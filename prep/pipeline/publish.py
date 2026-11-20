"""Stages 2 and 3: from the members' work stores to the bucket, in the mock's layout (bucket.py): per model and
scenario a map store for every member (1950-2014 from its historical run, 2015-2100 from the scenario) and the
ensemble store (mean, agreement, spread); per scenario the multi-model store; members.zarr; catalog.json.
Bit-rounded before writing (`keepbits`), gzip, one year per chunk.

Also checks each member's seam: the jump in global-mean precipitation from 2010-2014 to 2015-2019, in units of
its year-to-year standard deviation, logged and kept in the member store's attributes (some EC-Earth scenario runs
name historical r1i1p1f1 as their parent instead of their own member).
"""

import time
from pathlib import Path

import numpy as np
import xarray as xr

from bucket import METRICS, SCENARIOS, YEARS, Spread, member_variables, statistics, write
from members import run_dir


def about(manifest_sha: str) -> dict:
    return {
        "title": "hydroviewer: CMIP6 daily precipitation reduced to annual ETCCDI indices on a 1 degree grid",
        "source": "cmip6-pds (AWS open data), prep/pipeline",
        "manifest_sha256": manifest_sha,
        "regridding": "first-order conservative, indices computed on the native grid first",
        "calendar_note": "years and day counts in each model's own calendar",
    }


def values(work: Path, member: dict, ssp: str) -> dict[str, np.ndarray]:
    """One member run, 1950-2100, (year, lat, lon) per metric. Opened without Dask (chunks=None): Dask arrays
    computed inside a Dask task hand their work back to the cluster, and the worker starts its next task in the
    meantime, so a worker ran all its queued ensembles at once."""
    d = run_dir(work, member)
    with xr.open_zarr(d / "historical.zarr", consolidated=False, chunks=None) as h, xr.open_zarr(d / f"{ssp}.zarr", consolidated=False, chunks=None) as s:
        out = {m[0]: np.concatenate([h[m[0]].values, s[m[0]].values]) for m in METRICS}
    assert next(iter(out.values())).shape[0] == len(YEARS)
    return out


def seam(series: np.ndarray) -> float:
    """Jump at 2014/2015 in global-mean pr, in year-to-year standard deviations (1950-2014)."""
    hist = series[YEARS <= 2014]
    sd = np.std(np.diff(hist)) / np.sqrt(2) or 1.0
    return float((series[(YEARS >= 2015) & (YEARS <= 2019)].mean() - series[(YEARS >= 2010) & (YEARS <= 2014)].mean()) / sd)


def ensemble(out: Path, work: Path, run: dict, members: dict, keepbits: int, info: dict) -> dict:
    """One model and scenario: each member's map store and the ensemble store. Returns every member's global
    mean per metric (member, year) and the seams."""
    started = time.time()
    spreads = {m[0]: Spread() for m in METRICS}
    series = {m[0]: [] for m in METRICS}
    seams = {}
    for member in run["members"]:
        v = values(work, members[(run["model"], member)], run["scenario"])
        variables, means = member_variables(v)
        for id, x in v.items():
            spreads[id].add(x)
            series[id].append(means[id])
        seams[member] = round(seam(means["pr"]), 2)
        node = dict(scenario=run["scenario"], model=run["model"], member=member, seam_sd=seams[member])
        write(out / run["store"].format(member=member), variables, info, keepbits, **node)
    by = f"{len(run['members'])} members"
    write(out / run["ensemble"], statistics(spreads, by), info, keepbits, scenario=run["scenario"], model=run["model"])
    return {"series": {k: np.stack(v) for k, v in series.items()}, "seams": seams, "seconds": round(time.time() - started, 1)}


def runs(members: list[dict]) -> list[dict]:
    """Catalog runs (model x scenario) in scenario then manifest order; every kept member has maps."""
    out = []
    for ssp, _ in SCENARIOS:
        seen = {}
        for m in members:
            if ssp in m["scenarios"]:
                seen.setdefault(m["model"], (m["institution"], []))[1].append(m["member"])
        for model, (institution, ids) in seen.items():
            base = f"CMIP6/ScenarioMIP/{institution}/{model}/{ssp}"
            out.append({
                "scenario": ssp, "model": model, "institution": institution, "members": ids, "maps": ids,
                "store": f"{base}/{{member}}/annual.zarr", "ensemble": f"{base}/ensemble/annual.zarr",
            })
    return out
