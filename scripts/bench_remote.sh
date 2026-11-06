#!/usr/bin/env bash
# Run a command on the control VM with the benchmark's environment, inside the VPC next to Postgres and the runner.
# The benchmark's database role goes over SSH into a root-only file. Usage: scripts/bench_remote.sh '<command>'
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IP="$(python3 -c "import json;print(json.load(open('$ROOT/infra/STATE.json'))['instances']['control']['main_ip'])")"
SSH=(ssh -i "$ROOT/infra/.ssh/shadowrun_ed25519" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "root@$IP")
grep -E '^SHADOWRUN_BENCH_' "$ROOT/.env" | "${SSH[@]}" 'umask 077; cat > /etc/shadowrun/bench.env'
# main carries the same tree as a squashed commit, and it's the one a reader can look up.
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)"
if [ "$(git -C "$ROOT" rev-parse 'HEAD^{tree}' 2>/dev/null)" = "$(git -C "$ROOT" rev-parse 'main^{tree}' 2>/dev/null)" ]; then
  COMMIT="$(git -C "$ROOT" rev-parse --short main)"
fi
"${SSH[@]}" "cd /opt/shadowrun && set -a && . /etc/shadowrun/control.env && . /etc/shadowrun/bench.env && set +a && export SHADOWRUN_GIT_COMMIT=$COMMIT PATH=/opt/shadowrun/.venv/bin:\$PATH && $1"
# What the benchmark wrote on the VM comes home, or make_readme_table.py finds nothing.
rsync -rtz -u --include='*.json' --include='*.jsonl' --exclude='*' -e "ssh -i '$ROOT/infra/.ssh/shadowrun_ed25519' -o BatchMode=yes" "root@$IP:/opt/shadowrun/bench/" "$ROOT/bench/"
