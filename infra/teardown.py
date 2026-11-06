#!/usr/bin/env python3
"""Remove every Shadow Run resource on Vultr, then confirm each one is gone (GET returns 404).

Finds resources from infra/STATE.json and also by tag or label, so a lost state file cannot
leave anything running. Only resources carrying the shadowrun tag or label are ever touched.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from provision import STATE_PATH, TAG, Vultr, load_env, load_state, save_state  # noqa: E402

import os  # noqa: E402


def inventory(v: Vultr) -> dict:
    return {
        "instances": [i for i in v.list("/instances", "instances") if TAG in (i.get("tags") or []) or i["label"].startswith(f"{TAG}-")],
        "databases": [d for d in v.list("/databases", "databases") if d["label"].startswith(f"{TAG}-") or d.get("tag") == TAG],
        "object_storages": [o for o in v.list("/object-storage", "object_storages") if o["label"] == TAG],
        "firewalls": [f for f in v.list("/firewalls", "firewall_groups") if f["description"].startswith(f"{TAG}-")],
        "vpcs": [n for n in v.list("/vpcs", "vpcs") if n["description"].startswith(f"{TAG}-")],
        "ssh_keys": [k for k in v.list("/ssh-keys", "ssh_keys") if k["name"] == TAG],
    }


PATHS = {
    "instances": "/instances",
    "databases": "/databases",
    "object_storages": "/object-storage",
    "firewalls": "/firewalls",
    "vpcs": "/vpcs",
    "ssh_keys": "/ssh-keys",
}


def delete_and_confirm(v: Vultr, kind: str, rid: str, timeout: int = 300) -> None:
    path = f"{PATHS[kind]}/{rid}"
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = v.http.delete(path)
        if r.status_code in (200, 204, 404):
            break
        time.sleep(5)  # dependents still detaching
    while time.time() - t0 < timeout:
        if v.http.get(path).status_code == 404:
            print(f"  destroyed {kind} {rid}: GET {path} -> 404")
            return
        time.sleep(5)
    raise SystemExit(f"{kind} {rid} was not confirmed destroyed within {timeout}s")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="list what would be removed, remove nothing")
    args = ap.parse_args()
    load_env()
    v = Vultr(os.environ["VULTR_API_KEY"])
    found = inventory(v)
    print("Shadow Run resources found:")
    for kind, items in found.items():
        for it in items:
            print(f"  {kind}: {it['id']} {it.get('label') or it.get('description') or it.get('name')}")
    if args.dry_run:
        return
    # Order matters: instances and databases first, because they hold the VPC and firewall groups.
    for kind in ("instances", "databases", "object_storages", "firewalls", "vpcs", "ssh_keys"):
        for it in found[kind]:
            delete_and_confirm(v, kind, it["id"])
    left = {k: len(items) for k, items in inventory(v).items() if items}
    if left:
        raise SystemExit(f"still present after teardown: {left}")
    state = load_state()
    state["torn_down_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for key in ("instances", "database_id", "object_storage_id", "firewalls", "vpc_id", "ssh_key_id", "postgres"):
        state.pop(key, None)
    if STATE_PATH.exists():
        save_state(state)
    print(json.dumps({"teardown": "complete", "remaining": 0}))


if __name__ == "__main__":
    main()
