#!/usr/bin/env python3
"""How much of the credit is left, and how long the current resources will last on it."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from provision import Vultr, load_env, load_state  # noqa: E402

import os  # noqa: E402

CEILING_USD = 200.0


def main() -> None:
    load_env()
    v = Vultr(os.environ["VULTR_API_KEY"])
    acct = v.call("GET", "/account")["account"]
    credit_left = -float(acct["balance"]) - float(acct["pending_charges"])
    spent = CEILING_USD - credit_left
    plans = {p["id"]: p for p in v.list("/plans", "plans")}
    hourly = 0.0
    lines = []
    for inst in v.list("/instances", "instances"):
        cost = plans.get(inst["plan"], {}).get("hourly_cost", 0.0)
        hourly += cost
        lines.append({"resource": inst["label"], "plan": inst["plan"], "usd_per_hour": cost})
    for d in v.list("/databases", "databases"):
        hourly += 30 / 730
        lines.append({"resource": d["label"], "plan": d["plan"], "usd_per_hour": round(30 / 730, 4)})
    for o in v.list("/object-storage", "object_storages"):
        hourly += 18 / 730
        lines.append({"resource": o["label"], "usd_per_hour": round(18 / 730, 4)})
    inference = [s for s in v.call("GET", "/inference").get("subscriptions", [])]
    print(json.dumps({
        "ceiling_usd": CEILING_USD,
        "spent_usd": round(spent, 2),
        "credit_left_usd": round(credit_left, 2),
        "burn_usd_per_hour": round(hourly, 3),
        "days_left_at_this_burn": round(credit_left / hourly / 24, 1) if hourly else None,
        "resources": lines,
        "inference_pending_usd": [s.get("pending_charges") for s in inference],
        "state_region": load_state().get("region"),
    }, indent=2))


if __name__ == "__main__":
    main()
