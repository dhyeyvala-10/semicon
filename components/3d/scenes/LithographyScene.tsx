'use client';
/**
 * Lithography scanner (§23, §26) — an educational, generic EUV-style scanner:
 *   reticle: library → particle check → load onto the reticle stage → reticle alignment
 *   align:   wafer onto the measure chuck → height map (level sensor) → alignment marks →
 *            overlay corrections (use the MISALIGN slider to see what misalignment does)
 *   expose:  dual-stage swap → step & scan, field after field (reticle moves 4× opposite) →
 *            latent image in the resist → unload to the track
 * Light path is drawn in false colour: EUV (13.5 nm) is invisible and travels in vacuum.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, CleanroomBay } from '../environments';
import { M, shell, effectiveView } from '../materials';
import { B, C, GEO, Tube } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Inset, ProfileSlab, FlowLine, rect } from '../parts/section';
import { waferGeometry } from '../parts/wafer';
import { Screen, clear, plot, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { reticleTexture, drawWafer } from '../textures';
import { engine } from '@/simulation/engine';
import { pp, inPhase, pdt } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { clamp, lerp, rng, smooth, fract } from '@/lib/math';
import { exposureFields, FIELD_W, FIELD_H } from '@/simulation/models';
import type { V3 } from '../parts/primitives';

type Variant = 'reticle' | 'align' | 'expose';

const MX = -1.0; // measure position
const EX = 0.05; // expose position (optical axis)
const WY = 0.99; // wafer height on the chuck
const TI = new THREE.Vector3(2.3, WY, 0.55); // track interface
const RET_Y = 2.32; // reticle height (pattern facing down)
const RET_X = 0.2;
const FIELDS = exposureFields();
const N_FIELDS = FIELDS.length;

/* ---------------------------------------------------------------- motion */

/** Step & scan: wafer-centre offset (m) that puts the current field under the slit. */
function scanState() {
  const v = engine.player.view;
  if (v.phaseId !== 'expose') {
    const done = pp('expose') >= 1;
    return { k: done ? N_FIELDS : 0, scanning: false, dx: 0, dz: 0, scan: 0, exposed: done ? N_FIELDS : 0 };
  }
  const x = v.phaseT * N_FIELDS;
  const k = Math.min(N_FIELDS - 1, Math.floor(x));
  const u = fract(x);
  const f = FIELDS[k];
  const dir = k % 2 === 0 ? 1 : -1;
  const half = FIELD_H / 2000;
  let dx = -f.cx / 1000;
  let dz = -f.cy / 1000;
  let scan = 0;
  if (u < 0.72) {
    scan = dir * lerp(-half, half, u / 0.72);
    dz -= scan;
  } else if (k + 1 < N_FIELDS) {
    // step to the start of the next field
    const n = FIELDS[k + 1];
    const s = smooth((u - 0.72) / 0.28);
    const ndir = (k + 1) % 2 === 0 ? 1 : -1;
    const fromZ = dz - dir * half;
    const toZ = -n.cy / 1000 + ndir * half;
    dx = lerp(dx, -n.cx / 1000, s);
    dz = lerp(fromZ, toZ, s);
  } else dz -= dir * half;
  return { k, scanning: u < 0.72, dx, dz, scan, exposed: k + (u >= 0.72 ? 1 : 0) };
}

/** 24 alignment marks in the scribe lines (wafer-local x, z in m). */
const MARKS: [number, number][] = (() => {
  const step = Math.max(1, Math.floor(N_FIELDS / 24));
  return Array.from({ length: 24 }, (_, i) => {
    const f = FIELDS[(i * step) % N_FIELDS];
    return [(f.cx + FIELD_W / 2) / 1000, (f.cy + FIELD_H / 2) / 1000] as [number, number];
  });
})();

const W = new THREE.Vector3();
/** Our wafer (chuck A) position for the active variant. */
function waferPos(variant: Variant): THREE.Vector3 {
  const v = engine.player.view;
  if (variant === 'align') {
    const u = smooth(pp('load'));
    W.set(lerp(TI.x, MX, u), WY + Math.sin(Math.PI * u) * 0.12, lerp(TI.z, 0, u));
    if (v.phaseId === 'align') {
      // the stage brings each mark under the alignment sensor
      const x = v.phaseT * MARKS.length;
      const k = Math.min(MARKS.length - 1, Math.floor(x));
      const n = Math.min(MARKS.length - 1, k + 1);
      const s = smooth(clamp((fract(x) - 0.6) / 0.4));
      W.x = MX - lerp(MARKS[k][0], MARKS[n][0], s);
      W.z = -lerp(MARKS[k][1], MARKS[n][1], s);
    }
    return W;
  }
  if (variant === 'expose') {
    const sw = smooth(pp('swap'));
    const c = (MX + EX) / 2;
    const r = (EX - MX) / 2;
    W.set(c - r * Math.cos(Math.PI * sw), WY, -Math.sin(Math.PI * sw) * 0.55);
    const s = scanState();
    if (pp('swap') >= 1) W.set(EX + s.dx, WY, s.dz);
    const out = smooth(pp('unload'));
    if (out > 0) W.set(lerp(W.x, TI.x, out), WY + Math.sin(Math.PI * out) * 0.12, lerp(W.z, TI.z, out));
    return W;
  }
  return W.set(MX, WY, 0);
}

/** Reticle position for the reticle variant (library → inspection → stage). */
const R = new THREE.Vector3();
const LIB = new THREE.Vector3(-1.75, 2.55, -0.55);
const INSP = new THREE.Vector3(-1.3, 2.55, 0.35);
function reticlePos(variant: Variant): THREE.Vector3 {
  if (variant !== 'reticle') {
    R.set(RET_X, RET_Y, 0);
    if (variant === 'expose') R.z = -4 * scanState().scan; // 4× reduction: reticle scans 4× faster, opposite
    return R;
  }
  const a = smooth(pp('library'));
  const b = smooth(pp('load'));
  R.copy(LIB).lerp(INSP, a);
  if (b > 0) {
    R.lerp(new THREE.Vector3(RET_X, RET_Y, 0), b);
    R.y += Math.sin(Math.PI * b) * 0.12;
  }
  if (inPhase('align')) R.x += 0.004 * Math.sin(engine.time * 3) * (1 - engine.player.view.phaseT);
  return R;
}

/* ---------------------------------------------------------------- materials */

const beamMat = new THREE.MeshBasicMaterial({ color: '#b48cff', transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
const slitMat = new THREE.MeshBasicMaterial({ color: '#e3d0ff', toneMapped: false });
const markMat = new THREE.MeshBasicMaterial({ color: '#4fbf3f', toneMapped: false });
const markDim = new THREE.MeshBasicMaterial({ color: '#4a5048', toneMapped: false });
const arrowMat = new THREE.MeshBasicMaterial({ color: '#e8b23a', toneMapped: false });
const levelMat = new THREE.MeshBasicMaterial({ color: '#9fd18a', transparent: true, opacity: 0.8, toneMapped: false });
const mirrorMat = new THREE.MeshStandardMaterial({ color: '#8c8aa0', roughness: 0.05, metalness: 1 });
const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);

/* ---------------------------------------------------------------- scanner body */

function ScannerBody() {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  // the scanner is a closed box: the machine view looks inside it (cut-away) as well
  const view = effectiveView(viewRaw, cam === 'machine' ? 'internal' : cam);
  const sh = (m: THREE.Material) => shell(m, view);
  return (
    <Clickable sel={{ kind: 'machine', id: 'scanner', label: 'Lithography scanner' }}>
      {/* enclosure */}
      <B s={[4.6, 2.9, 0.05]} m={sh(M.panel)} position={[0.1, 1.45, -1.1]} />
      <B s={[4.6, 2.9, 0.05]} m={sh(M.panelWarm)} position={[0.1, 1.45, 1.1]} />
      <B s={[0.05, 2.9, 2.2]} m={sh(M.panel)} position={[-2.2, 1.45, 0]} />
      <B s={[0.05, 2.9, 2.2]} m={sh(M.panel)} position={[2.4, 1.45, 0]} />
      <B s={[4.62, 0.06, 2.22]} m={sh(M.panelGrey)} position={[0.1, 2.93, 0]} />
      <B s={[4.62, 0.08, 0.06]} m={sh(M.orangeAccent)} position={[0.1, 2.2, 1.13]} />
      <B s={[4.62, 0.04, 0.06]} m={sh(M.greenAccent)} position={[0.1, 0.62, 1.13]} />
      {/* service door outlines on the front */}
      {[-1.6, -0.5, 0.6, 1.7].map((x) => (
        <B key={x} s={[0.012, 1.3, 0.012]} m={sh(M.panelGrey)} position={[x, 1.35, 1.13]} />
      ))}
      {/* granite base / balance mass */}
      <B s={[3.9, 0.75, 1.7]} m={M.panelDark} position={[0, 0.375, 0]} />
      {/* metrology frame over the measure side */}
      <Clickable sel={{ kind: 'component', id: 'frame', machine: 'scanner', label: 'Metrology frame' }}>
        <B s={[2.3, 0.05, 1.1]} m={M.frame} position={[-0.45, 1.5, -0.1]} />
        {[[-1.55, -0.55], [-1.55, 0.35], [0.65, -0.55], [0.65, 0.35]].map(([x, z]) => (
          <B key={`${x}${z}`} s={[0.06, 0.75, 0.06]} m={M.frame} position={[x, 1.12, z]} />
        ))}
      </Clickable>
      {/* measure-side sensors */}
      <Clickable sel={{ kind: 'component', id: 'alignment', machine: 'scanner', label: 'Alignment sensor' }}>
        <B s={[0.16, 0.2, 0.16]} m={M.panelGrey} position={[MX, 1.38, 0]} />
        <C r={0.03} h={0.12} m={M.black} position={[MX, 1.22, 0]} />
      </Clickable>
      <Clickable sel={{ kind: 'component', id: 'level', machine: 'scanner', label: 'Level sensor' }}>
        <B s={[0.12, 0.1, 0.1]} m={M.panelGrey} position={[MX - 0.3, 1.32, 0]} rotation={[0, 0, -0.5]} />
        <B s={[0.12, 0.1, 0.1]} m={M.panelGrey} position={[MX + 0.3, 1.32, 0]} rotation={[0, 0, 0.5]} />
      </Clickable>
      {/* projection optics (mirror column) */}
      <Clickable sel={{ kind: 'component', id: 'projection', machine: 'scanner', label: 'Projection optics' }}>
        <mesh position={[EX, 1.6, 0]} material={sh(M.steel)}>
          <cylinderGeometry args={[0.36, 0.3, 0.9, 48, 1, true]} />
        </mesh>
        <C r={0.37} h={0.04} m={sh(M.steelDark)} position={[EX, 2.06, 0]} />
        <C r={0.31} h={0.04} m={sh(M.steelDark)} position={[EX, 1.15, 0]} />
        {[
          [1.28, 0.12, 0.25],
          [1.45, -0.14, -0.2],
          [1.6, 0.1, 0.18],
          [1.75, -0.12, -0.24],
          [1.9, 0.08, 0.22],
          [1.98, -0.06, -0.15],
        ].map(([y, x, tilt]) => (
          <mesh key={y} position={[EX + x, y, 0]} rotation={[0, 0, tilt]} material={mirrorMat}>
            <cylinderGeometry args={[0.1, 0.1, 0.025, 32]} />
          </mesh>
        ))}
      </Clickable>
      {/* illuminator */}
      <Clickable sel={{ kind: 'component', id: 'illuminator', machine: 'scanner', label: 'Illuminator' }}>
        <B s={[0.85, 0.42, 0.55]} m={sh(M.alu)} position={[-0.95, 2.3, 0]} />
        <mesh position={[-0.55, 2.3, 0]} rotation={[0, 0, 0.6]} material={mirrorMat}>
          <cylinderGeometry args={[0.08, 0.08, 0.02, 24]} />
        </mesh>
      </Clickable>
      {/* reticle stage carriage rails */}
      <Clickable sel={{ kind: 'component', id: 'reticle-stage', machine: 'scanner', label: 'Reticle stage' }}>
        {[-0.16, 0.16].map((dx) => (
          <B key={dx} s={[0.05, 0.05, 1.6]} m={M.steelDark} position={[RET_X + dx, RET_Y + 0.08, 0]} />
        ))}
      </Clickable>
      {/* reticle library + inspection */}
      <Clickable sel={{ kind: 'component', id: 'reticle-handler', machine: 'scanner', label: 'Reticle library & handler' }}>
        <B s={[0.5, 0.6, 0.5]} m={sh(M.panelGrey)} position={[LIB.x, 2.55, LIB.z - 0.05]} />
        {[2.33, 2.45, 2.57, 2.69, 2.81].map((y) => (
          <B key={y} s={[0.26, 0.04, 0.26]} m={M.foupDark} position={[LIB.x, y, LIB.z + 0.24]} />
        ))}
        <B s={[0.32, 0.12, 0.32]} m={M.panelGrey} position={[INSP.x, INSP.y - 0.1, INSP.z]} />
        <B s={[2.2, 0.04, 0.05]} m={M.steelDark} position={[-0.75, 2.72, 0.2]} />
      </Clickable>
      {/* wafer handler at the track interface */}
      <Clickable sel={{ kind: 'component', id: 'wafer-handler', machine: 'scanner', label: 'Wafer handler (track interface)' }}>
        <B s={[0.5, 1.2, 0.8]} m={sh(M.panelWarm)} position={[2.05, 0.6, 0.55]} />
      </Clickable>
      <SignalTower position={[2.2, 3.06, 0.9]} />
      {/* EUV source module outside the scanner body */}
      <Clickable sel={{ kind: 'component', id: 'source', machine: 'scanner', label: 'Light source (EUV, laser-produced plasma)' }}>
        <B s={[1.2, 1.8, 1.4]} m={M.panelWarm} position={[-3.3, 0.9, -0.3]} />
        <mesh position={[-3.3, 1.95, -0.3]} rotation={[0, 0, Math.PI / 2]} material={M.steel}>
          <cylinderGeometry args={[0.3, 0.3, 0.9, 32]} />
        </mesh>
        <B s={[1.22, 0.06, 1.42]} m={M.orangeAccent} position={[-3.3, 1.5, -0.3]} />
        <Tube points={[[-2.85, 1.95, -0.3], [-2.4, 2.1, -0.15], [-2.2, 2.25, 0]]} radius={0.05} m={M.steel} />
      </Clickable>
    </Clickable>
  );
}

/* ---------------------------------------------------------------- light path */

const BEAM: V3[] = [
  [-3.0, 1.95, -0.3],
  [-2.3, 2.2, -0.05],
  [-1.35, 2.3, 0],
  [-0.55, 2.3, 0],
  [RET_X - 0.02, RET_Y - 0.01, 0],
  [EX + 0.12, 2.0, 0],
  [EX - 0.1, 1.7, 0],
  [EX + 0.08, 1.4, 0],
  [EX, 1.15, 0],
];

function LightPath() {
  const group = useRef<THREE.Group>(null);
  const cone = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const on = engine.tele.value('dose', 0) > 1 && scanState().scanning;
    if (group.current) group.current.visible = on;
    beamMat.opacity = 0.25 + 0.12 * Math.sin(engine.time * 22);
    if (cone.current) cone.current.visible = on;
  });
  return (
    <group>
      <group ref={group}>
        <Tube points={BEAM} radius={0.018} m={beamMat} segments={160} />
        <FlowLine points={BEAM} color="#e3d0ff" speed={1.4} />
      </group>
      <mesh ref={cone} position={[EX, (1.15 + WY) / 2, 0]} material={beamMat}>
        <cylinderGeometry args={[0.07, 0.013, 1.15 - WY, 24, 1, true]} />
      </mesh>
    </group>
  );
}

/* ---------------------------------------------------------------- reticle */

function Reticle({ variant }: { variant: Variant }) {
  const group = useRef<THREE.Group>(null);
  const carriage = useRef<THREE.Group>(null);
  const laser = useRef<THREE.Mesh>(null);
  const tex = useMemo(() => reticleTexture(), []);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ map: tex, roughness: 0.2, metalness: 0.4 }), [tex]);
  useFrame(() => {
    const p = reticlePos(variant);
    if (group.current) group.current.position.copy(p);
    if (carriage.current) carriage.current.position.z = variant === 'expose' ? p.z : 0;
    if (variant === 'reticle') track('focus', p.x, p.y, p.z);
    if (laser.current) {
      const on = variant === 'reticle' && inPhase('inspect');
      laser.current.visible = on;
      laser.current.position.set(INSP.x, INSP.y - 0.003, INSP.z + lerp(-0.07, 0.07, fract(engine.player.view.phaseT * 2)));
    }
  });
  return (
    <>
      <group ref={carriage} position={[RET_X, RET_Y + 0.045, 0]}>
        <B s={[0.36, 0.04, 0.3]} m={M.alu} />
      </group>
      <group ref={group}>
        <Clickable sel={{ kind: 'component', id: 'reticle-stage', machine: 'scanner', label: 'Reticle (mask)' }}>
          <mesh rotation={[Math.PI / 2, 0, 0]} material={mat}>
            <planeGeometry args={[0.152, 0.152]} />
          </mesh>
          <B s={[0.152, 0.0064, 0.152]} m={M.quartz} position={[0, 0.0034, 0]} shadow={false} />
        </Clickable>
      </group>
      <mesh ref={laser} material={slitMat}>
        <boxGeometry args={[0.16, 0.001, 0.002]} />
      </mesh>
    </>
  );
}

/* ---------------------------------------------------------------- wafer + stages */

function useWaferCanvas(variant: Variant) {
  return useMemo(() => {
    const size = 512;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    let last = '';
    const heat = (x: number, y: number) => 0.5 + 0.25 * Math.sin(x * 7 + 1) * Math.cos(y * 5) + 0.25 * Math.sin((x + y) * 11);
    const draw = (key: string, fn: () => void) => {
      if (key === last) return;
      last = key;
      fn();
      tex.needsUpdate = true;
    };
    const update = () => {
      const v = engine.player.view;
      if (variant === 'expose') {
        const n = scanState().exposed;
        draw(`e${n}`, () => drawWafer(g, size, 'exposed', { exposed: n, tint: '#8f5a33' }));
        return;
      }
      // align: resist-coated wafer; height map revealed by the level-sensor sweep
      const rows = v.phaseId === 'level' ? Math.floor(v.phaseT * 32) : pp('level') >= 1 ? 32 : 0;
      draw(`a${rows}`, () => {
        g.fillStyle = '#8f5a33';
        g.fillRect(0, 0, size, size);
        const cell = size / 32;
        for (let j = 0; j < rows; j++)
          for (let i = 0; i < 32; i++) {
            const h = heat(i / 32, j / 32);
            g.fillStyle = `rgba(${Math.round(120 + 110 * h)},${Math.round(170 + 50 * (1 - h))},${Math.round(90 + 40 * h)},0.55)`;
            g.fillRect(i * cell, j * cell, cell + 0.5, cell + 0.5);
          }
      });
    };
    update();
    return { tex, update };
  }, [variant]);
}

function Stages({ variant }: { variant: Variant }) {
  const chuckA = useRef<THREE.Group>(null);
  const chuckB = useRef<THREE.Group>(null);
  const wafer = useRef<THREE.Group>(null);
  const slit = useRef<THREE.Mesh>(null);
  const marks = useRef<THREE.InstancedMesh>(null);
  const marksOn = useRef<THREE.InstancedMesh>(null);
  const arrows = useRef<THREE.InstancedMesh>(null);
  const level = useRef<THREE.Mesh>(null);
  const canvas = useWaferCanvas(variant);
  const topMat = useMemo(() => new THREE.MeshStandardMaterial({ map: canvas.tex, roughness: 0.25, metalness: 0.15 }), [canvas]);
  const waferMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.1, metalness: 0.9 }), []);
  const o = useMemo(() => new THREE.Object3D(), []);
  useFrame(() => {
    const p = waferPos(variant);
    if (wafer.current) {
      wafer.current.position.copy(p);
      wafer.current.visible = variant !== 'reticle';
    }
    if (variant !== 'reticle') track('focus', p.x, p.y, p.z);
    // chuck A carries our wafer; chuck B mirrors it across the swap
    if (chuckA.current) chuckA.current.position.set(variant === 'reticle' ? MX : p.x, WY - 0.004, variant === 'reticle' ? 0 : p.z);
    if (chuckB.current) {
      const sw = variant === 'expose' ? smooth(pp('swap')) : 0;
      const c = (MX + EX) / 2;
      const r = (EX - MX) / 2;
      chuckB.current.position.set(variant === 'align' || variant === 'reticle' ? EX : c + r * Math.cos(Math.PI * sw), WY - 0.004, variant === 'expose' ? Math.sin(Math.PI * sw) * 0.55 : 0);
    }
    canvas.update();
    const s = scanState();
    if (slit.current) {
      slit.current.visible = variant === 'expose' && s.scanning;
      slit.current.position.set(EX, WY + 0.0012, 0);
    }
    // alignment marks + overlay vectors (wafer-local)
    const v = engine.player.view;
    const measured = variant === 'align' ? engine.tele.value('marks', 0) : 0;
    const showVec = variant === 'align' && (v.phaseId === 'correct');
    const ovx = engine.tele.value('ovx', 0);
    const ovy = engine.tele.value('ovy', 0);
    MARKS.forEach(([mx, mz], i) => {
      const on = i < measured;
      o.position.set(mx, 0.0012, mz);
      o.rotation.set(0, 0, 0);
      o.scale.set(variant === 'align' ? 0.008 : 0, 0.0006, 0.008);
      o.updateMatrix();
      (on ? marksOn.current : marks.current)?.setMatrixAt(i, o.matrix);
      (on ? marks.current : marksOn.current)?.setMatrixAt(i, HIDE);
      if (arrows.current) {
        // translation + small wafer-scale rotation / expansion residual (nm)
        const vx = ovx - 6 * mz + 4 * mx;
        const vz = ovy + 6 * mx + 4 * mz;
        const len = Math.hypot(vx, vz) * 0.0035;
        if (!showVec || len < 1e-4) arrows.current.setMatrixAt(i, HIDE);
        else {
          o.position.set(mx + (vx * 0.0035) / 2, 0.0016, mz + (vz * 0.0035) / 2);
          o.rotation.set(0, -Math.atan2(vz, vx), 0);
          o.scale.set(len, 0.0008, 0.0025);
          o.updateMatrix();
          arrows.current.setMatrixAt(i, o.matrix);
        }
      }
    });
    for (const m of [marks.current, marksOn.current, arrows.current]) if (m) m.instanceMatrix.needsUpdate = true;
    if (level.current) {
      const on = variant === 'align' && v.phaseId === 'level';
      level.current.visible = on;
      level.current.position.set(0, 0.002, lerp(-0.15, 0.15, v.phaseT));
    }
  });
  return (
    <group>
      <Clickable sel={{ kind: 'component', id: 'wafer-stage', machine: 'scanner', label: 'Wafer stage (chuck A)' }}>
        <group ref={chuckA}>
          <B s={[0.4, 0.05, 0.4]} m={M.ceramic} position={[0, -0.025, 0]} />
          <B s={[0.52, 0.16, 0.52]} m={M.alu} position={[0, -0.13, 0]} />
        </group>
      </Clickable>
      <Clickable sel={{ kind: 'component', id: 'measure-stage', machine: 'scanner', label: 'Wafer stage (chuck B)' }}>
        <group ref={chuckB}>
          <B s={[0.4, 0.05, 0.4]} m={M.ceramic} position={[0, -0.025, 0]} />
          <B s={[0.52, 0.16, 0.52]} m={M.alu} position={[0, -0.13, 0]} />
          <mesh position={[0, 0.006, 0]} geometry={waferGeometry()} material={waferMat} />
        </group>
      </Clickable>
      <group ref={wafer}>
        <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184' }}>
          <mesh geometry={waferGeometry()} material={waferMat} castShadow />
          <mesh position={[0, 0.0005, 0]} rotation={[-Math.PI / 2, 0, 0]} material={topMat}>
            <circleGeometry args={[0.149, 64]} />
          </mesh>
          <instancedMesh ref={marks} args={[GEO.box, markDim, MARKS.length]} frustumCulled={false} />
          <instancedMesh ref={marksOn} args={[GEO.box, markMat, MARKS.length]} frustumCulled={false} />
          <instancedMesh ref={arrows} args={[GEO.box, arrowMat, MARKS.length]} frustumCulled={false} />
          <mesh ref={level} material={levelMat}>
            <boxGeometry args={[0.3, 0.0008, 0.004]} />
          </mesh>
        </Clickable>
      </group>
      <mesh ref={slit} material={slitMat}>
        <boxGeometry args={[FIELD_W / 1000, 0.0006, 0.0025]} />
      </mesh>
      <TechLabel position={[EX + 0.35, 1.05, 0.25]} title="EXPOSURE SLIT" min={3} show={() => variant === 'expose'} />
    </group>
  );
}

/* ---------------------------------------------------------------- insets */

const subMat = new THREE.MeshStandardMaterial({ color: '#7a828c', roughness: 0.45, metalness: 0.6 });
const resistMat = new THREE.MeshPhysicalMaterial({ color: '#b5612a', roughness: 0.3, transparent: true, opacity: 0.92 });
const exposedMat = new THREE.MeshPhysicalMaterial({ color: '#dd9a52', roughness: 0.3, transparent: true, opacity: 0.92 });
const acidMat = new THREE.MeshBasicMaterial({ color: '#f4e6a6', toneMapped: false });

/** Latent image: exposed regions of the resist are chemically changed (photo-acid). */
function LatentInset() {
  const H = 0.3;
  const spaces = [-0.36, -0.12, 0.12, 0.36];
  const w = 0.12;
  const acid = useRef<THREE.InstancedMesh>(null);
  const seeds = useMemo(() => {
    const r = rng(17);
    return Array.from({ length: 120 }, (_, i) => ({ c: spaces[i % 4], x: (r() - 0.5) * w * 0.9, y: r() * H * 0.95, ph: r() * 6 }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const o = useMemo(() => new THREE.Object3D(), []);
  const t = useRef(0);
  const lines = useMemo(() => {
    const edges = [-0.55, ...spaces.flatMap((c) => [c - w / 2, c + w / 2]), 0.55];
    const out: [number, number][][] = [];
    for (let i = 0; i < edges.length; i += 2) out.push(rect(edges[i], 0, edges[i + 1], H));
    return out;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const aerial = useMemo(() => Array.from({ length: 111 }, (_, i) => {
    const x = -0.55 + i * 0.01;
    const I = Math.pow(Math.cos(((x - 0.12) / 0.48) * Math.PI * 2), 2);
    return [x, H + 0.06 + 0.16 * I, 0.08] as V3;
  }), []);
  useFrame((_, dt) => {
    t.current += pdt(dt);
    if (!acid.current) return;
    const k = engine.player.view.phaseId === 'zoom' || pp('zoom') >= 1 ? 1 : clamp(engine.tele.value('fields', 0) / N_FIELDS);
    seeds.forEach((s, i) => {
      o.position.set(s.c + s.x + 0.004 * Math.sin(t.current * 4 + s.ph), s.y, 0.075);
      o.scale.setScalar(i / seeds.length < k ? 0.008 : 0);
      o.updateMatrix();
      acid.current!.setMatrixAt(i, o.matrix);
    });
    acid.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <Inset id="latent-section" position={[2.9, 1.5, 1.45]} size={[1.3, 0.85]} mpu={110e-9 / H} schematic={false} title="LATENT IMAGE · RESIST CROSS-SECTION">
      <group position={[0, -0.2, 0]}>
        <ProfileSlab points={rect(-0.55, -0.16, 0.55, 0)} depth={0.14} m={subMat} />
        {lines.map((p, i) => (
          <ProfileSlab key={i} points={p} depth={0.14} m={resistMat} />
        ))}
        {spaces.map((c) => (
          <ProfileSlab key={c} points={rect(c - w / 2, 0, c + w / 2, H)} depth={0.14} m={exposedMat} />
        ))}
        <instancedMesh ref={acid} args={[GEO.sphereLow, acidMat, 120]} frustumCulled={false} />
        <Line points={aerial} color="#d6b8ff" lineWidth={1.5} />
      </group>
      <TechLabel position={[-0.6, 0.36, 0.05]} title="AERIAL IMAGE (LIGHT INTENSITY)" min={2} />
      <TechLabel position={[0.15, -0.34, 0.05]} title="EXPOSED → PHOTO-ACID · NEXT: DEVELOP" min={3} />
    </Inset>
  );
}

/** Box-in-box overlay target; the inner (current layer) box moves with the measured overlay. */
function OverlayInset() {
  const inner = useRef<THREE.Group>(null);
  const K = 0.009; // inset units per nm (offset magnified)
  useFrame(() => {
    if (inner.current) inner.current.position.set(engine.tele.value('ovx', 0) * K, engine.tele.value('ovy', 0) * K, 0.01);
  });
  const frame = (s: number, t: number, m: THREE.Material) => (
    <>
      <B s={[s, t, 0.03]} m={m} position={[0, s / 2 - t / 2, 0]} />
      <B s={[s, t, 0.03]} m={m} position={[0, -s / 2 + t / 2, 0]} />
      <B s={[t, s, 0.03]} m={m} position={[s / 2 - t / 2, 0, 0]} />
      <B s={[t, s, 0.03]} m={m} position={[-s / 2 + t / 2, 0, 0]} />
    </>
  );
  return (
    <Inset id="overlay-target" position={[2.9, 1.5, 1.45]} size={[1.3, 0.85]} mpu={30e-6 / 1.3} title="OVERLAY TARGET · OFFSET MAGNIFIED">
      <group position={[-0.2, -0.02, 0]}>
        {frame(0.6, 0.07, M.greenAccent)}
        <group ref={inner}>{frame(0.3, 0.05, resistMat)}</group>
      </group>
      <TechLabel position={[0.15, 0.3, 0.05]} title="OVERLAY (X / Y)" min={2} value={() => `${engine.tele.value('ovx', 0).toFixed(1)} / ${engine.tele.value('ovy', 0).toFixed(1)} nm`} />
      <TechLabel
        position={[0.15, 0.05, 0.05]}
        title="VERDICT"
        min={2}
        tone="accent"
        value={() => {
          const m = Math.max(Math.abs(engine.tele.value('ovx', 0)), Math.abs(engine.tele.value('ovy', 0)));
          return m > 6 ? 'OUT OF SPEC → REWORK: strip resist, re-coat, re-expose' : m > 3 ? 'MARGINAL → corrections applied, monitor' : 'IN SPEC → expose';
        }}
      />
      <TechLabel position={[0.15, -0.2, 0.05]} title="OUTER: PREVIOUS LAYER · INNER: THIS LAYER" min={3} />
    </Inset>
  );
}

/** The reticle magnified: one layer of the chip, 4× larger than on the wafer. */
function ReticleInset() {
  const tex = useMemo(() => reticleTexture(), []);
  const scan = useRef<THREE.Mesh>(null);
  useFrame(() => {
    if (scan.current) {
      scan.current.visible = inPhase('inspect');
      scan.current.position.y = lerp(0.42, -0.42, fract(engine.player.view.phaseT * 2));
    }
  });
  return (
    <Inset id="reticle-mag" position={[-2.85, 2.75, 0.9]} size={[1.2, 0.95]} mpu={0.152 / 0.84} title="RETICLE · PATTERN ×4">
      <mesh>
        <planeGeometry args={[0.84, 0.84]} />
        <meshStandardMaterial map={tex} roughness={0.3} metalness={0.3} />
      </mesh>
      <mesh ref={scan} position={[0, 0, 0.01]}>
        <boxGeometry args={[0.9, 0.006, 0.002]} />
        <meshBasicMaterial color="#9fd18a" toneMapped={false} />
      </mesh>
      <TechLabel position={[0.44, 0.38, 0.02]} title="152 mm QUARTZ PLATE" lines={['EUV: absorber on a multilayer mirror', 'DUV: chrome on quartz']} min={2} />
      <TechLabel position={[0.44, 0.0, 0.02]} title="PARTICLE CHECK" min={2} value={() => `${engine.tele.value('rpart', 0).toFixed(0)} particles ≥ 0.5 µm · SIMULATED`} />
    </Inset>
  );
}

/* ---------------------------------------------------------------- screen */

function ScanScreen({ variant }: { variant: Variant }) {
  return (
    <group position={[3.0, 0, 0.1]} rotation={[0, -0.75, 0]}>
      <C r={0.025} h={1.35} m={M.steelDark} position={[0, 0.68, 0]} />
      <Screen
        size={[0.66, 0.42]}
        position={[0, 1.55, 0.03]}
        hz={5}
        draw={(g, w, h) => {
          if (variant === 'align') {
            clear(g, w, h, 'OVERLAY · ALIGNMENT · SIMULATED');
            const ovx = engine.tele.value('ovx', 0);
            const ovy = engine.tele.value('ovy', 0);
            const bad = Math.max(Math.abs(ovx), Math.abs(ovy));
            bigNumber(g, 'X', ovx.toFixed(1), 'nm', w * 0.06, h * 0.22, h * 0.11, bad > 6 ? SCR.crit : bad > 3 ? SCR.warn : SCR.text);
            bigNumber(g, 'Y', ovy.toFixed(1), 'nm', w * 0.4, h * 0.22, h * 0.11, bad > 6 ? SCR.crit : bad > 3 ? SCR.warn : SCR.text);
            bigNumber(g, 'MARKS', engine.tele.value('marks', 0).toFixed(0), '/ 24', w * 0.72, h * 0.22, h * 0.11);
            const c = engine.tele.get('ovx');
            plot(g, c ? c.series().slice(-160) : [], w * 0.06, h * 0.5, w * 0.88, h * 0.4, -12, 12, SCR.data);
            return;
          }
          if (variant === 'reticle') {
            clear(g, w, h, 'RETICLE HANDLING · SIMULATED');
            bigNumber(g, 'TEMP', engine.tele.value('rtemp', 22).toFixed(3), '°C', w * 0.06, h * 0.25, h * 0.11);
            bigNumber(g, 'ALIGN ERR', engine.tele.value('ralign', 0).toFixed(1), 'nm', w * 0.5, h * 0.25, h * 0.11);
            const c = engine.tele.get('ralign');
            plot(g, c ? c.series().slice(-160) : [], w * 0.06, h * 0.55, w * 0.88, h * 0.35, 0, 160, SCR.data);
            return;
          }
          clear(g, w, h, 'STEP & SCAN · SIMULATED');
          bigNumber(g, 'FIELDS', engine.tele.value('fields', 0).toFixed(0), `/ ${N_FIELDS}`, w * 0.06, h * 0.22, h * 0.11);
          bigNumber(g, 'DOSE', engine.tele.value('dose', 0).toFixed(1), 'mJ/cm²', w * 0.5, h * 0.22, h * 0.11);
          const c = engine.tele.get('vel');
          plot(g, c ? c.series().slice(-160) : [], w * 0.06, h * 0.52, w * 0.88, h * 0.38, 0, 600, SCR.data);
        }}
      />
    </group>
  );
}

/* ---------------------------------------------------------------- scene */

export default function LithographyScene({ stage }: SceneProps) {
  const variant = ((stage.variant as Variant) ?? 'expose') as Variant;
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.02;
  }, []);
  return (
    <>
      <Lighting env="litho" shadowExtent={7} />
      <CleanroomBay width={13} depth={9} height={4.4} amber />
      <ScannerBody />
      <LightPath />
      <Reticle variant={variant} />
      <Stages variant={variant} />
      <SensorIndicator id="interferometer" channel={variant === 'expose' ? 'vel' : undefined} machine="scanner" position={[EX + 0.45, 0.9, 0.5]} size={0.04} />
      <SensorIndicator id="level-sensor" channel={variant === 'align' ? 'focus' : undefined} machine="scanner" position={[MX - 0.3, 1.42, 0.08]} size={0.035} />
      <SensorIndicator id="alignment-sensor" channel={variant === 'align' ? 'marks' : undefined} machine="scanner" position={[MX + 0.1, 1.5, 0.1]} size={0.035} />
      <SensorIndicator id="dose-sensor" channel={variant === 'expose' ? 'dose' : undefined} machine="scanner" position={[EX + 0.3, 1.0, -0.25]} size={0.035} />
      {variant === 'expose' && <LatentInset />}
      {variant === 'align' && <OverlayInset />}
      {variant === 'reticle' && <ReticleInset />}
      <ScanScreen variant={variant} />
      <TechLabel position={[EX + 0.4, 1.9, 0.3]} title="PROJECTION OPTICS · 4× REDUCTION" min={2} />
      <TechLabel position={[-0.95, 2.6, 0.3]} title="ILLUMINATOR" min={3} />
      <TechLabel position={[RET_X + 0.2, 2.55, 0.3]} title="RETICLE STAGE" min={2} value={() => (variant === 'expose' ? `scan ${(Math.abs(reticlePos(variant).z) * 1000).toFixed(0)} mm · 4× wafer speed` : engine.player.view.phase.label)} />
      <TechLabel position={[MX - 0.3, 1.7, 0.3]} title="MEASURE SIDE" lines={['level + alignment sensors']} min={2} />
      <TechLabel position={[-3.3, 1.25, 0.45]} title="EUV SOURCE · GENERIC" lines={['13.5 nm light — invisible, shown in false colour', 'travels in vacuum']} min={2} />
      <Operator position={[-1.4, 0, 1.75]} rotation={Math.PI} still />
    </>
  );
}
