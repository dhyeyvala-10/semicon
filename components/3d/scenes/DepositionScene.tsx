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
import { B, C, GEO } from '../parts/primitives';
import { Clickable, SensorIndicator, TechLabel } from '../parts/interaction';
import { Inset, LiveProfile, ProfileSlab } from '../parts/section';
import { ClusterTool, Pedestal, Showerhead, CHAMBER } from '../parts/cluster';
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

function ChamberInternals({ mode, gap }: { mode: Mode; gap: boolean }) {
  const film = useRef<THREE.Mesh>(null);
  const filmMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8fb0a0', roughness: 0.1, metalness: 0.4, transparent: true, opacity: 0.9 }), []);
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
            <B s={[0.3, 0.22, 0.3]} m={M.panelWarm} position={[0, 1.55, 0]} />
            {[-0.08, 0.08].map((z) => (
              <C key={z} r={0.03} h={0.1} m={M.steel} position={[0.1, 1.71, z]} />
            ))}
          </Clickable>
        </group>
      )}
      {mode === 'pvd' && (
        <Clickable sel={{ kind: 'component', id: 'pvd-chamber', machine: 'dep-cluster', label: 'Sputter target & magnetron' }}>
          <C r={0.2} h={0.03} m={M.copper} position={[0, 1.3, 0]} />
          <C r={0.21} h={0.12} m={M.panelGrey} position={[0, 1.4, 0]} />
          <B s={[0.25, 0.18, 0.25]} m={M.panelDark} position={[0, 1.6, 0]} />
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

function NeighbourTools() {
  return (
    <>
      {[-3.6, 3.6].map((z) => (
        <group key={z} position={[0, 0, z]}>
          <B s={[3.2, 0.7, 2.2]} m={M.panelDark} position={[0, 0.35, 0]} />
          <C r={0.7} h={0.5} m={M.steel} position={[0, 0.98, 0]} />
          <B s={[0.8, 2.0, 1.8]} m={M.panel} position={[-2.1, 1.0, 0]} />
        </group>
      ))}
    </>
  );
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
