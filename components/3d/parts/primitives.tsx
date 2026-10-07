'use client';
/**
 * Geometry primitives backed by shared unit geometries (one GPU buffer, many meshes).
 */
import * as THREE from 'three';
import { forwardRef, useMemo, type ReactNode } from 'react';
import type { ThreeElements } from '@react-three/fiber';

export type V3 = [number, number, number];

export const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 40, 1),
  cylLow: new THREE.CylinderGeometry(1, 1, 1, 16, 1),
  cylOpen: new THREE.CylinderGeometry(1, 1, 1, 48, 1, true),
  sphere: new THREE.SphereGeometry(1, 24, 16),
  sphereLow: new THREE.SphereGeometry(1, 10, 8),
  torus: new THREE.TorusGeometry(1, 0.08, 10, 48),
  plane: new THREE.PlaneGeometry(1, 1),
  cone: new THREE.ConeGeometry(1, 1, 32, 1, true),
  disc: new THREE.CircleGeometry(1, 64),
};

type MeshProps = Omit<ThreeElements['mesh'], 'scale' | 'ref'> & { m: THREE.Material; shadow?: boolean };

/** Box with size s = [w, h, d]. */
export const B = forwardRef<THREE.Mesh, MeshProps & { s: V3 }>(function B({ s, m, shadow = true, ...rest }, ref) {
  return <mesh ref={ref} geometry={GEO.box} scale={s} material={m} castShadow={shadow} receiveShadow {...rest} />;
});

/** Cylinder (axis Y) radius r, height h. */
export const C = forwardRef<THREE.Mesh, MeshProps & { r: number; h: number; low?: boolean; open?: boolean }>(function C(
  { r, h, m, low, open, shadow = true, ...rest },
  ref,
) {
  return <mesh ref={ref} geometry={open ? GEO.cylOpen : low ? GEO.cylLow : GEO.cyl} scale={[r, h, r]} material={m} castShadow={shadow} receiveShadow {...rest} />;
});

/** Sphere radius r. */
export const S = forwardRef<THREE.Mesh, MeshProps & { r: number; low?: boolean }>(function S({ r, m, low, shadow = false, ...rest }, ref) {
  return <mesh ref={ref} geometry={low ? GEO.sphereLow : GEO.sphere} scale={r} material={m} castShadow={shadow} {...rest} />;
});

/** Horizontal cylinder along X. */
export function CX(props: MeshProps & { r: number; h: number; low?: boolean }) {
  return <C {...props} rotation={[0, 0, Math.PI / 2]} />;
}
/** Horizontal cylinder along Z. */
export function CZ(props: MeshProps & { r: number; h: number; low?: boolean }) {
  return <C {...props} rotation={[Math.PI / 2, 0, 0]} />;
}

/** Tube through points (pipes, cables, rails). */
export function Tube({ points, radius, m, closed = false, segments, radial = 8, shadow = false }: { points: V3[]; radius: number; m: THREE.Material; closed?: boolean; segments?: number; radial?: number; shadow?: boolean }) {
  const geo = useMemo(() => {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), closed, 'catmullrom', 0.05);
    return new THREE.TubeGeometry(curve, segments ?? Math.max(8, points.length * 12), radius, radial, closed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(points), radius, closed, segments, radial]);
  return <mesh geometry={geo} material={m} castShadow={shadow} />;
}

/** Orthogonal pipe run with rounded bends (polyline → tube). */
export function Pipe({ points, radius, m, bend = 0.15 }: { points: V3[]; radius: number; m: THREE.Material; bend?: number }) {
  const geo = useMemo(() => {
    const path = new THREE.CurvePath<THREE.Vector3>();
    const v = points.map((p) => new THREE.Vector3(...p));
    let prev = v[0].clone();
    for (let i = 1; i < v.length; i++) {
      const a = v[i];
      if (i < v.length - 1) {
        const inDir = a.clone().sub(v[i - 1]).normalize();
        const outDir = v[i + 1].clone().sub(a).normalize();
        const r = Math.min(bend, a.distanceTo(v[i - 1]) / 2, a.distanceTo(v[i + 1]) / 2);
        const p1 = a.clone().addScaledVector(inDir, -r);
        const p2 = a.clone().addScaledVector(outDir, r);
        path.add(new THREE.LineCurve3(prev, p1));
        path.add(new THREE.QuadraticBezierCurve3(p1, a.clone(), p2));
        prev = p2;
      } else path.add(new THREE.LineCurve3(prev, a));
    }
    return new THREE.TubeGeometry(path as unknown as THREE.Curve<THREE.Vector3>, Math.max(16, v.length * 10), radius, 8, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(points), radius, bend]);
  return <mesh geometry={geo} material={m} />;
}

/** Hanging cable between two points (catenary approximation). */
export function Cable({ a, b, sag = 0.15, radius = 0.012, m }: { a: V3; b: V3; sag?: number; radius?: number; m: THREE.Material }) {
  const pts = useMemo(() => {
    const out: V3[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t]);
    }
    return out;
  }, [a, b, sag]);
  return <Tube points={pts} radius={radius} m={m} segments={24} radial={6} />;
}

/** Bolt / screw heads along a panel edge, for mechanical detail. */
export function Bolts({ from, to, n, m, r = 0.008 }: { from: V3; to: V3; n: number; m: THREE.Material; r?: number }) {
  const items = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    items.push(
      <C key={i} r={r} h={r * 0.8} m={m} shadow={false} position={[from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t]} rotation={[Math.PI / 2, 0, 0]} low />,
    );
  }
  return <>{items}</>;
}

export function Group({ children, ...rest }: ThreeElements['group'] & { children?: ReactNode }) {
  return <group {...rest}>{children}</group>;
}
