'use client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useUI } from '@/lib/store';
import { useTicker } from '@/hooks/useTicker';
import { engine } from '@/simulation/engine';
import { search, type Doc } from '@/lib/search';
import { STAGES, JOURNEY, MACRO_LABEL, STAGE_BY_ID } from '@/data/process';
import { MACHINES, MACHINE_BY_ID } from '@/data/machines';
import { ROBOTS } from '@/data/robots';
import { MATERIALS } from '@/data/materials';
import { GLOSSARY } from '@/data/glossary';
import { COMPARISONS } from '@/data/comparisons';
import { FAILURES } from '@/data/failures';
import { SOURCES } from '@/data/sources';
import { BAYS, FAB, TOOLS, OHT_LOOP, TOOL_TYPE_NAME } from '@/data/fabLayout';
import { CONTROL_LOOPS, ControlLoopSim, simulateR2R } from '@/simulation/control';
import { FAB_TIME_COMPRESSION } from '@/simulation/fab';
import { fmt } from '@/lib/math';
import { DataTag, EduTag } from './common';
import { Bars, LineChart, WaferMapSVG } from '../charts/Charts';
import { STATE_COLOR } from '../3d/materials';
import { EventLog } from './SidePanel';
import type { MachineState } from '@/types';

function Sheet({ title, children, wide = true, right }: { title: string; children: ReactNode; wide?: boolean; right?: ReactNode }) {
  const close = () => useUI.getState().setOverlay(null);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="sheet" style={{ width: wide ? 'min(1120px, 100%)' : 'min(720px, 100%)' }}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {right}
            <button className="btn sm" onClick={close}>
              CLOSE ✕
            </button>
          </div>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export function Overlays() {
  const o = useUI((s) => s.overlay);
  switch (o) {
    case 'search':
      return <SearchPalette />;
    case 'fabmap':
      return <FabMap />;
    case 'processmap':
      return <ProcessMap />;
    case 'machines':
      return <MachineMap />;
    case 'robotics':
      return <RoboticsOverlay />;
    case 'materials':
      return <MaterialsOverlay />;
    case 'glossary':
      return <GlossaryOverlay />;
    case 'about':
      return <About />;
    case 'compare':
      return <CompareOverlay />;
    case 'failures':
      return <FailuresOverlay />;
    case 'data':
      return <Dashboard />;
    case 'loops':
      return <LoopsOverlay />;
    default:
      return null;
  }
}

/* ------------------------------ search ------------------------------ */

function openDoc(d: Doc) {
  const ui = useUI.getState();
  ui.setOverlay(null);
  if (d.overlay) {
    if (d.stage) ui.goToStage(d.stage);
    ui.setOverlay(d.overlay as never);
    return;
  }
  if (d.stage && d.stage !== ui.stageId && d.type !== 'SENSOR' && d.type !== 'TERM') ui.goToStage(d.stage);
  if (d.selection) setTimeout(() => useUI.getState().select(d.selection!, d.type === 'MACHINE' ? 'machine' : 'inspect'), 30);
}

function SearchPalette() {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => search(q), [q]);
  useEffect(() => input.current?.focus(), []);
  const groups = useMemo(() => {
    const g = new Map<string, Doc[]>();
    results.forEach((r) => g.set(r.type, [...(g.get(r.type) ?? []), r]));
    return Array.from(g.entries());
  }, [results]);
  const flat = groups.flatMap(([, v]) => v);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && useUI.getState().setOverlay(null)}>
      <div className="sheet search">
        <div className="sheet-head" style={{ gap: 10 }}>
          <input
            ref={input}
            className="search-input"
            placeholder="Search processes, machines, sensors, materials, terms…  (try “etch”)"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setSel((s) => Math.min(flat.length - 1, s + 1));
              if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1));
              if (e.key === 'Enter' && flat[sel]) openDoc(flat[sel]);
              if (e.key === 'Escape') useUI.getState().setOverlay(null);
            }}
          />
          <span className="cap">{results.length} RESULTS</span>
        </div>
        <div className="search-results">
          {!q && <div className="dim" style={{ padding: 10 }}>Global technical search across {STAGES.length} stages, {MACHINES.length} machines, {ROBOTS.length} robots, sensors, {MATERIALS.length} materials and {GLOSSARY.length} glossary terms.</div>}
          {groups.map(([type, docs]) => (
            <div key={type}>
              <div className="search-group">{type}</div>
              {docs.map((d) => (
                <button key={d.type + d.id} className={`search-hit ${flat[sel] === d ? 'sel' : ''}`} onClick={() => openDoc(d)}>
                  <span>{d.title}</span>
                  <small>{d.text.length > 70 ? d.text.slice(0, 70) + '…' : d.text}</small>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ fab map ------------------------------ */

function FabMap() {
  useTicker(3);
  const go = useUI((s) => s.goToStage);
  const W = 880;
  const sx = (x: number) => ((x - FAB.minX) / (FAB.maxX - FAB.minX)) * W;
  const H = ((FAB.maxZ - FAB.minZ) / (FAB.maxX - FAB.minX)) * W;
  const sz = (z: number) => ((z - FAB.minZ) / (FAB.maxZ - FAB.minZ)) * H;
  const others = [
    { label: 'CONTROL ROOM', stage: 'control-room' },
    { label: 'UTILITIES / SUBFAB', stage: 'utilities' },
    { label: 'ROBOT AREA (EFEM LAB)', stage: 'robot-lab' },
    { label: 'WAFER PROBE / TEST', stage: 'e-test' },
    { label: 'PACKAGING BAY (OSAT)', stage: 'die-attach' },
    { label: 'WAREHOUSE', stage: 'logistics' },
  ];
  return (
    <Sheet title="FAB MAP · FAB 1 CLEANROOM" right={<DataTag kind="CONCEPTUAL" />}>
      <div className="fabmap">
        <svg viewBox={`-10 -10 ${W + 20} ${H + 20}`}>
          <rect x={0} y={0} width={W} height={H} fill="#11161a" stroke="#3a434b" />
          <polyline points={OHT_LOOP.map(([x, z]) => `${sx(x)},${sz(z)}`).join(' ')} fill="none" stroke="#5a6670" strokeDasharray="4 3" />
          {BAYS.map((b) => {
            const x0 = sx(b.x - 6);
            const z0 = b.side > 0 ? sz(FAB.bayStart) : sz(-FAB.bayEnd);
            return (
              <g className="bay" key={b.id} onClick={() => { useUI.getState().setOverlay(null); go(b.stage); }}>
                <rect x={x0} y={z0} width={sx(b.x + 6) - x0} height={sz(FAB.bayEnd) - sz(FAB.bayStart)} fill={b.light === 'amber' ? 'var(--accent-dim)' : 'rgba(255,255,255,0.03)'} stroke="#3a434b" />
                <text x={sx(b.x)} y={z0 + 14} fill="#a3adb5" fontSize={9} fontFamily="var(--mono)" textAnchor="middle">
                  {b.name.replace(' BAY', '').slice(0, 22)}
                </text>
              </g>
            );
          })}
          {TOOLS.map((t) => {
            const st = engine.fab.toolById[t.id]?.state ?? 'IDLE';
            return (
              <g key={t.id}>
                <rect
                  x={sx(t.x) - (Math.abs(Math.cos(t.rot)) > 0.5 ? (t.rot === 0 ? t.depth : 0) : t.length / 2) * (W / (FAB.maxX - FAB.minX))}
                  y={sz(t.z) - (Math.abs(Math.cos(t.rot)) > 0.5 ? t.length / 2 : t.depth / 2) * (W / (FAB.maxX - FAB.minX))}
                  width={(Math.abs(Math.cos(t.rot)) > 0.5 ? t.depth : t.length) * (W / (FAB.maxX - FAB.minX))}
                  height={(Math.abs(Math.cos(t.rot)) > 0.5 ? t.length : t.depth) * (W / (FAB.maxX - FAB.minX))}
                  fill="#232a30"
                  stroke={STATE_COLOR[st]}
                  strokeWidth={1.2}
                >
                  <title>{`${t.id} · ${TOOL_TYPE_NAME[t.type]} · ${st}`}</title>
                </rect>
              </g>
            );
          })}
          {engine.fab.lots.map((l) => {
            const p = engine.fab.lotPosition(l);
            return <circle key={l.id} cx={sx(p.x)} cy={sz(p.z)} r={l.followed ? 4.5 : 2.2} fill={l.followed ? 'var(--accent)' : '#8fb0c4'} stroke={l.followed ? '#fff' : 'none'} />;
          })}
        </svg>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8, fontSize: 11 }} className="muted">
          {(['PROCESSING', 'IDLE', 'LOADING', 'ALARM', 'MAINTENANCE', 'OFFLINE'] as MachineState[]).map((s) => (
            <span key={s} style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
              <span style={{ width: 10, height: 10, border: `2px solid ${STATE_COLOR[s]}`, display: 'inline-block' }} /> {s}
            </span>
          ))}
          <span>● lot (FOUP) · <span style={{ color: 'var(--accent)' }}>●</span> LOT-A0731 (followed)</span>
          <span>- - - OHT rail loop</span>
        </div>
        <h3 className="cap" style={{ marginTop: 14 }}>OTHER LOCATIONS</h3>
        <div className="grid-cards">
          {others.map((o) => (
            <button key={o.stage} className="card" onClick={() => { useUI.getState().setOverlay(null); go(o.stage); }}>
              <h4>{o.label}</h4>
              <p>{STAGE_BY_ID[o.stage]?.summary}</p>
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

/* ------------------------------ process map ------------------------------ */

function ProcessMap() {
  const go = useUI((s) => s.goToStage);
  const cur = useUI((s) => s.stageId);
  const macros = Array.from(new Set(JOURNEY.map((s) => s.macro)));
  return (
    <Sheet title="PROCESS MAP · RAW MATERIAL → DEVICE">
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${macros.length}, minmax(110px, 1fr))`, gap: 6, overflowX: 'auto' }}>
        {macros.map((m, mi) => (
          <div key={m}>
            <div className="cap" style={{ color: 'var(--accent)', marginBottom: 6 }}>
              {String(mi + 1).padStart(2, '0')} · {MACRO_LABEL[m]}
            </div>
            {JOURNEY.filter((s) => s.macro === m).map((s) => (
              <button
                key={s.id}
                className="comp"
                style={{ borderColor: s.id === cur ? 'var(--accent)' : undefined, padding: '5px 7px' }}
                onClick={() => {
                  useUI.getState().setOverlay(null);
                  go(s.id);
                }}
              >
                <b style={{ fontSize: 11 }}>
                  <span className="dim mono">{String(s.num).padStart(2, '0')}</span> {s.short}
                </b>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="note">
        The front-end flow is re-entrant: deposition → coat → expose → develop → etch → clean → implant → anneal → CMP → inspect repeats for every layer (see “Repeated layer formation”).
        <button className="link" style={{ marginLeft: 6 }} onClick={() => { useUI.getState().setOverlay(null); go('layer-cycle'); }}>
          Open the loop ›
        </button>
      </div>
    </Sheet>
  );
}

/* ------------------------------ machine map ------------------------------ */

const FLOW = ['wet-bench', 'furnace', 'dep-cluster', 'track', 'scanner', 'etcher', 'asher', 'implanter', 'rtp', 'cmp', 'metrology', 'surface-inspection', 'prober'];

function MachineMap() {
  const [focus, setFocus] = useState<string | null>('scanner');
  const select = useUI((s) => s.select);
  const go = useUI((s) => s.goToStage);
  const related = new Set(focus ? [focus, ...(MACHINE_BY_ID[focus]?.related ?? []), ...MACHINES.filter((m) => m.related.includes(focus)).map((m) => m.id)] : []);
  const W = 1060;
  const r = 200;
  const cx = W / 2;
  const cy = 230;
  const pos = (i: number) => ({ x: cx + Math.cos((i / FLOW.length) * Math.PI * 2 - Math.PI / 2) * r * 2.1, y: cy + Math.sin((i / FLOW.length) * Math.PI * 2 - Math.PI / 2) * r });
  return (
    <Sheet title="MACHINE MAP · RELATIONSHIPS" right={<EduTag />}>
      <svg viewBox={`0 0 ${W} 470`} style={{ width: '100%' }}>
        {FLOW.map((id, i) => {
          const a = pos(i);
          const b = pos((i + 1) % FLOW.length);
          const hot = focus && (id === focus || FLOW[(i + 1) % FLOW.length] === focus);
          return <line key={id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={hot ? 'var(--accent)' : '#39424a'} strokeWidth={hot ? 2 : 1} markerEnd="url(#arr)" />;
        })}
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill="#6f7a83" />
          </marker>
        </defs>
        <text x={cx} y={cy - 6} textAnchor="middle" fill="#6f7a83" fontFamily="var(--mono)" fontSize={11}>
          RE-ENTRANT FLOW
        </text>
        <text x={cx} y={cy + 10} textAnchor="middle" fill="#6f7a83" fontFamily="var(--mono)" fontSize={10}>
          → NEXT PROCESS
        </text>
        {FLOW.map((id, i) => {
          const p = pos(i);
          const m = MACHINE_BY_ID[id];
          const on = related.has(id);
          return (
            <g key={id} transform={`translate(${p.x},${p.y})`} style={{ cursor: 'pointer' }} onClick={() => setFocus(id)} onDoubleClick={() => { useUI.getState().setOverlay(null); go(m.stages[0]); }}>
              <rect x={-74} y={-17} width={148} height={34} rx={4} fill={focus === id ? 'var(--accent-dim)' : on ? 'var(--accent-dim)' : '#151a1f'} stroke={on ? 'var(--accent)' : '#3a434b'} />
              <text textAnchor="middle" y={-2} fill="#dfe4e8" fontSize={10.5}>
                {m.name.length > 24 ? m.name.slice(0, 23) + '…' : m.name}
              </text>
              <text textAnchor="middle" y={11} fill="#6f7a83" fontSize={8.5} fontFamily="var(--mono)">
                {m.category.toUpperCase().slice(0, 26)}
              </text>
            </g>
          );
        })}
      </svg>
      {focus && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <span className="cap">SELECTED</span>
          <b>{MACHINE_BY_ID[focus].name}</b>
          <button className="btn sm" onClick={() => { useUI.getState().setOverlay(null); select({ kind: 'machine', id: focus, label: MACHINE_BY_ID[focus].name }, 'machine'); }}>
            OPEN INTERFACE
          </button>
          <button className="btn sm" onClick={() => { useUI.getState().setOverlay(null); go(MACHINE_BY_ID[focus].stages[0]); }}>
            GO TO MACHINE ›
          </button>
        </div>
      )}
      <div className="grid-cards">
        {MACHINES.map((m) => (
          <button key={m.id} className="card" style={{ borderColor: related.has(m.id) ? 'var(--accent)' : undefined }} onClick={() => setFocus(m.id)} onDoubleClick={() => { useUI.getState().setOverlay(null); go(m.stages[0]); }}>
            <h4>{m.name}</h4>
            <p>{m.purpose}</p>
          </button>
        ))}
      </div>
      <div className="note">Click to highlight connected equipment; double-click to travel to the machine.</div>
    </Sheet>
  );
}

/* ------------------------------ robotics ------------------------------ */

function RoboticsOverlay() {
  const go = useUI((s) => s.goToStage);
  const order = ['wafer-robot', 'vacuum-robot', 'oht', 'stocker', 'track-robot', 'wafer-stage', 'inspection-stage', 'prober-chuck', 'pick-place', 'test-handler-robot', 'amr'];
  return (
    <Sheet title="ROBOTICS ECOSYSTEM">
      <div className="seq" style={{ marginBottom: 12 }}>
        {['Wafer robots', 'Machine loading', 'Overhead transport', 'Automated storage', 'Inspection automation', 'Packaging automation', 'Warehouse logistics'].map((x, i, a) => (
          <span key={x} style={{ display: 'contents' }}>
            <span>{x}</span>
            {i < a.length - 1 && <i>→</i>}
          </span>
        ))}
      </div>
      <div className="grid-cards">
        {order.map((id) => {
          const r = ROBOTS.find((x) => x.id === id)!;
          const stageId = r.stage ?? (r.scene === 'fab' ? 'fab-overview' : 'robot-lab');
          return (
            <button
              key={r.id}
              className="card"
              onClick={() => {
                useUI.getState().setOverlay(null);
                go(stageId);
                setTimeout(() => useUI.getState().select({ kind: 'robot', id: r.id, label: r.name }), 60);
              }}
            >
              <div className="cap">{r.category}</div>
              <h4>{r.name}</h4>
              <p>{r.task}</p>
              <p className="dim" style={{ marginTop: 4 }}>{r.mechanism}</p>
            </button>
          );
        })}
      </div>
      <div className="note">Every robot opens with mechanism, movement, sensors, controller, task and — where the simulation drives it — live telemetry.</div>
    </Sheet>
  );
}

/* ------------------------------ materials ------------------------------ */

function MaterialsOverlay() {
  const go = useUI((s) => s.goToStage);
  const cats = Array.from(new Set(MATERIALS.map((m) => m.category)));
  return (
    <Sheet title="MATERIALS">
      {cats.map((c) => (
        <div key={c} style={{ marginBottom: 12 }}>
          <div className="cap" style={{ marginBottom: 6 }}>{c.toUpperCase()}</div>
          <div className="grid-cards">
            {MATERIALS.filter((m) => m.category === c).map((m) => (
              <button key={m.id} className="card" onClick={() => { useUI.getState().setOverlay(null); go(m.stages[0]); setTimeout(() => useUI.getState().select({ kind: 'material', id: m.id, label: m.name }), 60); }}>
                <h4>
                  {m.name} {m.formula && <span className="dim mono" style={{ fontWeight: 400 }}>{m.formula}</span>}
                </h4>
                <p>{m.use}</p>
              </button>
            ))}
          </div>
        </div>
      ))}
    </Sheet>
  );
}

/* ------------------------------ glossary ------------------------------ */

function GlossaryOverlay() {
  const [q, setQ] = useState('');
  const list = GLOSSARY.filter((g) => !q || (g.term + ' ' + (g.aka ?? []).join(' ') + g.short).toLowerCase().includes(q.toLowerCase())).sort((a, b) => a.term.localeCompare(b.term));
  return (
    <Sheet title="GLOSSARY" right={<input className="search-input" style={{ width: 220, height: 26 }} placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />}>
      <div className="grid-cards">
        {list.map((g) => (
          <button key={g.id} className="card" onClick={() => { useUI.getState().setOverlay(null); useUI.getState().select({ kind: 'glossary', id: g.id, label: g.term }); }}>
            <h4>{g.term}</h4>
            <p>{g.short}</p>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/* ------------------------------ compare ------------------------------ */

function CompareOverlay() {
  const go = useUI((s) => s.goToStage);
  return (
    <Sheet title="COMPARISONS · VISUAL FIRST">
      <div className="note" style={{ marginTop: 0 }}>Each comparison opens the 3D scene in the right mode — watch the difference, then read the table.</div>
      {COMPARISONS.map((c) => (
        <div key={c.id} className="chart-card" style={{ padding: 10 }}>
          <div className="chart-head" style={{ marginBottom: 6 }}>
            <b>{c.title}</b>
            <button
              className="btn sm primary"
              onClick={() => {
                useUI.getState().setOverlay(null);
                go(c.stage);
                if (c.mode) Object.entries(c.mode).forEach(([k, v]) => engine.setParam(k, Number(v)));
              }}
            >
              SHOW IN 3D ›
            </button>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th />
                {c.columns.map((x) => (
                  <th key={x}>{x}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {c.rows.map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  {r.values.map((v, i) => (
                    <td key={i}>{v}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </Sheet>
  );
}

/* ------------------------------ failures ------------------------------ */

function FailuresOverlay() {
  const go = useUI((s) => s.goToStage);
  return (
    <Sheet title="WHAT IF SOMETHING GOES WRONG?" right={<DataTag kind="SIMULATED" />}>
      <div className="seq" style={{ marginBottom: 12 }}>
        <span>NORMAL PROCESS</span>
        <i>→</i>
        <span>FAILURE</span>
        <i>→</i>
        <span>EFFECT</span>
        <i>→</i>
        <span>INSPECTION</span>
        <i>→</i>
        <span>REWORK / SCRAP / INTERVENTION</span>
      </div>
      <div className="grid-cards">
        {FAILURES.map((f) => (
          <button
            key={f.id}
            className="card"
            onClick={() => {
              const ui = useUI.getState();
              ui.setOverlay(null);
              go(f.stage);
              setTimeout(() => {
                engine.player.seekPhase(Math.max(0, STAGE_BY_ID[f.stage].phases.findIndex((p) => p.waferState === 'PROCESSING')));
                engine.player.playing = true;
                engine.injectFailure(f.id);
                ui.openPanel('data');
              }, 400);
            }}
          >
            <div className="cap">{STAGE_BY_ID[f.stage]?.short} · {f.disposition}</div>
            <h4>{f.title}</h4>
            <p>{f.cause}</p>
            <p className="dim" style={{ marginTop: 4 }}>→ {f.effect}</p>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/* ------------------------------ dashboard ------------------------------ */

function Dashboard() {
  useTicker(2);
  const fab = engine.fab;
  const counts = fab.stateCounts();
  const [die, setDie] = useState<number | null>(null);
  const d = engine.waferMap.find((x) => x.die.id === die);
  const series = fab.series;
  const lot = fab.followedLot();
  return (
    <Sheet title="FAB DASHBOARD" right={<><DataTag kind="SIMULATED" /><span className="cap">TIME-COMPRESSED ×{FAB_TIME_COMPRESSION}</span></>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 10 }}>
        <div className="chart-card">
          <div className="chart-head">
            <span className="t">Work in progress (lots in fab)</span>
            <span className="v">{fab.lots.length}</span>
          </div>
          <LineChart values={series.wip} min={0} max={40} dt={1} unit="lots" decimals={0} label="WIP" />
        </div>
        <div className="chart-card">
          <div className="chart-head">
            <span className="t">Tool utilisation (processing)</span>
            <span className="v">{fmt(fab.utilisation(), 1)}<small>%</small></span>
          </div>
          <LineChart values={series.util} min={0} max={100} dt={1} unit="%" decimals={0} label="Utilisation" />
        </div>
        <div className="chart-card">
          <div className="chart-head">
            <span className="t">Process moves per fab-hour</span>
            <span className="v">{fmt(fab.movesPerHour(), 0)}</span>
          </div>
          <LineChart values={series.moves} min={0} max={200} dt={1} unit="/h" decimals={0} label="Moves" />
        </div>
        <div className="chart-card">
          <div className="chart-head">
            <span className="t">Equipment status</span>
            <span className="v">{fab.tools.length - 2}<small>tools</small></span>
          </div>
          <Bars items={(Object.keys(counts) as MachineState[]).map((k) => ({ label: k, value: counts[k], color: STATE_COLOR[k] }))} />
        </div>
        <div className="chart-card">
          <div className="chart-head">
            <span className="t">Production queues (lots waiting)</span>
          </div>
          <Bars items={fab.queues().map((q) => ({ label: q.type.toUpperCase(), value: q.waiting }))} />
        </div>
        <div className="chart-card">
          <div className="chart-head">
            <span className="t">Line yield at metrology</span>
            <span className="v">{fmt(fab.lineYield(), 1)}<small>%</small></span>
          </div>
          <LineChart values={series.yield} min={90} max={100} dt={1} unit="%" decimals={1} label="Yield" />
          <div className="cap">INSPECTED {fab.inspected} · FLAGGED {fab.inspected - fab.inspectedPass} · ALARMS {fab.alarmsTotal}</div>
        </div>
        <div className="chart-card">
          <div className="chart-head">
            <span className="t">Wafer map · {engine.twin.waferId}</span>
            <span className="v">{fmt((100 * engine.waferMap.filter((x) => x.result === 'PASS').length) / engine.waferMap.length, 1)}<small>% yield</small></span>
          </div>
          <WaferMapSVG map={engine.waferMap} selected={die} onSelect={(x) => setDie(x.die.id)} size={260} />
          {d && (
            <div className="note">
              Die ({d.die.col},{d.die.row}) · {d.result}
              {d.defect ? ` · ${d.defect}` : ''} · Fmax {fmt(d.fmax, 2)} GHz — fictional educational defect category.
            </div>
          )}
        </div>
        <div className="chart-card">
          <div className="chart-head">
            <span className="t">Followed lot</span>
            <span className="v mono" style={{ fontSize: 12 }}>{lot?.id}</span>
          </div>
          {lot && (
            <>
              <div className="cap">{fab.routeLabel(lot)}</div>
              <div className="seq" style={{ marginTop: 6 }}>{lot.history.slice(-14).map((h, i) => <span key={i}>{h}</span>)}</div>
            </>
          )}
          <h3 className="cap" style={{ marginTop: 10 }}>EVENTS</h3>
          <div className="eventlog" style={{ maxHeight: 150 }}>
            {fab.events.slice(-30).reverse().map((e, i) => (
              <div key={i} className={e.level}>
                <span>{fmt(e.t, 0)}s</span>
                <span>FAB</span>
                <span>{e.msg}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <h3 className="cap" style={{ marginTop: 12 }}>SIMULATION EVENT LOG</h3>
      <EventLog />
    </Sheet>
  );
}

/* ------------------------------ control loops ------------------------------ */

function LoopsOverlay() {
  useTicker(12);
  const loopId = useUI((s) => s.loopId) ?? CONTROL_LOOPS[0].id;
  const [lambda, setLambda] = useState(0.35);
  const r2r = useMemo(() => simulateR2R(60, lambda), [lambda]);
  useEffect(() => {
    engine.openLoop(loopId);
    return () => engine.openLoop(null);
  }, [loopId]);
  const L: ControlLoopSim | null = engine.loop;
  const def = L?.def;
  const nodes = def ? [def.sensor, def.controller, def.actuator, def.process] : [];
  const tPhase = ((engine.time * 0.6) % 1) * 4;
  return (
    <Sheet title="CONTROL LOOPS & MANUFACTURING FEEDBACK" right={<DataTag kind="SIMULATED" />}>
      <div className="seg" style={{ marginBottom: 12 }}>
        {CONTROL_LOOPS.map((l) => (
          <button key={l.id} className={l.id === loopId ? 'on' : ''} onClick={() => useUI.getState().set({ loopId: l.id })}>
            {l.title.toUpperCase()}
          </button>
        ))}
      </div>
      {L && def && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 1fr) minmax(300px, 1fr)', gap: 14 }}>
          <div>
            <svg viewBox="0 0 420 220" style={{ width: '100%' }}>
              {nodes.map((n, i) => {
                const pos = [
                  [70, 50],
                  [350, 50],
                  [350, 170],
                  [70, 170],
                ][i];
                const active = Math.floor(tPhase) === i;
                return (
                  <g key={n} transform={`translate(${pos[0]},${pos[1]})`}>
                    <rect x={-62} y={-22} width={124} height={44} rx={4} fill={active ? 'var(--accent-dim)' : '#151a1f'} stroke={active ? 'var(--accent)' : '#3a434b'} />
                    <text textAnchor="middle" y={-6} fill="#6f7a83" fontSize={8} fontFamily="var(--mono)">
                      {['SENSOR', 'CONTROLLER', 'ACTUATOR', 'PHYSICAL PROCESS'][i]}
                    </text>
                    <text textAnchor="middle" y={9} fill="#dfe4e8" fontSize={9.5}>
                      {n.length > 22 ? n.slice(0, 21) + '…' : n}
                    </text>
                  </g>
                );
              })}
              <path d="M132,50 L288,50" stroke="#6f7a83" markerEnd="url(#a2)" />
              <path d="M350,72 L350,148" stroke="#6f7a83" markerEnd="url(#a2)" />
              <path d="M288,170 L132,170" stroke="#6f7a83" markerEnd="url(#a2)" />
              <path d="M70,148 L70,72" stroke="var(--accent)" markerEnd="url(#a2)" />
              <text x={210} y={40} textAnchor="middle" fill="#a3adb5" fontSize={9} fontFamily="var(--mono)">measured {fmt(L.x, 1)} {def.unit}</text>
              <text x={358} y={112} fill="#a3adb5" fontSize={9} fontFamily="var(--mono)">u = {fmt(L.u, 2)} {def.outUnit}</text>
              <text x={210} y={190} textAnchor="middle" fill="#a3adb5" fontSize={9} fontFamily="var(--mono)">error {fmt(L.error, 2)} {def.unit}</text>
              <text x={78} y={112} fill="var(--accent)" fontSize={9} fontFamily="var(--mono)">feedback</text>
              <defs>
                <marker id="a2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0,0 L10,5 L0,10 z" fill="#6f7a83" />
                </marker>
              </defs>
            </svg>
            <label style={{ display: 'grid', gridTemplateColumns: '90px 1fr 80px', gap: 8, alignItems: 'center', fontSize: 11 }}>
              <span className="cap">SET-POINT</span>
              <input type="range" min={def.spRange[0]} max={def.spRange[1]} step={(def.spRange[1] - def.spRange[0]) / 200} value={L.sp} onChange={(e) => (L.sp = Number(e.target.value))} style={{ accentColor: 'var(--accent)' }} />
              <span className="mono">
                {fmt(L.sp, 1)} {def.unit}
              </span>
            </label>
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="btn sm" onClick={() => L.kick()}>INJECT DISTURBANCE</button>
              <span className="cap" style={{ alignSelf: 'center' }}>PID Kp {def.kp} · Ki {def.ki} · Kd {def.kd} · plant model simplified</span>
            </div>
          </div>
          <div>
            <div className="chart-card">
              <div className="chart-head">
                <span className="t">{def.process} — measured (solid) vs set-point (dashed)</span>
                <span className="v">{fmt(L.x, 1)}<small>{def.unit}</small></span>
              </div>
              <LineChart values={L.hist.pv} ref2={L.hist.sp} ref2Label="SP" min={def.spRange[0]} max={def.spRange[1]} dt={0.05} unit={def.unit} decimals={1} />
            </div>
            <div className="chart-card">
              <div className="chart-head">
                <span className="t">Controller output → {def.actuator}</span>
                <span className="v">{fmt(L.u, 2)}<small>{def.outUnit}</small></span>
              </div>
              <LineChart values={L.hist.u} min={def.outMin} max={def.outMax} dt={0.05} unit={def.outUnit} decimals={2} height={55} color="var(--data-2)" />
            </div>
          </div>
        </div>
      )}
      <h3 className="cap" style={{ marginTop: 18 }}>INSPECTION FEEDBACK LOOP · CMP RUN-TO-RUN (EWMA)</h3>
      <div className="seq" style={{ marginBottom: 8 }}>
        <span>PROCESS (CMP)</span>
        <i>→</i>
        <span>METROLOGY</span>
        <i>→</i>
        <span>RESULT</span>
        <i>→</i>
        <span>CONTROLLER (EWMA)</span>
        <i>→</i>
        <span>CORRECTION (polish time)</span>
        <i>→</i>
        <span>NEXT WAFER</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 10 }}>
        <div className="chart-card">
          <div className="chart-head">
            <span className="t">Removal without feedback (fixed time) — target {r2r.target} nm</span>
          </div>
          <LineChart values={r2r.uncontrolled} min={300} max={430} target={r2r.target} warn={[385, 415]} dt={1} unit="nm" decimals={0} color="var(--data-2)" />
          <div className="cap">PAD WEAR LOWERS REMOVAL RATE · PAD CHANGE AT WAFER 40 · X AXIS = WAFERS</div>
        </div>
        <div className="chart-card">
          <div className="chart-head">
            <span className="t">Removal with run-to-run control</span>
          </div>
          <LineChart values={r2r.controlled} min={300} max={430} target={r2r.target} warn={[385, 415]} dt={1} unit="nm" decimals={0} />
          <label style={{ display: 'grid', gridTemplateColumns: '100px 1fr 40px', gap: 8, alignItems: 'center', fontSize: 11 }}>
            <span className="cap">EWMA λ</span>
            <input type="range" min={0.05} max={1} step={0.05} value={lambda} onChange={(e) => setLambda(Number(e.target.value))} style={{ accentColor: 'var(--accent)' }} />
            <span className="mono">{lambda.toFixed(2)}</span>
          </label>
        </div>
      </div>
      <div className="note">Manufacturing is a loop, not a line: INPUT → PROCESS → MEASURE → DECIDE → PROCESS AGAIN. The EWMA estimator and PID algorithm are standard; plant dynamics and numbers are simulated.</div>
    </Sheet>
  );
}

/* ------------------------------ about ------------------------------ */

function About() {
  return (
    <Sheet title="ABOUT FAB/TWIN" wide={false}>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        FAB/TWIN is a local-first, visual digital twin of semiconductor manufacturing. It runs entirely in the browser from local data — no cloud backend, no external API — and follows one object from quartz to a working computer.
      </p>
      <h3 className="cap">DATA CLASSIFICATION</h3>
      <table className="table">
        <tbody>
          <tr>
            <td><DataTag kind="REAL" /></td>
            <td>Publicly documented fact with a cited source (e.g. silicon melts at 1414 °C; EUV uses 13.5 nm light).</td>
          </tr>
          <tr>
            <td><DataTag kind="REPRESENTATIVE" /></td>
            <td>Typical textbook range for a process parameter — not a specific fab’s recipe.</td>
          </tr>
          <tr>
            <td><DataTag kind="SIMULATED" /></td>
            <td>Produced by the running simulation (telemetry, fab metrics, wafer maps, yields, bins).</td>
          </tr>
          <tr>
            <td><DataTag kind="CONCEPTUAL" /></td>
            <td>Illustrative structures: schematic scales, generic layouts, illustrative routes.</td>
          </tr>
        </tbody>
      </table>
      <h3 className="cap">MODELS</h3>
      <p className="muted">
        All equipment is shown as <EduTag /> — generic engineering reconstructions built procedurally. No proprietary internal architecture, service procedure or recipe is reproduced. Device and interconnect views are simplified models and are labelled as such.
      </p>
      <h3 className="cap">CONTROLS</h3>
      <table className="table">
        <tbody>
          <tr><td>Orbit / zoom / pan</td><td>Drag · scroll · right-drag</td></tr>
          <tr><td>Search</td><td>Ctrl/⌘ + K</td></tr>
          <tr><td>Play / pause</td><td>Space</td></tr>
          <tr><td>Step one operation</td><td>→ (shift → next stage)</td></tr>
          <tr><td>Previous / next stage</td><td>Shift ← / Shift →</td></tr>
          <tr><td>Info layer</td><td>1 · 2 · 3 · 4</td></tr>
          <tr><td>Debug overlay</td><td>` (backtick) or ?debug=1</td></tr>
        </tbody>
      </table>
      <h3 className="cap">REFERENCES ({SOURCES.length})</h3>
      {SOURCES.map((s) => (
        <div key={s.id} className="list-row">
          <span>{s.title}</span>
          <span className="r">{s.org} · {s.date}</span>
        </div>
      ))}
    </Sheet>
  );
}
