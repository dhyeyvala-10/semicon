'use client';
/**
 * Emissive display panels whose content is drawn into a canvas from live simulation
 * data (control-room video wall, tool HMIs, bay information boards).
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { makeScreen } from '../textures';
import type { V3 } from './primitives';

export type DrawFn = (g: CanvasRenderingContext2D, w: number, h: number, t: number) => void;

export function Screen({ size, position, rotation, draw, hz = 2, res = 512, frame = true }: { size: [number, number]; position: V3; rotation?: V3; draw: DrawFn; hz?: number; res?: number; frame?: boolean }) {
  const h = Math.round((res * size[1]) / size[0]);
  const scr = useMemo(() => makeScreen(res, h), [res, h]);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ map: scr.tex, toneMapped: false }), [scr]);
  const acc = useRef(1e9);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => () => {
    scr.tex.dispose();
    mat.dispose();
  }, [scr, mat]);
  useFrame(({ clock }, dt) => {
    acc.current += dt;
    if (acc.current < 1 / hz) return;
    acc.current = 0;
    drawRef.current(scr.ctx, res, h, clock.elapsedTime);
    scr.tex.needsUpdate = true;
  });
  return (
    <group position={position} rotation={rotation}>
      {frame && (
        <mesh position={[0, 0, -0.012]}>
          <boxGeometry args={[size[0] + 0.06, size[1] + 0.06, 0.02]} />
          <meshStandardMaterial color="#1a1d20" roughness={0.5} metalness={0.4} />
        </mesh>
      )}
      <mesh material={mat}>
        <planeGeometry args={size} />
      </mesh>
    </group>
  );
}

/* ----------------------- drawing helpers ----------------------- */

export const SCR = {
  bg: '#0b100c',
  grid: '#1d2a20',
  text: '#dfe8da',
  dim: '#7b8f78',
  accent: '#9fbf6a',
  data: '#c3d8a4',
  good: '#0ca30c',
  warn: '#fab219',
  crit: '#d03b3b',
};

export function clear(g: CanvasRenderingContext2D, w: number, h: number, title?: string) {
  g.fillStyle = SCR.bg;
  g.fillRect(0, 0, w, h);
  if (title) {
    g.fillStyle = SCR.dim;
    g.font = `${Math.round(h * 0.06)}px monospace`;
    g.fillText(title, w * 0.04, h * 0.1);
    g.fillStyle = SCR.accent;
    g.fillRect(w * 0.04, h * 0.125, w * 0.06, 2);
  }
}

export function plot(g: CanvasRenderingContext2D, data: number[], x: number, y: number, w: number, h: number, min: number, max: number, color = SCR.data) {
  g.strokeStyle = SCR.grid;
  g.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    g.beginPath();
    g.moveTo(x, y + (h * i) / 3);
    g.lineTo(x + w, y + (h * i) / 3);
    g.stroke();
  }
  if (data.length < 2) return;
  g.strokeStyle = color;
  g.lineWidth = 2.5;
  g.beginPath();
  data.forEach((v, i) => {
    const px = x + (i / (data.length - 1)) * w;
    const py = y + h - ((v - min) / (max - min || 1)) * h;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  });
  g.stroke();
}

export function bigNumber(g: CanvasRenderingContext2D, label: string, value: string, unit: string, x: number, y: number, size: number, color = SCR.text) {
  g.fillStyle = SCR.dim;
  g.font = `${Math.round(size * 0.32)}px monospace`;
  g.fillText(label, x, y);
  g.fillStyle = color;
  g.font = `${Math.round(size)}px monospace`;
  g.fillText(value, x, y + size * 1.05);
  const vw = g.measureText(value).width;
  g.fillStyle = SCR.dim;
  g.font = `${Math.round(size * 0.36)}px monospace`;
  g.fillText(unit, x + vw + size * 0.15, y + size * 1.05);
}
