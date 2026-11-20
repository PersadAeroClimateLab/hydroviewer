"""Hydroviewer prep pipeline: CMIP6 daily precipitation from the public cmip6-pds bucket to the app's bucket
(docs/llm/PREP_PIPELINE_PLAN.md). One-time and reproducible: runs.json (committed) fixes the source stores, the
image fixes the code and libraries.

    run.py select                     resolve runs.json from the catalogue (only to change the selection)
    run.py members   [options]        daily -> annual metrics per member (/work/runs), the long, network-bound part
    run.py publish   [options]        ensembles, multi-model means, bit-rounding, catalog.json (into /data)
    run.py verify                     check /data and write /data/SHA256SUMS
    run.py all       [options]        members, publish, verify

Every stage skips what is done, so rerunning after an interruption resumes. A test run on a slice:
    run.py all --models CanESM5 --max-members 2
"""

import argparse
import json
import logging
import os
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]  # this directory and bucket.py's

import manifest  # noqa: E402
import members as tasks  # noqa: E402
import publish  # noqa: E402
import verify  # noqa: E402
from bucket import SCENARIOS, finish, multimodel  # noqa: E402

MANIFEST = HERE / "runs.json"


def client(args, workers: int, memory: str):
    from dask.distributed import Client, LocalCluster

    from distributed.diagnostics.plugin import WorkerPlugin

    class Quiet(WorkerPlugin):
        """numpy's freed memory often stays with the process ("unmanaged"); Dask warns about it every few seconds
        per worker, which buries the progress lines. A plugin, so restarted workers are quiet too; restarts for
        memory (the nanny's warnings) still show."""

        def setup(self, worker):
            logging.getLogger("distributed.worker.memory").setLevel(logging.ERROR)

    cluster = LocalCluster(
        n_workers=workers, threads_per_worker=1, processes=True, memory_limit=memory,
        dashboard_address=":8787", local_directory=str(args.scratch / "dask"),
    )
    c = Client(cluster)
    c.register_plugin(Quiet())
    print(f"dask: {workers} workers x {memory}, dashboard on port 8787 (publish it with -p 8787:8787 to watch)")
    return c


def wait(futures: dict, log: Path) -> list[str]:
    """Logs each task as it finishes (with the bytes and time so far); returns the failures."""
    from dask.distributed import as_completed

    started, total, failed, n = time.time(), 0, [], 0
    for future in as_completed(list(futures)):
        n += 1
        name = futures[future]
        if future.status == "error":
            error = future.exception()
            failed.append(f"{name}: {error!r}")
            print(f"[{n}/{len(futures)}] FAILED {name}: {error!r}", flush=True)
            tasks.report([{"task": name, "error": repr(error)}], log)
            continue
        result = future.result()
        total += result.get("bytes_read", 0)
        tasks.report([result], log)
        rate = total / max(1, time.time() - started) / 1e6
        state = "skipped (done)" if result.get("skipped") else f"{result.get('bytes_read', 0) / 1e9:.1f} GB in {result.get('seconds')} s"
        print(f"[{n}/{len(futures)}] {name}: {state}; {total / 1e9:.0f} GB so far, {rate:.0f} MB/s", flush=True)
    return failed


def stage_members(args, c) -> list[str]:
    members = manifest.load(args.manifest, args.models, args.max_members)
    futures = {}
    for m in members:
        size = m["shape"][0] * m["shape"][1]  # big grids first: the long tasks should not start last
        h = c.submit(tasks.historical, m, args.work, args.scratch, args.connections, key=f"historical-{m['model']}-{m['member']}", priority=size + 1, retries=1)
        futures[h] = f"{m['model']}/{m['member']}/historical"
        for ssp in m["scenarios"]:
            f = c.submit(tasks.scenario, m, ssp, args.work, args.scratch, args.connections, h, key=f"{ssp}-{m['model']}-{m['member']}", priority=size, retries=1)
            futures[f] = f"{m['model']}/{m['member']}/{ssp}"
    print(f"members: {len(members)} members, {len(futures)} tasks")
    return wait(futures, args.work / "log.jsonl")


def stage_publish(args, c) -> list[str]:
    out = args.data
    catalog_path = out / "catalog.json"
    if catalog_path.exists() and json.loads(catalog_path.read_text()).get("mock"):
        raise SystemExit(f"{out} holds the mock; publish into another data directory")
    members = manifest.load(args.manifest, args.models, args.max_members)
    # Only member runs whose work is complete; a missing one leaves its ensemble smaller and is reported.
    missing = [f"{m['model']}/{m['member']}/{s}" for m in members for s in m["scenarios"] if not (tasks.done(args.work, m, "historical") and tasks.done(args.work, m, s))]
    members = [m | {"scenarios": {s: z for s, z in m["scenarios"].items() if f"{m['model']}/{m['member']}/{s}" not in missing}} for m in members]
    if missing:
        print(f"publish: {len(missing)} member runs not done, left out: {missing[:10]}{' ...' if len(missing) > 10 else ''}")
    runs = publish.runs(members)
    index = {(m["model"], m["member"]): m for m in members}
    info = publish.about(manifest.digest(args.manifest))
    for old in ["CMIP6", "members.zarr", "catalog.json", "SHA256SUMS"]:
        p = out / old
        shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)

    futures = {c.submit(publish.ensemble, out, args.work, r, index, args.keepbits, info, key=f"ensemble-{r['model']}-{r['scenario']}", priority=len(r["members"])): r for r in runs}
    from dask.distributed import wait as dask_wait

    dask_wait(list(futures))
    failed = [f"{r['model']}/{r['scenario']}: {f.exception()!r}" for f, r in futures.items() if f.status == "error"]
    if failed:
        return failed
    results = {id(r): f.result() for f, r in futures.items()}
    seams = {f"{r['model']}/{r['scenario']}/{m}": s for r in runs for m, s in results[id(r)]["seams"].items()}
    flagged = {k: v for k, v in seams.items() if abs(v) > 3}
    print(f"publish: {len(runs)} ensembles written; seams beyond 3 sd at 2014/2015: {flagged or 'none'}")
    (args.work / "seams.json").write_text(json.dumps(seams, indent=1) + "\n")

    multi = {}
    for ssp, _ in SCENARIOS:
        stores = [r["ensemble"] for r in runs if r["scenario"] == ssp]
        if stores:
            multi[ssp] = {"store": f"CMIP6/ScenarioMIP/multimodel/{ssp}/annual.zarr", "models": len(stores)}
    mm = [c.submit(multimodel, out, ssp, [r["ensemble"] for r in runs if r["scenario"] == ssp], m["store"], info, args.keepbits, key=f"multimodel-{ssp}") for ssp, m in multi.items()]
    dask_wait(mm)
    failed = [repr(f.exception()) for f in mm if f.status == "error"]
    if failed:
        return failed
    # No build date: a rebuild elsewhere should give the same bytes (SHA256SUMS).
    source = {"manifest_sha256": info["manifest_sha256"], "keepbits": args.keepbits}
    rows = finish(out, runs, [results[id(r)]["series"] for r in runs], multi, {"mock": False, "source": source})
    print(f"publish: {len(runs)} model-scenario runs, {rows} member runs into {out}")
    return []


def stage_verify(args, c) -> list[str]:
    out = args.data
    catalog = json.loads((out / "catalog.json").read_text())
    paths, aggregate = zip(*verify.stores(catalog))
    problems = sum(c.gather(c.map(verify.check, [out] * len(paths), paths, aggregate, pure=False)), [])
    files = sorted(p for p in out.rglob("*") if p.is_file() and p.name != "SHA256SUMS")
    groups = [files[i::args.workers] for i in range(args.workers)]
    lines = sorted(sum(c.gather(c.map(verify.checksum, [out] * len(groups), groups, pure=False)), []), key=lambda l: l[66:])
    (out / "SHA256SUMS").write_text("\n".join(lines) + "\n")
    size = sum(f.stat().st_size for f in files)
    print(f"verify: {len(verify.stores(catalog))} stores, {len(files)} files, {size / 1e9:.1f} GB; {len(problems)} problems")
    for p in problems[:50]:
        print("  ", p)
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("stage", choices=["select", "members", "publish", "verify", "all"])
    parser.add_argument("--work", type=Path, default=Path("/work"), help="work directory (53 GB of runs for the full set, plus scratch)")
    parser.add_argument("--data", type=Path, default=Path("/data"), help="the bucket root to publish into")
    parser.add_argument("--scratch", type=Path, help="source copies in flight (default WORK/scratch; up to ~16 GB per worker)")
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--workers", type=int, default=os.process_cpu_count(), help="Dask worker processes (default: the cores this process may use, e.g. a batch allocation)")
    parser.add_argument("--memory", default="6GB", help="memory limit per worker (members, verify)")
    parser.add_argument("--publish-workers", type=int, default=min(16, os.process_cpu_count() or 1), help="workers for publish (40 ensembles)")
    parser.add_argument("--publish-memory", default="6GB", help="memory limit per publish worker")
    parser.add_argument("--connections", type=int, default=8, help="concurrent downloads per task")
    parser.add_argument("--keepbits", type=int, default=7, help="mantissa bits kept when publishing (23 = no rounding)")
    parser.add_argument("--models", nargs="*", help="only these models (a test run)")
    parser.add_argument("--max-members", type=int, help="only the first N members per model and scenario (a test run)")
    parser.add_argument("--select-members", type=int, default=10, help="select: members per model and scenario")
    args = parser.parse_args()
    args.scratch = args.scratch or args.work / "scratch"
    args.scratch.mkdir(parents=True, exist_ok=True)
    args.data.mkdir(parents=True, exist_ok=True)
    started = time.time()

    if args.stage == "select":
        manifest.build(args.work, args.manifest, args.models or manifest.MODELS, args.select_members)
        return
    if not args.manifest.exists():
        raise SystemExit(f"no manifest at {args.manifest}; run the select stage first")
    stages = {"members": [stage_members], "publish": [stage_publish], "verify": [stage_verify], "all": [stage_members, stage_publish, stage_verify]}[args.stage]
    for stage in stages:
        # A cluster per stage: publish tasks hold a model's whole ensemble statistics (~3 GB, more after a few
        # tasks in one worker), member tasks ~2 GB and there are many more of them.
        sized = (args.publish_workers, args.publish_memory) if stage is stage_publish else (args.workers, args.memory)
        with client(args, *sized) as c:
            failed = stage(args, c)
            c.close()  # first, so the scheduler does not warn about the client's results as the workers go
            c.cluster.close()
        if failed:
            print(f"{stage.__name__}: {len(failed)} failures (see {args.work / 'log.jsonl'}); stopping")
            for f in failed[:20]:
                print("  ", f)
            sys.exit(1)
    print(f"done in {(time.time() - started) / 3600:.2f} h")


if __name__ == "__main__":
    main()
