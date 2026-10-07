/**
 * Simplified physical / process models shared by the 3D scenes AND the telemetry
 * samplers. Because both read the same functions, a number on screen always
 * corresponds to what the geometry is showing (§57: 3D EVENT ⇄ DATA CHANGE).
 *
 * Models are educational. Where coefficients come from literature this is noted;
 * outputs driven by the simulation clock are SIMULATED data.
 */
import { clamp, lerp, seg, smooth, approach, rng, gauss, hash1 } from '@/lib/math';

/* ------------------------------------------------------------------ */
/* Czochralski growth                                                  */
/* ------------------------------------------------------------------ */

/** Crystal length (m) grown at the end of each CZ phase. */
export const CZ_SEGMENTS = { neck: 0.12, crown: 0.15, body: 1.35, tail: 0.25 } as const;
export const CZ_TOTAL = CZ_SEGMENTS.neck + CZ_SEGMENTS.crown + CZ_SEGMENTS.body + CZ_SEGMENTS.tail;
export const CZ_BODY_R = 0.155; // m — slightly over 150 mm, ground to 300 mm later
const NECK_R = 0.0045;

/** Radius (m) of the crystal at distance s (m) from the seed. */
export function czRadiusAt(s: number, wobble = 0): number {
  const { neck, crown, body, tail } = CZ_SEGMENTS;
  if (s < 0) return 0;
  if (s < neck) return NECK_R;
  if (s < neck + crown) {
    const u = (s - neck) / crown;
    return lerp(NECK_R, CZ_BODY_R, Math.sin((u * Math.PI) / 2) ** 1.4);
  }
  if (s < neck + crown + body) {
    const u = (s - neck - crown) / body;
    return CZ_BODY_R * (1 + wobble * 0.06 * Math.sin(u * 40) * smooth(seg(u, 0.4, 0.55)) * (1 - smooth(seg(u, 0.75, 0.85))));
  }
  const u = clamp((s - neck - crown - body) / tail);
  return lerp(CZ_BODY_R, 0.02, Math.pow(u, 1.6));
}

/** Grown length (m) for a CZ phase id + progress. */
export function czLength(phaseId: string, phaseT: number): number {
  const { neck, crown, body, tail } = CZ_SEGMENTS;
  switch (phaseId) {
    case 'melt':
    case 'stabilize':
    case 'dip':
      return 0;
    case 'neck':
      return neck * phaseT;
    case 'crown':
      return neck + crown * phaseT;
    case 'body':
      return neck + crown + body * phaseT;
    case 'tail':
      return neck + crown + body + tail * phaseT;
    default:
      return CZ_TOTAL;
  }
}

export function czPullRate(phaseId: string): number {
  // mm/min, representative values
  return phaseId === 'neck' ? 3.5 : phaseId === 'crown' ? 0.7 : phaseId === 'body' ? 1.0 : phaseId === 'tail' ? 1.3 : 0;
}

/* ------------------------------------------------------------------ */
/* Thermal oxidation — Deal–Grove                                      */
/* ------------------------------------------------------------------ */

const K_B = 8.617e-5; // eV/K
/**
 * Deal–Grove dry-O₂ oxide thickness (µm) on (100) Si.
 * B = 7.72e2·exp(−1.23 eV/kT) µm²/h,  B/A = 6.23e6·exp(−2.0 eV/kT) µm/h  (Plummer et al., Table 6-2).
 */
export function dealGrove(hours: number, tempC: number, xi = 0.002): number {
  const T = tempC + 273.15;
  const B = 7.72e2 * Math.exp(-1.23 / (K_B * T));
  const BA = 6.23e6 * Math.exp(-2.0 / (K_B * T));
  const A = B / BA;
  const tau = (xi * xi + A * xi) / B;
  const t = Math.max(0, hours) + tau;
  return (-A + Math.sqrt(A * A + 4 * B * t)) / 2;
}
/** Fraction of grown oxide lying below the original silicon surface. */
export const OXIDE_CONSUMPTION = 0.44;

/* ------------------------------------------------------------------ */
/* Spin coating                                                        */
/* ------------------------------------------------------------------ */

/** Final resist thickness (nm) ∝ ω^-½ (Meyerhofer). Calibrated so 3000 rpm → 110 nm. */
export const spinThickness = (rpm: number) => (110 * Math.sqrt(3000)) / Math.sqrt(Math.max(rpm, 300));

/** Spin-coat recipe as a function of phase. Returns rpm and film thickness. */
export function spinRecipe(phaseId: string, phaseT: number): { rpm: number; thickness: number; spread: number } {
  switch (phaseId) {
    case 'load':
    case 'prime':
      return { rpm: 0, thickness: 0, spread: 0 };
    case 'dispense':
      return { rpm: lerp(0, 500, smooth(phaseT * 3)), thickness: 2500, spread: 0.08 + 0.25 * phaseT };
    case 'spread':
      return { rpm: lerp(500, 1000, smooth(phaseT)), thickness: lerp(2500, 600, phaseT), spread: lerp(0.33, 1, smooth(phaseT)) };
    case 'spin': {
      const rpm = lerp(1000, 3000, smooth(phaseT * 2.5));
      const final = spinThickness(3000);
      return { rpm, thickness: lerp(600, final, approach(phaseT, 0.25)), spread: 1 };
    }
    case 'ebr':
      return { rpm: 1500, thickness: spinThickness(3000), spread: 1 };
    case 'stop':
      return { rpm: lerp(1500, 0, smooth(phaseT)), thickness: spinThickness(3000), spread: 1 };
    default:
      return { rpm: 0, thickness: spinThickness(3000), spread: 1 };
  }
}

/* ------------------------------------------------------------------ */
/* Etch                                                                */
/* ------------------------------------------------------------------ */

export const ETCH_TARGET_NM = 120;
/** Etch depth (nm) and lateral undercut (nm) for dry/wet modes. */
export function etchProfile(phaseId: string, phaseT: number, wet: boolean, variation = 0) {
  let progress = 0;
  if (phaseId === 'main') progress = phaseT * 0.92;
  else if (phaseId === 'endpoint') progress = 0.92 + 0.08 * phaseT;
  else if (phaseId === 'unload') progress = 1;
  const rateScale = 1 - 0.35 * variation; // etch-variation failure reduces rate
  const depth = Math.min(ETCH_TARGET_NM, ETCH_TARGET_NM * progress * rateScale * (wet ? 1 : 1));
  const undercut = wet ? depth : depth * 0.04;
  return { depth, undercut, progress: progress * rateScale };
}

/* ------------------------------------------------------------------ */
/* Ion implantation                                                    */
/* ------------------------------------------------------------------ */

/** Representative boron implant: 20 keV → projected range ≈ 66 nm, straggle ≈ 26 nm. */
export const IMPLANT = { energyKeV: 20, rp: 66, drp: 26, doseTarget: 2e15 };

/** Deterministic set of implanted ion positions (nm), used by the cross-section. */
export function implantIons(count: number, seed = 7) {
  const r = rng(seed);
  const out: { x: number; depth: number; lateral: number }[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: r(), depth: Math.max(2, IMPLANT.rp + gauss(r) * IMPLANT.drp), lateral: gauss(r) * 8 });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* RTP anneal temperature profile                                      */
/* ------------------------------------------------------------------ */

export function rtpTemp(phaseId: string, phaseT: number, overshoot = 0): number {
  const peak = 1050 + overshoot * 90;
  switch (phaseId) {
    case 'load':
      return 25 + 10 * phaseT;
    case 'purge':
      return lerp(35, 450, smooth(phaseT));
    case 'ramp':
      return lerp(450, peak - 40, phaseT);
    case 'spike':
      return phaseT < 0.5 ? lerp(peak - 40, peak, smooth(phaseT * 2)) : lerp(peak, peak - 120, smooth((phaseT - 0.5) * 2));
    case 'cool':
      return lerp(peak - 120, 250, 1 - Math.exp(-phaseT * 3)) ;
    case 'unload':
      return lerp(250, 80, phaseT);
    default:
      return 25;
  }
}

/* ------------------------------------------------------------------ */
/* CMP                                                                 */
/* ------------------------------------------------------------------ */

/** Topography step height (nm) decays as high points are removed faster (Preston). */
export function cmpStepHeight(phaseId: string, phaseT: number): number {
  const h0 = 300;
  if (phaseId === 'load') return h0;
  if (phaseId === 'polish') return h0 * Math.exp(-phaseT * 3.2);
  return h0 * Math.exp(-3.2) * (phaseId === 'endpoint' ? 1 - 0.7 * phaseT : 0.3);
}
export function cmpRemoved(phaseId: string, phaseT: number): number {
  const total = 420;
  if (phaseId === 'load') return 0;
  if (phaseId === 'polish') return total * 0.85 * phaseT;
  if (phaseId === 'endpoint') return total * (0.85 + 0.15 * phaseT);
  return total;
}

/* ------------------------------------------------------------------ */
/* Wafer geometry: exposure fields & dies                              */
/* ------------------------------------------------------------------ */

export const WAFER_D = 300; // mm
export const FIELD_W = 26; // mm (x)
export const FIELD_H = 33; // mm (y)
export const DIE_W = 13;
export const DIE_H = 16.5;
export const EDGE_EXCLUSION = 3;

export interface Field {
  i: number;
  cx: number;
  cy: number;
  order: number;
}

/** Exposure fields covering the wafer (mm, centred), in serpentine exposure order. */
export function exposureFields(): Field[] {
  const fields: Field[] = [];
  const R = WAFER_D / 2;
  const nx = Math.ceil(WAFER_D / FIELD_W) + 1;
  const ny = Math.ceil(WAFER_D / FIELD_H) + 1;
  let order = 0;
  for (let j = 0; j < ny; j++) {
    const row: Field[] = [];
    for (let i = 0; i < nx; i++) {
      const cx = (i - (nx - 1) / 2) * FIELD_W;
      const cy = (j - (ny - 1) / 2) * FIELD_H;
      // include field if any corner region falls inside usable radius
      const dx = Math.max(Math.abs(cx) - FIELD_W / 2, 0);
      const dy = Math.max(Math.abs(cy) - FIELD_H / 2, 0);
      if (Math.hypot(dx, dy) < R - EDGE_EXCLUSION) row.push({ i: fields.length + row.length, cx, cy, order: 0 });
    }
    if (j % 2 === 1) row.reverse();
    for (const f of row) {
      f.order = order++;
      fields.push(f);
    }
  }
  fields.forEach((f, k) => (f.i = k));
  return fields;
}

export interface Die {
  id: number;
  col: number;
  row: number;
  cx: number;
  cy: number;
}

/** Complete dies inside the usable wafer area (mm, centred). */
export function dieGrid(): Die[] {
  const dies: Die[] = [];
  const R = WAFER_D / 2 - EDGE_EXCLUSION;
  const nx = Math.floor(WAFER_D / DIE_W);
  const ny = Math.floor(WAFER_D / DIE_H);
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const cx = (c - (nx - 1) / 2) * DIE_W;
      const cy = (r - (ny - 1) / 2) * DIE_H;
      const corners = [
        [cx - DIE_W / 2, cy - DIE_H / 2],
        [cx + DIE_W / 2, cy - DIE_H / 2],
        [cx - DIE_W / 2, cy + DIE_H / 2],
        [cx + DIE_W / 2, cy + DIE_H / 2],
      ];
      if (corners.every(([x, y]) => Math.hypot(x, y) <= R)) dies.push({ id: dies.length, col: c, row: r, cx, cy });
    }
  }
  return dies;
}

export type DieResult = 'PASS' | 'FAIL' | 'REVIEW';
export const DEFECT_CLASSES = ['Particle', 'Pattern bridge', 'Open line', 'Scratch', 'Residue', 'Edge chipping', 'Parametric drift'] as const;
export type DefectClass = (typeof DEFECT_CLASSES)[number];

export interface DieStatus {
  die: Die;
  result: DieResult;
  defect?: DefectClass;
  /** simulated speed bin used later in final test */
  fmax: number;
}

/**
 * Simulated wafer map: random particle defects, one scratch, an edge-ring
 * effect. Educational — NOT production data.
 */
export function simulateWaferMap(seed = 184, contamination = 0): DieStatus[] {
  const dies = dieGrid();
  const r = rng(seed);
  const R = WAFER_D / 2;
  // scratch: arc across part of the wafer
  const sA = r() * Math.PI * 2;
  const sx = Math.cos(sA) * 40;
  const sy = Math.sin(sA) * 40;
  const sdx = Math.cos(sA + 1.2);
  const sdy = Math.sin(sA + 1.2);
  return dies.map((die) => {
    const rad = Math.hypot(die.cx, die.cy) / R;
    let p = 0.05 + contamination * 0.25; // random defect probability
    p += rad > 0.85 ? 0.18 : 0; // edge ring
    const h = hash1(die.id * 97 + seed);
    // distance to scratch line
    const vx = die.cx - sx;
    const vy = die.cy - sy;
    const along = vx * sdx + vy * sdy;
    const perp = Math.abs(vx * -sdy + vy * sdx);
    const onScratch = perp < 6 && along > -50 && along < 70;
    const fmax = 3.2 + 1.4 * (1 - rad * rad) * 0.6 + (hash1(die.id * 13 + 5) - 0.5) * 0.6;
    if (onScratch) return { die, result: 'FAIL', defect: 'Scratch', fmax };
    if (h < p) {
      const cls: DefectClass = rad > 0.85 ? (h < 0.06 ? 'Edge chipping' : 'Residue') : (['Particle', 'Pattern bridge', 'Open line', 'Particle', 'Residue'] as DefectClass[])[Math.floor(hash1(die.id + 3) * 5)];
      return { die, result: 'FAIL', defect: cls, fmax };
    }
    if (h < p + 0.035) return { die, result: 'REVIEW', defect: 'Parametric drift', fmax };
    return { die, result: 'PASS', fmax };
  });
}

/* ------------------------------------------------------------------ */
/* Metrology "ground truth" (drives both geometry and measurement)     */
/* ------------------------------------------------------------------ */

export const METRO = {
  cdTarget: 24, // nm (CONCEPTUAL line width)
  cdActual: (seed = 0) => 24 + (hash1(seed + 11) - 0.5) * 1.6,
  film: 52.4, // nm
  overlay: { x: 1.8, y: -1.1 }, // nm
  depth: 118, // nm
  /** surface profile height (nm) along x ∈ [0,1] — lines and spaces with roughness */
  profile: (x: number) => {
    const pitch = 1 / 6;
    const u = (x % pitch) / pitch;
    const line = u > 0.25 && u < 0.75 ? 1 : 0;
    const edge = Math.min(1, Math.max(0, line ? Math.min((u - 0.25) / 0.04, (0.75 - u) / 0.04) : 0));
    return 45 * edge + 1.2 * Math.sin(x * 157) + 0.6 * Math.sin(x * 413);
  },
};

/* ------------------------------------------------------------------ */
/* Thin-film interference colour (representative, for visuals only)    */
/* ------------------------------------------------------------------ */

/** Approximate perceived colour of SiO₂ on Si by thickness (nm). Educational approximation. */
export function oxideColor(nm: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0, [0.55, 0.57, 0.6]],
    [50, [0.62, 0.55, 0.42]],
    [75, [0.55, 0.38, 0.32]],
    [100, [0.4, 0.28, 0.5]],
    [125, [0.25, 0.32, 0.65]],
    [150, [0.3, 0.5, 0.75]],
    [200, [0.6, 0.62, 0.5]],
    [250, [0.75, 0.6, 0.35]],
    [300, [0.55, 0.3, 0.45]],
  ];
  const x = clamp(nm, 0, 300);
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [a, ca] = stops[i - 1];
      const [b, cb] = stops[i];
      const t = (x - a) / (b - a);
      return [lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t)];
    }
  }
  return stops[stops.length - 1][1];
}
