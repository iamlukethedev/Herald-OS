#!/usr/bin/env bash
# From the Mac: push this repo into the VM over SSH, build it there, restart the shell.
# Works with the QEMU runner (linux/vm/run-qemu.sh) and with UTM (forward guest port 22 to 2222,
# or set HERALD_VM_HOST to the VM's IP).
#
#   bash linux/dev/push.sh                      # sync + build + restart
#   bash linux/dev/push.sh --with-hermes-config # also copy ~/.hermes/{config.yaml,.env} (model choice, API keys)
#   bash linux/dev/push.sh --with-hermes-auth   # ALSO copy ~/.hermes/auth.json (OAuth logins). Read the warning below.
#   bash linux/dev/push.sh --no-build           # sync only
#   bash linux/dev/push.sh ssh                  # open a shell in the VM
#
# OAuth providers (Nous Portal, Codex, Copilot) use rotating refresh tokens: whichever machine
# refreshes second is logged out. Copying auth.json therefore works only until the next refresh and
# can log the Mac out. Prefer signing the VM in on its own (Herald OS's sign-in card, or `hermes
# setup` over SSH), or sharing the Mac's login through `hermes proxy` (docs/LINUX.md).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
KEY="$ROOT/linux/vm/build/id_hermes"
HOST="${HERALD_VM_HOST:-${HERMES_VM_HOST:-127.0.0.1}}"
PORT="${HERALD_VM_PORT:-${HERMES_VM_PORT:-2222}}"
SSH=(ssh -i "$KEY" -p "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR hermes@"$HOST")

[[ -f "$KEY" ]] || { echo "missing $KEY: run bash linux/vm/make-seed.sh first" >&2; exit 1; }

BUILD=1
WITH_CONFIG=
WITH_AUTH=
for arg in "$@"; do
  case "$arg" in
    ssh) exec "${SSH[@]}" ;;
    --no-build) BUILD= ;;
    --with-hermes-config) WITH_CONFIG=1 ;;
    --with-hermes-auth) WITH_CONFIG=1; WITH_AUTH=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

echo "==> waiting for sshd on $HOST:$PORT"
for _ in $(seq 1 60); do
  "${SSH[@]}" -o ConnectTimeout=3 true 2>/dev/null && break
  sleep 3
done
"${SSH[@]}" -o ConnectTimeout=3 true

echo "==> syncing repo -> hermes@$HOST:~/Herald-OS"
"${SSH[@]}" 'mkdir -p ~/Herald-OS'
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude release --exclude .git \
  --exclude 'upstream/hermes-agent' --exclude 'linux/vm/build' --exclude '.DS_Store' \
  --exclude 'third_party/agent-desktop/target' \
  -e "ssh -i $KEY -p $PORT -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR" \
  "$ROOT/" hermes@"$HOST":Herald-OS/

if [[ -n "$WITH_CONFIG" ]]; then
  FILES=(config.yaml .env)
  if [[ -n "$WITH_AUTH" ]]; then
    FILES+=(auth.json)
    echo "==> WARNING: copying auth.json; OAuth refresh tokens rotate, so the Mac may be logged out on the next refresh"
  fi
  echo "==> copying Hermes config (${FILES[*]}) into the VM"
  "${SSH[@]}" 'mkdir -p ~/.hermes && chmod 700 ~/.hermes'
  for f in "${FILES[@]}"; do
    if [[ -f "$HOME/.hermes/$f" ]]; then
      scp -q -i "$KEY" -P "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$HOME/.hermes/$f" hermes@"$HOST":.hermes/"$f"
    fi
  done
fi

if [[ -n "$BUILD" ]]; then
  "${SSH[@]}" 'export PATH="$HOME/.local/bin:$PATH"; bash ~/Herald-OS/linux/dev/build.sh && bash ~/Herald-OS/linux/dev/restart-shell.sh'
fi
echo "==> done"
