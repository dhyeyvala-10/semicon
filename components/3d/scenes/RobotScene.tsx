'use client';
/**
 * Cleanroom entry & wafer robotics (§17–§20, §55): OHT → load port → FOUP door → mapping →
 * SCARA robot pick → pre-aligner → slit valve → process chamber lift pins → return.
 * Every pose is the RobotController's simulated state.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, CleanroomBay } from '../environments';
import { M, shell, XRAY } from '../materials';
import { B, C } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { FOUP, waferGeometry } from '../parts/wafer';
import { RobotArm } from '../parts/robotArm';
import { Operator } from '../parts/people';
import { useUI } from '@/lib/store';
import { useTicker } from '@/hooks/useTicker';
import { engine } from '@/simulation/engine';
import { STATIONS, FOUP_SLOT } from '@/simulation/robot';
import { pp } from '@/lib/anim';
import { track } from '@/lib/runtime';
import { smooth, clamp } from '@/lib/math';

const Y0 = 0.85; // robot frame origin (world y)
const PORT_X = STATIONS.foup.r; // FOUP centre x (wafer centres)
const OHT_Y = 4.1;
const waferMat = new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.07, metalness: 0.92 });
const SEQ = ['HOME', 'PICK', 'VERIFY', 'ROTATE', 'TRANSFER', 'PLACE', 'VERIFY', 'RETURN'];

function stationWorld(id: keyof typeof STATIONS) {
  const s = STATIONS[id];
  return new THREE.Vector3(Math.cos(s.th) * s.r, Y0 + s.z, -Math.sin(s.th) * s.r);
}

function Efem() {
  const view = useUI((s) => s.view);
  const glass = view === 'xray' ? XRAY : M.glass;
  const panel = shell(M.panel, view === 'xray' ? 'xray' : 'normal');
  return (
    <Clickable sel={{ kind: 'machine', id: 'efem', label: 'Equipment front-end module (EFEM)' }}>
      {/* frame & transparent panels so the mini-environment is visible */}
      <B s={[0.84, 0.42, 1.6]} m={panel} position={[0, 0.21, 0]} />
      {[[-0.42, -0.8], [0.42, -0.8], [-0.42, 0.8], [0.42, 0.8]].map(([x, z], i) => (
        <B key={i} s={[0.04, 1.75, 0.04]} m={M.frame} position={[x, 1.3, z]} />
      ))}
      <B s={[0.84, 1.3, 0.01]} m={glass} position={[0, 1.27, 0.8]} shadow={false} />
      <B s={[0.84, 1.3, 0.01]} m={glass} position={[0, 1.27, -0.8]} shadow={false} />
      {/* front wall toward the load port with FIMS opening */}
      <B s={[0.03, 0.5, 1.6]} m={panel} position={[0.42, 0.67, 0]} />
      <B s={[0.03, 0.6, 1.6]} m={panel} position={[0.42, 1.85, 0]} />
      <B s={[0.03, 0.38, 0.58]} m={panel} position={[0.42, 1.0, -0.51]} />
      <B s={[0.03, 0.38, 0.58]} m={panel} position={[0.42, 1.0, 0.51]} />
      {/* EFEM fan-filter unit */}
      <Clickable sel={{ kind: 'component', id: 'ffu', machine: 'efem', label: 'EFEM FFU' }}>
        <B s={[0.9, 0.22, 1.66]} m={M.steel} position={[0, 2.26, 0]} />
        <B s={[0.8, 0.01, 1.5]} m={M.lightPanel} position={[0, 2.14, 0]} shadow={false} />
      </Clickable>
      <SignalTower position={[0.36, 2.37, 0.7]} />
    </Clickable>
  );
}

function LoadPortAndFoup() {
  const foup = useRef<THREE.Group>(null);
  const hoist = useRef<THREE.Group>(null);
  const beam = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const entry = engine.stage.id === 'cleanroom-entry';
    const arrive = entry ? pp('arrive') : 1;
    const dock = entry ? pp('dock') : 1;
    const y = 0.9 + (1 - smooth(arrive)) * (OHT_Y - 0.62 - 0.9);
    if (foup.current) foup.current.position.set(PORT_X + 0.05 - smooth(dock) * 0.05, y, 0);
    if (hoist.current) {
      hoist.current.position.y = y + 0.38;
      hoist.current.visible = entry && arrive < 1;
    }
    if (beam.current) {
      beam.current.visible = entry && engine.player.view.phaseId === 'map';
      beam.current.position.y = Y0 + engine.robot.q[2];
    }
    if (entry && arrive < 1) track('focus', PORT_X, y + 0.2, 0);
  });
  return (
    <group>
      <Clickable sel={{ kind: 'component', id: 'load-port', machine: 'efem', label: 'Load port (FIMS)' }}>
        <B s={[0.46, 0.9, 0.5]} m={M.panel} position={[PORT_X, 0.45, 0]} />
        <B s={[0.44, 0.02, 0.46]} m={M.steelDark} position={[PORT_X, 0.895, 0]} />
        {[[-0.12, -0.12], [0.12, -0.12], [0, 0.14]].map(([dx, dz], i) => (
          <C key={i} r={0.008} h={0.012} m={M.steel} position={[PORT_X + dx, 0.905, dz]} />
        ))}
      </Clickable>
      <group ref={foup} position={[PORT_X, 0.9, 0]}>
        <Clickable sel={{ kind: 'wafer', id: 'lot-foup', label: 'FOUP · LOT-A0731 (25 wafers)' }}>
          <FoupLive />
        </Clickable>
      </group>
      <group ref={hoist}>
        <B s={[0.34, 0.03, 0.34]} m={M.panelDark} position={[PORT_X, 0, 0]} />
        {[-0.12, 0.12].map((dz) => (
          <B key={dz} s={[0.01, OHT_Y - 1.5, 0.02]} m={M.panelDark} position={[PORT_X, (OHT_Y - 1.5) / 2, dz]} />
        ))}
      </group>
      {/* OHT rail + vehicle above the port */}
      <B s={[6, 0.1, 0.14]} m={M.steelDark} position={[PORT_X, OHT_Y + 0.15, 0]} />
      <B s={[0.92, 0.7, 0.62]} m={M.panel} position={[PORT_X, OHT_Y - 0.25, 0]} />
      <mesh ref={beam} position={[0.4, 1, 0]} rotation={[0, 0, Math.PI / 2]} visible={false}>
        <cylinderGeometry args={[0.002, 0.002, 0.45, 6]} />
        <meshBasicMaterial color="#ff4a3a" toneMapped={false} />
      </mesh>
      <SensorIndicator id="wafer-presence" machine="efem" position={[0.46, 0.85, 0.3]} size={0.05} />
      <TechLabel position={[PORT_X, 1.45, 0.3]} title="FOUP · 25 SLOTS" lines={['SEMI E47.1 carrier · E84 hand-off']} />
    </group>
  );
}

/** FOUP whose door state and slot occupancy follow the simulation. */
function FoupLive() {
  useTicker(12);
  const entry = engine.stage.id === 'cleanroom-entry';
  const door = entry ? smooth(clamp(pp('dock') * 1.4 - 0.3)) : 1;
  const hide = engine.robot.waferLoc !== 'foup' ? FOUP_SLOT : undefined;
  return (
    <group rotation={[0, Math.PI, 0]}>
      <FOUP door={Math.min(0.999, door)} hideSlot={hide} />
    </group>
  );
}

function Aligner() {
  const chuck = useRef<THREE.Group>(null);
  const wafer = useRef<THREE.Mesh>(null);
  const p = stationWorld('aligner');
  useFrame(() => {
    const r = engine.robot;
    if (chuck.current) chuck.current.rotation.y = r.waferSpin;
    if (wafer.current) wafer.current.visible = r.waferLoc === 'aligner';
  });
  return (
    <Clickable sel={{ kind: 'component', id: 'aligner', machine: 'efem', label: 'Pre-aligner' }}>
      <B s={[0.3, p.y - 0.42 - 0.06, 0.3]} m={M.panelGrey} position={[p.x, 0.42 + (p.y - 0.42 - 0.06) / 2, p.z]} />
      <group ref={chuck} position={[p.x, p.y - 0.004, p.z]}>
        <C r={0.035} h={0.02} m={M.steelDark} position={[0, -0.012, 0]} />
        <mesh ref={wafer} geometry={waferGeometry()} material={waferMat} visible={false} />
      </group>
      {/* notch-finding optical sensor */}
      <B s={[0.05, 0.06, 0.04]} m={M.panelDark} position={[p.x + 0.17, p.y, p.z]} />
      <TechLabel position={[p.x, p.y + 0.12, p.z - 0.15]} title="PRE-ALIGNER" lines={['finds notch & centre']} value={() => (engine.robot.notchFound ? 'NOTCH FOUND · ORIENTED' : 'SEARCHING NOTCH…')} />
    </Clickable>
  );
}

function ProcessChamber() {
  const view = useUI((s) => s.view);
  const valve = useRef<THREE.Mesh>(null);
  const pins = useRef<THREE.Group>(null);
  const wafer = useRef<THREE.Mesh>(null);
  const glow = useRef<THREE.PointLight>(null);
  const p = stationWorld('chamber');
  const open = useRef(0);
  useFrame((_, dt) => {
    const r = engine.robot;
    const ph = engine.player.view.phaseId;
    const lab = engine.stage.id === 'robot-lab';
    // the slit valve opens only while the arm reaches into the chamber
    const reach = Math.cos(r.q[0]) < -0.95 && r.q[1] > 0.35;
    const want = reach || ph === 'transfer' || ph === 'place' ? 1 : 0;
    open.current += (want - open.current) * Math.min(1, dt * 6);
    if (valve.current) valve.current.position.y = p.y + open.current * 0.12;
    if (pins.current) pins.current.position.y = r.waferLoc === 'chamber' && !reach ? -0.012 : 0;
    if (wafer.current) wafer.current.visible = r.waferLoc === 'chamber';
    const processing = r.waferLoc === 'chamber' && !reach && (lab ? r.stepLabel === 'PROCESS' : ph === 'return');
    if (glow.current) glow.current.intensity = processing ? 2.5 + Math.sin(engine.time * 20) * 0.3 : 0;
  });
  return (
    <Clickable sel={{ kind: 'machine', id: 'dep-cluster', label: 'Process chamber (load lock)' }}>
      {/* chamber body behind the EFEM back wall */}
      <B s={[0.03, 1.6, 1.6]} m={shell(M.panel, view === 'xray' ? 'xray' : 'normal')} position={[-0.42, 1.3, 0]} />
      <mesh ref={valve} position={[-0.43, p.y, 0]} material={M.steelDark}>
        <boxGeometry args={[0.04, 0.05, 0.42]} />
      </mesh>
      <C r={0.36} h={0.36} m={shell(M.steel, view === 'normal' ? 'cutaway' : view)} position={[p.x - 0.02, p.y + 0.02, 0]} />
      <B s={[0.9, p.y - 0.25, 0.9]} m={M.panelGrey} position={[p.x - 0.1, (p.y - 0.25) / 2, 0]} />
      <group ref={pins} position={[p.x, 0, 0]}>
        {[0, 1, 2].map((k) => (
          <C key={k} r={0.006} h={0.06} m={M.ceramic} position={[Math.cos((k * 2 * Math.PI) / 3) * 0.08, p.y - 0.034, Math.sin((k * 2 * Math.PI) / 3) * 0.08]} />
        ))}
      </group>
      <mesh ref={wafer} geometry={waferGeometry()} material={waferMat} position={[p.x, p.y - 0.004, 0]} visible={false} />
      <pointLight ref={glow} position={[p.x, p.y + 0.08, 0]} color="#c9a6ff" distance={0.8} />
      <B s={[0.8, 0.5, 0.8]} m={M.steelDark} position={[p.x - 0.1, p.y + 0.42, 0]} />
      <TechLabel position={[p.x, p.y + 0.75, 0]} title="SLIT VALVE → CHAMBER LIFT PINS" min={2} />
    </Clickable>
  );
}

/** Recent end-effector path (motion trail) and the live step sequence. */
function MotionTrail() {
  const pts = useRef<THREE.Vector3[]>([]);
  const line = useRef<{ geometry: { setPositions: (a: number[]) => void } } | null>(null);
  const seqRef = useRef<HTMLDivElement>(null);
  useFrame(() => {
    const e = engine.robot.effector();
    const v = new THREE.Vector3(e.x, Y0 + e.y + 0.01, e.z);
    const last = pts.current[pts.current.length - 1];
    if (!last || last.distanceTo(v) > 0.01) {
      pts.current.push(v);
      if (pts.current.length > 120) pts.current.shift();
    }
    if (line.current && pts.current.length > 1) line.current.geometry.setPositions(pts.current.flatMap((p) => [p.x, p.y, p.z]));
    if (seqRef.current) {
      const step = engine.robot.error ? 'ERROR' : engine.robot.stepLabel;
      Array.from(seqRef.current.children).forEach((c, i) => {
        (c as HTMLElement).style.borderColor = SEQ[i] === step ? 'var(--accent)' : '';
        (c as HTMLElement).style.color = SEQ[i] === step ? 'var(--text)' : '';
      });
    }
    track('focus', v.x, v.y, v.z);
  });
  const info = useUI((s) => s.info);
  return (
    <>
      <Line ref={line as never} points={[[0, Y0, 0], [0.01, Y0, 0]]} color="#c3d8a4" lineWidth={1.5} transparent opacity={0.6} />
      {info >= 2 && (
        <Html position={[-0.3, 2.65, 0.8]} style={{ pointerEvents: 'none' }} zIndexRange={[15, 0]}>
          <div className="tlabel" style={{ transform: 'translate(-50%,-100%)' }}>
            <div className="tlabel-title">ROBOT SEQUENCE · SIMULATION</div>
            <div ref={seqRef} className="seq" style={{ marginTop: 4 }}>
              {SEQ.map((s, i) => (
                <span key={i}>{s}</span>
              ))}
            </div>
          </div>
        </Html>
      )}
    </>
  );
}

export default function RobotScene({ stage }: SceneProps) {
  const variant = stage.variant ?? 'efem';
  useEffect(() => {
    if (variant === 'lab') engine.robot.loop = true;
  }, [variant]);
  return (
    <>
      <Lighting env="cleanroom" shadowExtent={4} />
      <CleanroomBay width={10} depth={8} height={4.6} />
      <Efem />
      <LoadPortAndFoup />
      <Aligner />
      <ProcessChamber />
      <RobotArm position={[0, Y0, 0]} />
      <MotionTrail />
      <SensorIndicator id="vacuum-switch" channel="vac" machine="efem" position={[0.2, 0.55, 0.45]} size={0.05} />
      <SensorIndicator id="joint-encoder" channel="j1" machine="efem" position={[-0.15, 0.55, 0.45]} size={0.05} />
      <SensorIndicator id="particle-counter" machine="efem" position={[0.3, 2.05, -0.6]} size={0.05} />
      {/* neighbouring tools for context */}
      {[-3.6, 3.6].map((z) => (
        <group key={z} position={[0, 0, z]}>
          <B s={[0.84, 2.1, 1.6]} m={M.panel} position={[0, 1.05, 0]} />
          <B s={[0.46, 0.9, 0.5]} m={M.panel} position={[PORT_X, 0.45, 0]} />
          <B s={[1.6, 2.0, 1.6]} m={M.panelGrey} position={[-1.3, 1.0, 0]} />
          <SignalTower position={[0.36, 2.1, 0.6]} state={() => 'PROCESSING'} />
        </group>
      ))}
      <Operator position={[2.2, 0, 1.6]} rotation={-Math.PI / 2.5} still />
      <TechLabel position={[0, Y0 + 0.2, 0.75]} title="MINI-ENVIRONMENT · CLEANER THAN THE ROOM" lines={['wafers never meet open cleanroom air']} min={2} />
    </>
  );
}
