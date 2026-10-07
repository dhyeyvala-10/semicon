/**
 * Global technical search (§101) over every local data module.
 * Searching “etch” returns the etch stages, etch chamber, dry/wet etch terms,
 * etch gases, OES endpoint sensor, comparisons and failure scenarios.
 */
import type { Selection } from '@/types';
import { STAGES } from '@/data/process';
import { MACHINES } from '@/data/machines';
import { ROBOTS } from '@/data/robots';
import { SENSORS } from '@/data/sensors';
import { MATERIALS } from '@/data/materials';
import { GLOSSARY } from '@/data/glossary';
import { COMPARISONS } from '@/data/comparisons';
import { FAILURES } from '@/data/failures';
import { BAYS } from '@/data/fabLayout';

export type DocType = 'STAGE' | 'MACHINE' | 'COMPONENT' | 'ROBOT' | 'SENSOR' | 'MATERIAL' | 'TERM' | 'COMPARISON' | 'FAILURE' | 'LOCATION';

export interface Doc {
  type: DocType;
  id: string;
  title: string;
  text: string;
  body: string;
  stage?: string;
  selection?: Selection;
  overlay?: string;
}

let INDEX: Doc[] | null = null;

export function buildIndex(): Doc[] {
  if (INDEX) return INDEX;
  const docs: Doc[] = [];
  for (const s of STAGES) {
    docs.push({ type: 'STAGE', id: s.id, title: s.title, text: s.summary, body: `${s.short} ${s.summary} ${s.why} ${s.how} ${s.location}`, stage: s.id });
  }
  for (const m of MACHINES) {
    docs.push({ type: 'MACHINE', id: m.id, title: m.name, text: m.purpose, body: `${m.category} ${m.purpose} ${m.principle} ${m.sequence.join(' ')}`, stage: m.stages[0], selection: { kind: 'machine', id: m.id, label: m.name } });
    for (const c of m.components) {
      docs.push({ type: 'COMPONENT', id: `${m.id}:${c.id}`, title: `${c.name} · ${m.name}`, text: c.description, body: `${c.name} ${c.description}`, stage: m.stages[0], selection: { kind: 'component', id: c.id, machine: m.id, label: c.name } });
    }
  }
  for (const r of ROBOTS) docs.push({ type: 'ROBOT', id: r.id, title: r.name, text: r.task, body: `${r.category} ${r.mechanism} ${r.movement} ${r.task}`, stage: r.stage, selection: { kind: 'robot', id: r.id, label: r.name } });
  for (const s of SENSORS) docs.push({ type: 'SENSOR', id: s.id, title: s.name, text: s.measures, body: `${s.type} ${s.measures} ${s.why} ${s.where}`, selection: { kind: 'sensor', id: s.id, label: s.name } });
  for (const m of MATERIALS) docs.push({ type: 'MATERIAL', id: m.id, title: `${m.name}${m.formula ? ` (${m.formula})` : ''}`, text: m.use, body: `${m.category} ${m.use} ${m.formula ?? ''}`, stage: m.stages[0], selection: { kind: 'material', id: m.id, label: m.name } });
  for (const g of GLOSSARY) docs.push({ type: 'TERM', id: g.id, title: g.term, text: g.short, body: `${(g.aka ?? []).join(' ')} ${g.short} ${g.long ?? ''}`, stage: g.stage, selection: { kind: 'glossary', id: g.id, label: g.term } });
  for (const c of COMPARISONS) docs.push({ type: 'COMPARISON', id: c.id, title: c.title, text: c.columns.join(' vs '), body: `${c.title} ${c.rows.map((r) => `${r.label} ${r.values.join(' ')}`).join(' ')}`, stage: c.stage, overlay: 'compare' });
  for (const f of FAILURES) docs.push({ type: 'FAILURE', id: f.id, title: `What if: ${f.title}`, text: f.effect, body: `${f.cause} ${f.effect} ${f.detection} ${f.dispositionText}`, stage: f.stage, overlay: 'failures' });
  for (const b of BAYS) docs.push({ type: 'LOCATION', id: b.id, title: b.name, text: 'Fab bay', body: `${b.name} ${b.type}`, stage: b.stage });
  INDEX = docs;
  return docs;
}

const tok = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9₀-₉µ\-+ ]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean);

export function search(q: string, limit = 40): Doc[] {
  const docs = buildIndex();
  const terms = tok(q);
  if (!terms.length) return [];
  const scored: { d: Doc; s: number }[] = [];
  for (const d of docs) {
    const title = d.title.toLowerCase();
    const body = d.body.toLowerCase();
    let s = 0;
    let all = true;
    for (const t of terms) {
      let hit = 0;
      if (title === t) hit += 20;
      if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(title)) hit += 8;
      else if (title.includes(t)) hit += 4;
      if (body.includes(t)) hit += 1 + Math.min(3, body.split(t).length - 2);
      if (!hit) all = false;
      s += hit;
    }
    if (s > 0 && all) scored.push({ d, s: s + (d.type === 'STAGE' || d.type === 'MACHINE' ? 1 : 0) });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.d);
}

export async function searchIndex(q: string) {
  return search(q, 10);
}
