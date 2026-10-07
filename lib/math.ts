/** Small numeric helpers shared by data, simulation and 3D code. */

export const clamp = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** normalised position of x inside [a, b], clamped to 0..1 */
export const seg = (x: number, a: number, b: number) => clamp((x - a) / (b - a));
export const smooth = (t: number) => {
  const x = clamp(t);
  return x * x * (3 - 2 * x);
};
export const smoother = (t: number) => {
  const x = clamp(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
};
export const easeInOut = (t: number) => {
  const x = clamp(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
export const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t), 3);
export const easeIn = (t: number) => Math.pow(clamp(t), 3);
/** triangle pulse 0→1→0 across [0,1] */
export const tri = (t: number) => 1 - Math.abs(clamp(t) * 2 - 1);
/** first-order approach of a step: 1 - e^{-t/tau} */
export const approach = (t: number, tau: number) => 1 - Math.exp(-Math.max(0, t) / tau);
export const fract = (x: number) => x - Math.floor(x);
export const TAU = Math.PI * 2;
export const deg = (r: number) => (r * 180) / Math.PI;
export const rad = (d: number) => (d * Math.PI) / 180;

/** Deterministic hash → [0,1) */
export function hash1(n: number): number {
  let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Smooth value noise in [-1, 1] for a channel at time t. Deterministic. */
export function vnoise(t: number, channel = 0): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hash1(i * 131 + channel * 7919) * 2 - 1;
  const b = hash1((i + 1) * 131 + channel * 7919) * 2 - 1;
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

/** Choose a "nice" round number ≤ x (1, 2, 5 × 10^n). */
export function niceFloor(x: number): number {
  if (x <= 0 || !isFinite(x)) return 0;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / p;
  const n = m >= 5 ? 5 : m >= 2 ? 2 : 1;
  return n * p;
}

/** Format a length in metres with SI prefix. */
export function formatLength(m: number): string {
  const a = Math.abs(m);
  if (a >= 1000) return `${+(m / 1000).toPrecision(3)} km`;
  if (a >= 1) return `${+m.toPrecision(3)} m`;
  if (a >= 1e-2) return `${+(m * 100).toPrecision(3)} cm`;
  if (a >= 1e-3) return `${+(m * 1000).toPrecision(3)} mm`;
  if (a >= 1e-6) return `${+(m * 1e6).toPrecision(3)} µm`;
  if (a >= 1e-9) return `${+(m * 1e9).toPrecision(3)} nm`;
  return `${+(m * 1e12).toPrecision(3)} pm`;
}

export function fmt(v: number, decimals = 1): string {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return v.toExponential(2);
  return v.toFixed(decimals);
}

/** Mulberry32 seeded PRNG. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller normal sample from a uniform generator. */
export function gauss(r: () => number) {
  const u = Math.max(1e-9, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}
