'use client';
/**
 * Small shared UI pieces: data classification tags, glossary-linked text,
 * status badges, wafer glyphs for in/out strips.
 */
import { Fragment, useMemo, type ReactNode } from 'react';
import type { DataKind, Status, WaferSurface, MachineState } from '@/types';
import { GLOSSARY } from '@/data/glossary';
import { SOURCE_BY_ID } from '@/data/sources';
import { useUI } from '@/lib/store';
import { oxideColor } from '@/simulation/models';
import { STATE_COLOR } from '../3d/materials';

const KIND_LABEL: Record<DataKind, string> = { REAL: 'REAL · SOURCED', REPRESENTATIVE: 'REPRESENTATIVE', SIMULATED: 'SIMULATED', CONCEPTUAL: 'CONCEPTUAL' };

export function DataTag({ kind, short }: { kind: DataKind; short?: boolean }) {
  return (
    <span className={`dtag ${kind}`} title={KIND_LABEL[kind]}>
      {short ? (kind === 'REPRESENTATIVE' ? 'REP' : kind === 'CONCEPTUAL' ? 'CONC' : kind === 'SIMULATED' ? 'SIM' : 'REAL') : KIND_LABEL[kind]}
    </span>
  );
}

export function EduTag() {
  return <span className="dtag EDU">INDUSTRY-INSPIRED EDUCATIONAL MODEL</span>;
}

export function StatusBadge({ status }: { status: Status }) {
  const icon = status === 'NORMAL' ? '●' : status === 'WARNING' ? '▲' : '■';
  return (
    <span className={`status-badge ${status}`}>
      {icon} {status}
    </span>
  );
}

export function StateChip({ state }: { state: MachineState }) {
  return (
    <span className="chip">
      <span className="dot" style={{ background: STATE_COLOR[state] }} />
      {state}
    </span>
  );
}

export function SourceRef({ id }: { id?: string }) {
  const openPanel = useUI((s) => s.openPanel);
  if (!id) return null;
  const s = SOURCE_BY_ID[id];
  if (!s) return null;
  return (
    <button className="link" style={{ fontSize: 10 }} title={`${s.title} — ${s.org} (${s.date})`} onClick={() => openPanel('sources')}>
      [{s.org.split(/[ (,]/)[0]} {s.date.match(/\d{4}/)?.[0] ?? ''}]
    </button>
  );
}

/* --------------------- glossary-linked text --------------------- */

const TERMS = GLOSSARY.flatMap((g) => [g.term, ...(g.aka ?? [])].filter((t) => t.length > 2).map((t) => ({ t, id: g.id })))
  .sort((a, b) => b.t.length - a.t.length);
const RE = new RegExp(`\\b(${TERMS.map((x) => x.t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi');
const LOOKUP = new Map(TERMS.map((x) => [x.t.toLowerCase(), x.id]));

/** Wraps known technical terms so they open the glossary in context (§102). */
export function GlossaryText({ text, max = 6 }: { text: string; max?: number }) {
  const select = useUI((s) => s.select);
  const parts = useMemo(() => {
    const out: ReactNode[] = [];
    let last = 0;
    let n = 0;
    const seen = new Set<string>();
    text.replace(RE, (m, _g, idx: number) => {
      const id = LOOKUP.get(m.toLowerCase());
      if (!id || seen.has(id) || n >= max) return m;
      seen.add(id);
      n++;
      out.push(text.slice(last, idx));
      out.push(
        <button key={idx} className="gl" onClick={() => select({ kind: 'glossary', id, label: m }, 'inspect')}>
          {m}
        </button>,
      );
      last = idx + m.length;
      return m;
    });
    out.push(text.slice(last));
    return out;
  }, [text, max, select]);
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </>
  );
}

/* --------------------- wafer glyph --------------------- */

export function WaferGlyph({ surface, size = 54, label }: { surface: WaferSurface | 'ingot' | 'material' | 'die' | 'package' | 'product' | 'none'; size?: number; label?: string }) {
  const r = size / 2 - 2;
  let fill = '#8f97a3';
  let pattern: ReactNode = null;
  if (surface === 'as-cut') fill = '#6c7178';
  if (surface === 'lapped' || surface === 'ground') fill = '#868b91';
  if (surface === 'etched') fill = '#8d939a';
  if (surface === 'oxide') {
    const [a, b, c] = oxideColor(55);
    fill = `rgb(${a * 255},${b * 255},${c * 255})`;
  }
  if (surface === 'film') fill = '#a8946a';
  if (surface === 'resist') fill = '#a6582a';
  if (surface === 'exposed') fill = '#b4703a';
  if (['developed', 'patterned', 'doped', 'metal', 'passivated', 'mapped', 'diced', 'planarized'].includes(surface)) {
    pattern = (
      <g opacity={0.85}>
        {Array.from({ length: 7 }, (_, i) =>
          Array.from({ length: 7 }, (_, j) => {
            const x = (i - 3) * (size / 9);
            const y = (j - 3) * (size / 9);
            if (Math.hypot(x, y) > r - size / 12) return null;
            return <rect key={`${i}${j}`} x={size / 2 + x - size / 22} y={size / 2 + y - size / 22} width={size / 11} height={size / 11} fill={surface === 'metal' ? '#c47b4a' : surface === 'mapped' ? (i * 7 + j) % 9 === 0 ? '#d03b3b' : '#0ca30c' : '#7a85a0'} />;
          }),
        )}
      </g>
    );
  }
  if (surface === 'material') {
    return (
      <svg width={size} height={size} aria-label={label}>
        {[0, 1, 2, 3, 4].map((i) => (
          <polygon key={i} points={`${8 + i * 8},${size - 8} ${14 + i * 8},${size - 22 - (i % 2) * 6} ${20 + i * 8},${size - 8}`} fill="#cfd6d8" stroke="#8a9296" />
        ))}
      </svg>
    );
  }
  if (surface === 'ingot') {
    return (
      <svg width={size} height={size} aria-label={label}>
        <rect x={size * 0.15} y={size * 0.3} width={size * 0.7} height={size * 0.4} rx={size * 0.12} fill="#7d848d" stroke="#a3aab3" />
      </svg>
    );
  }
  if (surface === 'die' || surface === 'package' || surface === 'product') {
    return (
      <svg width={size} height={size} aria-label={label}>
        {surface !== 'die' && <rect x={size * 0.12} y={size * 0.12} width={size * 0.76} height={size * 0.76} rx={3} fill="#2e5a43" />}
        <rect x={size * 0.3} y={size * 0.3} width={size * 0.4} height={size * 0.4} fill={surface === 'product' ? '#b9bec4' : '#6f7c8f'} stroke="#9aa" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} aria-label={label}>
      <circle cx={size / 2} cy={size / 2} r={r} fill={fill} stroke="#b9c0c8" strokeWidth={1} />
      {pattern}
      <path d={`M${size / 2 - 3},${size - 2} L${size / 2},${size - 6} L${size / 2 + 3},${size - 2}`} fill="#0f1215" />
    </svg>
  );
}
