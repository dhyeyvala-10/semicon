'use client';
/**
 * Diffusion bay (§20, §32): a vertical oxidation furnace (batch, quartz boat, multi-zone
 * heater) and a single-wafer RTP chamber (lamp array, pyrometers).
 *   furnace: wafers load into the boat → boat rises into the tube → ramp → O₂ oxidation
 *            (Deal–Grove; oxide grows 56 % up / 44 % into the silicon) → anneal → cool → unload
 *   rtp:     lamps spike the wafer to ~1050 °C in seconds; dopants move onto lattice sites
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, CleanroomBay } from '../environments';
import { M, shell, effectiveView } from '../materials';
import { B, C, GEO, Pipe } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Inset, LiveProfile, FlowLine, rect } from '../parts/section';
import { FOUP, waferGeometry } from '../parts/wafer';
import { Screen, clear, plot, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { engine } from '@/simulation/engine';
import { pp, inPhase, pdt } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { rng, smooth, clamp, lerp } from '@/lib/math';
import { dealGrove, oxideColor, OXIDE_CONSUMPTION } from '@/simulation/models';

/* ================================================================ furnace */

const FX = -3;
const BOAT_N = 40;
const BOAT_PITCH = 0.026;
const BOAT_LOW = 0.5; // boat base height when lowered
const BOAT_HIGH = 2.05; // inside the tube
const FOLLOWED = 12; // slot of WF-000184 in the boat

const boatWaferMat = new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.12, metalness: 0.85, emissive: new THREE.Color('#ff5a1a'), emissiveIntensity: 0 });
const heaterGlow = new THREE.MeshStandardMaterial({ color: '#3a2a20', emissive: new THREE.Color('#ff6a1a'), emissiveIntensity: 0.2, side: THREE.BackSide, roughness: 0.8, toneMapped: false });

function boatY(furnace: boolean) {
  if (!furnace) return BOAT_LOW;
  const up = smooth(pp('raise'));
  const down = smooth(pp('unload'));
  return lerp(BOAT_LOW, BOAT_HIGH, up * (1 - down));
}

function Boat({ furnace }: { furnace: boolean }) {
  const group = useRef<THREE.Group>(null);
  const inst = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  useFrame(() => {
    const y = boatY(furnace);
    if (group.current) group.current.position.y = y;
    if (!inst.current) return;
    // wafers appear in the boat as the transfer robot loads them
    const n = furnace ? Math.floor(BOAT_N * clamp(pp('load') * 1.05)) : BOAT_N;
    for (let i = 0; i < BOAT_N; i++) {
      o.position.set(0, 0.06 + i * BOAT_PITCH, 0);
      o.scale.setScalar(i < n ? 1 : 0);
      o.updateMatrix();
      inst.current.setMatrixAt(i, o.matrix);
    }
    inst.current.instanceMatrix.needsUpdate = true;
    // oxide interference colour + thermal glow
    const tox = furnace ? engine.tele.value('tox', 0) : 55;
    const [r, g, b] = oxideColor(tox);
    boatWaferMat.color.setRGB(r, g, b);
    const T = furnace ? engine.tele.value('temp', 700) : 25;
    boatWaferMat.emissiveIntensity = clamp((T - 650) / 400) * 0.45;
    if (furnace && pp('raise') > 0 && pp('unload') < 1) track('focus', FX, y + 0.06 + FOLLOWED * BOAT_PITCH, 0);
    else if (furnace) track('focus', FX, BOAT_LOW + 0.6, 0.3);
  });
  const rods: [number, number][] = [
    [0.165, -0.02],
    [-0.165, -0.02],
    [0, -0.168],
  ];
  return (
    <group ref={group} position={[FX, BOAT_LOW, 0]}>
      <Clickable sel={{ kind: 'component', id: 'boat', machine: 'furnace', label: 'Quartz wafer boat' }}>
        <instancedMesh ref={inst} args={[waferGeometry(), boatWaferMat, BOAT_N]} castShadow />
        {rods.map(([x, z]) => (
          <C key={`${x}${z}`} r={0.008} h={BOAT_N * BOAT_PITCH + 0.1} m={M.quartz} position={[x, (BOAT_N * BOAT_PITCH + 0.1) / 2, z]} shadow={false} />
        ))}
        <C r={0.19} h={0.02} m={M.quartz} position={[0, 0.01, 0]} shadow={false} />
        <C r={0.19} h={0.02} m={M.quartz} position={[0, BOAT_N * BOAT_PITCH + 0.1, 0]} shadow={false} />
      </Clickable>
      {/* pedestal + door cap that seals the tube */}
      <C r={0.12} h={0.25} m={M.quartz} position={[0, -0.13, 0]} shadow={false} />
      <C r={0.31} h={0.05} m={M.steel} position={[0, -0.28, 0]} />
      <C r={0.05} h={2.4} m={M.steelDark} position={[0.42, -1.2 + 0.1, 0]} />
      <TechLabel position={[0.25, FOLLOWED * BOAT_PITCH + 0.06, 0.2]} title="WF-000184" min={2} show={() => furnace} />
    </group>
  );
}

function TransferRobot({ furnace }: { furnace: boolean }) {
  const arm = useRef<THREE.Group>(null);
  const t = useRef(0);
  useFrame((_, dt) => {
    t.current += pdt(dt);
    if (!arm.current) return;
    const loading = furnace && (inPhase('load') || inPhase('unload'));
    // shuttle between FOUP (+z) and boat (-x): one swing per wafer pair
    const s = loading ? 0.5 - 0.5 * Math.cos(t.current * 5) : 0;
    arm.current.rotation.y = lerp(-Math.PI / 2, Math.PI, s * 0.5 + 0.25);
    arm.current.position.y = 0.95 + (loading ? 0.25 * pp('load') : 0);
  });
  return (
    <Clickable sel={{ kind: 'component', id: 'transfer', machine: 'furnace', label: 'Wafer transfer robot' }}>
      <group position={[FX + 0.45, 0, 0.35]}>
        <C r={0.08} h={0.9} m={M.panel} position={[0, 0.45, 0]} />
        <group ref={arm} position={[0, 0.95, 0]}>
          <B s={[0.32, 0.04, 0.07]} m={M.alu} position={[0.16, 0, 0]} />
          <B s={[0.22, 0.008, 0.06]} m={M.ceramic} position={[0.38, 0.02, 0]} />
        </group>
      </group>
    </Clickable>
  );
}

function Furnace({ active }: { active: boolean }) {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  const view = effectiveView(viewRaw, cam);
  const light = useRef<THREE.PointLight>(null);
  const gas = useRef<THREE.Group>(null);
  useFrame(() => {
    const T = active ? engine.tele.value('temp', 700) : 650;
    heaterGlow.emissiveIntensity = clamp((T - 500) / 500) * 1.4;
    if (light.current) light.current.intensity = clamp((T - 600) / 400) * 2.2;
    if (gas.current) gas.current.visible = active && engine.tele.value('o2', 0) > 1;
  });
  const sh = (m: THREE.Material) => shell(m, view);
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'furnace', label: 'Vertical oxidation furnace' }}>
        {/* cabinet */}
        <B s={[1.4, 3.9, 0.04]} m={sh(M.panel)} position={[FX, 1.95, -0.65]} />
        <B s={[0.04, 3.9, 1.3]} m={sh(M.panel)} position={[FX - 0.7, 1.95, 0]} />
        <B s={[0.04, 3.9, 1.3]} m={sh(M.panel)} position={[FX + 0.7, 1.95, 0]} />
        <B s={[1.44, 0.05, 1.34]} m={sh(M.panelGrey)} position={[FX, 3.92, 0]} />
        <B s={[1.4, 1.95, 0.04]} m={sh(M.panel)} position={[FX, 2.93, 0.65]} />
        <mesh position={[FX, 0.95, 0.65]} material={M.glass}>
          <boxGeometry args={[1.3, 1.7, 0.01]} />
        </mesh>
        <B s={[1.42, 0.08, 0.06]} m={M.greenAccent} position={[FX, 1.92, 0.66]} />
        {/* heater jacket + tube */}
        <Clickable sel={{ kind: 'component', id: 'heater', machine: 'furnace', label: 'Multi-zone heater' }}>
          <mesh position={[FX, 2.8, 0]} material={sh(M.steelDark)}>
            <cylinderGeometry args={[0.38, 0.38, 1.7, 48, 1, true]} />
          </mesh>
          <mesh position={[FX, 2.8, 0]} material={heaterGlow}>
            <cylinderGeometry args={[0.31, 0.31, 1.66, 48, 1, true]} />
          </mesh>
          {[2.15, 2.6, 3.05, 3.5].map((y) => (
            <mesh key={y} position={[FX, y, 0]} rotation={[Math.PI / 2, 0, 0]} material={sh(M.steel)}>
              <torusGeometry args={[0.385, 0.012, 8, 48]} />
            </mesh>
          ))}
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'tube', machine: 'furnace', label: 'Quartz process tube' }}>
          <mesh position={[FX, 2.72, 0]} material={M.quartz}>
            <cylinderGeometry args={[0.23, 0.23, 1.45, 40, 1, true]} />
          </mesh>
          <mesh position={[FX, 3.445, 0]} material={M.quartz}>
            <sphereGeometry args={[0.23, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
          </mesh>
        </Clickable>
        <pointLight ref={light} position={[FX, 2.8, 0]} color="#ff7a2a" distance={2.4} decay={2} intensity={0} />
        {/* gas panel */}
        <Clickable sel={{ kind: 'component', id: 'gas-panel', machine: 'furnace', label: 'Gas panel (O₂ / H₂ / N₂)' }}>
          <B s={[0.5, 1.1, 0.4]} m={M.panelWarm} position={[FX - 1.05, 2.9, -0.3]} />
          {[0, 1, 2].map((i) => (
            <C key={i} r={0.03} h={0.12} m={M.steel} position={[FX - 1.05 + (i - 1) * 0.12, 3.5, -0.3]} />
          ))}
        </Clickable>
        <Pipe points={[[FX - 0.85, 3.3, -0.3], [FX - 0.4, 3.75, -0.3], [FX, 3.75, -0.1], [FX, 3.55, 0]]} radius={0.015} m={M.steel} />
        {/* elevator column + load port */}
        <Clickable sel={{ kind: 'component', id: 'elevator', machine: 'furnace', label: 'Boat elevator' }}>
          <B s={[0.12, 1.9, 0.12]} m={M.steelDark} position={[FX + 0.42, 0.95, -0.42]} />
        </Clickable>
        <B s={[0.5, 0.88, 0.48]} m={M.panelGrey} position={[FX + 0.35, 0.44, 0.98]} />
        <FOUP position={[FX + 0.35, 0.9, 0.98]} rotation={[0, Math.PI, 0]} />
        <SignalTower position={[FX + 0.55, 4.06, 0.5]} />
      </Clickable>
      <group ref={gas}>
        <FlowLine points={[[FX - 0.85, 3.3, -0.25], [FX - 0.4, 3.75, -0.25], [FX, 3.75, -0.05], [FX, 3.45, 0], [FX, 2.2, 0]]} color="#cfe3a8" speed={0.8} />
      </group>
      <Boat furnace={active} />
      <TransferRobot furnace={active} />
      <SensorIndicator id="thermocouple" channel={active ? 'temp' : undefined} machine="furnace" position={[FX + 0.39, 3.0, 0.1]} size={0.05} />
      <SensorIndicator id="mfc" channel={active ? 'o2' : undefined} machine="furnace" position={[FX - 1.05, 3.2, -0.08]} size={0.05} />
      <TechLabel position={[FX - 0.2, 3.75, 0.3]} title="QUARTZ TUBE · MULTI-ZONE HEATER" min={2} value={active ? () => `${engine.tele.value('temp', 0).toFixed(0)} °C · ${engine.player.view.phase.label}` : undefined} />
      <TechLabel position={[FX - 0.5, 1.3, 0.4]} title="QUARTZ BOAT" lines={[`${BOAT_N} wafers · batch process`]} min={3} />
    </group>
  );
}

/* --------------------------------------------- oxidation cross-section */

const OX_MPU = 200e-9 / 1.3;
const siLatMat = new THREE.MeshStandardMaterial({ color: '#9aa3ad', roughness: 0.4, metalness: 0.5 });
const siBulkMat = new THREE.MeshStandardMaterial({ color: '#6c747e', roughness: 0.5, metalness: 0.5 });
const oxMat = new THREE.MeshPhysicalMaterial({ color: '#c7dcc0', roughness: 0.2, metalness: 0, transparent: true, opacity: 0.55 });
const o2Mat = new THREE.MeshStandardMaterial({ color: '#d9775a', roughness: 0.4 });

function OxidationInset() {
  const toxU = () => (engine.tele.value('tox', 0) * 1e-9) / OX_MPU;
  const lattice = useRef<THREE.InstancedMesh>(null);
  const o2 = useRef<THREE.InstancedMesh>(null);
  const cols = 22;
  const rows = 7;
  const sp = 0.05;
  const o = useMemo(() => new THREE.Object3D(), []);
  const seeds = useMemo(() => {
    const r = rng(5);
    return Array.from({ length: 30 }, () => ({ x: r() - 0.5, o: r(), s: 0.6 + r() * 0.8, z: r() * 0.1 - 0.05 }));
  }, []);
  const t = useRef(0);
  useFrame((_, dt) => {
    t.current += pdt(dt);
    const tx = toxU();
    const interface_ = -OXIDE_CONSUMPTION * tx;
    if (lattice.current) {
      // silicon atoms above the moving interface have been consumed into the oxide
      let k = 0;
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const y = -0.02 - j * sp;
          o.position.set(-0.525 + i * sp, y, 0.095);
          o.scale.setScalar(y < interface_ - 0.01 ? 0.012 : 0);
          o.updateMatrix();
          lattice.current.setMatrixAt(k++, o.matrix);
        }
      lattice.current.instanceMatrix.needsUpdate = true;
    }
    if (o2.current) {
      const on = inPhase('oxidize');
      seeds.forEach((s, i) => {
        // O₂ arrives at the surface, diffuses through the oxide, reacts at the Si/SiO₂ interface
        const u = (t.current * 0.5 * s.s + s.o) % 1;
        const y = lerp(0.36, interface_ + 0.01, u);
        o.position.set(s.x + 0.01 * Math.sin(t.current * 6 + i), y, 0.1 + s.z * 0.2);
        o.scale.setScalar(on && y < 0.4 && y > interface_ ? 0.014 : 0);
        o.updateMatrix();
        o2.current!.setMatrixAt(i, o.matrix);
      });
      o2.current.instanceMatrix.needsUpdate = true;
    }
  });
  return (
    <Inset id="ox-section" position={[-0.9, 2.6, 0.75]} size={[1.3, 0.85]} mpu={OX_MPU} schematic={false} title="THERMAL OXIDATION · CROSS-SECTION">
      <group position={[0, 0.02, 0.05]} rotation={[0.16, -0.22, 0]}>
        <LiveProfile depth={0.16} m={siBulkMat} compute={() => rect(-0.55, -0.38, 0.55, -OXIDE_CONSUMPTION * toxU())} />
        <LiveProfile
          depth={0.17}
          m={oxMat}
          compute={() => {
            const tx = toxU();
            if (tx < 0.003) return null;
            return rect(-0.55, -OXIDE_CONSUMPTION * tx, 0.55, (1 - OXIDE_CONSUMPTION) * tx);
          }}
        />
        <instancedMesh ref={lattice} args={[GEO.sphereLow, siLatMat, cols * rows]} frustumCulled={false} />
        <instancedMesh ref={o2} args={[GEO.sphereLow, o2Mat, 30]} frustumCulled={false} />
        <Line points={[[-0.55, 0, 0.1], [0.55, 0, 0.1]]} color="#e9d27a" lineWidth={1.2} dashed dashSize={0.025} gapSize={0.018} />
      </group>
      <TechLabel position={[0.32, 0.06, 0.15]} title="ORIGINAL SURFACE" min={3} />
      <TechLabel position={[-0.62, 0.3, 0.15]} title="SiO₂" min={2} value={() => `${engine.tele.value('tox', 0).toFixed(1)} nm · 44 % below the original surface · SIMULATED`} />
      <TechLabel position={[-0.62, -0.3, 0.15]} title="Si (consumed at the interface)" min={3} />
    </Inset>
  );
}

function DealGroveScreen() {
  const curve = useMemo(() => Array.from({ length: 61 }, (_, i) => 1000 * dealGrove(i / 60, 1000)), []);
  return (
    <group position={[FX + 1.35, 0, -0.5]} rotation={[0, -0.25, 0]}>
      <C r={0.025} h={1.55} m={M.steelDark} position={[0, 0.78, 0]} />
      <Screen
        size={[0.7, 0.44]}
        position={[0, 1.75, 0.03]}
        hz={4}
        draw={(g, w, h) => {
          clear(g, w, h, 'DEAL–GROVE · DRY O₂ · 1000 °C · SIMULATED');
          const x = w * 0.08;
          const y = h * 0.36;
          const pw = w * 0.86;
          const ph = h * 0.52;
          plot(g, curve, x, y, pw, ph, 0, 80, SCR.dim);
          const hrs = pp('oxidize');
          const tox = engine.tele.value('tox', 0);
          g.fillStyle = SCR.accent;
          g.beginPath();
          g.arc(x + hrs * pw, y + ph - (tox / 80) * ph, h * 0.025, 0, Math.PI * 2);
          g.fill();
          bigNumber(g, 'OXIDE', tox.toFixed(1), 'nm', w * 0.08, h * 0.19, h * 0.09);
          bigNumber(g, 'TUBE', engine.tele.value('temp', 0).toFixed(0), '°C', w * 0.55, h * 0.19, h * 0.09);
          g.fillStyle = SCR.dim;
          g.font = `${Math.round(h * 0.05)}px monospace`;
          g.fillText('0 h', x, h * 0.97);
          g.fillText('1 h', x + pw - h * 0.08, h * 0.97);
        }}
      />
    </group>
  );
}

/* ================================================================ RTP */

const RX = 4;
const RTP_WAFER_Y = 1.05;
const lampMat = new THREE.MeshStandardMaterial({ color: '#fff1cf', emissive: new THREE.Color('#ffd28a'), emissiveIntensity: 0, roughness: 0.3, toneMapped: false });
const rtpWaferMat = new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.1, metalness: 0.85, emissive: new THREE.Color('#ff5a1a'), emissiveIntensity: 0, toneMapped: false });

function RTP({ active }: { active: boolean }) {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  const view = effectiveView(viewRaw, cam);
  const lamps = useMemo(() => {
    const pts: [number, number][] = [];
    for (let r = 0; r <= 4; r++) {
      const n = r === 0 ? 1 : r * 6;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        pts.push([Math.cos(a) * r * 0.042, Math.sin(a) * r * 0.042]);
      }
    }
    return pts;
  }, []);
  const lampRef = useRef<THREE.InstancedMesh>(null);
  const wafer = useRef<THREE.Mesh>(null);
  const light = useRef<THREE.PointLight>(null);
  useEffect(() => {
    if (!lampRef.current) return;
    const o = new THREE.Object3D();
    lamps.forEach(([x, z], i) => {
      o.position.set(x, 0, z);
      o.scale.set(0.016, 0.09, 0.016);
      o.updateMatrix();
      lampRef.current!.setMatrixAt(i, o.matrix);
    });
    lampRef.current.instanceMatrix.needsUpdate = true;
  }, [lamps]);
  useFrame(() => {
    const lamp = active ? engine.tele.value('lamp', 0) / 100 : 0;
    lampMat.emissiveIntensity = 0.1 + lamp * 3;
    if (light.current) light.current.intensity = lamp * 3;
    const T = active ? engine.tele.value('temp', 25) : 25;
    rtpWaferMat.emissiveIntensity = clamp((T - 600) / 450) * 1.2;
    if (wafer.current) {
      // slides in through the slit valve from the transfer side, out again at the end
      const inP = active ? smooth(pp('load')) : 0;
      const outP = active ? smooth(pp('unload')) : 0;
      const x = RX + 0.75 * (1 - inP) + 0.75 * outP;
      wafer.current.position.set(x, RTP_WAFER_Y, 0);
      wafer.current.visible = active;
      if (active) track('focus', x, RTP_WAFER_Y, 0);
    }
  });
  const sh = (m: THREE.Material) => shell(m, view);
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'rtp', label: 'Rapid thermal processing chamber' }}>
        {/* frame + body */}
        <B s={[1.4, 0.75, 1.0]} m={M.panelDark} position={[RX, 0.375, 0]} />
        <mesh position={[RX, 1.0, 0]} material={sh(M.steel)}>
          <cylinderGeometry args={[0.32, 0.32, 0.26, 48, 1, true]} />
        </mesh>
        <C r={0.33} h={0.04} m={M.steelDark} position={[RX, 0.86, 0]} />
        {/* lamp head */}
        <Clickable sel={{ kind: 'component', id: 'lamps', machine: 'rtp', label: 'Lamp array' }}>
          <mesh position={[RX, 1.32, 0]} material={sh(M.alu)}>
            <cylinderGeometry args={[0.34, 0.34, 0.28, 48, 1, true]} />
          </mesh>
          <C r={0.35} h={0.04} m={sh(M.panelGrey)} position={[RX, 1.47, 0]} />
          <instancedMesh ref={lampRef} args={[GEO.cylLow, lampMat, lamps.length]} position={[RX, 1.24, 0]} />
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'window', machine: 'rtp', label: 'Quartz window' }}>
          <mesh position={[RX, 1.16, 0]} material={M.quartz}>
            <cylinderGeometry args={[0.31, 0.31, 0.012, 48]} />
          </mesh>
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'edge-ring', machine: 'rtp', label: 'Edge ring' }}>
          <mesh position={[RX, RTP_WAFER_Y - 0.003, 0]} rotation={[-Math.PI / 2, 0, 0]} material={M.graphite}>
            <ringGeometry args={[0.145, 0.175, 48]} />
          </mesh>
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'pyrometers', machine: 'rtp', label: 'Pyrometers' }}>
          {[-0.1, 0, 0.1].map((x) => (
            <C key={x} r={0.012} h={0.08} m={M.black} position={[RX + x, 0.92, x === 0 ? 0.05 : -0.04]} />
          ))}
        </Clickable>
        {/* slit valve + transfer side */}
        <B s={[0.12, 0.2, 0.4]} m={sh(M.steelDark)} position={[RX + 0.38, 1.0, 0]} />
        <B s={[0.6, 0.3, 0.6]} m={M.panel} position={[RX + 0.95, 0.9, 0]} />
        <SignalTower position={[RX - 0.6, 0.75, 0.42]} />
      </Clickable>
      <mesh ref={wafer} geometry={waferGeometry()} material={rtpWaferMat} castShadow />
      <pointLight ref={light} position={[RX, 1.12, 0]} color="#ffcf8a" distance={1.6} decay={2} intensity={0} />
      <SensorIndicator id="pyrometer" channel={active ? 'temp' : undefined} machine="rtp" position={[RX + 0.12, 0.9, 0.2]} size={0.04} />
      <TechLabel position={[RX + 0.35, 1.5, 0.2]} title="LAMP ARRAY → WAFER" min={2} value={active ? () => `${engine.tele.value('temp', 0).toFixed(0)} °C · lamps ${engine.tele.value('lamp', 0).toFixed(0)} %` : undefined} />
    </group>
  );
}

/* ---------------------------------------- dopant activation (lattice) */

const ACT_MPU = 3e-9 / 1.2; // a few lattice constants
const siAtom = new THREE.MeshStandardMaterial({ color: '#9aa3ad', roughness: 0.4, metalness: 0.4 });
const dopAtom = new THREE.MeshStandardMaterial({ color: '#e0a64a', roughness: 0.35, emissive: new THREE.Color('#5a3a0a'), emissiveIntensity: 0.5 });

function ActivationInset() {
  const cols = 13;
  const rows = 7;
  const sp = 0.085;
  const si = useRef<THREE.InstancedMesh>(null);
  const dp = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const data = useMemo(() => {
    const r = rng(31);
    const jitter = Array.from({ length: cols * rows }, () => [r() - 0.5, r() - 0.5] as [number, number]);
    // dopants: start at interstitial positions, end on substitutional lattice sites
    const sites = [14, 18, 22, 29, 33, 41, 45, 50].map((k) => k % (cols * rows));
    const dop = sites.map((k) => ({ site: k, ix: (r() - 0.5) * sp, iy: (r() - 0.5) * sp }));
    return { jitter, dop };
  }, []);
  const pos = (k: number) => [-((cols - 1) * sp) / 2 + (k % cols) * sp, ((rows - 1) * sp) / 2 - Math.floor(k / cols) * sp] as const;
  useFrame(() => {
    const act = clamp(engine.tele.value('active', 0) / 100);
    const disorder = 1 - act; // implant damage heals as the lattice recrystallises
    if (si.current) {
      for (let k = 0; k < cols * rows; k++) {
        const [x, y] = pos(k);
        const row = Math.floor(k / cols);
        const dmg = row < 3 ? disorder * 0.5 * sp : 0;
        const occupied = data.dop.some((d) => d.site === k) && act > 0.6;
        o.position.set(x + data.jitter[k][0] * dmg, y + data.jitter[k][1] * dmg, 0);
        o.scale.setScalar(occupied ? 0 : 0.026);
        o.updateMatrix();
        si.current.setMatrixAt(k, o.matrix);
      }
      si.current.instanceMatrix.needsUpdate = true;
    }
    if (dp.current) {
      data.dop.forEach((d, i) => {
        const [x, y] = pos(d.site);
        const u = smooth(clamp((act - 0.15) / 0.6));
        o.position.set(x + sp / 2 + d.ix * 0.4 - (sp / 2 + d.ix * 0.4) * u, y + sp / 2 + d.iy * 0.4 - (sp / 2 + d.iy * 0.4) * u, 0.01);
        o.scale.setScalar(0.03);
        o.updateMatrix();
        dp.current!.setMatrixAt(i, o.matrix);
      });
      dp.current.instanceMatrix.needsUpdate = true;
    }
  });
  return (
    <Inset id="rtp-lattice" position={[5.85, 1.9, 0.65]} size={[1.2, 0.8]} mpu={ACT_MPU} title="DOPANT ACTIVATION · LATTICE (SCHEMATIC)">
      <instancedMesh ref={si} args={[GEO.sphereLow, siAtom, cols * rows]} frustumCulled={false} />
      <instancedMesh ref={dp} args={[GEO.sphereLow, dopAtom, data.dop.length]} frustumCulled={false} />
      <TechLabel position={[-0.58, -0.32, 0.05]} title="DOPANT → LATTICE SITE" min={2} value={() => `activation ${engine.tele.value('active', 0).toFixed(0)} % · SIMULATED`} />
    </Inset>
  );
}

function RtpScreen() {
  return (
    <group position={[RX + 1.3, 0, -0.6]} rotation={[0, -0.4, 0]}>
      <C r={0.025} h={1.25} m={M.steelDark} position={[0, 0.62, 0]} />
      <Screen
        size={[0.62, 0.4]}
        position={[0, 1.42, 0.03]}
        hz={5}
        draw={(g, w, h) => {
          clear(g, w, h, 'RTP · WAFER TEMPERATURE · SIMULATED');
          const c = engine.tele.get('temp');
          plot(g, c ? c.series().slice(-200) : [], w * 0.06, h * 0.38, w * 0.88, h * 0.5, 0, 1200, SCR.data);
          bigNumber(g, 'PYROMETER', engine.tele.value('temp', 0).toFixed(0), '°C', w * 0.06, h * 0.19, h * 0.1);
          bigNumber(g, 'ACTIVATION', engine.tele.value('active', 0).toFixed(0), '%', w * 0.56, h * 0.19, h * 0.1);
        }}
      />
    </group>
  );
}

/* ================================================================ scene */

export default function ThermalScene({ stage }: SceneProps) {
  const rtp = stage.variant === 'rtp';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0;
  }, []);
  return (
    <>
      <Lighting env="cleanroom" shadowExtent={7} />
      <CleanroomBay width={16} depth={9} height={4.4} />
      <Furnace active={!rtp} />
      <RTP active={rtp} />
      {!rtp && <OxidationInset />}
      {!rtp && <DealGroveScreen />}
      {rtp && <ActivationInset />}
      {rtp && <RtpScreen />}
      {/* neighbouring furnaces in the diffusion bay */}
      {[-5.2, -6.8].map((x) => (
        <group key={x}>
          <B s={[1.4, 3.9, 1.3]} m={M.panel} position={[x, 1.95, 0]} />
          <B s={[1.42, 0.08, 0.06]} m={M.greenAccent} position={[x, 1.92, 0.66]} />
          <SignalTower position={[x + 0.55, 4.06, 0.5]} />
        </group>
      ))}
      <Operator position={[0.6, 0, 1.8]} rotation={-Math.PI * 0.6} still />
    </>
  );
}
