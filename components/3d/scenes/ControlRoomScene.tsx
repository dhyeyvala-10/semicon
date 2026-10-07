'use client';
/**
 * Fab operations centre (§80): a video wall and operator desks fed live by the running fab
 * simulation — tool-state map with OHT vehicles and the followed lot, KPIs, trends, tool-state
 * Pareto, alarm / event log and cleanroom environment. All values are SIMULATED.
 */
import * as THREE from 'three';
import { useMemo } from 'react';
import { Lighting } from '../environments';
import { M } from '../materials';
import { B, C } from '../parts/primitives';
import { Clickable, TechLabel } from '../parts/interaction';
import { Screen, clear, plot, bigNumber, SCR } from '../parts/screens';
import { Operator } from '../parts/people';
import { engine } from '@/simulation/engine';
import { loopPoint, LOOP_LENGTH } from '@/simulation/fab';
import { FAB, OHT_LOOP } from '@/data/fabLayout';
import { STATE_COLOR } from '../materials';
import { vnoise } from '@/lib/math';
import type { MachineState } from '@/types';

const WALL_Z = -3.6;

/* ---------------------------------------------------------------- wall content */

function drawFabMap(g: CanvasRenderingContext2D, w: number, h: number) {
  clear(g, w, h, 'FAB 1 · LIVE TOOL STATE · AMHS · SIMULATED');
  const fab = engine.fab;
  const pad = w * 0.04;
  const sx = (w - pad * 2) / (FAB.maxX - FAB.minX);
  const sz = (h * 0.8) / (FAB.maxZ - FAB.minZ);
  const s = Math.min(sx, sz);
  const ox = w / 2;
  const oy = h * 0.55;
  const X = (x: number) => ox + x * s;
  const Y = (z: number) => oy + z * s;
  // cleanroom outline
  g.strokeStyle = SCR.grid;
  g.lineWidth = 2;
  g.strokeRect(X(FAB.minX), Y(FAB.minZ), (FAB.maxX - FAB.minX) * s, (FAB.maxZ - FAB.minZ) * s);
  // OHT loop
  g.strokeStyle = 'rgba(159,191,106,0.35)';
  g.lineWidth = 1.5;
  g.beginPath();
  OHT_LOOP.forEach(([x, z], i) => (i ? g.lineTo(X(x), Y(z)) : g.moveTo(X(x), Y(z))));
  g.closePath();
  g.stroke();
  // tools coloured by state
  for (const t of fab.tools) {
    const d = t.def;
    const horizontal = Math.abs(Math.sin(d.rot)) < 0.5;
    const wl = (horizontal ? d.depth : d.length) * s;
    const hl = (horizontal ? d.length : d.depth) * s;
    g.fillStyle = STATE_COLOR[t.state] ?? '#555';
    g.globalAlpha = t.state === 'IDLE' ? 0.55 : 0.9;
    g.fillRect(X(d.x) - wl / 2, Y(d.z) - hl / 2, wl, hl);
    g.globalAlpha = 1;
  }
  // vehicles
  for (const v of fab.vehicles) {
    const p = loopPoint(((v.s % LOOP_LENGTH) + LOOP_LENGTH) % LOOP_LENGTH);
    g.fillStyle = v.carrying ? (v.carrying.followed ? '#f4e6a6' : '#dfe8da') : '#7b8f78';
    g.beginPath();
    g.arc(X(p.x), Y(p.z), v.carrying?.followed ? 6 : 3.5, 0, Math.PI * 2);
    g.fill();
  }
  // followed lot
  const lot = fab.followedLot();
  g.fillStyle = SCR.text;
  g.font = `${Math.round(h * 0.045)}px monospace`;
  g.fillText(`FOLLOWED: ${lot ? `${lot.id} · step ${lot.step} · ${lot.waiting === 'none' ? 'moving / processing' : `waiting for ${lot.waiting}`}` : '—'}`, pad, h * 0.96);
  // legend
  let lx = w * 0.55;
  for (const st of ['PROCESSING', 'IDLE', 'MAINTENANCE', 'ALARM'] as MachineState[]) {
    g.fillStyle = STATE_COLOR[st];
    g.fillRect(lx, h * 0.93, 12, 12);
    g.fillStyle = SCR.dim;
    g.fillText(st, lx + 16, h * 0.96);
    lx += w * 0.11;
  }
}

function drawKPIs(g: CanvasRenderingContext2D, w: number, h: number) {
  clear(g, w, h, 'KEY INDICATORS · SIMULATED');
  const f = engine.fab;
  bigNumber(g, 'WIP · LOTS', String(f.lots.length), '', w * 0.05, h * 0.22, h * 0.13);
  bigNumber(g, 'UTILISATION', f.utilisation().toFixed(1), '%', w * 0.52, h * 0.22, h * 0.13);
  bigNumber(g, 'MOVES / HOUR', f.movesPerHour().toFixed(0), '', w * 0.05, h * 0.58, h * 0.13);
  const a = f.activeAlarms();
  bigNumber(g, 'LINE YIELD', f.lineYield().toFixed(1), '%', w * 0.52, h * 0.58, h * 0.13, SCR.good);
  g.fillStyle = a ? SCR.crit : SCR.good;
  g.font = `${Math.round(h * 0.07)}px monospace`;
  g.fillText(a ? `● ${a} ACTIVE ALARM${a > 1 ? 'S' : ''}` : '● NO ACTIVE ALARMS', w * 0.05, h * 0.93);
}

function drawTrends(g: CanvasRenderingContext2D, w: number, h: number) {
  clear(g, w, h, 'TRENDS · WIP / UTILISATION · SIMULATED');
  const wip = engine.tele.get('wip');
  const util = engine.tele.get('util');
  plot(g, wip ? wip.series().slice(-240) : [], w * 0.05, h * 0.2, w * 0.9, h * 0.32, 0, 80, SCR.data);
  plot(g, util ? util.series().slice(-240) : [], w * 0.05, h * 0.6, w * 0.9, h * 0.32, 0, 100, '#d8c27a');
  g.fillStyle = SCR.dim;
  g.font = `${Math.round(h * 0.05)}px monospace`;
  g.fillText('WIP', w * 0.05, h * 0.19);
  g.fillText('UTIL %', w * 0.05, h * 0.59);
}

function drawStates(g: CanvasRenderingContext2D, w: number, h: number) {
  clear(g, w, h, 'TOOL STATES · SIMULATED');
  const c = engine.fab.stateCounts();
  const keys: MachineState[] = ['PROCESSING', 'LOADING', 'UNLOADING', 'IDLE', 'MAINTENANCE', 'ALARM', 'OFFLINE'];
  const max = Math.max(1, ...keys.map((k) => c[k]));
  keys.forEach((k, i) => {
    const y = h * (0.2 + i * 0.11);
    g.fillStyle = SCR.dim;
    g.font = `${Math.round(h * 0.05)}px monospace`;
    g.fillText(k, w * 0.05, y + h * 0.05);
    g.fillStyle = STATE_COLOR[k];
    g.fillRect(w * 0.4, y, (w * 0.45 * c[k]) / max, h * 0.07);
    g.fillStyle = SCR.text;
    g.fillText(String(c[k]), w * 0.42 + (w * 0.45 * c[k]) / max, y + h * 0.05);
  });
}

function drawEvents(g: CanvasRenderingContext2D, w: number, h: number) {
  clear(g, w, h, 'ALARMS & EVENTS · SIMULATED');
  const ev = engine.fab.events.slice(-11).reverse();
  g.font = `${Math.round(h * 0.048)}px monospace`;
  ev.forEach((e, i) => {
    g.fillStyle = e.level === 'alarm' ? SCR.crit : e.level === 'warn' ? SCR.warn : SCR.dim;
    const t = (e.t * 60) / 3600;
    g.fillText(`${t.toFixed(2).padStart(6)} h  ${e.msg}`.slice(0, 64), w * 0.04, h * (0.2 + i * 0.072));
  });
}

function drawEnv(g: CanvasRenderingContext2D, w: number, h: number) {
  clear(g, w, h, 'CLEANROOM ENVIRONMENT · SIMULATED');
  const t = engine.time;
  bigNumber(g, 'PARTICLES ≥0.1 µm', engine.ext.get('fab.particles')?.toFixed(0) ?? '8', '/m³', w * 0.05, h * 0.22, h * 0.11, SCR.good);
  bigNumber(g, 'TEMPERATURE', (21 + 0.04 * vnoise(t * 0.2, 4)).toFixed(2), '°C', w * 0.52, h * 0.22, h * 0.11);
  bigNumber(g, 'HUMIDITY', (45 + 0.4 * vnoise(t * 0.15, 5)).toFixed(1), '%RH', w * 0.05, h * 0.58, h * 0.11);
  bigNumber(g, 'ΔP CLEANROOM', (12 + 0.3 * vnoise(t * 0.3, 6)).toFixed(1), 'Pa', w * 0.52, h * 0.58, h * 0.11);
  g.fillStyle = SCR.dim;
  g.font = `${Math.round(h * 0.05)}px monospace`;
  g.fillText('ISO 14644-1 class targets · representative values', w * 0.05, h * 0.94);
}

function drawDesk(kind: number) {
  return (g: CanvasRenderingContext2D, w: number, h: number) => {
    if (kind % 3 === 0) {
      clear(g, w, h, 'LOT TRACKING');
      const lot = engine.fab.followedLot();
      g.fillStyle = SCR.text;
      g.font = `${Math.round(h * 0.08)}px monospace`;
      g.fillText(lot ? lot.id : 'LOT-A0731', w * 0.06, h * 0.32);
      g.fillStyle = SCR.dim;
      g.font = `${Math.round(h * 0.06)}px monospace`;
      (lot?.history.slice(-5) ?? []).forEach((s, i) => g.fillText(s.slice(0, 32), w * 0.06, h * (0.45 + i * 0.1)));
    } else if (kind % 3 === 1) {
      clear(g, w, h, 'SPC · LINE CD');
      const r = Array.from({ length: 40 }, (_, i) => 24 + 0.5 * vnoise(i * 0.7 + engine.time * 0.05, 8));
      plot(g, r, w * 0.06, h * 0.25, w * 0.88, h * 0.6, 22.5, 25.5, SCR.data);
    } else drawStates(g, w, h);
  };
}

/* ---------------------------------------------------------------- room */

function VideoWall() {
  const tiles: { x: number; y: number; w: number; h: number; draw: (g: CanvasRenderingContext2D, w: number, h: number) => void; hz: number; res: number }[] = [
    { x: 0, y: 2.55, w: 4.2, h: 2.1, draw: drawFabMap, hz: 6, res: 1024 },
    { x: -3.55, y: 3.05, w: 2.6, h: 1.05, draw: drawKPIs, hz: 3, res: 640 },
    { x: -3.55, y: 1.92, w: 2.6, h: 1.05, draw: drawTrends, hz: 2, res: 640 },
    { x: 3.55, y: 3.05, w: 2.6, h: 1.05, draw: drawEvents, hz: 2, res: 640 },
    { x: 3.55, y: 1.92, w: 2.6, h: 1.05, draw: drawStates, hz: 2, res: 640 },
    { x: 0, y: 1.05, w: 2.6, h: 0.42, draw: drawEnv, hz: 2, res: 640 },
  ];
  return (
    <group position={[0, 0, WALL_Z]}>
      <B s={[11.5, 3.6, 0.2]} m={M.black} position={[0, 2.25, -0.12]} />
      {tiles.map((t, i) => (
        <Screen key={i} size={[t.w, t.h]} position={[t.x, t.y, 0]} draw={t.draw} hz={t.hz} res={t.res} />
      ))}
      <TechLabel position={[-5.6, 4.25, 0.2]} title="FAB OPERATIONS CENTRE · LIVE" lines={['every value here comes from the running fab simulation']} min={1} />
    </group>
  );
}

function Desk({ x, z, rot, k }: { x: number; z: number; rot: number; k: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, rot, 0]}>
      <B s={[1.8, 0.05, 0.8]} m={M.panelDark} position={[0, 0.74, 0]} />
      <B s={[1.7, 0.7, 0.05]} m={M.frame} position={[0, 0.37, 0.35]} />
      {[-0.55, 0, 0.55].map((dx, i) => (
        <group key={dx} position={[dx, 1.02, -0.2]} rotation={[0, -dx * 0.35, 0]}>
          <Screen size={[0.52, 0.32]} position={[0, 0, 0]} draw={drawDesk(k + i)} hz={1} res={256} />
          <C r={0.02} h={0.2} m={M.steelDark} position={[0, -0.22, -0.02]} />
        </group>
      ))}
      <B s={[0.45, 0.02, 0.15]} m={M.black} position={[0, 0.77, 0.12]} />
    </group>
  );
}

function Room() {
  const floor = useMemo(() => new THREE.MeshStandardMaterial({ color: '#1c211e', roughness: 0.7 }), []);
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} receiveShadow material={floor}>
        <planeGeometry args={[16, 12]} />
      </mesh>
      <B s={[16, 4.6, 0.1]} m={M.panelDark} position={[0, 2.3, -4]} />
      <B s={[0.1, 4.6, 12]} m={M.panelDark} position={[-8, 2.3, 2]} />
      <B s={[0.1, 4.6, 12]} m={M.panelDark} position={[8, 2.3, 2]} />
      {/* ceiling light strips */}
      {[-4, 0, 4].map((x) => (
        <B key={x} s={[0.15, 0.03, 9]} m={M.lightPanel} position={[x, 4.4, 1]} shadow={false} />
      ))}
      {/* window to the fab floor (amber litho light beyond) */}
      <B s={[0.05, 1.6, 4]} m={M.lightAmber} position={[7.9, 2.0, 2.4]} shadow={false} />
    </group>
  );
}

export default function ControlRoomScene() {
  return (
    <>
      <Lighting env="office" shadowExtent={8} />
      <Room />
      <Clickable sel={{ kind: 'component', id: 'control-room', label: 'Video wall' }}>
        <VideoWall />
      </Clickable>
      {[
        [-3.0, -0.6, 0.25, 0],
        [0, -0.9, 0, 3],
        [3.0, -0.6, -0.25, 6],
        [-1.6, 1.6, 0.12, 1],
        [1.6, 1.6, -0.12, 4],
      ].map(([x, z, r, k], i) => (
        <group key={i}>
          <Desk x={x} z={z} rot={r} k={k} />
          {i < 3 && <Operator position={[x - 0.3 * Math.sin(r), 0, z + 0.75]} rotation={Math.PI + r} still />}
        </group>
      ))}
    </>
  );
}
