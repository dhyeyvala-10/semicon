'use client';
/**
 * Dicing & die selection (§44, §45).
 *   saw:  the wafer, mounted on tape in a steel frame, is cut along every scribe street by a
 *         thin diamond blade (coolant on), rotated 90°, cut again, cleaned.
 *   pick: the tape is expanded, the ejector pushes the chosen good die up, the vacuum collet
 *         picks it, a vision check inspects it, and it moves on to packaging. Dies marked
 *         bad in the sort map stay on the tape.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, AssemblyFloor } from '../environments';
import { M } from '../materials';
import { B, C, GEO } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Inset } from '../parts/section';
import { waferGeometry } from '../parts/wafer';
import { Screen, clear, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { drawWafer, dieFloorplan } from '../textures';
import { engine } from '@/simulation/engine';
import { pp, inPhase, pdt } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { smooth, lerp, fract, rng } from '@/lib/math';
import { DIE_W, DIE_H, WAFER_D } from '@/simulation/models';

const WY = 1.0;
const VISION = new THREE.Vector3(2.45, 1.05, 0);
const SUBSTRATE = new THREE.Vector3(3.3, 0.98, 0);

/* streets (wafer-local mm): rows for the first channel, columns for the second */
const NX = Math.round(WAFER_D / DIE_W) + 1;
const NY = Math.round(WAFER_D / DIE_H) + 1;
const OX = -((Math.floor(WAFER_D / DIE_W) - 1) / 2) * DIE_W - DIE_W / 2;
const OY = -((Math.floor(WAFER_D / DIE_H) - 1) / 2) * DIE_H - DIE_H / 2;
const rowStreet = (j: number) => OY + j * DIE_H;
const colStreet = (i: number) => OX + i * DIE_W;

/* ---------------------------------------------------------------- saw */

function useCutTexture() {
  return useMemo(() => {
    const S = 512;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const base = document.createElement('canvas');
    base.width = base.height = S;
    drawWafer(base.getContext('2d')!, S, 'dies');
    const s = S / WAFER_D;
    let last = -1;
    const update = (cuts: number) => {
      if (cuts === last) return;
      last = cuts;
      g.drawImage(base, 0, 0);
      g.strokeStyle = '#141814';
      g.lineWidth = Math.max(1.5, s * 0.8);
      for (let k = 0; k < cuts; k++) {
        g.beginPath();
        if (k < NY) {
          const y = S / 2 + rowStreet(k) * s;
          g.moveTo(0, y);
          g.lineTo(S, y);
        } else {
          const x = S / 2 + colStreet(k - NY) * s;
          g.moveTo(x, 0);
          g.lineTo(x, S);
        }
        g.stroke();
      }
      tex.needsUpdate = true;
    };
    update(0);
    return { tex, update };
  }, []);
}

const coolMat = new THREE.MeshStandardMaterial({ color: '#d7e6dc', transparent: true, opacity: 0.45, roughness: 0.05, depthWrite: false });
const tapeMat = new THREE.MeshStandardMaterial({ color: '#9fb8a8', transparent: true, opacity: 0.55, roughness: 0.3, depthWrite: false });

function Saw() {
  const table = useRef<THREE.Group>(null);
  const spindle = useRef<THREE.Group>(null);
  const blade = useRef<THREE.Mesh>(null);
  const spray = useRef<THREE.InstancedMesh>(null);
  const cut = useCutTexture();
  const top = useMemo(() => new THREE.MeshStandardMaterial({ map: cut.tex, roughness: 0.2, metalness: 0.4 }), [cut]);
  const waferMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.1, metalness: 0.9 }), []);
  const seeds = useMemo(() => {
    const r = rng(4);
    return Array.from({ length: 40 }, () => ({ a: r() * Math.PI, s: 0.5 + r(), o: r() }));
  }, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const t = useRef(0);
  useFrame((_, dt) => {
    const v = engine.player.view;
    t.current += pdt(dt);
    const cuts = engine.tele.value('cuts', 0);
    cut.update(Math.floor(cuts));
    const mount = smooth(pp('mount'));
    const rot = smooth(pp('rotate'));
    if (table.current) {
      table.current.position.y = lerp(0.25, 0, mount);
      table.current.rotation.y = (Math.PI / 2) * rot;
    }
    track('focus', 0, WY, 0);
    // blade: one pass along x per street; street position along z (table frame)
    const cutting = v.phaseId === 'cut-x' || v.phaseId === 'cut-y';
    let bx = 0.32;
    let bz = 0;
    let by = WY + 0.08;
    if (cutting) {
      const n = v.phaseId === 'cut-x' ? NY : NX;
      const x = v.phaseT * n;
      const k = Math.min(n - 1, Math.floor(x));
      const u = fract(x);
      const street = v.phaseId === 'cut-x' ? rowStreet(k) : -colStreet(k);
      bz = street / 1000;
      bx = lerp(-0.2, 0.2, u);
      by = WY + 0.012;
    }
    if (spindle.current) spindle.current.position.set(bx, by, bz);
    if (blade.current) blade.current.rotation.z -= pdt(dt) * 60;
    if (spray.current) {
      seeds.forEach((s, i) => {
        const u = (t.current * 2 * s.s + s.o) % 1;
        o.position.set(bx + Math.cos(s.a) * u * 0.05, by + 0.01 + Math.sin(s.a) * u * 0.04, bz + (s.o - 0.5) * 0.02);
        o.scale.setScalar(cutting || inPhase('clean') ? 0.003 * (1 - u) : 0);
        o.updateMatrix();
        spray.current!.setMatrixAt(i, o.matrix);
      });
      spray.current.instanceMatrix.needsUpdate = true;
    }
  });
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'dicing-saw', label: 'Dicing saw' }}>
        <B s={[1.4, 0.9, 1.2]} m={M.panel} position={[0, 0.45, 0]} />
        <B s={[1.42, 0.05, 1.22]} m={M.greenAccent} position={[0, 0.88, 0]} />
        <mesh position={[0, 1.35, -0.55]} material={M.glass}>
          <boxGeometry args={[1.3, 0.9, 0.02]} />
        </mesh>
        <SignalTower position={[0.62, 0.95, 0.5]} />
      </Clickable>
      <group ref={table}>
        <Clickable sel={{ kind: 'component', id: 'table', machine: 'dicing-saw', label: 'Cutting table' }}>
          <C r={0.21} h={0.08} m={M.alu} position={[0, WY - 0.045, 0]} />
        </Clickable>
        {/* frame + tape + wafer */}
        <mesh position={[0, WY - 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]} material={M.steel}>
          <ringGeometry args={[0.19, 0.23, 64]} />
        </mesh>
        <mesh position={[0, WY - 0.003, 0]} rotation={[-Math.PI / 2, 0, 0]} material={tapeMat}>
          <circleGeometry args={[0.2, 64]} />
        </mesh>
        <group position={[0, WY, 0]}>
          <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184' }}>
            <mesh geometry={waferGeometry()} material={waferMat} castShadow />
            <mesh position={[0, 0.0005, 0]} rotation={[-Math.PI / 2, 0, 0]} material={top}>
              <circleGeometry args={[0.149, 64]} />
            </mesh>
          </Clickable>
        </group>
      </group>
      {/* spindle + blade */}
      <group ref={spindle}>
        <Clickable sel={{ kind: 'component', id: 'spindle', machine: 'dicing-saw', label: 'Air-bearing spindle' }}>
          <mesh position={[0, 0.03, -0.08]} rotation={[Math.PI / 2, 0, 0]} material={M.steel}>
            <cylinderGeometry args={[0.035, 0.035, 0.14, 24]} />
          </mesh>
          <B s={[0.08, 0.3, 0.08]} m={M.panelGrey} position={[0, 0.2, -0.13]} />
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'blade', machine: 'dicing-saw', label: 'Diamond blade' }}>
          <mesh ref={blade} position={[0, 0.03, 0]} rotation={[Math.PI / 2, 0, 0]} material={M.steelDark}>
            <cylinderGeometry args={[0.028, 0.028, 0.0008, 40]} />
          </mesh>
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'coolant', machine: 'dicing-saw', label: 'Coolant nozzles' }}>
          <B s={[0.01, 0.01, 0.06]} m={M.steel} position={[0.035, 0.03, 0.02]} />
        </Clickable>
      </group>
      <instancedMesh ref={spray} args={[GEO.sphereLow, coolMat, 40]} frustumCulled={false} />
      <Clickable sel={{ kind: 'component', id: 'camera', machine: 'dicing-saw', label: 'Alignment camera' }}>
        <C r={0.02} h={0.12} m={M.black} position={[-0.3, WY + 0.2, 0.15]} />
      </Clickable>
    </group>
  );
}

/* ---------------------------------------------------------------- pick */

const dieTopMat = new THREE.MeshStandardMaterial({ map: null, roughness: 0.35, metalness: 0.35 });
const badMark = new THREE.MeshBasicMaterial({ color: '#c4483b', toneMapped: false });

function Pick() {
  const dies = engine.waferMap;
  const followed = engine.followedDie;
  const inst = useRef<THREE.InstancedMesh>(null);
  const marks = useRef<THREE.InstancedMesh>(null);
  const die = useRef<THREE.Group>(null);
  const collet = useRef<THREE.Group>(null);
  const needle = useRef<THREE.Mesh>(null);
  useEffect(() => {
    dieTopMat.map = dieFloorplan('cpu');
    dieTopMat.needsUpdate = true;
  }, []);
  // already-picked good dies are gone; failing dies stay (marked)
  const remaining = useMemo(() => {
    const pass = dies.filter((d) => d.result === 'PASS' && d !== followed);
    const gone = new Set(pass.slice(0, Math.max(0, pass.length - 14)).map((d) => d.die.id));
    return dies.filter((d) => !gone.has(d.die.id) && d !== followed);
  }, [dies, followed]);
  const bad = useMemo(() => remaining.filter((d) => d.result !== 'PASS'), [remaining]);
  const o = useMemo(() => new THREE.Object3D(), []);
  const fpos = useRef(new THREE.Vector3());
  useFrame(() => {
    const ex = 1 + 0.06 * smooth(pp('expand'));
    if (inst.current) {
      remaining.forEach((d, i) => {
        o.position.set((d.die.cx / 1000) * ex, WY + 0.0004, (d.die.cy / 1000) * ex);
        o.scale.set((DIE_W / 1000) * 0.96, 0.0008, (DIE_H / 1000) * 0.96);
        o.updateMatrix();
        inst.current!.setMatrixAt(i, o.matrix);
      });
      inst.current.instanceMatrix.needsUpdate = true;
    }
    if (marks.current) {
      bad.forEach((d, i) => {
        o.position.set((d.die.cx / 1000) * ex, WY + 0.0012, (d.die.cy / 1000) * ex);
        o.scale.set(0.002, 0.0004, 0.002);
        o.updateMatrix();
        marks.current!.setMatrixAt(i, o.matrix);
      });
      marks.current.instanceMatrix.needsUpdate = true;
    }
    // followed die: eject → pick → vision → transfer
    const home = new THREE.Vector3((followed.die.cx / 1000) * ex, WY + 0.0004, (followed.die.cy / 1000) * ex);
    const ej = smooth(pp('eject'));
    const pk = smooth(pp('pick'));
    const vi = smooth(pp('inspect'));
    const tr = smooth(pp('transfer'));
    const p = home.clone();
    p.y += 0.004 * ej + 0.12 * pk;
    if (vi > 0) p.lerp(VISION.clone().add(new THREE.Vector3(0, 0.02, 0)), vi);
    if (tr > 0) p.lerp(SUBSTRATE.clone().add(new THREE.Vector3(0, 0.02, 0)), tr);
    fpos.current.copy(p);
    if (die.current) die.current.position.copy(p);
    if (collet.current) {
      const cy = pk > 0 ? p.y + 0.012 : WY + 0.12 - 0.11 * ej;
      collet.current.position.set(p.x, cy, p.z);
    }
    if (needle.current) {
      needle.current.position.set(home.x, WY - 0.03 + 0.03 * ej * (1 - pk), home.z);
      needle.current.visible = ej > 0 && pk < 1;
    }
    track('focus', p.x, p.y, p.z);
  });
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'die-bonder', label: 'Die sorter / bonder' }}>
        <B s={[1.4, 0.9, 1.2]} m={M.panel} position={[0, 0.45, 0]} />
        <B s={[1.42, 0.05, 1.22]} m={M.greenAccent} position={[0, 0.88, 0]} />
        <B s={[2.4, 0.9, 0.9]} m={M.panelWarm} position={[2.4, 0.45, 0]} />
        {/* gantry for the pick head */}
        <B s={[3.6, 0.08, 0.1]} m={M.frame} position={[1.6, 1.55, -0.35]} />
        {[-0.1, 3.3].map((x) => (
          <B key={x} s={[0.08, 0.7, 0.08]} m={M.frame} position={[x, 1.2, -0.35]} />
        ))}
        <SignalTower position={[0.62, 0.95, 0.5]} />
      </Clickable>
      {/* expanded tape + frame */}
      <mesh position={[0, WY - 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]} material={M.steel}>
        <ringGeometry args={[0.19, 0.23, 64]} />
      </mesh>
      <mesh position={[0, WY - 0.003, 0]} rotation={[-Math.PI / 2, 0, 0]} material={tapeMat}>
        <circleGeometry args={[0.2, 64]} />
      </mesh>
      <instancedMesh ref={inst} args={[GEO.box, dieTopMat, remaining.length]} castShadow />
      <instancedMesh ref={marks} args={[GEO.cylLow, badMark, bad.length]} />
      <Clickable sel={{ kind: 'component', id: 'ejector', machine: 'die-bonder', label: 'Ejector needles' }}>
        <mesh ref={needle} material={M.steel}>
          <cylinderGeometry args={[0.0008, 0.0003, 0.06, 6]} />
        </mesh>
      </Clickable>
      <group ref={die}>
        <Clickable sel={{ kind: 'die', id: String(followed.die.id), label: 'Followed die' }}>
          <mesh geometry={GEO.box} material={dieTopMat} scale={[DIE_W / 1000, 0.0008, DIE_H / 1000]} castShadow />
        </Clickable>
      </group>
      <group ref={collet}>
        <Clickable sel={{ kind: 'component', id: 'collet', machine: 'die-bonder', label: 'Vacuum collet' }}>
          <C r={0.006} h={0.02} m={M.rubber} position={[0, 0.01, 0]} />
          <C r={0.012} h={0.2} m={M.steel} position={[0, 0.12, 0]} />
        </Clickable>
      </group>
      {/* vision station + substrate strip */}
      <Clickable sel={{ kind: 'component', id: 'vision', machine: 'die-bonder', label: 'Vision system' }}>
        <C r={0.03} h={0.12} m={M.black} position={[VISION.x, VISION.y + 0.18, VISION.z]} />
        <C r={0.05} h={0.02} m={M.lightPanel} position={[VISION.x, VISION.y + 0.11, VISION.z]} />
        <B s={[0.1, 0.05, 0.1]} m={M.panelGrey} position={[VISION.x, VISION.y - 0.03, VISION.z]} />
      </Clickable>
      <B s={[0.5, 0.008, 0.12]} m={M.pcb} position={[SUBSTRATE.x, SUBSTRATE.y, SUBSTRATE.z]} />
    </group>
  );
}

function VisionInset() {
  return (
    <Inset id="vision" position={[2.45, 1.45, 0.25]} size={[0.8, 0.55]} mpu={0.02 / 0.8} title="VISION CHECK · DIE CAMERA">
      <Screen
        size={[0.76, 0.5]}
        position={[0, 0, 0]}
        hz={6}
        frame={false}
        res={512}
        draw={(g, w, h) => {
          clear(g, w, h, 'DIE IMAGE · SIMULATED');
          const img = (dieFloorplan('cpu') as THREE.CanvasTexture).image as HTMLCanvasElement;
          const dw = h * 0.62 * (DIE_W / DIE_H);
          const dh = h * 0.62;
          const x0 = w * 0.08;
          const y0 = h * 0.2;
          g.drawImage(img, x0, y0, dw, dh);
          g.strokeStyle = SCR.accent;
          g.lineWidth = 2;
          g.strokeRect(x0, y0, dw, dh);
          g.beginPath();
          g.moveTo(x0 + dw / 2, y0 - 8);
          g.lineTo(x0 + dw / 2, y0 + dh + 8);
          g.moveTo(x0 - 8, y0 + dh / 2);
          g.lineTo(x0 + dw + 8, y0 + dh / 2);
          g.stroke();
          const ok = pp('inspect') > 0.4;
          bigNumber(g, 'EDGE CHIPPING', ok ? 'NONE' : '…', '', w * 0.55, h * 0.26, h * 0.08, ok ? SCR.good : SCR.text);
          bigNumber(g, 'POSITION', ok ? '±2 µm' : '…', '', w * 0.55, h * 0.48, h * 0.08);
          bigNumber(g, 'DIE', `#${engine.followedDie.die.id}`, 'PASS', w * 0.55, h * 0.7, h * 0.08, SCR.good);
        }}
      />
    </Inset>
  );
}

function SawScreen() {
  return (
    <group position={[1.15, 0, -0.5]} rotation={[0, -0.6, 0]}>
      <C r={0.025} h={1.3} m={M.steelDark} position={[0, 0.65, 0]} />
      <Screen
        size={[0.6, 0.38]}
        position={[0, 1.5, 0.03]}
        hz={5}
        draw={(g, w, h) => {
          clear(g, w, h, 'DICING · SIMULATED');
          bigNumber(g, 'STREETS', engine.tele.value('cuts', 0).toFixed(0), `/ ${NX + NY}`, w * 0.05, h * 0.24, h * 0.11);
          bigNumber(g, 'SPINDLE', engine.tele.value('spindle', 0).toFixed(1), 'krpm', w * 0.5, h * 0.24, h * 0.11);
          bigNumber(g, 'BLADE LOAD', engine.tele.value('load', 0).toFixed(2), 'A', w * 0.05, h * 0.6, h * 0.11);
        }}
      />
    </group>
  );
}

export default function DicingScene({ stage }: SceneProps) {
  const pick = stage.variant === 'pick';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.3;
  }, []);
  return (
    <>
      <Lighting env="assembly" shadowExtent={6} />
      <AssemblyFloor width={12} depth={9} />
      {pick ? <Pick /> : <Saw />}
      {pick ? <VisionInset /> : <SawScreen />}
      {!pick && <SensorIndicator id="joint-encoder" channel="spindle" machine="dicing-saw" position={[0.2, 1.25, -0.45]} size={0.035} />}
      {pick && <SensorIndicator id="vacuum-switch" channel="vac" machine="die-bonder" position={[0.2, 1.3, -0.3]} size={0.035} />}
      <TechLabel
        position={[-0.75, 1.7, 0.3]}
        title={pick ? 'DIE PICK · ONLY GOOD DIES' : 'DICING · DIAMOND BLADE'}
        lines={[pick ? 'red dots: rejected in wafer sort — they stay on the tape' : 'cuts along every scribe street, then rotates 90°']}
        min={1}
        value={() => engine.player.view.phase.label}
      />
      <Operator position={[-1.0, 0, 1.5]} rotation={Math.PI * 0.85} still />
    </>
  );
}

