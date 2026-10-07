'use client';
/**
 * Subfab infrastructure revealed under the raised floor (§53, §85, §86): utility
 * headers along the spine, branches under every bay, vertical drops to each tool,
 * pumps/abatement under the tools, and flow pulses showing direction.
 * Layout and flow rates are CONCEPTUAL.
 */
import * as THREE from 'three';
import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TOOLS, FAB, BAY_X } from '@/data/fabLayout';
import { GEO } from '../parts/primitives';
import { TechLabel, Clickable } from '../parts/interaction';
import { M } from '../materials';

export const UTILITY_STYLE: { key: string; label: string; color: string; y: number; r: number; dz: number }[] = [
  { key: 'electricity', label: 'ELECTRICITY · BUSWAY', color: '#d8b35a', y: -0.7, r: 0.09, dz: -2.2 },
  { key: 'water', label: 'ULTRAPURE WATER', color: '#8fc7c0', y: -1.1, r: 0.07, dz: -1.5 },
  { key: 'gases', label: 'PROCESS GASES', color: '#a7c76a', y: -1.45, r: 0.05, dz: -0.8 },
  { key: 'vacuum', label: 'VACUUM / FORELINE', color: '#9aa39a', y: -1.85, r: 0.1, dz: 0 },
  { key: 'cooling', label: 'PROCESS COOLING WATER', color: '#6fa98a', y: -2.25, r: 0.08, dz: 0.8 },
  { key: 'chemicals', label: 'CHEMICAL DELIVERY', color: '#b59ac8', y: -2.65, r: 0.05, dz: 1.5 },
  { key: 'waste', label: 'EXHAUST & WASTE', color: '#a8805a', y: -3.1, r: 0.14, dz: 2.2 },
];

function pipeBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const g = new THREE.BoxGeometry(Math.abs(dx) + r * 2, Math.abs(dy) + r * 2, Math.abs(dz) + r * 2);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

function UtilityNetwork({ u }: { u: (typeof UTILITY_STYLE)[number] }) {
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: u.color, roughness: 0.45, metalness: 0.5 }), [u.color]);
  const geo = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    // main header along the spine
    parts.push(pipeBox(FAB.minX + 1, u.y, u.dz, FAB.maxX - 1, u.y, u.dz, u.r));
    // bay branches
    for (const bx of BAY_X)
      for (const side of [1, -1]) {
        const x = bx + u.dz * 0.35;
        parts.push(pipeBox(x, u.y, u.dz, x, u.y, side * FAB.bayEnd, u.r * 0.7));
      }
    // drops to tools
    for (const t of TOOLS) {
      if (t.type === 'stocker' && u.key !== 'electricity') continue;
      const bx = BAY_X.reduce((a, b) => (Math.abs(b - t.x) < Math.abs(a - t.x) ? b : a), BAY_X[0]);
      const x = bx + u.dz * 0.35;
      const tx = t.x - Math.cos(t.rot) * 1.6;
      parts.push(pipeBox(x, u.y, t.z, tx, u.y, t.z, u.r * 0.45));
      parts.push(pipeBox(tx, u.y, t.z, tx, -0.05, t.z, u.r * 0.45));
    }
    return mergeGeometries(parts, false)!;
  }, [u]);
  // flow pulses travelling along the header and bay branches
  const N = 70;
  const pulses = useMemo(() => {
    const m = new THREE.InstancedMesh(GEO.sphereLow, new THREE.MeshBasicMaterial({ color: u.color, toneMapped: false }), N);
    m.frustumCulled = false;
    return m;
  }, [u.color]);
  const o = useMemo(() => new THREE.Object3D(), []);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const span = FAB.maxX - FAB.minX - 2;
    for (let i = 0; i < N; i++) {
      const dir = u.key === 'waste' ? -1 : 1;
      const s = ((t * 3 * dir + i * (span / N)) % span + span) % span;
      o.position.set(FAB.minX + 1 + s, u.y, u.dz);
      o.scale.setScalar(u.r * 1.3);
      o.updateMatrix();
      pulses.setMatrixAt(i, o.matrix);
    }
    pulses.instanceMatrix.needsUpdate = true;
  });
  return (
    <Clickable sel={{ kind: 'component', id: `u-${u.key}`, label: u.label }}>
      <mesh geometry={geo} material={mat} />
      <primitive object={pulses} />
      <TechLabel position={[FAB.minX + 2, u.y + 0.15, u.dz]} title={u.label} min={1} />
    </Clickable>
  );
}

export function FabInfrastructure() {
  const pumps = useMemo(() => {
    const m = new THREE.InstancedMesh(GEO.box, M.panelGrey, TOOLS.length);
    const o = new THREE.Object3D();
    TOOLS.forEach((t, i) => {
      o.position.set(t.x - Math.cos(t.rot) * 1.8, -4.5, t.z);
      o.scale.set(1.0, 1.0, Math.min(1.8, t.length * 0.5));
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
    return m;
  }, []);
  return (
    <group>
      {/* subfab slab */}
      <mesh rotation-x={-Math.PI / 2} position={[0, -5, 0]} material={M.concrete}>
        <planeGeometry args={[FAB.maxX - FAB.minX, FAB.maxZ - FAB.minZ]} />
      </mesh>
      <Clickable sel={{ kind: 'component', id: 'u-vacuum', label: 'Subfab pumps & abatement' }}>
        <primitive object={pumps} />
      </Clickable>
      {UTILITY_STYLE.map((u) => (
        <UtilityNetwork key={u.key} u={u} />
      ))}
      <TechLabel position={[0, -0.3, 6]} title="SUBFAB · UTILITY INFRASTRUCTURE (CONCEPTUAL LAYOUT)" min={1} tone="accent" />
    </group>
  );
}
