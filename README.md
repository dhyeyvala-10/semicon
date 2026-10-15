# FAB/TWIN — how a computer chip is made

Follow ordinary sand on its way to becoming the chip inside your computer, in 13 short steps,
with a working 3D factory behind every step.

- **Story** (the default): scroll, and each step plays in 3D. Every step has a plain title, one
  sentence and a live caption of what is happening right now.
- **Explore**: the same 3D, free to turn and zoom. Pick any of the 13 steps, play or pause, look
  inside a machine, and tap a part to see what it is.

It is a local-first Next.js + React Three Fiber site with no backend, API keys or network calls at
runtime; fonts are bundled. All 3D models are built in code (no model files).

```bash
npm install
npm run dev        # http://localhost:3000
```

Production build:

```bash
npm run build
npm start          # http://localhost:3000
npm run typecheck  # tsc --noEmit
```

Requires Node.js ≥ 20.9 (developed on Node 22).

---

## The 13 steps

| # | Step | What you see |
| --- | --- | --- |
| 1 | Sand becomes silicon | quarry, then pure silicon grown on red-hot rods |
| 2 | Growing one perfect crystal | a crystal puller lifting one giant crystal from molten silicon |
| 3 | Slicing into wafers | a web of wires cutting the crystal into thin discs |
| 4 | Polishing to a mirror | spinning pads polishing each wafer |
| 5 | Into the cleanroom | a sealed wafer box, and a robot that carries wafers into a machine |
| 6 | Printing with light | a scanner printing the circuit pattern with light |
| 7 | Carving the pattern | a plasma chamber carving the pattern into the wafer |
| 8 | Changing the silicon | a beam of atoms fired into the silicon |
| 9 | Adding thin layers | chambers that grow films a few atoms thick |
| 10 | Wiring it all together | copper wires built layer by layer (close-up) |
| 11 | Testing every chip | the wafer map of good and bad chips |
| 12 | Cutting and packaging | gold wires connecting the chip to its package |
| 13 | Into your computer | the chip on a motherboard inside a computer |

The text lives in [`data/chapters.ts`](data/chapters.ts). Each step plays one or more of the
detailed process stages in `data/process.ts` that share one 3D scene.

### Keys and links

In Explore: ← / → change step, Space plays or pauses, Esc closes a part card.
`?stage=<stage id>` opens Explore at that stage (for example `?stage=lithography`), `?mode=2d`
forces the simple no-3D page, and `?quality=low` / `?quality=high` override the automatic
phone / desktop graphics setting.

All equipment is an *industry-inspired educational model*: no proprietary design, recipe or
process data is reproduced, and no company names are used.

---

## Architecture

A runtime architecture diagram (made with [Archify](https://github.com/tt-a1i/archify)) lives in
[`.archify/architecture-fab-twin-runtime-20261012-074517/fab-twin-runtime.html`](.archify/architecture-fab-twin-runtime-20261012-074517/fab-twin-runtime.html).

```
app/                 Next.js entry, design tokens (tokens.css), base + story styles (globals.css),
                     explore styles (explore.css); one typeface: Plus Jakarta Sans
components/
  App.tsx            shell: start-up, deep link, story or explore
  story/             the scroll story (hero, 13 steps, outro) and the logo
  explore/           the free 3D view (step chips, caption card, part cards with plain descriptions)
  ui/                top bar, loader and scene-change veil, colour grade
  fallback/          the no-3D page
  3d/
    Stage3D.tsx      canvas and renderer settings
    CameraRig.tsx    story camera (driven by the scroll) and explore camera (free after a drag)
    SceneSwitcher.tsx  lazy-loaded scenes, one module per scene
    environments.tsx lighting and rooms
    kit/             procedural modelling kit: merged geometry per finish, one shadow caster per model
    parts/           shared parts (wafer and box, robot arm, cluster tool, cross-sections, ...)
    scenes/          one module per scene
data/                the 13 steps (chapters.ts), process stages, scenes and camera presets,
                     machines, robots, materials, fab layout
simulation/          the engine: stage player, wafer twin, fab simulation, robot controller
lib/                 UI store (zustand), story runtime, quality tiers, runtime registries
types/               domain types
```

Key ideas:

- **Scenes are pure functions of the stage player's view** (`phaseId`, `phaseT`, `stageT`), so scrolling, playing and jumping always show a consistent state.
- **The UI never re-renders per frame.** Captions and progress are written to the page from one animation loop or a 4 Hz timer; the 3D reads the engine inside `useFrame`.
- **Detailed but cheap models:** each machine is built from code with the kit, merged into one draw call per finish and one shadow caster.

### Extending

- **Change the words:** edit `data/chapters.ts` (titles, one sentence, captions per phase) and `components/explore/parts.ts` (part cards).
- **Add a scene:** create `components/3d/scenes/MyScene.tsx`, register it in `components/3d/sceneLoaders.ts`, and add camera presets in `data/scenes.ts`.

### Verification

`npm run typecheck` and `npm run build` pass. The story and Explore were tested headless (Chromium /
SwiftShader) on a 390 × 844 phone and a 1280 × 800 desktop: the landing view, three steps, opening
Explore, changing step, looking inside, play / pause, tapping a part, taking the camera, and going back
to the story, with no console or page errors.
