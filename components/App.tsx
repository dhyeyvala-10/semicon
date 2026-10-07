'use client';
/**
 * Application root: runtime checks, real loading pipeline, keyboard shortcuts,
 * layout of the 3D world and the technical interface around it.
 */
import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useUI } from '@/lib/store';
import { engine } from '@/simulation/engine';
import { STAGE_BY_ID } from '@/data/process';
import { RobotController, STATIONS } from '@/simulation/robot';
import { startAudio, stopAudio } from '@/lib/audio';
import { TopBar } from './ui/TopBar';
import { ProcessRail } from './ui/Rail';
import { StageHUD } from './ui/StageHUD';
import { Transport, Toolbar } from './ui/Controls';
import { WaferHUD, ScaleBar, HoverTip, DebugOverlay } from './ui/Hud';
import { SidePanel } from './ui/SidePanel';
import { Overlays } from './ui/Overlays';
import { Loader, TransitionVeil, Finale } from './ui/Screens';
import { Landing } from './ui/Landing';
import { GradeDriver, GradeOverlay } from './ui/Grade';
import { Fallback2D } from './fallback/Fallback2D';

const Stage3D = dynamic(() => import('./3d/Stage3D'), { ssr: false });

/** StrictMode mounts effects twice in development — initialise exactly once. */
let initialised = false;

function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export default function App() {
  const started = useUI((s) => s.started);
  const panelOpen = useUI((s) => s.panelOpen);
  const railOpen = useUI((s) => s.railOpen);
  const cameraMode = useUI((s) => s.cameraMode);
  const fallback = useUI((s) => s.fallback2D);
  const webgl = useUI((s) => s.webgl);
  const sound = useUI((s) => s.sound);

  // runtime checks + loading pipeline
  useEffect(() => {
    if (initialised) return;
    initialised = true;
    const ui = useUI.getState();
    // developer handle for the console and automated checks (§129)
    (window as unknown as { fabTwin: unknown }).fabTwin = { engine, ui: useUI };
    const params = new URLSearchParams(window.location.search);
    const gl = hasWebGL();
    const mobile = window.matchMedia('(max-width: 860px), (pointer: coarse)').matches;
    ui.set({
      webgl: gl ? 'ok' : 'none',
      fallback2D: !gl || params.get('mode') === '2d',
      quality: mobile || params.get('quality') === 'low' ? 'low' : 'high',
      debug: params.get('debug') === '1',
      railOpen: !mobile,
    });
    if (!gl) {
      ui.setLoader('environment', 'error');
      ui.setLoader('models', 'done');
      ui.setLoader('materials', 'done');
    } else ui.setLoader('environment', 'loading');

    // process database → build the search index over every data module
    ui.setLoader('database', 'loading');
    import('@/lib/search')
      .then((m) => {
        m.buildIndex();
        useUI.getState().setLoader('database', 'done');
      })
      .catch(() => useUI.getState().setLoader('database', 'error'));

    // robot system: verify kinematics reach every station
    ui.setLoader('robots', 'loading');
    const test = new RobotController();
    const ok = Object.values(STATIONS).every((s) => {
      test.setState(s.th, s.r, s.z, 'foup', false);
      const e = test.effector();
      return Math.abs(Math.hypot(e.x, e.z) - s.r) < 1e-6;
    });
    ui.setLoader('robots', ok ? 'done' : 'error');

    // simulation
    ui.setLoader('simulation', 'loading');
    engine.start();
    const unsub = engine.subscribe(() => {
      if (engine.frame > 2) {
        useUI.getState().setLoader('simulation', 'done');
        unsub();
      }
    });

    // deep link
    const st = params.get('stage');
    if (st && STAGE_BY_ID[st]) {
      ui.set({ started: true });
      ui.goToStage(st);
    } else {
      ui.goToStage('fab-overview');
    }
    const exp = params.get('exp');
    if (exp === 'watch' || exp === 'learn' || exp === 'engineer' || exp === 'control') ui.setExperience(exp);
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUI.getState();
      const tag = (e.target as HTMLElement)?.tagName;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ui.setOverlay(ui.overlay === 'search' ? null : 'search');
        return;
      }
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') {
        if (ui.overlay) ui.setOverlay(null);
        else if (ui.panelOpen) ui.closePanel();
        else ui.select(null);
      } else if (e.key === '`') ui.toggle('debug');
      else if (e.key === ' ') {
        e.preventDefault();
        const p = engine.player;
        if (p.completed) p.restart();
        else p.playing = !p.playing;
      } else if (e.key === 'ArrowRight') {
        if (e.shiftKey) ui.next();
        else engine.player.step();
      } else if (e.key === 'ArrowLeft') {
        if (e.shiftKey) ui.prev();
        else engine.player.stepBack();
      } else if (['1', '2', '3', '4'].includes(e.key)) ui.setInfo(Number(e.key) as 1 | 2 | 3 | 4);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // sound
  useEffect(() => {
    if (sound) startAudio();
    else stopAudio();
  }, [sound]);

  // completion screen when the final stage finishes
  useEffect(() => {
    const id = setInterval(() => {
      const ui = useUI.getState();
      if (engine.stage.id === 'ecosystem' && engine.player.completed && !ui.finale && ui.started) ui.set({ finale: true });
    }, 500);
    return () => clearInterval(id);
  }, []);

  const cls = ['app', panelOpen ? 'panel-open' : '', railOpen ? '' : 'rail-collapsed', cameraMode === 'data' ? 'data-mode' : ''].join(' ');
  return (
    <div className={cls}>
      {!fallback && webgl !== 'none' && <Stage3D />}
      {fallback && <Fallback2D />}
      <GradeOverlay />
      <GradeDriver />
      <TopBar />
      {started && (
        <>
          <ProcessRail />
          <StageHUD />
          <WaferHUD />
          <Toolbar />
          <Transport />
          <ScaleBar />
        </>
      )}
      <SidePanel />
      <Landing />
      <TransitionVeil />
      <Finale />
      <Overlays />
      <HoverTip />
      <DebugOverlay />
      <Loader />
    </div>
  );
}
