'use client';
import { useEffect, useRef, useState } from 'react';
import { useUI, type OverlayId } from '@/lib/store';
import { engine } from '@/simulation/engine';
import type { ExperienceMode, InfoLevel } from '@/types';

interface MenuItem {
  label: string;
  hint?: string;
  run: () => void;
}

function useActions() {
  const ui = useUI.getState;
  const go = (id: string) => ui().goToStage(id);
  const ov = (o: OverlayId) => ui().setOverlay(o);
  const journey = (j: number) => {
    engine.setParam('journey', j);
    go('system');
  };
  const menus: { id: string; label: string; items: MenuItem[] }[] = [
    {
      id: 'fab',
      label: 'FAB',
      items: [
        { label: 'Cleanroom overview', hint: 'RUN FAB', run: () => go('fab-overview') },
        { label: 'Fab map', hint: 'MAP', run: () => ov('fabmap') },
        { label: 'Control room', hint: 'LIVE', run: () => go('control-room') },
        { label: 'Utilities cutaway', hint: 'BUILDING', run: () => go('utilities') },
        { label: 'Scale journey', hint: '10 m → 10 nm', run: () => go('scale-journey') },
      ],
    },
    {
      id: 'process',
      label: 'PROCESS',
      items: [
        { label: 'Process map', hint: 'ALL STEPS', run: () => ov('processmap') },
        { label: 'Watch complete manufacturing', hint: 'CINEMATIC', run: () => ui().start('watch') },
        { label: 'Repeated layer cycles', hint: '17 → 19', run: () => go('layer-cycle') },
        { label: 'What if something goes wrong?', hint: 'FAILURES', run: () => ov('failures') },
        { label: 'Comparisons', hint: 'VISUAL', run: () => ov('compare') },
      ],
    },
    { id: 'machines', label: 'MACHINES', items: [{ label: 'Machine map & catalogue', hint: 'GRAPH', run: () => ov('machines') }] },
    {
      id: 'wafer',
      label: 'WAFER',
      items: [
        { label: 'Digital twin record', hint: 'WF-000184', run: () => ui().openPanel('wafer') },
        { label: 'Follow this wafer', hint: 'CAMERA', run: () => ui().toggle('follow') },
        { label: 'Trace wafer path', hint: 'TRACE', run: () => ui().toggle('trace') },
      ],
    },
    {
      id: 'transistors',
      label: 'TRANSISTORS',
      items: [
        { label: 'Transistor formation', run: () => go('transistor') },
        { label: 'Planar · FinFET · GAA', run: () => go('architectures') },
        { label: 'Interconnect stack', run: () => go('metal-stack') },
      ],
    },
    {
      id: 'robotics',
      label: 'ROBOTICS',
      items: [
        { label: 'Robotics ecosystem', hint: 'ALL ROBOTS', run: () => ov('robotics') },
        { label: 'Robot lab (manual control)', run: () => go('robot-lab') },
        { label: 'FOUP → EFEM → tool', run: () => go('cleanroom-entry') },
      ],
    },
    {
      id: 'cpugpu',
      label: 'CPU / GPU',
      items: [
        { label: 'CPU journey', hint: 'WAFER → COMPUTER', run: () => journey(0) },
        { label: 'GPU journey', hint: 'WAFER → SERVER', run: () => journey(1) },
      ],
    },
    {
      id: 'materials',
      label: 'MATERIALS',
      items: [
        { label: 'Materials catalogue', run: () => ov('materials') },
        { label: 'From quartz to silicon', run: () => go('quartz') },
      ],
    },
    {
      id: 'supply',
      label: 'SUPPLY CHAIN',
      items: [
        { label: 'Machine supply chain', hint: 'GRAPH', run: () => go('supply-chain') },
        { label: 'Global logistics', hint: 'GLOBE', run: () => go('distribution') },
      ],
    },
    {
      id: 'data',
      label: 'DATA',
      items: [
        { label: 'Fab dashboard', hint: 'SIM', run: () => ov('data') },
        { label: 'Control loops & feedback', hint: 'PID · R2R', run: () => ov('loops') },
      ],
    },
    { id: 'glossary', label: 'GLOSSARY', items: [{ label: 'Glossary', run: () => ov('glossary') }] },
    { id: 'about', label: 'ABOUT', items: [{ label: 'About, data & sources', run: () => ov('about') }] },
  ];
  return menus;
}

export function TopBar() {
  const menus = useActions();
  const [open, setOpen] = useState<string | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const experience = useUI((s) => s.experience);
  const info = useUI((s) => s.info);
  const sound = useUI((s) => s.sound);
  const setExperience = useUI((s) => s.setExperience);
  const setInfo = useUI((s) => s.setInfo);
  const toggle = useUI((s) => s.toggle);
  const setOverlay = useUI((s) => s.setOverlay);
  const fallback = useUI((s) => s.fallback2D);
  const set = useUI((s) => s.set);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);

  const exps: [ExperienceMode, string][] = [
    ['watch', 'WATCH'],
    ['control', 'CONTROL'],
    ['learn', 'LEARN'],
    ['engineer', 'ENGINEER'],
  ];
  return (
    <div className="topbar" ref={ref}>
      <div className="brand" onClick={() => set({ started: false })} title="Back to the entrance">
        <i />
        <b>FAB/TWIN</b>
        <span>SEMICONDUCTOR DIGITAL TWIN</span>
      </div>
      <nav className="nav">
        {menus.map((m) => (
          <div className="nav-item" key={m.id}>
            <button
              className={open === m.id ? 'on' : ''}
              onClick={(e) => {
                if (m.items.length === 1) {
                  m.items[0].run();
                  setOpen(null);
                  return;
                }
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setPos({ x: r.left, y: r.bottom + 4 });
                setOpen(open === m.id ? null : m.id);
              }}
            >
              {m.label}
            </button>
            {open === m.id && (
              <div className="nav-menu" style={{ left: pos.x, top: pos.y }}>
                {m.items.map((it) => (
                  <button
                    key={it.label}
                    onClick={() => {
                      it.run();
                      setOpen(null);
                    }}
                  >
                    <span>{it.label}</span>
                    <span>{it.hint ?? ''}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>
      <div className="topbar-right">
        <div className="seg" title="Experience mode">
          {exps.map(([k, l]) => (
            <button key={k} className={experience === k ? 'on' : ''} onClick={() => setExperience(k)}>
              {l}
            </button>
          ))}
        </div>
        <div className="seg" title="Information layer: 1 visual · 2 labels · 3 technical · 4 deep dive">
          {([1, 2, 3, 4] as InfoLevel[]).map((l) => (
            <button key={l} className={info === l ? 'on' : ''} onClick={() => setInfo(l)} title={['VISUAL ONLY', 'VISUAL + LABELS', 'ENGINEERING', 'DEEP DIVE'][l - 1]}>
              L{l}
            </button>
          ))}
        </div>
        <button className="btn icon" title="Search (Ctrl+K)" onClick={() => setOverlay('search')}>
          ⌕
        </button>
        <button className={`btn icon ${sound ? 'on' : ''}`} title={sound ? 'Sound on' : 'Sound off'} onClick={() => toggle('sound')}>
          {sound ? '♪' : '∅'}
        </button>
        <button className={`btn sm ${fallback ? 'on' : ''}`} title="2D technical view (fallback)" onClick={() => set({ fallback2D: !fallback })}>
          2D
        </button>
      </div>
    </div>
  );
}
