#!/usr/bin/env bash
# Run the herald-os-bridge plugin tests and the Linux CLI tests.
# Prefers the Hermes runtime's venv when it has pytest and PyYAML (same interpreter the gateway loads
# the plugin with); otherwise runs in an ephemeral uv environment with linux/tests/requirements.txt,
# so the user's Hermes venv is never modified.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
PY="${HERALD_OS_PYTHON:-$HERMES_HOME/hermes-agent/venv/bin/python}"
REQUIREMENTS="$ROOT/linux/tests/requirements.txt"

cd "$ROOT/plugins/herald-os-bridge/tests"
# The CLI tests sit outside the plugin, so with no arguments both folders run; arguments (a file,
# -k) pick tests as before.
SUITES=(. "$ROOT/linux/tests")
[[ $# -eq 0 ]] || SUITES=()

if [[ -x "$PY" ]] && "$PY" -c "import pytest, yaml" >/dev/null 2>&1; then
  exec "$PY" -m pytest -q ${SUITES[@]+"${SUITES[@]}"} "$@"
fi

if command -v uv >/dev/null 2>&1; then
  exec uv run --no-project --python 3.11 --with-requirements "$REQUIREMENTS" python -m pytest -q ${SUITES[@]+"${SUITES[@]}"} "$@"
fi

echo "test-bridge: need either pytest and PyYAML in $PY ($REQUIREMENTS) or uv on PATH" >&2
exit 1
