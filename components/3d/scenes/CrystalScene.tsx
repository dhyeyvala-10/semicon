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

  const shellMat = shell(M.steel, view);
  const shellDark = shell(M.steelDark, view);
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'cz-puller', label: 'Czochralski crystal puller' }}>
        {/* base & platform */}
        <B s={[2.4, 0.45, 2.4]} m={M.panelGrey} position={[0, 0.22, 0]} />
        <B s={[3.4, 0.05, 3.4]} m={M.frame} position={[0, 0.47, 0]} />
        {/* lower furnace chamber */}
        <Clickable sel={{ kind: 'component', id: 'chamber', machine: 'cz-puller', label: 'Water-cooled chamber' }}>
          <C r={CHAMBER.r} h={CHAMBER.y1 - CHAMBER.y0} m={shellMat} position={[0, (CHAMBER.y0 + CHAMBER.y1) / 2, 0]} open />
          <mesh position={[0, CHAMBER.y1, 0]} material={shellMat}>
            <sphereGeometry args={[CHAMBER.r, 40, 12, 0, Math.PI * 2, 0, Math.PI / 3.2]} />
          </mesh>
          <C r={CHAMBER.r + 0.04} h={0.08} m={shellDark} position={[0, CHAMBER.y0, 0]} />
          {[0.95, 1.5].map((y) => (
            <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]} material={shellDark}>
              <torusGeometry args={[CHAMBER.r + 0.02, 0.025, 8, 48]} />
            </mesh>
          ))}
          {/* viewports */}
          <C r={0.07} h={0.18} m={M.steelDark} position={[0.55, 2.25, 0.25]} rotation={[0, 0, -0.7]} />
          <C r={0.07} h={0.18} m={M.steelDark} position={[-0.5, 2.25, 0.3]} rotation={[0, 0, 0.7]} />
        </Clickable>
        {/* isolation valve + pull chamber */}
        <C r={0.27} h={0.25} m={shellDark} position={[0, 2.18, 0]} />
        <C r={0.34} h={0.06} m={M.steelDark} position={[0, 2.3, 0]} />
        <C r={PULL.r} h={PULL.y1 - PULL.y0} m={shell(M.steel, view === 'cutaway' || view === 'xray' ? view : 'normal')} position={[0, (PULL.y0 + PULL.y1) / 2, 0]} open />
        {[3.0, 3.8, 4.6].map((y) => (
          <C key={y} r={PULL.r + 0.03} h={0.05} m={shellDark} position={[0, y, 0]} />
        ))}
        {/* pull head */}
        <Clickable sel={{ kind: 'component', id: 'pull-head', machine: 'cz-puller', label: 'Pull & rotation head' }}>
          <C r={0.42} h={0.45} m={M.panel} position={[0, 5.25, 0]} />
          <B s={[0.5, 0.35, 0.35]} m={M.panelGrey} position={[0.45, 5.3, 0]} />
          <C r={0.12} h={0.3} m={M.steelDark} position={[0.45, 5.6, 0]} />
        </Clickable>
        {/* support column & lift */}
        <B s={[0.25, 5.4, 0.25]} m={M.frame} position={[-1.15, 2.7, -0.6]} />
        <B s={[1.2, 0.18, 0.18]} m={M.frame} position={[-0.6, 5.2, -0.4]} />
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
        {/* gas and cooling */}
        <Pipe points={[[0.2, 5.0, 0.2], [0.8, 5.0, 0.6], [1.4, 5.0, 0.6], [1.4, 0.4, 0.6]]} radius={0.04} m={M.steel} />
        <Pipe points={[[-0.6, 0.7, 0.55], [-1.4, 0.7, 0.9], [-1.4, 0.15, 0.9]]} radius={0.08} m={M.steelDark} />
        <B s={[0.9, 1.6, 0.7]} m={M.panel} position={[1.9, 0.8, -0.9]} />
        <Pipe points={[[1.6, 1.4, -0.6], [1.0, 1.4, -0.4], [0.78, 1.2, -0.2]]} radius={0.05} m={M.copper} />
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
      {[-5, 5].map((x) => (
        <group key={x} position={[x, 0, -4]}>
          <B s={[2.4, 0.45, 2.4]} m={M.panelGrey} position={[0, 0.22, 0]} />
          <C r={0.78} h={1.45} m={M.steel} position={[0, 1.33, 0]} />
          <C r={0.32} h={2.7} m={M.steel} position={[0, 3.6, 0]} />
          <C r={0.42} h={0.45} m={M.panel} position={[0, 5.2, 0]} />
          <SignalTower position={[1.2, 1.1, 0]} state={() => 'PROCESSING'} />
        </group>
      ))}
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
