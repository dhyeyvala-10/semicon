/**
 * The followed object's digital twin (§58, §119).
 * One persistent identity travels the whole chain: material batch → ingot → wafer → die → package → product.
 * State changes go through a transition table; illegal jumps are routed through the
 * shortest legal path so the recorded state history is always valid.
 */
import type { ObjectForm, Stage, WaferEffect, WaferState, WaferSurface } from '@/types';

export const LEGAL: Record<WaferState, WaferState[]> = {
  WAFER_CREATED: ['WAFER_IN_TRANSIT', 'MACHINE_LOADING', 'PROCESSING'],
  WAFER_IN_TRANSIT: ['MACHINE_LOADING'],
  MACHINE_LOADING: ['PROCESSING'],
  PROCESSING: ['MACHINE_UNLOADING', 'DEFECT_DETECTED', 'INSPECTION'],
  MACHINE_UNLOADING: ['INSPECTION', 'NEXT_PROCESS', 'WAFER_IN_TRANSIT'],
  INSPECTION: ['ACCEPTED', 'DEFECT_DETECTED'],
  ACCEPTED: ['NEXT_PROCESS'],
  NEXT_PROCESS: ['WAFER_IN_TRANSIT'],
  DEFECT_DETECTED: ['REVIEW'],
  REVIEW: ['REWORK', 'SCRAP', 'ACCEPTED'],
  REWORK: ['WAFER_IN_TRANSIT'],
  SCRAP: [],
};

/** BFS shortest legal path (excluding `from`, including `to`). Returns null if unreachable. */
export function legalPath(from: WaferState, to: WaferState): WaferState[] | null {
  if (from === to) return [];
  const prev = new Map<WaferState, WaferState>();
  const q: WaferState[] = [from];
  const seen = new Set<WaferState>([from]);
  while (q.length) {
    const s = q.shift()!;
    for (const n of LEGAL[s]) {
      if (seen.has(n)) continue;
      seen.add(n);
      prev.set(n, s);
      if (n === to) {
        const path: WaferState[] = [n];
        let c = n;
        while (prev.get(c) && prev.get(c) !== from) {
          c = prev.get(c)!;
          path.unshift(c);
        }
        return path;
      }
      q.push(n);
    }
  }
  return null;
}

export interface TwinHistoryEntry {
  stageId: string;
  num: number;
  title: string;
  machine?: string;
  location: string;
  result: 'OK' | 'REWORK' | 'SCRAP' | 'REVIEW' | 'IN PROGRESS';
  tIn: number;
  tOut?: number;
}

export interface TwinTransition {
  t: number;
  from: WaferState;
  to: WaferState;
  reason: string;
}

export class WaferTwin {
  readonly waferId = 'WF-000184';
  readonly lotId = 'LOT-A0731';
  readonly slot = 7;
  readonly batchId = 'PS-2219';
  readonly ingotId = 'IG-0447';
  readonly chipId = 'CH-184-0412';

  form: ObjectForm = 'material';
  state: WaferState = 'WAFER_CREATED';
  stageId = '';
  stageTitle = '';
  machine = '—';
  location = '—';
  surface: WaferSurface = 'none';
  layerCount = 0;
  maskLayers = 0;
  processCycle = 0;
  thicknessUm = 0;
  diameterMm = 0;
  inspection: 'NOT INSPECTED' | 'PASS' | 'REVIEW' | 'FAIL' = 'NOT INSPECTED';
  defectCount = 0;
  testState = 'NOT TESTED';
  packageState = '—';
  /** accumulated time spent in PROCESSING (s, playback time) */
  processTime = 0;
  history: TwinHistoryEntry[] = [];
  transitions: TwinTransition[] = [];
  version = 0;

  reset() {
    this.form = 'material';
    this.state = 'WAFER_CREATED';
    this.stageId = '';
    this.stageTitle = '';
    this.machine = '—';
    this.location = '—';
    this.surface = 'none';
    this.layerCount = 0;
    this.maskLayers = 0;
    this.processCycle = 0;
    this.thicknessUm = 0;
    this.diameterMm = 0;
    this.inspection = 'NOT INSPECTED';
    this.defectCount = 0;
    this.testState = 'NOT TESTED';
    this.packageState = '—';
    this.processTime = 0;
    this.history = [];
    this.transitions = [];
    this.version++;
  }

  /** Identity shown in the HUD for the current physical form. */
  get displayId(): string {
    switch (this.form) {
      case 'material':
        return this.batchId;
      case 'ingot':
        return this.ingotId;
      case 'wafer':
        return this.waferId;
      default:
        return this.chipId;
    }
  }

  get formLabel(): string {
    return { material: 'MATERIAL BATCH', ingot: 'INGOT', wafer: 'WAFER', die: 'DIE', package: 'PACKAGE', product: 'PRODUCT' }[this.form];
  }

  /** Move to `to` through the shortest legal path. */
  transition(to: WaferState, t: number, reason = '') {
    if (to === this.state) return;
    let path = legalPath(this.state, to);
    if (!path) {
      // e.g. leaving SCRAP after a reset of a failure demo: restart the lifecycle explicitly
      this.transitions.push({ t, from: this.state, to: 'WAFER_CREATED', reason: 'lifecycle restart' });
      this.state = 'WAFER_CREATED';
      path = legalPath(this.state, to) ?? [to];
    }
    for (const s of path) {
      this.transitions.push({ t, from: this.state, to: s, reason: s === to ? reason : 'implied' });
      this.state = s;
    }
    if (this.transitions.length > 60) this.transitions.splice(0, this.transitions.length - 60);
    this.version++;
  }

  enterStage(stage: Stage, t: number) {
    this.stageId = stage.id;
    this.stageTitle = stage.title;
    this.machine = stage.machine ?? '—';
    this.location = stage.location;
    const open = this.history[this.history.length - 1];
    if (!open || open.stageId !== stage.id) {
      this.history.push({ stageId: stage.id, num: stage.num, title: stage.short, machine: stage.machine, location: stage.location, result: 'IN PROGRESS', tIn: t });
    }
    this.version++;
  }

  applyEffect(e: WaferEffect | undefined) {
    if (!e) return;
    if (e.form) {
      this.form = e.form;
      if (e.form === 'wafer' && this.diameterMm === 0) this.diameterMm = 300;
    }
    if (e.surface) this.surface = e.surface;
    if (e.layerDelta) this.layerCount += e.layerDelta;
    if (e.maskLayerDelta) this.maskLayers += e.maskLayerDelta;
    if (e.cycleDelta) this.processCycle += e.cycleDelta;
    if (e.thicknessUm) this.thicknessUm = e.thicknessUm;
    if (e.inspection) this.inspection = e.inspection;
    if (e.testState) this.testState = e.testState;
    if (e.packageState) this.packageState = e.packageState;
    if (e.location) this.location = e.location;
    if (e.defects !== undefined) this.defectCount = e.defects;
    this.version++;
  }

  completeStage(stage: Stage, t: number, result: TwinHistoryEntry['result'] = 'OK') {
    this.applyEffect(stage.effect);
    if (stage.id === 'layer-cycle' && this.processCycle < 19) this.processCycle = 19;
    const h = this.history[this.history.length - 1];
    if (h && h.stageId === stage.id) {
      h.result = result;
      h.tOut = t;
    }
    this.version++;
  }

  /**
   * Deterministically rebuild the twin as if every journey stage before `stages[index]`
   * had completed normally. Used when the visitor jumps around the journey.
   */
  rebuild(stages: Stage[], index: number) {
    this.reset();
    let t = 0;
    for (let i = 0; i < index; i++) {
      const s = stages[i];
      this.enterStage(s, t);
      this.transition('PROCESSING', t, 'fast-forward');
      t += s.phases.reduce((a, p) => a + p.duration, 0);
      this.processTime += s.phases.filter((p) => p.waferState === 'PROCESSING').reduce((a, p) => a + p.duration, 0);
      this.transition('ACCEPTED', t, 'fast-forward');
      this.transition('NEXT_PROCESS', t, 'fast-forward');
      this.completeStage(s, t);
    }
    if (index > 0 && this.processCycle === 0 && index > stages.findIndex((s) => s.id === 'layer-cycle')) this.processCycle = 19;
    this.version++;
  }
}
