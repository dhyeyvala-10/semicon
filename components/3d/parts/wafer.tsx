'use client';
/**
 * Wafer (300 mm, notch-oriented), FOUP carrier and wafer-material helpers.
 */
import * as THREE from 'three';
import { forwardRef, useMemo, useEffect } from 'react';
import type { ThreeElements } from '@react-three/fiber';
import type { WaferSurface } from '@/types';
import { M } from '../materials';
import { oxideColor } from '@/simulation/models';
import { B, C } from './primitives';

export const WAFER_R = 0.15;
export const WAFER_T = 0.000775;

const geoCache = new Map<string, THREE.BufferGeometry>();

/** Disc with a V-notch at −Z (6 o'clock when viewed from above), UVs mapped 0..1 over the face. */
export function waferGeometry(radius = WAFER_R, thickness = WAFER_T, notch = true): THREE.BufferGeometry {
  const key = `${radius}:${thickness}:${notch}`;
  const hit = geoCache.get(key);
  if (hit) return hit;
  const shape = new THREE.Shape();
  const N = 160;
  const nW = notch ? 0.012 * (radius / WAFER_R) : 0; // half-angle in radians-ish
  const start = -Math.PI / 2 + nW;
  const end = -Math.PI / 2 + Math.PI * 2 - nW;
  shape.moveTo(Math.cos(start) * radius, Math.sin(start) * radius);
  for (let i = 1; i <= N; i++) {
    const a = start + ((end - start) * i) / N;
    shape.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
  }
  if (notch) shape.lineTo(0, -radius + 0.0035 * (radius / WAFER_R));
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -thickness / 2);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) / radius + 1) / 2, (-pos.getZ(i) / radius + 1) / 2);
  uv.needsUpdate = true;
  g.computeVertexNormals();
  geoCache.set(key, g);
  return g;
}

/** Build a wafer top material for a surface state (and optional texture). */
export function waferMaterial(surface: WaferSurface, opts: { map?: THREE.Texture | null; oxideNm?: number } = {}): THREE.Material {
  const map = opts.map ?? null;
  switch (surface) {
    case 'none':
    case 'as-cut':
      return new THREE.MeshStandardMaterial({ color: '#70757b', roughness: 0.82, metalness: 0.45 });
    case 'ground':
    case 'lapped':
      return new THREE.MeshStandardMaterial({ color: '#8a8f95', roughness: 0.62, metalness: 0.5 });
    case 'etched':
      return new THREE.MeshStandardMaterial({ color: '#8d939a', roughness: 0.38, metalness: 0.7 });
    case 'polished':
    case 'planarized':
      return new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.06, metalness: 0.93, map });
    case 'oxide': {
      const [r, g, b] = oxideColor(opts.oxideNm ?? 100);
      return new THREE.MeshPhysicalMaterial({ color: new THREE.Color(r, g, b), roughness: 0.08, metalness: 0.55, clearcoat: 1, clearcoatRoughness: 0.05 });
    }
    case 'film':
      return new THREE.MeshPhysicalMaterial({ color: '#a8946a', roughness: 0.12, metalness: 0.45, clearcoat: 0.8, map });
    case 'resist':
    case 'exposed':
      return new THREE.MeshPhysicalMaterial({ color: map ? '#ffffff' : '#a6582a', roughness: 0.18, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.08, map });
    default:
      return new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.16, metalness: 0.55, clearcoat: 0.6, map });
  }
}

type WaferProps = Omit<ThreeElements['mesh'], 'material'> & {
  surface?: WaferSurface;
  map?: THREE.Texture | null;
  oxideNm?: number;
  material?: THREE.Material;
  radius?: number;
  thickness?: number;
};

/** A single wafer. Pass `material` to control it externally (animated surfaces). */
export const Wafer = forwardRef<THREE.Mesh, WaferProps>(function Wafer({ surface = 'polished', map, oxideNm, material, radius = WAFER_R, thickness = WAFER_T, ...rest }, ref) {
  const geo = useMemo(() => waferGeometry(radius, thickness), [radius, thickness]);
  const mat = useMemo(() => material ?? waferMaterial(surface, { map, oxideNm }), [material, surface, map, oxideNm]);
  useEffect(() => () => {
    if (!material) mat.dispose();
  }, [mat, material]);
  return <mesh ref={ref} geometry={geo} material={mat} castShadow receiveShadow {...rest} />;
});

/* ----------------------------- FOUP ----------------------------- */

export const FOUP_DIM = { w: 0.39, h: 0.33, d: 0.34 };
const SLOT_PITCH = 0.01;
const foupWaferMat = new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.08, metalness: 0.9 });

/**
 * FOUP (front-opening unified pod) — 25 slots, front door (+X), OHT flange on top.
 * Local origin: bottom centre. `door` 0 closed … 1 removed. `slots` = which slots hold wafers.
 */
export function FOUP({ door = 0, slots = 25, hideSlot, ...rest }: ThreeElements['group'] & { door?: number; slots?: number; hideSlot?: number }) {
  const { w, h, d } = FOUP_DIM;
  const inst = useMemo(() => {
    const m = new THREE.InstancedMesh(waferGeometry(), foupWaferMat, 25);
    m.castShadow = false;
    return m;
  }, []);
  useEffect(() => {
    const o = new THREE.Object3D();
    for (let i = 0; i < 25; i++) {
      const visible = i < slots && i + 1 !== hideSlot;
      o.position.set(0.0, 0.05 + i * SLOT_PITCH, 0);
      o.scale.setScalar(visible ? 1 : 0.0001);
      o.updateMatrix();
      inst.setMatrixAt(i, o.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
  }, [inst, slots, hideSlot]);
  return (
    <group {...rest}>
      {/* shell: back, sides, top, bottom */}
      <B s={[0.012, h, d]} m={M.foupShell} position={[-w / 2, h / 2, 0]} shadow={false} />
      <B s={[w, h, 0.012]} m={M.foupShell} position={[0, h / 2, -d / 2]} shadow={false} />
      <B s={[w, h, 0.012]} m={M.foupShell} position={[0, h / 2, d / 2]} shadow={false} />
      <B s={[w, 0.014, d]} m={M.foupDark} position={[0, h - 0.007, 0]} />
      <B s={[w, 0.02, d]} m={M.foupDark} position={[0, 0.01, 0]} />
      {/* OHT handling flange */}
      <B s={[0.05, 0.03, 0.05]} m={M.foupDark} position={[0, h + 0.015, 0]} />
      <B s={[0.2, 0.012, 0.2]} m={M.foupDark} position={[0, h + 0.036, 0]} />
      {/* side handles */}
      <B s={[0.12, 0.03, 0.02]} m={M.foupDark} position={[0, h * 0.6, d / 2 + 0.012]} />
      <B s={[0.12, 0.03, 0.02]} m={M.foupDark} position={[0, h * 0.6, -d / 2 - 0.012]} />
      {/* wafer slots (comb ribs) */}
      <B s={[w * 0.6, h * 0.86, 0.01]} m={M.plastic} position={[-0.02, h * 0.47, d / 2 - 0.02]} shadow={false} />
      <B s={[w * 0.6, h * 0.86, 0.01]} m={M.plastic} position={[-0.02, h * 0.47, -d / 2 + 0.02]} shadow={false} />
      <primitive object={inst} />
      {/* front door */}
      <group position={[w / 2 + 0.008 + door * 0.06, h / 2 - door * 0.33, 0]} visible={door < 0.999}>
        <B s={[0.018, h * 0.96, d * 0.98]} m={M.foupDark} />
        <B s={[0.01, 0.05, 0.1]} m={M.panelGrey} position={[0.012, 0.05, 0.08]} />
        <B s={[0.01, 0.05, 0.1]} m={M.panelGrey} position={[0.012, 0.05, -0.08]} />
      </group>
    </group>
  );
}

export function FoupSlotY(slot: number) {
  return 0.05 + (slot - 1) * SLOT_PITCH;
}

/** Simple load port: platform at 0.9 m with kinematic pins and FIMS door plate. */
export function LoadPort({ position, rotation }: { position?: [number, number, number]; rotation?: [number, number, number] }) {
  return (
    <group position={position} rotation={rotation}>
      <B s={[0.5, 0.9, 0.48]} m={M.panel} position={[0, 0.45, 0]} />
      <B s={[0.46, 0.03, 0.44]} m={M.steelDark} position={[0, 0.885, 0]} />
      {[[-0.12, -0.12], [0.12, -0.12], [0, 0.14]].map(([x, z], i) => (
        <C key={i} r={0.008} h={0.012} m={M.steel} position={[x, 0.906, z]} />
      ))}
      <B s={[0.06, 0.12, 0.4]} m={M.panelGrey} position={[0.22, 0.8, 0]} />
    </group>
  );
}
