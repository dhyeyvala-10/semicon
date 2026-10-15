'use client';
/**
 * Application root: runtime checks, the loading pipeline and the two ways through:
 * the scroll story (default) and Explore (free 3D). Nothing else is on screen.
 */
import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useUI } from '@/lib/store';
import { engine } from '@/simulation/engine';
import { STAGE_BY_ID } from '@/data/process';
import { CHAPTER_OF_STAGE } from '@/data/chapters';
import { getQuality } from '@/lib/quality';
import { TopBar } from './ui/TopBar';
import { Loader, TransitionVeil } from './ui/Screens';
import { Story } from './story/Story';
import { Explore } from './explore/Explore';
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
  const fallback = useUI((s) => s.fallback2D);
  const webgl = useUI((s) => s.webgl);

  useEffect(() => {
    if (initialised) return;
    initialised = true;
    const ui = useUI.getState();
    // developer handle for the console and automated checks (Stage3D adds gl, scene, camera, r3f)
    const w = window as unknown as { fabTwin?: object };
    w.fabTwin = Object.assign(w.fabTwin ?? {}, { engine, ui: useUI });
    const params = new URLSearchParams(window.location.search);
    const gl = hasWebGL();
    ui.set({
      webgl: gl ? 'ok' : 'none',
      fallback2D: !gl || params.get('mode') === '2d',
      quality: getQuality().mobile ? 'low' : 'high',
    });
    if (!gl) {
      ui.setLoader('environment', 'error');
      ui.setLoader('models', 'done');
      ui.setLoader('materials', 'done');
    } else ui.setLoader('environment', 'loading');
    // nothing to fetch or index any more: the text lives in data/chapters.ts
    ui.setLoader('database', 'done');
    ui.setLoader('robots', 'done');

    // simulation
    ui.setLoader('simulation', 'loading');
    engine.start();
    const unsub = engine.subscribe(() => {
      if (engine.frame > 2) {
        useUI.getState().setLoader('simulation', 'done');
        unsub();
      }
    });

    // deep link: ?stage=<a chapter's stage> opens Explore there; otherwise the story
    const st = params.get('stage');
    if (st && STAGE_BY_ID[st] && CHAPTER_OF_STAGE[st] && !params.has('mode')) {
      ui.set({ started: true });
      ui.goToStage(st);
    } else ui.goToStage('fab-overview');
  }, []);

  const three = !fallback && webgl !== 'none';
  return (
    <div className="app">
      {three && <Stage3D />}
      {fallback && <Fallback2D />}
      <GradeOverlay />
      <GradeDriver />
      <TopBar />
      {!started && <Story />}
      {started && three && <Explore />}
      {started && <TransitionVeil />}
      <Loader />
    </div>
  );
}
