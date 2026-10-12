'use client';
/**
 * The scroll story: the default way through the journey.
 *
 * The page scrolls; the 3D world stays fixed behind it. One section per stage. The
 * section that crosses the reading line becomes the active stage, and the position
 * inside the section scrubs that stage's timeline, so the machines animate with the
 * scroll and the camera glides along the stage's camera cues (see CameraRig).
 *
 * Everything that changes per frame (veil, progress, phase line) is written to the DOM
 * directly from one rAF loop. React only renders the static sections.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useUI } from '@/lib/store';
import { useTicker } from '@/hooks/useTicker';
import { engine } from '@/simulation/engine';
import { JOURNEY, MACRO_LABEL, STAGE_BY_ID } from '@/data/process';
import { JOURNEY_RIBBON, gradeAt, hex, journeyT, rgba } from '@/lib/palette';
import { CHAPTERS, story } from '@/lib/story';
import { prefetchScene } from '@/components/3d/sceneLoaders';
import { DataTag } from '@/components/ui/common';
import { fmt } from '@/lib/math';
import { Glyph } from './Glyph';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const HERO_STAGE = 'fab-overview';
/** Set once the visitor has opened the twin; coming back, the story resumes where they were. */
let visitedTwin = false;
useUI.subscribe((s) => {
  if (s.started) visitedTwin = true;
});

/** Leave the story and open the full twin at a stage. */
export function enterExplore(stageId: string) {
  story.active = false;
  engine.player.driven = false;
  const ui = useUI.getState();
  ui.set({ started: true });
  ui.goToStage(stageId, { autoplay: true });
}

function LiveLine() {
  useTicker(2);
  const f = engine.fab;
  return (
    <span className="live-line">
      FAB 1 NOW · {f.lots.length} lots in process · {fmt(f.utilisation(), 0)}% tools processing · {f.activeAlarms()} alarms <i>SIMULATED</i>
    </span>
  );
}

function Hero({ onJump }: { onJump: (stageId: string) => void }) {
  const segments = useMemo(
    () =>
      JOURNEY_RIBBON.map((r) => {
        const idx = JOURNEY.findIndex((s) => s.id === r.first);
        const g = gradeAt(journeyT(r.first));
        const count = JOURNEY.filter((s) => s.macro === r.macro).length;
        return { ...r, idx, count, color: hex(g.accent), soft: rgba(g.accent, 0.14) };
      }),
    [],
  );
  const ribbon = useMemo(() => `linear-gradient(90deg, ${segments.map((s, i) => `${s.color} ${((i + 0.5) / segments.length) * 100}%`).join(', ')})`, [segments]);
  const words = useMemo(() => [gradeAt(0), gradeAt(0.45), gradeAt(1)].map((g) => `linear-gradient(90deg, ${hex(g.glow)}, ${hex(g.accent)} 60%, ${hex(g.accent2)})`), []);
  return (
    <section className="st-hero landing" data-hero>
      <div className="landing-glow" />
      <div className="landing-main">
        <div className="kicker">
          <span className="pulse" /> FAB/TWIN · A WORKING DIGITAL FACTORY · LIVE SIMULATION
        </div>
        <h1>
          <span style={{ backgroundImage: words[0] }}>From sand</span>
          <span style={{ backgroundImage: words[1] }}>to silicon</span>
          <span style={{ backgroundImage: words[2] }} className="last">
            to system.
            <svg className="scribble" viewBox="0 0 300 24" preserveAspectRatio="none">
              <path d="M4 15 C 60 7, 120 21, 180 12 S 270 6, 296 13" />
            </svg>
          </span>
        </h1>
        <p>
          Follow one grain of quartz as it becomes wafer <b>WF-000184</b>, then chip <b>CH-184-0412</b>, then part of a working computer. Scroll, and the factory runs each step in front of you.
        </p>
        <div className="cta">
          <button className="cta-main" onClick={() => onJump(JOURNEY[0].id)}>
            <span>↓</span> Begin the journey
          </button>
          <button className="cta-link" onClick={() => enterExplore(HERO_STAGE)}>
            Explore the fab freely
          </button>
        </div>
      </div>

      <div className="ribbon-wrap">
        <div className="ribbon-meta">
          <span>EXTRACTION</span>
          <LiveLine />
          <span>SYSTEM</span>
        </div>
        <div className="ribbon">
          {segments.map((s) => (
            <button
              key={s.macro}
              className="seg-card"
              style={{ color: s.color, ['--seg' as string]: s.color, ['--seg-soft' as string]: s.soft }}
              onClick={() => onJump(s.first)}
              title={`Jump to ${JOURNEY[s.idx]?.title}`}
            >
              <div className="seg-glyph">
                <Glyph macro={s.macro} />
              </div>
              <div className="seg-n">
                {String(s.idx + 1).padStart(2, '0')}–{String(s.idx + s.count).padStart(2, '0')}
              </div>
              <div className="seg-label">{s.label}</div>
              <div className="seg-sub">{s.sub}</div>
            </button>
          ))}
        </div>
        <div className="ribbon-bar" style={{ backgroundImage: ribbon }}>
          <div className="ribbon-sheen" />
        </div>
      </div>
    </section>
  );
}

function Chapter({ i }: { i: number }) {
  const ch = CHAPTERS[i];
  const s = ch.stage;
  const fact = s.facts?.find((f) => f.kind === 'REAL') ?? s.facts?.[0];
  const color = hex(gradeAt(journeyT(s.id)).accent);
  return (
    <section className="st-sec" data-i={i} data-stage={s.id} style={{ height: `${ch.length * 100}vh`, ['--seg' as string]: color }}>
      <div className="st-copy">
        {ch.actStart && (
          <div className="st-act">
            <b>ACT {ROMAN[ch.act]}</b> · {MACRO_LABEL[s.macro]}
          </div>
        )}
        <div className="st-num">
          {String(s.num).padStart(2, '0')} / {JOURNEY.length} · {s.location}
        </div>
        <h2>{s.title}</h2>
        <p>{s.summary}</p>
        <div className="st-change">
          <span>{s.before}</span>
          <i>→</i>
          <span>{s.after}</span>
        </div>
        {fact && (
          <div className="st-fact">
            <b>{fact.value}</b>
            <span>{fact.label}</span>
            <DataTag kind={fact.kind} short />
          </div>
        )}
        <button className="st-explore" onClick={() => enterExplore(s.id)}>
          Explore this step <i>›</i>
        </button>
      </div>
    </section>
  );
}

function Outro({ onTop }: { onTop: () => void }) {
  return (
    <section className="st-outro" data-outro>
      <div className="st-copy">
        <div className="st-act">
          <b>END</b> · {JOURNEY.length} STEPS
        </div>
        <h2>From one grain of quartz to a working computer.</h2>
        <p>Every machine you passed is still running. Open the full twin to step through any operation, inject a failure, or read the telemetry behind it.</p>
        <div className="cta">
          <button className="cta-main" onClick={() => enterExplore(HERO_STAGE)}>
            Explore the twin
          </button>
          <button className="cta-link" onClick={onTop}>
            Back to the start
          </button>
          <button className="cta-link" onClick={() => useUI.getState().setOverlay('about')}>
            Data &amp; sources
          </button>
        </div>
      </div>
    </section>
  );
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function Story() {
  const scroller = useRef<HTMLDivElement>(null);
  const veil = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const now = useRef<HTMLDivElement>(null);
  const ticks = useRef<HTMLDivElement>(null);

  /** scroll so a stage's section sits on the reading line */
  const jump = (stageId: string, smooth = true) => {
    const el = scroller.current;
    const i = CHAPTERS.findIndex((c) => c.stage.id === stageId);
    const sec = el?.querySelector<HTMLElement>(`[data-i="${i}"]`);
    if (!el || !sec) return;
    el.scrollTo({ top: sec.offsetTop - el.clientHeight * readLine() + 2, behavior: smooth ? 'smooth' : 'auto' });
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

    // layout: section tops/heights, measured (mobile toolbars change the viewport height)
    type Sec = { top: number; h: number; stage: string; scene: string };
    let secs: Sec[] = [];
    let bounds: number[] = [];
    const measure = () => {
      const hero = el.querySelector<HTMLElement>('[data-hero]')!;
      const outro = el.querySelector<HTMLElement>('[data-outro]')!;
      secs = [{ top: hero.offsetTop, h: hero.offsetHeight, stage: HERO_STAGE, scene: STAGE_BY_ID[HERO_STAGE].scene }];
      el.querySelectorAll<HTMLElement>('[data-i]').forEach((s) => {
        const st = CHAPTERS[Number(s.dataset.i)].stage;
        secs.push({ top: s.offsetTop, h: s.offsetHeight, stage: st.id, scene: st.scene });
      });
      const last = CHAPTERS[CHAPTERS.length - 1].stage;
      secs.push({ top: outro.offsetTop, h: outro.offsetHeight, stage: last.id, scene: last.scene });
      // scene changes are hidden behind the veil
      bounds = [];
      for (let k = 1; k < secs.length; k++) if (secs[k].scene !== secs[k - 1].scene) bounds.push(secs[k].top);
      // act ticks on the progress rail
      const total = Math.max(1, el.scrollHeight - el.clientHeight);
      if (ticks.current)
        ticks.current.querySelectorAll<HTMLElement>('[data-tick]').forEach((t) => {
          const k = CHAPTERS.findIndex((c) => c.stage.id === t.dataset.tick) + 1;
          t.style.top = `${Math.min(100, (100 * Math.max(0, secs[k].top - el.clientHeight * readLine())) / total)}%`;
        });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);

    // resume where the visitor left the story (e.g. coming back from the twin)
    // (a first visit always opens on the hero: the engine starts on the first stage before the store syncs it)
    const ci = visitedTwin ? CHAPTERS.findIndex((c) => c.stage.id === engine.stage.id) : -1;
    if (ci >= 0) {
      const sec = secs[ci + 1];
      el.scrollTop = sec.top - el.clientHeight * readLine() + sec.h * engine.player.view.stageT;
    } else if (engine.stage.id !== HERO_STAGE) useUI.getState().goToStage(HERO_STAGE, { autoplay: true });

    // fetch every scene module in the background so scrolling never waits for code
    let pre = 0;
    const order = [...new Set(CHAPTERS.map((c) => c.stage.scene))];
    const preId = window.setInterval(() => {
      if (pre >= order.length) return window.clearInterval(preId);
      prefetchScene(order[pre++]);
    }, 400);

    let raf = 0;
    let last = performance.now();
    let smooth = el.scrollTop;
    let lastTop = el.scrollTop;
    let vel = 0;
    let veilCur = 1;
    let pending: { stage: string; since: number } | null = null;
    let phaseKey = '';
    let activeK = -1;
    const sections = () => [el.querySelector<HTMLElement>('[data-hero]'), ...el.querySelectorAll<HTMLElement>('[data-i]'), el.querySelector<HTMLElement>('[data-outro]')];
    const loop = (t: number) => {
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      const H = el.clientHeight || 1;
      const top = el.scrollTop;
      smooth += (top - smooth) * (1 - Math.exp(-dt * 7));
      if (Math.abs(top - smooth) < 0.5) smooth = top;
      vel += ((top - lastTop) / Math.max(dt, 1e-3) / H - vel) * 0.25;
      lastTop = top;
      story.velocity = vel;
      const portrait = H > el.clientWidth;
      story.frame.x = portrait ? 0 : 0.15;
      story.frame.y = portrait ? 0.16 : 0;

      // which section is on the reading line
      const line = smooth + H * readLine();
      let k = 0;
      for (let j = 0; j < secs.length; j++) if (line >= secs[j].top) k = j;
      const sec = secs[k];
      const isOutro = k === secs.length - 1;
      const local = isOutro ? 1 : k === 0 ? 0 : Math.min(1, Math.max(0, (line - sec.top) / sec.h));
      const want = sec.stage;
      // only the active chapter's copy is shown; the rest fade out
      if (k !== activeK) {
        const all = sections();
        all[activeK]?.classList.remove('on');
        all[k]?.classList.add('on');
        activeK = k;
      }

      if (want !== engine.stage.id) {
        const sceneChange = STAGE_BY_ID[want].scene !== engine.stage.scene;
        if (!pending || pending.stage !== want) pending = { stage: want, since: t };
        // within a scene, switch at once; across scenes wait until the scroll settles a little
        if (!sceneChange || (t - pending.since > 120 && Math.abs(vel) < 2.5)) {
          useUI.getState().goToStage(want, { autoplay: true });
          if (sceneChange) story.cut = true;
          pending = null;
        }
      } else pending = null;
      if (engine.stage.id === want && k > 0) engine.player.scrub(local);
      story.local = local;

      // veil: dark across scene boundaries, while waiting, and until the new scene has rendered
      let near = 0;
      for (const b of bounds) near = Math.max(near, 1 - smoothstep(0, H * 0.2, Math.abs(line - b)));
      const loading = !useUI.getState().loadedScenes.includes(engine.stage.scene);
      const target = Math.max(near, pending ? 1 : 0, loading ? 1 : 0);
      veilCur += (target - veilCur) * (1 - Math.exp(-dt * (target > veilCur ? 16 : 6)));
      story.veil = veilCur;
      if (veil.current) veil.current.style.opacity = veilCur.toFixed(3);

      const total = Math.max(1, el.scrollHeight - H);
      if (bar.current) bar.current.style.transform = `${portrait ? 'scaleX' : 'scaleY'}(${Math.min(1, smooth / total).toFixed(4)})`;

      // the operation running right now
      const v = engine.player.view;
      const key = k === 0 ? 'hero' : `${engine.stage.id}:${v.phaseIndex}`;
      if (key !== phaseKey && now.current) {
        phaseKey = key;
        if (k === 0 || isOutro) now.current.style.opacity = '0';
        else {
          const n = engine.stage.phases.length;
          now.current.style.opacity = '1';
          now.current.innerHTML = '';
          const b = document.createElement('b');
          b.textContent = `${String(v.phaseIndex + 1).padStart(2, '0')}/${String(n).padStart(2, '0')}`;
          const l = document.createElement('span');
          l.textContent = v.phase.caption ? `${v.phase.label} — ${v.phase.caption}` : v.phase.label;
          now.current.append(b, l);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(preId);
      ro.disconnect();
      story.active = false;
      engine.player.driven = false;
    };
  }, []);

  return (
    <>
      <div className="st-scrim" aria-hidden />
      <div className="st-veil" ref={veil} aria-hidden />
      <div className="st-scroll" ref={scroller} tabIndex={-1}>
        <Hero onJump={jump} />
        {CHAPTERS.map((c) => (
          <Chapter key={c.stage.id} i={c.index} />
        ))}
        <Outro onTop={() => scroller.current?.scrollTo({ top: 0, behavior: 'smooth' })} />
      </div>
      <div className="st-now" ref={now} aria-live="off" />
      <div className="st-rail" ref={ticks} aria-hidden>
        <div className="st-rail-fill" ref={bar} />
        {JOURNEY_RIBBON.map((r) => (
          <button key={r.macro} data-tick={r.first} title={r.label} onClick={() => jump(r.first)}>
            <span>{r.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/** Reading line as a fraction of the viewport height; lower on phones, where the text sits at the bottom. */
function readLine() {
  return typeof window !== 'undefined' && window.innerHeight > window.innerWidth ? 0.62 : 0.5;
}
