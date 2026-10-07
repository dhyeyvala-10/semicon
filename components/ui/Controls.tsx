'use client';
import { useRef, useState } from 'react';
import { useUI } from '@/lib/store';
import { useStage, useTicker } from '@/hooks/useTicker';
import { engine } from '@/simulation/engine';
import { JOURNEY, stageDuration } from '@/data/process';
import { modesFor } from '@/data/scenes';
import { FAILURE_BY_ID } from '@/data/failures';
import { CONTROL_LOOPS } from '@/simulation/control';
import { fmt } from '@/lib/math';
import type { CameraMode, ViewMode } from '@/types';

/** PLAY · PAUSE · STEP · RESTART · SPEED · scrub with phase markers (§61, §100). */
export function Transport() {
  useTicker(15);
  const stage = useStage();
  const autoAdvance = useUI((s) => s.autoAdvance);
  const experience = useUI((s) => s.experience);
  const toggle = useUI((s) => s.toggle);
  const next = useUI((s) => s.next);
  const prev = useUI((s) => s.prev);
  const p = engine.player;
  const scrub = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; label: string } | null>(null);
  const total = stageDuration(stage);
  const v = p.view;
  const inJourney = JOURNEY.some((s) => s.id === stage.id);

  const seekFromEvent = (clientX: number) => {
    const r = scrub.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    p.seek(f * total);
  };
  const speeds = [0.25, 0.5, 1, 2, 4];

  return (
    <div className="transport">
      <div className="transport-row">
        {inJourney && <button className="btn icon sm" title="Previous stage" onClick={prev}>⏮</button>}
        <button className="btn icon sm" title="Restart stage" onClick={() => p.restart()}>↺</button>
        <button className="btn icon sm" title="Step back one operation" onClick={() => p.stepBack()}>◂</button>
        <button
          className={`btn icon ${p.playing && !p.completed ? 'on' : ''}`}
          title={p.playing ? 'Pause' : 'Play'}
          onClick={() => {
            if (p.completed) p.restart();
            else p.playing = !p.playing;
            p.stepTarget = null;
          }}
        >
          {p.playing && !p.completed ? '❚❚' : '▶'}
        </button>
        <button className="btn sm" title="Execute one operation, then pause" onClick={() => p.step()}>
          STEP {String(v.phaseIndex + 1).padStart(2, '0')}
        </button>
        {inJourney && <button className="btn icon sm" title="Next stage" onClick={next}>⏭</button>}
        <span className="phase-label">
          {String(v.phaseIndex + 1).padStart(2, '0')}/{String(stage.phases.length).padStart(2, '0')} · {v.phase.label.toUpperCase()} · {fmt(v.t, 1)} / {fmt(total, 1)} s
          {p.override !== null ? ' · SCRUB' : ''}
        </span>
        <div className="seg" title="Playback speed">
          {speeds.map((s) => (
            <button key={s} className={p.speed === s ? 'on' : ''} onClick={() => (p.speed = s)}>
              {s < 1 ? `${s}` : `${s}×`}
            </button>
          ))}
        </div>
        {inJourney && (
          <button className={`btn sm ${autoAdvance || experience === 'watch' ? 'on' : ''}`} title="Continue automatically to the next stage" onClick={() => toggle('autoAdvance')}>
            AUTO
          </button>
        )}
      </div>
      <div
        className="scrub"
        ref={scrub}
        onMouseDown={(e) => {
          seekFromEvent(e.clientX);
          const move = (ev: MouseEvent) => seekFromEvent(ev.clientX);
          const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
          };
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
        }}
        onMouseMove={(e) => {
          const r = scrub.current!.getBoundingClientRect();
          const f = (e.clientX - r.left) / r.width;
          let acc = 0;
          let label = '';
          for (const ph of stage.phases) {
            if (f * total >= acc) label = ph.label;
            acc += ph.duration;
          }
          setHover({ x: e.clientX - r.left, label });
        }}
        onMouseLeave={() => setHover(null)}
      >
        <div className="scrub-track">
          {stage.phases.map((ph, k) => {
            const fill = k < v.phaseIndex ? 1 : k === v.phaseIndex ? v.phaseT : 0;
            return (
              <div key={ph.id + k} className={`scrub-seg ${k === v.phaseIndex ? 'cur' : ''}`} style={{ flex: ph.duration }} title={ph.label}>
                <div style={{ transform: `scaleX(${fill})` }} />
              </div>
            );
          })}
        </div>
        <div className="scrub-head" style={{ left: `calc(${(v.t / total) * 100}% - 1px)` }} />
        {hover && (
          <div className="scrub-tip" style={{ left: hover.x }}>
            {hover.label}
          </div>
        )}
      </div>
    </div>
  );
}

const CAM_LABEL: Record<CameraMode, string> = {
  factory: 'FACTORY',
  machine: 'MACHINE',
  internal: 'INTERNAL',
  wafer: 'WAFER',
  micro: 'MICROSCOPIC',
  transistor: 'TRANSISTOR',
  data: 'DATA',
};
const VIEW_LABEL: Record<ViewMode, string> = { normal: 'NORMAL', xray: 'X-RAY', cutaway: 'CUTAWAY', exploded: 'EXPLODED', section: 'CROSS-SECTION' };

/** Camera modes, view modes, scene layers, maintenance, failure injection (§7, §63, §74, §107). */
export function Toolbar() {
  useTicker(4);
  const stage = useStage();
  const cameraMode = useUI((s) => s.cameraMode);
  const setCamera = useUI((s) => s.setCamera);
  const view = useUI((s) => s.view);
  const setView = useUI((s) => s.setView);
  const follow = useUI((s) => s.follow);
  const trace = useUI((s) => s.trace);
  const toggle = useUI((s) => s.toggle);
  const ui = useUI();
  const goToStage = useUI((s) => s.goToStage);
  const modes = modesFor(stage.scene, stage.variant) as CameraMode[];
  const views: ViewMode[] = stage.views ?? ['normal'];
  const failure = engine.failure;
  const maint = engine.machineOverride === 'MAINTENANCE';
  const loop = CONTROL_LOOPS.find((l) => l.machine === stage.machine);

  return (
    <div className="toolbar">
      <div className="tool-group">
        <div className="cap">CAMERA</div>
        {modes.map((m) => (
          <button
            key={m}
            className={`btn sm ${cameraMode === m ? 'on' : ''}`}
            onClick={() => {
              if (m === 'transistor' && stage.scene !== 'transistor' && stage.scene !== 'interconnect' && stage.scene !== 'system') {
                goToStage('transistor');
                return;
              }
              setCamera(m);
            }}
          >
            {CAM_LABEL[m]}
          </button>
        ))}
        {!modes.includes('transistor') && (
          <button className="btn sm" title="Dive to the transistor level" onClick={() => goToStage('transistor')}>
            TRANSISTOR ›
          </button>
        )}
        <button className={`btn sm ${follow ? 'on' : ''}`} onClick={() => toggle('follow')} title="Camera follows the tracked wafer / object">
          ◎ FOLLOW
        </button>
      </div>
      {views.length > 1 && (
        <div className="tool-group">
          <div className="cap">VIEW</div>
          {views.map((v) => (
            <button key={v} className={`btn sm ${view === v ? 'on' : ''}`} onClick={() => setView(v)}>
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
      )}
      {stage.scene === 'fab' && (
        <div className="tool-group">
          <div className="cap">FAB LAYERS</div>
          <button className={`btn sm ${ui.airflow ? 'on' : ''}`} onClick={() => toggle('airflow')}>AIRFLOW</button>
          <button className={`btn sm ${ui.particles ? 'on' : ''}`} onClick={() => toggle('particles')}>PARTICLES</button>
          {ui.particles && (
            <button className={`btn sm ${!ui.ffuOn ? 'danger' : ''}`} onClick={() => toggle('ffuOn')}>{ui.ffuOn ? 'FFU: ON' : 'FFU: OFF'}</button>
          )}
          <button className={`btn sm ${ui.infrastructure ? 'on' : ''}`} onClick={() => toggle('infrastructure')}>INFRASTRUCTURE</button>
          <button className={`btn sm ${trace ? 'on' : ''}`} onClick={() => toggle('trace')}>TRACE LOT</button>
          <button className={`btn sm ${engine.fabRunning ? 'on' : ''}`} onClick={() => (engine.fabRunning = !engine.fabRunning)}>
            {engine.fabRunning ? 'RUN FAB ●' : 'RUN FAB ○'}
          </button>
        </div>
      )}
      {stage.machine && (
        <div className="tool-group">
          <div className="cap">EQUIPMENT</div>
          <button className={`btn sm ${maint ? 'on' : ''}`} onClick={() => engine.setMaintenance(!maint)}>
            {maint ? 'END MAINTENANCE' : 'MAINTENANCE'}
          </button>
          {loop && (
            <button className="btn sm" onClick={() => { useUI.getState().set({ loopId: loop.id }); useUI.getState().setOverlay('loops'); }}>
              CONTROL LOOP
            </button>
          )}
        </div>
      )}
      {(stage.failures?.length ?? 0) > 0 && (
        <div className="tool-group">
          <div className="cap">WHAT IF?</div>
          {!failure &&
            stage.failures!.map((f) => (
              <button key={f} className="btn sm danger" onClick={() => { engine.injectFailure(f); useUI.getState().openPanel('data'); }}>
                ⚠ {FAILURE_BY_ID[f]?.title.toUpperCase()}
              </button>
            ))}
          {failure && (
            <>
              <span className="chip" style={{ color: failure.phase === 'DISPOSITION' ? '#ff7a6e' : 'var(--warn)' }}>{failure.phase}</span>
              <button className="btn sm" onClick={() => engine.resetFailure()}>RESET PROCESS</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
