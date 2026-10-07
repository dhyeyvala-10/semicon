'use client';
/**
 * Interaction primitives: clickable groups, technical labels, sensors, signal towers.
 */
import * as THREE from 'three';
import { useRef, type ReactNode } from 'react';
import { useFrame, type ThreeEvent, type ThreeElements } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { useUI } from '@/lib/store';
import { hoverState } from '@/lib/runtime';
import type { MachineState, Selection } from '@/types';
import { engine } from '@/simulation/engine';
import { SENSOR_BY_ID } from '@/data/sensors';
import { STATE_COLOR } from '../materials';
import { GEO, type V3 } from './primitives';
import { fmt } from '@/lib/math';

/** Wrap any 3D content to make it selectable; opens the technical inspector (§9, §71). */
export function Clickable({ sel, children, hoverLabel, ...rest }: { sel: Selection; children: ReactNode; hoverLabel?: string } & ThreeElements['group']) {
  const select = useUI((s) => s.select);
  const label = hoverLabel ?? sel.label ?? sel.id;
  return (
    <group
      {...rest}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        select(sel);
      }}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        hoverState.label = label;
        hoverState.kind = sel.kind.toUpperCase();
        hoverState.version++;
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        hoverState.label = '';
        hoverState.version++;
        document.body.style.cursor = '';
      }}
    >
      {children}
    </group>
  );
}

/**
 * Small technical label (§105). Visible from info level `min` upward.
 * `value` is a function evaluated every frame (written straight to the DOM).
 */
export function TechLabel({
  position,
  title,
  lines,
  value,
  min = 2,
  tone = 'default',
}: {
  position: V3;
  title: string;
  lines?: string[];
  value?: () => string;
  min?: 1 | 2 | 3 | 4;
  tone?: 'default' | 'accent' | 'warn';
}) {
  const info = useUI((s) => s.info);
  const started = useUI((s) => s.started);
  const ref = useRef<HTMLSpanElement>(null);
  const acc = useRef(0);
  useFrame((_, dt) => {
    if (!value || !ref.current) return;
    acc.current += dt;
    if (acc.current < 0.12) return;
    acc.current = 0;
    ref.current.textContent = value();
  });
  if (info < min || !started) return null;
  return (
    <Html position={position} center={false} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
      <div className={`tlabel tlabel-${tone}`}>
        <div className="tlabel-title">{title}</div>
        {info >= 3 && lines?.map((l) => <div key={l} className="tlabel-line">{l}</div>)}
        {value && info >= 3 && <span ref={ref} className="tlabel-value" />}
      </div>
    </Html>
  );
}

const ledMats = new Map<string, THREE.MeshStandardMaterial>();
function led(color: string) {
  let m = ledMats.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, emissive: new THREE.Color(color), emissiveIntensity: 1.4, roughness: 0.4 });
    ledMats.set(color, m);
  }
  return m;
}
const sensorBody = new THREE.MeshStandardMaterial({ color: '#2d3237', roughness: 0.45, metalness: 0.6 });

/**
 * Representative sensor (§75): small body with status LED, clickable.
 * `channel` binds it to a telemetry channel for the simulated reading.
 */
export function SensorIndicator({ id, position, channel, machine, size = 0.035, rotation }: { id: string; position: V3; channel?: string; machine?: string; size?: number; rotation?: V3 }) {
  const ledRef = useRef<THREE.Mesh>(null);
  const def = SENSOR_BY_ID[id];
  useFrame(() => {
    if (!ledRef.current) return;
    const ch = channel ? engine.tele.get(channel) : undefined;
    const st = ch?.status ?? 'NORMAL';
    const col = st === 'FAULT' ? '#e0503f' : st === 'WARNING' ? '#e0a23a' : '#5fbf5a';
    ledRef.current.material = led(col);
  });
  return (
    <Clickable sel={{ kind: 'sensor', id, label: def?.name ?? id, machine, meta: channel ? { channel } : undefined }} position={position} rotation={rotation}>
      <mesh geometry={GEO.box} scale={[size, size * 0.7, size * 0.7]} material={sensorBody} />
      <mesh ref={ledRef} geometry={GEO.sphereLow} scale={size * 0.18} position={[size * 0.5, size * 0.12, 0]} material={led('#5fbf5a')} />
      <TechLabel position={[0, size * 0.9, 0]} title={def?.name ?? id} min={3} value={channel ? () => sensorReading(channel) : undefined} />
    </Clickable>
  );
}

export function sensorReading(channel: string) {
  const c = engine.tele.get(channel);
  if (!c) return '';
  return `${fmt(c.value, c.def.decimals ?? 1)} ${c.def.unit} · SIM`;
}

/** Stack light (signal tower) whose lamps follow the machine state (§59). */
export function SignalTower({ position, state, scale = 1 }: { position: V3; state?: () => MachineState; scale?: number }) {
  const lamps = useRef<(THREE.Mesh | null)[]>([]);
  const off = useRef(new THREE.MeshStandardMaterial({ color: '#2a2c2e', roughness: 0.5 })).current;
  useFrame(({ clock }) => {
    const s = state ? state() : engine.machineState;
    const blink = Math.sin(clock.elapsedTime * 7) > 0;
    const on = [
      s === 'ALARM' && blink, // red
      s === 'IDLE' || (s === 'LOADING' && blink) || (s === 'UNLOADING' && blink), // amber
      s === 'PROCESSING' || s === 'LOADING' || s === 'UNLOADING', // green
      s === 'MAINTENANCE', // blue
    ];
    const cols = ['#e0503f', '#e0a23a', '#5fbf5a', '#a99bd6'];
    lamps.current.forEach((m, i) => {
      if (m) m.material = on[i] ? led(cols[i]) : off;
    });
  });
  return (
    <group position={position} scale={scale}>
      <mesh geometry={GEO.cyl} scale={[0.012, 0.12, 0.012]} position={[0, 0.06, 0]} material={sensorBody} />
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} ref={(m) => { lamps.current[i] = m; }} geometry={GEO.cyl} scale={[0.028, 0.045, 0.028]} position={[0, 0.3 - i * 0.048, 0]} material={off} />
      ))}
      <mesh geometry={GEO.cyl} scale={[0.03, 0.012, 0.03]} position={[0, 0.33, 0]} material={sensorBody} />
    </group>
  );
}

export function stateColor(s: MachineState) {
  return STATE_COLOR[s] ?? '#888';
}
