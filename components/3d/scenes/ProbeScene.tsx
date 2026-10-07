'use client';
/**
 * Electrical wafer test & sort (§42, §43).
 *   test: the prober steps the wafer die by die under the probe card; needles touch the pads,
 *         the tester applies power and patterns, and the die is marked pass / fail / review.
 *   sort: the wafer map is classified — accepted dies rise, rejected dies drop — and the
 *         wafer yield is summarised. Results are SIMULATED (engine wafer map).
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, AssemblyFloor } from '../environments';
import { M } from '../materials';
import { B, C, Cable } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Inset } from '../parts/section';
import { waferGeometry } from '../parts/wafer';
import { Screen, clear, bigNumber, plot, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { drawWafer } from '../textures';
import { engine } from '@/simulation/engine';
import { pp, inPhase } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { clamp, smooth, lerp, fract } from '@/lib/math';
import { DIE_W, DIE_H, WAFER_D } from '@/simulation/models';

const WY = 1.0;
const RESULT_COLOR = { PASS: '#4f9a5a', FAIL: '#c4483b', REVIEW: '#d1a23a' } as const;

/** die index under the probe card and progress within that die (0..1) */
function probeState() {
  const v = engine.player.view;
  const n = engine.waferMap.length;
  if (v.phaseId !== 'test') return { i: v.phaseId === 'report' ? n - 1 : 0, u: 0, tested: v.phaseId === 'report' ? n : 0 };
  const x = v.phaseT * n;
  return { i: Math.min(n - 1, Math.floor(x)), u: fract(x), tested: Math.floor(x) };
}

/* ---------------------------------------------------------------- wafer + map texture */

function useMapTexture(sort: boolean) {
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
    let last = -1;
    const s = S / WAFER_D;
    const update = (tested: number) => {
      const k = sort ? engine.waferMap.length : tested;
      if (k === last) return;
      last = k;
      g.drawImage(base, 0, 0);
      for (let i = 0; i < k; i++) {
        const d = engine.waferMap[i];
        g.fillStyle = RESULT_COLOR[d.result];
        g.globalAlpha = 0.75;
        g.fillRect(S / 2 + (d.die.cx - DIE_W / 2) * s + 1.5, S / 2 + (d.die.cy - DIE_H / 2) * s + 1.5, DIE_W * s - 3, DIE_H * s - 3);
        g.globalAlpha = 1;
      }
      tex.needsUpdate = true;
    };
    update(0);
    return { tex, update };
  }, [sort]);
}

/* ---------------------------------------------------------------- prober */

const needleMat = new THREE.MeshStandardMaterial({ color: '#d6c27a', roughness: 0.3, metalness: 1 });

function Prober({ sort }: { sort: boolean }) {
  const wafer = useRef<THREE.Group>(null);
  const chuck = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const map = useMapTexture(sort);
  const top = useMemo(() => new THREE.MeshStandardMaterial({ map: map.tex, roughness: 0.2, metalness: 0.4 }), [map]);
  const waferMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.1, metalness: 0.9, transparent: true }), []);
  const needles = useMemo(() => {
    const out: { a: number; r: number }[] = [];
    for (let i = 0; i < 28; i++) out.push({ a: (i / 28) * Math.PI * 2, r: 0.006 + (i % 2) * 0.001 });
    return out;
  }, []);
  useFrame(() => {
    const st = probeState();
    map.update(st.tested);
    const dies = engine.waferMap;
    const cur = dies[st.i].die;
    const nxt = dies[Math.min(dies.length - 1, st.i + 1)].die;
    // move to the next die during the last 40 % of each die period; touchdown in between
    const mv = smooth(clamp((st.u - 0.6) / 0.4));
    const x = -lerp(cur.cx, nxt.cx, mv) / 1000;
    const z = -lerp(cur.cy, nxt.cy, mv) / 1000;
    const contact = inPhase('test') && st.u > 0.1 && st.u < 0.6;
    const loadP = sort ? 1 : smooth(pp('load'));
    const wx = inPhase('test') || pp('test') >= 1 ? x : lerp(0.6, 0, loadP);
    const wz = inPhase('test') || pp('test') >= 1 ? z : 0;
    const wy = WY - (contact ? 0 : 0.012);
    if (wafer.current) wafer.current.position.set(wx, wy, wz);
    if (chuck.current) chuck.current.position.set(wx, wy - 0.035, wz);
    track('focus', 0, WY, 0);
    if (head.current) {
      // for sorting the test head is swung open out of the way
      head.current.position.set(sort ? -0.75 : 0, sort ? 0.25 : 0, sort ? -0.55 : 0);
      head.current.rotation.z = sort ? 0.5 : 0;
    }
    waferMat.opacity = sort ? 1 - smooth(clamp(pp('separate') * 2)) * 0.85 : 1;
    top.opacity = waferMat.opacity;
    top.transparent = sort;
  });
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'prober', label: 'Wafer prober' }}>
        <B s={[1.3, 0.92, 1.2]} m={M.panel} position={[0, 0.46, 0]} />
        <B s={[1.32, 0.05, 1.22]} m={M.greenAccent} position={[0, 0.9, 0]} />
        <SignalTower position={[0.55, 0.95, 0.5]} />
      </Clickable>
      <group ref={chuck}>
        <Clickable sel={{ kind: 'component', id: 'chuck', machine: 'prober', label: 'Thermal chuck' }}>
          <C r={0.165} h={0.06} m={M.alu} />
        </Clickable>
      </group>
      <group ref={wafer}>
        <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184' }}>
          <mesh geometry={waferGeometry()} material={waferMat} castShadow />
          <mesh position={[0, 0.0005, 0]} rotation={[-Math.PI / 2, 0, 0]} material={top}>
            <circleGeometry args={[0.149, 64]} />
          </mesh>
        </Clickable>
      </group>
      {/* test head + probe card */}
      <group ref={head}>
        <Clickable sel={{ kind: 'component', id: 'probe-card', machine: 'prober', label: 'Probe card' }}>
          <mesh position={[0, WY + 0.045, 0]} material={M.pcb}>
            <cylinderGeometry args={[0.2, 0.2, 0.012, 48, 1, false]} />
          </mesh>
          <C r={0.03} h={0.02} m={M.ceramic} position={[0, WY + 0.032, 0]} />
          {needles.map((n, i) => (
            <mesh key={i} position={[Math.cos(n.a) * 0.016, WY + 0.018, Math.sin(n.a) * 0.016]} rotation={[Math.sin(n.a) * 0.9, 0, -Math.cos(n.a) * 0.9]} material={needleMat}>
              <cylinderGeometry args={[0.0006, 0.0003, 0.03, 4]} />
            </mesh>
          ))}
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'tester', machine: 'prober', label: 'Test head' }}>
          <B s={[0.9, 0.32, 0.8]} m={M.panelDark} position={[0, WY + 0.22, 0]} />
          <B s={[0.92, 0.04, 0.82]} m={M.orangeAccent} position={[0, WY + 0.06, 0]} />
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'camera', machine: 'prober', label: 'Alignment cameras' }}>
          <C r={0.025} h={0.08} m={M.black} position={[0.3, WY + 0.06, 0.25]} />
        </Clickable>
      </group>
      {/* ATE mainframe + cable */}
      <Clickable sel={{ kind: 'component', id: 'tester', machine: 'prober', label: 'ATE mainframe' }}>
        <B s={[0.8, 1.9, 0.9]} m={M.panelDark} position={[-1.4, 0.95, -0.2]} />
        {[0.5, 0.8, 1.1, 1.4].map((y) => (
          <B key={y} s={[0.82, 0.02, 0.6]} m={M.panelGrey} position={[-1.4, y, 0.16]} />
        ))}
        <Cable a={[-1.0, 1.4, 0]} b={[-0.45, WY + 0.25, 0]} sag={0.25} radius={0.035} m={M.black} />
      </Clickable>
    </group>
  );
}

/* ---------------------------------------------------------------- sort: dies rise / drop */

const tmpColor = new THREE.Color();
function SortDies() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const dies = engine.waferMap;
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.3 }), []);
  const o = useMemo(() => new THREE.Object3D(), []);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    dies.forEach((d, i) => m.setColorAt(i, tmpColor.set(RESULT_COLOR[d.result])));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [dies]);
  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    const k = pp('separate');
    m.visible = k > 0;
    dies.forEach((d, i) => {
      const stagger = clamp(k * 1.6 - (i / dies.length) * 0.6);
      const e = smooth(stagger);
      const dy = d.result === 'PASS' ? 0.09 * e : d.result === 'FAIL' ? -0.07 * e : 0.03 * e;
      o.position.set(d.die.cx / 1000, WY + 0.002 + dy, d.die.cy / 1000);
      o.scale.set((DIE_W / 1000) * 0.92, 0.0012, (DIE_H / 1000) * 0.92);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.instanceId === undefined) return;
    const d = dies[e.instanceId];
    useUI.getState().select({ kind: 'die', id: String(d.die.id), label: `Die (${d.die.col}, ${d.die.row})` });
  };
  return (
    <instancedMesh ref={ref} args={[undefined, mat, dies.length]} onClick={onClick} castShadow>
      <boxGeometry />
    </instancedMesh>
  );
}

/* ---------------------------------------------------------------- probe contact inset */

const padMat = new THREE.MeshStandardMaterial({ color: '#d9b45a', roughness: 0.3, metalness: 1 });
const dieMat = new THREE.MeshStandardMaterial({ color: '#2d3a32', roughness: 0.45, metalness: 0.3 });

function ContactInset() {
  const tips = useRef<THREE.Group>(null);
  const led = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(() => {
    const st = probeState();
    const contact = inPhase('test') && st.u > 0.1 && st.u < 0.6;
    if (tips.current) tips.current.position.y = contact ? 0 : 0.06;
    if (led.current) {
      const r = engine.waferMap[st.i].result;
      led.current.color.set(contact ? RESULT_COLOR[r] : '#3a4a3c');
    }
  });
  return (
    <Inset id="probe-contact" position={[0, 1.75, 0.6]} size={[1.3, 0.85]} mpu={1.2e-3 / 1.3} title="PROBE NEEDLES ON PADS · SCHEMATIC">
      <group rotation={[0.5, -0.2, 0]} position={[0, -0.12, 0]}>
        <B s={[1.1, 0.04, 0.5]} m={dieMat} position={[0, -0.02, 0]} />
        {Array.from({ length: 8 }, (_, i) => (
          <B key={i} s={[0.07, 0.012, 0.07]} m={padMat} position={[-0.42 + i * 0.12, 0.006, 0.12]} />
        ))}
        <group ref={tips}>
          {Array.from({ length: 8 }, (_, i) => (
            <mesh key={i} position={[-0.42 + i * 0.12, 0.2, 0.25]} rotation={[-0.9, 0, 0]} material={needleMat}>
              <cylinderGeometry args={[0.006, 0.0015, 0.42, 6]} />
            </mesh>
          ))}
        </group>
      </group>
      <mesh position={[0.52, 0.3, 0.02]}>
        <circleGeometry args={[0.035, 20]} />
        <meshBasicMaterial ref={led} color="#3a4a3c" toneMapped={false} />
      </mesh>
      <TechLabel position={[-0.62, 0.36, 0.02]} title="CONTACT → STIMULATE → MEASURE" min={2} value={() => `die ${probeState().i + 1} · Idd ${engine.tele.value('idd', 0).toFixed(0)} mA · Rc ${engine.tele.value('rc', 0).toFixed(2)} Ω · SIMULATED`} />
    </Inset>
  );
}

/* ---------------------------------------------------------------- screens */

function YieldScreen({ sort }: { sort: boolean }) {
  const counts = useMemo(() => {
    const c = { PASS: 0, FAIL: 0, REVIEW: 0 };
    for (const d of engine.waferMap) c[d.result]++;
    return c;
  }, []);
  return (
    <group position={[1.25, 0, -0.45]} rotation={[0, -0.6, 0]}>
      <C r={0.025} h={1.3} m={M.steelDark} position={[0, 0.65, 0]} />
      <Screen
        size={[0.66, 0.44]}
        position={[0, 1.52, 0.03]}
        hz={5}
        draw={(g, w, h) => {
          if (!sort) {
            clear(g, w, h, 'WAFER TEST · SIMULATED');
            const st = probeState();
            bigNumber(g, 'TESTED', String(st.tested), `/ ${engine.waferMap.length}`, w * 0.05, h * 0.2, h * 0.1);
            bigNumber(g, 'Idd', engine.tele.value('idd', 0).toFixed(0), 'mA', w * 0.5, h * 0.2, h * 0.1, engine.tele.value('idd', 0) > 200 ? SCR.crit : SCR.text);
            const c = engine.tele.get('idd');
            plot(g, c ? c.series().slice(-200) : [], w * 0.05, h * 0.5, w * 0.9, h * 0.4, 0, 300, SCR.data);
            return;
          }
          clear(g, w, h, 'WAFER SORT · YIELD · SIMULATED');
          const n = engine.waferMap.length;
          bigNumber(g, 'YIELD', ((100 * counts.PASS) / n).toFixed(1), '%', w * 0.05, h * 0.2, h * 0.12, SCR.good);
          const rows: [string, number, string][] = [
            ['GOOD', counts.PASS, RESULT_COLOR.PASS],
            ['FAIL', counts.FAIL, RESULT_COLOR.FAIL],
            ['REVIEW', counts.REVIEW, RESULT_COLOR.REVIEW],
          ];
          rows.forEach(([name, v, col], i) => {
            const y = h * (0.52 + i * 0.13);
            g.fillStyle = SCR.dim;
            g.font = `${Math.round(h * 0.06)}px monospace`;
            g.fillText(name, w * 0.05, y + h * 0.06);
            g.fillStyle = col;
            g.fillRect(w * 0.3, y, (w * 0.5 * v) / n, h * 0.08);
            g.fillStyle = SCR.text;
            g.fillText(String(v), w * 0.32 + (w * 0.5 * v) / n, y + h * 0.06);
          });
        }}
      />
    </group>
  );
}

export default function ProbeScene({ stage }: SceneProps) {
  const sort = stage.variant === 'sort';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.3;
  }, []);
  return (
    <>
      <Lighting env="assembly" shadowExtent={5} />
      <AssemblyFloor width={12} depth={9} />
      <Prober sort={sort} />
      {sort && <SortDies />}
      {!sort && <ContactInset />}
      <YieldScreen sort={sort} />
      <SensorIndicator id="probe-contact" channel={sort ? undefined : 'rc'} machine="prober" position={[0.32, WY + 0.08, 0.3]} size={0.03} />
      <TechLabel
        position={[-0.8, 1.75, 0.3]}
        title={sort ? 'WAFER SORT' : 'ELECTRICAL WAFER TEST'}
        lines={[sort ? 'good dies rise · rejects drop · review hovers' : 'every die is contacted and tested']}
        min={1}
        value={() => engine.player.view.phase.label}
      />
      <TechLabel position={[0.2, WY + 0.15, 0.25]} title="CLICK A DIE" min={2} show={() => sort && pp('separate') > 0.5} />
      {[-3.0, 2.9].map((x) => (
        <group key={x} position={[x, 0, -0.6]}>
          <B s={[1.3, 0.92, 1.2]} m={M.panel} position={[0, 0.46, 0]} />
          <B s={[0.9, 0.32, 0.8]} m={M.panelDark} position={[0, 1.2, 0]} />
        </group>
      ))}
      <Operator position={[-0.9, 0, 1.5]} rotation={Math.PI * 0.85} still />
    </>
  );
}
