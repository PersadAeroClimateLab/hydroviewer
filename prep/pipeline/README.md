# Hydroviewer prep pipeline

Builds the app's bucket from the public `cmip6-pds` bucket (AWS open data, no credentials): daily precipitation of
10 CMIP6 models, four SSP scenarios and up to 10 members each, reduced to annual mean precipitation and ten ETCCDI
indices on a 1° grid, with ensemble and multi-model statistics, bit-rounded, as Zarr v3 stores and a
`catalog.json` in the layout the app reads. Design and sizes: `docs/llm/PREP_PIPELINE_PLAN.md`,
`docs/llm/DATA_VOLUME.md` §4b.

One-time and reproducible: `runs.json` (committed) lists the exact source stores and versions, the image pins the
code and every library. Rebuilding elsewhere gives the same bucket; `SHA256SUMS` in the output compares two builds.

## Stages

| Stage | Reads | Writes | Cost (full set) |
|---|---|---|---|
| `select` | the catalogue, store metadata | `runs.json` | minutes; only to change the selection |
| `members` | ~1.5 TB of daily `pr`, streamed | `WORK/runs/<model>/<member>/*.zarr` (53 GB) | network-bound |
| `publish` | the work stores | `DATA/` bucket (52.5 GB) | ~10 min on 3 workers |
| `verify` | `DATA/` | `DATA/SHA256SUMS` | minutes |

`all` runs `members`, `publish` and `verify`. Each stage skips finished work, so after an interruption run the same
command again. A failed task is logged in `WORK/log.jsonl` and stops the run after its stage; rerun to retry it.

## On a large machine, with Apptainer

The SIF is built from the Docker image, so both run the same files. On a machine with Docker:

```bash
docker build -f prep/pipeline/Dockerfile -t hydroviewer-pipeline prep
docker save hydroviewer-pipeline -o hydroviewer-pipeline.tar          # ~115 MB; copy it to the machine
```

On the machine (unprivileged; tested with Apptainer 1.5.5):

```bash
apptainer build hydroviewer-pipeline.sif docker-archive://hydroviewer-pipeline.tar
apptainer exec --cleanenv hydroviewer-pipeline.sif python -m unittest discover -s /prep/pipeline/tests
apptainer exec --cleanenv hydroviewer-pipeline.sif python /prep/pipeline/bench_network.py   # ~4 min, see below
mkdir -p /fast/work /fast/bucket
apptainer run --cleanenv --bind /fast/work:/work,/fast/bucket:/data hydroviewer-pipeline.sif \
  all --workers 64 --memory 3GB --connections 8 --publish-workers 32 --publish-memory 6GB 2>&1 | tee -a run.log
```

- Run it in `tmux`/`screen` or a batch job; after an interruption run the same command again (it resumes).
- `--cleanenv` keeps the host's environment out (the image sets what it needs). Behind a proxy add
  `--env HTTPS_PROXY=...`. Without FUSE on the machine (`/dev/fuse`), add `--unsquash` (the image is unpacked to a
  temporary directory first, ~500 MB).
- Apptainer shares the host's network: the Dask dashboard is on the machine's port 8787
  (`ssh -L 8787:localhost:8787 machine`), or the next free port, which the log names.
- `--workers` defaults to the cores the process may use (a batch allocation's, not the whole machine's).

### Full run here (2026-11-19/20: 24 cores, 15 GB RAM, 1 Gbit behind the sandbox's proxy)

```bash
DATA_DIR=.../cmip6-full WORK_DIR=.../work-full docker compose --profile prep run -d --name hv-pipeline pipeline \
  all --workers 6 --memory 3GB --connections 48 --publish-workers 3 --publish-memory 4GB
```

6.0 h, no failures or restarts: members 5.75 h (1.45 TB new, the benchmark's 20 runs reused, at 70 MB/s on average), publish
10 min, verify 4 min: 305 stores, 665,989 files, 52.5 GB, 0 problems. At least 9 GB of RAM stayed free; scratch peaked
near 60 GB. Two UKESM1-0-LL members jump just over 3 sd at 2014/2015 (`seams.json`; 2 of 261 is about chance).

### Sizing (benchmark 2026-11-19, same machine)

One member of each model, historical and SSP5-8.5 (20 tasks, 88 GB, 10 workers x 24 connections): 34 min, no
failures; per task (`worker_peak_mb`, `seconds`, `download_seconds` in `WORK/log.jsonl`):

| Model (grid) | Historical: GB, compute s | SSP: GB, compute s | Worker peak |
|---|---|---|---|
| CanESM5 (64 x 128) | 0.7, 16 | 1.0, 16 | 0.9 GB |
| MPI-ESM1-2-LR (96 x 192) | 1.4, 29 | 1.8, 28 | 1.4 GB |
| IPSL-CM6A-LR (143 x 144) | 1.6, 30 | 2.1, 27 | 1.5 GB |
| ACCESS-CM2, KACE-1-0-G, UKESM1-0-LL (144 x 192) | 2.3-2.4, 38-40 | 3.1, 36-39 | 1.6 GB |
| MIROC6 (128 x 256) | 2.6, 47 | 3.4, 46 | 2.0 GB |
| CESM2 (192 x 288) | 4.7, 78 | 6.1, 67 | 1.7 GB |
| EC-Earth3, EC-Earth3-Veg (256 x 512) | 9.9, 176 | 13.1, 151 | 2.2 GB |

Scaled to `runs.json` (84 historical, 261 scenario tasks): **1.53 TB to download, 5.7 core-hours of compute**
(two thirds of each in the EC-Earth models). So:

- **Network sets the pace.** Here one connection gave 9 MB/s, 64 gave 40 MB/s, 256 gave 94 MB/s (near 1 Gbit),
  and the pipeline averaged 44 MB/s (a small model's run has few chunks, so it cannot use all its connections):
  ~10 h for the full set here. At 1 GB/s the download takes ~25 min, at 300 MB/s ~1.5 h. Run `bench_network.py`
  on the machine first and choose `workers x connections` near the count where the rate stops rising.
  Per-connection rates are best near AWS us-west-2, where the bucket is.
- **Compute** is ~10-15 % of a task's time here; 5.7 core-hours is ~6 min on 64 cores, so more workers only help
  to hold more downloads open. The longest chain is an EC-Earth3 member's historical then its scenario (~2 x 10 GB
  and ~5 min compute).
- **Memory:** a member worker peaked at 2.2 GB, so `--memory 3GB`; publish ~2.5 GB, `--publish-memory 6GB`.
  `workers x memory` must fit in RAM (64 x 3 GB = 192 GB; with less RAM, fewer workers and more connections).
  Here 10 workers used at most 6.3 GB.
- **Scratch disk** (`WORK/scratch`, or `--scratch`): each running task holds its run's chunks, up to ~16 GB for an
  EC-Earth historical (9.9 GB plus the 1961-1990 base years) and 13 GB for its scenario, ~1-6 GB for the others;
  deleted when the task ends. The big grids go first, so 64 workers can hold ~0.9 TB at once early on.
- **Work and output:** `WORK/runs` 53 GB, `DATA` 52.5 GB (full run).
- **Workers:** 84 historical and 261 scenario tasks (a scenario waits for its member's historical) and 40
  ensembles to publish, so more than ~100 member workers or ~40 publish workers do not help.
- Then upload `DATA/` to the bucket the app reads (R2), e.g. `rclone sync DATA r2:<bucket> --checksum`, and
  compare with `SHA256SUMS`.

Docker works the same way: `docker run --rm -p 8787:8787 -v /fast/work:/work -v /fast/bucket:/data
hydroviewer-pipeline all ...` with the options above.

## Here (dev sandbox)

```bash
docker compose --profile prep build pipeline
docker compose --profile prep run --rm pipeline all            # $DATA_DIR and $WORK_DIR from .env
docker compose --profile prep run --rm pipeline all --models CanESM5 --max-members 2   # a test run
docker compose --profile prep run --rm --entrypoint python pipeline -m unittest discover -s pipeline/tests
```

Use a data directory other than the mock's for `publish` (it refuses to write over the mock).

## What it computes

Per member run, on the model's own grid, per calendar year of its own calendar: `pr` (mean, mm/day), PRCPTOT,
SDII, Rx1day, Rx5day, R95p, R99p (wet-day percentiles of that member's 1961–1990), R10mm, R20mm, CDD, CWD
(`indices.py`); then first-order conservative regridding to 1° (`regrid.py`, exact for the rectilinear grids all
10 models use). Then per model and scenario the ensemble mean, agreement and spread of the change from each run's
1961–1990 mean, and per scenario the same across the models' ensemble means (`prep/bucket.py`, shared with the
mock). Maps bit-rounded to 7 mantissa bits (`--keepbits`; relative error ≤ 0.4%), gzip, one year per chunk.

The publish stage logs each member's jump at 2014/2015 (`WORK/seams.json`): some EC-Earth3 scenario runs name
historical r1i1p1f1 as their parent instead of their own member.
