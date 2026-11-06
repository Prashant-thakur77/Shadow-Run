"""Talks to the runner on the VX1. In dev both ends can be one process via a local runner."""
from __future__ import annotations

from pathlib import Path

import httpx

from control import settings


class RunnerError(RuntimeError):
    pass


class RunnerClient:
    def __init__(self, url: str | None = None, token: str | None = None) -> None:
        self.url = (url or settings.RUNNER_URL).rstrip("/")
        self.token = token if token is not None else settings.RUNNER_TOKEN

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"}

    async def _post(self, path: str, body: dict, timeout: float) -> dict:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(f"{self.url}{path}", json=body, headers=self._headers())
        if r.status_code != 200:
            raise RunnerError(f"runner {path} -> {r.status_code}: {r.text[:300]}")
        return r.json()

    async def health(self) -> dict:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.get(f"{self.url}/health", headers=self._headers())
        if r.status_code != 200:
            raise RunnerError(f"runner /health -> {r.status_code}")
        return r.json()

    async def has_snapshot(self, snapshot_id: str) -> bool:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.get(f"{self.url}/snapshots/{snapshot_id}", headers=self._headers())
        return r.status_code == 200 and r.json().get("exists") is True

    async def put_snapshot(self, snapshot_id: str, dump_path: str | Path) -> dict:
        async def body():
            with open(dump_path, "rb") as f:
                while chunk := f.read(1 << 20):
                    yield chunk

        async with httpx.AsyncClient(timeout=900) as c:
            r = await c.put(f"{self.url}/snapshots/{snapshot_id}", content=body(), headers=self._headers())
        if r.status_code != 200:
            raise RunnerError(f"runner put_snapshot -> {r.status_code}: {r.text[:300]}")
        return r.json()

    async def rehearse(self, run_id: str, snapshot_id: str, steps: list[dict], guardrails: list[dict], max_duration: int = 120, metrics: list[dict] | None = None, undo: bool = True) -> dict:
        return await self._post("/rehearse", {"run_id": run_id, "snapshot_id": snapshot_id, "steps": steps, "guardrails": guardrails, "max_duration": max_duration, "metrics": metrics or [], "undo": undo}, max_duration + 60)

    async def inspect(self, snapshot_id: str, sample_rows: int = 3) -> dict:
        return await self._post("/inspect", {"snapshot_id": snapshot_id, "sample_rows": sample_rows}, 120)

    async def query(self, snapshot_id: str, queries: list[str]) -> dict:
        return await self._post("/query", {"snapshot_id": snapshot_id, "queries": queries}, 120)

    async def suspects(self, snapshot_id: str) -> dict:
        return await self._post("/suspects", {"snapshot_id": snapshot_id}, 120)

    async def attacks(self) -> list[dict]:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.get(f"{self.url}/redteam/attacks", headers=self._headers())
        return r.json()["attacks"]

    async def redteam(self, attack: str, snapshot_id: str) -> dict:
        return await self._post("/redteam", {"attack": attack, "snapshot_id": snapshot_id}, 240)

    async def wall_two(self, snapshot_id: str) -> dict:
        return await self._post("/redteam/wall2", {"snapshot_id": snapshot_id}, 120)

    # Linux host targets
    async def host_ensure(self, host_id: str, seed_sh: str | None = None, recreate: bool = False) -> dict:
        return await self._post("/host/ensure", {"host_id": host_id, "seed_sh": seed_sh, "recreate": recreate}, 240)

    async def host_fingerprint(self, host_id: str) -> dict:
        return await self._post("/host/fingerprint", {"host_id": host_id}, 120)

    async def host_inspect(self, host_id: str) -> dict:
        return await self._post("/host/inspect", {"host_id": host_id}, 120)

    async def host_rehearse(self, run_id: str, host_id: str, steps: list[dict], guardrails: list[dict], max_duration: int = 120) -> dict:
        return await self._post("/host/rehearse", {"run_id": run_id, "host_id": host_id, "steps": steps, "guardrails": guardrails, "max_duration": max_duration}, max_duration + 120)

    async def host_apply(self, host_id: str, steps: list[dict], guardrails: list[dict]) -> dict:
        return await self._post("/host/apply", {"host_id": host_id, "steps": steps, "guardrails": guardrails}, 300)

    async def host_rollback(self, host_id: str, running: list[str]) -> dict:
        return await self._post("/host/rollback", {"host_id": host_id, "running": running}, 240)

    async def host_exec(self, host_id: str, sh: str) -> dict:
        return await self._post("/host/exec", {"host_id": host_id, "sh": sh}, 120)

    async def host_remove(self, host_id: str) -> dict:
        return await self._post("/host/remove", {"host_id": host_id}, 60)
