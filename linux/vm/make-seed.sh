#!/usr/bin/env bash
# Build the cloud-init NoCloud seed (cidata.iso) that turns a stock Fedora Cloud image into a
# Herald OS Linux machine on first boot: creates the `hermes` user, installs an SSH key, embeds
# the `linux/` payload (provisioner, session files, dev scripts) and runs the provisioner.
#
#   bash linux/vm/make-seed.sh            # writes linux/vm/build/cidata.iso
#
# Runs on macOS (uses hdiutil). Re-run whenever linux/ changes and you want a fresh VM.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINUX_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$LINUX_DIR/.." && pwd)"
BUILD="$HERE/build"
SEED="$BUILD/seed"
KEY="$BUILD/id_hermes"

mkdir -p "$SEED"
rm -f "$SEED/user-data" "$SEED/meta-data"

# SSH key used by linux/dev/push.sh and the verification scripts.
if [[ ! -f "$KEY" ]]; then
  echo "==> Generating SSH key $KEY"
  ssh-keygen -q -t ed25519 -N '' -C 'herald-os-dev' -f "$KEY"
fi
PUBKEY="$(cat "$KEY.pub")"

# Upstream Hermes Agent revision the provisioner checks out (kept in lockstep with the Mac build).
HERMES_REF="$(sed -n 's/^sha=//p' "$ROOT/upstream/UPSTREAM.lock" | tr -d '[:space:]')"
[[ -n "$HERMES_REF" ]] || { echo "upstream/UPSTREAM.lock has no sha=" >&2; exit 1; }

# The whole linux/ directory travels inside user-data so the first boot does not depend on a
# shared folder or network access to this repo.
PAYLOAD_B64="$(cd "$LINUX_DIR" && COPYFILE_DISABLE=1 tar czf - --exclude './vm/build' . | base64 | tr -d '\n')"

cat >"$SEED/meta-data" <<EOF
instance-id: herald-os-$(date +%Y%m%d%H%M%S)
local-hostname: herald-os
EOF

cat >"$SEED/user-data" <<EOF
#cloud-config
hostname: herald-os
preserve_hostname: false
timezone: $(readlink /etc/localtime | sed 's|.*/zoneinfo/||' || echo UTC)

groups:
  - seat
  - render

users:
  - name: hermes
    gecos: Hermes
    shell: /bin/bash
    groups: [wheel, video, input, render, audio, seat]
    sudo: ALL=(ALL) NOPASSWD:ALL
    lock_passwd: true
    ssh_authorized_keys:
      - ${PUBKEY}

ssh_pwauth: false
disable_root: true

# UTM (Apple Virtualization backend) exposes a VirtioFS share by tag; harmless when absent.
mounts:
  - ["herald-os", "/mnt/herald-os", "virtiofs", "defaults,nofail,x-systemd.device-timeout=5", "0", "0"]

write_files:
  - path: /etc/herald-os/ref
    permissions: '0644'
    content: |
      HERMES_REF=${HERMES_REF}
  - path: /usr/local/share/herald-os-linux.tar.gz
    permissions: '0644'
    encoding: b64
    content: ${PAYLOAD_B64}

runcmd:
  - [mkdir, -p, /usr/local/share/herald-os-linux]
  - [tar, -xzf, /usr/local/share/herald-os-linux.tar.gz, -C, /usr/local/share/herald-os-linux]
  - [chmod, -R, a+rX, /usr/local/share/herald-os-linux]
  - [bash, /usr/local/share/herald-os-linux/provision.sh, --dev-vm]

final_message: "cloud-init finished after \$UPTIME seconds; the Herald OS provisioning log is /var/log/herald-os-provision.log"
EOF

rm -f "$BUILD/cidata.iso"
echo "==> Building $BUILD/cidata.iso"
hdiutil makehybrid -quiet -o "$BUILD/cidata.iso" "$SEED" -iso -joliet -default-volume-name cidata
echo "==> Seed ready. Hermes ref $HERMES_REF, key $KEY"
