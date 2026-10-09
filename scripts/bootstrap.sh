#!/usr/bin/env bash
# One-shot developer bootstrap for Herald OS (macOS and Linux). Safe to re-run after every pull.
#   1. Fetch the pinned upstream snapshot (types for the gateway wire).
#   2. Install Node workspaces.
#   3. Link the system-bridge plugin into the user's Hermes plugins directory.
#   4. Find the Hermes runtime, migrate pre-rename settings, enable the plugin and its toolset.
#   5. Report voice support.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
HERALD_OS_HERMES_ROOT="${HERALD_OS_HERMES_ROOT:-${HERMES_OS_HERMES_ROOT:-}}"
OS="$(uname -s)"
export PATH="$HOME/.local/bin:$PATH"

# macOS: the /usr/bin shims refuse to run until the Xcode license is accepted; the CommandLineTools
# binaries behind them work. Prefer them so `npm install` (node-gyp) and git keep working.
if [[ "$OS" == "Darwin" && -d /Library/Developer/CommandLineTools/usr/bin ]]; then
  export PATH="/Library/Developer/CommandLineTools/usr/bin:$PATH"
  export SDKROOT="${SDKROOT:-/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk}"
fi

echo "==> Syncing upstream snapshot"
bash "$ROOT/scripts/sync-upstream.sh"

echo "==> Installing Node workspaces"
(cd "$ROOT" && npm install)

# Electron fetches its binary on first use rather than at install; do it once here.
echo "==> Fetching the Electron binary"
(cd "$ROOT/apps/desktop" && node -e "require('electron')") || echo "    WARNING: could not download Electron; npm run dev will try again"

# npm strips the executable bit from node-pty's prebuilt spawn-helper; the app also repairs this at
# runtime, but fixing it here keeps packaged builds working. (Linux has no prebuilds; see
# linux/dev/build.sh, which compiles node-pty.)
helper="$ROOT/node_modules/node-pty/prebuilds/$(node -p 'process.platform + "-" + process.arch')/spawn-helper"
[[ -f "$helper" ]] && chmod 755 "$helper"

echo "==> Linking herald-os-bridge plugin into $HERMES_HOME/plugins"
mkdir -p "$HERMES_HOME/plugins"
# The pre-rename link points at a folder that no longer exists; remove it only when it is ours.
legacy="$HERMES_HOME/plugins/hermes-os-bridge"
if [[ -L "$legacy" && "$(readlink "$legacy")" == "$ROOT/plugins/"* ]]; then
  rm -f "$legacy"
  echo "    removed the pre-rename hermes-os-bridge link"
fi
link="$HERMES_HOME/plugins/herald-os-bridge"
if [[ -L "$link" || -e "$link" ]]; then
  rm -rf "$link"
fi
ln -s "$ROOT/plugins/herald-os-bridge" "$link"

echo "==> Verifying Hermes runtime"
HERMES_CMD=()
HERMES_PY=""
# A checkout in either layout, as the shell looks (apps/desktop/electron/backend/resolve.ts): the
# launcher today's installers publish, or the venv earlier ones made.
checkout_runtime() {
  if [[ -x "$1/.hermes/bin/hermes" ]]; then
    HERMES_CMD=("$1/.hermes/bin/hermes")
  elif [[ -x "$1/venv/bin/python" ]]; then
    HERMES_PY="$1/venv/bin/python"
  else
    return 1
  fi
}
if [[ -n "$HERALD_OS_HERMES_ROOT" ]] && checkout_runtime "$HERALD_OS_HERMES_ROOT"; then
  echo "    HERALD_OS_HERMES_ROOT=$HERALD_OS_HERMES_ROOT"
elif checkout_runtime "$HERMES_HOME/hermes-agent"; then
  echo "    managed install: $HERMES_HOME/hermes-agent"
elif command -v hermes >/dev/null 2>&1; then
  echo "    hermes on PATH: $(command -v hermes)"
  HERMES_CMD=(hermes)
  # A pip/uv install's entry point names its interpreter on the first line.
  shebang="$(head -1 "$(command -v hermes)" 2>/dev/null | sed -n 's/^#!\(.*python[0-9.]*\)$/\1/p')"
  [[ -n "$shebang" && -x "$shebang" ]] && HERMES_PY="$shebang"
else
  echo "    WARNING: no Hermes runtime found. Install it, then re-run this script:" >&2
  echo "      curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash" >&2
fi
[[ -n "$HERMES_PY" && ${#HERMES_CMD[@]} -eq 0 ]] && HERMES_CMD=("$HERMES_PY" -m hermes_cli.main)
runtime_root="${HERALD_OS_HERMES_ROOT:-$HERMES_HOME/hermes-agent}"

# From the runtime checkout, like the `hermes` entry point: an editable install does not map
# top-level modules added after it was created.
hermes_run() {
  (cd "$runtime_root" 2>/dev/null || true; NO_COLOR=1 "${HERMES_CMD[@]}" "$@" </dev/null)
}

# One hermes command and what it changes; a failure stops the bootstrap with Hermes's output.
# `hermes tools enable` reports an unknown toolset as a ✗ line and still exits 0.
hermes_step() {
  local change="$1" output status=0
  shift
  echo "    hermes $*: $change"
  output="$(hermes_run "$@" 2>&1)" || status=$?
  if [[ $status -ne 0 ]] || grep -q '^[[:space:]]*✗' <<<"$output"; then
    echo "bootstrap: \`hermes $*\` failed (exit $status):" >&2
    echo "$output" >&2
    echo "Fix it and run npm run bootstrap again; docs/SYSTEM-BRIDGE.md says how to take back what was already changed." >&2
    exit 1
  fi
}

if [[ ${#HERMES_CMD[@]} -gt 0 ]]; then
  if [[ -n "$HERMES_PY" ]]; then
    echo "==> Migrating settings from the pre-rename Hermes OS"
    HERMES_HOME="$HERMES_HOME" PYTHONPATH="$runtime_root${PYTHONPATH:+:$PYTHONPATH}" "$HERMES_PY" "$ROOT/scripts/migrate-hermes-config.py" || true
  fi

  echo "==> Enabling the system bridge plugin and its toolset"
  # User plugins are opt-in (plugins.enabled) and a saved platform toolset list is authoritative, so
  # both must be recorded. The override prompt is answered "no" (stdin closed): the bridge never
  # replaces built-in tools.
  hermes_step "adds it to plugins.enabled in $HERMES_HOME/config.yaml" plugins enable herald-os-bridge
  hermes_step "saves platform_toolsets.cli with herald_os in it (the tools run only in Herald OS sessions)" tools enable herald_os
  # Upstream defers plugin tools behind its tool-search bridge; with the system tools hidden the
  # agent falls back to shell commands. Keep them direct (Settings -> Hermes & agents -> Tool search
  # turns it back on), writing down the value it had the first time so it can be put back.
  if ! before="$(hermes_run config get tools.tool_search.enabled 2>/dev/null)"; then
    echo "bootstrap: \`hermes config get tools.tool_search.enabled\` failed" >&2
    exit 1
  fi
  before="$(tail -n 1 <<<"$before" | tr -d '[:space:]')"
  record="$HERMES_HOME/herald-os/tool-search-before"
  if [[ "$before" == "off" ]]; then
    echo "    tools.tool_search.enabled is off already"
  else
    if [[ ! -f "$record" ]]; then
      mkdir -p "$(dirname "$record")"
      echo "$before" >"$record"
    fi
    hermes_step "turns Tool Search off for every Hermes session (it was $before; saved in $record)" config set tools.tool_search.enabled off
  fi

  echo "==> Checking voice support (docs/VOICE.md)"
  # The Live engine and the spoken-reply turn note need the voice-live routes (Hermes 0.21.3 and
  # later). Git installs report version 0.0.0, so look for the module rather than the version.
  if [[ -f "$runtime_root/tools/voice_live.py" ]]; then
    echo "    voice-live routes: available"
  elif [[ -d "$runtime_root" ]]; then
    echo "    WARNING: this Hermes has no voice-live routes; run 'hermes update' for the Live voice engine." >&2
  fi
  if [[ -n "$HERMES_PY" ]]; then
    "$HERMES_PY" - <<'PY' || true
import importlib
for name, purpose in (("openwakeword", "wake word"), ("faster_whisper", "local STT"), ("edge_tts", "free TTS")):
    try:
        importlib.import_module(name)
        print(f"    {name}: ok ({purpose})")
    except Exception:
        print(f"    {name}: missing ({purpose}); install with: pip install 'hermes-agent[voice]' inside the Hermes venv")
PY
  else
    # Today's layout keeps its Python dependencies out of the checkout, so its modules are not looked at here.
    echo "    voice extras: hermes pm install --extra voice --extra edge-tts --extra wake-openwakeword adds them (local STT, free TTS, wake word)"
  fi
fi

echo "==> Done. Start Herald OS with: npm run dev"
