'use client';
/**
 * Repeated layer formation (§33): the wafer loops through the same tool types again and
 * again — deposit, coat, bake, expose, develop, etch, strip, implant, anneal, CMP, inspect.
 * Each loop adds one patterned layer to the stack in the centre. Every cycle samples its
 * own colour grade from the journey palette, so the stack becomes a blend of all of them.
 * CONCEPTUAL: the station order is a simplified, typical loop; real flows vary per layer.
 */
import * as THREE from 'three';
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Lighting, VoidBackdrop } from '../environments';
import { M } from '../materials';
import { B, C } from '../parts/primitives';
import { TechLabel } from '../parts/interaction';
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
      <B s={[0.78, 0.62, 0.55]} m={M.panel} position={[0, 0.31, 0]} />
      <B s={[0.8, 0.06, 0.57]} m={M.panelDark} position={[0, 0.65, 0]} />
      <mesh ref={strip} position={[0, 0.5, 0.28]} material={mat}>
        <boxGeometry args={[0.78, 0.05, 0.01]} />
      </mesh>
      <C r={0.05} h={0.02} m={M.steelDark} position={[0.25, 0.68, 0.1]} />
      <TechLabel position={[-0.32, 0.95, 0]} title={`${String(i + 1).padStart(2, '0')} ${STATIONS[i]}`} min={1} />
    </group>
  );
}

function Traveller() {
  const foup = useRef<THREE.Group>(null);
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
      <B s={[0.3, 0.26, 0.28]} m={M.foupShell} />
      <B s={[0.32, 0.03, 0.3]} m={M.foupDark} position={[0, 0.15, 0]} />
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
      <B s={[1.9, 0.06, 1.2]} m={M.panelDark} position={[0, -0.03, 0]} />
      <C r={0.06} h={0.02} m={M.steelDark} position={[0, -0.06, 0]} />
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

export default function CycleScene() {
  return (
    <>
      <Lighting env="void" shadowExtent={6} />
      <VoidBackdrop color="#33402f" />
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
