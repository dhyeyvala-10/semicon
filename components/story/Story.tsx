'use client';
/**
 * The scroll story: the default way through, in 13 plain chapters (data/chapters.ts).
 *
 * The page scrolls; the 3D world stays fixed behind it and fills the screen. One section per
 * chapter. The section on the reading line is the active chapter, and the position inside it
 * plays the chapter's stage(s) in order, so the machines move with the scroll and the camera
 * glides along each stage's camera cues (see CameraRig). All stages of a chapter share one
 * scene, so scrolling inside a chapter never waits for a new scene.
 *
 * Everything that changes while scrolling (veil, caption, progress, active card) is written
 * to the DOM from one rAF loop. React only renders the static sections.
 */
import { useEffect, useRef } from 'react';
import { useUI } from '@/lib/store';
import { engine } from '@/simulation/engine';
import { STAGE_BY_ID } from '@/data/process';
import { CHAPTERS, CHAPTER_OF_STAGE } from '@/data/chapters';
import { HERO_STAGE, LAST_STAGE, STORY, captionAt, chapterIndexOf, chapterLocalOf, stageAt, story, type StoryChapter } from '@/lib/story';
import { prefetchScene } from '@/components/3d/sceneLoaders';
import type { SceneId } from '@/types';

const N = STORY.length;
const FIRST_STAGE = CHAPTERS[0].stages[0];

/** Set once the visitor has opened Explore; coming back, the story resumes where they were. */
let visitedExplore = false;
useUI.subscribe((s) => {
  if (s.started) visitedExplore = true;
});

/** Leave the story and open Explore at a chapter stage (the current one by default). */
export function enterExplore(stageId: string = engine.stage.id) {
  const id = CHAPTER_OF_STAGE[stageId] ? stageId : FIRST_STAGE;
  story.active = false;
  engine.player.driven = false;
  const ui = useUI.getState();
  ui.set({ started: true });
  if (id === engine.stage.id) {
    // same stage: keep playing from where the scroll left it, glide to the free camera
    engine.player.playing = true;
    useUI.setState((s) => ({ cameraNonce: s.cameraNonce + 1 }));
  } else ui.goToStage(id, { autoplay: true });
}

/** Reading line as a fraction of the screen height; lower on portrait screens, where the text sits at the bottom. */
function readLine() {
  return typeof window !== 'undefined' && window.innerHeight > window.innerWidth ? 0.62 : 0.5;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function Arrow() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden focusable="false">
      <path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Hero({ onStart }: { onStart: () => void }) {
  return (
    <section className="st-hero" data-hero aria-labelledby="st-hero-title">
      <div className="st-hero-copy">
        <h1 id="st-hero-title">How a computer chip is made</h1>
        <p>Follow ordinary sand on its way to becoming the chip inside your computer, one simple step at a time.</p>
        <div className="st-actions">
          <button className="btn btn-primary btn-lg" onClick={onStart}>
            Start <Arrow />
          </button>
          <button className="link" onClick={() => enterExplore(FIRST_STAGE)}>
            Explore freely
          </button>
        </div>
      </div>
    </section>
  );
}

function ChapterSection({ c }: { c: StoryChapter }) {
  const ch = c.chapter;
  const first = c.parts[0].stage;
  return (
    <section className="st-ch" data-i={c.index} data-chapter={ch.id} data-stage={first} style={{ ['--len' as string]: c.length }} aria-labelledby={`st-${ch.id}`}>
      <div className="st-card">
        <p className="st-step">
          Step {c.index + 1} of {N}
        </p>
        <h2 id={`st-${ch.id}`}>{ch.title}</h2>
        <p className="st-line">{ch.line}</p>
        <p className="st-now">
          <i aria-hidden />
          <span data-cap>{captionAt(ch, first, 0)}</span>
        </p>
      </div>
    </section>
  );
}

function Outro({ onTop }: { onTop: () => void }) {
  return (
    <section className="st-outro" data-outro aria-labelledby="st-outro-title">
      <div className="st-card">
        <h2 id="st-outro-title">That is how a chip is made</h2>
        <p className="st-line">From sand to a working computer in {N} steps. Want a closer look? Explore any step in 3D, at your own pace.</p>
        <div className="st-actions">
          <button className="btn btn-primary" onClick={() => enterExplore()}>
            Explore freely
          </button>
          <button className="link" onClick={onTop}>
            Back to the start
          </button>
        </div>
      </div>
    </section>
  );
}

export function Story() {
  const fallback = useUI((s) => s.fallback2D);
  // without WebGL the 2D page (components/fallback) tells the same story
  return fallback ? null : <ScrollStory />;
}

function ScrollStory() {
  const scroller = useRef<HTMLDivElement>(null);
  const veil = useRef<HTMLDivElement>(null);
  const veilStep = useRef<HTMLSpanElement>(null);
  const veilTitle = useRef<HTMLSpanElement>(null);
  const progress = useRef<HTMLDivElement>(null);

  /** scroll to the start of a chapter (its section on the reading line) */
  const goToChapter = (i: number, smooth = true) => {
    const el = scroller.current;
    const sec = el?.querySelector<HTMLElement>(`[data-i="${i}"]`);
    if (!el || !sec) return;
    const glide = smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: sec.offsetTop - el.clientHeight * readLine() + 2, behavior: glide ? 'smooth' : 'auto' });
  };

  useEffect(() => {
    const el = scroller.current!;
    story.active = true;
    story.cut = true;
    engine.player.driven = true;
    engine.player.autoAdvance = false;
    el.focus({ preventScroll: true });
    const url = new URL(window.location.href);
    if (url.searchParams.has('stage')) {
      url.searchParams.delete('stage');
      window.history.replaceState(null, '', url.toString());
    }

    // sections in page order: hero, one per chapter, outro
    const secs = Array.from(el.querySelectorAll<HTMLElement>('[data-hero], [data-i], [data-outro]'));
    const K = secs.length;
    const cards = secs.map((s) => s.querySelector<HTMLElement>('.st-card, .st-hero-copy'));
    const caps = secs.map((s) => s.querySelector<HTMLElement>('[data-cap]'));
    const segs = Array.from(progress.current?.children ?? []) as HTMLElement[];
    const fills = segs.map((s) => s.firstElementChild as HTMLElement | null);
    const chapterOf = (k: number) => (k <= 0 ? null : STORY[Math.min(N - 1, k - 1)]);
    const sceneOf = (k: number): SceneId => (k <= 0 ? STAGE_BY_ID[HERO_STAGE].scene : (chapterOf(k)!.scene as SceneId));

    // layout, measured on resize only (phone toolbars and fonts change it)
    let H = 1;
    let W = 1;
    let tops: number[] = [];
    let hs: number[] = [];
    let bounds: number[] = [];
    let frames: { x: number; y: number }[] = [];
    const measure = () => {
      H = el.clientHeight || 1;
      W = el.clientWidth || 1;
      tops = secs.map((s) => s.offsetTop);
      hs = secs.map((s) => s.offsetHeight);
      // scene changes are hidden behind the veil
      bounds = [];
      for (let k = 1; k < K; k++) if (sceneOf(k) !== sceneOf(k - 1)) bounds.push(tops[k]);
      // centre the 3D subject in the part of the screen the text leaves free
      const portrait = H > W;
      const topInset = 72;
      frames = cards.map((c) => {
        if (!c) return { x: 0, y: 0 };
        if (portrait) {
          const free = (topInset + H - c.offsetHeight - 16) / 2;
          return { x: 0, y: Math.min(0.24, Math.max(0, 0.5 - free / H)) };
        }
        const right = c.offsetLeft + c.offsetWidth;
        return { x: Math.min(0.24, Math.max(0, (right + W) / 2 / W - 0.5)), y: -topInset / 2 / H };
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    cards.forEach((c) => c && ro.observe(c));

    // resume where the visitor left the story (coming back from Explore); a first visit opens on the hero
    const ci = visitedExplore ? chapterIndexOf(engine.stage.id) : -1;
    if (ci >= 0) {
      const local = chapterLocalOf(STORY[ci], engine.stage.id, engine.player.view.stageT);
      el.scrollTop = tops[ci + 1] - H * readLine() + hs[ci + 1] * local;
    } else if (engine.stage.id !== HERO_STAGE) useUI.getState().goToStage(HERO_STAGE, { autoplay: true });

    let raf = 0;
    let last = performance.now();
    let smooth = el.scrollTop;
    let lastTop = el.scrollTop;
    let vel = 0;
    let veilCur = 1;
    let busyShown = false;
    let busySince = 0;
    let veilChapter = -2;
    let pending: { stage: string; since: number } | null = null;
    // after a scene change: wait until the new scene renders smoothly before lifting the veil
    let settling = true;
    let switchedAt = performance.now();
    let calm = 0;
    let activeK = -1;
    let progK = -2;
    let progFill = -1;
    let lastPre = 0;
    const capShown: string[] = secs.map((s) => s.querySelector('[data-cap]')?.textContent ?? '');
    const motion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const loop = (t: number) => {
      const dt = Math.min(0.25, (t - last) / 1000);
      last = t;
      const top = el.scrollTop;
      smooth += (top - smooth) * (1 - Math.exp(-Math.min(dt, 0.1) * 10));
      if (Math.abs(top - smooth) < 0.5) smooth = top;
      vel += ((top - lastTop) / Math.max(dt, 1e-3) / H - vel) * 0.25;
      lastTop = top;
      story.velocity = vel;

      // which section is on the reading line
      const line = smooth + H * readLine();
      let k = 0;
      for (let j = 0; j < K; j++) if (line >= tops[j]) k = j;
      const isOutro = k === K - 1;
      const chLocal = k === 0 ? 0 : isOutro ? 1 : Math.min(1, Math.max(0, (line - tops[k]) / hs[k]));
      const ch = chapterOf(k);
      const at = k === 0 ? { stage: HERO_STAGE, t: 0 } : isOutro ? { stage: LAST_STAGE, t: 1 } : stageAt(ch!, chLocal);
      const want = at.stage;

      if (k !== activeK) {
        if (activeK >= 0) secs[activeK].classList.remove('on');
        secs[k].classList.add('on');
        activeK = k;
      }

      // the subject sits in the free part of the screen
      const f = frames[k] ?? { x: 0, y: 0 };
      const kf = 1 - Math.exp(-Math.min(dt, 0.1) * 6);
      story.frame.x += (f.x - story.frame.x) * kf;
      story.frame.y += (f.y - story.frame.y) * kf;

      // stage switching: inside a scene at once; across scenes only once the scroll settles and the veil is down
      const ui = useUI.getState();
      if (want !== engine.stage.id) {
        const sceneChange = STAGE_BY_ID[want].scene !== engine.stage.scene;
        if (!sceneChange) {
          ui.goToStage(want, { autoplay: true });
          pending = null;
        } else {
          if (!pending || pending.stage !== want) pending = { stage: want, since: t };
          // the new scene is built while the veil (and the chapter's name on it) is fully shown
          const named = k === 0 || (busyShown && t - busySince > 180);
          if (t - pending.since > 120 && Math.abs(vel) < 1 && veilCur > 0.96 && named) {
            ui.goToStage(want, { autoplay: true });
            story.cut = true;
            pending = null;
            settling = true;
            switchedAt = t;
            calm = 0;
          }
        }
      } else pending = null;
      if (engine.stage.id === want && k > 0) engine.player.scrub(at.t);
      story.local = at.t;

      // veil: dark across scene boundaries, while waiting, and until the new scene renders smoothly
      const loaded = ui.loadedScenes.includes(engine.stage.scene);
      if (settling) {
        calm = loaded && dt < 0.07 ? calm + 1 : 0;
        if (loaded && (calm >= 3 || t - switchedAt > 2500)) settling = false;
      }
      // darken ahead of a scene boundary the scroll is moving towards (never while resting)
      const dir = vel > 0.05 ? 1 : vel < -0.05 ? -1 : 0;
      let near = 0;
      if (dir !== 0)
        for (const b of bounds) {
          const ahead = dir > 0 ? b - line : line - b;
          if (ahead >= 0) near = Math.max(near, 1 - smoothstep(0, H * 0.16, ahead));
        }
      const busy = !!pending || settling || !loaded;
      const target = busy ? 1 : near;
      veilCur += (target - veilCur) * (1 - Math.exp(-Math.min(dt, 0.1) * (target > veilCur ? 22 : 9)));
      if (Math.abs(target - veilCur) < 0.004) veilCur = target;
      story.veil = veilCur;
      if (veil.current) {
        veil.current.style.opacity = veilCur.toFixed(3);
        // name the chapter that is loading (not while the page is still moving)
        const showBusy = busy && k > 0 && Math.abs(vel) < 1;
        const vc = k > 0 ? Math.min(N - 1, k - 1) : -1;
        if (showBusy && vc !== veilChapter && veilStep.current && veilTitle.current) {
          veilChapter = vc;
          veilStep.current.textContent = `Step ${vc + 1} of ${N}`;
          veilTitle.current.textContent = STORY[vc].chapter.title;
        }
        if (showBusy !== busyShown) {
          busyShown = showBusy;
          busySince = t;
          veil.current.classList.toggle('busy', showBusy);
        }
      }

      // the live caption for what is happening right now
      if (ch && !isOutro) {
        const cap = captionAt(ch.chapter, want, at.t);
        const capEl = caps[k];
        if (capEl && cap !== capShown[k]) {
          capShown[k] = cap;
          capEl.textContent = cap;
          if (motion && secs[k].classList.contains('on')) capEl.animate?.([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
        }
      }

      // chapter progress: one segment per chapter, the current one fills with the scroll
      const pk = k === 0 ? -1 : isOutro ? N : k - 1;
      if (pk !== progK && progress.current) {
        progK = pk;
        progFill = -1;
        progress.current.classList.toggle('on', pk >= 0);
        segs.forEach((s, j) => {
          s.className = j < pk ? 'done' : j === pk ? 'cur' : '';
          const fl = fills[j];
          if (fl) fl.style.transform = '';
        });
      }
      if (pk >= 0 && pk < N) {
        const v = Math.round(chLocal * 200) / 200;
        const fl = fills[pk];
        if (fl && v !== progFill) {
          progFill = v;
          fl.style.transform = `scaleX(${v})`;
        }
      }

      // fetch the code of nearby scenes while the scroll is calm, so crossing into them never waits for the network
      if (t - lastPre > 700 && Math.abs(vel) < 0.6) {
        lastPre = t;
        for (const j of [k + 1, k + 2, k - 1]) if (j >= 0 && j < K) prefetchScene(sceneOf(j));
      }

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      story.active = false;
      engine.player.driven = false;
    };
  }, []);

  return (
    <>
      <div className="st-veil" ref={veil} style={{ opacity: 1 }} aria-hidden>
        <div className="veil-box">
          <span className="veil-step" ref={veilStep} />
          <span className="veil-title" ref={veilTitle} />
          <span className="veil-bar">
            <i />
          </span>
        </div>
      </div>
      <div className="st-scroll" ref={scroller} tabIndex={-1}>
        <Hero onStart={() => goToChapter(0)} />
        {STORY.map((c) => (
          <ChapterSection key={c.chapter.id} c={c} />
        ))}
        <Outro onTop={() => scroller.current?.scrollTo({ top: 0 })} />
      </div>
      <div className="st-progress" ref={progress} aria-hidden>
        {STORY.map((c) => (
          <span key={c.chapter.id}>
            <i />
          </span>
        ))}
      </div>
    </>
  );
}
