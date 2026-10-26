#!/usr/bin/env bash
# Build the Keep Watch helper program (ADR 0082) into the folder Tauri ships
# as Resources/keep-watch-helper/. presign.sh signs it; build.sh checks the
# signed copy in the built app against the requirement root installs it with.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="$REPO_ROOT/apps/desktop/src-tauri/keep-watch-helper"
mkdir -p "$OUT_DIR"
clang -Wall -Wextra -Werror -O2 -arch arm64 -arch x86_64 -mmacosx-version-min=13.5 \
  -o "$OUT_DIR/ai.northkeep.keepwatch-helper" "$REPO_ROOT/apps/desktop/keep-watch-helper/main.c"
echo "keep-watch-helper: built"
