'use client';
/**
 * Subfab infrastructure revealed under the raised floor (§53, §85, §86): utility
 * headers along the spine, branches under every bay, vertical drops to each tool,
 * pumps/abatement under the tools, and flow pulses showing direction.
 * Layout and flow rates are CONCEPTUAL.
 *
 * Detail level: round process piping (rectangular busway), flanged joints, a trapeze
 * pipe rack along the spine, and one dry-pump + abatement skid per tool (instanced).
 */
import * as THREE from 'three';
import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TOOLS, FAB, BAY_X } from '@/data/fabLayout';
import { TechLabel, Clickable } from '../parts/interaction';
import { M } from '../materials';
import { Kit } from '../kit/build';
import { KM } from '../kit/finish';
import { Baked, useKit } from '../kit/Baked';
import { FM, rbGeo } from './toolModels';

export const UTILITY_STYLE: { key: string; label: string; color: string; y: number; r: number; dz: number }[] = [
  { key: 'electricity', label: 'ELECTRICITY · BUSWAY', color: '#d8b35a', y: -0.7, r: 0.09, dz: -2.2 },
  { key: 'water', label: 'ULTRAPURE WATER', color: '#8fc7c0', y: -1.1, r: 0.07, dz: -1.5 },
  { key: 'gases', label: 'PROCESS GASES', color: '#a7c76a', y: -1.45, r: 0.05, dz: -0.8 },
  { key: 'vacuum', label: 'VACUUM / FORELINE', color: '#9aa39a', y: -1.85, r: 0.1, dz: 0 },
  { key: 'cooling', label: 'PROCESS COOLING WATER', color: '#6fa98a', y: -2.25, r: 0.08, dz: 0.8 },
  { key: 'chemicals', label: 'CHEMICAL DELIVERY', color: '#b59ac8', y: -2.65, r: 0.05, dz: 1.5 },
  { key: 'waste', label: 'EXHAUST & WASTE', color: '#a8805a', y: -3.1, r: 0.14, dz: 2.2 },
];

/** flow pulse: 80-triangle sphere (490 pulses are on screen at once) */
const PULSE = new THREE.IcosahedronGeometry(1, 1);

const _q = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** Straight run between two points: round pipe (or rectangular busway / duct). */
function run(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, square: boolean) {
  _a.set(x0, y0, z0);
  _b.set(x1, y1, z1);
  const len = _a.distanceTo(_b) + r * 2;
  const g = square ? new THREE.BoxGeometry(r * 2.4, len, r * 1.6) : new THREE.CylinderGeometry(r, r, len, 10, 1, true);
  _q.setFromUnitVectors(_up, _b.clone().sub(_a).normalize());
  g.applyQuaternion(_q);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g.index ? g.toNonIndexed() : g;
}

/** Flange ring at a point, perpendicular to the given axis. */
function flangeAt(x: number, y: number, z: number, r: number, axis: 'x' | 'y' | 'z') {
  const g = new THREE.CylinderGeometry(r * 1.35, r * 1.35, r * 0.5, 10);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g.toNonIndexed();
}

function UtilityNetwork({ u }: { u: (typeof UTILITY_STYLE)[number] }) {
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: u.color, roughness: 0.45, metalness: 0.5 }), [u.color]);
  const geo = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    const sq = u.key === 'electricity';
    // main header along the spine, flanged every 6 m
    parts.push(run(FAB.minX + 1, u.y, u.dz, FAB.maxX - 1, u.y, u.dz, u.r, sq));
    if (!sq) for (let x = FAB.minX + 4; x < FAB.maxX - 2; x += 6) parts.push(flangeAt(x, u.y, u.dz, u.r, 'x'));
    // bay branches
    for (const bx of BAY_X)
      for (const side of [1, -1]) {
        const x = bx + u.dz * 0.35;
        parts.push(run(x, u.y, u.dz, x, u.y, side * FAB.bayEnd, u.r * 0.7, sq));
        if (!sq) parts.push(flangeAt(x, u.y, u.dz + side * 0.5, u.r * 0.7, 'z'));
      }
    // drops to tools
    for (const t of TOOLS) {
      if (t.type === 'stocker' && u.key !== 'electricity') continue;
      const bx = BAY_X.reduce((a, b) => (Math.abs(b - t.x) < Math.abs(a - t.x) ? b : a), BAY_X[0]);
      const x = bx + u.dz * 0.35;
      const tx = t.x - Math.cos(t.rot) * 1.6;
      parts.push(run(x, u.y, t.z, tx, u.y, t.z, u.r * 0.45, sq));
      parts.push(run(tx, u.y, t.z, tx, -0.05, t.z, u.r * 0.45, sq));
      if (!sq) parts.push(flangeAt(tx, -0.25, t.z, u.r * 0.45, 'y'));
    }
    const g = mergeGeometries(parts, false)!;
    parts.forEach((p) => p.dispose());
    return g;
  }, [u]);
  useEffect(() => () => geo.dispose(), [geo]);
  // flow pulses travelling along the header and bay branches
  const N = 70;
  const pulses = useMemo(() => {
    const m = new THREE.InstancedMesh(PULSE, new THREE.MeshBasicMaterial({ color: u.color, toneMapped: false }), N);
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

/** Trapeze pipe rack along the spine and the raised-floor pedestal grid edge. */
function buildRack(k: Kit) {
  const nc = { cast: false };
  const levels = UTILITY_STYLE.map((u) => u.y - u.r - 0.03);
  for (let x = FAB.minX + 3; x < FAB.maxX - 2; x += 6) {
    for (const z of [-2.7, 2.7]) k.box(KM.paintGraphite, [0.05, 4.95, 0.05], [x, -2.525, z], [0, 0, 0], nc);
    for (const y of levels) k.box(KM.paintGraphite, [0.06, 0.04, 5.45], [x, y, 0], [0, 0, 0], nc);
    for (const z of [-2.7, 2.7]) k.box(FM.steel, [0.22, 0.012, 0.22], [x, -4.994, z], [0, 0, 0], nc);
  }
  // raised-floor pedestals and stringers under the spine
  for (let x = FAB.minX + 0.6; x < FAB.maxX; x += 2.4)
    for (const z of [-3.0, 3.0]) {
      k.cyl(FM.steel, 0.025, 0.55, [x, -0.31, z], [0, 0, 0], 6, nc);
      k.box(FM.steelDark, [0.12, 0.012, 0.12], [x, -0.03, z], [0, 0, 0], nc);
    }
  for (const z of [-3.0, 3.0]) k.box(FM.aluDark, [FAB.maxX - FAB.minX - 1, 0.03, 0.03], [0, -0.05, z], [0, 0, 0], nc);
}

/** Dry pump + abatement skid (local: +X toward the tool's aisle), low-poly for 66 instances. */
function buildPumpParts() {
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const k = new Kit();
  const nc = { cast: false };
  // dry pump: blue body on a kick plate, grille, plate, motor, foreline with flange
  k.box(KM.paintGraphite, [0.58, 0.08, 0.9], [0, 0.04, 0]);
  k.add(KM.paintBlue, rbGeo(0.62, 0.68, 0.95, 0.02), [0, 0.42, 0]);
  k.box(KM.seam, [0.003, 0.2, 0.5], [0.311, 0.36, 0], [0, 0, 0], nc);
  for (let i = 0; i < 5; i++) k.box(KM.paintGraphite, [0.008, 0.012, 0.48], [0.315, 0.28 + i * 0.04, 0], [0, 0, 0.5], nc);
  k.at([0.312, 0.62, 0], Math.PI / 2, () => k.label('model', 'DP-80', 'DRY PUMP · N₂ PURGE', 0.26, 0.065, [0, 0, 0]));
  k.cyl(FM.alu, 0.14, 0.45, [0, 0.9, 0], [Math.PI / 2, 0, 0], 12);
  k.cyl(FM.steel, 0.05, 0.6, [0.15, 1.05, 0.2], [0, 0, 0], 8);
  k.cyl(FM.steel, 0.075, 0.03, [0.15, 1.36, 0.2], [0, 0, 0], 8, nc);
  // point-of-use abatement beside it: cabinet, hazard stripe, warning, exhaust stack
  k.box(KM.paintGraphite, [0.56, 0.08, 0.66], [-0.85, 0.04, 0]);
  k.add(KM.paint, rbGeo(0.6, 1.07, 0.7, 0.02), [-0.85, 0.615, 0]);
  k.box(KM.paintYellow, [0.003, 0.03, 0.66], [-0.549, 1.05, 0], [0, 0, 0], nc);
  k.box(KM.seam, [0.003, 0.004, 0.66], [-0.549, 0.5, 0], [0, 0, 0], nc);
  k.at([-0.548, 0.85, 0.2], Math.PI / 2, () => k.label('warn', 'TOXIC GAS', '', 0.1, 0.1, [0, 0, 0]));
  k.cyl(FM.steel, 0.06, 0.55, [-0.85, 1.42, 0], [0, 0, 0], 8);
  k.ao(1.9, 0.9, [-0.4, 0, 0], 1.2);
  for (const p of k.build()) {
    const arr = byMat.get(p.material) ?? [];
    arr.push(p.geometry);
    byMat.set(p.material, arr);
  }
  return [...byMat.entries()].map(([material, geos]) => {
    const geometry = geos.length === 1 ? geos[0] : mergeGeometries(geos, false)!;
    if (geos.length > 1) geos.forEach((g) => g.dispose());
    return { material, geometry };
  });
}

export function FabInfrastructure() {
  const pumps = useMemo(() => {
    const parts = buildPumpParts();
    const o = new THREE.Object3D();
    return parts.map(({ material, geometry }) => {
      const m = new THREE.InstancedMesh(geometry, material, TOOLS.length);
      TOOLS.forEach((t, i) => {
        o.position.set(t.x - Math.cos(t.rot) * 1.8, -5, t.z);
        o.rotation.set(0, t.rot, 0);
        o.updateMatrix();
        m.setMatrixAt(i, o.matrix);
      });
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
      m.receiveShadow = true;
      return m;
    });
  }, []);
  useEffect(() => () => pumps.forEach((m) => m.geometry.dispose()), [pumps]);
  const rack = useKit(buildRack);
  return (
    <group>
      {/* subfab slab */}
      <mesh rotation-x={-Math.PI / 2} position={[0, -5, 0]} material={M.concrete}>
        <planeGeometry args={[FAB.maxX - FAB.minX, FAB.maxZ - FAB.minZ]} />
      </mesh>
      <Clickable sel={{ kind: 'component', id: 'u-vacuum', label: 'Subfab pumps & abatement' }}>
        {pumps.map((m, i) => (
          <primitive key={i} object={m} />
        ))}
      </Clickable>
      <Baked parts={rack} />
      {UTILITY_STYLE.map((u) => (
        <UtilityNetwork key={u.key} u={u} />
      ))}
      <TechLabel position={[0, -0.3, 6]} title="SUBFAB · UTILITY INFRASTRUCTURE (CONCEPTUAL LAYOUT)" min={1} tone="accent" />
    </group>
  );
}
