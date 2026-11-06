"""HTTP face of the runner. Lives on the VX1, listens on the VPC address only, needs a bearer token.

This process holds no prod credential and no inference key. It receives a dump and a plan.
"""
from __future__ import annotations

import base64
import json

import asyncio
import hmac
import logging
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel

from checker import redteam
from runner.engine import Engine, host_identity, image_digest

log = logging.getLogger("shadowrun.runner")
TOKEN = os.environ.get("RUNNER_TOKEN", "")
SNAP_TMP = Path(os.environ.get("SHADOWRUN_RUNNER_TMP", tempfile.gettempdir())) / "sr-snapshots"

app = FastAPI(title="Shadow Run runner", docs_url=None, redoc_url=None)
engine = Engine()


def auth(authorization: str = Header(default="")) -> None:
    if not TOKEN or not hmac.compare_digest(authorization, f"Bearer {TOKEN}"):
        raise HTTPException(401, "bad runner token")


class RehearseBody(BaseModel):
    run_id: str
    snapshot_id: str
    steps: list[dict]
    guardrails: list[dict] = []
    metrics: list[dict] = []
    undo: bool = True
    max_duration: int = 120


class ReadBody(BaseModel):
    snapshot_id: str
    queries: list[str] = []
    sample_rows: int = 3


@app.on_event("startup")
async def _start_janitor() -> None:
    async def loop() -> None:
        while True:
            await asyncio.sleep(60)
            try:
                killed = await engine.janitor_once()
                if killed:
                    log.warning("janitor removed %s", killed)
            except Exception as e:
                log.warning("janitor error: %s", e)

    asyncio.create_task(loop())


@app.get("/health", dependencies=[Depends(auth)])
async def health() -> dict:
    doctor = subprocess.run(["msb", "doctor"], capture_output=True, text=True, timeout=30)
    return {
        "host": host_identity(),
        "msb_doctor_ok": doctor.returncode == 0,
        "image_digest": await image_digest(),
        "firewall": redteam.firewall_counters(),
    }


@app.get("/snapshots/{snapshot_id}", dependencies=[Depends(auth)])
async def has_snapshot(snapshot_id: str) -> dict:
    return {"exists": await engine.has_golden(snapshot_id)}


@app.put("/snapshots/{snapshot_id}", dependencies=[Depends(auth)])
async def put_snapshot(snapshot_id: str, request: Request) -> dict:
    SNAP_TMP.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = SNAP_TMP / f"{uuid.uuid4().hex}.dump"
    try:
        size = 0
        with open(path, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                f.write(chunk)
        header = request.headers.get("x-sr-expected")
        expected = json.loads(base64.b64decode(header)) if header else None
        info = await engine.ensure_golden(snapshot_id, path, expected=expected)
        info["dump_bytes"] = size
        return info
    finally:
        # The dump exists on the host only long enough to be copied into the golden VM.
        path.unlink(missing_ok=True)


@app.delete("/snapshots/{snapshot_id}", dependencies=[Depends(auth)])
async def delete_snapshot(snapshot_id: str) -> dict:
    await engine.drop_golden(snapshot_id)
    return {"ok": True}


@app.post("/rehearse", dependencies=[Depends(auth)])
async def rehearse(body: RehearseBody) -> dict:
    return await engine.rehearse(body.run_id, body.snapshot_id, body.steps, body.guardrails, max_duration=body.max_duration, metrics=body.metrics, undo=body.undo)


@app.post("/inspect", dependencies=[Depends(auth)])
async def inspect(body: ReadBody) -> dict:
    return await engine.inspect(body.snapshot_id, f"i{uuid.uuid4().hex[:12]}", body.sample_rows)


@app.post("/query", dependencies=[Depends(auth)])
async def query(body: ReadBody) -> dict:
    return await engine.query(body.snapshot_id, f"q{uuid.uuid4().hex[:12]}", body.queries)


@app.post("/suspects", dependencies=[Depends(auth)])
async def suspects(body: ReadBody) -> dict:
    return await engine.suspects(body.snapshot_id, f"s{uuid.uuid4().hex[:12]}")


@app.get("/redteam/attacks", dependencies=[Depends(auth)])
async def attacks() -> dict:
    return {"attacks": redteam.list_attacks()}


class AttackBody(BaseModel):
    attack: str
    snapshot_id: str


@app.post("/redteam", dependencies=[Depends(auth)])
async def run_attack(body: AttackBody) -> dict:
    return await redteam.run_attack(engine, body.attack, body.snapshot_id)


class HostBody(BaseModel):
    host_id: str
    seed_sh: str | None = None
    recreate: bool = False


class HostRehearseBody(BaseModel):
    run_id: str
    host_id: str
    steps: list[dict]
    guardrails: list[dict] = []
    max_duration: int = 120


class HostApplyBody(BaseModel):
    host_id: str
    steps: list[dict]
    guardrails: list[dict] = []


class HostExecBody(BaseModel):
    host_id: str
    sh: str


class HostRollbackBody(BaseModel):
    host_id: str
    running: list[str]


@app.post("/host/ensure", dependencies=[Depends(auth)])
async def host_ensure(body: HostBody) -> dict:
    return await engine.ensure_prodhost(body.host_id, body.seed_sh, body.recreate)


@app.post("/host/fingerprint", dependencies=[Depends(auth)])
async def host_fingerprint(body: HostBody) -> dict:
    return await engine.prodhost_fingerprint(body.host_id)


@app.post("/host/inspect", dependencies=[Depends(auth)])
async def host_inspect(body: HostBody) -> dict:
    return await engine.prodhost_inspect(body.host_id)


@app.post("/host/rehearse", dependencies=[Depends(auth)])
async def host_rehearse(body: HostRehearseBody) -> dict:
    return await engine.rehearse_host(body.run_id, body.host_id, body.steps, body.guardrails, body.max_duration)


@app.post("/host/apply", dependencies=[Depends(auth)])
async def host_apply(body: HostApplyBody) -> dict:
    return await engine.prodhost_apply(body.host_id, body.steps, body.guardrails)


@app.post("/host/rollback", dependencies=[Depends(auth)])
async def host_rollback(body: HostRollbackBody) -> dict:
    return await engine.prodhost_rollback(body.host_id, body.running)


@app.post("/host/exec", dependencies=[Depends(auth)])
async def host_exec(body: HostExecBody) -> dict:
    return await engine.prodhost_exec(body.host_id, body.sh)


@app.post("/host/remove", dependencies=[Depends(auth)])
async def host_remove(body: HostBody) -> dict:
    await engine.remove_prodhost(body.host_id)
    return {"ok": True}


class WallBody(BaseModel):
    snapshot_id: str


@app.post("/redteam/wall2", dependencies=[Depends(auth)])
async def wall_two(body: WallBody) -> dict:
    return await redteam.wall_two_test(engine, body.snapshot_id)


def main() -> None:
    import uvicorn

    uvicorn.run(app, host=os.environ.get("SHADOWRUN_RUNNER_BIND", "127.0.0.1"), port=int(os.environ.get("SHADOWRUN_RUNNER_PORT", "8101")), log_level="info")


if __name__ == "__main__":
    if not shutil.which("msb"):
        raise SystemExit("msb is not on PATH")
    main()
