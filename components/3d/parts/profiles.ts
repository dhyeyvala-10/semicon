/**
 * 2D cross-section polygons (x right, y up) used by ProfileSlab to build accurate,
 * animated cross-sections: trenches, conformal / non-conformal films, etch profiles.
 * Units are inset-local (≈ 1.1 wide).
 */

export type Poly = [number, number][];

export const TRENCH = { x0: -0.13, x1: 0.13, depth: 0.26, top: 0 };

/** Substrate with one trench, spanning [-0.55, 0.55] × [-0.45, 0]. */
export function substrateWithTrench(depth = TRENCH.depth, x0 = TRENCH.x0, x1 = TRENCH.x1): Poly {
  return [
    [-0.55, -0.45],
    [0.55, -0.45],
    [0.55, 0],
    [x1, 0],
    [x1, -depth],
    [x0, -depth],
    [x0, 0],
    [-0.55, 0],
  ];
}

/**
 * Film over a trench with separate top / sidewall / bottom thickness (step coverage).
 * Thicknesses are clamped so opposite sidewalls meet (pinch-off) rather than cross.
 */
export function filmOverTrench(tTop: number, tSide: number, tBot: number, depth = TRENCH.depth, x0 = TRENCH.x0, x1 = TRENCH.x1, overhang = 0): Poly {
  const half = (x1 - x0) / 2;
  const mid = (x0 + x1) / 2;
  const inner: Poly = [
    [-0.55, 0],
    [x0, 0],
    [x0, -depth],
    [x1, -depth],
    [x1, 0],
    [0.55, 0],
  ];
  if (tSide >= half - 0.002 || tBot >= depth - 0.002) {
    // pinched off / filled: the trench is full, the top shows a shrinking cusp over the seam
    const cusp = Math.max(0.003, Math.min(tTop * 0.6, half * 0.8) * (1 - Math.min(1, Math.max(0, tSide - half) / half)));
    return [...inner, [0.55, tTop], [x1 + half * 0.4, tTop], [mid, tTop - cusp], [x0 - half * 0.4, tTop], [-0.55, tTop]];
  }
  const s = tSide;
  const b = tBot;
  const oh = Math.min(overhang, half - s - 0.002);
  const neck = Math.max(-depth + b + 0.001, Math.min(tTop * 0.2, -0.002));
  // inner boundary (the surface) left → right, then outer boundary right → left
  return [
    ...inner,
    [0.55, tTop],
    [x1 - oh, tTop],
    [x1 - s - oh, neck],
    [x1 - s, -depth + b],
    [x0 + s, -depth + b],
    [x0 + s + oh, neck],
    [x0 + oh, tTop],
    [-0.55, tTop],
  ];
}

/** Blanket film of thickness t on a flat surface at y0. */
export function blanket(t: number, y0 = 0, x0 = -0.55, x1 = 0.55): Poly {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y0 + Math.max(0.0005, t)],
    [x0, y0 + Math.max(0.0005, t)],
  ];
}

/**
 * Film being etched through a mask opening [o0, o1] — anisotropic (dry) or isotropic (wet).
 * Returns the remaining film polygon (film spans y ∈ [y0, y0 + h]).
 */
export function etchedFilm(depth: number, undercut: number, h: number, y0 = 0, o0 = -0.12, o1 = 0.12): Poly {
  const top = y0 + h;
  const d = Math.min(depth, h);
  if (d < 0.002) return [[-0.55, y0], [0.55, y0], [0.55, top], [-0.55, top]];
  const u = Math.max(0, undercut);
  const n = 10;
  const pts: Poly = [[-0.55, y0], [0.55, y0], [0.55, top]];
  // right wall: quarter ellipse from under the mask edge down to the opening edge
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * (Math.PI / 2);
    pts.push([o1 + u * Math.cos(a), top - d * Math.sin(a)]);
  }
  // left wall, mirrored
  for (let i = n; i >= 0; i--) {
    const a = (i / n) * (Math.PI / 2);
    pts.push([o0 - u * Math.cos(a), top - d * Math.sin(a)]);
  }
  pts.push([-0.55, top]);
  return pts;
}

/** Wavy topography (for CMP): bumps over buried features. */
export function bumpyTop(y0: number, amp: number, n = 4): Poly {
  const pts: Poly = [[-0.55, -0.1]];
  for (let i = 0; i <= 80; i++) {
    const x = -0.55 + (1.1 * i) / 80;
    const u = ((x + 0.55) / 1.1) * n;
    const bump = Math.max(0, Math.sin(u * Math.PI)) ** 0.6;
    pts.push([x, y0 + amp * bump]);
  }
  pts.push([0.55, -0.1]);
  return pts;
}
