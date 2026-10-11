/**
 * Stage player — PLAY / PAUSE / STEP / RESTART / SPEED for the current process stage.
 * Scenes read `view` (which honours the before/after scrub override) inside useFrame,
 * so animations are pure functions of playback time.
 */
import type { Phase, Stage } from '@/types';

export interface PlayerView {
  t: number;
  stageT: number;
  phaseIndex: number;
  phaseId: string;
  phaseT: number;
  phase: Phase;
}

export type PlayerEvent =
  | { type: 'phase'; index: number; phase: Phase; resync: boolean }
  | { type: 'complete' }
  | { type: 'advance' };

export class StagePlayer {
  stage!: Stage;
  t = 0;
  duration = 1;
  playing = true;
  speed = 1;
  autoAdvance = false;
  /** stop at the end of this phase index (STEP mode) */
  stepTarget: number | null = null;
  /** normalised 0..1 scrub override for “what changes?” */
  override: number | null = null;
  completed = false;
  /** timeline position is set from outside (scroll story); time does not advance on its own */
  driven = false;
  private hold = 0;
  private lastPhase = -1;
  private resync = false;
  private starts: number[] = [];
  view: PlayerView = { t: 0, stageT: 0, phaseIndex: 0, phaseId: '', phaseT: 0, phase: { id: '', label: '', duration: 1 } };

  load(stage: Stage) {
    this.stage = stage;
    this.starts = [];
    let acc = 0;
    for (const p of stage.phases) {
      this.starts.push(acc);
      acc += p.duration;
    }
    this.duration = Math.max(acc, 0.001);
    this.t = 0;
    this.completed = false;
    this.hold = 0;
    this.lastPhase = -1;
    this.stepTarget = null;
    this.override = null;
    this.view = this.computeView(0);
  }

  phaseStart(i: number) {
    return this.starts[i] ?? 0;
  }

  private indexAt(t: number): number {
    let i = 0;
    for (let k = 0; k < this.starts.length; k++) if (t >= this.starts[k]) i = k;
    return i;
  }

  computeView(t: number): PlayerView {
    const tt = Math.min(Math.max(t, 0), this.duration);
    const i = this.indexAt(tt >= this.duration ? this.duration - 1e-6 : tt);
    const p = this.stage.phases[i];
    const phaseT = Math.min(1, Math.max(0, (tt - this.starts[i]) / p.duration));
    return { t: tt, stageT: tt / this.duration, phaseIndex: i, phaseId: p.id, phaseT, phase: p };
  }

  /** Advance by dt seconds of wall time. Returns events to be handled by the engine. */
  tick(dt: number): PlayerEvent[] {
    const ev: PlayerEvent[] = [];
    if (this.playing && !this.completed && !this.driven) {
      const prev = this.t;
      this.t = Math.min(this.duration, this.t + dt * this.speed);
      if (this.stepTarget !== null) {
        const end = this.starts[this.stepTarget] + this.stage.phases[this.stepTarget].duration;
        if (prev < end && this.t >= end - 1e-9) {
          this.t = Math.min(end, this.duration);
          this.playing = false;
          this.stepTarget = null;
        }
      }
    }
    const idx = this.indexAt(this.t >= this.duration ? this.duration - 1e-6 : this.t);
    if (this.lastPhase > idx) this.lastPhase = idx - 1;
    if (this.resync && this.lastPhase >= idx) this.lastPhase = idx - 1;
    if (this.resync) {
      // jump straight to the current phase, no intermediate events
      this.lastPhase = idx;
      ev.push({ type: 'phase', index: idx, phase: this.stage.phases[idx], resync: true });
      this.resync = false;
    }
    while (this.lastPhase < idx) {
      this.lastPhase++;
      ev.push({ type: 'phase', index: this.lastPhase, phase: this.stage.phases[this.lastPhase], resync: false });
    }
    if (this.playing && !this.completed && !this.driven && this.t >= this.duration) {
      this.completed = true;
      this.hold = 0;
      ev.push({ type: 'complete' });
    } else if (this.completed && this.autoAdvance && this.playing) {
      this.hold += dt;
      if (this.hold > 1.2) {
        this.hold = -1e9;
        ev.push({ type: 'advance' });
      }
    }
    this.view = this.computeView(this.override !== null ? this.override * this.duration : this.t);
    return ev;
  }

  seek(t: number) {
    this.t = Math.min(Math.max(0, t), this.duration);
    this.completed = this.t >= this.duration;
    this.stepTarget = null;
    this.resync = true;
    this.view = this.computeView(this.t);
  }

  /** Externally driven position (0..1 of the stage). Phase events follow on the next tick, in order. */
  scrub(u: number) {
    this.t = Math.min(Math.max(0, u), 1) * this.duration;
    this.completed = false;
    this.stepTarget = null;
    this.view = this.computeView(this.override !== null ? this.override * this.duration : this.t);
  }

  restart() {
    this.t = 0;
    this.completed = false;
    this.stepTarget = null;
    this.lastPhase = -1;
    this.resync = false;
    this.playing = true;
    this.view = this.computeView(0);
  }

  /** Execute exactly one operation (phase), then pause. */
  step() {
    if (this.completed) return false;
    const idx = this.indexAt(this.t);
    // if paused exactly at the end of a phase, step through the next one
    const end = this.starts[idx] + this.stage.phases[idx].duration;
    this.stepTarget = this.t >= end - 1e-6 && idx + 1 < this.stage.phases.length ? idx + 1 : idx;
    this.playing = true;
    return true;
  }

  stepBack() {
    const idx = this.indexAt(this.t);
    const atStart = this.t - this.starts[idx] < 0.25;
    const target = atStart ? Math.max(0, idx - 1) : idx;
    this.seek(this.starts[target]);
    this.playing = false;
  }

  seekPhase(i: number) {
    const k = Math.max(0, Math.min(this.stage.phases.length - 1, i));
    this.seek(this.starts[k]);
  }
}
