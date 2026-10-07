/**
 * Simulation engine singleton. Owns the stage player, the followed object's digital
 * twin, telemetry, robot controller, fab simulation, failures and control loops.
 * It runs on its own requestAnimationFrame loop so it works with or without WebGL.
 * React reads it through throttled tickers; 3D components read it inside useFrame.
 */
import type { MachineState, Stage, Status, TelemetryCtx, WaferState } from '@/types';
import { StagePlayer, type PlayerEvent } from './player';
import { WaferTwin } from './twin';
import { TelemetryHub } from './telemetry';
import { RobotController, STATIONS } from './robot';
import { FabSim } from './fab';
import { ControlLoopSim, CONTROL_LOOPS } from './control';
import { simulateWaferMap, type DieStatus, DIE_W, DIE_H } from './models';
import { JOURNEY, STAGE_BY_ID } from '@/data/process';
import { FAILURE_BY_ID } from '@/data/failures';
import { vnoise, smooth, hash1, deg } from '@/lib/math';

export interface EngineEvent {
  t: number;
  level: 'info' | 'warn' | 'alarm' | 'ok';
  source: string;
  msg: string;
}

export type FailurePhase = 'INJECTED' | 'DEVIATING' | 'DETECTED' | 'DISPOSITION' | 'RESOLVED';

export interface ActiveFailure {
  id: string;
  start: number;
  phase: FailurePhase;
  detectedAt?: number;
}

const BINS = { A: 4.25, B: 3.9, C: 3.55 };

class Engine {
  readonly player = new StagePlayer();
  readonly twin = new WaferTwin();
  readonly tele = new TelemetryHub();
  readonly robot = new RobotController();
  readonly fab = new FabSim();

  stage: Stage = JOURNEY[0];
  /** simulation wall time (s) */
  time = 0;
  frame = 0;
  fps = 60;
  running = false;
  ext = new Map<string, number>();
  params: Record<string, number> = { depMode: 0, etchMode: 0, bondMode: 0, apMode: 0, journey: 0, alignError: 0 };
  paramsVersion = 0;
  events: EngineEvent[] = [];
  failure: ActiveFailure | null = null;
  machineOverride: MachineState | null = null;
  loop: ControlLoopSim | null = null;
  fabRunning = true;
  /** process-state machine of the current stage's main equipment */
  machineStateFromPhase: MachineState = 'IDLE';
  waferMap: DieStatus[] = simulateWaferMap(184);
  /** die we follow after dicing */
  followedDie: DieStatus;
  bins = { A: 0, B: 0, C: 0, R: 0 };
  onAdvance: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private raf = 0;
  private last = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  version = 0;

  constructor() {
    this.followedDie = this.pickFollowedDie();
    this.player.load(this.stage);
    this.tele.setDefs(this.stage.telemetry);
  }

  private pickFollowedDie(): DieStatus {
    const pass = this.waferMap.filter((d) => d.result === 'PASS');
    pass.sort((a, b) => Math.hypot(a.die.cx + 40, a.die.cy - 20) - Math.hypot(b.die.cx + 40, b.die.cy - 20));
    return pass[0] ?? this.waferMap[0];
  }

  /* ------------------------------ lifecycle ------------------------------ */

  start() {
    if (this.running || typeof window === 'undefined') return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      this.tick(dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  log(level: EngineEvent['level'], source: string, msg: string) {
    this.events.push({ t: this.time, level, source, msg });
    if (this.events.length > 150) this.events.shift();
    this.version++;
  }

  /* ------------------------------ stage control ------------------------------ */

  setStage(stage: Stage, opts: { rebuild?: boolean; autoplay?: boolean } = {}) {
    const prev = this.stage;
    this.stage = stage;
    this.player.load(stage);
    this.player.playing = opts.autoplay ?? true;
    this.tele.setDefs(stage.telemetry);
    this.machineOverride = null;
    if (this.failure && FAILURE_BY_ID[this.failure.id]?.stage !== stage.id && !(stage.failures ?? []).includes(this.failure.id)) this.failure = null;
    const ji = JOURNEY.findIndex((s) => s.id === stage.id);
    if (ji >= 0) {
      const prevIdx = JOURNEY.findIndex((s) => s.id === prev.id);
      if (opts.rebuild || prevIdx !== ji - 1) this.twin.rebuild(JOURNEY, ji);
      this.twin.enterStage(stage, this.time);
    }
    this.robot.loop = false;
    this.robot.clear();
    this.robot.mode = 'auto';
    if (stage.id === 'robot-lab') {
      this.robot.setState(STATIONS.home.th, STATIONS.home.r, STATIONS.home.z, 'foup', false);
      this.robot.loop = true;
    }
    this.log('info', 'STAGE', `${stage.num ? String(stage.num).padStart(2, '0') + ' · ' : ''}${stage.title}`);
    this.version++;
    this.emit();
  }

  setParam(key: string, v: number) {
    this.params[key] = v;
    this.paramsVersion++;
    this.version++;
    this.emit();
  }

  /* ------------------------------ failures ------------------------------ */

  injectFailure(id: string) {
    const f = FAILURE_BY_ID[id];
    if (!f) return;
    if (id === 'machine-downtime') {
      this.fab.triggerDowntime();
      this.log('alarm', 'FAB', f.cause);
      this.failure = { id, start: this.time, phase: 'INJECTED' };
      return;
    }
    this.failure = { id, start: this.time, phase: 'INJECTED' };
    if (id === 'robot-transfer') this.robot.vacuumLeak = 0;
    this.log('warn', 'FAILURE', `${f.title}: ${f.cause}`);
    this.version++;
  }

  resetFailure() {
    if (!this.failure) return;
    const f = FAILURE_BY_ID[this.failure.id];
    this.failure = null;
    this.machineOverride = null;
    this.robot.vacuumLeak = 0;
    this.robot.error = null;
    this.robot.slip = 0;
    this.waferMap = simulateWaferMap(184);
    this.log('ok', 'RESET', `${f?.title ?? 'Scenario'} cleared — process restored to normal`);
    if (this.twin.state === 'SCRAP' || this.twin.state === 'REWORK' || this.twin.state === 'REVIEW' || this.twin.state === 'DEFECT_DETECTED') {
      this.twin.transition('PROCESSING', this.time, 'process reset');
    }
    this.player.restart();
    this.version++;
  }

  /** severity 0..1 of a failure id (ramps in over a few seconds) */
  failSeverity(id: string): number {
    if (!this.failure || this.failure.id !== id) return 0;
    if (id === 'misalignment' || id === 'robot-transfer') return smooth((this.time - this.failure.start) / 2.5);
    return smooth((this.time - this.failure.start) / 3.5);
  }

  /* ------------------------------ machine state ------------------------------ */

  get machineState(): MachineState {
    if (this.machineOverride) return this.machineOverride;
    if (this.failure && (this.failure.phase === 'DETECTED' || this.failure.phase === 'DISPOSITION')) return 'ALARM';
    if (this.robot.error && (this.stage.id === 'cleanroom-entry' || this.stage.id === 'robot-lab')) return 'ALARM';
    return this.machineStateFromPhase;
  }

  setMaintenance(on: boolean) {
    this.machineOverride = on ? 'MAINTENANCE' : null;
    if (on) {
      this.player.playing = false;
      this.log('warn', 'MAINT', `${this.stage.machine ?? 'Equipment'} → MAINTENANCE — process paused, robotics parked`);
      if (this.stage.robot === 'wafer-robot') {
        this.robot.clear();
        this.robot.enqueue([{ kind: 'move', label: 'PARK', th: Math.PI / 2, r: STATIONS.home.r, z: 0.08 }], 'PARK');
      }
    } else {
      this.log('info', 'MAINT', `${this.stage.machine ?? 'Equipment'} returned to production`);
    }
    this.version++;
  }

  /* ------------------------------ control loops ------------------------------ */

  openLoop(id: string | null) {
    const def = CONTROL_LOOPS.find((l) => l.id === id);
    this.loop = def ? new ControlLoopSim(def) : null;
    this.version++;
  }

  /* ------------------------------ telemetry ctx ------------------------------ */

  private ctx: TelemetryCtx = {
    t: 0,
    stageT: 0,
    phaseId: '',
    phaseIndex: 0,
    phaseT: 0,
    noise: (ch) => vnoise(this.player.view.t * 2.3 + ch * 17.1, ch),
    fail: (id) => this.failSeverity(id),
    param: (k, f) => this.params[k] ?? f,
    ext: (k, f) => this.ext.get(k) ?? f,
  };

  /* ------------------------------ phase handling ------------------------------ */

  private handle(ev: PlayerEvent) {
    if (ev.type === 'phase') {
      const p = ev.phase;
      if (p.machineState) this.machineStateFromPhase = p.machineState;
      if (p.waferState && JOURNEY.some((s) => s.id === this.stage.id)) {
        const blocked = this.twin.state === 'SCRAP' || this.twin.state === 'REVIEW';
        if (!blocked) this.twin.transition(p.waferState as WaferState, this.time, `${this.stage.short}: ${p.label}`);
      }
      if (!ev.resync) this.log('info', this.stage.short.toUpperCase(), p.label);
      this.robotPhase(p.id, ev.resync);
    } else if (ev.type === 'complete') {
      if (this.stage.journey === false) {
        this.player.restart();
        return;
      }
      const f = this.failure;
      const relevant = !!f && (FAILURE_BY_ID[f.id]?.stage === this.stage.id || (this.stage.failures ?? []).includes(f.id));
      if (relevant && f!.phase !== 'DISPOSITION') {
        this.dispose();
      } else if (relevant) {
        // already dispositioned — the twin keeps its REWORK / SCRAP / REVIEW state
        this.twin.completeStage(this.stage, this.time, this.twin.state === 'SCRAP' ? 'SCRAP' : 'REWORK');
      } else {
        this.twin.transition('ACCEPTED', this.time, `${this.stage.short} complete`);
        this.twin.completeStage(this.stage, this.time, 'OK');
        this.twin.transition('NEXT_PROCESS', this.time, 'released');
        this.log('ok', this.stage.short.toUpperCase(), 'Stage complete → next process');
      }
      this.version++;
    } else if (ev.type === 'advance') {
      this.onAdvance?.();
    }
  }

  private dispose() {
    const f = FAILURE_BY_ID[this.failure!.id];
    this.failure!.phase = 'DISPOSITION';
    this.twin.transition('DEFECT_DETECTED', this.time, f.detection);
    this.twin.transition('REVIEW', this.time, 'engineering review');
    if (f.disposition === 'SCRAP') {
      this.twin.transition('SCRAP', this.time, f.dispositionText);
      this.twin.completeStage(this.stage, this.time, 'SCRAP');
      this.log('alarm', 'DISPOSITION', `SCRAP — ${f.dispositionText}`);
    } else if (f.disposition === 'REWORK') {
      this.twin.transition('REWORK', this.time, f.dispositionText);
      const h = this.twin.history[this.twin.history.length - 1];
      if (h) h.result = 'REWORK';
      this.log('warn', 'DISPOSITION', `REWORK — ${f.dispositionText}`);
    } else {
      const h = this.twin.history[this.twin.history.length - 1];
      if (h) h.result = 'REVIEW';
      this.log('warn', 'DISPOSITION', `INTERVENTION — ${f.dispositionText}`);
    }
    this.player.playing = false;
  }

  /* ------------------------------ robot choreography ------------------------------ */

  private robotPhase(phaseId: string, resync: boolean) {
    if (this.stage.id !== 'cleanroom-entry') return;
    const r = this.robot;
    const H = STATIONS.home;
    const A = STATIONS.aligner;
    const C = STATIONS.chamber;
    const F = STATIONS.foup;
    r.mode = 'auto';
    r.loop = false;
    switch (phaseId) {
      case 'arrive':
      case 'dock':
        r.setState(H.th, H.r, H.z, 'foup', false);
        r.notchFound = false;
        break;
      case 'map':
        if (resync) r.setState(H.th, H.r, H.z, 'foup', false);
        r.clear();
        r.enqueue(RobotController.seqMap(), 'MAP');
        break;
      case 'pick':
        if (resync) r.setState(H.th, H.r, H.z, 'foup', false);
        r.clear();
        r.cycleTime = 0;
        r.enqueue(RobotController.seqPickFoup(), 'PICK FROM FOUP');
        break;
      case 'align':
        if (resync) r.setState(F.th, H.r, F.z + 0.006, 'effector', true);
        r.clear();
        r.notchFound = false;
        r.enqueue(RobotController.seqAlign(), 'PRE-ALIGN');
        break;
      case 'transfer':
        if (resync) r.setState(A.th, H.r, A.z + 0.006, 'effector', true);
        r.clear();
        r.notchFound = true;
        r.enqueue(RobotController.seqTransfer(), 'TRANSFER');
        break;
      case 'place':
        if (resync) r.setState(C.th, C.r, C.z + 0.008, 'effector', true);
        r.clear();
        r.enqueue(RobotController.seqPlaceChamber(), 'PLACE');
        break;
      case 'return':
        if (resync) r.setState(C.th, H.r, C.z - 0.006, 'chamber', false);
        r.clear();
        r.enqueue([...RobotController.seqReturnHome(), { kind: 'cycle', label: 'HOME' }], 'RETURN');
        break;
    }
  }

  /* ------------------------------ main tick ------------------------------ */

  tick(dt: number) {
    this.time += dt;
    this.frame++;
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }

    const events = this.player.tick(dt);
    for (const e of events) this.handle(e);
    const pdt = this.player.playing && !this.player.completed ? dt * this.player.speed : 0;
    const v = this.player.view;

    // accumulate processing time on the twin
    if (pdt > 0 && v.phase.waferState === 'PROCESSING') this.twin.processTime += pdt;

    // robot
    const robotStage = this.stage.id === 'cleanroom-entry' || this.stage.id === 'robot-lab';
    if (robotStage) {
      if (this.failure?.id === 'robot-transfer') this.robot.vacuumLeak = this.failSeverity('robot-transfer');
      const rdt = this.robot.mode === 'manual' || this.machineOverride === 'MAINTENANCE' ? dt : pdt;
      this.robot.tick(rdt);
      const j = this.robot.joints();
      this.ext.set('robot.j1', ((deg(j.j1) + 540) % 360) - 180);
      this.ext.set('robot.j2', deg(j.j2));
      this.ext.set('robot.j3', deg(j.j3));
      this.ext.set('robot.z', this.robot.q[2] * 1000);
      this.ext.set('robot.v', this.robot.speed() * 1000);
      this.ext.set('robot.vac', this.robot.vacuumKPa);
    }

    // fab simulation always runs (control room history), unless paused by visitor
    if (this.fabRunning) this.fab.tick(dt);
    this.ext.set('fab.wip', this.fab.lots.length);
    this.ext.set('fab.util', this.fab.utilisation());
    this.ext.set('fab.moves', this.fab.movesPerHour());
    this.ext.set('fab.yield', this.fab.lineYield());
    this.ext.set('fab.alarms', this.fab.activeAlarms());
    this.ext.set('fab.particles', 6 + 3 * (1 + vnoise(this.time * 0.5, 3)));

    // stage-specific derived values (all from simulated models)
    this.stageExt(v.phaseId, v.phaseT);

    // telemetry
    const c = this.ctx;
    c.t = v.t;
    c.stageT = v.stageT;
    c.phaseId = v.phaseId;
    c.phaseIndex = v.phaseIndex;
    c.phaseT = v.phaseT;
    this.tele.tick(pdt, c);

    // failure progression
    this.failureTick();

    // control loop panel
    this.loop?.tick(dt);

    this.version++;
    this.emit();
  }

  private stageExt(phaseId: string, phaseT: number) {
    const id = this.stage.id;
    const map = this.waferMap;
    if (id === 'inspection' || id === 'wafer-inspection') {
      this.ext.set('inspect.defects', map.filter((d) => d.result !== 'PASS').length);
    }
    if (id === 'e-test') {
      const n = phaseId === 'test' ? Math.floor(map.length * phaseT) : phaseId === 'report' ? map.length : 0;
      this.ext.set('probe.tested', n);
      const d = map[Math.min(map.length - 1, n)];
      this.ext.set('probe.idd', phaseId === 'test' ? (d.result === 'FAIL' ? 260 : 85 + 20 * hash1(d.die.id)) : 0);
    }
    if (id === 'wafer-sort') {
      const pass = map.filter((d) => d.result === 'PASS').length;
      const fail = map.filter((d) => d.result === 'FAIL').length;
      this.ext.set('sort.pass', pass);
      this.ext.set('sort.fail', fail);
      this.ext.set('sort.yield', (100 * pass) / map.length);
    }
    if (id === 'dicing') {
      const nx = Math.round(300 / DIE_W) + 1;
      const ny = Math.round(300 / DIE_H) + 1;
      const n = phaseId === 'cut-x' ? Math.floor(ny * phaseT) : phaseId === 'cut-y' ? ny + Math.floor(nx * phaseT) : ['rotate'].includes(phaseId) ? ny : phaseId === 'clean' ? nx + ny : 0;
      this.ext.set('dice.cuts', n);
    }
    if (id === 'final-test') this.ext.set('ft.fmax', this.followedDie.fmax);
    if (id === 'binning') {
      const pass = map.filter((d) => d.result === 'PASS');
      const k = phaseId === 'sort' ? Math.floor(pass.length * phaseT) : pass.length;
      const b = { A: 0, B: 0, C: 0, R: 0 };
      for (let i = 0; i < k; i++) {
        const f = pass[i].fmax;
        if (hash1(pass[i].die.id * 3 + 1) < 0.02) b.R++;
        else if (f >= BINS.A) b.A++;
        else if (f >= BINS.B) b.B++;
        else if (f >= BINS.C) b.C++;
        else b.R++;
      }
      this.bins = b;
      this.ext.set('bin.A', b.A);
      this.ext.set('bin.B', b.B);
      this.ext.set('bin.C', b.C);
      this.ext.set('bin.R', b.R);
    }
  }

  binOf(fmax: number, id: number): 'A' | 'B' | 'C' | 'REJECT' {
    if (hash1(id * 3 + 1) < 0.02) return 'REJECT';
    return fmax >= BINS.A ? 'A' : fmax >= BINS.B ? 'B' : fmax >= BINS.C ? 'C' : 'REJECT';
  }

  private failureTick() {
    const f = this.failure;
    if (!f || f.id === 'machine-downtime') return;
    const def = FAILURE_BY_ID[f.id];
    const status: Status = this.tele.status;
    if (f.phase === 'INJECTED' && (status !== 'NORMAL' || this.failSeverity(f.id) > 0.3)) {
      f.phase = 'DEVIATING';
      this.log('warn', 'DEVIATION', def.effect);
    }
    if (f.phase === 'DEVIATING') {
      const robotFault = f.id === 'robot-transfer' && !!this.robot.error;
      if (status === 'FAULT' || robotFault || (f.id === 'defect-detection' && this.time - f.start > 2)) {
        f.phase = 'DETECTED';
        f.detectedAt = this.time;
        this.log('alarm', 'DETECTED', def.detection);
        if (f.id === 'defect-detection' || f.id === 'contamination') this.waferMap = simulateWaferMap(184, 1);
      }
    }
    if (f.phase === 'DETECTED' && f.detectedAt !== undefined && this.time - f.detectedAt > 2.5) {
      this.dispose();
    }
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  /** stage lookups for UI */
  get nextStage(): Stage | undefined {
    const i = JOURNEY.findIndex((s) => s.id === this.stage.id);
    return i >= 0 ? JOURNEY[i + 1] : undefined;
  }
  get prevStage(): Stage | undefined {
    const i = JOURNEY.findIndex((s) => s.id === this.stage.id);
    return i > 0 ? JOURNEY[i - 1] : undefined;
  }
}

export const engine = new Engine();
export type { Engine };
export { STAGE_BY_ID };
