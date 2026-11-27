#!/usr/bin/env bash
# Inside the VM (UTM with a VirtioFS share): copy the repo from the shared folder into the home
# directory (native modules must be installed on Linux, so the tree is not used in place), build,
# and restart the shell.
#
#   herald-os-sync              # /mnt/herald-os -> ~/Herald-OS, build, restart
set -euo pipefail

SRC="${HERALD_OS_SHARE:-/mnt/herald-os}"
REPO="${HERALD_OS_REPO:-$HOME/Herald-OS}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mountpoint -q "$SRC" || [[ -d "$SRC/apps/desktop" ]] || { echo "shared folder not mounted at $SRC" >&2; exit 1; }

echo "==> syncing $SRC -> $REPO"
mkdir -p "$REPO"
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude release --exclude .git \
  --exclude 'upstream/hermes-agent' --exclude 'linux/vm/build' --exclude '.DS_Store' \
  --exclude 'third_party/agent-desktop/target' \
  "$SRC/" "$REPO/"

bash "$HERE/build.sh"
bash "$HERE/restart-shell.sh" || true
