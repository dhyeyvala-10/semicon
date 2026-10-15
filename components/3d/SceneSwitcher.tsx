'use client';
/**
 * Scene management: each scene is a separate dynamically imported module and only the
 * active scene is mounted.
 *
 * A scene change must not block the main thread. Profiled on a phone, most of the old freeze
 * was the first draw waiting for the new scene's shader programs to compile. So a new scene
 * is brought on screen in steps, all while the story veil covers the canvas:
 *  1. it is mounted in a React transition while drawing is held (the last frame stays on the
 *     canvas);
 *  2. its shader programs compile in the background (`Compile`) and its textures are
 *     uploaded a few per frame;
 *  3. it is drawn for two frames, then reported as loaded (useUI.loadedScenes, which the veil
 *     waits for).
 * Objects that appear later (a new stage of the same scene, "See inside") are compiled the
 * same way and left out of the draw until their programs are ready (`beforeDraw`). The code
 * of the next chapters' scenes is fetched when idle.
 */
import { Suspense, lazy, startTransition, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { SCENE_LOADERS, prefetchScene, type SceneProps } from './sceneLoaders';
import type { SceneId } from '@/types';
import { useUI } from '@/lib/store';
import { STAGE_BY_ID } from '@/data/process';
import { CHAPTERS } from '@/data/chapters';
import { tracked } from '@/lib/runtime';
import { kitSceneChanged } from './kit/Baked';

export type { SceneProps };
export { SCENE_LOADERS, prefetchScene };

const LAZY = Object.fromEntries(Object.entries(SCENE_LOADERS).map(([k, l]) => [k, lazy(l)])) as unknown as Record<SceneId, ComponentType<SceneProps>>;

/**
 * While `hold` > 0 the renderer (Stage3D) does not draw. `since` is when the last scene
 * change started or ended, so frame-rate measurements can skip it. `warm`: the next draw
 * also draws the scene's hidden objects (still under the veil), so the programs only a draw
 * makes (shadow-map depth programs) and their geometry uploads are done before the veil lifts.
 */
export const renderGate = { hold: 0, since: 0, warm: false };

/** Diagnostics (window.fabTwin.sceneLoad, sceneLog, lateLoad). */
export const sceneLoad = { id: '', mode: '', /** stage change → scene mounted */ mountMs: 0, programs: 0, textures: 0, /** mounted → loaded, and its parts */ ms: 0, compileMs: 0, uploadMs: 0, drawMs: 0 };
export const sceneLog: (typeof sceneLoad)[] = [];
/** Objects compiled after their scene was loaded; `inDraw` counts programs still compiled inside a draw (Stage3D). */
export const lateLoad = { scans: 0, batches: 0, programs: 0, inDraw: 0, inDrawLog: [] as string[] };
let switchAt = 0;

/* ------------------------------------------------------------ code prefetch */

/** The order scenes are met in the story: the landing fab, then one scene per chapter. */
const STORY_SCENES: SceneId[] = (() => {
  const out: SceneId[] = ['fab'];
  for (const c of CHAPTERS) {
    const s = STAGE_BY_ID[c.stages[0]]?.scene;
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
})();

const idle = (fn: () => void, timeout: number) => {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout });
  else window.setTimeout(fn, 200);
};

/** Fetch (download + evaluate) the code of the scenes next to this one in the story, when idle. */
function prefetchNeighbours(id: SceneId) {
  const i = STORY_SCENES.indexOf(id);
  const queue = (i >= 0 ? [...STORY_SCENES.slice(i + 1, i + 3), ...(i > 0 ? [STORY_SCENES[i - 1]] : [])] : STORY_SCENES.slice(0, 2)).filter((s) => s !== id);
  const run = () => {
    const s = queue.shift();
    if (!s) return;
    prefetchScene(s);
    idle(run, 3000);
  };
  idle(run, 1500);
}

/* ------------------------------------------------------------ background compile */

type Mat = THREE.Material;
/** A three.js shader program (WebGLProgram): reading its uniforms waits until it is compiled. */
type Program = { isReady(): boolean; getUniforms(): unknown; getAttributes(): unknown; usedTimes: number };

const matsOf = (o: THREE.Object3D): Mat[] => {
  const m = (o as THREE.Mesh).material as Mat | Mat[] | undefined;
  return !m ? [] : Array.isArray(m) ? m : [m];
};

/** Main-thread time per frame for issuing compiles, reading programs back and uploading textures. */
const SLICE_MS = 6;
/** Programs per fence without KHR_parallel_shader_compile (a few, so the command buffer never fills up and blocks). */
const BATCH = 6;
/** Stop waiting after this long without progress (lost context, a driver that never signals): the draw then finishes the compile. */
const STALL_MS = 60000;

/**
 * Compiles the shader programs of some objects without blocking the main thread.
 *  - With KHR_parallel_shader_compile, every program is issued (a time slice per frame), the
 *    GPU compiles them in the background, and each is read back once it reports ready.
 *  - Without it, asking a program anything waits for its compile. But the GPU process runs
 *    commands in order, so a fence issued after a few compiles signals once they are done,
 *    and polling a fence never blocks. The batch is then read back and the next one issued.
 * Reading a program back (its uniform and attribute locations) is what its first draw would
 * otherwise do, waiting for the compile. `sweep` (an object or the scene) is compiled as a
 * whole at the end: it issues any program variant the per-object pass did not.
 */
class Compile {
  private queue: THREE.Object3D[];
  private pending: Program[] = [];
  private fence: WebGLSync | null = null;
  private moved = performance.now();
  programs = 0;

  constructor(
    objects: THREE.Object3D[],
    private sweep: THREE.Object3D | null,
  ) {
    this.queue = objects.slice().reverse();
  }

  /** Move forward (once per frame). True when every program is compiled and read back. */
  step(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): boolean {
    const ctx = gl.getContext() as WebGL2RenderingContext;
    const parallel = gl.extensions.has('KHR_parallel_shader_compile');
    const t0 = performance.now();
    // read back what is done
    if (this.fence) {
      if (ctx.clientWaitSync(this.fence, 0, 0) !== ctx.TIMEOUT_EXPIRED) {
        ctx.deleteSync(this.fence);
        this.fence = null;
      } else ctx.flush(); // (Chrome updates a fence's status only when commands are flushed; with drawing held there are none)
    }
    while (this.pending.length && !this.fence && performance.now() - t0 < SLICE_MS) {
      const p = this.pending[0];
      if (parallel && p.usedTimes > 0 && !p.isReady()) break;
      this.pending.shift();
      // (a program released meanwhile is gone)
      if (p.usedTimes > 0) {
        p.getUniforms();
        p.getAttributes();
      }
      this.moved = performance.now();
    }
    if (this.pending.length && t0 - this.moved > STALL_MS) {
      // never done: left to the draw
      if (this.fence) ctx.deleteSync(this.fence);
      this.fence = null;
      this.pending.length = 0;
      this.queue.length = 0;
      this.sweep = null;
    }
    if (this.pending.length && !parallel) return false;
    // issue more: with the extension as much as fits in the slice, without it the next batch
    const list = (gl.info.programs ?? []) as unknown as Program[];
    let fresh = 0;
    const issue = (o: THREE.Object3D) => {
      const n = list.length;
      gl.compile(o, camera, scene);
      for (let i = n; i < list.length; i++) this.pending.push(list[i]);
      fresh += list.length - n;
    };
    while (this.queue.length && (parallel || fresh < BATCH) && performance.now() - t0 < SLICE_MS) issue(this.queue.pop()!);
    if (!this.queue.length && !this.pending.length && this.sweep) {
      issue(this.sweep);
      this.sweep = null;
    }
    if (fresh) {
      this.programs += fresh;
      this.moved = performance.now();
      if (!parallel) this.fence = ctx.fenceSync(ctx.SYNC_GPU_COMMANDS_COMPLETE, 0);
      ctx.flush();
    }
    return !this.queue.length && !this.pending.length && !this.sweep;
  }
}

/* ------------------------------------------------------------ what needs compiling */

/*
 * A shader program depends on the material (and its version: needsUpdate may need another
 * program), a few properties of the object, and the lights of the scene. Materials are
 * remembered per variant once issued; a light added or removed changes every program.
 */
let issued = new Set<string>();
let issuedLights = '';

function variant(o: THREE.Object3D, m: Mat): string {
  const mesh = o as THREE.InstancedMesh;
  const a = mesh.geometry?.attributes;
  // transparent double-sided materials are drawn (and compiled) in two passes that bump their version each time
  const v = m.transparent && m.side === THREE.DoubleSide && !m.forceSinglePass ? 0 : m.version;
  return `${m.uuid}.${v}|${mesh.isInstancedMesh ? (mesh.instanceColor ? 2 : 1) : 0}|${a?.color ? 1 : 0}|${o.receiveShadow ? 1 : 0}`;
}

/** Light counts by kind (part of every program). */
function lightsKey(scene: THREE.Scene): string {
  const n: Record<string, number> = {};
  scene.traverseVisible((o) => {
    const l = o as THREE.Light;
    if (l.isLight) n[l.type + (l.castShadow ? '+s' : '')] = (n[l.type + (l.castShadow ? '+s' : '')] ?? 0) + 1;
  });
  return Object.keys(n)
    .sort()
    .map((k) => k + n[k])
    .join(',');
}

const hasLight = (o: THREE.Object3D) => {
  let found = false;
  o.traverse((c) => void (found ||= (c as THREE.Light).isLight === true));
  return found;
};

/**
 * Objects with a program variant not issued yet: `fresh` (one per new variant, to compile;
 * those holding a light are left to the sweep, which counts lights correctly) and `users`
 * (every object drawn with a variant that is new or still compiling in `pending`).
 */
function collect(scene: THREE.Scene, pending: Set<string>) {
  const fresh: THREE.Object3D[] = [];
  const users: THREE.Object3D[] = [];
  const added = new Set<string>();
  scene.traverse((o) => {
    const mats = matsOf(o);
    if (!mats.length) return;
    let isNew = false;
    let waits = false;
    for (const m of mats) {
      const k = variant(o, m);
      if (!issued.has(k) || reissue.has(m)) {
        reissue.delete(m);
        issued.add(k);
        added.add(k);
        isNew = true;
      } else if (pending.has(k) || added.has(k)) waits = true;
    }
    if (isNew && (o.children.length === 0 || !hasLight(o))) fresh.push(o);
    if (isNew || waits) users.push(o);
  });
  return { fresh, users, added: [...added] };
}

/** Start over for a scene (everything is issued again; existing programs are found instantly). */
function resetIssued(scene: THREE.Scene) {
  issued = new Set();
  issuedLights = lightsKey(scene);
  late.length = 0;
}

/* ------------------------------------------------------------ objects mounted later */

interface LateJob {
  compile: Compile;
  /** variants issued by this job, and the objects to leave out of the draw until it is done */
  keys: Set<string>;
  objects: THREE.Object3D[];
  /** the lights changed: nothing is drawn until every program is recompiled */
  all: boolean;
}
const late: LateJob[] = [];
const hidden: THREE.Object3D[] = [];

/*
 * New objects are noticed through Object3D.add (React Three Fiber mounts every object with
 * it), material swaps through store changes (view modes), and materials disposed while still
 * in use (drei's <Line> does that when its points change; three.js then compiles them again)
 * through Material.dispose (`reissue`). Only then is the scene scanned.
 */
const graph: { dirty: boolean; reissue: WeakSet<Mat> } = ((globalThis as unknown as { __fabGraph?: { dirty: boolean; reissue: WeakSet<Mat> } }).__fabGraph ??= { dirty: true, reissue: new WeakSet() });
const reissue = graph.reissue;
{
  const proto = THREE.Object3D.prototype as THREE.Object3D & { __fabAdd?: boolean };
  if (!proto.__fabAdd) {
    proto.__fabAdd = true;
    const add = proto.add;
    proto.add = function (this: THREE.Object3D, ...objects: THREE.Object3D[]) {
      graph.dirty = true;
      return add.apply(this, objects);
    } as typeof proto.add;
    const mat = THREE.Material.prototype;
    const dispose = mat.dispose;
    mat.dispose = function (this: Mat) {
      graph.reissue.add(this);
      graph.dirty = true;
      dispose.call(this);
    };
  }
}
if (typeof window !== 'undefined') useUI.subscribe(() => void (graph.dirty = true));

function scanLate(scene: THREE.Scene) {
  lateLoad.scans++;
  if (lightsKey(scene) !== issuedLights) {
    resetIssued(scene);
    const { fresh } = collect(scene, new Set());
    late.push({ compile: new Compile(fresh, scene), keys: new Set(), objects: [], all: true });
    return;
  }
  const pending = new Set<string>();
  for (const j of late) j.keys.forEach((k) => pending.add(k));
  const { fresh, users, added } = collect(scene, pending);
  if (added.length) late.push({ compile: new Compile(fresh, null), keys: new Set(added), objects: users, all: false });
  // objects that only share programs still compiling wait for the newest job (jobs finish in order)
  else if (users.length && late.length) late[late.length - 1].objects.push(...users);
}

/**
 * Called by the renderer before each draw (not while a scene change holds drawing). Returns
 * the objects to leave out of this draw, or null when nothing should be drawn (keep the
 * last frame).
 */
export function beforeDraw(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): THREE.Object3D[] | null {
  hidden.length = 0;
  if (graph.dirty) {
    graph.dirty = false;
    scanLate(scene);
  }
  if (!late.length) return hidden;
  // one job at a time, oldest first
  const j = late[0];
  if (j.compile.step(gl, scene, camera)) {
    late.shift();
    lateLoad.batches++;
    lateLoad.programs += j.compile.programs;
  }
  if (late.some((x) => x.all)) return null;
  for (const x of late) for (const o of x.objects) hidden.push(o);
  return hidden;
}

/* ------------------------------------------------------------ bringing a scene on screen */

/** Texture slots of the materials. */
const MAP_SLOTS = ['map', 'roughnessMap', 'metalnessMap', 'bumpMap', 'normalMap', 'emissiveMap', 'alphaMap', 'aoMap', 'lightMap', 'displacementMap', 'clearcoatMap', 'clearcoatRoughnessMap', 'clearcoatNormalMap', 'transmissionMap', 'thicknessMap', 'specularIntensityMap', 'specularColorMap', 'sheenColorMap', 'sheenRoughnessMap', 'iridescenceMap', 'anisotropyMap'] as const;

/** Textures of the scene not on the GPU yet. */
function sceneTextures(scene: THREE.Scene, gl: THREE.WebGLRenderer): THREE.Texture[] {
  const out = new Set<THREE.Texture>();
  const props = gl.properties as unknown as { get: (o: object) => { __version?: number } };
  scene.traverse((o) => {
    for (const mat of matsOf(o))
      for (const k of MAP_SLOTS) {
        const t = (mat as unknown as Record<string, THREE.Texture | null | undefined>)[k];
        if (!t?.isTexture || t.version === 0 || (t as THREE.CubeTexture).isCubeTexture || (t as { isRenderTargetTexture?: boolean }).isRenderTargetTexture) continue;
        if (props.get(t).__version !== t.version) out.add(t);
      }
  });
  return [...out];
}

interface Job {
  phase: 'settle' | 'compile' | 'upload' | 'draw' | 'done';
  frames: number;
  start: number;
  /** start of the current phase */
  mark: number;
  compile: Compile | null;
  textures: THREE.Texture[];
  release: () => void;
}

/**
 * Brings a freshly mounted scene on screen: settle (2 frames, so the scene's own frame
 * callbacks have run) → compile (background, again for objects mounted meanwhile) → upload
 * textures (time-sliced) → draw 2 frames → loaded.
 */
function SceneReady({ id }: { id: SceneId }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const job = useRef<Job | null>(null);

  useLayoutEffect(() => {
    // a hold is always paired with a release
    renderGate.hold++;
    renderGate.since = performance.now();
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      renderGate.hold--;
      renderGate.since = performance.now();
    };
    job.current = { phase: 'settle', frames: 0, start: performance.now(), mark: 0, compile: null, textures: [], release };
    return () => {
      release();
      job.current = null;
      // the veil waits for a scene that is shown again
      useUI.setState((s) => (s.loadedScenes.includes(id) ? { loadedScenes: s.loadedScenes.filter((x) => x !== id) } : s));
    };
  }, [id]);

  useFrame(() => {
    const j = job.current;
    if (!j || j.phase === 'done') return;
    j.frames++;
    const now = performance.now();
    if (j.phase === 'settle') {
      if (j.frames < 2) return;
      sceneLoad.id = id;
      sceneLoad.mountMs = Math.round(j.start - switchAt);
      sceneLoad.mode = gl.extensions.has('KHR_parallel_shader_compile') ? 'parallel' : 'fenced';
      sceneLoad.programs = 0;
      resetIssued(scene);
      graph.dirty = false;
      j.compile = new Compile(collect(scene, new Set()).fresh, scene);
      j.phase = 'compile';
      j.mark = now;
    } else if (j.phase === 'compile') {
      const c = j.compile!;
      if (!c.step(gl, scene, camera)) return;
      sceneLoad.programs += c.programs;
      // objects mounted meanwhile
      if (graph.dirty) {
        graph.dirty = false;
        if (lightsKey(scene) !== issuedLights) resetIssued(scene);
        const { fresh } = collect(scene, new Set());
        if (fresh.length) return void (j.compile = new Compile(fresh, scene));
      }
      j.compile = null;
      j.textures = sceneTextures(scene, gl);
      sceneLoad.textures = j.textures.length;
      sceneLoad.compileMs = Math.round(now - j.mark);
      j.phase = 'upload';
      j.mark = now;
    } else if (j.phase === 'upload') {
      while (j.textures.length && performance.now() - now < SLICE_MS) gl.initTexture(j.textures.pop()!);
      if (j.textures.length) return;
      j.phase = 'draw';
      j.frames = 0;
      renderGate.warm = true;
      sceneLoad.uploadMs = Math.round(performance.now() - j.mark);
      j.mark = performance.now();
      j.release();
    } else if (j.phase === 'draw') {
      if (j.frames < 2) return;
      j.phase = 'done';
      sceneLoad.drawMs = Math.round(now - j.mark);
      sceneLoad.ms = Math.round(now - j.start);
      sceneLog.push({ ...sceneLoad });
      if (sceneLog.length > 40) sceneLog.shift();
      const s = useUI.getState();
      s.markSceneLoaded(id);
      s.setLoader('models', 'done');
      s.setLoader('materials', 'done');
      if (s.transition.active) setTimeout(() => useUI.getState().set({ transition: { ...useUI.getState().transition, active: false } }), 250);
      prefetchNeighbours(id);
    }
  });
  return null;
}

export function SceneSwitcher() {
  const stageId = useUI((s) => s.stageId);
  const stage = STAGE_BY_ID[stageId];
  const want = stage.scene;

  // A new scene is mounted in a transition: React builds its components (and their models)
  // in slices between frames instead of one long block. Until it commits, nothing is mounted
  // (the old scene must not run against the new stage) and nothing is drawn (the last frame
  // stays on the canvas, under the story veil).
  const [shown, setShown] = useState<SceneId>(want);
  const switching = shown !== want;
  useEffect(() => {
    // always queued, so a quick A → B → A ends on A
    startTransition(() => setShown(want));
  }, [want]);
  useLayoutEffect(() => {
    if (!switching) return;
    renderGate.hold++;
    renderGate.since = performance.now();
    return () => {
      renderGate.hold--;
    };
  }, [switching]);

  // models built for scenes visited long ago are freed (see kit/Baked)
  const last = useRef<SceneId | null>(null);
  if (last.current !== want) {
    last.current = want;
    switchAt = performance.now();
    kitSceneChanged();
  }

  useEffect(() => {
    useUI.getState().setLoader('models', useUI.getState().loadedScenes.includes(want) ? 'done' : 'loading');
    // tracked positions are re-published every frame by the active scene
    tracked.clear();
  }, [want]);

  if (switching) return null;
  const Scene = LAZY[want];
  return (
    <Suspense fallback={null}>
      <group key={want}>
        <Scene stage={stage} />
        <SceneReady id={want} />
      </group>
    </Suspense>
  );
}
