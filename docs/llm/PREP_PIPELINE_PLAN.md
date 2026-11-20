# Prep pipeline: cmip6-pds daily `pr` to the Hydroviewer bucket (outline 2026-11-19; built, branch `prep-pipeline`)

A one-time build of the real-data bucket, in its own container, so the same bucket can be rebuilt anywhere (a new
machine, a VM next to the source, after a loss) from a committed manifest and a pinned image. Inputs and sizes:
`DATA_VOLUME.md` §4b. Output layout: the mock's (`DATA_TREE_PLAN.md` §7, `prep/make_mock.py`), so the app reads it
unchanged.

**As built** (2026-11-19): `prep/pipeline/` (README there for running it), decisions §7 taken as recommended. Differences
from the outline below: source chunks are downloaded by our own retrying downloader (`source.py`, aiohttp) into a
local partial copy that xarray opens, instead of fsspec's `simplecache`; stages 2 and 3 are one `publish` stage
(ensembles are computed while the member stores are written, as in the mock); the bucket writer moved into
`prep/bucket.py`, shared with `make_mock.py`; the historical window checked is 1950–2014 (not 1850–2014).

**Test runs** (2026-11-19, sandbox, ~20 MB/s through the proxy): `select` for all 10 models (1,023 stores checked,
84 members and 261 scenario runs); `all --models CanESM5 --max-members 2` end to end (10 member tasks, 9 GB read,
16 stores, verify 0 problems, opened in the app with no errors; values plausible: global mean pr 2.85 mm/day in
1961–1990, 3.21 in 2081–2100 under SSP5-8.5); EC-Earth3 historical r11 alone (256 × 512, the one-day shift: 9.9 GB,
346 s download + 169 s compute, peak 2.2 GB); two publishes of the same work byte-identical (SHA256SUMS). Found and
fixed on the way: a run's newest version can be an extension (latest *covering* version now); members mixed
CanESM5's p1 and p2 physics (ordered by variant first now); the 1961–1990 base years in a memory map counted as
worker memory (6.4 GB; plain file writes, 2.2 GB); stores opened with Dask arrays inside Dask tasks let one worker
run all its queued ensembles at once (opened with `chunks=None` now); gzip's timestamp made rebuilds differ
(zeroed in `bucket.py`). **Benchmark** (2026-11-19, 24 cores, 15 GB, 1 Gbit through the proxy): one member per
model, historical and SSP5-8.5, 20 tasks, 88 GB in 34 min; scaled to `runs.json`, 1.53 TB and 5.7 core-hours of
compute, worker peak 2.2 GB (EC-Earth), so the network sets the pace (here 9 MB/s per connection, 94 MB/s with 256;
table in the README). **Apptainer** (the deployment machine has only that): SIF built unprivileged from the
exported image (`docker-archive://`), run with `--cleanenv` from another directory, the image read-only: tests and
`all` on one CanESM5 member pass. For it the entrypoint is absolute, `PYTHONNOUSERSITE` set, `/work` and `/data`
exist in the image, the base image pinned (`python:3.13.18-slim`), `--workers` defaults to the allowed cores.
**Full run** (2026-11-19/20, here, 6 workers x 48 connections): 6.0 h, no failures; 1.45 TB new (the benchmark's 20 runs reused) at 70 MB/s on average, publish 10 min; `WORK/runs` 53 GB, the bucket 52.5 GB (305 stores, verify 0 problems), in `hydroviewer_data/cmip6-full`. Not yet seen in a run: a 10 Gbit link. Display ranges are still the mock's
table (`bucket.METRICS`): real CWD (global mean ~17 days) and the spreads exceed them; tune them from the full set.

Decided: the §4b set with **KACE-1-0-G in place of MRI-ESM2-0**, complete runs only, at most
10 members, every kept member with maps, **bit-rounded to 7 mantissa bits** + gzip. That is 261 SSP runs and 84
historical runs (`runs.json`), ~1.5 TB streamed, **~58 GB written** (measured: 52.5 GB) (the ~125 GB figure is the same layout unrounded).

## 1. Shape

```
cmip6-pds (Zarr v2, blosc, daily)            streamed over HTTPS, never stored whole
   │  stage 0  select     catalogue + listings + time coordinates  →  prep/pipeline/runs.json (committed)
   │  stage 1  members    per member: daily → 11 annual metrics, native grid → 1° conservative
   ▼                      →  $WORK_DIR/<model>/<member>/{historical,ssp…}.zarr   (float32, full precision)
$WORK_DIR (53 GB measured)
   │  stage 2  ensembles  per model × scenario: mean, agreement, spread; per scenario: multi-model
   │  stage 3  publish    bit-round, one year per chunk, gzip 5, bucket layout, members.zarr, catalog.json
   ▼
$DATA_DIR (52.5 GB measured)  →  stage 4 verify  →  upload to R2
```

Each stage reads only the previous stage's output, writes into a temporary name and renames when complete, and
skips work whose output exists, so an interrupted run resumes and a change to stages 2–3 (rounding, layout,
statistics) reruns in minutes without touching the network. Keeping `$WORK_DIR` (full precision) is the cheap
insurance; the 1.5 TB download is the expensive part.

## 2. Container

New directory `prep/pipeline/`, Compose service `pipeline` in the `prep` profile (same proxy args, user and
`$DATA_DIR` mount as `prep`; adds `$WORK_DIR` mounted at `/work`).

```
prep/pipeline/
  Dockerfile          python:3.13.18-slim (tag pinned), pip only (apt is blocked here), no conda
  requirements.txt    exact pins
  runs.json           the resolved manifest (stage 0's output, committed: the reproducibility anchor)
  run.py              CLI: run.py select | members | ensembles | publish | verify | all  [--workers N] [--only MODEL]
  select.py           stage 0
  indices.py          the 11 metrics, one year of daily values → one field each
  regrid.py           separable first-order conservative remap, rectilinear grid → 1°
  members.py          stage 1
  ensembles.py        stage 2
  publish.py          stage 3 (shares the writer with make_mock.py, see §6)
  verify.py           stage 4
  tests/              unittest: regrid conserves area-weighted totals; indices on hand-made series
```

Python packages (the existing `prep` image's pins where shared: numpy 2.5.4, xarray 2026.9.0, zarr 3.4.1,
numcodecs 0.17.0, fsspec 2026.9.0, aiohttp 3.14.5), plus:
- `dask[distributed]`: lazy reads of the source, the LocalCluster that runs members in parallel with memory limits
  and spill to disk.
- `cftime`: decoding noleap, 360_day and julian time axes (xarray needs it for non-standard calendars).
- `pandas` (comes with xarray): reading the 84 MB catalogue CSV in stage 0.

Not included, on purpose: xESMF/ESMF (conda only; the source grids are all rectilinear, so conservative weights
are two small dense matrices, see §4), s3fs/botocore (the bucket answers plain HTTPS and every store has
consolidated `.zmetadata`, so fsspec's HTTP filesystem is enough), xclim (see §7).

Run here: `docker compose --profile prep build pipeline`, then
`docker compose --profile prep run --rm pipeline all --workers 8`. Elsewhere (a VM in us-west-2, next to the
source): the same `docker build prep/pipeline` and `docker run -v <out>:/data -v <work>:/work … all`; nothing in
the image depends on this repo's other services. Optionally publish the image to GHCR so a relocation does not
even need a build.

## 3. Stage 0: select (`runs.json`)

Turns the §4b rules into a fixed list, so a later rebuild reads the same stores even if the mirror changes:

1. Catalogue rows: `table_id = day`, `variable_id = pr`, experiments `historical` + four SSPs, the 10 models.
2. Latest `version` per (model, experiment, member, grid).
3. For each store, read `.zmetadata` and the first and last chunks of `time`: keep a run only if its historical
   covers 1850–2014 and its SSP 2015–2100 (the mirror has runs that start in 1970 or stop in 1999, 2039, …).
4. Per model × scenario, the 10 lowest member ids (natural order) whose historical is also kept.
5. Write per run: model, institution, scenario, member, both store URLs with versions, `.zmetadata` ETags, grid
   shape, calendar, units, `parent_variant_label`. Commit it.

Later stages read only `runs.json`. `select` is rerun only on purpose (new models, a newer mirror), and the
manifest's diff shows what changed.

## 4. Stage 1: members (per member, historical once)

Unit of work: one (model, member). Its historical is shared by the scenarios it appears in, so it is read once
and its 1950–2014 metrics are written once (DATA_VOLUME §4: ~30% of member bytes saved in work, and stage 3 can
copy them into each scenario's store or keep them shared, whichever the layout decision says).

1. Open the historical store lazily: `xr.open_zarr("simplecache::https://cmip6-pds.s3.amazonaws.com/…",
   consolidated=True)`; fsspec's `simplecache` keeps the downloaded chunks in `/work/cache/<model>/<member>/` so the
   two passes below read the network once; the cache is deleted when the member is done (≤ ~15 GB per member for
   EC-Earth3, so 8 members in parallel need ~120 GB of scratch).
2. Units: kg m⁻² s⁻¹ × 86400 → mm/day; assert the units attribute.
3. **Base pass** (1961–1990): per cell, the 95th and 99th percentiles of wet days (≥ 1 mm) for R95p/R99p. Needs
   all 30 years per cell: rechunk from time chunks to latitude bands in Dask (spilling to disk), then a numpy
   percentile per band.
4. **Annual pass** (1950–2014): chunks aligned to calendar years in the run's own calendar (`time.dt.year` from
   cftime), and `indices.py` per year: `pr` (mean), PRCPTOT, SDII, Rx1day, Rx5day, R95p, R99p, R10mm, R20mm, CDD,
   CWD, units and definitions as the mock's `METRICS`. Spells are cut at year ends (ETCCDI annual convention).
5. **Regrid** each annual field to the 1° grid (360 × 180, cell-centred, lon −180..180, lat south to north) with
   `regrid.py`: for a rectilinear source the conservative weights separate into a latitude matrix (overlap of
   bands in sin(lat)) and a longitude matrix (overlap of intervals, wrapping at the dateline), so a field is
   `W_lat @ field @ W_lon.T`; assert the source has 1-D `lat`/`lon` and refuse otherwise. Indices first, then
   regrid, so extremes are not smoothed before they are found.
6. Then each SSP of that member (2015–2100, cut at 2100): same annual pass, with the base percentiles from step 3.
   **Seam check:** compare the 2010–2014 and 2015–2019 global means of `pr`; log a jump beyond the model's
   year-to-year spread (flags the 30 EC-Earth runs whose parent attribute names r1i1p1f1).
7. Write `/work/<model>/<member>/<experiment>.zarr`: per metric (year, lat, lon) float32, plus the run's
   1961–1990 mean per metric (for changes in stage 2) and its global mean series (cos-lat weighted).

Parallelism: a Dask LocalCluster, one task per member, `--workers` processes with a memory limit each (~4–6 GB;
EC-Earth3's 256 × 512 grid is the largest). The network is the limit (~25 h at 17 MB/s here), so 8 workers is
plenty. HTTP errors: fsspec retries, and a failed member is retried by rerunning (its output is absent).

## 5. Stages 2–4

- **ensembles**: per model × scenario, from the members' work stores: ensemble mean per metric and year;
  agreement (fraction of members on the majority's side of the change from each run's 1961–1990 mean) and spread
  (standard deviation of that change), as `make_mock.py`'s `Spread`; per scenario the multi-model store over the
  10 models' ensemble means. `actual_range` per statistic (min and max over all years), `display_range` and
  `stipple_threshold` (rules as the mock's, recomputed from real values: a percentile of the spread, not the
  mock's fixed table). Small: reads ~65 GB of work stores, writes into `/work/ensembles/`.
- **publish**: the bucket under the CMIP6 key path, exactly the mock's layout: per member `annual.zarr`, per model
  × scenario `ensemble/annual.zarr`, per scenario `multimodel/<ssp>/annual.zarr`, `members.zarr`, `catalog.json`
  (`"mock": false`, plus `source: runs.json`'s hash and the pipeline's git commit). Encoding: Zarr v3, `bytes` +
  `gzip` level 5, one year per chunk; values bit-rounded to 7 mantissa bits **before** writing (numcodecs
  `BitRound(7)` applied to the array, not as a codec, so the stores keep only the codecs zarrita reads). Agreement
  and other few-valued arrays are not rounded. CF attributes on every array (`units`, `long_name`, `display_range`,
  `actual_range`, `cell_methods`, `calendar_note`).
- **verify**: every store opens with zarr; shapes, years 1950–2100, no NaN; `catalog.json` paths exist; per
  metric the global means sit within a sane range; one rounded vs unrounded field differs by ≤ 0.4%; then the app
  itself against it (`DATA_DIR=… docker compose up -d data` and the browser tool) before uploading. Writes
  `SHA256SUMS` of every object, so a rebuild elsewhere can be compared and an upload checked.

## 6. Changes outside the new directory

- `docker-compose.yml`: the `pipeline` service (`$WORK_DIR`, default `./work`, set in `.env` to
  `/home/oxygen/Downloads/hydroviewer_data/work`).
- Share the bucket writer (`write()`, `attrs()`, `global_mean()`, the catalog builder) between `make_mock.py` and
  `publish.py` in one module (`prep/bucket.py`), so mock and real data cannot drift apart; the mock then only
  differs in where its values come from.
- `DATA_TREE_PLAN.md` §7 / the data contract: per-metric `cell_methods`, the calendar note, `actual_range` on fields.
- `prep/prep_cmip6.py` and its image (the GFDL-CM4 monthly slice) become obsolete once this works; remove them then.

## 7. Choices to confirm

1. **Index code: our own (~100 lines, the ETCCDI definitions, tested on hand-made series) or xclim** (the
   reference implementation, calendar-aware, but a large dependency tree: pint, numba, …). Recommendation: our
   own, checked once against xclim outside the image.
2. **Regridding: separable conservative in numpy** (exact for rectilinear grids, no ESMF) vs xESMF via a conda
   base image (handles any grid; none of the 10 models needs it). Recommendation: numpy.
3. **Keep `$WORK_DIR`** (~65 GB, full precision) after publishing. Recommendation: yes, at least until the
   encoding and layout are final.
4. **Where to run**: here (~25 h, streamed through the sandbox proxy) or a VM in us-west-2 (hours, free egress
   from the bucket; the image is the same).
5. **Historical in the published stores:** copied into each scenario's member store (as the mock, the app
   unchanged) or stored once per member (−30% of member bytes, the app joins two stores per timeline).

## 8. Build order

1. Container, `select`, commit `runs.json`; review the manifest (counts should match DATA_VOLUME §4b).
2. `indices.py` + `regrid.py` with their tests.
3. `members` on one small model (CanESM5, 64 × 128, ~0.05 TB), then `ensembles` + `publish` on it alone and open it
   in the app (a catalog with one model).
4. All 10 models; `verify`; upload.
