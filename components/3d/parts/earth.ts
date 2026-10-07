'use client';
/**
 * Earth texture from Natural Earth land outlines (world-atlas, bundled → works offline),
 * drawn into an equirectangular canvas in the journey's green palette.
 */
import * as THREE from 'three';
import { useEffect, useState } from 'react';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';

let cached: THREE.CanvasTexture | null = null;

export function useEarthTexture() {
  const [tex, setTex] = useState<THREE.CanvasTexture | null>(cached);
  useEffect(() => {
    if (cached) return;
    let alive = true;
    import('world-atlas/land-110m.json').then((m) => {
      if (!alive) return;
      const topo = (m.default ?? m) as unknown as Topology<{ land: GeometryCollection }>;
      const land = feature(topo, topo.objects.land) as unknown as FeatureCollection<Polygon | MultiPolygon>;
      const W = 2048;
      const H = 1024;
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d')!;
      g.fillStyle = '#0d1611';
      g.fillRect(0, 0, W, H);
      // graticule
      g.strokeStyle = 'rgba(127,163,90,0.10)';
      g.lineWidth = 1;
      for (let lon = -180; lon <= 180; lon += 15) {
        g.beginPath();
        g.moveTo(((lon + 180) / 360) * W, 0);
        g.lineTo(((lon + 180) / 360) * W, H);
        g.stroke();
      }
      for (let lat = -75; lat <= 75; lat += 15) {
        g.beginPath();
        g.moveTo(0, ((90 - lat) / 180) * H);
        g.lineTo(W, ((90 - lat) / 180) * H);
        g.stroke();
      }
      const P = ([lon, lat]: number[]) => [((lon + 180) / 360) * W, ((90 - lat) / 180) * H] as const;
      g.fillStyle = '#34503a';
      g.strokeStyle = 'rgba(169,207,154,0.55)';
      g.lineWidth = 1.2;
      for (const f of land.features) {
        const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        for (const poly of polys) {
          g.beginPath();
          for (const ring of poly) {
            ring.forEach((pt, i) => {
              const [x, y] = P(pt);
              if (i === 0) g.moveTo(x, y);
              else g.lineTo(x, y);
            });
            g.closePath();
          }
          g.fill('evenodd');
          g.stroke();
        }
      }
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      cached = t;
      setTex(t);
    });
    return () => {
      alive = false;
    };
  }, []);
  return tex;
}

