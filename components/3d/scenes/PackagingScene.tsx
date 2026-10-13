'use client';
/**
 * Packaging (§46–§49) — 1 world unit = 1 cm.
 *   attach:   adhesive / flux dispensed → die placed by the bond head → bonded & cured
 *   bond:     WIRE BOND (gold wires, pad → finger, one by one) or FLIP-CHIP (die flips onto bumps,
 *             reflow) — toggle in the HUD
 *   advanced: 2.5D interposer + HBM · 3D stack · chiplets with bridges — toggle; exploded at the end
 *   final:    underfill → TIM + lid → BGA balls & reflow → laser mark → exploded, clickable layers
 * Generic, educational structures — not any specific product. Counts of wires/bumps/balls are
 * reduced for clarity.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting } from '../environments';
import { M, XRAY } from '../materials';
import { GEO, type V3 } from '../parts/primitives';
import { Kit } from '../kit/build';
import { KM } from '../kit/finish';
import { Baked, useKit } from '../kit/Baked';
import { Clickable, SensorIndicator, TechLabel } from '../parts/interaction';
import { substrateTexture, dieFloorplan } from '../textures';
import { engine } from '@/simulation/engine';
import { pp, inPhase } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { useParam } from '@/hooks/useTicker';
import { clamp, smooth, lerp } from '@/lib/math';

const BASE = 0.5; // carrier top
const SUB = 4.5;
const SUB_T = 0.12;
const ST = BASE + SUB_T; // substrate top
const DW = 1.3;
const DD = 1.65;
const DT = 0.078;

/* ---------------------------------------------------------------- materials */

const std = (color: string, p: THREE.MeshPhysicalMaterialParameters = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.4, metalness: 0.05, ...p });
const MAT = {
  carrier: std('#2b302c', { roughness: 0.55, metalness: 0.5, emissive: new THREE.Color('#ff6a1a'), emissiveIntensity: 0 }),
  adhesive: std('#c9c6bf', { roughness: 0.3, metalness: 0.6 }),
  gold: std('#d9a944', { roughness: 0.25, metalness: 1 }),
  solder: std('#bfc3c6', { roughness: 0.25, metalness: 1, emissive: new THREE.Color('#ff7a2a'), emissiveIntensity: 0 }),
  underfill: std('#1f2421', { roughness: 0.5, transparent: true, opacity: 0.9 }),
  tim: std('#9a9c9a', { roughness: 0.6 }),
  lid: std('#c9cdd0', { roughness: 0.28, metalness: 0.95 }),
  si: std('#4a5560', { roughness: 0.3, metalness: 0.5 }),
  interposer: std('#5c6b66', { roughness: 0.3, metalness: 0.5 }),
  hbm: std('#3d4642', { roughness: 0.35, metalness: 0.4 }),
  bridge: std('#b9a36a', { roughness: 0.3, metalness: 0.6, emissive: new THREE.Color('#5a4a1a'), emissiveIntensity: 0.4 }),
  tsv: new THREE.MeshBasicMaterial({ color: '#d98a4a', toneMapped: false }),
  mold: std('#1c1d20', { roughness: 0.7 }),
};

/* ---------------------------------------------------------------- machine models (kit, 1 unit = 1 cm) */

/*
 * The packaging tools are seen at bench scale: the bond stage of a die bonder / wire bonder,
 * the bond heads above it and the reflow nest of the lid-attach / ball-attach line. Static
 * parts are merged with the detailing kit (one mesh per finish); the moving heads keep their
 * refs and pivots and only gain detail around the same origin.
 */
const RX: V3 = [Math.PI / 2, 0, 0];
const RZ: V3 = [0, 0, Math.PI / 2];
/** world-UV density for centimetre models (≈ one paint / brush tile per 1.7 cm) */
const UV_CM = 0.6;

let _sub: { top: THREE.MeshStandardMaterial; side: THREE.MeshStandardMaterial; die: THREE.MeshStandardMaterial } | null = null;
/** shared substrate / die finishes for the neighbouring units on the indexer */
function unitMats() {
  if (!_sub)
    _sub = {
      top: new THREE.MeshStandardMaterial({ map: substrateTexture(), roughness: 0.5, metalness: 0.2 }),
      side: new THREE.MeshStandardMaterial({ color: '#244a37', roughness: 0.6 }),
      die: new THREE.MeshStandardMaterial({ map: dieFloorplan('cpu'), roughness: 0.3, metalness: 0.35 }),
    };
  return _sub;
}

/** Square plate (top at y + t) with a centred square window of half-width hw. */
function windowPlate(k: Kit, m: THREE.Material, w: number, t: number, y: number, hw: number) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, -w / 2);
  s.lineTo(w / 2, -w / 2);
  s.lineTo(w / 2, w / 2);
  s.lineTo(-w / 2, w / 2);
  s.closePath();
  const h = new THREE.Path();
  h.moveTo(-hw, -hw);
  h.lineTo(-hw, hw);
  h.lineTo(hw, hw);
  h.lineTo(hw, -hw);
  h.closePath();
  s.holes.push(h);
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false });
  k.add(m, g, [0, y, 0], [-Math.PI / 2, 0, 0]);
  g.dispose();
}

/** Socket-head cap screw seen from above at (x, y, z). */
function capScrew(k: Kit, x: number, y: number, z: number, r = 0.11) {
  k.cyl(KM.stainlessDark, r, r * 0.9, [x, y + r * 0.45, z], [0, 0, 0], 16, { cast: false });
  k.cyl(KM.seam, r * 0.45, 0.004, [x, y + r * 0.9 + 0.002, z], [0, 0, 0], 6, { cast: false });
}

/** A substrate unit on the indexer (optionally with an attached die). */
function unit(k: Kit, x: number, withDie: boolean, lidded = false) {
  const um = unitMats();
  k.box(um.side, [SUB, SUB_T, SUB], [x, BASE + SUB_T / 2, 0]);
  k.add(um.top, new THREE.PlaneGeometry(SUB, SUB), [x, ST + 0.001, 0], [-Math.PI / 2, 0, 0], [1, 1, 1], { keepUV: true, cast: false });
  if (withDie) {
    k.box(MAT.si, [DW, DT, DD], [x, ST + 0.02 + DT / 2, 0]);
    k.add(um.die, new THREE.PlaneGeometry(DW, DD), [x, ST + 0.02 + DT + 0.001, 0], [-Math.PI / 2, 0, 0], [1, 1, 1], { keepUV: true, cast: false });
  }
  if (lidded) {
    k.rbox(MAT.lid, [3.6, 0.12, 3.6], 0.02, [x, ST + 0.06 + DT + 0.085, 0]);
    k.rbox(MAT.lid, [3.6, 0.17, 3.6], 0.02, [x, ST + 0.085, 0]);
  }
}

/**
 * Bond stage of a die / wire bonder: heated block (glows with the bond temperature), stepped
 * window clamp over the substrate edge, strip-guide rails of the indexer, pre- and post-bond
 * units on the neighbouring stations, heater leads, model plate.
 */
function buildBondStage(k: Kit, model: string, sub: string, next: 'bare' | 'die') {
  k.uvScale = UV_CM;
  // heater block + cartridge heaters and thermocouple on the -x face
  k.rbox(MAT.carrier, [7, BASE, 7], 0.05, [0, BASE / 2, 0]);
  for (const z of [-2.2, 0, 2.2]) {
    k.cyl(KM.stainless, 0.16, 0.24, [-3.62, 0.26, z], RZ, 16);
    k.tube(KM.ptfe, [[-3.72, 0.26, z], [-4.4, 0.2, z * 1.1], [-5.6, 0.06, z * 1.25 + 0.6]], 0.05, { radial: 6 });
  }
  k.tube(KM.copper, [[-3.55, 0.34, 1.1], [-4.2, 0.3, 1.3], [-5.4, 0.05, 1.9]], 0.025, { radial: 6 });
  // vacuum fitting on the front face
  k.cyl(KM.stainless, 0.14, 0.2, [0, 0.25, 3.6], RX, 6);
  k.tube(KM.plastic, [[0, 0.25, 3.7], [0.3, 0.18, 4.4], [1.2, 0.05, 5.6]], 0.07, { radial: 8 });
  // stepped window clamp: frame resting on the block, lip pressing the substrate edge
  windowPlate(k, KM.stainless, 6.4, 0.18, BASE, SUB / 2 + 0.06);
  windowPlate(k, KM.stainless, SUB + 0.2, 0.06, ST, 1.85);
  for (const s of [-1, 1]) {
    k.box(KM.seam, [3.7, 0.012, 0.03], [0, ST + 0.061, s * 1.85], [0, 0, 0], { cast: false });
    k.box(KM.seam, [0.03, 0.012, 3.7], [s * 1.85, ST + 0.061, 0], [0, 0, 0], { cast: false });
  }
  for (const [x, z] of [[-2.8, -2.8], [0, -2.8], [2.8, -2.8], [-2.8, 0], [2.8, 0], [-2.8, 2.8], [0, 2.8], [2.8, 2.8]]) capScrew(k, x, ST + 0.06, z);
  // indexer strip-guide rails with inner lips, screws, pusher finger
  for (const s of [-1, 1]) {
    k.rbox(KM.anodized, [34, 0.78, 0.36], 0.03, [0, 0.39, s * 3.45]);
    k.rbox(KM.anodized, [34, 0.06, 0.3], 0.015, [0, 0.81, s * 3.32]);
    for (let i = -8; i <= 8; i++) capScrew(k, i * 2, 0.84, s * 3.5, 0.08);
  }
  k.rbox(KM.anodizedDark, [0.5, 0.4, 0.5], 0.04, [-11.5, 1.04, 3.45]);
  k.rbox(KM.anodizedDark, [0.18, 0.5, 0.18], 0.02, [-11.5, 0.62, 3.2]);
  // neighbouring stations on the indexer: pre-heat (incoming) and post-bond (outgoing)
  for (const s of [-1, 1]) k.rbox(KM.anodizedDark, [6.6, BASE, 6.6], 0.05, [s * 8, BASE / 2, 0]);
  unit(k, -8, false);
  unit(k, 8, next === 'die');
  // model plate and caution label on the front rail
  k.label('model', model, sub, 3.4, 0.66, [-5.6, 0.42, 3.632]);
  k.label('warn', 'HOT', '', 0.5, 0.5, [-2.6, 0.42, 3.632]);
  k.ao(9, 9, [0, 0, 0], 1.15);
  k.ao(34, 8, [0, 0, 0], 1.05);
}

/** Die-bond head (rides the head group): rubber pick-up pad, tool, holder, shaft, load cell, Z body. */
function buildDieBondHead(k: Kit) {
  k.uvScale = UV_CM;
  k.rbox(KM.rubber, [0.9, 0.08, 1.1], 0.02, [0, -0.02, 0]);
  k.cyl(KM.stainless, 0.74, 0.26, [0, 0.15, 0], [0, Math.PI / 4, 0], 4, { top: 0.62 });
  k.cyl(KM.anodized, 0.5, 0.26, [0, 0.41, 0], [0, 0, 0], 32);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    k.cyl(KM.stainlessDark, 0.05, 0.06, [Math.cos(a) * 0.51, 0.42, Math.sin(a) * 0.51], [0, -a, Math.PI / 2], 8, { cast: false });
  }
  k.cyl(KM.ptfe, 0.4, 0.12, [0, 0.6, 0], [0, 0, 0], 32);
  k.cyl(KM.chrome, 0.18, 2.9, [0, 2.11, 0], [0, 0, 0], 20);
  k.cyl(KM.stainlessDark, 0.34, 0.2, [0, 3.45, 0], [0, 0, 0], 24);
  k.rbox(KM.paint, [1.8, 2.4, 1.6], 0.1, [0, 4.75, -0.2]);
  k.box(KM.seam, [1.82, 0.02, 1.62], [0, 4.1, -0.2], [0, 0, 0], { cast: false });
  k.cyl(KM.anodizedDark, 0.6, 0.5, [0, 6.2, -0.2], [0, 0, 0], 32);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    k.box(KM.anodizedDark, [0.04, 0.42, 0.14], [Math.cos(a) * 0.62, 6.2, -0.2 + Math.sin(a) * 0.62], [0, -a, 0], { cast: false });
  }
  k.box(KM.ledGreen, [0.3, 0.06, 0.02], [0.4, 5.6, 0.61], [0, 0, 0], { cast: false });
  // vacuum and heater leads
  k.tube(KM.plastic, [[0.5, 0.45, 0.1], [0.75, 1.0, 0.2], [0.85, 2.5, 0.35], [0.7, 3.7, 0.6]], 0.04, { radial: 6 });
  k.tube(KM.ptfe, [[-0.45, 0.6, 0.0], [-0.7, 1.4, 0.0], [-0.75, 3.0, 0.1], [-0.6, 3.7, 0.4]], 0.03, { radial: 6 });
}

/** Adhesive dispenser (rides the needle group): needle, luer hub, barrel, adapter, air line, clamp. */
function buildSyringe(k: Kit) {
  k.uvScale = UV_CM;
  k.cyl(KM.stainless, 0.03, 0.5, [0, 0.25, 0], [0, 0, 0], 10);
  k.cyl(KM.paintAccent, 0.08, 0.16, [0, 0.56, 0], [0, 0, 0], 12, { top: 0.7 });
  k.cyl(KM.plasticWhite, 0.14, 0.9, [0, 1.09, 0], [0, 0, 0], 24);
  k.cyl(KM.plasticWhite, 0.2, 0.04, [0, 1.56, 0], [0, 0, 0], 24);
  k.cyl(KM.anodizedDark, 0.16, 0.22, [0, 1.69, 0], [0, 0, 0], 20);
  k.tube(KM.plastic, [[0, 1.8, 0], [0, 2.3, 0], [0.3, 2.9, -0.3], [0.9, 3.8, -0.6]], 0.04, { radial: 6 });
  k.rbox(KM.anodized, [0.42, 0.28, 0.12], 0.03, [0, 1.15, -0.2]);
  k.rbox(KM.anodized, [0.2, 2.2, 0.16], 0.03, [0, 2.15, -0.34]);
  k.cyl(KM.stainlessDark, 0.04, 0.05, [0.14, 1.15, -0.13], RX, 8, { cast: false });
}

/** Capillary (rides the bond-head group): bottleneck ceramic tube + gold wire up to the clamp. */
function buildCapillary(k: Kit) {
  k.uvScale = UV_CM;
  k.lathe(M.ceramic, [[0.0001, 0], [0.012, 0], [0.018, 0.015], [0.024, 0.12], [0.03, 0.26], [0.046, 0.38], [0.06, 0.5], [0.06, 1.1], [0.05, 1.12], [0.0001, 1.12]], [0, 0, 0], [0, 0, 0], 24);
  k.cyl(MAT.gold, 0.006, 1.8, [0, 2.0, 0], [0, 0, 0], 6, { cast: false });
}

/**
 * Wire-bond head (rides the bond-head group): exponential horn, nodal flange and mount, piezo
 * stack, back mass, head body, wire clamp, wire guide, EFO wand and the PRS optics.
 */
function buildTransducer(k: Kit) {
  k.uvScale = UV_CM;
  k.at([0, 1.0, 0], [0, 0, -Math.PI / 2], () => {
    k.lathe(KM.stainless, [[0.0001, -0.12], [0.07, -0.12], [0.08, 0.25], [0.095, 0.9], [0.12, 1.6], [0.155, 2.2], [0.165, 2.4], [0.0001, 2.4]], [0, 0, 0], [0, 0, 0], 28);
  });
  k.cyl(KM.stainlessDark, 0.012, 0.18, [0, 1.0, 0.09], RX, 6, { cast: false });
  k.cyl(KM.stainless, 0.34, 0.12, [2.46, 1.0, 0], RZ, 32);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.cyl(KM.stainlessDark, 0.035, 0.04, [2.39, 1.0 + Math.cos(a) * 0.27, Math.sin(a) * 0.27], RZ, 6, { cast: false });
  }
  for (let i = 0; i < 8; i++) k.cyl(i % 2 ? KM.copper : KM.ptfe, 0.2, 0.08, [2.56 + 0.04 + i * 0.08, 1.0, 0], RZ, 24);
  k.cyl(KM.stainlessDark, 0.22, 0.42, [3.43, 1.0, 0], RZ, 24);
  k.cyl(KM.chrome, 0.06, 0.12, [3.7, 1.0, 0], RZ, 6);
  // nodal mount yoke, side plates into the head body
  k.rbox(KM.anodizedDark, [0.18, 0.95, 0.95], 0.03, [2.46, 1.0, 0]);
  for (const s of [-1, 1]) k.rbox(KM.anodizedDark, [1.6, 0.5, 0.08], 0.02, [3.2, 1.0, s * 0.44]);
  k.rbox(KM.paint, [1.8, 1.6, 1.5], 0.1, [4.8, 1.3, 0]);
  k.box(KM.seam, [0.02, 1.4, 1.3], [3.9, 1.3, 0], [0, 0, 0], { cast: false });
  k.label('model', 'WB-200', 'THERMOSONIC', 1.2, 0.26, [4.8, 1.75, 0.752]);
  // wire clamp (two jaws around the wire) on arms from the head body, wire guide above
  for (const s of [-1, 1]) {
    k.rbox(KM.anodizedDark, [3.9, 0.1, 0.06], 0.02, [2.0, 1.62, s * 0.065]);
    k.rbox(KM.stainless, [0.16, 0.16, 0.04], 0.01, [0.03, 1.62, s * 0.03]);
  }
  k.cyl(KM.ptfe, 0.035, 0.7, [0, 2.3, 0], [0, 0, 0], 12);
  k.rbox(KM.anodizedDark, [0.2, 0.12, 0.2], 0.02, [0, 2.7, 0]);
  k.rbox(KM.anodizedDark, [3.9, 0.12, 0.12], 0.03, [1.95, 2.7, 0]);
  // EFO wand: insulated rod ending just beside the capillary tip
  k.tube(KM.ptfe, [[2.2, 0.75, 1.0], [1.2, 0.4, 0.7], [0.35, 0.16, 0.3]], 0.04, { radial: 6 });
  k.cyl(KM.stainlessDark, 0.015, 0.2, [0.22, 0.12, 0.22], [0, -0.8, Math.PI / 2], 6, { cast: false });
  // pattern-recognition optics beside the horn
  k.cyl(KM.plastic, 0.26, 2.6, [0.9, 2.9, -1.15], [0, 0, 0], 24);
  k.torus(KM.ledWhite, 0.27, 0.045, [0.9, 1.58, -1.15], [0, 0, 0], 32);
  k.cyl(KM.glassSmoke, 0.22, 0.02, [0.9, 1.6, -1.15], [0, 0, 0], 24, { cast: false });
  k.rbox(KM.anodizedDark, [0.7, 0.8, 0.7], 0.06, [0.9, 4.6, -1.15]);
  k.rbox(KM.anodizedDark, [3.6, 0.3, 0.14], 0.04, [2.7, 3.2, -1.15]);
  k.rbox(KM.anodizedDark, [0.14, 1.9, 0.14], 0.03, [4.5, 2.25, -1.15]);
}

/** Reflow nest of the lid-attach / ball-attach line: pocket plate, corner ledges, locators, boat rails. */
function buildNest(k: Kit) {
  k.uvScale = UV_CM;
  k.rbox(MAT.carrier, [6, 0.3, 6], 0.04, [0, 0.15, 0]);
  for (let i = -5; i <= 5; i++) for (let j = -5; j <= 5; j++) if ((i + j) % 2 === 0) k.cyl(KM.seam, 0.06, 0.004, [i * 0.38, 0.302, j * 0.38], [0, 0, 0], 8, { cast: false });
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    k.box(KM.anodized, [0.28, 0.2, 0.28], [sx * 2.26, 0.4, sz * 2.26]);
    k.box(KM.anodized, [1.1, 0.5, 0.14], [sx * 1.85, 0.55, sz * 2.33]);
    k.box(KM.anodized, [0.14, 0.5, 1.1], [sx * 2.33, 0.55, sz * 1.85]);
    capScrew(k, sx * 2.65, 0.3, sz * 2.65, 0.1);
  }
  // conveyor boat rails and the neighbouring (finished) packages
  for (const s of [-1, 1]) {
    k.rbox(KM.stainless, [34, 0.45, 0.3], 0.03, [0, 0.225, s * 3.3]);
    k.rbox(KM.stainlessDark, [34, 0.06, 0.5], 0.02, [0, 0.47, s * 3.3]);
    k.rbox(MAT.carrier, [6, 0.3, 6], 0.04, [s * 8, 0.15, 0]);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box(KM.anodized, [0.28, 0.2, 0.28], [s * 8 + sx * 2.26, 0.4, sz * 2.26]);
    unit(k, s * 8, true, true);
  }
  k.label('model', 'BA-300', 'LID ATTACH · BALL MOUNT · REFLOW', 3.6, 0.7, [-5.2, 0.24, 3.452]);
  k.ao(7, 7, [0, 0, 0], 1.2);
  k.ao(34, 7.5, [0, 0, 0], 1.05);
}

/* ---------------------------------------------------------------- shared helpers */

function useDieMat() {
  return useMemo(() => {
    const top = new THREE.MeshStandardMaterial({ map: dieFloorplan('cpu'), roughness: 0.3, metalness: 0.35 });
    return [MAT.si, MAT.si, top, MAT.si, MAT.si, MAT.si] as THREE.Material[];
  }, []);
}

function Substrate({ label = 'Package substrate' }: { label?: string }) {
  const mats = useMemo(() => {
    const top = new THREE.MeshStandardMaterial({ map: substrateTexture(), roughness: 0.5, metalness: 0.2 });
    const side = new THREE.MeshStandardMaterial({ color: '#244a37', roughness: 0.6 });
    return [side, side, top, side, side, side];
  }, []);
  return (
    <Clickable sel={{ kind: 'component', id: 'pkg-substrate', label }}>
      <mesh geometry={GEO.box} material={mats} scale={[SUB, SUB_T, SUB]} position={[0, BASE + SUB_T / 2, 0]} castShadow receiveShadow />
    </Clickable>
  );
}

const STAGE_PLATE: Record<string, [string, string, 'bare' | 'die']> = {
  attach: ['DA-100', 'DIE BONDER · BOND STAGE', 'die'],
  bond: ['WB-200', 'WIRE BONDER · HEATER BLOCK', 'die'],
  advanced: ['AP-400', 'MULTI-DIE ASSEMBLY · CARRIER', 'bare'],
};

/** Heated bond stage with clamp, indexer rails and neighbouring units (replaces the plain carrier block). */
function Carrier({ kind = 'attach' }: { kind?: 'attach' | 'bond' | 'advanced' }) {
  const parts = useKit((k) => {
    const [model, sub, next] = STAGE_PLATE[kind];
    buildBondStage(k, model, sub, next);
  }, [kind]);
  return <Baked parts={parts} />;
}

/** explode factor: x-ray / exploded view mode or an explicit exploded phase */
function useExplode(phase?: string) {
  const view = useUI((s) => s.view);
  const ex = useRef(0);
  useFrame((_, dt) => {
    const target = Math.max(view === 'exploded' ? 1 : 0, phase ? smooth(clamp(pp(phase) * 2)) : 0);
    ex.current += (target - ex.current) * Math.min(1, dt * 3);
  });
  return ex;
}

/** a group lifted by `k × lift` in the exploded view */
function Lift({ ex, lift, children }: { ex: { current: number }; lift: number; children: ReactNode }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    if (g.current) g.current.position.y = ex.current * lift;
  });
  return <group ref={g}>{children}</group>;
}

/* ================================================================ attach */

function Attach() {
  const die = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const needle = useRef<THREE.Group>(null);
  const dots = useRef<THREE.InstancedMesh>(null);
  const dieMats = useDieMat();
  const headKit = useKit(buildDieBondHead);
  const syringe = useKit(buildSyringe);
  const o = useMemo(() => new THREE.Object3D(), []);
  useFrame(() => {
    const dp = smooth(pp('dispense'));
    const pl = smooth(pp('place'));
    const bd = pp('bond');
    const y = lerp(ST + 1.6, ST + 0.02 + DT / 2, pl);
    const err = engine.tele.value('xy', 2) * 1e-4; // µm → cm
    if (die.current) die.current.position.set(err * 30 * (1 - pl), y, -err * 20 * (1 - pl));
    if (head.current) head.current.position.set(0, (pl > 0 ? y : ST + 1.6) + DT / 2 + 0.3 - 0.03 * smooth(clamp(bd * 3)), 0);
    if (needle.current) {
      needle.current.visible = inPhase('dispense');
      const k = Math.floor(dp * 9);
      needle.current.position.set(((k % 3) - 1) * 0.4, ST + 0.35, (Math.floor(k / 3) - 1) * 0.5);
    }
    MAT.carrier.emissiveIntensity = clamp((engine.tele.value('temp', 80) - 90) / 100) * 0.35;
    if (dots.current) {
      for (let i = 0; i < 9; i++) {
        const show = dp * 9 > i;
        const spread = 1 + 1.6 * smooth(clamp(bd * 2)) * pl;
        o.position.set(((i % 3) - 1) * 0.4, ST + 0.01, (Math.floor(i / 3) - 1) * 0.5);
        o.scale.set(0.09 * spread, show ? 0.02 : 0, 0.09 * spread);
        o.updateMatrix();
        dots.current.setMatrixAt(i, o.matrix);
      }
      dots.current.instanceMatrix.needsUpdate = true;
    }
    track('focus', 0, ST, 0);
  });
  return (
    <group>
      <Carrier kind="attach" />
      <Substrate />
      <instancedMesh ref={dots} args={[GEO.sphereLow, MAT.adhesive, 9]} />
      <group ref={die}>
        <Clickable sel={{ kind: 'component', id: 'pkg-die', label: 'Die CH-184-0412' }}>
          <mesh geometry={GEO.box} material={dieMats} scale={[DW, DT, DD]} castShadow />
        </Clickable>
      </group>
      <group ref={head}>
        <Clickable sel={{ kind: 'component', id: 'bond-head', machine: 'die-bonder', label: 'Bond head + collet' }}>
          <Baked parts={headKit} />
        </Clickable>
      </group>
      <group ref={needle}>
        <Baked parts={syringe} />
      </group>
      <TechLabel position={[1.2, ST + 0.6, 1.2]} title="DIE ATTACH" lines={['adhesive / solder, placement ±µm, heat cure']} min={1} value={() => `${engine.player.view.phase.label} · ${engine.tele.value('xy', 0).toFixed(1)} µm · ${engine.tele.value('temp', 0).toFixed(0)} °C`} />
    </group>
  );
}

/* ================================================================ bond: wire / flip-chip */

const FINGER = (0.13 + 11 / 512 - 0.5) * SUB; // finger ring (matches the substrate texture)

function wireCurves() {
  const curves: THREE.CatmullRomCurve3[] = [];
  const top = ST + 0.02 + DT;
  for (let side = 0; side < 4; side++) {
    for (let j = 0; j < 12; j++) {
      const t = 0.18 + ((2 * j) / 23) * 0.64;
      const along = (t - 0.5) * SUB;
      const padAlong = ((j + 0.5) / 12 - 0.5) * (side % 2 ? DD : DW) * 0.86;
      const pad = side % 2 === 0 ? new THREE.Vector3(padAlong, top, (side === 0 ? -1 : 1) * (DD / 2 - 0.05)) : new THREE.Vector3((side === 1 ? -1 : 1) * (DW / 2 - 0.05), top, padAlong);
      const fin = side % 2 === 0 ? new THREE.Vector3(along, ST + 0.002, (side === 0 ? -1 : 1) * -FINGER) : new THREE.Vector3((side === 1 ? -1 : 1) * -FINGER, ST + 0.002, along);
      const up = pad.clone().add(new THREE.Vector3(0, 0.22, 0));
      const mid = pad.clone().lerp(fin, 0.4).add(new THREE.Vector3(0, 0.3, 0));
      const near = fin.clone().add(new THREE.Vector3(0, 0.05, 0)).lerp(pad, 0.06);
      curves.push(new THREE.CatmullRomCurve3([pad, up, mid, near, fin]));
    }
  }
  return curves;
}

function WireBond() {
  const curves = useMemo(() => wireCurves(), []);
  const geos = useMemo(() => curves.map((c) => new THREE.TubeGeometry(c, 24, 0.0045, 5, false)), [curves]);
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  const cap = useRef<THREE.Group>(null);
  const capKit = useKit(buildCapillary);
  const horn = useKit(buildTransducer);
  useFrame(() => {
    const n = engine.tele.value('bonds', 0);
    const k = inPhase('wire') ? engine.player.view.phaseT * 48 : 48;
    refs.current.forEach((m, i) => {
      if (m) m.visible = i < n || (inPhase('wire') ? false : true);
    });
    if (cap.current) {
      const i = Math.min(47, Math.floor(k));
      const u = k - Math.floor(k);
      const p = curves[i].getPoint(clamp(u));
      cap.current.position.copy(p);
      cap.current.visible = inPhase('wire');
    }
  });
  return (
    <group>
      <Clickable sel={{ kind: 'component', id: 'wires', label: 'Bond wires (Au)' }}>
        {geos.map((g, i) => (
          <mesh
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            geometry={g}
            material={MAT.gold}
          />
        ))}
      </Clickable>
      <group ref={cap}>
        <Clickable sel={{ kind: 'component', id: 'capillary', machine: 'wire-bonder', label: 'Capillary' }}>
          <Baked parts={capKit} />
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'transducer', machine: 'wire-bonder', label: 'Ultrasonic transducer' }}>
          <Baked parts={horn} />
        </Clickable>
      </group>
    </group>
  );
}

function FlipChip({ settled = false }: { settled?: boolean }) {
  const die = useRef<THREE.Group>(null);
  const dieMats = useDieMat();
  const bumps = useMemo(() => {
    const out: [number, number][] = [];
    for (let i = 0; i < 10; i++) for (let j = 0; j < 12; j++) out.push([((i + 0.5) / 10 - 0.5) * DW * 0.9, ((j + 0.5) / 12 - 0.5) * DD * 0.9]);
    return out;
  }, []);
  const inst = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    if (!inst.current) return;
    const o = new THREE.Object3D();
    bumps.forEach(([x, z], i) => {
      o.position.set(x, -DT / 2 - 0.03, z);
      o.scale.set(0.035, 0.03, 0.035);
      o.updateMatrix();
      inst.current!.setMatrixAt(i, o.matrix);
    });
    inst.current.instanceMatrix.needsUpdate = true;
  }, [bumps]);
  useFrame(() => {
    const k = settled ? 1 : inPhase('wire') ? engine.player.view.phaseT : pp('wire');
    const flip = smooth(clamp(k / 0.45));
    const down = smooth(clamp((k - 0.45) / 0.35));
    const reflow = clamp((k - 0.8) / 0.2);
    if (die.current) {
      die.current.rotation.x = Math.PI * (1 - flip); // face up (pattern on top) → face down
      die.current.position.set(0, lerp(ST + 1.5, ST + 0.06 + DT / 2, down), 0);
    }
    MAT.solder.emissiveIntensity = settled ? 0 : Math.sin(Math.PI * reflow) * 0.8;
    track('focus', 0, ST, 0);
  });
  return (
    <group ref={die}>
      <Clickable sel={{ kind: 'component', id: 'pkg-die', label: 'Die (flip-chip, face down)' }}>
        <mesh geometry={GEO.box} material={dieMats} scale={[DW, DT, DD]} rotation={[Math.PI, 0, 0]} castShadow />
      </Clickable>
      <Clickable sel={{ kind: 'component', id: 'bumps', label: 'Solder bumps' }}>
        <instancedMesh ref={inst} args={[GEO.sphereLow, MAT.solder, bumps.length]} />
      </Clickable>
    </group>
  );
}

function Bond() {
  const mode = useParam('bondMode');
  const dieMats = useDieMat();
  useFrame(() => track('focus', 0, ST, 0));
  return (
    <group>
      <Carrier kind="bond" />
      <Substrate />
      {mode === 0 ? (
        <>
          <Clickable sel={{ kind: 'component', id: 'pkg-die', label: 'Die (face up)' }}>
            <mesh geometry={GEO.box} material={dieMats} scale={[DW, DT, DD]} position={[0, ST + 0.02 + DT / 2, 0]} castShadow />
          </Clickable>
          <WireBond />
        </>
      ) : (
        <FlipChip />
      )}
      <TechLabel
        position={[1.4, ST + 1.0, 1.4]}
        title={mode === 0 ? 'WIRE BONDING' : 'FLIP-CHIP'}
        lines={[mode === 0 ? 'ball on the pad → loop → stitch on the finger' : 'die flips face-down onto solder bumps, reflowed']}
        min={1}
        value={() => `${engine.tele.value('bonds', 0).toFixed(0)} connections · ${mode === 0 ? 'wire Ø exaggerated' : 'bump count reduced'}`}
      />
    </group>
  );
}

/* ================================================================ advanced packaging */

function HbmStack({ x, z, k }: { x: number; z: number; k: () => number }) {
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  useFrame(() => {
    const n = k() * 9;
    refs.current.forEach((m, i) => {
      if (!m) return;
      const v = clamp(n - i);
      m.visible = v > 0;
      m.position.y = i * 0.055 + (1 - smooth(v)) * 0.8;
    });
  });
  return (
    <group position={[x, 0, z]}>
      <Clickable sel={{ kind: 'component', id: 'hbm', label: 'HBM stack (8 DRAM dies + base)' }}>
        {Array.from({ length: 9 }, (_, i) => (
          <mesh
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            geometry={GEO.box}
            material={i === 0 ? MAT.si : MAT.hbm}
            scale={[0.78, 0.045, 0.62]}
            castShadow
          />
        ))}
      </Clickable>
    </group>
  );
}

function Advanced() {
  const mode = useParam('apMode');
  const ex = useExplode('explore');
  const dieMats = useDieMat();
  const tsv = useMemo(() => {
    const out: [number, number][] = [];
    for (let i = 0; i < 16; i++) for (let j = 0; j < 12; j++) out.push([(i / 15 - 0.5) * 3.0, (j / 11 - 0.5) * 2.4]);
    return out;
  }, []);
  const tsvRef = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    if (!tsvRef.current) return;
    const o = new THREE.Object3D();
    tsv.forEach(([x, z], i) => {
      o.position.set(x, 0, z);
      o.scale.set(0.012, 0.11, 0.012);
      o.updateMatrix();
      tsvRef.current!.setMatrixAt(i, o.matrix);
    });
    tsvRef.current.instanceMatrix.needsUpdate = true;
  }, [tsv]);
  const base = () => smooth(pp('interposer'));
  const stack = () => (inPhase('stack') ? engine.player.view.phaseT : pp('stack'));
  const gBase = useRef<THREE.Group>(null);
  useFrame(() => {
    if (gBase.current) {
      const k = base();
      gBase.current.visible = k > 0.01;
      gBase.current.position.y = (1 - k) * 1.5;
    }
    track('focus', 0, ST + 0.3, 0);
  });
  const IY = ST + 0.06; // interposer bottom (on C4 bumps)
  return (
    <group>
      <Carrier kind="advanced" />
      <Lift ex={ex} lift={0}>
        <Substrate label={mode === 2 ? 'Organic substrate with embedded bridges' : 'Package substrate'} />
      </Lift>
      {mode === 0 && (
        <>
          <Lift ex={ex} lift={1.0}>
            <group ref={gBase}>
              <Clickable sel={{ kind: 'component', id: 'interposer', label: 'Silicon interposer' }}>
                <mesh geometry={GEO.box} material={MAT.interposer} scale={[3.4, 0.1, 2.8]} position={[0, IY + 0.05, 0]} castShadow />
              </Clickable>
              <Clickable sel={{ kind: 'component', id: 'tsv', label: 'Through-silicon vias' }}>
                <instancedMesh ref={tsvRef} args={[GEO.cylLow, MAT.tsv, tsv.length]} position={[0, IY + 0.05, 0]} />
              </Clickable>
            </group>
          </Lift>
          <Lift ex={ex} lift={2.0}>
            <DropIn k={() => smooth(clamp(stack() * 2))} y={IY + 0.1 + 0.04 + DT / 2}>
              <Clickable sel={{ kind: 'component', id: 'logic-die', label: 'Logic die' }}>
                <mesh geometry={GEO.box} material={dieMats} scale={[1.5, DT, 2.0]} castShadow />
              </Clickable>
            </DropIn>
            {[
              [-1.25, -0.65],
              [-1.25, 0.65],
              [1.25, -0.65],
              [1.25, 0.65],
            ].map(([x, z], i) => (
              <group key={i} position={[0, IY + 0.14 + 0.025, 0]}>
                <HbmStack x={x} z={z} k={() => clamp(stack() * 1.4 - i * 0.1)} />
              </group>
            ))}
          </Lift>
        </>
      )}
      {mode === 1 && (
        <>
          <Lift ex={ex} lift={1.0}>
            <group ref={gBase}>
              <Clickable sel={{ kind: 'component', id: 'logic-die', label: 'Base logic die (with TSVs)' }}>
                <mesh geometry={GEO.box} material={dieMats} scale={[1.8, 0.1, 2.0]} position={[0, IY + 0.05, 0]} castShadow />
              </Clickable>
              <Clickable sel={{ kind: 'component', id: 'tsv', label: 'Through-silicon vias' }}>
                <instancedMesh ref={tsvRef} args={[GEO.cylLow, MAT.tsv, tsv.length]} position={[0, IY + 0.05, 0]} scale={[0.5, 1, 0.75]} />
              </Clickable>
            </group>
          </Lift>
          {[0, 1, 2].map((i) => (
            <Lift key={i} ex={ex} lift={1.6 + i * 0.6}>
              <DropIn k={() => smooth(clamp(stack() * 1.6 - i * 0.3))} y={IY + 0.1 + 0.05 + i * 0.1}>
                <Clickable sel={{ kind: 'component', id: i === 0 ? 'chiplet' : 'hbm', label: i === 0 ? 'Cache die (hybrid bonded)' : 'Memory die (stacked)' }}>
                  <mesh geometry={GEO.box} material={i === 0 ? MAT.interposer : MAT.hbm} scale={[1.6 - i * 0.1, 0.09, 1.8 - i * 0.1]} castShadow />
                </Clickable>
              </DropIn>
            </Lift>
          ))}
        </>
      )}
      {mode === 2 && (
        <>
          <Lift ex={ex} lift={0.5}>
            <group ref={gBase}>
              {[
                [-0.7, -0.65],
                [-0.7, 0.65],
                [0.7, -0.65],
                [0.7, 0.65],
              ].map(([x, z], i) => (
                <Clickable key={i} sel={{ kind: 'component', id: 'bridge', label: 'Silicon bridge (embedded)' }}>
                  <mesh geometry={GEO.box} material={MAT.bridge} scale={[0.5, 0.03, 0.4]} position={[x * 0.8, ST - 0.01, z]} />
                </Clickable>
              ))}
            </group>
          </Lift>
          <Lift ex={ex} lift={1.6}>
            <DropIn k={() => smooth(clamp(stack() * 2))} y={ST + 0.06 + DT / 2}>
              <Clickable sel={{ kind: 'component', id: 'chiplet', label: 'I/O die' }}>
                <mesh geometry={GEO.box} material={MAT.interposer} scale={[0.7, DT, 2.6]} castShadow />
              </Clickable>
            </DropIn>
            {[
              [-1.2, -0.65],
              [-1.2, 0.65],
              [1.2, -0.65],
              [1.2, 0.65],
            ].map(([x, z], i) => (
              <DropIn key={i} k={() => smooth(clamp(stack() * 1.6 - 0.2 - i * 0.12))} y={ST + 0.06 + DT / 2} x={x} z={z}>
                <Clickable sel={{ kind: 'component', id: 'chiplet', label: 'Compute chiplet' }}>
                  <mesh geometry={GEO.box} material={dieMats} scale={[1.0, DT, 1.15]} castShadow />
                </Clickable>
              </DropIn>
            ))}
          </Lift>
        </>
      )}
      <TechLabel
        position={[-2.2, ST + 2.6, 2.2]}
        title={['2.5D · INTERPOSER + HBM', '3D · STACKED DIES', 'CHIPLETS · BRIDGES'][mode] ?? ''}
        lines={[
          ['logic and memory side by side on silicon', 'dies stacked vertically, TSVs / hybrid bonding', 'several smaller dies, linked by embedded bridges'][mode] ?? '',
          'generic structures · not a specific product',
        ]}
        min={1}
        value={() => engine.player.view.phase.label}
      />
    </group>
  );
}

function DropIn({ k, y, x = 0, z = 0, children }: { k: () => number; y: number; x?: number; z?: number; children: ReactNode }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    const v = k();
    if (!g.current) return;
    g.current.visible = v > 0.01;
    g.current.position.set(x, y + (1 - v) * 1.2, z);
  });
  return <group ref={g}>{children}</group>;
}

/* ================================================================ final package */

function markTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#c9cdd0';
  g.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  let last = -1;
  const update = (k: number) => {
    const q = Math.round(k * 20) / 20;
    if (q === last) return;
    last = q;
    g.fillStyle = '#c9cdd0';
    g.fillRect(0, 0, 512, 512);
    g.save();
    g.beginPath();
    g.rect(0, 0, 512 * q, 512);
    g.clip();
    g.fillStyle = '#6e7377';
    g.font = 'bold 54px monospace';
    g.fillText('FAB/TWIN', 70, 200);
    g.font = '30px monospace';
    g.fillText('CH-184-0412', 70, 260);
    g.fillText('LOT A0731  2026', 70, 305);
    g.fillText('EDUCATIONAL', 70, 350);
    g.beginPath();
    g.arc(60, 440, 14, 0, Math.PI * 2);
    g.fill();
    g.restore();
    tex.needsUpdate = true;
  };
  update(0);
  return { tex, update };
}

function FinalPackage() {
  const view = useUI((s) => s.view);
  const ex = useExplode('exploded');
  const underfill = useRef<THREE.Group>(null);
  const tim = useRef<THREE.Group>(null);
  const lid = useRef<THREE.Group>(null);
  const balls = useRef<THREE.InstancedMesh>(null);
  const mark = useMemo(() => markTexture(), []);
  const lidTop = useMemo(() => new THREE.MeshStandardMaterial({ map: mark.tex, roughness: 0.3, metalness: 0.9 }), [mark]);
  const lidMats = useMemo(() => [MAT.lid, MAT.lid, lidTop, MAT.lid, MAT.lid, MAT.lid], [lidTop]);
  const ballPos = useMemo(() => {
    const out: [number, number][] = [];
    const n = 22;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push([((i + 0.5) / n - 0.5) * SUB * 0.94, ((j + 0.5) / n - 0.5) * SUB * 0.94]);
    return out;
  }, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const nest = useKit(buildNest);
  useFrame(() => {
    const uf = smooth(pp('underfill'));
    if (underfill.current) {
      underfill.current.visible = uf > 0.01;
      underfill.current.scale.x = Math.max(0.01, uf);
      underfill.current.position.x = -(1 - uf) * (DW / 2 + 0.06);
    }
    const lp = inPhase('lid') ? engine.player.view.phaseT : pp('lid');
    if (tim.current) {
      tim.current.visible = lp > 0.05;
      tim.current.scale.y = smooth(clamp(lp * 2.5));
    }
    if (lid.current) {
      const d = smooth(clamp((lp - 0.4) / 0.6));
      lid.current.visible = lp > 0.4;
      lid.current.position.y = (1 - d) * 2.2;
    }
    mark.update(inPhase('mark') ? engine.player.view.phaseT : pp('mark'));
    if (balls.current) {
      const bp = inPhase('balls') ? engine.player.view.phaseT : pp('balls');
      const placed = smooth(clamp(bp / 0.5));
      const T = engine.tele.value('reflow', 25);
      MAT.solder.emissiveIntensity = clamp((T - 180) / 70) * 0.9;
      const squash = T > 217 || pp('balls') >= 1 ? 0.85 : 1;
      ballPos.forEach(([x, z], i) => {
        const show = i / ballPos.length < placed;
        o.position.set(x, BASE - 0.03, z);
        o.scale.set(show ? 0.045 : 0, show ? 0.045 * squash : 0, show ? 0.045 : 0);
        o.updateMatrix();
        balls.current!.setMatrixAt(i, o.matrix);
      });
      balls.current.instanceMatrix.needsUpdate = true;
    }
    track('focus', 0, ST + 0.2, 0);
  });
  const xr = view === 'xray';
  return (
    <group>
      {/* the package sits in the reflow nest of the lid-attach / ball-mount line */}
      <Baked parts={nest} />
      <Lift ex={ex} lift={-0.9}>
        <Clickable sel={{ kind: 'component', id: 'balls', label: 'BGA solder balls' }}>
          <instancedMesh ref={balls} args={[GEO.sphereLow, MAT.solder, ballPos.length]} castShadow />
        </Clickable>
      </Lift>
      <Lift ex={ex} lift={0}>
        <Substrate />
      </Lift>
      <Lift ex={ex} lift={0.9}>
        <FlipChip settled />
      </Lift>
      <Lift ex={ex} lift={0.55}>
        <group ref={underfill}>
          <Clickable sel={{ kind: 'component', id: 'underfill', label: 'Underfill' }}>
            <mesh geometry={GEO.box} material={MAT.underfill} scale={[DW + 0.12, 0.06, DD + 0.12]} position={[0, ST + 0.03, 0]} />
          </Clickable>
        </group>
      </Lift>
      <Lift ex={ex} lift={1.5}>
        <group ref={tim} position={[0, ST + 0.06 + DT, 0]}>
          <Clickable sel={{ kind: 'component', id: 'tim', label: 'Thermal interface material' }}>
            <mesh geometry={GEO.box} material={MAT.tim} scale={[DW, 0.025, DD]} position={[0, 0.0125, 0]} />
          </Clickable>
        </group>
      </Lift>
      <Lift ex={ex} lift={2.3}>
        <group ref={lid}>
          <Clickable sel={{ kind: 'component', id: 'lid', label: 'Lid / heat spreader' }}>
            <mesh geometry={GEO.box} material={xr ? XRAY : lidMats} scale={[3.6, 0.12, 3.6]} position={[0, ST + 0.06 + DT + 0.025 + 0.06, 0]} castShadow />
            {[
              [0, 1.75, 3.6, 0.1],
              [0, -1.75, 3.6, 0.1],
              [1.75, 0, 0.1, 3.6],
              [-1.75, 0, 0.1, 3.6],
            ].map(([x, z, w, d], i) => (
              <mesh key={i} geometry={GEO.box} material={xr ? XRAY : MAT.lid} scale={[w, 0.17, d]} position={[x, ST + 0.085, z]} />
            ))}
          </Clickable>
        </group>
      </Lift>
      <TechLabel position={[-2.3, ST + 2.8, 2.3]} title="FINAL PACKAGE · FLIP-CHIP BGA" lines={['click any layer · exploded view in the last phase']} min={1} value={() => engine.player.view.phase.label} />
      <SensorIndicator id="thermocouple" channel="reflow" machine="mold-press" position={[3.2, 0.32, 0]} size={0.12} />
    </group>
  );
}

/* ================================================================ scene */

export default function PackagingScene({ stage }: SceneProps) {
  const v = stage.variant ?? 'attach';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0;
  }, []);
  return (
    <>
      <Lighting env="assembly" shadowExtent={6} fogScale={3} />
      {/* ESD bench mat (1 unit = 1 cm) */}
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.001, 0]} receiveShadow>
        <planeGeometry args={[90, 90]} />
        <meshStandardMaterial color="#27302a" roughness={0.85} />
      </mesh>
      {v === 'attach' && <Attach />}
      {v === 'bond' && <Bond />}
      {v === 'advanced' && <Advanced />}
      {v === 'final' && <FinalPackage />}
      {v === 'attach' && <SensorIndicator id="downforce" channel="force" machine="die-bonder" position={[0.6, ST + 1.0, 0]} size={0.1} />}
      {v === 'bond' && <SensorIndicator id="torque-sensor" channel="us" machine="wire-bonder" position={[2.2, ST + 1.3, 0.2]} size={0.1} />}
    </>
  );
}
