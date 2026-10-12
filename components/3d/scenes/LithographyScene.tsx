'use client';
/**
 * Lithography scanner (§23, §26) — an educational, generic EUV-style scanner:
 *   reticle: library → particle check → load onto the reticle stage → reticle alignment
 *   align:   wafer onto the measure chuck → height map (level sensor) → alignment marks →
 *            overlay corrections (use the MISALIGN slider to see what misalignment does)
 *   expose:  dual-stage swap → step & scan, field after field (reticle moves 4× opposite) →
 *            latent image in the resist → unload to the track
 * Light path is drawn in false colour: EUV (13.5 nm) is invisible and travels in vacuum.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, CleanroomBay } from '../environments';
import { M, shell, effectiveView } from '../materials';
import { B, GEO, Tube } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Inset, ProfileSlab, FlowLine, rect } from '../parts/section';
import { waferGeometry } from '../parts/wafer';
import { Screen, clear, plot, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { reticleTexture, drawWafer } from '../textures';
import { engine } from '@/simulation/engine';
import { pp, inPhase, pdt } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { clamp, lerp, rng, smooth, fract } from '@/lib/math';
import { exposureFields, FIELD_W, FIELD_H } from '@/simulation/models';
import type { V3 } from '../parts/primitives';
import type { ViewMode } from '@/types';
import { useFolded } from '../parts/cluster';
import { Kit, cabinet, foot, boltCircle, viewport, bellows, grille, windowPane, type PartOpts, type BakedPart } from '../kit/build';
import { KM, labelMaterial } from '../kit/finish';
import { Baked } from '../kit/Baked';
import { casterGeometry, shadowOnly } from '../kit/shadow';

type Variant = 'reticle' | 'align' | 'expose';

const MX = -1.0; // measure position
const EX = 0.05; // expose position (optical axis)
const WY = 0.99; // wafer height on the chuck
const TI = new THREE.Vector3(2.3, WY, 0.55); // track interface
const RET_Y = 2.32; // reticle height (pattern facing down)
const RET_X = 0.2;
const FIELDS = exposureFields();
const N_FIELDS = FIELDS.length;

/* ---------------------------------------------------------------- motion */

/** Step & scan: wafer-centre offset (m) that puts the current field under the slit. */
function scanState() {
  const v = engine.player.view;
  if (v.phaseId !== 'expose') {
    const done = pp('expose') >= 1;
    return { k: done ? N_FIELDS : 0, scanning: false, dx: 0, dz: 0, scan: 0, exposed: done ? N_FIELDS : 0 };
  }
  const x = v.phaseT * N_FIELDS;
  const k = Math.min(N_FIELDS - 1, Math.floor(x));
  const u = fract(x);
  const f = FIELDS[k];
  const dir = k % 2 === 0 ? 1 : -1;
  const half = FIELD_H / 2000;
  let dx = -f.cx / 1000;
  let dz = -f.cy / 1000;
  let scan = 0;
  if (u < 0.72) {
    scan = dir * lerp(-half, half, u / 0.72);
    dz -= scan;
  } else if (k + 1 < N_FIELDS) {
    // step to the start of the next field
    const n = FIELDS[k + 1];
    const s = smooth((u - 0.72) / 0.28);
    const ndir = (k + 1) % 2 === 0 ? 1 : -1;
    const fromZ = dz - dir * half;
    const toZ = -n.cy / 1000 + ndir * half;
    dx = lerp(dx, -n.cx / 1000, s);
    dz = lerp(fromZ, toZ, s);
  } else dz -= dir * half;
  return { k, scanning: u < 0.72, dx, dz, scan, exposed: k + (u >= 0.72 ? 1 : 0) };
}

/** 24 alignment marks in the scribe lines (wafer-local x, z in m). */
const MARKS: [number, number][] = (() => {
  const step = Math.max(1, Math.floor(N_FIELDS / 24));
  return Array.from({ length: 24 }, (_, i) => {
    const f = FIELDS[(i * step) % N_FIELDS];
    return [(f.cx + FIELD_W / 2) / 1000, (f.cy + FIELD_H / 2) / 1000] as [number, number];
  });
})();

const W = new THREE.Vector3();
/** Our wafer (chuck A) position for the active variant. */
function waferPos(variant: Variant): THREE.Vector3 {
  const v = engine.player.view;
  if (variant === 'align') {
    const u = smooth(pp('load'));
    W.set(lerp(TI.x, MX, u), WY + Math.sin(Math.PI * u) * 0.12, lerp(TI.z, 0, u));
    if (v.phaseId === 'align') {
      // the stage brings each mark under the alignment sensor
      const x = v.phaseT * MARKS.length;
      const k = Math.min(MARKS.length - 1, Math.floor(x));
      const n = Math.min(MARKS.length - 1, k + 1);
      const s = smooth(clamp((fract(x) - 0.6) / 0.4));
      W.x = MX - lerp(MARKS[k][0], MARKS[n][0], s);
      W.z = -lerp(MARKS[k][1], MARKS[n][1], s);
    }
    return W;
  }
  if (variant === 'expose') {
    const sw = smooth(pp('swap'));
    const c = (MX + EX) / 2;
    const r = (EX - MX) / 2;
    W.set(c - r * Math.cos(Math.PI * sw), WY, -Math.sin(Math.PI * sw) * 0.55);
    const s = scanState();
    if (pp('swap') >= 1) W.set(EX + s.dx, WY, s.dz);
    const out = smooth(pp('unload'));
    if (out > 0) W.set(lerp(W.x, TI.x, out), WY + Math.sin(Math.PI * out) * 0.12, lerp(W.z, TI.z, out));
    return W;
  }
  return W.set(MX, WY, 0);
}

/** Reticle position for the reticle variant (library → inspection → stage). */
const R = new THREE.Vector3();
const LIB = new THREE.Vector3(-1.75, 2.55, -0.55);
const INSP = new THREE.Vector3(-1.3, 2.55, 0.35);
const RET_HOME = new THREE.Vector3(RET_X, RET_Y, 0);
function reticlePos(variant: Variant): THREE.Vector3 {
  if (variant !== 'reticle') {
    R.set(RET_X, RET_Y, 0);
    if (variant === 'expose') R.z = -4 * scanState().scan; // 4× reduction: reticle scans 4× faster, opposite
    return R;
  }
  const a = smooth(pp('library'));
  const b = smooth(pp('load'));
  R.copy(LIB).lerp(INSP, a);
  if (b > 0) {
    R.lerp(RET_HOME, b);
    R.y += Math.sin(Math.PI * b) * 0.12;
  }
  if (inPhase('align')) R.x += 0.004 * Math.sin(engine.time * 3) * (1 - engine.player.view.phaseT);
  return R;
}

/* ---------------------------------------------------------------- materials */

const beamMat = new THREE.MeshBasicMaterial({ color: '#b48cff', transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
const slitMat = new THREE.MeshBasicMaterial({ color: '#e3d0ff', toneMapped: false });
const markMat = new THREE.MeshBasicMaterial({ color: '#4fbf3f', toneMapped: false });
const markDim = new THREE.MeshBasicMaterial({ color: '#4a5048', toneMapped: false });
const arrowMat = new THREE.MeshBasicMaterial({ color: '#e8b23a', toneMapped: false });
const levelMat = new THREE.MeshBasicMaterial({ color: '#9fd18a', transparent: true, opacity: 0.8, toneMapped: false });
const mirrorMat = new THREE.MeshStandardMaterial({ color: '#8c8aa0', roughness: 0.05, metalness: 1 });
const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);

/* ---------------------------------------------------------------- scanner body (kit) */

const Z0: V3 = [0, 0, 0];
const RX: V3 = [0, 0, Math.PI / 2]; // cylinder axis → X
const RZ: V3 = [Math.PI / 2, 0, 0]; // cylinder axis → Z
/** enclosure parts are built as ordinary parts so they fold; <Static asShell> renders them as shell */
const SH: PartOpts = {};
const SHN: PartOpts = { cast: false };

/** polished black granite (balance mass, stage base) */
const GRANITE = new THREE.MeshStandardMaterial({ color: '#2a2c2e', roughness: 0.3, metalness: 0.05, roughnessMap: KM.paint.roughnessMap, bumpMap: KM.paint.bumpMap, bumpScale: 0.25 });
/** amber glass-ceramic (zero-expansion stage mirror blocks, mirror substrates) */
const ZERODUR = new THREE.MeshStandardMaterial({ color: '#6a4c34', roughness: 0.22, metalness: 0.1 });
/** bead-blasted aluminium vacuum housings */
const ALU = new THREE.MeshStandardMaterial({ color: '#c3c8cb', roughness: 0.74, metalness: 0.5, roughnessMap: KM.paint.roughnessMap });
/** cast metrology frame (dark grey, satin) */
const CAST = new THREE.MeshStandardMaterial({ color: '#7a8186', roughness: 0.6, metalness: 0.18, roughnessMap: KM.paint.roughnessMap, bumpMap: KM.paint.bumpMap, bumpScale: 0.5 });
/** satin electropolished stainless for large vacuum vessels (full-metal finishes mirror the dark bay and read black) */
const SATIN = new THREE.MeshStandardMaterial({ color: '#c4c9cc', roughness: 0.5, metalness: 0.55, roughnessMap: KM.stainless.roughnessMap });
const pellicleMat = new THREE.MeshPhysicalMaterial({ color: '#d9e4dc', roughness: 0.1, transparent: true, opacity: 0.14, depthWrite: false });

/** Label plate with part options (shell labels follow the cut-away). */
function plate(k: Kit, kind: Parameters<typeof labelMaterial>[0], text: string, sub: string, w: number, h: number, pos: V3, rot: V3 = Z0, o: PartOpts = {}, accent?: string) {
  const g = new THREE.PlaneGeometry(w, h);
  k.add(labelMaterial(kind, text, sub, accent), g, pos, rot, [1, 1, 1], { cast: false, keepUV: true, ...o });
  g.dispose();
}

/** Flat ring of rectangular section (flanges, clamp rings) from y to y + h. */
function ring(k: Kit, m: THREE.Material, r0: number, r1: number, h: number, y: number, seg = 48, o: PartOpts = {}) {
  // corner points doubled so the lathe keeps hard edges
  k.lathe(m, [[r0, 0], [r1, 0], [r1, 0], [r1, h], [r1, h], [r0, h], [r0, h], [r0, 0]], [0, y, 0], Z0, seg, o);
}

/** Local frame at a with +Y pointing at b (straight tubes between two points). */
function along(k: Kit, a: V3, b: V3, fn: (len: number) => void) {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length();
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  k.at(a, [e.x, e.y, e.z], () => fn(len));
}

/** Plate with round holes, in plan (x, z), from y to y + t. */
function holedPlate(k: Kit, m: THREE.Material, x0: number, x1: number, z0: number, z1: number, holes: [number, number, number][], y: number, t: number) {
  const s = new THREE.Shape([new THREE.Vector2(x0, -z0), new THREE.Vector2(x1, -z0), new THREE.Vector2(x1, -z1), new THREE.Vector2(x0, -z1)]);
  for (const [hx, hz, hr] of holes) {
    const p = new THREE.Path();
    p.absarc(hx, -hz, hr, 0, Math.PI * 2, true);
    s.holes.push(p);
  }
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 40 });
  k.add(m, g, [0, y, 0], [-Math.PI / 2, 0, 0]);
  g.dispose();
}

/** Signal-free LED status strip with part options. */
function led(k: Kit, w: number, pos: V3, m: THREE.Material = KM.ledGreen, o: PartOpts = {}) {
  k.box(KM.seam, [w + 0.01, 0.014, 0.004], pos, Z0, { cast: false, ...o });
  k.box(m, [w, 0.008, 0.004], [pos[0], pos[1], pos[2] + 0.002], Z0, { cast: false, ...o });
}

/**
 * Outer enclosure and the housings the cut-away opens: powder-coated cabinet on a dark kick
 * plate (6 service doors, louvres, handles, seams), viewing window, reticle-pod port, HMI,
 * EMO buttons, model plate and hazard labels; the projection-optics barrel, illuminator
 * vessel, beam tunnel and the track-interface port frame. Everything here follows x-ray /
 * cut-away (the front half disappears when the camera looks inside).
 */
function buildEnclosure(k: Kit) {
  k.at([0.1, 0, 0], 0, () => {
    cabinet(k, { size: [4.6, 2.9, 2.2], body: KM.paint, trim: KM.paintGraphite, plinth: 0.1, panels: 6, rows: [0.78, 2.05], sidePanels: 3, vent: true, handles: true, stripe: false, feet: false, ao: false });
    // accent band, status LEDs, model plate and labels on the front
    k.box(M.orangeAccent, [4.58, 0.035, 0.004], [0, 2.14, 1.1015], Z0, SHN);
    k.box(KM.paintGraphite, [4.58, 0.012, 0.004], [0, 2.105, 1.1015], Z0, SHN);
    led(k, 0.5, [1.55, 2.62, 1.102], KM.ledGreen, SH);
    plate(k, 'model', 'XS-3400', 'EUV STEP & SCAN · 13.5 nm · NA 0.33', 0.62, 0.155, [-1.62, 2.52, 1.1015], Z0, SH, '#c06a2b');
    plate(k, 'warn', 'LASER RADIATION', '', 0.13, 0.13, [-0.86, 2.52, 1.1015], Z0, SH);
  });
  // viewing window onto the measure side (between the door seams)
  windowPane(k, 0.5, 0.5, [-0.283, 1.32, 1.112], { ...SH, glass: KM.glassSmoke });
  // reticle-pod load port (front left): recess, shelf, pod
  k.box(KM.seam, [0.42, 0.34, 0.004], [-1.82, 1.32, 1.102], Z0, SHN);
  k.rbox(KM.anodized, [0.44, 0.022, 0.26], 0.006, [-1.82, 1.16, 1.22], Z0, SH);
  for (const x of [-2.0, -1.64]) k.box(KM.anodized, [0.02, 0.1, 0.2], [x, 1.11, 1.2], [0.5, 0, 0], SH);
  k.rbox(KM.plastic, [0.3, 0.13, 0.26], 0.02, [-1.82, 1.236, 1.22], Z0, SH);
  k.rbox(KM.plasticWhite, [0.24, 0.02, 0.2], 0.008, [-1.82, 1.31, 1.22], Z0, SH);
  k.rbox(KM.anodized, [0.12, 0.022, 0.03], 0.008, [-1.82, 1.335, 1.22], Z0, SH);
  plate(k, 'tag', 'RETICLE POD PORT', 'RSP-150 · LOAD / UNLOAD', 0.22, 0.055, [-1.82, 1.58, 1.1015], Z0, SH);
  // operator HMI on a swing arm and EMO buttons at both front corners
  k.at([1.25, 1.5, 1.1], 0, () => {
    k.rbox(KM.anodizedDark, [0.08, 0.12, 0.02], 0.006, [0, 0, 0.01], Z0, SH);
    k.cyl(KM.anodizedDark, 0.016, 0.2, [0, 0, 0.11], RZ, 12, SH);
    k.rbox(KM.plastic, [0.42, 0.29, 0.035], 0.01, [0, 0.02, 0.22], [-0.12, 0, 0], SH);
    k.box(KM.screen, [0.37, 0.235, 0.002], [0, 0.022, 0.2385], [-0.12, 0, 0], SHN);
    k.rbox(KM.plastic, [0.42, 0.03, 0.14], 0.006, [0, -0.17, 0.27], Z0, SH);
  });
  for (const x of [-2.02, 2.22])
    k.at([x, 0.95, 1.1], 0, () => {
      k.rbox(KM.paintYellow, [0.08, 0.08, 0.022], 0.006, [0, 0, 0.011], Z0, SH);
      k.cyl(KM.paintRed, 0.024, 0.028, [0, 0, 0.034], RZ, 20, SH);
    });
  // track-interface port on the right side wall
  k.box(KM.seam, [0.004, 0.44, 0.66], [2.4015, 0.98, 0.55], Z0, SHN);
  for (const [y, h] of [[1.215, 0.03], [0.745, 0.03]] as const) k.box(KM.paintGraphite, [0.012, h, 0.7], [2.405, y, 0.55], Z0, SH);
  // projection-optics barrel: nose, lower barrel, mounting flange, upper barrel with ribs, top cover
  k.lathe(SATIN, [[0.13, 1.13], [0.3, 1.2], [0.3, 1.205]], [EX, 0, 0], Z0, 56, SH);
  k.cyl(SATIN, 0.3, 0.35, [EX, 1.38, 0], Z0, 56, { ...SH, open: true });
  k.at([EX, 0, 0], 0, () => {
    ring(k, KM.stainlessDark, 0.3, 0.315, 0.02, 1.2, 56, SH);
    ring(k, SATIN, 0.3, 0.44, 0.045, 1.555, 64, SH);
    boltCircle(k, 0.41, 24, 1.602, 0.008, KM.stainlessDark, SH);
  });
  k.cyl(SATIN, 0.36, 0.42, [EX, 1.81, 0], Z0, 64, { ...SH, open: true });
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    k.box(SATIN, [0.016, 0.38, 0.03], [EX + Math.cos(a) * 0.37, 1.81, Math.sin(a) * 0.37], [0, -a, 0], SH);
  }
  for (const y of [1.72, 1.92]) k.torus(KM.copper, 0.388, 0.009, [EX, y, 0], Z0, 56, SH);
  k.at([EX, 0, 0], 0, () => {
    ring(k, SATIN, 0.3, 0.39, 0.035, 2.02, 64, SH);
    boltCircle(k, 0.37, 24, 2.057, 0.008, KM.stainlessDark, SH);
    ring(k, KM.stainlessDark, 0.16, 0.3, 0.012, 2.055, 56, SH);
  });
  // illuminator vacuum vessel with ribs and a bolted cover
  k.rbox(ALU, [0.85, 0.42, 0.55], 0.03, [-0.95, 2.3, 0], Z0, SH);
  k.rbox(ALU, [0.8, 0.03, 0.5], 0.01, [-0.95, 2.525, 0], Z0, SH);
  for (const x of [-1.33, -0.57]) for (const z of [-0.22, -0.11, 0, 0.11, 0.22]) k.cyl(KM.stainlessDark, 0.006, 0.006, [x, 2.543, z], Z0, 6, SHN);
  for (const x of [-1.25, -1.05, -0.85, -0.65]) {
    for (const z of [-0.2815, 0.2815]) k.box(ALU, [0.02, 0.36, 0.012], [x, 2.29, z], Z0, SH);
    k.box(ALU, [0.02, 0.012, 0.5], [x, 2.096, 0], Z0, SH);
  }
  // beam tunnel from the source port to the illuminator (cut open in the cut-away)
  along(k, [-2.2, 2.25, 0], [-1.375, 2.3, 0], (len) => {
    k.cyl(SATIN, 0.07, len, [0, len / 2, 0], Z0, 32, { ...SH, open: true });
    for (const y of [0.02, len - 0.02]) ring(k, SATIN, 0.07, 0.1, 0.022, y - 0.011, 40, SH);
    bellows(k, 0.085, 0.16, 7, [0, len * 0.45, 0], SATIN, SH);
  });
}

/** Granite balance mass on air mounts, base frame, planar-motor magnet plate, bumpers. */
function buildBase(k: Kit) {
  const cx = -0.1;
  // welded base frame with levelling feet
  k.rbox(KM.paintGraphite, [3.75, 0.19, 1.84], 0.01, [cx, 0.145, 0]);
  k.box(KM.seam, [3.7, 0.004, 0.002], [cx, 0.2, 0.921], Z0, { cast: false });
  for (const x of [-1.8, -0.1, 1.6]) for (const z of [-0.85, 0.85]) foot(k, [x, 0, z]);
  // air mounts (vibration isolation) under the granite
  for (const x of [-1.6, -0.1, 1.4])
    for (const z of [-0.58, 0.58]) {
      k.cyl(KM.anodized, 0.13, 0.025, [x, 0.2525, z], Z0, 32);
      bellows(k, 0.115, 0.1, 4, [x, 0.265, z], KM.rubber);
      k.cyl(KM.anodized, 0.13, 0.02, [x, 0.375, z], Z0, 32);
    }
  // granite block with lifting inserts and a label
  k.rbox(GRANITE, [3.7, 0.37, 1.7], 0.025, [cx, 0.57, 0]);
  for (const x of [-1.6, 1.4]) for (const z of [-0.86, 0.86]) k.cyl(KM.stainless, 0.018, 0.006, [x, 0.57, z * 0.9999], RZ, 12, { cast: false });
  plate(k, 'tag', 'BALANCE MASS', 'GRANITE · FLAT ±1 µm', 0.26, 0.065, [-0.6, 0.57, 0.851]);
  plate(k, 'warn', 'MAGNETIC FIELD', '', 0.09, 0.09, [0.9, 0.57, 0.851]);
  // planar-motor magnet plate with its tile seams
  k.rbox(KM.anodizedDark, [3.4, 0.012, 1.56], 0.004, [cx, 0.756, 0]);
  for (let i = 1; i < 20; i++) k.box(KM.seam, [0.003, 0.001, 1.54], [cx - 1.7 + i * 0.17, 0.7625, 0], Z0, { cast: false });
  for (let j = 1; j < 9; j++) k.box(KM.seam, [3.38, 0.001, 0.003], [cx, 0.7625, -0.78 + j * 0.173], Z0, { cast: false });
  // safety bumpers along the back and the left edge (clear of the stage paths)
  k.rbox(KM.rubber, [3.3, 0.04, 0.03], 0.008, [cx, 0.782, -0.835]);
  k.rbox(KM.rubber, [0.03, 0.04, 1.5], 0.008, [-1.83, 0.782, 0]);
}

/** Metrology frame: perimeter frame on isolated legs, lens bridge and measure bridge. */
function buildFrame(k: Kit) {
  const y = 1.48;
  for (const x of [-1.6, 0.72])
    for (const z of [-0.92, 0.92]) {
      k.rbox(CAST, [0.12, 1.16, 0.12], 0.012, [x, 0.24 + 0.58, z]);
      k.cyl(KM.anodized, 0.085, 0.085, [x, 1.4375, z], Z0, 28);
      k.torus(KM.seam, 0.085, 0.002, [x, 1.44, z], Z0, 28, { cast: false });
      k.rbox(CAST, [0.2, 0.03, 0.2], 0.008, [x, 0.255, z]);
    }
  // perimeter frame
  for (const z of [-0.92, 0.92]) k.rbox(CAST, [2.44, 0.1, 0.12], 0.012, [-0.44, y + 0.05, z]);
  for (const x of [-1.6, 0.72]) k.rbox(CAST, [0.12, 0.1, 1.96], 0.012, [x, y + 0.05, 0]);
  // lens bridge (projection optics sit in it) and measure bridge (alignment + level sensors)
  holedPlate(k, CAST, EX - 0.48, EX + 0.48, -0.88, 0.88, [[EX, 0, 0.31]], y, 0.07);
  holedPlate(k, CAST, MX - 0.42, MX + 0.42, -0.88, 0.88, [[MX, 0, 0.2]], y, 0.07);
  // flexure spider carrying the alignment sensor in the measure-bridge opening
  k.box(CAST, [0.42, 0.03, 0.04], [MX, y + 0.035, 0]);
  k.box(CAST, [0.04, 0.03, 0.42], [MX, y + 0.035, 0]);
  k.torus(KM.seam, 0.2, 0.002, [MX, y + 0.071, 0], Z0, 40, { cast: false });
  for (const x of [EX - 0.46, EX + 0.46, MX - 0.4, MX + 0.4]) k.box(CAST, [0.04, 0.06, 1.74], [x, y - 0.03, 0]);
  // pockets on the bridge tops (cast lightening pockets)
  for (const [x, w] of [[MX, 0.6], [EX, 0.7]] as const)
    for (const z of [-0.62, 0.62]) k.box(KM.seam, [w, 0.002, 0.34], [x, y + 0.071, z], Z0, { cast: false });
  plate(k, 'tag', 'METROLOGY FRAME', 'ISOLATED · Δ T < 1 mK', 0.24, 0.06, [-0.44, y + 0.05, 0.9805]);
}

/** Measure-side sensors under the measure bridge. */
function buildSensors(k: Kit) {
  // alignment sensor: housing, objective, cable
  k.rbox(KM.paint, [0.15, 0.2, 0.15], 0.012, [MX, 1.4, 0]);
  k.rbox(KM.paintGraphite, [0.156, 0.012, 0.156], 0.004, [MX, 1.3, 0]);
  k.cyl(KM.anodizedDark, 0.035, 0.1, [MX, 1.24, 0], Z0, 24);
  k.cyl(KM.glassSmoke, 0.024, 0.004, [MX, 1.188, 0], Z0, 20, { cast: false });
  plate(k, 'tag', 'ALIGN', 'OFF-AXIS · 4 COLOURS', 0.11, 0.03, [MX, 1.42, 0.0755]);
  k.tube(KM.paintYellow, [[MX + 0.06, 1.42, -0.085], [MX + 0.1, 1.45, -0.3], [MX + 0.12, 1.47, -0.6]], 0.005, { radial: 8 });
  // level sensor: projector and detector heads, angled at the wafer
  for (const s of [-1, 1]) {
    k.box(CAST, [0.05, 0.16, 0.08], [MX + s * 0.3, 1.4, 0], Z0);
    k.rbox(KM.paint, [0.13, 0.1, 0.1], 0.01, [MX + s * 0.3, 1.32, 0], [0, 0, s * 0.5]);
    k.cyl(KM.anodizedDark, 0.022, 0.04, [MX + s * 0.27, 1.275, 0], [0, 0, s * 0.5], 16);
  }
}

/** Projection-optics internals: six multilayer mirrors on mounts, struts to the barrel wall. */
function buildOptics(k: Kit) {
  const mirrors: [number, number, number][] = [
    [1.28, 0.12, 0.25],
    [1.45, -0.14, -0.2],
    [1.6, 0.1, 0.18],
    [1.75, -0.12, -0.24],
    [1.9, 0.08, 0.22],
    [1.98, -0.06, -0.15],
  ];
  for (const [y, x, tilt] of mirrors) {
    k.at([EX + x, y, 0], [0, 0, tilt], () => {
      k.cyl(ZERODUR, 0.1, 0.026, Z0, Z0, 40);
      k.cyl(mirrorMat, 0.092, 0.004, [0, 0.0135, 0], Z0, 40, { cast: false });
      k.torus(KM.anodizedDark, 0.103, 0.008, Z0, Z0, 40);
    });
    // struts from the mount to the rear barrel wall, with wall pads
    const rw = y < 1.555 ? 0.3 : 0.36;
    for (const dx of [-0.06, 0.06]) {
      const xx = x + dx;
      const zw = -Math.sqrt(rw * rw - xx * xx);
      k.cyl(KM.anodized, 0.007, -0.09 - zw, [EX + xx, y, (zw - 0.09) / 2], RZ, 8);
      k.cyl(KM.anodizedDark, 0.016, 0.012, [EX + xx, y, zw + 0.006], RZ, 12);
    }
  }
}

/** Illuminator internals: field-facet and pupil-facet mirrors and the fold mirror. */
function buildIllumInternals(k: Kit) {
  k.at([-1.26, 2.3, 0], [0, 0, 0.75], () => {
    k.box(ZERODUR, [0.03, 0.2, 0.26], Z0);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) k.box(mirrorMat, [0.006, 0.026, 0.05], [0.017, -0.085 + i * 0.034, -0.095 + j * 0.063], Z0, { cast: false });
  });
  k.at([-0.93, 2.41, -0.16], [0.4, 0, 0], () => {
    k.cyl(KM.anodizedDark, 0.095, 0.03, Z0, Z0, 32);
    for (const [r, n] of [[0, 1], [0.035, 6], [0.07, 12]] as const)
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        k.cyl(mirrorMat, 0.013, 0.006, [Math.cos(a) * r, -0.016, Math.sin(a) * r], Z0, 10, { cast: false });
      }
  });
  k.cyl(mirrorMat, 0.08, 0.02, [-0.55, 2.3, 0], [0, 0, 0.6], 32);
  k.cyl(KM.anodizedDark, 0.085, 0.03, [-0.555, 2.297, -0.005], [0, 0, 0.6], 32);
  for (const x of [-1.26, -0.55]) k.box(KM.anodized, [0.04, 0.2, 0.04], [x, 2.2, -0.2]);
  // vessel supports down to the measure bridge
  for (const x of [-1.25, -0.65]) {
    k.rbox(CAST, [0.07, 0.52, 0.07], 0.008, [x, 1.83, -0.22]);
    k.rbox(CAST, [0.14, 0.02, 0.12], 0.005, [x, 1.56, -0.22]);
  }
}

/** Reticle-stage linear-motor tracks on posts from the lens bridge, cable carrier. */
function buildReticleStage(k: Kit) {
  for (const dx of [-0.16, 0.16]) {
    k.rbox(KM.anodizedDark, [0.07, 0.06, 1.7], 0.008, [RET_X + dx, RET_Y + 0.09, 0]);
    k.box(KM.seam, [0.05, 0.004, 1.66], [RET_X + dx, RET_Y + 0.058, 0], Z0, { cast: false });
    k.box(KM.anodized, [0.072, 0.008, 1.62], [RET_X + dx, RET_Y + 0.124, 0], Z0, { cast: false });
    for (let i = 0; i < 9; i++) k.cyl(KM.stainlessDark, 0.005, 0.004, [RET_X + dx, RET_Y + 0.13, -0.76 + i * 0.19], Z0, 6, { cast: false });
    for (const z of [-0.85, 0.85]) {
      k.rbox(KM.anodized, [0.09, 0.08, 0.05], 0.008, [RET_X + dx, RET_Y + 0.09, z]);
      k.cyl(KM.rubber, 0.014, 0.02, [RET_X + dx, RET_Y + 0.08, z - Math.sign(z) * 0.035], RZ, 12);
    }
  }
  for (const z of [-0.9, 0.9]) {
    k.rbox(CAST, [0.5, 0.08, 0.1], 0.01, [RET_X, RET_Y + 0.16, z]);
    k.rbox(CAST, [0.1, 0.84, 0.1], 0.01, [RET_X, 2.0, z]);
    k.rbox(CAST, [0.18, 0.025, 0.14], 0.006, [RET_X, 1.5925, z]);
  }
  // energy chain to the carriage
  for (let i = 0; i < 14; i++) k.rbox(KM.plastic, [0.06, 0.03, 0.05], 0.006, [RET_X + 0.27, RET_Y + 0.13, -0.78 + i * 0.054]);
  k.box(KM.anodized, [0.08, 0.006, 0.8], [RET_X + 0.27, RET_Y + 0.112, -0.42]);
}

/** Reticle library (6-slot pod rack), particle-inspection station, overhead handler axis. */
function buildReticleHandling(k: Kit) {
  const [lx, , lz] = [LIB.x, LIB.y, LIB.z];
  // rack: back, sides, top, bottom; open front towards the handler
  k.box(KM.paint, [0.5, 0.64, 0.014], [lx, 2.57, lz - 0.3]);
  for (const x of [lx - 0.25, lx + 0.25]) k.rbox(KM.paint, [0.016, 0.66, 0.52], 0.004, [x, 2.57, lz - 0.05]);
  k.rbox(KM.paintGraphite, [0.54, 0.024, 0.54], 0.006, [lx, 2.9, lz - 0.05]);
  k.rbox(KM.paintGraphite, [0.54, 0.03, 0.54], 0.006, [lx, 2.235, lz - 0.05]);
  for (let n = -2; n <= 3; n++) {
    const y = LIB.y + n * 0.095;
    for (const x of [lx - 0.235, lx + 0.235]) k.box(KM.anodized, [0.014, 0.008, 0.46], [x, y - 0.036, lz - 0.05]);
    if (n === 0) {
      // open pod: the reticle sits on the inner-pod base plate
      k.rbox(KM.anodized, [0.2, 0.012, 0.2], 0.004, [lx, y - 0.007, lz]);
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.cyl(KM.ptfe, 0.006, 0.006, [lx + x * 0.07, y - 0.002, lz + z * 0.07], Z0, 8, { cast: false });
      continue;
    }
    k.rbox(KM.plastic, [0.26, 0.066, 0.26], 0.012, [lx, y, lz]);
    k.rbox(KM.plasticWhite, [0.2, 0.012, 0.2], 0.005, [lx, y + 0.034, lz]);
    k.box(KM.plasticWhite, [0.1, 0.022, 0.002], [lx, y, lz + 0.131], Z0, { cast: false });
  }
  plate(k, 'tag', 'RETICLE LIBRARY', '6 PODS · N₂ PURGED', 0.2, 0.05, [lx, 2.88, lz + 0.211]);
  led(k, 0.16, [lx, 2.85, lz + 0.212], KM.ledGreen);
  // carousel drive on top, wall brackets behind
  k.cyl(KM.anodizedDark, 0.06, 0.08, [lx, 2.952, lz - 0.1], Z0, 24);
  for (const y of [2.32, 2.82]) {
    k.box(CAST, [0.36, 0.05, 0.2], [lx, y, lz - 0.405]);
    k.box(KM.anodizedDark, [0.42, 0.1, 0.012], [lx, y, -1.07]);
  }
  // particle-inspection station: base, pins, oblique laser, dark-field camera on an arm
  const [ix, iy, iz] = [INSP.x, INSP.y, INSP.z];
  k.rbox(KM.paint, [0.32, 0.1, 0.2], 0.012, [ix, iy - 0.11, iz + 0.04]);
  k.rbox(CAST, [0.08, 0.84, 0.08], 0.008, [ix, 1.97, iz + 0.08]);
  k.rbox(CAST, [0.16, 0.02, 0.16], 0.005, [ix, 1.56, iz + 0.08]);
  k.rbox(KM.paintGraphite, [0.3, 0.012, 0.18], 0.004, [ix, iy - 0.054, iz + 0.04]);
  for (const [x, z] of [[-0.05, 0], [0.05, 0], [0, 0.06]]) k.cyl(M.ceramic, 0.006, 0.05, [ix + x, iy - 0.026, iz + z], Z0, 8, { cast: false });
  k.rbox(KM.anodizedDark, [0.04, 0.05, 0.18], 0.006, [ix - 0.2, iy + 0.005, iz]);
  k.box(KM.ledWhite, [0.002, 0.006, 0.14], [ix - 0.179, iy - 0.002, iz], Z0, { cast: false });
  k.rbox(KM.anodized, [0.04, 0.22, 0.04], 0.006, [ix - 0.13, iy + 0.06, iz + 0.13]);
  k.rbox(KM.anodized, [0.16, 0.03, 0.03], 0.006, [ix - 0.065, iy + 0.165, iz + 0.13]);
  k.cyl(KM.anodizedDark, 0.026, 0.08, [ix, iy + 0.13, iz + 0.1], [-0.5, 0, 0], 20);
  k.cyl(KM.glassSmoke, 0.018, 0.004, [ix, iy + 0.094, iz + 0.08], [-0.5, 0, 0], 16, { cast: false });
  plate(k, 'tag', 'PARTICLE CHECK', 'DARK-FIELD · ≥ 0.5 µm', 0.14, 0.035, [ix, iy - 0.11, iz + 0.1405]);
  // overhead handler axis (aluminium profile + guide) on hangers to the back wall
  const ry = 2.74;
  k.rbox(KM.anodized, [2.2, 0.05, 0.08], 0.008, [-0.75, ry, 0.2]);
  k.box(KM.stainless, [2.16, 0.012, 0.024], [-0.75, ry - 0.031, 0.2]);
  for (let i = 0; i < 11; i++) k.box(KM.seam, [0.004, 0.044, 0.002], [-1.8 + i * 0.21, ry, 0.2405], Z0, { cast: false });
  for (const x of [-1.85, 0.35]) k.rbox(KM.anodizedDark, [0.05, 0.07, 0.1], 0.006, [x, ry, 0.2]);
  for (const x of [-1.4, 0.3]) {
    k.box(KM.anodized, [0.05, 0.05, 1.24], [x, ry + 0.05, -0.42]);
    k.box(KM.anodizedDark, [0.12, 0.12, 0.012], [x, ry + 0.05, -1.04]);
  }
  // parked handler carriage with Z axis and gripper fork
  k.rbox(KM.anodizedDark, [0.14, 0.05, 0.12], 0.008, [-0.1, ry - 0.06, 0.2]);
  k.rbox(KM.anodized, [0.05, 0.14, 0.05], 0.006, [-0.1, ry - 0.155, 0.2]);
  for (const z of [0.15, 0.25]) k.box(KM.ptfe, [0.012, 0.008, 0.1], [-0.1, ry - 0.23, z]);
  k.tube(KM.plastic, [[-0.03, ry - 0.04, 0.2], [0.1, ry - 0.02, 0.2], [0.25, ry + 0.0, 0.2]], 0.009, { radial: 8 });
}

/** Wafer handler at the track interface: base cabinet, open transfer hood, SCARA robot, pre-aligner. */
function buildWaferHandler(k: Kit) {
  const [x0, x1, z0, z1] = [1.8, 2.3, 0.15, 0.95];
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  k.rbox(KM.paint, [0.5, 0.72, 0.8], 0.014, [cx, 0.38, cz]);
  k.box(KM.paintGraphite, [0.47, 0.02, 0.77], [cx, 0.01, cz]);
  k.rbox(KM.paintGraphite, [0.51, 0.02, 0.81], 0.006, [cx, 0.745, cz]);
  grille(k, 0.3, 0.12, [cx, 0.2, z1 + 0.001], { m: KM.paint });
  plate(k, 'tag', 'WH-2 WAFER HANDLER', 'TRACK INTERFACE · 300 mm', 0.24, 0.06, [cx, 0.6, z1 + 0.0015]);
  led(k, 0.14, [cx, 0.68, z1 + 0.002], KM.ledGreen);
  // hood: corner posts, roof, glass sides (front and back stay clear of the stage path)
  for (const x of [x0 + 0.02, x1 - 0.02]) for (const z of [z0 + 0.01, z1 - 0.01]) k.box(KM.anodized, [0.03, 0.56, 0.03], [x, 1.03, z]);
  for (const z of [z0 + 0.01, z1 - 0.01]) k.rbox(KM.paintGrey, [0.52, 0.05, 0.04], 0.008, [cx, 1.335, z]);
  for (const x of [x0 + 0.01, x1 - 0.01]) k.rbox(KM.paintGrey, [0.04, 0.05, 0.8], 0.008, [x, 1.335, cz]);
  k.box(KM.glassSmoke, [0.46, 0.006, 0.74], [cx, 1.35, cz], Z0, { cast: false });
  for (const z of [z0 + 0.01, z1 - 0.01]) k.box(KM.glass, [0.44, 0.5, 0.006], [cx, 1.03, z], Z0, { cast: false });
  // SCARA robot (parked over the transfer position) and pre-aligner
  k.cyl(KM.paint, 0.06, 0.2, [1.9, 0.85, 0.27], Z0, 28);
  k.cyl(KM.anodizedDark, 0.062, 0.012, [1.9, 0.955, 0.27], Z0, 28);
  k.cyl(KM.paint, 0.04, 0.16, [1.9, 1.04, 0.27], Z0, 24);
  k.rbox(KM.paint, [0.26, 0.04, 0.07], 0.015, [2.0, 1.13, 0.33], [0, -0.55, 0]);
  k.rbox(KM.paint, [0.22, 0.035, 0.06], 0.014, [2.16, 1.12, 0.47], [0, -1.0, 0]);
  k.rbox(KM.ptfe, [0.16, 0.006, 0.05], 0.002, [2.28, 1.105, 0.55], Z0);
  k.cyl(KM.anodized, 0.045, 0.06, [1.9, 0.775, 0.8], Z0, 24);
  k.cyl(M.ceramic, 0.03, 0.01, [1.9, 0.81, 0.8], Z0, 20);
  k.rbox(KM.anodizedDark, [0.05, 0.06, 0.05], 0.006, [1.9, 0.82, 0.88]);
  k.ao(0.5, 0.8, [cx, 0, cz], 1.2);
}

/** Interior of the back wall: card cages, cable ducts, conditioned-air duct and outlets. */
function buildBackWall(k: Kit) {
  const z = -1.07;
  for (const x of [-0.95, 0.25, 1.45]) {
    k.rbox(KM.paintGrey, [0.9, 0.78, 0.05], 0.008, [x, 2.14, z]);
    for (let i = 0; i < 14; i++) k.box(i % 3 ? KM.paintGraphite : KM.anodized, [0.022, 0.62, 0.012], [x - 0.39 + i * 0.06, 2.14, z + 0.03], Z0, { cast: false });
    for (let i = 0; i < 14; i++) k.box(i % 4 ? KM.ledGreen : KM.ledAmber, [0.008, 0.008, 0.004], [x - 0.39 + i * 0.06, 2.48, z + 0.038], Z0, { cast: false });
  }
  for (const x of [-2.05, 2.25]) {
    k.rbox(KM.paintGraphite, [0.12, 2.56, 0.08], 0.01, [x, 1.54, z + 0.01]);
    for (let i = 0; i < 8; i++) k.box(KM.seam, [0.1, 0.004, 0.002], [x, 0.4 + i * 0.32, z + 0.051], Z0, { cast: false });
  }
  k.cyl(KM.anodized, 0.06, 4.2, [0.1, 1.66, -1.02], RX, 24);
  for (const x of [-1.7, 1.9]) k.cyl(KM.anodizedDark, 0.064, 0.03, [x, 1.66, -1.02], RX, 24);
  for (const x of [-0.45, 1.35]) grille(k, 0.62, 0.24, [x, 1.2, z + 0.005], { m: KM.paint });
}

/** Roof utilities (behind the cut line): electronics cabinets, exhaust duct and cable riser. */
function buildRoof(k: Kit) {
  const top = 2.922;
  for (const x of [-0.9, 1.1]) k.at([x, top, -0.62], 0, () => cabinet(k, { size: [1.4, 0.44, 0.76], body: KM.paintWarm, panels: 2, rows: [], vent: true, stripe: false, feet: false, bolts: true }));
  k.cyl(KM.stainless, 0.14, 4.4 - top, [1.95, (top + 4.4) / 2, -0.78], Z0, 32);
  for (const y of [3.3, 3.9]) k.cyl(KM.stainlessDark, 0.152, 0.03, [1.95, y, -0.78], Z0, 32);
  k.rbox(KM.paintGraphite, [0.34, 4.4 - top - 0.44, 0.1], 0.01, [-0.5, (top + 0.44 + 4.4) / 2, -0.95]);
  k.cyl(KM.anodizedDark, 0.015, 0.14, [2.2, top + 0.07, 0.9], Z0, 10);
}

/** EUV source module beside the scanner: cabinet, vacuum vessel, droplet generator, laser duct, beam tube. */
function buildSource(k: Kit) {
  const [sx, , sz] = [-3.3, 0, -0.3];
  k.at([sx, 0, sz], 0, () => {
    cabinet(k, { size: [1.2, 1.6, 1.4], body: KM.paintWarm, trim: KM.paintGraphite, panels: 2, rows: [0.55, 1.25], vent: true, handles: true, stripe: M.orangeAccent, feet: true });
    plate(k, 'model', 'SRC-250', 'EUV SOURCE · LPP · 250 W', 0.36, 0.09, [-0.24, 1.42, 0.7015]);
    plate(k, 'warn', 'LASER RADIATION', '', 0.1, 0.1, [0.42, 1.42, 0.7015]);
    plate(k, 'warn', 'HIGH VOLTAGE', '', 0.1, 0.1, [0.42, 0.95, 0.7015]);
    plate(k, 'info', 'YELLOW ROOM', 'UV-FILTERED LIGHT ONLY', 0.24, 0.06, [-0.24, 1.08, 0.7015]);
    led(k, 0.3, [0.1, 1.55, 0.702], KM.ledGreen);
    // saddles under the vessel
    for (const x of [-0.25, 0.25]) {
      k.rbox(KM.paintGraphite, [0.1, 0.09, 0.5], 0.008, [x, 1.66, 0]);
      k.box(KM.paintGraphite, [0.14, 0.012, 0.56], [x, 1.62, 0]);
    }
  });
  const vy = 1.95;
  // vessel: shell, girth flanges with bolt circles, dished head, viewports
  k.cyl(SATIN, 0.3, 0.7, [sx, vy, sz], RX, 56);
  for (const x of [sx - 0.35, sx + 0.35, sx]) {
    k.cyl(SATIN, 0.33, 0.032, [x, vy, sz], RX, 56);
    k.at([x, vy, sz], [0, 0, Math.PI / 2], () => boltCircle(k, 0.315, 20, 0.018, 0.008));
  }
  const head: [number, number][] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    head.push([0.3 * Math.cos((t * Math.PI) / 2) + 0.0001, 0.14 * Math.sin((t * Math.PI) / 2)]);
  }
  k.at([sx - 0.35, vy, sz], [0, 0, Math.PI / 2], () => k.lathe(SATIN, head, Z0, Z0, 48));
  // intermediate-focus cone towards the scanner
  k.at([sx + 0.35, vy, sz], [0, 0, -Math.PI / 2], () => k.lathe(SATIN, [[0.3, 0], [0.22, 0.06], [0.1, 0.14], [0.08, 0.16]], Z0, Z0, 48));
  k.at([sx - 0.1, vy, sz + 0.3], 0, () => viewport(k, 0.05, 0.06));
  k.at([sx + 0.18, vy - 0.12, sz + 0.27], [0.4, 0, 0], () => viewport(k, 0.035, 0.05));
  k.label('model', 'COLLECTOR VESSEL', 'H₂ · 1 mbar', 0.22, 0.055, [sx - 0.18, vy + 0.15, sz + 0.262], [-0.52, 0, 0]);
  // droplet generator on top, cooling lines
  k.cyl(KM.stainless, 0.08, 0.03, [sx - 0.15, vy + 0.305, sz], Z0, 32);
  k.cyl(KM.anodized, 0.05, 0.26, [sx - 0.15, vy + 0.45, sz], Z0, 28);
  k.rbox(KM.paintGraphite, [0.14, 0.1, 0.14], 0.01, [sx - 0.15, vy + 0.62, sz]);
  plate(k, 'tag', 'Sn DROPLETS', '50 kHz', 0.1, 0.03, [sx - 0.15, vy + 0.62, sz + 0.0705]);
  k.tube(KM.rubber, [[sx - 0.08, vy + 0.62, sz], [sx + 0.2, vy + 0.66, sz - 0.2], [sx + 0.45, 1.65, sz - 0.5]], 0.012, { radial: 8, tension: 0.4 });
  for (const [i, m] of [[0, KM.paintBlue], [1, KM.paintRed]] as const) {
    const z = sz + 0.15 + i * 0.08;
    k.tube(m, [[sx + 0.1 + i * 0.1, vy - 0.24, z + 0.05], [sx + 0.12 + i * 0.1, 1.72, z + 0.22], [sx + 0.14 + i * 0.1, 1.63, sz + 0.56]], 0.013, { radial: 8, tension: 0.4 });
  }
  // CO₂ drive-laser beam duct up from the sub-fab into the vessel head
  k.rbox(KM.paint, [0.22, vy, 0.22], 0.012, [sx - 0.6, vy / 2, sz - 0.9]);
  k.rbox(KM.paint, [0.22, 0.22, 0.9], 0.012, [sx - 0.6, vy, sz - 0.45]);
  for (const y of [0.6, 1.3]) k.box(KM.seam, [0.224, 0.004, 0.224], [sx - 0.6, y, sz - 0.9], Z0, { cast: false });
  k.cyl(KM.stainless, 0.1, 0.04, [sx - 0.5, vy, sz], RX, 32);
  k.label('warn', 'LASER BEAM DUCT', '', 0.1, 0.1, [sx - 0.6, 1.1, sz - 0.789]);
  // beam tube with bellows to the scanner's side-wall port
  along(k, [sx + 0.51, vy, sz], [-2.2, 2.25, 0], (len) => {
    k.cyl(SATIN, 0.06, len, [0, len / 2, 0], Z0, 28);
    for (const y of [0.012, len - 0.012]) k.cyl(SATIN, 0.09, 0.024, [0, y, 0], Z0, 32);
    bellows(k, 0.078, 0.18, 8, [0, len * 0.3, 0], SATIN);
    for (const y of [len * 0.3 - 0.01, len * 0.3 + 0.19]) k.cyl(SATIN, 0.088, 0.02, [0, y, 0], Z0, 32);
  });
  k.cyl(KM.stainless, 0.11, 0.03, [-2.215, 2.25, 0], RX, 32);
  k.at([-2.235, 2.25, 0], [0, 0, Math.PI / 2], () => boltCircle(k, 0.095, 8, 0, 0.007));
}

/** Monitor stand for the scan screen (local to the screen group). */
function buildScreenStand(k: Kit) {
  k.rbox(KM.paintGraphite, [0.46, 0.035, 0.38], 0.012, [0, 0.0175, 0]);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) foot(k, [x * 0.19, 0, z * 0.15]);
  k.rbox(KM.anodized, [0.075, 1.42, 0.055], 0.012, [0, 0.745, -0.03]);
  k.rbox(KM.anodizedDark, [0.1, 0.12, 0.04], 0.01, [0, 1.55, -0.05]);
  k.rbox(KM.plastic, [0.74, 0.5, 0.03], 0.012, [0, 1.55, -0.012]);
  k.rbox(KM.plastic, [0.42, 0.02, 0.2], 0.006, [0, 1.12, 0.07]);
  k.box(KM.plasticWhite, [0.36, 0.008, 0.13], [0, 1.134, 0.08], Z0, { cast: false });
  k.ao(0.46, 0.38);
}

function buildInterior(k: Kit) {
  k.ao(4.6, 2.2, [0.1, 0, 0], 1.25);
  buildBase(k);
  buildFrame(k);
  buildSensors(k);
  buildOptics(k);
  buildIllumInternals(k);
  buildReticleStage(k);
  buildReticleHandling(k);
  buildWaferHandler(k);
  buildBackWall(k);
  buildRoof(k);
  buildSource(k);
  k.at([3.0, 0, 0.1], -0.75, () => buildScreenStand(k));
}

/** Wafer stage chuck (moving; local origin = chuck top): mirror block, short-stroke table, chuck. */
function buildChuck(k: Kit) {
  k.rbox(ZERODUR, [0.52, 0.12, 0.52], 0.012, [0, -0.15, 0]);
  for (const [x, z, r] of [[0, 0.2605, 0], [0, -0.2605, 0], [0.2605, 0, Math.PI / 2], [-0.2605, 0, Math.PI / 2]] as const) k.box(KM.chrome, [0.44, 0.07, 0.002], [x, -0.15, z], [0, r, 0], { cast: false });
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    k.rbox(KM.anodizedDark, [0.05, 0.035, 0.05], 0.006, [x * 0.235, -0.0725, z * 0.235]);
    k.cyl(KM.glassSmoke, 0.008, 0.002, [x * 0.235, -0.054, z * 0.235], Z0, 10, { cast: false });
  }
  k.rbox(KM.anodized, [0.42, 0.04, 0.42], 0.008, [0, -0.07, 0]);
  k.box(KM.seam, [0.424, 0.003, 0.424], [0, -0.06, 0], Z0, { cast: false });
  k.rbox(M.ceramic, [0.4, 0.05, 0.4], 0.006, [0, -0.025, 0]);
  k.cyl(KM.paintGraphite, 0.152, 0.0015, [0, 0.0006, 0], Z0, 64, { cast: false });
  for (const [x, z] of [[-1, -1], [1, 1], [1, -1]]) {
    k.box(KM.paintGraphite, [0.04, 0.002, 0.04], [x * 0.168, 0.0008, z * 0.168], Z0, { cast: false });
    k.box(KM.chrome, [0.026, 0.0024, 0.003], [x * 0.168, 0.0009, z * 0.168], Z0, { cast: false });
    k.box(KM.chrome, [0.003, 0.0024, 0.026], [x * 0.168, 0.0009, z * 0.168], Z0, { cast: false });
  }
}

/** Reticle-stage carriage (moving): body, linear-motor movers, clamp, interferometer mirror. */
function buildCarriage(k: Kit) {
  k.rbox(KM.anodized, [0.24, 0.032, 0.3], 0.006, Z0);
  for (const s of [-1, 1]) k.rbox(KM.paintGraphite, [0.06, 0.034, 0.28], 0.006, [s * 0.15, -0.002, 0]);
  k.box(KM.chrome, [0.22, 0.024, 0.002], [0, 0, 0.151], Z0, { cast: false });
  k.box(KM.paintGraphite, [0.17, 0.006, 0.17], [0, -0.019, 0], Z0, { cast: false });
  k.box(KM.seam, [0.244, 0.003, 0.304], [0, 0.008, 0], Z0, { cast: false });
}

/** Pellicle under the reticle (pattern faces down): frame and membrane. */
function buildPellicle(k: Kit) {
  const [w, d, t, h] = [0.12, 0.142, 0.004, 0.005];
  for (const z of [-d / 2, d / 2]) k.box(KM.anodizedDark, [w + t, h, t], [0, -h / 2, z], Z0, { cast: false });
  for (const x of [-w / 2, w / 2]) k.box(KM.anodizedDark, [t, h, d], [x, -h / 2, 0], Z0, { cast: false });
  k.box(pellicleMat, [w, 0.0003, d], [0, -h, 0], Z0, { cast: false });
}

const noRay = () => {};
const PICK = new THREE.MeshBasicMaterial();

const foldClip = new WeakMap<THREE.Material, THREE.Material>();
/**
 * Shell swap that also works on folded parts: the clipped clone keeps the fold shader
 * (Material.copy drops onBeforeCompile), so per-vertex finishes survive the cut-away.
 */
function shellOf(m: THREE.Material, view: ViewMode): THREE.Material {
  if ((view !== 'cutaway' && view !== 'section') || !m.vertexColors) return shell(m, view);
  let c = foldClip.get(m);
  if (!c) {
    c = m.clone();
    c.onBeforeCompile = m.onBeforeCompile;
    c.customProgramCacheKey = m.customProgramCacheKey;
    c.clippingPlanes = [cutPlane];
    c.side = THREE.DoubleSide;
    foldClip.set(m, c);
  }
  return c;
}

/**
 * Static kit meshes without raycasting (selection goes through the pick proxies).
 * `asShell` treats every part as shell (folded enclosure); `cast` toggles its shadow caster.
 */
function Static({ parts, view = 'normal', asShell = false, cast = true }: { parts: BakedPart[]; view?: ViewMode; asShell?: boolean; cast?: boolean }) {
  const caster = useMemo(() => {
    const g = casterGeometry(parts.filter((p) => p.cast).map((p) => p.geometry));
    return g ? shadowOnly(g) : null;
  }, [parts]);
  useEffect(() => () => caster?.geometry.dispose(), [caster]);
  return (
    <>
      {parts.map((p, i) => (
        <mesh key={i} geometry={p.geometry} material={asShell || p.shell ? shellOf(p.material, view) : p.material} receiveShadow raycast={noRay} />
      ))}
      {caster && cast && <primitive object={caster} />}
    </>
  );
}

/** Invisible pick proxy (box), never drawn, still raycast. */
function Pick({ p, s }: { p: V3; s: V3 }) {
  return <mesh geometry={GEO.box} position={p} scale={s} material={PICK} visible={false} />;
}

function ScannerBody() {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  // the scanner is a closed box: the machine view looks inside it (cut-away) as well
  const view = effectiveView(viewRaw, cam === 'machine' ? 'internal' : cam);
  const closed = view === 'normal';
  const enclosure = useFolded(buildEnclosure);
  const interior = useFolded(buildInterior);
  return (
    <Clickable sel={{ kind: 'machine', id: 'scanner', label: 'Lithography scanner' }}>
      {/* the enclosure's shadow is dropped while it is cut open, so the interior stays lit */}
      <Static parts={enclosure} view={view} asShell cast={closed} />
      <Static parts={interior} />
      {/* enclosure picks: the whole box when closed, the remaining back half when cut open */}
      {closed ? <Pick p={[0.1, 1.46, 0]} s={[4.6, 2.92, 2.2]} /> : (
        <>
          <Pick p={[0.1, 1.46, -1.08]} s={[4.6, 2.92, 0.06]} />
          <Pick p={[0.1, 2.9, -0.55]} s={[4.6, 0.05, 1.1]} />
          <Pick p={[-2.18, 1.46, -0.55]} s={[0.05, 2.92, 1.1]} />
          <Pick p={[2.38, 1.46, -0.55]} s={[0.05, 2.92, 1.1]} />
        </>
      )}
      <Pick p={[-0.1, 0.38, 0]} s={[3.75, 0.76, 1.84]} />
      <Pick p={[0.1, 3.14, -0.62]} s={[3.4, 0.44, 0.76]} />
      {/* metrology frame */}
      <Clickable sel={{ kind: 'component', id: 'frame', machine: 'scanner', label: 'Metrology frame' }}>
        {[-0.92, 0.92].map((z) => <Pick key={z} p={[-0.44, 1.53, z]} s={[2.44, 0.1, 0.12]} />)}
        {[-1.6, 0.72].map((x) => <Pick key={x} p={[x, 1.53, 0]} s={[0.12, 0.1, 1.96]} />)}
        <Pick p={[EX, 1.515, 0.6]} s={[0.96, 0.07, 0.56]} />
        <Pick p={[EX, 1.515, -0.6]} s={[0.96, 0.07, 0.56]} />
        <Pick p={[MX, 1.515, 0]} s={[0.84, 0.07, 1.76]} />
        {[-1.6, 0.72].map((x) => [-0.92, 0.92].map((z) => <Pick key={`${x}${z}`} p={[x, 0.86, z]} s={[0.12, 1.2, 0.12]} />))}
      </Clickable>
      {/* measure-side sensors */}
      <Clickable sel={{ kind: 'component', id: 'alignment', machine: 'scanner', label: 'Alignment sensor' }}>
        <Pick p={[MX, 1.33, 0]} s={[0.18, 0.3, 0.18]} />
      </Clickable>
      <Clickable sel={{ kind: 'component', id: 'level', machine: 'scanner', label: 'Level sensor' }}>
        <Pick p={[MX - 0.3, 1.36, 0]} s={[0.14, 0.2, 0.11]} />
        <Pick p={[MX + 0.3, 1.36, 0]} s={[0.14, 0.2, 0.11]} />
      </Clickable>
      {/* projection optics (mirror column) */}
      <Clickable sel={{ kind: 'component', id: 'projection', machine: 'scanner', label: 'Projection optics' }}>
        <Pick p={[EX, 1.6, 0]} s={[0.8, 0.94, 0.8]} />
      </Clickable>
      {/* illuminator */}
      <Clickable sel={{ kind: 'component', id: 'illuminator', machine: 'scanner', label: 'Illuminator' }}>
        <Pick p={[-0.95, 2.31, 0]} s={[0.87, 0.47, 0.57]} />
        <Pick p={[-1.79, 2.275, 0]} s={[0.82, 0.2, 0.2]} />
      </Clickable>
      {/* reticle stage tracks */}
      <Clickable sel={{ kind: 'component', id: 'reticle-stage', machine: 'scanner', label: 'Reticle stage' }}>
        {[-0.16, 0.16].map((dx) => <Pick key={dx} p={[RET_X + dx, RET_Y + 0.09, 0]} s={[0.09, 0.08, 1.75]} />)}
        {[-0.9, 0.9].map((z) => <Pick key={z} p={[RET_X, 2.0, z]} s={[0.5, 0.95, 0.1]} />)}
      </Clickable>
      {/* reticle library + inspection + handler */}
      <Clickable sel={{ kind: 'component', id: 'reticle-handler', machine: 'scanner', label: 'Reticle library & handler' }}>
        <Pick p={[LIB.x, 2.57, LIB.z - 0.05]} s={[0.54, 0.7, 0.54]} />
        <Pick p={[INSP.x, INSP.y - 0.11, INSP.z + 0.04]} s={[0.32, 0.12, 0.2]} />
        <Pick p={[-0.75, 2.74, 0.2]} s={[2.2, 0.08, 0.1]} />
      </Clickable>
      {/* wafer handler at the track interface */}
      <Clickable sel={{ kind: 'component', id: 'wafer-handler', machine: 'scanner', label: 'Wafer handler (track interface)' }}>
        <Pick p={[2.05, 0.38, 0.55]} s={[0.5, 0.76, 0.8]} />
        <Pick p={[2.05, 1.335, 0.55]} s={[0.52, 0.05, 0.82]} />
      </Clickable>
      <SignalTower position={[2.2, 3.06, 0.9]} />
      {/* EUV source module outside the scanner body */}
      <Clickable sel={{ kind: 'component', id: 'source', machine: 'scanner', label: 'Light source (EUV, laser-produced plasma)' }}>
        <Pick p={[-3.3, 0.81, -0.3]} s={[1.2, 1.62, 1.4]} />
        <Pick p={[-3.25, 1.98, -0.3]} s={[1.2, 0.72, 0.66]} />
        <Pick p={[-3.9, 0.98, -1.2]} s={[0.24, 1.98, 0.24]} />
        <Pick p={[-3.9, 1.95, -0.75]} s={[0.24, 0.24, 0.92]} />
        <Pick p={[-2.5, 2.1, -0.15]} s={[0.7, 0.2, 0.4]} />
      </Clickable>
    </Clickable>
  );
}

/* ---------------------------------------------------------------- light path */

const BEAM: V3[] = [
  [-3.0, 1.95, -0.3],
  [-2.3, 2.2, -0.05],
  [-1.35, 2.3, 0],
  [-0.55, 2.3, 0],
  [RET_X - 0.02, RET_Y - 0.01, 0],
  [EX + 0.12, 2.0, 0],
  [EX - 0.1, 1.7, 0],
  [EX + 0.08, 1.4, 0],
  [EX, 1.15, 0],
];

function LightPath() {
  const group = useRef<THREE.Group>(null);
  const cone = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const on = engine.tele.value('dose', 0) > 1 && scanState().scanning;
    if (group.current) group.current.visible = on;
    beamMat.opacity = 0.25 + 0.12 * Math.sin(engine.time * 22);
    if (cone.current) cone.current.visible = on;
  });
  return (
    <group>
      <group ref={group}>
        <Tube points={BEAM} radius={0.018} m={beamMat} segments={160} />
        <FlowLine points={BEAM} color="#e3d0ff" speed={1.4} />
      </group>
      <mesh ref={cone} position={[EX, (1.15 + WY) / 2, 0]} material={beamMat}>
        <cylinderGeometry args={[0.07, 0.013, 1.15 - WY, 24, 1, true]} />
      </mesh>
    </group>
  );
}

/* ---------------------------------------------------------------- reticle */

function Reticle({ variant }: { variant: Variant }) {
  const group = useRef<THREE.Group>(null);
  const carriage = useRef<THREE.Group>(null);
  const laser = useRef<THREE.Mesh>(null);
  const tex = useMemo(() => reticleTexture(), []);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ map: tex, roughness: 0.2, metalness: 0.4 }), [tex]);
  const carriageParts = useFolded(buildCarriage);
  const pellicle = useFolded(buildPellicle);
  useFrame(() => {
    const p = reticlePos(variant);
    if (group.current) group.current.position.copy(p);
    if (carriage.current) carriage.current.position.z = variant === 'expose' ? p.z : 0;
    if (variant === 'reticle') track('focus', p.x, p.y, p.z);
    if (laser.current) {
      const on = variant === 'reticle' && inPhase('inspect');
      laser.current.visible = on;
      laser.current.position.set(INSP.x, INSP.y - 0.003, INSP.z + lerp(-0.07, 0.07, fract(engine.player.view.phaseT * 2)));
    }
  });
  return (
    <>
      <group ref={carriage} position={[RET_X, RET_Y + 0.045, 0]}>
        <Baked parts={carriageParts} />
      </group>
      <group ref={group}>
        <Clickable sel={{ kind: 'component', id: 'reticle-stage', machine: 'scanner', label: 'Reticle (mask)' }}>
          <mesh rotation={[Math.PI / 2, 0, 0]} material={mat}>
            <planeGeometry args={[0.152, 0.152]} />
          </mesh>
          <B s={[0.152, 0.0064, 0.152]} m={M.quartz} position={[0, 0.0034, 0]} shadow={false} />
          <Baked parts={pellicle} />
        </Clickable>
      </group>
      <mesh ref={laser} material={slitMat}>
        <boxGeometry args={[0.16, 0.001, 0.002]} />
      </mesh>
    </>
  );
}

/* ---------------------------------------------------------------- wafer + stages */

function useWaferCanvas(variant: Variant) {
  return useMemo(() => {
    const size = 512;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    let last = '';
    const heat = (x: number, y: number) => 0.5 + 0.25 * Math.sin(x * 7 + 1) * Math.cos(y * 5) + 0.25 * Math.sin((x + y) * 11);
    const draw = (key: string, fn: () => void) => {
      if (key === last) return;
      last = key;
      fn();
      tex.needsUpdate = true;
    };
    const update = () => {
      const v = engine.player.view;
      if (variant === 'expose') {
        const n = scanState().exposed;
        draw(`e${n}`, () => drawWafer(g, size, 'exposed', { exposed: n, tint: '#8f5a33' }));
        return;
      }
      // align: resist-coated wafer; height map revealed by the level-sensor sweep
      const rows = v.phaseId === 'level' ? Math.floor(v.phaseT * 32) : pp('level') >= 1 ? 32 : 0;
      draw(`a${rows}`, () => {
        g.fillStyle = '#8f5a33';
        g.fillRect(0, 0, size, size);
        const cell = size / 32;
        for (let j = 0; j < rows; j++)
          for (let i = 0; i < 32; i++) {
            const h = heat(i / 32, j / 32);
            g.fillStyle = `rgba(${Math.round(120 + 110 * h)},${Math.round(170 + 50 * (1 - h))},${Math.round(90 + 40 * h)},0.55)`;
            g.fillRect(i * cell, j * cell, cell + 0.5, cell + 0.5);
          }
      });
    };
    update();
    return { tex, update };
  }, [variant]);
}

function Stages({ variant }: { variant: Variant }) {
  const chuckA = useRef<THREE.Group>(null);
  const chuckB = useRef<THREE.Group>(null);
  const wafer = useRef<THREE.Group>(null);
  const slit = useRef<THREE.Mesh>(null);
  const marks = useRef<THREE.InstancedMesh>(null);
  const marksOn = useRef<THREE.InstancedMesh>(null);
  const arrows = useRef<THREE.InstancedMesh>(null);
  const level = useRef<THREE.Mesh>(null);
  const canvas = useWaferCanvas(variant);
  const topMat = useMemo(() => new THREE.MeshStandardMaterial({ map: canvas.tex, roughness: 0.25, metalness: 0.15 }), [canvas]);
  const waferMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.1, metalness: 0.9 }), []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const chuck = useFolded(buildChuck);
  useFrame(() => {
    const p = waferPos(variant);
    if (wafer.current) {
      wafer.current.position.copy(p);
      wafer.current.visible = variant !== 'reticle';
    }
    if (variant !== 'reticle') track('focus', p.x, p.y, p.z);
    // chuck A carries our wafer; chuck B mirrors it across the swap
    if (chuckA.current) chuckA.current.position.set(variant === 'reticle' ? MX : p.x, WY - 0.004, variant === 'reticle' ? 0 : p.z);
    if (chuckB.current) {
      const sw = variant === 'expose' ? smooth(pp('swap')) : 0;
      const c = (MX + EX) / 2;
      const r = (EX - MX) / 2;
      chuckB.current.position.set(variant === 'align' || variant === 'reticle' ? EX : c + r * Math.cos(Math.PI * sw), WY - 0.004, variant === 'expose' ? Math.sin(Math.PI * sw) * 0.55 : 0);
    }
    canvas.update();
    const s = scanState();
    if (slit.current) {
      slit.current.visible = variant === 'expose' && s.scanning;
      slit.current.position.set(EX, WY + 0.0012, 0);
    }
    // alignment marks + overlay vectors (wafer-local)
    const v = engine.player.view;
    const measured = variant === 'align' ? engine.tele.value('marks', 0) : 0;
    const showVec = variant === 'align' && (v.phaseId === 'correct');
    const ovx = engine.tele.value('ovx', 0);
    const ovy = engine.tele.value('ovy', 0);
    MARKS.forEach(([mx, mz], i) => {
      const on = i < measured;
      o.position.set(mx, 0.0012, mz);
      o.rotation.set(0, 0, 0);
      o.scale.set(variant === 'align' ? 0.008 : 0, 0.0006, 0.008);
      o.updateMatrix();
      (on ? marksOn.current : marks.current)?.setMatrixAt(i, o.matrix);
      (on ? marks.current : marksOn.current)?.setMatrixAt(i, HIDE);
      if (arrows.current) {
        // translation + small wafer-scale rotation / expansion residual (nm)
        const vx = ovx - 6 * mz + 4 * mx;
        const vz = ovy + 6 * mx + 4 * mz;
        const len = Math.hypot(vx, vz) * 0.0035;
        if (!showVec || len < 1e-4) arrows.current.setMatrixAt(i, HIDE);
        else {
          o.position.set(mx + (vx * 0.0035) / 2, 0.0016, mz + (vz * 0.0035) / 2);
          o.rotation.set(0, -Math.atan2(vz, vx), 0);
          o.scale.set(len, 0.0008, 0.0025);
          o.updateMatrix();
          arrows.current.setMatrixAt(i, o.matrix);
        }
      }
    });
    for (const m of [marks.current, marksOn.current, arrows.current]) if (m) m.instanceMatrix.needsUpdate = true;
    if (level.current) {
      const on = variant === 'align' && v.phaseId === 'level';
      level.current.visible = on;
      level.current.position.set(0, 0.002, lerp(-0.15, 0.15, v.phaseT));
    }
  });
  return (
    <group>
      <Clickable sel={{ kind: 'component', id: 'wafer-stage', machine: 'scanner', label: 'Wafer stage (chuck A)' }}>
        <group ref={chuckA}>
          <Baked parts={chuck} />
        </group>
      </Clickable>
      <Clickable sel={{ kind: 'component', id: 'measure-stage', machine: 'scanner', label: 'Wafer stage (chuck B)' }}>
        <group ref={chuckB}>
          <Baked parts={chuck} />
          <mesh position={[0, 0.006, 0]} geometry={waferGeometry()} material={waferMat} />
        </group>
      </Clickable>
      <group ref={wafer}>
        <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184' }}>
          <mesh geometry={waferGeometry()} material={waferMat} castShadow />
          <mesh position={[0, 0.0005, 0]} rotation={[-Math.PI / 2, 0, 0]} material={topMat}>
            <circleGeometry args={[0.149, 64]} />
          </mesh>
          <instancedMesh ref={marks} args={[GEO.box, markDim, MARKS.length]} frustumCulled={false} />
          <instancedMesh ref={marksOn} args={[GEO.box, markMat, MARKS.length]} frustumCulled={false} />
          <instancedMesh ref={arrows} args={[GEO.box, arrowMat, MARKS.length]} frustumCulled={false} />
          <mesh ref={level} material={levelMat}>
            <boxGeometry args={[0.3, 0.0008, 0.004]} />
          </mesh>
        </Clickable>
      </group>
      <mesh ref={slit} material={slitMat}>
        <boxGeometry args={[FIELD_W / 1000, 0.0006, 0.0025]} />
      </mesh>
      <TechLabel position={[EX + 0.35, 1.05, 0.25]} title="EXPOSURE SLIT" min={3} show={() => variant === 'expose'} />
    </group>
  );
}

/* ---------------------------------------------------------------- insets */

const subMat = new THREE.MeshStandardMaterial({ color: '#7a828c', roughness: 0.45, metalness: 0.6 });
const resistMat = new THREE.MeshPhysicalMaterial({ color: '#b5612a', roughness: 0.3, transparent: true, opacity: 0.92 });
const exposedMat = new THREE.MeshPhysicalMaterial({ color: '#dd9a52', roughness: 0.3, transparent: true, opacity: 0.92 });
const acidMat = new THREE.MeshBasicMaterial({ color: '#f4e6a6', toneMapped: false });

/** Latent image: exposed regions of the resist are chemically changed (photo-acid). */
function LatentInset() {
  const H = 0.3;
  const spaces = [-0.36, -0.12, 0.12, 0.36];
  const w = 0.12;
  const acid = useRef<THREE.InstancedMesh>(null);
  const seeds = useMemo(() => {
    const r = rng(17);
    return Array.from({ length: 120 }, (_, i) => ({ c: spaces[i % 4], x: (r() - 0.5) * w * 0.9, y: r() * H * 0.95, ph: r() * 6 }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const o = useMemo(() => new THREE.Object3D(), []);
  const t = useRef(0);
  const lines = useMemo(() => {
    const edges = [-0.55, ...spaces.flatMap((c) => [c - w / 2, c + w / 2]), 0.55];
    const out: [number, number][][] = [];
    for (let i = 0; i < edges.length; i += 2) out.push(rect(edges[i], 0, edges[i + 1], H));
    return out;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const aerial = useMemo(() => Array.from({ length: 111 }, (_, i) => {
    const x = -0.55 + i * 0.01;
    const I = Math.pow(Math.cos(((x - 0.12) / 0.48) * Math.PI * 2), 2);
    return [x, H + 0.06 + 0.16 * I, 0.08] as V3;
  }), []);
  useFrame((_, dt) => {
    t.current += pdt(dt);
    if (!acid.current) return;
    const k = engine.player.view.phaseId === 'zoom' || pp('zoom') >= 1 ? 1 : clamp(engine.tele.value('fields', 0) / N_FIELDS);
    seeds.forEach((s, i) => {
      o.position.set(s.c + s.x + 0.004 * Math.sin(t.current * 4 + s.ph), s.y, 0.075);
      o.scale.setScalar(i / seeds.length < k ? 0.008 : 0);
      o.updateMatrix();
      acid.current!.setMatrixAt(i, o.matrix);
    });
    acid.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <Inset id="latent-section" position={[2.9, 1.5, 1.45]} size={[1.3, 0.85]} mpu={110e-9 / H} schematic={false} title="LATENT IMAGE · RESIST CROSS-SECTION">
      <group position={[0, -0.2, 0]}>
        <ProfileSlab points={rect(-0.55, -0.16, 0.55, 0)} depth={0.14} m={subMat} />
        {lines.map((p, i) => (
          <ProfileSlab key={i} points={p} depth={0.14} m={resistMat} />
        ))}
        {spaces.map((c) => (
          <ProfileSlab key={c} points={rect(c - w / 2, 0, c + w / 2, H)} depth={0.14} m={exposedMat} />
        ))}
        <instancedMesh ref={acid} args={[GEO.sphereLow, acidMat, 120]} frustumCulled={false} />
        <Line points={aerial} color="#d6b8ff" lineWidth={1.5} />
      </group>
      <TechLabel position={[-0.6, 0.36, 0.05]} title="AERIAL IMAGE (LIGHT INTENSITY)" min={2} />
      <TechLabel position={[0.15, -0.34, 0.05]} title="EXPOSED → PHOTO-ACID · NEXT: DEVELOP" min={3} />
    </Inset>
  );
}

/** Box-in-box overlay target; the inner (current layer) box moves with the measured overlay. */
function OverlayInset() {
  const inner = useRef<THREE.Group>(null);
  const K = 0.009; // inset units per nm (offset magnified)
  useFrame(() => {
    if (inner.current) inner.current.position.set(engine.tele.value('ovx', 0) * K, engine.tele.value('ovy', 0) * K, 0.01);
  });
  const frame = (s: number, t: number, m: THREE.Material) => (
    <>
      <B s={[s, t, 0.03]} m={m} position={[0, s / 2 - t / 2, 0]} />
      <B s={[s, t, 0.03]} m={m} position={[0, -s / 2 + t / 2, 0]} />
      <B s={[t, s, 0.03]} m={m} position={[s / 2 - t / 2, 0, 0]} />
      <B s={[t, s, 0.03]} m={m} position={[-s / 2 + t / 2, 0, 0]} />
    </>
  );
  return (
    <Inset id="overlay-target" position={[2.9, 1.5, 1.45]} size={[1.3, 0.85]} mpu={30e-6 / 1.3} title="OVERLAY TARGET · OFFSET MAGNIFIED">
      <group position={[-0.2, -0.02, 0]}>
        {frame(0.6, 0.07, M.greenAccent)}
        <group ref={inner}>{frame(0.3, 0.05, resistMat)}</group>
      </group>
      <TechLabel position={[0.15, 0.3, 0.05]} title="OVERLAY (X / Y)" min={2} value={() => `${engine.tele.value('ovx', 0).toFixed(1)} / ${engine.tele.value('ovy', 0).toFixed(1)} nm`} />
      <TechLabel
        position={[0.15, 0.05, 0.05]}
        title="VERDICT"
        min={2}
        tone="accent"
        value={() => {
          const m = Math.max(Math.abs(engine.tele.value('ovx', 0)), Math.abs(engine.tele.value('ovy', 0)));
          return m > 6 ? 'OUT OF SPEC → REWORK: strip resist, re-coat, re-expose' : m > 3 ? 'MARGINAL → corrections applied, monitor' : 'IN SPEC → expose';
        }}
      />
      <TechLabel position={[0.15, -0.2, 0.05]} title="OUTER: PREVIOUS LAYER · INNER: THIS LAYER" min={3} />
    </Inset>
  );
}

/** The reticle magnified: one layer of the chip, 4× larger than on the wafer. */
function ReticleInset() {
  const tex = useMemo(() => reticleTexture(), []);
  const scan = useRef<THREE.Mesh>(null);
  useFrame(() => {
    if (scan.current) {
      scan.current.visible = inPhase('inspect');
      scan.current.position.y = lerp(0.42, -0.42, fract(engine.player.view.phaseT * 2));
    }
  });
  return (
    <Inset id="reticle-mag" position={[-2.85, 2.75, 0.9]} size={[1.2, 0.95]} mpu={0.152 / 0.84} title="RETICLE · PATTERN ×4">
      <mesh>
        <planeGeometry args={[0.84, 0.84]} />
        <meshStandardMaterial map={tex} roughness={0.3} metalness={0.3} />
      </mesh>
      <mesh ref={scan} position={[0, 0, 0.01]}>
        <boxGeometry args={[0.9, 0.006, 0.002]} />
        <meshBasicMaterial color="#9fd18a" toneMapped={false} />
      </mesh>
      <TechLabel position={[0.44, 0.38, 0.02]} title="152 mm QUARTZ PLATE" lines={['EUV: absorber on a multilayer mirror', 'DUV: chrome on quartz']} min={2} />
      <TechLabel position={[0.44, 0.0, 0.02]} title="PARTICLE CHECK" min={2} value={() => `${engine.tele.value('rpart', 0).toFixed(0)} particles ≥ 0.5 µm · SIMULATED`} />
    </Inset>
  );
}

/* ---------------------------------------------------------------- screen */

function ScanScreen({ variant }: { variant: Variant }) {
  return (
    <group position={[3.0, 0, 0.1]} rotation={[0, -0.75, 0]}>
      <Screen
        size={[0.66, 0.42]}
        position={[0, 1.55, 0.03]}
        hz={5}
        draw={(g, w, h) => {
          if (variant === 'align') {
            clear(g, w, h, 'OVERLAY · ALIGNMENT · SIMULATED');
            const ovx = engine.tele.value('ovx', 0);
            const ovy = engine.tele.value('ovy', 0);
            const bad = Math.max(Math.abs(ovx), Math.abs(ovy));
            bigNumber(g, 'X', ovx.toFixed(1), 'nm', w * 0.06, h * 0.22, h * 0.11, bad > 6 ? SCR.crit : bad > 3 ? SCR.warn : SCR.text);
            bigNumber(g, 'Y', ovy.toFixed(1), 'nm', w * 0.4, h * 0.22, h * 0.11, bad > 6 ? SCR.crit : bad > 3 ? SCR.warn : SCR.text);
            bigNumber(g, 'MARKS', engine.tele.value('marks', 0).toFixed(0), '/ 24', w * 0.72, h * 0.22, h * 0.11);
            const c = engine.tele.get('ovx');
            plot(g, c ? c.series().slice(-160) : [], w * 0.06, h * 0.5, w * 0.88, h * 0.4, -12, 12, SCR.data);
            return;
          }
          if (variant === 'reticle') {
            clear(g, w, h, 'RETICLE HANDLING · SIMULATED');
            bigNumber(g, 'TEMP', engine.tele.value('rtemp', 22).toFixed(3), '°C', w * 0.06, h * 0.25, h * 0.11);
            bigNumber(g, 'ALIGN ERR', engine.tele.value('ralign', 0).toFixed(1), 'nm', w * 0.5, h * 0.25, h * 0.11);
            const c = engine.tele.get('ralign');
            plot(g, c ? c.series().slice(-160) : [], w * 0.06, h * 0.55, w * 0.88, h * 0.35, 0, 160, SCR.data);
            return;
          }
          clear(g, w, h, 'STEP & SCAN · SIMULATED');
          bigNumber(g, 'FIELDS', engine.tele.value('fields', 0).toFixed(0), `/ ${N_FIELDS}`, w * 0.06, h * 0.22, h * 0.11);
          bigNumber(g, 'DOSE', engine.tele.value('dose', 0).toFixed(1), 'mJ/cm²', w * 0.5, h * 0.22, h * 0.11);
          const c = engine.tele.get('vel');
          plot(g, c ? c.series().slice(-160) : [], w * 0.06, h * 0.52, w * 0.88, h * 0.38, 0, 600, SCR.data);
        }}
      />
    </group>
  );
}

/* ---------------------------------------------------------------- scene */

export default function LithographyScene({ stage }: SceneProps) {
  const variant = ((stage.variant as Variant) ?? 'expose') as Variant;
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.02;
  }, []);
  return (
    <>
      <Lighting env="litho" shadowExtent={7} />
      <CleanroomBay width={13} depth={9} height={4.4} amber />
      <ScannerBody />
      <LightPath />
      <Reticle variant={variant} />
      <Stages variant={variant} />
      <SensorIndicator id="interferometer" channel={variant === 'expose' ? 'vel' : undefined} machine="scanner" position={[EX + 0.45, 0.9, 0.5]} size={0.04} />
      <SensorIndicator id="level-sensor" channel={variant === 'align' ? 'focus' : undefined} machine="scanner" position={[MX - 0.3, 1.42, 0.08]} size={0.035} />
      <SensorIndicator id="alignment-sensor" channel={variant === 'align' ? 'marks' : undefined} machine="scanner" position={[MX + 0.1, 1.5, 0.1]} size={0.035} />
      <SensorIndicator id="dose-sensor" channel={variant === 'expose' ? 'dose' : undefined} machine="scanner" position={[EX + 0.3, 1.0, -0.25]} size={0.035} />
      {variant === 'expose' && <LatentInset />}
      {variant === 'align' && <OverlayInset />}
      {variant === 'reticle' && <ReticleInset />}
      <ScanScreen variant={variant} />
      <TechLabel position={[EX + 0.4, 1.9, 0.3]} title="PROJECTION OPTICS · 4× REDUCTION" min={2} />
      <TechLabel position={[-0.95, 2.6, 0.3]} title="ILLUMINATOR" min={3} />
      <TechLabel position={[RET_X + 0.2, 2.55, 0.3]} title="RETICLE STAGE" min={2} value={() => (variant === 'expose' ? `scan ${(Math.abs(reticlePos(variant).z) * 1000).toFixed(0)} mm · 4× wafer speed` : engine.player.view.phase.label)} />
      <TechLabel position={[MX - 0.3, 1.7, 0.3]} title="MEASURE SIDE" lines={['level + alignment sensors']} min={2} />
      <TechLabel position={[-3.3, 1.25, 0.45]} title="EUV SOURCE · GENERIC" lines={['13.5 nm light — invisible, shown in false colour', 'travels in vacuum']} min={2} />
      <Operator position={[-1.4, 0, 1.75]} rotation={Math.PI} still />
    </>
  );
}
