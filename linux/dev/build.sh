#!/usr/bin/env bash
# Build the Herald OS shell inside the Linux VM (run as the session user).
# Fetches the upstream snapshot, installs Node workspaces, links + enables the bridge plugin
# (scripts/bootstrap.sh), compiles the shell, and fixes Electron's sandbox helper permissions.
#
#   herald-os-build            # after linux/dev/push.sh or herald-os-sync
set -euo pipefail

REPO="${HERALD_OS_REPO:-$HOME/Herald-OS}"
export PATH="$HOME/.local/bin:$PATH"

[[ -d "$REPO/apps/desktop" ]] || { echo "repo not found at $REPO (push it from the Mac: linux/dev/push.sh)" >&2; exit 1; }
cd "$REPO"

# One build at a time: the first-boot provisioner and push.sh can each start one, and two npm
# installs in the same tree corrupt it.
exec 9>"/tmp/herald-os-build-$(id -u).lock"
flock 9

echo "==> bootstrap (upstream snapshot, npm install, bridge plugin)"
bash scripts/bootstrap.sh

# node-pty ships no Linux prebuilds; compile it once against the Electron ABI's Node.
if [[ ! -f node_modules/node-pty/build/Release/pty.node && ! -d "node_modules/node-pty/prebuilds/linux-$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')" ]]; then
  echo "==> compiling node-pty"
  (cd node_modules/node-pty && npx --yes node-gyp rebuild >/dev/null)
fi

echo "==> building shell"
npm run build --workspace apps/desktop

# Desktop control, from the vendored crates (no network), where the bridge's desktop tool looks for it.
if [[ -f third_party/agent-desktop/Cargo.lock ]] && command -v cargo >/dev/null && command -v sudo >/dev/null; then
  echo "==> building desktop control"
  (cd third_party/agent-desktop && cargo build --release --frozen --offline)
  sudo install -d -m 0755 /usr/local/libexec/herald-os
  sudo install -m 0755 third_party/agent-desktop/target/release/agent-desktop \
    third_party/agent-desktop/target/release/agent-desktop-linux-clipboard-owner /usr/local/libexec/herald-os/
fi

# Electron downloads its binary on first use, not at npm install: fetch it now so the first login
# does not wait on a download and the sandbox helper below exists.
(cd "$REPO/apps/desktop" && node -e "require('electron')")
# Chromium's setuid sandbox helper must be root-owned 4755 when unprivileged user namespaces
# are unavailable; harmless otherwise.
SANDBOX="$(dirname "$(cd "$REPO/apps/desktop" && node -p "require('electron')")")/chrome-sandbox"
if [[ -f "$SANDBOX" && "$(stat -c '%u %a' "$SANDBOX")" != "0 4755" ]]; then
  sudo chown root:root "$SANDBOX" && sudo chmod 4755 "$SANDBOX" || true
fi

# Keep the installed session files in step with the repo (they are what greetd/cage run).
if [[ -d "$REPO/linux/session" ]] && command -v sudo >/dev/null; then
  sudo install -m 0755 "$REPO/linux/session/herald-os-compositor" /usr/local/bin/herald-os-compositor
  sudo install -m 0755 "$REPO/linux/session/herald-os-session" /usr/local/bin/herald-os-session
  sudo install -m 0755 "$REPO/linux/session/herald-os-niri-nested" /usr/local/bin/herald-os-niri-nested
  sudo install -m 0644 "$REPO/linux/session/herald-os.desktop" /usr/share/wayland-sessions/herald-os.desktop
  sudo install -m 0755 "$REPO"/linux/bin/herald-os* /usr/local/bin/
  mkdir -p "$HOME/.config/systemd/user"
  install -m 0644 "$REPO/linux/session/herald-os-update-check.service" "$REPO/linux/session/herald-os-update-check.timer" "$HOME/.config/systemd/user/"
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable herald-os-update-check.timer 2>/dev/null || true
  mkdir -p "$HOME/.config/niri" "$HOME/.config/swaylock"
  # niri reloads its config as soon as it changes, so every file it includes must already exist.
  [[ -f "$HOME/.config/niri/outputs.kdl" ]] || echo "// Written by the Herald OS Display panel." >"$HOME/.config/niri/outputs.kdl"
  sudo install -D -m 0644 "$REPO/linux/niri/config.kdl" /usr/local/share/herald-os-linux/niri/config.kdl
  # herald-os.kdl is rendered from the template with the chosen keymap (herald-os keymap herald|omarchy).
  herald-os keymap apply || install -m 0644 "$REPO/linux/niri/config.kdl" "$HOME/.config/niri/herald-os.kdl"
  install -m 0644 "$REPO/linux/session/swaylock.conf" "$HOME/.config/swaylock/config"
  if [[ -d /usr/share/plymouth/themes ]]; then
    sudo install -d /usr/share/plymouth/themes/herald-os
    # The splash boots from the initramfs, so a changed theme needs every kernel's rebuilt (a minute).
    if ! diff -rq "$REPO/linux/plymouth/herald-os" /usr/share/plymouth/themes/herald-os >/dev/null 2>&1; then
      sudo install -m 0644 "$REPO"/linux/plymouth/herald-os/* /usr/share/plymouth/themes/herald-os/
      if [[ "$(plymouth-set-default-theme 2>/dev/null)" == "herald-os" ]]; then
        echo "==> boot splash changed: rebuilding the initramfs"
        sudo dracut -f --regenerate-all >/dev/null 2>&1 || echo "WARNING: could not rebuild the initramfs"
      fi
    fi
  fi
  for f in build.sh sync.sh restart-shell.sh shot.sh; do
    install -m 0755 "$REPO/linux/dev/$f" "$HOME/.local/bin/herald-os-${f%.sh}"
  done
  sudo install -d /usr/local/share/herald-os-linux/themes /usr/local/share/herald-os-linux/omakase /usr/local/share/herald-os-linux/catalog
  sudo cp -R "$REPO"/linux/themes/. /usr/local/share/herald-os-linux/themes/
  sudo cp -R "$REPO"/linux/omakase/. /usr/local/share/herald-os-linux/omakase/
  sudo cp -R "$REPO"/linux/catalog/. /usr/local/share/herald-os-linux/catalog/

  echo "==> one-shot migrations"
  HERALD_OS_REPO="$REPO" bash "$REPO/linux/bin/herald-os-update" --migrate || echo "WARNING: a migration failed; see above"
fi

echo "==> build complete: $REPO/apps/desktop/dist"
