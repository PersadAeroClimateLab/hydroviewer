# hydroviewer

Static web app for 2D/3D visualization of climate data (CMIP6, MERRA, ERA5, observational datasets;
precipitation first). Hosted on GitHub Pages. Data lives in Zarr stores in a public bucket. There is
no compute server.

Read `docs/llm/DEV_PLAN.md` before making architectural decisions. It records the stack, the data
contract, the rationale, and the open questions. If you change a decision, update the plan in the same
change.

## Project state

Front-end shell only: a collapsible left sidebar (layout presets 1, 1×2, 2×2, 1+2; colormap) and a CSS
grid of placeholder viewports driven by shared state. Desktop first; below 720px the sidebar starts
collapsed and cells stack in one column. Each cell has a dummy header. Layout and colormap are mirrored
to the URL hash (`#layout=2x2&colormap=magma`; `src/state/hash.svelte.ts`), and unknown values are
ignored. Cell A draws a flat map of one month (GFDL-CM4 historical precipitation, 1850-01) read with
zarrita from the bucket emulator and rendered with three.js (`src/viewports/flatMap.ts`); cell B shows
the same month on a rotatable, zoomable globe (`globe.ts`, OrbitControls); the other cells are still
placeholders. Both share `fieldLayer.ts` (float texture, colormap lookup in the fragment shader, any
geometry with equirectangular UVs) and redraw only on change. No coastlines yet, so orientation relies
on the data pattern. The colour scale max (99th percentile of the month) is still computed in the client; it
belongs in prep once there is a time control. No time control, catalog.json, Observable Plot,
trame viewport or Pages workflow yet. Remaining work is in the plan (section 9).

## Stack (see the plan for detail)

- Vite + TypeScript, Svelte 5 (plain Svelte, not SvelteKit)
- three.js for 3D, Observable Plot + d3 utilities for 2D
- zarrita.js reading Zarr v3 (`bytes` + `gzip` only) over HTTP
- Docker Compose for dev (`node:22-alpine`, Vite on port 5173, bind-mounted source)
- trame as an optional iframe viewport pointing at an external server

## Commands

```bash
docker compose up -d web data                     # dev server (HMR) on :5173 and bucket emulator on :9000
docker compose logs -f web
docker compose run --rm --no-deps web npm run check   # svelte-check (type check)
docker compose run --rm --no-deps web npm run build   # production build into dist/
docker compose build web                          # after changing package.json or the Dockerfile
```

- Dependencies live in the image at `/node_modules` (the repo is bind-mounted at `/app`), so there is
  no `node_modules` on the host and no volume to clear. Rebuild the image after any dependency change.
- Edits to `src/` hot-reload. Set `VITE_USE_POLLING=true` on Docker Desktop (Mac/Windows).
- Vite only accepts the `localhost` and `web` hosts (`allowedHosts`); add others in `vite.config.ts`.
- `docker compose --profile trame up` is planned but the trame service does not exist yet.
- The sandbox does not publish ports to the host by itself; see the parent CLAUDE.md (`sbx ports`).
  Publish both 5173 and 9000: the page in your browser fetches data from `http://localhost:9000`.

## Data path

- **Source:** the public `cmip6-pds` S3 bucket (Zarr v2, blosc, chunks of ~100 MB). It is only a
  source: the app cannot use it directly. Keys are
  `CMIP6/<activity>/<institution>/<model>/<experiment>/<member>/<table>/<variable>/<grid>/<version>/`.
- **Prep** (`prep/`, Python in Docker, opt-in profile) converts a slice into our bucket format under
  the same key path, as `.../<version>/map.zarr` in `./data` (gitignored):
  `docker compose --profile prep build prep`, then
  `docker compose --profile prep run --rm prep CMIP6/CMIP/NOAA-GFDL/GFDL-CM4/historical/r1i1p1f1/Amon/pr/gr1/v20180701 --months 600`
  (about 10 s, 107 MB output). Rebuild the prep image after editing `prep/*.py` (the script is copied in).
- **Bucket emulator:** the `data` service is nginx serving `./data` with S3-style headers (any-origin
  CORS incl. preflight, byte ranges, ETag, `Content-Range` exposed, no compression, 404 for missing
  keys). Config: `tools/bucket/default.conf`. Plain S3 API features (listing, signed URLs) are not
  emulated and not needed.
- **App side:** `src/data/config.ts` picks the bucket URL (`?data=URL` > `VITE_DATA_URL` >
  `http://localhost:9000`); `src/data/cmip6.ts` opens the store with zarrita (explicit
  `zarr.open.v3`, v3 consolidated metadata) and memoizes one month per fetch.
- The browser tool container reaches the emulator with `?data=http://data:9000`, e.g.
  `browser 'http://web:5173/?data=http://data:9000' --settle 1500 --shot map.png`. This is
  cross-origin, so CORS is genuinely exercised.

## Browser tool (works now)

`tools/browser/` is headless Chromium + Playwright in Docker, for looking at the dev page and
checking it. It is a Compose service in the opt-in `tools` profile, so it reaches the dev server by
service name (e.g. `http://web:5173/` once the `web` service exists).

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
  Use it for DOM state, and for CORS/Range checks of bucket files with an in-page `fetch`, since only
  the browser enforces CORS.
- For real pointer drags or multi-step flows, write a script in `tools/browser/src/` importing
  `open()` from `lib.mjs` (example in its header) and run it with `--entrypoint node`.
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
   data files in the repo. Vite `base` must match the Pages path.
2. **trame stays decoupled.** The app must build, run and deploy with trame completely absent.
   - The trame viewport exists only when `VITE_TRAME_URL` is set.
   - It is an iframe. Do not import trame/VTK code into the main bundle, and do not add live
     two-way state sync with the iframe. Initial state goes in URL query params only.
3. **Minimize client compute.** Do reductions, regridding, aggregation and rechunking in data prep,
   not in the browser. Do colormapping and similar per-pixel work in shaders.
4. **Renderers are framework-agnostic.** Viewports are plain TypeScript modules implementing the
   mount/update/destroy contract in the plan. They must not import Svelte. The UI framework only
   hosts them.
5. **Keep typed arrays out of deep reactive state** (`$state.raw` or non-reactive storage).
6. **Low complexity.** One tool per job. Do not add a state library, router, component library or
   extra chart library without a concrete need documented in the plan.
7. **Do not plan or build layouts or features unprompted.** Current scope is stack, data contract,
   dev kit and module boundaries.

## Data contract summary

- Target: regular 1° lat/lon, cell-centered (360 × 180). Fixed for all datasets: longitude
  -180..180 (west to east), latitude south to north. Regridding is not implemented yet; the first
  slice keeps the native GFDL-CM4 grid (180 × 288).
- Per variable: a map layout (chunks `(12, nlat, nlon)`, written), a series layout
  (`(all time, ~12, ~12)`) and small precomputed aggregates (neither written yet).
- Time is stored as integers counted from the first month (`units: "months since 1850-01-01"`), so
  the client needs no calendar code. Precipitation is stored in mm/day.
- float32, no NaN in data read by shaders (use a fill value or mask), CF attributes on all arrays,
  and a root `catalog.json`.
- Bucket needs public read and CORS with `Range`. Do not depend on `Content-Encoding` for chunks.

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
   that the test itself is well written.

## Conventions

- TypeScript strict mode. Match surrounding code style, naming and comment density; keep comments
  sparse and explain why, not what.
- Pin exact dependency versions (no `latest`); prefer versions at least two weeks old.
- Python (trame app, data prep) lives in `trame/` and `prep/`, each with its own Dockerfile and
  dependency file. `prep/` exists; create `trame/` only when first needed.
- Docs written for LLM/agent context go in `docs/llm/`.

## Environment notes

- The parent `/home/oxygen/Documents/CLAUDE.md` describes the sandbox (persistent env file, network
  firewall, git auth, port publishing). It applies here. In particular, dev servers must bind to
  `0.0.0.0` and be published with `sbx ports` to be reachable from the host.
- Use `bash -l -c "..."` if a tool is not found on PATH.

## Facts still unverified

Verified: zarrita 0.7.5 reads our Zarr v3 + gzip store including v3 consolidated metadata; the app
loads it cross-origin from the emulator. Still from memory or inconclusive searches, so confirm in the
relevant spike: trame launcher status and multi-session behaviour; trame-vtklocal / VTK version
compatibility; Safari behaviour for an HTTPS page framing `http://localhost`; whether the real bucket's
CORS config will match the emulator's.
