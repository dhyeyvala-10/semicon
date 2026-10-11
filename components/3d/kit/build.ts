/**
 * Procedural equipment builder.
 *
 * Detailed machines are made of hundreds of small parts (panel seams, bolts, flanges,
 * grille slats). Drawing each as its own mesh would cost hundreds of draw calls, so the
 * builder collects parts per material and merges them: one mesh per finish per model.
 * Moving parts stay separate meshes in the scene; everything static goes through here.
 *
 *   const parts = useMemo(() => { const k = new Kit(); cabinet(k, {...}); return k.build(); }, []);
 *   <Baked parts={parts} />
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { KM, aoMaterial, labelMaterial } from './finish';

export type V3 = [number, number, number];

/* ------------------------------------------------------------ templates */

const flat = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);
const T_BOX = flat(new THREE.BoxGeometry(1, 1, 1));
const cylCache = new Map<string, THREE.BufferGeometry>();
function unitCyl(seg: number, open = false, top = 1) {
  const k = `${seg}:${open}:${top}`;
  let g = cylCache.get(k);
  if (!g) cylCache.set(k, (g = flat(new THREE.CylinderGeometry(top, 1, 1, seg, 1, open))));
  return g;
}
const rboxCache = new Map<string, THREE.BufferGeometry>();
function rboxGeo(w: number, h: number, d: number, r: number, seg = 2) {
  const rr = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  const k = `${w.toFixed(4)}:${h.toFixed(4)}:${d.toFixed(4)}:${rr.toFixed(4)}:${seg}`;
  let g = rboxCache.get(k);
  if (!g) rboxCache.set(k, (g = flat(new RoundedBoxGeometry(w, h, d, seg, Math.max(1e-4, rr)))));
  return g;
}

/* ------------------------------------------------------------ builder */

interface Bin {
  m: THREE.Material;
  shell: boolean;
  cast: boolean;
  keepUV: boolean;
  parts: THREE.BufferGeometry[];
}

export interface BakedPart {
  material: THREE.Material;
  geometry: THREE.BufferGeometry;
  /** outer shell: follows x-ray / cut-away view modes */
  shell: boolean;
  cast: boolean;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

export interface PartOpts {
  shell?: boolean;
  /** cast shadows (default: true for parts larger than a few cm) */
  cast?: boolean;
  /** keep the geometry's own UVs (labels, decals) instead of world-projected ones */
  keepUV?: boolean;
}

export class Kit {
  private bins = new Map<string, Bin>();
  private stack: THREE.Matrix4[] = [new THREE.Matrix4()];
  /** texel scale of the world-projected UVs (repeats per metre) */
  uvScale = 2.2;

  private get top() {
    return this.stack[this.stack.length - 1];
  }

  /** Build children in a local frame (position, Euler rotation, uniform or vector scale). */
  at(pos: V3, rot: V3 | number = [0, 0, 0], fn: () => void, scale: number | V3 = 1) {
    const r = typeof rot === 'number' ? ([0, rot, 0] as V3) : rot;
    const s = typeof scale === 'number' ? ([scale, scale, scale] as V3) : scale;
    const m = new THREE.Matrix4().compose(_p.set(...pos), _q.setFromEuler(_e.set(...r)), _s.set(...s));
    this.stack.push(this.top.clone().multiply(m));
    fn();
    this.stack.pop();
    return this;
  }

  /** Add any geometry (it is copied) with a local transform. */
  add(m: THREE.Material, g: THREE.BufferGeometry, pos: V3 = [0, 0, 0], rot: V3 = [0, 0, 0], scale: V3 = [1, 1, 1], o: PartOpts = {}) {
    const c = flat(g) === g ? g.clone() : flat(g);
    _m.compose(_p.set(...pos), _q.setFromEuler(_e.set(...rot)), _s.set(...scale));
    c.applyMatrix4(this.top.clone().multiply(_m));
    const shell = !!o.shell;
    const cast = o.cast ?? true;
    const keepUV = !!o.keepUV;
    const key = `${m.uuid}:${shell ? 1 : 0}:${cast ? 1 : 0}:${keepUV ? 1 : 0}`;
    let b = this.bins.get(key);
    if (!b) this.bins.set(key, (b = { m, shell, cast, keepUV, parts: [] }));
    b.parts.push(c);
    return this;
  }

  box(m: THREE.Material, s: V3, pos: V3 = [0, 0, 0], rot: V3 = [0, 0, 0], o: PartOpts = {}) {
    const small = Math.max(...s) < 0.04;
    return this.add(m, T_BOX, pos, rot, s, { cast: !small, ...o });
  }

  /** Box with rounded edges (radius r). */
  rbox(m: THREE.Material, s: V3, r: number, pos: V3 = [0, 0, 0], rot: V3 = [0, 0, 0], o: PartOpts = {}) {
    return this.add(m, rboxGeo(s[0], s[1], s[2], r), pos, rot, [1, 1, 1], o);
  }

  /** Cylinder along Y. */
  cyl(m: THREE.Material, r: number, h: number, pos: V3 = [0, 0, 0], rot: V3 = [0, 0, 0], seg = 32, o: PartOpts & { open?: boolean; top?: number } = {}) {
    const small = r < 0.02 && h < 0.06;
    return this.add(m, unitCyl(seg, !!o.open, o.top ?? 1), pos, rot, [r, h, r], { cast: !small, ...o });
  }

  /** Torus in the XZ plane (rings, gaskets, flange beads). */
  torus(m: THREE.Material, R: number, r: number, pos: V3 = [0, 0, 0], rot: V3 = [0, 0, 0], seg = 40, o: PartOpts = {}) {
    return this.add(m, new THREE.TorusGeometry(R, r, 8, seg), pos, [rot[0] + Math.PI / 2, rot[1], rot[2]], [1, 1, 1], o);
  }

  /** Surface of revolution (profile in x = radius, y = height). */
  lathe(m: THREE.Material, profile: [number, number][], pos: V3 = [0, 0, 0], rot: V3 = [0, 0, 0], seg = 48, o: PartOpts = {}) {
    return this.add(m, new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), seg), pos, rot, [1, 1, 1], o);
  }

  /** Tube through points (pipes, hoses, rails). */
  tube(m: THREE.Material, points: V3[], radius: number, o: PartOpts & { radial?: number; tension?: number; closed?: boolean } = {}) {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), !!o.closed, 'catmullrom', o.tension ?? 0.05);
    return this.add(m, new THREE.TubeGeometry(curve, Math.max(12, points.length * 10), radius, o.radial ?? 10, !!o.closed), [0, 0, 0], [0, 0, 0], [1, 1, 1], { cast: radius > 0.015, ...o });
  }

  /** Orthogonal pipe run with tight bends (process piping). */
  pipe(m: THREE.Material, points: V3[], radius: number, bend = 0.08, o: PartOpts = {}) {
    const path = new THREE.CurvePath<THREE.Vector3>();
    const v = points.map((p) => new THREE.Vector3(...p));
    let prev = v[0].clone();
    for (let i = 1; i < v.length; i++) {
      const a = v[i];
      if (i < v.length - 1) {
        const inDir = a.clone().sub(v[i - 1]).normalize();
        const outDir = v[i + 1].clone().sub(a).normalize();
        const r = Math.min(bend, a.distanceTo(v[i - 1]) / 2, a.distanceTo(v[i + 1]) / 2);
        const p1 = a.clone().addScaledVector(inDir, -r);
        const p2 = a.clone().addScaledVector(outDir, r);
        if (prev.distanceTo(p1) > 1e-5) path.add(new THREE.LineCurve3(prev.clone(), p1));
        path.add(new THREE.QuadraticBezierCurve3(p1, a.clone(), p2));
        prev = p2;
      } else path.add(new THREE.LineCurve3(prev.clone(), a.clone()));
    }
    const segs = Math.max(16, v.length * 12);
    return this.add(m, new THREE.TubeGeometry(path as unknown as THREE.Curve<THREE.Vector3>, segs, radius, 10, false), [0, 0, 0], [0, 0, 0], [1, 1, 1], { cast: radius > 0.015, ...o });
  }

  /** Extruded 2D profile (I-beams, channels, brackets), extruded along +Z by depth. */
  extrude(m: THREE.Material, shape: [number, number][], depth: number, pos: V3 = [0, 0, 0], rot: V3 = [0, 0, 0], o: PartOpts & { bevel?: number } = {}) {
    const s = new THREE.Shape(shape.map(([x, y]) => new THREE.Vector2(x, y)));
    const bevel = o.bevel ?? 0;
    const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 1, curveSegments: 6 });
    return this.add(m, g, pos, rot, [1, 1, 1], o);
  }

  /** Soft contact shadow on the floor under a footprint (w × d, centred). */
  ao(w: number, d: number, pos: V3 = [0, 0, 0], spread = 1.35) {
    const g = new THREE.PlaneGeometry(w * spread, d * spread);
    return this.add(aoMaterial(), g, [pos[0], pos[1] + 0.003, pos[2]], [-Math.PI / 2, 0, 0], [1, 1, 1], { cast: false, keepUV: true });
  }

  /** Label plate (model plate, hazard sign, gas tag) facing local +Z. */
  label(kind: Parameters<typeof labelMaterial>[0], text: string, sub: string, w: number, h: number, pos: V3, rot: V3 = [0, 0, 0], accent?: string) {
    return this.add(labelMaterial(kind, text, sub, accent), new THREE.PlaneGeometry(w, h), pos, rot, [1, 1, 1], { cast: false, keepUV: true });
  }

  /** Merge every bin into one geometry per material. */
  build(): BakedPart[] {
    const out: BakedPart[] = [];
    for (const b of this.bins.values()) {
      const merged = mergeGeometries(b.parts, false);
      for (const p of b.parts) p.dispose();
      if (!merged) continue;
      if (!b.keepUV) worldUV(merged, this.uvScale);
      merged.computeBoundingSphere();
      out.push({ material: b.m, geometry: merged, shell: b.shell, cast: b.cast });
    }
    return out;
  }
}

/** Box-projected UVs from world position: uniform texel density across all parts. */
function worldUV(g: THREE.BufferGeometry, scale: number) {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const nx = Math.abs(n.getX(i));
    const ny = Math.abs(n.getY(i));
    const nz = Math.abs(n.getZ(i));
    let u: number;
    let v: number;
    if (nx >= ny && nx >= nz) {
      u = p.getZ(i);
      v = p.getY(i);
    } else if (ny >= nz) {
      u = p.getX(i);
      v = p.getZ(i);
    } else {
      u = p.getX(i);
      v = p.getY(i);
    }
    uv[i * 2] = u * scale;
    uv[i * 2 + 1] = v * scale;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/* ======================================================================
   Detail recipes. Each adds parts to a kit in the current local frame.
   Convention: +Z is the front (operator side), +Y up, origin on the floor.
   ====================================================================== */

export interface CabinetOpts {
  size: V3;
  body?: THREE.Material;
  trim?: THREE.Material;
  /** recessed kick plate height */
  plinth?: number;
  /** number of front panels across the width */
  panels?: number;
  /** heights (from floor) of horizontal front seams */
  rows?: number[];
  /** number of side panels along the depth */
  sidePanels?: number;
  /** louvred vent in the lower front panel(s) */
  vent?: boolean;
  /** recessed handles on front panels */
  handles?: boolean;
  /** accent stripe along the top edge */
  stripe?: THREE.Material | false;
  /** follows x-ray / cut-away */
  shell?: boolean;
  /** skip the back face details (against a wall) */
  bolts?: boolean;
  feet?: boolean;
  ao?: boolean;
}

/** Equipment cabinet: kick plate, rounded panels with seams, fasteners, vents, handles. */
export function cabinet(k: Kit, o: CabinetOpts) {
  const [w, h, d] = o.size;
  const body = o.body ?? KM.paint;
  const trim = o.trim ?? KM.paintGraphite;
  const pl = o.plinth ?? Math.min(0.1, h * 0.08);
  const sh = { shell: !!o.shell };
  const r = Math.min(0.018, w * 0.04, d * 0.04);
  // kick plate, set back 25 mm
  k.box(trim, [w - 0.05, pl, d - 0.05], [0, pl / 2, 0], [0, 0, 0], sh);
  // body
  k.rbox(body, [w, h - pl, d], r, [0, pl + (h - pl) / 2, 0], [0, 0, 0], sh);
  // top cap (slight overhang)
  k.rbox(trim, [w + 0.012, 0.022, d + 0.012], 0.006, [0, h + 0.011, 0], [0, 0, 0], sh);
  if (o.stripe !== false) k.box(o.stripe ?? KM.paintAccent, [w * 0.999, 0.012, 0.003], [0, h - 0.05, d / 2 + 0.0015], [0, 0, 0], { cast: false, ...sh });
  const n = o.panels ?? Math.max(1, Math.round(w / 0.7));
  const pw = w / n;
  const seamW = 0.0045;
  const z = d / 2 + 0.0012;
  // front vertical seams
  for (let i = 1; i < n; i++) k.box(KM.seam, [seamW, h - pl - 0.03, 0.002], [-w / 2 + i * pw, pl + (h - pl) / 2, z], [0, 0, 0], { cast: false, ...sh });
  // front horizontal seams
  const rows = o.rows ?? [pl + (h - pl) * 0.32];
  for (const y of rows) k.box(KM.seam, [w - 0.03, seamW, 0.002], [0, y, z], [0, 0, 0], { cast: false, ...sh });
  // side seams
  const sp = o.sidePanels ?? Math.max(1, Math.round(d / 0.8));
  for (const sx of [-1, 1])
    for (let i = 1; i < sp; i++) k.box(KM.seam, [0.002, h - pl - 0.03, seamW], [sx * (w / 2 + 0.0012), pl + (h - pl) / 2, -d / 2 + (i * d) / sp], [0, 0, 0], { cast: false, ...sh });
  // panel fasteners: four per front panel
  if (o.bolts !== false) {
    const edges = [pl, ...rows, h].sort((a, b) => a - b);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < edges.length - 1; j++) {
        const x0 = -w / 2 + i * pw + 0.03;
        const x1 = -w / 2 + (i + 1) * pw - 0.03;
        const y0 = edges[j] + 0.03;
        const y1 = edges[j + 1] - 0.03;
        if (y1 - y0 < 0.08) continue;
        for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]])
          k.cyl(KM.stainlessDark, 0.0055, 0.004, [x, y, z + 0.001], [Math.PI / 2, 0, 0], 8, { cast: false, ...sh });
      }
  }
  // louvred vent in the lower front band
  if (o.vent !== false) {
    const vh = Math.min(0.16, (rows[0] ?? h * 0.3) - pl - 0.06);
    if (vh > 0.05)
      for (let i = 0; i < n; i++) {
        const cx = -w / 2 + (i + 0.5) * pw;
        const vw = pw * 0.62;
        k.box(KM.seam, [vw, vh, 0.002], [cx, pl + 0.04 + vh / 2, z], [0, 0, 0], { cast: false, ...sh });
        const slats = Math.max(3, Math.floor(vh / 0.018));
        for (let s = 0; s < slats; s++) k.box(body, [vw - 0.01, 0.006, 0.008], [cx, pl + 0.045 + (s + 0.5) * (vh / slats), z + 0.002], [-0.5, 0, 0], { cast: false, ...sh });
      }
  }
  // recessed pull handles
  if (o.handles) {
    const y = Math.min(h - 0.25, 1.05);
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + (i + 1) * pw - 0.07;
      k.box(KM.seam, [0.022, 0.16, 0.002], [x, y, z], [0, 0, 0], { cast: false, ...sh });
      k.rbox(KM.anodized, [0.014, 0.14, 0.012], 0.004, [x, y, z + 0.004], [0, 0, 0], { cast: false, ...sh });
    }
  }
  if (o.feet) for (const [x, zz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) foot(k, [x * (w / 2 - 0.06), 0, zz * (d / 2 - 0.06)]);
  if (o.ao !== false) k.ao(w, d);
}

/** Levelling foot. */
export function foot(k: Kit, pos: V3) {
  k.cyl(KM.rubber, 0.03, 0.015, [pos[0], 0.0075, pos[2]], [0, 0, 0], 16, { cast: false });
  k.cyl(KM.stainless, 0.008, 0.05, [pos[0], 0.04, pos[2]], [0, 0, 0], 8, { cast: false });
  k.cyl(KM.stainlessDark, 0.016, 0.012, [pos[0], 0.035, pos[2]], [0, 0, 0], 6, { cast: false });
}

/** Bolt circle in the local XZ plane at height y (flanges, lids). */
export function boltCircle(k: Kit, R: number, n: number, y: number, r = 0.008, m: THREE.Material = KM.stainlessDark, o: PartOpts = {}) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    k.cyl(m, r, r * 0.9, [Math.cos(a) * R, y, Math.sin(a) * R], [0, a, 0], 6, { cast: false, ...o });
  }
}

/** Vacuum flange pair (CF/ISO style) around a vertical tube at height y. */
export function flange(k: Kit, R: number, y: number, o: PartOpts & { bolts?: number; t?: number; m?: THREE.Material } = {}) {
  const t = o.t ?? Math.max(0.012, R * 0.08);
  const m = o.m ?? KM.stainless;
  k.cyl(m, R * 1.16, t, [0, y - t / 2 - 0.001, 0], [0, 0, 0], 48, o);
  k.cyl(m, R * 1.16, t, [0, y + t / 2 + 0.001, 0], [0, 0, 0], 48, o);
  k.torus(KM.seam, R * 1.155, 0.0015, [0, y, 0], [0, 0, 0], 48, { cast: false, ...o });
  boltCircle(k, R * 1.09, o.bolts ?? Math.max(8, Math.round(R * 60)), y + t + 0.002, Math.max(0.005, R * 0.035), KM.stainlessDark, o);
}

/** Viewport: flanged port with glass, pointing along local +Z from its base. */
export function viewport(k: Kit, r: number, len = r * 1.2, o: PartOpts & { glass?: THREE.Material } = {}) {
  k.cyl(KM.stainless, r, len, [0, 0, len / 2], [Math.PI / 2, 0, 0], 24, o);
  k.cyl(KM.stainless, r * 1.45, r * 0.22, [0, 0, len], [Math.PI / 2, 0, 0], 32, o);
  k.cyl(o.glass ?? KM.glassSmoke, r * 0.82, 0.004, [0, 0, len + r * 0.12], [Math.PI / 2, 0, 0], 24, { cast: false, ...o });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.cyl(KM.stainlessDark, r * 0.08, r * 0.1, [Math.cos(a) * r * 1.22, Math.sin(a) * r * 1.22, len + r * 0.14], [Math.PI / 2, 0, 0], 6, { cast: false, ...o });
  }
}

/** Corrugated bellows along Y (vacuum feedthroughs, lift columns). */
export function bellows(k: Kit, r: number, h: number, folds: number, pos: V3 = [0, 0, 0], m: THREE.Material = KM.stainless, o: PartOpts = {}) {
  const prof: [number, number][] = [[r * 0.86, 0]];
  for (let i = 0; i <= folds * 2; i++) prof.push([i % 2 ? r : r * 0.86, (i / (folds * 2)) * h]);
  k.lathe(m, prof, pos, [0, 0, 0], 32, o);
}

/** Louvred grille panel facing +Z (w × h). */
export function grille(k: Kit, w: number, h: number, pos: V3, o: PartOpts & { m?: THREE.Material; pitch?: number } = {}) {
  const m = o.m ?? KM.anodizedDark;
  k.box(KM.seam, [w, h, 0.004], [pos[0], pos[1], pos[2]], [0, 0, 0], { cast: false, ...o });
  const n = Math.max(3, Math.floor(h / (o.pitch ?? 0.022)));
  for (let i = 0; i < n; i++) k.box(m, [w - 0.012, 0.007, 0.01], [pos[0], pos[1] - h / 2 + (i + 0.5) * (h / n), pos[2] + 0.004], [-0.55, 0, 0], { cast: false, ...o });
  // frame
  k.box(m, [w + 0.016, 0.008, 0.012], [pos[0], pos[1] + h / 2 + 0.004, pos[2] + 0.002], [0, 0, 0], { cast: false, ...o });
  k.box(m, [w + 0.016, 0.008, 0.012], [pos[0], pos[1] - h / 2 - 0.004, pos[2] + 0.002], [0, 0, 0], { cast: false, ...o });
  k.box(m, [0.008, h, 0.012], [pos[0] - w / 2 - 0.004, pos[1], pos[2] + 0.002], [0, 0, 0], { cast: false, ...o });
  k.box(m, [0.008, h, 0.012], [pos[0] + w / 2 + 0.004, pos[1], pos[2] + 0.002], [0, 0, 0], { cast: false, ...o });
}

/** Window with a framed glass pane, facing +Z, centred at pos. */
export function windowPane(k: Kit, w: number, h: number, pos: V3, o: PartOpts & { frame?: THREE.Material; glass?: THREE.Material } = {}) {
  const f = o.frame ?? KM.anodizedDark;
  const t = 0.022;
  k.box(f, [w + t * 2, t, 0.03], [pos[0], pos[1] + h / 2 + t / 2, pos[2]], [0, 0, 0], o);
  k.box(f, [w + t * 2, t, 0.03], [pos[0], pos[1] - h / 2 - t / 2, pos[2]], [0, 0, 0], o);
  k.box(f, [t, h, 0.03], [pos[0] - w / 2 - t / 2, pos[1], pos[2]], [0, 0, 0], o);
  k.box(f, [t, h, 0.03], [pos[0] + w / 2 + t / 2, pos[1], pos[2]], [0, 0, 0], o);
  k.box(o.glass ?? KM.glass, [w, h, 0.006], [pos[0], pos[1], pos[2]], [0, 0, 0], { cast: false, ...o });
}

/** Steel I-beam column/girder along local Y, height h. */
export function iBeam(k: Kit, h: number, pos: V3, size = 0.3, m: THREE.Material = KM.paintGrey, rot: V3 = [0, 0, 0]) {
  const b = size / 2;
  const tf = size * 0.08;
  const tw = size * 0.05;
  const shape: [number, number][] = [
    [-b, -b], [b, -b], [b, -b + tf], [tw / 2, -b + tf], [tw / 2, b - tf], [b, b - tf], [b, b], [-b, b], [-b, b - tf], [-tw / 2, b - tf], [-tw / 2, -b + tf], [-b, -b + tf],
  ];
  k.at(pos, rot, () => {
    k.extrude(m, shape, h, [0, 0, 0], [-Math.PI / 2, 0, 0]);
    // base plate with anchor bolts
    k.box(KM.steel, [size * 1.6, 0.025, size * 1.6], [0, 0.0125, 0]);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.cyl(KM.stainlessDark, 0.012, 0.03, [x * size * 0.62, 0.035, z * size * 0.62], [0, 0, 0], 6, { cast: false });
  });
}

/** Tubular handrail along a polyline with posts. */
export function handrail(k: Kit, points: V3[], height = 1.05, m: THREE.Material = KM.paintYellow) {
  const top = points.map((p) => [p[0], p[1] + height, p[2]] as V3);
  k.pipe(m, top, 0.021, 0.08);
  const mid = points.map((p) => [p[0], p[1] + height * 0.5, p[2]] as V3);
  k.pipe(m, mid, 0.015, 0.08);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const n = Math.max(1, Math.ceil(len / 1.2));
    for (let j = 0; j <= n; j++) {
      if (i > 0 && j === 0) continue;
      const t = j / n;
      k.cyl(m, 0.02, height, [a[0] + (b[0] - a[0]) * t, a[1] + height / 2, a[2] + (b[2] - a[2]) * t], [0, 0, 0], 12);
    }
  }
}

/** Ladder-type cable tray from a to b (horizontal), with a bundle of cables. */
export function cableTray(k: Kit, a: V3, b: V3, w = 0.3, cables = 5) {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const len = Math.hypot(dx, dz);
  const yaw = Math.atan2(dx, dz);
  k.at(a, [0, yaw, 0], () => {
    for (const s of [-1, 1]) k.box(KM.anodized, [0.004, 0.06, len], [s * w / 2, 0.03, len / 2], [0, 0, 0], { cast: false });
    const rungs = Math.floor(len / 0.3);
    for (let i = 0; i <= rungs; i++) k.box(KM.anodized, [w, 0.008, 0.02], [0, 0.004, (i * len) / Math.max(1, rungs)], [0, 0, 0], { cast: false });
    const cols = [KM.plastic, KM.paintGraphite, KM.paintBlue, KM.plastic, KM.paintDark];
    for (let i = 0; i < cables; i++) {
      const x = -w / 2 + 0.04 + (i * (w - 0.08)) / Math.max(1, cables - 1);
      k.cyl(cols[i % cols.length], 0.012 + (i % 3) * 0.003, len, [x, 0.02 + (i % 2) * 0.012, len / 2], [Math.PI / 2, 0, 0], 8, { cast: false });
    }
  });
}

/** Gas stick: a row of surface-mount components (valves, regulator, MFC) facing +Z. */
export function gasStick(k: Kit, len: number, pos: V3) {
  k.at(pos, 0, () => {
    k.box(KM.stainless, [len, 0.03, 0.04], [0, 0, 0]);
    const n = Math.max(3, Math.floor(len / 0.07));
    for (let i = 0; i < n; i++) {
      const x = -len / 2 + (i + 0.5) * (len / n);
      const kind = i % 4;
      if (kind === 2) {
        k.rbox(KM.stainless, [0.05, 0.07, 0.045], 0.004, [x, 0.05, 0]);
        k.box(KM.screen, [0.03, 0.012, 0.002], [x, 0.06, 0.024], [0, 0, 0], { cast: false });
      } else {
        k.cyl(KM.stainless, 0.016, 0.05, [x, 0.04, 0], [0, 0, 0], 16);
        k.cyl(kind === 0 ? KM.paintBlue : KM.plastic, 0.012, 0.02, [x, 0.075, 0], [0, 0, 0], 12);
      }
    }
  });
}

/** Wall-mounted HMI: arm and touchscreen facing +Z. Returns nothing; screen uses KM.screen. */
export function hmi(k: Kit, pos: V3, yaw = 0) {
  k.at(pos, yaw, () => {
    k.cyl(KM.anodizedDark, 0.018, 0.22, [0, 0, -0.11], [Math.PI / 2, 0, 0], 12);
    k.rbox(KM.plastic, [0.34, 0.24, 0.035], 0.008, [0, 0, 0.02]);
    k.box(KM.screen, [0.3, 0.19, 0.002], [0, 0.004, 0.038], [0, 0, 0], { cast: false });
    k.rbox(KM.plastic, [0.36, 0.035, 0.12], 0.006, [0, -0.15, 0.07]);
  });
}

/** Emergency-off button on a yellow collar, facing +Z. */
export function estop(k: Kit, pos: V3) {
  k.at(pos, 0, () => {
    k.rbox(KM.paintYellow, [0.07, 0.07, 0.02], 0.006, [0, 0, 0.01]);
    k.cyl(KM.paintRed, 0.022, 0.025, [0, 0, 0.032], [Math.PI / 2, 0, 0], 20);
  });
}

/** Signal-tower-free status strip (LED bar) facing +Z. */
export function ledStrip(k: Kit, w: number, pos: V3, m: THREE.Material = KM.ledGreen) {
  k.box(KM.seam, [w + 0.01, 0.014, 0.004], pos, [0, 0, 0], { cast: false });
  k.box(m, [w, 0.008, 0.004], [pos[0], pos[1], pos[2] + 0.002], [0, 0, 0], { cast: false });
}

/** Process hose/cable hanging between two points (catenary). */
export function hose(k: Kit, a: V3, b: V3, radius = 0.012, sag = 0.12, m: THREE.Material = KM.rubber) {
  const pts: V3[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t]);
  }
  return k.tube(m, pts, radius, { radial: 8 });
}
