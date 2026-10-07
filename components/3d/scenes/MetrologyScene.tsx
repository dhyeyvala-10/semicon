'use client';
/**
 * Metrology (§40): a combined, generic metrology tool with four heads on one bridge —
 * CD-SEM (line width), ellipsometer (film thickness), overlay microscope (layer-to-layer
 * placement) and AFM (surface profile); then etch depth. The stage brings the wafer under
 * each head; the inset shows what that instrument actually "sees". Values are SIMULATED and
 * come from the same ground truth that built the structures (METRO).
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Lighting, CleanroomBay } from '../environments';
import { M } from '../materials';
import { B, C } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Inset } from '../parts/section';
import { waferGeometry } from '../parts/wafer';
import { Screen, clear, plot, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { waferTexture } from '../textures';
import { engine } from '@/simulation/engine';
import { cutPlane, track } from '@/lib/runtime';
import { clamp, smooth, rng } from '@/lib/math';
import { METRO } from '@/simulation/models';

const HEADS: Record<string, { x: number; label: string; id: string }> = {
  cd: { x: -0.48, label: 'CD-SEM', id: 'cdsem' },
  film: { x: -0.16, label: 'ELLIPSOMETER', id: 'ellipsometer' },
  overlay: { x: 0.16, label: 'OVERLAY', id: 'overlay' },
  profile: { x: 0.48, label: 'AFM', id: 'afm' },
  depth: { x: -0.48, label: 'CD-SEM (tilt)', id: 'cdsem' },
};
const ORDER = ['cd', 'film', 'overlay', 'profile', 'depth'];
const WY = 1.0;

function activeHead() {
  return HEADS[engine.player.view.phaseId] ?? HEADS.cd;
}

/* ---------------------------------------------------------------- tool */

const beamMat = new THREE.MeshBasicMaterial({ color: '#c9a6ff', transparent: true, opacity: 0.8, toneMapped: false, depthWrite: false });
const lightMat = new THREE.MeshBasicMaterial({ color: '#f0e08a', transparent: true, opacity: 0.75, toneMapped: false, depthWrite: false });
const ledOn = new THREE.MeshBasicMaterial({ color: '#4fbf3f', toneMapped: false });

function Tool() {
  const wafer = useRef<THREE.Group>(null);
  const stage = useRef<THREE.Group>(null);
  const sem = useRef<THREE.Mesh>(null);
  const ell = useRef<THREE.Group>(null);
  const ovl = useRef<THREE.Mesh>(null);
  const tip = useRef<THREE.Group>(null);
  const leds = useRef<(THREE.Mesh | null)[]>([]);
  const tex = useMemo(() => waferTexture('dies', { size: 512 }), []);
  const top = useMemo(() => new THREE.MeshStandardMaterial({ map: tex, roughness: 0.2, metalness: 0.4 }), [tex]);
  const waferMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.1, metalness: 0.9 }), []);
  const pos = useRef(new THREE.Vector3(0, WY, 0.05));
  useFrame((_, dt) => {
    const v = engine.player.view;
    const h = activeHead();
    // the stage moves a measurement site under the active head (a different site per phase)
    const site = ORDER.indexOf(v.phaseId);
    const target = new THREE.Vector3(h.x + 0.06 * Math.sin(site * 2.1), WY, 0.05 + 0.05 * Math.cos(site * 1.3));
    pos.current.lerp(target, Math.min(1, dt * 2.5));
    if (wafer.current) wafer.current.position.copy(pos.current);
    if (stage.current) stage.current.position.set(pos.current.x, 0, pos.current.z);
    track('focus', h.x, WY + 0.1, 0);
    const measuring = v.phaseT > 0.15;
    if (sem.current) sem.current.visible = (v.phaseId === 'cd' || v.phaseId === 'depth') && measuring;
    if (ell.current) ell.current.visible = v.phaseId === 'film' && measuring;
    if (ovl.current) ovl.current.visible = v.phaseId === 'overlay' && measuring;
    if (tip.current) {
      const afm = v.phaseId === 'profile';
      tip.current.position.y = afm ? WY + 0.02 + 0.004 * Math.sin(engine.time * 40) : WY + 0.08;
    }
    ['cd', 'film', 'overlay', 'profile'].forEach((k, i) => {
      const m = leds.current[i];
      if (m) m.visible = HEADS[k].id === h.id;
    });
  });
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'metrology', label: 'Metrology tool' }}>
        {/* frame + granite */}
        <B s={[2.0, 0.8, 1.4]} m={M.panel} position={[0, 0.4, 0]} />
        <B s={[1.7, 0.12, 1.1]} m={M.panelDark} position={[0, 0.86, 0]} />
        <B s={[2.02, 0.05, 1.42]} m={M.greenAccent} position={[0, 0.79, 0]} />
        {/* bridge */}
        {[-0.85, 0.85].map((x) => (
          <B key={x} s={[0.08, 0.95, 0.12]} m={M.frame} position={[x, 1.38, -0.25]} />
        ))}
        <B s={[1.8, 0.14, 0.16]} m={M.frame} position={[0, 1.88, -0.25]} />
        {/* CD-SEM column */}
        <Clickable sel={{ kind: 'component', id: 'cdsem', machine: 'metrology', label: 'CD-SEM column' }}>
          <C r={0.09} h={0.62} m={M.steel} position={[HEADS.cd.x, 1.48, -0.02]} />
          <C r={0.05} h={0.14} m={M.steelDark} position={[HEADS.cd.x, 1.1, -0.02]} />
          <C r={0.12} h={0.1} m={M.panelGrey} position={[HEADS.cd.x, 1.82, -0.02]} />
        </Clickable>
        {/* ellipsometer arms */}
        <Clickable sel={{ kind: 'component', id: 'ellipsometer', machine: 'metrology', label: 'Ellipsometer' }}>
          <B s={[0.05, 0.05, 0.3]} m={M.alu} position={[HEADS.film.x - 0.12, 1.2, -0.05]} rotation={[0, 0, -0.9]} />
          <B s={[0.05, 0.05, 0.3]} m={M.alu} position={[HEADS.film.x + 0.12, 1.2, -0.05]} rotation={[0, 0, 0.9]} />
          <B s={[0.06, 0.62, 0.06]} m={M.frame} position={[HEADS.film.x, 1.55, -0.2]} />
        </Clickable>
        {/* overlay microscope */}
        <Clickable sel={{ kind: 'component', id: 'overlay', machine: 'metrology', label: 'Overlay microscope' }}>
          <C r={0.06} h={0.5} m={M.panelGrey} position={[HEADS.overlay.x, 1.42, -0.02]} />
          <C r={0.035} h={0.12} m={M.black} position={[HEADS.overlay.x, 1.12, -0.02]} />
        </Clickable>
        {/* AFM head */}
        <Clickable sel={{ kind: 'component', id: 'afm', machine: 'metrology', label: 'AFM probe' }}>
          <B s={[0.12, 0.4, 0.12]} m={M.panelWarm} position={[HEADS.profile.x, 1.5, -0.08]} />
        </Clickable>
        {['cd', 'film', 'overlay', 'profile'].map((k, i) => (
          <mesh
            key={k}
            ref={(el) => {
              leds.current[i] = el;
            }}
            position={[HEADS[k].x, 1.88, -0.16]}
            material={ledOn}
          >
            <sphereGeometry args={[0.018, 10, 8]} />
          </mesh>
        ))}
        <SignalTower position={[0.85, 2.0, -0.25]} />
      </Clickable>
      {/* AFM cantilever + tip (taps the surface) */}
      <group ref={tip} position={[HEADS.profile.x, WY + 0.08, -0.02]}>
        <B s={[0.07, 0.006, 0.02]} m={M.steel} position={[0, 0.03, 0]} />
        <mesh position={[0.03, 0.012, 0]} rotation={[Math.PI, 0, 0]} material={M.steelDark}>
          <coneGeometry args={[0.006, 0.025, 8]} />
        </mesh>
        <B s={[0.02, 0.28, 0.02]} m={M.steel} position={[-0.03, 0.17, 0]} />
      </group>
      {/* beams */}
      <mesh ref={sem} position={[HEADS.cd.x, (1.03 + WY) / 2, -0.02]} material={beamMat}>
        <cylinderGeometry args={[0.0015, 0.004, 1.03 - WY, 8]} />
      </mesh>
      <group ref={ell}>
        <mesh position={[HEADS.film.x - 0.09, WY + 0.09, -0.05]} rotation={[0, 0, -0.78]} material={lightMat}>
          <cylinderGeometry args={[0.003, 0.003, 0.25, 6]} />
        </mesh>
        <mesh position={[HEADS.film.x + 0.09, WY + 0.09, -0.05]} rotation={[0, 0, 0.78]} material={lightMat}>
          <cylinderGeometry args={[0.003, 0.003, 0.25, 6]} />
        </mesh>
      </group>
      <mesh ref={ovl} position={[HEADS.overlay.x, (1.06 + WY) / 2, -0.02]} material={lightMat}>
        <cylinderGeometry args={[0.012, 0.03, 1.06 - WY, 16, 1, true]} />
      </mesh>
      {/* stage + wafer */}
      <group ref={stage}>
        <B s={[0.42, 0.06, 0.42]} m={M.alu} position={[0, 0.95, 0]} />
      </group>
      <group ref={wafer}>
        <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184' }}>
          <mesh geometry={waferGeometry()} material={waferMat} castShadow />
          <mesh position={[0, 0.0005, 0]} rotation={[-Math.PI / 2, 0, 0]} material={top}>
            <circleGeometry args={[0.149, 64]} />
          </mesh>
        </Clickable>
      </group>
    </group>
  );
}

/* ---------------------------------------------------------------- instrument views */

const semNoise = (() => {
  const r = rng(91);
  return Array.from({ length: 4000 }, () => [r(), r(), r()] as [number, number, number]);
})();

function drawInstrument(g: CanvasRenderingContext2D, w: number, h: number) {
  const v = engine.player.view;
  const id = v.phaseId;
  const k = v.phaseT;
  g.fillStyle = '#0b100c';
  g.fillRect(0, 0, w, h);
  const ink = (c: string, s = 0.045) => {
    g.fillStyle = c;
    g.font = `${Math.round(h * s)}px monospace`;
  };
  if (id === 'cd') {
    // top-down SEM image: lines with bright edges (secondary-electron edge effect) + shot noise
    const cd = METRO.cdActual();
    const pitch = w / 6;
    for (let x = 0; x < w; x++) {
      const u = (x % pitch) / pitch;
      const line = u > 0.25 && u < 0.75;
      const edge = Math.min(Math.abs(u - 0.25), Math.abs(u - 0.75)) < 0.025;
      const lum = edge ? 225 : line ? 140 : 60;
      g.fillStyle = `rgb(${lum},${lum + 4},${lum - 6})`;
      g.fillRect(x, h * 0.1, 1, h * 0.72);
    }
    for (const [a, b, c] of semNoise) {
      g.fillStyle = `rgba(255,255,240,${c * 0.18})`;
      g.fillRect(a * w, h * 0.1 + b * h * 0.72, 1.5, 1.5);
    }
    // measurement cursors on one line
    const x0 = pitch * 2 + pitch * 0.25;
    const x1 = pitch * 2 + pitch * 0.75;
    g.strokeStyle = SCR.warn;
    g.lineWidth = 2;
    g.setLineDash([6, 4]);
    for (const x of [x0, x1]) {
      g.beginPath();
      g.moveTo(x, h * 0.12);
      g.lineTo(x, h * 0.8);
      g.stroke();
    }
    g.setLineDash([]);
    ink(SCR.text, 0.07);
    g.fillText(k > 0.5 ? `CD = ${cd.toFixed(2)} nm` : 'measuring…', w * 0.04, h * 0.94);
    ink(SCR.dim);
    g.fillText(`target ${METRO.cdTarget} nm · SEM top view · SIMULATED`, w * 0.45, h * 0.94);
    return;
  }
  if (id === 'film') {
    // film stack with the polarised beam reflecting at both interfaces
    const yF = h * 0.45;
    const yS = h * 0.62;
    g.fillStyle = '#6c747e';
    g.fillRect(0, yS, w, h * 0.3);
    g.fillStyle = 'rgba(169,194,160,0.85)';
    g.fillRect(0, yF, w, yS - yF);
    g.strokeStyle = '#f0e08a';
    g.lineWidth = 3;
    const cx = w * 0.5;
    g.beginPath();
    g.moveTo(cx - w * 0.3, h * 0.08);
    g.lineTo(cx, yF);
    g.lineTo(cx + w * 0.3, h * 0.08);
    g.stroke();
    g.globalAlpha = 0.6;
    g.beginPath();
    g.moveTo(cx, yF);
    g.lineTo(cx + w * 0.05, yS);
    g.lineTo(cx + w * 0.1, yF);
    g.lineTo(cx + w * 0.4, h * 0.08);
    g.stroke();
    g.globalAlpha = 1;
    ink(SCR.text, 0.07);
    g.fillText(k > 0.5 ? `t = ${METRO.film.toFixed(1)} nm` : 'fitting Ψ, Δ…', w * 0.04, h * 0.94);
    ink(SCR.dim);
    g.fillText('polarisation change → thickness · SIMULATED', w * 0.4, h * 0.94);
    return;
  }
  if (id === 'overlay') {
    const cx = w * 0.5;
    const cy = h * 0.45;
    const s = h * 0.62;
    g.strokeStyle = '#9fd18a';
    g.lineWidth = h * 0.05;
    g.strokeRect(cx - s / 2, cy - s / 2, s, s);
    const mag = 9; // offset magnified for visibility
    const ox = METRO.overlay.x * mag;
    const oy = -METRO.overlay.y * mag;
    g.strokeStyle = '#d99545';
    g.lineWidth = h * 0.035;
    g.strokeRect(cx - s / 4 + ox, cy - s / 4 + oy, s / 2, s / 2);
    ink(SCR.text, 0.065);
    g.fillText(k > 0.5 ? `x ${METRO.overlay.x.toFixed(1)} nm · y ${METRO.overlay.y.toFixed(1)} nm` : 'imaging targets…', w * 0.04, h * 0.94);
    ink(SCR.dim);
    g.fillText('offset ×9 for visibility', w * 0.62, h * 0.94);
    return;
  }
  if (id === 'profile') {
    // AFM: the tip trace IS the measurement — drawn as the tip moves
    const n = 220;
    const upto = Math.floor(n * k);
    g.strokeStyle = SCR.grid;
    g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      g.beginPath();
      g.moveTo(w * 0.05, h * (0.15 + i * 0.16));
      g.lineTo(w * 0.95, h * (0.15 + i * 0.16));
      g.stroke();
    }
    g.strokeStyle = SCR.data;
    g.lineWidth = 2.5;
    g.beginPath();
    for (let i = 0; i <= upto; i++) {
      const x = i / n;
      const y = METRO.profile(x);
      const px = w * (0.05 + 0.9 * x);
      const py = h * 0.78 - (y / 60) * h * 0.6;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();
    const tx = w * (0.05 + 0.9 * (upto / n));
    const ty = h * 0.78 - (METRO.profile(upto / n) / 60) * h * 0.6;
    g.fillStyle = SCR.warn;
    g.beginPath();
    g.moveTo(tx, ty - 3);
    g.lineTo(tx - 8, ty - 26);
    g.lineTo(tx + 8, ty - 26);
    g.fill();
    ink(SCR.text, 0.065);
    g.fillText(`height ${engine.tele.value('height', 0).toFixed(1)} nm`, w * 0.04, h * 0.94);
    ink(SCR.dim);
    g.fillText('AFM tip trace · lines 45 nm tall · SIMULATED', w * 0.45, h * 0.94);
    return;
  }
  // depth: tilted cross-section view of an etched trench
  g.fillStyle = 'rgba(169,194,160,0.9)';
  g.fillRect(0, h * 0.25, w, h * 0.5);
  g.fillStyle = '#6c747e';
  g.fillRect(0, h * 0.75, w, h * 0.15);
  const d = h * 0.48 * smooth(clamp(k * 1.5));
  g.fillStyle = '#0b100c';
  g.fillRect(w * 0.42, h * 0.25, w * 0.16, d);
  g.strokeStyle = SCR.warn;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(w * 0.64, h * 0.25);
  g.lineTo(w * 0.64, h * 0.25 + d);
  g.stroke();
  ink(SCR.text, 0.065);
  g.fillText(k > 0.5 ? `depth = ${METRO.depth} nm (target 120)` : 'tilting stage…', w * 0.04, h * 0.94);
}

function InstrumentInset() {
  return (
    <Inset id="metro-view" position={[0, 1.65, 0.6]} size={[1.3, 0.85]} mpu={300e-9 / 1.2} title="INSTRUMENT VIEW">
      <Screen size={[1.22, 0.78]} position={[0, 0, 0]} hz={12} res={640} frame={false} draw={(g, w, h) => drawInstrument(g, w, h)} />
      <TechLabel position={[0.42, 0.44, 0.02]} title="ACTIVE HEAD" min={2} value={() => activeHead().label} />
    </Inset>
  );
}

/** Statistical process control chart for the parameter being measured. */
function SPCScreen() {
  const series = useRef<Record<string, number[]>>({});
  return (
    <group position={[1.55, 0, -0.35]} rotation={[0, -0.55, 0]}>
      <C r={0.025} h={1.35} m={M.steelDark} position={[0, 0.68, 0]} />
      <Screen
        size={[0.66, 0.42]}
        position={[0, 1.55, 0.03]}
        hz={4}
        draw={(g, w, h) => {
          const id = engine.player.view.phaseId;
          const label = { cd: 'LINE CD', film: 'FILM', overlay: 'OVERLAY', profile: 'AFM HEIGHT', depth: 'ETCH DEPTH' }[id] ?? id;
          clear(g, w, h, `SPC · ${label} · SIMULATED`);
          // representative lot history around the target with ±3σ control limits
          if (!series.current[id]) {
            const r = rng(id.length * 7 + 3);
            const base = id === 'cd' ? 24 : id === 'film' ? 52.4 : id === 'overlay' ? 2.1 : id === 'depth' ? 118 : 30;
            const s = base * 0.02;
            series.current[id] = Array.from({ length: 30 }, () => base + (r() + r() + r() - 1.5) * s * 1.4);
          }
          const data = series.current[id];
          const mean = data.reduce((a, b) => a + b, 0) / data.length;
          const sd = Math.sqrt(data.reduce((a, b) => a + (b - mean) ** 2, 0) / data.length);
          const lo = mean - 4 * sd;
          const hi = mean + 4 * sd;
          plot(g, data, w * 0.06, h * 0.32, w * 0.88, h * 0.56, lo, hi, SCR.data);
          for (const [val, col] of [
            [mean + 3 * sd, SCR.warn],
            [mean - 3 * sd, SCR.warn],
            [mean, SCR.dim],
          ] as [number, string][]) {
            const y = h * 0.32 + h * 0.56 - ((val - lo) / (hi - lo)) * h * 0.56;
            g.strokeStyle = col;
            g.setLineDash([5, 4]);
            g.beginPath();
            g.moveTo(w * 0.06, y);
            g.lineTo(w * 0.94, y);
            g.stroke();
            g.setLineDash([]);
          }
          bigNumber(g, 'MEAN', mean.toFixed(2), '', w * 0.06, h * 0.17, h * 0.08);
          bigNumber(g, 'σ', sd.toFixed(2), '', w * 0.4, h * 0.17, h * 0.08);
          bigNumber(g, 'STATUS', 'IN CONTROL', '', w * 0.66, h * 0.17, h * 0.06, SCR.good);
        }}
      />
    </group>
  );
}

export default function MetrologyScene() {
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.3;
  }, []);
  return (
    <>
      <Lighting env="cleanroom" shadowExtent={5} />
      <CleanroomBay width={11} depth={8} height={4.2} />
      <Tool />
      <InstrumentInset />
      <SPCScreen />
      <SensorIndicator id="ellipsometer" channel="film" machine="metrology" position={[HEADS.film.x, 1.32, 0.02]} size={0.03} />
      <TechLabel
        position={[-1.0, 2.15, 0.1]}
        title="METROLOGY · MEASURE, DON'T TOUCH"
        lines={['CD-SEM · ellipsometer · overlay · AFM']}
        min={1}
        value={() => `${activeHead().label} · ${engine.player.view.phase.label}`}
      />
      {[-2.6, 2.8].map((x) => (
        <group key={x} position={[x, 0, -0.5]}>
          <B s={[1.4, 1.8, 1.2]} m={M.panel} position={[0, 0.9, 0]} />
          <B s={[1.42, 0.05, 1.22]} m={M.greenAccent} position={[0, 1.4, 0]} />
        </group>
      ))}
      <Operator position={[-1.3, 0, 1.6]} rotation={Math.PI * 0.85} still />
    </>
  );
}

