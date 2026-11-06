#!/usr/bin/env bash
# Everything from an empty Vultr account to a live HTTPS URL. Needs VULTR_API_KEY and VULTR_INFERENCE_KEY in .env.
set -euo pipefail
cd "$(dirname "$0")/.."
python infra/provision.py
python infra/seed_prod.py
python infra/bench_role.py
python infra/deploy.py
python scripts/make_readme_table.py
python -c "import json;print('live at', json.load(open('infra/STATE.json'))['public_url'])"
