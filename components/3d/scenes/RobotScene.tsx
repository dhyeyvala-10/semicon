'use client';
/**
 * Cleanroom entry & wafer robotics (§17–§20, §55): OHT → load port → FOUP door → mapping →
 * SCARA robot pick → pre-aligner → slit valve → process chamber lift pins → return.
 * Every pose is the RobotController's simulated state.
 *
 * Static equipment is built with the detailing kit and merged into ONE station model (one mesh
 * per finish for the whole tool): EFEM with aluminium frame, framed windows, perforated deck,
 * FFU and ionizer; three SEMI E15-style load ports; OHT rail and vehicle; pre-aligner; process
 * module frame. Invisible pick proxies keep every component's Clickable. Moving parts (FOUP,
 * hoist, chuck, slit-valve gate, lift pins, robot) and the always-cut-away chamber stay apart.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, CleanroomBay } from '../environments';
import { M } from '../materials';
import { B } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { FOUP, waferGeometry, buildFoup, buildLoadPort, useModel, ModelView, ModelPick, type MergedModel } from '../parts/wafer';
import { RobotArm } from '../parts/robotArm';
import { Operator } from '../parts/people';
import { Kit, type PartOpts, type V3, cabinet, windowPane, grille, hmi, estop, ledStrip, flange, viewport, hose } from '../kit/build';
import { KM, labelMaterial } from '../kit/finish';
import { useUI } from '@/lib/store';
import { useTicker } from '@/hooks/useTicker';
import { engine } from '@/simulation/engine';
import { STATIONS, FOUP_SLOT } from '@/simulation/robot';
import { pp } from '@/lib/anim';
import { track } from '@/lib/runtime';
import { smooth, clamp } from '@/lib/math';

const Y0 = 0.85; // robot frame origin (world y)
const PORT_X = STATIONS.foup.r; // FOUP centre x (wafer centres)
const OHT_Y = 4.1;
const waferMat = new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.07, metalness: 0.92 });
const SEQ = ['HOME', 'PICK', 'VERIFY', 'ROTATE', 'TRANSFER', 'PLACE', 'VERIFY', 'RETURN'];

/** EFEM envelope: x ±0.42 (load ports on +X, process tool on −X), z ±0.8, floor deck at 0.41, FFU above 2.15. */
const EF = { hx: 0.42, hz: 0.8, deck: 0.39, top: 2.15 };

function stationWorld(id: keyof typeof STATIONS) {
  const s = STATIONS[id];
  return new THREE.Vector3(Math.cos(s.th) * s.r, Y0 + s.z, -Math.sin(s.th) * s.r);
}
const P_ALIGN = stationWorld('aligner');
const P_CHAMBER = stationWorld('chamber');
/** load-port positions along the EFEM front (z); the live port is z = 0 */
const PORTS = [-0.53, 0, 0.53];

/* ------------------------------------------------------------------ kit models */

const PLANE = new THREE.PlaneGeometry(1, 1);
/** Label plate (as Kit.label) that can follow the x-ray / cut-away shell it is stuck on. */
function plate(k: Kit, kind: Parameters<typeof labelMaterial>[0], text: string, sub: string, w: number, h: number, pos: V3, rot: V3 = [0, 0, 0], o: PartOpts = {}) {
  k.add(labelMaterial(kind, text, sub), PLANE, pos, rot, [w, h, 1], { ...o, cast: false, keepUV: true });
}
/** EMO button and LED status strip facing +Z, shell-aware versions of the kit recipes. */
function emo(k: Kit, o: PartOpts) {
  k.rbox(KM.paintYellow, [0.07, 0.07, 0.02], 0.006, [0, 0, 0.01], [0, 0, 0], o);
  k.cyl(KM.paintRed, 0.022, 0.025, [0, 0, 0.032], [Math.PI / 2, 0, 0], 20, o);
}
function statusStrip(k: Kit, w: number, o: PartOpts) {
  k.box(KM.seam, [w + 0.01, 0.014, 0.004], [0, 0, 0], [0, 0, 0], { ...o, cast: false });
  k.box(KM.ledGreen, [w, 0.008, 0.004], [0, 0, 0.002], [0, 0, 0], { ...o, cast: false });
}

/**
 * EFEM body: controller plinth with a perforated deck plate (the down-flow leaves through it),
 * extruded-aluminium frame, framed windows on the operator side and the rear, load-port wall
 * (+X) with three FIMS openings (live port at z = 0, closed port doors at z = ±0.53), the FIMS
 * door-opener housings inside, and a window above the ports onto the robot.
 * `sh`: walls follow x-ray (main tool) or not (neighbours).
 */
function buildEfem(k: Kit, sh: boolean) {
  const o = { shell: sh };
  const nc = { cast: false, ...o };
  const { hx, hz, deck, top } = EF;
  // controller plinth (robot controller, vacuum ejector, power)
  cabinet(k, { size: [2 * hx, deck, 2 * hz], panels: 2, rows: [0.21], sidePanels: 1, stripe: false, shell: sh, ao: false, bolts: false });
  // perforated deck plate with staggered slots
  const dy = deck + 0.024;
  k.box(KM.stainlessDark, [2 * hx - 0.05, 0.004, 2 * hz - 0.05], [0, dy - 0.002, 0], [0, 0, 0], o);
  for (let j = 0; j < 33; j++)
    for (let i = 0; i < 15; i++) {
      const x = -hx + 0.06 + i * 0.05 + (j % 2) * 0.025;
      const z = -hz + 0.06 + j * 0.0455;
      if (x > hx - 0.05 || Math.hypot(x, z) < 0.16 || Math.hypot(x - P_ALIGN.x, z - P_ALIGN.z) < 0.16) continue;
      k.box(KM.seam, [0.026, 0.001, 0.007], [x, dy + 0.0002, z], [0, 0, 0], nc);
    }
  // corner posts and top rails (extruded aluminium with T-slots)
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      k.rbox(KM.anodized, [0.045, top - deck, 0.045], 0.005, [sx * (hx - 0.02), (top + deck) / 2 + 0.01, sz * (hz - 0.02)]);
      k.box(KM.seam, [0.008, top - deck - 0.02, 0.002], [sx * (hx - 0.02), (top + deck) / 2 + 0.01, sz * (hz - 0.02) + sz * 0.0235], [0, 0, 0], { cast: false });
      k.box(KM.seam, [0.002, top - deck - 0.02, 0.008], [sx * (hx - 0.02) + sx * 0.0235, (top + deck) / 2 + 0.01, sz * (hz - 0.02)], [0, 0, 0], { cast: false });
    }
  for (const sz of [-1, 1]) k.rbox(KM.anodized, [2 * hx, 0.04, 0.04], 0.005, [0, top - 0.02, sz * (hz - 0.02)]);
  for (const sx of [-1, 1]) k.rbox(KM.anodized, [0.04, 0.04, 2 * hz], 0.005, [sx * (hx - 0.02), top - 0.02, 0]);
  // operator-side window (+Z) with sill, and the rear window over a service panel (−Z)
  windowPane(k, 2 * hx - 0.1, 1.58, [0, 1.3, hz - 0.012], { ...o, frame: KM.anodizedDark });
  k.rbox(KM.paint, [2 * hx - 0.06, 0.07, 0.024], 0.006, [0, deck + 0.055, hz - 0.012], [0, 0, 0], o);
  k.rbox(KM.paint, [2 * hx - 0.06, 0.6, 0.02], 0.006, [0, deck + 0.32, -hz + 0.012], [0, 0, 0], o);
  k.box(KM.seam, [2 * hx - 0.1, 0.004, 0.002], [0, deck + 0.42, -hz + 0.023], [0, 0, 0], nc);
  for (const x of [-0.25, 0.25]) for (const y of [deck + 0.08, deck + 0.56]) k.cyl(KM.stainlessDark, 0.0055, 0.004, [x, y, -hz - 0.0005], [Math.PI / 2, 0, 0], 8, nc);
  windowPane(k, 2 * hx - 0.1, 0.96, [0, 1.58, -hz + 0.012], { ...o, frame: KM.anodizedDark });
  // load-port wall (+X): lower panel, FIMS band, upper panel (solid toward −Z, window toward +Z)
  const wx = hx - 0.005;
  const y0 = 0.9;
  const y1 = 1.25;
  const wz = -0.2;
  k.rbox(KM.paint, [0.02, y0 - deck - 0.02, 2 * hz - 0.04], 0.004, [wx, (y0 + deck + 0.02) / 2, 0], [0, 0, 0], o);
  for (const z of [-0.265, 0.265]) k.box(KM.paint, [0.02, y1 - y0, 0.13], [wx, (y0 + y1) / 2, z], [0, 0, 0], o);
  for (const s of [-1, 1]) k.box(KM.paint, [0.02, y1 - y0, 0.06], [wx, (y0 + y1) / 2, s * (hz - 0.05)], [0, 0, 0], o);
  k.rbox(KM.paint, [0.02, top - 0.04 - y1, hz - 0.02 + wz], 0.004, [wx, (top - 0.04 + y1) / 2, (-hz + 0.02 + wz) / 2], [0, 0, 0], o);
  k.rbox(KM.paint, [0.02, top - 0.04 - 2.0, hz - 0.02 - wz], 0.004, [wx, (top - 0.04 + 2.0) / 2, (hz - 0.02 + wz) / 2], [0, 0, 0], o);
  k.at([wx, (y1 + 2.0) / 2, (hz - 0.02 + wz) / 2], [0, Math.PI / 2, 0], () => windowPane(k, hz - 0.02 - wz - 0.044, 2.0 - y1 - 0.044, [0, 0, 0], { ...o, frame: KM.anodized }));
  k.box(KM.seam, [0.002, 0.0045, 2 * hz - 0.08], [wx + 0.011, 0.62, 0], [0, 0, 0], nc);
  k.box(KM.seam, [0.002, 0.0045, hz - 0.06 + wz], [wx + 0.011, 1.7, (-hz + wz) / 2], [0, 0, 0], nc);
  // closed FIMS port doors at the side ports, in bezels
  for (const z of [-0.53, 0.53]) {
    k.rbox(KM.paintGrey, [0.014, y1 - y0 - 0.02, 0.33], 0.004, [wx + 0.006, (y0 + y1) / 2, z]);
    k.box(KM.seam, [0.002, 0.004, 0.25], [wx + 0.0135, (y0 + y1) / 2, z], [0, 0, 0], { cast: false });
    k.box(KM.anodizedDark, [0.012, 0.016, 0.38], [wx + 0.012, y1 + 0.008, z]);
    k.box(KM.anodizedDark, [0.012, 0.016, 0.38], [wx + 0.012, y0 - 0.008, z]);
    for (const s of [-1, 1]) k.box(KM.anodizedDark, [0.012, y1 - y0 + 0.032, 0.016], [wx + 0.012, (y0 + y1) / 2, z + s * 0.182]);
  }
  // FIMS door-opener housings inside, below each opening (the carrier door parks above them)
  for (const z of PORTS) {
    k.rbox(KM.paintGrey, [0.07, 0.15, 0.38], 0.012, [hx - 0.06, deck + 0.1, z], [0, 0, 0], o);
    k.box(KM.seam, [0.002, 0.004, 0.36], [hx - 0.0955, deck + 0.13, z], [0, 0, 0], nc);
    k.box(KM.ledGreen, [0.002, 0.006, 0.03], [hx - 0.0955, deck + 0.15, z + 0.15], [0, 0, 0], nc);
  }
  k.ao(2 * hx + 0.1, 2 * hz + 0.1, [0, 0, 0], 1.2);
}

/** The three load ports in front of the EFEM (live port with its FIMS plate at z = 0) and parked carriers. */
function buildPorts(k: Kit, foups: number[]) {
  PORTS.forEach((z, i) => k.at([PORT_X, 0, z], [0, Math.PI, 0], () => buildLoadPort(k, { plate: z === 0, n: 3 - i })));
  for (const z of foups) k.at([PORT_X, 0.9, z], [0, Math.PI, 0], () => buildFoup(k, true));
}

/** Fan-filter unit on the EFEM roof: filter frame, fan housing, motor intakes, controller, gauge. */
function buildFfu(k: Kit) {
  const { hx, hz, top } = EF;
  k.rbox(KM.anodized, [2 * hx + 0.06, 0.05, 2 * hz + 0.06], 0.006, [0, top + 0.025, 0]);
  k.rbox(KM.paint, [2 * hx + 0.02, 0.15, 2 * hz + 0.02], 0.02, [0, top + 0.125, 0]);
  k.box(KM.seam, [2 * hx + 0.024, 0.004, 2 * hz + 0.024], [0, top + 0.052, 0], [0, 0, 0], { cast: false });
  for (const z of [-0.4, 0.4]) {
    k.cyl(KM.paintGrey, 0.165, 0.03, [0, top + 0.215, z], [0, 0, 0], 40);
    k.cyl(KM.seam, 0.15, 0.002, [0, top + 0.231, z], [0, 0, 0], 40, { cast: false });
    for (const r of [0.05, 0.09, 0.13]) k.torus(KM.anodizedDark, r, 0.004, [0, top + 0.233, z], [0, 0, 0], 32, { cast: false });
    for (let i = 0; i < 4; i++) k.box(KM.anodizedDark, [0.28, 0.006, 0.008], [0, top + 0.234, z], [0, (i * Math.PI) / 4, 0], { cast: false });
    k.cyl(KM.anodizedDark, 0.03, 0.02, [0, top + 0.24, z], [0, 0, 0], 20, { cast: false });
  }
  // controller box with conduit to the ceiling
  k.rbox(KM.paintGraphite, [0.2, 0.08, 0.14], 0.01, [0.22, top + 0.24, 0]);
  k.box(KM.ledGreen, [0.012, 0.012, 0.004], [0.28, top + 0.25, 0.071], [0, 0, 0], { cast: false });
  k.cyl(KM.anodized, 0.018, 4.6 - top - 0.28, [0.18, (4.6 + top + 0.28) / 2, -0.04], [0, 0, 0], 12);
  // differential-pressure gauge on the +X face
  k.at([hx + 0.01, top + 0.12, -0.5], [0, Math.PI / 2, 0], () => {
    k.cyl(KM.paintGraphite, 0.045, 0.03, [0, 0, 0.015], [Math.PI / 2, 0, 0], 28);
    k.cyl(KM.plasticWhite, 0.038, 0.002, [0, 0, 0.031], [Math.PI / 2, 0, 0], 28, { cast: false });
    k.box(KM.paintRed, [0.003, 0.03, 0.002], [0.006, 0.006, 0.033], [0, 0, -0.5], { cast: false });
  });
  k.label('info', 'FFU · ULPA', '0.45 m/s · ΔP 120 Pa', 0.18, 0.045, [-0.15, top + 0.12, hz + 0.0115]);
  // diffuser grid under the filter (light panel is its own mesh)
  for (let i = -3; i <= 3; i++) k.box(KM.anodized, [2 * hx - 0.08, 0.012, 0.012], [0, top - 0.006, i * 0.22], [0, 0, 0], { cast: false });
  // ionizer bar with emitter pins
  k.rbox(KM.paintGraphite, [0.05, 0.03, 1.36], 0.008, [-0.24, top - 0.06, 0]);
  for (let i = 0; i < 13; i++) k.cyl(KM.chrome, 0.003, 0.024, [-0.24, top - 0.085, -0.6 + i * 0.1], [0, 0, 0], 6, { cast: false });
  k.box(KM.ledGreen, [0.004, 0.008, 0.03], [-0.214, top - 0.06, 0.6], [0, 0, 0], { cast: false });
}

/**
 * Operator furniture on the solid part of the load-port wall (kept clear of the window the
 * wafer camera looks through): HMI on a swing arm, EMO, model plate, robot-hazard sign, status
 * strip, mini-environment tag.
 */
function buildEfemDressing(k: Kit, sh: boolean) {
  const o = { shell: sh };
  const { hx, hz } = EF;
  hmi(k, [hx + 0.24, 1.56, -0.52], Math.PI / 2);
  k.rbox(KM.anodized, [0.04, 0.12, 0.06], 0.006, [hx + 0.02, 1.56, -0.52]);
  k.at([hx + 0.006, 1.44, -0.27], [0, Math.PI / 2, 0], () => emo(k, o));
  plate(k, 'model', 'EF-300', 'EFEM · 3 LOAD PORTS · 300 mm', 0.34, 0.085, [hx + 0.007, 1.98, -0.49], [0, Math.PI / 2, 0], o);
  plate(k, 'warn', 'ROBOT', '', 0.07, 0.07, [hx + 0.007, 1.62, -0.27], [0, Math.PI / 2, 0], o);
  k.at([hx + 0.006, 1.86, -0.49], [0, Math.PI / 2, 0], () => statusStrip(k, 0.5, o));
  plate(k, 'info', 'MINI-ENV', 'ISO 3 · +5 Pa', 0.16, 0.04, [0.22, EF.deck + 0.055, hz + 0.001], [0, 0, 0], o);
}

/** OHT track (aluminium beam on hanger rods) and vehicle body. */
function buildOht(k: Kit) {
  const x0 = PORT_X;
  // track: top web, running rails, power rail, hangers to the ceiling
  k.rbox(KM.anodized, [6, 0.05, 0.16], 0.008, [x0, OHT_Y + 0.215, 0]);
  for (const s of [-1, 1]) k.box(KM.stainless, [6, 0.02, 0.035], [x0, OHT_Y + 0.17, s * 0.06]);
  k.box(KM.paintGraphite, [6, 0.03, 0.014], [x0, OHT_Y + 0.17, 0]);
  for (let i = -2; i <= 2; i++) {
    const x = x0 + i * 1.4;
    k.box(KM.paintGrey, [0.05, 0.04, 0.34], [x, OHT_Y + 0.26, 0]);
    for (const s of [-1, 1]) k.cyl(KM.steel, 0.008, 4.6 - OHT_Y - 0.28, [x, (4.6 + OHT_Y + 0.28) / 2, s * 0.15], [0, 0, 0], 8);
  }
  k.at([x0, 0, 0], 0, () => {
    // drive unit riding in the track
    k.rbox(KM.anodizedDark, [0.5, 0.1, 0.1], 0.01, [0, OHT_Y + 0.11, 0]);
    for (const x of [-0.2, 0.2]) for (const s of [-1, 1]) k.cyl(KM.rubber, 0.03, 0.02, [x, OHT_Y + 0.145, s * 0.06], [Math.PI / 2, 0, 0], 16);
    // body with end bumpers, side covers (anti-drop doors) and the hoist opening
    k.rbox(KM.paint, [0.84, 0.44, 0.6], 0.04, [0, OHT_Y - 0.18, 0]);
    k.box(KM.seam, [0.845, 0.004, 0.605], [0, OHT_Y - 0.06, 0], [0, 0, 0], { cast: false });
    for (const s of [-1, 1]) {
      k.rbox(KM.paintGraphite, [0.05, 0.68, 0.58], 0.02, [s * 0.44, OHT_Y - 0.3, 0]);
      k.box(KM.glassSmoke, [0.004, 0.06, 0.24], [s * 0.467, OHT_Y - 0.08, 0], [0, 0, 0], { cast: false });
      k.at([s * 0.468, OHT_Y - 0.3, 0], [0, (s * Math.PI) / 2, 0], () => ledStrip(k, 0.4, [0, 0, 0], KM.ledAmber));
      k.rbox(KM.paint, [0.8, 0.26, 0.025], 0.01, [0, OHT_Y - 0.51, s * 0.285]);
      for (const x of [-0.3, 0.3]) k.cyl(KM.stainlessDark, 0.006, 0.004, [x, OHT_Y - 0.6, s * 0.2985], [Math.PI / 2, 0, 0], 8, { cast: false });
      k.box(KM.seam, [0.7, 0.004, 0.002], [0, OHT_Y - 0.44, s * 0.2985], [0, 0, 0], { cast: false });
    }
    k.box(KM.seam, [0.5, 0.004, 0.4], [0, OHT_Y - 0.402, 0], [0, 0, 0], { cast: false });
    k.label('model', 'OHT-12', 'OVERHEAD HOIST TRANSPORT', 0.3, 0.075, [-0.12, OHT_Y - 0.2, 0.3015]);
    k.label('warn', 'OVERHEAD', '', 0.08, 0.08, [0.28, OHT_Y - 0.2, 0.3015]);
  });
}

/** OHT gripper (moves with the hoist): plate, locating cone and three fingers around the FOUP flange. */
function buildGripper(k: Kit) {
  k.rbox(KM.anodizedDark, [0.34, 0.03, 0.34], 0.01, [0, 0.0, 0]);
  k.rbox(KM.paint, [0.26, 0.05, 0.26], 0.012, [0, 0.04, 0]);
  k.cyl(KM.stainless, 0.02, 0.02, [0, -0.02, 0], [0, 0, 0], 16, { top: 0.4 });
  for (const a of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) {
    const x = Math.cos(a) * 0.115;
    const z = Math.sin(a) * 0.115;
    k.box(KM.stainless, [0.02, 0.05, 0.04], [x, -0.035, z], [0, -a, 0]);
    k.box(KM.stainless, [0.03, 0.01, 0.04], [x - Math.cos(a) * 0.012, -0.056, z - Math.sin(a) * 0.012], [0, -a, 0]);
  }
}

/** Pre-aligner: pedestal, spindle housing, notch-finding through-beam fork. */
function buildAligner(k: Kit, p: THREE.Vector3) {
  k.at([p.x, 0, p.z], 0, () => {
    const d = EF.deck + 0.02;
    k.rbox(KM.paint, [0.24, p.y - d - 0.19, 0.24], 0.012, [0, (p.y + d - 0.19) / 2, 0]);
    k.box(KM.seam, [0.244, 0.004, 0.244], [0, p.y - 0.195, 0], [0, 0, 0], { cast: false });
    k.rbox(KM.paint, [0.3, 0.12, 0.3], 0.018, [0, p.y - 0.13, 0]);
    k.rbox(KM.paintGraphite, [0.31, 0.012, 0.31], 0.004, [0, p.y - 0.068, 0]);
    k.cyl(KM.anodizedDark, 0.032, 0.03, [0, p.y - 0.05, 0], [0, 0, 0], 24);
    k.label('model', 'PA-1', 'PRE-ALIGNER', 0.14, 0.035, [0, p.y - 0.13, 0.1505]);
    k.box(KM.ledGreen, [0.03, 0.006, 0.003], [0.1, p.y - 0.1, 0.1505], [0, 0, 0], { cast: false });
    // through-beam notch sensor straddling the wafer edge
    k.rbox(KM.paintGraphite, [0.03, 0.1, 0.05], 0.006, [0.2, p.y - 0.02, 0]);
    k.rbox(KM.paintGraphite, [0.075, 0.014, 0.05], 0.004, [0.17, p.y + 0.022, 0]);
    k.rbox(KM.paintGraphite, [0.075, 0.014, 0.05], 0.004, [0.17, p.y - 0.032, 0]);
    k.cyl(KM.paintRed, 0.006, 0.002, [0.155, p.y - 0.024, 0], [0, 0, 0], 12, { cast: false });
    hose(k, [0.21, p.y - 0.06, 0.02], [0.13, d + 0.02, 0.1], 0.005, 0.03, KM.plastic);
  });
}

/** Vacuum chuck (rotates with the aligner spindle). */
function buildChuck(k: Kit) {
  k.lathe(KM.anodized, [[0.0001, -0.022], [0.03, -0.022], [0.035, -0.018], [0.035, -0.003], [0.033, -0.002], [0.0001, -0.002]], [0, 0, 0], [0, 0, 0], 32);
  for (const r of [0.012, 0.024]) k.torus(KM.seam, r, 0.0012, [0, -0.0018, 0], [0, 0, 0], 24, { cast: false });
}

/** EFEM rear wall toward the process tool: slit opening, bezel and a viewing window (x-ray shell). */
function buildRearWall(k: Kit, p: THREE.Vector3) {
  const o = { shell: true };
  const x = -EF.hx + 0.005;
  const { deck, top, hz } = EF;
  const s0 = p.y - 0.035;
  const s1 = p.y + 0.035;
  const w0 = s1 + 0.105;
  const w1 = 2.0;
  k.box(KM.paint, [0.02, s0 - deck - 0.02, 2 * hz - 0.04], [x, (s0 + deck + 0.02) / 2, 0], [0, 0, 0], o);
  for (const s of [-1, 1]) k.box(KM.paint, [0.02, s1 - s0, hz - 0.24], [x, p.y, s * (hz + 0.2) / 2], [0, 0, 0], o);
  k.box(KM.paint, [0.02, w0 - s1, 2 * hz - 0.04], [x, (w0 + s1) / 2, 0], [0, 0, 0], o);
  for (const s of [-1, 1]) k.box(KM.paint, [0.02, w1 - w0, 0.17], [x, (w0 + w1) / 2, s * (hz - 0.105)], [0, 0, 0], o);
  k.box(KM.paint, [0.02, top - w1, 2 * hz - 0.04], [x, (top + w1) / 2, 0], [0, 0, 0], o);
  k.at([x + 0.012, (w0 + w1) / 2, 0], [0, Math.PI / 2, 0], () => windowPane(k, 2 * hz - 0.4, w1 - w0, [0, 0, 0], { ...o, frame: KM.anodizedDark }));
  // slit-valve bezel on the EFEM side
  k.box(KM.anodizedDark, [0.012, 0.014, 0.44], [x + 0.014, s1 + 0.007, 0], [0, 0, 0], o);
  k.box(KM.anodizedDark, [0.012, 0.014, 0.44], [x + 0.014, s0 - 0.007, 0], [0, 0, 0], o);
  for (const s of [-1, 1]) k.box(KM.anodizedDark, [0.012, s1 - s0 + 0.028, 0.014], [x + 0.014, p.y, s * 0.213], [0, 0, 0], o);
  plate(k, 'warn', 'PINCH', '', 0.06, 0.06, [x + 0.012, s1 + 0.06, 0.3], [0, Math.PI / 2, 0], o);
}

/** Process module: frame, slit-valve body, cut-away chamber with lid, gas feed and RF match. */
function buildChamberShell(k: Kit, p: THREE.Vector3) {
  const o = { shell: true };
  // slit-valve body: slot at the wafer plane, bonnet above (the gate parks there), actuators
  const vx = -EF.hx - 0.0275;
  k.box(KM.stainless, [0.045, 0.1, 0.5], [vx, p.y - 0.085, 0], [0, 0, 0], o);
  k.box(KM.stainless, [0.045, 0.14, 0.5], [vx, p.y + 0.105, 0], [0, 0, 0], o);
  for (const s of [-1, 1]) k.box(KM.stainless, [0.045, 0.07, 0.04], [vx, p.y, s * 0.23], [0, 0, 0], o);
  for (const s of [-1, 1]) k.cyl(KM.anodized, 0.022, 0.16, [vx, p.y + 0.255, s * 0.15], [0, 0, 0], 20, o);
  k.box(KM.stainless, [0.05, 0.02, 0.38], [vx, p.y + 0.34, 0], [0, 0, 0], o);
  // chamber body (machined, open on the wafer side), top flange, domed lid
  k.at([p.x, 0, 0], 0, () => {
    k.lathe(KM.paintGrey, [[0.0001, 0.93], [0.25, 0.93], [0.25, 1.262], [0.222, 1.262], [0.222, 0.958], [0.0001, 0.958]], [0, 0, 0], [0, 0, 0], 64, o);
    for (const y of [1.0, 1.2]) k.torus(KM.stainlessDark, 0.251, 0.003, [0, y, 0], [0, 0, 0], 64, o);
    flange(k, 0.23, 1.281, o);
    k.lathe(KM.paintGrey, [[0.267, 1.3], [0.267, 1.325], [0.245, 1.352], [0.15, 1.375], [0.0001, 1.38]], [0, 0, 0], [0, 0, 0], 64, o);
    k.cyl(KM.stainless, 0.05, 0.07, [0, 1.41, 0], [0, 0, 0], 32, o);
    k.cyl(KM.stainlessDark, 0.06, 0.012, [0, 1.45, 0], [0, 0, 0], 32, o);
    // lid hinge at the back, viewport on the far side, pumping port below
    k.box(KM.anodizedDark, [0.06, 0.05, 0.32], [-0.27, 1.32, 0], [0, 0, 0], o);
    k.cyl(KM.chrome, 0.014, 0.36, [-0.29, 1.32, 0], [Math.PI / 2, 0, 0], 12, o);
    k.at([0.0, 1.12, -0.25], [0, Math.PI, 0], () => viewport(k, 0.035, 0.05, o));
    k.cyl(KM.stainless, 0.08, 0.08, [-0.06, 0.89, 0], [0, 0, 0], 32, o);
    // RF match and gas line over the lid
    k.rbox(KM.paint, [0.26, 0.16, 0.24], 0.015, [-0.08, 1.56, -0.02], [0, 0, 0], o);
    k.cyl(KM.anodized, 0.035, 0.03, [0, 1.47, 0], [0, 0, 0], 20, o);
    for (const z of [-0.11, 0.07]) k.box(KM.anodizedDark, [0.02, 0.14, 0.02], [-0.19, 1.41, z], [0, 0, 0], o);
    grille(k, 0.14, 0.06, [-0.12, 1.575, 0.101], o);
    plate(k, 'warn', 'RF', '', 0.06, 0.06, [0.0, 1.56, 0.101], [0, 0, 0], o);
    k.pipe(KM.stainless, [[0, 1.456, 0], [0, 1.5, 0], [0.1, 1.5, 0], [0.1, 1.5, -0.3], [0.1, 1.9, -0.3]], 0.008, 0.04, o);
  });
}

/** Process-module frame (outside the cut-away): cabinet with deck plate, pumping line, pedestal inside. */
function buildChamberFrame(k: Kit, p: THREE.Vector3) {
  k.at([-0.85, 0, 0], 0, () => {
    cabinet(k, { size: [0.76, 0.84, 0.92], panels: 1, rows: [0.34], handles: true, stripe: KM.paintAccent, ao: true });
    k.label('model', 'PM-1', 'PROCESS MODULE · 300 mm', 0.28, 0.07, [0, 0.74, 0.461]);
  });
  k.rbox(KM.anodized, [0.82, 0.02, 0.96], 0.006, [-0.85, 0.85, 0]);
  // heated pedestal and stem inside the chamber
  k.cyl(KM.stainless, 0.04, p.y - 0.06 - 0.958, [p.x, (p.y - 0.06 + 0.958) / 2, 0], [0, 0, 0], 20);
  k.cyl(KM.anodized, 0.165, 0.028, [p.x, p.y - 0.05, 0], [0, 0, 0], 48);
  k.cyl(KM.ptfe, 0.158, 0.004, [p.x, p.y - 0.035, 0], [0, 0, 0], 48, { cast: false });
  for (let i = 0; i < 3; i++) {
    const a = (i * 2 * Math.PI) / 3;
    k.cyl(KM.seam, 0.01, 0.002, [p.x + Math.cos(a) * 0.08, p.y - 0.032, Math.sin(a) * 0.08], [0, 0, 0], 12, { cast: false });
  }
  // exhaust: bellows-free foreline from the pumping port into the frame
  k.pipe(KM.stainless, [[p.x - 0.06, 0.85, 0], [p.x - 0.06, 0.7, 0], [p.x - 0.3, 0.7, 0]], 0.035, 0.06);
}

/** Neighbouring tool: the same EFEM (no x-ray), live-looking load ports with closed FOUPs, process tool. */
function buildNeighbourTool(k: Kit) {
  buildEfem(k, false);
  buildEfemDressing(k, false);
  buildFfu(k);
  buildPorts(k, [0, -0.53]);
  k.at([-1.3, 0, 0], 0, () => {
    cabinet(k, { size: [1.6, 2.0, 1.6], panels: 3, rows: [0.62, 1.55], handles: true, sidePanels: 2 });
    k.label('model', 'DP-4', 'DEPOSITION · 4 CHAMBERS', 0.4, 0.1, [-0.35, 1.78, 0.801]);
    k.label('warn', 'HIGH VOLTAGE', '', 0.1, 0.1, [0.5, 1.78, 0.801]);
    ledStrip(k, 1.3, [0, 1.95, 0.802], KM.ledGreen);
    estop(k, [0.68, 1.3, 0.8]);
    for (const z of [-0.4, 0.4]) {
      k.cyl(KM.stainless, 0.3, 0.12, [-0.1, 2.08, z], [0, 0, 0], 40);
      k.cyl(KM.stainlessDark, 0.32, 0.02, [-0.1, 2.15, z], [0, 0, 0], 40);
    }
    k.rbox(KM.paintGrey, [0.4, 0.3, 0.5], 0.02, [0.5, 2.15, 0]);
  });
}

/* ------------------------------------------------------------------ live assemblies */

/** Every static part of the tool, merged into one model; picks keep the components selectable. */
function useStation() {
  return useModel({
    efem: (k) => {
      buildEfem(k, true);
      buildEfemDressing(k, true);
    },
    ffu: buildFfu,
    port: (k) => buildPorts(k, [-0.53]),
    _oht: buildOht,
    aligner: (k) => buildAligner(k, P_ALIGN),
    wall: (k) => buildRearWall(k, P_CHAMBER),
    frame: (k) => buildChamberFrame(k, P_CHAMBER),
  });
}

/** Draws the station; EFEM walls and the rear wall follow x-ray only. */
function StationMeshes({ st }: { st: MergedModel }) {
  const view = useUI((s) => s.view);
  return <ModelView m={st} view={view === 'xray' ? 'xray' : 'normal'} pickable={false} />;
}

function Efem({ st }: { st: MergedModel }) {
  return (
    <Clickable sel={{ kind: 'machine', id: 'efem', label: 'Equipment front-end module (EFEM)' }}>
      <ModelPick m={st} tag="efem" />
      {/* EFEM fan-filter unit */}
      <Clickable sel={{ kind: 'component', id: 'ffu', machine: 'efem', label: 'EFEM FFU' }}>
        <ModelPick m={st} tag="ffu" />
        <B s={[0.8, 0.01, 1.5]} m={M.lightPanel} position={[0, 2.14, 0]} shadow={false} />
      </Clickable>
      <SignalTower position={[0.36, 2.37, 0.7]} />
    </Clickable>
  );
}

function LoadPortAndFoup({ st }: { st: MergedModel }) {
  const foup = useRef<THREE.Group>(null);
  const hoist = useRef<THREE.Group>(null);
  const belts = useRef<THREE.Group>(null);
  const beam = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const entry = engine.stage.id === 'cleanroom-entry';
    const arrive = entry ? pp('arrive') : 1;
    const dock = entry ? pp('dock') : 1;
    const y = 0.9 + (1 - smooth(arrive)) * (OHT_Y - 0.62 - 0.9);
    if (foup.current) foup.current.position.set(PORT_X + 0.05 - smooth(dock) * 0.05, y, 0);
    if (hoist.current) {
      hoist.current.position.y = y + 0.38;
      hoist.current.visible = entry && arrive < 1;
    }
    // hoist belts run from the gripper up into the vehicle
    if (belts.current) belts.current.scale.y = Math.max(0.01, OHT_Y - 0.4 - (y + 0.38));
    if (beam.current) {
      beam.current.visible = entry && engine.player.view.phaseId === 'map';
      beam.current.position.y = Y0 + engine.robot.q[2];
    }
    if (entry && arrive < 1) track('focus', PORT_X, y + 0.2, 0);
  });
  const grip = useModel(buildGripper);
  return (
    <group>
      <Clickable sel={{ kind: 'component', id: 'load-port', machine: 'efem', label: 'Load port (FIMS)' }}>
        <ModelPick m={st} tag="port" />
      </Clickable>
      <group ref={foup} position={[PORT_X, 0.9, 0]}>
        <Clickable sel={{ kind: 'wafer', id: 'lot-foup', label: 'FOUP · LOT-A0731 (25 wafers)' }}>
          <FoupLive />
        </Clickable>
      </group>
      <group ref={hoist} position={[PORT_X, 0, 0]}>
        <ModelView m={grip} />
        <group ref={belts}>
          {[-0.12, 0.12].map((dz) => (
            <B key={dz} s={[0.012, 1, 0.024]} m={M.panelDark} position={[0, 0.5, dz]} shadow={false} />
          ))}
        </group>
      </group>
      <mesh ref={beam} position={[0.4, 1, 0]} rotation={[0, 0, Math.PI / 2]} visible={false}>
        <cylinderGeometry args={[0.002, 0.002, 0.45, 6]} />
        <meshBasicMaterial color="#ff4a3a" toneMapped={false} />
      </mesh>
      <SensorIndicator id="wafer-presence" machine="efem" position={[0.46, 0.85, 0.3]} size={0.05} />
      <TechLabel position={[PORT_X, 1.45, 0.3]} title="FOUP · 25 SLOTS" lines={['SEMI E47.1 carrier · E84 hand-off']} />
    </group>
  );
}

/** FOUP whose door state and slot occupancy follow the simulation. */
function FoupLive() {
  useTicker(12);
  const entry = engine.stage.id === 'cleanroom-entry';
  const door = entry ? smooth(clamp(pp('dock') * 1.4 - 0.3)) : 1;
  const hide = engine.robot.waferLoc !== 'foup' ? FOUP_SLOT : undefined;
  return (
    <group rotation={[0, Math.PI, 0]}>
      <FOUP door={Math.min(0.999, door)} hideSlot={hide} />
    </group>
  );
}

function Aligner({ st }: { st: MergedModel }) {
  const chuck = useRef<THREE.Group>(null);
  const wafer = useRef<THREE.Mesh>(null);
  const p = P_ALIGN;
  useFrame(() => {
    const r = engine.robot;
    if (chuck.current) chuck.current.rotation.y = r.waferSpin;
    if (wafer.current) wafer.current.visible = r.waferLoc === 'aligner';
  });
  const chuckModel = useModel(buildChuck, [], { shadow: false });
  return (
    <Clickable sel={{ kind: 'component', id: 'aligner', machine: 'efem', label: 'Pre-aligner' }}>
      <ModelPick m={st} tag="aligner" />
      <group ref={chuck} position={[p.x, p.y - 0.004, p.z]}>
        <ModelView m={chuckModel} />
        <mesh ref={wafer} geometry={waferGeometry()} material={waferMat} visible={false} />
      </group>
      <TechLabel position={[p.x, p.y + 0.12, p.z - 0.15]} title="PRE-ALIGNER" lines={['finds notch & centre']} value={() => (engine.robot.notchFound ? 'NOTCH FOUND · ORIENTED' : 'SEARCHING NOTCH…')} />
    </Clickable>
  );
}

function ProcessChamber({ st }: { st: MergedModel }) {
  const view = useUI((s) => s.view);
  const valve = useRef<THREE.Mesh>(null);
  const pins = useRef<THREE.Group>(null);
  const wafer = useRef<THREE.Mesh>(null);
  const glow = useRef<THREE.PointLight>(null);
  const p = P_CHAMBER;
  const open = useRef(0);
  useFrame((_, dt) => {
    const r = engine.robot;
    const ph = engine.player.view.phaseId;
    const lab = engine.stage.id === 'robot-lab';
    // the slit valve opens only while the arm reaches into the chamber
    const reach = Math.cos(r.q[0]) < -0.95 && r.q[1] > 0.35;
    const want = reach || ph === 'transfer' || ph === 'place' ? 1 : 0;
    open.current += (want - open.current) * Math.min(1, dt * 6);
    if (valve.current) valve.current.position.y = p.y + open.current * 0.12;
    if (pins.current) pins.current.position.y = r.waferLoc === 'chamber' && !reach ? -0.012 : 0;
    if (wafer.current) wafer.current.visible = r.waferLoc === 'chamber';
    const processing = r.waferLoc === 'chamber' && !reach && (lab ? r.stepLabel === 'PROCESS' : ph === 'return');
    if (glow.current) glow.current.intensity = processing ? 2.5 + Math.sin(engine.time * 20) * 0.3 : 0;
  });
  const body = useModel((k) => buildChamberShell(k, p));
  return (
    <Clickable sel={{ kind: 'machine', id: 'dep-cluster', label: 'Process chamber (load lock)' }}>
      {/* EFEM back wall and module frame (station picks) and the always cut-away chamber */}
      <ModelPick m={st} tag="wall" />
      <ModelPick m={st} tag="frame" />
      <ModelView m={body} view={view === 'normal' ? 'cutaway' : view} />
      <mesh ref={valve} position={[-0.43, p.y, 0]} material={M.steelDark}>
        <boxGeometry args={[0.04, 0.05, 0.42]} />
      </mesh>
      <group ref={pins} position={[p.x, 0, 0]}>
        {[0, 1, 2].map((k) => (
          <mesh key={k} position={[Math.cos((k * 2 * Math.PI) / 3) * 0.08, p.y - 0.034, Math.sin((k * 2 * Math.PI) / 3) * 0.08]} scale={[0.006, 0.06, 0.006]} material={M.ceramic}>
            <cylinderGeometry args={[1, 1, 1, 12]} />
          </mesh>
        ))}
      </group>
      <mesh ref={wafer} geometry={waferGeometry()} material={waferMat} position={[p.x, p.y - 0.004, 0]} visible={false} />
      <pointLight ref={glow} position={[p.x, p.y + 0.08, 0]} color="#c9a6ff" distance={0.8} />
      <TechLabel position={[p.x, p.y + 0.75, 0]} title="SLIT VALVE → CHAMBER LIFT PINS" min={2} />
    </Clickable>
  );
}

/** Recent end-effector path (motion trail) and the live step sequence. */
function MotionTrail() {
  const pts = useRef<THREE.Vector3[]>([]);
  const cur = useMemo(() => new THREE.Vector3(), []);
  const line = useRef<{ geometry: { setPositions: (a: number[]) => void } } | null>(null);
  const seqRef = useRef<HTMLDivElement>(null);
  useFrame(() => {
    const e = engine.robot.effector();
    const v = cur.set(e.x, Y0 + e.y + 0.01, e.z);
    const last = pts.current[pts.current.length - 1];
    if (!last || last.distanceTo(v) > 0.01) {
      pts.current.push(v.clone());
      if (pts.current.length > 120) pts.current.shift();
      if (line.current && pts.current.length > 1) line.current.geometry.setPositions(pts.current.flatMap((p) => [p.x, p.y, p.z]));
    }
    if (seqRef.current) {
      const step = engine.robot.error ? 'ERROR' : engine.robot.stepLabel;
      Array.from(seqRef.current.children).forEach((c, i) => {
        (c as HTMLElement).style.borderColor = SEQ[i] === step ? 'var(--accent)' : '';
        (c as HTMLElement).style.color = SEQ[i] === step ? 'var(--text)' : '';
      });
    }
    track('focus', v.x, v.y, v.z);
  });
  const info = useUI((s) => s.info);
  return (
    <>
      <Line ref={line as never} points={[[0, Y0, 0], [0.01, Y0, 0]]} color="#c3d8a4" lineWidth={1.5} transparent opacity={0.6} />
      {info >= 2 && (
        <Html position={[-0.3, 2.65, 0.8]} style={{ pointerEvents: 'none' }} zIndexRange={[15, 0]}>
          <div className="tlabel" style={{ transform: 'translate(-50%,-100%)' }}>
            <div className="tlabel-title">ROBOT SEQUENCE · SIMULATION</div>
            <div ref={seqRef} className="seq" style={{ marginTop: 4 }}>
              {SEQ.map((s, i) => (
                <span key={i}>{s}</span>
              ))}
            </div>
          </div>
        </Html>
      )}
    </>
  );
}

function Neighbours() {
  const m = useModel((k) => {
    for (const z of [-3.6, 3.6]) k.at([0, 0, z], 0, () => buildNeighbourTool(k));
  });
  return (
    <>
      <ModelView m={m} pickable={false} />
      {[-3.6, 3.6].map((z) => (
        <SignalTower key={z} position={[0.36, 2.37, z + 0.7]} state={() => 'PROCESSING'} />
      ))}
    </>
  );
}

export default function RobotScene({ stage }: SceneProps) {
  const variant = stage.variant ?? 'efem';
  useEffect(() => {
    if (variant === 'lab') engine.robot.loop = true;
  }, [variant]);
  const st = useStation();
  return (
    <>
      <Lighting env="cleanroom" shadowExtent={4} />
      <CleanroomBay width={10} depth={8} height={4.6} />
      <StationMeshes st={st} />
      <Efem st={st} />
      <LoadPortAndFoup st={st} />
      <Aligner st={st} />
      <ProcessChamber st={st} />
      <RobotArm position={[0, Y0, 0]} />
      <MotionTrail />
      <SensorIndicator id="vacuum-switch" channel="vac" machine="efem" position={[0.2, 0.55, 0.45]} size={0.05} />
      <SensorIndicator id="joint-encoder" channel="j1" machine="efem" position={[-0.15, 0.55, 0.45]} size={0.05} />
      <SensorIndicator id="particle-counter" machine="efem" position={[0.3, 2.05, -0.6]} size={0.05} />
      {/* neighbouring tools for context */}
      <Neighbours />
      <Operator position={[2.2, 0, 1.6]} rotation={-Math.PI / 2.5} still />
      <TechLabel position={[0, Y0 + 0.2, 0.75]} title="MINI-ENVIRONMENT · CLEANER THAN THE ROOM" lines={['wafers never meet open cleanroom air']} min={2} />
    </>
  );
}
