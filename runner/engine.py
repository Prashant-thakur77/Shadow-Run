"""microVM lifecycle for rehearsals. One golden disk per prod snapshot; one fresh clone per run.

Containment rules enforced here, each of which has a test:
- Every clone is restored with disable_network=True, so the guest has no NIC at all.
  Restoring without it silently re-opens egress, even from a golden VM created with Network.none().
- A clone with any network interface other than lo/dummy0 fails closed before the plan runs.
- No host path is mounted into any clone. The dump is copied into the golden VM, restored,
  and deleted before the golden disk is captured.
- destroy runs in finally, on success, failure and timeout, and is then verified from the host.
- Nothing from this process's environment is passed to the guest.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import re
import socket
import subprocess
import time
from pathlib import Path
from typing import Any

from microsandbox import Image, Network, Sandbox, Snapshot
from microsandbox.errors import MicrosandboxError, SandboxNotFoundError

log = logging.getLogger("shadowrun.runner")

IMAGE = os.environ.get("SHADOWRUN_IMAGE", "sr-target:0.1")
CPUS = int(os.environ.get("SHADOWRUN_VM_CPUS", "2"))
MEMORY_MIB = int(os.environ.get("SHADOWRUN_VM_MEMORY_MIB", "2048"))
MAX_DURATION_S = int(os.environ.get("SHADOWRUN_VM_MAX_S", "120"))
MAX_PARALLEL = int(os.environ.get("SHADOWRUN_VM_PARALLEL", "4"))
JANITOR_MAX_AGE_S = 600
OUTPUT_CAP_BYTES = 8_000_000
RUN_PREFIX = "sr-run-"
GOLDEN_PREFIX = "sr-golden-"
PRODHOST_PREFIX = "sr-prodhost-"
HOST_IMAGE = os.environ.get("SHADOWRUN_HOST_IMAGE", "sr-host:0.1")
HOST_MEMORY_MIB = int(os.environ.get("SHADOWRUN_HOST_MEMORY_MIB", "1024"))
ALLOWED_NICS = {"lo", "dummy0"}
SAFE_ID = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
DRIVER = ["/opt/sr/guest/driver.py"]
# Sent with the scan, so the guest image itself contains no key-like strings to trip over.
SECRET_PATTERNS = [
    r"SRCANARY-[0-9a-f]{8,}",
    r"VULTR_[A-Z_]*KEY",
    r"postgres(?:ql)?://[^\s]+:[^\s]+@",
    r"AKIA[0-9A-Z]{16}",
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    r"RUNNER_TOKEN",
    r"SHADOWRUN_HMAC",
]


class SandboxFailure(Exception):
    """The sandbox died, hung or returned something unusable. Unknown is never treated as safe."""


def msb_home() -> Path:
    return Path(os.environ.get("MSB_HOME", Path.home() / ".microsandbox"))


def _ms(t0: float) -> float:
    return round((time.perf_counter() - t0) * 1000, 1)


def _check_id(value: str) -> str:
    if not SAFE_ID.match(value):
        raise ValueError(f"unsafe id: {value!r}")
    return value


async def _driver(sb: Sandbox, job: dict, timeout: float) -> dict:
    try:
        r = await sb.exec("python3", list(DRIVER), stdin=json.dumps(job).encode(), timeout=timeout)
    except MicrosandboxError as e:
        raise SandboxFailure(f"driver {job.get('op')}: {type(e).__name__}: {e}") from e
    if len(r.stdout_bytes) > OUTPUT_CAP_BYTES:
        raise SandboxFailure(f"driver {job.get('op')}: output over {OUTPUT_CAP_BYTES} bytes")
    try:
        return json.loads(r.stdout_text)
    except ValueError as e:
        raise SandboxFailure(
            f"driver {job.get('op')}: unusable output (exit {r.exit_code}): {r.stderr_text[:300]}"
        ) from e


def host_identity() -> dict:
    return {
        "kernel": platform.release(),
        "hostname": socket.gethostname(),
        "kvm_device": os.path.exists("/dev/kvm"),
        "kvm_rw": os.access("/dev/kvm", os.R_OK | os.W_OK),
    }


async def image_digest(reference: str = IMAGE) -> str | None:
    try:
        return (await Image.get(reference)).manifest_digest
    except MicrosandboxError:
        return None


class Engine:
    def __init__(self, image: str = IMAGE) -> None:
        self.image = image
        self._slots = asyncio.Semaphore(MAX_PARALLEL)
        self._golden_locks: dict[str, asyncio.Lock] = {}

    # ---------------------------------------------------------------- golden per prod snapshot

    async def _golden_group(self, snapshot_id: str) -> str:
        # A disk snapshot is bound to its base image, so a rebuilt image needs a new golden.
        digest = (await image_digest(self.image) or "unknown").removeprefix("sha256:")[:8]
        return f"{GOLDEN_PREFIX}{_check_id(snapshot_id)}-{digest}"

    async def golden_ref(self, snapshot_id: str) -> str:
        return f"{await self._golden_group(snapshot_id)}:v1"

    async def has_golden(self, snapshot_id: str) -> bool:
        try:
            await Snapshot.get(await self.golden_ref(snapshot_id))
            return True
        except (MicrosandboxError, FileNotFoundError):
            return False

    async def ensure_golden(self, snapshot_id: str, dump_path: str | Path, extensions: list[str] | None = None) -> dict:
        """Boot one VM, restore the dump into it, install capture, capture its disk, destroy it."""
        _check_id(snapshot_id)
        lock = self._golden_locks.setdefault(snapshot_id, asyncio.Lock())
        async with lock:
            if await self.has_golden(snapshot_id):
                return {"snapshot_id": snapshot_id, "cached": True}
            t0 = time.perf_counter()
            name = await self._golden_group(snapshot_id)
            sb = await Sandbox.create(
                name,
                image=self.image,
                cpus=CPUS,
                memory=MEMORY_MIB,
                network=Network.none(),
                replace=True,
                max_duration=600,
            )
            try:
                await sb.fs.copy_from_host(str(dump_path), "/tmp/prod.dump")
                prep = await _driver(sb, {"op": "prepare", "dump_path": "/tmp/prod.dump", "extensions": extensions or []}, 540)
                if not prep.get("ok"):
                    raise SandboxFailure(f"restore failed: {prep.get('error')}")
                seal = await _driver(sb, {"op": "seal", "dump_path": "/tmp/prod.dump"}, 60)
                if not seal.get("ok"):
                    raise SandboxFailure(f"could not seal golden clone: {seal.get('detail')}")
                await Snapshot.create("v1", from_sandbox=name, group=name)
            finally:
                await _destroy(sb, name)
            return {
                "snapshot_id": snapshot_id,
                "cached": False,
                "total_ms": _ms(t0),
                "timing": prep.get("timing"),
                "restore_warnings": prep.get("restore_warnings"),
            }

    async def drop_golden(self, snapshot_id: str) -> None:
        try:
            await Snapshot.remove(await self.golden_ref(snapshot_id), force=True)
        except (MicrosandboxError, FileNotFoundError) as e:
            log.warning("drop_golden %s: %s", snapshot_id, e)

    # ---------------------------------------------------------------- one clone, one run

    async def _clone(self, snapshot_id: str, name: str, max_duration: int) -> Sandbox:
        # disable_network is the load-bearing flag: see the module docstring.
        return await Sandbox.restore(
            await self.golden_ref(snapshot_id),
            name=name,
            cpus=CPUS,
            memory=MEMORY_MIB,
            disable_network=True,
            max_duration=max_duration,
        )

    async def _one_shot(self, snapshot_id: str, run_id: str, job: dict) -> dict:
        name = f"{RUN_PREFIX}{_check_id(run_id)}"
        async with self._slots:
            sb = await self._clone(snapshot_id, name, 60)
            try:
                return await _driver(sb, job, 50)
            finally:
                await _destroy(sb, name)

    async def inspect(self, snapshot_id: str, run_id: str, sample_rows: int = 3) -> dict:
        return await self._one_shot(snapshot_id, run_id, {"op": "inspect", "sample_rows": sample_rows})

    async def query(self, snapshot_id: str, run_id: str, queries: list[str]) -> dict:
        return await self._one_shot(snapshot_id, run_id, {"op": "query", "queries": queries})

    async def suspects(self, snapshot_id: str, run_id: str) -> dict:
        return await self._one_shot(snapshot_id, run_id, {"op": "suspects"})

    async def rehearse(
        self,
        run_id: str,
        snapshot_id: str,
        steps: list[dict],
        guardrails: list[dict],
        probe_targets: list[dict] | None = None,
        attack_shell: str | None = None,
        max_duration: int = MAX_DURATION_S,
        scan_secrets: bool = True,
        metrics: list[dict] | None = None,
        undo: bool = True,
    ) -> dict:
        """Clone, prove isolation, run the plan, measure, destroy, prove destroyed.

        `attack_shell` is for red-team runs only: it runs that script as guest root, with no gate.
        """
        name = f"{RUN_PREFIX}{_check_id(run_id)}"
        rec: dict[str, Any] = {
            "run_id": run_id,
            "snapshot_id": snapshot_id,
            "sandbox": name,
            "limits": {"cpus": CPUS, "memory_mib": MEMORY_MIB, "max_duration_s": max_duration, "network": "none (no NIC)"},
            "host": host_identity(),
            "image": {"reference": self.image, "digest": await image_digest(self.image)},
            "phases": {},
            "contained": None,
        }
        t_total = time.perf_counter()
        sb: Sandbox | None = None
        async with self._slots:
            try:
                t0 = time.perf_counter()
                sb = await self._clone(snapshot_id, name, max_duration)
                rec["phases"]["clone_boot_ms"] = _ms(t0)

                t0 = time.perf_counter()
                who = await sb.shell("uname -r; hostname", timeout=20)
                lines = who.stdout_text.split()
                rec["guest"] = {"kernel": lines[0] if lines else None, "hostname": lines[1] if len(lines) > 1 else None}
                rec["phases"]["first_exec_ms"] = _ms(t0)

                t0 = time.perf_counter()
                rec["probes"] = await _driver(sb, {"op": "probe", "targets": probe_targets or default_probe_targets()}, 30)
                rec["phases"]["probe_ms"] = _ms(t0)
                extra_nics = set(rec["probes"].get("nics", [])) - ALLOWED_NICS
                if extra_nics or not rec["probes"].get("ok"):
                    raise SandboxFailure(f"isolation check failed before the plan ran: nics={sorted(extra_nics)}")

                t0 = time.perf_counter()
                if attack_shell is not None:
                    rec["attack"] = await _run_attack(sb, attack_shell, max_duration)
                else:
                    rec["result"] = await _driver(
                        sb, {"op": "rehearse", "steps": steps, "guardrails": guardrails, "metrics": metrics or [], "undo": undo}, max_duration
                    )
                    if rec["result"].get("fatal"):
                        raise SandboxFailure(f"driver: {rec['result'].get('error')}")
                rec["phases"]["execute_ms"] = _ms(t0)

                if scan_secrets:
                    t0 = time.perf_counter()
                    try:
                        rec["secret_scan"] = await _driver(sb, {"op": "secret_scan", "patterns": SECRET_PATTERNS}, 30)
                    except SandboxFailure as e:
                        # The attack may have killed the guest. Not a pass: recorded as not run.
                        rec["secret_scan"] = {"ok": None, "error": str(e)[:300]}
                    rec["phases"]["secret_scan_ms"] = _ms(t0)

                try:
                    m = await sb.metrics()
                    rec["metrics"] = {
                        "memory_bytes": m.memory_bytes,
                        "memory_limit_bytes": m.memory_limit_bytes,
                        "net_rx_bytes": m.net_rx_bytes,
                        "net_tx_bytes": m.net_tx_bytes,
                        "uptime_ms": m.uptime_ms,
                    }
                except MicrosandboxError:
                    rec["metrics"] = None
            except SandboxFailure as e:
                rec["sandbox_error"] = str(e)
            except Exception as e:  # noqa: BLE001  unknown is not safe: it becomes a failed run, never a pass
                rec["sandbox_error"] = f"{type(e).__name__}: {str(e)[:400]}"
            finally:
                t0 = time.perf_counter()
                if sb is not None:
                    await _destroy(sb, name)
                rec["phases"]["destroy_ms"] = _ms(t0)
                rec["teardown"] = await teardown_proof(name)
        rec["phases"]["total_ms"] = _ms(t_total)
        rec["contained"] = _contained(rec)
        return rec

    # ---------------------------------------------------------------- Linux host targets

    async def _host_vm(self, name: str, max_duration: int | None) -> Sandbox:
        # `restore` does not carry init over, so a host clone is created from the image, and that
        # path has no NIC-less mode. The walls here are the deny-all policy, the link taken down
        # below, and the uid firewall. Reported as such in the run record.
        kw = {"max_duration": max_duration} if max_duration else {}
        return await Sandbox.create(
            name, image=HOST_IMAGE, cpus=CPUS, memory=HOST_MEMORY_MIB, network=Network.none(), init="auto", replace=True, **kw,
        )

    async def ensure_prodhost(self, host_id: str, seed_sh: str | None = None, recreate: bool = False) -> dict:
        """The demo's long-lived 'prod host': a VM on this machine, addressed the same way as a clone."""
        name = f"{PRODHOST_PREFIX}{_check_id(host_id)}"
        try:
            h = await Sandbox.get(name)
            if recreate:
                await force_remove(name)
            elif str(h.status).lower().endswith("running"):
                return {"name": name, "created": False}
            else:
                await force_remove(name)
        except SandboxNotFoundError:
            pass
        sb = await self._host_vm(name, None)
        if seed_sh:
            seeded = await _driver(sb, {"op": "seed", "sh": seed_sh}, 150)
            if not seeded.get("ok"):
                raise SandboxFailure(f"seed failed: {seeded.get('output')}")
        await sb.detach()
        return {"name": name, "created": True}

    async def _prodhost(self, host_id: str) -> Sandbox:
        return await (await Sandbox.get(f"{PRODHOST_PREFIX}{_check_id(host_id)}")).connect()

    async def prodhost_fingerprint(self, host_id: str) -> dict:
        sb = await self._prodhost(host_id)
        try:
            return await _driver(sb, {"op": "fingerprint"}, 60)
        finally:
            await sb.detach()

    async def prodhost_exec(self, host_id: str, sh: str) -> dict:
        """Used by the benchmark's oracles and by host guardrails on prod. Never reachable from a plan."""
        sb = await self._prodhost(host_id)
        try:
            r = await sb.exec("bash", ["-c", sh], timeout=60)
            return {"exit_code": r.exit_code, "output": (r.stdout_text + r.stderr_text)[-2000:]}
        finally:
            await sb.detach()

    async def prodhost_inspect(self, host_id: str) -> dict:
        sb = await self._prodhost(host_id)
        try:
            return await _driver(sb, {"op": "inspect"}, 60)
        finally:
            await sb.detach()

    async def prodhost_apply(self, host_id: str, steps: list[dict], guardrails: list[dict]) -> dict:
        """Same driver as the rehearsal. Keeps a state tar so the caller can roll back."""
        sb = await self._prodhost(host_id)
        try:
            backup_guest = "/var/tmp/.sr-prebackup.tgz"
            exported = await _driver(sb, {"op": "export_state", "path": backup_guest}, 120)
            result = await _driver(sb, {"op": "rehearse", "steps": steps, "guardrails": guardrails}, MAX_DURATION_S + 60)
            return {"result": result, "backup_guest_path": backup_guest, "services_before": exported.get("services"), "backup_bytes": exported.get("bytes")}
        finally:
            await sb.detach()

    async def prodhost_rollback(self, host_id: str, running: list[str]) -> dict:
        sb = await self._prodhost(host_id)
        try:
            return await _driver(sb, {"op": "import_state", "path": "/var/tmp/.sr-prebackup.tgz", "running": running, "clean_etc": True}, 180)
        finally:
            await sb.detach()

    async def prodhost_state(self, host_id: str) -> tuple[bytes, list[str]]:
        sb = await self._prodhost(host_id)
        try:
            exported = await _driver(sb, {"op": "export_state", "path": "/var/tmp/.sr-state.tgz"}, 120)
            data = await sb.fs.read("/var/tmp/.sr-state.tgz")
            await sb.fs.remove("/var/tmp/.sr-state.tgz")
            return data, exported.get("services", {}).get("running", [])
        finally:
            await sb.detach()

    async def remove_prodhost(self, host_id: str) -> None:
        await force_remove(f"{PRODHOST_PREFIX}{_check_id(host_id)}")

    async def rehearse_host(
        self, run_id: str, host_id: str, steps: list[dict], guardrails: list[dict], max_duration: int = MAX_DURATION_S,
    ) -> dict:
        name = f"{RUN_PREFIX}{_check_id(run_id)}"
        rec: dict[str, Any] = {
            "run_id": run_id, "sandbox": name, "target_kind": "host",
            "limits": {"cpus": CPUS, "memory_mib": HOST_MEMORY_MIB, "max_duration_s": max_duration, "network": "deny-all policy, link down, uid firewall (NIC present)"},
            "host": host_identity(), "image": {"reference": HOST_IMAGE, "digest": await image_digest(HOST_IMAGE)}, "phases": {}, "contained": None,
        }
        t_total = time.perf_counter()
        sb: Sandbox | None = None
        async with self._slots:
            try:
                state, running = await self.prodhost_state(host_id)
                rec["state_bytes"] = len(state)
                t0 = time.perf_counter()
                sb = await self._host_vm(name, max_duration)
                rec["phases"]["clone_boot_ms"] = _ms(t0)
                t0 = time.perf_counter()
                who = await sb.shell("uname -r; hostname", timeout=20)
                lines = who.stdout_text.split()
                rec["guest"] = {"kernel": lines[0] if lines else None, "hostname": lines[1] if len(lines) > 1 else None}
                rec["phases"]["first_exec_ms"] = _ms(t0)

                t0 = time.perf_counter()
                # systemd mounts a fresh /tmp during boot, so wait for boot before writing anything.
                booted = await _driver(sb, {"op": "ready"}, 60)
                rec["phases"]["systemd_boot_ms"] = _ms(t0)
                rec["boot_state"] = booted.get("state")
                t0 = time.perf_counter()
                await sb.fs.write("/var/tmp/.sr-state.tgz", state)
                imported = await _driver(sb, {"op": "import_state", "path": "/var/tmp/.sr-state.tgz", "running": running, "clean_etc": True}, 120)
                if not imported.get("ok"):
                    raise SandboxFailure(f"could not load host state: {imported.get('detail')}")
                rec["phases"]["load_state_ms"] = _ms(t0)

                await sb.exec("bash", ["-c", "ip link set eth0 down; ip route flush table main || true"], timeout=10)
                t0 = time.perf_counter()
                rec["probes"] = await _driver(sb, {"op": "probe", "targets": default_probe_targets()}, 30)
                rec["phases"]["probe_ms"] = _ms(t0)
                if not rec["probes"].get("ok"):
                    raise SandboxFailure("isolation check failed before the plan ran")

                t0 = time.perf_counter()
                rec["result"] = await _driver(sb, {"op": "rehearse", "steps": steps, "guardrails": guardrails}, max_duration)
                if rec["result"].get("fatal"):
                    raise SandboxFailure(f"driver: {rec['result'].get('error')}")
                rec["phases"]["execute_ms"] = _ms(t0)

                t0 = time.perf_counter()
                try:
                    rec["secret_scan"] = await _driver(sb, {"op": "secret_scan", "patterns": SECRET_PATTERNS}, 30)
                except SandboxFailure as e:
                    rec["secret_scan"] = {"ok": None, "error": str(e)[:300]}
                rec["phases"]["secret_scan_ms"] = _ms(t0)
            except Exception as e:  # noqa: BLE001  unknown is not safe
                rec["sandbox_error"] = f"{type(e).__name__}: {str(e)[:400]}"
            finally:
                t0 = time.perf_counter()
                if sb is not None:
                    await _destroy(sb, name)
                rec["phases"]["destroy_ms"] = _ms(t0)
                rec["teardown"] = await teardown_proof(name)
        rec["phases"]["total_ms"] = _ms(t_total)
        probes = rec.get("probes") or {}
        rec["contained"] = bool(
            rec.get("teardown", {}).get("ok") and probes.get("ok") is True and rec.get("guest", {}).get("kernel")
            and rec["guest"]["kernel"] != rec["host"]["kernel"]
        )
        return rec

    # ---------------------------------------------------------------- janitor

    async def janitor_once(self, max_age_s: int = JANITOR_MAX_AGE_S) -> list[str]:
        killed = []
        for h in (await Sandbox.list()).sandboxes:
            if not h.name.startswith((RUN_PREFIX, GOLDEN_PREFIX)):
                continue
            # created_at is epoch milliseconds in microsandbox 0.7.13.
            if h.created_at and time.time() - h.created_at / 1000 > max_age_s:
                try:
                    await force_remove(h.name)
                    killed.append(h.name)
                except MicrosandboxError as e:
                    log.warning("janitor could not remove %s: %s", h.name, e)
        return killed


def default_probe_targets() -> list[dict]:
    targets = [
        {"label": "metadata service", "host": "169.254.169.254", "port": 80},
        {"label": "internet", "host": "1.1.1.1", "port": 443},
    ]
    prod_host = os.environ.get("SHADOWRUN_PROBE_PROD_HOST")
    if prod_host:
        targets.insert(0, {"label": "prod database", "host": prod_host, "port": int(os.environ.get("SHADOWRUN_PROBE_PROD_PORT", "5432"))})
    return targets


async def _run_attack(sb: Sandbox, script: str, timeout: float) -> dict:
    # Output is capped inside the guest, so a plan printing forever cannot exhaust the host.
    await sb.fs.write("/tmp/attack.sh", script.encode())
    t0 = time.perf_counter()
    try:
        r = await sb.exec("bash", ["-c", "bash /tmp/attack.sh 2>&1 | head -c 200000; rm -f /tmp/attack.sh"], timeout=timeout)
        return {
            "exit_code": r.exit_code,
            "output_tail": r.stdout_text[-1500:],
            "wall_ms": _ms(t0),
            "ended": "exited",
        }
    except MicrosandboxError as e:
        return {"exit_code": None, "output_tail": "", "wall_ms": _ms(t0), "ended": type(e).__name__, "detail": str(e)[:300]}


async def force_remove(name: str) -> None:
    try:
        h = await Sandbox.get(name)
    except SandboxNotFoundError:
        return
    try:
        await h.kill()
    except MicrosandboxError:
        pass
    await Sandbox.remove(name)


async def _destroy(sb: Sandbox, name: str) -> None:
    try:
        await asyncio.wait_for(sb.destroy(force=True, timeout=10), timeout=20)
        return
    except (MicrosandboxError, asyncio.TimeoutError) as e:
        log.warning("destroy %s: %s; forcing", name, e)
    try:
        await force_remove(name)
    except MicrosandboxError as e:
        log.error("force_remove %s failed: %s", name, e)


async def teardown_proof(name: str) -> dict:
    """Checked from the host, independently of what the destroy call returned."""
    listed = [h.name for h in (await Sandbox.list()).sandboxes]
    rootfs = msb_home() / "sandboxes" / name
    procs = subprocess.run(["pgrep", "-fc", name], capture_output=True, text=True)
    # pgrep counts itself out, but not a parent shell whose args contain the name.
    leftover = int(procs.stdout.strip() or 0)
    return {
        "sandbox_listed": name in listed,
        "other_run_sandboxes": len([n for n in listed if n.startswith(RUN_PREFIX) and n != name]),
        "rootfs_exists": rootfs.exists(),
        "leftover_processes": leftover,
        "ok": name not in listed and not rootfs.exists() and leftover == 0,
    }


def _contained(rec: dict) -> bool:
    """True only when every host-visible check passed. Absent evidence is a failure."""
    probes = rec.get("probes") or {}
    return bool(
        rec.get("teardown", {}).get("ok")
        and probes.get("ok") is True
        and not (set(probes.get("nics", ["unknown"])) - ALLOWED_NICS)
        and rec.get("guest", {}).get("kernel")
        and rec["guest"]["kernel"] != rec["host"]["kernel"]
    )
