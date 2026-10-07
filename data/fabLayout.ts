/**
 * Layout of the virtual cleanroom (world units = metres).
 * Bay-and-chase layout: a central spine (inter-bay AMHS) with process bays to the
 * north (+z) and south (−z). Tools face the bay aisle; load ports sit under the
 * overhead-hoist rail. Purely an educational, generic layout.
 */

export type ToolType = 'litho' | 'etch' | 'dep' | 'furnace' | 'implant' | 'rtp' | 'cmp' | 'metro' | 'wet' | 'stocker';

export interface Bay {
  id: string;
  name: string;
  x: number;
  side: 1 | -1; // +1 north, −1 south
  type: ToolType;
  machine: string; // representative machine def id
  stage: string; // journey stage to open when visiting
  light: 'white' | 'amber';
}

export interface ToolInstance {
  id: string;
  type: ToolType;
  bay: string;
  machine: string;
  /** front-face centre position */
  x: number;
  z: number;
  /** rotation about Y so local +X faces the bay aisle */
  rot: number;
  /** footprint along aisle (local z) and depth away from aisle (local x) */
  length: number;
  depth: number;
  /** load-port FOUP positions (world) */
  ports: { x: number; z: number }[];
  /** nominal process time (simulation seconds, time-compressed) */
  processTime: number;
}

export const FAB = {
  minX: -44,
  maxX: 44,
  minZ: -18,
  maxZ: 18,
  ceiling: 5,
  ohtY: 4.1,
  spineZ: 1.6,
  bayStart: 3.2,
  bayEnd: 16.6,
  railOffset: 2.3,
  toolFront: 2.75,
};

export const BAY_X = [-35, -21, -7, 7, 21, 35];

export const BAYS: Bay[] = [
  { id: 'litho-a', name: 'LITHOGRAPHY BAY A', x: -35, side: 1, type: 'litho', machine: 'scanner', stage: 'lithography', light: 'amber' },
  { id: 'litho-b', name: 'LITHOGRAPHY BAY B', x: -21, side: 1, type: 'litho', machine: 'scanner', stage: 'alignment', light: 'amber' },
  { id: 'etch-a', name: 'ETCH BAY', x: -7, side: 1, type: 'etch', machine: 'etcher', stage: 'etch', light: 'white' },
  { id: 'dep-a', name: 'DEPOSITION BAY', x: 7, side: 1, type: 'dep', machine: 'dep-cluster', stage: 'deposition', light: 'white' },
  { id: 'cmp-a', name: 'CMP BAY', x: 21, side: 1, type: 'cmp', machine: 'cmp', stage: 'cmp', light: 'white' },
  { id: 'metro-a', name: 'METROLOGY & INSPECTION BAY', x: 35, side: 1, type: 'metro', machine: 'metrology', stage: 'metrology', light: 'white' },
  { id: 'diff-a', name: 'DIFFUSION / FURNACE BAY', x: -35, side: -1, type: 'furnace', machine: 'furnace', stage: 'oxidation', light: 'white' },
  { id: 'imp-a', name: 'IMPLANT BAY', x: -21, side: -1, type: 'implant', machine: 'implanter', stage: 'implant', light: 'white' },
  { id: 'rtp-a', name: 'RTP / ANNEAL BAY', x: -7, side: -1, type: 'rtp', machine: 'rtp', stage: 'anneal', light: 'white' },
  { id: 'wet-a', name: 'WET CLEAN BAY', x: 7, side: -1, type: 'wet', machine: 'wet-bench', stage: 'wafer-clean', light: 'white' },
  { id: 'etch-b', name: 'ETCH / STRIP BAY B', x: 21, side: -1, type: 'etch', machine: 'asher', stage: 'resist-strip', light: 'white' },
  { id: 'dep-b', name: 'DEPOSITION BAY B', x: 35, side: -1, type: 'dep', machine: 'dep-cluster', stage: 'deposition-2', light: 'white' },
];

/** local x of FOUP centre on a load port (in front of the tool face, toward the aisle) */
export const PORT_LX = FAB.toolFront - FAB.railOffset;
/** local z of the track (loading) end of a litho cell */
export const LITHO_TRACK_Z = 2.6;

/** Transform a tool-local (x toward aisle, z along aisle) offset to world XZ. */
export function localToWorld(x: number, z: number, rot: number, lx: number, lz: number) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return { x: x + c * lx + s * lz, z: z - s * lx + c * lz };
}

const SIZE: Record<ToolType, { length: number; depth: number; per: number; time: number; ports: number }> = {
  litho: { length: 9.5, depth: 4.2, per: 1, time: 22, ports: 2 },
  etch: { length: 3.6, depth: 4.0, per: 3, time: 26, ports: 3 },
  dep: { length: 3.6, depth: 4.0, per: 3, time: 28, ports: 3 },
  furnace: { length: 2.6, depth: 3.6, per: 4, time: 60, ports: 2 },
  implant: { length: 6.2, depth: 3.6, per: 2, time: 24, ports: 2 },
  rtp: { length: 3.0, depth: 3.2, per: 3, time: 14, ports: 2 },
  cmp: { length: 4.2, depth: 4.0, per: 3, time: 26, ports: 2 },
  metro: { length: 2.8, depth: 3.0, per: 4, time: 10, ports: 2 },
  wet: { length: 6.0, depth: 2.6, per: 2, time: 30, ports: 3 },
  stocker: { length: 6.0, depth: 3.0, per: 1, time: 0, ports: 2 },
};

const PREFIX: Record<ToolType, string> = {
  litho: 'LITHO',
  etch: 'ETCH',
  dep: 'DEP',
  furnace: 'FURN',
  implant: 'IMP',
  rtp: 'RTP',
  cmp: 'CMP',
  metro: 'METRO',
  wet: 'WET',
  stocker: 'STK',
};

function buildTools(): ToolInstance[] {
  const tools: ToolInstance[] = [];
  const counters: Record<string, number> = {};
  for (const bay of BAYS) {
    const sz = SIZE[bay.type];
    const span = FAB.bayEnd - FAB.bayStart;
    for (const lr of [-1, 1] as const) {
      // lr = −1: tool on west side of aisle (front faces +x); +1: east side (faces −x)
      for (let k = 0; k < sz.per; k++) {
        const pitch = span / sz.per;
        const along = FAB.bayStart + pitch * (k + 0.5);
        const z = bay.side * along;
        const x = bay.x + lr * FAB.toolFront;
        counters[bay.type] = (counters[bay.type] ?? 0) + 1;
        const id = `${PREFIX[bay.type]}-${String(counters[bay.type]).padStart(2, '0')}`;
        const rot = lr === -1 ? 0 : Math.PI; // local +x = facing aisle
        const ports: { x: number; z: number }[] = [];
        const pl = Math.min(sz.length - 0.6, sz.ports * 0.62);
        for (let p = 0; p < sz.ports; p++) {
          const off = sz.ports === 1 ? 0 : -pl / 2 + (pl / (sz.ports - 1)) * p;
          // litho cells load through the track at local +z end
          const lz = off + (bay.type === 'litho' ? LITHO_TRACK_Z : 0);
          ports.push(localToWorld(x, z, rot, PORT_LX, lz));
        }
        tools.push({
          id,
          type: bay.type,
          bay: bay.id,
          machine: bay.machine,
          x,
          z,
          rot,
          length: Math.min(sz.length, pitch - 0.4),
          depth: sz.depth,
          ports,
          processTime: sz.time,
        });
      }
    }
  }
  // stockers at both ends of the spine, loading under the loop's end segments
  const ends: [number, number][] = [
    [FAB.minX + 4 - PORT_LX, 0],
    [FAB.maxX - 4 + PORT_LX, Math.PI],
  ];
  ends.forEach(([sx, rot], i) => {
    tools.push({
      id: `STK-0${i + 1}`,
      type: 'stocker',
      bay: 'spine',
      machine: 'efem',
      x: sx,
      z: 0,
      rot,
      length: 6,
      depth: 3,
      ports: [-0.8, 0.8].map((lz) => localToWorld(sx, 0, rot, PORT_LX, lz)),
      processTime: 0,
    });
  });
  return tools;
}

export const TOOLS: ToolInstance[] = buildTools();
export const TOOL_BY_ID: Record<string, ToolInstance> = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

/**
 * Single directed OHT loop visiting every bay (spine north rail eastbound with
 * excursions into north bays, then south rail westbound with excursions into south bays).
 */
function buildOhtLoop(): [number, number][] {
  const pts: [number, number][] = [];
  const { spineZ, railOffset, bayEnd } = FAB;
  const west = FAB.minX + 4;
  const east = FAB.maxX - 4;
  pts.push([west, spineZ]);
  for (const bx of BAY_X) {
    pts.push([bx - railOffset, spineZ]);
    pts.push([bx - railOffset, bayEnd]);
    pts.push([bx + railOffset, bayEnd]);
    pts.push([bx + railOffset, spineZ]);
  }
  pts.push([east, spineZ]);
  pts.push([east, -spineZ]);
  for (const bx of [...BAY_X].reverse()) {
    pts.push([bx + railOffset, -spineZ]);
    pts.push([bx + railOffset, -bayEnd]);
    pts.push([bx - railOffset, -bayEnd]);
    pts.push([bx - railOffset, -spineZ]);
  }
  pts.push([west, -spineZ]);
  return pts;
}

export const OHT_LOOP: [number, number][] = buildOhtLoop();

/** Re-entrant route of one simplified “layer loop”. */
export const LAYER_ROUTE: ToolType[] = ['wet', 'furnace', 'dep', 'litho', 'etch', 'wet', 'implant', 'rtp', 'dep', 'cmp', 'metro'];
export const ROUTE_LOOPS = 3;

export const TOOL_TYPE_NAME: Record<ToolType, string> = {
  litho: 'Lithography cell (scanner + track)',
  etch: 'Plasma etch cluster',
  dep: 'Deposition cluster',
  furnace: 'Vertical furnace',
  implant: 'Ion implanter',
  rtp: 'RTP anneal',
  cmp: 'CMP polisher',
  metro: 'Metrology / inspection',
  wet: 'Wet clean station',
  stocker: 'Stocker',
};

/** Points of interest for the fab map overlay. */
export const FAB_LOCATIONS = [
  ...BAYS.map((b) => ({ id: b.id, label: b.name, x: b.x, z: b.side * 10, kind: 'bay' as const, stage: b.stage })),
  { id: 'spine', label: 'AMHS SPINE / STOCKERS', x: 0, z: 0, kind: 'spine' as const, stage: 'fab-overview' },
];
