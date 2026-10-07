'use client';
import { useEffect, useReducer, useSyncExternalStore } from 'react';
import { useUI } from '@/lib/store';
import { STAGE_BY_ID } from '@/data/process';
import type { Stage } from '@/types';
import { engine } from '@/simulation/engine';

/**
 * Re-render the calling component at a fixed rate. Simulation values are read
 * directly from the engine on render, so UI panels stay in sync with the 3D world
 * without pushing 60 fps updates through React.
 */
export function useTicker(hz = 8) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const id = window.setInterval(force, 1000 / hz);
    return () => window.clearInterval(id);
  }, [hz]);
}

export function useStage(): Stage {
  const id = useUI((s) => s.stageId);
  return STAGE_BY_ID[id];
}

/** Subscribe to one engine parameter (e.g. depMode) — re-renders only when it changes. */
export function useParam(key: string, fallback = 0): number {
  return useSyncExternalStore(
    (fn) => engine.subscribe(fn),
    () => engine.params[key] ?? fallback,
    () => fallback,
  );
}
