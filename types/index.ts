/**
 * Core domain types for the semiconductor fab digital twin.
 * Every visual component reads from data that conforms to these shapes, so the
 * content (process definitions, machines, robots…) can later move to SQLite,
 * PostgreSQL, Supabase or any other backend without touching the 3D layer.
 */

/** Classification required on every number shown in the UI (§90). */
export type DataKind = 'REAL' | 'REPRESENTATIVE' | 'SIMULATED' | 'CONCEPTUAL';

/** Whether a model/architecture follows public documentation or is a generic reconstruction (§95). */
export type ModelKind = 'PUBLICLY_DOCUMENTED' | 'EDUCATIONAL_MODEL';

export type MacroPhase =
  | 'MATERIAL'
  | 'CRYSTAL'
  | 'WAFERING'
  | 'FAB_ENTRY'
  | 'FEOL'
  | 'BEOL'
  | 'TEST'
  | 'BACKEND'
  | 'DISTRIBUTION'
  | 'EXPLORE';

export type SceneId =
  | 'fab'
  | 'materials'
  | 'crystal'
  | 'ingot'
  | 'finishing'
  | 'robot'
  | 'thermal'
  | 'deposition'
  | 'track'
  | 'lithography'
  | 'etch'
  | 'implant'
  | 'cmp'
  | 'cycle'
  | 'transistor'
  | 'interconnect'
  | 'metrology'
  | 'inspection'
  | 'probe'
  | 'dicing'
  | 'packaging'
  | 'finaltest'
  | 'shipping'
  | 'globe'
  | 'supplychain'
  | 'controlroom'
  | 'utilities'
  | 'system'
  | 'scale';

export type CameraMode = 'factory' | 'machine' | 'internal' | 'wafer' | 'micro' | 'transistor' | 'data';
export type ViewMode = 'normal' | 'xray' | 'cutaway' | 'exploded' | 'section';
export type InfoLevel = 1 | 2 | 3 | 4;
export type ExperienceMode = 'watch' | 'control' | 'learn' | 'engineer';

export type MachineState = 'IDLE' | 'LOADING' | 'PROCESSING' | 'UNLOADING' | 'MAINTENANCE' | 'ALARM' | 'OFFLINE';

export type WaferState =
  | 'WAFER_CREATED'
  | 'WAFER_IN_TRANSIT'
  | 'MACHINE_LOADING'
  | 'PROCESSING'
  | 'MACHINE_UNLOADING'
  | 'INSPECTION'
  | 'ACCEPTED'
  | 'NEXT_PROCESS'
  | 'DEFECT_DETECTED'
  | 'REVIEW'
  | 'REWORK'
  | 'SCRAP';

export type Status = 'NORMAL' | 'WARNING' | 'FAULT';

/** A sourced or classified fact. */
export interface Fact {
  label: string;
  value: string;
  kind: DataKind;
  source?: string; // id in data/sources
}

export interface Phase {
  id: string;
  label: string;
  /** seconds of playback at 1× */
  duration: number;
  waferState?: WaferState;
  machineState?: MachineState;
  /** camera cue used in WATCH mode */
  camera?: CameraMode;
  /** short visual caption — shown at info level ≥ 2 */
  caption?: string;
}

/** Context handed to telemetry samplers each simulation tick. */
export interface TelemetryCtx {
  /** seconds since stage start */
  t: number;
  /** 0..1 progress through the stage */
  stageT: number;
  phaseId: string;
  phaseIndex: number;
  /** 0..1 progress through the current phase */
  phaseT: number;
  /** deterministic noise in [-1, 1] keyed by channel */
  noise: (channel: number) => number;
  /** severity (0..1) of the active failure scenario if it matches the id, else 0 */
  fail: (id: string) => number;
  /** user-controlled parameters (e.g. alignment error slider) */
  param: (key: string, fallback: number) => number;
  /** live values published by simulation sub-systems (robot controller, fab sim…) */
  ext: (key: string, fallback: number) => number;
}

export interface TelemetryDef {
  id: string;
  label: string;
  unit: string;
  kind: DataKind;
  decimals?: number;
  /** chart range */
  min: number;
  max: number;
  target?: number;
  /** values outside [lo, hi] → WARNING */
  warn?: [number, number];
  /** values outside [lo, hi] → FAULT */
  fault?: [number, number];
  /** alarm bands apply only during these phases (e.g. a process setpoint, or a result after the step) */
  bandPhases?: string[];
  sample: (c: TelemetryCtx) => number;
}

/** Surface appearance of the wafer used by glyphs and 3D wafer materials. */
export type WaferSurface =
  | 'none'
  | 'as-cut'
  | 'ground'
  | 'lapped'
  | 'etched'
  | 'polished'
  | 'oxide'
  | 'film'
  | 'resist'
  | 'exposed'
  | 'developed'
  | 'patterned'
  | 'doped'
  | 'planarized'
  | 'metal'
  | 'passivated'
  | 'mapped'
  | 'diced';

export type ObjectForm = 'material' | 'ingot' | 'wafer' | 'die' | 'package' | 'product';

export interface WaferEffect {
  form?: ObjectForm;
  surface?: WaferSurface;
  layerDelta?: number;
  maskLayerDelta?: number;
  cycleDelta?: number;
  thicknessUm?: number;
  inspection?: 'PASS' | 'REVIEW' | 'FAIL';
  testState?: string;
  packageState?: string;
  location?: string;
  defects?: number;
}

export interface Stage {
  id: string;
  num: number;
  title: string;
  /** compact name for the rail */
  short: string;
  macro: MacroPhase;
  scene: SceneId;
  /** sub-variant inside a shared scene */
  variant?: string;
  machine?: string;
  robot?: string;
  location: string;
  phases: Phase[];
  summary: string;
  why: string;
  how: string;
  before: string;
  after: string;
  inputs: string[];
  outputs: string[];
  effect?: WaferEffect;
  telemetry?: TelemetryDef[];
  facts?: Fact[];
  views?: ViewMode[];
  failures?: string[];
  related?: string[];
  sources?: string[];
  /** label shown when the scale is not literal */
  schematic?: boolean;
  /** false for explorable locations that are not numbered journey steps */
  journey?: boolean;
  /** user-selectable modes for this stage (param key → labelled options) */
  modes?: { param: string; label: string; options: string[] }[];
  /** continuous what-if inputs (param key → range); applied live, no restart */
  sliders?: { param: string; label: string; min: number; max: number; step: number; unit: string }[];
}

export interface MachineComponent {
  id: string;
  name: string;
  description: string;
}

export type QuestionKey = 'what' | 'why' | 'how' | 'precision' | 'sensors' | 'wafer' | 'failure';

export interface MachineDef {
  id: string;
  name: string;
  category: string;
  modelKind: ModelKind;
  scene: SceneId;
  stages: string[];
  purpose: string;
  inputs: string[];
  outputs: string[];
  components: MachineComponent[];
  principle: string;
  sequence: string[];
  parameters: Fact[];
  robotics: string;
  sensors: string[];
  utilities: string[];
  related: string[];
  maintenance: string;
  safety?: string;
  qa?: Partial<Record<QuestionKey, string>>;
  controlLoop?: string;
  sources?: string[];
}

export interface SensorDef {
  id: string;
  name: string;
  type: 'temperature' | 'pressure' | 'position' | 'flow' | 'vacuum' | 'optical' | 'particle' | 'force' | 'electrical' | 'chemical';
  measures: string;
  why: string;
  where: string;
  unit: string;
}

export interface RobotDef {
  id: string;
  name: string;
  category: string;
  scene: SceneId;
  stage?: string;
  mechanism: string;
  movement: string;
  sensors: string[];
  controller: string;
  task: string;
  interacts: string[];
}

export interface MaterialDef {
  id: string;
  name: string;
  category: 'raw' | 'silicon' | 'chemical' | 'gas' | 'specialty' | 'metal' | 'dielectric' | 'packaging' | 'consumable';
  formula?: string;
  use: string;
  stages: string[];
  purity?: string;
  kind: DataKind;
}

export interface GlossaryTerm {
  id: string;
  term: string;
  aka?: string[];
  short: string;
  long?: string;
  related?: string[];
  stage?: string;
}

export interface SourceDef {
  id: string;
  title: string;
  org: string;
  date: string;
  url?: string;
  section?: string;
  note?: string;
}

export interface FailureScenario {
  id: string;
  title: string;
  stage: string;
  cause: string;
  effect: string;
  detection: string;
  disposition: 'REWORK' | 'SCRAP' | 'INTERVENTION';
  dispositionText: string;
  /** telemetry channel that drifts */
  channel?: string;
}

export interface Comparison {
  id: string;
  title: string;
  stage: string;
  /** scene-specific mode to activate */
  mode?: Record<string, string>;
  columns: string[];
  rows: { label: string; values: string[] }[];
}

export type SelectionKind =
  | 'machine'
  | 'component'
  | 'sensor'
  | 'robot'
  | 'wafer'
  | 'material'
  | 'glossary'
  | 'stage'
  | 'tool'
  | 'node'
  | 'die'
  | 'layer'
  | 'package';

export interface Selection {
  kind: SelectionKind;
  id: string;
  label?: string;
  /** owning machine, if any */
  machine?: string;
  meta?: Record<string, string | number>;
}

export interface CameraPreset {
  pos: [number, number, number];
  target: [number, number, number];
  fov?: number;
  /** meters represented by one world unit at this framing (drives the scale bar) */
  mpu?: number;
}

export interface SceneConfig {
  id: SceneId;
  name: string;
  facility: string;
  /** meters per world unit for the scene's main content */
  mpu: number;
  presets: Partial<Record<CameraMode, CameraPreset>>;
  /** variant-specific presets override `presets` */
  variants?: Record<string, Partial<Record<CameraMode, CameraPreset>>>;
  views: ViewMode[];
  environment: 'cleanroom' | 'litho' | 'hall' | 'assembly' | 'warehouse' | 'void' | 'office' | 'exterior';
}
