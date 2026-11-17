# Data tree: plan (draft, 2026-11-17)

A top pane showing how the data is organised (scenarios, models, ensemble members) as a branching diagram. Picking a
node in it selects the data that the globe, legend and timeline show. Modelled on Lantern's catalogue picker
(`/home/oxygen/Documents/Lantern`, `src/tree.js`, `src/picker.js`, `prototype/`). Lantern is a reference only: no
code, package or file from it is imported. The metric stays in the left pane. Status: **decided 2026-11-17 (D1–D7, §10); phase 1
(catalog and mock) built on branch `data-tree`.**

## 1. What Lantern has

- Three columns, Models → Scenarios → Realizations, with curved links from each item to its children. Hovering a
  model shows its scenarios and hovering a scenario shows its realizations; a click fixes a choice (bold, dark
  links) and a second click releases it. Unrelated items are grey.
- Under each column, "aggregators" (select / mean / variance / diff), each with a coloured dot. Choosing one puts
  the whole column in play and draws a coloured box round it. Items not shared by everything in play (a scenario
  some model lacks) are struck out and can't be clicked.
- Realizations: all selected at first. A click toggles one and a double-click keeps only that one. Each has a 16 px
  spinning globe (d3-geo, prerendered frame sheet).
- The rules are separate from the DOM (`createTree(catalogue)` → `items(column)`, `lines()`, `query()`), with 14
  node tests. Drawing uses d3-selection plus an SVG overlay positioned from the items' bounding boxes.
- Scale it was built for: 5 models, ≤ 4 scenarios, ≤ 8 realizations (`prototype/catalogue.json`, names only).
- Selections are sent to a server (Dask) that computes the mean or variance of any subset; an "Update" button
  starts the job.

## 2. Target scale (measured)

Public `cmip6-pds` index (`pangeo-cmip6.csv`), monthly `pr` (Amon), members that exist in historical *and* the SSP:

| model | ssp126 | ssp245 | ssp370 | ssp585 |
|---|---|---|---|---|
| EC-Earth3 | 57 | 71 | 57 | 58 |
| CanESM5 | 50 | 50 | 50 | 50 |
| MIROC6 | 50 | 50 | 3 | 50 |
| ACCESS-ESM1-5 | 40 | 10 | 30 | 10 |
| MIROC-ES2L | 10 | 30 | 10 | 10 |
| GISS-E2-1-G | 10 | 14 | 22 | 10 |
| UKESM1-0-LL | 13 | 14 | 13 | 5 |
| MPI-ESM1-2-LR | 10 | 10 | 10 | 10 |
| … 42 more models | mostly 1–11 | | | |

That is 50 models with at least one SSP and 1288 SSP member runs in total. The hierarchy is ragged: models differ in
which scenarios they ran, and member counts differ by scenario. This is ten times Lantern's size, so the design has
to change in three places:

1. **One curve per member doesn't work** (71 curves into a pane about 220 px tall). Members become a grid of small
   cells, joined to their parent by one bundled link.
2. **A column of 50 models doesn't fit** in a top pane. Models flow into several sub-columns sorted by ensemble size
   (or grouped by institution), and only links for the hovered or fixed model are drawn. "All models" is drawn as
   one bundle whose width scales with the number of models.
3. **No reductions of arbitrary subsets in the browser** (rule 2: 70 members × 260 kB per year step). Aggregates
   have to be precomputed nodes (§3).

## 3. What a selection means

The selection is a path in the tree, and every node with data is a precomputed **Dataset** (the existing `Dataset`
→ `Metric` → `Statistic` model, unchanged):

| node | colour (the metric) | statistics (elevation, stippling) | timeline |
|---|---|---|---|
| scenario › model › member | that member's field | the model's member agreement and spread (context) | the member's line, over the plume of its ensemble |
| scenario › model › *ensemble* | mean of the model's members | **member** agreement and spread (internal variability) | ensemble mean, over the plume of its members |
| scenario › *all models* | mean of the model ensemble means | **model** agreement and spread (structural) | multi-model mean, over one line per model |

- Lantern's aggregators map onto these: "select" means one item and "mean" means the ensemble or all-models node.
  Variance becomes the spread statistic, shown by elevation, stippling or the legend.
- Lantern's "diff" (scenario minus scenario) is deferred; it would need precomputed differences.
- **D1: arbitrary member subsets.** Lantern's per-member toggle can't change the maps without a reduction in the
  browser. Proposal: no subset toggling. A click picks one member and "ensemble" means all of them. Highlighting
  members in the plume is allowed, since that is only drawing.
- Struck-out items are no longer needed, because the all-models mean is precomputed over whichever models have the
  scenario. Instead, counts are shown ("ssp370 · 41 models", "CanESM5 · 50").
- Historical is not a separate scenario. A run is historical plus its SSP continuation, as the mock already
  assumes. Members are counted as above (present in both).

## 4. Column order

**D2:** Lantern uses Model → Scenario → Member, which matches the CMIP6 key path. Proposal: **Scenario → Model →
Member**:
- the first column is short (4 items);
- the all-models node is "all models" under a fixed scenario, which is how multi-model means are defined;
- the model column then lists only models that ran that scenario, ordered by ensemble size, so the large ensembles
  come first.

The rules module (§6) takes the facet order as data, so swapping the order later is cheap.

## 5. The top pane

```
closed: a chip at the top centre, which is also the readout of the selection
                 ┌────────────────────────────────────────────┐
                 │ SSP2-4.5 › CanESM5 › ensemble (50)       ▾ │
                 └────────────────────────────────────────────┘

open (wide screen, metric pane open on the left; about 220–260 px tall, scrolls inside if needed)
┌ pane ┐┌──────────────────────────────────────────────────────────────────────────────────────────┐
│      ││ Scenario            Model · members                         Members of CanESM5 · SSP2-4.5   ▴ │
│      ││  SSP1-2.6 ─╮        EC-Earth3      71 │ GISS-E2-1-G  14 │ …     ■■■■■■■■■■■■■■■■■■■■■■■■■      │
│      ││ [SSP2-4.5]═╪══════▶[CanESM5       50]│ UKESM1-0-LL  14 │ ═══▶  ■■■■■■■■■■■■■■■■■■■■■■■■■      │
│      ││  SSP3-7.0 ─┤        MIROC6         50 │ MPI-ESM1-2-LR 10 │       [ ensemble ]  r1i1p1f1 …     │
│      ││  SSP5-8.5 ─╯        MIROC-ES2L     30 │ …               │                                    │
│      ││                     [ all models · 48 ]                                                       │
└──────┘└──────────────────────────────────────────────────────────────────────────────────────────┘
                                  (globe centred in the area below and right)
```

- It opens downward from the top edge. While it is open, the globe centres in the area below it (a new
  `shared.insetTop`, alongside `insetLeft`, applied through the same `setViewOffset`; the easing code is already
  there).
- The top-right tools (colormap, gear) move into the pane's header row, or below the pane. To decide during the
  build (screenshot both).
- Phones: the pane covers the page when open and closes on a pick, like the metric pane.
- Hover previews the branches only. A click applies the selection straight away, with no "Update" button: loading
  one node's metadata and one chunk takes milliseconds, unlike Lantern's server jobs.
- Lantern's per-member spinning globes are dropped: 70 animated canvases break the rule that nothing draws while
  idle. Member cells are static and coloured by state (picked, in the ensemble, no maps).
- Keyboard: arrow keys move between items in a column and Enter picks, like the timeline's slider.

## 6. Code (hydroviewer conventions)

| piece | where | notes |
|---|---|---|
| tree rules | `src/data/tree.ts` | Pure TypeScript, no DOM (Lantern's split): `items(column)`, `links()`, `selection()`, hover/pick actions, given the catalog. Facet order is data. |
| tree rules tests | `src/data/tree.test.ts`, `node --test` in the `web` container | **D6:** keep in the repo (logic with many cases, as Lantern found), or throwaway as so far. No new dependency either way. |
| top pane | `src/ui/DataTree.svelte` | Buttons and lists in Svelte (accessible, keyboard); the links in an SVG overlay drawn from item rects after layout, as in Lantern. It is UI, not a renderer, so rule 3 (viewports must not import Svelte) is untouched. No d3 (not a dependency here; plain SVG paths). |
| catalog | `src/data/catalog.ts` | Parse the tree (§7); `openNode(path)` → `Dataset`, memoized per node. |
| shared state | `src/state/shared.svelte.ts` | `selection: { scenario, model, member }` (`'*'` = ensemble or all models), `insetTop`. |
| app | `App.svelte` | The dataset follows `shared.selection` (`$state.raw`). The metric pane greys out metrics a node lacks; the chosen metric and statistics stay when they exist. |
| globe | `stageGlobe.ts` | Today it takes the metrics once at mount; it needs to take a new `Dataset` on a selection change (its loader race guard covers the switch). `insetTop`. |
| timeline | `timeline.ts` | Reload the series on a dataset change, not only on a metric change. Phase 4: the plume. |

## 7. Data layout and catalog

**D3: store layout** (decided: per node, plus one series store; built in phase 1):
- **One store per node with maps**: `<metric>` (year, lat, lon), `<metric>_global_mean` (year), `year`, `lat`,
  `lon`; one year per chunk. Aggregate nodes add `<metric>_agreement` and `<metric>_spread` on the field's axes. A
  member store has no statistics: a member node takes them from its ensemble's store. Paths mirror the CMIP6 key path:
  `CMIP6/ScenarioMIP/CCCma/CanESM5/ssp245/r1i1p1f1/annual.zarr` (member), `.../ssp245/ensemble/annual.zarr`
  (ensemble), `CMIP6/ScenarioMIP/multimodel/ssp245/annual.zarr` (multi-model).
- **One series store** for plumes, `members.zarr`: `<metric>_global_mean` (member_run, year), with one row per member
  run in catalog order (a run's members start at its `series` row), and `<metric>_ensemble_global_mean` (run, year),
  with one row per run. It's dense, so there are no fill values or masks, and it is one small chunk per array
  (887 × 151 float32 for the default mock). The plume costs one request instead of up to 70.
- Rejected (A): one stacked store with dims (scenario, model, member, year, lat, lon). Adding a model would rewrite
  arrays, and the layout departs from the key path.

Catalog (as written by the mock; replaces the earlier flat `datasets` list):

```json
{
  "mock": true,
  "facets": ["scenario", "model", "member"],
  "scenarios": [{ "id": "ssp245", "label": "SSP2-4.5" }],
  "metrics": [{ "id": "pr", "group": "Precipitation", "statistics": ["agreement", "spread"] }],
  "series": "members.zarr",
  "multimodel": { "ssp245": { "store": "CMIP6/ScenarioMIP/multimodel/ssp245/annual.zarr", "models": 8 } },
  "runs": [
    { "scenario": "ssp245", "model": "CanESM5", "institution": "CCCma",
      "members": ["r1i1p1f1", "r2i1p1f1", "…"], "maps": ["r1i1p1f1", "r1i1p2f1", "r2i1p1f1"],
      "store": "CMIP6/ScenarioMIP/CCCma/CanESM5/ssp245/{member}/annual.zarr",
      "ensemble": "CMIP6/ScenarioMIP/CCCma/CanESM5/ssp245/ensemble/annual.zarr", "series": 71 }
  ]
}
```

`maps` lists the members that have map stores. Every member has a series. Real prep will probably not write maps for
all 1288 runs (about 72 MB each in this layout: roughly 90 GB), so the UI must handle a member without maps: the
cell is shown hollow, and clicking it shows the ensemble plus that member's line. `mock: true` lets the generator
replace a previous mock and refuse to write over anything else.

## 8. Mock

`prep/make_mock.py` grows from one dataset to a multi-model ensemble, built so that the statistics are *computed
from the mock members* (mean, agreement of the sign of change since 1970, standard deviation). That exercises the
same reductions real prep will do. The analytic statistics go away.

- Members = today's formulas with a member-specific phase on the year-to-year wobble and noise. Models = a
  per-model bias, pattern shift and climate sensitivity. Scenarios = a forcing scale on `warming()` (ssp126 low …
  ssp585 high), identical before 2015.
- Names and member counts: real ones from the index above, hard-coded (names only, like Lantern's
  `catalogue.json`).
- **D4: size** (decided). `--models` (default 8: the largest ensembles; 50 = all), `--map-members N` (default 3
  per model and scenario; every member still feeds the statistics and has a series), `--workers` (default 6, about
  2 GB each). Measured with the defaults: 887 member runs (96 with maps), 32 ensemble and 4 multi-model stores,
  21 GB, 199–210 s on 6 of 24 cores (about 0.85 s per member: formulas 0.5 s, statistics and global means 0.3 s).
  The tree's scale comes from the catalog and series, which are cheap at any size.
- Regeneration stays one command (`docker compose --profile prep run --rm mock [--models …]`), into `$DATA_DIR`.

## 9. Phases

1. **Catalog and mock** (built 2026-11-17): the new catalog format, `make_mock.py` with members, models, scenarios, computed aggregates
   and the series store; `catalog.ts` reads the tree and opens nodes. The app keeps working with a default
   selection. Check: values of computed statistics against a direct numpy reduction (throwaway); the emulator log
   for which keys a selection reads.
2. **Tree rules:** `tree.ts`, tests for hover, pick, release, ragged availability, counts, links and member cells
   without maps.
3. **Top pane:** `DataTree.svelte`, closed chip and open pane, `insetTop`, tools placement, phones, keyboard.
   Browser checks: screenshots at 1280 × 800 and phone width, 0 globe frames while idle, a drag-free pick flow
   with a Playwright script.
4. **Switching data:** the globe and timeline take a new dataset; the metric pane greys out missing metrics.
5. **Plume on the timeline:** the node's members (or models) as faint lines and the aggregate in bold, hover to
   identify (a Plot layer; drawing only).
6. **Docs:** CLAUDE.md, DEV_PLAN (data contract: catalog, node stores, series store).

## 10. Decisions (all made 2026-11-17)

- **D1** Member choice: one member or the whole ensemble. No subsets in the maps' aggregates; highlighting in the
  plume is only drawing.
- **D2** Column order: Scenario → Model → Member.
- **D3** Store layout: one store per node plus one series store (§7).
- **D4** Mock size: 8 largest-ensemble models with maps for 3 members each by default; `--models 50` for all.
- **D5** 50 models in a short pane: sub-columns sorted by ensemble size.
- **D6** Tree-rule tests are kept in the repo (`node --test`, no new dependency); each is checked by breaking the
  code on purpose once.
- **D7** Variables and metrics stay in the left pane, never a level of the tree; the tree only greys out in the pane
  what the chosen node lacks.
