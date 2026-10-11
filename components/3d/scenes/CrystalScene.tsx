'use client';
/**
 * Czochralski crystal growth (§12) and ingot removal.
 * The ingot is a lathe of the real neck → crown → body → tail profile, grown from the
 * melt interface as the simulated pull proceeds; diameter wobble follows the
 * melt-temperature failure scenario.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, Hall } from '../environments';
import { M, shell, effectiveView } from '../materials';
import { B, C, GEO, Pipe } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { FlowLine } from '../parts/section';
import { Operator } from '../parts/people';
import { useUI } from '@/lib/store';
import { engine } from '@/simulation/engine';
import { pp, pdt } from '@/lib/anim';
import { track, cutPlane } from '@/lib/runtime';
import { czLength, czRadiusAt, CZ_TOTAL, CZ_BODY_R } from '@/simulation/models';
import { Kit, cabinet, flange, viewport, bellows, iBeam, handrail, hmi, estop, gasStick, hose, grille, ledStrip, boltCircle } from '../kit/build';
import { KM } from '../kit/finish';
import { Baked, useKit } from '../kit/Baked';
import { rng, smooth, clamp, lerp } from '@/lib/math';

/** melt surface height (world) — the crucible is raised to keep it constant */
const MELT_Y = 1.32;
const CHAMBER = { r: 0.78, y0: 0.62, y1: 2.05 };
const PULL = { r: 0.32, y0: 2.3, y1: 5.0 };

const crystalMat = new THREE.MeshStandardMaterial({ color: '#7d848d', roughness: 0.16, metalness: 0.9, emissive: new THREE.Color('#ff7a2a'), emissiveIntensity: 0, toneMapped: false });
const meltMat = new THREE.MeshStandardMaterial({ color: '#fff0d0', emissive: new THREE.Color('#ffae55'), emissiveIntensity: 1.6, roughness: 0.15, metalness: 0.3, toneMapped: false });
const heaterMat = new THREE.MeshStandardMaterial({ color: '#2b2b2c', emissive: new THREE.Color('#ff6a1a'), emissiveIntensity: 0, roughness: 0.8, toneMapped: false });
const crucibleMat = new THREE.MeshPhysicalMaterial({ color: '#f2f0ea', roughness: 0.2, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
const feltMat = new THREE.MeshStandardMaterial({ color: '#3a3836', roughness: 0.95, side: THREE.DoubleSide });
const polyMat = new THREE.MeshStandardMaterial({ color: '#8c9196', roughness: 0.35, metalness: 0.85 });
const ringMat = new THREE.MeshBasicMaterial({ color: '#fff4d6', toneMapped: false });

/** Lathe geometry of the grown crystal: y = 0 at the growth interface, y = L at the seed. */
function crystalGeometry(L: number, wobble: number): THREE.BufferGeometry {
  const n = 96;
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, 0)];
  for (let i = 0; i <= n; i++) {
    const y = (L * i) / n;
    pts.push(new THREE.Vector2(Math.max(0.0005, czRadiusAt(L - y, wobble)), y));
  }
  pts.push(new THREE.Vector2(0, L));
  const g = new THREE.LatheGeometry(pts, 56);
  g.computeVertexNormals();
  return g;
}


/* ------------------------------------------------------------ static equipment (kit) */

/** Lower furnace: water-jacketed double-wall chamber, flanged dish head, viewports, hoses. */
function buildChamber(k: Kit, sh: boolean) {
  const o = { shell: sh };
  const { r, y0, y1 } = CHAMBER;
  // support skirt between the platform and the bottom flange
  k.cyl(KM.steel, r * 0.86, y0 - 0.47, [0, (y0 + 0.47) / 2, 0], [0, 0, 0], 48, o);
  // inner wall + water jacket with weld beads
  k.cyl(KM.stainless, r, y1 - y0, [0, (y0 + y1) / 2, 0], [0, 0, 0], 72, { ...o, open: true });
  k.cyl(KM.stainlessDark, r + 0.022, y1 - y0 - 0.16, [0, (y0 + y1) / 2, 0], [0, 0, 0], 72, { ...o, open: true });
  for (const y of [y0 + 0.08, y1 - 0.08]) k.torus(KM.stainless, r + 0.022, 0.006, [0, y, 0], [0, 0, 0], 72, o);
  // vertical jacket ribs
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    k.box(KM.stainless, [0.014, y1 - y0 - 0.2, 0.012], [Math.cos(a) * (r + 0.03), (y0 + y1) / 2, Math.sin(a) * (r + 0.03)], [0, -a, 0], o);
  }
  flange(k, r + 0.01, y0 + 0.02, { ...o, bolts: 32 });
  flange(k, r + 0.03, 1.5, { ...o, bolts: 36 });
  // dished head up to the neck
  const head: [number, number][] = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    head.push([r * Math.cos(t * Math.PI * 0.42) * (1 - t * 0.55) + 0.3 * t * 0.3, y1 + Math.sin(t * Math.PI * 0.5) * 0.24]);
  }
  head.push([0.3, y1 + 0.27]);
  k.lathe(KM.stainless, head, [0, 0, 0], [0, 0, 0], 72, o);
  flange(k, r + 0.01, y1, { ...o, bolts: 32 });
  // viewports aimed at the melt (pyrometer / diameter camera / operator)
  k.at([0.52, y1 + 0.12, 0.3], [-0.9, 0.62, 0], () => viewport(k, 0.06, 0.12, o));
  k.at([-0.5, y1 + 0.12, 0.34], [-0.9, -0.56, 0], () => viewport(k, 0.06, 0.12, o));
  k.at([0.0, y1 + 0.1, -0.6], [-1.1, Math.PI, 0], () => viewport(k, 0.05, 0.1, o));
  // lifting lugs
  for (const a of [0.4, 2.5, 4.6]) k.box(KM.stainless, [0.05, 0.12, 0.06], [Math.cos(a) * (r + 0.05), y1 - 0.12, Math.sin(a) * (r + 0.05)], [0, -a, 0], o);
  // cooling-water supply/return: blue and red tagged copper headers into the jacket
  for (const [i, y] of [[0, 0.8], [1, 1.8]] as const) {
    const a = 0.25 + i * 0.12;
    const x = Math.cos(a) * (r + 0.03);
    const z = Math.sin(a) * (r + 0.03);
    k.pipe(KM.copper, [[x, y, z], [x + 0.35, y, z + 0.1], [1.3, y, 0.55]], 0.02, 0.06, o);
    k.cyl(i ? KM.paintRed : KM.paintBlue, 0.024, 0.05, [x + 0.25, y, z + 0.07], [0, 0, Math.PI / 2], 16, o);
  }
}

/** Isolation valve, pull chamber, pull head housing. */
function buildUpper(k: Kit, sh: boolean) {
  const o = { shell: sh };
  // gate valve body + pneumatic actuator
  k.rbox(KM.stainless, [0.86, 0.2, 0.46], 0.02, [0.12, 2.42, 0], [0, 0, 0]);
  k.cyl(KM.anodized, 0.08, 0.42, [0.72, 2.42, 0], [0, 0, Math.PI / 2], 24);
  k.cyl(KM.chrome, 0.018, 0.12, [0.98, 2.42, 0], [0, 0, Math.PI / 2], 12);
  boltCircle(k, 0.34, 16, 2.53, 0.01);
  k.label('warn', 'VACUUM', '', 0.07, 0.07, [0.3, 2.42, 0.232]);
  // pull chamber with flanges, a viewport and ribs
  const { r, y0, y1 } = PULL;
  k.cyl(KM.stainless, r, y1 - y0, [0, (y0 + y1) / 2, 0], [0, 0, 0], 56, { ...o, open: true });
  for (const y of [y0 + 0.24, 3.4, 4.3, y1 - 0.02]) flange(k, r, y, { ...o, bolts: 16 });
  k.at([0, 3.1, r], [0, 0, 0], () => viewport(k, 0.045, 0.09, o));
  k.label('model', 'PULL CHAMBER', 'Ar purge · 20 mbar', 0.24, 0.06, [0, 3.85, r + 0.002]);
  // pull head housing
  k.at([0, 5.0, 0], 0, () => {
    k.rbox(KM.paint, [0.92, 0.5, 0.74], 0.04, [0.12, 0.25, 0]);
    k.rbox(KM.paintGraphite, [0.94, 0.05, 0.76], 0.02, [0.12, 0.01, 0]);
    k.box(KM.paintAccent, [0.92, 0.02, 0.004], [0.12, 0.44, 0.371], [0, 0, 0], { cast: false });
    grille(k, 0.3, 0.14, [0.34, 0.22, 0.372]);
    k.label('model', 'CZ-07', 'CRYSTAL PULLER · 300 mm', 0.3, 0.075, [-0.12, 0.3, 0.372]);
    // seed-lift motor and encoder
    k.cyl(KM.anodizedDark, 0.09, 0.26, [0.4, 0.62, -0.1], [0, 0, 0], 28);
    k.cyl(KM.anodized, 0.07, 0.06, [0.4, 0.78, -0.1], [0, 0, 0], 28);
    for (let i = 0; i < 10; i++) k.box(KM.anodizedDark, [0.004, 0.2, 0.024], [0.4 + Math.cos(i * 0.63) * 0.092, 0.6, -0.1 + Math.sin(i * 0.63) * 0.092], [0, -i * 0.63, 0], { cast: false });
    // rotation feedthrough
    bellows(k, 0.12, 0.2, 8, [0, -0.2, 0], KM.stainless);
  });
}

/** Furnace base, operator platform with stairs and handrails, lift column, utilities. */
function buildBase(k: Kit) {
  // furnace base (crucible lift + rotation drive)
  cabinet(k, { size: [2.3, 0.45, 2.3], body: KM.paintGrey, trim: KM.paintGraphite, panels: 3, rows: [], sidePanels: 3, stripe: false, vent: false, ao: false });
  grille(k, 0.5, 0.18, [0.6, 0.24, 1.152]);
  grille(k, 0.5, 0.18, [-0.6, 0.24, 1.152]);
  // grating platform with toe boards
  k.box(KM.steel, [3.4, 0.04, 3.4], [0, 0.47, 0]);
  for (let i = -16; i <= 16; i++) k.box(KM.stainlessDark, [3.38, 0.006, 0.012], [0, 0.493, i * 0.1], [0, 0, 0], { cast: false });
  for (const [x, z, w, d] of [[0, -1.7, 3.4, 0.01], [-1.7, 0, 0.01, 3.4], [1.7, -0.45, 0.01, 2.5]] as const) k.box(KM.paintYellow, [w, 0.1, d], [x, 0.54, z], [0, 0, 0]);
  handrail(k, [[1.68, 0.49, 0.75], [1.68, 0.49, -1.68], [-1.68, 0.49, -1.68], [-1.68, 0.49, 1.68], [0.6, 0.49, 1.68]]);
  // stairs down the front-right
  for (let i = 0; i < 4; i++) k.box(KM.steel, [0.9, 0.035, 0.26], [1.15, 0.38 - i * 0.12, 1.85 + i * 0.24], [0, 0, 0]);
  for (const x of [0.68, 1.62]) k.box(KM.paintYellow, [0.03, 0.1, 1.15], [x, 0.22, 2.12], [0.42, 0, 0]);
  // platform legs
  for (const [x, z] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) k.box(KM.paintGrey, [0.08, 0.45, 0.08], [x, 0.225, z]);
  // lift column (I-beam) with carriage arm to the pull head
  iBeam(k, 5.7, [-1.15, 0.49, -0.75], 0.3, KM.paintGrey);
  k.rbox(KM.paint, [0.42, 0.5, 0.42], 0.02, [-1.15, 5.12, -0.75]);
  k.box(KM.paintGrey, [1.05, 0.16, 0.16], [-0.62, 5.15, -0.42], [0, -0.55, 0]);
  k.cyl(KM.chrome, 0.035, 3.2, [-0.92, 2.2, -0.75], [0, 0, 0], 16);
  k.cyl(KM.anodizedDark, 0.07, 1.4, [-0.92, 1.2, -0.75], [0, 0, 0], 24);
  k.label('warn', 'HOT SURFACE', '', 0.12, 0.12, [-1.0, 1.6, -0.6], [0, 0.6, 0]);
  // power & control cabinet
  k.at([1.9, 0, -0.9], -0.35, () => {
    cabinet(k, { size: [0.9, 1.6, 0.7], panels: 1, rows: [0.5], handles: true, feet: false });
    k.label('model', 'POWER UNIT', '480 V · heater 160 kW', 0.32, 0.08, [0, 1.42, 0.352]);
    k.label('warn', 'HIGH VOLTAGE', '', 0.1, 0.1, [0.3, 1.2, 0.352]);
    ledStrip(k, 0.5, [0, 1.52, 0.352]);
    estop(k, [-0.32, 1.2, 0.35]);
  });
  // HMI on a swing arm from the platform rail
  hmi(k, [1.55, 1.55, 1.05], -0.8);
  // argon gas panel on a frame behind the puller
  k.at([-0.2, 0, -2.0], 0, () => {
    cabinet(k, { size: [1.2, 1.9, 0.35], panels: 2, rows: [0.6], vent: false, feet: false });
    for (const [i, y] of [[0, 1.1], [1, 1.35], [2, 1.6]] as const) {
      gasStick(k, 0.9, [0, y, 0.2]);
      k.label('gas', i === 2 ? 'N₂' : 'Ar', '', 0.12, 0.026, [-0.5, y + 0.05, 0.222], [0, 0, 0], i === 2 ? '#2f5d8a' : '#3e7d4c');
    }
  });
  // vacuum pump on the floor, piped to the chamber exhaust
  k.at([-1.9, 0, 1.0], 0.5, () => {
    cabinet(k, { size: [0.7, 0.55, 0.5], body: KM.paintBlue, trim: KM.paintGraphite, panels: 1, rows: [], vent: true, stripe: false });
    k.cyl(KM.anodized, 0.12, 0.3, [0, 0.72, 0], [0, 0, Math.PI / 2], 24);
  });
  hose(k, [1.75, 1.2, -0.62], [0.8, 0.55, 0.8], 0.018, 0.1, KM.rubber);
  hose(k, [1.7, 1.0, -0.62], [0.4, 0.55, 1.0], 0.015, 0.08, KM.plastic);
  k.ao(3.6, 3.6, [0, 0, 0], 1.25);
}

/** A neighbouring puller in the hall: same equipment, no cut-away, one merged model. */
function buildNeighbour(k: Kit) {
  buildChamber(k, false);
  buildUpper(k, false);
  cabinet(k, { size: [2.3, 0.45, 2.3], body: KM.paintGrey, trim: KM.paintGraphite, panels: 3, rows: [], stripe: false, vent: false });
  iBeam(k, 5.7, [-1.15, 0.0, -0.75], 0.3, KM.paintGrey);
  k.rbox(KM.paint, [0.42, 0.5, 0.42], 0.02, [-1.15, 5.12, -0.75]);
  k.box(KM.paintGrey, [1.05, 0.16, 0.16], [-0.62, 5.15, -0.42], [0, -0.55, 0]);
}

function Puller({ variant }: { variant: string }) {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  const view = effectiveView(viewRaw, cam);
  const crystal = useRef<THREE.Mesh>(null);
  const crystalGroup = useRef<THREE.Group>(null);
  const seedGroup = useRef<THREE.Group>(null);
  const melt = useRef<THREE.Mesh>(null);
  const crucible = useRef<THREE.Group>(null);
  const meniscus = useRef<THREE.Mesh>(null);
  const chunks = useRef<THREE.InstancedMesh>(null);
  const glow = useRef<THREE.PointLight>(null);
  const lastKey = useRef('');
  const rot = useRef(0);
  const o = useMemo(() => new THREE.Object3D(), []);
  const seeds = useMemo(() => {
    const r = rng(17);
    return Array.from({ length: 70 }, () => ({ x: (r() - 0.5) * 0.65, z: (r() - 0.5) * 0.65, y: r() * 0.25, s: 0.04 + r() * 0.05, a: r() * 6 }));
  }, []);

  useFrame((_, dt) => {
    const v = engine.player.view;
    const remove = variant === 'remove';
    const growing = engine.stage.id === 'crystal-growth';
    const wobble = growing ? engine.failSeverity('cz-temp') : 0;
    const L = remove ? CZ_TOTAL : growing ? czLength(v.phaseId, v.phaseT) : 0;
    // separation lift and removal for the ingot stage
    const sep = remove ? smooth(pp('separate')) * 0.12 + smooth(pp('cool')) * 0.25 : 0;
    const key = `${Math.round(L * 200)}:${Math.round(wobble * 20)}`;
    if (crystal.current && key !== lastKey.current) {
      lastKey.current = key;
      crystal.current.geometry.dispose();
      crystal.current.geometry = L > 0.002 ? crystalGeometry(L, wobble) : new THREE.BufferGeometry();
    }
    rot.current += pdt(dt) * 1.2;
    if (crystalGroup.current) {
      crystalGroup.current.position.y = MELT_Y + sep;
      crystalGroup.current.rotation.y = rot.current;
    }
    if (seedGroup.current) seedGroup.current.position.y = MELT_Y + sep + L + (growing && v.phaseId === 'dip' ? (1 - smooth(v.phaseT)) * 0.35 : 0) + (growing && (v.phaseId === 'melt' || v.phaseId === 'stabilize') ? 0.35 : 0);
    if (crucible.current) crucible.current.rotation.y = -rot.current * 0.5;
    // melt: chunks melt down during “melt”, then the melt is consumed as the crystal grows
    const meltProg = growing ? pp('melt') : 1;
    const consumed = L / CZ_TOTAL;
    if (melt.current) {
      melt.current.visible = !remove || pp('lift') < 0.5;
      melt.current.scale.setScalar(remove ? 0.35 : lerp(0.2, 1, smooth(meltProg * 1.3)));
      (melt.current.material as THREE.MeshStandardMaterial).emissiveIntensity = remove ? lerp(1.4, 0.4, pp('cool')) : 1.6;
    }
    if (crucible.current) crucible.current.position.y = consumed * 0.22;
    if (chunks.current) {
      seeds.forEach((s, i) => {
        const k = clamp(meltProg * 1.6 - s.y * 2);
        o.position.set(s.x, MELT_Y - 0.06 + s.y * (1 - k) - k * 0.08, s.z);
        o.rotation.set(s.a, s.a * 2, 0);
        o.scale.setScalar(growing ? s.s * (1 - k) + 0.0001 : 0.0001);
        o.updateMatrix();
        chunks.current!.setMatrixAt(i, o.matrix);
      });
      chunks.current.instanceMatrix.needsUpdate = true;
    }
    if (meniscus.current) {
      const r = L > 0 && !remove ? czRadiusAt(Math.max(0, L - 0.001), wobble) : 0;
      meniscus.current.visible = r > 0.002;
      meniscus.current.scale.setScalar(Math.max(0.001, r * 1.06));
      meniscus.current.position.y = MELT_Y + 0.003;
    }
    // freshly grown silicon glows near the interface; the ingot cools in the removal stage
    crystalMat.emissiveIntensity = remove ? lerp(0.5, 0, smooth(pp('cool'))) : growing && L > 0 ? 0.35 : 0;
    if (glow.current) glow.current.intensity = remove ? lerp(6, 0, pp('cool')) : growing ? 3 + 6 * smooth(meltProg) : 0;
    track('focus', 0, MELT_Y + Math.min(L, 1.2) * 0.5 + sep, 0);
  });

  const base = useKit(buildBase);
  const chamber = useKit((k) => buildChamber(k, true));
  const upper = useKit((k) => buildUpper(k, true));
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'cz-puller', label: 'Czochralski crystal puller' }}>
        <Baked parts={base} />
        <Clickable sel={{ kind: 'component', id: 'chamber', machine: 'cz-puller', label: 'Water-cooled chamber' }}>
          <Baked parts={chamber} view={view} />
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'pull-head', machine: 'cz-puller', label: 'Pull & rotation head' }}>
          <Baked parts={upper} view={view} />
        </Clickable>
        {/* hot zone (visible in cutaway / x-ray) */}
        <group ref={crucible}>
          <Clickable sel={{ kind: 'component', id: 'crucible', machine: 'cz-puller', label: 'Quartz crucible & graphite susceptor' }}>
            <mesh position={[0, MELT_Y - 0.17, 0]} material={crucibleMat}>
              <cylinderGeometry args={[0.43, 0.41, 0.42, 48, 1, true]} />
            </mesh>
            <C r={0.43} h={0.02} m={crucibleMat} position={[0, MELT_Y - 0.38, 0]} />
            <C r={0.47} h={0.5} m={M.graphite} position={[0, MELT_Y - 0.36, 0]} open />
            {/* rotation markers on susceptor */}
            {[0, 1, 2, 3].map((k) => (
              <B key={k} s={[0.03, 0.4, 0.01]} m={M.steelDark} position={[Math.cos((k * Math.PI) / 2) * 0.475, MELT_Y - 0.36, Math.sin((k * Math.PI) / 2) * 0.475]} rotation={[0, -(k * Math.PI) / 2, 0]} />
            ))}
            <C r={0.06} h={0.6} m={M.graphite} position={[0, MELT_Y - 0.9, 0]} />
          </Clickable>
        </group>
        <mesh ref={melt} position={[0, MELT_Y, 0]} rotation={[-Math.PI / 2, 0, 0]} material={meltMat}>
          <circleGeometry args={[0.41, 48]} />
        </mesh>
        <instancedMesh ref={chunks} args={[GEO.box, polyMat, 70]} />
        <Clickable sel={{ kind: 'component', id: 'heater', machine: 'cz-puller', label: 'Graphite heater' }}>
          <mesh position={[0, MELT_Y - 0.18, 0]} material={heaterMat}>
            <cylinderGeometry args={[0.56, 0.56, 0.58, 48, 1, true]} />
          </mesh>
        </Clickable>
        <mesh position={[0, MELT_Y - 0.1, 0]} material={feltMat}>
          <cylinderGeometry args={[0.68, 0.68, 0.9, 40, 1, true]} />
        </mesh>
        <Clickable sel={{ kind: 'component', id: 'heat-shield', machine: 'cz-puller', label: 'Heat shield' }}>
          <mesh position={[0, MELT_Y + 0.22, 0]} material={feltMat}>
            <cylinderGeometry args={[0.2, 0.5, 0.35, 40, 1, true]} />
          </mesh>
        </Clickable>
        <pointLight ref={glow} position={[0, MELT_Y + 0.15, 0]} color="#ffa04a" distance={3.2} decay={1.6} />
        {/* the crystal */}
        <group ref={crystalGroup}>
          <Clickable sel={{ kind: 'wafer', id: 'ingot', label: 'Growing single-crystal ingot' }}>
            <mesh ref={crystal} material={crystalMat} castShadow />
          </Clickable>
        </group>
        <mesh ref={meniscus} rotation={[-Math.PI / 2, 0, 0]} material={ringMat}>
          <ringGeometry args={[0.97, 1.08, 64]} />
        </mesh>
        <group ref={seedGroup}>
          <Clickable sel={{ kind: 'component', id: 'seed', machine: 'cz-puller', label: 'Seed crystal & chuck' }}>
            <C r={0.005} h={0.1} m={M.siCrystal} position={[0, 0.05, 0]} />
            <C r={0.025} h={0.06} m={M.steelDark} position={[0, 0.13, 0]} />
            <C r={0.0025} h={6} m={M.steel} position={[0, 3.16, 0]} />
          </Clickable>
        </group>
      </Clickable>
      <FlowLine points={[[0.12, 4.9, 0], [0.12, 2.4, 0], [0.12, MELT_Y + 0.4, 0], [0.55, MELT_Y + 0.25, 0], [0.6, 0.75, 0]]} color="#b8d4a8" speed={0.4} />
      <SensorIndicator id="diameter-camera" channel="diam" machine="cz-puller" position={[0.62, 2.36, 0.3]} size={0.08} />
      <SensorIndicator id="pyrometer" channel="melt" machine="cz-puller" position={[-0.58, 2.36, 0.34]} size={0.08} />
      <SensorIndicator id="capacitance-manometer" machine="cz-puller" position={[0.3, 2.2, 0.32]} size={0.06} />
      <SignalTower position={[1.9, 1.6, -0.9]} />
      <TechLabel position={[0, 5.75, 0]} title="PULL HEAD · SEED LIFT + ROTATION" lines={['pull rate & rpm under closed-loop control']} />
      <TechLabel position={[0.95, MELT_Y + 0.05, 0.4]} title="Si MELT > 1414 °C" lines={['quartz crucible · graphite heater · argon']} min={2} />
      <TechLabel position={[-0.95, 3.4, 0]} title="PULL CHAMBER" lines={['ingot rises here as it grows']} />
      <TechLabel position={[0.3, MELT_Y + 0.6, 0.3]} title="CRYSTAL" value={() => `L ${Math.round(engine.tele.value('length', 0))} mm · Ø ${engine.tele.value('diam', 0).toFixed(1)} mm · SIM`} min={3} />
    </group>
  );
}

function Neighbours() {
  const parts = useKit((k) => {
    for (const x of [-5.2, 5.2]) k.at([x, 0, -4.2], 0, () => buildNeighbour(k));
  });
  return (
    <>
      <Baked parts={parts} />
      {[-5.2, 5.2].map((x) => (
        <SignalTower key={x} position={[x + 1.25, 0.46, -3.6]} state={() => 'PROCESSING'} />
      ))}
    </>
  );
}

/** Removal stage: the finished ingot leaves the puller on a cart. */
function RemovedIngot() {
  const g = useRef<THREE.Group>(null);
  const geo = useMemo(() => crystalGeometry(CZ_TOTAL, 0), []);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#7d848d', roughness: 0.16, metalness: 0.9 }), []);
  useFrame(() => {
    const lift = pp('lift');
    const transfer = pp('transfer');
    if (!g.current) return;
    g.current.visible = lift > 0.45;
    const x = lerp(1.6, 2.6, smooth(transfer));
    g.current.position.set(x + transfer * 3, 0.95, 0.8);
    if (lift > 0.45) track('focus', x, 1.0, 0.8);
  });
  return (
    <group>
      <group ref={g} visible={false}>
        <mesh geometry={geo} material={mat} rotation={[0, 0, Math.PI / 2]} position={[CZ_TOTAL / 2, 0, 0]} castShadow />
        <TechLabel position={[0, 0.35, 0]} title="INGOT IG-0447 · → WAFERING" min={1} tone="accent" />
      </group>
    </group>
  );
}

function Cart() {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    if (g.current) g.current.position.x = 2.6 + pp('transfer') * 3;
  });
  return (
    <group ref={g} position={[2.6, 0, 0.8]}>
      <B s={[2.4, 0.08, 0.7]} m={M.steel} position={[0, 0.7, 0]} />
      <B s={[2.4, 0.4, 0.06]} m={M.yellow} position={[0, 0.4, 0.32]} />
      {[-1, 1].map((x) => [-0.3, 0.3].map((z) => <C key={`${x}${z}`} r={0.1} h={0.06} m={M.rubber} position={[x, 0.1, z]} rotation={[Math.PI / 2, 0, 0]} />))}
      {[-0.8, 0.8].map((x) => (
        <B key={x} s={[0.08, 0.2, 0.5]} m={M.rubber} position={[x, 0.83, 0]} />
      ))}
    </group>
  );
}

export default function CrystalScene({ stage }: SceneProps) {
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.0;
  }, []);
  const variant = stage.variant ?? 'grow';
  return (
    <>
      <Lighting env="hall" shadowExtent={10} />
      <Hall width={40} depth={22} height={11} />
      <Puller variant={variant} />
      {/* neighbouring pullers in the growth hall */}
      <Neighbours />
      <Operator position={[-2.2, 0.5, 1.5]} rotation={Math.PI / 3} still />
      {variant === 'remove' && (
        <>
          <Cart />
          <RemovedIngot />
        </>
      )}
      <TechLabel position={[-3.2, 0.9, 1.6]} title={`BODY Ø ≈ ${Math.round(CZ_BODY_R * 2000)} mm → GROUND TO 300 mm`} min={3} />
    </>
  );
}
