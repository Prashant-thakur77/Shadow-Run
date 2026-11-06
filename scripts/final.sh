#!/usr/bin/env bash
# Everything the README and the video quote, measured on the live deployment, in the order that keeps it honest.
# Usage: scripts/final.sh [checks|bench|publish|all]. Assumes scripts/up.sh has built the stack.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
set -a; . ./.env; set +a
. .venv/bin/activate
URL="$(python3 -c "import json;print(json.load(open('infra/STATE.json'))['public_url'])")"
unset SHADOWRUN_URL   # the scripts then use the live URL from STATE.json
curl -fsS -m 20 "$URL/api/public" >/dev/null || { echo "the live URL does not answer: $URL"; exit 1; }

checks() {
  python scripts/redteam_live.py
  python -m checker.controls
  python scripts/soak.py --n 50
  python scripts/incidents_live.py
  python scripts/gauntlet_live.py
  # The VM's Receipts and Results pages read these files.
  python infra/deploy.py control --quick
}

bench() {
  # The suite has to run on the policy being published, so this comes after any change to it.
  # The oracles were validated when the suite was frozen (python -m bench.validate, which needs Docker).
  bash scripts/bench_remote.sh 'python -m bench.run --runs 3 --parallel 4'
  bash scripts/bench_remote.sh 'python -m bench.clone_check'
  bash scripts/bench_remote.sh 'python -m bench.scale --scales 1 8 90 320'
  bash scripts/bench_remote.sh 'python -m bench.run --runs 1 --parallel 4 --split heldout --model glm-5.3'
  bash scripts/bench_remote.sh 'python -m bench.run --runs 1 --parallel 4 --split heldout --model deepseek-v4.1-flash-1017'
}

publish() {
  python -m bench.gate_score
  python -m bench.gate_replay
  python -m bench.second_opinion_eval
  python scripts/make_readme_table.py
  python scripts/make_submission.py
  python infra/deploy.py control --quick
  node scripts/video/readme_shots.cjs "$URL"
  python scripts/video/narration.py
  node scripts/video/record.cjs "$URL"
  python scripts/video/assemble.py
}

case "${1:-all}" in
  checks) checks ;;
  bench) bench ;;
  publish) publish ;;
  all) checks; bench; publish ;;
  *) echo "usage: $0 [checks|bench|publish|all]"; exit 2 ;;
esac
