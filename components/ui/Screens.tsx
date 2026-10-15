'use client';
/**
 * Full-screen states: the first-load screen and the fade used between scenes in Explore.
 */
import { useEffect, useState } from 'react';
import { useUI, type LoaderKey } from '@/lib/store';
import { CHAPTERS, CHAPTER_OF_STAGE } from '@/data/chapters';
import { Logo } from '../story/Logo';

const KEYS: LoaderKey[] = ['environment', 'database', 'models', 'simulation', 'materials', 'robots'];
/** never keep the visitor waiting on a step that fails to report */
const MAX_WAIT_MS = 20000;

/** First-load screen: logo and one thin bar that follows the real loading steps. */
export function Loader() {
  const loader = useUI((s) => s.loader);
  const webgl = useUI((s) => s.webgl);
  const fallback = useUI((s) => s.fallback2D);
  const [timedOut, setTimedOut] = useState(false);
  const [hidden, setHidden] = useState(false);
  const settled = KEYS.filter((k) => loader[k] === 'done' || loader[k] === 'error').length;
  // ready once the first 3D scene has drawn (or there is no 3D to wait for)
  const ready = timedOut || fallback || webgl === 'none' || loader.models === 'done' || settled === KEYS.length;
  useEffect(() => {
    const id = setTimeout(() => setTimedOut(true), MAX_WAIT_MS);
    return () => clearTimeout(id);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const id = setTimeout(() => setHidden(true), 360);
    return () => clearTimeout(id);
  }, [ready]);
  if (hidden) return null;
  const p = ready ? 1 : Math.max(0.08, settled / KEYS.length);
  return (
    <div className={`loader ${ready ? 'gone' : ''}`} role="status" aria-label="Loading">
      <div className="loader-box">
        <div className="loader-logo">
          <Logo />
        </div>
        <div className="loader-bar">
          <i style={{ transform: `scaleX(${p})` }} />
        </div>
        <p className="loader-note">Loading the 3D factory</p>
      </div>
    </div>
  );
}

/** Quick fade between scenes in Explore, naming the step that is loading. */
export function TransitionVeil() {
  const t = useUI((s) => s.transition);
  const stageId = useUI((s) => s.stageId);
  // failsafe: never leave the veil up if a scene fails to report ready
  useEffect(() => {
    if (!t.active) return;
    const id = setTimeout(() => useUI.getState().set({ transition: { ...useUI.getState().transition, active: false } }), 6000);
    return () => clearTimeout(id);
  }, [t.active]);
  const ch = CHAPTER_OF_STAGE[stageId];
  const n = ch ? CHAPTERS.indexOf(ch) + 1 : 0;
  return (
    <div className={`transition-veil ${t.active ? 'on' : ''}`} aria-hidden={!t.active}>
      <div className="veil-box">
        {n > 0 && (
          <span className="veil-step">
            Step {n} of {CHAPTERS.length}
          </span>
        )}
        <span className="veil-title">{ch ? ch.title : t.sub}</span>
        <span className="veil-bar">
          <i />
        </span>
      </div>
    </div>
  );
}
