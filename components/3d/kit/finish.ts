/**
 * Surface finishes for the detailed equipment models: powder-coated panels, brushed
 * stainless, anodised aluminium, chrome, rubber, glass. Micro-surface comes from small
 * procedural maps generated once at runtime (no image assets). Kit geometry carries
 * world-scaled UVs, so every map has the same texel density on every part.
 */
import * as THREE from 'three';
import { rng } from '@/lib/math';

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function dataTex(c: HTMLCanvasElement, repeat = 1) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

let _paint: THREE.Texture | null = null;
/** Soft value noise around mid-grey: orange-peel paint / cast surfaces (roughness + bump). */
function paintNoise() {
  if (_paint) return _paint;
  const S = 256;
  const c = canvas(S, S);
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  const r = rng(7);
  // two octaves of tiled value noise
  const grid = (n: number) => Array.from({ length: n * n }, () => r());
  const o1 = grid(16);
  const o2 = grid(64);
  const sample = (o: number[], n: number, x: number, y: number) => {
    const fx = (x / S) * n;
    const fy = (y / S) * n;
    const x0 = Math.floor(fx) % n;
    const y0 = Math.floor(fy) % n;
    const x1 = (x0 + 1) % n;
    const y1 = (y0 + 1) % n;
    const tx = fx - Math.floor(fx);
    const ty = fy - Math.floor(fy);
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const a = o[y0 * n + x0] * (1 - sx) + o[y0 * n + x1] * sx;
    const b = o[y1 * n + x0] * (1 - sx) + o[y1 * n + x1] * sx;
    return a * (1 - sy) + b * sy;
  };
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const v = 0.5 + 0.22 * (sample(o1, 16, x, y) - 0.5) + 0.18 * (sample(o2, 64, x, y) - 0.5);
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(v * 255);
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  _paint = dataTex(c);
  return _paint;
}

let _brush: THREE.Texture | null = null;
/** Fine linear streaks: brushed / ground metal. */
function brushNoise() {
  if (_brush) return _brush;
  const W = 512;
  const H = 128;
  const c = canvas(W, H);
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgb(128,128,128)';
  g.fillRect(0, 0, W, H);
  const r = rng(11);
  for (let i = 0; i < 2600; i++) {
    const y = r() * H;
    const x = r() * W;
    const len = 40 + r() * 260;
    const v = Math.round(90 + r() * 80);
    g.strokeStyle = `rgba(${v},${v},${v},${0.25 + r() * 0.35})`;
    g.lineWidth = 0.5 + r() * 0.9;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + len, y + (r() - 0.5) * 0.6);
    g.stroke();
    // wrap so the map tiles
    if (x + len > W) {
      g.beginPath();
      g.moveTo(x - W, y);
      g.lineTo(x + len - W, y);
      g.stroke();
    }
  }
  _brush = dataTex(c);
  return _brush;
}

const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);
const phys = (p: THREE.MeshPhysicalMaterialParameters) => new THREE.MeshPhysicalMaterial(p);

function painted(color: string, roughness: number, metalness = 0.04) {
  return std({ color, roughness, metalness, roughnessMap: paintNoise(), bumpMap: paintNoise(), bumpScale: 0.35 });
}
function metal(color: string, roughness: number, brushed = true) {
  return std({ color, roughness, metalness: 1, roughnessMap: brushed ? brushNoise() : paintNoise() });
}

/** Kit materials. Shared instances: one shader program per finish, few state changes. */
export const KM = {
  /** semiconductor-tool off-white powder coat */
  paint: painted('#dadcd8', 0.46),
  paintWarm: painted('#d6d2c6', 0.5),
  paintGrey: painted('#8e9490', 0.5, 0.1),
  paintDark: painted('#3a3f43', 0.5, 0.15),
  paintGraphite: painted('#22262a', 0.55, 0.2),
  /** brand accent stripe (muted green, matches the journey palette) */
  paintAccent: painted('#56745a', 0.45, 0.1),
  paintYellow: painted('#d7a634', 0.5),
  paintRed: painted('#a8342b', 0.45),
  paintBlue: painted('#33536b', 0.45, 0.1),
  stainless: metal('#cdd1d4', 0.3),
  stainlessDark: metal('#9aa0a6', 0.36),
  steel: metal('#8e949a', 0.42, false),
  anodized: metal('#a9afb4', 0.4),
  anodizedDark: metal('#4a5056', 0.42),
  chrome: std({ color: '#eceef0', roughness: 0.06, metalness: 1 }),
  copper: metal('#c9875a', 0.32),
  brass: metal('#c7a35c', 0.34),
  rubber: std({ color: '#17181a', roughness: 0.92, metalness: 0 }),
  plastic: std({ color: '#1f2225', roughness: 0.55, metalness: 0, roughnessMap: paintNoise() }),
  plasticWhite: std({ color: '#ecebe6', roughness: 0.5, metalness: 0, roughnessMap: paintNoise() }),
  ptfe: std({ color: '#f1efe9', roughness: 0.65, metalness: 0 }),
  /** panel gaps and recesses */
  seam: std({ color: '#121416', roughness: 0.8, metalness: 0 }),
  glass: phys({ color: '#b6cbd3', roughness: 0.04, metalness: 0, transparent: true, opacity: 0.2, depthWrite: false, envMapIntensity: 1.6 }),
  glassSmoke: phys({ color: '#22313a', roughness: 0.06, metalness: 0.1, transparent: true, opacity: 0.62, envMapIntensity: 1.4 }),
  screen: std({ color: '#0b120e', emissive: new THREE.Color('#2f5a3c'), emissiveIntensity: 0.55, roughness: 0.25 }),
  ledGreen: std({ color: '#6fd06a', emissive: new THREE.Color('#5fbf5a'), emissiveIntensity: 1.6, roughness: 0.4, toneMapped: false }),
  ledAmber: std({ color: '#f0b54a', emissive: new THREE.Color('#e0a23a'), emissiveIntensity: 1.5, roughness: 0.4, toneMapped: false }),
  ledWhite: std({ color: '#ffffff', emissive: new THREE.Color('#f4f7f6'), emissiveIntensity: 1.3, roughness: 0.5 }),
};

export type KitMaterial = THREE.Material;

/* ------------------------------------------------------------------ labels */

const labelCache = new Map<string, THREE.MeshStandardMaterial>();

/**
 * Label plates drawn on a canvas: model plates, hazard warnings, gas-line tags,
 * serial plates. Returned as a material for a plane of the given aspect.
 */
export function labelMaterial(kind: 'model' | 'warn' | 'info' | 'gas' | 'tag', text: string, sub = '', accent = '#56745a'): THREE.MeshStandardMaterial {
  const key = `${kind}|${text}|${sub}|${accent}`;
  const hit = labelCache.get(key);
  if (hit) return hit;
  const W = kind === 'warn' ? 256 : 512;
  const H = kind === 'warn' ? 256 : kind === 'gas' ? 96 : 128;
  const c = canvas(W, H);
  const g = c.getContext('2d')!;
  const mono = '"JetBrains Mono", ui-monospace, monospace';
  const sans = 'Inter, system-ui, sans-serif';
  if (kind === 'model') {
    g.fillStyle = '#1b1f22';
    g.fillRect(0, 0, W, H);
    g.fillStyle = accent;
    g.fillRect(0, 0, 14, H);
    g.fillStyle = '#e9ece8';
    g.font = `600 ${H * 0.36}px ${sans}`;
    g.textBaseline = 'middle';
    g.fillText(text, 34, H * 0.4);
    g.fillStyle = '#9aa29c';
    g.font = `${H * 0.17}px ${mono}`;
    g.fillText(sub, 36, H * 0.76);
  } else if (kind === 'warn') {
    g.fillStyle = '#e1b52c';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = '#111';
    g.lineWidth = 14;
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(W / 2, 30);
    g.lineTo(W - 34, H - 64);
    g.lineTo(34, H - 64);
    g.closePath();
    g.stroke();
    g.fillStyle = '#111';
    g.font = `900 ${H * 0.34}px ${sans}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('!', W / 2, H * 0.5);
    g.font = `700 ${H * 0.1}px ${sans}`;
    g.fillText(text, W / 2, H - 30);
  } else if (kind === 'gas') {
    g.fillStyle = accent;
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#ffffff';
    g.font = `700 ${H * 0.52}px ${mono}`;
    g.textBaseline = 'middle';
    g.fillText(text, 26, H / 2);
    // flow arrow
    g.beginPath();
    g.moveTo(W - 110, H * 0.3);
    g.lineTo(W - 40, H * 0.5);
    g.lineTo(W - 110, H * 0.7);
    g.closePath();
    g.fill();
  } else {
    g.fillStyle = kind === 'tag' ? '#e8e6df' : '#cfd3d0';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = '#555';
    g.lineWidth = 4;
    g.strokeRect(4, 4, W - 8, H - 8);
    g.fillStyle = '#1b1d1f';
    g.font = `600 ${H * 0.3}px ${mono}`;
    g.textBaseline = 'middle';
    g.fillText(text, 22, H * 0.38);
    g.fillStyle = '#555';
    g.font = `${H * 0.17}px ${mono}`;
    g.fillText(sub, 22, H * 0.74);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.5, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  labelCache.set(key, m);
  return m;
}

/* ----------------------------------------------------------- ground contact */

let _ao: THREE.MeshBasicMaterial | null = null;
/** Soft contact shadow (baked ambient occlusion) under equipment footprints. */
export function aoMaterial() {
  if (_ao) return _ao;
  const S = 128;
  const c = canvas(S, S);
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      // rounded-rectangle falloff: dense under the footprint, fading past its edge
      const u = Math.abs(x / (S - 1) - 0.5) * 2;
      const v = Math.abs(y / (S - 1) - 0.5) * 2;
      const d = Math.pow(Math.pow(u, 6) + Math.pow(v, 6), 1 / 6);
      const a = Math.max(0, Math.min(1, (1 - d) / 0.42));
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
      img.data[i + 3] = Math.round(255 * a * a * (3 - 2 * a));
    }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  _ao = new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.62, depthWrite: false, color: '#000000', polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  return _ao;
}
