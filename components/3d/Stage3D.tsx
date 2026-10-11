'use client';
/**
 * The WebGL host. Lighting and geometry live in the scene modules; this file wires the
 * renderer, camera rig, scene switcher and debug probe together.
 */
import * as THREE from 'three';
import { useEffect, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { useUI } from '@/lib/store';
import { renderStats } from '@/lib/runtime';
import { CameraRig } from './CameraRig';
import { SceneSwitcher } from './SceneSwitcher';

function DebugProbe() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const get = useThree((s) => s.get);
  if (typeof window !== 'undefined') Object.assign((window as unknown as { fabTwin?: object }).fabTwin ?? {}, { scene, camera, gl, r3f: get });
  const acc = useRef(0);
  useFrame((_, dt) => {
    acc.current += dt;
    if (acc.current < 0.5) return;
    acc.current = 0;
    renderStats.calls = gl.info.render.calls;
    renderStats.triangles = gl.info.render.triangles;
    renderStats.geometries = gl.info.memory.geometries;
    renderStats.textures = gl.info.memory.textures;
    renderStats.programs = gl.info.programs?.length ?? 0;
    renderStats.dpr = gl.getPixelRatio();
    renderStats.version++;
  });
  return null;
}

/** Pixel-ratio range per quality tier. Fill rate, not geometry, is what costs most on laptop GPUs. */
const DPR: Record<'high' | 'low', [number, number]> = { high: [1, 1.5], low: [0.75, 1] };

export default function Stage3D() {
  const quality = useUI((s) => s.quality);
  const [lo, hi] = DPR[quality];
  const cap = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, hi);
  const [dpr, setDpr] = useState(cap);
  useEffect(() => setDpr(cap), [cap]);
  return (
    <Canvas
      className="stage-canvas"
      shadows={quality === 'high' ? 'percentage' : false}
      dpr={dpr}
      gl={{ antialias: true, stencil: false, powerPreference: 'high-performance', localClippingEnabled: true } as THREE.WebGLRendererParameters & { localClippingEnabled: boolean }}
      camera={{ fov: 45, near: 0.005, far: 3000, position: [-41.5, 2.1, 0.6] }}
      onCreated={({ gl }) => {
        gl.localClippingEnabled = true;
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 0.92;
        useUI.getState().setLoader('environment', 'done');
      }}
      onPointerMissed={() => useUI.getState().select(null)}
    >
      {/* Adapts resolution only. Switching shadows or materials here would recompile every shader mid-session. */}
      <PerformanceMonitor
        factor={1}
        flipflops={3}
        onChange={({ factor }) => setDpr(+Math.max(lo, Math.min(cap, lo + (cap - lo) * factor)).toFixed(2))}
        onFallback={() => setDpr(lo)}
      />
      <CameraRig />
      <SceneSwitcher />
      <DebugProbe />
    </Canvas>
  );
}
