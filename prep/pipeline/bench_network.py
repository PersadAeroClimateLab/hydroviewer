"""Download rate from cmip6-pds against the number of concurrent connections, to size --workers x --connections
on a new machine before the long run (whole `pr` chunk objects of EC-Earth3 scenario runs, counted, not written;
each trial uses fresh objects and is measured after a 5 s ramp).

    python bench_network.py [connections ...]        default: 1 4 16 64 256
"""

import asyncio
import json
import sys
import time
from pathlib import Path

import aiohttp

from source import BUCKET, chunk_keys, prefix

RAMP, WINDOW = 5, 40


async def main(trials: list[int]):
    runs = json.loads((Path(__file__).parent / "runs.json").read_text())
    stores = [m["scenarios"][s] for m in runs["members"] if m["model"] in ("EC-Earth3", "EC-Earth3-Veg") for s in sorted(m["scenarios"])]
    timeout = aiohttp.ClientTimeout(total=None, sock_connect=60, sock_read=120)
    async with aiohttp.ClientSession(timeout=timeout, connector=aiohttp.TCPConnector(limit=0), trust_env=True) as session:
        urls = []
        for z in stores:
            url = BUCKET + prefix(z)
            async with session.get(url + ".zmetadata") as r:
                urls += [url + k for k in chunk_keys("pr", json.loads(await r.read())["metadata"]["pr/.zarray"])]
            if len(urls) > 40 * sum(trials):
                break
        queue = iter(urls)
        for n in trials:
            counted, start = [0], time.time()

            async def stream():
                for url in queue:
                    async with session.get(url) as r:
                        r.raise_for_status()
                        async for block in r.content.iter_chunked(1 << 20):
                            if time.time() - start > RAMP:
                                counted[0] += len(block)

            workers = [asyncio.create_task(stream()) for _ in range(n)]
            await asyncio.sleep(RAMP + WINDOW)
            for w in workers:
                w.cancel()
            await asyncio.gather(*workers, return_exceptions=True)
            rate = counted[0] / WINDOW
            print(f"connections {n:4d}: {rate / 1e6:7.1f} MB/s ({rate * 8 / 1e9:.2f} Gbit/s)", flush=True)


if __name__ == "__main__":
    asyncio.run(main([int(n) for n in sys.argv[1:]] or [1, 4, 16, 64, 256]))
