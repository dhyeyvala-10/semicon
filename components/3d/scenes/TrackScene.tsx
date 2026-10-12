'use client';
/**
 * Litho track (§24, §25, §27): spin coater, bake / chill plates and develop module on
 * one tool, under the yellow light of the lithography bay.
 *   coat:    dispense → spread → spin to thickness (∝ ω^-½) → edge-bead removal
 *   bake:    wafer onto proximity pins → solvent leaves the film → chill plate
 *   develop: PEB → developer puddle → exposed resist dissolves → rinse & spin dry
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, CleanroomBay } from '../environments';
import { M, effectiveView } from '../materials';
import { GEO } from '../parts/primitives';
import { Clickable, SensorIndicator, SignalTower, TechLabel } from '../parts/interaction';
import { Inset, LiveProfile, ProfileSlab, rect } from '../parts/section';
import { waferGeometry } from '../parts/wafer';
import { Screen, clear, plot, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { useFolded } from '../parts/cluster';
import { Kit, cabinet, boltCircle, grille, windowPane, estop, cableTray, type V3, type PartOpts } from '../kit/build';
import { KM, labelMaterial } from '../kit/finish';
import { Baked, useKit } from '../kit/Baked';
import { engine } from '@/simulation/engine';
import { pp, inPhase, pdt } from '@/lib/anim';
import { cutPlane, track } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { clamp, lerp, rng, smooth } from '@/lib/math';
import { spinThickness, exposureFields, WAFER_D, FIELD_W, FIELD_H } from '@/simulation/models';

const CX = -1.6; // coater
const BX = 0.5; // hot plate
const CHX = 1.15; // chill plate
const DX = 2.5; // developer
const WY = 1.0; // wafer height in the cups
const PLATE_Y = 0.962; // wafer height on the plate pins
const RAIL_Z = -0.42;

type Variant = 'coat' | 'bake' | 'develop';

/* ---------------------------------------------------------------- wafer path */

const V = new THREE.Vector3();
function waferPos(variant: Variant): THREE.Vector3 {
  if (variant === 'coat') {
    const inP = smooth(pp('load'));
    const outP = inPhase('stop') ? smooth(clamp((engine.player.view.phaseT - 0.55) / 0.45)) : 0;
    V.set(CX, lerp(1.12, WY, inP), lerp(RAIL_Z, 0, inP));
    if (outP > 0) V.set(lerp(CX, CX + 0.7, outP), lerp(WY, 1.12, Math.min(1, outP * 3)), lerp(0, RAIL_Z, outP));
    return V;
  }
  if (variant === 'bake') {
    const tr = smooth(pp('transfer'));
    const low = smooth(pp('lower'));
    const ch = smooth(pp('chill'));
    V.set(lerp(CX + 0.7, BX, tr), lerp(1.12, 1.05, tr), lerp(RAIL_Z, 0, tr));
    if (low > 0) V.y = lerp(1.05, PLATE_Y, low);
    if (ch > 0) {
      const lift = Math.sin(Math.PI * ch) * 0.09;
      V.set(lerp(BX, CHX, ch), PLATE_Y + lift, 0);
    }
    return V;
  }
  // develop
  const mv = inPhase('dispense') ? smooth(clamp(engine.player.view.phaseT / 0.35)) : pp('dispense') >= 1 ? 1 : 0;
  V.set(lerp(BX, DX, mv), PLATE_Y + Math.sin(Math.PI * mv) * 0.15 + (WY - PLATE_Y) * mv, 0);
  return V;
}

/* ---------------------------------------------------------------- textures */

const resistColor = new THREE.Color('#b5612a');

/** Wafer top for develop: resist with the exposed field pattern clearing as it dissolves. */
function useDevelopTexture() {
  return useMemo(() => {
    const size = 512;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const fields = exposureFields();
    let last = -1;
    const draw = (dissolve: number) => {
      const d = Math.round(dissolve * 50) / 50;
      if (d === last) return;
      last = d;
      const s = size / WAFER_D;
      g.clearRect(0, 0, size, size);
      g.fillStyle = '#9a5a2c';
      g.beginPath();
      g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      g.fill();
      for (const f of fields) {
        const x = size / 2 + (f.cx - FIELD_W / 2) * s;
        const y = size / 2 + (f.cy - FIELD_H / 2) * s;
        // latent image (exposed, not yet developed) is slightly lighter; developed spaces show the film below
        g.fillStyle = `rgba(216,150,80,${0.35 * (1 - d)})`;
        g.fillRect(x + 1, y + 1, FIELD_W * s - 2, FIELD_H * s - 2);
        g.fillStyle = `rgba(150,170,150,${0.85 * d})`;
        for (let k = 0; k < 6; k++) g.fillRect(x + 2 + k * ((FIELD_W * s - 4) / 6), y + 2, (FIELD_W * s - 4) / 12, FIELD_H * s - 4);
      }
      tex.needsUpdate = true;
    };
    draw(0);
    return { tex, draw };
  }, []);
}

/* ---------------------------------------------------------------- the wafer */

function TrackWafer({ variant }: { variant: Variant }) {
  const group = useRef<THREE.Group>(null);
  const spin = useRef<THREE.Group>(null);
  const film = useRef<THREE.Mesh>(null);
  const filmMat = useMemo(() => new THREE.MeshPhysicalMaterial({ color: resistColor, roughness: 0.18, metalness: 0, transparent: true, opacity: 0.9, clearcoat: 0.6 }), []);
  const dev = useDevelopTexture();
  const devMat = useMemo(() => new THREE.MeshStandardMaterial({ map: dev.tex, roughness: 0.25, metalness: 0.1, transparent: true }), [dev]);
  const waferMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f97a3', roughness: 0.08, metalness: 0.9 }), []);
  useFrame((_, dt) => {
    const p = waferPos(variant);
    if (group.current) group.current.position.copy(p);
    track('focus', p.x, p.y, p.z);
    // rotation: spin speed from telemetry (capped for display; real speed shown in the HUD)
    const rpm = variant === 'bake' ? 0 : engine.tele.value('rpm', 0);
    if (spin.current) spin.current.rotation.y += pdt(dt) * Math.min(rpm, 420) * 0.105;
    if (film.current) {
      if (variant === 'coat') {
        const spread = engine.player.view.phaseId === 'load' ? 0 : inPhase('dispense') ? 0.08 + 0.25 * engine.player.view.phaseT : inPhase('spread') ? lerp(0.33, 1, smooth(engine.player.view.phaseT)) : 1;
        const ebr = inPhase('ebr') ? smooth(engine.player.view.phaseT) : pp('ebr');
        film.current.visible = !inPhase('load');
        film.current.scale.setScalar(Math.max(0.01, spread * (1 - 0.02 * ebr)));
        // thick films look darker / more saturated; the final film shows a thin-film sheen
        const th = engine.tele.value('thick', 0);
        filmMat.opacity = clamp(0.55 + th / 3000, 0.55, 0.95);
        filmMat.color.copy(resistColor).offsetHSL(0, 0, clamp((800 - th) / 4000, -0.05, 0.12));
      } else if (variant === 'bake') {
        film.current.visible = true;
        film.current.scale.setScalar(0.98);
        filmMat.opacity = 0.9;
        filmMat.color.copy(resistColor).offsetHSL(0, 0, -0.03 * (1 - engine.tele.value('solvent', 25) / 25));
      } else {
        film.current.visible = true;
        film.current.scale.setScalar(0.98);
        dev.draw(clamp(engine.tele.value('dissolve', 0) / 100));
      }
    }
  });
  return (
    <group ref={group}>
      <group ref={spin}>
        <Clickable sel={{ kind: 'wafer', id: 'wafer', label: 'WF-000184' }}>
          <mesh geometry={waferGeometry()} material={waferMat} castShadow />
          <mesh ref={film} position={[0, 0.0006, 0]} rotation={[-Math.PI / 2, 0, 0]} material={variant === 'develop' ? devMat : filmMat}>
            <circleGeometry args={[0.15, 64]} />
          </mesh>
        </Clickable>
      </group>
    </group>
  );
}

/* ---------------------------------------------------------------- static detail (merged) */

const Z0: V3 = [0, 0, 0];
const RX: V3 = [0, 0, Math.PI / 2];
const RZ: V3 = [Math.PI / 2, 0, 0];
/** process deck (table top) height */
const DECK = 0.85;
/** process block from the carrier station to the interface block */
const X0 = -2.75;
const X1 = 3.45;
const XC = (X0 + X1) / 2;
const XW = X1 - X0;
/** roof canopy underside / top: above the story cameras' sightlines into the process block */
const ROOF = 2.5;
const ROOF_T = 2.62;
/** window mullions and door pulls, placed clear of the story camera paths and the preset sightlines */
const MULLIONS = [-0.35];
/** signal tower position (unchanged), carried on a bracket from the corner post */
const TOWER_LAMP: V3 = [-2.3, 2.02, 0.45];
const TOWERS = [-1.5, -0.4, 0.7, 1.8, 2.9];
const TOWER_TOP = 2.75;

/** bead-blasted aluminium (chill plate, bake lid): satin, partly diffuse */
const ALU = new THREE.MeshStandardMaterial({ color: '#c3c8cb', roughness: 0.78, metalness: 0.5, roughnessMap: KM.paint.roughnessMap });
/** lit diffuser under the roof FFUs (yellow-room lighting inside the process block) */
const LIT = new THREE.MeshStandardMaterial({ color: '#f1e3c4', emissive: new THREE.Color('#ffcf86'), emissiveIntensity: 0.32, roughness: 0.85 });

/** Label plate that can follow the shell (cut-away). */
function plate(k: Kit, kind: Parameters<typeof labelMaterial>[0], text: string, sub: string, w: number, h: number, pos: V3, rot: V3 = Z0, o: PartOpts = {}, accent?: string) {
  const g = new THREE.PlaneGeometry(w, h);
  k.add(labelMaterial(kind, text, sub, accent), g, pos, rot, [1, 1, 1], { cast: false, keepUV: true, ...o });
  g.dispose();
}

/** Load port of the carrier station (local +Z faces the operator, origin on the cabinet face). */
function carrierPort(k: Kit, n: number) {
  k.rbox(KM.paint, [0.5, 0.8, 0.4], 0.02, [0, 0.4, 0.2]);
  k.box(KM.seam, [0.5, 0.004, 0.402], [0, 0.3, 0.2], Z0, { cast: false });
  grille(k, 0.3, 0.12, [0, 0.16, 0.401], { m: KM.paint });
  k.rbox(ALU, [0.46, 0.03, 0.4], 0.006, [0, 0.815, 0.2]);
  for (const [x, z] of [[-0.12, 0.1], [0.12, 0.1], [0, 0.32]]) k.cyl(KM.stainless, 0.008, 0.014, [x, 0.836, z], Z0, 10, { cast: false });
  for (const x of [-0.17, 0.17]) k.rbox(KM.anodizedDark, [0.04, 0.02, 0.06], 0.004, [x, 0.84, 0.06]);
  // FIMS door on the cabinet face, operator buttons, status lamps
  k.box(KM.seam, [0.4, 0.36, 0.002], [0, 1.06, 0.001], Z0, { cast: false });
  k.rbox(KM.paintGrey, [0.38, 0.34, 0.02], 0.01, [0, 1.06, 0.01]);
  k.box(KM.anodizedDark, [0.3, 0.02, 0.012], [0, 1.17, 0.024], Z0, { cast: false });
  k.rbox(KM.plastic, [0.16, 0.06, 0.012], 0.005, [0, 0.72, 0.405]);
  k.cyl(KM.ledGreen, 0.01, 0.008, [-0.035, 0.72, 0.413], RZ, 12, { cast: false });
  k.cyl(KM.ledAmber, 0.01, 0.008, [0.035, 0.72, 0.413], RZ, 12, { cast: false });
  k.label('tag', `LP${n}`, 'E84 · FIMS', 0.1, 0.03, [0, 0.6, 0.4015]);
  k.ao(0.5, 0.42, [0, 0, 0.2], 1.25);
}

/** Lower cabinet with the chemical supply, deck, process towers, carrier station. */
function buildTrackStatic(k: Kit) {
  // lower cabinet (resist / developer supply, pumps, drains) under the process deck
  k.at([XC, 0, 0], 0, () =>
    cabinet(k, { size: [XW, DECK - 0.022, 1.2], body: KM.paint, trim: KM.paintGraphite, plinth: 0.08, panels: 8, rows: [0.32], sidePanels: 2, vent: true, handles: true, stripe: M.greenAccent, feet: false }),
  );
  k.box(KM.paintGrey, [XW - 0.02, 0.004, 1.18], [XC, DECK + 0.002, 0], Z0, { cast: false });
  const pw = XW / 8;
  const panel = (i: number) => X0 + (i + 0.5) * pw;
  k.label('model', 'CD-300', 'COAT · BAKE · DEVELOP TRACK · 300 mm', 0.4, 0.1, [X0 + 0.32, 0.66, 0.6025]);
  for (const [i, t, s, w] of [[1, 'RESIST SUPPLY', '6 × 4 L · N₂ PUSH', 'FLAMMABLE'], [2, 'SOLVENT', 'PGMEA · EBR · RINSE', 'FLAMMABLE'], [6, 'DEVELOPER', 'TMAH 2.38 % · 2 × 20 L', 'CORROSIVE'], [7, 'DI WATER', 'RINSE · BACKSIDE', '']] as const) {
    k.label('tag', t, s, 0.2, 0.05, [panel(i) - 0.08, 0.7, 0.6025]);
    if (w) k.label('warn', w, '', 0.07, 0.07, [panel(i) - 0.08, 0.59, 0.6025]);
    k.box(KM.seam, [0.034, 0.014, 0.003], [panel(i) + 0.1, 0.7, 0.6015], Z0, { cast: false });
    k.box(KM.ledGreen, [0.026, 0.007, 0.003], [panel(i) + 0.1, 0.7, 0.603], Z0, { cast: false });
  }
  // utility cabinet at the left end and the five process towers behind the deck
  k.at([(X0 + TOWERS[0] - 0.5) / 2, 0, -0.85], 0, () => {
    cabinet(k, { size: [TOWERS[0] - 0.5 - X0, TOWER_TOP, 0.5], body: KM.paint, trim: KM.paintGraphite, panels: 1, rows: [DECK, 1.6], sidePanels: 1, vent: false, handles: true, stripe: M.greenAccent, feet: false });
    grille(k, 0.4, 0.5, [0, 2.1, 0.252], { m: KM.paint });
    k.label('tag', 'POWER · CTRL', '400 V · 3 PH', 0.18, 0.045, [0, 1.25, 0.2525]);
    k.label('warn', 'HIGH VOLTAGE', '', 0.07, 0.07, [0, 1.42, 0.2525]);
  });
  const KINDS: [string, string][][] = [
    [['AD', 'HMDS · 90 °C'], ['CP', '23 °C'], ['HP', '110 °C'], ['HP', '110 °C'], ['TRS', 'TRANSFER']],
    [['HP', '110 °C'], ['HP', '110 °C'], ['CP', '23 °C'], ['CP', '23 °C'], ['BUF', 'BUFFER']],
    [['HP', '110 °C'], ['HP', '110 °C'], ['HP', '110 °C'], ['CP', '23 °C'], ['CP', '23 °C']],
    [['PEB', '120 °C'], ['PEB', '120 °C'], ['CP', '23 °C'], ['HP', '110 °C'], ['HP', '110 °C']],
    [['PEB', '120 °C'], ['CP', '23 °C'], ['HP', '110 °C'], ['HP', '110 °C'], ['BUF', 'BUFFER']],
  ];
  TOWERS.forEach((x, ti) => {
    k.at([x, 0, -0.85], 0, () => {
      const rows = [DECK, ...[0, 1, 2, 3].map((j) => 1.275 + j * 0.35)];
      cabinet(k, { size: [1.0, TOWER_TOP, 0.5], body: KM.paintWarm, trim: KM.paintGraphite, plinth: 0.08, panels: 1, rows, sidePanels: 1, vent: false, handles: false, stripe: M.greenAccent, feet: false, ao: false });
      const z = 0.2512;
      for (let j = 0; j < 5; j++) {
        const y = 1.1 + j * 0.35;
        const [kind, sub] = KINDS[ti][j];
        // wafer slot with its gate frame, status lamp and module tag
        k.rbox(KM.anodizedDark, [0.44, 0.07, 0.014], 0.005, [0, y - 0.03, z + 0.006]);
        k.box(KM.seam, [0.38, 0.026, 0.002], [0, y - 0.03, z + 0.0135], Z0, { cast: false });
        k.label('tag', `${kind}`, sub, 0.13, 0.034, [-0.34, y + 0.07, z]);
        k.box(kind === 'HP' || kind === 'PEB' ? KM.ledAmber : KM.ledGreen, [0.03, 0.008, 0.003], [0.38, y + 0.07, z + 0.001], Z0, { cast: false });
        k.cyl(KM.stainlessDark, 0.006, 0.004, [0.2, y + 0.07, z + 0.001], RZ, 8, { cast: false });
      }
      k.label('model', `BT-${ti + 1}`, ti === 0 ? 'COAT TOWER' : ti > 2 ? 'DEVELOP TOWER' : 'BAKE TOWER', 0.26, 0.065, [0, 2.56, z]);
      // service side (maintenance aisle): split panels, exhaust grille, fasteners, service tag
      k.at([0, 0, -0.2512], Math.PI, () => {
        for (const y of [DECK, 1.8]) k.box(KM.seam, [0.97, 0.004, 0.002], [0, y, 0], Z0, { cast: false });
        k.box(KM.seam, [0.004, TOWER_TOP - 0.12, 0.002], [0, TOWER_TOP / 2 + 0.04, 0], Z0, { cast: false });
        grille(k, 0.36, 0.3, [-0.24, 0.45, 0.001], { m: KM.paintWarm });
        for (const x of [-0.46, -0.04, 0.04, 0.46]) for (const y of [DECK + 0.04, 1.76, 1.84, TOWER_TOP - 0.04]) k.cyl(KM.stainlessDark, 0.0055, 0.004, [x, y, 0.001], RZ, 8, { cast: false });
        k.label('info', `BT-${ti + 1} SERVICE`, 'LOTO BEFORE OPENING', 0.2, 0.05, [0.24, 1.5, 0.001]);
      });
    });
    // filler panel to the next tower
    if (ti < TOWERS.length - 1) k.box(KM.paintGraphite, [0.1, TOWER_TOP - 0.1, 0.46], [x + 0.55, (TOWER_TOP - 0.1) / 2 + 0.05, -0.86]);
  });
  k.ao(XW + 0.6, 1.9, [XC - 0.15, 0, -0.25], 1.12);
  // tower tops: cable tray and exhaust ducts to the house exhaust in the ceiling
  cableTray(k, [X0 + 0.1, TOWER_TOP + 0.04, -0.85], [X1 - 0.1, TOWER_TOP + 0.04, -0.85], 0.3, 4);
  for (const x of [-0.95, 2.35]) {
    k.cyl(KM.stainless, 0.11, 0.02, [x, TOWER_TOP + 0.01, -0.7], Z0, 28);
    k.cyl(KM.paintGrey, 0.09, 4.2 - TOWER_TOP - 0.02, [x, (4.2 + TOWER_TOP) / 2, -0.7], Z0, 28);
    for (const y of [3.2, 3.8]) k.cyl(KM.stainless, 0.096, 0.02, [x, y, -0.7], Z0, 28);
    k.cyl(KM.anodizedDark, 0.03, 0.12, [x + 0.12, 3.0, -0.7], RX, 12);
    k.label('tag', 'EXHAUST', 'CUP · −80 Pa', 0.12, 0.03, [x, 3.0, -0.6085]);
  }
  // carrier station at the left end: two load ports facing −X, EMO, FFU grille
  k.at([X0 - 0.29, 0, 0], -Math.PI / 2, () => {
    cabinet(k, { size: [1.2, ROOF_T, 0.58], body: KM.paint, trim: KM.paintGraphite, panels: 2, rows: [0.95, 1.55], sidePanels: 1, vent: false, handles: false, stripe: M.greenAccent, feet: false });
    for (const [i, x] of [[1, -0.3], [2, 0.3]] as const) k.at([x, 0, 0.29], 0, () => carrierPort(k, i));
    estop(k, [0.48, 1.62, 0.29]);
    k.label('model', 'CD-300', 'CARRIER STATION', 0.3, 0.075, [-0.2, 1.75, 0.2925]);
    grille(k, 0.9, 0.1, [0, ROOF_T - 0.12, 0.292], { m: KM.paint });
  });
}

/** Process enclosure (follows the cut-away): framed sliding windows, roof canopy with FFUs, end panel. */
function buildTrackEnclosure(k: Kit) {
  const o = { shell: true };
  const zf = 0.6 - 0.0225;
  const posts = [X0 + 0.0225, ...MULLIONS, X1 - 0.0225];
  for (const x of posts) k.rbox(ALU, [0.04, ROOF - DECK, 0.045], 0.008, [x, (ROOF + DECK) / 2, zf], Z0, o);
  for (const x of [X0 + 0.0225, X1 - 0.0225]) k.rbox(ALU, [0.04, ROOF - DECK, 0.045], 0.008, [x, (ROOF + DECK) / 2, -0.5775], Z0, o);
  k.rbox(ALU, [XW, 0.04, 0.05], 0.006, [XC, DECK + 0.02, zf], Z0, o);
  for (let i = 0; i < posts.length - 1; i++) {
    const a = posts[i] + 0.0225;
    const b = posts[i + 1] - 0.0225;
    const h = ROOF - DECK - 0.04;
    // frameless sliding glass between the posts: top and bottom rails only
    const cx = (a + b) / 2;
    k.box(KM.glass, [b - a - 0.006, h - 0.05, 0.006], [cx, DECK + 0.04 + h / 2, zf], Z0, { ...o, cast: false });
    k.rbox(ALU, [b - a, 0.025, 0.03], 0.005, [cx, DECK + 0.0525, zf], Z0, o);
    k.rbox(ALU, [b - a, 0.025, 0.03], 0.005, [cx, ROOF - 0.0125, zf], Z0, o);
    // sliding-door pull
    k.rbox(KM.stainless, [0.02, 0.2, 0.026], 0.008, [a + 0.07, DECK + 0.62, zf + 0.026], Z0, o);
  }
  // signal tower bracket from the left corner post
  {
    const [tx, ty, tz] = TOWER_LAMP;
    const px = X0 + 0.0225;
    const dx = tx - px;
    const dz = tz - zf;
    k.rbox(ALU, [Math.hypot(dx, dz) + 0.03, 0.026, 0.03], 0.006, [(px + tx) / 2, ty - 0.013, (zf + tz) / 2], [0, -Math.atan2(dz, dx), 0], o);
    k.cyl(KM.anodizedDark, 0.034, 0.008, [tx, ty - 0.004, tz], Z0, 20, o);
  }
  // roof canopy with the fascia: seam, status strip, model plate
  k.rbox(KM.paint, [XW, ROOF_T - ROOF, 1.2], 0.012, [XC, (ROOF + ROOF_T) / 2, 0], Z0, o);
  k.box(LIT, [XW - 0.1, 0.004, 1.08], [XC, ROOF - 0.002, 0], Z0, { ...o, cast: false });
  for (let x = X0 + 1.2; x < X1 - 0.1; x += 1.2) k.box(KM.paint, [0.03, 0.006, 1.08], [x, ROOF - 0.004, 0], Z0, { ...o, cast: false });
  k.box(KM.seam, [XW - 0.03, 0.004, 0.002], [XC, ROOF + 0.03, 0.6012], Z0, { ...o, cast: false });
  for (const x of MULLIONS) k.box(KM.seam, [0.004, ROOF_T - ROOF - 0.03, 0.002], [x, (ROOF + ROOF_T) / 2 + 0.01, 0.6012], Z0, { ...o, cast: false });
  k.box(KM.seam, [0.62, 0.016, 0.003], [X0 + 0.45, ROOF + 0.085, 0.6015], Z0, { ...o, cast: false });
  k.box(KM.ledGreen, [0.6, 0.008, 0.003], [X0 + 0.45, ROOF + 0.085, 0.603], Z0, { ...o, cast: false });
  plate(k, 'model', 'CD-300', 'COAT / DEVELOP', 0.36, 0.09, [X1 - 0.4, ROOF + 0.07, 0.6015], Z0, o);
  // fan filter units on the roof
  for (const x of [-1.4, 0.45, 2.3]) {
    k.rbox(KM.paintGrey, [1.5, 0.11, 0.9], 0.01, [x, ROOF_T + 0.055, -0.08], Z0, o);
    k.at([x, ROOF_T + 0.111, -0.08], [-Math.PI / 2, 0, 0], () => grille(k, 1.3, 0.7, [0, 0, 0], { ...o, m: KM.paintGrey, pitch: 0.035 }));
    k.rbox(KM.paintGraphite, [0.22, 0.08, 0.16], 0.008, [x + 0.55, ROOF_T + 0.15, -0.38], Z0, o);
  }
  // left end panel with the pass-through from the carrier station
  k.box(KM.paint, [0.02, ROOF - DECK, 1.16], [X0 + 0.01, (ROOF + DECK) / 2, 0], Z0, o);
  k.box(KM.seam, [0.004, 0.06, 0.4], [X0 + 0.022, 1.0, -0.42], Z0, { ...o, cast: false });
  // interface block to the scanner (same footprint as before), orange interface band
  k.at([3.75, 0, 0], 0, () => {
    cabinet(k, { size: [0.6, 1.9, 1.2], body: KM.paint, trim: KM.paintGraphite, panels: 1, rows: [0.9], sidePanels: 2, vent: true, handles: false, stripe: false, shell: true, feet: false });
    k.box(M.orangeAccent, [0.612, 0.05, 1.212], [0, 1.7, 0], Z0, o);
    windowPane(k, 0.34, 0.34, [0, 1.3, 0.601], { ...o, glass: KM.glassSmoke });
    plate(k, 'model', 'IFB-1', 'SCANNER INTERFACE · WEE', 0.34, 0.085, [0, 1.56, 0.6015], Z0, o);
    plate(k, 'warn', 'LASER', '', 0.06, 0.06, [0.2, 1.05, 0.6015], Z0, o);
    // wafer tunnel to the scanner on the +X face: flange frame, bolted, with the transfer slot
    k.rbox(KM.paintGrey, [0.05, 0.42, 0.62], 0.01, [0.325, 1.12, 0], Z0, o);
    k.box(KM.seam, [0.004, 0.06, 0.4], [0.351, 1.12, 0], Z0, { ...o, cast: false });
    for (const y of [0.94, 1.3]) for (const z of [-0.27, 0, 0.27]) k.cyl(KM.stainlessDark, 0.006, 0.004, [0.351, y, z], RX, 8, { ...o, cast: false });
    plate(k, 'tag', 'TO SCANNER', 'WAFER TUNNEL · N₂ PURGED', 0.2, 0.05, [0.3512, 1.42, 0], [0, Math.PI / 2, 0], o);
  });
}

/** Spin cup bowl: a thick-walled cup with an inward splash lip (follows the cut-away). */
function buildBowl(k: Kit) {
  const prof: [number, number][] = [
    [0.212, 0.868], [0.232, 0.9], [0.244, 0.96], [0.244, 1.02], [0.232, 1.05], [0.207, 1.068], [0.184, 1.073],
    [0.182, 1.066], [0.2, 1.058], [0.224, 1.04], [0.234, 1.01], [0.234, 0.962], [0.223, 0.905], [0.204, 0.876], [0.212, 0.868],
  ];
  k.lathe(KM.plasticWhite, prof, Z0, Z0, 64, { shell: true });
}

/** Cup internals and surroundings (cup-local): base flange, spindle + chuck, inner cup, exhaust, nozzle post, home bath, EBR arm. */
function buildCupStatic(k: Kit, develop: boolean) {
  k.cyl(KM.paintGrey, 0.256, 0.02, [0, 0.86, 0], Z0, 56);
  boltCircle(k, 0.243, 12, 0.871, 0.006);
  k.cyl(KM.paintGrey, 0.206, 0.008, [0, 0.874, 0], Z0, 48);
  // spindle seal housing, shaft and vacuum chuck under the wafer
  k.lathe(KM.anodizedDark, [[0, 0.878], [0.062, 0.878], [0.062, 0.9], [0.036, 0.936], [0.02, 0.94], [0, 0.94]], Z0, Z0, 32);
  k.cyl(KM.stainless, 0.016, 0.05, [0, 0.965, 0], Z0, 16);
  k.cyl(KM.plastic, 0.056, 0.012, [0, 0.9925, 0], Z0, 40);
  k.torus(KM.seam, 0.04, 0.0016, [0, 0.9986, 0], Z0, 32, { cast: false });
  // inner splash cup
  k.lathe(KM.paintGrey, [[0.158, 0.915], [0.176, 0.92], [0.173, 0.972], [0.162, 0.976], [0.158, 0.915]], Z0, Z0, 48);
  // exhaust duct and drain from the cup bottom into the deck
  k.pipe(KM.plasticWhite, [[-0.16, 0.9, -0.16], [-0.25, 0.9, -0.25], [-0.25, DECK - 0.05, -0.25]], 0.03, 0.04);
  k.cyl(KM.plasticWhite, 0.04, 0.012, [-0.25, DECK + 0.006, -0.25], Z0, 20);
  // dispense arm post: base housing, column, rotary head and the PTFE supply lines
  k.at([0.32, 0, -0.18], 0, () => {
    k.rbox(KM.paint, [0.11, 0.08, 0.11], 0.01, [0, DECK + 0.04, 0]);
    k.rbox(KM.paintGraphite, [0.114, 0.008, 0.114], 0.003, [0, DECK + 0.084, 0]);
    k.box(KM.ledGreen, [0.02, 0.006, 0.003], [0, DECK + 0.05, 0.0562], Z0, { cast: false });
    k.cyl(ALU, 0.022, 0.21, [0, DECK + 0.088 + 0.105, 0], Z0, 20);
    k.cyl(KM.anodizedDark, 0.032, 0.022, [0, 1.147, 0], Z0, 24);
    for (const dz of [-0.012, 0, 0.012]) k.tube(dz ? KM.ptfe : KM.paintBlue, [[0.026, 1.14, dz], [0.06, 1.08, dz], [0.058, 0.99, dz], [0.04, DECK + 0.09, dz]], 0.0035, { radial: 6, tension: 0.4 });
  });
  // nozzle home bath (solvent atmosphere) under the arm's rest position
  k.rbox(KM.plasticWhite, [0.08, 1.1 - DECK, 0.08], 0.01, [0.335, (DECK + 1.1) / 2, 0.187]);
  k.cyl(KM.seam, 0.024, 0.004, [0.335, 1.1, 0.187], Z0, 16, { cast: false });
  // edge-bead removal (coater) / backside rinse (developer) nozzle on a short fixed arm
  k.at([-0.33, 0, -0.1], 0, () => {
    k.rbox(KM.paint, [0.07, 0.06, 0.07], 0.008, [0, DECK + 0.03, 0]);
    k.cyl(ALU, 0.013, 1.1 - DECK - 0.06, [0, (DECK + 0.06 + 1.1) / 2, 0], Z0, 14);
  });
  const nx = -0.1426;
  const nz = -0.0432;
  k.rbox(KM.paint, [0.205, 0.016, 0.022], 0.006, [(nx - 0.33) / 2, 1.1, (nz - 0.1) / 2], [0, -Math.atan2(nz + 0.1, nx + 0.33), 0]);
  k.cyl(KM.ptfe, 0.005, 0.05, [nx, 1.07, nz], Z0, 10);
  k.cyl(KM.plastic, 0.004, 0.012, [nx, 1.041, nz], Z0, 8);
  k.label('tag', develop ? 'DEV 1' : 'COT 1', develop ? 'PUDDLE · RINSE' : 'SPIN COAT · EBR', 0.12, 0.03, [0.335, DECK + 0.13, 0.2272]);
}

/** Dispense arm (arm-local, rotates about the post): hub, white beam, three-nozzle head, PTFE lines. */
function buildDispenseArm(k: Kit) {
  k.cyl(KM.anodizedDark, 0.03, 0.03, Z0, Z0, 24);
  k.cyl(KM.stainlessDark, 0.012, 0.006, [0, 0.018, 0], Z0, 12, { cast: false });
  k.rbox(KM.paint, [0.36, 0.024, 0.034], 0.008, [-0.17, 0, 0.09], [0, 0.48, 0]);
  k.box(KM.seam, [0.34, 0.002, 0.0352], [-0.17, -0.004, 0.09], [0, 0.48, 0], { cast: false });
  k.rbox(ALU, [0.045, 0.03, 0.066], 0.006, [-0.32, -0.006, 0.18], [0, 0.48, 0]);
  const px = Math.sin(0.48) * 0.02;
  const pz = Math.cos(0.48) * 0.02;
  for (const s of [-1, 0, 1]) {
    const x = -0.32 + s * px;
    const z = 0.18 + s * pz;
    k.cyl(KM.ptfe, 0.006, 0.03, [x, -0.035, z], Z0, 12);
    k.cyl(KM.plastic, 0.0045, 0.01, [x, -0.047, z], Z0, 10);
    k.tube(KM.ptfe, [[x, 0.01, z], [-0.17 + s * px * 0.5, 0.016, 0.09 + s * pz * 0.5], [-0.03, 0.016, 0.015 + s * 0.006], [0, 0.02, 0]], 0.0032, { radial: 6, tension: 0.4 });
  }
  k.box(KM.ledGreen, [0.003, 0.006, 0.014], [-0.32 + Math.cos(0.48) * 0.0228, 0.002, 0.18 - Math.sin(0.48) * 0.0228], [0, 0.48, 0], { cast: false });
}

/** Bake or chill plate module on the deck (world coords): housing, plate, pins, guide rods, water. */
function buildPlateModule(k: Kit, hot: boolean) {
  k.at([hot ? BX : CHX, 0, 0], 0, () => {
    k.rbox(KM.paint, [0.42, 0.092, 0.42], 0.012, [0, DECK + 0.046, 0]);
    k.rbox(KM.paintGraphite, [0.424, 0.008, 0.424], 0.004, [0, 0.946, 0]);
    k.cyl(KM.seam, 0.176, 0.003, [0, 0.9505, 0], Z0, 48, { cast: false });
    k.box(KM.seam, [0.4, 0.003, 0.002], [0, 0.885, 0.2112], Z0, { cast: false });
    k.label('tag', hot ? 'HP 1' : 'CP 1', hot ? '110 °C · PROXIMITY' : '23 °C · WATER COOLED', 0.15, 0.036, [-0.08, 0.915, 0.2112]);
    k.box(hot ? KM.ledAmber : KM.ledGreen, [0.03, 0.007, 0.003], [0.06, 0.92, 0.2115], Z0, { cast: false });
    for (const sx of [-1, 1]) k.cyl(KM.stainlessDark, 0.005, 0.004, [sx * 0.19, 0.9, 0.2112], RZ, 8, { cast: false });
    if (hot) {
      k.label('warn', 'HOT SURFACE', '', 0.05, 0.05, [0.15, 0.9, 0.2112]);
      // proximity pins and the lid guide rods (clear of the wafer path at z = ±0.2)
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI * 2) / 3;
        k.cyl(M.ceramic, 0.004, 0.01, [Math.cos(a) * 0.1, 0.958, Math.sin(a) * 0.1], Z0, 8, { cast: false });
      }
      for (const z of [-0.2, 0.2]) {
        k.cyl(KM.anodizedDark, 0.014, 0.012, [0, 0.956, z], Z0, 14);
        k.cyl(KM.chrome, 0.007, 0.37, [0, 0.95 + 0.185, z], Z0, 10);
        k.cyl(KM.anodizedDark, 0.012, 0.016, [0, 1.328, z], Z0, 12);
      }
      // heater cable and thermocouple lead into the deck
      k.tube(KM.plastic, [[-0.2, 0.89, -0.12], [-0.24, 0.89, -0.14], [-0.25, 0.86, -0.16], [-0.25, DECK - 0.02, -0.16]], 0.007, { radial: 6, tension: 0.4 });
    } else {
      k.cyl(ALU, 0.165, 0.008, [0, 0.953, 0], Z0, 48);
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI * 2) / 3 + 0.5;
        k.cyl(KM.seam, 0.006, 0.002, [Math.cos(a) * 0.1, 0.9575, Math.sin(a) * 0.1], Z0, 8, { cast: false });
      }
      // cooling water in / out
      for (const [i, m] of [[0, KM.paintBlue], [1, KM.paintRed]] as const) {
        const z = -0.06 + i * 0.12;
        k.cyl(KM.brass, 0.009, 0.03, [0.225, 0.9, z], RX, 10, { cast: false });
        k.tube(m, [[0.24, 0.9, z], [0.27, 0.9, z], [0.28, 0.87, z], [0.28, DECK - 0.02, z]], 0.009, { radial: 8, tension: 0.4 });
      }
    }
  });
}

/** Bake plate lid (lid-local, moves on the guide rods): cover, skirt, exhaust stem, rod bushings. */
function buildBakeLid(k: Kit) {
  k.cyl(ALU, 0.19, 0.022, [0, 0.005, 0], Z0, 48);
  k.cyl(ALU, 0.19, 0.02, [0, -0.016, 0], Z0, 48, { open: true });
  k.torus(KM.seam, 0.19, 0.0015, [0, 0.016, 0], Z0, 48, { cast: false });
  k.cyl(KM.stainless, 0.06, 0.006, [0, 0.019, 0], Z0, 28);
  boltCircle(k, 0.05, 6, 0.023, 0.004);
  k.cyl(KM.stainless, 0.03, 0.12, [0, 0.07, 0], Z0, 20);
  k.cyl(KM.stainless, 0.04, 0.01, [0, 0.128, 0], Z0, 24);
  for (const z of [-0.2, 0.2]) {
    k.box(ALU, [0.04, 0.014, 0.03], [0, 0.005, z * 0.95], Z0);
    k.cyl(KM.anodizedDark, 0.015, 0.044, [0, 0.005, z], Z0, 14);
  }
}

/** Linear transfer axis along the back of the deck (world coords). */
function buildRail(k: Kit) {
  const L = 5.4;
  const cx = 0.45;
  k.rbox(KM.anodizedDark, [L, 0.022, 0.13], 0.005, [cx, DECK + 0.011, RAIL_Z]);
  for (const dz of [-0.045, 0.045]) k.box(KM.steel, [L, 0.008, 0.016], [cx, DECK + 0.026, RAIL_Z + dz]);
  k.box(KM.seam, [L - 0.02, 0.003, 0.05], [cx, DECK + 0.0235, RAIL_Z], Z0, { cast: false });
  for (const s of [-1, 1]) k.rbox(KM.paintYellow, [0.03, 0.05, 0.13], 0.005, [cx + s * (L / 2 - 0.015), DECK + 0.047, RAIL_Z]);
  // cable channel behind the axis
  k.box(KM.anodized, [L, 0.004, 0.07], [cx, DECK + 0.006, RAIL_Z - 0.11], Z0, { cast: false });
  for (const dz of [-0.035, 0.035]) k.box(KM.anodized, [L, 0.04, 0.003], [cx, DECK + 0.024, RAIL_Z - 0.11 + dz], Z0, { cast: false });
  k.box(KM.rubber, [L * 0.5, 0.012, 0.05], [cx - L * 0.25, DECK + 0.014, RAIL_Z - 0.11], Z0, { cast: false });
  k.label('tag', 'X AXIS', 'LINEAR MOTOR · 5.4 m', 0.12, 0.016, [cx - 2.4, DECK + 0.011, RAIL_Z + 0.0655]);
}

/** Track robot carriage (body-local, rides on the axis): carriage, Z/θ housing, turret, status strip. */
function buildRobotBody(k: Kit) {
  k.rbox(KM.anodizedDark, [0.22, 0.02, 0.16], 0.005, [0, 0.01, 0]);
  k.rbox(KM.paint, [0.18, 0.1, 0.14], 0.014, [0, 0.07, 0]);
  k.rbox(KM.paintGraphite, [0.184, 0.01, 0.144], 0.004, [0, 0.125, 0]);
  k.box(KM.seam, [0.182, 0.003, 0.142], [0, 0.045, 0], Z0, { cast: false });
  k.cyl(KM.anodized, 0.05, 0.012, [0, 0.136, 0.02], Z0, 28);
  k.box(KM.ledGreen, [0.05, 0.006, 0.003], [0.03, 0.1, 0.0712], Z0, { cast: false });
  k.label('tag', 'TR-1', 'TRACK ROBOT', 0.07, 0.02, [-0.045, 0.075, 0.0711]);
  for (const sx of [-1, 1]) k.cyl(KM.stainlessDark, 0.005, 0.004, [sx * 0.08, 0.1, 0.0712], RZ, 8, { cast: false });
}

/** Deck-mounted monitor arm for the process screen (screen-local). */
function buildMonitorArm(k: Kit) {
  k.cyl(KM.anodizedDark, 0.05, 0.012, [0, DECK + 0.006, -0.06], Z0, 24);
  k.cyl(ALU, 0.018, 0.5, [0, DECK + 0.25, -0.06], Z0, 16);
  k.rbox(KM.anodizedDark, [0.04, 0.03, 0.06], 0.006, [0, 1.36, -0.045]);
  k.rbox(KM.anodizedDark, [0.14, 0.14, 0.012], 0.004, [0, 1.42, -0.028]);
}

/* ---------------------------------------------------------------- modules */

function Cup({ x, id, label, dispense }: { x: number; id: string; label: string; dispense: () => number }) {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  const view = effectiveView(viewRaw, cam);
  const arm = useRef<THREE.Group>(null);
  const stream = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const d = dispense();
    if (arm.current) arm.current.rotation.y = lerp(1.1, 0, smooth(clamp(d * 4)));
    if (stream.current) stream.current.visible = d > 0.25 && d < 0.98;
  });
  const develop = id === 'developer';
  const bowl = useKit(buildBowl);
  const base = useFolded((k) => buildCupStatic(k, develop), [develop]);
  const armParts = useFolded(buildDispenseArm);
  return (
    <group position={[x, 0, 0]}>
      <Clickable sel={{ kind: 'component', id, machine: 'track', label }}>
        <Baked parts={bowl} view={view} />
        <Baked parts={base} />
      </Clickable>
      <Clickable sel={{ kind: 'component', id: 'nozzle', machine: 'track', label: 'Dispense nozzle arm' }}>
        <group ref={arm} position={[0.32, 1.17, -0.18]}>
          <Baked parts={armParts} />
          <mesh ref={stream} position={[-0.32, -0.08, 0.18]} material={M.resist}>
            <cylinderGeometry args={[0.004, 0.004, 0.09, 8]} />
          </mesh>
        </group>
      </Clickable>
    </group>
  );
}

const plateMat = new THREE.MeshStandardMaterial({ color: '#8b8f8f', roughness: 0.35, metalness: 0.8, emissive: new THREE.Color('#ff6a1a'), emissiveIntensity: 0, toneMapped: false });

function Plates({ variant }: { variant: Variant }) {
  const lid = useRef<THREE.Group>(null);
  const vapour = useRef<THREE.InstancedMesh>(null);
  const seeds = useMemo(() => {
    const r = rng(12);
    return Array.from({ length: 40 }, () => ({ x: (r() - 0.5) * 0.26, z: (r() - 0.5) * 0.26, o: r(), s: 0.6 + r() * 0.8 }));
  }, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const t = useRef(0);
  useFrame((_, dt) => {
    t.current += pdt(dt);
    const T = variant === 'bake' ? engine.tele.value('plate', 100) : 100;
    plateMat.emissiveIntensity = clamp((T - 40) / 60) * 0.06;
    const baking = (variant === 'bake' && inPhase('bake')) || (variant === 'develop' && inPhase('peb'));
    if (lid.current) lid.current.position.y = baking ? lerp(1.2, 1.0, smooth(clamp(engine.player.view.phaseT * 5))) : 1.2;
    if (vapour.current) {
      const sol = variant === 'bake' && inPhase('bake') ? engine.tele.value('solvent', 0) / 25 : 0;
      seeds.forEach((s, i) => {
        const u = (t.current * 0.4 * s.s + s.o) % 1;
        o.position.set(BX + s.x, PLATE_Y + 0.005 + u * 0.03, s.z);
        o.scale.setScalar(i / seeds.length < sol ? 0.004 * (1 - u) : 0);
        o.updateMatrix();
        vapour.current!.setMatrixAt(i, o.matrix);
      });
      vapour.current.instanceMatrix.needsUpdate = true;
    }
  });
  const hot = useFolded((k) => buildPlateModule(k, true));
  const chill = useFolded((k) => buildPlateModule(k, false));
  const lidParts = useFolded(buildBakeLid);
  return (
    <group>
      <Clickable sel={{ kind: 'component', id: 'hotplate', machine: 'track', label: 'Bake plate (proximity pins)' }}>
        <Baked parts={hot} />
        <mesh position={[BX, 0.953, 0]} material={plateMat}>
          <cylinderGeometry args={[0.165, 0.165, 0.008, 48]} />
        </mesh>
        <group ref={lid} position={[BX, 1.2, 0]}>
          <Baked parts={lidParts} />
        </group>
      </Clickable>
      <Clickable sel={{ kind: 'component', id: 'chill', machine: 'track', label: 'Chill plate' }}>
        <Baked parts={chill} />
      </Clickable>
      <instancedMesh ref={vapour} args={[GEO.sphereLow, M.glass, 40]} frustumCulled={false} />
    </group>
  );
}

function TrackRobot({ variant }: { variant: Variant }) {
  const body = useRef<THREE.Group>(null);
  const blade = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const p = waferPos(variant);
    if (body.current) body.current.position.x = THREE.MathUtils.clamp(p.x, -2.2, 3.1);
    if (blade.current) {
      // blade reaches the wafer while it is between rail and module
      const reach = clamp((p.z - RAIL_Z) / -RAIL_Z);
      const carrying = p.y > 1.03 || (reach > 0.05 && reach < 0.95);
      blade.current.visible = carrying;
      blade.current.position.set(0, p.y - 0.006 - 0.88, p.z - RAIL_Z);
    }
  });
  const rail = useFolded(buildRail);
  const carriage = useFolded(buildRobotBody);
  return (
    <Clickable sel={{ kind: 'component', id: 'robot', machine: 'track', label: 'Track robot' }}>
      <Baked parts={rail} />
      <group ref={body} position={[0, 0.88, RAIL_Z]}>
        <Baked parts={carriage} />
        <mesh ref={blade} material={M.ceramic}>
          <boxGeometry args={[0.07, 0.006, 0.36]} />
        </mesh>
      </group>
    </Clickable>
  );
}

function TrackBody() {
  const viewRaw = useUI((s) => s.view);
  const cam = useUI((s) => s.cameraMode);
  const view = effectiveView(viewRaw, cam);
  const parts = useFolded((k) => {
    buildTrackStatic(k);
    buildTrackEnclosure(k);
  });
  return (
    <Clickable sel={{ kind: 'machine', id: 'track', label: 'Coater / developer track' }}>
      <Baked parts={parts} view={view} />
      <SignalTower position={TOWER_LAMP} />
    </Clickable>
  );
}

/* ---------------------------------------------------------------- insets */

const subMat = new THREE.MeshStandardMaterial({ color: '#7a828c', roughness: 0.45, metalness: 0.6 });
const resistMat = new THREE.MeshPhysicalMaterial({ color: '#b5612a', roughness: 0.3, metalness: 0, transparent: true, opacity: 0.92 });
const exposedMat = new THREE.MeshPhysicalMaterial({ color: '#dd9a52', roughness: 0.3, metalness: 0, transparent: true, opacity: 0.9 });
const devLiquid = new THREE.MeshStandardMaterial({ color: '#c8dccb', transparent: true, opacity: 0.2, depthWrite: false });
const dotMat = new THREE.MeshStandardMaterial({ color: '#e7e0c4', roughness: 0.5 });

/** Coat: thickness profile across the wafer diameter (vertical exaggeration). */
function CoatInset() {
  const Y = 0.45 / 2600; // units per nm of resist (schematic)
  return (
    <Inset id="coat-profile" position={[-0.35, 1.8, 0.4]} size={[1.2, 0.8]} mpu={0.3 / 1.0} title="RESIST PROFILE ACROSS THE WAFER · VERTICAL ×10⁵">
      <group position={[0, -0.22, 0.05]}>
        <ProfileSlab points={rect(-0.5, -0.06, 0.5, 0)} depth={0.12} m={subMat} />
        <LiveProfile
          depth={0.12}
          m={resistMat}
          compute={() => {
            const v = engine.player.view;
            if (v.phaseId === 'load') return null;
            const th = engine.tele.value('thick', 0);
            const spread = v.phaseId === 'dispense' ? 0.08 + 0.25 * v.phaseT : v.phaseId === 'spread' ? lerp(0.33, 1, smooth(v.phaseT)) : 1;
            const ebr = v.phaseId === 'ebr' ? smooth(v.phaseT) : pp('ebr');
            const R = 0.5 * spread * (1 - 0.06 * ebr);
            const pts: [number, number][] = [];
            const n = 40;
            for (let i = 0; i <= n; i++) {
              const x = -R + (2 * R * i) / n;
              const r = Math.abs(x) / Math.max(R, 1e-3);
              // puddle → domed spreading film → flat film (centrifugal thinning evens it out)
              const dome = spread < 1 ? 1 + 0.8 * (1 - r * r) : 1 + 0.04 * (1 - r * r) * clamp((th - 200) / 400);
              pts.push([x, Math.max(0.003, th * Y * dome)]);
            }
            pts.push([R, 0], [-R, 0]);
            return pts;
          }}
        />
      </group>
      <TechLabel position={[-0.56, 0.32, 0.05]} title="RESIST THICKNESS" min={2} value={() => `${engine.tele.value('thick', 0).toFixed(0)} nm @ ${engine.tele.value('rpm', 0).toFixed(0)} rpm · SIMULATED`} />
      <TechLabel position={[0.32, -0.32, 0.05]} title="WAFER Ø 300 mm" min={3} />
    </Inset>
  );
}

/** Bake: solvent leaving the resist film (cross-section at ~nm scale). */
function BakeInset() {
  const H = 0.3; // 110 nm of resist
  const dots = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const seeds = useMemo(() => {
    const r = rng(3);
    return Array.from({ length: 60 }, () => ({ x: (r() - 0.5) * 1.0, y: r(), o: r(), s: 0.5 + r() }));
  }, []);
  const t = useRef(0);
  useFrame((_, dt) => {
    t.current += pdt(dt);
    if (!dots.current) return;
    const sol = clamp(engine.tele.value('solvent', 25) / 25);
    const baking = inPhase('bake');
    seeds.forEach((s, i) => {
      const present = i / seeds.length < sol;
      // trapped solvent molecules jiggle inside; while baking a few escape upward
      const esc = baking && i / seeds.length > sol - 0.15 && present ? ((t.current * 0.6 * s.s + s.o) % 1) : 0;
      const y = s.y * H * 0.9 + 0.01 + esc * 0.3;
      o.position.set(s.x + 0.006 * Math.sin(t.current * 9 + i), y, 0.08);
      o.scale.setScalar(present ? 0.012 : 0);
      o.updateMatrix();
      dots.current!.setMatrixAt(i, o.matrix);
    });
    dots.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <Inset id="bake-section" position={[1.65, 1.8, 0.4]} size={[1.2, 0.8]} mpu={110e-9 / H} schematic={false} title="SOFT BAKE · RESIST CROSS-SECTION">
      <group position={[0, -0.12, 0]}>
        <ProfileSlab points={rect(-0.55, -0.22, 0.55, 0)} depth={0.14} m={subMat} />
        <LiveProfile depth={0.14} m={resistMat} compute={() => rect(-0.55, 0, 0.55, H * (0.95 + 0.05 * clamp(engine.tele.value('solvent', 25) / 25)))} />
        <instancedMesh ref={dots} args={[GEO.sphereLow, dotMat, 60]} frustumCulled={false} />
      </group>
      <TechLabel position={[-0.56, 0.32, 0.05]} title="RESIDUAL SOLVENT" min={2} value={() => `${engine.tele.value('solvent', 0).toFixed(1)} % · wafer ${engine.tele.value('wafer', 0).toFixed(1)} °C · SIMULATED`} />
    </Inset>
  );
}

/** Develop: exposed resist (latent image) dissolves top-down, leaving lines. */
function DevelopInset() {
  const H = 0.3;
  const spaces = [-0.36, -0.12, 0.12, 0.36];
  const w = 0.12;
  const liquid = useRef<THREE.Mesh>(null);
  useFrame(() => {
    if (liquid.current) liquid.current.visible = inPhase('dispense') || inPhase('develop');
  });
  const lines = useMemo(() => {
    const edges = [-0.55, ...spaces.flatMap((c) => [c - w / 2, c + w / 2]), 0.55];
    const out: [number, number][][] = [];
    for (let i = 0; i < edges.length; i += 2) out.push(rect(edges[i], 0, edges[i + 1], H));
    return out;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Inset id="dev-section" position={[3.65, 1.8, 0.4]} size={[1.2, 0.8]} mpu={110e-9 / H} schematic={false} title="DEVELOP · RESIST CROSS-SECTION">
      <group position={[0, -0.12, 0]}>
        <ProfileSlab points={rect(-0.55, -0.22, 0.55, 0)} depth={0.14} m={subMat} />
        {lines.map((p, i) => (
          <ProfileSlab key={i} points={p} depth={0.14} m={resistMat} />
        ))}
        {spaces.map((c) => (
          <LiveProfile
            key={c}
            depth={0.14}
            m={exposedMat}
            compute={() => {
              const d = clamp(engine.tele.value('dissolve', 0) / 100);
              const h = H * (1 - d);
              return h < 0.004 ? null : rect(c - w / 2, 0, c + w / 2, h);
            }}
          />
        ))}
        <mesh ref={liquid} position={[0, H + 0.08, 0]} material={devLiquid}>
          <boxGeometry args={[1.1, 0.5, 0.14]} />
        </mesh>
      </group>
      <TechLabel position={[-0.56, 0.32, 0.05]} title="EXPOSED RESIST DISSOLVED" min={2} value={() => `${engine.tele.value('dissolve', 0).toFixed(0)} % · lines 44 nm · SIMULATED`} />
      <TechLabel position={[0.28, -0.32, 0.05]} title="LATENT IMAGE → PATTERN" min={3} />
    </Inset>
  );
}

function SpinCurveScreen() {
  const curve = useMemo(() => Array.from({ length: 50 }, (_, i) => spinThickness(500 + i * 70)), []);
  const post = useFolded(buildMonitorArm);
  return (
    <group position={[-2.45, 0, -0.35]} rotation={[0, 0.5, 0]}>
      <Screen
        size={[0.56, 0.36]}
        position={[0, 1.42, 0]}
        hz={4}
        draw={(g, w, h) => {
          clear(g, w, h, 'SPIN COAT · t ∝ ω^-½ · SIMULATED');
          const x = w * 0.07;
          const y = h * 0.36;
          const pw = w * 0.86;
          const ph = h * 0.52;
          plot(g, curve, x, y, pw, ph, 0, 300, SCR.dim);
          const rpm = engine.tele.value('rpm', 0);
          if (rpm > 500) {
            const u = clamp((rpm - 500) / (49 * 70));
            g.fillStyle = SCR.accent;
            g.beginPath();
            g.arc(x + u * pw, y + ph - (spinThickness(rpm) / 300) * ph, h * 0.025, 0, Math.PI * 2);
            g.fill();
          }
          bigNumber(g, 'SPIN', rpm.toFixed(0), 'rpm', w * 0.07, h * 0.19, h * 0.09);
          bigNumber(g, 'FILM', engine.tele.value('thick', 0).toFixed(0), 'nm', w * 0.55, h * 0.19, h * 0.09);
        }}
      />
      <Baked parts={post} />
    </group>
  );
}

/* ---------------------------------------------------------------- scene */

export default function TrackScene({ stage }: SceneProps) {
  const variant = (stage.variant as Variant) ?? 'coat';
  useEffect(() => {
    cutPlane.normal.set(0, 0, -1);
    cutPlane.constant = 0.3;
  }, []);
  return (
    <>
      <Lighting env="litho" shadowExtent={6} />
      <CleanroomBay width={13} depth={8} height={4.2} amber />
      <TrackBody />
      <Cup x={CX} id="coater" label="Spin coater cup" dispense={() => (variant === 'coat' ? (inPhase('dispense') ? engine.player.view.phaseT : 0) : 0)} />
      <Cup x={DX} id="developer" label="Develop module" dispense={() => (variant === 'develop' ? (inPhase('dispense') ? clamp((engine.player.view.phaseT - 0.35) / 0.65) : inPhase('rinse') ? 0.5 : 0) : 0)} />
      <Plates variant={variant} />
      <TrackRobot variant={variant} />
      <TrackWafer variant={variant} />
      <SensorIndicator id="humidity" channel={variant === 'coat' ? 'rh' : undefined} machine="track" position={[CX - 0.28, 1.0, 0.2]} size={0.04} />
      <SensorIndicator id="thermocouple" channel={variant === 'bake' ? 'plate' : variant === 'develop' ? 'devT' : undefined} machine="track" position={[BX + 0.22, 0.92, 0.18]} size={0.04} />
      {variant === 'coat' && <CoatInset />}
      {variant === 'bake' && <BakeInset />}
      {variant === 'develop' && <DevelopInset />}
      <SpinCurveScreen />
      <TechLabel position={[CX - 0.1, 1.3, 0.1]} title="SPIN COATER" min={2} value={variant === 'coat' ? () => `${engine.tele.value('rpm', 0).toFixed(0)} rpm · ${engine.player.view.phase.label}` : undefined} />
      <TechLabel position={[BX - 0.1, 1.32, 0.1]} title="BAKE · CHILL" min={2} value={variant === 'bake' ? () => `plate ${engine.tele.value('plate', 0).toFixed(1)} °C · ${engine.player.view.phase.label}` : undefined} />
      <TechLabel position={[DX - 0.1, 1.3, 0.1]} title="DEVELOP" min={2} value={variant === 'develop' ? () => `${engine.tele.value('dissolve', 0).toFixed(0)} % dissolved · ${engine.player.view.phase.label}` : undefined} />
      <Operator position={[0.2, 0, 1.6]} rotation={Math.PI} still />
    </>
  );
}
