"""A plan that's too big is refused before anything parses it."""
import pytest

from control.limits import MAX_PLAN_BYTES, MAX_STEP_BYTES, MAX_STEPS, plan_too_big


@pytest.mark.parametrize("steps,word", [
    ([{"cmd": "SELECT 1"}] * (MAX_STEPS + 1), "steps"),
    ([{"cmd": "x" * (MAX_STEP_BYTES + 1)}], "step"),
    ([{"cmd": "x" * MAX_STEP_BYTES}] * 3, "plan"),
    ([{"cmd": "é" * (MAX_STEP_BYTES // 2 + 1)}], "step"),  # bytes, not characters
])
def test_a_plan_that_is_too_big_says_why(steps, word):
    assert word in plan_too_big(steps)


@pytest.mark.parametrize("steps", [
    [{"cmd": "SELECT 1"}],
    [{"cmd": "x" * MAX_STEP_BYTES}, {"cmd": "y" * MAX_STEP_BYTES}, {"cmd": "z" * (MAX_PLAN_BYTES - 2 * MAX_STEP_BYTES)}],
    "not a list",  # the plan's own check rejects this one
    [{"no_cmd": True}, "not a step"],
])
def test_a_plan_of_a_normal_size_passes(steps):
    assert plan_too_big(steps) is None
