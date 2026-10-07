'use client';
import { useEffect, useState } from 'react';
import { useUI } from '@/lib/store';
import { useStage, useTicker } from '@/hooks/useTicker';
import { engine } from '@/simulation/engine';
import { hoverState, renderStats, scaleState } from '@/lib/runtime';
import { fmt, formatLength, niceFloor } from '@/lib/math';
import { MACHINE_BY_ID } from '@/data/machines';
import type { WaferState } from '@/types';

export const TWIN_STATE_COLOR: Record<WaferState, string> = {
  WAFER_CREATED: '#a7b0a3',
  WAFER_IN_TRANSIT: '#a9c3b4',
  MACHINE_LOADING: '#7fbf6a',
  PROCESSING: '#5fbf5a',
  MACHINE_UNLOADING: '#7fbf6a',
  INSPECTION: '#d6b56a',
  ACCEPTED: '#4fbf3f',
  NEXT_PROCESS: '#a9c3b4',
  DEFECT_DETECTED: '#d64b40',
  REVIEW: '#e8b23a',
  REWORK: '#ec835a',
  SCRAP: '#d64b40',
};

/** Persistent “follow the wafer” identity card (§5, §58). */
export function WaferHUD() {
  useTicker(6);
  const stage = useStage();
  const follow = useUI((s) => s.follow);
  const trace = useUI((s) => s.trace);
  const toggle = useUI((s) => s.toggle);
  const openPanel = useUI((s) => s.openPanel);
  const info = useUI((s) => s.info);
  const tw = engine.twin;
  if (stage.journey === false && stage.scene !== 'fab' && stage.scene !== 'robot') return null;
  if (info < 2) {
    return (
      <div className="waferhud" style={{ width: 'auto', padding: '6px 9px' }}>
        <div className="waferhud-id">
          <span>{tw.displayId}</span>
        </div>
      </div>
    );
  }
  const machine = MACHINE_BY_ID[tw.machine]?.name ?? '—';
  const fabLot = stage.scene === 'fab' ? engine.fab.followedLot() : undefined;
  return (
    <div className="waferhud">
      <div className="cap">{tw.formLabel} · DIGITAL TWIN · SIM</div>
      <div className="waferhud-id">
        <span>{tw.displayId}</span>
        <span className="chip" style={{ color: TWIN_STATE_COLOR[tw.state] }}>
          {tw.state.replace(/_/g, ' ')}
        </span>
      </div>
      <div className="kv">
        <span>Lot</span>
        <span>
          {tw.lotId}
          {tw.form === 'wafer' ? ` · slot ${tw.slot}` : ''}
        </span>
        <span>Stage</span>
        <span>{tw.stageTitle || '—'}</span>
        <span>Equipment</span>
        <span>{machine}</span>
        <span>Location</span>
        <span>{tw.location}</span>
        {tw.form === 'wafer' && (
          <>
            <span>Layers / cycle</span>
            <span>
              {tw.layerCount} layers · mask {tw.maskLayers} · cycle {tw.processCycle}
            </span>
          </>
        )}
        <span>Inspection</span>
        <span>
          {tw.inspection} · {tw.defectCount} defects
        </span>
        <span>Test / package</span>
        <span>
          {tw.testState} · {tw.packageState}
        </span>
        <span>Process time</span>
        <span>{fmt(tw.processTime, 1)} s (playback)</span>
        {fabLot && (
          <>
            <span>Fab lot</span>
            <span>{engine.fab.routeLabel(fabLot)}</span>
          </>
        )}
      </div>
      <div style={{ display: 'flex', gap: 5, marginTop: 8 }}>
        <button className={`btn sm ${follow ? 'on' : ''}`} onClick={() => toggle('follow')}>
          ◎ FOLLOW THIS {tw.form === 'wafer' ? 'WAFER' : tw.formLabel}
        </button>
        <button className={`btn sm ${trace ? 'on' : ''}`} onClick={() => { toggle('trace'); openPanel('wafer'); }}>
          TRACE
        </button>
        <button className="btn sm" onClick={() => openPanel('wafer')}>
          RECORD
        </button>
      </div>
    </div>
  );
}

const LADDER = [10, 1, 0.1, 0.01, 1e-3, 1e-4, 1e-5, 1e-6, 1e-7, 1e-8];
const LADDER_LABEL = ['10 m', '1 m', '10 cm', '1 cm', '1 mm', '100 µm', '10 µm', '1 µm', '100 nm', '10 nm'];

/** Global scale indicator (§64, §106). */
export function ScaleBar() {
  useTicker(8);
  const show = useUI((s) => s.scaleBar);
  if (!show) return null;
  const mpp = scaleState.metersPerPixel;
  const target = mpp * 110;
  const nice = niceFloor(target);
  const px = nice / mpp;
  const view = scaleState.viewWidth;
  const idx = LADDER.reduce((best, v, i) => (Math.abs(Math.log10(v) - Math.log10(view)) < Math.abs(Math.log10(LADDER[best]) - Math.log10(view)) ? i : best), 0);
  return (
    <div className="scalebar" title="Width of the current view and a scale reference">
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span className="cap">SCALE</span>
        <span className="cap" style={{ color: scaleState.schematic ? 'var(--concept)' : 'var(--text-3)' }}>{scaleState.schematic ? 'EDUCATIONAL' : 'TRUE'}</span>
      </div>
      <div className="bar" style={{ width: Math.max(10, Math.min(180, px)) }} />
      <div>{isFinite(nice) && nice > 0 ? formatLength(nice) : '—'}</div>
      <div className="dim">VIEW ≈ {formatLength(view)}</div>
      <div className="ladder" title={LADDER_LABEL.join(' · ')}>
        {LADDER.map((v, i) => (
          <span key={v} className={i === idx ? 'on' : ''} title={LADDER_LABEL[i]} />
        ))}
      </div>
    </div>
  );
}

export function HoverTip() {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useTicker(20);
  useEffect(() => {
    const m = (e: PointerEvent) => setPos({ x: e.clientX, y: e.clientY });
    window.addEventListener('pointermove', m);
    return () => window.removeEventListener('pointermove', m);
  }, []);
  if (!hoverState.label) return null;
  return (
    <div className="hovertip" style={{ left: pos.x, top: pos.y }}>
      <small>{hoverState.kind} · CLICK TO INSPECT</small>
      {hoverState.label}
    </div>
  );
}

/** Hidden developer overlay (§129) — toggle with the ` key or ?debug=1. */
export function DebugOverlay() {
  useTicker(4);
  const debug = useUI((s) => s.debug);
  const loader = useUI((s) => s.loader);
  const loaded = useUI((s) => s.loadedScenes);
  const stage = useStage();
  if (!debug) return null;
  const r = engine.robot;
  return (
    <div className="debug">
      <div>
        <b>DEBUG</b> · ` to close
      </div>
      <div>FPS {fmt(engine.fps, 0)} · DPR {fmt(renderStats.dpr, 2)}</div>
      <div>
        draw calls <b>{renderStats.calls}</b> · tris {fmt(renderStats.triangles / 1000, 0)}k
      </div>
      <div>
        geometries {renderStats.geometries} · textures {renderStats.textures} · programs {renderStats.programs}
      </div>
      <div>active scene <b>{stage.scene}</b> / {stage.variant}</div>
      <div>loaded scenes {loaded.join(', ') || '—'}</div>
      <div>stage {stage.id} · phase {engine.player.view.phaseId} {fmt(engine.player.view.phaseT * 100, 0)}%</div>
      <div>
        wafer {engine.twin.displayId} · {engine.twin.state}
      </div>
      <div>machine {engine.machineState}</div>
      <div>sim time {fmt(engine.time, 1)} s · fab t {fmt(engine.fab.time, 0)} s</div>
      <div>
        robot {r.stepLabel} · {r.sequenceLabel} · {r.error ?? 'OK'}
      </div>
      <div>
        assets{' '}
        {Object.entries(loader)
          .map(([k, v]) => `${k}:${v}`)
          .join(' ')}
      </div>
      <div>telemetry ch {engine.tele.channels.length} · status {engine.tele.status}</div>
    </div>
  );
}
