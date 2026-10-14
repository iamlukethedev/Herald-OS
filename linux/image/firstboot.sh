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
#   firstboot.sh login    on a system switched from another bootc system, the login screen and no
#                         session user without a password: every boot, before greetd
#                         (herald-os-login.service)
#   firstboot.sh          system and apps, in order (the development VM's provisioner)
set -euo pipefail

PHASE="${1:-all}"
HERMES_USER="${HERMES_USER:-hermes}"
STATE=/var/lib/herald-os
# There on a system switched to Herald OS from another bootc system, which brought accounts of its
# own: greetd shows a login screen instead of signing the session user in, and the session user never
# has an empty password. The shell's setup reads it too: whoever got past the login screen has a
# password already.
SWITCHED="$STATE/login-screen"
GREETD=/etc/greetd/config.toml
LOGIN_DEFS=/etc/login.defs
HOMES=(/var/home/* /home/*)
NOLOGIN=/usr/sbin/nologin
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

# What a system switched to Herald OS brought along, one line each; an install from the image has
# none, since the session user is the first account it gets. Accounts in login.defs's UID range or
# systemd-homed's that are older than the session user (all of them while it does not exist yet),
# and folders in /home that are not the session user's: accounts getent does not list (SSSD, LDAP)
# have those too. When the accounts cannot be read, that is a line as well: in doubt, the system
# counts as switched, since an image install that takes itself for one shows a login screen, while a
# switched system that takes itself for an image install signs a passwordless administrator in.
earlier_accounts() {
  local min max mine entries home owner
  min="$(awk '$1 == "UID_MIN" { print $2 }' "$LOGIN_DEFS" 2>/dev/null || true)"
  max="$(awk '$1 == "UID_MAX" { print $2 }' "$LOGIN_DEFS" 2>/dev/null || true)"
  mine="$(id -u "$HERMES_USER" 2>/dev/null || echo 4294967295)"
  if ! entries="$(getent passwd)" || [[ -z "$entries" ]]; then
    echo "(the account list could not be read)"
  fi
  awk -F: -v min="${min:-1000}" -v max="${max:-60000}" -v homed_min=60001 -v homed_max=60513 -v mine="$mine" -v me="$HERMES_USER" \
    '$1 != me && $3 + 0 < mine + 0 && (($3 + 0 >= min + 0 && $3 + 0 <= max + 0) || ($3 + 0 >= homed_min && $3 + 0 <= homed_max)) { print $1 }' <<<"$entries"
  for home in "${HOMES[@]}"; do
    [[ -d "$home" && "${home##*/}" != "$HERMES_USER" && "${home##*/}" != lost+found ]] || continue
    owner="$(stat -c %U "$home" 2>/dev/null || echo "an unknown owner")"
    [[ "$owner" == "$HERMES_USER" ]] || echo "$home ($owner)"
  done
}

# Whether this system was switched to Herald OS from another one. The first time it is seen, it is
# written down, so it stays so through `herald-os reset`.
switched() {
  [[ -f "$SWITCHED" ]] && return 0
  local accounts
  accounts="$(earlier_accounts | sort -u | tr '\n' ' ')"
  [[ -n "$accounts" ]] || return 1
  echo "switched from another system, which has these accounts: $accounts"
  date -Is >"$SWITCHED"
}

# A password someone set: not empty, and not locked or never set ("!", "*").
has_password() {
  local hash
  hash="$(getent shadow "$HERMES_USER" | cut -d: -f2)"
  [[ -n "$hash" && "$hash" != '!'* && "$hash" != '*'* ]]
}

# The session user, made unless it is there. From the image it starts with no password: the shell's
# setup asks for one at once (and the lock screen refuses until there is one). On a switched system
# it starts locked and with no shell, so no one can sign in to it (an SSH key included) or use its
# administrator rights, until someone with an account gives it a password (sudo passwd hermes).
session_account() {
  id "$HERMES_USER" >/dev/null 2>&1 && return 0
  if switched; then
    useradd -m -G wheel -s "$NOLOGIN" "$HERMES_USER"
    usermod -L "$HERMES_USER"
  else
    useradd -m -G wheel "$HERMES_USER"
    passwd -d "$HERMES_USER" >/dev/null
  fi
}

# A switched system's login screen: greetd asks who signs in instead of signing the session user in.
# The account is locked before greetd's config changes, and herald-os-login.service holds greetd back
# until both are done (greetd.service.d/herald-os-login.conf): until then greetd could still be the
# stock one, which signs the session user in without asking. A session user an earlier first boot
# left with an empty password is locked and loses its shell; once someone gives it a password, its
# shell comes back.
login_screen() {
  if id "$HERMES_USER" >/dev/null 2>&1; then
    if [[ -z "$(getent shadow "$HERMES_USER" | cut -d: -f2)" ]]; then
      usermod -L -s "$NOLOGIN" "$HERMES_USER"
      echo "$HERMES_USER had no password: locked until someone gives it one (sudo passwd $HERMES_USER)"
    elif has_password && [[ "$(getent passwd "$HERMES_USER" | cut -d: -f7)" == "$NOLOGIN" ]]; then
      usermod -s /bin/bash "$HERMES_USER"
      echo "$HERMES_USER has a password now, and its shell back"
    fi
  fi
  if ! cmp -s "$SHARE/session/greetd-login.toml" "$GREETD"; then
    install -m 0644 "$SHARE/session/greetd-login.toml" "$GREETD"
    echo "greetd shows a login screen: sign in to your own account, or to $HERMES_USER once it has a password"
  fi
}

# greetd on the first boot: from the image it signs the session user in, on a switched system it
# shows the login screen.
greeter() {
  if switched; then
    login_screen
  else
    local config
    config="$(sed "s/^user = .*/user = \"$HERMES_USER\"/" "$GREETD")"
    printf '%s\n' "$config" >"$GREETD"
  fi
}

system_phase() {
  step "The session user ($HERMES_USER)"
  session_account
  HOME_DIR="$(getent passwd "$HERMES_USER" | cut -d: -f6)"
  usermod -aG video,input,render,audio "$HERMES_USER" 2>/dev/null || true
  if getent group seat >/dev/null; then
    usermod -aG seat "$HERMES_USER" || true
  fi
  # The user's systemd instance (pipewire, portals) keeps running when no one is logged in.
  loginctl enable-linger "$HERMES_USER" || true

  step "The login screen"
  greeter
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
      return 0
    fi
    note retrying
    echo "Hermes Agent did not install; trying again in $((RETRY_WAIT / 60)) minutes"
    sleep "$RETRY_WAIT"
  done
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
  # Also puts right a system switched before first boots told switched systems apart.
  login) if switched; then login_screen; fi ;;
  all) system_phase; apps_phase ;;
  *) echo "usage: $0 [system|hermes|apps|login]" >&2; exit 2 ;;
esac
echo "==> first boot ($PHASE) done"
