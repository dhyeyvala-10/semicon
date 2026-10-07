'use client';
/**
 * Atmospheric wafer robot model driven every frame by the RobotController state (§19).
 * base → lift column (Z) → θ rotation → link 1 (shoulder α) → link 2 (elbow −2α) → wrist → blade.
 */
import * as THREE from 'three';
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { engine } from '@/simulation/engine';
import { ROBOT_GEOM, type RobotController } from '@/simulation/robot';
import { useUI } from '@/lib/store';
import { M, XRAY } from '../materials';
import { B, C, GEO } from './primitives';
import { Clickable, TechLabel } from './interaction';
import { Wafer } from './wafer';
import { fmt, deg } from '@/lib/math';

const armMat = new THREE.MeshStandardMaterial({ color: '#e4e4df', roughness: 0.35, metalness: 0.15 });
const bladeMat = new THREE.MeshStandardMaterial({ color: '#f1efe9', roughness: 0.3, metalness: 0.05 });
const padMat = new THREE.MeshStandardMaterial({ color: '#2a2c2f', roughness: 0.8 });
const motorMat = new THREE.MeshStandardMaterial({ color: '#4b5560', roughness: 0.4, metalness: 0.7 });
const beltMat = new THREE.MeshStandardMaterial({ color: '#202224', roughness: 0.7 });

export function RobotArm({ ctrl = engine.robot, position = [0, 0, 0] as [number, number, number], showWafer = true }: { ctrl?: RobotController; position?: [number, number, number]; showWafer?: boolean }) {
  const lift = useRef<THREE.Group>(null);
  const column = useRef<THREE.Mesh>(null);
  const rot = useRef<THREE.Group>(null);
  const link1 = useRef<THREE.Group>(null);
  const link2 = useRef<THREE.Group>(null);
  const wrist = useRef<THREE.Group>(null);
  const wafer = useRef<THREE.Mesh>(null);
  const view = useUI((s) => s.view);
  const explode = view === 'exploded' ? 1 : 0;
  const ex = useRef(0);
  const { L } = ROBOT_GEOM;
  const coverMat = view === 'xray' ? XRAY : armMat;

  useFrame((_, dt) => {
    ex.current += (explode - ex.current) * Math.min(1, dt * 4);
    const e = ex.current;
    const [th, , z] = ctrl.q;
    const j = ctrl.joints();
    if (lift.current) lift.current.position.y = z + e * 0.25;
    if (column.current) {
      const h = Math.max(0.02, z - 0.09 + 0.45);
      column.current.scale.set(0.075, h, 0.075);
      column.current.position.y = -0.45 + h / 2;
    }
    if (rot.current) rot.current.rotation.y = th;
    if (link1.current) {
      link1.current.rotation.y = j.j2;
      link1.current.position.y = -0.07 + e * 0.12;
    }
    if (link2.current) {
      link2.current.position.set(L * Math.cos(j.j2), -0.04 + e * 0.26, -L * Math.sin(j.j2));
      link2.current.rotation.y = -j.j2;
    }
    if (wrist.current) wrist.current.position.set(2 * L * Math.cos(j.j2), -0.004 + e * 0.4, 0);
    if (wafer.current) wafer.current.visible = showWafer && ctrl.waferLoc === 'effector';
    if (wafer.current) wafer.current.position.x = ROBOT_GEOM.Le - ctrl.slip;
  });

  return (
    <group position={position}>
      <Clickable sel={{ kind: 'robot', id: 'wafer-robot', label: 'Atmospheric wafer robot' }}>
        {/* fixed base */}
        <C r={0.13} h={0.36} m={view === 'xray' ? XRAY : M.panel} position={[0, -0.27, 0]} />
        <C r={0.14} h={0.03} m={M.steelDark} position={[0, -0.45, 0]} />
        {/* Z motor + ball screw (visible in x-ray) */}
        <C r={0.035} h={0.12} m={motorMat} position={[0.06, -0.36, 0.05]} />
        <C r={0.008} h={0.36} m={M.steel} position={[0.06, -0.2, 0.05]} />
        <mesh ref={column} geometry={GEO.cyl} material={M.brushed} />
        <group ref={lift}>
          <group ref={rot}>
            {/* shoulder hub with θ motor */}
            <C r={0.085} h={0.05} m={coverMat} position={[0, -0.095, 0]} />
            <C r={0.04} h={0.07} m={motorMat} position={[0, -0.13, 0]} />
            <group ref={link1}>
              <B s={[L, 0.03, 0.08]} m={coverMat} position={[L / 2, 0, 0]} />
              <C r={0.04} h={0.034} m={coverMat} position={[0, 0, 0]} />
              <C r={0.04} h={0.034} m={coverMat} position={[L, 0, 0]} />
              {/* internal belt drive to elbow (x-ray) */}
              <B s={[L, 0.006, 0.05]} m={beltMat} position={[L / 2, 0, 0]} />
            </group>
            <group ref={link2}>
              <B s={[L, 0.028, 0.07]} m={coverMat} position={[L / 2, 0, 0]} />
              <C r={0.036} h={0.032} m={coverMat} position={[0, 0, 0]} />
              <C r={0.032} h={0.03} m={coverMat} position={[L, 0, 0]} />
              <B s={[L, 0.006, 0.045]} m={beltMat} position={[L / 2, 0, 0]} />
            </group>
            <group ref={wrist}>
              <C r={0.03} h={0.022} m={M.steelDark} position={[0, -0.012, 0]} />
              {/* ceramic blade (end effector) */}
              <B s={[0.24, 0.0035, 0.07]} m={bladeMat} position={[0.14, 0, 0]} />
              <B s={[0.1, 0.0035, 0.025]} m={bladeMat} position={[0.29, 0, 0.03]} />
              <B s={[0.1, 0.0035, 0.025]} m={bladeMat} position={[0.29, 0, -0.03]} />
              {[0.12, 0.27, 0.27].map((x, i) => (
                <C key={i} r={0.008} h={0.0042} m={padMat} position={[x, 0.0004, i === 0 ? 0 : i === 1 ? 0.03 : -0.03]} />
              ))}
              {/* wafer presence sensor */}
              <B s={[0.012, 0.008, 0.012]} m={motorMat} position={[0.05, 0.005, 0.03]} />
              <Wafer ref={wafer} surface="polished" position={[ROBOT_GEOM.Le, 0.0025, 0]} />
            </group>
          </group>
        </group>
      </Clickable>
      <RobotLabels ctrl={ctrl} />
    </group>
  );
}

function RobotLabels({ ctrl }: { ctrl: RobotController }) {
  return (
    <>
      <TechLabel
        position={[0, -0.05, 0.22]}
        title="WAFER ROBOT · SIMULATION"
        min={3}
        value={() => {
          const j = ctrl.joints();
          return `θ ${fmt(deg(j.j1), 1)}°  J2 ${fmt(deg(j.j2), 1)}°  J3 ${fmt(deg(j.j3), 1)}°  Z ${fmt(ctrl.q[2] * 1000, 0)} mm`;
        }}
      />
      <TechLabel
        position={[0, 0.25, -0.3]}
        title="END EFFECTOR"
        min={3}
        value={() => {
          const p = ctrl.effector();
          return `X ${fmt(p.x * 1000, 0)} Y ${fmt(p.y * 1000, 0)} Z ${fmt(p.z * 1000, 0)} mm · ${fmt(ctrl.speed() * 1000, 0)} mm/s · VAC ${fmt(ctrl.vacuumKPa, 0)} kPa · ${ctrl.error ?? ctrl.stepLabel}`;
        }}
      />
    </>
  );
}
