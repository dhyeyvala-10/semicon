'use client';
/**
 * Wafer inspection (§16, §41): a laser surface scanner with dark-field collectors.
 *   bare:      prime-wafer qualification — the spot spirals over the spinning wafer, light-point
 *              defects light up, accepted wafers are packed for shipment
 *   patterned: the laser line sweeps the patterned wafer, defects are classified, and a die map
 *              is produced — click a die to inspect it
 * Defect data is SIMULATED (engine wafer map) — fictional categories, not production data.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, CleanroomBay } from '../environments';
import { M, shell, effectiveView } from '../materials';
import { B, C } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { waferGeometry } from '../parts/wafer';
import { Screen, clear, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { drawWafer } from '../textures';
import { engine } from '@/simulation/engine';
import { pp, inPhase, pdt } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { rng, smooth, lerp, hash1 } from '@/lib/math';
import { DEFECT_CLASSES, DIE_W, DIE_H, WAFER_D } from '@/simulation/models';

const WY = 1.0;
const CLASS_COLOR: Record<string, string> = {
  Particle: '#e8e0b0',
  'Pattern bridge': '#ec835a',
  'Open line': '#d64b40',
  Scratch: '#f0a050',
  Residue: '#a99bd6',
  'Edge chipping': '#c9b46a',
  'Parametric drift': '#e8b23a',
};

interface Defect {
  x: number; // wafer-local m
  z: number;
  cls: string;
  r: number; // normalised radius 0..1 (scan order for the spiral)
  u: number; // 0..1 sweep order for the line scan
}

function useDefects(bare: boolean): Defect[] {
  return useMemo(() => {
    if (bare) {
      const r = rng(23);
      return Array.from({ length: 6 }, () => {
        const a = r() * Math.PI * 2;
        const rr = Math.sqrt(r()) * 0.14;
        return { x: Math.cos(a) * rr, z: Math.sin(a) * rr, cls: 'Particle', r: rr / 0.15, u: (Math.sin(a) * rr + 0.15) / 0.3 };
      });
    }
    return engine.waferMap
      .filter((d) => d.result !== 'PASS')
      .map((d) => {
        const x = (d.die.cx + (hash1(d.die.id) - 0.5) * DIE_W * 0.6) / 1000;
        const z = (d.die.cy + (hash1(d.die.id + 7) - 0.5) * DIE_H * 0.6) / 1000;
        return { x, z, cls: d.defect ?? 'Particle', r: Math.hypot(x, z) / 0.15, u: (z + 0.15) / 0.3 };
      });
  }, [bare]);
}

/** progress of the scan (0..1) */
const scanK = () => (inPhase('scan') ? engine.player.view.phaseT : pp('scan') >= 1 ? 1 : 0);

/* ---------------------------------------------------------------- wafer surface */

function useSurface(bare: boolean, defects: Defect[]) {
  return useMemo(() => {
    const S = 512;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const base = document.createElement('canvas');
    base.width = base.height = S;
    const bg = base.getContext('2d')!;
    if (bare) {
      bg.fillStyle = '#9aa1aa';
      bg.fillRect(0, 0, S, S);
    } else drawWafer(bg, S, 'dies');
    let last = '';
    const update = () => {
      const k = scanK();
      const classify = pp('classify') > 0;
      const key = `${Math.round(k * 60)}:${classify}`;
      if (key === last) return;
      last = key;
      g.drawImage(base, 0, 0);
      // scanned area tint
      g.fillStyle = 'rgba(160,210,140,0.10)';
      if (bare) {
        g.beginPath();
        g.arc(S / 2, S / 2, (S / 2) * k, 0, Math.PI * 2);
        g.fill();
      } else g.fillRect(0, 0, S, S * k);
      const px = (m: number) => S / 2 + (m * 1000 * S) / WAFER_D;
      for (const d of defects) {
        const found = bare ? d.r <= k : d.u <= k;
        if (!found) continue;
        g.fillStyle = classify ? CLASS_COLOR[d.cls] ?? '#fff' : '#fffbe0';
        g.beginPath();
        g.arc(px(d.x), px(d.z), classify ? 5 : 4, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = 'rgba(255,250,220,0.5)';
        g.lineWidth = 1;
        g.beginPath();
        g.arc(px(d.x), px(d.z), 9, 0, Math.PI * 2);
        g.stroke();
      }
      tex.needsUpdate = true;
    };
    update();
    return { tex, update };
  }, [bare, defects]);
}

/* ---------------------------------------------------------------- die map (clickable) */

const tmpColor = new THREE.Color();
function DieMap() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const dies = engine.waferMap;
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.92 }), []);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const o = new THREE.Object3D();
    dies.forEach((d, i) => {
      o.position.set(d.die.cx / 1000, 0, d.die.cy / 1000);
      o.scale.set((DIE_W / 1000) * 0.9, 0.0008, (DIE_H / 1000) * 0.9);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
      m.setColorAt(i, tmpColor.set(d.result === 'PASS' ? '#4f9a5a' : d.result === 'FAIL' ? '#c4483b' : '#d1a23a'));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [dies]);
  useFrame(() => {
    if (ref.current) ref.current.visible = inPhase('map');
  });
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const i = e.instanceId;
    if (i === undefined) return;
    const d = dies[i];
    useUI.getState().select({ kind: 'die', id: String(d.die.id), label: `Die (${d.die.col}, ${d.die.row})` });
  };
  return (
    <instancedMesh ref={ref} args={[undefined, mat, dies.length]} position={[0, 0.0016, 0]} onClick={onClick}>
      <boxGeometry />
    </instancedMesh>
  );
}

/* ---------------------------------------------------------------- tool */

const laserMat = new THREE.MeshBasicMaterial({ color: '#b7ff9a', transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false });
const spotMat = new THREE.MeshBasicMaterial({ color: '#eaffd8', toneMapped: false });

function Tool({ bare }: { bare: boolean }) {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  const view = effectiveView(viewRaw, cam === 'machine' ? 'internal' : cam);
  const sh = (m: THREE.Material) => shell(m, view);
  const defects = useDefects(bare);
  const surf = useSurface(bare, defects);
  const top = useMemo(() => new THREE.MeshStandardMaterial({ map: surf.tex, roughness: 0.15, metalness: 0.45 }), [surf]);
  const waferMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.08, metalness: 0.9 }), []);
  const spin = useRef<THREE.Group>(null);
  const wafer = useRef<THREE.Group>(null);
  const beam = useRef<THREE.Mesh>(null);
  const spot = useRef<THREE.Mesh>(null);
  const line = useRef<THREE.Mesh>(null);
  const box = useRef<THREE.Group>(null);
  const ang = useRef(0);
  useFrame((_, dt) => {
    surf.update();
    const k = scanK();
    const scanning = inPhase('scan');
    if (scanning && bare) ang.current += pdt(dt) * 14;
    if (spin.current) spin.current.rotation.y = ang.current;
    // load / pack motion
    const inP = smooth(pp('load'));
    const outP = bare ? smooth(pp('pack')) : 0;
    const p = new THREE.Vector3(lerp(0.75, 0, inP), WY + Math.sin(Math.PI * inP) * 0.08, lerp(0.45, 0, inP));
    if (outP > 0) p.set(lerp(0, -0.95, outP), WY + Math.sin(Math.PI * outP) * 0.15, lerp(0, 0.35, outP));
    if (wafer.current) wafer.current.position.copy(p);
    track('focus', p.x, p.y, p.z);
    // laser spot: bare → spiral (radius grows with coverage); patterned → line sweeping in z
    const sx = bare ? 0.15 * k : 0;
    const sz = bare ? 0 : lerp(-0.15, 0.15, k);
    if (spot.current) {
      spot.current.visible = scanning && bare;
      spot.current.position.set(sx, WY + 0.0012, 0);
    }
    if (line.current) {
      line.current.visible = scanning && !bare;
      line.current.position.set(0, WY + 0.0012, sz);
    }
    if (beam.current) {
      beam.current.visible = scanning;
      const from = new THREE.Vector3(-0.42, 1.42, -0.1);
      const to = new THREE.Vector3(sx, WY, sz);
      beam.current.position.copy(from).add(to).multiplyScalar(0.5);
      beam.current.scale.set(1, from.distanceTo(to), 1);
      beam.current.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
    }
    if (box.current) box.current.visible = bare;
  });
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'surface-inspection', label: bare ? 'Surface scanner' : 'Patterned-wafer inspection' }}>
        <B s={[1.7, 0.9, 1.3]} m={M.panel} position={[0, 0.45, 0]} />
        <B s={[1.72, 0.05, 1.32]} m={M.greenAccent} position={[0, 0.88, 0]} />
        {/* inspection enclosure */}
        <B s={[1.2, 0.9, 0.04]} m={sh(M.panelWarm)} position={[0, 1.35, -0.6]} />
        <B s={[1.2, 0.9, 0.04]} m={sh(M.panelWarm)} position={[0, 1.35, 0.6]} />
        <B s={[0.04, 0.9, 1.2]} m={sh(M.panelWarm)} position={[-0.6, 1.35, 0]} />
        <B s={[1.24, 0.04, 1.24]} m={sh(M.panelGrey)} position={[0, 1.82, 0]} />
        <Clickable sel={{ kind: 'component', id: 'laser', machine: 'surface-inspection', label: 'Laser source' }}>
          <B s={[0.22, 0.12, 0.12]} m={M.panelDark} position={[-0.45, 1.45, -0.1]} rotation={[0, 0, -0.6]} />
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'collectors', machine: 'surface-inspection', label: 'Dark-field collectors' }}>
          {[0, 1, 2].map((i) => {
            const a = 0.6 + i * 1.6;
            return (
              <group key={i} position={[Math.cos(a) * 0.32, 1.35, Math.sin(a) * 0.32]} rotation={[Math.sin(a) * 0.8, 0, -Math.cos(a) * 0.8]}>
                <C r={0.05} h={0.14} m={M.black} />
                <C r={0.052} h={0.01} m={M.glassDark} position={[0, -0.075, 0]} />
              </group>
            );
          })}
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'stage', machine: 'surface-inspection', label: bare ? 'Spin stage' : 'XY stage' }}>
          <C r={0.17} h={0.06} m={M.alu} position={[0, 0.95, 0]} />
        </Clickable>
        <SignalTower position={[0.75, 1.0, 0.55]} />
      </Clickable>
      <group ref={wafer}>
        <group ref={spin}>
          <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184' }}>
            <mesh geometry={waferGeometry()} material={waferMat} castShadow />
            <mesh position={[0, 0.0005, 0]} rotation={[-Math.PI / 2, 0, 0]} material={top}>
              <circleGeometry args={[0.149, 64]} />
            </mesh>
          </Clickable>
        </group>
        {!bare && <DieMap />}
      </group>
      <mesh ref={beam} material={laserMat}>
        <cylinderGeometry args={[0.0025, 0.0025, 1, 6]} />
      </mesh>
      <mesh ref={spot} material={spotMat}>
        <cylinderGeometry args={[0.006, 0.006, 0.001, 12]} />
      </mesh>
      <mesh ref={line} material={spotMat}>
        <boxGeometry args={[0.3, 0.0008, 0.003]} />
      </mesh>
      {/* shipping box for accepted prime wafers */}
      <group ref={box} position={[-0.95, 0.9, 0.35]}>
        <B s={[0.36, 0.3, 0.36]} m={M.foupShell} position={[0, 0.15, 0]} />
        <B s={[0.37, 0.03, 0.37]} m={M.foupDark} position={[0, 0.31, 0]} />
      </group>
    </group>
  );
}

/* ---------------------------------------------------------------- screens */

function ParetoScreen({ bare }: { bare: boolean }) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    if (bare) c.Particle = 6;
    else for (const d of engine.waferMap) if (d.result !== 'PASS') c[d.defect ?? 'Particle'] = (c[d.defect ?? 'Particle'] ?? 0) + 1;
    return DEFECT_CLASSES.map((k) => [k, c[k] ?? 0] as [string, number]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  }, [bare]);
  return (
    <group position={[1.35, 0, -0.45]} rotation={[0, -0.55, 0]}>
      <C r={0.025} h={1.3} m={M.steelDark} position={[0, 0.65, 0]} />
      <Screen
        size={[0.66, 0.44]}
        position={[0, 1.52, 0.03]}
        hz={4}
        draw={(g, w, h) => {
          const k = scanK();
          clear(g, w, h, bare ? 'LIGHT-POINT DEFECTS · SIMULATED' : 'DEFECT PARETO · SIMULATED');
          const total = counts.reduce((a, [, n]) => a + n, 0);
          bigNumber(g, 'COVERAGE', (k * 100).toFixed(0), '%', w * 0.05, h * 0.2, h * 0.09);
          bigNumber(g, 'DEFECTS', Math.round(total * k).toFixed(0), '', w * 0.4, h * 0.2, h * 0.09, total * k > 15 ? SCR.warn : SCR.text);
          bigNumber(g, 'VERDICT', bare ? (pp('classify') > 0.5 ? 'PRIME · PASS' : '…') : pp('map') > 0 ? 'MAP READY' : '…', '', w * 0.66, h * 0.2, h * 0.06, SCR.good);
          const max = Math.max(1, ...counts.map(([, n]) => n));
          const classify = pp('classify') > 0;
          counts.slice(0, 6).forEach(([name, n], i) => {
            const y = h * (0.42 + i * 0.09);
            const bw = (w * 0.5 * n * (classify ? 1 : k)) / max;
            g.fillStyle = SCR.dim;
            g.font = `${Math.round(h * 0.045)}px monospace`;
            g.fillText(name.toUpperCase(), w * 0.05, y + h * 0.045);
            g.fillStyle = classify ? CLASS_COLOR[name] ?? SCR.data : SCR.data;
            g.fillRect(w * 0.4, y, Math.max(2, bw), h * 0.06);
            g.fillStyle = SCR.text;
            g.fillText(String(n), w * 0.42 + bw, y + h * 0.045);
          });
        }}
      />
    </group>
  );
}

export default function InspectionScene({ stage }: SceneProps) {
  const bare = stage.variant === 'bare';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.3;
  }, []);
  return (
    <>
      <Lighting env="cleanroom" shadowExtent={5} />
      <CleanroomBay width={11} depth={8} height={4.2} />
      <Tool bare={bare} />
      <ParetoScreen bare={bare} />
      <SensorIndicator id="scatter-detector" channel={bare ? 'lpd' : 'defects'} machine="surface-inspection" position={[0.3, 1.5, 0.25]} size={0.035} />
      <TechLabel
        position={[-0.9, 2.1, 0.2]}
        title={bare ? 'PRIME WAFER QUALIFICATION' : 'PATTERNED-WAFER INSPECTION'}
        lines={[bare ? 'laser spot spirals over the spinning wafer' : 'laser line sweeps; scattered light reveals anomalies']}
        min={1}
        value={() => engine.player.view.phase.label}
      />
      <TechLabel position={[0.2, 1.25, 0.3]} title="CLICK A DIE ON THE MAP" min={1} show={() => !bare && inPhase('map')} />
      {[-2.4, 2.6].map((x) => (
        <group key={x} position={[x, 0, -0.4]}>
          <B s={[1.4, 1.7, 1.2]} m={M.panel} position={[0, 0.85, 0]} />
          <B s={[1.42, 0.05, 1.22]} m={M.greenAccent} position={[0, 1.3, 0]} />
        </group>
      ))}
      <Operator position={[-1.2, 0, 1.6]} rotation={Math.PI * 0.85} still />
    </>
  );
}

