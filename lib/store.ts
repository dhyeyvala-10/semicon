'use client';
/**
 * UI state (zustand). Simulation state lives in the engine singleton; this store holds what
 * the visitor has chosen: story or Explore, the stage, the camera and view, the tapped part,
 * and the loading pipeline. Fields the 3D scenes still read are kept even where the interface
 * that changed them is gone (they stay at their defaults).
 */
import { create } from 'zustand';
import type { CameraMode, ExperienceMode, InfoLevel, Selection, ViewMode } from '@/types';
import { STAGE_BY_ID } from '@/data/process';
import { CHAPTERS, CHAPTER_OF_STAGE } from '@/data/chapters';
import { presetFor, modesFor } from '@/data/scenes';
import { engine } from '@/simulation/engine';

export type LoaderKey = 'environment' | 'database' | 'models' | 'simulation' | 'materials' | 'robots';
export type LoadState = 'pending' | 'loading' | 'done' | 'error';

export interface UIState {
  stageId: string;
  /** false: the scroll story; true: Explore */
  started: boolean;
  /** legacy; nothing changes it any more */
  experience: ExperienceMode;
  /** floating 3D label level; 0 = none (the redesign shows no labels in the 3D view) */
  info: 0 | InfoLevel;
  cameraMode: CameraMode;
  /** bumps when a camera preset should be re-applied even if the mode is unchanged */
  cameraNonce: number;
  view: ViewMode;
  follow: boolean;
  /** Explore: the visitor moved the camera, so automatic camera moves wait (until a chapter is picked or Recenter) */
  freeCamera: boolean;
  trace: boolean;
  /** the part the visitor tapped (Explore shows its plain name and one sentence) */
  selection: Selection | null;
  airflow: boolean;
  particles: boolean;
  ffuOn: boolean;
  infrastructure: boolean;
  quality: 'high' | 'low';
  fallback2D: boolean;
  webgl: 'unknown' | 'ok' | 'none';
  loader: Record<LoaderKey, LoadState>;
  loadedScenes: string[];
  transition: { active: boolean; label: string; sub: string };
  /** @deprecated the side panel is gone; kept only so older callers still type-check */
  panelOpen: boolean;
  /** @deprecated the overlays are gone; kept only so older callers still type-check */
  overlay: string | null;

  /** `soft`: an automatic step inside a chapter; keeps the camera, the view and the tapped part */
  goToStage: (id: string, opts?: { autoplay?: boolean; keepCamera?: boolean; soft?: boolean }) => void;
  /** next / previous chapter */
  next: () => void;
  prev: () => void;
  setCamera: (m: CameraMode) => void;
  setView: (v: ViewMode) => void;
  select: (s: Selection | null) => void;
  /** Explore: automatic camera moves again, back to the framing of the current phase */
  recenter: () => void;
  /** @deprecated the overlays are gone; does nothing */
  setOverlay: (o: string | null) => void;
  set: (p: Partial<UIState>) => void;
  setLoader: (k: LoaderKey, s: LoadState) => void;
  markSceneLoaded: (id: string) => void;
}

const defaultCamera = (stageId: string): CameraMode => {
  const st = STAGE_BY_ID[stageId];
  if (!st) return 'factory';
  const first = st.phases[0]?.camera;
  if (first && presetFor(st.scene, st.variant, first)) return first;
  return (modesFor(st.scene, st.variant)[0] as CameraMode) ?? 'factory';
};

/**
 * Explore framing, written by the Explore view when its layout changes (never per frame) and
 * read by the camera rig: how far (share of the screen height) to lift the 3D subject so it
 * sits in the part of the screen the bottom card leaves free.
 */
export const exploreView = { frameY: 0 };

/** The part under the pointer (desktop hover), written by Clickable, read by Explore's hover tip. */
export const hoverPart: { sel: Selection | null; version: number } = { sel: null, version: 0 };

const chapterIndex = (stageId: string) => {
  const c = CHAPTER_OF_STAGE[stageId];
  return c ? CHAPTERS.indexOf(c) : -1;
};

export const useUI = create<UIState>((set, get) => ({
  stageId: 'fab-overview',
  started: false,
  experience: 'control',
  info: 0,
  cameraMode: 'factory',
  cameraNonce: 0,
  view: 'normal',
  follow: false,
  freeCamera: false,
  trace: false,
  selection: null,
  airflow: false,
  particles: false,
  ffuOn: true,
  infrastructure: false,
  quality: 'high',
  fallback2D: false,
  webgl: 'unknown',
  loader: { environment: 'pending', database: 'pending', models: 'pending', simulation: 'pending', materials: 'pending', robots: 'pending' },
  loadedScenes: [],
  transition: { active: false, label: '', sub: '' },
  panelOpen: false,
  overlay: null,

  goToStage: (id, opts = {}) => {
    const stage = STAGE_BY_ID[id];
    if (!stage) return;
    const prev = STAGE_BY_ID[get().stageId];
    const sceneChange = prev?.scene !== stage.scene;
    const soft = !!opts.soft && !sceneChange;
    engine.setStage(stage, { autoplay: opts.autoplay ?? true });
    set((s) => ({
      stageId: id,
      cameraMode: (opts.keepCamera || soft) && !sceneChange ? s.cameraMode : defaultCamera(id),
      cameraNonce: s.cameraNonce + 1,
      view: soft && (stage.views ?? []).includes(s.view) ? s.view : 'normal',
      selection: soft ? s.selection : null,
      trace: false,
      transition: sceneChange ? { active: true, label: stage.location, sub: stage.title } : s.transition,
    }));
    // Explore keeps its place in the address (?stage=), so a reload opens the same chapter
    if (typeof window !== 'undefined' && get().started) {
      const url = new URL(window.location.href);
      url.searchParams.set('stage', id);
      window.history.replaceState(null, '', url.toString());
    }
  },

  next: () => {
    const i = chapterIndex(get().stageId);
    const c = CHAPTERS[Math.min(CHAPTERS.length - 1, i + 1)];
    if (c) get().goToStage(c.stages[0]);
  },
  prev: () => {
    const i = chapterIndex(get().stageId);
    const c = CHAPTERS[Math.max(0, i - 1)];
    if (c) get().goToStage(c.stages[0]);
  },

  setCamera: (m) => set((s) => ({ cameraMode: m, cameraNonce: s.cameraNonce + 1, follow: m === 'wafer' ? true : m === 'machine' || m === 'internal' ? s.follow : false })),
  setView: (v) => set({ view: v }),
  select: (sel) => set({ selection: sel }),
  recenter: () => {
    const st = engine.stage;
    const cue = engine.player.view.phase.camera;
    set((s) => ({
      freeCamera: false,
      cameraMode: cue && presetFor(st.scene, st.variant, cue) ? cue : s.cameraMode,
      cameraNonce: s.cameraNonce + 1,
    }));
  },
  setOverlay: () => {},
  set: (p) => set(p),
  setLoader: (k, st) => set((s) => (s.loader[k] === st ? s : { loader: { ...s.loader, [k]: st } })),
  markSceneLoaded: (id) => set((s) => (s.loadedScenes.includes(id) ? s : { loadedScenes: [...s.loadedScenes, id] })),
}));
