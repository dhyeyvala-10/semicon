'use client';
/**
 * Atmospheric wafer robot model driven every frame by the RobotController state (§19).
 * base → lift column (Z) → θ rotation → link 1 (shoulder α) → link 2 (elbow −2α) → wrist → blade.
 * Each rigid body (base, hub, links, wrist) is a merged kit model: cast covers with inset
 * panels, seams, fasteners and joint caps, a handful of finishes per body, one mesh per finish
 * and one shadow caster per body, so the detail stays cheap.
 */
import * as THREE from 'three';
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { engine } from '@/simulation/engine';
import { ROBOT_GEOM, type RobotController } from '@/simulation/robot';
import { useUI } from '@/lib/store';
import { Clickable, TechLabel } from './interaction';
import { Wafer, ModelView, useModel } from './wafer';
import { fmt, deg } from '@/lib/math';
import { Kit, hose } from '../kit/build';
import { KM } from '../kit/finish';

const bladeMat = new THREE.MeshStandardMaterial({ color: '#f1efe9', roughness: 0.3, metalness: 0.05 });
const motorMat = new THREE.MeshStandardMaterial({ color: '#4b5560', roughness: 0.4, metalness: 0.7 });
const beltMat = new THREE.MeshStandardMaterial({ color: '#202224', roughness: 0.7 });

/** Unit lift-column bellows (radius 1, height 1, centred): scaled every frame, the folds compress with Z. */
const columnGeo = (() => {
  const folds = 16;
  const prof: THREE.Vector2[] = [];
  for (let i = 0; i <= folds * 2; i++) prof.push(new THREE.Vector2(i % 2 ? 1 : 0.86, -0.5 + i / (folds * 2)));
  return new THREE.LatheGeometry(prof, 32);
})();

type P2 = [number, number];
/** Link outline (x, z): rounded ends of radius r0 at x = 0 and r1 at x = len. */
function stadium(r0: number, r1: number, len: number, seg = 10): P2[] {
  const p: P2[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI / 2 + (i / seg) * Math.PI;
    p.push([Math.cos(a) * r0, Math.sin(a) * r0]);
  }
  for (let i = 0; i <= seg; i++) {
    const a = -Math.PI / 2 + (i / seg) * Math.PI;
    p.push([len + Math.cos(a) * r1, Math.sin(a) * r1]);
  }
  return p;
}
/** Extrude a plan outline (x, z) upward: occupies y0 … y0 + t (bevel included). */
function plan(k: Kit, m: THREE.Material, path: P2[], y0: number, t: number, o: { bevel?: number; shell?: boolean; cast?: boolean } = {}) {
  const b = o.bevel ?? 0;
  k.extrude(m, path.map(([x, z]) => [x, -z] as P2), Math.max(1e-4, t - 2 * b), [0, y0 + b, 0], [-Math.PI / 2, 0, 0], { bevel: b, shell: o.shell, cast: o.cast });
}

/**
 * Fixed base: cast housing with seam rings, top bezel with status ring, vent slots, connector
 * panel with cable exit, model plate, mounting flange; Z drive inside (x-ray).
 */
function buildBase(k: Kit) {
  const sh = { shell: true };
  const nc = { cast: false, ...sh };
  k.lathe(KM.paint, [[0.128, -0.432], [0.132, -0.428], [0.132, -0.13], [0.129, -0.113], [0.12, -0.1], [0.1, -0.092], [0.082, -0.09], [0.08, -0.1]], [0, 0, 0], [0, 0, 0], 48, sh);
  for (const y of [-0.38, -0.2]) k.torus(KM.seam, 0.1322, 0.0013, [0, y, 0], [0, 0, 0], 48, nc);
  k.torus(KM.ledGreen, 0.112, 0.0025, [0, -0.096, 0], [0, 0, 0], 40, nc);
  // vent slots on the back
  for (let i = 0; i < 7; i++) {
    const a = Math.PI * 0.82 + i * 0.075;
    k.box(KM.seam, [0.004, 0.11, 0.006], [Math.cos(a) * 0.131, -0.33, -Math.sin(a) * 0.131], [0, a, 0], nc);
  }
  // service-cover screws round the upper seam
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.31;
    k.cyl(KM.anodizedDark, 0.0035, 0.002, [Math.cos(a) * 0.1325, -0.188, Math.sin(a) * 0.1325], [0, -a, -Math.PI / 2], 8, nc);
  }
  // connector panel with cable exit toward the EFEM floor
  k.rbox(KM.paintGraphite, [0.014, 0.13, 0.1], 0.004, [-0.129, -0.33, 0.0], [0, 0, 0], sh);
  for (const [y, z] of [[-0.3, -0.025], [-0.3, 0.025], [-0.36, 0]] as const) k.cyl(KM.anodizedDark, 0.012, 0.02, [-0.142, y, z], [0, 0, Math.PI / 2], 16, sh);
  hose(k, [-0.15, -0.36, 0], [-0.32, -0.45, 0.22], 0.011, 0.04, KM.paintGraphite);
  hose(k, [-0.15, -0.3, 0.025], [-0.34, -0.45, 0.26], 0.007, 0.05, KM.paintGraphite);
  // model plate on a flat boss facing the window
  k.rbox(KM.paint, [0.075, 0.032, 0.012], 0.003, [0, -0.2, 0.127], [0, 0, 0], sh);
  k.label('model', 'WR-3', 'SCARA · 3-AXIS', 0.066, 0.022, [0, -0.2, 0.1335]);
  // mounting flange and bolts
  k.cyl(KM.anodizedDark, 0.145, 0.025, [0, -0.4475, 0], [0, 0, 0], 48, sh);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    k.cyl(KM.anodizedDark, 0.007, 0.006, [Math.cos(a) * 0.138, -0.432, Math.sin(a) * 0.138], [0, 0, 0], 6, nc);
  }
  // Z drive (visible in x-ray): servo with encoder, ball screw, guide rail
  k.cyl(motorMat, 0.035, 0.12, [0.06, -0.36, 0.05], [0, 0, 0], 24);
  k.cyl(motorMat, 0.032, 0.02, [0.06, -0.43, 0.05], [0, 0, 0], 24);
  k.cyl(KM.chrome, 0.008, 0.36, [0.06, -0.2, 0.05], [0, 0, 0], 12);
  k.box(KM.chrome, [0.02, 0.32, 0.012], [-0.06, -0.24, 0.06], [0, 0.5, 0]);
}

/** Shoulder hub (θ) with its motor and encoder. */
function buildHub(k: Kit) {
  const sh = { shell: true };
  k.lathe(KM.paint, [[0.07, -0.12], [0.085, -0.118], [0.087, -0.11], [0.087, -0.08], [0.083, -0.072], [0.075, -0.07], [0.0001, -0.07]], [0, 0, 0], [0, 0, 0], 48, sh);
  k.torus(KM.seam, 0.0875, 0.0012, [0, -0.1, 0], [0, 0, 0], 48, { cast: false, ...sh });
  k.cyl(motorMat, 0.04, 0.07, [0, -0.13, 0], [0, 0, 0], 28);
  k.cyl(motorMat, 0.036, 0.016, [0, -0.172, 0], [0, 0, 0], 28);
}

/** Arm link: cast cover with inset top panel, seam, screws and joint caps; belt drive inside (x-ray). */
function buildLink(k: Kit, len: number, r0: number, r1: number, t: number, beltW: number) {
  const sh = { shell: true };
  const nc = { cast: false, ...sh };
  plan(k, KM.paint, stadium(r0 - 0.003, r1 - 0.003, len), -t / 2, t, { bevel: 0.003, ...sh });
  // inset top cover: a dark groove round a slightly raised panel
  plan(k, KM.seam, stadium(r0 - 0.009, r1 - 0.009, len), t / 2 - 0.0004, 0.001, nc);
  plan(k, KM.paint, stadium(r0 - 0.012, r1 - 0.012, len), t / 2 - 0.0005, 0.0015, nc);
  // parting line of the two-piece cover along the side
  plan(k, KM.seam, stadium(r0 - 0.0028, r1 - 0.0028, len), -0.0006, 0.0012, nc);
  for (const x of [0.07, len / 2, len - 0.07]) {
    const r = r0 + ((r1 - r0) * x) / len - 0.018;
    for (const s of [-1, 1]) k.cyl(KM.anodizedDark, 0.0032, 0.0015, [x, t / 2 + 0.0015, s * r], [0, 0, 0], 8, nc);
  }
  for (const [x, r] of [[0, r0], [len, r1]] as const) {
    k.cyl(KM.anodizedDark, r * 0.58, 0.003, [x, t / 2 + 0.0018, 0], [0, 0, 0], 28, nc);
    k.torus(KM.seam, r * 0.58, 0.0012, [x, t / 2 + 0.0018, 0], [0, 0, 0], 28, nc);
    k.cyl(KM.anodizedDark, r * 0.2, 0.0014, [x, t / 2 + 0.0036, 0], [0, 0, 0], 16, nc);
    k.cyl(KM.anodizedDark, r * 0.58, 0.003, [x, -t / 2 - 0.0012, 0], [0, 0, 0], 28, nc);
    // pulleys of the internal belt drive
    k.cyl(beltMat, r * 0.7, t * 0.4, [x, 0, 0], [0, 0, 0], 24, { cast: false });
  }
  k.box(beltMat, [len, 0.006, beltW], [len / 2, 0, 0], [0, 0, 0], { cast: false });
}

/** Ceramic fork end effector (outline in x, z), wafer centre at x = Le. */
const BLADE: P2[] = [
  [0.008, 0], [0.012, -0.022], [0.07, -0.032], [0.2, -0.042], [0.334, -0.042], [0.345, -0.035], [0.345, -0.023], [0.334, -0.017], [0.27, -0.017], [0.245, -0.011],
  [0.245, 0.011], [0.27, 0.017], [0.334, 0.017], [0.345, 0.023], [0.345, 0.035], [0.334, 0.042], [0.2, 0.042], [0.07, 0.032], [0.012, 0.022],
];

/** Wrist: machined hub, blade clamp, ceramic fork with vacuum pads, channel and presence sensor. */
function buildWrist(k: Kit) {
  k.lathe(KM.anodized, [[0.028, -0.024], [0.03, -0.021], [0.03, -0.004], [0.027, -0.001], [0.0001, -0.001]], [0, 0, 0], [0, 0, 0], 32);
  k.torus(KM.seam, 0.0302, 0.001, [0, -0.012, 0], [0, 0, 0], 32, { cast: false });
  plan(k, bladeMat, BLADE, -0.00175, 0.0035);
  k.rbox(KM.anodizedDark, [0.046, 0.006, 0.05], 0.0018, [0.02, 0.0048, 0]);
  for (const z of [-0.014, 0.014]) k.cyl(KM.anodized, 0.003, 0.0015, [0.02, 0.0083, z], [0, 0, 0], 8, { cast: false });
  for (const [x, z] of [[0.12, 0], [0.27, 0.03], [0.27, -0.03]] as const) k.cyl(KM.seam, 0.008, 0.0042, [x, 0.0004, z], [0, 0, 0], 16, { cast: false });
  // vacuum channel to the pads
  k.box(KM.seam, [0.08, 0.0004, 0.0025], [0.08, 0.0018, 0], [0, 0, 0], { cast: false });
  for (const s of [-1, 1]) k.box(KM.seam, [0.07, 0.0004, 0.0025], [0.235, 0.0018, s * 0.03], [0, 0, 0], { cast: false });
  // wafer presence sensor and its cable along the blade root
  k.rbox(KM.anodizedDark, [0.014, 0.008, 0.014], 0.002, [0.05, 0.005, 0.03]);
  k.box(KM.anodizedDark, [0.03, 0.002, 0.003], [0.028, 0.0035, 0.03], [0, 0, 0], { cast: false });
}

export function RobotArm({ ctrl = engine.robot, position = [0, 0, 0] as [number, number, number], showWafer = true }: { ctrl?: RobotController; position?: [number, number, number]; showWafer?: boolean }) {
  const lift = useRef<THREE.Group>(null);
  const column = useRef<THREE.Mesh>(null);
  const rot = useRef<THREE.Group>(null);
  const link1 = useRef<THREE.Group>(null);
  const link2 = useRef<THREE.Group>(null);
  const wrist = useRef<THREE.Group>(null);
  const wafer = useRef<THREE.Mesh>(null);
  const view = useUI((s) => s.view);
  const explode = view === 'exploded' ? 1 : 0;
  const ex = useRef(0);
  const { L } = ROBOT_GEOM;
  // covers follow x-ray only (as before); cut-away does not apply to the robot
  const cover = view === 'xray' ? 'xray' : 'normal';
  const base = useModel(buildBase);
  const hub = useModel(buildHub);
  const l1 = useModel((k) => buildLink(k, L, 0.04, 0.04, 0.03, 0.05));
  const l2 = useModel((k) => buildLink(k, L, 0.036, 0.032, 0.028, 0.045));
  const wr = useModel(buildWrist, [], { shadow: false });

  useFrame((_, dt) => {
    ex.current += (explode - ex.current) * Math.min(1, dt * 4);
    const e = ex.current;
    const [th, , z] = ctrl.q;
    const j = ctrl.joints();
    if (lift.current) lift.current.position.y = z + e * 0.25;
    if (column.current) {
      const h = Math.max(0.02, z - 0.09 + 0.45);
      column.current.scale.set(0.075, h, 0.075);
      column.current.position.y = -0.45 + h / 2;
    }
    if (rot.current) rot.current.rotation.y = th;
    if (link1.current) {
      link1.current.rotation.y = j.j2;
      link1.current.position.y = -0.07 + e * 0.12;
    }
    if (link2.current) {
      link2.current.position.set(L * Math.cos(j.j2), -0.04 + e * 0.26, -L * Math.sin(j.j2));
      link2.current.rotation.y = -j.j2;
    }
    if (wrist.current) wrist.current.position.set(2 * L * Math.cos(j.j2), -0.004 + e * 0.4, 0);
    if (wafer.current) wafer.current.visible = showWafer && ctrl.waferLoc === 'effector';
    if (wafer.current) wafer.current.position.x = ROBOT_GEOM.Le - ctrl.slip;
  });

  return (
    <group position={position}>
      <Clickable sel={{ kind: 'robot', id: 'wafer-robot', label: 'Atmospheric wafer robot' }}>
        {/* fixed base with the Z drive inside */}
        <ModelView m={base} view={cover} />
        <mesh ref={column} geometry={columnGeo} material={KM.plastic} castShadow receiveShadow />
        <group ref={lift}>
          <group ref={rot}>
            {/* shoulder hub with θ motor */}
            <ModelView m={hub} view={cover} />
            <group ref={link1}>
              <ModelView m={l1} view={cover} />
            </group>
            <group ref={link2}>
              <ModelView m={l2} view={cover} />
            </group>
            <group ref={wrist}>
              {/* ceramic fork end effector */}
              <ModelView m={wr} />
              <Wafer ref={wafer} surface="polished" position={[ROBOT_GEOM.Le, 0.0025, 0]} />
            </group>
          </group>
        </group>
      </Clickable>
      <RobotLabels ctrl={ctrl} />
    </group>
  );
}

function RobotLabels({ ctrl }: { ctrl: RobotController }) {
  return (
    <>
      <TechLabel
        position={[0, -0.05, 0.22]}
        title="WAFER ROBOT · SIMULATION"
        min={3}
        value={() => {
          const j = ctrl.joints();
          return `θ ${fmt(deg(j.j1), 1)}°  J2 ${fmt(deg(j.j2), 1)}°  J3 ${fmt(deg(j.j3), 1)}°  Z ${fmt(ctrl.q[2] * 1000, 0)} mm`;
        }}
      />
      <TechLabel
        position={[0, 0.25, -0.3]}
        title="END EFFECTOR"
        min={3}
        value={() => {
          const p = ctrl.effector();
          return `X ${fmt(p.x * 1000, 0)} Y ${fmt(p.y * 1000, 0)} Z ${fmt(p.z * 1000, 0)} mm · ${fmt(ctrl.speed() * 1000, 0)} mm/s · VAC ${fmt(ctrl.vacuumKPa, 0)} kPa · ${ctrl.error ?? ctrl.stepLabel}`;
        }}
      />
    </>
  );
}
