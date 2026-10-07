'use client';
/**
 * Raw material → semiconductor-grade polysilicon (§11).
 * Four stations in one hall: quartz quarry/crusher · submerged arc furnace ·
 * hydrochlorination & distillation · Siemens reactor. Each has an atomic-scale inset.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, Hall } from '../environments';
import { M, shell } from '../materials';
import { B, C, GEO, Pipe, type V3 } from '../parts/primitives';
import { Clickable, SensorIndicator, TechLabel } from '../parts/interaction';
import { Inset, FlowLine } from '../parts/section';
import { AtomModel, silicaNetwork, tcsMolecule, diamondLattice, type Atom } from '../parts/atoms';
import { useUI } from '@/lib/store';
import { engine } from '@/simulation/engine';
import { pp, inPhase, pdt } from '@/lib/anim';
import { track, cutPlane } from '@/lib/runtime';
import { rng, smooth, clamp } from '@/lib/math';

const X = { quartz: -30, arc: -10, distill: 10, siemens: 30 };

const quartzMat = new THREE.MeshStandardMaterial({ color: '#e3e1d9', roughness: 0.55, metalness: 0.05 });
const mgSiMat = new THREE.MeshStandardMaterial({ color: '#7d8186', roughness: 0.45, metalness: 0.75 });
const polyMat = new THREE.MeshStandardMaterial({ color: '#8c9196', roughness: 0.35, metalness: 0.85 });
const moltenMat = new THREE.MeshStandardMaterial({ color: '#ffcf8a', emissive: new THREE.Color('#ff7a1a'), emissiveIntensity: 2.2, roughness: 0.3, toneMapped: false });
const refractory = new THREE.MeshStandardMaterial({ color: '#5a4a3e', roughness: 0.9 });
const belt = new THREE.MeshStandardMaterial({ color: '#202224', roughness: 0.85 });

const rockGeo = (() => {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const p = g.attributes.position;
  const r = rng(4);
  const seen = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    const f = seen.get(k) ?? 0.6 + r() * 0.8;
    seen.set(k, f);
    p.setXYZ(i, p.getX(i) * f, p.getY(i) * f * 0.8, p.getZ(i) * f);
  }
  g.computeVertexNormals();
  return g;
})();

function Comp({ id, machine, label, children, position }: { id: string; machine: string; label: string; children: React.ReactNode; position?: V3 }) {
  return (
    <Clickable sel={{ kind: 'component', id, machine, label }} position={position}>
      {children}
    </Clickable>
  );
}

/* ------------------------------------------------------------ path movers */

function pathPoint(path: V3[], t: number): THREE.Vector3 {
  const segs = path.length - 1;
  const x = clamp(t) * segs;
  const i = Math.min(segs - 1, Math.floor(x));
  const u = x - i;
  const a = path[i];
  const b = path[i + 1];
  return new THREE.Vector3(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
}

/* ------------------------------------------------------------ 1 · quartz */

function QuartzStation() {
  const cx = X.quartz;
  const pile = useMemo(() => {
    const r = rng(12);
    const m = new THREE.InstancedMesh(rockGeo, quartzMat, 90);
    const o = new THREE.Object3D();
    for (let i = 0; i < 90; i++) {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * 3;
      const s = 0.25 + r() * 0.35;
      o.position.set(cx - 7 + Math.cos(a) * d, s * 0.6 + (3 - d) * 0.5, -3 + Math.sin(a) * d * 0.8);
      o.rotation.set(r() * 3, r() * 3, r() * 3);
      o.scale.setScalar(s);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    }
    m.castShadow = true;
    return m;
  }, [cx]);
  const PATH: V3[] = [
    [cx - 5, 0.7, -1],
    [cx - 1.2, 2.6, -1],
    [cx - 0.2, 1.4, -1],
    [cx + 1.2, 0.55, -1],
    [cx + 4, 1.25, -1],
    [cx + 6.8, 0.9, -1],
    [cx + 8.5, 1.6, -1],
  ];
  const N = 46;
  const lumps = useMemo(() => {
    const m = new THREE.InstancedMesh(rockGeo, quartzMat, N);
    m.castShadow = true;
    m.frustumCulled = false;
    return m;
  }, []);
  const flywheel = useRef<THREE.Group>(null);
  const deck = useRef<THREE.Group>(null);
  const spray = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const time = useRef(0);
  useFrame((_, dt) => {
    const active = engine.stage.id === 'quartz';
    const d = active ? pdt(dt) : 0;
    time.current += d;
    const v = engine.player.view;
    const wash = active && inPhase('wash', v);
    for (let i = 0; i < N; i++) {
      const u = (time.current * 0.06 + i / N) % 1;
      const p = pathPoint(PATH, u);
      o.position.copy(p).add(new THREE.Vector3(0, 0.12, ((i * 37) % 7) * 0.04 - 0.12));
      o.rotation.set(i, i * 2, 0);
      o.scale.setScalar(u < 0.33 ? 0.22 : 0.09);
      o.updateMatrix();
      lumps.setMatrixAt(i, o.matrix);
      if (i === 0) track('focus', p.x, p.y + 0.3, p.z);
    }
    lumps.instanceMatrix.needsUpdate = true;
    if (flywheel.current) flywheel.current.rotation.z -= d * 4;
    if (deck.current) deck.current.position.y = 1.0 + (d > 0 ? Math.sin(time.current * 40) * 0.01 : 0);
    if (spray.current) {
      spray.current.visible = wash;
      for (let k = 0; k < 40; k++) {
        const ph = (time.current * 1.8 + k / 40) % 1;
        o.position.set(cx + 2.4 + (k % 8) * 0.3, 2.3 - ph * 1.1, -1.25 + (k % 5) * 0.12);
        o.scale.setScalar(0.025);
        o.updateMatrix();
        spray.current.setMatrixAt(k, o.matrix);
      }
      spray.current.instanceMatrix.needsUpdate = true;
    }
  });
  return (
    <group>
      <Clickable sel={{ kind: 'material', id: 'quartz', label: 'Quartz (SiO₂)' }}>
        <primitive object={pile} />
      </Clickable>
      <primitive object={lumps} />
      {/* conveyors */}
      {PATH.slice(0, -1).map((a, i) => {
        if (i === 1) return null;
        const b = PATH[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        return (
          <group key={i} position={[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, -1]} rotation={[0, 0, ang]}>
            <B s={[len, 0.05, 0.7]} m={belt} />
            <B s={[len, 0.12, 0.05]} m={M.frame} position={[0, -0.05, 0.38]} />
            <B s={[len, 0.12, 0.05]} m={M.frame} position={[0, -0.05, -0.38]} />
          </group>
        );
      })}
      {/* support legs */}
      {[[cx - 3, 1.4], [cx + 2.6, 0.8], [cx + 5.5, 1.0], [cx + 7.6, 1.2]].map(([x, h], i) => (
        <B key={i} s={[0.1, h as number, 0.9]} m={M.frame} position={[x as number, (h as number) / 2, -1]} />
      ))}
      {/* jaw crusher */}
      <Comp id="charge-feed" machine="arc-furnace" label="Jaw crusher">
        <B s={[1.6, 1.7, 1.5]} m={M.yellow} position={[cx - 0.4, 0.85, -1]} />
        <mesh position={[cx - 0.6, 2.05, -1]} rotation={[0, Math.PI / 4, 0]} material={M.steelDark}>
          <cylinderGeometry args={[1.0, 0.45, 0.8, 4, 1, true]} />
        </mesh>
        <group ref={flywheel} position={[cx - 0.4, 1.2, -0.12]}>
          <mesh rotation={[Math.PI / 2, 0, 0]} material={M.steelDark}>
            <torusGeometry args={[0.55, 0.06, 8, 32]} />
          </mesh>
          <B s={[1.1, 0.06, 0.06]} m={M.steelDark} />
          <B s={[0.06, 1.1, 0.06]} m={M.steelDark} />
        </group>
      </Comp>
      {/* vibrating screen with wash sprays */}
      <group ref={deck}>
        <B s={[2.8, 0.08, 1.1]} m={M.steel} position={[cx + 3.6, 0, -1]} rotation={[0, 0, 0.12]} />
      </group>
      <B s={[2.6, 0.06, 0.06]} m={M.steel} position={[cx + 3.5, 2.35, -1.25]} />
      <instancedMesh ref={spray} args={[GEO.sphereLow, new THREE.MeshBasicMaterial({ color: '#cfe8e0', transparent: true, opacity: 0.7 }), 40]} />
      {/* skip / truck to smelter */}
      <B s={[2.2, 1.0, 1.6]} m={M.orangeAccent} position={[cx + 9.6, 1.5, -1]} />
      <B s={[2.8, 0.5, 1.8]} m={M.panelDark} position={[cx + 9.6, 0.6, -1]} />
      {[cx + 8.6, cx + 10.6].map((x) => [-1.9, -0.1].map((z) => <C key={`${x}${z}`} r={0.35} h={0.25} m={M.rubber} position={[x, 0.35, z]} rotation={[Math.PI / 2, 0, 0]} />))}
      <TechLabel position={[cx - 7, 3.4, -3]} title="QUARTZITE STOCKPILE" lines={['high-purity silica (SiO₂)']} />
      <TechLabel position={[cx - 0.4, 3.0, -1]} title="CRUSHER" />
      <TechLabel position={[cx + 3.6, 2.7, -1]} title="SCREEN + WASH" lines={['fines & clay removed']} />
      <TechLabel position={[cx + 9.6, 2.5, -1]} title="TO SMELTER →" />
      {/* atomic inset */}
      <SilicaInset position={[-35, 3.0, 2]} mode="quartz" />
    </group>
  );
}

/* ------------------------------------------------------------ atomic insets */

function SilicaInset({ position, mode }: { position: V3; mode: 'quartz' | 'reduce' }) {
  const net = useMemo(() => silicaNetwork(2, 1.4), []);
  // carbon atoms that arrive and leave with oxygen as CO
  const carbons = useMemo(() => net.atoms.map((a, i) => (a.el === 'O' ? i : -1)).filter((i) => i >= 0), [net]);
  const atoms = useMemo<Atom[]>(() => (mode === 'reduce' ? [...net.atoms, ...carbons.map((i) => ({ p: net.atoms[i].p, el: 'C' as const }))] : net.atoms), [net, carbons, mode]);
  const bonds = net.bonds;
  const visible = useMemo(() => {
    if (mode !== 'reduce') return undefined;
    return (i: number, a: Atom): { visible: boolean; offset?: [number, number, number] } => {
      const k = pp('smelt');
      const crushed = pp('tap') > 0 || pp('crush') > 0 ? 1 : 0;
      const prog = Math.max(k, crushed);
      if (a.el === 'Si') return { visible: true };
      const idx = a.el === 'O' ? carbons.indexOf(i) : i - net.atoms.length;
      const start = (idx / carbons.length) * 0.75;
      const u = clamp((prog - start) / 0.25);
      if (a.el === 'C') {
        // carbon approaches from above, pairs with its oxygen, both leave upward
        const arrive = clamp(u * 2);
        const leave = clamp(u * 2 - 1);
        return { visible: u > 0 && leave < 1, offset: [0.12, (1 - arrive) * 0.8 + leave * 1.4, 0] };
      }
      const leave = clamp(u * 2 - 1);
      return { visible: leave < 1, offset: [0, leave * 1.4, 0] };
    };
  }, [mode, carbons, net]);
  return (
    <Inset id={`silica-${mode}`} position={position} size={[1.6, 1.25]} mpu={5.4e-10} title={mode === 'quartz' ? 'SiO₂ · TETRAHEDRAL NETWORK' : 'SiO₂ + 2C → Si + 2CO'}>
      <group position={[0, 0, 0.3]}>
        <AtomModel atoms={atoms} bonds={bonds} visibleFn={visible} scale={0.3} />
      </group>
    </Inset>
  );
}

function TcsInset({ position }: { position: V3 }) {
  const m = useMemo(() => tcsMolecule(0.55), []);
  return (
    <Inset id="tcs" position={position} size={[1.6, 1.25]} mpu={5e-10} title="SiHCl₃ · TRICHLOROSILANE (bp ≈ 32 °C)">
      <group position={[-0.35, 0, 0.3]}>
        <AtomModel atoms={m.atoms} bonds={m.bonds} spin={0.6} scale={0.42} />
      </group>
      <group position={[0.42, 0.18, 0.3]}>
        <AtomModel atoms={[{ p: [0, 0, 0], el: 'B' }, { p: [0.6, 0, 0], el: 'Cl' }, { p: [-0.3, 0.52, 0], el: 'Cl' }, { p: [-0.3, -0.52, 0], el: 'Cl' }]} bonds={[[0, 1], [0, 2], [0, 3]]} spin={0.9} scale={0.26} />
      </group>
      <group position={[0.42, -0.3, 0.3]}>
        <AtomModel atoms={[{ p: [0, 0, 0], el: 'P' }, { p: [0.6, -0.22, 0], el: 'Cl' }, { p: [-0.3, -0.22, 0.52], el: 'Cl' }, { p: [-0.3, -0.22, -0.52], el: 'Cl' }]} bonds={[[0, 1], [0, 2], [0, 3]]} spin={-0.7} scale={0.26} />
      </group>
      <TechLabel position={[0.42, 0.42, 0.3]} title="BCl₃ · bp 12.5 °C · LIGHT END" min={2} />
      <TechLabel position={[0.42, -0.1, 0.3]} title="PCl₃ · bp 76 °C · HEAVY END" min={2} />
    </Inset>
  );
}

function GrainsInset({ position }: { position: V3 }) {
  const lat = useMemo(() => diamondLattice(1, 1.0), []);
  const grains: { p: V3; r: V3 }[] = [
    { p: [-0.42, 0.05, 0.3], r: [0.3, 0.2, 0] },
    { p: [0.0, 0.1, 0.3], r: [0.9, 0.7, 0.4] },
    { p: [0.42, 0.0, 0.3], r: [0.1, 1.4, 0.8] },
  ];
  return (
    <Inset id="grains" position={position} size={[1.6, 1.25]} mpu={6e-10} title="POLYCRYSTALLINE · GRAINS WITH DIFFERENT ORIENTATIONS">
      {grains.map((g, i) => (
        <group key={i} position={g.p} rotation={g.r}>
          <AtomModel atoms={lat.atoms} bonds={lat.bonds} spin={0} scale={0.3} />
        </group>
      ))}
      <TechLabel position={[0, -0.45, 0.3]} title="ULTRA-PURE BUT NOT A SINGLE CRYSTAL → CZ GROWTH NEXT" min={2} />
    </Inset>
  );
}

/* ------------------------------------------------------------ 2 · arc furnace */

function ArcFurnace() {
  const cx = X.arc;
  const view = useUI((s) => s.view);
  const arcLight = useRef<THREE.PointLight>(null);
  const stream = useRef<THREE.Mesh>(null);
  const ladleFill = useRef<THREE.Mesh>(null);
  const charge = useRef<THREE.Mesh>(null);
  const smoke = useRef<THREE.InstancedMesh>(null);
  const chunks = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const r = useMemo(() => rng(31), []);
  const smokeSeed = useMemo(() => Array.from({ length: 60 }, () => ({ o: r(), x: (r() - 0.5) * 0.6 })), [r]);
  const clock = useRef(0);
  useFrame((_, dt) => {
    const active = engine.stage.id === 'mg-silicon';
    clock.current += active ? pdt(dt) : 0;
    const smelt = active ? pp('smelt') : 0;
    const tap = active ? pp('tap') : 0;
    const crush = active ? pp('crush') : 0;
    const hot = active && (engine.player.view.phaseId === 'smelt' || engine.player.view.phaseId === 'tap' || engine.player.view.phaseId === 'charge');
    if (arcLight.current) arcLight.current.intensity = hot ? 30 + 12 * Math.sin(clock.current * 31) * Math.sin(clock.current * 7) : 0;
    if (charge.current) {
      (charge.current.material as THREE.MeshStandardMaterial).emissiveIntensity = hot ? 1.2 + smelt : 0.15;
    }
    if (stream.current) stream.current.visible = active && engine.player.view.phaseId === 'tap';
    if (ladleFill.current) ladleFill.current.position.y = 0.6 + 0.65 * (tap > 0 ? Math.min(1, tap * 1.2) : 0) * (crush > 0 ? 0 : 1);
    if (ladleFill.current) ladleFill.current.visible = tap > 0 && crush === 0;
    if (smoke.current) {
      smokeSeed.forEach((s, i) => {
        const u = (clock.current * 0.25 + s.o) % 1;
        o.position.set(cx + 3.4 + s.x + u * 0.8, 6.5 + u * 4, -1.2 + s.x);
        o.scale.setScalar(hot ? 0.15 + u * 0.5 : 0.0001);
        o.updateMatrix();
        smoke.current!.setMatrixAt(i, o.matrix);
      });
      smoke.current.instanceMatrix.needsUpdate = true;
    }
    if (chunks.current) {
      for (let i = 0; i < 40; i++) {
        const show = crush > i / 40;
        o.position.set(cx + 3.2 + (i % 8) * 0.18, 0.55 + Math.floor(i / 8) * 0.1, 3.6 + ((i * 3) % 5) * 0.16);
        o.rotation.set(i, i * 1.7, 0);
        o.scale.setScalar(show ? 0.1 : 0.0001);
        o.updateMatrix();
        chunks.current.setMatrixAt(i, o.matrix);
      }
      chunks.current.instanceMatrix.needsUpdate = true;
    }
    if (active) track('focus', cx, 3.2, 0);
  });
  const shellM = shell(M.steelDark, view);
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'arc-furnace', label: 'Submerged arc furnace' }}>
        <B s={[8, 1.0, 8]} m={M.concrete} position={[cx, 0.5, 0]} />
        <Comp id="crucible" machine="arc-furnace" label="Refractory hearth">
          <C r={2.6} h={2.4} m={shellM} position={[cx, 2.2, 0]} />
          <C r={2.3} h={2.2} m={shell(refractory, view)} position={[cx, 2.25, 0]} />
          <mesh ref={charge} position={[cx, 3.1, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[2.25, 40]} />
            <meshStandardMaterial color="#5a3a24" emissive="#ff6a1a" emissiveIntensity={0.15} roughness={0.8} toneMapped={false} />
          </mesh>
        </Comp>
        <Comp id="electrodes" machine="arc-furnace" label="Graphite electrodes">
          {[0, 1, 2].map((k) => {
            const a = (k / 3) * Math.PI * 2 + Math.PI / 6;
            return (
              <group key={k} position={[cx + Math.cos(a) * 1.0, 0, Math.sin(a) * 1.0]}>
                <C r={0.32} h={5.2} m={M.graphite} position={[0, 5.3, 0]} />
                <C r={0.42} h={0.5} m={M.copper} position={[0, 5.4, 0]} />
                <B s={[0.12, 0.12, 2.2]} m={M.copper} position={[0, 5.4, -1.1]} />
              </group>
            );
          })}
        </Comp>
        <Comp id="hood" machine="arc-furnace" label="Fume hood">
          <mesh position={[cx, 4.2, 0]} material={shell(M.panelGrey, view)}>
            <cylinderGeometry args={[1.8, 2.8, 1.2, 32, 1, true]} />
          </mesh>
          <Pipe points={[[cx + 1.8, 4.6, -0.6], [cx + 3.4, 4.6, -1.2], [cx + 3.4, 6.5, -1.2]]} radius={0.45} m={M.steelDark} />
        </Comp>
        <Comp id="charge-feed" machine="arc-furnace" label="Charge feed chutes">
          <B s={[2.5, 1.6, 2.5]} m={M.panelGrey} position={[cx - 2.4, 8.4, -2.2]} />
          {[-0.4, 0.4].map((dz) => (
            <Pipe key={dz} points={[[cx - 2.0, 7.6, -1.8 + dz], [cx - 1.5, 4.8, -1.0 + dz]]} radius={0.12} m={M.steel} />
          ))}
        </Comp>
        <B s={[2.4, 2.6, 1.8]} m={M.panelGrey} position={[cx, 5.0, -4.5]} />
        <TechLabel position={[cx, 6.6, -4.5]} title="FURNACE TRANSFORMER" min={3} />
        <Comp id="tap-hole" machine="arc-furnace" label="Tap hole & ladle">
          <B s={[0.5, 0.25, 1.4]} m={refractory} position={[cx, 1.35, 3.0]} rotation={[0.25, 0, 0]} />
          <mesh ref={stream} position={[cx, 1.0, 3.8]} material={moltenMat} visible={false}>
            <cylinderGeometry args={[0.06, 0.09, 0.8, 12]} />
          </mesh>
          <C r={0.7} h={0.95} m={M.steelDark} position={[cx, 0.6 + 0.0, 4.3]} open />
          <C r={0.72} h={0.08} m={M.steelDark} position={[cx, 0.17, 4.3]} />
          <mesh ref={ladleFill} position={[cx, 0.6, 4.3]} rotation={[-Math.PI / 2, 0, 0]} material={moltenMat}>
            <circleGeometry args={[0.66, 32]} />
          </mesh>
        </Comp>
        <pointLight ref={arcLight} position={[cx, 3.5, 0]} color="#ff8a3a" distance={14} decay={1.5} />
      </Clickable>
      <instancedMesh ref={smoke} args={[GEO.sphereLow, new THREE.MeshStandardMaterial({ color: '#8a8f86', transparent: true, opacity: 0.25, depthWrite: false }), 60]} />
      <instancedMesh ref={chunks} args={[rockGeo, mgSiMat, 40]} castShadow />
      <B s={[1.4, 0.5, 1.0]} m={M.steelDark} position={[cx + 3.8, 0.25, 3.9]} />
      <SensorIndicator id="thermocouple" channel="temp" machine="arc-furnace" position={[cx + 2.65, 2.6, 0.6]} size={0.18} />
      <TechLabel position={[cx + 3.6, 10.8, -1.2]} title="OFF-GAS · CO → CO₂ + SILICA FUME → FILTER" min={2} />
      <TechLabel position={[cx, 8.2, 0]} title="3 GRAPHITE ELECTRODES · ~2000 °C" lines={['carbothermic reduction']} />
      <TechLabel position={[cx + 0.5, 1.9, 4.6]} title="TAP: LIQUID Si → LADLE" />
      <TechLabel position={[cx + 3.8, 1.2, 3.9]} title="MG-Si CHUNKS (~98–99 %)" />
      <SilicaInset position={[-15, 3.0, 2]} mode="reduce" />
    </group>
  );
}

/* ------------------------------------------------------------ 3 · distillation */

function Column({ x, z, r, h, label, id }: { x: number; z: number; r: number; h: number; label: string; id: string }) {
  const view = useUI((s) => s.view);
  return (
    <Comp id={id} machine="fbr-distillation" label={label}>
      <C r={r} h={h} m={shell(M.steel, view)} position={[x, h / 2, z]} />
      <mesh position={[x, h, z]} material={shell(M.steel, view)}>
        <sphereGeometry args={[r, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
      </mesh>
      {Array.from({ length: Math.floor(h / 0.6) }, (_, i) => (
        <C key={i} r={r * 0.92} h={0.025} m={M.steelDark} position={[x, 0.4 + i * 0.6, z]} />
      ))}
      {Array.from({ length: Math.floor(h / 2.5) }, (_, i) => (
        <mesh key={`p${i}`} position={[x, 2.5 + i * 2.5, z]} rotation={[-Math.PI / 2, 0, 0]} material={M.frame}>
          <ringGeometry args={[r + 0.02, r + 0.5, 32]} />
        </mesh>
      ))}
      <B s={[0.04, h, 0.3]} m={M.yellow} position={[x + r + 0.15, h / 2, z]} />
    </Comp>
  );
}

function Distillation() {
  const cx = X.distill;
  const bubbles = useRef<THREE.InstancedMesh>(null);
  const imp = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const t = useRef(0);
  useFrame((_, dt) => {
    const active = engine.stage.id === 'purification';
    t.current += active ? pdt(dt) : 0;
    const dist = active ? Math.max(pp('distill'), pp('store') > 0 ? 1 : 0) : 0;
    const on = active && (inPhase('distill') || inPhase('condense') || inPhase('react'));
    if (bubbles.current) {
      for (let i = 0; i < 80; i++) {
        const col = i % 2;
        const x = col ? cx + 3.5 : cx + 1;
        const h = col ? 8 : 10;
        const u = (t.current * 0.18 + i / 80) % 1;
        o.position.set(x + Math.sin(i * 7.3) * 0.3, 0.4 + u * (h - 0.8), -2 + Math.cos(i * 3.1) * 0.3);
        o.scale.setScalar(on ? 0.06 : 0.0001);
        o.updateMatrix();
        bubbles.current.setMatrixAt(i, o.matrix);
      }
      bubbles.current.instanceMatrix.needsUpdate = true;
    }
    if (imp.current) {
      // impurities: heavy ends sink to the bottom draw-off, light ends rise to the top vent
      for (let i = 0; i < 40; i++) {
        const heavy = i % 3 !== 0;
        const u = (t.current * 0.12 + i / 40) % 1;
        const y = heavy ? 9 - u * 8.6 : 1 + u * 7.0;
        const x = heavy ? cx + 1 : cx + 3.5;
        o.position.set(x + Math.sin(i * 5.1) * 0.35, y, -2 + Math.cos(i * 2.7) * 0.35);
        o.scale.setScalar(on && dist < 0.98 ? 0.07 : 0.0001);
        o.updateMatrix();
        imp.current.setMatrixAt(i, o.matrix);
        imp.current.setColorAt(i, new THREE.Color(heavy ? '#c9733a' : '#d6c35a'));
      }
      imp.current.instanceMatrix.needsUpdate = true;
      if (imp.current.instanceColor) imp.current.instanceColor.needsUpdate = true;
    }
    if (active) track('focus', cx + 1, 5, -2);
  });
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'fbr-distillation', label: 'Hydrochlorination & distillation train' }}>
        <Comp id="reactor" machine="fbr-distillation" label="Fluidised-bed reactor">
          <C r={0.75} h={5} m={M.steel} position={[cx - 4, 3.2, -1]} />
          <mesh position={[cx - 4, 0.4, -1]} material={M.steel}>
            <cylinderGeometry args={[0.75, 0.25, 0.8, 24]} />
          </mesh>
          <B s={[1.2, 1.2, 1.2]} m={M.panelGrey} position={[cx - 6, 6.2, -1]} />
          <Pipe points={[[cx - 5.4, 6.2, -1], [cx - 4, 6.2, -1], [cx - 4, 5.7, -1]]} radius={0.1} m={M.steel} />
        </Comp>
        <Comp id="condenser" machine="fbr-distillation" label="Condenser">
          <C r={0.45} h={3} m={M.alu} position={[cx - 1.5, 6.8, -1]} rotation={[0, 0, Math.PI / 2]} />
          {Array.from({ length: 10 }, (_, i) => (
            <C key={i} r={0.5} h={0.03} m={M.steelDark} position={[cx - 2.8 + i * 0.28, 6.8, -1]} rotation={[0, 0, Math.PI / 2]} />
          ))}
        </Comp>
        <Pipe points={[[cx - 4, 5.7, -1], [cx - 4, 6.8, -1], [cx - 3, 6.8, -1]]} radius={0.12} m={M.steel} />
        <Pipe points={[[cx - 0, 6.8, -1], [cx + 0.4, 6.8, -1], [cx + 0.4, 3, -2]]} radius={0.1} m={M.steel} />
        <Column x={cx + 1} z={-2} r={0.6} h={10} label="Distillation column 1 (heavy ends)" id="column" />
        <Column x={cx + 3.5} z={-2} r={0.5} h={8} label="Distillation column 2 (light ends)" id="column" />
        <Pipe points={[[cx + 1.6, 9.5, -2], [cx + 2.4, 9.5, -2], [cx + 2.4, 2, -2], [cx + 3, 2, -2]]} radius={0.09} m={M.steel} />
        <Comp id="storage" machine="fbr-distillation" label="Pure TCS storage">
          <C r={0.9} h={3.6} m={M.panel} position={[cx + 6.5, 1.3, 1]} rotation={[Math.PI / 2, 0, 0]} />
          {[-1.1, 1.1].map((dz) => (
            <B key={dz} s={[1.4, 0.5, 0.25]} m={M.frame} position={[cx + 6.5, 0.25, 1 + dz]} />
          ))}
        </Comp>
        <Pipe points={[[cx + 3.5, 4.5, -1.5], [cx + 5.2, 4.5, -1.5], [cx + 6.5, 2.4, 0]]} radius={0.09} m={M.steel} />
      </Clickable>
      <instancedMesh ref={bubbles} args={[GEO.sphereLow, new THREE.MeshStandardMaterial({ color: '#e6efd8', transparent: true, opacity: 0.6 }), 80]} />
      <instancedMesh ref={imp} args={[GEO.sphereLow, new THREE.MeshBasicMaterial({ color: '#ffffff' }), 40]} />
      <FlowLine points={[[cx + 5.2, 4.6, -1.5], [cx + 6.5, 2.6, 0]]} color="#cfe8b8" />
      <SensorIndicator id="thermocouple" channel="column" machine="fbr-distillation" position={[cx + 1.65, 9.6, -2]} size={0.16} />
      <SensorIndicator id="thermocouple" channel="reactor" machine="fbr-distillation" position={[cx - 3.2, 3.5, -1]} size={0.16} />
      <TechLabel position={[cx - 4, 6.9, -1]} title="FLUIDISED BED · Si + 3HCl → SiHCl₃ + H₂" />
      <TechLabel position={[cx + 1, 10.7, -2]} title="COLUMN 1 · HEAVY ENDS OUT BOTTOM" lines={['e.g. PCl₃, metal chlorides']} />
      <TechLabel position={[cx + 3.5, 8.7, -2]} title="COLUMN 2 · LIGHT ENDS OUT TOP" lines={['e.g. BCl₃']} />
      <TechLabel position={[cx + 6.5, 2.6, 1]} title="PURE SiHCl₃ → SIEMENS REACTOR" />
      <TcsInset position={[5, 3.0, 2]} />
    </group>
  );
}

/* ------------------------------------------------------------ 4 · Siemens */

function Siemens() {
  const cx = X.siemens;
  const view = useUI((s) => s.view);
  const jar = useRef<THREE.Group>(null);
  const rods = useRef<(THREE.Mesh | null)[]>([]);
  const rodMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8c9196', emissive: new THREE.Color('#ff7a2a'), emissiveIntensity: 0, roughness: 0.4, metalness: 0.7, toneMapped: false }), []);
  const bin = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const ROD_POS: [number, number][] = [
    [-0.55, -0.55],
    [-0.55, -0.15],
    [0.55, -0.55],
    [0.55, -0.15],
    [-0.55, 0.15],
    [-0.55, 0.55],
    [0.55, 0.15],
    [0.55, 0.55],
  ];
  useFrame(() => {
    const active = engine.stage.id === 'polysilicon';
    const T = active ? engine.tele.value('rodT', 60) : 60;
    const D = active ? engine.tele.value('rodD', 150) : 150;
    const harvest = active ? pp('harvest') : 0;
    rodMat.emissiveIntensity = Math.max(0, (T - 500) / 600) * 1.6;
    const rr = (D / 1000) / 2;
    rods.current.forEach((m, i) => {
      if (!m) return;
      if (i < 8) m.scale.set(rr, 2.3, rr);
      else m.scale.set(rr, 0.42, rr);
      m.visible = harvest < 0.6;
    });
    if (jar.current) jar.current.position.y = 3.6 * smooth(harvest * 1.6);
    if (bin.current) {
      for (let i = 0; i < 60; i++) {
        o.position.set(cx + 2.6 + (i % 6) * 0.2, 0.75 + Math.floor(i / 12) * 0.12, 1.6 + Math.floor((i % 12) / 6) * 0.25 + ((i * 7) % 3) * 0.05);
        o.rotation.set(i, i * 2.3, i * 0.7);
        o.scale.setScalar(harvest > 0.55 + (i / 60) * 0.4 || !active ? 0.09 : 0.0001);
        o.updateMatrix();
        bin.current.setMatrixAt(i, o.matrix);
      }
      bin.current.instanceMatrix.needsUpdate = true;
    }
    if (active) track('focus', cx, 2.2, 0);
  });
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'siemens-reactor', label: 'Siemens CVD reactor' }}>
        <B s={[3.6, 0.8, 3.6]} m={M.frame} position={[cx, 0.4, 0]} />
        <Comp id="electrodes" machine="siemens-reactor" label="Base-plate electrodes">
          <C r={1.65} h={0.3} m={M.steel} position={[cx, 0.95, 0]} />
          {ROD_POS.map(([x, z], i) => (
            <C key={i} r={0.06} h={0.5} m={M.copper} position={[cx + x, 0.55, z]} />
          ))}
        </Comp>
        <Comp id="gas-inlet" machine="siemens-reactor" label="Gas inlet nozzles">
          <C r={0.05} h={0.3} m={M.steelDark} position={[cx, 1.2, 0]} />
          <Pipe points={[[cx, 0.6, 0], [cx, 0.3, 0], [cx + 2.5, 0.3, 0]]} radius={0.07} m={M.steel} />
        </Comp>
        <Comp id="rods" machine="siemens-reactor" label="Silicon rods (U-shaped pairs)">
          {ROD_POS.map(([x, z], i) => (
            <mesh key={i} ref={(m) => { rods.current[i] = m; }} geometry={GEO.cyl} material={rodMat} position={[cx + x, 1.1 + 1.15, z]} castShadow />
          ))}
          {[0, 2, 4, 6].map((k, j) => {
            const [x1, z1] = ROD_POS[k];
            const [, z2] = ROD_POS[k + 1];
            return <mesh key={`b${j}`} ref={(m) => { rods.current[8 + j] = m; }} geometry={GEO.cyl} material={rodMat} position={[cx + x1, 3.4, (z1 + z2) / 2]} rotation={[Math.PI / 2, 0, 0]} />;
          })}
        </Comp>
        <group ref={jar}>
          <Comp id="bell-jar" machine="siemens-reactor" label="Bell jar">
            <C r={1.5} h={2.9} m={shell(M.steel, view)} position={[cx, 2.55, 0]} open />
            <mesh position={[cx, 4.0, 0]} material={shell(M.steel, view)}>
              <sphereGeometry args={[1.5, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
            </mesh>
            <C r={0.18} h={0.1} m={M.glassDark} position={[cx + 1.5, 2.6, 0]} rotation={[0, 0, Math.PI / 2]} />
            {[1.6, 2.3, 3.0, 3.7].map((y) => (
              <mesh key={y} position={[cx, y, 0]} rotation={[Math.PI / 2, 0, 0]} material={M.steelDark}>
                <torusGeometry args={[1.52, 0.035, 8, 48]} />
              </mesh>
            ))}
            <C r={0.05} h={2.4} m={M.steelDark} position={[cx, 6.6, 0]} />
          </Comp>
        </group>
      </Clickable>
      <B s={[1.5, 0.6, 1.0]} m={M.yellow} position={[cx + 3.1, 0.3, 1.85]} />
      <instancedMesh ref={bin} args={[rockGeo, polyMat, 60]} castShadow />
      <SensorIndicator id="pyrometer" channel="rodT" machine="siemens-reactor" position={[cx + 1.7, 2.6, 0.25]} size={0.14} />
      <SensorIndicator id="mfc" channel="tcs" machine="siemens-reactor" position={[cx + 2.3, 0.45, 0.2]} size={0.12} />
      <TechLabel position={[cx, 5.8, 0]} title="BELL JAR · ROD SURFACE ≈ 1100 °C" lines={['SiHCl₃ + H₂ → Si + 3HCl']} />
      <TechLabel position={[cx + 3.1, 1.3, 1.85]} title="POLYSILICON CHUNKS · 9N–11N" />
      <GrainsInset position={[25, 3.0, 2]} />
    </group>
  );
}

/* ------------------------------------------------------------ scene */

export default function MaterialsScene({ stage }: SceneProps) {
  const variant = stage.variant ?? 'quartz';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.05;
  }, []);
  const cx = X[variant as keyof typeof X] ?? 0;
  return (
    <>
      <Lighting env="hall" shadowExtent={22} center={[cx, 0, 0]} />
      <Hall width={92} depth={30} height={14} />
      <QuartzStation />
      <ArcFurnace />
      <Distillation />
      <Siemens />
      {/* the material route through the hall */}
      <FlowLine points={[[-20, 0.05, 6], [-10, 0.05, 6], [10, 0.05, 6], [30, 0.05, 6]]} color="#c8d8a6" speed={1.2} width={2} />
      <TechLabel position={[0, 0.4, 6.4]} title="MATERIAL FLOW · QUARTZ → MG-Si → TCS → POLYSILICON" min={2} tone="accent" />
    </>
  );
}
