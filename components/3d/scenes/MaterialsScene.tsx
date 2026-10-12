'use client';
/**
 * Raw material → semiconductor-grade polysilicon (§11).
 * Four stations in one hall: quartz quarry/crusher · submerged arc furnace ·
 * hydrochlorination & distillation · Siemens reactor. Each has an atomic-scale inset.
 *
 * Static equipment is built with the detailing kit (merged per finish, one mesh per
 * material per model). Animated parts — lumps, flywheel, screen deck, melt, ladle fill,
 * rods, bell jar — stay separate and keep their refs, pivots and paths.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, Hall } from '../environments';
import { M } from '../materials';
import { GEO, type V3 } from '../parts/primitives';
import { Clickable, SensorIndicator, TechLabel } from '../parts/interaction';
import { Inset, FlowLine } from '../parts/section';
import { AtomModel, silicaNetwork, tcsMolecule, diamondLattice, type Atom } from '../parts/atoms';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Kit, type BakedPart, type PartOpts, cabinet, boltCircle, viewport, bellows, grille, windowPane, iBeam, handrail, gasStick, hmi, estop, ledStrip } from '../kit/build';
import { KM, labelMaterial } from '../kit/finish';
import { Baked, useKit } from '../kit/Baked';
import { useUI } from '@/lib/store';
import { engine } from '@/simulation/engine';
import { pp, inPhase, pdt } from '@/lib/anim';
import { track, cutPlane } from '@/lib/runtime';
import { rng, smooth, clamp } from '@/lib/math';

const X = { quartz: -30, arc: -10, distill: 10, siemens: 30 };

const quartzMat = new THREE.MeshStandardMaterial({ color: '#e3e1d9', roughness: 0.55, metalness: 0.05 });
const mgSiMat = new THREE.MeshStandardMaterial({ color: '#7d8186', roughness: 0.45, metalness: 0.75 });
const polyMat = new THREE.MeshStandardMaterial({ color: '#8c9196', roughness: 0.35, metalness: 0.85 });
const moltenMat = new THREE.MeshStandardMaterial({ color: '#ffcf8a', emissive: new THREE.Color('#ff7a1a'), emissiveIntensity: 2.2, roughness: 0.3, toneMapped: false });
const refractory = new THREE.MeshStandardMaterial({ color: '#5a4a3e', roughness: 0.9 });
const belt = new THREE.MeshStandardMaterial({ color: '#202224', roughness: 0.85 });
/** cast concrete: the kit's paint noise as surface texture */
const concrete = (() => {
  const m = KM.paintGrey.clone();
  m.color.set('#8a8983');
  m.roughness = 0.93;
  m.metalness = 0;
  m.bumpScale = 0.7;
  return m;
})();
/** site-vehicle orange */
const orange = (() => {
  const m = KM.paintYellow.clone();
  m.color.set('#c2672b');
  return m;
})();
/** bright process stainless and aluminium insulation jacketing: partly metallic so they read light in the dim hall */
const ss = (() => {
  const m = KM.stainless.clone();
  m.color.set('#d7dadc');
  m.metalness = 0.55;
  m.roughness = 0.34;
  return m;
})();
const clad = (() => {
  const m = KM.anodized.clone();
  m.color.set('#c5c9cb');
  m.metalness = 0.35;
  m.roughness = 0.55;
  return m;
})();
const gravelMat = new THREE.MeshStandardMaterial({ color: '#b9b5aa', roughness: 0.96, metalness: 0 });
/** furnace burden (quartz + coke + wood chips) below the visible charge surface */
const burdenMat = new THREE.MeshStandardMaterial({ color: '#3a2e26', roughness: 0.95, metalness: 0 });

const rockGeo = (() => {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const p = g.attributes.position;
  const r = rng(4);
  const seen = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    const f = seen.get(k) ?? 0.6 + r() * 0.8;
    seen.set(k, f);
    p.setXYZ(i, p.getX(i) * f, p.getY(i) * f * 0.8, p.getZ(i) * f);
  }
  g.computeVertexNormals();
  return g;
})();

function Comp({ id, machine, label, children, position }: { id: string; machine: string; label: string; children: React.ReactNode; position?: V3 }) {
  return (
    <Clickable sel={{ kind: 'component', id, machine, label }} position={position}>
      {children}
    </Clickable>
  );
}

/**
 * useKit + a second merge: bins that share a finish (and shell flag) but differ only in the
 * cast-shadow flag become one mesh, so each finish costs one draw call per model.
 */
function useModel(fn: (k: Kit) => void, deps: unknown[] = []): BakedPart[] {
  const raw = useKit(fn, deps);
  const parts = useMemo(() => {
    const groups = new Map<string, BakedPart[]>();
    for (const p of raw) {
      const key = `${p.material.uuid}:${p.shell ? 1 : 0}`;
      const g = groups.get(key);
      if (g) g.push(p);
      else groups.set(key, [p]);
    }
    const out: BakedPart[] = [];
    for (const g of groups.values()) {
      if (g.length === 1) {
        out.push(g[0]);
        continue;
      }
      const geometry = mergeGeometries(g.map((p) => p.geometry), false);
      if (!geometry) {
        out.push(...g);
        continue;
      }
      geometry.computeBoundingSphere();
      out.push({ material: g[0].material, geometry, shell: g[0].shell, cast: g.some((p) => p.cast) });
    }
    return out;
  }, [raw]);
  useEffect(() => () => parts.forEach((p) => !raw.includes(p) && p.geometry.dispose()), [parts, raw]);
  return parts;
}

/* ------------------------------------------------------------ path movers */

function pathPoint(path: V3[], t: number): THREE.Vector3 {
  const segs = path.length - 1;
  const x = clamp(t) * segs;
  const i = Math.min(segs - 1, Math.floor(x));
  const u = x - i;
  const a = path[i];
  const b = path[i + 1];
  return new THREE.Vector3(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
}

/* ======================================================================
   Local detail recipes (kit). Convention as in the kit: +Y up, +Z front.
   ====================================================================== */

type P2 = [number, number];
const HP = Math.PI / 2;
const TAU = Math.PI * 2;
const _v = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _qq = new THREE.Quaternion();
const _ee = new THREE.Euler();

/** Lathe profile with crisp corners: interior points are doubled so normals don't smear across edges. */
function crisp(p: P2[]): P2[] {
  const out: P2[] = [];
  p.forEach((q, i) => {
    out.push(q);
    if (i > 0 && i < p.length - 1) {
      const n = p[i + 1];
      out.push([q[0] + (n[0] - q[0]) * 1e-3, q[1] + (n[1] - q[1]) * 1e-3]);
    }
  });
  return out;
}

/** Washer / band around Y: radii r0..r1 between heights y0 and y1. */
function ring(k: Kit, m: THREE.Material, r0: number, r1: number, y0: number, y1: number, seg = 48, o: PartOpts = {}) {
  k.lathe(m, crisp([[r0, y0], [r1, y0], [r1, y1], [r0, y1], [r0, y0]]), [0, 0, 0], [0, 0, 0], seg, o);
}

/** Local frame on a vertical vessel: radius R, angle a (from +X towards +Z), height y. Local +Z points outward. */
function radial(k: Kit, R: number, a: number, y: number, fn: () => void) {
  k.at([Math.cos(a) * R, y, Math.sin(a) * R], [0, HP - a, 0], fn);
}

/** Rotation that turns +Y onto the direction a → b; returns [euler, length, midpoint]. */
function aim(a: V3, b: V3): [V3, number, V3] {
  _v.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = _v.length();
  _qq.setFromUnitVectors(_up, _v.normalize());
  _ee.setFromQuaternion(_qq);
  return [[_ee.x, _ee.y, _ee.z], len, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]];
}

/** Square-section member between two points (bracing, struts, legs). */
function strut(k: Kit, m: THREE.Material, a: V3, b: V3, t = 0.06, o: PartOpts = {}) {
  const [rot, len, mid] = aim(a, b);
  k.box(m, [t, len, t], mid, rot, o);
}

/** Round bar / pipe between two points. */
function rod(k: Kit, m: THREE.Material, a: V3, b: V3, r: number, seg = 12, o: PartOpts = {}) {
  const [rot, len, mid] = aim(a, b);
  k.cyl(m, r, len, mid, rot, seg, o);
}

/** 2:1 ellipsoidal head profile from the rim at height y (dir 1 = up, -1 = down). */
function head(r: number, y: number, dir: 1 | -1, n = 10): P2[] {
  const p: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * HP;
    p.push([Math.max(1e-3, r * Math.cos(t)), y + dir * (r / 2) * Math.sin(t)]);
  }
  return dir > 0 ? p : p.reverse();
}

/** Flanged nozzle along local +Z from the origin. */
function nozzle(k: Kit, r: number, len: number, o: PartOpts = {}, m: THREE.Material = ss) {
  k.cyl(m, r, len, [0, 0, len / 2], [HP, 0, 0], 16, o);
  const ft = Math.max(0.018, r * 0.4);
  k.cyl(m, r * 1.8, ft, [0, 0, len - ft / 2], [HP, 0, 0], 20, o);
  k.cyl(m, r * 1.8, ft, [0, 0, len + ft / 2 + 0.002], [HP, 0, 0], 20, o);
  const n = r > 0.07 ? 8 : 4;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + 0.4;
    k.cyl(KM.stainlessDark, Math.max(0.006, r * 0.15), ft * 2 + 0.02, [Math.cos(a) * r * 1.45, Math.sin(a) * r * 1.45, len], [HP, 0, 0], 6, { cast: false, ...o });
  }
}

/** Manway along local +Z: neck, bolted blind cover, davit and handle. */
function manway(k: Kit, r: number, len: number, o: PartOpts = {}, m: THREE.Material = ss) {
  k.cyl(m, r, len, [0, 0, len / 2], [HP, 0, 0], 28, o);
  k.cyl(m, r * 1.3, 0.035, [0, 0, len], [HP, 0, 0], 32, o);
  k.cyl(m, r * 1.3, 0.035, [0, 0, len + 0.037], [HP, 0, 0], 32, o);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    k.cyl(KM.stainlessDark, 0.011, 0.1, [Math.cos(a) * r * 1.16, Math.sin(a) * r * 1.16, len + 0.02], [HP, 0, 0], 6, { cast: false, ...o });
  }
  k.cyl(KM.stainlessDark, 0.018, 0.22, [r * 1.45, 0, len - 0.04], [0, 0, 0], 8, o);
  k.box(KM.stainlessDark, [r * 1.45, 0.024, 0.024], [r * 0.72, 0.08, len + 0.07], [0, 0, 0], o);
  k.box(KM.stainlessDark, [r * 0.8, 0.02, 0.02], [0, -r * 0.45, len + 0.09], [0, 0, 0], o);
}

/** Insulated vessel shell: aluminium cladding courses with overlap steps and stainless bands. */
function cladding(k: Kit, R: number, y0: number, y1: number, o: PartOpts = {}, course = 0.9) {
  const n = Math.max(1, Math.round((y1 - y0) / course));
  const h = (y1 - y0) / n;
  for (let i = 0; i < n; i++) {
    k.cyl(clad, R + (i % 2) * 0.004, h, [0, y0 + (i + 0.5) * h, 0], [0, 0, 0], 48, { ...o, open: true });
    if (i > 0) k.cyl(ss, R + 0.009, 0.02, [0, y0 + i * h, 0], [0, 0, 0], 48, { ...o, open: true, cast: false });
  }
}

/** Grating platform around a vertical vessel: annular sector r0..r1 at height y from angle a0 to a1. */
function circPlatform(k: Kit, r0: number, r1: number, y: number, a0: number, a1: number) {
  const arc = a1 - a0;
  const n = Math.max(6, Math.ceil(arc / 0.1));
  const shape: P2[] = [];
  for (let i = 0; i <= n; i++) shape.push([Math.cos(a0 + (arc * i) / n) * r1, Math.sin(a0 + (arc * i) / n) * r1]);
  for (let i = n; i >= 0; i--) shape.push([Math.cos(a0 + (arc * i) / n) * r0, Math.sin(a0 + (arc * i) / n) * r0]);
  k.extrude(KM.steel, shape, 0.035, [0, y, 0], [HP, 0, 0]);
  // grating bars
  const rm = (r0 + r1) / 2;
  const bars = Math.floor((arc * rm) / 0.085);
  for (let i = 0; i <= bars; i++) radial(k, rm, a0 + (arc * i) / bars, y + 0.004, () => k.box(KM.stainlessDark, [0.012, 0.008, r1 - r0 - 0.03], [0, 0, 0], [0, 0, 0], { cast: false }));
  // toe plate and two-rail handrail
  k.add(KM.paintYellow, new THREE.CylinderGeometry(r1, r1, 0.1, n, 1, true, HP - a1, arc), [0, y + 0.05, 0]);
  for (const hh of [0.55, 1.05]) k.at([0, y + hh, 0], [0, -a0, 0], () => k.add(KM.paintYellow, new THREE.TorusGeometry(r1 - 0.025, hh > 1 ? 0.02 : 0.015, 6, n, arc), [0, 0, 0], [HP, 0, 0]));
  const posts = Math.max(2, Math.ceil((arc * r1) / 1.1) + 1);
  for (let i = 0; i < posts; i++) {
    const a = a0 + (arc * i) / (posts - 1);
    k.cyl(KM.paintYellow, 0.02, 1.05, [Math.cos(a) * (r1 - 0.025), y + 0.525, Math.sin(a) * (r1 - 0.025)], [0, 0, 0], 8);
  }
  // radial support beams with knee braces
  const br = Math.max(2, Math.ceil((arc * r0) / 1.0));
  for (let i = 0; i <= br; i++)
    radial(k, 0, a0 + (arc * i) / br, y, () => {
      k.box(KM.paintGrey, [0.06, 0.1, r1 - r0], [0, -0.085, (r0 + r1) / 2]);
      const dz = r1 - r0 - 0.1;
      k.box(KM.paintGrey, [0.05, Math.hypot(dz, 0.5), 0.05], [0, -0.38, r0 + dz / 2], [Math.atan2(dz, 0.5), 0, 0]);
    });
}

/** Vertical ladder: stiles along local Y, climbing side +Z, safety cage above 2.3 m. */
function ladder(k: Kit, y0: number, y1: number, cage = true) {
  const m = KM.paintYellow;
  const h = y1 - y0;
  for (const s of [-1, 1]) k.box(m, [0.05, h + 1.0, 0.014], [s * 0.21, y0 + (h + 1.0) / 2, 0]);
  for (let y = y0 + 0.3; y < y1; y += 0.3) k.cyl(m, 0.011, 0.42, [0, y, 0], [0, 0, HP], 6, { cast: false });
  if (cage && h > 2.6) {
    const c0 = y0 + 2.3;
    const c1 = y1 + 0.9;
    for (let y = c0; y <= c1 + 1e-6; y += 0.9) k.add(m, new THREE.TorusGeometry(0.36, 0.012, 4, 14, Math.PI), [0, y, 0], [HP, 0, 0]);
    for (const a of [0.3, 0.95, 1.57, 2.2, 2.85]) k.box(m, [0.04, c1 - c0, 0.006], [Math.cos(a) * 0.36, (c0 + c1) / 2, Math.sin(a) * 0.36], [0, HP - a, 0], { cast: false });
  }
}

/** Square hopper: bottom half-side b, top half-side t, height h; origin at the bottom centre. */
function hopper(k: Kit, b: number, t: number, h: number, m: THREE.Material, rim: THREE.Material, o: PartOpts = {}) {
  const s = Math.hypot(t - b, h);
  const th = Math.atan2(t - b, h);
  const shape: P2[] = [[-b, 0], [b, 0], [t, s], [-t, s]];
  for (let i = 0; i < 4; i++)
    k.at([0, 0, 0], [0, i * HP, 0], () => {
      k.extrude(m, shape, 0.014, [0, 0, b], [th, 0, 0], o);
      k.box(rim, [2 * t + 0.1, 0.06, 0.06], [0, h + 0.03, t + 0.03], [0, 0, 0], o);
      k.box(rim, [b + t + 0.06, 0.04, 0.035], [0, h / 2, (b + t) / 2 + 0.035], [th, 0, 0], o);
    });
  k.box(KM.seam, [2 * b, 0.01, 2 * b], [0, 0.01, 0], [0, 0, 0], { cast: false, ...o });
}

/** Gate valve with handwheel on a pipe along `axis`. */
function valve(k: Kit, pos: V3, axis: 'x' | 'y' | 'z', r: number) {
  const rot: V3 = axis === 'x' ? [0, 0, HP] : axis === 'z' ? [HP, 0, 0] : [0, 0, 0];
  const along = (d: number): V3 => (axis === 'x' ? [d, 0, 0] : axis === 'y' ? [0, d, 0] : [0, 0, d]);
  const L = r * 3;
  k.at(pos, 0, () => {
    k.cyl(KM.stainlessDark, r * 1.45, L, [0, 0, 0], rot, 16);
    for (const s of [-1, 1]) k.cyl(ss, r * 1.9, r * 0.5, along((s * L) / 2), rot, 20);
    const sl = r * 4;
    const stem: V3 = axis === 'y' ? [sl / 2, 0, 0] : [0, sl / 2, 0];
    k.cyl(KM.stainlessDark, r * 0.7, sl, stem, axis === 'y' ? [0, 0, HP] : [0, 0, 0], 12);
    const hw: V3 = axis === 'y' ? [sl + 0.01, 0, 0] : [0, sl + 0.01, 0];
    k.add(KM.paintRed, new THREE.TorusGeometry(r * 2.2, r * 0.2, 6, 20), hw, axis === 'y' ? [0, HP, 0] : [HP, 0, 0]);
  });
}

/** Centrifugal pump skid (end suction along local −X, discharge up). Origin on the floor. */
function pump(k: Kit, pos: V3, yaw = 0) {
  k.at(pos, yaw, () => {
    k.box(KM.paintGraphite, [1.15, 0.08, 0.42], [0.12, 0.04, 0]);
    k.cyl(KM.paintBlue, 0.2, 0.15, [-0.25, 0.32, 0], [0, 0, HP], 24);
    k.cyl(KM.paintBlue, 0.07, 0.2, [-0.42, 0.32, 0], [0, 0, HP], 16);
    k.cyl(KM.paintBlue, 0.06, 0.22, [-0.25, 0.53, 0], [0, 0, 0], 16);
    k.cyl(KM.paintBlue, 0.1, 0.03, [-0.25, 0.64, 0], [0, 0, 0], 16);
    k.box(KM.paintBlue, [0.16, 0.18, 0.22], [-0.25, 0.17, 0]);
    k.cyl(KM.paintBlue, 0.08, 0.22, [-0.07, 0.32, 0], [0, 0, HP], 16);
    k.rbox(KM.paintYellow, [0.18, 0.17, 0.17], 0.02, [0.12, 0.32, 0]);
    k.cyl(KM.paintGrey, 0.15, 0.44, [0.43, 0.32, 0], [0, 0, HP], 24);
    for (let i = 0; i < 10; i++) {
      const a = -0.6 + (i / 9) * (Math.PI + 1.2);
      k.box(KM.paintGrey, [0.4, 0.03, 0.008], [0.43, 0.32 + Math.sin(a) * 0.16, Math.cos(a) * 0.16], [HP - a, 0, 0], { cast: false });
    }
    k.rbox(KM.paintGrey, [0.12, 0.1, 0.12], 0.01, [0.43, 0.5, 0.08]);
    k.cyl(KM.paintGraphite, 0.155, 0.05, [0.67, 0.32, 0], [0, 0, HP], 24);
    k.box(KM.paintGrey, [0.3, 0.16, 0.3], [0.43, 0.12, 0]);
  });
}

/** Horizontal I-beam from a to b (axis-aligned along X or Z); a[1] is the top of steel. */
function girder(k: Kit, a: V3, b: V3, d = 0.3, bf = 0.16, m: THREE.Material = KM.paintGrey) {
  const alongX = Math.abs(b[0] - a[0]) > Math.abs(b[2] - a[2]);
  const len = alongX ? Math.abs(b[0] - a[0]) : Math.abs(b[2] - a[2]);
  const cx = (a[0] + b[0]) / 2;
  const cz = (a[2] + b[2]) / 2;
  const s = (l: number, h: number, w: number): V3 => (alongX ? [l, h, w] : [w, h, l]);
  k.box(m, s(len, 0.02, bf), [cx, a[1] - 0.01, cz]);
  k.box(m, s(len, 0.02, bf), [cx, a[1] - d + 0.01, cz]);
  k.box(m, s(len, d - 0.04, 0.014), [cx, a[1] - d / 2, cz]);
}

/** Bar-grating deck (w × d) with its top at y, centred at (x, z). */
function grating(k: Kit, w: number, d: number, pos: V3, pitch = 0.1) {
  k.box(KM.steel, [w, 0.035, d], [pos[0], pos[1] - 0.0175, pos[2]]);
  const n = Math.floor(d / pitch);
  for (let i = 0; i <= n; i++) k.box(KM.stainlessDark, [w - 0.02, 0.008, 0.012], [pos[0], pos[1] + 0.004, pos[2] - d / 2 + (i * d) / n], [0, 0, 0], { cast: false });
}

/* --- label atlas: every plate in the scene shares one texture, so a model's labels are one draw call */

type LabelKind = Parameters<typeof labelMaterial>[0];
const ATLAS_W = 2048;
const ATLAS_H = 1024;
let atlas: { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; mat: THREE.MeshStandardMaterial; x: number; y: number; row: number; slots: Map<string, [number, number, number, number]> } | null = null;
function labelAtlas() {
  if (atlas) return atlas;
  const c = document.createElement('canvas');
  c.width = ATLAS_W;
  c.height = ATLAS_H;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  atlas = { ctx: c.getContext('2d')!, tex, mat, x: 0, y: 0, row: 0, slots: new Map() };
  return atlas;
}
/** UV rectangle [u0, v0, u1, v1] of a label drawn by the kit's label painter into the atlas. */
function atlasSlot(kind: LabelKind, text: string, sub: string, accent?: string) {
  const A = labelAtlas();
  const key = `${kind}|${text}|${sub}|${accent ?? ''}`;
  const hit = A.slots.get(key);
  if (hit) return hit;
  const src = labelMaterial(kind, text, sub, accent).map!.image as HTMLCanvasElement;
  const w = kind === 'warn' ? 128 : src.width;
  const h = kind === 'warn' ? 128 : src.height;
  const pad = 4;
  if (A.x + w > ATLAS_W) {
    A.x = 0;
    A.y += A.row + pad;
    A.row = 0;
  }
  A.ctx.drawImage(src, A.x, A.y, w, h);
  const slot: [number, number, number, number] = [A.x / ATLAS_W, 1 - (A.y + h) / ATLAS_H, (A.x + w) / ATLAS_W, 1 - A.y / ATLAS_H];
  A.x += w + pad;
  A.row = Math.max(A.row, h);
  A.tex.needsUpdate = true;
  A.slots.set(key, slot);
  return slot;
}
/** Label plate (model plate, hazard sign, gas tag) facing local +Z, drawn from the shared atlas. */
function plate(k: Kit, kind: LabelKind, text: string, sub: string, w: number, h: number, pos: V3, rot: V3 = [0, 0, 0], accent?: string, shell = false) {
  const [u0, v0, u1, v1] = atlasSlot(kind, text, sub, accent);
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  k.add(labelAtlas().mat, g, pos, rot, [1, 1, 1], { cast: false, keepUV: true, shell });
}
/** Label plate that follows x-ray / cut-away with the shell it is mounted on. */
function shellLabel(k: Kit, kind: LabelKind, text: string, sub: string, w: number, h: number, pos: V3, rot: V3 = [0, 0, 0], accent?: string) {
  plate(k, kind, text, sub, w, h, pos, rot, accent, true);
}

/** Ladder-type cable tray from a to b (horizontal) with a cable bundle, in steel + jacket finishes. */
function tray(k: Kit, a: V3, b: V3, w = 0.4, cables = 5) {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const len = Math.hypot(dx, dz);
  k.at(a, [0, Math.atan2(dx, dz), 0], () => {
    for (const s of [-1, 1]) k.box(KM.steel, [0.005, 0.06, len], [(s * w) / 2, 0.03, len / 2], [0, 0, 0], { cast: false });
    const rungs = Math.max(1, Math.floor(len / 0.3));
    for (let i = 0; i <= rungs; i++) k.box(KM.steel, [w, 0.008, 0.02], [0, 0.004, (i * len) / rungs], [0, 0, 0], { cast: false });
    for (let i = 0; i < cables; i++) {
      const x = -w / 2 + 0.04 + (i * (w - 0.08)) / Math.max(1, cables - 1);
      k.cyl(i % 2 ? KM.rubber : KM.paintGraphite, 0.012 + (i % 3) * 0.003, len, [x, 0.02 + (i % 2) * 0.012, len / 2], [HP, 0, 0], 8, { cast: false });
    }
  });
}

/** Hanging hose / flexible cable between two points (light catenary: 6 points, 6 sides). */
function sagHose(k: Kit, a: V3, b: V3, r: number, sag: number, m: THREE.Material = KM.rubber) {
  const pts: V3[] = [];
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t]);
  }
  k.tube(m, pts, r, { radial: 6, tension: 0.5 });
}

/* ======================================================================
   1 · quartz yard: stockpile, feed conveyor, jaw crusher, screen, loadout
   ====================================================================== */

/** Troughed belt conveyor whose carrying surface runs a → b (same z), with trestles under it. */
function conveyor(k: Kit, a: V3, b: V3, o: { w?: number; legs?: number[]; drive?: boolean; skirt?: boolean; cord?: boolean } = {}) {
  const w = o.w ?? 0.72;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx);
  const half = len / 2;
  const cw = w * 0.56;
  const ww = w * 0.24;
  const tr = 0.38;
  const wy = -0.007 + (Math.sin(tr) * ww) / 2;
  const wz = cw / 2 + (Math.cos(tr) * ww) / 2;
  const fz = w / 2 + 0.09;
  k.at([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, a[2]], [0, 0, ang], () => {
    // carrying belt: flat centre + two troughed wings, return strand below
    k.box(belt, [len, 0.014, cw], [0, -0.007, 0]);
    for (const s of [-1, 1]) k.box(belt, [len, 0.014, ww], [0, wy, s * wz], [-s * tr, 0, 0]);
    k.box(belt, [len - 0.2, 0.01, w * 0.9], [0, -0.27, 0], [0, 0, 0], { cast: false });
    // channel stringers
    for (const s of [-1, 1]) {
      k.box(KM.paintGrey, [len, 0.17, 0.012], [0, -0.175, s * fz]);
      k.box(KM.paintGrey, [len, 0.012, 0.06], [0, -0.096, s * (fz - 0.024)]);
      k.box(KM.paintGrey, [len, 0.012, 0.06], [0, -0.254, s * (fz - 0.024)]);
    }
    // troughing idler sets
    const n = Math.max(2, Math.floor(len / 0.6));
    for (let i = 0; i <= n; i++) {
      const x = -half + 0.2 + (i * (len - 0.4)) / n;
      k.cyl(KM.steel, 0.045, cw - 0.02, [x, -0.06, 0], [HP, 0, 0], 10);
      for (const s of [-1, 1]) k.cyl(KM.steel, 0.045, ww - 0.02, [x, wy - 0.053, s * wz], [HP - s * tr, 0, 0], 10);
      k.box(KM.paintGrey, [0.05, 0.035, w + 0.2], [x, -0.122, 0], [0, 0, 0], { cast: false });
      for (const s of [-1, 1]) k.box(KM.paintGrey, [0.04, 0.09, 0.03], [x, -0.075, s * (cw / 2 + ww)], [0, 0, 0], { cast: false });
    }
    // return idlers
    for (let x = -half + 0.7; x < half - 0.4; x += 1.4) k.cyl(KM.steel, 0.04, w, [x, -0.31, 0], [HP, 0, 0], 10, { cast: false });
    // head & tail pulleys (belt wrapped), bearing blocks and take-up
    for (const x of [-half, half]) {
      k.cyl(belt, 0.137, w * 0.94, [x, -0.137, 0], [HP, 0, 0], 20);
      k.cyl(KM.steel, 0.032, w + 0.34, [x, -0.137, 0], [HP, 0, 0], 8);
      for (const s of [-1, 1]) k.rbox(KM.paintGraphite, [0.13, 0.1, 0.06], 0.012, [x, -0.137, s * (fz + 0.05)]);
    }
    // scraper under the head pulley
    k.box(KM.paintYellow, [0.04, 0.12, w * 0.9], [half - 0.14, -0.3, 0], [0, 0, 0.5]);
    if (o.drive) {
      // shaft-mounted reducer + motor + torque arm
      k.rbox(KM.paintAccent, [0.3, 0.32, 0.2], 0.03, [half, -0.137, fz + 0.2]);
      k.cyl(KM.paintAccent, 0.11, 0.36, [half - 0.32, -0.08, fz + 0.2], [0, 0, HP], 20);
      k.cyl(KM.paintGraphite, 0.115, 0.04, [half - 0.52, -0.08, fz + 0.2], [0, 0, HP], 20);
      k.box(KM.paintGrey, [0.04, 0.4, 0.04], [half + 0.05, -0.4, fz + 0.2]);
      // guard over the tail of the drive
      k.box(KM.paintYellow, [0.36, 0.3, 0.012], [half, -0.137, fz + 0.32]);
    }
    if (o.skirt) for (const s of [-1, 1]) k.box(KM.steel, [1.0, 0.13, 0.012], [-half + 0.65, 0.07, s * (cw / 2 - 0.01)], [s * 0.15, 0, 0]);
    if (o.cord) {
      // emergency pull-cord with switch boxes
      const y = 0.2;
      k.cyl(KM.paintRed, 0.005, len - 0.3, [0, y, fz + 0.03], [0, 0, HP], 5, { cast: false });
      for (let x = -half + 0.15; x <= half - 0.1; x += 1.0) k.box(KM.paintGrey, [0.025, 0.42, 0.025], [x, 0.0, fz + 0.03], [0, 0, 0], { cast: false });
      for (const x of [-half + 0.15, half - 0.15]) k.rbox(KM.paintYellow, [0.1, 0.14, 0.08], 0.01, [x, y - 0.02, fz + 0.08]);
    }
  });
  // world-vertical trestles under the stringers
  for (const x of o.legs ?? []) trestle(k, x, a[1] + ((x - a[0]) * dy) / dx - 0.27 / Math.cos(ang), a[2], fz);
}

function trestle(k: Kit, x: number, yTop: number, z: number, half: number) {
  if (yTop < 0.1) return;
  for (const s of [-1, 1]) {
    k.box(KM.paintGrey, [0.07, yTop, 0.07], [x, yTop / 2, z + s * half]);
    k.box(KM.steel, [0.17, 0.012, 0.17], [x, 0.006, z + s * half], [0, 0, 0], { cast: false });
    for (const d of [-0.055, 0.055]) k.cyl(KM.stainlessDark, 0.009, 0.03, [x + d, 0.02, z + s * half + d], [0, 0, 0], 6, { cast: false });
  }
  k.box(KM.paintGrey, [0.08, 0.07, half * 2 + 0.08], [x, yTop - 0.035, z]);
  if (yTop > 0.7) {
    const yb = Math.min(yTop - 0.3, 0.3 + yTop * 0.25);
    k.box(KM.paintGrey, [0.05, 0.05, half * 2], [x, yb, z]);
    strut(k, KM.paintGrey, [x, yb, z - half], [x, yTop - 0.08, z + half], 0.04);
  }
}

/** Steel discharge chute along a → b. */
function chute(k: Kit, a: V3, b: V3, w = 0.56) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  k.at([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, a[2]], [0, 0, Math.atan2(dy, dx)], () => {
    k.box(KM.steel, [len, 0.02, w], [0, -0.01, 0]);
    k.box(KM.paintGrey, [len, 0.03, w + 0.06], [0, -0.035, 0]);
    for (const s of [-1, 1]) {
      k.box(KM.paintGrey, [len, 0.24, 0.022], [0, 0.09, s * (w / 2 + 0.02)]);
      k.box(KM.paintGrey, [len, 0.022, 0.07], [0, 0.21, s * (w / 2 + 0.04)]);
      for (let i = 0; i < 3; i++) k.box(KM.paintGrey, [0.04, 0.27, 0.035], [-len / 2 + 0.15 + (i * (len - 0.3)) / 2, 0.07, s * (w / 2 + 0.045)]);
    }
  });
}

/** Flywheel / sheave in the local XY plane (axis along Z), radius 0.6. */
function buildFlywheel(k: Kit) {
  k.at([0, 0, 0], [HP, 0, 0], () => {
    k.lathe(KM.paintGraphite, crisp([[0.5, -0.08], [0.6, -0.08], [0.6, 0.08], [0.5, 0.08], [0.5, -0.08]]), [0, 0, 0], [0, 0, 0], 48);
    k.lathe(KM.steel, crisp([[0.594, -0.06], [0.61, -0.05], [0.61, 0.05], [0.594, 0.06]]), [0, 0, 0], [0, 0, 0], 48);
  });
  k.cyl(KM.paintGraphite, 0.15, 0.18, [0, 0, 0], [HP, 0, 0], 28);
  k.cyl(KM.steel, 0.085, 0.03, [0, 0, 0.1], [HP, 0, 0], 20);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    k.cyl(KM.stainlessDark, 0.014, 0.02, [Math.cos(a) * 0.115, Math.sin(a) * 0.115, 0.1], [HP, 0, 0], 6, { cast: false });
    // tapered spokes, one painted as a rotation marker
    k.box(i === 0 ? KM.paintYellow : KM.paintGraphite, [0.36, 0.085, 0.07], [Math.cos(a) * 0.32, Math.sin(a) * 0.32, 0], [0, 0, a]);
  }
  k.box(KM.paintYellow, [0.09, 0.008, 0.165], [0, 0.604, 0]);
}

/** Single-toggle jaw crusher; origin on the floor at the crusher centre, eccentric shaft at (0, 1.2) along Z. */
function buildCrusher(k: Kit) {
  const Y = KM.paintYellow;
  // skid
  for (const s of [-1, 1]) k.box(KM.paintGraphite, [2.2, 0.18, 0.16], [-0.15, 0.09, s * 0.62]);
  for (const x of [-1.05, -0.2, 0.8]) k.box(KM.paintGraphite, [0.14, 0.14, 1.1], [x, 0.07, 0]);
  // fabricated side frames with bearing bosses and ribs
  const side: P2[] = [[-0.82, 0.18], [0.8, 0.18], [0.8, 1.52], [0.66, 1.7], [-0.68, 1.7], [-0.82, 1.56]];
  for (const s of [-1, 1]) {
    k.extrude(Y, side, 0.1, [0, 0, s > 0 ? 0.64 : -0.74], [0, 0, 0], { bevel: 0.006 });
    k.cyl(Y, 0.26, 0.04, [0, 1.2, s * 0.762], [HP, 0, 0], 32);
    k.cyl(KM.paintGraphite, 0.17, 0.03, [0, 1.2, s * 0.775], [HP, 0, 0], 28);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      k.cyl(KM.stainlessDark, 0.012, 0.02, [Math.cos(a) * 0.215, 1.2 + Math.sin(a) * 0.215, s * 0.785], [HP, 0, 0], 6, { cast: false });
    }
    k.box(Y, [1.56, 0.05, 0.05], [0, 0.6, s * 0.77]);
    for (const x of [-0.62, 0.6]) k.box(Y, [0.05, 1.3, 0.05], [x, 0.85, s * 0.77]);
    for (const a of [-2.35, -HP, -0.8, 2.6, 0.5]) k.box(Y, [0.36, 0.045, 0.05], [Math.cos(a) * 0.44, 1.2 + Math.sin(a) * 0.44, s * 0.77], [0, 0, a]);
  }
  // end walls: toggle end and the discharge mouth facing the chute
  k.box(Y, [0.1, 1.48, 1.28], [-0.77, 0.94, 0]);
  k.box(Y, [0.1, 0.6, 1.28], [0.75, 0.48, 0]);
  k.box(Y, [0.1, 0.28, 1.28], [0.75, 1.54, 0]);
  k.box(KM.seam, [0.04, 0.6, 1.2], [0.7, 1.08, 0], [0, 0, 0], { cast: false });
  // top plates around the feed opening
  k.box(Y, [0.18, 0.04, 1.28], [-0.61, 1.72, 0]);
  k.box(Y, [0.56, 0.04, 1.28], [0.4, 1.72, 0]);
  for (const s of [-1, 1]) k.box(Y, [0.64, 0.04, 0.32], [-0.2, 1.72, s * 0.48]);
  // crushing chamber seen through the hopper: dark cavity, fixed jaw and pitman with dies
  k.box(KM.seam, [1.3, 0.04, 1.2], [0, 0.85, 0], [0, 0, 0], { cast: false });
  k.box(KM.steel, [0.06, 0.8, 1.1], [0.66, 1.25, 0]);
  for (let i = 0; i < 6; i++) k.box(KM.steel, [0.03, 0.03, 1.1], [0.62, 0.9 + i * 0.12, 0], [0, 0, 0], { cast: false });
  k.box(KM.paintGraphite, [0.22, 1.0, 1.1], [-0.32, 1.15, 0], [0, 0, -0.22]);
  k.box(KM.steel, [0.04, 0.85, 1.05], [-0.2, 1.15, 0], [0, 0, -0.22]);
  // eccentric shaft through both bearings
  k.cyl(KM.steel, 0.075, 1.94, [0, 1.2, 0], [HP, 0, 0], 20);
  // drive-side flywheel/sheave (the front flywheel rotates as its own mesh)
  k.at([0, 1.2, -0.88], 0, () => buildFlywheel(k));
  // motor on a slide base behind, V-belts to the rear sheave
  const mc: P2 = [-1.35, 0.5];
  const mz = -1.22;
  k.box(KM.paintGraphite, [0.62, 0.1, 0.7], [mc[0], 0.05, mz]);
  k.box(KM.paintGrey, [0.5, 0.08, 0.58], [mc[0], 0.14, mz]);
  for (const s of [-1, 1]) k.cyl(KM.steel, 0.015, 0.7, [mc[0] + s * 0.2, 0.2, mz], [HP, 0, 0], 6, { cast: false });
  k.cyl(KM.paintBlue, 0.2, 0.5, [mc[0], mc[1], mz], [HP, 0, 0], 24);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU;
    k.box(KM.paintBlue, [0.012, 0.035, 0.46], [mc[0] + Math.cos(a) * 0.205, mc[1] + Math.sin(a) * 0.205, mz], [0, 0, a], { cast: false });
  }
  k.box(KM.paintBlue, [0.3, 0.32, 0.4], [mc[0], 0.32, mz]);
  k.rbox(KM.paintBlue, [0.14, 0.12, 0.16], 0.01, [mc[0], mc[1] + 0.26, mz + 0.05]);
  k.cyl(KM.paintGraphite, 0.2, 0.04, [mc[0], mc[1], mz - 0.27], [HP, 0, 0], 24);
  k.cyl(KM.steel, 0.03, 0.4, [mc[0], mc[1], -0.92], [HP, 0, 0], 8);
  k.cyl(KM.steel, 0.1, 0.12, [mc[0], mc[1], -0.88], [HP, 0, 0], 20);
  {
    const [x1, y1] = mc;
    const r1 = 0.1;
    const r2 = 0.6;
    const dx = 0 - x1;
    const dy = 1.2 - y1;
    const d = Math.hypot(dx, dy);
    const th = Math.atan2(dy, dx);
    const be = Math.acos((r1 - r2) / d);
    for (const sg of [-1, 1]) {
      const n = th + sg * be;
      const p1: V3 = [x1 + Math.cos(n) * r1, y1 + Math.sin(n) * r1, 0];
      const p2: V3 = [Math.cos(n) * r2, 1.2 + Math.sin(n) * r2, 0];
      for (const z of [-0.91, -0.88, -0.85]) strut(k, KM.rubber, [p1[0], p1[1], z], [p2[0], p2[1], z], 0.02);
    }
  }
  // toggle tension rods with springs at the back
  for (const z of [-0.36, 0.36]) {
    k.cyl(KM.steel, 0.024, 0.6, [-1.08, 0.45, z], [0, 0, HP], 10);
    for (let i = 0; i < 5; i++) k.add(KM.paintRed, new THREE.TorusGeometry(0.068, 0.012, 4, 14), [-0.92 - i * 0.055, 0.45, z], [0, HP, 0]);
    k.cyl(KM.steel, 0.075, 0.03, [-1.22, 0.45, z], [0, 0, HP], 8);
    k.cyl(KM.stainlessDark, 0.04, 0.05, [-1.3, 0.45, z], [0, 0, HP], 6);
  }
  k.box(Y, [0.12, 0.22, 1.0], [-0.86, 0.45, 0]);
  // feed hopper (axis-aligned square, matches the conveyor drop)
  k.at([-0.2, 1.65, 0], 0, () => hopper(k, 0.318, 0.707, 0.8, KM.steel, Y));
  // plates and labels
  plate(k, 'model', 'JC-1200', 'JAW CRUSHER · 160 kW', 0.46, 0.115, [0.22, 0.38, 0.802]);
  plate(k, 'warn', 'CRUSH HAZARD', '', 0.15, 0.15, [0.69, 0.98, 0.802]);
  k.ao(2.4, 1.7, [-0.15, 0, 0]);
}

/** Vibrating screen deck (moving): built in the deck group's frame (group sits at y = 1.0). */
function buildScreenDeck(k: Kit, cx: number, a: V3, b: V3) {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  k.at([cx + (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 1.0, a[2]], [0, 0, ang], () => {
    // modular polyurethane screen panels
    const n = 9;
    for (let i = 0; i < n; i++) for (const zz of [-0.165, 0.165]) k.box(KM.paintAccent, [L / n - 0.012, 0.025, 0.318], [-L / 2 + (i + 0.5) * (L / n), -0.0125, zz]);
    k.box(KM.seam, [L, 0.02, 0.68], [0, -0.034, 0], [0, 0, 0], { cast: false });
    for (const s of [-1, 1]) {
      // side plates with flanges, stiffeners and huck-bolt rows
      k.box(KM.paintGrey, [L + 0.12, 0.34, 0.02], [0, 0, s * 0.37]);
      k.box(KM.paintGrey, [L + 0.12, 0.02, 0.07], [0, 0.17, s * 0.395]);
      k.box(KM.paintGrey, [L + 0.12, 0.02, 0.07], [0, -0.17, s * 0.395]);
      for (let i = 0; i < 6; i++) k.box(KM.paintGrey, [0.035, 0.34, 0.05], [-L / 2 + 0.2 + (i * (L - 0.4)) / 5, 0, s * 0.39]);
      for (let i = 0; i < 14; i++) for (const y of [0.12, -0.12]) k.cyl(KM.stainlessDark, 0.008, 0.012, [-L / 2 + 0.12 + (i * (L - 0.24)) / 13, y, s * 0.385], [HP, 0, 0], 6, { cast: false });
      // spring brackets
      for (const u of [-L / 2 + 0.2, L / 2 - 0.2]) k.box(KM.paintGrey, [0.22, 0.04, 0.17], [u, -0.2, s * 0.47]);
      // unbalanced vibrator motors
      k.box(KM.paintGrey, [0.32, 0.3, 0.03], [0.15, -0.02, s * 0.41]);
      k.cyl(KM.paintBlue, 0.12, 0.24, [0.15, -0.02, s * 0.54], [HP, 0, 0], 20);
      k.cyl(KM.paintGraphite, 0.13, 0.03, [0.15, -0.02, s * 0.67], [HP, 0, 0], 20);
    }
    for (const u of [-0.9, 0, 0.9]) k.cyl(KM.paintGrey, 0.05, 0.76, [u, -0.13, 0], [HP, 0, 0], 14);
    // feed box at the low end
    k.box(KM.paintGrey, [0.03, 0.42, 0.76], [-L / 2 - 0.05, 0.05, 0]);
  });
}

/** Tipper truck (skip to the smelter); origin on the floor, +X = front. */
function buildTruck(k: Kit) {
  const r = rng(21);
  // wheels: rear under the body, front under the cab
  for (const x of [-0.75, 1.45])
    for (const s of [-1, 1])
      k.at([x, 0.405, s * 0.86], [HP, 0, 0], () => {
        k.lathe(KM.rubber, [[0.25, -0.15], [0.33, -0.16], [0.39, -0.13], [0.405, -0.06], [0.405, 0.06], [0.39, 0.13], [0.33, 0.16], [0.25, 0.15]], [0, 0, 0], [0, 0, 0], 28);
        k.cyl(KM.paintGrey, 0.25, 0.27, [0, 0, 0], [0, 0, 0], 24);
        k.cyl(KM.steel, 0.1, 0.3, [0, 0, 0], [0, 0, 0], 16);
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU;
          k.cyl(KM.stainlessDark, 0.014, 0.03, [Math.cos(a) * 0.14, s * 0.145, Math.sin(a) * 0.14], [0, 0, 0], 6, { cast: false });
        }
      });
  // chassis, axles, springs, tank
  for (const s of [-1, 1]) {
    k.box(KM.paintGraphite, [3.5, 0.2, 0.09], [0.3, 0.68, s * 0.42]);
    for (const x of [-0.75, 1.45]) k.box(KM.steel, [0.9, 0.06, 0.07], [x, 0.54, s * 0.42]);
    k.box(KM.rubber, [0.02, 0.32, 0.32], [-1.25, 0.32, s * 0.86]);
    k.box(KM.paintRed, [0.02, 0.07, 0.16], [-1.47, 0.78, s * 0.78]);
  }
  for (const x of [-1.25, -0.3, 0.6, 1.6]) k.box(KM.paintGraphite, [0.08, 0.14, 0.8], [x, 0.68, 0]);
  for (const x of [-0.75, 1.45]) {
    k.cyl(KM.paintGraphite, 0.055, 1.5, [x, 0.405, 0], [HP, 0, 0], 12);
    k.cyl(KM.paintGraphite, 0.15, 0.24, [x, 0.405, 0], [HP, 0, 0], 16);
  }
  k.cyl(KM.anodized, 0.17, 0.62, [0.5, 0.56, 0.62], [0, 0, HP], 20);
  k.box(KM.paintGraphite, [0.4, 0.3, 0.3], [0.5, 0.58, -0.62]);
  // cab
  k.rbox(KM.paintWarm, [1.15, 1.25, 1.9], 0.08, [1.575, 1.48, 0]);
  k.rbox(KM.paintWarm, [1.05, 0.12, 1.8], 0.05, [1.55, 2.15, 0]);
  k.box(KM.glassSmoke, [0.01, 0.52, 1.6], [2.155, 1.76, 0], [0, 0, 0.05], { cast: false });
  for (const s of [-1, 1]) {
    k.box(KM.glassSmoke, [0.66, 0.48, 0.01], [1.52, 1.8, s * 0.953], [0, 0, 0], { cast: false });
    k.box(KM.seam, [0.006, 1.05, 0.004], [1.12, 1.42, s * 0.952], [0, 0, 0], { cast: false });
    k.box(KM.seam, [0.006, 1.05, 0.004], [1.98, 1.42, s * 0.952], [0, 0, 0], { cast: false });
    k.box(KM.paintGraphite, [0.12, 0.025, 0.03], [1.85, 1.45, s * 0.965]);
    k.box(KM.paintGraphite, [0.03, 0.03, 0.22], [2.1, 1.95, s * 1.04]);
    k.rbox(KM.paintGraphite, [0.04, 0.26, 0.14], 0.01, [2.12, 1.82, s * 1.15]);
    k.box(KM.steel, [0.32, 0.03, 0.18], [1.62, 0.62, s * 1.0]);
    k.box(ss, [0.02, 0.1, 0.2], [2.165, 1.0, s * 0.7], [0, 0, 0], { cast: false });
  }
  k.at([2.162, 1.16, 0], [0, HP, 0], () => grille(k, 1.0, 0.34, [0, 0, 0], { m: KM.paintGraphite }));
  k.box(KM.paintGraphite, [0.18, 0.2, 2.0], [2.2, 0.82, 0]);
  k.cyl(KM.paintYellow, 0.06, 0.1, [1.3, 2.26, 0.6], [0, 0, 0], 12);
  k.cyl(ss, 0.05, 1.05, [0.99, 1.95, 0.84], [0, 0, 0], 12);
  // dump body with ribs, headboard and cab canopy
  k.box(orange, [2.35, 0.08, 1.9], [-0.225, 0.95, 0]);
  for (const s of [-1, 1]) {
    k.box(KM.paintGraphite, [2.3, 0.12, 0.12], [-0.225, 0.85, s * 0.42]);
    k.box(orange, [2.35, 0.67, 0.05], [-0.225, 1.285, s * 0.95]);
    k.box(orange, [2.4, 0.07, 0.1], [-0.225, 1.64, s * 0.95]);
    for (const x of [-1.1, -0.55, 0.0, 0.55]) k.box(orange, [0.07, 0.6, 0.05], [x, 1.25, s * 1.0]);
  }
  k.box(orange, [0.05, 1.38, 1.95], [0.95, 1.62, 0]);
  k.box(orange, [0.75, 0.05, 1.92], [1.3, 2.33, 0]);
  k.box(orange, [0.05, 0.62, 1.9], [-1.4, 1.29, 0]);
  k.cyl(KM.steel, 0.03, 1.95, [-1.4, 1.6, 0], [HP, 0, 0], 10);
  // load of quartz lumps
  for (let i = 0; i < 16; i++) {
    const s = 0.16 + r() * 0.14;
    k.add(quartzMat, rockGeo, [-1.2 + r() * 2.0, 1.1 + r() * 0.35, (r() - 0.5) * 1.5], [r() * 3, r() * 3, r() * 3], [s, s, s]);
  }
  k.ao(3.8, 2.0, [0.4, 0, 0]);
}

/** Everything static in the quartz yard, in station-local coordinates. P = lump path. */
function buildQuartzYard(k: Kit, P: V3[]) {
  // stockpile: gravel bed under the rock pile, push walls of interlocking concrete blocks
  k.at([-7, 0, -3], 0, () => k.lathe(gravelMat, [[3.5, 0], [3.0, 0.06], [2.0, 0.42], [1.0, 0.92], [0.3, 1.25], [0.001, 1.32]], [0, 0, 0], [0, 0, 0], 28), [1, 1, 0.8]);
  const block = (x: number, y: number, z: number, yaw: number) => {
    k.at([x, y, z], yaw, () => {
      k.rbox(concrete, [1.58, 0.78, 0.78], 0.04, [0, 0.39, 0]);
      k.add(KM.steel, new THREE.TorusGeometry(0.06, 0.012, 4, 10, Math.PI), [0, 0.78, 0], [0, 0, 0]);
    });
  };
  for (let i = 0; i < 5; i++) block(-9.8 + i * 1.6, 0, -6.6, 0);
  for (let i = 0; i < 4; i++) block(-9.0 + i * 1.6, 0.8, -6.6, 0);
  for (let i = 0; i < 3; i++) block(-10.8, 0, -5.4 + i * 1.6, HP);
  for (let i = 0; i < 2; i++) block(-10.8, 0.8, -4.6 + i * 1.6, HP);
  k.ao(8.4, 1.2, [-6.6, 0, -6.6], 1.2);
  // reclaim hopper with grizzly bars over the conveyor tail
  k.at([P[0][0] + 0.35, 0.95, -1], 0, () => {
    hopper(k, 0.32, 0.62, 0.45, KM.steel, KM.paintYellow);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box(KM.paintGrey, [0.08, 1.4, 0.08], [x * 0.64, -0.25, z * 0.64]);
    for (let i = 0; i < 6; i++) k.box(KM.steel, [1.26, 0.04, 0.03], [0, 0.46, -0.5 + i * 0.2]);
  });
  // feed conveyor up to the crusher hopper
  conveyor(k, P[0], P[1], { w: 0.75, legs: [-4.3, -2.6], drive: true, skirt: true, cord: true });
  strut(k, KM.paintGrey, [P[1][0] + 0.1, P[1][1] - 0.3, -1.45], [-0.95, 1.72, -1.45], 0.07);
  strut(k, KM.paintGrey, [P[1][0] + 0.1, P[1][1] - 0.3, -0.55], [-0.95, 1.72, -0.55], 0.07);
  // discharge chute: crusher mouth → screen feed box
  const cy = (x: number) => P[2][1] + ((x - P[2][0]) * (P[3][1] - P[2][1])) / (P[3][0] - P[2][0]);
  chute(k, [0.25, cy(0.25), -1], [1.1, cy(1.1), -1]);
  k.box(KM.paintGrey, [0.07, cy(0.9) - 0.1, 0.07], [0.9, (cy(0.9) - 0.1) / 2, -1.36]);
  k.box(KM.paintGrey, [0.07, cy(0.9) - 0.1, 0.07], [0.9, (cy(0.9) - 0.1) / 2, -0.64]);
  k.box(KM.paintGrey, [0.08, 0.06, 0.8], [0.9, cy(0.9) - 0.13, -1]);
  // vibrating screen: spring seats on posts, under-screen sump, wash header on a portal
  const a3 = Math.atan2(P[4][1] - P[3][1], P[4][0] - P[3][0]);
  const L3 = Math.hypot(P[4][0] - P[3][0], P[4][1] - P[3][1]);
  const mx = (P[3][0] + P[4][0]) / 2;
  const my = (P[3][1] + P[4][1]) / 2;
  for (const u of [-L3 / 2 + 0.2, L3 / 2 - 0.2])
    for (const s of [-1, 1]) {
      const bx = mx + u * Math.cos(a3) + 0.22 * Math.sin(a3);
      const by = my + u * Math.sin(a3) - 0.22 * Math.cos(a3);
      const z = -1 + s * 0.47;
      for (let i = 0; i < 5; i++) k.add(KM.paintRed, new THREE.TorusGeometry(0.055, 0.011, 4, 12), [bx, by - 0.035 - i * 0.045, z], [HP, 0, 0]);
      const top = by - 0.25;
      k.box(KM.paintGrey, [0.2, 0.03, 0.18], [bx, top, z]);
      if (top > 0.05) k.box(KM.paintGrey, [0.12, top, 0.12], [bx, top / 2, z]);
    }
  k.rbox(KM.paintGrey, [0.72, 0.3, 0.8], 0.02, [2.35, 0.15, -1]);
  k.box(KM.seam, [0.64, 0.01, 0.72], [2.35, 0.301, -1], [0, 0, 0], { cast: false });
  k.at([mx + 0.32 * Math.sin(a3), my - 0.32 * Math.cos(a3), -1], [0, 0, a3], () => {
    k.box(KM.steel, [L3 - 0.4, 0.015, 0.78], [0, 0, 0]);
    for (const s of [-1, 1]) k.box(KM.paintGrey, [L3 - 0.4, 0.1, 0.015], [0, 0.05, s * 0.39]);
  });
  for (const x of [2.0, 4.9]) {
    k.box(KM.paintGrey, [0.12, 2.75, 0.12], [x, 1.375, -1.75]);
    k.box(KM.steel, [0.24, 0.015, 0.24], [x, 0.008, -1.75], [0, 0, 0], { cast: false });
  }
  k.box(KM.paintGrey, [3.12, 0.14, 0.12], [3.45, 2.81, -1.75]);
  for (const x of [2.5, 3.45, 4.4]) {
    k.box(KM.paintGrey, [0.07, 0.07, 0.8], [x, 2.75, -1.36]);
    k.cyl(KM.steel, 0.008, 0.27, [x, 2.6, -1.0], [0, 0, 0], 6, { cast: false });
  }
  k.cyl(ss, 0.04, 2.7, [3.5, 2.47, -1.0], [0, 0, HP], 16);
  for (let i = 0; i < 8; i++) {
    const x = 2.4 + i * 0.3;
    k.cyl(ss, 0.022, 0.62, [x, 2.4, -1.01], [HP, 0, 0], 10);
    k.cyl(ss, 0.02, 0.07, [x, 2.44, -1.0], [0, 0, 0], 8, { cast: false });
    for (const z of [-1.25, -1.01, -0.77]) k.cyl(KM.stainlessDark, 0.014, 0.05, [x, 2.36, z], [0, 0, 0], 8, { cast: false });
  }
  // wash-water pump behind the screen
  pump(k, [3.3, 0, -2.45], 0);
  k.pipe(ss, [[2.35, 0.2, -1.38], [2.35, 0.2, -2.2], [2.35, 0.32, -2.45], [2.76, 0.32, -2.45]], 0.05, 0.1);
  k.pipe(ss, [[3.05, 0.66, -2.45], [3.05, 1.6, -2.45], [5.05, 1.6, -2.45], [5.05, 1.6, -1.62], [5.05, 2.47, -1.62], [5.05, 2.47, -1.0], [4.85, 2.47, -1.0]], 0.035, 0.12);
  valve(k, [3.05, 1.15, -2.45], 'y', 0.04);
  // transfer and loadout conveyors
  conveyor(k, [P[4][0] + 0.15, P[4][1] - 0.15 * 0.125, -1], [P[5][0] - 0.1, P[5][1] + 0.1 * 0.125, -1], { w: 0.72, legs: [4.75, 6.2], cord: true });
  const s5 = (P[6][1] - P[5][1]) / (P[6][0] - P[5][0]);
  conveyor(k, [P[5][0] + 0.1, P[5][1] + 0.1 * s5, -1], P[6], { w: 0.72, legs: [7.35, 8.15], drive: true });
  // tipper truck under the loadout head
  k.at([10.0, 0, -1], 0, () => buildTruck(k));
  // e-house (MCC) and cable tray to the crusher drive
  k.at([1.8, 0, -5.2], 0, () => {
    cabinet(k, { size: [3.2, 2.6, 2.2], body: KM.paintWarm, panels: 4, rows: [1.0], vent: true, handles: true });
    k.rbox(KM.paintGrey, [1.0, 0.5, 0.5], 0.03, [0.7, 2.9, -0.3]);
    grille(k, 0.8, 0.3, [0.7, 2.9, -0.04]);
    plate(k, 'model', 'MCC-01', 'CRUSHING PLANT · 690 V', 0.6, 0.15, [-0.8, 2.25, 1.102]);
    plate(k, 'warn', 'HIGH VOLTAGE', '', 0.18, 0.18, [0.4, 2.25, 1.102]);
    ledStrip(k, 1.0, [0.95, 2.42, 1.102]);
  });
  tray(k, [0.6, 2.75, -4.0], [-1.7, 2.75, -4.0], 0.35, 4);
  for (const x of [-1.5, -0.4]) {
    k.box(KM.paintGrey, [0.08, 2.75, 0.08], [x, 1.375, -4.2]);
    k.box(KM.paintGrey, [0.06, 0.06, 0.45], [x, 2.72, -4.0]);
  }
  sagHose(k, [-1.6, 2.72, -4.0], [-1.75, 0.55, -1.75], 0.03, 0.15, KM.rubber);
  // local control station (HMI + EMO) on a post facing the aisle
  k.at([-2.1, 0, 0.55], 0.3, () => {
    k.box(KM.paintGrey, [0.12, 1.3, 0.12], [0, 0.65, 0]);
    k.box(KM.steel, [0.3, 0.015, 0.3], [0, 0.008, 0], [0, 0, 0], { cast: false });
    hmi(k, [0, 1.45, 0.12], 0);
    k.rbox(KM.paintGrey, [0.22, 0.26, 0.14], 0.015, [0, 1.05, 0.1]);
    estop(k, [0, 1.08, 0.17]);
  });
  // floor: hatched exclusion zone around crusher and screen
  const zx0 = -1.75;
  const zx1 = 5.3;
  const zz0 = -2.15;
  const zz1 = 0.2;
  for (const z of [zz0, zz1]) k.box(KM.paintYellow, [zx1 - zx0, 0.003, 0.08], [(zx0 + zx1) / 2, 0.0015, z], [0, 0, 0], { cast: false });
  for (const x of [zx0, zx1]) k.box(KM.paintYellow, [0.08, 0.003, zz1 - zz0], [x, 0.0015, (zz0 + zz1) / 2], [0, 0, 0], { cast: false });
  for (let x = zx0 + 0.3; x < zx1 - 0.1; x += 0.45) k.box(KM.paintYellow, [0.06, 0.003, 0.32], [x, 0.0015, zz1 - 0.2], [0, 0.7, 0], { cast: false });
  // yard sign
  k.at([-4.2, 0, 0.4], -0.25, () => {
    for (const s of [-1, 1]) k.box(KM.paintGrey, [0.05, 1.5, 0.05], [s * 0.32, 0.75, 0]);
    plate(k, 'info', 'QUARTZITE · SiO₂ ≥ 99.5 %', 'LUMP 10–100 mm · STOCKPILE A', 0.72, 0.18, [0, 1.35, 0.03]);
    k.box(KM.paintGrey, [0.76, 0.22, 0.02], [0, 1.35, 0.015]);
  });
}

function QuartzStation() {
  const cx = X.quartz;
  const pile = useMemo(() => {
    const r = rng(12);
    const m = new THREE.InstancedMesh(rockGeo, quartzMat, 90);
    const o = new THREE.Object3D();
    for (let i = 0; i < 90; i++) {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * 3;
      const s = 0.25 + r() * 0.35;
      o.position.set(cx - 7 + Math.cos(a) * d, s * 0.6 + (3 - d) * 0.5, -3 + Math.sin(a) * d * 0.8);
      o.rotation.set(r() * 3, r() * 3, r() * 3);
      o.scale.setScalar(s);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    }
    m.castShadow = true;
    return m;
  }, [cx]);
  const PATH: V3[] = [
    [cx - 5, 0.7, -1],
    [cx - 1.2, 2.6, -1],
    [cx - 0.2, 1.4, -1],
    [cx + 1.2, 0.55, -1],
    [cx + 4, 1.25, -1],
    [cx + 6.8, 0.9, -1],
    [cx + 8.5, 1.6, -1],
  ];
  const N = 46;
  const lumps = useMemo(() => {
    const m = new THREE.InstancedMesh(rockGeo, quartzMat, N);
    m.castShadow = true;
    m.frustumCulled = false;
    return m;
  }, []);
  const flywheel = useRef<THREE.Group>(null);
  const deck = useRef<THREE.Group>(null);
  const spray = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const time = useRef(0);
  useFrame((_, dt) => {
    const active = engine.stage.id === 'quartz';
    const d = active ? pdt(dt) : 0;
    time.current += d;
    const v = engine.player.view;
    const wash = active && inPhase('wash', v);
    for (let i = 0; i < N; i++) {
      const u = (time.current * 0.06 + i / N) % 1;
      const p = pathPoint(PATH, u);
      o.position.copy(p).add(new THREE.Vector3(0, 0.12, ((i * 37) % 7) * 0.04 - 0.12));
      o.rotation.set(i, i * 2, 0);
      o.scale.setScalar(u < 0.33 ? 0.22 : 0.09);
      o.updateMatrix();
      lumps.setMatrixAt(i, o.matrix);
      if (i === 0) track('focus', p.x, p.y + 0.3, p.z);
    }
    lumps.instanceMatrix.needsUpdate = true;
    if (flywheel.current) flywheel.current.rotation.z -= d * 4;
    if (deck.current) deck.current.position.y = 1.0 + (d > 0 ? Math.sin(time.current * 40) * 0.01 : 0);
    if (spray.current) {
      spray.current.visible = wash;
      for (let k = 0; k < 40; k++) {
        const ph = (time.current * 1.8 + k / 40) % 1;
        o.position.set(cx + 2.4 + (k % 8) * 0.3, 2.3 - ph * 1.1, -1.25 + (k % 5) * 0.12);
        o.scale.setScalar(0.025);
        o.updateMatrix();
        spray.current.setMatrixAt(k, o.matrix);
      }
      spray.current.instanceMatrix.needsUpdate = true;
    }
  });
  const local = (p: V3): V3 => [p[0] - cx, p[1], p[2]];
  const yard = useModel((k) => k.at([cx, 0, 0], 0, () => buildQuartzYard(k, PATH.map(local))), [cx]);
  const crusher = useModel((k) => k.at([cx - 0.4, 0, -1], 0, () => buildCrusher(k)), [cx]);
  const fly = useModel(buildFlywheel, []);
  const deckParts = useModel((k) => buildScreenDeck(k, cx, local(PATH[3]), local(PATH[4])), [cx]);
  return (
    <group>
      <Clickable sel={{ kind: 'material', id: 'quartz', label: 'Quartz (SiO₂)' }}>
        <primitive object={pile} />
      </Clickable>
      <primitive object={lumps} />
      {/* yard: conveyors, chute, screen frame, wash header, e-house, loadout truck */}
      <Baked parts={yard} />
      {/* jaw crusher */}
      <Comp id="charge-feed" machine="arc-furnace" label="Jaw crusher">
        <Baked parts={crusher} />
        <group ref={flywheel} position={[cx - 0.4, 1.2, -0.12]}>
          <Baked parts={fly} />
        </group>
      </Comp>
      {/* vibrating screen with wash sprays */}
      <group ref={deck}>
        <Baked parts={deckParts} />
      </group>
      <instancedMesh ref={spray} args={[GEO.sphereLow, new THREE.MeshBasicMaterial({ color: '#cfe8e0', transparent: true, opacity: 0.7 }), 40]} />
      <TechLabel position={[cx - 7, 3.4, -3]} title="QUARTZITE STOCKPILE" lines={['high-purity silica (SiO₂)']} />
      <TechLabel position={[cx - 0.4, 3.0, -1]} title="CRUSHER" />
      <TechLabel position={[cx + 3.6, 2.7, -1]} title="SCREEN + WASH" lines={['fines & clay removed']} />
      <TechLabel position={[cx + 9.6, 2.5, -1]} title="TO SMELTER →" />
      {/* atomic inset */}
      <SilicaInset position={[-35, 3.0, 2]} mode="quartz" />
    </group>
  );
}

/* ------------------------------------------------------------ atomic insets */

function SilicaInset({ position, mode }: { position: V3; mode: 'quartz' | 'reduce' }) {
  const net = useMemo(() => silicaNetwork(2, 1.4), []);
  // carbon atoms that arrive and leave with oxygen as CO
  const carbons = useMemo(() => net.atoms.map((a, i) => (a.el === 'O' ? i : -1)).filter((i) => i >= 0), [net]);
  const atoms = useMemo<Atom[]>(() => (mode === 'reduce' ? [...net.atoms, ...carbons.map((i) => ({ p: net.atoms[i].p, el: 'C' as const }))] : net.atoms), [net, carbons, mode]);
  const bonds = net.bonds;
  const visible = useMemo(() => {
    if (mode !== 'reduce') return undefined;
    return (i: number, a: Atom): { visible: boolean; offset?: [number, number, number] } => {
      const k = pp('smelt');
      const crushed = pp('tap') > 0 || pp('crush') > 0 ? 1 : 0;
      const prog = Math.max(k, crushed);
      if (a.el === 'Si') return { visible: true };
      const idx = a.el === 'O' ? carbons.indexOf(i) : i - net.atoms.length;
      const start = (idx / carbons.length) * 0.75;
      const u = clamp((prog - start) / 0.25);
      if (a.el === 'C') {
        // carbon approaches from above, pairs with its oxygen, both leave upward
        const arrive = clamp(u * 2);
        const leave = clamp(u * 2 - 1);
        return { visible: u > 0 && leave < 1, offset: [0.12, (1 - arrive) * 0.8 + leave * 1.4, 0] };
      }
      const leave = clamp(u * 2 - 1);
      return { visible: leave < 1, offset: [0, leave * 1.4, 0] };
    };
  }, [mode, carbons, net]);
  return (
    <Inset id={`silica-${mode}`} position={position} size={[1.6, 1.25]} mpu={5.4e-10} title={mode === 'quartz' ? 'SiO₂ · TETRAHEDRAL NETWORK' : 'SiO₂ + 2C → Si + 2CO'}>
      <group position={[0, 0, 0.3]}>
        <AtomModel atoms={atoms} bonds={bonds} visibleFn={visible} scale={0.3} />
      </group>
    </Inset>
  );
}

function TcsInset({ position }: { position: V3 }) {
  const m = useMemo(() => tcsMolecule(0.55), []);
  return (
    <Inset id="tcs" position={position} size={[1.6, 1.25]} mpu={5e-10} title="SiHCl₃ · TRICHLOROSILANE (bp ≈ 32 °C)">
      <group position={[-0.35, 0, 0.3]}>
        <AtomModel atoms={m.atoms} bonds={m.bonds} spin={0.6} scale={0.42} />
      </group>
      <group position={[0.42, 0.18, 0.3]}>
        <AtomModel atoms={[{ p: [0, 0, 0], el: 'B' }, { p: [0.6, 0, 0], el: 'Cl' }, { p: [-0.3, 0.52, 0], el: 'Cl' }, { p: [-0.3, -0.52, 0], el: 'Cl' }]} bonds={[[0, 1], [0, 2], [0, 3]]} spin={0.9} scale={0.26} />
      </group>
      <group position={[0.42, -0.3, 0.3]}>
        <AtomModel atoms={[{ p: [0, 0, 0], el: 'P' }, { p: [0.6, -0.22, 0], el: 'Cl' }, { p: [-0.3, -0.22, 0.52], el: 'Cl' }, { p: [-0.3, -0.22, -0.52], el: 'Cl' }]} bonds={[[0, 1], [0, 2], [0, 3]]} spin={-0.7} scale={0.26} />
      </group>
      <TechLabel position={[0.42, 0.42, 0.3]} title="BCl₃ · bp 12.5 °C · LIGHT END" min={2} />
      <TechLabel position={[0.42, -0.1, 0.3]} title="PCl₃ · bp 76 °C · HEAVY END" min={2} />
    </Inset>
  );
}

function GrainsInset({ position }: { position: V3 }) {
  const lat = useMemo(() => diamondLattice(1, 1.0), []);
  const grains: { p: V3; r: V3 }[] = [
    { p: [-0.42, 0.05, 0.3], r: [0.3, 0.2, 0] },
    { p: [0.0, 0.1, 0.3], r: [0.9, 0.7, 0.4] },
    { p: [0.42, 0.0, 0.3], r: [0.1, 1.4, 0.8] },
  ];
  return (
    <Inset id="grains" position={position} size={[1.6, 1.25]} mpu={6e-10} title="POLYCRYSTALLINE · GRAINS WITH DIFFERENT ORIENTATIONS">
      {grains.map((g, i) => (
        <group key={i} position={g.p} rotation={g.r}>
          <AtomModel atoms={lat.atoms} bonds={lat.bonds} spin={0} scale={0.3} />
        </group>
      ))}
      <TechLabel position={[0, -0.45, 0.3]} title="ULTRA-PURE BUT NOT A SINGLE CRYSTAL → CZ GROWTH NEXT" min={2} />
    </Inset>
  );
}

/* ======================================================================
   2 · submerged arc furnace (station-local coordinates, origin at X.arc)
   ====================================================================== */

/** electrode axes (x, z) at radius 1.0 */
const ELEC: P2[] = [0, 1, 2].map((k) => {
  const a = (k / 3) * Math.PI * 2 + Math.PI / 6;
  return [Math.cos(a) * 1.0, Math.sin(a) * 1.0];
});
/** electrode-hoist yoke beams (x) spanning the furnace bay */
const YOKE = [-1.32, -0.43, 0.43, 1.32];

/** Furnace bay: tapping-floor pad, steel structure, electrode floor, transformer vault, flexible bus, mud gun. */
function buildArcPlant(k: Kit) {
  // concrete pad with steel edge angles, stairs and handrails
  k.box(concrete, [8, 1, 7], [0, 0.5, -0.5]);
  for (const z of [2.975, -3.975]) k.box(KM.steel, [8.0, 0.05, 0.05], [0, 0.975, z], [0, 0, 0], { cast: false });
  for (const x of [-3.975, 3.975]) k.box(KM.steel, [0.05, 0.05, 7.0], [x, 0.975, -0.5], [0, 0, 0], { cast: false });
  for (let i = 0; i < 4; i++) k.box(KM.steel, [1.0, 0.04, 0.3], [-2.8, 0.2 + i * 0.2, 4.05 - i * 0.3]);
  for (const x of [-3.32, -2.28]) strut(k, KM.paintYellow, [x, 0.0, 4.35], [x, 1.0, 3.0], 0.05);
  handrail(k, [[-3.32, 0.2, 4.2], [-3.32, 1.0, 3.0]], 1.0);
  handrail(k, [[-2.28, 0.2, 4.2], [-2.28, 1.0, 3.0]], 1.0);
  handrail(k, [[1.3, 1.0, 2.94], [3.94, 1.0, 2.94], [3.94, 1.0, -3.94]], 1.05);
  handrail(k, [[-3.94, 1.0, 2.94], [-3.94, 1.0, -3.94]], 1.05);
  handrail(k, [[-2.2, 1.0, 2.94], [-1.3, 1.0, 2.94]], 1.05);
  k.ao(8.4, 7.4, [0, 0, -0.5], 1.15);
  // furnace building steel: columns, girders, side bracing
  const colZ = [1.25, -1.75, -3.6];
  for (const x of [-3.7, 3.7]) {
    for (const z of colZ) iBeam(k, 6.4, [x, 1.0, z], 0.3, KM.paintGrey);
    girder(k, [x, 7.7, colZ[0]], [x, 7.7, colZ[2]], 0.3, 0.16);
    girder(k, [x, 4.35, colZ[0]], [x, 4.35, colZ[1]], 0.22, 0.12);
    strut(k, KM.paintGrey, [x, 1.1, colZ[0] - 0.1], [x, 4.1, colZ[1] + 0.1], 0.08);
    strut(k, KM.paintGrey, [x, 4.45, colZ[1] + 0.1], [x, 7.35, colZ[0] - 0.1], 0.08);
  }
  for (const z of colZ) girder(k, [-3.85, 7.7, z], [3.85, 7.7, z], 0.32, 0.18);
  // electrode-hoist yokes on top of the girders
  for (const x of YOKE) girder(k, [x, 7.98, colZ[0] + 0.1], [x, 7.98, colZ[1] - 0.1], 0.26, 0.15);
  // electrode floor (back bay) with toe boards and rails
  grating(k, 7.3, 1.75, [0, 7.72, -2.675]);
  k.box(KM.paintYellow, [7.3, 0.1, 0.01], [0, 7.77, -1.8]);
  handrail(k, [[-3.6, 7.72, -1.82], [3.6, 7.72, -1.82]], 1.05);
  // off-gas duct support portal
  for (const x of [2.85, 3.95]) k.box(KM.paintGrey, [0.14, 3.1, 0.14], [x, 2.55, -1.2]);
  girder(k, [2.75, 4.12, -1.2], [4.05, 4.12, -1.2], 0.2, 0.14);
  strut(k, KM.paintGrey, [3.4, 5.8, -1.65], [3.7, 5.8, -1.75], 0.07);
  // transformer vault (concrete) with the furnace transformer on top
  k.box(concrete, [3.0, 3.7, 2.3], [0, 1.85, -4.55]);
  k.box(KM.paintGraphite, [1.0, 2.0, 0.04], [0, 2.0, -3.39]);
  k.box(KM.paintGrey, [0.9, 1.9, 0.04], [0, 1.98, -3.37]);
  plate(k, 'warn', 'HIGH VOLTAGE', '', 0.24, 0.24, [0, 3.25, -3.345]);
  k.at([0, 3.7, -4.55], 0, () => {
    k.rbox(KM.paintGrey, [2.2, 2.2, 1.6], 0.04, [0, 1.1, 0]);
    k.box(KM.paintGrey, [2.3, 0.08, 1.7], [0, 2.24, 0]);
    k.box(KM.paintGraphite, [2.26, 0.12, 1.66], [0, 0.06, 0]);
    for (const s of [-1, 1]) {
      for (let i = 0; i < 9; i++) k.box(KM.paintGrey, [0.34, 1.6, 0.03], [s * 1.3, 1.1, -0.62 + i * 0.155]);
      for (const y of [0.25, 1.95]) k.cyl(KM.paintGrey, 0.05, 1.4, [s * 1.3, y, 0], [HP, 0, 0], 12);
    }
    // vertical stiffeners on the tank front
    for (const x of [-0.75, -0.25, 0.25, 0.75]) k.box(KM.paintGrey, [0.05, 2.0, 0.04], [x, 1.1, 0.81]);
    // conservator + Buchholz pipe
    k.cyl(KM.paintGrey, 0.24, 1.6, [0.1, 2.75, -0.55], [0, 0, HP], 24);
    for (const x of [-0.5, 0.7]) k.box(KM.paintGrey, [0.08, 0.5, 0.08], [x, 2.5, -0.55]);
    k.pipe(KM.paintGrey, [[0.1, 2.28, -0.3], [0.1, 2.45, -0.3], [0.1, 2.45, -0.55]], 0.035, 0.08);
    // HV bushings (porcelain sheds)
    for (const x of [-0.6, 0, 0.6]) {
      const prof: P2[] = [[0.09, 0]];
      for (let i = 0; i < 6; i++) prof.push([0.13, 0.05 + i * 0.08], [0.07, 0.09 + i * 0.08]);
      prof.push([0.04, 0.6], [0.001, 0.62]);
      k.lathe(KM.ptfe, prof, [x, 2.28, -0.25], [0, 0, 0], 16);
      k.cyl(KM.copper, 0.02, 0.15, [x, 2.95, -0.25], [0, 0, 0], 8);
    }
    // LV (secondary) terminals facing the furnace
    for (const x of [-0.8, 0, 0.8]) {
      k.box(KM.copper, [0.32, 0.32, 0.06], [x, 1.9, 0.83]);
      for (const [bx, by] of [[-0.1, -0.1], [0.1, -0.1], [-0.1, 0.1], [0.1, 0.1]]) k.cyl(KM.stainlessDark, 0.016, 0.03, [x + bx, 1.9 + by, 0.87], [HP, 0, 0], 6, { cast: false });
    }
    plate(k, 'model', 'FT-36', 'FURNACE TRANSFORMER · 36 MVA', 0.7, 0.175, [0, 0.62, 0.802]);
  });
  // water-cooled flexible bus: transformer terminals → electrode bus tubes
  for (const [ex, ez] of ELEC) {
    const tx = ex * 0.92;
    for (const dy of [-0.06, 0.06]) sagHose(k, [ex, 5.45 + dy, ez - 2.25], [tx, 5.6 + dy, -3.7], 0.045, ez < 0 ? 0.08 : 0.32, KM.rubber);
  }
  // tap-hole mud gun on its swing pedestal
  k.at([-1.55, 1.0, 2.62], 0, () => {
    k.cyl(KM.paintGraphite, 0.2, 0.06, [0, 0.03, 0], [0, 0, 0], 20);
    k.cyl(KM.paintGraphite, 0.13, 0.55, [0, 0.33, 0], [0, 0, 0], 20);
    k.rbox(KM.paintYellow, [0.8, 0.2, 0.24], 0.03, [0.32, 0.66, 0]);
    k.cyl(KM.paintYellow, 0.12, 0.6, [0.5, 0.52, 0], [0, 0, HP], 20);
    k.cyl(KM.steel, 0.05, 0.22, [0.88, 0.52, 0], [0, 0, HP], 12);
    k.cyl(ss, 0.03, 0.5, [0.2, 0.86, 0.06], [0, 0, HP], 8);
    sagHose(k, [-0.05, 0.4, 0.1], [0.4, 0.4, 0.15], 0.018, 0.1, KM.rubber);
  });
}

/** Furnace shell (shell): stiffened steel shell, cooling ring, refractory lining, burden, tap block. */
function buildHearth(k: Kit) {
  const sh = { shell: true };
  // air-cooled beam grid under the shell
  for (let i = 0; i < 20; i++) radial(k, 0, (i / 20) * TAU, 1.0, () => k.box(KM.paintGraphite, [0.14, 0.14, 0.42], [0, 0.07, 2.62], [0, 0, 0], sh));
  ring(k, KM.paintDark, 2.45, 2.76, 1.12, 1.22, 64, sh);
  k.cyl(KM.paintDark, 2.6, 2.2, [0, 2.3, 0], [0, 0, 0], 64, { ...sh, open: true });
  for (let i = 0; i < 24; i++) radial(k, 0, ((i + 0.5) / 24) * TAU, 0, () => k.box(KM.paintDark, [0.03, 2.16, 0.1], [0, 2.3, 2.65], [0, 0, 0], sh));
  for (const y of [1.75, 2.75]) ring(k, KM.paintDark, 2.6, 2.73, y, y + 0.12, 64, sh);
  ring(k, KM.steel, 2.24, 2.76, 3.4, 3.48, 64, sh);
  // spray-cooling ring header with drop nozzles
  k.torus(KM.paintBlue, 2.88, 0.045, [0, 3.3, 0], [0, 0, 0], 64, sh);
  for (let i = 0; i < 16; i++) radial(k, 2.88, (i / 16) * TAU + 0.1, 3.3, () => k.cyl(KM.paintBlue, 0.018, 0.12, [0, -0.07, 0], [0, 0, 0], 6, { ...sh, cast: false }));
  // refractory lining and the burden it holds (cut-away shows the crater)
  k.lathe(refractory, crisp([[2.58, 3.4], [2.26, 3.4], [2.26, 1.45], [0.001, 1.45]]), [0, 0, 0], [0, 0, 0], 64, sh);
  k.lathe(burdenMat, crisp([[2.255, 1.46], [2.255, 3.06], [0.001, 3.06]]), [0, 0, 0], [0, 0, 0], 48, sh);
  // arc craters at the electrode tips and the silicon pool on the hearth (interior)
  for (const [ex, ez] of ELEC) k.lathe(moltenMat, [[0.001, 2.25], [0.3, 2.32], [0.46, 2.55], [0.44, 2.75], [0.001, 2.8]], [ex, 0, ez], [0, 0, 0], 20, { cast: false });
  k.cyl(moltenMat, 1.7, 0.08, [0, 1.5, 0], [0, 0, 0], 40, { cast: false });
  // tap block at the front
  radial(k, 2.6, HP, 1.45, () => {
    k.rbox(KM.copper, [0.62, 0.52, 0.16], 0.02, [0, 0, 0.08], [0, 0, 0], sh);
    k.cyl(KM.seam, 0.075, 0.04, [0, 0, 0.17], [HP, 0, 0], 16, sh);
    k.cyl(KM.paintBlue, 0.02, 0.6, [0, 0.3, 0.12], [0, 0, HP], 6, sh);
  });
  // thermocouple fitting (sensor marker sits on it)
  radial(k, 2.6, Math.atan2(0.6, 2.53), 2.6, () => {
    k.cyl(ss, 0.035, 0.16, [0, 0, 0.08], [HP, 0, 0], 12, sh);
    k.rbox(KM.anodized, [0.08, 0.1, 0.06], 0.01, [0, 0.07, 0.15], [0, 0, 0], sh);
  });
  shellLabel(k, 'model', 'SAF-3', 'SUBMERGED ARC FURNACE · 30 MW', 0.86, 0.215, [Math.cos(-0.22) * 2.76, 2.25, Math.sin(-0.22) * 2.76], [0, HP + 0.22, 0]);
}

/** Water-cooled fume hood (shell) and the off-gas duct with flanges, bellows and damper. */
function buildHood(k: Kit) {
  const sh = { shell: true };
  k.lathe(KM.paintGrey, crisp([[2.8, 3.6], [1.8, 4.8], [1.74, 4.8], [2.74, 3.62], [2.8, 3.6]]), [0, 0, 0], [0, 0, 0], 64, sh);
  ring(k, KM.paintGraphite, 2.7, 2.92, 3.54, 3.64, 64, sh);
  ring(k, KM.paintGrey, 1.36, 1.86, 4.8, 4.86, 64, sh);
  ring(k, KM.steel, 1.32, 1.38, 4.7, 4.92, 48, sh);
  const sl = Math.hypot(1.0, 1.2);
  const tilt = Math.atan2(1.0, 1.2);
  for (let i = 0; i < 28; i++) k.at([0, 0, 0], [0, (i / 28) * TAU, 0], () => k.cyl(KM.paintGrey, 0.03, sl, [2.34, 4.2, 0], [0, 0, tilt], 8, sh));
  k.torus(ss, 1.95, 0.05, [0, 4.95, 0], [0, 0, 0], 48, sh);
  // stoking / inspection doors between the electrodes
  for (const a of [HP, HP + (2 * Math.PI) / 3, HP - (2 * Math.PI) / 3])
    radial(k, 2.36, a, 4.15, () =>
      k.at([0, 0, 0], [-tilt, 0, 0], () => {
        k.rbox(KM.paintGraphite, [0.62, 0.5, 0.06], 0.02, [0, 0, 0.03], [0, 0, 0], sh);
        k.rbox(KM.paintGrey, [0.5, 0.38, 0.05], 0.02, [0, 0, 0.07], [0, 0, 0], sh);
        k.box(KM.stainlessDark, [0.3, 0.03, 0.03], [0, -0.1, 0.11], [0, 0, 0], sh);
        k.cyl(KM.glassSmoke, 0.05, 0.01, [0, 0.08, 0.1], [HP, 0, 0], 16, sh);
      }),
    );
  // off-gas duct to the filter
  k.pipe(KM.paintGrey, [[1.8, 4.6, -0.6], [3.4, 4.6, -1.2], [3.4, 6.5, -1.2]], 0.45, 0.55);
  const yaw = Math.atan2(0.6, 1.6);
  for (const t of [0.15, 0.55]) k.at([1.8 + 1.6 * t, 4.6, -0.6 - 0.6 * t], [0, yaw, 0], () => k.at([0, 0, 0], [0, 0, -HP], () => ring(k, KM.paintGrey, 0.44, 0.53, -0.03, 0.03, 40)));
  k.at([3.4, 0, -1.2], 0, () => {
    for (const y of [5.15, 5.85, 6.2]) ring(k, KM.paintGrey, 0.44, 0.53, y - 0.03, y + 0.03, 40);
    bellows(k, 0.5, 0.36, 4, [0, 5.3, 0], KM.stainlessDark);
    ring(k, KM.steel, 0.38, 0.52, 6.46, 6.54, 40);
    k.cyl(KM.seam, 0.43, 0.01, [0, 6.3, 0], [0, 0, 0], 32, { cast: false });
    // damper actuator
    k.rbox(KM.anodized, [0.24, 0.22, 0.32], 0.02, [0.6, 6.0, 0]);
    k.cyl(KM.steel, 0.03, 0.2, [0.5, 6.0, 0], [0, 0, HP], 8);
    plate(k, 'warn', 'CO GAS', '', 0.2, 0.2, [0, 5.0, 0.462]);
  });
}

/** Three graphite electrode columns with contact clamps, hoist cylinders and copper bus tubes. */
function buildElectrodes(k: Kit) {
  for (const [ex, ez] of ELEC)
    k.at([ex, 0, ez], 0, () => {
      k.cyl(M.graphite, 0.32, 5.0, [0, 5.4, 0], [0, 0, 0], 40);
      k.lathe(M.graphite, [[0.001, 2.72], [0.22, 2.74], [0.3, 2.82], [0.32, 2.92]], [0, 0, 0], [0, 0, 0], 40);
      for (const y of [4.1, 6.5]) k.cyl(KM.seam, 0.323, 0.014, [0, y, 0], [0, 0, 0], 40, { open: true, cast: false });
      // contact shoes in a pressure ring, upper slip ring
      for (let i = 0; i < 8; i++) radial(k, 0, (i / 8) * TAU, 5.4, () => k.box(KM.copper, [0.2, 0.44, 0.07], [0, 0, 0.345]));
      ring(k, KM.steel, 0.38, 0.47, 5.2, 5.6, 40);
      for (let i = 0; i < 8; i++) radial(k, 0.47, ((i + 0.5) / 8) * TAU, 5.4, () => k.cyl(KM.stainlessDark, 0.018, 0.03, [0, 0, 0.01], [HP, 0, 0], 6, { cast: false }));
      ring(k, KM.stainlessDark, 0.34, 0.45, 5.64, 5.74, 40);
      ring(k, KM.steel, 0.34, 0.44, 6.6, 6.72, 40);
      k.torus(KM.paintBlue, 0.5, 0.02, [0, 5.62, 0], [0, 0, 0], 24);
      // copper bus tubes towards the transformer (−Z) with end block
      for (const dx of [-0.09, 0, 0.09]) k.cyl(KM.copper, 0.035, 1.8, [dx, 5.45, -1.35], [HP, 0, 0], 12);
      k.rbox(KM.copper, [0.32, 0.18, 0.14], 0.02, [0, 5.45, -2.25]);
      k.box(KM.ptfe, [0.36, 0.06, 0.1], [0, 5.56, -1.6]);
      // hoist cylinders hanging from the yoke beams
      const xs = YOKE.filter((x) => Math.abs(x - ex) < 0.6).map((x) => x - ex);
      for (const lx of xs) {
        k.cyl(KM.chrome, 0.035, 0.9, [lx, 6.17, 0], [0, 0, 0], 12);
        k.cyl(KM.anodized, 0.075, 1.05, [lx, 7.12, 0], [0, 0, 0], 20);
        k.cyl(KM.anodizedDark, 0.088, 0.06, [lx, 6.6, 0], [0, 0, 0], 20);
        k.cyl(KM.anodizedDark, 0.088, 0.08, [lx, 7.64, 0], [0, 0, 0], 20);
        k.box(KM.steel, [0.12, 0.1, 0.16], [lx, 5.72, 0]);
        sagHose(k, [lx + 0.07, 6.7, 0.05], [lx + 0.09, 7.5, 0.08], 0.012, -0.08, KM.rubber);
      }
      const lo = Math.min(...xs);
      const hi = Math.max(...xs);
      k.box(KM.steel, [hi - lo + 0.2, 0.1, 0.14], [(lo + hi) / 2, 5.7, 0]);
      k.cyl(KM.steel, 0.12, 0.08, [0, 7.94, 0], [0, 0, 0], 20);
    });
}

/** Day bin with pyramid discharge, slide gate and two charge chutes to the hood collar. */
function buildChargeFeed(k: Kit) {
  const bx = -2.4;
  const bz = -2.2;
  k.at([bx, 0, bz], 0, () => {
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box(KM.paintGrey, [0.16, 0.5, 0.16], [x * 1.1, 7.97, z * 1.1]);
    k.rbox(KM.paintGrey, [2.5, 1.3, 2.5], 0.03, [0, 8.87, 0]);
    k.box(KM.paintGrey, [2.58, 0.06, 2.58], [0, 9.55, 0]);
    k.box(KM.paintGraphite, [2.58, 0.12, 2.58], [0, 8.22, 0]);
    for (const y of [8.6, 9.15]) {
      k.box(KM.paintGrey, [2.56, 0.06, 0.05], [0, y, 1.27]);
      k.box(KM.paintGrey, [0.05, 0.06, 2.56], [1.27, y, 0]);
    }
    for (let i = 1; i < 4; i++) {
      k.box(KM.seam, [0.005, 1.2, 0.003], [-1.25 + i * 0.625, 8.87, 1.252], [0, 0, 0], { cast: false });
      k.box(KM.seam, [0.003, 1.2, 0.005], [1.252, 8.87, -1.25 + i * 0.625], [0, 0, 0], { cast: false });
    }
    k.at([0, 7.72, 0], 0, () => hopper(k, 0.22, 1.24, 0.5, KM.paintGrey, KM.paintGrey));
    // bin vent filter and level radar on the roof
    k.cyl(KM.paint, 0.28, 0.6, [0.7, 9.9, -0.6], [0, 0, 0], 24);
    k.cyl(KM.paintGrey, 0.3, 0.05, [0.7, 10.22, -0.6], [0, 0, 0], 24);
    k.cyl(KM.anodized, 0.08, 0.2, [-0.6, 9.68, 0.5], [0, 0, 0], 16);
    k.cyl(KM.paintGrey, 0.25, 0.04, [-0.2, 9.6, -0.6], [0, 0, 0], 20);
    plate(k, 'info', 'DAY BIN · CHARGE', 'QUARTZ · COKE · WOODCHIP', 0.8, 0.2, [-0.3, 8.95, 1.257]);
    // slide gate under the outlet
    k.rbox(KM.paintGraphite, [0.6, 0.12, 0.44], 0.02, [0, 7.66, 0]);
    k.cyl(KM.anodized, 0.06, 0.5, [0.55, 7.66, 0], [0, 0, HP], 16);
  });
  // two chutes: outlet → down → diagonal to the hood collar between electrodes 2 and 3
  for (const a of [Math.PI + 0.26, Math.PI + 0.78]) {
    const end: V3 = [Math.cos(a) * 1.6, 4.92, Math.sin(a) * 1.6];
    const top: V3 = [bx, 7.25, bz];
    k.pipe(KM.steel, [[bx, 7.6, bz], top, end], 0.12, 0.3);
    const mid: V3 = [(top[0] + end[0]) / 2, (top[1] + end[1]) / 2, (top[2] + end[2]) / 2];
    const [rot] = aim(top, end);
    k.at(mid, rot, () => {
      k.cyl(KM.steel, 0.2, 0.06, [0, 0.25, 0], [0, 0, 0], 20);
      k.cyl(KM.steel, 0.2, 0.06, [0, -0.25, 0], [0, 0, 0], 20);
      k.rbox(KM.paintGraphite, [0.36, 0.14, 0.36], 0.02, [0, 0, 0]);
    });
    k.cyl(KM.steel, 0.2, 0.05, [end[0], 4.9, end[2]], [0, 0, 0], 20);
  }
}

/** Tap-hole launder, refractory-lined ladle on its transfer car and rails. */
function buildTap(k: Kit) {
  k.at([0, 1.35, 3.0], [0.25, 0, 0], () => {
    k.box(KM.paintGraphite, [0.58, 0.06, 1.4], [0, -0.12, 0]);
    for (const s of [-1, 1]) k.box(KM.paintGraphite, [0.06, 0.26, 1.4], [s * 0.26, 0, 0]);
    k.box(refractory, [0.46, 0.08, 1.38], [0, -0.06, 0]);
    for (const z of [-0.5, 0, 0.5]) k.box(KM.paintGraphite, [0.66, 0.05, 0.06], [0, -0.16, z]);
  });
  for (const s of [-1, 1]) k.box(KM.paintGraphite, [0.07, 0.2, 0.07], [s * 0.24, 1.08, 2.95]);
  k.at([0, 0, 4.3], 0, () => {
    k.lathe(KM.paintGraphite, crisp([[0.001, 0.18], [0.74, 0.18], [0.8, 1.22], [0.86, 1.24], [0.86, 1.32], [0.8, 1.32]]), [0, 0, 0], [0, 0, 0], 48);
    k.lathe(refractory, crisp([[0.8, 1.32], [0.665, 1.32], [0.665, 0.32], [0.001, 0.32]]), [0, 0, 0], [0, 0, 0], 48);
    for (const y of [0.45, 0.9]) ring(k, KM.paintGraphite, 0.74, 0.83, y, y + 0.08, 48);
    for (const s of [-1, 1]) {
      k.cyl(KM.paintGraphite, 0.12, 0.08, [s * 0.83, 0.95, 0], [0, 0, HP], 20);
      k.cyl(KM.steel, 0.07, 0.18, [s * 0.92, 0.95, 0], [0, 0, HP], 16);
    }
    k.box(KM.paintGraphite, [0.18, 0.06, 0.2], [0.86, 1.31, 0]);
  });
  // transfer car on rails
  for (const z of [4.0, 4.6]) k.box(KM.steel, [5.2, 0.07, 0.07], [0.05, 0.035, z]);
  for (const x of [-2.5, 2.6]) k.box(KM.paintYellow, [0.1, 0.2, 0.8], [x, 0.1, 4.3]);
  k.box(KM.paintYellow, [1.6, 0.12, 1.2], [0, 0.13, 4.3]);
  for (const x of [-0.6, 0.6]) for (const z of [4.0, 4.6]) k.cyl(KM.paintGraphite, 0.08, 0.05, [x, 0.09, z], [HP, 0, 0], 16);
  k.ao(1.8, 1.5, [0, 0, 4.3]);
}

/** MG-Si casting tray (outside the furnace selection, as before). */
function buildChunkTray(k: Kit) {
  k.at([3.8, 0, 3.9], 0, () => {
    for (const z of [-0.36, 0.36]) k.box(KM.paintGraphite, [1.4, 0.38, 0.14], [0, 0.19, z]);
    for (const x of [-0.63, 0.63]) k.box(KM.paintGraphite, [0.14, 0.38, 1.0], [x, 0.19, 0]);
    k.box(KM.steel, [1.4, 0.07, 1.0], [0, 0.42, 0]);
    for (const s of [-1, 1]) {
      k.box(KM.steel, [1.4, 0.18, 0.04], [0, 0.53, s * 0.48]);
      k.box(KM.steel, [0.04, 0.18, 0.96], [s * 0.68, 0.53, 0]);
    }
    plate(k, 'tag', 'MG-Si · 98.5 %', 'LOT 2207 · 1.2 t', 0.42, 0.105, [0, 0.27, 0.432]);
    k.ao(1.5, 1.1);
  });
}

/* ------------------------------------------------------------ 2 · arc furnace */

function ArcFurnace() {
  const cx = X.arc;
  const view = useUI((s) => s.view);
  const arcLight = useRef<THREE.PointLight>(null);
  const stream = useRef<THREE.Mesh>(null);
  const ladleFill = useRef<THREE.Mesh>(null);
  const charge = useRef<THREE.Mesh>(null);
  const smoke = useRef<THREE.InstancedMesh>(null);
  const chunks = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const r = useMemo(() => rng(31), []);
  const smokeSeed = useMemo(() => Array.from({ length: 60 }, () => ({ o: r(), x: (r() - 0.5) * 0.6 })), [r]);
  const clock = useRef(0);
  useFrame((_, dt) => {
    const active = engine.stage.id === 'mg-silicon';
    clock.current += active ? pdt(dt) : 0;
    const smelt = active ? pp('smelt') : 0;
    const tap = active ? pp('tap') : 0;
    const crush = active ? pp('crush') : 0;
    const hot = active && (engine.player.view.phaseId === 'smelt' || engine.player.view.phaseId === 'tap' || engine.player.view.phaseId === 'charge');
    if (arcLight.current) arcLight.current.intensity = hot ? 30 + 12 * Math.sin(clock.current * 31) * Math.sin(clock.current * 7) : 0;
    if (charge.current) {
      (charge.current.material as THREE.MeshStandardMaterial).emissiveIntensity = hot ? 1.2 + smelt : 0.15;
    }
    if (stream.current) stream.current.visible = active && engine.player.view.phaseId === 'tap';
    if (ladleFill.current) ladleFill.current.position.y = 0.6 + 0.65 * (tap > 0 ? Math.min(1, tap * 1.2) : 0) * (crush > 0 ? 0 : 1);
    if (ladleFill.current) ladleFill.current.visible = tap > 0 && crush === 0;
    if (smoke.current) {
      smokeSeed.forEach((s, i) => {
        const u = (clock.current * 0.25 + s.o) % 1;
        o.position.set(cx + 3.4 + s.x + u * 0.8, 6.5 + u * 4, -1.2 + s.x);
        o.scale.setScalar(hot ? 0.15 + u * 0.5 : 0.0001);
        o.updateMatrix();
        smoke.current!.setMatrixAt(i, o.matrix);
      });
      smoke.current.instanceMatrix.needsUpdate = true;
    }
    if (chunks.current) {
      for (let i = 0; i < 40; i++) {
        const show = crush > i / 40;
        o.position.set(cx + 3.2 + (i % 8) * 0.18, 0.55 + Math.floor(i / 8) * 0.1, 3.6 + ((i * 3) % 5) * 0.16);
        o.rotation.set(i, i * 1.7, 0);
        o.scale.setScalar(show ? 0.1 : 0.0001);
        o.updateMatrix();
        chunks.current.setMatrixAt(i, o.matrix);
      }
      chunks.current.instanceMatrix.needsUpdate = true;
    }
    if (active) track('focus', cx, 3.2, 0);
  });
  const at = (fn: (k: Kit) => void) => (k: Kit) => k.at([cx, 0, 0], 0, () => fn(k));
  const plant = useModel(at(buildArcPlant), [cx]);
  const hearth = useModel(at(buildHearth), [cx]);
  const hood = useModel(at(buildHood), [cx]);
  const elec = useModel(at(buildElectrodes), [cx]);
  const feed = useModel(at(buildChargeFeed), [cx]);
  const tapParts = useModel(at(buildTap), [cx]);
  const tray = useModel(at(buildChunkTray), [cx]);
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'arc-furnace', label: 'Submerged arc furnace' }}>
        {/* pad, building steel, electrode floor, transformer vault, flexible bus */}
        <Baked parts={plant} />
        <Comp id="crucible" machine="arc-furnace" label="Refractory hearth">
          <Baked parts={hearth} view={view} />
          <mesh ref={charge} position={[cx, 3.1, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[2.25, 40]} />
            <meshStandardMaterial color="#5a3a24" emissive="#ff6a1a" emissiveIntensity={0.15} roughness={0.8} toneMapped={false} />
          </mesh>
        </Comp>
        <Comp id="electrodes" machine="arc-furnace" label="Graphite electrodes">
          <Baked parts={elec} />
        </Comp>
        <Comp id="hood" machine="arc-furnace" label="Fume hood">
          <Baked parts={hood} view={view} />
        </Comp>
        <Comp id="charge-feed" machine="arc-furnace" label="Charge feed chutes">
          <Baked parts={feed} />
        </Comp>
        <TechLabel position={[cx, 6.6, -4.5]} title="FURNACE TRANSFORMER" min={3} />
        <Comp id="tap-hole" machine="arc-furnace" label="Tap hole & ladle">
          <Baked parts={tapParts} />
          <mesh ref={stream} position={[cx, 1.0, 3.8]} material={moltenMat} visible={false}>
            <cylinderGeometry args={[0.06, 0.09, 0.8, 12]} />
          </mesh>
          <mesh ref={ladleFill} position={[cx, 0.6, 4.3]} rotation={[-Math.PI / 2, 0, 0]} material={moltenMat}>
            <circleGeometry args={[0.66, 32]} />
          </mesh>
        </Comp>
        <pointLight ref={arcLight} position={[cx, 3.5, 0]} color="#ff8a3a" distance={14} decay={1.5} />
      </Clickable>
      <instancedMesh ref={smoke} args={[GEO.sphereLow, new THREE.MeshStandardMaterial({ color: '#8a8f86', transparent: true, opacity: 0.25, depthWrite: false }), 60]} />
      <instancedMesh ref={chunks} args={[rockGeo, mgSiMat, 40]} castShadow />
      <Baked parts={tray} />
      <SensorIndicator id="thermocouple" channel="temp" machine="arc-furnace" position={[cx + 2.65, 2.6, 0.6]} size={0.18} />
      <TechLabel position={[cx + 3.6, 10.8, -1.2]} title="OFF-GAS · CO → CO₂ + SILICA FUME → FILTER" min={2} />
      <TechLabel position={[cx, 8.2, 0]} title="3 GRAPHITE ELECTRODES · ~2000 °C" lines={['carbothermic reduction']} />
      <TechLabel position={[cx + 0.5, 1.9, 4.6]} title="TAP: LIQUID Si → LADLE" />
      <TechLabel position={[cx + 3.8, 1.2, 3.9]} title="MG-Si CHUNKS (~98–99 %)" />
      <SilicaInset position={[-15, 3.0, 2]} mode="reduce" />
    </group>
  );
}

/* ======================================================================
   3 · hydrochlorination & distillation (station-local, origin at X.distill)
   ====================================================================== */

/** Fluidised-bed reactor with support legs, platforms, cyclone, lock hopper and screw feeder. */
function buildFBR(k: Kit) {
  k.at([-4, 0, -1], 0, () => {
    const R = 0.77;
    k.lathe(ss, [[0.12, 0.22], [0.26, 0.32], [0.75, 0.86]], [0, 0, 0], [0, 0, 0], 40);
    ring(k, ss, 0.1, 0.3, 0.26, 0.31, 32);
    cladding(k, R, 0.86, 5.7);
    k.lathe(clad, head(R, 5.7, 1), [0, 0, 0], [0, 0, 0], 40);
    k.cyl(ss, 0.13, 0.32, [0, 6.12, 0], [0, 0, 0], 20);
    ring(k, ss, 0.12, 0.24, 6.24, 6.3, 24);
    // support ring girder and legs
    ring(k, KM.paintGrey, R, 0.98, 2.12, 2.32, 40);
    for (let i = 0; i < 4; i++) {
      const a = HP / 2 + i * HP;
      const x = Math.cos(a) * 0.98;
      const z = Math.sin(a) * 0.98;
      k.box(KM.paintGrey, [0.13, 2.32, 0.13], [x, 1.16, z]);
      k.box(KM.steel, [0.26, 0.015, 0.26], [x, 0.008, z], [0, 0, 0], { cast: false });
      const b = a + HP;
      strut(k, KM.paintGrey, [x, 0.2, z], [Math.cos(b) * 0.98, 1.9, Math.sin(b) * 0.98], 0.05);
    }
    // nozzles: thermowells (+X), manway (aisle side), feed, level taps
    for (const y of [2.6, 3.5, 4.4]) radial(k, R, 0, y, () => { nozzle(k, 0.035, 0.12); k.rbox(KM.anodized, [0.07, 0.09, 0.05], 0.01, [0, 0.05, 0.17]); });
    radial(k, R, HP + 0.2, 4.6, () => manway(k, 0.22, 0.22));
    radial(k, R, (3 * Math.PI) / 4, 1.45, () => nozzle(k, 0.1, 0.35));
    for (const y of [1.2, 4.9]) radial(k, R, -HP + 0.4, y, () => nozzle(k, 0.03, 0.1));
    k.cyl(ss, 0.02, 3.7, [Math.cos(-HP + 0.4) * (R + 0.16), 3.05, Math.sin(-HP + 0.4) * (R + 0.16)], [0, 0, 0], 8);
    radial(k, R + 0.02, HP - 0.5, 2.85, () => plate(k, 'model', 'R-101', 'FLUID-BED HYDROCHLORINATOR', 0.46, 0.115, [0, 0, 0.012]));
    // access platforms + caged ladder (away from the dip leg)
    circPlatform(k, R + 0.04, 1.45, 3.0, Math.PI + 0.95, Math.PI + 0.25 + TAU - 0.5);
    circPlatform(k, R + 0.04, 1.32, 5.5, HP - 0.4, Math.PI + 0.25);
    radial(k, R + 0.27, Math.PI + 0.6, 0, () => ladder(k, 0, 5.5));
    // HCl inlet: bottom elbow → riser to the pipe rack
    k.pipe(ss, [[0, 0.24, 0], [0, 0.14, 0], [0, 0.14, -2.9], [0, 5.2, -2.9], [0, 5.2, -3.15]], 0.06, 0.16);
    valve(k, [0, 0.14, -1.4], 'z', 0.06);
    plate(k, 'gas', 'HCl', '', 0.28, 0.055, [0.075, 1.2, -2.9], [0, HP, 0], '#8a6a2a');
    k.ao(2.2, 2.2);
  });
  // cyclone with dip leg back into the bed
  k.at([-6, 0, -1], 0, () => {
    k.cyl(ss, 0.42, 0.95, [0, 6.375, 0], [0, 0, 0], 40);
    k.lathe(ss, [[0.09, 4.9], [0.42, 5.9]], [0, 0, 0], [0, 0, 0], 40);
    k.cyl(ss, 0.45, 0.04, [0, 6.87, 0], [0, 0, 0], 40);
    k.cyl(ss, 0.16, 0.5, [0, 7.1, 0], [0, 0, 0], 24);
    k.rbox(ss, [0.62, 0.32, 0.24], 0.02, [0.45, 6.55, 0.28]);
    ring(k, KM.paintGrey, 0.42, 0.58, 5.86, 5.94, 40);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      k.box(KM.paintGrey, [0.1, 5.9, 0.1], [x * 0.45, 2.95, z * 0.45]);
      k.box(KM.steel, [0.2, 0.015, 0.2], [x * 0.45, 0.008, z * 0.45], [0, 0, 0], { cast: false });
    }
    for (const y of [2.0, 4.0]) for (const s of [-1, 1]) {
      strut(k, KM.paintGrey, [-0.45, y, s * 0.45], [0.45, y + 1.6, s * 0.45], 0.045);
      strut(k, KM.paintGrey, [s * 0.45, y, -0.45], [s * 0.45, y + 1.6, 0.45], 0.045);
    }
    k.pipe(ss, [[0, 4.92, 0], [0, 4.2, 0], [1.22, 3.6, 0]], 0.08, 0.2);
    k.rbox(KM.stainlessDark, [0.18, 0.16, 0.18], 0.02, [0, 4.45, 0]);
  });
  // FBR outlet → cyclone, cyclone gas → condenser inlet
  k.pipe(ss, [[-4, 6.3, -1], [-4, 6.55, -1], [-5.5, 6.55, -0.72]], 0.12, 0.2);
  k.pipe(ss, [[-6, 7.35, -1], [-6, 7.5, -1], [-3.75, 7.5, -1], [-3.75, 6.8, -1], [-3.4, 6.8, -1]], 0.12, 0.25);
  // MG-Si lock hopper and screw feeder
  k.at([-5.5, 0, 0.4], 0, () => {
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box(KM.paintGrey, [0.08, 2.0, 0.08], [x * 0.3, 1.0, z * 0.3]);
    k.lathe(ss, [[0.07, 1.62], [0.36, 2.02]], [0, 0, 0], [0, 0, 0], 32);
    k.cyl(ss, 0.36, 0.9, [0, 2.47, 0], [0, 0, 0], 32);
    k.lathe(ss, head(0.36, 2.92, 1), [0, 0, 0], [0, 0, 0], 32);
    for (const y of [3.18, 3.4]) {
      k.cyl(KM.stainlessDark, 0.09, 0.12, [0, y, 0], [0, 0, 0], 16);
      k.cyl(KM.paintRed, 0.02, 0.2, [0.12, y, 0], [0, 0, HP], 8);
    }
    k.cyl(ss, 0.06, 1.0, [0, 3.95, 0], [0, 0, 0], 12);
    k.cyl(KM.stainlessDark, 0.09, 0.15, [0, 1.52, 0], [0, 0, 0], 16);
  });
  rod(k, ss, [-5.5, 1.45, 0.4], [-4.79, 1.45, -0.21], 0.09, 16);
  k.at([-5.62, 1.45, 0.5], [0, Math.atan2(0.61, 0.71), 0], () => {
    k.rbox(KM.paintAccent, [0.24, 0.2, 0.2], 0.02, [0, 0, 0]);
    k.cyl(KM.paintAccent, 0.08, 0.26, [-0.2, 0, 0], [0, 0, HP], 16);
  });
}

/** Shell-and-tube condenser (horizontal) with channel heads, expansion joint, saddles and CW lines. */
function buildCondenser(k: Kit) {
  k.at([-1.5, 6.8, -1], 0, () => {
    k.at([0, 0, 0], [0, 0, -HP], () => {
      k.cyl(ss, 0.45, 3.0, [0, 0, 0], [0, 0, 0], 40, { open: true });
      for (const s of [-1, 1] as const) {
        k.cyl(ss, 0.56, 0.08, [0, s * 1.5, 0], [0, 0, 0], 40);
        boltCircle(k, 0.52, 20, s * 1.5 + s * 0.045, 0.012);
        k.cyl(ss, 0.45, 0.36, [0, s * 1.72, 0], [0, 0, 0], 40, { open: true });
        k.cyl(ss, 0.56, 0.06, [0, s * 1.9, 0], [0, 0, 0], 40);
        k.lathe(ss, head(0.45, s * 1.93, s), [0, 0, 0], [0, 0, 0], 40);
      }
      bellows(k, 0.52, 0.32, 4, [0, -0.16, 0], KM.stainlessDark);
      for (const y of [-0.8, 0.8]) k.cyl(KM.stainlessDark, 0.455, 0.012, [0, y, 0], [0, 0, 0], 40, { open: true, cast: false });
    });
    // saddles on the deck
    for (const x of [-0.95, 0.95]) {
      k.box(KM.paintGrey, [0.12, 0.3, 0.8], [x, -0.46, 0]);
      k.box(KM.paintGrey, [0.3, 0.02, 0.86], [x, -0.59, 0]);
      for (const z of [-0.3, 0.3]) k.box(KM.paintGrey, [0.2, 0.25, 0.02], [x, -0.47, z]);
    }
    // nozzles: CW in (bottom) / out (top), process in (left head), condensate out (right channel), vent
    k.at([1.1, -0.45, 0], [HP, 0, 0], () => nozzle(k, 0.07, 0.12));
    k.at([-1.1, 0.45, 0], [-HP, 0, 0], () => nozzle(k, 0.07, 0.12));
    k.at([-2.15, 0, 0], [0, -HP, 0], () => nozzle(k, 0.12, 0.12));
    k.at([1.72, -0.45, 0], [HP, 0, 0], () => nozzle(k, 0.06, 0.12));
    k.at([0.6, 0.45, 0], [-HP, 0, 0], () => nozzle(k, 0.03, 0.1));
    // CW supply/return to the rack, colour bands
    k.pipe(KM.paintAccent, [[1.1, -0.62, 0], [1.1, -0.9, 0], [1.1, -0.9, -3.0], [1.1, -1.72, -3.0], [1.1, -1.72, -3.3]], 0.07, 0.15);
    k.pipe(KM.paintAccent, [[-1.1, 0.62, 0], [-1.1, 0.85, 0], [-1.1, 0.85, -3.0], [-1.1, -1.72, -3.0], [-1.1, -1.72, -3.13]], 0.07, 0.15);
    k.cyl(KM.paintBlue, 0.078, 0.1, [1.1, -0.9, -1.2], [HP, 0, 0], 16);
    k.cyl(KM.paintRed, 0.078, 0.1, [-1.1, 0.85, -1.2], [HP, 0, 0], 16);
    plate(k, 'model', 'E-102', 'TCS CONDENSER · CW 18 °C', 0.5, 0.125, [0.2, 0.12, 0.462]);
  });
}

/** Distillation column: skirt, insulated shell with head, platforms, caged ladder, nozzles, manways. */
function buildColumn(k: Kit, x: number, z: number, r: number, h: number) {
  const sh = { shell: true };
  const R = r + 0.02;
  const tall = h > 9;
  const la = tall ? -0.45 : 0;
  k.at([x, 0, z], 0, () => {
    k.cyl(KM.paintGrey, r, 1.2, [0, 0.6, 0], [0, 0, 0], 40);
    ring(k, KM.paintGrey, r - 0.03, r + 0.16, 0, 0.04, 40);
    boltCircle(k, r + 0.1, 12, 0.045, 0.018);
    radial(k, r + 0.004, HP, 0.6, () => {
      k.box(KM.seam, [0.34, 0.56, 0.01], [0, 0, 0], [0, 0, 0], { cast: false });
      k.box(KM.paintGrey, [0.42, 0.05, 0.05], [0, 0.3, 0.01]);
      k.box(KM.paintGrey, [0.42, 0.05, 0.05], [0, -0.3, 0.01]);
    });
    cladding(k, R, 1.2, h, sh);
    k.lathe(clad, head(R, h, 1), [0, 0, 0], [0, 0, 0], 40, sh);
    const top = h + R / 2;
    k.cyl(ss, 0.1, 0.3, [0, top + 0.1, 0], [0, 0, 0], 16);
    ring(k, ss, 0.09, 0.19, top + 0.25, top + 0.3, 20);
    // relief valve on top
    k.cyl(ss, 0.05, 0.2, [0.25, top - 0.02, 0.1], [0, 0, 0], 12);
    k.rbox(KM.paintRed, [0.12, 0.16, 0.1], 0.015, [0.25, top + 0.15, 0.1]);
    // davit for lifting trays
    k.pipe(KM.paintYellow, [[-R * 0.7, top - 0.15, -R * 0.5], [-R * 0.7, top + 1.2, -R * 0.5], [0, top + 1.2, -R * 0.5]], 0.04, 0.2);
    // manways towards the aisle
    for (const y of [1.9, h - 1.3]) radial(k, R, HP + 0.35, y, () => manway(k, 0.22, 0.2));
    // thermowells on +X and a magnetic level gauge near the sump
    for (let y = 2.0; y < h - 0.2; y += 1.6) radial(k, R, la + 0.7, y, () => { nozzle(k, 0.035, 0.12); k.rbox(KM.anodized, [0.07, 0.09, 0.05], 0.01, [0, 0.05, 0.17]); });
    if (tall) radial(k, R, 0, h - 0.4, () => { nozzle(k, 0.035, 0.1); k.rbox(KM.anodized, [0.07, 0.09, 0.05], 0.01, [0, 0.05, 0.15]); });
    radial(k, R + 0.2, HP + 0.95, 0, () => {
      k.cyl(ss, 0.04, 1.0, [0, 1.85, 0], [0, 0, 0], 12);
      k.box(KM.paintRed, [0.03, 0.55, 0.012], [0, 1.75, 0.045], [0, 0, 0], { cast: false });
      k.box(KM.plasticWhite, [0.03, 0.4, 0.012], [0, 2.22, 0.045], [0, 0, 0], { cast: false });
      for (const y of [1.45, 2.25]) k.cyl(ss, 0.02, 0.22, [0, y, -0.11], [HP, 0, 0], 8);
    });
    // feed, overhead, draw-off and reboiler nozzles
    if (tall) {
      radial(k, R, (3 * Math.PI) / 4, 3.0, () => nozzle(k, 0.07, 0.12));
      radial(k, R, Math.asin(0.28 / 0.76), 9.5, () => nozzle(k, 0.09, 0.12));
    } else {
      radial(k, R, Math.PI - Math.asin(0.28 / 0.66), 2.0, () => nozzle(k, 0.09, 0.12));
      radial(k, R, HP, 4.5, () => nozzle(k, 0.08, 0.12));
    }
    radial(k, R, -HP, 1.4, () => nozzle(k, 0.07, 0.12));
    radial(k, R, -HP, 2.35, () => nozzle(k, 0.09, 0.12));
    // platforms with a gap for the caged ladder
    for (let y = 2.5; y <= h + 1e-6; y += 2.5) circPlatform(k, R + 0.03, r + 0.5, y, la + 0.32, la + TAU - 0.32);
    radial(k, R + 0.25, la, 0, () => ladder(k, 0, h));
    radial(k, R + 0.012, HP - 0.15, 1.5, () => plate(k, 'model', tall ? 'T-201' : 'T-202', tall ? 'HEAVY-ENDS COLUMN · 60 TRAYS' : 'LIGHT-ENDS COLUMN · 45 TRAYS', 0.42, 0.105, [0, 0, 0.02]));
    k.ao(r * 2.6, r * 2.6);
  });
}

/** Horizontal TCS bullet tank on saddles, nozzles, manway, level gauge, inside a bund. */
function buildTank(k: Kit) {
  k.at([6.5, 1.3, 1], 0, () => {
    k.at([0, 0, 0], [HP, 0, 0], () => {
      k.cyl(KM.paint, 0.9, 2.7, [0, 0, 0], [0, 0, 0], 48, { open: true });
      k.lathe(KM.paint, head(0.9, 1.35, 1), [0, 0, 0], [0, 0, 0], 48);
      k.lathe(KM.paint, head(0.9, -1.35, -1), [0, 0, 0], [0, 0, 0], 48);
      for (const y of [-1.35, 0, 1.35]) k.cyl(KM.paintGrey, 0.904, 0.012, [0, y, 0], [0, 0, 0], 48, { open: true, cast: false });
    });
    // saddles on concrete pedestals
    for (const zz of [-1.1, 1.1]) {
      const sad: P2[] = [[-0.7, -1.1], [0.7, -1.1], [0.7, -0.58]];
      for (let i = 0; i <= 12; i++) {
        const a = -0.69 - (i / 12) * (Math.PI - 1.38);
        sad.push([Math.cos(a) * 0.91, Math.sin(a) * 0.91]);
      }
      sad.push([-0.7, -0.58]);
      k.extrude(KM.paintGrey, sad, 0.03, [0, 0, zz - 0.015]);
      k.box(KM.paintGrey, [1.5, 0.02, 0.3], [0, -1.09, zz]);
      for (const x of [-0.45, 0, 0.45]) k.box(KM.paintGrey, [0.02, 0.2, 0.26], [x, -0.98, zz]);
      k.box(concrete, [1.6, 0.2, 0.45], [0, -1.2, zz]);
    }
    // top nozzles: inlet, PSV, radar level; manway on the +Z head; level gauge on +X
    k.at([0, 0.9, -1.0], [-HP, 0, 0], () => nozzle(k, 0.07, 0.18));
    k.at([0.2, 0.88, 0.3], [-HP, 0, 0], () => nozzle(k, 0.06, 0.16));
    k.rbox(KM.paintRed, [0.14, 0.2, 0.12], 0.015, [0.2, 1.18, 0.3]);
    k.pipe(ss, [[0.2, 1.28, 0.3], [0.2, 1.6, 0.3], [0.2, 1.6, -0.6]], 0.04, 0.1);
    k.at([-0.25, 0.88, 0.9], [-HP, 0, 0], () => nozzle(k, 0.05, 0.12));
    k.cyl(KM.anodized, 0.08, 0.16, [-0.25, 1.1, 0.9], [0, 0, 0], 16);
    k.at([0, 0.1, 1.72], 0, () => manway(k, 0.24, 0.15, {}, KM.paint));
    k.cyl(ss, 0.04, 1.4, [1.05, 0, 0.6], [0, 0, 0], 12);
    k.box(KM.paintRed, [0.012, 0.8, 0.03], [1.095, -0.15, 0.6], [0, 0, 0], { cast: false });
    for (const y of [-0.6, 0.6]) k.cyl(ss, 0.02, 0.2, [0.96, y, 0.6], [0, 0, HP], 8);
    plate(k, 'info', 'TK-301 · SiHCl₃', 'PURE TCS · 9N · 40 m³', 0.7, 0.175, [0.905, 0.15, -0.5], [0, HP, 0]);
    plate(k, 'warn', 'FLAMMABLE', '', 0.24, 0.24, [0.905, 0.15, 0.25], [0, HP, 0]);
    // bottom outlet towards the Siemens reactors
    k.pipe(ss, [[0, -0.88, 1.25], [0, -0.95, 1.25], [2.3, -0.95, 1.25]], 0.05, 0.06);
    valve(k, [1.2, -0.95, 1.25], 'x', 0.05);
  });
  // containment bund with coated floor
  for (const z of [-1.4, 3.4]) k.box(concrete, [3.4, 0.3, 0.15], [6.5, 0.15, z]);
  for (const x of [4.85, 8.15]) k.box(concrete, [0.15, 0.3, 4.95], [x, 0.15, 1]);
  k.box(KM.paintGrey, [3.15, 0.01, 4.65], [6.5, 0.005, 1], [0, 0, 0], { cast: false });
  k.ao(2.0, 4.0, [6.5, 0, 1]);
}

/** Station-wide: condenser structure, pipe rack, pumps, reboilers and process piping. */
function buildDistillPlant(k: Kit) {
  // condenser support structure with deck, rails and a caged ladder from the aisle
  const sx = [-3.2, -0.3];
  const sz = [-1.9, -0.1];
  for (const x of sx) for (const z of sz) iBeam(k, 6.2, [x, 0, z], 0.22, KM.paintGrey);
  for (const z of sz) {
    girder(k, [sx[0] - 0.1, 6.2, z], [sx[1] + 0.1, 6.2, z], 0.24, 0.14);
    girder(k, [sx[0] - 0.1, 3.1, z], [sx[1] + 0.1, 3.1, z], 0.2, 0.12);
  }
  for (const x of sx) girder(k, [x, 6.2, sz[0]], [x, 6.2, sz[1]], 0.24, 0.14);
  strut(k, KM.paintGrey, [sx[0] + 0.1, 0.2, sz[0]], [sx[1] - 0.1, 2.95, sz[0]], 0.07);
  strut(k, KM.paintGrey, [sx[0] + 0.1, 3.25, sz[0]], [sx[1] - 0.1, 6.0, sz[0]], 0.07);
  grating(k, 3.1, 1.95, [(sx[0] + sx[1]) / 2, 6.24, (sz[0] + sz[1]) / 2]);
  handrail(k, [[sx[0] - 0.05, 6.24, sz[1] + 0.05], [-1.3, 6.24, sz[1] + 0.05]], 1.05);
  handrail(k, [[-0.7, 6.24, sz[1] + 0.05], [sx[1] + 0.05, 6.24, sz[1] + 0.05], [sx[1] + 0.05, 6.24, sz[0] - 0.05]], 1.05);
  k.at([-1.0, 0, 0.12], 0, () => ladder(k, 0, 6.24));
  // pipe rack along the back: portals, two tiers, utility headers and a cable tray
  const rz = -4.2;
  for (let x = -7.5; x <= 7.6; x += 3) {
    for (const z of [rz - 0.4, rz + 0.4]) iBeam(k, 5.0, [x, 0, z], 0.2, KM.paintGrey);
    girder(k, [x, 5.0, rz - 0.5], [x, 5.0, rz + 0.5], 0.2, 0.12);
    girder(k, [x, 3.4, rz - 0.5], [x, 3.4, rz + 0.5], 0.18, 0.12);
  }
  for (const z of [rz - 0.4, rz + 0.4]) girder(k, [-7.6, 5.0, z], [7.6, 5.0, z], 0.16, 0.1);
  const lines: [THREE.Material, number, number][] = [
    [KM.anodized, 0.11, rz - 0.3],
    [ss, 0.07, rz - 0.08],
    [KM.paintAccent, 0.09, rz + 0.12],
    [ss, 0.05, rz + 0.3],
    [KM.stainlessDark, 0.04, rz + 0.42],
  ];
  for (const [m, rr, z] of lines) {
    k.cyl(m, rr, 15.8, [0.1, 5.0 + rr + 0.01, z], [0, 0, HP], 16);
    for (let x = -7.5; x <= 7.6; x += 3) k.box(KM.steel, [0.12, 0.04, rr * 1.6], [x, 5.02, z], [0, 0, 0], { cast: false });
  }
  for (let x = -6; x <= 6; x += 6) {
    k.cyl(ss, 0.12, 0.08, [x, 5.0 + 0.11 + 0.01, rz - 0.3], [0, 0, HP], 16);
    k.cyl(KM.paintYellow, 0.075, 0.12, [x + 0.4, 5.08, rz - 0.08], [0, 0, HP], 16);
  }
  plate(k, 'gas', 'HCl', '', 0.3, 0.06, [0.6, 5.08, rz - 0.005], [0, 0, 0], '#8a6a2a');
  plate(k, 'gas', 'CW', '', 0.3, 0.06, [-0.6, 5.1, rz + 0.215], [0, 0, 0], '#3e7d4c');
  tray(k, [-7.6, 3.42, rz], [7.6, 3.42, rz], 0.5, 6);
  // heavy-ends pump at the foot of column 1 and its discharge to the rack
  pump(k, [1.0, 0, -0.55], -HP);
  k.pipe(ss, [[1.0, 0.32, -1.38], [1.0, 0.32, -1.1]], 0.06, 0.05);
  k.pipe(ss, [[1.0, 0.66, -0.8], [1.0, 1.4, -0.8], [0.1, 1.4, -0.8], [0.1, 1.4, -3.9], [0.1, 5.15, -3.9]], 0.05, 0.12);
  valve(k, [1.0, 1.0, -0.8], 'y', 0.05);
  // thermosiphon reboilers behind the columns, steam from the rack
  for (const [x, zc, cr] of [[1.0, -3.3, 0.6], [3.5, -3.2, 0.5]] as const) {
    const tip = -2 - (cr + 0.02 + 0.12);
    k.at([x, 0, zc], 0, () => {
      for (const s of [-1, 1]) k.box(KM.paintGrey, [0.08, 0.6, 0.08], [s * 0.2, 0.3, 0]);
      cladding(k, 0.26, 0.6, 2.15, {}, 0.8);
      k.lathe(clad, head(0.26, 2.15, 1), [0, 0, 0], [0, 0, 0], 24);
      k.lathe(clad, head(0.26, 0.6, -1), [0, 0, 0], [0, 0, 0], 24);
      ring(k, ss, 0.26, 0.34, 1.9, 1.96, 24);
    });
    k.pipe(ss, [[x, 1.4, tip], [x, 1.4, zc + 0.36], [x, 0.38, zc + 0.36], [x, 0.38, zc], [x, 0.48, zc]], 0.06, 0.12);
    k.pipe(ss, [[x, 2.27, zc], [x, 2.35, zc], [x, 2.35, tip]], 0.08, 0.05);
    k.pipe(KM.anodized, [[x + 0.26, 1.7, zc], [x + 0.45, 1.7, zc], [x + 0.45, 1.7, rz + 0.3], [x + 0.45, 5.06, rz + 0.3]], 0.05, 0.1);
  }
  // condensate: condenser → column 1 feed
  k.pipe(ss, [[0.22, 6.14, -1], [0.22, 5.6, -1], [0.463, 5.6, -1], [0.463, 3.0, -1], [0.463, 3.0, -1.463]], 0.06, 0.12);
  valve(k, [0.463, 4.2, -1], 'y', 0.06);
  // column 1 overhead → column 2 feed
  k.pipe(ss, [[1.707, 9.5, -1.72], [2.38, 9.5, -1.72], [2.38, 2.0, -1.72], [2.902, 2.0, -1.72]], 0.09, 0.2);
  for (const y of [8.0, 5.0]) k.cyl(ss, 0.15, 0.05, [2.38, y, -1.72], [0, 0, 0], 16);
  // column 2 product draw → storage tank (route of the flow line)
  k.pipe(ss, [[3.5, 4.5, -1.34], [5.2, 4.5, -1.34], [6.5, 2.42, 0.0], [6.5, 2.3, 0.0]], 0.09, 0.25);
  valve(k, [4.4, 4.5, -1.34], 'x', 0.07);
  k.box(KM.paintGrey, [0.1, 3.3, 0.1], [5.86, 1.65, -0.67]);
  k.box(KM.paintGrey, [0.4, 0.08, 0.2], [5.86, 3.3, -0.67]);
  // column 2 light ends vent → rack
  k.pipe(ss, [[3.5, 8.6, -2], [3.5, 8.9, -2], [3.5, 8.9, -4.0], [3.5, 5.25, -4.0]], 0.05, 0.15);
}

/* ------------------------------------------------------------ 3 · distillation */

function Column({ x, z, r, h, label, id }: { x: number; z: number; r: number; h: number; label: string; id: string }) {
  const view = useUI((s) => s.view);
  const parts = useModel((k) => buildColumn(k, x, z, r, h), [x, z, r, h]);
  return (
    <Comp id={id} machine="fbr-distillation" label={label}>
      <Baked parts={parts} view={view} />
    </Comp>
  );
}

function Distillation() {
  const cx = X.distill;
  const bubbles = useRef<THREE.InstancedMesh>(null);
  const imp = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const t = useRef(0);
  useFrame((_, dt) => {
    const active = engine.stage.id === 'purification';
    t.current += active ? pdt(dt) : 0;
    const dist = active ? Math.max(pp('distill'), pp('store') > 0 ? 1 : 0) : 0;
    const on = active && (inPhase('distill') || inPhase('condense') || inPhase('react'));
    if (bubbles.current) {
      for (let i = 0; i < 80; i++) {
        const col = i % 2;
        const x = col ? cx + 3.5 : cx + 1;
        const h = col ? 8 : 10;
        const u = (t.current * 0.18 + i / 80) % 1;
        o.position.set(x + Math.sin(i * 7.3) * 0.3, 0.4 + u * (h - 0.8), -2 + Math.cos(i * 3.1) * 0.3);
        o.scale.setScalar(on ? 0.06 : 0.0001);
        o.updateMatrix();
        bubbles.current.setMatrixAt(i, o.matrix);
      }
      bubbles.current.instanceMatrix.needsUpdate = true;
    }
    if (imp.current) {
      // impurities: heavy ends sink to the bottom draw-off, light ends rise to the top vent
      for (let i = 0; i < 40; i++) {
        const heavy = i % 3 !== 0;
        const u = (t.current * 0.12 + i / 40) % 1;
        const y = heavy ? 9 - u * 8.6 : 1 + u * 7.0;
        const x = heavy ? cx + 1 : cx + 3.5;
        o.position.set(x + Math.sin(i * 5.1) * 0.35, y, -2 + Math.cos(i * 2.7) * 0.35);
        o.scale.setScalar(on && dist < 0.98 ? 0.07 : 0.0001);
        o.updateMatrix();
        imp.current.setMatrixAt(i, o.matrix);
        imp.current.setColorAt(i, new THREE.Color(heavy ? '#c9733a' : '#d6c35a'));
      }
      imp.current.instanceMatrix.needsUpdate = true;
      if (imp.current.instanceColor) imp.current.instanceColor.needsUpdate = true;
    }
    if (active) track('focus', cx + 1, 5, -2);
  });
  const at = (fn: (k: Kit) => void) => (k: Kit) => k.at([cx, 0, 0], 0, () => fn(k));
  const plant = useModel(at(buildDistillPlant), [cx]);
  const reactor = useModel(at(buildFBR), [cx]);
  const cond = useModel(at(buildCondenser), [cx]);
  const tank = useModel(at(buildTank), [cx]);
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'fbr-distillation', label: 'Hydrochlorination & distillation train' }}>
        {/* structure, pipe rack, pumps, reboilers, process piping */}
        <Baked parts={plant} />
        <Comp id="reactor" machine="fbr-distillation" label="Fluidised-bed reactor">
          <Baked parts={reactor} />
        </Comp>
        <Comp id="condenser" machine="fbr-distillation" label="Condenser">
          <Baked parts={cond} />
        </Comp>
        <Column x={cx + 1} z={-2} r={0.6} h={10} label="Distillation column 1 (heavy ends)" id="column" />
        <Column x={cx + 3.5} z={-2} r={0.5} h={8} label="Distillation column 2 (light ends)" id="column" />
        <Comp id="storage" machine="fbr-distillation" label="Pure TCS storage">
          <Baked parts={tank} />
        </Comp>
      </Clickable>
      <instancedMesh ref={bubbles} args={[GEO.sphereLow, new THREE.MeshStandardMaterial({ color: '#e6efd8', transparent: true, opacity: 0.6 }), 80]} />
      <instancedMesh ref={imp} args={[GEO.sphereLow, new THREE.MeshBasicMaterial({ color: '#ffffff' }), 40]} />
      <FlowLine points={[[cx + 5.2, 4.6, -1.5], [cx + 6.5, 2.6, 0]]} color="#cfe8b8" />
      <SensorIndicator id="thermocouple" channel="column" machine="fbr-distillation" position={[cx + 1.65, 9.6, -2]} size={0.16} />
      <SensorIndicator id="thermocouple" channel="reactor" machine="fbr-distillation" position={[cx - 3.2, 3.5, -1]} size={0.16} />
      <TechLabel position={[cx - 4, 6.9, -1]} title="FLUIDISED BED · Si + 3HCl → SiHCl₃ + H₂" />
      <TechLabel position={[cx + 1, 10.7, -2]} title="COLUMN 1 · HEAVY ENDS OUT BOTTOM" lines={['e.g. PCl₃, metal chlorides']} />
      <TechLabel position={[cx + 3.5, 8.7, -2]} title="COLUMN 2 · LIGHT ENDS OUT TOP" lines={['e.g. BCl₃']} />
      <TechLabel position={[cx + 6.5, 2.6, 1]} title="PURE SiHCl₃ → SIEMENS REACTOR" />
      <TcsInset position={[5, 3.0, 2]} />
    </group>
  );
}

/* ======================================================================
   4 · Siemens bell-jar reactor (station-local, origin at X.siemens)
   ====================================================================== */

/** Support frame, under-plate utilities, power cabinets, gas cabinet, off-gas line, pyrometer stand. */
function buildSiemensPlant(k: Kit, rods: [number, number][]) {
  // open steel frame under the base plate
  k.box(concrete, [3.56, 0.05, 3.56], [0, 0.025, 0]);
  for (const x of [-1.72, 1.72]) for (const z of [-1.72, 1.72]) k.box(KM.paintGrey, [0.16, 0.74, 0.16], [x, 0.43, z]);
  for (const s of [-1, 1]) {
    girder(k, [-1.8, 0.8, s * 1.72], [1.8, 0.8, s * 1.72], 0.16, 0.14);
    girder(k, [s * 1.72, 0.8, -1.8], [s * 1.72, 0.8, 1.8], 0.16, 0.14);
    girder(k, [-1.65, 0.8, s * 0.95], [1.65, 0.8, s * 0.95], 0.14, 0.12);
    strut(k, KM.paintGrey, [s * 1.72, 0.1, 1.72], [s * 1.72, 0.62, 1.1], 0.05);
    strut(k, KM.paintGrey, [s * 1.72, 0.1, -1.72], [s * 1.72, 0.62, -1.1], 0.05);
  }
  // electrode cooling manifolds and connections
  for (const [m, z] of [[KM.paintBlue, -0.35], [KM.paintRed, 0.35]] as const) {
    k.cyl(m, 0.035, 1.5, [0, 0.24, z], [0, 0, HP], 12);
    k.pipe(m, [[-0.75, 0.24, z], [-1.3, 0.24, z], [-1.3, 0.12, z], [-2.3, 0.12, z]], 0.035, 0.08);
  }
  for (const [x, z] of rods) {
    const zm = Math.sign(z) * 0.35;
    k.cyl(z < 0 ? KM.paintBlue : KM.paintRed, 0.015, Math.abs(zm - z), [x - Math.sign(x) * 0.08, 0.24, (z + zm) / 2], [HP, 0, 0], 6, { cast: false });
    k.cyl(z < 0 ? KM.paintBlue : KM.paintRed, 0.015, 0.1, [x - Math.sign(x) * 0.08, 0.29, z], [0, 0, 0], 6, { cast: false });
  }
  // copper bus bars from every electrode to the power supplies
  for (const sx of [-1, 1])
    for (let i = 0; i < 4; i++) k.box(KM.copper, [0.08, 0.025, 1.9], [sx * 0.66, 0.42 + i * 0.05, -1.0]);
  for (const sx of [-1, 1]) {
    k.box(KM.ptfe, [0.14, 0.32, 0.08], [sx * 0.66, 0.42, -1.6]);
    k.box(KM.copper, [0.1, 0.32, 0.6], [sx * 0.66, 0.2, -2.15]);
  }
  k.box(KM.steel, [2.2, 0.02, 0.8], [0, 0.07, -2.15]);
  for (let i = 0; i < 6; i++) k.box(KM.seam, [0.004, 0.004, 0.78], [-1.05 + i * 0.42, 0.081, -2.15], [0, 0, 0], { cast: false });
  // thyristor power cabinets
  for (const x of [-0.85, 0.85])
    k.at([x, 0, -2.9], 0, () => {
      cabinet(k, { size: [1.5, 2.1, 0.7], panels: 2, rows: [0.6], handles: true, vent: true });
      ledStrip(k, 0.6, [0, 1.95, 0.352]);
    });
  k.at([0.85, 0, -2.9], 0, () => {
    plate(k, 'model', 'PSU-8', 'ROD POWER · 8 × 600 kVA', 0.42, 0.105, [-0.35, 1.78, 0.352]);
    hmi(k, [0.3, 1.3, 0.6], 0);
    estop(k, [0.6, 0.95, 0.35]);
  });
  k.at([-0.85, 0, -2.9], 0, () => plate(k, 'warn', 'HIGH VOLTAGE', '', 0.16, 0.16, [0.45, 1.75, 0.352]));
  // gas cabinet: SiHCl₃ and H₂ sticks behind a glazed door
  k.at([2.9, 0, -0.55], 0, () => {
    const W = 1.2;
    const H = 1.9;
    const D = 0.6;
    k.box(KM.paintGraphite, [W - 0.05, 0.08, D - 0.05], [0, 0.04, 0]);
    k.rbox(KM.paint, [W + 0.01, 0.05, D + 0.01], 0.01, [0, H + 0.025, 0]);
    k.box(KM.paint, [W, H - 0.08, 0.03], [0, 0.08 + (H - 0.08) / 2, -D / 2 + 0.015]);
    for (const s of [-1, 1]) k.box(KM.paint, [0.03, H - 0.08, D], [s * (W / 2 - 0.015), 0.08 + (H - 0.08) / 2, 0]);
    k.box(KM.paint, [W, 0.62, 0.03], [0, 0.39, D / 2 - 0.015]);
    k.box(ss, [W - 0.08, 1.05, 0.01], [0, 1.25, -D / 2 + 0.035]);
    windowPane(k, W - 0.1, 1.06, [0, 1.25, D / 2 - 0.01]);
    gasStick(k, 0.9, [0, 1.0, -0.05]);
    gasStick(k, 0.9, [0, 1.42, -0.05]);
    for (const y of [1.0, 1.42]) k.pipe(ss, [[0.45, y, -0.05], [0.52, y, -0.05], [0.52, 0.2, -0.05]], 0.012, 0.05);
    plate(k, 'gas', 'SiHCl₃', '', 0.22, 0.045, [-0.25, 0.6, D / 2 + 0.002], [0, 0, 0], '#6b5a2e');
    plate(k, 'gas', 'H₂', '', 0.18, 0.045, [0.25, 0.6, D / 2 + 0.002], [0, 0, 0], '#8a3a32');
    k.cyl(ss, 0.1, 0.4, [0.35, H + 0.25, -0.1], [0, 0, 0], 16);
    k.ao(W, D);
  });
  // off-gas line from the base-plate exhaust nozzle
  k.pipe(ss, [[-1.0, 0.8, 0], [-1.0, 0.32, 0], [-2.6, 0.32, 0], [-2.6, 2.6, 0], [-2.6, 2.6, -3.2]], 0.09, 0.2);
  valve(k, [-2.6, 1.5, 0], 'y', 0.07);
  k.box(KM.paintGrey, [0.1, 2.5, 0.1], [-2.6, 1.25, -2.4]);
  plate(k, 'gas', 'OFF-GAS', '', 0.3, 0.06, [-2.6, 2.2, 0.095], [0, 0, 0], '#555c62');
  // pyrometer on a stand aimed at the sight glass
  k.at([2.15, 0, 0.27], 0, () => {
    k.box(KM.steel, [0.3, 0.015, 0.3], [0, 0.008, 0], [0, 0, 0], { cast: false });
    k.cyl(KM.anodizedDark, 0.03, 2.5, [0, 1.25, 0], [0, 0, 0], 10);
    k.rbox(KM.anodized, [0.24, 0.12, 0.12], 0.015, [-0.12, 2.6, 0]);
    k.cyl(KM.glassSmoke, 0.035, 0.03, [-0.25, 2.6, 0], [0, 0, HP], 16);
  });
  k.ao(3.8, 3.8, [0, 0, 0], 1.2);
}

/** Water-cooled base plate, swing-bolt clamps, electrode feedthroughs (top chucks, copper stems below). */
function buildBasePlate(k: Kit, rods: [number, number][]) {
  k.lathe(ss, crisp([[0.001, 0.8], [1.65, 0.8], [1.65, 1.1], [0.001, 1.1]]), [0, 0, 0], [0, 0, 0], 64);
  k.cyl(ss, 1.44, 0.004, [0, 1.102, 0], [0, 0, 0], 64, { cast: false });
  for (let i = 0; i < 24; i++)
    radial(k, 1.6, ((i + 0.5) / 24) * TAU, 1.1, () => {
      k.cyl(KM.stainlessDark, 0.016, 0.16, [0, 0.08, 0], [0, 0, 0], 6, { cast: false });
      k.cyl(KM.stainlessDark, 0.03, 0.03, [0, 0.15, 0], [0, 0, 0], 6, { cast: false });
    });
  for (const [x, z] of rods) {
    k.cyl(KM.ptfe, 0.1, 0.025, [x, 1.1125, z], [0, 0, 0], 20);
    k.lathe(M.graphite, [[0.08, 1.1], [0.05, 1.22], [0.001, 1.225]], [x, 0, z], [0, 0, 0], 16);
    k.cyl(KM.copper, 0.06, 0.5, [x, 0.55, z], [0, 0, 0], 16);
    k.cyl(KM.ptfe, 0.085, 0.12, [x, 0.72, z], [0, 0, 0], 16);
    k.cyl(KM.copper, 0.075, 0.06, [x, 0.34, z], [0, 0, 0], 16);
    k.box(KM.copper, [0.2, 0.03, 0.06], [x + Math.sign(x) * 0.08, 0.43, z]);
  }
  // exhaust nozzle and auxiliary feed nozzles
  k.cyl(ss, 0.12, 0.05, [-1.0, 1.12, 0], [0, 0, 0], 24);
  k.cyl(KM.seam, 0.08, 0.005, [-1.0, 1.146, 0], [0, 0, 0], 20, { cast: false });
}

/** Central gas nozzle and the TCS/H₂ feed line with flange, valve and MFC. */
function buildGasInlet(k: Kit) {
  k.cyl(ss, 0.05, 0.3, [0, 1.2, 0], [0, 0, 0], 16);
  k.cyl(KM.ptfe, 0.035, 0.05, [0, 1.37, 0], [0, 0, 0], 12);
  for (const z of [-0.35, 0.35]) k.cyl(ss, 0.03, 0.1, [0, 1.15, z], [0, 0, 0], 12);
  k.pipe(ss, [[0, 0.8, 0], [0, 0.3, 0], [2.5, 0.3, 0], [2.5, 0.3, -0.3]], 0.07, 0.15);
  k.cyl(ss, 0.12, 0.04, [1.6, 0.3, 0], [0, 0, HP], 16);
  valve(k, [1.9, 0.3, 0], 'x', 0.06);
  k.rbox(KM.anodized, [0.14, 0.16, 0.09], 0.012, [2.25, 0.42, 0]);
  k.box(KM.screen, [0.08, 0.04, 0.002], [2.25, 0.45, 0.046], [0, 0, 0], { cast: false });
}

/** Bell jar (moves with the jar group): jacketed double wall, polished liner, flange, sight glasses, lifting bail. */
function buildBellJar(k: Kit) {
  const sh = { shell: true };
  ring(k, ss, 1.46, 1.72, 1.1, 1.22, 64, sh);
  for (let i = 0; i < 24; i++) radial(k, 1.66, (i / 24) * TAU, 1.22, () => k.box(KM.stainlessDark, [0.06, 0.05, 0.08], [0, 0.025, 0], [0, 0, 0], { ...sh, cast: false }));
  k.cyl(KM.chrome, 1.46, 2.8, [0, 2.6, 0], [0, 0, 0], 64, { ...sh, open: true });
  k.cyl(ss, 1.52, 2.78, [0, 2.61, 0], [0, 0, 0], 64, { ...sh, open: true });
  const dome = (r: number): P2[] => Array.from({ length: 13 }, (_, i) => [Math.max(1e-3, r * Math.cos((i / 12) * HP)), 4.0 + r * Math.sin((i / 12) * HP)] as P2);
  k.lathe(ss, dome(1.52), [0, 0, 0], [0, 0, 0], 64, sh);
  k.lathe(KM.chrome, dome(1.46).reverse(), [0, 0, 0], [0, 0, 0], 48, sh);
  for (const y of [1.6, 2.3, 3.0, 3.7]) ring(k, KM.stainlessDark, 1.52, 1.565, y - 0.03, y + 0.03, 64, sh);
  ring(k, KM.stainlessDark, 1.52, 1.56, 3.97, 4.03, 64, sh);
  // jacket water in / out
  radial(k, 1.52, 2.5, 1.45, () => nozzle(k, 0.05, 0.16, sh));
  radial(k, 1.52, -0.9, 3.85, () => nozzle(k, 0.05, 0.16, sh));
  radial(k, 1.62, 2.5, 1.45, () => k.cyl(KM.paintBlue, 0.056, 0.06, [0, 0, 0.12], [HP, 0, 0], 12, sh));
  radial(k, 1.62, -0.9, 3.85, () => k.cyl(KM.paintRed, 0.056, 0.06, [0, 0, 0.12], [HP, 0, 0], 12, sh));
  // sight glasses (pyrometer port on +X)
  radial(k, 1.5, 0, 2.6, () => viewport(k, 0.12, 0.12, sh));
  radial(k, 1.5, 1.05, 2.0, () => viewport(k, 0.09, 0.1, sh));
  radial(k, 1.5, 2.2, 3.15, () => viewport(k, 0.09, 0.1, sh));
  // lifting lugs, top boss, bail
  for (const a of [0.4, 0.4 + (2 * Math.PI) / 3, 0.4 + (4 * Math.PI) / 3]) radial(k, 1.1, a, 5.05, () => k.box(ss, [0.04, 0.22, 0.2], [0, 0.1, 0], [0, 0, 0], sh));
  k.cyl(ss, 0.16, 0.12, [0, 5.56, 0], [0, 0, 0], 24, sh);
  k.cyl(KM.steel, 0.05, 2.4, [0, 6.6, 0], [0, 0, 0], 16);
  k.add(KM.steel, new THREE.TorusGeometry(0.14, 0.025, 8, 20), [0, 7.92, 0], [0, 0, 0]);
  shellLabel(k, 'model', 'PS-08', 'POLY CVD REACTOR · 8 RODS', 0.56, 0.14, [Math.cos(0.32) * 1.585, 3.35, Math.sin(0.32) * 1.585], [0, HP - 0.32, 0]);
  shellLabel(k, 'warn', 'HOT SURFACE', '', 0.16, 0.16, [Math.cos(0.75) * 1.575, 3.35, Math.sin(0.75) * 1.575], [0, HP - 0.75, 0]);
}

/** Polysilicon chunk tote on a pallet (outside the reactor selection, as before). */
function buildTote(k: Kit) {
  k.at([3.1, 0, 1.85], 0, () => {
    k.box(KM.plastic, [1.5, 0.04, 1.0], [0, 0.1, 0]);
    for (const x of [-0.6, 0, 0.6]) k.box(KM.plastic, [0.16, 0.08, 1.0], [x, 0.04, 0]);
    k.box(ss, [1.5, 0.04, 1.0], [0, 0.14, 0]);
    for (const s of [-1, 1]) {
      k.box(ss, [1.5, 0.66, 0.03], [0, 0.47, s * 0.5]);
      k.box(ss, [0.03, 0.66, 1.0], [s * 0.75, 0.47, 0]);
      k.box(KM.stainlessDark, [1.54, 0.03, 0.05], [0, 0.8, s * 0.5]);
      k.box(KM.stainlessDark, [0.05, 0.03, 1.04], [s * 0.75, 0.8, 0]);
    }
    k.box(KM.plasticWhite, [1.43, 0.02, 0.93], [0, 0.64, 0]);
    for (const s of [-1, 1]) {
      k.box(KM.plasticWhite, [1.43, 0.15, 0.01], [0, 0.72, s * 0.48]);
      k.box(KM.plasticWhite, [0.01, 0.15, 0.93], [s * 0.73, 0.72, 0]);
    }
    plate(k, 'tag', 'POLY-Si · 11N', 'BIN 03 · LOT P-0912', 0.42, 0.105, [0, 0.45, 0.517]);
    k.ao(1.6, 1.1);
  });
}

/* ------------------------------------------------------------ 4 · Siemens */

function Siemens() {
  const cx = X.siemens;
  const view = useUI((s) => s.view);
  const jar = useRef<THREE.Group>(null);
  const rods = useRef<(THREE.Mesh | null)[]>([]);
  const rodMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8c9196', emissive: new THREE.Color('#ff7a2a'), emissiveIntensity: 0, roughness: 0.4, metalness: 0.7, toneMapped: false }), []);
  const bin = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const ROD_POS: [number, number][] = [
    [-0.55, -0.55],
    [-0.55, -0.15],
    [0.55, -0.55],
    [0.55, -0.15],
    [-0.55, 0.15],
    [-0.55, 0.55],
    [0.55, 0.15],
    [0.55, 0.55],
  ];
  useFrame(() => {
    const active = engine.stage.id === 'polysilicon';
    const T = active ? engine.tele.value('rodT', 60) : 60;
    const D = active ? engine.tele.value('rodD', 150) : 150;
    const harvest = active ? pp('harvest') : 0;
    rodMat.emissiveIntensity = Math.max(0, (T - 500) / 600) * 1.6;
    const rr = (D / 1000) / 2;
    rods.current.forEach((m, i) => {
      if (!m) return;
      if (i < 8) m.scale.set(rr, 2.3, rr);
      else m.scale.set(rr, 0.42, rr);
      m.visible = harvest < 0.6;
    });
    if (jar.current) jar.current.position.y = 3.6 * smooth(harvest * 1.6);
    if (bin.current) {
      for (let i = 0; i < 60; i++) {
        o.position.set(cx + 2.6 + (i % 6) * 0.2, 0.75 + Math.floor(i / 12) * 0.12, 1.6 + Math.floor((i % 12) / 6) * 0.25 + ((i * 7) % 3) * 0.05);
        o.rotation.set(i, i * 2.3, i * 0.7);
        o.scale.setScalar(harvest > 0.55 + (i / 60) * 0.4 || !active ? 0.09 : 0.0001);
        o.updateMatrix();
        bin.current.setMatrixAt(i, o.matrix);
      }
      bin.current.instanceMatrix.needsUpdate = true;
    }
    if (active) track('focus', cx, 2.2, 0);
  });
  const at = (fn: (k: Kit) => void) => (k: Kit) => k.at([cx, 0, 0], 0, () => fn(k));
  const plant = useModel(at((k) => buildSiemensPlant(k, ROD_POS)), [cx]);
  const plate = useModel(at((k) => buildBasePlate(k, ROD_POS)), [cx]);
  const gas = useModel(at(buildGasInlet), [cx]);
  const jarParts = useModel(at(buildBellJar), [cx]);
  const tote = useModel(at(buildTote), [cx]);
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'siemens-reactor', label: 'Siemens CVD reactor' }}>
        {/* support frame, under-plate utilities, power & gas cabinets, off-gas */}
        <Baked parts={plant} />
        <Comp id="electrodes" machine="siemens-reactor" label="Base-plate electrodes">
          <Baked parts={plate} />
        </Comp>
        <Comp id="gas-inlet" machine="siemens-reactor" label="Gas inlet nozzles">
          <Baked parts={gas} />
        </Comp>
        <Comp id="rods" machine="siemens-reactor" label="Silicon rods (U-shaped pairs)">
          {ROD_POS.map(([x, z], i) => (
            <mesh key={i} ref={(m) => { rods.current[i] = m; }} geometry={GEO.cyl} material={rodMat} position={[cx + x, 1.1 + 1.15, z]} castShadow />
          ))}
          {[0, 2, 4, 6].map((k, j) => {
            const [x1, z1] = ROD_POS[k];
            const [, z2] = ROD_POS[k + 1];
            return <mesh key={`b${j}`} ref={(m) => { rods.current[8 + j] = m; }} geometry={GEO.cyl} material={rodMat} position={[cx + x1, 3.4, (z1 + z2) / 2]} rotation={[Math.PI / 2, 0, 0]} />;
          })}
        </Comp>
        <group ref={jar}>
          <Comp id="bell-jar" machine="siemens-reactor" label="Bell jar">
            <Baked parts={jarParts} view={view} />
          </Comp>
        </group>
      </Clickable>
      <Baked parts={tote} />
      <instancedMesh ref={bin} args={[rockGeo, polyMat, 60]} castShadow />
      <SensorIndicator id="pyrometer" channel="rodT" machine="siemens-reactor" position={[cx + 1.7, 2.6, 0.25]} size={0.14} />
      <SensorIndicator id="mfc" channel="tcs" machine="siemens-reactor" position={[cx + 2.3, 0.45, 0.2]} size={0.12} />
      <TechLabel position={[cx, 5.8, 0]} title="BELL JAR · ROD SURFACE ≈ 1100 °C" lines={['SiHCl₃ + H₂ → Si + 3HCl']} />
      <TechLabel position={[cx + 3.1, 1.3, 1.85]} title="POLYSILICON CHUNKS · 9N–11N" />
      <GrainsInset position={[25, 3.0, 2]} />
    </group>
  );
}

/* ------------------------------------------------------------ scene */

export default function MaterialsScene({ stage }: SceneProps) {
  const variant = stage.variant ?? 'quartz';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.05;
  }, []);
  const cx = X[variant as keyof typeof X] ?? 0;
  return (
    <>
      <Lighting env="hall" shadowExtent={15} center={[cx, 0, 0]} />
      <Hall width={92} depth={30} height={14} />
      <QuartzStation />
      <ArcFurnace />
      <Distillation />
      <Siemens />
      {/* the material route through the hall */}
      <FlowLine points={[[-20, 0.05, 6], [-10, 0.05, 6], [10, 0.05, 6], [30, 0.05, 6]]} color="#c8d8a6" speed={1.2} width={2} />
      <TechLabel position={[0, 0.4, 6.4]} title="MATERIAL FLOW · QUARTZ → MG-Si → TCS → POLYSILICON" min={2} tone="accent" />
    </>
  );
}
