'use client';
/**
 * Lighting rigs and reusable architectural environments.
 * Reflections come from a locally generated environment map (Lightformers) — no HDR
 * download, so the experience works fully offline.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import type { SceneConfig } from '@/types';
import { M } from './materials';
import { floorTile, ffuPanel, concrete, plainTile } from './textures';
import { B, C, GEO } from './parts/primitives';
import { useUI } from '@/lib/store';
import { gradeState } from '@/lib/runtime';

type Env = SceneConfig['environment'];

const ENV: Record<Env, { bg: string; fog: [number, number] | null; hemi: [string, string, number]; key: [string, number]; amb: number; tint?: string }> = {
  cleanroom: { bg: '#0b0e0c', fog: [22, 75], hemi: ['#e6ede6', '#262b27', 0.42], key: ['#fffdf6', 1.15], amb: 0.06 },
  litho: { bg: '#0f0b07', fog: [16, 52], hemi: ['#ffd9a0', '#3a2c1c', 0.45], key: ['#ffd08a', 1.1], amb: 0.06, tint: '#ffcf86' },
  hall: { bg: '#0b0c0b', fog: [20, 70], hemi: ['#d8d6cf', '#24262a', 0.4], key: ['#fff2dd', 1.15], amb: 0.06 },
  assembly: { bg: '#0b0d0c', fog: [14, 48], hemi: ['#e8ece6', '#2b2f2c', 0.45], key: ['#ffffff', 1.1], amb: 0.07 },
  warehouse: { bg: '#0c0c0b', fog: [26, 80], hemi: ['#e9e2d4', '#2a2824', 0.42], key: ['#fff1d8', 1.1], amb: 0.07 },
  void: { bg: '#07090b', fog: null, hemi: ['#cfd8e0', '#14181c', 0.6], key: ['#ffffff', 1.6], amb: 0.15 },
  office: { bg: '#07090b', fog: [12, 40], hemi: ['#b9c4cc', '#15181b', 0.35], key: ['#e8eef2', 0.6], amb: 0.08 },
  exterior: { bg: '#1a2129', fog: [180, 520], hemi: ['#b7c6d3', '#2b2d2c', 0.8], key: ['#fff1dc', 1.8], amb: 0.15 },
};

export function Lighting({ env, shadowExtent = 10, center = [0, 0, 0] }: { env: Env; shadowExtent?: number; center?: [number, number, number] }) {
  const e = ENV[env];
  const quality = useUI((s) => s.quality);
  const scene = useThree((s) => s.scene);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const base = useMemo(() => ({ bg: new THREE.Color(e.bg), sky: new THREE.Color(e.hemi[0]) }), [e]);
  useEffect(() => {
    scene.background = new THREE.Color(e.bg);
    scene.fog = e.fog ? new THREE.Fog(e.bg, e.fog[0], e.fog[1]) : null;
  }, [scene, e]);
  // journey colour grade: tint the atmosphere (background, fog, sky light) — subtly, physics stays neutral
  const last = useRef(-1);
  useFrame(() => {
    if (last.current === gradeState.version) return;
    last.current = gradeState.version;
    const bg = scene.background as THREE.Color | null;
    if (bg && bg.isColor) bg.copy(base.bg).lerp(gradeState.deep, env === 'exterior' ? 0.25 : 0.6);
    if (scene.fog && bg) (scene.fog as THREE.Fog).color.copy(bg);
    if (hemi.current) hemi.current.color.copy(base.sky).lerp(gradeState.glow, 0.14);
  });
  const amber = env === 'litho';
  return (
    <>
      <hemisphereLight ref={hemi} args={[e.hemi[0], e.hemi[1], e.hemi[2]]} />
      <ambientLight intensity={e.amb} />
      <directionalLight
        position={[center[0] + 6, center[1] + 14, center[2] + 8]}
        target-position={center}
        color={e.key[0]}
        intensity={e.key[1]}
        castShadow={quality === 'high'}
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-left={-shadowExtent}
        shadow-camera-right={shadowExtent}
        shadow-camera-top={shadowExtent}
        shadow-camera-bottom={-shadowExtent}
        shadow-camera-near={0.5}
        shadow-camera-far={60}
      />
      <directionalLight position={[-8, 6, -6]} intensity={0.35} color={amber ? '#ffc070' : '#bcd2e0'} />
      <Environment resolution={128} frames={1} environmentIntensity={env === 'void' ? 0.8 : 0.55}>
        <color attach="background" args={[amber ? '#20160b' : '#14181b']} />
        <Lightformer form="rect" intensity={amber ? 2.0 : 2.2} color={amber ? '#ffcf86' : '#f4f8f0'} position={[0, 5, 0]} rotation-x={Math.PI / 2} scale={[12, 12, 1]} />
        <Lightformer form="rect" intensity={1.2} color={amber ? '#ffb85c' : '#dfe9f0'} position={[-6, 2, -4]} rotation-y={Math.PI / 3} scale={[6, 3, 1]} />
        <Lightformer form="rect" intensity={0.9} color={amber ? '#ffb85c' : '#e8eef2'} position={[6, 2, 4]} rotation-y={-Math.PI / 1.5} scale={[6, 3, 1]} />
        <Lightformer form="ring" intensity={0.6} color="#ffffff" position={[0, 1, 8]} scale={3} />
      </Environment>
    </>
  );
}

/* ----------------------------- rooms ----------------------------- */

/**
 * Local cleanroom bay around a process tool: raised perforated floor, FFU ceiling
 * with light rails, back wall and a neighbouring tool silhouette.
 */
export function CleanroomBay({ width = 14, depth = 10, height = 4.2, amber = false, center = [0, 0, 0] }: { width?: number; depth?: number; height?: number; amber?: boolean; center?: [number, number, number] }) {
  const floorMat = useMemo(() => new THREE.MeshStandardMaterial({ map: floorTile([width / 0.6, depth / 0.6]), roughness: 0.42, metalness: 0.15, color: amber ? '#e6d4b0' : '#ffffff' }), [width, depth, amber]);
  const ceilMat = useMemo(() => new THREE.MeshStandardMaterial({ map: ffuPanel(), roughness: 0.8, color: amber ? '#ffe0b0' : '#ffffff', side: THREE.DoubleSide }), [amber]);
  const ffus = useMemo(() => {
    const cols = Math.floor(width / 1.2);
    const rows = Math.floor(depth / 1.2);
    const m = new THREE.InstancedMesh(GEO.box, ceilMat, cols * rows);
    const o = new THREE.Object3D();
    let i = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      o.position.set(-width / 2 + 0.6 + c * 1.2, height, -depth / 2 + 0.6 + r * 1.2);
      o.scale.set(1.16, 0.06, 1.16);
      o.updateMatrix();
      m.setMatrixAt(i++, o.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
    return m;
  }, [width, depth, height, ceilMat]);
  const camRef = useRef(true);
  useFrame(({ camera }) => {
    const inside = camera.position.y < height + center[1];
    if (inside !== camRef.current) {
      camRef.current = inside;
      ffus.visible = inside;
    }
  });
  const lightMat = amber ? M.lightAmber : M.lightPanel;
  return (
    <group position={center}>
      <mesh rotation-x={-Math.PI / 2} receiveShadow material={floorMat}>
        <planeGeometry args={[width, depth]} />
      </mesh>
      <primitive object={ffus} />
      {Array.from({ length: Math.floor(width / 2.4) }, (_, i) => (
        <B key={i} s={[0.06, 0.03, depth]} m={lightMat} position={[-width / 2 + 1.2 + i * 2.4, height - 0.05, 0]} shadow={false} />
      ))}
      {/* back wall with service chase panels */}
      <B s={[width, height, 0.1]} m={amber ? M.panelWarm : M.panel} position={[0, height / 2, -depth / 2]} />
      {Array.from({ length: Math.floor(width / 1.5) }, (_, i) => (
        <B key={i} s={[0.02, height - 0.4, 0.02]} m={M.frame} position={[-width / 2 + 0.75 + i * 1.5, height / 2, -depth / 2 + 0.06]} shadow={false} />
      ))}
      {/* side walls (low) */}
      <B s={[0.1, height, depth]} m={amber ? M.panelWarm : M.panel} position={[-width / 2, height / 2, 0]} />
      {/* columns */}
      {[-1, 1].map((sx) => (
        <B key={sx} s={[0.4, height, 0.4]} m={M.panel} position={[sx * (width / 2 - 1), height / 2, -depth / 2 + 0.3]} />
      ))}
    </group>
  );
}

/** Industrial hall: epoxy/concrete floor, steel columns, high bay lights. */
export function Hall({ width = 60, depth = 26, height = 12, center = [0, 0, 0] }: { width?: number; depth?: number; height?: number; center?: [number, number, number] }) {
  const floorMat = useMemo(() => new THREE.MeshStandardMaterial({ map: concrete([width / 4, depth / 4]), roughness: 0.85, metalness: 0.05 }), [width, depth]);
  const cols = [];
  for (let x = -width / 2 + 4; x <= width / 2 - 4; x += 8) {
    for (const z of [-depth / 2 + 1, depth / 2 - 1]) {
      if (z > 0) continue;
      cols.push(
        <group key={`${x}:${z}`} position={[x, 0, z]}>
          <B s={[0.36, height, 0.36]} m={M.frame} position={[0, height / 2, 0]} />
          <B s={[0.5, 0.5, 0.5]} m={M.concrete} position={[0, 0.25, 0]} />
        </group>,
      );
    }
  }
  return (
    <group position={center}>
      <mesh rotation-x={-Math.PI / 2} receiveShadow material={floorMat}>
        <planeGeometry args={[width, depth]} />
      </mesh>
      {cols}
      <B s={[width, height, 0.2]} m={M.panelDark} position={[0, height / 2, -depth / 2]} />
      {/* roof trusses */}
      {Array.from({ length: Math.floor(width / 8) + 1 }, (_, i) => (
        <B key={i} s={[0.2, 0.5, depth]} m={M.frame} position={[-width / 2 + i * 8, height - 0.3, 0]} shadow={false} />
      ))}
      {/* high-bay luminaires */}
      {Array.from({ length: Math.floor(width / 8) }, (_, i) =>
        [-4, 4].map((z) => <C key={`${i}:${z}`} r={0.35} h={0.1} m={M.lightPanel} position={[-width / 2 + 4 + i * 8, height - 0.8, z]} shadow={false} />),
      )}
      {/* floor safety lines */}
      <B s={[width - 2, 0.002, 0.1]} m={M.safety} position={[0, 0.001, 5]} shadow={false} />
      <B s={[width - 2, 0.002, 0.1]} m={M.safety} position={[0, 0.001, -6]} shadow={false} />
    </group>
  );
}

/** Assembly / test floor (ESD tiles, lower ceiling). */
export function AssemblyFloor({ width = 16, depth = 12, height = 3.6 }: { width?: number; depth?: number; height?: number }) {
  const floorMat = useMemo(() => new THREE.MeshStandardMaterial({ map: plainTile([width / 0.6, depth / 0.6], '#9aa3a0'), roughness: 0.5 }), [width, depth]);
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} receiveShadow material={floorMat}>
        <planeGeometry args={[width, depth]} />
      </mesh>
      <B s={[width, height, 0.1]} m={M.panel} position={[0, height / 2, -depth / 2]} />
      {Array.from({ length: Math.floor(width / 2) }, (_, i) => (
        <B key={i} s={[1.2, 0.04, 0.3]} m={M.lightPanel} position={[-width / 2 + 1 + i * 2, height, 0]} shadow={false} />
      ))}
    </group>
  );
}

/** Dark technical backdrop with a faint measurement grid for nanoscale scenes. */
export function VoidBackdrop({ size = 60, y = -0.01, color = '#3a4650' }: { size?: number; y?: number; color?: string }) {
  return (
    <group>
      <gridHelper args={[size, size, color, '#1a2026']} position={[0, y, 0]} />
    </group>
  );
}
