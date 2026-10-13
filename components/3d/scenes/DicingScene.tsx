'use client';
/**
 * Dicing & die selection (§44, §45).
 *   saw:  the wafer, mounted on tape in a steel frame, is cut along every scribe street by a
 *         thin diamond blade (coolant on), rotated 90°, cut again, cleaned.
 *   pick: the tape is expanded, the ejector pushes the chosen good die up, the vacuum collet
 *         picks it, a vision check inspects it, and it moves on to packaging. Dies marked
 *         bad in the sort map stay on the tape.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ViewMode } from '@/types';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, AssemblyFloor } from '../environments';
import { M, shell, effectiveView } from '../materials';
import { GEO } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Inset } from '../parts/section';
import { waferGeometry } from '../parts/wafer';
import { Screen, clear, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { drawWafer, dieFloorplan } from '../textures';
import { Kit, cabinet, bellows, boltCircle, grille, windowPane, estop, ledStrip, hose, type BakedPart, type PartOpts, type V3 } from '../kit/build';
import { KM } from '../kit/finish';
import { Baked, useKit } from '../kit/Baked';
import { casterGeometry, shadowOnly } from '../kit/shadow';
import { useUI } from '@/lib/store';
import { engine } from '@/simulation/engine';
import { pp, inPhase, pdt } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { smooth, lerp, fract, rng } from '@/lib/math';
import { DIE_W, DIE_H, WAFER_D } from '@/simulation/models';

const WY = 1.0;
const VISION = new THREE.Vector3(2.45, 1.05, 0);
const SUBSTRATE = new THREE.Vector3(3.3, 0.98, 0);

/* ---------------------------------------------------------------- station models */

/*
 * Static equipment is built with the detailing kit. All static components of a machine are
 * merged across components into one mesh per finish; selection keeps working through
 * invisible pick proxies (position-only copies, visible = false: never drawn, still raycast)
 * inside each component's Clickable, and the shadow comes from ONE position-only caster per
 * machine. Moving parts (table, spindle, blade, collet, die) keep their own refs and pivots.
 */
type Pieces = Record<string, (k: Kit) => void>;
interface Station {
  parts: BakedPart[];
  /** per-component pick geometry (keys starting with "_" are not pickable) */
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

function buildStation(pieces: Pieces): Station {
  const bins = new Map<string, { material: THREE.Material; shell: boolean; geos: THREE.BufferGeometry[] }>();
  const picks: Record<string, THREE.BufferGeometry> = {};
  const cast: THREE.BufferGeometry[] = [];
  for (const [tag, fn] of Object.entries(pieces)) {
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
  const caster = casterGeometry(cast);
  const parts: BakedPart[] = [];
  for (const b of bins.values()) {
    const geometry = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
    if (!geometry) continue;
    if (geometry !== b.geos[0]) b.geos.forEach((g) => g.dispose());
    geometry.computeBoundingSphere();
    parts.push({ material: b.material, geometry, shell: b.shell, cast: false });
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

/** Visible meshes of a station (not pickable: the proxies handle selection) + its shadow caster. */
function StationView({ m, view = 'normal' }: { m: Station; view?: ViewMode }) {
  const caster = useMemo(() => (m.caster ? shadowOnly(m.caster) : null), [m]);
  return (
    <>
      {m.parts.map((p, i) => (
        <mesh key={i} geometry={p.geometry} material={p.shell ? shell(p.material, view) : p.material} receiveShadow raycast={noRay} />
      ))}
      {caster && <primitive object={caster} />}
    </>
  );
}

/** Invisible pick proxy for one component of a station. */
function PickProxy({ m, tag }: { m: Station; tag: string }) {
  const g = m.picks[tag];
  return g ? <mesh geometry={g} material={PICK_MAT} visible={false} /> : null;
}

/* ---------------------------------------------------------------- detail recipes */

const RX: V3 = [Math.PI / 2, 0, 0];
const RZ: V3 = [0, 0, Math.PI / 2];

/** Horizontal plate (top at y + t) with rectangular openings [x0, z0, x1, z1]. */
function holedPlate(k: Kit, m: THREE.Material, w: number, d: number, t: number, y: number, holes: [number, number, number, number][], o: PartOpts = {}) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, -d / 2);
  s.lineTo(w / 2, -d / 2);
  s.lineTo(w / 2, d / 2);
  s.lineTo(-w / 2, d / 2);
  s.closePath();
  for (const [x0, z0, x1, z1] of holes) {
    const h = new THREE.Path();
    h.moveTo(x0, -z0);
    h.lineTo(x0, -z1);
    h.lineTo(x1, -z1);
    h.lineTo(x1, -z0);
    h.closePath();
    s.holes.push(h);
  }
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false });
  k.add(m, g, [0, y, 0], [-Math.PI / 2, 0, 0], [1, 1, 1], o);
  g.dispose();
}

/** Accordion way cover along X (x0 → x1) on a floor at y0, depth d centred on z. */
function accordion(k: Kit, m: THREE.Material, x0: number, x1: number, y0: number, h: number, z: number, d: number, folds: number) {
  const pts: [number, number][] = [[x0, 0]];
  const n = folds * 2;
  for (let i = 0; i <= n; i++) pts.push([x0 + ((x1 - x0) * i) / n, i % 2 ? h - 0.01 : h]);
  pts.push([x1, 0]);
  k.extrude(m, pts, d, [0, y0, z - d / 2]);
}

/** Simple sagging line (cable / hose) between two points. */
function line(k: Kit, a: V3, b: V3, r = 0.008, sag = 0.06, m: THREE.Material = KM.rubber) {
  hose(k, a, b, r, sag, m);
}

/** Facility panel facing local +Z: plate, bulkhead fittings, gas tags. */
function utilityPanel(k: Kit, pos: V3, yaw: number, lines: [string, string][]) {
  k.at(pos, yaw, () => {
    const w = 0.09 * lines.length + 0.04;
    k.rbox(KM.stainlessDark, [w, 0.2, 0.012], 0.004, [0, 0, 0.006]);
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.cyl(KM.stainless, 0.005, 0.004, [sx * (w / 2 - 0.014), sy * 0.086, 0.013], RX, 8, { cast: false });
    lines.forEach(([t, c], i) => {
      const x = -w / 2 + 0.065 + i * 0.09;
      k.cyl(KM.stainless, 0.017, 0.012, [x, 0.03, 0.018], RX, 6);
      k.cyl(KM.stainless, 0.009, 0.05, [x, 0.03, 0.045], RX, 10);
      k.cyl(KM.stainlessDark, 0.012, 0.012, [x, 0.03, 0.064], RX, 6);
      k.label('gas', t, '', 0.078, 0.022, [x, -0.05, 0.0125], [0, 0, 0], c);
    });
  });
}

/** Dial pressure gauge facing +Z. */
function gauge(k: Kit, pos: V3, r = 0.022) {
  k.cyl(KM.stainless, r, 0.014, [pos[0], pos[1], pos[2] + 0.007], RX, 20);
  k.cyl(KM.plasticWhite, r * 0.86, 0.002, [pos[0], pos[1], pos[2] + 0.0145], RX, 20, { cast: false });
  k.box(KM.paintRed, [0.0016, r * 0.7, 0.001], [pos[0] + r * 0.16, pos[1] + r * 0.2, pos[2] + 0.016], [0, 0, -0.7], { cast: false });
  k.cyl(KM.stainless, 0.005, 0.03, [pos[0], pos[1] - r - 0.012, pos[2] + 0.007], [0, 0, 0], 8);
}

/* ---------------------------------------------------------------- saw models */

/** clear polycarbonate of the cutting-chamber windows (lighter than the bay glazing) */
const clearPC = (() => {
  const m = KM.glass.clone();
  m.opacity = 0.1;
  m.envMapIntensity = 1.0;
  return m;
})();

const DECK = 0.9;
const BASIN = { x: 0.43, z: 0.34, floor: 0.806 };
const CH = { zf: 0.42, zb: -0.36, win: 1.5, top: 1.78 };

/** Saw frame: cabinet, deck with the cutting-chamber basin, glazed chamber, overhead axis, utilities. */
function buildSawBody(k: Kit) {
  const sh = { shell: true };
  // base cabinet + skirt band under the deck
  cabinet(k, { size: [1.4, 0.78, 1.2], panels: 2, rows: [0.34], sidePanels: 2, handles: true, feet: true, stripe: false, ao: false });
  for (const s of [-1, 1]) {
    k.rbox(KM.paint, [1.4, 0.08, 0.02], 0.005, [0, 0.842, s * 0.59]);
    k.rbox(KM.paint, [0.02, 0.08, 1.16], 0.005, [s * 0.69, 0.842, 0]);
  }
  k.box(KM.paintAccent, [1.398, 0.012, 0.003], [0, 0.85, 0.6015], [0, 0, 0], { cast: false });
  // stainless work deck with the basin opening, rounded front nosing
  holedPlate(k, KM.stainless, 1.4, 1.2, 0.018, DECK - 0.018, [[-BASIN.x, -BASIN.z, BASIN.x, BASIN.z]]);
  k.cyl(KM.stainless, 0.011, 1.4, [0, DECK - 0.009, 0.6], RZ, 14);
  // basin: walls, floor, drain
  const { x: bx, z: bz, floor: fl } = BASIN;
  for (const s of [-1, 1]) {
    k.box(KM.stainlessDark, [0.008, DECK - fl, 2 * bz], [s * (bx - 0.004), (DECK + fl) / 2, 0]);
    k.box(KM.stainlessDark, [2 * bx, DECK - fl, 0.008], [0, (DECK + fl) / 2, s * (bz - 0.004)]);
  }
  k.box(KM.stainlessDark, [2 * bx, 0.006, 2 * bz], [0, fl - 0.003, 0]);
  k.cyl(KM.seam, 0.028, 0.002, [0.33, fl + 0.001, 0.25], [0, 0, 0], 20, { cast: false });
  k.torus(KM.stainless, 0.028, 0.003, [0.33, fl + 0.002, 0.25], [0, 0, 0], 20, { cast: false });
  // theta stage under the chuck table, bellows skirt, X-axis accordion way covers
  k.cyl(KM.anodizedDark, 0.12, 0.096, [0, fl + 0.048, 0], [0, 0, 0], 40);
  bellows(k, 0.15, 0.07, 7, [0, fl, 0], KM.rubber);
  k.cyl(KM.anodized, 0.2, 0.013, [0, 0.9085, 0], [0, 0, 0], 64);
  boltCircle(k, 0.185, 16, 0.9155, 0.004);
  accordion(k, KM.plastic, -bx + 0.008, -0.2, fl, 0.075, 0, 0.32, 9);
  accordion(k, KM.plastic, 0.2, bx - 0.008, fl, 0.075, 0, 0.32, 9);
  // spinner cleaning station (left) and blade-height sensor (right) on the deck
  k.at([-0.565, DECK, 0.13], 0, () => {
    k.lathe(KM.stainless, [[0.1, 0], [0.104, 0], [0.104, 0.052], [0.108, 0.058], [0.094, 0.06], [0.096, 0.004]], [0, 0, 0], [0, 0, 0], 48);
    k.cyl(KM.seam, 0.096, 0.002, [0, 0.004, 0], [0, 0, 0], 40, { cast: false });
    k.cyl(KM.ptfe, 0.065, 0.012, [0, 0.03, 0], [0, 0, 0], 40);
    k.cyl(KM.stainlessDark, 0.02, 0.026, [0, 0.013, 0], [0, 0, 0], 16);
    k.tube(KM.stainless, [[0.1, 0.07, -0.06], [0.06, 0.09, -0.03], [0.02, 0.08, 0]], 0.004, { radial: 6 });
    k.cyl(KM.stainlessDark, 0.012, 0.06, [0.1, 0.035, -0.06], [0, 0, 0], 12);
  });
  k.at([0.55, DECK, -0.12], 0, () => {
    k.rbox(KM.anodizedDark, [0.08, 0.05, 0.1], 0.006, [0, 0.025, 0]);
    k.rbox(KM.anodized, [0.05, 0.03, 0.012], 0.003, [0, 0.065, 0.025]);
    k.rbox(KM.anodized, [0.05, 0.03, 0.012], 0.003, [0, 0.065, -0.025]);
    k.box(KM.ledAmber, [0.01, 0.006, 0.002], [0.025, 0.035, 0.051], [0, 0, 0], { cast: false });
  });
  // rear axis housing (stainless face inside the chamber)
  k.rbox(KM.paint, [1.4, CH.top - DECK, 0.24], 0.014, [0, (DECK + CH.top) / 2, -0.48]);
  k.box(KM.stainless, [1.32, 0.54, 0.004], [0, DECK + 0.29, CH.zb + 0.002]);
  for (const x of [-0.62, 0.62]) for (const y of [DECK + 0.04, DECK + 0.54]) k.cyl(KM.stainlessDark, 0.005, 0.004, [x, y, CH.zb + 0.005], RX, 8, { cast: false });
  // DIW / CDA manifold with gauges on the chamber back wall
  k.rbox(KM.stainless, [0.24, 0.04, 0.04], 0.008, [0.44, DECK + 0.36, CH.zb + 0.024]);
  gauge(k, [0.38, DECK + 0.44, CH.zb + 0.004]);
  gauge(k, [0.5, DECK + 0.44, CH.zb + 0.004]);
  for (const x of [0.36, 0.44, 0.52]) k.cyl(KM.paintBlue, 0.012, 0.014, [x, DECK + 0.33, CH.zb + 0.03], [0, 0, 0], 12);
  // overhead Y–Z axis housing that carries the spindle column, with its slot cover and cable chain
  k.rbox(KM.paint, [0.7, 0.2, 0.5], 0.02, [0, 1.56, -0.12]);
  k.box(KM.seam, [0.62, 0.003, 0.44], [0, 1.4585, -0.12], [0, 0, 0], { cast: false });
  for (const s of [-1, 1]) {
    k.box(KM.chrome, [0.006, 0.012, 0.46], [s * 0.353, 1.5, -0.12], [0, 0, 0], { cast: false });
    k.box(KM.seam, [0.002, 0.16, 0.003], [s * 0.2, 1.56, 0.1315], [0, 0, 0], { cast: false });
  }
  k.label('warn', 'PINCH POINT', '', 0.07, 0.07, [0.26, 1.56, 0.131]);
  // energy chain: lower run on the housing, U-loop, upper run into the rear housing
  {
    const path: V3[] = [];
    for (let i = 0; i <= 8; i++) path.push([0.2, 1.675, -0.34 + i * 0.045]);
    for (let i = 1; i < 8; i++) {
      const a = (i / 8) * Math.PI;
      path.push([0.2, 1.715 - Math.cos(a) * 0.04, 0.02 + Math.sin(a) * 0.04]);
    }
    for (let i = 0; i <= 8; i++) path.push([0.2, 1.755, 0.02 - i * 0.045]);
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      const ang = Math.atan2(b[1] - a[1], b[2] - a[2]);
      k.rbox(KM.plastic, [0.05, 0.022, 0.04], 0.004, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], [-ang, 0, 0]);
    }
  }
  // glazed cutting chamber (cut away when looking inside; glazing and headers cast no shadow,
  // the bay's ceiling light reaches the chuck through the roof)
  const glaze = { shell: true, cast: false };
  for (const s of [-1, 1]) k.rbox(KM.anodizedDark, [0.04, CH.top - DECK, 0.04], 0.006, [s * 0.68, (DECK + CH.top) / 2, CH.zf], [0, 0, 0], sh);
  windowPane(k, 1.26, 0.56, [0, 1.21, CH.zf], { ...glaze, frame: KM.anodizedDark, glass: clearPC });
  k.rbox(KM.anodized, [0.018, 0.22, 0.024], 0.006, [0.6, 1.21, CH.zf + 0.026], [0, 0, 0], sh);
  k.label('warn', 'ROTATING BLADE', '', 0.08, 0.08, [-0.55, 1.4, CH.zf + 0.016]);
  k.rbox(KM.paint, [1.4, CH.top - 1.502, 0.03], 0.008, [0, (1.502 + CH.top) / 2, CH.zf], [0, 0, 0], glaze);
  k.label('model', 'DS-300', 'AUTOMATIC DICING SAW · 300 mm', 0.42, 0.1, [-0.38, 1.645, CH.zf + 0.0155]);
  k.box(KM.seam, [1.36, 0.0035, 0.002], [0, 1.53, CH.zf + 0.0155], [0, 0, 0], { cast: false, ...sh });
  ledStrip(k, 0.36, [0.36, 1.68, CH.zf + 0.016], KM.ledGreen);
  for (const s of [-1, 1]) {
    k.at([s * 0.69, 0, (CH.zf + CH.zb) / 2], [0, s * Math.PI / 2, 0], () => windowPane(k, 0.74, 0.56, [0, 1.21, 0], { ...glaze, frame: KM.anodizedDark, glass: clearPC }));
    k.rbox(KM.paint, [0.03, CH.top - 1.502, CH.zf - CH.zb], 0.008, [s * 0.69, (1.502 + CH.top) / 2, (CH.zf + CH.zb) / 2], [0, 0, 0], glaze);
  }
  // chamber lights under the header and along the back
  k.box(KM.seam, [1.12, 0.02, 0.026], [0, 1.488, CH.zf - 0.03], [0, 0, 0], { cast: false, ...sh });
  k.box(KM.ledWhite, [1.08, 0.006, 0.018], [0, 1.477, CH.zf - 0.03], [0, 0, 0], { cast: false, ...sh });
  k.box(KM.ledWhite, [1.2, 0.006, 0.014], [0, CH.top - 0.03, CH.zb + 0.012], [0, 0, 0], { cast: false });
  // roof: frame and skylight
  k.at([0, CH.top + 0.012, (CH.zf + CH.zb) / 2], [-Math.PI / 2, 0, 0], () => windowPane(k, 1.3, 0.72, [0, 0, 0], { ...glaze, frame: KM.paint, glass: clearPC }));
  // exhaust duct off the rear housing
  k.cyl(KM.paintGrey, 0.07, 0.8, [0.45, CH.top + 0.4, -0.5], [0, 0, 0], 24);
  k.torus(KM.paintGrey, 0.072, 0.008, [0.45, CH.top + 0.06, -0.5], [0, 0, 0], 24);
  k.torus(KM.paintGrey, 0.072, 0.008, [0.45, CH.top + 0.5, -0.5], [0, 0, 0], 24);
  k.at([-0.3, (DECK + CH.top) / 2 + 0.1, -0.6], [0, Math.PI, 0], () => grille(k, 0.5, 0.3, [0, 0, 0]));
  // front ledge: signal-tower boss, key panel, EMO
  k.cyl(KM.anodizedDark, 0.02, 0.05, [0.62, DECK + 0.025, 0.5], [0, 0, 0], 16);
  k.at([-0.36, DECK, 0.51], [-0.18, 0, 0], () => {
    k.rbox(KM.plastic, [0.34, 0.03, 0.13], 0.008, [0, 0.015, 0]);
    k.box(KM.screen, [0.1, 0.002, 0.06], [0.1, 0.031, -0.01], [0, 0, 0], { cast: false });
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) k.rbox(KM.plasticWhite, [0.026, 0.008, 0.022], 0.003, [-0.13 + i * 0.034, 0.033, -0.035 + j * 0.03], [0, 0, 0], { cast: false });
  });
  estop(k, [-0.58, 0.68, 0.6]);
  k.label('info', 'SN 0247-DS', 'DIW 0.3 MPa · CDA 0.5 MPa', 0.2, 0.05, [0.48, 0.12, 0.601]);
  // facilities on the right side, lines to the wall
  utilityPanel(k, [0.701, 0.42, -0.3], Math.PI / 2, [['DIW', '#2f5d8a'], ['CDA', '#4a6a8a']]);
  hose(k, [0.77, 0.45, -0.34], [0.9, 0.02, -0.9], 0.012, 0.05, KM.paintBlue);
  hose(k, [0.77, 0.45, -0.25], [1.0, 0.02, -0.85], 0.012, 0.05, KM.plastic);
  k.ao(1.5, 1.3, [0, 0, 0], 1.25);
}

/** Pedestal for the saw's status monitor (screen itself is a live Screen). */
function buildScreenStand(k: Kit) {
  k.at([1.15, 0, -0.5], -0.6, () => {
    k.rbox(KM.paintGraphite, [0.42, 0.03, 0.34], 0.01, [0, 0.015, 0]);
    k.cyl(KM.anodized, 0.028, 1.28, [0, 0.67, -0.03], [0, 0, 0], 20);
    k.cyl(KM.anodizedDark, 0.036, 0.04, [0, 1.06, -0.03], [0, 0, 0], 20);
    k.rbox(KM.plastic, [0.6, 0.38, 0.03], 0.01, [0, 1.5, 0.0]);
    k.rbox(KM.anodizedDark, [0.12, 0.12, 0.04], 0.006, [0, 1.5, -0.03]);
    // keyboard tray
    k.rbox(KM.anodizedDark, [0.46, 0.014, 0.2], 0.004, [0, 1.08, 0.1]);
    k.rbox(KM.plastic, [0.4, 0.016, 0.13], 0.005, [0, 1.095, 0.11]);
    for (let r = 0; r < 4; r++) k.box(KM.seam, [0.38, 0.001, 0.002], [0, 1.1035, 0.065 + r * 0.03], [0, 0, 0], { cast: false });
    k.ao(0.42, 0.34, [0, 0, 0], 1.3);
  });
}

/** Alignment microscope camera hanging from the overhead axis housing. */
function buildAlignCam(k: Kit) {
  k.at([-0.3, WY + 0.2, 0.15], 0, () => {
    k.cyl(KM.anodizedDark, 0.016, 0.1, [0, -0.01, 0], [0, 0, 0], 20);
    k.cyl(KM.plastic, 0.021, 0.022, [0, -0.06, 0], [0, 0, 0], 20);
    k.torus(KM.ledWhite, 0.019, 0.0035, [0, -0.072, 0], [0, 0, 0], 24);
    k.rbox(KM.paint, [0.052, 0.07, 0.07], 0.007, [0, 0.075, 0]);
    k.cyl(KM.plastic, 0.007, 0.02, [0.03, 0.09, 0], RZ, 10);
    k.rbox(KM.anodizedDark, [0.04, 0.17, 0.012], 0.003, [0, 0.175, -0.04]);
    k.rbox(KM.anodizedDark, [0.06, 0.012, 0.06], 0.003, [0, 0.254, -0.02]);
  });
  line(k, [-0.27, WY + 0.29, 0.15], [-0.25, 1.458, 0.08], 0.004, 0.02, KM.plastic);
}

/** Chuck table + frame holder + tape frame (rides the table: lift on mount, 90° index). */
function buildChuck(k: Kit) {
  k.cyl(KM.anodizedDark, 0.205, 0.012, [0, 0.921, 0], [0, 0, 0], 64);
  k.cyl(KM.stainless, 0.168, 0.066, [0, 0.96, 0], [0, 0, 0], 64);
  k.cyl(KM.ptfe, 0.158, 0.003, [0, 0.9935, 0], [0, 0, 0], 64, { cast: false });
  // frame holder ring on four arms, four pneumatic frame clamps
  k.lathe(KM.anodizedDark, [[0.18, 0.975], [0.236, 0.975], [0.236, 0.9965], [0.18, 0.9965], [0.18, 0.975]], [0, 0, 0], [0, 0, 0], 72);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    k.box(KM.anodizedDark, [0.05, 0.05, 0.03], [c * 0.19, 0.95, s * 0.19], [0, -a, 0]);
    k.rbox(KM.anodized, [0.034, 0.03, 0.03], 0.004, [c * 0.252, 0.985, s * 0.252], [0, -a, 0]);
    k.box(KM.paintGraphite, [0.032, 0.004, 0.016], [c * 0.233, 1.0015, s * 0.233], [0, -a, 0], { cast: false });
    k.cyl(KM.stainlessDark, 0.006, 0.006, [c * 0.258, 1.002, s * 0.258], [0, 0, 0], 8, { cast: false });
  }
  // tape frame: steel ring with two flats and an orientation notch
  const outer: [number, number][] = [];
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    let x = Math.cos(a) * 0.23;
    let y = Math.sin(a) * 0.23;
    if (Math.abs(x) > 0.221) x = Math.sign(x) * 0.221;
    if (y > 0.224) y = 0.224;
    outer.push([x, y]);
  }
  const s = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
  s.holes.push(new THREE.Path().absarc(0, 0, 0.19, 0, Math.PI * 2, true));
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.0015, bevelEnabled: false, curveSegments: 48 });
  k.add(KM.stainless, g, [0, WY - 0.0025, 0], [-Math.PI / 2, 0, 0], [1, 1, 1], { cast: false });
  g.dispose();
}

/** Spindle (rides the spindle group): air-bearing housing, motor, mount, Z-slide, blade cover. */
function buildSpindle(k: Kit) {
  // housing along -Z behind the blade (lathe axis Y → -Z)
  k.at([0, 0.03, 0], [-Math.PI / 2, 0, 0], () => {
    k.lathe(KM.chrome, [[0, -0.005], [0.009, -0.005], [0.009, -0.0016], [0.016, -0.0016], [0.016, -0.0004], [0.0001, -0.0004]], [0, 0, 0], [0, 0, 0], 32);
    k.lathe(KM.chrome, [[0.0001, 0.0004], [0.017, 0.0004], [0.017, 0.004], [0.02, 0.004], [0.02, 0.012], [0.0001, 0.012]], [0, 0, 0], [0, 0, 0], 32);
    k.lathe(KM.stainless, [[0.02, 0.012], [0.03, 0.014], [0.034, 0.02], [0.034, 0.098], [0.039, 0.1], [0.039, 0.11], [0.02, 0.11]], [0, 0, 0], [0, 0, 0], 40);
    k.lathe(KM.paint, [[0.02, 0.11], [0.036, 0.11], [0.036, 0.17], [0.03, 0.178], [0.0001, 0.178]], [0, 0, 0], [0, 0, 0], 40);
  });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.cyl(KM.stainlessDark, 0.0025, 0.004, [Math.cos(a) * 0.0365, 0.03 + Math.sin(a) * 0.0365, -0.112], RX, 6, { cast: false });
  }
  // clamp block hanging from the Z-slide plate
  k.rbox(KM.anodizedDark, [0.092, 0.056, 0.07], 0.006, [0, 0.062, -0.135]);
  for (const s of [-1, 1]) k.cyl(KM.stainlessDark, 0.004, 0.004, [s * 0.03, 0.08, -0.0985], RX, 8, { cast: false });
  // Z-slide plate with linear guides, rising into the overhead axis housing
  k.rbox(KM.paint, [0.1, 0.42, 0.05], 0.008, [0, 0.3, -0.135]);
  for (const s of [-1, 1]) k.box(KM.chrome, [0.008, 0.38, 0.006], [s * 0.034, 0.3, -0.108], [0, 0, 0], { cast: false });
  k.rbox(KM.anodizedDark, [0.07, 0.05, 0.02], 0.004, [0, 0.13, -0.104]);
  // blade cover over the top half of the blade
  const cover: [number, number][] = [];
  for (let i = 0; i <= 20; i++) {
    const a = 0.12 + (i / 20) * (Math.PI - 0.24);
    cover.push([Math.cos(a) * 0.037, Math.sin(a) * 0.037]);
  }
  cover.push([-0.02, 0.0]);
  cover.push([0.02, 0.0]);
  k.extrude(KM.anodized, cover, 0.018, [0, 0.03, -0.009]);
  k.rbox(KM.anodizedDark, [0.03, 0.016, 0.026], 0.004, [-0.012, 0.071, 0]);
  line(k, [-0.02, 0.078, 0], [-0.03, 0.2, -0.11], 0.003, 0.02, KM.plastic);
}

/** Blade coolers (nozzle pair beside the blade), shower nozzle and supply hoses. */
function buildCoolant(k: Kit) {
  for (const s of [-1, 1]) {
    k.cyl(KM.stainless, 0.0026, 0.05, [0.0, 0.016, s * 0.0045], RZ, 8);
    k.cyl(KM.stainless, 0.0026, 0.024, [-0.024, 0.026, s * 0.0045], [0, 0, 0], 8);
    k.cyl(KM.stainlessDark, 0.004, 0.008, [-0.024, 0.04, s * 0.0045], [0, 0, 0], 8);
  }
  // shower nozzle aimed at the blade edge from the front of the cut
  k.tube(KM.stainless, [[0.03, 0.058, 0.0], [0.042, 0.035, 0.0], [0.034, 0.012, 0.0]], 0.0026, { radial: 6 });
  k.rbox(KM.anodizedDark, [0.016, 0.014, 0.02], 0.003, [0.024, 0.066, 0]);
  // PU supply lines up to the Z-slide
  line(k, [0.024, 0.072, 0.006], [0.045, 0.24, -0.11], 0.0035, 0.03, KM.paintBlue);
  line(k, [-0.024, 0.044, 0.008], [0.04, 0.22, -0.11], 0.0035, 0.04, KM.paintBlue);
}

/* streets (wafer-local mm): rows for the first channel, columns for the second */
const NX = Math.round(WAFER_D / DIE_W) + 1;
const NY = Math.round(WAFER_D / DIE_H) + 1;
const OX = -((Math.floor(WAFER_D / DIE_W) - 1) / 2) * DIE_W - DIE_W / 2;
const OY = -((Math.floor(WAFER_D / DIE_H) - 1) / 2) * DIE_H - DIE_H / 2;
const rowStreet = (j: number) => OY + j * DIE_H;
const colStreet = (i: number) => OX + i * DIE_W;

/* ---------------------------------------------------------------- saw */

function useCutTexture() {
  return useMemo(() => {
    const S = 512;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const base = document.createElement('canvas');
    base.width = base.height = S;
    drawWafer(base.getContext('2d')!, S, 'dies');
    const s = S / WAFER_D;
    let last = -1;
    const update = (cuts: number) => {
      if (cuts === last) return;
      last = cuts;
      g.drawImage(base, 0, 0);
      g.strokeStyle = '#141814';
      g.lineWidth = Math.max(1.5, s * 0.8);
      for (let k = 0; k < cuts; k++) {
        g.beginPath();
        if (k < NY) {
          const y = S / 2 + rowStreet(k) * s;
          g.moveTo(0, y);
          g.lineTo(S, y);
        } else {
          const x = S / 2 + colStreet(k - NY) * s;
          g.moveTo(x, 0);
          g.lineTo(x, S);
        }
        g.stroke();
      }
      tex.needsUpdate = true;
    };
    update(0);
    return { tex, update };
  }, []);
}

const coolMat = new THREE.MeshStandardMaterial({ color: '#d7e6dc', transparent: true, opacity: 0.45, roughness: 0.05, depthWrite: false });
/** nickel-bond diamond blade: dark, slightly metallic */
const bladeMat = new THREE.MeshStandardMaterial({ color: '#5d6166', roughness: 0.42, metalness: 0.8 });
const tapeMat = new THREE.MeshStandardMaterial({ color: '#9fb8a8', transparent: true, opacity: 0.55, roughness: 0.3, depthWrite: false });

function Saw() {
  const table = useRef<THREE.Group>(null);
  const spindle = useRef<THREE.Group>(null);
  const blade = useRef<THREE.Mesh>(null);
  const spray = useRef<THREE.InstancedMesh>(null);
  const cut = useCutTexture();
  const top = useMemo(() => new THREE.MeshStandardMaterial({ map: cut.tex, roughness: 0.2, metalness: 0.4 }), [cut]);
  const waferMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.1, metalness: 0.9 }), []);
  const seeds = useMemo(() => {
    const r = rng(4);
    return Array.from({ length: 40 }, () => ({ a: r() * Math.PI, s: 0.5 + r(), o: r() }));
  }, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const t = useRef(0);
  useFrame((_, dt) => {
    const v = engine.player.view;
    t.current += pdt(dt);
    const cuts = engine.tele.value('cuts', 0);
    cut.update(Math.floor(cuts));
    const mount = smooth(pp('mount'));
    const rot = smooth(pp('rotate'));
    if (table.current) {
      table.current.position.y = lerp(0.25, 0, mount);
      table.current.rotation.y = (Math.PI / 2) * rot;
    }
    track('focus', 0, WY, 0);
    // blade: one pass along x per street; street position along z (table frame)
    const cutting = v.phaseId === 'cut-x' || v.phaseId === 'cut-y';
    let bx = 0.32;
    let bz = 0;
    let by = WY + 0.08;
    if (cutting) {
      const n = v.phaseId === 'cut-x' ? NY : NX;
      const x = v.phaseT * n;
      const k = Math.min(n - 1, Math.floor(x));
      const u = fract(x);
      const street = v.phaseId === 'cut-x' ? rowStreet(k) : -colStreet(k);
      bz = street / 1000;
      bx = lerp(-0.2, 0.2, u);
      by = WY + 0.012;
    }
    if (spindle.current) spindle.current.position.set(bx, by, bz);
    if (blade.current) blade.current.rotation.z -= pdt(dt) * 60;
    if (spray.current) {
      seeds.forEach((s, i) => {
        const u = (t.current * 2 * s.s + s.o) % 1;
        o.position.set(bx + Math.cos(s.a) * u * 0.05, by + 0.01 + Math.sin(s.a) * u * 0.04, bz + (s.o - 0.5) * 0.02);
        o.scale.setScalar(cutting || inPhase('clean') ? 0.003 * (1 - u) : 0);
        o.updateMatrix();
        spray.current!.setMatrixAt(i, o.matrix);
      });
      spray.current.instanceMatrix.needsUpdate = true;
    }
  });
  const viewRaw = useUI((st) => st.view);
  const cam = useUI((st) => st.cameraMode);
  const view = effectiveView(viewRaw, cam);
  const body = useStation({ body: buildSawBody, camera: buildAlignCam, _stand: buildScreenStand });
  const head = useStation({ spindle: buildSpindle, coolant: buildCoolant });
  const chuck = useKit(buildChuck);
  return (
    <group>
      <StationView m={body} view={view} />
      <Clickable sel={{ kind: 'machine', id: 'dicing-saw', label: 'Dicing saw' }}>
        <PickProxy m={body} tag="body" />
        <SignalTower position={[0.62, 0.95, 0.5]} />
      </Clickable>
      <group ref={table}>
        <Clickable sel={{ kind: 'component', id: 'table', machine: 'dicing-saw', label: 'Cutting table' }}>
          <Baked parts={chuck} />
        </Clickable>
        {/* tape + wafer (the frame is part of the chuck model) */}
        <mesh position={[0, WY - 0.003, 0]} rotation={[-Math.PI / 2, 0, 0]} material={tapeMat}>
          <circleGeometry args={[0.2, 64]} />
        </mesh>
        <group position={[0, WY, 0]}>
          <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184' }}>
            <mesh geometry={waferGeometry()} material={waferMat} castShadow />
            <mesh position={[0, 0.0005, 0]} rotation={[-Math.PI / 2, 0, 0]} material={top}>
              <circleGeometry args={[0.149, 64]} />
            </mesh>
          </Clickable>
        </group>
      </group>
      {/* spindle + blade */}
      <group ref={spindle}>
        <StationView m={head} />
        <Clickable sel={{ kind: 'component', id: 'spindle', machine: 'dicing-saw', label: 'Air-bearing spindle' }}>
          <PickProxy m={head} tag="spindle" />
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'blade', machine: 'dicing-saw', label: 'Diamond blade' }}>
          <mesh ref={blade} position={[0, 0.03, 0]} rotation={[Math.PI / 2, 0, 0]} material={bladeMat}>
            <cylinderGeometry args={[0.028, 0.028, 0.0008, 48]} />
          </mesh>
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'coolant', machine: 'dicing-saw', label: 'Coolant nozzles' }}>
          <PickProxy m={head} tag="coolant" />
        </Clickable>
      </group>
      <instancedMesh ref={spray} args={[GEO.sphereLow, coolMat, 40]} frustumCulled={false} />
      <Clickable sel={{ kind: 'component', id: 'camera', machine: 'dicing-saw', label: 'Alignment camera' }}>
        <PickProxy m={body} tag="camera" />
      </Clickable>
    </group>
  );
}


/* ---------------------------------------------------------------- die sorter models */

/** Horizontal plate (top at y + t) with a round opening of radius r at the centre. */
function ringPlate(k: Kit, m: THREE.Material, w: number, d: number, t: number, y: number, r: number, cx = 0, cz = 0) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, -d / 2);
  s.lineTo(w / 2, -d / 2);
  s.lineTo(w / 2, d / 2);
  s.lineTo(-w / 2, d / 2);
  s.closePath();
  s.holes.push(new THREE.Path().absarc(0, 0, r, 0, Math.PI * 2, true));
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 40 });
  k.add(m, g, [cx, y, cz], [-Math.PI / 2, 0, 0]);
  g.dispose();
}

/** Tape frame (steel ring with two flats and an orientation flat) lying at height y. */
function tapeFrame(k: Kit, y: number) {
  const outer: [number, number][] = [];
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    let x = Math.cos(a) * 0.23;
    let v = Math.sin(a) * 0.23;
    if (Math.abs(x) > 0.221) x = Math.sign(x) * 0.221;
    if (v > 0.224) v = 0.224;
    outer.push([x, v]);
  }
  const s = new THREE.Shape(outer.map(([x, v]) => new THREE.Vector2(x, v)));
  s.holes.push(new THREE.Path().absarc(0, 0, 0.19, 0, Math.PI * 2, true));
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.0015, bevelEnabled: false, curveSegments: 48 });
  k.add(KM.stainless, g, [0, y, 0], [-Math.PI / 2, 0, 0], [1, 1, 1], { cast: false });
  g.dispose();
}

const SORT = { gantryY0: 1.22, gantryY1: 1.62, beamZ: -0.315 };

/** Die sorter frame: wafer-table cabinet, transfer module, bond cabinet, X gantry, magazines. */
function buildSorterBody(k: Kit) {
  const TOP = 0.922;
  // wafer-side cabinet
  cabinet(k, { size: [1.4, 0.9, 1.2], panels: 2, rows: [0.38], sidePanels: 2, handles: true, feet: true, ao: false });
  k.label('model', 'DB-500', 'DIE SORTER · KNOWN-GOOD-DIE PICK', 0.4, 0.095, [-0.4, 0.74, 0.601]);
  estop(k, [0.55, 0.74, 0.6]);
  k.label('info', 'SN 0512-DB', 'VAC −85 kPa · CDA 0.5 MPa', 0.2, 0.05, [0.45, 0.12, 0.601]);
  // stainless work decks on the cabinets
  k.rbox(KM.stainless, [1.4, 0.012, 1.2], 0.004, [0, TOP + 0.006, 0]);
  k.rbox(KM.stainless, [0.5, 0.012, 0.9], 0.004, [0.95, TOP + 0.006, 0]);
  k.rbox(KM.stainless, [2.4, 0.012, 0.9], 0.004, [2.4, TOP + 0.006, 0]);
  // X–Y wafer table on cross-roller ways, expander ring, frame holder and clamps
  k.rbox(KM.anodizedDark, [0.72, 0.025, 0.72], 0.004, [0, TOP + 0.0125, 0]);
  for (const s of [-1, 1]) {
    k.box(KM.chrome, [0.68, 0.008, 0.014], [0, TOP + 0.029, s * 0.25]);
    k.box(KM.chrome, [0.014, 0.008, 0.6], [s * 0.25, TOP + 0.037, 0]);
  }
  ringPlate(k, KM.anodized, 0.6, 0.6, 0.016, TOP + 0.041, 0.24);
  k.lathe(KM.stainless, [[0.198, TOP + 0.057], [0.212, TOP + 0.057], [0.212, 0.993], [0.206, 0.9962], [0.198, 0.9962], [0.198, TOP + 0.057]], [0, 0, 0], [0, 0, 0], 72);
  k.lathe(KM.anodizedDark, [[0.216, 0.972], [0.262, 0.972], [0.262, 0.9965], [0.216, 0.9965], [0.216, 0.972]], [0, 0, 0], [0, 0, 0], 72);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    k.box(KM.anodizedDark, [0.04, 0.012, 0.04], [c * 0.24, 0.968, sn * 0.24], [0, -a, 0]);
    k.rbox(KM.anodized, [0.034, 0.03, 0.03], 0.004, [c * 0.272, 0.985, sn * 0.272], [0, -a, 0]);
    k.box(KM.paintGraphite, [0.034, 0.004, 0.016], [c * 0.25, 1.0015, sn * 0.25], [0, -a, 0], { cast: false });
  }
  tapeFrame(k, WY - 0.0025);
  // stage drive motors on the table edges
  k.at([0.38, TOP + 0.025, 0.2], 0, () => {
    k.cyl(KM.paintGraphite, 0.03, 0.12, [0.06, 0.03, 0], RZ, 20);
    k.cyl(KM.stainless, 0.022, 0.012, [0.0, 0.03, 0], RZ, 20);
  });
  k.at([-0.2, TOP + 0.025, 0.38], 0, () => {
    k.cyl(KM.paintGraphite, 0.03, 0.12, [0, 0.03, 0.06], RX, 20);
    k.cyl(KM.stainless, 0.022, 0.012, [0, 0.03, 0.0], RX, 20);
  });
  // frame-cassette elevator on the left
  k.at([-0.88, 0, -0.05], 0, () => {
    cabinet(k, { size: [0.36, 0.9, 0.5], panels: 1, rows: [0.4], sidePanels: 1, vent: false, stripe: false, ao: false, feet: true });
    k.rbox(KM.anodizedDark, [0.06, 0.62, 0.06], 0.006, [0.1, TOP + 0.31, -0.18]);
    k.box(KM.chrome, [0.012, 0.58, 0.008], [0.1, TOP + 0.31, -0.148]);
    k.at([-0.02, TOP + 0.06, 0.02], 0, () => {
      k.rbox(KM.paintGraphite, [0.3, 0.012, 0.32], 0.004, [0, 0.006, 0]);
      k.rbox(KM.paintGraphite, [0.3, 0.012, 0.32], 0.004, [0, 0.31, 0]);
      for (const s of [-1, 1]) {
        k.rbox(KM.paintGraphite, [0.012, 0.31, 0.3], 0.004, [s * 0.144, 0.158, 0]);
        for (let i = 0; i < 12; i++) k.box(KM.anodized, [0.014, 0.003, 0.28], [s * 0.132, 0.03 + i * 0.022, 0], [0, 0, 0], { cast: false });
      }
      for (let i = 0; i < 9; i++) k.box(KM.stainless, [0.25, 0.0015, 0.27], [0, 0.03 + i * 0.022, 0.0], [0, 0, 0], { cast: false });
    });
  });
  // transfer module between the two cabinets
  k.at([0.95, 0, 0], 0, () => cabinet(k, { size: [0.5, 0.9, 0.9], panels: 1, rows: [0.38], sidePanels: 1, vent: true, ao: false, feet: true, stripe: KM.paintAccent }));
  // bond-side cabinet
  k.at([2.4, 0, 0], 0, () => {
    cabinet(k, { size: [2.4, 0.9, 0.9], body: KM.paintWarm, panels: 3, rows: [0.38], sidePanels: 1, handles: true, feet: true, ao: false });
    k.label('warn', 'HOT SURFACE', '', 0.08, 0.08, [0.95, 0.74, 0.451]);
  });
  // up-looking vision camera is its own component; its plinth here
  k.rbox(KM.paintGraphite, [0.16, 0.006, 0.16], 0.003, [VISION.x, TOP + 0.015, VISION.z]);
  // substrate indexer: heater block, guide rails with lips, pusher, output magazine elevator
  const sx = SUBSTRATE.x;
  k.rbox(KM.stainlessDark, [0.84, 0.03, 0.2], 0.004, [sx + 0.04, TOP + 0.015, 0]);
  k.rbox(KM.anodized, [0.24, 0.024, 0.11], 0.003, [sx, 0.964, 0]);
  for (let i = 0; i < 6; i++) k.box(KM.seam, [0.2, 0.0012, 0.0025], [sx, 0.9765, -0.04 + i * 0.016], [0, 0, 0], { cast: false });
  for (const s of [-1, 1]) {
    k.rbox(KM.anodized, [0.8, 0.07, 0.02], 0.003, [sx + 0.04, TOP + 0.065, s * 0.072]);
    k.box(KM.anodized, [0.8, 0.004, 0.014], [sx + 0.04, 0.989, s * 0.061]);
    for (let i = 0; i < 6; i++) k.cyl(KM.stainlessDark, 0.004, 0.003, [sx - 0.3 + i * 0.13, 0.993, s * 0.072], [0, 0, 0], 8, { cast: false });
  }
  k.label('warn', 'HOT', '', 0.04, 0.04, [sx - 0.2, 0.97, 0.0825]);
  k.at([3.78, 0, 0], 0, () => {
    cabinet(k, { size: [0.32, 0.9, 0.5], panels: 1, rows: [0.4], sidePanels: 1, vent: false, stripe: false, ao: false, feet: true });
    k.rbox(KM.anodizedDark, [0.05, 0.5, 0.05], 0.006, [0.1, TOP + 0.25, -0.2]);
    // substrate magazine: slotted side walls, strips inside
    k.at([0, 0.975, 0], 0, () => {
      for (const s of [-1, 1]) {
        k.rbox(KM.stainless, [0.26, 0.24, 0.006], 0.002, [0, 0.12, s * 0.08]);
        for (let i = 0; i < 10; i++) k.box(KM.seam, [0.24, 0.002, 0.002], [0, 0.02 + i * 0.022, s * 0.0835], [0, 0, 0], { cast: false });
      }
      k.rbox(KM.stainless, [0.26, 0.006, 0.166], 0.002, [0, 0.243, 0]);
      k.rbox(KM.stainless, [0.26, 0.006, 0.166], 0.002, [0, 0.003, 0]);
      for (let i = 0; i < 7; i++) k.box(M.pcb, [0.25, 0.004, 0.12], [0, 0.022 + i * 0.022, 0], [0, 0, 0], { cast: false });
    });
  });
  // X gantry: uprights, beam with linear-motor track and rails, cable tray on top
  for (const x of [-0.52, 3.48]) {
    k.rbox(KM.paint, [0.11, SORT.gantryY1 - TOP, 0.1], 0.01, [x, (TOP + SORT.gantryY1) / 2, -0.4]);
    k.rbox(KM.paintGraphite, [0.17, 0.02, 0.15], 0.004, [x, TOP + 0.01, -0.4]);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.cyl(KM.stainlessDark, 0.006, 0.008, [x + dx * 0.065, TOP + 0.024, -0.4 + dz * 0.055], [0, 0, 0], 6, { cast: false });
  }
  const bl = 4.14;
  const bc = (-0.6 + 3.54) / 2;
  const bz = SORT.beamZ - 0.06;
  k.rbox(KM.paint, [bl, SORT.gantryY1 - SORT.gantryY0, 0.12], 0.014, [bc, (SORT.gantryY0 + SORT.gantryY1) / 2, bz]);
  k.box(KM.paintGraphite, [bl - 0.12, 0.12, 0.004], [bc, 1.42, SORT.beamZ + 0.002], [0, 0, 0], { cast: false });
  for (let i = 0; i < 40; i++) k.box(KM.anodizedDark, [0.05, 0.1, 0.003], [-0.45 + i * 0.1, 1.42, SORT.beamZ + 0.005], [0, 0, 0], { cast: false });
  for (const y of [1.27, 1.57]) {
    k.box(KM.chrome, [bl - 0.12, 0.012, 0.01], [bc, y, SORT.beamZ + 0.005]);
    k.box(KM.seam, [bl - 0.1, 0.004, 0.002], [bc, y + 0.012, SORT.beamZ + 0.001], [0, 0, 0], { cast: false });
  }
  for (const x of [-0.58, 3.52]) k.rbox(KM.paintGraphite, [0.04, 0.42, 0.13], 0.008, [x, (SORT.gantryY0 + SORT.gantryY1) / 2, bz]);
  k.label('warn', 'MOVING GANTRY', '', 0.08, 0.08, [-0.3, 1.42, SORT.beamZ + 0.006]);
  ledStrip(k, 0.8, [1.6, 1.6, SORT.beamZ + 0.002], KM.ledGreen);
  {
    const y = SORT.gantryY1 + 0.004;
    for (const s of [-1, 1]) k.box(KM.anodized, [bl - 0.3, 0.05, 0.004], [bc, y + 0.025, bz + s * 0.045], [0, 0, 0], { cast: false });
    for (let i = 0; i < 4; i++) k.cyl([KM.plastic, KM.paintGraphite, KM.paintBlue, KM.plastic][i], 0.008 + (i % 2) * 0.003, bl - 0.32, [bc, y + 0.012 + (i % 2) * 0.01, bz - 0.03 + i * 0.02], RZ, 8, { cast: false });
  }
  // operator HMI on an arm off the bond cabinet
  k.at([1.75, 0.9, 0.42], 0, () => {
    k.cyl(KM.anodizedDark, 0.02, 0.36, [0, 0.2, 0], [0, 0, 0], 12);
    k.rbox(KM.plastic, [0.36, 0.25, 0.035], 0.008, [0, 0.47, 0.06], [-0.25, 0, 0]);
    k.box(KM.screen, [0.32, 0.2, 0.002], [0, 0.474, 0.079], [-0.25, 0, 0], { cast: false });
  });
  // facilities at the back, lines to the floor
  utilityPanel(k, [2.4, 0.45, -0.451], Math.PI, [['VAC', '#3a3f43'], ['CDA', '#4a6a8a'], ['N₂', '#3e7d4c']]);
  hose(k, [2.33, 0.45, -0.52], [2.2, 0.02, -1.1], 0.012, 0.05, KM.plastic);
  hose(k, [2.42, 0.45, -0.52], [2.5, 0.02, -1.15], 0.012, 0.05, KM.paintBlue);
  k.ao(1.6, 1.35, [0, 0, 0], 1.2);
  k.ao(0.6, 1.0, [0.95, 0, 0], 1.2);
  k.ao(2.5, 1.05, [2.4, 0, 0], 1.2);
  k.ao(0.45, 0.6, [-0.88, 0, -0.05], 1.25);
  k.ao(0.4, 0.6, [3.78, 0, 0], 1.25);
}

/** Up-looking die camera under the transfer path: housing, telecentric lens, ring light, cover glass. */
function buildVision(k: Kit) {
  k.at([VISION.x, 0.934, VISION.z], 0, () => {
    k.rbox(KM.anodizedDark, [0.09, 0.05, 0.09], 0.006, [0, 0.025, 0]);
    k.cyl(KM.plastic, 0.026, 0.05, [0, 0.075, 0], [0, 0, 0], 24);
    k.cyl(KM.anodized, 0.044, 0.012, [0, 0.106, 0], [0, 0, 0], 32);
    k.torus(KM.ledWhite, 0.034, 0.004, [0, 0.113, 0], [0, 0, 0], 32);
    k.cyl(KM.glassSmoke, 0.024, 0.002, [0, 0.112, 0], [0, 0, 0], 24, { cast: false });
    k.cyl(KM.plastic, 0.008, 0.03, [0.05, 0.025, 0], RZ, 10);
  });
  line(k, [2.52, 0.959, 0], [2.6, 0.926, -0.15], 0.004, 0.01, KM.plastic);
}

/** Ejector housing under the pick position: stage, column, dome with vacuum holes. */
function buildEjector(k: Kit, x: number, z: number) {
  k.at([x, 0, z], 0, () => {
    k.cyl(KM.stainlessDark, 0.02, 0.03, [0, 0.95, 0], [0, 0, 0], 20);
    k.cyl(KM.stainless, 0.013, 0.025, [0, 0.977, 0], [0, 0, 0], 20);
    k.lathe(KM.stainless, [[0.013, 0.989], [0.012, 0.9935], [0.009, 0.9955], [0.0001, 0.9958]], [0, 0, 0], [0, 0, 0], 24);
  });
}

/** Bond head on the X carriage (rides the collet group): collet, shaft, voice-coil Z, θ motor, arm. */
function buildBondHead(k: Kit) {
  k.cyl(KM.rubber, 0.006, 0.02, [0, 0.01, 0], [0, 0, 0], 12);
  k.cyl(KM.chrome, 0.008, 0.035, [0, 0.0375, 0], [0, 0, 0], 16);
  k.cyl(KM.chrome, 0.0045, 0.07, [0, 0.09, 0], [0, 0, 0], 12);
  k.cyl(KM.anodizedDark, 0.007, 0.012, [0, 0.07, 0], [0, 0, 0], 6);
  k.cyl(KM.chrome, 0.003, 0.016, [0.01, 0.07, 0], RZ, 8);
  // voice-coil Z head with θ motor on top
  k.rbox(KM.paint, [0.06, 0.11, 0.07], 0.008, [0, 0.18, -0.005]);
  k.box(KM.seam, [0.062, 0.003, 0.072], [0, 0.155, -0.005], [0, 0, 0], { cast: false });
  k.cyl(KM.anodizedDark, 0.022, 0.04, [0, 0.255, -0.005], [0, 0, 0], 20);
  k.cyl(KM.chrome, 0.008, 0.012, [0, 0.281, -0.005], [0, 0, 0], 12);
  k.box(KM.ledGreen, [0.012, 0.006, 0.002], [0.012, 0.21, 0.031], [0, 0, 0], { cast: false });
  // Z-slide plate and arm back to the X carriage on the gantry beam
  k.rbox(KM.anodizedDark, [0.07, 0.2, 0.014], 0.003, [0, 0.22, -0.047]);
  k.rbox(KM.paint, [0.07, 0.06, 0.28], 0.01, [0, 0.3, -0.18]);
  k.rbox(KM.anodizedDark, [0.15, 0.13, 0.03], 0.006, [0, 0.3, -0.315]);
  for (const s of [-1, 1]) k.cyl(KM.chrome, 0.004, 0.004, [s * 0.05, 0.35, -0.298], RX, 8, { cast: false });
  // vacuum line from the collet up the arm
  k.tube(KM.plastic, [[0.016, 0.07, 0], [0.03, 0.1, 0.005], [0.04, 0.2, 0.0], [0.04, 0.33, -0.06], [0.03, 0.34, -0.25]], 0.0025, { radial: 6 });
}

/* ---------------------------------------------------------------- pick */

const dieTopMat = new THREE.MeshStandardMaterial({ map: null, roughness: 0.35, metalness: 0.35 });
const badMark = new THREE.MeshBasicMaterial({ color: '#c4483b', toneMapped: false });

/** Substrate strip on the indexer: laminate, bonded dies upstream, epoxy dots on the empty sites. */
function buildStrip(k: Kit) {
  k.box(M.pcb, [0.5, 0.008, 0.12], [SUBSTRATE.x, SUBSTRATE.y, SUBSTRATE.z]);
  for (let i = 0; i < 5; i++) {
    const x = SUBSTRATE.x - 0.2 + i * 0.1;
    k.box(KM.copper, [0.05, 0.0006, 0.05], [x, SUBSTRATE.y + 0.0043, 0], [0, 0, 0], { cast: false });
    if (i < 2) k.add(dieTopMat, new THREE.BoxGeometry(DIE_W / 1000, 0.0008, DIE_H / 1000), [x, SUBSTRATE.y + 0.005, 0], [0, 0, 0], [1, 1, 1], { keepUV: true, cast: false });
    else if (i > 2) for (const [dx, dz] of [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]]) k.cyl(KM.plasticWhite, 0.0018, 0.001, [x + dx * 0.004, SUBSTRATE.y + 0.0048, dz * 0.004], [0, 0, 0], 8, { cast: false });
  }
  for (let i = 0; i < 12; i++) for (const s of [-1, 1]) k.cyl(KM.seam, 0.0015, 0.0005, [SUBSTRATE.x - 0.24 + i * 0.0436, SUBSTRATE.y + 0.0041, s * 0.053], [0, 0, 0], 8, { cast: false });
}

const _home = new THREE.Vector3();
const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const LIFT = new THREE.Vector3(0, 0.02, 0);

function Pick() {
  const dies = engine.waferMap;
  const followed = engine.followedDie;
  const inst = useRef<THREE.InstancedMesh>(null);
  const marks = useRef<THREE.InstancedMesh>(null);
  const die = useRef<THREE.Group>(null);
  const collet = useRef<THREE.Group>(null);
  const needle = useRef<THREE.Mesh>(null);
  useEffect(() => {
    dieTopMat.map = dieFloorplan('cpu');
    dieTopMat.needsUpdate = true;
  }, []);
  // already-picked good dies are gone; failing dies stay (marked)
  const remaining = useMemo(() => {
    const pass = dies.filter((d) => d.result === 'PASS' && d !== followed);
    const gone = new Set(pass.slice(0, Math.max(0, pass.length - 14)).map((d) => d.die.id));
    return dies.filter((d) => !gone.has(d.die.id) && d !== followed);
  }, [dies, followed]);
  const bad = useMemo(() => remaining.filter((d) => d.result !== 'PASS'), [remaining]);
  const o = useMemo(() => new THREE.Object3D(), []);
  const fpos = useRef(new THREE.Vector3());
  useFrame(() => {
    const ex = 1 + 0.06 * smooth(pp('expand'));
    if (inst.current) {
      remaining.forEach((d, i) => {
        o.position.set((d.die.cx / 1000) * ex, WY + 0.0004, (d.die.cy / 1000) * ex);
        o.scale.set((DIE_W / 1000) * 0.96, 0.0008, (DIE_H / 1000) * 0.96);
        o.updateMatrix();
        inst.current!.setMatrixAt(i, o.matrix);
      });
      inst.current.instanceMatrix.needsUpdate = true;
    }
    if (marks.current) {
      bad.forEach((d, i) => {
        o.position.set((d.die.cx / 1000) * ex, WY + 0.0012, (d.die.cy / 1000) * ex);
        o.scale.set(0.002, 0.0004, 0.002);
        o.updateMatrix();
        marks.current!.setMatrixAt(i, o.matrix);
      });
      marks.current.instanceMatrix.needsUpdate = true;
    }
    // followed die: eject → pick → vision → transfer
    const home = _home.set((followed.die.cx / 1000) * ex, WY + 0.0004, (followed.die.cy / 1000) * ex);
    const ej = smooth(pp('eject'));
    const pk = smooth(pp('pick'));
    const vi = smooth(pp('inspect'));
    const tr = smooth(pp('transfer'));
    const p = _p.copy(home);
    p.y += 0.004 * ej + 0.12 * pk;
    if (vi > 0) p.lerp(_t.copy(VISION).add(LIFT), vi);
    if (tr > 0) p.lerp(_t.copy(SUBSTRATE).add(LIFT), tr);
    fpos.current.copy(p);
    if (die.current) die.current.position.copy(p);
    if (collet.current) {
      const cy = pk > 0 ? p.y + 0.012 : WY + 0.12 - 0.11 * ej;
      collet.current.position.set(p.x, cy, p.z);
    }
    if (needle.current) {
      needle.current.position.set(home.x, WY - 0.03 + 0.03 * ej * (1 - pk), home.z);
      needle.current.visible = ej > 0 && pk < 1;
    }
    track('focus', p.x, p.y, p.z);
  });
  const station = useStation(
    {
      body: buildSorterBody,
      vision: buildVision,
      ejector: (k) => buildEjector(k, (followed.die.cx / 1000) * 1.06, (followed.die.cy / 1000) * 1.06),
      _strip: (k) => buildStrip(k),
    },
    [followed],
  );
  const headKit = useKit(buildBondHead);
  return (
    <group>
      <StationView m={station} />
      <Clickable sel={{ kind: 'machine', id: 'die-bonder', label: 'Die sorter / bonder' }}>
        <PickProxy m={station} tag="body" />
        <SignalTower position={[0.62, 0.95, 0.5]} />
      </Clickable>
      {/* expanded tape (the frame is part of the station model) */}
      <mesh position={[0, WY - 0.003, 0]} rotation={[-Math.PI / 2, 0, 0]} material={tapeMat}>
        <circleGeometry args={[0.2, 64]} />
      </mesh>
      <instancedMesh ref={inst} args={[GEO.box, dieTopMat, remaining.length]} castShadow />
      <instancedMesh ref={marks} args={[GEO.cylLow, badMark, bad.length]} />
      <Clickable sel={{ kind: 'component', id: 'ejector', machine: 'die-bonder', label: 'Ejector needles' }}>
        <PickProxy m={station} tag="ejector" />
        <mesh ref={needle} material={M.steel}>
          <cylinderGeometry args={[0.0008, 0.0003, 0.06, 6]} />
        </mesh>
      </Clickable>
      <group ref={die}>
        <Clickable sel={{ kind: 'die', id: String(followed.die.id), label: 'Followed die' }}>
          <mesh geometry={GEO.box} material={dieTopMat} scale={[DIE_W / 1000, 0.0008, DIE_H / 1000]} castShadow />
        </Clickable>
      </group>
      <group ref={collet}>
        <Clickable sel={{ kind: 'component', id: 'collet', machine: 'die-bonder', label: 'Vacuum collet' }}>
          <Baked parts={headKit} />
        </Clickable>
      </group>
      {/* vision station + substrate strip */}
      <Clickable sel={{ kind: 'component', id: 'vision', machine: 'die-bonder', label: 'Vision system' }}>
        <PickProxy m={station} tag="vision" />
      </Clickable>
    </group>
  );
}

function VisionInset() {
  return (
    <Inset id="vision" position={[2.45, 1.45, 0.25]} size={[0.8, 0.55]} mpu={0.02 / 0.8} title="VISION CHECK · DIE CAMERA">
      <Screen
        size={[0.76, 0.5]}
        position={[0, 0, 0]}
        hz={6}
        frame={false}
        res={512}
        draw={(g, w, h) => {
          clear(g, w, h, 'DIE IMAGE · SIMULATED');
          const img = (dieFloorplan('cpu') as THREE.CanvasTexture).image as HTMLCanvasElement;
          const dw = h * 0.62 * (DIE_W / DIE_H);
          const dh = h * 0.62;
          const x0 = w * 0.08;
          const y0 = h * 0.2;
          g.drawImage(img, x0, y0, dw, dh);
          g.strokeStyle = SCR.accent;
          g.lineWidth = 2;
          g.strokeRect(x0, y0, dw, dh);
          g.beginPath();
          g.moveTo(x0 + dw / 2, y0 - 8);
          g.lineTo(x0 + dw / 2, y0 + dh + 8);
          g.moveTo(x0 - 8, y0 + dh / 2);
          g.lineTo(x0 + dw + 8, y0 + dh / 2);
          g.stroke();
          const ok = pp('inspect') > 0.4;
          bigNumber(g, 'EDGE CHIPPING', ok ? 'NONE' : '…', '', w * 0.55, h * 0.26, h * 0.08, ok ? SCR.good : SCR.text);
          bigNumber(g, 'POSITION', ok ? '±2 µm' : '…', '', w * 0.55, h * 0.48, h * 0.08);
          bigNumber(g, 'DIE', `#${engine.followedDie.die.id}`, 'PASS', w * 0.55, h * 0.7, h * 0.08, SCR.good);
        }}
      />
    </Inset>
  );
}

function SawScreen() {
  return (
    <group position={[1.15, 0, -0.5]} rotation={[0, -0.6, 0]}>
      <Screen
        size={[0.6, 0.38]}
        position={[0, 1.5, 0.03]}
        hz={5}
        draw={(g, w, h) => {
          clear(g, w, h, 'DICING · SIMULATED');
          bigNumber(g, 'STREETS', engine.tele.value('cuts', 0).toFixed(0), `/ ${NX + NY}`, w * 0.05, h * 0.24, h * 0.11);
          bigNumber(g, 'SPINDLE', engine.tele.value('spindle', 0).toFixed(1), 'krpm', w * 0.5, h * 0.24, h * 0.11);
          bigNumber(g, 'BLADE LOAD', engine.tele.value('load', 0).toFixed(2), 'A', w * 0.05, h * 0.6, h * 0.11);
        }}
      />
    </group>
  );
}

export default function DicingScene({ stage }: SceneProps) {
  const pick = stage.variant === 'pick';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.3;
  }, []);
  return (
    <>
      <Lighting env="assembly" shadowExtent={6} />
      <AssemblyFloor width={12} depth={9} />
      {pick ? <Pick /> : <Saw />}
      {pick ? <VisionInset /> : <SawScreen />}
      {!pick && <SensorIndicator id="joint-encoder" channel="spindle" machine="dicing-saw" position={[0.2, 1.25, -0.45]} size={0.035} />}
      {pick && <SensorIndicator id="vacuum-switch" channel="vac" machine="die-bonder" position={[0.2, 1.3, -0.3]} size={0.035} />}
      <TechLabel
        position={[-0.75, 1.7, 0.3]}
        title={pick ? 'DIE PICK · ONLY GOOD DIES' : 'DICING · DIAMOND BLADE'}
        lines={[pick ? 'red dots: rejected in wafer sort — they stay on the tape' : 'cuts along every scribe street, then rotates 90°']}
        min={1}
        value={() => engine.player.view.phase.label}
      />
      <Operator position={[-1.0, 0, 1.5]} rotation={Math.PI * 0.85} still />
    </>
  );
}

