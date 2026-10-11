'use client';
/**
 * Living colour grade. Every stage samples its own grade from the journey palette;
 * the driver blends towards it over ~1.5 s and adds a slow organic drift.
 * The 3D lights and fog read the linear colours every frame (cheap, no DOM). The UI
 * gets CSS custom properties at a few hertz, and only when a value actually changes:
 * writing variables on the root element restyles the whole document.
 */
import { useEffect } from 'react';
import { useUI } from '@/lib/store';
import { engine } from '@/simulation/engine';
import { gradeForStage, gradeAt, mixGrade, drift, hex, rgba, lchToLinear, type Grade } from '@/lib/palette';
import { gradeState } from '@/lib/runtime';

const CSS_HZ = 4;
const GL_HZ = 30;

export function GradeDriver() {
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let accGl = 0;
    let accCss = 1;
    let current: Grade = gradeForStage(engine.stage.id);
    const root = document.documentElement;
    const written = new Map<string, string>();
    const put = (k: string, v: string) => {
      if (written.get(k) === v) return;
      written.set(k, v);
      root.style.setProperty(k, v);
    };
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      accGl += dt;
      accCss += dt;
      const time = now / 1000;
      const ui = useUI.getState();
      let target: Grade;
      if (!ui.started) {
        // the entrance travels slowly through the whole journey palette and back
        const p = (time * 0.018) % 2;
        target = gradeAt(p < 1 ? p : 2 - p);
      } else target = gradeForStage(engine.stage.id, engine.player.view.phaseId);
      current = mixGrade(current, target, 1 - Math.exp(-dt * 1.4));
      if (accGl > 1 / GL_HZ) {
        accGl = 0;
        const g = drift(current, time);
        gradeState.accent.setRGB(...lchToLinear(g.accent));
        gradeState.glow.setRGB(...lchToLinear(g.glow));
        gradeState.deep.setRGB(...lchToLinear(g.deep));
        gradeState.t = g.t;
        gradeState.version++;
        if (accCss > 1 / CSS_HZ) {
          accCss = 0;
          put('--accent', hex(g.accent));
          put('--accent-2', hex(g.accent2));
          put('--glow', hex(g.glow));
          put('--deep', hex(g.deep));
          put('--accent-dim', rgba(g.accent, 0.16));
          put('--accent-line', rgba(g.accent, 0.5));
          put('--accent-ink', hex({ l: 0.2, c: 0.04, h: g.accent.h }));
          put('--deep-a', rgba(g.deep, 0.88));
          put('--deep-soft', rgba(g.deep, 0.55));
          put('--data', hex(g.glow));
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return null;
}

/** Static vignette plus the data-mode dimmer — plain alpha layers, nothing animated over the canvas. */
export function GradeOverlay() {
  return (
    <div className="grade" aria-hidden>
      <div className="grade-vignette" />
      <div className="grade-dim" />
    </div>
  );
}
