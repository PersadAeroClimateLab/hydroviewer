"""Stage 0: which source stores to read, resolved once into runs.json (committed), so every later build reads the
same stores even if the mirror changes (docs/llm/DATA_VOLUME.md section 4b, docs/llm/PREP_PIPELINE_PLAN.md).

Rules: daily `pr` of the chosen models; the latest version of each (model, experiment, member, grid); a member
is kept for a scenario when its historical store covers 1950-2014 and its scenario store 2015-2100 without gaps,
on one grid; per model and scenario the first `max_members` members in variant then realisation order (natural(): r1..r10 of
i1p1f1 before r1i1p2f1), so the same ids recur across scenarios and share their historical run.
"""

import hashlib
import json
import re
import tempfile
import time
import urllib.request
from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd

from members import HISTORICAL, SCENARIO
from source import BUCKET, Store

CATALOGUE = BUCKET + "pangeo-cmip6.csv"
SCENARIOS = ["ssp126", "ssp245", "ssp370", "ssp585"]
# DATA_VOLUME.md section 4b: the models with daily pr in all four scenarios and the most complete members, with
# CESM2 for MPI-ESM1-2-HR and KACE-1-0-G for MRI-ESM2-0 (decided 2026-11-19).
MODELS = ["CanESM5", "MPI-ESM1-2-LR", "EC-Earth3", "UKESM1-0-LL", "MIROC6", "IPSL-CM6A-LR", "EC-Earth3-Veg", "ACCESS-CM2", "CESM2", "KACE-1-0-G"]


def natural(member: str) -> tuple:
    """Order of members: by variant first (physics p, forcing f, initialisation i), then realisation r, so an
    ensemble takes r1, r2, ... of one variant before another (CanESM5's p2 runs are another physics version)."""
    r, i, p, f = (int(x) for x in re.findall(r"\d+", member))
    return (p, f, i, r)


def catalogue(work: Path) -> pd.DataFrame:
    path = work / "pangeo-cmip6.csv"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(CATALOGUE, path)
    return pd.read_csv(path, dtype=str)


def coverage(zstore: str, window: tuple[int, int], scratch: Path) -> dict:
    """Whether a store covers the window's years without gaps, from its first and last time chunks.

    A few stores (EC-Earth3 historical r11, r15) are stamped one day early ("days since 1849-12-31 12:00", so a
    1850-2014 run reads 1849-12-31 to 2014-12-30): when the first stamp is a year's last day, the run is taken as
    starting the day after (`shift_days` 1, applied when its years are read), and recorded in the manifest.
    """
    with tempfile.TemporaryDirectory(dir=scratch) as tmp:
        store = Store(zstore, Path(tmp), connections=2)
        meta = store.metadata()
        store.fetch_small(only=["time"], ends=True)
        first, last, n = store.time_ends()
        attrs = meta.get(".zattrs", {})
        calendar = meta["time/.zattrs"].get("calendar", "standard")
        shift = 1 if (first + timedelta(days=1)).timetuple()[1:3] == (1, 1) else 0
        first, last = first + timedelta(days=shift), last + timedelta(days=shift)
        # Contiguous daily steps: as many steps as days from the first to the last.
        days = (last - first).days + 1
        covers = (first.year, first.month, first.day) <= (window[0], 1, 1) and (last.year, last.month, last.day) >= (window[1], 12, 30 if calendar == "360_day" else 31)
        return {
            "covers": bool(covers and days == n), "first": str(first)[:10], "last": str(last)[:10], "steps": n, "contiguous": days == n,
            "shift_days": shift, "shape": meta["pr/.zarray"]["shape"][1:], "calendar": calendar, "units": meta["pr/.zattrs"].get("units"),
            "parent": attrs.get("parent_variant_label"), "metadata_sha256": hashlib.sha256(json.dumps(meta, sort_keys=True).encode()).hexdigest()[:16],
        }


def build(work: Path, path: Path, models: list[str], max_members: int, workers: int = 32) -> dict:
    started = time.time()
    df = catalogue(work)
    df = df[(df.table_id == "day") & (df.variable_id == "pr") & df.source_id.isin(models) & df.experiment_id.isin(["historical", *SCENARIOS])]
    # Every version is checked; the latest one covering the window is used (a run's newest version can be an
    # extension, e.g. ACCESS-CM2 ssp585 r1 2251-2300).
    df = df.sort_values("version")

    scratch = work / "scratch" / "manifest"
    scratch.mkdir(parents=True, exist_ok=True)
    rows = df.to_dict("records")
    windows = [HISTORICAL if r["experiment_id"] == "historical" else SCENARIO for r in rows]

    def check(args):
        row, window = args
        try:
            return coverage(row["zstore"], window, scratch)
        except Exception as error:  # noqa: BLE001 - a store that cannot be read is simply not used
            return {"covers": False, "error": repr(error)[:200]}

    with ThreadPoolExecutor(workers) as pool:
        checks = list(pool.map(check, zip(rows, windows)))
    for row, c in zip(rows, checks):
        row["check"] = c

    complete = {(r["source_id"], r["experiment_id"], r["member_id"], r["grid_label"]): r for r in rows if r["check"]["covers"]}  # latest wins
    members, skipped = {}, [
        {"store": r["zstore"], **{k: r["check"].get(k) for k in ("first", "last", "steps", "contiguous", "error")}}
        for r in rows
        if not r["check"]["covers"] and (r["source_id"], r["experiment_id"], r["member_id"], r["grid_label"]) not in complete
    ]
    for model in models:
        for ssp in SCENARIOS:
            candidates = []
            for (m, e, member, grid), r in complete.items():
                h = complete.get((m, "historical", member, grid))
                if m == model and e == ssp and h and h["check"]["shape"] == r["check"]["shape"]:
                    candidates.append((natural(member), member, grid, r, h))
            for _, member, grid, r, h in sorted(candidates)[:max_members]:
                entry = members.setdefault((model, member), {
                    "model": model, "institution": h["institution_id"], "member": member, "grid": grid,
                    "historical": h["zstore"], "shape": h["check"]["shape"], "calendar": h["check"]["calendar"], "scenarios": {}, "parents": {},
                    "shift_days": {h["zstore"]: 1} if h["check"]["shift_days"] else {},
                })
                entry["scenarios"][ssp] = r["zstore"]
                entry["parents"][ssp] = r["check"]["parent"]
                if r["check"]["shift_days"]:
                    entry["shift_days"][r["zstore"]] = r["check"]["shift_days"]

    out = sorted(members.values(), key=lambda m: (models.index(m["model"]), natural(m["member"])))
    manifest = {
        "about": "Source stores for the Hydroviewer bucket; written by prep/pipeline (manifest.py), read by every later stage.",
        "catalogue": CATALOGUE,
        "rules": {"historical": HISTORICAL, "scenario": SCENARIO, "max_members": max_members, "models": models},
        "counts": {
            "members": len(out),
            "scenario_runs": sum(len(m["scenarios"]) for m in out),
            **{ssp: sum(ssp in m["scenarios"] for m in out) for ssp in SCENARIOS},
        },
        "members": out,
        "incomplete": skipped,
    }
    path.write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"manifest: {manifest['counts']} from {len(rows)} stores checked ({len(skipped)} incomplete) in {time.time() - started:.0f} s -> {path}")
    return manifest


def load(path: Path, models: list[str] | None = None, max_members: int | None = None) -> list[dict]:
    """The manifest's members, optionally only some models and the first `max_members` per model and scenario
    (for a test run)."""
    members = json.loads(path.read_text())["members"]
    if models:
        members = [m for m in members if m["model"] in models]
    if max_members:
        kept = []
        for m in members:
            scenarios = {s: z for s, z in m["scenarios"].items() if sum(1 for k in kept if k["model"] == m["model"] and s in k["scenarios"]) < max_members}
            if scenarios:
                kept.append(m | {"scenarios": scenarios})
        members = kept
    return members


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

