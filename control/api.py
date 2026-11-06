"""REST API and web UI host. Every approval happens here, whichever way a run came in."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from control import auth, evidence, llm, settings
from control.approvals import ApprovalError, challenge
from control.gate import check_plan
from control.mcp_server import McpAuth
from control.mcp_server import mount as mount_mcp
from control.plan import PlanError, normalize_plan, plan_hash
from control.runner_client import RunnerError
from control.service import DEMO_TARGET_ID, Service, public_target
from control.snapshot import conn_from_target, fingerprint

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("shadowrun.api")

ROOT = Path(__file__).resolve().parent.parent
WEB_DIST = ROOT / "web" / "dist"
RESULTS = ROOT / "bench" / "results.json"
PUBLIC_URL = os.environ.get("SHADOWRUN_PUBLIC_URL", "")

service: Service | None = None
mcp_server: Any = None


def svc() -> Service:
    global service
    if service is None:
        service = Service()
    return service


@asynccontextmanager
async def lifespan(_: FastAPI):
    async with mcp_server.session_manager.run():
        yield


app = FastAPI(title="Shadow Run", version="0.1.0", docs_url="/api/docs", openapi_url="/api/openapi.json", lifespan=lifespan)
app.add_middleware(McpAuth)
mcp_server = mount_mcp(app, svc, urlparse(PUBLIC_URL).hostname if PUBLIC_URL else None)


@app.exception_handler(ApprovalError)
async def _approval_error(_, e: ApprovalError):
    return JSONResponse(status_code=e.status, content={"detail": e.message})


@app.exception_handler(RunnerError)
async def _runner_error(_, e: RunnerError):
    return JSONResponse(status_code=502, content={"detail": str(e)})


class LoginBody(BaseModel):
    username: str
    password: str


class RunBody(BaseModel):
    target_id: str = DEMO_TARGET_ID
    task: str | None = Field(default=None, max_length=2000)
    steps: list[dict] | None = None
    source: str = "web"


class ApproveBody(BaseModel):
    plan_hash: str
    guardrails_hash: str
    report_hash: str
    nonce: str


class RejectBody(BaseModel):
    reason: str = ""


class ApplyBody(BaseModel):
    drift_check: bool = True


class GuardrailsBody(BaseModel):
    guardrails: list[dict]


class BudgetBody(BaseModel):
    budget: dict


class CheckBody(BaseModel):
    target_id: str = DEMO_TARGET_ID
    steps: list[dict]


_hits: dict[tuple[str, str], list[float]] = {}


def limit(user: str, action: str, per_hour: int) -> None:
    """The demo logins are public, so nothing that costs money or disturbs prod may be unlimited."""
    now = time.time()
    hits = [t for t in _hits.get((user, action), []) if now - t < 3600]
    if len(hits) >= per_hour:
        raise HTTPException(429, f"limit of {per_hour} {action} per hour reached")
    hits.append(now)
    _hits[(user, action)] = hits


def run_view(run: dict, user: str | None = None) -> dict:
    """What the UI gets. Adds server-computed permissions, so the UI never guesses."""
    v = dict(run)
    v.pop("submitted_steps", None)
    attempts = run.get("attempts", [])
    # While the loop runs there is no final attempt yet, so show the latest one.
    final = next((a for a in attempts if a["n"] == run.get("final_attempt")), None) or (attempts[-1] if attempts else None)
    v["final"] = final
    if run["status"] == "awaiting_approval" and run.get("plan_hash"):
        v["challenge"] = challenge(run)
    v.pop("approval_nonce", None)
    v["can"] = {
        "approve": run["status"] == "awaiting_approval" and user is not None and user != run["requester"],
        "approve_blocked_reason": "You requested this run, so a different person has to approve it." if run["status"] == "awaiting_approval" and user == run["requester"] else None,
        "apply": run["status"] == "approved",
        "rehearse_again": run["status"] in ("drift_detected", "rolled_back"),
    }
    ev = run.get("evidence") or {}
    if ev.get("key"):
        try:
            v["evidence_url"] = evidence.presign(ev)
        except Exception:
            v["evidence_url"] = None
    v["rerun"] = rerun_command(run)
    return v


def rerun_command(run: dict) -> str | None:
    final = next((a for a in run.get("attempts", []) if a["n"] == run.get("final_attempt")), None)
    if not final or "plan" not in final:
        return None
    body = {"target_id": run["target_id"], "steps": [{"type": s["type"], "cmd": s["cmd"]} for s in final["plan"]["steps"]]}
    return f"curl -s -X POST {PUBLIC_URL or 'http://localhost:8100'}/api/runs -H \"Authorization: Bearer $SHADOWRUN_TOKEN\" -H 'Content-Type: application/json' -d {shlex.quote(json.dumps(body))}"


def run_summary(run: dict) -> dict:
    final = next((a for a in run.get("attempts", []) if a["n"] == run.get("final_attempt")), None) or {}
    totals = (final.get("report") or {}).get("totals", {})
    steps = (final.get("plan") or {}).get("steps") or run.get("submitted_steps") or []
    return {
        "plan_preview": " ".join(str(steps[0].get("cmd", "")).split())[:160] if steps else None,
        "files_changed": (totals.get("files_created", 0) + totals.get("files_deleted", 0) + totals.get("files_changed", 0)) if totals else None,
        "services_stopped": totals.get("services_stopped"),
        "id": run["id"], "created_at": run["created_at"], "status": run["status"], "requester": run["requester"], "task": run.get("task"),
        "source": run.get("source"), "target_id": run["target_id"], "plan_hash": run.get("plan_hash"), "attempts": len(run.get("attempts", [])),
        "rows_changed": totals.get("rows_changed"), "rows_via_cascade": totals.get("rows_via_cascade"),
        "guardrails_failed": sum(1 for g in final.get("guardrails", []) if not g.get("passed")), "cost_usd": run.get("cost_usd"),
        "rehearsal_ms": (final.get("rehearsal") or {}).get("phases", {}).get("total_ms"),
    }


# ------------------------------------------------------------------ auth

@app.post("/api/login")
def login(body: LoginBody, response: Response) -> dict:
    if not auth.check_password(body.username, body.password):
        raise HTTPException(401, "wrong username or password")
    token = auth.issue(body.username)
    response.set_cookie(auth.COOKIE, token, httponly=True, samesite="lax", secure=PUBLIC_URL.startswith("https"), max_age=settings.SESSION_TTL_S)
    return {"username": body.username, "name": auth.users()[body.username]["name"], "token": token}


@app.post("/api/logout")
def logout(response: Response) -> dict:
    response.delete_cookie(auth.COOKIE)
    return {"ok": True}


@app.get("/api/me")
def me(user: str = Depends(auth.current_user)) -> dict:
    u = auth.users()[user]
    return {"username": user, "name": u["name"], "role": u["role"], "token": auth.issue(user)}


# ------------------------------------------------------------------ targets, guardrails

@app.get("/api/targets")
def targets(user: str = Depends(auth.current_user)) -> list[dict]:
    return [public_target(t) for t in svc().store.list_targets()]


@app.get("/api/targets/{target_id}")
def target(target_id: str, user: str = Depends(auth.current_user)) -> dict:
    t = svc().store.get_target(target_id)
    if not t:
        raise HTTPException(404, "no such target")
    return public_target(t)


@app.post("/api/targets/{target_id}/guardrails/draft")
async def guardrails_draft(target_id: str, user: str = Depends(auth.current_user)) -> dict:
    if not svc().store.get_target(target_id):
        raise HTTPException(404, "no such target")
    limit(user, "guardrail drafts", 10)
    return {"drafts": await svc().draft_guardrails(target_id), "model": settings.GUARDRAIL_MODEL}


@app.post("/api/targets/{target_id}/guardrails/accept")
def guardrails_accept(target_id: str, body: GuardrailsBody, user: str = Depends(auth.current_user)) -> dict:
    if auth.users()[user]["role"] != "admin":
        raise HTTPException(403, "only an admin can change the frozen guardrails")
    return public_target(svc().accept_guardrails(target_id, body.guardrails, user))


@app.post("/api/targets/{target_id}/budget")
def set_budget(target_id: str, body: BudgetBody, user: str = Depends(auth.current_user)) -> dict:
    if auth.users()[user]["role"] != "admin":
        raise HTTPException(403, "only an admin can change the budget")
    t = svc().store.get_target(target_id)
    if not t:
        raise HTTPException(404, "no such target")
    t["budget"] = {**t.get("budget", {}), **body.budget}
    svc().store.save_target(t)
    return public_target(t)


@app.get("/api/targets/{target_id}/inspect")
async def inspect(target_id: str, user: str = Depends(auth.current_user)) -> dict:
    """Schema and sample rows, always served from a clone, never from prod."""
    t = svc().store.get_target(target_id)
    if not t:
        raise HTTPException(404, "no such target")
    snap = await svc().ensure_snapshot(t)
    data = await svc().inspection_for(t, snap["snapshot_id"])
    return {"snapshot_id": snap["snapshot_id"], "served_from": "clone" if t["kind"] == "postgres" else "the host, read-only", **data}


# ------------------------------------------------------------------ runs

@app.post("/api/check")
def static_check(body: CheckBody, user: str = Depends(auth.current_user)) -> dict:
    t = svc().store.get_target(body.target_id)
    if not t:
        raise HTTPException(404, "no such target")
    try:
        steps = normalize_plan(body.steps)
    except PlanError as e:
        raise HTTPException(422, str(e)) from e
    return {"plan_hash": plan_hash(body.target_id, steps), "gate": check_plan(steps, t["kind"])}


@app.post("/api/runs", status_code=201)
async def create_run(body: RunBody, user: str = Depends(auth.current_user)) -> dict:
    s = svc()
    if not body.task and not body.steps:
        raise HTTPException(422, "send a task or steps")
    recent = s.store.count_runs_since(user, time.time() - 3600)
    # A public demo must not be able to burn the inference budget or saturate the VX1.
    if body.task and recent >= settings.RUNS_PER_HOUR:
        raise HTTPException(429, f"limit of {settings.RUNS_PER_HOUR} agent runs per hour reached")
    if recent >= settings.RUNS_PER_HOUR * 4:
        raise HTTPException(429, "too many runs this hour")
    if len(s._tasks) >= settings.MAX_RUNNING:
        raise HTTPException(429, "the runner is busy; try again in a minute")
    spent = sum(r.get("cost_usd") or 0 for r in s.store.list_runs(100) if r["created_at"] > time.time() - 86400)
    if body.task and spent >= settings.DAILY_USD_CAP:
        raise HTTPException(429, "today's inference budget for this demo is used up")
    if body.steps:
        try:
            normalize_plan(body.steps)
        except PlanError as e:
            raise HTTPException(422, str(e)) from e
    try:
        run = s.new_run(body.target_id, user, body.task, body.steps, body.source if body.source in ("web", "mcp", "cli", "api") else "api")
    except KeyError as e:
        raise HTTPException(404, "no such target") from e
    s.start(run)
    return {"id": run["id"], "status": run["status"]}


@app.get("/api/runs")
def list_runs(limit: int = 30, user: str = Depends(auth.current_user)) -> list[dict]:
    return [run_summary(r) for r in svc().store.list_runs(min(limit, 100))]


@app.get("/api/runs/{run_id}")
def get_run(run_id: str, user: str = Depends(auth.current_user)) -> dict:
    run = svc().store.get_run(run_id)
    if not run:
        raise HTTPException(404, "no such run")
    return run_view(run, user)


@app.post("/api/runs/{run_id}/approve")
def approve(run_id: str, body: ApproveBody, user: str = Depends(auth.current_user)) -> dict:
    return run_view(svc().approve(run_id, user, body.model_dump()), user)


@app.post("/api/runs/{run_id}/reject")
def reject(run_id: str, body: RejectBody, user: str = Depends(auth.current_user)) -> dict:
    return run_view(svc().reject(run_id, user, body.reason), user)


@app.post("/api/runs/{run_id}/apply")
async def apply_run(run_id: str, body: ApplyBody = ApplyBody(), user: str = Depends(auth.current_user)) -> dict:
    return run_view(await svc().apply(run_id, user, drift_check=body.drift_check), user)


@app.post("/api/runs/{run_id}/rehearse-again", status_code=201)
async def rehearse_again(run_id: str, user: str = Depends(auth.current_user)) -> dict:
    try:
        run = svc().rehearse_again(run_id, user)
    except (KeyError, ValueError) as e:
        raise HTTPException(404, str(e)) from e
    return {"id": run["id"], "status": run["status"]}


@app.get("/api/runs/{run_id}/evidence")
def run_evidence(run_id: str, user: str = Depends(auth.current_user)) -> dict:
    from control.evidence import build_bundle

    run = svc().store.get_run(run_id)
    if not run:
        raise HTTPException(404, "no such run")
    return build_bundle(run)


# ------------------------------------------------------------------ proof and demo controls

@app.get("/api/prod-checksum")
async def prod_checksum(target_id: str = DEMO_TARGET_ID, user: str = Depends(auth.current_user)) -> dict:
    t = svc().store.get_target(target_id)
    if not t:
        raise HTTPException(404, "no demo target")
    if t["kind"] == "host":
        await svc().runner.host_ensure(t["host_id"])
        fp = await svc().runner.host_fingerprint(t["host_id"])
        return {"digest": fp.get("digest"), "files": fp.get("files"), "services": fp.get("services"), "at": time.time()}
    fp = await asyncio.to_thread(fingerprint, conn_from_target(t))
    return {"digest": fp["digest"], "lsn": fp["lsn"], "rows": {k: v["rows"] for k, v in fp["tables"].items()}, "at": time.time()}


@app.post("/api/demo/drift")
async def make_drift(target_id: str = DEMO_TARGET_ID, user: str = Depends(auth.current_user)) -> dict:
    """Change prod behind Shadow Run's back: a real write to a table plans usually touch."""
    import psycopg

    limit(user, "demo drift writes", 120)
    t = svc().store.get_target(target_id)
    if t and t["kind"] == "host":
        await svc().runner.host_exec(t["host_id"], "echo drift >> /var/app/logs/app.log")
        svc().store.append_event(None, user, "demo_drift", {"target": target_id})
        return {"what": "one line appended to /var/app/logs/app.log, outside Shadow Run"}
    conn = conn_from_target(t)

    def write() -> dict:
        with psycopg.connect(**conn.kwargs()) as c:
            row = c.execute(
                """INSERT INTO users (account_id, email, full_name, role, status, last_login_at, created_at)
                   SELECT id, 'drift+' || extract(epoch from now())::bigint || '@example.test', 'Drift User', 'member', 'active',
                          now() - interval '2 years', now() FROM accounts ORDER BY id LIMIT 1 RETURNING id"""
            ).fetchone()
            return {"inserted_user_id": row[0], "what": "one user inserted directly into prod, outside Shadow Run"}

    result = await asyncio.to_thread(write)
    svc().store.append_event(None, user, "demo_drift", result)
    return result


@app.post("/api/demo/reset")
async def demo_reset(target_id: str = DEMO_TARGET_ID, user: str = Depends(auth.current_user)) -> dict:
    from demo.reset import reset

    limit(user, "demo resets", 120)
    t = svc().store.get_target(target_id)
    if t and t["kind"] == "host":
        await svc().runner.host_ensure(t["host_id"], recreate=True)
        svc().store.append_event(None, user, "demo_reset", {"target": target_id})
        return {"ok": True}
    conn = conn_from_target(t)
    counts = await asyncio.to_thread(reset, conn.kwargs())
    svc().store.append_event(None, user, "demo_reset", {"tables": len(counts)})
    return {"ok": True, "tables": counts}


@app.post("/api/redteam", status_code=201)
async def redteam_start(user: str = Depends(auth.current_user)) -> dict:
    running = [d for d in svc().store.list_redteam(3) if d.get("status") == "running" and time.time() - d["created_at"] < 300]
    if running:
        return running[0]
    return svc().start_redteam(user)


@app.get("/api/redteam")
def redteam_list(limit: int = 5, user: str = Depends(auth.current_user)) -> list[dict]:
    return svc().store.list_redteam(limit)


@app.get("/api/redteam/attacks")
async def redteam_attacks(user: str = Depends(auth.current_user)) -> list[dict]:
    return await svc().runner.attacks()


@app.get("/api/results")
def results() -> dict:
    """Benchmark results, exactly as written by bench/run.py. Public, like the README table."""
    if RESULTS.exists():
        return json.loads(RESULTS.read_text())
    return {"status": "not measured yet"}


@app.get("/api/audit")
def audit(after: int = 0, limit: int = 200, user: str = Depends(auth.current_user)) -> dict:
    s = svc().store
    return {"events": s.events(after=after, limit=min(limit, 1000)), "chain": s.verify_chain()}


@app.get("/api/health")
async def health() -> dict[str, Any]:
    out: dict[str, Any] = {"ok": True, "s3": evidence.s3_enabled(), "inference_base_is_vultr": llm.is_vultr_base(settings.INFERENCE_BASE), "planner_model": settings.PLANNER_MODEL}
    try:
        out["runner"] = await svc().runner.health()
    except Exception as e:
        out["ok"] = False
        out["runner_error"] = type(e).__name__
    return out


if WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        candidate = (WEB_DIST / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(WEB_DIST.resolve()):
            return FileResponse(candidate)
        return FileResponse(WEB_DIST / "index.html")
