#!/usr/bin/env bash
# Migration: the session starts niri with Herald's own ~/.config/niri/herald-os.kdl instead of
# ~/.config/niri/config.kdl, which is the person's. Renders the new file, then turns Herald's old copy
# of config.kdl (recognised by its first line) into an include of it: a niri still running with the
# old path reloads into the same config, and `niri validate -c ~/.config/niri/config.kdl` still
# checks Herald's. A config.kdl of the person's own is left alone. Safe to re-run.
# Runs as: user
set -euo pipefail

HEADER="// Herald OS: niri compositor configuration."
NIRI="$HOME/.config/niri"

command -v herald-os >/dev/null || exit 0
herald-os keymap apply
[[ -f "$NIRI/herald-os.kdl" ]] || { echo "    herald-os keymap apply wrote no $NIRI/herald-os.kdl" >&2; exit 1; }

if [[ -f "$NIRI/config.kdl" && "$(head -n 1 "$NIRI/config.kdl")" == "$HEADER" ]] && ! grep -qx 'include "herald-os.kdl"' "$NIRI/config.kdl"; then
  {
    echo "$HEADER"
    echo "// Herald OS no longer writes this file: its session starts niri with herald-os.kdl. This"
    echo "// include keeps older sessions and niri validate working; replace it with a config of your own"
    echo "// whenever you like."
    echo 'include "herald-os.kdl"'
  } >"$NIRI/config.kdl.new"
  mv "$NIRI/config.kdl.new" "$NIRI/config.kdl"
  echo "    ~/.config/niri/config.kdl now includes herald-os.kdl"
fi
exit 0
