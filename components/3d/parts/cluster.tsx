'use client';
/**
 * Generic single-wafer cluster tool (deposition, etch, strip): EFEM with load ports,
 * load locks, hexagonal vacuum transfer chamber with a vacuum robot, three closed
 * process chambers and one detailed, cut-away active chamber at +X.
 */
import * as THREE from 'three';
import { useMemo, useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { M, shell, effectiveView } from '../materials';
import { B, C } from './primitives';
import { Clickable, SignalTower, TechLabel } from './interaction';
import { FOUP, waferGeometry } from './wafer';
import { useUI } from '@/lib/store';
import { engine } from '@/simulation/engine';
import { pp } from '@/lib/anim';
import { track } from '@/lib/runtime';
import { smooth, clamp } from '@/lib/math';

export const CHAMBER = { x: 1.3, y0: 0.72, y1: 1.36, r: 0.5, waferY: 1.045 };
const LL = new THREE.Vector3(-1.35, 1.0, 0.35);
const TC = new THREE.Vector3(0, 1.0, 0);
const PM = new THREE.Vector3(CHAMBER.x, CHAMBER.waferY, 0);

/** Wafer position along LL → TC → PM for a 0..1 transfer progress. */
export function transferPos(u: number): THREE.Vector3 {
  const k = clamp(u);
  if (k < 0.5) return LL.clone().lerp(TC, smooth(k * 2));
  return TC.clone().lerp(PM, smooth((k - 0.5) * 2));
}

/** 0 = in load lock, 1 = on chamber pedestal — derived from the stage phases. */
export function transferProgress(): number {
  const ids = engine.stage.phases.map((p) => p.id);
  const loadId = ids[0];
  const outId = ids[ids.length - 1];
  const inP = pp(loadId);
  const outP = pp(outId);
  if (outP > 0) return 1 - outP;
  return inP;
}

export function ClusterTool({ machine, label, accent = 'blue', children, lid }: { machine: string; label: string; accent?: 'blue' | 'green' | 'orange'; children?: ReactNode; lid?: ReactNode }) {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  const view = effectiveView(viewRaw, cam);
  const wafer = useRef<THREE.Group>(null);
  const arm = useRef<THREE.Group>(null);
  const blade = useRef<THREE.Mesh>(null);
  const valve = useRef<THREE.Mesh>(null);
  const waferMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.08, metalness: 0.9 }), []);
  useFrame(() => {
    const u = transferProgress();
    const p = transferPos(u);
    if (wafer.current) wafer.current.position.copy(p);
    // vacuum robot follows the wafer while it is being carried
    const carried = u > 0.02 && u < 0.98;
    const target = carried ? p : u >= 0.98 ? TC.clone().add(new THREE.Vector3(0.25, 0, 0)) : TC.clone().add(new THREE.Vector3(-0.25, 0, 0.1));
    const d = target.clone().sub(TC);
    const r = Math.max(0.12, Math.hypot(d.x, d.z));
    if (arm.current) {
      arm.current.rotation.y = Math.atan2(-d.z, d.x);
      arm.current.scale.x = 1;
    }
    if (blade.current) {
      blade.current.scale.x = r;
      blade.current.position.x = r / 2;
    }
    // slit valve opens while the robot passes into the chamber
    const open = u > 0.55 && u < 0.97 ? 1 : 0;
    if (valve.current) valve.current.position.y = 1.0 + open * 0.14;
    if (u > 0.02 && u < 0.98) track('focus', p.x, p.y, p.z);
    else track('focus', PM.x, PM.y, PM.z);
  });
  const accentMat = accent === 'blue' ? M.blueAccent : accent === 'green' ? M.greenAccent : M.orangeAccent;
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: machine, label }}>
        {/* base frame */}
        <B s={[3.4, 0.7, 2.6]} m={M.panelDark} position={[0, 0.35, 0]} />
        {/* EFEM */}
        <Clickable sel={{ kind: 'component', id: 'efem', machine, label: 'EFEM & load ports' }}>
          <B s={[0.8, 2.05, 1.9]} m={shell(M.panel, view === 'xray' ? 'xray' : 'normal')} position={[-2.2, 1.03, 0]} />
          <B s={[0.82, 0.22, 1.92]} m={M.steel} position={[-2.2, 2.17, 0]} />
          {[-0.62, 0, 0.62].map((z) => (
            <B key={z} s={[0.5, 0.88, 0.48]} m={M.panelGrey} position={[-2.85, 0.44, z]} />
          ))}
          <FOUP position={[-2.85, 0.9, 0]} rotation={[0, 0, 0]} />
          <B s={[0.82, 0.06, 1.92]} m={accentMat} position={[-2.2, 1.9, 0]} />
          <SignalTower position={[-2.2, 2.28, 0.85]} />
        </Clickable>
        {/* load locks */}
        <Clickable sel={{ kind: 'component', id: 'load-lock', machine, label: 'Load locks' }}>
          {[-0.35, 0.35].map((z) => (
            <B key={z} s={[0.7, 0.42, 0.55]} m={shell(M.steel, view)} position={[-1.35, 1.0, z]} />
          ))}
        </Clickable>
        {/* transfer chamber */}
        <Clickable sel={{ kind: 'component', id: 'transfer-chamber', machine, label: 'Vacuum transfer chamber + robot' }}>
          <mesh position={[0, 0.98, 0]} material={shell(M.steel, view)}>
            <cylinderGeometry args={[0.78, 0.78, 0.5, 6, 1, true]} />
          </mesh>
          <mesh position={[0, 1.25, 0]} material={shell(M.panelGrey, view)}>
            <cylinderGeometry args={[0.8, 0.8, 0.05, 6]} />
          </mesh>
          <C r={0.12} h={0.12} m={M.steelDark} position={[0, 0.8, 0]} />
          <group ref={arm} position={[0, 0.99, 0]}>
            <mesh ref={blade} material={M.ceramic}>
              <boxGeometry args={[1, 0.012, 0.07]} />
            </mesh>
            <C r={0.05} h={0.04} m={M.steelDark} position={[0, -0.02, 0]} />
          </group>
        </Clickable>
        {/* other process chambers (closed) */}
        {[
          [0, 1.3],
          [0, -1.3],
        ].map(([x, z]) => (
          <group key={z} position={[x, 0, z]}>
            <C r={0.48} h={0.6} m={M.steel} position={[0, 1.02, 0]} />
            <B s={[0.5, 0.35, 0.5]} m={M.panel} position={[0, 1.5, 0]} />
            <C r={0.25} h={0.6} m={M.steelDark} position={[0, 0.42, 0]} />
          </group>
        ))}
        {/* active chamber body (cut-away when looking inside) */}
        <Clickable sel={{ kind: 'component', id: machine === 'etcher' ? 'liner' : machine === 'asher' ? 'plasma-source' : 'cvd-chamber', machine, label: 'Process chamber (active)' }}>
          <mesh position={[CHAMBER.x, (CHAMBER.y0 + CHAMBER.y1) / 2, 0]} material={shell(M.steel, view)}>
            <cylinderGeometry args={[CHAMBER.r, CHAMBER.r, CHAMBER.y1 - CHAMBER.y0, 48, 1, true]} />
          </mesh>
          <mesh position={[CHAMBER.x, CHAMBER.y1, 0]} material={shell(M.steelDark, view)}>
            <cylinderGeometry args={[CHAMBER.r + 0.03, CHAMBER.r + 0.03, 0.05, 48]} />
          </mesh>
          <C r={CHAMBER.r + 0.02} h={0.04} m={M.steelDark} position={[CHAMBER.x, CHAMBER.y0, 0]} />
          {/* pump port + turbo pump */}
          <C r={0.14} h={0.4} m={M.steelDark} position={[CHAMBER.x + 0.2, 0.52, 0.18]} />
          <C r={0.2} h={0.28} m={M.panelGrey} position={[CHAMBER.x + 0.2, 0.25, 0.18]} />
        </Clickable>
        {/* slit valve between TC and chamber */}
        <mesh ref={valve} position={[0.8, 1.0, 0]} material={M.steelDark}>
          <boxGeometry args={[0.05, 0.06, 0.4]} />
        </mesh>
        <B s={[0.14, 0.28, 0.5]} m={shell(M.steel, view)} position={[0.8, 0.98, 0]} />
        {lid}
      </Clickable>
      <group position={[CHAMBER.x, 0, 0]}>{children}</group>
      {/* the followed wafer */}
      <group ref={wafer}>
        <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184' }}>
          <mesh geometry={waferGeometry()} material={waferMat} castShadow />
        </Clickable>
      </group>
      <TechLabel position={[-1.35, 1.35, 0.35]} title="LOAD LOCK" lines={['atmosphere ↔ vacuum']} min={3} />
      <TechLabel position={[0, 1.45, 0]} title="VACUUM TRANSFER CHAMBER" min={2} />
    </group>
  );
}

/** Pedestal / electrostatic chuck with lift pins, centred in the active chamber (local coords). */
export function Pedestal({ heated = false, esc = false, machine, id }: { heated?: boolean; esc?: boolean; machine?: string; id?: string }) {
  const top = CHAMBER.waferY - 0.003;
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: esc ? '#4a4e52' : '#6b6e70', roughness: 0.5, metalness: 0.6, emissive: new THREE.Color('#ff6a1a'), emissiveIntensity: 0, toneMapped: false }), [esc]);
  useFrame(() => {
    if (heated) mat.emissiveIntensity = Math.max(0, (engine.tele.value('wT', engine.tele.value('platen', 25)) - 300) / 600) * 0.6;
  });
  return (
    <Clickable sel={{ kind: 'component', id: id ?? (esc ? 'esc' : 'pedestal'), machine: machine ?? (esc ? 'etcher' : 'dep-cluster'), label: esc ? 'Electrostatic chuck' : 'Heated pedestal' }}>
      <mesh position={[0, top - 0.04, 0]} material={mat}>
        <cylinderGeometry args={[0.165, 0.17, 0.08, 48]} />
      </mesh>
      <C r={0.05} h={top - 0.08 - CHAMBER.y0} m={M.steelDark} position={[0, (top - 0.08 + CHAMBER.y0) / 2, 0]} />
      {esc && <C r={0.19} h={0.012} m={M.ceramic} position={[0, top - 0.004, 0]} />}
    </Clickable>
  );
}

/** Showerhead (gas distribution plate) at the chamber top (local coords). */
export function Showerhead({ y = 1.28, machine = 'dep-cluster' }: { y?: number; machine?: string }) {
  return (
    <Clickable sel={{ kind: 'component', id: 'showerhead', machine, label: 'Showerhead / gas distribution plate' }}>
      <C r={0.2} h={0.025} m={M.alu} position={[0, y, 0]} />
      {Array.from({ length: 24 }, (_, i) => {
        const a = (i / 24) * Math.PI * 2;
        const r = i % 2 ? 0.14 : 0.08;
        return <C key={i} r={0.006} h={0.027} m={M.black} position={[Math.cos(a) * r, y, Math.sin(a) * r]} low shadow={false} />;
      })}
    </Clickable>
  );
}
