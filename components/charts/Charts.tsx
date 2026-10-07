'use client';
/**
 * Lightweight SVG charts driven by simulation buffers.
 * Thin 2px lines, recessive grid, warn/fault bands, hover crosshair + tooltip.
 */
import { useMemo, useRef, useState } from 'react';
import { fmt } from '@/lib/math';
import type { DieStatus } from '@/simulation/models';
import { WAFER_D, DIE_W, DIE_H } from '@/simulation/models';

export function Sparkline({ values, min, max, width = 104, height = 18, color = 'var(--data)' }: { values: number[]; min: number; max: number; width?: number; height?: number; color?: string }) {
  const pts = useMemo(() => {
    const v = values.filter((x) => isFinite(x));
    if (v.length < 2) return '';
    const lo = Math.min(min, ...v);
    const hi = Math.max(max, ...v);
    const span = hi - lo || 1;
    const n = values.length;
    return values
      .map((x, i) => (isFinite(x) ? `${((i / (n - 1)) * width).toFixed(1)},${(height - 1 - ((x - lo) / span) * (height - 2)).toFixed(1)}` : ''))
      .filter(Boolean)
      .join(' ');
  }, [values, min, max, width, height]);
  return (
    <svg width={width} height={height} aria-hidden>
      {pts && <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />}
    </svg>
  );
}

interface LineChartProps {
  values: number[];
  min: number;
  max: number;
  /** seconds per sample */
  dt?: number;
  target?: number;
  warn?: [number, number];
  fault?: [number, number];
  unit?: string;
  decimals?: number;
  height?: number;
  color?: string;
  /** optional second series (e.g. setpoint) drawn dashed */
  ref2?: number[];
  ref2Label?: string;
  label?: string;
}

export function LineChart({ values, min, max, dt = 0.1, target, warn, fault, unit = '', decimals = 1, height = 70, color = 'var(--data)', ref2, ref2Label, label }: LineChartProps) {
  const W = 360;
  const H = height;
  const padL = 34;
  const padB = 12;
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const finite = values.filter((v) => isFinite(v));
  const lo = Math.min(min, ...(finite.length ? finite : [min]), ...(ref2 ?? []).filter(isFinite));
  const hi = Math.max(max, ...(finite.length ? finite : [max]), ...(ref2 ?? []).filter(isFinite));
  const span = hi - lo || 1;
  const N = Math.max(values.length, 2);
  const x = (i: number) => padL + (i / (N - 1)) * (W - padL - 4);
  const y = (v: number) => 4 + (1 - (v - lo) / span) * (H - padB - 6);
  const path = (arr: number[]) => {
    let d = '';
    let pen = false;
    arr.forEach((v, i) => {
      if (!isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const band = (b: [number, number] | undefined, cls: string) => {
    if (!b) return null;
    const rects = [];
    if (b[0] > lo) rects.push(<rect key="lo" x={padL} width={W - padL - 4} y={y(b[0])} height={Math.max(0, y(lo) - y(b[0]))} className={cls} />);
    if (b[1] < hi) rects.push(<rect key="hi" x={padL} width={W - padL - 4} y={y(hi)} height={Math.max(0, y(b[1]) - y(hi))} className={cls} />);
    return rects;
  };
  const ticks = [lo, (lo + hi) / 2, hi];
  return (
    <div
      ref={box}
      style={{ position: 'relative' }}
      onMouseMove={(e) => {
        const r = box.current!.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W;
        const i = Math.round(((px - padL) / (W - padL - 4)) * (N - 1));
        setHover(i >= 0 && i < values.length ? i : null);
      }}
      onMouseLeave={() => setHover(null)}
    >
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        <g className="grid">
          {ticks.map((t, i) => (
            <line key={i} x1={padL} x2={W - 4} y1={y(t)} y2={y(t)} />
          ))}
        </g>
        <g fill="rgba(250,178,25,0.07)">{band(warn, '')}</g>
        <g fill="rgba(208,59,59,0.12)">{band(fault, '')}</g>
        {target !== undefined && isFinite(target) && <line x1={padL} x2={W - 4} y1={y(target)} y2={y(target)} stroke="#6f7a83" strokeDasharray="3 3" strokeWidth={1} />}
        {ref2 && <path d={path(ref2)} fill="none" stroke="#a3adb5" strokeWidth={1.5} strokeDasharray="4 3" />}
        <path d={path(values)} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <g className="axis">
          {ticks.map((t, i) => (
            <text key={i} x={padL - 4} y={y(t) + 3} textAnchor="end">
              {fmt(t, Math.abs(hi - lo) < 10 ? decimals : 0)}
            </text>
          ))}
          <text x={padL} y={H - 1}>−{fmt((N - 1) * dt, 0)} s</text>
          <text x={W - 4} y={H - 1} textAnchor="end">now</text>
        </g>
        {hover !== null && isFinite(values[hover]) && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={4} y2={H - padB} stroke="#8a949c" strokeWidth={1} />
            <circle cx={x(hover)} cy={y(values[hover])} r={4} fill={color} stroke="#0f1215" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hover !== null && isFinite(values[hover]) && (
        <div className="chart-tip" style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(values[hover]) / H) * 100}%` }}>
          {fmt(values[hover], decimals)} {unit}
          {ref2 && isFinite(ref2[hover]) ? ` · ${ref2Label ?? 'ref'} ${fmt(ref2[hover], decimals)}` : ''} · −{fmt((values.length - 1 - hover) * dt, 1)} s
        </div>
      )}
    </div>
  );
}

const RESULT_COLOR: Record<string, string> = { PASS: '#4fbf3f', FAIL: '#d64b40', REVIEW: '#e8b23a' };
const RESULT_ICON: Record<string, string> = { PASS: '✓', FAIL: '✕', REVIEW: '?' };

/** Wafer map (§39, §89). Click a die to inspect its (fictional) defect class. */
export function WaferMapSVG({ map, selected, onSelect, progress = 1, size = 300 }: { map: DieStatus[]; selected?: number | null; onSelect?: (d: DieStatus) => void; progress?: number; size?: number }) {
  const s = size / WAFER_D;
  const c = size / 2;
  const shown = Math.floor(map.length * progress);
  const counts = { PASS: 0, FAIL: 0, REVIEW: 0 };
  map.forEach((d) => counts[d.result]++);
  return (
    <div>
      <svg viewBox={`0 0 ${size} ${size}`} width="100%" style={{ maxWidth: size, display: 'block', margin: '0 auto' }} role="img" aria-label="Wafer map">
        <circle cx={c} cy={c} r={c - 1} fill="#1b2025" stroke="#4a535b" />
        <path d={`M${c - 5},${size - 1} L${c},${size - 7} L${c + 5},${size - 1}`} fill="#0f1215" />
        {map.map((d, i) => {
          const visible = i < shown;
          const x = c + (d.die.cx - DIE_W / 2) * s;
          const y = c + (d.die.cy - DIE_H / 2) * s;
          return (
            <rect
              key={d.die.id}
              x={x + 0.6}
              y={y + 0.6}
              width={DIE_W * s - 1.2}
              height={DIE_H * s - 1.2}
              rx={1}
              fill={visible ? RESULT_COLOR[d.result] : '#2a3036'}
              opacity={visible ? (d.result === 'PASS' ? 0.75 : 1) : 1}
              stroke={selected === d.die.id ? '#ffffff' : 'none'}
              strokeWidth={selected === d.die.id ? 2 : 0}
              style={{ cursor: onSelect ? 'pointer' : 'default' }}
              onClick={() => onSelect?.(d)}
            >
              <title>{`DIE ${d.die.col},${d.die.row} · ${d.result}${d.defect ? ' · ' + d.defect : ''}`}</title>
            </rect>
          );
        })}
      </svg>
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 6, fontFamily: 'var(--mono)', fontSize: 10 }}>
        {(['PASS', 'FAIL', 'REVIEW'] as const).map((k) => (
          <span key={k} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', color: 'var(--text-2)' }}>
            <span style={{ width: 9, height: 9, background: RESULT_COLOR[k], display: 'inline-block', borderRadius: 1 }} />
            {RESULT_ICON[k]} {k} {counts[k]}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Labelled horizontal bars (counts). */
export function Bars({ items, max }: { items: { label: string; value: number; color?: string; note?: string }[]; max?: number }) {
  const m = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {items.map((it) => (
        <div key={it.label} style={{ display: 'grid', gridTemplateColumns: '92px 1fr 42px', gap: 8, alignItems: 'center', fontSize: 11 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-2)', letterSpacing: '0.06em' }}>{it.label}</span>
          <div style={{ height: 8, background: '#1c2227', borderRadius: 2 }}>
            <div style={{ height: '100%', width: `${(100 * it.value) / m}%`, background: it.color ?? 'var(--data)', borderRadius: '0 4px 4px 0', transition: 'width 0.3s' }} />
          </div>
          <span style={{ fontFamily: 'var(--mono)', textAlign: 'right' }}>{fmt(it.value, 0)}</span>
        </div>
      ))}
    </div>
  );
}
