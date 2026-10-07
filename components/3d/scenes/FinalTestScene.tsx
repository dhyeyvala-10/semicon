'use client';
/**
 * Final test & binning (§50, §51): a pick-and-place test handler and the ATE.
 *   test: the packaged chip is picked from the input tray, seated in the socket, soaked to
 *         85 °C, tested electrically and functionally (a shmoo plot builds up), and binned.
 *   bin:  devices stream through the socket into BIN A / B / C / REJECT trays according to
 *         their SIMULATED maximum frequency.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, AssemblyFloor } from '../environments';
import { M } from '../materials';
import { B, C, GEO, Cable } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Screen, clear, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { engine, BINS } from '@/simulation/engine';
import { pp, inPhase } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { clamp, smooth, fract, hash1 } from '@/lib/math';

const TY = 1.02; // tray / socket surface
const PKG = 0.045;
const INPUT = new THREE.Vector3(-0.5, TY, 0.22);
const SOCKET = new THREE.Vector3(0, TY, -0.12);
const BIN_X: Record<string, number> = { A: 0.3, B: 0.48, C: 0.66, REJECT: 0.84 };
const BIN_Z = 0.22;
const BIN_COLOR: Record<string, string> = { A: '#4f9a5a', B: '#8fae62', C: '#c9b46a', REJECT: '#c4483b' };

const slot = (k: number) => {
  const i = k % 4;
  const j = Math.floor(k / 4) % 6;
  return new THREE.Vector3((i - 1.5) * 0.05, 0, (j - 2.5) * 0.05);
};

/* ---------------------------------------------------------------- materials */

const pkgMat = new THREE.MeshStandardMaterial({ color: '#c9cdd0', roughness: 0.3, metalness: 0.9 });
const pkgSub = new THREE.MeshStandardMaterial({ color: '#2e5a43', roughness: 0.5 });
const trayMat = new THREE.MeshStandardMaterial({ color: '#1f2421', roughness: 0.7 });
const heatMat = new THREE.MeshStandardMaterial({ color: '#6b6e70', roughness: 0.4, metalness: 0.7, emissive: new THREE.Color('#ff6a1a'), emissiveIntensity: 0 });

function Package({ position }: { position?: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh geometry={GEO.box} material={pkgSub} scale={[PKG, 0.0015, PKG]} position={[0, 0.00075, 0]} />
      <mesh geometry={GEO.box} material={pkgMat} scale={[PKG * 0.8, 0.0025, PKG * 0.8]} position={[0, 0.0028, 0]} />
    </group>
  );
}

function Tray({ x, z, label, color }: { x: number; z: number; label: string; color: string }) {
  return (
    <group position={[x, TY - 0.006, z]}>
      <mesh geometry={GEO.box} material={trayMat} scale={[0.17, 0.012, 0.3]} />
      <mesh position={[0, 0.0065, -0.16]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.17, 0.02]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      <TechLabel position={[-0.06, 0.05, -0.18]} title={label} min={1} />
    </group>
  );
}

/** Chips in a tray: `count()` visible slots (each slot can stand for several devices). */
function TrayChips({ x, z, count }: { x: number; z: number; count: () => number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const top = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  useFrame(() => {
    const n = Math.min(24, Math.ceil(count()));
    for (let k = 0; k < 24; k++) {
      const p = slot(k);
      const on = k < n;
      o.position.set(x + p.x, TY + 0.0008, z + p.z);
      o.scale.set(on ? PKG : 0, 0.0015, on ? PKG : 0);
      o.updateMatrix();
      ref.current?.setMatrixAt(k, o.matrix);
      o.position.y = TY + 0.0028;
      o.scale.set(on ? PKG * 0.8 : 0, 0.0025, on ? PKG * 0.8 : 0);
      o.updateMatrix();
      top.current?.setMatrixAt(k, o.matrix);
    }
    if (ref.current) ref.current.instanceMatrix.needsUpdate = true;
    if (top.current) top.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <>
      <instancedMesh ref={ref} args={[GEO.box, pkgSub, 24]} />
      <instancedMesh ref={top} args={[GEO.box, pkgMat, 24]} />
    </>
  );
}

/* ---------------------------------------------------------------- the handler */

function binOfFollowed() {
  const d = engine.followedDie;
  return engine.binOf(d.fmax, d.die.id);
}

/** Position of the device being handled (test variant: the followed chip). */
function chipPath(bin: boolean): { p: THREE.Vector3; target: string } {
  const v = engine.player.view;
  if (!bin) {
    const ld = smooth(pp('load'));
    const rs = smooth(pp('result'));
    const p = INPUT.clone().lerp(SOCKET, ld);
    p.y += Math.sin(Math.PI * ld) * 0.1;
    const b = binOfFollowed();
    const dest = new THREE.Vector3(BIN_X[b], TY, BIN_Z).add(slot(5));
    if (rs > 0) {
      p.lerp(dest, rs);
      p.y += Math.sin(Math.PI * rs) * 0.1;
    }
    return { p, target: b };
  }
  // binning: one device cycle per 1/24 of the sort phase
  if (v.phaseId !== 'sort') return { p: SOCKET.clone(), target: 'A' };
  const x = v.phaseT * 24;
  const k = Math.floor(x);
  const u = fract(x);
  const f = 3.3 + 1.3 * hash1(k * 17 + 3);
  const b = f >= BINS.A ? 'A' : f >= BINS.B ? 'B' : f >= BINS.C ? 'C' : 'REJECT';
  const p = new THREE.Vector3();
  const from = INPUT.clone().add(slot(23 - (k % 24)));
  const to = new THREE.Vector3(BIN_X[b], TY, BIN_Z);
  if (u < 0.35) p.copy(from).lerp(SOCKET, smooth(u / 0.35));
  else if (u < 0.6) p.copy(SOCKET);
  else p.copy(SOCKET).lerp(to, smooth((u - 0.6) / 0.4));
  p.y += u < 0.35 ? Math.sin((Math.PI * u) / 0.35) * 0.08 : u > 0.6 ? Math.sin((Math.PI * (u - 0.6)) / 0.4) * 0.08 : 0;
  return { p, target: b };
}

function Handler({ bin }: { bin: boolean }) {
  const chip = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const gantry = useRef<THREE.Group>(null);
  const thermal = useRef<THREE.Group>(null);
  useFrame(() => {
    const { p } = chipPath(bin);
    if (chip.current) chip.current.position.copy(p);
    if (gantry.current) gantry.current.position.x = p.x;
    if (head.current) head.current.position.set(0, p.y + 0.012, p.z);
    track('focus', p.x, p.y, p.z);
    // thermal head presses on the chip during soak + test
    const pressing = !bin ? inPhase('soak') || inPhase('test') : inPhase('sort') && fract(engine.player.view.phaseT * 24) > 0.35 && fract(engine.player.view.phaseT * 24) < 0.6;
    if (thermal.current) thermal.current.position.y = pressing ? TY + 0.012 : TY + 0.1;
    const T = !bin ? engine.tele.value('socket', 25) : 85;
    heatMat.emissiveIntensity = clamp((T - 40) / 60) * 0.25;
  });
  const inputCount = () => (bin ? 24 - (inPhase('sort') ? engine.player.view.phaseT * 24 : pp('sort') * 24) : 23 + (pp('load') > 0 ? 0 : 1));
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'test-handler', label: 'Test handler' }}>
        <B s={[2.0, 1.0, 1.2]} m={M.panel} position={[0.15, 0.5, 0]} />
        <B s={[2.02, 0.05, 1.22]} m={M.greenAccent} position={[0.15, 0.98, 0]} />
        <mesh position={[0.15, 1.35, -0.6]} material={M.glass}>
          <boxGeometry args={[2.0, 0.7, 0.02]} />
        </mesh>
        <SignalTower position={[1.05, 1.05, 0.5]} />
      </Clickable>
      {/* trays */}
      <Clickable sel={{ kind: 'component', id: 'pnp', machine: 'test-handler', label: 'Input tray (JEDEC)' }}>
        <Tray x={INPUT.x} z={INPUT.z} label="INPUT" color="#8a8f86" />
      </Clickable>
      <TrayChips x={INPUT.x} z={INPUT.z} count={inputCount} />
      <Clickable sel={{ kind: 'component', id: 'bins', machine: 'test-handler', label: 'Output bins' }}>
        {Object.entries(BIN_X).map(([b, x]) => (
          <Tray key={b} x={x} z={BIN_Z} label={`BIN ${b}`} color={BIN_COLOR[b]} />
        ))}
      </Clickable>
      {(['A', 'B', 'C', 'REJECT'] as const).map((b) => (
        <TrayChips
          key={b}
          x={BIN_X[b]}
          z={BIN_Z}
          count={() => {
            if (!bin) return pp('result') >= 0.99 && binOfFollowed() === b ? 6 : b === 'A' ? 4 : b === 'B' ? 5 : b === 'C' ? 2 : 1;
            const n = engine.tele.value(b === 'REJECT' ? 'rej' : `bin${b}`, 0);
            return n / 5;
          }}
        />
      ))}
      {/* socket + thermal head */}
      <Clickable sel={{ kind: 'component', id: 'sockets', machine: 'test-handler', label: 'Test socket' }}>
        <B s={[0.09, 0.02, 0.09]} m={M.panelDark} position={[SOCKET.x, TY - 0.01, SOCKET.z]} />
      </Clickable>
      <group ref={thermal} position={[SOCKET.x, TY + 0.1, SOCKET.z]}>
        <Clickable sel={{ kind: 'component', id: 'thermal', machine: 'test-handler', label: 'Thermal head' }}>
          <mesh geometry={GEO.box} material={heatMat} scale={[0.06, 0.02, 0.06]} position={[0, 0.01, 0]} />
          <C r={0.015} h={0.2} m={M.steel} position={[0, 0.12, 0]} />
        </Clickable>
      </group>
      {/* pick-and-place gantry */}
      <group ref={gantry}>
        <B s={[0.06, 0.06, 1.0]} m={M.frame} position={[0, 1.45, 0]} />
        <group ref={head}>
          <Clickable sel={{ kind: 'component', id: 'pnp', machine: 'test-handler', label: 'Pick-and-place head' }}>
            <C r={0.012} h={0.4} m={M.steel} position={[0, 0.2, 0]} />
            <C r={0.018} h={0.01} m={M.rubber} position={[0, 0.005, 0]} />
          </Clickable>
        </group>
      </group>
      <B s={[2.0, 0.06, 0.06]} m={M.frame} position={[0.15, 1.5, -0.45]} />
      <B s={[2.0, 0.06, 0.06]} m={M.frame} position={[0.15, 1.5, 0.45]} />
      <group ref={chip}>
        <Clickable sel={{ kind: 'component', id: 'pkg-die', label: 'Packaged chip CH-184-0412' }}>
          <Package />
        </Clickable>
      </group>
      {/* ATE */}
      <Clickable sel={{ kind: 'component', id: 'ate', machine: 'test-handler', label: 'Automatic test equipment' }}>
        <B s={[0.8, 1.9, 0.9]} m={M.panelDark} position={[-1.35, 0.95, -0.2]} />
        {[0.5, 0.85, 1.2, 1.55].map((y) => (
          <B key={y} s={[0.82, 0.02, 0.6]} m={M.panelGrey} position={[-1.35, y, 0.16]} />
        ))}
        <Cable a={[-0.95, 1.2, -0.1]} b={[-0.2, 0.8, -0.15]} sag={0.3} radius={0.03} m={M.black} />
      </Clickable>
    </group>
  );
}

/* ---------------------------------------------------------------- tester screen */

function TesterScreen({ bin }: { bin: boolean }) {
  const f0 = 2.0;
  const f1 = 5.0;
  const v0 = 0.7;
  const v1 = 1.2;
  return (
    <group position={[0.15, 0, -0.5]}>
      <Screen
        size={[0.9, 0.5]}
        position={[0, 1.78, 0]}
        hz={6}
        res={768}
        draw={(g, w, h) => {
          if (bin) {
            clear(g, w, h, 'BINNING · SIMULATED SPEED BINS');
            const rows: [string, string, string][] = [
              ['A', 'binA', `≥ ${BINS.A} GHz`],
              ['B', 'binB', `≥ ${BINS.B} GHz`],
              ['C', 'binC', `≥ ${BINS.C} GHz`],
              ['REJECT', 'rej', 'fail / slow'],
            ];
            const counts = rows.map(([, ch]) => engine.tele.value(ch, 0));
            const max = Math.max(10, ...counts);
            rows.forEach(([b, , note], i) => {
              const y = h * (0.22 + i * 0.17);
              g.fillStyle = SCR.dim;
              g.font = `${Math.round(h * 0.06)}px monospace`;
              g.fillText(`BIN ${b}`, w * 0.04, y + h * 0.07);
              g.fillStyle = BIN_COLOR[b];
              g.fillRect(w * 0.25, y, (w * 0.5 * counts[i]) / max, h * 0.1);
              g.fillStyle = SCR.text;
              g.fillText(`${counts[i].toFixed(0)}  ${note}`, w * 0.27 + (w * 0.5 * counts[i]) / max, y + h * 0.07);
            });
            return;
          }
          clear(g, w, h, 'ATE · SHMOO (VDD × FREQUENCY) · SIMULATED');
          const fmax = engine.followedDie.fmax;
          const k = inPhase('test') ? engine.player.view.phaseT : pp('test');
          const nx = 24;
          const ny = 12;
          const x0 = w * 0.08;
          const y0 = h * 0.2;
          const cw = (w * 0.56) / nx;
          const ch = (h * 0.66) / ny;
          const done = Math.floor(k * nx * ny);
          for (let j = 0; j < ny; j++)
            for (let i = 0; i < nx; i++) {
              const idx = j * nx + i;
              if (idx >= done) continue;
              const f = f0 + ((i + 0.5) / nx) * (f1 - f0);
              const vv = v1 - ((j + 0.5) / ny) * (v1 - v0);
              const limit = fmax * (0.72 + 0.28 * ((vv - v0) / (v1 - v0)) ** 0.7);
              g.fillStyle = f <= limit ? '#4f9a5a' : '#5a2a26';
              g.fillRect(x0 + i * cw, y0 + j * ch, cw - 1, ch - 1);
            }
          g.fillStyle = SCR.dim;
          g.font = `${Math.round(h * 0.045)}px monospace`;
          g.fillText(`${f0} GHz`, x0, y0 + ny * ch + h * 0.06);
          g.fillText(`${f1} GHz`, x0 + nx * cw - h * 0.12, y0 + ny * ch + h * 0.06);
          g.fillText(`${v1} V`, w * 0.01, y0 + h * 0.03);
          g.fillText(`${v0} V`, w * 0.01, y0 + ny * ch);
          bigNumber(g, 'FMAX', engine.tele.value('fmax', 0).toFixed(2), 'GHz', w * 0.68, h * 0.28, h * 0.1);
          bigNumber(g, 'POWER', engine.tele.value('power', 0).toFixed(0), 'W', w * 0.68, h * 0.5, h * 0.1);
          const res = pp('result') > 0 ? `BIN ${binOfFollowed()}` : '…';
          bigNumber(g, 'RESULT', res, '', w * 0.68, h * 0.72, h * 0.1, pp('result') > 0 ? SCR.good : SCR.text);
        }}
      />
      <B s={[0.94, 0.54, 0.03]} m={M.black} position={[0, 1.78, -0.02]} />
      <C r={0.025} h={0.8} m={M.steelDark} position={[0, 1.15, -0.03]} />
    </group>
  );
}

export default function FinalTestScene({ stage }: SceneProps) {
  const bin = stage.variant === 'bin';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.3;
  }, []);
  return (
    <>
      <Lighting env="assembly" shadowExtent={5} />
      <AssemblyFloor width={12} depth={9} />
      <Handler bin={bin} />
      <TesterScreen bin={bin} />
      <SensorIndicator id="thermocouple" channel={bin ? undefined : 'socket'} machine="test-handler" position={[0.08, TY + 0.12, -0.12]} size={0.02} />
      <TechLabel
        position={[-0.8, 1.6, 0.4]}
        title={bin ? 'BINNING' : 'FINAL TEST'}
        lines={[bin ? 'speed bins from simulated test results' : 'pick → socket → soak 85 °C → test → bin']}
        min={1}
        value={() => engine.player.view.phase.label}
      />
      <Operator position={[-0.9, 0, 1.6]} rotation={Math.PI * 0.85} still />
    </>
  );
}

