/**
 * Helpers for phase-driven animation. Scenes are pure functions of the stage
 * player's view, so scrubbing, stepping and before/after previews always agree.
 */
import type { Stage } from '@/types';
import type { PlayerView } from '@/simulation/player';
import { engine } from '@/simulation/engine';

/** 0 before the phase, phaseT during, 1 after. Works for any phase id of the current stage. */
export function pp(id: string, v: PlayerView = engine.player.view, stage: Stage = engine.stage): number {
  const i = stage.phases.findIndex((p) => p.id === id);
  if (i < 0) return 0;
  if (v.phaseIndex > i) return 1;
  if (v.phaseIndex < i) return 0;
  return v.phaseT;
}

/** true while the given phase is active */
export const inPhase = (id: string, v: PlayerView = engine.player.view) => v.phaseId === id;

/** Is this scene variant the active stage? */
export const isVariant = (variant: string) => engine.stage.variant === variant;

/** Playback is advancing (for continuous motion like spinning parts). */
export const running = () => engine.player.playing && !engine.player.completed && engine.player.override === null;

/** Speed-scaled frame delta for continuous mechanical motion. */
export function pdt(dt: number) {
  return running() ? dt * engine.player.speed : 0;
}
