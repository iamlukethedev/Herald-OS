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
# own; written the first time it is seen, so it stays so through `herald-os reset`.
SWITCHED="$STATE/switched"
# There once the first boot found an install from the image: accounts added since (and folders in
# /home) do not make it a switched system, through `herald-os reset` either.
IMAGE_INSTALL="$STATE/image-install"
# The session user's shell from before it was locked, which it gets back with a password.
SAVED_SHELL="$STATE/hermes-shell"
# There while a switched system's session user waits for a password to join wheel.
ADMIN_PENDING="$STATE/hermes-admin-pending"
FIRSTBOOT_DONE="$STATE/firstboot-done"
# There while greetd shows a login screen instead of signing the session user in, which is when the
# session user never has an empty password. The shell's setup reads it too: whoever got past the
# login screen has a password already.
LOGIN_SCREEN="$STATE/login-screen"
GREETD=/etc/greetd/config.toml
LOGIN_DEFS=/etc/login.defs
HOMES=(/var/home/* /home/*)
NOLOGIN=/usr/sbin/nologin
PASSWD=/etc/passwd
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
# folders in /home that are not the session user's, a system account's (root's stray folders are no
# one's home) or an account's newer than the session user: accounts getent does not list (SSSD,
# LDAP) have those too; and systemd-homed's LUKS images there (/home/<name>.home). When the accounts cannot be read, that is a line as well: in doubt, the system
# counts as switched. Whether that brings a login screen is login_screen_due's: only when an account
# can sign in there.
earlier_accounts() {
  local min max mine entries home owner uid
  min="$(awk '$1 == "UID_MIN" { print $2 }' "$LOGIN_DEFS" 2>/dev/null || true)"
  max="$(awk '$1 == "UID_MAX" { print $2 }' "$LOGIN_DEFS" 2>/dev/null || true)"
  mine="$(id -u "$HERMES_USER" 2>/dev/null || echo 4294967295)"
  if ! entries="$(getent passwd)" || [[ -z "$entries" ]]; then
    echo "(the account list could not be read)"
    entries="$(cat "$PASSWD" 2>/dev/null || true)"
  fi
  awk -F: -v min="${min:-1000}" -v max="${max:-60000}" -v homed_min=60001 -v homed_max=60513 -v mine="$mine" -v me="$HERMES_USER" \
    '$1 != me && $3 + 0 < mine + 0 && (($3 + 0 >= min + 0 && $3 + 0 <= max + 0) || ($3 + 0 >= homed_min && $3 + 0 <= homed_max)) { print $1 }' <<<"$entries"
  for home in "${HOMES[@]}"; do
    if [[ -f "$home" && "$home" == *.home ]]; then
      echo "$home (systemd-homed)"
      continue
    fi
    [[ -d "$home" && "${home##*/}" != "$HERMES_USER" && "${home##*/}" != lost+found ]] || continue
    owner="$(stat -c %U "$home" 2>/dev/null || echo "an unknown owner")"
    [[ "$owner" != "$HERMES_USER" ]] || continue
    uid="$(id -u "$owner" 2>/dev/null || true)"
    if [[ "$uid" =~ ^[0-9]+$ ]] && (( uid < ${min:-1000} || uid >= mine )); then
      continue
    fi
    echo "$home ($owner)"
  done
}

# Whether this system was switched to Herald OS from another one. Worked out once and written down
# either way, so it holds through `herald-os reset` and accounts added later. Only first-boot setup,
# or a run after it finished, writes the answer down: before that, the accounts (systemd-homed's,
# SSSD's) may not be there yet, and an "image install" written down then would stay wrong for good.
# Until then it is worked out again each run, and only held for the run.
SWITCHED_NOW=""
switched() {
  [[ -f "$SWITCHED" ]] && return 0
  [[ -f "$IMAGE_INSTALL" ]] && return 1
  if [[ -z "$SWITCHED_NOW" ]]; then
    local accounts record=""
    [[ "$PHASE" == system || "$PHASE" == all || -f "$FIRSTBOOT_DONE" ]] && record=1
    accounts="$(earlier_accounts | sort -u | tr '\n' ' ')"
    if [[ -z "$accounts" ]]; then
      SWITCHED_NOW=no
      [[ -z "$record" ]] || date -Is >"$IMAGE_INSTALL"
    else
      SWITCHED_NOW=yes
      echo "switched from another system, which has these accounts: $accounts"
      [[ -z "$record" ]] || date -Is >"$SWITCHED"
    fi
    [[ -n "$record" ]] || echo "first-boot setup has not finished: not writing down whether this system was switched yet"
  fi
  [[ "$SWITCHED_NOW" == yes ]]
}

# A password someone set for the account: not empty, and not locked or never set ("!", "*").
has_password() {
  local hash
  hash="$(getent shadow "${1:-$HERMES_USER}" | cut -d: -f2)"
  [[ -n "$hash" && "$hash" != '!'* && "$hash" != '*'* ]]
}

# The accounts other than the session user that can sign in at a login screen, one a line: a local
# one with a shell and a password, a systemd-homed one (in the UID range, or a LUKS image
# /home/<name>.home), and the owner of a folder in /home that getent finds although /etc/passwd does
# not have it (SSSD, LDAP). Those check passwords themselves. A local account whose password is
# locked ("!", "*": a fingerprint, smartcard or SSH key only) is not one: its way in may not be the
# login screen's. In doubt, someone can sign in (fail closed: a login screen and a locked hermes): a
# folder in /home whose owner cannot be resolved (SSSD offline at first boot), and an account list
# that neither getent nor /etc/passwd gives.
sign_in_accounts() {
  local min max entries name uid shell home owner
  min="$(awk '$1 == "UID_MIN" { print $2 }' "$LOGIN_DEFS" 2>/dev/null || true)"
  max="$(awk '$1 == "UID_MAX" { print $2 }' "$LOGIN_DEFS" 2>/dev/null || true)"
  if ! entries="$(getent passwd 2>/dev/null)" || [[ -z "$entries" ]]; then
    entries="$(cat "$PASSWD" 2>/dev/null || true)"
    [[ -n "$entries" ]] || echo "(the account list could not be read)"
  fi
  while IFS=: read -r name _ uid _ _ _ shell; do
    [[ -n "$name" && "$name" != "$HERMES_USER" && "$uid" =~ ^[0-9]+$ ]] || continue
    if (( uid >= 60001 && uid <= 60513 )); then
      echo "$name"
    elif (( uid >= ${min:-1000} && uid <= ${max:-60000} )); then
      case "$shell" in "" | */nologin | */false) continue ;; esac
      ! has_password "$name" || echo "$name"
    fi
  done <<<"$entries"
  for home in "${HOMES[@]}"; do
    if [[ -f "$home" && "$home" == *.home ]]; then
      name="${home##*/}"
      echo "${name%.home}"
      continue
    fi
    [[ -d "$home" && "${home##*/}" != "$HERMES_USER" && "${home##*/}" != lost+found ]] || continue
    owner="$(stat -c %U "$home" 2>/dev/null || true)"
    [[ "$owner" != "$HERMES_USER" ]] || continue
    if [[ -z "$owner" || "$owner" == UNKNOWN ]] || ! getent passwd "$owner" >/dev/null 2>&1; then
      echo "$home (an owner that cannot be looked up)"
      continue
    fi
    if ! grep -q "^$owner:" "$PASSWD" 2>/dev/null && getent passwd "$owner" >/dev/null 2>&1; then
      echo "$owner"
    fi
  done
}

# Whether greetd shows a login screen: on a switched system that has an account that can sign in
# there. A switched system without one would be left with no way in, so the session user signs in
# by itself and the shell's setup asks for its password at once, with a warning in the journal; it
# is not an administrator until it has one (hermes_admin). Worked out once a run.
LOGIN_SCREEN_DUE=""
login_screen_due() {
  if [[ -z "$LOGIN_SCREEN_DUE" ]]; then
    LOGIN_SCREEN_DUE=no
    if switched; then
      local who
      who="$(sign_in_accounts | sort -u | tr '\n' ' ')"
      if [[ -n "$who" ]]; then
        LOGIN_SCREEN_DUE=yes
        echo "the login screen is for: $who"
      else
        echo "WARNING: switched from another system, but none of its accounts can sign in at a login screen (no shell, or no password): $HERMES_USER signs in by itself, Herald OS's setup asks for its password at once, and it joins wheel only once it has one"
      fi
    fi
  fi
  [[ "$LOGIN_SCREEN_DUE" == yes ]]
}

# The session user, made unless it is there. From the image it starts with no password, in wheel:
# the shell's setup asks for a password at once (and the lock screen refuses until there is one). On
# a switched system it is never a passwordless administrator: it starts outside wheel and joins once
# it has a password (hermes_admin). With a login screen it also starts locked and with no shell, so
# no one can sign in to it (an SSH key included) until someone with an account gives it a password
# (sudo passwd hermes); without one, it signs in by itself and setup asks for the password.
session_account() {
  id "$HERMES_USER" >/dev/null 2>&1 && return 0
  if login_screen_due; then
    useradd -D 2>/dev/null | awk -F= '$1 == "SHELL" { print $2 }' >"$SAVED_SHELL" || true
    useradd -m -s "$NOLOGIN" "$HERMES_USER"
    usermod -L "$HERMES_USER"
    date -Is >"$ADMIN_PENDING"
  elif switched; then
    useradd -m "$HERMES_USER"
    passwd -d "$HERMES_USER" >/dev/null
    date -Is >"$ADMIN_PENDING"
  else
    useradd -m -G wheel "$HERMES_USER"
    passwd -d "$HERMES_USER" >/dev/null
  fi
}

# The login screen: greetd asks who signs in instead of signing the session user in. The account is
# locked before greetd's config changes, and herald-os-login.service holds greetd back until both are
# done (greetd.service.d/herald-os-login.conf): until then greetd could still be the stock one, which
# signs the session user in without asking. A session user an earlier first boot left with an empty
# password is locked and loses its shell; once someone gives it a password, the shell it had comes
# back.
# Never undone at a later boot: a login screen that has no one left to sign in is rescue.target's
# (docs/LINUX.md), not a passwordless administrator's.
login_screen() {
  if id "$HERMES_USER" >/dev/null 2>&1; then
    local shell
    shell="$(getent passwd "$HERMES_USER" | cut -d: -f7)"
    if [[ -z "$(getent shadow "$HERMES_USER" | cut -d: -f2)" ]]; then
      [[ "$shell" == "$NOLOGIN" ]] || echo "$shell" >"$SAVED_SHELL"
      usermod -L -s "$NOLOGIN" "$HERMES_USER"
      echo "$HERMES_USER had no password: locked until someone gives it one (sudo passwd $HERMES_USER)"
    elif has_password && [[ "$shell" == "$NOLOGIN" ]]; then
      shell="$(cat "$SAVED_SHELL" 2>/dev/null || true)"
      usermod -s "${shell:-/bin/bash}" "$HERMES_USER"
      rm -f "$SAVED_SHELL"
      echo "$HERMES_USER has a password now, and its shell back (${shell:-/bin/bash})"
    fi
  fi
  if ! cmp -s "$SHARE/session/greetd-login.toml" "$GREETD"; then
    # Through a new file and a rename, so greetd's config is never missing or half written.
    install -m 0644 "$SHARE/session/greetd-login.toml" "$GREETD.herald-os-new"
    mv -f "$GREETD.herald-os-new" "$GREETD"
    echo "greetd shows a login screen: sign in to your own account, or to $HERMES_USER once it has a password"
  fi
  [[ -f "$LOGIN_SCREEN" ]] || date -Is >"$LOGIN_SCREEN"
}

# A switched system's session user is in wheel only while it has a password: one an earlier first
# boot put there without a password leaves it, and one waiting for a password joins once it has
# one. A session user taken out of wheel by someone else is left out.
hermes_admin() {
  id "$HERMES_USER" >/dev/null 2>&1 || return 0
  if has_password; then
    if [[ -f "$ADMIN_PENDING" ]]; then
      usermod -aG wheel "$HERMES_USER"
      rm -f "$ADMIN_PENDING"
      echo "$HERMES_USER has a password now, and joins wheel"
    fi
  elif getent group wheel | cut -d: -f4 | tr ',' '\n' | grep -qx "$HERMES_USER"; then
    gpasswd -d "$HERMES_USER" wheel >/dev/null
    date -Is >"$ADMIN_PENDING"
    echo "$HERMES_USER had no password: out of wheel until it has one"
  fi
}

# The user manager (pipewire, portals, the update timer) runs for a session user with a password,
# whatever its shell, and not for one locked behind the login screen.
hermes_linger() {
  id "$HERMES_USER" >/dev/null 2>&1 || return 0
  if has_password; then
    loginctl enable-linger "$HERMES_USER" || true
  elif [[ -f "$LOGIN_SCREEN" ]]; then
    loginctl disable-linger "$HERMES_USER" || true
  fi
}

# herald-os-login.service, every boot, on a switched system: the login screen once it is due (and
# kept once it is there), wheel only with a password, and the user manager to match.
login_phase() {
  switched || return 0
  if login_screen_due || [[ -f "$LOGIN_SCREEN" ]]; then
    login_screen
  fi
  hermes_admin
  hermes_linger
}

# greetd on the first boot: from the image it signs the session user in; with a login screen due
# (a switched system), it shows that.
greeter() {
  if login_screen_due; then
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
  # The user's systemd instance (pipewire, portals) keeps running when no one is logged in. The home
  # folder's setup below needs it; a session user locked behind the login screen loses it at the end.
  loginctl enable-linger "$HERMES_USER" || true

  step "The login screen"
  greeter
  # Anaconda picks multi-user.target unless its kickstart says otherwise, because greetd provides
  # no service(graphical-login); only graphical.target starts greetd and so the session.
  if [[ "$(systemctl get-default)" != "graphical.target" ]]; then
    systemctl set-default graphical.target
    systemctl --no-block start graphical.target
  fi

  step "Graphics"
  # An NVIDIA GPU on the default image: how to switch to the NVIDIA image, for the journal. The
  # session says it once to the person (herald-os-session).
  if command -v herald-os-gpu-check >/dev/null; then
    herald-os-gpu-check || true
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
  if switched; then
    hermes_admin
    hermes_linger
  fi
  date -Is >"$FIRSTBOOT_DONE"
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
  login) login_phase ;;
  all) system_phase; apps_phase ;;
  *) echo "usage: $0 [system|hermes|apps|login]" >&2; exit 2 ;;
esac
echo "==> first boot ($PHASE) done"
