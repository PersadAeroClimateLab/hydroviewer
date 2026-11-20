# Data volume: cmip6-pds daily precipitation to Hydroviewer stores (measured, 2026-11-19)

How much the public `cmip6-pds` bucket holds for the viewer, what the prep would download, and how big the
Hydroviewer bucket becomes once daily precipitation is reduced to annual mean `pr` plus ten ETCCDI indices on the
1° grid and written as the mock's stores (`DATA_TREE_PLAN.md` §7). Scripts were throwaway (scratchpad); numbers are
from the bucket's own listing and from one real run processed end to end.

## 1. Access

- Public, no credentials: `index.html`, the catalogue `pangeo-cmip6.csv` (84 MB, **last modified 2021-12-15**, so it
  lists what the mirror held then) and S3 `ListObjectsV2` (exact object sizes) all answer over plain HTTPS. From this
  sandbox: ~17 MB/s (380 MB in 22 s), 1,222 store listings in 20 s at 32 in parallel (21 transient TLS errors through
  the proxy, all fine on retry).
- Still a source only (data contract): Zarr v2, blosc, time chunks of 131–1,689 days (60–400 MB each), CORS exposing
  only `ETag`, six calendars. The browser cannot use it directly.

## 2. What the viewer can draw from it

ETCCDI indices are defined on **daily** precipitation, so the source is `day/pr`, not the monthly `Amon/pr` the
data tree inventory counted (50 models, 1,288 runs). Runs kept: SSP member runs that also exist in `historical`
(needed for 1950–2014), latest version per run.

| Scenario | Models | Member runs | Largest ensembles |
|---|---|---|---|
| SSP1-2.6 | 32 | 183 | CanESM5 50, MIROC6 50, UKESM1-0-LL 13 |
| SSP2-4.5 | 34 | 265 | EC-Earth3 71, CanESM5 50, MIROC6 50 |
| SSP3-7.0 | 32 | 212 | EC-Earth3 57, CanESM5 50, UKESM1-0-LL 13 |
| SSP5-8.5 | 37 | 250 | EC-Earth3 57, CanESM5 50, MIROC6 50 |
| **All** | **41** | **910** (from 312 historical runs) | 135 model × scenario ensembles, **60 of them a single member** |

## 3. Source volume (what prep downloads)

| Experiment | Stores | Compressed | Uncompressed |
|---|---|---|---|
| historical (1850–2014) | 312 | 2,550 GB | 3,089 GB |
| SSP1-2.6 | 183 | 702 GB | 835 GB |
| SSP2-4.5 | 265 | 1,422 GB | 1,757 GB |
| SSP3-7.0 | 212 | 1,189 GB | 1,470 GB |
| SSP5-8.5 | 250 | 1,503 GB | 1,847 GB |
| **Total** | **1,222** | **7.37 TB** | **9.0 TB** |

- The 1950–2100 window the app shows needs **~5.7 TB** (whole chunks, so slightly more in practice).
- **EC-Earth3 alone is 3.35 TB (45%)**: 71 members on 256 × 512. Without it, ~4 TB. Then MIROC6 0.74 TB,
  EC-Earth3-Veg 0.54 TB, CanESM5 0.28 TB.
- Native grids run from 64 × 128 (265 stores) to 360 × 720 (3), most at 256 × 512 (304). Calendars:
  proleptic_gregorian 439, noleap 358, gregorian 324, 360_day 94, julian 5, 365_day 2.
- Download time: ~93 h at the sandbox's 17 MB/s; much less from a VM in the bucket's AWS region (not measured).
  Our data directory has 647 GB free, so the source must be **streamed** (chunk in, indices out, chunk dropped).
- Compute: one run (MPI-ESM1-2-HR, 192 × 384, ~0.94°), 4 years, all 11 metrics and the regrid: 10.6 s on one
  core. Scaled by grid size and years: **~51 core-hours** for everything (~3 h on 16 cores). Download, not compute,
  is the cost.

## 4. Output volume (the Hydroviewer bucket)

Measured on that real run: annual fields of `pr` and the ten ETCCDI indices, bilinear to 360 × 180, encoded as the
mock is (float32, gzip 5) and with 7-bit mantissa rounding (`BANDWIDTH.md` proposal). Raw: 259 kB per field-year.

| Metric | gzip | bit-round 7 + gzip |
|---|---|---|
| pr, PRCPTOT, SDII, Rx1day, Rx5day, R95p | 213–229 kB | 97–107 kB |
| R99p, R10mm, CDD, CWD | 194–215 kB | 94–101 kB |
| R20mm | 160 kB | 84 kB |
| **Mean** | **213 kB** | **99 kB** |

The mock's chunks are the same size (217–228 kB), and the size model reproduces the mock's measured 59 GiB, so
the mock is a fair stand-in. Statistics: spread compresses like a field; agreement (few distinct values) takes 11 kB
per year with 8 models in the mock, assumed up to 100 kB with 50 members.

Per store, 11 metrics × 151 years (1950–2100): a **member map store ~353 MB** (164 MB bit-rounded); an **ensemble
or multi-model store ~725–870 MB** (field + agreement + spread; 336–410 MB bit-rounded). The series store with every
run's, ensemble's and multi-model mean's global mean for all metrics: ~7 MB.

| Layout | float32 + gzip | bit-round 7 + gzip |
|---|---|---|
| Means only: 135 ensembles + 4 multi-model, plumes from the series store | 101–121 GB | 47–57 GB |
| Mock layout: maps for up to 3 members per model × scenario (272) + means | 197–217 GB | 91–102 GB |
| Every member with maps (910) + means | 422–443 GB | 196–206 GB |

Savings not counted above:
- **Historical repeated per scenario:** a member's 1950–2014 is identical in each SSP store it appears in; sharing it
  would save ~28% of member-map bytes (one historical store per member, the app joining two stores per timeline).
- **Single-member ensembles:** 60 of 135 model × scenario ensembles have one member; their ensemble store repeats
  the member and their spread and agreement are undefined. Skipping them saves ~45–55 GB (gzip).

### 4a. Variant: at most 10 members per model × scenario

Members kept: the 10 lowest member ids (natural order, r1 < r2 < r10) of each ensemble, so the same ids recur
across scenarios and share their historical runs. Only 15 of 135 ensembles are cut (EC-Earth3 ×3 at 57–71,
CanESM5 ×4 and MIROC6 ×3 at 50, UKESM1-0-LL ×3 at 13, IPSL-CM6A-LR ×2 at 11); every model and scenario stays.

| | All members | Capped at 10 |
|---|---|---|
| SSP member runs (126 / 245 / 370 / 585) | 910 (183 / 265 / 212 / 250) | **464** (100 / 120 / 121 / 123) |
| Historical runs to read | 312 | 171 |
| Source, whole stores | 7.37 TB | 3.94 TB |
| Source, 1950–2100 | ~5.7 TB | **~2.8 TB** (EC-Earth3 3.0 → 0.6 TB) |
| Download at 17 MB/s | ~93 h | ~47 h |
| Compute | ~51 core-hours | ~24 core-hours |

Output (agreement over ≤ 10 members takes at most 11 values, so it stays near the mock's 11 kB per year and
ensemble stores near the low end, ~725–740 MB):

| Layout | float32 + gzip | bit-round 7 + gzip |
|---|---|---|
| Means only (unchanged ensembles; plumes of ≤ 10 lines) | ~101–103 GB | ~47–49 GB |
| Mock layout (≤ 3 member maps, unchanged: 272) | ~197–199 GB | ~91–94 GB |
| Every kept member with maps (464) + means | **~265–267 GB** | **~123–125 GB** |

The cap halves the download and the every-member layout; the other two layouts barely move. Costs: the cut
ensembles' spread is estimated from 10 runs (about ±24% relative standard error), their agreement moves in steps
of 0.1, and their plumes lose 40–60 lines. Historical sharing would still save ~27% of member-map bytes, skipping
single-member ensembles ~43 GB.

### 4b. Chosen set: 10 models in all four scenarios, at most 10 members each (decided 2026-11-19)

26 of the 41 models have daily `pr` in all four SSPs. Ranked by members across the four (each capped at 10), the
top 9, plus **CESM2 in place of the 10th, MPI-ESM1-2-HR** (user's choice: it removes the MPI-ESM1-2-LR / -HR lineage
pair and brings in CESM), the same in every scenario. Members: the 10 lowest ids per ensemble (§4a).

| Model | Members (126 / 245 / 370 / 585) | Native grid | 1950–2100 source |
|---|---|---|---|
| CanESM5 | 10 / 10 / 10 / 10 (of 50) | 64 × 128 | 0.05 TB |
| MPI-ESM1-2-LR | 10 / 10 / 10 / 10 | 96 × 192 | 0.09 TB |
| EC-Earth3 | 7 / 10 / 10 / 10 (of 7 / 71 / 57 / 57) | 256 × 512 | 0.59 TB |
| UKESM1-0-LL | 10 / 10 / 10 / 5 (of 13) | 144 × 192 | 0.13 TB |
| MIROC6 | 10 / 10 / 3 / 10 (of 50) | 128 × 256 | 0.12 TB |
| IPSL-CM6A-LR | 6 / 10 / 10 / 6 (of 11) | 143 × 144 | 0.09 TB |
| EC-Earth3-Veg | 7 / 8 / 4 / 7 | 256 × 512 | 0.40 TB |
| MRI-ESM2-0 | 5 / 5 / 5 / 6 | 160 × 320 | 0.15 TB |
| ACCESS-CM2 | 3 / 5 / 3 / 5 | 144 × 192 | 0.06 TB |
| CESM2 | 2 / 2 / 2 / 2 (r4, r11) | 192 × 288 | 0.06 TB |

CESM2 ranks ~15th by members only because the mirror has 2 runs per scenario with daily `pr` in both historical
and the SSP (r10 has SSP runs but no daily historical; r1–r9 historical only); the CESM2 Large Ensemble is not in
this bucket. Its two-member ensembles give agreement of only 0.5 or 1 and a rough spread. Not chosen: MPI-ESM1-2-HR
(2 / 2 / 10 / 2), CESM2-WACCM (1 / 3 / 2 / 3; its SSP3-7.0 r2 stops in 2055 and its SSP1-2.6 and SSP5-8.5 r1 run to
2299), KACE-1-0-G and EC-Earth3-Veg-LR (3 per scenario). No ensemble in the set has a single member.

| | All | Cap 10 members (§4a) | Chosen set |
|---|---|---|---|
| SSP member runs | 910 | 464 | **288** (70 / 80 / 67 / 71) |
| Historical runs | 312 | 171 | 88 |
| Source, 1950–2100 | ~5.7 TB | ~2.8 TB | **~1.7 TB** (whole stores 2.3 TB) |
| Download at 17 MB/s | ~93 h | ~47 h | ~28 h |
| Compute | ~51 core-hours | ~24 | ~15 |

| Layout (40 ensembles + 4 multi-model) | float32 + gzip | bit-round 7 + gzip |
|---|---|---|
| Means only | ~32–33 GB | ~15 GB |
| Mock layout (≤ 3 member maps: 116) | ~73–74 GB | ~34 GB |
| Every kept member with maps (288) | **~134–135 GB** | **~62–63 GB** |

Caveats: the multi-model mean, agreement and plume are over 10 models instead of 32–37; EC-Earth3 and
EC-Earth3-Veg share a lineage and are 58% of the download. Historical sharing would save ~30% of member-map bytes.

**Coverage check (2026-11-19): the counts above are too high.** Every kept SSP run has a historical run of the same
member id (1850–2014: the 1950–2014 years of the timeline and the 1961–1990 base for changes, agreement, spread
and R95p/R99p), but some stores in the mirror do not cover their years (time values read from the stores):
- EC-Earth3 r101–r150 historical start in 1970 (all 50), so they lack 1950–1969 and two thirds of the base
  period; EC-Earth3 SSP3-7.0 and SSP5-8.5 keep 7 members (r1–r15), not 10.
- MRI-ESM2-0 r2–r5 historical end on 1999-12-31; MRI keeps only r1 (and r1i2p1f1 in SSP5-8.5): 1 / 1 / 1 / 2.
- SSP runs that stop early: MIROC6 SSP2-4.5 r4–r50 (2015–2039; MIROC6 keeps 3 there), UKESM1-0-LL SSP2-4.5 r10 and
  r12 (32 years), ACCESS-CM2 SSP1-2.6 and SSP5-8.5 r1 (50 years); elsewhere CESM2-WACCM, CNRM, NorESM2-LM,
  MPI-ESM-1-2-HAM and BCC-ESM1 SSP3-7.0 extra members (~41 years), HadGEM3-GC31-LL SSP2-4.5 r2–r4 (6 years).
- 30 EC-Earth3 and EC-Earth3-Veg SSP runs name `historical` r1i1p1f1 as their parent (`parent_variant_label`), not
  the same member id. Either the attribute is wrong or they branched from r1; prep should compare the 2014/2015
  seam before joining a member's historical and SSP years.

Complete runs only (member kept when its historical covers 1850–2014 and its SSP 2015–2100), 10 lowest ids:

| Model | Members (126 / 245 / 370 / 585) |
|---|---|
| CanESM5, MPI-ESM1-2-LR | 10 / 10 / 10 / 10 |
| EC-Earth3 | 7 / 10 / 7 / 7 |
| UKESM1-0-LL | 10 / 10 / 10 / 5 |
| MIROC6 | 10 / 3 / 3 / 10 |
| IPSL-CM6A-LR | 6 / 10 / 10 / 6 |
| EC-Earth3-Veg | 7 / 8 / 4 / 7 |
| ACCESS-CM2 | 2 / 5 / 3 / 4 |
| CESM2 | 2 / 2 / 2 / 2 |
| MRI-ESM2-0 | 1 / 1 / 1 / 2 (three single-member ensembles) |
| *or* KACE-1-0-G | 3 / 3 / 3 / 3 |

| | With MRI-ESM2-0 | KACE-1-0-G instead |
|---|---|---|
| SSP member runs | 257 (65 / 69 / 60 / 63) | 264 (67 / 71 / 62 / 64) |
| Historical runs | 83 | 84 |
| Source, 1950–2100 | ~1.5 TB (~25 h, ~13 core-hours) | ~1.5 TB (~25 h, ~13 core-hours) |
| Means only | ~32–33 GB (~15 GB) | ~32–33 GB (~15 GB) |
| Mock layout | 108 maps: ~70–71 GB (~33 GB) | 115 maps: ~73 GB (~34 GB) |
| Every kept member with maps | ~123–124 GB (~57 GB) | ~125–126 GB (~58 GB) |

(Bit-rounded in brackets.) EC-Earth3-Veg-LR or MPI-ESM1-2-HR in MRI's place give about the same; every
candidate shares a lineage with a model already in the set (KACE-1-0-G the UK Met Office atmosphere with
UKESM1-0-LL and ACCESS-CM2).

## 5. Data contract: what this review found

1. **Daily, not monthly, source.** The contract and the data tree inventory describe `Amon/pr`; ETCCDI needs
   `day/pr`, which has 41 models and 910 runs instead of 50 and 1,288. `catalog.json` should be built from the daily
   inventory (or show models with monthly data only for mean `pr`).
2. **Regridding is still unimplemented** and must handle 64 × 128 to 360 × 720 grids. For precipitation and its
   extremes, conservative remapping is the usual choice (preserves totals; bilinear smooths peaks such as Rx1day).
   Order matters: compute indices on the native grid, then regrid the annual fields (as measured here), so extremes
   are not diluted by regridding daily data first. The prep image has no scipy or xESMF.
3. **R95p and R99p** need each run's wet-day 95th and 99th percentiles over 1961–1990, i.e. 30 years of daily data
   read before the indices of any year can be written (a second pass, or keeping the base period's percentiles
   from the historical pass).
4. **Calendars**: indices are per calendar year in each model's own calendar (360_day years have 360 days, so day
   counts such as CDD are not strictly comparable); state this in the metrics' attributes. Spells (CDD, CWD) are
   cut at year ends (the ETCCDI annual convention); say so.
5. **Units**: `pr` mm/day, PRCPTOT/Rx1day/Rx5day/R95p/R99p mm, SDII mm/day, R10mm/R20mm/CDD/CWD days (as the mock).
6. **Ensemble statistics** need at least two members; the contract and catalog should say what a one-member
   ensemble shows (the member, no stippling).
7. **Encoding**: float32 + gzip as now; bit-rounding to 7 bits (~0.4%) halves every store and every download and is
   the single largest saving; still undecided (`BANDWIDTH.md`).
8. **Time coverage**: some SSP stores run past 2100 (extensions), and some stores in the mirror stop early or start
   late (§4b); prep should read the time coordinate, cut at 2100 and skip any run that does not cover 1950–2100.

## 6. Decisions for the user

- Layout: means only, the mock's (up to 3 member maps), or every member's maps.
- Encoding: float32, or bit-rounded (about half).
- Whether to share the historical years across scenarios (−28% of member maps, two stores per timeline).
- Decided 2026-11-19: the model set (§4b, 10 models in all four scenarios, at most 10 members each, CESM2 in place
  of MPI-ESM1-2-HR, KACE-1-0-G in place of MRI-ESM2-0); complete runs only; every kept member with maps,
  bit-rounded (~58 GB; the full run wrote 52.5 GB). Resolved by the pipeline into `prep/pipeline/runs.json`: **84 members, 261 scenario runs**
  (66 / 71 / 61 / 63), one variant per model (members ordered by p, f, i, then r, so CanESM5's p2 physics runs
  are not mixed in), the latest version covering the window (ACCESS-CM2 r1's newest is a 2251–2300 extension), and
  EC-Earth3 historical r11/r15 kept with a one-day time shift (stamped from 1849-12-31): EC-Earth3 6 / 10 / 6 / 6.
- Where to run prep: a VM in the bucket's region (fast, free egress there) or locally (~4 days of download).
