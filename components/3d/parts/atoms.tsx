'use client';
/**
 * Ball-and-stick atomic models for microscopic insets (§11): silica network,
 * diamond-cubic silicon, trichlorosilane. Instanced so large lattices stay cheap.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { GEO } from './primitives';

export type El = 'Si' | 'O' | 'C' | 'H' | 'Cl' | 'B' | 'P';
export const EL_COLOR: Record<El, string> = { Si: '#d9c29a', O: '#d9543f', C: '#3b3d3f', H: '#f2f2f2', Cl: '#5fbf4a', B: '#e8a0a0', P: '#e6a23a' };
export const EL_R: Record<El, number> = { Si: 0.16, O: 0.11, C: 0.12, H: 0.07, Cl: 0.15, B: 0.12, P: 0.14 };

export interface Atom {
  p: [number, number, number];
  el: El;
}

const bondMat = new THREE.MeshStandardMaterial({ color: '#9aa39a', roughness: 0.5, metalness: 0.2 });

export function AtomModel({ atoms, bonds, scale = 1, spin = 0.15, visibleFn }: { atoms: Atom[]; bonds: [number, number][]; scale?: number; spin?: number; visibleFn?: (i: number, a: Atom) => { visible: boolean; offset?: [number, number, number] } }) {
  const group = useRef<THREE.Group>(null);
  const byEl = useMemo(() => {
    const m = new Map<El, number[]>();
    atoms.forEach((a, i) => m.set(a.el, [...(m.get(a.el) ?? []), i]));
    return m;
  }, [atoms]);
  const meshes = useMemo(() => {
    const out = new Map<El, THREE.InstancedMesh>();
    for (const [el, idx] of byEl) {
      const mat = new THREE.MeshStandardMaterial({ color: EL_COLOR[el], roughness: 0.35, metalness: 0.1 });
      const m = new THREE.InstancedMesh(GEO.sphere, mat, idx.length);
      out.set(el, m);
    }
    return out;
  }, [byEl]);
  const bondMesh = useMemo(() => new THREE.InstancedMesh(GEO.cylLow, bondMat, Math.max(1, bonds.length)), [bonds.length]);
  const o = useMemo(() => new THREE.Object3D(), []);
  const pos = useMemo(() => atoms.map((a) => new THREE.Vector3(...a.p)), [atoms]);
  const vis = useRef<boolean[]>(atoms.map(() => true));

  const update = () => {
    for (const [el, idx] of byEl) {
      const m = meshes.get(el)!;
      idx.forEach((ai, k) => {
        const a = atoms[ai];
        const r = visibleFn?.(ai, a) ?? { visible: true };
        vis.current[ai] = r.visible;
        const p = pos[ai].set(a.p[0] + (r.offset?.[0] ?? 0), a.p[1] + (r.offset?.[1] ?? 0), a.p[2] + (r.offset?.[2] ?? 0));
        o.position.copy(p);
        o.rotation.set(0, 0, 0);
        o.scale.setScalar(r.visible ? EL_R[el] : 0.0001);
        o.updateMatrix();
        m.setMatrixAt(k, o.matrix);
      });
      m.instanceMatrix.needsUpdate = true;
    }
    const up = new THREE.Vector3(0, 1, 0);
    bonds.forEach(([i, j], k) => {
      const a = pos[i];
      const b = pos[j];
      const show = vis.current[i] && vis.current[j] && a.distanceTo(b) < 0.75;
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const dir = b.clone().sub(a);
      const len = dir.length();
      o.position.copy(mid);
      o.quaternion.setFromUnitVectors(up, dir.normalize());
      o.scale.set(show ? 0.035 : 0.0001, len, show ? 0.035 : 0.0001);
      o.updateMatrix();
      bondMesh.setMatrixAt(k, o.matrix);
    });
    bondMesh.instanceMatrix.needsUpdate = true;
  };
  useEffect(update); // eslint-disable-line react-hooks/exhaustive-deps
  useFrame((_, dt) => {
    if (group.current) group.current.rotation.y += dt * spin;
    if (visibleFn) update();
  });
  return (
    <group ref={group} scale={scale}>
      {Array.from(meshes.values()).map((m, i) => (
        <primitive key={i} object={m} />
      ))}
      <primitive object={bondMesh} />
    </group>
  );
}

/* ----------------------- structure generators ----------------------- */

/** Diamond-cubic silicon, n×n×n conventional cells, lattice constant a (model units). */
export function diamondLattice(n = 2, a = 1.0, el: El = 'Si'): { atoms: Atom[]; bonds: [number, number][] } {
  const basis = [
    [0, 0, 0],
    [0, 0.5, 0.5],
    [0.5, 0, 0.5],
    [0.5, 0.5, 0],
  ];
  const pts: [number, number, number][] = [];
  const key = new Set<string>();
  const push = (p: [number, number, number]) => {
    const k = p.map((v) => v.toFixed(3)).join(',');
    if (key.has(k)) return;
    key.add(k);
    pts.push(p);
  };
  for (let x = 0; x < n; x++)
    for (let y = 0; y < n; y++)
      for (let z = 0; z < n; z++)
        for (const b of basis) {
          push([(x + b[0]) * a, (y + b[1]) * a, (z + b[2]) * a]);
          push([(x + b[0] + 0.25) * a, (y + b[1] + 0.25) * a, (z + b[2] + 0.25) * a]);
        }
  const c = (n * a) / 2;
  const atoms: Atom[] = pts.map((p) => ({ p: [p[0] - c, p[1] - c, p[2] - c], el }));
  const bonds: [number, number][] = [];
  const d = (Math.sqrt(3) / 4) * a;
  for (let i = 0; i < atoms.length; i++)
    for (let j = i + 1; j < atoms.length; j++) {
      const [x1, y1, z1] = atoms[i].p;
      const [x2, y2, z2] = atoms[j].p;
      if (Math.abs(Math.hypot(x1 - x2, y1 - y2, z1 - z2) - d) < 0.02 * a) bonds.push([i, j]);
    }
  return { atoms, bonds };
}

/** Idealised silica network: Si on a diamond lattice, O between every Si–Si pair. */
export function silicaNetwork(n = 2, a = 1.4) {
  const si = diamondLattice(n, a, 'Si');
  const atoms: Atom[] = [...si.atoms];
  const bonds: [number, number][] = [];
  for (const [i, j] of si.bonds) {
    const p = si.atoms[i].p;
    const q = si.atoms[j].p;
    const mid: [number, number, number] = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2 + 0.05 * a, (p[2] + q[2]) / 2];
    atoms.push({ p: mid, el: 'O' });
    const k = atoms.length - 1;
    bonds.push([i, k], [k, j]);
  }
  return { atoms, bonds, siCount: si.atoms.length };
}

/** Trichlorosilane SiHCl₃: tetrahedral Si with one H and three Cl. */
export function tcsMolecule(r = 0.55) {
  const dirs = [
    [0, 1, 0],
    [0.943, -0.333, 0],
    [-0.471, -0.333, 0.816],
    [-0.471, -0.333, -0.816],
  ];
  const atoms: Atom[] = [{ p: [0, 0, 0], el: 'Si' }];
  dirs.forEach((d, i) => atoms.push({ p: [d[0] * r * (i === 0 ? 0.75 : 1.15), d[1] * r * (i === 0 ? 0.75 : 1.15), d[2] * r * (i === 0 ? 0.75 : 1.15)], el: i === 0 ? 'H' : 'Cl' }));
  return { atoms, bonds: [[0, 1], [0, 2], [0, 3], [0, 4]] as [number, number][] };
}
