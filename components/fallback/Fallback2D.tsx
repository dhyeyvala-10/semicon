'use client';
/**
 * The no-3D path: shown when WebGL is unavailable (or with ?mode=2d). The same 13 chapters as
 * the scroll story, as a plain page that reads well on any device.
 */
import { CHAPTERS } from '@/data/chapters';

export function Fallback2D() {
  return (
    <main className="fallback">
      <div className="fb-wrap">
        <header className="fb-hero">
          <h1>How a computer chip is made</h1>
          <p>Follow ordinary sand on its way to becoming the chip inside your computer, one simple step at a time.</p>
          <p className="fb-note">This device cannot show the 3D view, so here is the short version in words.</p>
        </header>
        <ol className="fb-list">
          {CHAPTERS.map((ch, i) => (
            <li className="fb-ch" key={ch.id}>
              <p className="st-step">
                Step {i + 1} of {CHAPTERS.length}
              </p>
              <h2>{ch.title}</h2>
              <p className="fb-line">{ch.line}</p>
              <ul className="fb-steps">
                {Object.entries(ch.captions).map(([k, text]) => (
                  <li key={k}>{text}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
        <p className="fb-end">That is how a chip is made: from sand to a working computer in {CHAPTERS.length} steps.</p>
      </div>
    </main>
  );
}
