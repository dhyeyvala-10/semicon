'use client';
/**
 * Wafer (300 mm, notch-oriented), FOUP carrier, load port, wafer-material helpers and the
 * merged-model helpers (one mesh per finish, one shadow caster, pick proxies) they are built with.
 */
import * as THREE from 'three';
import { forwardRef, useMemo, useEffect } from 'react';
import type { ThreeElements } from '@react-three/fiber';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ViewMode, WaferSurface } from '@/types';
import { M, shell } from '../materials';
import { oxideColor } from '@/simulation/models';
import { Kit, grille, ledStrip, type BakedPart } from '../kit/build';
import { KM } from '../kit/finish';
import { casterGeometry, shadowOnly } from '../kit/shadow';

export const WAFER_R = 0.15;
export const WAFER_T = 0.000775;

const geoCache = new Map<string, THREE.BufferGeometry>();

/** Disc with a V-notch at −Z (6 o'clock when viewed from above), UVs mapped 0..1 over the face. */
export function waferGeometry(radius = WAFER_R, thickness = WAFER_T, notch = true): THREE.BufferGeometry {
  const key = `${radius}:${thickness}:${notch}`;
  const hit = geoCache.get(key);
  if (hit) return hit;
  const shape = new THREE.Shape();
  const N = 160;
  const nW = notch ? 0.012 * (radius / WAFER_R) : 0; // half-angle in radians-ish
  const start = -Math.PI / 2 + nW;
  const end = -Math.PI / 2 + Math.PI * 2 - nW;
  shape.moveTo(Math.cos(start) * radius, Math.sin(start) * radius);
  for (let i = 1; i <= N; i++) {
    const a = start + ((end - start) * i) / N;
    shape.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
  }
  if (notch) shape.lineTo(0, -radius + 0.0035 * (radius / WAFER_R));
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -thickness / 2);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) / radius + 1) / 2, (-pos.getZ(i) / radius + 1) / 2);
  uv.needsUpdate = true;
  g.computeVertexNormals();
  geoCache.set(key, g);
  return g;
}

/** Build a wafer top material for a surface state (and optional texture). */
export function waferMaterial(surface: WaferSurface, opts: { map?: THREE.Texture | null; oxideNm?: number } = {}): THREE.Material {
  const map = opts.map ?? null;
  switch (surface) {
    case 'none':
    case 'as-cut':
      return new THREE.MeshStandardMaterial({ color: '#70757b', roughness: 0.82, metalness: 0.45 });
    case 'ground':
    case 'lapped':
      return new THREE.MeshStandardMaterial({ color: '#8a8f95', roughness: 0.62, metalness: 0.5 });
    case 'etched':
      return new THREE.MeshStandardMaterial({ color: '#8d939a', roughness: 0.38, metalness: 0.7 });
    case 'polished':
    case 'planarized':
      return new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.06, metalness: 0.93, map });
    case 'oxide': {
      const [r, g, b] = oxideColor(opts.oxideNm ?? 100);
      return new THREE.MeshPhysicalMaterial({ color: new THREE.Color(r, g, b), roughness: 0.08, metalness: 0.55, clearcoat: 1, clearcoatRoughness: 0.05 });
    }
    case 'film':
      return new THREE.MeshPhysicalMaterial({ color: '#a8946a', roughness: 0.12, metalness: 0.45, clearcoat: 0.8, map });
    case 'resist':
    case 'exposed':
      return new THREE.MeshPhysicalMaterial({ color: map ? '#ffffff' : '#a6582a', roughness: 0.18, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.08, map });
    default:
      return new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.16, metalness: 0.55, clearcoat: 0.6, map });
  }
}

type WaferProps = Omit<ThreeElements['mesh'], 'material'> & {
  surface?: WaferSurface;
  map?: THREE.Texture | null;
  oxideNm?: number;
  material?: THREE.Material;
  radius?: number;
  thickness?: number;
};

/** A single wafer. Pass `material` to control it externally (animated surfaces). */
export const Wafer = forwardRef<THREE.Mesh, WaferProps>(function Wafer({ surface = 'polished', map, oxideNm, material, radius = WAFER_R, thickness = WAFER_T, ...rest }, ref) {
  const geo = useMemo(() => waferGeometry(radius, thickness), [radius, thickness]);
  const mat = useMemo(() => material ?? waferMaterial(surface, { map, oxideNm }), [material, surface, map, oxideNm]);
  useEffect(() => () => {
    if (!material) mat.dispose();
  }, [mat, material]);
  return <mesh ref={ref} geometry={geo} material={mat} castShadow receiveShadow {...rest} />;
});

/* ------------------------------------------------------------------ merged models */

/**
 * A kit model re-merged by finish only. The kit keeps the casting and non-casting parts of one
 * finish in separate bins; here they become one mesh per finish (per shell flag), plus ONE
 * position-only shadow caster for the whole model and, optionally, per-component pick proxies
 * (position-only, never drawn, still raycast) so a whole machine can be one set of meshes while
 * each of its components keeps its own Clickable.
 *
 * Used by the FOUP, the wafer robot and the EFEM / thermal scenes.
 */
export interface MergedModel {
  parts: BakedPart[];
  caster: THREE.BufferGeometry | null;
  /** pick proxies per component tag (tags starting with "_" get none) */
  picks: Record<string, THREE.BufferGeometry>;
}

type Pieces = Record<string, (k: Kit) => void>;

function positionsOf(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  let n = 0;
  for (const g of geos) n += g.attributes.position.array.length;
  if (!n) return null;
  const arr = new Float32Array(n);
  let o = 0;
  for (const g of geos) {
    arr.set(g.attributes.position.array as Float32Array, o);
    o += g.attributes.position.array.length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/** Build a merged model from one builder or from named component builders. */
export function bakeModel(pieces: Pieces | ((k: Kit) => void), o: { shadow?: boolean } = {}): MergedModel {
  const named: Pieces = typeof pieces === 'function' ? { _: pieces } : pieces;
  const bins = new Map<string, { material: THREE.Material; shell: boolean; geos: THREE.BufferGeometry[] }>();
  const picks: Record<string, THREE.BufferGeometry> = {};
  const cast: THREE.BufferGeometry[] = [];
  for (const [tag, fn] of Object.entries(named)) {
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
  const caster = o.shadow === false ? null : casterGeometry(cast);
  const parts: BakedPart[] = [];
  for (const b of bins.values()) {
    const geometry = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
    if (!geometry) continue;
    if (geometry !== b.geos[0]) b.geos.forEach((g) => g.dispose());
    geometry.computeBoundingSphere();
    parts.push({ material: b.material, geometry, shell: b.shell, cast: false });
  }
  return { parts, caster, picks };
}

/** Build once per deps; free the GPU buffers on unmount. */
export function useModel(pieces: Pieces | ((k: Kit) => void), deps: unknown[] = [], o: { shadow?: boolean } = {}): MergedModel {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const m = useMemo(() => bakeModel(pieces, o), deps);
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

/** Render a merged model: one mesh per finish + its shadow caster. Shell parts follow `view`. */
export function ModelView({ m, view = 'normal', pickable = true }: { m: MergedModel; view?: ViewMode; pickable?: boolean }) {
  const caster = useMemo(() => (m.caster ? shadowOnly(m.caster) : null), [m]);
  const ray = pickable ? {} : { raycast: noRay };
  return (
    <>
      {m.parts.map((p, i) => (
        <mesh key={i} geometry={p.geometry} material={p.shell ? shell(p.material, view) : p.material} receiveShadow {...ray} />
      ))}
      {caster && <primitive object={caster} />}
    </>
  );
}

/** Invisible pick proxy of one component of a merged model (put it inside that component's Clickable). */
export function ModelPick({ m, tag }: { m: MergedModel; tag: string }) {
  const g = m.picks[tag];
  return g ? <mesh geometry={g} material={PICK_MAT} visible={false} /> : null;
}

/* ----------------------------- FOUP ----------------------------- */

export const FOUP_DIM = { w: 0.39, h: 0.33, d: 0.34 };
const SLOT_PITCH = 0.01;
const foupWaferMat = new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.08, metalness: 0.9 });

type P2 = [number, number];

/** Plan outline (x, z) of a FOUP-style shell: flat front at xf, back at xb with rounded corners. */
function dPath(xf: number, xb: number, hz: number, R: number, seg = 7): P2[] {
  const p: P2[] = [[xf, hz]];
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI / 2 + (i / seg) * (Math.PI / 2);
    p.push([xb + R + Math.cos(a) * R, hz - R + Math.sin(a) * R]);
  }
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI + (i / seg) * (Math.PI / 2);
    p.push([xb + R + Math.cos(a) * R, -hz + R + Math.sin(a) * R]);
  }
  p.push([xf, -hz]);
  return p;
}

/** Extrude a plan outline (x, z) upward: occupies y0 … y0 + t (bevel included). */
function planSolid(k: Kit, m: THREE.Material, path: P2[], y0: number, t: number, o: { bevel?: number; cast?: boolean } = {}) {
  const b = o.bevel ?? 0;
  k.extrude(m, path.map(([x, z]) => [x, -z] as P2), Math.max(1e-4, t - 2 * b), [0, y0 + b, 0], [-Math.PI / 2, 0, 0], { bevel: b, cast: o.cast });
}

/**
 * FOUP body: polycarbonate shell with rounded back and moulded ribs, top/base plates, door
 * flange with latch slots, robotic (OHT) flange, side handles, 25-slot combs, rear retainer,
 * kinematic-coupling grooves and info pads under the base, carrier-ID tag.
 */
function foupBody(k: Kit) {
  const { w, h, d } = FOUP_DIM;
  const hz = d / 2;
  const xf = w / 2 - 0.014;
  const xb = -w / 2;
  const R = 0.1;
  const t = 0.006;
  // translucent shell walls, open at the door
  const outer = dPath(xf, xb, hz, R);
  const inner = dPath(xf, xb + t, hz - t, R - t).reverse();
  planSolid(k, M.foupShell, [...outer, ...inner], 0.02, h - 0.036, { cast: false });
  // moulded top and base plates
  const plan = dPath(w / 2, xb - 0.002, hz + 0.002, R + 0.002);
  planSolid(k, M.foupDark, plan, h - 0.017, 0.017, { bevel: 0.003 });
  planSolid(k, M.foupDark, plan, 0, 0.021, { bevel: 0.003 });
  // horizontal stiffening rib round the shell at mid height
  planSolid(k, M.foupDark, [...dPath(xf, xb - 0.003, hz + 0.003, R + 0.003), ...dPath(xf, xb + 0.001, hz - 0.001, R - 0.001).reverse()], h * 0.42, 0.008, { cast: false });
  // vertical corner ribs at the back
  for (const s of [-1, 1]) k.rbox(M.foupDark, [0.012, h - 0.03, 0.012], 0.004, [xb + R * 0.3, h / 2, s * (hz - R * 0.3)], [0, s * 0.78, 0]);
  // front flange around the door opening, with the four latch slots the door bolts engage
  const fx = w / 2 - 0.007;
  k.rbox(M.foupDark, [0.014, 0.02, d + 0.006], 0.005, [fx, h - 0.026, 0]);
  k.rbox(M.foupDark, [0.014, 0.02, d + 0.006], 0.005, [fx, 0.03, 0]);
  for (const s of [-1, 1]) k.rbox(M.foupDark, [0.014, h - 0.05, 0.018], 0.005, [fx, h / 2, s * (hz - 0.006)]);
  for (const y of [h - 0.026, 0.03]) for (const z of [-0.08, 0.08]) k.box(KM.seam, [0.016, 0.006, 0.022], [fx, y + (y > h / 2 ? -0.004 : 0.004), z], [0, 0, 0], { cast: false });
  // robotic handling flange (OHT gripper interface): neck, plate with chamfered corners, centring recess
  k.rbox(M.foupDark, [0.07, 0.034, 0.07], 0.01, [0, h + 0.013, 0]);
  const fl: P2[] = [[-0.1, -0.07], [-0.07, -0.1], [0.07, -0.1], [0.1, -0.07], [0.1, 0.07], [0.07, 0.1], [-0.07, 0.1], [-0.1, 0.07]];
  planSolid(k, M.foupDark, fl, h + 0.03, 0.012, { bevel: 0.002 });
  k.cyl(KM.seam, 0.018, 0.002, [0, h + 0.0425, 0], [0, 0, 0], 20, { cast: false });
  for (const s of [-1, 1]) k.box(KM.seam, [0.034, 0.002, 0.008], [s * 0.06, h + 0.0425, 0], [0, 0, 0], { cast: false });
  for (const s of [-1, 1]) k.box(KM.seam, [0.008, 0.002, 0.034], [0, h + 0.0425, s * 0.06], [0, 0, 0], { cast: false });
  // manual side handles on stand-offs
  for (const s of [-1, 1]) {
    k.rbox(M.foupDark, [0.13, 0.024, 0.014], 0.006, [0, h * 0.6, s * (hz + 0.027)]);
    for (const x of [-0.052, 0.052]) k.rbox(M.foupDark, [0.018, 0.024, 0.03], 0.005, [x, h * 0.6, s * (hz + 0.012)]);
  }
  // 25-slot combs on both side walls + rear wafer retainer
  for (const s of [-1, 1]) {
    k.box(M.plastic, [0.16, 0.27, 0.005], [-0.01, 0.17, s * (hz - 0.009)], [0, 0, 0], { cast: false });
    for (let i = 0; i < 25; i++) k.box(M.plastic, [0.15, 0.0022, 0.02], [-0.01, 0.05 + i * SLOT_PITCH - 0.0034, s * (hz - 0.02)], [0, 0, 0], { cast: false });
  }
  k.box(M.plastic, [0.008, 0.26, 0.07], [xb + 0.016, 0.17, 0], [0, 0, 0], { cast: false });
  // kinematic-coupling grooves (match the load-port pins) and carrier info pads under the base
  for (const [x, z] of [[-0.12, -0.12], [0.12, -0.12], [0, 0.14]] as const) {
    const a = Math.atan2(z, x);
    k.box(KM.seam, [0.04, 0.002, 0.012], [x, -0.001, z], [0, -a, 0], { cast: false });
  }
  for (const z of [-0.06, 0.06]) k.cyl(KM.seam, 0.008, 0.002, [-0.15, -0.001, z], [0, 0, 0], 10, { cast: false });
  // carrier ID tag
  k.label('tag', 'F-0731', 'RFID · 300 mm', 0.08, 0.024, [-0.07, h * 0.3, hz + 0.0012]);
}

/** FOUP door (local frame centred on the door): latch-key bosses, ribs, registration holes, latch bolts, seal, retainer. */
function foupDoor(k: Kit) {
  const { h, d } = FOUP_DIM;
  const H = h * 0.96;
  const D = d * 0.98;
  k.rbox(M.foupDark, [0.018, H, D], 0.006);
  for (const y of [-0.118, 0.118]) k.rbox(M.foupDark, [0.006, 0.012, D * 0.84], 0.003, [0.01, y, 0]);
  for (const z of [-0.08, 0.08]) {
    // latch-key boss with its keyway, and the latch bolts it drives out of the door edge
    k.cyl(M.plastic, 0.025, 0.006, [0.011, 0.02, z], [0, 0, Math.PI / 2], 24);
    k.box(KM.seam, [0.002, 0.032, 0.0075], [0.0145, 0.02, z], [0, 0, 0], { cast: false });
    for (const s of [-1, 1]) k.box(M.plastic, [0.008, 0.008, 0.016], [0, s * (H / 2 + 0.002), z], [0, 0, 0], { cast: false });
  }
  for (const [y, z] of [[-0.07, -0.135], [-0.07, 0.135], [0.07, -0.135], [0.07, 0.135]]) k.cyl(KM.seam, 0.007, 0.002, [0.0095, y, z], [0, 0, Math.PI / 2], 12, { cast: false });
  // inner face: perimeter seal and front wafer retainer
  for (const s of [-1, 1]) {
    k.box(KM.seam, [0.003, H - 0.02, 0.006], [-0.0095, 0, s * (D / 2 - 0.012)], [0, 0, 0], { cast: false });
    k.box(KM.seam, [0.003, 0.006, D - 0.02], [-0.0095, s * (H / 2 - 0.012), 0], [0, 0, 0], { cast: false });
  }
  k.rbox(M.plastic, [0.008, H * 0.8, 0.05], 0.003, [-0.012, 0, 0]);
}

/**
 * Closed FOUP added to a kit (static carriers on neighbouring tools, stockers).
 * Origin bottom centre, door toward +X. `wafers` adds a static stack of 25 wafers.
 */
export function buildFoup(k: Kit, wafers = true) {
  foupBody(k);
  k.at([FOUP_DIM.w / 2 + 0.008, FOUP_DIM.h / 2, 0], 0, () => foupDoor(k));
  if (wafers) for (let i = 0; i < 25; i++) k.cyl(M.siPolished, WAFER_R, 0.0008, [0, 0.05 + i * SLOT_PITCH, 0], [0, 0, 0], 36, { cast: false });
}

let FOUP_MODEL: { body: MergedModel; door: MergedModel } | null = null;
/** FOUP geometry is shared by every carrier in every scene (built once, never disposed). */
function foupModel() {
  if (!FOUP_MODEL) FOUP_MODEL = { body: bakeModel(foupBody), door: bakeModel(foupDoor) };
  return FOUP_MODEL;
}

/**
 * FOUP (front-opening unified pod) — 25 slots, front door (+X), OHT flange on top.
 * Local origin: bottom centre. `door` 0 closed … 1 removed. `slots` = which slots hold wafers.
 */
export function FOUP({ door = 0, slots = 25, hideSlot, ...rest }: ThreeElements['group'] & { door?: number; slots?: number; hideSlot?: number }) {
  const { w, h } = FOUP_DIM;
  const model = foupModel();
  const inst = useMemo(() => {
    const m = new THREE.InstancedMesh(waferGeometry(), foupWaferMat, 25);
    m.castShadow = false;
    return m;
  }, []);
  useEffect(() => {
    const o = new THREE.Object3D();
    for (let i = 0; i < 25; i++) {
      const visible = i < slots && i + 1 !== hideSlot;
      o.position.set(0.0, 0.05 + i * SLOT_PITCH, 0);
      o.scale.setScalar(visible ? 1 : 0.0001);
      o.updateMatrix();
      inst.setMatrixAt(i, o.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
  }, [inst, slots, hideSlot]);
  return (
    <group {...rest}>
      <ModelView m={model.body} />
      <primitive object={inst} />
      {/* front door */}
      <group position={[w / 2 + 0.008 + door * 0.06, h / 2 - door * 0.33, 0]} visible={door < 0.999}>
        <ModelView m={model.door} />
      </group>
    </group>
  );
}

export function FoupSlotY(slot: number) {
  return 0.05 + (slot - 1) * SLOT_PITCH;
}

/* --------------------------- load port --------------------------- */

export interface LoadPortOpts {
  /** vertical FIMS port frame against the tool wall (default true) */
  plate?: boolean;
  /** depth of the enclosed opener between the port frame and a tool wall further away */
  tunnel?: number;
  /** port number on the tag */
  n?: number;
}

/**
 * SEMI E15-style load port, in the FOUP frame: carrier door toward +X, tool wall at x ≈ 0.195,
 * operator side toward −X, origin on the floor under the carrier centre. Stage top at 0.897 m
 * with docking plate, three kinematic pins, clamps and presence sensors; FIMS port frame with
 * bezel, E84 optical I/O and status LEDs; pedestal with levelling feet, indicator/button panel,
 * model plate and vent.
 */
export function buildLoadPort(k: Kit, o: LoadPortOpts = {}) {
  // pedestal on a recessed kick plate and levelling feet
  k.box(KM.paintGraphite, [0.32, 0.06, 0.4], [-0.01, 0.03, 0]);
  k.rbox(KM.paint, [0.36, 0.78, 0.44], 0.012, [-0.01, 0.45, 0]);
  k.box(KM.seam, [0.002, 0.0045, 0.42], [-0.1905, 0.34, 0], [0, 0, 0], { cast: false });
  for (const s of [-1, 1]) k.box(KM.seam, [0.34, 0.74, 0.002], [-0.01, 0.46, s * 0.2205], [0, 0, 0], { cast: false });
  for (const [x, z] of [[-0.15, -0.18], [-0.15, 0.18], [0.13, -0.18], [0.13, 0.18]] as const) {
    k.cyl(KM.rubber, 0.022, 0.012, [x, 0.006, z], [0, 0, 0], 12, { cast: false });
    k.cyl(KM.stainless, 0.007, 0.05, [x, 0.03, z], [0, 0, 0], 8, { cast: false });
  }
  k.at([-0.1915, 0.19, 0], -Math.PI / 2, () => grille(k, 0.28, 0.13, [0, 0, 0], { m: KM.paint }));
  k.at([-0.19, 0.0, 0], -Math.PI / 2, () => {
    k.label('model', 'LP-300', 'LOAD PORT · E15.1', 0.2, 0.05, [0, 0.52, 0.002]);
    // indicator panel: LOAD · UNLOAD · AUTO · MANUAL · RESERVE · ALARM, two push buttons
    k.rbox(KM.plastic, [0.24, 0.1, 0.01], 0.003, [0, 0.72, 0.004]);
    for (let i = 0; i < 6; i++) k.cyl(i === 0 || i === 2 ? KM.ledGreen : KM.seam, 0.006, 0.004, [-0.09 + i * 0.036, 0.745, 0.01], [Math.PI / 2, 0, 0], 12, { cast: false });
    k.cyl(KM.paintBlue, 0.014, 0.012, [-0.04, 0.7, 0.012], [Math.PI / 2, 0, 0], 20, { cast: false });
    k.cyl(KM.paintAccent, 0.014, 0.012, [0.04, 0.7, 0.012], [Math.PI / 2, 0, 0], 20, { cast: false });
  });
  // stage + docking plate (slides the carrier toward the port)
  k.rbox(KM.paint, [0.42, 0.045, 0.48], 0.01, [-0.04, 0.8625, 0]);
  k.rbox(KM.anodized, [0.36, 0.012, 0.4], 0.004, [-0.03, 0.891, 0]);
  k.box(KM.seam, [0.37, 0.002, 0.41], [-0.03, 0.8852, 0], [0, 0, 0], { cast: false });
  for (const s of [-1, 1]) k.box(KM.seam, [0.3, 0.003, 0.006], [-0.03, 0.8975, s * 0.1], [0, 0, 0], { cast: false });
  // kinematic coupling pins
  for (const [x, z] of [[0.12, 0.12], [-0.12, 0.12], [0, -0.14]] as const) {
    k.cyl(KM.seam, 0.014, 0.001, [x, 0.8975, z], [0, 0, 0], 16, { cast: false });
    k.cyl(KM.stainless, 0.009, 0.006, [x, 0.9, z], [0, 0, 0], 16, { cast: false });
    k.lathe(KM.chrome, [[0.009, 0], [0.008, 0.003], [0.0055, 0.0055], [0.0001, 0.007]], [x, 0.903, z], [0, 0, 0], 12, { cast: false });
  }
  // carrier clamps and placement/presence sensors
  for (const z of [-0.175, 0.175]) k.rbox(KM.paintGraphite, [0.05, 0.016, 0.024], 0.005, [-0.16, 0.904, z]);
  for (const [x, z] of [[0.05, 0.16], [-0.17, -0.03], [0.05, -0.16]] as const) k.cyl(KM.plastic, 0.007, 0.006, [x, 0.899, z], [0, 0, 0], 12, { cast: false });
  if (o.plate !== false) {
    // FIMS port frame with the carrier-door opening
    const px = 0.1825;
    k.rbox(KM.paint, [0.025, 0.9, 0.5], 0.006, [px, 0.45, 0]);
    k.rbox(KM.paint, [0.025, 0.2, 0.5], 0.006, [px, 1.34, 0]);
    for (const s of [-1, 1]) k.rbox(KM.paint, [0.025, 0.36, 0.07], 0.004, [px, 1.07, s * 0.215]);
    k.box(KM.anodizedDark, [0.01, 0.016, 0.39], [0.166, 1.248, 0]);
    for (const s of [-1, 1]) k.box(KM.anodizedDark, [0.01, 0.36, 0.016], [0.166, 1.07, s * 0.188]);
    for (const [y, z] of [[1.2, -0.2], [1.2, 0.2], [0.95, -0.2], [0.95, 0.2], [1.4, -0.21], [1.4, 0.21]] as const) k.cyl(KM.stainlessDark, 0.005, 0.004, [0.169, y, z], [0, 0, Math.PI / 2], 8, { cast: false });
    // E84 optical I/O on top, status bar and port tag
    k.rbox(KM.paintGraphite, [0.07, 0.04, 0.1], 0.008, [0.15, 1.46, 0.15]);
    k.cyl(KM.glassSmoke, 0.016, 0.004, [0.15, 1.481, 0.15], [0, 0, 0], 20, { cast: false });
    k.at([0.168, 1.3, 0], -Math.PI / 2, () => ledStrip(k, 0.3, [0, 0, 0], KM.ledGreen));
    k.label('info', `LP ${o.n ?? 2}`, 'E84 · AUTO', 0.08, 0.032, [0.169, 1.385, -0.15], [0, -Math.PI / 2, 0]);
  }
  if (o.tunnel) {
    k.rbox(KM.paint, [o.tunnel, 0.6, 0.5], 0.006, [0.195 + o.tunnel / 2, 1.14, 0]);
    k.box(KM.paintGraphite, [o.tunnel, 0.84, 0.42], [0.195 + o.tunnel / 2, 0.42, 0]);
  }
  k.ao(0.42, 0.5, [-0.03, 0, 0]);
}

/** Simple load port: platform at 0.9 m with kinematic pins and FIMS port frame (carrier door toward +X). */
export function LoadPort({ position, rotation }: { position?: [number, number, number]; rotation?: [number, number, number] }) {
  const m = useModel((k) => buildLoadPort(k));
  return (
    <group position={position} rotation={rotation}>
      <ModelView m={m} />
    </group>
  );
}
