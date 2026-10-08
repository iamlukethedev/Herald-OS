#!/usr/bin/env bash
# Herald OS Linux, the per-machine half: the session user and everything in a home folder. Runs as
# root and is safe to re-run. The shell's first-boot setup then lets the person choose a name and a
# password, join Wi-Fi and sign in to Hermes.
#
#   firstboot.sh system   the user, the home folder, Hermes Agent: before the login screen
#                         (herald-os-firstboot.service)
#   firstboot.sh hermes   Hermes Agent alone, when the first boot could not install it: waits for
#                         the network, then installs and sets it up (herald-os-hermes.service)
#   firstboot.sh apps     the omakase Flatpaks, after the login screen is up
#                         (herald-os-firstboot-apps.service)
#   firstboot.sh          system and apps, in order (the development VM's provisioner)
set -euo pipefail

PHASE="${1:-all}"
HERMES_USER="${HERMES_USER:-hermes}"
STATE=/var/lib/herald-os
# There while Hermes Agent waits to be installed: one word for how it goes (offline, installing,
# retrying), which the shell's boot screen shows; herald-os-hermes.service runs while it is there.
PENDING="$STATE/hermes-pending"
HERMES_UNIT=/usr/lib/systemd/system/herald-os-hermes.service
BRIDGE=/usr/share/herald-os/bridge
OFFLINE_WAIT=30
RETRY_WAIT=600
mkdir -p "$STATE"

step() { echo; echo "--- $*"; }
# Through pipes: run from a unit, what the command writes straight to the journal never gets there
# (sudo 1.9.17 on Fedora 44), and that is the installer's every word.
as_user() { sudo -u "$HERMES_USER" -H "$@" 2> >(cat >&2) | cat; }
# Whether GitHub, where Hermes Agent comes from, answers. Quiet: offline, it is asked every half minute.
online() { curl -fsI --connect-timeout 10 --max-time 30 -o /dev/null https://github.com/NousResearch/hermes-agent; }
# How the shell's boot screen describes the wait, while there is one.
note() { [[ ! -f "$PENDING" ]] || echo "$1" >"$PENDING"; }

# Where packages.sh put the shared files: the image's /usr/share/herald-os or the VM's /usr/local share.
SHARE=""
for candidate in /usr/share/herald-os /usr/local/share/herald-os-linux "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; do
  if [[ -f "$candidate/niri/config.kdl" && -d "$candidate/session" ]]; then
    SHARE="$candidate"
    break
  fi
done
[[ -n "$SHARE" ]] || { echo "firstboot: the Herald OS files are missing (run packages.sh first)" >&2; exit 1; }

system_phase() {
  step "The session user ($HERMES_USER)"
  if ! id "$HERMES_USER" >/dev/null 2>&1; then
    # No password yet: the lock screen refuses until one is set (first-boot setup or herald-os password).
    useradd -m -G wheel "$HERMES_USER"
    passwd -d "$HERMES_USER" >/dev/null
  fi
  HOME_DIR="$(getent passwd "$HERMES_USER" | cut -d: -f6)"
  usermod -aG video,input,render,audio "$HERMES_USER" 2>/dev/null || true
  if getent group seat >/dev/null; then
    usermod -aG seat "$HERMES_USER" || true
  fi
  # The user's systemd instance (pipewire, portals) keeps running when no one is logged in.
  loginctl enable-linger "$HERMES_USER" || true
  sed -i "s/^user = .*/user = \"$HERMES_USER\"/" /etc/greetd/config.toml

  step "The login screen"
  # Anaconda picks multi-user.target unless its kickstart says otherwise, because greetd provides
  # no service(graphical-login); only graphical.target starts greetd and so the session.
  if [[ "$(systemctl get-default)" != "graphical.target" ]]; then
    systemctl set-default graphical.target
    systemctl --no-block start graphical.target
  fi

  step "Home folder"
  as_user mkdir -p "$HOME_DIR/.local/bin" "$HOME_DIR/.local/share" "$HOME_DIR/.local/state" "$HOME_DIR/.config/herald-os" "$HOME_DIR/.config/niri" "$HOME_DIR/.config/swaylock" "$HOME_DIR/.config/systemd/user"
  as_user env XDG_RUNTIME_DIR="/run/user/$(id -u "$HERMES_USER")" systemctl --user enable herald-os-update-check.timer 2>/dev/null || true
  as_user herald-os-theme set "$(as_user herald-os-theme current)" || true
  # Herald's niri config, rendered with the person's keymap (managed; local.kdl is theirs).
  as_user herald-os keymap apply || install -m 0644 -o "$HERMES_USER" -g "$HERMES_USER" "$SHARE/niri/config.kdl" "$HOME_DIR/.config/niri/herald-os.kdl"
  install -m 0644 -o "$HERMES_USER" -g "$HERMES_USER" "$SHARE/session/swaylock.conf" "$HOME_DIR/.config/swaylock/config"

  if hermes_step; then
    rm -f "$PENDING"
    zouroboros_step
  else
    hermes_later
  fi
  date -Is >"$STATE/firstboot-done"
}

# Hermes Agent for the session user: installed unless it is there already, in whichever layout
# (`herald-os hermes-command` looks for it the way the shell does), given the voice extras, and set
# up for Herald OS. Fails while there is still no Hermes.
hermes_step() {
  step "Hermes Agent for $HERMES_USER"
  if [[ -f /etc/herald-os/ref ]]; then
    # shellcheck disable=SC1091
    source /etc/herald-os/ref
  fi
  local ref="${HERMES_REF:-main}" agent="$HOME_DIR/.hermes/hermes-agent" hermes
  if hermes="$(as_user herald-os hermes-command)"; then
    echo "already installed: ${hermes%%$'\n'*}"
  else
    as_user bash -euo pipefail -c "
      mkdir -p '$HOME_DIR/.hermes'
      # A clone the network cut off has no commits; it starts over.
      if [[ -d '$agent/.git' ]] && ! git -C '$agent' rev-parse --verify --quiet HEAD >/dev/null; then
        rm -rf '$agent'
      fi
      if [[ ! -d '$agent/.git' ]]; then
        # Every commit, but file contents only as checkouts need them: a quarter of the full download.
        git clone --filter=blob:none https://github.com/NousResearch/hermes-agent '$agent'
      fi
      cd '$agent'
      git fetch --quiet origin '$ref' || true
      git checkout --quiet '$ref' || git checkout --quiet main
      # Older setup-hermes.sh asks two yes/no questions (ripgrep, setup wizard): no to both.
      printf 'n\nn\n' | bash ./setup-hermes.sh
    " || true
    hermes="$(as_user herald-os hermes-command)" || return 1
  fi
  # Voice: local transcription, free neural voices and the "hey hermes" wake word. Today's layout
  # takes them through Hermes's own package manager, which keeps them across `hermes update`.
  case "${hermes%%$'\n'*}" in
    "$agent/.hermes/bin/hermes") as_user "$agent/.hermes/bin/hermes" pm install --extra voice --extra edge-tts --extra wake-openwakeword ;;
    "$agent/venv/bin/hermes") as_user bash -c "cd '$agent' && PATH=\"\$HOME/.local/bin:\$PATH\" uv pip install --python venv/bin/python -q -e '.[voice,edge-tts,wake-openwakeword]'" ;;
    *) echo "Hermes Agent came from another installer (${hermes%%$'\n'*}); voice uses cloud providers until it adds the voice extras" ;;
  esac || echo "voice extras failed; voice falls back to cloud providers"
  # The bridge plugin that lets Hermes use the system. The image ships it with the shell; the
  # development VM links the repo's copy when it builds the shell.
  if [[ -d "$BRIDGE" ]]; then
    as_user herald-os setup --yes || echo "WARNING: herald-os setup did not finish"
  fi
}

# The first boot could not install Hermes, usually for want of a network (Wi-Fi is joined later, in
# the shell's setup). On the image herald-os-hermes.service installs it once the computer is online,
# and the shell waits for it; the development VM has no such unit.
hermes_later() {
  if [[ ! -f "$HERMES_UNIT" ]]; then
    echo "WARNING: Hermes Agent did not install (offline?); run $0 hermes as root once this computer is online"
    return 0
  fi
  if online; then echo retrying; else echo offline; fi >"$PENDING"
  echo "WARNING: Hermes Agent did not install (offline?); herald-os-hermes.service installs it once this computer is online, and Herald OS starts it then"
}

# herald-os-hermes.service: wait for the network, then install and set up Hermes; a failed try is
# repeated ten minutes later. The note goes once Hermes is set up, which is what the shell waits for.
hermes_phase() {
  HOME_DIR="$(getent passwd "$HERMES_USER" | cut -d: -f6)"
  while :; do
    if ! online; then
      note offline
      echo "waiting for the network: Hermes Agent comes from GitHub"
      until online; do sleep "$OFFLINE_WAIT"; done
    fi
    note installing
    if hermes_step; then
      rm -f "$PENDING"
      zouroboros_step
      return 0
    fi
    note retrying
    echo "Hermes Agent did not install; trying again in $((RETRY_WAIT / 60)) minutes"
    sleep "$RETRY_WAIT"
  done
}

# The Zouroboros workshop (shared memory, swarm orchestration, factory intake) on top of the Hermes
# Agent installed above. Runs only once Hermes is in and the network is up, in whichever phase got
# there first. Same shape as the Hermes block: clone the repo as the session user, then its own
# setup script. Soft-fails like the voice extras; opt out with HERALD_OS_ZOUROBOROS=0.
zouroboros_step() {
  step "Zouroboros workshop layer for $HERMES_USER"
  if [[ "${HERALD_OS_ZOUROBOROS:-1}" == "1" ]]; then
    as_user bash -euo pipefail -c '
      zo="$HOME/hermes-zouroboros"
      [[ -d "$zo/.git" ]] || git clone --depth 1 https://github.com/marlandoj/hermes-zouroboros "$zo"
      # Reuse the Node runtime the Hermes Agent install fetched; add bun and pnpm next to it.
      for d in "$HOME"/.hermes/tools/node-*/bin; do export PATH="$d:$PATH"; done
      export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
      command -v bun  >/dev/null || curl -fsSL https://bun.sh/install | bash
      export PATH="$HOME/.bun/bin:$PATH"
      command -v pnpm >/dev/null || { corepack prepare pnpm@8.15.0 --activate || npm i -g pnpm@8.15.0; }
      grep -q "hermes-zouroboros toolchain" "$HOME/.bashrc" 2>/dev/null || cat >>"$HOME/.bashrc" <<'"'"'ZORC'"'"'

# hermes-zouroboros toolchain
for d in "$HOME"/.hermes/tools/node-*/bin; do export PATH="$d:$PATH"; done
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
ZORC
      cd "$zo" && bash scripts/setup.sh
      mkdir -p "$HOME/work/hermes-projects"
      bun integration/cli.ts init --workspace "$HOME/work/hermes-projects"
      bun integration/cli.ts doctor
      # Provider sign-in for the Zouroboros profile stays with the person: hermes setup is an
      # interactive wizard and first boot has no TTY. See docs: integration/cli.ts hermes setup.
    ' || echo "WARNING: Zouroboros did not install; run firstboot.sh hermes as root once online to retry"
  fi
}

apps_phase() {
  step "Omakase apps (HERALD_OS_OMAKASE=0 to skip)"
  if [[ "${HERALD_OS_OMAKASE:-1}" == "1" ]]; then
    as_user herald-os-omakase install --flatpaks || echo "WARNING: omakase flatpaks incomplete"
    # Web apps need the shell's icon fetch; herald-os-session installs them on the first login.
  fi
  date -Is >"$STATE/firstboot-apps-done"
}

case "$PHASE" in
  system) system_phase ;;
  hermes) hermes_phase ;;
  apps) apps_phase ;;
  all) system_phase; apps_phase ;;
  *) echo "usage: $0 [system|hermes|apps]" >&2; exit 2 ;;
esac
echo "==> first boot ($PHASE) done"
