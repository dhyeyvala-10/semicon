'use client';
/**
 * Wafer finishing (§15, §16): edge profiling → lapping → chemical etching → polishing → cleaning.
 * The followed wafer's surface visibly changes from rough to mirror; each station has a
 * magnified cross-section whose roughness / damage / particles come from the same
 * simulated values shown in the telemetry.
 *
 * Equipment is built with the detailing kit: static parts (and the rigid moving
 * assemblies) are merged into one mesh per finish, so the finished models stay cheap.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, CleanroomBay } from '../environments';
import { M } from '../materials';
import { B, GEO } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Inset } from '../parts/section';
import { waferGeometry, WAFER_R } from '../parts/wafer';
import { engine } from '@/simulation/engine';
import { pp, pdt, inPhase } from '@/lib/anim';
import { track } from '@/lib/runtime';
import { rng, smooth, clamp, lerp } from '@/lib/math';
import { Kit, cabinet, bellows, grille, windowPane, hmi, estop, ledStrip, hose, type BakedPart, type V3 } from '../kit/build';
import { KM } from '../kit/finish';
import { Baked, useKit } from '../kit/Baked';

const X = { edge: -12, lap: -4, etch: 4, polish: 12, clean: 20 };
const TABLE_Y = 1.0;

/** Wafer material whose roughness/metalness animate with the finishing state. */
const followMat = new THREE.MeshStandardMaterial({ color: '#7a8088', roughness: 0.8, metalness: 0.45 });
function setSurface(rough: number) {
  // rough = 1 (as-cut) … 0 (mirror)
  followMat.roughness = lerp(0.05, 0.82, rough);
  followMat.metalness = lerp(0.93, 0.45, rough);
  followMat.color.setRGB(lerp(0.56, 0.47, rough), lerp(0.59, 0.5, rough), lerp(0.64, 0.53, rough));
}

const slurryMat = new THREE.MeshBasicMaterial({ color: '#d8d4c4', transparent: true, opacity: 0.8 });
const liquid = (color: string, opacity = 0.55) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.05, transparent: true, opacity, depthWrite: false });

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


/** Pole-mounted HMI: touchscreen on an arm, pedestal to the floor. */
function hmiPedestal(k: Kit, pos: V3, yaw: number) {
  hmi(k, pos, yaw);
  const ax = pos[0] + 0.22 * Math.sin(yaw);
  const az = pos[2] - 0.22 * Math.cos(yaw);
  k.cyl(KM.anodizedDark, 0.028, pos[1], [ax, pos[1] / 2, az], [0, 0, 0], 16);
  k.cyl(KM.paintGraphite, 0.15, 0.02, [ax, 0.01, az], [0, 0, 0], 24);
}

/* --------------------------------------------------------- surface inset */

function RoughnessInset({ id, position, title, mpu, amp, layers }: { id: string; position: [number, number, number]; title: string; mpu: number; amp: () => number; layers?: () => { damage?: number } }) {
  const N = 60;
  const ref = useRef<{ key: string }>({ key: '' });
  const slabRef = useRef<THREE.Mesh>(null);
  const damageRef = useRef<THREE.Mesh>(null);
  const r = useMemo(() => rng(id.length * 31), [id]);
  const phases = useMemo(() => Array.from({ length: N + 1 }, () => r()), [r]);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8a9098', roughness: 0.4, metalness: 0.6 }), []);
  const dmgMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#5a4f48', roughness: 0.9 }), []);
  useFrame(() => {
    const a = amp();
    const key = a.toFixed(3);
    if (key !== ref.current.key && slabRef.current) {
      ref.current.key = key;
      const pts: [number, number][] = [[-0.55, -0.32]];
      for (let i = 0; i <= N; i++) {
        const x = -0.55 + (1.1 * i) / N;
        const y = 0.12 + a * (0.6 * Math.sin(i * 1.7 + phases[i] * 3) * 0.5 + (phases[i] - 0.5) * 0.9);
        pts.push([x, Math.min(0.3, y)]);
      }
      pts.push([0.55, -0.32]);
      const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
      const g = new THREE.ExtrudeGeometry(shape, { depth: 0.18, bevelEnabled: false });
      g.translate(0, 0, -0.09);
      slabRef.current.geometry.dispose();
      slabRef.current.geometry = g;
    }
    if (damageRef.current && layers) {
      const d = layers().damage ?? 0;
      damageRef.current.visible = d > 0.01;
      damageRef.current.scale.set(1.1, Math.max(0.001, d * 0.25), 0.185);
      damageRef.current.position.y = 0.12 - (d * 0.25) / 2 - 0.02;
    }
  });
  return (
    <Inset id={id} position={position} size={[1.3, 0.85]} mpu={mpu} title={title}>
      <group position={[0, 0, 0.15]} rotation={[0.25, 0, 0]}>
        <mesh ref={slabRef} material={mat} />
        <mesh ref={damageRef} geometry={GEO.box} material={dmgMat} />
      </group>
    </Inset>
  );
}

/* --------------------------------------------------------- 1 · edge */

const BASIN_X = 0.12; // splash basin centre (local x)
const BASIN_R = 0.4;

/** Edge profiler body: cabinet, stainless deck with a splash basin, guard housing, load cassette, controls. */
function buildEdgeProfiler(k: Kit) {
  const D = 1.15;
  const ZC = -0.075;
  const zf = ZC + D / 2;
  const zb = ZC - D / 2;
  k.at([0, 0, ZC], 0, () => cabinet(k, { size: [1.4, 0.84, D], panels: 2, rows: [0.34], sidePanels: 2, handles: true, stripe: KM.paintAccent, ao: false }));
  // skirt between the cabinet and the deck
  const sy0 = 0.862;
  const sy1 = 0.97;
  k.box(KM.paint, [1.4, sy1 - sy0, 0.02], [0, (sy0 + sy1) / 2, zf - 0.01]);
  k.box(KM.paint, [1.4, sy1 - sy0, 0.02], [0, (sy0 + sy1) / 2, zb + 0.01]);
  for (const s of [-1, 1]) k.box(KM.paint, [0.02, sy1 - sy0, D], [s * 0.69, (sy0 + sy1) / 2, ZC]);
  k.box(KM.seam, [1.36, 0.004, 0.003], [0, sy0 + 0.006, zf + 0.0005], [0, 0, 0], { cast: false });
  // stainless deck with the basin opening
  const deck = new THREE.Shape();
  deck.moveTo(-0.7, -zf);
  deck.lineTo(0.7, -zf);
  deck.lineTo(0.7, -zb);
  deck.lineTo(-0.7, -zb);
  deck.closePath();
  deck.holes.push(new THREE.Path().absarc(BASIN_X, 0, BASIN_R, 0, Math.PI * 2, false));
  const dg = new THREE.ExtrudeGeometry(deck, { depth: 0.03, bevelEnabled: false, curveSegments: 40 });
  k.add(KM.stainless, dg, [0, 0.97, 0], [-Math.PI / 2, 0, 0]);
  dg.dispose();
  // splash basin: inward wall, floor, raised lip, drain
  k.at([BASIN_X, 0, 0], 0, () => {
    k.lathe(KM.stainless, [[BASIN_R, 1.0], [BASIN_R, 0.87]], [0, 0, 0], [0, 0, 0], 64);
    k.cyl(KM.stainlessDark, BASIN_R, 0.006, [0, 0.867, 0], [0, 0, 0], 64);
    k.lathe(KM.stainless, [[BASIN_R + 0.04, 1.005], [BASIN_R, 1.005]], [0, 0, 0], [0, 0, 0], 64);
    k.lathe(KM.stainless, [[BASIN_R + 0.04, 0.998], [BASIN_R + 0.04, 1.005]], [0, 0, 0], [0, 0, 0], 64);
    k.cyl(KM.seam, 0.03, 0.004, [0.22, 0.871, 0.18], [0, 0, 0], 16);
  });
  // linear rail for the spindle carriage
  k.rbox(KM.paintGraphite, [0.46, 0.02, 0.07], 0.004, [0.3, 1.01, -0.52]);
  k.box(KM.chrome, [0.44, 0.008, 0.016], [0.3, 1.024, -0.52]);
  // guard housing: back panel, glazed side panels, top frame, exhaust hood
  const HB = 1.0;
  const HT = 1.95;
  k.rbox(KM.paint, [1.4, HT - HB, 0.03], 0.008, [0, (HB + HT) / 2, -0.625]);
  ledStrip(k, 0.5, [-0.3, HT - 0.07, -0.608]);
  for (const s of [-1, 1]) {
    k.box(KM.paint, [0.03, 0.18, 0.86], [s * 0.685, HB + 0.09, -0.21]);
    k.at([s * 0.685, 0, -0.21], [0, s * Math.PI / 2, 0], () => windowPane(k, 0.78, 0.66, [0, HB + 0.18 + 0.36, 0], { frame: KM.anodizedDark, glass: KM.glass }));
    for (const z of [-0.64, 0.22]) k.rbox(KM.anodizedDark, [0.04, HT - HB, 0.04], 0.006, [s * 0.685, (HB + HT) / 2, z]);
    k.box(KM.anodizedDark, [0.04, 0.04, 0.86], [s * 0.685, HT, -0.21]);
  }
  k.box(KM.anodizedDark, [1.41, 0.04, 0.04], [0, HT, 0.22]);
  k.rbox(KM.paint, [1.4, 0.12, 0.3], 0.02, [0, HT + 0.06, -0.49]);
  k.at([0, HT - 0.003, -0.47], [Math.PI / 2, 0, 0], () => grille(k, 1.1, 0.16, [0, 0, 0], { m: KM.paint }));
  k.cyl(KM.paintGrey, 0.07, 0.6, [0.35, HT + 0.42, -0.5], [0, 0, 0], 24);
  k.torus(KM.paintGrey, 0.072, 0.008, [0.35, HT + 0.2, -0.5], [0, 0, 0], 24);
  // front lip of the work deck
  k.cyl(KM.stainless, 0.015, 1.4, [0, 1.0, zf], RX, 12);
  // input cassette with as-cut wafers on the deck
  k.at([-0.5, 1.0, -0.05], 0, () => {
    k.rbox(KM.paintGraphite, [0.36, 0.012, 0.34], 0.004, [0, 0.006, 0]);
    for (const s of [-1, 1]) {
      k.rbox(KM.ptfe, [0.012, 0.16, 0.3], 0.004, [s * 0.162, 0.092, 0]);
      for (let i = 0; i < 6; i++) k.box(KM.ptfe, [0.012, 0.004, 0.28], [s * 0.15, 0.03 + i * 0.022, 0]);
    }
    k.rbox(KM.ptfe, [0.336, 0.03, 0.02], 0.004, [0, 0.157, -0.15]);
    k.rbox(KM.ptfe, [0.336, 0.02, 0.02], 0.004, [0, 0.022, 0.15]);
    for (let i = 0; i < 5; i++) k.cyl(M.siRough, 0.148, 0.0008, [0, 0.034 + i * 0.022, 0], [0, 0, 0], 48);
  });
  // DIW supply manifold on the back panel
  k.rbox(KM.stainless, [0.3, 0.05, 0.05], 0.01, [-0.25, 1.45, -0.585]);
  for (const x of [-0.35, -0.15]) {
    k.cyl(KM.stainless, 0.014, 0.08, [x, 1.5, -0.585], [0, 0, 0], 10);
    k.rbox(KM.paintBlue, [0.05, 0.012, 0.02], 0.004, [x, 1.545, -0.585]);
  }
  k.label('gas', 'DIW', '', 0.12, 0.026, [-0.25, 1.62, -0.608], [0, 0, 0], '#2f5d8a');
  hose(k, [-0.15, 1.42, -0.57], [0.02, 1.03, -0.44], 0.01, 0.06, KM.ptfe);
  // nameplate, warning, controls
  k.label('model', 'EP-300', 'WAFER EDGE PROFILER', 0.36, 0.09, [0.22, 0.74, zf + 0.002]);
  k.label('warn', 'ROTATING', '', 0.1, 0.1, [0.7015, 1.09, 0.0], [0, Math.PI / 2, 0]);
  estop(k, [-0.45, 0.74, zf]);
  hmiPedestal(k, [0.95, 1.5, 0.62], -0.5);
  k.ao(1.5, 1.25, [0, 0, ZC], 1.2);
}

/** Vacuum chuck: pedestal, stainless body, porous ceramic face. */
function buildChuck(k: Kit) {
  k.cyl(KM.stainlessDark, 0.05, 0.08, [0, 0.91, 0], [0, 0, 0], 28);
  bellows(k, 0.06, 0.03, 4, [0, 0.87, 0], KM.rubber);
  k.cyl(KM.stainless, 0.075, 0.06, [0, 0.98, 0], [0, 0, 0], 40);
  k.cyl(KM.ptfe, 0.072, 0.0095, [0, 1.01475, 0], [0, 0, 0], 40);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.cyl(KM.stainlessDark, 0.006, 0.01, [Math.cos(a) * 0.066, 1.011, Math.sin(a) * 0.066], [0, 0, 0], 6);
  }
}

/** Profiled diamond wheel (spins as a whole): grooved rim, hub, spindle, index mark. */
function buildProfileWheel(k: Kit) {
  k.lathe(M.graphite, [[0.03, -0.02], [0.1, -0.02], [0.1, -0.007], [0.088, 0], [0.1, 0.007], [0.1, 0.02], [0.03, 0.02]], [0, 0, 0], [0, 0, 0], 64);
  k.cyl(KM.stainless, 0.045, 0.05, [0, 0, 0], [0, 0, 0], 32);
  k.cyl(KM.chrome, 0.02, 0.28, [0, 0.16, 0], [0, 0, 0], 16);
  k.cyl(KM.stainlessDark, 0.03, 0.012, [0, 0.031, 0], [0, 0, 0], 6);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    k.cyl(KM.stainlessDark, 0.005, 0.006, [Math.cos(a) * 0.036, 0.027, Math.sin(a) * 0.036], [0, 0, 0], 6);
  }
  k.box(KM.paintYellow, [0.03, 0.002, 0.008], [0.07, 0.0205, 0]);
}

/** Spindle head (follows the wheel's infeed, does not spin): housing, motor, arm, Z-slide, carriage, coolant. */
function buildEdgeSpindle(k: Kit) {
  k.cyl(KM.paint, 0.045, 0.18, [0, 0.21, 0], [0, 0, 0], 28);
  k.cyl(KM.stainless, 0.05, 0.012, [0, 0.12, 0], [0, 0, 0], 28);
  k.at([0, 0.3, 0], 0, () => motor(k, 0.065, 0.22));
  k.rbox(KM.paint, [0.14, 0.11, 0.14], 0.015, [0, 0.24, 0]);
  k.rbox(KM.paint, [0.08, 0.07, 0.46], 0.015, [0, 0.24, -0.27]);
  k.rbox(KM.paint, [0.2, 0.48, 0.05], 0.015, [0, 0.27, -0.52]);
  for (const s of [-1, 1]) k.box(KM.chrome, [0.012, 0.44, 0.012], [s * 0.06, 0.27, -0.492]);
  k.rbox(KM.paintGraphite, [0.22, 0.04, 0.11], 0.008, [0, 0.01, -0.52]);
  k.tube(KM.stainless, [[-0.05, 0.2, 0.06], [-0.1, 0.1, 0.07], [-0.115, 0.035, 0.045]], 0.006, { radial: 6 });
  hose(k, [0, 0.52, -0.03], [0.04, 0.46, -0.5], 0.012, 0.05, KM.paintGraphite);
}

function EdgeStation() {
  const cx = X.edge;
  const spin = useRef<THREE.Group>(null);
  const wheel = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const profRef = useRef<{ k: number }>({ k: -1 });
  const prof = useRef<THREE.Mesh>(null);
  const profMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8a9098', roughness: 0.4, metalness: 0.7 }), []);
  useFrame((_, dt) => {
    const active = engine.stage.id === 'edge-profiling';
    const g = active ? pp('grind') : engine.stage.id === 'edge-profiling' ? 0 : 1;
    if (spin.current) spin.current.rotation.y += pdt(dt) * (active && inPhase('grind') ? 3 : 0);
    if (wheel.current) {
      wheel.current.rotation.y -= pdt(dt) * (active && inPhase('grind') ? 18 : 0);
      wheel.current.position.x = cx + WAFER_R + 0.11 + (active && inPhase('grind') ? 0 : 0.08);
    }
    // the spindle head rides with the wheel's infeed (it does not spin)
    if (head.current) head.current.position.x = cx + WAFER_R + 0.11 + (active && inPhase('grind') ? 0 : 0.08);
    // edge cross-section: square corner → rounded bullet profile
    const k = Math.round(g * 20) / 20;
    if (prof.current && k !== profRef.current.k) {
      profRef.current.k = k;
      const pts: [number, number][] = [[-0.5, -0.12]];
      const R = 0.12 * k;
      for (let i = 0; i <= 12; i++) {
        const a = -Math.PI / 2 + (i / 12) * Math.PI;
        const x = 0.35 - R + (R > 0 ? Math.cos(a) * R : 0);
        const y = R > 0 ? Math.sin(a) * 0.12 : i < 6 ? -0.12 : 0.12;
        pts.push([R > 0 ? x : 0.35, y]);
      }
      pts.push([-0.5, 0.12]);
      const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.25, bevelEnabled: false });
      geo.translate(0, 0, -0.125);
      prof.current.geometry.dispose();
      prof.current.geometry = geo;
    }
    if (active) track('focus', cx, TABLE_Y + 0.05, 0);
  });
  const body = useModel(buildEdgeProfiler);
  const chuck = useModel(buildChuck);
  const wheelKit = useModel(buildProfileWheel);
  const headKit = useModel(buildEdgeSpindle);
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'edge-grinder', label: 'Edge profiler' }}>
        <group position={[cx, 0, 0]}>
          <Baked parts={body} />
        </group>
        <Clickable sel={{ kind: 'component', id: 'chuck', machine: 'edge-grinder', label: 'Vacuum chuck' }}>
          <group position={[cx, 0, 0]}>
            <Baked parts={chuck} />
          </group>
        </Clickable>
        <group ref={spin} position={[cx, TABLE_Y + 0.02, 0]}>
          <mesh geometry={waferGeometry()} material={followMat} />
        </group>
        <group ref={wheel} position={[cx + WAFER_R + 0.11, TABLE_Y + 0.02, 0]}>
          <Clickable sel={{ kind: 'component', id: 'profile-wheel', machine: 'edge-grinder', label: 'Profiled diamond wheel' }}>
            <Baked parts={wheelKit} />
          </Clickable>
        </group>
        <group ref={head} position={[cx + WAFER_R + 0.11, TABLE_Y + 0.02, 0]}>
          <Clickable sel={{ kind: 'component', id: 'profile-wheel', machine: 'edge-grinder', label: 'Profiled diamond wheel' }}>
            <Baked parts={headKit} />
          </Clickable>
        </group>
        <SignalTower position={[cx + 0.6, 1.0, -0.5]} />
      </Clickable>
      <Inset id="edge" position={[cx - 0.9, 2.1, 0.9]} size={[1.3, 0.85]} mpu={1.2e-3 / 1.3} title="WAFER EDGE PROFILE">
        <group position={[0, 0, 0.15]}>
          <mesh ref={prof} material={profMat} />
        </group>
      </Inset>
      <TechLabel position={[cx, TABLE_Y + 0.35, 0.25]} title="EDGE PROFILER" lines={['sharp edge → rounded bevel']} />
    </group>
  );
}

/* --------------------------------------------------------- 2/4 · double-side machines */

const castIron = new THREE.MeshStandardMaterial({ color: '#4a4e52', roughness: 0.55, metalness: 0.7 });
const padMat = new THREE.MeshStandardMaterial({ color: '#d9cfb8', roughness: 0.9, metalness: 0 });
const padGroove = new THREE.MeshStandardMaterial({ color: '#aba189', roughness: 0.95, metalness: 0 });
const carrierMat = new THREE.MeshStandardMaterial({ color: '#56724c', roughness: 0.5, metalness: 0.05 });
const DS_COL: V3 = [-1.0, 0, -0.85]; // column of the swing arm (local)

/** Lapper / polisher base: cabinet, deck, slurry trough, pin gears, column + swing arm, slurry ring, supply skid. */
function buildDoubleSide(k: Kit, kind: 'lap' | 'polish') {
  cabinet(k, { size: [2.1, 0.86, 2.1], panels: 3, rows: [0.38], sidePanels: 3, handles: true, stripe: KM.paintAccent, ao: false });
  k.rbox(KM.paintGraphite, [2.14, 0.07, 2.14], 0.012, [0, 0.917, 0]);
  // slurry trough around the plates
  k.lathe(KM.stainless, [[0.98, 0.952], [0.98, 1.09]], [0, 0, 0], [0, 0, 0], 72);
  k.lathe(KM.stainless, [[0.98, 1.09], [0.95, 1.09]], [0, 0, 0], [0, 0, 0], 72);
  k.lathe(KM.stainless, [[0.95, 1.09], [0.95, 0.958]], [0, 0, 0], [0, 0, 0], 72);
  k.lathe(KM.stainlessDark, [[0.95, 0.958], [0.84, 0.958]], [0, 0, 0], [0, 0, 0], 72);
  k.pipe(KM.stainless, [[0, 0.99, 0.97], [0, 0.99, 1.12], [0, 0.62, 1.12], [0, 0.62, 1.05]], 0.025, 0.05);
  // outer pin ring and sun gear that drive the planetary carriers
  k.cyl(KM.stainlessDark, 0.905, 0.02, [0, 0.962, 0], [0, 0, 0], 72);
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    k.cyl(KM.stainless, 0.009, 0.1, [Math.cos(a) * 0.865, 1.022, Math.sin(a) * 0.865], [0, 0, 0], 8);
  }
  k.cyl(KM.stainlessDark, 0.075, 0.09, [0, 1.0, 0], [0, 0, 0], 32);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    k.cyl(KM.stainless, 0.011, 0.08, [Math.cos(a) * 0.092, 1.02, Math.sin(a) * 0.092], [0, 0, 0], 8);
  }
  k.cyl(KM.stainless, 0.06, 0.012, [0, 1.051, 0], [0, 0, 0], 24);
  // column and swing arm carrying the upper-plate drive
  const col = DS_COL;
  k.rbox(KM.paint, [0.34, 1.75, 0.34], 0.03, [col[0], 0.952 + 0.875, col[2]]);
  for (const y of [1.45, 2.2]) k.box(KM.seam, [0.3, 0.004, 0.002], [col[0], y, col[2] + 0.1712], [0, 0, 0], { cast: false });
  k.label('warn', 'CRUSH HAZARD', '', 0.12, 0.12, [col[0], 1.75, col[2] + 0.172]);
  const yaw = Math.atan2(-col[0], -col[2]);
  const len = Math.hypot(col[0], col[2]);
  k.at([col[0] / 2, 2.45, col[2] / 2], yaw, () => {
    k.rbox(KM.paint, [0.3, 0.3, len + 0.2], 0.03, [0, 0, 0]);
    k.box(KM.paintAccent, [0.302, 0.014, len], [0, 0.08, 0], [0, 0, 0], { cast: false });
  });
  k.cyl(KM.paint, 0.24, 0.42, [0, 2.45, 0], [0, 0, 0], 48);
  k.cyl(KM.paintGraphite, 0.245, 0.03, [0, 2.675, 0], [0, 0, 0], 48);
  k.at([0, 2.69, 0], 0, () => motor(k, 0.12, 0.34));
  k.label('info', 'UPPER PLATE DRIVE', 'PNEUMATIC LOAD · 0–500 daN', 0.3, 0.075, [0, 2.45, 0.243]);
  k.cyl(KM.stainless, 0.12, 0.44, [0, 2.02, 0], [0, 0, 0], 40);
  k.cyl(KM.stainless, 0.135, 0.02, [0, 2.23, 0], [0, 0, 0], 40);
  bellows(k, 0.11, 0.08, 5, [0, 1.72, 0], KM.paintGraphite);
  // slurry distribution ring with drip nozzles
  k.torus(KM.ptfe, 0.3, 0.014, [0, 1.92, 0], [0, 0, 0], 48);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    k.cyl(KM.ptfe, 0.008, 0.05, [Math.cos(a) * 0.3, 1.89, Math.sin(a) * 0.3], [0, 0, 0], 8);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    k.box(KM.stainless, [0.18, 0.012, 0.02], [Math.cos(a) * 0.21, 1.93, Math.sin(a) * 0.21], [0, -a, 0]);
  }
  k.pipe(KM.ptfe, [[-0.8, 0.96, -0.66], [-0.8, 2.27, -0.66], [-0.25, 2.27, -0.2125], [-0.215, 1.935, -0.2]], 0.012, 0.06);
  // nameplate, controls
  k.label('model', kind === 'lap' ? 'DSL-9' : 'DSP-9', kind === 'lap' ? 'DOUBLE-SIDE LAPPER · PLANETARY' : 'DOUBLE-SIDE POLISHER · PLANETARY', 0.44, 0.1, [0.3, 0.72, 1.052]);
  k.label('warn', 'PINCH POINT', '', 0.12, 0.12, [-0.72, 0.72, 1.052]);
  estop(k, [-0.32, 0.72, 1.05]);
  ledStrip(k, 0.6, [0.55, 0.917, 1.071]);
  hmiPedestal(k, [1.25, 1.55, 1.05], -0.6);
  // slurry supply skid behind the machine
  k.at([1.6, 0, -1.3], 0, () => {
    for (const [x, z] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) k.box(KM.stainless, [0.04, 0.1, 0.04], [x, 0.05, z]);
    k.rbox(KM.stainless, [0.72, 0.04, 0.72], 0.008, [0, 0.12, 0]);
    k.cyl(KM.plasticWhite, 0.26, 0.72, [-0.08, 0.5, 0], [0, 0, 0], 40);
    k.cyl(KM.stainless, 0.272, 0.03, [-0.08, 0.875, 0], [0, 0, 0], 40);
    for (const y of [0.3, 0.6]) k.torus(KM.stainless, 0.262, 0.005, [-0.08, y, 0], [0, 0, 0], 40);
    k.at([-0.08, 0.89, 0], 0, () => motor(k, 0.06, 0.18));
    k.at([0.22, 0.14, 0.2], 0, () => motor(k, 0.06, 0.16, KM.paintBlue));
    k.label('info', kind === 'lap' ? 'Al₂O₃ SLURRY' : 'SiO₂ SLURRY', 'AGITATED · 25 °C', 0.26, 0.065, [-0.08, 0.55, 0.262]);
  });
  k.pipe(KM.ptfe, [[1.36, 0.5, -1.25], [-0.75, 0.5, -1.25], [-0.75, 1.1, -1.25], [-0.75, 1.1, -1.03]], 0.014, 0.08);
  k.ao(2.4, 2.4, [0, 0, 0], 1.15);
  k.ao(0.75, 0.75, [1.6, 0, -1.3]);
}

/** Grid of grooves over an annulus (lap plate / pad), at height y. */
function grooveGrid(k: Kit, m: THREE.Material, RI: number, RO: number, step: number, y: number) {
  for (let c = -RO + step / 2; c < RO; c += step) {
    const outer = Math.sqrt(Math.max(0, RO * RO - c * c)) - 0.012;
    if (outer <= 0.02) continue;
    const segs: [number, number][] = Math.abs(c) < RI + 0.01 ? [[-outer, -Math.sqrt(Math.max(0, (RI + 0.01) ** 2 - c * c))], [Math.sqrt(Math.max(0, (RI + 0.01) ** 2 - c * c)), outer]] : [[-outer, outer]];
    for (const [a, b] of segs) {
      if (b - a < 0.02) continue;
      k.box(m, [b - a, 0.0012, 0.004], [(a + b) / 2, y, c], [0, 0, 0], { cast: false });
      k.box(m, [0.004, 0.0012, b - a], [c, y, (a + b) / 2], [0, 0, 0], { cast: false });
    }
  }
}

/** Lower plate (rotates): annular cast-iron lap plate, or stainless platen with a polishing pad. */
function buildLowerPlate(k: Kit, kind: 'lap' | 'polish') {
  const face = kind === 'lap' ? castIron : padMat;
  const body = kind === 'lap' ? castIron : KM.stainless;
  const RI = 0.12;
  const RO = 0.82;
  k.lathe(face, [[RO, 0.03], [RI, 0.03]], [0, 0, 0], [0, 0, 0], 96);
  k.lathe(body, [[RO, -0.03], [RO, kind === 'lap' ? 0.03 : 0.022]], [0, 0, 0], [0, 0, 0], 96);
  if (kind === 'polish') k.lathe(padMat, [[RO, 0.022], [RO, 0.03]], [0, 0, 0], [0, 0, 0], 96);
  k.lathe(body, [[RI, 0.03], [RI, -0.03]], [0, 0, 0], [0, 0, 0], 48);
  grooveGrid(k, kind === 'lap' ? KM.seam : padGroove, RI, RO, kind === 'lap' ? 0.08 : 0.06, 0.0306);
}

/** Upper plate (rises and counter-rotates): annular plate, ribs, hub, gimbal, shaft, slurry inlets. */
function buildUpperPlate(k: Kit, kind: 'lap' | 'polish') {
  const face = kind === 'lap' ? castIron : padMat;
  const body = kind === 'lap' ? castIron : KM.stainless;
  const RI = 0.14;
  const RO = 0.82;
  k.lathe(face, [[RI, -0.04], [RO, -0.04]], [0, 0, 0], [0, 0, 0], 96);
  k.lathe(body, [[RO, -0.04], [RO, 0.04]], [0, 0, 0], [0, 0, 0], 96);
  k.lathe(body, [[RO, 0.04], [RI, 0.04]], [0, 0, 0], [0, 0, 0], 96);
  k.lathe(body, [[RI, 0.04], [RI, -0.04]], [0, 0, 0], [0, 0, 0], 48);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.rbox(KM.paint, [0.5, 0.06, 0.04], 0.01, [Math.cos(a) * 0.41, 0.07, Math.sin(a) * 0.41], [0, -a, 0]);
    const b = a + Math.PI / 6;
    for (const r of [0.35, 0.55]) k.cyl(KM.seam, 0.012, 0.003, [Math.cos(b) * r, 0.0415, Math.sin(b) * r], [0, 0, 0], 12);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    k.cyl(KM.ptfe, 0.03, 0.035, [Math.cos(a) * 0.3, 0.058, Math.sin(a) * 0.3], [0, 0, 0], 16, { top: 1.4 });
  }
  k.cyl(KM.paint, 0.16, 0.1, [0, 0.09, 0], [0, 0, 0], 40);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    k.cyl(KM.stainlessDark, 0.008, 0.01, [Math.cos(a) * 0.125, 0.145, Math.sin(a) * 0.125], [0, 0, 0], 6);
  }
  k.cyl(KM.stainlessDark, 0.1, 0.05, [0, 0.165, 0], [0, 0, 0], 32);
  k.cyl(KM.chrome, 0.08, 0.66, [0, 0.47, 0], [0, 0, 0], 32);
}

let _carrierGeo: THREE.BufferGeometry | null = null;
/** Planetary carrier: thin epoxy-glass gear with one centre and three outer wafer pockets. */
function carrierGeometry() {
  if (_carrierGeo) return _carrierGeo;
  const T = 60;
  const Ro = 0.34;
  const Rr = 0.326;
  const s = new THREE.Shape();
  for (let i = 0; i < T; i++) {
    const a = (i / T) * Math.PI * 2;
    const da = (Math.PI * 2) / T;
    const pts: [number, number][] = [[Rr, a], [Ro, a + da * 0.22], [Ro, a + da * 0.5], [Rr, a + da * 0.72]];
    pts.forEach(([r, t], j) => (i === 0 && j === 0 ? s.moveTo(Math.cos(t) * r, Math.sin(t) * r) : s.lineTo(Math.cos(t) * r, Math.sin(t) * r)));
  }
  s.closePath();
  const hole = (x: number, y: number, r: number) => s.holes.push(new THREE.Path().absarc(x, y, r, 0, Math.PI * 2, true));
  hole(0, 0, 0.093);
  for (const a of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) hole(Math.cos(a) * 0.2, Math.sin(a) * 0.2, 0.093);
  for (const a of [Math.PI / 3, Math.PI, (5 * Math.PI) / 3]) hole(Math.cos(a) * 0.245, Math.sin(a) * 0.245, 0.022);
  _carrierGeo = new THREE.ExtrudeGeometry(s, { depth: 0.006, bevelEnabled: false, curveSegments: 28 });
  return _carrierGeo;
}

function buildCarrier(k: Kit) {
  k.add(carrierMat, carrierGeometry(), [0, -0.003, 0], [-Math.PI / 2, 0, 0]);
  for (const a of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) k.cyl(M.siRough, 0.09, 0.0008, [Math.cos(a) * 0.2, 0.004, -Math.sin(a) * 0.2], [0, 0, 0], 48);
}

function DoubleSide({ cx, kind }: { cx: number; kind: 'lap' | 'polish' }) {
  const lower = useRef<THREE.Group>(null);
  const upper = useRef<THREE.Group>(null);
  const carriers = useRef<THREE.Group>(null);
  const drops = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const stageId = kind === 'lap' ? 'lapping' : 'polishing';
  const ang = useRef(0);
  useFrame((_, dt) => {
    const active = engine.stage.id === stageId;
    const working = active && (inPhase('lap') || inPhase('stock') || inPhase('final'));
    ang.current += pdt(dt) * (working ? 1 : 0);
    if (lower.current) lower.current.rotation.y = ang.current * 1.4;
    if (upper.current) {
      upper.current.rotation.y = -ang.current * 1.1;
      const down = working || (active && !inPhase('load') && !inPhase('measure') && !inPhase('unload')) ? 1 : 0;
      upper.current.position.y = TABLE_Y + 0.07 + (1 - down) * 0.45;
    }
    if (carriers.current) {
      carriers.current.rotation.y = ang.current * 0.5;
      carriers.current.children.forEach((c, i) => {
        c.rotation.y = -ang.current * 2.2 + i;
      });
    }
    if (drops.current) {
      for (let i = 0; i < 24; i++) {
        const u = (engine.time * 1.4 + i / 24) % 1;
        o.position.set(cx - 0.25 + (i % 6) * 0.1, TABLE_Y + 0.9 - u * 0.75, -0.3 + (i % 4) * 0.2);
        o.scale.setScalar(working ? 0.012 : 0.0001);
        o.updateMatrix();
        drops.current.setMatrixAt(i, o.matrix);
      }
      drops.current.instanceMatrix.needsUpdate = true;
    }
    if (active) track('focus', cx, TABLE_Y + 0.1, 0);
  });
  const machine = kind === 'lap' ? 'lapper' : 'dsp-polisher';
  const body = useModel((k) => buildDoubleSide(k, kind), [kind]);
  const lowerKit = useModel((k) => buildLowerPlate(k, kind), [kind]);
  const upperKit = useModel((k) => buildUpperPlate(k, kind), [kind]);
  const carrierKit = useModel(buildCarrier);
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: machine, label: kind === 'lap' ? 'Double-side lapper' : 'Double-side polisher' }}>
        <group position={[cx, 0, 0]}>
          <Baked parts={body} />
        </group>
        <group ref={lower} position={[cx, TABLE_Y, 0]}>
          <Clickable sel={{ kind: 'component', id: kind === 'lap' ? 'plates' : 'pads', machine, label: kind === 'lap' ? 'Lower plate' : 'Lower pad' }}>
            <Baked parts={lowerKit} />
          </Clickable>
        </group>
        <group ref={carriers} position={[cx, TABLE_Y + 0.035, 0]}>
          {[0, 1, 2, 3].map((k) => {
            const a = (k / 4) * Math.PI * 2;
            return (
              <group key={k} position={[Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45]}>
                <Clickable sel={{ kind: 'component', id: 'carriers', machine, label: 'Planetary carrier' }}>
                  <Baked parts={carrierKit} />
                  <mesh geometry={waferGeometry(0.15)} material={k === 0 ? followMat : M.siRough} position={[0.0, 0.004, 0]} scale={0.6} />
                </Clickable>
              </group>
            );
          })}
        </group>
        <group ref={upper} position={[cx, TABLE_Y + 0.5, 0]}>
          <Baked parts={upperKit} />
        </group>
        <SignalTower position={[cx + 0.9, TABLE_Y - 0.05, -0.9]} />
      </Clickable>
      <instancedMesh ref={drops} args={[GEO.sphereLow, slurryMat, 24]} />
      <SensorIndicator id="downforce" channel={kind === 'lap' ? undefined : 'force'} machine={machine} position={[cx, TABLE_Y + 1.15, 0.15]} size={0.07} />
      <TechLabel position={[cx, TABLE_Y + 1.25, 0.3]} title={kind === 'lap' ? 'DOUBLE-SIDE LAPPING · Al₂O₃ ABRASIVE' : 'DOUBLE-SIDE POLISHING · COLLOIDAL SILICA'} value={() => (kind === 'lap' ? `thickness ${engine.tele.value('thick', 925).toFixed(1)} µm · Ra ${engine.tele.value('ra', 1.5).toFixed(2)} µm` : `thickness ${engine.tele.value('thick', 775).toFixed(1)} µm · roughness ${engine.tele.value('rough', 0.2).toFixed(1)} nm`)} />
      <RoughnessInset
        id={`rough-${kind}`}
        position={[cx - 0.9, 2.1, 0.9]}
        mpu={kind === 'lap' ? 2e-5 / 1.3 : 1e-6 / 1.3}
        title={kind === 'lap' ? 'SURFACE PROFILE · ~20 µm FIELD' : 'SURFACE PROFILE · ~1 µm FIELD'}
        amp={() => (engine.stage.id === stageId ? (kind === 'lap' ? engine.tele.value('ra', 1.5) / 1.5 : Math.min(1, engine.tele.value('rough', 250) / 250)) : kind === 'lap' ? 0.17 : 0.001)}
      />
    </group>
  );
}

/* --------------------------------------------------------- wet benches (etch + clean) */

interface BenchOpts {
  w: number;
  d: number;
  zc: number;
  lowerH: number;
  deckY: number;
  topY: number;
  tanks: number[];
  tankW: number;
  canopy: boolean;
  model: [string, string];
  chem: [string, string][];
  tags: [string, string][];
}

const BEAM_Y = 2.32;
const BEAM_Z = -0.44;

/** Wet bench: PP cabinet, glazed tank bay, deck with tank openings and weirs, lids, exhaust plenum, chemical lines, gantry beam. */
function buildWetBench(k: Kit, o: BenchOpts) {
  const { w, d, zc, lowerH, deckY, topY, tankW } = o;
  const zf = zc + d / 2;
  const zb = zc - d / 2;
  const capY = lowerH + 0.022;
  const hw = tankW / 2 + 0.02;
  k.at([0, 0, zc], 0, () => cabinet(k, { size: [w, lowerH, d], body: KM.plasticWhite, trim: KM.paintGrey, panels: Math.round(w / 0.6), rows: [], handles: true, stripe: KM.paintAccent, ao: false }));
  // tank bay: side and back walls, PVC viewing window in front
  const uh = deckY - capY;
  for (const s of [-1, 1]) k.box(KM.plasticWhite, [0.04, uh, d], [s * (w / 2 - 0.02), capY + uh / 2, zc]);
  k.box(KM.plasticWhite, [w, uh, 0.04], [0, capY + uh / 2, zb + 0.02]);
  windowPane(k, w - 0.12, uh - 0.05, [0, capY + uh / 2, zf - 0.016], { frame: KM.plasticWhite, glass: KM.glass });
  // deck with tank openings, bullnose edge, PTFE weir lips
  const deck = new THREE.Shape();
  deck.moveTo(-w / 2, -zf);
  deck.lineTo(w / 2, -zf);
  deck.lineTo(w / 2, -zb);
  deck.lineTo(-w / 2, -zb);
  deck.closePath();
  for (const tx of o.tanks) {
    const h = new THREE.Path();
    h.moveTo(tx - hw, -hw);
    h.lineTo(tx - hw, hw);
    h.lineTo(tx + hw, hw);
    h.lineTo(tx + hw, -hw);
    h.closePath();
    deck.holes.push(h);
  }
  const dg = new THREE.ExtrudeGeometry(deck, { depth: 0.03, bevelEnabled: false });
  k.add(KM.plasticWhite, dg, [0, deckY, 0], [-Math.PI / 2, 0, 0]);
  dg.dispose();
  k.cyl(KM.plasticWhite, 0.02, w, [0, deckY + 0.015, zf], RX, 14);
  for (const tx of o.tanks)
    for (const s of [-1, 1]) {
      k.box(KM.ptfe, [hw * 2, 0.012, 0.02], [tx, deckY + 0.036, s * (hw - 0.01)]);
      k.box(KM.ptfe, [0.02, 0.012, hw * 2 - 0.04], [tx + s * (hw - 0.01), deckY + 0.036, 0]);
    }
  // exhaust plenum with slots, back panel with service seams
  k.rbox(KM.plasticWhite, [w, 0.22, 0.13], 0.015, [0, deckY + 0.14, zb + 0.065]);
  for (let i = 0; i < 3; i++) k.box(KM.seam, [w - 0.16, 0.012, 0.003], [0, deckY + 0.09 + i * 0.05, zb + 0.1315], [0, 0, 0], { cast: false });
  const by0 = deckY + 0.25;
  k.box(KM.plasticWhite, [w, topY - by0, 0.04], [0, (by0 + topY) / 2, zb + 0.02]);
  for (let x = -w / 2 + 0.8; x < w / 2 - 0.1; x += 0.8) k.box(KM.seam, [0.004, topY - by0 - 0.06, 0.002], [x, (by0 + topY) / 2, zb + 0.041], [0, 0, 0], { cast: false });
  // tank lids (open), chemical feed lines with valves and line tags
  o.tanks.forEach((tx, i) => {
    k.at([tx, deckY + 0.03, zb + 0.16], [-0.1, 0, 0], () => {
      k.rbox(KM.plasticWhite, [tankW + 0.02, tankW, 0.022], 0.006, [0, tankW / 2, 0]);
      k.rbox(KM.ptfe, [0.2, 0.025, 0.03], 0.008, [0, tankW - 0.06, 0.025]);
      const t = o.tags[i];
      if (t) k.label('tag', t[0], t[1], 0.3, 0.075, [0, tankW * 0.55, 0.0115]);
    });
    const px = tx + hw + 0.03;
    k.pipe(KM.ptfe, [[px, by0 + 0.55, zb + 0.06], [px, deckY + 0.28, zb + 0.06], [px, deckY + 0.28, -hw + 0.04], [tx + hw - 0.05, deckY + 0.28, -hw + 0.04], [tx + hw - 0.05, deckY - 0.1, -hw + 0.04]], 0.01, 0.04);
    k.rbox(KM.ptfe, [0.04, 0.06, 0.04], 0.006, [px, by0 + 0.35, zb + 0.06]);
    k.rbox(KM.paintBlue, [0.012, 0.012, 0.06], 0.004, [px, by0 + 0.39, zb + 0.09]);
    const c = o.chem[i];
    if (c) k.label('gas', c[0], '', 0.13, 0.028, [px, by0 + 0.48, zb + 0.072], [0, 0, 0], c[1]);
  });
  // exhaust ducts to the ceiling
  for (const x of o.canopy ? [-w / 2 + 0.5, w / 2 - 0.5] : [w / 2 - 0.35]) {
    k.cyl(KM.paintGrey, 0.11, 4.15 - deckY, [x, (deckY + 4.15) / 2, zb - 0.14], [0, 0, 0], 28);
    k.rbox(KM.paintGrey, [0.26, 0.2, 0.18], 0.02, [x, deckY + 0.5, zb - 0.1]);
    for (const y of [deckY + 1.2, 3.4]) k.torus(KM.paintGrey, 0.113, 0.01, [x, y, zb - 0.14], [0, 0, 0], 28);
  }
  // gantry beam for the transfer robot
  k.rbox(KM.paintGrey, [w + 0.1, 0.12, 0.14], 0.012, [0, BEAM_Y, BEAM_Z]);
  k.box(KM.seam, [w + 0.08, 0.004, 0.002], [0, BEAM_Y + 0.03, BEAM_Z + 0.0705], [0, 0, 0], { cast: false });
  k.box(KM.chrome, [w, 0.02, 0.01], [0, BEAM_Y - 0.02, BEAM_Z + 0.072]);
  for (const s of [-1, 1]) k.rbox(KM.anodizedDark, [0.06, 0.16, 0.16], 0.008, [s * (w / 2 + 0.03), BEAM_Y, BEAM_Z - 0.03]);
  if (o.canopy) {
    // FFU canopy with filter grille and task lights
    k.rbox(KM.plasticWhite, [w, 0.25, 1.0], 0.02, [0, 2.6, -0.1]);
    k.at([0, 2.473, -0.15], [Math.PI / 2, 0, 0], () => grille(k, w - 0.4, 0.62, [0, 0, 0], { m: KM.plasticWhite, pitch: 0.04 }));
    k.box(KM.ledWhite, [w - 0.3, 0.012, 0.04], [0, 2.472, 0.3], [0, 0, 0], { cast: false });
    ledStrip(k, 0.8, [w / 2 - 0.7, 2.62, 0.402]);
    k.label('model', o.model[0], o.model[1], 0.46, 0.1, [-w / 2 + 0.6, 2.6, 0.401]);
    for (const s of [-1, 1]) k.rbox(KM.paintGrey, [0.05, 2.47 - capY, 0.05], 0.008, [s * (w / 2 - 0.025), (capY + 2.47) / 2, 0.37]);
    // HMI hanging from the canopy
    const hp: V3 = [w / 2 - 0.45, 1.85, 0.62];
    hmi(k, hp, -0.25);
    k.cyl(KM.anodizedDark, 0.022, 2.475 - hp[1], [hp[0] + 0.22 * Math.sin(-0.25), (hp[1] + 2.475) / 2, hp[2] - 0.22 * Math.cos(-0.25)], [0, 0, 0], 12);
  } else {
    k.label('model', o.model[0], o.model[1], 0.42, 0.1, [-w / 2 + 0.55, 0.47, zf + 0.002]);
    hmiPedestal(k, [w / 2 + 0.28, 1.5, zf + 0.1], -0.45);
  }
  k.label('warn', 'CORROSIVE', '', 0.11, 0.11, [w / 2 - 0.18, capY + uh / 2, zf + 0.004]);
  estop(k, [-w / 2 + 0.14, 0.47, zf]);
  k.ao(w + 0.1, d + 0.1, [0, 0, zc], 1.12);
}

/** Quartz process tank: open-top box of thin walls (bottom at y0). */
function buildQuartzTank(k: Kit, w: number, h: number, y0: number) {
  const t = 0.008;
  k.box(M.quartz, [w, t, w], [0, y0 + t / 2, 0], [0, 0, 0], { cast: false });
  for (const s of [-1, 1]) {
    k.box(M.quartz, [w, h, t], [0, y0 + h / 2, s * (w / 2 - t / 2)], [0, 0, 0], { cast: false });
    k.box(M.quartz, [t, h, w - 2 * t], [s * (w / 2 - t / 2), y0 + h / 2, 0], [0, 0, 0], { cast: false });
  }
}

/** Robot carriage (follows the carrier along the gantry): carriage block, arm, Z-axis housing the hanger runs in. */
function buildBenchRobot(k: Kit, armZ: number, y0: number, y1: number) {
  k.rbox(KM.anodizedDark, [0.26, 0.2, 0.1], 0.015, [0, BEAM_Y, BEAM_Z + 0.12]);
  const a0 = BEAM_Z + 0.17;
  const a1 = armZ - 0.05;
  if (a1 > a0) k.rbox(KM.paint, [0.12, 0.09, a1 - a0 + 0.02], 0.012, [0, BEAM_Y, (a0 + a1) / 2]);
  k.rbox(KM.paint, [0.1, y1 - y0, 0.1], 0.015, [0, (y0 + y1) / 2, armZ]);
  k.box(KM.seam, [0.02, y1 - y0 - 0.06, 0.002], [0, (y0 + y1) / 2, armZ + 0.051], [0, 0, 0], { cast: false });
  k.box(KM.paintAccent, [0.102, 0.02, 0.102], [0, y1 - 0.04, armZ], [0, 0, 0], { cast: false });
  hose(k, [0.1, BEAM_Y + 0.1, BEAM_Z + 0.1], [0.32, BEAM_Y + 0.07, BEAM_Z - 0.02], 0.012, 0.05, KM.paintGraphite);
}

/* --------------------------------------------------------- 3 · etch bath */

const ETCH_TANKS = [-0.55, 0.55];
const ETCH_BENCH: BenchOpts = {
  w: 2.3,
  d: 1.0,
  zc: -0.05,
  lowerH: 0.578,
  deckY: TABLE_Y + 0.1,
  topY: 2.45,
  tanks: ETCH_TANKS,
  tankW: 0.6,
  canopy: false,
  model: ['WB-2', 'ACID ETCH · QUENCH RINSE'],
  chem: [['HF/HNO₃', '#a8742b'], ['UPW', '#2f5d8a']],
  tags: [['TANK 1 · ETCH', 'HF / HNO₃ / CH₃COOH'], ['TANK 2 · QDR', 'UPW · 18 MΩ·cm']],
};

/** Process cassette (wafers on edge): PTFE end plates, rails, comb, hanger rod. */
function buildCassette(k: Kit) {
  for (const s of [-1, 1]) {
    k.rbox(KM.ptfe, [0.014, 0.34, 0.3], 0.005, [s * 0.172, 0.02, 0]);
    k.rbox(KM.ptfe, [0.36, 0.04, 0.04], 0.008, [0, 0.17, s * 0.12]);
    k.cyl(KM.ptfe, 0.012, 0.34, [0, -0.12, s * 0.07], RX, 12);
    k.cyl(KM.ptfe, 0.012, 0.34, [0, -0.02, s * 0.14], RX, 12);
    for (let i = 0; i < 9; i++) k.box(KM.ptfe, [0.006, 0.02, 0.02], [-0.16 + i * 0.04, -0.104, s * 0.07]);
  }
  k.box(KM.stainless, [0.03, 0.7, 0.03], [0, 0.5, -0.12]);
  k.rbox(KM.stainless, [0.07, 0.04, 0.05], 0.008, [0, 0.2, -0.12]);
}

function EtchStation() {
  const cx = X.etch;
  const cassette = useRef<THREE.Group>(null);
  const robot = useRef<THREE.Group>(null);
  const bubbles = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const tanks = useMemo(
    () => [
      { x: cx + ETCH_TANKS[0], label: 'ACID ETCH (HF/HNO₃)', mat: liquid('#c8d6a4', 0.5) },
      { x: cx + ETCH_TANKS[1], label: 'QUENCH RINSE (UPW)', mat: liquid('#cfe6ea', 0.35) },
    ],
    [cx],
  );
  useFrame(() => {
    const active = engine.stage.id === 'chemical-etch';
    const imm = active ? pp('immerse') : 1;
    const rinse = active ? pp('rinse') : 1;
    const dry = active ? pp('dry') : 1;
    let x = tanks[0].x;
    let y = TABLE_Y + 0.55;
    if (active) {
      if (rinse > 0 && rinse < 1) {
        const m = smooth(clamp(rinse * 3));
        x = lerp(tanks[0].x, tanks[1].x, m);
        y = TABLE_Y + 0.55 - Math.sin(Math.PI * clamp(rinse * 3)) * -0.4 - (rinse > 0.33 ? 0.45 : 0);
      } else if (dry > 0) {
        x = tanks[1].x;
        y = TABLE_Y + 0.1 + smooth(dry) * 0.55;
      } else {
        x = tanks[0].x;
        y = TABLE_Y + 0.55 - smooth(imm) * 0.45;
      }
    } else {
      x = tanks[1].x;
      y = TABLE_Y + 0.65;
    }
    if (cassette.current) cassette.current.position.set(x, y, 0);
    // the robot carriage runs along the gantry with the cassette
    if (robot.current) robot.current.position.x = x;
    if (bubbles.current) {
      const on = active && inPhase('etch');
      for (let i = 0; i < 40; i++) {
        const u = (engine.time * 0.7 + i / 40) % 1;
        o.position.set(tanks[0].x - 0.18 + (i % 7) * 0.06, TABLE_Y - 0.3 + u * 0.38, -0.15 + (i % 5) * 0.07);
        o.scale.setScalar(on ? 0.012 + 0.006 * (1 - u) : 0.0001);
        o.updateMatrix();
        bubbles.current.setMatrixAt(i, o.matrix);
      }
      bubbles.current.instanceMatrix.needsUpdate = true;
    }
    if (active) track('focus', x, y, 0);
  });
  const bench = useModel((k) => buildWetBench(k, ETCH_BENCH));
  const tank = useModel((k) => buildQuartzTank(k, 0.6, 0.5, TABLE_Y - 0.4));
  const cas = useModel(buildCassette);
  const bot = useModel((k) => buildBenchRobot(k, -0.12, 1.9, 2.4));
  const bubbleMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#f2f6e8', transparent: true, opacity: 0.8 }), []);
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'etch-bath', label: 'Wet chemical etch station' }}>
        <group position={[cx, 0, 0]}>
          <Baked parts={bench} />
        </group>
        {tanks.map((t) => (
          <Clickable key={t.x} sel={{ kind: 'component', id: 'tanks', machine: 'etch-bath', label: t.label }}>
            <group position={[t.x, 0, 0]}>
              <Baked parts={tank} />
            </group>
            <mesh position={[t.x, TABLE_Y - 0.17, 0]} material={t.mat}>
              <boxGeometry args={[0.56, 0.42, 0.56]} />
            </mesh>
          </Clickable>
        ))}
        <group ref={robot} position={[tanks[1].x, 0, 0]}>
          <Baked parts={bot} />
        </group>
      </Clickable>
      <group ref={cassette}>
        <Clickable sel={{ kind: 'component', id: 'cassette', machine: 'etch-bath', label: 'Process cassette (wafers on edge)' }}>
          <Baked parts={cas} />
          {Array.from({ length: 8 }, (_, i) => (
            <mesh key={i} geometry={waferGeometry(0.15)} material={i === 3 ? followMat : M.siRough} position={[-0.14 + i * 0.04, 0.0, 0]} rotation={[0, 0, Math.PI / 2]} scale={0.95} />
          ))}
        </Clickable>
      </group>
      <instancedMesh ref={bubbles} args={[GEO.sphereLow, bubbleMat, 40]} />
      <SensorIndicator id="thermocouple" channel="bath" machine="etch-bath" position={[tanks[0].x + 0.33, TABLE_Y, 0.2]} size={0.06} />
      <SensorIndicator id="conductivity" machine="etch-bath" position={[tanks[1].x + 0.33, TABLE_Y, 0.2]} size={0.06} />
      <TechLabel position={[tanks[0].x, TABLE_Y + 0.25, 0.35]} title="ACID ETCH" lines={['dissolves the cracked surface layer']} />
      <TechLabel position={[tanks[1].x, TABLE_Y + 0.25, 0.35]} title="RINSE" />
      <RoughnessInset
        id="damage"
        position={[cx - 0.9, 2.1, 0.9]}
        mpu={2e-5 / 1.3}
        title="SUB-SURFACE DAMAGE LAYER"
        amp={() => 0.2}
        layers={() => ({ damage: engine.stage.id === 'chemical-etch' ? engine.tele.value('damage', 12) / 12 : engine.stage.id === 'lapping' ? 1 : 0 })}
      />
    </group>
  );
}

/* --------------------------------------------------------- 5 · wet clean bench */

const CLEAN_TANKS = [
  { id: 'sc1', label: 'SC-1 + MEGASONICS', color: '#cfe0b8' },
  { id: 'rinse1', label: 'UPW RINSE', color: '#d6eaf0' },
  { id: 'sc2', label: 'SC-2', color: '#e6dcb0' },
  { id: 'rinse2', label: 'UPW RINSE', color: '#d6eaf0' },
  { id: 'hf', label: 'DILUTE HF', color: '#dfe8d6' },
  { id: 'dry', label: 'MARANGONI DRY', color: '#eef2ea' },
];

const CLEAN_BENCH: BenchOpts = {
  w: 4.8,
  d: 1.05,
  zc: -0.05,
  lowerH: 0.618,
  deckY: TABLE_Y + 0.12,
  topY: 2.475,
  tanks: CLEAN_TANKS.map((_, i) => -1.75 + i * 0.7),
  tankW: 0.6,
  canopy: true,
  model: ['WCS-6', 'WET CLEAN STATION · RCA SEQUENCE'],
  chem: [['SC-1', '#3e7d4c'], ['UPW', '#2f5d8a'], ['SC-2', '#8a6a2f'], ['UPW', '#2f5d8a'], ['HF 1 %', '#a8742b'], ['IPA / N₂', '#5a5f66']],
  tags: [['T1 · SC-1', 'NH₄OH:H₂O₂:H₂O · 75 °C'], ['T2 · QDR', 'UPW OVERFLOW'], ['T3 · SC-2', 'HCl:H₂O₂:H₂O · 70 °C'], ['T4 · QDR', 'UPW OVERFLOW'], ['T5 · DHF', 'HF 1 % · 23 °C'], ['T6 · DRYER', 'MARANGONI · IPA']],
};

/** Chemical dispense cabinet at the end of the clean bench: drums behind a window, tagged lines. */
function buildChemCabinet(k: Kit) {
  cabinet(k, { size: [0.66, 2.0, 0.9], body: KM.plasticWhite, trim: KM.paintGrey, panels: 1, rows: [0.5], vent: true, stripe: KM.paintAccent, ao: false });
  k.box(KM.seam, [0.5, 1.05, 0.004], [0, 1.25, 0.451], [0, 0, 0], { cast: false });
  windowPane(k, 0.5, 1.05, [0, 1.25, 0.47], { frame: KM.plasticWhite, glass: KM.glass });
  for (const [x, m] of [[-0.12, KM.plasticWhite], [0.13, KM.paintBlue]] as const) {
    k.cyl(m, 0.1, 0.42, [x, 0.95, 0.15], [0, 0, 0], 28);
    k.cyl(KM.paintGraphite, 0.03, 0.03, [x, 1.175, 0.15], [0, 0, 0], 12);
  }
  gasPanelRow(k);
  k.label('info', 'CHEMICAL SUPPLY', 'NH₄OH · H₂O₂ · HCl · HF', 0.4, 0.1, [0, 1.9, 0.452]);
  k.ao(0.66, 0.9);
}

function gasPanelRow(k: Kit) {
  for (let i = 0; i < 3; i++) {
    const y = 1.55 + i * 0.09;
    k.cyl(KM.ptfe, 0.009, 0.4, [0, y, 0.2], RX, 8);
    k.rbox(KM.ptfe, [0.04, 0.05, 0.04], 0.006, [-0.1 + i * 0.1, y, 0.2]);
  }
}

/** Wafer hanger + end effector of the clean-bench robot (moves with the carrier). */
function buildCleanHanger(k: Kit) {
  k.box(KM.stainless, [0.05, 0.66, 0.05], [0, 0.33, -0.25]);
  k.rbox(KM.ptfe, [0.16, 0.014, 0.04], 0.004, [0, -0.008, -0.235]);
  for (const s of [-1, 1]) {
    k.rbox(KM.ptfe, [0.02, 0.012, 0.22], 0.004, [s * 0.06, -0.008, -0.13]);
    k.cyl(KM.ptfe, 0.008, 0.02, [s * 0.06, 0.0, -0.03], [0, 0, 0], 10);
  }
}

function buildMegasonic(k: Kit) {
  k.rbox(KM.stainlessDark, [0.5, 0.04, 0.5], 0.006, [0, TABLE_Y - 0.379, 0]);
  k.pipe(KM.paintGraphite, [[0.2, TABLE_Y - 0.38, -0.25], [0.2, TABLE_Y - 0.38, -0.5], [0.2, TABLE_Y - 0.2, -0.5]], 0.014, 0.04);
}

function CleanBench() {
  const cx = X.clean;
  const carrier = useRef<THREE.Group>(null);
  const robot = useRef<THREE.Group>(null);
  const particles = useRef<THREE.InstancedMesh>(null);
  const ions = useRef<THREE.InstancedMesh>(null);
  const oxide = useRef<THREE.Mesh>(null);
  const ripples = useRef<THREE.Mesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const seeds = useMemo(() => {
    const r = rng(77);
    return Array.from({ length: 64 }, () => ({ a: r() * Math.PI * 2, d: Math.sqrt(r()) * 0.13, h: r() }));
  }, []);
  const tx = (i: number) => cx - 1.75 + i * 0.7;
  useFrame(() => {
    const active = engine.stage.id === 'wafer-clean';
    const v = engine.player.view;
    const i = active ? Math.max(0, CLEAN_TANKS.findIndex((t) => t.id === v.phaseId)) : 5;
    const p = active ? v.phaseT : 1;
    // carrier: lift out of previous tank, travel, dip into the current tank
    const x = tx(i);
    const dip = active ? smooth(clamp(p * 4)) * (1 - smooth(clamp((p - 0.85) / 0.15))) : 0;
    if (carrier.current) carrier.current.position.set(x, TABLE_Y + 0.75 - dip * 0.55, 0);
    // the robot carriage runs along the gantry with the carrier
    if (robot.current) robot.current.position.x = x;
    // particle count follows telemetry; particles lift off and float away as they are removed
    const count = active ? engine.tele.value('particles', 300) : 8;
    const shown = Math.round((count / 320) * 64);
    if (particles.current) {
      seeds.forEach((s, k) => {
        const leaving = k >= shown;
        const lift = leaving ? clamp((engine.time * 0.4 + s.h) % 1) * 0.3 : 0;
        o.position.set(Math.cos(s.a) * s.d, 0.006 + lift, Math.sin(s.a) * s.d);
        o.scale.setScalar(leaving && lift > 0.25 ? 0.0001 : 0.006 + s.h * 0.004);
        o.updateMatrix();
        particles.current!.setMatrixAt(k, o.matrix);
      });
      particles.current.instanceMatrix.needsUpdate = true;
    }
    if (ions.current) {
      const sc2 = active ? pp('sc2') : 1;
      seeds.slice(0, 30).forEach((s, k) => {
        o.position.set(Math.cos(s.a + 1) * s.d * 0.9, 0.003, Math.sin(s.a + 1) * s.d * 0.9);
        o.scale.setScalar(k / 30 >= sc2 ? 0.003 : 0.0001);
        o.updateMatrix();
        ions.current!.setMatrixAt(k, o.matrix);
      });
      ions.current.instanceMatrix.needsUpdate = true;
    }
    if (oxide.current) oxide.current.visible = !active || pp('hf') < 0.6;
    if (ripples.current) {
      ripples.current.visible = active && v.phaseId === 'sc1';
      const s = 0.1 + ((engine.time * 0.8) % 1) * 0.25;
      ripples.current.scale.setScalar(s);
    }
    if (active) track('focus', x, TABLE_Y + 0.75 - dip * 0.55, 0);
  });
  const bench = useModel((k) => buildWetBench(k, CLEAN_BENCH));
  const tank = useModel((k) => buildQuartzTank(k, 0.6, 0.48, TABLE_Y - 0.36));
  const chem = useModel(buildChemCabinet);
  const hanger = useModel(buildCleanHanger);
  const mega = useModel(buildMegasonic);
  const bot = useModel((k) => buildBenchRobot(k, -0.25, 1.78, 2.26));
  const liquids = useMemo(() => CLEAN_TANKS.map((t) => liquid(t.color, 0.45)), []);
  const particleMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#e8d18a', roughness: 0.7 }), []);
  const ionMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#b06ad6' }), []);
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'wet-bench', label: 'Wet clean station' }}>
        <group position={[cx, 0, 0]}>
          <Baked parts={bench} />
        </group>
        <group position={[cx + CLEAN_BENCH.w / 2 + 0.36, 0, -0.1]}>
          <Baked parts={chem} />
        </group>
        {CLEAN_TANKS.map((t, i) => (
          <Clickable key={t.id} sel={{ kind: 'component', id: t.id === 'sc1' ? 'sc1' : t.id === 'sc2' ? 'sc2' : t.id === 'hf' ? 'hf' : t.id === 'dry' ? 'dryer' : 'rinse', machine: 'wet-bench', label: t.label }}>
            <group position={[tx(i), 0, 0]}>
              <Baked parts={tank} />
            </group>
            {t.id !== 'dry' && (
              <mesh position={[tx(i), TABLE_Y - 0.15, 0]} material={liquids[i]}>
                <boxGeometry args={[0.56, 0.4, 0.56]} />
              </mesh>
            )}
            <TechLabel position={[tx(i), TABLE_Y + 0.2, 0.33]} title={t.label} min={2} />
          </Clickable>
        ))}
        <Clickable sel={{ kind: 'component', id: 'megasonic', machine: 'wet-bench', label: 'Megasonic transducer' }}>
          <group position={[tx(0), 0, 0]}>
            <Baked parts={mega} />
          </group>
        </Clickable>
        <mesh ref={ripples} position={[tx(0), TABLE_Y + 0.051, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.9, 1, 40]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.5} />
        </mesh>
        <group ref={robot} position={[tx(5), 0, 0]}>
          <Baked parts={bot} />
        </group>
        <SignalTower position={[cx + 2.2, TABLE_Y + 1.75, -0.4]} />
      </Clickable>
      <group ref={carrier}>
        <Baked parts={hanger} />
        <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184 in cleaning' }}>
          <group position={[0, 0.01, 0]}>
            <mesh geometry={waferGeometry(0.15)} material={followMat} rotation={[0, 0, 0]} />
            <mesh ref={oxide} position={[0, 0.0006, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <circleGeometry args={[0.149, 48]} />
              <meshStandardMaterial color="#b9c2d0" transparent opacity={0.18} />
            </mesh>
            <instancedMesh ref={particles} args={[GEO.sphereLow, particleMat, 64]} />
            <instancedMesh ref={ions} args={[GEO.sphereLow, ionMat, 30]} />
          </group>
        </Clickable>
      </group>
      <SensorIndicator id="particle-counter" channel="particles" machine="wet-bench" position={[cx + 2.2, TABLE_Y + 0.4, 0.45]} size={0.07} />
      <SensorIndicator id="conductivity" channel="rho" machine="wet-bench" position={[tx(1) + 0.33, TABLE_Y, 0.25]} size={0.06} />
      <SensorIndicator id="thermocouple" channel="bath" machine="wet-bench" position={[tx(0) + 0.33, TABLE_Y, 0.25]} size={0.06} />
      <TechLabel position={[cx, TABLE_Y + 1.95, 0]} title="PARTICLES · METAL IONS · NATIVE OXIDE → REMOVED" value={() => `particles on wafer ${engine.tele.value('particles', 8).toFixed(0)} · rinse ${engine.tele.value('rho', 18).toFixed(1)} MΩ·cm`} />
      <ParticleInset position={[cx - 0.9, 2.1, 0.9]} />
    </group>
  );
}

/** SC-1 mechanism: the surface is etched slightly under a particle, which lifts and is repelled. */
function ParticleInset({ position }: { position: [number, number, number] }) {
  const p = useRef<THREE.Mesh>(null);
  const undercut = useRef<THREE.Mesh>(null);
  const particleMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#e8d18a', roughness: 0.8 }), []);
  useFrame(() => {
    const active = engine.stage.id === 'wafer-clean';
    const k = active ? pp('sc1') : 1;
    const stay = engine.failSeverity('contamination');
    if (p.current) {
      const lift = smooth(clamp((k - 0.4) / 0.6)) * (1 - stay);
      p.current.position.set(lift * 0.25, 0.12 + 0.1 + lift * 0.35, 0.15);
    }
    if (undercut.current) undercut.current.scale.set(0.18 * smooth(clamp(k * 1.5)), 0.03, 0.2);
  });
  return (
    <Inset id="particle" position={position} size={[1.3, 0.85]} mpu={1e-6 / 1.3} title="SC-1 · UNDERCUT & LIFT-OFF">
      <group position={[0, -0.05, 0]}>
        <B s={[1.1, 0.24, 0.2]} m={M.siPolished} position={[0, 0, 0.15]} shadow={false} />
        <mesh ref={undercut} geometry={GEO.box} material={M.black} position={[0, 0.11, 0.15]} />
        <mesh ref={p} geometry={GEO.sphere} scale={0.1} material={particleMat} />
      </group>
      <TechLabel position={[0.35, 0.25, 0.2]} title="PARTICLE REPELLED (same-sign surface charge)" min={3} />
    </Inset>
  );
}

/* --------------------------------------------------------- utilities */

/** DI-water supply and drain lines along the bay on floor stands, with clamps, flanges and line tags. */
function buildUtilityLine(k: Kit) {
  const x0 = -14;
  const x1 = 24;
  const z = -2.2;
  k.cyl(KM.stainless, 0.05, x1 - x0, [(x0 + x1) / 2, 0.25, z], RX, 24);
  k.cyl(KM.paintGrey, 0.04, x1 - x0, [(x0 + x1) / 2, 0.25, z - 0.16], RX, 20);
  for (let x = x0 + 1; x < x1; x += 2) {
    k.box(KM.paintGraphite, [0.05, 0.19, 0.05], [x, 0.095, z - 0.08]);
    k.box(KM.paintGraphite, [0.06, 0.025, 0.36], [x, 0.19, z - 0.08]);
    k.box(KM.paintGraphite, [0.14, 0.01, 0.14], [x, 0.005, z - 0.08]);
    k.torus(KM.stainlessDark, 0.053, 0.006, [x, 0.25, z], [-Math.PI / 2, Math.PI / 2, 0], 20);
    k.torus(KM.stainlessDark, 0.043, 0.006, [x, 0.25, z - 0.16], [-Math.PI / 2, Math.PI / 2, 0], 20);
  }
  for (let x = x0 + 4; x < x1; x += 8) {
    for (const dx of [-0.012, 0.012]) k.cyl(KM.stainless, 0.075, 0.02, [x + dx, 0.25, z], RX, 24);
    k.label('gas', 'UPW', '', 0.14, 0.03, [x + 0.35, 0.25, z + 0.052], [0, 0, 0], '#2f5d8a');
    k.label('gas', 'DRAIN', '', 0.14, 0.03, [x + 0.35, 0.25, z - 0.118], [0, 0, 0], '#5a5f66');
  }
}

function UtilityLine() {
  const parts = useModel(buildUtilityLine);
  return <Baked parts={parts} />;
}

/* --------------------------------------------------------- scene */

export default function FinishingScene({ stage }: SceneProps) {
  const variant = (stage.variant ?? 'edge') as keyof typeof X;
  // the followed wafer's surface condition through the finishing line
  useFrame(() => {
    const id = engine.stage.id;
    let rough = 1;
    if (id === 'edge-profiling') rough = 1;
    if (id === 'lapping') rough = lerp(1, 0.62, pp('lap'));
    if (id === 'chemical-etch') rough = lerp(0.62, 0.42, pp('etch'));
    if (id === 'polishing') rough = lerp(0.42, 0.0, smooth(Math.max(pp('stock') * 0.7, pp('stock') * 0.7 + pp('final') * 0.3)));
    if (id === 'wafer-clean') rough = 0;
    setSurface(rough);
  });
  useEffect(() => () => setSurface(1), []);
  const cx = X[variant] ?? 0;
  return (
    <>
      <Lighting env="cleanroom" shadowExtent={7} center={[cx, 0, 0]} />
      <CleanroomBay width={42} depth={10} height={4.2} center={[4, 0, -1]} />
      <EdgeStation />
      <DoubleSide cx={X.lap} kind="lap" />
      <EtchStation />
      <DoubleSide cx={X.polish} kind="polish" />
      <CleanBench />
      <UtilityLine />
    </>
  );
}
