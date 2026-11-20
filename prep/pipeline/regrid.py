"""First-order conservative regridding from a rectilinear lat/lon grid to the app's 1° grid (360 x 180,
cell-centred, longitude -180..180 west to east, latitude south to north).

On a rectilinear grid a cell's area is (sin of its north edge - sin of its south edge) x (its longitude width),
so the overlap of a source and a target cell is a latitude overlap (in sin(lat)) times a longitude overlap. The
weights therefore separate into two small dense matrices, and a field is regridded as W_lat @ field @ W_lon.T,
each row normalised to sum to one: every target cell is the area-weighted mean of the source cells under it, and
area-weighted totals are kept. No ESMF needed; grids that are not rectilinear (1-D lat and lon) are refused.
"""

import numpy as np

TARGET_LAT = np.arange(-90.0, 91.0)  # edges
TARGET_LON = np.arange(-180.0, 181.0)


def edges_from_centres(centres: np.ndarray, period: float | None = None) -> np.ndarray:
    """(n, 2) cell bounds halfway between centres; the ends extend by half a step (clamped to the poles)."""
    c = np.asarray(centres, dtype="float64")
    mid = (c[1:] + c[:-1]) / 2
    lo = np.concatenate([[c[0] - (mid[0] - c[0])], mid])
    hi = np.concatenate([mid, [c[-1] + (c[-1] - mid[-1])]])
    bounds = np.stack([lo, hi], axis=1)
    return bounds if period else np.clip(bounds, -90, 90)


def _overlap(src: np.ndarray, dst: np.ndarray, shifts=(0.0,)) -> np.ndarray:
    """(n_dst, n_src) lengths of overlap between intervals, each (n, 2) with lo < hi; source intervals are also
    tried shifted by each of `shifts` (for longitude, whole turns)."""
    out = np.zeros((len(dst), len(src)))
    for shift in shifts:
        lo = np.maximum(dst[:, None, 0], src[None, :, 0] + shift)
        hi = np.minimum(dst[:, None, 1], src[None, :, 1] + shift)
        out += np.maximum(0, hi - lo)
    return out


def _normalise(w: np.ndarray) -> np.ndarray:
    total = w.sum(axis=1, keepdims=True)
    if np.any(total <= 0):
        raise ValueError("a target cell has no source cell under it")
    return w / total


def weights(lat_bounds: np.ndarray, lon_bounds: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """W_lat (180, n_lat) and W_lon (360, n_lon) from the source's cell bounds, each (n, 2) in degrees, in any
    order and any longitude convention (0..360 or -180..180)."""
    lat = np.sort(np.clip(np.asarray(lat_bounds, "float64"), -90, 90), axis=1)
    src_lat = np.sin(np.radians(lat))
    dst_lat = np.sin(np.radians(np.stack([TARGET_LAT[:-1], TARGET_LAT[1:]], axis=1)))
    w_lat = _normalise(_overlap(src_lat, dst_lat))

    lon = np.asarray(lon_bounds, "float64").copy()
    lon[:, 1] = np.where(lon[:, 1] <= lon[:, 0], lon[:, 1] + 360, lon[:, 1])  # a cell across the wrap
    lon -= 360 * np.floor(lon[:, :1] / 360)  # lower edges into 0..360
    dst_lon = np.stack([TARGET_LON[:-1], TARGET_LON[1:]], axis=1)
    w_lon = _normalise(_overlap(lon, dst_lon, shifts=(-720.0, -360.0, 0.0, 360.0)))
    widths = lon[:, 1] - lon[:, 0]
    if not np.isclose(widths.sum(), 360, atol=1e-3):
        raise ValueError(f"source longitudes cover {widths.sum():.3f} degrees, not 360")
    return w_lat.astype("float32"), w_lon.astype("float32")


def apply(w: tuple[np.ndarray, np.ndarray], field: np.ndarray) -> np.ndarray:
    """A (n_lat, n_lon) field on the 1° grid, (180, 360) float32."""
    w_lat, w_lon = w
    return (w_lat @ field.astype("float32") @ w_lon.T).astype("float32")
