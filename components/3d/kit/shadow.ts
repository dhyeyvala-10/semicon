/**
 * Shadow-only casters. A detailed model is drawn with one mesh per finish, but its shadow
 * needs only positions: all casting parts are concatenated into one geometry that lives on
 * SHADOW_LAYER. The key light's shadow camera renders that layer, the main camera does not,
 * so the shadow pass costs one draw call per model instead of one per finish.
 */
import * as THREE from 'three';

export const SHADOW_LAYER = 7;

const CASTER_MAT = new THREE.MeshBasicMaterial();
const noRay = () => {};

/**
 * Positions of every triangle of the given (non-indexed) geometries, minus slivers smaller
 * than `minArea` m² (bolt heads, rims, fins), whose shadows fall below a shadow-map texel.
 */
export function casterGeometry(geos: THREE.BufferGeometry[], minArea = 4e-4): THREE.BufferGeometry | null {
  const keep: number[] = [];
  const min2 = 4 * minArea * minArea;
  for (const g of geos) {
    const a = g.attributes.position.array as Float32Array;
    for (let i = 0; i + 8 < a.length; i += 9) {
      const ux = a[i + 3] - a[i], uy = a[i + 4] - a[i + 1], uz = a[i + 5] - a[i + 2];
      const vx = a[i + 6] - a[i], vy = a[i + 7] - a[i + 1], vz = a[i + 8] - a[i + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (cx * cx + cy * cy + cz * cz >= min2) for (let j = 0; j < 9; j++) keep.push(a[i + j]);
    }
  }
  if (!keep.length) return null;
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(new Float32Array(keep), 3));
  out.computeBoundingSphere();
  return out;
}

/** A mesh that only the shadow camera sees. */
export function shadowOnly(geo: THREE.BufferGeometry): THREE.Mesh {
  const m = new THREE.Mesh(geo, CASTER_MAT);
  m.castShadow = true;
  m.receiveShadow = false;
  m.layers.set(SHADOW_LAYER);
  m.raycast = noRay;
  return m;
}
