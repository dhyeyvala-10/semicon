'use client';
/**
 * Inside the wafer (§34, §35) — 1 world unit = 10 nm. SIMPLIFIED DEVICE MODELS.
 *   build:   a planar MOSFET assembled step by step — substrate, STI, well, gate dielectric,
 *            gate, spacers, source/drain, silicide, contacts, first metal; then it switches on.
 *   compare: planar · FinFET · GAA/nanosheet side by side — how much of the channel the gate
 *            surrounds (1, 3 and 4 sides) and what that does to leakage (schematic).
 * Views: section (cut through the device), exploded (layers lifted apart), x-ray (gates ghosted).
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, VoidBackdrop } from '../environments';
import { shell, XRAY } from '../materials';
import { GEO } from '../parts/primitives';
import { Clickable, TechLabel } from '../parts/interaction';
import { engine } from '@/simulation/engine';
import { pp, inPhase, pdt } from '@/lib/anim';
import { cutPlane, track, gradeState } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { clamp, smooth, rng, lerp } from '@/lib/math';
import type { V3 } from '../parts/primitives';
import type { ViewMode } from '@/types';

/* ---------------------------------------------------------------- materials */

const std = (color: string, p: THREE.MeshPhysicalMaterialParameters = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.4, metalness: 0.05, ...p });
const MAT = {
  si: std('#5f676f', { roughness: 0.35, metalness: 0.5 }),
  oxide: std('#a9bfa2', { roughness: 0.25, transparent: true, opacity: 0.85 }),
  well: std('#d9b56b', { transparent: true, opacity: 0.32, depthWrite: false }),
  nplus: std('#4f8f5e', { roughness: 0.45 }),
  gox: std('#efe6b8', { roughness: 0.3 }),
  gate: std('#a58a6a', { roughness: 0.35, metalness: 0.5 }),
  gateGlass: std('#b49a72', { roughness: 0.3, metalness: 0.3, transparent: true, opacity: 0.5, depthWrite: false }),
  spacer: std('#c9c2a8', { roughness: 0.5 }),
  silicide: std('#6b5a3a', { roughness: 0.3, metalness: 0.8 }),
  tungsten: std('#8c8f94', { roughness: 0.3, metalness: 0.9 }),
  copper: std('#c47b4a', { roughness: 0.25, metalness: 1 }),
  pmd: std('#d9e8d0', { roughness: 0.1, transparent: true, opacity: 0.1, depthWrite: false }),
  fin: std('#9aa3ad', { roughness: 0.3, metalness: 0.4 }),
  electron: new THREE.MeshBasicMaterial({ color: '#d8f0b8', toneMapped: false }),
  leak: new THREE.MeshBasicMaterial({ color: '#ec835a', toneMapped: false }),
  ion: new THREE.MeshBasicMaterial({ color: '#b9e3a8', toneMapped: false }),
  field: new THREE.MeshBasicMaterial({ color: '#d9f29a', toneMapped: false, transparent: true, opacity: 0.85 }),
};
const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);

function useView(): ViewMode {
  return useUI((s) => s.view);
}

/* ---------------------------------------------------------------- build: animated parts */

type Mode = 'drop' | 'grow' | 'fade';

/**
 * A device layer that appears during `phase`: dropped in from above, grown upward from its
 * base, or faded in. `layer` sets its lift in the exploded view.
 */
function Part({ phase, mode = 'drop', layer, children, sel }: { phase: string; mode?: Mode; layer: number; children: ReactNode; sel: { id: string; label: string } }) {
  const g = useRef<THREE.Group>(null);
  const inner = useRef<THREE.Group>(null);
  const view = useView();
  const ex = useRef(0);
  useFrame((_, dt) => {
    const k = smooth(clamp(pp(phase) * 1.35));
    ex.current += ((view === 'exploded' ? 1 : 0) - ex.current) * Math.min(1, dt * 4);
    if (!g.current || !inner.current) return;
    g.current.visible = k > 0.001;
    g.current.position.y = layer * 1.6 * ex.current;
    if (mode === 'drop') {
      inner.current.position.y = (1 - k) * 4;
      inner.current.scale.setScalar(1);
    } else if (mode === 'grow') {
      inner.current.scale.set(1, Math.max(0.001, k), 1);
      inner.current.position.y = 0;
    }
  });
  return (
    <group ref={g}>
      <group ref={inner}>
        <Clickable sel={{ kind: 'component', id: sel.id, label: sel.label }}>{children}</Clickable>
      </group>
    </group>
  );
}

/** Box helper: centre-bottom anchored so 'grow' scales up from the base. */
function Slab({ x0, x1, y0, y1, z0, z1, m }: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; m: THREE.Material }) {
  const view = useView();
  const mat = m === MAT.well || m === MAT.pmd ? m : shell(m, view === 'xray' ? 'normal' : view);
  return (
    <group position={[(x0 + x1) / 2, y0, (z0 + z1) / 2]}>
      <mesh geometry={GEO.box} material={mat} scale={[x1 - x0, y1 - y0, z1 - z0]} position={[0, (y1 - y0) / 2, 0]} castShadow receiveShadow />
    </group>
  );
}

function SourceDrainIons() {
  const N = 120;
  const ref = useRef<THREE.InstancedMesh>(null);
  const seeds = useMemo(() => {
    const r = rng(8);
    return Array.from({ length: N }, () => ({ x: (r() - 0.5) * 12, z: (r() - 0.5) * 5, o: r(), s: 0.7 + r() * 0.6 }));
  }, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const t = useRef(0);
  useFrame((_, dt) => {
    t.current += pdt(dt);
    if (!ref.current) return;
    const on = inPhase('sd') || inPhase('well');
    seeds.forEach((s, i) => {
      if (!on) return ref.current!.setMatrixAt(i, HIDE);
      const u = (t.current * 0.9 * s.s + s.o) % 1;
      // ions are blocked by the gate + spacers (and by STI) during the S/D implant
      const blocked = inPhase('sd') && (Math.abs(s.x) < 1.5 || Math.abs(s.x) > 5.5);
      const stop = blocked ? (Math.abs(s.x) < 1.5 ? 2.0 : 0.05) : -0.6;
      o.position.set(s.x, lerp(7, stop, u), s.z);
      o.scale.set(0.08, 0.35, 0.08);
      o.updateMatrix();
      ref.current!.setMatrixAt(i, o.matrix);
    });
    ref.current.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={ref} args={[GEO.box, MAT.ion, N]} frustumCulled={false} />;
}

/** Electrons drifting source → drain once the device is complete (ON state). */
function Electrons({ paths, leak = 0, on }: { paths: { y: number; z: number }[]; leak?: number; on: () => boolean }) {
  const N = 60;
  const e = useRef<THREE.InstancedMesh>(null);
  const l = useRef<THREE.InstancedMesh>(null);
  const seeds = useMemo(() => {
    const r = rng(5);
    return Array.from({ length: N }, () => ({ p: Math.floor(r() * 1000), o: r(), dz: (r() - 0.5) * 0.8, dy: (r() - 0.5) * 0.2, s: 0.7 + r() * 0.5, lk: r() }));
  }, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const t = useRef(0);
  useFrame((_, dt) => {
    t.current += pdt(dt);
    const show = on();
    seeds.forEach((s, i) => {
      const path = paths[s.p % paths.length];
      const u = (t.current * 0.25 * s.s + s.o) % 1;
      const isLeak = s.lk < leak;
      o.position.set(lerp(-2.8, 2.8, u), isLeak ? path.y - 0.9 - s.dy * 3 : path.y + s.dy, path.z + s.dz * (isLeak ? 2 : 1));
      o.scale.setScalar(0.12);
      o.updateMatrix();
      e.current?.setMatrixAt(i, show && !isLeak ? o.matrix : HIDE);
      l.current?.setMatrixAt(i, show && isLeak ? o.matrix : HIDE);
    });
    if (e.current) e.current.instanceMatrix.needsUpdate = true;
    if (l.current) l.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <>
      <instancedMesh ref={e} args={[GEO.sphereLow, MAT.electron, N]} frustumCulled={false} />
      <instancedMesh ref={l} args={[GEO.sphereLow, MAT.leak, N]} frustumCulled={false} />
    </>
  );
}

function PlanarBuild() {
  useFrame(() => track('focus', 0, 1, 0));
  return (
    <group>
      <Part phase="substrate" mode="fade" layer={0} sel={{ id: 'substrate', label: 'Silicon substrate' }}>
        <Slab x0={-7} x1={7} y0={-4} y1={0} z0={-3} z1={3} m={MAT.si} />
      </Part>
      <Part phase="sti" mode="grow" layer={0} sel={{ id: 'sti', label: 'Shallow trench isolation' }}>
        <Slab x0={-7.02} x1={-5.5} y0={-2.6} y1={0.03} z0={-3.02} z1={3.02} m={MAT.oxide} />
        <Slab x0={5.5} x1={7.02} y0={-2.6} y1={0.03} z0={-3.02} z1={3.02} m={MAT.oxide} />
      </Part>
      <Part phase="well" mode="fade" layer={0} sel={{ id: 'well', label: 'p-well' }}>
        <Slab x0={-5.5} x1={5.5} y0={-3.4} y1={-0.01} z0={-2.98} z1={2.98} m={MAT.well} />
      </Part>
      <Part phase="gate-ox" mode="drop" layer={1} sel={{ id: 'gate-oxide', label: 'Gate dielectric' }}>
        <Slab x0={-1.1} x1={1.1} y0={0} y1={0.14} z0={-2.5} z1={2.5} m={MAT.gox} />
      </Part>
      <Part phase="gate" mode="grow" layer={2} sel={{ id: 'gate', label: 'Gate electrode' }}>
        <Slab x0={-1} x1={1} y0={0.14} y1={2.0} z0={-2.5} z1={2.5} m={MAT.gate} />
      </Part>
      <Part phase="spacer" mode="grow" layer={2} sel={{ id: 'spacer', label: 'Spacers' }}>
        <Slab x0={-1.5} x1={-1} y0={0} y1={1.9} z0={-2.5} z1={2.5} m={MAT.spacer} />
        <Slab x0={1} x1={1.5} y0={0} y1={1.9} z0={-2.5} z1={2.5} m={MAT.spacer} />
      </Part>
      <Part phase="sd" mode="fade" layer={0} sel={{ id: 'source', label: 'Source / drain' }}>
        <Slab x0={-5.5} x1={-1.5} y0={-1.2} y1={0.005} z0={-2.6} z1={2.6} m={MAT.nplus} />
        <Slab x0={1.5} x1={5.5} y0={-1.2} y1={0.005} z0={-2.6} z1={2.6} m={MAT.nplus} />
      </Part>
      <Part phase="silicide" mode="drop" layer={3} sel={{ id: 'silicide', label: 'Silicide' }}>
        <Slab x0={-5.3} x1={-1.6} y0={0.005} y1={0.17} z0={-2.4} z1={2.4} m={MAT.silicide} />
        <Slab x0={1.6} x1={5.3} y0={0.005} y1={0.17} z0={-2.4} z1={2.4} m={MAT.silicide} />
        <Slab x0={-1} x1={1} y0={2.0} y1={2.16} z0={-2.5} z1={2.5} m={MAT.silicide} />
      </Part>
      <Part phase="contacts" mode="grow" layer={4} sel={{ id: 'contact', label: 'Contact plugs (W)' }}>
        <Slab x0={-3.9} x1={-3.1} y0={0.17} y1={3.4} z0={-0.4} z1={0.4} m={MAT.tungsten} />
        <Slab x0={3.1} x1={3.9} y0={0.17} y1={3.4} z0={-0.4} z1={0.4} m={MAT.tungsten} />
        <Slab x0={-0.4} x1={0.4} y0={2.16} y1={3.4} z0={-2.2} z1={-1.4} m={MAT.tungsten} />
        <Slab x0={-7} x1={7} y0={0} y1={3.4} z0={-3} z1={3} m={MAT.pmd} />
      </Part>
      <Part phase="m1" mode="drop" layer={5} sel={{ id: 'm1', label: 'Metal 1 (Cu)' }}>
        <Slab x0={-4.1} x1={-2.9} y0={3.4} y1={4.3} z0={-3} z1={3} m={MAT.copper} />
        <Slab x0={2.9} x1={4.1} y0={3.4} y1={4.3} z0={-3} z1={3} m={MAT.copper} />
        <Slab x0={-0.6} x1={0.6} y0={3.4} y1={4.3} z0={-3} z1={-1.0} m={MAT.copper} />
      </Part>
      <SourceDrainIons />
      <Clickable sel={{ kind: 'component', id: 'channel', label: 'Channel' }}>
        <Electrons paths={[{ y: -0.15, z: 0 }]} on={() => pp('m1') > 0.6} />
      </Clickable>
      <TechLabel position={[-5.8, 0.6, 3]} title="SOURCE" min={1} show={() => pp('sd') > 0.3} />
      <TechLabel position={[3.6, 0.6, 3]} title="DRAIN" min={1} show={() => pp('sd') > 0.3} />
      <TechLabel position={[-0.9, 2.6, 2.6]} title="GATE" min={1} show={() => pp('gate') > 0.3} />
      <TechLabel position={[-1.2, -0.9, 3.1]} title="CHANNEL" lines={['electrons flow when the gate is ON']} min={2} show={() => pp('m1') > 0.6} />
      <TechLabel position={[-7, 1.2, 3]} title="STI" min={2} show={() => pp('sti') > 0.3} />
      <TechLabel
        position={[-7, 5.2, 0]}
        title="PLANAR MOSFET · SIMPLIFIED MODEL"
        min={1}
        value={() => `${engine.player.view.phase.label} · gate length ≈ 20 nm (schematic) · 1 unit = 10 nm`}
      />
    </group>
  );
}

/* ---------------------------------------------------------------- compare: three architectures */

function GateField({ arrows }: { arrows: { p: V3; dir: V3 }[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  useFrame(() => {
    if (!ref.current) return;
    MAT.field.color.copy(gradeState.glow);
    const pulse = 0.85 + 0.15 * Math.sin(engine.time * 4);
    arrows.forEach((a, i) => {
      const d = new THREE.Vector3(...a.dir).normalize();
      q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
      o.position.set(...a.p);
      o.quaternion.copy(q);
      o.scale.set(0.22 * pulse, 0.5 * pulse, 0.22 * pulse);
      o.updateMatrix();
      ref.current!.setMatrixAt(i, o.matrix);
    });
    ref.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <Clickable sel={{ kind: 'component', id: 'field-lines', label: 'Gate control' }}>
      <instancedMesh ref={ref} args={[GEO.cone, MAT.field, arrows.length]} frustumCulled={false} />
    </Clickable>
  );
}

function Device({ x, phase, title, sides, children, field, paths, leak }: { x: number; phase: string; title: string; sides: string; children: ReactNode; field: { p: V3; dir: V3 }[]; paths: { y: number; z: number }[]; leak: number }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    const v = engine.player.view;
    const active = v.phaseId === phase || v.phaseId === 'compare';
    if (g.current) {
      const target = active ? 1 : 0.55;
      const s = g.current.scale.x + (target - g.current.scale.x) * 0.08;
      g.current.scale.setScalar(s);
      g.current.position.y = active ? 0 : -0.4;
    }
    if (v.phaseId === phase) track('focus', x, 1, 0);
    else if (v.phaseId === 'compare') track('focus', 0, 1, 0);
  });
  return (
    <group position={[x, 0, 0]}>
      <group ref={g}>
        {children}
        <GateField arrows={field} />
        <Electrons paths={paths} leak={leak} on={() => true} />
      </group>
      <TechLabel position={[-3, 5.2, 0]} title={title} lines={[sides]} min={1} />
    </group>
  );
}

function Compare() {
  const view = useView();
  const gm = view === 'xray' ? XRAY : MAT.gateGlass;
  return (
    <group>
      {/* PLANAR */}
      <Device
        x={-10}
        phase="planar"
        title="PLANAR"
        sides="gate on 1 side · leakage under the channel"
        leak={0.3}
        paths={[{ y: -0.15, z: 0 }]}
        field={[-1.6, 0, 1.6].map((z) => ({ p: [0, 0.9, z] as V3, dir: [0, -1, 0] as V3 }))}
      >
        <Clickable sel={{ kind: 'component', id: 'substrate', label: 'Silicon substrate' }}>
          <Slab x0={-3.5} x1={3.5} y0={-3} y1={0} z0={-2.6} z1={2.6} m={MAT.si} />
        </Clickable>
        <Slab x0={-3.5} x1={-1.5} y0={-1} y1={0.01} z0={-2.2} z1={2.2} m={MAT.nplus} />
        <Slab x0={1.5} x1={3.5} y0={-1} y1={0.01} z0={-2.2} z1={2.2} m={MAT.nplus} />
        <Slab x0={-1.1} x1={1.1} y0={0.01} y1={0.15} z0={-2.2} z1={2.2} m={MAT.gox} />
        <Clickable sel={{ kind: 'component', id: 'gate', label: 'Gate' }}>
          <mesh geometry={GEO.box} material={gm} scale={[2, 1.6, 4.4]} position={[0, 0.95, 0]} />
        </Clickable>
      </Device>
      {/* FINFET */}
      <Device
        x={0}
        phase="finfet"
        title="FinFET"
        sides="gate wraps 3 sides of the fin"
        leak={0.1}
        paths={[{ y: 1.2, z: 0 }, { y: 1.8, z: 0 }, { y: 0.7, z: 0 }]}
        field={[
          { p: [0, 3.4, 0], dir: [0, -1, 0] },
          { p: [0, 1.6, -1.4], dir: [0, 0, 1] },
          { p: [0, 1.6, 1.4], dir: [0, 0, -1] },
          { p: [0, 0.9, -1.4], dir: [0, 0, 1] },
          { p: [0, 0.9, 1.4], dir: [0, 0, -1] },
        ]}
      >
        <Slab x0={-3.5} x1={3.5} y0={-2} y1={0} z0={-2.6} z1={2.6} m={MAT.si} />
        <Slab x0={-3.5} x1={3.5} y0={0} y1={0.5} z0={-2.6} z1={-0.42} m={MAT.oxide} />
        <Slab x0={-3.5} x1={3.5} y0={0} y1={0.5} z0={0.42} z1={2.6} m={MAT.oxide} />
        <Clickable sel={{ kind: 'component', id: 'fin', label: 'Fin' }}>
          <Slab x0={-3.5} x1={3.5} y0={0} y1={2.4} z0={-0.4} z1={0.4} m={MAT.fin} />
        </Clickable>
        <Slab x0={-3.5} x1={-1.4} y0={0.5} y1={2.6} z0={-0.7} z1={0.7} m={MAT.nplus} />
        <Slab x0={1.4} x1={3.5} y0={0.5} y1={2.6} z0={-0.7} z1={0.7} m={MAT.nplus} />
        <Clickable sel={{ kind: 'component', id: 'gate', label: 'Gate (wraps the fin)' }}>
          <mesh geometry={GEO.box} material={gm} scale={[2.2, 3.0, 3.2]} position={[0, 2.0, 0]} />
        </Clickable>
      </Device>
      {/* GAA / NANOSHEET */}
      <Device
        x={10}
        phase="gaa"
        title="GAA · NANOSHEET"
        sides="gate surrounds every sheet (4 sides)"
        leak={0}
        paths={[0.9, 1.8, 2.7].map((y) => ({ y, z: 0 }))}
        field={[0.9, 1.8, 2.7].flatMap((y) => [
          { p: [0, y + 0.55, 0] as V3, dir: [0, -1, 0] as V3 },
          { p: [0, y - 0.55, 0] as V3, dir: [0, 1, 0] as V3 },
          { p: [0, y, -1.75] as V3, dir: [0, 0, 1] as V3 },
          { p: [0, y, 1.75] as V3, dir: [0, 0, -1] as V3 },
        ])}
      >
        <Slab x0={-3.5} x1={3.5} y0={-2} y1={0} z0={-2.6} z1={2.6} m={MAT.si} />
        <Slab x0={-3.5} x1={3.5} y0={0} y1={0.3} z0={-2.6} z1={2.6} m={MAT.oxide} />
        <Clickable sel={{ kind: 'component', id: 'nanosheet', label: 'Nanosheets' }}>
          {[0.9, 1.8, 2.7].map((y) => (
            <Slab key={y} x0={-1.4} x1={1.4} y0={y - 0.22} y1={y + 0.22} z0={-1.3} z1={1.3} m={MAT.fin} />
          ))}
        </Clickable>
        <Slab x0={-3.5} x1={-1.4} y0={0.3} y1={3.2} z0={-1.5} z1={1.5} m={MAT.nplus} />
        <Slab x0={1.4} x1={3.5} y0={0.3} y1={3.2} z0={-1.5} z1={1.5} m={MAT.nplus} />
        <Clickable sel={{ kind: 'component', id: 'gate', label: 'Gate (all around)' }}>
          <mesh geometry={GEO.box} material={gm} scale={[2.2, 3.4, 3.6]} position={[0, 1.95, 0]} />
        </Clickable>
      </Device>
      <TechLabel position={[-14, -3.2, 3]} title="ORANGE DOTS = OFF-STATE LEAKAGE (SCHEMATIC)" lines={['more gate surround → better control → less leakage']} min={2} />
    </group>
  );
}

export default function TransistorScene({ stage }: SceneProps) {
  const compare = stage.variant === 'compare';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0;
  }, []);
  return (
    <>
      <Lighting env="void" shadowExtent={16} />
      <VoidBackdrop y={-4.05} color="#33402f" />
      {compare ? <Compare /> : <PlanarBuild />}
    </>
  );
}
