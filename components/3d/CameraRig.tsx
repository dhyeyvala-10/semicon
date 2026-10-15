'use client';
/**
 * Camera system.
 *
 * Story (scroll): the camera glides along each stage's camera cues, driven by the scroll.
 * Explore: animated preset transitions per camera mode, the phase's camera cues, follow mode
 * and a slow sway keep the subject framed, until the visitor drags or zooms. From then on the
 * camera is theirs (`freeCamera`) until they pick a chapter or tap Recenter.
 */
import * as THREE from 'three';
import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useUI, exploreView } from '@/lib/store';
import { STAGE_BY_ID } from '@/data/process';
import { SCENES, presetFor, modesFor } from '@/data/scenes';
import { tracked, cameraRef, cameraDriver } from '@/lib/runtime';
import { engine } from '@/simulation/engine';
import { easeInOut } from '@/lib/math';
import type { CameraMode, CameraPreset, Stage } from '@/types';
import { story } from '@/lib/story';

interface Anim {
  p0: THREE.Vector3;
  t0: THREE.Vector3;
  p1: THREE.Vector3;
  t1: THREE.Vector3;
  f0: number;
  f1: number;
  u: number;
  dur: number;
}

/* ------------------------------------------------------------- scroll story */

interface Pose {
  t: THREE.Vector3;
  r: number;
  az: number;
  el: number;
  fov: number;
}

const toPose = (p: CameraPreset): Pose => {
  const t = new THREE.Vector3(...p.target);
  const off = new THREE.Vector3(...p.pos).sub(t);
  const r = Math.max(1e-4, off.length());
  return { t, r, az: Math.atan2(off.x, off.z), el: Math.asin(THREE.MathUtils.clamp(off.y / r, -1, 1)), fov: p.fov ?? 45 };
};

interface StoryKey {
  u: number;
  pose: Pose;
  mode: CameraMode;
}

/** One camera key per phase, at the middle of the phase, from the phase's camera cue. */
function storyKeys(stage: Stage): StoryKey[] {
  const D = stage.phases.reduce((a, p) => a + p.duration, 0) || 1;
  const first = stage.phases.find((p) => p.camera && presetFor(stage.scene, stage.variant, p.camera))?.camera;
  let mode = first ?? (modesFor(stage.scene, stage.variant)[0] as CameraMode) ?? 'factory';
  let acc = 0;
  const keys: StoryKey[] = [];
  for (const p of stage.phases) {
    if (p.camera && presetFor(stage.scene, stage.variant, p.camera)) mode = p.camera;
    const preset = presetFor(stage.scene, stage.variant, mode) ?? presetFor(stage.scene, stage.variant, 'factory') ?? Object.values(SCENES[stage.scene].presets)[0];
    if (preset) keys.push({ u: (acc + p.duration / 2) / D, pose: toPose(preset), mode });
    acc += p.duration;
  }
  return keys;
}

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const ease = (x: number) => {
  // hold on each key, glide in the middle half between keys
  const k = THREE.MathUtils.clamp((x - 0.2) / 0.6, 0, 1);
  return k * k * k * (k * (k * 6 - 15) + 10);
};

const UP = new THREE.Vector3(0, 1, 0);
const swayOffset = new THREE.Vector3();

/** Explore: the visitor takes the camera; automatic moves wait until a chapter pick or Recenter. */
function takeCamera() {
  const ui = useUI.getState();
  if (ui.started && !story.active && !ui.freeCamera) ui.set({ freeCamera: true });
}

export function CameraRig() {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const gl = useThree((s) => s.gl);
  const stageId = useUI((s) => s.stageId);
  const mode = useUI((s) => s.cameraMode);
  const nonce = useUI((s) => s.cameraNonce);
  const follow = useUI((s) => s.follow);
  const started = useUI((s) => s.started);
  const free = useUI((s) => s.freeCamera);
  const anim = useRef<Anim | null>(null);
  /** Explore framing (view offset, eased) and the slow sway around the target */
  const ex = useRef({ x: 0, y: 0, on: false, swayT: 0, sway: 0 });
  const lastScene = useRef<string>('');
  const lastFocus = useRef<THREE.Vector3 | null>(null);
  const focusPrev = useRef(new THREE.Vector3());
  const delta = useRef(new THREE.Vector3());
  const lastPhase = useRef(-1);
  const lastStage = useRef('');
  const storyCam = useRef({ stage: '', keys: [] as StoryKey[], pos: new THREE.Vector3(), tgt: new THREE.Vector3(), want: new THREE.Vector3(), wantT: new THREE.Vector3(), fov: 45, offset: false });

  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);

  // a drag (more than a few pixels) or a zoom hands the camera to the visitor; a plain tap does not
  useEffect(() => {
    const el = gl.domElement;
    let down = false;
    let sx = 0;
    let sy = 0;
    const onDown = (e: PointerEvent) => {
      down = true;
      sx = e.clientX;
      sy = e.clientY;
    };
    const onMove = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - sx, e.clientY - sy) < 6) return;
      down = false;
      anim.current = null;
      takeCamera();
    };
    const onUp = () => {
      down = false;
    };
    const onWheel = () => {
      anim.current = null;
      takeCamera();
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
    };
  }, [gl]);

  // preset transitions
  useEffect(() => {
    const st = STAGE_BY_ID[stageId];
    if (!st) return;
    if (story.active) {
      lastScene.current = st.scene;
      anim.current = null;
      return;
    }
    const preset = presetFor(st.scene, st.variant, mode);
    if (!preset) return;
    const c = controls.current;
    const target = c ? c.target.clone() : new THREE.Vector3();
    const t1 = new THREE.Vector3(...preset.target);
    const p1 = new THREE.Vector3(...preset.pos);
    // presets are framed for landscape; in portrait the horizontal field shrinks, so pull back
    const aspect = (camera as THREE.PerspectiveCamera).aspect || 1.6;
    if (aspect < 1.2) p1.sub(t1).multiplyScalar(Math.min(2.4, 1.35 / aspect)).add(t1);
    const sceneChanged = lastScene.current !== st.scene;
    lastScene.current = st.scene;
    lastFocus.current = null;
    // the visitor holds the camera: no automatic move (a chapter pick or Recenter clears this first)
    if (!sceneChanged && useUI.getState().started && useUI.getState().freeCamera) return;
    ex.current.swayT = 0;
    ex.current.sway = 0;
    if (sceneChanged) {
      // arrive: start pulled back along the view direction, then glide in
      const dir = p1.clone().sub(t1);
      const p0 = t1.clone().add(dir.multiplyScalar(1.6)).add(new THREE.Vector3(0, dir.length() * 0.1, 0));
      camera.position.copy(p0);
      if (c) c.target.copy(t1);
      camera.fov = preset.fov ?? 45;
      camera.updateProjectionMatrix();
      anim.current = { p0, t0: t1.clone(), p1, t1, f0: camera.fov, f1: preset.fov ?? 45, u: 0, dur: 2.2 };
    } else {
      anim.current = { p0: camera.position.clone(), t0: target, p1, t1, f0: camera.fov, f1: preset.fov ?? 45, u: 0, dur: 1.6 };
    }
  }, [stageId, mode, nonce, camera]);

  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
    const sr = storyCam.current;
    c.enabled = !story.active;
    if (!story.active) {
      // Explore: lift the subject into the part of the screen the bottom card leaves free
      // (eased; coming from the story it starts from the story's framing)
      const e = ex.current;
      if (sr.offset && !e.on) {
        e.x = story.frame.x;
        e.y = story.frame.y;
      }
      const wantY = useUI.getState().started ? exploreView.frameY : 0;
      const k = 1 - Math.exp(-Math.min(dt, 0.1) * 5);
      e.x += (0 - e.x) * k;
      e.y += (wantY - e.y) * k;
      if (Math.abs(e.x) < 1e-4) e.x = 0;
      if (Math.abs(wantY - e.y) < 1e-4) e.y = wantY;
      if (e.x !== 0 || Math.abs(e.y) > 1e-4) {
        camera.setViewOffset(size.width, size.height, -e.x * size.width, e.y * size.height, size.width, size.height);
        sr.offset = true;
        e.on = true;
      } else if (sr.offset) {
        camera.clearViewOffset();
        sr.offset = false;
        e.on = false;
      }
    } else ex.current.on = false;
    const frameOffset = () => {
      // keep the subject clear of the text column
      const w = size.width;
      const h = size.height;
      camera.setViewOffset(w, h, -story.frame.x * w, story.frame.y * h, w, h);
      sr.offset = true;
    };
    if (cameraDriver.scene) {
      if (story.active) {
        frameOffset();
        camera.updateProjectionMatrix();
        story.cut = true;
      }
      c.update();
      return;
    }
    if (story.active) {
      const stage = engine.stage;
      if (sr.stage !== stage.id) {
        sr.stage = stage.id;
        sr.keys = storyKeys(stage);
      }
      const u = engine.player.view.stageT;
      const keys = sr.keys;
      if (!keys.length) return;
      let a = keys[0];
      let b = keys[0];
      for (let i = 0; i < keys.length; i++) {
        if (keys[i].u <= u) a = keys[i];
        if (keys[i].u >= u) {
          b = keys[i];
          break;
        }
        b = keys[i];
      }
      const e = a === b ? 0 : ease((u - a.u) / Math.max(1e-6, b.u - a.u));
      // the camera mode drives cut-aways and the magnified insets, so follow the nearer key
      // ('data' dims the canvas for data overlays, which the story does not show)
      const near = e < 0.5 ? a.mode : b.mode;
      const m = near === 'data' ? 'factory' : near;
      if (m !== useUI.getState().cameraMode) useUI.setState({ cameraMode: m });
      const A = a.pose;
      const B = b.pose;
      // spherical blend around the target: sweeps around machines instead of cutting through them
      const aspect = camera.aspect || 1.6;
      const portrait = aspect < 1.2 ? Math.min(2.2, 1.3 / aspect) : 1;
      const r = Math.exp(THREE.MathUtils.lerp(Math.log(A.r), Math.log(B.r), e)) * (1.06 - 0.12 * u) * portrait;
      const az = A.az + wrapPi(B.az - A.az) * e + (u - 0.5) * 0.34;
      const el = THREE.MathUtils.clamp(THREE.MathUtils.lerp(A.el, B.el, e) + (0.5 - u) * 0.05, -0.25, 1.4);
      sr.wantT.lerpVectors(A.t, B.t, e);
      sr.want.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(r).add(sr.wantT);
      const fov = THREE.MathUtils.lerp(A.fov, B.fov, e);
      if (story.cut) {
        story.cut = false;
        sr.pos.copy(sr.want);
        sr.tgt.copy(sr.wantT);
        sr.fov = fov;
      } else {
        const k = 1 - Math.exp(-dt * 4.5);
        sr.pos.lerp(sr.want, k);
        sr.tgt.lerp(sr.wantT, k);
        sr.fov += (fov - sr.fov) * k;
      }
      camera.position.copy(sr.pos);
      c.target.copy(sr.tgt);
      camera.fov = sr.fov;
      frameOffset();
      camera.updateProjectionMatrix();
      c.update();
      return;
    }
    const a = anim.current;
    if (a) {
      a.u = Math.min(1, a.u + dt / a.dur);
      const e = easeInOut(a.u);
      camera.position.lerpVectors(a.p0, a.p1, e);
      c.target.lerpVectors(a.t0, a.t1, e);
      camera.fov = a.f0 + (a.f1 - a.f0) * e;
      camera.updateProjectionMatrix();
      if (a.u >= 1) anim.current = null;
    }

    // Explore while the camera is automatic: follow the tracked object, take the phase's
    // camera cues, sway slowly. Once the visitor drags or zooms, none of this runs.
    const auto = started && !free;

    // follow the tracked focus object (wafer / FOUP / die / package)
    const focus = tracked.get('focus');
    if (auto && follow && focus) {
      if (lastFocus.current) {
        const d = delta.current.subVectors(focus, lastFocus.current);
        if (d.lengthSq() > 0 && d.lengthSq() < 25) {
          camera.position.add(d);
          c.target.add(d);
          if (anim.current) {
            anim.current.p1.add(d);
            anim.current.t1.add(d);
          }
        }
      } else if (!anim.current) {
        // first frame of follow: glide target onto the object
        const offset = camera.position.clone().sub(c.target);
        const dist = THREE.MathUtils.clamp(offset.length(), 0.5, 6);
        offset.setLength(dist);
        anim.current = { p0: camera.position.clone(), t0: c.target.clone(), p1: focus.clone().add(offset), t1: focus.clone(), f0: camera.fov, f1: camera.fov, u: 0, dur: 1.2 };
      }
      lastFocus.current = focusPrev.current.copy(focus);
    } else lastFocus.current = null;

    // the phase's camera cue (the same cues the story follows)
    const v = engine.player.view;
    if (lastStage.current !== engine.stage.id) {
      lastStage.current = engine.stage.id;
      lastPhase.current = v.phaseIndex;
    } else if (v.phaseIndex !== lastPhase.current) {
      lastPhase.current = v.phaseIndex;
      const cue = v.phase.camera as CameraMode | undefined;
      const st = engine.stage;
      if (auto && cue && cue !== useUI.getState().cameraMode && presetFor(st.scene, st.variant, cue)) useUI.getState().setCamera(cue);
    }

    // a slow sway around the subject (about ±11° over ~40 s), never while gliding
    c.autoRotate = false;
    if (auto && !anim.current) {
      const e = ex.current;
      e.swayT += dt;
      const want = Math.sin(e.swayT * 0.16) * 0.2;
      const d = want - e.sway;
      e.sway = want;
      if (d !== 0) {
        swayOffset.subVectors(camera.position, c.target).applyAxisAngle(UP, d);
        camera.position.copy(c.target).add(swayOffset);
      }
    }
    c.update();
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      minDistance={0.05}
      maxDistance={400}
      maxPolarAngle={Math.PI * 0.495}
    />
  );
}
