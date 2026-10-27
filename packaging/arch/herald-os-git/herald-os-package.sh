# Shared by herald-os-bin and herald-os-git (keep the two copies identical; CI compares them).
# Lays out an unpacked Herald OS build (the release tarball, or electron-builder's linux-unpacked):
#   /opt/herald-os                    the app (its resources carry the CLIs, session, data, bridge)
#   /usr/bin/herald-os*               the CLIs and session scripts, linked from the app
#   /usr/share/herald-os/*            themes, catalog, niri template, omakase lists, migrations, bridge
#   /usr/share/wayland-sessions/      the full Herald OS session for the login screen
#   /usr/share/xdg-desktop-portal/    which portal backends answer in that session (HeraldOS)
#   /usr/share/applications/          Herald OS as an app inside Hyprland, Omarchy or any desktop

# The folder that holds resources/app.asar, wherever the archive put it.
_herald_os_appdir() {
  local asar
  asar="$(find "$1" -path '*/resources/app.asar' -print -quit)"
  [[ -n "$asar" ]] || { echo "no Herald OS build under $1" >&2; return 1; }
  dirname "$(dirname "$asar")"
}

_herald_os_package() {
  local app="$1" res=/opt/herald-os/resources tool script dir

  install -d "$pkgdir/opt/herald-os"
  cp -a "$app/." "$pkgdir/opt/herald-os/"
  # Chromium's sandbox helper must be setuid root where unprivileged user namespaces are off.
  chmod 4755 "$pkgdir/opt/herald-os/chrome-sandbox"

  install -d "$pkgdir/usr/bin"
  for tool in "$pkgdir$res"/herald-os-linux/bin/*; do
    ln -s "$res/herald-os-linux/bin/${tool##*/}" "$pkgdir/usr/bin/${tool##*/}"
  done
  for script in herald-os-session herald-os-compositor herald-os-niri-nested; do
    ln -s "$res/herald-os-linux/session/$script" "$pkgdir/usr/bin/$script"
  done

  install -d "$pkgdir/usr/share/herald-os"
  ln -s "$res/themes" "$pkgdir/usr/share/herald-os/themes"
  ln -s "$res/catalog" "$pkgdir/usr/share/herald-os/catalog"
  ln -s "$res/herald-os-bridge" "$pkgdir/usr/share/herald-os/bridge"
  for dir in niri omakase migrations plymouth; do
    ln -s "$res/herald-os-linux/$dir" "$pkgdir/usr/share/herald-os/$dir"
  done

  install -Dm644 "$pkgdir$res/herald-os-linux/session/herald-os.desktop" "$pkgdir/usr/share/wayland-sessions/herald-os.desktop"
  # Read only where XDG_CURRENT_DESKTOP is HeraldOS (the session above); Hyprland and Omarchy keep theirs.
  install -Dm644 "$pkgdir$res/herald-os-linux/session/heraldos-portals.conf" "$pkgdir/usr/share/xdg-desktop-portal/heraldos-portals.conf"
  install -Dm644 -t "$pkgdir/usr/lib/systemd/user" "$pkgdir$res/herald-os-linux/session/herald-os-update-check.service" "$pkgdir$res/herald-os-linux/session/herald-os-update-check.timer"
  install -Dm644 "$pkgdir$res/icons/herald-os.png" "$pkgdir/usr/share/icons/hicolor/512x512/apps/herald-os.png"
  install -Dm644 /dev/stdin "$pkgdir/usr/share/applications/herald-os.desktop" <<'DESKTOP'
[Desktop Entry]
Name=Herald OS
Comment=The AI-native desktop built around Hermes Agent
Exec=herald-os-app
Icon=herald-os
Type=Application
Categories=System;Utility;
StartupWMClass=herald-os
Terminal=false
DESKTOP
  install -Dm644 "$pkgdir$res/LICENSE" "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
  install -Dm644 "$pkgdir$res/NOTICE" "$pkgdir/usr/share/licenses/$pkgname/NOTICE"
}
