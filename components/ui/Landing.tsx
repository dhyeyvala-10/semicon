'use client';
/**
 * Entrance (§2): the live cleanroom behind, a colour-graded headline, and a journey
 * ribbon from silica extraction to the finished system. Each segment carries its own
 * grade; the ribbon itself is the blend of all of them.
 */
import { useMemo, useState } from 'react';
import { useUI } from '@/lib/store';
import { useTicker } from '@/hooks/useTicker';
import { engine } from '@/simulation/engine';
import { JOURNEY } from '@/data/process';
import { JOURNEY_RIBBON, gradeAt, hex, journeyT, rgba } from '@/lib/palette';
import { fmt } from '@/lib/math';

/** Line illustrations — drawn with round caps and slightly irregular paths. */
function Glyph({ macro }: { macro: string }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (macro) {
    case 'MATERIAL':
      return (
        <svg viewBox="0 0 64 64" {...common}>
          <path d="M14 50 L18 28 L23 21 L27 29 L25 50" />
          <path d="M25 50 L28 22 L34 12 L39 23 L37 50" />
          <path d="M37 50 L40 31 L45 26 L49 32 L50 50" />
          <path d="M23 21 L24 50 M34 12 L33 50 M45 26 L45 50" opacity={0.45} />
          <path d="M8 51 C 20 49, 44 53, 57 50" />
          <circle cx="11" cy="55" r="1.2" />
          <circle cx="51" cy="56" r="1" />
        </svg>
      );
    case 'CRYSTAL':
      return (
        <svg viewBox="0 0 64 64" {...common}>
          <path d="M32 4 L32 12" />
          <path d="M31 12 C 31 16, 25 18, 25 22 L25 40 C 25 42, 39 42, 39 40 L39 22 C 39 18, 33 16, 33 12" />
          <path d="M14 46 C 14 56, 50 56, 50 46" />
          <path d="M18 46 C 24 43, 40 43, 46 46" opacity={0.6} />
          <path d="M22 50 C 28 48.5, 36 48.5, 42 50" opacity={0.4} />
          <path d="M28 41 C 29 44, 35 44, 36 41" />
        </svg>
      );
    case 'WAFERING':
      return (
        <svg viewBox="0 0 64 64" {...common}>
          <ellipse cx="32" cy="34" rx="22" ry="22" />
          <path d="M30 56 L32 53 L34 56" />
          <path d="M16 26 C 26 23, 38 23, 48 26" opacity={0.45} />
          <path d="M13 34 C 25 31, 39 31, 51 34" opacity={0.45} />
          <path d="M16 42 C 26 39, 38 39, 48 42" opacity={0.45} />
          <path d="M44 12 C 47 14, 50 17, 52 20" />
        </svg>
      );
    case 'FAB_ENTRY':
      return (
        <svg viewBox="0 0 64 64" {...common}>
          <path d="M14 20 L48 20 L48 52 L14 52 Z" />
          <path d="M26 14 L36 14 L36 20" />
          <path d="M18 27 L42 27 M18 32 L42 32 M18 37 L42 37 M18 42 L42 42 M18 47 L42 47" opacity={0.55} />
          <path d="M48 24 L54 26 L54 48 L48 50" />
        </svg>
      );
    case 'FEOL':
      return (
        <svg viewBox="0 0 64 64" {...common}>
          <path d="M8 46 L56 46" />
          <path d="M27 46 L27 24 L37 24 L37 46" />
          <path d="M20 46 L20 18 C 20 15, 44 15, 44 18 L44 46" />
          <path d="M10 46 L10 40 L18 40 M46 40 L54 40 L54 46" opacity={0.55} />
          <path d="M32 10 L32 15" />
        </svg>
      );
    case 'BEOL':
      return (
        <svg viewBox="0 0 64 64" {...common}>
          <path d="M8 52 L56 52" />
          <path d="M12 44 L30 44 M36 44 L52 44" />
          <path d="M10 34 L24 34 M28 34 L54 34" />
          <path d="M14 22 L50 22" strokeWidth={2.6} />
          <path d="M16 12 L48 12" strokeWidth={3.4} />
          <path d="M20 52 L20 44 M44 44 L44 34 M26 34 L26 22 M40 22 L40 12" opacity={0.7} />
        </svg>
      );
    case 'TEST':
      return (
        <svg viewBox="0 0 64 64" {...common}>
          <circle cx="32" cy="34" r="22" />
          {[0, 1, 2, 3].map((r) =>
            [0, 1, 2, 3].map((c) => (
              <rect key={`${r}${c}`} x={19 + c * 7} y={21 + r * 7} width={5} height={5} rx={0.8} opacity={(r * 4 + c) % 5 === 2 ? 1 : 0.45} fill={(r * 4 + c) % 5 === 2 ? 'currentColor' : 'none'} />
            )),
          )}
          <path d="M44 6 L44 14 M40 10 L48 10" />
        </svg>
      );
    case 'BACKEND':
      return (
        <svg viewBox="0 0 64 64" {...common}>
          <path d="M10 40 L54 40 L54 46 L10 46 Z" />
          <path d="M22 40 L22 32 L42 32 L42 40" />
          <path d="M20 32 C 20 26, 44 26, 44 32" opacity={0.6} />
          {[14, 21, 28, 35, 42, 49].map((x) => (
            <circle key={x} cx={x} cy={50} r={1.6} />
          ))}
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 64 64" {...common}>
          <path d="M10 16 L54 16 L54 44 L10 44 Z" />
          <path d="M26 44 L24 52 L40 52 L38 44" />
          <path d="M18 52 L46 52" />
          <path d="M16 24 C 24 30, 32 20, 40 28 C 44 32, 47 27, 49 26" opacity={0.7} />
        </svg>
      );
  }
}

/** The only live part of the entrance; ticking here keeps the rest of the landing static. */
function LiveLine() {
  useTicker(2);
  const f = engine.fab;
  return (
    <span className="live-line">
      FAB 1 NOW · {f.lots.length} lots in process · {fmt(f.utilisation(), 0)}% tools processing · {f.activeAlarms()} alarms <i>SIMULATED</i>
    </span>
  );
}

export function Landing() {
  const started = useUI((s) => s.started);
  const start = useUI((s) => s.start);
  const [hover, setHover] = useState<number | null>(null);
  const segments = useMemo(
    () =>
      JOURNEY_RIBBON.map((r) => {
        const first = JOURNEY.findIndex((s) => s.id === r.first);
        const t = journeyT(r.first);
        const g = gradeAt(t);
        const stages = JOURNEY.filter((s) => s.macro === r.macro);
        return { ...r, stageId: r.first as string, first, t, color: hex(g.accent), soft: rgba(g.accent, 0.14), glow: hex(g.glow), count: stages.length };
      }),
    [],
  );
  const ribbon = useMemo(() => `linear-gradient(90deg, ${segments.map((s, i) => `${s.color} ${((i + 0.5) / segments.length) * 100}%`).join(', ')})`, [segments]);
  const words = useMemo(() => [gradeAt(0), gradeAt(0.45), gradeAt(1)].map((g) => `linear-gradient(90deg, ${hex(g.glow)}, ${hex(g.accent)} 60%, ${hex(g.accent2)})`), []);
  if (started) return null;
  const go = (stageId: string) => {
    start('control');
    useUI.getState().goToStage(stageId);
  };
  return (
    <div className="landing">
      <div className="landing-glow" />
      <div className="landing-main">
        <div className="kicker">
          <span className="pulse" /> FAB/TWIN · A WORKING DIGITAL FACTORY · LIVE SIMULATION
        </div>
        <h1>
          <span style={{ backgroundImage: words[0] }}>From sand</span>
          <span style={{ backgroundImage: words[1] }}>to silicon</span>
          <span style={{ backgroundImage: words[2] }} className="last">
            to system.
            <svg className="scribble" viewBox="0 0 300 24" preserveAspectRatio="none">
              <path d="M4 15 C 60 7, 120 21, 180 12 S 270 6, 296 13" />
            </svg>
          </span>
        </h1>
        <p>
          Follow one grain of quartz as it becomes wafer <b>WF-000184</b>, then chip <b>CH-184-0412</b>, then part of a working computer — {JOURNEY.length} stages, every machine running, every number labelled with where it came from.
        </p>
        <div className="cta">
          <button className="cta-main" onClick={() => start('watch')}>
            <span>▶</span> Watch the full journey
          </button>
          <button className="cta-link" onClick={() => start('control')}>
            Control the fab
          </button>
          <button className="cta-link" onClick={() => start('learn')}>
            Learn step by step
          </button>
          <button className="cta-link" onClick={() => start('engineer')}>
            Engineer view
          </button>
        </div>
      </div>

      <div className="ribbon-wrap">
        <div className="ribbon-meta">
          <span>EXTRACTION</span>
          <LiveLine />
          <span>SYSTEM</span>
        </div>
        <div className="ribbon">
          {segments.map((s, i) => (
            <button
              key={s.macro}
              className={`seg-card ${hover === i ? 'hot' : ''}`}
              style={{ color: s.color, ['--seg' as string]: s.color, ['--seg-soft' as string]: s.soft }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onClick={() => go(s.stageId)}
              title={`Enter at ${JOURNEY[s.first]?.title}`}
            >
              <div className="seg-glyph">
                <Glyph macro={s.macro} />
              </div>
              <div className="seg-n">
                {String(s.first + 1).padStart(2, '0')}–{String(s.first + s.count).padStart(2, '0')}
              </div>
              <div className="seg-label">{s.label}</div>
              <div className="seg-sub">{s.sub}</div>
            </button>
          ))}
        </div>
        <div className="ribbon-bar" style={{ backgroundImage: ribbon }}>
          <div className="ribbon-sheen" />
          {hover !== null && <div className="ribbon-mark" style={{ left: `${((hover + 0.5) / segments.length) * 100}%` }} />}
        </div>
      </div>
    </div>
  );
}
