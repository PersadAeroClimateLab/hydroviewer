"""Conservative regridding (regrid.py). Run in the pipeline image:
    docker compose --profile prep run --rm --entrypoint python pipeline -m unittest discover -s pipeline/tests
"""

import unittest

import numpy as np

import regrid

TARGET_AREA = np.outer(np.diff(np.sin(np.radians(regrid.TARGET_LAT))), np.ones(360))


def area(lat_b, lon_b):
    lat = np.sort(lat_b, axis=1)
    return np.outer(np.sin(np.radians(lat[:, 1])) - np.sin(np.radians(lat[:, 0])), lon_b[:, 1] - lon_b[:, 0])


class Regrid(unittest.TestCase):
    def grid(self, ny, nx, lon0=0.0, north_first=False):
        lat = regrid.edges_from_centres(np.linspace(-90 + 90 / ny, 90 - 90 / ny, ny))
        lon = regrid.edges_from_centres(lon0 + (np.arange(nx) + 0.5) * 360 / nx, period=360)
        return (lat[::-1] if north_first else lat), lon

    def test_keeps_the_area_weighted_total(self):
        # Fails if weights lose or double count area (e.g. the dateline wrap or the poles): totals would differ.
        for ny, nx, lon0, flip in [(64, 128, 0.0, False), (143, 144, -180.0, True), (256, 512, 0.0, False)]:
            lat_b, lon_b = self.grid(ny, nx, lon0, flip)
            field = np.random.default_rng(0).gamma(1.0, 3.0, (ny, nx)).astype("float32")
            out = regrid.apply(regrid.weights(lat_b, lon_b), field)
            src = (field * area(lat_b, lon_b)).sum() / area(lat_b, lon_b).sum()
            dst = (out * TARGET_AREA).sum() / TARGET_AREA.sum()
            self.assertAlmostEqual(float(src), float(dst), delta=1e-4 * float(src), msg=(ny, nx, lon0, flip))

    def test_places_values_where_they_are(self):
        # Fails if longitudes are shifted or latitudes flipped: a 2-degree source cell must land on its own four
        # 1-degree cells (here the cell 10..12 E, 30..32 N, on a 0..360 grid, read on the -180..180 target).
        lat_b = np.stack([np.arange(-90, 90, 2), np.arange(-88, 92, 2)], axis=1).astype(float)
        lon_b = np.stack([np.arange(0, 360, 2), np.arange(2, 362, 2)], axis=1).astype(float)
        field = np.zeros((90, 180), "float32")
        field[60, 5] = 1  # lat 30..32, lon 10..12
        field[44, 175] = 2  # lat -2..0, lon 350..352, i.e. -10..-8
        out = regrid.apply(regrid.weights(lat_b, lon_b), field)
        self.assertTrue(np.allclose(out[120:122, 190:192], 1) and np.isclose(out.sum(), 4 + 8))
        self.assertTrue(np.allclose(out[88:90, 170:172], 2))


if __name__ == "__main__":
    unittest.main()
