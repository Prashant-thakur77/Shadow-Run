#!/usr/bin/env python3
"""Sync code to the two VMs, write their env files over SSH, and (re)start services.

Secrets stay out of cloud-init and metadata: they travel only over SSH into root-owned files.
The VX1 receives RUNNER_TOKEN and nothing else.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shlex
import socket
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from provision import ENV_PATH, ROOT, SSH_KEY, load_env, load_state, set_env  # noqa: E402

SSH = ["ssh", "-i", str(SSH_KEY), "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=20", "-o", "BatchMode=yes"]
EXCLUDES = [".git", ".venv", "/var", ".env", ".env.*", "PROGRESS.md", "SCORECARD.md", "node_modules", "__pycache__", "docs/PLAN.md", "infra/STATE.json", "infra/.ssh", ".superpowers", ".claude", "web/src", "web/node_modules", "web/fixtures", "web/.shots", "*.pyc", ".pytest_cache", "PROGRESS.md", "SCORECARD.md"]
CONTROL_ENV_KEYS = [
    "VULTR_INFERENCE_BASE", "VULTR_INFERENCE_KEY", "SHADOWRUN_MODEL", "SHADOWRUN_GUARDRAIL_MODEL", "SHADOWRUN_EXPLAINER_MODEL",
    "SHADOWRUN_S3_ENDPOINT", "SHADOWRUN_S3_ACCESS_KEY", "SHADOWRUN_S3_SECRET_KEY", "SHADOWRUN_S3_BUCKET",
    "SHADOWRUN_PROD_HOST", "SHADOWRUN_PROD_PORT", "SHADOWRUN_PROD_USER", "SHADOWRUN_PROD_PASSWORD", "SHADOWRUN_PROD_DB",
    "SHADOWRUN_HMAC_SECRET", "RUNNER_TOKEN", "SHADOWRUN_JUDGE_PASSWORD", "SHADOWRUN_REVIEWER_PASSWORD", "SHADOWRUN_ADMIN_PASSWORD",
    "SHADOWRUN_VIDEO_URL", "SHADOWRUN_TARGETS",
]


def ssh(ip: str, command: str, check: bool = True, input_text: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run([*SSH, f"root@{ip}", command], input=input_text, text=True, check=check)


def pull_results(ip: str) -> None:
    """Results written on the VM come home first, because the sync below deletes what's missing locally."""
    e = " ".join(shlex.quote(str(x)) for x in SSH)
    subprocess.run(["rsync", "-rtz", "-u", "--include=*.json", "--include=*.jsonl", "--exclude=*", "-e", e, f"root@{ip}:/opt/shadowrun/bench/", f"{ROOT}/bench/"], check=False)


def rsync(ip: str) -> None:
    ssh(ip, "mkdir -p /opt/shadowrun && chmod 755 /opt/shadowrun && (command -v rsync >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq rsync >/dev/null))")
    e = " ".join(shlex.quote(str(x)) for x in SSH)
    # Root-owned and not group-writable on the VM: uid sbx runs this code and must not be able to edit it.
    args = ["rsync", "-rlptz", "--delete", "--chown=root:root", "--chmod=Dgo-w,Fgo-w", "--omit-dir-times", "-e", e]
    for x in EXCLUDES:
        args += ["--exclude", x]
    subprocess.run([*args, f"{ROOT}/", f"root@{ip}:/opt/shadowrun/"], check=True)


def ensure_secrets() -> None:
    gen = {}
    for name in ("RUNNER_TOKEN", "SHADOWRUN_HMAC_SECRET", "SHADOWRUN_JUDGE_PASSWORD", "SHADOWRUN_REVIEWER_PASSWORD", "SHADOWRUN_ADMIN_PASSWORD"):
        if not os.environ.get(name):
            gen[name] = secrets.token_urlsafe(32 if "PASSWORD" not in name else 12)
    if gen:
        set_env(gen)


def prod_ip() -> str:
    # An address, not a name: the guest has no DNS, and the probe must test the route, not the resolver.
    # The VPC address is the one the VX1 could really reach if both network walls failed.
    host = os.environ.get("SHADOWRUN_PROD_VPC_HOST") or os.environ.get("SHADOWRUN_PROD_HOST", "")
    return socket.gethostbyname(host) if host else "10.77.0.1"


def deploy_vx1(state: dict) -> None:
    node = state["instances"]["vx1"]
    ip = node["main_ip"]
    rsync(ip)
    ssh(ip, "install -d -m 700 /etc/shadowrun && umask 077 && cat > /etc/shadowrun/runner.env",
        input_text=f"RUNNER_TOKEN={os.environ['RUNNER_TOKEN']}\nSHADOWRUN_PROBE_PROD_HOST={prod_ip()}\nSHADOWRUN_PROBE_PROD_PORT={os.environ.get('SHADOWRUN_PROD_PORT', '5432')}\n")
    ssh(ip, f"bash /opt/shadowrun/infra/bootstrap_vx1.sh {shlex.quote(node['vpc_ip'])}")


def build_web() -> None:
    web = ROOT / "web"
    if (web / "package.json").exists():
        if not (web / "node_modules").exists():
            subprocess.run(["npm", "ci"], cwd=web, check=True)
        subprocess.run(["npm", "run", "build"], cwd=web, check=True)


def point_docs_at(public_url: str) -> None:
    path = ROOT / "docs" / "opencode.json"
    text = path.read_text()
    path.write_text(re.sub(r"https://[^\"]+/mcp", f"{public_url}/mcp", text))


def deploy_control(state: dict) -> None:
    node = state["instances"]["control"]
    ip = node["main_ip"]
    build_web()
    pull_results(ip)
    rsync(ip)
    host = f"{ip.replace('.', '-')}.sslip.io"
    lines = [f"{k}={os.environ[k]}" for k in CONTROL_ENV_KEYS if os.environ.get(k) and k != "SHADOWRUN_PROD_HOST"]
    # The control VM reaches Managed Postgres over the VPC, not the public internet.
    lines.append(f"SHADOWRUN_PROD_HOST={os.environ.get('SHADOWRUN_PROD_VPC_HOST') or os.environ['SHADOWRUN_PROD_HOST']}")
    lines += [f"SHADOWRUN_RUNNER_URL=http://{state['instances']['vx1']['vpc_ip']}:8101", f"SHADOWRUN_PUBLIC_URL=https://{host}"]
    ssh(ip, "install -d -m 755 /etc/shadowrun && umask 077 && cat > /etc/shadowrun/control.env", input_text="\n".join(lines) + "\n")
    ssh(ip, f"bash /opt/shadowrun/infra/bootstrap_control.sh {shlex.quote(host)} && chown shadowrun /etc/shadowrun/control.env && chmod 600 /etc/shadowrun/control.env && systemctl restart shadowrun-control.service")
    state["public_url"] = f"https://{host}"
    point_docs_at(state["public_url"])
    (ROOT / "infra" / "STATE.json").write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("what", nargs="*", default=["vx1", "control"], choices=["vx1", "control"])
    ap.add_argument("--quick", action="store_true", help="sync code and restart services; skip the full bootstrap")
    ap.add_argument("--web", action="store_true", help="with --quick, rebuild the web UI first")
    args = ap.parse_args()
    load_env()
    ensure_secrets()
    state = load_state()
    if args.quick:
        for what in args.what:
            ip = state["instances"][what]["main_ip"]
            if what == "control" and args.web:
                build_web()
            if what == "control":
                pull_results(ip)
            rsync(ip)
            unit = "shadowrun-runner" if what == "vx1" else "shadowrun-control"
            ssh(ip, f"systemctl restart {unit} && sleep 3 && systemctl is-active {unit}")
        return
    if "vx1" in args.what:
        deploy_vx1(state)
    if "control" in args.what:
        deploy_control(state)
    print(json.dumps({"deployed": args.what, "public_url": state.get("public_url")}))


if __name__ == "__main__":
    if not ENV_PATH.exists():
        raise SystemExit("no .env")
    main()
