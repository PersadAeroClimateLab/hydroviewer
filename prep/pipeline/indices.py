"""Annual mean precipitation and ten ETCCDI precipitation indices from one year of daily values on the model's
own grid (definitions: http://etccdi.pacificclimate.org/list_27_indices.shtml). Days are those of the run's own
calendar year (360 in a 360_day calendar), so day counts are per that calendar.

- pr       mean daily precipitation, mm/day
- PRCPTOT  total on wet days (>= 1 mm), mm
- SDII     PRCPTOT / number of wet days, mm/day (0 where no day is wet)
- Rx1day   wettest day, mm
- Rx5day   wettest 5 consecutive days, mm (windows inside the year)
- R95p     total on wet days above the 95th percentile of the 1961-1990 wet days, mm
- R99p     the same above the 99th percentile, mm
- R10mm    days >= 10 mm; R20mm days >= 20 mm
- CDD      longest run of dry days (< 1 mm); CWD longest run of wet days (>= 1 mm), cut at the year's ends
"""

import numpy as np

WET = 1.0  # mm/day
NAMES = ["pr", "prcptot", "sdii", "rx1day", "rx5day", "r95p", "r99p", "r10mm", "r20mm", "cdd", "cwd"]


def longest_run(mask: np.ndarray) -> np.ndarray:
    """Per cell, the longest run of True along the first axis."""
    run = np.zeros(mask.shape[1:], "int16")
    best = np.zeros(mask.shape[1:], "int16")
    for day in mask:
        run += 1
        run *= day
        np.maximum(best, run, out=best)
    return best


def annual(days: np.ndarray, p95: np.ndarray, p99: np.ndarray) -> dict[str, np.ndarray]:
    """days (n_days, ...) in mm/day, no NaN; p95, p99 the base-period wet-day percentiles per cell (inf where the
    base period had no wet day). Every index as float32, shape days.shape[1:]."""
    d = np.maximum(days, 0, dtype="float32")  # tiny negative values from some models' numerics
    wet = d >= WET
    n_wet = wet.sum(axis=0)
    on_wet = np.where(wet, d, 0)
    prcptot = on_wet.sum(axis=0, dtype="float64")
    sums = np.cumsum(d, axis=0, dtype="float64")
    five = sums[4:] - np.concatenate([np.zeros((1, *d.shape[1:])), sums[:-5]])
    out = {
        "pr": d.mean(axis=0, dtype="float64"),
        "prcptot": prcptot,
        "sdii": np.divide(prcptot, n_wet, out=np.zeros_like(prcptot), where=n_wet > 0),
        "rx1day": d.max(axis=0),
        "rx5day": five.max(axis=0),
        "r95p": np.where(on_wet > p95, on_wet, 0).sum(axis=0, dtype="float64"),
        "r99p": np.where(on_wet > p99, on_wet, 0).sum(axis=0, dtype="float64"),
        "r10mm": (d >= 10).sum(axis=0),
        "r20mm": (d >= 20).sum(axis=0),
        "cdd": longest_run(~wet),
        "cwd": longest_run(wet),
    }
    return {k: v.astype("float32") for k, v in out.items()}


def wet_percentiles(days: np.ndarray, qs=(95, 99)) -> list[np.ndarray]:
    """Per cell, percentiles (linear interpolation between order statistics) of the wet days among `days`
    (n_days, ...); inf where no day is wet, so no day exceeds them. Sorting one block of cells at a time is the
    caller's business (memory)."""
    x = np.where(days >= WET, days, np.nan).astype("float32")
    x.sort(axis=0)  # NaN (dry days) sort last
    n = np.sum(~np.isnan(x), axis=0)
    out = []
    for q in qs:
        rank = q / 100 * np.maximum(n - 1, 0)
        lo = np.floor(rank).astype("int64")
        hi = np.minimum(lo + 1, np.maximum(n - 1, 0))
        a = np.take_along_axis(x, lo[None], axis=0)[0]
        b = np.take_along_axis(x, hi[None], axis=0)[0]
        value = a + (rank - lo) * (b - a)
        out.append(np.where(n > 0, value, np.inf).astype("float32"))
    return out
