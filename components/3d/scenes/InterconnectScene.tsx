'use client';
/**
 * Back end of line (§36–§39) — 1 world unit = 100 nm. SCHEMATIC proportions.
 *   contacts:    pre-metal dielectric → contact holes → Ti/TiN liner → tungsten fill → W CMP
 *   damascene:   low-k → trench pattern → trench etch → barrier/seed → Cu plating (bottom-up) → Cu CMP
 *   stack:       M1 → M12, each level thicker and wider; toggle levels to look inside
 *   passivation: top pads → SiN/oxide → pad windows → polyimide
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, VoidBackdrop } from '../environments';
import { shell, XRAY } from '../materials';
import { GEO } from '../parts/primitives';
import { Clickable, TechLabel } from '../parts/interaction';
import { engine } from '@/simulation/engine';
import { pp, inPhase, pdt } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { clamp, smooth, rng, lerp } from '@/lib/math';
import type { ViewMode } from '@/types';

const std = (color: string, p: THREE.MeshPhysicalMaterialParameters = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.4, metalness: 0.05, ...p });
const MAT = {
  si: std('#5f676f', { roughness: 0.35, metalness: 0.5 }),
  nplus: std('#4f8f5e'),
  gate: std('#a58a6a', { metalness: 0.5, roughness: 0.35 }),
  pmd: std('#d4e4cc', { roughness: 0.1, transparent: true, opacity: 0.22, depthWrite: false }),
  lowk: std('#bcd3b0', { roughness: 0.15, transparent: true, opacity: 0.3, depthWrite: false }),
  hole: std('#1b211c', { roughness: 0.9 }),
  liner: std('#9a8e6a', { metalness: 0.7, roughness: 0.3 }),
  tungsten: std('#8c8f94', { metalness: 0.9, roughness: 0.3 }),
  copper: std('#c47b4a', { metalness: 1, roughness: 0.22 }),
  barrier: std('#5d5446', { metalness: 0.8, roughness: 0.35 }),
  resist: std('#b5612a', { roughness: 0.3, transparent: true, opacity: 0.9 }),
  electrolyte: std('#9fc3b0', { roughness: 0.05, transparent: true, opacity: 0.18, depthWrite: false }),
  ion: new THREE.MeshBasicMaterial({ color: '#e0a070', toneMapped: false }),
  pad: std('#c9c6bf', { metalness: 0.85, roughness: 0.3 }),
  sin: std('#d8cfae', { roughness: 0.4, transparent: true, opacity: 0.85 }),
  polyimide: std('#b8742e', { roughness: 0.35, transparent: true, opacity: 0.75 }),
};
const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);

/** Box from bounds; bottom-anchored so y-scaling grows from the base. */
function Bx({ x0, x1, y0, y1, z0, z1, m, sx = 1, sy = 1 }: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; m: THREE.Material; sx?: number; sy?: number }) {
  return (
    <group position={[(x0 + x1) / 2, y0, (z0 + z1) / 2]} scale={[sx, sy, 1]}>
      <mesh geometry={GEO.box} material={m} scale={[x1 - x0, y1 - y0, z1 - z0]} position={[0, (y1 - y0) / 2, 0]} castShadow receiveShadow />
    </group>
  );
}

/** A group whose y-scale (from its base at y0) follows a 0..1 function every frame. */
function Grow({ k, y0 = 0, children, fade }: { k: () => number; y0?: number; children: ReactNode; fade?: boolean }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!g.current) return;
    const v = clamp(k());
    g.current.visible = v > 0.002;
    if (!fade) {
      g.current.scale.y = Math.max(0.002, v);
      g.current.position.y = y0 * (1 - Math.max(0.002, v));
    }
  });
  return <group ref={g}>{children}</group>;
}

function useMat(m: THREE.Material): THREE.Material {
  const view: ViewMode = useUI((s) => s.view);
  if (view === 'xray' && (m === MAT.si || m === MAT.nplus || m === MAT.gate)) return XRAY;
  return shell(m, view === 'xray' ? 'normal' : view);
}

/** The transistor row at the bottom of every BEOL view (context). */
function DeviceRow({ w = 6 }: { w?: number }) {
  const si = useMat(MAT.si);
  const gate = useMat(MAT.gate);
  return (
    <Clickable sel={{ kind: 'component', id: 'substrate', label: 'Transistors (FEOL)' }}>
      <Bx x0={-w} x1={w} y0={-1.2} y1={0} z0={-3} z1={3} m={si} />
      {[-3.5, 0, 3.5].map((x) => (
        <group key={x}>
          <Bx x0={x - 0.2} x1={x + 0.2} y0={0} y1={0.6} z0={-2.2} z1={2.2} m={gate} />
          <Bx x0={x - 1.4} x1={x - 0.35} y0={-0.4} y1={0.005} z0={-2.2} z1={2.2} m={MAT.nplus} />
          <Bx x0={x + 0.35} x1={x + 1.4} y0={-0.4} y1={0.005} z0={-2.2} z1={2.2} m={MAT.nplus} />
        </group>
      ))}
    </Clickable>
  );
}

/* ================================================================ contacts */

const CONTACTS: [number, number][] = [-5.25, -1.75, 1.75, 5.25].flatMap((x) => [[x, -1.2] as [number, number], [x, 1.2] as [number, number]]);
const PMD_TOP = 2.2;

function Contacts() {
  const pmd = useMat(MAT.pmd);
  const wMat = useMat(MAT.tungsten);
  useFrame(() => track('focus', 0, 1.2, 0));
  return (
    <group>
      <DeviceRow />
      <Grow k={() => smooth(pp('pmd'))}>
        <Clickable sel={{ kind: 'component', id: 'pmd', label: 'Pre-metal dielectric' }}>
          <Bx x0={-6} x1={6} y0={0} y1={PMD_TOP} z0={-3} z1={3} m={pmd} />
        </Clickable>
      </Grow>
      {CONTACTS.map(([x, z]) => (
        <group key={`${x}${z}`} position={[x, 0, z]}>
          {/* hole etched from the top down */}
          <Grow k={() => (pp('fill') >= 1 ? 0 : smooth(pp('etch')))} y0={PMD_TOP}>
            <mesh geometry={GEO.cyl} material={MAT.hole} scale={[0.26, PMD_TOP, 0.26]} position={[0, PMD_TOP / 2, 0]} />
          </Grow>
          <Grow k={() => smooth(pp('liner'))}>
            <mesh geometry={GEO.cylOpen} material={MAT.liner} scale={[0.28, PMD_TOP, 0.28]} position={[0, PMD_TOP / 2, 0]} />
          </Grow>
          <Grow k={() => smooth(clamp(pp('fill') * 1.4))}>
            <Clickable sel={{ kind: 'component', id: 'contact', label: 'Tungsten contact plug' }}>
              <mesh geometry={GEO.cyl} material={wMat} scale={[0.25, PMD_TOP, 0.25]} position={[0, PMD_TOP / 2, 0]} />
            </Clickable>
          </Grow>
        </group>
      ))}
      {/* tungsten overburden: grows at the end of fill, polished away by CMP */}
      <Grow k={() => smooth(clamp((pp('fill') - 0.6) / 0.4)) * (1 - smooth(pp('cmp')))} y0={PMD_TOP}>
        <Bx x0={-6} x1={6} y0={PMD_TOP} y1={PMD_TOP + 0.35} z0={-3} z1={3} m={wMat} />
      </Grow>
      <TechLabel position={[-6, PMD_TOP + 1.2, 3]} title="CONTACTS · MOL" min={1} value={() => `${engine.player.view.phase.label} · ${engine.tele.value('filled', 0).toFixed(0)} % filled`} />
      <TechLabel position={[6.2, 1.2, 1.2]} title="W PLUG · ~50 nm Ø" lines={['schematic proportions']} min={2} show={() => pp('fill') > 0.3} />
    </group>
  );
}

/* ================================================================ damascene */

const TRENCHES = [-3.5, -1.75, 0, 1.75, 3.5];
const TW = 0.32; // trench half width
const D0 = PMD_TOP;
const D1 = PMD_TOP + 1.4; // low-k top

function CuIons() {
  const N = 80;
  const ref = useRef<THREE.InstancedMesh>(null);
  const seeds = useMemo(() => {
    const r = rng(6);
    return Array.from({ length: N }, () => ({ x: (r() - 0.5) * 11, z: (r() - 0.5) * 5.6, o: r(), s: 0.6 + r() * 0.8 }));
  }, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const t = useRef(0);
  useFrame((_, dt) => {
    t.current += pdt(dt);
    if (!ref.current) return;
    const on = inPhase('plate');
    seeds.forEach((s, i) => {
      if (!on) return ref.current!.setMatrixAt(i, HIDE);
      const u = (t.current * 0.5 * s.s + s.o) % 1;
      o.position.set(s.x, lerp(D1 + 2.4, D1 + 0.1, u), s.z);
      o.scale.setScalar(0.07);
      o.updateMatrix();
      ref.current!.setMatrixAt(i, o.matrix);
    });
    ref.current.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={ref} args={[GEO.sphereLow, MAT.ion, N]} frustumCulled={false} />;
}

function Damascene() {
  const pmd = useMat(MAT.pmd);
  const lowk = useMat(MAT.lowk);
  const cu = useMat(MAT.copper);
  const w = useMat(MAT.tungsten);
  const segs = useMemo(() => {
    const edges = [-6, ...TRENCHES.flatMap((c) => [c - TW, c + TW]), 6];
    const out: [number, number][] = [];
    for (let i = 0; i < edges.length; i += 2) out.push([edges[i], edges[i + 1]]);
    return out;
  }, []);
  const electro = useRef<THREE.Group>(null);
  useFrame(() => {
    track('focus', 0, D1, 0);
    if (electro.current) electro.current.visible = inPhase('plate');
  });
  const cuFill = () => (inPhase('plate') ? smooth(clamp(engine.player.view.phaseT / 0.7)) : pp('plate') >= 1 ? 1 : 0);
  const over = () => (inPhase('plate') ? smooth(clamp((engine.player.view.phaseT - 0.55) / 0.45)) : inPhase('cmp') ? 1 - smooth(engine.player.view.phaseT) : 0);
  return (
    <group>
      <DeviceRow />
      <Bx x0={-6} x1={6} y0={0} y1={D0} z0={-3} z1={3} m={pmd} />
      {CONTACTS.map(([x, z]) => (
        <mesh key={`${x}${z}`} geometry={GEO.cyl} material={w} scale={[0.25, D0, 0.25]} position={[x, D0 / 2, z]} />
      ))}
      {/* low-k between trenches */}
      <Grow k={() => smooth(pp('dielectric'))} y0={D0}>
        <Clickable sel={{ kind: 'component', id: 'low-k', label: 'Low-k dielectric' }}>
          {segs.map(([a, b]) => (
            <Bx key={a} x0={a} x1={b} y0={D0} y1={D1} z0={-3} z1={3} m={lowk} />
          ))}
        </Clickable>
      </Grow>
      {/* low-k where the trenches will be: removed by the trench etch (top-down) */}
      {TRENCHES.map((c) => (
        <Grow key={c} k={() => smooth(pp('dielectric')) * (1 - smooth(pp('etch')))} y0={D0}>
          <Bx x0={c - TW} x1={c + TW} y0={D0} y1={D1} z0={-3} z1={3} m={lowk} />
        </Grow>
      ))}
      {/* resist pattern: lines over the dielectric, gaps over the trenches */}
      <Grow k={() => (pp('etch') >= 1 ? 0 : smooth(pp('pattern')))} y0={D1}>
        {segs.map(([a, b]) => (
          <Bx key={a} x0={a} x1={b} y0={D1} y1={D1 + 0.3} z0={-3} z1={3} m={MAT.resist} />
        ))}
      </Grow>
      {/* barrier / seed lining each trench */}
      <Grow k={() => smooth(pp('barrier'))} fade>
        <Clickable sel={{ kind: 'component', id: 'barrier', label: 'Barrier / seed' }}>
          {TRENCHES.map((c) => (
            <group key={c}>
              <Bx x0={c - TW} x1={c + TW} y0={D0} y1={D0 + 0.05} z0={-3} z1={3} m={MAT.barrier} />
              <Bx x0={c - TW} x1={c - TW + 0.05} y0={D0} y1={D1} z0={-3} z1={3} m={MAT.barrier} />
              <Bx x0={c + TW - 0.05} x1={c + TW} y0={D0} y1={D1} z0={-3} z1={3} m={MAT.barrier} />
            </group>
          ))}
        </Clickable>
      </Grow>
      {/* copper: bottom-up fill, then overburden */}
      {TRENCHES.map((c) => (
        <Grow key={c} k={cuFill} y0={D0 + 0.05}>
          <Clickable sel={{ kind: 'component', id: 'cu-wire', label: 'Copper wire' }}>
            <Bx x0={c - TW + 0.05} x1={c + TW - 0.05} y0={D0 + 0.05} y1={D1} z0={-3} z1={3} m={cu} />
          </Clickable>
        </Grow>
      ))}
      <Grow k={over} y0={D1}>
        <Bx x0={-6} x1={6} y0={D1} y1={D1 + 0.8} z0={-3} z1={3} m={cu} />
      </Grow>
      <group ref={electro}>
        <Bx x0={-6} x1={6} y0={D1} y1={D1 + 2.6} z0={-3} z1={3} m={MAT.electrolyte} />
        <CuIons />
      </group>
      <TechLabel position={[-6, D1 + 2.9, 3]} title="DUAL DAMASCENE · COPPER" min={1} value={() => `${engine.player.view.phase.label} · Cu ${engine.tele.value('cu', 0).toFixed(0)} nm`} />
      <TechLabel position={[6.2, D1 + 0.6, 2]} title="Cu²⁺ → Cu" lines={['electroplating fills trenches bottom-up']} min={2} show={() => inPhase('plate')} />
    </group>
  );
}

/* ================================================================ M1 → M12 stack */

interface Level {
  k: number;
  y: number;
  h: number;
  pitch: number;
  width: number;
  dir: 'x' | 'z';
  tier: string;
}

const LEVELS: Level[] = (() => {
  const out: Level[] = [];
  let y = 1.0;
  for (let k = 1; k <= 12; k++) {
    const tier = k <= 4 ? 'LOCAL' : k <= 8 ? 'INTERMEDIATE' : k <= 10 ? 'SEMI-GLOBAL' : 'GLOBAL';
    const h = k <= 4 ? 0.45 : k <= 8 ? 0.7 : k <= 10 ? 1.1 : 1.6;
    const pitch = k <= 4 ? 0.8 : k <= 8 ? 1.4 : k <= 10 ? 2.4 : 3.6;
    out.push({ k, y, h, pitch, width: pitch * 0.5, dir: k % 2 ? 'z' : 'x', tier });
    y += h + (k <= 4 ? 0.35 : k <= 8 ? 0.5 : 0.7);
  }
  return out;
})();

function LevelMesh({ L, visible, explode }: { L: Level; visible: boolean; explode: () => number }) {
  const g = useRef<THREE.Group>(null);
  const cu = useMat(MAT.copper);
  const lowk = useMat(MAT.lowk);
  const wires = useMemo(() => {
    const n = Math.floor(10 / L.pitch);
    return Array.from({ length: n }, (_, i) => -((n - 1) * L.pitch) / 2 + i * L.pitch);
  }, [L]);
  const vias = useMemo(() => wires.filter((_, i) => i % 2 === 0).map((c, i) => ({ c, o: ((i * 0.37) % 1) * 8 - 4 })), [wires]);
  useFrame(() => {
    if (!g.current) return;
    const built = engine.tele.value('levels', 12);
    const k = inPhase('build') ? clamp(built - L.k + 1) : 1;
    g.current.visible = visible && k > 0;
    g.current.position.y = (1 - smooth(k)) * 3 + explode() * L.k * 0.9;
  });
  return (
    <group ref={g}>
      <Clickable sel={{ kind: 'component', id: L.k === 1 ? 'm1' : 'cu-wire', label: `Metal ${L.k} · ${L.tier}` }}>
        {wires.map((c) =>
          L.dir === 'z' ? (
            <Bx key={c} x0={c - L.width / 2} x1={c + L.width / 2} y0={L.y} y1={L.y + L.h} z0={-5} z1={5} m={cu} />
          ) : (
            <Bx key={c} x0={-5} x1={5} y0={L.y} y1={L.y + L.h} z0={c - L.width / 2} z1={c + L.width / 2} m={cu} />
          ),
        )}
      </Clickable>
      <Clickable sel={{ kind: 'component', id: 'via', label: `Vias V${L.k - 1}` }}>
        {vias.map(({ c, o }) => {
          const x = L.dir === 'z' ? c : o;
          const z = L.dir === 'z' ? o : c;
          const s = Math.min(L.width * 0.8, 0.9);
          return <Bx key={c} x0={x - s / 2} x1={x + s / 2} y0={L.y - (L.k <= 4 ? 0.35 : L.k <= 8 ? 0.5 : 0.7)} y1={L.y} z0={z - s / 2} z1={z + s / 2} m={cu} />;
        })}
      </Clickable>
      <Bx x0={-5.2} x1={5.2} y0={L.y - 0.02} y1={L.y + L.h + 0.02} z0={-5.2} z1={5.2} m={lowk} />
    </group>
  );
}

function Stack() {
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const view = useUI((s) => s.view);
  const info = useUI((s) => s.info);
  const started = useUI((s) => s.started);
  const ex = useRef(0);
  useFrame((_, dt) => {
    ex.current += ((view === 'exploded' ? 1 : 0) - ex.current) * Math.min(1, dt * 3);
    track('focus', 0, 6, 0);
  });
  const toggle = (k: number) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const top = LEVELS[11].y + LEVELS[11].h;
  return (
    <group>
      <DeviceRow w={5.2} />
      {LEVELS.map((L) => (
        <LevelMesh key={L.k} L={L} visible={!hidden.has(L.k)} explode={() => ex.current} />
      ))}
      {[
        ['LOCAL · M1–M4', LEVELS[1].y],
        ['INTERMEDIATE · M5–M8', LEVELS[5].y],
        ['SEMI-GLOBAL · M9–M10', LEVELS[8].y],
        ['GLOBAL · M11–M12', LEVELS[10].y],
      ].map(([t, y]) => (
        <TechLabel key={t as string} position={[5.6, y as number, 5]} title={t as string} min={1} />
      ))}
      <TechLabel position={[-5.6, top + 1.2, 5]} title="METAL STACK · SCHEMATIC" lines={['finer wires near the transistors, thick wide wires on top']} min={1} value={() => `${engine.tele.value('levels', 12).toFixed(0)} levels`} />
      {started && info >= 1 && (
        <Html position={[-8.5, top, -5]} zIndexRange={[20, 0]}>
          <div className="level-toggles" onPointerDown={(e) => e.stopPropagation()}>
            <div className="cap">LEVELS</div>
            {LEVELS.slice()
              .reverse()
              .map((L) => (
                <button key={L.k} className={`btn sm ${hidden.has(L.k) ? '' : 'on'}`} onClick={() => toggle(L.k)}>
                  M{L.k}
                </button>
              ))}
            <button className="btn sm" onClick={() => setHidden(new Set())}>
              ALL
            </button>
          </div>
        </Html>
      )}
    </group>
  );
}

/* ================================================================ passivation */

const PADS = [-3.4, 0, 3.4];
const PW = 1.1; // pad half width
const TOP_Y = 2.0;

function Passivation() {
  const cu = useMat(MAT.copper);
  const lowk = useMat(MAT.lowk);
  const sin = useMat(MAT.sin);
  const pi = useMat(MAT.polyimide);
  const pad = useMat(MAT.pad);
  const strips = useMemo(() => {
    // passivation pieces around the pad windows (x strips between pads, plus z bands)
    const xs = [-6, ...PADS.flatMap((c) => [c - PW + 0.3, c + PW - 0.3]), 6];
    const out: [number, number][] = [];
    for (let i = 0; i < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
    return out;
  }, []);
  useFrame(() => track('focus', 0, TOP_Y, 0));
  return (
    <group>
      {/* top wiring level (context) */}
      <Bx x0={-6} x1={6} y0={0} y1={1.4} z0={-3} z1={3} m={lowk} />
      {[-4.5, -1.5, 1.5, 4.5].map((x) => (
        <Bx key={x} x0={x - 0.9} x1={x + 0.9} y0={0.2} y1={1.4} z0={-3} z1={3} m={cu} />
      ))}
      <Grow k={() => smooth(pp('pads'))} y0={1.4}>
        <Clickable sel={{ kind: 'component', id: 'pad', label: 'Bond pad' }}>
          {PADS.map((c) => (
            <Bx key={c} x0={c - PW} x1={c + PW} y0={1.4} y1={TOP_Y} z0={-PW} z1={PW} m={pad} />
          ))}
        </Clickable>
      </Grow>
      <Grow k={() => smooth(pp('dep'))} y0={1.4}>
        <Clickable sel={{ kind: 'component', id: 'passivation', label: 'Passivation (SiN / oxide)' }}>
          {strips.map(([a, b]) => (
            <Bx key={a} x0={a} x1={b} y0={1.4} y1={TOP_Y + 0.5} z0={-3} z1={3} m={sin} />
          ))}
          {PADS.map((c) => (
            <group key={c}>
              <Bx x0={c - PW + 0.3} x1={c + PW - 0.3} y0={1.4} y1={TOP_Y + 0.5} z0={-3} z1={-PW + 0.3} m={sin} />
              <Bx x0={c - PW + 0.3} x1={c + PW - 0.3} y0={1.4} y1={TOP_Y + 0.5} z0={PW - 0.3} z1={3} m={sin} />
            </group>
          ))}
        </Clickable>
      </Grow>
      {/* pad windows: passivation over the pad centre, etched away */}
      {PADS.map((c) => (
        <Grow key={c} k={() => smooth(pp('dep')) * (1 - smooth(pp('open')))} y0={TOP_Y}>
          <Bx x0={c - PW + 0.3} x1={c + PW - 0.3} y0={TOP_Y} y1={TOP_Y + 0.5} z0={-PW + 0.3} z1={PW - 0.3} m={sin} />
        </Grow>
      ))}
      <Grow k={() => smooth(pp('polyimide'))} y0={TOP_Y + 0.5}>
        <Clickable sel={{ kind: 'component', id: 'polyimide', label: 'Polyimide' }}>
          {strips.map(([a, b]) => (
            <Bx key={a} x0={a} x1={b} y0={TOP_Y + 0.5} y1={TOP_Y + 1.3} z0={-3} z1={3} m={pi} />
          ))}
          {PADS.map((c) => (
            <group key={c}>
              <Bx x0={c - PW + 0.3} x1={c + PW - 0.3} y0={TOP_Y + 0.5} y1={TOP_Y + 1.3} z0={-3} z1={-PW + 0.3} m={pi} />
              <Bx x0={c - PW + 0.3} x1={c + PW - 0.3} y0={TOP_Y + 0.5} y1={TOP_Y + 1.3} z0={PW - 0.3} z1={3} m={pi} />
            </group>
          ))}
        </Clickable>
      </Grow>
      <TechLabel position={[-6, TOP_Y + 2.2, 3]} title="PASSIVATION · PAD OPENINGS" min={1} value={() => engine.player.view.phase.label} />
      <TechLabel position={[0.3, TOP_Y + 0.2, 0]} title="PAD WINDOW" lines={['probe needles, wires or bumps land here']} min={2} show={() => pp('open') > 0.5} />
    </group>
  );
}

export default function InterconnectScene({ stage }: SceneProps) {
  const v = stage.variant ?? 'damascene';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0;
  }, []);
  return (
    <>
      <Lighting env="void" shadowExtent={14} />
      <VoidBackdrop y={-1.25} color="#33402f" />
      {v === 'contacts' && <Contacts />}
      {v === 'damascene' && <Damascene />}
      {v === 'stack' && <Stack />}
      {v === 'passivation' && <Passivation />}
    </>
  );
}
