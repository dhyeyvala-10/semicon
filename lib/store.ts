'use client';
/**
 * UI state (zustand). Simulation state lives in the engine singleton; this store holds
 * what the visitor has chosen: stage, modes, panels, toggles, selection.
 */
import { create } from 'zustand';
import type { CameraMode, ExperienceMode, InfoLevel, Selection, ViewMode } from '@/types';
import { STAGE_BY_ID, JOURNEY } from '@/data/process';
import { presetFor, modesFor } from '@/data/scenes';
import { engine } from '@/simulation/engine';

export type OverlayId =
  | 'search'
  | 'fabmap'
  | 'processmap'
  | 'machines'
  | 'robotics'
  | 'materials'
  | 'glossary'
  | 'about'
  | 'compare'
  | 'failures'
  | 'data'
  | 'loops';

export type PanelTab = 'inspect' | 'machine' | 'ask' | 'data' | 'wafer' | 'sources';

export type UtilityKey = 'electricity' | 'water' | 'air' | 'gases' | 'vacuum' | 'cooling' | 'chemicals' | 'waste';
export type FlowKey = 'wafer' | 'gas' | 'liquid' | 'chemical' | 'electricity' | 'water' | 'waste';
export type LoaderKey = 'environment' | 'database' | 'models' | 'simulation' | 'materials' | 'robots';
export type LoadState = 'pending' | 'loading' | 'done' | 'error';

export interface UIState {
  stageId: string;
  started: boolean;
  experience: ExperienceMode;
  info: InfoLevel;
  cameraMode: CameraMode;
  /** bumps when a camera preset should be re-applied even if the mode is unchanged */
  cameraNonce: number;
  view: ViewMode;
  follow: boolean;
  trace: boolean;
  panelOpen: boolean;
  panelTab: PanelTab;
  railOpen: boolean;
  selection: Selection | null;
  overlay: OverlayId | null;
  airflow: boolean;
  particles: boolean;
  ffuOn: boolean;
  infrastructure: boolean;
  utilities: Record<UtilityKey, boolean>;
  flows: Record<FlowKey, boolean>;
  sound: boolean;
  debug: boolean;
  scaleBar: boolean;
  autoAdvance: boolean;
  quality: 'high' | 'low';
  fallback2D: boolean;
  webgl: 'unknown' | 'ok' | 'none';
  loader: Record<LoaderKey, LoadState>;
  loadedScenes: string[];
  transition: { active: boolean; label: string; sub: string };
  hiddenLayers: Record<string, boolean>;
  cmpDivider: number;
  archFocus: 'planar' | 'finfet' | 'gaa' | null;
  waferOverlay: boolean;
  finale: boolean;
  askTopic: string | null;
  loopId: string | null;

  goToStage: (id: string, opts?: { autoplay?: boolean; keepCamera?: boolean }) => void;
  next: () => void;
  prev: () => void;
  start: (mode: ExperienceMode) => void;
  setExperience: (m: ExperienceMode) => void;
  setInfo: (l: InfoLevel) => void;
  setCamera: (m: CameraMode) => void;
  setView: (v: ViewMode) => void;
  select: (s: Selection | null, openTab?: PanelTab) => void;
  openPanel: (tab: PanelTab) => void;
  closePanel: () => void;
  setOverlay: (o: OverlayId | null) => void;
  toggle: (k: 'airflow' | 'particles' | 'ffuOn' | 'infrastructure' | 'sound' | 'debug' | 'scaleBar' | 'autoAdvance' | 'follow' | 'trace' | 'railOpen' | 'waferOverlay') => void;
  toggleUtility: (k: UtilityKey) => void;
  toggleFlow: (k: FlowKey) => void;
  toggleLayer: (k: string) => void;
  set: (p: Partial<UIState>) => void;
  setLoader: (k: LoaderKey, s: LoadState) => void;
  markSceneLoaded: (id: string) => void;
  ask: (topic: string | null) => void;
}

const defaultCamera = (stageId: string): CameraMode => {
  const st = STAGE_BY_ID[stageId];
  if (!st) return 'factory';
  const first = st.phases[0]?.camera;
  if (first && presetFor(st.scene, st.variant, first)) return first;
  return (modesFor(st.scene, st.variant)[0] as CameraMode) ?? 'factory';
};

export const useUI = create<UIState>((set, get) => ({
  stageId: 'fab-overview',
  started: false,
  experience: 'control',
  info: 2,
  cameraMode: 'factory',
  cameraNonce: 0,
  view: 'normal',
  follow: false,
  trace: false,
  panelOpen: false,
  panelTab: 'inspect',
  railOpen: true,
  selection: null,
  overlay: null,
  airflow: false,
  particles: false,
  ffuOn: true,
  infrastructure: false,
  utilities: { electricity: false, water: false, air: true, gases: false, vacuum: false, cooling: false, chemicals: false, waste: false },
  flows: { wafer: true, gas: false, liquid: false, chemical: false, electricity: false, water: false, waste: false },
  sound: false,
  debug: false,
  scaleBar: true,
  autoAdvance: false,
  quality: 'high',
  fallback2D: false,
  webgl: 'unknown',
  loader: { environment: 'pending', database: 'pending', models: 'pending', simulation: 'pending', materials: 'pending', robots: 'pending' },
  loadedScenes: [],
  transition: { active: false, label: '', sub: '' },
  hiddenLayers: {},
  cmpDivider: 0.5,
  archFocus: null,
  waferOverlay: false,
  finale: false,
  askTopic: null,
  loopId: null,

  goToStage: (id, opts = {}) => {
    const stage = STAGE_BY_ID[id];
    if (!stage) return;
    const prev = STAGE_BY_ID[get().stageId];
    const sceneChange = prev?.scene !== stage.scene;
    engine.setStage(stage, { autoplay: opts.autoplay ?? true });
    const exp = get().experience;
    set((s) => ({
      stageId: id,
      cameraMode: opts.keepCamera && !sceneChange ? s.cameraMode : defaultCamera(id),
      cameraNonce: s.cameraNonce + 1,
      view: 'normal',
      selection: null,
      trace: false,
      archFocus: null,
      finale: false,
      hiddenLayers: {},
      panelOpen: exp === 'learn' ? true : s.panelOpen,
      panelTab: exp === 'learn' ? 'ask' : s.panelTab === 'inspect' && !s.selection ? s.panelTab : s.panelTab,
      transition: sceneChange ? { active: true, label: stage.location, sub: stage.title } : s.transition,
    }));
    if (typeof window !== 'undefined' && get().started) {
      const url = new URL(window.location.href);
      url.searchParams.set('stage', id);
      window.history.replaceState(null, '', url.toString());
    }
  },

  next: () => {
    const i = JOURNEY.findIndex((s) => s.id === get().stageId);
    if (i >= 0 && i < JOURNEY.length - 1) get().goToStage(JOURNEY[i + 1].id);
    else if (i === JOURNEY.length - 1) set({ finale: true });
    else if (i < 0) get().goToStage(JOURNEY[0].id);
  },
  prev: () => {
    const i = JOURNEY.findIndex((s) => s.id === get().stageId);
    if (i > 0) get().goToStage(JOURNEY[i - 1].id);
  },

  start: (mode) => {
    set({ started: true });
    get().setExperience(mode);
    if (mode === 'watch' || mode === 'learn') get().goToStage(JOURNEY[0].id);
    if (mode === 'engineer') get().goToStage('lithography');
    if (mode === 'control') get().goToStage('fab-overview');
  },

  setExperience: (m) => {
    const info: Record<ExperienceMode, InfoLevel> = { watch: 1, control: 2, learn: 3, engineer: 4 };
    engine.player.autoAdvance = m === 'watch' || get().autoAdvance;
    set({
      experience: m,
      info: info[m],
      autoAdvance: m === 'watch' ? true : get().autoAdvance,
      panelOpen: m === 'learn' || m === 'engineer' ? true : m === 'watch' ? false : get().panelOpen,
      panelTab: m === 'learn' ? 'ask' : m === 'engineer' ? 'data' : get().panelTab,
    });
  },
  setInfo: (l) => set({ info: l }),
  setCamera: (m) => set((s) => ({ cameraMode: m, cameraNonce: s.cameraNonce + 1, follow: m === 'wafer' ? true : m === 'machine' || m === 'internal' ? s.follow : false })),
  setView: (v) => set({ view: v }),
  select: (sel, openTab) =>
    set((s) => ({ selection: sel, panelOpen: sel ? true : s.panelOpen, panelTab: openTab ?? (sel ? 'inspect' : s.panelTab) })),
  openPanel: (tab) => set({ panelOpen: true, panelTab: tab }),
  closePanel: () => set({ panelOpen: false }),
  setOverlay: (o) => set({ overlay: o }),
  toggle: (k) => {
    set((s) => ({ [k]: !s[k] }) as Partial<UIState>);
    if (k === 'autoAdvance') engine.player.autoAdvance = get().autoAdvance || get().experience === 'watch';
  },
  toggleUtility: (k) => set((s) => ({ utilities: { ...s.utilities, [k]: !s.utilities[k] } })),
  toggleFlow: (k) => set((s) => ({ flows: { ...s.flows, [k]: !s.flows[k] } })),
  toggleLayer: (k) => set((s) => ({ hiddenLayers: { ...s.hiddenLayers, [k]: !s.hiddenLayers[k] } })),
  set: (p) => set(p),
  setLoader: (k, st) => set((s) => (s.loader[k] === st ? s : { loader: { ...s.loader, [k]: st } })),
  markSceneLoaded: (id) => set((s) => (s.loadedScenes.includes(id) ? s : { loadedScenes: [...s.loadedScenes, id] })),
  ask: (topic) => set({ askTopic: topic, panelOpen: true, panelTab: 'ask' }),
}));

engine.onAdvance = () => useUI.getState().next();
