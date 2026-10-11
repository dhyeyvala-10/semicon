'use client';
/**
 * Camera system (§7): animated preset transitions per camera mode, follow mode,
 * cinematic cues in WATCH/LEARN, user orbit/zoom, scale probe (§106).
 */
import * as THREE from 'three';
import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useUI } from '@/lib/store';
import { STAGE_BY_ID } from '@/data/process';
import { SCENES, presetFor } from '@/data/scenes';
import { tracked, scaleRegions, scaleState, cameraRef, cameraDriver } from '@/lib/runtime';
import { engine } from '@/simulation/engine';
import { easeInOut } from '@/lib/math';
import type { CameraMode } from '@/types';

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

export function CameraRig() {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const stageId = useUI((s) => s.stageId);
  const mode = useUI((s) => s.cameraMode);
  const nonce = useUI((s) => s.cameraNonce);
  const follow = useUI((s) => s.follow);
  const experience = useUI((s) => s.experience);
  const anim = useRef<Anim | null>(null);
  const lastScene = useRef<string>('');
  const lastFocus = useRef<THREE.Vector3 | null>(null);
  const focusPrev = useRef(new THREE.Vector3());
  const delta = useRef(new THREE.Vector3());
  const lastPhase = useRef(-1);
  const lastStage = useRef('');
  const probeAcc = useRef(0);

  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);

  // preset transitions
  useEffect(() => {
    const st = STAGE_BY_ID[stageId];
    if (!st) return;
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
    if (cameraDriver.scene) {
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

    // follow the tracked focus object (wafer / FOUP / die / package)
    const focus = tracked.get('focus');
    if (follow && focus) {
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

    // cinematic cues (WATCH / LEARN): phase-specific camera modes
    if (experience === 'watch' || experience === 'learn') {
      const v = engine.player.view;
      if (lastStage.current !== engine.stage.id) {
        lastStage.current = engine.stage.id;
        lastPhase.current = v.phaseIndex;
      } else if (v.phaseIndex !== lastPhase.current) {
        lastPhase.current = v.phaseIndex;
        const cue = v.phase.camera as CameraMode | undefined;
        const st = engine.stage;
        if (cue && cue !== useUI.getState().cameraMode && presetFor(st.scene, st.variant, cue)) useUI.getState().setCamera(cue);
      }
    }
    c.autoRotate = experience === 'watch' && !anim.current;
    c.autoRotateSpeed = 0.25;
    c.update();

    // scale probe
    probeAcc.current += dt;
    if (probeAcc.current > 0.15) {
      probeAcc.current = 0;
      const st = STAGE_BY_ID[useUI.getState().stageId];
      const cfg = SCENES[st?.scene ?? 'fab'];
      let mpu = presetFor(cfg.id, st?.variant, 'factory')?.mpu ?? cfg.mpu;
      let schematic = !!st?.schematic;
      let label = '';
      for (const r of scaleRegions.values()) {
        if (r.center.distanceTo(c.target) < r.radius) {
          mpu = r.mpu;
          schematic = !!r.label;
          label = r.label ?? '';
        }
      }
      const sceneOverride = (scaleState as { override?: number }).override;
      if (sceneOverride) mpu = sceneOverride;
      const d = camera.position.distanceTo(c.target);
      const viewH = 2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      scaleState.metersPerPixel = (viewH * mpu) / Math.max(1, size.height);
      scaleState.viewWidth = (viewH * mpu * size.width) / Math.max(1, size.height);
      scaleState.schematic = schematic;
      scaleState.label = label;
      scaleState.version++;
    }
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
      onStart={() => {
        anim.current = null;
      }}
    />
  );
}
