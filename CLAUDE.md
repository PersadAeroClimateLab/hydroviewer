# hydroviewer

Static web app for visualizing climate data (CMIP6, MERRA, ERA5, observational datasets; precipitation
first). Hosted on GitHub Pages. Data lives in Zarr stores in a public bucket (Cloudflare R2 planned). There is
no compute server and no rendering server: everything is drawn in the browser with three.js and Observable Plot.

Read `docs/llm/DEV_PLAN.md` before making architectural decisions. It records the stack, the data
contract, the rationale, and the open questions. If you change a decision, update the plan in the same
change.

## Project state

Front-end overhaul merged into `main` (2026-11-17). In progress: the data tree on branch `data-tree`
(`docs/llm/DATA_TREE_PLAN.md`, plan step 8b). `App.svelte` is a full-screen
three.js globe (`src/viewports/stageGlobe.ts`) with floating panels, on **mock data read from the bucket** (a
multi-model, multi-scenario ensemble of analytic 360 × 180 annual fields for 1950–2100 written by `prep/make_mock.py`;
see Data path). `main.ts` loads the bucket's `catalog.json` (`loadCatalog()`), opens the SSP2-4.5 multi-model mean
(`openNode()` in `src/data/catalog.ts`) and then mounts `App` with it and its years; if that fails the page shows
only the error. The data tree pane picks a node (`shared.selection`); `App` opens it (`openNode`, each store opened
once) and, once loaded, swaps its `dataset` (`$state.raw`) and sets `shared.node` (the node's key, `nodeKey()`), on
which the globe and timeline reload (they read the metrics through a getter); a newer pick wins over a slow load,
and a failure shows a notice. The timeline's year range is the first node's (every mock node has the same). Not
done: greying out metrics a node lacks (every mock node has all four):

- **Data tree** (top, `src/ui/DataTree.svelte`; rules in `src/data/tree.ts`, tested in `tests/tree.test.ts`): closed,
  a chip at the top centre reads out the selection ("SSP2-4.5 › CanESM5 › Ensemble (50)") and toggles the pane;
  open, the pane takes a row under the top row (right of the metric pane) and the globe centres below it
  (`shared.insetTop` from the pane's lower edge, eased with `insetLeft` in `setViewOffset`). Columns: scenarios
  (with model counts), models (sorted by ensemble size, "All models" first; sub-columns of 9 to 14 rows, scrolling
  sideways when there is no room, the picked one scrolled into view), members (an "Ensemble mean" button and a grid
  of 14 px cells: solid with maps, hollow without, blue when picked, the id in the heading on hover). Links are
  SVG curves measured from the items' boxes after each change, thicker for bundles; one that would cross other
  models' names runs along the band above the first row instead. Arrow keys move within a column, Escape closes.
  Phones: the chip gets its own row and the open pane covers the page, columns stacked, no links. Checked with 8
  and (catalog swapped in the browser) 45 models per scenario.

- **Metric pane** (left, `src/ui/MetricPane.svelte`): app title, dataset (model, experiment, member) and its
  metrics grouped (mock: mean precipitation and ten ETCCDI precipitation indices stored at yearly or monthly
  frequency, in groups totals and intensity, extremes, heavy-precipitation days, spells; no temperature, no
  daily data); picking one shows
  it on the globe, legend and timeline (`shared.metric`). Collapses to a title chip («, ☰). Open on wide screens,
  where the globe centres in the area right of it (`shared.insetLeft`; `setViewOffset` shifts the projection, the
  camera stays on its axis, eased); on phones it starts closed, covers the page when open and closes on a pick.
  Data model in `src/data/cmip6.ts`: a `Dataset` has `Metric`s, each with its field per year, global-mean series
  and `Statistic`s (same ids across metrics, so elevation/stippling picks survive a metric change).

- **Globe:** longitude/latitude per pixel from the sphere position (coarse mesh, no pole pinching), one float
  texture refilled in place when the year changes, colormap lookup in the fragment shader, Natural Earth
  coastlines, a faint rim halo. Grab-to-rotate keeps the grabbed point under the pointer (`grab.ts`, north
  stays up, a flick coasts to a stop) within 30% of the globe's on-screen radius; beyond that `softLimit()` eases it
  so the globe turns slower and slower toward the edge and stops past it (the edge is where a pixel covers a
  large angle and dragging got erratic). OrbitControls only zooms. Spins on its own by default (`shared.spin`; a turn in 90 s, eastward, paused
  while grabbed and until a flick has coasted out; off by default under `prefers-reduced-motion`), toggled by the
  Spin switch left of the colormap (a checkbox with `role="switch"`; on phones only the switch shows, its word stays
  for screen readers). Draws only while something moves, so every frame while spinning and nothing while idle
  with spin off (check idle frames with spin off).
- **Elevation and stippling** show per-cell ensemble statistics (`Statistic` in `src/data/cmip6.ts`, the output
  contract: one grid per time step on the field's grid, `units`, `long_name`, `display_range`, `stipple_threshold`,
  `actual_range`).
  Mock: computed from the runs in `prep/make_mock.py` (`Spread`): agreement (fraction of members, or of models for
  the multi-model mean, on the side of the majority's sign of change from each run's 1961–1990 mean, 0.5–1,
  threshold 0.8) and spread (standard deviation of that change; display range per metric in `METRICS`, threshold
  half of it). A member shows its ensemble's statistics. The gear menu picks which statistic each shows, or off (`shared.elevation`,
  `shared.stipple`; defaults agreement and spread); the legend explains both, and its ⇅ button swaps them (the
  draggable action ignores pointer-downs on buttons, inputs, selects and links). A Threshold slider in the gear menu
  moves the stipple threshold between the statistic's `actual_range` (min and max over all years, written by prep,
  so the browser reads no extra data); moved values live in `shared.thresholds` by `<metric>/<statistic>`, and the
  globe only sets a uniform. `stageGlobe(load, statistics)`:
  - elevation: a 360 × 180-segment sphere displaced in the vertex shader (the top of the display range rises
    `shared.elevationScale` × `shared.elevationMultiplier` of the radius: a Height slider in the gear menu, 0–20%,
    default 8%, times an integer multiplier from − / + buttons, ×1–×10, so the slider keeps its fine steps at any
    height; both disabled with elevation off; changing them only sets a uniform, and the closest zoom
    (`controls.minDistance`) rises to stay 0.05 outside the highest peaks), coastlines displaced by the same shader, shading from the relief's slope per pixel, lit from
    the upper left. Grabbing still intersects the unit sphere, so on high relief the grabbed point drifts by up to ~8%.
  - stippling: in the fragment shader, dots fixed to the surface on rows `shared.stippleSize` degrees apart (a Dot
    size slider in the gear menu, 1–6°, default 2.5°; radius a fifth of the spacing, so bigger dots, fewer of them,
    same stippled area), fewer per row toward the poles, each whole: threshold and ink (dark on light colours,
    light on dark) decided at its centre.
  The PNG export has neither (colour only).
- **Timeline** (`timeline.ts`, bottom): the global mean 1950–2100 as a Plot line with a draggable year needle
  (also a keyboard slider) and ◀ ▶ buttons stepping one year, over the node's plume (`Series.plume`, faint lines:
  its ensemble's members for an ensemble or member, the scenario's models' ensemble means for the multi-model mean;
  read whole per metric from the series store `members.zarr`, `seriesRows()` in `catalog.ts`). The selected member
  (`shared.selection.member`, also one without maps) is drawn in the accent colour, and the line nearest the pointer
  (within 6 px at its year) in the text colour, named with its value top right; both are an SVG overlay redrawn on
  its own (`mark()`), not the chart.
- **Colormap** picker and **settings gear** (top right; its menu downloads the field as an
  equirectangular PNG, one pixel per cell, `exportPng.ts`, and imports colormaps), **colour bar** (bottom left, a
  canvas drawn from the same lookup table as the globe). The legend panel is draggable anywhere over the globe
  (`src/ui/draggable.ts`, a Svelte action: pointer or arrow keys, kept inside the page, re-clamped on resize; moves
  by `translate` only, so the globe does not redraw); its offset is kept in localStorage and reset by double-click
  or the gear menu.
- **Colormaps** are SciVisColor ColorMoves JSON exports (`{ colormaps: [{ name, space, points: [{ x, o, r, g, b }] }] }`),
  parsed by `src/data/colormoves.ts`. Built-ins are the files in `src/assets/colormaps/` (id = file name; only
  viridis and magma, by decision: custom maps arrive by upload). A new export dropped there would ship as built-in. Users
  import their own through the gear menu or by dropping a file on the page; those live in localStorage
  (`src/state/colormaps.svelte.ts`). `bakeLut()` in `src/viewports/colormaps.ts` blends the points in Lab or RGB
  into one 1024-entry table that the globe shader, colour bar and PNG all sample. Opacity is ignored.

Shared state is `{ colormap, metric, insetLeft, insetTop, spin, selection, node, year, elevation, stipple, elevationScale, elevationMultiplier, stippleSize, thresholds }` (`src/state/shared.svelte.ts`; the colormap object itself, so viewports need no
registry). Next: real data in the same layout as the mock (prep for CMIP6 writing `catalog.json` and annual
metrics). No URL-hash state yet.
The Pages workflow exists but has not run on GitHub yet (see Deploy).

**Removed (2026-11-17):** the trame/ParaView server and its iframe viewport, and the earlier analysis/layout grid
shell (sidebar, Total Precip./Trend/Extremes/Engines analyses, flat map, relief globe, contour boxplot view, Plot
panels, URL-hash sync). The last version with all of it is merge `6506c10` on `main` (tag `grid-trame-archive`);
`git checkout grid-trame-archive` to look at it.

## Stack (see the plan for detail)

- Vite + TypeScript, Svelte 5 (plain Svelte, not SvelteKit)
- three.js for maps and globes, Observable Plot for charts
- zarrita.js reading Zarr v3 (`bytes` + `gzip` only) over HTTP
- Docker Compose for dev (`node:22-alpine`, Vite on port 5173, bind-mounted source); Python only in `prep/`

## Commands

```bash
docker compose up -d web data                     # dev server (HMR) on :5173 and bucket emulator on :9000
docker compose logs -f web
docker compose run --rm --no-deps web npm run check   # svelte-check (type check)
docker compose run --rm --no-deps web npm test        # tests/*.test.ts (node --test; the data tree's rules)
docker compose run --rm --no-deps web npm run build   # production build into dist/
docker compose build web                          # after changing package.json or the Dockerfile
```

- **Deploy:** `.github/workflows/pages.yml` runs on every push to main: `npm ci`, `npm run check`, then
  `npm run build -- --base=/<repo>/`, published with `upload-pages-artifact`/`deploy-pages`. Repo setting once:
  Settings > Pages > Source: GitHub Actions. Repository variable `DATA_URL` becomes `VITE_DATA_URL`; unset, the
  page reads `http://localhost:9000` (`?data=` still overrides). The page needs a bucket with `catalog.json`
  (upload the mock for now). To check a Pages-like build locally:
  `docker compose exec web sh -c 'npm run build -- --base=/hydroviewer/'`, then
  `docker compose exec -d web vite preview --host --port 4173 --base /hydroviewer/` and open
  `http://web:4173/hydroviewer/` with the browser tool.
- Dependencies live in the image at `/node_modules` (the repo is bind-mounted at `/app`), so there is
  no `node_modules` on the host and no volume to clear. Rebuild the image after any dependency change.
- Edits to `src/` hot-reload. Set `VITE_USE_POLLING=true` on Docker Desktop (Mac/Windows). After a git checkout,
  merge or branch switch, run `docker compose restart web`: Vite can keep a file version from mid-switch (seen
  2026-11-17: `app.css` without `.panel`, so every panel lost its background).
- Vite only accepts the `localhost` and `web` hosts (`allowedHosts`); add others in `vite.config.ts`.
- The sandbox does not publish ports to the host by itself; see the parent CLAUDE.md (`sbx ports`).
  Publish 5173 and 9000 (your browser fetches the data from `http://localhost:9000`).

## Data path

- **Source:** the public `cmip6-pds` S3 bucket (Zarr v2, blosc, chunks of ~100 MB). It is only a
  source: the app cannot use it directly. Keys are
  `CMIP6/<activity>/<institution>/<model>/<experiment>/<member>/<table>/<variable>/<grid>/<version>/`.
- **Data directory:** the emulator serves, and prep writes into, `$DATA_DIR` (set in `.env`, gitignored; default
  `./data`). Each data directory is one bucket root. Here they live outside the repo, because home is snapshotted:
  `/home/oxygen/Downloads/hydroviewer_data/mock` (the mock, the current `.env`), `.../cmip6` (the GFDL-CM4 slice
  below; no `catalog.json`, so the app cannot open it yet) and `.../colormaps` (ColorMoves test files). To switch,
  edit `.env` (or prefix a command with `DATA_DIR=...`) and run `docker compose up -d data`.
- **Mock:** `docker compose --profile prep run --rm mock [--models 8] [--map-members 3] [--workers 4]`
  (`prep/make_mock.py`, about 13 minutes and 59 GB for the defaults) writes a mock multi-model ensemble into
  `$DATA_DIR`, replacing a previous mock (it refuses to overwrite a catalog without `"mock": true`). Real model and
  member names (`prep/mock_ensembles.json`: 50 models, 1288 member runs with monthly pr in historical and an SSP in
  the cmip6-pds index, largest ensembles first), four SSPs, analytic values: each model its own bias and climate
  sensitivity, each scenario its forcing after 2015, each member its own year-to-year variability. The `mock`
  service mounts `prep/`, so edits need no image rebuild (only `docker compose --profile prep build mock` once).
  Layout (`docs/llm/DATA_TREE_PLAN.md` §7), under the CMIP6 key path: per model and scenario, map stores for the
  first `--map-members` members (`.../<member>/annual.zarr`: per metric (`pr`, `prcptot`, `sdii`, `rx1day`, `rx5day`, `r95p`, `r99p`, `r10mm`, `r20mm`, `cdd`, `cwd`; ETCCDI
  values derived from the mean with plausible shapes, see `fields()`) an array (year,
  lat, lon), one year per chunk, with `display_range`, and `<metric>_global_mean` over `year`) and an ensemble store
  (`.../ensemble/annual.zarr`: mean of all members plus `<metric>_agreement` and `<metric>_spread` with
  `display_range` and `stipple_threshold`); per scenario a multi-model store
  (`CMIP6/ScenarioMIP/multimodel/<ssp>/annual.zarr`, the same across model means); `members.zarr` with every
  member's and ensemble mean's global mean (rows in catalog order, for plumes); coordinates `year` (int32 calendar
  years), `lat`, `lon`. `catalog.json`: `scenarios`, `metrics` (`id`, `group`, statistic ids), `multimodel` per
  scenario, and `runs` (scenario, model, institution, `members`, `maps`, store paths, first `series` row); names,
  units and ranges come from the arrays' CF attributes.
- **Prep** (`prep/`, Python in Docker, opt-in profile) converts a slice into our bucket format under
  the same key path, as `.../<version>/map.zarr` plus `aggregates.zarr` in `$DATA_DIR`:
  `docker compose --profile prep build prep`, then
  `docker compose --profile prep run --rm prep CMIP6/CMIP/NOAA-GFDL/GFDL-CM4/historical/r1i1p1f1/Amon/pr/gr1/v20180701 --months 1980`
  (the whole 1850–2014 historical run; about 25 s, 351 MB output). Rebuild the prep image after editing
  `prep/*.py` (the script is copied in). `aggregates.zarr` holds statistics over whole years, all with `units`,
  `long_name` and `period`: maps `pr_trend` and `pr_wettest_month` with `display_range`; series `pr_global_mean`
  and `pr_wettest_month_global` over `year` (cos(lat)-weighted), `pr_trend_zonal` over `lat`,
  `pr_wettest_month_hist` over `bin`; and a contour boxplot of the June–August rain band (`contour_boxplot()`,
  `pr_jja_*`). `map.zarr` also holds `uncertainty`, synthetic noise from `dummy_uncertainty()` that only the removed
  relief globe used. Nothing in the current app reads these stores.
- **Bucket emulator:** the `data` service is nginx serving `$DATA_DIR` with S3-style headers (any-origin
  CORS incl. preflight, byte ranges, ETag, `Content-Range` exposed, no compression, 404 for missing
  keys). Config: `tools/bucket/default.conf`. Use its access log to see which keys a page reads, i.e. what
  must be uploaded to R2.
- **App side:** `src/data/config.ts` picks the bucket URL (`?data=URL` > `VITE_DATA_URL` >
  `http://localhost:9000`); `src/data/catalog.ts` reads `catalog.json` and `openNode(catalog, { scenario, model?,
  member? })` builds a node's `Dataset` from its store's consolidated metadata (explicit `zarr.open.v3`; each store
  opened once); a field is one chunk read per year, keeping the latest per array. `src/data/cmip6.ts` holds the data model and the older, unused loaders for the GFDL-CM4 slice:
  `loadMonth(i)`, `loadField(source)` (the month or an aggregate map), `loadSeries(source)` (a 1D series with its
  coordinate from `dimension_names`), all memoized.
- **Coastlines** are a committed app asset, not bucket data. Regenerate `src/assets/coastlines.json`
  (Natural Earth 110m, pinned to tag v5.1.2, densified to 1° steps) with
  `docker compose --profile prep run --rm --entrypoint python -v "$PWD/src/assets:/assets" prep make_coastlines.py /assets/coastlines.json`.
- The browser tool container reaches the emulator with `?data=http://data:9000`. This is cross-origin, so
  CORS is genuinely exercised.

## Browser tool

`tools/browser/` is headless Chromium + Playwright in Docker, for looking at the dev page and
checking it. It is a Compose service in the opt-in `tools` profile, so it reaches the dev server by
service name (`http://web:5173/`).

```bash
docker compose --profile tools build browser          # once, and after editing Dockerfile/package.json
docker compose --profile tools run --rm browser URL [--shot name.png] [--clip SELECTOR] \
    [--wait 'window.ready'] [--eval 'JS expression']... [--settle MS] [--size WxH] [--logs]
```

- Prints one JSON line: `status`, `errors`, `warnings`, `failed_requests`, `evals`, `shot`. Exit status
  is 0 only if the page loaded and has no console errors or failed requests, so it can gate a check.
- Screenshots land in `./.shots/` (gitignored); view them with the Read tool. WebGL canvases are
  captured (software GL, WebGL2 with float textures works).
- `--eval` takes an expression (wrap statements in an IIFE), runs in order, and returns each result.
- For pointer drags, downloads, dark mode (`page.emulateMedia`) or multi-step flows, write a script in
  `tools/browser/src/` importing `open()` from `lib.mjs` (example in its header) and run it with
  `--entrypoint node`. Delete one-off scripts afterwards.
- Smoke test: `docker compose --profile tools run --rm --entrypoint node browser --test test/smoke.mjs`.
  Run it only after changing `tools/browser/src/`.
- Behind the sandbox proxy, a domain the firewall blocks shows up as `ERR_NAME_NOT_RESOLVED`.
  Dotless host names (compose services like `web`, `data`) bypass the proxy.
- If you change the Playwright version, change `package.json` and the image tag in the Dockerfile
  together, then rebuild.
- A proxy CA for image builds, if needed, goes in `tools/browser/certs/*.crt` (gitignored).

## Rules that must hold

1. **Everything must work on GitHub Pages.** Static output only. No server code, no custom response
   headers (so no `SharedArrayBuffer`/COOP/COEP), no client-side router or SPA fallback, no large
   data files in the repo. Vite `base` must match the Pages path (the workflow passes `--base=/<repo>/`).
2. **Minimize client compute.** Do reductions, regridding, aggregation and rechunking in data prep,
   not in the browser. Do colormapping and similar per-pixel work in shaders.
3. **Renderers are framework-agnostic.** Viewports are plain TypeScript modules implementing
   `mount(el, state)` → `{ update(state), destroy() }` (`src/viewports/types.ts`). They must not import
   Svelte; `ViewportHost.svelte` hosts them.
4. **Keep typed arrays out of deep reactive state** (`$state.raw` or non-reactive storage).
5. **Low complexity.** One tool per job. Do not add a state library, router, component library or
   extra chart library without a concrete need documented in the plan.
6. **Do not build features unprompted.**

## Data contract summary

- Target: regular 1° lat/lon, cell-centered (360 × 180). Fixed for all datasets: longitude
  -180..180 (west to east), latitude south to north. Regridding is not implemented yet; the first
  slice keeps the native GFDL-CM4 grid (180 × 288).
- Per variable: a map layout (chunks `(12, nlat, nlon)`, written), a series layout
  (`(all time, ~12, ~12)`, not written yet) and small precomputed aggregates (`aggregates.zarr`, written).
- Time is stored as integers counted from the first month (`units: "months since 1850-01-01"`), so
  the client needs no calendar code. Precipitation is stored in mm/day.
- float32, no NaN in data read by shaders (use a fill value or mask), CF attributes on all arrays,
  and a root `catalog.json`.
- Bucket needs public read and CORS with `Range`. Do not depend on `Content-Encoding` for chunks.
- Ensemble statistics (agreement, spread, ...) for elevation and stippling: one float32 grid per time step on the
  field's grid and time axis, no NaN, `units`, `long_name`, `display_range`, `stipple_threshold`, `actual_range`
  (plan step 7).

## Working agreements

1. **Never commit automatically.** Always pause for review. Commit only when explicitly told to.
2. **Evaluate complexity and confidence as you go.** When you hit an area of real complexity or
   ambiguity, stop and ask for feedback before proceeding.
3. **Favor the minimal solution.** Prefer an existing function or a small tweak over new code, and
   the standard library over a new dependency. Don't build for edge cases that haven't appeared yet.
   If a test surfaces an edge case, fix it with the smallest change that addresses the root cause,
   without modifying the test.
4. **Keep testing narrow.** Don't run the full test suite unless the change warrants it. Keep tests
   deliberate, and document in a short comment what it means if a given test fails; this also checks
   that the test itself is well written. Kept tests live in `tests/` (Node's runner, no test dependency,
   outside the type check); check each new one by breaking the code on purpose once.

## Conventions

- TypeScript strict mode. Match surrounding code style, naming and comment density; keep comments
  sparse and explain why, not what.
- Pin exact dependency versions (no `latest`); prefer versions at least two weeks old.
- Python (data prep only) lives in `prep/`, with its own Dockerfile and dependency file.
- Docs written for LLM/agent context go in `docs/llm/`.

## Environment notes

- The parent `/home/oxygen/Documents/CLAUDE.md` describes the sandbox (persistent env file, network
  firewall, git auth, port publishing). It applies here. In particular, dev servers must bind to
  `0.0.0.0` and be published with `sbx ports` to be reachable from the host.
- Data goes in `/home/oxygen/Downloads/hydroviewer_data/` (read-write, outside the snapshotted home), never in
  the repo. `/home/oxygen/Documents/Lantern/` (read-only) is an earlier ensemble viewer with visualizations to
  bring over (catalogue picker, plume, uncertainty fractions).
- Use `bash -l -c "..."` if a tool is not found on PATH.
- **Docker's disk is small (about 9.8 GB).** The Playwright image alone is 3.6 GB and build cache piles up.
  If a build fails with "no space left on device", run `docker builder prune -af` (safe, only slows the
  next build), and if needed remove the rebuildable `hydroviewer-browser` image.
- `apt` to Debian mirrors is blocked by the firewall, so images must not `apt-get install`.

## Verified facts

- zarrita 0.7.5 reads our Zarr v3 + gzip store including v3 consolidated metadata; the app loaded it
  cross-origin from the emulator.
- 2026-11-03: a temporary Cloudflare R2 bucket (public `r2.dev` URL, CORS for the Pages origin and
  `http://localhost:5173`, `Range` allowed, `Content-Range`/`Content-Length`/`ETag` exposed) behaves like the
  emulator (200 with CORS, 206 ranges, 204 preflight, 404 for missing keys) and the app loads from it with
  `?data=`. Its CORS does not allow `http://web:5173`, so the browser tool needs a localhost forwarder for it.
