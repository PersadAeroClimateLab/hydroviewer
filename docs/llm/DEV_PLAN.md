# hydroviewer — Development Plan

Status: planning. No application code exists yet. This document records the stack decisions from the
initial brainstorm, the constraints behind them, and the order in which to de-risk them.

Scope of this plan: **stack, data contract, dev kit, and module boundaries only.** Page layouts and
user-facing features are intentionally out of scope and will be planned separately.

## 1. Goal

A static web app for 2D and 3D visualization of climate data (CMIP6, MERRA, ERA5, and some
observational datasets; precipitation is the initial focus). Viewports render visualizations in one
of two modes:

1. **Bespoke JS rendering** (three.js, Observable Plot) running entirely in the browser.
2. **trame** (ParaView/VTK-based) for the visualization team, embedded as an optional viewport.

## 2. Hard constraints

| Constraint | Consequence |
|---|---|
| Hosted on GitHub Pages | Static files only. No server-side code, no custom response headers (so no COOP/COEP, no `SharedArrayBuffer`), no SPA fallback routing, ~1 GB site limit. |
| No compute server | Data is prepared offline and fetched from a bucket. Client-side compute is minimized; heavy lifting is done in prep or on the GPU. |
| trame must be toggleable | trame is not deeply integrated. The web app must build, run and deploy with it fully absent. |
| Docker for dev | Reproducible, portable dev server with auto-reload. |
| Low complexity | Prefer one tool per job. Avoid frameworks, routers and state libraries until they are needed. |

## 3. Stack decisions

| Layer | Choice | Status | Notes |
|---|---|---|---|
| Hosting | GitHub Pages via GitHub Actions (`upload-pages-artifact` + `deploy-pages`) | Decided | Vite `base` set to the repo path. No client-side router; view state lives in the URL hash. |
| Build / dev server | Vite + TypeScript | Decided | HMR for dev, static `dist/` for Pages. |
| Dev environment | Docker Compose, `node:22-alpine`, source bind-mounted | Decided | Vite runs with `--host 0.0.0.0`; `server.watch.usePolling` is needed on Docker Desktop (Mac/Windows). Port 5173. |
| 3D rendering (non-trame) | three.js | Decided | Fields uploaded as textures, colormapped in a fragment shader (GPU, not CPU). A 2D map can reuse the same shader on a plane with an orthographic camera. |
| 2D plots | Observable Plot + d3 utilities | Decided | Add uPlot only if a specific time-series view proves too slow. |
| UI layer | Svelte 5 + Vite (plain Svelte, not SvelteKit) | Decided (in use) | Alternative considered: Lit. See section 5. |
| Data format | Zarr v3, core codecs only (`bytes` + `gzip`) | Decided, verified in spike 1 | zarr-python writes it; v3 consolidated metadata works. |
| Browser Zarr reader | zarrita.js 0.7.5 | Decided, verified in spike 1 | Reads v2/v3 over HTTP. It bundles WASM codecs (blosc, lz4, zstd) as lazy chunks that our gzip data never loads. |
| trame integration | Option A: iframe to an external trame server | Decided | See section 7. |

## 4. Architecture

```
GitHub Pages (static)                       Bucket (public, CORS)
┌─────────────────────────────┐             ┌────────────────────────┐
│ Svelte shell                │  zarrita    │ catalog.json           │
│  ├─ shared state module     │────────────▶│ <dataset>/<var>.zarr   │
│  ├─ viewport registry       │             │   map layout           │
│  │    ├─ three.js viewport  │             │   series layout        │
│  │    ├─ Plot viewport      │             │   aggregates           │
│  │    └─ trame viewport ····│···┐         └───────────▲────────────┘
└─────────────────────────────┘   │ iframe              │ xarray/zarr
                                  ▼ (optional)          │
                        ┌──────────────────────────┐    │
                        │ trame server (external)  │────┘
                        │ Python, own HTTPS origin │
                        └──────────────────────────┘
```

### Viewport module contract

Renderers are plain TypeScript modules with no UI-framework imports. The UI framework only hosts them.

```ts
interface Viewport {
  mount(el: HTMLElement, ctx: ViewportContext): ViewportHandle;
}
interface ViewportHandle {
  update(state: SharedState): void;
  destroy(): void;
}
```

- A registry maps viewport type ids to modules. Adding a viewport type means adding one module and one registry entry.
- The trame viewport is a module like any other: it mounts an `<iframe>`. It is registered only when `VITE_TRAME_URL` is set at build time (or provided by runtime config). With it unset, no trame code path is reachable and nothing about trame appears in the UI.
- Shared state (selected dataset, variable, time, colormap and range) lives in a small module. Typed arrays must stay out of deep reactive state (use `$state.raw` or keep them outside reactivity).
- State is mirrored to the URL hash so views are shareable. The trame viewport receives initial state through URL query params only. There is no live two-way sync with the iframe (that would be deep integration).

## 5. UI layer: Svelte vs Lit

Svelte 5 is proposed. Reasons Lit was set aside:

- Weaker HMR: `customElements.define` cannot be re-run, so edits often force a full reload, against the "iterative dev with auto-reload" goal.
- No built-in cross-component state, and shared state is the core of this app.
- Shadow DOM friction with global CSS, theming and popovers.
- Thinner control ecosystem; less template type-checking; more boilerplate.

Lit's real advantage (pluggable viewports as custom elements) is achieved instead by the module contract in section 4, which keeps the UI framework swappable. Lit remains the better choice only if viewports must later be embedded in other sites or frameworks.

Svelte caveats: runes have a learning curve, and typed arrays must not go into deep `$state`.

Start with plain CSS and no component library.

## 6. Data contract

Data is prepared offline (xarray, dask, regridding tools) and written to a public bucket. The web app and trame both read the same Zarr stores. No VTK files are stored; trame converts xarray to VTK/PyVista in Python.

### Grid

- Regular lat/lon, **1°**, cell-centered: 360 × 180.
- Longitude **-180..180**, west to east; latitude south to north. Fixed for every dataset; prep wraps and asserts.
- Regridding happens in prep, never in the client. **Not implemented yet:** the first slice (GFDL-CM4, 180 × 288) keeps its native grid, and the stored lat/lon arrays describe it.
- Time is stored as integers counted from the first month (`units: "months since 1850-01-01"`), so the client needs no calendar code (the source uses a `noleap` calendar with hours since 1850).
- Precipitation is stored in mm/day (source: kg m-2 s-1).

### Source data and key layout

The public `cmip6-pds` bucket is a **source**, not something the app can read directly. Its stores are Zarr v2 with blosc/lz4 and chunks of `(600, nlat, nlon)`: for GFDL-CM4 `pr`, about 102 MB compressed per chunk, so one month would cost a 100 MB download. It also has a `1e20` fill value, a `noleap` calendar and CORS that exposes only `ETag`.

Our bucket mirrors its key path: `CMIP6/<activity>/<institution>/<model>/<experiment>/<member>/<table>/<variable>/<grid>/<version>/`, with our stores inside the version directory (`map.zarr`, later `series.zarr`) and other datasets (ERA5, MERRA, observations) under their own top-level prefix. A root `catalog.json` (not written yet) is how the app discovers stores.

### Dev bucket emulator

The `data` compose service is nginx serving `./data` with S3-style read behaviour (config in `tools/bucket/default.conf`): `Access-Control-Allow-Origin: *`, preflight, `Range`, ETag, `Content-Range` exposed, no compression, 404 for missing keys. The real bucket's CORS must expose `Content-Range` and `Content-Length` too, which the public bucket does not. A real S3 server was rejected because listing and signed URLs are unused and the common images are not available here.

`prep/` (Python in Docker, opt-in compose profile) writes into `./data`; see CLAUDE.md for commands. The page reaches the emulator at `http://localhost:9000` (override with `?data=` or `VITE_DATA_URL`).

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

- **Map layout:** chunks `(12, 180, 360)` (one year of months per chunk). Tune after spike 1.
- **Series layout:** chunks `(all time, ~12, ~12)` (~1.7 MB each), so a point time series costs a few requests instead of thousands.
- **Aggregates:** precomputed global mean, zonal mean and climatology as small separate arrays, so the client never reduces a large array.
- Duplicating data across layouts is preferred over client-side rechunking.

### Encoding

- Zarr v3, `bytes` + `gzip` (browsers decode gzip natively; no WASM dependency). No sharding. No zstd/blosc until browser support is confirmed.
- float32 on disk. If size becomes a problem, quantize to uint16 with scale/offset before considering other codecs.
- No NaN in data the shader reads (GPU NaN handling is unreliable). Use an explicit fill value or a separate mask.
- CF attributes (`units`, `long_name`) on every array so the UI labels itself.
- Consolidated metadata, if zarrita supports it for v3 (verify); otherwise keep metadata fetches to a minimum.
- A static `catalog.json` at the bucket root lists datasets and variables so the app discovers content instead of hard-coding it.

### Bucket

Public read, CORS allowing the Pages origin with `Range` allowed and `Content-Range`/`Content-Length` exposed, ideally behind a CDN. Do not rely on `Content-Encoding` compression for chunks (it conflicts with range requests); compress in the codec.

## 7. trame integration (Option A)

trame is a Python server and cannot run on GitHub Pages. The web app only knows a URL.

- **Toggle:** `VITE_TRAME_URL` unset means no trame viewport type. Public builds can leave it unset; the viz team's build sets it.
- **Local dev:** a `trame` Docker Compose profile starts a Python container. `docker compose --profile trame up` enables it; plain `docker compose up` does not.
- **HTTPS:** Pages is HTTPS, so a hosted trame server must be HTTPS too. `localhost` is generally treated as secure in Chrome and Firefox; verify Safari.
- **Framing:** the trame server must allow being framed by the Pages origin (no `X-Frame-Options: DENY`; set `frame-ancestors`).
- **Initial state:** passed via URL query params only.

### Shared instance with anonymous users

By default one trame server process shares `server.state` across all connected browsers, so a naive shared instance would show every visitor the same scene. For anonymous multi-user use:

- Run a process or container per session using Kitware's trame launcher (verify its current state and docs).
- Point the iframe at the launcher root, which creates a session and redirects, so the web app stays unaware of sessions.
- Guardrails: max concurrent sessions, idle timeout, per-session memory limit, rate limiting, and an allowlist of bucket paths the Python app may read.
- Capacity is concurrent sessions times per-session memory (plan for hundreds of MB; measure). CPU-only server-side rendering may be slow; trame-vtklocal (client-side VTK.wasm) can offload rendering, but note its threaded build needs `SharedArrayBuffer`, and its version compatibility is in flux (VTK 9.4–9.6 vs trame-vtklocal 1.x tied to VTK 10).

This is the only server in the architecture. Everything else remains static.

## 8. Planned repository layout

```
hydroviewer/
├── CLAUDE.md
├── README.md
├── docs/llm/DEV_PLAN.md
├── docker-compose.yml          # web, browser (tools profile); trame to be added
├── Dockerfile                  # node:22-alpine dev image
├── package.json, vite.config.ts, tsconfig.json
├── src/
│   ├── main.ts
│   ├── state/                  # shared state module
│   ├── viewports/              # registry + one module per viewport type
│   ├── data/                   # zarrita access, catalog loading
│   └── ui/                     # Svelte shell components
├── tools/browser/              # Playwright + Chromium in Docker, for inspecting the dev page
├── trame/                      # optional: Python trame app + its Dockerfile
├── prep/                       # optional: Python data-prep scripts (xarray, regridding)
└── .github/workflows/pages.yml
```

Directories under `trame/` and `prep/` are created only when first needed. `src/` internals may shift once the first spike lands.

## 9. Phases and spikes

Each spike answers a question that could change the plan. Do them in order.

1. **Data path spike (done except the 3D part).** The first slice works end to end with a flat map in place of the sphere: GFDL-CM4 historical `pr`, 600 months, prepped to Zarr v3 + gzip (107 MB), served by the emulator, read by zarrita, drawn in cell A. The flat map and a globe (OrbitControls) now render through three.js with a shared float-texture + shader-colormap layer (bundle ~168 kB gzip). Coastlines (Natural Earth 110m, a committed app asset built by `prep/make_coastlines.py`, ~35 kB gzip lazy chunk) are drawn on both. The globes also have relief: a synthetic uncertainty array (written by prep, read by both engines, displaced radially in a vertex shader / VTK points, headlight-shaded) stands in until a real uncertainty product exists. Still to do: a time control, series layout and aggregates, regridding, `catalog.json`. Original goal: Write one precipitation variable as Zarr v3 (`bytes` + `gzip`, map layout). Serve it from a bucket with CORS. Read it with zarrita and render it as a texture on a three.js sphere with a shader colormap. Confirms: zarrita v3 and gzip support, consolidated metadata, chunk size, fill-value handling.
2. **Dev kit (done, except the Pages workflow).** Docker Compose + Vite + Svelte + TypeScript with HMR working in the container; a GitHub Actions workflow deploying to Pages with the correct `base`.
3. **Viewport contract (partly done: contract, shared state, URL-hash sync and one placeholder viewport exist; registry does not).** Implement the registry, shared state module and URL-hash sync with two trivial viewports (three.js, Plot) to prove the contract.
4. **trame spike (done for local rendering, single user).** Cells C and D show the flat map and globe built by `trame/` (VTK scenes drawn by vtk.js in the browser) and match A and B visually; the iframe is only present when a trame URL is configured, and the app builds identically without it. Findings: the server needs no GPU/X11 (use `vtkGenericOpenGLRenderWindow`); VTK 9.7's Linux wheel imports without system GL libraries; the browser-side camera ignores parallel projection and the horizontal view angle, so the front end letterboxes the iframe; a `?ui=` layout per view and colormap carries the initial state. Still open: HTTPS and Safari/localhost framing, remote (server-side) rendering and VTK.wasm comparisons, URL-driven state beyond a fixed set of layouts, and the multi-user launcher. Original goal: minimal trame app in the `trame` Compose profile, embedded via iframe from the deployed Pages origin. Confirms HTTPS, framing and Safari/localhost behaviour, and that the app builds identically with the URL unset.
5. **Shared-instance spike** (only if needed). Launcher, session caps and measured per-session cost.

## 10. Open questions

- Bucket provider and CDN, and who owns CORS and access configuration.
- Where the shared trame instance will be hosted, and whether the public Pages build should expose it at all.
- Resolved for now: one store per variable per version, at the mirrored CMIP6 key path. Revisit if metadata fetches matter.
- Resolved for now: ensembles, scenarios and models are separate stores, identified by the key path. Multi-member views would need catalog support.

## 11. Out of scope for now

Page layouts, specific visualizations and features, authentication, a compute backend, multiscale pyramids, live state sync with the trame iframe, and any trame code in the main app bundle.
