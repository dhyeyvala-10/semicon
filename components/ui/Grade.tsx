'use client';
/**
 * Living colour grade for the 3D world. Every stage samples its own grade from the journey
 * palette; the driver blends towards it over ~1.5 s and adds a slow organic drift. The 3D
 * lights and fog read the linear colours (cheap, no DOM). The interface does not follow the
 * grade: it uses the one fixed accent from app/tokens.css, so nothing restyles the page.
 */
import { useEffect } from 'react';
import { engine } from '@/simulation/engine';
import { gradeForStage, mixGrade, drift, lchToLinear, type Grade } from '@/lib/palette';
import { gradeState } from '@/lib/runtime';

const GL_HZ = 30;

export function GradeDriver() {
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let accGl = 0;
    let current: Grade = gradeForStage(engine.stage.id);
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      accGl += dt;
      const time = now / 1000;
      // the story and Explore both drive the engine's stage, so the grade follows it in both
      const target = gradeForStage(engine.stage.id, engine.player.view.phaseId);
      current = mixGrade(current, target, 1 - Math.exp(-dt * 1.4));
      if (accGl > 1 / GL_HZ) {
        accGl = 0;
        const g = drift(current, time);
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

/** At most a subtle static vignette (wide screens only, see globals.css): one plain alpha layer, nothing animated over the canvas. */
export function GradeOverlay() {
  return <div className="grade" aria-hidden />;
}
