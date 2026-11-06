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
from contextvars import ContextVar
from typing import Any, Literal
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from checker.control_kinds import control_kind
from control import hero
from control import auth, evidence, llm, settings
from control.approvals import ApprovalError, challenge
from control.gate import check_plan
from control.mcp_server import McpAuth
from control.mcp_server import mount as mount_mcp
from control.limits import MAX_BODY_BYTES, plan_too_big
from control.plan import PlanError, normalize_plan, plan_hash
from control.runner_client import RunnerError
from control.hardening import Hardening
from control.service import DEMO_TARGET_ID, ROOT as SERVICE_ROOT, Service, demo_target, public_target
from control.snapshot import conn_from_target, fingerprint

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("shadowrun.api")

ROOT = Path(__file__).resolve().parent.parent
WEB_DIST = ROOT / "web" / "dist"
RESULTS = ROOT / "bench" / "results.json"
PUBLIC_URL = os.environ.get("SHADOWRUN_PUBLIC_URL", "")
# Guest access hands out both identities, so it can never sit in front of a team's own database.
IDLE_RESEED_S = int(os.environ.get("SHADOWRUN_IDLE_RESEED_S", "1200"))
OPEN_DEMO = not settings.TARGETS_FILE and (os.environ.get("SHADOWRUN_OPEN_DEMO", "1") == "1")

service: Service | None = None
mcp_server: Any = None


def svc() -> Service:
    global service
    if service is None:
        service = Service()
    return service


@asynccontextmanager
async def lifespan(_: FastAPI):
    reseeder = asyncio.create_task(_reseed_when_idle())
    try:
        async with mcp_server.session_manager.run():
            yield
    finally:
        reseeder.cancel()


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
    rehearse_only: bool = False


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
client_ip: ContextVar[str] = ContextVar("client_ip", default="unknown")


@app.middleware("http")
async def remember_client(request: Request, call_next: Any) -> Any:
    # Every guest shares one identity, so limits go by address, or one visitor could use up everyone's.
    # Caddy replaces X-Forwarded-For with the real peer, uvicorn trusts that only from loopback, and this is the result.
    client_ip.set(request.client.host if request.client else "unknown")
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        return JSONResponse({"detail": f"a request can be at most {MAX_BODY_BYTES:,} bytes"}, status_code=413)
    response = await call_next(request)
    # Built assets have a content hash in their names, so a new build can never be served stale.
    if request.url.path.startswith("/assets/") and response.status_code == 200:
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


def refuse_oversized(steps: Any) -> None:
    problem = plan_too_big(steps)
    if problem:
        raise HTTPException(413, problem)


def limit(user: str, action: str, per_hour: int) -> None:
    """The demo logins are public, so nothing that costs money or disturbs prod may be unlimited."""
    now = time.time()
    key = (client_ip.get(), action)
    hits = [t for t in _hits.get(key, []) if now - t < 3600]
    if len(hits) >= per_hour:
        raise HTTPException(429, f"limit of {per_hour} {action} per hour reached")
    hits.append(now)
    _hits[key] = hits


def require_inference_budget() -> None:
    """A run with fixed steps still calls the explainer, so every path that spends inference checks this."""
    since = time.time() - 86400
    spent = svc().store.cost_since(since) + sum(g.get("cost_usd") or 0 for g in hardening().list_gauntlets(20) if g.get("created_at", 0) >= since)
    if spent >= settings.DAILY_USD_CAP:
        raise HTTPException(429, "today's inference budget for this demo is used up")


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


# ------------------------------------------------------------------ one click into the demo

@app.get("/api/public")
def public_info() -> dict:
    """What the landing page shows before anyone signs in. Numbers only from the benchmark's own file."""
    r = json.loads(RESULTS.read_text()) if RESULTS.exists() else {}
    headline = None
    if r.get("status") == "measured" and r.get("scope") == "full" and r.get("harness_errors") == 0:
        h = r["heldout"]
        headline = {
            "risky_tasks": h["direct"]["risky_tasks"], "direct": h["direct"]["harm_on_prod"]["mean"], "static_gate": h["static_gate"]["harm_on_prod"]["mean"],
            "shadow_run": h["shadow_run"]["harm_on_prod"]["mean"], "rubber_stamp": h["shadow_run"]["harm_if_rubber_stamped"]["mean"],
            "done_direct": h["direct"]["risky_done"]["mean"], "done_static_gate": h["static_gate"]["risky_done"]["mean"], "done_unread": h["shadow_run"]["risky_done_if_rubber_stamped"]["mean"],
            "held": h["shadow_run"]["risky_held"]["mean"],
            "runs_per_task": r["runs_per_task"], "measured_at": r["at"],
        }
    return {"open_demo": OPEN_DEMO, "headline": headline, "hero": hero.latest(svc().store) if OPEN_DEMO else None, "applied_example": hero.applied_example(svc().store) if OPEN_DEMO else None, "video_url": os.environ.get("SHADOWRUN_VIDEO_URL") or None, "repo": "https://github.com/Prashant-thakur77/Shadow-Run"}


@app.post("/api/demo/enter")
def demo_enter(response: Response) -> dict:
    """Continue as a guest: both public demo identities, so the requester and approver flow works in one tab."""
    if not OPEN_DEMO:
        raise HTTPException(403, "this deployment has no open demo")
    judge = auth.issue("judge")
    response.set_cookie(auth.COOKIE, judge, httponly=True, samesite="lax", secure=PUBLIC_URL.startswith("https"), max_age=settings.SESSION_TTL_S)
    return {"username": "judge", "name": auth.users()["judge"]["name"], "token": judge, "others": {"reviewer": auth.issue("reviewer")}}


# ------------------------------------------------------------------ auth

@app.post("/api/login")
def login(body: LoginBody, response: Response) -> dict:
    limit(body.username, "sign-in attempts", 30)
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
    require_inference_budget()
    return {"drafts": await svc().draft_guardrails(target_id), "model": settings.GUARDRAIL_MODEL}


@app.post("/api/targets/{target_id}/guardrails/accept")
def guardrails_accept(target_id: str, body: GuardrailsBody, user: str = Depends(auth.current_user)) -> dict:
    if auth.users()[user]["role"] != "admin":
        raise HTTPException(403, "only an admin can change the frozen guardrails")
    try:
        return public_target(svc().accept_guardrails(target_id, body.guardrails, user))
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


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
    refuse_oversized(body.steps)
    limit(user, "plan checks", 600)
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
    refuse_oversized(body.steps)
    # A public demo must not be able to burn the inference budget or saturate the VX1.
    if body.task:
        limit(user, "agent runs", settings.RUNS_PER_HOUR)
    limit(user, "runs", settings.RUNS_PER_HOUR * 4)
    if s.store.count_runs_since(user, time.time() - 3600) >= settings.RUNS_PER_HOUR * 12:
        raise HTTPException(429, "the demo is very busy; try again in a while")
    if len(s._tasks) >= settings.MAX_RUNNING:
        raise HTTPException(429, "the runner is busy; try again in a minute")
    require_inference_budget()
    if body.steps:
        try:
            normalize_plan(body.steps)
        except PlanError as e:
            raise HTTPException(422, str(e)) from e
    try:
        run = s.new_run(body.target_id, user, body.task, body.steps, body.source if body.source in ("web", "mcp", "cli", "api") else "api")
    except KeyError as e:
        raise HTTPException(404, "no such target") from e
    if body.rehearse_only:
        run["rehearse_only"] = True
        s.store.save_run(run)
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


class LearnBody(BaseModel):
    reason: str = Field(min_length=3, max_length=800)


def hardening() -> Hardening:
    return Hardening(svc())


@app.post("/api/runs/{run_id}/undo", status_code=201)
async def undo_run(run_id: str, user: str = Depends(auth.current_user)) -> dict:
    try:
        run = svc().undo_run(run_id, user)
    except KeyError as e:
        raise HTTPException(404, "no such run") from e
    except ValueError as e:
        raise HTTPException(409, str(e)) from e
    return {"id": run["id"], "status": run["status"]}


@app.get("/api/runs/{run_id}/undo")
def get_undo(run_id: str, user: str = Depends(auth.current_user)) -> dict:
    run = svc().store.get_run(run_id)
    if not run:
        raise HTTPException(404, "no such run")
    statements = svc().store.kv_get(f"undo:{run_id}:{run.get('final_attempt')}") or []
    return {"statements": statements[:50]}


@app.post("/api/runs/{run_id}/learn")
async def learn(run_id: str, body: LearnBody, user: str = Depends(auth.current_user)) -> dict:
    """Turn a person's reason for rejecting a plan into a guardrail, proved on a clone."""
    run = svc().store.get_run(run_id)
    if not run:
        raise HTTPException(404, "no such run")
    limit(user, "guardrails learned", 12)
    require_inference_budget()
    try:
        return await hardening().learn_from_rejection(run, body.reason, user)
    except (ValueError, llm.LLMError) as e:
        raise HTTPException(422, str(e)[:300]) from e


class GauntletBody(BaseModel):
    rounds: int = Field(default=5, ge=1, le=10)
    policy: Literal["named_scope", "row_budget_only"] = "named_scope"


@app.post("/api/targets/{target_id}/gauntlet", status_code=201)
async def gauntlet_start(target_id: str, body: GauntletBody | None = None, user: str = Depends(auth.current_user)) -> dict:
    t = svc().store.get_target(target_id)
    if not t or t["kind"] != "postgres":
        raise HTTPException(404, "the gauntlet runs on a Postgres target")
    running = [d for d in hardening().list_gauntlets(3) if d.get("status") == "running"]
    if running:
        return running[0]
    limit(user, "gauntlet runs", 6)
    require_inference_budget()
    body = body or GauntletBody()
    return hardening().start_gauntlet(target_id, user, rounds=body.rounds, policy=body.policy)


@app.get("/api/gauntlet")
def gauntlet_list(limit: int = 5, user: str = Depends(auth.current_user)) -> list[dict]:
    return hardening().list_gauntlets(min(limit, 20))


def bench_json(name: str) -> dict | None:
    path = SERVICE_ROOT / "bench" / name
    return json.loads(path.read_text()) if path.exists() else None


@app.get("/api/gauntlet/published")
def gauntlet_published(user: str = Depends(auth.current_user)) -> dict:
    """The measured comparison, as bench/gauntlet.json has it. Null fields mean it hasn't been measured."""
    g = bench_json("gauntlet.json") or {}
    if not g.get("baseline_summary"):
        return {"measured": False}
    replay = {k: v for k, v in (g.get("replay") or {}).items() if k != "attacks"}
    keep = ("at", "model", "baseline_summary", "first_summary", "summary", "adopted", "guardrails_before", "guardrails_after", "cost_usd", "rerun")
    return {"measured": True, "replay": replay, **{k: g.get(k) for k in keep}}


@app.post("/api/gauntlet/{gauntlet_id}/replay")
async def gauntlet_replay(gauntlet_id: str, user: str = Depends(auth.current_user)) -> dict:
    """Do the attacks that got past the rules still get past them today?"""
    limit(user, "gauntlet replays", 12)
    try:
        return await hardening().replay(gauntlet_id)
    except KeyError as e:
        raise HTTPException(404, "no such gauntlet") from e


@app.post("/api/guardrails/candidates/{candidate_id}/accept")
def candidate_accept(candidate_id: str, target_id: str = DEMO_TARGET_ID, user: str = Depends(auth.current_user)) -> dict:
    """On a demo target anyone signed in may add a proved rule, and a reset restores the set. Elsewhere it's an admin's call,
    because a rule that's too strict stops every apply until someone removes it."""
    target = svc().store.get_target(target_id)
    if target and not target.get("demo_controls") and auth.users()[user]["role"] != "admin":
        raise HTTPException(403, "only an admin can change the frozen guardrails")
    try:
        return public_target(hardening().accept(candidate_id, target_id, user))
    except KeyError as e:
        raise HTTPException(404, "no such guardrail") from e
    except ValueError as e:
        raise HTTPException(409, str(e)) from e


def load_incidents() -> list[dict]:
    import yaml

    return yaml.safe_load((SERVICE_ROOT / "demo" / "incidents.yaml").read_text())


@app.get("/api/incidents")
def incidents() -> list[dict]:
    return load_incidents()


@app.post("/api/incidents/{incident_id}/replay", status_code=201)
async def replay_incident(incident_id: str, user: str = Depends(auth.current_user)) -> dict:
    incident = next((i for i in load_incidents() if i["id"] == incident_id), None)
    if incident is None:
        raise HTTPException(404, "no such incident")
    limit(user, "incident replays", 60)
    require_inference_budget()
    run = svc().replay_incident(incident, user)
    return {"id": run["id"], "status": run["status"]}


@app.get("/api/receipts")
def receipts() -> dict:
    """Every measured claim, where it lives and the command that reproduces it. Public, like the README."""
    bench = ROOT / "bench"

    def load(name: str) -> dict | None:
        p = bench / name
        return json.loads(p.read_text()) if p.exists() else None

    items: list[dict] = []
    r = load("results.json")
    if r and r.get("status") == "measured":
        for row in r["table"]["rows"]:
            items.append({"group": "Benchmark", "claim": row[0], "values": dict(zip(r["table"]["columns"][1:], row[1:])), "at": r["at"], "source": "bench/results.json", "rerun": r["rerun"], "commit": r.get("git_commit")})
    rt = load("redteam.json")
    if rt and rt.get("attacks"):
        for a in rt["attacks"]:
            items.append({"group": "Red team", "claim": a["title"], "value": "contained" if a["contained"] else "NOT CONTAINED", "at": rt.get("created_at"), "source": "bench/redteam.json", "rerun": "python scripts/redteam_live.py"})
    c = load("controls.json")
    if c:
        for x in c["controls"]:
            items.append({"group": "Negative controls", "claim": x["control"], "value": "pass" if x["ok"] else "FAIL", "must": x["must"], "got": str(x.get("got", ""))[:300], "kind": control_kind(x["control"]), "at": c["at"], "source": "bench/controls.json", "rerun": "python -m checker.controls"})
    g = load("gauntlet.json")
    if g and g.get("summary"):
        for label, s in (("old policy, a row limit only", g.get("baseline_summary")), ("named list of what may change alone", g.get("first_summary")), ("after adopting the rules those attacks taught", g["summary"])):
            if s:
                items.append({"group": "Guardrail gauntlet", "claim": f"Real attacks stopped by a rule, {label}", "value": f"{s['caught']} of {s['real_attacks']}", "at": g.get("at"), "source": "bench/gauntlet.json", "rerun": "python scripts/gauntlet_live.py"})
                items.append({"group": "Guardrail gauntlet", "claim": f"Real attacks that would have applied with no person looking, {label}", "value": f"{s.get('would_auto_apply', 0)} of {s['real_attacks']}", "at": g.get("at"), "source": "bench/gauntlet.json", "rerun": "python scripts/gauntlet_live.py"})
        if g.get("replay"):
            items.append({"group": "Guardrail gauntlet", "claim": "Attacks that passed the rules, replayed against the rules they taught", "value": f"{g['replay']['caught']} of {g['replay']['total']} now stopped", "at": g.get("at"), "source": "bench/gauntlet.json", "rerun": "python scripts/gauntlet_live.py"})
    inc = load("incidents.json")
    if inc:
        for i in inc["incidents"]:
            items.append({"group": "Incident replay", "claim": i["who"] + ", " + i["when"], "value": i["status"], "detail": "; ".join(i.get("measured", [])[:2]), "at": inc.get("at"), "source": "bench/incidents.json", "rerun": "python scripts/incidents_live.py"})
    sc = load("scale.json")
    if sc:
        for row in sc["rows"]:
            items.append({"group": "Scale", "claim": f"Rehearsal on a {row['db_mb']} MB database", "value": f"{row['rehearsal_total_s']} s" if row.get("rehearsal_total_s") else "timed out", "at": sc["at"], "source": "bench/scale.json", "rerun": sc["rerun"]})
    rv = load("reviewer.json")
    if rv:
        for kind, label in (("harmful", "harmful"), ("good", "good")):
            for key, how in (("plan_only", "reading the plan alone"), ("with_report", "with the measured report")):
                items.append({"group": "Reviewer test", "claim": f"A model standing in for the reviewer, {how}: {label} plans approved", "value": f"{rv[key][kind]['approved']} of {rv[key][kind]['total']}", "at": rv["at"], "source": "bench/reviewer.json", "rerun": rv["rerun"]})
    so = load("soak.json")
    if so:
        items.append({"group": "Soak", "claim": f"{so['rehearsals']} rehearsals, every one contained with teardown confirmed", "value": "yes" if so["all_contained"] and so["all_teardown_ok"] else "NO", "at": so["at"], "source": "bench/soak.json", "rerun": so["rerun"]})
    return {"items": items, "note": "Nothing here is estimated. A claim with no measurement isn't listed." if items else "not measured yet"}


@app.post("/api/runs/{run_id}/rehearse-again", status_code=201)
async def rehearse_again(run_id: str, user: str = Depends(auth.current_user)) -> dict:
    limit(user, "rehearsals again", 30)
    require_inference_budget()
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
    seed = svc().store.kv_get(f"seed_digest:{target_id}")
    return {"seed_digest": seed, "changed_from_seed": bool(seed) and seed != fp["digest"], "digest": fp["digest"], "lsn": fp["lsn"], "rows": {k: v["rows"] for k, v in fp["tables"].items()}, "at": time.time()}


@app.post("/api/demo/drift")
async def make_drift(target_id: str = DEMO_TARGET_ID, user: str = Depends(auth.current_user)) -> dict:
    """Change prod behind Shadow Run's back: a real write to a table plans usually touch."""
    import psycopg

    limit(user, "demo drift writes", 120)
    t = svc().store.get_target(target_id)
    if not t or not t.get("demo_controls"):
        raise HTTPException(403, "only a demo target can be drifted on purpose")
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


async def reseed_demo(t: dict, who: str, event: str = "demo_reset") -> dict:
    """Back to the seed, learned guardrails included, because those belong to a demo session and not to the seed."""
    from demo.reset import reset

    conn = conn_from_target(t)
    counts = await asyncio.to_thread(reset, conn.kwargs())
    fresh = demo_target()
    fresh["budget"] = t.get("budget", fresh["budget"])
    svc().store.save_target(fresh)
    # A reseed is what defines the seed, so the header can say when a visitor has changed prod since.
    digest = (await asyncio.to_thread(fingerprint, conn))["digest"]
    svc().store.kv_set(f"seed_digest:{t['id']}", digest)
    svc().store.append_event(None, who, event, {"tables": len(counts)})
    return counts


def idle_reseed_due(now: float, last_activity: float, busy: bool, digest: str, seed: str | None, guardrails: int, seeded_guardrails: int, idle_s: float) -> bool:
    """Nobody should inherit another visitor's changes, and nobody should lose theirs while they're working."""
    if busy or not seed or now - last_activity < idle_s:
        return False
    return digest != seed or guardrails != seeded_guardrails


async def _reseed_if_idle() -> None:
    s = svc()
    t = s.store.get_target(DEMO_TARGET_ID)
    seed = s.store.kv_get(f"seed_digest:{DEMO_TARGET_ID}")
    if not t or not seed:
        return
    last = max((r.get("updated_at") or r.get("created_at") or 0 for r in s.store.list_runs(3)), default=0)
    if bool(s._tasks) or time.time() - last < IDLE_RESEED_S:
        return
    digest = (await asyncio.to_thread(fingerprint, conn_from_target(t)))["digest"]
    if idle_reseed_due(time.time(), last, bool(s._tasks), digest, seed, len(t["guardrails"]), len(demo_target()["guardrails"]), IDLE_RESEED_S):
        await reseed_demo(t, "shadowrun", "demo_reseeded_while_idle")


async def _reseed_when_idle() -> None:
    while True:
        await asyncio.sleep(120)
        if OPEN_DEMO:
            try:
                await _reseed_if_idle()
            except Exception:
                logging.getLogger("shadowrun.api").exception("idle reseed failed")


@app.post("/api/demo/reset")
async def demo_reset(target_id: str = DEMO_TARGET_ID, user: str = Depends(auth.current_user)) -> dict:
    limit(user, "demo resets", 120)
    t = svc().store.get_target(target_id)
    # This reseeds whatever database it's pointed at, so it must only ever reach the seeded demo.
    if not t or not t.get("demo_controls"):
        raise HTTPException(403, "only a demo target can be reset")
    if t and t["kind"] == "host":
        await svc().runner.host_ensure(t["host_id"], recreate=True)
        svc().store.append_event(None, user, "demo_reset", {"target": target_id})
        return {"ok": True}
    counts = await reseed_demo(t, user)
    return {"ok": True, "tables": counts}


@app.post("/api/redteam", status_code=201)
async def redteam_start(user: str = Depends(auth.current_user)) -> dict:
    running = [d for d in svc().store.list_redteam(3) if d.get("status") == "running" and time.time() - d["created_at"] < 300]
    if running:
        return running[0]
    limit(user, "red team runs", 12)
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
        doc = json.loads(RESULTS.read_text())
        reviewer = RESULTS.parent / "reviewer.json"
        if reviewer.exists():
            doc["reviewer"] = {k: v for k, v in json.loads(reviewer.read_text()).items() if k != "rows"}
        return doc
    return {"status": "not measured yet"}


@app.get("/api/audit")
def audit(after: int = 0, limit: int = 200, user: str = Depends(auth.current_user)) -> dict:
    s = svc().store
    return {"events": s.events(after=after, limit=min(limit, 1000)), "chain": s.verify_chain()}


@app.get("/api/health")
async def health() -> dict[str, Any]:
    out: dict[str, Any] = {"ok": True, "s3": evidence.s3_enabled(), "inference_base_is_vultr": llm.is_vultr_base(settings.INFERENCE_BASE), "planner_model": settings.PLANNER_MODEL}
    try:
        runner = await svc().runner.health()
        # Public, so it says what's working and leaves out the kernel and image a visitor would fingerprint.
        host = runner.get("host") or {}
        out["runner"] = {**runner, "host": {k: host.get(k) for k in ("hostname", "kvm_device", "kvm_rw")}}
        out["runner"].pop("image_digest", None)
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
