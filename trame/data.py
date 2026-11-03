"""Read the fields the browser viewports also read: the first month (map.zarr) or an aggregate map
(aggregates.zarr), same ids as `Source` in src/data/cmip6.ts."""

import os
import re
from dataclasses import dataclass
from functools import cache

import numpy as np
import xarray as xr

DATA_URL = os.environ.get("DATA_URL", "http://data:9000")
PATH = "CMIP6/CMIP/NOAA-GFDL/GFDL-CM4/historical/r1i1p1f1/Amon/pr/gr1/v20180701"
SOURCES = ("month", "pr_trend", "pr_wettest_month")


@dataclass
class Field:
    lon: np.ndarray  # degrees east, -180..180, west to east
    lat: np.ndarray  # degrees north, south to north
    values: np.ndarray  # (lat, lon)
    uncertainty: np.ndarray  # (lat, lon), 0..1, synthetic: globe relief
    vmin: float  # colour scale; below zero means diverging
    vmax: float
    units: str
    label: str  # e.g. "pr · 1850-01"


@cache
def store(name: str) -> xr.Dataset:
    return xr.open_zarr(f"{DATA_URL}/{PATH}/{name}", zarr_format=3, consolidated=True, chunks=None, decode_times=False)


def load(source: str = "month") -> Field:
    ds = store("map.zarr")
    if source == "month":
        values = ds["pr"].isel(time=0).values.astype("float32")
        year, month = map(int, re.search(r"since (\d{4})-(\d{2})", ds["time"].attrs["units"]).groups())
        # Same rule as the browser: the 99th percentile, since precipitation has a long tail.
        vmin, vmax = 0.0, float(np.sort(values.ravel())[int(0.99 * values.size)])
        units, label = ds["pr"].attrs["units"], f"pr · {year}-{month:02d}"
    else:
        array = store("aggregates.zarr")[source]
        values = array.values.astype("float32")
        vmin, vmax = map(float, array.attrs["display_range"])  # from prep, used as is (like the browser)
        units, label = array.attrs["units"], f"{array.attrs['long_name']} · {array.attrs['period']}"
    return Field(
        lon=ds["lon"].values,
        lat=ds["lat"].values,
        values=values,
        # stores prepped before the relief was added have none: the globe is then flat, as in the browser
        uncertainty=ds["uncertainty"].values.astype("float32") if "uncertainty" in ds else np.zeros_like(values),
        vmin=vmin,
        vmax=vmax,
        units=units,
        label=label,
    )
