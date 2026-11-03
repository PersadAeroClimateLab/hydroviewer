"""Convert a slice of a CMIP6 precipitation store from the public cmip6-pds bucket into the
hydroviewer map layout (docs/llm/DEV_PLAN.md, section 6), under the same key path.

    prep_cmip6.py CMIP6/CMIP/NOAA-GFDL/GFDL-CM4/historical/r1i1p1f1/Amon/pr/gr1/v20180701 --months 600

Writes <out>/<path>/map.zarr as Zarr v3 with gzip (the only codec the browser decodes
natively). The grid stays native for now (no regridding), but longitude is wrapped to
-180..180 and latitude must run south to north. Also writes a synthetic `uncertainty` field
(lat, lon) for testing globe relief, and <out>/<path>/aggregates.zarr with per-cell statistics
over whole years (see aggregates()). No series layout yet.
"""

import argparse
import re
from pathlib import Path

import numpy as np
import xarray as xr
from zarr.codecs import GzipCodec

SOURCE = "https://cmip6-pds.s3.amazonaws.com"
MONTHS_PER_CHUNK = 12  # one year per chunk: stepping through months within a year costs no extra fetch
KEEP_ATTRS = ["source_id", "experiment_id", "variant_label", "grid_label", "nominal_resolution", "table_id", "version_id"]


def dummy_uncertainty(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """Rough synthetic 0..1 noise for testing globe relief. It is NOT a real uncertainty.

    Fractal noise (power-law spectrum, so rough at every scale) plus a little white noise, skewed so
    most of the surface is low with sharp peaks. Fixed seed, so every run gives the same field.
    Longitude is periodic; towards the poles the noise fades to the zonal mean, so the poles are
    single points.
    """
    rng = np.random.default_rng(7)
    ny, nx = len(lat), len(lon)
    k = np.hypot(np.fft.fftfreq(ny)[:, None], np.fft.fftfreq(nx)[None, :])
    k[0, 0] = 1
    amplitude = k**-1.0
    amplitude[0, 0] = 0
    fractal = np.fft.ifft2(np.fft.fft2(rng.standard_normal((ny, nx))) * amplitude).real
    noise = fractal / fractal.std() + 0.35 * rng.standard_normal((ny, nx))
    u = np.exp(0.8 * noise)  # skew: broad lows, sharp highs
    zonal = u.mean(axis=1, keepdims=True)
    u = zonal + np.cos(np.radians(lat))[:, None] * (u - zonal)
    lo, hi = np.percentile(u, [2, 99.5])
    return np.clip((u - lo) / (hi - lo), 0, 1).astype("float32")


def aggregates(values: np.ndarray, year: int, lat: np.ndarray) -> dict[str, tuple]:
    """Statistics over the whole years in `values` (time, lat, lon), mm/day, as xarray variables.

    Maps are (lat, lon) and carry `display_range` (the colour scale the browser uses as is); series
    are 1D over their own coordinate (`year`, `bin`). All carry `period`. Annual means are plain means
    of the 12 months (not weighted by month length); global means and areas are weighted by cos(lat).
    """
    years = values.shape[0] // 12
    by_year = values[: years * 12].reshape(years, 12, *values.shape[1:])
    period = f"{year}–{year + years - 1}"
    area = np.broadcast_to(np.cos(np.radians(lat))[:, None], values.shape[1:])

    annual = by_year.mean(axis=1)
    trend = (np.polyfit(np.arange(years), annual.reshape(years, -1), 1)[0] * 10).reshape(area.shape)
    r = float(np.percentile(np.abs(trend), 98))  # symmetric, so zero sits in the middle of a diverging scale
    global_mean = (annual * area).sum(axis=(1, 2)) / area.sum()

    wettest = by_year.max(axis=1).mean(axis=0)
    wettest_range = [0.0, float(np.percentile(wettest, 99))]
    edges = np.arange(0, np.ceil(wettest.max()) + 1)  # 1 mm/day bins
    share, _ = np.histogram(wettest, bins=edges, weights=area)

    f32 = lambda a: np.asarray(a, dtype="float32")  # noqa: E731
    return {
        "pr_trend": (
            ("lat", "lon"),
            f32(trend),
            {"units": "mm day-1 decade-1", "long_name": "Precipitation trend", "display_range": [-r, r], "period": period},
        ),
        "pr_wettest_month": (
            ("lat", "lon"),
            f32(wettest),
            {"units": "mm day-1", "long_name": "Mean wettest month", "display_range": wettest_range, "period": period},
        ),
        "pr_global_mean": (
            ("year",),
            f32(global_mean),
            {"units": "mm day-1", "long_name": "Global-mean precipitation", "period": period},
        ),
        # Bars coloured like the wettest-month map, so it shares that map's display range.
        "pr_wettest_month_hist": (
            ("bin",),
            f32(100 * share / area.sum()),
            {"units": "% of area", "long_name": "Area by mean wettest month", "display_range": wettest_range, "period": period},
        ),
        "year": (("year",), np.arange(year, year + years, dtype="int32"), {"long_name": "year"}),
        "bin": (("bin",), f32(edges[:-1]), {"units": "mm day-1", "long_name": "Mean wettest month", "bin_width": 1.0}),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("path", help="CMIP6/<activity>/.../<variable>/<grid>/<version>")
    parser.add_argument("--months", type=int, default=600, help="how many months to keep from the start")
    parser.add_argument("--out", default="/data")
    args = parser.parse_args()

    variable = args.path.rstrip("/").split("/")[-3]
    # trust_env lets aiohttp use HTTP(S)_PROXY, which fsspec ignores by default.
    ds = xr.open_zarr(
        f"{SOURCE}/{args.path}",
        consolidated=True,
        chunks=None,
        decode_times=False,
        storage_options={"client_kwargs": {"trust_env": True}},
    )
    src = ds[variable].isel(time=slice(0, args.months))
    assert src.attrs["units"] == "kg m-2 s-1", f"expected a precipitation flux, got {src.attrs['units']}"

    # Monthly time axis -> integers counted from the first month, so the client needs no calendar.
    time = ds["time"].isel(time=slice(0, args.months)).values
    step_days = np.diff(time) / 24  # hours since the origin
    assert ((step_days >= 28) & (step_days <= 31)).all(), "time axis is not monthly"
    year, month = map(int, re.search(r"since (\d{4})-(\d{2})", ds["time"].attrs["units"]).groups())

    lat, lon = ds["lat"].values, ds["lon"].values
    assert (np.diff(lat) > 0).all(), "latitude must run south to north"
    lon = (lon + 180) % 360 - 180
    west_to_east = np.argsort(lon)

    # 1 kg m-2 of water is 1 mm deep, so kg m-2 s-1 -> mm/day is a factor of 86400.
    values = (src.values.astype("float32") * np.float32(86400))[:, :, west_to_east]
    assert np.isfinite(values).all() and values.max() < 1e19, "unexpected fill values in the data"

    out = xr.Dataset(
        {
            variable: (
                ("time", "lat", "lon"),
                values,
                {
                    "units": "mm day-1",
                    "long_name": src.attrs["long_name"],
                    "standard_name": src.attrs["standard_name"],
                },
            ),
            "uncertainty": (
                ("lat", "lon"),
                dummy_uncertainty(lat, lon[west_to_east]),
                {"units": "1", "long_name": "Dummy uncertainty (synthetic, for relief testing)"},
            ),
        },
        coords={
            "time": ("time", np.arange(len(time), dtype="int32"), {"units": f"months since {year:04d}-{month:02d}-01"}),
            "lat": ("lat", lat, {"units": "degrees_north", "long_name": "latitude"}),
            "lon": ("lon", lon[west_to_east], {"units": "degrees_east", "long_name": "longitude"}),
        },
        attrs={k: ds.attrs[k] for k in KEEP_ATTRS if k in ds.attrs} | {"source": f"{SOURCE}/{args.path}"},
    )

    gzip = [GzipCodec(level=5)]
    dest = Path(args.out) / args.path / "map.zarr"
    out.to_zarr(
        dest,
        mode="w",
        zarr_format=3,
        consolidated=True,
        encoding={
            variable: {"chunks": (MONTHS_PER_CHUNK, out.sizes["lat"], out.sizes["lon"]), "compressors": gzip},
            "uncertainty": {"chunks": (out.sizes["lat"], out.sizes["lon"]), "compressors": gzip},
            "time": {"compressors": gzip},
            "lat": {"compressors": gzip},
            "lon": {"compressors": gzip},
        },
    )
    print(f"wrote {dest}: {variable} {values.shape}, {values.nbytes / 1e6:.0f} MB raw")

    assert month == 1, "aggregates assume the series starts in January"
    stats = aggregates(values, year, lat)
    dest = dest.parent / "aggregates.zarr"
    xr.Dataset(stats, coords={"lat": out["lat"], "lon": out["lon"]}, attrs=out.attrs).to_zarr(
        dest,
        mode="w",
        zarr_format=3,
        consolidated=True,
        encoding={name: {"compressors": gzip} for name in [*stats, "lat", "lon"]},
    )
    print(f"wrote {dest}: {', '.join(stats)} over {stats['pr_trend'][2]['period']}")


if __name__ == "__main__":
    main()
