import type { DataKind } from '@/types';

/** Descriptions for clickable sub-objects that are not machines/robots/sensors. */
export interface ObjectInfo {
  title: string;
  category: string;
  description: string;
  kind?: DataKind;
}

export const OBJECTS: Record<string, ObjectInfo> = {
  /* transistor (simplified device model) */
  substrate: { title: 'Silicon substrate', category: 'Device · FEOL', description: 'Lightly doped single-crystal silicon. The transistor channel forms at its surface.' },
  sti: { title: 'Shallow trench isolation (STI)', category: 'Device · FEOL', description: 'Oxide-filled trenches that electrically separate neighbouring transistors.' },
  well: { title: 'Well', category: 'Device · FEOL', description: 'Implanted region setting the background doping type (p-well for nMOS, n-well for pMOS).' },
  'gate-oxide': { title: 'Gate dielectric', category: 'Device · FEOL', description: 'A few-nanometre insulator between gate and channel; modern devices use high-k materials (HfO₂-based).' },
  gate: { title: 'Gate electrode', category: 'Device · FEOL', description: 'Controls the channel through the dielectric. A voltage on the gate turns the transistor on or off.' },
  spacer: { title: 'Spacers', category: 'Device · FEOL', description: 'Thin dielectric walls on the gate sides; they self-align the source/drain implants to the gate.' },
  source: { title: 'Source', category: 'Device · FEOL', description: 'Heavily doped region supplying carriers into the channel.' },
  drain: { title: 'Drain', category: 'Device · FEOL', description: 'Heavily doped region collecting carriers from the channel.' },
  channel: { title: 'Channel', category: 'Device · FEOL', description: 'The region under (or surrounded by) the gate where current flows when the transistor is on.' },
  silicide: { title: 'Silicide', category: 'Device · FEOL', description: 'Metal–silicon compound that lowers contact resistance on source, drain and gate.' },
  contact: { title: 'Contact plug', category: 'Device · MOL', description: 'Tungsten (or cobalt) plug connecting a transistor terminal to metal 1.' },
  m1: { title: 'Metal 1', category: 'Interconnect · BEOL', description: 'First wiring level — the densest, finest-pitch wires connecting nearby transistors.' },
  pmd: { title: 'Pre-metal dielectric (PMD)', category: 'Interconnect · MOL', description: 'Insulating glass deposited over the transistors; contact holes are etched through it.' },
  'low-k': { title: 'Low-k dielectric', category: 'Interconnect · BEOL', description: 'Insulator with a lower dielectric constant than SiO₂, reducing the capacitance between neighbouring wires.' },
  barrier: { title: 'Barrier / seed layer', category: 'Interconnect · BEOL', description: 'A few-nanometre liner (e.g. TaN/Ta) that stops copper diffusing into the dielectric, plus a thin copper seed for plating.' },
  'cu-wire': { title: 'Copper wire', category: 'Interconnect · BEOL', description: 'Damascene copper line: plated into an etched trench, then polished flush with the dielectric.' },
  via: { title: 'Via', category: 'Interconnect · BEOL', description: 'Vertical copper connection between two wiring levels.' },
  pad: { title: 'Bond pad', category: 'Interconnect · top', description: 'Large top-level metal area where wires, bumps or probe needles make contact.' },
  passivation: { title: 'Passivation', category: 'Interconnect · top', description: 'Silicon nitride / oxide layer that seals the chip against moisture and ions; windows are opened over the pads.' },
  polyimide: { title: 'Polyimide', category: 'Interconnect · top', description: 'Organic stress-buffer coating on top of the passivation, patterned with the pad openings.' },
  fin: { title: 'Fin', category: 'Device · FinFET', description: 'Thin vertical silicon fin forming the channel; the gate wraps three sides.' },
  nanosheet: { title: 'Nanosheet', category: 'Device · GAA', description: 'Horizontal silicon sheets stacked vertically; the gate surrounds each sheet on all sides.' },
  'field-lines': { title: 'Gate control', category: 'Concept', description: 'Arrows show where the gate electrostatically controls the channel. More surrounding = better control = less leakage.', kind: 'CONCEPTUAL' },

  /* package */
  lid: { title: 'Lid / integrated heat spreader', category: 'Package', description: 'Nickel-plated copper lid that spreads heat from the die to the cooler and protects it mechanically.' },
  tim: { title: 'Thermal interface material', category: 'Package', description: 'Conducts heat across the gap between die and lid.' },
  'pkg-die': { title: 'Die', category: 'Package', description: 'The silicon chip itself — CH-184-0412 in this journey.' },
  underfill: { title: 'Underfill', category: 'Package', description: 'Epoxy between die and substrate that shares mechanical stress so bumps do not crack.' },
  bumps: { title: 'Bumps / micro-bumps', category: 'Package', description: 'Solder bumps or copper pillars connecting the flipped die to the substrate.' },
  'pkg-substrate': { title: 'Package substrate', category: 'Package', description: 'Multi-layer laminate fanning out thousands of fine die connections to board-level balls.' },
  balls: { title: 'BGA solder balls', category: 'Package', description: 'Ball grid array connecting the package to the motherboard or card.' },
  'mold-cap': { title: 'Mold compound', category: 'Package', description: 'Epoxy encapsulation protecting wire-bonded dies.' },
  wires: { title: 'Bond wires', category: 'Package', description: 'Fine gold or copper wires from die pads to substrate fingers.' },
  interposer: { title: 'Silicon interposer', category: 'Advanced packaging', description: 'Thin silicon with very fine wiring and TSVs placing dies side by side (2.5D).', kind: 'CONCEPTUAL' },
  hbm: { title: 'HBM stack', category: 'Advanced packaging', description: 'Stacked DRAM dies connected by TSVs on a base logic die (JEDEC HBM).', kind: 'REAL' },
  tsv: { title: 'Through-silicon vias', category: 'Advanced packaging', description: 'Vertical copper connections passing through silicon dies.' },
  bridge: { title: 'Silicon bridge', category: 'Advanced packaging', description: 'Small silicon piece embedded in the substrate giving dense die-to-die links only where needed.', kind: 'CONCEPTUAL' },
  chiplet: { title: 'Chiplet', category: 'Advanced packaging', description: 'One of several smaller dies combined in a package.', kind: 'CONCEPTUAL' },
  'logic-die': { title: 'Logic die', category: 'Advanced packaging', description: 'Processor die placed next to (2.5D) or under/over (3D) other dies.', kind: 'CONCEPTUAL' },

  /* fab */
  /* cluster tools (deposition, etch, strip) */
  efem: { title: 'EFEM & load ports', category: 'Cluster tool', description: 'Equipment front-end module: FOUPs dock at the load ports and an atmospheric robot passes wafers to the load locks, all under filtered downflow.' },
  'load-lock': { title: 'Load lock', category: 'Cluster tool', description: 'Small chamber that is pumped from atmosphere down to vacuum (and vented back) so the transfer and process chambers never see air.' },
  'transfer-chamber': { title: 'Vacuum transfer chamber', category: 'Cluster tool', description: 'Central hub under vacuum. A vacuum robot moves wafers between load locks and the process chambers through slit valves.' },
  oht: { title: 'OHT vehicle', category: 'Fab logistics', description: 'Overhead hoist vehicle carrying a FOUP along the ceiling rail; lowers it onto load ports.' },
  stocker: { title: 'Stocker', category: 'Automated storage', description: 'Automated FOUP storage tower; a crane moves carriers between shelves and ports.' },
  ffu: { title: 'Fan filter units', category: 'Cleanroom', description: 'Ceiling fans with HEPA/ULPA filters push particle-free air down through the room at low velocity.' },
  'raised-floor': { title: 'Perforated raised floor', category: 'Cleanroom', description: 'Air leaves through the floor perforations into the return path, carrying particles away from wafers.' },
  operator: { title: 'Cleanroom operator', category: 'People', description: 'Full gowning (coverall, hood, mask, gloves, boots) contains the particles every person sheds.' },
  'particle-counter-post': { title: 'Particle counter', category: 'Environmental monitoring', description: 'Continuously samples air and counts particles per size class to verify the ISO class.' },
  'lot-foup': { title: 'FOUP (followed lot)', category: 'Material handling', description: 'The carrier holding LOT-A0731, including wafer WF-000184.' },

  /* utilities */
  'fab-building': { title: 'Main fab building', category: 'Utilities', description: 'Several stacked levels: the sub-fab with pumps, abatement and distribution; the cleanroom on a waffle slab; and the return-air plenum with fan filter units above. Proportions here are illustrative.' },
  'u-electricity': { title: 'Electrical distribution', category: 'Utilities', description: 'Substation, switchgear, UPS and busways power tools, HVAC and pumps.', kind: 'CONCEPTUAL' },
  'u-water': { title: 'Ultrapure water', category: 'Utilities', description: 'Multi-stage treatment (filtration, reverse osmosis, ion exchange, UV, degassing) feeds a recirculating UPW loop.', kind: 'CONCEPTUAL' },
  'u-air': { title: 'Air handling', category: 'Utilities', description: 'Make-up air units condition fresh air; FFUs recirculate cleanroom air through filters.', kind: 'CONCEPTUAL' },
  'u-gases': { title: 'Process gases', category: 'Utilities', description: 'Bulk gases (N₂, O₂, Ar, H₂) from a gas yard; specialty gases from gas cabinets via double-walled lines.', kind: 'CONCEPTUAL' },
  'u-vacuum': { title: 'Vacuum', category: 'Utilities', description: 'House vacuum plus tool-dedicated dry pumps in the subfab.', kind: 'CONCEPTUAL' },
  'u-cooling': { title: 'Process cooling', category: 'Utilities', description: 'Chillers and cooling towers remove heat from tools and air.', kind: 'CONCEPTUAL' },
  'u-chemicals': { title: 'Chemical delivery', category: 'Utilities', description: 'Bulk chemical distribution with filtration and monitoring to wet benches and CMP.', kind: 'CONCEPTUAL' },
  'u-waste': { title: 'Waste treatment', category: 'Utilities', description: 'Exhaust abatement, acid/alkali scrubbers and wastewater treatment before discharge.', kind: 'CONCEPTUAL' },

  /* systems */
  socket: { title: 'CPU socket', category: 'System', description: 'Land-grid or pin socket holding the processor package on the motherboard.' },
  motherboard: { title: 'Motherboard', category: 'System', description: 'Printed circuit board connecting processor, memory, power delivery and I/O.' },
  vrm: { title: 'Voltage regulators', category: 'System', description: 'Convert board power to the low, precisely regulated voltages the processor needs.' },
  dimm: { title: 'Memory modules', category: 'System', description: 'DRAM modules in slots next to the CPU.' },
  cooler: { title: 'Cooler', category: 'System', description: 'Heat sink and fan (or liquid cooling) removing the processor’s heat.' },
  'gpu-card': { title: 'Accelerator card', category: 'System', description: 'Board carrying the GPU package, its power delivery and memory, with a cooling shroud.' },
  case: { title: 'Computer / server', category: 'System', description: 'The finished system where the chip finally does useful work.' },
};
