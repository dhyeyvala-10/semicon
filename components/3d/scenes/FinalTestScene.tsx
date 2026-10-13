'use client';
/**
 * Final test & binning (§50, §51): a pick-and-place test handler and the ATE.
 *   test: the packaged chip is picked from the input tray, seated in the socket, soaked to
 *         85 °C, tested electrically and functionally (a shmoo plot builds up), and binned.
 *   bin:  devices stream through the socket into BIN A / B / C / REJECT trays according to
 *         their SIMULATED maximum frequency.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ViewMode } from '@/types';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, AssemblyFloor } from '../environments';
import { M, shell } from '../materials';
import { GEO } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Kit, cabinet, windowPane, estop, ledStrip, grille, hose, type BakedPart, type V3 } from '../kit/build';
import { KM } from '../kit/finish';
import { Baked, useKit } from '../kit/Baked';
import { casterGeometry, shadowOnly } from '../kit/shadow';
import { useUI } from '@/lib/store';
import { Screen, clear, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { engine, BINS } from '@/simulation/engine';
import { pp, inPhase } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { clamp, smooth, fract, hash1 } from '@/lib/math';

const TY = 1.02; // tray / socket surface
const PKG = 0.045;
const INPUT = new THREE.Vector3(-0.5, TY, 0.22);
const SOCKET = new THREE.Vector3(0, TY, -0.12);
const BIN_X: Record<string, number> = { A: 0.3, B: 0.48, C: 0.66, REJECT: 0.84 };
const BIN_Z = 0.22;
const BIN_COLOR: Record<string, string> = { A: '#4f9a5a', B: '#8fae62', C: '#c9b46a', REJECT: '#c4483b' };

/** tray pocket offset k (4 × 6 grid), written into `out` (no per-frame allocation) */
const slotInto = (k: number, out: THREE.Vector3) => {
  const i = k % 4;
  const j = Math.floor(k / 4) % 6;
  return out.set((i - 1.5) * 0.05, 0, (j - 2.5) * 0.05);
};
const _slot = new THREE.Vector3();
const _cp = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/* ---------------------------------------------------------------- materials */

const pkgMat = new THREE.MeshStandardMaterial({ color: '#c9cdd0', roughness: 0.3, metalness: 0.9 });
const pkgSub = new THREE.MeshStandardMaterial({ color: '#2e5a43', roughness: 0.5 });
const trayMat = new THREE.MeshStandardMaterial({ color: '#1f2421', roughness: 0.7 });
const MAT_GOLD = new THREE.MeshStandardMaterial({ color: '#d9a944', roughness: 0.28, metalness: 1 });
const heatMat = new THREE.MeshStandardMaterial({ color: '#6b6e70', roughness: 0.4, metalness: 0.7, emissive: new THREE.Color('#ff6a1a'), emissiveIntensity: 0 });

/* ---------------------------------------------------------------- station models */

/*
 * Static equipment is built with the detailing kit and merged across components into one
 * mesh per finish; selection works through invisible pick proxies (visible = false: never
 * drawn, still raycast) inside each component's Clickable, and the shadow comes from ONE
 * position-only caster. Moving parts (gantry, head, thermal head, chip) keep their refs.
 */
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

function PickProxy({ m, tag }: { m: Station; tag: string }) {
  const g = m.picks[tag];
  return g ? <mesh geometry={g} material={PICK_MAT} visible={false} /> : null;
}

/* ---------------------------------------------------------------- handler models */

const RZ: V3 = [0, 0, Math.PI / 2];
const DECK = 1.0;
const binMats: Record<string, THREE.MeshBasicMaterial> = Object.fromEntries(Object.entries(BIN_COLOR).map(([b, c]) => [b, new THREE.MeshBasicMaterial({ color: c, toneMapped: false })]));
const inputMat = new THREE.MeshBasicMaterial({ color: '#8a8f86', toneMapped: false });

/** JEDEC tray: moulded base with a raised rim and pocket ribs (4 × 6 pockets), colour code strip. */
function jedecTray(k: Kit, x: number, z: number, code: THREE.Material) {
  k.at([x, TY - 0.006, z], 0, () => {
    k.rbox(trayMat, [0.17, 0.012, 0.3], 0.003, [0, 0, 0]);
    for (const s of [-1, 1]) {
      k.box(trayMat, [0.17, 0.006, 0.006], [0, 0.009, s * 0.147], [0, 0, 0], { cast: false });
      k.box(trayMat, [0.006, 0.006, 0.3], [s * 0.082, 0.009, 0], [0, 0, 0], { cast: false });
    }
    for (let i = 1; i < 4; i++) k.box(trayMat, [0.0035, 0.004, 0.29], [(i - 2) * 0.05, 0.008, 0], [0, 0, 0], { cast: false });
    for (let j = 1; j < 6; j++) k.box(trayMat, [0.16, 0.004, 0.0035], [0, 0.008, (j - 3) * 0.05], [0, 0, 0], { cast: false });
    k.box(KM.seam, [0.02, 0.003, 0.012], [-0.07, 0.0075, 0.14], [0, 0, 0], { cast: false });
    k.add(code, new THREE.PlaneGeometry(0.17, 0.02), [0, 0.0065, -0.16], [-Math.PI / 2, 0, 0], [1, 1, 1], { keepUV: true, cast: false });
  });
}

/** Handler frame: base cabinet, work deck, low guards, gantry frame and X rails, soak chamber, utilities. */
function buildHandlerBody(k: Kit) {
  const sh = { shell: true };
  k.at([0.15, 0, 0], 0, () => {
    cabinet(k, { size: [2.0, 0.95, 1.2], panels: 3, rows: [0.38], sidePanels: 2, handles: true, feet: true, ao: false });
    k.label('model', 'TH-850', 'PICK & PLACE TEST HANDLER', 0.42, 0.1, [-0.5, 0.84, 0.601]);
    k.label('info', 'SN 1288-TH', '−40 … +125 °C · 4 SITES', 0.2, 0.05, [0.65, 0.12, 0.601]);
    estop(k, [0.77, 0.8, 0.6]);
  });
  // anodised work deck with a docking plate around the socket (test head docked underneath)
  k.rbox(KM.anodized, [2.0, 0.028, 1.2], 0.006, [0.15, 0.986, 0]);
  k.rbox(KM.anodizedDark, [0.36, 0.006, 0.32], 0.004, [SOCKET.x, DECK + 0.001, SOCKET.z]);
  k.box(M.pcb, [0.28, 0.004, 0.24], [SOCKET.x, DECK + 0.005, SOCKET.z]);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.cyl(KM.stainlessDark, 0.008, 0.012, [SOCKET.x + sx * 0.16, DECK + 0.01, SOCKET.z + sz * 0.14], [0, 0, 0], 12, { cast: false });
  // tray nests: locating pins at each tray corner
  for (const [x, z] of [[INPUT.x, INPUT.z], ...Object.values(BIN_X).map((bx) => [bx, BIN_Z])] as [number, number][])
    for (const [sx, sz] of [[-1, -1], [1, 1]]) k.cyl(KM.stainless, 0.004, 0.02, [x + sx * 0.092, DECK + 0.01, z + sz * 0.158], [0, 0, 0], 8, { cast: false });
  // low safety guards with framed polycarbonate, rear screen
  const gy = DECK + 0.13;
  windowPane(k, 1.92, 0.22, [0.15, gy, 0.6], { ...sh, frame: KM.anodizedDark, glass: KM.glass });
  for (const s of [-1, 1]) k.at([s < 0 ? -0.84 : 1.14, 0, 0], [0, Math.PI / 2, 0], () => windowPane(k, 1.12, 0.22, [0, gy, 0], { ...sh, frame: KM.anodizedDark, glass: KM.glass }));
  windowPane(k, 1.92, 0.56, [0.15, DECK + 0.3, -0.6], { ...sh, frame: KM.anodizedDark, glass: KM.glass });
  // gantry frame: four posts carrying the X rails
  for (const x of [-0.82, 1.12])
    for (const z of [-0.46, 0.46]) {
      k.rbox(KM.anodizedDark, [0.05, 0.47, 0.05], 0.006, [x, DECK + 0.235, z]);
      k.rbox(KM.anodizedDark, [0.09, 0.012, 0.09], 0.003, [x, DECK + 0.006, z]);
    }
  for (const z of [-0.46, 0.46]) {
    k.rbox(KM.anodized, [2.0, 0.04, 0.06], 0.006, [0.15, 1.5 - 0.035, z]);
    k.box(KM.chrome, [1.96, 0.014, 0.02], [0.15, 1.5 - 0.008, z]);
    k.box(KM.seam, [1.96, 0.004, 0.062], [0.15, 1.5 - 0.016, z], [0, 0, 0], { cast: false });
    for (const x of [-0.85, 1.15]) k.rbox(KM.paintGraphite, [0.02, 0.05, 0.07], 0.004, [x, 1.5 - 0.03, z]);
  }
  for (const x of [-0.82, 1.12]) k.rbox(KM.anodizedDark, [0.05, 0.04, 0.92], 0.006, [x, 1.5 - 0.035, 0]);
  ledStrip(k, 0.6, [0.15, 1.465, 0.4915], KM.ledGreen);
  k.label('warn', 'MOVING PARTS', '', 0.06, 0.06, [1.12, 1.35, 0.4865]);
  // input tray stacker beside the input tray (full trays waiting), corner guides
  k.at([-0.72, DECK, INPUT.z], 0, () => {
    for (let i = 0; i < 6; i++) k.rbox(trayMat, [0.17, 0.011, 0.3], 0.003, [0, 0.006 + i * 0.012, 0]);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box(KM.anodizedDark, [0.012, 0.12, 0.012], [sx * 0.092, 0.06, sz * 0.157]);
    k.rbox(KM.anodizedDark, [0.2, 0.01, 0.33], 0.003, [0, 0.005, 0]);
  });
  // thermal soak chamber: insulated box, glass lid, heater, display
  k.at([-0.5, DECK, -0.24], 0, () => {
    k.rbox(KM.paint, [0.26, 0.11, 0.2], 0.012, [0, 0.055, 0]);
    windowPane(k, 0.18, 0.12, [0, 0.112, 0], { frame: KM.anodizedDark, glass: KM.glassSmoke });
    k.box(KM.screen, [0.06, 0.022, 0.002], [0.07, 0.06, 0.101], [0, 0, 0], { cast: false });
    k.box(KM.ledAmber, [0.008, 0.008, 0.002], [-0.09, 0.07, 0.101], [0, 0, 0], { cast: false });
    k.label('warn', 'HOT', '', 0.035, 0.035, [-0.05, 0.065, 0.1012]);
    for (let i = 0; i < 4; i++) k.box(KM.seam, [0.2, 0.002, 0.002], [0, 0.02 + i * 0.012, 0.1005], [0, 0, 0], { cast: false });
    hose(k, [-0.13, 0.04, -0.06], [-0.3, -0.01, -0.2], 0.008, 0.02, KM.ptfe);
  });
  // operator panel and signal-tower boss on the right ledge
  k.cyl(KM.anodizedDark, 0.022, 0.05, [1.05, DECK + 0.025, 0.5], [0, 0, 0], 16);
  k.at([1.07, DECK, 0.12], -Math.PI / 2, () => {
    k.rbox(KM.plastic, [0.2, 0.03, 0.12], 0.008, [0, 0.015, 0]);
    for (let i = 0; i < 3; i++) k.cyl([KM.ledGreen, KM.ledAmber, KM.paintRed][i], 0.008, 0.008, [-0.06 + i * 0.05, 0.033, 0.0], [0, 0, 0], 12, { cast: false });
  });
  // facilities at the back, mains feed to the floor
  k.at([0.7, 0.45, -0.601], Math.PI, () => grille(k, 0.4, 0.22, [0, 0, 0]));
  hose(k, [-0.6, 0.3, -0.62], [-0.7, 0.01, -1.2], 0.02, 0.05, KM.plastic);
  hose(k, [-0.5, 0.3, -0.62], [-0.45, 0.01, -1.25], 0.012, 0.05, KM.paintBlue);
  k.ao(2.2, 1.4, [0.15, 0, 0], 1.18);
}

/** Test socket on the load board: socket body, alignment frame, guide pins, contactor field. */
function buildSocket(k: Kit) {
  k.at([SOCKET.x, TY, SOCKET.z], 0, () => {
    k.rbox(M.panelDark, [0.09, 0.016, 0.09], 0.003, [0, -0.012, 0]);
    k.box(KM.seam, [0.05, 0.002, 0.05], [0, -0.0035, 0], [0, 0, 0], { cast: false });
    for (const s of [-1, 1]) {
      k.box(KM.anodizedDark, [0.09, 0.006, 0.016], [0, -0.001, s * 0.037]);
      k.box(KM.anodizedDark, [0.016, 0.006, 0.058], [s * 0.037, -0.001, 0]);
    }
    for (const [sx, sz] of [[-1, -1], [1, 1]]) k.cyl(KM.stainless, 0.003, 0.012, [sx * 0.04, 0.004, sz * 0.04], [0, 0, 0], 8, { cast: false });
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) k.cyl(MAT_GOLD, 0.0016, 0.001, [(i - 2.5) * 0.007, -0.0035, (j - 2.5) * 0.007], [0, 0, 0], 6, { cast: false });
  });
}

/** ATE mainframe: rack cabinet with instrument slots behind a glazed door, test-head cable bundle. */
function buildATE(k: Kit) {
  k.at([-1.35, 0, -0.2], 0, () => {
    cabinet(k, { size: [0.8, 1.9, 0.9], body: KM.paintDark, trim: KM.paintGraphite, panels: 1, rows: [0.3], sidePanels: 2, vent: true, stripe: KM.paintAccent, ao: true, feet: true });
    // glazed rack door with the instrument boards behind
    k.box(KM.seam, [0.66, 1.3, 0.004], [0, 1.08, 0.451]);
    for (let r = 0; r < 4; r++)
      for (let i = 0; i < 12; i++) {
        const y = 0.55 + r * 0.33;
        k.rbox(i % 4 === 0 ? KM.anodized : KM.anodizedDark, [0.046, 0.28, 0.01], 0.002, [-0.28 + i * 0.051, y + 0.15, 0.456], [0, 0, 0], { cast: false });
        if (i % 3 === 1) k.box(KM.ledGreen, [0.006, 0.006, 0.002], [-0.28 + i * 0.051, y + 0.27, 0.462], [0, 0, 0], { cast: false });
      }
    windowPane(k, 0.66, 1.3, [0, 1.08, 0.462], { frame: KM.paintGraphite, glass: KM.glassSmoke });
    k.rbox(KM.anodized, [0.016, 0.24, 0.024], 0.006, [0.3, 1.08, 0.49]);
    k.label('model', 'TX-9000', 'TEST SYSTEM · 1024 CH', 0.36, 0.085, [0, 1.84, 0.4515]);
    k.label('warn', 'HIGH VOLTAGE', '', 0.07, 0.07, [-0.28, 0.2, 0.4515]);
    ledStrip(k, 0.5, [0, 1.76, 0.452], KM.ledGreen);
    grille(k, 0.5, 0.18, [0, 0.16, 0.452]);
  });
  // test-head cable bundle from the mainframe into the handler (test head docked under the socket)
  k.cyl(KM.anodizedDark, 0.06, 0.08, [-0.93, 1.2, -0.1], RZ, 20);
  k.cyl(KM.anodizedDark, 0.06, 0.08, [-0.88, 0.62, -0.15], RZ, 20);
  for (let i = 0; i < 3; i++) hose(k, [-0.9, 1.2 + (i - 1) * 0.03, -0.1 + (i - 1) * 0.02], [-0.86, 0.62 + (i - 1) * 0.03, -0.15 + (i - 1) * 0.02], 0.022, 0.18 + i * 0.03, KM.plastic);
}

/** Pole and housing of the tester screen (the screen itself is a live Screen). */
function buildScreenStand(k: Kit) {
  k.at([0.15, 0, -0.5], 0, () => {
    k.rbox(KM.plastic, [0.94, 0.54, 0.035], 0.012, [0, 1.78, -0.03]);
    k.rbox(KM.anodizedDark, [0.14, 0.14, 0.04], 0.008, [0, 1.78, -0.06]);
    k.cyl(KM.anodized, 0.025, 0.56, [0, 1.3, -0.06], [0, 0, 0], 16);
    k.rbox(KM.anodizedDark, [0.1, 0.012, 0.1], 0.003, [0, DECK + 0.006, -0.06]);
  });
}

/** Y beam of the pick-and-place gantry (rides the gantry group in X): extrusion, carriages, motor. */
function buildGantry(k: Kit) {
  const prof: [number, number][] = [[-0.03, -0.03], [-0.008, -0.03], [-0.008, -0.024], [0.008, -0.024], [0.008, -0.03], [0.03, -0.03], [0.03, -0.008], [0.024, -0.008], [0.024, 0.008], [0.03, 0.008], [0.03, 0.03], [0.008, 0.03], [0.008, 0.024], [-0.008, 0.024], [-0.008, 0.03], [-0.03, 0.03], [-0.03, 0.008], [-0.024, 0.008], [-0.024, -0.008], [-0.03, -0.008]];
  k.extrude(KM.anodized, prof, 0.8, [0, 1.45, -0.4]);
  for (const z of [-0.46, 0.46]) {
    k.rbox(KM.anodizedDark, [0.09, 0.03, 0.08], 0.006, [0, 1.5 + 0.016, z]);
    k.rbox(KM.anodizedDark, [0.07, 0.1, 0.03], 0.006, [0, 1.48, z + (z < 0 ? 0.045 : -0.045)]);
    k.rbox(KM.paintGraphite, [0.03, 0.03, 0.03], 0.004, [0.05, 1.52, z]);
  }
  k.rbox(KM.plastic, [0.05, 0.012, 0.74], 0.004, [0, 1.486, 0]);
}

/** Pick-and-place head (rides the head group): suction cup, nozzle, Z body, slide plate on the beam. */
function buildPnpHead(k: Kit) {
  k.lathe(KM.rubber, [[0.006, 0], [0.018, 0], [0.016, 0.004], [0.012, 0.006], [0.015, 0.009], [0.008, 0.012]], [0, 0, 0], [0, 0, 0], 20);
  k.cyl(KM.stainless, 0.005, 0.03, [0, 0.025, 0], [0, 0, 0], 12);
  k.cyl(KM.chrome, 0.008, 0.26, [0, 0.17, 0], [0, 0, 0], 16);
  k.rbox(KM.anodized, [0.05, 0.12, 0.05], 0.006, [0, 0.36, 0]);
  k.cyl(KM.anodizedDark, 0.018, 0.04, [0, 0.44, 0], [0, 0, 0], 16);
  k.rbox(KM.anodizedDark, [0.012, 0.2, 0.06], 0.003, [-0.04, 0.38, 0]);
  k.cyl(KM.stainlessDark, 0.004, 0.012, [0.026, 0.33, 0], RZ, 8, { cast: false });
  k.tube(KM.plastic, [[0.032, 0.33, 0], [0.05, 0.38, 0.0], [0.04, 0.46, 0.0]], 0.003, { radial: 6 });
}

/** Thermal head (rides the thermal group): heated ring plunger around the pick nozzle, cold plate, guides, yoke. */
function buildThermalHead(k: Kit) {
  k.lathe(heatMat, [[0.021, 0], [0.034, 0], [0.034, 0.02], [0.021, 0.02], [0.021, 0]], [0, 0, 0], [0, 0, 0], 32);
  k.lathe(KM.copper, [[0.022, 0.02], [0.037, 0.02], [0.037, 0.03], [0.022, 0.03], [0.022, 0.02]], [0, 0, 0], [0, 0, 0], 32);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    k.box(KM.anodizedDark, [0.004, 0.03, 0.014], [Math.cos(a) * 0.03, 0.046, Math.sin(a) * 0.03], [0, -a, 0], { cast: false });
  }
  for (const s of [-1, 1]) {
    k.cyl(KM.chrome, 0.004, 0.14, [s * 0.046, 0.1, 0], [0, 0, 0], 10);
    k.rbox(KM.anodizedDark, [0.02, 0.02, 0.02], 0.004, [s * 0.046, 0.03, 0]);
  }
  k.rbox(KM.anodizedDark, [0.12, 0.016, 0.03], 0.004, [0, 0.175, 0.024]);
  k.rbox(KM.anodizedDark, [0.12, 0.016, 0.03], 0.004, [0, 0.175, -0.024]);
  hose(k, [0.036, 0.04, 0.02], [0.09, 0.16, 0.06], 0.004, 0.01, KM.paintBlue);
  hose(k, [0.036, 0.04, -0.02], [0.09, 0.16, -0.06], 0.004, 0.01, KM.paintRed);
}

function Package({ position }: { position?: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh geometry={GEO.box} material={pkgSub} scale={[PKG, 0.0015, PKG]} position={[0, 0.00075, 0]} />
      <mesh geometry={GEO.box} material={pkgMat} scale={[PKG * 0.8, 0.0025, PKG * 0.8]} position={[0, 0.0028, 0]} />
    </group>
  );
}

/** Chips in a tray: `count()` visible slots (each slot can stand for several devices). */
function TrayChips({ x, z, count }: { x: number; z: number; count: () => number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const top = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  useFrame(() => {
    const n = Math.min(24, Math.ceil(count()));
    for (let k = 0; k < 24; k++) {
      const p = slotInto(k, _slot);
      const on = k < n;
      o.position.set(x + p.x, TY + 0.0008, z + p.z);
      o.scale.set(on ? PKG : 0, 0.0015, on ? PKG : 0);
      o.updateMatrix();
      ref.current?.setMatrixAt(k, o.matrix);
      o.position.y = TY + 0.0028;
      o.scale.set(on ? PKG * 0.8 : 0, 0.0025, on ? PKG * 0.8 : 0);
      o.updateMatrix();
      top.current?.setMatrixAt(k, o.matrix);
    }
    if (ref.current) ref.current.instanceMatrix.needsUpdate = true;
    if (top.current) top.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <>
      <instancedMesh ref={ref} args={[GEO.box, pkgSub, 24]} />
      <instancedMesh ref={top} args={[GEO.box, pkgMat, 24]} />
    </>
  );
}

/* ---------------------------------------------------------------- the handler */

function binOfFollowed() {
  const d = engine.followedDie;
  return engine.binOf(d.fmax, d.die.id);
}

/** Position of the device being handled (test variant: the followed chip). Returns a shared vector. */
function chipPath(bin: boolean): THREE.Vector3 {
  const v = engine.player.view;
  const p = _cp;
  if (!bin) {
    const ld = smooth(pp('load'));
    const rs = smooth(pp('result'));
    p.copy(INPUT).lerp(SOCKET, ld);
    p.y += Math.sin(Math.PI * ld) * 0.1;
    const b = binOfFollowed();
    const dest = _a.set(BIN_X[b], TY, BIN_Z).add(slotInto(5, _slot));
    if (rs > 0) {
      p.lerp(dest, rs);
      p.y += Math.sin(Math.PI * rs) * 0.1;
    }
    return p;
  }
  // binning: one device cycle per 1/24 of the sort phase
  if (v.phaseId !== 'sort') return p.copy(SOCKET);
  const x = v.phaseT * 24;
  const k = Math.floor(x);
  const u = fract(x);
  const f = 3.3 + 1.3 * hash1(k * 17 + 3);
  const b = f >= BINS.A ? 'A' : f >= BINS.B ? 'B' : f >= BINS.C ? 'C' : 'REJECT';
  const from = _a.copy(INPUT).add(slotInto(23 - (k % 24), _slot));
  const to = _b.set(BIN_X[b], TY, BIN_Z);
  if (u < 0.35) p.copy(from).lerp(SOCKET, smooth(u / 0.35));
  else if (u < 0.6) p.copy(SOCKET);
  else p.copy(SOCKET).lerp(to, smooth((u - 0.6) / 0.4));
  p.y += u < 0.35 ? Math.sin((Math.PI * u) / 0.35) * 0.08 : u > 0.6 ? Math.sin((Math.PI * (u - 0.6)) / 0.4) * 0.08 : 0;
  return p;
}

function Handler({ bin }: { bin: boolean }) {
  const chip = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const gantry = useRef<THREE.Group>(null);
  const thermal = useRef<THREE.Group>(null);
  useFrame(() => {
    const p = chipPath(bin);
    if (chip.current) chip.current.position.copy(p);
    if (gantry.current) gantry.current.position.x = p.x;
    if (head.current) head.current.position.set(0, p.y + 0.012, p.z);
    track('focus', p.x, p.y, p.z);
    // thermal head presses on the chip during soak + test
    const pressing = !bin ? inPhase('soak') || inPhase('test') : inPhase('sort') && fract(engine.player.view.phaseT * 24) > 0.35 && fract(engine.player.view.phaseT * 24) < 0.6;
    if (thermal.current) thermal.current.position.y = pressing ? TY + 0.012 : TY + 0.1;
    const T = !bin ? engine.tele.value('socket', 25) : 85;
    heatMat.emissiveIntensity = clamp((T - 40) / 60) * 0.25;
  });
  const inputCount = () => (bin ? 24 - (inPhase('sort') ? engine.player.view.phaseT * 24 : pp('sort') * 24) : 23 + (pp('load') > 0 ? 0 : 1));
  const view = useUI((st) => st.view);
  const station = useStation({
    body: buildHandlerBody,
    input: (k) => jedecTray(k, INPUT.x, INPUT.z, inputMat),
    bins: (k) => Object.entries(BIN_X).forEach(([b, x]) => jedecTray(k, x, BIN_Z, binMats[b])),
    socket: buildSocket,
    ate: buildATE,
    _stand: buildScreenStand,
  });
  const gantryKit = useKit(buildGantry);
  const headKit = useKit(buildPnpHead);
  const thermalKit = useKit(buildThermalHead);
  return (
    <group>
      <StationView m={station} view={view} />
      <Clickable sel={{ kind: 'machine', id: 'test-handler', label: 'Test handler' }}>
        <PickProxy m={station} tag="body" />
        <SignalTower position={[1.05, 1.05, 0.5]} />
      </Clickable>
      {/* trays */}
      <Clickable sel={{ kind: 'component', id: 'pnp', machine: 'test-handler', label: 'Input tray (JEDEC)' }}>
        <PickProxy m={station} tag="input" />
      </Clickable>
      <TechLabel position={[INPUT.x - 0.06, TY + 0.044, INPUT.z - 0.18]} title="INPUT" min={1} />
      <TrayChips x={INPUT.x} z={INPUT.z} count={inputCount} />
      <Clickable sel={{ kind: 'component', id: 'bins', machine: 'test-handler', label: 'Output bins' }}>
        <PickProxy m={station} tag="bins" />
      </Clickable>
      {Object.entries(BIN_X).map(([b, x]) => (
        <TechLabel key={b} position={[x - 0.06, TY + 0.044, BIN_Z - 0.18]} title={`BIN ${b}`} min={1} />
      ))}
      {(['A', 'B', 'C', 'REJECT'] as const).map((b) => (
        <TrayChips
          key={b}
          x={BIN_X[b]}
          z={BIN_Z}
          count={() => {
            if (!bin) return pp('result') >= 0.99 && binOfFollowed() === b ? 6 : b === 'A' ? 4 : b === 'B' ? 5 : b === 'C' ? 2 : 1;
            const n = engine.tele.value(b === 'REJECT' ? 'rej' : `bin${b}`, 0);
            return n / 5;
          }}
        />
      ))}
      {/* socket + thermal head */}
      <Clickable sel={{ kind: 'component', id: 'sockets', machine: 'test-handler', label: 'Test socket' }}>
        <PickProxy m={station} tag="socket" />
      </Clickable>
      <group ref={thermal} position={[SOCKET.x, TY + 0.1, SOCKET.z]}>
        <Clickable sel={{ kind: 'component', id: 'thermal', machine: 'test-handler', label: 'Thermal head' }}>
          <Baked parts={thermalKit} />
        </Clickable>
      </group>
      {/* pick-and-place gantry */}
      <group ref={gantry}>
        <Baked parts={gantryKit} />
        <group ref={head}>
          <Clickable sel={{ kind: 'component', id: 'pnp', machine: 'test-handler', label: 'Pick-and-place head' }}>
            <Baked parts={headKit} />
          </Clickable>
        </group>
      </group>
      <group ref={chip}>
        <Clickable sel={{ kind: 'component', id: 'pkg-die', label: 'Packaged chip CH-184-0412' }}>
          <Package />
        </Clickable>
      </group>
      {/* ATE */}
      <Clickable sel={{ kind: 'component', id: 'ate', machine: 'test-handler', label: 'Automatic test equipment' }}>
        <PickProxy m={station} tag="ate" />
      </Clickable>
    </group>
  );
}

/* ---------------------------------------------------------------- tester screen */

function TesterScreen({ bin }: { bin: boolean }) {
  const f0 = 2.0;
  const f1 = 5.0;
  const v0 = 0.7;
  const v1 = 1.2;
  return (
    <group position={[0.15, 0, -0.5]}>
      <Screen
        size={[0.9, 0.5]}
        position={[0, 1.78, 0]}
        hz={6}
        res={768}
        draw={(g, w, h) => {
          if (bin) {
            clear(g, w, h, 'BINNING · SIMULATED SPEED BINS');
            const rows: [string, string, string][] = [
              ['A', 'binA', `≥ ${BINS.A} GHz`],
              ['B', 'binB', `≥ ${BINS.B} GHz`],
              ['C', 'binC', `≥ ${BINS.C} GHz`],
              ['REJECT', 'rej', 'fail / slow'],
            ];
            const counts = rows.map(([, ch]) => engine.tele.value(ch, 0));
            const max = Math.max(10, ...counts);
            rows.forEach(([b, , note], i) => {
              const y = h * (0.22 + i * 0.17);
              g.fillStyle = SCR.dim;
              g.font = `${Math.round(h * 0.06)}px monospace`;
              g.fillText(`BIN ${b}`, w * 0.04, y + h * 0.07);
              g.fillStyle = BIN_COLOR[b];
              g.fillRect(w * 0.25, y, (w * 0.5 * counts[i]) / max, h * 0.1);
              g.fillStyle = SCR.text;
              g.fillText(`${counts[i].toFixed(0)}  ${note}`, w * 0.27 + (w * 0.5 * counts[i]) / max, y + h * 0.07);
            });
            return;
          }
          clear(g, w, h, 'ATE · SHMOO (VDD × FREQUENCY) · SIMULATED');
          const fmax = engine.followedDie.fmax;
          const k = inPhase('test') ? engine.player.view.phaseT : pp('test');
          const nx = 24;
          const ny = 12;
          const x0 = w * 0.08;
          const y0 = h * 0.2;
          const cw = (w * 0.56) / nx;
          const ch = (h * 0.66) / ny;
          const done = Math.floor(k * nx * ny);
          for (let j = 0; j < ny; j++)
            for (let i = 0; i < nx; i++) {
              const idx = j * nx + i;
              if (idx >= done) continue;
              const f = f0 + ((i + 0.5) / nx) * (f1 - f0);
              const vv = v1 - ((j + 0.5) / ny) * (v1 - v0);
              const limit = fmax * (0.72 + 0.28 * ((vv - v0) / (v1 - v0)) ** 0.7);
              g.fillStyle = f <= limit ? '#4f9a5a' : '#5a2a26';
              g.fillRect(x0 + i * cw, y0 + j * ch, cw - 1, ch - 1);
            }
          g.fillStyle = SCR.dim;
          g.font = `${Math.round(h * 0.045)}px monospace`;
          g.fillText(`${f0} GHz`, x0, y0 + ny * ch + h * 0.06);
          g.fillText(`${f1} GHz`, x0 + nx * cw - h * 0.12, y0 + ny * ch + h * 0.06);
          g.fillText(`${v1} V`, w * 0.01, y0 + h * 0.03);
          g.fillText(`${v0} V`, w * 0.01, y0 + ny * ch);
          bigNumber(g, 'FMAX', engine.tele.value('fmax', 0).toFixed(2), 'GHz', w * 0.68, h * 0.28, h * 0.1);
          bigNumber(g, 'POWER', engine.tele.value('power', 0).toFixed(0), 'W', w * 0.68, h * 0.5, h * 0.1);
          const res = pp('result') > 0 ? `BIN ${binOfFollowed()}` : '…';
          bigNumber(g, 'RESULT', res, '', w * 0.68, h * 0.72, h * 0.1, pp('result') > 0 ? SCR.good : SCR.text);
        }}
      />
    </group>
  );
}

export default function FinalTestScene({ stage }: SceneProps) {
  const bin = stage.variant === 'bin';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.3;
  }, []);
  return (
    <>
      <Lighting env="assembly" shadowExtent={5} />
      <AssemblyFloor width={12} depth={9} />
      <Handler bin={bin} />
      <TesterScreen bin={bin} />
      <SensorIndicator id="thermocouple" channel={bin ? undefined : 'socket'} machine="test-handler" position={[0.08, TY + 0.12, -0.12]} size={0.02} />
      <TechLabel
        position={[-0.8, 1.6, 0.4]}
        title={bin ? 'BINNING' : 'FINAL TEST'}
        lines={[bin ? 'speed bins from simulated test results' : 'pick → socket → soak 85 °C → test → bin']}
        min={1}
        value={() => engine.player.view.phase.label}
      />
      <Operator position={[-0.9, 0, 1.6]} rotation={Math.PI * 0.85} still />
    </>
  );
}

