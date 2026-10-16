#!/usr/bin/env bash
# Migration: Hermes OS became Herald OS. Runs as the session user (root steps through sudo -n) after
# linux/dev/build.sh has installed the new session files, commands and units. Moves per-user state,
# points greetd and Plymouth at the new names and retires the old files. Safe to re-run.
# Runs as: user, with sudo
set -uo pipefail

REPO="${REPO:-$HOME/Herald-OS}"

move() {
  if [[ -e "$1" && ! -e "$2" ]]; then
    mv "$1" "$2" && echo "    moved $1 -> $2"
  fi
}

# Per-user configuration and state.
move "$HOME/.config/hermes-os" "$HOME/.config/herald-os"
move "$HOME/.local/state/hermes-os" "$HOME/.local/state/herald-os"
if [[ -f "$HOME/.config/herald-os/session.env" ]]; then
  sed -i 's/HERMES_OS_/HERALD_OS_/g' "$HOME/.config/herald-os/session.env"
fi
if [[ -f "$HOME/.config/herald-os/theme" ]]; then
  sed -i 's/^hermes-/herald-/' "$HOME/.config/herald-os/theme"
fi
if command -v herald-os-theme >/dev/null; then
  herald-os-theme set "$(herald-os-theme current)" >/dev/null 2>&1 || echo "    WARNING: could not re-apply the theme"
fi

# The pre-rename copy of the repo (linux/dev/push.sh now syncs to ~/Herald-OS). Synced copies have no
# .git, so a folder with one is somebody's own checkout and stays.
if [[ -d "$HOME/Hermes-OS" && -d "$REPO/apps" && "$HOME/Hermes-OS" != "$REPO" ]]; then
  if [[ -e "$HOME/Hermes-OS/.git" ]]; then
    echo "    left ~/Hermes-OS in place: it is a git checkout of the pre-rename repo"
  else
    rm -rf "$HOME/Hermes-OS" && echo "    removed ~/Hermes-OS"
  fi
fi
# The shell moved from apps/os to apps/desktop; push.sh's --delete keeps the excluded build output.
# In a git checkout, git has already removed the tracked files and what is left may be the user's.
if [[ -d "$REPO/apps/os" && -f "$REPO/apps/desktop/package.json" ]]; then
  if [[ -e "$REPO/.git" ]]; then
    echo "    $REPO/apps/os now holds only untracked files (old build output); delete it to free space"
  else
    rm -rf "$REPO/apps/os" && echo "    removed $REPO/apps/os"
  fi
fi

# User units and developer helpers.
systemctl --user disable --now hermes-os-update-check.timer >/dev/null 2>&1 || true
rm -f "$HOME/.config/systemd/user/hermes-os-update-check.service" "$HOME/.config/systemd/user/hermes-os-update-check.timer"
systemctl --user daemon-reload >/dev/null 2>&1 || true
systemctl --user enable herald-os-update-check.timer >/dev/null 2>&1 || true
rm -f "$HOME"/.local/bin/hermes-os-{build,sync,restart-shell,shot}

# System files (provision.sh and build.sh install the herald-os equivalents).
if [[ -f /etc/greetd/config.toml ]] && grep -q 'hermes-os-' /etc/greetd/config.toml; then
  sudo -n sed -i 's/hermes-os-/herald-os-/g' /etc/greetd/config.toml && echo "    greetd now starts herald-os-compositor"
fi
if [[ -d /etc/hermes-os && ! -e /etc/herald-os ]]; then
  sudo -n mv /etc/hermes-os /etc/herald-os
fi
if [[ -d /var/lib/hermes-os ]]; then
  sudo -n mkdir -p /var/lib/herald-os/migrations
  sudo -n cp -an /var/lib/hermes-os/. /var/lib/herald-os/ && sudo -n rm -rf /var/lib/hermes-os
fi
sudo -n rm -f /usr/local/bin/hermes-os /usr/local/bin/hermes-os-{theme,omakase,update,compositor,session,niri-nested}
sudo -n rm -f /usr/share/wayland-sessions/hermes-os.desktop
sudo -n rm -rf /usr/local/share/hermes-os-linux
if command -v plymouth-set-default-theme >/dev/null && [[ -d /usr/share/plymouth/themes/herald-os ]]; then
  if [[ "$(plymouth-set-default-theme 2>/dev/null)" == "hermes-os" ]]; then
    # Every kernel's initramfs, not only the running one's (what -R rebuilds): whichever kernel boots
    # next has to carry the new splash (takes a minute).
    { sudo -n plymouth-set-default-theme herald-os && sudo -n dracut -f --regenerate-all; } >/dev/null 2>&1 || echo "    WARNING: could not switch the Plymouth theme"
  fi
  sudo -n rm -rf /usr/share/plymouth/themes/hermes-os
fi
exit 0
