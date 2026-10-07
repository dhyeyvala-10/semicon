'use client';
/**
 * Chemical mechanical planarization (§31): a rotating platen with a grooved pad, a carrier
 * head pressing the wafer face-down, slurry, pad conditioner and a post-CMP brush cleaner.
 * Removal follows Preston (rate ∝ pressure × velocity): high points go first, so the step
 * height decays while the stop layer (nitride) ends the polish.
 * The cross-section has a draggable before / after divider.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Lighting, CleanroomBay } from '../environments';
import { M } from '../materials';
import { B, C, GEO } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Inset, LiveProfile, ProfileSlab } from '../parts/section';
import { waferGeometry } from '../parts/wafer';
import { Screen, clear, plot, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { engine } from '@/simulation/engine';
import { pp, inPhase, pdt } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { clamp, lerp, smooth, rng } from '@/lib/math';

const PAD_Y = 0.856;
const PLATEN_R = 0.4;
const POLISH = new THREE.Vector3(0.17, PAD_Y + 0.0012, 0.04);
const LOAD_CUP = new THREE.Vector3(0.85, 0.9, 0.62);
const CLEAN = new THREE.Vector3(-1.55, 1.12, 0);
const OUT = new THREE.Vector3(-1.55, 0.95, 0.75);

/* ---------------------------------------------------------------- textures */

function padTexture() {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#cbbd92';
  g.fillRect(0, 0, S, S);
  const r = rng(4);
  for (let i = 0; i < 4000; i++) {
    g.fillStyle = `rgba(90,80,50,${0.05 + r() * 0.08})`;
    g.fillRect(r() * S, r() * S, 1.5, 1.5);
  }
  g.strokeStyle = 'rgba(70,62,40,0.55)';
  g.lineWidth = 1.4;
  for (let k = 8; k < S / 2; k += 9) {
    g.beginPath();
    g.arc(S / 2, S / 2, k, 0, Math.PI * 2);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/* ---------------------------------------------------------------- motion */

const P = new THREE.Vector3();
/** Wafer (and carrier head) position: load cup → platen → cleaner → output. */
function waferPos(): { p: THREE.Vector3; faceDown: number; vertical: number } {
  const ld = smooth(pp('load'));
  const cl = smooth(pp('clean'));
  const un = smooth(pp('unload'));
  P.copy(LOAD_CUP).lerp(POLISH, ld);
  P.y += Math.sin(Math.PI * ld) * 0.2;
  let faceDown = ld;
  let vertical = 0;
  if (inPhase('polish') || inPhase('endpoint')) P.x += 0.07 * Math.sin(engine.time * 1.1); // head sweep
  if (cl > 0) {
    P.lerp(CLEAN, cl);
    P.y += Math.sin(Math.PI * cl) * 0.25;
    faceDown = 1 - cl;
    vertical = cl;
  }
  if (un > 0) {
    P.lerp(OUT, un);
    vertical = 1 - un;
  }
  return { p: P, faceDown, vertical };
}

/* ---------------------------------------------------------------- polisher */

const slurryMat = new THREE.MeshStandardMaterial({ color: '#f2f1ea', roughness: 0.15, transparent: true, opacity: 0.55, depthWrite: false });
const waterMat = new THREE.MeshStandardMaterial({ color: '#d7e6dc', roughness: 0.05, transparent: true, opacity: 0.35, depthWrite: false });

function Polisher() {
  const platen = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const cond = useRef<THREE.Group>(null);
  const stream = useRef<THREE.Mesh>(null);
  const puddle = useRef<THREE.Mesh>(null);
  const rollers = useRef<THREE.Group>(null);
  const wafer = useRef<THREE.Group>(null);
  const spray = useRef<THREE.Mesh>(null);
  const pad = useMemo(() => new THREE.MeshStandardMaterial({ map: padTexture(), roughness: 0.75, metalness: 0 }), []);
  const waferMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.1, metalness: 0.9 }), []);
  const spin = useRef(0);
  useFrame((_, dt) => {
    const polishing = inPhase('polish') || inPhase('endpoint');
    const d = pdt(dt);
    if (platen.current && polishing) platen.current.rotation.y += d * 6.3; // ≈ 60 rpm
    const { p, faceDown, vertical } = waferPos();
    track('focus', p.x, p.y, p.z);
    if (polishing) spin.current += d * 5.9;
    // carrier head carries the wafer from load until the cleaner
    const onHead = pp('load') > 0 && pp('clean') < 0.5;
    if (head.current) {
      head.current.position.set(onHead ? p.x : POLISH.x, onHead ? p.y + 0.045 : PAD_Y + 0.25, onHead ? p.z : POLISH.z);
      head.current.rotation.y = spin.current;
    }
    if (wafer.current) {
      wafer.current.position.copy(p);
      wafer.current.rotation.set(Math.PI * faceDown + (Math.PI / 2) * vertical, spin.current * (onHead ? 1 : 0), 0);
    }
    if (cond.current) cond.current.rotation.y = polishing ? 0.5 * Math.sin(engine.time * 0.7) - 0.3 : 0.9;
    if (stream.current) stream.current.visible = polishing;
    if (puddle.current) {
      puddle.current.visible = polishing || pp('polish') > 0.02;
      slurryMat.opacity = polishing ? 0.5 : 0.25 * (1 - pp('clean'));
    }
    const cleaning = inPhase('clean');
    if (rollers.current) rollers.current.children.forEach((r, i) => (r.rotation.x += d * (cleaning ? 8 : 0) * (i % 2 ? 1 : -1)));
    if (spray.current) spray.current.visible = cleaning;
  });
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'cmp', label: 'CMP polisher' }}>
        <B s={[2.4, 0.8, 2.0]} m={M.panel} position={[0.1, 0.4, 0]} />
        <B s={[2.42, 0.05, 2.02]} m={M.greenAccent} position={[0.1, 0.79, 0]} />
        {/* splash guard ring */}
        <mesh position={[0, 0.86, 0]} material={M.plastic}>
          <cylinderGeometry args={[PLATEN_R + 0.06, PLATEN_R + 0.06, 0.08, 64, 1, true]} />
        </mesh>
        <Clickable sel={{ kind: 'component', id: 'platen', machine: 'cmp', label: 'Rotating platen & pad' }}>
          <group ref={platen} position={[0, 0.82, 0]}>
            <C r={PLATEN_R} h={0.06} m={M.steelDark} />
            <mesh position={[0, PAD_Y - 0.82 - 0.0005, 0]} rotation={[-Math.PI / 2, 0, 0]} material={pad}>
              <circleGeometry args={[PLATEN_R - 0.005, 96]} />
            </mesh>
            <mesh ref={puddle} position={[0.08, PAD_Y - 0.82 + 0.0006, 0.05]} rotation={[-Math.PI / 2, 0, 0]} material={slurryMat}>
              <ringGeometry args={[0.05, 0.3, 64, 1, 0, Math.PI * 1.4]} />
            </mesh>
          </group>
        </Clickable>
        {/* head gantry */}
        <B s={[0.12, 0.9, 0.12]} m={M.steel} position={[0.95, 1.2, -0.75]} />
        <B s={[1.0, 0.08, 0.1]} m={M.steel} position={[0.55, 1.62, -0.75]} />
        {/* slurry arm */}
        <Clickable sel={{ kind: 'component', id: 'slurry-arm', machine: 'cmp', label: 'Slurry arm' }}>
          <C r={0.025} h={0.22} m={M.steel} position={[-0.55, 0.95, -0.42]} />
          <B s={[0.5, 0.025, 0.03]} m={M.steel} position={[-0.32, 1.06, -0.24]} rotation={[0, -0.68, 0]} />
          <mesh ref={stream} position={[-0.12, 0.96, -0.08]} material={slurryMat}>
            <cylinderGeometry args={[0.004, 0.004, 0.19, 8]} />
          </mesh>
        </Clickable>
        {/* pad conditioner */}
        <Clickable sel={{ kind: 'component', id: 'conditioner', machine: 'cmp', label: 'Pad conditioner' }}>
          <C r={0.03} h={0.24} m={M.steel} position={[0.62, 0.96, -0.5]} />
          <group ref={cond} position={[0.62, 1.07, -0.5]}>
            <B s={[0.42, 0.03, 0.04]} m={M.steel} position={[-0.21, 0, 0]} />
            <C r={0.05} h={0.03} m={M.steelDark} position={[-0.42, -0.2 + 0.006, 0]} />
            <C r={0.012} h={0.2} m={M.steel} position={[-0.42, -0.1, 0]} />
          </group>
        </Clickable>
        {/* load cup */}
        <C r={0.17} h={0.06} m={M.plastic} position={[LOAD_CUP.x, LOAD_CUP.y - 0.04, LOAD_CUP.z]} />
        {/* post-CMP cleaner */}
        <Clickable sel={{ kind: 'component', id: 'cleaner', machine: 'cmp', label: 'Post-CMP brush cleaner' }}>
          <B s={[0.8, 1.4, 1.0]} m={M.panelWarm} position={[-1.55, 0.7, -0.25]} />
          <mesh position={[-1.55, 1.12, 0.12]} material={M.glass}>
            <boxGeometry args={[0.7, 0.6, 0.6]} />
          </mesh>
          <group ref={rollers}>
            {[-0.03, 0.03].map((z) => (
              <mesh key={z} position={[-1.55, 1.12, z]} rotation={[0, 0, Math.PI / 2]} material={M.plastic}>
                <cylinderGeometry args={[0.022, 0.022, 0.34, 16]} />
              </mesh>
            ))}
          </group>
          <mesh ref={spray} position={[-1.55, 1.28, 0]} material={waterMat}>
            <coneGeometry args={[0.08, 0.14, 16, 1, true]} />
          </mesh>
        </Clickable>
        <SignalTower position={[1.15, 0.95, 0.85]} />
      </Clickable>
      {/* carrier head (moves with the wafer) */}
      <Clickable sel={{ kind: 'component', id: 'head', machine: 'cmp', label: 'Carrier head' }}>
        <group ref={head}>
          <C r={0.175} h={0.07} m={M.alu} />
          <C r={0.04} h={0.7} m={M.steel} position={[0, 0.38, 0]} />
          <C r={0.18} h={0.012} m={M.panelGrey} position={[0, 0.04, 0]} />
        </group>
      </Clickable>
      <group ref={wafer}>
        <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184' }}>
          <mesh geometry={waferGeometry()} material={waferMat} castShadow />
        </Clickable>
      </group>
    </group>
  );
}

/* ---------------------------------------------------------------- cross-section with divider */

const TRENCHES = [-0.3, 0, 0.3];
const TW = 0.07; // half width
const DEPTH = 0.2;
const NIT = 0.04;
const BOTTOM = -0.36;
const EDGES = TRENCHES.flatMap((c) => [c - TW, c + TW]);
const inTrench = (x: number) => TRENCHES.some((c) => Math.abs(x - c) < TW);

/** oxide top (inset units) for a removal fraction r ∈ [0,1], step height in nm, dishing 0..1 */
function oxTop(x: number, r: number, stepNm: number, dish: number) {
  const L = lerp(0.3, NIT, r);
  const A = 0.11 * (stepNm / 300);
  // smooth high (over active areas) / low (over trenches) pattern
  let d = Infinity;
  for (const c of TRENCHES) d = Math.min(d, Math.abs(x - c));
  const hi = smooth(clamp((d - TW * 0.4) / (TW * 1.6)));
  let y = L + A * (hi - 0.5);
  if (r >= 0.999 && inTrench(x)) y -= 0.014 * dish;
  return Math.max(y, inTrench(x) ? -DEPTH + 0.01 : NIT);
}

function xs(x0: number, x1: number): number[] {
  const out: number[] = [];
  const n = 60;
  for (let i = 0; i <= n; i++) out.push(x0 + ((x1 - x0) * i) / n);
  for (const e of EDGES) if (e > x0 && e < x1) out.push(e - 1e-4, e + 1e-4);
  return out.sort((a, b) => a - b);
}

function band(x0: number, x1: number, top: (x: number) => number, bottom: number): [number, number][] | null {
  if (x1 - x0 < 0.004) return null;
  const pts: [number, number][] = [
    [x0, bottom],
    [x1, bottom],
  ];
  const s = xs(x0, x1).reverse();
  for (const x of s) pts.push([x, top(x)]);
  return pts;
}

const siTop = (x: number) => (inTrench(x) ? -DEPTH : 0);
const siMat = new THREE.MeshStandardMaterial({ color: '#7a828c', roughness: 0.45, metalness: 0.55 });
const oxMat = new THREE.MeshPhysicalMaterial({ color: '#a9c2a0', roughness: 0.3, transparent: true, opacity: 0.95 });
const oxBefore = new THREE.MeshPhysicalMaterial({ color: '#8fa889', roughness: 0.35, transparent: true, opacity: 0.95 });
const nitMat = new THREE.MeshStandardMaterial({ color: '#b7a77d', roughness: 0.4 });
const dividerMat = new THREE.MeshBasicMaterial({ color: '#e3e8df', toneMapped: false });
const INSET_POS: [number, number, number] = [-1.5, 2.1, 1.45];

function CMPInset() {
  const div = useRef(0);
  const dragging = useRef(false);
  const handle = useRef<THREE.Group>(null);
  const controls = useThree((s) => s.controls) as unknown as { enabled: boolean } | null;
  const current = () => {
    const removed = engine.tele.value('removed', 0);
    const step = engine.tele.value('step', 300);
    const dish = pp('endpoint');
    return { r: clamp(removed / 420), step, dish };
  };
  useFrame(() => {
    if (handle.current) handle.current.position.x = div.current;
  });
  const setFrom = (e: ThreeEvent<PointerEvent>) => {
    div.current = clamp(e.point.x - INSET_POS[0], -0.55, 0.55);
  };
  const nitride = useMemo(() => {
    const regions: [number, number][] = [];
    const bounds = [-0.55, ...EDGES, 0.55];
    for (let i = 0; i < bounds.length; i += 2) regions.push([bounds[i], bounds[i + 1]]);
    return regions.map(([a, b]) => [
      [a, 0],
      [b, 0],
      [b, NIT],
      [a, NIT],
    ] as [number, number][]);
  }, []);
  const silicon = useMemo(() => band(-0.55, 0.55, siTop, BOTTOM)!, []);
  return (
    <Inset id="cmp-section" position={INSET_POS} size={[1.4, 0.9]} mpu={500e-9 / 0.55} schematic={false} title="CMP · BEFORE ◀ ▶ AFTER (DRAG)">
      <group position={[0, -0.02, 0]}>
        {/* oxide: before (left of the divider) and current (right) */}
        <LiveProfile depth={0.12} m={oxBefore} compute={() => band(-0.55, div.current, (x) => oxTop(x, 0, 300, 0), -DEPTH)} />
        <LiveProfile
          depth={0.12}
          m={oxMat}
          compute={() => {
            const c = current();
            return band(div.current, 0.55, (x) => oxTop(x, c.r, c.step, c.dish), -DEPTH);
          }}
        />
        {/* silicon and nitride are drawn slightly deeper so they sit in front of the oxide */}
        <ProfileSlab points={silicon} depth={0.13} m={siMat} />
        {nitride.map((p, i) => (
          <ProfileSlab key={i} points={p} depth={0.128} m={nitMat} />
        ))}
        <group ref={handle}>
          <mesh position={[0, 0, 0.075]} material={dividerMat}>
            <boxGeometry args={[0.006, 0.82, 0.004]} />
          </mesh>
          <mesh
            position={[0, 0.36, 0.08]}
            material={dividerMat}
            onPointerDown={(e) => {
              e.stopPropagation();
              dragging.current = true;
              if (controls) controls.enabled = false;
              (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
            }}
          >
            <sphereGeometry args={[0.03, 16, 12]} />
          </mesh>
        </group>
        {/* drag surface */}
        <mesh
          position={[0, 0, 0.09]}
          visible={false}
          onPointerDown={(e) => {
            e.stopPropagation();
            dragging.current = true;
            if (controls) controls.enabled = false;
            setFrom(e);
          }}
          onPointerMove={(e) => {
            if (!dragging.current) return;
            e.stopPropagation();
            setFrom(e);
          }}
          onPointerUp={() => {
            dragging.current = false;
            if (controls) controls.enabled = true;
          }}
          onPointerLeave={() => {
            if (!dragging.current) return;
            dragging.current = false;
            if (controls) controls.enabled = true;
          }}
        >
          <planeGeometry args={[1.3, 0.86]} />
        </mesh>
      </group>
      <TechLabel position={[-0.66, 0.4, 0.05]} title="BEFORE · STEP 300 nm" min={2} />
      <TechLabel position={[0.2, 0.4, 0.05]} title="NOW" min={2} value={() => `step ${engine.tele.value('step', 0).toFixed(0)} nm · removed ${engine.tele.value('removed', 0).toFixed(0)} nm · SIMULATED`} />
      <TechLabel position={[0.2, -0.36, 0.05]} title="NITRIDE STOP LAYER · OXIDE-FILLED TRENCHES" min={3} />
    </Inset>
  );
}

function CMPScreen() {
  return (
    <group position={[1.65, 0, -0.55]} rotation={[0, -0.6, 0]}>
      <C r={0.025} h={1.3} m={M.steelDark} position={[0, 0.65, 0]} />
      <Screen
        size={[0.62, 0.4]}
        position={[0, 1.5, 0.03]}
        hz={5}
        draw={(g, w, h) => {
          clear(g, w, h, 'ENDPOINT · MOTOR CURRENT · SIMULATED');
          bigNumber(g, 'STEP', engine.tele.value('step', 0).toFixed(0), 'nm', w * 0.05, h * 0.21, h * 0.1);
          bigNumber(g, 'MOTOR', engine.tele.value('motor', 0).toFixed(1), 'A', w * 0.37, h * 0.21, h * 0.1, inPhase('endpoint') ? SCR.warn : SCR.text);
          bigNumber(g, 'FORCE', engine.tele.value('force', 0).toFixed(2), 'psi', w * 0.68, h * 0.21, h * 0.1);
          const c = engine.tele.get('motor');
          plot(g, c ? c.series().slice(-200) : [], w * 0.05, h * 0.5, w * 0.9, h * 0.4, 0, 18, SCR.data);
        }}
      />
    </group>
  );
}

export default function CMPScene() {
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.3;
  }, []);
  return (
    <>
      <Lighting env="cleanroom" shadowExtent={5} />
      <CleanroomBay width={11} depth={8} height={4.2} />
      <Polisher />
      <CMPInset />
      <CMPScreen />
      <SensorIndicator id="downforce" channel="force" machine="cmp" position={[0.95, 1.3, -0.68]} size={0.04} />
      <SensorIndicator id="endpoint-motor" channel="motor" machine="cmp" position={[0.3, 0.7, 1.01]} size={0.04} />
      <SensorIndicator id="eddy-current" channel="removed" machine="cmp" position={[-0.25, 0.9, 0.3]} size={0.035} />
      <TechLabel position={[0.0, 1.05, 0.45]} title="PAD + SLURRY" lines={['removal ∝ pressure × velocity (Preston)']} min={2} />
      <TechLabel position={[-1.55, 1.55, 0.2]} title="BRUSH CLEAN" min={2} />
      {[-3.4, 3.4].map((x) => (
        <group key={x} position={[x, 0, 0]}>
          <B s={[2.2, 0.8, 1.9]} m={M.panel} position={[0, 0.4, 0]} />
          <C r={0.4} h={0.06} m={M.steelDark} position={[0, 0.83, 0]} />
        </group>
      ))}
      <Operator position={[-0.9, 0, 1.7]} rotation={Math.PI * 0.85} still />
    </>
  );
}
