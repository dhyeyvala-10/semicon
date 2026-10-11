/**
 * Scroll story runtime. The story scroller writes here every frame; the camera rig
 * and the scenes read it. Nothing in here goes through React.
 */
import type { Stage } from '@/types';
import { JOURNEY } from '@/data/process';

export const story = {
  /** the scroll story owns the camera and the stage timeline */
  active: false,
  /** smoothed position inside the current stage section, 0..1 */
  local: 0,
  /** scroll velocity in viewport heights per second (smoothed) */
  velocity: 0,
  /** 0..1 black veil used to hide scene changes */
  veil: 0,
  /** where the 3D subject should sit on screen, as a fraction of the viewport (x right, y down) */
  frame: { x: 0, y: 0 },
  /** set when the camera must jump (scene change) instead of gliding */
  cut: true,
};

/** Hero machines get a longer stretch of scroll; connecting steps pass quicker. */
const LONG = new Set([
  'quartz', 'crystal-growth', 'slicing', 'polishing', 'cleanroom-entry', 'oxidation', 'deposition', 'lithography', 'etch',
  'implant', 'cmp', 'transistor', 'architectures', 'metal-stack', 'inspection', 'wafer-sort', 'dicing', 'bonding',
  'advanced-packaging', 'final-test', 'distribution', 'system', 'ecosystem',
]);

export interface Chapter {
  stage: Stage;
  index: number;
  /** section height in viewport heights */
  length: number;
  /** first stage of a macro phase (act) */
  actStart: boolean;
  act: number;
}

export const CHAPTERS: Chapter[] = (() => {
  let act = 0;
  return JOURNEY.map((stage, index) => {
    const actStart = index === 0 || JOURNEY[index - 1].macro !== stage.macro;
    if (actStart && index > 0) act++;
    return { stage, index, length: LONG.has(stage.id) ? 1.6 : 1.0, actStart, act };
  });
})();
