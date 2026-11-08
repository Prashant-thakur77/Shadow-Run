"""The pull request comment. No network."""
from control.cli import EXIT, markdown


def run(**kw):
    return {
        "id": "r1", "status": "blocked", "plan_hash": "abc123def456789", "blocked_reason": "A guardrail failed on the clone.",
        "final": {
            "report": {"sentences": [{"text": "2804 invoices deleted via cascade from users (step 1)"}], "metrics": [{"name": "Paid invoices on record", "before": 100.0, "after": 40.0}, {"name": "Live users", "before": 5.0, "after": 5.0}]},
            "guardrails": [{"name": "No paid invoice is lost", "passed": False}, {"name": "Core tables still exist", "passed": True}],
            "gate": {"findings": [{"rule": "drop", "reason": "DROP destroys the object"}]},
            "undo": {"verified": True},
        },
        **kw,
    }


def test_the_comment_says_what_was_measured():
    text = markdown(run())
    assert "Blocked" in text and "2804 invoices deleted via cascade" in text
    assert "Paid invoices on record | 100 | 40" in text
    assert "Live users" not in text, "only metrics that moved"
    assert "1 of 2 passed" in text and "Failed: No paid invoice is lost" in text
    assert "`drop`" in text and "proved on the clone" in text


def test_a_run_with_no_report_still_renders():
    assert "Blocked" in markdown({"id": "r", "status": "blocked", "final": None})


def test_exit_codes_for_ci():
    assert EXIT["applied"] == 0 and EXIT["no_change"] == 0
    assert EXIT["awaiting_approval"] == 2 and EXIT["blocked"] == 3 and EXIT["rolled_back"] == 4 and EXIT["drift_detected"] == 4


def test_a_rehearse_only_comment_says_nothing_reached_prod():
    assert "Nothing reached prod" in markdown(run(status="awaiting_approval", rehearse_only=True))
    assert "Nothing reached prod" not in markdown(run(status="awaiting_approval"))


def test_a_rehearsal_only_comment_points_at_the_mcp_setup(monkeypatch):
    monkeypatch.setenv("SHADOWRUN_URL", "https://demo.example")
    text = markdown(run(status="awaiting_approval", rehearse_only=True))
    assert "https://demo.example/mcp" in text and "#try-it" in text


def test_a_normal_run_has_no_setup_footer():
    assert "/mcp" not in markdown(run(status="awaiting_approval"))
