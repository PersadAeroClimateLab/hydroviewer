# Bandwidth: what the browser downloads (estimates, 2026-11-18)

Bandwidth to the viewer is the primary constraint: there is no server to reduce data, and R2 charges nothing for
egress, so the limit is the viewer's connection. This records what each visualization (built or buildable on the
current platform) pulls, at annual, monthly and daily frequency, and whether it runs on decent wifi. No decision
has been taken from it yet; the recommendations at the end are proposals.

Assumed connections: decent wifi 50 Mbit/s (about 6 MB/s), mobile 10 Mbit/s (about 1.2 MB/s).

## Measured

Method: a throwaway script (not kept) gzipped (level 5) 1° fields from the real GFDL-CM4 slice (monthly `pr`, 1950,
scaled from 180 × 288 to 360 × 180) and the mock, and read the mock's file sizes on disk; the bundle is
`npm run build` output. Daily precipitation was **emulated** (a monthly field, dry in 55% of cells, exponential wet
amounts), not real daily output.

Per 1° field (raw float32 259 kB), gzip:

| Field | float32 | bit-round 10 bits | bit-round 7 bits (~0.4%) | uint16 scale/offset |
|---|---|---|---|---|
| Real GFDL-CM4 monthly pr | 231 kB | 141 kB | 108 kB | 106 kB |
| Mock annual pr | 213 kB | 126 kB | 86 kB | 110 kB |
| Emulated daily pr (45% wet cells) | 133 kB | 92 kB | 75 kB | 66 kB |

Floats barely compress (about 10–15%). Bit-rounding (zeroing low mantissa bits, as xbitinfo or numcodecs BitRound)
and uint16 quantisation both stay within `bytes` + `gzip`, so the client needs no new codec.

Fixed pieces (mock, gzip or on disk):

| Piece | Size |
|---|---|
| App bundle | ~350 kB (index 184, Plot chunk 127, coastlines 35, CSS 3; zarrita's blosc/zstd/lz4 chunks are lazy and never load) |
| `catalog.json` | 28 kB |
| One store's consolidated metadata | 58 kB |
| Field chunk (one year) | 225 kB |
| Statistic chunk (one year) | 229 kB |
| Member plume per metric (887 members × 151 years) | 445 kB |
| Model plume per metric | 13 kB |
| Global-mean series | 0.6 kB |

Region time series (from the region tool's scoping, measured on the mock): a 12 × 12-cell all-years tile is about
75 kB; a summed-area-table tile (151 years × 8 × 8, float64) about 65 kB. Requests per region with 12 × 12 tiles:
Niño 3.4 12, Sahel 10, 20° × 20° 9, Amazon 16, 60° × 90° 54, globe 450. The browser's area-weighted mean takes
0.04 ms for 20° × 20° and 15 ms for the whole globe.

## Ranking, heaviest first

float32 as stored today; bit-rounding to 7 bits roughly halves every map row. Daily rows use the emulated field.

| # | Visualization | Frequency | Data pulled | 50 Mbit/s | 10 Mbit/s | Verdict |
|---|---|---|---|---|---|---|
| 1 | Scrub or animate 1950–2100 | daily | ~7.3 GB per metric (map only) | ~20 min | ~1.6 h | Not viable; short windows only |
| 2 | Scrub or animate 1950–2100 | monthly | ~1.25 GB (map + 2 statistics) | ~3.5 min | ~17 min | Not viable as a scrub |
| 3 | Member plume, global mean, full period | daily | ~200 MB per metric | ~35 s | ~3 min | No; chunk per year (~1.3 MB per year shown) |
| 4 | Region series 20° × 20°, time-series tiles | daily | ~145 MB | ~25 s | ~2 min | No; summed-area table (row 12) |
| 5 | Scrub or animate 1950–2100 | annual | ~104 MB (151 years × 3 maps) | ~17 s | ~80 s | Borderline; fine at a few years per second with prefetch |
| 6 | Animate one year | daily | ~49 MB (365 maps) | ~8 s | ~40 s | Feasible on wifi; 30 fps needs ~32 Mbit/s |
| 7 | Region series 20° × 20° to 60° × 90°, tiles | monthly | ~8–48 MB | 1.5–8 s | 7–40 s | Heavy; summed-area table |
| 8 | Member maps side by side (50, if all had maps) | annual | ~11.5 MB | ~2 s | ~9 s | OK on wifi |
| 9 | Member plume, global mean | monthly | ~5 MB per metric | ~1 s | ~4 s | OK |
| 10 | Region series 20° × 20° to 60° × 90°, tiles (region option A) | annual | ~0.7–4 MB | 0.1–0.7 s | 0.6–3 s | OK |
| 11 | Four scenarios side by side, per year step | annual | ~2.8 MB | ~0.5 s | ~2 s | OK |
| 12 | Region series, summed-area table, any size | daily | ~1.6 MB (4 corners × 55k days × 8 B) | ~0.3 s | ~1.3 s | Good; makes daily regions possible |
| 13 | First page load (bundle, catalog, metadata, 3 chunks, series, plume) | annual | ~1.2 MB | 0.2 s | 1 s | Good |
| 14 | Switch node or metric (ensemble, with plume) | annual | ≤ 1.2 MB | 0.2 s | 1 s | Good |
| 15 | Year step: map, elevation, stippling | annual, or monthly at one month per chunk | ~0.69 MB | 0.1 s | 0.5 s | Good |
| 16 | Region series, summed-area table (region option B) | annual / monthly | ~0.26 MB (8 × 8 tiles) / ~0.06 MB (per-cell chunks) | < 0.1 s | ~0.2 s | Good |
| 17 | Day step, map only | daily | ~0.13 MB | instant | 0.1 s | Good |
| 18 | Point time series, one cell, all days | daily | ~0.12–0.22 MB | instant | 0.1 s | Good, with per-cell chunks |
| 19 | Colormap, statistic swap, threshold, height, spin, hover value, data tree browsing | — | 0 | — | — | Free: local |

A typical session today (annual, a few nodes and metrics, some scrubbing) pulls about 30–50 MB.

## What follows

- **Per-click cost is fine at every frequency; "the whole time axis" is what grows** (×12 monthly, ×365 daily).
  Views that read a whole time axis need a layout chunked along it; none needs heavy browser compute.
- **Monthly maps need one month per chunk** for stepping. The contract's map layout `(12, 180, 360)` would cost
  ~8.3 MB per step with two statistics.
- **Daily:** day steps, bounded playback (a season or a year, prefetched while playing), point series and
  summed-area-table region series work. Century scrubs, daily member plumes and tile-based daily regions do not;
  reduce daily data to ETCCDI-style indices in prep instead.
- **Summed-area table** (region option B) costs the same for any box size, which matters from monthly upward. Its
  per-cell chunks mean ~65,000 objects per array unless Zarr v3 sharding packs them (read by byte ranges, which the
  bucket supports). Not verified: that zarrita reads sharded stores; the contract currently says no sharding.
- **Bit-rounding to ~0.4%** halves every map download and is invisible on a colormap; it is a decision about stored
  precision, not about code.
- **Prefetch and cache neighbouring years** to smooth scrubbing; watch request counts as well as bytes.
- **Bucket side:** daily precipitation for every dataset with maps is about 1 TB per variable to store and upload.

Before choosing a daily layout, measure real daily output (its dry-cell share and noise decide its compression).
