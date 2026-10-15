'use client';
/**
 * Renders a built kit: one mesh per finish, plus one shadow-only caster for the whole
 * model (only where shadow maps are on). Shell parts follow the x-ray / cut-away view modes
 * through the shared material library.
 */
import { useEffect, useMemo } from 'react';
import type { ViewMode } from '@/types';
import { getQuality } from '@/lib/quality';
import { shell } from '../materials';
import { Kit, type BakedPart } from './build';
import { casterGeometry, shadowOnly } from './shadow';

/** Build a static model once (per deps) and free its geometry on unmount. */
export function useKit(fn: (k: Kit) => void, deps: unknown[] = []): BakedPart[] {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const parts = useMemo(() => {
    const k = new Kit();
    fn(k);
    return k.build();
  }, deps);
  useEffect(() => () => parts.forEach((p) => p.geometry.dispose()), [parts]);
  return parts;
}

/* ------------------------------------------------------------ kept builds */

interface Held {
  value: unknown;
  dispose: () => void;
  /** mounted users */
  refs: number;
  /** scene change it was last used in */
  gen: number;
}
const held = new Map<string, Held>();
let gen = 0;

/** Idle builds of this many previously visited scenes stay ready (phones keep one: scrolling back a chapter). */
const keepScenes = () => (getQuality().mobile ? 1 : 3);

/** Called by the scene switcher whenever the active scene changes: frees builds idle for too long. */
export function kitSceneChanged() {
  gen++;
  for (const [k, h] of held)
    if (h.refs <= 0 && gen - h.gen > keepScenes()) {
      h.dispose();
      held.delete(k);
    }
}

/**
 * Build something expensive once per `key` and keep it across scene visits (going back to a
 * scene does not rebuild it). Freed a few scene changes after its last user unmounted.
 */
export function useCached<T>(key: string, build: () => T, dispose: (v: T) => void): T {
  const h = useMemo(() => {
    let x = held.get(key);
    if (!x) {
      const v = build();
      x = { value: v, dispose: () => dispose(v), refs: 0, gen };
      held.set(key, x);
    }
    x.gen = gen;
    return x;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    h.refs++;
    h.gen = gen;
    return () => {
      h.refs--;
      h.gen = gen;
    };
  }, [h]);
  return h.value as T;
}

export function Baked({ parts, view = 'normal' }: { parts: BakedPart[]; view?: ViewMode }) {
  // without shadow maps (phones) no caster is needed
  const shadows = getQuality().shadows;
  const caster = useMemo(() => {
    const g = shadows ? casterGeometry(parts.filter((p) => p.cast).map((p) => p.geometry)) : null;
    return g ? shadowOnly(g) : null;
  }, [parts, shadows]);
  useEffect(() => () => caster?.geometry.dispose(), [caster]);
  return (
    <>
      {parts.map((p, i) => (
        <mesh key={i} geometry={p.geometry} material={p.shell ? shell(p.material, view) : p.material} receiveShadow />
      ))}
      {caster && <primitive object={caster} />}
    </>
  );
}

/** Convenience: build and render in one element. */
export function Model({ build, deps = [], view }: { build: (k: Kit) => void; deps?: unknown[]; view?: ViewMode }) {
  const parts = useKit(build, deps);
  return <Baked parts={parts} view={view} />;
}
