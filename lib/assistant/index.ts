/**
 * Technical companion (§10, §121). The default provider answers from the local
 * knowledge base (process, machine, sensor, robot, glossary, failure data) and works
 * fully offline. A remote LLM provider can be plugged in later through the same
 * interface; it receives the same structured context.
 */
import type { MachineDef, QuestionKey, Selection, Stage } from '@/types';
import { MACHINE_BY_ID } from '@/data/machines';
import { SENSOR_BY_ID } from '@/data/sensors';
import { ROBOT_BY_ID } from '@/data/robots';
import { GLOSSARY_BY_ID } from '@/data/glossary';
import { FAILURE_BY_ID } from '@/data/failures';
import { MATERIAL_BY_ID } from '@/data/materials';
import { searchIndex } from '@/lib/search';

export interface AssistantContext {
  stage: Stage;
  object: Selection | null;
  cameraMode: string;
  scaleView: string;
  telemetry: { label: string; value: string; status: string }[];
  wafer: { id: string; state: string; stage: string; layers: number };
}

export interface AssistantAnswer {
  question: string;
  paragraphs: string[];
  related?: { label: string; selection?: Selection; stage?: string }[];
  provider: string;
}

export interface AssistantProvider {
  id: string;
  label: string;
  available(): boolean;
  answer(q: QuestionKey | string, ctx: AssistantContext): Promise<AssistantAnswer>;
}

export const QUESTIONS: { key: QuestionKey; label: string }[] = [
  { key: 'what', label: 'What is it?' },
  { key: 'why', label: 'Why is it required?' },
  { key: 'how', label: 'How does it work / move?' },
  { key: 'precision', label: 'Why is precision important?' },
  { key: 'sensors', label: 'What sensors control it?' },
  { key: 'wafer', label: 'How does it interact with the wafer?' },
  { key: 'failure', label: 'What happens if it fails?' },
];

function machineOf(ctx: AssistantContext): MachineDef | undefined {
  const sel = ctx.object;
  if (sel?.kind === 'machine') return MACHINE_BY_ID[sel.id];
  if (sel?.machine) return MACHINE_BY_ID[sel.machine];
  return ctx.stage.machine ? MACHINE_BY_ID[ctx.stage.machine] : undefined;
}

function subjectName(ctx: AssistantContext): string {
  const s = ctx.object;
  if (!s) return ctx.stage.title;
  return s.label ?? s.id;
}

/** Answers a structured question from local data — deterministic, offline. */
function localAnswer(key: QuestionKey, ctx: AssistantContext): string[] {
  const sel = ctx.object;
  const m = machineOf(ctx);
  const stage = ctx.stage;

  // object-specific knowledge first
  if (sel?.kind === 'sensor') {
    const s = SENSOR_BY_ID[sel.id];
    if (s) {
      const reading = ctx.telemetry.find((t) => sel.meta?.channel && t.label);
      switch (key) {
        case 'what':
          return [`${s.name}: ${s.measures}`, `Used in: ${s.where}`];
        case 'why':
        case 'precision':
          return [s.why];
        case 'how':
          return [s.measures, `Unit: ${s.unit}. Its reading is closed-loop: the controller compares it with the set-point and adjusts an actuator.`];
        case 'sensors':
          return [`This is itself a sensor (${s.type}). ${reading ? `Current simulated reading is shown in the DATA tab.` : ''}`];
        case 'wafer':
          return [`It does not touch the wafer; it observes the process condition that determines what happens to the wafer. ${s.why}`];
        case 'failure':
          return [`A drifting or failed ${s.name.toLowerCase()} makes the controller hold the wrong real condition. Redundant sensors, calibration schedules and cross-checks against metrology catch this.`];
      }
    }
  }
  if (sel?.kind === 'robot') {
    const r = ROBOT_BY_ID[sel.id];
    if (r) {
      switch (key) {
        case 'what':
          return [`${r.name} — ${r.category}.`, r.task];
        case 'why':
          return [r.task, 'Automation keeps wafers away from people (the largest particle source) and makes every handling step repeatable.'];
        case 'how':
          return [r.mechanism, r.movement];
        case 'precision':
          return ['Wafers must be placed onto lift pins, chucks or slots without scraping or tilting; misplacement causes particles, breakage or process non-uniformity.', r.movement];
        case 'sensors':
          return [`Sensors: ${r.sensors.map((x) => SENSOR_BY_ID[x]?.name ?? x).join(', ')}.`, r.controller];
        case 'wafer':
          return [r.task, `Interacts with: ${r.interacts.map((x) => MACHINE_BY_ID[x]?.name ?? x).join(', ')}.`];
        case 'failure':
          return [FAILURE_BY_ID['robot-transfer'].effect, FAILURE_BY_ID['robot-transfer'].detection, FAILURE_BY_ID['robot-transfer'].dispositionText];
      }
    }
  }
  if (sel?.kind === 'glossary') {
    const g = GLOSSARY_BY_ID[sel.id];
    if (g) return [g.short, ...(g.long ? [g.long] : [])];
  }
  if (sel?.kind === 'material') {
    const mat = MATERIAL_BY_ID[sel.id];
    if (mat) return [`${mat.name}${mat.formula ? ` (${mat.formula})` : ''}: ${mat.use}`];
  }
  if (sel?.kind === 'component' && m) {
    const c = m.components.find((x) => x.id === sel.id);
    if (c) {
      switch (key) {
        case 'what':
          return [`${c.name} — part of the ${m.name}.`, c.description];
        case 'why':
          return [c.description, `Without it the ${m.name.toLowerCase()} could not: ${m.purpose.toLowerCase()}`];
        case 'how':
          return [c.description, m.principle];
        default:
          break;
      }
    }
  }

  // machine / stage knowledge
  if (m) {
    const q = m.qa?.[key];
    switch (key) {
      case 'what':
        return [q ?? `${m.name} — ${m.category}. ${m.purpose}`, `Inputs: ${m.inputs.join(', ')}. Outputs: ${m.outputs.join(', ')}.`];
      case 'why':
        return [q ?? stage.why, ...(q ? [stage.why] : [])];
      case 'how':
        return [q ?? m.principle, `Sequence: ${m.sequence.join(' → ')}.`];
      case 'precision':
        return [q ?? `The result depends on tightly controlled conditions: ${m.parameters.map((p) => `${p.label} ${p.value}`).join('; ') || 'temperature, pressure, flow and position'}. Small deviations change film thickness, line width or alignment across hundreds of dies at once.`];
      case 'sensors':
        return [q ?? `Representative sensors: ${m.sensors.map((s) => SENSOR_BY_ID[s]?.name ?? s).join(', ')}.`, 'Each feeds a closed control loop: sensor → controller → actuator → process → sensor.'];
      case 'wafer':
        return [q ?? `${m.robotics}`, `The wafer enters as: ${m.inputs[0]}. It leaves as: ${m.outputs[0]}.`];
      case 'failure': {
        const f = (stage.failures ?? []).map((id) => FAILURE_BY_ID[id]).find(Boolean);
        return [q ?? (f ? `${f.title}: ${f.effect}` : 'Equipment faults raise an alarm, stop the process and hold the wafer; the lot is reviewed before it continues.'), ...(f ? [`Detection: ${f.detection}`, `Response: ${f.dispositionText}`] : []), `Maintenance: ${m.maintenance}`];
      }
    }
  }
  switch (key) {
    case 'what':
      return [stage.summary];
    case 'why':
      return [stage.why];
    case 'how':
      return [stage.how];
    case 'precision':
      return [`${stage.how}`, 'At these scales every deviation is multiplied across billions of structures and hundreds of dies.'];
    case 'sensors':
      return ['This stage is shown as a conceptual model; see the machines involved for their sensors.'];
    case 'wafer':
      return [`Before: ${stage.before}. After: ${stage.after}.`];
    case 'failure':
      return ['If this step deviates, inspection and metrology downstream detect it; wafers are reworked where possible or scrapped.'];
  }
  return [stage.summary];
}

export const LocalKnowledgeProvider: AssistantProvider = {
  id: 'local',
  label: 'LOCAL KNOWLEDGE BASE · OFFLINE',
  available: () => true,
  async answer(q, ctx) {
    const known = ['what', 'why', 'how', 'precision', 'sensors', 'wafer', 'failure'].includes(q as string);
    if (known) {
      const label = q === 'how' && ctx.object?.kind === 'robot' ? 'How does it move?' : `${QUESTIONS.find((x) => x.key === q)?.label}`;
      return { question: `${label} — ${subjectName(ctx)}`, paragraphs: localAnswer(q as QuestionKey, ctx), provider: this.label };
    }
    // free text: retrieve from the search index
    const hits = (await searchIndex(q as string)).slice(0, 4);
    if (!hits.length) {
      return {
        question: q as string,
        paragraphs: ['No matching entry in the local knowledge base. Try a term such as “etch”, “overlay”, “FOUP” or “annealing”.'],
        provider: this.label,
      };
    }
    return {
      question: q as string,
      paragraphs: hits.map((h) => `${h.title}: ${h.text}`),
      related: hits.map((h) => ({ label: h.title, selection: h.selection, stage: h.stage })),
      provider: this.label,
    };
  },
};

/**
 * Placeholder for an optional remote assistant. Disabled unless an endpoint is
 * configured; the core experience never depends on it.
 */
export const RemoteProvider: AssistantProvider = {
  id: 'remote',
  label: 'REMOTE ASSISTANT (not configured)',
  available: () => typeof process !== 'undefined' && !!process.env.NEXT_PUBLIC_ASSISTANT_ENDPOINT,
  async answer(q, ctx) {
    const url = process.env.NEXT_PUBLIC_ASSISTANT_ENDPOINT!;
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q, context: ctx }) });
    const data = (await res.json()) as { answer: string };
    return { question: String(q), paragraphs: [data.answer], provider: 'REMOTE' };
  },
};

export function provider(): AssistantProvider {
  return RemoteProvider.available() ? RemoteProvider : LocalKnowledgeProvider;
}
