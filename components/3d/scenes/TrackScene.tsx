'use client';
/**
 * Litho track (§24, §25, §27): spin coater, bake / chill plates and develop module on
 * one tool, under the yellow light of the lithography bay.
 *   coat:    dispense → spread → spin to thickness (∝ ω^-½) → edge-bead removal
 *   bake:    wafer onto proximity pins → solvent leaves the film → chill plate
 *   develop: PEB → developer puddle → exposed resist dissolves → rinse & spin dry
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, CleanroomBay } from '../environments';
import { M, shell, effectiveView } from '../materials';
import { B, C, GEO } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Inset, LiveProfile, ProfileSlab, rect } from '../parts/section';
import { waferGeometry } from '../parts/wafer';
import { Screen, clear, plot, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { engine } from '@/simulation/engine';
import { pp, inPhase, pdt } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { clamp, lerp, rng, smooth } from '@/lib/math';
import { spinThickness, exposureFields, WAFER_D, FIELD_W, FIELD_H } from '@/simulation/models';

const CX = -1.6; // coater
const BX = 0.5; // hot plate
const CHX = 1.15; // chill plate
const DX = 2.5; // developer
const WY = 1.0; // wafer height in the cups
const PLATE_Y = 0.962; // wafer height on the plate pins
const RAIL_Z = -0.42;

type Variant = 'coat' | 'bake' | 'develop';

/* ---------------------------------------------------------------- wafer path */

const V = new THREE.Vector3();
function waferPos(variant: Variant): THREE.Vector3 {
  if (variant === 'coat') {
    const inP = smooth(pp('load'));
    const outP = inPhase('stop') ? smooth(clamp((engine.player.view.phaseT - 0.55) / 0.45)) : 0;
    V.set(CX, lerp(1.12, WY, inP), lerp(RAIL_Z, 0, inP));
    if (outP > 0) V.set(lerp(CX, CX + 0.7, outP), lerp(WY, 1.12, Math.min(1, outP * 3)), lerp(0, RAIL_Z, outP));
    return V;
  }
  if (variant === 'bake') {
    const tr = smooth(pp('transfer'));
    const low = smooth(pp('lower'));
    const ch = smooth(pp('chill'));
    V.set(lerp(CX + 0.7, BX, tr), lerp(1.12, 1.05, tr), lerp(RAIL_Z, 0, tr));
    if (low > 0) V.y = lerp(1.05, PLATE_Y, low);
    if (ch > 0) {
      const lift = Math.sin(Math.PI * ch) * 0.09;
      V.set(lerp(BX, CHX, ch), PLATE_Y + lift, 0);
    }
    return V;
  }
  // develop
  const mv = inPhase('dispense') ? smooth(clamp(engine.player.view.phaseT / 0.35)) : pp('dispense') >= 1 ? 1 : 0;
  V.set(lerp(BX, DX, mv), PLATE_Y + Math.sin(Math.PI * mv) * 0.15 + (WY - PLATE_Y) * mv, 0);
  return V;
}

/* ---------------------------------------------------------------- textures */

const resistColor = new THREE.Color('#b5612a');

/** Wafer top for develop: resist with the exposed field pattern clearing as it dissolves. */
function useDevelopTexture() {
  return useMemo(() => {
    const size = 512;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const fields = exposureFields();
    let last = -1;
    const draw = (dissolve: number) => {
      const d = Math.round(dissolve * 50) / 50;
      if (d === last) return;
      last = d;
      const s = size / WAFER_D;
      g.clearRect(0, 0, size, size);
      g.fillStyle = '#9a5a2c';
      g.beginPath();
      g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      g.fill();
      for (const f of fields) {
        const x = size / 2 + (f.cx - FIELD_W / 2) * s;
        const y = size / 2 + (f.cy - FIELD_H / 2) * s;
        // latent image (exposed, not yet developed) is slightly lighter; developed spaces show the film below
        g.fillStyle = `rgba(216,150,80,${0.35 * (1 - d)})`;
        g.fillRect(x + 1, y + 1, FIELD_W * s - 2, FIELD_H * s - 2);
        g.fillStyle = `rgba(150,170,150,${0.85 * d})`;
        for (let k = 0; k < 6; k++) g.fillRect(x + 2 + k * ((FIELD_W * s - 4) / 6), y + 2, (FIELD_W * s - 4) / 12, FIELD_H * s - 4);
      }
      tex.needsUpdate = true;
    };
    draw(0);
    return { tex, draw };
  }, []);
}

/* ---------------------------------------------------------------- the wafer */

function TrackWafer({ variant }: { variant: Variant }) {
  const group = useRef<THREE.Group>(null);
  const spin = useRef<THREE.Group>(null);
  const film = useRef<THREE.Mesh>(null);
  const filmMat = useMemo(() => new THREE.MeshPhysicalMaterial({ color: resistColor, roughness: 0.18, metalness: 0, transparent: true, opacity: 0.9, clearcoat: 0.6 }), []);
  const dev = useDevelopTexture();
  const devMat = useMemo(() => new THREE.MeshStandardMaterial({ map: dev.tex, roughness: 0.25, metalness: 0.1, transparent: true }), [dev]);
  const waferMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.08, metalness: 0.9 }), []);
  useFrame((_, dt) => {
    const p = waferPos(variant);
    if (group.current) group.current.position.copy(p);
    track('focus', p.x, p.y, p.z);
    // rotation: spin speed from telemetry (capped for display; real speed shown in the HUD)
    const rpm = variant === 'bake' ? 0 : engine.tele.value('rpm', 0);
    if (spin.current) spin.current.rotation.y += pdt(dt) * Math.min(rpm, 420) * 0.105;
    if (film.current) {
      if (variant === 'coat') {
        const spread = engine.player.view.phaseId === 'load' ? 0 : inPhase('dispense') ? 0.08 + 0.25 * engine.player.view.phaseT : inPhase('spread') ? lerp(0.33, 1, smooth(engine.player.view.phaseT)) : 1;
        const ebr = inPhase('ebr') ? smooth(engine.player.view.phaseT) : pp('ebr');
        film.current.visible = !inPhase('load');
        film.current.scale.setScalar(Math.max(0.01, spread * (1 - 0.02 * ebr)));
        // thick films look darker / more saturated; the final film shows a thin-film sheen
        const th = engine.tele.value('thick', 0);
        filmMat.opacity = clamp(0.55 + th / 3000, 0.55, 0.95);
        filmMat.color.copy(resistColor).offsetHSL(0, 0, clamp((800 - th) / 4000, -0.05, 0.12));
      } else if (variant === 'bake') {
        film.current.visible = true;
        film.current.scale.setScalar(0.98);
        filmMat.opacity = 0.9;
        filmMat.color.copy(resistColor).offsetHSL(0, 0, -0.03 * (1 - engine.tele.value('solvent', 25) / 25));
      } else {
        film.current.visible = true;
        film.current.scale.setScalar(0.98);
        dev.draw(clamp(engine.tele.value('dissolve', 0) / 100));
      }
    }
  });
  return (
    <group ref={group}>
      <group ref={spin}>
        <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184' }}>
          <mesh geometry={waferGeometry()} material={waferMat} castShadow />
          <mesh ref={film} position={[0, 0.0006, 0]} rotation={[-Math.PI / 2, 0, 0]} material={variant === 'develop' ? devMat : filmMat}>
            <circleGeometry args={[0.15, 64]} />
          </mesh>
        </Clickable>
      </group>
    </group>
  );
}

/* ---------------------------------------------------------------- modules */

function Cup({ x, id, label, dispense }: { x: number; id: string; label: string; dispense: () => number }) {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  const view = effectiveView(viewRaw, cam);
  const arm = useRef<THREE.Group>(null);
  const stream = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const d = dispense();
    if (arm.current) arm.current.rotation.y = lerp(1.1, 0, smooth(clamp(d * 4)));
    if (stream.current) stream.current.visible = d > 0.25 && d < 0.98;
  });
  return (
    <group position={[x, 0, 0]}>
      <Clickable sel={{ kind: 'component', id, machine: 'track', label }}>
        <mesh position={[0, 0.96, 0]} material={shell(M.plastic, view)}>
          <cylinderGeometry args={[0.24, 0.22, 0.2, 48, 1, true]} />
        </mesh>
        <mesh position={[0, 1.06, 0]} rotation={[Math.PI / 2, 0, 0]} material={shell(M.plastic, view)}>
          <torusGeometry args={[0.235, 0.012, 8, 48]} />
        </mesh>
        <C r={0.06} h={0.12} m={M.steelDark} position={[0, 0.93, 0]} />
        <C r={0.25} h={0.02} m={M.panelGrey} position={[0, 0.86, 0]} />
      </Clickable>
      <Clickable sel={{ kind: 'component', id: 'nozzle', machine: 'track', label: 'Dispense nozzle arm' }}>
        <C r={0.025} h={0.32} m={M.steel} position={[0.32, 1.02, -0.18]} />
        <group ref={arm} position={[0.32, 1.17, -0.18]}>
          <B s={[0.36, 0.022, 0.03]} m={M.steel} position={[-0.17, 0, 0.09]} rotation={[0, 0.48, 0]} />
          <C r={0.01} h={0.05} m={M.plastic} position={[-0.32, -0.025, 0.18]} />
          <mesh ref={stream} position={[-0.32, -0.08, 0.18]} material={M.resist}>
            <cylinderGeometry args={[0.004, 0.004, 0.09, 8]} />
          </mesh>
        </group>
      </Clickable>
    </group>
  );
}

const plateMat = new THREE.MeshStandardMaterial({ color: '#8b8f8f', roughness: 0.35, metalness: 0.8, emissive: new THREE.Color('#ff6a1a'), emissiveIntensity: 0, toneMapped: false });

function Plates({ variant }: { variant: Variant }) {
  const lid = useRef<THREE.Group>(null);
  const vapour = useRef<THREE.InstancedMesh>(null);
  const seeds = useMemo(() => {
    const r = rng(12);
    return Array.from({ length: 40 }, () => ({ x: (r() - 0.5) * 0.26, z: (r() - 0.5) * 0.26, o: r(), s: 0.6 + r() * 0.8 }));
  }, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const t = useRef(0);
  useFrame((_, dt) => {
    t.current += pdt(dt);
    const T = variant === 'bake' ? engine.tele.value('plate', 100) : 100;
    plateMat.emissiveIntensity = clamp((T - 40) / 60) * 0.06;
    const baking = (variant === 'bake' && inPhase('bake')) || (variant === 'develop' && inPhase('peb'));
    if (lid.current) lid.current.position.y = baking ? lerp(1.2, 1.0, smooth(clamp(engine.player.view.phaseT * 5))) : 1.2;
    if (vapour.current) {
      const sol = variant === 'bake' && inPhase('bake') ? engine.tele.value('solvent', 0) / 25 : 0;
      seeds.forEach((s, i) => {
        const u = (t.current * 0.4 * s.s + s.o) % 1;
        o.position.set(BX + s.x, PLATE_Y + 0.005 + u * 0.03, s.z);
        o.scale.setScalar(i / seeds.length < sol ? 0.004 * (1 - u) : 0);
        o.updateMatrix();
        vapour.current!.setMatrixAt(i, o.matrix);
      });
      vapour.current.instanceMatrix.needsUpdate = true;
    }
  });
  return (
    <group>
      <Clickable sel={{ kind: 'component', id: 'hotplate', machine: 'track', label: 'Bake plate (proximity pins)' }}>
        <B s={[0.42, 0.1, 0.42]} m={M.panelGrey} position={[BX, 0.9, 0]} />
        <mesh position={[BX, 0.953, 0]} material={plateMat}>
          <cylinderGeometry args={[0.165, 0.165, 0.008, 48]} />
        </mesh>
        {[0, 1, 2].map((k) => (
          <C key={k} r={0.004} h={0.01} m={M.ceramic} position={[BX + Math.cos((k * Math.PI * 2) / 3) * 0.1, 0.958, Math.sin((k * Math.PI * 2) / 3) * 0.1]} shadow={false} />
        ))}
        <group ref={lid} position={[BX, 1.2, 0]}>
          <C r={0.19} h={0.03} m={M.alu} />
          <C r={0.03} h={0.12} m={M.steelDark} position={[0, 0.07, 0]} />
        </group>
      </Clickable>
      <Clickable sel={{ kind: 'component', id: 'chill', machine: 'track', label: 'Chill plate' }}>
        <B s={[0.42, 0.1, 0.42]} m={M.panelGrey} position={[CHX, 0.9, 0]} />
        <mesh position={[CHX, 0.953, 0]} material={M.alu}>
          <cylinderGeometry args={[0.165, 0.165, 0.008, 48]} />
        </mesh>
      </Clickable>
      <instancedMesh ref={vapour} args={[GEO.sphereLow, M.glass, 40]} frustumCulled={false} />
    </group>
  );
}

function TrackRobot({ variant }: { variant: Variant }) {
  const body = useRef<THREE.Group>(null);
  const blade = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const p = waferPos(variant);
    if (body.current) body.current.position.x = THREE.MathUtils.clamp(p.x, -2.2, 3.1);
    if (blade.current) {
      // blade reaches the wafer while it is between rail and module
      const reach = clamp((p.z - RAIL_Z) / -RAIL_Z);
      const carrying = p.y > 1.03 || (reach > 0.05 && reach < 0.95);
      blade.current.visible = carrying;
      blade.current.position.set(0, p.y - 0.006 - 0.88, p.z - RAIL_Z);
    }
  });
  return (
    <Clickable sel={{ kind: 'component', id: 'robot', machine: 'track', label: 'Track robot' }}>
      <B s={[5.4, 0.04, 0.08]} m={M.steelDark} position={[0.45, 0.87, RAIL_Z]} />
      <group ref={body} position={[0, 0.88, RAIL_Z]}>
        <B s={[0.2, 0.14, 0.16]} m={M.panel} position={[0, 0.07, 0]} />
        <mesh ref={blade} material={M.ceramic}>
          <boxGeometry args={[0.07, 0.006, 0.36]} />
        </mesh>
      </group>
    </Clickable>
  );
}

function TrackBody() {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  const view = effectiveView(viewRaw, cam);
  return (
    <Clickable sel={{ kind: 'machine', id: 'track', label: 'Coater / developer track' }}>
      <B s={[6.0, 0.85, 1.2]} m={M.panel} position={[0.45, 0.425, 0]} />
      <B s={[6.02, 0.05, 1.22]} m={M.greenAccent} position={[0.45, 0.83, 0]} />
      {/* back tower: stacked bake / adhesion / cool modules */}
      {[-1.5, -0.4, 0.7, 1.8, 2.9].map((x) => (
        <group key={x} position={[x, 0, -0.85]}>
          <B s={[1.0, 1.9, 0.5]} m={shell(M.panelWarm, view)} position={[0, 1.8, 0]} />
          {[1.1, 1.45, 1.8, 2.15, 2.5].map((y) => (
            <B key={y} s={[0.9, 0.025, 0.02]} m={M.panelGrey} position={[0, y, 0.26]} />
          ))}
        </group>
      ))}
      {/* scanner interface block at the right end */}
      <B s={[0.6, 1.9, 1.2]} m={M.panelWarm} position={[3.75, 0.95, 0]} />
      <B s={[0.62, 0.06, 1.22]} m={M.orangeAccent} position={[3.75, 1.7, 0]} />
      {/* chemical cabinet + front glass */}
      <mesh position={[0.45, 1.4, 0.6]} material={M.glass}>
        <boxGeometry args={[5.9, 0.9, 0.01]} />
      </mesh>
      <SignalTower position={[-2.3, 2.02, 0.45]} />
    </Clickable>
  );
}

/* ---------------------------------------------------------------- insets */

const subMat = new THREE.MeshStandardMaterial({ color: '#7a828c', roughness: 0.45, metalness: 0.6 });
const resistMat = new THREE.MeshPhysicalMaterial({ color: '#b5612a', roughness: 0.3, metalness: 0, transparent: true, opacity: 0.92 });
const exposedMat = new THREE.MeshPhysicalMaterial({ color: '#dd9a52', roughness: 0.3, metalness: 0, transparent: true, opacity: 0.9 });
const devLiquid = new THREE.MeshStandardMaterial({ color: '#c8dccb', transparent: true, opacity: 0.2, depthWrite: false });
const dotMat = new THREE.MeshStandardMaterial({ color: '#e7e0c4', roughness: 0.5 });

/** Coat: thickness profile across the wafer diameter (vertical exaggeration). */
function CoatInset() {
  const Y = 0.45 / 2600; // units per nm of resist (schematic)
  return (
    <Inset id="coat-profile" position={[-0.35, 1.8, 0.4]} size={[1.2, 0.8]} mpu={0.3 / 1.0} title="RESIST PROFILE ACROSS THE WAFER · VERTICAL ×10⁵">
      <group position={[0, -0.22, 0.05]}>
        <ProfileSlab points={rect(-0.5, -0.06, 0.5, 0)} depth={0.12} m={subMat} />
        <LiveProfile
          depth={0.12}
          m={resistMat}
          compute={() => {
            const v = engine.player.view;
            if (v.phaseId === 'load') return null;
            const th = engine.tele.value('thick', 0);
            const spread = v.phaseId === 'dispense' ? 0.08 + 0.25 * v.phaseT : v.phaseId === 'spread' ? lerp(0.33, 1, smooth(v.phaseT)) : 1;
            const ebr = v.phaseId === 'ebr' ? smooth(v.phaseT) : pp('ebr');
            const R = 0.5 * spread * (1 - 0.06 * ebr);
            const pts: [number, number][] = [];
            const n = 40;
            for (let i = 0; i <= n; i++) {
              const x = -R + (2 * R * i) / n;
              const r = Math.abs(x) / Math.max(R, 1e-3);
              // puddle → domed spreading film → flat film (centrifugal thinning evens it out)
              const dome = spread < 1 ? 1 + 0.8 * (1 - r * r) : 1 + 0.04 * (1 - r * r) * clamp((th - 200) / 400);
              pts.push([x, Math.max(0.003, th * Y * dome)]);
            }
            pts.push([R, 0], [-R, 0]);
            return pts;
          }}
        />
      </group>
      <TechLabel position={[-0.56, 0.32, 0.05]} title="RESIST THICKNESS" min={2} value={() => `${engine.tele.value('thick', 0).toFixed(0)} nm @ ${engine.tele.value('rpm', 0).toFixed(0)} rpm · SIMULATED`} />
      <TechLabel position={[0.32, -0.32, 0.05]} title="WAFER Ø 300 mm" min={3} />
    </Inset>
  );
}

/** Bake: solvent leaving the resist film (cross-section at ~nm scale). */
function BakeInset() {
  const H = 0.3; // 110 nm of resist
  const dots = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const seeds = useMemo(() => {
    const r = rng(3);
    return Array.from({ length: 60 }, () => ({ x: (r() - 0.5) * 1.0, y: r(), o: r(), s: 0.5 + r() }));
  }, []);
  const t = useRef(0);
  useFrame((_, dt) => {
    t.current += pdt(dt);
    if (!dots.current) return;
    const sol = clamp(engine.tele.value('solvent', 25) / 25);
    const baking = inPhase('bake');
    seeds.forEach((s, i) => {
      const present = i / seeds.length < sol;
      // trapped solvent molecules jiggle inside; while baking a few escape upward
      const esc = baking && i / seeds.length > sol - 0.15 && present ? ((t.current * 0.6 * s.s + s.o) % 1) : 0;
      const y = s.y * H * 0.9 + 0.01 + esc * 0.3;
      o.position.set(s.x + 0.006 * Math.sin(t.current * 9 + i), y, 0.08);
      o.scale.setScalar(present ? 0.012 : 0);
      o.updateMatrix();
      dots.current!.setMatrixAt(i, o.matrix);
    });
    dots.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <Inset id="bake-section" position={[1.65, 1.8, 0.4]} size={[1.2, 0.8]} mpu={110e-9 / H} schematic={false} title="SOFT BAKE · RESIST CROSS-SECTION">
      <group position={[0, -0.12, 0]}>
        <ProfileSlab points={rect(-0.55, -0.22, 0.55, 0)} depth={0.14} m={subMat} />
        <LiveProfile depth={0.14} m={resistMat} compute={() => rect(-0.55, 0, 0.55, H * (0.95 + 0.05 * clamp(engine.tele.value('solvent', 25) / 25)))} />
        <instancedMesh ref={dots} args={[GEO.sphereLow, dotMat, 60]} frustumCulled={false} />
      </group>
      <TechLabel position={[-0.56, 0.32, 0.05]} title="RESIDUAL SOLVENT" min={2} value={() => `${engine.tele.value('solvent', 0).toFixed(1)} % · wafer ${engine.tele.value('wafer', 0).toFixed(1)} °C · SIMULATED`} />
    </Inset>
  );
}

/** Develop: exposed resist (latent image) dissolves top-down, leaving lines. */
function DevelopInset() {
  const H = 0.3;
  const spaces = [-0.36, -0.12, 0.12, 0.36];
  const w = 0.12;
  const liquid = useRef<THREE.Mesh>(null);
  useFrame(() => {
    if (liquid.current) liquid.current.visible = inPhase('dispense') || inPhase('develop');
  });
  const lines = useMemo(() => {
    const edges = [-0.55, ...spaces.flatMap((c) => [c - w / 2, c + w / 2]), 0.55];
    const out: [number, number][][] = [];
    for (let i = 0; i < edges.length; i += 2) out.push(rect(edges[i], 0, edges[i + 1], H));
    return out;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Inset id="dev-section" position={[3.65, 1.8, 0.4]} size={[1.2, 0.8]} mpu={110e-9 / H} schematic={false} title="DEVELOP · RESIST CROSS-SECTION">
      <group position={[0, -0.12, 0]}>
        <ProfileSlab points={rect(-0.55, -0.22, 0.55, 0)} depth={0.14} m={subMat} />
        {lines.map((p, i) => (
          <ProfileSlab key={i} points={p} depth={0.14} m={resistMat} />
        ))}
        {spaces.map((c) => (
          <LiveProfile
            key={c}
            depth={0.14}
            m={exposedMat}
            compute={() => {
              const d = clamp(engine.tele.value('dissolve', 0) / 100);
              const h = H * (1 - d);
              return h < 0.004 ? null : rect(c - w / 2, 0, c + w / 2, h);
            }}
          />
        ))}
        <mesh ref={liquid} position={[0, H + 0.08, 0]} material={devLiquid}>
          <boxGeometry args={[1.1, 0.5, 0.14]} />
        </mesh>
      </group>
      <TechLabel position={[-0.56, 0.32, 0.05]} title="EXPOSED RESIST DISSOLVED" min={2} value={() => `${engine.tele.value('dissolve', 0).toFixed(0)} % · lines 44 nm · SIMULATED`} />
      <TechLabel position={[0.28, -0.32, 0.05]} title="LATENT IMAGE → PATTERN" min={3} />
    </Inset>
  );
}

function SpinCurveScreen() {
  const curve = useMemo(() => Array.from({ length: 50 }, (_, i) => spinThickness(500 + i * 70)), []);
  return (
    <group position={[-2.45, 0, -0.35]} rotation={[0, 0.5, 0]}>
      <Screen
        size={[0.56, 0.36]}
        position={[0, 1.42, 0]}
        hz={4}
        draw={(g, w, h) => {
          clear(g, w, h, 'SPIN COAT · t ∝ ω^-½ · SIMULATED');
          const x = w * 0.07;
          const y = h * 0.36;
          const pw = w * 0.86;
          const ph = h * 0.52;
          plot(g, curve, x, y, pw, ph, 0, 300, SCR.dim);
          const rpm = engine.tele.value('rpm', 0);
          if (rpm > 500) {
            const u = clamp((rpm - 500) / (49 * 70));
            g.fillStyle = SCR.accent;
            g.beginPath();
            g.arc(x + u * pw, y + ph - (spinThickness(rpm) / 300) * ph, h * 0.025, 0, Math.PI * 2);
            g.fill();
          }
          bigNumber(g, 'SPIN', rpm.toFixed(0), 'rpm', w * 0.07, h * 0.19, h * 0.09);
          bigNumber(g, 'FILM', engine.tele.value('thick', 0).toFixed(0), 'nm', w * 0.55, h * 0.19, h * 0.09);
        }}
      />
      <C r={0.02} h={1.25} m={M.steelDark} position={[0, 0.62, -0.02]} />
    </group>
  );
}

/* ---------------------------------------------------------------- scene */

export default function TrackScene({ stage }: SceneProps) {
  const variant = (stage.variant as Variant) ?? 'coat';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.3;
  }, []);
  return (
    <>
      <Lighting env="litho" shadowExtent={6} />
      <CleanroomBay width={13} depth={8} height={4.2} amber />
      <TrackBody />
      <Cup x={CX} id="coater" label="Spin coater cup" dispense={() => (variant === 'coat' ? (inPhase('dispense') ? engine.player.view.phaseT : 0) : 0)} />
      <Cup x={DX} id="developer" label="Develop module" dispense={() => (variant === 'develop' ? (inPhase('dispense') ? clamp((engine.player.view.phaseT - 0.35) / 0.65) : inPhase('rinse') ? 0.5 : 0) : 0)} />
      <Plates variant={variant} />
      <TrackRobot variant={variant} />
      <TrackWafer variant={variant} />
      <SensorIndicator id="humidity" channel={variant === 'coat' ? 'rh' : undefined} machine="track" position={[CX - 0.28, 1.0, 0.2]} size={0.04} />
      <SensorIndicator id="thermocouple" channel={variant === 'bake' ? 'plate' : variant === 'develop' ? 'devT' : undefined} machine="track" position={[BX + 0.22, 0.92, 0.18]} size={0.04} />
      {variant === 'coat' && <CoatInset />}
      {variant === 'bake' && <BakeInset />}
      {variant === 'develop' && <DevelopInset />}
      <SpinCurveScreen />
      <TechLabel position={[CX - 0.1, 1.3, 0.1]} title="SPIN COATER" min={2} value={variant === 'coat' ? () => `${engine.tele.value('rpm', 0).toFixed(0)} rpm · ${engine.player.view.phase.label}` : undefined} />
      <TechLabel position={[BX - 0.1, 1.32, 0.1]} title="BAKE · CHILL" min={2} value={variant === 'bake' ? () => `plate ${engine.tele.value('plate', 0).toFixed(1)} °C · ${engine.player.view.phase.label}` : undefined} />
      <TechLabel position={[DX - 0.1, 1.3, 0.1]} title="DEVELOP" min={2} value={variant === 'develop' ? () => `${engine.tele.value('dissolve', 0).toFixed(0)} % dissolved · ${engine.player.view.phase.label}` : undefined} />
      <Operator position={[0.2, 0, 1.6]} rotation={Math.PI} still />
    </>
  );
}
