"""Stage 1: one member's daily precipitation to annual metrics on the 1° grid.

Two kinds of task, both run on Dask workers:
- historical(member): 1961-1990 wet-day percentiles on the native grid (for R95p and R99p, kept in base.npz),
  then the 11 metrics for 1950-2014;
- scenario(member, ssp): the metrics for 2015-2100 with that member's percentiles.

Each reads its source store through a local partial copy (source.py) under the scratch directory, deleted when
the task is done, and writes /work/runs/<model>/<member>/<experiment>.zarr (float32, full precision) by
renaming a finished temporary store, so a task either left its result or nothing and a rerun skips done work.
"""

import json
import resource
import shutil
import time
from pathlib import Path

import numpy as np
import xarray as xr
from zarr.codecs import GzipCodec

import indices
import regrid
from source import Store

HISTORICAL = (1950, 2014)
SCENARIO = (2015, 2100)
BASE = (1961, 1990)
BAND_BYTES = 256 << 20  # cells sorted at once for the percentiles
LAT = np.arange(-89.5, 90)
LON = np.arange(-179.5, 180)


def run_dir(work: Path, member: dict) -> Path:
    return work / "runs" / member["model"] / member["member"]


def done(work: Path, member: dict, experiment: str) -> bool:
    return (run_dir(work, member) / f"{experiment}.zarr").exists()


class Source:
    """A run's local copy, opened, with its years and grid."""

    def __init__(self, zstore: str, local: Path, window: tuple[int, int], connections: int, shift_days: int = 0):
        self.store = Store(zstore, local, connections)
        meta = self.store.metadata()
        names = ["time", "lat", "lon"] + [meta.get(f"{c}/.zattrs", {}).get("bounds", f"{c}_bnds") for c in ("lat", "lon")]
        self.store.fetch_small(only=names)
        self.years = self.store.years(shift_days)
        first, last = np.searchsorted(self.years, window[0]), np.searchsorted(self.years, window[1], side="right") - 1
        counts = np.bincount(self.years[first : last + 1] - window[0], minlength=window[1] - window[0] + 1)
        if counts.min() < 360:
            raise ValueError(f"{self.store.prefix}: incomplete years in {window}: {counts.min()} days")
        started = time.time()
        self.store.fetch_pr(first, last)
        self.download_seconds = round(time.time() - started, 1)
        self.ds = self.store.open()
        pr = self.ds["pr"]
        if pr.dims[0] != "time" or len(pr.dims) != 3:
            raise ValueError(f"{self.store.prefix}: pr has dims {pr.dims}")
        units = pr.attrs.get("units", "")
        if units not in ("kg m-2 s-1", "kg m-2 s-1 ", "kg/m2/s"):
            raise ValueError(f"{self.store.prefix}: pr in {units!r}")
        self.shape = pr.shape[1:]
        self.grid = regrid.weights(self.bounds("lat"), self.bounds("lon"))
        self.nan = 0

    def bounds(self, coord: str) -> np.ndarray:
        name = self.ds[coord].attrs.get("bounds", f"{coord}_bnds")
        values = self.ds[coord].values
        if values.ndim != 1:
            raise ValueError(f"{self.store.prefix}: {coord} is not 1-D (not a rectilinear grid)")
        if name in self.ds:
            return self.ds[name].values.reshape(-1, 2)
        return regrid.edges_from_centres(values, period=360 if coord == "lon" else None)

    def year(self, y: int) -> np.ndarray:
        """One calendar year of daily values, mm/day, NaN (fill) as 0 and counted."""
        i, j = np.searchsorted(self.years, y), np.searchsorted(self.years, y, side="right")
        days = self.ds["pr"].isel(time=slice(i, j)).values.astype("float32") * 86400
        bad = ~np.isfinite(days)
        if bad.any():
            self.nan += int(bad.sum())
            days[bad] = 0
        return days


def percentiles(src: Source, scratch: Path) -> tuple[np.ndarray, np.ndarray]:
    """1961-1990 wet-day 95th and 99th percentiles per native cell. The 30 years (5.8 GB for EC-Earth3) go to a
    file as they arrive (time-major, plain writes: written pages of a memory map would count as the worker's
    memory), then a band of latitudes at a time is mapped, copied out and sorted."""
    years = range(BASE[0], BASE[1] + 1)
    ny, nx = src.shape
    path, n = scratch / "base.f32", 0
    with open(path, "wb") as f:
        for y in years:
            d = src.year(y)
            d.tofile(f)
            n += len(d)
    p95, p99 = np.empty((ny, nx), "float32"), np.empty((ny, nx), "float32")
    rows = max(1, BAND_BYTES // (n * nx * 4))
    for r in range(0, ny, rows):
        stack = np.memmap(path, dtype="float32", mode="r", shape=(n, ny, nx))
        band = np.array(stack[:, r : r + rows])
        del stack
        p95[r : r + rows], p99[r : r + rows] = indices.wet_percentiles(band)
    path.unlink()
    return p95, p99


def metrics(src: Source, window: tuple[int, int], p95, p99) -> dict[str, np.ndarray]:
    """Every metric for each year of the window, regridded: (year, 180, 360) float32."""
    years = range(window[0], window[1] + 1)
    out = {k: np.empty((len(years), len(LAT), len(LON)), "float32") for k in indices.NAMES}
    for i, y in enumerate(years):
        for k, v in indices.annual(src.year(y), p95, p99).items():
            out[k][i] = regrid.apply(src.grid, v)
    return out


def save(path: Path, values: dict, window: tuple[int, int], about: dict):
    years = np.arange(window[0], window[1] + 1, dtype="int32")
    ds = xr.Dataset(
        {k: (("year", "lat", "lon"), v) for k, v in values.items()},
        coords={"year": years, "lat": LAT.astype("float32"), "lon": LON.astype("float32")},
        attrs=about,
    )
    tmp = path.with_name(path.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    encoding = {k: {"compressors": [GzipCodec(level=1)], "chunks": (1, len(LAT), len(LON))} for k in values}
    ds.to_zarr(tmp, mode="w", zarr_format=3, consolidated=False, encoding=encoding)
    shutil.rmtree(path, ignore_errors=True)
    tmp.rename(path)


def about(member: dict, zstore: str, src: Source, started: float) -> dict:
    return {
        "model": member["model"], "member": member["member"], "source": zstore, "calendar": src.store.meta["time/.zattrs"].get("calendar", ""),
        "native_grid": list(src.shape), "nan_days_set_to_zero": src.nan, "bytes_read": src.store.bytes,
        "download_seconds": src.download_seconds, "seconds": round(time.time() - started, 1),
        # The worker process's peak so far (it may have run bigger tasks before), for sizing --memory.
        "worker_peak_mb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024,
    }


def historical(member: dict, work: Path, scratch: Path, connections: int) -> dict:
    out = run_dir(work, member)
    if (out / "historical.zarr").exists():
        return {"task": f"{member['model']}/{member['member']}/historical", "skipped": True}
    started, local = time.time(), scratch / member["model"] / member["member"] / "historical"
    shutil.rmtree(local, ignore_errors=True)
    local.mkdir(parents=True)
    try:
        src = Source(member["historical"], local, HISTORICAL, connections, member.get("shift_days", {}).get(member["historical"], 0))
        p95, p99 = percentiles(src, local)
        values = metrics(src, HISTORICAL, p95, p99)
        out.mkdir(parents=True, exist_ok=True)
        np.savez(out / "base.npz", p95=p95, p99=p99)
        info = about(member, member["historical"], src, started)
        save(out / "historical.zarr", values, HISTORICAL, info)
    finally:
        shutil.rmtree(local, ignore_errors=True)
    return {"task": f"{member['model']}/{member['member']}/historical"} | info


def scenario(member: dict, ssp: str, work: Path, scratch: Path, connections: int, after=None) -> dict:
    """`after` is the historical task's result (only to make Dask run this one after it)."""
    out = run_dir(work, member)
    if (out / f"{ssp}.zarr").exists():
        return {"task": f"{member['model']}/{member['member']}/{ssp}", "skipped": True}
    if not (out / "historical.zarr").exists():
        raise RuntimeError(f"{member['model']}/{member['member']}: historical not done")
    base = np.load(out / "base.npz")
    started, local = time.time(), scratch / member["model"] / member["member"] / ssp
    shutil.rmtree(local, ignore_errors=True)
    local.mkdir(parents=True)
    try:
        zstore = member["scenarios"][ssp]
        src = Source(zstore, local, SCENARIO, connections, member.get("shift_days", {}).get(zstore, 0))
        if src.shape != base["p95"].shape:
            raise ValueError(f"{zstore}: grid {src.shape} differs from historical {base['p95'].shape}")
        values = metrics(src, SCENARIO, base["p95"], base["p99"])
        info = about(member, zstore, src, started)
        save(out / f"{ssp}.zarr", values, SCENARIO, info)
    finally:
        shutil.rmtree(local, ignore_errors=True)
    return {"task": f"{member['model']}/{member['member']}/{ssp}"} | info


def report(results: list[dict], path: Path):
    """Appends task results to a JSON-lines log (bytes, seconds, NaN counts), for the record and for tuning."""
    with open(path, "a") as f:
        for r in results:
            f.write(json.dumps(r) + "\n")
