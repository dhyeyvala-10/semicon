'use client';
/**
 * Living colour grade. Every stage samples its own grade from the journey palette;
 * the driver blends towards it over ~1.5 s and adds a slow organic drift, then
 * publishes the result as CSS custom properties (UI) and linear colours (3D).
 * The overlay applies the grade to the rendered scene with a soft-light wash,
 * a breathing gradient field, a vignette and film grain.
 */
import { useEffect } from 'react';
import { useUI } from '@/lib/store';
import { engine } from '@/simulation/engine';
import { gradeForStage, gradeAt, mixGrade, drift, hex, rgba, lchToLinear, type Grade } from '@/lib/palette';
import { gradeState } from '@/lib/runtime';

export function GradeDriver() {
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let current: Grade = gradeForStage(engine.stage.id);
    const root = document.documentElement;
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      acc += dt;
      const time = now / 1000;
      const ui = useUI.getState();
      let target: Grade;
      if (!ui.started) {
        // the entrance travels slowly through the whole journey palette and back
        const p = (time * 0.018) % 2;
        target = gradeAt(p < 1 ? p : 2 - p);
      } else target = gradeForStage(engine.stage.id, engine.player.view.phaseId);
      current = mixGrade(current, target, 1 - Math.exp(-dt * 1.4));
      if (acc > 1 / 30) {
        acc = 0;
        const g = drift(current, time);
        root.style.setProperty('--accent', hex(g.accent));
        root.style.setProperty('--accent-2', hex(g.accent2));
        root.style.setProperty('--glow', hex(g.glow));
        root.style.setProperty('--deep', hex(g.deep));
        root.style.setProperty('--accent-dim', rgba(g.accent, 0.16));
        root.style.setProperty('--accent-line', rgba(g.accent, 0.5));
        root.style.setProperty('--accent-ink', hex({ l: 0.2, c: 0.04, h: g.accent.h }));
        root.style.setProperty('--deep-a', rgba(g.deep, 0.88));
        root.style.setProperty('--deep-soft', rgba(g.deep, 0.55));
        root.style.setProperty('--data', hex(g.glow));
        root.style.setProperty('--gx', `${50 + 22 * Math.sin(time * 0.05)}%`);
        root.style.setProperty('--gy', `${40 + 18 * Math.cos(time * 0.037)}%`);
        root.style.setProperty('--gx2', `${48 + 26 * Math.cos(time * 0.031 + 1)}%`);
        root.style.setProperty('--gy2', `${62 + 16 * Math.sin(time * 0.043 + 2)}%`);
        gradeState.accent.setRGB(...lchToLinear(g.accent));
        gradeState.glow.setRGB(...lchToLinear(g.glow));
        gradeState.deep.setRGB(...lchToLinear(g.deep));
        gradeState.t = g.t;
        gradeState.version++;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return null;
}

const GRAIN =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0.9 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")";

export function GradeOverlay() {
  return (
    <div className="grade" aria-hidden>
      <div className="grade-wash" />
      <div className="grade-tint" />
      <div className="grade-vignette" />
      <div className="grade-grain" style={{ backgroundImage: GRAIN }} />
    </div>
  );
}
