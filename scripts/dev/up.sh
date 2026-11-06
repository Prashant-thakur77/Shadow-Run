#!/usr/bin/env bash
# Local stand-in for Vultr Managed Postgres, used only for development and tests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PW_FILE="$ROOT/var/dev-prod-password"
mkdir -p "$ROOT/var"
[ -f "$PW_FILE" ] || (umask 077; head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' > "$PW_FILE")
PW="$(cat "$PW_FILE")"
if docker ps --format '{{.Names}}' | grep -qx sr-prod-pg; then
  # Started from another checkout: its password file isn't this one, so ask the container.
  PW="$(docker exec sr-prod-pg printenv POSTGRES_PASSWORD)"
else
  docker rm -f sr-prod-pg >/dev/null 2>&1 || true
  docker run -d --name sr-prod-pg -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=prod -p 127.0.0.1:55432:5432 postgres:16-bookworm >/dev/null
fi
until docker exec sr-prod-pg pg_isready -q -h 127.0.0.1 -U postgres -d prod; do sleep 0.5; done
echo "postgresql://postgres:$PW@127.0.0.1:55432/prod"
