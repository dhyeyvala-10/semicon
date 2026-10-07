import type { Comparison } from '@/types';

/** Visual-first comparisons: each opens a 3D scene in a comparison mode; the table is secondary. */
export const COMPARISONS: Comparison[] = [
  {
    id: 'cvd-pvd-ald',
    title: 'CVD vs PVD vs ALD',
    stage: 'deposition',
    mode: { depMode: '0' },
    columns: ['CVD', 'PVD', 'ALD'],
    rows: [
      { label: 'Mechanism', values: ['Gases react on hot surface', 'Atoms sputtered from target', 'Alternating self-limiting pulses'] },
      { label: 'Coverage of steps', values: ['Good', 'Line-of-sight, thin sidewalls', 'Near-perfect (conformal)'] },
      { label: 'Thickness control', values: ['Time & flow', 'Time & power', 'Counted in cycles (~0.1 nm)'] },
      { label: 'Speed', values: ['Fast', 'Fast', 'Slow'] },
      { label: 'Typical use', values: ['Oxides, nitrides, poly, W', 'Barriers, seeds, metals', 'High-k gate, liners, spacers'] },
    ],
  },
  {
    id: 'wet-dry',
    title: 'Wet vs Dry Etching',
    stage: 'etch',
    mode: { etchMode: '1' },
    columns: ['WET', 'DRY (PLASMA)'],
    rows: [
      { label: 'Direction', values: ['Isotropic — all directions', 'Anisotropic — mostly vertical'] },
      { label: 'Profile', values: ['Undercuts the mask', 'Straight sidewalls'] },
      { label: 'Selectivity', values: ['Very high', 'Tunable, lower'] },
      { label: 'Typical use', values: ['Cleaning, oxide strip, large features', 'All fine patterning'] },
    ],
  },
  {
    id: 'planar-finfet-gaa',
    title: 'Planar vs FinFET vs GAA',
    stage: 'architectures',
    columns: ['PLANAR', 'FINFET', 'GAA / NANOSHEET'],
    rows: [
      { label: 'Gate contact with channel', values: ['Top only', 'Three sides', 'All sides'] },
      { label: 'Channel', values: ['Flat surface', 'Vertical fin', 'Stacked horizontal sheets'] },
      { label: 'Short-channel control', values: ['Weakest', 'Strong', 'Strongest'] },
      { label: 'Width tuning', values: ['Continuous', 'Discrete (fin count)', 'Sheet width adjustable'] },
    ],
  },
  {
    id: 'cpu-gpu',
    title: 'CPU vs GPU',
    stage: 'system',
    mode: { journey: '0' },
    columns: ['CPU', 'GPU'],
    rows: [
      { label: 'Compute', values: ['Few large, complex cores', 'Many small parallel cores'] },
      { label: 'On-die memory', values: ['Large caches per core', 'Shared L2, register files'] },
      { label: 'External memory', values: ['DIMMs on motherboard', 'GDDR on board or HBM in package'] },
      { label: 'Mounting', values: ['Socket on motherboard', 'Soldered on add-in card / module'] },
      { label: 'Strength', values: ['Low-latency sequential work', 'High-throughput parallel work'] },
    ],
  },
  {
    id: 'wafer-die',
    title: 'Wafer vs Die',
    stage: 'die-select',
    columns: ['WAFER', 'DIE'],
    rows: [
      { label: 'Size', values: ['300 mm diameter', 'A few mm to ~30 mm per side'] },
      { label: 'Contains', values: ['Hundreds of dies', 'One chip design (billions of transistors)'] },
      { label: 'Handled by', values: ['FOUPs & wafer robots', 'Tape, collets, trays'] },
      { label: 'Stage', values: ['Fab & wafer test', 'Assembly, final test, system'] },
    ],
  },
  {
    id: 'feol-beol',
    title: 'Front-End vs Back-End of Line',
    stage: 'metal-stack',
    columns: ['FEOL', 'BEOL'],
    rows: [
      { label: 'Builds', values: ['Transistors in silicon', 'Metal wiring above transistors'] },
      { label: 'Materials', values: ['Si, oxides, high-k, poly/metal gate, dopants', 'Copper, tungsten, low-k dielectrics, barriers'] },
      { label: 'Temperatures', values: ['Up to ~1000 °C+', 'Limited (~400 °C) to protect metals'] },
      { label: 'Key steps', values: ['Oxidation, implant, anneal, gate patterning', 'Damascene, CMP, vias'] },
    ],
  },
  {
    id: 'manual-auto',
    title: 'Manual vs Automated Handling',
    stage: 'robot-lab',
    columns: ['MANUAL', 'AUTOMATED'],
    rows: [
      { label: 'Contamination', values: ['Humans shed particles', 'Sealed carriers, mini-environments'] },
      { label: 'Repeatability', values: ['Variable', 'Sub-millimetre, every time'] },
      { label: 'Throughput', values: ['Limited, fatigue', 'Continuous 24/7'] },
      { label: '300 mm practice', values: ['Impractical (heavy FOUPs, ergonomics)', 'Standard (OHT + EFEM robots)'] },
    ],
  },
];
