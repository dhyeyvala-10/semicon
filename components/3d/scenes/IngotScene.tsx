'use client';
/**
 * Ingot → wafers (§13, §14): cropping, OD grinding, X-ray orientation + notch, and
 * multi-wire slicing. The same block is followed through every machine; slicing is
 * shown as a real geometric transformation (the block below the wire plane becomes
 * discrete wafers separated by kerf gaps), not a fade.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, Hall } from '../environments';
import { M, effectiveView } from '../materials';
import { B, C, GEO } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { waferGeometry, WAFER_T } from '../parts/wafer';
import { useUI } from '@/lib/store';
import { engine } from '@/simulation/engine';
import { pp, pdt, inPhase } from '@/lib/anim';
import { track, cutPlane } from '@/lib/runtime';
import { czRadiusAt, CZ_SEGMENTS, CZ_TOTAL, CZ_BODY_R } from '@/simulation/models';
import { smooth, clamp } from '@/lib/math';

const X = { crop: -8, grind: 0, saw: 9 };
const AXIS_Y = 1.15; // ingot axis height on the machines
const CROWN = CZ_SEGMENTS.neck + CZ_SEGMENTS.crown; // seed → start of body
const BODY = CZ_SEGMENTS.body;
const BLOCK = 0.36; // block that goes to the saw (m)
const R_GROUND = 0.15;

const rough = new THREE.MeshStandardMaterial({ color: '#767c84', roughness: 0.45, metalness: 0.85 });
const ground = new THREE.MeshStandardMaterial({ color: '#8c939b', roughness: 0.3, metalness: 0.88 });
const asCut = new THREE.MeshStandardMaterial({ color: '#70757b', roughness: 0.8, metalness: 0.45 });
const laser = new THREE.MeshBasicMaterial({ color: '#ff4a3a', transparent: true, opacity: 0.8, toneMapped: false });
const coolant = new THREE.MeshBasicMaterial({ color: '#d7e8de', transparent: true, opacity: 0.6 });
const wireMat = new THREE.MeshStandardMaterial({ color: '#c9c3b6', roughness: 0.3, metalness: 0.9 });

function lathePart(s0: number, s1: number) {
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, 0)];
  const n = 40;
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    pts.push(new THREE.Vector2(Math.max(0.001, czRadiusAt(s)), s - s0));
  }
  pts.push(new THREE.Vector2(0, s1 - s0));
  const g = new THREE.LatheGeometry(pts, 48);
  g.rotateZ(-Math.PI / 2); // axis along +x, s grows with x
  return g;
}

/* ------------------------------------------------------------ cropping */

function CropStation() {
  const cx = X.crop;
  const crownGeo = useMemo(() => lathePart(0, CROWN), []);
  const tailGeo = useMemo(() => lathePart(CROWN + BODY, CZ_TOTAL), []);
  const blade = useRef<THREE.Group>(null);
  const crown = useRef<THREE.Mesh>(null);
  const tail = useRef<THREE.Mesh>(null);
  const blocks = useRef<(THREE.Mesh | null)[]>([]);
  const x0 = cx - CZ_TOTAL / 2; // seed end
  const cutA = x0 + CROWN;
  const cutB = x0 + CROWN + BODY;
  const blockCuts = [cutA + BODY / 3, cutA + (2 * BODY) / 3];
  useFrame(() => {
    const active = engine.stage.id === 'ingot-shaping';
    const top = active ? pp('crop-top') : 1;
    const tl = active ? pp('crop-tail') : 1;
    const sec = active ? pp('section') : 1;
    // blade position: sweeps down at the active cut
    let bx = cutA;
    let depth = 0;
    if (active && inPhase('crop-top')) {
      bx = cutA;
      depth = top;
    } else if (active && inPhase('crop-tail')) {
      bx = cutB;
      depth = tl;
    } else if (active && inPhase('section')) {
      const k = sec < 0.5 ? 0 : 1;
      bx = blockCuts[k];
      depth = (sec * 2) % 1;
    }
    if (blade.current) {
      blade.current.position.x = bx;
      blade.current.position.y = AXIS_Y + 0.55 - depth * 1.1;
    }
    if (crown.current) {
      crown.current.position.set(x0 - smooth(clamp((top - 0.85) / 0.15)) * 0.5, AXIS_Y - smooth(clamp((top - 0.9) / 0.1)) * 0.6, 0);
      crown.current.visible = engine.stage.id === 'ingot-shaping' || engine.stage.id === 'ingot';
    }
    if (tail.current) {
      tail.current.position.set(cutB + smooth(clamp((tl - 0.85) / 0.15)) * 0.5, AXIS_Y - smooth(clamp((tl - 0.9) / 0.1)) * 0.6, 0);
      tail.current.visible = crown.current?.visible ?? true;
    }
    blocks.current.forEach((m, i) => {
      if (!m) return;
      const spread = smooth(clamp(sec * 2 - (i === 0 ? 0 : 1))) * 0.12;
      m.position.x = cutA + (i * BODY) / 3 + BODY / 6 + (i - 1) * spread;
      m.visible = active || engine.stage.id === 'ingot';
    });
    if (active) track('focus', cx, AXIS_Y, 0);
  });
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'ingot-grinder', label: 'Cropping band saw' }}>
        <B s={[3.4, 0.8, 1.1]} m={M.panel} position={[cx, 0.4, 0]} />
        {[-1.2, -0.4, 0.4, 1.2].map((dx) => (
          <group key={dx} position={[cx + dx, 0, 0]}>
            <B s={[0.16, 0.3, 0.5]} m={M.steelDark} position={[0, 0.95, 0]} />
            <mesh position={[0, 1.0, 0]} rotation={[0, 0, Math.PI / 4]} material={M.rubber}>
              <boxGeometry args={[0.12, 0.12, 0.42]} />
            </mesh>
          </group>
        ))}
        <group ref={blade}>
          <B s={[0.06, 1.6, 1.4]} m={M.yellow} position={[0, 0.5, -0.75]} />
          <B s={[0.06, 0.25, 1.4]} m={M.yellow} position={[0, 1.2, 0]} />
          <B s={[0.008, 1.0, 0.03]} m={M.steel} position={[0, 0.55, 0]} />
          <C r={0.12} h={0.08} m={M.steelDark} position={[0, 1.2, -0.75]} rotation={[0, 0, Math.PI / 2]} />
        </group>
      </Clickable>
      <mesh ref={crown} geometry={crownGeo} material={rough} castShadow />
      <mesh ref={tail} geometry={tailGeo} material={rough} castShadow />
      {[0, 1, 2].map((i) => (
        <mesh key={i} ref={(m) => { blocks.current[i] = m; }} position={[0, AXIS_Y, 0]} rotation={[0, 0, Math.PI / 2]} material={rough} castShadow>
          <cylinderGeometry args={[CZ_BODY_R, CZ_BODY_R, BODY / 3 - 0.004, 56]} />
        </mesh>
      ))}
      <TechLabel position={[cx - 1.2, AXIS_Y + 0.4, 0]} title="CROWN (SEED CONE) · RECYCLED" min={2} />
      <TechLabel position={[cx + 1.3, AXIS_Y + 0.4, 0]} title="TAIL · RECYCLED" min={2} />
      <TechLabel position={[cx, AXIS_Y + 0.65, 0.3]} title="BODY → 3 BLOCKS · BLOCK B FOLLOWED" min={2} tone="accent" />
    </group>
  );
}

/* ------------------------------------------------------------ OD grinding + notch */

function Grinder({ variant }: { variant: string }) {
  const cx = X.grind;
  const block = useRef<THREE.Group>(null);
  const groundPart = useRef<THREE.Mesh>(null);
  const roughPart = useRef<THREE.Mesh>(null);
  const wheel = useRef<THREE.Group>(null);
  const laserRef = useRef<THREE.Mesh>(null);
  const xbeam = useRef<THREE.Mesh>(null);
  const notch = useRef<THREE.Mesh>(null);
  const spray = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const ang = useRef(0);
  const L = BLOCK;
  useFrame((_, dt) => {
    const sid = engine.stage.id;
    const grinding = sid === 'ingot-grinding';
    const notching = sid === 'orientation-notch';
    const g = grinding ? pp('grind') : sid === 'orientation-notch' || sid === 'slicing' ? 1 : 0;
    const spin = grinding && inPhase('grind') ? 6 : notching && inPhase('xray') ? 0.8 : notching && inPhase('notch') ? 0 : 0;
    ang.current += pdt(dt) * spin;
    if (block.current) block.current.rotation.x = ang.current;
    // ground length follows the traversing wheel
    const gl = L * g;
    if (groundPart.current) {
      groundPart.current.visible = gl > 0.002;
      groundPart.current.scale.set(1, Math.max(0.001, gl), 1);
      groundPart.current.position.x = -L / 2 + gl / 2;
    }
    if (roughPart.current) {
      roughPart.current.visible = gl < L - 0.002;
      roughPart.current.scale.set(1, Math.max(0.001, L - gl), 1);
      roughPart.current.position.x = -L / 2 + gl + (L - gl) / 2;
    }
    if (wheel.current) {
      wheel.current.visible = grinding;
      wheel.current.position.x = cx - L / 2 + gl;
      wheel.current.rotation.x += pdt(dt) * 20;
    }
    if (laserRef.current) laserRef.current.visible = grinding && inPhase('measure');
    if (xbeam.current) xbeam.current.visible = notching && inPhase('xray');
    if (notch.current) {
      const n = notching ? pp('notch') : sid === 'slicing' ? 1 : 0;
      notch.current.visible = n > 0.01 && variant !== 'grind';
      notch.current.scale.set(Math.max(0.001, L * n), 1, 1);
      notch.current.position.x = -L / 2 + (L * n) / 2;
    }
    if (spray.current) {
      const on = grinding && inPhase('grind') && engine.player.playing;
      for (let i = 0; i < 30; i++) {
        const u = (engine.time * 1.5 + i / 30) % 1;
        o.position.set(cx - L / 2 + gl + (Math.sin(i * 7) * 0.04), AXIS_Y + 0.3 - u * 0.4, 0.2 + u * 0.05);
        o.scale.setScalar(on ? 0.012 : 0.0001);
        o.updateMatrix();
        spray.current.setMatrixAt(i, o.matrix);
      }
      spray.current.instanceMatrix.needsUpdate = true;
    }
    if (grinding || notching) track('focus', cx, AXIS_Y, 0);
  });
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'ingot-grinder', label: 'OD grinder / notch grinder' }}>
        <B s={[2.2, 0.9, 1.2]} m={M.panel} position={[cx, 0.45, -0.1]} />
        <B s={[2.2, 0.08, 0.5]} m={M.steelDark} position={[cx, 0.92, 0]} />
        <Clickable sel={{ kind: 'component', id: 'spindles', machine: 'ingot-grinder', label: 'Headstock & tailstock' }}>
          <B s={[0.35, 0.55, 0.45]} m={M.panelGrey} position={[cx - L / 2 - 0.3, 1.15, 0]} />
          <B s={[0.35, 0.45, 0.4]} m={M.panelGrey} position={[cx + L / 2 + 0.3, 1.1, 0]} />
          <C r={0.04} h={0.2} m={M.steel} position={[cx - L / 2 - 0.1, AXIS_Y, 0]} rotation={[0, 0, Math.PI / 2]} />
          <C r={0.04} h={0.2} m={M.steel} position={[cx + L / 2 + 0.1, AXIS_Y, 0]} rotation={[0, 0, Math.PI / 2]} />
        </Clickable>
        {/* enclosure back wall with window */}
        <B s={[2.2, 1.3, 0.06]} m={M.panel} position={[cx, 1.6, -0.62]} />
        <B s={[1.4, 0.7, 0.02]} m={M.glassDark} position={[cx, 1.55, -0.58]} />
        <SignalTower position={[cx + 1.0, 2.25, -0.6]} />
      </Clickable>
      <group position={[cx, AXIS_Y, 0]}>
        <group ref={block}>
          <Clickable sel={{ kind: 'wafer', id: 'ingot', label: 'Ingot block B (IG-0447)' }}>
            <mesh ref={groundPart} rotation={[0, 0, Math.PI / 2]} material={ground} castShadow>
              <cylinderGeometry args={[R_GROUND, R_GROUND, 1, 64]} />
            </mesh>
            <mesh ref={roughPart} rotation={[0, 0, Math.PI / 2]} material={rough} castShadow>
              <cylinderGeometry args={[CZ_BODY_R, CZ_BODY_R, 1, 64]} />
            </mesh>
            {/* orientation notch groove */}
            <mesh ref={notch} position={[0, R_GROUND - 0.0035, 0]} material={M.black}>
              <boxGeometry args={[1, 0.008, 0.008]} />
            </mesh>
          </Clickable>
        </group>
      </group>
      <group ref={wheel} position={[cx, AXIS_Y, 0.42]}>
        <Clickable sel={{ kind: 'component', id: 'grind-wheel', machine: 'ingot-grinder', label: 'Diamond grinding wheel' }}>
          <C r={0.24} h={0.05} m={M.steelDark} rotation={[0, 0, Math.PI / 2]} />
          <C r={0.25} h={0.03} m={M.graphite} rotation={[0, 0, Math.PI / 2]} />
          <B s={[0.1, 0.1, 0.4]} m={M.panelGrey} position={[0, 0, 0.25]} />
        </Clickable>
      </group>
      <instancedMesh ref={spray} args={[GEO.sphereLow, coolant, 30]} />
      {/* laser micrometer */}
      <Clickable sel={{ kind: 'component', id: 'gauge', machine: 'ingot-grinder', label: 'Laser diameter gauge' }}>
        <B s={[0.12, 0.12, 0.12]} m={M.panelDark} position={[cx, AXIS_Y + 0.28, 0]} />
        <B s={[0.12, 0.12, 0.12]} m={M.panelDark} position={[cx, AXIS_Y - 0.28, 0]} />
        <mesh ref={laserRef} position={[cx, AXIS_Y, 0]} material={laser} visible={false}>
          <boxGeometry args={[0.004, 0.5, 0.004]} />
        </mesh>
      </Clickable>
      {/* X-ray orientation unit */}
      {variant === 'notch' && (
        <Clickable sel={{ kind: 'component', id: 'xray', machine: 'ingot-grinder', label: 'X-ray orientation unit' }}>
          <B s={[0.3, 0.3, 0.3]} m={M.yellow} position={[cx + 0.1, AXIS_Y + 0.5, 0.35]} />
          <B s={[0.25, 0.2, 0.2]} m={M.panelDark} position={[cx + 0.1, AXIS_Y + 0.45, -0.4]} />
          <mesh ref={xbeam} position={[cx + 0.1, AXIS_Y + 0.33, 0.12]} rotation={[0.7, 0, 0]} visible={false}>
            <coneGeometry args={[0.03, 0.4, 12, 1, true]} />
            <meshBasicMaterial color="#c6e8a8" transparent opacity={0.35} depthWrite={false} />
          </mesh>
          <C r={0.12} h={0.03} m={M.steelDark} position={[cx - 0.12, AXIS_Y + R_GROUND + 0.05, 0]} rotation={[0, 0, Math.PI / 2]} />
        </Clickable>
      )}
      <SensorIndicator id="interferometer" channel="diam" machine="ingot-grinder" position={[cx + 0.12, AXIS_Y + 0.36, 0]} size={0.07} />
      <SensorIndicator id="torque-sensor" channel="load" machine="ingot-grinder" position={[cx + 0.2, AXIS_Y, 0.62]} size={0.07} />
      <TechLabel position={[cx, AXIS_Y + 0.55, 0.3]} title={variant === 'notch' ? 'X-RAY ORIENTATION → NOTCH' : 'OD GRINDING → Ø 300 mm'} value={() => (variant === 'notch' ? `orientation error ${engine.tele.value('orient', 0).toFixed(2)}° · notch ${engine.tele.value('depth', 0).toFixed(2)} mm` : `Ø ${engine.tele.value('diam', 300).toFixed(2)} mm · SIM`)} />
    </group>
  );
}

/* ------------------------------------------------------------ multi-wire saw */

/** Visual spacing is exaggerated (real pitch ≈ 1.1 mm) so individual wafers and kerf gaps are visible. */
const N_WAFERS = 64;
const PITCH = 0.0056;

function WireSaw() {
  const cx = X.saw;
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  const view = effectiveView(viewRaw, cam, 'normal');
  const wirePlaneY = 0.95;
  const span = N_WAFERS * PITCH; // block length along z
  // clipping: uncut block above the wire plane, slices below it
  const above = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), -wirePlaneY), []);
  const below = useMemo(() => new THREE.Plane(new THREE.Vector3(0, -1, 0), wirePlaneY), []);
  const blockMat = useMemo(() => {
    const m = ground.clone();
    m.clippingPlanes = [above];
    return m;
  }, [above]);
  const sliceMat = useMemo(() => {
    const m = asCut.clone();
    m.clippingPlanes = [below];
    return m;
  }, [below]);
  useEffect(() => {
    const planes = view === 'section' || view === 'cutaway' ? [cutPlane] : [];
    blockMat.clippingPlanes = [above, ...planes];
    sliceMat.clippingPlanes = [below, ...planes];
    blockMat.side = sliceMat.side = planes.length ? THREE.DoubleSide : THREE.FrontSide;
    blockMat.needsUpdate = sliceMat.needsUpdate = true;
  }, [view, blockMat, sliceMat, above, below]);

  const slices = useMemo(() => {
    const geo = new THREE.CylinderGeometry(R_GROUND, R_GROUND, WAFER_T * 1.0, 48);
    geo.rotateX(Math.PI / 2);
    const m = new THREE.InstancedMesh(geo, sliceMat, N_WAFERS);
    m.frustumCulled = false;
    return m;
  }, [sliceMat]);
  const wires = useMemo(() => {
    const m = new THREE.InstancedMesh(GEO.box, wireMat, N_WAFERS * 3);
    m.frustumCulled = false;
    return m;
  }, []);
  const stack = useMemo(() => {
    const m = new THREE.InstancedMesh(waferGeometry(), asCut, 40);
    m.frustumCulled = false;
    m.castShadow = true;
    return m;
  }, []);
  const blockGroup = useRef<THREE.Group>(null);
  const followed = useRef<THREE.Group>(null);
  const rollers = useRef<(THREE.Group | null)[]>([]);
  const slurry = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const wirePhase = useRef(0);

  // static wire web: top cutting span + two return spans to the lower roller
  useEffect(() => {
    const top = [-0.5, wirePlaneY - 0.001];
    const L = [-0.5, 0.42];
    const Rr = [0.5, 0.42];
    const tr = [0.5, wirePlaneY - 0.001];
    const seg = (i: number, a: number[], b: number[], z: number) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      o.position.set(cx + (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z);
      o.rotation.set(0, 0, Math.atan2(dy, dx));
      o.scale.set(Math.hypot(dx, dy), 0.0012, 0.0012);
      o.updateMatrix();
      wires.setMatrixAt(i, o.matrix);
    };
    for (let k = 0; k < N_WAFERS; k++) {
      const z = -span / 2 + k * PITCH;
      seg(k * 3, top, tr, z);
      seg(k * 3 + 1, tr, Rr, z);
      seg(k * 3 + 2, L, top, z);
    }
    wires.instanceMatrix.needsUpdate = true;
  }, [wires, cx, span, o]);

  useFrame((_, dt) => {
    const sid = engine.stage.id;
    const active = sid === 'slicing';
    const mount = active ? pp('mount') : 1;
    const cut = active ? pp('cut') : 1;
    const retract = active ? pp('retract') : 1;
    const sep = active ? pp('separate') : sid === 'slicing' ? 0 : 1;
    const depth = cut * (2 * R_GROUND + 0.01);
    // block descends through the web, then retracts upward with the sliced part attached
    const bottom = wirePlaneY + 0.003 - depth + retract * (2 * R_GROUND + 0.05) + (1 - mount) * 0.3;
    if (blockGroup.current) blockGroup.current.position.y = bottom + R_GROUND;
    // after retraction everything is sliced
    const allSliced = retract > 0.02;
    above.constant = allSliced ? -10 : -wirePlaneY;
    below.constant = allSliced ? 10 : wirePlaneY;
    // wafers: separate and fan out during the last phase
    for (let k = 0; k < N_WAFERS; k++) {
      const z = -span / 2 + k * PITCH;
      const fan = smooth(sep) * (k - N_WAFERS / 2) * 0.01;
      o.position.set(0, 0, z + fan);
      o.rotation.set(0, 0, 0);
      o.scale.setScalar(1);
      o.updateMatrix();
      slices.setMatrixAt(k, o.matrix);
    }
    slices.instanceMatrix.needsUpdate = true;
    // wire motion: reversing wire speed drives roller rotation
    const ws = active && inPhase('cut') ? engine.tele.value('wire', 0) : 0;
    wirePhase.current += pdt(dt) * ws;
    rollers.current.forEach((r) => {
      if (r) r.rotation.z = -wirePhase.current / 0.17;
    });
    if (slurry.current) {
      const on = active && inPhase('cut');
      for (let i = 0; i < 40; i++) {
        const u = (engine.time * 1.3 + i / 40) % 1;
        o.position.set(cx - 0.35 + (i % 8) * 0.1, 1.45 - u * 0.45, -span / 2 + ((i * 13) % 40) * (span / 40));
        o.scale.setScalar(on ? 0.008 : 0.0001);
        o.updateMatrix();
        slurry.current.setMatrixAt(i, o.matrix);
      }
      slurry.current.instanceMatrix.needsUpdate = true;
    }
    // followed wafer WF-000184 lifts out of the stack
    if (followed.current) {
      const lift = smooth(clamp((sep - 0.4) / 0.6));
      followed.current.visible = sep > 0.38 || sid !== 'slicing';
      followed.current.position.set(cx + 0.9 * lift, wirePlaneY + R_GROUND + 0.35 + lift * 0.25, 0.25 + lift * 0.1);
      followed.current.rotation.set(-Math.PI / 2 + lift * 1.1, 0, 0);
      if (sep > 0.38) track('focus', cx + 0.9 * lift, wirePlaneY + R_GROUND + 0.4, 0.3);
      else if (active) track('focus', cx, wirePlaneY + 0.1, 0);
    }
    // accumulated wafers in the output cassette
    for (let i = 0; i < 40; i++) {
      o.position.set(cx + 1.75, 0.95 + i * 0.008, -0.2);
      o.rotation.set(0, 0, 0);
      o.scale.setScalar(sep > i / 40 || sid !== 'slicing' ? 1 : 0.0001);
      o.updateMatrix();
      stack.setMatrixAt(i, o.matrix);
    }
    stack.instanceMatrix.needsUpdate = true;
  });

  const rollerPos: [number, number][] = [
    [-0.5, wirePlaneY - 0.17],
    [0.5, wirePlaneY - 0.17],
    [0, 0.42 - 0.17],
  ];
  return (
    <group>
      <Clickable sel={{ kind: 'machine', id: 'wire-saw', label: 'Multi-wire saw' }}>
        {/* frame */}
        <B s={[2.6, 0.25, 1.6]} m={M.panelGrey} position={[cx, 0.125, 0]} />
        <B s={[0.25, 2.6, 1.4]} m={M.panel} position={[cx - 1.2, 1.3, -0.1]} />
        <B s={[0.25, 2.6, 1.4]} m={M.panel} position={[cx + 1.2, 1.3, -0.1]} />
        <B s={[2.6, 0.3, 1.4]} m={M.panel} position={[cx, 2.45, -0.1]} />
        <B s={[2.2, 2.2, 0.08]} m={M.panel} position={[cx, 1.35, -0.78]} />
        {/* feed table + glue beam */}
        <Clickable sel={{ kind: 'component', id: 'feed-table', machine: 'wire-saw', label: 'Ingot feed table' }}>
          <group ref={blockGroup} position={[cx, 1.5, 0]}>
            <B s={[0.18, 0.06, span + 0.04]} m={M.glassDark} position={[0, R_GROUND + 0.03, 0]} />
            <B s={[0.4, 0.08, span + 0.1]} m={M.steelDark} position={[0, R_GROUND + 0.1, 0]} />
            <B s={[0.12, 0.9, 0.12]} m={M.steel} position={[0, R_GROUND + 0.55, 0]} />
            {/* uncut block (above wire plane) */}
            <mesh rotation={[Math.PI / 2, 0, 0]} material={blockMat}>
              <cylinderGeometry args={[R_GROUND, R_GROUND, span, 64]} />
            </mesh>
            <primitive object={slices} />
          </group>
        </Clickable>
        {/* grooved wire guides */}
        <Clickable sel={{ kind: 'component', id: 'wire-guides', machine: 'wire-saw', label: 'Grooved wire guides' }}>
          {rollerPos.map(([x, y], i) => (
            <group key={i} position={[cx + x, y + 0.17, 0]} ref={(g) => { rollers.current[i] = g; }}>
              <mesh rotation={[Math.PI / 2, 0, 0]} material={M.panelWarm}>
                <cylinderGeometry args={[0.17, 0.17, span + 0.08, 40]} />
              </mesh>
              <B s={[0.02, 0.34, span + 0.09]} m={M.steelDark} />
            </group>
          ))}
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'wire-web', machine: 'wire-saw', label: 'Wire web' }}>
          <primitive object={wires} />
        </Clickable>
        {/* spools and tension arms */}
        <Clickable sel={{ kind: 'component', id: 'spools', machine: 'wire-saw', label: 'Supply & take-up spools' }}>
          {[-0.75, 0.75].map((x) => (
            <C key={x} r={0.22} h={0.3} m={M.steel} position={[cx + x, 2.0, 0.55]} rotation={[Math.PI / 2, 0, 0]} />
          ))}
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'tension', machine: 'wire-saw', label: 'Tension control (dancer arms)' }}>
          <B s={[0.5, 0.04, 0.04]} m={M.yellow} position={[cx - 0.75, 1.7, 0.6]} rotation={[0, 0, 0.4]} />
          <B s={[0.5, 0.04, 0.04]} m={M.yellow} position={[cx + 0.75, 1.7, 0.6]} rotation={[0, 0, -0.4]} />
        </Clickable>
        <Clickable sel={{ kind: 'component', id: 'slurry', machine: 'wire-saw', label: 'Slurry / coolant nozzles' }}>
          <B s={[0.9, 0.05, span + 0.05]} m={M.steelDark} position={[cx, 1.48, 0]} />
        </Clickable>
        <SignalTower position={[cx + 1.2, 2.6, -0.5]} />
      </Clickable>
      <instancedMesh ref={slurry} args={[GEO.sphereLow, new THREE.MeshBasicMaterial({ color: '#9a9a8a' }), 40]} />
      {/* output cassette */}
      <B s={[0.36, 0.04, 0.36]} m={M.plastic} position={[cx + 1.75, 0.93, -0.2]} />
      <B s={[0.36, 0.9, 0.36]} m={M.panelGrey} position={[cx + 1.75, 0.45, -0.2]} />
      <primitive object={stack} />
      <group ref={followed} visible={false}>
        <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184 (as-cut)' }}>
          <mesh geometry={waferGeometry()} material={asCut} />
        </Clickable>
        <TechLabel position={[0, 0.02, 0.18]} title="WF-000184 · AS-CUT" min={1} tone="accent" show={() => engine.stage.id !== 'slicing' || pp('separate') > 0.38} />
      </group>
      <SensorIndicator id="wire-tension" channel="tension" machine="wire-saw" position={[cx - 0.75, 1.82, 0.62]} size={0.07} />
      <SensorIndicator id="torque-sensor" machine="wire-saw" position={[cx + 1.05, 1.0, 0.6]} size={0.07} />
      <TechLabel position={[cx, 2.85, 0]} title="MULTI-WIRE SAW · HUNDREDS OF CUTS AT ONCE" value={() => `wire ${engine.tele.value('wire', 0).toFixed(1)} m/s · tension ${engine.tele.value('tension', 0).toFixed(1)} N · depth ${engine.tele.value('depth', 0).toFixed(0)} mm`} />
      <TechLabel position={[cx + 0.62, wirePlaneY + 0.05, 0.3]} title="KERF · SCHEMATIC SPACING" lines={['real: ≈ 160 µm kerf per ≈ 1.1 mm pitch', '≈ 15 % of the silicon becomes sludge']} min={2} />
      <TechLabel position={[cx + 1.75, 1.4, -0.2]} title="AS-CUT WAFERS" min={2} />
    </group>
  );
}

export default function IngotScene({ stage }: SceneProps) {
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0;
  }, []);
  const variant = stage.variant ?? 'crop';
  const center = X[variant === 'slice' ? 'saw' : variant === 'crop' ? 'crop' : 'grind'];
  return (
    <>
      <Lighting env="hall" shadowExtent={8} center={[center, 0, 0]} />
      <Hall width={36} depth={18} height={9} />
      <CropStation />
      <Grinder variant={variant} />
      <WireSaw />
      <TechLabel position={[0, 0.05, 2.2]} title="INGOT IG-0447 → BLOCK B → WAFERS" min={2} />
    </>
  );
}

