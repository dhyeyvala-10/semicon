/**
 * Procedural canvas textures — generated locally at runtime, no external assets.
 */
import * as THREE from 'three';
import { dieGrid, exposureFields, WAFER_D, DIE_W, DIE_H, FIELD_W, FIELD_H, type DieStatus } from '@/simulation/models';
import { rng } from '@/lib/math';

const cache = new Map<string, THREE.Texture>();

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function finish(key: string, c: HTMLCanvasElement, opts: { repeat?: [number, number]; srgb?: boolean; aniso?: number } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (opts.srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
  if (opts.repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(opts.repeat[0], opts.repeat[1]);
  }
  t.anisotropy = opts.aniso ?? 8;
  cache.set(key, t);
  return t;
}

/** Raised-floor perforated tile (600 mm). */
export function floorTile(repeat: [number, number] = [1, 1]): THREE.Texture {
  const key = `floor:${repeat}`;
  if (cache.has(key)) return cache.get(key)!;
  const c = canvas(256, 256);
  const g = c.getContext('2d')!;
  g.fillStyle = '#c8cbc8';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#9da19e';
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    g.beginPath();
    g.arc(14 + x * 15.2, 14 + y * 15.2, 3.4, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = '#7e8380';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, 253, 253);
  return finish(key, c, { repeat });
}

/** Solid tile (non-perforated) for walkways. */
export function plainTile(repeat: [number, number] = [1, 1], color = '#cfd2cf'): THREE.Texture {
  const key = `plain:${repeat}:${color}`;
  if (cache.has(key)) return cache.get(key)!;
  const c = canvas(128, 128);
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 2;
  g.strokeRect(1, 1, 126, 126);
  return finish(key, c, { repeat });
}

/** Concrete / epoxy industrial floor with subtle noise. */
export function concrete(repeat: [number, number] = [4, 4], tint = '#64686a'): THREE.Texture {
  const key = `concrete:${repeat}:${tint}`;
  if (cache.has(key)) return cache.get(key)!;
  const c = canvas(256, 256);
  const g = c.getContext('2d')!;
  g.fillStyle = tint;
  g.fillRect(0, 0, 256, 256);
  const r = rng(3);
  for (let i = 0; i < 2600; i++) {
    const v = Math.floor(r() * 40) - 20;
    g.fillStyle = `rgba(${128 + v},${128 + v},${128 + v},0.08)`;
    g.fillRect(r() * 256, r() * 256, 2 + r() * 3, 2 + r() * 3);
  }
  g.strokeStyle = 'rgba(20,20,20,0.25)';
  g.lineWidth = 2;
  g.strokeRect(0, 0, 256, 256);
  return finish(key, c, { repeat });
}

/** FFU ceiling panel: filter mesh with frame. */
export function ffuPanel(): THREE.Texture {
  const key = 'ffu';
  if (cache.has(key)) return cache.get(key)!;
  const c = canvas(128, 128);
  const g = c.getContext('2d')!;
  g.fillStyle = '#e9ecef';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(120,130,140,0.35)';
  g.lineWidth = 1;
  for (let i = 6; i < 128; i += 5) {
    g.beginPath();
    g.moveTo(i, 6);
    g.lineTo(i, 122);
    g.stroke();
  }
  g.strokeStyle = '#8b9299';
  g.lineWidth = 6;
  g.strokeRect(3, 3, 122, 122);
  return finish(key, c);
}

/** Vent / louvre pattern for machine panels. */
export function louvre(): THREE.Texture {
  const key = 'louvre';
  if (cache.has(key)) return cache.get(key)!;
  const c = canvas(64, 64);
  const g = c.getContext('2d')!;
  g.fillStyle = '#d7d9d4';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#3d4247';
  for (let y = 4; y < 64; y += 8) g.fillRect(6, y, 52, 3);
  return finish(key, c, { repeat: [1, 1] });
}

export type WaferPattern = 'none' | 'fields' | 'dies' | 'pattern' | 'map' | 'diced' | 'exposed';

/**
 * Top-surface texture of a 300 mm wafer. `exposedCount` lights up exposure fields in
 * order (lithography); `map` colours dies by test result.
 */
export function waferTexture(kind: WaferPattern, opts: { exposed?: number; map?: DieStatus[]; tint?: string; size?: number } = {}): THREE.CanvasTexture {
  const size = opts.size ?? 1024;
  const c = canvas(size, size);
  const g = c.getContext('2d')!;
  drawWafer(g, size, kind, opts);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function drawWafer(g: CanvasRenderingContext2D, size: number, kind: WaferPattern, opts: { exposed?: number; map?: DieStatus[]; tint?: string } = {}) {
  const s = size / WAFER_D; // px per mm
  const cx = size / 2;
  g.clearRect(0, 0, size, size);
  g.fillStyle = opts.tint ?? '#9aa1aa';
  g.fillRect(0, 0, size, size);
  if (kind === 'none') return;
  const fields = exposureFields();
  if (kind === 'fields' || kind === 'exposed') {
    const n = opts.exposed ?? fields.length;
    for (const f of fields) {
      const on = f.order < n;
      g.fillStyle = on ? 'rgba(232,170,90,0.55)' : 'rgba(0,0,0,0)';
      g.fillRect(cx + (f.cx - FIELD_W / 2) * s + 1, cx + (f.cy - FIELD_H / 2) * s + 1, FIELD_W * s - 2, FIELD_H * s - 2);
      if (on) {
        g.strokeStyle = 'rgba(255,220,160,0.35)';
        g.lineWidth = 1;
        g.strokeRect(cx + (f.cx - FIELD_W / 2) * s + 1, cx + (f.cy - FIELD_H / 2) * s + 1, FIELD_W * s - 2, FIELD_H * s - 2);
      }
    }
    return;
  }
  const dies = dieGrid();
  const byId = new Map<number, DieStatus>();
  opts.map?.forEach((d) => byId.set(d.die.id, d));
  for (const d of dies) {
    const x = cx + (d.cx - DIE_W / 2) * s;
    const y = cx + (d.cy - DIE_H / 2) * s;
    const w = DIE_W * s;
    const h = DIE_H * s;
    if (kind === 'map') {
      const st = byId.get(d.id);
      g.fillStyle = !st ? '#555' : st.result === 'PASS' ? '#4f9a5a' : st.result === 'FAIL' ? '#c4483b' : '#d1a23a';
      g.fillRect(x + 1.5, y + 1.5, w - 3, h - 3);
      continue;
    }
    // die body with simplified floorplan blocks
    const grad = g.createLinearGradient(x, y, x + w, y + h);
    grad.addColorStop(0, '#6f7d70');
    grad.addColorStop(0.5, '#8a8a6a');
    grad.addColorStop(1, '#5f8274');
    g.fillStyle = grad;
    g.fillRect(x + 1, y + 1, w - 2, h - 2);
    g.fillStyle = 'rgba(28,36,30,0.35)';
    g.fillRect(x + w * 0.08, y + h * 0.08, w * 0.38, h * 0.36);
    g.fillRect(x + w * 0.54, y + h * 0.08, w * 0.38, h * 0.36);
    g.fillStyle = 'rgba(200,190,140,0.28)';
    g.fillRect(x + w * 0.08, y + h * 0.52, w * 0.84, h * 0.22);
    g.fillStyle = 'rgba(210,170,90,0.6)';
    for (let i = 0; i < 8; i++) {
      g.fillRect(x + w * (0.08 + i * 0.11), y + h * 0.86, w * 0.05, h * 0.05);
    }
  }
  if (kind === 'diced') {
    g.strokeStyle = '#1f2326';
    g.lineWidth = Math.max(1, s * 0.6);
    const nx = Math.ceil(WAFER_D / DIE_W) + 1;
    const ny = Math.ceil(WAFER_D / DIE_H) + 1;
    const ox = (dies[0]?.cx ?? 0) - DIE_W / 2;
    const oy = (dies[0]?.cy ?? 0) - DIE_H / 2;
    for (let i = -nx; i <= nx; i++) {
      const xx = cx + (ox + i * DIE_W) * s;
      g.beginPath();
      g.moveTo(xx, 0);
      g.lineTo(xx, size);
      g.stroke();
    }
    for (let j = -ny; j <= ny; j++) {
      const yy = cx + (oy + j * DIE_H) * s;
      g.beginPath();
      g.moveTo(0, yy);
      g.lineTo(size, yy);
      g.stroke();
    }
  }
}

/** Reticle pattern (chrome on quartz): one layer of a die ×4, repeated 2×2 dies. */
export function reticleTexture(): THREE.Texture {
  const key = 'reticle';
  if (cache.has(key)) return cache.get(key)!;
  const S = 1024;
  const c = canvas(S, S);
  const g = c.getContext('2d')!;
  g.fillStyle = '#d6dde0';
  g.fillRect(0, 0, S, S);
  // pattern area 104 x 132 mm on a 152 mm plate → scaled
  const pw = S * (104 / 152);
  const ph = S * (132 / 152);
  const ox = (S - pw) / 2;
  const oy = (S - ph) / 2;
  g.fillStyle = '#2b2f33';
  g.fillRect(ox, oy, pw, ph);
  const r = rng(11);
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const x0 = ox + 6 + dx * (pw / 2);
    const y0 = oy + 6 + dy * (ph / 2);
    const w = pw / 2 - 12;
    const h = ph / 2 - 12;
    g.fillStyle = 'rgba(214,221,224,0.92)';
    // lines-and-spaces blocks (clear areas)
    for (let b = 0; b < 26; b++) {
      const bx = x0 + r() * w * 0.85;
      const by = y0 + r() * h * 0.85;
      const bw = 20 + r() * 60;
      const bh = 20 + r() * 60;
      const horiz = r() > 0.5;
      for (let k = 0; k < (horiz ? bh : bw); k += 4) {
        if (horiz) g.fillRect(bx, by + k, bw, 1.6);
        else g.fillRect(bx + k, by, 1.6, bh);
      }
    }
    g.strokeStyle = 'rgba(214,221,224,0.6)';
    g.strokeRect(x0, y0, w, h);
  }
  // alignment marks
  g.fillStyle = '#2b2f33';
  for (const [mx, my] of [[0.08, 0.08], [0.92, 0.08], [0.08, 0.92], [0.92, 0.92]]) {
    g.fillRect(S * mx - 14, S * my - 2, 28, 4);
    g.fillRect(S * mx - 2, S * my - 14, 4, 28);
  }
  return finish(key, c, { aniso: 16 });
}

/** Display screen content renderer: returns a reusable texture + draw function. */
export function makeScreen(w = 512, h = 320) {
  const c = canvas(w, h);
  const g = c.getContext('2d')!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { canvas: c, ctx: g, tex };
}

/** Package substrate top: copper fingers and solder-mask green. */
export function substrateTexture(): THREE.Texture {
  const key = 'substrate';
  if (cache.has(key)) return cache.get(key)!;
  const S = 512;
  const c = canvas(S, S);
  const g = c.getContext('2d')!;
  g.fillStyle = '#2e5a43';
  g.fillRect(0, 0, S, S);
  g.fillStyle = '#c9a050';
  // bond fingers around a central die area
  for (let i = 0; i < 24; i++) {
    const t = 0.18 + (i / 23) * 0.64;
    g.fillRect(S * t - 3, S * 0.13, 6, 22);
    g.fillRect(S * t - 3, S * 0.87 - 22, 6, 22);
    g.fillRect(S * 0.13, S * t - 3, 22, 6);
    g.fillRect(S * 0.87 - 22, S * t - 3, 22, 6);
  }
  g.fillStyle = 'rgba(200,170,90,0.35)';
  for (let i = 0; i < 60; i++) g.fillRect(S * 0.05 + (i % 10) * 46, S * 0.03 + Math.floor(i / 10) * 3, 30, 1);
  return finish(key, c);
}

/** Generic die floorplan used in system journeys (CPU / GPU), simplified & generic. */
export function dieFloorplan(kind: 'cpu' | 'gpu'): THREE.Texture {
  const key = `floorplan:${kind}`;
  if (cache.has(key)) return cache.get(key)!;
  const S = 1024;
  const c = canvas(S, S);
  const g = c.getContext('2d')!;
  g.fillStyle = '#323d36';
  g.fillRect(0, 0, S, S);
  const block = (x: number, y: number, w: number, h: number, col: string, label?: string) => {
    g.fillStyle = col;
    g.fillRect(x * S, y * S, w * S, h * S);
    g.strokeStyle = 'rgba(0,0,0,0.4)';
    g.lineWidth = 3;
    g.strokeRect(x * S, y * S, w * S, h * S);
    if (label) {
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.font = `${Math.round(S * 0.022)}px monospace`;
      g.fillText(label, x * S + 8, y * S + S * 0.03);
    }
  };
  if (kind === 'cpu') {
    for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) block(0.05 + i * 0.225, 0.06 + j * 0.3, 0.2, 0.26, '#5d7a68', 'CORE');
    block(0.05, 0.66, 0.9, 0.14, '#7d7a5a', 'SHARED CACHE');
    block(0.05, 0.83, 0.42, 0.12, '#58806f', 'MEMORY CTRL');
    block(0.52, 0.83, 0.43, 0.12, '#806f58', 'I/O');
  } else {
    for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) block(0.12 + i * 0.095, 0.1 + j * (j < 2 ? 0.17 : 0.17) + (j >= 2 ? 0.1 : 0), 0.085, 0.15, '#5d7f6c', j === 0 && i === 0 ? 'CU' : undefined);
    block(0.12, 0.44, 0.76, 0.08, '#7d7a5a', 'L2 CACHE');
    block(0.02, 0.1, 0.07, 0.8, '#806f58', 'PHY');
    block(0.91, 0.1, 0.07, 0.8, '#806f58', 'PHY');
    block(0.12, 0.9, 0.76, 0.07, '#58806f', 'I/O · INTERCONNECT');
  }
  return finish(key, c);
}
