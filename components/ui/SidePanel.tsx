'use client';
/**
 * Right-side technical interface (§9, §10, §71, §75, §78, §91). The 3D scene keeps
 * running behind it. Tabs: INSPECT · MACHINE · ASK · DATA · WAFER · SOURCES.
 */
import { useEffect, useMemo, useState } from 'react';
import { useUI, type PanelTab } from '@/lib/store';
import { useStage, useTicker } from '@/hooks/useTicker';
import { engine } from '@/simulation/engine';
import { MACHINE_BY_ID } from '@/data/machines';
import { SENSOR_BY_ID } from '@/data/sensors';
import { ROBOT_BY_ID } from '@/data/robots';
import { GLOSSARY_BY_ID } from '@/data/glossary';
import { MATERIAL_BY_ID } from '@/data/materials';
import { SOURCES, SOURCE_BY_ID } from '@/data/sources';
import { STAGE_BY_ID, STAGES } from '@/data/process';
import { OBJECTS } from '@/data/objects';
import { FAILURE_BY_ID } from '@/data/failures';
import { TOOL_BY_ID, TOOL_TYPE_NAME } from '@/data/fabLayout';
import { SUPPLY_NODES, SUPPLY_EDGES } from '@/data/supplychain';
import { CONTROL_LOOPS } from '@/simulation/control';
import { STATIONS, ROBOT_GEOM } from '@/simulation/robot';
import { provider, QUESTIONS, type AssistantAnswer, type AssistantContext } from '@/lib/assistant';
import { scaleState } from '@/lib/runtime';
import { fmt, formatLength, deg, rad } from '@/lib/math';
import type { MachineDef, QuestionKey, Selection } from '@/types';
import { DataTag, EduTag, GlossaryText, SourceRef, StateChip, StatusBadge } from './common';
import { LineChart, WaferMapSVG } from '../charts/Charts';
import { TWIN_STATE_COLOR } from './Hud';

const TABS: [PanelTab, string][] = [
  ['inspect', 'INSPECT'],
  ['machine', 'MACHINE'],
  ['ask', 'ASK'],
  ['data', 'DATA'],
  ['wafer', 'WAFER'],
  ['sources', 'SOURCES'],
];

export function SidePanel() {
  const open = useUI((s) => s.panelOpen);
  const tab = useUI((s) => s.panelTab);
  const openPanel = useUI((s) => s.openPanel);
  const close = useUI((s) => s.closePanel);
  return (
    <aside className={`panel ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div className="panel-tabs">
        {TABS.map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => openPanel(k)}>
            {l}
          </button>
        ))}
        <button style={{ flex: '0 0 36px' }} onClick={close} title="Close panel">
          ✕
        </button>
      </div>
      <div className="panel-body">
        {open && tab === 'inspect' && <Inspector />}
        {open && tab === 'machine' && <MachineTab />}
        {open && tab === 'ask' && <Companion />}
        {open && tab === 'data' && <DataTab />}
        {open && tab === 'wafer' && <WaferTab />}
        {open && tab === 'sources' && <SourcesTab />}
      </div>
    </aside>
  );
}

/* ================================ INSPECT ================================ */

function KV({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <div className="kv" style={{ gridTemplateColumns: '120px 1fr' }}>
      {rows.map(([k, v]) => (
        <FragmentPair key={k} k={k} v={v} />
      ))}
    </div>
  );
}
function FragmentPair({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <span>{k}</span>
      <span style={{ whiteSpace: 'normal' }}>{v}</span>
    </>
  );
}

function Inspector() {
  useTicker(6);
  const sel = useUI((s) => s.selection);
  const stage = useStage();
  if (!sel) return <StageInfo />;
  switch (sel.kind) {
    case 'machine':
      return <MachinePanel machine={MACHINE_BY_ID[sel.id]} />;
    case 'sensor':
      return <SensorInfo sel={sel} />;
    case 'robot':
      return <RobotInfo sel={sel} />;
    case 'tool':
      return <ToolInfo sel={sel} />;
    case 'glossary': {
      const g = GLOSSARY_BY_ID[sel.id];
      return (
        <div>
          <div className="cap">GLOSSARY</div>
          <h2>{g?.term}</h2>
          {g?.aka && <div className="dim mono" style={{ fontSize: 10 }}>ALSO: {g.aka.join(' · ')}</div>}
          <p style={{ marginTop: 8, color: 'var(--text)' }}>{g?.short}</p>
          {g?.long && <p>{g.long}</p>}
          {g?.stage && <StageLink id={g.stage} />}
          {g?.related && (
            <>
              <h3>Related</h3>
              <div className="seq">
                {g.related.map((r) => (
                  <button key={r} className="btn sm" onClick={() => useUI.getState().select({ kind: 'glossary', id: r, label: GLOSSARY_BY_ID[r]?.term })}>
                    {GLOSSARY_BY_ID[r]?.term ?? r}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      );
    }
    case 'material': {
      const m = MATERIAL_BY_ID[sel.id];
      return (
        <div>
          <div className="cap">MATERIAL · {m?.category.toUpperCase()}</div>
          <h2>{m?.name}</h2>
          {m?.formula && <div className="mono">{m.formula}</div>}
          <p style={{ marginTop: 8 }}>{m?.use}</p>
          {m?.purity && (
            <div className="list-row">
              <span>Purity</span>
              <span className="r">
                {m.purity} <DataTag kind={m.kind} short />
              </span>
            </div>
          )}
          <h3>Used in</h3>
          {m?.stages.map((s) => <StageLink key={s} id={s} />)}
        </div>
      );
    }
    case 'die':
      return <DieInfo sel={sel} />;
    case 'node': {
      const n = SUPPLY_NODES.find((x) => x.id === sel.id);
      const up = SUPPLY_EDGES.filter((e) => e.to === sel.id).map((e) => SUPPLY_NODES.find((x) => x.id === e.from)?.label);
      const down = SUPPLY_EDGES.filter((e) => e.from === sel.id).map((e) => SUPPLY_NODES.find((x) => x.id === e.to)?.label);
      return (
        <div>
          <div className="cap">SUPPLY-CHAIN NODE · TIER {n?.tier}</div>
          <h2>{sel.label ?? n?.label}</h2>
          <p>{n?.note ?? (sel.meta?.role as string)}</p>
          {up.length > 0 && (
            <>
              <h3>Depends on</h3>
              <ul>{up.map((u) => <li key={u}>{u}</li>)}</ul>
            </>
          )}
          {down.length > 0 && (
            <>
              <h3>Supplies</h3>
              <ul>{down.map((u) => <li key={u}>{u}</li>)}</ul>
            </>
          )}
          <div className="note">Generic, educational structure — categories, not companies. Locations and routes on the globe are ILLUSTRATIVE.</div>
        </div>
      );
    }
    default: {
      const o = OBJECTS[sel.id];
      const m = sel.machine ? MACHINE_BY_ID[sel.machine] : undefined;
      const comp = m?.components.find((c) => c.id === sel.id);
      return (
        <div>
          <div className="cap">
            {(o?.category ?? sel.kind).toUpperCase()}
            {m ? ` · ${m.name.toUpperCase()}` : ''}
          </div>
          <h2>{o?.title ?? comp?.name ?? sel.label ?? sel.id}</h2>
          <p style={{ color: 'var(--text)' }}>
            <GlossaryText text={o?.description ?? comp?.description ?? ''} />
          </p>
          {o?.kind && <DataTag kind={o.kind} />}
          {sel.meta && (
            <KV rows={Object.entries(sel.meta).map(([k, v]) => [k.toUpperCase(), typeof v === 'number' ? fmt(v, 2) : v])} />
          )}
          {m && (
            <div className="btn-grid">
              <button className="btn" onClick={() => useUI.getState().select({ kind: 'machine', id: m.id, label: m.name }, 'machine')}>MACHINE ›</button>
              <button className="btn" onClick={() => useUI.getState().ask('how')}>ASK ABOUT THIS</button>
            </div>
          )}
          <div className="note">Context: {stage.title}</div>
        </div>
      );
    }
  }
}

function StageLink({ id }: { id: string }) {
  const st = STAGE_BY_ID[id];
  const go = useUI((s) => s.goToStage);
  if (!st) return null;
  return (
    <button className="comp" onClick={() => go(id)}>
      <b>
        {st.num ? `${String(st.num).padStart(2, '0')} · ` : ''}
        {st.title}
      </b>
      <span>{st.summary}</span>
    </button>
  );
}

function StageInfo() {
  const stage = useStage();
  const info = useUI((s) => s.info);
  const machine = stage.machine ? MACHINE_BY_ID[stage.machine] : undefined;
  return (
    <div>
      <div className="cap">{stage.num ? `STAGE ${String(stage.num).padStart(2, '0')}` : 'LOCATION'} · {stage.location}</div>
      <h2>{stage.title}</h2>
      <p style={{ color: 'var(--text)' }}>
        <GlossaryText text={stage.summary} />
      </p>
      <h3>Why</h3>
      <p>
        <GlossaryText text={stage.why} />
      </p>
      <h3>How</h3>
      <p>
        <GlossaryText text={stage.how} />
      </p>
      {stage.before && (
        <>
          <h3>Transformation</h3>
          <div className="inout" style={{ gridTemplateColumns: '1fr auto 1fr' }}>
            <div className="box">{stage.before}</div>
            <span className="arrow">→</span>
            <div className="box">{stage.after}</div>
          </div>
        </>
      )}
      {stage.facts && stage.facts.length > 0 && (
        <>
          <h3>Key facts</h3>
          {stage.facts.map((f) => (
            <div className="list-row" key={f.label}>
              <span>{f.label}</span>
              <span className="r">
                {f.value} <DataTag kind={f.kind} short /> <SourceRef id={f.source} />
              </span>
            </div>
          ))}
        </>
      )}
      {machine && (
        <div className="btn-grid">
          <button className="btn" onClick={() => useUI.getState().select({ kind: 'machine', id: machine.id, label: machine.name }, 'machine')}>⚙ {machine.name.split(' ')[0].toUpperCase()} INTERFACE</button>
          <button className="btn" onClick={() => useUI.getState().openPanel('data')}>LIVE DATA</button>
        </div>
      )}
      {info >= 4 && (
        <div className="note">
          DEEP DIVE · Phases: {stage.phases.map((p) => `${p.label} (${p.duration}s)`).join(' → ')}. Wafer-state transitions:{' '}
          {Array.from(new Set(stage.phases.map((p) => p.waferState).filter(Boolean))).join(' → ')}.
        </div>
      )}
      <div className="note">Tip: click any machine, robot, sensor or wafer in the 3D view to inspect it.</div>
    </div>
  );
}

/* ================================ MACHINE ================================ */

function MachineTab() {
  const sel = useUI((s) => s.selection);
  const stage = useStage();
  const id = sel?.kind === 'machine' ? sel.id : sel?.machine ?? stage.machine;
  const m = id ? MACHINE_BY_ID[id] : undefined;
  if (!m) return <div className="note">No machine in this view. Open the MACHINES catalogue from the top bar to explore all equipment.</div>;
  return <MachinePanel machine={m} />;
}

export function MachinePanel({ machine: m }: { machine?: MachineDef }) {
  useTicker(4);
  const stage = useStage();
  const ui = useUI.getState();
  const info = useUI((s) => s.info);
  if (!m) return null;
  const here = m.stages.includes(stage.id);
  const loop = CONTROL_LOOPS.find((l) => l.id === m.controlLoop);
  const nextStage = STAGES.find((s) => s.id === m.stages[m.stages.length - 1]);
  return (
    <div>
      <div className="cap">{m.category.toUpperCase()}</div>
      <h2>{m.name.toUpperCase()}</h2>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0 8px', flexWrap: 'wrap' }}>
        {here && <StateChip state={engine.machineState} />}
        {m.modelKind === 'EDUCATIONAL_MODEL' ? <EduTag /> : <span className="dtag REAL">PUBLICLY DOCUMENTED</span>}
      </div>
      <div className="btn-grid">
        <button className="btn" onClick={() => (here ? ui.setCamera('machine') : ui.goToStage(m.stages[0]))}>EXPLORE MACHINE</button>
        <button className="btn" onClick={() => { if (!here) ui.goToStage(m.stages[0]); else engine.player.restart(); }}>RUN PROCESS</button>
        <button className="btn" onClick={() => { if (!here) ui.goToStage(m.stages[0]); ui.setCamera('internal'); const st = STAGE_BY_ID[m.stages[0]]; const v = st.views ?? []; ui.setView(v.includes('cutaway') ? 'cutaway' : v.includes('xray') ? 'xray' : 'normal'); }}>INTERNAL VIEW</button>
        <button className="btn" onClick={() => ui.setInfo(4)}>TECHNICAL DETAILS</button>
        <button className="btn" onClick={() => ui.openPanel('data')}>DATA</button>
        <button className="btn" onClick={() => (nextStage ? ui.next() : undefined)}>NEXT STEP ›</button>
        {here && (
          <button className={`btn ${engine.machineOverride === 'MAINTENANCE' ? 'on' : ''}`} onClick={() => engine.setMaintenance(engine.machineOverride !== 'MAINTENANCE')}>
            MAINTENANCE
          </button>
        )}
        {loop && (
          <button className="btn" onClick={() => { ui.set({ loopId: loop.id }); ui.setOverlay('loops'); }}>
            CONTROL LOOP
          </button>
        )}
      </div>
      <h3>Purpose</h3>
      <p style={{ color: 'var(--text)' }}>
        <GlossaryText text={m.purpose} />
      </p>
      <div className="inout">
        <div className="box">{m.inputs.map((x) => <div key={x}>{x}</div>)}</div>
        <span className="arrow">→</span>
        <div className="box" style={{ borderColor: 'var(--accent)' }}>{m.name.split(' (')[0]}</div>
        <span className="arrow">→</span>
        <div className="box">{m.outputs.map((x) => <div key={x}>{x}</div>)}</div>
      </div>
      <h3>Major components</h3>
      {m.components.map((c) => (
        <button key={c.id} className="comp" onClick={() => ui.select({ kind: 'component', id: c.id, machine: m.id, label: c.name })}>
          <b>{c.name}</b>
          <span>{c.description}</span>
        </button>
      ))}
      <h3>Physical principle</h3>
      <p>
        <GlossaryText text={m.principle} />
      </p>
      <h3>Process sequence</h3>
      <div className="seq">
        {m.sequence.map((s, i) => (
          <span key={s + i} style={{ display: 'contents' }}>
            <span>{s}</span>
            {i < m.sequence.length - 1 && <i>→</i>}
          </span>
        ))}
      </div>
      {m.parameters.length > 0 && (
        <>
          <h3>Key parameters</h3>
          {m.parameters.map((p) => (
            <div className="list-row" key={p.label}>
              <span>{p.label}</span>
              <span className="r">
                {p.value} <DataTag kind={p.kind} short /> <SourceRef id={p.source} />
              </span>
            </div>
          ))}
        </>
      )}
      <h3>Robotics</h3>
      <p>{m.robotics}</p>
      <h3>Sensors</h3>
      {m.sensors.map((s) => (
        <button key={s} className="comp" onClick={() => ui.select({ kind: 'sensor', id: s, machine: m.id, label: SENSOR_BY_ID[s]?.name })}>
          <b>{SENSOR_BY_ID[s]?.name ?? s}</b>
          <span>{SENSOR_BY_ID[s]?.measures}</span>
        </button>
      ))}
      <h3>Energy / utilities</h3>
      <div className="seq">{m.utilities.map((u) => <span key={u}>{u}</span>)}</div>
      <h3>Maintenance</h3>
      <p>{m.maintenance} <span className="dim">(high-level concept only — no proprietary service procedures)</span></p>
      {m.safety && (
        <>
          <h3>Safety / environment</h3>
          <p>{m.safety}</p>
        </>
      )}
      <h3>Related processes &amp; machines</h3>
      {m.stages.map((s) => <StageLink key={s} id={s} />)}
      <div className="seq" style={{ marginTop: 6 }}>
        {m.related.map((r) => (
          <button key={r} className="btn sm" onClick={() => ui.select({ kind: 'machine', id: r, label: MACHINE_BY_ID[r]?.name }, 'machine')}>
            {MACHINE_BY_ID[r]?.name ?? r}
          </button>
        ))}
      </div>
      {info >= 4 && m.sources && (
        <>
          <h3>Sources</h3>
          {m.sources.map((s) => (
            <div key={s} className="list-row">
              <span>{SOURCE_BY_ID[s]?.title}</span>
              <span className="r">{SOURCE_BY_ID[s]?.org}</span>
            </div>
          ))}
        </>
      )}
      <div className="note">Architecture shown is a generic engineering model. Internal layouts of commercial tools are proprietary and are not reproduced.</div>
    </div>
  );
}

/* ---------------- sensor ---------------- */

function SensorInfo({ sel }: { sel: Selection }) {
  const s = SENSOR_BY_ID[sel.id];
  const ch = typeof sel.meta?.channel === 'string' ? engine.tele.get(sel.meta.channel) : undefined;
  return (
    <div>
      <div className="cap">SENSOR · {s?.type.toUpperCase()}{sel.machine ? ` · ${MACHINE_BY_ID[sel.machine]?.name.toUpperCase()}` : ''}</div>
      <h2>{s?.name}</h2>
      <h3>What it measures</h3>
      <p style={{ color: 'var(--text)' }}>{s?.measures}</p>
      <h3>Why it matters</h3>
      <p>{s?.why}</p>
      <h3>Where it is used</h3>
      <p>{s?.where}</p>
      <h3>
        Simulated reading <DataTag kind="SIMULATED" short />
      </h3>
      {ch ? (
        <ChannelCard id={ch.def.id} />
      ) : (
        <p className="dim">No live channel bound in this view (unit: {s?.unit}).</p>
      )}
      <h3>Closed loop</h3>
      <div className="seq">
        <span>SENSOR</span>
        <i>→</i>
        <span>CONTROLLER</span>
        <i>→</i>
        <span>ACTUATOR</span>
        <i>→</i>
        <span>PROCESS</span>
        <i>↺</i>
      </div>
    </div>
  );
}

/* ---------------- robot ---------------- */

function RobotInfo({ sel }: { sel: Selection }) {
  const r = ROBOT_BY_ID[sel.id];
  const stage = useStage();
  const ctrl = engine.robot;
  const live = sel.id === 'wafer-robot' && (stage.id === 'cleanroom-entry' || stage.id === 'robot-lab');
  const ui = useUI.getState();
  const trace = useUI((s) => s.trace);
  const j = ctrl.joints();
  const p = ctrl.effector();
  return (
    <div>
      <div className="cap">ROBOT · {r?.category.toUpperCase()}</div>
      <h2>{r?.name}</h2>
      <p style={{ color: 'var(--text)' }}>{r?.task}</p>
      <h3>Mechanism</h3>
      <p>{r?.mechanism}</p>
      <h3>Movement</h3>
      <p>{r?.movement}</p>
      <h3>Sensors</h3>
      <div className="seq">{r?.sensors.map((s) => <span key={s}>{SENSOR_BY_ID[s]?.name ?? s}</span>)}</div>
      <h3>Controller</h3>
      <p>{r?.controller}</p>
      {live && (
        <>
          <h3>
            Telemetry <DataTag kind="SIMULATED" short />
          </h3>
          <KV
            rows={[
              ['Joint 1 (θ)', `${fmt(deg(j.j1), 1)}°`],
              ['Joint 2 (shoulder)', `${fmt(deg(j.j2), 1)}°`],
              ['Joint 3 (elbow)', `${fmt(deg(j.j3), 1)}°`],
              ['Z lift', `${fmt(ctrl.q[2] * 1000, 1)} mm`],
              ['End effector', `X ${fmt(p.x * 1000, 0)} · Y ${fmt(p.y * 1000, 0)} · Z ${fmt(p.z * 1000, 0)} mm`],
              ['Velocity', `${fmt(ctrl.speed() * 1000, 0)} mm/s`],
              ['Acceleration', `${fmt(ctrl.accel(), 2)} m/s²`],
              ['Grip / vacuum', `${ctrl.vacuumOn ? 'ON' : 'OFF'} · ${fmt(ctrl.vacuumKPa, 1)} kPa`],
              ['Wafer state', ctrl.waferLoc.toUpperCase()],
              ['Step', `${ctrl.stepLabel} · ${ctrl.sequenceLabel}`],
              ['Cycle time', `${fmt(ctrl.cycleTime, 1)} s (last ${fmt(ctrl.lastCycle, 1)} s)`],
              ['Error state', <span key="e" style={{ color: ctrl.error ? '#ff7a6e' : 'var(--good)' }}>{ctrl.error ?? 'NONE'}</span>],
            ]}
          />
          <RobotManual />
        </>
      )}
      <h3>Interacts with</h3>
      <div className="seq">
        {r?.interacts.map((x) => (
          <button key={x} className="btn sm" onClick={() => ui.select({ kind: 'machine', id: x, label: MACHINE_BY_ID[x]?.name }, 'machine')}>
            {MACHINE_BY_ID[x]?.name ?? x}
          </button>
        ))}
      </div>
      <div className="btn-grid">
        <button className={`btn ${trace ? 'on' : ''}`} onClick={() => ui.toggle('trace')}>TRACE (MACHINES SERVED)</button>
        {r && !live && <button className="btn" onClick={() => ui.goToStage(r.stage ?? 'robot-lab')}>GO TO ROBOT</button>}
      </div>
    </div>
  );
}

function RobotManual() {
  const ctrl = engine.robot;
  const [th, setTh] = useState(deg(ctrl.q[0]));
  const [r, setR] = useState(ctrl.q[1] * 1000);
  const [z, setZ] = useState(ctrl.q[2] * 1000);
  const manual = ctrl.mode === 'manual';
  const apply = (a = th, b = r, c = z) => ctrl.jogTo(rad(a), b / 1000, c / 1000);
  useTicker(4);
  const station = ctrl.stationAtEffector();
  return (
    <>
      <h3>
        Control mode
        <div className="seg">
          <button className={!manual ? 'on' : ''} onClick={() => { ctrl.mode = 'auto'; if (engine.stage.id === 'robot-lab') { ctrl.clear(); ctrl.loop = true; } }}>AUTOMATIC</button>
          <button className={manual ? 'on' : ''} onClick={() => { ctrl.mode = 'manual'; ctrl.loop = false; ctrl.clear(); setTh(deg(ctrl.q[0])); setR(ctrl.q[1] * 1000); setZ(ctrl.q[2] * 1000); }}>MANUAL</button>
        </div>
      </h3>
      {manual && (
        <div style={{ display: 'grid', gap: 6 }}>
          {([
            ['θ BASE', th, -180, 180, 1, '°', (v: number) => { setTh(v); apply(v, r, z); }],
            ['R EXTENSION', r, ROBOT_GEOM.rMin * 1000, ROBOT_GEOM.rMax * 1000, 1, 'mm', (v: number) => { setR(v); apply(th, v, z); }],
            ['Z LIFT', z, ROBOT_GEOM.zMin * 1000, ROBOT_GEOM.zMax * 1000, 1, 'mm', (v: number) => { setZ(v); apply(th, r, v); }],
          ] as const).map(([label, val, min, max, step, unit, fn]) => (
            <label key={label} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 60px', gap: 8, alignItems: 'center', fontSize: 11 }}>
              <span className="cap">{label}</span>
              <input type="range" min={min} max={max} step={step} value={val} onChange={(e) => fn(Number(e.target.value))} style={{ accentColor: 'var(--accent)' }} />
              <span className="mono">{fmt(val, 0)} {unit}</span>
            </label>
          ))}
          <div className="seq">
            {(['home', 'foup', 'aligner', 'chamber'] as const).map((k) => (
              <button key={k} className="btn sm" onClick={() => { const s = STATIONS[k]; const a = deg(s.th); setTh(a); setR(s.r * 1000); setZ((s.z - 0.008) * 1000); apply(a, s.r * 1000, (s.z - 0.008) * 1000); }}>
                TO {k.toUpperCase()}
              </button>
            ))}
            <button className={`btn sm ${ctrl.vacuumOn ? 'on' : ''}`} onClick={() => ctrl.toggleVacuum()}>
              VACUUM {ctrl.vacuumOn ? 'ON' : 'OFF'}
            </button>
          </div>
          <div className="note">
            Station under end effector: {station ? station.label : 'none'}. Approach a station from below (Z), raise to lift the wafer, then switch vacuum ON to grip. Moves use trapezoidal profiles within joint limits.
          </div>
        </div>
      )}
    </>
  );
}

/* ---------------- fab tool ---------------- */

function ToolInfo({ sel }: { sel: Selection }) {
  const t = engine.fab.toolById[sel.id];
  const def = TOOL_BY_ID[sel.id];
  const m = MACHINE_BY_ID[def?.machine ?? ''];
  if (!t || !def) return null;
  const total = Object.values(t.stateTime).reduce((a, b) => a + b, 0) || 1;
  return (
    <div>
      <div className="cap">FAB TOOL · {TOOL_TYPE_NAME[def.type].toUpperCase()}</div>
      <h2>{def.id}</h2>
      <div style={{ margin: '4px 0 8px' }}>
        <StateChip state={t.state} /> <DataTag kind="SIMULATED" short />
      </div>
      <KV
        rows={[
          ['Current lot', t.lot?.id ?? '—'],
          ['Waiting at ports', `${t.inbox.length} in · ${t.outbox.length} out`],
          ['Lots processed', String(t.processed)],
          ['Time in state', `${fmt(engine.fab.time - t.since, 0)} s`],
          ['Utilisation', `${fmt((100 * t.stateTime.PROCESSING) / total, 1)} %`],
          ['Downtime', `${fmt((100 * (t.stateTime.ALARM + t.stateTime.MAINTENANCE)) / total, 1)} %`],
          ['Position', `X ${fmt(def.x, 1)} · Z ${fmt(def.z, 1)} m`],
        ]}
      />
      <div className="btn-grid">
        <button className="btn" onClick={() => engine.fab.force(def.id, 'MAINTENANCE')}>MAINTENANCE</button>
        <button className="btn" onClick={() => engine.fab.force(def.id, 'OFFLINE')}>OFFLINE</button>
        <button className="btn" onClick={() => engine.fab.force(def.id, null)}>RELEASE</button>
        {m && <button className="btn" onClick={() => useUI.getState().goToStage(m.stages[0])}>ENTER PROCESS ›</button>}
      </div>
      {m && (
        <button className="comp" onClick={() => useUI.getState().select({ kind: 'machine', id: m.id, label: m.name }, 'machine')}>
          <b>{m.name}</b>
          <span>{m.purpose}</span>
        </button>
      )}
    </div>
  );
}

/* ---------------- die ---------------- */

function DieInfo({ sel }: { sel: Selection }) {
  const d = engine.waferMap.find((x) => x.die.id === Number(sel.id));
  if (!d) return null;
  return (
    <div>
      <div className="cap">DIE · WAFER {engine.twin.waferId}</div>
      <h2>
        Die ({d.die.col}, {d.die.row})
      </h2>
      <KV
        rows={[
          ['Result', <span key="r" style={{ color: d.result === 'PASS' ? 'var(--good)' : d.result === 'FAIL' ? '#ff6b5e' : 'var(--warn)' }}>{d.result}</span>],
          ['Defect class', d.defect ?? '—'],
          ['Position', `${fmt(d.die.cx, 1)}, ${fmt(d.die.cy, 1)} mm`],
          ['Max frequency', `${fmt(d.fmax, 2)} GHz`],
          ['Bin', d.result === 'PASS' ? engine.binOf(d.fmax, d.die.id) : '—'],
        ]}
      />
      <div className="note">Fictional educational defect category and simulated electrical data — not production data from any fab.</div>
    </div>
  );
}

/* ================================ ASK ================================ */

function Companion() {
  useTicker(2);
  const stage = useStage();
  const sel = useUI((s) => s.selection);
  const topic = useUI((s) => s.askTopic);
  const cameraMode = useUI((s) => s.cameraMode);
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const p = provider();

  const ctx = (): AssistantContext => ({
    stage,
    object: sel,
    cameraMode,
    scaleView: formatLength(scaleState.viewWidth),
    telemetry: engine.tele.channels.map((c) => ({ label: c.def.label, value: `${fmt(c.value, c.def.decimals ?? 1)} ${c.def.unit}`, status: c.status })),
    wafer: { id: engine.twin.displayId, state: engine.twin.state, stage: engine.twin.stageTitle, layers: engine.twin.layerCount },
  });

  const run = async (k: QuestionKey | string) => {
    setBusy(true);
    try {
      setAnswer(await p.answer(k, ctx()));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (topic) {
      run(topic);
      useUI.getState().set({ askTopic: null });
    } else if (!answer) run('what');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, stage.id, sel?.id]);

  return (
    <div>
      <div className="cap">TECHNICAL COMPANION</div>
      <div className="ctx" style={{ marginTop: 6 }}>
        <span>SCENE</span>
        <span>{stage.short}</span>
        <span>OBJECT</span>
        <span>{sel ? sel.label ?? sel.id : stage.machine ? MACHINE_BY_ID[stage.machine]?.name : stage.title}</span>
        <span>CAMERA</span>
        <span>{cameraMode.toUpperCase()}</span>
        <span>VIEW WIDTH</span>
        <span>{formatLength(scaleState.viewWidth)}{scaleState.schematic ? ' (educational scale)' : ''}</span>
        <span>STATUS</span>
        <span>
          <StatusBadge status={engine.tele.status} />
        </span>
      </div>
      <div className="qchips">
        {QUESTIONS.map((x) => (
          <button key={x.key} onClick={() => run(x.key)}>
            {x.key === 'how' && sel?.kind === 'robot' ? 'How does it move?' : x.label}
          </button>
        ))}
      </div>
      {busy && <div className="dim">…</div>}
      {answer && (
        <div className="answer">
          <div className="q">{answer.question}</div>
          {answer.paragraphs.map((t, i) => (
            <p key={i}>
              <GlossaryText text={t} />
            </p>
          ))}
          {answer.related && (
            <div className="seq">
              {answer.related.map((r) => (
                <button
                  key={r.label}
                  className="btn sm"
                  onClick={() => {
                    if (r.stage && r.stage !== stage.id) useUI.getState().goToStage(r.stage);
                    if (r.selection) setTimeout(() => useUI.getState().select(r.selection!, 'inspect'), 50);
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <form
        className="askbox"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) run(q.trim());
        }}
      >
        <input placeholder="Ask about anything in the fab… e.g. “overlay”" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" type="submit">
          ASK
        </button>
      </form>
      <div className="note">
        {p.label}. Answers come from the local process, machine, sensor and glossary database. An external AI assistant can be connected later through the same context interface — it is never required.
      </div>
    </div>
  );
}

/* ================================ DATA ================================ */

export function ChannelCard({ id }: { id: string }) {
  const c = engine.tele.get(id);
  if (!c) return null;
  const d = c.def;
  const values = c.series();
  const color = c.status === 'FAULT' ? '#d03b3b' : c.status === 'WARNING' ? '#fab219' : 'var(--data)';
  return (
    <div className={`chart-card ${c.status}`}>
      <div className="chart-head">
        <span className="t">
          {d.label} <DataTag kind={d.kind} short />
        </span>
        <span className="v">
          {isFinite(c.value) ? fmt(c.value, d.decimals ?? 1) : '—'}
          <small>{d.unit}</small>
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <StatusBadge status={c.status} />
        {d.target !== undefined && <span className="cap">TARGET {fmt(d.target, d.decimals ?? 1)} {d.unit}</span>}
      </div>
      <LineChart values={values} min={d.min} max={d.max} target={d.target} warn={d.warn} fault={d.fault} unit={d.unit} decimals={d.decimals} color={color} label={d.label} />
    </div>
  );
}

function DataTab() {
  useTicker(6);
  const stage = useStage();
  const chans = engine.tele.channels;
  const f = engine.failure;
  const fdef = f ? FAILURE_BY_ID[f.id] : undefined;
  return (
    <div>
      <div className="cap">LIVE DATA · {stage.short.toUpperCase()}</div>
      <p style={{ fontSize: 11.5 }}>Every chart below is sampled from the running simulation — the same values that drive the 3D animation. Values are SIMULATED unless tagged otherwise.</p>
      {(stage.failures?.length ?? 0) > 0 && (
        <>
          <h3>What if something goes wrong?</h3>
          {!f && (
            <div className="seq">
              {stage.failures!.map((id) => (
                <button key={id} className="btn sm danger" onClick={() => engine.injectFailure(id)}>
                  ⚠ {FAILURE_BY_ID[id]?.title}
                </button>
              ))}
            </div>
          )}
          {f && fdef && (
            <div className="chart-card FAULT">
              <div className="chart-head">
                <span className="t">{fdef.title}</span>
                <span className="mono" style={{ color: '#ff7a6e' }}>{f.phase}</span>
              </div>
              <div className="seq" style={{ margin: '6px 0' }}>
                {(['INJECTED', 'DEVIATING', 'DETECTED', 'DISPOSITION'] as const).map((ph, i) => (
                  <span key={ph} style={{ borderColor: ['INJECTED', 'DEVIATING', 'DETECTED', 'DISPOSITION'].indexOf(f.phase) >= i ? '#d03b3b' : undefined }}>
                    {['NORMAL → FAILURE', 'EFFECT', 'INSPECTION / DETECTION', fdef.disposition][i]}
                  </span>
                ))}
              </div>
              <p><b>Cause.</b> {fdef.cause}</p>
              <p><b>Effect.</b> {fdef.effect}</p>
              <p><b>Detection.</b> {fdef.detection}</p>
              <p><b>{fdef.disposition}.</b> {fdef.dispositionText}</p>
              <button className="btn" onClick={() => engine.resetFailure()}>RESET PROCESS</button>
            </div>
          )}
        </>
      )}
      <h3>Process telemetry</h3>
      {chans.length === 0 && <div className="note">This view is conceptual — no process telemetry.</div>}
      {chans.map((c) => (
        <ChannelCard key={c.def.id} id={c.def.id} />
      ))}
      {['inspection', 'wafer-sort', 'e-test'].includes(stage.id) && (
        <>
          <h3>Wafer map · {engine.twin.waferId}</h3>
          <WaferMapSVG map={engine.waferMap} onSelect={(d) => useUI.getState().select({ kind: 'die', id: String(d.die.id), label: `Die ${d.die.col},${d.die.row}` })} selected={Number(useUI.getState().selection?.id ?? -1)} />
        </>
      )}
      <h3>Event log</h3>
      <EventLog />
    </div>
  );
}

export function EventLog() {
  const ev = engine.events.slice(-60).reverse();
  return (
    <div className="eventlog">
      {ev.map((e, i) => (
        <div key={i} className={e.level}>
          <span>{fmt(e.t, 1)}s</span>
          <span>{e.source}</span>
          <span>{e.msg}</span>
        </div>
      ))}
    </div>
  );
}

/* ================================ WAFER ================================ */

function WaferTab() {
  useTicker(4);
  const tw = engine.twin;
  const trace = useUI((s) => s.trace);
  const go = useUI((s) => s.goToStage);
  const snapshot = useMemo(
    () => ({
      waferId: tw.waferId,
      lotId: tw.lotId,
      processStage: tw.stageId,
      currentMachine: tw.machine,
      layerCount: tw.layerCount,
      inspectionState: tw.inspection,
      defectCount: tw.defectCount,
      testState: tw.testState,
      packageState: tw.packageState,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tw.version],
  );
  return (
    <div>
      <div className="cap">DIGITAL TWIN · {tw.formLabel}</div>
      <h2 className="mono">{tw.displayId}</h2>
      <div className="dim mono" style={{ fontSize: 10 }}>
        {tw.batchId} → {tw.ingotId} → {tw.waferId} → {tw.chipId}
      </div>
      <div style={{ margin: '8px 0' }}>
        <span className="chip" style={{ color: TWIN_STATE_COLOR[tw.state] }}>{tw.state}</span> <DataTag kind="SIMULATED" short />
      </div>
      <KV
        rows={[
          ['Lot / slot', `${tw.lotId} / ${tw.slot}`],
          ['Process stage', tw.stageTitle],
          ['Equipment', MACHINE_BY_ID[tw.machine]?.name ?? '—'],
          ['Location', tw.location],
          ['Surface', tw.surface],
          ['Thickness', tw.thicknessUm ? `${tw.thicknessUm} µm` : '—'],
          ['Layers', `${tw.layerCount} (mask layers ${tw.maskLayers})`],
          ['Process cycle', String(tw.processCycle)],
          ['Inspection', `${tw.inspection} · ${tw.defectCount} defects`],
          ['Test', tw.testState],
          ['Package', tw.packageState],
        ]}
      />
      <h3>
        State record (JSON)
        <span className="dim">machine-readable</span>
      </h3>
      <pre className="mono" style={{ fontSize: 10.5, background: 'rgba(255,255,255,0.03)', padding: 8, borderRadius: 4, overflowX: 'auto', margin: 0 }}>
        {JSON.stringify(snapshot, null, 1)}
      </pre>
      <h3>
        Trace — machines visited
        <button className={`btn sm ${trace ? 'on' : ''}`} onClick={() => useUI.getState().toggle('trace')}>TRACE IN 3D</button>
      </h3>
      {tw.history.length === 0 && <div className="dim">No history yet.</div>}
      {tw.history.slice().reverse().map((h, i) => (
        <button key={i} className="comp" onClick={() => go(h.stageId)}>
          <b>
            {String(h.num).padStart(2, '0')} · {h.title}{' '}
            <span style={{ color: h.result === 'OK' ? 'var(--good)' : h.result === 'IN PROGRESS' ? 'var(--accent)' : '#ff7a6e', fontFamily: 'var(--mono)', fontSize: 10 }}>{h.result}</span>
          </b>
          <span>{MACHINE_BY_ID[h.machine ?? '']?.name ?? h.location}</span>
        </button>
      ))}
      <h3>State transitions (legal path enforced)</h3>
      <div className="eventlog">
        {tw.transitions.slice(-25).reverse().map((t, i) => (
          <div key={i}>
            <span>{fmt(t.t, 1)}s</span>
            <span style={{ color: TWIN_STATE_COLOR[t.to] }}>{t.to.replace(/_/g, ' ')}</span>
            <span>{t.reason}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ================================ SOURCES ================================ */

function SourcesTab() {
  const stage = useStage();
  const machine = stage.machine ? MACHINE_BY_ID[stage.machine] : undefined;
  const ids = Array.from(new Set([...(stage.sources ?? []), ...(machine?.sources ?? []), ...(stage.facts ?? []).map((f) => f.source).filter(Boolean)])) as string[];
  const rest = SOURCES.filter((s) => !ids.includes(s.id));
  const Card = ({ id }: { id: string }) => {
    const s = SOURCE_BY_ID[id];
    if (!s) return null;
    return (
      <div className="comp" style={{ cursor: 'default' }}>
        <b>{s.title}</b>
        <span>
          {s.org} · {s.date}
          {s.section ? ` · ${s.section}` : ''}
        </span>
        {s.url && (
          <div>
            <a href={s.url} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
              {s.url}
            </a>
          </div>
        )}
        {s.note && <div className="dim" style={{ fontSize: 11, marginTop: 2 }}>{s.note}</div>}
      </div>
    );
  };
  return (
    <div>
      <div className="cap">SOURCES</div>
      <p style={{ fontSize: 11.5 }}>Real technical claims are tagged REAL or REPRESENTATIVE and cite a public reference. Everything produced by the simulation is SIMULATED; illustrative structures are CONCEPTUAL.</p>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0 10px' }}>
        <DataTag kind="REAL" />
        <DataTag kind="REPRESENTATIVE" />
        <DataTag kind="SIMULATED" />
        <DataTag kind="CONCEPTUAL" />
      </div>
      <h3>This stage</h3>
      {ids.length === 0 && <div className="dim">No sourced claims in this view.</div>}
      {ids.map((id) => <Card key={id} id={id} />)}
      <h3>All references</h3>
      {rest.map((s) => <Card key={s.id} id={s.id} />)}
    </div>
  );
}
