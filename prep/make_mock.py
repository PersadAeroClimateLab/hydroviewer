"""Write a mock multi-model, multi-scenario ensemble into a bucket root, in the layout the app reads
(docs/llm/DATA_TREE_PLAN.md, section 7):

    make_mock.py [--out /data] [--models 8] [--map-members 3] [--workers 4]

Models and their members are real names (mock_ensembles.json, largest ensembles first); the values are analytic
formulas on the target 1° grid (360 x 180, cell-centred, south to north, west to east), annual, 1950-2100. Not real
data. Metrics: mean precipitation and ETCCDI precipitation indices that are stored at yearly (or monthly)
frequency: PRCPTOT, SDII, Rx1day, Rx5day, R95p, R99p, R10mm, R20mm, CDD, CWD (annual values here). Each model has
its own bias and climate sensitivity, each scenario its own forcing after 2015, and each member its own
year-to-year variability. Ensemble statistics are computed from the members, as real prep will do.

Writes the layout in bucket.py (shared with the real-data pipeline), with map stores for the first --map-members
members of each model and scenario. Re-running replaces a previous mock in --out; it refuses to write over a
catalog that is not a mock's.
"""

import argparse
import json
import shutil
import time
import zlib
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

from bucket import LAT, LON, METRICS, RAD, SCENARIOS, YEARS, Spread, finish, member_variables, multimodel, statistics, write

ENSEMBLES = Path(__file__).with_name("mock_ensembles.json")

ABOUT = {"title": "hydroviewer mock (analytic formulas, not real data)", "source": "prep/make_mock.py"}
# Forcing after 2015 relative to SSP2-4.5.
FORCING = {"ssp126": 0.45, "ssp245": 1.0, "ssp370": 1.45, "ssp585": 1.9}

# Broadcast as (year, lat, lon).
year = YEARS[:, None, None].astype("float64")
lat = LAT[None, :, None]
lon = LON[None, None, :]


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

    Mean precipitation (mm/day): a tropical rain band that wobbles from year to year, wetter over the Maritime
    Continent, Amazon and Congo, mid-latitude storm tracks and some ripples; warming makes the band wetter, the
    subtropics drier and moves the storm tracks poleward. The ETCCDI indices follow from it and the warming with
    plausible shapes, not from daily data: the share of wet days (>= 1 mm) rises with the mean, wet-day amounts are
    taken as exponential with mean SDII (so R10mm and R20mm are tails of it), extremes intensify with warming faster
    than the mean, and dry spells are long where it rains little. A model shifts the band and storm tracks, scales
    the wetness and the warming; a member has its own phases of the year-to-year wobble, and its own wetter and
    drier years everywhere at once (a few percent, as in real ensembles; the wobble alone cancels out in a global
    mean, so members' global-mean lines would coincide).
    """
    m, p = rng(model).uniform(size=5), rng(model, member).uniform(0, 2 * np.pi, size=4)
    sensitivity, band_lat, track_lat, wet = 0.7 + 0.7 * m[0], 4 * m[1] - 2, 6 * m[2] - 3, 0.8 + 0.4 * m[3]
    warm = warming(forcing, sensitivity)

    itcz = band_lat + 1.5 * np.sin(year * 0.9 + p[0]) + np.sin(year * 0.37 + p[1])
    land = np.exp(-(((lon - 120) / 35) ** 2)) + 0.7 * np.exp(-(((lon + 60) / 20) ** 2)) + 0.6 * np.exp(-(((lon - 20) / 15) ** 2))
    band = (6 + 6 * wet * land) * (1 + 0.07 * warm) * np.exp(-(((lat - itcz) / 8) ** 2))
    dry = 1 - 0.06 * warm * np.exp(-(((np.abs(lat) - 25) / 8) ** 2))
    track = 45 + track_lat + 1.5 * warm
    storms = 4 * (1 + 0.04 * warm) * np.exp(-(((np.abs(lat) - track) / 10) ** 2)) * (0.7 + 0.3 * np.cos(2 * lon * RAD + 3 * lat * RAD))
    ripple = 0.8 * np.sin(5 * lon * RAD + 3 * lat * RAD) * np.sin(7 * lat * RAD - 2 * lon * RAD + year * 0.5 + p[2])
    wetter = 1 + 0.02 * np.sin(year * 2.1 + p[3]) + 0.012 * np.sin(year * 0.53 + 2 * p[3])
    pr = np.maximum(0, (0.4 + band + storms + ripple) * dry * wetter)

    wet_days = 0.04 + 0.6 * (1 - np.exp(-pr / 2.5))  # share of days with >= 1 mm
    prcptot = 365 * 0.95 * pr
    sdii = np.maximum(1, prcptot / (365 * wet_days))  # a wet day has at least 1 mm
    rx1day = (4 + 3.5 * pr) * (1 + 0.05 * warm)
    out = {
        "pr": pr,
        "prcptot": prcptot,
        "sdii": sdii,
        "rx1day": rx1day,
        "rx5day": rx1day * (1.6 + 0.6 * (1 - np.exp(-pr / 4))),
        "r95p": prcptot * (0.18 + 0.1 * (1 - np.exp(-pr / 3))) * (1 + 0.06 * warm),
        "r99p": prcptot * (0.05 + 0.04 * (1 - np.exp(-pr / 3))) * (1 + 0.1 * warm),
        "r10mm": 365 * wet_days * np.exp(-10 / sdii),
        "r20mm": 365 * wet_days * np.exp(-20 / sdii),
        "cdd": 3 + 110 * np.exp(-pr / 1.2),
        "cwd": 1 + 18 * wet_days**1.5,
    }
    shape = (len(YEARS), len(LAT), len(LON))
    return {k: np.broadcast_to(v, shape).astype("float32") for k, v in out.items()}


def ensemble(task: tuple) -> dict[str, np.ndarray]:
    """One model and scenario: map stores for the first members, the ensemble store, and every member's global
    mean per metric (member, year)."""
    out, run, forcing = task
    spreads = {m[0]: Spread() for m in METRICS}
    series = {m[0]: [] for m in METRICS}
    for member in run["members"]:
        values = fields(run["model"], member, forcing)
        variables, means = member_variables(values)
        for id, v in values.items():
            spreads[id].add(v)
            series[id].append(means[id])
        if member in run["maps"]:
            write(out / run["store"].format(member=member), variables, ABOUT, scenario=run["scenario"], model=run["model"], member=member)
    write(out / run["ensemble"], statistics(spreads, f"{len(run['members'])} members"), ABOUT, scenario=run["scenario"], model=run["model"])
    return {k: np.stack(v) for k, v in series.items()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("--out", type=Path, default=Path("/data"))
    parser.add_argument("--models", type=int, default=8, help="how many models, largest ensembles first (50 = all)")
    parser.add_argument("--map-members", type=int, default=3, help="members per model and scenario with map stores")
    parser.add_argument("--workers", type=int, default=4, help="processes; each needs about 2.5 GB")
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
    runs = []
    for id, _ in SCENARIOS:
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
        done = dict(zip(order, pool.map(ensemble, [(out, runs[i], FORCING[runs[i]["scenario"]]) for i in order])))
        series = [done[i] for i in range(len(runs))]
        multi = {}
        for id, _ in SCENARIOS:
            stores = [r["ensemble"] for r in runs if r["scenario"] == id]
            if stores:
                multi[id] = {"store": f"CMIP6/ScenarioMIP/multimodel/{id}/annual.zarr", "models": len(stores)}
        tasks = [(out, id, [r["ensemble"] for r in runs if r["scenario"] == id], m["store"], ABOUT) for id, m in multi.items()]
        list(pool.map(multimodel, *zip(*tasks)))
    row = finish(out, runs, series, multi, {"mock": True, "dataset": {"label": "Mock data"}})
    print(
        f"wrote {len(models)} models, {len(runs)} model-scenario runs, {row} members "
        f"({sum(len(r['maps']) for r in runs)} with maps) into {out} in {time.time() - started:.0f} s"
    )


if __name__ == "__main__":
    main()
