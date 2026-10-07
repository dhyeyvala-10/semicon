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
import { M, shell, effectiveView } from '../materials';
import { B, C, GEO, Tube } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Inset, ProfileSlab, rect } from '../parts/section';
import { waferGeometry } from '../parts/wafer';
import { Screen, clear, plot, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
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
      const a = new THREE.Vector3(SCAN_X, Y, 0);
      const b = new THREE.Vector3(LENS_X, Y, zLens);
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

/* ---------------------------------------------------------------- hardware */

function Implanter() {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  // beamline housings are opaque vacuum vessels: the machine view looks inside them too
  const view = effectiveView(viewRaw, cam === 'machine' ? 'internal' : cam);
  const sh = (m: THREE.Material) => shell(m, view);
  const arcPts = useMemo(() => Array.from({ length: 25 }, (_, i) => arcPoint(i / 24, RM).toArray() as V3), []);
  const glow = useRef<THREE.Mesh>(null);
  useFrame(() => {
    if (glow.current) glow.current.visible = engine.tele.value('current', 0) > 0.05 || inPhase('pump');
  });
  return (
    <Clickable sel={{ kind: 'machine', id: 'implanter', label: 'Ion implanter' }}>
      {/* base / terminal enclosure floor */}
      <B s={[5.4, 0.7, 1.6]} m={M.panelDark} position={[1.0, 0.35, 0]} />
      <B s={[1.8, 0.7, 2.2]} m={M.panelDark} position={[-0.9, 0.35, -1.3]} />
      {/* ion source */}
      <Clickable sel={{ kind: 'component', id: 'source', machine: 'implanter', label: 'Ion source' }}>
        <B s={[0.5, 0.5, 0.5]} m={sh(M.steel)} position={[MC.x - RM, Y, SRC_Z - 0.2]} />
        <mesh ref={glow} position={[MC.x - RM, Y, SRC_Z - 0.2]} material={plasmaMat}>
          <sphereGeometry args={[0.08, 16, 12]} />
        </mesh>
        <B s={[0.7, 0.5, 0.6]} m={M.panelWarm} position={[MC.x - RM - 0.6, 1.0, SRC_Z - 0.2]} />
      </Clickable>
      <Clickable sel={{ kind: 'component', id: 'extraction', machine: 'implanter', label: 'Extraction electrodes' }}>
        {[0, 0.07, 0.14].map((d) => (
          <B key={d} s={[0.3, 0.3, 0.015]} m={M.graphite} position={[MC.x - RM, Y, SRC_Z + 0.08 + d]} />
        ))}
      </Clickable>
      {/* straight flight tube into the magnet */}
      <mesh position={[MC.x - RM, Y, (SRC_Z + 0.3 + MC.z) / 2]} rotation={[Math.PI / 2, 0, 0]} material={sh(M.steel)}>
        <cylinderGeometry args={[0.07, 0.07, MC.z - SRC_Z - 0.3, 24, 1, true]} />
      </mesh>
      {/* analyzer magnet: two pole pieces around the curved flight tube */}
      <Clickable sel={{ kind: 'component', id: 'analyzer', machine: 'implanter', label: 'Analyzer magnet' }}>
        {[Y - 0.12, Y + 0.12].map((y) => (
          <mesh key={y} position={[MC.x, y, MC.z]} material={sh(M.blueAccent)}>
            <cylinderGeometry args={[RM + 0.32, RM + 0.32, 0.12, 40, 1, false, (3 * Math.PI) / 2, Math.PI / 2]} />
          </mesh>
        ))}
        <mesh position={[MC.x, Y, MC.z]} material={M.copper}>
          <cylinderGeometry args={[RM - 0.28, RM - 0.28, 0.36, 32, 1, false, (3 * Math.PI) / 2, Math.PI / 2]} />
        </mesh>
        <Tube points={arcPts} radius={0.07} m={sh(M.steel)} segments={60} radial={16} />
      </Clickable>
      {/* resolving slit */}
      <Clickable sel={{ kind: 'component', id: 'analyzer', machine: 'implanter', label: 'Resolving aperture (mass slit)' }}>
        <B s={[0.02, 0.32, 0.12]} m={M.graphite} position={[-0.3, Y, -0.1]} />
        <B s={[0.02, 0.32, 0.12]} m={M.graphite} position={[-0.3, Y, 0.1]} />
      </Clickable>
      {/* acceleration column */}
      <Clickable sel={{ kind: 'component', id: 'accelerator', machine: 'implanter', label: 'Acceleration column' }}>
        {Array.from({ length: 7 }, (_, i) => (
          <mesh key={i} position={[0.0 + i * 0.12, Y, 0]} rotation={[0, 0, Math.PI / 2]} material={i % 2 ? M.ceramic : M.steel}>
            <cylinderGeometry args={[0.2, 0.2, 0.06, 32, 1, true]} />
          </mesh>
        ))}
        <B s={[1.0, 0.04, 0.5]} m={M.panelGrey} position={[0.36, Y - 0.32, 0]} />
      </Clickable>
      {/* scanner + parallelizing lens */}
      <Clickable sel={{ kind: 'component', id: 'scanner', machine: 'implanter', label: 'Beam scanner' }}>
        <B s={[0.25, 0.04, 0.3]} m={M.copper} position={[SCAN_X, Y + 0.08, 0]} />
        <B s={[0.25, 0.04, 0.3]} m={M.copper} position={[SCAN_X, Y - 0.08, 0]} />
        <B s={[0.3, 0.5, 0.6]} m={sh(M.steel)} position={[SCAN_X, Y, 0]} />
        <B s={[0.3, 0.6, 0.8]} m={sh(M.blueAccent)} position={[LENS_X, Y, 0]} />
      </Clickable>
      <mesh position={[(SCAN_X + LENS_X) / 2, Y, 0]} material={sh(M.steel)}>
        <boxGeometry args={[LENS_X - SCAN_X, 0.18, 0.5]} />
      </mesh>
      <mesh position={[(LENS_X + WX - 0.4) / 2, Y, 0]} material={sh(M.steel)}>
        <boxGeometry args={[WX - 0.4 - LENS_X, 0.2, 0.5]} />
      </mesh>
      {/* end station */}
      <Clickable sel={{ kind: 'component', id: 'end-station', machine: 'implanter', label: 'End station' }}>
        <B s={[0.9, 1.1, 1.2]} m={sh(M.panel)} position={[WX, 1.25, 0]} />
        <B s={[0.9, 0.05, 1.2]} m={sh(M.greenAccent)} position={[WX, 1.82, 0]} />
        <B s={[0.5, 0.4, 0.45]} m={sh(M.steel)} position={[WX - 0.1, 1.0, 0.85]} />
      </Clickable>
      <SignalTower position={[WX + 0.35, 1.95, 0.5]} />
    </Clickable>
  );
}

function EndStationWafer() {
  const group = useRef<THREE.Group>(null);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.1, metalness: 0.9 }), []);
  const resist = useMemo(() => new THREE.MeshPhysicalMaterial({ color: '#b5612a', roughness: 0.25, transparent: true, opacity: 0.85 }), []);
  useFrame(() => {
    // load: from the load lock (+z), tilt up to vertical; unload: reverse
    const inP = smooth(pp('load'));
    const outP = smooth(pp('unload'));
    const k = inP * (1 - outP);
    const sc = scan();
    const p = new THREE.Vector3(lerp(WX - 0.1, WX, k), lerp(1.0, Y, k) + sc.y, lerp(0.85, 0, k));
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
      <C r={0.16} h={0.03} m={M.steelDark} position={[0, -0.018, 0]} />
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
      <C r={0.025} h={1.3} m={M.steelDark} position={[0, 0.65, 0]} />
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
