'use client';
/**
 * The chip in a system (§58) — 1 world unit = 1 cm. Generic, educational layouts.
 *   CPU journey: die → package (substrate + lid) → socket on a motherboard → memory, power
 *                delivery, cooler → mounted in a tower computer
 *   GPU journey: die → package with HBM → soldered onto a graphics card → heatsink & fans →
 *                cards installed in a server chassis
 * The exploded view lifts each part apart.
 *
 * Hardware is built with the detailing kit. Static assemblies (board components, tower case,
 * server chassis) are merged per finish; moving parts (package, board, memory modules, coolers,
 * cards, fan rotors) keep their own groups and animation. Selection on merged assemblies goes
 * through invisible pick proxies, and each assembly casts its shadow through one caster.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Lighting } from '../environments';
import { GEO } from '../parts/primitives';
import { Clickable, TechLabel } from '../parts/interaction';
import { dieFloorplan, substrateTexture } from '../textures';
import { Kit, type BakedPart } from '../kit/build';
import { KM } from '../kit/finish';
import { Baked, useKit } from '../kit/Baked';
import { casterGeometry, shadowOnly } from '../kit/shadow';
import { engine } from '@/simulation/engine';
import { pp } from '@/lib/anim';
import { track } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { useParam } from '@/hooks/useTicker';
import { clamp, smooth, lerp, rng } from '@/lib/math';

type V3 = [number, number, number];

const std = (color: string, p: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1, ...p });
/** Kit metals at reduced metalness: fully metallic finishes read black in this dim room. */
function satin(m: THREE.MeshStandardMaterial, metalness: number) {
  const c = m.clone();
  c.metalness = metalness;
  return c;
}
const MAT = {
  pcb: std('#1f4a35', { roughness: 0.55 }),
  pcbDark: std('#18392a', { roughness: 0.6 }),
  gold: std('#d9a944', { roughness: 0.25, metalness: 1 }),
  socket: std('#2a2d2b', { roughness: 0.6 }),
  lever: std('#b9bec4', { roughness: 0.3, metalness: 0.9 }),
  lid: std('#c9cdd0', { roughness: 0.25, metalness: 0.95 }),
  dimm: std('#244a37'),
  chip: std('#1c1d20', { roughness: 0.6 }),
  fin: std('#b9bec4', { roughness: 0.35, metalness: 0.9 }),
  fan: std('#2a2d2b', { roughness: 0.5 }),
  fanBlade: std('#3a3f3c', { roughness: 0.5 }),
  caseMat: std('#3d4540', { roughness: 0.45, metalness: 0.55 }),
  glass: new THREE.MeshPhysicalMaterial({ color: '#9fb4a8', roughness: 0.05, transparent: true, opacity: 0.16, depthWrite: false }),
  cap: std('#3a3f3c', { metalness: 0.6, roughness: 0.4 }),
  shroud: std('#3d4642', { metalness: 0.5, roughness: 0.4 }),
  hbm: std('#3d4642', { metalness: 0.4, roughness: 0.35 }),
  si: std('#4a5560', { metalness: 0.5, roughness: 0.3 }),
  // detailing finishes
  plasticGrey: std('#4b5052', { roughness: 0.55 }),
  white: std('#e4e4de', { roughness: 0.5 }),
  ferrite: std('#45484a', { roughness: 0.55, metalness: 0.35 }),
  ceramic: std('#8c7656', { roughness: 0.6 }),
  nickel: std('#bfc3c6', { roughness: 0.3, metalness: 0.85 }),
  solder: std('#a7abae', { roughness: 0.35, metalness: 0.8 }),
  audioCap: std('#b8902f', { roughness: 0.4, metalness: 0.3 }),
  frit: std('#0d0f10', { roughness: 0.3 }),
  sleeve: std('#1a1c1e', { roughness: 0.75 }),
  seam: KM.seam,
  tray: std('#b4b8b2', { roughness: 0.5, metalness: 0.15 }),
  alu: satin(KM.anodized, 0.6),
  aluDark: satin(KM.anodizedDark, 0.55),
  steel: satin(KM.stainless, 0.65),
  steelDark: satin(KM.stainlessDark, 0.7),
  copper: satin(KM.copper, 0.85),
  brass: satin(KM.brass, 0.8),
};

const O: V3 = [0, 0, 0];
const NC = { cast: false };
/** CPU socket position on the motherboard. */
const SX = -4;
const SZ = -2;
/** world-projected UV density for the kit's micro-surface maps (repeats per cm) */
const CM_UV = 0.3;

const prog = (id: string) => smooth(clamp(pp(id) * 1.2));

function Ex({ lift, children }: { lift: number; children: ReactNode }) {
  const view = useUI((s) => s.view);
  const g = useRef<THREE.Group>(null);
  const e = useRef(0);
  useFrame((_, dt) => {
    e.current += ((view === 'exploded' ? 1 : 0) - e.current) * Math.min(1, dt * 3);
    if (g.current) g.current.position.y = e.current * lift;
  });
  return <group ref={g}>{children}</group>;
}

/** group following a per-frame transform function */
function Anim({ f, children }: { f: (g: THREE.Group) => void; children: ReactNode }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    if (g.current) f(g.current);
  });
  return <group ref={g}>{children}</group>;
}

function Box({ s, p, m, sel }: { s: [number, number, number]; p: [number, number, number]; m: THREE.Material | THREE.Material[]; sel?: { id: string; label: string } }) {
  const mesh = <mesh geometry={GEO.box} material={m} scale={s} position={p} castShadow receiveShadow />;
  return sel ? <Clickable sel={{ kind: 'component', id: sel.id, label: sel.label }}>{mesh}</Clickable> : mesh;
}

/* ================================================================ kit plumbing */

function useCm(fn: (k: Kit) => void, deps: unknown[] = []) {
  return useKit((k) => {
    k.uvScale = CM_UV;
    fn(k);
  }, deps);
}

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

/** Build every piece and merge all of an assembly's parts per finish; each piece gets a pick proxy. */
function buildStation(pieces: Pieces): Station {
  const bins = new Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[] }>();
  const picks: Record<string, THREE.BufferGeometry> = {};
  const cast: THREE.BufferGeometry[] = [];
  for (const [tag, fn] of Object.entries(pieces)) {
    const k = new Kit();
    k.uvScale = CM_UV;
    fn(k);
    const own: THREE.BufferGeometry[] = [];
    for (const p of k.build()) {
      let b = bins.get(p.material.uuid);
      if (!b) bins.set(p.material.uuid, (b = { material: p.material, geos: [] }));
      b.geos.push(p.geometry);
      own.push(p.geometry);
      if (p.cast) cast.push(p.geometry);
    }
    const g = positionsOf(own);
    if (g) picks[tag] = g;
  }
  const caster = casterGeometry(cast);
  const parts: BakedPart[] = [];
  for (const b of bins.values()) {
    const geometry = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
    if (!geometry) continue;
    if (geometry !== b.geos[0]) b.geos.forEach((g) => g.dispose());
    geometry.computeBoundingSphere();
    parts.push({ material: b.material, geometry, shell: false, cast: false });
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

/** Invisible pick proxy for one piece of an assembly. */
function Pick({ m, tag }: { m: Station; tag: string }) {
  const g = m.picks[tag];
  return g ? <mesh geometry={g} material={PICK_MAT} visible={false} /> : null;
}

/* ================================================================ geometry helpers */

/** Rounded rectangle plate (w × h in the XY plane) with circular holes, extruded along Z (centred). */
function holedPlate(w: number, h: number, r: number, holes: [number, number, number][], depth: number, seg = 24) {
  const s = new THREE.Shape();
  const x0 = -w / 2;
  const y0 = -h / 2;
  s.moveTo(x0 + r, y0);
  s.lineTo(x0 + w - r, y0);
  s.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
  s.lineTo(x0 + w, y0 + h - r);
  s.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
  s.lineTo(x0 + r, y0 + h);
  s.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
  s.lineTo(x0, y0 + r);
  s.quadraticCurveTo(x0, y0, x0 + r, y0);
  for (const [hx, hy, hr] of holes) {
    const p = new THREE.Path();
    p.absarc(hx, hy, hr, 0, Math.PI * 2, true);
    s.holes.push(p);
  }
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: seg });
  g.translate(0, 0, -depth / 2);
  return g;
}

/** Swept fan blade outline (radial along +X from rh to rt), thin along Z. */
function bladeGeo(rh: number, rt: number, chord: number, th: number) {
  const s = new THREE.Shape();
  s.moveTo(rh, -chord * 0.3);
  s.quadraticCurveTo((rh + rt) / 2, -chord * 0.42, rt, -chord * 0.22);
  s.quadraticCurveTo(rt * 1.03, chord * 0.2, rt * 0.96, chord * 0.58);
  s.quadraticCurveTo((rh + rt) / 2, chord * 0.5, rh, chord * 0.3);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: th, bevelEnabled: false, curveSegments: 6 });
  g.translate(0, 0, -th / 2);
  return g;
}

/** Fan rotor around local +Z: n pitched blades (axial depth ≈ depth) and an optional hub. */
function rotor(k: Kit, hr: number, rt: number, depth: number, blade: THREE.Material, n = 7, hub?: THREE.Material) {
  const chord = ((Math.PI * 2 * rt) / n) * 0.7;
  const pitch = Math.asin(Math.min(0.85, depth / chord));
  const geo = bladeGeo(hr * 0.92, rt, chord, Math.max(0.03, rt * 0.012));
  for (let i = 0; i < n; i++) k.at(O, [0, 0, (i / n) * Math.PI * 2], () => k.add(blade, geo, O, [pitch, 0, 0], [1, 1, 1], NC));
  geo.dispose();
  if (hub) k.cyl(hub, hr, depth * 1.1, O, [Math.PI / 2, 0, 0], 24, NC);
}

/** Axial fan, axis along local +Z (air leaves toward +Z): frame with round throat, stator, rotor. */
function axialFan(k: Kit, s: number, t: number, frame: THREE.Material = MAT.fan, blade: THREE.Material = MAT.fanBlade, n = 7, ring?: THREE.Material) {
  const r = s * 0.47;
  const g = holedPlate(s, s, s * 0.08, [[0, 0, r]], t);
  k.add(frame, g);
  g.dispose();
  if (ring) k.torus(ring, r + 0.05, 0.09, [0, 0, t / 2 + 0.02], [Math.PI / 2, 0, 0], 40, NC);
  for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    k.cyl(MAT.seam, s * 0.03, t + 0.02, [x * s * 0.41, y * s * 0.41, 0], [Math.PI / 2, 0, 0], 8, NC);
    k.box(KM.rubber, [s * 0.1, s * 0.1, 0.04], [x * s * 0.43, y * s * 0.43, -t / 2 - 0.02], O, NC);
  }
  const hr = s * 0.17;
  k.cyl(frame, hr, t * 0.3, [0, 0, t * 0.34], [Math.PI / 2, 0, 0], 24, NC);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const m = (hr + r) / 2;
    k.box(frame, [r - hr + 0.1, s * 0.025, t * 0.22], [Math.cos(a) * m, Math.sin(a) * m, t * 0.38], [0, 0, a], NC);
  }
  rotor(k, hr, r - s * 0.012, t * 0.45, blade, n, frame);
  k.cyl(MAT.seam, hr * 0.8, 0.01, [0, 0, -t * 0.26], [Math.PI / 2, 0, 0], 20, NC);
}

/** SMD passive (0402-style): body plus two nickel terminations, along local X. */
function smd(k: Kit, x: number, y: number, z: number, yaw = 0, body: THREE.Material = MAT.ceramic, l = 0.1, w = 0.05, h = 0.05) {
  k.at([x, y, z], yaw, () => {
    k.box(body, [l * 0.6, h, w], [0, h / 2, 0], O, NC);
    for (const s of [-1, 1]) k.box(MAT.nickel, [l * 0.22, h * 1.04, w * 1.04], [s * l * 0.39, h / 2, 0], O, NC);
  });
}

/** Plane carrying its own texture (label, pin field, perforation), facing local +Z before rot. */
function decal(k: Kit, m: THREE.Material, w: number, h: number, pos: V3, rot: V3 = O) {
  const g = new THREE.PlaneGeometry(w, h);
  k.add(m, g, pos, rot, [1, 1, 1], { cast: false, keepUV: true });
  g.dispose();
}

/* ================================================================ procedural maps */

function canvasTex(c: HTMLCanvasElement, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!] as const;
}

let _perf: THREE.CanvasTexture | null = null;
/** Staggered round perforation (mesh filters, exhaust panels), tinted by the material colour. */
function perfTexture() {
  if (_perf) return _perf;
  const [c, g] = makeCanvas(64, 64);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#0d0f10';
  for (const [x, y] of [[16, 16], [48, 16], [0, 48], [32, 48], [64, 48]] as const) {
    g.beginPath();
    g.arc(x, y, 11, 0, Math.PI * 2);
    g.fill();
  }
  _perf = canvasTex(c);
  _perf.wrapS = _perf.wrapT = THREE.RepeatWrapping;
  return _perf;
}
const perfCache = new Map<string, THREE.MeshStandardMaterial>();
function perfMat(color: string, rx: number, ry: number) {
  const key = `${color}:${rx.toFixed(1)}:${ry.toFixed(1)}`;
  let m = perfCache.get(key);
  if (!m) {
    const t = perfTexture().clone();
    t.repeat.set(rx, ry);
    t.needsUpdate = true;
    perfCache.set(key, (m = new THREE.MeshStandardMaterial({ map: t, color, roughness: 0.55, metalness: 0.45, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })));
  }
  return m;
}

/** LGA contact field: hexagonal grid of gold contacts around the central cavity. */
function pinFieldMaterial() {
  const W = 512;
  const H = 425;
  const [c, g] = makeCanvas(W, H);
  g.fillStyle = '#232527';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#c9a046';
  const p = 7.5;
  for (let y = p / 2, row = 0; y < H; y += p * 0.866, row++)
    for (let x = p / 2 + (row % 2) * (p / 2); x < W; x += p) {
      if (x > W * 0.37 && x < W * 0.63 && y > H * 0.35 && y < H * 0.65) continue;
      g.beginPath();
      g.arc(x, y, 1.9, 0, Math.PI * 2);
      g.fill();
    }
  g.strokeStyle = '#3a3d40';
  g.lineWidth = 3;
  g.strokeRect(W * 0.37, H * 0.35, W * 0.26, H * 0.3);
  return new THREE.MeshStandardMaterial({ map: canvasTex(c), roughness: 0.35, metalness: 0.6 });
}

type Draw = (g: CanvasRenderingContext2D, X: (x: number) => number, Z: (z: number) => number, s: number) => void;
/** PCB top: copper pours, routed traces, vias and silkscreen, mapped onto a box top (w × d cm). */
function pcbTexture(w: number, d: number, seed: number, draw: Draw) {
  const s = 24;
  const W = Math.round(w * s);
  const H = Math.round(d * s);
  const [c, g] = makeCanvas(W, H);
  // canvas x → +x, canvas y → +z (box top UVs)
  const X = (x: number) => (x + w / 2) * s;
  const Z = (z: number) => (z + d / 2) * s;
  g.fillStyle = '#1d4633';
  g.fillRect(0, 0, W, H);
  const r = rng(seed);
  g.fillStyle = 'rgba(70,130,92,0.14)';
  for (let i = 0; i < 16; i++) g.fillRect(r() * W, r() * H, 40 + r() * 170, 30 + r() * 120);
  g.lineWidth = 1;
  for (let i = 0; i < (W * H) / 1100; i++) {
    let x = r() * W;
    let y = r() * H;
    g.strokeStyle = r() < 0.5 ? 'rgba(92,158,114,0.36)' : 'rgba(80,140,100,0.26)';
    g.beginPath();
    g.moveTo(x, y);
    for (let k = 0; k < 3; k++) {
      const L = 8 + r() * 70;
      const dir = Math.floor(r() * 4);
      if (dir === 0) x += L;
      else if (dir === 1) y += L;
      else {
        x += L * 0.7;
        y += dir === 2 ? L * 0.7 : -L * 0.7;
      }
      g.lineTo(x, y);
    }
    g.stroke();
    if (r() < 0.45) {
      g.fillStyle = 'rgba(205,175,96,0.75)';
      g.beginPath();
      g.arc(x, y, 1.6, 0, Math.PI * 2);
      g.fill();
    }
  }
  draw(g, X, Z, s);
  g.strokeStyle = 'rgba(120,180,140,0.35)';
  g.lineWidth = 2;
  g.strokeRect(4, 4, W - 8, H - 8);
  return canvasTex(c);
}

function silk(g: CanvasRenderingContext2D) {
  g.strokeStyle = 'rgba(226,232,226,0.72)';
  g.fillStyle = 'rgba(226,232,226,0.8)';
  g.lineWidth = 1.3;
}

function motherboardTexture() {
  return pcbTexture(30.5, 24.4, 58, (g, X, Z, s) => {
    // DDR fly-by bus: socket → DIMM slots
    g.strokeStyle = 'rgba(104,176,128,0.55)';
    g.lineWidth = 1;
    for (let i = 0; i < 64; i++) {
      const z = SZ - 4.2 + i * 0.13;
      const z2 = SZ + (z - SZ) * 1.3;
      g.beginPath();
      g.moveTo(X(SX + 2.8), Z(z));
      g.lineTo(X(-0.6), Z(z));
      g.lineTo(X(0.4), Z(z2));
      g.lineTo(X(6.2), Z(z2));
      g.stroke();
    }
    // PCIe lanes: socket → slots
    for (let i = 0; i < 30; i++) {
      const x = SX - 2.2 + i * 0.15;
      g.beginPath();
      g.moveTo(X(x), Z(SZ + 2.9));
      g.lineTo(X(x), Z(1.8));
      g.lineTo(X(x - 1.0), Z(2.8));
      g.lineTo(X(x - 1.0), Z(i % 2 ? 9.5 : 6));
      g.stroke();
    }
    silk(g);
    const rect = (x: number, z: number, w: number, d: number) => g.strokeRect(X(x - w / 2), Z(z - d / 2), w * s, d * s);
    rect(SX, SZ, 6.3, 5.9);
    for (let i = 0; i < 4; i++) rect(SX + 6 + i * 1.1, SZ, 0.78, 14.3);
    for (const z of [6, 9.5]) rect(-2, z, 9.3, 0.9);
    rect(-4.2, 3.4, 8.9, 2.4);
    rect(-2.2, 7.75, 8.9, 2.4);
    rect(9, 7.6, 6.3, 6.3);
    g.setLineDash([6, 4]);
    g.strokeRect(X(-15.0), Z(6.9), 7.4 * s, 5.2 * s);
    g.setLineDash([]);
    g.font = `600 ${0.42 * s}px "JetBrains Mono", ui-monospace, monospace`;
    const txt = (t: string, x: number, z: number) => g.fillText(t, X(x), Z(z));
    txt('CPU1', SX - 3.0, SZ - 3.15);
    ['DIMM_A1', 'DIMM_A2', 'DIMM_B1', 'DIMM_B2'].forEach((t, i) => {
      g.save();
      g.translate(X(SX + 6.45 + i * 1.1), Z(SZ + 7.3));
      g.rotate(-Math.PI / 2);
      g.fillText(t, 0, 0);
      g.restore();
    });
    txt('PCIE_X16_1', -6.4, 5.45);
    txt('PCIE_X16_2', -6.4, 8.95);
    txt('M2_1', -8.4, 2.05);
    txt('ATX_PWR', 12.2, -4.6);
    txt('CPU_FAN', 0.2, -10.0);
    txt('CPU_PWR', -10.0, -10.4);
    txt('BAT', -10.0, 11.6);
    txt('AUDIO', -14.8, 12.0);
    txt('MB-Z7  REV 1.0', 4.6, 11.95);
  });
}

function cardTexture() {
  return pcbTexture(26, 11, 77, (g, X, Z, s) => {
    g.strokeStyle = 'rgba(104,176,128,0.55)';
    g.lineWidth = 1;
    // PCIe lanes: package → edge fingers
    for (let i = 0; i < 34; i++) {
      const x = -7.6 + i * 0.22;
      g.beginPath();
      g.moveTo(X(-2.6 + i * 0.08), Z(2.8));
      g.lineTo(X(-2.6 + i * 0.08), Z(3.4));
      g.lineTo(X(x), Z(4.6));
      g.lineTo(X(x), Z(5.5));
      g.stroke();
    }
    // power planes from the VRM
    g.fillStyle = 'rgba(80,150,104,0.22)';
    g.fillRect(X(3.2), Z(-4.6), 9.5 * s, 6.4 * s);
    silk(g);
    const rect = (x: number, z: number, w: number, d: number) => g.strokeRect(X(x - w / 2), Z(z - d / 2), w * s, d * s);
    rect(0, 0, 6.3, 5.8);
    for (let i = 0; i < 12; i++) rect(6 + (i % 6) * 1.1, -3 + Math.floor(i / 6) * 1.2, 0.9, 0.9);
    g.font = `600 ${0.4 * s}px "JetBrains Mono", ui-monospace, monospace`;
    g.fillText('GPU1', X(-3.0), Z(-3.15));
    g.fillText('AX-100  PCB REV B', X(-11.8), Z(-4.6));
    g.fillText('PWR_IN', X(10.6), Z(-0.2));
  });
}

/* ================================================================ CPU package */

function buildCpuSubstrate(k: Kit) {
  const y = 0.16;
  for (const sx of [-1, 1]) for (let i = 0; i < 11; i++) smd(k, sx * 2.02, y, -1.6 + i * 0.32, 0);
  for (const sz of [-1, 1]) for (let i = 0; i < 10; i++) smd(k, -1.35 + i * 0.3, y, sz * 1.74, Math.PI / 2);
  // pin-1 marker
  k.extrude(MAT.gold, [[0, 0], [0.22, 0], [0, 0.22]], 0.004, [-2.24, y + 0.004, -1.86], [Math.PI / 2, 0, 0], NC);
}

/** Integrated heat spreader: notched skirt sealed to the substrate, raised plateau, marked top. */
function buildIhs(k: Kit, top: THREE.Material) {
  for (const sz of [-1, 1]) k.rbox(MAT.lid, [3.6, 0.1, 1.25], 0.05, [0, 0.305, sz * 0.975]);
  k.box(MAT.lid, [3.1, 0.1, 0.72], [0, 0.305, 0]);
  k.rbox(MAT.lid, [3.06, 0.17, 2.76], 0.08, [0, 0.42, 0]);
  k.box(MAT.chip, [3.64, 0.012, 3.24], [0, 0.258, 0], O, NC);
  decal(k, top, 2.86, 2.56, [0, 0.5055, 0], [-Math.PI / 2, 0, 0]);
}

/* ================================================================ motherboard */

/** LGA socket: housing with seating cavity and contact field, stainless load frame, screws, hinge, hook. */
function buildSocket(k: Kit, pins: THREE.Material) {
  k.at([SX, 0, SZ], 0, () => {
    k.rbox(MAT.socket, [5.2, 0.4, 4.6], 0.04, [0, 0.28, 0]);
    for (const sz of [-1, 1]) k.box(MAT.socket, [5.2, 0.1, 0.37], [0, 0.53, sz * 2.115]);
    for (const sx of [-1, 1]) k.box(MAT.socket, [0.3, 0.1, 3.86], [sx * 2.45, 0.53, 0]);
    decal(k, pins, 4.4, 3.66, [0, 0.4815, 0], [-Math.PI / 2, 0, 0]);
    for (const sz of [-1, 1]) k.box(MAT.steel, [6.0, 0.12, 0.45], [0, 0.14, sz * 2.575]);
    for (const sx of [-1, 1]) k.box(MAT.steel, [0.35, 0.12, 4.7], [sx * 2.825, 0.14, 0]);
    for (const [x, z] of [[-2.78, -2.58], [2.78, -2.58], [-2.78, 2.58], [2.78, 2.58]] as const) {
      k.cyl(MAT.steelDark, 0.17, 0.09, [x, 0.245, z], O, 12, NC);
      k.cyl(MAT.seam, 0.07, 0.01, [x, 0.293, z], O, 6, NC);
    }
    for (const z of [-1.6, 1.6]) k.cyl(MAT.steel, 0.12, 0.6, [-2.95, 0.3, z], [Math.PI / 2, 0, 0], 12);
    k.box(MAT.steel, [0.3, 0.42, 0.3], [2.85, 0.41, -2.6]);
    k.box(MAT.steel, [0.32, 0.5, 0.12], [2.95, 0.45, 2.42]);
    k.box(MAT.steel, [0.12, 0.12, 0.25], [3.05, 0.66, 2.42], O, NC);
  });
}

/** Load lever in its hinge frame: rod along local −X (world +Z), cam on the hinge axis, bent handle. */
function buildLever(k: Kit) {
  k.cyl(MAT.lever, 0.06, 5.0, [-2.6, 0, 0], [0, 0, Math.PI / 2], 12);
  k.cyl(MAT.lever, 0.06, 0.45, [0, 0, -0.2], [Math.PI / 2, 0, 0], 12);
  k.cyl(MAT.lever, 0.08, 0.14, [-0.1, 0, 0], [0, 0, Math.PI / 2], 12, NC);
  k.cyl(MAT.lever, 0.06, 0.36, [-5.12, 0, 0.17], [Math.PI / 2, 0, 0], 10);
  k.rbox(KM.plastic, [0.26, 0.14, 0.45], 0.05, [-5.12, 0, 0.52]);
}

function buildCpuVrm(k: Kit) {
  // left bank: eight phases along z (chokes, polymer caps, power stages under a finned sink)
  for (let i = 0; i < 8; i++) {
    const z = SZ - 3.5 + i * 1.0;
    k.rbox(MAT.ferrite, [0.9, 0.5, 0.9], 0.05, [SX - 4.5, 0.33, z]);
    k.box(MAT.steelDark, [0.5, 0.004, 0.32], [SX - 4.5, 0.582, z], O, NC);
    k.cyl(MAT.alu, 0.3, 0.82, [SX - 5.8, 0.49, z], O, 16);
    k.cyl(MAT.cap, 0.302, 0.1, [SX - 5.8, 0.85, z], O, 16, NC);
    k.box(MAT.seam, [0.36, 0.004, 0.035], [SX - 5.8, 0.902, z], O, NC);
    k.box(MAT.seam, [0.035, 0.004, 0.36], [SX - 5.8, 0.902, z], O, NC);
  }
  k.rbox(MAT.aluDark, [0.9, 0.35, 8.4], 0.05, [SX - 3.62, 0.255, SZ - 0.5]);
  for (let i = 0; i < 14; i++) k.box(MAT.aluDark, [0.9, 0.7, 0.16], [SX - 3.62, 0.78, SZ - 4.4 + i * 0.6]);
  k.box(KM.paintAccent, [0.02, 0.08, 8.4], [SX - 3.16, 0.3, SZ - 0.5], O, NC);
  // top bank along the upper edge
  for (let i = 0; i < 5; i++) {
    const x = SX - 2.5 + i * 1.15;
    k.rbox(MAT.ferrite, [0.9, 0.5, 0.9], 0.05, [x, 0.33, SZ - 4.8]);
    k.box(MAT.steelDark, [0.32, 0.004, 0.5], [x, 0.582, SZ - 4.8], O, NC);
    k.box(MAT.chip, [0.6, 0.08, 0.45], [x, 0.12, SZ - 4.0], O, NC);
    k.cyl(MAT.alu, 0.28, 0.74, [x, 0.45, SZ - 5.95], O, 16);
    k.cyl(MAT.cap, 0.282, 0.1, [x, 0.77, SZ - 5.95], O, 16, NC);
  }
  k.box(MAT.chip, [0.7, 0.08, 0.7], [SX - 6.8, 0.12, SZ + 3.2], O, NC);
}

/** Fixed board components: memory and PCIe slots, I/O shroud, connectors, M.2 and chipset sinks, headers. */
function buildBoardParts(k: Kit) {
  // DIMM slots (latch at the +z end, key off-centre)
  for (let i = 0; i < 4; i++) {
    const x = SX + 6 + i * 1.1;
    const m = i % 2 ? MAT.plasticGrey : MAT.socket;
    k.box(m, [0.6, 0.8, 13.2], [x, 0.48, SZ]);
    k.box(MAT.seam, [0.2, 0.004, 12.9], [x, 0.882, SZ], O, NC);
    k.box(m, [0.2, 0.008, 0.16], [x, 0.882, SZ - 0.9], O, NC);
    k.rbox(m, [0.6, 0.95, 0.4], 0.05, [x, 0.555, SZ - 6.8]);
    k.rbox(MAT.plasticGrey, [0.62, 1.12, 0.42], 0.06, [x, 0.64, SZ + 6.81]);
    k.box(MAT.seam, [0.3, 0.004, 0.3], [x, 1.202, SZ + 6.81], O, NC);
  }
  // PCIe x16 slots, the primary one with a steel armour
  for (const z of [6, 9.5]) {
    k.box(MAT.socket, [8.6, 0.85, 0.7], [-2.2, 0.505, z]);
    k.box(MAT.seam, [8.3, 0.004, 0.22], [-2.2, 0.932, z], O, NC);
    k.box(MAT.socket, [0.16, 0.008, 0.22], [-5.35, 0.932, z], O, NC);
    k.rbox(MAT.plasticGrey, [0.45, 1.0, 0.72], 0.06, [2.3, 0.58, z]);
    if (z === 6) {
      for (const s of [-1, 1]) {
        k.box(MAT.steel, [8.7, 0.82, 0.03], [-2.2, 0.5, z + s * 0.366]);
        k.box(MAT.steel, [8.7, 0.03, 0.14], [-2.2, 0.93, z + s * 0.3], O, NC);
        for (const x of [-6.3, -2.2, 1.9]) k.cyl(MAT.steelDark, 0.05, 0.02, [x, 0.3, z + s * 0.383], [Math.PI / 2, 0, 0], 8, NC);
      }
    }
  }
  // M.2 heatsinks
  const m2 = (x: number, z: number, h: number) => {
    k.rbox(MAT.aluDark, [8.6, h, 2.2], 0.08, [x, 0.08 + h / 2, z]);
    for (let i = 0; i < 9; i++) k.box(MAT.seam, [7.4, 0.004, 0.06], [x - 0.2, 0.082 + h, z - 0.8 + i * 0.2], O, NC);
    k.box(MAT.alu, [8.62, 0.05, 0.03], [x, 0.08 + h * 0.6, z + 1.1], O, NC);
    for (const xx of [x - 4.0, x + 4.0]) k.cyl(MAT.steelDark, 0.14, 0.05, [xx, 0.105 + h, z], O, 10, NC);
  };
  m2(-4.2, 3.4, 0.55);
  m2(-2.2, 7.75, 0.45);
  // chipset heatsink
  k.rbox(MAT.aluDark, [6.0, 0.7, 6.0], 0.15, [9.0, 0.43, 7.6]);
  k.rbox(MAT.alu, [5.0, 0.1, 5.0], 0.06, [9.0, 0.82, 7.6]);
  for (const z of [5.6, 5.9, 9.3, 9.6]) k.box(MAT.seam, [4.4, 0.004, 0.06], [9.0, 0.872, z], O, NC);
  k.label('model', 'FX-1', 'PLATFORM HUB', 2.8, 0.7, [9.0, 0.873, 7.6], [-Math.PI / 2, 0, 0]);
  // I/O shroud over the rear connectors
  k.at([-12.9, 0, -5.2], 0, () => {
    k.rbox(MAT.aluDark, [4.5, 2.2, 13.6], 0.25, [0, 1.18, 0]);
    k.rbox(MAT.shroud, [3.7, 0.18, 12.6], 0.08, [0.15, 2.32, 0]);
    for (let i = 0; i < 8; i++) k.box(MAT.seam, [3.2, 0.004, 0.06], [0.15, 2.412, 2.6 + i * 0.42], O, NC);
    k.box(KM.paintAccent, [0.03, 0.08, 12.8], [2.262, 1.6, 0], O, NC);
    k.label('model', 'MB-Z7', 'ATX · LGA · DDR5', 2.8, 0.7, [0.15, 2.413, -3.2], [-Math.PI / 2, 0, 0]);
  });
  // rear I/O connectors, faces just past the PCB edge
  const usb = (z: number) => {
    k.box(MAT.steel, [1.5, 1.6, 1.4], [-14.6, 0.88, z]);
    for (const y of [0.55, 1.2]) {
      k.box(MAT.seam, [0.01, 0.42, 1.05], [-15.356, y, z], O, NC);
      k.box(KM.paintBlue, [0.012, 0.12, 0.85], [-15.358, y + 0.05, z], O, NC);
    }
  };
  [-11.1, -9.5, -5.9, -2.2].forEach(usb);
  k.box(MAT.steel, [1.6, 1.3, 1.6], [-14.55, 0.73, -7.7]);
  k.box(MAT.seam, [0.01, 0.8, 1.1], [-15.356, 0.7, -7.7], O, NC);
  for (const s of [-1, 1]) k.box(s < 0 ? KM.ledGreen : KM.ledAmber, [0.012, 0.14, 0.2], [-15.358, 1.25, -7.7 + s * 0.5], O, NC);
  k.box(MAT.socket, [1.4, 0.9, 1.6], [-14.6, 0.53, -4.2]);
  k.box(MAT.seam, [0.01, 0.4, 1.2], [-15.306, 0.55, -4.2], O, NC);
  k.box(KM.plastic, [1.4, 2.0, 1.4], [-14.6, 1.08, -0.4]);
  [KM.paintBlue, KM.ledGreen, KM.paintRed].forEach((m, i) => k.cyl(m, 0.22, 0.03, [-15.31, 0.5 + i * 0.6, -0.4], [0, 0, Math.PI / 2], 14, NC));
  // power connectors
  k.rbox(MAT.socket, [2.0, 1.0, 0.9], 0.05, [-9.0, 0.58, -11.4]);
  for (let i = 0; i < 4; i++) for (const s of [-1, 1]) k.box(MAT.seam, [0.34, 0.004, 0.32], [-9.75 + i * 0.5, 1.082, -11.4 + s * 0.2], O, NC);
  k.box(MAT.socket, [0.5, 0.35, 0.12], [-9.0, 0.95, -11.9]);
  k.rbox(MAT.socket, [1.0, 1.45, 5.4], 0.05, [14.3, 0.805, -1.6]);
  for (let j = 0; j < 12; j++) for (const y of [0.5, 1.05]) k.box(MAT.seam, [0.004, 0.36, 0.34], [14.802, y, -4.075 + j * 0.45], O, NC);
  k.box(MAT.socket, [0.15, 0.4, 0.6], [14.88, 1.15, -1.6]);
  // SATA ports and internal USB header on the front edge
  for (const z of [5.0, 6.4, 7.8])
    for (const lv of [0, 1]) {
      const y = 0.36 + lv * 0.6;
      k.box(MAT.socket, [1.2, 0.55, 1.1], [14.5, y, z]);
      k.box(MAT.seam, [0.004, 0.22, 0.8], [15.102, y, z], O, NC);
      k.box(MAT.seam, [0.004, 0.12, 0.15], [15.102, y + 0.12, z - 0.35], O, NC);
    }
  k.rbox(MAT.socket, [0.95, 0.9, 2.0], 0.05, [14.4, 0.53, 10.6]);
  k.box(MAT.seam, [0.004, 0.5, 1.6], [14.877, 0.55, 10.6], O, NC);
  // front-panel and fan headers
  for (const x of [7.6, 9.6, 11.6]) {
    k.box(MAT.socket, [1.3, 0.25, 0.55], [x, 0.205, 11.5]);
    for (let i = 0; i < 5; i++) for (const s of [-1, 1]) k.box(MAT.gold, [0.06, 0.6, 0.06], [x - 0.5 + i * 0.25, 0.38, 11.5 + s * 0.13], O, NC);
  }
  for (const [x, z] of [[-6.8, -11.4], [6.5, -11.4], [0.9, -9.4], [14.6, 3.4], [-12.6, 6.4]] as const) {
    k.box(MAT.white, [0.9, 0.55, 0.35], [x, 0.355, z]);
    for (let i = 0; i < 4; i++) k.box(MAT.gold, [0.05, 0.4, 0.05], [x - 0.3 + i * 0.2, 0.44, z], O, NC);
  }
  // CMOS cell, audio section, controllers, debug LEDs
  k.rbox(MAT.socket, [2.4, 0.16, 2.4], 0.3, [-9.6, 0.16, 9.6]);
  k.cyl(MAT.steel, 1.0, 0.32, [-9.6, 0.4, 9.6], O, 32);
  k.cyl(MAT.steelDark, 0.95, 0.01, [-9.6, 0.565, 9.6], O, 32, NC);
  k.box(MAT.steel, [0.3, 0.3, 0.5], [-8.4, 0.3, 9.6]);
  k.box(MAT.steel, [1.6, 0.25, 1.6], [-13.0, 0.205, 9.6]);
  for (let i = 0; i < 4; i++) k.box(MAT.seam, [1.2, 0.004, 0.05], [-13.0, 0.332, 9.0 + i * 0.4], O, NC);
  for (const [x, z] of [[-14.2, 11.4], [-13.2, 11.4], [-12.2, 11.4], [-11.2, 11.4], [-14.3, 7.6], [-11.6, 7.8]] as const) {
    k.cyl(MAT.audioCap, 0.32, 0.66, [x, 0.41, z], O, 16);
    k.cyl(MAT.steel, 0.3, 0.02, [x, 0.75, z], O, 16, NC);
  }
  k.box(MAT.chip, [1.4, 0.12, 1.4], [11.2, 0.14, -8.6], O, NC);
  k.box(MAT.chip, [0.6, 0.12, 0.5], [12.6, 0.14, 2.8], O, NC);
  k.box(MAT.chip, [0.9, 0.1, 0.9], [-12.0, 0.13, 4.2], O, NC);
  for (let i = 0; i < 4; i++) k.box(i === 3 ? KM.ledGreen : MAT.white, [0.3, 0.08, 0.15], [13.0, 0.12, -5.0 + i * 0.3], O, NC);
}

const BOARD_HOLES: [number, number][] = [[-14.4, -11.4], [-14.4, 1.0], [-14.4, 11.3], [-0.5, -11.4], [12.0, -11.4], [13.0, 1.8], [0.9, 1.4], [1.0, 11.4]];

/** PCB-level detail (moves with the bare board in the exploded view): plated holes, passives, backplate. */
function buildBoardPcb(k: Kit) {
  for (const [x, z] of BOARD_HOLES) {
    k.torus(MAT.gold, 0.38, 0.06, [x, 0.08, z], O, 24, NC);
    k.cyl(MAT.seam, 0.27, 0.17, [x, 0, z], O, 16, NC);
  }
  const r = rng(91);
  for (let i = 0; i < 170; i++) {
    const x = -14.5 + r() * 29;
    const z = -11.5 + r() * 23;
    const kind = r();
    const yaw = r() < 0.5 ? 0 : Math.PI / 2;
    if (kind < 0.55) smd(k, x, 0.08, z, yaw);
    else if (kind < 0.85) smd(k, x, 0.08, z, yaw, MAT.chip, 0.16, 0.08, 0.04);
    else k.box(MAT.chip, [0.3 + r() * 0.4, 0.07, 0.3 + r() * 0.3], [x, 0.115, z], O, NC);
  }
  for (let i = 0; i < 22; i++) smd(k, SX - 3.0 + i * 0.28, 0.08, SZ + 3.05, Math.PI / 2);
  for (let i = 0; i < 28; i++) smd(k, 1.3, 0.08, -8.4 + i * 0.45);
  // socket backplate under the board
  k.rbox(MAT.steelDark, [5.6, 0.14, 5.0], 0.2, [SX, -0.15, SZ]);
  k.box(MAT.seam, [2.4, 0.004, 2.0], [SX, -0.222, SZ], O, NC);
}

/** Memory module in module-local x (y and z as on the board): PCB, edge fingers, DRAM, PMIC, label. */
function buildDimm(k: Kit) {
  k.box(MAT.dimm, [0.15, 3.1, 13.3], [0, 2.3, SZ]);
  for (const s of [-1, 1]) {
    k.box(MAT.gold, [0.006, 0.3, 5.5], [s * 0.078, 0.93, SZ - 3.8], O, NC);
    k.box(MAT.gold, [0.006, 0.3, 7.3], [s * 0.078, 0.93, SZ + 2.9], O, NC);
    for (let j = 0; j < 8; j++) k.box(MAT.chip, [0.1, 0.9, 1.1], [s * 0.125, 2.4, SZ - 5.6 + j * 1.6]);
  }
  k.box(MAT.chip, [0.08, 0.45, 0.45], [0.115, 3.45, SZ]);
  k.box(MAT.chip, [0.06, 0.25, 0.3], [0.105, 3.5, SZ + 1.0], O, NC);
  k.label('tag', 'DDR5 · 16 GB', 'PC5-48000 · 1Rx8', 3.2, 0.8, [-0.081, 1.5, SZ], [0, -Math.PI / 2, 0]);
}

/** Tower cooler: copper cold plate, nickel base, four U heat pipes, 28 fins, top cover, 120 mm fan. */
function buildTowerCooler(k: Kit) {
  k.rbox(MAT.copper, [3.6, 0.12, 3.6], 0.04, [SX, 1.02, SZ]);
  k.rbox(MAT.nickel, [4.0, 0.36, 3.0], 0.06, [SX, 1.26, SZ]);
  k.rbox(MAT.aluDark, [3.6, 0.14, 1.8], 0.04, [SX, 1.51, SZ]);
  for (const dx of [-1.4, 1.4]) k.cyl(MAT.steelDark, 0.12, 0.1, [SX + dx, 1.62, SZ], O, 10, NC);
  // mounting bar with spring screws onto standoffs
  k.rbox(MAT.steel, [0.9, 0.12, 7.6], 0.04, [SX, 1.5, SZ]);
  for (const s of [-1, 1]) {
    const z = SZ + s * 3.5;
    k.cyl(MAT.steelDark, 0.22, 1.36, [SX, 0.76, z], O, 12);
    k.cyl(MAT.steel, 0.3, 0.14, [SX, 1.63, z], O, 14, NC);
    k.cyl(MAT.seam, 0.12, 0.01, [SX, 1.705, z], O, 6, NC);
    for (let j = 0; j < 4; j++) k.torus(MAT.steel, 0.24, 0.035, [SX, 1.0 + j * 0.11, z], O, 12, NC);
  }
  // heat pipes: U-shaped, through the base, risers spread across the fin stack
  const pipes: [number, number][] = [[-1.65, 4.6], [-0.55, 2.0], [0.55, 3.3], [1.65, 0.8]];
  for (const [dx, off] of pipes) {
    const x = SX + dx;
    k.pipe(MAT.copper, [[x, 11.75, SZ - off], [x, 1.26, SZ - off], [x, 1.26, SZ + off], [x, 11.75, SZ + off]], 0.3, Math.min(1.2, off));
    for (const s of [-1, 1]) k.cyl(MAT.nickel, 0.3, 0.1, [x, 11.8, SZ + s * off], O, 14, NC);
  }
  // fin stack (7 deep along the airflow, 12 wide)
  for (let i = 0; i < 28; i++) k.box(MAT.fin, [7.0, 0.05, 12.0], [SX, 2.6 + i * 0.32, SZ]);
  for (const s of [-1, 1]) k.box(MAT.fin, [7.0, 8.7, 0.04], [SX, 6.92, SZ + s * 6.0], O, NC);
  k.rbox(MAT.aluDark, [7.2, 0.22, 12.2], 0.08, [SX, 11.42, SZ]);
  k.rbox(MAT.alu, [6.4, 0.05, 11.4], 0.03, [SX, 11.55, SZ]);
  k.label('model', 'TC-6', 'TOWER COOLER · 6 mm PIPES', 3.4, 0.85, [SX, 11.578, SZ - 3.6], [-Math.PI / 2, 0, 0]);
  // 120 mm fan on the intake face with wire clips
  k.at([0.6, 6.9, SZ], [0, Math.PI / 2, 0], () => axialFan(k, 12, 2.0, MAT.fan, MAT.fanBlade, 9));
  for (const y of [1.6, 12.2]) for (const s of [-1, 1]) k.tube(MAT.steel, [[1.55, y, SZ + s * 5.6], [-0.5, y, SZ + s * 5.6], [-1.0, y + (y < 5 ? 0.6 : -0.6), SZ + s * 5.6]], 0.05, { radial: 6, cast: false });
  k.tube(MAT.sleeve, [[1.4, 1.2, SZ - 5.4], [1.3, 0.7, SZ - 6.6], [0.9, 0.7, -9.0], [0.9, 0.62, -9.4]], 0.07, { radial: 6, cast: false });
}

/** Tower case around the board's final pose: glass front and sides, aluminium frame, fans, PSU shroud. */
const TOWER = { x0: -17, x1: 18, y0: -5.9, y1: 37.5, z0: -24.3, z1: -7 };
function buildTower(k: Kit) {
  const { x0, x1, y0, y1, z0, z1 } = TOWER;
  const W = x1 - x0;
  const H = y1 - y0;
  const D = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const cz = (z0 + z1) / 2;
  const fz = (z0 + 0.6 - 9.7) / 2; // main-chamber centre line for the fans
  const R = 0.8;
  const rail = MAT.alu;
  const panel = MAT.caseMat;
  // extruded aluminium frame: twelve rounded edge rails, corner caps
  for (const y of [y0 + R / 2, y1 - R / 2]) for (const z of [z0 + R / 2, z1 - R / 2]) k.rbox(rail, [W, R, R], 0.25, [cx, y, z]);
  for (const x of [x0 + R / 2, x1 - R / 2]) for (const z of [z0 + R / 2, z1 - R / 2]) k.rbox(rail, [R, H - 2 * R, R], 0.25, [x, cy, z]);
  for (const x of [x0 + R / 2, x1 - R / 2]) for (const y of [y0 + R / 2, y1 - R / 2]) k.rbox(rail, [R, R, D - 2 * R], 0.25, [x, y, cz]);
  for (const x of [x0 + R / 2, x1 - R / 2]) for (const z of [z0 + R / 2, z1 - R / 2]) for (const y of [y0 + R + 0.06, y1 - R - 0.06]) k.box(MAT.seam, [R + 0.01, 0.06, R + 0.01], [x, y, z], O, NC);
  // floor, top plate with a perforated filter over the fans, front I/O
  k.box(panel, [W - 0.4, 0.3, D - 0.4], [cx, y0 + 0.35, cz]);
  k.box(panel, [W - 0.4, 0.3, D - 0.4], [cx, y1 - 0.35, cz]);
  decal(k, perfMat('#6a706c', 31 / 0.6, 13 / 0.6), 31, 13, [cx - 0.5, y1 - 0.19, fz], [-Math.PI / 2, 0, 0]);
  k.rbox(MAT.plasticGrey, [2.6, 0.08, 9.0], 0.04, [x1 - 2.4, y1 - 0.17, cz]);
  k.cyl(MAT.steel, 0.62, 0.2, [x1 - 2.4, y1 - 0.06, cz - 3.0], O, 24);
  k.torus(KM.ledWhite, 0.7, 0.05, [x1 - 2.4, y1 - 0.1, cz - 3.0], O, 24, NC);
  for (const z of [cz - 1.0, cz + 0.6]) k.box(MAT.seam, [1.2, 0.004, 0.5], [x1 - 2.4, y1 - 0.128, z], O, NC);
  k.box(MAT.seam, [0.85, 0.004, 0.3], [x1 - 2.4, y1 - 0.128, cz + 2.0], O, NC);
  k.cyl(MAT.seam, 0.18, 0.01, [x1 - 2.4, y1 - 0.128, cz + 3.2], O, 12, NC);
  // rear panel: I/O shield aligned with the board's rear I/O, slot covers, exhaust fan and grille
  k.box(panel, [0.25, H - 1.6, D - 1.6], [x0 + 0.4, cy, cz]);
  k.box(MAT.steel, [0.05, 14.4, 2.7], [x0 + 0.25, 9.0, -11.35]);
  for (let i = 0; i < 5; i++) {
    const y = 18.0 + i * 2.03;
    k.box(MAT.steel, [0.06, 1.7, 11.0], [x0 + 0.24, y, -17.9]);
    for (let j = 0; j < 6; j++) k.box(MAT.seam, [0.02, 0.9, 0.35], [x0 + 0.205, y, -22.0 + j * 0.9], O, NC);
    k.cyl(MAT.steelDark, 0.35, 0.4, [x0 + 0.05, y, -23.0], [0, 0, Math.PI / 2], 12, NC);
  }
  k.at([x0 + 0.53 + 1.25, 30.8, fz], [0, -Math.PI / 2, 0], () => axialFan(k, 11, 2.5, MAT.fan, MAT.fanBlade, 7, KM.ledWhite));
  decal(k, perfMat('#5c625f', 11 / 0.6, 11 / 0.6), 11, 11, [x0 + 0.27, 30.8, fz], [0, -Math.PI / 2, 0]);
  decal(k, perfMat('#5c625f', 6 / 0.6, 5 / 0.6), 6, 5, [x0 + 0.27, -2.6, -15.2], [0, -Math.PI / 2, 0]);
  k.box(MAT.seam, [0.02, 1.2, 1.8], [x0 + 0.26, -2.6, -20.5], O, NC);
  // glass: front and both sides, black ceramic frit borders, thumbscrews through the side glass
  k.box(MAT.glass, [0.4, H - 1.6, D - 1.6], [x1 - 0.4, cy, cz], O, NC);
  for (const s of [-1, 1]) {
    k.box(MAT.frit, [0.42, 1.0, D - 1.6], [x1 - 0.4, cy + (s * (H - 2.6)) / 2, cz], O, NC);
    k.box(MAT.frit, [0.42, H - 3.6, 1.0], [x1 - 0.4, cy, cz + (s * (D - 2.6)) / 2], O, NC);
  }
  for (const z of [z0 + 0.4, z1 - 0.4]) {
    k.box(MAT.glass, [W - 1.6, H - 1.6, 0.4], [cx, cy, z], O, NC);
    for (const s of [-1, 1]) {
      k.box(MAT.frit, [W - 1.6, 1.0, 0.42], [cx, cy + (s * (H - 2.6)) / 2, z], O, NC);
      k.box(MAT.frit, [1.0, H - 3.6, 0.42], [cx + (s * (W - 2.6)) / 2, cy, z], O, NC);
    }
  }
  for (const y of [3, 30]) k.cyl(MAT.steel, 0.42, 0.5, [x0 + 1.5, y, z1 + 0.05], [Math.PI / 2, 0, 0], 16, NC);
  k.label('model', 'TW-1', 'MID-TOWER · ATX · DUAL GLASS', 3.6, 0.9, [x0 + 4.4, y0 + 1.3, z1 - 0.18]);
  // motherboard tray with grommets, standoffs under the board's holes, rear-chamber cable runs, boot SSD
  {
    // tray (light powder coat) with a CPU-backplate opening behind the socket
    const tx0 = x0 + 0.9;
    const tx1 = x1 - 0.9;
    const ty0 = 1.8;
    const ty1 = y1 - 0.9;
    const [ox0, ox1, oy0, oy1] = [SX - 4.5, SX + 4.5, 14 + SZ - 4.2, 14 + SZ + 4.2];
    const plate = (a: number, b: number, c: number, d: number) => k.box(MAT.tray, [b - a, d - c, 0.15], [(a + b) / 2, (c + d) / 2, -9.55]);
    plate(tx0, ox0, ty0, ty1);
    plate(ox1, tx1, ty0, ty1);
    plate(ox0, ox1, ty0, oy0);
    plate(ox0, ox1, oy1, ty1);
    for (const [a, b, c, d] of [[ox0, ox1, oy0 - 0.08, oy0 + 0.08], [ox0, ox1, oy1 - 0.08, oy1 + 0.08]] as const) k.box(MAT.seam, [b - a, d - c, 0.17], [(a + b) / 2, (c + d) / 2, -9.55], O, NC);
    k.label('info', 'CABLE MANAGEMENT', 'ROUTE BEHIND TRAY', 3.6, 0.9, [8.0, 33.5, -9.47]);
  }
  for (const y of [5, 12.4, 19.8]) {
    k.rbox(KM.rubber, [1.1, 5.0, 0.2], 0.3, [16.4, y, -9.62]);
    k.box(MAT.seam, [0.06, 4.4, 0.21], [16.4, y, -9.62], O, NC);
  }
  for (const [hx, hz] of BOARD_HOLES) k.cyl(MAT.brass, 0.24, 0.3, [hx, 14 + hz, -9.77], [Math.PI / 2, 0, 0], 6, NC);
  k.tube(MAT.sleeve, [[13.5, 1.6, -8.2], [16.4, 3.4, -8.2], [16.4, 12.4, -8.2], [16.4, 12.4, -9.3]], 0.55, { radial: 10 });
  k.tube(MAT.sleeve, [[14.5, 1.6, -8.7], [16.9, 3.8, -8.7], [16.9, 19.8, -8.7], [16.5, 19.8, -9.3]], 0.3, { radial: 8 });
  for (const y of [6, 10, 16]) k.box(KM.paintAccent, [1.4, 0.25, 1.3], [16.5, y, -8.3], O, NC);
  k.rbox(MAT.aluDark, [4.8, 7.0, 0.8], 0.1, [12.6, 28.4, -8.5]);
  k.label('tag', 'SSD 2 TB', 'NVMe · BOOT', 3.2, 0.8, [12.6, 28.4, -8.09]);
  // PSU shroud with two intake fans, SFX supply inside
  const sw = W - 1.75;
  const sd = -9.7 - (z0 + 0.6);
  const scx = x0 + 0.8 + sw / 2;
  const sh = holedPlate(sw, sd, 0.3, [[1.6 - scx, 0, 4.5], [11.8 - scx, 0, 4.5]], 0.25);
  k.add(panel, sh, [scx, 1.375, fz], [-Math.PI / 2, 0, 0]);
  sh.dispose();
  for (const x of [1.6, 11.8]) k.at([x, 0.0, fz], [-Math.PI / 2, 0, 0], () => axialFan(k, 9.5, 2.5, MAT.fan, MAT.fanBlade, 7, KM.ledWhite));
  k.box(panel, [0.25, 6.75, sd], [x1 - 0.95, -2.0, fz]);
  decal(k, perfMat('#5c625f', 8 / 0.6, 3 / 0.6), 8, 3, [x1 - 0.82, -2.8, fz], [0, Math.PI / 2, 0]);
  k.label('model', 'TW-1', 'FAB/TWIN SYSTEMS', 3.2, 0.8, [x1 - 0.82, -0.3, fz], [0, Math.PI / 2, 0]);
  k.rbox(KM.paintGraphite, [12.5, 6.3, 12.5], 0.2, [x0 + 0.6 + 6.25, -2.25, fz - 0.5]);
  // top exhaust fans, interior light strip, feet, contact shadow
  for (const x of [-10.6, 0.4, 11.4]) k.at([x, y1 - 1.75, fz], [-Math.PI / 2, 0, 0], () => axialFan(k, 10.5, 2.5, MAT.fan, MAT.fanBlade, 7, KM.ledWhite));
  k.box(KM.ledWhite, [0.1, 0.12, D - 2.6], [x1 - 0.85, y1 - 0.95, cz], O, NC);
  for (const x of [x0 + 3.5, x1 - 3.5]) for (const z of [z0 + 2, z1 - 2]) k.rbox(KM.rubber, [4.0, 0.62, 2.0], 0.2, [x, -6.19, z]);
  k.ao(W, D, [cx, -6.5, cz], 1.15);
}

function Cpu() {
  const dieMats = useMemo(() => [MAT.si, MAT.si, new THREE.MeshStandardMaterial({ map: dieFloorplan('cpu'), roughness: 0.3, metalness: 0.35 }), MAT.si, MAT.si, MAT.si], []);
  const subMats = useMemo(() => {
    const top = new THREE.MeshStandardMaterial({ map: substrateTexture(), roughness: 0.5 });
    return [MAT.pcbDark, MAT.pcbDark, top, MAT.pcbDark, MAT.pcbDark, MAT.pcbDark];
  }, []);
  const lidTop = useMemo(() => {
    const [c, g] = makeCanvas(256, 256);
    g.fillStyle = '#c9cdd0';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#6e7377';
    g.font = 'bold 30px monospace';
    g.fillText('FAB/TWIN', 40, 110);
    g.font = '18px monospace';
    g.fillText('CH-184-0412', 40, 145);
    return new THREE.MeshStandardMaterial({ map: canvasTex(c), roughness: 0.25, metalness: 0.9 });
  }, []);
  const boardMats = useMemo(() => {
    const top = new THREE.MeshStandardMaterial({ map: motherboardTexture(), roughness: 0.55, metalness: 0.1 });
    return [MAT.pcb, MAT.pcb, top, MAT.pcbDark, MAT.pcb, MAT.pcb];
  }, []);
  const pins = useMemo(() => pinFieldMaterial(), []);
  const substrate = useCm(buildCpuSubstrate);
  const ihs = useCm((k) => buildIhs(k, lidTop), [lidTop]);
  const board = useStation({ socket: (k) => buildSocket(k, pins), vrm: buildCpuVrm, motherboard: buildBoardParts }, [pins]);
  const pcb = useCm(buildBoardPcb);
  const lever = useCm(buildLever);
  const dimm = useCm(buildDimm);
  const cooler = useCm(buildTowerCooler);
  const tower = useCm(buildTower);
  return (
    <group>
      {/* the package: die → substrate + lid, then moves into the socket */}
      <Anim
        f={(g) => {
          const s = prog('socket');
          g.position.set(lerp(0, SX, s), lerp(0, 0.45, s), lerp(0, SZ, s));
          track('focus', g.position.x, g.position.y, g.position.z);
        }}
      >
        <Ex lift={3}>
          <Box s={[1.3, 0.08, 1.65]} p={[0, 0.2, 0]} m={dieMats} sel={{ id: 'pkg-die', label: 'CPU die (generic)' }} />
        </Ex>
        <Anim
          f={(g) => {
            const v = prog('package');
            g.visible = v > 0.01;
            g.position.y = (1 - v) * -2;
          }}
        >
          <Ex lift={0}>
            <Clickable sel={{ kind: 'component', id: 'pkg-substrate', label: 'Package substrate' }}>
              <mesh geometry={GEO.box} material={subMats} scale={[4.5, 0.12, 3.75]} position={[0, 0.1, 0]} castShadow receiveShadow />
              <Baked parts={substrate} />
            </Clickable>
          </Ex>
        </Anim>
        <Anim
          f={(g) => {
            const v = smooth(clamp((pp('package') - 0.4) / 0.6));
            g.visible = v > 0.01;
            g.position.y = (1 - v) * 3;
          }}
        >
          <Ex lift={5}>
            <Clickable sel={{ kind: 'component', id: 'lid', label: 'Integrated heat spreader' }}>
              <Baked parts={ihs} />
            </Clickable>
          </Ex>
        </Anim>
      </Anim>
      {/* motherboard + socket */}
      <Anim
        f={(g) => {
          const v = prog('socket');
          g.visible = v > 0.01;
          g.position.y = (1 - v) * -6;
          // in the system phase the board stands up and slides into the case
          const sy = prog('system');
          g.rotation.x = lerp(0, -Math.PI / 2, sy);
          g.position.z = lerp(0, -10, sy);
          g.position.y += lerp(0, 14, sy);
        }}
      >
        <Ex lift={-3}>
          <Clickable sel={{ kind: 'component', id: 'motherboard', label: 'Motherboard' }}>
            <mesh geometry={GEO.box} material={boardMats} scale={[30.5, 0.16, 24.4]} castShadow receiveShadow />
            <Baked parts={pcb} />
          </Clickable>
        </Ex>
        <StationView m={board} />
        <Clickable sel={{ kind: 'component', id: 'motherboard', label: 'Motherboard' }}>
          <Pick m={board} tag="motherboard" />
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'socket', label: 'CPU socket (LGA)' }}>
          <Pick m={board} tag="socket" />
        </Clickable>
        {/* load lever: hinged at the socket's back corner, swings down to latch */}
        <group position={[SX + 2.8, 0.6, SZ - 2.6]} rotation={[0, Math.PI / 2, 0]}>
          <Anim
            f={(g) => {
              g.rotation.z = lerp(-1.2, 0, smooth(clamp((pp('socket') - 0.7) / 0.3)));
            }}
          >
            <Baked parts={lever} />
          </Anim>
        </group>
        <Clickable sel={{ kind: 'component', id: 'vrm', label: 'Voltage regulator (VRM)' }}>
          <Pick m={board} tag="vrm" />
        </Clickable>
        {/* memory modules */}
        {[0, 1, 2, 3].map((i) => (
          <Anim
            key={i}
            f={(g) => {
              const v = smooth(clamp(pp('board') * 2 - i * 0.15));
              g.visible = v > 0.01;
              g.position.y = (1 - v) * 6;
            }}
          >
            <Ex lift={4}>
              <Clickable sel={{ kind: 'component', id: 'dimm', label: 'Memory module (DIMM)' }}>
                <group position={[SX + 6 + i * 1.1, 0, 0]}>
                  <Baked parts={dimm} />
                </group>
              </Clickable>
            </Ex>
          </Anim>
        ))}
        {/* cooler */}
        <Anim
          f={(g) => {
            const v = smooth(clamp((pp('board') - 0.45) / 0.55));
            g.visible = v > 0.01;
            g.position.y = (1 - v) * 10;
          }}
        >
          <Ex lift={8}>
            <Clickable sel={{ kind: 'component', id: 'cooler', label: 'CPU cooler (heat pipes, fins, fan)' }}>
              <Baked parts={cooler} />
            </Clickable>
          </Ex>
        </Anim>
      </Anim>
      {/* tower case */}
      <Anim
        f={(g) => {
          const v = prog('system');
          g.visible = v > 0.01;
          g.scale.setScalar(lerp(0.9, 1, v));
        }}
      >
        <Clickable sel={{ kind: 'component', id: 'case', label: 'Computer case' }}>
          <Baked parts={tower} />
        </Clickable>
      </Anim>
    </group>
  );
}

/* ================================================================ GPU */

const HBM_POS: [number, number][] = [
  [-1.85, -1.2],
  [-1.85, 1.2],
  [1.85, -1.2],
  [1.85, 1.2],
];

/** GPU substrate detail: stiffener ring, decoupling rows, BGA ball field underneath. */
function buildGpuSubstrate(k: Kit) {
  for (const s of [-1, 1]) {
    k.box(MAT.steel, [5.8, 0.12, 0.35], [0, 0.23, s * 2.475]);
    k.box(MAT.steel, [0.3, 0.12, 4.6], [s * 2.75, 0.23, 0]);
    for (let i = 0; i < 17; i++) smd(k, -2.0 + i * 0.25, 0.17, s * 2.15, Math.PI / 2);
    for (let i = 0; i < 12; i++) smd(k, s * 2.5, 0.17, -1.65 + i * 0.3);
  }
  for (let i = 0; i < 22; i++) for (let j = 0; j < 20; j++) k.cyl(MAT.solder, 0.07, 0.27, [-2.75 + (i * 5.5) / 21, -0.105, -2.5 + (j * 5) / 19], O, 6, NC);
}

/** HBM stack (stack-local x/z, package y): logic base die, eight DRAM layers with bond lines, top die. */
function buildHbm(k: Kit) {
  k.box(MAT.seam, [0.98, 0.03, 1.18], [0, 0.255, 0], O, NC);
  k.box(MAT.si, [0.9, 0.06, 1.1], [0, 0.28, 0]);
  for (let i = 0; i < 8; i++) {
    const y = 0.31 + i * 0.05;
    k.box(MAT.seam, [0.88, 0.006, 1.08], [0, y + 0.003, 0], O, NC);
    k.box(MAT.hbm, [0.9, 0.044, 1.1], [0, y + 0.028, 0]);
  }
  k.box(MAT.si, [0.9, 0.04, 1.1], [0, 0.73, 0]);
}

/** Card PCB detail (card-local): edge-finger tab, bracket, backplate, power input, passives. */
function buildCardPcb(k: Kit) {
  k.box(MAT.pcb, [8, 0.16, 0.3], [-4, 0, 5.65]);
  for (let i = 0; i < 40; i++) {
    const x = -7.9 + i * 0.2;
    if (Math.abs(x + 6.84) < 0.12) continue;
    for (const s of [-1, 1]) k.box(MAT.gold, [0.13, 0.004, 0.36], [x, s * 0.082, 5.6], O, NC);
  }
  k.box(MAT.seam, [0.2, 0.17, 0.3], [-6.84, 0, 5.66], O, NC);
  // I/O bracket with vents and a port cage, mounting tab
  k.box(MAT.steel, [0.08, 4.4, 11.6], [-13.1, 1.9, 0]);
  for (let i = 0; i < 7; i++) k.box(MAT.seam, [0.01, 0.28, 4.6], [-13.145, 0.6 + i * 0.48, 2.6], O, NC);
  for (const z of [-2.0, -4.0]) {
    k.box(MAT.steelDark, [0.4, 1.0, 1.7], [-13.25, 1.2, z]);
    k.box(MAT.seam, [0.01, 0.75, 1.4], [-13.452, 1.2, z], O, NC);
  }
  k.box(MAT.steel, [0.9, 4.4, 0.08], [-13.5, 1.9, -5.84]);
  // backplate
  k.rbox(MAT.aluDark, [25.0, 0.14, 10.6], 0.08, [0, -0.16, 0]);
  for (let i = 0; i < 12; i++) k.box(MAT.seam, [0.25, 0.005, 6.0], [4.2 + i * 0.6, -0.232, -0.5], O, NC);
  for (const [x, z] of [[-1.9, -1.9], [1.9, -1.9], [-1.9, 1.9], [1.9, 1.9]] as const) k.cyl(MAT.steelDark, 0.16, 0.04, [x, -0.25, z], O, 10, NC);
  k.label('model', 'AX-100', 'ACCELERATOR · 96 GB HBM', 4.0, 1.0, [-6.0, -0.2315, 0], [Math.PI / 2, 0, 0]);
  // 16-pin power input at the tail end
  k.rbox(MAT.socket, [0.9, 0.9, 2.2], 0.05, [12.45, 0.53, -2.5]);
  for (let i = 0; i < 6; i++) for (const y of [0.35, 0.7]) k.box(MAT.seam, [0.004, 0.26, 0.26], [12.902, y, -3.35 + i * 0.34], O, NC);
  k.box(MAT.socket, [0.6, 0.12, 0.6], [12.45, 1.04, -2.5]);
  // passives around the package and the power stage
  for (let i = 0; i < 16; i++) for (const s of [-1, 1]) smd(k, -3.0 + i * 0.4, 0.08, s * 3.2, Math.PI / 2);
  for (let i = 0; i < 12; i++) for (const s of [-1, 1]) smd(k, s * 3.6, 0.08, -2.4 + i * 0.44);
  for (let i = 0; i < 10; i++) {
    k.box(MAT.chip, [0.35, 0.18, 0.25], [5.0 + i * 0.75, 0.17, 1.2], O, NC);
    k.box(MAT.ceramic, [0.06, 0.181, 0.25], [4.86 + i * 0.75, 0.17, 1.2], O, NC);
  }
  const r = rng(23);
  for (let i = 0; i < 90; i++) smd(k, -12 + r() * 24, 0.08, -5 + r() * 10, r() < 0.5 ? 0 : Math.PI / 2, r() < 0.4 ? MAT.chip : MAT.ceramic);
}

/** Card power delivery (Clickable VRM): chokes, power stages, polymer caps, controller. */
function buildCardVrm(k: Kit) {
  for (let i = 0; i < 12; i++) {
    const x = 6 + (i % 6) * 1.1;
    const z = -3 + Math.floor(i / 6) * 1.2;
    k.rbox(MAT.ferrite, [0.8, 0.45, 0.8], 0.05, [x, 0.305, z]);
    k.box(MAT.steelDark, [0.44, 0.004, 0.28], [x, 0.532, z], O, NC);
    k.box(MAT.chip, [0.5, 0.08, 0.42], [x, 0.12, i < 6 ? -4.05 : -0.85], O, NC);
  }
  for (let i = 0; i < 6; i++) {
    k.cyl(MAT.alu, 0.28, 0.66, [6 + i * 1.1, 0.41, 2.4], O, 14);
    k.cyl(MAT.cap, 0.282, 0.09, [6 + i * 1.1, 0.7, 2.4], O, 14, NC);
  }
  k.box(MAT.chip, [0.7, 0.08, 0.7], [4.6, 0.12, -2.4], O, NC);
}

/** Card cooler (card-local): vapour chamber and pedestal, 40 fins, heat pipes, shroud with fan throats, stators. */
function buildCardCooler(k: Kit) {
  k.rbox(MAT.copper, [24.5, 0.25, 9.8], 0.06, [0, 1.2, 0]);
  k.box(MAT.copper, [2.5, 0.46, 3.1], [0, 0.845, 0]);
  for (let i = 0; i < 40; i++) k.box(MAT.fin, [0.06, 2.075, 10], [-12 + i * 0.6, 2.3625, 0]);
  for (const [y, z] of [[1.75, -3.6], [2.75, -1.2], [1.75, 1.2], [2.75, 3.6]] as const) {
    k.cyl(MAT.copper, 0.28, 24.2, [-0.3, y, z], [0, 0, Math.PI / 2], 12);
    for (const x of [-12.4, 11.8]) k.cyl(MAT.nickel, 0.29, 0.06, [x, y, z], [0, 0, Math.PI / 2], 12, NC);
  }
  const sh = holedPlate(26, 11, 0.5, [[-7, 0, 3.35], [0, 0, 3.35], [7, 0, 3.35]], 0.6);
  k.add(MAT.shroud, sh, [0, 3.7, 0], [-Math.PI / 2, 0, 0]);
  sh.dispose();
  for (const s of [-1, 1]) {
    k.box(KM.paintAccent, [25.2, 0.1, 0.02], [0, 3.86, s * 5.505], O, NC);
    k.box(MAT.shroud, [0.6, 0.4, 10.4], [s * 12.95, 3.2, 0], [0, 0, s * 0.5]);
  }
  k.label('model', 'AX-100', 'PASSIVE + 3 × 90 mm', 2.2, 0.55, [-11.75, 4.003, 0], [-Math.PI / 2, 0, 0]);
  for (const x of [-7, 0, 7]) {
    k.torus(MAT.fan, 3.35, 0.1, [x, 3.98, 0], O, 40, NC);
    k.cyl(MAT.fan, 1.0, 0.2, [x, 3.5, 0], O, 24, NC);
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      k.box(MAT.fan, [2.35, 0.1, 0.14], [x + Math.cos(a) * 2.2, 3.5, Math.sin(a) * 2.2], [0, -a, 0], NC);
    }
  }
}

/** One fan rotor in its spinning group (origin 4.05 above the card): nine blades in the throat. */
function buildCardRotor(k: Kit) {
  k.at([0, -0.32, 0], [-Math.PI / 2, 0, 0], () => {
    rotor(k, 1.05, 3.2, 0.34, MAT.fanBlade, 9, MAT.fan);
    k.cyl(MAT.fanBlade, 0.95, 0.02, [0, 0, 0.2], [Math.PI / 2, 0, 0], 24, NC);
    k.torus(KM.paintAccent, 0.75, 0.03, [0, 0, 0.21], [Math.PI / 2, 0, 0], 24, { cast: false });
  });
}

/** A complete installed card for the chassis (static). */
function buildCardAssembly(k: Kit) {
  k.box(MAT.pcb, [26, 0.16, 11], O);
  buildCardPcb(k);
  buildCardVrm(k);
  buildCardCooler(k);
  for (const x of [-7, 0, 7]) k.at([x, 4.05, 0], 0, () => buildCardRotor(k));
}

/**
 * GPU server (6U, lid off, service side lowered): front fan wall and drive cage, dual-socket board,
 * vertical PCIe switch board carrying four accelerators, card retention rail, rear PSUs and I/O.
 */
const CARDS = [-12, -4, 4, 12];

function buildServer(k: Kit) {
  const cards = CARDS;
  const X0 = -22;
  const X1 = 22;
  const Z0 = -45;
  const Z1 = 25;
  const FY = -5.5;
  const TOP = 22.2;
  const zc = (Z0 + Z1) / 2;
  const L = Z1 - Z0;
  const wallH = TOP - (FY - 0.3);
  // tub: floor, far wall with slide rail, low service-side wall, front bulkhead, rack ears
  k.box(MAT.steel, [44, 0.3, L], [0, FY - 0.15, zc]);
  for (const x of [-19, 19]) for (const z of [Z0 + 2.5, Z1 - 2.5]) k.rbox(KM.rubber, [3, 0.7, 2.4], 0.2, [x, FY - 0.65, z]);
  k.box(MAT.caseMat, [0.25, wallH, L], [X0 + 0.125, FY - 0.3 + wallH / 2, zc]);
  for (const y of [0, 7, 14]) k.box(MAT.caseMat, [0.15, 0.6, L - 2], [X0 + 0.32, y, zc], O, NC);
  k.box(MAT.steel, [0.4, 1.8, L - 4], [X0 - 0.2, 8, zc]);
  for (let i = 0; i < 6; i++) k.cyl(MAT.steelDark, 0.2, 0.1, [X0 - 0.42, 8, Z0 + 6 + i * 11.5], [0, 0, Math.PI / 2], 8, NC);
  k.box(MAT.caseMat, [0.25, 3.5, L], [X1 - 0.125, FY - 0.3 + 1.75, zc]);
  k.box(MAT.caseMat, [1.2, 0.2, L], [X1 - 0.6, FY + 3.1, zc]);
  k.label('model', 'GX-8', 'ACCELERATED SERVER · 6U', 4.0, 1.0, [X1 + 0.003, FY + 1.5, 12], [0, Math.PI / 2, 0]);
  k.label('warn', 'HEAVY', '', 1.2, 1.2, [X1 + 0.003, FY + 1.5, 6], [0, Math.PI / 2, 0]);
  k.box(MAT.caseMat, [44, wallH, 0.3], [0, FY - 0.3 + wallH / 2, Z0 + 0.15]);
  for (const s of [-1, 1]) {
    k.box(MAT.steel, [2.2, wallH, 0.25], [s * 23.1, FY - 0.3 + wallH / 2, Z0 - 0.1]);
    k.tube(MAT.steelDark, [[s * 23.2, 4, Z0 - 0.25], [s * 23.2, 4.6, Z0 - 2.4], [s * 23.2, 11.4, Z0 - 2.4], [s * 23.2, 12, Z0 - 0.25]], 0.3, { radial: 10 });
  }
  // front fan wall: two rows of six hot-swap 80 mm modules
  for (let r = 0; r < 2; r++)
    for (let i = 0; i < 6; i++) {
      const x = -18.3 + i * 7.32;
      const y = FY + 3.5 + r * 7.0;
      k.at([x, y, -40.5], 0, () => {
        k.rbox(KM.plastic, [7.0, 6.9, 3.9], 0.25, [0, 0, -0.05]);
        axialFan(k, 6.6, 3.0);
        k.rbox(KM.rubber, [2.2, 0.5, 1.0], 0.2, [0, 3.6, -1.0]);
        k.box(KM.ledGreen, [0.3, 0.12, 0.05], [2.6, 3.0, 1.93], O, NC);
      });
    }
  for (const y of [FY + 0.1, FY + 7.0, FY + 13.9]) k.box(MAT.steel, [43.4, 0.25, 4.4], [0, y, -40.5]);
  // drive cage above the fans: NVMe backplane facing the board, cable bundles
  k.box(MAT.steel, [43.4, 13.4, 7.0], [0, 15.4, -41.5]);
  k.box(MAT.pcb, [42.0, 11.6, 0.16], [0, 15.4, -37.92]);
  for (let i = 0; i < 12; i++) {
    k.box(MAT.socket, [1.8, 0.9, 0.8], [-18.7 + i * 3.4, 11.6, -37.44]);
    k.box(KM.ledGreen, [0.2, 0.2, 0.02], [-18.7 + i * 3.4, 20.4, -37.83], O, NC);
  }
  // dual-socket board with passive heatsinks and memory
  const BZ = -24;
  k.box(MAT.pcb, [40, 0.16, 27], [0, FY + 0.6, BZ]);
  for (const x of [-18.5, 18.5]) for (const z of [-36, -12]) k.cyl(MAT.brass, 0.25, 0.5, [x, FY + 0.25, z], O, 8, NC);
  for (const cx of [-9.5, 9.5]) {
    k.rbox(MAT.copper, [8.6, 0.4, 10], 0.05, [cx, FY + 0.9, BZ]);
    for (let i = 0; i < 34; i++) k.box(MAT.fin, [0.08, 4.6, 10], [cx - 4.15 + i * 0.25, FY + 3.4, BZ]);
    for (const dz of [-3.5, 0, 3.5]) k.cyl(MAT.copper, 0.3, 8.8, [cx, FY + 1.5, BZ + dz], [0, 0, Math.PI / 2], 12, NC);
    for (const [dx, dz] of [[-3.9, -4.6], [3.9, -4.6], [-3.9, 4.6], [3.9, 4.6]] as const) k.cyl(MAT.steelDark, 0.3, 0.6, [cx + dx, FY + 5.9, BZ + dz], O, 10, NC);
    for (const side of [-1, 1])
      for (let j = 0; j < 4; j++) {
        const x = cx + side * (5.0 + j * 0.8);
        k.box(MAT.socket, [0.55, 0.7, 14], [x, FY + 1.03, BZ]);
        k.box(MAT.dimm, [0.15, 3.1, 13.3], [x, FY + 2.5, BZ]);
        for (let c = 0; c < 8; c++) for (const s of [-1, 1]) k.box(MAT.chip, [0.1, 0.9, 1.1], [x + s * 0.125, FY + 2.6, BZ - 5.6 + c * 1.6], O, NC);
      }
    for (let i = 0; i < 6; i++) k.rbox(MAT.ferrite, [0.8, 0.45, 0.8], 0.05, [cx - 3.0 + i * 1.2, FY + 0.9, BZ - 6.6]);
  }
  for (const x of [-6, 6]) {
    k.rbox(MAT.aluDark, [3.6, 0.5, 3.6], 0.08, [x, FY + 0.93, -13.5]);
    for (let i = 0; i < 8; i++) k.box(MAT.aluDark, [0.15, 1.2, 3.6], [x - 1.6 + i * 0.46, FY + 1.75, -13.5], O, NC);
  }
  k.box(MAT.chip, [1.6, 0.12, 1.6], [0, FY + 0.74, -33]);
  k.label('model', 'GX-8 MB', 'DUAL SOCKET · 16 × DDR5', 3.6, 0.9, [0, FY + 0.69, -14.0], [-Math.PI / 2, 0, 0]);
  // board-to-switch cables between the cards
  for (const x of [-6.0, 2.1, 10.1])
    for (const s of [-1, 1]) k.pipe(KM.plastic, [[x + s * 0.25, FY + 0.95, -11.5], [x + s * 0.25, FY + 0.95, 4.0], [x + s * 0.25, 6.4, 5.8]], 0.2, 1.5);
  // vertical PCIe switch board with x16 slots facing the cards, switch heatsinks behind
  k.box(MAT.pcb, [40, 11.5, 0.16], [0, 12.25, 6.58]);
  for (const x of cards) {
    k.box(MAT.socket, [0.85, 9.2, 0.85], [x, 12.05, 6.075]);
    k.box(MAT.seam, [0.25, 8.9, 0.004], [x, 12.05, 5.648], O, NC);
    k.rbox(MAT.plasticGrey, [0.85, 0.5, 0.9], 0.06, [x, 7.2, 6.05]);
  }
  for (const x of [-6, 2.1, 10.1]) k.box(MAT.socket, [1.6, 0.8, 1.0], [x, 7.0, 6.0]);
  for (const x of [-8, 8]) {
    k.rbox(MAT.aluDark, [5, 4, 0.4], 0.08, [x, 12.5, 6.9]);
    for (let i = 0; i < 9; i++) k.box(MAT.aluDark, [0.15, 4, 1.2], [x - 2.2 + i * 0.55, 12.5, 7.6], O, NC);
  }
  for (const x of [-20.9, 20.9]) k.box(MAT.steel, [0.6, TOP - FY, 0.8], [x, (TOP + FY) / 2, 6.6]);
  // card retention rail with thumbscrews over the brackets
  k.box(MAT.steel, [42.6, 0.8, 1.6], [0, 21.6, -4.2]);
  k.box(MAT.steel, [0.6, TOP - FY, 0.6], [20.9, (TOP + FY) / 2, -4.2]);
  for (const x of cards) {
    k.cyl(MAT.steel, 0.4, 0.6, [x + 1.9, 22.3, -4.2], O, 14);
    k.cyl(MAT.seam, 0.15, 0.01, [x + 1.9, 22.605, -4.2], O, 8, NC);
  }
  // the installed accelerators (the animated card fills the remaining slot)
  for (const x of cards.filter((x) => x !== -4)) k.at([x, 8, 0], [0, 0, -Math.PI / 2], () => buildCardAssembly(k));
  // rear: four PSUs, I/O row, perforated exhaust panel
  for (let i = 0; i < 4; i++) {
    const x = -15.3 + i * 10.2;
    k.rbox(MAT.steel, [9.5, 3.9, 17.5], 0.1, [x, FY + 1.95, 16.1]);
    for (let j = 0; j < 10; j++) k.box(MAT.seam, [7.0, 0.005, 0.25], [x, FY + 3.902, 9.2 + j * 0.5], O, NC);
    k.label('tag', 'PSU · 3000 W', '200–240 VAC · HOT SWAP', 4.0, 1.0, [x, FY + 3.905, 19.5], [-Math.PI / 2, 0, 0]);
    k.at([x - 2.4, FY + 1.95, 24.6], 0, () => axialFan(k, 3.4, 0.5));
    k.box(MAT.seam, [2.2, 1.4, 0.05], [x + 2.4, FY + 1.95, 24.86], O, NC);
    k.box(KM.ledGreen, [0.3, 0.3, 0.05], [x + 2.4, FY + 3.2, 24.87], O, NC);
    k.tube(MAT.steelDark, [[x - 1.2, FY + 3.2, 24.85], [x - 1.2, FY + 3.2, 25.9], [x + 1.2, FY + 3.2, 25.9], [x + 1.2, FY + 3.2, 24.85]], 0.15, { radial: 8, cast: false });
  }
  k.box(MAT.caseMat, [44, TOP - (FY + 4.0), 0.3], [0, (TOP + FY + 4.0) / 2, Z1 - 0.15]);
  decal(k, perfMat('#6a706c', 40 / 0.6, 15 / 0.6), 40, 15, [0, 13.4, Z1 + 0.005]);
  for (const x of [-16, -13.5, 13.5, 16]) {
    k.box(MAT.steel, [1.9, 1.0, 4.5], [x, FY + 5.0, Z1 - 2.0]);
    k.box(MAT.seam, [1.5, 0.6, 0.02], [x, FY + 5.0, Z1 + 0.26], O, NC);
  }
  for (const x of [-9, -7.4]) k.box(MAT.seam, [1.3, 1.1, 0.02], [x, FY + 5.0, Z1 + 0.01], O, NC);
  k.box(KM.paintBlue, [1.6, 0.6, 0.02], [-4.5, FY + 5.0, Z1 + 0.01], O, NC);
  k.box(MAT.steel, [43.4, 0.6, 1.2], [0, TOP - 0.3, Z1 - 0.6]);
  k.ao(44, L, [0, -6.5, zc], 1.12);
}

function Gpu() {
  const dieMats = useMemo(() => [MAT.si, MAT.si, new THREE.MeshStandardMaterial({ map: dieFloorplan('gpu'), roughness: 0.3, metalness: 0.35 }), MAT.si, MAT.si, MAT.si], []);
  const cardMats = useMemo(() => {
    const top = new THREE.MeshStandardMaterial({ map: cardTexture(), roughness: 0.55, metalness: 0.1 });
    return [MAT.pcb, MAT.pcb, top, MAT.pcbDark, MAT.pcb, MAT.pcb];
  }, []);
  const fan = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (fan.current) fan.current.children.forEach((c) => (c.rotation.y += dt * (pp('board') > 0.6 ? 12 : 0)));
  });
  const substrate = useCm(buildGpuSubstrate);
  const hbm = useCm(buildHbm);
  const pcb = useCm(buildCardPcb);
  const vrm = useCm(buildCardVrm);
  const cooler = useCm(buildCardCooler);
  const rotorParts = useCm(buildCardRotor);
  const chassis = useCm(buildServer);
  return (
    <group>
      <Anim
        f={(g) => {
          const s = prog('socket');
          g.position.set(0, lerp(0, 0.32, s), 0);
          track('focus', 0, g.position.y, 0);
        }}
      >
        <Ex lift={3}>
          <Box s={[2.6, 0.08, 3.2]} p={[0, 0.25, 0]} m={dieMats} sel={{ id: 'pkg-die', label: 'GPU die (generic)' }} />
        </Ex>
        <Anim
          f={(g) => {
            const v = prog('package');
            g.visible = v > 0.01;
            g.position.y = (1 - v) * -2;
          }}
        >
          <Clickable sel={{ kind: 'component', id: 'pkg-substrate', label: 'Package substrate' }}>
            <mesh geometry={GEO.box} material={MAT.pcbDark} scale={[6, 0.14, 5.5]} position={[0, 0.1, 0]} castShadow receiveShadow />
            <Baked parts={substrate} />
          </Clickable>
          <Box s={[4.8, 0.08, 4]} p={[0, 0.2, 0]} m={MAT.si} sel={{ id: 'interposer', label: 'Silicon interposer' }} />
          {HBM_POS.map(([x, z], i) => (
            <Ex key={i} lift={3}>
              <Clickable sel={{ kind: 'component', id: 'hbm', label: 'HBM stack' }}>
                <group position={[x, 0, z]}>
                  <Baked parts={hbm} />
                </group>
              </Clickable>
            </Ex>
          ))}
        </Anim>
      </Anim>
      {/* graphics card */}
      <Anim
        f={(g) => {
          const v = prog('socket');
          g.visible = v > 0.01;
          g.position.y = (1 - v) * -5;
          const sy = prog('system');
          g.rotation.z = lerp(0, -Math.PI / 2, sy);
          g.position.x = lerp(0, -4, sy);
          g.position.y += lerp(0, 8, sy);
        }}
      >
        <Ex lift={-3}>
          <Clickable sel={{ kind: 'component', id: 'gpu-card', label: 'Accelerator card PCB' }}>
            <mesh geometry={GEO.box} material={cardMats} scale={[26, 0.16, 11]} castShadow receiveShadow />
            <Baked parts={pcb} />
          </Clickable>
        </Ex>
        <Clickable sel={{ kind: 'component', id: 'vrm', label: 'Power delivery (VRM)' }}>
          <Baked parts={vrm} />
        </Clickable>
        <Anim
          f={(g) => {
            const v = smooth(clamp((pp('board') - 0.3) / 0.7));
            g.visible = v > 0.01;
            g.position.y = (1 - v) * 8;
          }}
        >
          <Ex lift={6}>
            <Clickable sel={{ kind: 'component', id: 'cooler', label: 'Heatsink, vapour chamber & fans' }}>
              <Baked parts={cooler} />
              <group ref={fan}>
                {[-7, 0, 7].map((x) => (
                  <group key={x} position={[x, 4.05, 0]}>
                    <Baked parts={rotorParts} />
                  </group>
                ))}
              </group>
            </Clickable>
          </Ex>
        </Anim>
      </Anim>
      {/* server chassis with further accelerator cards */}
      <Anim
        f={(g) => {
          const v = prog('system');
          g.visible = v > 0.01;
          g.position.y = (1 - v) * -4;
        }}
      >
        <Clickable sel={{ kind: 'component', id: 'case', label: 'Server chassis (accelerated computing)' }}>
          <Baked parts={chassis} />
        </Clickable>
      </Anim>
    </group>
  );
}

export default function SystemScene() {
  const journey = useParam('journey');
  return (
    <>
      <Lighting env="office" shadowExtent={40} fogScale={8} />
      <mesh rotation-x={-Math.PI / 2} position={[0, -6.5, 0]} receiveShadow>
        <planeGeometry args={[400, 400]} />
        <meshStandardMaterial color="#2a312c" roughness={0.8} />
      </mesh>
      {journey === 1 ? <Gpu /> : <Cpu />}
      <pointLight position={[0, 30, 10]} intensity={900} distance={120} decay={2} color="#f2f5ee" />
      <TechLabel
        position={[-14, 16, 8]}
        title={journey === 1 ? 'GPU JOURNEY · ACCELERATED COMPUTING' : 'CPU JOURNEY · DESKTOP COMPUTER'}
        lines={['generic, educational layouts — not a specific product']}
        min={1}
        value={() => engine.player.view.phase.label}
      />
    </>
  );
}
