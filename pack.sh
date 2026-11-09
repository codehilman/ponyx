#!/usr/bin/env bash
# Builds the zip to upload at https://extensions.gnome.org/upload/
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="ponyx@codehilman"
OUT="$ROOT/dist"

mkdir -p "$OUT"
gnome-extensions pack "$ROOT/$UUID" \
    --extra-source=usage.js \
    --extra-source=media.js \
    --extra-source=lyrics.js \
    --out-dir="$OUT" \
    --force

echo "Built $OUT/$UUID.shell-extension.zip"
