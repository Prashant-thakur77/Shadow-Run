"""Configuration, read from the environment (.env on the control VM). No secret has a default."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    path = Path(os.environ.get("SHADOWRUN_ENV_FILE", ROOT / ".env"))
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


_load_dotenv()

VAR = Path(os.environ.get("SHADOWRUN_VAR", ROOT / "var"))
DB_PATH = VAR / "control.sqlite3"
SNAP_DIR = VAR / "snapshots"

INFERENCE_BASE = os.environ.get("VULTR_INFERENCE_BASE", "https://api.vultrinference.com/v1")
INFERENCE_KEY = os.environ.get("VULTR_INFERENCE_KEY", "")
PLANNER_MODEL = os.environ.get("SHADOWRUN_MODEL", "qwen3.8-27b")
GUARDRAIL_MODEL = os.environ.get("SHADOWRUN_GUARDRAIL_MODEL", "glm-5.3")
EXPLAINER_MODEL = os.environ.get("SHADOWRUN_EXPLAINER_MODEL", "qwen3.8-27b")
SAFETY_MODEL = os.environ.get("SHADOWRUN_SAFETY_MODEL", "nemotron-3.5-content-safety")

RUNNER_URL = os.environ.get("SHADOWRUN_RUNNER_URL", "http://127.0.0.1:8101")
RUNNER_TOKEN = os.environ.get("RUNNER_TOKEN", "")

HMAC_SECRET = os.environ.get("SHADOWRUN_HMAC_SECRET", "")
SESSION_TTL_S = int(os.environ.get("SHADOWRUN_SESSION_TTL_S", str(12 * 3600)))
APPROVAL_TTL_S = int(os.environ.get("SHADOWRUN_APPROVAL_TTL_S", "900"))
MAX_ATTEMPTS = 3
MAX_ATTEMPTS_HARD_CAP = 5

S3_ENDPOINT = os.environ.get("SHADOWRUN_S3_ENDPOINT", "")
S3_ACCESS_KEY = os.environ.get("SHADOWRUN_S3_ACCESS_KEY", "")
S3_SECRET_KEY = os.environ.get("SHADOWRUN_S3_SECRET_KEY", "")
S3_BUCKET = os.environ.get("SHADOWRUN_S3_BUCKET", "")

PROD_HOST = os.environ.get("SHADOWRUN_PROD_HOST", "")
PROD_PORT = os.environ.get("SHADOWRUN_PROD_PORT", "5432")
PROD_USER = os.environ.get("SHADOWRUN_PROD_USER", "")
PROD_PASSWORD = os.environ.get("SHADOWRUN_PROD_PASSWORD", "")
PROD_DB = os.environ.get("SHADOWRUN_PROD_DB", "")
PROD_SSLMODE = os.environ.get("SHADOWRUN_PROD_SSLMODE", "require")

# Stops a public demo from burning credits; LLM runs started per user per hour.
RUNS_PER_HOUR = int(os.environ.get("SHADOWRUN_RUNS_PER_HOUR", "40"))
MAX_RUNNING = int(os.environ.get("SHADOWRUN_MAX_RUNNING", "8"))
DAILY_USD_CAP = float(os.environ.get("SHADOWRUN_DAILY_USD_CAP", "5"))


def require_secret(name: str, value: str) -> str:
    if not value:
        raise RuntimeError(f"{name} is not set")
    return value
