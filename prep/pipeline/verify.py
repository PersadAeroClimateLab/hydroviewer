"""Stage 4: checks the published bucket and lists every object's checksum (SHA256SUMS), so a rebuild elsewhere can
be compared with this one and an upload checked against it.

Per store in catalog.json: it opens; years are 1950-2100 on the 360 x 180 grid; every metric (and for aggregates
its agreement and spread) is there, finite, and not all zero.
"""

import hashlib
from pathlib import Path

import numpy as np
import xarray as xr

from bucket import LAT, LON, METRICS, YEARS


def stores(catalog: dict) -> list[tuple[str, bool]]:
    """(store path, is an aggregate) for every store the catalog lists."""
    out = []
    for run in catalog["runs"]:
        out += [(run["store"].format(member=m), False) for m in run["maps"]]
        out.append((run["ensemble"], True))
    out += [(m["store"], True) for m in catalog["multimodel"].values()]
    return out


def check(root: Path, path: str, aggregate: bool) -> list[str]:
    problems = []
    try:
        ds = xr.open_zarr(root / path, consolidated=True, chunks=None)
    except Exception as error:  # noqa: BLE001
        return [f"{path}: does not open ({error!r})"]
    if not (np.array_equal(ds.year.values, YEARS) and ds.sizes.get("lat") == len(LAT) and ds.sizes.get("lon") == len(LON)):
        problems.append(f"{path}: coordinates {dict(ds.sizes)}")
    names = [m[0] for m in METRICS]
    if aggregate:
        names += [f"{n}_{s}" for n in names for s in ("agreement", "spread")]
    for name in names:
        if name not in ds:
            problems.append(f"{path}: no {name}")
            continue
        v = ds[name].values
        if not np.isfinite(v).all():
            problems.append(f"{path}: {name} has {int((~np.isfinite(v)).sum())} non-finite values")
        if name in [m[0] for m in METRICS] and not v.any():
            problems.append(f"{path}: {name} is all zero")
    return problems


def checksum(root: Path, files: list[Path]) -> list[str]:
    lines = []
    for f in files:
        h = hashlib.sha256()
        with open(f, "rb") as fh:
            for block in iter(lambda: fh.read(1 << 20), b""):
                h.update(block)
        lines.append(f"{h.hexdigest()}  {f.relative_to(root)}")
    return lines
