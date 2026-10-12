'use client';
/**
 * Etch (§28) and resist strip (§29).
 *   DRY: RF plasma; ions accelerate vertically across the sheath → anisotropic, straight walls.
 *   WET: liquid etchant attacks in every direction → isotropic, undercuts the mask.
 *   STRIP: downstream O₂ plasma radicals turn the resist into CO₂ + H₂O.
 * The cross-section is driven by the same etch model as the telemetry (depth / undercut).
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, CleanroomBay } from '../environments';
import { M, effectiveView } from '../materials';
import { GEO } from '../parts/primitives';
import { Clickable, SensorIndicator, TechLabel } from '../parts/interaction';
import { Inset, LiveProfile, ProfileSlab, rect } from '../parts/section';
import { ClusterTool, Pedestal, Showerhead, CHAMBER, useFolded, buildClusterNeighbour, rfCable } from '../parts/cluster';
import { Kit, boltCircle, grille, ledStrip, viewport, foot, type V3, type PartOpts } from '../kit/build';
import { KM, labelMaterial } from '../kit/finish';
import { Baked } from '../kit/Baked';
import { etchedFilm } from '../parts/profiles';
import { Screen, clear, plot, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { engine } from '@/simulation/engine';
import { inPhase, pdt } from '@/lib/anim';
import { cutPlane } from '@/lib/runtime';
import { useParam } from '@/hooks/useTicker';
import { useUI } from '@/lib/store';
import { rng } from '@/lib/math';
import { etchProfile, ETCH_TARGET_NM } from '@/simulation/models';

/* ---------------------------------------------------------------- materials */

const subMat = new THREE.MeshStandardMaterial({ color: '#7a828c', roughness: 0.45, metalness: 0.6 });
const filmMat = new THREE.MeshStandardMaterial({ color: '#a9c2a0', roughness: 0.35, metalness: 0.05 });
const resistMat = new THREE.MeshStandardMaterial({ color: '#b5612a', roughness: 0.4, metalness: 0, transparent: true, opacity: 0.92 });
const ionMat = new THREE.MeshBasicMaterial({ color: '#d6b8ff', toneMapped: false });
const radMat = new THREE.MeshStandardMaterial({ color: '#d98a6a', roughness: 0.5, emissive: new THREE.Color('#5a2a18'), emissiveIntensity: 0.4 });
const gasOutMat = new THREE.MeshStandardMaterial({ color: '#9aa39a', roughness: 0.6, transparent: true, opacity: 0.6 });
const liquidMat = new THREE.MeshStandardMaterial({ color: '#b9d4b0', roughness: 0.05, metalness: 0, transparent: true, opacity: 0.22, depthWrite: false });
const plasmaEtch = new THREE.MeshBasicMaterial({ color: '#b48cff', transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
const plasmaAsh = new THREE.MeshBasicMaterial({ color: '#ffb6d0', transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);

/* ---------------------------------------------------------------- static detail (kit) */

const Z0: V3 = [0, 0, 0];
const RX: V3 = [0, 0, Math.PI / 2]; // cylinder axis → X
const RZ: V3 = [Math.PI / 2, 0, 0]; // cylinder axis → Z
/** top face of the chamber lid (chamber-local) */
const LID = 1.385;
/** yaw that turns local +Z towards the plan direction (cos a, sin a) */
const yawTo = (a: number) => Math.PI / 2 - a;
const polar = (r: number, a: number, y: number): V3 => [Math.cos(a) * r, y, Math.sin(a) * r];
/** bead-blasted aluminium (RF shield, source housings) — same look as the cluster chambers */
const ALU = new THREE.MeshStandardMaterial({ color: '#c3c8cb', roughness: 0.78, metalness: 0.5, roughnessMap: KM.paint.roughnessMap });

/** Flat ring (washer / clamp ring) of rectangular section, from y to y + h. */
function ring(k: Kit, m: THREE.Material, r0: number, r1: number, h: number, y: number, seg = 48, o: PartOpts = {}) {
  // corner points doubled so the lathe keeps hard edges
  k.lathe(m, [[r0, 0], [r1, 0], [r1, 0], [r1, h], [r1, h], [r0, h], [r0, h], [r0, 0]], [0, y, 0], Z0, seg, o);
}

/** Label plate that follows the shell (cut-away / x-ray) when asked. */
function plate(k: Kit, kind: Parameters<typeof labelMaterial>[0], text: string, sub: string, w: number, h: number, pos: V3, rot: V3 = Z0, o: PartOpts = {}, accent?: string) {
  const g = new THREE.PlaneGeometry(w, h);
  k.add(labelMaterial(kind, text, sub, accent), g, pos, rot, [1, 1, 1], { cast: false, keepUV: true, ...o });
  g.dispose();
}

/** Surface-mount pneumatic valve with a coloured cap. */
function valve(k: Kit, pos: V3, cap: THREE.Material = KM.paintBlue) {
  const [x, y, z] = pos;
  k.rbox(KM.stainless, [0.036, 0.026, 0.036], 0.004, [x, y, z]);
  k.cyl(KM.stainless, 0.012, 0.024, [x, y + 0.025, z], Z0, 14);
  k.cyl(cap, 0.0145, 0.026, [x, y + 0.05, z], Z0, 16);
}

/**
 * Inductively coupled plasma source on the lid (chamber-local): alumina window in a clamp
 * ring, flat copper spiral coil on PTFE combs, grounded RF shield can (cut-away with the
 * chamber), match network on top with its coax, and the bias match under the chamber.
 */
function buildIcpSource(k: Kit) {
  const sh = { shell: true };
  // dielectric window and its bolted clamp ring
  k.cyl(M.ceramic, 0.27, 0.022, [0, LID + 0.011, 0], Z0, 64);
  ring(k, ALU, 0.255, 0.305, 0.016, LID, 64);
  boltCircle(k, 0.293, 16, LID + 0.018, 0.0055);
  // PTFE coil combs and the 2½-turn planar coil
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    k.box(KM.ptfe, [0.19, 0.014, 0.018], polar(0.15, a, LID + 0.03), [0, -a, 0]);
  }
  const coil: V3[] = [];
  for (let i = 0; i <= 44; i++) {
    const t = i / 44;
    const a = t * 2.5 * Math.PI * 2;
    const r = 0.07 + 0.16 * t;
    coil.push([Math.cos(a) * r, LID + 0.043, Math.sin(a) * r]);
  }
  k.tube(KM.copper, coil, 0.0085, { radial: 8 });
  // coil terminals: copper straps up to the match
  for (const x of [0.07, -0.23]) {
    k.box(KM.copper, [0.022, 0.16, 0.004], [x, LID + 0.125, 0]);
    k.cyl(KM.brass, 0.008, 0.012, [x, LID + 0.05, 0], Z0, 10, { cast: false });
  }
  // grounded RF shield can (follows the chamber cut-away) with a vented band
  k.cyl(ALU, 0.3, 0.17, [0, LID + 0.101, 0], Z0, 64, { ...sh, open: true });
  ring(k, ALU, 0.3, 0.318, 0.014, LID + 0.016, 64, sh);
  k.cyl(ALU, 0.308, 0.014, [0, LID + 0.192, 0], Z0, 64, sh);
  k.torus(KM.seam, 0.301, 0.0015, [0, LID + 0.17, 0], Z0, 64, { ...sh, cast: false });
  boltCircle(k, 0.31, 12, LID + 0.031, 0.005, KM.stainlessDark, sh);
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    k.box(KM.seam, [0.012, 0.05, 0.002], polar(0.3005, a, LID + 0.1), [0, -a + Math.PI / 2, 0], { ...sh, cast: false });
  }
  // match network on the can
  const my = LID + 0.199;
  k.rbox(KM.paint, [0.34, 0.18, 0.28], 0.016, [0, my + 0.09, -0.02]);
  k.rbox(KM.paintGraphite, [0.35, 0.016, 0.29], 0.006, [0, my + 0.188, -0.02]);
  k.box(KM.seam, [0.342, 0.004, 0.282], [0, my + 0.03, -0.02], Z0, { cast: false });
  grille(k, 0.13, 0.07, [-0.08, my + 0.1, 0.121], { m: KM.paint });
  plate(k, 'warn', 'HIGH VOLTAGE', '', 0.055, 0.055, [0.1, my + 0.12, 0.1205]);
  plate(k, 'tag', 'RF MATCH', '13.56 MHz · 2.5 kW', 0.13, 0.032, [0.06, my + 0.06, 0.1205]);
  ledStrip(k, 0.07, [0.1, my + 0.165, 0.121], KM.ledGreen);
  for (const x of [-0.155, 0.155]) for (const y of [my + 0.045, my + 0.165]) k.cyl(KM.stainlessDark, 0.005, 0.004, [x, y, 0.121], RZ, 8, { cast: false });
  // RF input (N-type) and coax round the lid edge, down into the raised floor
  k.cyl(KM.stainless, 0.024, 0.045, [0.19, my + 0.1, -0.06], RX, 16);
  k.cyl(KM.stainlessDark, 0.028, 0.016, [0.215, my + 0.1, -0.06], RX, 6);
  const cy = my + 0.1;
  k.tube(KM.rubber, [[0.222, cy, -0.06], [0.3, cy - 0.015, -0.1], [0.44, cy - 0.12, -0.2], [0.56, 1.3, -0.27], [0.6, 0.9, -0.29], [0.61, 0.35, -0.3], [0.61, -0.02, -0.3]], 0.017, { radial: 10, tension: 0.4 });
  k.box(KM.paintGraphite, [0.09, 0.004, 0.09], [0.61, 0.002, -0.3], Z0, { cast: false });
  // bias match under the chamber with its feed into the cathode stem
  k.rbox(KM.paint, [0.16, 0.18, 0.15], 0.012, [-0.22, 0.47, 0.2]);
  k.rbox(KM.paintGraphite, [0.166, 0.012, 0.156], 0.004, [-0.22, 0.566, 0.2]);
  plate(k, 'tag', 'BIAS', '2 MHz', 0.07, 0.024, [-0.22, 0.5, 0.2755]);
  k.tube(KM.rubber, [[-0.14, 0.5, 0.17], [-0.06, 0.52, 0.09], [0.0, 0.54, 0.05]], 0.012, { radial: 8, tension: 0.4 });
}

/** Optical-emission viewport with a fibre collimator and the spectrometer on a frame bracket. */
function buildOes(k: Kit) {
  const a = Math.atan2(0.12, 0.5);
  const r0 = CHAMBER.r + 0.008;
  k.at(polar(r0, a, 1.15), yawTo(a), () => {
    viewport(k, 0.03, 0.045);
    k.cyl(KM.anodized, 0.017, 0.012, [0, 0, 0.064], RZ, 16);
    k.cyl(KM.anodizedDark, 0.012, 0.05, [0, 0, 0.094], RZ, 16);
    k.cyl(KM.paintYellow, 0.006, 0.02, [0, 0, 0.128], RZ, 10, { cast: false });
  });
  const tip = polar(r0 + 0.138, a, 1.15);
  k.tube(KM.paintYellow, [tip, [tip[0] + 0.04, 1.08, tip[2] + 0.04], [0.6, 0.86, 0.24], [0.52, 0.72, 0.3]], 0.0045, { radial: 8, tension: 0.4 });
  // spectrometer on a bracket off the chamber-frame leg
  k.box(KM.paintGraphite, [0.18, 0.008, 0.2], [0.47, 0.6, 0.29]);
  k.box(KM.paintGraphite, [0.008, 0.08, 0.2], [0.389, 0.565, 0.29]);
  k.rbox(KM.paint, [0.15, 0.09, 0.19], 0.01, [0.5, 0.65, 0.29]);
  k.rbox(KM.paintGraphite, [0.154, 0.01, 0.194], 0.004, [0.5, 0.697, 0.29]);
  k.cyl(KM.anodizedDark, 0.01, 0.02, [0.52, 0.71, 0.3], Z0, 10);
  plate(k, 'tag', 'OES', '200–800 nm', 0.08, 0.024, [0.5, 0.65, 0.3855]);
  ledStrip(k, 0.04, [0.5, 0.625, 0.3855], KM.ledGreen);
}

/** Wet-etch dispense arm (local to its pivot; rotates about Y). */
function buildNozzleArm(k: Kit) {
  k.cyl(KM.stainless, 0.022, 0.04, [0, 0, 0], Z0, 24);
  k.cyl(KM.anodizedDark, 0.023, 0.006, [0, 0.02, 0], Z0, 24, { cast: false });
  k.rbox(KM.stainless, [0.3, 0.02, 0.024], 0.006, [-0.15, 0, 0]);
  k.cyl(KM.ptfe, 0.0045, 0.28, [-0.15, 0.0145, 0], RX, 10, { cast: false });
  k.cyl(KM.ptfe, 0.009, 0.05, [-0.3, -0.03, 0], Z0, 16);
  k.cyl(KM.ptfe, 0.004, 0.012, [-0.3, -0.061, 0], Z0, 10, { cast: false });
  k.rbox(KM.stainless, [0.03, 0.026, 0.03], 0.005, [-0.3, 0.005, 0]);
}

/** Wet mode: arm pivot shaft through the lid, rotary actuator and chemical supply line. */
function buildWetDrive(k: Kit) {
  k.cyl(KM.stainless, 0.011, LID - 1.2, [0.3, (LID + 1.2) / 2, 0], Z0, 16);
  k.cyl(KM.stainless, 0.05, 0.02, [0.3, LID + 0.01, 0], Z0, 28);
  k.at([0.3, 0, 0], 0, () => boltCircle(k, 0.04, 6, LID + 0.021, 0.004));
  k.cyl(KM.anodized, 0.04, 0.08, [0.3, LID + 0.06, 0], Z0, 28);
  k.cyl(KM.paintGraphite, 0.03, 0.07, [0.3, LID + 0.135, 0], Z0, 24);
  k.cyl(KM.anodizedDark, 0.032, 0.012, [0.3, LID + 0.176, 0], Z0, 24);
  plate(k, 'tag', 'ROTARY', 'DISPENSE ARM', 0.07, 0.022, [0.3, LID + 0.06, 0.041]);
  k.cyl(KM.ptfe, 0.008, 0.03, [0.33, LID + 0.03, -0.03], Z0, 10);
  rfCable(k, [0.33, LID + 0.05, -0.03], 0.007, KM.ptfe, -0.6);
}

/**
 * Downstream (remote) plasma source for the asher (chamber-local): lid adapter, flanged
 * quartz tube (live mesh) in a helical copper coil and a grounded cage, RF supply on
 * standoffs, O₂ / N₂ inlet on the top cap.
 */
function buildRps(k: Kit) {
  // adapter on the lid and the lower tube flange/clamp
  k.cyl(KM.stainless, 0.125, 0.026, [0, LID + 0.013, 0], Z0, 48);
  boltCircle(k, 0.11, 8, LID + 0.027, 0.0055);
  k.cyl(KM.stainless, 0.1, 0.02, [0, 1.42, 0], Z0, 40);
  k.cyl(KM.stainless, 0.079, 0.036, [0, 1.448, 0], Z0, 36, { open: true });
  k.torus(KM.seam, 0.1, 0.0014, [0, 1.43, 0], Z0, 40, { cast: false });
  // upper clamp, cap and gas inlet
  k.cyl(KM.stainless, 0.079, 0.036, [0, 1.792, 0], Z0, 36, { open: true });
  k.cyl(KM.stainless, 0.1, 0.022, [0, 1.821, 0], Z0, 40);
  k.cyl(KM.stainless, 0.07, 0.016, [0, 1.84, 0], Z0, 36);
  boltCircle(k, 0.088, 8, 1.834, 0.005);
  k.cyl(KM.stainless, 0.016, 0.04, [0, 1.868, 0], Z0, 16);
  k.rbox(KM.stainless, [0.07, 0.03, 0.04], 0.005, [0, 1.9, 0]);
  // helical work coil (3 turns) and its leads into the RF supply
  const helix: V3[] = [];
  for (let i = 0; i <= 42; i++) {
    const t = i / 42;
    const a = t * 3 * Math.PI * 2;
    helix.push([Math.cos(a) * 0.094, 1.54 + t * 0.16, Math.sin(a) * 0.094]);
  }
  k.tube(KM.copper, helix, 0.0075, { radial: 8 });
  for (const y of [1.54, 1.7]) k.box(KM.copper, [0.08, 0.012, 0.012], [0.134, y, 0]);
  // grounded cage around the coil
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    k.cyl(KM.stainless, 0.006, 0.36, polar(0.132, a, 1.62), Z0, 8);
  }
  for (const y of [1.45, 1.79]) k.torus(KM.stainless, 0.132, 0.006, [0, y, 0], Z0, 40);
  // RF supply on standoffs from the lid
  for (const [x, z] of [[0.22, -0.07], [0.38, -0.07], [0.22, 0.07], [0.38, 0.07]]) k.cyl(KM.stainless, 0.01, 1.52 - LID, [x, (LID + 1.52) / 2, z], Z0, 10);
  k.rbox(KM.paint, [0.26, 0.2, 0.22], 0.014, [0.3, 1.62, 0]);
  k.rbox(KM.paintGraphite, [0.268, 0.014, 0.228], 0.005, [0.3, 1.727, 0]);
  k.box(KM.seam, [0.262, 0.003, 0.222], [0.3, 1.55, 0], Z0, { cast: false });
  grille(k, 0.1, 0.06, [0.25, 1.63, 0.1105], { m: KM.paint });
  plate(k, 'model', 'RPS-2', 'O₂ DOWNSTREAM · 13.56 MHz', 0.12, 0.03, [0.33, 1.685, 0.1105]);
  plate(k, 'warn', 'HIGH VOLTAGE', '', 0.05, 0.05, [0.39, 1.615, 0.1105]);
  ledStrip(k, 0.06, [0.36, 1.57, 0.111], KM.ledGreen);
  for (const x of [0.18, 0.42]) for (const y of [1.535, 1.705]) k.cyl(KM.stainlessDark, 0.005, 0.004, [x, y, 0.1105], RZ, 8, { cast: false });
  k.cyl(KM.stainless, 0.022, 0.04, [0.45, 1.62, -0.04], RX, 16);
  rfCable(k, [0.47, 1.62, -0.04], 0.016);
  // O₂ / N₂ supply: up from the inlet block, back over the hinge, down the rear
  ([['O₂', '#3e7d4c', -0.035], ['N₂', '#2f5d8a', 0.035]] as const).forEach(([gas, col, x]) => {
    k.pipe(KM.stainless, [[x, 1.915, 0], [x, 1.98, 0], [x, 1.98, -0.64], [x, 0.02, -0.64]], 0.0065, 0.04);
    valve(k, [x, 1.95, -0.3], KM.paintBlue);
    k.at([x, 1.15, -0.64], Math.PI, () => plate(k, 'gas', gas, '', 0.07, 0.016, [0, 0, 0.009], Z0, {}, col));
    k.box(KM.paintGraphite, [0.05, 0.004, 0.05], [x, 0.002, -0.64], Z0, { cast: false });
  });
}

/** Endpoint-monitor stand (local to the monitor group): weighted base, column, VESA arm, keyboard tray. */
function buildMonitorStand(k: Kit) {
  k.rbox(KM.paintGraphite, [0.46, 0.035, 0.38], 0.012, [0, 0.0175, 0]);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) foot(k, [x * 0.19, 0, z * 0.15]);
  k.rbox(KM.anodized, [0.075, 1.32, 0.055], 0.012, [0, 0.69, -0.03]);
  k.box(KM.seam, [0.006, 1.2, 0.002], [0, 0.69, -0.002], Z0, { cast: false });
  k.rbox(KM.anodizedDark, [0.1, 0.12, 0.04], 0.01, [0, 1.45, -0.05]);
  k.rbox(KM.plastic, [0.7, 0.48, 0.03], 0.012, [0, 1.45, -0.012]);
  k.rbox(KM.plastic, [0.42, 0.02, 0.2], 0.006, [0, 1.06, 0.07]);
  k.box(KM.plasticWhite, [0.36, 0.008, 0.13], [0, 1.074, 0.08], Z0, { cast: false });
  k.label('tag', 'EPD-1', 'ENDPOINT CONTROLLER', 0.12, 0.026, [0, 0.0175, 0.1905]);
  k.ao(0.46, 0.38);
}

/* ---------------------------------------------------------------- inset geometry */

/** Inset units: film thickness 0.24 = 120 nm → 5e-7 m per unit. */
const H = 0.24;
const NM = H / ETCH_TARGET_NM;
const MPU = 120e-9 / H;
const O0 = -0.12;
const O1 = 0.12;
const RESIST_H = 0.16; // ≈ 80 nm

function depthNow(wet: boolean) {
  const v = engine.player.view;
  const p = etchProfile(v.phaseId, v.phaseT, wet, engine.failSeverity('etch-variation'));
  return { depth: p.depth * NM, undercut: p.undercut * NM };
}

/** Ions (straight down) and radicals (random walk) inside the cross-section. */
function InsetParticles({ wet, strip }: { wet: boolean; strip: boolean }) {
  const N = 60;
  const ions = useRef<THREE.InstancedMesh>(null);
  const rads = useRef<THREE.InstancedMesh>(null);
  const out = useRef<THREE.InstancedMesh>(null);
  const seeds = useMemo(() => {
    const r = rng(9);
    return Array.from({ length: N }, () => ({ x: r() * 1.0 - 0.5, o: r(), s: 0.7 + r() * 0.6, z: r() * 0.2 - 0.1, w: r() }));
  }, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const t = useRef(0);
  useFrame((_, dt) => {
    if (!ions.current || !rads.current || !out.current) return;
    t.current += pdt(dt);
    const active = strip ? inPhase('ash') : !wet && (inPhase('main') || inPhase('endpoint'));
    const resistTop = H + (strip ? (engine.tele.value('resist', 0) / 80) * RESIST_H : RESIST_H);
    const { depth } = strip ? { depth: H } : depthNow(wet);
    for (let i = 0; i < N; i++) {
      const s = seeds[i];
      ions.current.setMatrixAt(i, HIDE);
      rads.current.setMatrixAt(i, HIDE);
      out.current.setMatrixAt(i, HIDE);
      if (!active) continue;
      const u = (t.current * 0.8 * s.s + s.o) % 1;
      if (!strip && i < N / 2) {
        // ion: vertical drop, stops at the surface it meets
        const inOpening = s.x > O0 && s.x < O1;
        const floor = inOpening ? H - depth : resistTop;
        const y = 0.62 - u * (0.62 - floor);
        o.position.set(s.x, y, s.z);
        o.scale.set(0.006, 0.05, 0.006);
        o.updateMatrix();
        ions.current.setMatrixAt(i, o.matrix);
      } else if (strip) {
        // O radicals drift down to the resist; CO₂ / H₂O leave upward
        if (s.w < 0.6) {
          o.position.set(s.x + 0.03 * Math.sin(t.current * 3 + i), 0.62 - u * (0.62 - resistTop), s.z);
          o.scale.setScalar(0.01);
          o.updateMatrix();
          rads.current.setMatrixAt(i, o.matrix);
        } else {
          o.position.set(s.x + 0.04 * Math.sin(t.current * 2 + i), resistTop + u * 0.3, s.z);
          o.scale.setScalar(0.012);
          o.updateMatrix();
          out.current.setMatrixAt(i, o.matrix);
        }
      } else {
        // radical: wandering neutral
        const x = s.x + 0.05 * Math.sin(t.current * 2.3 + i * 1.7);
        if (s.w > 0.5) continue;
        const y = resistTop + 0.04 + ((u + 0.5 * Math.abs(Math.sin(i))) % 1) * 0.2;
        o.position.set(x, y, s.z);
        o.scale.setScalar(0.008);
        o.updateMatrix();
        rads.current.setMatrixAt(i, o.matrix);
      }
    }
    ions.current.instanceMatrix.needsUpdate = true;
    rads.current.instanceMatrix.needsUpdate = true;
    out.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <>
      <instancedMesh ref={ions} args={[GEO.box, ionMat, N]} frustumCulled={false} />
      <instancedMesh ref={rads} args={[GEO.sphereLow, radMat, N]} frustumCulled={false} />
      <instancedMesh ref={out} args={[GEO.sphereLow, gasOutMat, N]} frustumCulled={false} />
    </>
  );
}

function SectionInset({ wet, strip }: { wet: boolean; strip: boolean }) {
  const sub = useMemo(() => rect(-0.55, -0.3, 0.55, 0), []);
  const liquid = useRef<THREE.Mesh>(null);
  useFrame(() => {
    if (liquid.current) liquid.current.visible = (wet && (inPhase('main') || inPhase('endpoint'))) || (strip && inPhase('wet'));
  });
  return (
    <Inset id="etch-section" position={[CHAMBER.x, 2.4, 1.55]} size={[1.3, 0.85]} mpu={MPU} schematic={false} title={strip ? 'RESIST STRIP · CROSS-SECTION' : wet ? 'WET (ISOTROPIC) ETCH · CROSS-SECTION' : 'DRY (ANISOTROPIC) ETCH · CROSS-SECTION'}>
      <group position={[0, -0.12, 0.12]} rotation={[0.2, -0.26, 0]}>
        <ProfileSlab points={sub} depth={0.22} m={subMat} />
        <LiveProfile
          depth={0.22}
          m={filmMat}
          compute={() => {
            if (strip) return etchedFilm(H, H * 0.04, H);
            const { depth, undercut } = depthNow(wet);
            return etchedFilm(depth, undercut, H, 0, O0, O1);
          }}
        />
        {/* resist mask (left + right of the opening) */}
        <LiveProfile
          depth={0.22}
          m={resistMat}
          compute={() => {
            const th = strip ? (engine.tele.value('resist', 0) / 80) * RESIST_H : RESIST_H;
            if (th < 0.002) return null;
            return [
              [-0.55, H],
              [O0, H],
              [O0, H + th],
              [-0.55, H + th],
            ];
          }}
        />
        <LiveProfile
          depth={0.22}
          m={resistMat}
          compute={() => {
            const th = strip ? (engine.tele.value('resist', 0) / 80) * RESIST_H : RESIST_H;
            if (th < 0.002) return null;
            return [
              [O1, H],
              [0.55, H],
              [0.55, H + th],
              [O1, H + th],
            ];
          }}
        />
        <mesh ref={liquid} position={[0, H + 0.12, 0]} material={liquidMat}>
          <boxGeometry args={[1.1, 0.5, 0.22]} />
        </mesh>
        <InsetParticles wet={wet} strip={strip} />
      </group>
      <TechLabel
        position={[0.12, -0.32, 0.2]}
        title={strip ? 'RESIST' : 'ETCH DEPTH'}
        min={2}
        value={() => {
          if (strip) return `${engine.tele.value('resist', 0).toFixed(0)} nm remaining · SIMULATED`;
          const v = engine.player.view;
          const p = etchProfile(v.phaseId, v.phaseT, wet);
          return `${p.depth.toFixed(0)} / ${ETCH_TARGET_NM} nm · undercut ${p.undercut.toFixed(0)} nm · SIMULATED`;
        }}
      />
      <TechLabel position={[-0.6, 0.36, 0.2]} title="RESIST MASK" min={3} />
      <TechLabel position={[-0.6, 0.06, 0.2]} title={strip ? 'PATTERNED FILM' : 'FILM BEING ETCHED'} min={3} />
    </Inset>
  );
}

/* ---------------------------------------------------------------- chamber */

function ChamberIons({ active }: { active: () => boolean }) {
  const N = 70;
  const ref = useRef<THREE.InstancedMesh>(null);
  const seeds = useMemo(() => {
    const r = rng(77);
    return Array.from({ length: N }, () => ({ r: Math.sqrt(r()) * 0.15, a: r() * Math.PI * 2, o: r(), s: 0.8 + r() * 0.5 }));
  }, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const t = useRef(0);
  useFrame((_, dt) => {
    if (!ref.current) return;
    t.current += pdt(dt);
    const on = active();
    for (let i = 0; i < N; i++) {
      if (!on) {
        ref.current.setMatrixAt(i, HIDE);
        continue;
      }
      const s = seeds[i];
      const u = (t.current * 1.4 * s.s + s.o) % 1;
      o.position.set(Math.cos(s.a) * s.r, 1.22 - u * (1.22 - CHAMBER.waferY - 0.01), Math.sin(s.a) * s.r);
      o.scale.set(0.0025, 0.03, 0.0025);
      o.updateMatrix();
      ref.current.setMatrixAt(i, o.matrix);
    }
    ref.current.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={ref} args={[GEO.box, ionMat, N]} frustumCulled={false} />;
}

function EtchInternals({ wet }: { wet: boolean }) {
  const glow = useRef<THREE.Mesh>(null);
  const resist = useRef<THREE.Mesh>(null);
  const liquid = useRef<THREE.Mesh>(null);
  const nozzle = useRef<THREE.Group>(null);
  const icp = useFolded(buildIcpSource);
  const oes = useFolded(buildOes);
  const arm = useFolded(buildNozzleArm);
  const drive = useFolded(buildWetDrive);
  useFrame(() => {
    const rf = engine.tele.value('rf', 0) / 900;
    if (glow.current) {
      glow.current.visible = !wet && rf > 0.02;
      plasmaEtch.opacity = 0.12 + 0.22 * rf * (0.92 + 0.08 * Math.sin(engine.time * 40));
    }
    const w = wet && (inPhase('main') || inPhase('endpoint') || inPhase('strike'));
    if (liquid.current) liquid.current.visible = w;
    if (nozzle.current) nozzle.current.rotation.y = w ? 0 : 0.9;
    if (resist.current) resist.current.visible = !inPhase('unload') || engine.player.view.phaseT < 0.98;
  });
  return (
    <group>
      <Pedestal esc={!wet} machine="etcher" />
      <mesh ref={resist} position={[0, CHAMBER.waferY + 0.0012, 0]} rotation={[-Math.PI / 2, 0, 0]} material={resistMat}>
        <circleGeometry args={[0.148, 48]} />
      </mesh>
      {!wet && (
        <>
          <Showerhead machine="etcher" y={1.27} />
          <mesh ref={glow} position={[0, (CHAMBER.waferY + 1.25) / 2, 0]} material={plasmaEtch}>
            <cylinderGeometry args={[0.18, 0.2, 1.25 - CHAMBER.waferY - 0.02, 40, 1, true]} />
          </mesh>
          <ChamberIons active={() => inPhase('main') || inPhase('endpoint')} />
          {/* ICP source: coil + RF shield + match on the lid, bias match below */}
          <Clickable sel={{ kind: 'component', id: 'rf', machine: 'etcher', label: 'RF generators & match' }}>
            <IcpView parts={icp} />
          </Clickable>
          <Clickable sel={{ kind: 'component', id: 'oes-window', machine: 'etcher', label: 'OES viewport' }}>
            <Baked parts={oes} />
          </Clickable>
        </>
      )}
      {wet && (
        <>
          <mesh ref={liquid} position={[0, CHAMBER.waferY + 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]} material={liquidMat}>
            <circleGeometry args={[0.15, 48]} />
          </mesh>
          <Baked parts={drive} />
          <group ref={nozzle} position={[0.3, 1.18, 0]}>
            <Baked parts={arm} />
          </group>
        </>
      )}
    </group>
  );
}

/** The ICP shield can follows the chamber's cut-away / x-ray like the cluster shells. */
function IcpView({ parts }: { parts: ReturnType<typeof useFolded> }) {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  return <Baked parts={parts} view={effectiveView(viewRaw, cam)} />;
}

function AshInternals() {
  const glow = useRef<THREE.Mesh>(null);
  const resist = useRef<THREE.Mesh>(null);
  const rps = useFolded(buildRps);
  useFrame(() => {
    const ash = inPhase('ash');
    if (glow.current) glow.current.visible = ash;
    plasmaAsh.opacity = 0.3 + 0.08 * Math.sin(engine.time * 25);
    if (resist.current) {
      const r = engine.tele.value('resist', 0) / 80;
      resist.current.visible = r > 0.01;
      (resist.current.material as THREE.MeshStandardMaterial).opacity = 0.2 + 0.7 * r;
    }
  });
  const rm = useMemo(() => resistMat.clone(), []);
  return (
    <group>
      <Pedestal heated machine="asher" id="heater" />
      <mesh ref={resist} position={[0, CHAMBER.waferY + 0.0012, 0]} rotation={[-Math.PI / 2, 0, 0]} material={rm}>
        <circleGeometry args={[0.148, 48]} />
      </mesh>
      <Showerhead machine="asher" y={1.27} />
      {/* downstream plasma source: a quartz tube above the chamber, radicals flow down */}
      <Clickable sel={{ kind: 'component', id: 'plasma-source', machine: 'asher', label: 'Downstream plasma source' }}>
        <mesh position={[0, 1.62, 0]} material={M.quartz}>
          <cylinderGeometry args={[0.07, 0.07, 0.42, 24, 1, true]} />
        </mesh>
        <mesh ref={glow} position={[0, 1.62, 0]} material={plasmaAsh}>
          <cylinderGeometry args={[0.06, 0.06, 0.38, 24]} />
        </mesh>
        <Baked parts={rps} />
      </Clickable>
    </group>
  );
}

/* ---------------------------------------------------------------- endpoint monitor */

function EndpointMonitor({ strip }: { strip: boolean }) {
  const ch = strip ? 'co' : 'oes';
  return (
    <group position={[2.35, 0, -0.55]} rotation={[0, -0.35, 0]}>
      <Screen
        size={[0.62, 0.4]}
        position={[0, 1.45, 0.03]}
        hz={4}
        draw={(g, w, h) => {
          clear(g, w, h, strip ? 'CO EMISSION · ENDPOINT · SIMULATED' : 'OES ENDPOINT · SIMULATED');
          const c = engine.tele.get(ch);
          const data = c ? c.series().slice(-180) : [];
          plot(g, data, w * 0.05, h * 0.38, w * 0.9, h * 0.5, 0, 1.2, SCR.data);
          const v = engine.tele.value(ch, 0);
          bigNumber(g, strip ? 'CO LINE' : 'EMISSION', v.toFixed(2), 'a.u.', w * 0.05, h * 0.2, h * 0.1, v < 0.5 && v > 0.01 ? SCR.warn : SCR.text);
          if (v < 0.5 && v > 0.01) {
            g.fillStyle = SCR.warn;
            g.font = `${Math.round(h * 0.06)}px monospace`;
            g.fillText('ENDPOINT DETECTED', w * 0.55, h * 0.28);
          }
        }}
      />
    </group>
  );
}

/** Neighbouring etch / strip clusters along the bay and the endpoint-monitor stand (one merged model). */
function BayStatic() {
  const parts = useFolded((k) => {
    // each drops the closed chamber that would stand in the bay wall
    k.at([0, 0, -3.9], 0, () => buildClusterNeighbour(k, M.greenAccent, 'etcher', [1]));
    k.at([0, 0, 3.9], 0, () => buildClusterNeighbour(k, M.orangeAccent, 'asher', [-1]));
    k.at([2.35, 0, -0.55], -0.35, () => buildMonitorStand(k));
  });
  return <Baked parts={parts} />;
}

/* ---------------------------------------------------------------- scene */

export default function EtchScene({ stage }: SceneProps) {
  const strip = stage.variant === 'strip';
  const etchMode = useParam('etchMode');
  const wet = !strip && etchMode === 1;
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0;
  }, []);
  const machine = strip ? 'asher' : 'etcher';
  return (
    <>
      <Lighting env="cleanroom" shadowExtent={5} />
      <CleanroomBay width={12} depth={9} height={4.4} />
      <ClusterTool machine={machine} label={strip ? 'Plasma asher (resist strip)' : 'Plasma etch cluster'} accent={strip ? 'orange' : 'green'}>
        {strip ? <AshInternals /> : <EtchInternals wet={wet} />}
        <SensorIndicator id="capacitance-manometer" channel="pressure" machine={machine} position={[0.42, 1.2, 0.25]} size={0.05} />
        {!strip && <SensorIndicator id="oes" channel="oes" machine="etcher" position={[0.5, 1.26, 0.12]} size={0.045} />}
        {strip && <SensorIndicator id="thermocouple" channel="platen" machine="asher" position={[0.2, 0.86, 0.3]} size={0.05} />}
      </ClusterTool>
      <SectionInset wet={wet} strip={strip} />
      <EndpointMonitor strip={strip} />
      <TechLabel
        position={[CHAMBER.x + 0.6, 1.5, 0]}
        title={strip ? 'ASHER CHAMBER' : wet ? 'WET ETCH' : 'PLASMA CHAMBER'}
        min={2}
        lines={wet ? ['SIMPLIFIED: real wet etch runs in a wet bench or single-wafer spin processor'] : undefined}
        value={() => {
          const v = engine.player.view;
          if (strip) return v.phaseId === 'ash' ? 'O₂ PLASMA · RESIST → CO₂ + H₂O' : v.phase.label.toUpperCase();
          if (wet) return v.phaseId === 'main' ? 'ISOTROPIC · ATTACKS IN ALL DIRECTIONS' : v.phase.label.toUpperCase();
          return v.phaseId === 'main' ? `IONS ⟂ WAFER · ${engine.tele.value('rf', 0).toFixed(0)} W RF` : v.phase.label.toUpperCase();
        }}
      />
      <Operator position={[-3.2, 0, 2.2]} rotation={Math.PI * 0.7} still />
      <BayStatic />
    </>
  );
}
