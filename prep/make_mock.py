"""Write the mock dataset into a bucket root, in the format the app reads, so the app runs without real data:

    make_mock.py [--out /data]

Writes <out>/catalog.json and <out>/mock/annual.zarr (Zarr v3, gzip, consolidated metadata). Annual means from
analytic formulas on the target 1° grid (360 x 180, cell-centred, south to north, west to east), 1950-2100.
Not real data. Each metric is an array (year, lat, lon) with its ensemble statistics `<metric>_agreement` and
`<metric>_spread` on the same axes and its area-weighted global mean `<metric>_global_mean` (year). Every
array has `units` and `long_name`; maps have `display_range`, statistics `stipple_threshold`. Re-running
replaces both. Edit the formulas here to change the mock.
"""

import argparse
import json
from pathlib import Path

import numpy as np
import xarray as xr
from zarr.codecs import GzipCodec

STORE = "mock/annual.zarr"
YEARS = np.arange(1950, 2101)
LON = np.arange(-179.5, 180)
LAT = np.arange(-89.5, 90)
RAD = np.pi / 180

# Broadcast as (year, lat, lon).
year = YEARS[:, None, None].astype("float64")
lat = LAT[None, :, None]
lon = LON[None, None, :]


def warming(year):
    """Warming from about 1970, in degrees by 2100."""
    return 3 * np.maximum(0, (year - 1970) / 130) ** 1.6


def pr(year, wobble=True):
    """Precipitation (mm/day): a tropical rain band that wobbles from year to year, wetter over the Maritime
    Continent, Amazon and Congo, mid-latitude storm tracks and some ripples. Warming makes the band wetter, the
    subtropics drier and moves the storm tracks poleward. Without `wobble`, only the forced change (no
    year-to-year wobble of the band or ripples), as an ensemble mean would show it."""
    warm = warming(year)
    itcz = 2 + 1.5 * np.sin(year * 0.9) + np.sin(year * 0.37) if wobble else 2
    land = np.exp(-(((lon - 120) / 35) ** 2)) + 0.7 * np.exp(-(((lon + 60) / 20) ** 2)) + 0.6 * np.exp(-(((lon - 20) / 15) ** 2))
    band = (6 + 6 * land) * (1 + 0.07 * warm) * np.exp(-(((lat - itcz) / 8) ** 2))
    dry = 1 - 0.06 * warm * np.exp(-(((np.abs(lat) - 25) / 8) ** 2))
    track = 45 + 1.5 * warm
    storms = 4 * (1 + 0.04 * warm) * np.exp(-(((np.abs(lat) - track) / 10) ** 2)) * (0.7 + 0.3 * np.cos(2 * lon * RAD + 3 * lat * RAD))
    ripple = 0.8 * np.sin(5 * lon * RAD + 3 * lat * RAD) * np.sin(7 * lat * RAD - 2 * lon * RAD + (year * 0.5 if wobble else 0))
    return np.maximum(0, (0.4 + band + storms + ripple) * dry)


def rx1day(year, wobble=True):
    """Wettest day of the year (mm/day): heavier where it rains more, and heavier with warming."""
    return (4 + 3.5 * pr(year, wobble)) * (1 + 0.05 * warming(year))


def cdd(year, wobble=True):
    """Longest dry spell (days): long where it rains little."""
    return 3 + 110 * np.exp(-pr(year, wobble) / 1.2)


def tas(year, wobble=True):
    """Near-surface temperature (°C): warm tropics, cold poles, warming stronger toward the poles."""
    return (
        -28 + 55 * np.cos(lat * RAD) ** 1.4 + 4 * np.sin(2 * lon * RAD) * np.cos(lat * RAD)
        + warming(year) * (1 + np.abs(lat) / 60)
        + (0.4 * np.sin(year * 1.3 + lon * RAD) if wobble else 0)
    )


# id, name, group, units, display range, formula, size of the model spread in the metric's units
METRICS = [
    ("pr", "Precipitation", "Precipitation", "mm/day", [0, 14], pr, 0.5),
    ("rx1day", "Wettest day", "Precipitation", "mm/day", [0, 60], rx1day, 2),
    ("cdd", "Longest dry spell", "Precipitation", "days", [0, 120], cdd, 6),
    ("tas", "Temperature", "Temperature", "°C", [-30, 35], tas, 0.8),
]


def statistics(at, units: str, scale: float) -> dict[str, tuple]:
    """Ensemble statistics of a metric's change since 1970. Spread (standard deviation across models) grows with
    warming. Agreement (fraction of models agreeing on the sign of the change, 0.5 = a coin flip, IPCC style) is
    high where the forced change is large against the spread; both show no signal before the warming starts."""
    spread = scale * (1 + 0.5 * np.sin(3 * lon * RAD) * np.cos(4 * lat * RAD)) * (1 + warming(year) / 6)
    agreement = 0.5 + 0.5 * np.tanh(np.abs(at(year, False) - at(np.float64(1970), False)) / (1.6 * spread))
    return {
        "agreement": (agreement, {"units": "fraction of models", "long_name": "Model agreement", "display_range": [0.5, 1], "stipple_threshold": 0.8}),
        "spread": (spread, {"units": units, "long_name": "Model spread", "display_range": [0, 3 * scale], "stipple_threshold": 1.6 * scale}),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("--out", default="/data")
    args = parser.parse_args()

    dims = ("year", "lat", "lon")
    area = np.cos(LAT * RAD)[:, None] * np.ones(len(LON))
    variables, entries = {}, []
    for id, name, group, units, display_range, at, scale in METRICS:
        values = np.broadcast_to(at(year), (len(YEARS), len(LAT), len(LON)))
        variables[id] = (dims, values.astype("float32"), {"units": units, "long_name": name, "display_range": display_range})
        global_mean = (values * area).sum(axis=(1, 2)) / area.sum()
        variables[f"{id}_global_mean"] = (("year",), global_mean.astype("float32"), {"units": units, "long_name": f"Global mean {name.lower()} (mock)"})
        stats = statistics(at, units, scale)
        for stat, (v, attrs) in stats.items():
            variables[f"{id}_{stat}"] = (dims, np.broadcast_to(v, values.shape).astype("float32"), attrs)
        entries.append({"id": id, "group": group, "statistics": list(stats)})
    assert all(np.isfinite(v[1]).all() for v in variables.values()), "NaN or infinity in the mock"

    ds = xr.Dataset(
        variables,
        coords={
            "year": ("year", YEARS.astype("int32"), {"long_name": "year"}),
            "lat": ("lat", LAT.astype("float32"), {"units": "degrees_north", "long_name": "latitude"}),
            "lon": ("lon", LON.astype("float32"), {"units": "degrees_east", "long_name": "longitude"}),
        },
        attrs={"title": "hydroviewer mock dataset (analytic formulas, not real data)", "source": "prep/make_mock.py"},
    )
    gzip = [GzipCodec(level=5)]
    out = Path(args.out)
    ds.to_zarr(
        out / STORE,
        mode="w",
        zarr_format=3,
        consolidated=True,
        # One year per chunk: a step on the timeline fetches one chunk per array shown.
        encoding={n: {"compressors": gzip} | ({"chunks": (1, len(LAT), len(LON))} if ds[n].ndim == 3 else {}) for n in ds.variables},
    )
    catalog = {
        "datasets": [
            {"name": "GFDL-CM4", "detail": "historical + SSP2-4.5 · r1i1p1f1 · mock data", "store": STORE, "metrics": entries},
        ]
    }
    (out / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {out / 'catalog.json'} and {out / STORE}: {', '.join(m[0] for m in METRICS)}, {YEARS[0]}–{YEARS[-1]}")


if __name__ == "__main__":
    main()
