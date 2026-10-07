'use client';
/**
 * Packing & logistics (§52, §53).
 *   pack:      trays → tape & reel (devices drop into carrier-tape pockets) → dry pack
 *              (moisture-barrier bag, desiccant, humidity card, vacuum seal) → carton & label
 *   warehouse: palletise → AMRs store the pallet in high-bay racking → order picking → dispatch
 *              onto a truck. Generic, educational logistics model.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting } from '../environments';
import { M } from '../materials';
import { B, C, GEO } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Operator } from '../parts/people';
import { plainTile } from '../textures';
import { engine } from '@/simulation/engine';
import { pp, inPhase, pdt } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { clamp, smooth, lerp } from '@/lib/math';

const cardboard = new THREE.MeshStandardMaterial({ color: '#b08a5a', roughness: 0.85 });
const cardboardDark = new THREE.MeshStandardMaterial({ color: '#8f6d44', roughness: 0.85 });
const tapeMat = new THREE.MeshStandardMaterial({ color: '#2a2d2b', roughness: 0.5 });
const reelMat = new THREE.MeshStandardMaterial({ color: '#2e3f37', roughness: 0.5 });
const bagMat = new THREE.MeshPhysicalMaterial({ color: '#c9ccc9', roughness: 0.2, metalness: 0.8, transparent: true, opacity: 0.75 });
const labelMat = new THREE.MeshStandardMaterial({ color: '#f2f1ea', roughness: 0.6 });
const palletMat = new THREE.MeshStandardMaterial({ color: '#9a7a4a', roughness: 0.9 });
const wrapMat = new THREE.MeshPhysicalMaterial({ color: '#e8efe6', roughness: 0.1, transparent: true, opacity: 0.35, depthWrite: false });

/* ================================================================ packing line */

function labelTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f2f1ea';
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#1a1c1a';
  g.font = 'bold 18px monospace';
  g.fillText('FAB/TWIN', 10, 24);
  g.font = '12px monospace';
  g.fillText('CH-184-0412 · LOT A0731', 10, 44);
  g.fillText('QTY 500 · MSL 3 · DRY PACK', 10, 60);
  for (let i = 0; i < 60; i++) g.fillRect(10 + i * 3.8, 74, (i * 7) % 3 === 0 ? 2.4 : 1.2, 40);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function PackLine() {
  const reel = useRef<THREE.Group>(null);
  const bag = useRef<THREE.Group>(null);
  const carton = useRef<THREE.Group>(null);
  const flapA = useRef<THREE.Mesh>(null);
  const flapB = useRef<THREE.Mesh>(null);
  const label = useRef<THREE.Mesh>(null);
  const pockets = useRef<THREE.InstancedMesh>(null);
  const trays = useRef<THREE.Group>(null);
  const labelMatT = useMemo(() => new THREE.MeshStandardMaterial({ map: labelTexture(), roughness: 0.6 }), []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const spin = useRef(0);
  useFrame((_, dt) => {
    const tr = smooth(pp('tray'));
    const rl = inPhase('reel') ? engine.player.view.phaseT : pp('reel');
    const dp = inPhase('drypack') ? engine.player.view.phaseT : pp('drypack');
    const ct = inPhase('carton') ? engine.player.view.phaseT : pp('carton');
    if (trays.current) trays.current.children.forEach((c, i) => (c.position.y = 0.92 + i * 0.012 + (i / 6 > tr ? 0.3 : 0)));
    if (inPhase('reel')) spin.current += pdt(dt) * 2.5;
    // reel travels: tape&reel station → dry-pack station → carton station
    const toBag = smooth(clamp(dp / 0.3));
    const toBox = smooth(clamp(ct / 0.35));
    const rx = lerp(lerp(-0.3, 1.0, toBag), 2.2, toBox);
    const ry = lerp(1.25, 1.12, toBag);
    if (reel.current) {
      reel.current.position.set(rx, toBox > 0 ? lerp(1.12, 1.02, toBox) : ry, 0);
      reel.current.rotation.z = -spin.current;
      reel.current.rotation.x = lerp(0, -Math.PI / 2, toBag);
    }
    track('focus', rx, 1.1, 0);
    // carrier-tape pockets filling
    if (pockets.current) {
      for (let i = 0; i < 24; i++) {
        const filled = i / 24 < rl * 1.2;
        o.position.set(-1.1 + i * 0.03, 0.935, 0);
        o.scale.set(filled ? 0.02 : 0, 0.006, filled ? 0.02 : 0);
        o.updateMatrix();
        pockets.current.setMatrixAt(i, o.matrix);
      }
      pockets.current.instanceMatrix.needsUpdate = true;
    }
    if (bag.current) {
      const vis = dp > 0.25 && ct < 0.35;
      bag.current.visible = vis;
      const vac = smooth(clamp((dp - 0.6) / 0.4));
      bag.current.position.set(rx, 1.12, 0);
      bag.current.scale.set(1 - 0.12 * vac, 1 - 0.5 * vac, 1 - 0.12 * vac);
    }
    if (flapA.current && flapB.current) {
      const close = smooth(clamp((ct - 0.45) / 0.35));
      flapA.current.rotation.z = lerp(-1.4, 0, close);
      flapB.current.rotation.z = lerp(1.4, 0, close);
    }
    if (label.current) label.current.visible = ct > 0.85;
  });
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'packing-line', label: 'Packing line' }}>
        {/* conveyor */}
        <B s={[5.2, 0.08, 0.5]} m={M.panelGrey} position={[0.3, 0.88, 0]} />
        <B s={[5.2, 0.84, 0.4]} m={M.panel} position={[0.3, 0.42, 0]} />
        {Array.from({ length: 26 }, (_, i) => (
          <mesh key={i} position={[-2.2 + i * 0.2, 0.92, 0]} rotation={[Math.PI / 2, 0, 0]} material={M.steel}>
            <cylinderGeometry args={[0.02, 0.02, 0.48, 8]} />
          </mesh>
        ))}
        <SignalTower position={[2.8, 1.0, 0.3]} />
      </Clickable>
      {/* tray stack */}
      <Clickable sel={{ kind: 'component', id: 'pnp', machine: 'packing-line', label: 'JEDEC trays' }}>
        <group ref={trays} position={[-1.7, 0, 0]}>
          {Array.from({ length: 6 }, (_, i) => (
            <mesh key={i} geometry={GEO.box} material={i % 2 ? tapeMat : M.foupDark} scale={[0.32, 0.01, 0.14]} />
          ))}
        </group>
      </Clickable>
      {/* tape & reel machine */}
      <Clickable sel={{ kind: 'component', id: 'taper', machine: 'packing-line', label: 'Taping machine' }}>
        <B s={[0.5, 0.6, 0.35]} m={M.panelWarm} position={[-0.75, 1.25, -0.15]} />
        <mesh geometry={GEO.box} material={tapeMat} scale={[0.8, 0.004, 0.024]} position={[-0.75, 0.93, 0]} />
        <C r={0.012} h={0.3} m={M.steel} position={[-0.9, 1.08, 0]} />
      </Clickable>
      <instancedMesh ref={pockets} args={[GEO.box, M.pcb, 24]} />
      <group ref={reel}>
        <Clickable sel={{ kind: 'component', id: 'reel', machine: 'packing-line', label: 'Reel (13-inch)' }}>
          <mesh rotation={[Math.PI / 2, 0, 0]} material={reelMat}>
            <cylinderGeometry args={[0.165, 0.165, 0.004, 48]} />
          </mesh>
          <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.026]} material={reelMat}>
            <cylinderGeometry args={[0.165, 0.165, 0.004, 48]} />
          </mesh>
          <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.013]} material={tapeMat}>
            <cylinderGeometry args={[0.12, 0.12, 0.022, 40]} />
          </mesh>
          <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.013]} material={M.plastic}>
            <cylinderGeometry args={[0.05, 0.05, 0.03, 24]} />
          </mesh>
        </Clickable>
      </group>
      {/* dry-pack bag (vacuum-sealed around the reel) */}
      <group ref={bag}>
        <Clickable sel={{ kind: 'component', id: 'bagger', machine: 'packing-line', label: 'Moisture-barrier bag + desiccant + HIC' }}>
          <mesh geometry={GEO.box} material={bagMat} scale={[0.42, 0.09, 0.42]} />
          <mesh geometry={GEO.box} material={labelMat} scale={[0.08, 0.002, 0.06]} position={[0.1, 0.047, 0.08]} />
        </Clickable>
      </group>
      <Clickable sel={{ kind: 'component', id: 'bagger', machine: 'packing-line', label: 'Vacuum bag sealer' }}>
        <B s={[0.6, 0.12, 0.5]} m={M.panelGrey} position={[1.0, 1.42, 0]} />
        <B s={[0.6, 0.04, 0.05]} m={M.orangeAccent} position={[1.0, 1.35, 0.22]} />
      </Clickable>
      {/* carton */}
      <group ref={carton} position={[2.2, 0.92, 0]}>
        <Clickable sel={{ kind: 'component', id: 'cartoner', machine: 'packing-line', label: 'Carton & label' }}>
          <mesh geometry={GEO.box} material={cardboard} scale={[0.46, 0.012, 0.46]} position={[0, 0.006, 0]} />
          {[
            [0, 0.12, 0.23, 0.46, 0.012],
            [0, 0.12, -0.23, 0.46, 0.012],
          ].map(([x, y, z, w, d], i) => (
            <mesh key={i} geometry={GEO.box} material={cardboard} scale={[w, 0.24, d]} position={[x, y, z]} />
          ))}
          {[-0.23, 0.23].map((x) => (
            <mesh key={x} geometry={GEO.box} material={cardboard} scale={[0.012, 0.24, 0.46]} position={[x, 0.12, 0]} />
          ))}
          <mesh ref={flapA} geometry={GEO.box} material={cardboardDark} scale={[0.23, 0.008, 0.46]} position={[-0.115, 0.24, 0]} />
          <mesh ref={flapB} geometry={GEO.box} material={cardboardDark} scale={[0.23, 0.008, 0.46]} position={[0.115, 0.24, 0]} />
          <mesh ref={label} position={[0, 0.13, 0.237]} material={labelMatT}>
            <planeGeometry args={[0.2, 0.1]} />
          </mesh>
        </Clickable>
      </group>
      <SensorIndicator id="humidity" channel="rh" machine="packing-line" position={[1.2, 1.32, 0.25]} size={0.03} />
      <TechLabel
        position={[-2.0, 1.75, 0.3]}
        title="PACKING LINE"
        lines={['moisture-sensitive devices are dry-packed (J-STD-033)']}
        min={1}
        value={() => `${engine.player.view.phase.label} · reel ${engine.tele.value('reel', 0).toFixed(0)} units · bag ${engine.tele.value('rh', 0).toFixed(1)} %RH`}
      />
    </group>
  );
}

/* ================================================================ warehouse */

const DOCK = new THREE.Vector3(-7, 0, 1);
const PACK_AREA = new THREE.Vector3(0, 0, 3);
const SLOT = new THREE.Vector3(8, 2.2, -6);
const PICK_SLOT = new THREE.Vector3(4, 0.15, -6);

function Racks() {
  const pallets = useMemo(() => {
    const out: [number, number, number][] = [];
    for (const z of [-6, -10]) for (let i = 0; i < 9; i++) for (let l = 0; l < 4; l++) if ((i * 7 + l * 3 + z) % 5 !== 0) out.push([-1 + i * 1.5, 0.15 + l * 2.05, z]);
    return out;
  }, []);
  const inst = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const o = new THREE.Object3D();
    pallets.forEach(([x, y, z], i) => {
      o.position.set(x, y + 0.55, z);
      o.scale.set(1.1, 1.0, 1.0);
      o.updateMatrix();
      inst.current?.setMatrixAt(i, o.matrix);
    });
    if (inst.current) inst.current.instanceMatrix.needsUpdate = true;
  }, [pallets]);
  return (
    <Clickable sel={{ kind: 'component', id: 'racks', label: 'High-bay racking' }}>
      {[-6, -10].map((z) => (
        <group key={z}>
          {Array.from({ length: 10 }, (_, i) => (
            <B key={i} s={[0.08, 8.4, 1.2]} m={M.orangeAccent} position={[-1.75 + i * 1.5, 4.2, z]} />
          ))}
          {[0.1, 2.15, 4.2, 6.25].map((y) => (
            <B key={y} s={[13.6, 0.1, 1.2]} m={M.steelDark} position={[5, y, z]} />
          ))}
        </group>
      ))}
      <instancedMesh ref={inst} args={[GEO.box, cardboard, pallets.length]} castShadow />
    </Clickable>
  );
}

function AMR({ path, color = '#d8a62a' }: { path: () => { p: THREE.Vector3; load: boolean; lift: number }; color?: string }) {
  const g = useRef<THREE.Group>(null);
  const loadRef = useRef<THREE.Group>(null);
  const last = useRef(new THREE.Vector3());
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color, roughness: 0.5 }), [color]);
  useFrame(() => {
    const { p, load, lift } = path();
    if (!g.current) return;
    const d = p.clone().sub(last.current);
    if (d.lengthSq() > 1e-6) g.current.rotation.y = Math.atan2(d.x, d.z);
    last.current.copy(p);
    g.current.position.set(p.x, 0, p.z);
    if (loadRef.current) {
      loadRef.current.visible = load;
      loadRef.current.position.y = 0.32 + lift;
    }
  });
  return (
    <group ref={g}>
      <Clickable sel={{ kind: 'component', id: 'amr', label: 'Autonomous mobile robot' }}>
        <mesh geometry={GEO.box} material={mat} scale={[0.9, 0.28, 1.2]} position={[0, 0.16, 0]} castShadow />
        <mesh geometry={GEO.box} material={M.black} scale={[0.92, 0.04, 1.22]} position={[0, 0.3, 0]} />
        <C r={0.06} h={0.08} m={M.black} position={[0, 0.36, 0.5]} />
      </Clickable>
      <group ref={loadRef}>
        <mesh geometry={GEO.box} material={palletMat} scale={[1.1, 0.14, 1.0]} position={[0, 0.07, 0]} />
        <mesh geometry={GEO.box} material={cardboard} scale={[1.05, 0.9, 0.95]} position={[0, 0.6, 0]} castShadow />
        <mesh geometry={GEO.box} material={wrapMat} scale={[1.1, 0.95, 1.0]} position={[0, 0.6, 0]} />
      </group>
    </group>
  );
}

function Truck() {
  const g = useRef<THREE.Group>(null);
  const load = useRef<THREE.Group>(null);
  useFrame(() => {
    const leave = inPhase('dispatch') ? smooth(clamp((engine.player.view.phaseT - 0.55) / 0.45)) : pp('dispatch') >= 1 ? 1 : 0;
    if (g.current) g.current.position.x = DOCK.x - 4 - leave * 16;
    if (load.current) load.current.visible = inPhase('dispatch') && engine.player.view.phaseT > 0.45;
  });
  return (
    <group ref={g} position={[DOCK.x - 4, 0, DOCK.z]}>
      <Clickable sel={{ kind: 'component', id: 'truck', label: 'Truck (dispatch)' }}>
        <B s={[7, 2.8, 2.5]} m={M.panel} position={[0, 1.9, 0]} />
        <B s={[2, 2.4, 2.4]} m={M.greenAccent} position={[-4.6, 1.5, 0]} />
        {[-3.8, -1.5, 2.2].map((x) => (
          <group key={x}>
            <mesh position={[x, 0.45, 1.2]} rotation={[Math.PI / 2, 0, 0]} material={M.rubber}>
              <cylinderGeometry args={[0.45, 0.45, 0.3, 20]} />
            </mesh>
            <mesh position={[x, 0.45, -1.2]} rotation={[Math.PI / 2, 0, 0]} material={M.rubber}>
              <cylinderGeometry args={[0.45, 0.45, 0.3, 20]} />
            </mesh>
          </group>
        ))}
      </Clickable>
      <group ref={load}>
        <mesh geometry={GEO.box} material={cardboard} scale={[1.05, 0.9, 0.95]} position={[2.6, 1.2, 0]} />
      </group>
    </group>
  );
}

function Warehouse() {
  const floor = useMemo(() => new THREE.MeshStandardMaterial({ map: plainTile([20, 14], '#8d918a'), roughness: 0.6 }), []);
  const cartons = useRef<THREE.Group>(null);
  useFrame(() => {
    const k = inPhase('pallet') ? engine.player.view.phaseT : pp('pallet');
    if (cartons.current) cartons.current.children.forEach((c, i) => (c.visible = i / 12 < k * 1.1 && pp('store') < 0.05));
  });
  // AMR 1: carries the new pallet into storage
  const amr1 = () => {
    const st = inPhase('store') ? smooth(engine.player.view.phaseT) : pp('store');
    const p = PACK_AREA.clone().lerp(new THREE.Vector3(SLOT.x, 0, -4.2), clamp(st * 1.3));
    if (st > 0.77) p.lerp(new THREE.Vector3(SLOT.x, 0, SLOT.z), smooth((st - 0.77) / 0.23));
    track('focus', p.x, 1, p.z);
    return { p, load: st < 0.98 && pp('pallet') > 0.95, lift: st > 0.77 ? lerp(0, SLOT.y - 0.15, smooth((st - 0.77) / 0.23)) : 0 };
  };
  // AMR 2: order picking → dock
  const amr2 = () => {
    const pk = inPhase('pick') ? smooth(engine.player.view.phaseT) : pp('pick');
    const dp = inPhase('dispatch') ? smooth(clamp(engine.player.view.phaseT / 0.5)) : pp('dispatch');
    const p = new THREE.Vector3(1, 0, 4).lerp(new THREE.Vector3(PICK_SLOT.x, 0, PICK_SLOT.z), pk);
    if (dp > 0) p.lerp(new THREE.Vector3(DOCK.x + 1.5, 0, DOCK.z), dp);
    if (inPhase('pick') || inPhase('dispatch')) track('focus', p.x, 1, p.z);
    return { p, load: pk > 0.6 && dp < 0.98, lift: 0 };
  };
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} receiveShadow material={floor}>
        <planeGeometry args={[40, 28]} />
      </mesh>
      <B s={[40, 10, 0.2]} m={M.panel} position={[0, 5, -13]} />
      {Array.from({ length: 8 }, (_, i) => (
        <B key={i} s={[2.4, 0.06, 0.4]} m={M.lightPanel} position={[-14 + i * 4, 9.6, -2]} shadow={false} />
      ))}
      {/* dock door */}
      <B s={[0.2, 4, 4]} m={M.steelDark} position={[DOCK.x - 0.3, 2, DOCK.z]} />
      <B s={[0.25, 3.6, 3.4]} m={M.black} position={[DOCK.x - 0.2, 1.8, DOCK.z]} />
      <Racks />
      {/* packing area: cartons being stacked on a pallet, then stretch wrapped */}
      <group position={[PACK_AREA.x, 0, PACK_AREA.z]}>
        <mesh geometry={GEO.box} material={palletMat} scale={[1.1, 0.14, 1.0]} position={[0, 0.07, 0]} />
        <group ref={cartons}>
          {Array.from({ length: 12 }, (_, i) => (
            <mesh key={i} geometry={GEO.box} material={i % 2 ? cardboard : cardboardDark} scale={[0.5, 0.3, 0.45]} position={[-0.27 + (i % 2) * 0.54, 0.29 + Math.floor(i / 4) * 0.31, -0.24 + (Math.floor(i / 2) % 2) * 0.48]} />
          ))}
        </group>
      </group>
      <AMR path={amr1} />
      <AMR path={amr2} color="#7fbf6a" />
      <Truck />
      <Operator position={[1.6, 0, 4.2]} rotation={-Math.PI * 0.7} still />
      <TechLabel
        position={[-3, 4.2, 3]}
        title="DISTRIBUTION CENTRE"
        lines={['controlled storage · AMRs · order picking · dispatch']}
        min={1}
        value={() => `${engine.player.view.phase.label} · inventory ≈ ${engine.tele.value('inv', 0).toFixed(0)}k units · AMRs ${engine.tele.value('amr', 0).toFixed(0)} · SIMULATED`}
      />
    </group>
  );
}

export default function ShippingScene({ stage }: SceneProps) {
  const pack = stage.variant !== 'warehouse';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0;
  }, []);
  return (
    <>
      <Lighting env="warehouse" shadowExtent={pack ? 5 : 18} />
      {pack ? (
        <>
          <mesh rotation-x={-Math.PI / 2} receiveShadow>
            <planeGeometry args={[16, 12]} />
            <meshStandardMaterial color="#8d918a" roughness={0.6} />
          </mesh>
          <B s={[16, 4, 0.1]} m={M.panel} position={[0, 2, -3]} />
          <PackLine />
          <Operator position={[-2.6, 0, 0.9]} rotation={Math.PI * 0.8} still />
        </>
      ) : (
        <Warehouse />
      )}
    </>
  );
}
