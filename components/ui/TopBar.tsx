'use client';
/**
 * One minimal bar for both modes: the logo (back to the story) and one button.
 * Story: "Explore" opens the free 3D view at the current step. Explore: "Back to story".
 */
import { useUI } from '@/lib/store';
import { enterExplore } from '../story/Story';
import { Logo } from '../story/Logo';

/** Return from Explore to the scroll story; in the story, go back to its start. */
function toStory() {
  const ui = useUI.getState();
  if (ui.started) ui.set({ started: false, selection: null });
  else document.querySelector('.st-scroll, .fallback')?.scrollTo({ top: 0 });
}

export function TopBar() {
  const started = useUI((s) => s.started);
  const fallback = useUI((s) => s.fallback2D);
  return (
    <header className="topbar">
      <button className="brand" onClick={toStory} aria-label={started ? 'FAB/TWIN, back to the story' : 'FAB/TWIN, back to the start'}>
        <Logo />
      </button>
      {fallback ? null : started ? (
        <button className="btn btn-sm story-back" onClick={toStory}>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden focusable="false">
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to story
        </button>
      ) : (
        <button className="btn btn-sm story-explore" onClick={() => enterExplore()}>
          Explore
        </button>
      )}
    </header>
  );
}
