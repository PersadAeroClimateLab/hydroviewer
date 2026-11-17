"""Write a mock multi-model, multi-scenario ensemble into a bucket root, in the layout the app reads
(docs/llm/DATA_TREE_PLAN.md, section 7):

    make_mock.py [--out /data] [--models 8] [--map-members 3] [--workers 4]

Models and their members are real names (mock_ensembles.json, largest ensembles first); the values are analytic
formulas on the target 1° grid (360 x 180, cell-centred, south to north, west to east), annual, 1950-2100. Not real
data. Each model has its own bias and climate sensitivity, each scenario its own forcing after 2015, and each member
its own year-to-year variability. Ensemble statistics are computed from the members, as real prep will do.

Writes, under the CMIP6 key path:
- per model and scenario, the first --map-members members: <member>/annual.zarr with each metric (year, lat, lon)
  and its global mean (year);
- per model and scenario, ensemble/annual.zarr: the mean of all members, `<metric>_agreement` and
  `<metric>_spread` across them, and the mean's global mean;
- per scenario, multimodel/<scenario>/annual.zarr: the mean of the model means, with agreement and spread across
  models;
- members.zarr: every member's global mean (member run, year) and every ensemble mean's (run, year), for plumes;
- catalog.json, which lists all of it.

Change (for agreement and spread) is measured from each run's own 1961-1990 mean. Re-running replaces a previous
mock in --out; it refuses to write over a catalog that is not a mock's.
"""

import argparse
import json
import shutil
import time
import warnings
import zlib
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import xarray as xr
from zarr.codecs import GzipCodec

YEARS = np.arange(1950, 2101)
LON = np.arange(-179.5, 180)
LAT = np.arange(-89.5, 90)
RAD = np.pi / 180
BASELINE = (YEARS >= 1961) & (YEARS <= 1990)
ENSEMBLES = Path(__file__).with_name("mock_ensembles.json")

# id, label, forcing after 2015 relative to SSP2-4.5
SCENARIOS = [("ssp126", "SSP1-2.6", 0.45), ("ssp245", "SSP2-4.5", 1.0), ("ssp370", "SSP3-7.0", 1.45), ("ssp585", "SSP5-8.5", 1.9)]
# id, name, group, units, display range of the field, display range of the spread (its stipple threshold is half)
METRICS = [
    ("pr", "Precipitation", "Precipitation", "mm/day", [0, 14], 1.6),
    ("rx1day", "Wettest day", "Precipitation", "mm/day", [0, 60], 6),
    ("cdd", "Longest dry spell", "Precipitation", "days", [0, 120], 32),
    ("tas", "Temperature", "Temperature", "°C", [-30, 35], 1.6),
]

# Broadcast as (year, lat, lon).
year = YEARS[:, None, None].astype("float64")
lat = LAT[None, :, None]
lon = LON[None, None, :]
AREA = np.cos(LAT * RAD)


def rng(*names: str) -> np.random.Generator:
    """The same random numbers for the same model or member on every run."""
    return np.random.default_rng(zlib.crc32("/".join(names).encode()))


def warming(forcing: float, sensitivity: float):
    """Warming from about 1970, in degrees: about 3 by 2100 for SSP2-4.5 at sensitivity 1, the same for every
    scenario up to 2015."""
    h = lambda y: 3 * np.maximum(0, (y - 1970) / 130) ** 1.6  # noqa: E731
    return sensitivity * np.where(year <= 2015, h(year), h(2015) + forcing * (h(year) - h(2015)))


def fields(model: str, member: str, forcing: float) -> dict[str, np.ndarray]:
    """Every metric of one member run, (year, lat, lon) float32.

    Precipitation (mm/day): a tropical rain band that wobbles from year to year, wetter over the Maritime Continent,
    Amazon and Congo, mid-latitude storm tracks and some ripples; warming makes the band wetter, the subtropics drier
    and moves the storm tracks poleward. Wettest day (mm/day) is heavier where it rains more and with warming;
    longest dry spell (days) is long where it rains little. Temperature (°C): warm tropics, cold poles, warming
    stronger toward the poles. A model shifts the band, storm tracks, wetness and temperature and scales the warming;
    a member has its own phases of the year-to-year wobble.
    """
    m, p = rng(model).uniform(size=5), rng(model, member).uniform(0, 2 * np.pi, size=4)
    sensitivity, band_lat, track_lat, wet, bias = 0.7 + 0.7 * m[0], 4 * m[1] - 2, 6 * m[2] - 3, 0.8 + 0.4 * m[3], 4 * m[4] - 2
    warm = warming(forcing, sensitivity)

    itcz = band_lat + 1.5 * np.sin(year * 0.9 + p[0]) + np.sin(year * 0.37 + p[1])
    land = np.exp(-(((lon - 120) / 35) ** 2)) + 0.7 * np.exp(-(((lon + 60) / 20) ** 2)) + 0.6 * np.exp(-(((lon - 20) / 15) ** 2))
    band = (6 + 6 * wet * land) * (1 + 0.07 * warm) * np.exp(-(((lat - itcz) / 8) ** 2))
    dry = 1 - 0.06 * warm * np.exp(-(((np.abs(lat) - 25) / 8) ** 2))
    track = 45 + track_lat + 1.5 * warm
    storms = 4 * (1 + 0.04 * warm) * np.exp(-(((np.abs(lat) - track) / 10) ** 2)) * (0.7 + 0.3 * np.cos(2 * lon * RAD + 3 * lat * RAD))
    ripple = 0.8 * np.sin(5 * lon * RAD + 3 * lat * RAD) * np.sin(7 * lat * RAD - 2 * lon * RAD + year * 0.5 + p[2])
    pr = np.maximum(0, (0.4 + band + storms + ripple) * dry)

    tas = (
        -28 + bias + 55 * np.cos(lat * RAD) ** 1.4 + 4 * np.sin(2 * lon * RAD) * np.cos(lat * RAD)
        + warm * (1 + np.abs(lat) / 60)
        + 0.4 * np.sin(year * 1.3 + lon * RAD + p[3])
    )
    out = {"pr": pr, "rx1day": (4 + 3.5 * pr) * (1 + 0.05 * warm), "cdd": 3 + 110 * np.exp(-pr / 1.2), "tas": tas}
    shape = (len(YEARS), len(LAT), len(LON))
    return {k: np.broadcast_to(v, shape).astype("float32") for k, v in out.items()}


def global_mean(values: np.ndarray) -> np.ndarray:
    """Area-weighted (cos(lat)) mean of (year, lat, lon) per year."""
    return (np.einsum("ylx,l->y", values, AREA) / (AREA.sum() * values.shape[2])).astype("float32")


class Spread:
    """Mean of runs, and agreement and spread of their change from the baseline, accumulated one run at a time."""

    def __init__(self):
        self.n = 0

    def add(self, values: np.ndarray):
        change = values - values[BASELINE].mean(axis=0)
        if not self.n:  # in place from here on: allocating per run cost a third of the time
            self.total, self.change, self.square = (np.zeros(values.shape) for _ in range(3))
            self.rising = np.zeros(values.shape, "int16")
        self.n += 1
        self.total += values
        self.change += change
        self.square += np.square(change, dtype="float64")
        self.rising += change > 0

    def result(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Mean, agreement (fraction of runs on the side of the majority's sign of change, 0.5-1) and spread
        (standard deviation of the change)."""
        n = self.n
        agreement = np.maximum(self.rising, n - self.rising) / n
        spread = np.sqrt(np.maximum(0, self.square / n - (self.change / n) ** 2))
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


def write(path: Path, variables: dict, **node):
    """One node's store: Zarr v3, gzip, consolidated, one year per chunk."""
    ds = xr.Dataset(
        variables,
        coords={
            "year": ("year", YEARS.astype("int32"), {"long_name": "year"}),
            "lat": ("lat", LAT.astype("float32"), {"units": "degrees_north", "long_name": "latitude"}),
            "lon": ("lon", LON.astype("float32"), {"units": "degrees_east", "long_name": "longitude"}),
        },
        attrs={"title": "hydroviewer mock (analytic formulas, not real data)", "source": "prep/make_mock.py"} | node,
    )
    gzip = [GzipCodec(level=5)]
    encoding = {n: {"compressors": gzip} | ({"chunks": (1, len(LAT), len(LON))} if ds[n].ndim == 3 else {}) for n in ds.variables}
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message="Consolidated metadata")
        ds.to_zarr(path, mode="w", zarr_format=3, consolidated=True, encoding=encoding)


def statistics(spreads: dict, by: str) -> dict:
    """Variables of an aggregate node: per metric its mean, agreement, spread and the mean's global mean."""
    out = {}
    for metric in METRICS:
        mean, agreement, spread = spreads[metric[0]].result()
        dims = ("year", "lat", "lon")
        out[metric[0]] = (dims, mean, attrs(metric) | {"long_name": f"{metric[1]}, mean of {by}"})
        # actual_range (min, max over all years) bounds the app's threshold slider without reading every year.
        extent = lambda a: {"actual_range": [float(a.min()), float(a.max())]}  # noqa: E731
        out[f"{metric[0]}_agreement"] = (dims, agreement, attrs(metric, "agreement") | {"long_name": f"Agreement of {by}"} | extent(agreement))
        out[f"{metric[0]}_spread"] = (dims, spread, attrs(metric, "spread") | {"long_name": f"Spread of {by}"} | extent(spread))
        out[f"{metric[0]}_global_mean"] = (("year",), global_mean(mean), {"units": metric[3], "long_name": f"Global mean {metric[1].lower()}, mean of {by}"})
    return out


def ensemble(task: tuple) -> dict[str, np.ndarray]:
    """One model and scenario: map stores for the first members, the ensemble store, and every member's global
    mean per metric (member, year)."""
    out, run, forcing = task
    spreads = {m[0]: Spread() for m in METRICS}
    series = {m[0]: [] for m in METRICS}
    for member in run["members"]:
        values = fields(run["model"], member, forcing)
        variables = {}
        for metric in METRICS:
            id = metric[0]
            spreads[id].add(values[id])
            series[id].append(global_mean(values[id]))
            variables[id] = (("year", "lat", "lon"), values[id], attrs(metric))
            variables[f"{id}_global_mean"] = (("year",), series[id][-1], {"units": metric[3], "long_name": f"Global mean {metric[1].lower()}"})
        if member in run["maps"]:
            write(out / run["store"].format(member=member), variables, scenario=run["scenario"], model=run["model"], member=member)
    write(out / run["ensemble"], statistics(spreads, f"{len(run['members'])} members"), scenario=run["scenario"], model=run["model"])
    return {k: np.stack(v) for k, v in series.items()}


def multimodel(task: tuple):
    """One scenario: the mean of the model ensemble means, with agreement and spread across models."""
    out, scenario, stores, path = task
    spreads = {m[0]: Spread() for m in METRICS}
    for store in stores:
        ds = xr.open_zarr(out / store, consolidated=True)
        for metric in METRICS:
            spreads[metric[0]].add(ds[metric[0]].values)
    write(out / path, statistics(spreads, f"{len(stores)} models"), scenario=scenario)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("--out", type=Path, default=Path("/data"))
    parser.add_argument("--models", type=int, default=8, help="how many models, largest ensembles first (50 = all)")
    parser.add_argument("--map-members", type=int, default=3, help="members per model and scenario with map stores")
    parser.add_argument("--workers", type=int, default=6, help="processes; each needs about 2 GB")
    args = parser.parse_args()
    out, started = args.out, time.time()

    # Replace a previous mock, and nothing else.
    catalog_path = out / "catalog.json"
    if catalog_path.exists():
        if not json.loads(catalog_path.read_text()).get("mock"):
            raise SystemExit(f"{catalog_path} is not a mock's catalog; use an empty data directory for the mock")
        for old in ["CMIP6", "members.zarr", "mock"]:
            shutil.rmtree(out / old, ignore_errors=True)

    models = json.loads(ENSEMBLES.read_text())["models"][: args.models]
    forcing = {id: f for id, _, f in SCENARIOS}
    runs = []
    for id, _, _ in SCENARIOS:
        for model in models:
            members = model["members"].get(id)
            if not members:
                continue
            base = f"CMIP6/ScenarioMIP/{model['institution']}/{model['id']}/{id}"
            runs.append({
                "scenario": id, "model": model["id"], "institution": model["institution"],
                "members": members, "maps": members[: args.map_members],
                "store": f"{base}/{{member}}/annual.zarr", "ensemble": f"{base}/ensemble/annual.zarr",
            })

    with ProcessPoolExecutor(args.workers) as pool:
        # Largest ensembles first, so no worker is left with a big one at the end.
        order = sorted(range(len(runs)), key=lambda i: -len(runs[i]["members"]))
        done = dict(zip(order, pool.map(ensemble, [(out, runs[i], forcing[runs[i]["scenario"]]) for i in order])))
        series = [done[i] for i in range(len(runs))]
        multi = {}
        for id, _, _ in SCENARIOS:
            stores = [r["ensemble"] for r in runs if r["scenario"] == id]
            if stores:
                multi[id] = {"store": f"CMIP6/ScenarioMIP/multimodel/{id}/annual.zarr", "models": len(stores)}
        list(pool.map(multimodel, [(out, id, [r["ensemble"] for r in runs if r["scenario"] == id], m["store"]) for id, m in multi.items()]))

    # Plumes: every member's global mean, rows in catalog order (a run's members start at its `series` row), and
    # every ensemble mean's, one row per run.
    row = 0
    for run, s in zip(runs, series):
        run["series"] = row
        row += len(run["members"])
    plumes = {}
    for metric in METRICS:
        id, units, name = metric[0], metric[3], metric[1].lower()
        plumes[f"{id}_global_mean"] = (("member_run", "year"), np.concatenate([s[id] for s in series]), {"units": units, "long_name": f"Global mean {name}"})
        plumes[f"{id}_ensemble_global_mean"] = (("run", "year"), np.stack([s[id].mean(axis=0) for s in series]), {"units": units, "long_name": f"Global mean {name}, ensemble mean"})
    ds = xr.Dataset(plumes, coords={"year": ("year", YEARS.astype("int32"), {"long_name": "year"})})
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message="Consolidated metadata")
        ds.to_zarr(out / "members.zarr", mode="w", zarr_format=3, consolidated=True, encoding={n: {"compressors": [GzipCodec(level=5)]} for n in ds.variables})

    catalog = {
        "mock": True,
        "facets": ["scenario", "model", "member"],
        "scenarios": [{"id": id, "label": label} for id, label, _ in SCENARIOS if id in multi],
        "metrics": [{"id": m[0], "group": m[2], "statistics": ["agreement", "spread"]} for m in METRICS],
        "series": "members.zarr",
        "multimodel": multi,
        "runs": runs,
    }
    catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=1) + "\n")
    print(
        f"wrote {len(models)} models, {len(runs)} model-scenario runs, {row} members "
        f"({sum(len(r['maps']) for r in runs)} with maps) into {out} in {time.time() - started:.0f} s"
    )


if __name__ == "__main__":
    main()
