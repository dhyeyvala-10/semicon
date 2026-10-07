/**
 * Fab-level discrete-event simulation for RUN FAB mode (§60) and the control room (§56).
 * Tools follow the machine state model; lots (FOUPs) follow a re-entrant route; OHT
 * vehicles move along a single directed rail loop with acceleration limits.
 * All outputs are SIMULATED and time-compressed for viewing.
 */
import type { MachineState } from '@/types';
import { TOOLS, OHT_LOOP, LAYER_ROUTE, ROUTE_LOOPS, FAB, type ToolInstance, type ToolType } from '@/data/fabLayout';
import { rng } from '@/lib/math';

/** One second of playback stands for this many seconds of fab time in reported rates. */
export const FAB_TIME_COMPRESSION = 60;

export interface SimLot {
  id: string;
  wafers: number;
  step: number; // index into full route
  followed: boolean;
  /** where the FOUP physically is */
  at: { kind: 'port'; tool: string; port: number } | { kind: 'vehicle'; vehicle: number } | { kind: 'tool'; tool: string };
  history: string[];
  waiting: 'process' | 'transport' | 'none';
  defects: number;
}

export interface SimTool {
  def: ToolInstance;
  state: MachineState;
  since: number;
  lot: SimLot | null;
  inbox: SimLot[];
  outbox: SimLot[];
  procEnd: number;
  stateTime: Record<MachineState, number>;
  processed: number;
  nextFail: number;
  /** forced by visitor */
  forced: MachineState | null;
}

export interface Vehicle {
  id: number;
  s: number; // arc length on loop
  v: number;
  target: number | null; // arc-length stop
  phase: 'idle' | 'toPick' | 'hoistDown' | 'hoistUp' | 'toDrop' | 'dropDown' | 'dropUp';
  timer: number;
  hoist: number; // 0 up, 1 down
  job: Job | null;
  carrying: SimLot | null;
}

interface Job {
  lot: SimLot;
  from: { tool: string; port: number; s: number };
  to: { tool: string; port: number; s: number };
}

const FULL_ROUTE: ToolType[] = Array.from({ length: ROUTE_LOOPS }, () => LAYER_ROUTE).flat();

/* ------------------------- loop geometry ------------------------- */

const SEGS = OHT_LOOP.map((p, i) => {
  const q = OHT_LOOP[(i + 1) % OHT_LOOP.length];
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  return { a: p, b: q, len };
});
const SEG_START: number[] = [];
{
  let acc = 0;
  for (const s of SEGS) {
    SEG_START.push(acc);
    acc += s.len;
  }
}
export const LOOP_LENGTH = SEGS.reduce((a, s) => a + s.len, 0);

export function loopPoint(s: number): { x: number; z: number; dir: number } {
  const u = ((s % LOOP_LENGTH) + LOOP_LENGTH) % LOOP_LENGTH;
  let i = SEG_START.length - 1;
  for (let k = 0; k < SEG_START.length; k++) {
    if (SEG_START[k] > u) {
      i = k - 1;
      break;
    }
  }
  const seg = SEGS[Math.max(0, i)];
  const t = seg.len > 0 ? (u - SEG_START[Math.max(0, i)]) / seg.len : 0;
  return {
    x: seg.a[0] + (seg.b[0] - seg.a[0]) * t,
    z: seg.a[1] + (seg.b[1] - seg.a[1]) * t,
    dir: Math.atan2(-(seg.b[1] - seg.a[1]), seg.b[0] - seg.a[0]),
  };
}

/** Project a world point onto the loop → arc length. */
export function projectToLoop(x: number, z: number): number {
  let best = 0;
  let bestD = Infinity;
  SEGS.forEach((seg, i) => {
    const dx = seg.b[0] - seg.a[0];
    const dz = seg.b[1] - seg.a[1];
    const L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - seg.a[0]) * dx + (z - seg.a[1]) * dz) / L2));
    const px = seg.a[0] + dx * t;
    const pz = seg.a[1] + dz * t;
    const d = (px - x) ** 2 + (pz - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = SEG_START[i] + seg.len * t;
    }
  });
  return best;
}

const PORT_S: Record<string, number[]> = Object.fromEntries(TOOLS.map((t) => [t.id, t.ports.map((p) => projectToLoop(p.x, p.z))]));
export const portArc = (tool: string, port: number) => PORT_S[tool]?.[port] ?? 0;

const fwd = (from: number, to: number) => (((to - from) % LOOP_LENGTH) + LOOP_LENGTH) % LOOP_LENGTH;

const STATES: MachineState[] = ['IDLE', 'LOADING', 'PROCESSING', 'UNLOADING', 'MAINTENANCE', 'ALARM', 'OFFLINE'];
const zeroStates = () => Object.fromEntries(STATES.map((s) => [s, 0])) as Record<MachineState, number>;

/** load-port docking height: FOUP bottom sits 900 mm above the floor */
export const PORT_HEIGHT = 0.9;
const V_MAX = 4.0; // m/s
const A_MAX = 1.6; // m/s²
const HOIST_T = 1.6; // s
const LOAD_T = 2.2;
const UNLOAD_T = 2.2;

export interface FabEvent {
  t: number;
  level: 'info' | 'warn' | 'alarm';
  msg: string;
}

export class FabSim {
  time = 0;
  tools: SimTool[] = [];
  toolById: Record<string, SimTool> = {};
  lots: SimLot[] = [];
  vehicles: Vehicle[] = [];
  events: FabEvent[] = [];
  moves = 0;
  completedLots = 0;
  inspected = 0;
  inspectedPass = 0;
  alarmsTotal = 0;
  /** rolling series for control-room charts (one sample per playback second) */
  series = { wip: [] as number[], util: [] as number[], moves: [] as number[], queue: [] as number[], yield: [] as number[] };
  private moveStamps: number[] = [];
  private sampleAcc = 0;
  private r = rng(184);
  private lotSeq = 731;
  private jobs: Job[] = [];
  version = 0;

  constructor() {
    this.reset();
  }

  reset() {
    this.r = rng(184);
    this.time = 0;
    this.moves = 0;
    this.completedLots = 0;
    this.inspected = 0;
    this.inspectedPass = 0;
    this.alarmsTotal = 0;
    this.events = [];
    this.moveStamps = [];
    this.jobs = [];
    this.series = { wip: [], util: [], moves: [], queue: [], yield: [] };
    this.tools = TOOLS.map((def) => ({
      def,
      state: 'IDLE' as MachineState,
      since: 0,
      lot: null,
      inbox: [],
      outbox: [],
      procEnd: 0,
      stateTime: zeroStates(),
      processed: 0,
      nextFail: 200 + this.r() * 900,
      forced: null,
    }));
    this.toolById = Object.fromEntries(this.tools.map((t) => [t.def.id, t]));
    // one tool under qualification → OFFLINE
    const off = this.tools.find((t) => t.def.id === 'METRO-07');
    if (off) off.state = 'OFFLINE';
    this.vehicles = Array.from({ length: 14 }, (_, i) => ({
      id: i,
      s: (LOOP_LENGTH / 14) * i,
      v: 0,
      target: null,
      phase: 'idle',
      timer: 0,
      hoist: 0,
      job: null,
      carrying: null,
    }));
    this.lots = [];
    this.lotSeq = 700;
    // seed WIP spread over the route
    const N = 34;
    for (let i = 0; i < N; i++) {
      const step = Math.floor((i / N) * FULL_ROUTE.length);
      const lot = this.newLot(step, i === 9);
      const tool = this.pickTool(FULL_ROUTE[step]);
      if (!tool) continue;
      lot.at = { kind: 'port', tool: tool.def.id, port: 0 };
      lot.waiting = 'process';
      tool.inbox.push(lot);
    }
    this.version++;
  }

  private newLot(step: number, followed = false): SimLot {
    this.lotSeq++;
    const lot: SimLot = {
      id: followed ? 'LOT-A0731' : `LOT-A${String(this.lotSeq).padStart(4, '0')}`,
      wafers: 25,
      step,
      followed,
      at: { kind: 'tool', tool: 'STK-01' },
      history: [],
      waiting: 'none',
      defects: 0,
    };
    this.lots.push(lot);
    return lot;
  }

  log(level: FabEvent['level'], msg: string) {
    this.events.push({ t: this.time, level, msg });
    if (this.events.length > 120) this.events.shift();
  }

  private setState(t: SimTool, s: MachineState) {
    if (t.state === s) return;
    t.state = s;
    t.since = this.time;
    this.version++;
  }

  /** choose a tool of a type: least loaded, available */
  pickTool(type: ToolType): SimTool | null {
    let best: SimTool | null = null;
    let bestScore = Infinity;
    for (const t of this.tools) {
      if (t.def.type !== type) continue;
      if (t.state === 'OFFLINE' || t.forced === 'OFFLINE') continue;
      const down = t.state === 'ALARM' || t.state === 'MAINTENANCE' ? 6 : 0;
      const score = t.inbox.length + (t.lot ? 1 : 0) + down + this.r() * 0.3;
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  /** Visitor control: force a tool into maintenance / offline or release it. */
  force(toolId: string, s: MachineState | null) {
    const t = this.toolById[toolId];
    if (!t) return;
    t.forced = s;
    if (s) {
      this.setState(t, s);
      this.log(s === 'ALARM' ? 'alarm' : 'warn', `${toolId} → ${s} (operator)`);
    } else {
      this.setState(t, 'IDLE');
      this.log('info', `${toolId} released to production`);
    }
  }

  triggerDowntime(toolId = 'ETCH-02') {
    const t = this.toolById[toolId];
    if (!t) return;
    this.setState(t, 'ALARM');
    t.procEnd = this.time + 8;
    this.alarmsTotal++;
    this.log('alarm', `${toolId} ALARM — chamber fault (simulated)`);
  }

  private requestTransport(lot: SimLot, from: SimTool, port: number) {
    const nextType = FULL_ROUTE[lot.step];
    let dest: SimTool | null;
    if (nextType === undefined) dest = this.toolById['STK-02'];
    else dest = this.pickTool(nextType);
    if (!dest) return;
    const dp = Math.floor(this.r() * dest.def.ports.length);
    this.jobs.push({
      lot,
      from: { tool: from.def.id, port, s: portArc(from.def.id, port) },
      to: { tool: dest.def.id, port: dp, s: portArc(dest.def.id, dp) },
    });
    lot.waiting = 'transport';
  }

  private assignJobs() {
    for (let j = this.jobs.length - 1; j >= 0; j--) {
      const job = this.jobs[j];
      let best: Vehicle | null = null;
      let bestD = Infinity;
      for (const v of this.vehicles) {
        if (v.phase !== 'idle') continue;
        const d = fwd(v.s, job.from.s);
        if (d < bestD) {
          bestD = d;
          best = v;
        }
      }
      if (!best) return;
      best.job = job;
      best.phase = 'toPick';
      best.target = job.from.s;
      this.jobs.splice(j, 1);
    }
  }

  private driveVehicle(v: Vehicle, dt: number) {
    // keep spacing from vehicle ahead
    let gap = Infinity;
    for (const o of this.vehicles) {
      if (o === v) continue;
      const d = fwd(v.s, o.s);
      if (d > 0 && d < gap) gap = d;
    }
    const toStop = v.target !== null ? fwd(v.s, v.target) : Infinity;
    const limitDist = Math.min(toStop, gap - 1.6);
    const vAllowed = Math.sqrt(Math.max(0, 2 * A_MAX * Math.max(0, limitDist)));
    const vTarget = Math.min(V_MAX, vAllowed);
    if (v.v < vTarget) v.v = Math.min(vTarget, v.v + A_MAX * dt);
    else v.v = Math.max(vTarget, v.v - A_MAX * 2 * dt);
    const ds = Math.min(v.v * dt, Math.max(0, limitDist));
    v.s = (v.s + ds) % LOOP_LENGTH;
    return toStop - ds < 0.02 && v.v < 0.3;
  }

  tick(dt: number) {
    if (dt <= 0) return;
    this.time += dt;
    const now = this.time;

    /* ---------------- tools ---------------- */
    for (const t of this.tools) {
      t.stateTime[t.state] += dt;
      if (t.def.type === 'stocker') {
        // stocker releases new lots into the route at a steady rate
        if (t.def.id === 'STK-01' && this.lots.length < 36 && now - t.since > 6) {
          const lot = this.newLot(0);
          lot.at = { kind: 'port', tool: t.def.id, port: 0 };
          t.outbox.push(lot);
          this.requestTransport(lot, t, 0);
          t.since = now;
        }
        if (t.def.id === 'STK-02' && t.inbox.length) {
          const done = t.inbox.shift()!;
          this.lots = this.lots.filter((l) => l !== done);
          this.completedLots++;
          this.log('info', `${done.id} completed route (${ROUTE_LOOPS} layer loops)`);
          if (done.followed) {
            // the followed lot re-enters so it can always be observed
            const again = this.newLot(0, true);
            const stk = this.toolById['STK-01'];
            again.at = { kind: 'port', tool: 'STK-01', port: 0 };
            stk.outbox.push(again);
            this.requestTransport(again, stk, 0);
          }
        }
        continue;
      }
      if (t.forced) continue;
      switch (t.state) {
        case 'IDLE':
          if (now > t.nextFail && t.state === 'IDLE' && this.r() < 0.5) {
            this.setState(t, 'ALARM');
            t.procEnd = now + 6 + this.r() * 6;
            t.nextFail = now + 400 + this.r() * 1200;
            this.alarmsTotal++;
            this.log('alarm', `${t.def.id} ALARM (simulated random fault)`);
            break;
          }
          if (t.inbox.length) {
            t.lot = t.inbox.shift()!;
            t.lot.at = { kind: 'tool', tool: t.def.id };
            t.lot.waiting = 'none';
            this.setState(t, 'LOADING');
            t.procEnd = now + LOAD_T;
          }
          break;
        case 'LOADING':
          if (now >= t.procEnd) {
            this.setState(t, 'PROCESSING');
            t.procEnd = now + t.def.processTime * (0.85 + this.r() * 0.3);
          }
          break;
        case 'PROCESSING':
          if (now >= t.procEnd) {
            this.setState(t, 'UNLOADING');
            t.procEnd = now + UNLOAD_T;
          }
          break;
        case 'UNLOADING':
          if (now >= t.procEnd && t.lot) {
            const lot = t.lot;
            lot.history.push(t.def.id);
            if (lot.history.length > 40) lot.history.shift();
            lot.step++;
            t.processed++;
            this.moves++;
            this.moveStamps.push(now);
            if (t.def.type === 'metro') {
              this.inspected++;
              const pass = this.r() > 0.035;
              if (pass) this.inspectedPass++;
              else {
                lot.defects++;
                this.log('warn', `${lot.id} flagged at ${t.def.id} — sent to review`);
              }
            }
            const port = Math.floor(this.r() * t.def.ports.length);
            lot.at = { kind: 'port', tool: t.def.id, port };
            t.outbox.push(lot);
            t.lot = null;
            this.requestTransport(lot, t, port);
            this.setState(t, 'IDLE');
          }
          break;
        case 'ALARM':
          if (now >= t.procEnd) {
            this.setState(t, 'MAINTENANCE');
            t.procEnd = now + 10 + this.r() * 8;
            this.log('warn', `${t.def.id} under maintenance`);
          }
          break;
        case 'MAINTENANCE':
          if (now >= t.procEnd) {
            this.setState(t, t.lot ? 'PROCESSING' : 'IDLE');
            if (t.lot) t.procEnd = now + 4;
            this.log('info', `${t.def.id} back in production`);
          }
          break;
        default:
          break;
      }
    }

    /* ---------------- transport ---------------- */
    this.assignJobs();
    for (const v of this.vehicles) {
      switch (v.phase) {
        case 'idle':
          // drift slowly forward to stay distributed
          v.target = null;
          v.v = Math.max(0, v.v - A_MAX * dt);
          if (v.v > 0) v.s = (v.s + v.v * dt) % LOOP_LENGTH;
          break;
        case 'toPick':
        case 'toDrop':
          if (this.driveVehicle(v, dt)) {
            v.v = 0;
            v.phase = v.phase === 'toPick' ? 'hoistDown' : 'dropDown';
            v.timer = 0;
          }
          break;
        case 'hoistDown':
        case 'dropDown':
          v.timer += dt;
          v.hoist = Math.min(1, v.timer / HOIST_T);
          if (v.timer >= HOIST_T) {
            const job = v.job!;
            if (v.phase === 'hoistDown') {
              const src = this.toolById[job.from.tool];
              src.outbox = src.outbox.filter((l) => l !== job.lot);
              v.carrying = job.lot;
              job.lot.at = { kind: 'vehicle', vehicle: v.id };
              v.phase = 'hoistUp';
            } else {
              const dst = this.toolById[job.to.tool];
              job.lot.at = { kind: 'port', tool: dst.def.id, port: job.to.port };
              job.lot.waiting = 'process';
              dst.inbox.push(job.lot);
              v.carrying = null;
              v.phase = 'dropUp';
            }
            v.timer = 0;
          }
          break;
        case 'hoistUp':
        case 'dropUp':
          v.timer += dt;
          v.hoist = Math.max(0, 1 - v.timer / HOIST_T);
          if (v.timer >= HOIST_T) {
            if (v.phase === 'hoistUp') {
              v.phase = 'toDrop';
              v.target = v.job!.to.s;
            } else {
              v.phase = 'idle';
              v.job = null;
              v.target = null;
            }
          }
          break;
      }
    }

    /* ---------------- metrics ---------------- */
    this.sampleAcc += dt;
    if (this.sampleAcc >= 1) {
      this.sampleAcc = 0;
      const push = (k: keyof FabSim['series'], v: number) => {
        const arr = this.series[k];
        arr.push(v);
        if (arr.length > 180) arr.shift();
      };
      push('wip', this.lots.length);
      push('util', this.utilisation());
      push('moves', this.movesPerHour());
      push('queue', this.tools.reduce((a, t) => a + t.inbox.length, 0));
      push('yield', this.lineYield());
      this.version++;
    }
  }

  /** fraction of production tools currently processing (%) */
  utilisation(): number {
    const prod = this.tools.filter((t) => t.def.type !== 'stocker');
    const busy = prod.filter((t) => t.state === 'PROCESSING' || t.state === 'LOADING' || t.state === 'UNLOADING').length;
    return (100 * busy) / prod.length;
  }

  /** process moves per fab-hour (time-compressed) */
  movesPerHour(): number {
    const window = 60; // playback seconds
    const cutoff = this.time - window;
    while (this.moveStamps.length && this.moveStamps[0] < cutoff) this.moveStamps.shift();
    const span = Math.min(window, Math.max(1, this.time));
    return (this.moveStamps.length / (span * FAB_TIME_COMPRESSION)) * 3600;
  }

  lineYield(): number {
    return this.inspected ? (100 * this.inspectedPass) / this.inspected : 100;
  }

  activeAlarms(): number {
    return this.tools.filter((t) => t.state === 'ALARM').length;
  }

  stateCounts(): Record<MachineState, number> {
    const c = zeroStates();
    for (const t of this.tools) if (t.def.type !== 'stocker') c[t.state]++;
    return c;
  }

  followedLot(): SimLot | undefined {
    return this.lots.find((l) => l.followed);
  }

  /** world position of a lot's FOUP bottom-centre (for rendering & camera follow) */
  lotPosition(lot: SimLot): { x: number; y: number; z: number } {
    if (lot.at.kind === 'vehicle') {
      const v = this.vehicles[lot.at.vehicle];
      const p = loopPoint(v.s);
      const up = FAB.ohtY - 0.62;
      return { x: p.x, y: up - v.hoist * (up - PORT_HEIGHT), z: p.z };
    }
    const tool = this.toolById[lot.at.tool];
    if (lot.at.kind === 'port') {
      const p = tool.def.ports[lot.at.port] ?? tool.def.ports[0];
      return { x: p.x, y: PORT_HEIGHT, z: p.z };
    }
    // inside the tool
    const c = Math.cos(tool.def.rot);
    const s = Math.sin(tool.def.rot);
    const lx = -1.2;
    return { x: tool.def.x + c * lx, y: PORT_HEIGHT, z: tool.def.z - s * lx };
  }

  /** queue snapshot for the control room */
  queues(): { type: ToolType; waiting: number; tools: number }[] {
    const types: ToolType[] = ['litho', 'etch', 'dep', 'furnace', 'implant', 'rtp', 'cmp', 'metro', 'wet'];
    return types.map((type) => {
      const ts = this.tools.filter((t) => t.def.type === type);
      return { type, waiting: ts.reduce((a, t) => a + t.inbox.length, 0), tools: ts.length };
    });
  }

  routeLabel(lot: SimLot): string {
    const loop = Math.floor(lot.step / LAYER_ROUTE.length) + 1;
    const next = FULL_ROUTE[lot.step];
    return next ? `LOOP ${loop}/${ROUTE_LOOPS} · NEXT ${next.toUpperCase()}` : 'ROUTE COMPLETE';
  }
}
