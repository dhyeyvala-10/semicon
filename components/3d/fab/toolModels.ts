/**
 * Procedural, industry-inspired tool exteriors for the fab overview, at a finished
 * hard-surface level: powder-coated enclosures on recessed kick plates, panel seams,
 * louvres, framed windows with the interior behind them, load ports with FOUP docks,
 * FFUs, LED strips, HMIs on arms, EMO buttons, model plates and hazard labels.
 *
 * Cost model (the fab is the landing hero, so it must stay cheap):
 *  - every tool type is built ONCE with the detailing kit in its local frame;
 *  - the finishes of ALL ~66 tools are then merged across the fab, so the whole tool
 *    population costs one draw call per finish (≈20), not one per finish per tool type;
 *  - all labels come from one canvas atlas (one material);
 *  - shadows come from one position-only caster built from a few volumes per tool;
 *  - selection uses one invisible instanced pick box per tool.
 *
 * Local frame: +X faces the bay aisle (front), Z runs along the aisle, origin = front-face
 * centre at floor. Generic, educational equipment — no real products.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { ToolType, ToolInstance } from '@/data/fabLayout';
import { BAYS, LITHO_TRACK_Z, PORT_LX } from '@/data/fabLayout';
import { Kit, type BakedPart, type PartOpts, type V3 } from '../kit/build';
import { KM } from '../kit/finish';
import { casterGeometry } from '../kit/shadow';

type Mat = THREE.Material;

/**
 * Satin variants of the kit metals for the fab: fully metallic finishes mirror the dark
 * cleanroom environment and read black at overview distance; at ~55 % metalness they keep
 * the brushed maps and pick up the FFU light like real bead-blasted stainless.
 */
function satin(m: THREE.MeshStandardMaterial, metalness: number) {
  const c = m.clone();
  c.metalness = metalness;
  return c;
}
export const FM = {
  steel: satin(KM.stainless, 0.55),
  steelDark: satin(KM.stainlessDark, 0.6),
  alu: satin(KM.anodized, 0.5),
  aluDark: satin(KM.anodizedDark, 0.6),
};

/* ================================================================ label atlas */

type LabelKind = 'model' | 'warn' | 'info' | 'gas' | 'tag';
const LABELS: [string, LabelKind, string, string, string?][] = [
  ['litho', 'model', 'LX-900', 'DUV SCANNER · 300 mm'],
  ['track', 'model', 'CT-6', 'COAT / DEVELOP TRACK'],
  ['etch', 'model', 'ET-300', 'PLASMA ETCH CLUSTER'],
  ['dep', 'model', 'DP-300', 'CVD / PVD CLUSTER'],
  ['furnace', 'model', 'VF-2', 'VERTICAL FURNACE · 150 WFR'],
  ['implant', 'model', 'IM-5', 'HIGH-CURRENT IMPLANTER'],
  ['rtp', 'model', 'RT-2', 'RAPID THERMAL PROCESS'],
  ['cmp', 'model', 'CMP-4', 'CHEM-MECH POLISHER'],
  ['metro', 'model', 'MX-1', 'METROLOGY · CD / OVERLAY'],
  ['wet', 'model', 'WB-6', 'WET BENCH · SC1 / SC2 / HF'],
  ['stocker', 'model', 'SK-4', 'FOUP STOCKER · 240 SLOTS'],
  ['efem', 'tag', 'EFEM', 'ISO 1 MINI-ENVIRONMENT'],
  ['lp', 'tag', 'LOAD PORT', 'E15.1 · 300 mm FOUP'],
  ['gasbox', 'tag', 'GAS BOX', 'EXHAUSTED · 0.5 m/s'],
  ['rack', 'tag', 'RF / DC POWER', '480 VAC · 3 PH'],
  ['emo', 'info', 'EMO', 'EMERGENCY OFF'],
  ['wHV', 'warn', 'HIGH VOLTAGE', ''],
  ['wHot', 'warn', 'HOT SURFACE', ''],
  ['wLaser', 'warn', 'LASER', ''],
  ['wChem', 'warn', 'CORROSIVE', ''],
  ['wRF', 'warn', 'RF ENERGY', ''],
  ['wGas', 'warn', 'TOXIC GAS', ''],
  ['wPinch', 'warn', 'MOVING PARTS', ''],
  ['gN2', 'gas', 'N2', '', '#2f5d8a'],
  ['gAr', 'gas', 'Ar', '', '#3e7d4c'],
  ['gCF4', 'gas', 'CF4', '', '#7a5a2a'],
  ['gSiH4', 'gas', 'SiH4', '', '#8a2f2f'],
  ['gPCW', 'gas', 'PCW', '', '#2f6a8a'],
  ['gEXH', 'gas', 'EXH', '', '#4f5559'],
  ['gDIW', 'gas', 'UPW', '', '#2f7a7a'],
  ...BAYS.map((b): [string, LabelKind, string, string] => [`bay:${b.id}`, 'info', b.name, b.light === 'amber' ? 'YELLOW-LIGHT ZONE · ISO 4' : 'ISO 5 · CLASS 100']),
  ['spine', 'info', 'INTERBAY SPINE', 'AMHS · OHT LOOP A'],
];

const CELL_H = 128;
const AW = 2048;
interface Cell {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}
let atlas: { mat: THREE.MeshStandardMaterial; cells: Map<string, Cell> } | null = null;

function fitFont(g: CanvasRenderingContext2D, text: string, weight: string, size: number, family: string, max: number) {
  let s = size;
  g.font = `${weight} ${s}px ${family}`;
  while (s > 8 && g.measureText(text).width > max) {
    s -= 1;
    g.font = `${weight} ${s}px ${family}`;
  }
}

function drawCell(g: CanvasRenderingContext2D, kind: LabelKind, text: string, sub: string, accent: string, W: number, H: number) {
  const mono = '"JetBrains Mono", ui-monospace, monospace';
  const sans = 'Inter, system-ui, sans-serif';
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  if (kind === 'model') {
    g.fillStyle = '#1b1f22';
    g.fillRect(0, 0, W, H);
    g.fillStyle = accent;
    g.fillRect(0, 0, 14, H);
    g.fillStyle = '#e9ece8';
    fitFont(g, text, '600', H * 0.36, sans, W - 50);
    g.fillText(text, 34, H * 0.4);
    g.fillStyle = '#9aa29c';
    fitFont(g, sub, '400', H * 0.17, mono, W - 50);
    g.fillText(sub, 36, H * 0.76);
  } else if (kind === 'warn') {
    g.fillStyle = '#e1b52c';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = '#111';
    g.lineWidth = W * 0.055;
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(W / 2, H * 0.12);
    g.lineTo(W * 0.87, H * 0.75);
    g.lineTo(W * 0.13, H * 0.75);
    g.closePath();
    g.stroke();
    g.fillStyle = '#111';
    g.textAlign = 'center';
    g.font = `900 ${H * 0.34}px ${sans}`;
    g.fillText('!', W / 2, H * 0.5);
    fitFont(g, text, '700', H * 0.12, sans, W - 12);
    g.fillText(text, W / 2, H * 0.88);
  } else if (kind === 'gas') {
    g.fillStyle = accent;
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#ffffff';
    g.font = `700 ${H * 0.5}px ${mono}`;
    g.fillText(text, 26, H / 2);
    g.beginPath();
    g.moveTo(W - 110, H * 0.3);
    g.lineTo(W - 40, H * 0.5);
    g.lineTo(W - 110, H * 0.7);
    g.closePath();
    g.fill();
  } else {
    g.fillStyle = kind === 'tag' ? '#e8e6df' : '#cfd3d0';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = '#555';
    g.lineWidth = 4;
    g.strokeRect(4, 4, W - 8, H - 8);
    g.fillStyle = '#1b1d1f';
    fitFont(g, text, '600', H * 0.3, mono, W - 40);
    g.fillText(text, 22, H * 0.38);
    g.fillStyle = '#555';
    fitFont(g, sub, '400', H * 0.17, mono, W - 40);
    g.fillText(sub, 22, H * 0.74);
  }
}

/** One canvas holds every plate, warning and tag of the fab: one material for all labels. */
function getAtlas() {
  if (atlas) return atlas;
  // pack: plates 512 × 128, warnings 128 × 128, rows of 128 px
  const place: { key: string; x: number; y: number; w: number }[] = [];
  let x = 0;
  let y = 0;
  for (const [key, kind] of LABELS) {
    const w = kind === 'warn' ? CELL_H : CELL_H * 4;
    if (x + w > AW) {
      x = 0;
      y += CELL_H;
    }
    place.push({ key, x, y, w });
    x += w;
  }
  const AH = y + CELL_H;
  const c = document.createElement('canvas');
  c.width = AW;
  c.height = AH;
  const g = c.getContext('2d')!;
  const cells = new Map<string, Cell>();
  LABELS.forEach(([key, kind, text, sub, accent], i) => {
    const p = place[i];
    g.save();
    g.translate(p.x, p.y);
    g.beginPath();
    g.rect(0, 0, p.w, CELL_H);
    g.clip();
    drawCell(g, kind, text, sub, accent ?? '#56745a', p.w, CELL_H);
    g.restore();
    // half-texel inset against bleeding
    cells.set(key, { u0: (p.x + 1) / AW, u1: (p.x + p.w - 1) / AW, v0: 1 - (p.y + CELL_H - 1) / AH, v1: 1 - (p.y + 1) / AH });
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  const mat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.5, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  atlas = { mat, cells };
  return atlas;
}

const planeCache = new Map<string, THREE.BufferGeometry>();
function labelPlane(key: string, w: number, h: number) {
  const ck = `${key}:${w.toFixed(3)}:${h.toFixed(3)}`;
  let g = planeCache.get(ck);
  if (g) return g;
  const cell = getAtlas().cells.get(key);
  g = new THREE.PlaneGeometry(w, h).toNonIndexed();
  const uv = g.getAttribute('uv');
  if (cell)
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, cell.u0 + uv.getX(i) * (cell.u1 - cell.u0), cell.v0 + uv.getY(i) * (cell.v1 - cell.v0));
    }
  planeCache.set(ck, g);
  return g;
}

/** Atlas label (plate facing local +Z of the given frame, rotated by yaw). */
export function atlasLabel(k: Kit, key: string, w: number, h: number, pos: V3, yaw = 0, o: PartOpts = {}) {
  k.add(getAtlas().mat, labelPlane(key, w, h), pos, [0, yaw, 0], [1, 1, 1], { cast: false, keepUV: true, ...o });
}

/* ================================================================ local builder */

type Box6 = [number, number, number, number, number, number];
const FRONT_YAW = Math.PI / 2;

const rbCache = new Map<string, THREE.BufferGeometry>();
/** Low-poly rounded box (one rounding segment: a soft chamfer, 108 triangles). */
export function rbGeo(w: number, h: number, d: number, r: number) {
  const rr = Math.max(1e-4, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
  const key = `${w.toFixed(3)}:${h.toFixed(3)}:${d.toFixed(3)}:${rr.toFixed(4)}`;
  let g = rbCache.get(key);
  if (!g) {
    const rg = new RoundedBoxGeometry(w, h, d, 1, rr);
    rbCache.set(key, (g = rg.index ? rg.toNonIndexed() : rg));
  }
  return g;
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _up = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3();

/** Tool-local helpers on top of the kit (x toward the aisle, z along it). */
class T {
  vols: Box6[] = [];
  constructor(public k: Kit) {}
  /** shadow / pick volume */
  vol(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
    this.vols.push([Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1), Math.min(z0, z1), Math.max(z0, z1)]);
  }
  span(m: Mat, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, o: PartOpts = {}) {
    this.k.box(m, [Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)], [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [0, 0, 0], o);
  }
  rspan(m: Mat, r: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, o: PartOpts = {}) {
    this.k.add(m, rbGeo(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), r), [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [0, 0, 0], [1, 1, 1], o);
  }
  rbox(m: Mat, s: V3, r: number, pos: V3, rot: V3 = [0, 0, 0], o: PartOpts = {}) {
    this.k.add(m, rbGeo(s[0], s[1], s[2], r), pos, rot, [1, 1, 1], o);
  }
  cyl(m: Mat, r: number, h: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'y', seg = 16, o: PartOpts & { top?: number; open?: boolean } = {}) {
    const rot: V3 = axis === 'y' ? [0, 0, 0] : axis === 'x' ? [0, 0, Math.PI / 2] : [Math.PI / 2, 0, 0];
    this.k.cyl(m, r, h, [x, y, z], rot, seg, o);
  }
  /** frame on a front face: kit +Z → tool +X, kit +X → tool −Z */
  front(x: number, y: number, z: number, fn: () => void) {
    this.k.at([x, y, z], FRONT_YAW, fn);
  }
  /** Orthogonal pipe run from straight low-poly segments with fittings at the bends. */
  run(m: Mat, pts: V3[], r: number, o: PartOpts = {}) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      _d.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const len = _d.length();
      if (len < 1e-4) continue;
      _q.setFromUnitVectors(_up, _d.normalize());
      _e.setFromQuaternion(_q);
      this.k.cyl(m, r, len, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], [_e.x, _e.y, _e.z], 8, { cast: false, ...o });
      if (i > 0) this.k.box(FM.steelDark, [r * 2.7, r * 2.7, r * 2.7], a, [0, 0, 0], { cast: false, ...o });
    }
  }
}

/* ------------------------------------------------------------ recipes (tool-local) */

interface Encl {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  h: number;
  y0?: number;
  body?: Mat;
  trim?: Mat;
  plinth?: number;
  /** front panel pitch along z */
  pitch?: number;
  /** heights of horizontal front seams */
  rows?: number[];
  sidePitch?: number;
  stripe?: Mat | false;
  stripeY?: number;
  shell?: boolean;
  cap?: boolean;
  ao?: boolean;
  handles?: boolean;
  r?: number;
  /** window openings in the front face (glazed, framed), with the interior recess behind */
  cuts?: Cut[];
  /** depth of the recess behind the openings */
  cutDepth?: number;
}

interface Cut {
  y0: number;
  y1: number;
  z0: number;
  z1: number;
  glass?: Mat;
  frame?: Mat;
  mullions?: number;
}

/** Parts of [a, b] not covered by the holes. */
function gaps(a: number, b: number, holes: [number, number][]): [number, number][] {
  const hs = holes.filter(([h0, h1]) => h1 > a && h0 < b).sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  let cur = a;
  for (const [h0, h1] of hs) {
    if (h0 > cur) out.push([cur, h0]);
    cur = Math.max(cur, h1);
  }
  if (cur < b) out.push([cur, b]);
  return out;
}

/** Powder-coated enclosure, front face at x1: kick plate, rounded body, cap, seams, stripe, contact shadow. */
function encl(t: T, o: Encl) {
  const { k } = t;
  const y0 = o.y0 ?? 0;
  const pl = o.plinth ?? (y0 > 0 ? 0 : 0.1);
  const body = o.body ?? KM.paint;
  const trim = o.trim ?? KM.paintGraphite;
  const sh: PartOpts = { shell: !!o.shell };
  const nc: PartOpts = { shell: !!o.shell, cast: false };
  const { x0, x1, z0, z1 } = o;
  const top = y0 + o.h;
  if (pl > 0) t.span(trim, x0 + 0.025, x1 - 0.025, y0, y0 + pl, z0 + 0.025, z1 - 0.025, sh);
  const cuts = o.cuts ?? [];
  const M = 0.026;
  if (cuts.length) {
    // rear block + front slab built around the openings, so the interior shows through the glass
    const cd = Math.min(o.cutDepth ?? 0.6, x1 - x0 - 0.05);
    t.rspan(body, o.r ?? 0.022, x0, x1 - cd, y0 + pl, top, z0, z1, sh);
    t.vol(x0, x1 - cd, y0, top, z0, z1);
    const inCut = (y: number, z: number) => cuts.some((c) => y > c.y0 && y < c.y1 && z > c.z0 && z < c.z1);
    const ys = [...new Set([y0 + pl, top, ...cuts.flatMap((c) => [c.y0, c.y1])])].sort((a, b) => a - b);
    const zs = [...new Set([z0, z1, ...cuts.flatMap((c) => [c.z0, c.z1])])].sort((a, b) => a - b);
    for (let i = 0; i < ys.length - 1; i++) {
      let start = -1;
      for (let j = 0; j < zs.length; j++) {
        const solid = j < zs.length - 1 && !inCut((ys[i] + ys[i + 1]) / 2, (zs[j] + zs[j + 1]) / 2);
        if (solid && start < 0) start = j;
        if (!solid && start >= 0) {
          t.span(body, x1 - cd, x1, ys[i], ys[i + 1], zs[start], zs[j], sh);
          t.vol(x1 - cd, x1, ys[i], ys[i + 1], zs[start], zs[j]);
          start = -1;
        }
      }
    }
    for (const c of cuts) win(t, x1, c.y0, c.y1, c.z0, c.z1, { shell: o.shell, glass: c.glass, mullions: c.mullions, frame: c.frame });
  } else t.rspan(body, o.r ?? 0.022, x0, x1, y0 + pl, top, z0, z1, sh);
  const vHoles = (z: number) => cuts.filter((c) => z > c.z0 - M && z < c.z1 + M).map((c): [number, number] => [c.y0 - M, c.y1 + M]);
  const hHoles = (y: number) => cuts.filter((c) => y > c.y0 - M && y < c.y1 + M).map((c): [number, number] => [c.z0 - M, c.z1 + M]);
  if (o.cap !== false) {
    // roof cap in the body colour, overhanging, with a dark shadow line under its edge
    t.span(body, x0 - 0.008, x1 + 0.008, top, top + 0.02, z0 - 0.008, z1 + 0.008, sh);
    t.span(trim, x0 - 0.002, x1 + 0.002, top - 0.006, top, z0 - 0.002, z1 + 0.002, { ...sh, cast: false });
  }
  if (o.stripe !== false) {
    const sy = o.stripeY ?? top - 0.06;
    for (const [a, b] of gaps(z0 + 0.012, z1 - 0.012, hHoles(sy))) t.span(o.stripe ?? KM.paintAccent, x1, x1 + 0.003, sy - 0.008, sy + 0.008, a, b, nc);
  }
  const L = z1 - z0;
  const n = Math.max(1, Math.round(L / (o.pitch ?? 0.9)));
  const yb = y0 + pl + 0.012;
  const yt = top - 0.012;
  for (let i = 1; i < n; i++) {
    const z = z0 + (i * L) / n;
    for (const [a, b] of gaps(yb, yt, vHoles(z))) t.span(KM.seam, x1, x1 + 0.0025, a, b, z - 0.0025, z + 0.0025, nc);
  }
  for (const y of o.rows ?? []) for (const [a, b] of gaps(z0 + 0.012, z1 - 0.012, hHoles(y))) t.span(KM.seam, x1, x1 + 0.0025, y - 0.0025, y + 0.0025, a, b, nc);
  const D = x1 - x0;
  const m = Math.max(1, Math.round(D / (o.sidePitch ?? 0.9)));
  for (const z of [z0 - 0.0012, z1 + 0.0012])
    for (let i = 1; i < m; i++) {
      const x = x0 + (i * D) / m;
      t.span(KM.seam, x - 0.0025, x + 0.0025, yb, yt, z - 0.0012, z + 0.0012, nc);
    }
  if (o.handles)
    for (let i = 0; i < n; i++) {
      const z = z0 + ((i + 1) * L) / n - 0.08;
      const y = Math.min(top - 0.3, y0 + 1.05);
      if (cuts.some((c) => y > c.y0 - 0.1 && y < c.y1 + 0.1 && z > c.z0 - 0.04 && z < c.z1 + 0.04)) continue;
      t.span(KM.seam, x1, x1 + 0.0025, y - 0.085, y + 0.085, z - 0.012, z + 0.012, nc);
      t.span(FM.alu, x1, x1 + 0.014, y - 0.07, y + 0.07, z - 0.006, z + 0.006, nc);
    }
  if (o.ao !== false && y0 === 0) k.ao(D, L, [(x0 + x1) / 2, 0, (z0 + z1) / 2], 1.22);
  if (!cuts.length) t.vol(x0, x1, y0, top, z0, z1);
}

/** Louvred vent on a front face at x. */
function louvre(t: T, x: number, y0: number, y1: number, z0: number, z1: number, body: Mat = KM.paint, o: PartOpts = {}) {
  const nc = { cast: false, ...o };
  t.span(KM.seam, x, x + 0.003, y0, y1, z0, z1, nc);
  const n = Math.max(3, Math.floor((y1 - y0) / 0.045));
  const zc = (z0 + z1) / 2;
  for (let i = 0; i < n; i++) t.k.box(body, [0.012, 0.007, z1 - z0 - 0.012], [x + 0.006, y0 + (i + 0.5) * ((y1 - y0) / n), zc], [0, 0, 0.6], nc);
  t.span(FM.aluDark, x, x + 0.01, y1, y1 + 0.01, z0 - 0.01, z1 + 0.01, nc);
  t.span(FM.aluDark, x, x + 0.01, y0 - 0.01, y0, z0 - 0.01, z1 + 0.01, nc);
  t.span(FM.aluDark, x, x + 0.01, y0, y1, z0 - 0.01, z0, nc);
  t.span(FM.aluDark, x, x + 0.01, y0, y1, z1, z1 + 0.01, nc);
}

/** Framed window on a front face at x (frame proud of the face). */
function win(t: T, x: number, y0: number, y1: number, z0: number, z1: number, o: PartOpts & { glass?: Mat; frame?: Mat; mullions?: number } = {}) {
  const f = o.frame ?? FM.aluDark;
  const fw = 0.022;
  const po: PartOpts = { shell: o.shell, cast: false };
  t.span(f, x, x + 0.024, y1, y1 + fw, z0 - fw, z1 + fw, po);
  t.span(f, x, x + 0.024, y0 - fw, y0, z0 - fw, z1 + fw, po);
  t.span(f, x, x + 0.024, y0, y1, z0 - fw, z0, po);
  t.span(f, x, x + 0.024, y0, y1, z1, z1 + fw, po);
  const n = o.mullions ?? 0;
  for (let i = 1; i <= n; i++) {
    const z = z0 + ((z1 - z0) * i) / (n + 1);
    t.span(f, x, x + 0.02, y0, y1, z - 0.008, z + 0.008, po);
  }
  t.span(o.glass ?? KM.glassSmoke, x + 0.006, x + 0.012, y0, y1, z0, z1, po);
}

/** Flush touchscreen in a graphite bezel on a front face. */
function screenPanel(t: T, x: number, y0: number, y1: number, z0: number, z1: number, o: PartOpts = {}) {
  const po = { cast: false, ...o };
  t.span(KM.paintGraphite, x, x + 0.02, y0 - 0.02, y1 + 0.02, z0 - 0.02, z1 + 0.02, po);
  t.span(KM.screen, x + 0.02, x + 0.023, y0, y1, z0, z1, po);
}

/** Touchscreen HMI facing +x at (x, y, z): housing, screen, keyboard shelf (arm is built by the caller). */
function hmiLite(t: T, x: number, y: number, z: number, o: PartOpts = {}) {
  const nc = { cast: false, ...o };
  t.rspan(KM.plastic, 0.008, x - 0.035, x, y - 0.12, y + 0.12, z - 0.17, z + 0.17, o);
  t.span(KM.screen, x, x + 0.003, y - 0.095, y + 0.1, z - 0.15, z + 0.15, nc);
  t.span(KM.plastic, x - 0.02, x + 0.1, y - 0.165, y - 0.14, z - 0.18, z + 0.18, nc);
  t.span(FM.aluDark, x - 0.24, x - 0.035, y - 0.012, y + 0.012, z - 0.012, z + 0.012, nc);
}

/** LED status strip on a front face. */
function led(t: T, x: number, y: number, z0: number, z1: number, m: Mat = KM.ledGreen, o: PartOpts = {}) {
  const po = { cast: false, ...o };
  t.span(KM.seam, x, x + 0.004, y - 0.008, y + 0.008, z0 - 0.006, z1 + 0.006, po);
  t.span(m, x + 0.004, x + 0.006, y - 0.004, y + 0.004, z0, z1, po);
}

/** EMO: red mushroom button on a yellow collar, with its tag. */
function emo(t: T, x: number, y: number, z: number, o: PartOpts = {}) {
  const po = { cast: false, ...o };
  t.rspan(KM.paintYellow, 0.006, x, x + 0.02, y - 0.035, y + 0.035, z - 0.035, z + 0.035, po);
  t.cyl(KM.paintRed, 0.022, 0.025, x + 0.032, y, z, 'x', 16, po);
  t.front(x + 0.021, y + 0.06, z, () => atlasLabel(t.k, 'emo', 0.1, 0.025, [0, 0, 0], 0, o));
}

/** Label plate on a front face at x (key from the atlas). */
function plate(t: T, key: string, x: number, y: number, z: number, w: number, o: PartOpts = {}) {
  const warn = key.startsWith('w');
  t.front(x + 0.002, y, z, () => atlasLabel(t.k, key, w, warn ? w : w / 4, [0, 0, 0], 0, o));
}

/** Static parts of the signal tower around the simulation-driven lamp. */
function tower(t: T, p: V3) {
  const [x, y, z] = p;
  const nc: PartOpts = { cast: false };
  t.cyl(KM.paintGraphite, 0.055, 0.02, x, y + 0.01, z, 'y', 12, nc);
  t.cyl(FM.steel, 0.018, 0.03, x, y + 0.035, z, 'y', 8, nc);
  for (const yy of [y + 0.145, y + 0.255]) t.cyl(KM.paintGraphite, 0.048, 0.007, x, yy, z, 'y', 16, { ...nc, open: true });
  t.cyl(KM.paintGraphite, 0.048, 0.02, x, y + 0.37, z, 'y', 12, nc);
}

/** Load port with FOUP dock (stage at PORT height), centred on z. */
function loadPort(t: T, z: number) {
  const nc: PartOpts = { cast: false };
  // frame plate on the EFEM face, FIMS opening and door
  t.span(KM.paint, -0.01, 0.035, 0.1, 1.48, z - 0.255, z + 0.255);
  t.span(KM.seam, 0.035, 0.0375, 0.93, 1.35, z - 0.19, z + 0.19, nc);
  t.span(KM.paintGrey, 0.035, 0.046, 0.95, 1.33, z - 0.172, z + 0.172, nc);
  t.span(KM.seam, 0.046, 0.0475, 1.12, 1.16, z - 0.14, z + 0.14, nc);
  // kinematic stage (FOUP dock) with three pins and a presence sensor
  t.span(FM.alu, 0.035, 0.53, 0.868, 0.9, z - 0.205, z + 0.205);
  t.span(FM.aluDark, 0.035, 0.53, 0.866, 0.87, z - 0.207, z + 0.207, nc);
  for (const [px, pz] of [[PORT_LX - 0.1, 0], [PORT_LX + 0.06, -0.1], [PORT_LX + 0.06, 0.1]] as const) t.span(KM.chrome, px - 0.007, px + 0.007, 0.9, 0.912, z + pz - 0.007, z + pz + 0.007, nc);
  t.span(KM.paintGraphite, PORT_LX + 0.02, PORT_LX + 0.06, 0.9, 0.908, z - 0.17, z - 0.13, nc);
  // pedestal, kick plate, indicator panel
  t.rspan(KM.paint, 0.012, 0.05, 0.47, 0.1, 0.868, z - 0.19, z + 0.19);
  t.span(KM.paintGraphite, 0.07, 0.45, 0, 0.1, z - 0.17, z + 0.17, nc);
  t.span(KM.seam, 0.47, 0.4725, 0.5, 0.505, z - 0.17, z + 0.17, nc);
  t.span(KM.paintGraphite, 0.47, 0.476, 0.7, 0.82, z - 0.13, z + 0.13, nc);
  t.span(KM.ledGreen, 0.476, 0.479, 0.785, 0.795, z - 0.11, z - 0.06, nc);
  t.span(KM.ledAmber, 0.476, 0.479, 0.785, 0.795, z - 0.04, z + 0.01, nc);
  t.span(KM.plasticWhite, 0.476, 0.484, 0.722, 0.748, z + 0.037, z + 0.063, nc);
  t.span(KM.paintBlue, 0.476, 0.484, 0.722, 0.748, z + 0.082, z + 0.108, nc);
  plate(t, 'lp', 0.47, 0.6, z, 0.2);
  t.k.ao(0.42, 0.4, [0.26, 0, z], 1.3);
  t.vol(0.05, 0.47, 0, 0.9, z - 0.19, z + 0.19);
}

/** Equipment front-end module: enclosure, FFU, window with robot, load ports, LED, plate, HMI. */
function efem(t: T, zc: number, w: number, ports: number[], o: { h?: number; dep?: number; hmiSide?: 1 | -1 | 0; plateKey?: string } = {}) {
  const h = o.h ?? 2.05;
  const dep = o.dep ?? 0.85;
  const z0 = zc - w / 2;
  const z1 = zc + w / 2;
  const sh: PartOpts = { shell: true };
  encl(t, { x0: -dep, x1: 0, z0, z1, h, pitch: 0.62, rows: [1.45], stripe: false, shell: true, ao: false, cuts: [{ y0: 1.53, y1: 1.93, z0: z0 + 0.12, z1: z1 - 0.12, glass: KM.glass }], cutDepth: dep - 0.1 });
  // FFU on the roof: housing, filter grille, plate
  t.rspan(KM.paint, 0.012, -dep + 0.03, -0.03, h + 0.02, h + 0.25, z0 + 0.04, z1 - 0.04, sh);
  louvre(t, -0.03, h + 0.07, h + 0.2, zc - w / 2 + 0.08, zc + w * 0.12, KM.paint, sh);
  plate(t, o.plateKey ?? 'efem', -0.03, h + 0.135, zc + w * 0.32, 0.36, sh);
  t.vol(-dep + 0.03, -0.03, h, h + 0.25, z0 + 0.04, z1 - 0.04);
  // mini-environment behind the inspection window: stainless liner, wafer-handling robot
  t.span(FM.steel, -0.75, -0.745, 1.5, 1.96, z0 + 0.1, z1 - 0.1, { cast: false });
  t.cyl(FM.alu, 0.11, 0.75, -0.42, 1.27, zc, 'y', 10, { open: true });
  t.cyl(FM.aluDark, 0.115, 0.04, -0.42, 1.64, zc, 'y', 10, { cast: false });
  t.k.box(FM.alu, [0.12, 0.06, 0.42], [-0.42, 1.69, zc + 0.12]);
  t.k.box(FM.aluDark, [0.1, 0.05, 0.3], [-0.36, 1.745, zc + 0.3]);
  t.span(KM.ptfe, -0.31, -0.18, 1.773, 1.78, zc + 0.36, zc + 0.46, { cast: false });
  // status LED strip and seams between port bays
  led(t, 0, 1.49, z0 + 0.15, z1 - 0.15, KM.ledGreen, sh);
  for (const p of ports) loadPort(t, p);
  // HMI on a swing arm at one end
  if (o.hmiSide) {
    const s = o.hmiSide;
    const ze = s > 0 ? z1 : z0;
    t.span(FM.aluDark, -0.22, -0.1, 1.39, 1.51, ze - s * 0.002, ze + s * 0.05);
    t.run(FM.aluDark, [[-0.16, 1.45, ze + s * 0.05], [-0.16, 1.45, ze + s * 0.24], [-0.02, 1.45, ze + s * 0.24], [-0.02, 1.55, ze + s * 0.24]], 0.018);
    hmiLite(t, 0.2, 1.55, ze + s * 0.24);
    emo(t, 0, 1.72, ze - s * 0.06, sh);
  }
}

/* ================================================================ tool types */

function buildLitho(t: T, L: number, depth: number, ports: number[]) {
  const sh: PartOpts = { shell: true };
  const zs0 = -L / 2;
  const zs1 = LITHO_TRACK_Z - 1.6;
  // scanner main body (set back from the aisle)
  encl(t, { x0: -depth, x1: -0.9, z0: zs0, z1: zs1, h: 2.75, pitch: 1.15, rows: [0.98, 2.3], shell: true, handles: true, stripeY: 2.5, cuts: [{ y0: 1.3, y1: 2.18, z0: zs0 + 0.55, z1: zs0 + 2.75, mullions: 1, glass: KM.glass }], cutDepth: 1.0 });
  louvre(t, -0.9, 0.24, 0.84, zs0 + 0.18, zs0 + 0.98, KM.paint, sh);
  louvre(t, -0.9, 0.24, 0.84, zs0 + 1.33, zs0 + 2.13, KM.paint, sh);
  louvre(t, -0.9, 0.24, 0.84, zs0 + 2.48, zs0 + 3.28, KM.paint, sh);
  // wafer-stage window with the stage module inside
  t.span(KM.paintGrey, -1.75, -1.15, 1.0, 1.38, zs0 + 0.7, zs0 + 2.6);
  t.rbox(FM.alu, [0.5, 0.12, 0.6], 0.02, [-1.42, 1.44, zs0 + 1.3]);
  t.rbox(FM.alu, [0.5, 0.12, 0.6], 0.02, [-1.42, 1.44, zs0 + 2.1]);
  t.cyl(FM.steel, 0.12, 0.6, -1.5, 1.95, zs0 + 1.7, 'y', 16);
  screenPanel(t, -0.9, 1.45, 1.75, zs1 - 1.1, zs1 - 0.55, sh);
  emo(t, -0.9, 1.25, zs1 - 0.35, sh);
  plate(t, 'litho', -0.9, 2.42, zs0 + 3.6, 0.6, sh);
  plate(t, 'wLaser', -0.9, 1.9, zs0 + 3.2, 0.11, sh);
  plate(t, 'wHV', -0.9, 1.9, zs0 + 3.38, 0.11, sh);
  led(t, -0.9, 2.62, zs0 + 0.2, zs1 - 0.2, KM.ledWhite, sh);
  // roof utilities, exhaust duct to the ceiling, illuminator housing
  encl(t, { x0: -depth + 0.1, x1: -1.05, z0: zs0 + 0.3, z1: zs1 - 0.3, h: 0.3, y0: 2.77, body: KM.paintGrey, stripe: false, pitch: 1.2, cap: false, shell: true });
  t.rspan(FM.steel, 0.02, -depth + 0.4, -1.4, 3.07, 3.27, zs0 + 0.8, zs0 + 2.2);
  t.cyl(FM.steel, 0.22, 1.75, -depth + 0.6, 4.14, zs0 + 1.5, 'y', 20);
  t.cyl(FM.steelDark, 0.25, 0.04, -depth + 0.6, 3.6, zs0 + 1.5, 'y', 20);
  t.cyl(FM.steelDark, 0.25, 0.04, -depth + 0.6, 4.95, zs0 + 1.5, 'y', 20);
  t.rspan(KM.paint, 0.02, -depth + 0.15, -2.4, 3.07, 3.5, zs1 - 2.6, zs1 - 0.5, sh);
  louvre(t, -2.4, 3.15, 3.42, zs1 - 2.4, zs1 - 0.7, KM.paint, sh);
  t.vol(-depth + 0.15, -2.4, 3.07, 3.5, zs1 - 2.6, zs1 - 0.5);
  // track (coat / develop) at the loading end
  const zt0 = LITHO_TRACK_Z - 1.4;
  const zt1 = L / 2;
  encl(t, {
    x0: -depth + 0.4,
    x1: -0.85,
    z0: zt0,
    z1: zt1,
    h: 2.2,
    pitch: 0.9,
    rows: [0.95],
    shell: true,
    stripeY: 2.08,
    cuts: [
      { y0: 1.05, y1: 1.88, z0: zt0 + 0.12, z1: LITHO_TRACK_Z - 1.02, glass: KM.glass },
      { y0: 1.05, y1: 1.88, z0: LITHO_TRACK_Z + 1.02, z1: zt1 - 0.15, glass: KM.glass },
    ],
    cutDepth: 0.95,
  });
  // coater cups and hot-plate stack inside the track
  for (const z of [zt0 + 0.33, zt1 - 0.4]) {
    t.cyl(KM.plasticWhite, 0.17, 0.16, -1.25, 1.1, z, 'y', 18);
    t.cyl(KM.seam, 0.14, 0.01, -1.25, 1.185, z, 'y', 18, { cast: false });
  }
  for (let i = 0; i < 4; i++) t.rspan(FM.steelDark, 0.01, -1.7, -1.05, 1.3 + i * 0.14, 1.4 + i * 0.14, zt1 - 0.9, zt1 - 0.62);
  plate(t, 'track', -0.85, 0.78, zt1 - 0.55, 0.44, sh);
  plate(t, 'wChem', -0.85, 0.6, zt0 + 0.25, 0.1, sh);
  louvre(t, -0.85, 0.22, 0.8, zt0 + 0.12, zt0 + 0.5, KM.paint, sh);
  // scanner ↔ track interface tunnel
  t.rspan(FM.steel, 0.015, -3.0, -1.2, 0.95, 1.4, zs1 - 0.1, zt0 + 0.1);
  efem(t, LITHO_TRACK_Z, 1.95, ports, { hmiSide: 1 });
  // chemical cabinet at the far end
  t.k.at([-depth + 0.95, 0, zt1 + 0.001], 0, () => {
    t.span(KM.seam, -0.4, 0.4, 0.15, 1.15, 0, 0.002, { cast: false, shell: true });
    t.span(KM.paintWarm, -0.38, 0.38, 0.17, 1.13, 0.002, 0.012, { cast: false, shell: true });
    t.span(FM.alu, 0.3, 0.32, 0.55, 0.75, 0.012, 0.03, { cast: false });
  });
}

/** Process chamber around a cluster transfer chamber, local frame: +x points away from the TM. */
function chamber(t: T, kind: 'etch' | 'dep') {
  const { k } = t;
  const nc: PartOpts = { cast: false };
  // slit valve block toward the TM
  k.box(FM.steel, [0.22, 0.32, 0.46], [-0.52, 1.05, 0]);
  k.box(FM.aluDark, [0.08, 0.22, 0.3], [-0.44, 1.05, 0], [0, 0, 0], nc);
  // chamber body with flanges
  k.cyl(FM.steel, 0.46, 0.62, [0, 1.05, 0], [0, 0, 0], 18, { open: true });
  k.cyl(FM.steelDark, 0.5, 0.035, [0, 0.755, 0], [0, 0, 0], 18);
  k.cyl(FM.alu, 0.5, 0.08, [0, 1.4, 0], [0, 0, 0], 18);
  // side viewport
  k.cyl(FM.steel, 0.07, 0.08, [0.48, 1.08, 0], [0, 0, Math.PI / 2], 8, nc);
  k.cyl(KM.glassSmoke, 0.05, 0.01, [0.525, 1.08, 0], [0, 0, Math.PI / 2], 8, nc);
  if (kind === 'etch') {
    // RF match box with cooling grille and coax feed
    k.add(KM.paint, rbGeo(0.45, 0.4, 0.45, 0.02), [0, 1.65, 0]);
    k.box(KM.seam, [0.3, 0.12, 0.003], [0, 1.65, 0.227], [0, 0, 0], nc);
    k.cyl(KM.paintGraphite, 0.035, 0.22, [0, 1.95, 0], [0, 0, 0], 8);
    k.cyl(KM.rubber, 0.025, 0.7, [-0.1, 2.06, 0], [0, 0, Math.PI / 2], 6, nc);
  } else {
    // showerhead lid with gas box and feed lines
    k.add(KM.paintWarm, rbGeo(0.38, 0.28, 0.38, 0.02), [0, 1.58, 0]);
    k.cyl(FM.steel, 0.03, 0.42, [0.12, 1.92, 0.08], [0, 0, 0], 6);
    k.cyl(FM.steel, 0.03, 0.42, [0.12, 1.92, -0.08], [0, 0, 0], 6);
    k.cyl(KM.paintBlue, 0.04, 0.05, [0.12, 1.86, 0.08], [0, 0, 0], 8, nc);
  }
  // pumping stack: gate valve, turbo pump, foreline
  k.box(FM.steel, [0.32, 0.12, 0.32], [0, 0.68, 0]);
  k.cyl(FM.alu, 0.15, 0.3, [0, 0.47, 0], [0, 0, 0], 12);
  k.cyl(FM.steel, 0.04, 0.32, [0, 0.16, 0], [0, 0, 0], 6, nc);
  // frame legs
  for (const [x, z] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]] as const) k.box(KM.paintGraphite, [0.04, 0.74, 0.04], [x, 0.37, z]);
}

function buildCluster(t: T, L: number, depth: number, ports: number[], kind: 'etch' | 'dep') {
  const sh: PartOpts = { shell: true };
  const w = Math.min(L - 0.2, ports.length * 0.62 + 0.6);
  efem(t, 0, w, ports, { hmiSide: 1, plateKey: kind });
  // load locks
  for (const z of [-0.3, 0.3]) {
    t.rspan(FM.steel, 0.02, -1.36, -0.86, 0.75, 1.25, z - 0.25, z + 0.25);
    t.span(FM.aluDark, -1.33, -0.89, 1.25, 1.29, z - 0.22, z + 0.22);
    t.cyl(KM.glassSmoke, 0.07, 0.01, -1.11, 1.295, z, 'y', 12, { cast: false });
  }
  // mainframe pedestal and hex transfer chamber
  encl(t, { x0: -2.95, x1: -0.86, z0: -0.72, z1: 0.72, h: 0.75, pitch: 0.72, stripe: false, cap: false, sidePitch: 0.7, ao: false });
  const cx = -2.15;
  t.cyl(FM.steel, 0.78, 0.5, cx, 1.05, 0, 'y', 6);
  t.cyl(FM.alu, 0.8, 0.06, cx, 1.33, 0, 'y', 6);
  t.cyl(FM.steelDark, 0.22, 0.05, cx, 1.385, 0, 'y', 16, { cast: false });
  t.cyl(KM.glassSmoke, 0.16, 0.01, cx, 1.415, 0, 'y', 16, { cast: false });
  // process chambers
  const angles = [Math.PI * 0.5, Math.PI * 0.85, Math.PI * 1.15, Math.PI * 1.5];
  for (const a of angles) {
    const r = 1.25;
    const x = cx + Math.cos(a) * r;
    const z = Math.sin(a) * r * 0.95;
    if (x < -depth + 0.4) continue;
    t.k.at([x, 0, z], -Math.atan2(z, x - cx), () => chamber(t, kind));
    t.vol(x - 0.5, x + 0.5, 0, 1.86, z - 0.5, z + 0.5);
  }
  // gas cabinet (exhausted) at the back corner, with duct to the ceiling
  const gz0 = -L / 2;
  const gz1 = -L / 2 + 0.68;
  encl(t, { x0: -depth, x1: -depth + 0.75, z0: gz0, z1: gz1, h: 2.2, body: kind === 'etch' ? KM.paintGrey : KM.paintWarm, pitch: 0.7, stripe: KM.paintYellow, shell: true, cuts: [{ y0: 1.0, y1: 1.85, z0: gz0 + 0.12, z1: gz1 - 0.12, glass: KM.glass }], cutDepth: 0.45 });
  for (const y of [1.2, 1.45, 1.7]) t.span(FM.steel, -depth + 0.25, -depth + 0.3, y, y + 0.025, gz0 + 0.15, gz1 - 0.15);
  plate(t, 'gasbox', -depth + 0.75, 0.82, (gz0 + gz1) / 2, 0.3, sh);
  plate(t, 'wGas', -depth + 0.75, 0.55, (gz0 + gz1) / 2, 0.1, sh);
  t.cyl(FM.steel, 0.11, 2.8, -depth + 0.35, 3.62, gz0 + 0.34, 'y', 14);
  // gas lines from the cabinet to the chambers
  const gl: V3[] = [[-depth + 0.4, 2.22, gz0 + 0.5], [-depth + 0.4, 2.12, gz0 + 0.5], [-3.2, 2.12, gz0 + 0.5], [-3.2, 2.12, 0.55], [-2.6, 2.12, 0.55]];
  t.run(FM.steel, gl, 0.012);
  t.run(FM.steel, gl.map(([x, y, z]) => [x + 0.05, y - 0.04, z] as V3), 0.012);
  // RF / power rack at the other back corner
  const rz0 = L / 2 - 0.68;
  const rz1 = L / 2;
  encl(t, { x0: -depth, x1: -depth + 0.75, z0: rz0, z1: rz1, h: 2.0, body: KM.paintGrey, pitch: 0.7, rows: [1.0], stripe: false, shell: true });
  louvre(t, -depth + 0.75, 0.25, 0.85, rz0 + 0.1, rz1 - 0.1, KM.paintGrey, sh);
  led(t, -depth + 0.75, 1.85, rz0 + 0.1, rz1 - 0.1, KM.ledAmber, sh);
  plate(t, 'rack', -depth + 0.75, 1.62, (rz0 + rz1) / 2, 0.3, sh);
  plate(t, kind === 'etch' ? 'wRF' : 'wHV', -depth + 0.75, 1.32, (rz0 + rz1) / 2, 0.1, sh);
  // low chamber power supplies along the back, cable tray over the chambers
  encl(t, { x0: -depth, x1: -depth + 0.24, z0: gz1 + 0.02, z1: rz0 - 0.02, h: 1.25, body: KM.paintGrey, pitch: 0.6, stripe: false, cap: false, ao: false });
  t.span(FM.alu, -depth + 0.1, -0.95, 2.36, 2.38, -0.12, 0.12, { cast: false });
  for (const s of [-1, 1]) t.span(FM.alu, -depth + 0.1, -0.95, 2.38, 2.42, s * 0.12 - 0.004, s * 0.12 + 0.004, { cast: false });
  t.span(KM.paintGraphite, -depth + 0.1, -0.95, 2.385, 2.41, -0.08, 0.08, { cast: false });
  t.span(FM.steelDark, -depth + 0.1, -depth + 0.13, 2.05, 2.36, -0.02, 0.02, { cast: false });
  t.k.ao(depth, L, [-depth / 2, 0, 0], 1.08);
}

function buildFurnace(t: T, L: number, depth: number, ports: number[]) {
  const sh: PartOpts = { shell: true };
  const z0 = -L / 2 + 0.1;
  const z1 = L / 2 - 0.1;
  encl(t, { x0: -depth, x1: 0, z0, z1, h: 3.6, pitch: 0.8, rows: [1.0, 2.5], shell: true, stripeY: 3.4, cuts: [{ y0: 1.12, y1: 2.4, z0: -0.62, z1: 0.62, mullions: 1, glass: KM.glass }], cutDepth: 1.2 });
  // boat elevator behind the window: quartz boat with wafers on its pedestal, lift screw
  t.cyl(KM.ptfe, 0.23, 0.05, -0.65, 1.2, 0, 'y', 18);
  t.cyl(FM.steel, 0.2, 0.04, -0.65, 1.245, 0, 'y', 18, { cast: false });
  for (let i = 0; i < 14; i++) t.cyl(FM.steelDark, 0.15, 0.004, -0.65, 1.3 + i * 0.065, 0, 'y', 16, { cast: false });
  for (const a of [0.6, 2.5, 4.4]) t.cyl(KM.glass, 0.012, 0.95, -0.65 + Math.cos(a) * 0.16, 1.73, Math.sin(a) * 0.16, 'y', 6, { cast: false });
  t.cyl(KM.chrome, 0.025, 1.25, -1.05, 1.75, 0.42, 'y', 8);
  t.span(FM.alu, -1.12, -0.98, 1.6, 1.7, 0.3, 0.5);
  // upper front: louvre, HMI screen, plate, warnings, LED
  louvre(t, 0, 2.62, 3.22, -0.55, 0.3, KM.paint, sh);
  screenPanel(t, 0, 2.62, 2.92, z1 - 0.62, z1 - 0.18, sh);
  plate(t, 'furnace', 0, 3.1, z1 - 0.4, 0.4, sh);
  plate(t, 'wHot', 0, 2.2, z1 - 0.3, 0.1, sh);
  led(t, 0, 2.48, -0.6, 0.6, KM.ledGreen, sh);
  emo(t, 0, 1.25, z1 - 0.22, sh);
  for (const p of ports) loadPort(t, p);
  // heater housing and scavenger exhaust to the ceiling
  encl(t, { x0: -depth + 0.2, x1: -1.2, z0: -L / 2 + 0.3, z1: L / 2 - 0.3, h: 0.35, y0: 3.62, body: KM.paintGrey, stripe: false, pitch: 0.7, cap: false, shell: true });
  t.cyl(FM.steel, 0.18, 1.0, -depth + 0.7, 4.5, 0, 'y', 16);
  t.cyl(FM.steelDark, 0.21, 0.04, -depth + 0.7, 4.02, 0, 'y', 16);
  t.rspan(FM.steel, 0.01, -depth + 0.55, -depth + 0.85, 4.25, 4.4, -0.12, 0.12);
  // cooling-water supply / return with tags on the side
  for (const [dx, m] of [[0.1, KM.paintBlue], [-0.1, KM.paintRed]] as const) {
    t.run(KM.copper, [[-2.6 + dx, 2.7, z1], [-2.6 + dx, 2.7, z1 + 0.06], [-2.6 + dx, 3.78, z1 + 0.06], [-2.6 + dx, 3.78, z1 - 0.3]], 0.018);
    t.cyl(m, 0.024, 0.06, -2.6 + dx, 3.1, z1 + 0.06, 'y', 10, { cast: false });
  }
  t.k.at([-2.6, 2.55, z1 + 0.002], 0, () => atlasLabel(t.k, 'gPCW', 0.24, 0.06, [0, 0, 0], 0, sh));
  t.k.at([-0.9, 0, z1 + 0.001], -Math.PI / 2, () => louvre(t, 0, 0.25, 0.85, -0.4, 0.4, KM.paint, sh));
  t.k.at([-0.9, 0, z0 - 0.001], Math.PI / 2, () => louvre(t, 0, 0.25, 0.85, -0.4, 0.4, KM.paint, sh));
}

function buildImplant(t: T, L: number, depth: number, ports: number[]) {
  const sh: PartOpts = { shell: true };
  const nc: PartOpts = { shell: true, cast: false };
  efem(t, 0, 1.95, ports, { hmiSide: -1 });
  const z0 = -L / 2 + 0.2;
  const z1 = L / 2 - 0.1;
  // end station + beamline enclosure
  encl(t, { x0: -depth, x1: -0.85, z0, z1: z1 - 2.0, h: 2.05, pitch: 1.0, rows: [0.9], shell: true, handles: true, stripeY: 1.98, cuts: [{ y0: 1.12, y1: 1.78, z0: z0 + 0.3, z1: -1.1, glass: KM.glass }], cutDepth: 1.45 });
  louvre(t, -0.85, 0.3, 0.8, z0 + 0.15, z0 + 0.9, KM.paint, sh);
  louvre(t, -0.85, 0.3, 0.8, z0 + 1.1, z0 + 1.85, KM.paint, sh);
  // beamline window: flight tube and analyser magnet behind glass
  t.cyl(FM.steel, 0.09, 1.9, -1.6, 1.42, z0 + 1.6, 'z', 16);
  t.rspan(KM.paintBlue, 0.03, -2.0, -1.2, 1.15, 1.7, z0 + 0.7, z0 + 1.2);
  t.rspan(KM.copper, 0.02, -1.95, -1.25, 1.2, 1.65, z0 + 0.6, z0 + 0.7);
  plate(t, 'implant', -0.85, 1.9, z0 + 0.9, 0.5, sh);
  // high-voltage terminal enclosure (taller), mesh window, hazard band
  const tz0 = z1 - 2.0;
  encl(t, { x0: -depth, x1: -1.0, z0: tz0, z1, h: 2.5, body: KM.paintGrey, pitch: 1.0, shell: true, stripe: KM.paintYellow, stripeY: 2.42 });
  t.span(KM.seam, -1.0, -0.997, 0.6, 2.2, tz0 + 0.2, z1 - 0.2, nc);
  for (let i = 0; i <= 12; i++) t.span(FM.aluDark, -1.0, -0.99, 0.6, 2.2, tz0 + 0.2 + (i * 1.6) / 12 - 0.004, tz0 + 0.2 + (i * 1.6) / 12 + 0.004, nc);
  for (let i = 0; i <= 10; i++) t.span(FM.aluDark, -1.0, -0.99, 0.6 + i * 0.16 - 0.004, 0.6 + i * 0.16 + 0.004, tz0 + 0.2, z1 - 0.2, nc);
  for (let i = 0; i < 12; i++) t.span(i % 2 ? KM.paintGraphite : KM.paintYellow, -0.999, -0.996, 0.12, 0.2, tz0 + 0.05 + (i * 1.9) / 12, tz0 + 0.05 + ((i + 1) * 1.9) / 12, nc);
  plate(t, 'wHV', -0.99, 2.3, tz0 + 0.5, 0.12, sh);
  plate(t, 'wHV', -0.99, 2.3, z1 - 0.5, 0.12, sh);
  // source gas cabinet with exhaust duct
  encl(t, { x0: -depth, x1: -depth + 0.8, z0: z0 - 0.1, z1: z0 + 0.7, y0: 2.07, h: 0.4, body: KM.paintGrey, stripe: false, cap: false, shell: true });
  t.cyl(FM.steel, 0.12, 2.5, -depth + 0.4, 3.72, z0 + 0.3, 'y', 14);
  plate(t, 'wGas', -depth + 0.8, 2.26, z0 + 0.3, 0.1, sh);
  t.k.ao(depth, L, [-depth / 2, 0, 0], 1.08);
}

function buildRTP(t: T, L: number, depth: number, ports: number[]) {
  const sh: PartOpts = { shell: true };
  efem(t, 0, 1.95, ports, { hmiSide: -1, plateKey: 'rtp' });
  // handler between the EFEM and the chambers
  t.rspan(FM.steel, 0.02, -1.2, -0.86, 0.82, 1.28, -0.95, 0.95);
  for (const z of [-0.65, 0.65]) {
    // chamber body, lamp-head housing with cooling grille, water lines
    t.rspan(FM.steel, 0.03, -2.15, -1.15, 0.78, 1.22, z - 0.4, z + 0.4);
    t.span(FM.steelDark, -2.1, -1.2, 1.22, 1.24, z - 0.36, z + 0.36);
    t.rspan(KM.paint, 0.025, -2.1, -1.2, 1.24, 1.72, z - 0.35, z + 0.35);
    t.span(KM.seam, -2.1, -1.2, 1.72, 1.725, z - 0.3, z + 0.3, { cast: false });
    for (let i = 0; i < 6; i++) t.span(FM.aluDark, -2.0 + i * 0.13, -1.95 + i * 0.13, 1.725, 1.76, z - 0.28, z + 0.28, { cast: false });
    t.cyl(KM.copper, 0.018, 0.4, -1.4, 1.5, z + 0.36, 'x', 8, { cast: false });
    t.cyl(KM.paintBlue, 0.022, 0.05, -1.25, 1.5, z + 0.36, 'x', 10, { cast: false });
    t.cyl(KM.paintRed, 0.022, 0.05, -1.25, 1.42, z + 0.36, 'x', 10, { cast: false });
    t.cyl(KM.copper, 0.018, 0.4, -1.4, 1.42, z + 0.36, 'x', 8, { cast: false });
    t.cyl(KM.paintGraphite, 0.05, 0.3, -1.65, 1.9, z, 'y', 10);
    // support frame and pump
    for (const [dx, dz] of [[-0.45, -0.32], [0.45, -0.32], [-0.45, 0.32], [0.45, 0.32]] as const) t.span(KM.paintGraphite, -1.65 + dx - 0.02, -1.65 + dx + 0.02, 0, 0.78, z + dz - 0.02, z + dz + 0.02);
    t.cyl(FM.alu, 0.13, 0.32, -1.65, 0.4, z, 'y', 14);
    t.vol(-2.15, -1.15, 0, 1.76, z - 0.4, z + 0.4);
  }
  plate(t, 'wHot', -1.15, 1.48, 0, 0.1);
  // power and control cabinet at the back
  encl(t, { x0: -depth, x1: -2.2, z0: -L / 2 + 0.1, z1: L / 2 - 0.1, h: 1.9, body: KM.paintGrey, pitch: 0.7, rows: [0.95], shell: true, stripe: KM.paintAccent });
  louvre(t, -2.2, 0.25, 0.8, -L / 2 + 0.25, -L / 2 + 0.9, KM.paintGrey, sh);
  louvre(t, -2.2, 0.25, 0.8, L / 2 - 0.9, L / 2 - 0.25, KM.paintGrey, sh);
  led(t, -2.2, 1.7, -0.5, 0.5, KM.ledAmber, sh);
  plate(t, 'wHV', -2.2, 1.35, -L / 2 + 0.4, 0.1, sh);
  t.k.ao(depth, L, [-depth / 2, 0, 0], 1.08);
}

function buildCMP(t: T, L: number, depth: number, ports: number[]) {
  const sh: PartOpts = { shell: true };
  efem(t, 0, 1.95, ports, { hmiSide: 1 });
  const z0 = -L / 2 + 0.1;
  const z1 = L / 2 - 0.1;
  // polisher enclosure with windows onto the platens, heads and slurry arms
  encl(t, {
    x0: -depth,
    x1: -0.85,
    z0,
    z1,
    h: 2.25,
    pitch: 0.95,
    rows: [0.88],
    shell: true,
    stripeY: 2.12,
    handles: true,
    cuts: [
      { y0: 0.98, y1: 1.92, z0: z0 + 0.18, z1: -1.05, glass: KM.glass },
      { y0: 0.98, y1: 1.92, z0: 1.05, z1: z1 - 0.18, glass: KM.glass },
    ],
    cutDepth: 1.5,
  });
  for (const s of [-1, 1]) {
    const z = s * 1.2;
    t.span(KM.paintGrey, -2.3, -0.95, 0.6, 0.86, z - 0.62, z + 0.62);
    t.span(KM.seam, -2.3, -0.95, 0.86, 0.862, z - 0.6, z + 0.6, { cast: false });
    t.cyl(FM.steel, 0.45, 0.06, -1.6, 0.89, z, 'y', 28);
    t.cyl(KM.paintGraphite, 0.44, 0.012, -1.6, 0.926, z, 'y', 28, { cast: false });
    // carrier head on its spindle arm
    t.cyl(FM.alu, 0.17, 0.09, -1.65, 1.0, z + s * 0.12, 'y', 18);
    t.cyl(KM.chrome, 0.035, 0.45, -1.65, 1.27, z + s * 0.12, 'y', 10);
    t.rspan(KM.paint, 0.02, -2.25, -1.55, 1.46, 1.58, z + s * 0.12 - 0.08, z + s * 0.12 + 0.08);
    t.rspan(KM.paint, 0.03, -2.4, -2.1, 0.86, 1.62, z + s * 0.12 - 0.15, z + s * 0.12 + 0.15);
    // slurry arm and conditioner
    t.span(KM.ptfe, -1.55, -1.1, 0.98, 1.0, z - s * 0.32, z - s * 0.3);
    t.cyl(FM.steelDark, 0.06, 0.06, -1.3, 0.97, z - s * 0.12, 'y', 12);
  }
  plate(t, 'cmp', -0.85, 2.0, -L / 2 + 0.75, 0.5, sh);
  plate(t, 'wPinch', -0.85, 1.7, L / 2 - 0.35, 0.1, sh);
  // roof utilities, exhaust duct and slurry supply cabinet
  encl(t, { x0: -depth, x1: -depth + 0.6, z0: z0 + 0.2, z1: z1 - 0.2, y0: 2.27, h: 0.3, body: KM.paintGrey, stripe: false, cap: false, shell: true });
  t.cyl(FM.steel, 0.15, 2.4, -depth + 0.3, 3.8, 0.9, 'y', 14);
  t.run(KM.ptfe, [[-depth + 0.3, 2.57, -1.3], [-depth + 0.3, 2.75, -1.3], [-depth + 0.3, 2.75, -2.4]], 0.02);
  t.k.ao(depth, L, [-depth / 2, 0, 0], 1.08);
}

function buildMetro(t: T, L: number, depth: number, ports: number[]) {
  const sh: PartOpts = { shell: true };
  efem(t, 0, 1.95, ports, { hmiSide: 0 });
  // isolation base with vibration isolators
  t.span(KM.paintGraphite, -depth + 0.1, -0.86, 0.0, 0.3, -L / 2 + 0.25, L / 2 - 0.25);
  for (const x of [-depth + 0.25, -1.05]) for (const z of [-L / 2 + 0.4, L / 2 - 0.4]) t.cyl(KM.rubber, 0.08, 0.07, x, 0.335, z, 'y', 12);
  // measurement enclosure on the base
  encl(t, { x0: -depth + 0.15, x1: -0.86, z0: -L / 2 + 0.2, z1: L / 2 - 0.2, y0: 0.37, h: 1.53, pitch: 0.65, rows: [1.15], shell: true, stripeY: 1.78 });
  for (const s of [-1, 1]) t.k.at([-1.85, 0, s * (L / 2 - 0.2) + s * 0.001], s > 0 ? -Math.PI / 2 : Math.PI / 2, () => win(t, 0, 1.0, 1.65, -0.6, 0.6, { shell: true }));
  louvre(t, -0.86, 0.5, 1.05, 1.03, L / 2 - 0.28, KM.paint, sh);
  louvre(t, -0.86, 0.5, 1.05, -L / 2 + 0.28, -1.03, KM.paint, sh);
  t.span(KM.paintGrey, -2.2, -1.1, 0.95, 1.2, -1.2, 1.2);
  t.cyl(FM.alu, 0.12, 0.35, -1.6, 1.38, 0.0, 'y', 16);
  t.k.at([-1.6, 1.45, L / 2 - 0.2 + 0.002], 0, () => atlasLabel(t.k, 'metro', 0.44, 0.11, [0, 0, 0], 0, sh));
  led(t, -0.86, 1.86, -L / 2 + 0.3, L / 2 - 0.3, KM.ledWhite, sh);
  // optical column on top
  t.rspan(KM.paint, 0.02, -2.3, -1.3, 1.92, 2.08, -0.4, 0.4, sh);
  t.cyl(FM.alu, 0.2, 0.4, -1.8, 2.28, 0, 'y', 20);
  t.cyl(FM.steelDark, 0.23, 0.04, -1.8, 2.1, 0, 'y', 20, { cast: false });
  t.cyl(KM.paintGraphite, 0.12, 0.1, -1.8, 2.53, 0, 'y', 16);
  t.vol(-2.3, -1.3, 1.9, 2.58, -0.4, 0.4);
  t.k.ao(depth, L, [-depth / 2, 0, 0], 1.12);
}

function buildWet(t: T, L: number, depth: number, ports: number[]) {
  const sh: PartOpts = { shell: true };
  const nc: PartOpts = { shell: true, cast: false };
  const z0 = -L / 2 + 0.1;
  const z1 = L / 2 - 0.1;
  // sash windows (above the load ports in the middle), tanks and the wet robot gantry behind them
  const g0 = -L / 2 + 1.4;
  const g1 = L / 2 - 0.3;
  const sash = { glass: KM.glass, frame: FM.steel };
  encl(t, {
    x0: -depth,
    x1: 0,
    z0,
    z1,
    h: 2.3,
    pitch: 1.0,
    rows: [0.95],
    shell: true,
    stripeY: 2.18,
    cuts: [
      { y0: 1.0, y1: 2.04, z0: g0, z1: -1.25, ...sash },
      { y0: 1.56, y1: 2.04, z0: -1.25 + 0.05, z1: 1.25 - 0.05, mullions: 1, ...sash },
      { y0: 1.0, y1: 2.04, z0: 1.25, z1: g1, mullions: 1, ...sash },
    ],
    cutDepth: 1.7,
  });
  t.span(KM.paintGrey, -1.6, -0.15, 0.6, 0.98, g0, g1);
  for (let i = 0; i < 5; i++) {
    const zc = g0 + ((i + 0.5) * (g1 - g0)) / 5;
    t.rspan(i % 2 ? KM.ptfe : KM.plasticWhite, 0.015, -1.1, -0.3, 0.98, 1.3, zc - 0.36, zc + 0.36);
    t.span(i === 2 ? KM.glassSmoke : KM.seam, -1.05, -0.35, 1.302, 1.305, zc - 0.32, zc + 0.32, { cast: false });
  }
  t.span(FM.alu, -1.45, -1.35, 1.88, 1.96, g0, g1);
  t.rspan(FM.aluDark, 0.01, -1.5, -0.9, 1.6, 1.95, g0 + 1.8, g0 + 2.1);
  t.span(FM.steel, -1.25, -1.21, 1.3, 1.6, g0 + 1.92, g0 + 1.98);
  // lower chemical cabinet doors: handles, warning
  for (let i = 0; i < 5; i++) {
    const z = g0 + ((i + 0.85) * (g1 - g0)) / 5;
    t.span(FM.alu, 0, 0.014, 0.5, 0.66, z - 0.006, z + 0.006, nc);
  }
  plate(t, 'wChem', 0, 0.75, g0 + 0.25, 0.11, sh);
  plate(t, 'wet', 0, 1.72, z0 + 0.55, 0.5, sh);
  // controls at the left end
  screenPanel(t, 0, 1.2, 1.48, z0 + 0.92, z0 + 1.22, sh);
  emo(t, 0, 1.12, z0 + 0.25, sh);
  louvre(t, 0, 0.25, 0.8, z0 + 0.15, z0 + 1.05, KM.paint, sh);
  led(t, 0, 2.08, g0, g1, KM.ledGreen, sh);
  for (const p of ports) loadPort(t, p);
  // exhaust plenum and duct
  encl(t, { x0: -depth + 0.2, x1: -0.4, z0: z0 + 0.2, z1: z1 - 0.2, y0: 2.32, h: 0.36, body: KM.paintGrey, stripe: false, cap: false, shell: true });
  t.cyl(KM.ptfe, 0.2, 2.3, -depth + 0.6, 3.83, -L / 2 + 0.8, 'y', 16);
  t.cyl(FM.steelDark, 0.22, 0.05, -depth + 0.6, 2.72, -L / 2 + 0.8, 'y', 16, { cast: false });
  t.k.at([-depth + 0.6, 3.1, -L / 2 + 0.8 + 0.205], 0, () => atlasLabel(t.k, 'gEXH', 0.2, 0.05, [0, 0, 0], 0));
  t.cyl(KM.ptfe, 0.06, 2.3, -depth + 0.25, 3.83, L / 2 - 0.6, 'y', 10);
  t.k.at([-depth + 0.25, 3.0, L / 2 - 0.6 + 0.065], 0, () => atlasLabel(t.k, 'gDIW', 0.16, 0.04, [0, 0, 0], 0));
}

function buildStocker(t: T, L: number, depth: number, ports: number[]) {
  const sh: PartOpts = { shell: true };
  encl(t, { x0: -depth, x1: 0, z0: -L / 2, z1: L / 2, h: 4.6, pitch: 1.2, rows: [1.5], shell: true, stripe: KM.paintYellow, stripeY: 4.35, sidePitch: 1.0, cuts: [{ y0: 1.56, y1: 4.18, z0: -L / 2 + 0.4, z1: L / 2 - 0.4, glass: KM.glass, mullions: 3 }], cutDepth: 2.5 });
  // shelves with stored FOUPs (static), crane mast between the racks
  const pattern = [1, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1];
  for (let r = 0; r < 5; r++) {
    const y = 1.62 + r * 0.5;
    t.span(FM.steelDark, -0.85, -0.12, y, y + 0.025, -L / 2 + 0.3, L / 2 - 0.3);
    t.span(FM.steelDark, -2.48, -1.85, y, y + 0.025, -L / 2 + 0.3, L / 2 - 0.3);
    for (let i = 0; i < 8; i++) {
      const z = -L / 2 + 0.65 + i * ((L - 1.3) / 7);
      if (pattern[(r * 5 + i * 3) % pattern.length]) {
        t.rspan(KM.plasticWhite, 0.03, -0.66, -0.3, y + 0.03, y + 0.36, z - 0.19, z + 0.19);
        t.span(KM.paintGraphite, -0.55, -0.4, y + 0.36, y + 0.4, z - 0.1, z + 0.1, { cast: false });
        t.span(KM.paintGrey, -0.3, -0.292, y + 0.09, y + 0.31, z - 0.15, z + 0.15, { cast: false });
      }
      if (pattern[(r * 7 + i * 5 + 3) % pattern.length]) {
        t.rspan(KM.plasticWhite, 0.03, -2.35, -1.99, y + 0.03, y + 0.36, z - 0.19, z + 0.19);
        t.span(KM.paintGraphite, -2.25, -2.1, y + 0.36, y + 0.4, z - 0.1, z + 0.1, { cast: false });
        t.span(KM.paintGrey, -1.998, -1.99, y + 0.09, y + 0.31, z - 0.15, z + 0.15, { cast: false });
      }
    }
  }
  t.span(FM.alu, -1.6, -1.4, 0.05, 4.3, -0.12, 0.12);
  t.span(FM.alu, -1.7, -1.3, 4.3, 4.4, -L / 2 + 0.3, L / 2 - 0.3);
  t.span(FM.alu, -1.7, -1.3, 0.0, 0.08, -L / 2 + 0.3, L / 2 - 0.3);
  t.rspan(KM.paintYellow, 0.02, -1.85, -1.15, 2.0, 2.2, -0.35, 0.35);
  plate(t, 'stocker', 0.02, 4.48, -L / 2 + 0.75, 0.55, sh);
  screenPanel(t, 0, 1.25, 1.55, L / 2 - 0.35, L / 2 - 0.12, sh);
  emo(t, 0, 1.05, L / 2 - 0.22, sh);
  for (const p of ports) loadPort(t, p);
  // FFUs on the roof
  for (let i = 0; i < 4; i++) t.rspan(KM.paint, 0.02, -depth + 0.2, -0.2, 4.62, 4.78, -L / 2 + 0.3 + i * 1.4, -L / 2 + 1.5 + i * 1.4);
}

/* ================================================================ public API */

interface ToolModel {
  parts: BakedPart[];
  caster: THREE.BufferGeometry;
  bounds: THREE.Box3;
}

const _box = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();

/** Local offsets (along the aisle) of a tool's load ports, from its world port positions. */
function portOffsets(t: ToolInstance) {
  const c = Math.cos(t.rot);
  const s = Math.sin(t.rot);
  return t.ports.map((p) => s * (p.x - t.x) + c * (p.z - t.z));
}

function buildTool(tool: ToolInstance): ToolModel {
  const k = new Kit();
  const t = new T(k);
  const { type, length: L, depth } = tool;
  const ports = portOffsets(tool);
  switch (type) {
    case 'litho':
      buildLitho(t, L, depth, ports);
      break;
    case 'etch':
      buildCluster(t, L, depth, ports, 'etch');
      break;
    case 'dep':
      buildCluster(t, L, depth, ports, 'dep');
      break;
    case 'furnace':
      buildFurnace(t, L, depth, ports);
      break;
    case 'implant':
      buildImplant(t, L, depth, ports);
      break;
    case 'rtp':
      buildRTP(t, L, depth, ports);
      break;
    case 'cmp':
      buildCMP(t, L, depth, ports);
      break;
    case 'metro':
      buildMetro(t, L, depth, ports);
      break;
    case 'wet':
      buildWet(t, L, depth, ports);
      break;
    case 'stocker':
      buildStocker(t, L, depth, ports);
      break;
  }
  tower(t, towerPos(type, L, depth));
  const bounds = new THREE.Box3();
  const casters: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  for (const [x0, x1, y0, y1, z0, z1] of t.vols) {
    bounds.expandByPoint(new THREE.Vector3(x0, y0, z0)).expandByPoint(new THREE.Vector3(x1, y1, z1));
    m.compose(new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), new THREE.Quaternion(), new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0));
    casters.push(_box.clone().applyMatrix4(m));
  }
  const caster = mergeGeometries(casters, false)!;
  casters.forEach((g) => g.dispose());
  return { parts: k.build(), caster, bounds };
}

export interface FabToolsModel {
  /** visible meshes: one per finish for the whole fab (shell parts kept apart for x-ray) */
  parts: BakedPart[];
  /** position-only shadow caster (simple volumes of every tool) */
  caster: THREE.BufferGeometry | null;
  /** local bounds of each tool (same order as the input), for pick proxies */
  bounds: THREE.Box3[];
}

/** Build every tool of the fab and merge each finish across all of them. */
export function buildFabTools(tools: ToolInstance[]): FabToolsModel {
  const models = new Map<string, ToolModel>();
  const bins = new Map<string, { material: Mat; shell: boolean; geos: THREE.BufferGeometry[] }>();
  const casters: THREE.BufferGeometry[] = [];
  const bounds: THREE.Box3[] = [];
  const m = new THREE.Matrix4();
  for (const tool of tools) {
    const key = `${tool.type}:${tool.length.toFixed(2)}:${tool.depth.toFixed(2)}`;
    let model = models.get(key);
    if (!model) models.set(key, (model = buildTool(tool)));
    m.makeRotationY(tool.rot).setPosition(tool.x, 0, tool.z);
    for (const p of model.parts) {
      const bk = `${p.material.uuid}:${p.shell ? 1 : 0}`;
      let b = bins.get(bk);
      if (!b) bins.set(bk, (b = { material: p.material, shell: p.shell, geos: [] }));
      b.geos.push(p.geometry.clone().applyMatrix4(m));
    }
    casters.push(model.caster.clone().applyMatrix4(m));
    bounds.push(model.bounds);
  }
  const parts: BakedPart[] = [];
  for (const b of bins.values()) {
    const g = mergeGeometries(b.geos, false);
    b.geos.forEach((x) => x.dispose());
    if (!g) continue;
    g.computeBoundingSphere();
    parts.push({ material: b.material, geometry: g, shell: b.shell, cast: false });
  }
  const caster = casterGeometry(casters, 0);
  casters.forEach((g) => g.dispose());
  for (const md of models.values()) {
    md.parts.forEach((p) => p.geometry.dispose());
    md.caster.dispose();
  }
  return { parts, caster, bounds };
}

/** Where the signal tower sits on each tool type (local coords). */
export function towerPos(type: ToolType, length: number, depth: number): [number, number, number] {
  void depth;
  switch (type) {
    case 'litho':
      return [-1.0, 2.75, -length / 2 + 0.3];
    case 'furnace':
      return [-0.2, 3.6, length / 2 - 0.25];
    case 'stocker':
      return [-0.2, 4.6, length / 2 - 0.3];
    case 'wet':
      return [-0.2, 2.3, length / 2 - 0.25];
    default:
      return [-0.15, 2.3, length / 2 - 0.35 > 0.9 ? 0.9 : length / 2 - 0.35];
  }
}

export { PORT_LX };
