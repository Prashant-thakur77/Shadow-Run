"""Evidence bundle and pre-apply backup in Vultr Object Storage. Falls back to local disk in dev."""
from __future__ import annotations

import json
import logging
import os
import subprocess
import time
from pathlib import Path
from typing import Any

from control import settings
from control.approvals import _sign
from control.plan import canonical_json, sha256_hex
from control.snapshot import ProdConn

log = logging.getLogger("shadowrun.evidence")


def _s3():
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3", endpoint_url=settings.S3_ENDPOINT, aws_access_key_id=settings.S3_ACCESS_KEY,
        aws_secret_access_key=settings.S3_SECRET_KEY, config=Config(signature_version="s3v4", retries={"max_attempts": 4}),
    )


def s3_enabled() -> bool:
    return bool(settings.S3_ENDPOINT and settings.S3_ACCESS_KEY and settings.S3_SECRET_KEY and settings.S3_BUCKET)


def put_bytes(key: str, data: bytes, content_type: str = "application/octet-stream") -> dict:
    if s3_enabled():
        _s3().put_object(Bucket=settings.S3_BUCKET, Key=key, Body=data, ContentType=content_type)
        return {"store": "vultr-object-storage", "bucket": settings.S3_BUCKET, "key": key, "bytes": len(data)}
    path = settings.VAR / "evidence" / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {"store": "local", "path": str(path), "bytes": len(data)}


def presign(ref: dict | None, expires: int = 3600) -> str | None:
    if not ref or ref.get("store") != "vultr-object-storage":
        return None
    return _s3().generate_presigned_url("get_object", Params={"Bucket": ref["bucket"], "Key": ref["key"]}, ExpiresIn=expires)


def backup_prod(conn: ProdConn, run_id: str) -> dict:
    t0 = time.perf_counter()
    r = subprocess.run(["pg_dump", "-Fc", "--no-owner", "--no-privileges"], capture_output=True, env={**os.environ, **conn.libpq_env()})
    if r.returncode != 0:
        raise RuntimeError(f"pre-apply backup failed: {r.stderr.decode()[:400]}")
    ref = put_bytes(f"backups/{run_id}/pre-apply.dump", r.stdout)
    ref["ms"] = round((time.perf_counter() - t0) * 1000, 1)
    return ref


def build_bundle(run: dict) -> dict[str, Any]:
    final = next((a for a in run.get("attempts", []) if a["n"] == run.get("final_attempt")), None) or {}
    rec = final.get("rehearsal") or {}
    bundle = {
        "schema": "shadowrun.evidence/1",
        "run_id": run["id"],
        "created_at": time.time(),
        "target": run["target_id"],
        "task": run.get("task"),
        "requester": run["requester"],
        "source": run.get("source"),
        "plan": final.get("plan"),
        "plan_hash": run.get("plan_hash"),
        "guardrails": run.get("guardrails"),
        "guardrails_hash": run.get("guardrails_hash"),
        "snapshot": {k: run.get("snapshot", {}).get(k) for k in ("snapshot_id", "lsn", "digest", "server_version", "bytes")},
        "attempts": [{"n": a["n"], "verdict": a.get("verdict"), "plan_hash": a.get("plan_hash"), "failed_guardrails": [g["name"] for g in a.get("guardrails", []) if not g["passed"]]} for a in run.get("attempts", [])],
        "gate": final.get("gate"),
        "blast_radius": final.get("report"),
        "guardrail_results": final.get("guardrails"),
        "run_record": {k: rec.get(k) for k in ("sandbox", "host", "guest", "image", "limits", "probes", "secret_scan", "teardown", "phases", "contained")},
        "budget": final.get("budget"),
        "approval": run.get("approval"),
        "apply": run.get("apply"),
        "backup": run.get("backup"),
        "prod_check_around_rehearsal": run.get("prod_check"),
        "prod_checksum_after": run.get("prod_after"),
        "inference_usage": run.get("usage"),
        "inference_cost_usd": run.get("cost_usd"),
        "audit_chain_head": run.get("chain_head"),
    }
    bundle["bundle_sha256"] = sha256_hex(bundle)
    bundle["signature"] = _sign({"bundle_sha256": bundle["bundle_sha256"], "run_id": run["id"]})
    return bundle


def write_bundle(run: dict) -> dict:
    bundle = build_bundle(run)
    ref = put_bytes(f"runs/{run['id']}/evidence.json", json.dumps(bundle, indent=1, default=str).encode(), "application/json")
    ref["bundle_sha256"] = bundle["bundle_sha256"]
    return ref


__all__ = ["build_bundle", "write_bundle", "backup_prod", "put_bytes", "presign", "s3_enabled", "canonical_json"]
