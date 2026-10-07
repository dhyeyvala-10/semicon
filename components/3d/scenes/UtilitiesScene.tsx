'use client';
/**
 * The fab as a building (§81, §82): what surrounds the cleanroom. A generic, SCHEMATIC campus —
 * main fab (sub-fab · cleanroom · FFU plenum), central utility building with chillers and
 * cooling towers, ultrapure-water plant, bulk gas yard, electrical substation, chemical storage,
 * waste-water treatment and roof-top exhaust abatement. Utility flows are animated; click any
 * system. X-ray / internal views open the fab building.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Lighting } from '../environments';
import { M, shell, effectiveView } from '../materials';
import { B, C, GEO } from '../parts/primitives';
import { Clickable, TechLabel } from '../parts/interaction';
import { FlowLine } from '../parts/section';
import { engine } from '@/simulation/engine';
import { pdt } from '@/lib/anim';
import { cutPlane } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { rng } from '@/lib/math';
import type { V3 } from '../parts/primitives';

const FAB_W = 100;
const FAB_D = 60;
const FAB_H = 26;

const UTIL_COLOR: Record<string, string> = {
  power: '#e8c84a',
  upw: '#8fd0b8',
  gas: '#e3e8df',
  chem: '#d99545',
  cooling: '#7fbf6a',
  exhaust: '#9a9f97',
  waste: '#b9a36a',
};

/* ---------------------------------------------------------------- site */

const groundMat = new THREE.MeshStandardMaterial({ color: '#2c352d', roughness: 0.95 });
const roadMat = new THREE.MeshStandardMaterial({ color: '#3a3d3b', roughness: 0.9 });
const treeMat = new THREE.MeshStandardMaterial({ color: '#33502f', roughness: 0.9 });
const trunkMat = new THREE.MeshStandardMaterial({ color: '#4a3a2a', roughness: 0.9 });
const wallMat = new THREE.MeshStandardMaterial({ color: '#c9ccc5', roughness: 0.6, metalness: 0.15 });
const wallDark = new THREE.MeshStandardMaterial({ color: '#8d938c', roughness: 0.6, metalness: 0.2 });
const glassBand = new THREE.MeshStandardMaterial({ color: '#2a3a33', roughness: 0.15, metalness: 0.6 });
const steamMat = new THREE.MeshStandardMaterial({ color: '#e9ede6', transparent: true, opacity: 0.1, depthWrite: false, roughness: 1 });

function Site() {
  const trees = useMemo(() => {
    const r = rng(77);
    const out: [number, number, number][] = [];
    for (let i = 0; i < 70; i++) {
      const a = r() * Math.PI * 2;
      const d = 115 + r() * 60;
      out.push([Math.cos(a) * d, Math.sin(a) * d * 0.75, 0.7 + r() * 0.6]);
    }
    return out;
  }, []);
  const trunks = useRef<THREE.InstancedMesh>(null);
  const crowns = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const o = new THREE.Object3D();
    trees.forEach(([x, z, s], i) => {
      o.position.set(x, 2 * s, z);
      o.scale.set(0.5 * s, 4 * s, 0.5 * s);
      o.updateMatrix();
      trunks.current?.setMatrixAt(i, o.matrix);
      o.position.set(x, 7 * s, z);
      o.scale.set(3.2 * s, 7 * s, 3.2 * s);
      o.updateMatrix();
      crowns.current?.setMatrixAt(i, o.matrix);
    });
    if (trunks.current) trunks.current.instanceMatrix.needsUpdate = true;
    if (crowns.current) crowns.current.instanceMatrix.needsUpdate = true;
  }, [trees]);
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} receiveShadow material={groundMat}>
        <planeGeometry args={[600, 600]} />
      </mesh>
      {[
        [0, -48, 260, 10],
        [0, 72, 260, 8],
        [-102, 10, 8, 140],
        [104, 10, 8, 140],
      ].map(([x, z, w, d], i) => (
        <mesh key={i} rotation-x={-Math.PI / 2} position={[x, 0.02, z]} material={roadMat} receiveShadow>
          <planeGeometry args={[w, d]} />
        </mesh>
      ))}
      <instancedMesh ref={trunks} args={[GEO.cylLow, trunkMat, trees.length]} />
      <instancedMesh ref={crowns} args={[GEO.cone, treeMat, trees.length]} castShadow />
    </group>
  );
}

/* ---------------------------------------------------------------- main fab building */

function FabBuilding() {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  const view = effectiveView(viewRaw, cam);
  const sh = (m: THREE.Material) => shell(m, view);
  const inside = view !== 'normal';
  const toolRows = useMemo(() => {
    const out: [number, number][] = [];
    for (let i = 0; i < 12; i++) for (let j = 0; j < 2; j++) out.push([-42 + i * 7.6, j ? 8 : -8]);
    return out;
  }, []);
  return (
    <group>
      <Clickable sel={{ kind: 'component', id: 'fab-building', label: 'Main fab building' }}>
        {/* shell */}
        <B s={[FAB_W, FAB_H, 0.6]} m={sh(wallMat)} position={[0, FAB_H / 2, -FAB_D / 2]} />
        <B s={[FAB_W, FAB_H, 0.6]} m={sh(wallMat)} position={[0, FAB_H / 2, FAB_D / 2]} />
        <B s={[0.6, FAB_H, FAB_D]} m={sh(wallMat)} position={[-FAB_W / 2, FAB_H / 2, 0]} />
        <B s={[0.6, FAB_H, FAB_D]} m={sh(wallMat)} position={[FAB_W / 2, FAB_H / 2, 0]} />
        <B s={[FAB_W + 1, 0.8, FAB_D + 1]} m={sh(wallDark)} position={[0, FAB_H + 0.4, 0]} />
        <B s={[FAB_W + 0.2, 1.4, 0.7]} m={sh(glassBand)} position={[0, 12, FAB_D / 2]} />
        <B s={[FAB_W + 0.2, 0.6, 0.7]} m={sh(M.greenAccent)} position={[0, 20.5, FAB_D / 2]} />
      </Clickable>
      {/* inside (visible in x-ray / cut-away): sub-fab, cleanroom with tool rows, FFU plenum */}
      {inside && (
        <group>
          <Clickable sel={{ kind: 'component', id: 'u-vacuum', label: 'Sub-fab: pumps, abatement, chemical & gas distribution' }}>
            <B s={[FAB_W - 2, 0.5, FAB_D - 2]} m={M.concrete} position={[0, 8, 0]} />
            {toolRows.map(([x, z], i) => (
              <B key={i} s={[3, 2.5, 3]} m={M.panelGrey} position={[x, 1.25, z * 1.2]} />
            ))}
          </Clickable>
          <Clickable sel={{ kind: 'component', id: 'ffu', label: 'Cleanroom (waffle slab, tools)' }}>
            {toolRows.map(([x, z], i) => (
              <B key={i} s={[4.5, 3, 5]} m={M.panel} position={[x, 9.75, z]} />
            ))}
            <B s={[FAB_W - 2, 0.4, FAB_D - 2]} m={M.lightPanel} position={[0, 15.5, 0]} shadow={false} />
          </Clickable>
          <Clickable sel={{ kind: 'component', id: 'u-air', label: 'Return-air plenum & recirculation' }}>
            {[-30, -10, 10, 30].map((x) => (
              <B key={x} s={[8, 6, 8]} m={M.panelGrey} position={[x, 20, 0]} />
            ))}
          </Clickable>
        </group>
      )}
      {/* roof: make-up air units + exhaust abatement stacks */}
      <Clickable sel={{ kind: 'component', id: 'u-air', label: 'Make-up air units (roof)' }}>
        {[-36, -18, 0, 18, 36].map((x) => (
          <B key={x} s={[10, 3.5, 6]} m={M.panel} position={[x, FAB_H + 2.5, -18]} />
        ))}
      </Clickable>
      <Clickable sel={{ kind: 'component', id: 'u-waste', label: 'Exhaust scrubbers & stacks' }}>
        {[-40, -28, -16, 16, 28, 40].map((x) => (
          <group key={x} position={[x, FAB_H + 0.8, 18]}>
            <C r={1.6} h={5} m={M.panelWarm} position={[0, 2.5, 0]} />
            <C r={0.6} h={8} m={M.steel} position={[0, 7, 0]} />
          </group>
        ))}
      </Clickable>
    </group>
  );
}

/* ---------------------------------------------------------------- utility plants */

function CoolingTowers() {
  const plumes = useRef<THREE.InstancedMesh>(null);
  const seeds = useMemo(() => {
    const r = rng(12);
    return Array.from({ length: 36 }, (_, i) => ({ cell: i % 4, o: r(), s: 0.6 + r() * 0.6 }));
  }, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const t = useRef(0);
  useFrame((_, dt) => {
    t.current += Math.max(pdt(dt), dt * 0.3);
    if (!plumes.current) return;
    seeds.forEach((s, i) => {
      const u = (t.current * 0.12 * s.s + s.o) % 1;
      o.position.set(66 + s.cell * 7 + u * 4, 14 + u * 22, 34 + u * 3);
      o.scale.setScalar(1.6 + u * 3.4);
      o.updateMatrix();
      plumes.current!.setMatrixAt(i, o.matrix);
    });
    plumes.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <Clickable sel={{ kind: 'component', id: 'u-cooling', label: 'Cooling towers' }}>
      {[0, 1, 2, 3].map((i) => (
        <group key={i} position={[66 + i * 7, 0, 34]}>
          <B s={[6.4, 10, 6.4]} m={wallDark} position={[0, 5, 0]} />
          <C r={2.6} h={3} m={M.panelGrey} position={[0, 11.5, 0]} />
        </group>
      ))}
      <instancedMesh ref={plumes} args={[GEO.sphereLow, steamMat, seeds.length]} />
    </Clickable>
  );
}

function Plants() {
  return (
    <group>
      {/* central utility building: chillers, boilers, compressed air, house vacuum */}
      <Clickable sel={{ kind: 'component', id: 'u-cooling', label: 'Central utility building (chillers, CDA, vacuum)' }}>
        <B s={[30, 16, 34]} m={wallMat} position={[76, 8, -6]} />
        <B s={[30.4, 1, 34.4]} m={wallDark} position={[76, 16.5, -6]} />
        {[68, 76, 84].map((x) => (
          <B key={x} s={[5, 2, 8]} m={M.panelGrey} position={[x, 18, -6]} />
        ))}
      </Clickable>
      <CoolingTowers />
      {/* ultrapure water plant */}
      <Clickable sel={{ kind: 'component', id: 'u-water', label: 'Ultrapure water plant' }}>
        <B s={[30, 12, 26]} m={wallMat} position={[-76, 6, -8]} />
        {[-84, -76, -68].map((x) => (
          <C key={x} r={2.2} h={9} m={M.steel} position={[x, 4.5, 9.5]} />
        ))}
      </Clickable>
      {/* bulk gas yard */}
      <Clickable sel={{ kind: 'component', id: 'u-gases', label: 'Bulk gas yard (N₂, O₂, Ar, H₂)' }}>
        {[-86, -79, -72].map((x) => (
          <group key={x} position={[x, 0, 32]}>
            <C r={2.4} h={16} m={M.plastic} position={[0, 8, 0]} />
            <C r={2.45} h={0.6} m={M.steelDark} position={[0, 0.3, 0]} />
          </group>
        ))}
        <B s={[10, 4, 7]} m={wallDark} position={[-62, 2, 32]} />
      </Clickable>
      {/* substation */}
      <Clickable sel={{ kind: 'component', id: 'u-electricity', label: 'Electrical substation' }}>
        <B s={[30, 0.4, 20]} m={M.concrete} position={[76, 0.2, -50]} />
        {[66, 72, 78, 84].map((x) => (
          <group key={x} position={[x, 0, -50]}>
            <B s={[4, 4, 3]} m={M.panelGrey} position={[0, 2.4, 0]} />
            {[-1.2, 0, 1.2].map((dz) => (
              <C key={dz} r={0.18} h={2.4} m={M.ceramic} position={[0, 5.4, dz]} />
            ))}
          </group>
        ))}
        {[-6, 6].map((dz) => (
          <B key={dz} s={[0.4, 14, 0.4]} m={M.steelDark} position={[90, 7, -50 + dz]} />
        ))}
      </Clickable>
      {/* chemical storage */}
      <Clickable sel={{ kind: 'component', id: 'u-chemicals', label: 'Chemical storage & distribution' }}>
        <B s={[26, 7, 14]} m={wallDark} position={[26, 3.5, 50]} />
        {[18, 24, 30, 36].map((x) => (
          <C key={x} r={1.6} h={5} m={M.plastic} position={[x, 2.5, 60]} />
        ))}
      </Clickable>
      {/* waste water treatment */}
      <Clickable sel={{ kind: 'component', id: 'u-waste', label: 'Waste-water treatment' }}>
        {[-38, -22].map((x) => (
          <group key={x} position={[x, 0, 54]}>
            <mesh position={[0, 1.5, 0]} material={M.concrete}>
              <cylinderGeometry args={[7, 7, 3, 40, 1, true]} />
            </mesh>
            <mesh position={[0, 2.6, 0]} rotation-x={-Math.PI / 2} material={M.glassDark}>
              <circleGeometry args={[6.8, 40]} />
            </mesh>
          </group>
        ))}
      </Clickable>
    </group>
  );
}

/* ---------------------------------------------------------------- utility flows */

const FLOWS: { id: string; label: string; color: string; pts: V3[]; obj: string }[] = [
  { id: 'power', label: 'ELECTRICITY', color: UTIL_COLOR.power, obj: 'u-electricity', pts: [[76, 6, -40], [76, 6, -34], [52, 6, -34], [50, 6, -20]] },
  { id: 'cool', label: 'CHILLED / PROCESS COOLING WATER', color: UTIL_COLOR.cooling, obj: 'u-cooling', pts: [[61, 5, -6], [56, 5, -6], [50.5, 5, -6]] },
  { id: 'upw', label: 'ULTRAPURE WATER', color: UTIL_COLOR.upw, obj: 'u-water', pts: [[-61, 5, -8], [-56, 5, -8], [-50.5, 5, -8]] },
  { id: 'gas', label: 'BULK GASES', color: UTIL_COLOR.gas, obj: 'u-gases', pts: [[-72, 4, 26], [-58, 4, 26], [-58, 4, 31], [-50.5, 4, 22]] },
  { id: 'chem', label: 'CHEMICALS', color: UTIL_COLOR.chem, obj: 'u-chemicals', pts: [[26, 3, 43], [26, 3, 36], [20, 3, 30.5]] },
  { id: 'waste', label: 'WASTE WATER', color: UTIL_COLOR.waste, obj: 'u-waste', pts: [[-20, 2, 30.5], [-24, 2, 40], [-30, 2, 47]] },
  { id: 'exhaust', label: 'TREATED EXHAUST', color: UTIL_COLOR.exhaust, obj: 'u-waste', pts: [[-28, FAB_H + 10, 18], [-28, FAB_H + 22, 18]] },
];

function Flows() {
  return (
    <group>
      {FLOWS.map((f) => (
        <group key={f.id}>
          <FlowLine points={f.pts} color={f.color} speed={2.2} width={3} />
          <TechLabel position={f.pts[0]} title={f.label} min={2} />
        </group>
      ))}
      {/* pipe racks */}
      <B s={[12, 0.6, 2.4]} m={M.steelDark} position={[56, 4.4, -6]} />
      <B s={[12, 0.6, 2.4]} m={M.steelDark} position={[-56, 4.4, -8]} />
    </group>
  );
}

export default function UtilitiesScene() {
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0;
  }, []);
  return (
    <>
      <Lighting env="exterior" shadowExtent={140} />
      <Site />
      <FabBuilding />
      <Plants />
      <Flows />
      <TechLabel
        position={[-50, FAB_H + 14, 30]}
        title="FAB 1 · SCHEMATIC CAMPUS"
        lines={['the cleanroom is a small part of the site', 'proportions are illustrative']}
        min={1}
        value={() => `electrical load ≈ ${engine.tele.value('power', 0).toFixed(0)} MW · UPW ≈ ${engine.tele.value('upw', 0).toFixed(0)} m³/h · SIMULATED`}
      />
      <TechLabel position={[60, 20, 10]} title="CENTRAL UTILITY BUILDING" min={1} />
      <TechLabel position={[-90, 15, -8]} title="ULTRAPURE WATER" min={1} />
      <TechLabel position={[-90, 18, 32]} title="BULK GASES" min={1} />
      <TechLabel position={[64, 15, -50]} title="SUBSTATION" min={1} />
      <TechLabel position={[60, 30, 34]} title="COOLING TOWERS" min={1} />
      <TechLabel position={[-44, 8, 54]} title="WASTE-WATER TREATMENT" min={2} />
      <TechLabel position={[14, 10, 50]} title="CHEMICAL STORAGE" min={2} />
    </>
  );
}
