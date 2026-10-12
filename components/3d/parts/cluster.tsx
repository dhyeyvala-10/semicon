'use client';
/**
 * Generic single-wafer cluster tool (deposition, etch, strip): EFEM with load ports,
 * load locks, octagonal vacuum transfer chamber with a vacuum robot, two closed process
 * chambers and one detailed, cut-away active chamber at +X.
 *
 * Static equipment is built procedurally with the detailing kit and folded into a few
 * draw calls per sub-assembly; only the robot, slit valve and wafer are live meshes.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { M, effectiveView } from '../materials';
import { C } from './primitives';
import { Clickable, SignalTower, TechLabel } from './interaction';
import { FOUP, waferGeometry } from './wafer';
import { useUI } from '@/lib/store';
import { engine } from '@/simulation/engine';
import { pp } from '@/lib/anim';
import { track } from '@/lib/runtime';
import { smooth, clamp } from '@/lib/math';
import { Kit, cabinet, foot, boltCircle, viewport, bellows, grille, windowPane, hmi, estop, ledStrip, hose, gasStick, type V3, type PartOpts, type BakedPart } from '../kit/build';
import { KM, labelMaterial } from '../kit/finish';
import { Baked, useKit } from '../kit/Baked';

export const CHAMBER = { x: 1.3, y0: 0.72, y1: 1.36, r: 0.5, waferY: 1.045 };
const LL = new THREE.Vector3(-1.35, 1.0, 0.35);
const TC = new THREE.Vector3(0, 1.0, 0);
const PM = new THREE.Vector3(CHAMBER.x, CHAMBER.waferY, 0);

/** Wafer position along LL → TC → PM for a 0..1 transfer progress. */
export function transferPos(u: number): THREE.Vector3 {
  const k = clamp(u);
  if (k < 0.5) return LL.clone().lerp(TC, smooth(k * 2));
  return TC.clone().lerp(PM, smooth((k - 0.5) * 2));
}

/** 0 = in load lock, 1 = on chamber pedestal — derived from the stage phases. */
export function transferProgress(): number {
  const ids = engine.stage.phases.map((p) => p.id);
  const loadId = ids[0];
  const outId = ids[ids.length - 1];
  const inP = pp(loadId);
  const outP = pp(outId);
  if (outP > 0) return 1 - outP;
  return inP;
}

/* ======================================================================
   Folding: a finished model in a handful of draw calls.
   Every opaque, non-emissive, non-shell finish is merged into one mesh whose vertices
   carry the finish (colour, roughness, metalness, micro-surface map, bump); every label
   plate is packed into one canvas atlas. Shell parts keep their own materials so the
   x-ray / cut-away swap still works; glass, LEDs, screens and contact shadows keep theirs.
   ====================================================================== */

type Std = THREE.MeshStandardMaterial;
const isStd = (m: THREE.Material): m is Std => (m as Std).isMeshStandardMaterial === true;
const foldable = (m: THREE.Material) => isStd(m) && !(m as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial && !m.transparent && !m.map && m.toneMapped && m.emissive.getHex() === 0 && !m.vertexColors;
const isLabel = (m: THREE.Material) => isStd(m) && m.map?.image instanceof HTMLCanvasElement && m.polygonOffset && !m.transparent;

let _fold: Std | null = null;
function foldMaterial(): Std {
  if (_fold) return _fold;
  const paintTex = KM.paint.roughnessMap;
  const brushTex = KM.stainless.roughnessMap;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1, roughnessMap: paintTex, bumpMap: paintTex, bumpScale: 1 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.kitBrush = { value: brushTex };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 kitRM;\nvarying vec4 vKitRM;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvKitRM = kitRM;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vKitRM;\nuniform sampler2D kitBrush;')
      .replace('#include <bumpmap_pars_fragment>', THREE.ShaderChunk.bumpmap_pars_fragment.replace('uniform float bumpScale;', 'float bumpScale;'))
      .replace('void main() {', 'void main() {\n\tbumpScale = vKitRM.w;')
      .replace(
        '#include <roughnessmap_fragment>',
        [
          'float kitP = texture2D( roughnessMap, vRoughnessMapUv ).g;',
          'float kitB = texture2D( kitBrush, vRoughnessMapUv ).g;',
          'float roughnessFactor = vKitRM.x * ( vKitRM.z > 1.5 ? kitB : ( vKitRM.z > 0.5 ? kitP : 1.0 ) );',
        ].join('\n'),
      )
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vKitRM.y;');
  };
  // same program key as the other folded models: one shader program for all of them
  m.customProgramCacheKey = () => 'kit-fold-1';
  _fold = m;
  return m;
}

function tagFinish(g: THREE.BufferGeometry, m: Std) {
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  const rm = new Float32Array(n * 4);
  const mode = !m.roughnessMap ? 0 : m.roughnessMap === KM.stainless.roughnessMap ? 2 : 1;
  const bump = m.bumpMap ? m.bumpScale : 0;
  for (let i = 0; i < n; i++) {
    col[i * 3] = m.color.r;
    col[i * 3 + 1] = m.color.g;
    col[i * 3 + 2] = m.color.b;
    rm[i * 4] = m.roughness;
    rm[i * 4 + 1] = m.metalness;
    rm[i * 4 + 2] = mode;
    rm[i * 4 + 3] = bump;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('kitRM', new THREE.BufferAttribute(rm, 4));
}

function atlasLabels(list: BakedPart[]): BakedPart | null {
  const W = 512;
  const GAP = 8;
  const slots = new Map<THREE.Material, { im: HTMLCanvasElement; y: number }>();
  let H = 0;
  for (const p of list) {
    if (slots.has(p.material)) continue;
    const im = (p.material as Std).map!.image as HTMLCanvasElement;
    slots.set(p.material, { im, y: H });
    H += im.height + GAP;
  }
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  for (const { im, y } of slots.values()) ctx.drawImage(im, 0, y);
  const geos = list.map((p) => {
    const { im, y } = slots.get(p.material)!;
    const g = p.geometry.clone();
    const uv = g.getAttribute('uv');
    const us = im.width / W;
    const v0 = 1 - (y + im.height) / H;
    const vs = im.height / H;
    for (let j = 0; j < uv.count; j++) uv.setXY(j, uv.getX(j) * us, v0 + uv.getY(j) * vs);
    return g;
  });
  const geometry = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  if (!geometry) return null;
  geometry.computeBoundingSphere();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  material.userData.kitOwned = true;
  return { material, geometry, shell: false, cast: false };
}

function fold(parts: BakedPart[]): BakedPart[] {
  const finishes: BakedPart[] = [];
  const labels: BakedPart[] = [];
  const by = new Map<string, BakedPart[]>();
  for (const p of parts) {
    if (!p.shell && foldable(p.material)) {
      tagFinish(p.geometry, p.material as Std);
      finishes.push(p);
    } else if (!p.shell && isLabel(p.material)) labels.push(p);
    else {
      const key = `${p.material.uuid}:${p.shell ? 1 : 0}`;
      const list = by.get(key);
      if (list) list.push(p);
      else by.set(key, [p]);
    }
  }
  const out: BakedPart[] = [];
  if (finishes.length) {
    const g = mergeGeometries(finishes.map((p) => p.geometry), false);
    if (g) {
      g.computeBoundingSphere();
      out.push({ material: foldMaterial(), geometry: g, shell: false, cast: finishes.some((p) => p.cast) });
    } else for (const p of finishes) by.set(p.material.uuid + ':f', [p]);
  }
  if (labels.length > 1) {
    const a = atlasLabels(labels);
    if (a) out.push(a);
    else out.push(...labels);
  } else out.push(...labels);
  for (const list of by.values()) {
    const m = list[0].material;
    const cast = !m.transparent && list.some((p) => p.cast);
    const g = list.length > 1 ? mergeGeometries(list.map((p) => p.geometry), false) : null;
    if (!g) {
      for (const p of list) out.push(p.cast === cast ? p : { ...p, cast });
      continue;
    }
    g.computeBoundingSphere();
    out.push({ material: m, geometry: g, shell: list[0].shell, cast });
  }
  return out;
}

/** Kit build + fold (one draw call for all opaque finishes, one for all label plates). */
export function useFolded(fn: (k: Kit) => void, deps: unknown[] = []): BakedPart[] {
  const raw = useKit(fn, deps);
  const parts = useMemo(() => fold(raw), [raw]);
  useEffect(
    () => () =>
      parts.forEach((p) => {
        if (raw.includes(p)) return;
        p.geometry.dispose();
        const m = p.material as THREE.MeshStandardMaterial;
        if (m.userData.kitOwned) {
          m.map?.dispose();
          m.dispose();
        }
      }),
    [parts, raw],
  );
  return parts;
}

/* ======================================================================
   Local finishes. Vacuum hardware is bead-blasted / hard-anodised aluminium: a satin,
   partly diffuse metal. Full-metalness finishes mirror the dark bay and read as black.
   ====================================================================== */

const F = {
  /** bead-blasted aluminium (chamber bodies, lids, transfer chamber) */
  alu: new THREE.MeshStandardMaterial({ color: '#c3c8cb', roughness: 0.78, metalness: 0.5, roughnessMap: KM.paint.roughnessMap }),
  /** machined aluminium faces (lid top plates, flanges) */
  aluFine: new THREE.MeshStandardMaterial({ color: '#cfd3d6', roughness: 0.62, metalness: 0.62, roughnessMap: KM.stainless.roughnessMap }),
  /** hard-anodised aluminium (slit valves, door valves, adapter blocks) */
  aluDark: new THREE.MeshStandardMaterial({ color: '#7c8287', roughness: 0.8, metalness: 0.42, roughnessMap: KM.paint.roughnessMap }),
  /** silicone heater blanket around chamber walls */
  jacket: new THREE.MeshStandardMaterial({ color: '#8a8f92', roughness: 0.95, metalness: 0.02, roughnessMap: KM.paint.roughnessMap, bumpMap: KM.paint.bumpMap, bumpScale: 0.8 }),
};

/** Segment-count scale: background copies of the tool are built with fewer facets. */
let LOD = 1;
const sg = (n: number) => Math.max(8, Math.round(n * LOD));
/** Rounded box, or a plain box in background copies (rounded edges vanish at that distance). */
function rb(k: Kit, m: THREE.Material, size: V3, r: number, pos: V3 = [0, 0, 0], rot: V3 = [0, 0, 0], o: PartOpts = {}) {
  if (LOD < 1) k.box(m, size, pos, rot, o);
  else k.rbox(m, size, r, pos, rot, o);
}

/* ======================================================================
   Detail helpers
   ====================================================================== */

const Z0: V3 = [0, 0, 0];
const RX: V3 = [0, 0, Math.PI / 2]; // cylinder axis → X
const RZ: V3 = [Math.PI / 2, 0, 0]; // cylinder axis → Z
/** yaw that turns local +Z towards the plan direction (cos a, sin a) */
const yawTo = (a: number) => Math.PI / 2 - a;
const polar = (r: number, a: number, y: number): V3 => [Math.cos(a) * r, y, Math.sin(a) * r];

/** Regular polygon in plan (flat facets at angles k·2π/n when rot = π/n). */
function ngon(R: number, n = 8, rot = Math.PI / 8): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const a = rot + (i / n) * Math.PI * 2;
    return [R * Math.cos(a), R * Math.sin(a)] as [number, number];
  });
}

/** Vertical prism (flat-shaded facets) from a plan polygon, y0 → y0 + h. */
function prism(k: Kit, m: THREE.Material, pts: [number, number][], y0: number, h: number, o: PartOpts = {}) {
  k.extrude(m, pts, h, [0, y0, 0], [-Math.PI / 2, 0, 0], o);
}

/** Vertical polygon ring (machined wall) from an outer and an inner plan polygon. */
function ringPrism(k: Kit, m: THREE.Material, outer: [number, number][], inner: [number, number][], y0: number, h: number, o: PartOpts = {}) {
  const s = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
  s.holes.push(new THREE.Path(inner.map(([x, y]) => new THREE.Vector2(x, y))));
  const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false });
  k.add(m, g, [0, y0, 0], [-Math.PI / 2, 0, 0], [1, 1, 1], o);
  g.dispose();
}

/** Label plate that can follow the shell (x-ray / cut-away). */
function plate(k: Kit, kind: Parameters<typeof labelMaterial>[0], text: string, sub: string, w: number, h: number, pos: V3, rot: V3 = Z0, o: PartOpts = {}, accent?: string) {
  const g = new THREE.PlaneGeometry(w, h);
  k.add(labelMaterial(kind, text, sub, accent), g, pos, rot, [1, 1, 1], { cast: false, keepUV: true, ...o });
  g.dispose();
}

/** Pneumatic actuator (body, end caps, chrome rod) along local Y, base at the origin. */
function actuator(k: Kit, r: number, len: number, rod: number, o: PartOpts = {}) {
  k.cyl(F.aluFine, r, len, [0, len / 2, 0], Z0, 20, o);
  k.cyl(KM.anodizedDark, r * 1.12, len * 0.14, [0, len * 0.07, 0], Z0, 20, o);
  k.cyl(KM.anodizedDark, r * 1.12, len * 0.14, [0, len * 0.93, 0], Z0, 20, o);
  k.cyl(KM.chrome, r * 0.3, rod, [0, len + rod / 2, 0], Z0, 10, { cast: false, ...o });
  k.cyl(KM.brass, r * 0.28, r * 0.8, [r * 0.9, len * 0.85, 0], RX, 8, { cast: false, ...o });
}

/** Surface-mount pneumatic valve with a coloured actuator cap (gas lines). */
function gasValve(k: Kit, pos: V3, cap: THREE.Material = KM.paintBlue, o: PartOpts = {}) {
  k.rbox(KM.stainless, [0.04, 0.03, 0.04], 0.004, [pos[0], pos[1], pos[2]], Z0, o);
  k.cyl(KM.stainless, 0.014, 0.03, [pos[0], pos[1] + 0.03, pos[2]], Z0, 14, o);
  k.cyl(cap, 0.016, 0.022, [pos[0], pos[1] + 0.056, pos[2]], Z0, 14, o);
}

/* ======================================================================
   Sub-assemblies (world / tool coordinates; +Z is the operator side)
   ====================================================================== */

const TC_R = 0.78; // transfer chamber circumradius (octagon)
const TC_A = TC_R * Math.cos(Math.PI / 8); // facet distance

/** Open support frame under a process chamber: square-tube legs, rails, levelling feet. */
function chamberFrame(k: Kit, lite: boolean) {
  const s = 0.36;
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    k.box(KM.paintGraphite, [0.05, 0.64, 0.05], [x * s, 0.38, z * s]);
    foot(k, [x * s, 0, z * s]);
  }
  for (const y of [0.675, 0.15]) {
    for (const z of [-s, s]) k.box(KM.paintGraphite, [2 * s + 0.05, 0.045, 0.04], [0, y, z]);
    for (const x of [-s, s]) k.box(KM.paintGraphite, [0.04, 0.045, 2 * s], [x, y, 0]);
  }
  if (!lite) for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box(KM.paintGraphite, [0.09, 0.006, 0.09], [x * s, 0.7, z * s], Z0, { cast: false });
  k.ao(0.86, 0.86, [0, 0, 0], 1.3);
}

/** Pumping stack under a chamber port at (px, pz): port, pendulum valve, turbo, foreline. */
function pumpStack(k: Kit, px: number, pz: number, lite: boolean) {
  k.at([px, 0, pz], 0, () => {
    k.cyl(KM.stainless, 0.07, 0.07, [0, 0.665, 0], Z0, sg(28));
    k.cyl(KM.stainless, 0.095, 0.014, [0, 0.632, 0], Z0, sg(32));
    // pendulum gate valve: flat body, rounded gate housing and its motor
    rb(k, KM.anodized, [0.3, 0.06, 0.22], 0.02, [0.07, 0.595, 0]);
    k.cyl(KM.anodized, 0.11, 0.06, [0.14, 0.595, 0], Z0, sg(32));
    k.cyl(KM.paintGraphite, 0.034, 0.08, [0.2, 0.664, 0.05], Z0, sg(16));
    k.cyl(KM.anodizedDark, 0.036, 0.012, [0.2, 0.71, 0.05], Z0, sg(16));
    // turbomolecular pump
    k.cyl(KM.stainless, 0.15, 0.02, [0, 0.555, 0], Z0, sg(40));
    if (!lite) boltCircle(k, 0.137, 12, 0.567, 0.0065);
    k.cyl(F.alu, 0.13, 0.2, [0, 0.445, 0], Z0, sg(40));
    for (const y of [0.39, 0.45, 0.51]) k.torus(KM.anodizedDark, 0.131, 0.004, [0, y, 0], Z0, sg(40), { cast: false });
    k.cyl(KM.anodizedDark, 0.11, 0.06, [0, 0.315, 0], Z0, sg(32));
    k.cyl(KM.stainlessDark, 0.06, 0.03, [0, 0.27, 0], Z0, sg(24));
    // pump controller and its cable
    rb(k, KM.paintGraphite, [0.07, 0.15, 0.12], 0.012, [-0.165, 0.44, 0]);
    if (!lite) {
      ledStrip(k, 0.05, [-0.2, 0.5, 0], KM.ledGreen);
      hose(k, [-0.2, 0.38, 0.03], [-0.36, 0.06, 0.2], 0.008, 0.06, KM.plastic);
    }
    // foreline down into the raised floor, with a flexible bellows section
    k.pipe(KM.stainless, [[0.09, 0.3, 0], [0.24, 0.3, 0], [0.24, 0.0, 0]], 0.022, 0.05);
    bellows(k, 0.029, 0.09, 6, [0.24, 0.1, 0]);
    k.cyl(KM.stainless, 0.034, 0.012, [0.24, 0.215, 0], Z0, sg(20));
    k.cyl(KM.stainless, 0.034, 0.012, [0.24, 0.085, 0], Z0, sg(20));
    k.box(KM.paintGraphite, [0.14, 0.004, 0.14], [0.24, 0.002, 0], Z0, { cast: false });
  });
}

/** Pedestal lift drive under the chamber centre (bellows, carriage, servo). */
function liftDrive(k: Kit) {
  bellows(k, 0.045, 0.09, 7, [0, 0.61, 0], KM.stainless);
  k.cyl(KM.stainless, 0.06, 0.012, [0, 0.606, 0], Z0, sg(24));
  rb(k, KM.anodizedDark, [0.15, 0.11, 0.13], 0.01, [0, 0.545, -0.02]);
  for (const x of [-0.055, 0.055]) k.cyl(KM.chrome, 0.009, 0.2, [x, 0.5, -0.07], Z0, 10, { cast: false });
  k.cyl(KM.paintGraphite, 0.042, 0.13, [0, 0.425, -0.02], Z0, sg(20));
  k.cyl(KM.anodized, 0.03, 0.02, [0, 0.35, -0.02], Z0, sg(16));
}

interface BodyOpts {
  R: number;
  o: PartOpts;
  lite: boolean;
  /** plan angle of the lid hinge (local) */
  hinge: number;
  /** plan angle of the viewport (local), or null */
  port: number | null;
  name: string;
  sub: string;
  /** plan angle of the chamber name plate (local) */
  tag: number;
}

/** Process chamber body: bottom plate, wall with heater jacket, flanges, stepped lid, bolts, hinge. */
function chamberBody(k: Kit, b: BodyOpts) {
  const { R, o, lite } = b;
  const top = 1.335;
  k.cyl(F.aluDark, R + 0.02, 0.04, [0, 0.72, 0], Z0, sg(56));
  k.cyl(F.aluFine, R + 0.03, 0.025, [0, 0.7525, 0], Z0, sg(64), o);
  k.cyl(F.alu, R, top - 0.765, [0, (top + 0.765) / 2, 0], Z0, sg(64), { ...o, open: true });
  // heater jacket with weld beads and a vertical seam
  k.cyl(F.jacket, R + 0.013, 0.4, [0, 1.03, 0], Z0, sg(64), { ...o, open: true });
  for (const y of [0.83, 1.23]) k.torus(KM.stainless, R + 0.013, 0.005, [0, y, 0], Z0, sg(64), o);
  k.at(polar(R + 0.014, b.hinge + 0.6, 1.03), yawTo(b.hinge + 0.6), () => k.box(KM.seam, [0.004, 0.39, 0.002], Z0, Z0, { cast: false, ...o }));
  // top flange + seam
  k.cyl(F.aluFine, R + 0.04, 0.03, [0, top - 0.015, 0], Z0, sg(64), o);
  k.torus(KM.seam, R + 0.039, 0.0016, [0, top + 0.001, 0], Z0, sg(64), { cast: false, ...o });
  // stepped lid
  k.cyl(F.alu, R + 0.03, 0.034, [0, top + 0.017, 0], Z0, sg(64), o);
  k.cyl(F.aluFine, R + 0.012, 0.016, [0, top + 0.042, 0], Z0, sg(64), o);
  if (!lite) boltCircle(k, R + 0.016, 24, top + 0.037, 0.0075, KM.stainlessDark, o);
  // lid hinge: two knuckles and leaves on the wall and the lid
  k.at(polar(R + 0.05, b.hinge, top), yawTo(b.hinge), () => {
    for (const x of [-0.13, 0.13]) {
      k.cyl(KM.stainless, 0.02, 0.09, [x, 0.012, 0], RX, sg(16), o);
      k.box(KM.stainless, [0.08, 0.006, 0.07], [x, 0.038, -0.04], Z0, o);
      k.box(KM.stainless, [0.08, 0.07, 0.008], [x, -0.03, -0.012], Z0, o);
    }
    k.cyl(KM.chrome, 0.006, 0.36, [0, 0.012, 0], RX, 8, { cast: false, ...o });
  });
  // lid lift strut beside the hinge
  k.at(polar(R + 0.035, b.hinge - 0.55, 0.92), yawTo(b.hinge - 0.55), () => {
    k.box(KM.stainless, [0.05, 0.04, 0.03], [0, 0, -0.012], Z0, o);
    actuator(k, 0.016, 0.26, 0.17, o);
  });
  // lift handle on the lid opposite the hinge
  k.at(polar(R - 0.06, b.hinge + Math.PI, top + 0.05), yawTo(b.hinge + Math.PI), () => {
    k.pipe(KM.stainless, [[-0.08, 0, 0], [-0.08, 0.045, 0], [0.08, 0.045, 0], [0.08, 0, 0]], 0.0075, 0.02, o);
  });
  if (b.port !== null) k.at(polar(R + 0.005, b.port, 1.12), yawTo(b.port), () => viewport(k, 0.042, 0.06, o));
  // name plate on the jacket and a hot-surface warning
  k.at(polar(R + 0.016, b.tag, 0.96), yawTo(b.tag), () => plate(k, 'tag', b.name, b.sub, 0.15, 0.04, [0, 0, 0.001], Z0, o));
  k.at(polar(R + 0.016, b.tag + 0.32, 1.13), yawTo(b.tag + 0.32), () => plate(k, 'warn', 'HOT SURFACE', '', 0.06, 0.06, [0, 0, 0.001], Z0, o));
}

/** Cooling-water supply/return hoses from a chamber jacket to the frame. */
function waterLines(k: Kit, R: number, a: number) {
  for (const [i, m] of [[0, KM.paintBlue], [1, KM.paintRed]] as const) {
    const aa = a + i * 0.16;
    const p = polar(R + 0.02, aa, 0.86 + i * 0.05);
    k.cyl(KM.brass, 0.011, 0.04, [p[0] + Math.cos(aa) * 0.02, p[1], p[2] + Math.sin(aa) * 0.02], [Math.PI / 2, 0, Math.PI / 2 - aa], 10, { cast: false });
    const q = polar(R + 0.045, aa, p[1]);
    hose(k, q, [Math.cos(aa) * 0.4, 0.69, Math.sin(aa) * 0.4], 0.011, 0.05, m);
  }
}

/**
 * Power cable from a lid connector: over the lid edge, down the outside of the chamber
 * (clear of the wall, radius ≥ 0.58) and into the raised floor through a grommet plate.
 */
export function rfCable(k: Kit, from: V3, r: number, m: THREE.Material = KM.rubber, angle?: number) {
  const a = angle ?? Math.atan2(from[2], from[0]) - 0.35;
  const at = (rr: number, y: number): V3 => [Math.cos(a) * rr, y, Math.sin(a) * rr];
  k.tube(m, [from, [from[0] + Math.cos(a) * 0.07, from[1] + 0.02, from[2] + Math.sin(a) * 0.07], at(0.5, from[1] - 0.04), at(0.6, 1.3), at(0.61, 0.9), at(0.62, 0.35), at(0.62, -0.02)], r, { radial: 10, tension: 0.35 });
  k.box(KM.paintGraphite, [0.09, 0.004, 0.09], at(0.62, 0.002), [0, -a, 0], { cast: false });
}

/** RF match network on standoffs on the lid (local +Z faces outward). */
function rfMatch(k: Kit, lite: boolean) {
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.cyl(KM.stainlessDark, 0.012, 0.045, [x * 0.16, 1.405, z * 0.12], Z0, 10);
  k.cyl(KM.ptfe, 0.06, 0.045, [0, 1.405, 0], Z0, sg(24));
  rb(k, KM.paint, [0.44, 0.24, 0.36], 0.022, [0, 1.545, 0]);
  rb(k, KM.paintGraphite, [0.452, 0.018, 0.372], 0.007, [0, 1.672, 0]);
  k.box(KM.seam, [0.44, 0.004, 0.002], [0, 1.47, 0.181], Z0, { cast: false });
  grille(k, 0.2, 0.09, [-0.08, 1.56, 0.181]);
  plate(k, 'warn', 'HIGH VOLTAGE', '', 0.065, 0.065, [0.14, 1.56, 0.182]);
  plate(k, 'tag', 'RF MATCH', '13.56 MHz · 3 kW', 0.16, 0.04, [-0.06, 1.635, 0.182]);
  if (!lite) for (const x of [-0.2, 0.2]) for (const y of [1.45, 1.64]) k.cyl(KM.stainlessDark, 0.005, 0.004, [x, y, 0.181], RZ, 8, { cast: false });
  // RF input connector and coax down to the generator rack
  k.cyl(KM.stainless, 0.026, 0.05, [0.245, 1.52, -0.05], RX, sg(16));
  k.cyl(KM.stainlessDark, 0.03, 0.02, [0.275, 1.52, -0.05], RX, 6);
  rfCable(k, [0.285, 1.52, -0.05], 0.017);
}

/** Process gas line from the frame up the chamber side into the lid inlet (local coords). */
function gasDrop(k: Kit, x: number, z: number, inlet: V3, gas: string, color: string, o: PartOpts = {}) {
  const top = 1.46;
  k.pipe(KM.stainless, [[x, 0.68, z], [x, top, z], [inlet[0], top, inlet[2]], [inlet[0], inlet[1], inlet[2]]], 0.0065, 0.035, o);
  gasValve(k, [x, 1.2, z], KM.paintBlue, o);
  k.cyl(KM.stainless, 0.03, 0.03, [inlet[0], inlet[1] + 0.015, inlet[2]], Z0, sg(16), o);
  k.at([x, 0.98, z], Math.atan2(x, z), () => plate(k, 'gas', gas, '', 0.07, 0.016, [0, 0, 0.009], Z0, o, color));
}

/** Closed process chamber (local +Z points away from the transfer chamber). */
function closedChamber(k: Kit, name: string, lite: boolean) {
  chamberFrame(k, lite);
  pumpStack(k, 0.16, 0.14, lite);
  liftDrive(k);
  chamberBody(k, { R: 0.48, o: {}, lite, hinge: -Math.PI / 2, port: 1.25, name, sub: 'PROCESS MODULE', tag: 1.75 });
  rfMatch(k, lite);
  if (!lite) waterLines(k, 0.48, 0.2);
  gasDrop(k, 0.58, -0.16, [0.3, 1.385, -0.16], 'N₂', '#2f5d8a');
  if (!lite) gasDrop(k, -0.58, -0.16, [-0.3, 1.385, -0.16], 'NF₃', '#7a4a8a');
}

/** Mainframe base, chamber frames, closed chambers, slit valve housing, gas cabinet. */
function buildMain(k: Kit, accent: THREE.Material, lite: boolean, closed: readonly number[] = [1, -1]) {
  // mainframe cabinet under the transfer chamber and the load locks
  k.at([-0.49, 0, 0], 0, () =>
    cabinet(k, { size: [2.46, 0.7, 1.56], body: KM.paint, trim: KM.paintGraphite, plinth: 0.08, panels: 4, rows: [], sidePanels: 2, vent: true, handles: false, stripe: accent, bolts: !lite, feet: false }),
  );
  // closed process chambers on the ±Z facets
  if (closed.includes(1)) k.at([0, 0, 1.3], 0, () => closedChamber(k, 'PM B', lite));
  if (closed.includes(-1)) k.at([0, 0, -1.3], Math.PI, () => closedChamber(k, 'PM C', lite));
  // active chamber frame + slit-valve housing to the transfer chamber (gate is live)
  k.at([CHAMBER.x, 0, 0], 0, () => chamberFrame(k, lite));
  rb(k, F.aluDark, [0.16, 0.36, 0.52], 0.016, [0.8, 1.02, 0], Z0, { shell: true });
  k.box(KM.seam, [0.162, 0.004, 0.5], [0.8, 1.14, 0], Z0, { shell: true, cast: false });
  k.at([0.8, 0.735, 0], 0, () => actuator(k, 0.034, 0.09, 0.0));
  if (!lite) for (const z of [-0.22, 0.22]) for (const y of [0.88, 1.16]) k.cyl(KM.stainlessDark, 0.007, 0.006, [0.8, y, z], RX, 6, { shell: true, cast: false });
  // gas cabinet behind the load locks: stainless gas sticks behind a window, tagged lines
  k.at([-1.36, 0, -1.08], Math.PI, () => {
    cabinet(k, { size: [0.68, 1.55, 0.4], body: KM.paint, trim: KM.paintGraphite, panels: 1, rows: [0.5], vent: true, handles: true, stripe: accent, bolts: !lite, feet: true });
    windowPane(k, 0.44, 0.62, [-0.02, 1.08, 0.21], { glass: KM.glassSmoke });
    if (!lite) for (const [i, y] of [[0, 0.88], [1, 1.08], [2, 1.28]] as const) {
      gasStick(k, 0.36, [-0.02, y - 0.04, 0.17]);
      plate(k, 'gas', ['N₂', 'Ar', 'NF₃'][i], '', 0.08, 0.018, [-0.02, y + 0.07, 0.226], Z0, {}, ['#2f5d8a', '#3e7d4c', '#7a4a8a'][i]);
    }
    plate(k, 'model', 'GAS BOX', 'EXHAUSTED · LEAK-TESTED', 0.3, 0.075, [0, 1.47, 0.202]);
    plate(k, 'warn', 'TOXIC GAS', '', 0.08, 0.08, [0.24, 1.3, 0.202]);
    // exhaust duct to the house scrubber
    k.cyl(KM.paintGrey, 0.07, 0.6, [0.12, 1.86, 0], Z0, sg(24));
    k.cyl(KM.stainless, 0.08, 0.02, [0.12, 1.57, 0], Z0, sg(24));
    k.cyl(KM.stainless, 0.078, 0.016, [0.12, 1.9, 0], Z0, sg(24));
    k.label('tag', 'EXHAUST', '≥ 0.5 m/s', 0.1, 0.028, [0.12, 1.75, 0.0705], Z0);
  });
  // gas header from the cabinet to the chambers along the mainframe back
  if (!lite) for (let i = 0; i < 3; i++) {
    const y = 0.6 + i * 0.03;
    k.pipe(KM.stainless, [[-1.2 + i * 0.05, 0.75, -0.86], [-1.2 + i * 0.05, y, -0.86], [0.75, y, -0.86], [0.75, y, -0.3 - i * 0.03], [0.92, y, -0.3 - i * 0.03]], 0.0055, 0.04);
  }
  // facility cable tray along the back of the mainframe
  if (!lite) {
    k.box(KM.anodized, [1.9, 0.004, 0.18], [-0.7, 0.45, -0.88], Z0, { cast: false });
    for (const z of [-0.79, -0.97]) k.box(KM.anodized, [1.9, 0.05, 0.004], [-0.7, 0.475, z], Z0, { cast: false });
    for (let i = 0; i < 4; i++) k.cyl([KM.plastic, KM.paintGraphite, KM.paintBlue, KM.plastic][i], 0.012, 1.9, [-0.7, 0.465, -0.83 - i * 0.035], RX, 8, { cast: false });
  }
}

/** Load port (local +Z faces outward, origin on the EFEM face at floor level). */
function loadPort(k: Kit, n: number, lite: boolean) {
  rb(k, KM.paint, [0.52, 1.38, 0.035], 0.008, [0, 0.69, 0.018]);
  k.box(KM.seam, [0.4, 0.35, 0.002], [0, 1.09, 0.036], Z0, { cast: false });
  rb(k, KM.paintGrey, [0.38, 0.33, 0.02], 0.01, [0, 1.09, 0.042]);
  k.box(KM.anodizedDark, [0.3, 0.02, 0.012], [0, 1.2, 0.055], Z0, { cast: false });
  // kinematic stage
  k.box(KM.paintGraphite, [0.42, 0.06, 0.38], [0, 0.03, 0.25]);
  rb(k, KM.paint, [0.46, 0.8, 0.42], 0.02, [0, 0.46, 0.25]);
  rb(k, F.aluFine, [0.44, 0.03, 0.44], 0.006, [0, 0.885, 0.26]);
  for (const [x, z] of [[-0.12, 0.14], [0.12, 0.14], [0, 0.4]]) k.cyl(KM.stainless, 0.008, 0.014, [x, 0.905, z], Z0, 10, { cast: false });
  for (const x of [-0.17, 0.17]) rb(k, KM.anodizedDark, [0.04, 0.02, 0.06], 0.004, [x, 0.91, 0.1]);
  // operator buttons and status lamps
  rb(k, KM.plastic, [0.18, 0.07, 0.012], 0.006, [0, 0.78, 0.466]);
  k.cyl(KM.ledGreen, 0.011, 0.008, [-0.04, 0.78, 0.474], RZ, 12, { cast: false });
  k.cyl(KM.ledAmber, 0.011, 0.008, [0.04, 0.78, 0.474], RZ, 12, { cast: false });
  ledStrip(k, 0.3, [0, 1.33, 0.037], n === 1 ? KM.ledGreen : KM.ledWhite);
  plate(k, 'tag', `LP${n + 1}`, 'E84 · FIMS', 0.1, 0.03, [0, 0.69, 0.462]);
  if (!lite) grille(k, 0.3, 0.12, [0, 0.25, 0.462], { m: KM.paint });
  k.ao(0.5, 0.48, [0, 0, 0.25], 1.25);
}

const MODEL: Record<string, [string, string]> = {
  'dep-cluster': ['DCX-300', 'CVD · PVD · ALD CLUSTER · 300 mm'],
  etcher: ['PEX-300', 'PLASMA ETCH CLUSTER · 300 mm'],
  asher: ['ASX-300', 'RESIST STRIP · 300 mm'],
};

/** Equipment front end: housing (x-ray only), FFU, load ports, HMI, EMO, ATM robot. */
function buildEfem(k: Kit, accent: THREE.Material, machine: string, sh: boolean, lite: boolean) {
  const o = { shell: sh };
  const [model, sub] = MODEL[machine] ?? [machine.toUpperCase(), '300 mm'];
  // EFEM frame: local +Z faces the load ports (world −X), local +X is world +Z
  k.at([-2.2, 0, 0], -Math.PI / 2, () => {
    cabinet(k, { size: [1.9, 2.05, 0.8], body: KM.paint, trim: KM.paintGraphite, panels: 3, rows: [1.4], sidePanels: 1, vent: false, handles: false, stripe: false, bolts: !lite, feet: false, shell: sh, ao: true });
    k.box(accent, [1.912, 0.05, 0.812], [0, 1.9, 0], Z0, o);
    // windows into the mini-environment on both sides
    for (const s of [-1, 1])
      k.at([s * 0.951, 1.45, 0], [0, (s * Math.PI) / 2, 0], () => windowPane(k, 0.44, 0.5, [0, 0, 0], { ...o, glass: KM.glassSmoke }));
    plate(k, 'model', model, sub, 0.44, 0.11, [0, 1.72, 0.402], Z0, o);
    plate(k, 'model', model, sub, 0.36, 0.09, [0.952, 1.82, 0], [0, Math.PI / 2, 0], o);
    plate(k, 'warn', 'ROBOT', '', 0.07, 0.07, [0.952, 1.1, 0.24], [0, Math.PI / 2, 0], o);
    estop(k, [0.8, 1.52, 0.4]);
    // fan filter unit on top
    rb(k, KM.paint, [1.9, 0.19, 0.8], 0.015, [0, 2.17, 0]);
    rb(k, KM.paintGraphite, [1.914, 0.016, 0.814], 0.006, [0, 2.273, 0]);
    grille(k, 1.2, 0.1, [0, 2.17, 0.401], { m: KM.paint });
    k.at([0.951, 2.17, 0], [0, Math.PI / 2, 0], () => grille(k, 0.5, 0.1, [0, 0, 0], { m: KM.paint }));
    rb(k, KM.paintGrey, [0.3, 0.07, 0.2], 0.01, [-0.5, 2.31, -0.1]);
    k.cyl(KM.anodizedDark, 0.03, 0.012, [0.85, 2.288, 0], Z0, sg(16));
    // atmospheric robot inside (seen in x-ray)
    k.cyl(KM.anodizedDark, 0.11, 0.62, [0, 0.31, -0.1], Z0, sg(28));
    k.cyl(KM.paint, 0.1, 0.22, [0, 0.73, -0.1], Z0, sg(28));
    rb(k, KM.paint, [0.12, 0.08, 0.34], 0.03, [0, 0.88, 0.03]);
    rb(k, KM.paint, [0.1, 0.06, 0.3], 0.025, [0.1, 0.95, 0.18], [0, 0.7, 0]);
    k.box(KM.ptfe, [0.07, 0.006, 0.24], [0.18, 0.99, 0.28], [0, 0.7, 0]);
  });
  for (let i = 0; i < 3; i++) k.at([-2.6, 0, [-0.62, 0, 0.62][i]], -Math.PI / 2, () => loadPort(k, i, lite));
  hmi(k, [-2.74, 1.52, 1.08], -Math.PI / 4);
}

/** Two load locks, the atmospheric door valves, and the adapter to the transfer chamber. */
function buildLoadLocks(k: Kit, sh: boolean, lite: boolean) {
  const o = { shell: sh };
  for (const [i, z] of [[0, -0.35], [1, 0.35]] as const) {
    const s = z > 0 ? 1 : -1;
    rb(k, F.alu, [0.7, 0.42, 0.55], 0.03, [-1.35, 1.0, z], Z0, o);
    k.box(KM.seam, [0.702, 0.004, 0.552], [-1.35, 1.16, z], Z0, { ...o, cast: false });
    // lid with a viewing window, bolts, handle
    rb(k, F.aluFine, [0.66, 0.03, 0.51], 0.01, [-1.35, 1.225, z], Z0, o);
    k.box(KM.glassSmoke, [0.3, 0.004, 0.26], [-1.33, 1.242, z], Z0, { ...o, cast: false });
    for (const [w, d, x, zz] of [[0.34, 0.02, -1.33, z - 0.14], [0.34, 0.02, -1.33, z + 0.14], [0.02, 0.26, -1.5, z], [0.02, 0.26, -1.16, z]] as const)
      k.box(KM.stainless, [w, 0.012, d], [x, 1.246, zz], Z0, { ...o, cast: false });
    if (!lite) for (const x of [-1.64, -1.35, -1.06]) for (const dz of [-0.23, 0.23]) k.cyl(KM.stainlessDark, 0.007, 0.006, [x, 1.243, z + dz], Z0, 6, { ...o, cast: false });
    k.pipe(KM.stainless, [[-1.63, 1.24, z - 0.08], [-1.63, 1.285, z - 0.08], [-1.63, 1.285, z + 0.08], [-1.63, 1.24, z + 0.08]], 0.0075, 0.02, o);
    // vacuum gauge on the outer side, name tag
    k.cyl(KM.stainless, 0.016, 0.05, [-1.2, 1.02, z + s * 0.3], RZ, 14, o);
    k.cyl(KM.anodizedDark, 0.03, 0.07, [-1.2, 1.02, z + s * 0.355], RZ, sg(20), o);
    plate(k, 'tag', i ? 'LL B' : 'LL A', 'LOAD LOCK', 0.13, 0.036, [-1.45, 1.0, z + s * 0.2765], s > 0 ? Z0 : [0, Math.PI, 0], o);
    // atmospheric door valve towards the EFEM
    rb(k, F.aluDark, [0.07, 0.36, 0.5], 0.012, [-1.735, 1.0, z], Z0, o);
    for (const dz of [-0.17, 0.17]) k.at([-1.735, 1.18, z + dz], 0, () => actuator(k, 0.016, 0.07, 0.02, o));
    // supports, pump-down and vent valves below
    for (const dx of [-0.24, 0.24]) rb(k, KM.anodizedDark, [0.08, 0.07, 0.42], 0.006, [-1.35 + dx, 0.756, z]);
    k.cyl(KM.stainless, 0.022, 0.07, [-1.25, 0.755, z], Z0, sg(16));
    gasValve(k, [-1.47, 0.74, z + s * 0.12], KM.paintGraphite);
  }
  // adapter from the load locks to the transfer chamber's −X facet, with slit-valve actuators
  k.extrude(F.alu, [[-1.0, -0.6], [-TC_A + 0.02, -0.3], [-TC_A + 0.02, 0.3], [-1.0, 0.6]], 0.34, [0, 0.83, 0], [-Math.PI / 2, 0, 0], o);
  for (const z of [-0.3, 0.3]) k.at([-0.86, 1.17, z], 0, () => actuator(k, 0.024, 0.07, 0.02, o));
}

/** Octagonal transfer chamber: machined wall, hinged lid with a window, facet hardware, robot drive. */
function buildTransfer(k: Kit, sh: boolean, lite: boolean) {
  const o = { shell: sh };
  const ya = 0.73;
  const yb = 1.225;
  ringPrism(k, F.alu, ngon(TC_R), ngon(TC_R - 0.055), ya, yb - ya, o);
  // lid: two stepped plates, bolt rows, window, handles, hinge, lift struts
  prism(k, F.alu, ngon(0.8), yb, 0.034, o);
  prism(k, F.aluFine, ngon(0.77), yb + 0.034, 0.014, o);
  if (!lite) {
    const v = ngon(0.755);
    for (let i = 0; i < 8; i++) {
      const [ax, az] = v[i];
      const [bx, bz] = v[(i + 1) % 8];
      for (const t of [0.3, 0.7]) k.cyl(KM.stainlessDark, 0.0085, 0.008, [ax + (bx - ax) * t, yb + 0.037, -(az + (bz - az) * t)], Z0, 6, { ...o, cast: false });
    }
  }
  k.cyl(KM.stainless, 0.34, 0.02, [0, yb + 0.058, 0], Z0, sg(56), o);
  k.cyl(KM.glassSmoke, 0.3, 0.006, [0, yb + 0.069, 0], Z0, sg(48), { ...o, cast: false });
  if (!lite) boltCircle(k, 0.32, 16, yb + 0.07, 0.0065, KM.stainlessDark, o);
  for (const a of [Math.PI / 4, (3 * Math.PI) / 4])
    k.at(polar(0.64, a, yb + 0.048), yawTo(a), () => k.pipe(KM.stainless, [[-0.09, 0, 0], [-0.09, 0.05, 0], [0.09, 0.05, 0], [0.09, 0, 0]], 0.008, 0.02, o));
  k.at(polar(TC_A + 0.03, -Math.PI / 2, yb + 0.02), yawTo(-Math.PI / 2), () => {
    for (const x of [-0.17, 0.17]) {
      k.cyl(KM.stainless, 0.022, 0.1, [x, 0, 0], RX, sg(16), o);
      k.box(KM.stainless, [0.09, 0.006, 0.08], [x, 0.03, -0.05], Z0, o);
      k.box(KM.stainless, [0.09, 0.08, 0.008], [x, -0.04, -0.016], Z0, o);
    }
    k.cyl(KM.chrome, 0.007, 0.44, [0, 0, 0], RX, 8, { ...o, cast: false });
  });
  // facets: diagonal blanks (gauge, viewport), all with cover plates and bolts
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    k.at(polar(TC_A, a, 0.98), yawTo(a), () => {
      rb(k, KM.stainless, [0.4, 0.26, 0.02], 0.01, [0, 0, 0.01], Z0, o);
      if (!lite) for (const x of [-0.17, 0, 0.17]) for (const y of [-0.1, 0.1]) k.cyl(KM.stainlessDark, 0.007, 0.006, [x, y, 0.022], RZ, 6, { ...o, cast: false });
      if (i === 1) viewport(k, 0.05, 0.05, o);
      if (i === 0) {
        k.cyl(KM.stainless, 0.018, 0.06, [0, 0, 0.05], RZ, 14, o);
        k.cyl(KM.stainless, 0.03, 0.01, [0, 0, 0.08], RZ, sg(16), o);
        rb(k, KM.anodizedDark, [0.07, 0.11, 0.06], 0.008, [0, -0.02, 0.115], Z0, o);
        plate(k, 'tag', 'TM', 'COLD CATHODE', 0.06, 0.02, [0, 0.07, 0.15], Z0, o);
      }
    });
  }
  for (const a of [(5 * Math.PI) / 4, (7 * Math.PI) / 4])
    k.at(polar(TC_A + 0.03, a, 0.9), yawTo(a), () => actuator(k, 0.016, 0.24, 0.12, o));
  plate(k, 'model', 'TRANSFER MODULE', 'VACUUM · 1E-6 Torr', 0.3, 0.075, [0, 0.9, TC_A + 0.022], Z0, o);
  plate(k, 'warn', 'VACUUM', '', 0.06, 0.06, [0.26, 1.1, TC_A + 0.022], Z0, o);
  // floor plate and robot drive (inside)
  prism(k, KM.anodizedDark, ngon(TC_R), 0.7, 0.03);
  k.cyl(KM.stainlessDark, 0.12, 0.12, [0, 0.8, 0], Z0, sg(40));
  k.cyl(KM.anodized, 0.135, 0.015, [0, 0.745, 0], Z0, sg(40));
  k.cyl(KM.anodizedDark, 0.07, 0.09, [0, 0.905, 0], Z0, sg(32));
  // slit valves to the closed chambers on the ±Z facets
  for (const s of [-1, 1]) {
    rb(k, F.aluDark, [0.44, 0.26, 0.12], 0.015, [0, 0.98, s * 0.78]);
    k.box(KM.seam, [0.442, 0.004, 0.11], [0, 1.06, s * 0.78], Z0, { cast: false });
    k.at([0, 0.73, s * 0.78], 0, () => actuator(k, 0.03, 0.09, 0.02));
  }
}

/** Active chamber (chamber-local coordinates): body + pumping + lift + gauges and lines. */
function buildActive(k: Kit, sh: boolean, lite: boolean) {
  const o = { shell: sh };
  chamberBody(k, { R: CHAMBER.r, o, lite, hinge: -Math.PI / 2, port: 1.22, name: 'PM A', sub: 'ACTIVE · 300 mm', tag: 0.95 });
  // capacitance manometer on a short tube
  k.at(polar(CHAMBER.r, 0.5, 1.24), yawTo(0.5), () => {
    k.cyl(KM.stainless, 0.012, 0.07, [0, 0, 0.035], RZ, 12, o);
    k.cyl(F.aluFine, 0.04, 0.075, [0, 0.03, 0.09], Z0, sg(24), o);
    k.torus(KM.seam, 0.04, 0.0015, [0, 0.05, 0.09], Z0, sg(24), { ...o, cast: false });
    k.cyl(KM.anodizedDark, 0.03, 0.02, [0, 0.077, 0.09], Z0, sg(20), o);
    k.cyl(KM.ledGreen, 0.004, 0.004, [0.02, 0.087, 0.09], Z0, 8, { ...o, cast: false });
  });
  // second (process) gauge + isolation valve on the back
  k.at(polar(CHAMBER.r, -2.2, 1.18), yawTo(-2.2), () => {
    k.cyl(KM.stainless, 0.014, 0.08, [0, 0, 0.04], RZ, 12, o);
    gasValve(k, [0, -0.02, 0.09], KM.paintGraphite, o);
  });
  pumpStack(k, 0.2, 0.18, lite);
  liftDrive(k);
  if (!lite) waterLines(k, CHAMBER.r, 0.05);
  gasDrop(k, -0.32, -0.46, [-0.18, 1.385, -0.3], 'N₂', '#2f5d8a', o);
  // heater / thermocouple cable from the pedestal feedthrough
  hose(k, [0, 0.36, -0.02], [-0.32, 0.12, -0.34], 0.01, 0.05, KM.plastic);
}

/**
 * Merged background cluster tool (no cut-away, fewer facets): for neighbouring tools in
 * the bay. `closed` lists the closed chambers to include (+1 = +Z facet, −1 = −Z facet),
 * so a neighbour can drop the chamber that would sit inside a wall or off the floor.
 */
export function buildClusterNeighbour(k: Kit, accent: THREE.Material = M.greenAccent, machine = 'dep-cluster', closed: readonly number[] = [1, -1]) {
  LOD = 0.5;
  try {
    buildMain(k, accent, true, closed);
    buildEfem(k, accent, machine, false, true);
    buildLoadLocks(k, false, true);
    buildTransfer(k, false, true);
    k.at([CHAMBER.x, 0, 0], 0, () => {
      buildActive(k, false, true);
      rfMatch(k, true);
    });
    // static stack light on the FFU
    k.cyl(KM.anodizedDark, 0.012, 0.12, [-2.2, 2.34, 0.85], Z0, 10);
    for (const [i, m] of [KM.plastic, KM.plastic, KM.ledGreen, KM.plastic].entries()) k.cyl(m, 0.028, 0.045, [-2.2, 2.58 - i * 0.048, 0.85], Z0, sg(16), { cast: false });
  } finally {
    LOD = 1;
  }
}

/* ======================================================================
   The tool
   ====================================================================== */

/** Static robot details that ride with the arm (hub, wrist, retracted second blade). */
function buildArm(k: Kit) {
  k.cyl(KM.anodized, 0.1, 0.035, [0, -0.04, 0], Z0, 40);
  k.cyl(KM.anodizedDark, 0.102, 0.004, [0, -0.021, 0], Z0, 40, { cast: false });
  k.rbox(KM.anodized, [0.09, 0.022, 0.1], 0.008, [0.03, -0.016, 0]);
  k.rbox(KM.anodized, [0.2, 0.02, 0.07], 0.008, [-0.12, -0.03, 0]);
  k.box(KM.ptfe, [0.16, 0.006, 0.06], [-0.26, -0.03, 0], Z0, { cast: false });
}

export function ClusterTool({ machine, label, accent = 'blue', children, lid }: { machine: string; label: string; accent?: 'blue' | 'green' | 'orange'; children?: ReactNode; lid?: ReactNode }) {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  const view = effectiveView(viewRaw, cam);
  const wafer = useRef<THREE.Group>(null);
  const arm = useRef<THREE.Group>(null);
  const blade = useRef<THREE.Mesh>(null);
  const valve = useRef<THREE.Mesh>(null);
  const waferMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.08, metalness: 0.9 }), []);
  useFrame(() => {
    const u = transferProgress();
    const p = transferPos(u);
    if (wafer.current) wafer.current.position.copy(p);
    // vacuum robot follows the wafer while it is being carried
    const carried = u > 0.02 && u < 0.98;
    const target = carried ? p : u >= 0.98 ? TC.clone().add(new THREE.Vector3(0.25, 0, 0)) : TC.clone().add(new THREE.Vector3(-0.25, 0, 0.1));
    const d = target.clone().sub(TC);
    const r = Math.max(0.12, Math.hypot(d.x, d.z));
    if (arm.current) {
      arm.current.rotation.y = Math.atan2(-d.z, d.x);
      arm.current.scale.x = 1;
    }
    if (blade.current) {
      blade.current.scale.x = r;
      blade.current.position.x = r / 2;
    }
    // slit valve opens while the robot passes into the chamber
    const open = u > 0.55 && u < 0.97 ? 1 : 0;
    if (valve.current) valve.current.position.y = 1.0 + open * 0.14;
    if (u > 0.02 && u < 0.98) track('focus', p.x, p.y, p.z);
    else track('focus', PM.x, PM.y, PM.z);
  });
  const accentMat = accent === 'blue' ? M.blueAccent : accent === 'green' ? M.greenAccent : M.orangeAccent;
  const main = useFolded((k) => buildMain(k, accentMat, false), [accentMat]);
  const efem = useFolded((k) => buildEfem(k, accentMat, machine, true, false), [accentMat, machine]);
  const locks = useFolded((k) => buildLoadLocks(k, true, false));
  const tc = useFolded((k) => buildTransfer(k, true, false));
  const pm = useFolded((k) => k.at([CHAMBER.x, 0, 0], 0, () => buildActive(k, true, false)));
  const armParts = useFolded(buildArm);
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: machine, label }}>
        <Baked parts={main} view={view} />
        {/* EFEM */}
        <Clickable sel={{ kind: 'component', id: 'efem', machine, label: 'EFEM & load ports' }}>
          <Baked parts={efem} view={view === 'xray' ? 'xray' : 'normal'} />
          <FOUP position={[-2.85, 0.9, 0]} rotation={[0, 0, 0]} />
          <SignalTower position={[-2.2, 2.28, 0.85]} />
        </Clickable>
        {/* load locks */}
        <Clickable sel={{ kind: 'component', id: 'load-lock', machine, label: 'Load locks' }}>
          <Baked parts={locks} view={view} />
        </Clickable>
        {/* transfer chamber */}
        <Clickable sel={{ kind: 'component', id: 'transfer-chamber', machine, label: 'Vacuum transfer chamber + robot' }}>
          <Baked parts={tc} view={view} />
          <group ref={arm} position={[0, 0.99, 0]}>
            <mesh ref={blade} material={M.ceramic}>
              <boxGeometry args={[1, 0.012, 0.07]} />
            </mesh>
            <C r={0.05} h={0.04} m={M.steelDark} position={[0, -0.02, 0]} />
            <Baked parts={armParts} />
          </group>
        </Clickable>
        {/* active chamber body (cut-away when looking inside) */}
        <Clickable sel={{ kind: 'component', id: machine === 'etcher' ? 'liner' : machine === 'asher' ? 'plasma-source' : 'cvd-chamber', machine, label: 'Process chamber (active)' }}>
          <Baked parts={pm} view={view} />
        </Clickable>
        {/* slit valve gate between TC and chamber (housing is part of the main model) */}
        <mesh ref={valve} position={[0.8, 1.0, 0]} material={M.steelDark}>
          <boxGeometry args={[0.05, 0.06, 0.4]} />
        </mesh>
        {lid}
      </Clickable>
      <group position={[CHAMBER.x, 0, 0]}>{children}</group>
      {/* the followed wafer */}
      <group ref={wafer}>
        <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184' }}>
          <mesh geometry={waferGeometry()} material={waferMat} castShadow />
        </Clickable>
      </group>
      <TechLabel position={[-1.35, 1.35, 0.35]} title="LOAD LOCK" lines={['atmosphere ↔ vacuum']} min={3} />
      <TechLabel position={[0, 1.45, 0]} title="VACUUM TRANSFER CHAMBER" min={2} />
    </group>
  );
}

/* ---------------------------------------------------------------- chamber internals */

function buildPedestal(k: Kit, mat: THREE.Material, esc: boolean, top: number) {
  // heater / chuck body with a stepped edge (the animated material glows when hot)
  k.cyl(mat, 0.165, 0.06, [0, top - 0.03, 0], Z0, 56);
  k.cyl(mat, 0.17, 0.02, [0, top - 0.07, 0], Z0, 56);
  k.cyl(KM.anodizedDark, 0.12, 0.03, [0, top - 0.095, 0], Z0, 40);
  if (esc) {
    k.cyl(M.ceramic, 0.19, 0.012, [0, top - 0.004, 0], Z0, 56);
    k.torus(KM.ptfe, 0.18, 0.006, [0, top - 0.012, 0], Z0, 48, { cast: false });
  }
  // stem with its bellows down through the chamber floor
  k.cyl(KM.stainlessDark, 0.05, top - 0.11 - CHAMBER.y0, [0, (top - 0.11 + CHAMBER.y0) / 2, 0], Z0, 28);
  bellows(k, 0.065, 0.1, 8, [0, CHAMBER.y0 + 0.02, 0], KM.stainless);
  // lift pins and their hoop under the pedestal
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    k.cyl(M.ceramic, 0.004, 0.12, [Math.cos(a) * 0.1, top - 0.16, Math.sin(a) * 0.1], Z0, 8, { cast: false });
  }
  k.torus(KM.stainless, 0.1, 0.006, [0, top - 0.21, 0], Z0, 32, { cast: false });
}

/** Pedestal / electrostatic chuck with lift pins, centred in the active chamber (local coords). */
export function Pedestal({ heated = false, esc = false, machine, id }: { heated?: boolean; esc?: boolean; machine?: string; id?: string }) {
  const top = CHAMBER.waferY - 0.003;
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: esc ? '#4a4e52' : '#6b6e70', roughness: 0.5, metalness: 0.6, emissive: new THREE.Color('#ff6a1a'), emissiveIntensity: 0, toneMapped: false }), [esc]);
  useFrame(() => {
    if (heated) mat.emissiveIntensity = Math.max(0, (engine.tele.value('wT', engine.tele.value('platen', 25)) - 300) / 600) * 0.6;
  });
  const parts = useFolded((k) => buildPedestal(k, mat, esc, top), [mat, esc, top]);
  return (
    <Clickable sel={{ kind: 'component', id: id ?? (esc ? 'esc' : 'pedestal'), machine: machine ?? (esc ? 'etcher' : 'dep-cluster'), label: esc ? 'Electrostatic chuck' : 'Heated pedestal' }}>
      <Baked parts={parts} />
    </Clickable>
  );
}

function buildShowerhead(k: Kit, y: number) {
  // face plate with drilled holes, backing plate, insulator, gas stem up to the lid
  k.cyl(KM.anodized, 0.2, 0.025, [0, y, 0], Z0, 64);
  k.cyl(KM.anodized, 0.215, 0.012, [0, y + 0.018, 0], Z0, 64);
  k.cyl(KM.ptfe, 0.17, 0.016, [0, y + 0.032, 0], Z0, 48);
  k.cyl(KM.stainless, 0.032, CHAMBER.y1 - 0.025 - (y + 0.04), [0, (CHAMBER.y1 - 0.025 + y + 0.04) / 2, 0], Z0, 20);
  k.torus(KM.seam, 0.2, 0.0015, [0, y - 0.0125, 0], Z0, 64, { cast: false });
  for (const [r, n] of [[0, 1], [0.035, 8], [0.07, 14], [0.105, 20], [0.14, 26], [0.175, 32]] as const)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r * 7;
      k.cyl(KM.seam, 0.0045, 0.002, [Math.cos(a) * r, y - 0.0128, Math.sin(a) * r], Z0, 6, { cast: false });
    }
}

/** Showerhead (gas distribution plate) at the chamber top (local coords). */
export function Showerhead({ y = 1.28, machine = 'dep-cluster' }: { y?: number; machine?: string }) {
  const parts = useFolded((k) => buildShowerhead(k, y), [y]);
  return (
    <Clickable sel={{ kind: 'component', id: 'showerhead', machine, label: 'Showerhead / gas distribution plate' }}>
      <Baked parts={parts} />
    </Clickable>
  );
}
