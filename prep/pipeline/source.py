"""Reading cmip6-pds stores (Zarr v2, consolidated, over plain HTTPS; no credentials).

A store is copied to a local directory in part: its metadata, every small array (coordinates, bounds) and only
the `pr` chunks that a time window touches. xarray then opens the local copy like any Zarr store. Downloading
whole chunk objects ourselves (rather than letting zarr fetch them lazily over HTTP) keeps the transfer
concurrent, resumable and retried, and lets the caller delete the copy as soon as a run is done.
"""

import asyncio
import json
import os
import random
import shutil
from pathlib import Path

import aiohttp
import cftime
import numpy as np
import xarray as xr
import zarr

BUCKET = "https://cmip6-pds.s3.amazonaws.com/"
TRIES = 8


def prefix(zstore: str) -> str:
    """The key prefix of a catalogue `zstore` (s3://cmip6-pds/CMIP6/... or gs://...), with a trailing slash."""
    key = zstore.split("CMIP6/", 1)[1]
    return "CMIP6/" + key.rstrip("/") + "/"


async def _download(session: aiohttp.ClientSession, url: str, path: Path, gate: asyncio.Semaphore) -> int:
    """One object to `path` (via a .part file); 0 for a missing key (Zarr leaves out chunks that are all fill)."""
    for attempt in range(TRIES):
        try:
            async with gate, session.get(url) as response:
                if response.status == 404:
                    return 0
                response.raise_for_status()
                path.parent.mkdir(parents=True, exist_ok=True)
                part = path.with_name(path.name + ".part")
                size = 0
                with open(part, "wb") as f:
                    async for block in response.content.iter_chunked(1 << 20):
                        f.write(block)
                        size += len(block)
                if response.content_length is not None and size != response.content_length:
                    raise aiohttp.ClientPayloadError(f"{url}: {size} of {response.content_length} bytes")
                os.replace(part, path)
                return size
        except (aiohttp.ClientError, asyncio.TimeoutError, ConnectionError) as error:
            if attempt == TRIES - 1:
                raise RuntimeError(f"{url}: {error!r} after {TRIES} tries") from error
            await asyncio.sleep(min(60, 2**attempt) * (0.5 + random.random()))
    return 0


def download(objects: dict[str, Path], connections: int) -> int:
    """Downloads url -> path for those not already on disk, `connections` at a time; returns the bytes."""
    todo = {u: p for u, p in objects.items() if not p.exists()}
    if not todo:
        return 0

    async def run():
        gate = asyncio.Semaphore(connections)
        timeout = aiohttp.ClientTimeout(total=None, sock_connect=60, sock_read=120)
        connector = aiohttp.TCPConnector(limit=connections)
        # trust_env: HTTPS_PROXY where there is one (the dev sandbox); none on a plain machine.
        async with aiohttp.ClientSession(timeout=timeout, connector=connector, trust_env=True) as session:
            return sum(await asyncio.gather(*(_download(session, u, p, gate) for u, p in todo.items())))

    return asyncio.run(run())


def chunk_keys(name: str, zarray: dict, first: int | None = None, last: int | None = None) -> list[str]:
    """Keys of an array's chunks; for `first`..`last` (positions on the first axis) only the chunks they touch."""
    shape, chunks = zarray["shape"], zarray["chunks"]
    if not shape:
        return [f"{name}/0"]
    counts = [-(-s // c) for s, c in zip(shape, chunks)]
    lead = range(counts[0]) if first is None else range(first // chunks[0], last // chunks[0] + 1)
    sep = zarray.get("dimension_separator", ".")
    keys = []
    for i in lead:
        for rest in np.ndindex(*counts[1:]):
            keys.append(f"{name}/" + sep.join(str(x) for x in (i, *rest)))
    return keys


class Store:
    """A local partial copy of one source store."""

    def __init__(self, zstore: str, local: Path, connections: int = 8):
        self.prefix, self.local, self.connections = prefix(zstore), Path(local), connections
        self.url = BUCKET + self.prefix

    def metadata(self) -> dict:
        """The consolidated metadata, fetched once, and the metadata files written out so zarr can open the copy."""
        path = self.local / ".zmetadata"
        self.bytes = download({self.url + ".zmetadata": path}, 1)
        if not path.exists():
            raise FileNotFoundError(f"{self.url}.zmetadata: no consolidated metadata")
        meta = json.loads(path.read_text())["metadata"]
        for key, value in meta.items():
            target = self.local / key
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps(value))
        self.meta = meta
        return meta

    def arrays(self) -> dict[str, dict]:
        return {k[: -len("/.zarray")]: v for k, v in self.meta.items() if k.endswith("/.zarray")}

    def fetch_small(self, only: list[str] | None = None, ends: bool = False):
        """Every array but `pr` whole, or just `only`; with `ends`, only their first and last chunks."""
        objects = {}
        for name, zarray in self.arrays().items():
            if name == "pr" or (only and name not in only):
                continue
            keys = chunk_keys(name, zarray)
            for key in (keys[:1] + keys[-1:]) if ends else keys:
                objects[self.url + key] = self.local / key
        self.bytes += download(objects, self.connections)

    def fetch_pr(self, first: int, last: int):
        """The `pr` chunks holding time steps first..last (inclusive)."""
        keys = chunk_keys("pr", self.meta["pr/.zarray"], first, last)
        self.bytes += download({self.url + k: self.local / k for k in keys}, self.connections)

    def time_ends(self):
        """First and last time step as dates, and the number of steps (reads two time chunks)."""
        t = zarr.open_array(self.local / "time", mode="r", zarr_format=2)
        attrs = self.meta["time/.zattrs"]
        first, last = cftime.num2date([t[0], t[-1]], attrs["units"], attrs.get("calendar", "standard"))
        return first, last, t.shape[0]

    def years(self, shift_days: int = 0) -> np.ndarray:
        """The calendar year of every time step, in the run's own calendar (needs the whole time array);
        `shift_days` moves stamps that are a day early (see manifest.coverage)."""
        t = zarr.open_array(self.local / "time", mode="r", zarr_format=2)[:]
        attrs = self.meta["time/.zattrs"]
        if shift_days and not attrs["units"].startswith("days"):
            raise ValueError(f"{self.prefix}: a day shift needs time in days, not {attrs['units']}")
        dates = cftime.num2date(t + shift_days, attrs["units"], attrs.get("calendar", "standard"))
        steps = np.diff(cftime.date2num(dates, "days since 1850-01-01", attrs.get("calendar", "standard")))
        if steps.size and not np.allclose(steps, 1):
            raise ValueError(f"{self.prefix}: time steps are not one day apart ({np.unique(steps)[:5]})")
        return np.array([d.year for d in dates])

    def open(self) -> xr.Dataset:
        """The local copy, lazily (chunks=None: plain lazy arrays, no Dask inside a task), times as numbers."""
        return xr.open_zarr(self.local, consolidated=True, zarr_format=2, decode_times=False, chunks=None)

    def remove(self):
        shutil.rmtree(self.local, ignore_errors=True)
