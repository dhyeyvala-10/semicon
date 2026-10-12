'use client';
/**
 * Repeated layer formation (§33): the wafer loops through the same tool types again and
 * again — deposit, coat, bake, expose, develop, etch, strip, implant, anneal, CMP, inspect.
 * Each loop adds one patterned layer to the stack in the centre. Every cycle samples its
 * own colour grade from the journey palette, so the stack becomes a blend of all of them.
 * CONCEPTUAL: the station order is a simplified, typical loop; real flows vary per layer.
 *
 * The eleven tools are finished miniatures, each with the silhouette of its machine class
 * (cluster chambers, track hood, bake stack, scanner, beamline, furnace, polisher, metrology
 * gantry), built with the detailing kit and merged into ONE model together with the AMHS track
 * and the stack plinth: one mesh per finish for the whole loop. The status strips, the
 * travelling FOUP, the layers and the glowing loop stay their own animated meshes.
 */
import * as THREE from 'three';
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Lighting, VoidBackdrop } from '../environments';
import { M } from '../materials';
import { TechLabel } from '../parts/interaction';
import { buildFoup, useModel, ModelView } from '../parts/wafer';
import { Kit, type V3, cabinet, grille, hmi, ledStrip } from '../kit/build';
import { KM } from '../kit/finish';
import { engine } from '@/simulation/engine';
import { pp } from '@/lib/anim';
import { track, gradeState } from '@/lib/runtime';
import { clamp, smooth } from '@/lib/math';
import { gradeAt, hex, journeyT } from '@/lib/palette';

const STATIONS = ['DEPOSIT', 'COAT', 'BAKE', 'EXPOSE', 'DEVELOP', 'ETCH', 'STRIP', 'IMPLANT', 'ANNEAL', 'CMP', 'INSPECT'];
const R = 3.3;
const CYCLES = ['c17', 'c18', 'c19'] as const;
const BASE_LAYERS = 16;
const LAYER_H = 0.05;

/** progress around the loop for the current cycle phase (0..1), and which cycle (0..2, 3 = next) */
function loopState() {
  const v = engine.player.view;
  const idx = CYCLES.indexOf(v.phaseId as (typeof CYCLES)[number]);
  if (idx < 0) return { cycle: pp('c19') >= 1 ? 3 : 0, u: v.phaseId === 'next' ? v.phaseT : 0 };
  return { cycle: idx, u: v.phaseT };
}

const stationPos = (i: number) => {
  const a = (i / STATIONS.length) * Math.PI * 2 - Math.PI / 2;
  return new THREE.Vector3(Math.cos(a) * R, 0, Math.sin(a) * R);
};

/* ---------------------------------------------------------------- tool miniatures (kit) */

const HP = Math.PI / 2;
/** top of every tool base (cabinet 0.62 m + cap) */
const Y0 = 0.642;
/** base footprint: the status strip runs across the front face at z = 0.28 */
const W = 0.78;
const D = 0.55;

/** Metal finishes with some diffuse response (the dark void environment turns full metal black). */
const VS = (() => {
  const m = KM.stainless.clone();
  m.metalness = 0.55;
  m.roughness = 0.34;
  return m;
})();
const VA = (() => {
  const m = KM.anodized.clone();
  m.metalness = 0.5;
  m.roughness = 0.42;
  return m;
})();

/** Common tool base: kick plate, rounded panels with seams and fasteners, louvred vent. */
function toolBase(k: Kit, body: THREE.Material = KM.paint) {
  cabinet(k, { size: [W, 0.62, D], body, panels: 2, rows: [], sidePanels: 1, stripe: false });
  k.box(KM.paintGrey, [W - 0.012, 0.004, D - 0.012], [0, Y0 + 0.002, 0], [0, 0, 0], { cast: false });
}

/** Vacuum chamber on a cluster platform: body, lid with bolt ring, gas/RF box on top. */
function chamber(k: Kit, x: number, z: number, r: number, h: number, rf = false) {
  k.cyl(VS, r, h, [x, Y0 + h / 2, z], [0, 0, 0], 28);
  k.cyl(VS, r * 1.08, 0.014, [x, Y0 + h + 0.007, z], [0, 0, 0], 28);
  k.torus(KM.stainlessDark, r * 1.02, 0.004, [x, Y0 + h * 0.35, z], [0, 0, 0], 28, { cast: false });
  if (rf) {
    k.rbox(KM.paint, [r * 1.1, 0.1, r * 1.1], 0.012, [x, Y0 + h + 0.064, z]);
    k.cyl(KM.copper, 0.012, 0.03, [x, Y0 + h + 0.13, z], [0, 0, 0], 10);
  } else k.rbox(VA, [r * 0.9, 0.05, r * 0.6], 0.01, [x, Y0 + h + 0.039, z]);
}

/** Front EFEM strip of a cluster tool: two load ports with carriers (FOUP silhouettes). */
function loadPorts(k: Kit) {
  for (const x of [-0.19, 0.19]) {
    k.rbox(M.foupDark, [0.15, 0.12, 0.13], 0.02, [x, Y0 + 0.06, 0.19]);
    k.rbox(M.foupDark, [0.1, 0.012, 0.1], 0.004, [x, Y0 + 0.126, 0.19]);
  }
}

/** Cluster tool (deposition / etch / strip): hexagonal transfer chamber and process chambers. */
function cluster(k: Kit, n: number, rf: boolean, domes = false) {
  toolBase(k);
  k.cyl(VA, 0.11, 0.09, [0, Y0 + 0.045, -0.04], [0, 0, 0], 6);
  k.cyl(KM.glassSmoke, 0.08, 0.004, [0, Y0 + 0.092, -0.04], [0, 0, 0], 6, { cast: false });
  const span = n === 2 ? [-0.6, 0.6] : n === 3 ? [-1.0, 0, 1.0] : [-1.3, -0.45, 0.45, 1.3];
  for (const a of span) {
    const x = Math.sin(a) * 0.19;
    const z = -0.04 - Math.cos(a) * 0.19;
    if (domes) {
      k.cyl(VS, 0.075, 0.1, [x, Y0 + 0.05, z], [0, 0, 0], 24);
      k.lathe(M.ceramic, [[0.0, 0], [0.075, 0], [0.072, 0.03], [0.05, 0.07], [0.0, 0.085]], [x, Y0 + 0.1, z], [0, 0, 0], 24);
      k.torus(KM.copper, 0.068, 0.007, [x, Y0 + 0.13, z], [0, 0, 0], 24);
    } else chamber(k, x, z, n > 3 ? 0.072 : 0.08, 0.13 + (rf ? 0.02 : 0), rf);
  }
  loadPorts(k);
}

/** Track (coat / develop): long hood with viewing window, cups inside, chemical tower, exhaust. */
function trackTool(k: Kit, develop: boolean) {
  toolBase(k);
  k.rbox(KM.paint, [W - 0.04, 0.16, 0.42], 0.015, [0, Y0 + 0.08, -0.04]);
  k.box(KM.glassSmoke, [W - 0.16, 0.08, 0.004], [0, Y0 + 0.09, 0.172], [0, 0, 0], { cast: false });
  for (const x of [-0.24, 0.0]) k.at([x, Y0 + 0.161, -0.06], [-HP, 0, 0], () => grille(k, 0.16, 0.14, [0, 0, 0], { m: KM.paint }));
  k.rbox(KM.paint, [0.2, 0.26, 0.22], 0.015, [0.27, Y0 + 0.16 + 0.13, -0.12]);
  for (let i = 0; i < 3; i++) k.cyl(develop ? KM.paintBlue : KM.plasticWhite, 0.018, 0.07, [0.22 + i * 0.05, Y0 + 0.195, 0.06], [0, 0, 0], 12);
  k.cyl(VS, 0.04, 0.2, [-0.25, Y0 + 0.26, -0.18], [0, 0, 0], 16);
  ledStrip(k, 0.24, [-0.2, Y0 + 0.14, 0.172]);
}

/** Bake: hot-plate stack tower with slot seams, chill plates below, exhaust collar. */
function bakeTool(k: Kit) {
  toolBase(k);
  k.rbox(KM.paint, [0.56, 0.34, 0.42], 0.015, [0, Y0 + 0.17, -0.04]);
  for (let i = 0; i < 5; i++) {
    const y = Y0 + 0.045 + i * 0.06;
    k.box(KM.seam, [0.5, 0.012, 0.004], [0, y, 0.172], [0, 0, 0], { cast: false });
    k.box(i < 2 ? KM.paintBlue : KM.ledAmber, [0.03, 0.008, 0.004], [0.22, y + 0.02, 0.173], [0, 0, 0], { cast: false });
  }
  k.cyl(VS, 0.05, 0.12, [0, Y0 + 0.4, -0.08], [0, 0, 0], 16);
  k.label('warn', 'HOT SURFACE', '', 0.06, 0.06, [-0.2, Y0 + 0.3, 0.172]);
}

/** Exposure scanner: wide body, raised lens column housing, reticle library, wafer-stage hood. */
function scannerTool(k: Kit) {
  toolBase(k);
  k.rbox(KM.paint, [W - 0.02, 0.18, D - 0.04], 0.02, [0, Y0 + 0.09, -0.01]);
  k.rbox(KM.paintGraphite, [W - 0.01, 0.02, D - 0.03], 0.008, [0, Y0 + 0.19, -0.01]);
  k.cyl(KM.paint, 0.11, 0.16, [0.02, Y0 + 0.28, -0.06], [0, 0, 0], 28);
  k.cyl(KM.paintGraphite, 0.12, 0.02, [0.02, Y0 + 0.37, -0.06], [0, 0, 0], 28);
  k.rbox(KM.paint, [0.18, 0.14, 0.2], 0.015, [-0.26, Y0 + 0.27, -0.1]);
  k.box(KM.paintAccent, [W - 0.04, 0.012, 0.004], [0, Y0 + 0.15, 0.257], [0, 0, 0], { cast: false });
  k.box(KM.glassSmoke, [0.3, 0.06, 0.004], [0.15, Y0 + 0.08, 0.257], [0, 0, 0], { cast: false });
}

/** Implanter: terminal box, blue analyzer sector, beam tube, end station. */
function implantTool(k: Kit) {
  toolBase(k);
  k.rbox(KM.paint, [0.2, 0.2, 0.2], 0.015, [-0.27, Y0 + 0.1, -0.12]);
  const shape: [number, number][] = [];
  for (let i = 0; i <= 10; i++) {
    const t = (i / 10) * HP;
    shape.push([-0.17 + Math.cos(t) * 0.22, -0.12 + Math.sin(t) * 0.22]);
  }
  for (let i = 10; i >= 0; i--) {
    const t = (i / 10) * HP;
    shape.push([-0.17 + Math.cos(t) * 0.1, -0.12 + Math.sin(t) * 0.1]);
  }
  k.extrude(KM.paintBlue, shape.map(([x, z]) => [x, -z] as [number, number]), 0.1, [0, Y0 + 0.06, 0], [-HP, 0, 0]);
  k.cyl(VS, 0.03, 0.4, [0.05, Y0 + 0.11, 0.05], [0, 0, HP], 16);
  for (let i = 0; i < 4; i++) k.cyl(M.ceramic, 0.045, 0.03, [-0.03 + i * 0.05, Y0 + 0.11, 0.05], [0, 0, HP], 16);
  k.rbox(VS, [0.18, 0.22, 0.24], 0.015, [0.28, Y0 + 0.11, 0.0]);
  k.label('warn', 'HIGH VOLTAGE', '', 0.07, 0.07, [-0.27, Y0 + 0.1, -0.019]);
}

/** Anneal: vertical furnace tower with scavenger box and duct, RTP lamp head beside it. */
function annealTool(k: Kit) {
  toolBase(k);
  k.rbox(KM.paint, [0.36, 0.5, 0.4], 0.015, [-0.16, Y0 + 0.25, -0.06]);
  k.box(KM.paintAccent, [0.362, 0.03, 0.402], [-0.16, Y0 + 0.24, -0.06], [0, 0, 0], { cast: false });
  grille(k, 0.22, 0.08, [-0.16, Y0 + 0.4, 0.141], { m: KM.paint });
  k.rbox(KM.paint, [0.22, 0.08, 0.2], 0.012, [-0.16, Y0 + 0.54, -0.1]);
  k.cyl(VS, 0.04, 0.12, [-0.12, Y0 + 0.64, -0.12], [0, 0, 0], 16);
  k.rbox(VA, [0.24, 0.1, 0.26], 0.015, [0.22, Y0 + 0.05, -0.02]);
  k.cyl(KM.paintGraphite, 0.09, 0.05, [0.22, Y0 + 0.125, -0.02], [0, 0, 0], 24);
  k.label('warn', 'HOT SURFACE', '', 0.07, 0.07, [-0.25, Y0 + 0.14, 0.141]);
}

/** CMP: polisher enclosure frame with glass, platen and pad, head on its spindle, slurry arm. */
function cmpTool(k: Kit) {
  toolBase(k);
  for (const [x, z] of [[-0.36, -0.24], [0.36, -0.24], [-0.36, 0.24], [0.36, 0.24]] as const) k.box(KM.paint, [0.025, 0.34, 0.025], [x, Y0 + 0.17, z]);
  for (const z of [-0.24, 0.24]) k.box(KM.paint, [0.745, 0.025, 0.025], [0, Y0 + 0.33, z]);
  for (const x of [-0.36, 0.36]) k.box(KM.paint, [0.025, 0.025, 0.505], [x, Y0 + 0.33, 0]);
  k.box(KM.glass, [0.72, 0.3, 0.004], [0, Y0 + 0.17, 0.24], [0, 0, 0], { cast: false });
  k.box(KM.paint, [0.72, 0.31, 0.012], [0, Y0 + 0.16, -0.24]);
  k.cyl(KM.plasticWhite, 0.17, 0.035, [-0.05, Y0 + 0.0175, 0.0], [0, 0, 0], 32);
  k.cyl(KM.paintWarm, 0.15, 0.004, [-0.05, Y0 + 0.037, 0.0], [0, 0, 0], 32, { cast: false });
  k.cyl(VA, 0.06, 0.03, [0.0, Y0 + 0.06, 0.02], [0, 0, 0], 20);
  k.cyl(VS, 0.012, 0.2, [0.0, Y0 + 0.17, 0.02], [0, 0, 0], 10);
  k.rbox(KM.paint, [0.4, 0.04, 0.06], 0.012, [0.14, Y0 + 0.29, -0.06], [0, 0.4, 0]);
  k.cyl(KM.paint, 0.03, 0.27, [0.3, Y0 + 0.135, -0.15], [0, 0, 0], 14);
}

/** Inspection: dark metrology enclosure, granite stage, gantry bridge with microscope column. */
function inspectTool(k: Kit) {
  toolBase(k);
  k.rbox(KM.paintDark, [W - 0.06, 0.06, D - 0.08], 0.012, [0, Y0 + 0.03, -0.02]);
  k.box(KM.paintGraphite, [0.5, 0.02, 0.36], [0, Y0 + 0.07, -0.02]);
  for (const x of [-0.3, 0.3]) k.rbox(KM.paint, [0.05, 0.22, 0.06], 0.01, [x, Y0 + 0.17, -0.06]);
  k.rbox(KM.paint, [0.66, 0.06, 0.08], 0.012, [0, Y0 + 0.3, -0.06]);
  k.rbox(KM.paint, [0.1, 0.16, 0.1], 0.012, [0.06, Y0 + 0.2, -0.0]);
  k.cyl(KM.paintGraphite, 0.025, 0.06, [0.06, Y0 + 0.1, 0.0], [0, 0, 0], 16);
  k.at([0.32, Y0 + 0.1, 0.2], -0.4, () => hmi(k, [0, 0.1, 0], 0), 0.5);
}

const BUILDERS: ((k: Kit) => void)[] = [
  (k) => cluster(k, 3, false),
  (k) => trackTool(k, false),
  bakeTool,
  scannerTool,
  (k) => trackTool(k, true),
  (k) => cluster(k, 4, true),
  (k) => cluster(k, 2, false, true),
  implantTool,
  annealTool,
  cmpTool,
  inspectTool,
];

/** AMHS track under the travelling FOUP: dark track bed with two rails and sleepers. */
function buildTrack(k: Kit) {
  const r = R - 0.75;
  k.lathe(KM.paintGraphite, [[r - 0.12, 0], [r + 0.12, 0], [r + 0.12, 0.008], [r - 0.12, 0.008], [r - 0.12, 0]], [0, 0.0, 0], [0, 0, 0], 160);
  for (const dr of [-0.07, 0.07]) k.torus(KM.stainlessDark, r + dr, 0.006, [0, 0.014, 0], [0, 0, 0], 160, { cast: false });
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    k.box(KM.anodizedDark, [0.17, 0.006, 0.025], [Math.cos(a) * r, 0.01, Math.sin(a) * r], [0, -a, 0], { cast: false });
  }
}

/** Display plinth for the layer stack: chamfered dark base, stainless rim, accent band, feet. */
function buildPlinth(k: Kit) {
  k.rbox(KM.paintGraphite, [1.9, 0.05, 1.2], 0.012, [0, 0.025, 0]);
  k.rbox(KM.paintDark, [1.8, 0.012, 1.1], 0.004, [0, 0.056, 0]);
  k.box(KM.paintAccent, [1.904, 0.008, 1.204], [0, 0.03, 0], [0, 0, 0], { cast: false });
  for (const [x, z] of [[-0.88, -0.53], [0.88, -0.53], [-0.88, 0.53], [0.88, 0.53]] as const) k.cyl(VS, 0.018, 0.004, [x, 0.0505, z], [0, 0, 0], 12, { cast: false });
  k.ao(1.9, 1.2, [0, 0, 0], 1.3);
}

function useLoopModel() {
  return useModel((k) => {
    STATIONS.forEach((_, i) => {
      const p = stationPos(i);
      k.at([p.x, 0, p.z] as V3, Math.atan2(-p.x, -p.z), () => BUILDERS[i](k));
    });
    buildTrack(k);
    buildPlinth(k);
  });
}

function Station({ i }: { i: number }) {
  const p = stationPos(i);
  const strip = useRef<THREE.Mesh>(null);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#7fa35a', emissive: new THREE.Color('#7fa35a'), emissiveIntensity: 0.1, roughness: 0.5 }), []);
  useFrame(() => {
    const { u, cycle } = loopState();
    const here = cycle < 3 ? u * STATIONS.length : -10;
    const d = Math.abs(here - (i + 0.5));
    const active = d < 0.5;
    mat.color.copy(gradeState.accent);
    mat.emissive.copy(gradeState.glow);
    mat.emissiveIntensity = active ? 1.1 : 0.08 + 0.05 * Math.sin(engine.time * 0.8 + i);
    if (strip.current) strip.current.scale.y = active ? 1.6 : 1;
  });
  const face = Math.atan2(-p.x, -p.z);
  return (
    <group position={p} rotation={[0, face, 0]}>
      <mesh ref={strip} position={[0, 0.5, 0.28]} material={mat}>
        <boxGeometry args={[0.78, 0.05, 0.01]} />
      </mesh>
      <TechLabel position={[-0.32, 0.95, 0]} title={`${String(i + 1).padStart(2, '0')} ${STATIONS[i]}`} min={1} />
    </group>
  );
}

function Traveller() {
  const foup = useRef<THREE.Group>(null);
  // closed 25-slot FOUP carrying the lot (door toward the tools), scaled to the loop
  const carrier = useModel((k) => k.at([0, -0.132, 0], 0, () => buildFoup(k, true), 0.8));
  useFrame(() => {
    const { u, cycle } = loopState();
    const a = (cycle < 3 ? u : 0) * Math.PI * 2 - Math.PI / 2;
    const r = R - 0.75;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (foup.current) {
      foup.current.position.set(x, 0.32 + 0.04 * Math.sin(engine.time * 6), z);
      foup.current.rotation.y = -a;
    }
    track('focus', x, 0.3, z);
  });
  return (
    <group ref={foup}>
      <ModelView m={carrier} />
    </group>
  );
}

/** Layer stack: 16 earlier layers + the three cycles of this stage + ghosted future layers. */
function LayerStack() {
  const layers = useMemo(() => {
    const t0 = journeyT('layer-cycle');
    return Array.from({ length: 40 }, (_, k) => {
      // each layer samples its own grade: neighbouring positions on the journey + a cycle hue shift
      const g = gradeAt(clamp(t0 - 0.25 + k * 0.012), k - BASE_LAYERS);
      const col = new THREE.Color(hex(g.accent));
      return new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.35, metalness: 0.1, transparent: true, opacity: 1, clearcoat: 0.3 });
    });
  }, []);
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  useFrame(() => {
    const { cycle, u } = loopState();
    layers.forEach((m, k) => {
      const mesh = refs.current[k];
      if (!mesh) return;
      let h = 1;
      let op = 1;
      if (k >= BASE_LAYERS) {
        const c = k - BASE_LAYERS; // 0,1,2 → cycles 17,18,19; ≥3 future
        if (c < 3) {
          h = c < cycle ? 1 : c === cycle ? smooth(clamp((u - 0.05) / 0.9)) : 0;
        } else {
          // future layers: ghosts appear in the "next layer …" phase
          h = cycle === 3 ? 1 : 0;
          op = cycle === 3 ? 0.18 * smooth(clamp(u * 2 - (c - 3) * 0.04)) : 0;
        }
      }
      mesh.visible = h > 0.001 && op > 0.001;
      mesh.scale.y = Math.max(0.001, h);
      m.opacity = op;
      m.depthWrite = op > 0.9;
    });
  });
  return (
    <group position={[0, 0.06, 0]}>
      {layers.map((m, k) => (
        <group key={k} position={[0, k * LAYER_H, 0]}>
          <mesh ref={(el) => {
              refs.current[k] = el;
            }} position={[0, LAYER_H / 2, 0]} material={m} castShadow>
            <boxGeometry args={[1.6 - (k % 3) * 0.02, LAYER_H * 0.92, 1.0]} />
          </mesh>
        </group>
      ))}
      <TechLabel position={[0.9, BASE_LAYERS * LAYER_H, 0.5]} title="LAYER STACK" lines={['one patterned layer per loop']} min={1} value={() => {
        const { cycle } = loopState();
        return cycle < 3 ? `CYCLE ${17 + cycle} · adding layer ${17 + cycle}` : 'many tens of mask layers · hundreds of steps';
      }} />
    </group>
  );
}

function LoopRing() {
  const pts = useMemo(() => {
    const out: THREE.Vector3[] = [];
    for (let i = 0; i <= 120; i++) {
      const a = (i / 120) * Math.PI * 2;
      out.push(new THREE.Vector3(Math.cos(a) * (R - 0.75), 0.02, Math.sin(a) * (R - 0.75)));
    }
    return out;
  }, []);
  const geo = useMemo(() => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 240, 0.025, 8, true), [pts]);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#4d6b4a', emissive: new THREE.Color('#7fa35a'), emissiveIntensity: 0.3 }), []);
  useFrame(() => {
    mat.emissive.copy(gradeState.accent);
    mat.emissiveIntensity = 0.35 + 0.1 * Math.sin(engine.time * 1.3);
  });
  return <mesh geometry={geo} material={mat} />;
}

/** Static tools, AMHS track and stack plinth: one merged model for the whole loop. */
function LoopEquipment() {
  const m = useLoopModel();
  return <ModelView m={m} pickable={false} />;
}

export default function CycleScene() {
  return (
    <>
      <Lighting env="void" shadowExtent={6} />
      <VoidBackdrop color="#33402f" />
      <LoopEquipment />
      <LoopRing />
      {STATIONS.map((_, i) => (
        <Station key={i} i={i} />
      ))}
      <Traveller />
      <LayerStack />
      <TechLabel
        position={[-1.4, 2.1, 0]}
        title="RE-ENTRANT FLOW · CONCEPTUAL"
        lines={['the same tool types, a new recipe and reticle each loop']}
        min={1}
        value={() => `steps completed ≈ ${engine.tele.value('steps', 0).toFixed(0)} · ${engine.player.view.phase.label}`}
      />
    </>
  );
}
