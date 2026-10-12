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
import { KM } from './kit/finish';
import { iBeam, cableTray, grille, type Kit } from './kit/build';
import { Baked, useKit } from './kit/Baked';
import { SHADOW_LAYER } from './kit/shadow';

type Env = SceneConfig['environment'];

const ENV: Record<Env, { bg: string; fog: [number, number] | null; hemi: [string, string, number]; key: [string, number]; amb: number; tint?: string }> = {
  cleanroom: { bg: '#0b0e0c', fog: [22, 75], hemi: ['#e6ede6', '#262b27', 0.42], key: ['#fffdf6', 1.15], amb: 0.06 },
  litho: { bg: '#0f0b07', fog: [16, 52], hemi: ['#ffd9a0', '#3a2c1c', 0.45], key: ['#ffd08a', 1.1], amb: 0.06, tint: '#ffcf86' },
  hall: { bg: '#0b0c0b', fog: [20, 70], hemi: ['#d8d6cf', '#24262a', 0.4], key: ['#fff2dd', 1.15], amb: 0.06 },
  assembly: { bg: '#0b0d0c', fog: [14, 48], hemi: ['#e8ece6', '#2b2f2c', 0.45], key: ['#ffffff', 1.1], amb: 0.07 },
  warehouse: { bg: '#0c0c0b', fog: [26, 80], hemi: ['#e9e2d4', '#2a2824', 0.42], key: ['#fff1d8', 1.1], amb: 0.07 },
  void: { bg: '#07090b', fog: null, hemi: ['#d4dccf', '#141814', 0.5], key: ['#ffffff', 1.35], amb: 0.12 },
  office: { bg: '#07090b', fog: [12, 40], hemi: ['#b9c4cc', '#15181b', 0.35], key: ['#e8eef2', 0.6], amb: 0.08 },
  exterior: { bg: '#1a211c', fog: [200, 560], hemi: ['#c9d6c3', '#2b2d2a', 0.75], key: ['#fff1dc', 1.7], amb: 0.14 },
};

export function Lighting({ env, shadowExtent = 10, center = [0, 0, 0], fogScale = 1 }: { env: Env; shadowExtent?: number; center?: [number, number, number]; /** multiply fog distances (scenes in cm use 100) */ fogScale?: number }) {
  const e = ENV[env];
  const quality = useUI((s) => s.quality);
  const scene = useThree((s) => s.scene);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const key = useRef<THREE.DirectionalLight>(null);
  // the key light aims at a real scene object, so its shadow camera follows `center`
  const keyTarget = useMemo(() => new THREE.Object3D(), []);
  useEffect(() => {
    keyTarget.position.set(center[0], center[1], center[2]);
    keyTarget.updateMatrixWorld();
    const l = key.current;
    if (!l) return;
    l.target = keyTarget;
    // shadow-only casters (kit models) live on their own layer
    l.shadow.camera.layers.enable(SHADOW_LAYER);
  }, [keyTarget, center[0], center[1], center[2]]); // eslint-disable-line react-hooks/exhaustive-deps
  const base = useMemo(() => ({ bg: new THREE.Color(e.bg), sky: new THREE.Color(e.hemi[0]) }), [e]);
  useEffect(() => {
    scene.background = new THREE.Color(e.bg);
    scene.fog = e.fog ? new THREE.Fog(e.bg, e.fog[0] * fogScale, e.fog[1] * fogScale) : null;
  }, [scene, e, fogScale]);
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
      <primitive object={keyTarget} />
      <directionalLight
        ref={key}
        position={[center[0] + 6, center[1] + 14, center[2] + 8]}
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
      <Environment resolution={256} frames={1} environmentIntensity={env === 'void' ? 0.62 : 0.55}>
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
  const room = useKit((k) => buildBayShell(k, width, depth, height, amber), [width, depth, height, amber]);
  return (
    <group position={center}>
      <mesh rotation-x={-Math.PI / 2} receiveShadow material={floorMat}>
        <planeGeometry args={[width, depth]} />
      </mesh>
      <primitive object={ffus} />
      {Array.from({ length: Math.floor(width / 2.4) }, (_, i) => (
        <B key={i} s={[0.06, 0.03, depth]} m={lightMat} position={[-width / 2 + 1.2 + i * 2.4, height - 0.05, 0]} shadow={false} />
      ))}
      <Baked parts={room} />
    </group>
  );
}

/** Cleanroom wall system: modular panels with seams, return-air grilles, cove base, clad columns, T-bar ceiling grid. */
function buildBayShell(k: Kit, width: number, depth: number, height: number, amber: boolean) {
  const wall = amber ? KM.paintWarm : KM.paint;
  const pw = 1.2;
  // back wall
  k.box(wall, [width, height, 0.1], [0, height / 2, -depth / 2]);
  const n = Math.floor(width / pw);
  for (let i = 1; i < n; i++) k.box(KM.seam, [0.006, height - 0.12, 0.004], [-width / 2 + i * pw, height / 2, -depth / 2 + 0.052], [0, 0, 0], { cast: false });
  k.box(KM.seam, [width, 0.006, 0.004], [0, 2.4, -depth / 2 + 0.052], [0, 0, 0], { cast: false });
  for (let i = 0; i < n; i += 2) grille(k, 0.8, 0.32, [-width / 2 + (i + 0.5) * pw, 0.32, -depth / 2 + 0.056], { m: wall });
  // stainless cove base
  k.box(KM.stainless, [width, 0.1, 0.02], [0, 0.05, -depth / 2 + 0.06], [0, 0, 0], { cast: false });
  // left side wall with the same system
  k.box(wall, [0.1, height, depth], [-width / 2, height / 2, 0]);
  const m = Math.floor(depth / pw);
  for (let i = 1; i < m; i++) k.box(KM.seam, [0.004, height - 0.12, 0.006], [-width / 2 + 0.052, height / 2, -depth / 2 + i * pw], [0, 0, 0], { cast: false });
  k.box(KM.stainless, [0.02, 0.1, depth], [-width / 2 + 0.06, 0.05, 0], [0, 0, 0], { cast: false });
  // pass-through door with vision panel
  k.at([-width / 2 + 0.055, 0, depth * 0.18], [0, Math.PI / 2, 0], () => {
    k.box(KM.anodized, [1.0, 2.15, 0.02], [0, 1.075, 0]);
    k.box(KM.glassSmoke, [0.3, 0.5, 0.006], [0, 1.5, 0.012], [0, 0, 0], { cast: false });
    k.rbox(KM.stainless, [0.03, 0.3, 0.04], 0.008, [0.38, 1.05, 0.03]);
    k.label('info', 'ISO 5 · CLASS 100', 'GOWNING REQUIRED', 0.36, 0.09, [0, 1.95, 0.012]);
  });
  // clad columns
  for (const sx of [-1, 1]) k.rbox(wall, [0.42, height, 0.42], 0.03, [sx * (width / 2 - 1), height / 2, -depth / 2 + 0.3]);
  // T-bar ceiling grid
  for (let x = -width / 2; x <= width / 2 + 1e-6; x += 1.2) k.box(KM.anodized, [0.025, 0.04, depth], [x, height - 0.03, 0], [0, 0, 0], { cast: false });
  for (let z = -depth / 2; z <= depth / 2 + 1e-6; z += 1.2) k.box(KM.anodized, [width, 0.04, 0.025], [0, height - 0.03, z], [0, 0, 0], { cast: false });
  // fire sprinklers and the EMO station
  for (let x = -width / 2 + 2.4; x < width / 2; x += 4.8) for (let z = -depth / 2 + 2.4; z < depth / 2; z += 4.8) k.cyl(KM.chrome, 0.015, 0.05, [x, height - 0.08, z], [0, 0, 0], 8, { cast: false });
  k.rbox(KM.paintRed, [0.16, 0.2, 0.04], 0.01, [width / 2 - 2, 1.45, -depth / 2 + 0.07]);
  k.label('info', 'EMO', 'EMERGENCY OFF', 0.14, 0.04, [width / 2 - 2, 1.6, -depth / 2 + 0.07]);
}

/** Industrial hall: concrete floor with joints, I-beam frame, ribbed wall cladding, trusses, crane runway, high-bay lights. */
export function Hall({ width = 60, depth = 26, height = 12, center = [0, 0, 0] }: { width?: number; depth?: number; height?: number; center?: [number, number, number] }) {
  const floorMat = useMemo(() => new THREE.MeshStandardMaterial({ map: concrete([width / 4, depth / 4]), roughness: 0.85, metalness: 0.05 }), [width, depth]);
  const hall = useKit((k) => buildHall(k, width, depth, height), [width, depth, height]);
  return (
    <group position={center}>
      <mesh rotation-x={-Math.PI / 2} receiveShadow material={floorMat}>
        <planeGeometry args={[width, depth]} />
      </mesh>
      <Baked parts={hall} />
      {/* high-bay luminaires: emissive lenses */}
      {Array.from({ length: Math.floor(width / 8) }, (_, i) =>
        [-4, 4].map((z) => <C key={`${i}:${z}`} r={0.3} h={0.02} m={M.lightPanel} position={[-width / 2 + 4 + i * 8, height - 1.06, z]} shadow={false} />),
      )}
    </group>
  );
}

function buildHall(k: Kit, width: number, depth: number, height: number) {
  // floor: saw-cut joints and walkway lines
  for (let x = -width / 2 + 6; x < width / 2; x += 6) k.box(KM.seam, [0.008, 0.002, depth], [x, 0.001, 0], [0, 0, 0], { cast: false });
  for (let z = -depth / 2 + 6; z < depth / 2; z += 6) k.box(KM.seam, [width, 0.002, 0.008], [0, 0.001, z], [0, 0, 0], { cast: false });
  for (const z of [5, -6]) k.box(KM.paintYellow, [width - 2, 0.003, 0.1], [0, 0.0015, z], [0, 0, 0], { cast: false });
  // back wall: ribbed cladding, window band, roll-up door
  const zb = -depth / 2;
  k.box(KM.paintDark, [width, height, 0.12], [0, height / 2, zb]);
  for (let x = -width / 2 + 0.15; x < width / 2; x += 0.3) k.box(KM.paintDark, [0.05, height * 0.62, 0.04], [x, height * 0.31, zb + 0.08], [0, 0, 0], { cast: false });
  k.box(KM.glassSmoke, [width - 1, 1.1, 0.04], [0, height * 0.72, zb + 0.07], [0, 0, 0], { cast: false });
  for (let x = -width / 2 + 2; x < width / 2; x += 2) k.box(KM.anodizedDark, [0.06, 1.2, 0.07], [x, height * 0.72, zb + 0.08], [0, 0, 0], { cast: false });
  k.box(KM.anodized, [4.2, 4.6, 0.06], [width / 2 - 6, 2.3, zb + 0.1]);
  for (let y = 0.2; y < 4.6; y += 0.18) k.box(KM.anodizedDark, [4.2, 0.012, 0.012], [width / 2 - 6, y, zb + 0.135], [0, 0, 0], { cast: false });
  k.label('warn', 'FORKLIFTS', '', 0.4, 0.4, [width / 2 - 3.5, 2.2, zb + 0.07]);
  // columns along the back wall + crane runway
  for (let x = -width / 2 + 4; x <= width / 2 - 4; x += 8) {
    iBeam(k, height - 0.2, [x, 0, zb + 1], 0.42, KM.paintGrey);
    k.box(KM.paintGrey, [0.5, 0.3, 0.9], [x, height * 0.72 - 0.3, zb + 1.4]);
  }
  k.box(KM.paintYellow, [width - 4, 0.5, 0.3], [0, height * 0.72, zb + 1.6]);
  k.box(KM.steel, [width - 4, 0.08, 0.08], [0, height * 0.72 + 0.29, zb + 1.6], [0, 0, 0], { cast: false });
  // overhead crane bridge parked at one end, with hoist
  k.at([-width / 2 + 7, height * 0.72 + 0.6, 0], 0, () => {
    k.box(KM.paintYellow, [0.6, 0.7, depth - 4], [0, 0, zb / 2 + 0.8]);
    k.rbox(KM.paintYellow, [0.9, 0.6, 1.1], 0.04, [0, -0.6, -2]);
    k.cyl(KM.steel, 0.012, 3.2, [0, -2.5, -2], [0, 0, 0], 6, { cast: false });
    k.rbox(KM.paintYellow, [0.25, 0.3, 0.2], 0.03, [0, -4.2, -2]);
    k.label('model', '10 t', 'SWL', 0.45, 0.12, [0.31, 0, zb / 2 + 0.8], [0, Math.PI / 2, 0]);
  });
  // roof trusses: chords and diagonals
  for (let x = -width / 2; x <= width / 2 + 1e-6; x += 8) {
    k.box(KM.paintGrey, [0.16, 0.16, depth], [x, height - 0.1, 0], [0, 0, 0], { cast: false });
    k.box(KM.paintGrey, [0.12, 0.12, depth], [x, height - 1.1, 0], [0, 0, 0], { cast: false });
    for (let z = -depth / 2; z < depth / 2 - 0.5; z += 1.6) k.box(KM.paintGrey, [0.06, 1.25, 0.06], [x, height - 0.6, z + 0.8], [0.9, 0, 0], { cast: false });
  }
  // luminaire housings
  for (let i = 0; i < Math.floor(width / 8); i++)
    for (const z of [-4, 4]) {
      const x = -width / 2 + 4 + i * 8;
      k.lathe(KM.anodizedDark, [[0.08, 0.45], [0.12, 0.3], [0.32, 0.06], [0.34, 0]], [x, height - 1.06, z], [0, 0, 0], 24, { cast: false });
      k.cyl(KM.steel, 0.006, 0.5, [x, height - 0.36, z], [0, 0, 0], 6, { cast: false });
    }
  // cable trays along the back wall
  cableTray(k, [-width / 2 + 1, height * 0.55, zb + 0.5], [width / 2 - 1, height * 0.55, zb + 0.5], 0.4, 6);
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
