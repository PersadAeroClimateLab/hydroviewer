"""ETCCDI indices on hand-made daily series (indices.py)."""

import unittest

import numpy as np

import indices


def series(values):
    return np.array(values, "float32")[:, None, None]


class Indices(unittest.TestCase):
    def test_hand_made_year(self):
        # Fails if a definition drifts from ETCCDI's: wet days are >= 1 mm, runs are the longest ones, R95p only
        # counts wet days above the base percentile. 10 days: 0, 0.5, 2, 12, 25, 0, 0, 0, 3, 1.
        d = series([0, 0.5, 2, 12, 25, 0, 0, 0, 3, 1])
        p95, p99 = np.full((1, 1), 11, "float32"), np.full((1, 1), 24, "float32")
        got = {k: float(v[0, 0]) for k, v in indices.annual(d, p95, p99).items()}
        expected = {
            "pr": 4.35, "prcptot": 43, "sdii": 43 / 5, "rx1day": 25, "rx5day": 39.5, "r95p": 37, "r99p": 25,
            "r10mm": 2, "r20mm": 1, "cdd": 3, "cwd": 3,
        }
        for k, v in expected.items():
            self.assertAlmostEqual(got[k], v, places=4, msg=k)

    def test_dry_cell_has_no_nan(self):
        # Fails if a cell without wet days gives NaN (SDII) or exceeds an infinite percentile.
        d = series([0.2] * 30)
        p95, p99 = indices.wet_percentiles(d)
        got = indices.annual(d, p95, p99)
        self.assertTrue(all(np.isfinite(v).all() for v in got.values()))
        self.assertEqual(float(got["sdii"][0, 0]), 0)
        self.assertEqual(float(got["cdd"][0, 0]), 30)

    def test_percentiles_of_wet_days_only(self):
        # Fails if dry days enter the percentile: wet days 1..100 (and 50 dry days) give numpy's linear 95th, 99th.
        wet = np.arange(1, 101, dtype="float32")
        d = series(np.concatenate([wet, np.zeros(50)]))
        p95, p99 = indices.wet_percentiles(d)
        self.assertAlmostEqual(float(p95[0, 0]), float(np.percentile(wet, 95)), places=4)
        self.assertAlmostEqual(float(p99[0, 0]), float(np.percentile(wet, 99)), places=4)


if __name__ == "__main__":
    unittest.main()
