"""Build src/assets/coastlines.json from Natural Earth 110m coastlines (public domain).

    docker compose --profile prep run --rm --entrypoint python \\
        -v "$PWD/src/assets:/assets" prep make_coastlines.py /assets/coastlines.json

Output is a list of polylines, each a flat [lon, lat, lon, lat, ...] list. Lines are densified
to steps of at most 1 degree so they follow the curve of the globe, and rounded to 2 decimals.
Standard library only.
"""

import json
import math
import sys
import urllib.request

# Pinned to a release tag so the output is reproducible.
SOURCE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_110m_coastline.geojson"
MAX_STEP = 1.0


def densify(line: list[list[float]]) -> list[float]:
    out = [line[0][0], line[0][1]]
    for (lon0, lat0), (lon1, lat1) in zip(line, line[1:]):
        n = max(1, math.ceil(max(abs(lon1 - lon0), abs(lat1 - lat0)) / MAX_STEP))
        for i in range(1, n + 1):
            out += [lon0 + (lon1 - lon0) * i / n, lat0 + (lat1 - lat0) * i / n]
    return [round(v, 2) for v in out]


def main() -> None:
    dest = sys.argv[1]
    with urllib.request.urlopen(SOURCE, timeout=60) as response:
        features = json.load(response)["features"]
    lines = [densify(f["geometry"]["coordinates"]) for f in features if f["geometry"]["type"] == "LineString"]
    # Natural Earth cuts lines at the antimeridian; a jump across it would draw a line across the map.
    assert all(abs(a - b) <= 180 for line in lines for a, b in zip(line[0::2], line[2::2])), "line crosses the antimeridian"
    with open(dest, "w") as f:
        json.dump(lines, f, separators=(",", ":"))
    print(f"wrote {dest}: {len(lines)} lines, {sum(len(line) // 2 for line in lines)} points")


if __name__ == "__main__":
    main()
