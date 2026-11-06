#!/usr/bin/env python3
"""Runs inside a host-target sandbox as root. Measures files and services around the plan's steps.

Each plan step runs as its own bash script with capped output, so a plan cannot write to this
driver's stdout and cannot forge the result.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import time

ROOTS = ["/etc", "/var/app", "/srv", "/opt/app", "/home", "/root"]
SKIP = ("/etc/ssl", "/etc/alternatives", "/etc/systemd/system/multi-user.target.wants", "/root/.cache")
OUTPUT_CAP = 8000
# Never persistent, the system log, or the sandbox's own agent. Everything else outside ROOTS is watched by change time.
NOT_WATCHED = ("/proc", "/sys", "/dev", "/run", "/tmp", "/var/tmp", "/var/log/journal", "/.msb")
WATCH_MARKER = "/run/.sr-watch"
OUTSIDE_CAP = 50


def manifest() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for root in ROOTS:
        for dirpath, dirnames, filenames in os.walk(root):
            if dirpath.startswith(SKIP):
                dirnames[:] = []
                continue
            for name in filenames:
                path = os.path.join(dirpath, name)
                try:
                    st = os.lstat(path)
                    if os.path.islink(path):
                        out[path] = {"link": os.readlink(path)}
                    elif os.path.isfile(path):
                        h = hashlib.sha256()
                        with open(path, "rb") as f:
                            for chunk in iter(lambda: f.read(1 << 20), b""):
                                h.update(chunk)
                        out[path] = {"sha256": h.hexdigest(), "size": st.st_size, "mode": st.st_mode}
                except OSError:
                    continue
    return out


def services() -> dict:
    r = subprocess.run(["systemctl", "list-units", "--type=service", "--state=running", "--no-legend", "--plain"], capture_output=True, text=True, timeout=20)
    running = sorted(line.split()[0] for line in r.stdout.splitlines() if line.strip())
    p = subprocess.run(["ss", "-ltnH"], capture_output=True, text=True, timeout=10)
    ports = sorted({line.split()[3].rsplit(":", 1)[-1] for line in p.stdout.splitlines() if line.strip()})
    return {"running": running, "listening_ports": ports}


def wait_for_boot(timeout: float = 25) -> str:
    t0 = time.time()
    state = ""
    while time.time() - t0 < timeout:
        r = subprocess.run(["systemctl", "is-system-running"], capture_output=True, text=True, timeout=10)
        state = r.stdout.strip()
        if state in ("running", "degraded"):
            return state
        time.sleep(0.2)
    return state or "unknown"


def diff_manifest(a: dict, b: dict) -> dict:
    created = sorted(set(b) - set(a))
    deleted = sorted(set(a) - set(b))
    changed = sorted(p for p in set(a) & set(b) if a[p] != b[p])
    return {
        "created": created[:300],
        "deleted": deleted[:300],
        "changed": changed[:300],
        "counts": {"created": len(created), "deleted": len(deleted), "changed": len(changed)},
        "content_sha256": hashlib.sha256(json.dumps({p: b[p] for p in sorted(created + changed)}, sort_keys=True).encode()).hexdigest(),
        "bytes_freed": sum(a[p].get("size", 0) for p in deleted),
    }


def changed_outside_roots() -> list[str]:
    """ROOTS are hashed file by file. Elsewhere a change still shows in the inode's change time, which `touch` can't backdate."""
    prune: list[str] = []
    for path in (*ROOTS, *NOT_WATCHED):
        prune += ["-path", path, "-o"]
    r = subprocess.run(["find", "/", "-xdev", "(", *prune[:-1], ")", "-prune", "-o", "-cnewer", WATCH_MARKER, "-print"], capture_output=True, text=True, timeout=30)
    # Deepest first: the file a plan wrote says more than the folders above it.
    return sorted(r.stdout.splitlines(), key=lambda p: (-p.count("/"), p))


def run_steps(steps: list[dict], timeout: float) -> tuple[list[dict], str | None]:
    """Stops at the first failure, like `set -e` across steps."""
    results = []
    for i, step in enumerate(steps, start=1):
        path = f"/tmp/.sr-step-{i}.sh"
        with open(path, "w") as f:
            f.write(step["cmd"] + "\n")
        t0 = time.perf_counter()
        try:
            r = subprocess.run(["bash", path], capture_output=True, timeout=timeout, cwd="/root")
            rec = {"step": i, "exit_code": r.returncode, "output": (r.stdout + r.stderr)[-OUTPUT_CAP:].decode("utf-8", "replace")}
        except subprocess.TimeoutExpired:
            rec = {"step": i, "exit_code": None, "output": "", "timed_out": True}
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
        rec["ms"] = round((time.perf_counter() - t0) * 1000, 1)
        results.append(rec)
        if rec["exit_code"] != 0:
            return results, f"step {i} failed with exit code {rec['exit_code']}: {rec['output'][-300:]}"
    return results, None


def run_checks(guardrails: list[dict]) -> list[dict]:
    """A host guardrail is a shell check that must exit 0."""
    out = []
    for g in guardrails:
        t0 = time.perf_counter()
        try:
            r = subprocess.run(["bash", "-c", g["sh"]], capture_output=True, timeout=30)
            item = {"id": g["id"], "name": g.get("name", g["id"]), "passed": r.returncode == 0, "output": (r.stdout + r.stderr)[-400:].decode("utf-8", "replace")}
        except subprocess.TimeoutExpired:
            item = {"id": g["id"], "name": g.get("name", g["id"]), "passed": False, "error": "timed out"}
        item["ms"] = round((time.perf_counter() - t0) * 1000, 1)
        out.append(item)
    return out


def op_rehearse(job: dict) -> dict:
    boot = wait_for_boot()
    before = manifest()
    services_before = services()
    with open(WATCH_MARKER, "w"):
        pass
    t0 = time.perf_counter()
    steps, error = run_steps(job["steps"], float(job.get("step_timeout", 60)))
    execute_ms = round((time.perf_counter() - t0) * 1000, 1)
    time.sleep(0.3)
    outside = changed_outside_roots()
    after = manifest()
    services_after = services()
    guardrails = run_checks(job.get("guardrails", []))
    files = diff_manifest(before, after)
    files["outside_measured"] = outside[:OUTSIDE_CAP]
    files["counts"]["outside_measured"] = len(outside)
    return {
        "ok": error is None,
        "error": error,
        "boot_state": boot,
        "steps": steps,
        "files": files,
        "services_before": services_before,
        "services_after": services_after,
        "services_stopped": sorted(set(services_before["running"]) - set(services_after["running"])),
        "services_started": sorted(set(services_after["running"]) - set(services_before["running"])),
        "ports_closed": sorted(set(services_before["listening_ports"]) - set(services_after["listening_ports"])),
        "guardrails": guardrails,
        "timing": {"execute_ms": execute_ms},
        "fingerprint": hashlib.sha256(json.dumps({"m": after, "s": services_after}, sort_keys=True).encode()).hexdigest(),
    }


def op_fingerprint(job: dict) -> dict:
    wait_for_boot()
    m = manifest()
    s = services()
    return {"ok": True, "digest": hashlib.sha256(json.dumps({"m": m, "s": s}, sort_keys=True).encode()).hexdigest(), "files": len(m), "services": s}


def op_inspect(job: dict) -> dict:
    wait_for_boot()
    tree = subprocess.run(["bash", "-c", "du -sh /var/app/* /var/app/*/* 2>/dev/null | head -40; echo; ls -la /var/app /var/app/cache /etc/cron.d; echo; cat /etc/cron.d/* 2>/dev/null | head -20; echo; df -h / | tail -1"], capture_output=True, text=True, timeout=20).stdout
    return {"ok": True, "overview": tree, "services": services()}


def op_probe(job: dict) -> dict:
    """Reads the reply: the sandbox gateway accepts some connections only to deny them."""
    nics = sorted(os.listdir("/sys/class/net"))
    results = []
    for t in job.get("targets", []):
        item = {"label": t["label"], "host": t["host"], "port": t["port"]}
        try:
            with socket.create_connection((t["host"], t["port"]), timeout=float(job.get("timeout", 2))) as c:
                c.settimeout(1.5)
                try:
                    c.sendall(b"GET / HTTP/1.0\r\nHost: probe\r\n\r\n")
                    reply = c.recv(512)
                except OSError:
                    reply = b""
                text = reply.decode("utf-8", "replace")
                if "network_policy_denied" in text:
                    item.update(result="BLOCKED", how="denied by sandbox network policy")
                elif not reply:
                    item.update(result="BLOCKED", how="connection closed with no reply")
                else:
                    item.update(result="REACHABLE", how=f"reply {text[:80]!r}")
        except OSError as e:
            item.update(result="BLOCKED", how=(e.strerror or type(e).__name__))
        results.append(item)
    try:
        socket.getaddrinfo(job.get("dns_name", "api.vultrinference.com"), 443)
        dns = "RESOLVED"
    except OSError as e:
        dns = f"BLOCKED ({e.strerror or type(e).__name__})"
    with open("/proc/net/route") as f:
        routes = max(0, len(f.readlines()) - 1)
    return {"ok": all(r["result"] == "BLOCKED" for r in results) and dns.startswith("BLOCKED"), "nics": nics, "routes": routes, "targets": results, "dns": dns}


def op_secret_scan(job: dict) -> dict:
    pattern = re.compile("|".join(job["patterns"]).encode())
    hits: list[dict] = []
    scanned = 0
    for pid in os.listdir("/proc"):
        if pid.isdigit():
            try:
                with open(f"/proc/{pid}/environ", "rb") as f:
                    data = f.read()
            except OSError:
                continue
            scanned += 1
            for m in pattern.finditer(data):
                hits.append({"where": f"/proc/{pid}/environ", "match": m.group(0)[:24].decode("utf-8", "replace")})
    for root in ("/etc", "/home", "/root", "/tmp", "/var/tmp", "/var/app", "/srv", "/opt/app"):
        for dirpath, _, filenames in os.walk(root):
            for name in filenames:
                path = os.path.join(dirpath, name)
                try:
                    if os.path.isfile(path) and os.path.getsize(path) <= 2_000_000:
                        with open(path, "rb") as f:
                            data = f.read()
                        scanned += 1
                        for m in pattern.finditer(data):
                            hits.append({"where": path, "match": m.group(0)[:24].decode("utf-8", "replace")})
                except OSError:
                    continue
    return {"ok": not hits, "scanned": scanned, "hits": hits[:20]}


def op_ready(job: dict) -> dict:
    return {"ok": True, "state": wait_for_boot()}


def op_seed(job: dict) -> dict:
    wait_for_boot()
    r = subprocess.run(["bash", "-c", job["sh"]], capture_output=True, timeout=120)
    return {"ok": r.returncode == 0, "output": (r.stdout + r.stderr)[-1000:].decode("utf-8", "replace")}


def op_export_state(job: dict) -> dict:
    """Tar of the managed paths, written to a guest path for the host to copy out."""
    wait_for_boot()
    roots = [r for r in ROOTS if os.path.exists(r)]
    r = subprocess.run(["tar", "--xattrs", "-czpf", job["path"], *roots], capture_output=True, timeout=120)
    return {"ok": r.returncode in (0, 1), "services": services(), "bytes": os.path.getsize(job["path"]) if os.path.exists(job["path"]) else 0, "detail": r.stderr[-300:].decode("utf-8", "replace")}


def op_import_state(job: dict) -> dict:
    """Make this VM match an exported state: same files, same running services."""
    wait_for_boot()
    for root in ROOTS:
        if os.path.exists(root) and root not in ("/etc",):
            subprocess.run(["find", root, "-mindepth", "1", "-delete"], capture_output=True, timeout=60)
    if job.get("clean_etc"):
        subprocess.run(["find", "/etc/cron.d", "-mindepth", "1", "-delete"], capture_output=True, timeout=30)
    r = subprocess.run(["tar", "--xattrs", "-xzpf", job["path"], "-C", "/"], capture_output=True, timeout=120)
    os.remove(job["path"])
    subprocess.run(["systemctl", "daemon-reload"], capture_output=True, timeout=30)
    wanted = set(job.get("running", []))
    now = set(services()["running"])
    for unit in sorted(now - wanted):
        subprocess.run(["systemctl", "stop", unit], capture_output=True, timeout=30)
    for unit in sorted(wanted - now):
        subprocess.run(["systemctl", "start", unit], capture_output=True, timeout=30)
    subprocess.run(["systemctl", "restart", "nginx"], capture_output=True, timeout=30)
    return {"ok": r.returncode in (0, 1), "services": services(), "detail": r.stderr[-300:].decode("utf-8", "replace")}


def main() -> int:
    job = json.load(sys.stdin)
    handlers = {
        "rehearse": op_rehearse, "fingerprint": op_fingerprint, "inspect": op_inspect, "probe": op_probe,
        "secret_scan": op_secret_scan, "ready": op_ready, "seed": op_seed, "export_state": op_export_state, "import_state": op_import_state,
    }
    try:
        result = handlers[job["op"]](job)
    except Exception as e:  # the host decides what a failure means
        result = {"ok": False, "fatal": True, "error": " ".join(str(e).split())[:1000], "type": type(e).__name__}
    json.dump(result, sys.stdout, default=str)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
