'use client';
/**
 * Wafer inspection (§16, §41): a laser surface scanner with dark-field collectors.
 *   bare:      prime-wafer qualification — the spot spirals over the spinning wafer, light-point
 *              defects light up, accepted wafers are packed for shipment
 *   patterned: the laser line sweeps the patterned wafer, defects are classified, and a die map
 *              is produced — click a die to inspect it
 * Defect data is SIMULATED (engine wafer map) — fictional categories, not production data.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import type { ViewMode } from '@/types';
import { Lighting, CleanroomBay } from '../environments';
import { M, shell, effectiveView } from '../materials';
import { GEO } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { waferGeometry } from '../parts/wafer';
import { Screen, clear, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { drawWafer } from '../textures';
import { Kit, cabinet, flange, grille, estop, ledStrip, foot, windowPane, type BakedPart, type PartOpts, type V3 } from '../kit/build';
import { KM } from '../kit/finish';
import { useKit } from '../kit/Baked';
import { casterGeometry, shadowOnly } from '../kit/shadow';
import { engine } from '@/simulation/engine';
import { pp, inPhase, pdt } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { rng, smooth, lerp, hash1 } from '@/lib/math';
import { DEFECT_CLASSES, DIE_W, DIE_H, WAFER_D } from '@/simulation/models';

const WY = 1.0;
const CLASS_COLOR: Record<string, string> = {
  Particle: '#e8e0b0',
  'Pattern bridge': '#ec835a',
  'Open line': '#d64b40',
  Scratch: '#f0a050',
  Residue: '#a99bd6',
  'Edge chipping': '#c9b46a',
  'Parametric drift': '#e8b23a',
};

interface Defect {
  x: number; // wafer-local m
  z: number;
  cls: string;
  r: number; // normalised radius 0..1 (scan order for the spiral)
  u: number; // 0..1 sweep order for the line scan
}

function useDefects(bare: boolean): Defect[] {
  return useMemo(() => {
    if (bare) {
      const r = rng(23);
      return Array.from({ length: 6 }, () => {
        const a = r() * Math.PI * 2;
        const rr = Math.sqrt(r()) * 0.14;
        return { x: Math.cos(a) * rr, z: Math.sin(a) * rr, cls: 'Particle', r: rr / 0.15, u: (Math.sin(a) * rr + 0.15) / 0.3 };
      });
    }
    return engine.waferMap
      .filter((d) => d.result !== 'PASS')
      .map((d) => {
        const x = (d.die.cx + (hash1(d.die.id) - 0.5) * DIE_W * 0.6) / 1000;
        const z = (d.die.cy + (hash1(d.die.id + 7) - 0.5) * DIE_H * 0.6) / 1000;
        return { x, z, cls: d.defect ?? 'Particle', r: Math.hypot(x, z) / 0.15, u: (z + 0.15) / 0.3 };
      });
  }, [bare]);
}

/** progress of the scan (0..1) */
const scanK = () => (inPhase('scan') ? engine.player.view.phaseT : pp('scan') >= 1 ? 1 : 0);

/* ---------------------------------------------------------------- wafer surface */

function useSurface(bare: boolean, defects: Defect[]) {
  return useMemo(() => {
    const S = 512;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const base = document.createElement('canvas');
    base.width = base.height = S;
    const bg = base.getContext('2d')!;
    if (bare) {
      bg.fillStyle = '#9aa1aa';
      bg.fillRect(0, 0, S, S);
    } else drawWafer(bg, S, 'dies');
    let last = '';
    const update = () => {
      const k = scanK();
      const classify = pp('classify') > 0;
      const key = `${Math.round(k * 60)}:${classify}`;
      if (key === last) return;
      last = key;
      g.drawImage(base, 0, 0);
      // scanned area tint
      g.fillStyle = 'rgba(160,210,140,0.10)';
      if (bare) {
        g.beginPath();
        g.arc(S / 2, S / 2, (S / 2) * k, 0, Math.PI * 2);
        g.fill();
      } else g.fillRect(0, 0, S, S * k);
      const px = (m: number) => S / 2 + (m * 1000 * S) / WAFER_D;
      for (const d of defects) {
        const found = bare ? d.r <= k : d.u <= k;
        if (!found) continue;
        g.fillStyle = classify ? CLASS_COLOR[d.cls] ?? '#fff' : '#fffbe0';
        g.beginPath();
        g.arc(px(d.x), px(d.z), classify ? 5 : 4, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = 'rgba(255,250,220,0.5)';
        g.lineWidth = 1;
        g.beginPath();
        g.arc(px(d.x), px(d.z), 9, 0, Math.PI * 2);
        g.stroke();
      }
      tex.needsUpdate = true;
    };
    update();
    return { tex, update };
  }, [bare, defects]);
}

/* ---------------------------------------------------------------- die map (clickable) */

const tmpColor = new THREE.Color();
function DieMap() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const dies = engine.waferMap;
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.92 }), []);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const o = new THREE.Object3D();
    dies.forEach((d, i) => {
      o.position.set(d.die.cx / 1000, 0, d.die.cy / 1000);
      o.scale.set((DIE_W / 1000) * 0.9, 0.0008, (DIE_H / 1000) * 0.9);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
      m.setColorAt(i, tmpColor.set(d.result === 'PASS' ? '#4f9a5a' : d.result === 'FAIL' ? '#c4483b' : '#d1a23a'));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [dies]);
  useFrame(() => {
    if (ref.current) ref.current.visible = inPhase('map');
  });
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const i = e.instanceId;
    if (i === undefined) return;
    const d = dies[i];
    useUI.getState().select({ kind: 'die', id: String(d.die.id), label: `Die (${d.die.col}, ${d.die.row})` });
  };
  return (
    <instancedMesh ref={ref} args={[undefined, mat, dies.length]} position={[0, 0.0016, 0]} onClick={onClick}>
      <boxGeometry />
    </instancedMesh>
  );
}

/* ---------------------------------------------------------------- static model (kit) */

const Z0: V3 = [0, 0, 0];
const HP = Math.PI / 2;
/** enclosure on the base: half width, floor (base top), roof */
const EN = { hw: 0.6, y0: 0.922, y1: 1.82 };
/** laser exit (beam start) and the collector channels (angle around the wafer) */
const LASER: V3 = [-0.42, 1.42, -0.1];
const COLLECTORS = [0, 1, 2].map((i) => 0.6 + i * 1.6);

/** Hard-edged surface of revolution: one band per profile edge. */
function crisp(k: Kit, m: THREE.Material, p: [number, number][], pos: V3 = Z0, rot: V3 = Z0, seg = 40, o: PartOpts = {}) {
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i];
    const b = p[i + 1];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6) k.lathe(m, [a, b], pos, rot, seg, o);
  }
}

function knurl(k: Kit, m: THREE.Material, r: number, h: number, pos: V3, n = 18) {
  k.cyl(m, r, h, pos, Z0, 28);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    k.box(m, [0.0025, h * 0.9, 0.003], [pos[0] + Math.cos(a) * r, pos[1], pos[2] + Math.sin(a) * r], [0, -a, 0], { cast: false });
  }
}

/** Euler (XYZ) that turns local +X onto the laser axis, from the exit towards the wafer centre. */
const LASER_ROT: V3 = (() => {
  const d = new THREE.Vector3(-LASER[0], WY - LASER[1], -LASER[2]).normalize();
  return [0, Math.atan2(-d.z, d.x), Math.asin(d.y)];
})();

/** Base cabinet, load station, unload shelf (bare wafers are packed beside the tool). */
function buildBase(k: Kit, bare: boolean) {
  cabinet(k, { size: [1.7, 0.9, 1.3], panels: 3, rows: [0.34], sidePanels: 2, handles: true });
  const zf = 0.6515;
  k.label('model', 'SI-300', bare ? 'SURFACE SCANNER · 300 mm' : 'DEFECT INSPECTION · 300 mm', 0.34, 0.085, [-0.58, 0.66, zf]);
  ledStrip(k, 0.3, [0, 0.74, zf]);
  k.label('warn', 'LASER', '', 0.07, 0.07, [0.38, 0.66, zf]);
  estop(k, [0.58, 0.66, 0.65]);
  // facility side: exhaust grille, PCW/CDA bulkheads
  k.at([0.85, 0, 0], HP, () => {
    grille(k, 0.5, 0.18, [0.28, 0.55, 0.002]);
    k.rbox(KM.stainless, [0.24, 0.12, 0.012], 0.004, [-0.32, 0.2, 0.006]);
    for (const x of [-0.39, -0.32, -0.25]) {
      k.cyl(KM.stainlessDark, 0.016, 0.012, [x, 0.2, 0.018], [HP, 0, 0], 6);
      k.cyl(KM.stainless, 0.011, 0.045, [x, 0.2, 0.04], [HP, 0, 0], 16);
    }
  });
  for (const z of [0.39, 0.32, 0.25]) k.pipe(KM.stainless, [[0.9, 0.2, z], [0.95, 0.2, z], [0.95, 0.0, z]], 0.009, 0.035);
  // load station on the right ledge: pre-aligner pedestal the wafer is handed in from
  k.cyl(KM.anodizedDark, 0.07, 0.05, [0.75, 0.947, 0.45], Z0, 32);
  k.cyl(KM.ptfe, 0.045, 0.026, [0.75, 0.986, 0.45], Z0, 32);
  k.rbox(KM.anodized, [0.06, 0.03, 0.03], 0.004, [0.66, 0.937, 0.45]);
  if (bare) {
    // unload shelf for the shipping box
    k.rbox(KM.anodized, [0.44, 0.025, 0.44], 0.006, [-0.95, 0.9095, 0.35]);
    for (const z of [0.2, 0.5]) k.extrude(KM.anodized, [[0, 0], [0.2, 0], [0, -0.2]], 0.012, [-0.85, 0.897, z - 0.006], [0, Math.PI, 0]);
  }
}

/** Enclosure (shell): aluminium frame, panels, glass windows, transfer slots, FFU on the roof. */
function buildEnclosure(k: Kit) {
  const o = { shell: true };
  const { hw, y0, y1 } = EN;
  const h = y1 - y0;
  const yc = (y0 + y1) / 2;
  const F = KM.anodized;
  // frame: corner posts and edge rails (extrusion), slot lines on the visible faces
  for (const x of [-hw, hw])
    for (const z of [-hw, hw]) {
      k.rbox(F, [0.04, h, 0.04], 0.006, [x, yc, z], Z0, o);
      k.box(KM.seam, [0.006, h - 0.06, 0.002], [x, yc, z + Math.sign(z) * 0.021], Z0, { ...o, cast: false });
    }
  for (const y of [y0 + 0.02, y1 - 0.02]) {
    for (const z of [-hw, hw]) k.rbox(F, [hw * 2 - 0.04, 0.04, 0.04], 0.006, [0, y, z], Z0, o);
    for (const x of [-hw, hw]) k.rbox(F, [0.04, 0.04, hw * 2 - 0.04], 0.006, [x, y, 0], Z0, o);
  }
  const P = KM.paint;
  const t = 0.012;
  const ya = y0 + 0.04;
  const yb = y1 - 0.04;
  // back wall: two panels, seam, fasteners
  k.box(P, [hw * 2 - 0.04, yb - ya, t], [0, (ya + yb) / 2, -hw], Z0, o);
  k.box(KM.seam, [0.004, yb - ya - 0.04, 0.002], [0, (ya + yb) / 2, -hw + 0.007], Z0, { ...o, cast: false });
  for (const x of [-0.53, -0.03, 0.03, 0.53]) for (const y of [ya + 0.04, yb - 0.04]) k.cyl(KM.stainlessDark, 0.005, 0.004, [x, y, -hw + 0.008], [HP, 0, 0], 8, { ...o, cast: false });
  // left wall with the unload slot (z 0.02..0.46, y 1.04..1.22)
  const L = -hw;
  k.box(P, [t, 1.04 - ya, hw * 2 - 0.04], [L, (ya + 1.04) / 2, 0], Z0, o);
  k.box(P, [t, yb - 1.22, hw * 2 - 0.04], [L, (yb + 1.22) / 2, 0], Z0, o);
  k.box(P, [t, 0.18, 0.6], [L, 1.13, -0.28], Z0, o);
  k.box(P, [t, 0.18, 0.12], [L, 1.13, 0.52], Z0, o);
  slotLips(k, L, 1.04, 1.22, 0.02, 0.46, o);
  for (const z of [-0.53, 0.53]) for (const y of [ya + 0.04, yb - 0.04]) k.cyl(KM.stainlessDark, 0.005, 0.004, [L - 0.008, y, z], [0, 0, HP], 8, { ...o, cast: false });
  // right wall: load slot low at the front (z 0.14..0.58, y 0.962..1.14), framed window above
  const R = hw;
  k.box(P, [t, 1.16 - ya, 0.72], [R, (ya + 1.16) / 2, -0.22], Z0, o);
  k.box(P, [t, 0.02, 0.44], [R, 1.15, 0.36], Z0, o);
  slotLips(k, R, ya, 1.14, 0.14, 0.58, o);
  k.at([R, 0, 0], HP, () => windowPane(k, 1.06, 0.56, [0, 1.47, 0], { ...o, frame: KM.anodizedDark }));
  // front: glass door with handle and hinges
  windowPane(k, 1.08, 0.78, [0, 1.37, hw], { ...o, frame: KM.anodizedDark });
  k.rbox(KM.chrome, [0.018, 0.26, 0.018], 0.006, [0.48, 1.37, hw + 0.045], Z0, o);
  for (const y of [1.28, 1.46]) k.box(KM.chrome, [0.012, 0.012, 0.03], [0.48, y, hw + 0.025], Z0, o);
  for (const y of [1.1, 1.64]) k.rbox(KM.anodizedDark, [0.03, 0.07, 0.03], 0.006, [-0.575, y, hw + 0.03], Z0, o);
  k.label('warn', 'LASER', '', 0.07, 0.07, [-0.45, 1.66, hw + 0.019], Z0);
  // roof and fan filter unit
  k.box(P, [hw * 2 - 0.04, t, hw * 2 - 0.04], [0, y1 - 0.006, 0], Z0, o);
  k.rbox(P, [0.9, 0.11, 0.9], 0.012, [0, y1 + 0.055, -0.02], Z0, o);
  k.rbox(KM.paintGraphite, [0.92, 0.012, 0.92], 0.004, [0, y1 + 0.004, -0.02], Z0, o);
  grille(k, 0.6, 0.06, [0, y1 + 0.055, 0.4305], o);
  k.label('info', 'FFU-2', 'ULPA · 0.45 m/s', 0.12, 0.03, [0.33, y1 + 0.055, 0.4315]);
  k.rbox(KM.paintGraphite, [0.18, 0.08, 0.14], 0.008, [-0.25, y1 + 0.15, -0.2], Z0, o);
  k.tube(KM.plastic, [[-0.16, y1 + 0.15, -0.2], [0.05, y1 + 0.15, -0.3], [0.2, y1 + 0.15, -0.55], [0.2, y1 - 0.2, -0.63]], 0.012, o);
}

/** Lips around a transfer slot in a side wall at x (opening y0..y1, z0..z1). */
function slotLips(k: Kit, x: number, y0: number, y1: number, z0: number, z1: number, o: PartOpts) {
  const m = KM.anodizedDark;
  k.box(m, [0.04, 0.012, z1 - z0 + 0.024], [x, y0 - 0.006, (z0 + z1) / 2], Z0, o);
  k.box(m, [0.04, 0.012, z1 - z0 + 0.024], [x, y1 + 0.006, (z0 + z1) / 2], Z0, o);
  k.box(m, [0.04, y1 - y0, 0.012], [x, (y0 + y1) / 2, z0 - 0.006], Z0, o);
  k.box(m, [0.04, y1 - y0, 0.012], [x, (y0 + y1) / 2, z1 + 0.006], Z0, o);
}

/** Interior: granite, XY + spin stage, laser module, collector ring with channels, brightfield column. */
function buildInterior(k: Kit) {
  // granite (recessed into the deck) and the XY stage stack under the spin chuck
  k.rbox(KM.paintDark, [0.98, 0.04, 0.98], 0.006, [0, 0.915, 0]);
  k.box(KM.seam, [0.96, 0.002, 0.002], [0, 0.93, 0.491], Z0, { cast: false });
  for (const x of [-0.25, 0.25]) {
    k.rbox(KM.stainlessDark, [0.026, 0.01, 0.86], 0.003, [x, 0.94, 0]);
    k.box(KM.paintGraphite, [0.05, 0.004, 0.84], [x * 0.62, 0.937, 0], Z0, { cast: false });
    for (const z of [-0.44, 0.44]) k.rbox(KM.paintYellow, [0.04, 0.022, 0.02], 0.004, [x, 0.946, z]);
  }
  // Y carriage with bearing blocks, X rails, X carriage
  k.rbox(KM.paintGrey, [0.6, 0.014, 0.36], 0.005, [0, 0.952, 0]);
  for (const x of [-0.25, 0.25]) for (const z of [-0.12, 0.12]) k.rbox(KM.anodized, [0.045, 0.012, 0.07], 0.003, [x, 0.946, z]);
  for (const z of [-0.13, 0.13]) k.rbox(KM.stainlessDark, [0.5, 0.008, 0.022], 0.002, [0, 0.963, z]);
  k.rbox(KM.anodized, [0.32, 0.012, 0.32], 0.004, [0, 0.973, 0]);
  for (const x of [-0.12, 0.12]) for (const z of [-0.13, 0.13]) k.rbox(KM.anodizedDark, [0.06, 0.01, 0.04], 0.003, [x, 0.967, z]);
  k.rbox(KM.anodizedDark, [0.04, 0.03, 0.8], 0.006, [-0.37, 0.95, 0]);
  // spin spindle housing and the vacuum chuck (mushroom profile)
  crisp(k, KM.anodizedDark, [[0.11, 0.979], [0.11, 0.984], [0.085, 0.986], [0.085, 0.988], [0.06, 0.99]], Z0, Z0, 48);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    k.box(KM.anodizedDark, [0.003, 0.004, 0.012], [Math.cos(a) * 0.112, 0.982, Math.sin(a) * 0.112], [0, -a, 0], { cast: false });
  }
  crisp(k, KM.ptfe, [[0.06, 0.99], [0.15, 0.9905], [0.15, 0.9995], [0.0, 0.9995]], Z0, Z0, 64);
  for (const r of [0.05, 0.09, 0.13]) k.torus(KM.seam, r, 0.0006, [0, 0.9992, 0], Z0, 48, { cast: false });
  // cable chain to the stage
  for (let i = 0; i < 9; i++) k.box(KM.plastic, [0.05, 0.022, 0.035], [-0.43, 0.946, -0.4 + i * 0.04], Z0, { cast: false });
  // laser module on its wall bracket, beam expander nose at the exit point
  k.at(LASER, LASER_ROT, () => {
    k.cyl(KM.anodizedDark, 0.018, 0.04, [-0.02, 0, 0], [0, 0, HP], 24);
    k.cyl(KM.chrome, 0.011, 0.004, [0.001, 0, 0], [0, 0, HP], 20);
    k.rbox(KM.paint, [0.17, 0.085, 0.09], 0.01, [-0.125, 0, 0]);
    for (let i = 0; i < 7; i++) k.box(KM.anodizedDark, [0.005, 0.024, 0.08], [-0.195 + i * 0.022, 0.054, 0], Z0, { cast: false });
    k.label('warn', 'LASER', '', 0.04, 0.04, [-0.12, 0, 0.0455]);
    k.cyl(KM.stainlessDark, 0.012, 0.02, [-0.215, 0, 0], [0, 0, HP], 12);
  });
  k.rbox(KM.anodizedDark, [0.02, 0.16, 0.12], 0.004, [-0.584, 1.56, -0.12]);
  k.rbox(KM.anodized, [0.06, 0.03, 0.05], 0.004, [-0.56, 1.5, -0.12]);
  k.tube(KM.plastic, [[-0.585, 1.6, -0.14], [-0.58, 1.66, -0.2], [-0.58, 1.75, -0.4]], 0.008);
  // collector ring hung from the roof, with the darkfield channels (lens tube, focus ring, PMT)
  crisp(k, KM.anodized, [[0.3, 1.49], [0.46, 1.49], [0.46, 1.51], [0.3, 1.51], [0.3, 1.49]], Z0, Z0, 64);
  for (const a of [1.4, 3.0, 5.2]) k.cyl(KM.stainlessDark, 0.008, EN.y1 - 1.51, [Math.cos(a) * 0.38, (EN.y1 + 1.51) / 2, Math.sin(a) * 0.38], Z0, 10);
  for (const a of COLLECTORS) {
    k.at([Math.cos(a) * 0.32, 1.35, Math.sin(a) * 0.32], [Math.sin(a) * 0.8, 0, -Math.cos(a) * 0.8], () => {
      k.cyl(KM.anodizedDark, 0.05, 0.14, Z0, Z0, 36);
      k.cyl(KM.glassSmoke, 0.042, 0.004, [0, -0.071, 0], Z0, 32, { cast: false });
      k.torus(KM.anodized, 0.046, 0.004, [0, -0.07, 0], Z0, 32);
      knurl(k, KM.anodized, 0.053, 0.02, [0, -0.03, 0]);
      k.rbox(KM.paint, [0.09, 0.1, 0.09], 0.01, [0, 0.12, 0]);
      k.box(KM.seam, [0.092, 0.003, 0.092], [0, 0.1, 0], Z0, { cast: false });
      k.cyl(KM.stainlessDark, 0.012, 0.02, [0, 0.18, 0], Z0, 12);
    });
    const tx = Math.cos(a) * (0.32 + 0.19 * Math.sin(0.8));
    const tz = Math.sin(a) * (0.32 + 0.19 * Math.sin(0.8));
    k.tube(KM.plastic, [[tx, 1.35 + 0.19 * Math.cos(0.8), tz], [tx * 1.08, 1.6, tz * 1.08], [tx * 1.1, EN.y1 - 0.01, tz * 1.1]], 0.006);
  }
  // brightfield imaging column from the roof (objective, beam splitter, tube lens)
  k.at([0, 0, -0.02], 0, () => {
    crisp(k, KM.chrome, [[0.012, 1.5], [0.02, 1.505], [0.028, 1.525], [0.03, 1.57], [0.036, 1.575], [0.036, 1.6]], Z0, Z0, 28);
    k.torus(KM.paintYellow, 0.0302, 0.0018, [0, 1.55, 0], Z0, 28);
    k.cyl(KM.anodized, 0.05, 0.04, [0, 1.62, 0], Z0, 32);
    k.rbox(KM.paint, [0.11, 0.09, 0.11], 0.01, [0, 1.685, 0]);
    k.cyl(KM.anodizedDark, 0.022, 0.09, [0, 1.685, -0.1], [HP, 0, 0], 20);
    k.cyl(KM.paint, 0.042, 0.08, [0, 1.77, 0], Z0, 32);
    flange(k, 0.05, EN.y1 - 0.02, { bolts: 8, t: 0.008 });
  });
}

/** Shipping box for accepted prime wafers (moves / toggles with its group). */
function buildShipper(k: Kit) {
  k.rbox(M.foupDark, [0.35, 0.02, 0.35], 0.006, [0, 0.032, 0]);
  k.rbox(M.foupShell, [0.34, 0.265, 0.34], 0.03, [0, 0.022 + 0.1375, 0]);
  k.rbox(M.foupDark, [0.36, 0.035, 0.36], 0.012, [0, 0.305, 0]);
  for (const s of [-1, 1]) {
    k.rbox(M.foupDark, [0.02, 0.05, 0.13], 0.006, [s * 0.178, 0.26, 0]);
    k.rbox(M.foupDark, [0.12, 0.05, 0.02], 0.006, [0, 0.26, s * 0.178]);
  }
  k.label('tag', 'PRIME · 25', 'LOT P-2231 · ACCEPTED', 0.13, 0.0325, [0, 0.19, 0.1705]);
}

/** Floor stand for the Pareto monitor (local to the screen group). */
function buildMonitorStand(k: Kit) {
  k.rbox(KM.paintGraphite, [0.46, 0.035, 0.38], 0.012, [0, 0.0175, -0.04]);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) foot(k, [x * 0.19, 0, -0.04 + z * 0.15]);
  k.rbox(KM.anodized, [0.075, 1.47, 0.055], 0.012, [0, 0.77, -0.07]);
  k.box(KM.seam, [0.006, 1.36, 0.002], [0, 0.77, -0.042], Z0, { cast: false });
  k.rbox(KM.anodizedDark, [0.12, 0.12, 0.04], 0.01, [0, 1.52, -0.04]);
  k.rbox(KM.plastic, [0.72, 0.5, 0.03], 0.012, [0, 1.52, -0.008]);
  k.ao(0.46, 0.38, [0, 0, -0.04]);
}

/** Neighbouring tool in the bay: enclosed body, EFEM with two load ports, roof FFU, stack light. */
function buildNeighbour(k: Kit, name: string, sub: string, side: number) {
  cabinet(k, { size: [1.4, 1.52, 0.86], panels: 2, rows: [0.55], sidePanels: 1, handles: true, ao: false });
  k.at([0, 0, 0.43], 0, () => cabinet(k, { size: [1.4, 1.3, 0.34], panels: 2, rows: [0.8], sidePanels: 1, vent: false, ao: false, stripe: false }));
  k.ao(1.4, 1.2, [0, 0, 0.17]);
  for (const [i, x] of [-0.34, 0.34].entries()) {
    k.box(KM.seam, [0.4, 0.34, 0.003], [x, 1.05, 0.6015], Z0, { cast: false });
    k.rbox(KM.paint, [0.36, 0.3, 0.012], 0.006, [x, 1.05, 0.606]);
    k.rbox(KM.anodized, [0.42, 0.035, 0.36], 0.008, [x, 0.86, 0.78]);
    if (i === (side > 0 ? 1 : 0)) {
      k.rbox(KM.ptfe, [0.34, 0.3, 0.32], 0.035, [x, 1.03, 0.78]);
      k.rbox(KM.anodizedDark, [0.2, 0.025, 0.2], 0.006, [x, 1.192, 0.78]);
    }
  }
  ledStrip(k, 0.24, [0, 1.24, 0.6015]);
  estop(k, [0.6, 1.16, 0.6]);
  k.label('model', name, sub, 0.3, 0.075, [-0.38, 1.36, 0.2615]);
  k.at([side * 0.7, 0, -0.17], side * HP, () => {
    windowPane(k, 0.46, 0.34, [0, 1.1, 0.006], { glass: KM.glassSmoke });
    grille(k, 0.4, 0.14, [0, 0.36, 0.003]);
  });
  k.rbox(KM.paint, [1.2, 0.15, 0.7], 0.012, [0, 1.595, -0.17]);
  grille(k, 0.9, 0.07, [0, 1.595, 0.181]);
  k.at([0.6, 1.52, -0.5], 0, () => {
    k.cyl(KM.anodizedDark, 0.012, 0.1, [0, 0.05, 0], Z0, 12);
    k.cyl(KM.ledGreen, 0.025, 0.04, [0, 0.12, 0], Z0, 20);
    k.cyl(KM.ptfe, 0.025, 0.04, [0, 0.162, 0], Z0, 20);
    k.cyl(KM.anodizedDark, 0.027, 0.01, [0, 0.187, 0], Z0, 20);
  });
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
function Pick({ p, s, r }: { p: V3; s: V3; r?: V3 }) {
  return <mesh geometry={GEO.box} position={p} rotation={r} scale={s} material={PICK} visible={false} />;
}

/* ---------------------------------------------------------------- tool */

const laserMat = new THREE.MeshBasicMaterial({ color: '#b7ff9a', transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false });
const spotMat = new THREE.MeshBasicMaterial({ color: '#eaffd8', toneMapped: false });
const _p = new THREE.Vector3();
const _from = new THREE.Vector3(...LASER);
const _to = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function Tool({ bare }: { bare: boolean }) {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  const view = effectiveView(viewRaw, cam === 'machine' ? 'internal' : cam);
  const defects = useDefects(bare);
  const surf = useSurface(bare, defects);
  const top = useMemo(() => new THREE.MeshStandardMaterial({ map: surf.tex, roughness: 0.15, metalness: 0.45 }), [surf]);
  const waferMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.08, metalness: 0.9 }), []);
  const model = useKit(
    (k) => {
      buildBase(k, bare);
      buildEnclosure(k);
      buildInterior(k);
      k.at([1.35, 0, -0.45], -0.55, () => buildMonitorStand(k));
      k.at([-2.4, 0, -0.4], 0, () => buildNeighbour(k, 'MI-2', 'MACRO INSPECTION', 1));
      k.at([2.6, 0, -0.4], 0, () => buildNeighbour(k, 'RV-1', 'DEFECT REVIEW', -1));
    },
    [bare],
  );
  const shipper = useKit(buildShipper);
  const spin = useRef<THREE.Group>(null);
  const wafer = useRef<THREE.Group>(null);
  const beam = useRef<THREE.Mesh>(null);
  const spot = useRef<THREE.Mesh>(null);
  const line = useRef<THREE.Mesh>(null);
  const box = useRef<THREE.Group>(null);
  const ang = useRef(0);
  useFrame((_, dt) => {
    surf.update();
    const k = scanK();
    const scanning = inPhase('scan');
    if (scanning && bare) ang.current += pdt(dt) * 14;
    if (spin.current) spin.current.rotation.y = ang.current;
    // load / pack motion
    const inP = smooth(pp('load'));
    const outP = bare ? smooth(pp('pack')) : 0;
    const p = _p.set(lerp(0.75, 0, inP), WY + Math.sin(Math.PI * inP) * 0.08, lerp(0.45, 0, inP));
    if (outP > 0) p.set(lerp(0, -0.95, outP), WY + Math.sin(Math.PI * outP) * 0.15, lerp(0, 0.35, outP));
    if (wafer.current) wafer.current.position.copy(p);
    track('focus', p.x, p.y, p.z);
    // laser spot: bare → spiral (radius grows with coverage); patterned → line sweeping in z
    const sx = bare ? 0.15 * k : 0;
    const sz = bare ? 0 : lerp(-0.15, 0.15, k);
    if (spot.current) {
      spot.current.visible = scanning && bare;
      spot.current.position.set(sx, WY + 0.0012, 0);
    }
    if (line.current) {
      line.current.visible = scanning && !bare;
      line.current.position.set(0, WY + 0.0012, sz);
    }
    if (beam.current) {
      beam.current.visible = scanning;
      _to.set(sx, WY, sz);
      beam.current.position.copy(_from).add(_to).multiplyScalar(0.5);
      beam.current.scale.set(1, _from.distanceTo(_to), 1);
      beam.current.quaternion.setFromUnitVectors(_up, _dir.copy(_to).sub(_from).normalize());
    }
    if (box.current) box.current.visible = bare;
  });
  return (
    <group>
      <Static parts={model} view={view} />
      <Clickable sel={{ kind: 'machine', id: 'surface-inspection', label: bare ? 'Surface scanner' : 'Patterned-wafer inspection' }}>
        {/* base, enclosure walls and roof (pick proxies; the visible model is merged above) */}
        <Pick p={[0, 0.45, 0]} s={[1.7, 0.9, 1.3]} />
        <Pick p={[0, 1.37, -0.6]} s={[1.24, 0.9, 0.04]} />
        <Pick p={[-0.6, 1.37, 0]} s={[0.04, 0.9, 1.24]} />
        <Pick p={[0, 1.9, -0.02]} s={[1.24, 0.17, 1.24]} />
        {view === 'normal' && <Pick p={[0, 1.37, 0.6]} s={[1.24, 0.9, 0.04]} />}
        {view === 'normal' && <Pick p={[0.6, 1.47, 0]} s={[0.04, 0.62, 1.24]} />}
        <Clickable sel={{ kind: 'component', id: 'laser', machine: 'surface-inspection', label: 'Laser source' }}>
          <group position={LASER} rotation={LASER_ROT}>
            <Pick p={[-0.11, 0.01, 0]} s={[0.24, 0.12, 0.11]} />
          </group>
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'collectors', machine: 'surface-inspection', label: 'Dark-field collectors' }}>
          {COLLECTORS.map((a, i) => (
            <group key={i} position={[Math.cos(a) * 0.32, 1.35, Math.sin(a) * 0.32]} rotation={[Math.sin(a) * 0.8, 0, -Math.cos(a) * 0.8]}>
              <Pick p={[0, 0.05, 0]} s={[0.11, 0.25, 0.11]} />
            </group>
          ))}
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'stage', machine: 'surface-inspection', label: bare ? 'Spin stage' : 'XY stage' }}>
          <Pick p={[0, 0.965, 0]} s={[0.6, 0.07, 0.6]} />
        </Clickable>
        <SignalTower position={[0.52, EN.y1 + 0.006, -0.5]} />
      </Clickable>
      <group ref={wafer}>
        <group ref={spin}>
          <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184' }}>
            <mesh geometry={waferGeometry()} material={waferMat} castShadow />
            <mesh position={[0, 0.0005, 0]} rotation={[-Math.PI / 2, 0, 0]} material={top}>
              <circleGeometry args={[0.149, 64]} />
            </mesh>
          </Clickable>
        </group>
        {!bare && <DieMap />}
      </group>
      <mesh ref={beam} material={laserMat}>
        <cylinderGeometry args={[0.0025, 0.0025, 1, 6]} />
      </mesh>
      <mesh ref={spot} material={spotMat}>
        <cylinderGeometry args={[0.006, 0.006, 0.001, 12]} />
      </mesh>
      <mesh ref={line} material={spotMat}>
        <boxGeometry args={[0.3, 0.0008, 0.003]} />
      </mesh>
      {/* shipping box for accepted prime wafers */}
      <group ref={box} position={[-0.95, 0.9, 0.35]}>
        <Static parts={shipper} />
      </group>
    </group>
  );
}

/* ---------------------------------------------------------------- screens */

function ParetoScreen({ bare }: { bare: boolean }) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    if (bare) c.Particle = 6;
    else for (const d of engine.waferMap) if (d.result !== 'PASS') c[d.defect ?? 'Particle'] = (c[d.defect ?? 'Particle'] ?? 0) + 1;
    return DEFECT_CLASSES.map((k) => [k, c[k] ?? 0] as [string, number]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  }, [bare]);
  return (
    <group position={[1.35, 0, -0.45]} rotation={[0, -0.55, 0]}>
      <Screen
        size={[0.66, 0.44]}
        position={[0, 1.52, 0.03]}
        hz={4}
        draw={(g, w, h) => {
          const k = scanK();
          clear(g, w, h, bare ? 'LIGHT-POINT DEFECTS · SIMULATED' : 'DEFECT PARETO · SIMULATED');
          const total = counts.reduce((a, [, n]) => a + n, 0);
          bigNumber(g, 'COVERAGE', (k * 100).toFixed(0), '%', w * 0.05, h * 0.2, h * 0.09);
          bigNumber(g, 'DEFECTS', Math.round(total * k).toFixed(0), '', w * 0.4, h * 0.2, h * 0.09, total * k > 15 ? SCR.warn : SCR.text);
          bigNumber(g, 'VERDICT', bare ? (pp('classify') > 0.5 ? 'PRIME · PASS' : '…') : pp('map') > 0 ? 'MAP READY' : '…', '', w * 0.66, h * 0.2, h * 0.06, SCR.good);
          const max = Math.max(1, ...counts.map(([, n]) => n));
          const classify = pp('classify') > 0;
          counts.slice(0, 6).forEach(([name, n], i) => {
            const y = h * (0.42 + i * 0.09);
            const bw = (w * 0.5 * n * (classify ? 1 : k)) / max;
            g.fillStyle = SCR.dim;
            g.font = `${Math.round(h * 0.045)}px monospace`;
            g.fillText(name.toUpperCase(), w * 0.05, y + h * 0.045);
            g.fillStyle = classify ? CLASS_COLOR[name] ?? SCR.data : SCR.data;
            g.fillRect(w * 0.4, y, Math.max(2, bw), h * 0.06);
            g.fillStyle = SCR.text;
            g.fillText(String(n), w * 0.42 + bw, y + h * 0.045);
          });
        }}
      />
    </group>
  );
}

export default function InspectionScene({ stage }: SceneProps) {
  const bare = stage.variant === 'bare';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.3;
  }, []);
  return (
    <>
      <Lighting env="cleanroom" shadowExtent={5} />
      <CleanroomBay width={11} depth={8} height={4.2} />
      <Tool bare={bare} />
      <ParetoScreen bare={bare} />
      <SensorIndicator id="scatter-detector" channel={bare ? 'lpd' : 'defects'} machine="surface-inspection" position={[0.3, 1.5, 0.25]} size={0.035} />
      <TechLabel
        position={[-0.9, 2.1, 0.2]}
        title={bare ? 'PRIME WAFER QUALIFICATION' : 'PATTERNED-WAFER INSPECTION'}
        lines={[bare ? 'laser spot spirals over the spinning wafer' : 'laser line sweeps; scattered light reveals anomalies']}
        min={1}
        value={() => engine.player.view.phase.label}
      />
      <TechLabel position={[0.2, 1.25, 0.3]} title="CLICK A DIE ON THE MAP" min={1} show={() => !bare && inPhase('map')} />
      <Operator position={[-1.2, 0, 1.6]} rotation={Math.PI * 0.85} still />
    </>
  );
}

