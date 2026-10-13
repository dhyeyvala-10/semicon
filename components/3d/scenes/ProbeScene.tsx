'use client';
/**
 * Electrical wafer test & sort (§42, §43).
 *   test: the prober steps the wafer die by die under the probe card; needles touch the pads,
 *         the tester applies power and patterns, and the die is marked pass / fail / review.
 *   sort: the wafer map is classified — accepted dies rise, rejected dies drop — and the
 *         wafer yield is summarised. Results are SIMULATED (engine wafer map).
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import type { ViewMode } from '@/types';
import { Lighting, AssemblyFloor } from '../environments';
import { M, shell, effectiveView } from '../materials';
import { B, GEO } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Inset } from '../parts/section';
import { waferGeometry } from '../parts/wafer';
import { Screen, clear, bigNumber, plot, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { drawWafer } from '../textures';
import { engine } from '@/simulation/engine';
import { pp, inPhase } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { clamp, smooth, lerp, fract } from '@/lib/math';
import { DIE_W, DIE_H, WAFER_D } from '@/simulation/models';
import { Kit, cabinet, boltCircle, grille, estop, ledStrip, foot, windowPane, type BakedPart, type PartOpts, type V3 } from '../kit/build';
import { KM } from '../kit/finish';
import { useKit } from '../kit/Baked';
import { casterGeometry, shadowOnly } from '../kit/shadow';

const WY = 1.0;
const RESULT_COLOR = { PASS: '#4f9a5a', FAIL: '#c4483b', REVIEW: '#d1a23a' } as const;

/** die index under the probe card and progress within that die (0..1) */
function probeState() {
  const v = engine.player.view;
  const n = engine.waferMap.length;
  if (v.phaseId !== 'test') return { i: v.phaseId === 'report' ? n - 1 : 0, u: 0, tested: v.phaseId === 'report' ? n : 0 };
  const x = v.phaseT * n;
  return { i: Math.min(n - 1, Math.floor(x)), u: fract(x), tested: Math.floor(x) };
}

/* ---------------------------------------------------------------- wafer + map texture */

function useMapTexture(sort: boolean) {
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
    let last = -1;
    const s = S / WAFER_D;
    const update = (tested: number) => {
      const k = sort ? engine.waferMap.length : tested;
      if (k === last) return;
      last = k;
      g.drawImage(base, 0, 0);
      for (let i = 0; i < k; i++) {
        const d = engine.waferMap[i];
        g.fillStyle = RESULT_COLOR[d.result];
        g.globalAlpha = 0.75;
        g.fillRect(S / 2 + (d.die.cx - DIE_W / 2) * s + 1.5, S / 2 + (d.die.cy - DIE_H / 2) * s + 1.5, DIE_W * s - 3, DIE_H * s - 3);
        g.globalAlpha = 1;
      }
      tex.needsUpdate = true;
    };
    update(0);
    return { tex, update };
  }, [sort]);
}

/* ---------------------------------------------------------------- static model (kit) */

const Z0: V3 = [0, 0, 0];
const HP = Math.PI / 2;
/** test head pose when swung open for sorting (see Prober useFrame) */
const OPEN = { pos: [-0.75, 0.25, -0.55] as V3, rz: 0.5 };
/** head plate: the probe card sits in its insert ring, the test head docks on top */
const PLATE = { y0: 1.035, y1: 1.065, hole: 0.34 };
/** ATE mainframe footprint centre */
const ATE: V3 = [-1.55, 0, 0.45];
const MANIP: V3 = [-0.75, 0, -1.15];

/** A point given in test-head coordinates, in the world (docked, or swung open for sort). */
function headPoint(p: V3, sort: boolean): V3 {
  if (!sort) return p;
  const c = Math.cos(OPEN.rz);
  const s = Math.sin(OPEN.rz);
  return [p[0] * c - p[1] * s + OPEN.pos[0], p[0] * s + p[1] * c + OPEN.pos[1], p[2] + OPEN.pos[2]];
}

function crisp(k: Kit, m: THREE.Material, p: [number, number][], pos: V3 = Z0, rot: V3 = Z0, seg = 40, o: PartOpts = {}) {
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i];
    const b = p[i + 1];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6) k.lathe(m, [a, b], pos, rot, seg, o);
  }
}

/** Prober: body, stage chamber (shell), head plate with insert ring, loader with a cassette. */
function buildProber(k: Kit) {
  const o = { shell: true };
  cabinet(k, { size: [1.3, 0.9, 1.2], panels: 2, rows: [0.32], sidePanels: 2, handles: true });
  const zf = 0.6015;
  k.label('model', 'PR-12', 'WAFER PROBER · 300 mm', 0.34, 0.085, [-0.36, 0.64, zf]);
  ledStrip(k, 0.24, [0.27, 0.76, zf]);
  estop(k, [0.36, 0.64, 0.6]);
  k.label('warn', 'PINCH POINT', '', 0.06, 0.06, [0.2, 0.64, zf]);
  // stage chamber between the body and the head plate: platen, walls, front window, loader slot
  const ya = 0.922;
  const yb = PLATE.y0;
  const ym = (ya + yb) / 2;
  k.box(KM.paintDark, [1.24, 0.003, 1.14], [0, ya + 0.0015, 0], Z0, { cast: false });
  for (let i = -5; i <= 5; i++) {
    k.box(KM.seam, [1.2, 0.001, 0.0025], [0, ya + 0.0032, i * 0.1], Z0, { cast: false });
    k.box(KM.seam, [0.0025, 0.001, 1.1], [i * 0.11, ya + 0.0032, 0], Z0, { cast: false });
  }
  k.box(KM.paint, [1.3, yb - ya, 0.012], [0, ym, -0.594], Z0, o);
  k.box(KM.paint, [0.012, yb - ya, 1.2], [-0.644, ym, 0], Z0, o);
  for (const z of [-0.41, 0.41]) k.box(KM.paint, [0.012, yb - ya, 0.38], [0.644, ym, z], Z0, o);
  for (const z of [-0.22, 0.22]) k.box(KM.anodizedDark, [0.04, yb - ya, 0.012], [0.644, ym, z], Z0, o);
  k.box(KM.glass, [1.22, yb - ya - 0.02, 0.006], [0, ym, 0.597], Z0, { ...o, cast: false });
  for (const y of [ya + 0.006, yb - 0.006]) k.box(KM.anodizedDark, [1.3, 0.012, 0.02], [0, y, 0.594], Z0, o);
  for (const x of [-0.635, 0.635]) k.box(KM.anodizedDark, [0.03, yb - ya, 0.03], [x, ym, 0.585], Z0, o);
  // head plate around a square opening, insert ring on four spokes, docking receptacles
  const { hole } = PLATE;
  const yp = (PLATE.y0 + PLATE.y1) / 2;
  const tp = PLATE.y1 - PLATE.y0;
  const W = KM.anodized;
  k.rbox(W, [1.3, tp, 0.6 - hole], 0.006, [0, yp, -(0.6 + hole) / 2], Z0, o);
  k.rbox(W, [1.3, tp, 0.6 - hole], 0.006, [0, yp, (0.6 + hole) / 2], Z0, o);
  k.rbox(W, [0.65 - hole, tp, hole * 2], 0.006, [-(0.65 + hole) / 2, yp, 0], Z0, o);
  k.rbox(W, [0.65 - hole, tp, hole * 2], 0.006, [(0.65 + hole) / 2, yp, 0], Z0, o);
  crisp(k, KM.anodizedDark, [[0.215, PLATE.y0 + 0.002], [0.255, PLATE.y0 + 0.002], [0.255, PLATE.y1 - 0.002], [0.215, PLATE.y1 - 0.002], [0.215, PLATE.y0 + 0.002]], Z0, Z0, 64, o);
  boltCircle(k, 0.236, 12, PLATE.y1 - 0.001, 0.005, KM.stainlessDark, o);
  for (let i = 0; i < 12; i++) k.cyl(KM.stainlessDark, 0.005, 0.004, [-0.6 + i * 0.109, PLATE.y1 + 0.001, 0.575], Z0, 6, { ...o, cast: false });
  k.box(KM.seam, [1.28, 0.002, 0.002], [0, yp, 0.6005], Z0, { ...o, cast: false });
  for (const a of [0, HP, Math.PI, -HP]) k.box(KM.anodizedDark, [0.1, 0.022, 0.04], [Math.cos(a) * 0.2975, yp, Math.sin(a) * 0.2975], [0, -a, 0], o);
  for (const x of [-0.53, 0.53])
    for (const z of [-0.46, 0.46]) {
      k.cyl(KM.stainless, 0.028, 0.012, [x, PLATE.y1 + 0.006, z], Z0, 20, o);
      k.cyl(KM.chrome, 0.009, 0.03, [x, PLATE.y1 + 0.02, z], Z0, 12, o);
    }
  // loader on the right: base, glazed transfer housing, open cassette with wafers on the roof
  k.at([0.825, 0, 0], 0, () => {
    cabinet(k, { size: [0.35, 0.9, 0.6], panels: 1, rows: [0.32], sidePanels: 1, ao: false, stripe: false });
    const y1 = 1.24;
    k.box(KM.paint, [0.35, y1 - ya, 0.012], [0, (ya + y1) / 2, -0.294], Z0, o);
    k.box(KM.paint, [0.012, y1 - ya, 0.6], [0.169, (ya + y1) / 2, 0], Z0, o);
    k.rbox(KM.paint, [0.36, 0.02, 0.61], 0.006, [0, y1 + 0.01, 0], Z0, o);
    windowPane(k, 0.28, 0.26, [0, (ya + y1) / 2, 0.29], { ...o, frame: KM.anodizedDark });
    for (const s of [-1, 1]) {
      k.box(KM.ptfe, [0.012, 0.26, 0.3], [s * 0.16, y1 + 0.15, 0], Z0);
      for (let i = 0; i < 12; i++) k.box(KM.ptfe, [0.012, 0.004, 0.27], [s * 0.148, y1 + 0.04 + i * 0.019, 0], Z0, { cast: false });
    }
    k.box(KM.ptfe, [0.32, 0.03, 0.02], [0, y1 + 0.035, -0.14], Z0);
    k.box(KM.ptfe, [0.32, 0.02, 0.02], [0, y1 + 0.27, -0.14], Z0);
    for (let i = 0; i < 5; i++) k.cyl(KM.paintGrey, 0.148, 0.0008, [0, y1 + 0.06 + i * 0.038, 0.01], Z0, 48, { cast: false });
    k.label('tag', 'CST-A', 'LOT 0184 · 25 SLOTS', 0.12, 0.03, [0, 1.12, 0.302]);
  });
}

/** Manipulator column, counterweight and arm to the test-head hub (docked or swung open). */
function buildManipulator(k: Kit, sort: boolean) {
  const [cx, , cz] = MANIP;
  const hub = headPoint([0, 1.22, -0.475], sort);
  k.rbox(KM.paintGrey, [0.5, 0.04, 0.5], 0.01, [cx, 0.02, cz]);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.cyl(KM.stainlessDark, 0.012, 0.02, [cx + x * 0.2, 0.05, cz + z * 0.2], Z0, 6);
  k.rbox(KM.paintGrey, [0.16, 1.76, 0.16], 0.012, [cx, 0.92, cz]);
  k.box(KM.chrome, [0.03, 1.5, 0.006], [cx, 0.95, cz + 0.083], Z0, { cast: false });
  k.rbox(KM.paintGraphite, [0.18, 0.03, 0.18], 0.008, [cx, 1.815, cz]);
  // carriage at the hub height, counterweight on the far side
  k.rbox(KM.paint, [0.24, 0.24, 0.24], 0.012, [cx, hub[1], cz]);
  const dx = hub[0] - cx;
  const dz = hub[2] - cz;
  const L = Math.hypot(dx, dz);
  const yaw = Math.atan2(dx, dz);
  k.at([cx, hub[1], cz], [0, yaw, 0], () => {
    k.rbox(KM.paint, [0.11, 0.11, L - 0.12], 0.01, [0, 0, (L - 0.12) / 2 + 0.06]);
    k.rbox(KM.paintGraphite, [0.2, 0.2, 0.16], 0.012, [0, 0, -0.2]);
    k.cyl(KM.anodized, 0.065, 0.05, [0, 0, L - 0.04], [HP, 0, 0], 28);
    k.cyl(KM.anodizedDark, 0.07, 0.012, [0.0, 0.0, 0.14], [HP, 0, 0], 28);
  });
  k.at([cx + 0.121, hub[1], cz], [0, 0, -HP], () => {
    k.cyl(KM.anodizedDark, 0.012, 0.04, [0, 0.02, 0], Z0, 12);
    k.torus(KM.chrome, 0.05, 0.006, [0, 0.045, 0], Z0, 28);
  });
  k.ao(0.5, 0.5, [cx, 0, cz], 1.4);
}

/** ATE mainframe and the cable bundle up and over to the test head. */
function buildAte(k: Kit, sort: boolean) {
  k.at(ATE, 0, () => {
    cabinet(k, { size: [0.8, 1.9, 0.9], body: KM.paintDark, trim: KM.paintGraphite, panels: 2, rows: [0.55, 1.35], sidePanels: 1, handles: true });
    for (const x of [-0.2, 0.2]) grille(k, 0.28, 0.5, [x, 0.95, 0.4515], { m: KM.anodizedDark });
    k.label('model', 'ATE-9', 'TEST SYSTEM · 1024 PINS', 0.32, 0.08, [0, 1.62, 0.4515]);
    k.label('warn', 'HIGH VOLTAGE', '', 0.07, 0.07, [0.28, 1.45, 0.4515]);
    ledStrip(k, 0.3, [0, 1.5, 0.4515]);
    estop(k, [-0.28, 1.45, 0.45]);
    k.at([0.4, 0, 0], HP, () => grille(k, 0.5, 0.3, [0.1, 1.5, 0.002], { m: KM.anodizedDark }));
    // cable exit hood on the roof
    k.rbox(KM.paintGraphite, [0.36, 0.1, 0.26], 0.012, [0.1, 1.97, -0.3]);
    k.cyl(KM.anodized, 0.075, 0.03, [0.1, 2.03, -0.3], Z0, 28);
  });
  const a = headPoint([-0.3, 1.44, -0.15], sort);
  const e: V3 = [ATE[0] + 0.1, 2.04, ATE[2] - 0.3];
  const mid: V3[] = sort
    ? [[e[0] - 0.02, 2.14, e[2] - 0.1], [-1.62, 1.95, -0.4], [a[0], a[1] + 0.12, a[2]]]
    : [[e[0] + 0.1, 2.16, e[2] - 0.1], [-0.85, 2.0, -0.05], [-0.42, 1.68, -0.13], [a[0], a[1] + 0.1, a[2]]];
  for (const [i, [ox, oz, r]] of [[0, 0, 0.035], [0.05, 0.04, 0.02], [-0.045, 0.035, 0.016]].entries()) {
    const pts: V3[] = [e, ...mid, a].map((p, j, arr) => (j === 0 || j === arr.length - 1 ? [p[0] + ox * 0.4, p[1], p[2] + oz * 0.4] : [p[0] + ox, p[1], p[2] + oz]));
    k.tube(i === 0 ? KM.plastic : KM.paintGraphite, pts, r, { radial: 10, tension: 0.4 });
  }
}

/** Floor stand for the yield monitor (local to the screen group). */
function buildMonitorStand(k: Kit) {
  k.rbox(KM.paintGraphite, [0.46, 0.035, 0.38], 0.012, [0, 0.0175, -0.04]);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) foot(k, [x * 0.19, 0, -0.04 + z * 0.15]);
  k.rbox(KM.anodized, [0.075, 1.47, 0.055], 0.012, [0, 0.77, -0.07]);
  k.box(KM.seam, [0.006, 1.36, 0.002], [0, 0.77, -0.042], Z0, { cast: false });
  k.rbox(KM.anodizedDark, [0.12, 0.12, 0.04], 0.01, [0, 1.52, -0.04]);
  k.rbox(KM.plastic, [0.72, 0.5, 0.03], 0.012, [0, 1.52, -0.008]);
  k.ao(0.46, 0.38, [0, 0, -0.04]);
}

/** A neighbouring prober cell: body, head plate, docked test head, manipulator. */
function buildNeighbour(k: Kit) {
  cabinet(k, { size: [1.3, 0.9, 1.2], panels: 2, rows: [0.32], sidePanels: 2, handles: true });
  k.rbox(KM.anodized, [1.3, 0.03, 1.2], 0.006, [0, 1.05, 0]);
  k.box(KM.paintDark, [1.26, 0.113, 1.16], [0, 0.9785, 0]);
  k.box(KM.glass, [1.24, 0.09, 0.006], [0, 0.9785, 0.583], Z0, { cast: false });
  k.rbox(M.orangeAccent, [0.92, 0.025, 0.82], 0.008, [0, 1.0825, 0]);
  k.rbox(KM.paintGraphite, [0.9, 0.285, 0.8], 0.02, [0, 1.2375, 0]);
  for (const s of [-1, 1]) k.at([s * 0.45, 0, 0], s * HP, () => grille(k, 0.5, 0.16, [0, 1.24, 0.002], { m: KM.anodizedDark }));
  ledStrip(k, 0.2, [0.2, 1.33, 0.401]);
  k.rbox(KM.paintGrey, [0.16, 1.76, 0.16], 0.012, [-0.75, 0.88, -1.0]);
  k.rbox(KM.paint, [0.11, 0.11, 0.7], 0.01, [-0.4, 1.22, -0.72], [0, 0.85, 0]);
  k.rbox(KM.paintGrey, [0.5, 0.04, 0.5], 0.01, [-0.75, 0.02, -1.0]);
  k.cyl(KM.anodized, 0.07, 0.03, [-0.3, 1.395, -0.15], Z0, 24);
}

/** Thermal chuck on its planar-motor forcer (local to the chuck group). */
function buildChuck(k: Kit) {
  k.rbox(KM.anodizedDark, [0.3, 0.02, 0.3], 0.006, [0, -0.02, 0]);
  k.cyl(KM.anodized, 0.165, 0.03, [0, 0.005, 0], Z0, 64);
  for (const y of [-0.002, 0.012]) k.torus(KM.anodizedDark, 0.1655, 0.0025, [0, y, 0], Z0, 64, { cast: false });
  k.cyl(KM.brass, 0.155, 0.0146, [0, 0.0273, 0], Z0, 64);
  for (const r of [0.05, 0.09, 0.13]) k.torus(KM.seam, r, 0.0006, [0, 0.0343, 0], Z0, 48, { cast: false });
  for (const a of [2.4, 2.7]) {
    k.cyl(KM.stainless, 0.008, 0.03, [Math.cos(a) * 0.178, 0.004, Math.sin(a) * 0.178], [0, 0, HP], 10, { cast: false });
    k.cyl(KM.stainlessDark, 0.011, 0.012, [Math.cos(a) * 0.168, 0.004, Math.sin(a) * 0.168], [0, 0, HP], 6, { cast: false });
  }
  k.rbox(KM.plastic, [0.04, 0.018, 0.03], 0.004, [0.17, -0.004, 0.06]);
}

const needleMat = new THREE.MeshStandardMaterial({ color: '#d6c27a', roughness: 0.3, metalness: 1 });

/** Test head with the probe card and needles (local to the head group, docked = world). */
function buildHead(k: Kit) {
  // probe card: PCB, stiffener, edge contacts, space transformer, ceramic probe head, needles
  k.cyl(M.pcb, 0.2, 0.012, [0, WY + 0.045, 0], Z0, 64);
  crisp(k, KM.anodized, [[0.12, WY + 0.051], [0.185, WY + 0.051], [0.185, WY + 0.059], [0.12, WY + 0.059], [0.12, WY + 0.051]], Z0, Z0, 48);
  boltCircle(k, 0.152, 8, WY + 0.0595, 0.004);
  k.torus(KM.brass, 0.194, 0.0018, [0, WY + 0.0385, 0], Z0, 64, { cast: false });
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.3;
    k.box(i % 3 ? KM.plastic : KM.brass, [0.012, 0.003, 0.008], [Math.cos(a) * 0.09, WY + 0.0375, Math.sin(a) * 0.09], [0, -a, 0], { cast: false });
  }
  k.rbox(M.ceramic, [0.09, 0.008, 0.09], 0.002, [0, WY + 0.0355, 0]);
  k.cyl(M.ceramic, 0.03, 0.02, [0, WY + 0.032, 0], Z0, 32);
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    k.cyl(needleMat, 0.0003, 0.03, [Math.cos(a) * 0.016, WY + 0.018, Math.sin(a) * 0.016], [Math.sin(a) * 0.9, 0, -Math.cos(a) * 0.9], 4, { top: 2, cast: false });
  }
  // pogo tower into the head, docking band with cams
  k.cyl(KM.anodizedDark, 0.16, 0.019, [0, WY + 0.0605, 0], Z0, 48);
  k.rbox(M.orangeAccent, [0.92, 0.025, 0.82], 0.008, [0, WY + 0.0825, 0]);
  for (const x of [-0.43, 0.43]) for (const z of [-0.38, 0.38]) k.rbox(KM.anodized, [0.06, 0.035, 0.06], 0.006, [x, WY + 0.0825, z]);
  // head body: panels, seams, fan grilles, handles, plate, status strip
  const yb = WY + 0.095;
  const yt = WY + 0.38;
  k.rbox(KM.paintGraphite, [0.9, yt - yb, 0.8], 0.02, [0, (yb + yt) / 2, 0]);
  k.box(KM.seam, [0.004, yt - yb - 0.03, 0.002], [0, (yb + yt) / 2, 0.4012], Z0, { cast: false });
  k.box(KM.seam, [0.88, 0.002, 0.004], [0, yt + 0.0012, 0.0], Z0, { cast: false });
  for (const s of [-1, 1]) k.at([s * 0.45, 0, 0], s * HP, () => grille(k, 0.56, 0.17, [0, (yb + yt) / 2, 0.002], { m: KM.anodizedDark }));
  for (const x of [-0.39, 0.39]) {
    k.rbox(KM.anodized, [0.022, 0.2, 0.022], 0.006, [x, (yb + yt) / 2, 0.44]);
    for (const dy of [-0.08, 0.08]) k.box(KM.anodized, [0.016, 0.016, 0.04], [x, (yb + yt) / 2 + dy, 0.42]);
  }
  k.label('model', 'TH-64', 'TEST HEAD · 1024 CH', 0.3, 0.075, [-0.15, WY + 0.28, 0.4015]);
  ledStrip(k, 0.18, [0.2, WY + 0.32, 0.4015]);
  for (const [x, z] of [[-0.42, -0.37], [0.42, -0.37], [-0.42, 0.37], [0.42, 0.37]]) k.cyl(KM.stainlessDark, 0.007, 0.004, [x, yt + 0.002, z], Z0, 8, { cast: false });
  // cable and coolant entries on the roof, cradle and hub on the back
  k.cyl(KM.anodized, 0.07, 0.04, [-0.3, yt + 0.02, -0.15], Z0, 28);
  k.cyl(KM.anodizedDark, 0.05, 0.02, [-0.3, yt + 0.05, -0.15], Z0, 24);
  for (const x of [-0.08, -0.02]) k.cyl(KM.stainless, 0.012, 0.03, [x, yt + 0.015, -0.28], Z0, 12);
  for (const x of [0.15, 0.32]) {
    k.cyl(KM.stainlessDark, 0.012, 0.02, [x, yt + 0.01, 0.1], Z0, 12);
    k.torus(KM.stainless, 0.022, 0.005, [x, yt + 0.042, 0.1], [HP, 0, 0], 20);
  }
  k.rbox(KM.paintGrey, [0.5, 0.2, 0.03], 0.008, [0, WY + 0.22, -0.415]);
  k.cyl(KM.anodized, 0.06, 0.03, [0, WY + 0.22, -0.445], [HP, 0, 0], 28);
  // alignment camera with ring light, hanging into the plate opening
  k.cyl(KM.anodizedDark, 0.022, 0.06, [0.3, WY + 0.05, 0.25], Z0, 24);
  k.cyl(KM.glassSmoke, 0.016, 0.003, [0.3, WY + 0.0195, 0.25], Z0, 20, { cast: false });
  k.torus(KM.ledWhite, 0.025, 0.003, [0.3, WY + 0.022, 0.25], Z0, 24, { cast: false });
  k.rbox(KM.anodizedDark, [0.05, 0.02, 0.05], 0.004, [0.3, WY + 0.085, 0.25]);
}

const noRay = () => {};
const PICK = new THREE.MeshBasicMaterial();

/** Static kit meshes (shell parts follow the view), not raycast, one shadow caster. */
function Static({ parts, view = 'normal' }: { parts: BakedPart[]; view?: ViewMode }) {
  const caster = useMemo(() => {
    const g = casterGeometry(parts.filter((p) => p.cast).map((p) => p.geometry));
    return g ? shadowOnly(g) : null;
  }, [parts]);
  useEffect(() => () => caster?.geometry.dispose(), [caster]);
  return (
    <>
      {parts.map((p, i) => (
        <mesh key={i} geometry={p.geometry} material={p.shell ? shell(p.material, view) : p.material} receiveShadow raycast={noRay} />
      ))}
      {caster && <primitive object={caster} />}
    </>
  );
}

/** Invisible pick proxy (box): never drawn, still raycast. */
function Pick({ p, s }: { p: V3; s: V3 }) {
  return <mesh geometry={GEO.box} position={p} scale={s} material={PICK} visible={false} />;
}

/* ---------------------------------------------------------------- prober */

function Prober({ sort }: { sort: boolean }) {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  const view = effectiveView(viewRaw, cam);
  const wafer = useRef<THREE.Group>(null);
  const chuck = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const map = useMapTexture(sort);
  const top = useMemo(() => new THREE.MeshStandardMaterial({ map: map.tex, roughness: 0.2, metalness: 0.4 }), [map]);
  const waferMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.1, metalness: 0.9, transparent: true }), []);
  const cell = useKit(
    (k) => {
      buildProber(k);
      buildManipulator(k, sort);
      buildAte(k, sort);
      k.at([1.25, 0, -0.45], -0.6, () => buildMonitorStand(k));
      for (const x of [-3.0, 2.9]) k.at([x, 0, -0.6], 0, () => buildNeighbour(k));
    },
    [sort],
  );
  const chuckParts = useKit(buildChuck);
  const headParts = useKit(buildHead);
  useFrame(() => {
    const st = probeState();
    map.update(st.tested);
    const dies = engine.waferMap;
    const cur = dies[st.i].die;
    const nxt = dies[Math.min(dies.length - 1, st.i + 1)].die;
    // move to the next die during the last 40 % of each die period; touchdown in between
    const mv = smooth(clamp((st.u - 0.6) / 0.4));
    const x = -lerp(cur.cx, nxt.cx, mv) / 1000;
    const z = -lerp(cur.cy, nxt.cy, mv) / 1000;
    const contact = inPhase('test') && st.u > 0.1 && st.u < 0.6;
    const loadP = sort ? 1 : smooth(pp('load'));
    const wx = inPhase('test') || pp('test') >= 1 ? x : lerp(0.6, 0, loadP);
    const wz = inPhase('test') || pp('test') >= 1 ? z : 0;
    const wy = WY - (contact ? 0 : 0.012);
    if (wafer.current) wafer.current.position.set(wx, wy, wz);
    if (chuck.current) chuck.current.position.set(wx, wy - 0.035, wz);
    track('focus', 0, WY, 0);
    if (head.current) {
      // for sorting the test head is swung open out of the way
      head.current.position.set(sort ? OPEN.pos[0] : 0, sort ? OPEN.pos[1] : 0, sort ? OPEN.pos[2] : 0);
      head.current.rotation.z = sort ? OPEN.rz : 0;
    }
    waferMat.opacity = sort ? 1 - smooth(clamp(pp('separate') * 2)) * 0.85 : 1;
    top.opacity = waferMat.opacity;
    top.transparent = sort;
  });
  return (
    <group>
      <Static parts={cell} view={view} />
      <Clickable sel={{ kind: 'machine', id: 'prober', label: 'Wafer prober' }}>
        {/* body, head plate, loader, manipulator (pick proxies; the visible model is merged above) */}
        <Pick p={[0, 0.46, 0]} s={[1.3, 0.92, 1.2]} />
        <Pick p={[0, (PLATE.y0 + PLATE.y1) / 2, -0.47]} s={[1.3, 0.04, 0.26]} />
        <Pick p={[-0.495, (PLATE.y0 + PLATE.y1) / 2, 0]} s={[0.31, 0.04, 0.68]} />
        <Pick p={[0.495, (PLATE.y0 + PLATE.y1) / 2, 0]} s={[0.31, 0.04, 0.68]} />
        {view === 'normal' && <Pick p={[0, (PLATE.y0 + PLATE.y1) / 2, 0.47]} s={[1.3, 0.04, 0.26]} />}
        <Pick p={[0.825, 0.64, 0]} s={[0.35, 1.28, 0.6]} />
        <Pick p={[MANIP[0], 0.92, MANIP[2]]} s={[0.24, 1.84, 0.24]} />
        <SignalTower position={[0.6, PLATE.y1, -0.56]} />
      </Clickable>
      <group ref={chuck}>
        <Static parts={chuckParts} />
        <Clickable sel={{ kind: 'component', id: 'chuck', machine: 'prober', label: 'Thermal chuck' }}>
          <Pick p={[0, 0.0025, 0]} s={[0.34, 0.065, 0.34]} />
        </Clickable>
      </group>
      <group ref={wafer}>
        <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184' }}>
          <mesh geometry={waferGeometry()} material={waferMat} castShadow />
          <mesh position={[0, 0.0005, 0]} rotation={[-Math.PI / 2, 0, 0]} material={top}>
            <circleGeometry args={[0.149, 64]} />
          </mesh>
        </Clickable>
      </group>
      {/* test head + probe card */}
      <group ref={head}>
        <Static parts={headParts} />
        <Clickable sel={{ kind: 'component', id: 'probe-card', machine: 'prober', label: 'Probe card' }}>
          <Pick p={[0, WY + 0.0375, 0]} s={[0.42, 0.065, 0.42]} />
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'tester', machine: 'prober', label: 'Test head' }}>
          <Pick p={[0, WY + 0.225, 0]} s={[0.92, 0.31, 0.82]} />
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'camera', machine: 'prober', label: 'Alignment cameras' }}>
          <Pick p={[0.3, WY + 0.06, 0.25]} s={[0.06, 0.09, 0.06]} />
        </Clickable>
      </group>
      {/* ATE mainframe (+ cable bundle, merged above) */}
      <Clickable sel={{ kind: 'component', id: 'tester', machine: 'prober', label: 'ATE mainframe' }}>
        <Pick p={[ATE[0], 0.95, ATE[2]]} s={[0.8, 1.9, 0.9]} />
      </Clickable>
    </group>
  );
}

/* ---------------------------------------------------------------- sort: dies rise / drop */

const tmpColor = new THREE.Color();
function SortDies() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const dies = engine.waferMap;
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.3 }), []);
  const o = useMemo(() => new THREE.Object3D(), []);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    dies.forEach((d, i) => m.setColorAt(i, tmpColor.set(RESULT_COLOR[d.result])));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [dies]);
  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    const k = pp('separate');
    m.visible = k > 0;
    dies.forEach((d, i) => {
      const stagger = clamp(k * 1.6 - (i / dies.length) * 0.6);
      const e = smooth(stagger);
      const dy = d.result === 'PASS' ? 0.09 * e : d.result === 'FAIL' ? -0.07 * e : 0.03 * e;
      o.position.set(d.die.cx / 1000, WY + 0.002 + dy, d.die.cy / 1000);
      o.scale.set((DIE_W / 1000) * 0.92, 0.0012, (DIE_H / 1000) * 0.92);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.instanceId === undefined) return;
    const d = dies[e.instanceId];
    useUI.getState().select({ kind: 'die', id: String(d.die.id), label: `Die (${d.die.col}, ${d.die.row})` });
  };
  return (
    <instancedMesh ref={ref} args={[undefined, mat, dies.length]} onClick={onClick} castShadow>
      <boxGeometry />
    </instancedMesh>
  );
}

/* ---------------------------------------------------------------- probe contact inset */

const padMat = new THREE.MeshStandardMaterial({ color: '#d9b45a', roughness: 0.3, metalness: 1 });
const dieMat = new THREE.MeshStandardMaterial({ color: '#2d3a32', roughness: 0.45, metalness: 0.3 });

function ContactInset() {
  const tips = useRef<THREE.Group>(null);
  const led = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(() => {
    const st = probeState();
    const contact = inPhase('test') && st.u > 0.1 && st.u < 0.6;
    if (tips.current) tips.current.position.y = contact ? 0 : 0.06;
    if (led.current) {
      const r = engine.waferMap[st.i].result;
      led.current.color.set(contact ? RESULT_COLOR[r] : '#3a4a3c');
    }
  });
  return (
    <Inset id="probe-contact" position={[0, 1.75, 0.6]} size={[1.3, 0.85]} mpu={1.2e-3 / 1.3} title="PROBE NEEDLES ON PADS · SCHEMATIC">
      <group rotation={[0.5, -0.2, 0]} position={[0, -0.12, 0]}>
        <B s={[1.1, 0.04, 0.5]} m={dieMat} position={[0, -0.02, 0]} />
        {Array.from({ length: 8 }, (_, i) => (
          <B key={i} s={[0.07, 0.012, 0.07]} m={padMat} position={[-0.42 + i * 0.12, 0.006, 0.12]} />
        ))}
        <group ref={tips}>
          {Array.from({ length: 8 }, (_, i) => (
            <mesh key={i} position={[-0.42 + i * 0.12, 0.2, 0.25]} rotation={[-0.9, 0, 0]} material={needleMat}>
              <cylinderGeometry args={[0.006, 0.0015, 0.42, 6]} />
            </mesh>
          ))}
        </group>
      </group>
      <mesh position={[0.52, 0.3, 0.02]}>
        <circleGeometry args={[0.035, 20]} />
        <meshBasicMaterial ref={led} color="#3a4a3c" toneMapped={false} />
      </mesh>
      <TechLabel position={[-0.62, 0.36, 0.02]} title="CONTACT → STIMULATE → MEASURE" min={2} value={() => `die ${probeState().i + 1} · Idd ${engine.tele.value('idd', 0).toFixed(0)} mA · Rc ${engine.tele.value('rc', 0).toFixed(2)} Ω · SIMULATED`} />
    </Inset>
  );
}

/* ---------------------------------------------------------------- screens */

function YieldScreen({ sort }: { sort: boolean }) {
  const counts = useMemo(() => {
    const c = { PASS: 0, FAIL: 0, REVIEW: 0 };
    for (const d of engine.waferMap) c[d.result]++;
    return c;
  }, []);
  return (
    <group position={[1.25, 0, -0.45]} rotation={[0, -0.6, 0]}>
      <Screen
        size={[0.66, 0.44]}
        position={[0, 1.52, 0.03]}
        hz={5}
        draw={(g, w, h) => {
          if (!sort) {
            clear(g, w, h, 'WAFER TEST · SIMULATED');
            const st = probeState();
            bigNumber(g, 'TESTED', String(st.tested), `/ ${engine.waferMap.length}`, w * 0.05, h * 0.2, h * 0.1);
            bigNumber(g, 'Idd', engine.tele.value('idd', 0).toFixed(0), 'mA', w * 0.5, h * 0.2, h * 0.1, engine.tele.value('idd', 0) > 200 ? SCR.crit : SCR.text);
            const c = engine.tele.get('idd');
            plot(g, c ? c.series().slice(-200) : [], w * 0.05, h * 0.5, w * 0.9, h * 0.4, 0, 300, SCR.data);
            return;
          }
          clear(g, w, h, 'WAFER SORT · YIELD · SIMULATED');
          const n = engine.waferMap.length;
          bigNumber(g, 'YIELD', ((100 * counts.PASS) / n).toFixed(1), '%', w * 0.05, h * 0.2, h * 0.12, SCR.good);
          const rows: [string, number, string][] = [
            ['GOOD', counts.PASS, RESULT_COLOR.PASS],
            ['FAIL', counts.FAIL, RESULT_COLOR.FAIL],
            ['REVIEW', counts.REVIEW, RESULT_COLOR.REVIEW],
          ];
          rows.forEach(([name, v, col], i) => {
            const y = h * (0.52 + i * 0.13);
            g.fillStyle = SCR.dim;
            g.font = `${Math.round(h * 0.06)}px monospace`;
            g.fillText(name, w * 0.05, y + h * 0.06);
            g.fillStyle = col;
            g.fillRect(w * 0.3, y, (w * 0.5 * v) / n, h * 0.08);
            g.fillStyle = SCR.text;
            g.fillText(String(v), w * 0.32 + (w * 0.5 * v) / n, y + h * 0.06);
          });
        }}
      />
    </group>
  );
}

export default function ProbeScene({ stage }: SceneProps) {
  const sort = stage.variant === 'sort';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.3;
  }, []);
  return (
    <>
      <Lighting env="assembly" shadowExtent={5} />
      <AssemblyFloor width={12} depth={9} />
      <Prober sort={sort} />
      {sort && <SortDies />}
      {!sort && <ContactInset />}
      <YieldScreen sort={sort} />
      <SensorIndicator id="probe-contact" channel={sort ? undefined : 'rc'} machine="prober" position={[0.32, WY + 0.08, 0.3]} size={0.03} />
      <TechLabel
        position={[-0.8, 1.75, 0.3]}
        title={sort ? 'WAFER SORT' : 'ELECTRICAL WAFER TEST'}
        lines={[sort ? 'good dies rise · rejects drop · review hovers' : 'every die is contacted and tested']}
        min={1}
        value={() => engine.player.view.phase.label}
      />
      <TechLabel position={[0.2, WY + 0.15, 0.25]} title="CLICK A DIE" min={2} show={() => sort && pp('separate') > 0.5} />
      <Operator position={[-0.9, 0, 1.5]} rotation={Math.PI * 0.85} still />
    </>
  );
}
