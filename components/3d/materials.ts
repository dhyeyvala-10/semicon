/**
 * Shared material library. Reusing material instances keeps shader programs and
 * draw-state changes low. Colours aim at industrial realism: painted steel panels,
 * brushed stainless, anodised aluminium, glass, quartz, silicon.
 */
import * as THREE from 'three';
import { cutPlane } from '@/lib/runtime';
import type { ViewMode } from '@/types';

const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);
const phys = (p: THREE.MeshPhysicalMaterialParameters) => new THREE.MeshPhysicalMaterial(p);

export const M = {
  panel: std({ color: '#c9ccc5', roughness: 0.5, metalness: 0.1 }),
  panelWarm: std({ color: '#c8c3b4', roughness: 0.55, metalness: 0.06 }),
  panelGrey: std({ color: '#7f8681', roughness: 0.5, metalness: 0.25 }),
  panelDark: std({ color: '#2a2e33', roughness: 0.5, metalness: 0.3 }),
  frame: std({ color: '#3b4147', roughness: 0.45, metalness: 0.55 }),
  steel: std({ color: '#b9bec4', roughness: 0.32, metalness: 0.9 }),
  steelDark: std({ color: '#6f757b', roughness: 0.35, metalness: 0.85 }),
  brushed: std({ color: '#c6c9cc', roughness: 0.42, metalness: 0.75 }),
  alu: std({ color: '#a7adb3', roughness: 0.38, metalness: 0.8 }),
  black: std({ color: '#141618', roughness: 0.6, metalness: 0.1 }),
  rubber: std({ color: '#1b1c1e', roughness: 0.9, metalness: 0 }),
  plastic: std({ color: '#e7e5df', roughness: 0.45, metalness: 0 }),
  foupShell: phys({ color: '#c9d2d6', roughness: 0.25, metalness: 0, transparent: true, opacity: 0.55, transmission: 0, thickness: 0.01 }),
  foupDark: std({ color: '#3a4044', roughness: 0.4, metalness: 0.1 }),
  glass: phys({ color: '#9fb4bf', roughness: 0.08, metalness: 0, transparent: true, opacity: 0.18, depthWrite: false }),
  glassDark: phys({ color: '#1d2a30', roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.55 }),
  quartz: phys({ color: '#e8eef0', roughness: 0.12, metalness: 0, transparent: true, opacity: 0.3, depthWrite: false }),
  ceramic: std({ color: '#efece6', roughness: 0.35, metalness: 0 }),
  graphite: std({ color: '#2b2b2c', roughness: 0.75, metalness: 0.2 }),
  copper: std({ color: '#c47b4a', roughness: 0.3, metalness: 1 }),
  gold: std({ color: '#d9a944', roughness: 0.28, metalness: 1 }),
  tungsten: std({ color: '#8c8f94', roughness: 0.35, metalness: 1 }),
  siPolished: std({ color: '#8f97a3', roughness: 0.07, metalness: 0.92 }),
  siRough: std({ color: '#6c7178', roughness: 0.75, metalness: 0.5 }),
  siCrystal: std({ color: '#7d848d', roughness: 0.18, metalness: 0.88 }),
  siMelt: std({ color: '#ffd9a0', emissive: new THREE.Color('#ff9a3d'), emissiveIntensity: 1.6, roughness: 0.2, metalness: 0.4 }),
  oxide: phys({ color: '#5f86b8', roughness: 0.15, metalness: 0, transparent: true, opacity: 0.7 }),
  nitride: std({ color: '#b7a77d', roughness: 0.4, metalness: 0 }),
  resist: phys({ color: '#b5612a', roughness: 0.25, metalness: 0, transparent: true, opacity: 0.85 }),
  resistExposed: phys({ color: '#d99545', roughness: 0.3, metalness: 0, transparent: true, opacity: 0.85 }),
  substrate: std({ color: '#3d566e', roughness: 0.55, metalness: 0.1 }),
  pcb: std({ color: '#1f4a35', roughness: 0.5, metalness: 0.1 }),
  pcbBrown: std({ color: '#5b4230', roughness: 0.55, metalness: 0.1 }),
  mold: std({ color: '#1c1d20', roughness: 0.7, metalness: 0 }),
  concrete: std({ color: '#5b5e60', roughness: 0.92, metalness: 0 }),
  floor: std({ color: '#c9ccc9', roughness: 0.35, metalness: 0.1 }),
  yellow: std({ color: '#d8a62a', roughness: 0.5, metalness: 0.1 }),
  safety: std({ color: '#c7a32b', roughness: 0.6, metalness: 0 }),
  blueAccent: std({ color: '#4d6b4a', roughness: 0.5, metalness: 0.2 }),
  orangeAccent: std({ color: '#c06a2b', roughness: 0.5, metalness: 0.2 }),
  greenAccent: std({ color: '#6b7a3c', roughness: 0.5, metalness: 0.2 }),
  screen: std({ color: '#0d140f', emissive: new THREE.Color('#33553a'), emissiveIntensity: 0.6, roughness: 0.3 }),
  lightPanel: std({ color: '#ffffff', emissive: new THREE.Color('#f2f5f7'), emissiveIntensity: 1.2, roughness: 0.6 }),
  lightAmber: std({ color: '#ffd28a', emissive: new THREE.Color('#ffb54d'), emissiveIntensity: 1.1, roughness: 0.6 }),
};

/** X-ray: shells become a faint technical ghost so internals are visible (§107). */
export const XRAY = new THREE.MeshStandardMaterial({
  color: '#b9d6a8',
  transparent: true,
  opacity: 0.1,
  depthWrite: false,
  roughness: 0.5,
  metalness: 0,
  side: THREE.DoubleSide,
});
export const XRAY_EDGE = new THREE.LineBasicMaterial({ color: '#a9c79a', transparent: true, opacity: 0.35 });

const clipped = new WeakMap<THREE.Material, THREE.Material>();
/** Clone of a material that is cut by the global cutaway plane (§25, §62). */
export function clippedOf(m: THREE.Material): THREE.Material {
  let c = clipped.get(m);
  if (!c) {
    c = m.clone();
    c.clippingPlanes = [cutPlane];
    c.side = THREE.DoubleSide;
    clipped.set(m, c);
  }
  return c;
}

/** Material for an outer shell given the current view mode. */
export function shell(m: THREE.Material, view: ViewMode): THREE.Material {
  if (view === 'xray') return XRAY;
  if (view === 'cutaway' || view === 'section') return clippedOf(m);
  return m;
}

/** State colours (machine state lights / UI) — muted industrial palette. */
export const STATE_COLOR: Record<string, string> = {
  IDLE: '#d4a03a',
  LOADING: '#7fbf6a',
  PROCESSING: '#5fbf5a',
  UNLOADING: '#7fbf6a',
  MAINTENANCE: '#a99bd6',
  ALARM: '#e0503f',
  OFFLINE: '#55595e',
};

/** Effective shell view: looking “inside” a machine automatically cuts its shell away. */
export function effectiveView(view: ViewMode, cameraMode: string, internal: ViewMode = 'cutaway'): ViewMode {
  if (view !== 'normal') return view;
  return cameraMode === 'internal' || cameraMode === 'wafer' || cameraMode === 'micro' ? internal : 'normal';
}
