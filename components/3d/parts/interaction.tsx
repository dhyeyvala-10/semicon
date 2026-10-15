'use client';
/**
 * Interaction primitives: clickable groups (tap a part to learn what it is) and signal towers.
 * Floating labels and sensor markers render nothing in the redesign.
 */
import * as THREE from 'three';
import { useRef, type ReactNode } from 'react';
import { useFrame, type ThreeEvent, type ThreeElements } from '@react-three/fiber';
import { useUI, hoverPart } from '@/lib/store';
import { hoverState } from '@/lib/runtime';
import type { MachineState, Selection } from '@/types';
import { engine } from '@/simulation/engine';
import { STATE_COLOR } from '../materials';
import { GEO, type V3 } from './primitives';

/** Wrap any 3D content to make it selectable: a tap shows the part's plain name and one sentence (Explore). */
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
        hoverPart.sel = sel;
        hoverPart.version++;
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        hoverState.label = '';
        hoverState.version++;
        hoverPart.sel = null;
        hoverPart.version++;
        document.body.style.cursor = '';
      }}
    >
      {children}
    </group>
  );
}

/**
 * Floating 3D label. The redesign shows no labels in the 3D view (they were jargon, and each
 * one was a DOM overlay re-projected every frame), so this renders nothing. The props stay so
 * the scenes that place labels keep compiling unchanged.
 */
export function TechLabel(_props: {
  position: V3;
  title: string;
  lines?: string[];
  value?: () => string;
  min?: 1 | 2 | 3 | 4;
  tone?: 'default' | 'accent' | 'warn';
  /** optional visibility predicate */
  show?: () => boolean;
}) {
  return null;
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
 * Sensor marker. The redesign drops the sensor markers and their live readings from the 3D
 * view (no per-frame work, no label), so this renders nothing; the props stay for the scenes.
 */
export function SensorIndicator(_props: { id: string; position: V3; channel?: string; machine?: string; size?: number; rotation?: V3 }) {
  return null;
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
