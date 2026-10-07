'use client';
import { useEffect, useRef } from 'react';
import { useUI } from '@/lib/store';
import { JOURNEY, JOURNEY_LENGTH, MACRO_LABEL, STAGE_BY_ID } from '@/data/process';

/** Persistent factory-position indicator (§6). */
export function ProcessRail() {
  const stageId = useUI((s) => s.stageId);
  const open = useUI((s) => s.railOpen);
  const toggle = useUI((s) => s.toggle);
  const go = useUI((s) => s.goToStage);
  const cur = JOURNEY.findIndex((s) => s.id === stageId);
  const stage = STAGE_BY_ID[stageId];
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.querySelector('.rail-item.cur') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [stageId]);

  let lastMacro = '';
  return (
    <aside className={`rail ${open ? '' : 'collapsed'}`}>
      <div className="rail-head">
        <div>
          <div className="cap">{cur >= 0 ? MACRO_LABEL[stage.macro] : 'EXPLORE'}</div>
          <div className="rail-progress">
            {cur >= 0 ? String(cur + 1).padStart(2, '0') : '—'} <small>/ {JOURNEY_LENGTH}</small>
          </div>
        </div>
        <button className="btn icon sm" onClick={() => toggle('railOpen')} title={open ? 'Collapse' : 'Expand process indicator'}>
          {open ? '‹' : '›'}
        </button>
      </div>
      <div className="rail-bar">
        <div style={{ width: `${cur >= 0 ? ((cur + 1) / JOURNEY_LENGTH) * 100 : 0}%` }} />
      </div>
      <div className="rail-mini">
        {cur >= 0 ? `${MACRO_LABEL[stage.macro]} · ${String(cur + 1).padStart(2, '0')}/${JOURNEY_LENGTH}` : stage.short.toUpperCase()}
      </div>
      <div className="rail-list" ref={listRef}>
        {JOURNEY.map((s, i) => {
          const header = s.macro !== lastMacro;
          lastMacro = s.macro;
          const first = JOURNEY.findIndex((x) => x.macro === s.macro);
          return (
            <div key={s.id}>
              {header && (
                <div className="rail-group">
                  <span>{MACRO_LABEL[s.macro]}</span>
                  <span>{String(first + 1).padStart(2, '0')}</span>
                </div>
              )}
              <button className={`rail-item ${s.id === stageId ? 'cur' : ''} ${cur >= 0 && i < cur ? 'done' : ''}`} onClick={() => go(s.id)} title={s.title}>
                <span className="n">{String(i + 1).padStart(2, '0')}</span>
                <span>{s.short}</span>
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
