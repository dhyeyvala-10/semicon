'use client';
/**
 * Powers of ten (§9, §59).
 *   dive:   building → cleanroom → tool → wafer → die → metal layers → transistor → atoms
 *   finale: transistor → billions on a die → hundreds of dies on a wafer → the fab → the world
 * Each level is modelled at a normalised size; the scale bar reports its real size, and the
 * camera "flies" between levels by zooming into (or out of) the focus point. SCHEMATIC.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting } from '../environments';
import { GEO } from '../parts/primitives';
import { TechLabel } from '../parts/interaction';
import { AtomModel, diamondLattice } from '../parts/atoms';
import { useEarthTexture } from '../parts/earth';
import { waferTexture, dieFloorplan } from '../textures';
import { engine } from '@/simulation/engine';
import { scaleRegions, track, gradeState } from '@/lib/runtime';
import { clamp, smooth, rng, formatLength } from '@/lib/math';

const std = (color: string, p: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1, ...p });

/* ---------------------------------------------------------------- level wrapper */

interface Ctx {
  order: string[];
  zoomOut: boolean;
}

/**
 * One scale level. Visible while its phase (or the transition into it) is active. During the
 * last 35 % of a phase the current level zooms past the camera (dive) or shrinks into the next
 * (zoom out) while the next level fades in. Materials are cloned so they can fade.
 */
function Level({ id, ctx, meters, children }: { id: string; ctx: Ctx; meters: number; children: ReactNode }) {
  const g = useRef<THREE.Group>(null);
  const mats = useRef<THREE.Material[] | null>(null);
  const i = ctx.order.indexOf(id);
  useFrame(() => {
    const grp = g.current;
    if (!grp) return;
    if (!mats.current) {
      const list: THREE.Material[] = [];
      grp.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const swap = (x: THREE.Material) => {
          const c = x.clone();
          c.transparent = true;
          list.push(c);
          return c;
        };
        m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material);
      });
      mats.current = list;
    }
    const v = engine.player.view;
    const ci = Math.max(0, ctx.order.indexOf(v.phaseId));
    const t = v.phaseT;
    const e = smooth(clamp((t - 0.65) / 0.35));
    const last = ci === ctx.order.length - 1;
    let scale = 1;
    let op = 0;
    if (i === ci) {
      op = last ? 1 : 1 - e;
      scale = ctx.zoomOut ? (last ? 1 : 1 / Math.pow(6, e)) : 1 + 0.12 * t + (last ? 0 : Math.pow(7, e) - 1);
    } else if (i === ci + 1 && !last) {
      op = e;
      scale = ctx.zoomOut ? 6 - 5 * e : 0.14 + 0.86 * e;
    }
    grp.visible = op > 0.01;
    grp.scale.setScalar(scale);
    for (const m of mats.current) {
      m.opacity = op;
      m.depthWrite = op > 0.95;
    }
    if (i === ci) {
      // scale bar: this level's real size spans ~0.9 units at scale 1
      const r = scaleRegions.get('powers');
      if (r) r.mpu = meters / (0.9 * scale);
    }
  });
  return <group ref={g}>{children}</group>;
}

/* ---------------------------------------------------------------- level models (≈0.9 units wide) */

function Building() {
  const wall = useMemo(() => std('#c9ccc5'), []);
  const roof = useMemo(() => std('#8d938c'), []);
  const ground = useMemo(() => std('#2c352d', { roughness: 0.95 }), []);
  return (
    <group>
      <mesh geometry={GEO.box} material={ground} scale={[1.6, 0.005, 1.1]} position={[0, -0.13, 0]} />
      <mesh geometry={GEO.box} material={wall} scale={[0.6, 0.16, 0.36]} position={[0, -0.05, 0]} />
      <mesh geometry={GEO.box} material={roof} scale={[0.62, 0.01, 0.38]} position={[0, 0.035, 0]} />
      <mesh geometry={GEO.box} material={wall} scale={[0.18, 0.1, 0.2]} position={[0.45, -0.08, -0.04]} />
      {[-0.2, -0.1, 0, 0.1, 0.2].map((x) => (
        <mesh key={x} geometry={GEO.box} material={roof} scale={[0.06, 0.025, 0.04]} position={[x, 0.05, -0.1]} />
      ))}
      {[0, 1, 2].map((k) => (
        <mesh key={k} geometry={GEO.cyl} material={wall} scale={[0.015, 0.12, 0.015]} position={[-0.42 + k * 0.04, -0.07, 0.2]} />
      ))}
    </group>
  );
}

function Room() {
  const floor = useMemo(() => std('#c9ccc9'), []);
  const tool = useMemo(() => std('#c8c3b4'), []);
  const accent = useMemo(() => std('#6b7a3c'), []);
  const rail = useMemo(() => std('#6f757b', { metalness: 0.8 }), []);
  const light = useMemo(() => std('#ffffff', { emissive: new THREE.Color('#f2f5f7'), emissiveIntensity: 0.8 }), []);
  return (
    <group position={[0, -0.12, 0]}>
      <mesh geometry={GEO.box} material={floor} scale={[1.1, 0.005, 0.7]} />
      {Array.from({ length: 6 }, (_, i) =>
        [-1, 1].map((s) => (
          <group key={`${i}${s}`}>
            <mesh geometry={GEO.box} material={tool} scale={[0.1, 0.1, 0.13]} position={[-0.4 + i * 0.16, 0.05, s * 0.16]} />
            <mesh geometry={GEO.box} material={accent} scale={[0.1, 0.01, 0.13]} position={[-0.4 + i * 0.16, 0.08, s * 0.16]} />
          </group>
        )),
      )}
      <mesh geometry={GEO.box} material={rail} scale={[1.0, 0.008, 0.01]} position={[0, 0.2, 0]} />
      {Array.from({ length: 8 }, (_, i) => (
        <mesh key={i} geometry={GEO.box} material={light} scale={[0.1, 0.004, 0.1]} position={[-0.42 + i * 0.12, 0.27, -0.25]} />
      ))}
    </group>
  );
}

function Tool() {
  const panel = useMemo(() => std('#c9ccc5'), []);
  const steel = useMemo(() => std('#b9bec4', { metalness: 0.9, roughness: 0.3 }), []);
  const dark = useMemo(() => std('#2a2e33'), []);
  return (
    <group position={[0, -0.15, 0]}>
      <mesh geometry={GEO.box} material={dark} scale={[0.8, 0.12, 0.6]} position={[0, 0.06, 0]} />
      <mesh geometry={GEO.box} material={panel} scale={[0.18, 0.4, 0.45]} position={[-0.4, 0.2, 0]} />
      <mesh material={steel} position={[0, 0.2, 0]}>
        <cylinderGeometry args={[0.16, 0.16, 0.12, 6]} />
      </mesh>
      {[0, 1, 2].map((k) => {
        const a = -Math.PI / 2 + k * (Math.PI / 2);
        return <mesh key={k} geometry={GEO.cyl} material={steel} scale={[0.1, 0.14, 0.1]} position={[Math.cos(a) * 0.3, 0.2, Math.sin(a) * 0.3]} />;
      })}
    </group>
  );
}

function Wafer() {
  const tex = useMemo(() => waferTexture('dies', { size: 1024 }), []);
  const m = useMemo(() => new THREE.MeshStandardMaterial({ map: tex, roughness: 0.15, metalness: 0.6 }), [tex]);
  return (
    <mesh rotation={[-Math.PI / 2 + 0.25, 0, 0]} material={m}>
      <circleGeometry args={[0.45, 96]} />
    </mesh>
  );
}

function Die({ dense = false }: { dense?: boolean }) {
  const top = useMemo(() => {
    if (!dense) return new THREE.MeshStandardMaterial({ map: dieFloorplan('cpu'), roughness: 0.3, metalness: 0.35 });
    // "billions of transistors": a dense, fine grid over the floorplan
    const base = dieFloorplan('cpu').image as HTMLCanvasElement;
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const g = c.getContext('2d')!;
    g.drawImage(base, 0, 0, 1024, 1024);
    g.strokeStyle = 'rgba(220,235,200,0.10)';
    for (let i = 0; i < 1024; i += 3) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i, 1024);
      g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.3, metalness: 0.35 });
  }, [dense]);
  const side = useMemo(() => std('#4a5560', { metalness: 0.5 }), []);
  return <mesh geometry={GEO.box} material={[side, side, top, side, side, side]} scale={[0.7, 0.03, 0.89]} rotation={[0.25, 0, 0]} />;
}

function Layers() {
  const cu = useMemo(() => std('#c47b4a', { metalness: 1, roughness: 0.25 }), []);
  const diel = useMemo(() => std('#bcd3b0', { transparent: true, opacity: 0.3 }), []);
  const si = useMemo(() => std('#5f676f', { metalness: 0.5 }), []);
  const levels = [0.025, 0.025, 0.03, 0.035, 0.045, 0.055, 0.075, 0.1];
  let y = -0.28;
  return (
    <group rotation={[0.2, -0.5, 0]}>
      <mesh geometry={GEO.box} material={si} scale={[0.8, 0.08, 0.5]} position={[0, -0.32, 0]} />
      {levels.map((h, k) => {
        const y0 = y;
        y += h + 0.02;
        const pitch = 0.05 + k * 0.025;
        const n = Math.floor(0.76 / pitch);
        return (
          <group key={k}>
            <mesh geometry={GEO.box} material={diel} scale={[0.8, h, 0.5]} position={[0, y0 + h / 2, 0]} />
            {Array.from({ length: n }, (_, j) =>
              k % 2 ? (
                <mesh key={j} geometry={GEO.box} material={cu} scale={[pitch * 0.5, h, 0.5]} position={[-0.38 + pitch / 2 + j * pitch, y0 + h / 2, 0]} />
              ) : (
                <mesh key={j} geometry={GEO.box} material={cu} scale={[0.8, h, Math.min(pitch * 0.5, 0.05)]} position={[0, y0 + h / 2, -0.22 + j * Math.min(pitch, 0.1)]} />
              ),
            )}
          </group>
        );
      })}
    </group>
  );
}

function Transistor() {
  const si = useMemo(() => std('#5f676f', { metalness: 0.5 }), []);
  const fin = useMemo(() => std('#9aa3ad', { metalness: 0.4 }), []);
  const gate = useMemo(() => std('#b49a72', { metalness: 0.4 }), []);
  const sd = useMemo(() => std('#4f8f5e'), []);
  return (
    <group rotation={[0.25, -0.6, 0]} position={[0, -0.05, 0]}>
      <mesh geometry={GEO.box} material={si} scale={[0.8, 0.12, 0.5]} position={[0, -0.2, 0]} />
      <mesh geometry={GEO.box} material={fin} scale={[0.8, 0.22, 0.08]} position={[0, -0.03, 0]} />
      <mesh geometry={GEO.box} material={gate} scale={[0.18, 0.3, 0.42]} position={[0, 0.02, 0]} />
      <mesh geometry={GEO.box} material={sd} scale={[0.22, 0.26, 0.16]} position={[-0.3, -0.02, 0]} />
      <mesh geometry={GEO.box} material={sd} scale={[0.22, 0.26, 0.16]} position={[0.3, -0.02, 0]} />
    </group>
  );
}

function Nano() {
  const lat = useMemo(() => diamondLattice(2, 1.0), []);
  return (
    <group rotation={[0.3, 0.6, 0]} position={[-0.32, -0.32, -0.32]}>
      <AtomModel atoms={lat.atoms} bonds={lat.bonds} scale={0.32} spin={0.08} />
    </group>
  );
}

function World() {
  const tex = useEarthTexture();
  const m = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.85, color: '#ffffff' }), []);
  const arcsRef = useRef<THREE.Group>(null);
  const sphere = useRef<THREE.Mesh>(null);
  useEffect(() => {
    // the Level wrapper may have swapped in a fading clone — set the map on whatever is live
    const live = (sphere.current?.material as THREE.MeshStandardMaterial | undefined) ?? m;
    if (tex) {
      live.map = tex;
      live.needsUpdate = true;
    }
  }, [tex, m]);
  const arcs = useMemo(() => {
    const r = rng(9);
    return Array.from({ length: 26 }, () => {
      const a = new THREE.Vector3(r() - 0.5, r() * 0.8 - 0.2, r() - 0.5).normalize();
      const b = new THREE.Vector3(r() - 0.5, r() * 0.8 - 0.2, r() - 0.5).normalize();
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 32; i++) {
        const t = i / 32;
        pts.push(a.clone().lerp(b, t).normalize().multiplyScalar(0.36 * (1 + 0.15 * Math.sin(Math.PI * t))));
      }
      return new THREE.BufferGeometry().setFromPoints(pts);
    });
  }, []);
  const lineMat = useMemo(() => new THREE.LineBasicMaterial({ color: '#d9f29a', transparent: true, opacity: 0.8 }), []);
  const lines = useMemo(() => arcs.map((g) => new THREE.Line(g, lineMat)), [arcs, lineMat]);
  useFrame((_, dt) => {
    if (arcsRef.current) arcsRef.current.rotation.y += dt * 0.08;
    lineMat.color.copy(gradeState.glow);
  });
  return (
    <group ref={arcsRef} rotation={[0.35, 0, 0]}>
      <mesh ref={sphere} material={m}>
        <sphereGeometry args={[0.36, 64, 48]} />
      </mesh>
      {lines.map((l, i) => (
        <primitive key={i} object={l} />
      ))}
    </group>
  );
}

/* ---------------------------------------------------------------- scene */

const DIVE: { id: string; title: string; meters: number; node: () => ReactNode }[] = [
  { id: 'building', title: 'FAB BUILDING', meters: 150, node: () => <Building /> },
  { id: 'room', title: 'CLEANROOM BAY', meters: 25, node: () => <Room /> },
  { id: 'machine', title: 'PROCESS TOOL', meters: 3, node: () => <Tool /> },
  { id: 'wafer', title: '300 mm WAFER', meters: 0.3, node: () => <Wafer /> },
  { id: 'die', title: 'ONE DIE', meters: 0.015, node: () => <Die /> },
  { id: 'layer', title: 'METAL LAYERS', meters: 1e-5, node: () => <Layers /> },
  { id: 'transistor', title: 'TRANSISTOR', meters: 5e-8, node: () => <Transistor /> },
  { id: 'nano', title: 'SILICON ATOMS', meters: 1.2e-9, node: () => <Nano /> },
];

const FINALE: { id: string; title: string; meters: number; node: () => ReactNode }[] = [
  { id: 'transistor', title: 'ONE TRANSISTOR', meters: 5e-8, node: () => <Transistor /> },
  { id: 'die', title: 'BILLIONS ON ONE DIE', meters: 0.015, node: () => <Die dense /> },
  { id: 'wafer', title: 'HUNDREDS OF DIES PER WAFER', meters: 0.3, node: () => <Wafer /> },
  { id: 'fab', title: 'ONE FAB', meters: 150, node: () => <Building /> },
  { id: 'world', title: 'A GLOBAL INDUSTRY', meters: 1.27e7, node: () => <World /> },
];

export default function ScaleScene({ stage }: SceneProps) {
  const finale = stage.variant === 'finale';
  const levels = finale ? FINALE : DIVE;
  const ctx = useMemo<Ctx>(() => ({ order: levels.map((l) => l.id), zoomOut: finale }), [levels, finale]);
  useEffect(() => {
    scaleRegions.set('powers', { id: 'powers', center: new THREE.Vector3(0, 0, 0), radius: 3, mpu: 1, label: 'SCHEMATIC' });
    return () => {
      scaleRegions.delete('powers');
    };
  }, []);
  useFrame(() => track('focus', 0, 0, 0));
  return (
    <>
      <Lighting env="void" shadowExtent={2} />
      {levels.map((l) => (
        <Level key={l.id} id={l.id} ctx={ctx} meters={l.meters}>
          {l.node()}
        </Level>
      ))}
      <TechLabel
        position={[-0.62, 0.42, 0]}
        title={finale ? 'ZOOMING OUT' : 'POWERS OF TEN'}
        min={1}
        value={() => {
          const v = engine.player.view;
          const l = levels.find((x) => x.id === v.phaseId) ?? levels[0];
          return `${l.title} · ≈ ${formatLength(l.meters)}`;
        }}
      />
    </>
  );
}
