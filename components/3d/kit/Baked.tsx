'use client';
/**
 * Renders a built kit: one mesh per finish, plus one shadow-only caster for the whole
 * model. Shell parts follow the x-ray / cut-away view modes through the shared material
 * library.
 */
import { useEffect, useMemo } from 'react';
import type { ViewMode } from '@/types';
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

export function Baked({ parts, view = 'normal' }: { parts: BakedPart[]; view?: ViewMode }) {
  const caster = useMemo(() => {
    const g = casterGeometry(parts.filter((p) => p.cast).map((p) => p.geometry));
    return g ? shadowOnly(g) : null;
  }, [parts]);
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
