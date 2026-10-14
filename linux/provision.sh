#!/usr/bin/env bash
# Turn a stock Fedora Cloud install into the Herald OS Linux development VM. Runs as root, idempotent.
# Invoked by cloud-init on first boot (see linux/vm/make-seed.sh); safe to re-run by hand inside
# the development VM:
#
#   sudo bash /usr/local/share/herald-os-linux/provision.sh            # the seed disc still attached
#   sudo bash /usr/local/share/herald-os-linux/provision.sh --dev-vm   # the seed disc removed
#
# It refuses to run anywhere else: it carries on only in a virtual machine with the cloud-init seed
# attached (the disc labelled cidata, in any case), or when given --dev-vm (cloud-init's runcmd
# passes it).
#
# The same two halves build the bootc image (linux/image/Containerfile):
#   1. image/packages.sh --dev   packages, the session and CLIs, the boot splash, services
#   2. image/firstboot.sh        the session user's home folder, Hermes Agent, the omakase apps
# and then, for development only: the helper scripts and building the shell from the repo.
set -euo pipefail

DEV_VM=0
for arg in "$@"; do
  case "$arg" in
    --dev-vm) DEV_VM=1 ;;
    *) echo "provision.sh: unknown argument '$arg' (the only one is --dev-vm)" >&2; exit 2 ;;
  esac
done

# The NoCloud seed's label is matched in any case: make-seed.sh writes cidata, other tools CIDATA.
seed_attached() {
  local label
  while IFS= read -r label; do
    case "$label" in [Cc][Ii][Dd][Aa][Tt][Aa]) return 0 ;; esac
  done < <(blkid -s LABEL -o value 2>/dev/null)
  return 1
}

# Everything below changes the whole system and is meant for a throwaway VM, so this check comes
# before anything is written, the log included.
if [[ $DEV_VM -eq 0 ]] && ! { systemd-detect-virt --quiet --vm >/dev/null 2>&1 && seed_attached; }; then
  cat >&2 <<EOF
provision.sh turns a fresh Fedora Cloud VM into the Herald OS development VM, and this machine
does not look like one: it is not a virtual machine with the cloud-init seed (the disc labelled
cidata or CIDATA) attached. On this machine it would:

  - set SELinux to permissive, now and after every reboot
  - install greetd and log ${HERMES_USER:-hermes} in automatically on VT 1, with no password prompt
  - make Herald's firewall zone the default (SSH allowed) and restart firewalld
  - enable sshd and seatd, and make graphical.target the default
  - rebuild every initramfs and change the kernel arguments of every installed kernel
  - install development packages, Flathub and the default apps, and set up Hermes Agent in the
    session user's home

Nothing has been changed. If this is the development VM, run it again with --dev-vm:

  sudo bash "${BASH_SOURCE[0]}" --dev-vm
EOF
  exit 1
fi

PAYLOAD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export HERMES_USER="${HERMES_USER:-hermes}"
HERMES_UID_HOME="$(getent passwd "$HERMES_USER" | cut -d: -f6)"
STATE_DIR=/var/lib/herald-os
LOG=/var/log/herald-os-provision.log

mkdir -p "$STATE_DIR"
exec > >(tee -a "$LOG") 2>&1
# cloud-init prints its own final message either way, so a failure has to say so here.
trap 'echo "==> Provisioning FAILED at line $LINENO. Full log: $LOG"' ERR
echo "==> Herald OS Linux provisioner $(date -Is) (payload $PAYLOAD)"

step() { echo; echo "--- $*"; }

bash "$PAYLOAD/image/packages.sh" --dev
bash "$PAYLOAD/image/firstboot.sh" system
# The development account is set up already (cloud-init made it); the shell's first-boot setup is
# for the image's owners.
sudo -u "$HERMES_USER" -H bash -c 'mkdir -p ~/.config/herald-os && date -Is > ~/.config/herald-os/setup-done'

# ---------------------------------------------------------------------------------------------
step "Developer helpers for $HERMES_USER"
# `install -d` would create ~/.local as root; keep every directory under the home owned by the
# session user or uv/npm fail later.
chown -R "$HERMES_USER:$HERMES_USER" "$HERMES_UID_HOME/.local" "$HERMES_UID_HOME/.config"
for f in build.sh sync.sh restart-shell.sh shot.sh; do
  install -m 0755 -o "$HERMES_USER" -g "$HERMES_USER" "$PAYLOAD/dev/$f" "$HERMES_UID_HOME/.local/bin/herald-os-${f%.sh}"
done

# ---------------------------------------------------------------------------------------------
step "Herald OS shell"
REPO="$HERMES_UID_HOME/Herald-OS"
if mountpoint -q /mnt/herald-os 2>/dev/null; then
  echo "shared folder mounted at /mnt/herald-os; syncing and building"
  sudo -u "$HERMES_USER" -H bash "$PAYLOAD/dev/sync.sh" || echo "WARNING: shell build failed; see above"
elif [[ -d "$REPO/apps/desktop" ]]; then
  echo "repo present at $REPO; building"
  sudo -u "$HERMES_USER" -H bash "$PAYLOAD/dev/build.sh" || echo "WARNING: shell build failed; see above"
else
  echo "repo not present yet. From the Mac run: bash linux/dev/push.sh"
fi

bash "$PAYLOAD/image/firstboot.sh" apps

date -Is >"$STATE_DIR/provisioned"
echo "==> Provisioning complete. greetd will start Herald OS on the next boot (or: systemctl start greetd)."
