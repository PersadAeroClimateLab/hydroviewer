"""The bucket layout the app reads (docs/llm/DATA_TREE_PLAN.md, section 7), shared by the mock (make_mock.py) and
the real-data pipeline (pipeline/), so the two cannot drift apart: the grid and years, the metrics and their
attributes, ensemble statistics, the store writer, the series store and catalog.json.

Under the CMIP6 key path:
- per model and scenario, map stores for some members: <member>/annual.zarr with each metric (year, lat, lon)
  and its global mean (year);
- per model and scenario, ensemble/annual.zarr: the mean of all members, `<metric>_agreement` and
  `<metric>_spread` across them, and the mean's global mean;
- per scenario, multimodel/<scenario>/annual.zarr: the mean of the model means, with agreement and spread across
  models;
- members.zarr: every member's global mean (member run, year) and every ensemble mean's (run, year), for plumes;
- catalog.json, which lists all of it.

Change (for agreement and spread) is measured from each run's own 1961-1990 mean.
"""

import functools
import gzip
import json
import warnings
from pathlib import Path

import numpy as np
import xarray as xr
from zarr.codecs import GzipCodec

YEARS = np.arange(1950, 2101)
LON = np.arange(-179.5, 180)
LAT = np.arange(-89.5, 90)
RAD = np.pi / 180
BASELINE = (YEARS >= 1961) & (YEARS <= 1990)
AREA = np.cos(LAT * RAD)

SCENARIOS = [("ssp126", "SSP1-2.6"), ("ssp245", "SSP2-4.5"), ("ssp370", "SSP3-7.0"), ("ssp585", "SSP5-8.5")]
# id, name (no commas: the app cuts names at the first one), group, units, display range of the field, display
# range of the spread (its stipple threshold is half). ETCCDI indices by their short names. The ranges are the real
# data's (2026-11-20, the pipeline's full bucket, area-weighted over every 5th year): the field's top is the 99th
# percentile of member values and the spread's the 99th percentile of ensemble spreads, rounded up. The 99th, not
# the maximum: a few cells per model (orographic hotspots, New Guinea in IPSL-CM6A-LR at ~100 mm/day) are far
# beyond the rest and would leave every other map in the bottom of the colour bar.
TOTALS, EXTREMES, DAYS, SPELLS = "Totals and intensity", "Extremes", "Heavy-precipitation days", "Spells"
METRICS = [
    ("pr", "Precipitation", TOTALS, "mm/day", [0, 12], 2),  # the annual mean
    ("prcptot", "Wet-day total (PRCPTOT)", TOTALS, "mm", [0, 4000], 800),
    ("sdii", "Wet-day intensity (SDII)", TOTALS, "mm/day", [0, 16], 3.5),
    ("rx1day", "Wettest day (Rx1day)", EXTREMES, "mm", [0, 160], 60),
    ("rx5day", "Wettest 5 days (Rx5day)", EXTREMES, "mm", [0, 350], 120),
    ("r95p", "Very wet days total (R95p)", EXTREMES, "mm", [0, 1200], 450),
    ("r99p", "Extremely wet days total (R99p)", EXTREMES, "mm", [0, 600], 300),
    ("r10mm", "Heavy days (R10mm)", DAYS, "days", [0, 140], 30),
    ("r20mm", "Very heavy days (R20mm)", DAYS, "days", [0, 60], 15),
    ("cdd", "Longest dry spell (CDD)", SPELLS, "days", [0, 250], 60),
    ("cwd", "Longest wet spell (CWD)", SPELLS, "days", [0, 120], 35),
]
GZIP = [GzipCodec(level=5)]
# gzip stamps the current time into every chunk's header (numcodecs' GZip, behind zarr's GzipCodec, passes none),
# so two builds of the same values would differ byte for byte. A zero stamp makes builds comparable by checksum
# (the pipeline's SHA256SUMS); readers ignore it.
gzip.GzipFile.__init__ = functools.partialmethod(gzip.GzipFile.__init__, mtime=0)


def lower(name: str) -> str:
    """A name inside a sentence: only its first letter lowered, so "Wettest day (Rx1day)" keeps its index name."""
    return name[:1].lower() + name[1:]


def global_mean(values: np.ndarray) -> np.ndarray:
    """Area-weighted (cos(lat)) mean of (year, lat, lon) per year."""
    return (np.einsum("ylx,l->y", values, AREA) / (AREA.sum() * values.shape[2])).astype("float32")


def bitround(values: np.ndarray, keepbits: int) -> np.ndarray:
    """float32 values with only `keepbits` mantissa bits (round to nearest, ties to even, as numcodecs' BitRound):
    the zeroed low bits make gzip about twice as effective, at a relative error of at most 2^-(keepbits+1).
    In place when `values` is a writable contiguous float32 array (no copy of a 39 MB map per variable)."""
    drop = 23 - keepbits
    if not (values.dtype == np.float32 and values.flags.c_contiguous and values.flags.writeable):
        values = np.array(values, dtype="float32")
    bits = values.view("uint32")
    odd = (bits >> np.uint32(drop)) & np.uint32(1)
    bits += np.uint32((1 << (drop - 1)) - 1)
    bits += odd
    bits &= np.uint32((0xFFFFFFFF << drop) & 0xFFFFFFFF)
    return values


class Spread:
    """Mean of runs, and agreement and spread of their change from the baseline, accumulated one run at a time."""

    def __init__(self):
        self.n = 0

    def add(self, values: np.ndarray):
        change = values - values[BASELINE].mean(axis=0)
        if not self.n:  # in place from here on: allocating per run cost a third of the time
            # float32 (11 metrics of float64 sums would need ~3 GB per worker), so the variance is Welford's running
            # one: a sum of squares minus the squared mean lost 0.2% of the spread to cancellation in float32.
            self.total, self.mean, self.m2 = (np.zeros(values.shape, "float32") for _ in range(3))
            self.rising = np.zeros(values.shape, "int16")
        self.n += 1
        self.total += values
        delta = change - self.mean
        self.mean += delta / self.n
        self.m2 += delta * (change - self.mean)
        self.rising += change > 0

    def result(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Mean, agreement (fraction of runs on the side of the majority's sign of change, 0.5-1) and spread
        (standard deviation of the change)."""
        n = self.n
        agreement = np.maximum(self.rising, n - self.rising) / n
        spread = np.sqrt(np.maximum(0, self.m2 / n))
        return (self.total / n).astype("float32"), agreement.astype("float32"), spread.astype("float32")


def attrs(metric: tuple, kind: str = "") -> dict:
    """CF attributes of a metric's field, or of its statistic `kind` ('agreement' or 'spread') across members or
    models."""
    id, name, group, units, display_range, spread = metric
    if kind == "agreement":
        return {"units": "fraction of runs", "long_name": "Agreement on the sign of change", "display_range": [0.5, 1], "stipple_threshold": 0.8}
    if kind == "spread":
        return {"units": units, "long_name": "Spread of change", "display_range": [0, spread], "stipple_threshold": spread / 2}
    return {"units": units, "long_name": name, "display_range": display_range}


def write(path: Path, variables: dict, about: dict, keepbits: int | None = None, **node):
    """One node's store: Zarr v3, gzip, consolidated, one year per chunk. With `keepbits`, maps are bit-rounded
    in place before writing (not as a codec: the app's reader knows only bytes and gzip); agreement, a few
    distinct fractions, and the small global-mean series are kept whole."""
    if keepbits is not None:
        variables = {
            n: (v[0], bitround(v[1], keepbits), v[2]) if len(v[0]) == 3 and not n.endswith("_agreement") else v
            for n, v in variables.items()
        }
    ds = xr.Dataset(
        variables,
        coords={
            "year": ("year", YEARS.astype("int32"), {"long_name": "year"}),
            "lat": ("lat", LAT.astype("float32"), {"units": "degrees_north", "long_name": "latitude"}),
            "lon": ("lon", LON.astype("float32"), {"units": "degrees_east", "long_name": "longitude"}),
        },
        attrs=about | node,
    )
    encoding = {n: {"compressors": GZIP} | ({"chunks": (1, len(LAT), len(LON))} if ds[n].ndim == 3 else {}) for n in ds.variables}
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message="Consolidated metadata")
        ds.to_zarr(path, mode="w", zarr_format=3, consolidated=True, encoding=encoding)


def member_variables(values: dict[str, np.ndarray]) -> tuple[dict, dict]:
    """A member's map store variables and its global mean per metric."""
    variables, series = {}, {}
    for metric in METRICS:
        id = metric[0]
        series[id] = global_mean(values[id])
        variables[id] = (("year", "lat", "lon"), values[id], attrs(metric))
        variables[f"{id}_global_mean"] = (("year",), series[id], {"units": metric[3], "long_name": f"Global mean {lower(metric[1])}"})
    return variables, series


def statistics(spreads: dict, by: str) -> dict:
    """Variables of an aggregate node: per metric its mean, agreement, spread and the mean's global mean. Empties
    `spreads` as it goes (each accumulator is 3.5 maps of all years; freeing them halves the peak memory)."""
    out = {}
    for metric in METRICS:
        mean, agreement, spread = spreads.pop(metric[0]).result()
        dims = ("year", "lat", "lon")
        out[metric[0]] = (dims, mean, attrs(metric) | {"long_name": f"{metric[1]}, mean of {by}"})
        # actual_range (min, max over all years) bounds the app's threshold slider without reading every year.
        extent = lambda a: {"actual_range": [float(a.min()), float(a.max())]}  # noqa: E731
        out[f"{metric[0]}_agreement"] = (dims, agreement, attrs(metric, "agreement") | {"long_name": f"Agreement of {by}"} | extent(agreement))
        out[f"{metric[0]}_spread"] = (dims, spread, attrs(metric, "spread") | {"long_name": f"Spread of {by}"} | extent(spread))
        out[f"{metric[0]}_global_mean"] = (("year",), global_mean(mean), {"units": metric[3], "long_name": f"Global mean {lower(metric[1])}, mean of {by}"})
    return out


def multimodel(out: Path, scenario: str, stores: list[str], path: str, about: dict, keepbits: int | None = None):
    """One scenario: the mean of the model ensemble means, with agreement and spread across models."""
    spreads = {m[0]: Spread() for m in METRICS}
    for store in stores:
        # chunks=None: plain arrays. Dask arrays computed inside a Dask task hand their work back to the cluster,
        # and the worker starts its next task meanwhile (all of them at once, each holding GBs).
        ds = xr.open_zarr(out / store, consolidated=True, chunks=None)
        for metric in METRICS:
            spreads[metric[0]].add(ds[metric[0]].values)
    write(out / path, statistics(spreads, f"{len(stores)} models"), about, keepbits, scenario=scenario)


def finish(out: Path, runs: list[dict], series: list[dict], multi: dict, catalog: dict):
    """members.zarr (plumes: every member's global mean, rows in catalog order, a run's members starting at its
    `series` row, and every ensemble mean's, one row per run) and catalog.json. Returns the number of members."""
    row = 0
    for run in runs:
        run["series"] = row
        row += len(run["members"])
    plumes = {}
    for metric in METRICS:
        id, units, name = metric[0], metric[3], lower(metric[1])
        plumes[f"{id}_global_mean"] = (("member_run", "year"), np.concatenate([s[id] for s in series]), {"units": units, "long_name": f"Global mean {name}"})
        plumes[f"{id}_ensemble_global_mean"] = (("run", "year"), np.stack([s[id].mean(axis=0) for s in series]), {"units": units, "long_name": f"Global mean {name}, ensemble mean"})
    ds = xr.Dataset(plumes, coords={"year": ("year", YEARS.astype("int32"), {"long_name": "year"})})
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message="Consolidated metadata")
        ds.to_zarr(out / "members.zarr", mode="w", zarr_format=3, consolidated=True, encoding={n: {"compressors": GZIP} for n in ds.variables})

    catalog = catalog | {
        "facets": ["scenario", "model", "member"],
        "scenarios": [{"id": id, "label": label} for id, label in SCENARIOS if id in multi],
        "metrics": [{"id": m[0], "group": m[2], "statistics": ["agreement", "spread"]} for m in METRICS],
        "series": "members.zarr",
        "multimodel": multi,
        "runs": runs,
    }
    (out / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=1) + "\n")
    return row
