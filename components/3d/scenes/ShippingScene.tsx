'use client';
/**
 * Packing & logistics (§52, §53).
 *   pack:      trays → tape & reel (devices drop into carrier-tape pockets) → dry pack
 *              (moisture-barrier bag, desiccant, humidity card, vacuum seal) → carton & label
 *   warehouse: palletise → AMRs store the pallet in high-bay racking → order picking → dispatch
 *              onto a truck. Generic, educational logistics model.
 *
 * Static equipment is built with the detailing kit and merged per finish across a whole
 * station (one draw call per finish); selection keeps working through invisible pick
 * proxies inside each component's Clickable, shadows come from one caster per station.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting } from '../environments';
import { M } from '../materials';
import { GEO } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Operator } from '../parts/people';
import { plainTile } from '../textures';
import { Kit, cabinet, estop, foot, grille, hmi, iBeam, ledStrip, cableTray, type BakedPart, type V3 } from '../kit/build';
import { KM } from '../kit/finish';
import { Baked, useKit } from '../kit/Baked';
import { casterGeometry, shadowOnly } from '../kit/shadow';
import { engine } from '@/simulation/engine';
import { pp, inPhase, pdt } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { clamp, smooth, lerp } from '@/lib/math';

const cardboard = new THREE.MeshStandardMaterial({ color: '#b08a5a', roughness: 0.85 });
const cardboardDark = new THREE.MeshStandardMaterial({ color: '#8f6d44', roughness: 0.85 });
const tapeMat = new THREE.MeshStandardMaterial({ color: '#2a2d2b', roughness: 0.5 });
const reelMat = new THREE.MeshStandardMaterial({ color: '#2e3f37', roughness: 0.5 });
const bagMat = new THREE.MeshPhysicalMaterial({ color: '#c9ccc9', roughness: 0.2, metalness: 0.8, transparent: true, opacity: 0.75 });
const labelMat = new THREE.MeshStandardMaterial({ color: '#f2f1ea', roughness: 0.6 });
const palletMat = new THREE.MeshStandardMaterial({ color: '#9a7a4a', roughness: 0.9 });
const wrapMat = new THREE.MeshPhysicalMaterial({ color: '#e8efe6', roughness: 0.1, transparent: true, opacity: 0.35, depthWrite: false });
const packTape = new THREE.MeshStandardMaterial({ color: '#c9a66b', roughness: 0.45 });
const rackOrange = new THREE.MeshStandardMaterial({ color: '#c0622a', roughness: 0.5, metalness: 0.2 });
const rackBlue = new THREE.MeshStandardMaterial({ color: '#2f4e68', roughness: 0.5, metalness: 0.25 });

/** Satin versions of the kit metals: fully metallic finishes read black in this dim hall. */
function satin(m: THREE.MeshStandardMaterial, metalness: number) {
  const c = m.clone();
  c.metalness = metalness;
  return c;
}
const FM = {
  steel: satin(KM.stainless, 0.55),
  steelDark: satin(KM.stainlessDark, 0.6),
  alu: satin(KM.anodized, 0.5),
  aluDark: satin(KM.anodizedDark, 0.6),
};

/* ================================================================ station merge */

type Pieces = Record<string, (k: Kit) => void>;
interface Station {
  parts: BakedPart[];
  picks: Record<string, THREE.BufferGeometry>;
  caster: THREE.BufferGeometry | null;
}

function positionsOf(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  let n = 0;
  for (const g of geos) n += g.attributes.position.count * 3;
  if (!n) return null;
  const arr = new Float32Array(n);
  let o = 0;
  for (const g of geos) {
    arr.set(g.attributes.position.array as Float32Array, o);
    o += g.attributes.position.count * 3;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  out.computeBoundingSphere();
  return out;
}

/** Build every piece, merge all of a station's parts per finish; keys without "_" get pick proxies. */
function buildStation(pieces: Pieces): Station {
  const bins = new Map<string, { material: THREE.Material; shell: boolean; geos: THREE.BufferGeometry[] }>();
  const picks: Record<string, THREE.BufferGeometry> = {};
  const cast: THREE.BufferGeometry[] = [];
  for (const [tag, fn] of Object.entries(pieces)) {
    const k = new Kit();
    fn(k);
    const own: THREE.BufferGeometry[] = [];
    for (const p of k.build()) {
      const key = `${p.material.uuid}:${p.shell ? 1 : 0}`;
      let b = bins.get(key);
      if (!b) bins.set(key, (b = { material: p.material, shell: p.shell, geos: [] }));
      b.geos.push(p.geometry);
      own.push(p.geometry);
      if (p.cast) cast.push(p.geometry);
    }
    if (!tag.startsWith('_')) {
      const g = positionsOf(own);
      if (g) picks[tag] = g;
    }
  }
  const caster = casterGeometry(cast);
  const parts: BakedPart[] = [];
  for (const b of bins.values()) {
    const geometry = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
    if (!geometry) continue;
    if (geometry !== b.geos[0]) b.geos.forEach((g) => g.dispose());
    geometry.computeBoundingSphere();
    parts.push({ material: b.material, geometry, shell: b.shell, cast: false });
  }
  return { parts, picks, caster };
}

function useStation(pieces: Pieces, deps: unknown[] = []): Station {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const m = useMemo(() => buildStation(pieces), deps);
  useEffect(
    () => () => {
      m.parts.forEach((p) => p.geometry.dispose());
      Object.values(m.picks).forEach((g) => g.dispose());
      m.caster?.dispose();
    },
    [m],
  );
  return m;
}

const noRay = () => {};
const PICK_MAT = new THREE.MeshBasicMaterial();

function StationView({ m }: { m: Station }) {
  const caster = useMemo(() => (m.caster ? shadowOnly(m.caster) : null), [m]);
  return (
    <>
      {m.parts.map((p, i) => (
        <mesh key={i} geometry={p.geometry} material={p.material} receiveShadow raycast={noRay} />
      ))}
      {caster && <primitive object={caster} />}
    </>
  );
}

/** Invisible pick proxy for one component of a station. */
function Pick({ m, tag }: { m: Station; tag: string }) {
  const g = m.picks[tag];
  return g ? <mesh geometry={g} material={PICK_MAT} visible={false} /> : null;
}

/** One merged geometry from a kit build (all parts share the caller's single material). */
function kitGeometry(fn: (k: Kit) => void) {
  const k = new Kit();
  fn(k);
  const parts = k.build();
  const g = parts.length === 1 ? parts[0].geometry : mergeGeometries(parts.map((p) => p.geometry), false)!;
  if (parts.length > 1) parts.forEach((p) => p.geometry.dispose());
  return g;
}

/* ------------------------------------------------------------ shared props */

/** Four-way wooden pallet (1.1 × 1.0, 0.14 high), origin at floor centre. */
function pallet(k: Kit, m: THREE.Material = palletMat) {
  for (let i = 0; i < 5; i++) k.box(m, [1.1, 0.022, 0.15], [0, 0.129, -0.42 + i * 0.21]);
  for (const z of [-0.43, 0, 0.43]) k.box(m, [1.1, 0.022, 0.14], [0, 0.011, z]);
  for (const x of [-0.47, 0, 0.47]) for (const z of [-0.43, 0, 0.43]) k.box(m, [0.14, 0.096, 0.12], [x, 0.07, z]);
}

/** Palletised load of cartons (2 × 2 × 3) in one material, centred, base at y0. */
function cartonStack(k: Kit, m: THREE.Material, y0: number, parity: number, w = 1.05, d = 0.95, h = 0.9) {
  const cw = w / 2;
  const cd = d / 2;
  const ch = h / 3;
  for (let l = 0; l < 3; l++)
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 2; j++) {
        if ((i + j + l) % 2 !== parity) continue;
        k.box(m, [cw - 0.008, ch - 0.006, cd - 0.008], [-w / 2 + cw * (i + 0.5), y0 + ch * (l + 0.5), -d / 2 + cd * (j + 0.5)]);
      }
}

/** Carton tape strips over the stack tops (one material). */
function stackTape(k: Kit, y0: number, w = 1.05, d = 0.95, h = 0.9) {
  const ch = h / 3;
  for (let l = 0; l < 3; l++) for (const i of [0, 1]) k.box(packTape, [0.05, 0.002, d / 2 - 0.02], [-w / 2 + (w / 2) * (i + 0.5), y0 + ch * (l + 1) - 0.002, -d / 4]);
}

/* ================================================================ packing line */

function labelTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f2f1ea';
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#1a1c1a';
  g.font = 'bold 18px monospace';
  g.fillText('FAB/TWIN', 10, 24);
  g.font = '12px monospace';
  g.fillText('CH-184-0412 · LOT A0731', 10, 44);
  g.fillText('QTY 500 · MSL 3 · DRY PACK', 10, 60);
  for (let i = 0; i < 60; i++) g.fillRect(10 + i * 3.8, 74, (i * 7) % 3 === 0 ? 2.4 : 1.2, 40);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const ROLLER_TOP = 0.94;

/** Roller conveyor: side channels, rollers (gap under the taping bed), legs, guide rails, drive. */
function buildConveyor(k: Kit) {
  const nc = { cast: false };
  const x0 = -2.4;
  const x1 = 3.0;
  const L = x1 - x0;
  const xc = (x0 + x1) / 2;
  for (const s of [-1, 1]) {
    // C-channel side frames
    k.box(FM.alu, [L, 0.11, 0.012], [xc, 0.885, s * 0.255]);
    k.box(FM.alu, [L, 0.012, 0.04], [xc, 0.836, s * 0.237], [0, 0, 0], nc);
    k.box(FM.alu, [L, 0.012, 0.03], [xc, 0.934, s * 0.244], [0, 0, 0], nc);
    // adjustable guide rails on brackets
    k.cyl(FM.steel, 0.009, L - 0.1, [xc, 1.0, s * 0.275], [0, 0, Math.PI / 2], 8, nc);
    for (let x = x0 + 0.3; x < x1; x += 0.9) {
      k.box(FM.steelDark, [0.02, 0.07, 0.02], [x, 0.965, s * 0.275], [0, 0, 0], nc);
      k.box(KM.plastic, [0.03, 0.02, 0.03], [x, 0.94, s * 0.275], [0, 0, 0], nc);
    }
  }
  // rollers (none under the taping bed)
  for (let i = 0; i < 26; i++) {
    const x = -2.2 + i * 0.2;
    if (x > -1.3 && x < 0.2) continue;
    k.cyl(FM.steel, 0.02, 0.48, [x, 0.92, 0], [Math.PI / 2, 0, 0], 12, nc);
    k.cyl(FM.steelDark, 0.008, 0.5, [x, 0.92, 0], [Math.PI / 2, 0, 0], 6, nc);
  }
  // legs with levelling feet, braces, stretchers
  for (const x of [-2.25, -0.55, 1.15, 2.85]) {
    for (const s of [-1, 1]) {
      k.box(FM.alu, [0.05, 0.79, 0.05], [x, 0.435, s * 0.22]);
      foot(k, [x, 0, s * 0.22]);
    }
    k.box(FM.alu, [0.04, 0.04, 0.4], [x, 0.25, 0], [0, 0, 0], nc);
  }
  k.box(FM.alu, [L - 0.3, 0.04, 0.04], [xc, 0.25, -0.22], [0, 0, 0], nc);
  // drive: gearmotor under the discharge end, chain guard
  k.cyl(FM.alu, 0.07, 0.24, [2.55, 0.7, -0.08], [Math.PI / 2, 0, 0], 16);
  k.rbox(KM.paintBlue, [0.16, 0.14, 0.14], 0.01, [2.55, 0.7, 0.1]);
  k.rbox(KM.paintYellow, [0.5, 0.12, 0.02], 0.008, [2.55, 0.79, -0.265]);
  // plates, EMO, cable tray under the frame
  k.label('model', 'PL-5', 'PACKING LINE · 24 V MDR', 0.3, 0.075, [-1.95, 0.885, 0.262]);
  estop(k, [2.85, 0.6, 0.245]);
  k.box(KM.paintGraphite, [L - 0.4, 0.03, 0.12], [xc, 0.74, -0.05], [0, 0, 0], nc);
  k.ao(L, 0.6, [xc, 0, 0], 1.2);
}

/** Tape & reel machine: rear cabinet, sealing head over the carrier tape, pick-and-place gantry, reel spindle. */
function buildTaper(k: Kit) {
  const nc = { cast: false };
  // rear cabinet (front at z = −0.3)
  k.at([-0.55, 0, -0.46], 0, () => {
    cabinet(k, { size: [1.4, 1.62, 0.32], body: KM.paintWarm, panels: 2, rows: [0.62], handles: true, stripe: KM.paintAccent, ao: true });
    k.label('model', 'TR-12', 'TAPE & REEL · 8–24 mm', 0.32, 0.08, [-0.3, 1.45, 0.162]);
    ledStrip(k, 0.5, [0.3, 1.53, 0.162]);
  });
  // taping bed with tape track guides
  k.rbox(FM.steel, [1.45, 0.022, 0.4], 0.006, [-0.55, 0.917, 0]);
  for (const z of [-0.018, 0.018]) k.box(FM.steelDark, [1.4, 0.012, 0.006], [-0.55, 0.934, z], [0, 0, 0], nc);
  // sealing head: upper housing with a framed inspection door, rear column, heat-seal shoe
  // on a pneumatic slide over the carrier tape, vision camera, cover-tape supply reel
  k.at([-0.75, 0, -0.15], 0, () => {
    const zf = 0.1762;
    k.rbox(KM.paintWarm, [0.5, 0.4, 0.35], 0.02, [0, 1.35, 0]);
    k.rbox(KM.paintWarm, [0.5, 0.2, 0.12], 0.012, [0, 1.05, -0.115]);
    k.box(KM.paintGraphite, [0.47, 0.012, 0.32], [0, 1.145, 0.0], [0, 0, 0], nc);
    // door outline, hinge, fasteners, latch
    for (const y of [1.17, 1.53]) k.box(KM.seam, [0.44, 0.004, 0.002], [0, y, zf], [0, 0, 0], nc);
    for (const x of [-0.22, 0.22]) k.box(KM.seam, [0.004, 0.36, 0.002], [x, 1.35, zf], [0, 0, 0], nc);
    for (const y of [1.2, 1.5]) k.cyl(FM.steelDark, 0.008, 0.05, [-0.226, y, zf + 0.004], [0, 0, 0], 8, nc);
    for (const [x, y] of [[-0.195, 1.195], [0.195, 1.195], [-0.195, 1.505], [0.195, 1.505]] as const)
      k.cyl(KM.stainlessDark, 0.005, 0.004, [x, y, zf + 0.001], [Math.PI / 2, 0, 0], 8, nc);
    k.rbox(KM.anodized, [0.014, 0.08, 0.012], 0.004, [0.2, 1.35, zf + 0.006], [0, 0, 0], nc);
    k.rbox(KM.paintGraphite, [0.3, 0.2, 0.012], 0.008, [-0.02, 1.38, zf + 0.004]);
    k.box(KM.glassSmoke, [0.26, 0.16, 0.004], [-0.02, 1.38, zf + 0.011], [0, 0, 0], nc);
    // side louvres
    k.at([-0.2512, 1.33, -0.02], -Math.PI / 2, () => grille(k, 0.22, 0.14, [0, 0, 0], { m: KM.paintWarm, pitch: 0.02, cast: false }));
    // pneumatic slide with guide rods and the heated shoe (shoe face 13 mm above the tape)
    k.cyl(KM.anodized, 0.022, 0.1, [-0.03, 1.09, 0.15], [0, 0, 0], 16);
    k.cyl(KM.anodizedDark, 0.024, 0.012, [-0.03, 1.04, 0.15], [0, 0, 0], 16, nc);
    k.cyl(KM.chrome, 0.008, 0.07, [-0.03, 1.0, 0.15], [0, 0, 0], 10, nc);
    for (const dx of [-0.05, 0.05]) k.cyl(KM.chrome, 0.005, 0.17, [-0.03 + dx, 1.06, 0.15], [0, 0, 0], 8, nc);
    k.rbox(FM.steel, [0.13, 0.022, 0.06], 0.004, [-0.03, 0.966, 0.15]);
    k.box(KM.copper, [0.12, 0.008, 0.04], [-0.03, 0.951, 0.15], [0, 0, 0], nc);
    k.cyl(KM.paintRed, 0.003, 0.12, [0.04, 0.99, 0.15], [0, 0, Math.PI / 2.4], 6, nc);
    // vision camera on a bracket, looking down into the pockets
    k.box(FM.alu, [0.02, 0.17, 0.03], [-0.21, 1.065, 0.13]);
    k.rbox(KM.paintGraphite, [0.05, 0.07, 0.05], 0.006, [-0.21, 1.0, 0.15]);
    k.cyl(KM.paintGraphite, 0.02, 0.03, [-0.21, 0.955, 0.15], [0, 0, 0], 14, nc);
    k.cyl(KM.glassSmoke, 0.016, 0.004, [-0.21, 0.939, 0.15], [0, 0, 0], 14, nc);
    k.torus(KM.ledWhite, 0.024, 0.003, [-0.21, 0.942, 0.15], [0, 0, 0], 16, { cast: false });
    // cover-tape supply reel and guide rollers on the door
    k.at([0.19, 1.42, zf], 0, () => {
      for (const z of [0.006, 0.03]) k.cyl(KM.plasticWhite, 0.075, 0.003, [0, 0, z], [Math.PI / 2, 0, 0], 28, nc);
      k.cyl(KM.ptfe, 0.055, 0.022, [0, 0, 0.018], [Math.PI / 2, 0, 0], 24, nc);
      k.cyl(KM.plastic, 0.022, 0.04, [0, 0, 0.02], [Math.PI / 2, 0, 0], 14, nc);
      k.cyl(KM.anodizedDark, 0.014, 0.02, [0, 0, 0.048], [Math.PI / 2, 0, 0], 12, nc);
    });
    for (const [x, y] of [[0.17, 1.24], [0.06, 1.13]] as const) {
      k.cyl(FM.steel, 0.012, 0.03, [x, y, zf + 0.018], [Math.PI / 2, 0, 0], 14, nc);
      k.cyl(FM.steelDark, 0.016, 0.003, [x, y, zf + 0.034], [Math.PI / 2, 0, 0], 14, nc);
    }
    k.tube(KM.ptfe, [[0.135, 1.38, zf + 0.02], [0.182, 1.24, zf + 0.02], [0.072, 1.12, zf + 0.02], [0.0, 1.0, 0.16], [-0.03, 0.975, 0.15]], 0.0025, { radial: 4, cast: false });
    k.label('warn', 'HOT SURFACE', '', 0.05, 0.05, [0.17, 1.52, zf + 0.001]);
    k.label('tag', 'SEAL 180 °C', 'COVER TAPE 5.4 mm', 0.12, 0.03, [-0.02, 1.25, zf + 0.001]);
    ledStrip(k, 0.08, [-0.15, 1.25, zf]);
  });
  // pick-and-place gantry over the tray stack
  k.box(FM.alu, [0.05, 0.6, 0.05], [-2.05, 1.22, -0.29]);
  k.box(FM.alu, [1.15, 0.06, 0.08], [-1.47, 1.5, -0.2]);
  k.rbox(KM.paintGraphite, [0.12, 0.1, 0.1], 0.01, [-1.55, 1.5, -0.1]);
  k.box(FM.steel, [0.025, 0.32, 0.025], [-1.55, 1.3, -0.06]);
  k.cyl(KM.plastic, 0.012, 0.04, [-1.55, 1.12, -0.06], [0, 0, 0], 8, nc);
  k.box(KM.paintGraphite, [1.0, 0.03, 0.03], [-1.47, 1.46, -0.16], [0, 0, 0], nc);
  // reel drive: anodised mounting plate, servo + gearhead behind it, hub boss, keyed
  // spindle, plate fasteners, tape guide roller, pedestal
  k.at([-0.3, 0, 0], 0, () => {
    k.rbox(FM.alu, [0.4, 0.46, 0.014], 0.01, [0, 1.22, -0.045]);
    k.rbox(KM.paintGraphite, [0.4, 0.06, 0.016], 0.006, [0, 1.42, -0.045]);
    k.label('tag', 'REEL 13"', 'EIA-481 · 12 mm', 0.12, 0.03, [0.09, 1.42, -0.0365]);
    for (const [x, y] of [[-0.18, 1.01], [0.18, 1.01], [-0.18, 1.37], [0.18, 1.37]] as const)
      k.cyl(KM.stainlessDark, 0.007, 0.006, [x, y, -0.036], [Math.PI / 2, 0, 0], 8, nc);
    k.cyl(FM.steel, 0.034, 0.02, [0, 1.25, -0.03], [Math.PI / 2, 0, 0], 24);
    k.torus(KM.seam, 0.034, 0.002, [0, 1.25, -0.02], [Math.PI / 2, 0, 0], 24, { cast: false });
    k.cyl(FM.steel, 0.016, 0.08, [0, 1.25, -0.01], [Math.PI / 2, 0, 0], 12, nc);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      k.box(FM.steelDark, [0.006, 0.006, 0.05], [Math.cos(a) * 0.017, 1.25 + Math.sin(a) * 0.017, 0.005], [0, 0, a], nc);
    }
    k.cyl(KM.paintGraphite, 0.05, 0.12, [0, 1.25, -0.115], [Math.PI / 2, 0, 0], 20);
    k.rbox(KM.anodizedDark, [0.09, 0.09, 0.05], 0.008, [0, 1.25, -0.075]);
    k.cyl(FM.steel, 0.014, 0.05, [-0.155, 0.985, -0.01], [Math.PI / 2, 0, 0], 14, nc);
    for (const z of [-0.012, 0.035]) k.cyl(FM.steelDark, 0.02, 0.003, [-0.155, 0.985, z], [Math.PI / 2, 0, 0], 14, nc);
    k.rbox(FM.alu, [0.08, 0.27, 0.06], 0.008, [0, 0.995, -0.07]);
    k.box(FM.aluDark, [0.14, 0.012, 0.1], [0, 0.866, -0.07], [0, 0, 0], nc);
  });
  // operator panel on an arm at the left end
  hmi(k, [-1.2, 1.45, -0.06], 0);
}

/** Vacuum bag sealer: stand, platen under the bag, hinged hood with heat-seal bar, vacuum nozzle, controls. */
function buildSealer(k: Kit) {
  const nc = { cast: false };
  for (const x of [0.7, 1.3]) for (const s of [-1, 1]) k.box(FM.alu, [0.04, 1.03, 0.04], [x, 0.515, s * 0.31]);
  for (const s of [-1, 1]) k.box(FM.alu, [0.64, 0.04, 0.04], [1.0, 0.3, s * 0.31], [0, 0, 0], nc);
  k.rbox(FM.steel, [0.66, 0.04, 0.66], 0.008, [1.0, 1.05, 0]);
  k.box(KM.rubber, [0.6, 0.006, 0.6], [1.0, 1.072, 0], [0, 0, 0], nc);
  // hood (hinged at the back) with seal bar
  k.rbox(KM.paintGrey, [0.6, 0.12, 0.5], 0.015, [1.0, 1.42, 0]);
  k.box(KM.glassSmoke, [0.4, 0.004, 0.3], [1.0, 1.481, 0], [0, 0, 0], nc);
  k.box(KM.copper, [0.6, 0.04, 0.05], [1.0, 1.35, 0.22]);
  k.box(KM.ptfe, [0.58, 0.004, 0.04], [1.0, 1.328, 0.22], [0, 0, 0], nc);
  for (const x of [0.76, 1.24]) {
    k.cyl(KM.chrome, 0.012, 0.32, [x, 1.22, -0.27], [0, 0, 0], 8);
    k.box(FM.steelDark, [0.04, 0.04, 0.06], [x, 1.38, -0.25], [0, 0, 0], nc);
  }
  // vacuum nozzle into the bag mouth
  k.pipe(FM.steel, [[1.0, 0.8, -0.34], [1.0, 1.1, -0.34], [1.0, 1.1, -0.2]], 0.012, 0.04);
  // control box with vacuum gauge
  k.at([1.5, 0, 0.18], 0, () => {
    k.box(FM.alu, [0.04, 1.0, 0.04], [0, 0.5, 0]);
    k.rbox(KM.paint, [0.22, 0.26, 0.12], 0.012, [0, 1.12, 0.02]);
    k.cyl(KM.paintGraphite, 0.045, 0.012, [0, 1.17, 0.085], [Math.PI / 2, 0, 0], 20, nc);
    k.cyl(KM.plasticWhite, 0.038, 0.004, [0, 1.17, 0.092], [Math.PI / 2, 0, 0], 20, nc);
    k.box(KM.screen, [0.12, 0.04, 0.003], [0, 1.06, 0.081], [0, 0, 0], nc);
    k.cyl(KM.paintRed, 0.014, 0.012, [0.07, 1.04, 0.085], [Math.PI / 2, 0, 0], 12, nc);
  });
  k.label('model', 'VS-2', 'VACUUM SEALER · N₂ FLUSH', 0.26, 0.065, [1.0, 1.42, 0.252]);
  k.label('warn', 'HOT SURFACE', '', 0.06, 0.06, [1.22, 1.42, 0.252]);
}

/** Case sealer + print-and-apply labeller over the carton station. */
function buildCartoner(k: Kit) {
  const nc = { cast: false };
  for (const x of [1.88, 2.52]) for (const s of [-1, 1]) k.box(FM.alu, [0.045, 0.62, 0.045], [x, 1.25, s * 0.34]);
  for (const x of [1.88, 2.52]) k.box(FM.alu, [0.045, 0.045, 0.72], [x, 1.56, 0]);
  k.box(FM.alu, [0.68, 0.05, 0.05], [2.2, 1.56, 0]);
  // top tape head with roll
  k.rbox(KM.paintGraphite, [0.3, 0.1, 0.12], 0.01, [2.2, 1.42, 0]);
  k.cyl(packTape, 0.07, 0.05, [2.2, 1.5, 0.0], [Math.PI / 2, 0, 0], 20);
  k.cyl(KM.plastic, 0.03, 0.055, [2.2, 1.5, 0.0], [Math.PI / 2, 0, 0], 12, nc);
  k.box(KM.paintYellow, [0.03, 0.06, 0.1], [2.06, 1.35, 0], [0, 0, 0.4], nc);
  // print-and-apply labeller on the far side
  k.box(FM.alu, [0.04, 1.3, 0.04], [2.2, 0.65, -0.62]);
  k.rbox(KM.plasticWhite, [0.3, 0.26, 0.24], 0.015, [2.2, 1.35, -0.55]);
  k.box(KM.screen, [0.1, 0.05, 0.003], [2.2, 1.42, -0.428], [0, 0, 0], nc);
  k.cyl(labelMat, 0.06, 0.08, [2.2, 1.35, -0.42], [Math.PI / 2, 0, 0], 16, nc);
  k.box(FM.steel, [0.05, 0.05, 0.22], [2.2, 1.2, -0.37]);
  k.box(KM.rubber, [0.12, 0.08, 0.02], [2.2, 1.2, -0.255], [0, 0, 0], nc);
}

/** Packing room: ESD wall panels, signage, dry cabinet, materials shelf, workbench, floor marks. */
function buildPackRoom(k: Kit) {
  const nc = { cast: false };
  // sandwich-panel wall (front face z = −2.95)
  k.box(KM.paint, [16, 4, 0.1], [0, 2, -3]);
  for (let x = -7.2; x < 8; x += 1.2) k.box(KM.seam, [0.006, 3.9, 0.004], [x, 2, -2.948], [0, 0, 0], nc);
  k.box(KM.seam, [16, 0.006, 0.004], [0, 2.4, -2.948], [0, 0, 0], nc);
  k.box(FM.steel, [16, 0.1, 0.02], [0, 0.05, -2.94], [0, 0, 0], nc);
  for (const x of [-5.4, 4.8]) grille(k, 0.8, 0.3, [x, 0.4, -2.945], { m: KM.paint, pitch: 0.04, cast: false });
  cableTray(k, [-8, 3.2, -2.75], [8, 3.2, -2.75], 0.3, 4);
  k.label('info', 'ESD PROTECTED AREA', 'WRIST STRAP · HEEL GROUNDER', 0.8, 0.2, [-1.0, 2.0, -2.946]);
  k.label('info', 'MSL 3 · FLOOR LIFE 168 h', 'J-STD-033 · ≤ 30 °C / 60 %RH', 0.8, 0.2, [0.1, 2.0, -2.946]);
  // dry cabinet with glazed doors: shelves of trays and reels, hygrometer
  k.at([-3.6, 0, -2.6], 0, () => {
    cabinet(k, { size: [1.2, 1.9, 0.6], body: KM.paintGrey, panels: 2, rows: [], vent: false, stripe: false, handles: true });
    for (const x of [-0.3, 0.3]) {
      k.box(KM.glass, [0.5, 1.3, 0.006], [x, 1.05, 0.302], [0, 0, 0], nc);
      k.box(KM.paintGraphite, [0.54, 0.02, 0.012], [x, 1.71, 0.3], [0, 0, 0], nc);
      k.box(KM.paintGraphite, [0.54, 0.02, 0.012], [x, 0.39, 0.3], [0, 0, 0], nc);
    }
    for (const y of [0.55, 0.9, 1.25, 1.6]) {
      k.box(FM.steel, [1.12, 0.012, 0.5], [0, y, 0.02], [0, 0, 0], nc);
      for (let i = 0; i < 5; i++) k.cyl(reelMat, 0.11, 0.025, [-0.44 + i * 0.22, y + 0.12, 0.05], [Math.PI / 2, 0, 0], 16, nc);
    }
    k.rbox(KM.paintGraphite, [0.2, 0.08, 0.02], 0.006, [0, 1.8, 0.31]);
    k.box(KM.screen, [0.16, 0.05, 0.003], [0, 1.8, 0.321], [0, 0, 0], nc);
    k.label('tag', 'DRY CABINET', '< 5 %RH · N₂', 0.3, 0.075, [0, 1.92, 0.302]);
  });
  // shelf with moisture-barrier bags, desiccant and humidity cards
  k.at([3.9, 0, -2.6], 0, () => {
    for (const x of [-0.6, 0.6]) for (const z of [-0.2, 0.2]) k.box(FM.alu, [0.035, 1.8, 0.035], [x, 0.9, z]);
    for (const y of [0.15, 0.7, 1.25, 1.78]) k.box(FM.steelDark, [1.24, 0.02, 0.44], [0, y, 0]);
    for (let i = 0; i < 4; i++) k.box(cardboard, [0.26, 0.3, 0.36], [-0.45 + i * 0.3, 0.86, 0]);
    for (let i = 0; i < 6; i++) k.cyl(bagMat, 0.07, 0.38, [-0.48 + i * 0.19, 1.34, 0], [Math.PI / 2, 0, 0], 12);
    for (let i = 0; i < 3; i++) k.box(cardboardDark, [0.36, 0.22, 0.34], [-0.4 + i * 0.4, 0.27, 0]);
  });
  // ESD workbench with scanner, monitor and label rolls
  k.at([-4.2, 0, -0.4], Math.PI / 2, () => {
    k.rbox(KM.ptfe, [1.6, 0.04, 0.75], 0.006, [0, 0.9, 0]);
    k.box(KM.paintBlue, [1.6, 0.004, 0.72], [0, 0.922, 0], [0, 0, 0], nc);
    for (const x of [-0.75, 0.75]) for (const z of [-0.33, 0.33]) k.box(FM.alu, [0.04, 0.88, 0.04], [x, 0.44, z]);
    k.box(FM.alu, [1.5, 0.03, 0.03], [0, 0.2, -0.33], [0, 0, 0], nc);
    k.rbox(KM.plastic, [0.5, 0.32, 0.03], 0.01, [0.2, 1.22, -0.25]);
    k.box(KM.screen, [0.46, 0.27, 0.003], [0.2, 1.22, -0.233], [0, 0, 0], nc);
    k.box(KM.plastic, [0.04, 0.22, 0.04], [0.2, 1.03, -0.27]);
    k.rbox(KM.plastic, [0.06, 0.1, 0.05], 0.01, [-0.4, 0.98, 0.1]);
    for (let i = 0; i < 3; i++) k.cyl(labelMat, 0.05, 0.08, [-0.6 + i * 0.12, 0.97, -0.2], [Math.PI / 2, 0, 0], 14, nc);
  });
  // floor: ESD walkway and line boundary marks
  for (const z of [0.85, -0.85]) k.box(KM.paintYellow, [6.6, 0.002, 0.06], [0.3, 0.001, z], [0, 0, 0], nc);
  k.box(KM.ledGreen, [0.02, 0.002, 0.02], [0, -1, 0], [0, 0, 0], nc);
}

/** Reel flange: disc with three kidney windows and a centre bore, extruded along +Z. */
function reelFlange(r: number, t: number) {
  const s = new THREE.Shape();
  s.absarc(0, 0, r, 0, Math.PI * 2, false);
  for (let i = 0; i < 3; i++) {
    const a0 = (i / 3) * Math.PI * 2 + 0.25;
    const a1 = a0 + 1.45;
    const h = new THREE.Path();
    h.absarc(0, 0, r * 0.84, a0, a1, false);
    h.absarc(0, 0, r * 0.42, a1, a0, true);
    s.holes.push(h);
  }
  const bore = new THREE.Path();
  bore.absarc(0, 0, 0.0065, 0, Math.PI * 2, true);
  s.holes.push(bore);
  return new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 20 });
}

/** 13-inch reel (axis along local Z, flanges at z = 0 and 0.026): windowed flanges, wound tape, hub. */
function buildReel(k: Kit) {
  const nc = { cast: false };
  const fl = reelFlange(0.165, 0.004);
  for (const z of [-0.002, 0.024]) k.add(reelMat, fl, [0, 0, z]);
  fl.dispose();
  k.cyl(tapeMat, 0.12, 0.022, [0, 0, 0.013], [Math.PI / 2, 0, 0], 40);
  k.cyl(KM.plastic, 0.05, 0.03, [0, 0, 0.013], [Math.PI / 2, 0, 0], 24, nc);
  k.cyl(KM.plasticWhite, 0.014, 0.032, [0, 0, 0.013], [Math.PI / 2, 0, 0], 12, nc);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 2.02;
    k.box(KM.plastic, [0.07, 0.012, 0.022], [Math.cos(a) * 0.085, Math.sin(a) * 0.085, 0.013], [0, 0, a], nc);
  }
  k.label('tag', 'CH-184', 'LOT A0731 · 500 pcs', 0.05, 0.03, [-0.06, -0.085, 0.0285], [0, 0, 4.11 - Math.PI / 2]);
}

/** Moisture-barrier bag (pillow form, heat-sealed lip at the front) with its humidity card label. */
function buildBag(k: Kit) {
  k.rbox(bagMat, [0.42, 0.09, 0.42], 0.04, [0, 0, 0], [0, 0, 0], { cast: false });
  k.box(bagMat, [0.43, 0.004, 0.06], [0, -0.005, 0.235], [0, 0, 0], { cast: false });
  k.box(labelMat, [0.08, 0.002, 0.06], [0.1, 0.046, 0.08], [0, 0, 0], { cast: false });
  k.box(KM.paintBlue, [0.035, 0.0025, 0.035], [0.1, 0.0475, 0.075], [0, 0, 0], { cast: false });
}

function PackLine() {
  const reel = useRef<THREE.Group>(null);
  const bag = useRef<THREE.Group>(null);
  const carton = useRef<THREE.Group>(null);
  const flapA = useRef<THREE.Mesh>(null);
  const flapB = useRef<THREE.Mesh>(null);
  const label = useRef<THREE.Mesh>(null);
  const pockets = useRef<THREE.InstancedMesh>(null);
  const trays = useRef<THREE.Group>(null);
  const labelMatT = useMemo(() => new THREE.MeshStandardMaterial({ map: labelTexture(), roughness: 0.6 }), []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const spin = useRef(0);
  const st = useStation({ line: buildConveyor, taper: buildTaper, bagger: buildSealer, cartoner: buildCartoner, _room: buildPackRoom }, []);
  // JEDEC tray (moulded matrix tray with pocket grid) and the reel (flanges with windows, hub, wound tape)
  const trayGeo = useMemo(
    () =>
      kitGeometry((k) => {
        k.rbox(KM.plastic, [0.32, 0.008, 0.14], 0.002, [0, 0, 0]);
        for (let i = 0; i < 8; i++) for (let j = 0; j < 3; j++) k.box(KM.plastic, [0.028, 0.004, 0.028], [-0.14 + i * 0.04, 0.005, -0.04 + j * 0.04]);
      }),
    [],
  );
  useEffect(() => () => trayGeo.dispose(), [trayGeo]);
  const reelParts = useKit(buildReel);
  const bagParts = useKit(buildBag);
  useFrame((_, dt) => {
    const tr = smooth(pp('tray'));
    const rl = inPhase('reel') ? engine.player.view.phaseT : pp('reel');
    const dp = inPhase('drypack') ? engine.player.view.phaseT : pp('drypack');
    const ct = inPhase('carton') ? engine.player.view.phaseT : pp('carton');
    if (trays.current) trays.current.children.forEach((c, i) => (c.position.y = 0.92 + i * 0.012 + (i / 6 > tr ? 0.3 : 0)));
    if (inPhase('reel')) spin.current += pdt(dt) * 2.5;
    // reel travels: tape&reel station → dry-pack station → carton station
    const toBag = smooth(clamp(dp / 0.3));
    const toBox = smooth(clamp(ct / 0.35));
    const rx = lerp(lerp(-0.3, 1.0, toBag), 2.2, toBox);
    const ry = lerp(1.25, 1.12, toBag);
    if (reel.current) {
      reel.current.position.set(rx, toBox > 0 ? lerp(1.12, 1.02, toBox) : ry, 0);
      reel.current.rotation.z = -spin.current;
      reel.current.rotation.x = lerp(0, -Math.PI / 2, toBag);
    }
    track('focus', rx, 1.1, 0);
    // carrier-tape pockets filling
    if (pockets.current) {
      for (let i = 0; i < 24; i++) {
        const filled = i / 24 < rl * 1.2;
        o.position.set(-1.1 + i * 0.03, 0.935, 0);
        o.scale.set(filled ? 0.02 : 0, 0.006, filled ? 0.02 : 0);
        o.updateMatrix();
        pockets.current.setMatrixAt(i, o.matrix);
      }
      pockets.current.instanceMatrix.needsUpdate = true;
    }
    if (bag.current) {
      const vis = dp > 0.25 && ct < 0.35;
      bag.current.visible = vis;
      const vac = smooth(clamp((dp - 0.6) / 0.4));
      bag.current.position.set(rx, 1.12, 0);
      bag.current.scale.set(1 - 0.12 * vac, 1 - 0.5 * vac, 1 - 0.12 * vac);
    }
    if (flapA.current && flapB.current) {
      const close = smooth(clamp((ct - 0.45) / 0.35));
      flapA.current.rotation.z = lerp(-1.4, 0, close);
      flapB.current.rotation.z = lerp(1.4, 0, close);
    }
    if (label.current) label.current.visible = ct > 0.85;
  });
  return (
    <group>
      <StationView m={st} />
      <Clickable sel={{ kind: 'machine', id: 'packing-line', label: 'Packing line' }}>
        <Pick m={st} tag="line" />
        <SignalTower position={[2.8, ROLLER_TOP + 0.06, 0.3]} />
      </Clickable>
      {/* tray stack */}
      <Clickable sel={{ kind: 'component', id: 'pnp', machine: 'packing-line', label: 'JEDEC trays' }}>
        <group ref={trays} position={[-1.7, 0, 0]}>
          {Array.from({ length: 6 }, (_, i) => (
            <mesh key={i} geometry={trayGeo} material={i % 2 ? tapeMat : M.foupDark} castShadow />
          ))}
        </group>
      </Clickable>
      {/* tape & reel machine */}
      <Clickable sel={{ kind: 'component', id: 'taper', machine: 'packing-line', label: 'Taping machine' }}>
        <Pick m={st} tag="taper" />
        <mesh geometry={GEO.box} material={tapeMat} scale={[0.8, 0.004, 0.024]} position={[-0.75, 0.93, 0]} />
      </Clickable>
      <instancedMesh ref={pockets} args={[GEO.box, M.pcb, 24]} />
      <group ref={reel}>
        <Clickable sel={{ kind: 'component', id: 'reel', machine: 'packing-line', label: 'Reel (13-inch)' }}>
          <Baked parts={reelParts} />
        </Clickable>
      </group>
      {/* dry-pack bag (vacuum-sealed around the reel) */}
      <group ref={bag}>
        <Clickable sel={{ kind: 'component', id: 'bagger', machine: 'packing-line', label: 'Moisture-barrier bag + desiccant + HIC' }}>
          <Baked parts={bagParts} />
        </Clickable>
      </group>
      <Clickable sel={{ kind: 'component', id: 'bagger', machine: 'packing-line', label: 'Vacuum bag sealer' }}>
        <Pick m={st} tag="bagger" />
      </Clickable>
      {/* carton */}
      <group ref={carton} position={[2.2, 0.92, 0]}>
        <Clickable sel={{ kind: 'component', id: 'cartoner', machine: 'packing-line', label: 'Carton & label' }}>
          <mesh geometry={GEO.box} material={cardboard} scale={[0.46, 0.012, 0.46]} position={[0, 0.006, 0]} />
          {[
            [0, 0.12, 0.23, 0.46, 0.012],
            [0, 0.12, -0.23, 0.46, 0.012],
          ].map(([x, y, z, w, d], i) => (
            <mesh key={i} geometry={GEO.box} material={cardboard} scale={[w, 0.24, d]} position={[x, y, z]} />
          ))}
          {[-0.23, 0.23].map((x) => (
            <mesh key={x} geometry={GEO.box} material={cardboard} scale={[0.012, 0.24, 0.46]} position={[x, 0.12, 0]} />
          ))}
          <mesh ref={flapA} geometry={GEO.box} material={cardboardDark} scale={[0.23, 0.008, 0.46]} position={[-0.115, 0.24, 0]} />
          <mesh ref={flapB} geometry={GEO.box} material={cardboardDark} scale={[0.23, 0.008, 0.46]} position={[0.115, 0.24, 0]} />
          <mesh ref={label} position={[0, 0.13, 0.237]} material={labelMatT}>
            <planeGeometry args={[0.2, 0.1]} />
          </mesh>
        </Clickable>
      </group>
      <Clickable sel={{ kind: 'component', id: 'cartoner', machine: 'packing-line', label: 'Case sealer & label applicator' }}>
        <Pick m={st} tag="cartoner" />
      </Clickable>
      <SensorIndicator id="humidity" channel="rh" machine="packing-line" position={[1.2, 1.32, 0.25]} size={0.03} />
      <TechLabel
        position={[-2.0, 1.75, 0.3]}
        title="PACKING LINE"
        lines={['moisture-sensitive devices are dry-packed (J-STD-033)']}
        min={1}
        value={() => `${engine.player.view.phase.label} · reel ${engine.tele.value('reel', 0).toFixed(0)} units · bag ${engine.tele.value('rh', 0).toFixed(1)} %RH`}
      />
    </group>
  );
}

/* ================================================================ warehouse */

const DOCK = new THREE.Vector3(-7, 0, 1);
const PACK_AREA = new THREE.Vector3(0, 0, 3);
const SLOT = new THREE.Vector3(8, 2.2, -6);
const PICK_SLOT = new THREE.Vector3(4, 0.15, -6);

/** Selective pallet racking: braced upright frames, beam pairs, column guards, signage. */
function buildRacks(k: Kit) {
  const nc = { cast: false };
  for (const z of [-6, -10]) {
    for (let i = 0; i < 10; i++) {
      const x = -1.75 + i * 1.5;
      for (const s of [-1, 1]) {
        k.box(rackBlue, [0.08, 8.4, 0.07], [x, 4.2, z + s * 0.56]);
        k.box(KM.seam, [0.004, 8.2, 0.02], [x + 0.041, 4.2, z + s * 0.56], [0, 0, 0], nc);
        k.box(FM.steel, [0.2, 0.012, 0.16], [x, 0.006, z + s * 0.56], [0, 0, 0], nc);
        k.box(KM.paintYellow, [0.16, 0.4, 0.14], [x, 0.2, z + s * 0.56 + s * 0.02]);
      }
      // frame bracing: horizontals and diagonals between the two posts
      for (let y = 0.3; y < 8.2; y += 1.0) {
        k.box(rackBlue, [0.03, 0.03, 1.05], [x, y, z], [0, 0, 0], nc);
        k.box(rackBlue, [0.025, 0.025, 1.4], [x, y + 0.5, z], [Math.atan2(1.0, 1.05) * (Math.round(y) % 2 ? 1 : -1), 0, 0], nc);
      }
    }
    // beam pairs at each level
    for (const y of [0.1, 2.15, 4.2, 6.25])
      for (let i = 0; i < 9; i++) {
        const x = -1.0 + i * 1.5;
        for (const s of [-1, 1]) {
          k.box(rackOrange, [1.42, 0.1, 0.05], [x, y, z + s * 0.53]);
          k.box(KM.paintGraphite, [1.42, 0.01, 0.002], [x, y, z + s * 0.556], [0, 0, 0], nc);
        }
        if (y > 0.2) for (const dx of [-0.35, 0.35]) k.box(FM.steelDark, [0.04, 0.03, 1.05], [x + dx, y + 0.04, z], [0, 0, 0], nc);
      }
    // row-end guard and load signs
    k.box(KM.paintYellow, [0.1, 0.4, 1.3], [-2.0, 0.2, z]);
    k.box(KM.paintGraphite, [0.02, 0.08, 1.3], [-2.0, 0.42, z], [0, 0, 0], nc);
    k.label('info', z === -6 ? 'AISLE A' : 'AISLE B', 'BAYS 01–09 · LEVELS 1–4', 0.6, 0.15, [-1.75, 2.6, z + 0.6]);
    k.label('warn', 'MAX 1000 kg', '', 0.22, 0.22, [-1.75, 1.9, z + 0.6]);
  }
  k.ao(14, 1.4, [5, 0, -6], 1.1);
  k.ao(14, 1.4, [5, 0, -10], 1.1);
}

/** Building: clad back wall with windows and columns, dock wall with three dock positions, yard, marks, lights. */
function buildWarehouse(k: Kit) {
  const nc = { cast: false };
  const H = 10;
  // back wall: ribbed sandwich cladding, clerestory band, columns, cable tray
  k.box(KM.paintGrey, [40, H, 0.2], [0, H / 2, -13]);
  for (let x = -19.85; x < 20; x += 0.3) k.box(KM.paintGrey, [0.05, 6.4, 0.05], [x, 3.2, -12.88], [0, 0, 0], nc);
  k.box(KM.glassSmoke, [38, 1.0, 0.05], [0, 7.6, -12.88], [0, 0, 0], nc);
  for (let x = -19; x <= 19; x += 2) k.box(FM.aluDark, [0.06, 1.1, 0.07], [x, 7.6, -12.86], [0, 0, 0], nc);
  for (let x = -16; x <= 16; x += 8) iBeam(k, H - 0.2, [x, 0, -12.6], 0.36, KM.paintGrey);
  cableTray(k, [-19, 6.2, -12.6], [19, 6.2, -12.6], 0.35, 5);
  // dock wall at x = −7.3, three dock positions (the middle one open for the truck)
  const wx = DOCK.x - 0.3;
  const doors = [DOCK.z - 6, DOCK.z, DOCK.z + 6];
  k.at([wx, 0, 0], Math.PI / 2, () => {
    // wall panels around the openings (local x = −world z)
    const segs: [number, number][] = [];
    let cur = -14;
    for (const dz of [...doors].sort((a, b) => a - b)) {
      segs.push([cur, dz - 1.8]);
      cur = dz + 1.8;
    }
    segs.push([cur, 13]);
    for (const [z0, z1] of segs) k.box(KM.paintGrey, [z1 - z0, H, 0.2], [-(z0 + z1) / 2, H / 2, 0]);
    for (const dz of doors) k.box(KM.paintGrey, [3.6, H - 3.8, 0.2], [-dz, 3.8 + (H - 3.8) / 2, 0]);
    for (let x = -13.8; x < 14; x += 0.3) if (!doors.some((dz) => Math.abs(-x - dz) < 2.0)) k.box(KM.paintGrey, [0.05, 6.4, 0.05], [x, 3.2, 0.12], [0, 0, 0], nc);
    for (const dz of doors) {
      const lx = -dz;
      const open = dz === DOCK.z;
      // steel frame, seals, bumpers, light, leveler
      k.box(FM.steelDark, [0.15, 3.8, 0.24], [lx - 1.8, 1.9, 0]);
      k.box(FM.steelDark, [0.15, 3.8, 0.24], [lx + 1.8, 1.9, 0]);
      k.box(FM.steelDark, [3.75, 0.15, 0.24], [lx, 3.8, 0]);
      for (const s of [-1, 1]) {
        k.box(KM.rubber, [0.25, 3.0, 0.2], [lx + s * 1.62, 2.0, 0.18]);
        k.rbox(KM.rubber, [0.22, 0.3, 0.12], 0.02, [lx + s * 1.3, 1.1, 0.16]);
      }
      k.box(KM.rubber, [3.4, 0.5, 0.2], [lx, 3.55, 0.18]);
      k.rbox(KM.paintGraphite, [3.7, 0.5, 0.5], 0.04, [lx, 4.1, 0.25]);
      if (open) {
        k.box(FM.steel, [3.2, 0.06, 1.3], [lx, 0.97, 0.75], [-0.03, 0, 0]);
        for (let i = 0; i < 8; i++) k.box(i % 2 ? KM.paintGraphite : KM.paintYellow, [0.4, 0.062, 0.06], [lx - 1.4 + i * 0.4, 0.98, 1.4]);
        k.box(KM.paintGraphite, [3.2, 0.95, 0.04], [lx, 0.475, 1.38]);
      } else {
        k.box(FM.alu, [3.5, 3.6, 0.06], [lx, 1.8, -0.02]);
        for (let y = 0.15; y < 3.6; y += 0.15) k.box(FM.aluDark, [3.5, 0.012, 0.012], [lx, y, 0.015], [0, 0, 0], nc);
        k.box(KM.paintGraphite, [3.2, 0.95, 0.04], [lx, 0.475, 0.12]);
      }
      k.cyl(FM.steel, 0.02, 0.8, [lx + 2.2, 2.8, 0.45], [Math.PI / 2, 0, 0], 8, nc);
      k.cyl(KM.ledWhite, 0.07, 0.05, [lx + 2.2, 2.75, 0.85], [0, 0, 0], 12, nc);
      k.rbox(KM.paintRed, [0.2, 0.3, 0.1], 0.01, [lx - 2.3, 1.4, 0.12]);
      k.box(KM.ledGreen, [0.08, 0.08, 0.01], [lx - 2.3, 1.45, 0.175], [0, 0, 0], nc);
    }
    k.label('info', 'DOCK 2 · OUTBOUND', 'SEMICONDUCTORS · ESD / MSL', 1.0, 0.25, [-DOCK.z, 4.7, 0.11]);
    k.label('warn', 'FORKLIFTS', '', 0.4, 0.4, [-DOCK.z - 2.6, 2.2, 0.11]);
  });
  // yard outside the dock wall: asphalt and bay lines
  k.box(KM.paintDark, [12.6, 0.01, 28], [-13.65, 0.004, 0], [0, 0, 0], nc);
  for (const dz of doors) for (const s of [-1, 1]) k.box(KM.plasticWhite, [10, 0.002, 0.12], [-13, 0.011, dz + s * 1.9], [0, 0, 0], nc);
  // floor marks: aisles, pedestrian walkway, AMR route, pack-area boundary
  for (const z of [-7.3, -4.7, -11.3]) k.box(KM.paintYellow, [15, 0.002, 0.1], [5, 0.002, z], [0, 0, 0], nc);
  k.box(KM.paintAccent, [0.9, 0.002, 18], [15.5, 0.002, -2], [0, 0, 0], nc);
  for (let x = -5; x < 9; x += 0.8) k.box(KM.plasticWhite, [0.45, 0.002, 0.06], [x, 0.002, -3.8], [0, 0, 0], nc);
  for (const [w, d, x, z] of [[2.6, 0.08, 0, 1.75], [2.6, 0.08, 0, 4.25], [0.08, 2.5, -1.3, 3], [0.08, 2.5, 1.3, 3]] as const) k.box(KM.paintYellow, [w, 0.002, d], [x, 0.002, z], [0, 0, 0], nc);
  // high-bay luminaires
  for (let i = 0; i < 8; i++) {
    const x = -14 + i * 4;
    k.box(M.lightPanel, [2.4, 0.06, 0.4], [x, 9.6, -2], [0, 0, 0], nc);
    k.rbox(FM.aluDark, [2.5, 0.1, 0.5], 0.02, [x, 9.68, -2], [0, 0, 0], nc);
    for (const dx of [-1, 1]) k.cyl(FM.steelDark, 0.006, 0.3, [x + dx, 9.88, -2], [0, 0, 0], 6, nc);
  }
}

/** Stretch wrapper mast beside the pack-area pallet, a parked pallet jack and a packing table. */
function buildPackArea(k: Kit) {
  const nc = { cast: false };
  const { x, z } = PACK_AREA;
  // pit-mounted turntable under the pallet, wrapper mast with film carriage
  k.cyl(FM.steel, 0.86, 0.012, [x, 0.006, z], [0, 0, 0], 48, nc);
  k.torus(KM.paintYellow, 0.9, 0.02, [x, 0.008, z], [0, 0, 0], 48, nc);
  for (let i = 0; i < 4; i++) k.box(KM.seam, [1.6, 0.002, 0.012], [x, 0.0125, z], [0, (i * Math.PI) / 4, 0], nc);
  k.rbox(KM.paintAccent, [0.5, 0.25, 0.6], 0.02, [x - 1.05, 0.125, z]);
  k.box(FM.alu, [0.14, 2.3, 0.14], [x - 1.05, 1.4, z]);
  k.rbox(KM.paintGraphite, [0.22, 0.3, 0.3], 0.02, [x - 0.93, 1.1, z]);
  k.cyl(wrapMat, 0.06, 0.5, [x - 0.8, 1.1, z], [0, 0, 0], 16);
  k.cyl(KM.plastic, 0.025, 0.52, [x - 0.8, 1.1, z], [0, 0, 0], 8, nc);
  k.rbox(KM.paint, [0.3, 0.4, 0.2], 0.02, [x - 1.05, 1.0, z + 0.42]);
  k.box(KM.screen, [0.2, 0.12, 0.003], [x - 1.05, 1.08, z + 0.521], [0, 0, 0], nc);
  k.label('model', 'SW-1', 'STRETCH WRAPPER', 0.22, 0.055, [x - 1.05, 0.9, z + 0.52]);
  // pallet jack
  k.at([x + 2.6, 0, z + 1.6], 0.4, () => {
    for (const s of [-1, 1]) k.box(KM.paintRed, [0.16, 0.05, 1.15], [s * 0.2, 0.06, 0.2]);
    k.rbox(KM.paintRed, [0.55, 0.25, 0.18], 0.02, [0, 0.2, -0.45]);
    k.cyl(KM.chrome, 0.012, 1.1, [0, 0.75, -0.6], [-0.35, 0, 0], 8);
    k.box(KM.rubber, [0.3, 0.04, 0.04], [0, 1.27, -0.8], [0, 0, 0], nc);
    k.cyl(KM.rubber, 0.08, 0.06, [0, 0.08, -0.48], [0, 0, Math.PI / 2], 14, nc);
  });
  // label/packing table
  k.at([x + 2.4, 0, z - 0.6], -Math.PI / 2, () => {
    k.rbox(KM.ptfe, [1.2, 0.04, 0.6], 0.006, [0, 0.88, 0]);
    for (const xx of [-0.55, 0.55]) for (const zz of [-0.25, 0.25]) k.box(FM.alu, [0.04, 0.86, 0.04], [xx, 0.43, zz]);
    k.rbox(KM.plasticWhite, [0.25, 0.2, 0.3], 0.015, [-0.3, 1.0, -0.05]);
    k.rbox(KM.plastic, [0.3, 0.22, 0.02], 0.01, [0.25, 1.1, -0.2]);
    k.box(KM.screen, [0.27, 0.18, 0.003], [0.25, 1.1, -0.188], [0, 0, 0], nc);
  });
  k.ao(1.3, 1.2, [x, 0, z], 1.1);
}

/** Parked counterbalance forklift (electric), forks lowered. */
function buildForklift(k: Kit) {
  const nc = { cast: false };
  // chassis and counterweight
  k.rbox(KM.paintYellow, [1.0, 0.55, 1.6], 0.06, [0, 0.55, 0]);
  k.rbox(KM.paintGraphite, [1.04, 0.5, 0.35], 0.08, [0, 0.62, -0.75]);
  k.rbox(KM.paintGraphite, [0.6, 0.28, 0.5], 0.04, [0, 0.98, -0.2]);
  k.rbox(KM.plastic, [0.46, 0.12, 0.42], 0.03, [0, 1.15, -0.25]);
  k.rbox(KM.plastic, [0.46, 0.4, 0.08], 0.03, [0, 1.38, -0.46], [-0.15, 0, 0]);
  // overhead guard
  for (const [x, z] of [[-0.45, 0.45], [0.45, 0.45], [-0.45, -0.62], [0.45, -0.62]] as const) k.box(KM.paintGraphite, [0.06, 1.35, 0.06], [x, 1.5, z]);
  k.box(KM.paintGraphite, [0.96, 0.05, 1.12], [0, 2.18, -0.08]);
  for (let i = 0; i < 5; i++) k.box(KM.paintGraphite, [0.92, 0.03, 0.03], [0, 2.21, -0.5 + i * 0.22], [0, 0, 0], nc);
  // steering and dash
  k.cyl(KM.plastic, 0.16, 0.03, [0, 1.3, 0.3], [-0.9, 0, 0], 16, nc);
  k.cyl(KM.paintGraphite, 0.025, 0.35, [0, 1.15, 0.36], [-0.5, 0, 0], 8, nc);
  // mast, carriage, forks
  for (const x of [-0.32, 0.32]) k.box(FM.steelDark, [0.08, 2.2, 0.12], [x, 1.15, 0.88]);
  k.box(FM.steelDark, [0.72, 0.08, 0.12], [0, 2.2, 0.88]);
  k.box(KM.paintGraphite, [0.8, 0.5, 0.06], [0, 0.35, 0.98]);
  for (const x of [-0.25, 0.25]) {
    k.box(FM.steel, [0.1, 0.04, 1.1], [x, 0.04, 1.55]);
    k.box(FM.steel, [0.1, 0.5, 0.04], [x, 0.3, 1.0]);
  }
  k.cyl(KM.chrome, 0.03, 1.2, [0, 0.9, 0.84], [0, 0, 0], 10);
  // mast ties, inner channels, lift chains, load backrest, tilt rams
  for (const y of [0.55, 1.45]) k.box(FM.steelDark, [0.72, 0.06, 0.08], [0, y, 0.86], [0, 0, 0], nc);
  for (const x of [-0.22, 0.22]) {
    k.box(FM.steel, [0.05, 2.0, 0.06], [x, 1.1, 0.95], [0, 0, 0], nc);
    k.box(KM.paintGraphite, [0.025, 1.7, 0.02], [x * 0.55, 1.25, 0.81], [0, 0, 0], nc);
  }
  for (let i = 0; i < 6; i++) k.box(KM.paintGraphite, [0.03, 0.78, 0.03], [-0.35 + i * 0.14, 1.0, 1.0], [0, 0, 0], nc);
  k.box(KM.paintGraphite, [0.82, 0.04, 0.04], [0, 1.4, 1.0], [0, 0, 0], nc);
  for (const x of [-0.42, 0.42]) {
    k.cyl(FM.steel, 0.035, 0.42, [x, 0.98, 0.7], [-1.1, 0, 0], 10, nc);
    k.cyl(KM.chrome, 0.018, 0.3, [x, 1.04, 0.84], [-1.1, 0, 0], 8, nc);
  }
  // hood seam, step, rear combination lights, warning stripe on the counterweight
  k.box(KM.seam, [0.9, 0.004, 0.004], [0, 0.828, 0.35], [0, 0, 0], nc);
  for (const s of [-1, 1]) {
    k.box(KM.rubber, [0.06, 0.04, 0.4], [s * 0.52, 0.38, 0.15], [0, 0, 0], nc);
    k.box(KM.paintRed, [0.12, 0.08, 0.02], [s * 0.38, 0.72, -0.931], [0, 0, 0], nc);
  }
  for (let i = 0; i < 5; i++) k.box(i % 2 ? KM.paintGraphite : KM.paintYellow, [0.2, 0.08, 0.004], [-0.4 + i * 0.2, 0.45, -0.932], [0, 0, 0], nc);
  // wheels, lights, beacon
  for (const [x, z, r] of [[-0.48, 0.55, 0.26], [0.48, 0.55, 0.26], [-0.46, -0.55, 0.2], [0.46, -0.55, 0.2]] as const) {
    k.cyl(KM.rubber, r, 0.2, [x, r, z], [0, 0, Math.PI / 2], 18);
    k.cyl(FM.steel, r * 0.55, 0.205, [x, r, z], [0, 0, Math.PI / 2], 12, nc);
  }
  for (const x of [-0.4, 0.4]) k.cyl(KM.ledWhite, 0.05, 0.04, [x, 2.0, 0.5], [Math.PI / 2, 0, 0], 12, nc);
  k.cyl(KM.ledAmber, 0.05, 0.08, [0.35, 2.26, -0.55], [0, 0, 0], 12, nc);
  k.label('model', 'FL-16E', '1.6 t · LI-ION', 0.3, 0.075, [0.505, 0.6, -0.1], [0, Math.PI / 2, 0]);
  k.ao(1.3, 2.4, [0, 0, 0.3], 1.1);
}

/** Rack pallets and their loads (static, instanced: pallet, cartons ×2 shades, tape, label). */
function RackLoads() {
  const slots = useMemo(() => {
    const out: [number, number, number][] = [];
    for (const z of [-6, -10]) for (let i = 0; i < 9; i++) for (let l = 0; l < 4; l++) if ((i * 7 + l * 3 + z) % 5 !== 0) out.push([-1 + i * 1.5, 0.15 + l * 2.05, z]);
    return out;
  }, []);
  const meshes = useMemo(() => {
    const defs: [THREE.BufferGeometry, THREE.Material][] = [
      [kitGeometry((k) => pallet(k)), palletMat],
      [kitGeometry((k) => cartonStack(k, cardboard, 0.15, 0)), cardboard],
      [kitGeometry((k) => cartonStack(k, cardboardDark, 0.15, 1)), cardboardDark],
      [kitGeometry((k) => stackTape(k, 0.15)), packTape],
      [kitGeometry((k) => k.box(labelMat, [0.2, 0.14, 0.004], [0.25, 0.5, 0.477])), labelMat],
    ];
    const o = new THREE.Object3D();
    return defs.map(([g, m], j) => {
      const mesh = new THREE.InstancedMesh(g, m, slots.length);
      slots.forEach(([x, y, z], i) => {
        o.position.set(x, y + 0.002, z);
        o.updateMatrix();
        mesh.setMatrixAt(i, o.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = j === 1 || j === 2;
      mesh.receiveShadow = true;
      return mesh;
    });
  }, [slots]);
  useEffect(() => () => meshes.forEach((m) => m.geometry.dispose()), [meshes]);
  return (
    <>
      {meshes.map((m, i) => (
        <primitive key={i} object={m} />
      ))}
    </>
  );
}

/** AMR body (local +z = driving direction): rounded chassis, bumper, lift plate, lidar, LEDs, scanners. */
function buildAMR(k: Kit, mat: THREE.Material) {
  const nc = { cast: false };
  k.rbox(mat, [0.9, 0.24, 1.2], 0.05, [0, 0.16, 0]);
  k.box(KM.rubber, [0.92, 0.05, 1.22], [0, 0.065, 0], [0, 0, 0], nc);
  k.rbox(KM.paintGraphite, [0.86, 0.035, 1.16], 0.012, [0, 0.3, 0]);
  for (let i = 0; i < 5; i++) k.box(KM.rubber, [0.8, 0.004, 0.06], [0, 0.32, -0.45 + i * 0.22], [0, 0, 0], nc);
  k.cyl(KM.paintGraphite, 0.06, 0.06, [0, 0.35, 0.5], [0, 0, 0], 16);
  k.cyl(KM.glassSmoke, 0.055, 0.025, [0, 0.39, 0.5], [0, 0, 0], 16, nc);
  k.cyl(KM.paintGraphite, 0.062, 0.012, [0, 0.41, 0.5], [0, 0, 0], 16, nc);
  for (const s of [-1, 1]) {
    k.box(KM.ledGreen, [0.6, 0.012, 0.004], [0, 0.2, s * 0.602], [0, 0, 0], nc);
    k.box(KM.ledGreen, [0.004, 0.012, 0.9], [s * 0.452, 0.2, 0], [0, 0, 0], nc);
    k.rbox(KM.paintYellow, [0.1, 0.06, 0.04], 0.01, [s * 0.36, 0.13, 0.6]);
    k.cyl(KM.rubber, 0.075, 0.05, [s * 0.43, 0.075, 0], [0, 0, Math.PI / 2], 16, nc);
  }
  k.box(KM.paintGraphite, [0.3, 0.06, 0.004], [0, 0.2, -0.603], [0, 0, 0], nc);
  k.cyl(KM.paintRed, 0.02, 0.015, [0.3, 0.2, -0.607], [Math.PI / 2, 0, 0], 12, nc);
  k.ao(1.0, 1.3, [0, 0, 0], 1.15);
}

/** Palletised load carried by an AMR (pallet + cartons + stretch wrap + label). */
function buildLoad(k: Kit) {
  pallet(k);
  cartonStack(k, cardboard, 0.15, 0);
  cartonStack(k, cardboardDark, 0.15, 1);
  stackTape(k, 0.15);
  k.box(wrapMat, [1.1, 0.95, 1.0], [0, 0.6, 0], [0, 0, 0], { cast: false });
  k.box(labelMat, [0.2, 0.14, 0.004], [0.25, 0.5, 0.503], [0, 0, 0], { cast: false });
}

function AMR({ path, color = '#d8a62a' }: { path: () => { p: THREE.Vector3; load: boolean; lift: number }; color?: string }) {
  const g = useRef<THREE.Group>(null);
  const loadRef = useRef<THREE.Group>(null);
  const last = useRef(new THREE.Vector3());
  const d = useMemo(() => new THREE.Vector3(), []);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color, roughness: 0.5 }), [color]);
  const body = useKit((k) => buildAMR(k, mat), [mat]);
  const load = useKit(buildLoad);
  useFrame(() => {
    const { p, load, lift } = path();
    if (!g.current) return;
    d.copy(p).sub(last.current);
    if (d.lengthSq() > 1e-6) g.current.rotation.y = Math.atan2(d.x, d.z);
    last.current.copy(p);
    g.current.position.set(p.x, 0, p.z);
    if (loadRef.current) {
      loadRef.current.visible = load;
      loadRef.current.position.y = 0.32 + lift;
    }
  });
  return (
    <group ref={g}>
      <Clickable sel={{ kind: 'component', id: 'amr', label: 'Autonomous mobile robot' }}>
        <Baked parts={body} />
      </Clickable>
      <group ref={loadRef}>
        <Baked parts={load} />
      </group>
    </group>
  );
}

/** Box-van tractor-trailer (local +x = rear, toward the dock). */
function buildTruck(k: Kit) {
  const nc = { cast: false };
  // trailer box: ribbed sides, rails, rear doors
  k.rbox(KM.paint, [7, 2.8, 2.5], 0.04, [0, 1.9, 0]);
  for (let x = -3.3; x <= 3.3; x += 0.6) for (const s of [-1, 1]) k.box(KM.paint, [0.05, 2.7, 0.03], [x, 1.9, s * 1.258], [0, 0, 0], nc);
  for (const y of [0.53, 3.27]) for (const s of [-1, 1]) k.box(FM.alu, [7.02, 0.08, 0.04], [0, y, s * 1.26], [0, 0, 0], nc);
  k.box(FM.alu, [0.06, 2.8, 2.52], [3.5, 1.9, 0]);
  k.box(KM.seam, [0.004, 2.6, 0.01], [3.532, 1.9, 0], [0, 0, 0], nc);
  for (const z of [-0.6, 0.6]) {
    k.cyl(KM.chrome, 0.015, 2.5, [3.55, 1.9, z], [0, 0, 0], 8, nc);
    k.box(FM.steelDark, [0.04, 0.08, 0.15], [3.56, 1.3, z + 0.08], [0, 0, 0], nc);
  }
  for (const y of [0.8, 1.9, 3.0]) for (const s of [-1, 1]) k.box(FM.steelDark, [0.04, 0.12, 0.08], [3.55, y, s * 1.18], [0, 0, 0], nc);
  for (const s of [-1, 1]) {
    k.box(KM.paintRed, [0.03, 0.12, 0.25], [3.535, 0.75, s * 1.0], [0, 0, 0], nc);
    k.box(KM.ledAmber, [0.03, 0.05, 0.05], [-3.0, 3.25, s * 1.262], [0, 0, 0], nc);
  }
  k.label('info', 'FAB/TWIN LOGISTICS', 'ESD-SAFE · CLIMATE CONTROLLED', 2.4, 0.6, [0, 2.2, 1.276]);
  k.label('info', 'FAB/TWIN LOGISTICS', 'ESD-SAFE · CLIMATE CONTROLLED', 2.4, 0.6, [0, 2.2, -1.276], [0, Math.PI, 0]);
  // chassis, rear bumper, side guards, landing gear
  for (const s of [-1, 1]) k.box(KM.paintGraphite, [10, 0.2, 0.12], [-1.2, 0.62, s * 0.45]);
  k.box(KM.paintGraphite, [0.1, 0.12, 2.3], [3.45, 0.42, 0]);
  for (const s of [-1, 1]) {
    k.box(FM.alu, [3.2, 0.06, 0.04], [-0.2, 0.38, s * 1.22], [0, 0, 0], nc);
    k.box(FM.steelDark, [0.08, 0.5, 0.08], [-2.4, 0.3, s * 0.6]);
  }
  // cab
  k.rbox(KM.paintAccent, [2.0, 2.2, 2.4], 0.12, [-4.6, 1.6, 0]);
  k.rbox(KM.paintAccent, [1.2, 0.5, 2.3], 0.15, [-4.25, 2.95, 0]);
  k.box(KM.glassSmoke, [0.02, 0.8, 2.1], [-5.605, 2.1, 0], [0, 0, 0.08], nc);
  for (const s of [-1, 1]) k.box(KM.glassSmoke, [0.8, 0.6, 0.02], [-4.9, 2.15, s * 1.205], [0, 0, 0], nc);
  k.box(KM.paintGraphite, [0.05, 0.7, 1.6], [-5.61, 1.1, 0], [0, 0, 0], nc);
  for (let i = 0; i < 6; i++) k.box(FM.alu, [0.06, 0.02, 1.5], [-5.64, 0.85 + i * 0.1, 0], [0, 0, 0], nc);
  k.rbox(KM.paintGraphite, [0.25, 0.3, 2.45], 0.04, [-5.6, 0.55, 0]);
  for (const s of [-1, 1]) {
    k.box(KM.ledWhite, [0.03, 0.12, 0.3], [-5.63, 0.95, s * 0.95], [0, 0, 0], nc);
    k.box(KM.paintGraphite, [0.06, 0.4, 0.04], [-5.45, 2.2, s * 1.38]);
    k.box(KM.paintGraphite, [0.3, 0.05, 0.05], [-5.4, 2.35, s * 1.3], [0, 0, 0], nc);
    k.cyl(KM.chrome, 0.25, 0.9, [-3.7, 0.65, s * 0.95], [Math.PI / 2, 0, 0], 16);
    k.box(FM.alu, [0.4, 0.05, 0.25], [-4.5, 0.42, s * 1.12], [0, 0, 0], nc);
  }
  k.cyl(KM.chrome, 0.07, 1.6, [-3.55, 3.0, 0.95], [0, 0, 0], 12);
  // wheels (dual at the rear axles)
  for (const x of [-3.8, -1.5, 2.2])
    for (const s of [-1, 1]) {
      const zs = x > -3 ? [s * 1.05, s * 0.78] : [s * 1.08];
      for (const z of zs) {
        k.cyl(KM.rubber, 0.45, 0.26, [x, 0.45, z], [Math.PI / 2, 0, 0], 24);
        k.cyl(FM.steel, 0.26, 0.27, [x, 0.45, z], [Math.PI / 2, 0, 0], 14, nc);
      }
      k.cyl(FM.steelDark, 0.09, 0.3, [x, 0.45, s * 1.1], [Math.PI / 2, 0, 0], 10, nc);
    }
  for (const x of [-1.5, 2.2]) for (const s of [-1, 1]) k.box(KM.rubber, [0.02, 0.5, 0.35], [x + 0.55, 0.45, s * 1.0], [0, 0, 0], nc);
}

function Truck() {
  const g = useRef<THREE.Group>(null);
  const load = useRef<THREE.Group>(null);
  const truck = useKit(buildTruck);
  const cargo = useKit((k) => k.at([2.6, 0.75, 0], 0, () => buildLoad(k)));
  useFrame(() => {
    const leave = inPhase('dispatch') ? smooth(clamp((engine.player.view.phaseT - 0.55) / 0.45)) : pp('dispatch') >= 1 ? 1 : 0;
    if (g.current) g.current.position.x = DOCK.x - 4 - leave * 16;
    if (load.current) load.current.visible = inPhase('dispatch') && engine.player.view.phaseT > 0.45;
  });
  return (
    <group ref={g} position={[DOCK.x - 4, 0, DOCK.z]}>
      <Clickable sel={{ kind: 'component', id: 'truck', label: 'Truck (dispatch)' }}>
        <Baked parts={truck} />
      </Clickable>
      <group ref={load}>
        <Baked parts={cargo} />
      </group>
    </group>
  );
}

/* AMR routes (scratch vectors: no allocation per frame) */
const V_AISLE = new THREE.Vector3(SLOT.x, 0, -4.2);
const V_SLOT = new THREE.Vector3(SLOT.x, 0, SLOT.z);
const V_START2 = new THREE.Vector3(1, 0, 4);
const V_PICK = new THREE.Vector3(PICK_SLOT.x, 0, PICK_SLOT.z);
const V_DOCK = new THREE.Vector3(DOCK.x + 1.5, 0, DOCK.z);
const r1 = { p: new THREE.Vector3(), load: false, lift: 0 };
const r2 = { p: new THREE.Vector3(), load: false, lift: 0 };
/** AMR 1: carries the new pallet into storage. */
function amr1() {
  const st = inPhase('store') ? smooth(engine.player.view.phaseT) : pp('store');
  const p = r1.p.copy(PACK_AREA).lerp(V_AISLE, clamp(st * 1.3));
  if (st > 0.77) p.lerp(V_SLOT, smooth((st - 0.77) / 0.23));
  track('focus', p.x, 1, p.z);
  r1.load = st < 0.98 && pp('pallet') > 0.95;
  r1.lift = st > 0.77 ? lerp(0, SLOT.y - 0.15, smooth((st - 0.77) / 0.23)) : 0;
  return r1;
}
/** AMR 2: order picking → dock. */
function amr2() {
  const pk = inPhase('pick') ? smooth(engine.player.view.phaseT) : pp('pick');
  const dp = inPhase('dispatch') ? smooth(clamp(engine.player.view.phaseT / 0.5)) : pp('dispatch');
  const p = r2.p.copy(V_START2).lerp(V_PICK, pk);
  if (dp > 0) p.lerp(V_DOCK, dp);
  if (inPhase('pick') || inPhase('dispatch')) track('focus', p.x, 1, p.z);
  r2.load = pk > 0.6 && dp < 0.98;
  r2.lift = 0;
  return r2;
}

function Warehouse() {
  const floor = useMemo(() => new THREE.MeshStandardMaterial({ map: plainTile([20, 14], '#8d918a'), roughness: 0.6 }), []);
  const cartons = useRef<THREE.Group>(null);
  const st = useStation({ racks: buildRacks, _building: buildWarehouse, _pack: buildPackArea, _forklift: (k) => k.at([-4.6, 0, 7.2], 2.4, () => buildForklift(k)) }, []);
  const packPallet = useKit((k) => k.at([PACK_AREA.x, 0, PACK_AREA.z], 0, () => pallet(k)));
  useFrame(() => {
    const k = inPhase('pallet') ? engine.player.view.phaseT : pp('pallet');
    if (cartons.current) cartons.current.children.forEach((c, i) => (c.visible = i / 12 < k * 1.1 && pp('store') < 0.05));
  });
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} receiveShadow material={floor}>
        <planeGeometry args={[40, 28]} />
      </mesh>
      <StationView m={st} />
      <Clickable sel={{ kind: 'component', id: 'racks', label: 'High-bay racking' }}>
        <Pick m={st} tag="racks" />
        <RackLoads />
      </Clickable>
      {/* packing area: cartons being stacked on a pallet, then stretch wrapped */}
      <Baked parts={packPallet} />
      <group position={[PACK_AREA.x, 0, PACK_AREA.z]}>
        <group ref={cartons}>
          {Array.from({ length: 12 }, (_, i) => (
            <mesh key={i} geometry={GEO.box} material={i % 2 ? cardboard : cardboardDark} scale={[0.5, 0.3, 0.45]} position={[-0.27 + (i % 2) * 0.54, 0.29 + Math.floor(i / 4) * 0.31, -0.24 + (Math.floor(i / 2) % 2) * 0.48]} castShadow />
          ))}
        </group>
      </group>
      <AMR path={amr1} />
      <AMR path={amr2} color="#7fbf6a" />
      <Truck />
      <Operator position={[1.6, 0, 4.2]} rotation={-Math.PI * 0.7} still />
      <TechLabel
        position={[-3, 4.2, 3]}
        title="DISTRIBUTION CENTRE"
        lines={['controlled storage · AMRs · order picking · dispatch']}
        min={1}
        value={() => `${engine.player.view.phase.label} · inventory ≈ ${engine.tele.value('inv', 0).toFixed(0)}k units · AMRs ${engine.tele.value('amr', 0).toFixed(0)} · SIMULATED`}
      />
    </group>
  );
}

export default function ShippingScene({ stage }: SceneProps) {
  const pack = stage.variant !== 'warehouse';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0;
  }, []);
  return (
    <>
      <Lighting env="warehouse" shadowExtent={pack ? 5 : 18} />
      {pack ? (
        <>
          <mesh rotation-x={-Math.PI / 2} receiveShadow>
            <planeGeometry args={[16, 12]} />
            <meshStandardMaterial color="#8d918a" roughness={0.6} />
          </mesh>
          <PackLine />
          <Operator position={[-2.6, 0, 0.9]} rotation={Math.PI * 0.8} still />
        </>
      ) : (
        <Warehouse />
      )}
    </>
  );
}

export type { V3 };
