/**
 * Educational supply-chain structures. Node names are generic categories, not companies.
 * Globe locations and routes are ILLUSTRATIVE; regional specialisation is described in
 * the SIA/BCG (2021) report, cited where shown.
 */

export interface SupplyNode {
  id: string;
  label: string;
  tier: number;
  group: 'fab' | 'equipment' | 'materials' | 'subsystem' | 'base' | 'downstream';
  note: string;
}

export interface SupplyEdge {
  from: string; // supplier
  to: string; // consumer
}

export const SUPPLY_NODES: SupplyNode[] = [
  { id: 'fab', label: 'WAFER FAB', tier: 0, group: 'fab', note: 'Runs hundreds of process tools around the clock.' },
  { id: 'osat', label: 'ASSEMBLY & TEST', tier: -1, group: 'downstream', note: 'Packages and tests the dies the fab produces.' },
  { id: 'oem', label: 'SYSTEM MAKERS', tier: -2, group: 'downstream', note: 'Build computers, servers, phones, cars, robots.' },

  { id: 'litho', label: 'LITHOGRAPHY EQUIPMENT', tier: 1, group: 'equipment', note: 'Scanners, tracks, reticle handling.' },
  { id: 'dep', label: 'DEPOSITION EQUIPMENT', tier: 1, group: 'equipment', note: 'CVD, PVD, ALD, furnaces, plating.' },
  { id: 'etch', label: 'ETCH & CLEAN EQUIPMENT', tier: 1, group: 'equipment', note: 'Plasma etch, strip, wet clean.' },
  { id: 'metro', label: 'METROLOGY & INSPECTION', tier: 1, group: 'equipment', note: 'Measure and find defects.' },
  { id: 'cmp-imp', label: 'CMP & IMPLANT EQUIPMENT', tier: 1, group: 'equipment', note: 'Planarisation and doping tools.' },
  { id: 'wafers', label: 'SILICON WAFERS', tier: 1, group: 'materials', note: 'Polished prime wafers.' },
  { id: 'chem', label: 'CHEMICALS & GASES', tier: 1, group: 'materials', note: 'Acids, solvents, specialty gases, precursors.' },
  { id: 'resist', label: 'PHOTORESISTS', tier: 1, group: 'materials', note: 'Light-sensitive polymers for each wavelength.' },
  { id: 'masks', label: 'PHOTOMASKS', tier: 1, group: 'materials', note: 'Reticles written by e-beam mask writers.' },
  { id: 'eda', label: 'DESIGN SOFTWARE & IP', tier: 1, group: 'subsystem', note: 'Defines what the fab patterns.' },

  { id: 'optics', label: 'PRECISION OPTICS', tier: 2, group: 'subsystem', note: 'Lenses and mirrors polished to sub-nanometre figure.' },
  { id: 'source', label: 'LIGHT SOURCES', tier: 2, group: 'subsystem', note: 'Excimer lasers; EUV plasma sources.' },
  { id: 'motion', label: 'MOTION SYSTEMS & STAGES', tier: 2, group: 'subsystem', note: 'Linear motors, maglev stages, air bearings.' },
  { id: 'vacuum', label: 'VACUUM & PUMPS', tier: 2, group: 'subsystem', note: 'Turbo and dry pumps, valves, gauges.' },
  { id: 'rf', label: 'RF & POWER', tier: 2, group: 'subsystem', note: 'RF generators, matching networks, power supplies.' },
  { id: 'robotics', label: 'ROBOTICS & HANDLING', tier: 2, group: 'subsystem', note: 'Wafer robots, EFEMs, load ports, AMHS.' },
  { id: 'sensors', label: 'SENSORS', tier: 2, group: 'subsystem', note: 'Interferometers, gauges, MFCs, pyrometers.' },
  { id: 'electronics', label: 'CONTROL ELECTRONICS', tier: 2, group: 'subsystem', note: 'Motion controllers, FPGAs, computers.' },
  { id: 'software', label: 'CONTROL SOFTWARE', tier: 2, group: 'subsystem', note: 'Tool control, MES, fab scheduling, APC.' },
  { id: 'specialty', label: 'SPECIALTY MATERIALS', tier: 2, group: 'materials', note: 'Fused silica, ceramics, ultra-pure metals, polymers.' },

  { id: 'glass', label: 'OPTICAL GLASS & COATINGS', tier: 3, group: 'base', note: 'Raw optical materials and thin-film coatings.' },
  { id: 'gases', label: 'RARE & INDUSTRIAL GASES', tier: 3, group: 'base', note: 'Neon, argon, hydrogen, nitrogen production.' },
  { id: 'magnets', label: 'MAGNETS & MOTORS', tier: 3, group: 'base', note: 'Permanent magnets and precision motors.' },
  { id: 'chips', label: 'SEMICONDUCTORS (FOR TOOLS)', tier: 3, group: 'base', note: 'Machines that make chips are themselves full of chips.' },
  { id: 'machining', label: 'PRECISION MACHINING', tier: 3, group: 'base', note: 'Machine tools, metrology frames, castings.' },
  { id: 'minerals', label: 'MINERALS & MINING', tier: 3, group: 'base', note: 'Quartz, metals, rare earths, fluorspar.' },
];

export const SUPPLY_EDGES: SupplyEdge[] = [
  { from: 'fab', to: 'osat' },
  { from: 'osat', to: 'oem' },
  ...['litho', 'dep', 'etch', 'metro', 'cmp-imp', 'wafers', 'chem', 'resist', 'masks', 'eda'].map((f) => ({ from: f, to: 'fab' })),
  ...['optics', 'source', 'motion', 'vacuum', 'sensors', 'electronics', 'software', 'robotics'].map((f) => ({ from: f, to: 'litho' })),
  ...['vacuum', 'rf', 'robotics', 'sensors', 'electronics', 'software', 'specialty'].map((f) => ({ from: f, to: 'dep' })),
  ...['vacuum', 'rf', 'robotics', 'sensors', 'electronics', 'software', 'specialty'].map((f) => ({ from: f, to: 'etch' })),
  ...['optics', 'motion', 'sensors', 'electronics', 'software', 'robotics', 'source'].map((f) => ({ from: f, to: 'metro' })),
  ...['vacuum', 'motion', 'robotics', 'electronics', 'software', 'rf'].map((f) => ({ from: f, to: 'cmp-imp' })),
  { from: 'minerals', to: 'wafers' },
  { from: 'gases', to: 'chem' },
  { from: 'minerals', to: 'chem' },
  { from: 'chem', to: 'resist' },
  { from: 'glass', to: 'masks' },
  { from: 'glass', to: 'optics' },
  { from: 'gases', to: 'source' },
  { from: 'magnets', to: 'motion' },
  { from: 'machining', to: 'motion' },
  { from: 'machining', to: 'vacuum' },
  { from: 'chips', to: 'electronics' },
  { from: 'chips', to: 'sensors' },
  { from: 'magnets', to: 'robotics' },
  { from: 'minerals', to: 'specialty' },
  { from: 'minerals', to: 'magnets' },
  { from: 'oem', to: 'chips' },
];

/* --------------------------- Globe network --------------------------- */

export interface GlobeNode {
  id: string;
  label: string;
  role: string;
  lat: number;
  lon: number;
}

/** Illustrative node placement by broad region. NOT real facilities or trade data. */
export const GLOBE_NODES: GlobeNode[] = [
  { id: 'fab', label: 'WAFER FAB', role: 'Fabrication (illustrative, East Asia)', lat: 24, lon: 121 },
  { id: 'osat', label: 'ASSEMBLY & TEST', role: 'Packaging / test (illustrative, Southeast Asia)', lat: 3, lon: 102 },
  { id: 'dc', label: 'DISTRIBUTION CENTRE', role: 'Regional distributor (illustrative)', lat: 22, lon: 114 },
  { id: 'oem', label: 'SYSTEM INTEGRATOR', role: 'Dealer / OEM (illustrative, North America)', lat: 37, lon: -121 },
  { id: 'eu-eq', label: 'EQUIPMENT MAKER', role: 'Tool supplier (illustrative, Europe)', lat: 51.5, lon: 5.5 },
  { id: 'us-eq', label: 'EQUIPMENT MAKER', role: 'Tool supplier (illustrative, North America)', lat: 37.5, lon: -122 },
  { id: 'jp-mat', label: 'MATERIALS SUPPLIER', role: 'Wafers / chemicals (illustrative, East Asia)', lat: 35.5, lon: 139.5 },
  { id: 'eu-opt', label: 'OPTICS SUPPLIER', role: 'Precision optics (illustrative, Europe)', lat: 48.8, lon: 10 },
  { id: 'gas', label: 'GAS SUPPLIER', role: 'Specialty gases (illustrative)', lat: 46, lon: 30 },
  { id: 'quartz', label: 'QUARTZ / SILICON', role: 'Raw material (illustrative)', lat: 36, lon: -82 },
];

export const SHIPMENT_ROUTE = ['fab', 'osat', 'dc', 'oem'];

export interface MaterialCategory {
  id: string;
  label: string;
  origins: string[]; // globe node ids
  chain: string[];
}

export const MATERIAL_CATEGORIES: MaterialCategory[] = [
  { id: 'silicon', label: 'SILICON', origins: ['quartz', 'jp-mat'], chain: ['Quartz mining', 'Smelting', 'Polysilicon', 'Crystal growth', 'Wafering', 'Wafer fab'] },
  { id: 'chemicals', label: 'CHEMICALS', origins: ['jp-mat', 'us-eq'], chain: ['Base chemicals', 'Purification', 'Electronic-grade chemicals', 'Fab chemical delivery'] },
  { id: 'specialty', label: 'SPECIALTY MATERIALS', origins: ['jp-mat', 'eu-opt'], chain: ['Minerals', 'Refining', 'Precursors / resists / targets', 'Fab'] },
  { id: 'gases', label: 'GASES', origins: ['gas', 'us-eq'], chain: ['Air separation / synthesis', 'Purification', 'Cylinders & bulk', 'Gas cabinets', 'Tools'] },
  { id: 'equipment', label: 'EQUIPMENT', origins: ['eu-eq', 'us-eq', 'jp-mat'], chain: ['Subsystems', 'Tool integration', 'Installation & qualification', 'Fab'] },
  { id: 'litho', label: 'LITHOGRAPHY EQUIPMENT', origins: ['eu-eq', 'eu-opt'], chain: ['Optical glass', 'Precision optics', 'Light source', 'Stages & sensors', 'Scanner integration', 'Fab litho bay'] },
  { id: 'optics', label: 'OPTICS', origins: ['eu-opt'], chain: ['Optical glass', 'Grinding & polishing', 'Coatings', 'Metrology', 'Optical modules'] },
  { id: 'electronics', label: 'ELECTRONICS', origins: ['fab', 'us-eq'], chain: ['Chips', 'Boards', 'Controllers', 'Tool electronics'] },
  { id: 'packaging', label: 'PACKAGING MATERIALS', origins: ['jp-mat', 'osat'], chain: ['Laminates', 'Substrates', 'Solder & wire', 'Assembly'] },
];
