'use client';
/**
 * Ingot → wafers (§13, §14): cropping, OD grinding, X-ray orientation + notch, and
 * multi-wire slicing. The same block is followed through every machine; slicing is
 * shown as a real geometric transformation (the block below the wire plane becomes
 * discrete wafers separated by kerf gaps), not a fade.
 *
 * Equipment is built with the detailing kit: static parts (and the rigid moving
 * assemblies) are merged into one mesh per finish, so the finished models stay cheap.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, Hall } from '../environments';
import { M, effectiveView } from '../materials';
import { GEO } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { waferGeometry, WAFER_T } from '../parts/wafer';
import { useUI } from '@/lib/store';
import { engine } from '@/simulation/engine';
import { pp, pdt, inPhase } from '@/lib/anim';
import { track, cutPlane } from '@/lib/runtime';
import { czRadiusAt, CZ_SEGMENTS, CZ_TOTAL, CZ_BODY_R } from '@/simulation/models';
import { smooth, clamp } from '@/lib/math';
import { Kit, cabinet, bellows, grille, windowPane, hmi, estop, ledStrip, type BakedPart, type V3 } from '../kit/build';
import { KM } from '../kit/finish';
import { Baked, useKit } from '../kit/Baked';

const X = { crop: -8, grind: 0, saw: 9 };
const AXIS_Y = 1.15; // ingot axis height on the machines
const CROWN = CZ_SEGMENTS.neck + CZ_SEGMENTS.crown; // seed → start of body
const BODY = CZ_SEGMENTS.body;
const BLOCK = 0.36; // block that goes to the saw (m)
const R_GROUND = 0.15;

const rough = new THREE.MeshStandardMaterial({ color: '#767c84', roughness: 0.45, metalness: 0.85 });
const ground = new THREE.MeshStandardMaterial({ color: '#8c939b', roughness: 0.3, metalness: 0.88 });
const asCut = new THREE.MeshStandardMaterial({ color: '#70757b', roughness: 0.8, metalness: 0.45 });
const laser = new THREE.MeshBasicMaterial({ color: '#ff4a3a', transparent: true, opacity: 0.8, toneMapped: false });
const coolant = new THREE.MeshBasicMaterial({ color: '#d7e8de', transparent: true, opacity: 0.6 });
const wireMat = new THREE.MeshStandardMaterial({ color: '#c9c3b6', roughness: 0.3, metalness: 0.9 });

function lathePart(s0: number, s1: number) {
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, 0)];
  const n = 40;
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    pts.push(new THREE.Vector2(Math.max(0.001, czRadiusAt(s)), s - s0));
  }
  pts.push(new THREE.Vector2(0, s1 - s0));
  const g = new THREE.LatheGeometry(pts, 48);
  g.rotateZ(-Math.PI / 2); // axis along +x, s grows with x
  return g;
}

/* ------------------------------------------------------------ kit helpers */

/**
 * Kit build + a folding pass so a finished model costs only a few draw calls:
 *  · every opaque, non-emissive finish (powder coat, stainless, anodised, rubber…) is
 *    merged into ONE mesh whose vertices carry the finish's colour, roughness,
 *    metalness, micro-surface map (paint / brushed) and bump strength;
 *  · every label plate of the model is packed into one canvas atlas.
 * Glass, LEDs, screens and contact shadows keep their own (shared) materials.
 */
function useModel(fn: (k: Kit) => void, deps: unknown[] = []): BakedPart[] {
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

type Std = THREE.MeshStandardMaterial;
const isStd = (m: THREE.Material): m is Std => (m as Std).isMeshStandardMaterial === true;
const foldable = (m: THREE.Material) => isStd(m) && !(m as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial && !m.transparent && !m.map && m.toneMapped && m.emissive.getHex() === 0 && !m.vertexColors;
const isLabel = (m: THREE.Material) => isStd(m) && m.map?.image instanceof HTMLCanvasElement && m.polygonOffset && !m.transparent;

let _fold: Std | null = null;
/** One shader for all folded finishes: per-vertex colour + (roughness, metalness, map mode, bump). */
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

/** Pack label plates into one canvas atlas (one draw call for all of a model's plates). */
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

const RX: V3 = [0, 0, Math.PI / 2]; // cylinder axis → X
const RZ: V3 = [Math.PI / 2, 0, 0]; // cylinder axis → Z

/** Finned motor along local +Y from its mounting face at y = 0 (cowl and terminal box). */
function motor(k: Kit, r: number, len: number, body: THREE.Material = KM.paintGraphite, metal: THREE.Material = KM.stainless) {
  k.cyl(metal, r * 0.78, 0.022, [0, 0.011, 0], [0, 0, 0], 24);
  const bl = len * 0.74;
  k.cyl(body, r, bl, [0, 0.022 + bl / 2, 0], [0, 0, 0], 28);
  const n = 14;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    k.box(body, [0.007, bl * 0.84, r * 0.2], [Math.cos(a) * r * 1.07, 0.022 + bl / 2, Math.sin(a) * r * 1.07], [0, Math.PI / 2 - a, 0]);
  }
  const cl = len - bl - 0.022;
  k.cyl(body, r * 1.02, cl, [0, 0.022 + bl + cl / 2, 0], [0, 0, 0], 28);
  k.cyl(KM.seam, r * 0.72, 0.004, [0, len + 0.002, 0], [0, 0, 0], 24);
  k.rbox(body, [r * 0.8, bl * 0.34, r * 0.8], 0.008, [r * 1.18, 0.022 + bl * 0.45, 0]);
}

/** Handwheel in the local XZ plane (axis +Y), with spokes and a crank knob. */
function handwheel(k: Kit, R: number, m: THREE.Material = KM.anodizedDark) {
  k.torus(m, R, R * 0.11, [0, 0, 0], [0, 0, 0], 28);
  k.cyl(m, R * 0.25, R * 0.4, [0, 0, 0], [0, 0, 0], 16);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    k.box(m, [R * 0.9, R * 0.08, R * 0.12], [Math.cos(a) * R * 0.5, 0, Math.sin(a) * R * 0.5], [0, -a, 0]);
  }
  k.cyl(KM.paintGraphite, R * 0.1, R * 0.6, [R, R * 0.3, 0], [0, 0, 0], 10);
}

/** Safety light-curtain post (receiver/emitter column) facing local +X. */
function lightCurtain(k: Kit, h: number) {
  k.box(KM.paintGraphite, [0.12, 0.012, 0.12], [0, 0.006, 0]);
  k.rbox(KM.paintYellow, [0.045, h, 0.045], 0.008, [0, h / 2 + 0.012, 0]);
  k.box(KM.seam, [0.004, h * 0.86, 0.022], [0.0235, h / 2 + 0.012, 0]);
  k.box(KM.ledAmber, [0.006, 0.03, 0.012], [0.02, h - 0.02, 0]);
}

/** Hose / cable sagging between two points: a light tube (few segments) instead of the kit's dense catenary. */
function line(k: Kit, a: V3, b: V3, r = 0.012, sag = 0.12, m: THREE.Material = KM.rubber, segs = 14) {
  const mid = new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - sag * 2, (a[2] + b[2]) / 2);
  const g = new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(new THREE.Vector3(...a), mid, new THREE.Vector3(...b)), segs, r, 6, false);
  k.add(m, g, [0, 0, 0], [0, 0, 0], [1, 1, 1], { cast: r > 0.012 });
  g.dispose();
}

/** Hex bolt heads on a circle in the YZ plane (heads facing ±X), centred at c. */
function boltRingX(k: Kit, c: V3, R: number, n: number, r = 0.008, m: THREE.Material = KM.stainlessDark, a0 = 0) {
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2;
    k.cyl(m, r, r * 0.9, [c[0], c[1] + Math.cos(a) * R, c[2] + Math.sin(a) * R], RX, 6, { cast: false });
  }
}

/** Hex bolt heads on a circle in the XY plane (heads facing ±Z), centred at c. */
function boltRingZ(k: Kit, c: V3, R: number, n: number, r = 0.008, m: THREE.Material = KM.stainlessDark, a0 = 0) {
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2;
    k.cyl(m, r, r * 0.9, [c[0] + Math.cos(a) * R, c[1] + Math.sin(a) * R, c[2]], RZ, 6, { cast: false });
  }
}

/** Ball knob (turned) of radius r centred at pos. */
function knob(k: Kit, m: THREE.Material, r: number, pos: V3) {
  const prof: [number, number][] = [];
  for (let i = 0; i <= 8; i++) {
    const a = -Math.PI / 2 + (i / 8) * Math.PI;
    prof.push([Math.max(0.0005, Math.cos(a) * r), Math.sin(a) * r]);
  }
  k.lathe(m, prof, pos, [0, 0, 0], 12);
}

/** Bolted access cover on a face pointing +Z (face at pos[2]): seam outline, raised plate, corner screws. */
function coverPlate(k: Kit, w: number, h: number, pos: V3, m: THREE.Material = KM.paint) {
  k.box(KM.seam, [w + 0.008, h + 0.008, 0.002], [pos[0], pos[1], pos[2] + 0.001], [0, 0, 0], { cast: false });
  k.rbox(m, [w, h, 0.008], 0.003, [pos[0], pos[1], pos[2] + 0.005], [0, 0, 0], { cast: false });
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.cyl(KM.stainlessDark, 0.005, 0.004, [pos[0] + sx * (w / 2 - 0.016), pos[1] + sy * (h / 2 - 0.016), pos[2] + 0.0105], RZ, 8, { cast: false });
}

/** Facility connection panel facing local +Z: plate, bulkhead fittings, tagged lines. */
function utilityPanel(k: Kit, pos: V3, yaw: number, lines: [string, string][]) {
  k.at(pos, yaw, () => {
    const w = 0.09 * lines.length + 0.04;
    k.rbox(KM.stainlessDark, [w, 0.2, 0.012], 0.004, [0, 0, 0.006]);
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.cyl(KM.stainless, 0.005, 0.004, [sx * (w / 2 - 0.014), sy * 0.086, 0.013], RZ, 8, { cast: false });
    lines.forEach(([t, c], i) => {
      const x = -w / 2 + 0.065 + i * 0.09;
      k.cyl(KM.stainless, 0.017, 0.012, [x, 0.03, 0.018], RZ, 6);
      k.cyl(KM.stainless, 0.009, 0.05, [x, 0.03, 0.045], RZ, 10);
      k.cyl(KM.stainlessDark, 0.012, 0.012, [x, 0.03, 0.064], RZ, 6);
      k.label('gas', t, '', 0.078, 0.022, [x, -0.05, 0.0125], [0, 0, 0], c);
    });
  });
}

/* ------------------------------------------------------------ cropping */

/** Cropping saw bed: V-block rests, scrap totes at both ends, traverse spine, guard screen, HMI. */
function buildCropSaw(k: Kit) {
  const TOP = 0.777; // worktable surface
  cabinet(k, { size: [2.1, 0.72, 1.1], panels: 3, rows: [], sidePanels: 1, stripe: KM.paintAccent, ao: false });
  k.rbox(KM.paintGrey, [2.14, 0.035, 1.14], 0.008, [0, TOP - 0.0175, 0]);
  for (const z of [-0.44, -0.27, 0.27, 0.44]) k.box(KM.seam, [2.08, 0.002, 0.014], [0, TOP + 0.0005, z], [0, 0, 0], { cast: false });
  k.label('model', 'CS-1900', 'INGOT CROPPING BAND SAW', 0.42, 0.1, [0.25, 0.56, 0.552]);
  estop(k, [-0.86, 0.55, 0.55]);
  // V-block rests with polyurethane pads, one per block between the cut planes
  const vb: [number, number][] = [[-0.17, TOP], [0.17, TOP], [0.17, 1.04], [0.127, 1.04], [0, 0.913], [-0.127, 1.04], [-0.17, 1.04]];
  for (const x of [-0.44, 0.01, 0.46]) {
    k.extrude(KM.paintGrey, vb, 0.12, [x - 0.06, 0, 0], [0, Math.PI / 2, 0], { bevel: 0.004 });
    for (const s of [-1, 1]) {
      k.box(KM.rubber, [0.13, 0.012, 0.16], [x, 0.9807, s * 0.0593], [-s * Math.PI / 4, 0, 0]);
      k.cyl(KM.stainlessDark, 0.012, 0.01, [x - 0.03, 1.046, s * 0.15], [0, 0, 0], 6);
      k.cyl(KM.stainlessDark, 0.012, 0.01, [x + 0.03, 1.046, s * 0.15], [0, 0, 0], 6);
    }
    k.box(KM.paintGraphite, [0.16, 0.02, 0.36], [x, TOP + 0.01, 0]);
  }
  // scrap totes for crown and tail
  for (const s of [-1, 1])
    k.at([s * 1.4, 0, 0], 0, () => {
      k.rbox(KM.paintGraphite, [0.62, 0.3, 0.92], 0.012, [0, 0.15, 0]);
      k.box(KM.paintGrey, [0.6, 0.012, 0.86], [0, 0.306, 0]);
      k.box(KM.paintGrey, [0.6, 0.44, 0.012], [0, 0.52, -0.43]);
      k.box(KM.paintGrey, [0.6, 0.3, 0.012], [0, 0.45, 0.43]);
      for (const e of [-1, 1]) k.box(KM.paintGrey, [0.012, 0.44, 0.86], [e * 0.3, 0.52, 0]);
      for (const x of [-0.15, 0.15]) k.box(KM.paintGrey, [0.02, 0.26, 0.014], [x, 0.44, 0.437]);
      k.cyl(KM.stainless, 0.009, 0.6, [0, 0.6, 0.43], RX, 10);
      k.cyl(KM.stainless, 0.009, 0.6, [0, 0.74, -0.43], RX, 10);
      for (const e of [-1, 1]) k.cyl(KM.stainless, 0.009, 0.86, [e * 0.3, 0.74, 0], RZ, 10);
      for (const e of [-1, 1]) k.cyl(KM.rubber, 0.035, 0.03, [e * 0.22, 0.035, 0.36], RX, 16);
    });
  k.label('info', 'Si SCRAP', 'CROWN · TAIL → RECYCLE', 0.3, 0.075, [-1.4, 0.42, 0.438]);
  // traverse spine behind the bed: the saw column runs in its sealed slot
  k.box(KM.paintGraphite, [3.44, 0.06, 0.22], [0, 0.03, -0.88]);
  k.rbox(KM.paint, [3.5, 0.89, 0.28], 0.02, [0, 0.505, -0.88]);
  k.box(KM.seam, [3.44, 0.004, 0.17], [0, 0.951, -0.88], [0, 0, 0], { cast: false });
  for (const s of [-1, 1]) k.box(KM.rubber, [3.44, 0.012, 0.014], [0, 0.955, -0.88 + s * 0.08]);
  for (let i = 1; i < 5; i++) k.box(KM.seam, [0.004, 0.84, 0.002], [-1.75 + i * 0.7, 0.5, -0.739], [0, 0, 0], { cast: false });
  ledStrip(k, 0.5, [1.1, 0.88, -0.738]);
  // cable carrier lying on the spine
  for (let i = 0; i < 26; i++) k.rbox(KM.plastic, [0.055, 0.045, 0.07], 0.008, [-1.6 + i * 0.06, 0.98, -0.99]);
  // polycarbonate guard screen
  for (let i = 0; i <= 4; i++) k.rbox(KM.anodizedDark, [0.05, 2.2, 0.05], 0.008, [-1.75 + i * 0.875, 1.1, -1.12]);
  for (let i = 0; i < 4; i++) windowPane(k, 0.8, 1.05, [-1.3125 + i * 0.875, 1.55, -1.12], { frame: KM.anodizedDark, glass: KM.glass });
  k.box(KM.anodizedDark, [3.55, 0.05, 0.06], [0, 2.18, -1.12]);
  // light curtains on the loading side
  for (const s of [-1, 1]) k.at([s * 1.8, 0, 0.55], s > 0 ? Math.PI : 0, () => lightCurtain(k, 1.55));
  // HMI pedestal at the right front corner
  const yaw = -0.35;
  const hp: V3 = [2.0, 1.42, 0.86];
  hmi(k, hp, yaw);
  const ax = hp[0] + 0.22 * Math.sin(yaw);
  const az = hp[2] - 0.22 * Math.cos(yaw);
  k.cyl(KM.anodizedDark, 0.03, 1.42, [ax, 0.71, az], [0, 0, 0], 16);
  k.cyl(KM.paintGraphite, 0.16, 0.02, [ax, 0.01, az], [0, 0, 0], 24);
  estop(k, [ax - 0.05, 1.12, az + 0.03]);
  k.ao(3.6, 1.35, [0, 0, -0.2], 1.15);
}

/** Saw head (moves with the blade group): band-wheel housing, blade loop, guides, column ram. */
function buildSawHead(k: Kit) {
  const CUT = 0.19; // cutting run height (local)
  const zc = 0.55;
  const yc = 0.62;
  const R = 0.29;
  // vertical ram (runs down into the spine slot) with linear guide strips
  k.rbox(KM.paint, [0.16, 2.15, 0.14], 0.02, [0, -0.125, -0.88]);
  for (const s of [-1, 1]) k.box(KM.stainless, [0.008, 2.1, 0.03], [s * 0.084, -0.125, -0.88]);
  k.rbox(KM.paintGraphite, [0.2, 0.62, 0.16], 0.02, [0, yc, -0.8]);
  // band-wheel housing (stadium) with hubs and latches
  const st: [number, number][] = [];
  for (let i = 0; i <= 14; i++) {
    const a = -Math.PI / 2 + (i / 14) * Math.PI;
    st.push([zc + Math.cos(a) * R, yc + Math.sin(a) * R]);
  }
  for (let i = 0; i <= 14; i++) {
    const a = Math.PI / 2 + (i / 14) * Math.PI;
    st.push([-zc + Math.cos(a) * R, yc + Math.sin(a) * R]);
  }
  k.extrude(KM.paint, st, 0.15, [-0.075, 0, 0], [0, Math.PI / 2, 0], { bevel: 0.012 });
  for (const z of [-zc, zc])
    for (const sx of [-1, 1]) {
      k.cyl(KM.stainless, 0.075, 0.016, [sx * 0.094, yc, z], RX, 28);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        k.cyl(KM.paintGraphite, 0.008, 0.012, [sx * 0.104, yc + Math.cos(a) * 0.052, z + Math.sin(a) * 0.052], RX, 6);
      }
    }
  for (const z of [-0.2, 0.2]) k.rbox(KM.stainless, [0.02, 0.05, 0.07], 0.006, [0.093, 0.86, z]);
  for (const y of [0.5, 0.74]) k.cyl(KM.stainless, 0.012, 0.07, [0.094, y, -0.79], [0, 0, 0], 12);
  k.cyl(KM.stainless, 0.034, 0.012, [0.092, 0.74, 0.74], RX, 24);
  k.cyl(KM.plasticWhite, 0.028, 0.004, [0.1, 0.74, 0.74], RX, 24, { cast: false });
  k.box(KM.paintRed, [0.002, 0.022, 0.003], [0.1025, 0.746, 0.742], [0.5, 0, 0], { cast: false });
  k.box(KM.seam, [0.003, 0.004, 1.06], [0.089, 0.79, 0], [0, 0, 0], { cast: false });
  k.label('warn', 'BLADE', '', 0.1, 0.1, [0.0895, 0.5, 0.32], [0, Math.PI / 2, 0]);
  k.label('model', 'BS-450', 'BAND SAW HEAD · 450 mm WHEELS', 0.3, 0.075, [0.0895, 0.67, -0.2], [0, Math.PI / 2, 0]);
  // blade: cutting run between the guides, sloped runs up to the wheels
  k.box(KM.stainless, [0.003, 0.03, 0.74], [0, CUT, 0]);
  k.box(KM.seam, [0.0034, 0.006, 0.74], [0, CUT - 0.016, 0], [0, 0, 0], { cast: false });
  const dz = 0.19;
  const dy = 0.14;
  const ang = Math.atan2(dy, dz);
  for (const s of [-1, 1]) {
    k.box(KM.stainless, [0.003, 0.03, Math.hypot(dz, dy)], [0, CUT + dy / 2, s * (0.36 + dz / 2)], [-s * ang, 0, 0]);
    // guide arm + carbide guide block, coolant nozzle
    k.rbox(KM.paintGraphite, [0.08, 0.2, 0.07], 0.01, [0, 0.33, s * 0.39]);
    k.rbox(KM.paintGraphite, [0.07, 0.06, 0.08], 0.008, [0, 0.21, s * 0.36]);
    k.tube(KM.stainless, [[0.045, 0.36, s * 0.41], [0.05, 0.28, s * 0.37], [0.03, 0.235, s * 0.31]], 0.006, { radial: 6 });
    // blade guard over the sloped run
    k.rbox(KM.paintYellow, [0.11, 0.1, 0.17], 0.015, [0, 0.3, s * 0.48]);
  }
  // blade-tension handwheel at the front end
  k.cyl(KM.stainless, 0.018, 0.06, [0, yc, 0.87], RZ, 12);
  k.at([0, yc, 0.9], [Math.PI / 2, 0, 0], () => handwheel(k, 0.07, KM.paintGraphite));
  // drive motor on the rear wheel
  k.at([-0.087, yc, -zc], [0, 0, Math.PI / 2], () => motor(k, 0.09, 0.26));
  line(k, [-0.2, 0.74, -0.62], [-0.07, 0.42, -0.85], 0.012, 0.06, KM.paintGraphite);
}

function CropStation() {
  const cx = X.crop;
  const crownGeo = useMemo(() => lathePart(0, CROWN), []);
  const tailGeo = useMemo(() => lathePart(CROWN + BODY, CZ_TOTAL), []);
  const blade = useRef<THREE.Group>(null);
  const crown = useRef<THREE.Mesh>(null);
  const tail = useRef<THREE.Mesh>(null);
  const blocks = useRef<(THREE.Mesh | null)[]>([]);
  const x0 = cx - CZ_TOTAL / 2; // seed end
  const cutA = x0 + CROWN;
  const cutB = x0 + CROWN + BODY;
  const blockCuts = [cutA + BODY / 3, cutA + (2 * BODY) / 3];
  useFrame(() => {
    const active = engine.stage.id === 'ingot-shaping';
    const top = active ? pp('crop-top') : 1;
    const tl = active ? pp('crop-tail') : 1;
    const sec = active ? pp('section') : 1;
    // blade position: sweeps down at the active cut
    let bx = cutA;
    let depth = 0;
    if (active && inPhase('crop-top')) {
      bx = cutA;
      depth = top;
    } else if (active && inPhase('crop-tail')) {
      bx = cutB;
      depth = tl;
    } else if (active && inPhase('section')) {
      const k = sec < 0.5 ? 0 : 1;
      bx = blockCuts[k];
      depth = (sec * 2) % 1;
    }
    if (blade.current) {
      blade.current.position.x = bx;
      blade.current.position.y = AXIS_Y + 0.55 - depth * 1.1;
    }
    if (crown.current) {
      crown.current.position.set(x0 - smooth(clamp((top - 0.85) / 0.15)) * 0.5, AXIS_Y - smooth(clamp((top - 0.9) / 0.1)) * 0.6, 0);
      crown.current.visible = engine.stage.id === 'ingot-shaping' || engine.stage.id === 'ingot';
    }
    if (tail.current) {
      tail.current.position.set(cutB + smooth(clamp((tl - 0.85) / 0.15)) * 0.5, AXIS_Y - smooth(clamp((tl - 0.9) / 0.1)) * 0.6, 0);
      tail.current.visible = crown.current?.visible ?? true;
    }
    blocks.current.forEach((m, i) => {
      if (!m) return;
      const spread = smooth(clamp(sec * 2 - (i === 0 ? 0 : 1))) * 0.12;
      m.position.x = cutA + (i * BODY) / 3 + BODY / 6 + (i - 1) * spread;
      m.visible = active || engine.stage.id === 'ingot';
    });
    if (active) track('focus', cx, AXIS_Y, 0);
  });
  const bed = useModel(buildCropSaw);
  const head = useModel(buildSawHead);
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'ingot-grinder', label: 'Cropping band saw' }}>
        <group position={[cx, 0, 0]}>
          <Baked parts={bed} />
        </group>
        <group ref={blade}>
          <Baked parts={head} />
        </group>
      </Clickable>
      <mesh ref={crown} geometry={crownGeo} material={rough} castShadow />
      <mesh ref={tail} geometry={tailGeo} material={rough} castShadow />
      {[0, 1, 2].map((i) => (
        <mesh key={i} ref={(m) => { blocks.current[i] = m; }} position={[0, AXIS_Y, 0]} rotation={[0, 0, Math.PI / 2]} material={rough} castShadow>
          <cylinderGeometry args={[CZ_BODY_R, CZ_BODY_R, BODY / 3 - 0.004, 56]} />
        </mesh>
      ))}
      <TechLabel position={[cx - 1.2, AXIS_Y + 0.4, 0]} title="CROWN (SEED CONE) · RECYCLED" min={2} />
      <TechLabel position={[cx + 1.3, AXIS_Y + 0.4, 0]} title="TAIL · RECYCLED" min={2} />
      <TechLabel position={[cx, AXIS_Y + 0.65, 0.3]} title="BODY → 3 BLOCKS · BLOCK B FOLLOWED" min={2} tone="accent" />
    </group>
  );
}

/* ------------------------------------------------------------ OD grinding + notch */

const HEAD_X = BLOCK / 2 + 0.3; // headstock / tailstock centres (±)

/** Grinder base: machine bed, work table, wheelhead cross-slide, coolant trough, guard enclosure. */
function buildGrinderBase(k: Kit) {
  const TOP = 0.882;
  k.at([0, 0, -0.1], 0, () => cabinet(k, { size: [2.4, 0.8, 1.3], panels: 3, rows: [0.36], sidePanels: 2, handles: true, stripe: KM.paintAccent, ao: false }));
  // work table carrying headstock and tailstock
  k.rbox(KM.paintGrey, [2.1, 0.06, 0.6], 0.01, [0, TOP - 0.03, -0.12]);
  for (const z of [-0.36, 0.12]) k.box(KM.stainless, [2.0, 0.012, 0.03], [0, TOP + 0.003, z]);
  // coolant trough under the ingot
  k.rbox(KM.stainless, [0.6, 0.03, 0.44], 0.006, [0, TOP + 0.012, 0]);
  k.box(KM.seam, [0.54, 0.004, 0.38], [0, TOP + 0.0275, 0], [0, 0, 0], { cast: false });
  // wheelhead cross-slide with rails and bellows way covers outside the saddle travel
  k.rbox(KM.paintGrey, [1.8, 0.04, 0.3], 0.008, [0, 0.842, 0.4]);
  for (const z of [0.3, 0.5]) k.box(KM.stainless, [1.7, 0.012, 0.02], [0, 0.868, z]);
  for (const [x0, x1] of [[-0.88, -0.69], [0.13, 0.88]] as const) {
    const n = Math.round((x1 - x0) / 0.026);
    for (let i = 0; i <= n; i++) k.box(i % 2 ? KM.paintGraphite : KM.plastic, [0.012, 0.05, 0.26], [x0 + i * 0.026, 0.887, 0.4]);
  }
  // guard enclosure: back panel with a window, glazed end panels, open top frame
  const EB = 0.822;
  const ET = 2.25;
  const bz = -0.72;
  k.box(KM.paint, [2.4, 0.38, 0.04], [0, EB + 0.19, bz]);
  k.box(KM.paint, [2.4, 0.22, 0.04], [0, ET - 0.11, bz]);
  for (const s of [-1, 1]) k.box(KM.paint, [0.45, ET - EB - 0.6, 0.04], [s * 0.975, (EB + 0.38 + ET - 0.22) / 2, bz]);
  windowPane(k, 1.5, ET - EB - 0.6, [0, (EB + 0.38 + ET - 0.22) / 2, bz], { frame: KM.anodizedDark, glass: KM.glass });
  k.box(KM.paintAccent, [2.4, 0.02, 0.004], [0, ET - 0.06, bz + 0.022], [0, 0, 0], { cast: false });
  for (const s of [-1, 1]) {
    k.box(KM.paint, [0.04, 0.32, 1.12], [s * 1.2, EB + 0.16, -0.16]);
    k.at([s * 1.2, 0, -0.16], [0, s * Math.PI / 2, 0], () => windowPane(k, 1.0, 0.98, [0, EB + 0.32 + 0.52, 0], { frame: KM.anodizedDark, glass: KM.glass }));
    for (const z of [bz, 0.4]) k.rbox(KM.anodizedDark, [0.05, ET - EB, 0.05], 0.008, [s * 1.2, (EB + ET) / 2, z]);
    k.box(KM.anodizedDark, [0.05, 0.05, 1.17], [s * 1.2, ET, -0.16]);
  }
  k.box(KM.anodizedDark, [2.45, 0.05, 0.05], [0, ET, 0.4]);
  k.box(KM.anodizedDark, [2.45, 0.05, 0.05], [0, ET, bz]);
  k.box(KM.anodizedDark, [0.1, 0.02, 0.2], [1.0, ET + 0.035, -0.62]);
  k.label('warn', 'ROTATING', '', 0.11, 0.11, [1.222, 1.0, 0.1], [0, Math.PI / 2, 0]);
  // nameplate, controls
  k.label('model', 'CG-300', 'OD & NOTCH GRINDER · 300 mm', 0.42, 0.1, [0.0, 0.72, 0.552]);
  estop(k, [-0.95, 0.72, 0.55]);
  const yaw = -0.45;
  const hp: V3 = [1.55, 1.48, 0.7];
  hmi(k, hp, yaw);
  const ax = hp[0] + 0.22 * Math.sin(yaw);
  const az = hp[2] - 0.22 * Math.cos(yaw);
  k.cyl(KM.anodizedDark, 0.03, 1.48, [ax, 0.74, az], [0, 0, 0], 16);
  k.cyl(KM.paintGraphite, 0.16, 0.02, [ax, 0.01, az], [0, 0, 0], 24);
  // coolant unit with pump and filter at the left end
  k.at([-1.62, 0, -0.25], 0, () => {
    cabinet(k, { size: [0.6, 0.62, 0.8], panels: 1, rows: [], stripe: false, vent: true, bolts: false, ao: false });
    k.at([0.08, 0.642, 0.1], 0, () => motor(k, 0.07, 0.2, KM.paintBlue));
    k.cyl(KM.stainless, 0.07, 0.24, [-0.14, 0.76, -0.15], [0, 0, 0], 24);
    k.cyl(KM.paintGraphite, 0.075, 0.03, [-0.14, 0.895, -0.15], [0, 0, 0], 24);
  });
  k.pipe(KM.stainless, [[-1.76, 0.88, -0.4], [-1.76, 1.05, -0.4], [-1.25, 1.05, -0.4], [-0.33, 1.05, -0.4], [-0.33, 0.93, -0.2]], 0.016, 0.06);
  line(k, [-1.5, 0.88, -0.6], [-1.23, 0.5, -0.76], 0.02, 0.08, KM.rubber);
  // facility connections and main disconnect on the service side
  utilityPanel(k, [1.2, 0.46, -0.32], Math.PI / 2, [['CDA', '#4a6a8a'], ['COOLANT', '#3e7d4c'], ['DRAIN', '#5a5f66']]);
  k.rbox(KM.paintGrey, [0.014, 0.16, 0.12], 0.004, [1.207, 0.6, 0.2]);
  k.rbox(KM.paintYellow, [0.006, 0.1, 0.1], 0.004, [1.216, 0.6, 0.2]);
  k.rbox(KM.paintRed, [0.03, 0.022, 0.08], 0.006, [1.228, 0.6, 0.2], [0.6, 0, 0]);
  k.ao(2.6, 1.35, [0, 0, -0.1], 1.2);
  k.ao(0.6, 0.8, [-1.62, 0, -0.25]);
}

/** Headstock (drive) and tailstock (quill, handwheel) that clamp the block between pads. */
function buildSpindles(k: Kit) {
  const TOP = 0.882;
  const YAW_X: V3 = [0, Math.PI / 2, 0]; // extrude along +X (profile u → −z)
  const clamp4 = (x: number) => {
    for (const sx of [-1, 1])
      for (const z of [-0.15, 0.15]) {
        k.rbox(KM.stainlessDark, [0.05, 0.02, 0.05], 0.004, [x + sx * 0.235, TOP + 0.01, z]);
        k.cyl(KM.stainless, 0.012, 0.014, [x + sx * 0.235, TOP + 0.027, z], [0, 0, 0], 6);
      }
  };
  /* headstock: ribbed casting with a spindle-nose boss, bolted covers, belt guard, motor on a riser */
  const hx = -HEAD_X;
  k.rbox(KM.paintGraphite, [0.42, 0.03, 0.5], 0.006, [hx, TOP + 0.015, 0]);
  k.rbox(KM.paint, [0.36, 0.05, 0.5], 0.012, [hx, TOP + 0.055, 0]);
  k.rbox(KM.paint, [0.36, 0.45, 0.42], 0.045, [hx, TOP + 0.08 + 0.225, 0]);
  for (const s of [-1, 1])
    for (const x of [hx - 0.12, hx, hx + 0.12]) {
      const tri: [number, number][] = s > 0 ? [[-0.2, 0], [-0.248, 0], [-0.2, 0.1]] : [[0.2, 0], [0.248, 0], [0.2, 0.1]];
      k.extrude(KM.paint, tri, 0.016, [x - 0.008, TOP + 0.08, 0], YAW_X, { bevel: 0.002 });
    }
  for (const x of [hx - 0.11, hx, hx + 0.11]) k.rbox(KM.paint, [0.024, 0.34, 0.02], 0.006, [x, TOP + 0.3, -0.214]);
  k.box(KM.seam, [0.362, 0.004, 0.422], [hx, TOP + 0.395, 0], [0, 0, 0], { cast: false });
  // spindle nose: boss, bolt ring, labyrinth seal
  k.cyl(KM.paint, 0.135, 0.014, [hx + 0.186, AXIS_Y, 0], RX, 40);
  boltRingX(k, [hx + 0.195, AXIS_Y, 0], 0.122, 8, 0.0075, KM.stainlessDark, Math.PI / 8);
  k.torus(KM.seam, 0.112, 0.003, [hx + 0.194, AXIS_Y, 0], [-Math.PI / 2, Math.PI / 2, 0], 40, { cast: false });
  // operator-side cover with the work-head plate, oil sight glass
  coverPlate(k, 0.24, 0.2, [hx, TOP + 0.31, 0.21]);
  k.label('model', 'WH-300', 'WORK HEAD · 0–60 rpm', 0.18, 0.045, [hx, TOP + 0.35, 0.2201]);
  k.label('warn', 'PINCH', '', 0.05, 0.05, [hx - 0.06, TOP + 0.265, 0.2201]);
  k.cyl(KM.stainless, 0.017, 0.008, [hx + 0.12, TOP + 0.15, 0.212], RZ, 16);
  k.cyl(KM.brass, 0.011, 0.004, [hx + 0.12, TOP + 0.15, 0.216], RZ, 16, { cast: false });
  k.cyl(KM.stainlessDark, 0.007, 0.012, [hx - 0.12, TOP + 0.13, 0.214], RZ, 6);
  // belt guard on the far end: louvres and screws
  k.rbox(KM.paint, [0.06, 0.42, 0.38], 0.02, [hx - 0.21, TOP + 0.26, 0]);
  k.at([hx - 0.241, TOP + 0.26, 0], [0, -Math.PI / 2, 0], () => {
    grille(k, 0.24, 0.12, [0, 0.06, 0], { m: KM.paint, pitch: 0.02 });
    for (const [x, y] of [[-0.16, -0.18], [0.16, -0.18], [-0.16, 0.18], [0.16, 0.18]]) k.cyl(KM.stainlessDark, 0.006, 0.004, [x, y, 0.002], RZ, 8, { cast: false });
  });
  // drive motor on a riser plate, conduit to the bed
  k.rbox(KM.paintGraphite, [0.3, 0.014, 0.17], 0.004, [hx, TOP + 0.537, -0.04]);
  for (const x of [hx - 0.1, hx + 0.1]) k.box(KM.paintGraphite, [0.04, 0.03, 0.16], [x, TOP + 0.555, -0.04]);
  k.at([hx - 0.12, 1.5, -0.04], [0, 0, -Math.PI / 2], () => motor(k, 0.075, 0.28));
  line(k, [hx - 0.22, 1.47, -0.1], [hx - 0.1, 0.9, -0.235], 0.011, 0.05, KM.paintGraphite);
  // faceplate and drive dogs
  k.cyl(KM.stainless, 0.11, 0.025, [-0.2875, AXIS_Y, 0], RX, 36);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    k.box(KM.paintGraphite, [0.03, 0.03, 0.02], [-0.262, AXIS_Y + Math.cos(a) * 0.08, Math.sin(a) * 0.08], [a, 0, 0]);
  }
  boltRingX(k, [-0.273, AXIS_Y, 0], 0.055, 6, 0.006, KM.stainlessDark, Math.PI / 6);
  k.cyl(KM.chrome, 0.04, 0.09, [-0.23, AXIS_Y, 0], RX, 24);
  k.cyl(KM.paintGraphite, 0.07, 0.008, [-0.184, AXIS_Y, 0], RX, 32);
  clamp4(hx);

  /* tailstock: base casting, web and quill barrel, lock lever, scale, hydraulic cylinder */
  const tx = HEAD_X;
  k.rbox(KM.paintGraphite, [0.4, 0.03, 0.44], 0.006, [tx, TOP + 0.015, 0]);
  k.rbox(KM.paint, [0.36, 0.1, 0.42], 0.02, [tx, TOP + 0.08, 0]);
  k.extrude(KM.paint, [[-0.19, 0], [0.19, 0], [0.085, 0.15], [-0.085, 0.15]], 0.3, [tx - 0.15, TOP + 0.118, 0], YAW_X, { bevel: 0.006 });
  k.cyl(KM.paint, 0.12, 0.32, [tx, AXIS_Y, 0], RX, 40);
  k.cyl(KM.paintGraphite, 0.126, 0.016, [tx - 0.154, AXIS_Y, 0], RX, 40);
  k.cyl(KM.paint, 0.105, 0.02, [tx + 0.17, AXIS_Y, 0], RX, 32);
  boltRingX(k, [tx + 0.182, AXIS_Y, 0], 0.088, 6, 0.0065);
  k.label('model', 'TS-300', 'TAILSTOCK · HYDRAULIC QUILL', 0.22, 0.05, [tx, TOP + 0.08, 0.2101]);
  // quill
  k.cyl(KM.paint, 0.075, 0.05, [0.3, AXIS_Y, 0], RX, 28);
  k.torus(KM.rubber, 0.075, 0.005, [0.276, AXIS_Y, 0], [-Math.PI / 2, Math.PI / 2, 0], 28);
  k.cyl(KM.chrome, 0.045, 0.1, [0.24, AXIS_Y, 0], RX, 24);
  k.cyl(KM.paintGraphite, 0.07, 0.008, [0.184, AXIS_Y, 0], RX, 32);
  k.cyl(KM.chrome, 0.016, 0.07, [tx + 0.2, AXIS_Y, 0], RX, 12);
  k.at([tx + 0.235, AXIS_Y, 0], [0, 0, -Math.PI / 2], () => handwheel(k, 0.08));
  // quill lock lever
  k.cyl(KM.paint, 0.026, 0.04, [tx - 0.06, AXIS_Y + 0.125, 0], [0, 0, 0], 16);
  k.cyl(KM.stainlessDark, 0.014, 0.02, [tx - 0.06, AXIS_Y + 0.15, 0], [0, 0, 0], 6);
  k.rbox(KM.paintGraphite, [0.014, 0.012, 0.13], 0.004, [tx - 0.06, AXIS_Y + 0.158, 0.06], [-0.22, 0, 0]);
  knob(k, KM.paintRed, 0.016, [tx - 0.06, AXIS_Y + 0.175, 0.125]);
  // quill position scale on a milled land
  k.box(KM.paint, [0.22, 0.05, 0.012], [tx + 0.02, AXIS_Y, 0.118]);
  k.box(KM.ptfe, [0.2, 0.016, 0.002], [tx + 0.02, AXIS_Y + 0.008, 0.1251], [0, 0, 0], { cast: false });
  for (let i = 0; i <= 10; i++) k.box(KM.seam, [0.0014, i % 5 ? 0.007 : 0.012, 0.001], [tx - 0.08 + i * 0.02, AXIS_Y + 0.012 - (i % 5 ? 0.0025 : 0), 0.1262], [0, 0, 0], { cast: false });
  // hydraulic quill cylinder behind the barrel, bracket and hoses
  k.cyl(KM.stainless, 0.034, 0.2, [tx + 0.05, 1.22, -0.22], RX, 20);
  for (const x of [tx - 0.055, tx + 0.155]) k.rbox(KM.paintGraphite, [0.022, 0.08, 0.08], 0.006, [x, 1.22, -0.22]);
  for (const x of [tx - 0.055, tx + 0.155]) for (const [y, z] of [[1.25, -0.25], [1.25, -0.19], [1.19, -0.25], [1.19, -0.19]]) k.cyl(KM.chrome, 0.004, 0.024, [x, y, z], RX, 6, { cast: false });
  k.cyl(KM.chrome, 0.012, 0.11, [tx - 0.12, 1.22, -0.22], RX, 12);
  k.rbox(KM.paintGraphite, [0.03, 0.05, 0.16], 0.006, [tx - 0.17, 1.21, -0.15]);
  k.rbox(KM.paint, [0.05, 0.17, 0.06], 0.008, [tx + 0.12, TOP + 0.215, -0.19]);
  line(k, [tx - 0.03, 1.255, -0.22], [tx + 0.09, 0.92, -0.38], 0.008, 0.05, KM.rubber);
  line(k, [tx + 0.13, 1.255, -0.22], [tx + 0.17, 0.92, -0.38], 0.008, 0.04, KM.rubber);
  for (const x of [tx - 0.03, tx + 0.13]) k.cyl(KM.brass, 0.01, 0.02, [x, 1.256, -0.22], [0, 0, 0], 6);
  clamp4(tx);
}

/** Laser micrometer: emitter above, receiver below, C-yoke behind the block. */
function buildGauge(k: Kit) {
  // emitter and receiver heads: housings with dark end caps, beam windows, cable glands
  for (const [y, h] of [[AXIS_Y + 0.285, 0.07], [0.93, 0.05]] as const) {
    k.rbox(KM.paint, [0.1, h, 0.12], 0.01, [0, y, 0]);
    for (const s of [-1, 1]) k.rbox(KM.anodizedDark, [0.012, h + 0.006, 0.124], 0.004, [s * 0.052, y, 0]);
    k.cyl(KM.paintGraphite, 0.011, 0.025, [0, y, -0.07], RZ, 10);
  }
  k.box(KM.paintDark, [0.07, 0.004, 0.03], [0, AXIS_Y + 0.249, 0], [0, 0, 0], { cast: false });
  k.box(KM.paintDark, [0.07, 0.004, 0.03], [0, 0.9555, 0], [0, 0, 0], { cast: false });
  k.label('tag', 'LM-300', 'LASER Ø GAUGE', 0.07, 0.02, [-0.01, AXIS_Y + 0.285, 0.0605]);
  k.box(KM.ledGreen, [0.012, 0.012, 0.004], [0.034, AXIS_Y + 0.285, 0.061], [0, 0, 0], { cast: false });
  // C-yoke: post on a foot plate, arms to both heads
  k.rbox(KM.paintGraphite, [0.1, 0.012, 0.1], 0.004, [0, 0.888, -0.26]);
  for (const [x, z] of [[-0.035, -0.295], [0.035, -0.295], [-0.035, -0.225], [0.035, -0.225]]) k.cyl(KM.stainlessDark, 0.006, 0.008, [x, 0.898, z], [0, 0, 0], 6, { cast: false });
  k.rbox(KM.paint, [0.05, 0.62, 0.05], 0.01, [0, 1.2, -0.26]);
  k.rbox(KM.paint, [0.05, 0.04, 0.3], 0.01, [0, AXIS_Y + 0.31, -0.13]);
  k.rbox(KM.paint, [0.05, 0.035, 0.3], 0.01, [0, 0.925, -0.13]);
  k.rbox(KM.paintGraphite, [0.06, 0.03, 0.06], 0.006, [0, 1.515, -0.26]);
}

/** Diamond wheel (rotates as a whole): steel core, resin-bond rim, clamp flange, bolts. */
function buildWheel(k: Kit) {
  k.cyl(M.graphite, 0.25, 0.042, [0, 0, 0], RX, 64);
  k.cyl(KM.stainless, 0.236, 0.048, [0, 0, 0], RX, 64);
  k.cyl(KM.stainlessDark, 0.09, 0.07, [0, 0, 0], RX, 32);
  k.cyl(KM.stainlessDark, 0.035, 0.1, [0, 0, 0], RX, 16);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.cyl(KM.stainless, 0.009, 0.08, [0, Math.cos(a) * 0.065, Math.sin(a) * 0.065], RX, 6);
    k.cyl(M.graphite, 0.02, 0.05, [0, Math.cos(a + 0.5) * 0.17, Math.sin(a + 0.5) * 0.17], RX, 12);
  }
}

/** Wheelhead (follows the wheel's traverse, does not spin): saddle, spindle, motor, hood, coolant nozzle. */
function buildWheelhead(k: Kit) {
  // spindle housing and motor sit on the far (−x) side so the contact zone stays in view
  k.rbox(KM.paint, [0.42, 0.17, 0.3], 0.02, [-0.28, -0.195, 0.02]);
  coverPlate(k, 0.3, 0.11, [-0.3, -0.195, 0.17]);
  k.label('model', 'GS-500', 'WHEEL SPINDLE · 3.7 kW', 0.17, 0.042, [-0.3, -0.19, 0.1802]);
  k.cyl(KM.brass, 0.006, 0.02, [-0.12, -0.105, 0.1], [0, 0, 0], 6, { cast: false });
  k.rbox(KM.paintGraphite, [0.46, 0.02, 0.32], 0.006, [-0.28, -0.27, 0.02]);
  for (const x of [-0.515, -0.045]) k.box(KM.rubber, [0.014, 0.014, 0.3], [x, -0.272, 0.02]);
  k.rbox(KM.paint, [0.2, 0.06, 0.15], 0.015, [-0.15, -0.085, 0]);
  k.cyl(KM.paint, 0.08, 0.2, [-0.15, 0, 0], RX, 32);
  k.cyl(KM.stainless, 0.084, 0.016, [-0.055, 0, 0], RX, 32);
  k.at([-0.25, 0, 0], [0, 0, Math.PI / 2], () => motor(k, 0.085, 0.24));
  // hood over the top of the wheel (open towards the work)
  k.add(KM.paint, new THREE.CylinderGeometry(0.285, 0.285, 0.085, 36, 1, false, -2.618, 1.92), [0, 0, 0], [0, 0, -Math.PI / 2]);
  k.label('warn', 'WHEEL', '', 0.07, 0.07, [0.044, 0.2, 0.06], [0, Math.PI / 2, 0]);
  for (const t of [-2.35, -1.9, -1.35, -0.95]) k.cyl(KM.stainlessDark, 0.006, 0.006, [0.045, -0.265 * Math.sin(t), 0.265 * Math.cos(t)], RX, 6, { cast: false });
  // coolant nozzle aimed at the contact line
  k.tube(KM.stainless, [[0.0, 0.29, -0.04], [0.0, 0.34, -0.14], [0.0, 0.315, -0.215]], 0.008, { radial: 8 });
  k.rbox(KM.stainless, [0.08, 0.02, 0.03], 0.005, [0, 0.302, -0.23]);
  k.cyl(KM.paintGraphite, 0.014, 0.03, [0, 0.33, -0.1], [0.9, 0, 0], 10);
}

/** X-ray orientation unit: tube head on a goniometer sector, flat-panel detector, Z-slide notch head. */
function buildXray(k: Kit) {
  const DECK = 0.822; // cabinet top inside the guard
  const tc: V3 = [0.1, 1.77, 0.365];
  k.at(tc, [0.7, 0, 0], () => {
    // tube housing: cooling fins, HV receptacle, shutter block, stepped collimator
    k.cyl(KM.paintYellow, 0.085, 0.3, [0, 0, 0], [0, 0, 0], 32);
    for (let i = 0; i < 5; i++) k.torus(KM.paintYellow, 0.088, 0.0055, [0, 0.03 + i * 0.022, 0], [0, 0, 0], 32);
    k.cyl(KM.paintGraphite, 0.09, 0.03, [0, 0.16, 0], [0, 0, 0], 32);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      k.cyl(KM.stainlessDark, 0.006, 0.006, [Math.cos(a) * 0.072, 0.178, Math.sin(a) * 0.072], [0, 0, 0], 6, { cast: false });
    }
    k.cyl(KM.stainless, 0.034, 0.05, [0, 0.2, 0], [0, 0, 0], 20);
    k.cyl(KM.paintGraphite, 0.042, 0.022, [0, 0.232, 0], [0, 0, 0], 6);
    k.torus(KM.paintGraphite, 0.09, 0.009, [0, -0.11, 0], [0, 0, 0], 32);
    k.rbox(KM.paintGraphite, [0.13, 0.05, 0.12], 0.01, [0, -0.165, 0]);
    k.rbox(KM.anodized, [0.03, 0.03, 0.05], 0.006, [0.078, -0.165, 0]);
    k.cyl(KM.stainless, 0.03, 0.03, [0, -0.205, 0], [0, 0, 0], 20);
    k.cyl(KM.stainless, 0.018, 0.05, [0, -0.245, 0], [0, 0, 0], 16);
    k.torus(KM.stainlessDark, 0.019, 0.003, [0, -0.268, 0], [0, 0, 0], 16);
    k.label('warn', 'X-RAY', '', 0.065, 0.065, [0, -0.05, 0.0858]);
  });
  line(k, [0.1, 1.95, 0.48], [0.4, 2.0, -0.6], 0.016, 0.12, KM.paintGraphite);
  // flat-panel detector facing the ingot: housing, bezel, carbon window, fins, handles
  k.at([0.1, 1.62, -0.42], [0.6435, 0, 0], () => {
    k.rbox(KM.paint, [0.26, 0.22, 0.07], 0.014, [0, 0, -0.01]);
    k.rbox(KM.anodizedDark, [0.22, 0.18, 0.012], 0.005, [0, 0, 0.028]);
    k.box(KM.paintDark, [0.17, 0.13, 0.004], [0, 0.005, 0.0335], [0, 0, 0], { cast: false });
    k.box(KM.ledAmber, [0.022, 0.007, 0.003], [0.07, -0.077, 0.0345], [0, 0, 0], { cast: false });
    for (let i = 0; i < 5; i++) k.box(KM.anodizedDark, [0.2, 0.008, 0.03], [0, -0.07 + i * 0.035, -0.06]);
    for (const s of [-1, 1]) k.pipe(KM.anodizedDark, [[s * 0.128, -0.06, -0.02], [s * 0.15, -0.06, -0.02], [s * 0.15, 0.06, -0.02], [s * 0.128, 0.06, -0.02]], 0.006, 0.015);
    k.cyl(KM.paintGraphite, 0.014, 0.03, [0.06, 0.1, -0.04], [0, 0, 0], 10);
  });
  line(k, [0.16, 1.71, -0.43], [0.27, 1.5, -0.5], 0.008, 0.06, KM.paintGraphite);
  // goniometer sector around the ingot axis: machined arc, graduations, end stops
  const t0 = -0.87;
  const t1 = 1.05;
  const prof = [[0.6, 0], [0.64, 0], [0.64, 0.035], [0.6, 0.035], [0.6, 0]].map(([x, y]) => new THREE.Vector2(x, y));
  const sector = new THREE.LatheGeometry(prof, 40, t0 - Math.PI / 2, t1 - t0);
  k.add(KM.stainless, sector, [0.2525, AXIS_Y, 0], [0, 0, -Math.PI / 2]);
  sector.dispose();
  const at = (t: number, r = 0.62): V3 => [0.27, AXIS_Y + r * Math.cos(t), r * Math.sin(t)];
  for (let i = 0; i <= 24; i++) {
    const t = t0 + 0.08 + (i * (t1 - t0 - 0.16)) / 24;
    const p = at(t, i % 4 ? 0.634 : 0.63);
    k.box(KM.seam, [0.001, i % 4 ? 0.01 : 0.018, 0.0025], [0.2884, p[1], p[2]], [t, 0, 0], { cast: false });
  }
  for (const t of [t0, t1]) {
    const p = at(t);
    k.rbox(KM.paintGraphite, [0.05, 0.06, 0.026], 0.006, p, [t, 0, 0]);
  }
  const c1 = at(0.532);
  const c2 = at(-0.73);
  k.rbox(KM.paintGraphite, [0.2, 0.05, 0.07], 0.01, [0.185, c1[1] + 0.03, c1[2] + 0.01]);
  k.rbox(KM.paintGraphite, [0.19, 0.045, 0.06], 0.01, [0.185, c2[1], c2[2]]);
  k.rbox(KM.paintGraphite, [0.06, 0.06, 0.06], 0.008, [0.32, c1[1] + 0.055, c1[2] + 0.01]);
  k.cyl(KM.stainless, 0.02, 0.01, [0.355, c1[1] + 0.055, c1[2] + 0.01], RX, 12);
  for (const c of [[c1[1] + 0.03, c1[2] + 0.04], [c2[1] + 0.005, c2[2] + 0.035]]) knob(k, KM.paintRed, 0.012, [0.24, c[0], c[1]]);
  // columns: base plate with anchors, square tube, cap
  const post = (x: number, z: number, top: number, w = 0.07) => {
    k.rbox(KM.paintGraphite, [0.12, 0.016, 0.12], 0.004, [x, DECK + 0.008, z]);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.cyl(KM.stainlessDark, 0.007, 0.01, [x + sx * 0.045, DECK + 0.021, z + sz * 0.045], [0, 0, 0], 6, { cast: false });
    k.rbox(KM.paint, [w, top - DECK - 0.016, w], 0.012, [x, (DECK + 0.016 + top) / 2, z]);
    k.rbox(KM.paintGraphite, [w + 0.012, 0.014, w + 0.012], 0.004, [x, top + 0.007, z]);
  };
  post(0.27, -0.48, 1.545);
  k.cyl(KM.paintGraphite, 0.026, 0.02, [0.27, 1.569, -0.48], [0, 0, 0], 16);
  k.cyl(KM.ledAmber, 0.02, 0.04, [0.27, 1.599, -0.48], [0, 0, 0], 16);
  k.label('warn', 'RADIATION', '', 0.06, 0.06, [0.27, 1.3, -0.4445]);
  post(-0.2, -0.5, 1.745, 0.08);
  // notch-head Z-slide on the column: rails, bellows cover, carriage, servo
  for (const s of [-1, 1]) k.box(KM.chrome, [0.012, 0.76, 0.01], [-0.2 + s * 0.026, 1.27, -0.455]);
  for (let i = 0; i < 34; i++) k.box(i % 2 ? KM.paintGraphite : KM.plastic, [0.034, 0.012, 0.012], [-0.2, 0.9 + i * 0.02, -0.454]);
  k.rbox(KM.paintGraphite, [0.1, 0.12, 0.05], 0.01, [-0.2, 1.66, -0.44]);
  k.at([-0.2, 1.759, -0.5], 0, () => motor(k, 0.04, 0.12));
  // notch wheel with V-edge, belt guard, motor, coolant jet
  k.at([-0.12, AXIS_Y + R_GROUND + 0.05, 0], [0, 0, -Math.PI / 2], () => {
    k.lathe(M.graphite, [[0.1, -0.012], [0.12, 0], [0.1, 0.012]], [0, 0, 0], [0, 0, 0], 48);
    k.cyl(KM.stainless, 0.1, 0.024, [0, 0, 0], [0, 0, 0], 40);
    k.cyl(KM.stainlessDark, 0.035, 0.05, [0, 0, 0], [0, 0, 0], 16);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      k.cyl(KM.stainless, 0.005, 0.03, [Math.cos(a) * 0.024, 0, Math.sin(a) * 0.024], [0, 0, 0], 6, { cast: false });
    }
  });
  k.rbox(KM.paintYellow, [0.03, 0.36, 0.11], 0.012, [-0.155, AXIS_Y + R_GROUND + 0.2, 0]);
  for (const [y, z] of [[-0.15, -0.035], [-0.15, 0.035], [0.15, -0.035], [0.15, 0.035]]) k.cyl(KM.stainlessDark, 0.005, 0.004, [-0.139, AXIS_Y + R_GROUND + 0.2 + y, z], RX, 8, { cast: false });
  k.at([-0.17, AXIS_Y + R_GROUND + 0.36, 0], [0, 0, Math.PI / 2], () => motor(k, 0.06, 0.18));
  k.rbox(KM.paint, [0.05, 0.05, 0.52], 0.01, [-0.2, AXIS_Y + R_GROUND + 0.36, -0.26]);
  k.tube(KM.stainless, [[-0.14, AXIS_Y + 0.38, 0.06], [-0.115, AXIS_Y + 0.29, 0.085], [-0.105, AXIS_Y + 0.215, 0.07]], 0.005, { radial: 6 });
  line(k, [-0.25, AXIS_Y + 0.56, -0.05], [-0.2, AXIS_Y + 0.6, -0.42], 0.01, 0.05, KM.paintGraphite);
}

function Grinder({ variant }: { variant: string }) {
  const cx = X.grind;
  const block = useRef<THREE.Group>(null);
  const groundPart = useRef<THREE.Mesh>(null);
  const roughPart = useRef<THREE.Mesh>(null);
  const wheel = useRef<THREE.Group>(null);
  const wheelhead = useRef<THREE.Group>(null);
  const laserRef = useRef<THREE.Mesh>(null);
  const xbeam = useRef<THREE.Mesh>(null);
  const notch = useRef<THREE.Mesh>(null);
  const spray = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const ang = useRef(0);
  const L = BLOCK;
  useFrame((_, dt) => {
    const sid = engine.stage.id;
    const grinding = sid === 'ingot-grinding';
    const notching = sid === 'orientation-notch';
    const g = grinding ? pp('grind') : sid === 'orientation-notch' || sid === 'slicing' ? 1 : 0;
    const spin = grinding && inPhase('grind') ? 6 : notching && inPhase('xray') ? 0.8 : notching && inPhase('notch') ? 0 : 0;
    ang.current += pdt(dt) * spin;
    if (block.current) block.current.rotation.x = ang.current;
    // ground length follows the traversing wheel
    const gl = L * g;
    if (groundPart.current) {
      groundPart.current.visible = gl > 0.002;
      groundPart.current.scale.set(1, Math.max(0.001, gl), 1);
      groundPart.current.position.x = -L / 2 + gl / 2;
    }
    if (roughPart.current) {
      roughPart.current.visible = gl < L - 0.002;
      roughPart.current.scale.set(1, Math.max(0.001, L - gl), 1);
      roughPart.current.position.x = -L / 2 + gl + (L - gl) / 2;
    }
    if (wheel.current) {
      wheel.current.visible = grinding;
      wheel.current.position.x = cx - L / 2 + gl;
      wheel.current.rotation.x += pdt(dt) * 20;
    }
    // the wheelhead rides with the wheel's traverse (it does not spin)
    if (wheelhead.current) {
      wheelhead.current.visible = grinding;
      wheelhead.current.position.x = cx - L / 2 + gl;
    }
    if (laserRef.current) laserRef.current.visible = grinding && inPhase('measure');
    if (xbeam.current) xbeam.current.visible = notching && inPhase('xray');
    if (notch.current) {
      const n = notching ? pp('notch') : sid === 'slicing' ? 1 : 0;
      notch.current.visible = n > 0.01 && variant !== 'grind';
      notch.current.scale.set(Math.max(0.001, L * n), 1, 1);
      notch.current.position.x = -L / 2 + (L * n) / 2;
    }
    if (spray.current) {
      const on = grinding && inPhase('grind') && engine.player.playing;
      for (let i = 0; i < 30; i++) {
        const u = (engine.time * 1.5 + i / 30) % 1;
        o.position.set(cx - L / 2 + gl + (Math.sin(i * 7) * 0.04), AXIS_Y + 0.3 - u * 0.4, 0.2 + u * 0.05);
        o.scale.setScalar(on ? 0.012 : 0.0001);
        o.updateMatrix();
        spray.current.setMatrixAt(i, o.matrix);
      }
      spray.current.instanceMatrix.needsUpdate = true;
    }
    if (grinding || notching) track('focus', cx, AXIS_Y, 0);
  });
  const base = useModel(buildGrinderBase);
  const spindles = useModel(buildSpindles);
  const gauge = useModel(buildGauge);
  const wheelParts = useModel(buildWheel);
  const headParts = useModel(buildWheelhead);
  const xray = useModel(buildXray);
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'ingot-grinder', label: 'OD grinder / notch grinder' }}>
        <group position={[cx, 0, 0]}>
          <Baked parts={base} />
        </group>
        <Clickable sel={{ kind: 'component', id: 'spindles', machine: 'ingot-grinder', label: 'Headstock & tailstock' }}>
          <group position={[cx, 0, 0]}>
            <Baked parts={spindles} />
          </group>
        </Clickable>
        <SignalTower position={[cx + 1.0, 2.25, -0.6]} />
      </Clickable>
      <group position={[cx, AXIS_Y, 0]}>
        <group ref={block}>
          <Clickable sel={{ kind: 'wafer', id: 'ingot', label: 'Ingot block B (IG-0447)' }}>
            <mesh ref={groundPart} rotation={[0, 0, Math.PI / 2]} material={ground} castShadow>
              <cylinderGeometry args={[R_GROUND, R_GROUND, 1, 64]} />
            </mesh>
            <mesh ref={roughPart} rotation={[0, 0, Math.PI / 2]} material={rough} castShadow>
              <cylinderGeometry args={[CZ_BODY_R, CZ_BODY_R, 1, 64]} />
            </mesh>
            {/* orientation notch groove */}
            <mesh ref={notch} position={[0, R_GROUND - 0.0035, 0]} material={M.black}>
              <boxGeometry args={[1, 0.008, 0.008]} />
            </mesh>
          </Clickable>
        </group>
      </group>
      <group ref={wheel} position={[cx, AXIS_Y, 0.42]}>
        <Clickable sel={{ kind: 'component', id: 'grind-wheel', machine: 'ingot-grinder', label: 'Diamond grinding wheel' }}>
          <Baked parts={wheelParts} />
        </Clickable>
      </group>
      <group ref={wheelhead} position={[cx, AXIS_Y, 0.42]}>
        <Clickable sel={{ kind: 'component', id: 'grind-wheel', machine: 'ingot-grinder', label: 'Diamond grinding wheel' }}>
          <Baked parts={headParts} />
        </Clickable>
      </group>
      <instancedMesh ref={spray} args={[GEO.sphereLow, coolant, 30]} />
      {/* laser micrometer */}
      <Clickable sel={{ kind: 'component', id: 'gauge', machine: 'ingot-grinder', label: 'Laser diameter gauge' }}>
        <group position={[cx, 0, 0]}>
          <Baked parts={gauge} />
        </group>
        <mesh ref={laserRef} position={[cx, AXIS_Y, 0]} material={laser} visible={false}>
          <boxGeometry args={[0.004, 0.5, 0.004]} />
        </mesh>
      </Clickable>
      {/* X-ray orientation unit */}
      {variant === 'notch' && (
        <Clickable sel={{ kind: 'component', id: 'xray', machine: 'ingot-grinder', label: 'X-ray orientation unit' }}>
          <group position={[cx, 0, 0]}>
            <Baked parts={xray} />
          </group>
          <mesh ref={xbeam} position={[cx + 0.1, AXIS_Y + 0.33, 0.12]} rotation={[0.7, 0, 0]} visible={false}>
            <coneGeometry args={[0.03, 0.4, 12, 1, true]} />
            <meshBasicMaterial color="#c6e8a8" transparent opacity={0.35} depthWrite={false} />
          </mesh>
        </Clickable>
      )}
      <SensorIndicator id="interferometer" channel="diam" machine="ingot-grinder" position={[cx + 0.12, AXIS_Y + 0.36, 0]} size={0.07} />
      <SensorIndicator id="torque-sensor" channel="load" machine="ingot-grinder" position={[cx + 0.2, AXIS_Y, 0.62]} size={0.07} />
      <TechLabel position={[cx, AXIS_Y + 0.55, 0.3]} title={variant === 'notch' ? 'X-RAY ORIENTATION → NOTCH' : 'OD GRINDING → Ø 300 mm'} value={() => (variant === 'notch' ? `orientation error ${engine.tele.value('orient', 0).toFixed(2)}° · notch ${engine.tele.value('depth', 0).toFixed(2)} mm` : `Ø ${engine.tele.value('diam', 300).toFixed(2)} mm · SIM`)} />
    </group>
  );
}

/* ------------------------------------------------------------ multi-wire saw */

/** Visual spacing is exaggerated (real pitch ≈ 1.1 mm) so individual wafers and kerf gaps are visible. */
const N_WAFERS = 64;
const PITCH = 0.0056;
const SPAN = N_WAFERS * PITCH;
const WIRE_Y = 0.95;
const ROLLERS: [number, number][] = [
  [-0.5, WIRE_Y],
  [0.5, WIRE_Y],
  [0, 0.42],
];

/** Saw frame: cast bed, slurry pan, side towers, top beam with feed unit, roller bearings, doors, utilities. */
function buildSawFrame(k: Kit) {
  // cast bed with recessed kick plate, slurry pan
  k.box(KM.paintGraphite, [2.62, 0.06, 1.52], [0, 0.03, -0.05]);
  k.rbox(KM.paintGrey, [2.7, 0.19, 1.6], 0.02, [0, 0.155, -0.05]);
  k.box(KM.seam, [1.7, 0.003, 0.9], [0, 0.2515, 0], [0, 0, 0], { cast: false });
  for (const s of [-1, 1]) {
    k.box(KM.stainless, [1.73, 0.06, 0.012], [0, 0.28, s * 0.45]);
    k.box(KM.stainless, [0.012, 0.06, 0.9], [s * 0.86, 0.28, 0]);
  }
  k.cyl(KM.stainlessDark, 0.03, 0.006, [0.6, 0.254, 0.3], [0, 0, 0], 16);
  // side towers (drives, wire management, electrics)
  for (const s of [-1, 1])
    k.at([s * 1.2, 0.25, -0.1], 0, () => {
      k.rbox(KM.paint, [0.25, 2.05, 1.4], 0.02, [0, 1.025, 0]);
      for (const y of [0.62, 1.42]) k.box(KM.seam, [0.22, 0.004, 0.002], [0, y, 0.7012], [0, 0, 0], { cast: false });
      for (const z of [-0.23, 0.23]) k.box(KM.seam, [0.002, 1.98, 0.004], [s * 0.1262, 1.025, z], [0, 0, 0], { cast: false });
      k.box(KM.seam, [0.002, 0.004, 1.36], [s * 0.1262, 0.7, 0], [0, 0, 0], { cast: false });
      for (const [y, z] of [[0.08, -0.65], [0.08, 0.65], [1.97, -0.65], [1.97, 0.65], [0.08, 0], [1.97, 0]] as const) k.cyl(KM.stainlessDark, 0.0055, 0.004, [s * 0.127, y, z], RX, 8);
      k.at([s * 0.127, 0.38, 0], [0, s * Math.PI / 2, 0], () => grille(k, 0.62, 0.36, [0, 0, 0]));
      k.at([s * 0.127, 1.45, 0.42], [0, s * Math.PI / 2, 0], () => grille(k, 0.3, 0.42, [0, 0, 0], { pitch: 0.03 }));
    });
  // top beam and feed unit
  k.rbox(KM.paint, [2.7, 0.3, 1.42], 0.02, [0, 2.45, -0.1]);
  k.rbox(KM.paintGraphite, [2.72, 0.022, 1.44], 0.006, [0, 2.611, -0.1]);
  k.box(KM.paintAccent, [2.66, 0.014, 0.003], [0, 2.56, 0.6115], [0, 0, 0], { cast: false });
  k.label('model', 'MWS-300', 'MULTI-WIRE SAW · 300 mm', 0.44, 0.1, [0.62, 2.44, 0.612]);
  k.label('warn', 'MOVING WIRE', '', 0.13, 0.13, [-0.62, 2.44, 0.612]);
  ledStrip(k, 0.5, [-0.05, 2.36, 0.612]);
  k.box(KM.ledWhite, [1.9, 0.012, 0.05], [0, 2.295, 0.42], [0, 0, 0], { cast: false });
  k.rbox(KM.paint, [0.56, 0.42, 0.5], 0.02, [0, 2.09, -0.05]);
  k.box(KM.seam, [0.562, 0.004, 0.502], [0, 2.0, -0.05], [0, 0, 0], { cast: false });
  bellows(k, 0.1, 0.12, 6, [0, 1.76, 0], KM.paintGraphite);
  k.cyl(KM.stainless, 0.12, 0.012, [0, 1.882, 0], [0, 0, 0], 32);
  // stainless back wall of the cutting chamber: stiffeners, drip lip, service ports
  k.box(KM.paintGrey, [2.15, 2.05, 0.05], [0, 1.275, -0.78]);
  for (const x of [-0.82, 0.82]) k.rbox(KM.stainlessDark, [0.05, 1.95, 0.025], 0.006, [x, 1.3, -0.742]);
  k.rbox(KM.stainlessDark, [2.1, 0.04, 0.05], 0.008, [0, 0.33, -0.73]);
  k.box(KM.seam, [2.1, 0.004, 0.002], [0, 2.2, -0.754], [0, 0, 0], { cast: false });
  for (const x of [-0.82, 0.82]) for (const y of [0.42, 1.05, 1.7, 2.22]) k.cyl(KM.stainless, 0.007, 0.006, [x, y, -0.727], RZ, 6, { cast: false });
  // roller bearing housings (back) and front bearing caps
  for (const [x, y] of ROLLERS) {
    k.cyl(KM.stainlessDark, 0.1, 0.46, [x, y, -0.52], RZ, 32);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      k.box(KM.stainlessDark, [0.014, 0.03, 0.4], [x + Math.cos(a) * 0.11, y + Math.sin(a) * 0.11, -0.53], [0, 0, a - Math.PI / 2]);
    }
    k.cyl(KM.stainless, 0.15, 0.02, [x, y, -0.745], RZ, 40);
    boltRingZ(k, [x, y, -0.733], 0.132, 8, 0.008);
    k.cyl(KM.brass, 0.006, 0.03, [x, y + 0.112, -0.4], [0, 0, 0], 6, { cast: false });
    k.cyl(KM.stainless, 0.13, 0.025, [x, y, -0.2775], RZ, 40);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      k.cyl(KM.stainlessDark, 0.008, 0.012, [x + Math.cos(a) * 0.112, y + Math.sin(a) * 0.112, -0.26], RZ, 6);
    }
    k.cyl(KM.stainlessDark, 0.06, 0.055, [x, y, 0.2825], RZ, 24);
    k.cyl(KM.stainless, 0.03, 0.01, [x, y, 0.315], RZ, 16);
  }
  for (const s of [-1, 1]) k.rbox(KM.paintGrey, [0.575, 0.045, 0.04], 0.01, [s * 0.7875, WIRE_Y, 0.2825]);
  k.rbox(KM.paintGrey, [0.05, 0.17, 0.04], 0.01, [0, 0.335, 0.2825]);
  // wire path: spools → dancer pulleys → guide pulleys → web
  for (const s of [-1, 1]) {
    k.tube(KM.steel, [[s * 0.75, 1.8, 0.55], [s * 0.55, 1.77, 0.6], [s * 0.47, 1.33, 0.27], [s * 0.5, 1.12, 0.2]], 0.0016, { radial: 4, tension: 0 });
    k.cyl(KM.stainless, 0.04, 0.016, [s * 0.47, 1.3, 0.27], RZ, 20);
    k.cyl(KM.paintGrey, 0.008, 0.6, [s * 0.775, 1.3, 0.27], RX, 8);
  }
  // parked sliding doors and their tracks
  for (const s of [-1, 1]) {
    windowPane(k, 0.28, 1.85, [s * 1.26, 1.33, 0.64], { frame: KM.anodizedDark, glass: KM.glass });
    k.rbox(KM.stainless, [0.025, 0.3, 0.035], 0.008, [s * 1.12, 1.3, 0.665]);
  }
  k.box(KM.anodizedDark, [2.9, 0.04, 0.04], [0, 2.29, 0.64]);
  k.box(KM.anodizedDark, [2.9, 0.02, 0.03], [0, 0.26, 0.64]);
  // operator HMI on a swing arm, EMOs
  const yaw = -0.5;
  const hp: V3 = [1.55, 1.45, 0.78];
  hmi(k, hp, yaw);
  const ax = hp[0] + 0.22 * Math.sin(yaw);
  const az = hp[2] - 0.22 * Math.cos(yaw);
  k.pipe(KM.anodizedDark, [[ax, hp[1], az], [ax, hp[1], 0.42], [1.33, hp[1], 0.42]], 0.018, 0.05);
  for (const s of [-1, 1]) k.at([s * 1.326, 1.1, 0.35], [0, s * Math.PI / 2, 0], () => estop(k, [0, 0, 0]));
  // slurry tank with agitator and supply line to the nozzle manifold
  k.at([1.95, 0, -1.15], 0, () => {
    for (const [x, z] of [[-0.22, -0.22], [0.22, -0.22], [-0.22, 0.22], [0.22, 0.22]]) k.box(KM.stainless, [0.04, 0.12, 0.04], [x, 0.06, z]);
    k.cyl(KM.plasticWhite, 0.32, 0.86, [0, 0.55, 0], [0, 0, 0], 40);
    k.cyl(KM.stainless, 0.335, 0.03, [0, 0.995, 0], [0, 0, 0], 40);
    for (const y of [0.32, 0.62, 0.9]) k.torus(KM.stainless, 0.322, 0.006, [0, y, 0], [0, 0, 0], 40);
    k.at([0, 1.01, 0], 0, () => motor(k, 0.07, 0.22));
    k.label('info', 'SLURRY TANK', 'PEG + SiC · AGITATED', 0.3, 0.075, [0, 0.62, 0.322]);
  });
  k.pipe(KM.stainless, [[1.75, 0.98, -1.1], [1.75, 1.75, -1.1], [1.75, 1.75, -0.86], [-0.4, 1.75, -0.86]], 0.02, 0.08);
  k.ao(2.9, 1.75, [0, 0, -0.05], 1.15);
  k.ao(0.8, 0.8, [1.95, 0, -1.15]);
}

/** Grooved wire guide (rotates about its own axis): PU-coated roller, wire grooves, flanges, hub bolts. */
function buildRoller(k: Kit) {
  const half = (SPAN + 0.08) / 2;
  k.cyl(KM.paintWarm, 0.168, half * 2, [0, 0, 0], RZ, 48);
  for (let i = 0; i < N_WAFERS; i += 4) k.cyl(KM.seam, 0.1683, 0.0022, [0, 0, -SPAN / 2 + i * PITCH], RZ, 48, { cast: false, open: true });
  for (const e of [-1, 1]) {
    k.cyl(KM.stainless, 0.172, 0.012, [0, 0, e * (half + 0.006)], RZ, 48);
    k.cyl(KM.stainlessDark, 0.07, 0.012, [0, 0, e * (half + 0.018)], RZ, 32);
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.cyl(KM.stainless, 0.008, 0.01, [Math.cos(a) * 0.05, Math.sin(a) * 0.05, half + 0.027], RZ, 6);
  }
  k.box(KM.seam, [0.02, 0.05, 0.004], [0, 0.14, half + 0.0125], [0, 0, 0], { cast: false });
}

/** Supply and take-up spools with their gearmotor housings. */
function buildSpools(k: Kit) {
  for (const s of [-1, 1]) {
    k.at([s * 0.75, 2.0, 0.55], [Math.PI / 2, 0, 0], () => {
      k.cyl(KM.brass, 0.195, 0.24, [0, 0, 0], [0, 0, 0], 48);
      for (let i = 0; i < 6; i++) k.cyl(KM.copper, 0.1958, 0.004, [0, -0.1 + i * 0.04, 0], [0, 0, 0], 48, { cast: false, open: true });
      for (const e of [-1, 1]) {
        k.cyl(KM.paintGrey, 0.22, 0.02, [0, e * 0.13, 0], [0, 0, 0], 48);
      }
      k.cyl(KM.stainlessDark, 0.06, 0.05, [0, 0.16, 0], [0, 0, 0], 20);
      k.cyl(KM.stainless, 0.03, 0.03, [0, 0.19, 0], [0, 0, 0], 6);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        k.cyl(KM.stainless, 0.006, 0.008, [Math.cos(a) * 0.045, 0.188, Math.sin(a) * 0.045], [0, 0, 0], 6, { cast: false });
      }
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        k.cyl(KM.seam, 0.03, 0.022, [Math.cos(a) * 0.135, 0.131, Math.sin(a) * 0.135], [0, 0, 0], 14);
      }
    });
    k.rbox(KM.paint, [0.34, 0.34, 0.16], 0.02, [s * 0.75, 2.0, 0.33]);
    k.rbox(KM.paint, [0.2, 0.16, 0.12], 0.02, [s * 0.75, 2.23, 0.33]);
    k.cyl(KM.stainlessDark, 0.03, 0.08, [s * 0.75, 2.0, 0.42], RZ, 16);
    k.label('tag', s < 0 ? 'SUPPLY' : 'TAKE-UP', 'Ø 0.12 mm WIRE', 0.12, 0.03, [s * 0.75, 2.23, 0.3905]);
  }
}

/** Dancer arms with pivot hubs, encoders, counterweights and grooved pulleys. */
function buildDancers(k: Kit) {
  for (const s of [-1, 1]) {
    k.rbox(KM.paintYellow, [0.52, 0.045, 0.035], 0.012, [s * 0.75, 1.7, 0.6], [0, 0, -s * 0.4]);
    k.box(KM.seam, [0.34, 0.012, 0.002], [s * 0.75, 1.7, 0.6185], [0, 0, -s * 0.4], { cast: false });
    k.rbox(KM.paintGraphite, [0.09, 0.07, 0.05], 0.01, [s * 1.07, 1.565, 0.6], [0, 0, -s * 0.4]);
    k.cyl(KM.stainlessDark, 0.035, 0.08, [s * 0.98, 1.603, 0.585], RZ, 20);
    boltRingZ(k, [s * 0.98, 1.603, 0.627], 0.022, 4, 0.005, KM.stainless);
    k.box(KM.stainlessDark, [0.14, 0.12, 0.02], [s * 1.02, 1.603, 0.545]);
    for (const [x, y] of [[-0.05, -0.045], [0.05, -0.045], [-0.05, 0.045], [0.05, 0.045]]) k.cyl(KM.stainless, 0.006, 0.006, [s * 1.02 + x, 1.603 + y, 0.557], RZ, 6, { cast: false });
    k.cyl(KM.paintGraphite, 0.026, 0.03, [s * 0.98, 1.603, 0.52], RZ, 16);
    line(k, [s * 0.98, 1.63, 0.505], [s * 1.06, 1.7, 0.45], 0.005, 0.03, KM.paintGraphite);
    k.cyl(KM.stainless, 0.05, 0.02, [s * 0.52, 1.797, 0.625], RZ, 28);
    k.cyl(KM.stainlessDark, 0.014, 0.05, [s * 0.52, 1.797, 0.61], RZ, 12);
    k.torus(KM.stainlessDark, 0.05, 0.004, [s * 0.52, 1.797, 0.625], [-Math.PI / 2, 0, 0], 28);
  }
}

/** Slurry curtain manifolds above the web: nozzle rows, end caps, feed lines, valve and gauge. */
function buildSlurry(k: Kit) {
  for (const s of [-1, 1]) {
    k.rbox(KM.stainless, [0.06, 0.05, SPAN + 0.12], 0.01, [s * 0.31, 1.17, 0]);
    k.box(KM.seam, [0.022, 0.004, SPAN + 0.06], [s * 0.295, 1.144, 0], [0, 0, 0], { cast: false });
    for (let i = 0; i < 10; i++) k.cyl(KM.stainlessDark, 0.006, 0.016, [s * 0.295, 1.138, -SPAN / 2 + 0.02 + (i * (SPAN - 0.04)) / 9], [0, 0, 0], 8, { cast: false });
    for (const e of [-1, 1]) {
      k.cyl(KM.stainlessDark, 0.036, 0.012, [s * 0.31, 1.17, e * (SPAN / 2 + 0.066)], RZ, 20);
      boltRingZ(k, [s * 0.31, 1.17, e * (SPAN / 2 + 0.073)], 0.026, 4, 0.004, KM.stainless, Math.PI / 4);
    }
    k.pipe(KM.stainless, [[s * 0.31, 1.17, -0.24], [s * 0.31, 1.17, -0.6], [s * 0.31, 1.75, -0.6], [s * 0.31, 1.75, -0.88]], 0.016, 0.06);
    k.cyl(KM.stainless, 0.028, 0.014, [s * 0.31, 1.17, -0.42], RZ, 16);
  }
  // header: ball valve with lever, pressure gauge
  k.rbox(KM.stainless, [0.07, 0.07, 0.06], 0.01, [0.31, 1.4, -0.6]);
  k.rbox(KM.paintRed, [0.12, 0.012, 0.02], 0.004, [0.37, 1.44, -0.6]);
  k.cyl(KM.stainless, 0.006, 0.05, [0.24, 1.32, -0.6], RX, 6);
  k.cyl(KM.stainless, 0.03, 0.02, [0.205, 1.32, -0.59], RZ, 20);
  k.cyl(KM.plasticWhite, 0.024, 0.004, [0.205, 1.32, -0.578], RZ, 20, { cast: false });
  k.box(KM.seam, [0.002, 0.018, 0.001], [0.205, 1.326, -0.5755], [0, 0, -0.6], { cast: false });
  k.label('gas', 'SLURRY', '', 0.14, 0.03, [0.31, 1.52, -0.582], [0, 0, 0], '#7a6a3a');
}

/** Work holder carried by the feed ram: glass glue beam, adapter plate, dovetail clamp, ram with way cover. */
function buildFeedTable(k: Kit) {
  const R = R_GROUND;
  const L = SPAN + 0.1;
  k.rbox(M.glassDark, [0.18, 0.06, SPAN + 0.04], 0.004, [0, R + 0.03, 0]);
  k.rbox(KM.stainless, [0.3, 0.035, SPAN + 0.08], 0.006, [0, R + 0.0775, 0]);
  k.label('tag', 'IG-0447 · B', 'GLASS BEAM · EPOXY', 0.12, 0.03, [0, R + 0.0775, (SPAN + 0.08) / 2 + 0.0005]);
  k.rbox(KM.anodizedDark, [0.4, 0.07, L], 0.01, [0, R + 0.13, 0]);
  for (const x of [-0.13, 0, 0.13]) k.cyl(KM.stainless, 0.012, 0.012, [x, R + 0.13, L / 2 + 0.005], RZ, 6);
  for (const x of [-0.065, 0.065]) k.box(KM.seam, [0.014, 0.002, L - 0.02], [x, R + 0.1655, 0], [0, 0, 0], { cast: false });
  // dovetail clamp jaws with clamp screws
  for (const s of [-1, 1]) {
    k.rbox(KM.stainlessDark, [0.04, 0.05, L], 0.006, [s * 0.172, R + 0.092, 0]);
    for (let i = 0; i < 4; i++) k.cyl(KM.stainless, 0.009, 0.012, [s * 0.197, R + 0.092, -L / 2 + 0.05 + (i * (L - 0.1)) / 3], RX, 6);
  }
  // ram: mounting flange, gussets, linear guides, front way cover
  k.rbox(KM.paintGraphite, [0.22, 0.03, 0.22], 0.006, [0, R + 0.18, 0]);
  for (const [x, z] of [[-0.085, -0.085], [0.085, -0.085], [-0.085, 0.085], [0.085, 0.085]]) k.cyl(KM.stainless, 0.008, 0.008, [x, R + 0.199, z], [0, 0, 0], 6, { cast: false });
  for (const x of [-0.04, 0.04]) {
    k.extrude(KM.paint, [[-0.06, 0], [-0.105, 0], [-0.06, 0.09]], 0.012, [x - 0.006, R + 0.195, 0], [0, Math.PI / 2, 0]);
    k.extrude(KM.paint, [[0.06, 0], [0.105, 0], [0.06, 0.09]], 0.012, [x - 0.006, R + 0.195, 0], [0, Math.PI / 2, 0]);
  }
  k.rbox(KM.paint, [0.12, 0.835, 0.12], 0.012, [0, R + 0.5825, 0]);
  for (const s of [-1, 1]) k.box(KM.stainless, [0.006, 0.8, 0.03], [s * 0.061, R + 0.6, 0]);
  for (let i = 0; i < 38; i++) k.box(i % 2 ? KM.paintGraphite : KM.plastic, [0.09, 0.014, 0.016], [0, R + 0.24 + i * 0.02, 0.064]);
}

/** Output stand: stainless table with a PTFE tray and alignment posts for the as-cut stack. */
function buildOutputStand(k: Kit) {
  for (const [x, z] of [[-0.16, -0.16], [0.16, -0.16], [-0.16, 0.16], [0.16, 0.16]]) {
    k.box(KM.stainless, [0.03, 0.86, 0.03], [x, 0.47, z]);
    k.cyl(KM.rubber, 0.03, 0.03, [x, 0.03, z], RX, 14);
  }
  k.rbox(KM.stainless, [0.38, 0.02, 0.38], 0.004, [0, 0.25, 0]);
  k.rbox(KM.stainless, [0.4, 0.025, 0.4], 0.005, [0, 0.9155, 0]);
  k.rbox(KM.ptfe, [0.38, 0.02, 0.38], 0.006, [0, 0.938, 0]);
  for (const a of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) k.cyl(KM.ptfe, 0.012, 0.35, [Math.cos(a) * 0.165, 0.948 + 0.175, Math.sin(a) * 0.165], [0, 0, 0], 12);
  k.ao(0.4, 0.4);
}

function WireSaw() {
  const cx = X.saw;
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  const view = effectiveView(viewRaw, cam, 'normal');
  const wirePlaneY = WIRE_Y;
  const span = SPAN; // block length along z
  // clipping: uncut block above the wire plane, slices below it
  const above = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), -wirePlaneY), []);
  const below = useMemo(() => new THREE.Plane(new THREE.Vector3(0, -1, 0), wirePlaneY), []);
  const blockMat = useMemo(() => {
    const m = ground.clone();
    m.clippingPlanes = [above];
    return m;
  }, [above]);
  const sliceMat = useMemo(() => {
    const m = asCut.clone();
    m.clippingPlanes = [below];
    return m;
  }, [below]);
  useEffect(() => {
    const planes = view === 'section' || view === 'cutaway' ? [cutPlane] : [];
    blockMat.clippingPlanes = [above, ...planes];
    sliceMat.clippingPlanes = [below, ...planes];
    blockMat.side = sliceMat.side = planes.length ? THREE.DoubleSide : THREE.FrontSide;
    blockMat.needsUpdate = sliceMat.needsUpdate = true;
  }, [view, blockMat, sliceMat, above, below]);

  const slices = useMemo(() => {
    const geo = new THREE.CylinderGeometry(R_GROUND, R_GROUND, WAFER_T * 1.0, 48);
    geo.rotateX(Math.PI / 2);
    const m = new THREE.InstancedMesh(geo, sliceMat, N_WAFERS);
    m.frustumCulled = false;
    return m;
  }, [sliceMat]);
  const wires = useMemo(() => {
    const m = new THREE.InstancedMesh(GEO.box, wireMat, N_WAFERS * 3);
    m.frustumCulled = false;
    return m;
  }, []);
  const stack = useMemo(() => {
    const m = new THREE.InstancedMesh(waferGeometry(), asCut, 40);
    m.frustumCulled = false;
    m.castShadow = true;
    return m;
  }, []);
  const blockGroup = useRef<THREE.Group>(null);
  const followed = useRef<THREE.Group>(null);
  const rollers = useRef<(THREE.Group | null)[]>([]);
  const slurry = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const wirePhase = useRef(0);

  // static wire web: top cutting span + two return spans to the lower roller
  useEffect(() => {
    const top = [-0.5, wirePlaneY - 0.001];
    const L = [-0.5, 0.42];
    const Rr = [0.5, 0.42];
    const tr = [0.5, wirePlaneY - 0.001];
    const seg = (i: number, a: number[], b: number[], z: number) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      o.position.set(cx + (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z);
      o.rotation.set(0, 0, Math.atan2(dy, dx));
      o.scale.set(Math.hypot(dx, dy), 0.0012, 0.0012);
      o.updateMatrix();
      wires.setMatrixAt(i, o.matrix);
    };
    for (let k = 0; k < N_WAFERS; k++) {
      const z = -span / 2 + k * PITCH;
      seg(k * 3, top, tr, z);
      seg(k * 3 + 1, tr, Rr, z);
      seg(k * 3 + 2, L, top, z);
    }
    wires.instanceMatrix.needsUpdate = true;
  }, [wires, cx, span, o, wirePlaneY]);

  useFrame((_, dt) => {
    const sid = engine.stage.id;
    const active = sid === 'slicing';
    const mount = active ? pp('mount') : 1;
    const cut = active ? pp('cut') : 1;
    const retract = active ? pp('retract') : 1;
    const sep = active ? pp('separate') : sid === 'slicing' ? 0 : 1;
    const depth = cut * (2 * R_GROUND + 0.01);
    // block descends through the web, then retracts upward with the sliced part attached
    const bottom = wirePlaneY + 0.003 - depth + retract * (2 * R_GROUND + 0.05) + (1 - mount) * 0.3;
    if (blockGroup.current) blockGroup.current.position.y = bottom + R_GROUND;
    // after retraction everything is sliced
    const allSliced = retract > 0.02;
    above.constant = allSliced ? -10 : -wirePlaneY;
    below.constant = allSliced ? 10 : wirePlaneY;
    // wafers: separate and fan out during the last phase
    for (let k = 0; k < N_WAFERS; k++) {
      const z = -span / 2 + k * PITCH;
      const fan = smooth(sep) * (k - N_WAFERS / 2) * 0.01;
      o.position.set(0, 0, z + fan);
      o.rotation.set(0, 0, 0);
      o.scale.setScalar(1);
      o.updateMatrix();
      slices.setMatrixAt(k, o.matrix);
    }
    slices.instanceMatrix.needsUpdate = true;
    // wire motion: reversing wire speed drives roller rotation
    const ws = active && inPhase('cut') ? engine.tele.value('wire', 0) : 0;
    wirePhase.current += pdt(dt) * ws;
    rollers.current.forEach((r) => {
      if (r) r.rotation.z = -wirePhase.current / 0.17;
    });
    if (slurry.current) {
      const on = active && inPhase('cut');
      for (let i = 0; i < 40; i++) {
        const u = (engine.time * 1.3 + i / 40) % 1;
        o.position.set(cx - 0.35 + (i % 8) * 0.1, 1.45 - u * 0.45, -span / 2 + ((i * 13) % 40) * (span / 40));
        o.scale.setScalar(on ? 0.008 : 0.0001);
        o.updateMatrix();
        slurry.current.setMatrixAt(i, o.matrix);
      }
      slurry.current.instanceMatrix.needsUpdate = true;
    }
    // followed wafer WF-000184 lifts out of the stack
    if (followed.current) {
      const lift = smooth(clamp((sep - 0.4) / 0.6));
      followed.current.visible = sep > 0.38 || sid !== 'slicing';
      followed.current.position.set(cx + 0.9 * lift, wirePlaneY + R_GROUND + 0.35 + lift * 0.25, 0.25 + lift * 0.1);
      followed.current.rotation.set(-Math.PI / 2 + lift * 1.1, 0, 0);
      if (sep > 0.38) track('focus', cx + 0.9 * lift, wirePlaneY + R_GROUND + 0.4, 0.3);
      else if (active) track('focus', cx, wirePlaneY + 0.1, 0);
    }
    // accumulated wafers in the output cassette
    for (let i = 0; i < 40; i++) {
      o.position.set(cx + 1.75, 0.95 + i * 0.008, -0.2);
      o.rotation.set(0, 0, 0);
      o.scale.setScalar(sep > i / 40 || sid !== 'slicing' ? 1 : 0.0001);
      o.updateMatrix();
      stack.setMatrixAt(i, o.matrix);
    }
    stack.instanceMatrix.needsUpdate = true;
  });

  const frame = useModel(buildSawFrame);
  const roller = useModel(buildRoller);
  const spools = useModel(buildSpools);
  const dancers = useModel(buildDancers);
  const nozzles = useModel(buildSlurry);
  const feed = useModel(buildFeedTable);
  const stand = useModel(buildOutputStand);
  const slurryDrop = useMemo(() => new THREE.MeshBasicMaterial({ color: '#9a9a8a' }), []);
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'wire-saw', label: 'Multi-wire saw' }}>
        <group position={[cx, 0, 0]}>
          <Baked parts={frame} />
        </group>
        {/* feed table + glue beam */}
        <Clickable sel={{ kind: 'component', id: 'feed-table', machine: 'wire-saw', label: 'Ingot feed table' }}>
          <group ref={blockGroup} position={[cx, 1.5, 0]}>
            <Baked parts={feed} />
            {/* uncut block (above wire plane) */}
            <mesh rotation={[Math.PI / 2, 0, 0]} material={blockMat}>
              <cylinderGeometry args={[R_GROUND, R_GROUND, span, 64]} />
            </mesh>
            <primitive object={slices} />
          </group>
        </Clickable>
        {/* grooved wire guides */}
        <Clickable sel={{ kind: 'component', id: 'wire-guides', machine: 'wire-saw', label: 'Grooved wire guides' }}>
          {ROLLERS.map(([x, y], i) => (
            <group key={i} position={[cx + x, y, 0]} ref={(g) => { rollers.current[i] = g; }}>
              <Baked parts={roller} />
            </group>
          ))}
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'wire-web', machine: 'wire-saw', label: 'Wire web' }}>
          <primitive object={wires} />
        </Clickable>
        {/* spools and tension arms */}
        <Clickable sel={{ kind: 'component', id: 'spools', machine: 'wire-saw', label: 'Supply & take-up spools' }}>
          <group position={[cx, 0, 0]}>
            <Baked parts={spools} />
          </group>
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'tension', machine: 'wire-saw', label: 'Tension control (dancer arms)' }}>
          <group position={[cx, 0, 0]}>
            <Baked parts={dancers} />
          </group>
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'slurry', machine: 'wire-saw', label: 'Slurry / coolant nozzles' }}>
          <group position={[cx, 0, 0]}>
            <Baked parts={nozzles} />
          </group>
        </Clickable>
        <SignalTower position={[cx + 1.2, 2.6, -0.5]} />
      </Clickable>
      <instancedMesh ref={slurry} args={[GEO.sphereLow, slurryDrop, 40]} />
      {/* output stand */}
      <group position={[cx + 1.75, 0, -0.2]}>
        <Baked parts={stand} />
      </group>
      <primitive object={stack} />
      <group ref={followed} visible={false}>
        <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184 (as-cut)' }}>
          <mesh geometry={waferGeometry()} material={asCut} />
        </Clickable>
        <TechLabel position={[0, 0.02, 0.18]} title="WF-000184 · AS-CUT" min={1} tone="accent" show={() => engine.stage.id !== 'slicing' || pp('separate') > 0.38} />
      </group>
      <SensorIndicator id="wire-tension" channel="tension" machine="wire-saw" position={[cx - 0.75, 1.82, 0.62]} size={0.07} />
      <SensorIndicator id="torque-sensor" machine="wire-saw" position={[cx + 1.05, 1.0, 0.6]} size={0.07} />
      <TechLabel position={[cx, 2.85, 0]} title="MULTI-WIRE SAW · HUNDREDS OF CUTS AT ONCE" value={() => `wire ${engine.tele.value('wire', 0).toFixed(1)} m/s · tension ${engine.tele.value('tension', 0).toFixed(1)} N · depth ${engine.tele.value('depth', 0).toFixed(0)} mm`} />
      <TechLabel position={[cx + 0.62, wirePlaneY + 0.05, 0.3]} title="KERF · SCHEMATIC SPACING" lines={['real: ≈ 160 µm kerf per ≈ 1.1 mm pitch', '≈ 15 % of the silicon becomes sludge']} min={2} />
      <TechLabel position={[cx + 1.75, 1.4, -0.2]} title="AS-CUT WAFERS" min={2} />
    </group>
  );
}

export default function IngotScene({ stage }: SceneProps) {
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0;
  }, []);
  const variant = stage.variant ?? 'crop';
  const center = X[variant === 'slice' ? 'saw' : variant === 'crop' ? 'crop' : 'grind'];
  return (
    <>
      <Lighting env="hall" shadowExtent={8} center={[center, 0, 0]} />
      <Hall width={36} depth={18} height={9} />
      <CropStation />
      <Grinder variant={variant} />
      <WireSaw />
      <TechLabel position={[0, 0.05, 2.2]} title="INGOT IG-0447 → BLOCK B → WAFERS" min={2} />
    </>
  );
}
