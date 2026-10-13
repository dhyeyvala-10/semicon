'use client';
/**
 * Metrology (§40): a combined, generic metrology tool with four heads on one bridge —
 * CD-SEM (line width), ellipsometer (film thickness), overlay microscope (layer-to-layer
 * placement) and AFM (surface profile); then etch depth. The stage brings the wafer under
 * each head; the inset shows what that instrument actually "sees". Values are SIMULATED and
 * come from the same ground truth that built the structures (METRO).
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Lighting, CleanroomBay } from '../environments';
import { GEO } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Inset } from '../parts/section';
import { waferGeometry } from '../parts/wafer';
import { Screen, clear, plot, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { waferTexture } from '../textures';
import { Kit, cabinet, flange, boltCircle, bellows, grille, hmi, estop, ledStrip, cableTray, foot, windowPane, type BakedPart, type PartOpts, type V3 } from '../kit/build';
import { KM } from '../kit/finish';
import { useKit } from '../kit/Baked';
import { casterGeometry, shadowOnly } from '../kit/shadow';
import { engine } from '@/simulation/engine';
import { cutPlane, track } from '@/lib/runtime';
import { clamp, smooth, rng } from '@/lib/math';
import { METRO } from '@/simulation/models';

const HEADS: Record<string, { x: number; label: string; id: string }> = {
  cd: { x: -0.48, label: 'CD-SEM', id: 'cdsem' },
  film: { x: -0.16, label: 'ELLIPSOMETER', id: 'ellipsometer' },
  overlay: { x: 0.16, label: 'OVERLAY', id: 'overlay' },
  profile: { x: 0.48, label: 'AFM', id: 'afm' },
  depth: { x: -0.48, label: 'CD-SEM (tilt)', id: 'cdsem' },
};
const ORDER = ['cd', 'film', 'overlay', 'profile', 'depth'];
const WY = 1.0;
/** ellipsometer: angle of incidence (from the wafer normal), beam length, beam plane z */
const EL = { aoi: 0.7, len: 0.2, z: -0.05 };

function activeHead() {
  return HEADS[engine.player.view.phaseId] ?? HEADS.cd;
}

/* ---------------------------------------------------------------- static model (kit) */

const Z0: V3 = [0, 0, 0];
const HP = Math.PI / 2;

/** Hard-edged surface of revolution: one band per profile edge (crisp machined steps). */
function crisp(k: Kit, m: THREE.Material, p: [number, number][], pos: V3 = Z0, rot: V3 = Z0, seg = 40, o: PartOpts = {}) {
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i];
    const b = p[i + 1];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6) k.lathe(m, [a, b], pos, rot, seg, o);
  }
}

/** Knurled ring (thumb wheels, rotation stages) around local Y. */
function knurl(k: Kit, m: THREE.Material, r: number, h: number, pos: V3, n = 18) {
  k.cyl(m, r, h, pos, Z0, 28);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    k.box(m, [0.0025, h * 0.9, 0.003], [pos[0] + Math.cos(a) * r, pos[1], pos[2] + Math.sin(a) * r], [0, -a, 0], { cast: false });
  }
}

/** Machine base, vibration isolators, granite, interferometers, granite bridge. */
function buildBase(k: Kit) {
  cabinet(k, { size: [2.0, 0.74, 1.4], panels: 3, rows: [0.3], sidePanels: 2, handles: true });
  const zf = 0.7015;
  k.label('model', 'MX-4', 'INTEGRATED METROLOGY · 300 mm', 0.36, 0.09, [-0.66, 0.53, zf]);
  ledStrip(k, 0.32, [0, 0.6, zf]);
  k.label('warn', 'LASER', '', 0.07, 0.07, [0.46, 0.53, zf]);
  estop(k, [0.66, 0.53, 0.7]);
  // facility side (+X): exhaust grille, bulkhead fittings, tagged supply lines into the floor
  k.at([1.0, 0, 0], HP, () => {
    grille(k, 0.46, 0.16, [0.25, 0.5, 0.002]);
    k.rbox(KM.stainless, [0.3, 0.14, 0.012], 0.004, [-0.3, 0.2, 0.006]);
    for (const x of [-0.39, -0.3, -0.21]) {
      k.cyl(KM.stainlessDark, 0.017, 0.012, [x, 0.2, 0.018], [HP, 0, 0], 6);
      k.cyl(KM.stainless, 0.012, 0.05, [x, 0.2, 0.04], [HP, 0, 0], 16);
    }
    k.label('gas', 'CDA', '', 0.07, 0.018, [-0.36, 0.3, 0.0125], Z0, '#2f5d8a');
    k.label('gas', 'VAC', '', 0.07, 0.018, [-0.24, 0.3, 0.0125], Z0, '#5a5f66');
  });
  for (const z of [0.39, 0.3, 0.21]) {
    k.pipe(KM.stainless, [[1.06, 0.2, z], [1.12, 0.2, z], [1.12, 0.0, z]], 0.01, 0.04);
    k.cyl(KM.stainlessDark, 0.024, 0.01, [1.12, 0.005, z], Z0, 16, { cast: false });
  }
  // pneumatic vibration isolators between the frame and the granite
  for (const x of [-0.72, 0.72])
    for (const z of [-0.4, 0.4]) {
      k.cyl(KM.anodizedDark, 0.075, 0.012, [x, 0.768, z], Z0, 28);
      bellows(k, 0.062, 0.022, 3, [x, 0.774, z], KM.rubber);
      k.cyl(KM.anodized, 0.07, 0.006, [x, 0.797, z], Z0, 28);
    }
  // granite base (stage reference surface)
  k.rbox(KM.paintDark, [1.86, 0.12, 1.1], 0.012, [0, 0.86, 0]);
  k.box(KM.seam, [1.84, 0.004, 0.002], [0, 0.903, 0.5505], Z0, { cast: false });
  // granite hold-down clamps at the corners
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      k.rbox(KM.anodizedDark, [0.07, 0.17, 0.03], 0.005, [sx * 0.6, 0.847, sz * 0.567]);
      k.rbox(KM.anodizedDark, [0.07, 0.012, 0.05], 0.004, [sx * 0.6, 0.926, sz * 0.557]);
      k.cyl(KM.stainlessDark, 0.007, 0.006, [sx * 0.6, 0.935, sz * 0.557], Z0, 6, { cast: false });
    }
  // laser interferometer heads reading the stage mirrors (X at the side, Y at the back)
  k.rbox(KM.anodizedDark, [0.1, 0.05, 0.07], 0.006, [0.845, 0.947, 0.05]);
  k.cyl(KM.chrome, 0.012, 0.02, [0.79, 0.955, 0.05], [0, 0, HP], 16);
  k.rbox(KM.anodizedDark, [0.07, 0.05, 0.1], 0.006, [-0.1, 0.947, -0.49]);
  k.cyl(KM.chrome, 0.012, 0.02, [-0.1, 0.955, -0.435], [HP, 0, 0], 16);
  // granite bridge: posts on plinths, beam, linear guide, head carriages
  for (const s of [-1, 1]) {
    k.rbox(KM.paintDark, [0.18, 0.05, 0.26], 0.008, [s * 0.85, 0.945, -0.25]);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.cyl(KM.stainlessDark, 0.007, 0.006, [s * 0.85 + dx * 0.065, 0.973, -0.25 + dz * 0.105], Z0, 6, { cast: false });
    k.rbox(KM.paintDark, [0.14, 0.84, 0.18], 0.01, [s * 0.85, 1.39, -0.25]);
  }
  k.rbox(KM.paintDark, [1.84, 0.16, 0.16], 0.01, [0, 1.88, -0.25]);
  k.box(KM.stainlessDark, [1.66, 0.014, 0.01], [0, 1.935, -0.166]);
  k.box(KM.seam, [1.8, 0.002, 0.002], [0, 1.812, -0.169], Z0, { cast: false });
  for (let i = 0; i < 16; i++) k.cyl(KM.stainlessDark, 0.005, 0.004, [-0.82 + i * 0.1093, 1.948, -0.159], [HP, 0, 0], 6, { cast: false });
  k.label('model', 'MX-4', 'INTEGRATED METROLOGY · 300 mm', 0.2, 0.05, [0.69, 1.885, -0.1695]);
  for (const key of ['cd', 'film', 'overlay', 'profile']) {
    const x = HEADS[key].x;
    // carriage under the beam, head plate, status LED bezel
    k.rbox(KM.anodizedDark, [0.16, 0.03, 0.14], 0.005, [x, 1.785, -0.25]);
    k.rbox(KM.paintGrey, [0.2, 0.455, 0.02], 0.006, [x, 1.6275, -0.16]);
    for (const [dx, y] of [[-0.08, 1.43], [0.08, 1.43], [-0.08, 1.83], [0.08, 1.83]]) k.cyl(KM.stainlessDark, 0.006, 0.005, [x + dx, y, -0.148], [HP, 0, 0], 6, { cast: false });
    k.cyl(KM.anodizedDark, 0.027, 0.008, [x, 1.88, -0.168], [HP, 0, 0], 20, { cast: false });
  }
  // signal-tower mount, cable tray on the beam, cables down the back of the left post
  k.rbox(KM.anodizedDark, [0.07, 0.04, 0.07], 0.006, [0.85, 1.98, -0.25]);
  cableTray(k, [-0.72, 1.962, -0.25], [0.7, 1.962, -0.25], 0.1, 3);
  for (const dx of [-0.025, 0.025])
    k.pipe(KM.plastic, [[-0.72, 1.985, -0.25 + dx], [-0.85 + dx, 1.985, -0.25 + dx], [-0.85 + dx, 1.985, -0.37], [-0.85 + dx, 0.99, -0.37], [-0.85 + dx, 0.99, -0.62], [-0.85 + dx, 0.765, -0.62]], 0.011, 0.05);
  for (const y of [1.25, 1.55]) k.rbox(KM.anodizedDark, [0.1, 0.018, 0.03], 0.004, [-0.85, y, -0.355]);
  // operator HMI on a post at the front-left corner
  k.cyl(KM.anodizedDark, 0.035, 0.012, [-0.92, 0.768, 0.62], Z0, 20);
  k.cyl(KM.anodized, 0.02, 0.54, [-0.92, 1.04, 0.62], Z0, 16);
  hmi(k, [-0.92 + 0.22 * Math.sin(-0.35), 1.3, 0.62 + 0.22 * Math.cos(-0.35)], -0.35);
}

/** CD-SEM electron column: pole piece, objective, scan/condenser sections, gun, ion pump, HV cable. */
function buildSem(k: Kit) {
  k.at([HEADS.cd.x, 0, -0.02], 0, () => {
    crisp(k, KM.stainless, [[0.004, 1.03], [0.012, 1.03], [0.03, 1.07], [0.052, 1.1], [0.07, 1.135], [0.07, 1.16]]);
    crisp(k, KM.paint, [[0.07, 1.16], [0.085, 1.17], [0.085, 1.285]]);
    k.torus(KM.stainlessDark, 0.071, 0.003, [0, 1.15, 0], Z0, 40);
    flange(k, 0.078, 1.29, { bolts: 12 });
    k.cyl(KM.paint, 0.07, 0.18, [0, 1.385, 0], Z0, 40);
    flange(k, 0.066, 1.48, { bolts: 10 });
    k.cyl(KM.paintGrey, 0.062, 0.16, [0, 1.565, 0], Z0, 40);
    flange(k, 0.07, 1.65, { bolts: 10 });
    k.cyl(KM.paint, 0.094, 0.13, [0, 1.72, 0], Z0, 40);
    flange(k, 0.094, 1.79, { bolts: 12 });
    k.label('tag', 'COLUMN 2', '1 kV · 8 pA', 0.05, 0.0125, [0, 1.42, 0.0705]);
    k.label('warn', 'HIGH VOLTAGE', '', 0.05, 0.05, [0, 1.72, 0.0955]);
    // HV insulator, cable gland, cable over the beam into the tray
    k.cyl(KM.ptfe, 0.04, 0.07, [0, 1.835, 0], Z0, 24);
    for (const y of [1.812, 1.828, 1.844, 1.86]) k.torus(KM.ptfe, 0.043, 0.004, [0, y, 0], Z0, 24);
    k.cyl(KM.stainlessDark, 0.024, 0.02, [0, 1.88, 0], Z0, 16);
    k.tube(KM.plastic, [[0, 1.89, 0], [0, 1.95, -0.01], [0, 2.0, -0.08], [0, 2.0, -0.23]], 0.011);
    // ion pump on the gun chamber (magnet plates, HV feed)
    k.cyl(KM.stainless, 0.02, 0.05, [-0.115, 1.7, 0], [0, 0, HP], 20);
    k.rbox(KM.stainless, [0.05, 0.12, 0.1], 0.006, [-0.155, 1.7, 0]);
    for (const s of [-1, 1]) k.box(KM.paintGraphite, [0.054, 0.1, 0.006], [-0.155, 1.7, s * 0.053]);
    k.cyl(KM.ptfe, 0.01, 0.03, [-0.155, 1.775, 0], Z0, 12);
    k.tube(KM.plastic, [[-0.155, 1.79, 0], [-0.16, 1.9, -0.04], [-0.1, 2.0, -0.12], [-0.06, 2.0, -0.23]], 0.007);
    // clamp collars to the head plate
    for (const y of [1.45, 1.6]) k.rbox(KM.anodizedDark, [0.07, 0.05, 0.08], 0.006, [0, y, -0.095]);
    // secondary-electron detector port and vacuum gauge
    k.at([-0.06, 1.25, 0.05], [0.5, 0, 0.7], () => {
      k.cyl(KM.stainless, 0.015, 0.07, [0, 0.03, 0], Z0, 16);
      k.cyl(KM.stainless, 0.024, 0.012, [0, 0.065, 0], Z0, 20);
    });
    k.cyl(KM.stainless, 0.012, 0.05, [0, 1.56, 0.08], [HP, 0, 0], 16);
    k.cyl(KM.anodizedDark, 0.02, 0.045, [0, 1.56, 0.125], [HP, 0, 0], 20);
    // lens cooling water: two fittings, hoses up to the beam
    for (const [i, dx] of [-0.115, -0.135].entries()) {
      k.cyl(KM.stainlessDark, 0.008, 0.03, [-0.06 - i * 0.02, 1.22, -0.065], [HP * 0.6, 0, 0], 10);
      k.tube(KM.plastic, [[-0.06 - i * 0.02, 1.23, -0.075], [dx, 1.32, -0.1], [dx, 1.75, -0.12], [dx, 2.0, -0.2]], 0.006);
    }
  });
}

/** Spectroscopic ellipsometer: goniometer arc, source (lamp + polariser) and analyser arms, spectrometer. */
function buildEllipsometer(k: Kit) {
  const x0 = HEADS.film.x;
  k.at([x0, WY, EL.z], 0, () => {
    // goniometer arc behind the beam plane, with graduation ticks
    const arc: [number, number][] = [];
    const n = 28;
    const a0 = 0.61;
    const a1 = Math.PI - 0.61;
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      arc.push([Math.cos(a) * 0.262, Math.sin(a) * 0.262]);
    }
    for (let i = n; i >= 0; i--) {
      const a = a0 + ((a1 - a0) * i) / n;
      arc.push([Math.cos(a) * 0.232, Math.sin(a) * 0.232]);
    }
    k.extrude(KM.anodized, arc, 0.012, [0, 0, -0.072]);
    for (let i = 0; i <= 12; i++) {
      const a = a0 + 0.12 + ((a1 - a0 - 0.24) * i) / 12;
      k.box(KM.seam, [0.0018, i % 3 ? 0.008 : 0.014, 0.001], [Math.cos(a) * 0.256, Math.sin(a) * 0.256, -0.0595], [0, 0, a - HP], { cast: false });
    }
    // arms: s = -1 source (left), +1 analyser (right); module axis is local +Y after the tilt
    for (const s of [-1, 1]) {
      k.at(Z0, [0, 0, -s * EL.aoi], () => {
        const t = EL.len;
        k.cyl(KM.anodizedDark, 0.014, 0.024, [0, t + 0.012, 0], Z0, 20);
        knurl(k, KM.anodized, 0.024, 0.018, [0, t + 0.033, 0]);
        k.cyl(KM.anodizedDark, 0.02, 0.04, [0, t + 0.062, 0], Z0, 24);
        k.rbox(KM.anodized, [0.036, 0.04, 0.05], 0.004, [0, t + 0.05, -0.045]);
        if (s < 0) {
          k.rbox(KM.paintGraphite, [0.05, 0.03, 0.05], 0.006, [0, t + 0.097, 0]);
          for (let i = 0; i < 3; i++) k.box(KM.paintGraphite, [0.058, 0.003, 0.058], [0, t + 0.087 + i * 0.01, 0], Z0, { cast: false });
        } else k.cyl(KM.stainless, 0.01, 0.03, [0, t + 0.097, 0], Z0, 16);
      });
    }
    // post up to the head plate, spectrometer housing, yellow fibres
    k.rbox(KM.anodized, [0.05, 0.3, 0.035], 0.006, [0, 0.4, -0.07]);
    k.rbox(KM.anodizedDark, [0.08, 0.06, 0.05], 0.006, [0, 0.47, -0.09]);
    k.rbox(KM.paint, [0.075, 0.13, 0.06], 0.008, [0.07, 0.56, -0.08]);
    k.box(KM.seam, [0.05, 0.003, 0.001], [0.07, 0.6, -0.0495], Z0, { cast: false });
    ledStrip(k, 0.03, [0.07, 0.53, -0.048], KM.ledGreen);
    const c = Math.cos(EL.aoi);
    const sn = Math.sin(EL.aoi);
    const tip = EL.len + 0.112;
    k.tube(KM.paintYellow, [[sn * tip, c * tip, 0], [sn * tip + 0.02, c * tip + 0.08, -0.02], [0.12, 0.5, -0.06], [0.08, 0.53, -0.08]], 0.005);
    k.tube(KM.plastic, [[-sn * (tip - 0.01), c * (tip - 0.01), 0.02], [-sn * tip - 0.03, c * tip + 0.08, 0.0], [-0.07, 0.55, -0.05], [-0.02, 0.62, -0.09]], 0.006);
  });
}

/** Overlay microscope: objective, nosepiece, beam-splitter, tube lens, camera, illuminator, focus drive. */
function buildOverlay(k: Kit) {
  k.at([HEADS.overlay.x, 0, -0.02], 0, () => {
    crisp(k, KM.chrome, [[0.009, 1.06], [0.014, 1.062], [0.02, 1.075], [0.024, 1.09], [0.024, 1.14], [0.028, 1.145], [0.028, 1.175]], Z0, Z0, 28);
    k.torus(KM.paintRed, 0.0245, 0.0018, [0, 1.12, 0], Z0, 28);
    crisp(k, KM.anodized, [[0.028, 1.175], [0.062, 1.18], [0.066, 1.198], [0.052, 1.212], [0.04, 1.218]], Z0, Z0, 36);
    for (const a of [4.0, 5.4]) {
      const cx = Math.cos(a);
      const cz = Math.sin(a);
      k.at([cx * 0.038, 1.185, cz * 0.038], [-0.45 * cz, 0, 0.45 * cx], () => {
        k.cyl(KM.chrome, 0.02, 0.05, [0, -0.025, 0], Z0, 20);
        k.cyl(KM.chrome, 0.013, 0.01, [0, -0.055, 0], Z0, 16);
      });
    }
    k.cyl(KM.paint, 0.045, 0.14, [0, 1.288, 0], Z0, 32);
    k.rbox(KM.paint, [0.1, 0.08, 0.1], 0.01, [0, 1.398, 0]);
    // Koehler illuminator arm and lamp house (+X), fibre light guide to the beam
    k.cyl(KM.anodizedDark, 0.02, 0.08, [0.09, 1.398, 0], [0, 0, HP], 20);
    k.rbox(KM.paintGraphite, [0.05, 0.06, 0.06], 0.008, [0.155, 1.398, 0]);
    for (let i = 0; i < 3; i++) k.box(KM.paintGraphite, [0.054, 0.004, 0.064], [0.155, 1.378 + i * 0.02, 0], Z0, { cast: false });
    k.tube(KM.plastic, [[0.18, 1.4, 0], [0.2, 1.46, -0.02], [0.2, 1.75, -0.1], [0.18, 2.0, -0.23]], 0.008);
    k.cyl(KM.paint, 0.038, 0.14, [0, 1.508, 0], Z0, 32);
    k.torus(KM.anodizedDark, 0.039, 0.004, [0, 1.47, 0], Z0, 32);
    k.cyl(KM.anodizedDark, 0.026, 0.02, [0, 1.588, 0], Z0, 24);
    k.rbox(KM.paintGraphite, [0.07, 0.07, 0.07], 0.008, [0, 1.633, 0]);
    for (let i = 0; i < 4; i++) k.box(KM.paintGraphite, [0.074, 0.05, 0.003], [0, 1.633, -0.02 + i * 0.013], [0, HP, 0], { cast: false });
    k.tube(KM.plastic, [[0, 1.668, 0], [0, 1.72, -0.02], [0.03, 1.95, -0.1], [0.03, 2.0, -0.23]], 0.006);
    // focus drive: Z slide and motor on the head plate
    k.rbox(KM.anodized, [0.08, 0.26, 0.04], 0.006, [0, 1.46, -0.075]);
    k.rbox(KM.anodizedDark, [0.06, 0.22, 0.04], 0.006, [0, 1.52, -0.112]);
    k.cyl(KM.anodizedDark, 0.022, 0.06, [0, 1.62, -0.075], Z0, 20);
    knurl(k, KM.anodized, 0.016, 0.012, [0.0, 1.656, -0.075], 12);
  });
}

/** AFM head: piezo tube scanner, head housing with laser / photodiode adjusters, approach motor. */
function buildAfm(k: Kit) {
  k.at([HEADS.profile.x, 0, 0], 0, () => {
    k.cyl(KM.ptfe, 0.022, 0.06, [-0.03, 1.33, -0.02], Z0, 24, { open: true });
    k.cyl(KM.anodizedDark, 0.028, 0.012, [-0.03, 1.366, -0.02], Z0, 24);
    k.rbox(KM.paint, [0.15, 0.22, 0.14], 0.014, [-0.01, 1.48, -0.05]);
    k.box(KM.seam, [0.15, 0.003, 0.002], [-0.01, 1.55, 0.0205], Z0, { cast: false });
    k.label('tag', 'AFM-2', 'TAPPING MODE', 0.09, 0.0225, [-0.01, 1.42, 0.0205]);
    for (const dx of [-0.05, 0.03]) k.at([-0.01 + dx, 1.5, 0.028], [HP, 0, 0], () => knurl(k, KM.anodizedDark, 0.011, 0.016, Z0, 10));
    for (const y of [1.45, 1.51]) k.at([0.073, y, -0.05], [0, 0, -HP], () => knurl(k, KM.anodizedDark, 0.009, 0.012, Z0, 8));
    k.cyl(KM.anodizedDark, 0.03, 0.08, [-0.01, 1.63, -0.05], Z0, 28);
    k.cyl(KM.anodized, 0.026, 0.02, [-0.01, 1.68, -0.05], Z0, 28);
    k.rbox(KM.anodizedDark, [0.1, 0.3, 0.03], 0.006, [-0.01, 1.53, -0.135]);
    k.cyl(KM.stainlessDark, 0.01, 0.02, [0.055, 1.42, -0.05], [0, 0, HP], 12);
    k.tube(KM.plastic, [[0.066, 1.42, -0.05], [0.1, 1.45, -0.06], [0.1, 1.8, -0.12], [0.06, 2.0, -0.23]], 0.007);
  });
}

/** Floor stand for the SPC monitor (local to the screen group): base, column, VESA bracket, rear housing. */
function buildMonitorStand(k: Kit) {
  k.rbox(KM.paintGraphite, [0.46, 0.035, 0.38], 0.012, [0, 0.0175, -0.04]);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) foot(k, [x * 0.19, 0, -0.04 + z * 0.15]);
  k.rbox(KM.anodized, [0.075, 1.5, 0.055], 0.012, [0, 0.785, -0.07]);
  k.box(KM.seam, [0.006, 1.38, 0.002], [0, 0.78, -0.042], Z0, { cast: false });
  k.rbox(KM.anodizedDark, [0.12, 0.12, 0.04], 0.01, [0, 1.55, -0.04]);
  k.rbox(KM.plastic, [0.72, 0.48, 0.03], 0.012, [0, 1.55, -0.008]);
  k.ao(0.46, 0.38, [0, 0, -0.04]);
}

/** A neighbouring metrology tool in the bay: enclosed body, EFEM with load ports, roof details. */
function buildNeighbour(k: Kit, kind: 'sem' | 'ocd') {
  cabinet(k, { size: [1.4, 1.62, 0.86], panels: 2, rows: [0.55], sidePanels: 1, handles: true, ao: false });
  k.at([0, 0, 0.43], 0, () => cabinet(k, { size: [1.4, 1.35, 0.34], panels: 2, rows: [0.82], sidePanels: 1, vent: false, ao: false, stripe: false }));
  k.ao(1.4, 1.2, [0, 0, 0.17]);
  // two load ports with docked carriers on the EFEM front
  for (const [i, x] of [-0.34, 0.34].entries()) {
    k.box(KM.seam, [0.4, 0.34, 0.003], [x, 1.07, 0.6015], Z0, { cast: false });
    k.rbox(KM.paint, [0.36, 0.3, 0.012], 0.006, [x, 1.07, 0.606]);
    k.rbox(KM.anodized, [0.42, 0.035, 0.36], 0.008, [x, 0.88, 0.78]);
    for (const dz of [-0.1, 0.1]) k.cyl(KM.stainlessDark, 0.008, 0.01, [x, 0.902, 0.78 + dz], Z0, 8, { cast: false });
    if (i === 0 || kind === 'sem') {
      k.rbox(KM.ptfe, [0.34, 0.3, 0.32], 0.035, [x, 1.05, 0.78]);
      k.rbox(KM.anodizedDark, [0.2, 0.025, 0.2], 0.006, [x, 1.212, 0.78]);
      for (const s of [-1, 1]) k.rbox(KM.ptfe, [0.02, 0.1, 0.16], 0.006, [x + s * 0.18, 1.07, 0.78]);
    }
  }
  ledStrip(k, 0.24, [0.0, 1.27, 0.6015]);
  estop(k, [0.6, 1.2, 0.6]);
  k.label('model', kind === 'sem' ? 'CD-3' : 'OCD-2', kind === 'sem' ? 'CD-SEM · 300 mm' : 'OPTICAL CD · FILM', 0.3, 0.075, [-0.38, 1.46, 0.2615]);
  // inner side faces the bay: framed viewing window and exhaust grille
  const sx = kind === 'sem' ? 1 : -1;
  k.at([sx * 0.7, 0, -0.17], sx * HP, () => {
    windowPane(k, 0.46, 0.34, [0, 1.15, 0.006], { glass: KM.glassSmoke });
    grille(k, 0.4, 0.14, [0, 0.36, 0.003]);
  });
  // roof
  if (kind === 'sem') {
    k.at([0.25, 1.64, -0.28], 0, () => {
      k.cyl(KM.stainless, 0.1, 0.16, [0, 0.08, 0], Z0, 40);
      flange(k, 0.1, 0.17, { bolts: 12 });
      k.cyl(KM.stainless, 0.075, 0.16, [0, 0.26, 0], Z0, 36);
      flange(k, 0.075, 0.345, { bolts: 10 });
      k.cyl(KM.ptfe, 0.035, 0.07, [0, 0.39, 0], Z0, 24);
      k.tube(KM.plastic, [[0, 0.425, 0], [0, 0.5, -0.05], [-0.3, 0.52, -0.2], [-0.5, 0.02, -0.2]], 0.012);
      k.rbox(KM.stainless, [0.06, 0.14, 0.12], 0.006, [-0.16, 0.26, 0]);
      k.cyl(KM.stainless, 0.02, 0.05, [-0.11, 0.26, 0], [0, 0, HP], 16);
    });
    k.rbox(KM.paintGraphite, [0.5, 0.06, 0.4], 0.01, [-0.35, 1.66, -0.2]);
    grille(k, 0.36, 0.03, [-0.35, 1.66, 0.0]);
  } else {
    k.rbox(KM.paint, [1.2, 0.16, 0.7], 0.012, [0, 1.71, -0.17]);
    grille(k, 0.9, 0.08, [0, 1.71, 0.181]);
    k.label('info', 'FFU', 'HEPA · ULPA 15', 0.12, 0.03, [0.5, 1.71, 0.1815]);
  }
  // stack light
  k.at([0.6, 1.64, -0.5], 0, () => {
    k.cyl(KM.anodizedDark, 0.012, 0.1, [0, 0.05, 0], Z0, 12);
    k.cyl(KM.ledGreen, 0.025, 0.04, [0, 0.12, 0], Z0, 20);
    k.cyl(KM.ptfe, 0.025, 0.04, [0, 0.162, 0], Z0, 20);
    k.cyl(KM.anodizedDark, 0.027, 0.01, [0, 0.187, 0], Z0, 20);
  });
}

/** Planar air-bearing XY stage with the vacuum chuck (moves with the `stage` group). */
function buildStage(k: Kit) {
  for (const [x, z] of [[-0.15, -0.15], [0.15, -0.15], [-0.15, 0.15], [0.15, 0.15]]) k.cyl(KM.anodized, 0.045, 0.014, [x, 0.928, z], Z0, 28);
  k.rbox(KM.anodized, [0.42, 0.026, 0.42], 0.006, [0, 0.948, 0]);
  k.box(KM.chrome, [0.4, 0.028, 0.01], [0, 0.975, -0.205]);
  k.box(KM.chrome, [0.01, 0.028, 0.4], [0.205, 0.975, 0]);
  k.cyl(KM.anodizedDark, 0.165, 0.02, [0, 0.971, 0], Z0, 56);
  boltCircle(k, 0.158, 12, 0.9815, 0.005);
  k.cyl(KM.ptfe, 0.152, 0.018, [0, 0.9905, 0], Z0, 64);
  k.rbox(KM.anodizedDark, [0.06, 0.03, 0.04], 0.005, [-0.12, 0.976, 0.19]);
}

const noRay = () => {};
const PICK = new THREE.MeshBasicMaterial();

/** Static kit meshes, not raycast (selection goes through the pick proxies), one shadow caster. */
function Static({ parts }: { parts: BakedPart[] }) {
  const caster = useMemo(() => {
    const g = casterGeometry(parts.filter((p) => p.cast).map((p) => p.geometry));
    return g ? shadowOnly(g) : null;
  }, [parts]);
  useEffect(() => () => caster?.geometry.dispose(), [caster]);
  return (
    <>
      {parts.map((p, i) => (
        <mesh key={i} geometry={p.geometry} material={p.material} receiveShadow raycast={noRay} />
      ))}
      {caster && <primitive object={caster} />}
    </>
  );
}

/** Invisible pick proxy (box): never drawn, still raycast. */
function Pick({ p, s }: { p: V3; s: V3 }) {
  return <mesh geometry={GEO.box} position={p} scale={s} material={PICK} visible={false} />;
}

/** Everything static in the bay: the tool, the SPC monitor stand, two neighbouring tools. */
function BayModel() {
  const parts = useKit((k) => {
    buildBase(k);
    buildSem(k);
    buildEllipsometer(k);
    buildOverlay(k);
    buildAfm(k);
    k.at([1.55, 0, -0.35], -0.55, () => buildMonitorStand(k));
    k.at([-2.6, 0, -0.5], 0, () => buildNeighbour(k, 'sem'));
    k.at([2.8, 0, -0.5], 0, () => buildNeighbour(k, 'ocd'));
  });
  return <Static parts={parts} />;
}

/* ---------------------------------------------------------------- tool */

const beamMat = new THREE.MeshBasicMaterial({ color: '#c9a6ff', transparent: true, opacity: 0.8, toneMapped: false, depthWrite: false });
const lightMat = new THREE.MeshBasicMaterial({ color: '#f0e08a', transparent: true, opacity: 0.75, toneMapped: false, depthWrite: false });
const ledOn = new THREE.MeshBasicMaterial({ color: '#4fbf3f', toneMapped: false });
const _target = new THREE.Vector3();

function Tool() {
  const wafer = useRef<THREE.Group>(null);
  const stage = useRef<THREE.Group>(null);
  const sem = useRef<THREE.Mesh>(null);
  const ell = useRef<THREE.Group>(null);
  const ovl = useRef<THREE.Mesh>(null);
  const tip = useRef<THREE.Group>(null);
  const leds = useRef<(THREE.Mesh | null)[]>([]);
  const tex = useMemo(() => waferTexture('dies', { size: 512 }), []);
  const top = useMemo(() => new THREE.MeshStandardMaterial({ map: tex, roughness: 0.2, metalness: 0.4 }), [tex]);
  const waferMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.1, metalness: 0.9 }), []);
  const stageParts = useKit(buildStage);
  const pos = useRef(new THREE.Vector3(0, WY, 0.05));
  useFrame((_, dt) => {
    const v = engine.player.view;
    const h = activeHead();
    // the stage moves a measurement site under the active head (a different site per phase)
    const site = ORDER.indexOf(v.phaseId);
    _target.set(h.x + 0.06 * Math.sin(site * 2.1), WY, 0.05 + 0.05 * Math.cos(site * 1.3));
    pos.current.lerp(_target, Math.min(1, dt * 2.5));
    if (wafer.current) wafer.current.position.copy(pos.current);
    if (stage.current) stage.current.position.set(pos.current.x, 0, pos.current.z);
    track('focus', h.x, WY + 0.1, 0);
    const measuring = v.phaseT > 0.15;
    if (sem.current) sem.current.visible = (v.phaseId === 'cd' || v.phaseId === 'depth') && measuring;
    if (ell.current) ell.current.visible = v.phaseId === 'film' && measuring;
    if (ovl.current) ovl.current.visible = v.phaseId === 'overlay' && measuring;
    if (tip.current) {
      const afm = v.phaseId === 'profile';
      tip.current.position.y = afm ? WY + 0.02 + 0.004 * Math.sin(engine.time * 40) : WY + 0.08;
    }
    ['cd', 'film', 'overlay', 'profile'].forEach((k, i) => {
      const m = leds.current[i];
      if (m) m.visible = HEADS[k].id === h.id;
    });
  });
  const ex = Math.sin(EL.aoi) * (EL.len / 2);
  const ey = Math.cos(EL.aoi) * (EL.len / 2);
  return (
    <group>
      <BayModel />
      <Clickable sel={{ kind: 'machine', id: 'metrology', label: 'Metrology tool' }}>
        {/* frame, granite and bridge (pick proxies; the visible model is merged in BayModel) */}
        <Pick p={[0, 0.46, 0]} s={[2.0, 0.92, 1.4]} />
        <Pick p={[-0.85, 1.39, -0.25]} s={[0.14, 0.84, 0.18]} />
        <Pick p={[0.85, 1.39, -0.25]} s={[0.14, 0.84, 0.18]} />
        <Pick p={[0, 1.88, -0.25]} s={[1.84, 0.16, 0.16]} />
        <Clickable sel={{ kind: 'component', id: 'cdsem', machine: 'metrology', label: 'CD-SEM column' }}>
          <Pick p={[HEADS.cd.x - 0.03, 1.46, -0.03]} s={[0.26, 0.86, 0.24]} />
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'ellipsometer', machine: 'metrology', label: 'Ellipsometer' }}>
          <Pick p={[HEADS.film.x, 1.33, -0.08]} s={[0.42, 0.55, 0.14]} />
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'overlay', machine: 'metrology', label: 'Overlay microscope' }}>
          <Pick p={[HEADS.overlay.x + 0.05, 1.37, -0.05]} s={[0.24, 0.62, 0.18]} />
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'afm', machine: 'metrology', label: 'AFM probe' }}>
          <Pick p={[HEADS.profile.x - 0.01, 1.5, -0.06]} s={[0.17, 0.38, 0.2]} />
        </Clickable>
        {['cd', 'film', 'overlay', 'profile'].map((k, i) => (
          <mesh
            key={k}
            ref={(el) => {
              leds.current[i] = el;
            }}
            position={[HEADS[k].x, 1.88, -0.16]}
            material={ledOn}
          >
            <sphereGeometry args={[0.018, 10, 8]} />
          </mesh>
        ))}
        <SignalTower position={[0.85, 2.0, -0.25]} />
      </Clickable>
      {/* AFM cantilever + tip (taps the surface) */}
      <group ref={tip} position={[HEADS.profile.x, WY + 0.08, -0.02]}>
        <mesh geometry={GEO.box} scale={[0.07, 0.006, 0.02]} position={[0, 0.03, 0]} material={KM.stainless} />
        <mesh position={[0.03, 0.012, 0]} rotation={[Math.PI, 0, 0]} material={KM.stainlessDark}>
          <coneGeometry args={[0.006, 0.025, 8]} />
        </mesh>
        <mesh geometry={GEO.box} scale={[0.02, 0.28, 0.02]} position={[-0.03, 0.17, 0]} material={KM.anodized} />
      </group>
      {/* beams */}
      <mesh ref={sem} position={[HEADS.cd.x, (1.03 + WY) / 2, -0.02]} material={beamMat}>
        <cylinderGeometry args={[0.0015, 0.004, 1.03 - WY, 8]} />
      </mesh>
      <group ref={ell}>
        <mesh position={[HEADS.film.x - ex, WY + ey, EL.z]} rotation={[0, 0, EL.aoi]} material={lightMat}>
          <cylinderGeometry args={[0.003, 0.003, EL.len, 6]} />
        </mesh>
        <mesh position={[HEADS.film.x + ex, WY + ey, EL.z]} rotation={[0, 0, -EL.aoi]} material={lightMat}>
          <cylinderGeometry args={[0.003, 0.003, EL.len, 6]} />
        </mesh>
      </group>
      <mesh ref={ovl} position={[HEADS.overlay.x, (1.06 + WY) / 2, -0.02]} material={lightMat}>
        <cylinderGeometry args={[0.012, 0.03, 1.06 - WY, 16, 1, true]} />
      </mesh>
      {/* planar air-bearing stage + wafer */}
      <group ref={stage}>
        <Static parts={stageParts} />
      </group>
      <group ref={wafer}>
        <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184' }}>
          <mesh geometry={waferGeometry()} material={waferMat} castShadow />
          <mesh position={[0, 0.0005, 0]} rotation={[-Math.PI / 2, 0, 0]} material={top}>
            <circleGeometry args={[0.149, 64]} />
          </mesh>
        </Clickable>
      </group>
    </group>
  );
}

/* ---------------------------------------------------------------- instrument views */

const semNoise = (() => {
  const r = rng(91);
  return Array.from({ length: 4000 }, () => [r(), r(), r()] as [number, number, number]);
})();

function drawInstrument(g: CanvasRenderingContext2D, w: number, h: number) {
  const v = engine.player.view;
  const id = v.phaseId;
  const k = v.phaseT;
  g.fillStyle = '#0b100c';
  g.fillRect(0, 0, w, h);
  const ink = (c: string, s = 0.045) => {
    g.fillStyle = c;
    g.font = `${Math.round(h * s)}px monospace`;
  };
  if (id === 'cd') {
    // top-down SEM image: lines with bright edges (secondary-electron edge effect) + shot noise
    const cd = METRO.cdActual();
    const pitch = w / 6;
    for (let x = 0; x < w; x++) {
      const u = (x % pitch) / pitch;
      const line = u > 0.25 && u < 0.75;
      const edge = Math.min(Math.abs(u - 0.25), Math.abs(u - 0.75)) < 0.025;
      const lum = edge ? 225 : line ? 140 : 60;
      g.fillStyle = `rgb(${lum},${lum + 4},${lum - 6})`;
      g.fillRect(x, h * 0.1, 1, h * 0.72);
    }
    for (const [a, b, c] of semNoise) {
      g.fillStyle = `rgba(255,255,240,${c * 0.18})`;
      g.fillRect(a * w, h * 0.1 + b * h * 0.72, 1.5, 1.5);
    }
    // measurement cursors on one line
    const x0 = pitch * 2 + pitch * 0.25;
    const x1 = pitch * 2 + pitch * 0.75;
    g.strokeStyle = SCR.warn;
    g.lineWidth = 2;
    g.setLineDash([6, 4]);
    for (const x of [x0, x1]) {
      g.beginPath();
      g.moveTo(x, h * 0.12);
      g.lineTo(x, h * 0.8);
      g.stroke();
    }
    g.setLineDash([]);
    ink(SCR.text, 0.07);
    g.fillText(k > 0.5 ? `CD = ${cd.toFixed(2)} nm` : 'measuring…', w * 0.04, h * 0.94);
    ink(SCR.dim);
    g.fillText(`target ${METRO.cdTarget} nm · SEM top view · SIMULATED`, w * 0.45, h * 0.94);
    return;
  }
  if (id === 'film') {
    // film stack with the polarised beam reflecting at both interfaces
    const yF = h * 0.45;
    const yS = h * 0.62;
    g.fillStyle = '#6c747e';
    g.fillRect(0, yS, w, h * 0.3);
    g.fillStyle = 'rgba(169,194,160,0.85)';
    g.fillRect(0, yF, w, yS - yF);
    g.strokeStyle = '#f0e08a';
    g.lineWidth = 3;
    const cx = w * 0.5;
    g.beginPath();
    g.moveTo(cx - w * 0.3, h * 0.08);
    g.lineTo(cx, yF);
    g.lineTo(cx + w * 0.3, h * 0.08);
    g.stroke();
    g.globalAlpha = 0.6;
    g.beginPath();
    g.moveTo(cx, yF);
    g.lineTo(cx + w * 0.05, yS);
    g.lineTo(cx + w * 0.1, yF);
    g.lineTo(cx + w * 0.4, h * 0.08);
    g.stroke();
    g.globalAlpha = 1;
    ink(SCR.text, 0.07);
    g.fillText(k > 0.5 ? `t = ${METRO.film.toFixed(1)} nm` : 'fitting Ψ, Δ…', w * 0.04, h * 0.94);
    ink(SCR.dim);
    g.fillText('polarisation change → thickness · SIMULATED', w * 0.4, h * 0.94);
    return;
  }
  if (id === 'overlay') {
    const cx = w * 0.5;
    const cy = h * 0.45;
    const s = h * 0.62;
    g.strokeStyle = '#9fd18a';
    g.lineWidth = h * 0.05;
    g.strokeRect(cx - s / 2, cy - s / 2, s, s);
    const mag = 9; // offset magnified for visibility
    const ox = METRO.overlay.x * mag;
    const oy = -METRO.overlay.y * mag;
    g.strokeStyle = '#d99545';
    g.lineWidth = h * 0.035;
    g.strokeRect(cx - s / 4 + ox, cy - s / 4 + oy, s / 2, s / 2);
    ink(SCR.text, 0.065);
    g.fillText(k > 0.5 ? `x ${METRO.overlay.x.toFixed(1)} nm · y ${METRO.overlay.y.toFixed(1)} nm` : 'imaging targets…', w * 0.04, h * 0.94);
    ink(SCR.dim);
    g.fillText('offset ×9 for visibility', w * 0.62, h * 0.94);
    return;
  }
  if (id === 'profile') {
    // AFM: the tip trace IS the measurement — drawn as the tip moves
    const n = 220;
    const upto = Math.floor(n * k);
    g.strokeStyle = SCR.grid;
    g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      g.beginPath();
      g.moveTo(w * 0.05, h * (0.15 + i * 0.16));
      g.lineTo(w * 0.95, h * (0.15 + i * 0.16));
      g.stroke();
    }
    g.strokeStyle = SCR.data;
    g.lineWidth = 2.5;
    g.beginPath();
    for (let i = 0; i <= upto; i++) {
      const x = i / n;
      const y = METRO.profile(x);
      const px = w * (0.05 + 0.9 * x);
      const py = h * 0.78 - (y / 60) * h * 0.6;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();
    const tx = w * (0.05 + 0.9 * (upto / n));
    const ty = h * 0.78 - (METRO.profile(upto / n) / 60) * h * 0.6;
    g.fillStyle = SCR.warn;
    g.beginPath();
    g.moveTo(tx, ty - 3);
    g.lineTo(tx - 8, ty - 26);
    g.lineTo(tx + 8, ty - 26);
    g.fill();
    ink(SCR.text, 0.065);
    g.fillText(`height ${engine.tele.value('height', 0).toFixed(1)} nm`, w * 0.04, h * 0.94);
    ink(SCR.dim);
    g.fillText('AFM tip trace · lines 45 nm tall · SIMULATED', w * 0.45, h * 0.94);
    return;
  }
  // depth: tilted cross-section view of an etched trench
  g.fillStyle = 'rgba(169,194,160,0.9)';
  g.fillRect(0, h * 0.25, w, h * 0.5);
  g.fillStyle = '#6c747e';
  g.fillRect(0, h * 0.75, w, h * 0.15);
  const d = h * 0.48 * smooth(clamp(k * 1.5));
  g.fillStyle = '#0b100c';
  g.fillRect(w * 0.42, h * 0.25, w * 0.16, d);
  g.strokeStyle = SCR.warn;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(w * 0.64, h * 0.25);
  g.lineTo(w * 0.64, h * 0.25 + d);
  g.stroke();
  ink(SCR.text, 0.065);
  g.fillText(k > 0.5 ? `depth = ${METRO.depth} nm (target 120)` : 'tilting stage…', w * 0.04, h * 0.94);
}

function InstrumentInset() {
  return (
    <Inset id="metro-view" position={[0, 1.65, 0.6]} size={[1.3, 0.85]} mpu={300e-9 / 1.2} title="INSTRUMENT VIEW">
      <Screen size={[1.22, 0.78]} position={[0, 0, 0]} hz={12} res={640} frame={false} draw={(g, w, h) => drawInstrument(g, w, h)} />
      <TechLabel position={[0.42, 0.44, 0.02]} title="ACTIVE HEAD" min={2} value={() => activeHead().label} />
    </Inset>
  );
}

/** Statistical process control chart for the parameter being measured. */
function SPCScreen() {
  const series = useRef<Record<string, number[]>>({});
  return (
    <group position={[1.55, 0, -0.35]} rotation={[0, -0.55, 0]}>
      <Screen
        size={[0.66, 0.42]}
        position={[0, 1.55, 0.03]}
        hz={4}
        draw={(g, w, h) => {
          const id = engine.player.view.phaseId;
          const label = { cd: 'LINE CD', film: 'FILM', overlay: 'OVERLAY', profile: 'AFM HEIGHT', depth: 'ETCH DEPTH' }[id] ?? id;
          clear(g, w, h, `SPC · ${label} · SIMULATED`);
          // representative lot history around the target with ±3σ control limits
          if (!series.current[id]) {
            const r = rng(id.length * 7 + 3);
            const base = id === 'cd' ? 24 : id === 'film' ? 52.4 : id === 'overlay' ? 2.1 : id === 'depth' ? 118 : 30;
            const s = base * 0.02;
            series.current[id] = Array.from({ length: 30 }, () => base + (r() + r() + r() - 1.5) * s * 1.4);
          }
          const data = series.current[id];
          const mean = data.reduce((a, b) => a + b, 0) / data.length;
          const sd = Math.sqrt(data.reduce((a, b) => a + (b - mean) ** 2, 0) / data.length);
          const lo = mean - 4 * sd;
          const hi = mean + 4 * sd;
          plot(g, data, w * 0.06, h * 0.32, w * 0.88, h * 0.56, lo, hi, SCR.data);
          for (const [val, col] of [
            [mean + 3 * sd, SCR.warn],
            [mean - 3 * sd, SCR.warn],
            [mean, SCR.dim],
          ] as [number, string][]) {
            const y = h * 0.32 + h * 0.56 - ((val - lo) / (hi - lo)) * h * 0.56;
            g.strokeStyle = col;
            g.setLineDash([5, 4]);
            g.beginPath();
            g.moveTo(w * 0.06, y);
            g.lineTo(w * 0.94, y);
            g.stroke();
            g.setLineDash([]);
          }
          bigNumber(g, 'MEAN', mean.toFixed(2), '', w * 0.06, h * 0.17, h * 0.08);
          bigNumber(g, 'σ', sd.toFixed(2), '', w * 0.4, h * 0.17, h * 0.08);
          bigNumber(g, 'STATUS', 'IN CONTROL', '', w * 0.66, h * 0.17, h * 0.06, SCR.good);
        }}
      />
    </group>
  );
}

export default function MetrologyScene() {
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.3;
  }, []);
  return (
    <>
      <Lighting env="cleanroom" shadowExtent={5} />
      <CleanroomBay width={11} depth={8} height={4.2} />
      <Tool />
      <InstrumentInset />
      <SPCScreen />
      <SensorIndicator id="ellipsometer" channel="film" machine="metrology" position={[HEADS.film.x, 1.32, 0.02]} size={0.03} />
      <TechLabel
        position={[-1.0, 2.15, 0.1]}
        title="METROLOGY · MEASURE, DON'T TOUCH"
        lines={['CD-SEM · ellipsometer · overlay · AFM']}
        min={1}
        value={() => `${activeHead().label} · ${engine.player.view.phase.label}`}
      />
      <Operator position={[-1.3, 0, 1.6]} rotation={Math.PI * 0.85} still />
    </>
  );
}

