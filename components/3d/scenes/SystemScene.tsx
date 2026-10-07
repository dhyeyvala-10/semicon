'use client';
/**
 * The chip in a system (§58) — 1 world unit = 1 cm. Generic, educational layouts.
 *   CPU journey: die → package (substrate + lid) → socket on a motherboard → memory, power
 *                delivery, cooler → mounted in a tower computer
 *   GPU journey: die → package with HBM → soldered onto a graphics card → heatsink & fans →
 *                cards installed in a server chassis
 * The exploded view lifts each part apart.
 */
import * as THREE from 'three';
import { useMemo, useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { Lighting } from '../environments';
import { GEO } from '../parts/primitives';
import { Clickable, TechLabel } from '../parts/interaction';
import { dieFloorplan, substrateTexture } from '../textures';
import { engine } from '@/simulation/engine';
import { pp } from '@/lib/anim';
import { track } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { useParam } from '@/hooks/useTicker';
import { clamp, smooth, lerp } from '@/lib/math';

const std = (color: string, p: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1, ...p });
const MAT = {
  pcb: std('#1f4a35', { roughness: 0.55 }),
  pcbDark: std('#18392a', { roughness: 0.6 }),
  gold: std('#d9a944', { roughness: 0.25, metalness: 1 }),
  socket: std('#2a2d2b', { roughness: 0.6 }),
  lever: std('#b9bec4', { roughness: 0.3, metalness: 0.9 }),
  lid: std('#c9cdd0', { roughness: 0.25, metalness: 0.95 }),
  dimm: std('#244a37'),
  chip: std('#1c1d20', { roughness: 0.6 }),
  fin: std('#b9bec4', { roughness: 0.35, metalness: 0.9 }),
  fan: std('#2a2d2b', { roughness: 0.5 }),
  fanBlade: std('#3a3f3c', { roughness: 0.5 }),
  caseMat: std('#3d4540', { roughness: 0.45, metalness: 0.55 }),
  glass: new THREE.MeshPhysicalMaterial({ color: '#9fb4a8', roughness: 0.05, transparent: true, opacity: 0.16, depthWrite: false }),
  cap: std('#3a3f3c', { metalness: 0.6, roughness: 0.4 }),
  shroud: std('#3d4642', { metalness: 0.5, roughness: 0.4 }),
  hbm: std('#3d4642', { metalness: 0.4, roughness: 0.35 }),
  si: std('#4a5560', { metalness: 0.5, roughness: 0.3 }),
};

const k = (id: string) => smooth(clamp(pp(id) * 1.2));

function Ex({ lift, children }: { lift: number; children: ReactNode }) {
  const view = useUI((s) => s.view);
  const g = useRef<THREE.Group>(null);
  const e = useRef(0);
  useFrame((_, dt) => {
    e.current += ((view === 'exploded' ? 1 : 0) - e.current) * Math.min(1, dt * 3);
    if (g.current) g.current.position.y = e.current * lift;
  });
  return <group ref={g}>{children}</group>;
}

/** group following a per-frame transform function */
function Anim({ f, children }: { f: (g: THREE.Group) => void; children: ReactNode }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    if (g.current) f(g.current);
  });
  return <group ref={g}>{children}</group>;
}

function Box({ s, p, m, sel }: { s: [number, number, number]; p: [number, number, number]; m: THREE.Material | THREE.Material[]; sel?: { id: string; label: string } }) {
  const mesh = <mesh geometry={GEO.box} material={m} scale={s} position={p} castShadow receiveShadow />;
  return sel ? <Clickable sel={{ kind: 'component', id: sel.id, label: sel.label }}>{mesh}</Clickable> : mesh;
}

/* ================================================================ CPU */

function Cpu() {
  const dieMats = useMemo(() => [MAT.si, MAT.si, new THREE.MeshStandardMaterial({ map: dieFloorplan('cpu'), roughness: 0.3, metalness: 0.35 }), MAT.si, MAT.si, MAT.si], []);
  const subMats = useMemo(() => {
    const top = new THREE.MeshStandardMaterial({ map: substrateTexture(), roughness: 0.5 });
    return [MAT.pcbDark, MAT.pcbDark, top, MAT.pcbDark, MAT.pcbDark, MAT.pcbDark];
  }, []);
  const lidTop = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    g.fillStyle = '#c9cdd0';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#6e7377';
    g.font = 'bold 30px monospace';
    g.fillText('FAB/TWIN', 40, 110);
    g.font = '18px monospace';
    g.fillText('CH-184-0412', 40, 145);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return [MAT.lid, MAT.lid, new THREE.MeshStandardMaterial({ map: t, roughness: 0.25, metalness: 0.9 }), MAT.lid, MAT.lid, MAT.lid];
  }, []);
  // socket position on the board
  const SX = -4;
  const SZ = -2;
  return (
    <group>
      {/* the package: die → substrate + lid, then moves into the socket */}
      <Anim
        f={(g) => {
          const s = k('socket');
          g.position.set(lerp(0, SX, s), lerp(0, 0.45, s), lerp(0, SZ, s));
          track('focus', g.position.x, g.position.y, g.position.z);
        }}
      >
        <Ex lift={3}>
          <Box s={[1.3, 0.08, 1.65]} p={[0, 0.2, 0]} m={dieMats} sel={{ id: 'pkg-die', label: 'CPU die (generic)' }} />
        </Ex>
        <Anim
          f={(g) => {
            const v = k('package');
            g.visible = v > 0.01;
            g.position.y = (1 - v) * -2;
          }}
        >
          <Ex lift={0}>
            <Box s={[4.5, 0.12, 3.75]} p={[0, 0.1, 0]} m={subMats} sel={{ id: 'pkg-substrate', label: 'Package substrate' }} />
          </Ex>
        </Anim>
        <Anim
          f={(g) => {
            const v = smooth(clamp((pp('package') - 0.4) / 0.6));
            g.visible = v > 0.01;
            g.position.y = (1 - v) * 3;
          }}
        >
          <Ex lift={5}>
            <Box s={[3.6, 0.25, 3.2]} p={[0, 0.38, 0]} m={lidTop} sel={{ id: 'lid', label: 'Integrated heat spreader' }} />
          </Ex>
        </Anim>
      </Anim>
      {/* motherboard + socket */}
      <Anim
        f={(g) => {
          const v = k('socket');
          g.visible = v > 0.01;
          g.position.y = (1 - v) * -6;
          // in the system phase the board stands up and slides into the case
          const sy = k('system');
          g.rotation.x = lerp(0, -Math.PI / 2, sy);
          g.position.z = lerp(0, -10, sy);
          g.position.y += lerp(0, 14, sy);
        }}
      >
        <Ex lift={-3}>
          <Box s={[30.5, 0.16, 24.4]} p={[0, 0, 0]} m={MAT.pcb} sel={{ id: 'motherboard', label: 'Motherboard' }} />
        </Ex>
        <Box s={[5.2, 0.5, 4.6]} p={[SX, 0.33, SZ]} m={MAT.socket} sel={{ id: 'socket', label: 'CPU socket (LGA)' }} />
        <Anim
          f={(g) => {
            g.rotation.z = lerp(-1.2, 0, smooth(clamp((pp('socket') - 0.7) / 0.3)));
          }}
        >
          <Box s={[0.12, 0.12, 5.2]} p={[SX + 2.8, 0.6, SZ]} m={MAT.lever} />
        </Anim>
        {/* VRM */}
        <Clickable sel={{ kind: 'component', id: 'vrm', label: 'Voltage regulator (VRM)' }}>
          {Array.from({ length: 8 }, (_, i) => (
            <group key={i}>
              <mesh geometry={GEO.box} material={MAT.chip} scale={[0.9, 0.5, 0.9]} position={[SX - 4.5, 0.33, SZ - 3.5 + i * 1.0]} />
              <mesh geometry={GEO.cyl} material={MAT.cap} scale={[0.3, 0.9, 0.3]} position={[SX - 5.8, 0.53, SZ - 3.5 + i * 1.0]} />
            </group>
          ))}
        </Clickable>
        {/* DIMM slots + modules */}
        {[0, 1, 2, 3].map((i) => (
          <group key={i}>
            <Box s={[0.6, 0.8, 14]} p={[SX + 6 + i * 1.1, 0.48, SZ]} m={MAT.socket} />
            <Anim
              f={(g) => {
                const v = smooth(clamp(pp('board') * 2 - i * 0.15));
                g.visible = v > 0.01;
                g.position.y = (1 - v) * 6;
              }}
            >
              <Ex lift={4}>
                <Clickable sel={{ kind: 'component', id: 'dimm', label: 'Memory module (DIMM)' }}>
                  <mesh geometry={GEO.box} material={MAT.dimm} scale={[0.15, 3.1, 13.3]} position={[SX + 6 + i * 1.1, 2.3, SZ]} castShadow />
                  {Array.from({ length: 8 }, (_, j) => (
                    <mesh key={j} geometry={GEO.box} material={MAT.chip} scale={[0.1, 0.9, 1.1]} position={[SX + 6.1 + i * 1.1, 2.4, SZ - 5.6 + j * 1.6]} />
                  ))}
                </Clickable>
              </Ex>
            </Anim>
          </group>
        ))}
        {/* PCIe slots */}
        {[6, 9.5].map((z) => (
          <Box key={z} s={[9, 0.9, 0.7]} p={[-2, 0.5, z]} m={MAT.socket} />
        ))}
        {/* cooler */}
        <Anim
          f={(g) => {
            const v = smooth(clamp((pp('board') - 0.45) / 0.55));
            g.visible = v > 0.01;
            g.position.y = (1 - v) * 10;
          }}
        >
          <Ex lift={8}>
            <Clickable sel={{ kind: 'component', id: 'cooler', label: 'CPU cooler (heat pipes, fins, fan)' }}>
              <mesh geometry={GEO.box} material={MAT.lid} scale={[4, 0.6, 4]} position={[SX, 0.95, SZ]} />
              {[-1.2, -0.4, 0.4, 1.2].map((dx) => (
                <mesh key={dx} geometry={GEO.cyl} material={MAT.gold} scale={[0.3, 9, 0.3]} position={[SX + dx, 5.5, SZ]} />
              ))}
              {Array.from({ length: 28 }, (_, i) => (
                <mesh key={i} geometry={GEO.box} material={MAT.fin} scale={[12, 0.06, 7]} position={[SX, 2.6 + i * 0.32, SZ]} />
              ))}
              <mesh geometry={GEO.box} material={MAT.fan} scale={[0.6, 12, 12]} position={[SX + 6.3, 6.9, SZ]} />
            </Clickable>
          </Ex>
        </Anim>
      </Anim>
      {/* tower case */}
      <Anim
        f={(g) => {
          const v = k('system');
          g.visible = v > 0.01;
          g.scale.setScalar(lerp(0.9, 1, v));
        }}
      >
        <Clickable sel={{ kind: 'component', id: 'case', label: 'Computer case' }}>
          <Box s={[22, 47, 0.6]} p={[0, 23.5, -22.5]} m={MAT.caseMat} />
          <Box s={[22, 0.6, 46]} p={[0, 0.3, 0]} m={MAT.caseMat} />
          <Box s={[22, 0.6, 46]} p={[0, 47, 0]} m={MAT.caseMat} />
          <Box s={[0.6, 47, 46]} p={[-11, 23.5, 0]} m={MAT.caseMat} />
          <mesh geometry={GEO.box} material={MAT.glass} scale={[0.4, 46, 45]} position={[11, 23.5, 0]} />
          <Box s={[22, 47, 0.6]} p={[0, 23.5, 22.5]} m={MAT.caseMat} />
          <Box s={[16, 9, 14]} p={[0, 5.5, 13]} m={MAT.shroud} />
        </Clickable>
      </Anim>
    </group>
  );
}

/* ================================================================ GPU */

function Gpu() {
  const dieMats = useMemo(() => [MAT.si, MAT.si, new THREE.MeshStandardMaterial({ map: dieFloorplan('gpu'), roughness: 0.3, metalness: 0.35 }), MAT.si, MAT.si, MAT.si], []);
  const fan = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (fan.current) fan.current.children.forEach((c) => (c.rotation.y += dt * (pp('board') > 0.6 ? 12 : 0)));
  });
  const cards = [-12, -4, 4, 12];
  return (
    <group>
      <Anim
        f={(g) => {
          const s = k('socket');
          g.position.set(0, lerp(0, 0.32, s), 0);
          track('focus', 0, g.position.y, 0);
        }}
      >
        <Ex lift={3}>
          <Box s={[2.6, 0.08, 3.2]} p={[0, 0.25, 0]} m={dieMats} sel={{ id: 'pkg-die', label: 'GPU die (generic)' }} />
        </Ex>
        <Anim
          f={(g) => {
            const v = k('package');
            g.visible = v > 0.01;
            g.position.y = (1 - v) * -2;
          }}
        >
          <Box s={[6, 0.14, 5.5]} p={[0, 0.1, 0]} m={MAT.pcbDark} sel={{ id: 'pkg-substrate', label: 'Package substrate' }} />
          <Box s={[4.8, 0.08, 4]} p={[0, 0.2, 0]} m={MAT.si} sel={{ id: 'interposer', label: 'Silicon interposer' }} />
          {[
            [-1.85, -1.2],
            [-1.85, 1.2],
            [1.85, -1.2],
            [1.85, 1.2],
          ].map(([x, z], i) => (
            <Ex key={i} lift={3}>
              <Box s={[0.9, 0.5, 1.1]} p={[x, 0.5, z]} m={MAT.hbm} sel={{ id: 'hbm', label: 'HBM stack' }} />
            </Ex>
          ))}
        </Anim>
      </Anim>
      {/* graphics card */}
      <Anim
        f={(g) => {
          const v = k('socket');
          g.visible = v > 0.01;
          g.position.y = (1 - v) * -5;
          const sy = k('system');
          g.rotation.z = lerp(0, -Math.PI / 2, sy);
          g.position.x = lerp(0, -4, sy);
          g.position.y += lerp(0, 8, sy);
        }}
      >
        <Ex lift={-3}>
          <Box s={[26, 0.16, 11]} p={[0, 0, 0]} m={MAT.pcb} sel={{ id: 'gpu-card', label: 'Accelerator card PCB' }} />
          <Box s={[8, 0.1, 0.4]} p={[-4, -0.05, 5.6]} m={MAT.gold} />
        </Ex>
        <Clickable sel={{ kind: 'component', id: 'vrm', label: 'Power delivery (VRM)' }}>
          {Array.from({ length: 12 }, (_, i) => (
            <mesh key={i} geometry={GEO.box} material={MAT.chip} scale={[0.8, 0.45, 0.8]} position={[6 + (i % 6) * 1.1, 0.3, -3 + Math.floor(i / 6) * 1.2]} />
          ))}
        </Clickable>
        <Anim
          f={(g) => {
            const v = smooth(clamp((pp('board') - 0.3) / 0.7));
            g.visible = v > 0.01;
            g.position.y = (1 - v) * 8;
          }}
        >
          <Ex lift={6}>
            <Clickable sel={{ kind: 'component', id: 'cooler', label: 'Heatsink, vapour chamber & fans' }}>
              {Array.from({ length: 40 }, (_, i) => (
                <mesh key={i} geometry={GEO.box} material={MAT.fin} scale={[0.06, 2.6, 10]} position={[-12 + i * 0.6, 2.1, 0]} />
              ))}
              <mesh geometry={GEO.box} material={MAT.shroud} scale={[26, 0.6, 11]} position={[0, 3.7, 0]} />
              <group ref={fan}>
                {[-7, 0, 7].map((x) => (
                  <group key={x} position={[x, 4.05, 0]}>
                    <mesh geometry={GEO.cyl} material={MAT.fan} scale={[4.2, 0.12, 4.2]} />
                    {[0, 1, 2, 3, 4, 5, 6].map((b) => (
                      <mesh key={b} geometry={GEO.box} material={MAT.fanBlade} scale={[3.6, 0.1, 0.9]} position={[0, 0.1, 0]} rotation={[0.25, (b * Math.PI * 2) / 7, 0]} />
                    ))}
                  </group>
                ))}
              </group>
            </Clickable>
          </Ex>
        </Anim>
      </Anim>
      {/* server chassis with further accelerator cards */}
      <Anim
        f={(g) => {
          const v = k('system');
          g.visible = v > 0.01;
          g.position.y = (1 - v) * -4;
        }}
      >
        <Clickable sel={{ kind: 'component', id: 'case', label: 'Server chassis (accelerated computing)' }}>
          <Box s={[44, 0.6, 70]} p={[0, -0.6, -10]} m={MAT.caseMat} />
          <Box s={[0.6, 18, 70]} p={[-22, 8.4, -10]} m={MAT.caseMat} />
          <Box s={[0.6, 18, 70]} p={[22, 8.4, -10]} m={MAT.caseMat} />
          <Box s={[44, 18, 0.6]} p={[0, 8.4, -45]} m={MAT.caseMat} />
          {cards
            .filter((x) => x !== -4)
            .map((x) => (
              <group key={x} position={[x, 13, 0]} rotation={[0, 0, -Math.PI / 2]}>
                <mesh geometry={GEO.box} material={MAT.pcb} scale={[26, 0.16, 11]} />
                <mesh geometry={GEO.box} material={MAT.shroud} scale={[26, 3.6, 11]} position={[0, 2, 0]} />
              </group>
            ))}
          {Array.from({ length: 6 }, (_, i) => (
            <mesh key={i} geometry={GEO.cyl} material={MAT.fan} scale={[3, 0.6, 3]} position={[-17.5 + i * 7, 6, -40]} rotation={[Math.PI / 2, 0, 0]} />
          ))}
        </Clickable>
      </Anim>
    </group>
  );
}

export default function SystemScene() {
  const journey = useParam('journey');
  return (
    <>
      <Lighting env="office" shadowExtent={40} fogScale={8} />
      <mesh rotation-x={-Math.PI / 2} position={[0, -6.5, 0]} receiveShadow>
        <planeGeometry args={[400, 400]} />
        <meshStandardMaterial color="#2a312c" roughness={0.8} />
      </mesh>
      {journey === 1 ? <Gpu /> : <Cpu />}
      <pointLight position={[0, 30, 10]} intensity={900} distance={120} decay={2} color="#f2f5ee" />
      <TechLabel
        position={[-14, 16, 8]}
        title={journey === 1 ? 'GPU JOURNEY · ACCELERATED COMPUTING' : 'CPU JOURNEY · DESKTOP COMPUTER'}
        lines={['generic, educational layouts — not a specific product']}
        min={1}
        value={() => engine.player.view.phase.label}
      />
    </>
  );
}
