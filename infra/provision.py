#!/usr/bin/env python3
"""Create everything Shadow Run needs on Vultr, from zero. Safe to re-run: it finds before it creates.

Hard limit enforced in code: 2 VMs, 1 Managed Postgres, 1 Object Storage subscription, 1 bucket.
Resource ids go to infra/STATE.json (gitignored). Secrets returned by the API go to .env only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
STATE_PATH = ROOT / "infra" / "STATE.json"
ENV_PATH = ROOT / ".env"
SSH_DIR = ROOT / "infra" / ".ssh"
SSH_KEY = SSH_DIR / "shadowrun_ed25519"
API = "https://api.vultr.com/v2"

TAG = "shadowrun"
OS_UBUNTU_2404 = 2284
VPC_SUBNET = "10.77.0.0"
VPC_MASK = 24
CONTROL_PLAN = "vc2-2c-4gb"
VX1_PLAN = "vx1-g-4c-16g-240s"
PG_VERSION = "16"
BUCKET_PREFIX = "shadowrun-evidence"
MAX_VMS = 2


def load_env() -> None:
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ[k.strip()] = v.strip()


@contextmanager
def reachable(admin: dict) -> Iterator[dict]:
    """Connection details that work from here. Some networks block Postgres's high port, so if the public host
    doesn't answer, this goes through the control VM over SSH, which reaches the database inside the VPC."""
    try:
        socket.create_connection((admin["host"], int(admin["port"])), timeout=6).close()
        yield admin
        return
    except OSError:
        pass
    control = load_state()["instances"]["control"]["main_ip"]
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        local_port = probe.getsockname()[1]
    print(f"{admin['host']}:{admin['port']} isn't reachable from this network, so going through the control VM")
    forward = f"127.0.0.1:{local_port}:{os.environ['SHADOWRUN_PROD_VPC_HOST']}:{admin['port']}"
    tunnel = subprocess.Popen(["ssh", "-i", str(SSH_KEY), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-N", "-L", forward, f"root@{control}"])
    try:
        for _ in range(40):
            try:
                socket.create_connection(("127.0.0.1", local_port), timeout=1).close()
                break
            except OSError:
                if tunnel.poll() is not None:
                    raise RuntimeError("the SSH tunnel to the control VM closed") from None
                time.sleep(0.5)
        else:
            raise RuntimeError("the SSH tunnel to the control VM didn't open")
        yield {**admin, "host": "127.0.0.1", "port": str(local_port)}
    finally:
        tunnel.terminate()


def set_env(values: dict[str, str]) -> None:
    """Store secrets in .env (mode 600). Existing keys are replaced, nothing is printed."""
    text = ENV_PATH.read_text() if ENV_PATH.exists() else ""
    for k, v in values.items():
        line = f"{k}={v}"
        if re.search(rf"^{re.escape(k)}=", text, flags=re.M):
            text = re.sub(rf"^{re.escape(k)}=.*$", lambda _: line, text, flags=re.M)
        else:
            text = text.rstrip("\n") + f"\n{line}\n"
        os.environ[k] = v
    ENV_PATH.write_text(text)
    ENV_PATH.chmod(0o600)


class Vultr:
    def __init__(self, key: str) -> None:
        self.http = httpx.Client(base_url=API, headers={"Authorization": f"Bearer {key}"}, timeout=60)

    def call(self, method: str, path: str, body: dict | None = None, ok=(200, 201, 202, 204)) -> dict:
        for attempt in range(5):
            r = self.http.request(method, path, json=body)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(2 * (attempt + 1))
                continue
            if r.status_code not in ok:
                raise SystemExit(f"Vultr {method} {path} -> {r.status_code}: {r.text[:400]}")
            return r.json() if r.content else {}
        raise SystemExit(f"Vultr {method} {path}: gave up after retries ({r.status_code})")

    def list(self, path: str, key: str) -> list[dict]:
        out: list[dict] = []
        cursor = ""
        while True:
            q = f"{path}?per_page=500" + (f"&cursor={cursor}" if cursor else "")
            d = self.call("GET", q)
            out += d.get(key, [])
            cursor = (d.get("meta", {}).get("links") or {}).get("next", "")
            if not cursor:
                return out


def load_state() -> dict:
    return json.loads(STATE_PATH.read_text()) if STATE_PATH.exists() else {}


def save_state(state: dict) -> None:
    STATE_PATH.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")


def my_public_ip() -> str:
    return httpx.get("https://api.ipify.org", timeout=15).text.strip()


def ensure_ssh_key(v: Vultr, state: dict) -> str:
    SSH_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not SSH_KEY.exists():
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "shadowrun-deploy", "-f", str(SSH_KEY)], check=True)
    pub = SSH_KEY.with_suffix(".pub").read_text().strip()
    for k in v.list("/ssh-keys", "ssh_keys"):
        if k["name"] == TAG:
            state["ssh_key_id"] = k["id"]
            return k["id"]
    k = v.call("POST", "/ssh-keys", {"name": TAG, "ssh_key": pub})["ssh_key"]
    state["ssh_key_id"] = k["id"]
    return k["id"]


def ensure_vpc(v: Vultr, state: dict, region: str) -> str:
    for n in v.list("/vpcs", "vpcs"):
        if n["description"] == f"{TAG}-vpc":
            state["vpc_id"] = n["id"]
            return n["id"]
    n = v.call("POST", "/vpcs", {"region": region, "description": f"{TAG}-vpc", "v4_subnet": VPC_SUBNET, "v4_subnet_mask": VPC_MASK})["vpc"]
    state["vpc_id"] = n["id"]
    return n["id"]


def ensure_firewall(v: Vultr, state: dict, name: str, public_ports: list[str], admin_ip: str) -> str:
    desc = f"{TAG}-{name}"
    group = next((g for g in v.list("/firewalls", "firewall_groups") if g["description"] == desc), None)
    if group is None:
        group = v.call("POST", "/firewalls", {"description": desc})["firewall_group"]
    gid = group["id"]
    state.setdefault("firewalls", {})[name] = gid
    existing = v.list(f"/firewalls/{gid}/rules", "firewall_rules")
    # SSH from the admin IP only. Stale admin rules are replaced when the IP changes.
    for rule in existing:
        if rule.get("port") == "22" and rule.get("subnet") != admin_ip:
            v.call("DELETE", f"/firewalls/{gid}/rules/{rule['id']}")
    if not any(r.get("port") == "22" and r.get("subnet") == admin_ip for r in existing):
        v.call("POST", f"/firewalls/{gid}/rules", {"ip_type": "v4", "protocol": "tcp", "subnet": admin_ip, "subnet_size": 32, "port": "22", "notes": "admin ssh"})
    for port in public_ports:
        if not any(r.get("port") == port and r.get("subnet") == "0.0.0.0" for r in existing):
            v.call("POST", f"/firewalls/{gid}/rules", {"ip_type": "v4", "protocol": "tcp", "subnet": "0.0.0.0", "subnet_size": 0, "port": port, "notes": f"public {port}"})
    return gid


def ensure_instance(v: Vultr, state: dict, role: str, plan: str, region: str, firewall: str, vpc: str, ssh: str) -> dict:
    label = f"{TAG}-{role}"
    instances = v.list("/instances", "instances")
    found = next((i for i in instances if i["label"] == label), None)
    if found is None:
        ours = [i for i in instances if TAG in (i.get("tags") or [])]
        if len(ours) >= MAX_VMS:
            raise SystemExit(f"refusing to create {label}: already at the {MAX_VMS} VM limit")
        body = {
            "region": region, "plan": plan, "os_id": OS_UBUNTU_2404, "label": label, "hostname": label,
            "sshkey_id": [ssh], "firewall_group_id": firewall, "attach_vpc": [vpc], "enable_ipv6": False,
            "backups": "disabled", "activation_email": False, "tags": [TAG, role],
        }
        if plan.startswith("vx1-"):
            # VX1 local-storage plans take the boot disk through block_devices.
            body["block_devices"] = [{"block_id": "local", "bootable": True}]
        found = v.call("POST", "/instances", body)["instance"]
    return found


def wait_instance(v: Vultr, iid: str, timeout: int = 900) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        i = v.call("GET", f"/instances/{iid}")["instance"]
        if i["status"] == "active" and i["power_status"] == "running" and i["main_ip"] not in ("", "0.0.0.0"):
            return i
        time.sleep(10)
    raise SystemExit(f"instance {iid} not active after {timeout}s")


def vpc_ip(v: Vultr, iid: str) -> str | None:
    for _ in range(30):
        nets = v.call("GET", f"/instances/{iid}/vpcs").get("vpcs", [])
        if nets and nets[0].get("ip_address"):
            return nets[0]["ip_address"]
        time.sleep(5)
    return None


def cheapest_pg_plan(v: Vultr, region: str) -> str:
    plans = v.call("GET", "/databases/plans")["plans"]
    usable = [p for p in plans if (p.get("supported_engines") or {}).get("pg") and region.upper() in p["locations"] and p["number_of_nodes"] == 1 and p["ram"] >= 2048]
    if not usable:
        raise SystemExit(f"no Managed Postgres plan with 2 GB+ in {region}")
    return sorted(usable, key=lambda p: p["monthly_cost"])[0]["id"]


def ensure_postgres(v: Vultr, state: dict, region: str, vpc: str, trusted: list[str]) -> dict:
    found = next((d for d in v.list("/databases", "databases") if d["label"] == f"{TAG}-prod"), None)
    if found is not None:
        # Keep the allow-list current, because the admin's address can change between runs.
        v.call("PUT", f"/databases/{found['id']}", {"trusted_ips": trusted})
    if found is None:
        found = v.call("POST", "/databases", {
            "database_engine": "pg", "database_engine_version": PG_VERSION, "region": region.upper(),
            "plan": cheapest_pg_plan(v, region), "label": f"{TAG}-prod", "tag": TAG, "vpc_id": vpc,
            "trusted_ips": trusted,
        })["database"]
    state["database_id"] = found["id"]
    return found


def wait_postgres(v: Vultr, dbid: str, timeout: int = 1200) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        d = v.call("GET", f"/databases/{dbid}")["database"]
        if d["status"] == "Running":
            return d
        time.sleep(15)
    raise SystemExit(f"database {dbid} not running after {timeout}s")


def pick_object_storage(v: Vultr, region: str) -> tuple[int, int]:
    """Cheapest non-archive tier, in the VM region or the nearest cluster that sells it.

    Evidence bundles are small and travel over S3, so a neighbouring region is fine; $50 a month
    for the only tiers sold in `sea` is not, on a $200 credit.
    """
    nearby = {"sea": ["sea", "sjc", "lax", "ord"], "ewr": ["ewr", "atl", "ord"], "sjc": ["sjc", "sea", "lax"]}.get(region, [region])
    clusters = [c for c in v.call("GET", "/object-storage/clusters")["clusters"] if c["deploy"] == "yes"]
    best: tuple[float, int, int, int] | None = None
    for rank, reg in enumerate(nearby):
        for c in (c for c in clusters if c["region"] == reg):
            for t in v.call("GET", f"/object-storage/clusters/{c['id']}/tiers")["tiers"]:
                if "archive" in t["slug"]:
                    continue
                cand = (t["price"], rank, c["id"], t["id"])
                if best is None or cand < best:
                    best = cand
    if best is None:
        raise SystemExit(f"no object storage cluster near {region}")
    return best[2], best[3]


def ensure_object_storage(v: Vultr, state: dict, region: str) -> dict:
    found = next((o for o in v.list("/object-storage", "object_storages") if o["label"] == TAG), None)
    if found is None:
        cluster_id, tier_id = pick_object_storage(v, region)
        found = v.call("POST", "/object-storage", {"cluster_id": cluster_id, "tier_id": tier_id, "label": TAG})["object_storage"]
    state["object_storage_id"] = found["id"]
    t0 = time.time()
    while time.time() - t0 < 600:
        o = v.call("GET", f"/object-storage/{found['id']}")["object_storage"]
        if o["status"] == "active":
            return o
        time.sleep(10)
    raise SystemExit("object storage not active after 600s")


def ensure_bucket(o: dict) -> str:
    """Exactly one bucket. Its name carries the subscription id, because Vultr keeps a deleted
    bucket's name reserved, so a fixed name fails on a rebuild with BucketAlreadyExists."""
    import boto3
    from botocore.config import Config

    s3 = boto3.client(
        "s3",
        endpoint_url=f"https://{o['s3_hostname']}",
        aws_access_key_id=o["s3_access_key"],
        aws_secret_access_key=o["s3_secret_key"],
        config=Config(signature_version="s3v4", retries={"max_attempts": 5}),
    )
    names = [b["Name"] for b in s3.list_buckets().get("Buckets", [])]
    ours = [n for n in names if n.startswith(BUCKET_PREFIX)]
    if ours:
        return ours[0]
    bucket = f"{BUCKET_PREFIX}-{o['id'].split('-')[0]}"
    s3.create_bucket(Bucket=bucket)
    return bucket


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--region", default=None)
    ap.add_argument("--no-wait", action="store_true", help="create and return without waiting for readiness")
    args = ap.parse_args()

    load_env()
    key = os.environ.get("VULTR_API_KEY")
    if not key:
        raise SystemExit("VULTR_API_KEY is not set (see .env.example)")
    region = args.region or os.environ.get("VULTR_REGION", "sea")
    v = Vultr(key)
    state = load_state()
    state["region"] = region
    admin_ip = my_public_ip()
    state["admin_ip"] = admin_ip

    ssh = ensure_ssh_key(v, state)
    vpc = ensure_vpc(v, state, region)
    fw_control = ensure_firewall(v, state, "control", ["80", "443"], admin_ip)
    fw_vx1 = ensure_firewall(v, state, "vx1", [], admin_ip)
    save_state(state)

    control = ensure_instance(v, state, "control", CONTROL_PLAN, region, fw_control, vpc, ssh)
    vx1 = ensure_instance(v, state, "vx1", VX1_PLAN, region, fw_vx1, vpc, ssh)
    state.setdefault("instances", {})
    state["instances"]["control"] = {"id": control["id"], "plan": CONTROL_PLAN}
    state["instances"]["vx1"] = {"id": vx1["id"], "plan": VX1_PLAN}
    save_state(state)

    obj = ensure_object_storage(v, state, region)
    bucket = ensure_bucket(obj)
    state["bucket"] = bucket
    state["s3_hostname"] = obj["s3_hostname"]
    set_env({
        "SHADOWRUN_S3_ENDPOINT": f"https://{obj['s3_hostname']}",
        "SHADOWRUN_S3_ACCESS_KEY": obj["s3_access_key"],
        "SHADOWRUN_S3_SECRET_KEY": obj["s3_secret_key"],
        "SHADOWRUN_S3_BUCKET": bucket,
    })
    save_state(state)

    if args.no_wait:
        print(json.dumps(state, indent=2))
        return

    for role in ("control", "vx1"):
        inst = wait_instance(v, state["instances"][role]["id"])
        state["instances"][role].update(main_ip=inst["main_ip"], vpc_ip=vpc_ip(v, inst["id"]), status=inst["status"])
    save_state(state)

    db = ensure_postgres(v, state, region, vpc, trusted=[admin_ip, state["instances"]["control"]["main_ip"], state["instances"]["control"]["vpc_ip"]])
    save_state(state)
    db = wait_postgres(v, db["id"])
    # Managed PG returns its credentials over the API; they live in .env, never in STATE.json.
    # This is the admin login. infra/seed_prod.py creates the restricted role the control plane uses.
    host = db.get("public_host") or db["host"]
    set_env({
        "SHADOWRUN_PROD_HOST": host,
        "SHADOWRUN_PROD_VPC_HOST": db.get("host", host),
        "SHADOWRUN_PROD_PORT": str(db["port"]),
        "SHADOWRUN_ADMIN_HOST": host,
        "SHADOWRUN_ADMIN_PORT": str(db["port"]),
        "SHADOWRUN_ADMIN_USER": db["user"],
        "SHADOWRUN_ADMIN_DB_PASSWORD": db["password"],
        "SHADOWRUN_ADMIN_DB": db["dbname"],
    })
    state["postgres"] = {"plan": db["plan"], "version": db["database_engine_version"], "status": db["status"], "region": db["region"]}
    save_state(state)
    summary = {k: state[k] for k in ("region", "instances", "bucket", "postgres") if k in state}
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    sys.exit(main())
