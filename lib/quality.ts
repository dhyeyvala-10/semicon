/**
 * Render quality tiers.
 *
 * Decided once, before the WebGL context is created: antialiasing is a context attribute,
 * and shadows / environment size are part of every shader program, so nothing here changes
 * during a session. Only the pixel ratio adapts (see `renderState.dpr`), which never
 * recompiles a shader.
 *
 *   phone   : small touch screen. Pixel ratio min(dpr, 2), no MSAA at 2x (the pixels are
 *             already tiny), no shadow maps (kit models keep their baked contact shadows),
 *             a smaller environment map, the hero fab drops detail it cannot show.
 *   tablet  : large touch screen. As a phone, at its own pixel ratio.
 *   desktop : as before: pixel ratio up to min(dpr, 1.5), MSAA, PCF shadow maps.
 *
 * `?quality=low` forces the phone tier, `?quality=high` the desktop tier.
 */

export type Tier = 'phone' | 'tablet' | 'desktop';

export interface Quality {
  tier: Tier;
  /** phone or tablet */
  mobile: boolean;
  /** device pixel ratio of the screen */
  deviceDpr: number;
  /** render pixel ratio to start at (and the adaptive ceiling) */
  dprMax: number;
  /** the adaptive pixel ratio does not step below this while the frame rate is merely low */
  dprFloor: number;
  /** last resort when even the floor runs truly badly */
  dprMin: number;
  /** MSAA (WebGL context attribute) */
  antialias: boolean;
  /** dynamic shadow maps (key light) */
  shadows: boolean;
  shadowMapSize: number;
  /** environment (reflection) cube-map resolution */
  envResolution: number;
  /** drop hidden or sub-pixel detail in large scenes (the landing fab) */
  lite: boolean;
}

const DESKTOP: Quality = {
  tier: 'desktop',
  mobile: false,
  deviceDpr: 1,
  dprMax: 1,
  dprFloor: 1,
  dprMin: 0.75,
  antialias: true,
  shadows: true,
  shadowMapSize: 2048,
  envResolution: 256,
  lite: false,
};

function detect(): Quality {
  if (typeof window === 'undefined') return DESKTOP;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mq = (q: string) => {
    try {
      return window.matchMedia(q).matches;
    } catch {
      return false;
    }
  };
  const deviceDpr = Math.max(1, window.devicePixelRatio || 1);
  const shortSide = Math.min(window.screen?.width || window.innerWidth, window.screen?.height || window.innerHeight);
  const coarse = mq('(pointer: coarse)') || (mq('(hover: none)') && (nav.maxTouchPoints ?? 0) > 0);
  const memory = nav.deviceMemory ?? 8;
  const cores = nav.hardwareConcurrency ?? 8;
  let force: string | null = null;
  try {
    force = new URLSearchParams(window.location.search).get('quality');
  } catch {
    /* ignore */
  }

  // measurement override: ?dpr=1 renders at that pixel ratio (fixed)
  let fixedDpr = 0;
  try {
    fixedDpr = Number(new URLSearchParams(window.location.search).get('dpr')) || 0;
  } catch {
    /* ignore */
  }
  const fix = (q: Quality): Quality => (fixedDpr > 0 ? { ...q, dprMax: fixedDpr, dprFloor: fixedDpr, dprMin: fixedDpr, antialias: q.mobile ? fixedDpr < 2 : q.antialias } : q);

  let tier: Tier = coarse ? (shortSide <= 600 ? 'phone' : 'tablet') : shortSide <= 500 ? 'phone' : 'desktop';
  if (force === 'low' && tier === 'desktop') tier = 'phone';
  if (force === 'high') tier = 'desktop';

  if (tier === 'desktop') {
    // fill rate, not geometry, is what costs most on laptop GPUs
    const dprMax = Math.min(deviceDpr, 1.5);
    return fix({ ...DESKTOP, deviceDpr, dprMax, dprFloor: Math.min(dprMax, 1) });
  }

  // phones and tablets: sharp (2x), no MSAA at 2x, no shadow maps
  const veryLow = memory <= 2 || cores <= 2;
  const dprMax = Math.min(deviceDpr, veryLow ? 1.5 : 2);
  return fix({
    tier,
    mobile: true,
    deviceDpr,
    dprMax,
    dprFloor: Math.min(dprMax, 1.25),
    dprMin: 1,
    antialias: dprMax < 2,
    shadows: false,
    shadowMapSize: 1024,
    envResolution: 128,
    lite: true,
  });
}

let _q: Quality | null = null;

/** The quality tier of this device (stable for the session). */
export function getQuality(): Quality {
  if (typeof window === 'undefined') return DESKTOP;
  return (_q ??= detect());
}

/** Hook form for components (the tier never changes, so this never re-renders anything). */
export const useQuality = getQuality;

/** Live render state, written by the renderer (Stage3D), readable anywhere without React. */
export const renderState = {
  /** current render pixel ratio */
  dpr: 1,
  /** times the adaptive pixel ratio stepped down / up */
  stepsDown: 0,
  stepsUp: 0,
  /** smoothed frames per second of the 3D view (0 until measured) */
  fps: 0,
};
