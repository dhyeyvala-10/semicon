'use client';
/**
 * Wafer finishing (§15, §16): edge profiling → lapping → chemical etching → polishing → cleaning.
 * The followed wafer's surface visibly changes from rough to mirror; each station has a
 * magnified cross-section whose roughness / damage / particles come from the same
 * simulated values shown in the telemetry.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, CleanroomBay } from '../environments';
import { M } from '../materials';
import { B, C, GEO, Pipe } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Inset, ProfileSlab } from '../parts/section';
import { waferGeometry, WAFER_R } from '../parts/wafer';
import { engine } from '@/simulation/engine';
import { pp, pdt, inPhase } from '@/lib/anim';
import { track } from '@/lib/runtime';
import { rng, smooth, clamp, lerp } from '@/lib/math';

const X = { edge: -12, lap: -4, etch: 4, polish: 12, clean: 20 };
const TABLE_Y = 1.0;

/** Wafer material whose roughness/metalness animate with the finishing state. */
const followMat = new THREE.MeshStandardMaterial({ color: '#7a8088', roughness: 0.8, metalness: 0.45 });
function setSurface(rough: number) {
  // rough = 1 (as-cut) … 0 (mirror)
  followMat.roughness = lerp(0.05, 0.82, rough);
  followMat.metalness = lerp(0.93, 0.45, rough);
  followMat.color.setRGB(lerp(0.56, 0.47, rough), lerp(0.59, 0.5, rough), lerp(0.64, 0.53, rough));
}

const slurryMat = new THREE.MeshBasicMaterial({ color: '#d8d4c4', transparent: true, opacity: 0.8 });
const liquid = (color: string, opacity = 0.55) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.05, transparent: true, opacity, depthWrite: false });

/* --------------------------------------------------------- surface inset */

function RoughnessInset({ id, position, title, mpu, amp, layers }: { id: string; position: [number, number, number]; title: string; mpu: number; amp: () => number; layers?: () => { damage?: number } }) {
  const N = 60;
  const ref = useRef<{ key: string }>({ key: '' });
  const slabRef = useRef<THREE.Mesh>(null);
  const damageRef = useRef<THREE.Mesh>(null);
  const r = useMemo(() => rng(id.length * 31), [id]);
  const phases = useMemo(() => Array.from({ length: N + 1 }, () => r()), [r]);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8a9098', roughness: 0.4, metalness: 0.6 }), []);
  const dmgMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#5a4f48', roughness: 0.9 }), []);
  useFrame(() => {
    const a = amp();
    const key = a.toFixed(3);
    if (key !== ref.current.key && slabRef.current) {
      ref.current.key = key;
      const pts: [number, number][] = [[-0.55, -0.32]];
      for (let i = 0; i <= N; i++) {
        const x = -0.55 + (1.1 * i) / N;
        const y = 0.12 + a * (0.6 * Math.sin(i * 1.7 + phases[i] * 3) * 0.5 + (phases[i] - 0.5) * 0.9);
        pts.push([x, Math.min(0.3, y)]);
      }
      pts.push([0.55, -0.32]);
      const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
      const g = new THREE.ExtrudeGeometry(shape, { depth: 0.18, bevelEnabled: false });
      g.translate(0, 0, -0.09);
      slabRef.current.geometry.dispose();
      slabRef.current.geometry = g;
    }
    if (damageRef.current && layers) {
      const d = layers().damage ?? 0;
      damageRef.current.visible = d > 0.01;
      damageRef.current.scale.set(1.1, Math.max(0.001, d * 0.25), 0.185);
      damageRef.current.position.y = 0.12 - (d * 0.25) / 2 - 0.02;
    }
  });
  return (
    <Inset id={id} position={position} size={[1.3, 0.85]} mpu={mpu} title={title}>
      <group position={[0, 0, 0.15]} rotation={[0.25, 0, 0]}>
        <mesh ref={slabRef} material={mat} />
        <mesh ref={damageRef} geometry={GEO.box} material={dmgMat} />
      </group>
    </Inset>
  );
}

/* --------------------------------------------------------- 1 · edge */

function EdgeStation() {
  const cx = X.edge;
  const spin = useRef<THREE.Group>(null);
  const wheel = useRef<THREE.Group>(null);
  const profRef = useRef<{ k: number }>({ k: -1 });
  const prof = useRef<THREE.Mesh>(null);
  const profMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8a9098', roughness: 0.4, metalness: 0.7 }), []);
  useFrame((_, dt) => {
    const active = engine.stage.id === 'edge-profiling';
    const g = active ? pp('grind') : engine.stage.id === 'edge-profiling' ? 0 : 1;
    if (spin.current) spin.current.rotation.y += pdt(dt) * (active && inPhase('grind') ? 3 : 0);
    if (wheel.current) {
      wheel.current.rotation.y -= pdt(dt) * (active && inPhase('grind') ? 18 : 0);
      wheel.current.position.x = cx + WAFER_R + 0.11 + (active && inPhase('grind') ? 0 : 0.08);
    }
    // edge cross-section: square corner → rounded bullet profile
    const k = Math.round(g * 20) / 20;
    if (prof.current && k !== profRef.current.k) {
      profRef.current.k = k;
      const pts: [number, number][] = [[-0.5, -0.12]];
      const R = 0.12 * k;
      for (let i = 0; i <= 12; i++) {
        const a = -Math.PI / 2 + (i / 12) * Math.PI;
        const x = 0.35 - R + (R > 0 ? Math.cos(a) * R : 0);
        const y = R > 0 ? Math.sin(a) * 0.12 : i < 6 ? -0.12 : 0.12;
        pts.push([R > 0 ? x : 0.35, y]);
      }
      pts.push([-0.5, 0.12]);
      const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.25, bevelEnabled: false });
      geo.translate(0, 0, -0.125);
      prof.current.geometry.dispose();
      prof.current.geometry = geo;
    }
    if (active) track('focus', cx, TABLE_Y + 0.05, 0);
  });
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'edge-grinder', label: 'Edge profiler' }}>
        <B s={[1.4, 1.0, 1.0]} m={M.panel} position={[cx, 0.5, -0.1]} />
        <Clickable sel={{ kind: 'component', id: 'chuck', machine: 'edge-grinder', label: 'Vacuum chuck' }}>
          <C r={0.08} h={0.12} m={M.steelDark} position={[cx, TABLE_Y - 0.04, 0]} />
        </Clickable>
        <group ref={spin} position={[cx, TABLE_Y + 0.02, 0]}>
          <mesh geometry={waferGeometry()} material={followMat} />
        </group>
        <group ref={wheel} position={[cx + WAFER_R + 0.11, TABLE_Y + 0.02, 0]}>
          <Clickable sel={{ kind: 'component', id: 'profile-wheel', machine: 'edge-grinder', label: 'Profiled diamond wheel' }}>
            <C r={0.1} h={0.04} m={M.graphite} />
            <C r={0.02} h={0.3} m={M.steel} position={[0, 0.15, 0]} />
          </Clickable>
        </group>
        <B s={[1.4, 0.8, 0.05]} m={M.glassDark} position={[cx, 1.4, -0.58]} />
        <SignalTower position={[cx + 0.6, 1.0, -0.5]} />
      </Clickable>
      <Inset id="edge" position={[cx - 0.9, 2.1, 0.9]} size={[1.3, 0.85]} mpu={1.2e-3 / 1.3} title="WAFER EDGE PROFILE">
        <group position={[0, 0, 0.15]}>
          <mesh ref={prof} material={profMat} />
        </group>
      </Inset>
      <TechLabel position={[cx, TABLE_Y + 0.35, 0.25]} title="EDGE PROFILER" lines={['sharp edge → rounded bevel']} />
    </group>
  );
}

/* --------------------------------------------------------- 2/4 · double-side machines */

function DoubleSide({ cx, kind }: { cx: number; kind: 'lap' | 'polish' }) {
  const lower = useRef<THREE.Group>(null);
  const upper = useRef<THREE.Group>(null);
  const carriers = useRef<THREE.Group>(null);
  const drops = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const stageId = kind === 'lap' ? 'lapping' : 'polishing';
  const plateMat = kind === 'lap' ? M.graphite : new THREE.MeshStandardMaterial({ color: '#d9cfb8', roughness: 0.9 });
  const ang = useRef(0);
  useFrame((_, dt) => {
    const active = engine.stage.id === stageId;
    const working = active && (inPhase('lap') || inPhase('stock') || inPhase('final'));
    ang.current += pdt(dt) * (working ? 1 : 0);
    if (lower.current) lower.current.rotation.y = ang.current * 1.4;
    if (upper.current) {
      upper.current.rotation.y = -ang.current * 1.1;
      const down = working || (active && !inPhase('load') && !inPhase('measure') && !inPhase('unload')) ? 1 : 0;
      upper.current.position.y = TABLE_Y + 0.07 + (1 - down) * 0.45;
    }
    if (carriers.current) {
      carriers.current.rotation.y = ang.current * 0.5;
      carriers.current.children.forEach((c, i) => {
        c.rotation.y = -ang.current * 2.2 + i;
      });
    }
    if (drops.current) {
      for (let i = 0; i < 24; i++) {
        const u = (engine.time * 1.4 + i / 24) % 1;
        o.position.set(cx - 0.25 + (i % 6) * 0.1, TABLE_Y + 0.9 - u * 0.75, -0.3 + (i % 4) * 0.2);
        o.scale.setScalar(working ? 0.012 : 0.0001);
        o.updateMatrix();
        drops.current.setMatrixAt(i, o.matrix);
      }
      drops.current.instanceMatrix.needsUpdate = true;
    }
    if (active) track('focus', cx, TABLE_Y + 0.1, 0);
  });
  const machine = kind === 'lap' ? 'lapper' : 'dsp-polisher';
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: machine, label: kind === 'lap' ? 'Double-side lapper' : 'Double-side polisher' }}>
        <B s={[1.9, TABLE_Y - 0.05, 1.9]} m={M.panel} position={[cx, (TABLE_Y - 0.05) / 2, 0]} />
        <group ref={lower} position={[cx, TABLE_Y, 0]}>
          <Clickable sel={{ kind: 'component', id: kind === 'lap' ? 'plates' : 'pads', machine, label: kind === 'lap' ? 'Lower plate' : 'Lower pad' }}>
            <C r={0.82} h={0.06} m={plateMat} />
            {Array.from({ length: 8 }, (_, i) => (
              <B key={i} s={[1.6, 0.002, 0.012]} m={M.steelDark} position={[0, 0.031, 0]} rotation={[0, (i / 8) * Math.PI, 0]} />
            ))}
          </Clickable>
        </group>
        <group ref={carriers} position={[cx, TABLE_Y + 0.035, 0]}>
          {[0, 1, 2, 3].map((k) => {
            const a = (k / 4) * Math.PI * 2;
            return (
              <group key={k} position={[Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45]}>
                <Clickable sel={{ kind: 'component', id: 'carriers', machine, label: 'Planetary carrier' }}>
                  <C r={0.34} h={0.006} m={M.greenAccent} />
                  <mesh geometry={waferGeometry(0.15)} material={k === 0 ? followMat : M.siRough} position={[0.0, 0.004, 0]} scale={0.6} />
                </Clickable>
              </group>
            );
          })}
        </group>
        <group ref={upper} position={[cx, TABLE_Y + 0.5, 0]}>
          <C r={0.82} h={0.08} m={plateMat} />
          <C r={0.12} h={0.6} m={M.steel} position={[0, 0.34, 0]} />
        </group>
        <B s={[0.25, 1.8, 0.25]} m={M.panelGrey} position={[cx - 1.05, 0.9, -0.85]} />
        <B s={[1.3, 0.2, 0.25]} m={M.panelGrey} position={[cx - 0.5, 1.75, -0.85]} />
        <SignalTower position={[cx + 0.9, TABLE_Y - 0.05, -0.9]} />
      </Clickable>
      <instancedMesh ref={drops} args={[GEO.sphereLow, slurryMat, 24]} />
      <SensorIndicator id="downforce" channel={kind === 'lap' ? undefined : 'force'} machine={machine} position={[cx, TABLE_Y + 1.15, 0.15]} size={0.07} />
      <TechLabel position={[cx, TABLE_Y + 1.25, 0.3]} title={kind === 'lap' ? 'DOUBLE-SIDE LAPPING · Al₂O₃ ABRASIVE' : 'DOUBLE-SIDE POLISHING · COLLOIDAL SILICA'} value={() => (kind === 'lap' ? `thickness ${engine.tele.value('thick', 925).toFixed(1)} µm · Ra ${engine.tele.value('ra', 1.5).toFixed(2)} µm` : `thickness ${engine.tele.value('thick', 775).toFixed(1)} µm · roughness ${engine.tele.value('rough', 0.2).toFixed(1)} nm`)} />
      <RoughnessInset
        id={`rough-${kind}`}
        position={[cx - 0.9, 2.1, 0.9]}
        mpu={kind === 'lap' ? 2e-5 / 1.3 : 1e-6 / 1.3}
        title={kind === 'lap' ? 'SURFACE PROFILE · ~20 µm FIELD' : 'SURFACE PROFILE · ~1 µm FIELD'}
        amp={() => (engine.stage.id === stageId ? (kind === 'lap' ? engine.tele.value('ra', 1.5) / 1.5 : Math.min(1, engine.tele.value('rough', 250) / 250)) : kind === 'lap' ? 0.17 : 0.001)}
      />
    </group>
  );
}

/* --------------------------------------------------------- 3 · etch bath */

function EtchStation() {
  const cx = X.etch;
  const cassette = useRef<THREE.Group>(null);
  const bubbles = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const tanks = [
    { x: cx - 0.55, label: 'ACID ETCH (HF/HNO₃)', mat: liquid('#c8d6a4', 0.5) },
    { x: cx + 0.55, label: 'QUENCH RINSE (UPW)', mat: liquid('#cfe6ea', 0.35) },
  ];
  useFrame(() => {
    const active = engine.stage.id === 'chemical-etch';
    const imm = active ? pp('immerse') : 1;
    const rinse = active ? pp('rinse') : 1;
    const dry = active ? pp('dry') : 1;
    let x = tanks[0].x;
    let y = TABLE_Y + 0.55;
    if (active) {
      if (rinse > 0 && rinse < 1) {
        const m = smooth(clamp(rinse * 3));
        x = lerp(tanks[0].x, tanks[1].x, m);
        y = TABLE_Y + 0.55 - Math.sin(Math.PI * clamp(rinse * 3)) * -0.4 - (rinse > 0.33 ? 0.45 : 0);
      } else if (dry > 0) {
        x = tanks[1].x;
        y = TABLE_Y + 0.1 + smooth(dry) * 0.55;
      } else {
        x = tanks[0].x;
        y = TABLE_Y + 0.55 - smooth(imm) * 0.45;
      }
    } else {
      x = tanks[1].x;
      y = TABLE_Y + 0.65;
    }
    if (cassette.current) cassette.current.position.set(x, y, 0);
    if (bubbles.current) {
      const on = active && inPhase('etch');
      for (let i = 0; i < 40; i++) {
        const u = (engine.time * 0.7 + i / 40) % 1;
        o.position.set(tanks[0].x - 0.18 + (i % 7) * 0.06, TABLE_Y - 0.3 + u * 0.38, -0.15 + (i % 5) * 0.07);
        o.scale.setScalar(on ? 0.012 + 0.006 * (1 - u) : 0.0001);
        o.updateMatrix();
        bubbles.current.setMatrixAt(i, o.matrix);
      }
      bubbles.current.instanceMatrix.needsUpdate = true;
    }
    if (active) track('focus', x, y, 0);
  });
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'etch-bath', label: 'Wet chemical etch station' }}>
        <B s={[2.0, TABLE_Y - 0.4, 0.9]} m={M.plastic} position={[cx, (TABLE_Y - 0.4) / 2, 0]} />
        {tanks.map((t) => (
          <Clickable key={t.x} sel={{ kind: 'component', id: 'tanks', machine: 'etch-bath', label: t.label }}>
            <mesh position={[t.x, TABLE_Y - 0.15, 0]} material={M.quartz}>
              <boxGeometry args={[0.6, 0.5, 0.6]} />
            </mesh>
            <mesh position={[t.x, TABLE_Y - 0.17, 0]} material={t.mat}>
              <boxGeometry args={[0.56, 0.42, 0.56]} />
            </mesh>
          </Clickable>
        ))}
        <B s={[2.1, 0.08, 0.1]} m={M.steel} position={[cx, TABLE_Y + 1.25, -0.35]} />
        <B s={[0.08, 1.3, 0.08]} m={M.steel} position={[cx - 1.0, TABLE_Y + 0.6, -0.35]} />
        <B s={[0.08, 1.3, 0.08]} m={M.steel} position={[cx + 1.0, TABLE_Y + 0.6, -0.35]} />
        <B s={[2.0, 1.6, 0.06]} m={M.panel} position={[cx, TABLE_Y + 0.4, -0.5]} />
      </Clickable>
      <group ref={cassette}>
        <Clickable sel={{ kind: 'component', id: 'cassette', machine: 'etch-bath', label: 'Process cassette (wafers on edge)' }}>
          <B s={[0.36, 0.04, 0.04]} m={M.plastic} position={[0, 0.17, 0.12]} />
          <B s={[0.36, 0.04, 0.04]} m={M.plastic} position={[0, 0.17, -0.12]} />
          {Array.from({ length: 8 }, (_, i) => (
            <mesh key={i} geometry={waferGeometry(0.15)} material={i === 3 ? followMat : M.siRough} position={[-0.14 + i * 0.04, 0.0, 0]} rotation={[0, 0, Math.PI / 2]} scale={0.95} />
          ))}
          <B s={[0.03, 0.7, 0.03]} m={M.steel} position={[0, 0.5, -0.12]} />
        </Clickable>
      </group>
      <instancedMesh ref={bubbles} args={[GEO.sphereLow, new THREE.MeshBasicMaterial({ color: '#f2f6e8', transparent: true, opacity: 0.8 }), 40]} />
      <SensorIndicator id="thermocouple" channel="bath" machine="etch-bath" position={[tanks[0].x + 0.33, TABLE_Y, 0.2]} size={0.06} />
      <SensorIndicator id="conductivity" machine="etch-bath" position={[tanks[1].x + 0.33, TABLE_Y, 0.2]} size={0.06} />
      <TechLabel position={[tanks[0].x, TABLE_Y + 0.25, 0.35]} title="ACID ETCH" lines={['dissolves the cracked surface layer']} />
      <TechLabel position={[tanks[1].x, TABLE_Y + 0.25, 0.35]} title="RINSE" />
      <RoughnessInset
        id="damage"
        position={[cx - 0.9, 2.1, 0.9]}
        mpu={2e-5 / 1.3}
        title="SUB-SURFACE DAMAGE LAYER"
        amp={() => 0.2}
        layers={() => ({ damage: engine.stage.id === 'chemical-etch' ? engine.tele.value('damage', 12) / 12 : engine.stage.id === 'lapping' ? 1 : 0 })}
      />
    </group>
  );
}

/* --------------------------------------------------------- 5 · wet clean bench */

const CLEAN_TANKS = [
  { id: 'sc1', label: 'SC-1 + MEGASONICS', color: '#cfe0b8' },
  { id: 'rinse1', label: 'UPW RINSE', color: '#d6eaf0' },
  { id: 'sc2', label: 'SC-2', color: '#e6dcb0' },
  { id: 'rinse2', label: 'UPW RINSE', color: '#d6eaf0' },
  { id: 'hf', label: 'DILUTE HF', color: '#dfe8d6' },
  { id: 'dry', label: 'MARANGONI DRY', color: '#eef2ea' },
];

function CleanBench() {
  const cx = X.clean;
  const carrier = useRef<THREE.Group>(null);
  const particles = useRef<THREE.InstancedMesh>(null);
  const ions = useRef<THREE.InstancedMesh>(null);
  const oxide = useRef<THREE.Mesh>(null);
  const ripples = useRef<THREE.Mesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const seeds = useMemo(() => {
    const r = rng(77);
    return Array.from({ length: 64 }, () => ({ a: r() * Math.PI * 2, d: Math.sqrt(r()) * 0.13, h: r() }));
  }, []);
  const tx = (i: number) => cx - 1.75 + i * 0.7;
  useFrame(() => {
    const active = engine.stage.id === 'wafer-clean';
    const v = engine.player.view;
    const i = active ? Math.max(0, CLEAN_TANKS.findIndex((t) => t.id === v.phaseId)) : 5;
    const p = active ? v.phaseT : 1;
    // carrier: lift out of previous tank, travel, dip into the current tank
    const x = tx(i);
    const dip = active ? smooth(clamp(p * 4)) * (1 - smooth(clamp((p - 0.85) / 0.15))) : 0;
    if (carrier.current) carrier.current.position.set(x, TABLE_Y + 0.75 - dip * 0.55, 0);
    // particle count follows telemetry; particles lift off and float away as they are removed
    const count = active ? engine.tele.value('particles', 300) : 8;
    const shown = Math.round((count / 320) * 64);
    if (particles.current) {
      seeds.forEach((s, k) => {
        const leaving = k >= shown;
        const lift = leaving ? clamp((engine.time * 0.4 + s.h) % 1) * 0.3 : 0;
        o.position.set(Math.cos(s.a) * s.d, 0.006 + lift, Math.sin(s.a) * s.d);
        o.scale.setScalar(leaving && lift > 0.25 ? 0.0001 : 0.006 + s.h * 0.004);
        o.updateMatrix();
        particles.current!.setMatrixAt(k, o.matrix);
      });
      particles.current.instanceMatrix.needsUpdate = true;
    }
    if (ions.current) {
      const sc2 = active ? pp('sc2') : 1;
      seeds.slice(0, 30).forEach((s, k) => {
        o.position.set(Math.cos(s.a + 1) * s.d * 0.9, 0.003, Math.sin(s.a + 1) * s.d * 0.9);
        o.scale.setScalar(k / 30 >= sc2 ? 0.003 : 0.0001);
        o.updateMatrix();
        ions.current!.setMatrixAt(k, o.matrix);
      });
      ions.current.instanceMatrix.needsUpdate = true;
    }
    if (oxide.current) oxide.current.visible = !active || pp('hf') < 0.6;
    if (ripples.current) {
      ripples.current.visible = active && v.phaseId === 'sc1';
      const s = 0.1 + ((engine.time * 0.8) % 1) * 0.25;
      ripples.current.scale.setScalar(s);
    }
    if (active) track('focus', x, TABLE_Y + 0.75 - dip * 0.55, 0);
  });
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'wet-bench', label: 'Wet clean station' }}>
        <B s={[4.6, TABLE_Y - 0.35, 1.0]} m={M.plastic} position={[cx, (TABLE_Y - 0.35) / 2, 0]} />
        <B s={[4.6, 1.8, 0.06]} m={M.panel} position={[cx, TABLE_Y + 0.6, -0.55]} />
        <B s={[4.6, 0.25, 1.0]} m={M.panelGrey} position={[cx, TABLE_Y + 1.6, -0.1]} />
        {CLEAN_TANKS.map((t, i) => (
          <Clickable key={t.id} sel={{ kind: 'component', id: t.id === 'sc1' ? 'sc1' : t.id === 'sc2' ? 'sc2' : t.id === 'hf' ? 'hf' : t.id === 'dry' ? 'dryer' : 'rinse', machine: 'wet-bench', label: t.label }}>
            <mesh position={[tx(i), TABLE_Y - 0.12, 0]} material={M.quartz}>
              <boxGeometry args={[0.6, 0.48, 0.6]} />
            </mesh>
            {t.id !== 'dry' && (
              <mesh position={[tx(i), TABLE_Y - 0.15, 0]} material={liquid(t.color, 0.45)}>
                <boxGeometry args={[0.56, 0.4, 0.56]} />
              </mesh>
            )}
            <TechLabel position={[tx(i), TABLE_Y + 0.2, 0.33]} title={t.label} min={2} />
          </Clickable>
        ))}
        <Clickable sel={{ kind: 'component', id: 'megasonic', machine: 'wet-bench', label: 'Megasonic transducer' }}>
          <B s={[0.5, 0.04, 0.5]} m={M.steelDark} position={[tx(0), TABLE_Y - 0.35, 0]} />
        </Clickable>
        <mesh ref={ripples} position={[tx(0), TABLE_Y + 0.051, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.9, 1, 40]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.5} />
        </mesh>
        <B s={[4.7, 0.06, 0.08]} m={M.steel} position={[cx, TABLE_Y + 1.3, -0.3]} />
        <SignalTower position={[cx + 2.2, TABLE_Y + 1.75, -0.4]} />
      </Clickable>
      <group ref={carrier}>
        <B s={[0.05, 0.6, 0.05]} m={M.steel} position={[0, 0.3, -0.25]} />
        <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184 in cleaning' }}>
          <group position={[0, 0.01, 0]}>
            <mesh geometry={waferGeometry(0.15)} material={followMat} rotation={[0, 0, 0]} />
            <mesh ref={oxide} position={[0, 0.0006, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <circleGeometry args={[0.149, 48]} />
              <meshStandardMaterial color="#b9c2d0" transparent opacity={0.18} />
            </mesh>
            <instancedMesh ref={particles} args={[GEO.sphereLow, new THREE.MeshStandardMaterial({ color: '#e8d18a', roughness: 0.7 }), 64]} />
            <instancedMesh ref={ions} args={[GEO.sphereLow, new THREE.MeshBasicMaterial({ color: '#b06ad6' }), 30]} />
          </group>
        </Clickable>
      </group>
      <SensorIndicator id="particle-counter" channel="particles" machine="wet-bench" position={[cx + 2.2, TABLE_Y + 0.4, 0.45]} size={0.07} />
      <SensorIndicator id="conductivity" channel="rho" machine="wet-bench" position={[tx(1) + 0.33, TABLE_Y, 0.25]} size={0.06} />
      <SensorIndicator id="thermocouple" channel="bath" machine="wet-bench" position={[tx(0) + 0.33, TABLE_Y, 0.25]} size={0.06} />
      <TechLabel position={[cx, TABLE_Y + 1.95, 0]} title="PARTICLES · METAL IONS · NATIVE OXIDE → REMOVED" value={() => `particles on wafer ${engine.tele.value('particles', 8).toFixed(0)} · rinse ${engine.tele.value('rho', 18).toFixed(1)} MΩ·cm`} />
      <ParticleInset position={[cx - 0.9, 2.1, 0.9]} />
    </group>
  );
}

/** SC-1 mechanism: the surface is etched slightly under a particle, which lifts and is repelled. */
function ParticleInset({ position }: { position: [number, number, number] }) {
  const p = useRef<THREE.Mesh>(null);
  const undercut = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const active = engine.stage.id === 'wafer-clean';
    const k = active ? pp('sc1') : 1;
    const stay = engine.failSeverity('contamination');
    if (p.current) {
      const lift = smooth(clamp((k - 0.4) / 0.6)) * (1 - stay);
      p.current.position.set(lift * 0.25, 0.12 + 0.1 + lift * 0.35, 0.15);
    }
    if (undercut.current) undercut.current.scale.set(0.18 * smooth(clamp(k * 1.5)), 0.03, 0.2);
  });
  return (
    <Inset id="particle" position={position} size={[1.3, 0.85]} mpu={1e-6 / 1.3} title="SC-1 · UNDERCUT & LIFT-OFF">
      <group position={[0, -0.05, 0]}>
        <B s={[1.1, 0.24, 0.2]} m={M.siPolished} position={[0, 0, 0.15]} shadow={false} />
        <mesh ref={undercut} geometry={GEO.box} material={M.black} position={[0, 0.11, 0.15]} />
        <mesh ref={p} geometry={GEO.sphere} scale={0.1} material={new THREE.MeshStandardMaterial({ color: '#e8d18a', roughness: 0.8 })} />
      </group>
      <TechLabel position={[0.35, 0.25, 0.2]} title="PARTICLE REPELLED (same-sign surface charge)" min={3} />
    </Inset>
  );
}

/* --------------------------------------------------------- scene */

export default function FinishingScene({ stage }: SceneProps) {
  const variant = (stage.variant ?? 'edge') as keyof typeof X;
  // the followed wafer's surface condition through the finishing line
  useFrame(() => {
    const id = engine.stage.id;
    let rough = 1;
    if (id === 'edge-profiling') rough = 1;
    if (id === 'lapping') rough = lerp(1, 0.62, pp('lap'));
    if (id === 'chemical-etch') rough = lerp(0.62, 0.42, pp('etch'));
    if (id === 'polishing') rough = lerp(0.42, 0.0, smooth(Math.max(pp('stock') * 0.7, pp('stock') * 0.7 + pp('final') * 0.3)));
    if (id === 'wafer-clean') rough = 0;
    setSurface(rough);
  });
  useEffect(() => () => setSurface(1), []);
  const cx = X[variant] ?? 0;
  return (
    <>
      <Lighting env="cleanroom" shadowExtent={7} center={[cx, 0, 0]} />
      <CleanroomBay width={42} depth={10} height={4.2} center={[4, 0, -1]} />
      <EdgeStation />
      <DoubleSide cx={X.lap} kind="lap" />
      <EtchStation />
      <DoubleSide cx={X.polish} kind="polish" />
      <CleanBench />
      <Pipe points={[[-14, 0.25, -2.2], [24, 0.25, -2.2]]} radius={0.05} m={M.steel} />
    </>
  );
}
