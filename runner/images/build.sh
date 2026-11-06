#!/usr/bin/env bash
# Builds the rehearsal images with Docker and loads them into the microsandbox image store.
set -euo pipefail
umask 022
HERE="$(cd "$(dirname "$0")" && pwd)"
LOAD_AS="${LOAD_AS:-}"   # optional user to load the image for (the VX1 uses sbx)
for spec in "sr-target:0.1 sr-target capture.sql txrun.py driver.py" "sr-host:0.1 sr-host host_driver.py"; do
  set -- $spec
  TAG="$1"; DIR="$2"; shift 2
  # Image tars are large, and /tmp is often a small tmpfs, so use real disk.
  mkdir -p "$HERE/../../var/tmp"
  CTX="$(mktemp -d -p "$HERE/../../var/tmp")"
  cp "$HERE/$DIR/"* "$CTX/"
  for f in "$@"; do cp "$HERE/../guest/$f" "$CTX/"; done
  docker build -q -t "$TAG" "$CTX" >/dev/null
  docker save "$TAG" -o "$CTX/image.tar"
  chmod 755 "$CTX"; chmod 644 "$CTX/image.tar"
  if [ -n "$LOAD_AS" ]; then
    runuser -u "$LOAD_AS" -- bash -c "umask 022; export PATH=\"$PATH\"; msb load -q -i '$CTX/image.tar' -t '$TAG'"
  else
    msb load -q -i "$CTX/image.tar" -t "$TAG"
  fi
  rm -rf "$CTX"
  echo "loaded $TAG"
done
