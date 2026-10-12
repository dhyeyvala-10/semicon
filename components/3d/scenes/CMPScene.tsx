'use client';
/**
 * Chemical mechanical planarization (§31): a rotating platen with a grooved pad, a carrier
 * head pressing the wafer face-down, slurry, pad conditioner and a post-CMP brush cleaner.
 * Removal follows Preston (rate ∝ pressure × velocity): high points go first, so the step
 * height decays while the stop layer (nitride) ends the polish.
 * The cross-section has a draggable before / after divider.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Lighting, CleanroomBay } from '../environments';
import { effectiveView } from '../materials';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Inset, LiveProfile, ProfileSlab } from '../parts/section';
import { waferGeometry, useModel, ModelView, ModelPick } from '../parts/wafer';
import { Screen, clear, plot, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { Kit, type PartOpts, cabinet, bellows, boltCircle, grille, gasStick, estop, ledStrip } from '../kit/build';
import { KM } from '../kit/finish';
import { engine } from '@/simulation/engine';
import { pp, inPhase, pdt } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { clamp, lerp, smooth, rng } from '@/lib/math';

const PAD_Y = 0.856;
const PLATEN_R = 0.4;
const POLISH = new THREE.Vector3(0.17, PAD_Y + 0.0012, 0.04);
const LOAD_CUP = new THREE.Vector3(0.85, 0.9, 0.62);
const CLEAN = new THREE.Vector3(-1.55, 1.12, 0);
const OUT = new THREE.Vector3(-1.55, 0.95, 0.75);

/* ---------------------------------------------------------------- textures */

function padTexture() {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#cbbd92';
  g.fillRect(0, 0, S, S);
  const r = rng(4);
  for (let i = 0; i < 4000; i++) {
    g.fillStyle = `rgba(90,80,50,${0.05 + r() * 0.08})`;
    g.fillRect(r() * S, r() * S, 1.5, 1.5);
  }
  g.strokeStyle = 'rgba(70,62,40,0.55)';
  g.lineWidth = 1.4;
  for (let k = 8; k < S / 2; k += 9) {
    g.beginPath();
    g.arc(S / 2, S / 2, k, 0, Math.PI * 2);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/* ---------------------------------------------------------------- motion */

const P = new THREE.Vector3();
/** Wafer (and carrier head) position: load cup → platen → cleaner → output. */
function waferPos(): { p: THREE.Vector3; faceDown: number; vertical: number } {
  const ld = smooth(pp('load'));
  const cl = smooth(pp('clean'));
  const un = smooth(pp('unload'));
  P.copy(LOAD_CUP).lerp(POLISH, ld);
  P.y += Math.sin(Math.PI * ld) * 0.2;
  let faceDown = ld;
  let vertical = 0;
  if (inPhase('polish') || inPhase('endpoint')) P.x += 0.07 * Math.sin(engine.time * 1.1); // head sweep
  if (cl > 0) {
    P.lerp(CLEAN, cl);
    P.y += Math.sin(Math.PI * cl) * 0.25;
    faceDown = 1 - cl;
    vertical = cl;
  }
  if (un > 0) {
    P.lerp(OUT, un);
    vertical = 1 - un;
  }
  return { p: P, faceDown, vertical };
}

/* ---------------------------------------------------------------- polisher (kit) */
/*
 * Static equipment is built with the detailing kit and merged per finish for the whole bay
 * (polisher base and enclosure, basin, load cup, slurry arm, conditioner column, swing-arm
 * column, post-CMP cleaner, output stage, screen stand and the two neighbouring polishers):
 * one mesh per finish plus one shadow caster, with invisible pick proxies for each component's
 * Clickable. Moving parts (platen, carrier head, conditioner arm, brush rollers) are their own
 * small kit models; the head's swing arm and carriage follow the head every frame.
 */

const HP = Math.PI / 2;
/** top of the polisher base deck */
const DECK = 0.802;
/** underside of the head swing arm */
const ARM_Y = 1.98;
/** swing-arm axis: equidistant from the load cup and the polish position */
const PIVOT = new THREE.Vector3(1.13, 0, -0.39);
const SH: PartOpts = { shell: true };
const CORNERS: [number, number][] = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

/**
 * Metal finishes with some diffuse response: the bay's environment is dark at the horizon,
 * so fully metallic vertical surfaces read black (same brushed maps as the kit finishes).
 */
const VS = (() => {
  const m = KM.stainless.clone();
  m.metalness = 0.55;
  m.roughness = 0.34;
  return m;
})();
const VA = (() => {
  const m = KM.anodized.clone();
  m.metalness = 0.5;
  m.roughness = 0.42;
  return m;
})();

let _pva: THREE.MeshStandardMaterial | null = null;
/** PVA sponge brush with moulded nodules (shows the roller spin). */
function pvaMat() {
  if (_pva) return _pva;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d9e3ea';
  g.fillRect(0, 0, 128, 64);
  g.fillStyle = '#9fb3c2';
  for (let j = 0; j < 4; j++)
    for (let i = 0; i < 8; i++) {
      g.beginPath();
      g.arc(i * 16 + 8 + (j % 2) * 8, j * 16 + 8, 4.5, 0, Math.PI * 2);
      g.fill();
    }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 5);
  _pva = new THREE.MeshStandardMaterial({ map: t, roughness: 0.95, metalness: 0 });
  return _pva;
}

/** Deck plate with a round opening (basin around the platen), top at y. */
function deckPlate(k: Kit, m: THREE.Material, w: number, d: number, cx: number, cz: number, holeR: number, y: number, t = 0.006) {
  // shape in (x, −z); rotating −90° about X extrudes it upward (+Y)
  const s = new THREE.Shape([new THREE.Vector2(cx - w / 2, -cz - d / 2), new THREE.Vector2(cx + w / 2, -cz - d / 2), new THREE.Vector2(cx + w / 2, -cz + d / 2), new THREE.Vector2(cx - w / 2, -cz + d / 2)]);
  const hole = new THREE.Path();
  hole.absarc(0, 0, holeR, 0, Math.PI * 2, true);
  s.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 32 });
  k.add(m, g, [0, y - t, 0], [-HP, 0, 0], [1, 1, 1], { cast: false });
  g.dispose();
}

/** Floor stand for a monitor: base plate, pole, VESA bracket and the screen's rear housing. */
function monitorStand(k: Kit, pole: number, screenY: number, size: [number, number]) {
  k.rbox(KM.paintGraphite, [0.4, 0.02, 0.32], 0.006, [0, 0.01, 0]);
  k.cyl(VA, 0.03, 0.03, [0, 0.035, 0], [0, 0, 0], 20);
  k.cyl(VA, 0.022, pole, [0, pole / 2, 0], [0, 0, 0], 16);
  k.rbox(KM.anodizedDark, [0.12, 0.1, 0.04], 0.008, [0, screenY, 0.0]);
  k.rbox(KM.plastic, [size[0] + 0.03, size[1] + 0.03, 0.03], 0.01, [0, screenY, 0.012]);
  k.ao(0.4, 0.32, [0, 0, 0], 1.5);
}

/** Polisher base: cabinet, grey splash deck with the basin, splash guard, drain, front controls. */
function buildBase(k: Kit, live = true) {
  k.at([0.1, 0, 0], 0, () => cabinet(k, { size: [2.4, 0.78, 2.0], panels: 3, rows: [0.3], sidePanels: 2, handles: true }));
  deckPlate(k, KM.paintGrey, 2.38, 1.98, 0.1, 0, 0.452, DECK + 0.006);
  // basin floor and the splash guard round the platen
  k.cyl(KM.paintGraphite, 0.452, 0.012, [0, DECK - 0.006, 0], [0, 0, 0], 64);
  k.lathe(KM.plasticWhite, [[0.43, DECK], [0.472, DECK], [0.472, 0.905], [0.458, 0.922], [0.436, 0.918], [0.43, 0.9], [0.43, DECK]], [0, 0, 0], [0, 0, 0], 72);
  k.torus(KM.paintGraphite, 0.472, 0.004, [0, 0.88, 0], [0, 0, 0], 72, { cast: false });
  if (!live) return;
  // front controls: model plate, warnings, EMO, status strip, platen-drive status panel
  const zf = 1.002;
  k.label('model', 'CMP-4', 'CHEMICAL MECHANICAL PLANARIZER · 300 mm', 0.52, 0.11, [-0.68, 0.6, zf]);
  k.label('warn', 'ROTATING PARTS', '', 0.1, 0.1, [-0.1, 0.6, zf]);
  estop(k, [1.15, 0.6, 1.0]);
  ledStrip(k, 0.45, [0.85, 0.71, zf]);
  k.rbox(KM.plastic, [0.14, 0.08, 0.01], 0.004, [0.3, 0.7, 1.005]);
  for (let i = 0; i < 3; i++) k.box(i ? KM.seam : KM.ledGreen, [0.016, 0.008, 0.003], [0.26 + i * 0.04, 0.715, 1.011], [0, 0, 0], { cast: false });
  k.box(KM.screen, [0.1, 0.022, 0.002], [0.3, 0.688, 1.011], [0, 0, 0], { cast: false });
}

/** Load cup (pusher): shallow cup with rim, alignment pins and a DI rinse ring. */
function buildLoadCup(k: Kit) {
  k.at([LOAD_CUP.x, 0, LOAD_CUP.z], 0, () => {
    k.cyl(VA, 0.19, 0.012, [0, DECK + 0.006, 0], [0, 0, 0], 48);
    k.lathe(KM.plasticWhite, [[0, DECK + 0.012], [0.168, DECK + 0.012], [0.172, 0.884], [0.166, 0.892], [0.156, 0.889], [0.152, 0.866], [0, 0.866]], [0, 0, 0], [0, 0, 0], 56);
    k.cyl(KM.plastic, 0.1, 0.018, [0, 0.875, 0], [0, 0, 0], 40);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.4;
      k.cyl(KM.chrome, 0.006, 0.03, [Math.cos(a) * 0.158, 0.885, Math.sin(a) * 0.158], [0, 0, 0], 10, { cast: false });
    }
    k.torus(VS, 0.162, 0.005, [0, 0.872, 0], [0, 0, 0], 48, { cast: false });
    k.pipe(VS, [[0.17, 0.872, 0], [0.24, 0.872, 0], [0.24, DECK + 0.01, 0]], 0.006, 0.02);
  });
}

/** Swing-arm column: drive housing on the deck, bellows boot, column, bearing housing. */
function buildArmColumn(k: Kit) {
  k.at([PIVOT.x, 0, PIVOT.z], 0, () => {
    k.rbox(KM.paint, [0.3, 0.32, 0.3], 0.02, [0, DECK + 0.16, 0]);
    k.box(KM.seam, [0.302, 0.004, 0.302], [0, DECK + 0.26, 0], [0, 0, 0], { cast: false });
    k.label('warn', 'PINCH POINT', '', 0.08, 0.08, [0, DECK + 0.15, 0.151]);
    bellows(k, 0.1, 0.16, 8, [0, DECK + 0.32, 0], KM.rubber);
    k.cyl(VS, 0.085, ARM_Y - 0.05 - (DECK + 0.48), [0, (DECK + 0.48 + ARM_Y - 0.05) / 2, 0], [0, 0, 0], 32);
    k.cyl(VA, 0.12, 0.05, [0, ARM_Y - 0.025, 0], [0, 0, 0], 40);
    boltCircle(k, 0.1, 10, ARM_Y - 0.001, 0.007);
  });
}

/** Slurry arm: rotary actuator, post, arm housing with PFA delivery lines and the nozzle block. */
function buildSlurryArm(k: Kit) {
  k.rbox(KM.paint, [0.14, 0.12, 0.14], 0.012, [-0.55, DECK + 0.06, -0.42]);
  k.cyl(VS, 0.025, 1.06 - DECK - 0.12, [-0.55, (DECK + 0.12 + 1.06) / 2, -0.42], [0, 0, 0], 20);
  k.cyl(VA, 0.034, 0.05, [-0.55, 1.06, -0.42], [0, 0, 0], 20);
  k.at([-0.32, 1.06, -0.24], [0, -0.68, 0], () => {
    k.rbox(KM.plasticWhite, [0.52, 0.034, 0.046], 0.01, [0, 0, 0]);
    for (let i = 0; i < 3; i++) k.cyl(KM.ptfe, 0.0045, 0.5, [-0.01, 0.021, -0.012 + i * 0.012], [0, 0, HP], 8, { cast: false });
    k.rbox(KM.plasticWhite, [0.06, 0.044, 0.064], 0.01, [0.26, -0.006, 0]);
    for (let i = 0; i < 3; i++) k.cyl(KM.ptfe, 0.004, 0.012, [0.265, -0.032, -0.016 + i * 0.016], [0, 0, 0], 8, { cast: false });
  });
  // supply lines from the back-wall manifold to the arm base
  for (let i = 0; i < 2; i++) k.tube(KM.ptfe, [[-0.5 + i * 0.03, DECK + 0.1, -0.48], [-0.48 + i * 0.03, DECK + 0.14, -0.7], [-0.45 + i * 0.03, 1.1, -0.93], [-0.42 + i * 0.03, 1.36, -0.955]], 0.006, { radial: 6 });
}

/** Pad conditioner column: drive housing, bellows boot, column (the arm on top swings). */
function buildConditioner(k: Kit) {
  k.rbox(KM.paint, [0.16, 0.14, 0.16], 0.015, [0.62, DECK + 0.07, -0.5]);
  bellows(k, 0.04, 0.08, 5, [0.62, DECK + 0.14, -0.5], KM.rubber);
  k.cyl(VS, 0.03, 1.04 - (DECK + 0.22), [0.62, (DECK + 0.22 + 1.04) / 2, -0.5], [0, 0, 0], 20);
}

/**
 * Enclosure round the polishing area: corner posts and top frame, back wall with the slurry
 * manifold and head-pressure (EPR) panel, side walls with windows, sliding glass front doors
 * (cut away in the internal view), exhaust plenum and duct.
 */
function buildEnclosure(k: Kit, live = true) {
  const x0 = -1.1;
  const x1 = 1.3;
  const z0 = -1.0;
  const z1 = 1.0;
  const yt = 2.35;
  const cx = (x0 + x1) / 2;
  const W = x1 - x0;
  const D = z1 - z0;
  for (const [x, z] of [[x0 + 0.03, z0 + 0.03], [x1 - 0.03, z0 + 0.03], [x0 + 0.03, z1 - 0.03], [x1 - 0.03, z1 - 0.03]] as const)
    k.rbox(KM.paint, [0.06, yt - DECK, 0.06], 0.012, [x, (DECK + yt) / 2, z]);
  for (const z of [z0 + 0.03, z1 - 0.03]) k.rbox(KM.paint, [W, 0.08, 0.06], 0.012, [cx, yt - 0.04, z]);
  for (const x of [x0 + 0.03, x1 - 0.03]) k.rbox(KM.paint, [0.06, 0.08, D], 0.012, [x, yt - 0.04, 0]);
  // back wall
  k.rbox(KM.paint, [W - 0.12, yt - DECK - 0.08, 0.025], 0.008, [cx, (DECK + yt - 0.08) / 2, z0 + 0.0125]);
  for (const x of [-0.3, 0.5]) k.box(KM.seam, [0.0045, yt - DECK - 0.12, 0.002], [x, (DECK + yt - 0.08) / 2, z0 + 0.026], [0, 0, 0], { cast: false });
  k.box(KM.seam, [W - 0.16, 0.0045, 0.002], [cx, 1.6, z0 + 0.026], [0, 0, 0], { cast: false });
  // side walls: solid lower panel, framed window above; the cleaner side has the wafer
  // transfer slot (shutter frame) the wafer passes on its way to the brush box
  const inner = D - 0.12;
  for (const s of [-1, 1]) {
    const x = s < 0 ? x0 + 0.03 : x1 - 0.03;
    const top = s < 0 && live ? 1.47 : DECK + 0.55;
    if (s < 0 && live) {
      const sy0 = 1.06;
      const sz = 0.22;
      k.rbox(KM.paint, [0.02, sy0 - DECK, inner], 0.006, [x, (DECK + sy0) / 2, 0]);
      for (const zz of [-1, 1]) k.rbox(KM.paint, [0.02, top - sy0, inner / 2 - sz], 0.006, [x, (sy0 + top) / 2, zz * (sz + (inner / 2 - sz) / 2)]);
      for (const zz of [-1, 1]) k.box(KM.anodizedDark, [0.05, top - sy0, 0.02], [x, (sy0 + top) / 2, zz * (sz + 0.01)]);
      k.box(KM.anodizedDark, [0.05, 0.02, 2 * sz + 0.04], [x, sy0 + 0.01, 0]);
      k.rbox(KM.anodizedDark, [0.06, 0.08, 2 * sz + 0.06], 0.01, [x, top - 0.04, 0]);
      k.box(KM.ledGreen, [0.004, 0.012, 0.04], [x + 0.031, top - 0.04, 0.18], [0, 0, 0], { cast: false });
    } else k.rbox(KM.paint, [0.02, 0.5, inner], 0.006, [x, DECK + 0.25, 0]);
    k.rbox(KM.paint, [0.04, 0.05, inner], 0.008, [x, top - 0.025, 0]);
    k.rbox(KM.paint, [0.04, 0.04, inner], 0.008, [x, yt - 0.1, 0]);
    k.box(KM.glass, [0.008, yt - 0.12 - top, inner], [x, (top + yt - 0.12) / 2, 0], [0, 0, 0], { cast: false });
  }
  // sliding glass front doors (two leaves on staggered tracks)
  const dy0 = DECK + 0.02;
  const dy1 = yt - 0.08;
  for (const [i, z] of [[0, z1 - 0.02], [1, z1 - 0.055]] as const) {
    const a = i === 0 ? x0 + 0.06 : cx - 0.04;
    const b = i === 0 ? cx + 0.04 : x1 - 0.06;
    const w = b - a;
    const m = (a + b) / 2;
    k.rbox(KM.paint, [w, 0.06, 0.03], 0.008, [m, dy1 - 0.03, z], [0, 0, 0], SH);
    k.rbox(KM.paint, [w, 0.1, 0.03], 0.008, [m, dy0 + 0.05, z], [0, 0, 0], SH);
    for (const x of [a + 0.025, b - 0.025]) k.rbox(KM.paint, [0.05, dy1 - dy0, 0.03], 0.008, [x, (dy0 + dy1) / 2, z], [0, 0, 0], SH);
    k.box(KM.glass, [w - 0.04, dy1 - dy0 - 0.14, 0.006], [m, (dy0 + dy1) / 2 + 0.02, z], [0, 0, 0], { ...SH, cast: false });
    k.rbox(VA, [0.02, 0.3, 0.02], 0.006, [i === 0 ? a + 0.07 : b - 0.07, 1.25, z + 0.03], [0, 0, 0], SH);
  }
  k.rbox(VA, [W, 0.02, 0.07], 0.006, [cx, yt - 0.09, z1 - 0.04], [0, 0, 0], SH);
  // exhaust plenum on the roof frame and the duct to the house exhaust
  k.rbox(KM.paint, [0.8, 0.16, 0.5], 0.02, [0.1, yt + 0.08, -0.68]);
  k.cyl(VS, 0.12, 4.2 - yt - 0.16, [0.1, (yt + 0.16 + 4.2) / 2, -0.68], [0, 0, 0], 28);
  k.torus(KM.stainlessDark, 0.122, 0.008, [0.1, yt + 0.3, -0.68], [0, 0, 0], 28, { cast: false });
  if (!live) return;
  // slurry / DIW manifold on the back wall
  for (const [i, name, col] of [[0, 'SLURRY', '#7a6a3a'], [1, 'DIW', '#2f5d8a']] as const) {
    const y = 1.32 + i * 0.16;
    gasStick(k, 0.5, [-0.35, y, z0 + 0.05]);
    k.label('gas', name, '', 0.12, 0.026, [-0.7, y + 0.01, z0 + 0.027], [0, 0, 0], col);
  }
  // head-pressure regulator (EPR) panel: one gauge per membrane zone
  k.rbox(KM.paint, [0.32, 0.26, 0.2], 0.015, [0.95, 1.3, z0 + 0.125]);
  for (let i = 0; i < 4; i++) {
    const x = 0.83 + i * 0.08;
    k.cyl(KM.plastic, 0.026, 0.02, [x, 1.33, z0 + 0.235], [HP, 0, 0], 20);
    k.cyl(KM.glassSmoke, 0.02, 0.004, [x, 1.33, z0 + 0.246], [HP, 0, 0], 20, { cast: false });
  }
  k.label('tag', 'EPR · ZONES 1–4', 'HEAD PRESSURE', 0.2, 0.05, [0.95, 1.22, z0 + 0.226]);
  for (let i = 0; i < 4; i++) k.tube(KM.ptfe, [[0.83 + i * 0.08, 1.43, z0 + 0.15], [0.86 + i * 0.05, 1.7, z0 + 0.12], [1.05, 1.95, -0.6], [PIVOT.x - 0.05 + i * 0.03, ARM_Y + 0.15, PIVOT.z - 0.05]], 0.005, { radial: 6, tension: 0.4 });
  // signal-tower mast (the tower stands on it)
  k.cyl(VA, 0.03, 0.012, [1.15, DECK + 0.006, 0.85], [0, 0, 0], 20);
  k.cyl(VA, 0.016, 0.95 - DECK, [1.15, (DECK + 0.95) / 2, 0.85], [0, 0, 0], 12);
}

/**
 * Post-CMP cleaner (local frame centred on the module, front +Z): cabinet base, open-fronted
 * process section with the brush box (side plates, bearing stubs, edge-drive rollers, spray
 * bars, sump), spin-rinse-dry bowl behind, FFU and exhaust on top, input port to the polisher.
 */
function buildCleaner(k: Kit) {
  const w = 0.8;
  const d = 1.0;
  const h = 1.42;
  const yb = 0.842;
  const cz = 0.25; // CLEAN in the local frame
  cabinet(k, { size: [w, 0.82, d], panels: 1, rows: [], stripe: false, feet: false });
  for (const s of [-1, 1]) k.rbox(KM.paint, [0.02, h - yb, d], 0.006, [s * (w / 2 - 0.01), (yb + h) / 2, 0]);
  k.rbox(KM.paint, [w, h - yb, 0.02], 0.006, [0, (yb + h) / 2, -d / 2 + 0.01]);
  k.rbox(KM.paintGraphite, [w + 0.012, 0.024, d + 0.012], 0.006, [0, h + 0.012, 0]);
  k.box(KM.paintGrey, [w - 0.04, 0.01, d - 0.04], [0, yb + 0.005, 0]);
  // front panel framing the process opening
  const ox = 0.27;
  const oy0 = 0.88;
  const oy1 = 1.36;
  const zf = d / 2 - 0.01;
  k.rbox(KM.paint, [w, oy0 - yb, 0.02], 0.006, [0, (yb + oy0) / 2, zf]);
  k.rbox(KM.paint, [w, h - oy1, 0.02], 0.006, [0, (oy1 + h) / 2, zf]);
  for (const s of [-1, 1]) k.rbox(KM.paint, [w / 2 - ox, oy1 - oy0, 0.02], 0.006, [s * (ox + (w / 2 - ox) / 2), (oy0 + oy1) / 2, zf]);
  for (const s of [-1, 1]) {
    k.box(KM.anodizedDark, [2 * ox + 0.03, 0.015, 0.03], [0, s < 0 ? oy0 : oy1, zf + 0.008]);
    k.box(KM.anodizedDark, [0.015, oy1 - oy0, 0.03], [s * (ox + 0.0075), (oy0 + oy1) / 2, zf + 0.008]);
  }
  // brush box
  for (const s of [-1, 1]) {
    k.rbox(KM.plasticWhite, [0.02, 0.42, 0.3], 0.006, [s * 0.21, 1.12, cz]);
    for (const z of [-0.03, 0.03]) {
      k.cyl(VS, 0.009, 0.06, [s * 0.19, 1.12, cz + z], [0, 0, HP], 12);
      k.rbox(KM.plastic, [0.03, 0.05, 0.04], 0.006, [s * 0.235, 1.12, cz + z]);
    }
  }
  for (const a of [-2.25, -HP, -0.89]) k.cyl(KM.plastic, 0.02, 0.026, [Math.cos(a) * 0.172, 1.12 + Math.sin(a) * 0.172, cz], [HP, 0, 0], 20);
  for (const z of [-0.075, 0.075]) {
    k.cyl(VS, 0.008, 0.38, [0, 1.32, cz + z], [0, 0, HP], 10);
    for (let i = 0; i < 5; i++) k.cyl(KM.ptfe, 0.006, 0.014, [-0.14 + i * 0.07, 1.306, cz + z], [0, 0, 0], 8, { cast: false });
  }
  k.rbox(KM.plasticWhite, [0.46, 0.06, 0.34], 0.01, [0, 0.885, cz]);
  // spin-rinse-dry bowl and lid behind the brush box
  k.lathe(KM.plasticWhite, [[0, 0.86], [0.2, 0.86], [0.22, 1.02], [0.2, 1.04], [0.19, 1.0], [0, 0.98]], [0, 0, -0.22], [0, 0, 0], 48);
  k.cyl(VA, 0.155, 0.012, [0, 1.0, -0.22], [0, 0, 0], 40);
  k.rbox(KM.paintGrey, [0.46, 0.02, 0.46], 0.006, [0, 1.25, -0.22]);
  k.cyl(VA, 0.012, 0.2, [0.2, 1.15, -0.22], [0, 0, 0], 10);
  // FFU and exhaust on the roof
  k.rbox(KM.paint, [0.7, 0.14, 0.62], 0.012, [0, h + 0.094, -0.15]);
  grille(k, 0.5, 0.08, [0, h + 0.094, 0.161], { m: KM.paint });
  k.cyl(VS, 0.07, 4.2 - h - 0.164, [0.2, (h + 0.164 + 4.2) / 2, -0.32], [0, 0, 0], 20);
  // front controls and labels
  // (the output stage covers the middle of the lower front: plate and EMO sit beside it)
  k.label('model', 'PCC-2', 'POST-CMP CLEANER', 0.13, 0.04, [0.322, 0.78, d / 2 + 0.002]);
  ledStrip(k, 0.6, [0, 1.395, d / 2 + 0.002]);
  estop(k, [0.32, 0.6, d / 2]);
  // input port on the polisher side
  k.box(KM.seam, [0.002, 0.3, 0.4], [w / 2 + 0.001, 1.15, cz], [0, 0, 0], { cast: false });
}

/** Dry output stage in front of the cleaner: pedestal, wafer ring and support pins. */
function buildOutput(k: Kit) {
  cabinet(k, { size: [0.5, 0.9, 0.4], panels: 1, rows: [], stripe: false, vent: false });
  k.cyl(KM.plastic, 0.165, 0.008, [0, 0.926, 0], [0, 0, 0], 48);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    k.cyl(KM.chrome, 0.005, 0.02, [Math.cos(a) * 0.13, 0.94, Math.sin(a) * 0.13], [0, 0, 0], 8, { cast: false });
  }
  k.label('info', 'OUT', 'DRY WAFER · TO FOUP', 0.16, 0.04, [0, 0.8, 0.202]);
}

/* --- moving parts (local frames) --- */

/** Platen: chamfered table, drive skirt, sub-pad and pad edges, index marks (pad face is its own mesh). */
function buildPlaten(k: Kit) {
  k.lathe(VS, [[0, -0.03], [0.39, -0.03], [0.4, -0.022], [0.4, 0.026], [0.396, 0.03], [0, 0.03]], [0, 0, 0], [0, 0, 0], 96);
  k.cyl(KM.anodizedDark, 0.34, 0.03, [0, -0.045, 0], [0, 0, 0], 64);
  k.cyl(KM.rubber, 0.397, 0.0025, [0, 0.0312, 0], [0, 0, 0], 96, { open: true, cast: false });
  k.cyl(KM.paintWarm, 0.396, 0.003, [0, 0.034, 0], [0, 0, 0], 96, { open: true, cast: false });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    k.box(i % 3 ? KM.seam : KM.paintAccent, [0.004, 0.034, 0.012], [Math.cos(a) * 0.401, 0, Math.sin(a) * 0.401], [0, -a, 0], { cast: false });
  }
}

/** Carrier head: retaining ring, membrane carrier, top flange with bolts, gimbal, spindle, union. */
function buildHead(k: Kit) {
  k.lathe(KM.plastic, [[0.15, -0.035], [0.175, -0.035], [0.175, -0.013], [0.15, -0.013], [0.15, -0.035]], [0, 0, 0], [0, 0, 0], 64);
  k.lathe(VA, [[0, -0.03], [0.15, -0.03], [0.168, -0.013], [0.168, 0.022], [0.16, 0.034], [0, 0.034]], [0, 0, 0], [0, 0, 0], 64);
  k.cyl(KM.paint, 0.18, 0.012, [0, 0.04, 0], [0, 0, 0], 64);
  boltCircle(k, 0.155, 12, 0.047, 0.006);
  k.cyl(VA, 0.075, 0.05, [0, 0.071, 0], [0, 0, 0], 40);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    k.cyl(KM.ptfe, 0.008, 0.02, [Math.cos(a) * 0.11, 0.056, Math.sin(a) * 0.11], [0, 0, 0], 10, { cast: false });
  }
  k.cyl(VS, 0.04, 0.634, [0, 0.413, 0], [0, 0, 0], 24);
  k.cyl(KM.anodizedDark, 0.05, 0.03, [0, 0.115, 0], [0, 0, 0], 24);
}

/** Head swing arm (pivot frame, +X toward the head): hub, covered box beam, accent stripes, cap. */
function buildSwingArm(k: Kit) {
  k.cyl(VA, 0.13, 0.16, [0, ARM_Y + 0.07, 0], [0, 0, 0], 40);
  k.rbox(KM.paint, [1.5, 0.14, 0.22], 0.03, [0.57, ARM_Y + 0.07, 0]);
  k.box(KM.seam, [1.24, 0.004, 0.05], [0.66, ARM_Y - 0.0015, 0], [0, 0, 0], { cast: false });
  for (const s of [-1, 1]) k.box(KM.paintAccent, [1.36, 0.018, 0.004], [0.6, ARM_Y + 0.115, s * 0.111], [0, 0, 0], { cast: false });
  for (const x of [0.25, 0.75, 1.2]) k.box(KM.seam, [0.004, 0.142, 0.222], [x, ARM_Y + 0.07, 0], [0, 0, 0], { cast: false });
  k.cyl(KM.paint, 0.135, 0.02, [0, ARM_Y + 0.16, 0], [0, 0, 0], 40);
  k.rbox(KM.paintGraphite, [0.2, 0.08, 0.16], 0.02, [-0.12, ARM_Y + 0.07, 0]);
  k.label('tag', 'HEAD 1', 'SWING ARM', 0.16, 0.04, [0.4, ARM_Y + 0.07, 0.111]);
}

/** Carriage riding in the arm: Z-drive housing, telescoping spindle sleeve, spindle motor, belt cover. */
function buildCarriage(k: Kit) {
  k.rbox(KM.paint, [0.26, 0.13, 0.24], 0.02, [0, ARM_Y - 0.065, 0]);
  k.cyl(VS, 0.06, 0.32, [0, ARM_Y - 0.29, 0], [0, 0, 0], 28);
  k.cyl(KM.anodizedDark, 0.068, 0.02, [0, ARM_Y - 0.44, 0], [0, 0, 0], 28);
  k.cyl(KM.anodizedDark, 0.045, 0.16, [0.0, ARM_Y - 0.21, 0.12], [0, 0, 0], 20);
  k.rbox(KM.paintGraphite, [0.07, 0.06, 0.16], 0.01, [0, ARM_Y - 0.16, 0.06]);
  k.tube(KM.plastic, [[0.1, ARM_Y - 0.06, -0.12], [0.16, ARM_Y + 0.02, -0.14], [0.22, ARM_Y + 0.1, -0.12]], 0.008, { radial: 6 });
}

/** Conditioner arm (pivot frame, arm toward −X): hub, covered arm, disk drive, down-force rod, diamond disk. */
function buildCondArm(k: Kit) {
  k.cyl(VA, 0.04, 0.06, [0, 0, 0], [0, 0, 0], 24);
  k.rbox(KM.paint, [0.46, 0.045, 0.056], 0.012, [-0.21, 0, 0]);
  for (const s of [-1, 1]) k.box(KM.paintAccent, [0.38, 0.008, 0.002], [-0.2, 0.008, s * 0.0285], [0, 0, 0], { cast: false });
  k.rbox(KM.paint, [0.09, 0.07, 0.09], 0.014, [-0.42, 0, 0]);
  k.cyl(VS, 0.012, 0.15, [-0.42, -0.105, 0], [0, 0, 0], 12);
  k.cyl(VA, 0.055, 0.014, [-0.42, -0.186, 0], [0, 0, 0], 32);
  k.cyl(KM.steel, 0.05, 0.016, [-0.42, -0.201, 0], [0, 0, 0], 32);
}

/** Neighbouring polisher (static, no cut-away): base, enclosure, platen and pad, arm and head. */
function buildNeighbour(k: Kit, pad: THREE.Material) {
  buildBase(k, false);
  buildEnclosure(k, false);
  k.at([0, 0.82, 0], 0, () => buildPlaten(k));
  k.add(pad, new THREE.CircleGeometry(PLATEN_R - 0.005, 64), [0, PAD_Y - 0.0005, 0], [-HP, 0, 0], [1, 1, 1], { keepUV: true, cast: false });
  buildArmColumn(k);
  k.at([PIVOT.x, 0, PIVOT.z], Math.atan2(-(POLISH.z - PIVOT.z), POLISH.x - PIVOT.x), () => {
    buildSwingArm(k);
    k.at([Math.hypot(POLISH.x - PIVOT.x, POLISH.z - PIVOT.z), 0, 0], 0, () => buildCarriage(k));
  });
  k.at([POLISH.x, PAD_Y + 0.045, POLISH.z], 0, () => buildHead(k));
  buildConditioner(k);
  k.at([0.62, 1.07, -0.5], 0.4, () => buildCondArm(k));
  buildSlurryArm(k);
}

function usePolisherStation(pad: THREE.Material) {
  return useModel({
    body: (k) => {
      buildBase(k);
      buildEnclosure(k);
      buildLoadCup(k);
      buildArmColumn(k);
      k.at([-1.55, 0, 0.75], 0, () => buildOutput(k));
    },
    slurry: buildSlurryArm,
    conditioner: buildConditioner,
    cleaner: (k) => k.at([-1.55, 0, -0.25], 0, () => buildCleaner(k)),
    _stand: (k) => k.at([1.65, 0, -0.55], -0.6, () => monitorStand(k, 1.36, 1.5, [0.62, 0.4])),
    _nb: (k) => {
      for (const x of [-3.4, 3.4]) k.at([x, 0, 0], 0, () => buildNeighbour(k, pad), [0.92, 1, 0.95]);
    },
  });
}

const slurryMat = new THREE.MeshStandardMaterial({ color: '#f2f1ea', roughness: 0.15, transparent: true, opacity: 0.55, depthWrite: false });
const waterMat = new THREE.MeshStandardMaterial({ color: '#d7e6dc', roughness: 0.05, transparent: true, opacity: 0.35, depthWrite: false });

function Polisher() {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  const view = effectiveView(viewRaw, cam);
  const platen = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const cond = useRef<THREE.Group>(null);
  const stream = useRef<THREE.Mesh>(null);
  const puddle = useRef<THREE.Mesh>(null);
  const rollers = useRef<THREE.Group>(null);
  const wafer = useRef<THREE.Group>(null);
  const spray = useRef<THREE.Mesh>(null);
  const arm = useRef<THREE.Group>(null);
  const slide = useRef<THREE.Group>(null);
  const pad = useMemo(() => new THREE.MeshStandardMaterial({ map: padTexture(), roughness: 0.75, metalness: 0 }), []);
  const waferMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.1, metalness: 0.9 }), []);
  const pva = useMemo(() => pvaMat(), []);
  const spin = useRef(0);
  useFrame((_, dt) => {
    const polishing = inPhase('polish') || inPhase('endpoint');
    const d = pdt(dt);
    if (platen.current && polishing) platen.current.rotation.y += d * 6.3; // ≈ 60 rpm
    const { p, faceDown, vertical } = waferPos();
    track('focus', p.x, p.y, p.z);
    if (polishing) spin.current += d * 5.9;
    // carrier head carries the wafer from load until the cleaner
    const onHead = pp('load') > 0 && pp('clean') < 0.5;
    if (head.current) {
      head.current.position.set(onHead ? p.x : POLISH.x, onHead ? p.y + 0.045 : PAD_Y + 0.25, onHead ? p.z : POLISH.z);
      head.current.rotation.y = spin.current;
    }
    // the swing arm turns toward the head and its carriage slides to the head's radius
    if (arm.current && head.current) {
      const dx = head.current.position.x - PIVOT.x;
      const dz = head.current.position.z - PIVOT.z;
      arm.current.rotation.y = Math.atan2(-dz, dx);
      if (slide.current) slide.current.position.x = Math.hypot(dx, dz);
    }
    if (wafer.current) {
      wafer.current.position.copy(p);
      wafer.current.rotation.set(Math.PI * faceDown + (Math.PI / 2) * vertical, spin.current * (onHead ? 1 : 0), 0);
    }
    if (cond.current) cond.current.rotation.y = polishing ? 0.5 * Math.sin(engine.time * 0.7) - 0.3 : 0.9;
    if (stream.current) stream.current.visible = polishing;
    if (puddle.current) {
      puddle.current.visible = polishing || pp('polish') > 0.02;
      slurryMat.opacity = polishing ? 0.5 : 0.25 * (1 - pp('clean'));
    }
    const cleaning = inPhase('clean');
    if (rollers.current) rollers.current.children.forEach((r, i) => (r.rotation.x += d * (cleaning ? 8 : 0) * (i % 2 ? 1 : -1)));
    if (spray.current) spray.current.visible = cleaning;
  });
  const st = usePolisherStation(pad);
  const platenModel = useModel(buildPlaten);
  const headModel = useModel(buildHead);
  const condModel = useModel(buildCondArm);
  const armModel = useModel(buildSwingArm);
  const slideModel = useModel(buildCarriage);
  return (
    <group>
      <ModelView m={st} view={view} pickable={false} />
      <Clickable sel={{ kind: 'machine', id: 'cmp', label: 'CMP polisher' }}>
        <ModelPick m={st} tag="body" />
        <Clickable sel={{ kind: 'component', id: 'platen', machine: 'cmp', label: 'Rotating platen & pad' }}>
          <group ref={platen} position={[0, 0.82, 0]}>
            <ModelView m={platenModel} />
            <mesh position={[0, PAD_Y - 0.82 - 0.0005, 0]} rotation={[-Math.PI / 2, 0, 0]} material={pad} receiveShadow>
              <circleGeometry args={[PLATEN_R - 0.005, 96]} />
            </mesh>
            <mesh ref={puddle} position={[0.08, PAD_Y - 0.82 + 0.0006, 0.05]} rotation={[-Math.PI / 2, 0, 0]} material={slurryMat}>
              <ringGeometry args={[0.05, 0.3, 64, 1, 0, Math.PI * 1.4]} />
            </mesh>
          </group>
        </Clickable>
        {/* head swing arm and carriage (follow the carrier head) */}
        <group ref={arm} position={[PIVOT.x, 0, PIVOT.z]}>
          <ModelView m={armModel} />
          <group ref={slide}>
            <ModelView m={slideModel} />
          </group>
        </group>
        {/* slurry arm */}
        <Clickable sel={{ kind: 'component', id: 'slurry-arm', machine: 'cmp', label: 'Slurry arm' }}>
          <ModelPick m={st} tag="slurry" />
          <mesh ref={stream} position={[-0.12, 0.96, -0.08]} material={slurryMat}>
            <cylinderGeometry args={[0.004, 0.004, 0.19, 8]} />
          </mesh>
        </Clickable>
        {/* pad conditioner */}
        <Clickable sel={{ kind: 'component', id: 'conditioner', machine: 'cmp', label: 'Pad conditioner' }}>
          <ModelPick m={st} tag="conditioner" />
          <group ref={cond} position={[0.62, 1.07, -0.5]}>
            <ModelView m={condModel} />
          </group>
        </Clickable>
        {/* post-CMP cleaner */}
        <Clickable sel={{ kind: 'component', id: 'cleaner', machine: 'cmp', label: 'Post-CMP brush cleaner' }}>
          <ModelPick m={st} tag="cleaner" />
          <group ref={rollers}>
            {[-0.03, 0.03].map((z) => (
              <mesh key={z} position={[-1.55, 1.12, z]} rotation={[0, 0, Math.PI / 2]} material={pva}>
                <cylinderGeometry args={[0.022, 0.022, 0.34, 24]} />
              </mesh>
            ))}
          </group>
          <mesh ref={spray} position={[-1.55, 1.28, 0]} material={waterMat}>
            <coneGeometry args={[0.08, 0.14, 16, 1, true]} />
          </mesh>
        </Clickable>
        <SignalTower position={[1.15, 0.95, 0.85]} />
      </Clickable>
      {/* carrier head (moves with the wafer) */}
      <Clickable sel={{ kind: 'component', id: 'head', machine: 'cmp', label: 'Carrier head' }}>
        <group ref={head}>
          <ModelView m={headModel} />
        </group>
      </Clickable>
      <group ref={wafer}>
        <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184' }}>
          <mesh geometry={waferGeometry()} material={waferMat} castShadow />
        </Clickable>
      </group>
    </group>
  );
}

/* ---------------------------------------------------------------- cross-section with divider */

const TRENCHES = [-0.3, 0, 0.3];
const TW = 0.07; // half width
const DEPTH = 0.2;
const NIT = 0.04;
const BOTTOM = -0.36;
const EDGES = TRENCHES.flatMap((c) => [c - TW, c + TW]);
const inTrench = (x: number) => TRENCHES.some((c) => Math.abs(x - c) < TW);

/** oxide top (inset units) for a removal fraction r ∈ [0,1], step height in nm, dishing 0..1 */
function oxTop(x: number, r: number, stepNm: number, dish: number) {
  const L = lerp(0.3, NIT, r);
  const A = 0.11 * (stepNm / 300);
  // smooth high (over active areas) / low (over trenches) pattern
  let d = Infinity;
  for (const c of TRENCHES) d = Math.min(d, Math.abs(x - c));
  const hi = smooth(clamp((d - TW * 0.4) / (TW * 1.6)));
  let y = L + A * (hi - 0.5);
  if (r >= 0.999 && inTrench(x)) y -= 0.014 * dish;
  return Math.max(y, inTrench(x) ? -DEPTH + 0.01 : NIT);
}

function xs(x0: number, x1: number): number[] {
  const out: number[] = [];
  const n = 60;
  for (let i = 0; i <= n; i++) out.push(x0 + ((x1 - x0) * i) / n);
  for (const e of EDGES) if (e > x0 && e < x1) out.push(e - 1e-4, e + 1e-4);
  return out.sort((a, b) => a - b);
}

function band(x0: number, x1: number, top: (x: number) => number, bottom: number): [number, number][] | null {
  if (x1 - x0 < 0.004) return null;
  const pts: [number, number][] = [
    [x0, bottom],
    [x1, bottom],
  ];
  const s = xs(x0, x1).reverse();
  for (const x of s) pts.push([x, top(x)]);
  return pts;
}

const siTop = (x: number) => (inTrench(x) ? -DEPTH : 0);
const siMat = new THREE.MeshStandardMaterial({ color: '#7a828c', roughness: 0.45, metalness: 0.55 });
const oxMat = new THREE.MeshPhysicalMaterial({ color: '#a9c2a0', roughness: 0.3, transparent: true, opacity: 0.95 });
const oxBefore = new THREE.MeshPhysicalMaterial({ color: '#8fa889', roughness: 0.35, transparent: true, opacity: 0.95 });
const nitMat = new THREE.MeshStandardMaterial({ color: '#b7a77d', roughness: 0.4 });
const dividerMat = new THREE.MeshBasicMaterial({ color: '#e3e8df', toneMapped: false });
const INSET_POS: [number, number, number] = [-1.5, 2.1, 1.45];

function CMPInset() {
  const div = useRef(0);
  const dragging = useRef(false);
  const handle = useRef<THREE.Group>(null);
  const controls = useThree((s) => s.controls) as unknown as { enabled: boolean } | null;
  const current = () => {
    const removed = engine.tele.value('removed', 0);
    const step = engine.tele.value('step', 300);
    const dish = pp('endpoint');
    return { r: clamp(removed / 420), step, dish };
  };
  useFrame(() => {
    if (handle.current) handle.current.position.x = div.current;
  });
  const setFrom = (e: ThreeEvent<PointerEvent>) => {
    div.current = clamp(e.point.x - INSET_POS[0], -0.55, 0.55);
  };
  const nitride = useMemo(() => {
    const regions: [number, number][] = [];
    const bounds = [-0.55, ...EDGES, 0.55];
    for (let i = 0; i < bounds.length; i += 2) regions.push([bounds[i], bounds[i + 1]]);
    return regions.map(([a, b]) => [
      [a, 0],
      [b, 0],
      [b, NIT],
      [a, NIT],
    ] as [number, number][]);
  }, []);
  const silicon = useMemo(() => band(-0.55, 0.55, siTop, BOTTOM)!, []);
  return (
    <Inset id="cmp-section" position={INSET_POS} size={[1.4, 0.9]} mpu={500e-9 / 0.55} schematic={false} title="CMP · BEFORE ◀ ▶ AFTER (DRAG)">
      <group position={[0, -0.02, 0]}>
        {/* oxide: before (left of the divider) and current (right) */}
        <LiveProfile depth={0.12} m={oxBefore} compute={() => band(-0.55, div.current, (x) => oxTop(x, 0, 300, 0), -DEPTH)} />
        <LiveProfile
          depth={0.12}
          m={oxMat}
          compute={() => {
            const c = current();
            return band(div.current, 0.55, (x) => oxTop(x, c.r, c.step, c.dish), -DEPTH);
          }}
        />
        {/* silicon and nitride are drawn slightly deeper so they sit in front of the oxide */}
        <ProfileSlab points={silicon} depth={0.13} m={siMat} />
        {nitride.map((p, i) => (
          <ProfileSlab key={i} points={p} depth={0.128} m={nitMat} />
        ))}
        <group ref={handle}>
          <mesh position={[0, 0, 0.075]} material={dividerMat}>
            <boxGeometry args={[0.006, 0.82, 0.004]} />
          </mesh>
          <mesh
            position={[0, 0.36, 0.08]}
            material={dividerMat}
            onPointerDown={(e) => {
              e.stopPropagation();
              dragging.current = true;
              if (controls) controls.enabled = false;
              (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
            }}
          >
            <sphereGeometry args={[0.03, 16, 12]} />
          </mesh>
        </group>
        {/* drag surface */}
        <mesh
          position={[0, 0, 0.09]}
          visible={false}
          onPointerDown={(e) => {
            e.stopPropagation();
            dragging.current = true;
            if (controls) controls.enabled = false;
            setFrom(e);
          }}
          onPointerMove={(e) => {
            if (!dragging.current) return;
            e.stopPropagation();
            setFrom(e);
          }}
          onPointerUp={() => {
            dragging.current = false;
            if (controls) controls.enabled = true;
          }}
          onPointerLeave={() => {
            if (!dragging.current) return;
            dragging.current = false;
            if (controls) controls.enabled = true;
          }}
        >
          <planeGeometry args={[1.3, 0.86]} />
        </mesh>
      </group>
      <TechLabel position={[-0.66, 0.4, 0.05]} title="BEFORE · STEP 300 nm" min={2} />
      <TechLabel position={[0.2, 0.4, 0.05]} title="NOW" min={2} value={() => `step ${engine.tele.value('step', 0).toFixed(0)} nm · removed ${engine.tele.value('removed', 0).toFixed(0)} nm · SIMULATED`} />
      <TechLabel position={[0.2, -0.36, 0.05]} title="NITRIDE STOP LAYER · OXIDE-FILLED TRENCHES" min={3} />
    </Inset>
  );
}

function CMPScreen() {
  return (
    <group position={[1.65, 0, -0.55]} rotation={[0, -0.6, 0]}>
      <Screen
        size={[0.62, 0.4]}
        position={[0, 1.5, 0.03]}
        hz={5}
        draw={(g, w, h) => {
          clear(g, w, h, 'ENDPOINT · MOTOR CURRENT · SIMULATED');
          bigNumber(g, 'STEP', engine.tele.value('step', 0).toFixed(0), 'nm', w * 0.05, h * 0.21, h * 0.1);
          bigNumber(g, 'MOTOR', engine.tele.value('motor', 0).toFixed(1), 'A', w * 0.37, h * 0.21, h * 0.1, inPhase('endpoint') ? SCR.warn : SCR.text);
          bigNumber(g, 'FORCE', engine.tele.value('force', 0).toFixed(2), 'psi', w * 0.68, h * 0.21, h * 0.1);
          const c = engine.tele.get('motor');
          plot(g, c ? c.series().slice(-200) : [], w * 0.05, h * 0.5, w * 0.9, h * 0.4, 0, 18, SCR.data);
        }}
      />
    </group>
  );
}

export default function CMPScene() {
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.3;
  }, []);
  return (
    <>
      <Lighting env="cleanroom" shadowExtent={5} />
      <CleanroomBay width={11} depth={8} height={4.2} />
      <Polisher />
      <CMPInset />
      <CMPScreen />
      <SensorIndicator id="downforce" channel="force" machine="cmp" position={[0.95, 1.3, -0.68]} size={0.04} />
      <SensorIndicator id="endpoint-motor" channel="motor" machine="cmp" position={[0.3, 0.7, 1.01]} size={0.04} />
      <SensorIndicator id="eddy-current" channel="removed" machine="cmp" position={[-0.25, 0.9, 0.3]} size={0.035} />
      <TechLabel position={[0.0, 1.05, 0.45]} title="PAD + SLURRY" lines={['removal ∝ pressure × velocity (Preston)']} min={2} />
      <TechLabel position={[-1.55, 1.55, 0.2]} title="BRUSH CLEAN" min={2} />
      <Operator position={[-0.9, 0, 1.7]} rotation={Math.PI * 0.85} still />
    </>
  );
}
