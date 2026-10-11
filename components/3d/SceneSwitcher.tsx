'use client';
/**
 * Scene management (§123, §124): each major scene is a separate dynamically imported
 * module. Only the active scene is mounted; the next scene in the journey is
 * prefetched while the current one plays.
 */
import { Suspense, lazy, useEffect, useRef, type ComponentType } from 'react';
import { SCENE_LOADERS, prefetchScene, type SceneProps } from './sceneLoaders';
import { useFrame } from '@react-three/fiber';
import type { SceneId, Stage } from '@/types';
import { useUI } from '@/lib/store';
import { STAGE_BY_ID, JOURNEY } from '@/data/process';
import { engine } from '@/simulation/engine';
import { tracked } from '@/lib/runtime';

export type { SceneProps };
export { SCENE_LOADERS, prefetchScene };

const LAZY = Object.fromEntries(Object.entries(SCENE_LOADERS).map(([k, l]) => [k, lazy(l)])) as unknown as Record<SceneId, ComponentType<SceneProps>>;

/** Marks loader steps and ends the transition once the first frame of a scene renders. */
function SceneReady({ id }: { id: string }) {
  const frames = useRef(0);
  const done = useRef(false);
  useFrame(() => {
    if (done.current) return;
    frames.current++;
    if (frames.current === 3) {
      done.current = true;
      const s = useUI.getState();
      s.markSceneLoaded(id);
      s.setLoader('models', 'done');
      s.setLoader('materials', 'done');
      if (s.transition.active) setTimeout(() => useUI.getState().set({ transition: { ...useUI.getState().transition, active: false } }), 250);
    }
  });
  return null;
}

export function SceneSwitcher() {
  const stageId = useUI((s) => s.stageId);
  const stage = STAGE_BY_ID[stageId];
  const Scene = LAZY[stage.scene];

  useEffect(() => {
    useUI.getState().setLoader('models', useUI.getState().loadedScenes.includes(stage.scene) ? 'done' : 'loading');
    // tracked positions are re-published every frame by the active scene
    tracked.clear();
  }, [stage.scene]);

  // prefetch the next journey scene once this stage is underway
  useEffect(() => {
    const id = setInterval(() => {
      const i = JOURNEY.findIndex((s) => s.id === engine.stage.id);
      const next = JOURNEY[i + 1];
      if (next && next.scene !== stage.scene && engine.player.view.stageT > 0.3) prefetchScene(next.scene);
    }, 1000);
    return () => clearInterval(id);
  }, [stage.scene]);

  return (
    <Suspense fallback={null}>
      <group key={stage.scene}>
        <Scene stage={stage} />
        <SceneReady id={stage.scene} />
      </group>
    </Suspense>
  );
}
