'use client';
/**
 * Diffusion bay (§20, §32): a vertical oxidation furnace (batch, quartz boat, multi-zone
 * heater) and a single-wafer RTP chamber (lamp array, pyrometers).
 *   furnace: wafers load into the boat → boat rises into the tube → ramp → O₂ oxidation
 *            (Deal–Grove; oxide grows 56 % up / 44 % into the silicon) → anneal → cool → unload
 *   rtp:     lamps spike the wafer to ~1050 °C in seconds; dopants move onto lattice sites
 *
 * Static equipment is built with the detailing kit and merged per machine (one mesh per finish
 * for the whole furnace, its gas cabinet and load station; one for the RTP tool; one for the
 * neighbouring furnaces). Invisible pick proxies keep each component's Clickable. Moving parts
 * (boat, seal cap and elevator carriage, transfer arm, RTP wafer) are their own small models.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, CleanroomBay } from '../environments';
import { M, clippedOf, effectiveView } from '../materials';
import { GEO } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Inset, LiveProfile, FlowLine, rect } from '../parts/section';
import { waferGeometry, buildFoup, buildLoadPort, useModel, ModelView, ModelPick, type MergedModel } from '../parts/wafer';
import { Screen, clear, plot, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { Kit, type PartOpts, type V3, boltCircle, estop, gasStick, grille, hmi, hose, ledStrip, viewport, windowPane } from '../kit/build';
import { KM, labelMaterial } from '../kit/finish';
import { engine } from '@/simulation/engine';
import { pp, inPhase, pdt } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { rng, smooth, clamp, lerp } from '@/lib/math';
import { dealGrove, oxideColor, OXIDE_CONSUMPTION } from '@/simulation/models';

/* ================================================================ shared detail */

/** Euler rotation that points a Y-axis cylinder radially outward at plan angle a (x = cos a, z = sin a). */
const radial = (a: number): V3 => [0, -a, -Math.PI / 2];

/** Annulus (flange, ring plate) from r0 to r1, bottom at y, height h. */
function ring(k: Kit, m: THREE.Material, r0: number, r1: number, y: number, h: number, o: PartOpts = {}, seg = 64) {
  k.lathe(m, [[r0, y], [r1, y], [r1, y + h], [r0, y + h], [r0, y]], [0, 0, 0], [0, 0, 0], seg, o);
}

/** Label plate (as Kit.label) that can follow the cut-away / x-ray shell. */
function plate(k: Kit, kind: Parameters<typeof labelMaterial>[0], text: string, sub: string, w: number, h: number, pos: V3, o: PartOpts = {}, accent?: string) {
  k.add(labelMaterial(kind, text, sub, accent), PLANE, pos, [0, 0, 0], [w, h, 1], { ...o, cast: false, keepUV: true });
}
const PLANE = new THREE.PlaneGeometry(1, 1);

/** Emergency-off button on a yellow collar facing +Z (as the kit's estop, shell-aware). */
function emo(k: Kit, pos: V3, o: PartOpts = {}) {
  k.rbox(KM.paintYellow, [0.07, 0.07, 0.02], 0.006, [pos[0], pos[1], pos[2] + 0.01], [0, 0, 0], o);
  k.cyl(KM.paintRed, 0.022, 0.025, [pos[0], pos[1], pos[2] + 0.032], [Math.PI / 2, 0, 0], 20, o);
}

/** Status LED strip facing +Z (as the kit's ledStrip, shell-aware). */
function statusStrip(k: Kit, w: number, pos: V3, o: PartOpts = {}) {
  k.box(KM.seam, [w + 0.01, 0.014, 0.004], pos, [0, 0, 0], { ...o, cast: false });
  k.box(KM.ledGreen, [w, 0.008, 0.004], [pos[0], pos[1], pos[2] + 0.002], [0, 0, 0], { ...o, cast: false });
}

/** Floor stand for a monitor: base plate, pole, VESA bracket and the screen's rear housing. */
function monitorStand(k: Kit, pole: number, screenY: number, size: [number, number]) {
  k.rbox(KM.paintGraphite, [0.4, 0.02, 0.32], 0.006, [0, 0.01, 0]);
  k.cyl(KM.anodized, 0.03, 0.03, [0, 0.035, 0], [0, 0, 0], 20);
  k.cyl(KM.anodized, 0.022, pole, [0, pole / 2, 0], [0, 0, 0], 16);
  k.rbox(KM.anodizedDark, [0.12, 0.1, 0.04], 0.008, [0, screenY, 0.0]);
  k.rbox(KM.plastic, [size[0] + 0.03, size[1] + 0.03, 0.03], 0.01, [0, screenY, 0.012]);
  k.ao(0.4, 0.32, [0, 0, 0], 1.5);
}

/* ================================================================ furnace */

const FX = -3;
const BOAT_N = 40;
const BOAT_PITCH = 0.026;
const BOAT_LOW = 0.5; // boat base height when lowered
const BOAT_HIGH = 2.05; // inside the tube
const FOLLOWED = 12; // slot of WF-000184 in the boat
/** furnace enclosure (local to FX): half width, half depth, height, loading-area / heater split */
const FN = { hw: 0.7, hd: 0.65, h: 3.9, split: 1.95 };

const boatWaferMat = new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.12, metalness: 0.85, emissive: new THREE.Color('#ff5a1a'), emissiveIntensity: 0 });
const heaterGlow = new THREE.MeshStandardMaterial({ color: '#3a2a20', emissive: new THREE.Color('#ff6a1a'), emissiveIntensity: 0.2, side: THREE.BackSide, roughness: 0.8, toneMapped: false });

function boatY(furnace: boolean) {
  if (!furnace) return BOAT_LOW;
  const up = smooth(pp('raise'));
  const down = smooth(pp('unload'));
  return lerp(BOAT_LOW, BOAT_HIGH, up * (1 - down));
}

/** Framed glass door leaf facing +Z: powder-coated stiles and rails, glass, pull handle, hinges. */
function doorLeaf(k: Kit, x0: number, x1: number, y0: number, y1: number, z: number, hingeLeft: boolean, o: PartOpts, glass: THREE.Material) {
  const w = x1 - x0;
  const h = y1 - y0;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const t = 0.05;
  k.rbox(KM.paint, [w, t, 0.035], 0.008, [cx, y1 - t / 2, z], [0, 0, 0], o);
  k.rbox(KM.paint, [w, t * 1.6, 0.035], 0.008, [cx, y0 + t * 0.8, z], [0, 0, 0], o);
  for (const x of [x0 + t / 2, x1 - t / 2]) k.rbox(KM.paint, [t, h, 0.035], 0.008, [x, cy, z], [0, 0, 0], o);
  k.box(glass, [w - 2 * t + 0.01, h - 2.6 * t + 0.01, 0.006], [cx, cy + t * 0.3, z], [0, 0, 0], { cast: false, ...o });
  // gasket line round the glass
  k.box(KM.seam, [w - 2 * t + 0.016, 0.004, 0.004], [cx, y1 - t + 0.002, z + 0.017], [0, 0, 0], { cast: false, ...o });
  k.box(KM.seam, [w - 2 * t + 0.016, 0.004, 0.004], [cx, y0 + t * 1.6 - 0.002, z + 0.017], [0, 0, 0], { cast: false, ...o });
  const hx = hingeLeft ? x1 - t / 2 : x0 + t / 2;
  const kx = hingeLeft ? x0 - 0.004 : x1 + 0.004;
  // pull handle on stand-offs
  k.rbox(KM.anodized, [0.018, 0.34, 0.016], 0.006, [hx, cy, z + 0.045], [0, 0, 0], o);
  for (const dy of [-0.15, 0.15]) k.cyl(KM.anodized, 0.007, 0.03, [hx, cy + dy, z + 0.03], [Math.PI / 2, 0, 0], 10, o);
  // hinges and door-closed sensor
  for (const y of [y0 + 0.2, y1 - 0.2]) k.cyl(KM.stainlessDark, 0.011, 0.09, [kx, y, z + 0.012], [0, 0, 0], 12, o);
  k.box(KM.ledGreen, [0.006, 0.02, 0.004], [hx, y1 - 0.08, z + 0.019], [0, 0, 0], { cast: false, ...o });
}

/**
 * Furnace enclosure (local frame, origin on the floor at the furnace axis, +Z operator side):
 * kick plate, side/back panels with seams, fasteners and louvres, heater-section front with
 * model plate, hazard labels, status strip and EMO, accent band, framed glass doors onto the
 * loading area, top cap with heat-exhaust (scavenger) box and duct, signal-tower mast.
 */
function buildFurnaceCabinet(k: Kit, sh: boolean, glass: THREE.Material) {
  const o = { shell: sh };
  const nc = { cast: false, ...o };
  const { hw, hd, h, split } = FN;
  const pl = 0.08;
  k.box(KM.paintGraphite, [2 * hw - 0.05, pl, 2 * hd - 0.05], [0, pl / 2, 0], [0, 0, 0], o);
  // side panels with seams, fasteners and louvred vents
  for (const s of [-1, 1]) {
    const x = s * (hw - 0.015);
    k.rbox(KM.paint, [0.03, h - pl, 2 * hd], 0.01, [x, pl + (h - pl) / 2, 0], [0, 0, 0], o);
    for (const y of [1.0, split, 2.95]) k.box(KM.seam, [0.002, 0.0045, 2 * hd - 0.04], [s * (hw + 0.0006), y, 0], [0, 0, 0], nc);
    k.box(KM.seam, [0.002, h - pl - 0.04, 0.0045], [s * (hw + 0.0006), pl + (h - pl) / 2, 0], [0, 0, 0], nc);
    for (const [y, z] of [[pl + 0.04, -hd + 0.04], [pl + 0.04, hd - 0.04], [0.96, -0.04], [0.96, 0.04], [1.04, -hd + 0.04], [1.04, hd - 0.04], [split - 0.04, -0.04], [split + 0.04, hd - 0.04], [2.91, -hd + 0.04], [2.99, 0.04], [h - 0.04, -hd + 0.04], [h - 0.04, hd - 0.04]] as const)
      k.cyl(KM.stainlessDark, 0.0055, 0.004, [s * (hw + 0.001), y, z], [0, 0, Math.PI / 2], 8, nc);
    k.at([s * (hw + 0.001), 0.5, 0.3], [0, (s * Math.PI) / 2, 0], () => grille(k, 0.44, 0.24, [0, 0, 0], { ...o, m: KM.paint }));
    k.at([s * (hw + 0.001), 3.55, -0.3], [0, (s * Math.PI) / 2, 0], () => grille(k, 0.44, 0.3, [0, 0, 0], { ...o, m: KM.paint }));
  }
  // back panel
  k.rbox(KM.paint, [2 * hw, h - pl, 0.03], 0.01, [0, pl + (h - pl) / 2, -(hd - 0.015)], [0, 0, 0], o);
  for (const y of [split, 2.95]) k.box(KM.seam, [2 * hw - 0.04, 0.0045, 0.002], [0, y, -hd - 0.0006], [0, 0, 0], nc);
  // heater-section front: two panels, seams, fasteners, vents
  const zf = hd - 0.015;
  k.rbox(KM.paint, [2 * hw, h - split - 0.06, 0.03], 0.01, [0, (h + split + 0.06) / 2, zf], [0, 0, 0], o);
  k.box(KM.seam, [0.0045, h - split - 0.1, 0.002], [0, (h + split + 0.06) / 2, hd + 0.0006], [0, 0, 0], nc);
  k.box(KM.seam, [2 * hw - 0.04, 0.0045, 0.002], [0, 2.95, hd + 0.0006], [0, 0, 0], nc);
  for (const x of [-hw + 0.04, -0.04, 0.04, hw - 0.04]) for (const y of [split + 0.1, 2.91, 2.99, h - 0.04]) k.cyl(KM.stainlessDark, 0.0055, 0.004, [x, y, hd + 0.001], [Math.PI / 2, 0, 0], 8, nc);
  grille(k, 0.5, 0.16, [-0.33, 3.66, hd + 0.001], o);
  grille(k, 0.5, 0.16, [0.33, 3.66, hd + 0.001], o);
  plate(k, 'model', 'VF-300', 'VERTICAL FURNACE · 150 WAFERS · 1200 °C', 0.44, 0.11, [-0.33, 3.3, hd + 0.002], o);
  plate(k, 'warn', 'HOT SURFACE', '', 0.11, 0.11, [0.22, 3.3, hd + 0.002], o);
  plate(k, 'warn', 'HIGH VOLTAGE', '', 0.11, 0.11, [0.42, 3.3, hd + 0.002], o);
  statusStrip(k, 1.2, [0, 3.84, hd + 0.003], o);
  emo(k, [0.56, 2.25, hd], o);
  // quarter-turn panel latches
  for (const x of [-hw + 0.06, -0.06, 0.06, hw - 0.06])
    for (const y of [2.45, 3.45]) {
      k.cyl(KM.paintGraphite, 0.011, 0.004, [x, y, hd + 0.002], [Math.PI / 2, 0, 0], 12, nc);
      k.box(KM.seam, [0.016, 0.003, 0.002], [x, y, hd + 0.0045], [0, 0, x > 0 ? 0.6 : -0.6], nc);
    }
  // operator HMI on a swing arm at the front-right corner
  k.rbox(KM.anodized, [0.09, 0.1, 0.06], 0.006, [hw + 0.04, 1.45, 0.42], [0, 0, 0], o);
  hmi(k, [hw + 0.2, 1.45, hd - 0.03], 0.6);
  // accent band between the sections, with the door header
  k.rbox(KM.paintAccent, [2 * hw + 0.02, 0.08, 0.06], 0.01, [0, 1.92, hd + 0.01], [0, 0, 0], o);
  // loading-area front: jambs, sill and two glass doors
  for (const s of [-1, 1]) k.rbox(KM.paint, [0.04, 1.8, 0.04], 0.008, [s * (hw - 0.02), 0.98, hd - 0.005], [0, 0, 0], o);
  k.rbox(KM.paint, [2 * hw, 0.04, 0.04], 0.008, [0, pl + 0.02, hd - 0.005], [0, 0, 0], o);
  doorLeaf(k, -hw + 0.045, -0.006, pl + 0.045, 1.875, hd + 0.0, true, o, glass);
  doorLeaf(k, 0.006, hw - 0.045, pl + 0.045, 1.875, hd + 0.0, true, o, glass);
  // top cap, heat-exhaust (scavenger) box and duct to the house exhaust
  k.rbox(KM.paintGraphite, [2 * hw + 0.012, 0.03, 2 * hd + 0.012], 0.008, [0, h + 0.015, 0], [0, 0, 0], o);
  k.at([-0.22, h + 0.03, -0.2], 0, () => {
    k.rbox(KM.paint, [0.7, 0.26, 0.56], 0.02, [0, 0.13, 0]);
    k.box(KM.seam, [0.704, 0.0045, 0.564], [0, 0.2, 0], [0, 0, 0], { cast: false });
    grille(k, 0.4, 0.12, [0, 0.11, 0.281]);
    k.cyl(KM.stainless, 0.13, 4.4 - h - 0.3, [0.08, 0.26 + (4.4 - h - 0.3) / 2, -0.05], [0, 0, 0], 32);
    for (const y of [0.3, 0.46]) k.torus(KM.stainlessDark, 0.132, 0.006, [0.08, y, -0.05], [0, 0, 0], 32);
  });
  // signal-tower mast (the tower stands on it)
  k.cyl(KM.anodized, 0.016, 0.13, [0.55, h + 0.095, 0.5], [0, 0, 0], 12);
  k.cyl(KM.anodizedDark, 0.035, 0.012, [0.55, h + 0.036, 0.5], [0, 0, 0], 20);
  k.ao(2 * hw, 2 * hd, [0, 0, 0], 1.25);
}

/**
 * Loading-area and heater-section interiors of the live furnace (cut-away shows them):
 * heater-section floor with the throat opening, scavenger duct round the throat, manifold
 * with gas inlets, exhaust port and cooling lines, FOUP stocker with parked carriers, mini-
 * environment FFU, and the gas / exhaust piping in the heater section.
 */
function buildFurnaceInterior(k: Kit) {
  const { hw, hd, split } = FN;
  const so = { shell: true };
  // heater-section floor plate around the throat (cut-away with the shell)
  const op = 0.39;
  k.box(KM.paintGrey, [2 * hw - 0.06, 0.04, hd - op - 0.03], [0, split, (-hd + 0.03 - op) / 2], [0, 0, 0], so);
  k.box(KM.paintGrey, [2 * hw - 0.06, 0.04, hd - op - 0.03], [0, split, (hd - 0.03 + op) / 2], [0, 0, 0], so);
  for (const s of [-1, 1]) k.box(KM.paintGrey, [hw - op - 0.03, 0.04, 2 * op], [s * (hw - 0.03 + op) / 2, split, 0], [0, 0, 0], so);
  // scavenger: ring exhaust duct round the throat (under the manifold), drawn off at the back
  ring(k, KM.stainless, 0.33, 0.39, 1.74, 0.06, so);
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    k.box(KM.seam, [0.004, 0.002, 0.03], [Math.cos(a) * 0.36, 1.801, Math.sin(a) * 0.36], [0, -a, 0], { cast: false, ...so });
  }
  k.pipe(KM.stainless, [[0.2, 1.77, -0.3], [0.2, 1.77, -0.56], [0.2, 0.3, -0.56], [0.2, 0.3, -0.62]], 0.045, 0.08);
  // manifold under the tube flange: water-cooled ring, inlet ports, exhaust port, bolt circle
  k.lathe(KM.stainless, [[0.215, 1.8], [0.33, 1.8], [0.33, 1.84], [0.3, 1.845], [0.3, 1.945], [0.33, 1.95], [0.33, 1.98], [0.215, 1.98], [0.215, 1.8]], [0, 0, 0], [0, 0, 0], 64);
  for (const y of [1.87, 1.92]) k.torus(KM.copper, 0.305, 0.008, [0, y, 0], [0, 0, 0], 48);
  boltCircle(k, 0.315, 16, 1.985, 0.007);
  for (const a of [-2.0, -1.75, -1.5]) {
    k.cyl(KM.stainless, 0.014, 0.08, [Math.cos(a) * 0.37, 1.9, Math.sin(a) * 0.37], radial(a), 16);
    k.cyl(KM.stainlessDark, 0.02, 0.016, [Math.cos(a) * 0.41, 1.9, Math.sin(a) * 0.41], radial(a), 6);
  }
  // exhaust port toward +X and the exhaust line down the side to the house exhaust
  k.cyl(KM.stainless, 0.045, 0.16, [0.33, 1.89, -0.2], [0, 0, -Math.PI / 2], 24);
  k.cyl(KM.stainlessDark, 0.06, 0.02, [0.41, 1.89, -0.2], [0, 0, -Math.PI / 2], 24);
  k.pipe(KM.stainless, [[0.41, 1.89, -0.2], [0.6, 1.89, -0.2], [0.6, 0.3, -0.2], [0.6, 0.3, -0.62]], 0.04, 0.08);
  // mini-environment FFU on the loading-area ceiling (down-flow onto the boat)
  k.rbox(KM.paintGrey, [0.5, 0.08, 0.5], 0.01, [-0.4, split - 0.07, -0.33]);
  for (let i = 0; i < 8; i++) k.box(KM.seam, [0.44, 0.004, 0.012], [-0.4, split - 0.111, -0.54 + i * 0.06], [0, 0, 0], { cast: false });
  // FOUP stocker on the left: two shelves, uprights, parked carriers (doors toward the robot)
  for (const y of [0.9, 1.42]) {
    k.rbox(KM.anodized, [0.44, 0.02, 0.4], 0.004, [-0.45, y - 0.01, -0.36]);
    k.at([-0.45, y, -0.36], 0, () => buildFoup(k, true));
  }
  for (const [x, z] of [[-0.67, -0.56], [-0.67, -0.16], [-0.23, -0.56]] as const) k.box(KM.anodized, [0.025, 1.4, 0.025], [x, 0.78, z]);
  // gas supply into the heater section: O₂ / H₂ / N₂ from the cabinet to the tube top
  for (let i = 0; i < 3; i++) {
    const z = -0.24 - i * 0.05;
    const y = 3.81 - i * 0.025;
    k.pipe(KM.stainless, [[-hw - 0.1, 3.3, z], [-0.45, 3.3, z], [-0.45, y, z], [-0.03, y, z], [-0.03, y, -0.09]], 0.009, 0.05);
  }
  k.rbox(KM.stainless, [0.07, 0.09, 0.06], 0.008, [0, 3.79, -0.08]);
  k.pipe(KM.stainless, [[0, 3.75, -0.08], [0, 3.75, 0], [0, 3.69, 0]], 0.012, 0.03);
  // injector line down to the manifold inlets
  k.pipe(KM.stainless, [[-hw - 0.1, 2.05, -0.382], [-0.46, 2.05, -0.382], [-0.46, 1.9, -0.382], [-0.175, 1.9, -0.382]], 0.009, 0.05);
  // heater power cables in a tray up the back wall
  k.box(KM.anodized, [0.2, 1.8, 0.008], [-0.45, 2.8, -hd + 0.035]);
  for (let i = 0; i < 4; i++) k.cyl(i % 2 ? KM.paintGraphite : KM.plastic, 0.012, 1.8, [-0.52 + i * 0.045, 2.8, -hd + 0.05], [0, 0, 0], 8, { cast: false });
}

/**
 * Multi-zone heater (local frame): stainless jacket with zone bands, insulated top lid,
 * flanges, per-zone power terminal boxes and conduits, spike thermocouples, cooling-water
 * lines; the glowing element (inner liner + coil turns) uses the animated heater material.
 */
function buildHeater(k: Kit) {
  const o = { shell: true };
  const nc = { cast: false, ...o };
  const y0 = 1.95;
  const y1 = 3.65;
  const R = 0.38;
  k.cyl(KM.stainless, R, y1 - y0, [0, (y0 + y1) / 2, 0], [0, 0, 0], 64, { ...o, open: true });
  ring(k, KM.stainlessDark, 0.3, 0.41, y0, 0.03, o);
  ring(k, KM.stainlessDark, 0.3, 0.41, y1 - 0.03, 0.03, o);
  k.lathe(KM.paintGrey, [[0.04, y1], [0.4, y1], [0.4, y1 + 0.05], [0.36, y1 + 0.08], [0.04, y1 + 0.08], [0.04, y1]], [0, 0, 0], [0, 0, 0], 64, o);
  for (const y of [2.15, 2.6, 3.05, 3.5]) k.torus(KM.stainlessDark, 0.385, 0.012, [0, y, 0], [0, 0, 0], 64, o);
  // vertical stiffeners
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    k.box(KM.stainlessDark, [0.012, y1 - y0 - 0.06, 0.02], [Math.cos(a) * (R + 0.008), (y0 + y1) / 2, Math.sin(a) * (R + 0.008)], [0, -a, 0], o);
  }
  // zone terminal boxes with conduits (back-left) and spike thermocouples (back-right)
  const zones = [2.05, 2.375, 2.825, 3.275, 3.575];
  zones.forEach((y, i) => {
    const a = -2.35;
    k.at([Math.cos(a) * (R + 0.045), y, Math.sin(a) * (R + 0.045)], [0, -a + Math.PI / 2, 0], () => {
      k.rbox(KM.paintGrey, [0.12, 0.09, 0.07], 0.01, [0, 0, 0]);
      k.box(KM.seam, [0.122, 0.003, 0.072], [0, 0.02, 0], [0, 0, 0], { cast: false });
      k.label('tag', 'ZONE', '', 0.05, 0.016, [0, -0.012, 0.036]);
    });
    k.pipe(KM.anodizedDark, [[Math.cos(a) * (R + 0.08), y, Math.sin(a) * (R + 0.08)], [Math.cos(a) * (R + 0.17), y, Math.sin(a) * (R + 0.17)], [Math.cos(a) * (R + 0.17), 3.75, Math.sin(a) * (R + 0.17)]], 0.012, 0.04);
    const b = -0.85;
    k.cyl(KM.stainless, 0.006, 0.12, [Math.cos(b) * (R + 0.06), y, Math.sin(b) * (R + 0.06)], radial(b), 8);
    k.cyl(KM.paintGraphite, 0.014, 0.03, [Math.cos(b) * (R + 0.12), y, Math.sin(b) * (R + 0.12)], radial(b), 10);
  });
  // cooling-water lines on the jacket (supply blue, return red)
  for (const [a, tag] of [[-1.35, KM.paintBlue], [-1.6, KM.paintRed]] as const) {
    k.cyl(KM.copper, 0.012, y1 - y0, [Math.cos(a) * (R + 0.03), (y0 + y1) / 2, Math.sin(a) * (R + 0.03)], [0, 0, 0], 10);
    k.cyl(tag, 0.016, 0.05, [Math.cos(a) * (R + 0.03), y1 - 0.12, Math.sin(a) * (R + 0.03)], [0, 0, 0], 12);
  }
  k.at([Math.cos(-1.1) * (R + 0.002), 2.95, Math.sin(-1.1) * (R + 0.002)], [0, 1.1 + Math.PI / 2, 0], () => k.label('warn', 'HOT SURFACE', '', 0.08, 0.08, [0, 0, 0.001]));
  // glowing element: insulation liner and coil turns (animated material, cut with the shell)
  k.cyl(heaterGlow, 0.31, 1.66, [0, 2.8, 0], [0, 0, 0], 48, { ...nc, open: true });
  for (let i = 0; i < 26; i++) k.torus(heaterGlow, 0.306, 0.005, [0, 2.0 + i * 0.062, 0], [0, 0, 0], 48, nc);
}

/** Quartz process tube (double wall, domed, flanged), inner liner and gas injector. */
function buildTube(k: Kit) {
  const q = { cast: false };
  const p: [number, number][] = [[0.27, 1.98], [0.27, 2.0], [0.23, 2.0]];
  for (let i = 0; i <= 10; i++) {
    const t = (i / 10) * (Math.PI / 2);
    p.push([Math.max(1e-4, Math.cos(t) * 0.23), 3.445 + Math.sin(t) * 0.23]);
  }
  for (let i = 10; i >= 0; i--) {
    const t = (i / 10) * (Math.PI / 2);
    p.push([Math.max(1e-4, Math.cos(t) * 0.222), 3.445 + Math.sin(t) * 0.222]);
  }
  p.push([0.222, 1.98], [0.27, 1.98]);
  k.lathe(M.quartz, p, [0, 0, 0], [0, 0, 0], 56, q);
  k.cyl(M.quartz, 0.205, 1.35, [0, 2.675, 0], [0, 0, 0], 48, { ...q, open: true });
  ring(k, M.quartz, 0.205, 0.222, 1.985, 0.012, q, 48);
  k.cyl(M.quartz, 0.006, 1.35, [0, 2.6, -0.2135], [0, 0, 0], 8, q);
  k.cyl(M.quartz, 0.014, 0.05, [0, 3.685, 0], [0, 0, 0], 12, q);
}

/** Boat elevator: ball-screw column with guide rails, servo and brake at the foot, top bearing. */
function buildElevator(k: Kit) {
  k.rbox(KM.paintGrey, [0.2, 0.08, 0.2], 0.01, [0, 0.04, 0]);
  k.rbox(KM.paint, [0.12, 1.78, 0.12], 0.012, [0, 0.98, 0]);
  for (const s of [-1, 1]) k.box(KM.stainless, [0.012, 1.7, 0.02], [s * 0.035, 1.0, 0.065]);
  k.cyl(KM.stainless, 0.012, 1.7, [0, 1.0, 0.075], [0, 0, 0], 12);
  k.rbox(KM.paintGrey, [0.16, 0.08, 0.16], 0.01, [0, 1.9, 0]);
  k.cyl(KM.paintGraphite, 0.045, 0.16, [0.15, 0.2, 0], [0, 0, 0], 20);
  k.cyl(KM.stainlessDark, 0.047, 0.03, [0.15, 0.295, 0], [0, 0, 0], 20);
}

/** Floor-standing gas cabinet: louvred lower doors, windowed gas-panel section, exhaust duct. */
function buildGasCabinet(k: Kit) {
  const w = 0.52;
  const d = 0.5;
  const h = 3.45;
  const zf = d / 2;
  const ys = 2.3; // lower doors / gas-panel section split
  k.box(KM.paintGraphite, [w - 0.04, 0.08, d - 0.04], [0, 0.04, 0]);
  k.rbox(KM.paint, [w, ys - 0.08, d], 0.012, [0, 0.08 + (ys - 0.08) / 2, 0]);
  k.rbox(KM.paintGraphite, [w + 0.012, 0.025, d + 0.012], 0.006, [0, h + 0.012, 0]);
  k.box(KM.seam, [w - 0.02, 0.0045, 0.002], [0, 1.1, zf + 0.001], [0, 0, 0], { cast: false });
  for (const s of [-1, 1]) for (const y of [0.12, 1.06, 1.14, ys - 0.04]) k.cyl(KM.stainlessDark, 0.0055, 0.004, [s * (w / 2 - 0.03), y, zf + 0.001], [Math.PI / 2, 0, 0], 8, { cast: false });
  grille(k, 0.36, 0.3, [0, 0.4, zf + 0.001], { m: KM.paint });
  grille(k, 0.36, 0.2, [0, 1.95, zf + 0.001], { m: KM.paint });
  k.rbox(KM.anodized, [0.014, 0.16, 0.012], 0.004, [0.2, 1.5, zf + 0.008]);
  // gas-panel section: side, back and top walls, framed window, three gas sticks behind it, tagged
  for (const s of [-1, 1]) k.rbox(KM.paint, [0.02, h - ys, d], 0.006, [s * (w / 2 - 0.01), (h + ys) / 2, 0]);
  k.rbox(KM.paint, [w, h - ys, 0.02], 0.006, [0, (h + ys) / 2, -zf + 0.01]);
  k.box(KM.paintGrey, [w - 0.06, h - ys - 0.06, 0.01], [0, (h + ys) / 2, -zf + 0.03], [0, 0, 0], { cast: false });
  const gw = w - 0.12;
  const gh = 0.84;
  const gy = 2.86;
  windowPane(k, gw, gh, [0, gy, zf - 0.012], { frame: KM.paintGraphite });
  for (const s of [-1, 1]) k.box(KM.paint, [(w - gw) / 2 - 0.022, h - ys, 0.02], [s * (w / 2 - ((w - gw) / 2 - 0.022) / 2), (h + ys) / 2, zf - 0.01]);
  k.box(KM.paint, [w, h - (gy + gh / 2 + 0.022), 0.02], [0, (h + gy + gh / 2 + 0.022) / 2, zf - 0.01]);
  k.box(KM.paint, [w, gy - gh / 2 - 0.022 - ys, 0.02], [0, (ys + gy - gh / 2 - 0.022) / 2, zf - 0.01]);
  const gases: [string, string][] = [['O₂', '#3e7d4c'], ['H₂', '#a8342b'], ['N₂', '#2f5d8a']];
  gases.forEach(([g, c], i) => {
    const y = 3.12 - i * 0.24;
    gasStick(k, 0.36, [0, y, -0.14]);
    k.label('gas', g, '', 0.1, 0.022, [-0.13, y + 0.09, -0.1], [0, 0, 0], c);
  });
  k.label('model', 'GC-3', 'GAS CABINET · O₂ · H₂ · N₂', 0.3, 0.075, [0, ys + 0.058, zf + 0.002]);
  k.label('warn', 'FLAMMABLE GAS', '', 0.1, 0.1, [0.14, 1.75, zf + 0.002]);
  ledStrip(k, 0.3, [0, 3.38, zf + 0.002], KM.ledGreen);
  // exhaust duct to the ceiling and supply valves on the roof
  k.cyl(KM.stainless, 0.07, 4.4 - h, [-0.1, h + (4.4 - h) / 2, -0.08], [0, 0, 0], 24);
  k.torus(KM.stainlessDark, 0.072, 0.006, [-0.1, h + 0.1, -0.08], [0, 0, 0], 24);
  for (let i = 0; i < 3; i++) {
    k.cyl(KM.stainless, 0.03, 0.12, [(i - 1) * 0.12 + 0.06, h + 0.06, 0.1], [0, 0, 0], 16);
    k.cyl(KM.paintBlue, 0.022, 0.03, [(i - 1) * 0.12 + 0.06, h + 0.135, 0.1], [0, 0, 0], 12);
  }
  k.ao(w, d, [0, 0, 0], 1.4);
}

/** Load station in front of the furnace: E15-style port and tunnel to the front wall, FOUP docked. */
function buildFurnacePort(k: Kit) {
  k.at([0.35, 0, 0.98], [0, Math.PI / 2, 0], () => {
    buildLoadPort(k, { plate: false });
    k.at([0, 0.9, 0], 0, () => buildFoup(k, true));
  });
}

/** Transfer-robot base: lift column with covers, seams and a cable exit. */
function buildTransferBase(k: Kit) {
  k.cyl(KM.anodizedDark, 0.12, 0.025, [0, 0.0125, 0], [0, 0, 0], 32);
  k.lathe(KM.paint, [[0.1, 0.025], [0.1, 0.84], [0.095, 0.88], [0.085, 0.9], [0.06, 0.9]], [0, 0, 0], [0, 0, 0], 40);
  for (const y of [0.3, 0.62]) k.torus(KM.seam, 0.1005, 0.0015, [0, y, 0], [0, 0, 0], 40, { cast: false });
  k.torus(KM.ledGreen, 0.088, 0.003, [0, 0.895, 0], [0, 0, 0], 32, { cast: false });
  hose(k, [-0.09, 0.15, -0.04], [-0.3, 0.02, -0.25], 0.012, 0.03, KM.paintGraphite);
}

/** Neighbouring furnace in the bay: same enclosure, no interior, smoked glass. */
function buildNeighbourFurnace(k: Kit) {
  buildFurnaceCabinet(k, false, KM.glassSmoke);
  k.rbox(KM.paintGrey, [1.2, 0.04, 1.1], 0.008, [0, FN.split - 0.06, 0]);
}

function Boat({ furnace }: { furnace: boolean }) {
  const group = useRef<THREE.Group>(null);
  const inst = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  useFrame(() => {
    const y = boatY(furnace);
    if (group.current) group.current.position.y = y;
    if (!inst.current) return;
    // wafers appear in the boat as the transfer robot loads them
    const n = furnace ? Math.floor(BOAT_N * clamp(pp('load') * 1.05)) : BOAT_N;
    for (let i = 0; i < BOAT_N; i++) {
      o.position.set(0, 0.06 + i * BOAT_PITCH, 0);
      o.scale.setScalar(i < n ? 1 : 0);
      o.updateMatrix();
      inst.current.setMatrixAt(i, o.matrix);
    }
    inst.current.instanceMatrix.needsUpdate = true;
    // oxide interference colour + thermal glow
    const tox = furnace ? engine.tele.value('tox', 0) : 55;
    const [r, g, b] = oxideColor(tox);
    boatWaferMat.color.setRGB(r, g, b);
    const T = furnace ? engine.tele.value('temp', 700) : 25;
    boatWaferMat.emissiveIntensity = clamp((T - 650) / 400) * 0.45;
    if (furnace && pp('raise') > 0 && pp('unload') < 1) track('focus', FX, y + 0.06 + FOLLOWED * BOAT_PITCH, 0);
    else if (furnace) track('focus', FX, BOAT_LOW + 0.6, 0.3);
  });
  // quartz boat: three slotted rods (one tooth per wafer), end rings
  const boat = useModel((k) => {
    const L = BOAT_N * BOAT_PITCH + 0.1;
    const q = { cast: false };
    for (const [x, z] of [[0.165, -0.02], [-0.165, -0.02], [0, -0.168]] as const) {
      k.cyl(M.quartz, 0.008, L, [x, L / 2, z], [0, 0, 0], 12, q);
      const a = Math.atan2(-z, -x);
      for (let i = 0; i <= BOAT_N; i++) k.box(M.quartz, [0.016, 0.003, 0.009], [x + Math.cos(a) * 0.008, 0.06 + (i - 0.5) * BOAT_PITCH, z + Math.sin(a) * 0.008], [0, -a, 0], q);
    }
    ring(k, M.quartz, 0.11, 0.19, 0, 0.02, q, 48);
    ring(k, M.quartz, 0.11, 0.19, L - 0.01, 0.02, q, 48);
  });
  // heat-insulating quartz pedestal with fins, seal cap with O-ring, rotation drive, elevator arm and carriage
  const base = useModel((k) => {
    const q = { cast: false };
    k.cyl(M.quartz, 0.12, 0.25, [0, -0.13, 0], [0, 0, 0], 40, { ...q, open: true });
    for (let i = 0; i < 5; i++) k.cyl(M.quartz, 0.17, 0.006, [0, -0.03 - i * 0.045, 0], [0, 0, 0], 40, q);
    k.lathe(KM.stainless, [[0.0001, -0.305], [0.31, -0.305], [0.31, -0.262], [0.29, -0.255], [0.0001, -0.255]], [0, 0, 0], [0, 0, 0], 64);
    k.torus(KM.seam, 0.27, 0.005, [0, -0.255, 0], [0, 0, 0], 48, { cast: false });
    boltCircle(k, 0.29, 12, -0.25, 0.006);
    k.cyl(KM.anodizedDark, 0.06, 0.11, [0, -0.36, 0], [0, 0, 0], 24);
    k.cyl(KM.paintGraphite, 0.062, 0.03, [0, -0.43, 0], [0, 0, 0], 24);
    k.at([0, -0.33, 0], Math.PI / 4, () => k.rbox(KM.paint, [0.6, 0.06, 0.09], 0.012, [0.3, 0, 0]));
    k.rbox(KM.paint, [0.15, 0.16, 0.15], 0.014, [0.42, -0.31, -0.42]);
    k.box(KM.seam, [0.152, 0.004, 0.152], [0.42, -0.27, -0.42], [0, 0, 0], { cast: false });
  });
  return (
    <group ref={group} position={[FX, BOAT_LOW, 0]}>
      <Clickable sel={{ kind: 'component', id: 'boat', machine: 'furnace', label: 'Quartz wafer boat' }}>
        <instancedMesh ref={inst} args={[waferGeometry(), boatWaferMat, BOAT_N]} castShadow />
        <ModelView m={boat} />
      </Clickable>
      {/* pedestal + door cap that seals the tube, on the elevator arm */}
      <ModelView m={base} />
      <TechLabel position={[0.25, FOLLOWED * BOAT_PITCH + 0.06, 0.2]} title="WF-000184" min={2} show={() => furnace} />
    </group>
  );
}

function TransferRobot({ furnace, st }: { furnace: boolean; st: MergedModel }) {
  const arm = useRef<THREE.Group>(null);
  const t = useRef(0);
  useFrame((_, dt) => {
    t.current += pdt(dt);
    if (!arm.current) return;
    const loading = furnace && (inPhase('load') || inPhase('unload'));
    // shuttle between FOUP (+z) and boat (-x): one swing per wafer pair
    const s = loading ? 0.5 - 0.5 * Math.cos(t.current * 5) : 0;
    arm.current.rotation.y = lerp(-Math.PI / 2, Math.PI, s * 0.5 + 0.25);
    arm.current.position.y = 0.95 + (loading ? 0.25 * pp('load') : 0);
  });
  // arm: telescoping inner column, link with cover, fork holder and five ceramic forks
  const armModel = useModel((k) => {
    k.cyl(KM.stainless, 0.06, 0.36, [0, -0.17, 0], [0, 0, 0], 28);
    k.cyl(KM.paint, 0.07, 0.05, [0, 0, 0], [0, 0, 0], 32);
    k.rbox(KM.paint, [0.3, 0.045, 0.08], 0.02, [0.15, 0, 0]);
    k.box(KM.seam, [0.26, 0.002, 0.05], [0.15, 0.0225, 0], [0, 0, 0], { cast: false });
    k.cyl(KM.anodizedDark, 0.03, 0.004, [0, 0.026, 0], [0, 0, 0], 20, { cast: false });
    k.rbox(KM.anodizedDark, [0.05, 0.07, 0.07], 0.008, [0.29, 0.02, 0]);
    for (let i = 0; i < 5; i++) k.box(M.ceramic, [0.22, 0.003, 0.06], [0.4, -0.006 + i * 0.013, 0], [0, 0, 0], { cast: false });
    for (let i = 0; i < 5; i++) k.cyl(KM.seam, 0.006, 0.001, [0.47, -0.004 + i * 0.013, 0], [0, 0, 0], 8, { cast: false });
  });
  return (
    <Clickable sel={{ kind: 'component', id: 'transfer', machine: 'furnace', label: 'Wafer transfer robot' }}>
      <ModelPick m={st} tag="transfer" />
      <group position={[FX + 0.45, 0, 0.35]}>
        <group ref={arm} position={[0, 0.95, 0]}>
          <ModelView m={armModel} />
        </group>
      </group>
    </Clickable>
  );
}

/** The live furnace's static model: enclosure, interiors, heater, tube, elevator, gas cabinet, load station, robot base, screen stand. */
function useFurnaceStation() {
  return useModel({
    furnace: (k) =>
      k.at([FX, 0, 0], 0, () => {
        buildFurnaceCabinet(k, true, KM.glass);
        buildFurnaceInterior(k);
        buildFurnacePort(k);
      }),
    heater: (k) => k.at([FX, 0, 0], 0, () => buildHeater(k)),
    tube: (k) => k.at([FX, 0, 0], 0, () => buildTube(k)),
    elevator: (k) => k.at([FX + 0.42, 0, -0.42], 0, () => buildElevator(k)),
    gas: (k) => k.at([FX - 1.05, 0, -0.33], 0, () => buildGasCabinet(k)),
    transfer: (k) => k.at([FX + 0.45, 0, 0.35], 0, () => buildTransferBase(k)),
    _stand: (k) => k.at([FX + 1.35, 0, -0.5], -0.25, () => monitorStand(k, 1.55, 1.75, [0.7, 0.44])),
  });
}

function Furnace({ active }: { active: boolean }) {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  const view = effectiveView(viewRaw, cam);
  const light = useRef<THREE.PointLight>(null);
  const gas = useRef<THREE.Group>(null);
  const glowCut = useMemo(() => clippedOf(heaterGlow) as THREE.MeshStandardMaterial, []);
  useFrame(() => {
    const T = active ? engine.tele.value('temp', 700) : 650;
    heaterGlow.emissiveIntensity = clamp((T - 500) / 500) * 1.4;
    // the cut-away copy of the heater material glows with it
    glowCut.emissiveIntensity = heaterGlow.emissiveIntensity;
    if (light.current) light.current.intensity = clamp((T - 600) / 400) * 2.2;
    if (gas.current) gas.current.visible = active && engine.tele.value('o2', 0) > 1;
  });
  const st = useFurnaceStation();
  return (
    <group>
      <ModelView m={st} view={view} pickable={false} />
      <Clickable sel={{ kind: 'machine', id: 'furnace', label: 'Vertical oxidation furnace' }}>
        <ModelPick m={st} tag="furnace" />
        {/* heater jacket, element and zones */}
        <Clickable sel={{ kind: 'component', id: 'heater', machine: 'furnace', label: 'Multi-zone heater' }}>
          <ModelPick m={st} tag="heater" />
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'tube', machine: 'furnace', label: 'Quartz process tube' }}>
          <ModelPick m={st} tag="tube" />
        </Clickable>
        <pointLight ref={light} position={[FX, 2.8, 0]} color="#ff7a2a" distance={2.4} decay={2} intensity={0} />
        {/* gas cabinet */}
        <Clickable sel={{ kind: 'component', id: 'gas-panel', machine: 'furnace', label: 'Gas panel (O₂ / H₂ / N₂)' }}>
          <ModelPick m={st} tag="gas" />
        </Clickable>
        {/* elevator column */}
        <Clickable sel={{ kind: 'component', id: 'elevator', machine: 'furnace', label: 'Boat elevator' }}>
          <ModelPick m={st} tag="elevator" />
        </Clickable>
        <SignalTower position={[FX + 0.55, 4.06, 0.5]} />
      </Clickable>
      <group ref={gas}>
        <FlowLine points={[[FX - 0.85, 3.3, -0.25], [FX - 0.4, 3.75, -0.25], [FX, 3.75, -0.05], [FX, 3.45, 0], [FX, 2.2, 0]]} color="#cfe3a8" speed={0.8} />
      </group>
      <Boat furnace={active} />
      <TransferRobot furnace={active} st={st} />
      <SensorIndicator id="thermocouple" channel={active ? 'temp' : undefined} machine="furnace" position={[FX + 0.39, 3.0, 0.1]} size={0.05} />
      <SensorIndicator id="mfc" channel={active ? 'o2' : undefined} machine="furnace" position={[FX - 1.05, 3.2, -0.08]} size={0.05} />
      <TechLabel position={[FX - 0.2, 3.75, 0.3]} title="QUARTZ TUBE · MULTI-ZONE HEATER" min={2} value={active ? () => `${engine.tele.value('temp', 0).toFixed(0)} °C · ${engine.player.view.phase.label}` : undefined} />
      <TechLabel position={[FX - 0.5, 1.3, 0.4]} title="QUARTZ BOAT" lines={[`${BOAT_N} wafers · batch process`]} min={3} />
    </group>
  );
}

/* --------------------------------------------- oxidation cross-section */

const OX_MPU = 200e-9 / 1.3;
const siLatMat = new THREE.MeshStandardMaterial({ color: '#9aa3ad', roughness: 0.4, metalness: 0.5 });
const siBulkMat = new THREE.MeshStandardMaterial({ color: '#6c747e', roughness: 0.5, metalness: 0.5 });
const oxMat = new THREE.MeshPhysicalMaterial({ color: '#c7dcc0', roughness: 0.2, metalness: 0, transparent: true, opacity: 0.55 });
const o2Mat = new THREE.MeshStandardMaterial({ color: '#d9775a', roughness: 0.4 });

function OxidationInset() {
  const toxU = () => (engine.tele.value('tox', 0) * 1e-9) / OX_MPU;
  const lattice = useRef<THREE.InstancedMesh>(null);
  const o2 = useRef<THREE.InstancedMesh>(null);
  const cols = 22;
  const rows = 7;
  const sp = 0.05;
  const o = useMemo(() => new THREE.Object3D(), []);
  const seeds = useMemo(() => {
    const r = rng(5);
    return Array.from({ length: 30 }, () => ({ x: r() - 0.5, o: r(), s: 0.6 + r() * 0.8, z: r() * 0.1 - 0.05 }));
  }, []);
  const t = useRef(0);
  useFrame((_, dt) => {
    t.current += pdt(dt);
    const tx = toxU();
    const interface_ = -OXIDE_CONSUMPTION * tx;
    if (lattice.current) {
      // silicon atoms above the moving interface have been consumed into the oxide
      let k = 0;
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const y = -0.02 - j * sp;
          o.position.set(-0.525 + i * sp, y, 0.095);
          o.scale.setScalar(y < interface_ - 0.01 ? 0.012 : 0);
          o.updateMatrix();
          lattice.current.setMatrixAt(k++, o.matrix);
        }
      lattice.current.instanceMatrix.needsUpdate = true;
    }
    if (o2.current) {
      const on = inPhase('oxidize');
      seeds.forEach((s, i) => {
        // O₂ arrives at the surface, diffuses through the oxide, reacts at the Si/SiO₂ interface
        const u = (t.current * 0.5 * s.s + s.o) % 1;
        const y = lerp(0.36, interface_ + 0.01, u);
        o.position.set(s.x + 0.01 * Math.sin(t.current * 6 + i), y, 0.1 + s.z * 0.2);
        o.scale.setScalar(on && y < 0.4 && y > interface_ ? 0.014 : 0);
        o.updateMatrix();
        o2.current!.setMatrixAt(i, o.matrix);
      });
      o2.current.instanceMatrix.needsUpdate = true;
    }
  });
  return (
    <Inset id="ox-section" position={[-0.9, 2.6, 0.75]} size={[1.3, 0.85]} mpu={OX_MPU} schematic={false} title="THERMAL OXIDATION · CROSS-SECTION">
      <group position={[0, 0.02, 0.05]} rotation={[0.16, -0.22, 0]}>
        <LiveProfile depth={0.16} m={siBulkMat} compute={() => rect(-0.55, -0.38, 0.55, -OXIDE_CONSUMPTION * toxU())} />
        <LiveProfile
          depth={0.17}
          m={oxMat}
          compute={() => {
            const tx = toxU();
            if (tx < 0.003) return null;
            return rect(-0.55, -OXIDE_CONSUMPTION * tx, 0.55, (1 - OXIDE_CONSUMPTION) * tx);
          }}
        />
        <instancedMesh ref={lattice} args={[GEO.sphereLow, siLatMat, cols * rows]} frustumCulled={false} />
        <instancedMesh ref={o2} args={[GEO.sphereLow, o2Mat, 30]} frustumCulled={false} />
        <Line points={[[-0.55, 0, 0.1], [0.55, 0, 0.1]]} color="#e9d27a" lineWidth={1.2} dashed dashSize={0.025} gapSize={0.018} />
      </group>
      <TechLabel position={[0.32, 0.06, 0.15]} title="ORIGINAL SURFACE" min={3} />
      <TechLabel position={[-0.62, 0.3, 0.15]} title="SiO₂" min={2} value={() => `${engine.tele.value('tox', 0).toFixed(1)} nm · 44 % below the original surface · SIMULATED`} />
      <TechLabel position={[-0.62, -0.3, 0.15]} title="Si (consumed at the interface)" min={3} />
    </Inset>
  );
}


function DealGroveScreen() {
  const curve = useMemo(() => Array.from({ length: 61 }, (_, i) => 1000 * dealGrove(i / 60, 1000)), []);
  return (
    <group position={[FX + 1.35, 0, -0.5]} rotation={[0, -0.25, 0]}>
      {/* stand: part of the furnace station model */}
      <Screen
        size={[0.7, 0.44]}
        position={[0, 1.75, 0.03]}
        hz={4}
        draw={(g, w, h) => {
          clear(g, w, h, 'DEAL–GROVE · DRY O₂ · 1000 °C · SIMULATED');
          const x = w * 0.08;
          const y = h * 0.36;
          const pw = w * 0.86;
          const ph = h * 0.52;
          plot(g, curve, x, y, pw, ph, 0, 80, SCR.dim);
          const hrs = pp('oxidize');
          const tox = engine.tele.value('tox', 0);
          g.fillStyle = SCR.accent;
          g.beginPath();
          g.arc(x + hrs * pw, y + ph - (tox / 80) * ph, h * 0.025, 0, Math.PI * 2);
          g.fill();
          bigNumber(g, 'OXIDE', tox.toFixed(1), 'nm', w * 0.08, h * 0.19, h * 0.09);
          bigNumber(g, 'TUBE', engine.tele.value('temp', 0).toFixed(0), '°C', w * 0.55, h * 0.19, h * 0.09);
          g.fillStyle = SCR.dim;
          g.font = `${Math.round(h * 0.05)}px monospace`;
          g.fillText('0 h', x, h * 0.97);
          g.fillText('1 h', x + pw - h * 0.08, h * 0.97);
        }}
      />
    </group>
  );
}

/* ================================================================ RTP */

const RX = 4;
const RTP_WAFER_Y = 1.05;
const lampMat = new THREE.MeshStandardMaterial({ color: '#fff1cf', emissive: new THREE.Color('#ffd28a'), emissiveIntensity: 0, roughness: 0.3, toneMapped: false });
const rtpWaferMat = new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.1, metalness: 0.85, emissive: new THREE.Color('#ff5a1a'), emissiveIntensity: 0, toneMapped: false });

/** lamp positions in the head (x, z): centre lamp and four hexagonal rings */
const LAMPS: [number, number][] = (() => {
  const pts: [number, number][] = [];
  for (let r = 0; r <= 4; r++) {
    const n = r === 0 ? 1 : r * 6;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      pts.push([Math.cos(a) * r * 0.042, Math.sin(a) * r * 0.042]);
    }
  }
  return pts;
})();

/**
 * RTP tool body (local to RX): electronics cabinet with deck, rotor-drive housing, water-
 * cooled chamber with flanges, ports and viewport (cut-away shell), slit valve with its
 * actuator, adapter tunnel and a lidded transfer module on its stand; cooling and gas lines.
 */
function buildRtpBody(k: Kit) {
  const o = { shell: true };
  const nc = { cast: false, ...o };
  // electronics / power cabinet with deck plate
  k.at([0, 0, 0], 0, () => {
    k.box(KM.paintGraphite, [1.35, 0.06, 0.95], [0, 0.03, 0]);
    k.rbox(KM.paint, [1.4, 0.69, 1.0], 0.014, [0, 0.405, 0]);
    for (const x of [-0.233, 0.233]) k.box(KM.seam, [0.0045, 0.65, 0.002], [x, 0.405, 0.501], [0, 0, 0], { cast: false });
    k.box(KM.seam, [1.36, 0.0045, 0.002], [0, 0.3, 0.501], [0, 0, 0], { cast: false });
    for (const x of [-0.62, -0.26, -0.21, 0.21, 0.26, 0.62]) for (const y of [0.1, 0.27, 0.33, 0.71]) k.cyl(KM.stainlessDark, 0.0055, 0.004, [x, y, 0.502], [Math.PI / 2, 0, 0], 8, { cast: false });
    for (const x of [-0.466, 0, 0.466]) grille(k, 0.3, 0.13, [x, 0.17, 0.501], { m: KM.paint });
    for (const x of [-0.3, 0.17, 0.64]) k.rbox(KM.anodized, [0.014, 0.12, 0.012], 0.004, [x, 0.52, 0.508]);
    k.label('model', 'RTP-2', 'RAPID THERMAL PROCESSOR · 300 mm', 0.36, 0.09, [-0.0, 0.56, 0.502]);
    k.label('warn', 'HIGH VOLTAGE', '', 0.09, 0.09, [-0.5, 0.56, 0.502]);
    ledStrip(k, 1.1, [0, 0.68, 0.503], KM.ledGreen);
    estop(k, [0.6, 0.62, 0.5]);
    for (const s of [-1, 1]) k.at([s * 0.701, 0.42, 0], [0, (s * Math.PI) / 2, 0], () => grille(k, 0.5, 0.2, [0, 0, 0], { m: KM.paint }));
    k.rbox(KM.paintGraphite, [1.42, 0.025, 1.02], 0.006, [0, 0.7625, 0]);
    k.ao(1.4, 1.0, [0, 0, 0], 1.25);
  });
  // rotor-drive housing and standoffs between the deck and the chamber bottom
  k.cyl(KM.anodizedDark, 0.2, 0.065, [0, 0.8075, 0], [0, 0, 0], 48);
  k.torus(KM.seam, 0.2005, 0.0015, [0, 0.82, 0], [0, 0, 0], 48, { cast: false });
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    k.cyl(KM.stainless, 0.016, 0.065, [Math.cos(a) * 0.27, 0.8075, Math.sin(a) * 0.27], [0, 0, 0], 12);
  }
  // chamber: bottom plate (reflector), machined wall, flanges, cooling coil, ports
  k.cyl(KM.stainlessDark, 0.33, 0.04, [0, 0.86, 0], [0, 0, 0], 64, o);
  k.lathe(KM.stainless, [[0.3, 0.88], [0.32, 0.88], [0.32, 1.13], [0.3, 1.13], [0.3, 0.88]], [0, 0, 0], [0, 0, 0], 64, o);
  ring(k, KM.stainless, 0.3, 0.35, 1.115, 0.02, o);
  ring(k, KM.stainless, 0.3, 0.345, 0.88, 0.02, o);
  boltCircle(k, 0.333, 24, 1.138, 0.006, KM.stainlessDark, nc);
  for (const y of [0.95, 1.04]) k.torus(KM.copper, 0.326, 0.006, [0, y, 0], [0, 0, 0], 64, o);
  k.at([-0.32, 1.0, 0], [0, -Math.PI / 2, 0], () => viewport(k, 0.03, 0.05, o));
  k.at([0, 1.0, -0.32], [0, Math.PI, 0], () => {
    k.cyl(KM.stainless, 0.025, 0.08, [0, 0, 0.04], [Math.PI / 2, 0, 0], 16, o);
    k.cyl(KM.stainlessDark, 0.035, 0.014, [0, 0, 0.08], [Math.PI / 2, 0, 0], 16, o);
  });
  k.pipe(KM.stainless, [[0, 1.0, -0.41], [0, 1.0, -0.48], [0, 0.78, -0.48]], 0.012, 0.04);
  // slit valve, its pneumatic actuator, adapter tunnel to the transfer module
  k.rbox(KM.stainless, [0.12, 0.2, 0.4], 0.01, [0.38, 1.0, 0], [0, 0, 0], o);
  k.box(KM.seam, [0.122, 0.004, 0.3], [0.38, 1.05, 0], [0, 0, 0], nc);
  k.cyl(KM.anodized, 0.03, 0.14, [0.38, 0.83, 0], [0, 0, 0], 20);
  k.cyl(KM.stainless, 0.008, 0.04, [0.38, 0.92, 0], [0, 0, 0], 8);
  k.rbox(KM.stainless, [0.21, 0.12, 0.36], 0.008, [0.545, 1.05, 0], [0, 0, 0], o);
  // transfer module: frame, walls, glass lid, wafer support pins
  const tx = 0.95;
  for (const [x, z] of [[-0.27, -0.27], [-0.27, 0.27], [0.27, -0.27], [0.27, 0.27]] as const) {
    k.rbox(KM.paintGrey, [0.04, 0.72, 0.04], 0.006, [tx + x, 0.38, z]);
    k.cyl(KM.rubber, 0.025, 0.015, [tx + x, 0.0075, z], [0, 0, 0], 12, { cast: false });
  }
  for (const s of [-1, 1]) k.box(KM.paintGrey, [0.5, 0.03, 0.03], [tx, 0.18, s * 0.27]);
  k.rbox(KM.paintGrey, [0.62, 0.03, 0.62], 0.006, [tx, 0.74, 0]);
  k.rbox(KM.stainlessDark, [0.6, 0.04, 0.6], 0.008, [tx, 0.77, 0], [0, 0, 0], o);
  for (const s of [-1, 1]) {
    k.box(KM.paint, [0.6, 0.36, 0.02], [tx, 0.97, s * 0.29], [0, 0, 0], o);
    k.box(KM.paint, [0.02, 0.36, 0.56], [tx + s * 0.29, 0.97, 0], [0, 0, 0], o);
  }
  k.box(KM.seam, [0.4, 0.004, 0.002], [tx, 1.1, 0.3005], [0, 0, 0], nc);
  // lid: frame with a viewing glass and clamp bolts
  for (const s of [-1, 1]) {
    k.box(KM.stainless, [0.62, 0.02, 0.09], [tx, 1.16, s * 0.265], [0, 0, 0], o);
    k.box(KM.stainless, [0.09, 0.02, 0.44], [tx + s * 0.265, 1.16, 0], [0, 0, 0], o);
  }
  k.box(KM.glass, [0.46, 0.006, 0.46], [tx, 1.163, 0], [0, 0, 0], { cast: false, ...o });
  for (const [x, z] of [[-1, -1], [-1, 1], [1, -1], [1, 1], [0, -1], [0, 1]] as const) k.cyl(KM.stainlessDark, 0.01, 0.012, [tx + x * 0.265, 1.176, z * 0.265], [0, 0, 0], 6, nc);
  for (let i = 0; i < 3; i++) {
    const a = (i * 2 * Math.PI) / 3;
    k.cyl(KM.ptfe, 0.006, 0.25, [0.75 + Math.cos(a) * 0.08, 0.915, Math.sin(a) * 0.08], [0, 0, 0], 8, { cast: false });
  }
  plate(k, 'info', 'TM', 'TRANSFER MODULE · N₂', 0.14, 0.035, [tx, 0.97, 0.301], o);
  k.ao(0.62, 0.62, [tx, 0, 0], 1.3);
  // cooling water to the lamp head and chamber (blue supply, red return), N₂ purge line
  hose(k, [-0.4, 0.78, -0.3], [-0.3, 1.36, -0.24], 0.014, -0.05, KM.paintBlue);
  hose(k, [-0.45, 0.78, -0.24], [-0.33, 1.4, -0.12], 0.014, -0.05, KM.paintRed);
  k.pipe(KM.stainless, [[0.15, 0.78, -0.42], [0.15, 0.95, -0.42], [0.15, 0.95, -0.33]], 0.008, 0.04);
  k.label('gas', 'N₂', '', 0.08, 0.02, [0.15, 0.86, -0.41], [0, 0, 0], '#2f5d8a');
}

/** Lamp head: water-cooled housing (cut-away shell), top cover with connectors, cooling fittings, hinge and struts; reflector and lamp sockets inside. */
function buildLampHead(k: Kit) {
  const o = { shell: true };
  const nc = { cast: false, ...o };
  k.lathe(KM.paint, [[0.32, 1.18], [0.34, 1.18], [0.34, 1.46], [0.32, 1.46], [0.32, 1.18]], [0, 0, 0], [0, 0, 0], 64, o);
  for (const y of [1.24, 1.32, 1.4]) k.torus(KM.seam, 0.3405, 0.0018, [0, y, 0], [0, 0, 0], 64, nc);
  ring(k, KM.paintGrey, 0.3, 0.346, 1.18, 0.022, o);
  k.cyl(KM.paintGrey, 0.35, 0.04, [0, 1.47, 0], [0, 0, 0], 64, o);
  ring(k, KM.paintGraphite, 0.3, 0.352, 1.49, 0.012, o);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    k.cyl(KM.stainlessDark, 0.006, 0.006, [Math.cos(a) * 0.33, 1.5, Math.sin(a) * 0.33], [0, 0, 0], 6, nc);
  }
  // power connectors, cooling-water fittings, lifting handles on the cover
  for (let i = 0; i < 3; i++) {
    const a = 0.5 + (i * 2 * Math.PI) / 3;
    k.at([Math.cos(a) * 0.2, 1.52, Math.sin(a) * 0.2], -a, () => {
      k.rbox(KM.paintGraphite, [0.09, 0.05, 0.06], 0.008, [0, 0, 0]);
      k.cyl(KM.anodized, 0.012, 0.03, [0.055, 0, 0], [0, 0, Math.PI / 2], 12);
    });
  }
  for (const [x, z, m] of [[-0.3, -0.24, KM.paintBlue], [-0.33, -0.12, KM.paintRed]] as const) {
    k.cyl(KM.brass, 0.014, 0.05, [x, 1.4, z], [0, 0, Math.PI / 2], 12, o);
    k.cyl(m, 0.016, 0.02, [x - 0.03, 1.4, z], [0, 0, Math.PI / 2], 12, o);
  }
  for (const s of [-1, 1]) {
    k.box(KM.stainless, [0.012, 0.05, 0.012], [0.1, 1.515, s * 0.12], [0, 0, 0]);
    k.box(KM.stainless, [0.012, 0.05, 0.012], [-0.1, 1.515, s * 0.12], [0, 0, 0]);
    k.cyl(KM.stainless, 0.008, 0.2, [0, 1.54, s * 0.12], [0, 0, Math.PI / 2], 10);
  }
  // clamshell hinge at the back and the two gas struts that hold the head open
  k.rbox(KM.paintGraphite, [0.06, 0.06, 0.3], 0.008, [-0.37, 1.18, 0]);
  k.cyl(KM.stainless, 0.012, 0.34, [-0.37, 1.18, 0], [Math.PI / 2, 0, 0], 12);
  for (const s of [-1, 1]) {
    k.cyl(KM.paintGraphite, 0.014, 0.22, [-0.39, 0.89, s * 0.2], [0, 0, 0], 12);
    k.cyl(KM.stainless, 0.006, 0.26, [-0.39, 1.12, s * 0.2], [0, 0, 0], 8);
    k.rbox(KM.paintGraphite, [0.04, 0.03, 0.03], 0.006, [-0.37, 1.26, s * 0.2]);
  }
  plate(k, 'warn', 'HOT SURFACE', '', 0.07, 0.07, [0, 1.32, 0.3405], o);
  // inside: gold reflector and lamp sockets above the lamps
  k.cyl(KM.brass, 0.315, 0.012, [0, 1.296, 0], [0, 0, 0], 64);
  for (const [x, z] of LAMPS) k.cyl(KM.paintGraphite, 0.012, 0.03, [x, 1.317, z], [0, 0, 0], 8, { cast: false });
}

/** Pyrometers: sapphire light pipes through the bottom reflector, heads below, fibres to the cabinet. */
function buildPyrometers(k: Kit) {
  for (const x of [-0.1, 0, 0.1]) {
    const z = x === 0 ? 0.05 : -0.04;
    k.cyl(M.black, 0.012, 0.08, [x, 0.92, z], [0, 0, 0], 16);
    k.cyl(KM.glassSmoke, 0.006, 0.004, [x, 0.962, z], [0, 0, 0], 12, { cast: false });
    k.cyl(KM.anodizedDark, 0.018, 0.05, [x, 0.815, z], [0, 0, 0], 16);
  }
  hose(k, [-0.1, 0.79, -0.04], [-0.55, 0.78, 0.2], 0.005, 0.02, KM.paintYellow);
  hose(k, [0.1, 0.79, -0.04], [-0.55, 0.78, 0.22], 0.005, 0.02, KM.paintYellow);
}

function useRtpStation() {
  return useModel({
    rtp: (k) => k.at([RX, 0, 0], 0, () => buildRtpBody(k)),
    lamps: (k) => k.at([RX, 0, 0], 0, () => buildLampHead(k)),
    pyrometers: (k) => k.at([RX, 0, 0], 0, () => buildPyrometers(k)),
    _stand: (k) => k.at([RX + 1.3, 0, -0.6], -0.4, () => monitorStand(k, 1.25, 1.42, [0.62, 0.4])),
  });
}

function RTP({ active }: { active: boolean }) {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  const view = effectiveView(viewRaw, cam);
  const lampRef = useRef<THREE.InstancedMesh>(null);
  const wafer = useRef<THREE.Mesh>(null);
  const light = useRef<THREE.PointLight>(null);
  useEffect(() => {
    if (!lampRef.current) return;
    const o = new THREE.Object3D();
    LAMPS.forEach(([x, z], i) => {
      o.position.set(x, 0, z);
      o.scale.set(0.016, 0.09, 0.016);
      o.updateMatrix();
      lampRef.current!.setMatrixAt(i, o.matrix);
    });
    lampRef.current.instanceMatrix.needsUpdate = true;
  }, []);
  useFrame(() => {
    const lamp = active ? engine.tele.value('lamp', 0) / 100 : 0;
    lampMat.emissiveIntensity = 0.1 + lamp * 3;
    if (light.current) light.current.intensity = lamp * 3;
    const T = active ? engine.tele.value('temp', 25) : 25;
    rtpWaferMat.emissiveIntensity = clamp((T - 600) / 450) * 1.2;
    if (wafer.current) {
      // slides in through the slit valve from the transfer side, out again at the end
      const inP = active ? smooth(pp('load')) : 0;
      const outP = active ? smooth(pp('unload')) : 0;
      const x = RX + 0.75 * (1 - inP) + 0.75 * outP;
      wafer.current.position.set(x, RTP_WAFER_Y, 0);
      wafer.current.visible = active;
      if (active) track('focus', x, RTP_WAFER_Y, 0);
    }
  });
  const st = useRtpStation();
  return (
    <group>
      <ModelView m={st} view={view} pickable={false} />
      <Clickable sel={{ kind: 'machine', id: 'rtp', label: 'Rapid thermal processing chamber' }}>
        <ModelPick m={st} tag="rtp" />
        {/* lamp head */}
        <Clickable sel={{ kind: 'component', id: 'lamps', machine: 'rtp', label: 'Lamp array' }}>
          <ModelPick m={st} tag="lamps" />
          <instancedMesh ref={lampRef} args={[GEO.cylLow, lampMat, LAMPS.length]} position={[RX, 1.24, 0]} />
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'window', machine: 'rtp', label: 'Quartz window' }}>
          <mesh position={[RX, 1.16, 0]} material={M.quartz}>
            <cylinderGeometry args={[0.31, 0.31, 0.012, 48]} />
          </mesh>
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'edge-ring', machine: 'rtp', label: 'Edge ring' }}>
          <mesh position={[RX, RTP_WAFER_Y - 0.003, 0]} rotation={[-Math.PI / 2, 0, 0]} material={M.graphite}>
            <ringGeometry args={[0.145, 0.175, 48]} />
          </mesh>
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'pyrometers', machine: 'rtp', label: 'Pyrometers' }}>
          <ModelPick m={st} tag="pyrometers" />
        </Clickable>
        <SignalTower position={[RX - 0.6, 0.75, 0.42]} />
      </Clickable>
      <mesh ref={wafer} geometry={waferGeometry()} material={rtpWaferMat} castShadow />
      <pointLight ref={light} position={[RX, 1.12, 0]} color="#ffcf8a" distance={1.6} decay={2} intensity={0} />
      <SensorIndicator id="pyrometer" channel={active ? 'temp' : undefined} machine="rtp" position={[RX + 0.12, 0.9, 0.2]} size={0.04} />
      <TechLabel position={[RX + 0.35, 1.5, 0.2]} title="LAMP ARRAY → WAFER" min={2} value={active ? () => `${engine.tele.value('temp', 0).toFixed(0)} °C · lamps ${engine.tele.value('lamp', 0).toFixed(0)} %` : undefined} />
    </group>
  );
}

/* ---------------------------------------- dopant activation (lattice) */

const ACT_MPU = 3e-9 / 1.2; // a few lattice constants
const siAtom = new THREE.MeshStandardMaterial({ color: '#9aa3ad', roughness: 0.4, metalness: 0.4 });
const dopAtom = new THREE.MeshStandardMaterial({ color: '#e0a64a', roughness: 0.35, emissive: new THREE.Color('#5a3a0a'), emissiveIntensity: 0.5 });

function ActivationInset() {
  const cols = 13;
  const rows = 7;
  const sp = 0.085;
  const si = useRef<THREE.InstancedMesh>(null);
  const dp = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const data = useMemo(() => {
    const r = rng(31);
    const jitter = Array.from({ length: cols * rows }, () => [r() - 0.5, r() - 0.5] as [number, number]);
    // dopants: start at interstitial positions, end on substitutional lattice sites
    const sites = [14, 18, 22, 29, 33, 41, 45, 50].map((k) => k % (cols * rows));
    const dop = sites.map((k) => ({ site: k, ix: (r() - 0.5) * sp, iy: (r() - 0.5) * sp }));
    return { jitter, dop };
  }, []);
  const pos = (k: number) => [-((cols - 1) * sp) / 2 + (k % cols) * sp, ((rows - 1) * sp) / 2 - Math.floor(k / cols) * sp] as const;
  useFrame(() => {
    const act = clamp(engine.tele.value('active', 0) / 100);
    const disorder = 1 - act; // implant damage heals as the lattice recrystallises
    if (si.current) {
      for (let k = 0; k < cols * rows; k++) {
        const [x, y] = pos(k);
        const row = Math.floor(k / cols);
        const dmg = row < 3 ? disorder * 0.5 * sp : 0;
        const occupied = data.dop.some((d) => d.site === k) && act > 0.6;
        o.position.set(x + data.jitter[k][0] * dmg, y + data.jitter[k][1] * dmg, 0);
        o.scale.setScalar(occupied ? 0 : 0.026);
        o.updateMatrix();
        si.current.setMatrixAt(k, o.matrix);
      }
      si.current.instanceMatrix.needsUpdate = true;
    }
    if (dp.current) {
      data.dop.forEach((d, i) => {
        const [x, y] = pos(d.site);
        const u = smooth(clamp((act - 0.15) / 0.6));
        o.position.set(x + sp / 2 + d.ix * 0.4 - (sp / 2 + d.ix * 0.4) * u, y + sp / 2 + d.iy * 0.4 - (sp / 2 + d.iy * 0.4) * u, 0.01);
        o.scale.setScalar(0.03);
        o.updateMatrix();
        dp.current!.setMatrixAt(i, o.matrix);
      });
      dp.current.instanceMatrix.needsUpdate = true;
    }
  });
  return (
    <Inset id="rtp-lattice" position={[5.85, 1.9, 0.65]} size={[1.2, 0.8]} mpu={ACT_MPU} title="DOPANT ACTIVATION · LATTICE (SCHEMATIC)">
      <instancedMesh ref={si} args={[GEO.sphereLow, siAtom, cols * rows]} frustumCulled={false} />
      <instancedMesh ref={dp} args={[GEO.sphereLow, dopAtom, data.dop.length]} frustumCulled={false} />
      <TechLabel position={[-0.58, -0.32, 0.05]} title="DOPANT → LATTICE SITE" min={2} value={() => `activation ${engine.tele.value('active', 0).toFixed(0)} % · SIMULATED`} />
    </Inset>
  );
}


function RtpScreen() {
  return (
    <group position={[RX + 1.3, 0, -0.6]} rotation={[0, -0.4, 0]}>
      {/* stand: part of the RTP station model */}
      <Screen
        size={[0.62, 0.4]}
        position={[0, 1.42, 0.03]}
        hz={5}
        draw={(g, w, h) => {
          clear(g, w, h, 'RTP · WAFER TEMPERATURE · SIMULATED');
          const c = engine.tele.get('temp');
          plot(g, c ? c.series().slice(-200) : [], w * 0.06, h * 0.38, w * 0.88, h * 0.5, 0, 1200, SCR.data);
          bigNumber(g, 'PYROMETER', engine.tele.value('temp', 0).toFixed(0), '°C', w * 0.06, h * 0.19, h * 0.1);
          bigNumber(g, 'ACTIVATION', engine.tele.value('active', 0).toFixed(0), '%', w * 0.56, h * 0.19, h * 0.1);
        }}
      />
    </group>
  );
}

/* ================================================================ scene */

/** Neighbouring furnaces in the diffusion bay: one merged model for both. */
function NeighbourFurnaces() {
  const m = useModel((k) => {
    for (const x of [-5.2, -6.8]) k.at([x, 0, 0], 0, () => buildNeighbourFurnace(k));
  });
  return (
    <>
      <ModelView m={m} pickable={false} />
      {[-5.2, -6.8].map((x) => (
        <SignalTower key={x} position={[x + 0.55, 4.06, 0.5]} />
      ))}
    </>
  );
}

export default function ThermalScene({ stage }: SceneProps) {
  const rtp = stage.variant === 'rtp';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0;
  }, []);
  return (
    <>
      <Lighting env="cleanroom" shadowExtent={7} />
      <CleanroomBay width={16} depth={9} height={4.4} />
      <Furnace active={!rtp} />
      <RTP active={rtp} />
      {!rtp && <OxidationInset />}
      {!rtp && <DealGroveScreen />}
      {rtp && <ActivationInset />}
      {rtp && <RtpScreen />}
      {/* neighbouring furnaces in the diffusion bay */}
      <NeighbourFurnaces />
      <Operator position={[0.6, 0, 1.8]} rotation={-Math.PI * 0.6} still />
    </>
  );
}
