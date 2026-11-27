#!/usr/bin/env bash
# The Hermes revision firstboot.sh checks out, as the one line /etc/herald-os/ref holds:
# HERMES_REF=<sha from upstream/UPSTREAM.lock>. packages.sh writes it into the image and
# linux/vm/make-seed.sh into the development VM's seed, both through this script, so an install from
# the ISO and the VM check out the same commit in the same way.
#
#   hermes-ref.sh <UPSTREAM.lock>            prints the line
#   hermes-ref.sh <UPSTREAM.lock> <file>     writes it to <file> (mode 0644)
#
# A lock without exactly one full commit sha stops it: without the file, firstboot.sh would take
# Hermes's main branch, which is not the revision the release was tested with.
set -euo pipefail

LOCK="${1:?usage: hermes-ref.sh <UPSTREAM.lock> [<file>]}"
OUT="${2:-}"

[[ -f "$LOCK" ]] || { echo "hermes-ref: $LOCK does not exist" >&2; exit 1; }
sha="$(sed -n 's/^sha=//p' "$LOCK" | tr -d '[:space:]')"
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "hermes-ref: $LOCK has no sha= with one full 40-character commit id (found '$sha')" >&2
  exit 1
fi

line="HERMES_REF=$sha"
if [[ -z "$OUT" ]]; then
  echo "$line"
else
  install -d "$(dirname "$OUT")"
  echo "$line" >"$OUT"
  chmod 0644 "$OUT"
fi
