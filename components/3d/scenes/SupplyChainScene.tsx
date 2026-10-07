'use client';
/**
 * The industrial ecosystem behind one fab (§56, §57): a layered dependency graph from raw
 * materials and base industries, through subsystems, equipment and materials, to the fab,
 * assembly & test and the system makers — and back (tools are full of chips). Click a node
 * to light up everything it depends on and everything that depends on it.
 * Node names are generic categories, not companies.
 */
import * as THREE from 'three';
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { Lighting, VoidBackdrop } from '../environments';
import { GEO } from '../parts/primitives';
import { Clickable, TechLabel } from '../parts/interaction';
import { engine } from '@/simulation/engine';
import { track, gradeState } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { SUPPLY_NODES, SUPPLY_EDGES, type SupplyNode } from '@/data/supplychain';
import type { V3 } from '../parts/primitives';

const TIER_X: Record<number, number> = { 3: -15, 2: -8.5, 1: -2, 0: 4.5, [-1]: 9.5, [-2]: 14.5 };
const GROUP_COLOR: Record<SupplyNode['group'], string> = {
  fab: '#e8c84a',
  equipment: '#9fd18a',
  materials: '#c9b46a',
  subsystem: '#7fbf9a',
  base: '#a9a48a',
  downstream: '#d8e2a0',
};

function layout() {
  const pos: Record<string, THREE.Vector3> = {};
  const tiers = new Map<number, SupplyNode[]>();
  for (const n of SUPPLY_NODES) tiers.set(n.tier, [...(tiers.get(n.tier) ?? []), n]);
  for (const [t, ns] of tiers) {
    ns.forEach((n, i) => {
      const y = 1.5 + (i - (ns.length - 1) / 2) * 1.75;
      pos[n.id] = new THREE.Vector3(TIER_X[t], y, ((i % 3) - 1) * 0.8);
    });
  }
  return pos;
}

/** all nodes reachable upstream (suppliers) and downstream (consumers) of `id` */
function related(id: string) {
  const up = new Set<string>();
  const down = new Set<string>();
  const walk = (k: string, dir: 'up' | 'down', seen: Set<string>) => {
    for (const e of SUPPLY_EDGES) {
      const next = dir === 'up' ? (e.to === k ? e.from : null) : e.from === k ? e.to : null;
      if (next && !seen.has(next)) {
        seen.add(next);
        walk(next, dir, seen);
      }
    }
  };
  walk(id, 'up', up);
  walk(id, 'down', down);
  return { up, down };
}

function edgeCurve(a: THREE.Vector3, b: THREE.Vector3): V3[] {
  const loop = b.x < a.x; // feedback edge (chips for tools)
  const mid = a.clone().lerp(b, 0.5).add(new THREE.Vector3(0, loop ? -9 : 0.6, loop ? 4 : 0));
  const c = new THREE.QuadraticBezierCurve3(a, mid, b);
  return c.getPoints(loop ? 48 : 20).map((p) => p.toArray() as V3);
}

export default function SupplyChainScene() {
  const pos = useMemo(() => layout(), []);
  const sel = useUI((s) => s.selection);
  const focus = sel?.kind === 'node' ? sel.id : null;
  const rel = useMemo(() => (focus ? related(focus) : null), [focus]);
  const edges = useMemo(() => SUPPLY_EDGES.map((e) => ({ ...e, pts: edgeCurve(pos[e.from], pos[e.to]) })), [pos]);
  const flow = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const flowMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#d9f29a', toneMapped: false }), []);
  useFrame(() => {
    flowMat.color.copy(gradeState.glow);
    if (!flow.current) return;
    const t = engine.time;
    edges.forEach((e, i) => {
      const on = !rel || (focus && (e.from === focus || e.to === focus || (rel.up.has(e.from) && (rel.up.has(e.to) || e.to === focus)) || (rel.down.has(e.to) && (rel.down.has(e.from) || e.from === focus))));
      for (let k = 0; k < 2; k++) {
        const u = (t * 0.25 + k * 0.5 + i * 0.137) % 1;
        const f = u * (e.pts.length - 1);
        const j = Math.min(e.pts.length - 2, Math.floor(f));
        const a = e.pts[j];
        const b = e.pts[j + 1];
        o.position.set(a[0] + (b[0] - a[0]) * (f - j), a[1] + (b[1] - a[1]) * (f - j), a[2] + (b[2] - a[2]) * (f - j));
        o.scale.setScalar(on ? 0.09 : 0);
        o.updateMatrix();
        flow.current!.setMatrixAt(i * 2 + k, o.matrix);
      }
    });
    flow.current.instanceMatrix.needsUpdate = true;
    track('focus', 0, 1, 0);
  });
  const lit = (id: string) => !rel || id === focus || rel.up.has(id) || rel.down.has(id);
  return (
    <>
      <Lighting env="void" shadowExtent={20} />
      <VoidBackdrop y={-8} size={80} color="#33402f" />
      {edges.map((e, i) => {
        const on = lit(e.from) && lit(e.to);
        return <Line key={i} points={e.pts} color={on ? '#9fbf6a' : '#3a4a3c'} lineWidth={on && rel ? 2 : 1} transparent opacity={on ? 0.75 : 0.25} />;
      })}
      <instancedMesh ref={flow} args={[GEO.sphereLow, flowMat, edges.length * 2]} frustumCulled={false} />
      {SUPPLY_NODES.map((n) => {
        const p = pos[n.id];
        const on = lit(n.id);
        const big = n.id === 'fab';
        return (
          <group key={n.id} position={p}>
            <Clickable sel={{ kind: 'node', id: n.id, label: n.label }}>
              <mesh scale={big ? 0.7 : 0.38}>
                <icosahedronGeometry args={[1, 1]} />
                <meshStandardMaterial color={GROUP_COLOR[n.group]} emissive={GROUP_COLOR[n.group]} emissiveIntensity={on ? (n.id === focus ? 0.9 : 0.35) : 0.02} roughness={0.5} transparent opacity={on ? 1 : 0.35} flatShading />
              </mesh>
            </Clickable>
            <TechLabel position={[0.45, 0.35, 0]} title={n.label} lines={[n.note]} min={1} />
          </group>
        );
      })}
      {[
        [3, 'BASE INDUSTRIES'],
        [2, 'SUBSYSTEMS & SPECIALTY'],
        [1, 'EQUIPMENT · MATERIALS · DESIGN'],
        [0, 'FAB'],
        [-1, 'ASSEMBLY & TEST'],
        [-2, 'SYSTEMS'],
      ].map(([t, label]) => (
        <TechLabel key={t as number} position={[TIER_X[t as number] - 1, -7.2, 0]} title={label as string} min={1} />
      ))}
      <TechLabel
        position={[-16, 11.5, 0]}
        title="ONE FAB · MANY INDUSTRIES"
        lines={['click a node to trace its dependencies', 'categories only — no company names · structure per SIA/BCG (2021)']}
        min={1}
      />
    </>
  );
}
