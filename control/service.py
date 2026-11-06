"""Run orchestration: snapshot, agent loop, approval, apply, evidence. Shared by web, MCP and CLI."""
from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Any

import yaml

from control import approvals, evidence, llm, settings
from control.agent import describe_schema, draft_guardrails, draft_host_guardrails, run_loop
from control.apply import apply_host_plan, apply_plan
from control.approvals import ApprovalError
from control.plan import guardrails_hash, sha256_hex
from control.runner_client import RunnerClient, RunnerError
from control.snapshot import conn_from_target, fingerprint, take_snapshot
from control.store import Store

log = logging.getLogger("shadowrun.service")

DEMO_TARGET_ID = "demo-saas"
DEMO_HOST_ID = "demo-host"
ROOT = Path(__file__).resolve().parent.parent
TERMINAL = {"blocked", "applied", "rolled_back", "rejected", "drift_detected", "error", "no_change"}


def demo_target() -> dict:
    guardrails = yaml.safe_load((ROOT / "demo" / "guardrails.yaml").read_text())
    return {
        "id": DEMO_TARGET_ID,
        "name": "Demo SaaS billing database",
        "kind": "postgres",
        "connection": {
            "host": settings.PROD_HOST, "port": settings.PROD_PORT, "user": settings.PROD_USER,
            "password_env": "SHADOWRUN_PROD_PASSWORD", "dbname": settings.PROD_DB, "sslmode": settings.PROD_SSLMODE,
        },
        "guardrails": [{**g, "sql": g["sql"].strip(), "accepted_by": "project owner"} for g in guardrails],
        "budget": {"max_rows_changed": 100, "max_table_pct": 10.0, "max_cascade_rows": 0, "allow_drop": False, "allow_truncate": False, "allow_ddl": True},
        "auto_apply_within_budget": True,
        "demo_controls": True,
    }


def demo_host_target() -> dict:
    guardrails = yaml.safe_load((ROOT / "demo" / "host_guardrails.yaml").read_text())
    return {
        "id": DEMO_HOST_ID,
        "name": "Demo Linux server (nginx, cron, app files)",
        "kind": "host",
        "host_id": "demo",
        "guardrails": [{**g, "sh": g["sh"].strip(), "accepted_by": "project owner"} for g in guardrails],
        "budget": {"max_files_deleted": 20, "max_files_changed": 5, "max_services_stopped": 0},
        "auto_apply_within_budget": True,
        "demo_controls": True,
    }


def public_target(target: dict) -> dict:
    return {k: v for k, v in target.items() if k != "connection"} | {"guardrails_hash": guardrails_hash(target["guardrails"])}


class Service:
    def __init__(self, store: Store | None = None, runner: Any = None) -> None:
        self.store = store or Store()
        self.runner = runner or RunnerClient()
        self._tasks: set[asyncio.Task] = set()
        self._apply_lock = asyncio.Lock()
        if settings.PROD_HOST and self.store.get_target(DEMO_TARGET_ID) is None:
            self.store.save_target(demo_target())
        elif settings.PROD_HOST:
            t = demo_target()
            old = self.store.get_target(DEMO_TARGET_ID)
            if old:
                t["budget"] = old.get("budget", t["budget"])
            self.store.save_target(t)
        self.ensure_host_target()

    def ensure_host_target(self) -> None:
        old = self.store.get_target(DEMO_HOST_ID)
        t = demo_host_target()
        if old:
            t["budget"] = old.get("budget", t["budget"])
        self.store.save_target(t)

    # ---------------------------------------------------------------- snapshots

    async def ensure_snapshot(self, target: dict) -> dict:
        if target["kind"] == "host":
            await self.runner.host_ensure(target["host_id"])
            fp = await self.runner.host_fingerprint(target["host_id"])
            return {"snapshot_id": f"h{fp['digest'][:20]}", "digest": fp["digest"], "files": fp.get("files"), "services": fp.get("services"), "cached": True, "timing": {}, "tables": {}}
        conn = conn_from_target(target)
        fp = await asyncio.to_thread(fingerprint, conn)
        snapshot_id = f"s{fp['digest'][:20]}"
        if await self.runner.has_snapshot(snapshot_id):
            return {"snapshot_id": snapshot_id, "lsn": fp["lsn"], "tables": fp["tables"], "schema_sha256": fp["schema_sha256"], "digest": fp["digest"], "cached": True, "timing": {}}
        snap = await asyncio.to_thread(take_snapshot, conn)
        try:
            loaded = await self.runner.put_snapshot(snap["snapshot_id"], snap["dump_path"])
        finally:
            Path(snap["dump_path"]).unlink(missing_ok=True)
        snap.pop("dump_path")
        snap["golden"] = loaded
        snap["cached"] = False
        return snap

    async def inspection_for(self, target: dict, snapshot_id: str) -> dict:
        if target["kind"] == "host":
            return await self.runner.host_inspect(target["host_id"])
        return await self.inspection(snapshot_id)

    async def inspection(self, snapshot_id: str) -> dict:
        key = f"inspect:{snapshot_id}"
        cached = self.store.kv_get(key)
        if cached:
            return cached
        data = await self.runner.inspect(snapshot_id)
        if not data.get("ok"):
            raise RunnerError(f"inspect failed: {data.get('error')}")
        self.store.kv_set(key, data)
        return data

    async def scan_suspect_rows(self, snapshot_id: str) -> list[dict]:
        """Stored text that reads like instructions, with a second opinion from the safety model."""
        key = f"suspects:{snapshot_id}"
        cached = self.store.kv_get(key)
        if cached is not None:
            return cached
        found = (await self.runner.suspects(snapshot_id)).get("suspects", [])
        out = []
        for row in found[:5]:
            try:
                verdict = await asyncio.to_thread(llm.safety_verdict, row["text"])
            except llm.LLMError as e:
                verdict = {"verdict": "error", "raw": str(e)[:120]}
            out.append({"table": row["table"], "column": row["column"], "preview": row["text"][:240], **verdict})
        self.store.kv_set(key, out)
        return out

    # ---------------------------------------------------------------- run lifecycle

    def new_run(self, target_id: str, requester: str, task: str | None, steps: list[dict] | None, source: str) -> dict:
        target = self.store.get_target(target_id)
        if target is None:
            raise KeyError(target_id)
        run = {
            "id": f"r{uuid.uuid4().hex[:14]}",
            "created_at": time.time(),
            "status": "queued",
            "requester": requester,
            "target_id": target_id,
            "task": task,
            "submitted_steps": steps,
            "source": source,
            "guardrails": target["guardrails"],
            "guardrails_hash": guardrails_hash(target["guardrails"]),
            "attempts": [],
            "usage": [],
            "cost_usd": 0.0,
            "timeline": [],
        }
        self.store.save_run(run)
        self.event(run, "run_created", {"source": source})
        return run

    def event(self, run: dict, type_: str, detail: dict | None = None, actor: str = "shadowrun") -> None:
        ev = self.store.append_event(run["id"], actor, type_, detail or {})
        run.setdefault("timeline", []).append({"t": ev["ts"], "type": type_, "actor": actor, "detail": detail or {}, "seq": ev["seq"]})
        run["chain_head"] = ev["sha256"]

    def start(self, run: dict) -> None:
        task = asyncio.create_task(self._drive(run["id"]))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _set_usage(self, run: dict, sink: list[dict]) -> None:
        run["usage"] = sink
        run["cost_usd"] = round(sum(u["cost_usd"] for u in sink), 6)

    async def _drive(self, run_id: str) -> None:
        run = self.store.get_run(run_id)
        target = self.store.get_target(run["target_id"])
        sink: list[dict] = []
        llm.usage_sink.set(sink)

        def on_event(type_: str, detail: dict) -> None:
            self.event(run, type_, detail)
            status = {"planning": "planning", "rehearsal_started": "rehearsing"}.get(type_)
            if status:
                run["status"] = status
            self._set_usage(run, sink)
            self.store.save_run(run)

        try:
            run["status"] = "snapshotting"
            self.store.save_run(run)
            t0 = time.perf_counter()
            snap = await self.ensure_snapshot(target)
            run["snapshot"] = snap
            on_event("snapshot_taken", {"snapshot_id": snap["snapshot_id"], "lsn": snap.get("lsn"), "cached": snap["cached"], "ms": round((time.perf_counter() - t0) * 1000, 1)})
            inspection = await self.inspection_for(target, snap["snapshot_id"])
            run["inspection_summary"] = {"tables": len(inspection.get("tables", [])), "foreign_keys": len(inspection.get("foreign_keys", []))}
            run["data_flags"] = []
            if target["kind"] == "postgres":
                try:
                    run["data_flags"] = await self.scan_suspect_rows(snap["snapshot_id"])
                    if run["data_flags"]:
                        on_event("injected_text_flagged", {"rows": len(run["data_flags"]), "unsafe": sum(1 for f in run["data_flags"] if f.get("verdict") == "unsafe")})
                except RunnerError as e:
                    log.warning("suspect scan failed: %s", e)

            run["attempts"] = []
            result = await run_loop(
                task=run["task"], fixed_steps=run.get("submitted_steps"), target=target, guardrails=run["guardrails"],
                run_id=run["id"], snapshot_id=snap["snapshot_id"], runner=self.runner, inspection=inspection, on_event=on_event,
                attempts=run["attempts"],
            )
            final = result["final"]
            run["final_attempt"] = final["n"]
            self._set_usage(run, sink)
            await self._prod_check(run, target, snap)
            await self._conclude(run, target, final)
        except Exception as e:
            log.exception("run %s failed", run_id)
            run["status"] = "error"
            run["error"] = f"{type(e).__name__}: {str(e)[:500]}"
            self.event(run, "run_error", {"error": run["error"]})
            self._set_usage(run, sink)
            self.store.save_run(run)

    async def _prod_check(self, run: dict, target: dict, snap: dict) -> None:
        """Hash prod again from outside the sandbox. A rehearsal, whatever it did, must leave this unchanged."""
        try:
            if target["kind"] == "host":
                digest = (await self.runner.host_fingerprint(target["host_id"])).get("digest")
            else:
                digest = (await asyncio.to_thread(fingerprint, conn_from_target(target)))["digest"]
            run["prod_check"] = {"before": snap.get("digest"), "after": digest, "unchanged": digest == snap.get("digest"), "measured_from": "control plane, outside the sandbox"}
            self.event(run, "prod_checked", {"unchanged": run["prod_check"]["unchanged"]})
        except Exception as e:
            run["prod_check"] = {"error": f"{type(e).__name__}: {str(e)[:200]}", "unchanged": None}

    async def _conclude(self, run: dict, target: dict, final: dict) -> None:
        verdict = final.get("verdict")
        if verdict != "passed":
            run["status"] = "blocked"
            run["blocked_reason"] = {
                "blocked_by_gate": "The static gate refused the plan.",
                "failed_guardrails": "A guardrail failed on the clone. Guardrails are frozen and cannot be approved past.",
                "sql_error": f"The plan failed on the clone: {final.get('error')}",
                "sandbox_error": f"The sandbox failed, and unknown is not safe: {final.get('error')}",
                "invalid_plan": f"The agent did not produce a valid plan: {final.get('error')}",
            }.get(verdict, str(verdict))
            run["plan_hash"] = final.get("plan_hash")
            self.event(run, "run_blocked", {"reason": verdict, "attempts": len(run["attempts"])})
            self.store.save_run(run)
            return

        run["plan_hash"] = final["plan_hash"]
        run["report_hash"] = final["report_hash"]
        totals = final.get("report", {}).get("totals", {})
        changed = totals.get("rows_changed", 0) or totals.get("ddl_commands", 0) or totals.get("files_created", 0) or totals.get("files_deleted", 0) or totals.get("files_changed", 0) or totals.get("services_stopped", 0)
        if not changed:
            # Nothing to apply, so nothing reaches prod and nobody is asked to approve anything.
            run["status"] = "no_change"
            self.event(run, "no_change", {"note": "The rehearsal changed nothing, so nothing was applied."})
            self.store.save_run(run)
            return
        approvals.open_challenge(run)
        within = final["budget"]["within"]
        if within and target.get("auto_apply_within_budget"):
            run["status"] = "approved"
            run["approval"] = approvals.grant_auto(run)
            self.event(run, "auto_approved_within_budget", {"limits": final["budget"]["limits"]})
            self.store.save_run(run)
            await self.apply(run["id"], actor="budget-policy")
            return
        run["status"] = "awaiting_approval"
        self.event(run, "awaiting_approval", {"reasons": final["budget"]["reasons"]})
        self.store.save_run(run)

    # ---------------------------------------------------------------- approve, reject

    def approve(self, run_id: str, approver: str, presented: dict) -> dict:
        run = self.store.get_run(run_id)
        if run is None:
            raise ApprovalError(404, "run not found")
        approval = approvals.grant(run, approver, presented)
        swapped = self.store.set_status_if(run_id, "awaiting_approval", "approved")
        if swapped is None:
            raise ApprovalError(409, "this run was already decided; an approval is one-use")
        swapped["approval"] = approval
        self.event(swapped, "approved", {"approver": approver, "plan_hash": approval["plan_hash"]}, actor=approver)
        self.store.save_run(swapped)
        return swapped

    def reject(self, run_id: str, approver: str, reason: str) -> dict:
        run = self.store.get_run(run_id)
        if run is None:
            raise ApprovalError(404, "run not found")
        swapped = self.store.set_status_if(run_id, "awaiting_approval", "rejected")
        if swapped is None:
            raise ApprovalError(409, "this run was already decided")
        swapped["rejection"] = {"by": approver, "reason": reason[:500], "at": time.time()}
        self.event(swapped, "rejected", {"by": approver, "reason": reason[:200]}, actor=approver)
        self.store.save_run(swapped)
        return swapped

    # ---------------------------------------------------------------- apply

    async def apply(self, run_id: str, actor: str, drift_check: bool = True) -> dict:
        run = self.store.set_status_if(run_id, "approved", "applying")
        if run is None:
            current = self.store.get_run(run_id)
            if current is None:
                raise ApprovalError(404, "run not found")
            if current["status"] == "awaiting_approval":
                raise ApprovalError(409, "this run has no approval yet")
            raise ApprovalError(409, f"this run is {current['status']}; an approval can be used once")
        approvals.verify(run, run.get("approval"))
        if not self.store.consume_nonce(run["approval"]["nonce"], run_id):
            raise ApprovalError(409, "this approval was already used")
        target = self.store.get_target(run["target_id"])
        if not drift_check and not target.get("demo_controls"):
            self.store.set_status_if(run_id, "applying", "approved")
            raise ApprovalError(403, "the drift check can only be turned off on a demo target")
        final = next(a for a in run["attempts"] if a["n"] == run["final_attempt"])
        self.event(run, "apply_started", {"plan_hash": run["plan_hash"], "drift_check": drift_check}, actor=actor)
        self.store.save_run(run)
        if target["kind"] == "host":
            return await self._apply_host(run, target, final, drift_check)
        conn = conn_from_target(target)
        steps = [{"statements": s["statements"]} for s in final["plan"]["steps"]]
        async with self._apply_lock:
            try:
                run["backup"] = await asyncio.to_thread(evidence.backup_prod, conn, run_id)
                self.event(run, "backup_written", {k: run["backup"].get(k) for k in ("store", "bytes", "ms")})
                out = await asyncio.to_thread(
                    apply_plan, conn, steps, run["guardrails"], final["rehearsal"]["result"], run["snapshot"]["tables"], check_drift=drift_check,
                )
            except Exception as e:
                log.exception("apply %s failed", run_id)
                out = {"outcome": "rolled_back", "reason": f"apply could not run: {type(e).__name__}: {str(e)[:300]}"}
        run["apply"] = out
        run["status"] = {"committed": "applied", "drift_detected": "drift_detected"}.get(out["outcome"], "rolled_back")
        self.event(run, f"apply_{out['outcome']}", {"reason": out.get("reason"), "counts": out.get("actual_counts")})
        try:
            run["prod_after"] = (await asyncio.to_thread(fingerprint, conn))["digest"]
        except Exception as e:
            run["prod_after"] = f"unavailable: {e}"
        try:
            run["evidence"] = await asyncio.to_thread(evidence.write_bundle, run)
            self.event(run, "evidence_written", {k: run["evidence"].get(k) for k in ("store", "key", "bundle_sha256")})
        except Exception as e:
            log.exception("evidence for %s failed", run_id)
            run["evidence"] = {"error": str(e)[:300]}
        self.store.save_run(run)
        return run

    async def _apply_host(self, run: dict, target: dict, final: dict, drift_check: bool) -> dict:
        host_id = target["host_id"]
        async with self._apply_lock:
            try:
                out = await apply_host_plan(
                    self.runner, host_id, [{"cmd": s["cmd"]} for s in final["plan"]["steps"]], run["guardrails"],
                    final["rehearsal"]["result"], run["snapshot"].get("digest"), check_drift=drift_check,
                )
            except Exception as e:
                log.exception("host apply %s failed", run["id"])
                out = {"outcome": "rolled_back", "reason": f"apply could not finish: {type(e).__name__}: {str(e)[:300]}"}
        run["apply"] = out
        run["status"] = {"committed": "applied", "drift_detected": "drift_detected"}.get(out["outcome"], "rolled_back")
        self.event(run, f"apply_{out['outcome']}", {"reason": out.get("reason")})
        try:
            run["prod_after"] = (await self.runner.host_fingerprint(host_id)).get("digest")
            run["evidence"] = await asyncio.to_thread(evidence.write_bundle, run)
            self.event(run, "evidence_written", {k: run["evidence"].get(k) for k in ("store", "key", "bundle_sha256")})
        except Exception as e:
            log.exception("evidence for %s failed", run["id"])
            run["evidence"] = {"error": str(e)[:300]}
        self.store.save_run(run)
        return run

    def rehearse_again(self, run_id: str, requester: str) -> dict:
        """Prod drifted: same plan, new snapshot, new rehearsal. Nothing carries over from the old one."""
        old = self.store.get_run(run_id)
        if old is None:
            raise KeyError(run_id)
        final = next((a for a in old["attempts"] if a["n"] == old.get("final_attempt")), None)
        if final is None or "plan" not in final:
            raise ValueError("that run has no plan to rehearse again")
        steps = [{"type": s["type"], "cmd": s["cmd"], "why": s.get("why", "")} for s in final["plan"]["steps"]]
        run = self.new_run(old["target_id"], requester, old.get("task"), steps, "rehearse_again")
        run["rehearses_again"] = run_id
        self.store.save_run(run)
        self.start(run)
        return run

    # ---------------------------------------------------------------- guardrails

    async def draft_guardrails(self, target_id: str) -> list[dict]:
        target = self.store.get_target(target_id)
        snap = await self.ensure_snapshot(target)
        inspection = await self.inspection_for(target, snap["snapshot_id"])
        if target["kind"] == "host":
            drafts = await asyncio.to_thread(draft_host_guardrails, describe_schema(inspection))
            # Model-written commands run on a clone only, never on the real host.
            rec = await self.runner.host_rehearse(f"g{uuid.uuid4().hex[:12]}", target["host_id"], [], [{"id": d["id"], "name": d["name"], "sh": d["sh"]} for d in drafts])
            results = {g["id"]: g for g in (rec.get("result") or {}).get("guardrails", [])}
            for d in drafts:
                d["holds_today"] = results.get(d["id"], {}).get("passed") is True
                d["error"] = results.get(d["id"], {}).get("error")
            return drafts
        drafts = await asyncio.to_thread(draft_guardrails, describe_schema(inspection))
        # A guardrail that already fires on the unchanged database is wrong, so test each draft on a clone.
        rec = await self.runner.rehearse(f"g{uuid.uuid4().hex[:12]}", snap["snapshot_id"], [], [{"id": d["id"], "name": d["name"], "sql": d["sql"]} for d in drafts])
        results = {g["id"]: g for g in (rec.get("result") or {}).get("guardrails", [])}
        for d in drafts:
            r = results.get(d["id"], {})
            d["holds_today"] = r.get("passed") is True
            d["error"] = r.get("error")
        return drafts

    def accept_guardrails(self, target_id: str, guardrails: list[dict], who: str) -> dict:
        target = self.store.get_target(target_id)
        if target is None:
            raise KeyError(target_id)
        target["guardrails"] = [{"id": g["id"], "name": g["name"], "sql": g["sql"], "why": g.get("why", ""), "accepted_by": who} for g in guardrails]
        self.store.save_target(target)
        self.store.append_event(None, who, "guardrails_accepted", {"target": target_id, "hash": guardrails_hash(target["guardrails"])})
        return target

    # ---------------------------------------------------------------- red team

    def start_redteam(self, requester: str) -> dict:
        rid = f"rt{uuid.uuid4().hex[:12]}"
        doc = {"id": rid, "created_at": time.time(), "requester": requester, "status": "running", "attacks": [], "expected": 7}
        self.store.save_redteam(rid, doc)
        task = asyncio.create_task(self._drive_redteam(doc))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return doc

    async def _drive_redteam(self, doc: dict) -> None:
        target = self.store.get_target(DEMO_TARGET_ID)
        try:
            conn = conn_from_target(target)
            snap = await self.ensure_snapshot(target)
            doc["snapshot_id"] = snap["snapshot_id"]
            doc["prod_before"] = (await asyncio.to_thread(fingerprint, conn))["digest"]
            self.store.save_redteam(doc["id"], doc)
            for attack in await self.runner.attacks():
                result = await self.runner.redteam(attack["id"], snap["snapshot_id"])
                doc["attacks"].append(result)
                doc["prod_during"] = (await asyncio.to_thread(fingerprint, conn))["digest"]
                self.store.save_redteam(doc["id"], doc)
            try:
                doc["wall_two"] = await self.runner.wall_two(snap["snapshot_id"])
            except RunnerError as e:
                doc["wall_two"] = {"error": str(e)[:300]}
            doc["prod_after"] = (await asyncio.to_thread(fingerprint, conn))["digest"]
            doc["prod_unchanged"] = doc["prod_before"] == doc["prod_after"]
            doc["contained"] = sum(1 for a in doc["attacks"] if a["contained"])
            doc["total"] = len(doc["attacks"])
            doc["status"] = "done"
            self.store.append_event(None, doc["requester"], "redteam_finished", {"id": doc["id"], "contained": doc["contained"], "total": doc["total"], "prod_unchanged": doc["prod_unchanged"]})
        except Exception as e:
            log.exception("red team failed")
            doc["status"] = "error"
            doc["error"] = f"{type(e).__name__}: {str(e)[:400]}"
        self.store.save_redteam(doc["id"], doc)


__all__ = ["Service", "DEMO_TARGET_ID", "TERMINAL", "demo_target", "public_target", "sha256_hex", "os"]
