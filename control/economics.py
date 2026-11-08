"""What it costs to serve one protected database on Vultr, for the Who pays page. The costs are measured (the benchmark's
own records and Vultr's list prices), the price is the plan in docs/market.json. The arithmetic is the README's cost-to-serve
table, scripts/make_readme_table.py economics(), and tests/test_economics.py holds the two to the same answer."""
from __future__ import annotations


def economics(results: dict | None, vultr: dict | None, market: dict | None) -> dict | None:
    """None when any input is missing, so a page shows nothing rather than a number with a hole in it."""
    if not results or not vultr or not market:
        return None
    s = ((results.get("all_risky_and_safe") or {}).get("shadow_run") or {})
    price = (market.get("price") or {}).get("usd_per_database_month")
    if not s.get("cost_per_task_usd") or not s.get("seconds_per_task") or not results.get("vx1_usd_per_hour") or not price:
        return None
    inf, secs, vx1 = s["cost_per_task_usd"], s["seconds_per_task"], results["vx1_usd_per_hour"]
    # An upper bound: the whole VX1 host, for the task's whole wall time, although a host runs several rehearsals at once.
    vx1_task = vx1 * secs / 3600
    per_task = inf + vx1_task
    # One deployment: the control VM, the VX1 host and the bucket. Prod is the customer's own database, so it isn't counted.
    res = (((vultr.get("spend") or {}).get("budget") or {}).get("resources") or [])
    fixed_parts = [x for x in res if "dbaas" not in (x.get("plan") or "")]
    fixed = sum(x["usd_per_hour"] for x in fixed_parts) * 24 * 30 if fixed_parts else None
    tasks = 1000
    out = dict(tasks=s.get("risky_tasks", 0) + s.get("safe_tasks", 0), inf=inf, secs=secs, vx1=vx1, vx1_task=vx1_task, per_task=per_task, per_k=per_task * 1000, price=price, fixed=fixed)
    if fixed is not None:
        out["margin_one_db"] = (price - fixed - per_task * tasks) / price
        out["margin_k"] = {k: (k * price - fixed - k * per_task * tasks) / (k * price) for k in (1, 2, 3)}
        out["tasks_to_cost"] = (price - fixed) / per_task
    return out


def served_db_mb(scale: dict | None) -> int | None:
    """The largest database a full rehearsal finished on (bench/scale.json), the size the hosted tier is offered up to today.
    The same choice as the README's size_line()."""
    ok = [r for r in (scale or {}).get("rows", []) if not r.get("errors") and r.get("rehearsal_total_s")]
    return max(r["db_mb"] for r in ok) if ok else None
