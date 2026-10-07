'use client';
/**
 * Cross-section building blocks (§62): extruded 2D profiles and magnified insets
 * that register their own physical scale with the scale bar.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import { scaleRegions } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { formatLength } from '@/lib/math';
import type { V3 } from './primitives';

/** Extrude a 2D polygon (x right, y up) along z by `depth`, centred on z. */
export function profileGeometry(points: [number, number][], depth: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 6 });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  return g;
}

/** A cross-section slab. Re-built only when `points` changes (quantise animated inputs). */
export function ProfileSlab({ points, depth, m, position, visible = true }: { points: [number, number][]; depth: number; m: THREE.Material; position?: V3; visible?: boolean }) {
  const key = points.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join(';');
  const geo = useMemo(() => profileGeometry(points, depth), [key, depth]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => geo.dispose(), [geo]);
  return <mesh geometry={geo} material={m} position={position} visible={visible} castShadow={false} receiveShadow />;
}

/**
 * A cross-section slab whose polygon is recomputed every frame from simulation state.
 * The geometry is rebuilt only when the (quantised) polygon actually changes.
 * `compute` returning null hides the slab.
 */
export function LiveProfile({ compute, depth, m, position }: { compute: () => [number, number][] | null; depth: number; m: THREE.Material | (() => THREE.Material); position?: V3 }) {
  const ref = useRef<THREE.Mesh>(null);
  const key = useRef('');
  useEffect(() => {
    const mesh = ref.current;
    return () => mesh?.geometry.dispose();
  }, []);
  useFrame(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const pts = compute();
    if (!pts || pts.length < 3) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    const k = pts.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join(';');
    if (k !== key.current) {
      key.current = k;
      const old = mesh.geometry;
      mesh.geometry = profileGeometry(pts, depth);
      old.dispose();
    }
    if (typeof m === 'function') mesh.material = m();
  });
  return <mesh ref={ref} material={typeof m === 'function' ? m() : m} position={position} receiveShadow />;
}

/** Rectangle helper for profile polygons. */
export const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

const frameMat = new THREE.MeshBasicMaterial({ color: '#0c110d', transparent: true, opacity: 0.84 });
const borderMat = new THREE.LineBasicMaterial({ color: '#a9c48a' });

/**
 * Magnified inset: a dark backplate + frame at `position`, a leader line to `anchor`,
 * a label with the represented field width, and a scale-region registration.
 * Children are drawn in inset-local units (1 unit = `mpu` metres).
 */
export function Inset({
  id,
  position,
  size = [1.2, 0.8],
  anchor,
  mpu,
  title,
  children,
  schematic = true,
  rotationY = 0,
  always = false,
}: {
  id: string;
  position: V3;
  size?: [number, number];
  anchor?: V3;
  mpu: number;
  title: string;
  children: ReactNode;
  schematic?: boolean;
  rotationY?: number;
  /** keep visible in factory / machine camera modes (default: hidden there to keep machine views clear) */
  always?: boolean;
}) {
  const info = useUI((s) => s.info);
  const cam = useUI((s) => s.cameraMode);
  const hidden = !always && (cam === 'factory' || cam === 'machine');
  useEffect(() => {
    scaleRegions.set(id, { id, center: new THREE.Vector3(...position), radius: Math.max(size[0], size[1]) * 0.9, mpu, label: schematic ? 'SCHEMATIC' : undefined });
    return () => {
      scaleRegions.delete(id);
    };
  }, [id, position, size, mpu, schematic]);
  const [w, h] = size;
  if (hidden) return null;
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh position={[0, 0, -0.02]} scale={[w, h, 1]} material={frameMat}>
        <planeGeometry />
      </mesh>
      <lineSegments position={[0, 0, -0.019]} material={borderMat}>
        <edgesGeometry args={[new THREE.PlaneGeometry(w, h)]} />
      </lineSegments>
      <group>{children}</group>
      {anchor && (
        <Line
          points={[
            [0, -h / 2, -0.02],
            [anchor[0] - position[0], anchor[1] - position[1], anchor[2] - position[2]],
          ]}
          color="#a9c48a"
          lineWidth={1}
          dashed
          dashSize={0.02}
          gapSize={0.015}
          transparent
          opacity={0.7}
        />
      )}
      {info >= 2 && (
        <Html position={[-w / 2, h / 2, 0]} style={{ pointerEvents: 'none' }} zIndexRange={[15, 0]}>
          <div className="inset-label">
            <span>{title}</span>
            <span className="inset-scale">FIELD ≈ {formatLength(w * mpu)}{schematic ? ' · SCHEMATIC' : ''}</span>
          </div>
        </Html>
      )}
    </group>
  );
}

/** Animated dashed flow line (gas/liquid/beam directions). */
export function FlowLine({ points, color = '#a9cf9a', speed = 0.6, width = 1.5, opacity = 0.8 }: { points: V3[]; color?: string; speed?: number; width?: number; opacity?: number }) {
  const ref = useRef<{ material: { dashOffset: number } } | null>(null);
  useFrame((_, dt) => {
    if (ref.current) ref.current.material.dashOffset -= dt * speed;
  });
  return (
    <Line
      ref={ref as never}
      points={points}
      color={color}
      lineWidth={width}
      dashed
      dashSize={0.05}
      gapSize={0.04}
      transparent
      opacity={opacity}
    />
  );
}
