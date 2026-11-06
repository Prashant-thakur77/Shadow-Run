#!/usr/bin/env bash
# Run the runner and control plane on this machine, against the local Postgres. Dev only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
export PATH="$ROOT/.venv/bin:$ROOT/scripts/dev/bin:$PATH" PYTHONPATH="$ROOT"
umask 022
# /tmp is a small tmpfs with a per-user quota here, and other projects fill it. Clones and dumps are large.
mkdir -p "$ROOT/var/tmp"
export TMPDIR="$ROOT/var/tmp"
TOKEN="$(grep '^RUNNER_TOKEN=' var/local/control.env | cut -d= -f2-)"
if [ -f var/local/runner.pid ]; then kill "$(cat var/local/runner.pid)" 2>/dev/null || true; fi
if [ -f var/local/control.pid ]; then kill "$(cat var/local/control.pid)" 2>/dev/null || true; fi
sleep 1
RUNNER_TOKEN="$TOKEN" SHADOWRUN_RUNNER_BIND=127.0.0.1 SHADOWRUN_RUNNER_PORT=8101 SHADOWRUN_RUNNER_TMP="$ROOT/var/local" SHADOWRUN_VM_PARALLEL=2 \
  SHADOWRUN_PROBE_PROD_HOST=127.0.0.1 SHADOWRUN_PROBE_PROD_PORT=55432 SHADOWRUN_ENV_FILE=/nonexistent \
  nohup python -m runner.service > var/logs/local-runner.log 2>&1 &
echo $! > var/local/runner.pid
SHADOWRUN_ENV_FILE="$ROOT/var/local/control.env" nohup uvicorn control.api:app --host 127.0.0.1 --port 8100 > var/logs/local-control.log 2>&1 &
echo $! > var/local/control.pid
