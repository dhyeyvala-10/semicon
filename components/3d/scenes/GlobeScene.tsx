'use client';
/**
 * Global distribution (§54, §55). Land outlines from Natural Earth (world-atlas, bundled —
 * works offline). Node placement is ILLUSTRATIVE by broad region, not real facilities or trade
 * data. The followed shipment travels fab → assembly & test → distribution centre → system
 * integrator; the network phase lets you trace where material categories come from.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import { Lighting } from '../environments';
import { useEarthTexture } from '../parts/earth';
import { Clickable, TechLabel } from '../parts/interaction';
import { engine } from '@/simulation/engine';
import { pp } from '@/lib/anim';
import { track, gradeState } from '@/lib/runtime';
import { useUI } from '@/lib/store';
import { smooth, rng } from '@/lib/math';
import { GLOBE_NODES, SHIPMENT_ROUTE, MATERIAL_CATEGORIES } from '@/data/supplychain';
import type { V3 } from '../parts/primitives';

const R = 2;
const BY_ID = Object.fromEntries(GLOBE_NODES.map((n) => [n.id, n]));

/** lat/lon (deg) → position on a sphere of radius r, consistent with SphereGeometry UVs. */
function ll(lat: number, lon: number, r = R): THREE.Vector3 {
  const la = THREE.MathUtils.degToRad(lat);
  const ph = THREE.MathUtils.degToRad(lon + 180);
  return new THREE.Vector3(-r * Math.cos(la) * Math.cos(ph), r * Math.sin(la), r * Math.cos(la) * Math.sin(ph));
}

/** great-circle arc lifted above the surface */
function arc(a: string, b: string, n = 64): V3[] {
  const A = ll(BY_ID[a].lat, BY_ID[a].lon, 1);
  const B = ll(BY_ID[b].lat, BY_ID[b].lon, 1);
  const ang = A.angleTo(B);
  const out: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const v = new THREE.Vector3().copy(A).multiplyScalar(Math.sin((1 - t) * ang) / Math.sin(ang)).add(B.clone().multiplyScalar(Math.sin(t * ang) / Math.sin(ang)));
    v.normalize().multiplyScalar(R * (1 + 0.18 * Math.sin(Math.PI * t) * (ang / Math.PI) * 2 + 0.01));
    out.push(v.toArray() as V3);
  }
  return out;
}

/* ---------------------------------------------------------------- earth */

function Stars() {
  const geo = useMemo(() => {
    const r = rng(3);
    const pts: number[] = [];
    for (let i = 0; i < 900; i++) {
      const v = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize().multiplyScalar(60 + r() * 20);
      pts.push(v.x, v.y, v.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, []);
  return (
    <points geometry={geo}>
      <pointsMaterial color="#d8e2d0" size={0.12} sizeAttenuation transparent opacity={0.6} />
    </points>
  );
}

/* ---------------------------------------------------------------- network */

const SUPPLY_ARCS: [string, string][] = [
  ['eu-eq', 'fab'],
  ['us-eq', 'fab'],
  ['jp-mat', 'fab'],
  ['eu-opt', 'eu-eq'],
  ['gas', 'fab'],
  ['quartz', 'jp-mat'],
];

const ROLE_COLOR = (id: string) => (id === 'fab' ? '#e8c84a' : SHIPMENT_ROUTE.includes(id) ? '#9fd18a' : '#c9b46a');

function Globe() {
  const tex = useEarthTexture();
  const group = useRef<THREE.Group>(null);
  const dot = useRef<THREE.Mesh>(null);
  const [cat, setCat] = useState<string | null>(null);
  const started = useUI((s) => s.started);
  const routeArcs = useMemo(() => SHIPMENT_ROUTE.slice(0, -1).map((a, i) => arc(a, SHIPMENT_ROUTE[i + 1], 80)), []);
  const supplyArcs = useMemo(() => SUPPLY_ARCS.map(([a, b]) => ({ a, b, pts: arc(a, b, 64) })), []);
  const catArcs = useMemo(() => {
    const c = MATERIAL_CATEGORIES.find((m) => m.id === cat);
    return c ? c.origins.filter((o) => o !== 'fab').map((o) => arc(o, 'fab', 64)) : [];
  }, [cat]);
  const rot = useRef(THREE.MathUtils.degToRad(-90 - 121));
  const earthMat = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05, color: '#ffffff' }), []);
  useEffect(() => {
    if (tex) {
      earthMat.map = tex;
      earthMat.needsUpdate = true;
    }
  }, [tex, earthMat]);
  const atmo = useMemo(() => new THREE.MeshBasicMaterial({ color: '#7fa35a', transparent: true, opacity: 0.1, side: THREE.BackSide, depthWrite: false }), []);
  useFrame((_, dt) => {
    const v = engine.player.view;
    const seg = ['fab-osat', 'osat-dc', 'dc-oem'].indexOf(v.phaseId);
    atmo.color.copy(gradeState.accent);
    // shipment dot along the active route segment
    let focusLon = BY_ID.fab.lon;
    if (dot.current) {
      dot.current.visible = seg >= 0;
      if (seg >= 0) {
        const pts = routeArcs[seg];
        const f = smooth(v.phaseT) * (pts.length - 1);
        const i = Math.min(pts.length - 2, Math.floor(f));
        const p = new THREE.Vector3(...pts[i]).lerp(new THREE.Vector3(...pts[i + 1]), f - i);
        dot.current.position.copy(p);
        const a = BY_ID[SHIPMENT_ROUTE[seg]];
        const b = BY_ID[SHIPMENT_ROUTE[seg + 1]];
        let dl = b.lon - a.lon;
        if (dl > 180) dl -= 360;
        if (dl < -180) dl += 360;
        focusLon = a.lon + dl * smooth(v.phaseT);
      }
    }
    if (v.phaseId === 'network') focusLon = 40 + 40 * Math.sin(engine.time * 0.05);
    // turn the globe so the action faces the camera (lon −90 faces +z)
    const target = THREE.MathUtils.degToRad(-90 - focusLon);
    let d = target - rot.current;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    rot.current += d * Math.min(1, dt * 1.5);
    if (group.current) group.current.rotation.y = rot.current;
    track('focus', 0, 0, 0);
  });
  return (
    <group rotation={[0.35, 0, 0]}>
      <group ref={group}>
        <Clickable sel={{ kind: 'component', id: 'globe', label: 'Earth (Natural Earth land outlines)' }}>
          <mesh material={earthMat}>
            <sphereGeometry args={[R, 96, 64]} />
          </mesh>
        </Clickable>
        <mesh material={atmo}>
          <sphereGeometry args={[R * 1.06, 64, 32]} />
        </mesh>
        {GLOBE_NODES.map((n) => {
          const p = ll(n.lat, n.lon, R * 1.005);
          const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), p.clone().normalize());
          return (
            <group key={n.id} position={p} quaternion={q}>
              <Clickable sel={{ kind: 'node', id: n.id, label: n.label, meta: { role: n.role } }}>
                <mesh position={[0, 0.06, 0]}>
                  <cylinderGeometry args={[0.012, 0.012, 0.12, 8]} />
                  <meshBasicMaterial color={ROLE_COLOR(n.id)} toneMapped={false} />
                </mesh>
                <mesh position={[0, 0.13, 0]}>
                  <sphereGeometry args={[0.03, 12, 8]} />
                  <meshBasicMaterial color={ROLE_COLOR(n.id)} toneMapped={false} />
                </mesh>
              </Clickable>
              <TechLabel position={[0.04, 0.2, 0]} title={n.label} lines={[n.role]} min={2} />
            </group>
          );
        })}
        {routeArcs.map((pts, i) => (
          <RouteLine key={i} pts={pts} seg={i} />
        ))}
        {supplyArcs.map((s) => (
          <Line key={`${s.a}-${s.b}`} points={s.pts} color="#c9b46a" lineWidth={1} transparent opacity={0.35} dashed dashSize={0.05} gapSize={0.04} />
        ))}
        {catArcs.map((pts, i) => (
          <Line key={i} points={pts} color="#f0d27a" lineWidth={2.5} />
        ))}
        <mesh ref={dot}>
          <sphereGeometry args={[0.045, 16, 12]} />
          <meshBasicMaterial color="#f4e6a6" toneMapped={false} />
        </mesh>
      </group>
      {started && inPhaseNetwork() && (
        <Html position={[-4.2, 1.6, 0]} zIndexRange={[20, 0]}>
          <div className="level-toggles globe-cats" onPointerDown={(e) => e.stopPropagation()}>
            <div className="cap">MATERIAL CATEGORY</div>
            {MATERIAL_CATEGORIES.map((m) => (
              <button key={m.id} className={`btn sm ${cat === m.id ? 'on' : ''}`} onClick={() => setCat(cat === m.id ? null : m.id)}>
                {m.label}
              </button>
            ))}
            {cat && (
              <div className="chain">
                {MATERIAL_CATEGORIES.find((m) => m.id === cat)!.chain.map((s, i) => (
                  <div key={s}>
                    {i ? '↓ ' : ''}
                    {s}
                  </div>
                ))}
                <div className="dim">origins & routes are ILLUSTRATIVE</div>
              </div>
            )}
          </div>
        </Html>
      )}
    </group>
  );
}

/** re-render trigger for the network panel (phase changes are infrequent) */
function inPhaseNetwork() {
  return engine.player.view.phaseId === 'network';
}

function RouteLine({ pts, seg }: { pts: V3[]; seg: number }) {
  const ref = useRef<{ material: { opacity: number; color: THREE.Color } } | null>(null);
  useFrame(() => {
    const v = engine.player.view;
    const active = ['fab-osat', 'osat-dc', 'dc-oem'].indexOf(v.phaseId) === seg;
    const done = pp(['fab-osat', 'osat-dc', 'dc-oem'][seg]) >= 1;
    if (ref.current) ref.current.material.opacity = active ? 1 : done ? 0.75 : 0.25;
  });
  return <Line ref={ref as never} points={pts} color="#9fd18a" lineWidth={2.2} transparent opacity={0.3} />;
}

export default function GlobeScene() {
  const [, force] = useState(0);
  const last = useRef('');
  useFrame(() => {
    // re-render when entering / leaving the network phase (shows the category panel)
    const k = engine.player.view.phaseId === 'network' ? 'n' : 'r';
    if (k !== last.current) {
      last.current = k;
      force((x) => x + 1);
    }
  });
  return (
    <>
      <Lighting env="void" shadowExtent={4} />
      <Stars />
      <Globe />
      <TechLabel
        position={[-3.6, 2.3, 0]}
        title="GLOBAL DISTRIBUTION · ILLUSTRATIVE"
        lines={['regions are broad and illustrative — not real facilities or trade data']}
        min={1}
        value={() => {
          const v = engine.player.view;
          return `${v.phase.label} · route ≈ ${engine.tele.value('dist', 0).toFixed(0)} km`;
        }}
      />
    </>
  );
}

