# Multiple globes: plan (draft, 2026-11-19)

Several globes side by side, each showing its own node of the data tree (scenario › model › member, or an ensemble
or multi-model mean) at its own year, in a grid that grows and shrinks as globes are added and removed. One legend
for all of them. A globe (grid cell) can be selected; the timeline sets the year of the selected globes. Branch
`multi-globe`. Status: **decided 2026-11-19 (§10); stages 1 and 2 built 2026-11-19 (§11, §12).**

## 1. Stages (as asked)

1. **Three fixed globes in a row.** Hard-coded nodes, e.g. the SSP1-2.6, SSP2-4.5 and SSP5-8.5 multi-model means.
   Select and deselect globes; the timeline moves the selected globes' year only. This stage carries most of the
   work: one renderer drawing several globes, per-globe state, selection, the timeline following a selection.
2. **Dynamic grid.** The layout follows the number of globes (a pure function, unit-tested); add and remove
   globes (a + button and × on each cell to test it before the tree is wired).
3. **Tree-driven.** The data tree edits the focused globe, + adds a copy of it for the tree to change, × removes
   one (option a, §7; D7).

## 2. What exists and what changes

Today one node is shown: `shared.selection` (the tree's pick), `shared.node` (its key, once loaded) and
`shared.year`; `App` opens the node (`openNode`), swaps `dataset`, and `stageGlobe` draws it full screen with one
`WebGLRenderer`, eased right of the metric pane and below the open tree with `setViewOffset`.

These three move into a list of globes; everything else in shared state stays shared:

```ts
globes: { id: number; selection: Selection; node: string; year: number }[]; // node: key once loaded, as now
selected: number[]; // globe ids; the last one is the focus (timeline series, tree, metric pane, PNG)
```

| Shared by all globes (one legend) | Per globe |
|---|---|
| metric, colormap, colour range (`ranges`), stippled statistic, threshold, dot size, column height and colours, spin, orientation and zoom (D3) | node (scenario, model, member), year |

The colour range and stippling stay common on purpose: side-by-side comparison only works on one colour scale.
The legend's wording comes from the focused globe's dataset ("spread of 8 models" vs "of 50 members").

`App` keeps a dataset per node key (`Map<string, Promise<Dataset>>`; `openNode` already opens each store once), so
two globes on the same node share one. The metric pane lists the focused globe's metrics (every mock node has all
of them; greying out missing ones stays deferred).

## 3. Rendering: one renderer, one canvas, a scissor rectangle per globe

**Measured 2026-11-19 (browser tool, Chromium):** a page keeps at most 16 live WebGL contexts; the 17th makes the
browser drop the oldest ("Too many active WebGL contexts. Oldest context will be lost"), and the app's own globe
was the first to go black. One renderer per globe would cap the grid near 16 and fail silently past it, and would
load the coastlines, lookup tables and shader programs once per globe. So: **one `WebGLRenderer` over the whole
stage**, and per frame, for each cell, `setViewport` + `setScissor` to the cell and render that globe's scene (the
three.js "multiple elements" pattern). This is the plan from stage 1, so stage 2 is layout only.

Split `stageGlobe.ts` (about 530 lines) into:

- **`globeStage.ts`**, the viewport (`mount(el, state)` → `update`, `destroy`; no Svelte): the renderer and
  canvas, the redraw-on-demand loop, the shared orientation (yaw, pitch, flick, spin) and zoom, pointer handling,
  the cell rectangles (from `layout()`, §4) eased when the insets change. One camera driven by OrbitControls (zoom
  only, as now); per cell its position is copied and the aspect set to the cell's.
- **`globe.ts`**, one per globe: the surface and column materials (their own field and stipple textures, filled in
  place as now), the halo, the `setData` loading with latest-wins per globe. Shared across globes: sphere, halo and
  coastline geometry, the column geometry for the dot spacing (dot centres do not depend on the data), the two
  lookup tables, the coastline material. Three.js compiles each shader program once.

**Interaction.** The pointer is hit-tested against the cell rectangles; a grab uses that cell's projection and keeps
the pointer capture across cells. A press and release without movement (under 4 px) is a click: it selects that
globe (§5). Wheel or pinch over any cell zooms all (D3).

**Cost.** Per globe and frame: a 96 × 48 sphere (9k triangles), the columns (6.6k instances at the default dot size,
most collapsed; up to 41k at 1°), coastlines and halo. Nine globes with every column showing at 2.5° is about 1.5M
triangles; typical frames are far below. Spinning redraws every globe every frame (they turn together); idle with
spin off draws nothing, as now. GPU memory per extra globe: two 360 × 180 float textures, 0.5 MB.

## 4. Layout (stage 2)

`layout(n, area, gap)` → cell rectangles: try every column count c = 1..n with r = ⌈n / c⌉ rows; the globe diameter is
min(cell width, cell height); take the c that gives the biggest globe (ties: fewer rows). A short last row is centred.
Pure TypeScript in `src/viewports/grid.ts`, tested in `tests/grid.test.ts` like the tree rules (e.g. 3 globes in a
wide area are 3 × 1, in a phone's portrait area 1 × 3; 4 are 2 × 2; 5 are 3 + 2 with the 2 centred).

The area is the stage minus the metric pane (`insetLeft`), the open tree (`insetTop`) and, new, the timeline
(`insetBottom`): with one globe it may sit behind the timeline as now, but a lower row of globes must not. The
legend keeps floating and draggable over the cells.

Per cell, an HTML overlay (Svelte, positioned from the same `layout()`) carries the globe's label ("SSP2-4.5 ›
CanESM5 › r1i1p1f1 · 2071"), the selection ring and, from stage 2, a × to remove it. The labels are buttons, so
selection works from the keyboard too; the canvas underneath keeps the pointer for rotating.

## 5. Selection and time

Proposal (D4, D5):

- Click a globe (or its label): it alone is selected. Shift- or Ctrl/Cmd-click toggles it in the selection. The
  last one clicked is the **focus**.
- The timeline draws the focused globe's series and plume, its needle at the focused globe's year. Dragging the
  needle, clicking the chart, the ◀ ▶ buttons and the keyboard set the year of **every selected globe** (they snap
  to the same year). Unselected globes keep theirs. Small ticks on the time axis mark the other globes' years, so
  you can see where each one is.
- Nothing selected: the timeline moves all globes (D5). The focus stays where it was (the tree and the timeline's
  series still need one).
- Each label shows its globe's year, so mixed years read at a glance.

Comparing one run against itself across time (e.g. 2030 vs 2090) is then: two globes on the same node, select one,
move it.

## 6. Data and bandwidth

Each globe loads its own field and statistic per year step: 225 + 229 kB (`BANDWIDTH.md`), so a year step with N
selected globes pulls ~0.45 MB × N (3 globes 1.4 MB, 9 globes 4 MB, 16 globes 7 MB); latest-wins per globe already
drops stale requests while scrubbing. A new node costs its store's metadata (58 kB) and series, at most a plume of
445 kB per metric for a large ensemble. Capped at 6 globes (D6): at most ~2.7 MB per year step.

**Cache change needed.** `grids()` in `catalog.ts` keeps only the latest year per array. Members of one ensemble
share their ensemble's statistic arrays, and two globes on one node share all arrays, so globes at different years
would evict each other on every redraw. Keep a few years per array instead (small LRU, e.g. 8 entries, about 1.8 MB
per array at most), or key by year per globe.

## 7. Stage 3: the tree drives the globes (D7)

Options:

a. **The tree edits the focused globe**, plus explicit + (adds a copy of the focused globe, which the tree then
   edits) and × on cells. Simple and predictable; already needed in stage 1, because the tree must do something.
b. **Ctrl/Cmd-click in the tree adds a globe** for that node (plain click edits the focused globe, as in a); nodes
   with globes get a small marker (a count badge) in the tree, and the chip reads "3 globes". Fast for building a
   comparison.
c. **Compare along a column**: a button on a tree column (scenarios, models, members) spreads the current pick
   along it: "all scenarios for CanESM5" makes one globe per scenario, "these 6 members" one per member. Small
   multiples in one click; the most powerful, and the most UI.

Decided (D7): a. The tree edits the focused globe from stage 1; stage 3 finishes a (+ copies the focus, × removes,
both from the tree pane as well as the grid). b and c are not planned.

## 8. Stage checklist

1. Shared state `globes`/`selected`; datasets per node in `App`; `globeStage.ts` + `globe.ts` replacing
   `stageGlobe.ts`; three cells in a row (fixed); labels with selection ring; click and Shift/Ctrl-click
   selection; timeline follows the focus and sets the selected globes' years, ticks for the others; tree edits the
   focused globe; the `grids()` cache. Checks: rotate and zoom act on all; select and deselect; scrub with one,
   two, none selected; idle frames 0 with spin off; no console errors; one WebGL context.
   Estimate: the largest stage, about +450 / −300 lines.
2. `layout()` + tests; `insetBottom`; + and × buttons; cells ease into their new places. Checks: 1–16 globes at
   desktop and phone sizes; adding during a scrub. About +150 lines.
3. Option a finished: + copies the focused globe (the tree then edits the copy), × removes; the tree's chip names the
   focused globe and says how many there are. About +60 lines.

## 9. Risks

- **Phones.** Three globes stacked in a portrait phone are small (about a third of the height each). Possibly one
  globe at a time with swiping, or a cap of two (D8).
- **Labels and legend over small cells.** With many globes the floating legend covers some of them; it stays
  draggable.
- **Grab on a small globe** is coarser (fewer pixels per degree); the soft edge limit still applies per cell.
- **PNG export** exports the focused globe only.

## 10. Decisions (2026-11-19)

| # | Question | Decided |
|---|---|---|
| D1 | One renderer with scissor cells, or one renderer per globe? | One renderer (measured: 16-context limit, silent loss) |
| D2 | Shared vs per globe | Only node and year per globe; metric, colours, range, stippling shared (one legend) |
| D3 | Globes rotate and zoom together, or each on its own? | Together |
| D4 | Selection | Click selects one (again on the only selected one: none), Shift/Ctrl/Cmd-click toggles; the last selected is the focus |
| D5 | With nothing selected | The timeline moves all globes |
| D6 | Cap on globes | 6 (about 2.7 MB per year step when all scrub together) |
| D7 | Tree interaction (§7) | a: the tree edits the focused globe; + and × |
| D8 | Phones | Same grid, cap 3, revisit after stage 2 |

## 11. Stage 1 as built (2026-11-19)

- `src/state/globes.ts`: `Globe`, `focused()`, `timed()`, `pick()` (tests in `tests/globes.test.ts`). Shared state
  `globes`, `focus`, `selected` replace `selection`, `node`, `year`.
- `src/viewports/globe.ts` (`globeKit()` shared, `createGlobe()` per globe) and `globeStage.ts` (renderer, cells in
  one row, shared orientation and zoom, click vs drag) replace `stageGlobe.ts`.
- `App.svelte`: datasets per node key; labels above the globes (below them, the legend covered the left one);
  a tint behind selected cells. `DataTree` edits the focused globe; the timeline follows it and loads series by
  node key (through the focused `dataset` it charted the previous node's series for a moment: a race).
- `grids()` keeps 8 years per array.
- Cells 16 px apart (`GAP`, added after review): zoomed in, each globe is clipped short of its neighbour.
- Checked in the browser: one WebGL canvas; clicking the middle globe moves only it; Shift-click adds the left one
  (focus moves, both snap to one year, a tick marks the third's); clicking twice clears (all move); a drag rotates
  all and selects nothing; the tree edits only the focus; no frames while idle with spin off (on software GL a
  flick coasts for several seconds, at a few frames per second); no console errors.
- Left for stage 2: the selected-cell tint spans the full height (behind the timeline) until `insetBottom` exists;
  three in a row on a phone are small until the layout picks rows.

## 12. Stage 2 as built (2026-11-19)

- `layout(ids, area, gap)` in `src/viewports/grid.ts` (tests in `tests/grid.test.ts`): the column count giving the
  biggest globe; on a tie within half a pixel the fewest empty places (first built with "more columns", which made
  four globes 3 + 1 in a 1000 × 600 area; the test now covers it); a short last row centred.
- The area: right of `insetLeft`, below `insetTop` (now always set: the tree's chip, or its open pane, plus 8 px),
  above `insetBottom` (new: the timeline's height plus padding). Cells move to a new layout over 300 ms by elapsed
  time (first built per frame, a quarter of the way each frame: with six globes on software GL that took seconds).
- `add()` and `remove()` in `src/state/globes.ts` (tests): + in the tree's chip copies the focused globe (pick,
  node, year) after it and focuses it, replacing a selection if there was one; × on each label removes a globe, the
  focus moving to the last selected one or a neighbour; never fewer than one, at most 6 (`MAX_GLOBES`, 3 on phones).
  With the add, stage 3 (option a) is mostly in place: the tree edits the focus, + copies it, × removes.
- Checked in the browser: 3 → a row, 4 → 2 × 2, 5 → 3 + 2 centred, 6 → 3 × 2 and + disabled; cells 8 px clear of
  the chip and the timeline; adding during a scrub keeps the years in step; the tree edits the new globe; removing
  the focus moves it on and re-enables +; no idle frames with spin off; no console errors. Phone (390 × 844): three
  globes make 2 + 1 (a hair bigger than a column of three once the chip row and timeline take their room); + is
  disabled at 3.
- Known: the floating legend covers part of the lower-left globe (draggable); labels lose their year to the
  ellipsis on phones.
- After review: the page starts with one globe (the tree's first selection) instead of the three fixed ones of stage 1;
  + adds more.
