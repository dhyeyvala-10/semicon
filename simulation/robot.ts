/**
 * Atmospheric wafer-handling robot (θ–R–Z SCARA with radial wrist), simulated.
 * Task axes are driven by synchronised trapezoidal profiles; joint angles follow
 * from the kinematics. The 3D model renders exactly this state; telemetry reads it.
 */
import { MultiAxisMove, type AxisLimit } from './motion';

export const ROBOT_GEOM = {
  L: 0.32, // link length (m), both links
  Le: 0.2, // wrist → wafer centre (m)
  zMin: 0.05,
  zMax: 0.42,
  rMin: 0.22,
  rMax: 0.82,
};

export type WaferLoc = 'foup' | 'effector' | 'aligner' | 'chamber';

export interface Station {
  id: 'home' | 'foup' | 'aligner' | 'chamber';
  label: string;
  th: number; // rad
  r: number; // m (wafer-centre radius when placed)
  z: number; // m (height of wafer support)
}

const SLOT_PITCH = 0.01;
export const FOUP_SLOT = 7;
export const FOUP_SLOT_Z = (slot: number) => 0.1 + (slot - 1) * SLOT_PITCH;

export const STATIONS: Record<Station['id'], Station> = {
  home: { id: 'home', label: 'HOME', th: 0, r: 0.24, z: 0.15 },
  foup: { id: 'foup', label: 'FOUP · SLOT 7', th: 0, r: 0.62, z: FOUP_SLOT_Z(FOUP_SLOT) },
  aligner: { id: 'aligner', label: 'PRE-ALIGNER', th: Math.PI / 2, r: 0.45, z: 0.22 },
  chamber: { id: 'chamber', label: 'PROCESS CHAMBER', th: Math.PI, r: 0.72, z: 0.26 },
};

type Step =
  | { kind: 'move'; label: string; th?: number; r?: number; z?: number }
  | { kind: 'vac'; label: string; on: boolean }
  | { kind: 'grip'; label: string; from: WaferLoc }
  | { kind: 'release'; label: string; to: WaferLoc }
  | { kind: 'wait'; label: string; dur: number }
  | { kind: 'spin'; label: string; dur: number }
  | { kind: 'cycle'; label: string };

const LIMITS_EMPTY: AxisLimit[] = [
  { vmax: 2.2, amax: 5 }, // θ rad/s
  { vmax: 0.7, amax: 2.2 }, // r m/s
  { vmax: 0.18, amax: 0.8 }, // z m/s
];
const LIMITS_LOADED: AxisLimit[] = [
  { vmax: 1.6, amax: 2.6 },
  { vmax: 0.5, amax: 1.2 },
  { vmax: 0.12, amax: 0.5 },
];

export class RobotController {
  /** task-space state [θ, r, z] */
  q = [STATIONS.home.th, STATIONS.home.r, STATIONS.home.z];
  qd = [0, 0, 0];
  qdd = [0, 0, 0];
  vacuumOn = false;
  vacuumKPa = 0;
  waferLoc: WaferLoc = 'foup';
  /** wafer rotation about its own axis on the aligner (rad) */
  waferSpin = 0;
  notchFound = false;
  stepLabel = 'HOME';
  sequenceLabel = 'IDLE';
  mode: 'auto' | 'manual' = 'auto';
  error: string | null = null;
  cycleTime = 0;
  lastCycle = 0;
  cycles = 0;
  /** degradation 0..1 for the robot-transfer failure scenario */
  vacuumLeak = 0;
  /** slip offset (m) of wafer on blade after a vacuum fault */
  slip = 0;
  loop = false;
  private queue: Step[] = [];
  private current: Step | null = null;
  private move: MultiAxisMove | null = null;
  private timer = 0;
  version = 0;

  get holding() {
    return this.waferLoc === 'effector';
  }

  /** Joint angles derived from task space (degrees for telemetry). */
  joints() {
    const { L, Le } = ROBOT_GEOM;
    const d = Math.min(2 * L - 1e-4, Math.max(0, this.q[1] - Le));
    const alpha = Math.acos(d / (2 * L));
    return { j1: this.q[0], j2: alpha, j3: -2 * alpha, j4: alpha };
  }

  /** Wafer-centre / blade position in the robot frame. */
  effector() {
    const [th, r, z] = this.q;
    return { x: Math.cos(th) * r, y: z, z: -Math.sin(th) * r };
  }

  speed() {
    // end-effector speed from task velocities
    const [, r] = this.q;
    const [thd, rd, zd] = this.qd;
    return Math.sqrt((r * thd) ** 2 + rd ** 2 + zd ** 2);
  }

  accel() {
    const [, r] = this.q;
    const [thdd, rdd, zdd] = this.qdd;
    return Math.sqrt((r * thdd) ** 2 + rdd ** 2 + zdd ** 2);
  }

  /** Reset to a canonical state (used when the visitor jumps to a phase). */
  setState(th: number, r: number, z: number, loc: WaferLoc, vac: boolean) {
    this.q = [th, r, z];
    this.qd = [0, 0, 0];
    this.qdd = [0, 0, 0];
    this.waferLoc = loc;
    this.vacuumOn = vac;
    this.vacuumKPa = vac ? -78 : 0;
    this.queue = [];
    this.current = null;
    this.move = null;
    this.error = null;
    this.slip = 0;
    this.version++;
  }

  enqueue(steps: Step[], label: string) {
    this.queue.push(...steps);
    this.sequenceLabel = label;
  }

  clear() {
    this.queue = [];
    this.current = null;
    this.move = null;
  }

  get busy() {
    return !!this.current || this.queue.length > 0;
  }

  /* -------------------------- sequences -------------------------- */

  static seqMap(): Step[] {
    const f = STATIONS.foup;
    return [
      { kind: 'move', label: 'MAP', th: f.th, r: 0.4, z: 0.36 },
      { kind: 'move', label: 'MAP', z: 0.09 },
      { kind: 'move', label: 'MAP', r: STATIONS.home.r, z: STATIONS.home.z },
    ];
  }

  static seqPickFoup(): Step[] {
    const f = STATIONS.foup;
    return [
      { kind: 'move', label: 'HOME', th: f.th, r: STATIONS.home.r, z: f.z - 0.006 },
      { kind: 'move', label: 'PICK', r: f.r },
      { kind: 'vac', label: 'PICK', on: true },
      { kind: 'move', label: 'PICK', z: f.z + 0.006 },
      { kind: 'grip', label: 'VERIFY', from: 'foup' },
      { kind: 'wait', label: 'VERIFY', dur: 0.35 },
      { kind: 'move', label: 'PICK', r: STATIONS.home.r },
    ];
  }

  static seqAlign(): Step[] {
    const a = STATIONS.aligner;
    return [
      { kind: 'move', label: 'ROTATE', th: a.th, z: a.z + 0.006 },
      { kind: 'move', label: 'TRANSFER', r: a.r },
      { kind: 'move', label: 'PLACE', z: a.z - 0.006 },
      { kind: 'vac', label: 'PLACE', on: false },
      { kind: 'release', label: 'PLACE', to: 'aligner' },
      { kind: 'move', label: 'RETURN', r: 0.3 },
      { kind: 'spin', label: 'VERIFY', dur: 1.1 },
      { kind: 'move', label: 'PICK', r: a.r },
      { kind: 'vac', label: 'PICK', on: true },
      { kind: 'move', label: 'PICK', z: a.z + 0.006 },
      { kind: 'grip', label: 'VERIFY', from: 'aligner' },
      { kind: 'move', label: 'PICK', r: STATIONS.home.r },
    ];
  }

  static seqTransfer(): Step[] {
    const c = STATIONS.chamber;
    return [
      { kind: 'move', label: 'ROTATE', th: c.th, z: c.z + 0.008 },
      { kind: 'move', label: 'TRANSFER', r: c.r },
    ];
  }

  static seqPlaceChamber(): Step[] {
    const c = STATIONS.chamber;
    return [
      { kind: 'move', label: 'PLACE', z: c.z - 0.006 },
      { kind: 'vac', label: 'PLACE', on: false },
      { kind: 'release', label: 'PLACE', to: 'chamber' },
      { kind: 'wait', label: 'VERIFY', dur: 0.4 },
      { kind: 'move', label: 'RETURN', r: STATIONS.home.r },
    ];
  }

  static seqReturnHome(): Step[] {
    const h = STATIONS.home;
    return [{ kind: 'move', label: 'RETURN', th: h.th, r: h.r, z: h.z }];
  }

  static seqPickChamber(): Step[] {
    const c = STATIONS.chamber;
    return [
      { kind: 'move', label: 'ROTATE', th: c.th, r: STATIONS.home.r, z: c.z - 0.006 },
      { kind: 'move', label: 'PICK', r: c.r },
      { kind: 'vac', label: 'PICK', on: true },
      { kind: 'move', label: 'PICK', z: c.z + 0.008 },
      { kind: 'grip', label: 'VERIFY', from: 'chamber' },
      { kind: 'move', label: 'PICK', r: STATIONS.home.r },
    ];
  }

  static seqPlaceFoup(): Step[] {
    const f = STATIONS.foup;
    return [
      { kind: 'move', label: 'ROTATE', th: f.th, z: f.z + 0.006 },
      { kind: 'move', label: 'TRANSFER', r: f.r },
      { kind: 'move', label: 'PLACE', z: f.z - 0.006 },
      { kind: 'vac', label: 'PLACE', on: false },
      { kind: 'release', label: 'PLACE', to: 'foup' },
      { kind: 'move', label: 'RETURN', r: STATIONS.home.r },
      { kind: 'move', label: 'HOME', z: STATIONS.home.z },
      { kind: 'cycle', label: 'HOME' },
    ];
  }

  /** Full automatic demo cycle used in the robotics lab. */
  enqueueFullCycle() {
    this.enqueue(
      [
        ...RobotController.seqPickFoup(),
        ...RobotController.seqAlign(),
        ...RobotController.seqTransfer(),
        ...RobotController.seqPlaceChamber(),
        { kind: 'wait', label: 'PROCESS', dur: 1.5 },
        ...RobotController.seqPickChamber(),
        ...RobotController.seqPlaceFoup(),
      ],
      'AUTO CYCLE',
    );
  }

  /* -------------------------- manual -------------------------- */

  /** Manual jog target (clamped to mechanical limits). */
  jogTo(th: number, r: number, z: number) {
    if (this.error) return;
    const { rMin, rMax, zMin, zMax } = ROBOT_GEOM;
    const target = { kind: 'move' as const, label: 'MANUAL', th, r: Math.min(rMax, Math.max(rMin, r)), z: Math.min(zMax, Math.max(zMin, z)) };
    this.queue = [target];
    this.current = null;
    this.move = null;
    this.sequenceLabel = 'MANUAL';
  }

  /** Station whose wafer support is at the end effector, if within tolerance. */
  stationAtEffector(): Station | null {
    for (const s of [STATIONS.foup, STATIONS.aligner, STATIONS.chamber]) {
      const dth = Math.abs(((this.q[0] - s.th + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (dth < 0.05 && Math.abs(this.q[1] - s.r) < 0.02 && Math.abs(this.q[2] - s.z) < 0.012) return s;
    }
    return null;
  }

  toggleVacuum() {
    if (this.busy && this.mode === 'auto') return;
    this.vacuumOn = !this.vacuumOn;
    const s = this.stationAtEffector();
    if (this.vacuumOn && s && this.waferLoc === (s.id as WaferLoc)) this.waferLoc = 'effector';
    else if (!this.vacuumOn && this.waferLoc === 'effector' && s) this.waferLoc = s.id as WaferLoc;
    this.version++;
  }

  /* -------------------------- tick -------------------------- */

  tick(dt: number) {
    if (dt <= 0) {
      this.qd = [0, 0, 0];
      this.qdd = [0, 0, 0];
      return;
    }
    this.cycleTime += dt;
    // vacuum dynamics (first-order) + leak scenario
    const sealed = this.vacuumOn && this.waferLoc === 'effector';
    const target = this.vacuumOn ? (sealed ? -78 + 70 * this.vacuumLeak : -12) : 0;
    this.vacuumKPa += (target - this.vacuumKPa) * Math.min(1, dt * 8);

    if (this.error) {
      // controlled stop: decelerate quickly
      for (let i = 0; i < 3; i++) {
        this.qd[i] *= Math.max(0, 1 - dt * 12);
        this.q[i] += this.qd[i] * dt;
        this.qdd[i] = 0;
      }
      return;
    }

    if (sealed && this.vacuumKPa > -40 && this.speed() > 0.05) {
      this.error = 'E-VAC · GRIP VACUUM LOW — CONTROLLED STOP';
      this.slip = 0.025;
      this.stepLabel = 'ERROR';
      this.version++;
      return;
    }

    let budget = dt;
    let guard = 0;
    while (budget > 0 && guard++ < 8) {
      if (!this.current) {
        this.current = this.queue.shift() ?? null;
        this.timer = 0;
        this.move = null;
        if (!this.current) {
          this.qd = [0, 0, 0];
          this.qdd = [0, 0, 0];
          if (this.loop && this.mode === 'auto') this.enqueueFullCycle();
          return;
        }
        this.stepLabel = this.current.label;
        this.version++;
      }
      const s = this.current;
      if (s.kind === 'move') {
        if (!this.move) {
          const to = [s.th ?? this.q[0], s.r ?? this.q[1], s.z ?? this.q[2]];
          this.move = new MultiAxisMove([...this.q], to, this.holding ? LIMITS_LOADED : LIMITS_EMPTY);
        }
        const remain = this.move.duration - this.move.t;
        const step = Math.min(budget, remain);
        this.move.advance(step);
        budget -= step;
        for (let i = 0; i < 3; i++) {
          this.q[i] = this.move.pos(i);
          this.qd[i] = this.move.vel(i);
          this.qdd[i] = this.move.acc(i);
        }
        if (this.move.done) {
          this.current = null;
          this.move = null;
        }
      } else if (s.kind === 'wait' || s.kind === 'spin') {
        const step = Math.min(budget, s.dur - this.timer);
        this.timer += step;
        budget -= step;
        this.qd = [0, 0, 0];
        this.qdd = [0, 0, 0];
        if (s.kind === 'spin') {
          this.waferSpin += step * 7;
          if (this.timer >= s.dur) {
            this.notchFound = true;
            this.waferSpin = 0;
          }
        }
        if (this.timer >= s.dur - 1e-9) this.current = null;
      } else {
        if (s.kind === 'vac') this.vacuumOn = s.on;
        if (s.kind === 'grip') this.waferLoc = 'effector';
        if (s.kind === 'release') this.waferLoc = s.to;
        if (s.kind === 'cycle') {
          this.cycles++;
          this.lastCycle = this.cycleTime;
          this.cycleTime = 0;
        }
        this.current = null;
        this.version++;
      }
    }
  }
}
