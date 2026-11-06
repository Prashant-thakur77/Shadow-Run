"""Approval bound to exact bytes. A changed or replayed approval returns 409, an expired one 410.

Digest-bound decisions adapted from Airlock; HMAC maker-checker adapted from Tieout.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time

from control import settings


class ApprovalError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def _sign(fields: dict) -> str:
    key = settings.require_secret("SHADOWRUN_HMAC_SECRET", settings.HMAC_SECRET).encode()
    canon = json.dumps(fields, sort_keys=True, separators=(",", ":")).encode()
    return hmac.new(key, canon, hashlib.sha256).hexdigest()


def challenge(run: dict) -> dict:
    """What the approver is asked to sign off on. The UI sends these same values back."""
    return {
        "run_id": run["id"],
        "plan_hash": run["plan_hash"],
        "guardrails_hash": run["guardrails_hash"],
        "report_hash": run["report_hash"],
        "nonce": run["approval_nonce"],
        "expires_at": run["approval_expires_at"],
    }


def open_challenge(run: dict) -> None:
    run["approval_nonce"] = secrets.token_hex(16)
    run["approval_expires_at"] = time.time() + settings.APPROVAL_TTL_S


def grant(run: dict, approver: str, presented: dict) -> dict:
    """Check the presented digests against the run, then sign. Raises ApprovalError on any mismatch."""
    if approver == run["requester"]:
        raise ApprovalError(403, "maker-checker: the requester of a run cannot approve it")
    if run["status"] != "awaiting_approval":
        raise ApprovalError(409, f"this run is {run['status']}; an approval is one-use")
    if time.time() >= run["approval_expires_at"]:
        raise ApprovalError(410, "the approval window closed; rehearse again")
    for field in ("plan_hash", "guardrails_hash", "report_hash", "nonce"):
        expected = run["approval_nonce"] if field == "nonce" else run[field]
        if not hmac.compare_digest(str(presented.get(field, "")), str(expected)):
            raise ApprovalError(409, f"{field} does not match the rehearsed run: approve exactly what you reviewed")
    fields = {
        "run_id": run["id"], "plan_hash": run["plan_hash"], "guardrails_hash": run["guardrails_hash"],
        "report_hash": run["report_hash"], "approver_id": approver, "nonce": run["approval_nonce"], "kind": "human",
    }
    return {**fields, "granted_at": time.time(), "signature": _sign(fields)}


def grant_auto(run: dict) -> dict:
    fields = {
        "run_id": run["id"], "plan_hash": run["plan_hash"], "guardrails_hash": run["guardrails_hash"],
        "report_hash": run["report_hash"], "approver_id": "budget-policy", "nonce": run["approval_nonce"], "kind": "auto_budget",
    }
    return {**fields, "granted_at": time.time(), "signature": _sign(fields)}


def verify(run: dict, approval: dict | None) -> None:
    """Called at apply time. Re-derives everything from the run, so a tampered record fails."""
    if not approval:
        raise ApprovalError(409, "no approval on this run")
    fields = {k: approval.get(k) for k in ("run_id", "plan_hash", "guardrails_hash", "report_hash", "approver_id", "nonce", "kind")}
    if not hmac.compare_digest(_sign(fields), str(approval.get("signature", ""))):
        raise ApprovalError(409, "approval signature does not verify")
    for field in ("plan_hash", "guardrails_hash", "report_hash"):
        if fields[field] != run[field]:
            raise ApprovalError(409, f"{field} changed after approval")
    if fields["run_id"] != run["id"]:
        raise ApprovalError(409, "approval belongs to a different run")
