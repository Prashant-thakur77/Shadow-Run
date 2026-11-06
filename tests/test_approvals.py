"""Maker-checker, digest binding, replay, expiry and the signature. No VM or database needed."""
import time

import pytest

from control import approvals, settings
from control.approvals import ApprovalError


@pytest.fixture(autouse=True)
def secret(monkeypatch):
    monkeypatch.setattr(settings, "HMAC_SECRET", "test-secret")


def run(**kw):
    r = {"id": "r1", "status": "awaiting_approval", "requester": "alice", "plan_hash": "p" * 64, "guardrails_hash": "g" * 64, "report_hash": "h" * 64}
    approvals.open_challenge(r)
    r.update(kw)
    return r


def presented(r, **kw):
    return {"plan_hash": r["plan_hash"], "guardrails_hash": r["guardrails_hash"], "report_hash": r["report_hash"], "nonce": r["approval_nonce"], **kw}


def test_grant_and_verify():
    r = run()
    a = approvals.grant(r, "bob", presented(r))
    approvals.verify(r, a)
    assert a["approver_id"] == "bob"


def test_requester_cannot_approve():
    r = run()
    with pytest.raises(ApprovalError) as e:
        approvals.grant(r, "alice", presented(r))
    assert e.value.status == 403


@pytest.mark.parametrize("field", ["plan_hash", "guardrails_hash", "report_hash", "nonce"])
def test_changed_value_is_409(field):
    r = run()
    with pytest.raises(ApprovalError) as e:
        approvals.grant(r, "bob", presented(r, **{field: "x"}))
    assert e.value.status == 409


def test_decided_run_is_409():
    r = run(status="approved")
    with pytest.raises(ApprovalError) as e:
        approvals.grant(r, "bob", presented(r))
    assert e.value.status == 409


def test_expired_is_410():
    r = run(approval_expires_at=time.time() - 1)
    with pytest.raises(ApprovalError) as e:
        approvals.grant(r, "bob", presented(r))
    assert e.value.status == 410


@pytest.mark.parametrize("field,value", [("plan_hash", "z" * 64), ("approver_id", "mallory"), ("kind", "auto_budget")])
def test_forged_approval_fails_signature(field, value):
    r = run()
    a = approvals.grant(r, "bob", presented(r))
    with pytest.raises(ApprovalError):
        approvals.verify(r, {**a, field: value})


def test_approval_for_a_run_whose_plan_changed_fails():
    r = run()
    a = approvals.grant(r, "bob", presented(r))
    r["plan_hash"] = "q" * 64
    with pytest.raises(ApprovalError):
        approvals.verify(r, a)


def test_missing_approval_fails():
    with pytest.raises(ApprovalError):
        approvals.verify(run(), None)
