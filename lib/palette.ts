/**
 * Journey colour grading.
 *
 * The palette is a continuous path through the green family in OKLCH space —
 * earthy olive at silica extraction, molten olive-gold at crystal growth, sage at
 * wafering, moss and forest through the fab, pine and jade at packaging and the
 * finished system. Every stage (and every layer cycle) samples its own grade from
 * that path; transitions blend smoothly because neighbouring grades share
 * lightness and chroma. Nothing is bound to a function — the palette is mood, not
 * a legend.
 */
import { clamp, lerp, vnoise } from './math';
import { JOURNEY, STAGE_BY_ID } from '@/data/process';

export interface LCH {
  l: number;
  c: number;
  h: number;
}

/** Anchors along the journey (t = 0 extraction … 1 finished system). */
const ANCHORS: { t: number; c: LCH; name: string }[] = [
  { t: 0.0, c: { l: 0.7, c: 0.07, h: 92 }, name: 'khaki olive' },
  { t: 0.07, c: { l: 0.66, c: 0.085, h: 98 }, name: 'smelter olive' },
  { t: 0.13, c: { l: 0.74, c: 0.11, h: 96 }, name: 'molten olive-gold' },
  { t: 0.22, c: { l: 0.72, c: 0.075, h: 122 }, name: 'sage' },
  { t: 0.3, c: { l: 0.7, c: 0.1, h: 132 }, name: 'moss' },
  { t: 0.45, c: { l: 0.68, c: 0.115, h: 146 }, name: 'forest' },
  { t: 0.6, c: { l: 0.67, c: 0.105, h: 156 }, name: 'deep forest' },
  { t: 0.72, c: { l: 0.75, c: 0.12, h: 128 }, name: 'fern' },
  { t: 0.85, c: { l: 0.68, c: 0.095, h: 166 }, name: 'pine' },
  { t: 1.0, c: { l: 0.73, c: 0.1, h: 174 }, name: 'jade' },
];

export function lchAt(t: number): LCH {
  const x = clamp(t);
  for (let i = 1; i < ANCHORS.length; i++) {
    const a = ANCHORS[i - 1];
    const b = ANCHORS[i];
    if (x <= b.t) {
      const u = (x - a.t) / (b.t - a.t || 1);
      const s = u * u * (3 - 2 * u);
      return { l: lerp(a.c.l, b.c.l, s), c: lerp(a.c.c, b.c.c, s), h: lerp(a.c.h, b.c.h, s) };
    }
  }
  return ANCHORS[ANCHORS.length - 1].c;
}

/* ---------------- OKLCH → sRGB ---------------- */

function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

/** OKLCH → sRGB in 0..1 (gamut-clipped). */
export function lchToRgb({ l, c, h }: LCH): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const [r, g, b] = oklabToLinear(l, c * Math.cos(hr), c * Math.sin(hr));
  return [clamp(gamma(r)), clamp(gamma(g)), clamp(gamma(b))];
}
/** OKLCH → linear RGB 0..1 (for three.js colours). */
export function lchToLinear({ l, c, h }: LCH): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const [r, g, b] = oklabToLinear(l, c * Math.cos(hr), c * Math.sin(hr));
  return [clamp(r), clamp(g), clamp(b)];
}
export function hex(c: LCH): string {
  const [r, g, b] = lchToRgb(c);
  const h2 = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${h2(r)}${h2(g)}${h2(b)}`;
}
export function rgba(c: LCH, a: number): string {
  const [r, g, b] = lchToRgb(c);
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
}

/* ---------------- grades ---------------- */

export interface Grade {
  /** main hue: buttons, highlights, data lines */
  accent: LCH;
  /** companion hue for gradients (warmer / cooler neighbour on the path) */
  accent2: LCH;
  /** light glow for emissive and text highlights */
  glow: LCH;
  /** deep tone for backgrounds, fog and vignettes */
  deep: LCH;
  /** journey position 0..1 */
  t: number;
}

/** Thematic journey positions for locations outside the numbered journey. */
const EXPLORE_T: Record<string, number> = {
  'fab-overview': 0.42,
  'control-room': 0.5,
  utilities: 0.36,
  'supply-chain': 0.9,
  'robot-lab': 0.31,
  'scale-journey': 0.55,
};

export function journeyT(stageId: string): number {
  const i = JOURNEY.findIndex((s) => s.id === stageId);
  if (i >= 0) return i / (JOURNEY.length - 1);
  return EXPLORE_T[stageId] ?? 0.42;
}

export function gradeAt(t: number, cycle = 0): Grade {
  const base = lchAt(t);
  // each layer cycle shifts the grade so repeated loops are visibly distinct
  const h = base.h + cycle * 11;
  const accent = { ...base, h };
  return {
    t,
    accent,
    accent2: { l: base.l - 0.04, c: base.c * 0.9, h: h - 34 },
    glow: { l: Math.min(0.9, base.l + 0.14), c: base.c * 0.7, h: h + 6 },
    deep: { l: 0.17, c: Math.min(0.04, base.c * 0.38), h },
  };
}

/** Grade for a stage, including per-phase cycle shifts for the layer-cycle stage. */
export function gradeForStage(stageId: string, phaseId?: string): Grade {
  const cycle = stageId === 'layer-cycle' && phaseId ? ({ c17: 0, c18: 1, c19: 2, next: 3 } as Record<string, number>)[phaseId] ?? 0 : 0;
  return gradeAt(journeyT(stageId), cycle);
}

/** “Human touch”: slow organic drift so the grade is never a flat, static colour. */
export function drift(g: Grade, time: number): Grade {
  const dh = 5 * vnoise(time * 0.07, 11) + 2.5 * Math.sin(time * 0.11);
  const dl = 0.018 * vnoise(time * 0.05, 23);
  const dc = 0.012 * vnoise(time * 0.09, 37);
  const f = (c: LCH, k = 1): LCH => ({ l: clamp(c.l + dl * k, 0, 1), c: Math.max(0, c.c + dc * k), h: c.h + dh * k });
  return { ...g, accent: f(g.accent), accent2: f(g.accent2, 1.4), glow: f(g.glow, 0.6), deep: f(g.deep, 0.4) };
}

export function mixLCH(a: LCH, b: LCH, t: number): LCH {
  // shortest hue path
  let dh = b.h - a.h;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return { l: lerp(a.l, b.l, t), c: lerp(a.c, b.c, t), h: a.h + dh * t };
}
export function mixGrade(a: Grade, b: Grade, t: number): Grade {
  return {
    t: lerp(a.t, b.t, t),
    accent: mixLCH(a.accent, b.accent, t),
    accent2: mixLCH(a.accent2, b.accent2, t),
    glow: mixLCH(a.glow, b.glow, t),
    deep: mixLCH(a.deep, b.deep, t),
  };
}

/** Macro phases sampled for the landing ribbon. */
export const JOURNEY_RIBBON = [
  { macro: 'MATERIAL', label: 'Silica', sub: 'Quarry → silicon', first: 'quartz' },
  { macro: 'CRYSTAL', label: 'Crystal', sub: 'Melt → ingot', first: 'crystal-growth' },
  { macro: 'WAFERING', label: 'Wafer', sub: 'Slice → polish', first: 'ingot-shaping' },
  { macro: 'FAB_ENTRY', label: 'Cleanroom', sub: 'FOUP → robot', first: 'cleanroom-entry' },
  { macro: 'FEOL', label: 'Transistors', sub: 'Pattern → dope', first: 'oxidation' },
  { macro: 'BEOL', label: 'Wiring', sub: 'Copper stack', first: 'contacts' },
  { macro: 'TEST', label: 'Test', sub: 'Measure → sort', first: 'metrology' },
  { macro: 'BACKEND', label: 'Package', sub: 'Dice → bond', first: 'dicing' },
  { macro: 'DISTRIBUTION', label: 'System', sub: 'Ship → compute', first: 'packing' },
] as const;

export function stageT(id: string) {
  return STAGE_BY_ID[id] ? journeyT(id) : 0;
}
