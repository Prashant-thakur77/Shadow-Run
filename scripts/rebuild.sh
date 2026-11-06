#!/usr/bin/env bash
# Prove the whole thing from zero: remove every resource, confirm it's gone, create it all again.
set -euo pipefail
cd "$(dirname "$0")/.."
python infra/teardown.py
python infra/budget.py | grep -E 'spent|credit_left'
bash scripts/up.sh
