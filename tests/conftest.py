import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("MSB_NO_UPDATE_CHECK", "1")


def msb_ok() -> bool:
    return shutil.which("msb") is not None and os.access("/dev/kvm", os.R_OK | os.W_OK)


def msb_sandboxes() -> list[str]:
    out = subprocess.run(["msb", "ls", "--format", "json"], capture_output=True, text=True, check=True).stdout
    data = json.loads(out or "[]")
    items = data if isinstance(data, list) else data.get("sandboxes", [])
    return [s.get("name") for s in items]


@pytest.fixture(scope="session")
def prod_dsn() -> str:
    if shutil.which("docker") is None:
        pytest.skip("docker not available")
    return subprocess.run(["bash", str(ROOT / "scripts/dev/up.sh")], capture_output=True, text=True, check=True).stdout.strip()


@pytest.fixture(scope="session")
def demo_dump(prod_dsn: str, tmp_path_factory) -> Path:
    """A real pg_dump of the seeded demo prod."""
    import psycopg

    from demo.seed import seed

    with psycopg.connect(prod_dsn) as c:
        n = c.execute("select count(*) from information_schema.tables where table_schema='public'").fetchone()[0]
        if n == 0:
            seed(c)
    path = tmp_path_factory.mktemp("snap") / "prod.dump"
    env = {**os.environ, "PGPASSWORD": prod_dsn.split(":")[2].split("@")[0], "PATH": f"{ROOT}/scripts/dev/bin:{os.environ['PATH']}"}
    with open(path, "wb") as f:
        subprocess.run(["pg_dump", "-Fc", "-h", "127.0.0.1", "-p", "55432", "-U", "postgres", "-d", "prod"], stdout=f, env=env, check=True)
    return path


@pytest.fixture(autouse=True)
def second_reader_agrees(request, monkeypatch):
    """The check for getting around a rule asks a second model, and no test may depend on a live model call. It agrees by
    default; a test about it sets its own answer, and the KVM tests that run the real loop keep the real one."""
    if request.node.get_closest_marker("kvm"):
        return
    from control import evasion

    monkeypatch.setattr(evasion, "second_reader", lambda *a, **k: {"model": "test", "verdict": "respects_it", "reason": ""})


@pytest.fixture(autouse=True)
def no_live_model(request, monkeypatch):
    """Only the KVM tests may reach a real model. Anywhere else a model call is a test that forgot its stub: it would spend
    credit on a developer's machine and fail in CI, which has no key."""
    if request.node.get_closest_marker("kvm"):
        return
    from control import llm

    def refuse(*a, **k):
        raise AssertionError("a test reached a live model: stub agent.explain, evasion.second_reader or llm.chat")

    monkeypatch.setattr(llm, "_client", refuse)
