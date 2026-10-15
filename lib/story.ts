/**
 * Scroll story runtime and layout.
 *
 * `story` is written every frame by the story scroller and read by the camera rig and the
 * scenes; nothing in it goes through React. `STORY` describes the scroll layout: one section
 * per chapter (data/chapters.ts), each split across the chapter's stages by their duration.
 */
import { CHAPTERS, type Chapter } from '@/data/chapters';
import { STAGE_BY_ID } from '@/data/process';

export const story = {
  /** the scroll story owns the camera and the stage timeline */
  active: false,
  /** position inside the current stage, 0..1 */
  local: 0,
  /** scroll velocity in viewport heights per second (smoothed) */
  velocity: 0,
  /** 0..1 dark veil used to hide scene changes */
  veil: 0,
  /** where the 3D subject should sit on screen, as a fraction of the viewport (x right, y up) */
  frame: { x: 0, y: 0 },
  /** set when the camera must jump (scene change) instead of gliding */
  cut: true,
};

/** The stage shown behind the hero. */
export const HERO_STAGE = 'fab-overview';

export interface StoryPart {
  stage: string;
  /** share of the chapter's scroll range, 0..1 */
  from: number;
  to: number;
}

export interface StoryChapter {
  chapter: Chapter;
  index: number;
  /** section height in screen heights */
  length: number;
  /** the one 3D scene all stages of the chapter share */
  scene: string;
  parts: StoryPart[];
}

/** Screen heights of scroll per chapter: a base for reading plus one per stage. */
const BASE = 0.6;
const PER_STAGE = 1.0;

export const STORY: StoryChapter[] = CHAPTERS.map((chapter, index) => {
  const stages = chapter.stages.filter((id) => STAGE_BY_ID[id]);
  const dur = stages.map((id) => STAGE_BY_ID[id].phases.reduce((a, p) => a + p.duration, 0) || 1);
  const total = dur.reduce((a, d) => a + d, 0) || 1;
  let acc = 0;
  const parts = stages.map((stage, i) => {
    const from = acc / total;
    acc += dur[i];
    return { stage, from, to: acc / total };
  });
  return { chapter, index, length: BASE + PER_STAGE * Math.max(1, stages.length), scene: STAGE_BY_ID[stages[0]]?.scene ?? 'fab', parts };
});

export const LAST_STAGE = (() => {
  const p = STORY[STORY.length - 1].parts;
  return p[p.length - 1].stage;
})();

/** Which stage a chapter shows at a scroll position inside it, and how far into that stage. */
export function stageAt(ch: StoryChapter, local: number): { stage: string; t: number } {
  const u = Math.min(1, Math.max(0, local));
  let part = ch.parts[0];
  for (const p of ch.parts) if (u >= p.from) part = p;
  return { stage: part.stage, t: Math.min(1, Math.max(0, (u - part.from) / Math.max(1e-6, part.to - part.from))) };
}

/** The chapter position (0..1) where a stage starts. */
export function chapterLocalOf(ch: StoryChapter, stageId: string, stageT = 0): number {
  const p = ch.parts.find((x) => x.stage === stageId);
  return p ? p.from + (p.to - p.from) * stageT : 0;
}

/** Index into STORY of the chapter that plays a stage, or -1. */
export function chapterIndexOf(stageId: string): number {
  return STORY.findIndex((c) => c.parts.some((p) => p.stage === stageId));
}

/** Phase id of a stage at a position 0..1, from the stage data (no engine needed). */
export function phaseAt(stageId: string, t: number): string {
  const st = STAGE_BY_ID[stageId];
  if (!st || !st.phases.length) return '';
  const total = st.phases.reduce((a, p) => a + p.duration, 0) || 1;
  const at = Math.min(total - 1e-6, Math.max(0, t * total));
  let acc = 0;
  for (const p of st.phases) {
    acc += p.duration;
    if (at < acc) return p.id;
  }
  return st.phases[st.phases.length - 1].id;
}

/** The plain caption for a stage at a position 0..1. */
export function captionAt(ch: Chapter, stageId: string, t: number): string {
  return ch.captions[`${stageId}:${phaseAt(stageId, t)}`] ?? ch.line;
}
