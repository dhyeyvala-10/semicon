'use client';
/**
 * Ion implantation (§30) — generic high-current implanter:
 *   ion source → extraction → analyzer magnet (only the selected mass passes the slit) →
 *   acceleration column (energy sets depth) → beam scanner + parallelizing lens →
 *   end station: the beam sweeps across the wafer while the wafer moves vertically.
 * The inset shows ions stopping at statistical depths, only where the resist mask is open.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { Lighting, CleanroomBay } from '../environments';
import type { ViewMode } from '@/types';
import { M, shell, effectiveView } from '../materials';
import { GEO, Tube } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Inset, ProfileSlab, rect } from '../parts/section';
import { waferGeometry, useModel, ModelView, ModelPick, type MergedModel } from '../parts/wafer';
import { Screen, clear, plot, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { Kit, type PartOpts, cabinet, flange, viewport, bellows, boltCircle, grille, gasStick, hmi, estop, ledStrip, hose, cableTray } from '../kit/build';
import { KM } from '../kit/finish';
import { shadowOnly } from '../kit/shadow';
import { engine } from '@/simulation/engine';
import { pp, inPhase, pdt } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { clamp, lerp, smooth, rng } from '@/lib/math';
import { implantIons, IMPLANT } from '@/simulation/models';
import type { V3 } from '../parts/primitives';

const Y = 1.25; // beam height
const MC = new THREE.Vector3(-0.6, Y, -0.6); // analyzer magnet arc centre
const RM = 0.6; // selected-ion bend radius
const SRC_Z = -1.95;
const SCAN_X = 1.2;
const LENS_X = 1.95;
const WX = 3.1; // wafer plane (end station)

const beamMat = new THREE.MeshBasicMaterial({ color: '#ffcf7a', transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
const ionSel = new THREE.MeshBasicMaterial({ color: '#ffd28a', toneMapped: false });
const ionLight = new THREE.MeshBasicMaterial({ color: '#9fd18a', toneMapped: false });
const ionHeavy = new THREE.MeshBasicMaterial({ color: '#b9b4c8', toneMapped: false });
const plasmaMat = new THREE.MeshBasicMaterial({ color: '#ffb36b', transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);

/** Point on the analyzer arc for angle fraction u ∈ [0,1] at radius r. */
function arcPoint(u: number, r: number, out = new THREE.Vector3()) {
  const th = -Math.PI / 2 + (u * Math.PI) / 2; // entry at θ=-π/2 (x−), exit at θ=0 (z+)
  return out.set(MC.x + r * Math.sin(th), Y, MC.z + r * Math.cos(th));
}

const ARC: V3[] = Array.from({ length: 25 }, (_, i) => arcPoint(i / 24, RM).toArray() as V3);
const BEAM_IN: V3[] = [
  [MC.x - RM, Y, SRC_Z + 0.2],
  [MC.x - RM, Y, MC.z],
];
const BEAM_OUT: V3[] = [
  [MC.x, Y, MC.z + RM],
  [SCAN_X, Y, 0],
];

/* ---------------------------------------------------------------- beam */

function beamOn() {
  return engine.tele.value('current', 0) > 0.2;
}

/** scan state: horizontal beam position on the wafer (m) and vertical wafer offset */
function scan() {
  const t = engine.time;
  const implanting = inPhase('implant');
  return {
    z: implanting ? 0.16 * Math.sin(t * 9) : 0,
    y: implanting ? 0.16 * Math.sin(engine.player.view.phaseT * Math.PI * 6) : 0,
  };
}

const FA = new THREE.Vector3();
const FB = new THREE.Vector3();

function Beam() {
  const stat = useRef<THREE.Group>(null);
  const fan1 = useRef<THREE.Mesh>(null);
  const fan2 = useRef<THREE.Mesh>(null);
  const spot = useRef<THREE.Mesh>(null);
  const N = 90;
  const ions = useRef<THREE.InstancedMesh>(null);
  const light = useRef<THREE.InstancedMesh>(null);
  const heavy = useRef<THREE.InstancedMesh>(null);
  const seeds = useMemo(() => {
    const r = rng(21);
    return Array.from({ length: N }, () => ({ o: r(), k: r(), s: 0.8 + r() * 0.4 }));
  }, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const t = useRef(0);
  useFrame((_, dt) => {
    t.current += pdt(dt);
    const on = beamOn();
    beamMat.opacity = 0.3 + 0.25 * clamp(engine.tele.value('current', 0) / 5);
    if (stat.current) stat.current.visible = on;
    const sc = scan();
    // fan: scanner deflects, lens makes the beam parallel again
    const zLens = sc.z;
    if (fan1.current) {
      fan1.current.visible = on;
      const a = FA.set(SCAN_X, Y, 0);
      const b = FB.set(LENS_X, Y, zLens);
      fan1.current.position.copy(a).add(b).multiplyScalar(0.5);
      fan1.current.scale.set(a.distanceTo(b), 1, 1);
      fan1.current.rotation.set(0, -Math.atan2(b.z - a.z, b.x - a.x), 0);
    }
    if (fan2.current) {
      fan2.current.visible = on;
      fan2.current.position.set((LENS_X + WX) / 2, Y, zLens);
      fan2.current.scale.set(WX - LENS_X, 1, 1);
    }
    if (spot.current) {
      spot.current.visible = on && inPhase('implant');
      spot.current.position.set(WX - 0.004, Y, sc.z);
    }
    // ions in the analyzer magnet: selected mass follows the arc, lighter bend more, heavier less
    for (let i = 0; i < N; i++) {
      const s = seeds[i];
      const u = (t.current * 0.9 * s.s + s.o) % 1;
      for (const m of [ions.current, light.current, heavy.current]) m?.setMatrixAt(i, HIDE);
      if (!on) continue;
      if (s.k < 0.6) {
        // selected ions: source → arc → slit → onwards
        if (u < 0.3) tmp.set(MC.x - RM, Y, lerp(SRC_Z + 0.2, MC.z, u / 0.3));
        else if (u < 0.7) arcPoint((u - 0.3) / 0.4, RM, tmp);
        else tmp.set(lerp(MC.x, SCAN_X, (u - 0.7) / 0.3), Y, lerp(MC.z + RM, 0, (u - 0.7) / 0.3));
        o.position.copy(tmp);
        o.scale.setScalar(0.012);
        o.updateMatrix();
        ions.current?.setMatrixAt(i, o.matrix);
      } else {
        const heavyIon = s.k > 0.8;
        const v = u < 0.3 ? 0 : clamp((u - 0.3) / 0.4);
        if (u < 0.3) tmp.set(MC.x - RM, Y, lerp(SRC_Z + 0.2, MC.z, u / 0.3));
        else {
          // radius drifts away from the selected path until the ion hits the flight-tube wall
          const r = RM + (heavyIon ? 1 : -1) * 0.22 * v;
          arcPoint(v * 0.75, r, tmp);
        }
        if (u > 0.3 && v > 0.95) continue;
        o.position.copy(tmp);
        o.scale.setScalar(0.011);
        o.updateMatrix();
        (heavyIon ? heavy.current : light.current)?.setMatrixAt(i, o.matrix);
      }
    }
    for (const m of [ions.current, light.current, heavy.current]) if (m) m.instanceMatrix.needsUpdate = true;
  });
  return (
    <group>
      <group ref={stat}>
        <Tube points={BEAM_IN} radius={0.012} m={beamMat} />
        <Tube points={ARC} radius={0.012} m={beamMat} segments={60} />
        <Tube points={BEAM_OUT} radius={0.012} m={beamMat} />
      </group>
      <mesh ref={fan1} material={beamMat}>
        <boxGeometry args={[1, 0.02, 0.02]} />
      </mesh>
      <mesh ref={fan2} material={beamMat}>
        <boxGeometry args={[1, 0.02, 0.02]} />
      </mesh>
      <mesh ref={spot} rotation={[0, 0, Math.PI / 2]} material={ionSel}>
        <cylinderGeometry args={[0.018, 0.018, 0.002, 20]} />
      </mesh>
      <instancedMesh ref={ions} args={[GEO.sphereLow, ionSel, N]} frustumCulled={false} />
      <instancedMesh ref={light} args={[GEO.sphereLow, ionLight, N]} frustumCulled={false} />
      <instancedMesh ref={heavy} args={[GEO.sphereLow, ionHeavy, N]} frustumCulled={false} />
    </group>
  );
}

/* ---------------------------------------------------------------- hardware (kit) */
/*
 * Static equipment is built with the detailing kit and merged per finish for the whole
 * implanter bay (base, HV terminal fence and supplies, gas box, beamline, end station, load
 * lock): one mesh per finish plus one shadow caster. Invisible pick proxies keep every
 * component's Clickable. The source housing, flight tube and analyzer magnet are a second
 * small model whose cut-away is a horizontal section at beam height, so the mass separation
 * inside the magnet can be watched from above; the straight beamline downstream uses the
 * scene's vertical cut plane (z = 0.02) like before.
 */

type P2 = [number, number];
const HP = Math.PI / 2;
/** top of the beamline base / of the terminal base (1 cm lower: no coplanar caps) */
const DECK = 0.722;
const DECK2 = 0.712;
const SRC: V3 = [MC.x - RM, Y, SRC_Z - 0.2];
const TH0 = -HP;
const TH1 = 0;
const CORNERS: P2[] = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
const PLANE = new THREE.PlaneGeometry(1, 1);
const SH: PartOpts = { shell: true };

/**
 * Vessel finishes. The bay's environment is dark at the horizon, so fully metallic vertical
 * walls read black; the beamline stainless and anodised aluminium keep some diffuse response
 * (same brushed maps as the kit finishes, so they replace them at no extra draw calls).
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

/** Plan point (x, z) in the analyzer frame: radius r, angle th (same convention as arcPoint). */
const pol = (r: number, th: number): P2 => [MC.x + r * Math.sin(th), MC.z + r * Math.cos(th)];

/** Plan outline of an annular sector of the analyzer frame. */
function sectorPath(r0: number, r1: number, th0 = TH0, th1 = TH1, n = 28): P2[] {
  const p: P2[] = [];
  for (let i = 0; i <= n; i++) p.push(pol(r1, th0 + ((th1 - th0) * i) / n));
  for (let i = n; i >= 0; i--) p.push(pol(r0, th0 + ((th1 - th0) * i) / n));
  return p;
}

/** Outline of the analyzer pole sector grown by d with rounded corners (racetrack coil). */
function racetrack(r0: number, r1: number, d: number, n = 28, nc = 5): P2[] {
  const p: P2[] = [];
  const er = (th: number): P2 => [Math.sin(th), Math.cos(th)];
  const et = (th: number): P2 => [Math.cos(th), -Math.sin(th)];
  const neg = (v: P2): P2 => [-v[0], -v[1]];
  const corner = (c: P2, a: P2, b: P2, skipLast = false) => {
    for (let j = 0; j <= nc; j++) {
      if (skipLast && j === nc) break;
      const f = (j / nc) * HP;
      p.push([c[0] + d * (a[0] * Math.cos(f) + b[0] * Math.sin(f)), c[1] + d * (a[1] * Math.cos(f) + b[1] * Math.sin(f))]);
    }
  };
  for (let i = 0; i < n; i++) p.push(pol(r1 + d, TH0 + ((TH1 - TH0) * i) / n));
  corner(pol(r1, TH1), er(TH1), et(TH1));
  corner(pol(r0, TH1), et(TH1), neg(er(TH1)));
  for (let i = 1; i < n; i++) p.push(pol(r0 - d, TH1 - ((TH1 - TH0) * i) / n));
  corner(pol(r0, TH0), neg(er(TH0)), neg(et(TH0)));
  corner(pol(r1, TH0), neg(et(TH0)), er(TH0), true);
  return p;
}

/** Plan outline (x, z) extruded upward from y0 by h, with optional holes. */
function planSolid(k: Kit, m: THREE.Material, outer: P2[], y0: number, h: number, o: PartOpts = {}, holes: P2[][] = []) {
  const s = new THREE.Shape(outer.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const hp of holes) s.holes.push(new THREE.Path(hp.map(([x, z]) => new THREE.Vector2(x, -z))));
  const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 4 });
  k.add(m, g, [0, y0, 0], [-HP, 0, 0], [1, 1, 1], o);
  g.dispose();
}

/** End plate w × h (thickness t along local Z) with a round port hole, centred at pos. */
function holedPlate(k: Kit, m: THREE.Material, w: number, h: number, t: number, r: number, pos: V3, rot: V3 = [0, 0, 0], o: PartOpts = {}) {
  const s = new THREE.Shape([new THREE.Vector2(-w / 2, -h / 2), new THREE.Vector2(w / 2, -h / 2), new THREE.Vector2(w / 2, h / 2), new THREE.Vector2(-w / 2, h / 2)]);
  const hole = new THREE.Path();
  hole.absarc(0, 0, r, 0, Math.PI * 2, true);
  s.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 20 });
  g.translate(0, 0, -t / 2);
  k.add(m, g, pos, rot, [1, 1, 1], o);
  g.dispose();
}

/** Ribbed insulator profile along local Y (alumina bushings, post insulators, column rings). */
function ribbed(r: number, len: number, ribs: number, depth = 0.014): [number, number][] {
  const p: [number, number][] = [[r * 0.7, 0], [r, 0]];
  for (let i = 0; i < ribs; i++) {
    const a = (i / ribs) * len;
    const b = ((i + 1) / ribs) * len;
    const q = (f: number) => a + (b - a) * f;
    p.push([r, q(0.12)], [r + depth, q(0.3)], [r + depth, q(0.7)], [r, q(0.88)]);
  }
  p.push([r, len], [r * 0.7, len], [r * 0.7, 0]);
  return p;
}

/** Ring (torus) whose axis is the beam (X) axis. */
function ringX(k: Kit, m: THREE.Material, R: number, r: number, pos: V3, o: PartOpts = {}) {
  k.add(m, new THREE.TorusGeometry(R, r, 8, 40), pos, [0, HP, 0], [1, 1, 1], o);
}

/** Flange pair on a beam tube running along X (at x) or Z (at z). */
const flangeX = (k: Kit, x: number, R: number, o: PartOpts = {}, bolts = 10) => k.at([x, Y, 0], [0, 0, HP], () => flange(k, R, 0, { m: VS, ...o, bolts }));
const flangeZ = (k: Kit, z: number, R: number, o: PartOpts = {}, bolts = 10) => k.at([SRC[0], Y, z], [HP, 0, 0], () => flange(k, R, 0, { m: VS, ...o, bolts }));

/** Beamline pedestal: anchored base plate, column, adjustment plate with jack screws. */
function stand(k: Kit, x: number, z: number, top: number, w = 0.16, d = 0.16, base = DECK) {
  const h = top - base;
  k.box(KM.steel, [w + 0.08, 0.014, d + 0.08], [x, base + 0.007, z]);
  for (const [a, b] of CORNERS) k.cyl(KM.stainlessDark, 0.008, 0.012, [x + a * (w / 2 + 0.025), base + 0.02, z + b * (d / 2 + 0.025)], [0, 0, 0], 6, { cast: false });
  k.rbox(KM.paintGrey, [w, h - 0.034, d], 0.008, [x, base + 0.014 + (h - 0.034) / 2, z]);
  k.box(KM.steel, [w + 0.05, 0.02, d + 0.05], [x, top - 0.01, z]);
  for (const [a, b] of CORNERS) k.cyl(KM.stainlessDark, 0.007, 0.03, [x + a * (w / 2 + 0.012), top - 0.01, z + b * (d / 2 + 0.012)], [0, 0, 0], 6, { cast: false });
}

/** Turbo pump hanging under a port: flange, gate valve with actuator, finned body, controller, foreline. */
function turbo(k: Kit, x: number, z: number, floor: number, top: number, r = 0.1) {
  k.cyl(VS, r + 0.025, 0.018, [x, top - 0.009, z], [0, 0, 0], 32);
  k.rbox(VA, [r * 2 + 0.07, 0.07, r * 2 + 0.04], 0.01, [x, top - 0.053, z]);
  k.cyl(KM.anodizedDark, 0.024, 0.12, [x + r + 0.09, top - 0.053, z], [0, 0, HP], 14);
  const yt = top - 0.088;
  const yb = floor + 0.03;
  k.cyl(VS, r + 0.018, 0.016, [x, yt - 0.008, z], [0, 0, 0], 32);
  k.cyl(VA, r, yt - yb - 0.016, [x, (yb + yt - 0.016) / 2, z], [0, 0, 0], 32);
  for (let i = 0; i < 4; i++) k.torus(KM.anodizedDark, r + 0.002, 0.004, [x, yb + 0.03 + i * 0.026, z], [0, 0, 0], 28, { cast: false });
  k.cyl(KM.steel, r + 0.02, 0.03, [x, floor + 0.015, z], [0, 0, 0], 32);
  k.rbox(KM.paintGraphite, [0.06, 0.1, 0.11], 0.008, [x - r - 0.03, (yb + yt) / 2, z]);
  k.box(KM.ledGreen, [0.002, 0.008, 0.02], [x - r - 0.061, (yb + yt) / 2 + 0.03, z], [0, 0, 0], { cast: false });
  k.pipe(VS, [[x, yb + 0.05, z + r - 0.01], [x, yb + 0.05, z + r + 0.07], [x, floor + 0.004, z + r + 0.07]], 0.016, 0.03);
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

let _cage: THREE.MeshStandardMaterial | null = null;
/** Welded wire mesh (≈ 57 mm cells at the kit's world UV scale), alpha-tested. */
function cageMat() {
  if (_cage) return _cage;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, S, S);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 3;
  for (let i = 0; i <= 8; i++) {
    const p = (i / 8) * S;
    g.beginPath();
    g.moveTo(p, 0);
    g.lineTo(p, S);
    g.moveTo(0, p);
    g.lineTo(S, p);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  _cage = new THREE.MeshStandardMaterial({ color: '#6a7074', map: t, alphaTest: 0.04, alphaToCoverage: true, side: THREE.DoubleSide, metalness: 0.55, roughness: 0.45 });
  return _cage;
}

/* --- machine base, terminal fence and supplies (machine-level picks) --- */

function buildBase(k: Kit) {
  // beamline base (under the beamline and end station) and terminal base (under the source)
  k.at([0.95, 0, 0], 0, () => cabinet(k, { size: [5.5, 0.7, 1.6], panels: 8, rows: [], sidePanels: 2, stripe: KM.paintAccent }));
  k.at([-0.9, 0, -1.705], 0, () => cabinet(k, { size: [1.8, 0.69, 1.79], panels: 3, rows: [], sidePanels: 2, stripe: false }));
  // grey deck plates on the caps, with a drip edge
  k.box(KM.paintGrey, [5.48, 0.005, 1.58], [0.95, DECK + 0.0025, 0], [0, 0, 0], { cast: false });
  k.box(KM.paintGrey, [1.78, 0.005, 1.77], [-0.9, DECK2 + 0.0025, -1.705], [0, 0, 0], { cast: false });
  const zf = 0.802;
  k.label('model', 'IX-300', 'HIGH-CURRENT ION IMPLANTER · 300 mm', 0.6, 0.13, [2.15, 0.42, zf]);
  k.label('warn', 'HIGH VOLTAGE', '', 0.11, 0.11, [-1.05, 0.42, zf]);
  k.label('warn', 'X-RADIATION', '', 0.11, 0.11, [0.4, 0.42, zf]);
  ledStrip(k, 1.0, [2.15, 0.57, zf]);
  estop(k, [-1.5, 0.42, 0.8]);
  estop(k, [3.45, 0.42, 0.8]);
  // operator console on a column at the front-left
  k.rbox(KM.anodizedDark, [0.07, 0.67, 0.07], 0.01, [-1.5, DECK + 0.335, 0.72]);
  hmi(k, [-1.5, 1.38, 0.95], 0);
  // cable tray along the back of the deck
  cableTray(k, [-0.25, DECK, -0.66], [2.55, DECK, -0.66], 0.2, 4);
  // signal-tower mast on an L-bracket beside the end station (the tower stands on it)
  k.cyl(VA, 0.018, 1.21, [3.63, DECK + 0.605, 0.5], [0, 0, 0], 14);
  k.rbox(VA, [0.22, 0.03, 0.05], 0.01, [3.54, 1.935, 0.5]);
  k.cyl(KM.anodizedDark, 0.035, 0.012, [3.45, 1.944, 0.5], [0, 0, 0], 20);
}

/** HV terminal safety fence: yellow posts, framed wire-mesh panels, kick plates, warning signs. */
function buildCage(k: Kit) {
  const H = 2.1;
  const mesh = cageMat();
  const runs: [P2, P2][] = [
    [[-2.7, -1.3], [-2.7, -3.05]],
    [[-2.7, -3.05], [0.4, -3.05]],
    [[0.4, -3.05], [0.4, -1.3]],
  ];
  for (const [a, b] of runs) {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    const n = Math.ceil(len / 1.05);
    k.at([a[0], 0, a[1]], Math.atan2(dx, dz), () => {
      for (let i = 0; i <= n; i++) {
        const z = (i * len) / n;
        k.rbox(KM.paintYellow, [0.05, H, 0.05], 0.008, [0, H / 2, z]);
        k.box(KM.steel, [0.12, 0.01, 0.12], [0, 0.005, z]);
        k.cyl(KM.paintGraphite, 0.03, 0.012, [0, H + 0.006, z], [0, 0, 0], 12);
      }
      for (let i = 0; i < n; i++) {
        const z0 = (i * len) / n + 0.03;
        const z1 = ((i + 1) * len) / n - 0.03;
        const pz = (z0 + z1) / 2;
        const pw = z1 - z0;
        for (const y of [0.13, H - 0.06]) k.box(KM.paintGraphite, [0.022, 0.022, pw], [0, y, pz]);
        for (const z of [z0 + 0.011, z1 - 0.011]) k.box(KM.paintGraphite, [0.022, H - 0.19, 0.022], [0, (0.13 + H - 0.06) / 2, z]);
        k.add(mesh, PLANE, [0, (0.13 + H - 0.06) / 2, pz], [0, HP, 0], [pw - 0.02, H - 0.21, 1], { cast: false });
        k.box(KM.paintGraphite, [0.012, 0.1, pw], [0, 0.06, pz]);
        if (i % 2 === 0) {
          k.label('warn', 'HIGH VOLTAGE', '', 0.16, 0.16, [0.016, 1.45, pz], [0, HP, 0]);
          k.label('warn', 'HIGH VOLTAGE', '', 0.16, 0.16, [-0.016, 1.45, pz], [0, -HP, 0]);
        }
      }
    });
  }
  // interlocked access door on the left run: hinge pins, latch with interlock switch
  for (const y of [0.4, 1.7]) k.cyl(KM.stainlessDark, 0.012, 0.1, [-2.7, y, -1.36], [0, 0, 0], 10);
  k.rbox(KM.paintRed, [0.05, 0.12, 0.07], 0.008, [-2.67, 1.1, -2.1]);
  k.box(KM.ledGreen, [0.004, 0.016, 0.016], [-2.643, 1.13, -2.1], [0, 0, 0], { cast: false });
}

/** Terminal and source power supplies behind the fence, cable tray over the fence to the terminal. */
function buildSupplies(k: Kit) {
  for (const [x, name, sub] of [[-1.75, 'HV-80', 'TERMINAL SUPPLY · 80 kV'], [-0.62, 'SPS-3', 'ARC · FILAMENT · EXTRACTION']] as const)
    k.at([x, 0, -3.62], 0, () => {
      cabinet(k, { size: [1.0, 1.95, 0.7], panels: 2, rows: [0.62], handles: true });
      k.label('model', name, sub, 0.4, 0.09, [-0.2, 1.72, 0.352]);
      k.label('warn', 'HIGH VOLTAGE', '', 0.11, 0.11, [0.3, 1.72, 0.352]);
      ledStrip(k, 0.6, [0, 1.85, 0.352]);
      grille(k, 0.5, 0.2, [0, 1.36, 0.352]);
    });
  cableTray(k, [-1.15, 2.3, -3.55], [-1.15, 2.3, -2.78], 0.26, 5);
  for (const [x, dx] of [[-1.75, 0.07], [-0.62, -0.07]] as const) hose(k, [x, 1.97, -3.5], [-1.15 - dx, 2.3, -3.45], 0.014, 0.08, KM.plastic);
  for (const z of [-3.4, -2.9]) for (const s of [-1, 1]) k.cyl(KM.stainlessDark, 0.006, 2.1, [-1.15 + s * 0.14, 3.35, z], [0, 0, 0], 6, { cast: false });
  // flight-tube pump under the pumping tee
  turbo(k, SRC[0], -1.05, DECK2, Y - 0.155, 0.09);
}

/* --- ion source and gas box --- */

/** Terminal gas box: cylinder bay, windowed valve-manifold enclosure with gas sticks, exhaust duct. */
function buildGasBox(k: Kit) {
  const w = 0.7;
  const d = 0.5;
  const y0 = 0.82;
  const y1 = 1.62;
  cabinet(k, { size: [w, 0.8, d], panels: 1, rows: [], stripe: false, feet: false, ao: false });
  k.rbox(KM.paint, [w, y1 - y0, 0.02], 0.006, [0, (y0 + y1) / 2, -d / 2 + 0.01]);
  for (const s of [-1, 1]) k.rbox(KM.paint, [0.02, y1 - y0, d], 0.006, [s * (w / 2 - 0.01), (y0 + y1) / 2, 0]);
  k.rbox(KM.paintGraphite, [w + 0.012, 0.024, d + 0.012], 0.006, [0, y1 + 0.012, 0]);
  k.box(KM.paintGrey, [w - 0.04, 0.012, d - 0.04], [0, y0 + 0.006, 0]);
  // framed glass door
  const zf = d / 2 - 0.012;
  const t = 0.05;
  k.rbox(KM.paint, [w, t, 0.03], 0.006, [0, y1 - t / 2, zf]);
  k.rbox(KM.paint, [w, t * 1.4, 0.03], 0.006, [0, y0 + t * 0.7, zf]);
  for (const s of [-1, 1]) k.rbox(KM.paint, [t, y1 - y0, 0.03], 0.006, [s * (w / 2 - t / 2), (y0 + y1) / 2, zf]);
  k.box(KM.glass, [w - 2 * t + 0.01, y1 - y0 - 2.4 * t + 0.01, 0.006], [0, (y0 + y1) / 2 + 0.01, zf], [0, 0, 0], { cast: false });
  k.rbox(VA, [0.018, 0.22, 0.016], 0.005, [w / 2 - t / 2, (y0 + y1) / 2, zf + 0.03]);
  for (const y of [y0 + 0.15, y1 - 0.15]) k.cyl(KM.stainlessDark, 0.01, 0.07, [-w / 2 - 0.004, y, zf], [0, 0, 0], 10);
  // one gas stick per dopant line with a line tag
  const lines: [string, string][] = [['BF₃', '#6b4c8a'], ['PH₃', '#8a5a2c'], ['AsH₃', '#8a2f2f']];
  lines.forEach(([gas, col], i) => {
    const y = 1.0 + i * 0.19;
    gasStick(k, 0.48, [0.05, y, -0.2]);
    k.label('gas', gas, '', 0.09, 0.022, [-0.255, y, -0.228], [0, 0, 0], col);
  });
  k.label('model', 'GB-4', 'TERMINAL GAS BOX · 4 LINES', 0.3, 0.07, [-0.12, 0.62, d / 2 + 0.002]);
  k.label('warn', 'TOXIC GAS', '', 0.1, 0.1, [0.22, 0.62, d / 2 + 0.002]);
  // exhaust duct to the house scrubbed exhaust (ceiling), with a flow switch
  k.cyl(VS, 0.065, 4.38 - y1 - 0.024, [0.15, (y1 + 0.024 + 4.38) / 2, -0.08], [0, 0, 0], 24);
  for (const y of [y1 + 0.06, 2.4]) k.torus(KM.stainlessDark, 0.067, 0.006, [0.15, y, -0.08], [0, 0, 0], 24, { cast: false });
  k.rbox(KM.paintGraphite, [0.07, 0.08, 0.06], 0.008, [0.24, 1.9, -0.08]);
  k.ao(w, d);
}

/** Source vessel (horizontal cut-away): housing, source magnet, extraction housing, bushing and cap. */
function buildSourceVessel(k: Kit) {
  const [sx, sy, sz] = SRC;
  k.rbox(VS, [0.44, 0.44, 0.44], 0.03, SRC);
  // source magnet coils either side of the arc chamber
  for (const s of [-1, 1]) {
    k.cyl(KM.copper, 0.13, 0.06, [sx + s * 0.25, sy, sz], [0, 0, HP], 36);
    k.cyl(KM.paintGraphite, 0.136, 0.012, [sx + s * 0.284, sy, sz], [0, 0, HP], 36);
    k.cyl(KM.paintGraphite, 0.05, 0.02, [sx + s * 0.3, sy, sz], [0, 0, HP], 20);
  }
  // top port with blank flange and a pressure gauge
  k.cyl(VS, 0.05, 0.06, [sx, sy + 0.25, sz + 0.06], [0, 0, 0], 24);
  k.cyl(VS, 0.065, 0.016, [sx, sy + 0.288, sz + 0.06], [0, 0, 0], 24);
  boltCircle(k, 0.056, 6, sy + 0.298, 0.006);
  k.cyl(KM.anodizedDark, 0.024, 0.08, [sx + 0.12, sy + 0.26, sz - 0.1], [0, 0, 0], 16);
  // exit flange (+z) and the extraction-electrode housing with a viewport
  flangeZ(k, sz + 0.228, 0.15, {}, 16);
  k.cyl(VS, 0.13, 0.035, [sx, sy, -1.9125], [HP, 0, 0], 32);
  k.rbox(VS, [0.34, 0.34, 0.22], 0.02, [sx, sy, -1.785]);
  flangeZ(k, -1.665, 0.1, {}, 12);
  k.at([sx + 0.17, sy, -1.785], [0, HP, 0], () => viewport(k, 0.04, 0.05));
  // source head: flange, ribbed insulating bushing, cap with feedthroughs and the gas inlet
  k.at([sx, sy, sz - 0.22], [-HP, 0, 0], () => {
    flange(k, 0.17, 0.014, { m: VS, bolts: 16 });
    k.lathe(M.ceramic, ribbed(0.13, 0.17, 6, 0.016), [0, 0.03, 0], [0, 0, 0], 40);
    k.cyl(VS, 0.165, 0.03, [0, 0.215, 0], [0, 0, 0], 40);
    boltCircle(k, 0.14, 12, 0.232, 0.008);
    for (const [a, b] of CORNERS) {
      k.cyl(KM.anodizedDark, 0.022, 0.05, [a * 0.08, 0.255, b * 0.08], [0, 0, 0], 16);
      k.cyl(KM.paintRed, 0.024, 0.008, [a * 0.08, 0.235, b * 0.08], [0, 0, 0], 16);
    }
    k.cyl(VS, 0.026, 0.04, [0, 0.25, 0], [0, 0, 0], 16);
  });
}

/** Source utilities (not cut): turbo pump, interior arc-chamber parts, gas line, HV cables. */
function buildSourceUtilities(k: Kit) {
  const [sx, sy, sz] = SRC;
  turbo(k, sx, sz, DECK2, sy - 0.22, 0.11);
  stand(k, sx - 0.19, sz - 0.18, sy - 0.22, 0.06, 0.06, DECK2);
  // interior (seen in cut-away): arc-chamber base, liner and filament leads
  k.box(M.graphite, [0.22, 0.02, 0.22], [sx, sy - 0.11, sz]);
  k.box(M.graphite, [0.2, 0.08, 0.012], [sx, sy - 0.06, sz - 0.11]);
  for (const s of [-1, 1]) k.cyl(KM.chrome, 0.006, 0.12, [sx + s * 0.03, sy - 0.03, sz - 0.16], [HP, 0, 0], 8);
  // gas line from the gas box to the source cap, with a ceramic isolation break
  k.pipe(VS, [[-1.8, 1.45, -2.22], [-1.55, 1.45, -2.22], [-1.55, 1.45, -2.72], [sx, 1.45, -2.72], [sx, sy, -2.72], [sx, sy, -2.64]], 0.0065, 0.04);
  k.cyl(M.ceramic, 0.014, 0.1, [-1.55, 1.45, -2.45], [HP, 0, 0], 14);
  k.label('gas', 'BF₃', '', 0.07, 0.018, [-1.55, 1.467, -2.3], [0, HP, 0], '#6b4c8a');
  // HV / filament cables from the cable tray down to the cap connectors
  for (const [a, b] of CORNERS) hose(k, [sx + a * 0.08, sy + b * 0.08, -2.66], [-1.15 + a * 0.05, 2.29, -2.82], 0.011, 0.05, KM.plastic);
}

/** Extraction electrodes: slotted graphite plates in stainless frames on ceramic stand-offs. */
function buildExtraction(k: Kit) {
  const [sx, sy] = SRC;
  for (const d of [0, 0.07, 0.14]) {
    const z = SRC_Z + 0.08 + d;
    for (const s of [-1, 1]) k.box(M.graphite, [0.13, 0.27, 0.014], [sx + s * 0.08, sy, z]);
    for (const s of [-1, 1]) {
      k.box(KM.stainlessDark, [0.3, 0.018, 0.02], [sx, sy + s * 0.144, z]);
      k.box(KM.stainlessDark, [0.018, 0.27, 0.02], [sx + s * 0.15, sy, z]);
    }
  }
  for (const [a, b] of CORNERS) k.cyl(M.ceramic, 0.011, 0.13, [sx + a * 0.15, sy + b * 0.144, SRC_Z + 0.15], [HP, 0, 0], 10);
}

/** Flight tube from the extraction housing to the magnet: bellows section, pumping tee. */
function buildFlightTube(k: Kit) {
  const x = SRC[0];
  const seg = (z0: number, z1: number) => k.cyl(VS, 0.07, z1 - z0, [x, Y, (z0 + z1) / 2], [HP, 0, 0], 32);
  seg(-1.655, -1.47);
  flangeZ(k, -1.47, 0.08);
  k.at([x, Y, -1.462], [HP, 0, 0], () => bellows(k, 0.088, 0.16, 8, [0, 0, 0], VS));
  flangeZ(k, -1.294, 0.08);
  seg(-1.294, -0.775);
  k.cyl(VS, 0.062, 0.11, [x, Y - 0.1, -1.05], [0, 0, 0], 28);
  flangeZ(k, -0.775, 0.08);
}

/* --- analyzer magnet --- */

const POLE: [number, number] = [RM - 0.24, RM + 0.24];

/** Analyzer vessel (horizontal cut-away): flight chamber with strike liners, poles, coils, C-yoke. */
function buildAnalyzerVessel(k: Kit) {
  const [r0, r1] = POLE;
  // flight chamber between the poles, wide enough for the off-mass ions to reach its walls
  planSolid(k, VS, sectorPath(r0, r1), Y + 0.05, 0.012);
  planSolid(k, VS, sectorPath(r0, r1), Y - 0.062, 0.012);
  planSolid(k, VS, sectorPath(RM + 0.23, RM + 0.242, TH0, TH1, 40), Y - 0.05, 0.1);
  planSolid(k, VS, sectorPath(RM - 0.242, RM - 0.23, TH0, TH1, 40), Y - 0.05, 0.1);
  planSolid(k, M.graphite, sectorPath(RM + 0.214, RM + 0.23, -1.15, -0.12, 24), Y - 0.042, 0.084);
  planSolid(k, M.graphite, sectorPath(RM - 0.23, RM - 0.214, -1.15, -0.12, 24), Y - 0.042, 0.084);
  // end plates with the beam ports and snouts to the flight tube / slit
  holedPlate(k, VS, r1 - r0 + 0.004, 0.124, 0.012, 0.07, [MC.x - RM, Y, MC.z - 0.006], [0, 0, 0]);
  holedPlate(k, VS, r1 - r0 + 0.004, 0.124, 0.012, 0.07, [MC.x + 0.006, Y, MC.z + RM], [0, HP, 0]);
  k.cyl(VS, 0.07, 0.165, [MC.x - RM, Y, MC.z - 0.0925], [HP, 0, 0], 32, { open: true });
  k.cyl(VS, 0.07, 0.16, [MC.x + 0.08, Y, MC.z + RM], [0, 0, HP], 32, { open: true });
  flangeX(k, -0.445, 0.08);
  // poles, racetrack coils and the C-yoke (return leg on the inner radius, open outside)
  for (const s of [-1, 1]) {
    planSolid(k, KM.steel, sectorPath(r0, r1), s > 0 ? Y + 0.062 : Y - 0.2, 0.138);
    planSolid(k, KM.copper, racetrack(r0, r1, 0.13), s > 0 ? Y + 0.072 : Y - 0.192, 0.12, {}, [racetrack(r0, r1, 0.012)]);
    // coil banding straps and the epoxy end blocks
    for (const th of [-1.32, -0.79, -0.26]) {
      const [x, z] = pol(r1 + 0.075, th);
      k.box(KM.paintGraphite, [0.04, 0.128, 0.13], [x, s > 0 ? Y + 0.132 : Y - 0.132, z], [0, th, 0]);
    }
    planSolid(k, KM.paintBlue, sectorPath(RM - 0.5, RM + 0.4), s > 0 ? Y + 0.2 : Y - 0.34, 0.14);
    // pole-gap shims and lifting eyes on the yoke plates
    if (s > 0)
      for (const th of [-1.2, -0.4]) {
        const [x, z] = pol(RM - 0.05, th);
        k.cyl(KM.stainlessDark, 0.03, 0.03, [x, Y + 0.355, z], [0, 0, 0], 16);
        k.torus(KM.stainlessDark, 0.03, 0.008, [x, Y + 0.39, z], [-HP, th, 0], 16);
      }
  }
  planSolid(k, KM.paintBlue, sectorPath(RM - 0.5, RM - 0.39), Y - 0.2, 0.4);
  // jumper between the coil halves at the entry end, plates and warnings on the lower yoke
  const [jx, jz] = pol(RM + 0.33, TH0 - 0.06);
  k.box(KM.copper, [0.03, 0.42, 0.012], [jx, Y, jz]);
  const [lx, lz] = pol(RM + 0.412, -HP / 2);
  k.label('model', 'AM-90', 'ANALYZER · 90° · R 0.6 m', 0.3, 0.075, [lx, Y - 0.27, lz], [0, -HP / 2, 0]);
  const [wx, wz] = pol(RM + 0.412, -0.3);
  k.label('warn', 'MAGNETIC FIELD', '', 0.1, 0.1, [wx, Y - 0.27, wz], [0, -0.3, 0]);
}

/** Analyzer supports and services (not cut): pedestals, cooling manifold and hoses, bus bars. */
function buildAnalyzerUtilities(k: Kit) {
  for (const [r, th] of [[0.3, -1.25], [0.86, -1.25], [0.3, -0.32], [0.86, -0.32]] as const) {
    const [x, z] = pol(r, th);
    stand(k, x, z, Y - 0.34, 0.14, 0.14);
  }
  // cooling-water manifold (blue supply / red return) and hoses to the lower coil ear
  const [mx, mz] = pol(RM + 0.55, TH0 + 0.12);
  for (const [i, m] of [[0, KM.paintBlue], [1, KM.paintRed]] as const) {
    const y = DECK + 0.08 + i * 0.07;
    k.cyl(KM.copper, 0.02, 0.36, [mx, y, mz - 0.1], [HP, 0, 0], 14);
    k.cyl(m, 0.023, 0.04, [mx, y, mz + 0.06], [HP, 0, 0], 14);
    const [hx, hz] = pol(RM + 0.2 + i * 0.1, TH0 - 0.08);
    hose(k, [hx, Y - 0.19, hz], [mx, y, mz - 0.25], 0.012, 0.06);
  }
  // coil power bus bars down into the base
  for (const i of [0, 1]) {
    const [bx, bz] = pol(RM - 0.05 + i * 0.12, TH0 - 0.16);
    k.box(KM.copper, [0.04, Y - 0.19 - DECK, 0.01], [bx, (Y - 0.19 + DECK) / 2, bz]);
  }
}

/* --- resolving aperture, acceleration column --- */

function buildSlit(k: Kit) {
  k.rbox(VS, [0.24, 0.36, 0.32], 0.02, [-0.3, Y, 0], [0, 0, 0], SH);
  flangeX(k, -0.425, 0.08, SH);
  flangeX(k, -0.175, 0.08, SH);
  k.cyl(VS, 0.07, 0.12, [-0.115, Y, 0], [0, 0, HP], 32, SH);
  // adjustable slit jaws: graphite plates in holders on actuator rods through bellows
  for (const s of [-1, 1]) {
    k.box(M.graphite, [0.02, 0.32, 0.12], [-0.3, Y, s * 0.1]);
    k.box(KM.stainlessDark, [0.04, 0.03, 0.1], [-0.3, Y + 0.145, s * 0.1]);
    k.cyl(KM.chrome, 0.007, 0.1, [-0.3, Y + 0.2, s * 0.1], [0, 0, 0], 8, SH);
    bellows(k, 0.022, 0.05, 5, [-0.3, Y + 0.18, s * 0.1], VS, SH);
    k.cyl(KM.anodizedDark, 0.03, 0.09, [-0.3, Y + 0.275, s * 0.1], [0, 0, 0], 16, SH);
    k.cyl(VA, 0.032, 0.012, [-0.3, Y + 0.326, s * 0.1], [0, 0, 0], 16, SH);
  }
  stand(k, -0.3, 0, Y - 0.18, 0.14, 0.2);
}

const COL_X = Array.from({ length: 7 }, (_, i) => i * 0.12);

function buildColumn(k: Kit) {
  // end flanges with corona (grading) rings
  for (const [x, cx] of [[-0.045, -0.075], [0.765, 0.795]] as const) {
    k.cyl(VS, 0.24, 0.03, [x, Y, 0], [0, 0, HP], 48, SH);
    k.at([x < 0 ? -0.063 : 0.783, Y, 0], [0, 0, HP], () => boltCircle(k, 0.215, 16, 0, 0.008, KM.stainlessDark, SH));
    ringX(k, VS, 0.24, 0.02, [cx, Y, 0], SH);
  }
  COL_X.forEach((x, i) => {
    // electrode flange (vacuum wall) and the ribbed alumina insulator to the next one
    k.cyl(VS, 0.225, 0.022, [x, Y, 0], [0, 0, HP], 48, SH);
    if (i < 6) k.at([x + 0.011, Y, 0], [0, 0, -HP], () => k.lathe(M.ceramic, ribbed(0.185, 0.098, 3, 0.012), [0, 0, 0], [0, 0, 0], 48, SH));
    // internal electrode: apertured dish (visible in cut-away)
    k.at([x, Y, 0], [0, 0, -HP], () => k.lathe(KM.stainlessDark, [[0.045, -0.006], [0.17, -0.006], [0.17, 0.006], [0.06, 0.006], [0.045, 0.03], [0.045, -0.006]], [0, 0, 0], [0, 0, 0], 40));
    // grading resistor chains between the electrode flanges (back side)
    if (i < 6) for (const y of [0.15, -0.15]) k.cyl(KM.anodizedDark, 0.008, 0.096, [x + 0.06, Y + y, -0.14], [0, 0, HP], 8, SH);
  });
  // post insulators and saddles on a base frame
  for (const x of [0.12, 0.6]) {
    k.lathe(M.ceramic, ribbed(0.04, 0.2, 5, 0.012), [x, DECK + 0.02, 0], [0, 0, 0], 24);
    k.cyl(VS, 0.05, 0.02, [x, DECK + 0.23, 0], [0, 0, 0], 24);
    k.rbox(VS, [0.08, 0.06, 0.24], 0.008, [x, DECK + 0.27, 0]);
  }
  k.label('warn', 'HIGH VOLTAGE', '', 0.05, 0.05, [0.12, DECK + 0.27, 0.121]);
  k.box(KM.steel, [0.7, 0.02, 0.3], [0.36, DECK + 0.01, 0]);
}

/* --- scanner, parallelizing lens, drift chamber --- */

function buildScanner(k: Kit) {
  // drift tube from the column to the scanner, with bellows
  k.cyl(VS, 0.07, 0.08, [0.82, Y, 0], [0, 0, HP], 32, SH);
  flangeX(k, 0.865, 0.08, SH);
  k.at([0.87, Y, 0], [0, 0, -HP], () => bellows(k, 0.088, 0.1, 6, [0, 0, 0], VS, SH));
  flangeX(k, 0.975, 0.08, SH);
  k.cyl(VS, 0.07, 0.07, [1.015, Y, 0], [0, 0, HP], 32, SH);
  // scanner chamber between the scan-magnet poles
  k.rbox(VS, [0.3, 0.1, 0.34], 0.012, [SCAN_X, Y, 0], [0, 0, 0], SH);
  flangeX(k, 1.05, 0.08, SH);
  // scan magnet: laminated poles, copper coils, C-yoke (return leg at the back)
  for (const s of [-1, 1]) {
    const y = Y + s * 0.1;
    k.box(KM.steel, [0.2, 0.1, 0.22], [SCAN_X, y, 0]);
    for (let i = 1; i < 10; i++) k.box(KM.seam, [0.002, 0.098, 0.222], [SCAN_X - 0.1 + i * 0.02, y, 0], [0, 0, 0], { cast: false });
    for (const z of [-0.14, 0.14]) k.rbox(KM.copper, [0.27, 0.08, 0.05], 0.015, [SCAN_X, y, z]);
    for (const x of [-0.118, 0.118]) k.rbox(KM.copper, [0.03, 0.08, 0.24], 0.01, [SCAN_X + x, y, 0]);
    k.rbox(KM.paintBlue, [0.28, 0.055, 0.36], 0.01, [SCAN_X, Y + s * 0.177, -0.02]);
  }
  k.rbox(KM.paintBlue, [0.28, 0.41, 0.06], 0.01, [SCAN_X, Y, -0.2]);
  stand(k, SCAN_X, -0.05, Y - 0.205, 0.16, 0.2);
  // parallelizing lens: shaped poles, coils, H-yoke (all part of the beamline shell)
  const L = LENS_X;
  k.rbox(VS, [0.3, 0.1, 0.56], 0.012, [L, Y, 0], [0, 0, 0], SH);
  for (const s of [-1, 1]) {
    k.box(KM.steel, [0.26, 0.12, 0.5], [L, Y + s * 0.11, 0], [0, 0, 0], SH);
    for (const x of [-0.16, 0.16]) k.rbox(KM.copper, [0.05, 0.09, 0.62], 0.015, [L + x, Y + s * 0.11, 0], [0, 0, 0], SH);
    for (const z of [-0.285, 0.285]) k.rbox(KM.copper, [0.37, 0.09, 0.05], 0.015, [L, Y + s * 0.11, z], [0, 0, 0], SH);
    k.rbox(KM.paintBlue, [0.32, 0.1, 0.84], 0.012, [L, Y + s * 0.22, 0], [0, 0, 0], SH);
    k.rbox(KM.paintBlue, [0.32, 0.34, 0.1], 0.012, [L, Y, s * 0.37], [0, 0, 0], SH);
  }
  k.label('model', 'PL-1', 'PARALLELIZING LENS', 0.26, 0.065, [L, Y, 0.421], [0, 0, 0]);
  for (const z of [-0.28, 0.28]) stand(k, L, z, Y - 0.27, 0.2, 0.14);
}

function buildBeamDucts(k: Kit) {
  // fan chamber (scanner → lens): wedge widening with the scan, ribbed lid
  planSolid(k, VS, [[1.35, -0.09], [1.76, -0.23], [1.76, 0.23], [1.35, 0.09]], Y - 0.06, 0.12, SH);
  for (const x of [1.45, 1.56, 1.67]) {
    const hw = 0.09 + ((x - 1.35) / 0.41) * 0.14;
    k.box(VS, [0.02, 0.02, hw * 2], [x, Y + 0.07, 0], [0, 0, 0], SH);
  }
  k.cyl(VS, 0.06, 0.1, [1.58, Y - 0.11, 0], [0, 0, 0], 24);
  turbo(k, 1.58, 0, DECK, Y - 0.16, 0.09);
  // drift chamber (lens → end station): profiler port, ion gauge, turbo pump below
  k.rbox(VS, [0.5, 0.18, 0.46], 0.015, [2.395, Y, 0], [0, 0, 0], SH);
  k.rbox(VS, [0.03, 0.24, 0.52], 0.008, [2.155, Y, 0], [0, 0, 0], SH);
  k.cyl(VS, 0.05, 0.12, [2.3, Y + 0.15, -0.08], [0, 0, 0], 24, SH);
  k.rbox(KM.anodizedDark, [0.1, 0.14, 0.1], 0.01, [2.3, Y + 0.28, -0.08], [0, 0, 0], SH);
  k.cyl(VA, 0.02, 0.1, [2.5, Y + 0.14, -0.15], [0, 0, 0], 12, SH);
  k.cyl(VS, 0.06, 0.08, [2.42, Y - 0.12, 0], [0, 0, 0], 24);
  turbo(k, 2.42, 0, DECK, Y - 0.16, 0.09);
}

/* --- end station and load lock --- */

function buildEndStation(k: Kit) {
  const x0 = WX - 0.45;
  const x1 = WX + 0.45;
  const y0 = DECK + 0.03;
  const y1 = 1.8;
  const z0 = -0.58;
  // base frame and vacuum chamber with external stiffeners
  k.rbox(KM.paintGraphite, [0.96, 0.03, 1.22], 0.008, [WX, DECK + 0.015, 0]);
  k.rbox(VS, [0.9, y1 - y0, 1.16], 0.04, [WX, (y0 + y1) / 2, 0], [0, 0, 0], SH);
  for (const x of [x0 + 0.15, WX, x1 - 0.15]) k.box(VS, [0.03, y1 - y0 - 0.1, 0.03], [x, (y0 + y1) / 2, z0 - 0.015], [0, 0, 0], SH);
  for (const y of [y0 + 0.3, y1 - 0.3]) k.box(VS, [0.86, 0.03, 0.03], [WX, y, z0 - 0.015], [0, 0, 0], SH);
  k.box(KM.seam, [0.904, 0.004, 1.164], [WX, y1 - 0.06, 0], [0, 0, 0], { ...SH, cast: false });
  // service door on the +x side: hinges and clamp knobs
  k.rbox(VS, [0.03, 0.82, 0.92], 0.012, [x1 + 0.015, 1.27, 0], [0, 0, 0], SH);
  for (const y of [0.98, 1.56]) k.cyl(KM.stainlessDark, 0.02, 0.12, [x1 + 0.035, y, -0.47], [0, 0, 0], 14, SH);
  for (const y of [1.0, 1.27, 1.54]) k.cyl(KM.paintGraphite, 0.026, 0.05, [x1 + 0.055, y, 0.43], [0, 0, HP], 16, SH);
  // lid lip, front access port with bolt ring, stiffener band, accent band, viewport
  k.rbox(VS, [0.92, 0.035, 1.18], 0.01, [WX, y1 - 0.0175, 0], [0, 0, 0], SH);
  k.rbox(VS, [0.42, 0.36, 0.02], 0.01, [WX - 0.15, 1.36, 0.588], [0, 0, 0], SH);
  for (let i = 0; i < 14; i++) {
    const t = (i / 14) * Math.PI * 2;
    const bx = Math.max(-1, Math.min(1, Math.cos(t) * 1.3)) * 0.185;
    const by = Math.max(-1, Math.min(1, Math.sin(t) * 1.3)) * 0.155;
    k.cyl(KM.stainlessDark, 0.007, 0.008, [WX - 0.15 + bx, 1.36 + by, 0.6], [HP, 0, 0], 6, { ...SH, cast: false });
  }
  k.box(VS, [0.9, 0.03, 0.025], [WX, 1.0, 0.59], [0, 0, 0], SH);
  k.box(KM.paintAccent, [0.9, 0.05, 0.004], [WX, y1 - 0.12, 0.582], [0, 0, 0], { ...SH, cast: false });
  k.at([WX + 0.2, 1.5, 0.58], [0, 0, 0], () => viewport(k, 0.045, 0.04, SH));
  // beam-entry flange frame on the −x side
  k.rbox(VS, [0.04, 0.3, 0.56], 0.01, [x0 - 0.02, Y, 0], [0, 0, 0], SH);
  // cryopump on its gate valve on the lid, compressor hoses to the floor behind the tool
  k.rbox(VA, [0.34, 0.08, 0.34], 0.01, [WX + 0.12, y1 + 0.04, -0.27]);
  k.cyl(KM.anodizedDark, 0.024, 0.12, [WX + 0.12 + 0.22, y1 + 0.04, -0.27], [0, 0, HP], 14);
  k.cyl(VS, 0.165, 0.016, [WX + 0.12, y1 + 0.088, -0.27], [0, 0, 0], 40);
  k.cyl(VS, 0.15, 0.34, [WX + 0.12, y1 + 0.266, -0.27], [0, 0, 0], 40);
  k.cyl(VS, 0.162, 0.014, [WX + 0.12, y1 + 0.44, -0.27], [0, 0, 0], 40);
  k.cyl(KM.anodizedDark, 0.07, 0.16, [WX + 0.12, y1 + 0.527, -0.27], [0, 0, 0], 24);
  k.cyl(VA, 0.075, 0.02, [WX + 0.12, y1 + 0.617, -0.27], [0, 0, 0], 24);
  for (const s of [-1, 1])
    k.tube(KM.stainlessDark, [[WX + 0.12 + s * 0.05, y1 + 0.5, -0.33], [WX + 0.14 + s * 0.05, y1 + 0.42, -0.72], [WX + 0.3 + s * 0.06, 1.3, -0.95], [WX + 0.42 + s * 0.06, 0.75, -1.25], [WX + 0.45 + s * 0.06, 0.63, -1.36]], 0.014, { tension: 0.5 });
  k.at([WX + 0.45, 0, -1.5], 0, () => {
    cabinet(k, { size: [0.55, 0.6, 0.45], panels: 1, rows: [], stripe: false });
    k.label('info', 'CRY-C', 'He COMPRESSOR', 0.16, 0.04, [0, 0.5, 0.227]);
  });
  k.label('warn', 'COLD SURFACE', '', 0.09, 0.09, [WX + 0.12, y1 + 0.27, -0.112], [0, 0, 0]);
  // interior (seen in cut-away): graphite liner, platen scan drive, side Faraday cups, flood gun
  k.box(VA, [0.8, 0.88, 0.012], [WX, 1.27, z0 + 0.03]);
  for (let i = 1; i < 4; i++) k.box(KM.seam, [0.002, 0.88, 0.014], [WX - 0.4 + i * 0.2, 1.27, z0 + 0.03], [0, 0, 0], { cast: false });
  k.rbox(VA, [0.1, 0.86, 0.14], 0.01, [WX + 0.27, 1.27, 0]);
  for (const z of [-0.04, 0.04]) k.box(KM.chrome, [0.012, 0.8, 0.014], [WX + 0.214, 1.27, z]);
  k.rbox(KM.anodizedDark, [0.12, 0.08, 0.16], 0.01, [WX + 0.27, 0.8, 0]);
  for (const s of [-1, 1]) {
    k.cyl(KM.stainlessDark, 0.04, 0.09, [WX - 0.02, Y, s * 0.26], [0, 0, HP], 20);
    k.cyl(M.graphite, 0.03, 0.004, [WX - 0.066, Y, s * 0.26], [0, 0, HP], 20);
  }
  k.rbox(KM.anodizedDark, [0.12, 0.1, 0.14], 0.01, [x0 + 0.12, Y + 0.17, 0]);
  k.cyl(M.ceramic, 0.018, 0.05, [x0 + 0.12, Y + 0.1, 0], [0, 0, 0], 12);
}

function buildLoadLock(k: Kit) {
  const lx = WX - 0.1;
  const lz = 0.85;
  // pedestal (front module) under the load lock
  k.at([WX - 0.05, 0, 1.05], 0, () => {
    cabinet(k, { size: [0.9, 0.81, 0.5], panels: 1, rows: [], stripe: false });
    k.label('info', 'LL-2', 'LOAD LOCK · VENT / PUMP', 0.2, 0.05, [-0.2, 0.62, 0.252]);
    ledStrip(k, 0.3, [0.2, 0.62, 0.252]);
  });
  // open-topped stainless lock with a clamped glass lid (the slit-valve wall is shell)
  k.rbox(VS, [0.5, 0.03, 0.46], 0.008, [lx, 0.847, lz]);
  for (const s of [-1, 1]) k.rbox(VS, [0.03, 0.3, 0.46], 0.008, [lx + s * 0.235, 1.012, lz]);
  k.rbox(VS, [0.5, 0.3, 0.03], 0.008, [lx, 1.012, lz + 0.215]);
  k.rbox(VS, [0.5, 0.3, 0.03], 0.008, [lx, 1.012, lz - 0.215], [0, 0, 0], SH);
  for (const s of [-1, 1]) {
    k.rbox(VA, [0.52, 0.026, 0.04], 0.008, [lx, 1.175, lz + s * 0.215]);
    k.rbox(VA, [0.04, 0.026, 0.46], 0.008, [lx + s * 0.245, 1.175, lz]);
    k.rbox(KM.paintGraphite, [0.05, 0.03, 0.05], 0.008, [lx + s * 0.27, 1.17, lz + 0.12]);
  }
  k.box(KM.glass, [0.46, 0.012, 0.4], [lx, 1.175, lz], [0, 0, 0], { cast: false });
  for (const [x, z] of [[0, -0.1], [-0.087, 0.05], [0.087, 0.05]] as const) k.cyl(KM.chrome, 0.004, 0.13, [lx + x, 0.925, lz + z], [0, 0, 0], 8);
  // slit valve to the end station, vent / roughing valve block on the side
  k.rbox(VA, [0.42, 0.16, 0.06], 0.01, [lx, 1.03, 0.6], [0, 0, 0], SH);
  k.cyl(KM.anodizedDark, 0.03, 0.15, [lx + 0.29, 1.03, 0.6], [0, 0, HP], 16, SH);
  k.rbox(VS, [0.06, 0.08, 0.08], 0.008, [lx + 0.28, 0.95, lz]);
  k.cyl(KM.paintBlue, 0.02, 0.05, [lx + 0.28, 1.01, lz], [0, 0, 0], 12);
  k.pipe(VS, [[lx + 0.31, 0.95, lz], [lx + 0.46, 0.95, lz], [lx + 0.46, 0.84, lz]], 0.014, 0.03);
}

/* --- live implanter --- */

const LID_PLANE = new THREE.Plane(new THREE.Vector3(0, -1, 0), Y + 0.012);
const lidCut = new WeakMap<THREE.Material, THREE.Material>();
/** Clone of a material cut away above the beam plane (source / analyzer section view). */
function lidOf(m: THREE.Material): THREE.Material {
  let c = lidCut.get(m);
  if (!c) {
    c = m.clone();
    c.clippingPlanes = [LID_PLANE];
    c.side = THREE.DoubleSide;
    lidCut.set(m, c);
  }
  return c;
}
const noRay = () => {};

/** The source / analyzer vessel: in cut-away and section views it is cut at beam height. */
function LidView({ m, view }: { m: MergedModel; view: ViewMode }) {
  const caster = useMemo(() => (m.caster ? shadowOnly(m.caster) : null), [m]);
  const cut = view === 'cutaway' || view === 'section';
  return (
    <>
      {m.parts.map((p, i) => (
        <mesh key={i} geometry={p.geometry} material={view === 'xray' ? shell(p.material, 'xray') : cut ? lidOf(p.material) : p.material} receiveShadow raycast={noRay} />
      ))}
      {caster && <primitive object={caster} />}
    </>
  );
}

function useImplanterStation() {
  return useModel({
    body: (k) => {
      buildBase(k);
      buildCage(k);
      buildSupplies(k);
      buildBeamDucts(k);
    },
    source: (k) => {
      k.at([-2.15, 0, -2.1], 0, () => buildGasBox(k));
      buildSourceUtilities(k);
    },
    extraction: buildExtraction,
    analyzer: buildAnalyzerUtilities,
    slit: buildSlit,
    accelerator: buildColumn,
    scanner: buildScanner,
    endstation: (k) => {
      buildEndStation(k);
      buildLoadLock(k);
    },
    _stand: (k) => k.at([WX + 0.95, 0, -0.6], -0.6, () => monitorStand(k, 1.36, 1.5, [0.62, 0.4])),
  });
}

function useVessel() {
  return useModel({ source: buildSourceVessel, body: buildFlightTube, analyzer: buildAnalyzerVessel });
}

function Implanter() {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  // beamline housings are opaque vacuum vessels: the machine view looks inside them too
  const view = effectiveView(viewRaw, cam === 'machine' ? 'internal' : cam);
  const glow = useRef<THREE.Mesh>(null);
  useFrame(() => {
    if (glow.current) glow.current.visible = engine.tele.value('current', 0) > 0.05 || inPhase('pump');
  });
  const st = useImplanterStation();
  const vessel = useVessel();
  return (
    <group>
      <ModelView m={st} view={view} pickable={false} />
      <LidView m={vessel} view={view} />
      <Clickable sel={{ kind: 'machine', id: 'implanter', label: 'Ion implanter' }}>
        <ModelPick m={st} tag="body" />
        <ModelPick m={vessel} tag="body" />
        {/* ion source */}
        <Clickable sel={{ kind: 'component', id: 'source', machine: 'implanter', label: 'Ion source' }}>
          <ModelPick m={st} tag="source" />
          <ModelPick m={vessel} tag="source" />
          <mesh ref={glow} position={SRC} material={plasmaMat}>
            <sphereGeometry args={[0.08, 16, 12]} />
          </mesh>
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'extraction', machine: 'implanter', label: 'Extraction electrodes' }}>
          <ModelPick m={st} tag="extraction" />
        </Clickable>
        {/* analyzer magnet: poles, coils and yoke around the curved flight chamber */}
        <Clickable sel={{ kind: 'component', id: 'analyzer', machine: 'implanter', label: 'Analyzer magnet' }}>
          <ModelPick m={st} tag="analyzer" />
          <ModelPick m={vessel} tag="analyzer" />
        </Clickable>
        {/* resolving slit */}
        <Clickable sel={{ kind: 'component', id: 'analyzer', machine: 'implanter', label: 'Resolving aperture (mass slit)' }}>
          <ModelPick m={st} tag="slit" />
        </Clickable>
        {/* acceleration column */}
        <Clickable sel={{ kind: 'component', id: 'accelerator', machine: 'implanter', label: 'Acceleration column' }}>
          <ModelPick m={st} tag="accelerator" />
        </Clickable>
        {/* scanner + parallelizing lens */}
        <Clickable sel={{ kind: 'component', id: 'scanner', machine: 'implanter', label: 'Beam scanner' }}>
          <ModelPick m={st} tag="scanner" />
        </Clickable>
        {/* end station */}
        <Clickable sel={{ kind: 'component', id: 'end-station', machine: 'implanter', label: 'End station' }}>
          <ModelPick m={st} tag="endstation" />
        </Clickable>
        <SignalTower position={[WX + 0.35, 1.95, 0.5]} />
      </Clickable>
    </group>
  );
}

const WP = new THREE.Vector3();

function EndStationWafer() {
  const group = useRef<THREE.Group>(null);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.1, metalness: 0.9 }), []);
  const resist = useMemo(() => new THREE.MeshPhysicalMaterial({ color: '#b5612a', roughness: 0.25, transparent: true, opacity: 0.85 }), []);
  // platen (electrostatic chuck) behind the wafer: chamfered disc, dielectric face, cooling hub
  const platen = useModel((k) => {
    k.lathe(KM.stainlessDark, [[0, -0.033], [0.152, -0.033], [0.16, -0.026], [0.16, -0.01], [0.154, -0.003], [0, -0.003]], [0, 0, 0], [0, 0, 0], 48);
    k.cyl(KM.paintGraphite, 0.148, 0.0012, [0, -0.0024, 0], [0, 0, 0], 48, { cast: false });
    k.cyl(KM.anodizedDark, 0.06, 0.03, [0, -0.048, 0], [0, 0, 0], 24);
  });
  useFrame(() => {
    // load: from the load lock (+z), tilt up to vertical; unload: reverse
    const inP = smooth(pp('load'));
    const outP = smooth(pp('unload'));
    const k = inP * (1 - outP);
    const sc = scan();
    const p = WP.set(lerp(WX - 0.1, WX, k), lerp(1.0, Y, k) + sc.y, lerp(0.85, 0, k));
    if (group.current) {
      group.current.position.copy(p);
      group.current.rotation.set(0, 0, (Math.PI / 2) * k);
    }
    track('focus', p.x, p.y, p.z);
  });
  return (
    <group ref={group}>
      <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184' }}>
        <mesh geometry={waferGeometry()} material={mat} castShadow />
        <mesh position={[0, 0.0006, 0]} rotation={[-Math.PI / 2, 0, 0]} material={resist}>
          <ringGeometry args={[0.02, 0.148, 64]} />
        </mesh>
      </Clickable>
      {/* platen behind the wafer */}
      <ModelView m={platen} pickable={false} />
    </group>
  );
}

/* ---------------------------------------------------------------- inset */

const NM = 0.18 / IMPLANT.rp; // inset units per nm (Rp = 66 nm → 0.18)
const SI_TOP = 0.08;
const RESIST_H = 0.24;
const OPEN = 0.2;
const siMat = new THREE.MeshStandardMaterial({ color: '#7a828c', roughness: 0.45, metalness: 0.5 });
const resistMat = new THREE.MeshPhysicalMaterial({ color: '#b5612a', roughness: 0.3, transparent: true, opacity: 0.8 });
const dopMat = new THREE.MeshBasicMaterial({ color: '#ffd28a', toneMapped: false });
const streakMat = new THREE.MeshBasicMaterial({ color: '#ffcf7a', toneMapped: false, transparent: true, opacity: 0.7 });

function ImplantInset() {
  const ions = useMemo(() => implantIons(360), []);
  const dots = useRef<THREE.InstancedMesh>(null);
  const streaks = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const t = useRef(0);
  const profile = useMemo(() => {
    const pts: V3[] = [];
    for (let d = 0; d <= 200; d += 4) {
      const c = Math.exp(-0.5 * ((d - IMPLANT.rp) / IMPLANT.drp) ** 2);
      pts.push([0.62 + 0.3 * c, SI_TOP - d * NM, 0.08]);
    }
    return pts;
  }, []);
  useFrame((_, dt) => {
    t.current += pdt(dt);
    const frac = clamp(engine.tele.value('dose', 0) / 2);
    if (dots.current) {
      ions.forEach((ion, i) => {
        const arrive = i / ions.length;
        const x = -0.55 + ion.x * 1.1;
        const open = Math.abs(x) < OPEN;
        // through the opening: stop in silicon at the projected range ± straggle; else stop in the resist
        const restY = open ? SI_TOP - ion.depth * NM : SI_TOP + RESIST_H - Math.min(ion.depth * 0.6 * NM, RESIST_H - 0.01);
        const k = clamp((frac - arrive) * 40);
        o.position.set(x + ion.lateral * NM * (open ? 1 : 0.5), lerp(0.42, restY, k), 0.08);
        o.scale.setScalar(frac > arrive ? 0.008 : 0);
        o.updateMatrix();
        dots.current!.setMatrixAt(i, o.matrix);
      });
      dots.current.instanceMatrix.needsUpdate = true;
    }
    if (streaks.current) {
      const on = inPhase('implant');
      for (let i = 0; i < 16; i++) {
        const u = (t.current * 1.6 + i * 0.37) % 1;
        o.position.set(-0.5 + ((i * 0.618) % 1) * 1.0, lerp(0.42, SI_TOP + 0.02, u), 0.08);
        o.scale.set(0.004, 0.06, 0.004);
        o.updateMatrix();
        streaks.current.setMatrixAt(i, on ? o.matrix : HIDE);
      }
      streaks.current.instanceMatrix.needsUpdate = true;
    }
  });
  return (
    <Inset id="implant-section" position={[3.2, 2.6, 1.35]} size={[1.4, 0.9]} mpu={1 / (NM * 1e9)} schematic={false} title="ION IMPLANT · CROSS-SECTION">
      <group position={[-0.1, -0.05, 0]}>
        <ProfileSlab points={rect(-0.55, -0.38, 0.55, SI_TOP)} depth={0.12} m={siMat} />
        <ProfileSlab points={rect(-0.55, SI_TOP, -OPEN, SI_TOP + RESIST_H)} depth={0.12} m={resistMat} />
        <ProfileSlab points={rect(OPEN, SI_TOP, 0.55, SI_TOP + RESIST_H)} depth={0.12} m={resistMat} />
        <instancedMesh ref={dots} args={[GEO.sphereLow, dopMat, 360]} frustumCulled={false} />
        <instancedMesh ref={streaks} args={[GEO.box, streakMat, 16]} frustumCulled={false} />
        <Line points={profile} color="#ffd28a" lineWidth={1.6} />
        <Line points={[[0.6, SI_TOP - IMPLANT.rp * NM, 0.08], [0.95, SI_TOP - IMPLANT.rp * NM, 0.08]]} color="#9fd18a" lineWidth={1} dashed dashSize={0.02} gapSize={0.015} />
      </group>
      <TechLabel position={[0.48, -0.14, 0.05]} title={`Rp ≈ ${IMPLANT.rp} nm`} lines={[`straggle ≈ ${IMPLANT.drp} nm`, 'concentration profile →']} min={2} />
      <TechLabel position={[-0.66, 0.4, 0.05]} title="B⁺ IONS · 20 keV" min={2} value={() => `dose ${engine.tele.value('dose', 0).toFixed(2)} ×10¹⁵ /cm² · SIMULATED`} />
      <TechLabel position={[-0.66, 0.18, 0.05]} title="RESIST MASK STOPS IONS" min={3} />
    </Inset>
  );
}

function BeamScreen() {
  return (
    <group position={[WX + 0.95, 0, -0.6]} rotation={[0, -0.6, 0]}>
      <Screen
        size={[0.62, 0.4]}
        position={[0, 1.5, 0.03]}
        hz={5}
        draw={(g, w, h) => {
          clear(g, w, h, 'BEAM · DOSE · SIMULATED');
          bigNumber(g, 'ENERGY', engine.tele.value('energy', 0).toFixed(1), 'keV', w * 0.05, h * 0.21, h * 0.1);
          bigNumber(g, 'CURRENT', engine.tele.value('current', 0).toFixed(2), 'mA', w * 0.37, h * 0.21, h * 0.1);
          bigNumber(g, 'DOSE', engine.tele.value('dose', 0).toFixed(2), '×10¹⁵', w * 0.69, h * 0.21, h * 0.1);
          const c = engine.tele.get('dose');
          plot(g, c ? c.series().slice(-200) : [], w * 0.05, h * 0.5, w * 0.9, h * 0.4, 0, 2.2, SCR.data);
        }}
      />
    </group>
  );
}

export default function ImplantScene() {
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.02;
  }, []);
  return (
    <>
      <Lighting env="cleanroom" shadowExtent={7} />
      <CleanroomBay width={13} depth={9} height={4.4} />
      <Implanter />
      <Beam />
      <EndStationWafer />
      <ImplantInset />
      <BeamScreen />
      <SensorIndicator id="faraday-cup" channel="dose" machine="implanter" position={[WX - 0.05, Y + 0.24, -0.25]} size={0.04} />
      <SensorIndicator id="ion-gauge" channel="vac" machine="implanter" position={[0.4, Y + 0.24, 0.12]} size={0.04} />
      <TechLabel position={[MC.x - 0.2, Y + 0.45, MC.z]} title="ANALYZER MAGNET" lines={['selected mass passes the slit', 'lighter ions bend more, heavier less']} min={2} />
      <TechLabel position={[0.4, Y + 0.35, 0.1]} title="ACCELERATION" min={2} value={() => `${engine.tele.value('energy', 0).toFixed(0)} keV → depth`} />
      <TechLabel position={[MC.x - RM, Y + 0.4, SRC_Z - 0.2]} title="ION SOURCE" lines={['BF₃ → B⁺ (representative)']} min={2} />
      <TechLabel position={[WX - 0.3, 1.95, 0.2]} title="END STATION" min={2} value={() => engine.player.view.phase.label} />
      <Operator position={[-2.2, 0, 1.6]} rotation={Math.PI * 0.8} still />
    </>
  );
}
