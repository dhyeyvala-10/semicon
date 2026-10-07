/**
 * Mutable, non-React registries shared between the 3D layer and the DOM overlay.
 * Updated every frame without triggering React renders.
 */
import * as THREE from 'three';

/** World positions of trackable objects (wafer, FOUP, die, package…) published by scenes. */
export const tracked = new Map<string, THREE.Vector3>();

export function track(id: string, x: number, y: number, z: number) {
  let v = tracked.get(id);
  if (!v) {
    v = new THREE.Vector3();
    tracked.set(id, v);
  }
  v.set(x, y, z);
}

/** Regions with a different physical scale (e.g. magnified cross-section insets). */
export interface ScaleRegion {
  id: string;
  center: THREE.Vector3;
  radius: number;
  mpu: number;
  label?: string;
}
export const scaleRegions = new Map<string, ScaleRegion>();

/** Live scale readout (written by ScaleProbe). */
export const scaleState = {
  metersPerPixel: 0.01,
  viewWidth: 10,
  schematic: false,
  label: '',
  version: 0,
};

/** Renderer statistics (written by DebugProbe). */
export const renderStats = {
  calls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  programs: 0,
  dpr: 1,
  version: 0,
};

/** Hover label shown near the pointer. */
export const hoverState = {
  label: '',
  kind: '',
  x: 0,
  y: 0,
  version: 0,
};

/** Global cutaway clipping plane (scenes set its orientation). */
export const cutPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
export const NO_CLIP = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6);

/** Camera handle for overlays that need projection (set by CameraRig). */
export const cameraRef: { current: THREE.PerspectiveCamera | null } = { current: null };

/** When a scene drives the camera itself (e.g. the cinematic intro), the rig stands by. */
export const cameraDriver = { scene: false };

/** Current journey colour grade (linear RGB), written by the GradeDriver, read by 3D lighting. */
export const gradeState = {
  accent: new THREE.Color('#7fa35a'),
  glow: new THREE.Color('#b9d29a'),
  deep: new THREE.Color('#1b2418'),
  t: 0.4,
  version: 0,
};
