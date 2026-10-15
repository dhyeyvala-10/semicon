'use client';
/**
 * Explore: the free 3D view.
 *
 * The 3D fills the screen and can be turned and zoomed freely. The only interface sits at
 * the bottom: one caption card (what is happening, in plain words) with play/pause, "See
 * inside" and Recenter, and a row of the 13 chapters. Tapping a part shows its plain name
 * and one sentence. The top bar (logo, Back to story) is components/ui/TopBar.
 *
 * Nothing here re-renders per frame: the live caption is written to the DOM from a 4 Hz
 * timer, the desktop hover tip from a pointer-driven rAF.
 */
import '@/app/explore.css';
import { useEffect, useRef, useState } from 'react';
import { useUI, exploreView, hoverPart } from '@/lib/store';
import { engine } from '@/simulation/engine';
import { STAGE_BY_ID } from '@/data/process';
import { CHAPTERS, CHAPTER_OF_STAGE, type Chapter } from '@/data/chapters';
import { describePart } from './parts';

const N = CHAPTERS.length;
/** pause after the last phase before the chapter moves on (or starts over) */
const END_HOLD_MS = 1600;

const captionOf = (ch: Chapter, stageId: string, phaseId: string) => ch.captions[`${stageId}:${phaseId}`] ?? ch.line;

/** Open a chapter at its first stage, with the automatic camera back on. */
export function goToChapter(i: number) {
  const ch = CHAPTERS[((i % N) + N) % N];
  const ui = useUI.getState();
  ui.set({ freeCamera: false });
  ui.goToStage(ch.stages[0], { autoplay: true });
  engine.player.playing = true;
}

function togglePlay() {
  const p = engine.player;
  if (p.completed) p.restart();
  else p.playing = !p.playing;
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function Icon({ d, size = 20 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const PLAY = 'M8 5.5v13l10.5-6.5z';
const PAUSE = 'M8.5 5.5v13M15.5 5.5v13';
const CLOSE = 'M6 6l12 12M18 6L6 18';
const EYE = 'M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z';
const CENTER = 'M12 3v3M12 18v3M3 12h3M18 12h3M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z';

/** Small card with the tapped part's plain name and one sentence. */
function PartPopover() {
  const selection = useUI((s) => s.selection);
  if (!selection) return null;
  const info = describePart(selection);
  return (
    <div className="ex-pop" role="dialog" aria-label={info.name}>
      <div className="ex-pop-text">
        <h3>{info.name}</h3>
        {info.text && <p>{info.text}</p>}
      </div>
      <button className="ex-x" aria-label="Close" onClick={() => useUI.getState().select(null)}>
        <Icon d={CLOSE} size={18} />
      </button>
    </div>
  );
}

/** Desktop only: the plain name of the part under the pointer, next to the cursor. */
function HoverTip() {
  const tip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    const el = tip.current!;
    let x = 0;
    let y = 0;
    let raf = 0;
    let version = -1;
    const draw = () => {
      raf = 0;
      if (hoverPart.version !== version) {
        version = hoverPart.version;
        const sel = hoverPart.sel;
        el.textContent = sel ? describePart(sel).name : '';
        el.classList.toggle('on', !!sel);
      }
      if (hoverPart.sel) el.style.transform = `translate3d(${Math.round(x + 14)}px, ${Math.round(y + 18)}px, 0)`;
    };
    const move = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
      if (!raf) raf = requestAnimationFrame(draw);
    };
    const leave = () => {
      hoverPart.sel = null;
      hoverPart.version++;
      if (!raf) raf = requestAnimationFrame(draw);
    };
    window.addEventListener('pointermove', move, { passive: true });
    document.documentElement.addEventListener('pointerleave', leave);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('pointerleave', leave);
    };
  }, []);
  return <div className="ex-tip" ref={tip} aria-hidden />;
}

export function Explore() {
  const stageId = useUI((s) => s.stageId);
  const view = useUI((s) => s.view);
  const free = useUI((s) => s.freeCamera);
  const hasSelection = useUI((s) => !!s.selection);
  const ch = CHAPTER_OF_STAGE[stageId] ?? CHAPTERS[0];
  const idx = CHAPTERS.indexOf(ch);
  const canSeeInside = !!STAGE_BY_ID[stageId]?.views?.includes('cutaway');
  const [playing, setPlaying] = useState(() => engine.player.playing);
  const main = useRef<HTMLDivElement>(null);
  const chips = useRef<HTMLElement>(null);
  const cap = useRef<HTMLSpanElement>(null);

  // the engine plays on its own here; leaving restores the plain view
  useEffect(() => {
    engine.player.driven = false;
    engine.player.autoAdvance = false;
    const ui = useUI.getState();
    if (!CHAPTER_OF_STAGE[ui.stageId]) goToChapter(0);
    return () => {
      exploreView.frameY = 0;
      hoverPart.sel = null;
      hoverPart.version++;
      document.body.style.cursor = '';
      useUI.getState().set({ view: 'normal', selection: null, freeCamera: false });
    };
  }, []);

  // 4 Hz: the live caption, the play state, and what happens when a stage ends
  useEffect(() => {
    let shown = cap.current?.textContent ?? '';
    let endedAt = 0;
    const motion = !reducedMotion();
    const tick = () => {
      const p = engine.player;
      const sid = engine.stage.id;
      const c = CHAPTER_OF_STAGE[sid];
      const el = cap.current;
      if (c && el) {
        const text = captionOf(c, sid, p.view.phaseId);
        if (text !== shown) {
          shown = text;
          el.textContent = text;
          if (motion) el.animate?.([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: 'ease-out' });
        }
      }
      setPlaying(p.playing);
      // calm ending: hold on the last frame, then the chapter's next stage, or from the top
      if (c && p.completed && p.playing) {
        const now = performance.now();
        if (!endedAt) endedAt = now;
        else if (now - endedAt > END_HOLD_MS) {
          endedAt = 0;
          const next = c.stages[c.stages.indexOf(sid) + 1] ?? c.stages[0];
          if (next === sid) p.restart();
          else useUI.getState().goToStage(next, { autoplay: true, soft: true });
        }
      } else endedAt = 0;
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, []);

  // keep the current chapter's chip in view
  useEffect(() => {
    const row = chips.current;
    const chip = row?.children[idx] as HTMLElement | undefined;
    if (!row || !chip) return;
    row.scrollTo({ left: chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [idx]);

  // centre the 3D subject in the part of the screen the card leaves free (phones)
  useEffect(() => {
    const card = main.current!;
    const row = chips.current!;
    const measure = () => {
      const W = window.innerWidth || 1;
      const H = window.innerHeight || 1;
      const top = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 60;
      const r = card.getBoundingClientRect();
      // wide screens: the card is a compact corner card; only the chip row spans the width
      const coveredFrom = r.width > W * 0.6 ? r.top : row.getBoundingClientRect().top;
      exploreView.frameY = Math.min(0.25, Math.max(0, (H - coveredFrom - top) / 2 / H));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(card);
    ro.observe(row);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // tap elsewhere or Escape closes the part card; arrows switch chapters; space plays/pauses
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!useUI.getState().selection || !t) return;
      // taps on the 3D are handled there (a part selects, empty space closes, a drag keeps it)
      if (t.closest('.ex-pop') || t.tagName === 'CANVAS') return;
      useUI.getState().select(null);
    };
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') useUI.getState().select(null);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const c = CHAPTER_OF_STAGE[useUI.getState().stageId];
        goToChapter((c ? CHAPTERS.indexOf(c) : 0) + (e.key === 'ArrowRight' ? 1 : -1));
      } else if (e.key === ' ' && t?.tagName !== 'BUTTON') {
        e.preventDefault();
        togglePlay();
      }
    };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, []);

  const firstCaption = captionOf(ch, stageId, engine.stage.id === stageId ? engine.player.view.phaseId : STAGE_BY_ID[stageId]?.phases[0]?.id ?? '');

  return (
    <div className="ex">
      <div className="ex-dock">
        <div className="ex-main" ref={main}>
          {hasSelection && <PartPopover />}
          <section className="ex-card" aria-labelledby="ex-title">
            <div className="ex-head">
              <div className="ex-titles">
                <p className="ex-step">
                  Step {idx + 1} of {N}
                </p>
                <h2 id="ex-title">{ch.title}</h2>
              </div>
              <button
                className="ex-play"
                aria-label={playing ? 'Pause' : 'Play'}
                onClick={() => {
                  togglePlay();
                  setPlaying(engine.player.playing);
                }}
              >
                <Icon d={playing ? PAUSE : PLAY} />
              </button>
            </div>
            <p className="ex-now">
              <i aria-hidden />
              <span ref={cap}>{firstCaption}</span>
            </p>
            <p className="ex-more">{ch.explore}</p>
            {(canSeeInside || free) && (
              <div className="ex-actions">
                {canSeeInside && (
                  <button className="btn btn-sm ex-inside" aria-pressed={view === 'cutaway'} onClick={() => useUI.getState().setView(view === 'cutaway' ? 'normal' : 'cutaway')}>
                    <Icon d={EYE} size={18} />
                    See inside
                  </button>
                )}
                {free && (
                  <button className="btn btn-sm ex-recenter" onClick={() => useUI.getState().recenter()}>
                    <Icon d={CENTER} size={18} />
                    Recenter
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
        <nav
          className="ex-chips"
          ref={chips}
          aria-label="Chapters"
          onWheel={(e) => {
            // a mouse wheel scrolls the row sideways
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
          }}
        >
          {CHAPTERS.map((c, i) => (
            <button key={c.id} className="ex-chip" data-ex-chapter={c.id} aria-current={i === idx ? 'step' : undefined} onClick={() => goToChapter(i)}>
              <b>{i + 1}</b>
              {c.title}
            </button>
          ))}
        </nav>
      </div>
      <HoverTip />
    </div>
  );
}
