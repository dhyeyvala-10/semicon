/**
 * Closed-loop control visualisations (§76, §87, §88).
 * Real PID / EWMA algorithms running on simple simulated plants — the dynamics are
 * educational, the algorithms are the standard ones used in industry.
 */
import { rng, gauss } from '@/lib/math';

export interface ControlLoopDef {
  id: string;
  title: string;
  sensor: string;
  controller: string;
  actuator: string;
  process: string;
  unit: string;
  outUnit: string;
  setpoint: number;
  spRange: [number, number];
  initial: number;
  kp: number;
  ki: number;
  kd: number;
  outMin: number;
  outMax: number;
  /** plant: dx/dt = (gain·u + bias − x)/tau  (first order) or mass-damper (second order) */
  plant: { order: 1 | 2; gain: number; tau: number; bias: number };
  disturbance: number;
  machine: string;
}

export const CONTROL_LOOPS: ControlLoopDef[] = [
  {
    id: 'furnace-temp',
    title: 'Furnace zone temperature',
    sensor: 'Thermocouple',
    controller: 'PID zone controller',
    actuator: 'Heater power (SCR)',
    process: 'Tube temperature',
    unit: '°C',
    outUnit: '%',
    setpoint: 1000,
    spRange: [800, 1100],
    initial: 700,
    kp: 1.2,
    ki: 0.18,
    kd: 0.6,
    outMin: 0,
    outMax: 100,
    plant: { order: 1, gain: 7, tau: 6, bias: 300 },
    disturbance: -40,
    machine: 'furnace',
  },
  {
    id: 'rtp-temp',
    title: 'RTP wafer temperature',
    sensor: 'Pyrometer',
    controller: 'Model-based PID',
    actuator: 'Lamp power',
    process: 'Wafer temperature',
    unit: '°C',
    outUnit: '%',
    setpoint: 1050,
    spRange: [600, 1100],
    initial: 450,
    kp: 0.9,
    ki: 0.6,
    kd: 0.05,
    outMin: 0,
    outMax: 100,
    plant: { order: 1, gain: 13, tau: 1.2, bias: 25 },
    disturbance: -60,
    machine: 'rtp',
  },
  {
    id: 'stage-position',
    title: 'Wafer stage position (one axis)',
    sensor: 'Interferometer / encoder',
    controller: 'Servo controller (PID + feed-forward)',
    actuator: 'Linear motor force',
    process: 'Stage position',
    unit: 'nm',
    outUnit: 'N',
    setpoint: 500,
    spRange: [-1000, 1000],
    initial: 0,
    kp: 0.9,
    ki: 0.25,
    kd: 0.35,
    outMin: -400,
    outMax: 400,
    plant: { order: 2, gain: 9, tau: 0.35, bias: 0 },
    disturbance: 120,
    machine: 'scanner',
  },
  {
    id: 'cz-diameter',
    title: 'Crystal diameter',
    sensor: 'Meniscus diameter camera',
    controller: 'Diameter controller',
    actuator: 'Pull-rate reduction',
    process: 'Crystal diameter',
    unit: 'mm',
    outUnit: 'mm/min',
    setpoint: 310,
    spRange: [300, 320],
    initial: 302,
    kp: 0.08,
    ki: 0.03,
    kd: 0.0,
    outMin: -1,
    outMax: 1,
    plant: { order: 1, gain: 14, tau: 3, bias: 302 },
    disturbance: 4,
    machine: 'cz-puller',
  },
];

export class ControlLoopSim {
  x: number;
  v = 0;
  u = 0;
  sp: number;
  integ = 0;
  prevErr = 0;
  dist = 0;
  t = 0;
  hist: { sp: number[]; pv: number[]; u: number[] } = { sp: [], pv: [], u: [] };
  private acc = 0;
  constructor(readonly def: ControlLoopDef) {
    this.x = def.initial;
    this.sp = def.setpoint;
  }

  get error() {
    return this.sp - this.x;
  }

  kick() {
    this.dist = this.def.disturbance;
  }

  tick(dt: number) {
    const d = this.def;
    const h = 1 / 120;
    let rem = Math.min(dt, 0.1);
    while (rem > 1e-9) {
      const step = Math.min(h, rem);
      rem -= step;
      this.t += step;
      const err = this.sp - this.x;
      const deriv = (err - this.prevErr) / step;
      this.prevErr = err;
      let u = d.kp * err + d.ki * this.integ + d.kd * deriv;
      const sat = Math.min(d.outMax, Math.max(d.outMin, u));
      // anti-windup: integrate only when not saturated in the same direction
      if (u === sat || Math.sign(err) !== Math.sign(u)) this.integ += err * step;
      u = sat;
      this.u = u;
      if (d.plant.order === 1) {
        const target = d.plant.bias + d.plant.gain * u + this.dist;
        this.x += ((target - this.x) / d.plant.tau) * step;
      } else {
        const acc = d.plant.gain * u - this.v / d.plant.tau + this.dist * 4;
        this.v += acc * step;
        this.x += this.v * step;
      }
      this.dist *= Math.exp(-step / 1.5);
    }
    this.acc += dt;
    if (this.acc >= 0.05) {
      this.acc = 0;
      const push = (a: number[], v: number) => {
        a.push(v);
        if (a.length > 240) a.shift();
      };
      push(this.hist.sp, this.sp);
      push(this.hist.pv, this.x);
      push(this.hist.u, this.u);
    }
  }
}

/* ------------------------- run-to-run (EWMA) ------------------------- */

export interface R2RResult {
  target: number;
  uncontrolled: number[];
  controlled: number[];
  polishTime: number[];
}

/**
 * CMP run-to-run control: removal rate drifts down as the pad wears; the pad is
 * replaced at wafer 40. Metrology after each wafer updates an EWMA estimate of the
 * removal rate, and the next wafer's polish time is target / estimate.
 */
export function simulateR2R(n = 60, lambda = 0.35, seed = 7): R2RResult {
  const r = rng(seed);
  const target = 400; // nm removal
  const nominalTime = 100; // s
  let est = 4.0; // nm/s
  const uncontrolled: number[] = [];
  const controlled: number[] = [];
  const polishTime: number[] = [];
  for (let k = 0; k < n; k++) {
    const wear = k < 40 ? k : k - 40;
    const rate = 4.0 * (1 - 0.0065 * wear) + gauss(r) * 0.05;
    uncontrolled.push(rate * nominalTime);
    const time = target / est;
    const removal = rate * time + gauss(r) * 2;
    controlled.push(removal);
    polishTime.push(time);
    est = lambda * (removal / time) + (1 - lambda) * est;
  }
  return { target, uncontrolled, controlled, polishTime };
}
