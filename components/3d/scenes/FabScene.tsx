'use client';
/**
 * FAB 1 — the cleanroom digital factory (§2, §17, §53, §54, §60, §82, §85, §109).
 * Tools, lots and OHT vehicles are driven by the discrete-event FabSim; every lamp,
 * FOUP and vehicle you see corresponds to simulation state.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting } from '../environments';
import { M, STATE_COLOR, XRAY } from '../materials';
import { floorTile, plainTile, ffuPanel } from '../textures';
import { GEO, B } from '../parts/primitives';
import { Clickable, SensorIndicator, TechLabel } from '../parts/interaction';
import { FOUP } from '../parts/wafer';
import { Operator } from '../parts/people';
import { Screen, clear, plot, bigNumber, SCR } from '../parts/screens';
import { toolModel, matFor, towerPos } from '../fab/toolModels';
import { FabInfrastructure } from '../fab/FabInfrastructure';
import { TOOLS, BAYS, FAB, BAY_X, OHT_LOOP, localToWorld, type ToolType, type ToolInstance } from '@/data/fabLayout';
import { engine } from '@/simulation/engine';
import { loopPoint, PORT_HEIGHT, FAB_TIME_COMPRESSION } from '@/simulation/fab';
import { useUI } from '@/lib/store';
import { track, hoverState, cameraDriver } from '@/lib/runtime';
import { fmt, rng } from '@/lib/math';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const W = FAB.maxX - FAB.minX;
const D = FAB.maxZ - FAB.minZ;

/* ---------------------------------------------------------------- shell */

function FabShell() {
  const view = useUI((s) => s.view);
  const infra = useUI((s) => s.infrastructure);
  const bayFloor = useMemo(() => new THREE.MeshStandardMaterial({ map: floorTile([W / 0.6, D / 0.6]), color: '#a9aea8', roughness: 0.38, metalness: 0.2, transparent: true }), []);
  const spineFloor = useMemo(() => new THREE.MeshStandardMaterial({ map: plainTile([W / 0.6, 6 / 0.6], '#b9bdb7'), roughness: 0.3, metalness: 0.15, transparent: true }), []);
  useEffect(() => {
    const o = infra ? 0.18 : 1;
    bayFloor.opacity = o;
    spineFloor.opacity = o;
    bayFloor.depthWrite = !infra;
    spineFloor.depthWrite = !infra;
  }, [infra, bayFloor, spineFloor]);

  const ceil = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({ map: ffuPanel(), roughness: 0.85, side: THREE.DoubleSide });
    const cols = Math.floor(W / 1.2);
    const rows = Math.floor(D / 1.2);
    const m = new THREE.InstancedMesh(GEO.box, mat, cols * rows);
    const o = new THREE.Object3D();
    let i = 0;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        o.position.set(FAB.minX + 0.6 + c * 1.2, FAB.ceiling, FAB.minZ + 0.6 + r * 1.2);
        o.scale.set(1.17, 0.05, 1.17);
        o.updateMatrix();
        m.setMatrixAt(i++, o.matrix);
      }
    m.instanceMatrix.needsUpdate = true;
    return m;
  }, []);
  const strips = useMemo(() => {
    const n = Math.floor(D / 2.4);
    const m = new THREE.InstancedMesh(GEO.box, M.lightPanel, n);
    const o = new THREE.Object3D();
    for (let i = 0; i < n; i++) {
      o.position.set(0, FAB.ceiling - 0.04, FAB.minZ + 1.2 + i * 2.4);
      o.scale.set(W - 0.4, 0.035, 0.07);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
    return m;
  }, []);
  const amberStrips = useMemo(() => {
    const m = new THREE.InstancedMesh(GEO.box, M.lightAmber, 2 * 6);
    const o = new THREE.Object3D();
    let i = 0;
    for (const b of BAYS.filter((x) => x.light === 'amber'))
      for (let k = 0; k < 6; k++) {
        o.position.set(b.x - 6 + k * 2.4, FAB.ceiling - 0.05, b.side * 10);
        o.scale.set(0.08, 0.04, 13);
        o.updateMatrix();
        m.setMatrixAt(i++, o.matrix);
      }
    m.instanceMatrix.needsUpdate = true;
    return m;
  }, []);
  const inside = useRef(true);
  useFrame(({ camera }) => {
    const v = camera.position.y < FAB.ceiling - 0.05;
    if (v !== inside.current) {
      inside.current = v;
      ceil.visible = v;
      strips.visible = v;
      amberStrips.visible = v;
    }
  });
  const wallMat = view === 'xray' ? XRAY : M.panel;
  return (
    <group>
      <Clickable sel={{ kind: 'component', id: 'raised-floor', label: 'Perforated raised floor' }}>
        <mesh rotation-x={-Math.PI / 2} position={[0, 0, 0]} receiveShadow material={bayFloor}>
          <planeGeometry args={[W, D]} />
        </mesh>
      </Clickable>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.002, 0]} receiveShadow material={spineFloor}>
        <planeGeometry args={[W - 1, 5.6]} />
      </mesh>
      {/* walkway edge lines */}
      <B s={[W - 2, 0.003, 0.06]} m={M.safety} position={[0, 0.004, 2.8]} shadow={false} />
      <B s={[W - 2, 0.003, 0.06]} m={M.safety} position={[0, 0.004, -2.8]} shadow={false} />
      <Clickable sel={{ kind: 'component', id: 'ffu', label: 'Fan filter units (ceiling)' }}>
        <primitive object={ceil} />
      </Clickable>
      <primitive object={strips} />
      <primitive object={amberStrips} />
      {/* perimeter walls */}
      <B s={[W, FAB.ceiling, 0.15]} m={wallMat} position={[0, FAB.ceiling / 2, FAB.minZ]} />
      <B s={[W, FAB.ceiling, 0.15]} m={wallMat} position={[0, FAB.ceiling / 2, FAB.maxZ]} />
      <B s={[0.15, FAB.ceiling, D]} m={wallMat} position={[FAB.minX, FAB.ceiling / 2, 0]} />
      <B s={[0.15, FAB.ceiling, D]} m={wallMat} position={[FAB.maxX, FAB.ceiling / 2, 0]} />
      {/* chase walls between back-to-back tool rows */}
      {BAY_X.slice(0, -1).map((x) =>
        [1, -1].map((side) => (
          <B key={`${x}:${side}`} s={[0.12, FAB.ceiling, FAB.bayEnd - FAB.bayStart + 0.6]} m={wallMat} position={[x + 7, FAB.ceiling / 2, side * (FAB.bayStart + FAB.bayEnd) / 2]} />
        )),
      )}
      {/* structural columns along the spine */}
      {BAY_X.map((x) =>
        [3.1, -3.1].map((z) => <B key={`${x}:${z}`} s={[0.45, FAB.ceiling, 0.45]} m={M.panel} position={[x + 7, FAB.ceiling / 2, z]} />),
      )}
      {/* amber floor wash in litho bays (yellow-light zone) */}
      {BAYS.filter((b) => b.light === 'amber').map((b) => (
        <group key={b.id}>
          <pointLight position={[b.x, 3.6, b.side * 10]} color="#ffb24d" intensity={18} distance={16} decay={1.6} />
          <mesh rotation-x={-Math.PI / 2} position={[b.x, 0.006, b.side * 10]}>
            <planeGeometry args={[12, 13.4]} />
            <meshBasicMaterial color="#ffb24d" transparent opacity={0.06} depthWrite={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/* ---------------------------------------------------------------- tools */

const TYPES: ToolType[] = ['litho', 'etch', 'dep', 'furnace', 'implant', 'rtp', 'cmp', 'metro', 'wet', 'stocker'];

function ToolGroup({ type, tools }: { type: ToolType; tools: ToolInstance[] }) {
  const view = useUI((s) => s.view);
  const select = useUI((s) => s.select);
  const model = useMemo(() => toolModel(type, tools[0].length, tools[0].depth), [type, tools]);
  const meshes = useMemo(() => {
    const out: THREE.InstancedMesh[] = [];
    const o = new THREE.Object3D();
    for (const [k, geo] of model) {
      const mesh = new THREE.InstancedMesh(geo, matFor(k), tools.length);
      mesh.userData.matKey = k;
      tools.forEach((t, i) => {
        o.position.set(t.x, 0, t.z);
        o.rotation.set(0, t.rot, 0);
        o.updateMatrix();
        mesh.setMatrixAt(i, o.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = k !== 'glass' && k !== 'screen';
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      out.push(mesh);
    }
    return out;
  }, [model, tools]);
  useEffect(() => {
    for (const m of meshes) {
      const k = m.userData.matKey as string;
      const shellKey = k === 'panel' || k === 'panelWarm' || k === 'panelGrey' || k === 'louvre' || k === 'glass';
      m.material = view === 'xray' && shellKey ? XRAY : matFor(k as never);
    }
  }, [view, meshes]);

  // signal tower lamps (instanced, coloured from simulation state)
  const lamps = useMemo(() => {
    const m = new THREE.InstancedMesh(GEO.cyl, new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.9, roughness: 0.4, toneMapped: false }), tools.length);
    const o = new THREE.Object3D();
    tools.forEach((t, i) => {
      const [lx, ly, lz] = towerPos(type, t.length, t.depth);
      const w = localToWorld(t.x, t.z, t.rot, lx, lz);
      o.position.set(w.x, ly + 0.2, w.z);
      o.scale.set(0.045, 0.32, 0.045);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
      m.setColorAt(i, new THREE.Color('#5fbf5a'));
    });
    m.instanceMatrix.needsUpdate = true;
    return m;
  }, [tools, type]);
  const col = useMemo(() => new THREE.Color(), []);
  useFrame(({ clock }) => {
    const blink = Math.sin(clock.elapsedTime * 7) > 0;
    tools.forEach((t, i) => {
      const s = engine.fab.toolById[t.id]?.state ?? 'IDLE';
      const c = s === 'ALARM' && !blink ? '#3a1a18' : STATE_COLOR[s];
      lamps.setColorAt(i, col.set(c));
    });
    if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
  });

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const i = e.instanceId;
    if (i === undefined) return;
    select({ kind: 'tool', id: tools[i].id, label: tools[i].id });
  };
  const onOver = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const i = e.instanceId;
    if (i === undefined) return;
    const t = tools[i];
    hoverState.label = `${t.id} · ${engine.fab.toolById[t.id]?.state ?? ''}`;
    hoverState.kind = 'TOOL';
    hoverState.version++;
    document.body.style.cursor = 'pointer';
  };
  const onOut = () => {
    hoverState.label = '';
    hoverState.version++;
    document.body.style.cursor = '';
  };
  return (
    <group>
      {meshes.map((m, i) => (
        <primitive key={i} object={m} onClick={onClick} onPointerOver={onOver} onPointerOut={onOut} />
      ))}
      <primitive object={lamps} />
    </group>
  );
}

function Tools() {
  const groups = useMemo(() => TYPES.map((type) => ({ type, tools: TOOLS.filter((t) => t.type === type) })).filter((g) => g.tools.length), []);
  return (
    <>
      {groups.map((g) => (
        <ToolGroup key={g.type} type={g.type} tools={g.tools} />
      ))}
    </>
  );
}

/** Highlight: selected tool, tools in maintenance (barriers), traced path. */
function ToolOverlays() {
  const sel = useUI((s) => s.selection);
  const trace = useUI((s) => s.trace);
  const selTool = sel?.kind === 'tool' ? TOOLS.find((t) => t.id === sel.id) : undefined;
  const barrier = useMemo(() => {
    const m = new THREE.InstancedMesh(GEO.cone, M.yellow, TOOLS.length * 2);
    m.count = 0;
    return m;
  }, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  useFrame(() => {
    let n = 0;
    for (const t of TOOLS) {
      const s = engine.fab.toolById[t.id]?.state;
      if (s !== 'MAINTENANCE' && s !== 'ALARM') continue;
      for (const lz of [-t.length / 2 + 0.2, t.length / 2 - 0.2]) {
        const w = localToWorld(t.x, t.z, t.rot, 0.9, lz);
        o.position.set(w.x, 0.25, w.z);
        o.scale.set(0.12, 0.5, 0.12);
        o.rotation.set(Math.PI, 0, 0);
        o.updateMatrix();
        barrier.setMatrixAt(n++, o.matrix);
      }
    }
    barrier.count = n;
    barrier.instanceMatrix.needsUpdate = true;
  });
  // traced path of the followed lot
  const lot = engine.fab.followedLot();
  const pts = trace && lot ? lot.history.map((id) => engine.fab.toolById[id]?.def).filter(Boolean).map((t) => [t!.x, 0.15, t!.z] as [number, number, number]) : [];
  return (
    <group>
      <primitive object={barrier} />
      {selTool && <Footprint t={selTool} color="#c3d8a4" />}
      {trace && lot && lot.history.map((id, i) => {
        const t = engine.fab.toolById[id]?.def;
        return t ? <Footprint key={id + i} t={t} color="#e0c56e" /> : null;
      })}
      {pts.length > 1 && <Line points={pts} color="#e0c56e" lineWidth={2} dashed dashSize={0.6} gapSize={0.3} />}
    </group>
  );
}

function Footprint({ t, color }: { t: ToolInstance; color: string }) {
  const corners = [
    [0.6, -t.length / 2],
    [0.6, t.length / 2],
    [-t.depth, t.length / 2],
    [-t.depth, -t.length / 2],
    [0.6, -t.length / 2],
  ].map(([lx, lz]) => {
    const w = localToWorld(t.x, t.z, t.rot, lx, lz);
    return [w.x, 0.03, w.z] as [number, number, number];
  });
  return <Line points={corners} color={color} lineWidth={2.5} />;
}

/* ---------------------------------------------------------------- OHT */

function Rail() {
  const geo = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    const n = OHT_LOOP.length;
    for (let i = 0; i < n; i++) {
      const a = OHT_LOOP[i];
      const b = OHT_LOOP[(i + 1) % n];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const g = new THREE.BoxGeometry(len + 0.12, 0.1, 0.14);
      g.rotateY(Math.atan2(-(b[1] - a[1]), b[0] - a[0]));
      g.translate((a[0] + b[0]) / 2, FAB.ohtY + 0.14, (a[1] + b[1]) / 2);
      parts.push(g);
      // hangers
      const k = Math.floor(len / 3.5);
      for (let j = 0; j <= k; j++) {
        const t = k ? j / k : 0.5;
        const h = new THREE.BoxGeometry(0.03, FAB.ceiling - FAB.ohtY - 0.18, 0.03);
        h.translate(a[0] + (b[0] - a[0]) * t, (FAB.ceiling + FAB.ohtY + 0.18) / 2, a[1] + (b[1] - a[1]) * t);
        parts.push(h);
      }
    }
    return mergeAll(parts) ?? new THREE.BufferGeometry();
  }, []);
  return (
    <Clickable sel={{ kind: 'robot', id: 'oht', label: 'Overhead hoist transport (rail)' }}>
      <mesh geometry={geo} material={M.steelDark} />
    </Clickable>
  );
}

function mergeAll(parts: THREE.BufferGeometry[]) {
  return mergeGeometries(parts, false);
}

const vehBody = new THREE.MeshStandardMaterial({ color: '#e9eae6', roughness: 0.45, metalness: 0.15 });
const vehDark = new THREE.MeshStandardMaterial({ color: '#30353a', roughness: 0.5, metalness: 0.4 });

function Vehicles() {
  const N = engine.fab.vehicles.length;
  const { top, side, trolley, grip, belt } = useMemo(() => {
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.castShadow = true;
      m.frustumCulled = false;
      return m;
    };
    return {
      top: mk(GEO.box, vehBody, N),
      side: mk(GEO.box, vehBody, N * 2),
      trolley: mk(GEO.box, vehDark, N),
      grip: mk(GEO.box, vehDark, N),
      belt: mk(GEO.box, vehDark, N * 2),
    };
  }, [N]);
  const o = useMemo(() => new THREE.Object3D(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  useFrame(() => {
    const vs = engine.fab.vehicles;
    const stowY = FAB.ohtY - 0.62;
    vs.forEach((v, i) => {
      const p = loopPoint(v.s);
      q.setFromAxisAngle(up, p.dir);
      const set = (m: THREE.InstancedMesh, idx: number, lx: number, y: number, lz: number, sx: number, sy: number, sz: number) => {
        const off = new THREE.Vector3(lx, 0, lz).applyQuaternion(q);
        o.position.set(p.x + off.x, y, p.z + off.z);
        o.quaternion.copy(q);
        o.scale.set(sx, sy, sz);
        o.updateMatrix();
        m.setMatrixAt(idx, o.matrix);
      };
      set(top, i, 0, FAB.ohtY - 0.03, 0, 0.92, 0.16, 0.62);
      set(side, i * 2, 0, FAB.ohtY - 0.38, 0.3, 0.92, 0.55, 0.03);
      set(side, i * 2 + 1, 0, FAB.ohtY - 0.38, -0.3, 0.92, 0.55, 0.03);
      set(trolley, i, 0, FAB.ohtY + 0.1, 0, 0.6, 0.12, 0.2);
      const foupBottom = stowY - v.hoist * (stowY - PORT_HEIGHT);
      const gy = foupBottom + 0.38;
      set(grip, i, 0, gy, 0, 0.34, 0.03, 0.34);
      const len = Math.max(0.01, FAB.ohtY - 0.12 - gy);
      set(belt, i * 2, 0.12, gy + len / 2, 0, 0.012, len, 0.03);
      set(belt, i * 2 + 1, -0.12, gy + len / 2, 0, 0.012, len, 0.03);
    });
    for (const m of [top, side, trolley, grip, belt]) m.instanceMatrix.needsUpdate = true;
  });
  return (
    <Clickable sel={{ kind: 'robot', id: 'oht', label: 'OHT vehicle' }}>
      <primitive object={top} />
      <primitive object={side} />
      <primitive object={trolley} />
      <primitive object={grip} />
      <primitive object={belt} />
    </Clickable>
  );
}

/* ---------------------------------------------------------------- FOUPs */

const foupBodyMat = new THREE.MeshStandardMaterial({ color: '#c5ccd0', roughness: 0.35, metalness: 0.05, transparent: true, opacity: 0.85 });
function Foups() {
  const MAX = 48;
  const body = useMemo(() => {
    const m = new THREE.InstancedMesh(GEO.box, foupBodyMat, MAX);
    m.frustumCulled = false;
    m.castShadow = true;
    return m;
  }, []);
  const lid = useMemo(() => {
    const m = new THREE.InstancedMesh(GEO.box, M.foupDark, MAX);
    m.frustumCulled = false;
    return m;
  }, []);
  const followed = useRef<THREE.Group>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  useFrame(() => {
    let n = 0;
    for (const lot of engine.fab.lots) {
      if (lot.at.kind === 'tool') continue; // inside the tool
      const p = engine.fab.lotPosition(lot);
      if (lot.followed) {
        if (followed.current) {
          followed.current.visible = true;
          followed.current.position.set(p.x, p.y, p.z);
        }
        track('focus', p.x, p.y + 0.2, p.z);
        continue;
      }
      if (n >= MAX) break;
      o.position.set(p.x, p.y + 0.165, p.z);
      o.rotation.set(0, 0, 0);
      o.scale.set(0.39, 0.33, 0.34);
      o.updateMatrix();
      body.setMatrixAt(n, o.matrix);
      o.position.set(p.x, p.y + 0.36, p.z);
      o.scale.set(0.2, 0.03, 0.2);
      o.updateMatrix();
      lid.setMatrixAt(n, o.matrix);
      n++;
    }
    const fl = engine.fab.followedLot();
    if (fl && fl.at.kind === 'tool') {
      const p = engine.fab.lotPosition(fl);
      track('focus', p.x, p.y + 0.6, p.z);
      if (followed.current) followed.current.visible = false;
    }
    body.count = n;
    lid.count = n;
    body.instanceMatrix.needsUpdate = true;
    lid.instanceMatrix.needsUpdate = true;
  });
  return (
    <>
      <primitive object={body} />
      <primitive object={lid} />
      <group ref={followed}>
        <Clickable sel={{ kind: 'wafer', id: 'lot-foup', label: 'FOUP · LOT-A0731 (WF-000184 inside)' }}>
          <FOUP />
          <mesh position={[0, 0.002, 0]} rotation-x={-Math.PI / 2}>
            <ringGeometry args={[0.32, 0.36, 40]} />
            <meshBasicMaterial color="#c3d8a4" transparent opacity={0.9} />
          </mesh>
        </Clickable>
        <TechLabel position={[0, 0.55, 0]} title="LOT-A0731 · WF-000184" min={2} value={() => { const l = engine.fab.followedLot(); return l ? engine.fab.routeLabel(l) : ''; }} />
      </group>
    </>
  );
}

/* ---------------------------------------------------------------- airflow & particles */

function Airflow() {
  const N = 1400;
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(GEO.box, new THREE.MeshBasicMaterial({ color: '#d9f0c8', transparent: true, opacity: 0.4, depthWrite: false }), N);
    m.frustumCulled = false;
    return m;
  }, []);
  const seeds = useMemo(() => {
    const r = rng(5);
    return Array.from({ length: N }, () => ({ x: FAB.minX + 1 + r() * (W - 2), z: FAB.minZ + 1 + r() * (D - 2), o: r() * 10, v: 0.42 + r() * 0.1 }));
  }, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    seeds.forEach((s, i) => {
      const h = FAB.ceiling - 0.1;
      // laminar downflow at ~0.45 m/s (representative), faster visual
      const y = h - ((t * s.v * 3 + s.o * h) % h);
      o.position.set(s.x, y, s.z);
      o.scale.set(0.012, 0.32, 0.012);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  return (
    <group>
      <primitive object={mesh} />
      <TechLabel position={[-14, 4.2, 0]} title="LAMINAR DOWNFLOW · FFU → PERFORATED FLOOR" lines={['≈ 0.3–0.5 m/s (representative)', 'animation speed exaggerated']} min={1} tone="accent" />
    </group>
  );
}

/** Contaminant particles shed by an operator: swept away by downflow, or settling when FFUs stop. */
function Particles() {
  const ffuOn = useUI((s) => s.ffuOn);
  const N = 260;
  const src = useMemo(() => new THREE.Vector3(-14, 1.3, -1.2), []);
  const wafer = useMemo(() => new THREE.Vector3(-12.6, 0.95, -1.2), []);
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(GEO.sphereLow, new THREE.MeshBasicMaterial({ color: '#f2c75c' }), N);
    m.frustumCulled = false;
    return m;
  }, []);
  const state = useMemo(() => {
    const r = rng(9);
    return Array.from({ length: N }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), age: r() * 6, landed: false, r }));
  }, []);
  const landedCount = useRef(0);
  const o = useMemo(() => new THREE.Object3D(), []);
  useFrame((_, dt) => {
    let landed = 0;
    state.forEach((s, i) => {
      s.age += dt;
      if (s.age > 6 || s.p.y < 0) {
        s.age = 0;
        s.landed = false;
        s.p.set(src.x + (s.r() - 0.5) * 0.4, src.y + (s.r() - 0.5) * 0.8, src.z + (s.r() - 0.5) * 0.3);
        s.v.set((s.r() - 0.5) * 0.3, (s.r() - 0.5) * 0.1, (s.r() - 0.5) * 0.3);
      }
      if (!s.landed) {
        if (ffuOn) {
          s.v.y += (-0.45 - s.v.y) * Math.min(1, dt * 3);
          s.v.x *= 1 - dt * 2;
          s.v.z *= 1 - dt * 2;
        } else {
          s.v.x += (s.r() - 0.5) * dt * 0.6;
          s.v.z += (s.r() - 0.5) * dt * 0.6;
          s.v.y += ((s.r() - 0.52) * 0.2 - s.v.y * 0.5) * dt;
        }
        s.p.addScaledVector(s.v, dt);
        // landing on the open monitor wafer
        if (Math.abs(s.p.y - wafer.y) < 0.03 && Math.hypot(s.p.x - wafer.x, s.p.z - wafer.z) < 0.15) s.landed = true;
      }
      if (s.landed) landed++;
      o.position.copy(s.p);
      o.scale.setScalar(0.012);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
    });
    landedCount.current = landed;
    engine.ext.set('fab.particles', ffuOn ? 6 + landed : 60 + landed * 8);
    mesh.instanceMatrix.needsUpdate = true;
  });
  return (
    <group>
      <primitive object={mesh} />
      <Operator position={[-14, 0, -1.2]} rotation={Math.PI / 2} still />
      {/* monitor wafer on a cart */}
      <B s={[0.5, 0.9, 0.5]} m={M.steel} position={[wafer.x, 0.45, wafer.z]} />
      <mesh position={[wafer.x, wafer.y, wafer.z]}>
        <cylinderGeometry args={[0.15, 0.15, 0.002, 48]} />
        <meshStandardMaterial color="#8f97a3" metalness={0.9} roughness={0.08} />
      </mesh>
      <TechLabel
        position={[wafer.x, 1.35, wafer.z]}
        title={ffuOn ? 'FFU ON · PARTICLES SWEPT DOWN' : 'FFU OFF · PARTICLES DRIFT AND SETTLE'}
        min={1}
        tone={ffuOn ? 'accent' : 'warn'}
        value={() => `particles landed on monitor wafer: ${landedCount.current} · SIMULATED`}
      />
    </group>
  );
}

/* ---------------------------------------------------------------- displays */

function SpineScreens() {
  return (
    <>
      <Screen
        size={[2.4, 1.2]}
        position={[-7, 3.5, 2.9]}
        rotation={[0, Math.PI, 0]}
        hz={1}
        draw={(g, w, h) => {
          clear(g, w, h, 'FAB 1 · LIVE (SIMULATED)');
          const f = engine.fab;
          bigNumber(g, 'LOTS IN FAB', String(f.lots.length), 'lots', w * 0.04, h * 0.25, h * 0.13);
          bigNumber(g, 'UTILISATION', fmt(f.utilisation(), 0), '%', w * 0.36, h * 0.25, h * 0.13);
          bigNumber(g, 'MOVES / FAB-HOUR', fmt(f.movesPerHour(), 0), `×${FAB_TIME_COMPRESSION}`, w * 0.66, h * 0.25, h * 0.13);
          plot(g, f.series.util, w * 0.04, h * 0.58, w * 0.92, h * 0.34, 0, 100, SCR.data);
        }}
      />
      <Screen
        size={[2.4, 1.2]}
        position={[7, 3.5, -2.9]}
        hz={1}
        draw={(g, w, h) => {
          clear(g, w, h, 'EQUIPMENT STATUS (SIMULATED)');
          const c = engine.fab.stateCounts();
          const keys = Object.keys(c) as (keyof typeof c)[];
          keys.forEach((k, i) => {
            const y = h * 0.22 + i * h * 0.1;
            g.fillStyle = STATE_COLOR[k];
            g.fillRect(w * 0.04, y, (w * 0.6 * c[k]) / 40, h * 0.06);
            g.fillStyle = SCR.text;
            g.font = `${Math.round(h * 0.055)}px monospace`;
            g.fillText(`${k} ${c[k]}`, w * 0.68, y + h * 0.05);
          });
        }}
      />
    </>
  );
}

/* ---------------------------------------------------------------- intro camera */

function IntroCamera() {
  const started = useUI((s) => s.started);
  const controls = useThree((s) => s.controls) as unknown as OrbitControlsImpl | null;
  const camera = useThree((s) => s.camera);
  const pick = useRef(0);
  const look = useMemo(() => new THREE.Vector3(), []);
  const pos = useMemo(() => new THREE.Vector3(), []);
  useEffect(() => {
    cameraDriver.scene = !started;
    return () => {
      cameraDriver.scene = false;
    };
  }, [started]);
  useFrame((_, dt) => {
    if (started || !controls) return;
    // follow a vehicle carrying a FOUP through the cleanroom
    const vs = engine.fab.vehicles;
    let v = vs[pick.current];
    if (!v || (!v.carrying && vs.some((x) => x.carrying))) {
      const carrying = vs.findIndex((x) => x.carrying && (x.phase === 'toDrop'));
      if (carrying >= 0) pick.current = carrying;
      v = vs[pick.current];
    }
    const p = loopPoint(v.s);
    const ahead = loopPoint(v.s + 6);
    look.set(p.x, FAB.ohtY - 0.6, p.z);
    const dirx = ahead.x - p.x;
    const dirz = ahead.z - p.z;
    const len = Math.hypot(dirx, dirz) || 1;
    // camera trails behind and to the side, at standing height
    pos.set(p.x - (dirx / len) * 5.5 + (dirz / len) * 2.4, 2.4, p.z - (dirz / len) * 5.5 - (dirx / len) * 2.4);
    const k = Math.min(1, dt * 0.9);
    camera.position.lerp(pos, k);
    controls.target.lerp(look, Math.min(1, dt * 2));
    track('focus', p.x, FAB.ohtY - 0.6, p.z);
  });
  return null;
}

/* ---------------------------------------------------------------- scene */

const OPERATOR_PATHS: [number, number][][] = [
  [[-36, 0.6], [30, 0.6], [30, -0.6], [-36, -0.6]],
  [[-21, 4], [-21, 15], [-21.4, 15], [-21.4, 4]],
  [[7, -4], [7, -15], [6.6, -15], [6.6, -4]],
  [[21, 5], [21, 14], [20.6, 14], [20.6, 5]],
  [[-35, -5], [-35, -14], [-35.4, -14], [-35.4, -5]],
];

export default function FabScene(_props: SceneProps) {
  const airflow = useUI((s) => s.airflow);
  const particles = useUI((s) => s.particles);
  const infra = useUI((s) => s.infrastructure);
  const info = useUI((s) => s.info);
  const started = useUI((s) => s.started);
  return (
    <>
      <Lighting env="cleanroom" shadowExtent={46} />
      <FabShell />
      <Tools />
      <ToolOverlays />
      <Rail />
      <Vehicles />
      <Foups />
      {OPERATOR_PATHS.map((p, i) => (
        <Operator key={i} path={p} speed={1.0 + (i % 3) * 0.15} offset={i * 7} />
      ))}
      <SpineScreens />
      <SensorIndicator id="particle-counter" channel="particles" position={[-3.5, 1.4, 2.9]} size={0.12} />
      <SensorIndicator id="particle-counter" channel="particles" position={[18, 1.4, -2.9]} size={0.12} />
      <SensorIndicator id="humidity" position={[-28, 1.6, 3.1]} size={0.1} />
      {airflow && <Airflow />}
      {particles && <Particles />}
      {infra && <FabInfrastructure />}
      {info >= 2 &&
        started &&
        BAYS.map((b) => (
          <Html key={b.id} position={[b.x, 4.5, b.side * 9]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
            <div className="tlabel" style={{ transform: 'none', borderLeftColor: b.light === 'amber' ? '#ffb24d' : undefined }}>
              <div className="tlabel-title">{b.name}</div>
            </div>
          </Html>
        ))}
      <IntroCamera />
    </>
  );
}
