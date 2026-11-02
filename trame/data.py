"""Read one month of the precipitation store that the browser viewports also read."""

import os
import re
from dataclasses import dataclass

import numpy as np
import xarray as xr

DATA_URL = os.environ.get("DATA_URL", "http://data:9000")
STORE = "CMIP6/CMIP/NOAA-GFDL/GFDL-CM4/historical/r1i1p1f1/Amon/pr/gr1/v20180701/map.zarr"


@dataclass
class Field:
    lon: np.ndarray  # degrees east, -180..180, west to east
    lat: np.ndarray  # degrees north, south to north
    values: np.ndarray  # (lat, lon)
    vmax: float  # colour scale maximum
    units: str
    label: str  # e.g. "1850-01"


def load_month(index: int = 0) -> Field:
    ds = xr.open_zarr(f"{DATA_URL}/{STORE}", zarr_format=3, consolidated=True, chunks=None, decode_times=False)
    values = ds["pr"].isel(time=index).values.astype("float32")
    year, month = map(int, re.search(r"since (\d{4})-(\d{2})", ds["time"].attrs["units"]).groups())
    at = year * 12 + month - 1 + index
    # Same rule as the browser: the 99th percentile, since precipitation has a long tail.
    vmax = float(np.sort(values.ravel())[int(0.99 * values.size)])
    return Field(
        lon=ds["lon"].values,
        lat=ds["lat"].values,
        values=values,
        vmax=vmax,
        units=ds["pr"].attrs["units"],
        label=f"{at // 12}-{at % 12 + 1:02d}",
    )
