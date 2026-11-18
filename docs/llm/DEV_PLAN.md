# hydroviewer — Development Plan

This document records the stack decisions, the constraints behind them, the data contract, and the
order of work. CLAUDE.md summarizes the current state and the commands.

## 1. Goal

A static web app for 2D and 3D visualization of climate data (CMIP6, MERRA, ERA5, and some
observational datasets; precipitation is the initial focus), for students and researchers. Everything is
rendered in the browser with JavaScript: three.js for maps and globes, Observable Plot for charts.

## 2. Hard constraints

| Constraint | Consequence |
|---|---|
| Hosted on GitHub Pages | Static files only. No server-side code, no custom response headers (so no COOP/COEP, no `SharedArrayBuffer`), no SPA fallback routing, ~1 GB site limit. |
| No compute or rendering server | Data is prepared offline and fetched from a bucket. Client-side compute is minimized; heavy lifting is done in prep or on the GPU. |
| Docker for dev | Reproducible, portable dev server with auto-reload. |
| Low complexity | One tool per job. Avoid frameworks, routers and state libraries until they are needed. |

## 3. Stack decisions

| Layer | Choice | Status | Notes |
|---|---|---|---|
| Hosting | GitHub Pages via GitHub Actions (`upload-pages-artifact` + `deploy-pages`) | Decided | Vite `base` set to the repo path. No client-side router. |
| Build / dev server | Vite + TypeScript | Decided | HMR for dev, static `dist/` for Pages. |
| Dev environment | Docker Compose, `node:22-alpine`, source bind-mounted | Decided | Vite runs with `--host 0.0.0.0`; `server.watch.usePolling` is needed on Docker Desktop (Mac/Windows). Port 5173. |
| Maps and globes | three.js | Decided | Fields uploaded as float textures, colormapped in a fragment shader (GPU, not CPU). |
| Charts | Observable Plot (+ d3 utilities), lazy-loaded | Decided | Add uPlot only if a specific time-series view proves too slow. |
| UI layer | Svelte 5 (plain Svelte, not SvelteKit) | Decided | Alternative considered: Lit. See section 5. |
| Data format | Zarr v3, core codecs only (`bytes` + `gzip`) | Decided, verified | zarr-python writes it; v3 consolidated metadata works. |
| Browser Zarr reader | zarrita.js 0.7.5 | Decided, verified | Reads v2/v3 over HTTP. Its WASM codecs (blosc, lz4, zstd) are lazy chunks our gzip data never loads. |
| Bucket | Cloudflare R2, public, CORS | Planned, verified with a temporary bucket | Behaves like the emulator. |
| trame / ParaView | **Removed** (2026-11-17) | Decided | Previously an optional iframe viewport backed by a Python VTK server, then a dev tool. Dropped to keep one renderer: no mirrored scenes, no server, no Python outside prep. Custom colormaps also need it gone (an iframe only takes initial state through its URL). Last version with it: merge `6506c10`, tag `grid-trame-archive`. |

## 4. Architecture

```
GitHub Pages (static)                    Bucket (R2; nginx emulator in dev)
┌──────────────────────────────┐         ┌────────────────────────────┐
│ Svelte shell (App.svelte)    │ zarrita │ catalog.json               │
│  ├─ shared state module      │────────▶│ <key path>/map.zarr        │
│  ├─ three.js viewports       │         │            aggregates.zarr │
│  └─ Plot viewports           │         │ mock/annual.zarr           │
└──────────────────────────────┘         └─────────────▲──────────────┘
                                                       │ prep/ (Python, offline)
```

### Viewport module contract

Renderers are plain TypeScript modules with no UI-framework imports. The UI framework only hosts them
(`ViewportHost.svelte`).

```ts
interface Viewport {
  mount(el: HTMLElement, state: SharedState): ViewportHandle;
}
interface ViewportHandle {
  update(state: SharedState): void;
  destroy(): void;
}
```

- A viewport that changes shared state (e.g. the timeline's needle) takes a callback in its factory.
- Shared state (now: colormap and year; later: dataset, variable, colour range) lives in a small module.
  Typed arrays stay out of deep reactive state (`$state.raw` or outside reactivity).
- Planned: mirror shared state to the URL hash so views are shareable (the removed grid shell did).

## 5. UI layer: Svelte vs Lit

Svelte 5 was chosen. Lit was set aside for weaker HMR (`customElements.define` cannot re-run), no built-in
shared state, Shadow DOM friction with global CSS and theming, and more boilerplate. Lit's advantage
(pluggable viewports) is covered by the module contract in section 4. Plain CSS, no component library.
Svelte caveat: typed arrays must not go into deep `$state`.

## 6. Data contract

Data is prepared offline (xarray, dask, regridding tools) and written to a public bucket.

### Grid

- Regular lat/lon, **1°**, cell-centered: 360 × 180.
- Longitude **-180..180**, west to east; latitude south to north. Fixed for every dataset; prep wraps and asserts.
- Regridding happens in prep, never in the client. **Not implemented yet:** the first slice (GFDL-CM4, 180 × 288) keeps its native grid, and the stored lat/lon arrays describe it.
- Time is stored as integers counted from the first month (`units: "months since 1850-01-01"`), so the client needs no calendar code (the source uses a `noleap` calendar with hours since 1850). Annual stores (the mock) use a `year` coordinate of int32 calendar years instead.
- Precipitation is stored in mm/day (source: kg m-2 s-1).

### Source data and key layout

The public `cmip6-pds` bucket is a **source**, not something the app can read directly. Its stores are Zarr v2 with blosc/lz4 and chunks of `(600, nlat, nlon)`: for GFDL-CM4 `pr`, about 102 MB compressed per chunk, so one month would cost a 100 MB download. It also has a `1e20` fill value, a `noleap` calendar and CORS that exposes only `ETag`.

Our bucket mirrors its key path: `CMIP6/<activity>/<institution>/<model>/<experiment>/<member>/<table>/<variable>/<grid>/<version>/`, with our stores inside the version directory (`map.zarr`, `aggregates.zarr`, later `series.zarr`) and other datasets (ERA5, MERRA, observations) under their own top-level prefix. A root `catalog.json` is how the app discovers stores (written so far only by the mock, see below).

### Dev bucket emulator

Each data directory is one bucket root. `$DATA_DIR` (in `.env`, default `./data`) picks the one the emulator serves and prep writes into; data lives outside the repo (decided 2026-11-17: in the sandbox, `/home/oxygen/Downloads/hydroviewer_data/{mock,cmip6}`, because home is snapshotted), and switching is `docker compose up -d data` after changing it. The `data` compose service is nginx serving `$DATA_DIR` with S3-style read behaviour (config in `tools/bucket/default.conf`): `Access-Control-Allow-Origin: *`, preflight, `Range`, ETag, `Content-Range` exposed, no compression, 404 for missing keys. Its access log shows which keys a page reads, i.e. what must be uploaded. Measured 2026-11-16 with the removed grid shell: 19 keys, 3.4 MB of the 352 MB store (all of `aggregates.zarr` plus one `map.zarr` chunk); a time control will need every `map.zarr` chunk.

### Sizes (float32, 1°)

| Slice | Raw size |
|---|---|
| One 2D field | ~259 KB |
| 12 months | ~3.1 MB |
| 1850–2100 yearly | ~65 MB |
| 1850–2100 monthly | ~780 MB |
| 3D variable, 30 levels, one month | ~7.8 MB |

No multiscale pyramids at 1°. Revisit if 0.25° data (e.g. native ERA5, ~4 MB per field) is added.

### Layout per variable

- **Map layout:** chunks `(12, 180, 360)` (one year of months per chunk).
- **Series layout:** chunks `(all time, ~12, ~12)` (~1.7 MB each), so a point time series costs a few requests instead of thousands. Not written yet.
- **Aggregates:** precomputed maps and series (global mean, zonal mean, trend, extremes, contour boxplot) as small separate arrays, so the client never reduces a large array.
- Duplicating data across layouts is preferred over client-side rechunking.

### Encoding

- Zarr v3, `bytes` + `gzip` (browsers decode gzip natively; no WASM dependency). No sharding.
- float32 on disk. If size becomes a problem, quantize to uint16 with scale/offset before considering other codecs.
- No NaN in data the shader reads. Use an explicit fill value or a separate mask.
- CF attributes (`units`, `long_name`) on every array so the UI labels itself.
- v3 consolidated metadata (verified with zarrita).
- A static `catalog.json` at the bucket root lists the scenario › model › member tree, the metrics and every store, so the app discovers content instead of hard-coding it (format: `docs/llm/DATA_TREE_PLAN.md` §7); names, units and ranges come from the arrays' CF attributes.

### Mock dataset

Decided 2026-11-17: the mock is data in the bucket, not formulas in the browser, so the app reads mock and real data through one path and switching data directories switches between them. `prep/make_mock.py` (`docker compose --profile prep run --rm mock`) writes a multi-model, multi-scenario ensemble (real model and member names, analytic values, statistics computed from the members) in the data tree's layout: one store per node (member, model ensemble, multi-model mean), a series store for plumes and a tree-shaped `catalog.json` (`docs/llm/DATA_TREE_PLAN.md` §7–8; about 13 minutes and 59 GB for the defaults). Real data should be written in the same layout (`src/data/catalog.ts` reads it).

### Bucket

Public read, CORS allowing the Pages origin with `Range` allowed and `Content-Range`/`Content-Length` exposed, ideally behind a CDN. Do not rely on `Content-Encoding` compression for chunks (it conflicts with range requests); compress in the codec.

## 7. Repository layout

```
hydroviewer/
├── CLAUDE.md, README.md, docs/llm/DEV_PLAN.md
├── docker-compose.yml          # web, data (emulator); profiles: tools (browser), prep
├── Dockerfile                  # node:22-alpine dev image
├── package.json, vite.config.ts, tsconfig.json, index.html
├── src/
│   ├── App.svelte, main.ts, app.css
│   ├── state/                  # shared state module
│   ├── viewports/              # framework-agnostic renderers (globe, timeline) and helpers
│   ├── data/                   # bucket access (zarrita: catalog.ts), data model, colormap parsing
│   ├── ui/                     # Svelte components (viewport host, settings menu)
│   └── assets/                 # coastlines, colormaps
├── prep/                       # Python data prep (xarray), own Dockerfile; make_mock.py writes the mock
├── tools/browser/              # Playwright + Chromium in Docker, for checking the dev page
├── tools/bucket/               # nginx config of the bucket emulator
└── .github/workflows/pages.yml
```

## 8. Phases

Done:

1. **Data path.** GFDL-CM4 historical `pr` (1850–2014) prepped to Zarr v3 + gzip, served by the emulator, read by zarrita, drawn with three.js; coastlines as a committed asset; R2 verified with a temporary bucket.
2. **Dev kit.** Docker Compose + Vite + Svelte + TypeScript with HMR; a Pages workflow (written and built locally under `/hydroviewer/`, not yet run on GitHub).
3. **Viewport contract and shared state.**
4. **Analyses on a grid shell** (removed 2026-11-17, kept in history at merge `6506c10`, tag `grid-trame-archive`): a sidebar with layouts and analyses (Total Precip., Trend, Extremes, Engines), three.js maps and globes, trame panels, Plot charts, URL-hash sync, and a contour boxplot of the June–August rain band (Whitaker, Mirzargar and Kirby 2013) drawn in shaders. Prep still writes all of their aggregates.

In progress:

5. **Front-end overhaul** (branch `frontend-overhaul`). Layouts brainstormed: full-screen map with floating panels, map with axis-sharing charts, metric gallery plus detail, side-by-side compare, guided story, student workbench, timeline-first. Chosen first: **full-screen globe with floating panels**, on mock data so the work goes into the globe (formulas in `src/data/mock.ts` until 2026-11-17, now a store written by `prep/make_mock.py` and read from the bucket).
   - `stageGlobe.ts`: longitude/latitude per pixel from the sphere position (exact colours on a coarse 96 × 48 mesh, no pole pinching), one field texture refilled in place on a year change, grab-to-rotate (`grab.ts` solves yaw then pitch so the grabbed point stays under the pointer and north stays up; a flick coasts to a stop; OrbitControls only zooms; near the edge `softLimit()` eases the target by its on-screen distance from the centre, exact up to 30% of the radius and levelling off before 60%, so the per-pixel turn falls to about a sixth at the edge and to zero past it, measured in the browser as a smooth fall instead of the previous near-tripling), drawing only while something moves (0 frames when idle), a faint rim halo. Since 2026-11-17 it spins on its own by default (a turn in 90 s, eastward; off under reduced motion), toggled by a Spin switch left of the colormap; it then draws every frame, and 0 frames when idle with spin off.
   - `timeline.ts` (1950–2100): the global mean as a Plot line (redrawn only on resize) with a needle for the shared year, dragged or clicked, a keyboard slider, ◀ ▶ buttons stepping one year.
   - Metric pane (2026-11-17, `MetricPane.svelte`): left, collapsible; the dataset and its metrics grouped by variable, for the same model/dataset selection. Data model: `Dataset` → `Metric` (field per year, global-mean series, statistics) in `src/data/cmip6.ts`; mock has four metrics (precipitation, wettest day, longest dry spell, temperature) with generic agreement/spread scaled per metric; since 2026-11-17 mean precipitation and ten ETCCDI precipitation indices (PRCPTOT, SDII, Rx1day, Rx5day, R95p, R99p, R10mm, R20mm, CDD, CWD: those stored at yearly or monthly frequency; temperature and daily data dropped, the project studies precipitation). The globe centres in the area right of the open pane by shifting the projection (`setViewOffset`), eased; on phones the pane overlays the page instead.
   - Draggable legend (2026-11-17): `draggable` action (`src/ui/draggable.ts`), legend only, free placement clamped to the page, offset in localStorage, reset by double-click or the gear menu. Measured: 0 globe frames while dragging (the move is a CSS `translate`). Reusable for other panels if wanted.
   - Settings gear (`SettingsMenu.svelte`): downloads the current field as an equirectangular PNG, one pixel per grid cell, coloured with the globe's colormap and range, no coastlines (`exportPng.ts`).

6. **Custom colormaps from SciVisColor ColorMoves** (done 2026-11-17). ColorMoves exports `{ colormaps: [{ name, space, points: [{ x, o, r, g, b }], sections, ... }] }` (ParaView's colormap model): points at arbitrary `x` in 0..1, colours 0..1, interpolation space (`"Lab"` in both samples), opacity sometimes a string, hard steps as two points 1e-5 apart (the "Interlinked" sample: a brown ramp with five solid bands), `sections` as editor metadata only. Plan:
   1. One `Colormap` model (`id`, `name`, `space`, positioned points) and one baked lookup table (`bakeLut`, 1024 entries, Lab or RGB blending) that the globe shader, the colour bar (a canvas, since CSS gradients cannot show Lab blending or hard steps exactly) and the PNG export all sample. Built-in viridis and magma move to the same file format, replacing `src/assets/colormaps.json`.
   2. A ColorMoves parser (`src/data/colormoves.ts`): all maps in a file, numeric coercion, sort and clamp `x`, at least two points, readable errors; unknown `space` falls back to RGB with a warning. Built-ins are the ColorMoves files in `src/assets/colormaps/` (only viridis and magma: decided 2026-11-17 that custom maps, including the team's two samples, arrive by upload).
   3. Import from the settings menu (file picker, drag and drop), stored in localStorage, removable; the first imported map is selected and a notice reports names, warnings or the error.
   Checked (the team's "Divergent 1" and "Interlinked" samples, now in `hydroviewer_data/colormaps/` (`colormap1.json`, `colormap.json`), uploaded through the menu populate the drop-down and draw on the globe): Lab round trips, L*=50 grey = sRGB 119, viridis unchanged from the old evenly spaced RGB blending (within 1/255), the Interlinked step at x = 0.08 within one table entry, Divergent 1's white midpoint, bad files rejected with messages; in the browser, import by menu and drop, persistence over a reload, removal, a bad file, the PNG.
   Later: export back to ColorMoves JSON, sharing through the URL, reversing, colour-range controls, labelling bands in the legend.
7. **Uncertainty, spread and agreement** (2026-11-17: elevation and stippling built on mock data; decided that both exist and the user configures which statistic each reads, or off; which statistic comes first and the reference period for "change" are open). Precipitation stays the colour; a second statistic per cell needs its own visual channel. Candidates:
   - **Elevation (relief)**: built, then replaced by columns (2026-11-18); it had a height slider (0–20% of the radius, default 8%) and an integer multiplier (×1–×10, − / + buttons, 2026-11-17) for low-valued statistics such as the multi-model spread; the closest zoom rises with the peaks. Good for a smooth field and for seeing structure while rotating; weak face-on (read mostly from shading and the outline), weak on dark colormap ends, and it displaces the colour surface (grabbing and pointer reading become approximate on high relief). Agreement is shown as height above the sphere: flat = 50% (no consensus), top = 100%.
   - **Columns through the stipple dots** (decided and built 2026-11-18, replacing the relief): a radial column through each dot, as wide as the dot (so the dot-size slider sets the diameter), as high as the stippled statistic's value from zero (`value / top of display_range`, clamped, × the height slider and multiplier, which moved over from elevation). Coloured with the field at the dot, shaded on its sides; the surface stays an undisplaced sphere, so grabbing is exact again. One instanced draw of every dot centre, the vertex shader collapsing those below the threshold: no extra data, 1.1k–41k instances (6.6k at the default 2.5°) of ~24 triangles. No separate on/off switch: height 0 leaves dots only. The elevation picker and the legend's ⇅ swap are gone.
   - **Stippling** where a statistic is at or above its threshold: built, the IPCC convention, readable face-on. Fragment shader only: dots fixed to the surface (rows 1–6° apart from a dot-size slider, default 2.5°, radius a fifth of the spacing so the stippled area stays the same; fewer per row toward the poles, so even on the sphere and turning with the globe), each whole (threshold and ink decided at the dot's centre). Not in the PNG export yet. Hatching (lines) is the usual alternative for "low agreement".
   - **Value-suppressing colour** (desaturate or fade the colour where uncertainty is high): one channel, no geometry; needs a 2D lookup (value x uncertainty) and a legend that explains it.
   - **Contours of the second field** (e.g. the 66% and 90% agreement lines), as in the removed contour boxplot shaders.
   - **Toggle or swap**: a picker for what the overlay shows: agreement, inter-model spread (standard deviation), signal-to-noise; off for reading colour exactly. Built: the gear menu's pickers, a ⇅ button in the legend that swaps elevation and stippling (2026-11-17: agreement is stepped as elevation with few models, which is accepted; what matters is switching at runtime), and a stipple threshold slider bounded by `actual_range`; with the relief gone (2026-11-18) only the stippling picker remains.
   **Output contract** (the simplest input these need; processing of the real high-resolution multi-model ensembles must produce it): per statistic, one float32 grid per time step on the same 1° grid and time axis as the field it accompanies, no NaN, CF `units` and `long_name`, a `display_range` (columns reach full height at its top), a `stipple_threshold` (cells at or above it are stippled, by default) and an `actual_range` (min and max over all time steps: the limits of the threshold slider, so the browser never scans every year). Stored next to the field, e.g. `pr_agreement` (fraction of models agreeing on the sign of change, 0.5–1), `pr_spread` (inter-model standard deviation of the change), `pr_snr`. In the app this is `Statistic` (`src/data/cmip6.ts`). Mock: `statistics()` in `prep/make_mock.py` (agreement and spread), stored as `<metric>_agreement` and `<metric>_spread`.

Next:

8. **Real data** in place of the mock. Done 2026-11-17: the app reads the bucket via zarrita from `catalog.json` (the mock). Left: prep for CMIP6 writing the mock's layout (annual metrics, statistics, global means, `catalog.json`), the series layout, regridding to 1°, and the R2 upload list from the emulator log.
8b. **Data tree** (draft plan 2026-11-17, `docs/llm/DATA_TREE_PLAN.md`): a top pane showing scenarios, models and ensemble members as a branching diagram (after Lantern's catalogue picker), whose selection picks precomputed member, ensemble and multi-model datasets; multi-model large ensembles (up to ~70 members, ~50 models). Decided: variables stay in the left pane (D7); D1–D6 open.
9. **Student options** (from the team's notes): colour ranges, line widths, background colour, image and configuration export.

## 9. Open questions

- Bucket provider details and CDN, and who owns CORS and access configuration.
- Colour range per year (fixed across the timeline, as now) or per field.
- Resolved for now: one store per variable per version, at the mirrored CMIP6 key path. Ensembles, scenarios and models are separate stores identified by the key path; multi-member views would need catalog support.

## 10. Out of scope for now

Authentication, a compute or rendering backend, multiscale pyramids.
