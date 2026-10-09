#!/usr/bin/env bash
# Herald OS Linux, the system half: packages, services, the session and the boot splash. No session
# user exists yet; everything that lives in a home folder is firstboot.sh's. Runs as root.
#
#   packages.sh --image <shell.tar.gz>   building the bootc image (linux/image/Containerfile): the
#                                        prebuilt shell goes to /usr/share/herald-os/app, the rest
#                                        under /usr, which is read-only once the image boots
#   packages.sh --dev                    the development VM (linux/provision.sh): build tools too;
#                                        the shell is built from the repo, files under /usr/local
set -euo pipefail

LINUX="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-}"
case "$MODE" in
  --image)
    TARBALL="${2:?--image needs the shell tarball (herald-os-<version>-linux-<arch>.tar.gz)}"
    BIN=/usr/bin
    SHARE=/usr/share/herald-os
    ;;
  --dev)
    BIN=/usr/local/bin
    SHARE=/usr/local/share/herald-os-linux
    ;;
  *) echo "usage: $0 --image <shell.tar.gz> | --dev" >&2; exit 2 ;;
esac

step() { echo; echo "--- $*"; }
list() { sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$@"; }

# ---------------------------------------------------------------------------------------------
step "SELinux permissive (ADR-012: greetd and cage have no tailored policy yet)"
if [[ -f /etc/selinux/config ]]; then
  sed -i 's/^SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config
fi
command -v setenforce >/dev/null && { setenforce 0 2>/dev/null || true; }

# ---------------------------------------------------------------------------------------------
step "Packages"
mapfile -t PACKAGES < <(list "$LINUX/image/packages.txt")
if [[ "$MODE" == "--dev" ]]; then
  mapfile -t -O "${#PACKAGES[@]}" PACKAGES < <(list "$LINUX/image/packages-dev.txt")
fi
dnf -y install --setopt=install_weak_deps=False "${PACKAGES[@]}"
# The curated apps every install gets (omakase); Flatpaks and web apps are per user (firstboot.sh).
if [[ "${HERALD_OS_OMAKASE:-1}" == "1" ]]; then
  mapfile -t OMAKASE < <(list "$LINUX/omakase/packages.txt")
  dnf -y install --skip-unavailable --setopt=install_weak_deps=False "${OMAKASE[@]}" || echo "WARNING: some omakase packages did not install"
fi

# ---------------------------------------------------------------------------------------------
step "The Herald OS session and CLIs ($BIN)"
install -d "$BIN"
install -m 0755 "$LINUX"/session/herald-os-compositor "$LINUX"/session/herald-os-session "$LINUX"/session/herald-os-niri-nested "$BIN/"
install -m 0755 "$LINUX"/bin/herald-os* "$BIN/"
# Themes, the catalog, the niri template, omakase lists and migrations, for machines without a checkout.
# The dev VM's cloud-init payload is unpacked at $SHARE itself, and cp refuses to copy onto itself.
install -d "$SHARE"
if [[ "$(realpath "$LINUX")" != "$(realpath "$SHARE")" ]]; then
  for dir in themes omakase catalog niri migrations plymouth session; do
    install -d "$SHARE/$dir"
    cp -R "$LINUX/$dir/." "$SHARE/$dir/"
  done
fi
install -d /usr/share/wayland-sessions
install -m 0644 "$LINUX/session/herald-os.desktop" /usr/share/wayland-sessions/herald-os.desktop
install -d /usr/lib/systemd/user
install -m 0644 "$LINUX/session/herald-os-update-check.service" "$LINUX/session/herald-os-update-check.timer" /usr/lib/systemd/user/
install -d /etc/greetd
# firstboot.sh fills in the session user.
install -m 0644 "$LINUX/session/greetd-config.toml" /etc/greetd/config.toml
# foot's client and server entries are for scripts; Applications keeps Foot next to Herald's Terminal.
# (Not on the image: /usr/local lives in /var there, which a bootc image leaves empty.)
if [[ "$MODE" == "--dev" ]]; then
  install -d /usr/local/share/applications
  for entry in footclient foot-server; do
    if [[ -f "/usr/share/applications/$entry.desktop" ]]; then
      printf '[Desktop Entry]\nType=Application\nName=%s\nHidden=true\n' "$entry" >"/usr/local/share/applications/$entry.desktop"
    fi
  done
fi

if [[ "$MODE" == "--image" ]]; then
  # herald-os tells its own image from other bootc systems (Silverblue, Bazzite, Bluefin) by this
  # line; on those it never runs bootc, since their updates and rollbacks are the person's.
  sed -i --follow-symlinks '/^IMAGE_ID=/d' /usr/lib/os-release
  echo 'IMAGE_ID=herald-os' >>/usr/lib/os-release

  step "The shell ($TARBALL)"
  install -d "$SHARE/app"
  tar -xzf "$TARBALL" -C "$SHARE/app" --strip-components=1
  [[ -f "$SHARE/app/resources/app.asar" ]] || { echo "the tarball has no resources/app.asar" >&2; exit 1; }
  # Chromium's sandbox helper must be setuid root where unprivileged user namespaces are off.
  chown root:root "$SHARE/app/chrome-sandbox"
  chmod 4755 "$SHARE/app/chrome-sandbox"
  ln -sfn "$SHARE/app/resources/herald-os-bridge" "$SHARE/bridge"
  install -Dm0644 "$SHARE/app/resources/icons/herald-os.png" /usr/share/icons/hicolor/512x512/apps/herald-os.png
  install -Dm0644 "$LINUX/image/herald-os-firstboot.service" /usr/lib/systemd/system/herald-os-firstboot.service
  install -Dm0644 "$LINUX/image/herald-os-firstboot-apps.service" /usr/lib/systemd/system/herald-os-firstboot-apps.service
  install -Dm0644 "$LINUX/image/herald-os-hermes.service" /usr/lib/systemd/system/herald-os-hermes.service
  install -Dm0755 "$LINUX/image/firstboot.sh" /usr/libexec/herald-os/firstboot.sh
  install -Dm0755 "$LINUX/image/reset-helper" /usr/libexec/herald-os/reset-helper
  install -Dm0644 "$LINUX/image/herald-os-reset.service" /usr/lib/systemd/system/herald-os-reset.service
  install -Dm0644 "$LINUX/image/kargs.toml" /usr/lib/bootc/kargs.d/10-herald-os.toml
  # Updates are signed with the project's cosign key (not keyless: that would write to a public
  # log); with its public half in the repo, the image only accepts signed updates of itself.
  if [[ -f "$LINUX/image/cosign.pub" ]]; then
    install -Dm0644 "$LINUX/image/cosign.pub" /etc/pki/containers/herald-os.pub
    install -d /etc/containers/registries.d
    printf 'docker:\n  ghcr.io/iamlukethedev/herald-os:\n    use-sigstore-attachments: true\n' >/etc/containers/registries.d/herald-os.yaml
    python3 - <<'PY'
import json
path = "/etc/containers/policy.json"
policy = json.load(open(path))
policy.setdefault("transports", {}).setdefault("docker", {})["ghcr.io/iamlukethedev/herald-os"] = [
    {"type": "sigstoreSigned", "keyPath": "/etc/pki/containers/herald-os.pub", "signedIdentity": {"type": "matchRepository"}}
]
json.dump(policy, open(path, "w"), indent=2)
PY
  fi
fi

# ---------------------------------------------------------------------------------------------
step "Boot splash (Plymouth)"
install -d /usr/share/plymouth/themes/herald-os
install -m 0644 "$LINUX"/plymouth/herald-os/* /usr/share/plymouth/themes/herald-os/
if [[ "$(plymouth-set-default-theme 2>/dev/null)" != "herald-os" ]]; then
  plymouth-set-default-theme herald-os || echo "WARNING: could not set the Plymouth theme"
  if [[ "$MODE" == "--dev" ]]; then
    # Every kernel's initramfs, not only the running one's: the package step usually installs a
    # newer kernel, and that is the one the next boot starts. (The image builds its own below.)
    dracut -f --regenerate-all || echo "WARNING: could not rebuild the initramfs"
    # Show the splash instead of the console. With a serial console on the kernel command line
    # (the VM's), Plymouth falls back to scrolling text unless told to ignore it.
    if command -v grubby >/dev/null; then
      grubby --update-kernel=ALL --args="rhgb quiet plymouth.ignore-serial-consoles" || true
    fi
  fi
fi
if [[ "$MODE" == "--image" ]]; then
  # A bootc image carries its initramfs inside /usr/lib/modules; the kernel arguments are kargs.toml.
  kver="$(basename "$(find /usr/lib/modules -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)")"
  dracut -f --no-hostonly "/usr/lib/modules/$kver/initramfs.img" "$kver"
fi

# ---------------------------------------------------------------------------------------------
step "Services"
if [[ "$MODE" == "--image" ]]; then
  # Flathub as a configured remote (/etc), not a populated repo in /var, which the image leaves empty.
  install -d /etc/flatpak/remotes.d
  curl -fsSL --retry 3 -o /etc/flatpak/remotes.d/flathub.flatpakrepo https://dl.flathub.org/repo/flathub.flatpakrepo
else
  flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo || true
fi
systemctl enable NetworkManager bluetooth greetd || true
systemctl enable plocate-updatedb.timer || true
systemctl set-default graphical.target
# The firewall: nothing comes in except LocalSend and mDNS (and SSH on the development VM).
install -Dm0644 "$LINUX/image/firewall-zone.xml" /etc/firewalld/zones/herald-os.xml
if [[ "$MODE" == "--dev" ]]; then
  sed -i 's|<service name="mdns"/>|<service name="mdns"/>\n  <service name="ssh"/>|' /etc/firewalld/zones/herald-os.xml
fi
# Offline: works while building the image (no daemon) and wherever firewalld keeps its defaults.
firewall-offline-cmd --set-default-zone=herald-os
systemctl enable firewalld || true
if [[ "$MODE" == "--dev" ]]; then
  systemctl restart firewalld || true
fi

if [[ "$MODE" == "--image" ]]; then
  systemctl enable herald-os-firstboot.service herald-os-firstboot-apps.service herald-os-hermes.service herald-os-reset.service
  # Release images ship without SSH; the dev VM keeps it for linux/dev/.
  systemctl disable sshd.service 2>/dev/null || true
else
  systemctl enable --now seatd NetworkManager bluetooth || true
  systemctl enable sshd || true
  # The VM's first-boot seed disc stays attached for cloud-init; keep it out of Files and the desktop.
  echo 'SUBSYSTEM=="block", ENV{ID_FS_LABEL}=="cidata", ENV{UDISKS_IGNORE}="1"' >/etc/udev/rules.d/90-herald-os-hide-seed.rules
  udevadm control --reload || true
  udevadm trigger --subsystem-match=block || true
fi

echo "==> system half done ($MODE)"
