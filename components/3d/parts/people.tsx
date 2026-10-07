'use client';
/**
 * Cleanroom operators in full gowning (coverall, hood, mask/visor, gloves, boots).
 * They walk along paths so the environment reads as a working facility.
 */
import * as THREE from 'three';
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { GEO } from './primitives';
import { Clickable } from './interaction';

const suit = new THREE.MeshStandardMaterial({ color: '#eef0f2', roughness: 0.85 });
const suitShade = new THREE.MeshStandardMaterial({ color: '#d5dade', roughness: 0.85 });
const visor = new THREE.MeshStandardMaterial({ color: '#1b2a33', roughness: 0.15, metalness: 0.4 });
const glove = new THREE.MeshStandardMaterial({ color: '#5d84b8', roughness: 0.6 });

export function Operator({ path, speed = 1.0, offset = 0, still = false, position, rotation = 0 }: { path?: [number, number][]; speed?: number; offset?: number; still?: boolean; position?: [number, number, number]; rotation?: number }) {
  const root = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const seg = useMemo(() => {
    if (!path) return null;
    const lens = path.map((p, i) => {
      const q = path[(i + 1) % path.length];
      return Math.hypot(q[0] - p[0], q[1] - p[1]);
    });
    return { lens, total: lens.reduce((a, b) => a + b, 0) };
  }, [path]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime + offset;
    if (root.current && path && seg && !still) {
      let s = (t * speed) % seg.total;
      let i = 0;
      while (s > seg.lens[i]) {
        s -= seg.lens[i];
        i = (i + 1) % path.length;
      }
      const a = path[i];
      const b = path[(i + 1) % path.length];
      const u = s / seg.lens[i];
      root.current.position.set(a[0] + (b[0] - a[0]) * u, 0, a[1] + (b[1] - a[1]) * u);
      const target = Math.atan2(b[0] - a[0], b[1] - a[1]);
      root.current.rotation.y = target;
    }
    const swing = still ? Math.sin(t * 0.8) * 0.05 : Math.sin(t * speed * 5.2) * 0.45;
    if (legL.current) legL.current.rotation.x = swing;
    if (legR.current) legR.current.rotation.x = -swing;
    if (armL.current) armL.current.rotation.x = -swing * 0.7;
    if (armR.current) armR.current.rotation.x = swing * 0.7 + (still ? -0.6 : 0);
  });
  return (
    <group ref={root} position={position} rotation={[0, rotation, 0]}>
      <Clickable sel={{ kind: 'component', id: 'operator', label: 'Cleanroom operator' }}>
        {/* torso */}
        <mesh geometry={GEO.cyl} material={suit} scale={[0.19, 0.6, 0.13]} position={[0, 1.18, 0]} castShadow />
        <mesh geometry={GEO.sphere} material={suit} scale={[0.2, 0.12, 0.14]} position={[0, 1.47, 0]} castShadow />
        {/* hood + visor */}
        <mesh geometry={GEO.sphere} material={suit} scale={[0.12, 0.14, 0.13]} position={[0, 1.66, 0]} castShadow />
        <mesh geometry={GEO.box} material={visor} scale={[0.15, 0.06, 0.04]} position={[0, 1.67, 0.105]} />
        <mesh geometry={GEO.box} material={suitShade} scale={[0.13, 0.05, 0.03]} position={[0, 1.6, 0.11]} />
        {/* legs */}
        <group ref={legL} position={[-0.08, 0.88, 0]}>
          <mesh geometry={GEO.cyl} material={suit} scale={[0.075, 0.8, 0.075]} position={[0, -0.42, 0]} castShadow />
          <mesh geometry={GEO.box} material={suitShade} scale={[0.1, 0.08, 0.2]} position={[0, -0.84, 0.03]} />
        </group>
        <group ref={legR} position={[0.08, 0.88, 0]}>
          <mesh geometry={GEO.cyl} material={suit} scale={[0.075, 0.8, 0.075]} position={[0, -0.42, 0]} castShadow />
          <mesh geometry={GEO.box} material={suitShade} scale={[0.1, 0.08, 0.2]} position={[0, -0.84, 0.03]} />
        </group>
        {/* arms */}
        <group ref={armL} position={[-0.23, 1.42, 0]}>
          <mesh geometry={GEO.cyl} material={suit} scale={[0.055, 0.56, 0.055]} position={[0, -0.28, 0]} castShadow />
          <mesh geometry={GEO.sphere} material={glove} scale={0.055} position={[0, -0.58, 0]} />
        </group>
        <group ref={armR} position={[0.23, 1.42, 0]}>
          <mesh geometry={GEO.cyl} material={suit} scale={[0.055, 0.56, 0.055]} position={[0, -0.28, 0]} castShadow />
          <mesh geometry={GEO.sphere} material={glove} scale={0.055} position={[0, -0.58, 0]} />
        </group>
      </Clickable>
    </group>
  );
}
