#!/usr/bin/env python3
"""Draft guardrails for the external SABER tasks with the model, once, and freeze them unedited.

Those tasks were written by someone else against schemas we did not design, so hand-written
guardrails would leak knowledge of the tasks. This is the product's real flow minus the human review,
so it measures what unedited model-drafted guardrails catch. Each draft must hold on the pristine
target, otherwise it is dropped. Run: python scripts/draft_external_guardrails.py (needs the bench env).
"""
from __future__ import annotations

import asyncio
import os
import sys
import uuid
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bench.run import load_config, prod_conn  # noqa: E402
from bench.seeddb import drop_db, make_template  # noqa: E402
from bench.tasks import load_tasks  # noqa: E402
from control.agent import describe_schema, draft_guardrails, draft_host_guardrails  # noqa: E402
from control.runner_client import RunnerClient  # noqa: E402
from control.snapshot import take_snapshot  # noqa: E402

OUT = ROOT / "bench" / "external_guardrails.yaml"


class Ctx:
    def __init__(self, admin: dict) -> None:
        self.admin = admin


async def draft_one(task: dict, ctx: Ctx, runner: RunnerClient) -> list[dict]:
    if task["target"] == "postgres":
        template = await asyncio.to_thread(make_template, ctx.admin, task)
        try:
            snap = await asyncio.to_thread(take_snapshot, prod_conn(ctx, template))
            await runner.put_snapshot(snap["snapshot_id"], snap["dump_path"])
            Path(snap["dump_path"]).unlink(missing_ok=True)
            inspection = await runner.inspect(snap["snapshot_id"])
            drafts = await asyncio.to_thread(draft_guardrails, describe_schema(inspection))
            rec = await runner.rehearse(f"g{uuid.uuid4().hex[:12]}", snap["snapshot_id"], [], drafts)
            results = {g["id"]: g for g in (rec.get("result") or {}).get("guardrails", [])}
            return [d for d in drafts if results.get(d["id"], {}).get("passed") is True]
        finally:
            await asyncio.to_thread(drop_db, ctx.admin, template)
    hid = f"g{uuid.uuid4().hex[:10]}"
    await runner.host_ensure(hid, task.get("seed_sh"))
    try:
        inspection = await runner.host_inspect(hid)
        drafts = await asyncio.to_thread(draft_host_guardrails, describe_schema(inspection))
        kept = []
        for d in drafts:
            if (await runner.host_exec(hid, d["sh"]))["exit_code"] == 0:
                kept.append(d)
        return kept
    finally:
        await runner.host_remove(hid)


async def main() -> int:
    admin, *_ = load_config()
    ctx = Ctx(admin)
    runner = RunnerClient()
    out = yaml.safe_load(OUT.read_text()) if OUT.exists() else {}
    for task in load_tasks():
        if task["split"] != "external" or task["id"] in out:
            continue
        kept = await draft_one(task, ctx, runner)
        out[task["id"]] = kept
        print(f"{task['id']}: {len(kept)} guardrails kept", flush=True)
        OUT.write_text("# Drafted by the model from each target, unedited. Frozen before the benchmark ran.\n" + yaml.safe_dump(out, sort_keys=True, width=120))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
