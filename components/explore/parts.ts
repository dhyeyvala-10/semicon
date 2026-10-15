/**
 * Plain words for the parts a visitor can tap in Explore: a short name and one sentence.
 *
 * Machines, robots and the wafer have hand-written plain descriptions. Anything else falls
 * back to the data modules (data/machines.ts components, data/objects.ts, ...) with the
 * name cleaned of codes and brackets and the text cut to its first sentence.
 */
import type { Selection } from '@/types';
import { MACHINE_BY_ID } from '@/data/machines';
import { ROBOT_BY_ID } from '@/data/robots';
import { SENSOR_BY_ID } from '@/data/sensors';
import { MATERIAL_BY_ID } from '@/data/materials';
import { GLOSSARY_BY_ID } from '@/data/glossary';
import { OBJECTS } from '@/data/objects';

export interface PartInfo {
  name: string;
  text: string;
}

const MACHINES: Record<string, PartInfo> = {
  'arc-furnace': { name: 'Arc furnace', text: 'Melts quartz with carbon at about 2,000 °C to free rough silicon.' },
  'fbr-distillation': { name: 'Purifying plant', text: 'Turns rough silicon into a liquid and boils away the impurities.' },
  'siemens-reactor': { name: 'Silicon reactor', text: 'Red-hot rods inside slowly grow a thick coat of ultra-pure silicon.' },
  'cz-puller': { name: 'Crystal puller', text: 'Melts the silicon and slowly pulls one giant crystal out of it.' },
  'ingot-grinder': { name: 'Crystal grinder', text: 'Trims the ends of the crystal and grinds it perfectly round.' },
  'wire-saw': { name: 'Wire saw', text: 'A web of thin moving wires slices the whole crystal into wafers at once.' },
  'edge-grinder': { name: 'Edge grinder', text: 'Rounds the sharp edge of each wafer so it does not chip.' },
  lapper: { name: 'Lapping machine', text: 'Grinds both sides of the wafer flat and even.' },
  'etch-bath': { name: 'Chemical bath', text: 'Dissolves the thin damaged skin left on the wafer by grinding.' },
  'dsp-polisher': { name: 'Polisher', text: 'Soft spinning pads and a fine liquid polish the wafer to a mirror finish.' },
  'wet-bench': { name: 'Cleaning station', text: 'Washes the wafer in a row of liquid baths, rinses it and dries it.' },
  'surface-inspection': { name: 'Inspection machine', text: 'Scans the wafer with a laser to find tiny specks and scratches.' },
  efem: { name: 'Loading station', text: 'Opens the sealed wafer box so its robot can hand wafers to the machine.' },
  furnace: { name: 'Furnace', text: 'Heats about a hundred wafers at once to grow a thin layer of glass on them.' },
  'dep-cluster': { name: 'Coating machine', text: 'Adds layers only a few atoms thick, one wafer at a time, in airless chambers.' },
  track: { name: 'Coating track', text: 'Spreads a light-sensitive coating on the wafer, bakes it and develops it.' },
  scanner: { name: 'Light printer', text: 'Shines light through a circuit drawing and prints it, shrunk, onto the wafer.' },
  etcher: { name: 'Plasma etcher', text: 'Glowing gas carves the printed pattern into the layer below.' },
  asher: { name: 'Coating remover', text: 'Burns off the leftover light-sensitive coating.' },
  implanter: { name: 'Atom implanter', text: 'Fires a beam of charged atoms into the silicon to change how it conducts.' },
  rtp: { name: 'Fast heater', text: 'Heats one wafer red-hot for a few seconds to settle the new atoms in place.' },
  cmp: { name: 'Flattening polisher', text: 'Polishes the wafer flat so the next layer can be printed sharply.' },
  ecp: { name: 'Copper plating tool', text: 'Fills the tiny trenches with copper to make the wires.' },
  metrology: { name: 'Measuring tools', text: 'Measure what was just made to check it is the right size and thickness.' },
  prober: { name: 'Chip tester', text: 'Touches every chip on the wafer with tiny needles to test it.' },
  'dicing-saw': { name: 'Dicing saw', text: 'A thin spinning blade cuts the wafer into separate chips.' },
  'die-bonder': { name: 'Chip placer', text: 'Picks up the good chips and sets each one onto its package.' },
  'wire-bonder': { name: 'Wire bonder', text: 'Connects the chip to its package with hair-thin gold wires.' },
  'mold-press': { name: 'Sealing press', text: 'Seals the chip in protective plastic or under a metal lid.' },
  'test-handler': { name: 'Final tester', text: 'Tests every finished chip and sorts it by the result.' },
  'packing-line': { name: 'Packing line', text: 'Packs the finished chips and seals them for shipping.' },
};

const ROBOTS: Record<string, PartInfo> = {
  'wafer-robot': { name: 'Wafer robot arm', text: 'Lifts one wafer at a time out of the sealed box and carries it into the machine.' },
  'vacuum-robot': { name: 'Inner robot arm', text: 'Moves wafers between the chambers without letting any air in.' },
  oht: { name: 'Ceiling shuttle', text: 'Rides a rail on the ceiling and delivers sealed wafer boxes to the machines.' },
  stocker: { name: 'Storage crane', text: 'Keeps wafer boxes on shelves until their next machine is free.' },
  'track-robot': { name: 'Track robot', text: 'Carries wafers between coating, baking and the light printer.' },
  'wafer-stage': { name: 'Wafer table', text: 'Moves the wafer under the lens with the precision of a few atoms.' },
  'inspection-stage': { name: 'Scanning table', text: 'Moves the wafer under the inspection camera.' },
  'prober-chuck': { name: 'Test table', text: 'Lifts each chip up against the test needles, one after another.' },
  'pick-place': { name: 'Chip picker', text: 'Picks the good chips off the tape and moves them on to packaging.' },
  'test-handler-robot': { name: 'Tester robot', text: 'Puts chips into the test sockets and sorts them into bins.' },
  amr: { name: 'Warehouse robot', text: 'Drives boxes of chips between packing, storage and the loading dock.' },
};

const WAFERS: Record<string, PartInfo> = {
  wafer: { name: 'Silicon wafer', text: 'The thin silicon disc that will carry hundreds of chips.' },
  'lot-foup': { name: 'Sealed wafer box', text: 'Carries 25 wafers through the factory so no dust can reach them.' },
  ingot: { name: 'Silicon crystal', text: 'One giant, perfect crystal of silicon. It will be sliced into wafers.' },
};

/**
 * Tappable parts in the 13 chapter scenes, keyed by the label the 3D code gives them.
 * Hand-written so every popover is plain, short and about the thing actually tapped.
 */
const PARTS: Record<string, PartInfo> = {
  // crystal puller
  'Water-cooled chamber': { name: 'Furnace chamber', text: 'A sealed, water-cooled tank where the silicon is melted and the crystal grows.' },
  'Pull & rotation head': { name: 'Lifting head', text: 'Slowly lifts and turns the growing crystal.' },
  'Quartz crucible & graphite susceptor': { name: 'Melting pot', text: 'A quartz bowl that holds the molten silicon.' },
  'Graphite heater': { name: 'Heater', text: 'Keeps the silicon melted at just over 1,414 °C.' },
  'Heat shield': { name: 'Heat shield', text: 'Controls how fast the new crystal cools as it grows.' },
  'Seed crystal & chuck': { name: 'Seed crystal', text: 'A small perfect crystal that the whole ingot grows from.' },
  // ingot shaping and slicing
  'Headstock & tailstock': { name: 'Holders', text: 'Hold the crystal at both ends and spin it.' },
  'Diamond grinding wheel': { name: 'Grinding wheel', text: 'Grinds the crystal perfectly round.' },
  'Laser diameter gauge': { name: 'Laser gauge', text: 'Measures the width of the crystal along its length.' },
  'X-ray orientation unit': { name: 'X-ray checker', text: 'Uses X-rays to find which way the crystal atoms line up.' },
  'Ingot feed table': { name: 'Feed table', text: 'Slowly pushes the crystal down into the moving wires.' },
  'Grooved wire guides': { name: 'Wire rollers', text: 'Grooved rollers that keep hundreds of wires evenly spaced.' },
  'Wire web': { name: 'Wire web', text: 'Hundreds of fast-moving wires that cut the crystal into slices.' },
  'Supply & take-up spools': { name: 'Wire spools', text: 'Feed in fresh wire and wind up the used wire.' },
  'Tension control (dancer arms)': { name: 'Tension arms', text: 'Keep the wires pulled tight while they cut.' },
  'Slurry / coolant nozzles': { name: 'Coolant nozzles', text: 'Spray liquid onto the cut to cool it and carry dust away.' },
  // wafer finishing
  'Vacuum chuck': { name: 'Wafer holder', text: 'Holds the wafer in place with suction.' },
  'Profiled diamond wheel': { name: 'Edge wheel', text: 'Rounds off the sharp edge of the wafer.' },
  'Process cassette (wafers on edge)': { name: 'Wafer rack', text: 'Carries a batch of wafers through the cleaning baths.' },
  'Megasonic transducer': { name: 'Sound cleaner', text: 'Very fast sound waves shake tiny dust specks off the wafer.' },
  // cleanroom entry
  'EFEM FFU': { name: 'Air filter fan', text: 'Blows filtered, dust-free air down over the wafers.' },
  'Load port (FIMS)': { name: 'Box dock', text: 'Holds the sealed wafer box and opens its door.' },
  'Pre-aligner': { name: 'Wafer turner', text: 'Spins the wafer so it faces the right way before it goes in.' },
  // lithography
  'Metrology frame': { name: 'Measuring frame', text: 'A very steady frame the sensors measure from.' },
  'Alignment sensor': { name: 'Alignment sensor', text: 'Finds marks from earlier layers so the new pattern lines up.' },
  'Level sensor': { name: 'Height sensor', text: 'Maps the wafer surface so the image stays in focus.' },
  'Projection optics': { name: 'Lens', text: 'Shrinks the circuit drawing four times and focuses it onto the wafer.' },
  'Illuminator': { name: 'Light shaper', text: 'Turns the light into an even strip that shines through the drawing.' },
  'Reticle stage': { name: 'Drawing holder', text: 'Moves the circuit drawing in step with the wafer.' },
  'Reticle library & handler': { name: 'Drawing store', text: 'Stores the circuit drawings and loads the right one.' },
  'Wafer handler (track interface)': { name: 'Wafer loader', text: 'Brings coated wafers in and takes printed ones out.' },
  'Light source (EUV, laser-produced plasma)': { name: 'Light source', text: 'Makes the very short-wavelength light used to print.' },
  'Reticle (mask)': { name: 'Circuit drawing', text: 'A glass plate carrying one layer of the circuit, four times larger.' },
  'Wafer stage (chuck A)': { name: 'Wafer table', text: 'Moves the wafer under the lens to print one area after another.' },
  'Wafer stage (chuck B)': { name: 'Second wafer table', text: 'Measures the next wafer while the first one is printed.' },
  // etch
  'Process chamber (active)': { name: 'Process chamber', text: 'The sealed chamber where the wafer is worked on.' },
  'RF generators & match': { name: 'Power supply', text: 'Sends radio-wave power in to turn the gas into glowing plasma.' },
  'OES viewport': { name: 'Light window', text: 'Watches the plasma glow to tell when the carving is done.' },
  'Downstream plasma source': { name: 'Plasma source', text: 'Makes oxygen plasma that burns off the leftover coating.' },
  // implant
  'Ion source': { name: 'Atom source', text: 'Turns gas into charged atoms that can be fired as a beam.' },
  'Extraction electrodes': { name: 'Beam starter', text: 'Pulls the charged atoms out as a beam.' },
  'Analyzer magnet': { name: 'Sorting magnet', text: 'Bends the beam so only the wanted kind of atom gets through.' },
  'Resolving aperture (mass slit)': { name: 'Filter slit', text: 'A narrow gap that blocks the atoms the magnet sorted out.' },
  'Acceleration column': { name: 'Speed-up tube', text: 'Speeds the atoms up; faster atoms go deeper into the silicon.' },
  'Beam scanner': { name: 'Beam sweeper', text: 'Sweeps the beam back and forth so the whole wafer is covered evenly.' },
  'End station': { name: 'Wafer holder', text: 'Holds the wafer in the beam and counts how many atoms hit it.' },
  // deposition
  'Sputter target & magnetron': { name: 'Metal target', text: 'Atoms knocked off this metal plate settle on the wafer as a thin film.' },
  // wiring (cross-section)
  'Transistors (FEOL)': { name: 'Transistors', text: 'The tiny switches at the bottom, built into the silicon.' },
  'Pre-metal dielectric': { name: 'First insulating layer', text: 'Glass-like layer that keeps the transistors from touching the wires.' },
  'Tungsten contact plug': { name: 'Contact', text: 'A tiny metal plug linking a transistor to the wires above.' },
  'Low-k dielectric': { name: 'Insulating layer', text: 'Keeps neighbouring wires apart so signals do not leak.' },
  'Barrier / seed': { name: 'Thin lining', text: 'Stops copper from leaking into the insulation.' },
  'Copper wire': { name: 'Copper wire', text: 'Carries signals between the transistors.' },
  'Bond pad': { name: 'Connection pad', text: 'Where the chip connects to the outside world.' },
  'Passivation (SiN / oxide)': { name: 'Protective layer', text: 'Seals the chip against moisture and scratches.' },
  'Polyimide': { name: 'Top cushion layer', text: 'A soft layer that protects the chip during packaging.' },
  // test
  'Thermal chuck': { name: 'Test table', text: 'Holds the wafer and can heat or cool it during testing.' },
  'Probe card': { name: 'Needle card', text: 'Tiny needles that touch each chip to test it.' },
  'Test head': { name: 'Tester', text: 'Sends power and signals to the chip and checks the answers.' },
  'Alignment cameras': { name: 'Cameras', text: 'Line the needles up with the chip pads.' },
  'ATE mainframe': { name: 'Test computer', text: 'Runs the tests and records which chips pass.' },
  // packaging
  'Die CH-184-0412': { name: 'The chip', text: 'The tiny piece of silicon this whole story is about.' },
  'Bond head + collet': { name: 'Placing head', text: 'Picks up the chip and presses it into place.' },
  'Bond wires (Au)': { name: 'Gold wires', text: 'Hair-thin wires that connect the chip to its package.' },
  'Capillary': { name: 'Wire nozzle', text: 'Feeds the gold wire and presses it onto each pad.' },
  'Ultrasonic transducer': { name: 'Vibrating arm', text: 'Vibrates very fast to weld each wire in place.' },
  'Die (flip-chip, face down)': { name: 'The chip, face down', text: 'Flipped over so tiny solder bumps connect it directly.' },
  'Solder bumps': { name: 'Solder bumps', text: 'Tiny metal balls that connect the chip to the board below.' },
  'Die (face up)': { name: 'The chip, face up', text: 'Connected to its package by thin wires.' },
  'HBM stack (8 DRAM dies + base)': { name: 'Memory stack', text: 'Eight memory chips stacked on top of each other.' },
  'Silicon interposer': { name: 'Silicon base', text: 'A thin silicon layer that wires several chips together.' },
  'Through-silicon vias': { name: 'Vertical wires', text: 'Tiny wires that pass straight through the silicon.' },
  'Logic die': { name: 'Processor chip', text: 'The chip that does the computing.' },
  'Base logic die (with TSVs)': { name: 'Base chip', text: 'Sits under the memory stack and passes signals up and down.' },
  'Silicon bridge (embedded)': { name: 'Silicon bridge', text: 'A small piece of silicon that links two chips side by side.' },
  'I/O die': { name: 'Connection chip', text: 'Handles the chip’s links to the outside world.' },
  'Compute chiplet': { name: 'Compute chip', text: 'One of several small chips that do the computing together.' },
  'BGA solder balls': { name: 'Solder balls', text: 'Connect the finished package to the circuit board.' },
  'Underfill': { name: 'Glue fill', text: 'Fills the gap under the chip so the joints do not crack.' },
  'Thermal interface material': { name: 'Heat paste', text: 'Helps heat flow from the chip into the lid.' },
  'Lid / heat spreader': { name: 'Metal lid', text: 'Protects the chip and spreads its heat.' },
  // computer
  'Package substrate': { name: 'Package board', text: 'The small green board the chip sits on, with contacts underneath.' },
  'Integrated heat spreader': { name: 'Metal lid', text: 'Protects the chip and spreads its heat to the cooler.' },
  'Motherboard': { name: 'Motherboard', text: 'The main circuit board that connects every part of the computer.' },
  'CPU socket (LGA)': { name: 'Chip socket', text: 'Holds the chip and connects its contacts to the motherboard.' },
  'Voltage regulator (VRM)': { name: 'Power supply', text: 'Feeds the chip the steady power it needs.' },
  'Memory module (DIMM)': { name: 'Memory', text: 'Holds the data the chip is working on.' },
  'CPU cooler (heat pipes, fins, fan)': { name: 'Cooler', text: 'Carries heat away from the chip with pipes, fins and a fan.' },
  'Computer case': { name: 'Computer case', text: 'The box that holds and protects all the parts.' },
  'HBM stack': { name: 'Memory stack', text: 'Very fast memory stacked right next to the chip.' },
  'Accelerator card PCB': { name: 'Accelerator card', text: 'A board with a powerful chip for AI and graphics.' },
  'Power delivery (VRM)': { name: 'Power supply', text: 'Feeds the chips the steady power they need.' },
  'Heatsink, vapour chamber & fans': { name: 'Cooler', text: 'Pulls heat away from the chips so they do not overheat.' },
  'Server chassis (accelerated computing)': { name: 'Server', text: 'A rack computer that runs AI and cloud services.' },
};

const DIE: PartInfo = { name: 'One chip', text: 'One of the chips on the wafer. Each one is tested on its own.' };

/** Drop codes and brackets: "Atmospheric Wafer Robot (SCARA)" → "Atmospheric Wafer Robot". */
export function plainName(s: string): string {
  const out = s
    .replace(/\s*\([^)]*\)/g, '')
    .split(' · ')[0]
    .replace(/\s+/g, ' ')
    .trim();
  return out || s.trim();
}

/** The first sentence, at most ~150 characters (cut at a word). */
export function firstSentence(s: string | undefined): string {
  if (!s) return '';
  const t = s.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  let out = m ? m[0] : t;
  if (out.length > 150) out = out.slice(0, 150).replace(/\s+\S*$/, '') + '…';
  return out;
}

/** Plain name and one sentence for a tapped part. */
export function describePart(sel: Selection): PartInfo {
  if (sel.label && PARTS[sel.label]) return PARTS[sel.label];
  if (sel.kind === 'machine' && MACHINES[sel.id]) return MACHINES[sel.id];
  if (sel.kind === 'robot' && ROBOTS[sel.id]) return ROBOTS[sel.id];
  if (sel.kind === 'wafer' && WAFERS[sel.id]) return WAFERS[sel.id];
  if (sel.kind === 'die') return DIE;

  const label = sel.label ? plainName(sel.label) : '';
  switch (sel.kind) {
    case 'machine': {
      const m = MACHINE_BY_ID[sel.id];
      return { name: label || plainName(m?.name ?? sel.id), text: firstSentence(m?.purpose) };
    }
    case 'robot': {
      const r = ROBOT_BY_ID[sel.id];
      return { name: label || plainName(r?.name ?? sel.id), text: firstSentence(r?.task) };
    }
    case 'sensor': {
      const s = SENSOR_BY_ID[sel.id];
      return { name: plainName(s?.name ?? (label || sel.id)), text: firstSentence(s?.measures) };
    }
    case 'material': {
      const m = MATERIAL_BY_ID[sel.id];
      return { name: label || plainName(m?.name ?? sel.id), text: firstSentence(m?.use) };
    }
    case 'glossary': {
      const g = GLOSSARY_BY_ID[sel.id];
      return { name: plainName(g?.term ?? (label || sel.id)), text: firstSentence(g?.short) };
    }
    default: {
      const comp = sel.machine ? MACHINE_BY_ID[sel.machine]?.components.find((c) => c.id === sel.id) : undefined;
      const obj = OBJECTS[sel.id];
      const name = label || plainName(comp?.name ?? obj?.title ?? sel.id);
      const sameThing = !label || !comp || plainName(comp.name).toLowerCase() === label.toLowerCase();
      const text = (sameThing ? firstSentence(comp?.description ?? obj?.description) : '') || (sel.machine && MACHINES[sel.machine] ? `Part of the ${MACHINES[sel.machine].name.toLowerCase()}.` : '');
      return { name, text };
    }
  }
}
