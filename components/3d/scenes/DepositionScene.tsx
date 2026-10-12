'use client';
/**
 * Thin-film deposition (§22): CVD, PVD and ALD animated differently —
 *   CVD: precursor flow → surface reaction → film; by-products pumped away
 *   PVD: Ar⁺ ions hit the target → ejected atoms fly line-of-sight → film (thin sidewalls)
 *   ALD: precursor A → purge → precursor B → purge → one atomic layer per cycle
 * The trench cross-section shows each method's step coverage, at a physical scale.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, CleanroomBay } from '../environments';
import { M } from '../materials';
import { GEO } from '../parts/primitives';
import { Clickable, SensorIndicator, TechLabel } from '../parts/interaction';
import { Inset, LiveProfile, ProfileSlab } from '../parts/section';
import { ClusterTool, Pedestal, Showerhead, CHAMBER, useFolded, buildClusterNeighbour, rfCable } from '../parts/cluster';
import { Kit, boltCircle, grille, ledStrip, type V3 } from '../kit/build';
import { KM } from '../kit/finish';
import { Baked } from '../kit/Baked';
import { substrateWithTrench, filmOverTrench, TRENCH } from '../parts/profiles';
import { Operator } from '../parts/people';
import { engine } from '@/simulation/engine';
import { inPhase, pdt } from '@/lib/anim';
import { cutPlane } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { useParam } from '@/hooks/useTicker';
import { rng } from '@/lib/math';
import { oxideColor } from '@/simulation/models';

type Mode = 'cvd' | 'pvd' | 'ald';
const MODES: Mode[] = ['cvd', 'pvd', 'ald'];

const siMat = new THREE.MeshStandardMaterial({ color: '#7a828c', roughness: 0.45, metalness: 0.6 });
const filmMats: Record<Mode | 'gap', THREE.MeshStandardMaterial> = {
  cvd: new THREE.MeshStandardMaterial({ color: '#9db7a4', roughness: 0.3, metalness: 0.1 }),
  pvd: new THREE.MeshStandardMaterial({ color: '#c08a5a', roughness: 0.3, metalness: 0.9 }),
  ald: new THREE.MeshStandardMaterial({ color: '#c9b46a', roughness: 0.3, metalness: 0.2 }),
  gap: new THREE.MeshStandardMaterial({ color: '#a9c2a0', roughness: 0.35, metalness: 0.05, transparent: true, opacity: 0.92 }),
};
const molA = new THREE.MeshStandardMaterial({ color: '#d0b070', roughness: 0.5 });
const molB = new THREE.MeshStandardMaterial({ color: '#6fb39a', roughness: 0.5 });
const molX = new THREE.MeshStandardMaterial({ color: '#8a8f86', roughness: 0.6, transparent: true, opacity: 0.7 });
const ionMat = new THREE.MeshBasicMaterial({ color: '#c9a6ff', toneMapped: false });
const plasmaMat = new THREE.MeshBasicMaterial({ color: '#c9a6ff', transparent: true, opacity: 0.2, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });

/** Inset scale: metres per inset unit. The trench (0.26 units wide) is drawn at a real width per method. */
const MPU: Record<Mode | 'gap', number> = {
  cvd: 180e-9 / 0.26, // 180 nm trench, 50 nm film
  pvd: 180e-9 / 0.26,
  ald: 20e-9 / 0.26, // 20 nm trench, 4 nm film (40 cycles × 0.1 nm)
  gap: 500e-9 / 0.26, // 500 nm trench filled by 420 nm of oxide
};

/** Step coverage per method: fraction of the top thickness reaching sidewall / bottom. */
function coverage(mode: Mode | 'gap', t: number) {
  if (mode === 'gap') return { top: t, side: t * 0.9, bot: t * 0.95, oh: 0 };
  if (mode === 'pvd') return { top: t, side: t * 0.22, bot: t * 0.45, oh: t * 0.3 };
  if (mode === 'ald') return { top: t, side: t, bot: t, oh: 0 };
  return { top: t, side: t * 0.72, bot: t * 0.82, oh: 0 };
}

/* --------------------------------------------------------- chamber particles */

const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);

function ChamberParticles({ mode }: { mode: Mode }) {
  const N = 160;
  const a = useRef<THREE.InstancedMesh>(null);
  const b = useRef<THREE.InstancedMesh>(null);
  const x = useRef<THREE.InstancedMesh>(null);
  const ions = useRef<THREE.InstancedMesh>(null);
  const plasma = useRef<THREE.Mesh>(null);
  const seeds = useMemo(() => {
    const r = rng(42);
    return Array.from({ length: N }, () => ({ r: Math.sqrt(r()) * 0.17, ang: r() * Math.PI * 2, o: r(), s: 0.6 + r() * 0.8, k: r() }));
  }, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const t = useRef(0);
  useFrame((_, dt) => {
    const meshes = [a.current, b.current, x.current, ions.current];
    if (meshes.some((m) => !m)) return;
    const [ma, mb, mx, mi] = meshes as THREE.InstancedMesh[];
    const dep = inPhase('deposit');
    t.current += pdt(dt);
    const top = 1.26;
    const bot = CHAMBER.waferY + 0.006;
    const put = (m: THREE.InstancedMesh, i: number, px: number, py: number, pz: number, s: number) => {
      o.position.set(px, py, pz);
      o.scale.setScalar(s);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    };
    // ALD: 40 cycles across the deposit phase; each = A pulse, purge, B pulse, purge
    const cyc = (engine.player.view.phaseT * 40) % 1;
    for (let i = 0; i < N; i++) {
      for (const m of meshes as THREE.InstancedMesh[]) m.setMatrixAt(i, HIDE);
      if (!dep) continue;
      const s = seeds[i];
      if (mode === 'cvd') {
        // precursors stream from the showerhead down to the surface; by-products drift to the pump ring
        const u = (t.current * 0.35 * s.s + s.o) % 1;
        if (s.k < 0.7) put(ma, i, Math.cos(s.ang) * s.r, top - u * (top - bot), Math.sin(s.ang) * s.r, 0.012);
        else put(mx, i, Math.cos(s.ang) * (0.18 + u * 0.25), bot + 0.02 + u * 0.05, Math.sin(s.ang) * (0.18 + u * 0.25), 0.011);
      } else if (mode === 'pvd') {
        // Ar⁺ ions accelerate up into the target; sputtered metal atoms fly down in straight lines
        const u = (t.current * 0.6 * s.s + s.o) % 1;
        if (s.k < 0.35) put(mi, i, Math.cos(s.ang) * s.r, bot + 0.04 + u * (top - bot - 0.06), Math.sin(s.ang) * s.r, 0.007);
        else {
          const spread = (s.k - 0.67) * 0.5 * u * 0.3;
          put(ma, i, Math.cos(s.ang) * s.r * 0.6 + spread, top - 0.02 - u * (top - bot - 0.02), Math.sin(s.ang) * s.r * 0.6, 0.009);
        }
      } else {
        // ALD: chamber fills with A, purge sweeps it out, then B, purge
        const py = bot + 0.01 + s.o * (top - bot - 0.02);
        const px = Math.cos(s.ang) * s.r * 1.2;
        const pz = Math.sin(s.ang) * s.r * 1.2;
        if (cyc < 0.25) put(ma, i, px, py, pz, 0.011);
        else if (cyc < 0.5 && s.k > (cyc - 0.25) * 4) put(ma, i, px + (cyc - 0.25) * 2, py, pz, 0.011);
        else if (cyc >= 0.5 && cyc < 0.75) put(mb, i, px, py, pz, 0.011);
        else if (cyc >= 0.75 && s.k > (cyc - 0.75) * 4) put(mb, i, px + (cyc - 0.75) * 2, py, pz, 0.011);
      }
    }
    for (const m of meshes as THREE.InstancedMesh[]) m.instanceMatrix.needsUpdate = true;
    if (plasma.current) {
      plasma.current.visible = dep && mode === 'pvd';
      plasmaMat.opacity = 0.18 + 0.05 * Math.sin(engine.time * 30);
    }
  });
  return (
    <group>
      <instancedMesh ref={a} args={[GEO.sphereLow, molA, N]} frustumCulled={false} />
      <instancedMesh ref={b} args={[GEO.sphereLow, molB, N]} frustumCulled={false} />
      <instancedMesh ref={x} args={[GEO.sphereLow, molX, N]} frustumCulled={false} />
      <instancedMesh ref={ions} args={[GEO.sphereLow, ionMat, N]} frustumCulled={false} />
      <mesh ref={plasma} position={[0, 1.24, 0]} rotation={[-Math.PI / 2, 0, 0]} material={plasmaMat}>
        <ringGeometry args={[0.06, 0.19, 40]} />
      </mesh>
    </group>
  );
}

/* --------------------------------------------------------- lid hardware (static, merged) */

const Z0: V3 = [0, 0, 0];
const RX: V3 = [0, 0, Math.PI / 2];
const RZ: V3 = [Math.PI / 2, 0, 0];
/** top of the active chamber's lid (chamber-local) */
const LID = 1.385;
/** bead-blasted aluminium (matches the cluster's vacuum hardware) */
const ALU = new THREE.MeshStandardMaterial({ color: '#c3c8cb', roughness: 0.78, metalness: 0.5, roughnessMap: KM.paint.roughnessMap });

/** Fast-switching pneumatic diaphragm valve (body, bonnet, coloured actuator, pilot fitting). */
function aldValve(k: Kit, pos: V3, cap: THREE.Material) {
  const [x, y, z] = pos;
  k.rbox(KM.stainless, [0.038, 0.026, 0.038], 0.004, [x, y + 0.013, z]);
  k.cyl(KM.stainless, 0.012, 0.02, [x, y + 0.036, z], Z0, 16);
  k.cyl(cap, 0.0155, 0.032, [x, y + 0.062, z], Z0, 18);
  k.cyl(KM.anodizedDark, 0.0162, 0.004, [x, y + 0.08, z], Z0, 18, { cast: false });
  k.cyl(KM.brass, 0.0035, 0.014, [x + 0.019, y + 0.068, z], RX, 8, { cast: false });
}

/**
 * CVD / ALD lid: isolator and gas inlet manifold on the lid centre, a row of fast valves,
 * the lid-mounted gas box on standoffs (MFCs behind a louvred cover), precursor lines
 * dropping down the back, and the RF feed to the showerhead.
 */
function buildLidGas(k: Kit, ald: boolean) {
  // isolator ring, inlet flange and manifold block
  k.cyl(KM.ptfe, 0.075, 0.022, [0, LID + 0.011, 0], Z0, 36);
  k.cyl(KM.stainless, 0.092, 0.012, [0, LID + 0.028, 0], Z0, 36);
  boltCircle(k, 0.08, 8, LID + 0.035, 0.0055);
  k.rbox(KM.stainless, [0.24, 0.042, 0.12], 0.006, [0, LID + 0.055, 0.01]);
  k.box(KM.seam, [0.242, 0.003, 0.122], [0, LID + 0.046, 0.01], Z0, { cast: false });
  // valve row on the manifold, towards the operator
  const caps = ald ? [KM.paintBlue, KM.plasticWhite, KM.paintBlue, KM.plasticWhite, KM.paintYellow] : [KM.paintBlue, KM.paintBlue, KM.plasticWhite, KM.paintGraphite];
  const n = caps.length;
  for (let i = 0; i < n; i++) aldValve(k, [-0.1 + (0.2 * i) / (n - 1), LID + 0.076, 0.045], caps[i]);
  k.label('tag', ald ? 'ALD VALVES' : 'GAS INLET', ald ? '≤ 10 ms · 4 LINES' : 'TEOS · O₂ · He', 0.12, 0.03, [0, LID + 0.058, 0.0712], Z0);
  // lid-mounted gas box on four standoffs
  const gy = LID + 0.09;
  const gh = 0.17;
  for (const [x, z] of [[-0.15, -0.03], [0.15, -0.03], [-0.15, -0.2], [0.15, -0.2]]) k.cyl(KM.stainless, 0.009, gy - LID, [x, LID + (gy - LID) / 2, z], Z0, 10);
  k.rbox(KM.paint, [0.34, gh, 0.22], 0.012, [0, gy + gh / 2, -0.115]);
  k.rbox(KM.paintGraphite, [0.348, 0.014, 0.228], 0.005, [0, gy + gh + 0.007, -0.115]);
  k.box(KM.seam, [0.342, 0.003, 0.222], [0, gy + 0.03, -0.115], Z0, { cast: false });
  grille(k, 0.14, 0.07, [-0.08, gy + 0.095, -0.0035], { m: KM.paint });
  k.label('model', ald ? 'ALD-4' : 'GB-300', ald ? 'PULSE GAS BOX' : 'LID GAS BOX · 4 MFC', 0.13, 0.032, [0.08, gy + 0.125, -0.0045], Z0);
  k.label('warn', 'TOXIC GAS', '', 0.045, 0.045, [0.08, gy + 0.065, -0.0045], Z0);
  ledStrip(k, 0.1, [0.08, gy + 0.03 + 0.012, -0.002], KM.ledGreen);
  for (const x of [-0.155, 0.155]) for (const y of [gy + 0.015, gy + gh - 0.015]) k.cyl(KM.stainlessDark, 0.005, 0.004, [x, y, -0.003], RZ, 8, { cast: false });
  // precursor lines: up out of the gas box, back, and down the rear of the chamber
  const gases: [string, string][] = ald ? [['TMA', '#7a4a8a'], ['H₂O', '#2f5d8a']] : [['TEOS', '#7a4a8a'], ['O₂', '#3e7d4c']];
  gases.forEach(([g, c], i) => {
    const x = 0.06 + i * 0.07;
    const z = -0.08 - i * 0.06;
    k.pipe(KM.stainless, [[x, gy + gh + 0.014, z], [x, gy + gh + 0.09, z], [x, gy + gh + 0.09, -0.6], [x, 0.02, -0.6]], 0.0065, 0.04);
    k.cyl(KM.stainless, 0.013, 0.02, [x, gy + gh + 0.024, z], Z0, 14);
    aldValve(k, [x, gy + gh + 0.09, -0.4], KM.paintBlue);
    k.at([x, 1.05, -0.6], Math.PI, () => k.label('gas', g, '', 0.07, 0.016, [0, 0, 0.009], Z0, c));
    k.box(KM.paintGraphite, [0.05, 0.004, 0.05], [x, 0.002, -0.6], Z0, { cast: false });
  });
  // RF feed to the showerhead: connector on the manifold, coax round the back
  k.cyl(KM.stainless, 0.022, 0.04, [0.14, LID + 0.055, 0.01], RX, 16);
  k.cyl(KM.stainlessDark, 0.026, 0.016, [0.165, LID + 0.055, 0.01], RX, 6);
  rfCable(k, [0.17, LID + 0.055, 0.01], 0.014);
  k.label('warn', 'RF', '', 0.04, 0.04, [0.12, LID + 0.055, 0.0712], Z0);
}

/**
 * PVD lid: dark-space shield and bonded target (inside), insulator ring, water-cooled
 * magnetron housing with a bolted cover, rotating-magnet drive, DC feed box and cables.
 */
function buildMagnetron(k: Kit) {
  // inside the chamber (seen in the cut-away): grounded shield and backing plate
  k.cyl(KM.stainlessDark, 0.224, 0.07, [0, 1.282, 0], Z0, 48, { open: true });
  k.torus(KM.stainlessDark, 0.224, 0.004, [0, 1.247, 0], Z0, 48, { cast: false });
  k.cyl(KM.copper, 0.206, 0.014, [0, 1.322, 0], Z0, 48);
  // ceramic insulator and magnetron body on the lid
  k.cyl(KM.ptfe, 0.235, 0.016, [0, LID + 0.008, 0], Z0, 56);
  k.cyl(ALU, 0.215, 0.1, [0, LID + 0.066, 0], Z0, 56);
  for (const y of [LID + 0.03, LID + 0.1]) k.torus(KM.seam, 0.2155, 0.0014, [0, y, 0], Z0, 56, { cast: false });
  k.cyl(ALU, 0.226, 0.014, [0, LID + 0.123, 0], Z0, 56);
  k.cyl(KM.stainless, 0.17, 0.006, [0, LID + 0.133, 0], Z0, 48);
  boltCircle(k, 0.205, 16, LID + 0.132, 0.0058);
  // rotating-magnet drive: gearbox, motor and encoder
  k.rbox(KM.anodized, [0.12, 0.045, 0.1], 0.008, [0.05, LID + 0.158, 0.03]);
  k.cyl(KM.paintGraphite, 0.042, 0.11, [0.05, LID + 0.235, 0.03], Z0, 24);
  k.cyl(KM.anodizedDark, 0.044, 0.018, [0.05, LID + 0.299, 0.03], Z0, 24);
  k.cyl(KM.plastic, 0.012, 0.02, [0.09, LID + 0.27, 0.03], RX, 12, { cast: false });
  // DC power feed box with HV warning and the cathode cable
  k.rbox(KM.paint, [0.15, 0.13, 0.14], 0.012, [-0.09, LID + 0.2, -0.07]);
  k.rbox(KM.paintGraphite, [0.156, 0.012, 0.146], 0.004, [-0.09, LID + 0.27, -0.07]);
  k.label('warn', 'HIGH VOLTAGE', '', 0.05, 0.05, [-0.12, LID + 0.2, 0.0006], Z0);
  k.label('tag', 'DC CATHODE', '20 kW · ROTATING MAG', 0.13, 0.032, [0.05, LID + 0.085, 0.2162], Z0);
  k.cyl(KM.stainless, 0.024, 0.04, [-0.17, LID + 0.2, -0.07], RX, 16);
  rfCable(k, [-0.19, LID + 0.2, -0.07], 0.02, KM.rubber, -2.0);
  // cooling water in / out on the housing side
  for (const [i, m] of [[0, KM.paintBlue], [1, KM.paintRed]] as const) {
    const z = -0.05 + i * 0.1;
    const x = Math.sqrt(0.215 * 0.215 - z * z);
    k.cyl(KM.brass, 0.01, 0.04, [x + 0.015, LID + 0.07, z], RX, 10, { cast: false });
    rfCable(k, [x + 0.035, LID + 0.07, z], 0.011, m, (i - 0.5) * 0.46);
  }
}

function ChamberInternals({ mode, gap }: { mode: Mode; gap: boolean }) {
  const film = useRef<THREE.Mesh>(null);
  const filmMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8fb0a0', roughness: 0.1, metalness: 0.4, transparent: true, opacity: 0.9 }), []);
  const ald = mode === 'ald';
  const lidGas = useFolded((k) => buildLidGas(k, ald), [ald]);
  const magnetron = useFolded(buildMagnetron);
  useFrame(() => {
    const nm = engine.tele.value('film', 0);
    if (!film.current) return;
    film.current.visible = nm > 0.05;
    if (mode === 'pvd') {
      filmMat.color.set('#c08a5a');
      filmMat.metalness = 0.9;
    } else {
      // thin-film interference colour of the growing dielectric
      const [r, g, bl] = oxideColor(gap ? nm * 0.3 : mode === 'ald' ? nm * 8 : nm * 2);
      filmMat.color.setRGB(r, g, bl);
      filmMat.metalness = 0.4;
    }
  });
  return (
    <group>
      <Pedestal heated />
      <mesh ref={film} position={[0, CHAMBER.waferY + 0.0006, 0]} rotation={[-Math.PI / 2, 0, 0]} material={filmMat}>
        <circleGeometry args={[0.149, 48]} />
      </mesh>
      {mode !== 'pvd' && (
        <group>
          <Showerhead />
          <Clickable sel={{ kind: 'component', id: mode === 'ald' ? 'ald-chamber' : 'cvd-chamber', machine: 'dep-cluster', label: mode === 'ald' ? 'Fast-switching ALD valves / gas box' : 'Gas box & mass-flow controllers' }}>
            <Baked parts={lidGas} />
          </Clickable>
        </group>
      )}
      {mode === 'pvd' && (
        <Clickable sel={{ kind: 'component', id: 'pvd-chamber', machine: 'dep-cluster', label: 'Sputter target & magnetron' }}>
          <mesh position={[0, 1.3, 0]} geometry={GEO.cyl} scale={[0.2, 0.03, 0.2]} material={M.copper} />
          <Baked parts={magnetron} />
        </Clickable>
      )}
      <ChamberParticles mode={mode} />
    </group>
  );
}

/* --------------------------------------------------------- cross-section */

function SectionInset({ mode, gap }: { mode: Mode; gap: boolean }) {
  const key = gap ? 'gap' : mode;
  const sub = useMemo(() => substrateWithTrench(), []);
  const mpu = MPU[key];
  return (
    <Inset id="dep-section" position={[CHAMBER.x, 2.4, 1.55]} size={[1.3, 0.85]} mpu={mpu} schematic={false} title={gap ? 'TRENCH GAP FILL · CROSS-SECTION' : 'STEP COVERAGE · CROSS-SECTION'}>
      <group position={[0, 0.08, 0.12]} rotation={[0.2, -0.26, 0]}>
        <ProfileSlab points={sub} depth={0.22} m={siMat} />
        <LiveProfile
          depth={0.22}
          m={filmMats[key]}
          compute={() => {
            const nm = engine.tele.value('film', 0);
            if (nm < 0.05) return null;
            const t = (nm * 1e-9) / mpu;
            const c = coverage(key, t);
            return filmOverTrench(c.top, c.side, c.bot, TRENCH.depth, TRENCH.x0, TRENCH.x1, c.oh);
          }}
        />
      </group>
      <TechLabel position={[0.15, -0.3, 0.2]} title="FILM" min={2} value={() => `${engine.tele.value('film', 0).toFixed(1)} nm · ${gap ? 'CVD OXIDE' : mode.toUpperCase()} · SIMULATED`} />
    </Inset>
  );
}

/** Side-by-side final profiles of the three methods (info ≥ 3). */
function CompareStrip() {
  const info = useUI((s) => s.info);
  const sub = useMemo(() => substrateWithTrench(), []);
  if (info < 3) return null;
  return (
    <group position={[CHAMBER.x, 1.8, 1.55]}>
      {MODES.map((m, i) => {
        const c = coverage(m, 0.06);
        return (
          <group key={m} position={[(i - 1) * 0.48, 0, 0]} scale={0.36}>
            <mesh position={[0, 0, -0.03]}>
              <planeGeometry args={[1.25, 0.85]} />
              <meshBasicMaterial color="#0c110d" transparent opacity={0.84} />
            </mesh>
            <group rotation={[0.2, -0.2, 0]}>
              <ProfileSlab points={sub} depth={0.2} m={siMat} />
              <ProfileSlab points={filmOverTrench(c.top, c.side, c.bot, TRENCH.depth, TRENCH.x0, TRENCH.x1, c.oh)} depth={0.2} m={filmMats[m]} />
            </group>
            <TechLabel position={[-0.55, 0.42, 0]} title={`${m.toUpperCase()} · ${m === 'pvd' ? 'LINE-OF-SIGHT' : m === 'ald' ? 'CONFORMAL' : 'GOOD COVERAGE'}`} min={3} />
          </group>
        );
      })}
    </group>
  );
}

/** Neighbouring cluster tools along the bay (merged, background detail). */
function NeighbourTools() {
  const parts = useFolded((k) => {
    // each drops the closed chamber that would stand in the back wall / off the floor
    k.at([0, 0, -3.9], 0, () => buildClusterNeighbour(k, M.blueAccent, 'etcher', [1]));
    k.at([0, 0, 3.9], 0, () => buildClusterNeighbour(k, M.greenAccent, 'dep-cluster', [-1]));
  });
  return <Baked parts={parts} />;
}

export default function DepositionScene({ stage }: SceneProps) {
  const gap = stage.variant === 'gapfill';
  const depMode = useParam('depMode');
  const mode: Mode = gap ? 'cvd' : MODES[depMode] ?? 'cvd';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0;
  }, []);
  return (
    <>
      <Lighting env="cleanroom" shadowExtent={5} />
      <CleanroomBay width={12} depth={9} height={4.4} />
      <ClusterTool machine="dep-cluster" label="Deposition cluster tool" accent="green">
        <ChamberInternals mode={mode} gap={gap} />
        <SensorIndicator id="capacitance-manometer" channel="pressure" machine="dep-cluster" position={[0.42, 1.2, 0.25]} size={0.05} />
        <SensorIndicator id="thermocouple" channel="wT" machine="dep-cluster" position={[0.2, 0.86, 0.3]} size={0.05} />
        <SensorIndicator id="mfc" machine="dep-cluster" position={[-0.15, 1.62, 0.15]} size={0.05} />
      </ClusterTool>
      <SectionInset mode={mode} gap={gap} />
      {!gap && <CompareStrip />}
      <TechLabel
        position={[CHAMBER.x + 0.6, 1.5, 0]}
        title="ACTIVE CHAMBER"
        min={2}
        value={() => {
          const v = engine.player.view;
          if (v.phaseId !== 'deposit') return v.phase.label.toUpperCase();
          if (gap) return 'CVD OXIDE · BOTTOM-UP FILL';
          if (mode === 'ald') {
            const cyc = (v.phaseT * 40) % 1;
            return `ALD CYCLE ${Math.min(40, Math.floor(v.phaseT * 40) + 1)} · ${cyc < 0.25 ? 'PRECURSOR A' : cyc < 0.5 ? 'PURGE' : cyc < 0.75 ? 'PRECURSOR B' : 'PURGE'}`;
          }
          return mode === 'pvd' ? 'Ar⁺ SPUTTERING · LINE OF SIGHT' : 'PRECURSOR FLOW → SURFACE REACTION';
        }}
      />
      <Operator position={[-3.2, 0, 2.2]} rotation={Math.PI * 0.7} still />
      <NeighbourTools />
    </>
  );
}
