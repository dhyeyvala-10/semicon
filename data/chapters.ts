/**
 * The story, in plain words: 13 chapters from sand to a working computer.
 *
 * Each chapter plays one or more journey stages that share a single 3D scene, so scrolling
 * through a chapter never waits for a new scene. Captions are keyed `${stageId}:${phaseId}`
 * and cover every phase of every stage listed. Keep the language short and free of jargon.
 */

export interface Chapter {
  id: string;
  /** short, plain title (≤ 5 words) */
  title: string;
  /** the one thing to understand (one sentence, ≤ 18 words) */
  line: string;
  /** what you are looking at in the 3D view (≤ 2 short sentences) */
  explore: string;
  /** journey stage ids played by this chapter, in order; all use the same scene */
  stages: string[];
  /** one plain caption per phase, keyed `${stageId}:${phaseId}` (≤ 10 words) */
  captions: Record<string, string>;
}

export const CHAPTERS: Chapter[] = [
  {
    id: 'sand',
    title: 'Sand becomes silicon',
    line: 'Chips start as quartz sand, which is melted and purified into almost perfectly pure silicon.',
    explore: 'Quartz is dug up, washed and melted. Then silicon is grown on hot rods until it is 99.9999999% pure.',
    stages: ['quartz', 'polysilicon'],
    captions: {
      'quartz:mine': 'Quartz rock is dug up and crushed',
      'quartz:wash': 'The pieces are washed and sorted by size',
      'quartz:ship': 'Clean quartz goes to the furnace',
      'polysilicon:heat': 'Thin silicon rods are heated red-hot',
      'polysilicon:deposit': 'Pure silicon slowly builds up on the rods',
      'polysilicon:cool': 'The thick rods cool down',
      'polysilicon:harvest': 'Rods are broken into pure silicon chunks',
    },
  },
  {
    id: 'crystal',
    title: 'Growing one perfect crystal',
    line: 'The silicon is melted and pulled up slowly, growing a single giant crystal called an ingot.',
    explore: 'Inside this furnace, molten silicon hangs on a small seed crystal that is slowly lifted and turned.',
    stages: ['crystal-growth'],
    captions: {
      'crystal-growth:melt': 'Silicon chunks melt at 1,414 °C',
      'crystal-growth:stabilize': 'The melt settles to an even temperature',
      'crystal-growth:dip': 'A tiny seed crystal touches the melt',
      'crystal-growth:neck': 'A thin neck removes flaws in the seed',
      'crystal-growth:crown': 'The crystal widens to full size',
      'crystal-growth:body': 'It grows slowly for many hours',
      'crystal-growth:tail': 'It narrows to a point and lifts free',
    },
  },
  {
    id: 'slice',
    title: 'Slicing into wafers',
    line: 'The ingot is sliced into thin discs called wafers by a web of fine wire.',
    explore: 'Hundreds of moving wires cut the whole ingot at once, each slice thinner than a coin.',
    stages: ['slicing'],
    captions: {
      'slicing:mount': 'The ingot is glued to a holder',
      'slicing:tension': 'A web of thin wire is pulled tight',
      'slicing:cut': 'The wires cut through the ingot',
      'slicing:retract': 'The cut ingot is lifted out',
      'slicing:separate': 'The slices come apart as wafers',
    },
  },
  {
    id: 'polish',
    title: 'Polishing to a mirror',
    line: 'Each wafer is polished until it is flatter and smoother than almost anything made by people.',
    explore: 'A soft pad and a fine liquid polish the wafer while both spin.',
    stages: ['polishing'],
    captions: {
      'polishing:load': 'A wafer is placed in the polisher',
      'polishing:stock': 'Spinning pads take off the rough layer',
      'polishing:final': 'A final pass makes it mirror-smooth',
      'polishing:unload': 'The finished wafer is lifted out',
    },
  },
  {
    id: 'cleanroom',
    title: 'Into the cleanroom',
    line: 'Wafers travel in sealed boxes, and robots move them so no dust or hands touch them.',
    explore: 'A sealed box arrives from the ceiling rail. A robot arm takes one wafer out and carries it into the machine.',
    stages: ['cleanroom-entry'],
    captions: {
      'cleanroom-entry:arrive': 'A ceiling vehicle delivers a sealed wafer box',
      'cleanroom-entry:dock': 'The box docks and its door opens',
      'cleanroom-entry:map': 'A sensor checks which slots hold wafers',
      'cleanroom-entry:pick': 'The robot lifts out one wafer',
      'cleanroom-entry:align': 'The wafer is turned to face the right way',
      'cleanroom-entry:transfer': 'The robot carries it to the machine',
      'cleanroom-entry:place': 'The wafer is set down inside',
      'cleanroom-entry:return': 'The robot goes back for the next one',
    },
  },
  {
    id: 'light',
    title: 'Printing with light',
    line: 'Light shines through a pattern and prints tiny circuit shapes onto the wafer.',
    explore: 'This machine shrinks a circuit drawing with light and prints it across the wafer, one small area at a time.',
    stages: ['lithography'],
    captions: {
      'lithography:swap': 'The next wafer moves under the lens',
      'lithography:expose': 'Light prints the pattern, square by square',
      'lithography:zoom': 'The printed pattern is still invisible',
      'lithography:unload': 'The wafer leaves to be developed',
    },
  },
  {
    id: 'etch',
    title: 'Carving the pattern',
    line: 'A glowing gas carves the printed pattern into the layer below.',
    explore: 'Inside the chamber, charged gas (plasma) eats away only the parts the pattern leaves open.',
    stages: ['etch'],
    captions: {
      'etch:load': 'The wafer is moved in and held flat',
      'etch:strike': 'Gas is switched on into a glowing plasma',
      'etch:main': 'The plasma carves trenches into the layer',
      'etch:endpoint': 'Carving stops at exactly the right depth',
      'etch:unload': 'The wafer is moved out',
    },
  },
  {
    id: 'dope',
    title: 'Changing the silicon',
    line: 'Tiny atoms are fired into the silicon so it can switch electricity on and off.',
    explore: 'A beam of charged atoms is sped up, sorted by a magnet and aimed at the wafer.',
    stages: ['implant'],
    captions: {
      'implant:load': 'The wafer is placed at the end of the beam',
      'implant:pump': 'Air is pumped out of the machine',
      'implant:tune': 'A magnet picks out just the right atoms',
      'implant:implant': 'The beam sweeps across the whole wafer',
      'implant:unload': 'The wafer is taken out',
    },
  },
  {
    id: 'layers',
    title: 'Adding thin layers',
    line: 'Layers only a few atoms thick are added on top, one after another.',
    explore: 'In these chambers, gases react on the hot wafer and leave a thin, even film.',
    stages: ['deposition'],
    captions: {
      'deposition:load': 'The wafer enters through an airlock',
      'deposition:pump': 'The chamber is emptied and heated',
      'deposition:deposit': 'A thin film grows evenly on the wafer',
      'deposition:purge': 'Leftover gas is flushed away',
      'deposition:unload': 'The wafer moves on',
    },
  },
  {
    id: 'wiring',
    title: 'Wiring it all together',
    line: 'Copper wires are built in many layers to connect billions of tiny switches.',
    explore: 'This close-up shows copper filling tiny trenches, then being polished flat. It repeats layer after layer.',
    stages: ['interconnect'],
    captions: {
      'interconnect:dielectric': 'An insulating layer goes on top',
      'interconnect:pattern': 'The wire paths are printed',
      'interconnect:etch': 'Trenches for the wires are carved',
      'interconnect:barrier': 'A thin lining protects the trenches',
      'interconnect:plate': 'Copper fills the trenches',
      'interconnect:cmp': 'Extra copper is polished away',
    },
  },
  {
    id: 'test',
    title: 'Testing every chip',
    line: 'Every chip on the wafer is tested, and the bad ones are marked.',
    explore: 'Green squares passed the test. Red ones failed and will not be used.',
    stages: ['wafer-sort'],
    captions: {
      'wafer-sort:map': 'Test results are collected for every chip',
      'wafer-sort:separate': 'Good chips are kept, bad ones marked',
      'wafer-sort:yield': 'The share of good chips is counted',
    },
  },
  {
    id: 'package',
    title: 'Cutting and packaging',
    line: 'The wafer is cut into chips, and each one is wired into a protective package.',
    explore: 'Hair-thin gold wires connect the chip to its package so it can talk to the outside world.',
    stages: ['bonding'],
    captions: {
      'bonding:wire': 'Thin wires connect the chip to its package',
      'bonding:inspect': 'A camera checks every connection',
    },
  },
  {
    id: 'computer',
    title: 'Into your computer',
    line: 'The finished chip goes onto a board and powers a computer, phone or server.',
    explore: 'The chip sits in a socket on the motherboard, under a cooler, inside the computer.',
    stages: ['system'],
    captions: {
      'system:die': 'The tiny chip itself',
      'system:package': 'Sealed in its package',
      'system:socket': 'Placed in a socket',
      'system:board': 'Mounted on a motherboard',
      'system:system': 'Inside a working computer',
    },
  },
];

export const CHAPTER_BY_ID: Record<string, Chapter> = Object.fromEntries(CHAPTERS.map((c) => [c.id, c]));

/** The chapter a journey stage belongs to, if any. */
export const CHAPTER_OF_STAGE: Record<string, Chapter> = Object.fromEntries(CHAPTERS.flatMap((c) => c.stages.map((s) => [s, c] as const)));
