/**
 * Procedural, industry-inspired tool exteriors for the fab overview. Each tool type is
 * built once from primitives, merged per material and drawn with instancing, so
 * ~70 detailed tools cost only a few dozen draw calls.
 * Local frame: +X faces the bay aisle (front), Z runs along the aisle, origin = front-face centre at floor.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ToolType } from '@/data/fabLayout';
import { LITHO_TRACK_Z, PORT_LX } from '@/data/fabLayout';
import { M } from '../materials';
import { louvre } from '../textures';

type MatKey = 'panel' | 'panelWarm' | 'panelGrey' | 'dark' | 'steel' | 'glass' | 'screen' | 'accentBlue' | 'accentOrange' | 'accentGreen' | 'louvre' | 'black' | 'quartz' | 'yellow';

const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 24, 1);
const unitHex = new THREE.CylinderGeometry(1, 1, 1, 6, 1);

class Builder {
  parts = new Map<MatKey, THREE.BufferGeometry[]>();
  add(mat: MatKey, geo: THREE.BufferGeometry, m: THREE.Matrix4) {
    const g = geo.clone().applyMatrix4(m);
    const arr = this.parts.get(mat) ?? [];
    arr.push(g);
    this.parts.set(mat, arr);
  }
  box(mat: MatKey, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(w, h, d));
    this.add(mat, unitBox, m);
  }
  /** box spanning [x0,x1]×[y0,y1]×[z0,z1] */
  span(mat: MatKey, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
    this.box(mat, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  }
  cyl(mat: MatKey, r: number, h: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'y', hex = false) {
    const rot = axis === 'y' ? new THREE.Euler() : axis === 'x' ? new THREE.Euler(0, 0, Math.PI / 2) : new THREE.Euler(Math.PI / 2, 0, 0);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(rot), new THREE.Vector3(r, h, r));
    this.add(mat, hex ? unitHex : unitCyl, m);
  }
  result(): Map<MatKey, THREE.BufferGeometry> {
    const out = new Map<MatKey, THREE.BufferGeometry>();
    for (const [k, arr] of this.parts) {
      const merged = mergeGeometries(arr, false);
      if (merged) out.set(k, merged);
    }
    return out;
  }
}

/** Load ports + EFEM front common to most tools. */
function efem(b: Builder, length: number, ports: number, zOffset = 0, width = 0, height = 2.1, depth = 0.85) {
  const w = width || Math.min(length - 0.2, Math.max(1.5, ports * 0.62 + 0.4));
  b.span('panel', -depth, 0, 0.0, height, zOffset - w / 2, zOffset + w / 2);
  b.span('dark', -depth - 0.02, 0.02, 0, 0.12, zOffset - w / 2, zOffset + w / 2); // plinth
  b.span('steel', -depth, 0, height, height + 0.25, zOffset - w / 2 + 0.05, zOffset + w / 2 - 0.05); // EFEM FFU
  b.span('glass', 0.005, 0.02, 1.25, 1.95, zOffset - w / 2 + 0.1, zOffset + w / 2 - 0.1); // EFEM window
  const pl = Math.min(length - 0.6, ports * 0.62);
  for (let p = 0; p < ports; p++) {
    const off = ports === 1 ? 0 : -pl / 2 + (pl / (ports - 1)) * p;
    const z = zOffset + off;
    b.span('panelGrey', 0, 0.5, 0, 0.88, z - 0.24, z + 0.24); // load-port body
    b.span('steel', 0.0, 0.48, 0.88, 0.9, z - 0.22, z + 0.22); // docking plate
    b.span('dark', 0.0, 0.03, 0.92, 1.3, z - 0.2, z + 0.2); // FIMS door
    b.span('screen', 0.5, 0.505, 0.6, 0.7, z - 0.08, z + 0.08); // status panel
  }
}

function signalAndScreen(b: Builder, x: number, y: number, z: number) {
  b.span('screen', x, x + 0.02, y, y + 0.32, z - 0.22, z + 0.22);
  b.span('dark', x - 0.02, x, y - 0.02, y + 0.34, z - 0.24, z + 0.24);
}

function buildLitho(b: Builder, length: number, depth: number) {
  const L = length;
  // scanner main body (away from track end)
  const zs0 = -L / 2;
  const zs1 = LITHO_TRACK_Z - 1.6;
  b.span('panel', -depth, -0.9, 0.12, 2.75, zs0, zs1);
  b.span('dark', -depth - 0.02, -0.88, 0, 0.12, zs0, zs1);
  b.span('panelGrey', -depth + 0.1, -1.0, 2.75, 3.05, zs0 + 0.3, zs1 - 0.3); // roof utilities
  b.span('steel', -depth + 0.4, -1.4, 3.05, 3.25, zs0 + 0.8, zs0 + 2.2); // exhaust duct
  b.cyl('steel', 0.22, 1.6, -depth + 0.6, 3.6, zs0 + 1.5);
  // front face detailing of scanner: service doors, window, louvres
  for (let i = 0; i < 4; i++) b.span('louvre', -0.9, -0.885, 0.3, 1.0, zs0 + 0.3 + i * 1.25, zs0 + 1.25 + i * 1.25);
  b.span('glass', -0.9, -0.885, 1.3, 2.3, zs0 + 0.6, zs0 + 2.6);
  b.span('accentBlue', -0.902, -0.89, 2.45, 2.55, zs0, zs1);
  signalAndScreen(b, -0.89, 1.35, zs1 - 0.8);
  // track (coat/develop) at loading end
  const zt0 = LITHO_TRACK_Z - 1.4;
  const zt1 = L / 2;
  b.span('panel', -depth + 0.4, -0.85, 0.12, 2.2, zt0, zt1);
  b.span('dark', -depth + 0.38, -0.83, 0, 0.12, zt0, zt1);
  b.span('glass', -0.85, -0.835, 1.0, 1.9, zt0 + 0.2, zt1 - 0.2);
  b.span('accentOrange', -0.852, -0.84, 2.0, 2.08, zt0, zt1);
  efem(b, 3, 2, LITHO_TRACK_Z, 1.6, 2.0, 0.85);
  // chemical cabinet under the track
  b.span('panelGrey', -depth + 0.4, -depth + 1.2, 0.12, 1.2, zt0 + 0.2, zt1 - 0.2);
}

function buildCluster(b: Builder, length: number, depth: number, kind: 'etch' | 'dep') {
  efem(b, length, 3, 0, 0, 2.05, 0.85);
  // load locks
  b.span('steel', -1.35, -0.85, 0.75, 1.25, -0.55, -0.05);
  b.span('steel', -1.35, -0.85, 0.75, 1.25, 0.05, 0.55);
  // transfer chamber (hex)
  const cx = -2.15;
  b.cyl('steel', 0.78, 0.5, cx, 1.05, 0, 'y', true);
  b.cyl('panelGrey', 0.8, 0.06, cx, 1.33, 0, 'y', true);
  b.cyl('dark', 0.55, 0.7, cx, 0.45, 0, 'y', true);
  // process chambers
  const angles = [Math.PI * 0.5, Math.PI * 0.85, Math.PI * 1.15, Math.PI * 1.5];
  for (const a of angles) {
    const r = 1.25;
    const x = cx + Math.cos(a) * r;
    const z = Math.sin(a) * r * 0.95;
    if (x < -depth + 0.4) continue;
    b.cyl('steel', 0.46, 0.62, x, 1.05, z);
    b.cyl('panelGrey', 0.5, 0.08, x, 1.4, z);
    if (kind === 'etch') {
      b.box('panel', 0.45, 0.42, 0.45, x, 1.68, z); // RF match box
      b.cyl('accentBlue', 0.06, 0.2, x, 1.98, z);
    } else {
      b.box('panelWarm', 0.35, 0.3, 0.35, x, 1.6, z); // showerhead lid / gas box
      b.cyl('steel', 0.04, 0.5, x + 0.2, 1.7, z, 'y');
    }
    b.cyl('dark', 0.3, 0.75, x, 0.4, z); // pedestal / pump below
  }
  // gas cabinet & electronics rack at the back
  b.span(kind === 'etch' ? 'panelGrey' : 'panelWarm', -depth, -depth + 0.7, 0.0, 2.1, -length / 2 + 0.25, -length / 2 + 1.2);
  b.span('panelGrey', -depth, -depth + 0.7, 0.0, 1.9, length / 2 - 1.1, length / 2 - 0.25);
  b.span('louvre', -depth + 0.7, -depth + 0.71, 0.3, 1.6, length / 2 - 1.0, length / 2 - 0.35);
  b.span(kind === 'etch' ? 'accentBlue' : 'accentGreen', -0.86, -0.85, 2.05, 2.11, -length / 2 + 0.3, length / 2 - 0.3);
}

function buildFurnace(b: Builder, length: number, depth: number) {
  b.span('panel', -depth, -0.0, 0.12, 3.6, -length / 2 + 0.1, length / 2 - 0.1);
  b.span('dark', -depth, 0.02, 0, 0.12, -length / 2 + 0.1, length / 2 - 0.1);
  b.span('glass', 0.0, 0.015, 1.1, 2.4, -0.6, 0.6);
  b.span('panelGrey', -depth + 0.2, -1.2, 3.6, 3.95, -length / 2 + 0.3, length / 2 - 0.3);
  b.cyl('steel', 0.18, 0.8, -depth + 0.7, 4.3, 0);
  b.span('accentOrange', 0.0, 0.012, 3.35, 3.45, -length / 2 + 0.1, length / 2 - 0.1);
  for (let p = 0; p < 2; p++) {
    const z = -0.62 + p * 1.24;
    b.span('panelGrey', 0, 0.5, 0, 0.88, z - 0.24, z + 0.24);
    b.span('steel', 0, 0.48, 0.88, 0.9, z - 0.22, z + 0.22);
  }
  signalAndScreen(b, 0.0, 2.6, length / 2 - 0.5);
}

function buildImplant(b: Builder, length: number, depth: number) {
  efem(b, 2.2, 2, 0, 1.7, 2.0, 0.85);
  b.span('panel', -depth, -0.85, 0.12, 2.05, -length / 2 + 0.2, length / 2 - 0.1);
  b.span('dark', -depth, -0.85, 0, 0.12, -length / 2 + 0.2, length / 2 - 0.1);
  // high-voltage terminal enclosure (taller) with mesh window
  b.span('panelGrey', -depth, -1.0, 0.12, 2.5, length / 2 - 2.0, length / 2 - 0.1);
  b.span('black', -1.0, -0.985, 0.6, 2.2, length / 2 - 1.8, length / 2 - 0.3);
  b.span('accentOrange', -0.86, -0.85, 1.95, 2.02, -length / 2 + 0.2, length / 2 - 0.1);
  for (let i = 0; i < 2; i++) b.span('louvre', -0.85, -0.84, 0.3, 1.2, -length / 2 + 0.4 + i * 0.95, -length / 2 + 1.2 + i * 0.95);
  signalAndScreen(b, -0.84, 1.35, -length / 2 + 2.3);
}

function buildRTP(b: Builder, length: number, depth: number) {
  efem(b, length, 2, 0, 0, 2.0, 0.85);
  for (const z of [-0.65, 0.65]) {
    b.box('steel', 1.0, 0.45, 0.8, -1.65, 1.0, z);
    b.box('panel', 0.9, 0.5, 0.7, -1.65, 1.48, z); // lamp head housing
    b.cyl('accentOrange', 0.05, 0.3, -1.65, 1.8, z);
  }
  b.span('panelGrey', -depth, -2.2, 0, 1.9, -length / 2 + 0.1, length / 2 - 0.1);
}

function buildCMP(b: Builder, length: number, depth: number) {
  efem(b, length, 2, 0, 1.6, 2.0, 0.85);
  b.span('panel', -depth, -0.85, 0.12, 2.25, -length / 2 + 0.1, length / 2 - 0.1);
  b.span('dark', -depth, -0.85, 0, 0.12, -length / 2 + 0.1, length / 2 - 0.1);
  b.span('glass', -0.86, -0.845, 0.95, 1.95, -length / 2 + 0.25, -0.9);
  b.span('glass', -0.86, -0.845, 0.95, 1.95, 0.9, length / 2 - 0.25);
  b.span('accentGreen', -0.86, -0.85, 2.1, 2.16, -length / 2 + 0.1, length / 2 - 0.1);
  // visible platens through the glass
  b.cyl('steel', 0.45, 0.06, -1.6, 0.9, -1.2);
  b.cyl('steel', 0.45, 0.06, -1.6, 0.9, 1.2);
  b.span('panelGrey', -depth, -depth + 0.6, 2.25, 2.55, -length / 2 + 0.3, length / 2 - 0.3);
}

function buildMetro(b: Builder, length: number, depth: number) {
  efem(b, length, 2, 0, 1.6, 1.95, 0.85);
  b.span('panel', -depth + 0.15, -0.85, 0.35, 1.9, -length / 2 + 0.2, length / 2 - 0.2);
  b.span('dark', -depth + 0.1, -0.8, 0.0, 0.35, -length / 2 + 0.25, length / 2 - 0.25); // isolation base
  b.span('steel', -depth + 0.6, -1.4, 1.9, 2.2, -0.3, 0.3); // column top
  b.span('accentBlue', -0.86, -0.85, 1.75, 1.8, -length / 2 + 0.2, length / 2 - 0.2);
}

function buildWet(b: Builder, length: number, depth: number) {
  b.span('panel', -depth, 0, 0.12, 2.3, -length / 2 + 0.1, length / 2 - 0.1);
  b.span('dark', -depth, 0.02, 0, 0.12, -length / 2 + 0.1, length / 2 - 0.1);
  b.span('glass', 0.0, 0.015, 1.0, 2.0, -length / 2 + 1.4, length / 2 - 0.3);
  for (let i = 0; i < 5; i++) b.span('steel', -0.012, 0.0, 1.0, 2.0, -length / 2 + 1.4 + i * 0.95, -length / 2 + 1.42 + i * 0.95);
  b.span('panelGrey', -depth + 0.2, -0.4, 2.3, 2.7, -length / 2 + 0.3, length / 2 - 0.3); // exhaust plenum
  b.cyl('panelGrey', 0.2, 1.4, -depth + 0.6, 3.4, -length / 2 + 0.8);
  b.span('accentBlue', 0.0, 0.012, 2.1, 2.18, -length / 2 + 0.1, length / 2 - 0.1);
  const pl = 3 * 0.62;
  for (let p = 0; p < 3; p++) {
    const z = -pl / 2 + (pl / 2) * p;
    b.span('panelGrey', 0, 0.5, 0, 0.88, z - 0.24, z + 0.24);
    b.span('steel', 0, 0.48, 0.88, 0.9, z - 0.22, z + 0.22);
  }
}

function buildStocker(b: Builder, length: number, depth: number) {
  b.span('panel', -depth, 0, 0, 4.6, -length / 2, length / 2);
  b.span('glass', 0, 0.015, 0.9, 4.2, -length / 2 + 0.4, length / 2 - 0.4);
  for (let r = 0; r < 6; r++) b.span('steel', -depth + 0.2, -0.1, 0.95 + r * 0.55, 0.98 + r * 0.55, -length / 2 + 0.3, length / 2 - 0.3);
  b.span('yellow', 0.0, 0.015, 4.3, 4.4, -length / 2, length / 2);
  for (const z of [-0.8, 0.8]) {
    b.span('panelGrey', 0, 0.5, 0, 0.88, z - 0.25, z + 0.25);
    b.span('steel', 0, 0.48, 0.88, 0.9, z - 0.22, z + 0.22);
  }
}

export type ToolModel = Map<MatKey, THREE.BufferGeometry>;

const cache = new Map<string, ToolModel>();
export function toolModel(type: ToolType, length: number, depth: number): ToolModel {
  const key = `${type}:${length.toFixed(2)}:${depth.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const b = new Builder();
  switch (type) {
    case 'litho':
      buildLitho(b, length, depth);
      break;
    case 'etch':
      buildCluster(b, length, depth, 'etch');
      break;
    case 'dep':
      buildCluster(b, length, depth, 'dep');
      break;
    case 'furnace':
      buildFurnace(b, length, depth);
      break;
    case 'implant':
      buildImplant(b, length, depth);
      break;
    case 'rtp':
      buildRTP(b, length, depth);
      break;
    case 'cmp':
      buildCMP(b, length, depth);
      break;
    case 'metro':
      buildMetro(b, length, depth);
      break;
    case 'wet':
      buildWet(b, length, depth);
      break;
    case 'stocker':
      buildStocker(b, length, depth);
      break;
  }
  const r = b.result();
  cache.set(key, r);
  return r;
}

let louvreMat: THREE.MeshStandardMaterial | null = null;
export function matFor(k: MatKey): THREE.Material {
  switch (k) {
    case 'panel':
      return M.panel;
    case 'panelWarm':
      return M.panelWarm;
    case 'panelGrey':
      return M.panelGrey;
    case 'dark':
      return M.panelDark;
    case 'steel':
      return M.steel;
    case 'glass':
      return M.glassDark;
    case 'screen':
      return M.screen;
    case 'accentBlue':
      return M.blueAccent;
    case 'accentOrange':
      return M.orangeAccent;
    case 'accentGreen':
      return M.greenAccent;
    case 'black':
      return M.black;
    case 'quartz':
      return M.quartz;
    case 'yellow':
      return M.yellow;
    case 'louvre':
      if (!louvreMat) louvreMat = new THREE.MeshStandardMaterial({ map: louvre(), roughness: 0.6, metalness: 0.1 });
      return louvreMat;
  }
}

/** Where the signal tower sits on each tool type (local coords). */
export function towerPos(type: ToolType, length: number, depth: number): [number, number, number] {
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
