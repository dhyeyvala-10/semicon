# FAB/TWIN — a visual digital twin of semiconductor manufacturing

Follow one grain of quartz as it becomes wafer **WF-000184**, then chip **CH-184-0412**, then part of a
working computer. There are 55 journey stages and six explorable locations. Every machine runs, and
every number on screen is labelled with where it comes from.

It is a local-first Next.js + React Three Fiber application. It needs no backend, API keys or network
calls at runtime; fonts and map data are bundled.

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

## What you can do

| Experience | What it does |
| --- | --- |
| **Watch** | Cinematic playback of the whole journey; the camera follows the phase cues. |
| **Control** | Free exploration of the running fab: the fab overview, *Run fab*, failures and maintenance. |
| **Learn** | Step-by-step, with WHY / HOW / WHAT CHANGES panels and the technical companion. |
| **Engineer** | Telemetry, control loops, run-to-run feedback, sources and debug data. |

- **Camera modes:** factory · machine · internal · wafer · microscopic · transistor · data, plus *Follow* (the followed wafer, FOUP, die or package).
- **View modes** (per scene): normal · cut-away · cross-section · x-ray · exploded.
- **Information layers L1–L4:** visual only → labels → engineering values → deep dive.
- **Wafer digital twin:** identity, location, layers, cycles, inspection, test and package state, with a full history. It stays consistent when you jump around the journey.
- **What-if:** inject failures (contamination, misalignment, robot vacuum loss, temperature drift, etch variation, defect excursion, melt disturbance, wire tension, downtime). Also maintenance mode, the misalignment slider and method toggles (CVD/PVD/ALD, dry/wet etch, wire-bond/flip-chip, 2.5D/3D/chiplets, CPU/GPU).
- **Overlays:** search (Ctrl/⌘ K), fab map, process map, machine map, robotics, materials, glossary, comparisons, failures, fab dashboard, control loops & R2R, about & sources.
- **2D technical view:** a fallback that runs on the same simulation. It switches on automatically without WebGL.

### Keyboard

| Key | Action |
| --- | --- |
| Space | play / pause |
| ← / → | step one operation back / forward |
| Shift + ← / → | previous / next stage |
| 1 – 4 | information layer |
| Ctrl/⌘ + K | search |
| Esc | close overlay / panel / selection |
| `` ` `` | debug overlay |

### URL parameters

`?stage=<id>` deep-links to a stage (for example `?stage=lithography`, `?stage=metal-stack`, `?stage=control-room`).
`?exp=watch|control|learn|engineer` sets the experience mode, `?mode=2d` forces the 2D view,
`?quality=low` uses a lighter renderer (automatic on mobile), and `?debug=1` shows the debug overlay.

---

## The journey

| Macro phase | Stages |
| --- | --- |
| Raw material | quartz · metallurgical silicon (arc furnace) · trichlorosilane purification · Siemens polysilicon |
| Silicon crystal | Czochralski growth · ingot removal |
| Wafering | cropping · OD grinding · orientation notch · multi-wire slicing · edge profiling · lapping · chemical etch · polishing · cleaning · prime-wafer inspection |
| Fab entry | FOUP, load port, EFEM robot, pre-aligner |
| FEOL | oxidation · CVD/PVD/ALD · resist coat · soft bake · reticle · alignment · step-and-scan exposure · develop · dry/wet etch · strip · implant · RTP anneal · gap fill · CMP · repeated layer cycles 17–19 · transistor build · planar / FinFET / GAA |
| BEOL | contacts · copper dual damascene · M1–M12 stack · passivation |
| Test | metrology · inspection & wafer map · electrical test · wafer sort |
| Package | dicing · known-good-die pick · die attach · wire bond / flip-chip · 2.5D / 3D / chiplets · final package |
| Distribution | final test · binning · tape & reel / dry pack · warehouse · global distribution · CPU/GPU systems · ecosystem finale |

Explore locations: **fab overview** (bays, OHT, stockers, airflow and particles, utilities, *Run fab*),
**control room** (a video wall driven by the fab simulation), **utilities campus**,
**supply-chain graph**, **robot lab** (manual jog of the EFEM robot) and the **powers-of-ten scale journey**.

---

## Honest data

Every value carries a classification:

- **REAL** — publicly documented and cited, for example the silicon melting point (1414 °C), the Deal–Grove constants and the EUV wavelength (13.5 nm).
- **REPRESENTATIVE** — a typical textbook range, not a specific fab's recipe.
- **SIMULATED** — produced by the running simulation: telemetry, wafer maps, yields, bins.
- **CONCEPTUAL** — illustrative structure: schematic scales, generic layouts, illustrative routes.

All equipment is an *industry-inspired educational model*. No proprietary architecture, recipe or
process data is reproduced. Supply-chain nodes are generic categories, never companies, and globe
locations are illustrative by region. The sources panel lists 25 references (Plummer, Sze, Deal & Grove,
Czochralski, Dash, Kern, Meyerhofer, Preston, Mack, ISO 14644-1, SEMI M1/E47.1/E84, IRDS 2023,
SIA–BCG 2021, Natural Earth and others).

---

## Architecture

A runtime architecture diagram (made with [Archify](https://github.com/tt-a1i/archify), every node linked to the source lines it describes) lives in
[`.archify/architecture-fab-twin-runtime-20261012-074517/fab-twin-runtime.html`](.archify/architecture-fab-twin-runtime-20261012-074517/fab-twin-runtime.html) — open it in a browser.
Its source is `candidate.json` next to it.

```
app/                 Next.js App Router entry, global styles (green journey palette)
components/
  App.tsx            shell: init, deep links, keyboard, finale trigger, layout
  ui/                TopBar, ProcessRail, StageHUD, WaferHUD, Toolbar/Transport, SidePanel
                     (inspector, machine, companion, data, wafer twin, sources), Overlays, Landing,
                     Loader, colour-grade overlay
  charts/            sparkline, line chart with bands, wafer-map SVG, bars
  fallback/          2D technical view
  3d/
    Stage3D.tsx      Canvas, renderer settings
    CameraRig.tsx    presets per scene × camera mode, follow, cinematic cues, scale probe
    SceneSwitcher.tsx  lazy-loaded scenes (one module per scene, next one prefetched)
    environments.tsx lighting (tinted by the journey grade), cleanroom / hall / assembly rooms
    materials.ts     shared material library, x-ray / cut-away shells
    parts/           primitives, interaction (clickable, labels, sensors), wafer & FOUP,
                     robot arm, cluster tool, cross-section profiles and insets, atoms,
                     people, live screens, earth texture
    scenes/          29 scenes (fab, materials, crystal, ingot, finishing, robot, thermal,
                     deposition, track, lithography, etch, implant, CMP, cycle, transistor,
                     interconnect, metrology, inspection, probe, dicing, packaging, final test,
                     shipping, globe, supply chain, control room, utilities, system, scale)
data/                stages & telemetry (process.ts), scenes & camera presets, machines, robots,
                     sensors, materials, glossary, failures, comparisons, sources, fab layout,
                     supply chain, object descriptions
simulation/
  engine.ts          singleton rAF loop: stage player, twin, telemetry, fab, robot, control loops
  player.ts          play / pause / step / seek / speed / auto-advance / before-after override
  twin.ts            wafer digital twin with a legal state-transition table and deterministic rebuild
  telemetry.ts       ring-buffered channels, phase-gated warn/fault bands
  models.ts          physics-flavoured models shared by geometry *and* telemetry: Czochralski radius,
                     Deal–Grove, spin coat ∝ ω^-½, etch profile, implant range, RTP, CMP (Preston),
                     exposure fields, die grid, simulated wafer map, metrology ground truth
  fab.ts             discrete-event fab: tools, lots, dispatch, OHT vehicles, metrics, alarms
  robot.ts           θ–R–Z SCARA controller with synchronised trapezoidal moves and a vacuum interlock
  control.ts         PID loops and EWMA run-to-run control
lib/                 UI store (zustand), runtime registries, journey colour grading (OKLCH),
                     search, audio, offline assistant (with an optional remote-provider interface)
types/               domain types
```

Key ideas:

- **Scenes are pure functions of the stage player's view** (`phaseId`, `phaseT`, `stageT`). Scrubbing, stepping, before/after previews and the 2D view therefore always agree with the 3D world.
- **One model drives geometry and data.** For example, the oxide thickness drawn in the cross-section is the same Deal–Grove value plotted in the HUD, and the etch profile, CMP step height and implant depth work the same way.
- **The UI reads the engine at a fixed tick** (`useTicker`). The 3D layer reads it inside `useFrame`, so no 60 fps state goes through React.
- **Journey colour grading:** a continuous OKLCH path through the greens (olive → moss → forest → pine → jade). Each stage and each layer cycle samples its own grade, with a slow organic drift. It feeds CSS variables and Three.js lights and fog.
- **Performance:** lazy scenes, shared geometries, instancing, merged fab-tool geometry, `?quality=low`, and a 2D fallback.

### Extending

- **Add a stage:** add an entry to `data/process.ts` (phases, telemetry samplers, effect on the twin, facts, sources) and point it at a scene and variant.
- **Add a scene:** create `components/3d/scenes/MyScene.tsx`, register it in `SCENE_LOADERS`, and add camera presets in `data/scenes.ts`.
- **Assistant:** `lib/assistant` answers offline from the local knowledge base. `RemoteProvider` is a disabled stub, ready to wire to a model endpoint if wanted.

### Verification

`npm run typecheck` and `npm run build` pass. Every stage was rendered headless (Chromium /
SwiftShader) at mid-stage with its cued camera, with no console or page errors. The overlays,
the 2D view and a 390 × 844 phone viewport were also checked.
