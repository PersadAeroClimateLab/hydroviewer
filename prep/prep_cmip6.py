"""Convert a slice of a CMIP6 precipitation store from the public cmip6-pds bucket into the
hydroviewer map layout (docs/llm/DEV_PLAN.md, section 6), under the same key path.

    prep_cmip6.py CMIP6/CMIP/NOAA-GFDL/GFDL-CM4/historical/r1i1p1f1/Amon/pr/gr1/v20180701 --months 600

Writes <out>/<path>/map.zarr as Zarr v3 with gzip (the only codec the browser decodes
natively). The grid stays native for now (no regridding), but longitude is wrapped to
-180..180 and latitude must run south to north. Also writes a synthetic `uncertainty` field
(lat, lon) for testing globe relief. No series layout or aggregates yet.
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


if __name__ == "__main__":
    main()
