'use client';
/**
 * 2D technical visualisation (§125) — used when WebGL is unavailable or the visitor
 * chooses 2D. Same engine, same stage player, same data: process flow, animated
 * cross-section, transformation and live telemetry.
 */
import type { ReactElement } from 'react';
import { useStage, useTicker } from '@/hooks/useTicker';
import { engine } from '@/simulation/engine';
import { useUI } from '@/lib/store';
import { MACHINE_BY_ID } from '@/data/machines';
import { JOURNEY } from '@/data/process';
import { dealGrove, etchProfile, spinRecipe, cmpStepHeight, IMPLANT, implantIons } from '@/simulation/models';
import { GlossaryText, WaferGlyph } from '../ui/common';
import { ChannelCard } from '../ui/SidePanel';
import { clamp } from '@/lib/math';

const W = 520;
const H = 220;

/** Cross-section of the top ~1 µm of the wafer for FEOL steps (schematic). */
function Section({ id, phaseId, phaseT, stageT }: { id: string; phaseId: string; phaseT: number; stageT: number }) {
  const base = 150; // y of original silicon surface
  const layers: ReactElement[] = [];
  const si = <rect key="si" x={0} y={base} width={W} height={H - base} fill="#59606a" />;
  const label = (t: string, y: number) => (
    <text key={t + y} x={W - 6} y={y} textAnchor="end" fill="#a3adb5" fontSize={10} fontFamily="var(--mono)">
      {t}
    </text>
  );
  if (id === 'oxidation') {
    const hours = phaseId === 'oxidize' ? phaseT : ['anneal', 'cool', 'unload'].includes(phaseId) ? 1 : 0;
    const tox = dealGrove(hours, 1000) * 1000; // nm
    const px = tox * 0.9;
    layers.push(<rect key="si" x={0} y={base + px * 0.44} width={W} height={H} fill="#59606a" />);
    layers.push(<rect key="ox" x={0} y={base - px * 0.56} width={W} height={px} fill="#5f86b8" />);
    layers.push(<line key="orig" x1={0} x2={W} y1={base} y2={base} stroke="#fff" strokeDasharray="4 4" opacity={0.5} />);
    layers.push(label(`SiO₂ ${tox.toFixed(1)} nm`, base - px * 0.56 - 4));
    layers.push(label('original surface', base - 3));
    return <>{layers}</>;
  }
  layers.push(si);
  if (id === 'deposition' || id === 'deposition-2') {
    const t = phaseId === 'deposit' ? phaseT : ['purge', 'unload'].includes(phaseId) ? 1 : 0;
    layers.push(<rect key="f" x={0} y={base - 50 * t} width={W} height={50 * t} fill="#a8946a" />);
    layers.push(label('deposited film', base - 50 * t - 4));
  }
  if (id === 'resist-coat' || id === 'soft-bake') {
    const th = id === 'soft-bake' ? 110 : spinRecipe(phaseId, phaseT).thickness;
    const px = clamp(th / 25, 0, 90);
    layers.push(<rect key="r" x={0} y={base - px} width={W} height={px} fill="#a6582a" />);
    layers.push(label(`resist ${th.toFixed(0)} nm`, base - px - 4));
  }
  if (id === 'lithography' || id === 'development') {
    const exposed = id === 'development' ? 1 : phaseId === 'expose' ? phaseT : phaseId === 'swap' ? 0 : 1;
    const dissolve = id === 'development' ? (phaseId === 'develop' ? phaseT : phaseId === 'rinse' ? 1 : 0) : 0;
    for (let k = 0; k < 6; k++) {
      const x = k * (W / 6);
      layers.push(<rect key={`u${k}`} x={x} y={base - 40} width={W / 12} height={40} fill="#a6582a" />);
      layers.push(<rect key={`e${k}`} x={x + W / 12} y={base - 40 + 40 * dissolve} width={W / 12} height={40 * (1 - dissolve)} fill={exposed > k / 6 ? '#d99545' : '#a6582a'} />);
    }
    layers.push(label(id === 'development' ? 'exposed resist dissolves' : 'latent image', base - 46));
  }
  if (id === 'etch' || id === 'resist-strip') {
    const wet = engine.params.etchMode === 1;
    const prof = etchProfile(phaseId, phaseT, wet);
    const d = id === 'resist-strip' ? 70 : prof.depth * 0.6;
    const resistH = id === 'resist-strip' ? 30 * (phaseId === 'ash' ? 1 - phaseT : phaseId === 'load' ? 1 : 0) : 30;
    for (let k = 0; k < 6; k++) {
      const x = k * (W / 6);
      layers.push(<rect key={`r${k}`} x={x} y={base - 70 - resistH} width={W / 12} height={resistH} fill="#a6582a" />);
      layers.push(<rect key={`f${k}`} x={x} y={base - 70} width={W / 12 + (W / 12) * (1 - Math.min(1, d / 70))} height={70} fill="#5f86b8" />);
    }
    layers.push(label(wet ? 'wet: isotropic' : 'dry: anisotropic', base - 104));
  }
  if (id === 'implant' || id === 'anneal') {
    const n = id === 'implant' ? Math.floor(260 * (phaseId === 'implant' ? phaseT : phaseId === 'unload' ? 1 : 0)) : 260;
    const ions = implantIons(260);
    for (let k = 0; k < n; k++) {
      const ion = ions[k];
      const x = ion.x * W;
      const masked = Math.floor(ion.x * 6) % 2 === 0;
      if (masked) continue;
      layers.push(<circle key={`i${k}`} cx={x} cy={base + ion.depth * 0.6} r={2} fill={id === 'anneal' && stageT > 0.5 ? '#e8a23a' : '#c9cdd2'} />);
    }
    if (id === 'implant')
      for (let k = 0; k < 6; k += 2) layers.push(<rect key={`m${k}`} x={k * (W / 6)} y={base - 40} width={W / 6} height={40} fill="#a6582a" />);
    layers.push(label(`B⁺ ${IMPLANT.energyKeV} keV · Rp ≈ ${IMPLANT.rp} nm`, base + IMPLANT.rp * 0.6 + 30));
  }
  if (id === 'cmp') {
    const h = cmpStepHeight(phaseId, phaseT) / 6;
    for (let k = 0; k < 8; k++) layers.push(<rect key={`b${k}`} x={k * (W / 8)} y={base - 60 - (k % 2) * h} width={W / 8} height={60 + (k % 2) * h} fill="#5f86b8" />);
    layers.push(label('oxide — topography flattens', base - 66 - h));
  }
  return <>{layers}</>;
}

export function Fallback2D() {
  useTicker(12);
  const stage = useStage();
  const go = useUI((s) => s.goToStage);
  const v = engine.player.view;
  const machine = stage.machine ? MACHINE_BY_ID[stage.machine] : undefined;
  const idx = JOURNEY.findIndex((s) => s.id === stage.id);
  const prevSurface = (after: boolean) => {
    let surface: string = 'none';
    let form = 'material';
    for (let k = 0; k < (after ? idx + 1 : idx); k++) {
      const e = JOURNEY[k].effect;
      if (e?.surface) surface = e.surface;
      if (e?.form) form = e.form;
    }
    return (form === 'wafer' ? surface : form) as Parameters<typeof WaferGlyph>[0]['surface'];
  };
  return (
    <div className="fallback">
      <div style={{ maxWidth: 1100, margin: '0 auto', display: 'grid', gridTemplateColumns: 'minmax(320px, 1.3fr) minmax(280px, 1fr)', gap: 18 }}>
        <div>
          <div className="cap">2D TECHNICAL VIEW · SAME SIMULATION</div>
          <div className="seq" style={{ margin: '10px 0 14px' }}>
            {stage.phases.map((p, i) => (
              <span key={p.id + i} style={{ borderColor: i === v.phaseIndex ? 'var(--accent)' : undefined, color: i < v.phaseIndex ? 'var(--text-3)' : undefined }}>
                {p.label}
              </span>
            ))}
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', background: '#0e1317', border: '1px solid var(--line)', borderRadius: 4 }}>
            <Section id={stage.id} phaseId={v.phaseId} phaseT={v.phaseT} stageT={v.stageT} />
            <text x={8} y={16} fill="#6f7a83" fontSize={10} fontFamily="var(--mono)">
              CROSS-SECTION · SCHEMATIC · {v.phase.label.toUpperCase()}
            </text>
          </svg>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '14px 0' }}>
            <WaferGlyph surface={prevSurface(false)} size={70} />
            <div style={{ flex: 1 }}>
              <div style={{ height: 4, background: '#262d33', borderRadius: 2 }}>
                <div style={{ height: '100%', width: `${v.stageT * 100}%`, background: 'var(--accent)', borderRadius: 2 }} />
              </div>
              <div className="cap" style={{ marginTop: 4 }}>
                {stage.before} → {stage.after}
              </div>
            </div>
            <WaferGlyph surface={prevSurface(true)} size={70} />
          </div>
          <p className="muted" style={{ lineHeight: 1.6 }}>
            <GlossaryText text={stage.how} />
          </p>
          {machine && (
            <div className="note">
              {machine.name}: {machine.principle}
            </div>
          )}
          <div className="seq" style={{ marginTop: 10 }}>
            {JOURNEY.slice(Math.max(0, idx - 2), idx + 4).map((s) => (
              <button key={s.id} className={`btn sm ${s.id === stage.id ? 'on' : ''}`} onClick={() => go(s.id)}>
                {String(s.num).padStart(2, '0')} {s.short}
              </button>
            ))}
          </div>
        </div>
        <div>
          {engine.tele.channels.map((c) => (
            <ChannelCard key={c.def.id} id={c.def.id} />
          ))}
        </div>
      </div>
    </div>
  );
}
