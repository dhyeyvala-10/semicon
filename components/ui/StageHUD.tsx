'use client';
import { useState } from 'react';
import { useUI } from '@/lib/store';
import { useStage, useTicker } from '@/hooks/useTicker';
import { engine } from '@/simulation/engine';
import { JOURNEY, JOURNEY_LENGTH, MACRO_LABEL, journeyIndex } from '@/data/process';
import { MACHINE_BY_ID } from '@/data/machines';
import { fmt } from '@/lib/math';
import { DataTag, StateChip, WaferGlyph, GlossaryText } from './common';
import { Sparkline } from '../charts/Charts';
import type { WaferSurface } from '@/types';

/** Compact stage header: what is happening, where, on which machine (§104). */
export function StageHUD() {
  useTicker(6);
  const stage = useStage();
  const info = useUI((s) => s.info);
  const ask = useUI((s) => s.ask);
  const select = useUI((s) => s.select);
  const go = useUI((s) => s.goToStage);
  const [pop, setPop] = useState<'changes' | 'inout' | null>(null);
  const i = journeyIndex(stage.id);
  const machine = stage.machine ? MACHINE_BY_ID[stage.machine] : undefined;
  const next = i >= 0 ? JOURNEY[i + 1] : undefined;
  const v = engine.player.view;
  const chans = engine.tele.channels.slice(0, 4);

  return (
    <div className="hud">
      <div className="hud-kicker">
        <span>{i >= 0 ? `PROCESS ${String(i + 1).padStart(2, '0')} / ${JOURNEY_LENGTH}` : 'EXPLORE'}</span>
        <span className="dim">{MACRO_LABEL[stage.macro]}</span>
        {stage.schematic && <span className="dtag CONCEPTUAL">SCHEMATIC</span>}
      </div>
      <div className="hud-title">{stage.title}</div>
      <div className="hud-loc">{stage.location}</div>
      <div className="hud-row">
        {machine && (
          <button className="chip" onClick={() => select({ kind: 'machine', id: machine.id, label: machine.name }, 'machine')} title="Open technical interface">
            ⚙ {machine.name.toUpperCase()}
          </button>
        )}
        {machine && <StateChip state={engine.machineState} />}
        <span className="chip">{v.phase.label.toUpperCase()}</span>
        {next && (
          <button className="chip" onClick={() => go(next.id)} title={next.title}>
            NEXT: {next.short.toUpperCase()} ›
          </button>
        )}
      </div>
      {info >= 2 && (
        <div className="hud-row">
          <button className="btn sm" onClick={() => ask('why')}>WHY?</button>
          <button className="btn sm" onClick={() => ask('how')}>{machine ? 'HOW DOES THIS WORK?' : 'HOW?'}</button>
          {stage.journey !== false && stage.before && (
            <button className={`btn sm ${pop === 'changes' ? 'on' : ''}`} onClick={() => setPop(pop === 'changes' ? null : 'changes')}>WHAT CHANGES?</button>
          )}
          {stage.inputs.length > 0 && (
            <button className={`btn sm ${pop === 'inout' ? 'on' : ''}`} onClick={() => setPop(pop === 'inout' ? null : 'inout')}>IN / OUT</button>
          )}
          <button className="btn sm" onClick={() => ask('what')}>ASK ABOUT THIS</button>
        </div>
      )}
      {stage.modes?.map((m) => (
        <div className="hud-row" key={m.param}>
          <span className="cap">{m.label}</span>
          <div className="seg">
            {m.options.map((o, k) => (
              <button key={o} className={(engine.params[m.param] ?? 0) === k ? 'on' : ''} onClick={() => { engine.setParam(m.param, k); engine.player.restart(); }}>
                {o}
              </button>
            ))}
          </div>
        </div>
      ))}
      {info >= 2 && v.phase.caption && <div className="hud-caption">{v.phase.caption}</div>}
      {info >= 2 && chans.length > 0 && (
        <div className="live-strip">
          {chans.map((c) => (
            <div key={c.def.id} className={`live ${c.status}`} title={`${c.def.label} — ${c.def.kind}`}>
              <div className="k">
                {c.def.label} <DataTag kind={c.def.kind} short />
              </div>
              <div className="v">
                {isFinite(c.value) ? fmt(c.value, c.def.decimals ?? 1) : '—'}
                <small>{c.def.unit}</small>
              </div>
              {info >= 3 && <Sparkline values={c.series().slice(-80)} min={c.def.min} max={c.def.max} color={c.status === 'FAULT' ? '#d03b3b' : c.status === 'WARNING' ? '#fab219' : 'var(--data)'} />}
            </div>
          ))}
        </div>
      )}
      {pop === 'changes' && <WhatChanges onClose={() => setPop(null)} />}
      {pop === 'inout' && <InOut onClose={() => setPop(null)} />}
    </div>
  );
}

function glyphFor(stageId: string, after: boolean): Parameters<typeof WaferGlyph>[0]['surface'] {
  const i = JOURNEY.findIndex((s) => s.id === stageId);
  // walk the journey to find the surface/form before or after this stage
  let surface: WaferSurface = 'none';
  let form = 'material';
  for (let k = 0; k < (after ? i + 1 : i); k++) {
    const e = JOURNEY[k].effect;
    if (e?.surface) surface = e.surface;
    if (e?.form) form = e.form;
  }
  if (form === 'material') return 'material';
  if (form === 'ingot') return 'ingot';
  if (form === 'die') return 'die';
  if (form === 'package') return 'package';
  if (form === 'product') return 'product';
  return surface;
}

/** Before/after scrubber (§112): drives the scene's playback time directly. */
function WhatChanges({ onClose }: { onClose: () => void }) {
  const stage = useStage();
  const [t, setT] = useState(0);
  return (
    <div className="popover" style={{ top: '100%', marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="cap">WHAT CHANGES? · drag to scrub the transformation</span>
        <button className="btn sm ghost" onClick={() => { engine.player.override = null; onClose(); }}>✕</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 8 }}>
        <div>
          <div className="cap">BEFORE</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <WaferGlyph surface={glyphFor(stage.id, false)} size={44} />
            <span style={{ fontSize: 12 }}>{stage.before}</span>
          </div>
        </div>
        <div>
          <div className="cap">AFTER</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <WaferGlyph surface={glyphFor(stage.id, true)} size={44} />
            <span style={{ fontSize: 12 }}>{stage.after}</span>
          </div>
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={t}
        style={{ width: '100%', marginTop: 10, accentColor: 'var(--accent)' }}
        onChange={(e) => {
          const x = Number(e.target.value);
          setT(x);
          engine.player.override = x;
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between' }} className="cap">
        <span>BEFORE</span>
        <button className="btn sm" onClick={() => { engine.player.override = null; onClose(); }}>RESUME LIVE</button>
        <span>AFTER</span>
      </div>
    </div>
  );
}

/** What goes in / out (§113). */
function InOut({ onClose }: { onClose: () => void }) {
  const stage = useStage();
  const machine = stage.machine ? MACHINE_BY_ID[stage.machine] : undefined;
  return (
    <div className="popover" style={{ top: '100%', marginTop: 8, width: 440 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span className="cap">WHAT GOES IN / OUT</span>
        <button className="btn sm ghost" onClick={onClose}>✕</button>
      </div>
      <div className="inout">
        <div className="box">
          <WaferGlyph surface={glyphFor(stage.id, false)} size={40} />
          {stage.inputs.map((x) => (
            <div key={x}>{x}</div>
          ))}
        </div>
        <span className="arrow">→</span>
        <div className="box" style={{ borderColor: 'var(--accent)' }}>
          <div className="cap" style={{ color: 'var(--accent)' }}>{machine ? 'MACHINE' : 'PROCESS'}</div>
          <div style={{ fontWeight: 600 }}>{machine?.name ?? stage.short}</div>
        </div>
        <span className="arrow">→</span>
        <div className="box">
          <WaferGlyph surface={glyphFor(stage.id, true)} size={40} />
          {stage.outputs.map((x) => (
            <div key={x}>{x}</div>
          ))}
        </div>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 10 }}>
        <GlossaryText text={stage.summary} />
      </p>
    </div>
  );
}
