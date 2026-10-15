'use client';
/**
 * The WebGL host. Lighting and geometry live in the scene modules; this file wires the
 * renderer, camera rig, scene switcher and debug probe together.
 *
 * Quality comes from lib/quality.ts and is fixed before the context is created (MSAA is a
 * context attribute; shadows are part of every shader program). Only the pixel ratio adapts
 * at run time, which never recompiles a shader.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useUI } from '@/lib/store';
import { renderStats } from '@/lib/runtime';
import { engine } from '@/simulation/engine';
import { getQuality, renderState } from '@/lib/quality';
import { CameraRig } from './CameraRig';
import { SceneSwitcher, beforeDraw, lateLoad, renderGate, sceneLoad, sceneLog } from './SceneSwitcher';

/** Debug handle for the console and automated checks: window.fabTwin.{gl, scene, camera, r3f}. */
function DebugProbe() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const get = useThree((s) => s.get);
  useEffect(() => {
    const w = window as unknown as { fabTwin?: object };
    w.fabTwin = Object.assign(w.fabTwin ?? {}, { scene, camera, gl, r3f: get, quality: getQuality(), renderState, sceneLoad, sceneLog, lateLoad, renderGate });
  }, [gl, scene, camera, get]);
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

/**
 * Make the hidden objects of the scene visible; returns them (to hide again after the draw).
 * Lights stay as they are: a light more would change every shader program.
 */
function revealHidden(scene: THREE.Scene): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const isLight = (o: THREE.Object3D) => (o as THREE.Light).isLight === true;
  scene.traverse((o) => {
    if (o.visible || isLight(o)) return;
    let light = false;
    if (o.children.length) o.traverse((c) => void (light ||= isLight(c)));
    if (light) return;
    o.visible = true;
    out.push(o);
  });
  return out;
}

/**
 * Draws the frame. Takes rendering over from R3F (positive priority) so a scene whose shader
 * programs are still compiling in the background is never drawn: the previous frame stays on
 * the canvas (behind the story veil) instead of the main thread blocking on the compile.
 * Objects mounted later (a new stage of the same scene) are left out of the draw until their
 * own programs are ready (see SceneSwitcher.beforeDraw).
 */
function Renderer() {
  const vis = useRef<boolean[]>([]);
  useFrame(({ gl, scene, camera }) => {
    if (renderGate.hold > 0) return;
    const hide = beforeDraw(gl, scene, camera);
    if (!hide) return; // the lights changed and every program is recompiling: keep the last frame
    const v = vis.current;
    v.length = 0;
    // the first draw of a new scene also draws what is hidden (see renderGate.warm)
    const shown = renderGate.warm ? revealHidden(scene) : null;
    renderGate.warm = false;
    for (const o of hide) {
      v.push(o.visible);
      o.visible = false;
    }
    const programs = gl.info.programs?.length ?? 0;
    gl.render(scene, camera);
    for (let i = hide.length - 1; i >= 0; i--) hide[i].visible = v[i];
    if (shown) for (const o of shown) o.visible = false;
    // diagnostics: programs that still had to be compiled inside the draw
    const list = gl.info.programs as unknown as { name: string; cacheKey: string }[] | null;
    if (list && list.length > programs) {
      lateLoad.inDraw += list.length - programs;
      for (const p of list.slice(programs)) lateLoad.inDrawLog.push(`${engine.stage.id}:${p.name}:${String(p.cacheKey).slice(0, 120)}`);
      if (lateLoad.inDrawLog.length > 40) lateLoad.inDrawLog.splice(0, lateLoad.inDrawLog.length - 40);
    }
  }, 1);
  return null;
}

/**
 * Gentle adaptive resolution: measures the frame rate in 1.5 s windows (ignoring scene
 * changes and hidden tabs) and steps the pixel ratio down by 0.25 only while the frame rate
 * stays low (under 28 fps on phones, 40 on desktops), never below the tier's floor unless it
 * is truly bad (under 18 fps). Steps back up (at most
 * twice) when there is plenty of headroom. Changing the pixel ratio resizes the drawing
 * buffer only: no shader recompiles.
 */
function AdaptiveDpr({ dpr, onChange }: { dpr: number; onChange: (d: number) => void }) {
  const q = getQuality();
  const s = useRef({ frames: [] as number[], t0: 0, low: 0, bad: 0, high: 0, lastDown: 0 });
  // phones: sharpness first. 30 fps (also the iOS low-power-mode cap) is fine for this site;
  // only a frame rate below that costs resolution
  const lowFps = q.mobile ? 28 : 40;
  useEffect(() => {
    renderState.dpr = dpr;
  }, [dpr]);
  useFrame((_, dt) => {
    const now = performance.now();
    const st = s.current;
    // scene changes (compile, uploads, first frames) and hidden tabs say nothing about steady rendering
    if (renderGate.hold > 0 || now - renderGate.since < 2500 || document.hidden || dt <= 0) {
      st.frames.length = 0;
      st.t0 = now;
      return;
    }
    st.frames.push(dt);
    if (now - st.t0 < 1500 || st.frames.length < 12) return;
    const sorted = st.frames.slice().sort((a, b) => a - b);
    const fps = 1 / sorted[Math.floor(sorted.length / 2)];
    renderState.fps = fps;
    st.frames.length = 0;
    st.t0 = now;
    const step = (d: number) => {
      const next = Math.round(d * 100) / 100;
      if (next !== dpr) onChange(next);
    };
    if (fps < lowFps) {
      st.high = 0;
      if (dpr > q.dprFloor + 1e-3) {
        if (++st.low >= 2) {
          st.low = 0;
          st.lastDown = now;
          renderState.stepsDown++;
          step(Math.max(q.dprFloor, dpr - 0.25));
        }
      } else if (fps < 18 && dpr > q.dprMin + 1e-3) {
        // truly bad even at the floor
        if (++st.bad >= 3) {
          st.bad = 0;
          st.lastDown = now;
          renderState.stepsDown++;
          step(Math.max(q.dprMin, dpr - 0.25));
        }
      } else st.bad = 0;
    } else {
      st.low = 0;
      st.bad = 0;
      if (fps > 57 && dpr < q.dprMax - 1e-3 && renderState.stepsUp < 2 && now - st.lastDown > 15000) {
        if (++st.high >= 4) {
          st.high = 0;
          renderState.stepsUp++;
          step(Math.min(q.dprMax, dpr + 0.25));
        }
      } else st.high = 0;
    }
  });
  return null;
}

export default function Stage3D() {
  const q = getQuality();
  const [dpr, setDpr] = useState(q.dprMax);
  // the scene tree never re-renders because of a resolution change
  const content = useMemo(
    () => (
      <>
        <CameraRig />
        <SceneSwitcher />
        <Renderer />
        <DebugProbe />
      </>
    ),
    [],
  );
  return (
    <Canvas
      className="stage-canvas"
      shadows={q.shadows ? 'percentage' : false}
      dpr={dpr}
      gl={{ antialias: q.antialias, stencil: false, powerPreference: 'high-performance', localClippingEnabled: true } as THREE.WebGLRendererParameters & { localClippingEnabled: boolean }}
      camera={{ fov: 45, near: 0.005, far: 3000, position: [-41.5, 2.1, 0.6] }}
      onCreated={({ gl }) => {
        gl.localClippingEnabled = true;
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 0.92;
        // link errors are reported by the driver anyway; the per-program log queries are
        // synchronous round trips to the GPU process
        if (process.env.NODE_ENV === 'production') gl.debug.checkShaderErrors = false;
        renderState.dpr = gl.getPixelRatio();
        useUI.getState().setLoader('environment', 'done');
      }}
      onPointerMissed={() => useUI.getState().select(null)}
    >
      <AdaptiveDpr dpr={dpr} onChange={setDpr} />
      {content}
    </Canvas>
  );
}
