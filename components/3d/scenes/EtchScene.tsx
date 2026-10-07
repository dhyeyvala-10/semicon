'use client';
/**
 * Etch (§28) and resist strip (§29).
 *   DRY: RF plasma; ions accelerate vertically across the sheath → anisotropic, straight walls.
 *   WET: liquid etchant attacks in every direction → isotropic, undercuts the mask.
 *   STRIP: downstream O₂ plasma radicals turn the resist into CO₂ + H₂O.
 * The cross-section is driven by the same etch model as the telemetry (depth / undercut).
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, CleanroomBay } from '../environments';
import { M } from '../materials';
import { B, C, GEO, Cable } from '../parts/primitives';
import { Clickable, SensorIndicator, TechLabel } from '../parts/interaction';
import { Inset, LiveProfile, ProfileSlab, rect } from '../parts/section';
import { ClusterTool, Pedestal, Showerhead, CHAMBER } from '../parts/cluster';
import { etchedFilm } from '../parts/profiles';
import { Screen, clear, plot, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { engine } from '@/simulation/engine';
import { inPhase, pdt } from '@/lib/anim';
import { cutPlane } from '@/lib/runtime';
import { useParam } from '@/hooks/useTicker';
import { rng } from '@/lib/math';
import { etchProfile, ETCH_TARGET_NM } from '@/simulation/models';

/* ---------------------------------------------------------------- materials */

const subMat = new THREE.MeshStandardMaterial({ color: '#7a828c', roughness: 0.45, metalness: 0.6 });
const filmMat = new THREE.MeshStandardMaterial({ color: '#a9c2a0', roughness: 0.35, metalness: 0.05 });
const resistMat = new THREE.MeshStandardMaterial({ color: '#b5612a', roughness: 0.4, metalness: 0, transparent: true, opacity: 0.92 });
const ionMat = new THREE.MeshBasicMaterial({ color: '#d6b8ff', toneMapped: false });
const radMat = new THREE.MeshStandardMaterial({ color: '#d98a6a', roughness: 0.5, emissive: new THREE.Color('#5a2a18'), emissiveIntensity: 0.4 });
const gasOutMat = new THREE.MeshStandardMaterial({ color: '#9aa39a', roughness: 0.6, transparent: true, opacity: 0.6 });
const liquidMat = new THREE.MeshStandardMaterial({ color: '#b9d4b0', roughness: 0.05, metalness: 0, transparent: true, opacity: 0.22, depthWrite: false });
const plasmaEtch = new THREE.MeshBasicMaterial({ color: '#b48cff', transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
const plasmaAsh = new THREE.MeshBasicMaterial({ color: '#ffb6d0', transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);

/* ---------------------------------------------------------------- inset geometry */

/** Inset units: film thickness 0.24 = 120 nm → 5e-7 m per unit. */
const H = 0.24;
const NM = H / ETCH_TARGET_NM;
const MPU = 120e-9 / H;
const O0 = -0.12;
const O1 = 0.12;
const RESIST_H = 0.16; // ≈ 80 nm

function depthNow(wet: boolean) {
  const v = engine.player.view;
  const p = etchProfile(v.phaseId, v.phaseT, wet, engine.failSeverity('etch-variation'));
  return { depth: p.depth * NM, undercut: p.undercut * NM };
}

/** Ions (straight down) and radicals (random walk) inside the cross-section. */
function InsetParticles({ wet, strip }: { wet: boolean; strip: boolean }) {
  const N = 60;
  const ions = useRef<THREE.InstancedMesh>(null);
  const rads = useRef<THREE.InstancedMesh>(null);
  const out = useRef<THREE.InstancedMesh>(null);
  const seeds = useMemo(() => {
    const r = rng(9);
    return Array.from({ length: N }, () => ({ x: r() * 1.0 - 0.5, o: r(), s: 0.7 + r() * 0.6, z: r() * 0.2 - 0.1, w: r() }));
  }, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const t = useRef(0);
  useFrame((_, dt) => {
    if (!ions.current || !rads.current || !out.current) return;
    t.current += pdt(dt);
    const active = strip ? inPhase('ash') : !wet && (inPhase('main') || inPhase('endpoint'));
    const resistTop = H + (strip ? (engine.tele.value('resist', 0) / 80) * RESIST_H : RESIST_H);
    const { depth } = strip ? { depth: H } : depthNow(wet);
    for (let i = 0; i < N; i++) {
      const s = seeds[i];
      ions.current.setMatrixAt(i, HIDE);
      rads.current.setMatrixAt(i, HIDE);
      out.current.setMatrixAt(i, HIDE);
      if (!active) continue;
      const u = (t.current * 0.8 * s.s + s.o) % 1;
      if (!strip && i < N / 2) {
        // ion: vertical drop, stops at the surface it meets
        const inOpening = s.x > O0 && s.x < O1;
        const floor = inOpening ? H - depth : resistTop;
        const y = 0.62 - u * (0.62 - floor);
        o.position.set(s.x, y, s.z);
        o.scale.set(0.006, 0.05, 0.006);
        o.updateMatrix();
        ions.current.setMatrixAt(i, o.matrix);
      } else if (strip) {
        // O radicals drift down to the resist; CO₂ / H₂O leave upward
        if (s.w < 0.6) {
          o.position.set(s.x + 0.03 * Math.sin(t.current * 3 + i), 0.62 - u * (0.62 - resistTop), s.z);
          o.scale.setScalar(0.01);
          o.updateMatrix();
          rads.current.setMatrixAt(i, o.matrix);
        } else {
          o.position.set(s.x + 0.04 * Math.sin(t.current * 2 + i), resistTop + u * 0.3, s.z);
          o.scale.setScalar(0.012);
          o.updateMatrix();
          out.current.setMatrixAt(i, o.matrix);
        }
      } else {
        // radical: wandering neutral
        const x = s.x + 0.05 * Math.sin(t.current * 2.3 + i * 1.7);
        if (s.w > 0.5) continue;
        const y = resistTop + 0.04 + ((u + 0.5 * Math.abs(Math.sin(i))) % 1) * 0.2;
        o.position.set(x, y, s.z);
        o.scale.setScalar(0.008);
        o.updateMatrix();
        rads.current.setMatrixAt(i, o.matrix);
      }
    }
    ions.current.instanceMatrix.needsUpdate = true;
    rads.current.instanceMatrix.needsUpdate = true;
    out.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <>
      <instancedMesh ref={ions} args={[GEO.box, ionMat, N]} frustumCulled={false} />
      <instancedMesh ref={rads} args={[GEO.sphereLow, radMat, N]} frustumCulled={false} />
      <instancedMesh ref={out} args={[GEO.sphereLow, gasOutMat, N]} frustumCulled={false} />
    </>
  );
}

function SectionInset({ wet, strip }: { wet: boolean; strip: boolean }) {
  const sub = useMemo(() => rect(-0.55, -0.3, 0.55, 0), []);
  const liquid = useRef<THREE.Mesh>(null);
  useFrame(() => {
    if (liquid.current) liquid.current.visible = (wet && (inPhase('main') || inPhase('endpoint'))) || (strip && inPhase('wet'));
  });
  return (
    <Inset id="etch-section" position={[CHAMBER.x, 2.4, 1.55]} size={[1.3, 0.85]} mpu={MPU} schematic={false} title={strip ? 'RESIST STRIP · CROSS-SECTION' : wet ? 'WET (ISOTROPIC) ETCH · CROSS-SECTION' : 'DRY (ANISOTROPIC) ETCH · CROSS-SECTION'}>
      <group position={[0, -0.12, 0.12]} rotation={[0.2, -0.26, 0]}>
        <ProfileSlab points={sub} depth={0.22} m={subMat} />
        <LiveProfile
          depth={0.22}
          m={filmMat}
          compute={() => {
            if (strip) return etchedFilm(H, H * 0.04, H);
            const { depth, undercut } = depthNow(wet);
            return etchedFilm(depth, undercut, H, 0, O0, O1);
          }}
        />
        {/* resist mask (left + right of the opening) */}
        <LiveProfile
          depth={0.22}
          m={resistMat}
          compute={() => {
            const th = strip ? (engine.tele.value('resist', 0) / 80) * RESIST_H : RESIST_H;
            if (th < 0.002) return null;
            return [
              [-0.55, H],
              [O0, H],
              [O0, H + th],
              [-0.55, H + th],
            ];
          }}
        />
        <LiveProfile
          depth={0.22}
          m={resistMat}
          compute={() => {
            const th = strip ? (engine.tele.value('resist', 0) / 80) * RESIST_H : RESIST_H;
            if (th < 0.002) return null;
            return [
              [O1, H],
              [0.55, H],
              [0.55, H + th],
              [O1, H + th],
            ];
          }}
        />
        <mesh ref={liquid} position={[0, H + 0.12, 0]} material={liquidMat}>
          <boxGeometry args={[1.1, 0.5, 0.22]} />
        </mesh>
        <InsetParticles wet={wet} strip={strip} />
      </group>
      <TechLabel
        position={[0.12, -0.32, 0.2]}
        title={strip ? 'RESIST' : 'ETCH DEPTH'}
        min={2}
        value={() => {
          if (strip) return `${engine.tele.value('resist', 0).toFixed(0)} nm remaining · SIMULATED`;
          const v = engine.player.view;
          const p = etchProfile(v.phaseId, v.phaseT, wet);
          return `${p.depth.toFixed(0)} / ${ETCH_TARGET_NM} nm · undercut ${p.undercut.toFixed(0)} nm · SIMULATED`;
        }}
      />
      <TechLabel position={[-0.6, 0.36, 0.2]} title="RESIST MASK" min={3} />
      <TechLabel position={[-0.6, 0.06, 0.2]} title={strip ? 'PATTERNED FILM' : 'FILM BEING ETCHED'} min={3} />
    </Inset>
  );
}

/* ---------------------------------------------------------------- chamber */

function ChamberIons({ active }: { active: () => boolean }) {
  const N = 70;
  const ref = useRef<THREE.InstancedMesh>(null);
  const seeds = useMemo(() => {
    const r = rng(77);
    return Array.from({ length: N }, () => ({ r: Math.sqrt(r()) * 0.15, a: r() * Math.PI * 2, o: r(), s: 0.8 + r() * 0.5 }));
  }, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const t = useRef(0);
  useFrame((_, dt) => {
    if (!ref.current) return;
    t.current += pdt(dt);
    const on = active();
    for (let i = 0; i < N; i++) {
      if (!on) {
        ref.current.setMatrixAt(i, HIDE);
        continue;
      }
      const s = seeds[i];
      const u = (t.current * 1.4 * s.s + s.o) % 1;
      o.position.set(Math.cos(s.a) * s.r, 1.22 - u * (1.22 - CHAMBER.waferY - 0.01), Math.sin(s.a) * s.r);
      o.scale.set(0.0025, 0.03, 0.0025);
      o.updateMatrix();
      ref.current.setMatrixAt(i, o.matrix);
    }
    ref.current.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={ref} args={[GEO.box, ionMat, N]} frustumCulled={false} />;
}

function EtchInternals({ wet }: { wet: boolean }) {
  const glow = useRef<THREE.Mesh>(null);
  const resist = useRef<THREE.Mesh>(null);
  const liquid = useRef<THREE.Mesh>(null);
  const nozzle = useRef<THREE.Group>(null);
  useFrame(() => {
    const rf = engine.tele.value('rf', 0) / 900;
    if (glow.current) {
      glow.current.visible = !wet && rf > 0.02;
      plasmaEtch.opacity = 0.12 + 0.22 * rf * (0.92 + 0.08 * Math.sin(engine.time * 40));
    }
    const w = wet && (inPhase('main') || inPhase('endpoint') || inPhase('strike'));
    if (liquid.current) liquid.current.visible = w;
    if (nozzle.current) nozzle.current.rotation.y = w ? 0 : 0.9;
    if (resist.current) resist.current.visible = !inPhase('unload') || engine.player.view.phaseT < 0.98;
  });
  return (
    <group>
      <Pedestal esc={!wet} machine="etcher" />
      <mesh ref={resist} position={[0, CHAMBER.waferY + 0.0012, 0]} rotation={[-Math.PI / 2, 0, 0]} material={resistMat}>
        <circleGeometry args={[0.148, 48]} />
      </mesh>
      {!wet && (
        <>
          <Showerhead machine="etcher" y={1.27} />
          <mesh ref={glow} position={[0, (CHAMBER.waferY + 1.25) / 2, 0]} material={plasmaEtch}>
            <cylinderGeometry args={[0.18, 0.2, 1.25 - CHAMBER.waferY - 0.02, 40, 1, true]} />
          </mesh>
          <ChamberIons active={() => inPhase('main') || inPhase('endpoint')} />
          {/* RF generator + match, OES viewport */}
          <Clickable sel={{ kind: 'component', id: 'rf', machine: 'etcher', label: 'RF generators & match' }}>
            <B s={[0.32, 0.26, 0.28]} m={M.panelGrey} position={[0.62, 1.58, -0.18]} />
            <B s={[0.33, 0.04, 0.29]} m={M.greenAccent} position={[0.62, 1.73, -0.18]} />
            <Cable a={[0.5, 1.5, -0.18]} b={[0.05, 1.42, 0]} sag={0.05} radius={0.012} m={M.black} />
          </Clickable>
          <Clickable sel={{ kind: 'component', id: 'oes-window', machine: 'etcher', label: 'OES viewport' }}>
            <mesh position={[0.5, 1.15, 0.12]} rotation={[0, 0, Math.PI / 2]} material={M.steelDark}>
              <cylinderGeometry args={[0.04, 0.04, 0.06, 20]} />
            </mesh>
            <Cable a={[0.53, 1.15, 0.12]} b={[0.85, 0.9, 0.5]} sag={0.1} radius={0.006} m={M.yellow} />
          </Clickable>
        </>
      )}
      {wet && (
        <>
          <mesh ref={liquid} position={[0, CHAMBER.waferY + 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]} material={liquidMat}>
            <circleGeometry args={[0.15, 48]} />
          </mesh>
          <group ref={nozzle} position={[0.3, 1.18, 0]}>
            <B s={[0.3, 0.02, 0.02]} m={M.steel} position={[-0.15, 0, 0]} />
            <C r={0.008} h={0.06} m={M.plastic} position={[-0.3, -0.03, 0]} />
          </group>
        </>
      )}
    </group>
  );
}

function AshInternals() {
  const glow = useRef<THREE.Mesh>(null);
  const resist = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const ash = inPhase('ash');
    if (glow.current) glow.current.visible = ash;
    plasmaAsh.opacity = 0.3 + 0.08 * Math.sin(engine.time * 25);
    if (resist.current) {
      const r = engine.tele.value('resist', 0) / 80;
      resist.current.visible = r > 0.01;
      (resist.current.material as THREE.MeshStandardMaterial).opacity = 0.2 + 0.7 * r;
    }
  });
  const rm = useMemo(() => resistMat.clone(), []);
  return (
    <group>
      <Pedestal heated machine="asher" id="heater" />
      <mesh ref={resist} position={[0, CHAMBER.waferY + 0.0012, 0]} rotation={[-Math.PI / 2, 0, 0]} material={rm}>
        <circleGeometry args={[0.148, 48]} />
      </mesh>
      <Showerhead machine="asher" y={1.27} />
      {/* downstream plasma source: a quartz tube above the chamber, radicals flow down */}
      <Clickable sel={{ kind: 'component', id: 'plasma-source', machine: 'asher', label: 'Downstream plasma source' }}>
        <mesh position={[0, 1.62, 0]} material={M.quartz}>
          <cylinderGeometry args={[0.07, 0.07, 0.42, 24, 1, true]} />
        </mesh>
        <mesh ref={glow} position={[0, 1.62, 0]} material={plasmaAsh}>
          <cylinderGeometry args={[0.06, 0.06, 0.38, 24]} />
        </mesh>
        {[1.5, 1.62, 1.74].map((y) => (
          <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]} material={M.copper}>
            <torusGeometry args={[0.085, 0.008, 8, 32]} />
          </mesh>
        ))}
        <B s={[0.26, 0.2, 0.22]} m={M.panelGrey} position={[0.3, 1.62, 0]} />
      </Clickable>
    </group>
  );
}

/* ---------------------------------------------------------------- endpoint monitor */

function EndpointMonitor({ strip }: { strip: boolean }) {
  const ch = strip ? 'co' : 'oes';
  return (
    <group position={[2.35, 0, -0.55]} rotation={[0, -0.35, 0]}>
      <C r={0.025} h={1.3} m={M.steelDark} position={[0, 0.65, 0]} />
      <Screen
        size={[0.62, 0.4]}
        position={[0, 1.45, 0.03]}
        hz={4}
        draw={(g, w, h) => {
          clear(g, w, h, strip ? 'CO EMISSION · ENDPOINT · SIMULATED' : 'OES ENDPOINT · SIMULATED');
          const c = engine.tele.get(ch);
          const data = c ? c.series().slice(-180) : [];
          plot(g, data, w * 0.05, h * 0.38, w * 0.9, h * 0.5, 0, 1.2, SCR.data);
          const v = engine.tele.value(ch, 0);
          bigNumber(g, strip ? 'CO LINE' : 'EMISSION', v.toFixed(2), 'a.u.', w * 0.05, h * 0.2, h * 0.1, v < 0.5 && v > 0.01 ? SCR.warn : SCR.text);
          if (v < 0.5 && v > 0.01) {
            g.fillStyle = SCR.warn;
            g.font = `${Math.round(h * 0.06)}px monospace`;
            g.fillText('ENDPOINT DETECTED', w * 0.55, h * 0.28);
          }
        }}
      />
    </group>
  );
}

/* ---------------------------------------------------------------- scene */

export default function EtchScene({ stage }: SceneProps) {
  const strip = stage.variant === 'strip';
  const etchMode = useParam('etchMode');
  const wet = !strip && etchMode === 1;
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0;
  }, []);
  const machine = strip ? 'asher' : 'etcher';
  return (
    <>
      <Lighting env="cleanroom" shadowExtent={5} />
      <CleanroomBay width={12} depth={9} height={4.4} />
      <ClusterTool machine={machine} label={strip ? 'Plasma asher (resist strip)' : 'Plasma etch cluster'} accent={strip ? 'orange' : 'green'}>
        {strip ? <AshInternals /> : <EtchInternals wet={wet} />}
        <SensorIndicator id="capacitance-manometer" channel="pressure" machine={machine} position={[0.42, 1.2, 0.25]} size={0.05} />
        {!strip && <SensorIndicator id="oes" channel="oes" machine="etcher" position={[0.5, 1.26, 0.12]} size={0.045} />}
        {strip && <SensorIndicator id="thermocouple" channel="platen" machine="asher" position={[0.2, 0.86, 0.3]} size={0.05} />}
      </ClusterTool>
      <SectionInset wet={wet} strip={strip} />
      <EndpointMonitor strip={strip} />
      <TechLabel
        position={[CHAMBER.x + 0.6, 1.5, 0]}
        title={strip ? 'ASHER CHAMBER' : wet ? 'WET ETCH' : 'PLASMA CHAMBER'}
        min={2}
        lines={wet ? ['SIMPLIFIED: real wet etch runs in a wet bench or single-wafer spin processor'] : undefined}
        value={() => {
          const v = engine.player.view;
          if (strip) return v.phaseId === 'ash' ? 'O₂ PLASMA · RESIST → CO₂ + H₂O' : v.phase.label.toUpperCase();
          if (wet) return v.phaseId === 'main' ? 'ISOTROPIC · ATTACKS IN ALL DIRECTIONS' : v.phase.label.toUpperCase();
          return v.phaseId === 'main' ? `IONS ⟂ WAFER · ${engine.tele.value('rf', 0).toFixed(0)} W RF` : v.phase.label.toUpperCase();
        }}
      />
      <Operator position={[-3.2, 0, 2.2]} rotation={Math.PI * 0.7} still />
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
