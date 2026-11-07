#!/usr/bin/env bash
# Everything the README and the video quote, measured on the live deployment, in the order that keeps it honest.
# Usage: scripts/final.sh [checks|bench|publish|all]. Assumes scripts/up.sh has built the stack. Stops at the first failure.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
set -a; . ./.env; set +a
. .venv/bin/activate
URL="$(python3 -c "import json;print(json.load(open('infra/STATE.json'))['public_url'])")"
unset SHADOWRUN_URL   # the scripts then use the live URL from STATE.json
curl -fsS -m 20 "$URL/api/public" >/dev/null || { echo "the live URL does not answer: $URL"; exit 1; }

STAGE="starting"
trap 'status=$?; [ "$status" -eq 0 ] || echo "FAILED at: $STAGE (exit $status). The numbers on the page are not from a complete run." >&2' EXIT

stage() {
  STAGE="$1"
  echo "=== $(date -u +%H:%M:%S) $STAGE"
}

remote() {
  stage "$1"
  bash scripts/bench_remote.sh "$1"
}

# A run that ends with harness errors exits non-zero. --resume retries only what failed, and refuses if the code has changed.
run_bench() {
  local cmd="python -m bench.run $*"
  stage "$cmd"
  bash scripts/bench_remote.sh "$cmd" && return 0
  stage "$cmd --resume"
  bash scripts/bench_remote.sh "$cmd --resume"
}

# bench.run hashes the files on the VM, so a run from a stale deploy would be labelled honestly but measure the wrong code.
check_deployed() {
  stage "the VM has the code that's here"
  local here there
  here="$(python -c 'from bench import provenance as p; print(p.code_sha256(p.code_manifest()))')"
  there="$(bash scripts/bench_remote.sh "python -c 'from bench import provenance as p; print(p.code_sha256(p.code_manifest()))'" | tail -1)"
  if [ "$here" != "$there" ]; then
    echo "the VM's measuring code is $there and this checkout's is $here. Deploy first: python infra/deploy.py --quick" >&2
    exit 1
  fi
}

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
  stage "the oracles, on this machine, with Docker and microVMs"
  python -m bench.validate
  check_deployed

  # The main table, then the two that ask how much of it is the rehearsal and how much is the demo's schema.
  run_bench --runs 3 --parallel 4
  run_bench --runs 3 --parallel 4 --modes rules_in_prompt rollback --split heldout external --target postgres --label controls
  run_bench --runs 3 --parallel 4 --modes direct shadow_run --split heldout --target postgres --restrict-fks --label restrict
  run_bench --runs 3 --parallel 4 --modes shadow_run --scope-file demo/wider_list.yaml

  remote 'python -m bench.clone_check'
  remote 'python -m bench.scale --scales 1 8 90 320'
  run_bench --runs 1 --parallel 4 --split heldout --model glm-5.3
  run_bench --runs 1 --parallel 4 --split heldout --model deepseek-v4.1-flash-1017
  remote 'python -m bench.reviewer_eval'

  stage "scores that read the runs above"
  python -m bench.gate_score
  python -m bench.gate_replay
  python -m bench.second_opinion_eval
  python -m bench.rescore
  python -m bench.stats
}

publish() {
  stage "publish"
  python scripts/make_readme_table.py
  python scripts/make_submission.py
  python scripts/make_slides.py
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
STAGE="done"
