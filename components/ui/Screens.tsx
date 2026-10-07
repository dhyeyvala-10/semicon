'use client';
import { useEffect, useState } from 'react';
import { useUI, type LoaderKey } from '@/lib/store';
import { engine } from '@/simulation/engine';
import { JOURNEY } from '@/data/process';

const STEPS: [LoaderKey, string][] = [
  ['environment', '3D Environment'],
  ['database', 'Process Database'],
  ['models', 'Machine Models'],
  ['simulation', 'Simulation'],
  ['materials', 'Material System'],
  ['robots', 'Robot System'],
];

/** Initial loader — every row reflects a real loading step (§128). */
export function Loader() {
  const loader = useUI((s) => s.loader);
  const webgl = useUI((s) => s.webgl);
  const [gone, setGone] = useState(false);
  const done = STEPS.every(([k]) => loader[k] === 'done' || loader[k] === 'error');
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setGone(true), 500);
    return () => clearTimeout(t);
  }, [done]);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (gone) {
      const t = setTimeout(() => setHidden(true), 900);
      return () => clearTimeout(t);
    }
  }, [gone]);
  if (hidden) return null;
  return (
    <div className={`loader ${gone ? 'gone' : ''}`}>
      <div className="loader-box">
        <div className="loader-title">INITIALIZING FAB</div>
        {STEPS.map(([k, label]) => {
          const s = loader[k];
          return (
            <div className="loader-row" key={k}>
              <span className={`s-${s}`}>{s === 'done' ? '✓' : s === 'loading' ? '◌' : s === 'error' ? '✕' : '·'}</span>
              <span>{label}</span>
              <span className={`s-${s}`}>{s === 'error' && k === 'environment' ? 'WEBGL UNAVAILABLE → 2D' : s.toUpperCase()}</span>
            </div>
          );
        })}
        {webgl === 'none' && <div className="note">WebGL is not available — the complete journey is shown as a 2D technical visualisation.</div>}
      </div>
    </div>
  );
}

export function TransitionVeil() {
  const t = useUI((s) => s.transition);
  // failsafe: never leave the veil up if a scene fails to report ready
  useEffect(() => {
    if (!t.active) return;
    const id = setTimeout(() => useUI.getState().set({ transition: { ...useUI.getState().transition, active: false } }), 6000);
    return () => clearTimeout(id);
  }, [t.active]);
  return (
    <div className={`transition-veil ${t.active ? 'on' : ''}`}>
      <div className="t1">ENTERING · {t.label}</div>
      <div className="t2">{t.sub}</div>
    </div>
  );
}

/** Completion screen (§138). */
export function Finale() {
  const finale = useUI((s) => s.finale);
  const set = useUI((s) => s.set);
  const go = useUI((s) => s.goToStage);
  const setOverlay = useUI((s) => s.setOverlay);
  const setExperience = useUI((s) => s.setExperience);
  if (!finale) return null;
  return (
    <div className="finale">
      <div>
        <div className="sub">ONE CHIP IS THE RESULT OF AN ENTIRE INDUSTRIAL ECOSYSTEM</div>
        <h1>SEMICONDUCTOR FABRICATION</h1>
        <div className="cap" style={{ fontSize: 13, letterSpacing: '0.3em', color: 'var(--text-2)' }}>
          FROM MATERIAL · TO COMPUTATION
        </div>
        <div className="row">
          <button
            className="btn primary"
            onClick={() => {
              set({ finale: false });
              engine.twin.reset();
              go(JOURNEY[0].id);
            }}
          >
            RESTART
          </button>
          <button className="btn" onClick={() => { set({ finale: false }); setExperience('control'); go('fab-overview'); }}>EXPLORE FAB</button>
          <button className="btn" onClick={() => { set({ finale: false }); setOverlay('machines'); }}>EXPLORE MACHINES</button>
          <button className="btn" onClick={() => { set({ finale: false }); setOverlay('robotics'); }}>EXPLORE ROBOTICS</button>
          <button className="btn" onClick={() => { set({ finale: false }); setExperience('engineer'); go('lithography'); }}>DEEP DIVE</button>
        </div>
      </div>
    </div>
  );
}
