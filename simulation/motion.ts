/**
 * Synchronised trapezoidal motion profiles (accelerate → cruise → decelerate).
 * No teleportation: every axis respects velocity and acceleration limits.
 */

export interface AxisLimit {
  vmax: number;
  amax: number;
}

/** accel fraction of the normalised trapezoid */
const F = 0.28;
const K = 1 / (F * (1 - F));

/** normalised position 0..1 at normalised time τ */
export function trapS(tau: number): number {
  const t = Math.min(1, Math.max(0, tau));
  if (t < F) return 0.5 * K * t * t;
  if (t <= 1 - F) return (t - F / 2) / (1 - F);
  const u = 1 - t;
  return 1 - 0.5 * K * u * u;
}
/** normalised velocity ds/dτ */
export function trapV(tau: number): number {
  const t = Math.min(1, Math.max(0, tau));
  if (t < F) return K * t;
  if (t <= 1 - F) return 1 / (1 - F);
  return K * (1 - t);
}
/** normalised acceleration d²s/dτ² */
export function trapA(tau: number): number {
  if (tau <= 0 || tau >= 1) return 0;
  if (tau < F) return K;
  if (tau <= 1 - F) return 0;
  return -K;
}

/** Minimum duration for a distance d under the normalised trapezoid shape. */
export function minDuration(d: number, lim: AxisLimit): number {
  const a = Math.abs(d);
  if (a < 1e-9) return 0;
  return Math.max(a / (lim.vmax * (1 - F)), Math.sqrt(a * K / lim.amax));
}

export class MultiAxisMove {
  readonly duration: number;
  t = 0;
  constructor(readonly from: number[], readonly to: number[], limits: AxisLimit[], minT = 0.05) {
    let T = minT;
    for (let i = 0; i < from.length; i++) T = Math.max(T, minDuration(to[i] - from[i], limits[i]));
    this.duration = T;
  }
  get done() {
    return this.t >= this.duration;
  }
  advance(dt: number) {
    this.t = Math.min(this.duration, this.t + dt);
  }
  pos(i: number) {
    return this.from[i] + (this.to[i] - this.from[i]) * trapS(this.t / this.duration);
  }
  vel(i: number) {
    return ((this.to[i] - this.from[i]) * trapV(this.t / this.duration)) / this.duration;
  }
  acc(i: number) {
    return ((this.to[i] - this.from[i]) * trapA(this.t / this.duration)) / (this.duration * this.duration);
  }
}
