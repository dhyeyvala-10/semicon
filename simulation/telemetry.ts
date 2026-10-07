/**
 * Telemetry hub: evaluates the current stage's telemetry samplers every frame and
 * records them into ring buffers at a fixed sample interval. Charts draw from these
 * buffers, so every chart corresponds to something that happened in the simulation.
 */
import type { Status, TelemetryCtx, TelemetryDef } from '@/types';

export const SAMPLE_DT = 0.1; // s (playback time)
export const BUF_LEN = 300; // 30 s of history

export class Channel {
  readonly buf = new Float32Array(BUF_LEN);
  head = 0;
  count = 0;
  value = NaN;
  status: Status = 'NORMAL';
  constructor(readonly def: TelemetryDef) {}

  push(v: number) {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % BUF_LEN;
    if (this.count < BUF_LEN) this.count++;
  }

  /** chronological copy (oldest first) */
  series(): number[] {
    const out: number[] = new Array(this.count);
    const start = (this.head - this.count + BUF_LEN) % BUF_LEN;
    for (let i = 0; i < this.count; i++) out[i] = this.buf[(start + i) % BUF_LEN];
    return out;
  }

  clear() {
    this.head = 0;
    this.count = 0;
    this.value = NaN;
    this.status = 'NORMAL';
  }
}

export function classify(def: TelemetryDef, v: number, phaseId?: string): Status {
  if (!isFinite(v)) return 'NORMAL';
  if (def.bandPhases && phaseId !== undefined && !def.bandPhases.includes(phaseId)) return 'NORMAL';
  if (def.fault && (v < def.fault[0] || v > def.fault[1])) return 'FAULT';
  if (def.warn && (v < def.warn[0] || v > def.warn[1])) return 'WARNING';
  return 'NORMAL';
}

export class TelemetryHub {
  channels: Channel[] = [];
  private acc = 0;
  status: Status = 'NORMAL';
  /** the channel that is worst right now, if any */
  worst: Channel | null = null;
  version = 0;

  setDefs(defs: TelemetryDef[] | undefined) {
    this.channels = (defs ?? []).map((d) => new Channel(d));
    this.acc = 0;
    this.status = 'NORMAL';
    this.worst = null;
    this.version++;
  }

  clear() {
    for (const c of this.channels) c.clear();
    this.acc = 0;
    this.version++;
  }

  get(id: string): Channel | undefined {
    return this.channels.find((c) => c.def.id === id);
  }

  value(id: string, fallback = 0): number {
    const v = this.get(id)?.value;
    return v === undefined || !isFinite(v) ? fallback : v;
  }

  /** dt = playback seconds advanced (0 when paused → values still refresh, no new samples) */
  tick(dt: number, ctx: TelemetryCtx) {
    let worst: Channel | null = null;
    let rank = 0;
    for (const c of this.channels) {
      let v: number;
      try {
        v = c.def.sample(ctx);
      } catch {
        v = NaN;
      }
      c.value = v;
      c.status = classify(c.def, v, ctx.phaseId);
      const r = c.status === 'FAULT' ? 2 : c.status === 'WARNING' ? 1 : 0;
      if (r > rank) {
        rank = r;
        worst = c;
      }
    }
    this.worst = worst;
    this.status = rank === 2 ? 'FAULT' : rank === 1 ? 'WARNING' : 'NORMAL';
    if (dt > 0) {
      this.acc += dt;
      let n = 0;
      while (this.acc >= SAMPLE_DT && n < 20) {
        this.acc -= SAMPLE_DT;
        for (const c of this.channels) c.push(c.value);
        n++;
      }
      if (n) this.version++;
    }
  }
}
