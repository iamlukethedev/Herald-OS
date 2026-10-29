#!/usr/bin/env bash
# Check that an installer ISO can start the LVM D-Bus service Anaconda's storage needs (lvmdbusd,
# the name com.redhat.lvmdbus1). Without it the installer stops at its first screen with "Could not
# activate remote peer 'com.redhat.lvmdbus1'" (#180), and nothing earlier in a build notices.
#
# It reads the installer's root (images/install.img) for each step of D-Bus activation: the
# activation file for the name, the systemd unit that file names (there, not masked, owning the
# same name), the program the unit starts and its interpreter, the D-Bus policy that lets it own
# the name, the lvm command and profile lvmdbusd runs, the Python modules it imports, and the
# libblockdev plugin that calls it. Then, unless --static, it starts the unit's command inside that
# root on a private bus, waits for the name, and has it read the disks once (Manager.Refresh).
# That part needs root (chroot and mounts) and a host that runs the ISO's architecture.
#
#   sudo bash linux/image/check-installer.sh output/bootiso/install.iso
#   bash linux/image/check-installer.sh --static <unpacked installer root>
#
# Unpacking an ISO needs xorriso or 7z, and unsquashfs.
set -euo pipefail

NAME=com.redhat.lvmdbus1
UNIT=lvm2-lvmdbusd.service
START_WAIT="${START_WAIT:-30}"

usage() {
  echo "usage: $0 [--static] <installer.iso | installer root>" >&2
  exit 2
}

static=""
[[ "${1:-}" == --static ]] && { static=1; shift; }
[[ $# -eq 1 ]] || usage

failed=""
bad() {
  echo "check-installer: $*" >&2
  failed=1
}
ok() { echo "  ok: $*"; }

work=""
mounted=()
bus_pid=""
cleanup() {
  local at
  [[ -z "$bus_pid" ]] || kill "$bus_pid" 2>/dev/null || true
  at=${#mounted[@]}
  while (( at > 0 )); do
    at=$((at - 1))
    umount -l "${mounted[$at]}" 2>/dev/null || true
  done
  [[ -z "$work" ]] || rm -rf "$work"
}
trap cleanup EXIT

if [[ -d "$1" ]]; then
  root="$(cd "$1" && pwd)"
elif [[ -f "$1" ]]; then
  work="$(mktemp -d "${TMPDIR:-/tmp}/check-installer.XXXXXX")"
  if command -v xorriso >/dev/null 2>&1; then
    xorriso -osirrox on -indev "$1" -extract /images/install.img "$work/install.img" >/dev/null 2>&1 || true
  elif command -v 7z >/dev/null 2>&1; then
    7z e -o"$work" "$1" images/install.img >/dev/null || true
  else
    echo "check-installer: unpacking an ISO needs xorriso or 7z" >&2
    exit 2
  fi
  [[ -f "$work/install.img" ]] || { echo "check-installer: $1 has no images/install.img" >&2; exit 1; }
  command -v unsquashfs >/dev/null 2>&1 || { echo "check-installer: unpacking install.img needs unsquashfs" >&2; exit 2; }
  unsquashfs -no-progress -no-xattrs -d "$work/root" "$work/install.img" >/dev/null
  rm "$work/install.img"
  root="$work/root"
else
  usage
fi
[[ -d "$root/usr" ]] || { echo "check-installer: $root is not an installer root (no usr/)" >&2; exit 1; }
echo "Installer root: $root"

# The host path of an absolute path inside the root, following its symlinks inside the root rather
# than out to the host's own files.
inside() {
  local rest="${1#/}" walked="" part target hops=0
  while [[ -n "$rest" ]]; do
    part="${rest%%/*}"
    if [[ "$rest" == */* ]]; then rest="${rest#*/}"; else rest=""; fi
    case "$part" in
      "" | .) continue ;;
      ..) walked="${walked%/*}"; continue ;;
    esac
    if [[ -L "$root$walked/$part" ]]; then
      hops=$((hops + 1))
      (( hops <= 40 )) || return 1
      target="$(readlink "$root$walked/$part")"
      [[ "$target" != /* ]] || walked=""
      target="${target#/}"
      rest="$target${rest:+/$rest}"
    else
      walked="$walked/$part"
    fi
  done
  printf '%s\n' "$root$walked"
}

# The last value a key has in an INI-style file (a D-Bus service file or a systemd unit).
value() {
  sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//p" "$1" | tr -d '\r' | sed 's/[[:space:]]*$//' | tail -n 1
}

# The D-Bus activation file for the name.
activation=""
for file in "$root"/usr/share/dbus-1/system-services/*.service; do
  [[ -f "$file" ]] || continue
  [[ "$(value "$file" Name)" == "$NAME" ]] && activation="$file"
done
if [[ -z "$activation" ]]; then
  bad "no D-Bus activation file names $NAME in /usr/share/dbus-1/system-services"
else
  ok "D-Bus activation file ${activation#"$root"}"
  service="$(value "$activation" SystemdService)"
  [[ "$service" == "$UNIT" ]] || bad "${activation#"$root"} starts systemd unit '$service', not $UNIT"
  exec_word="$(value "$activation" Exec)"
  exec_word="${exec_word%% *}"
  if [[ -z "$exec_word" ]]; then
    bad "${activation#"$root"} has no Exec="
  elif [[ ! -x "$(inside "$exec_word")" ]]; then
    bad "${activation#"$root"} runs $exec_word, which the installer does not have"
  fi
fi

# The unit: the first of /etc, /run and /usr/lib wins, a link to /dev/null masks it, and drop-ins
# can change what it starts.
unit=""
for dir in /etc/systemd/system /run/systemd/system /usr/lib/systemd/system; do
  path="$(inside "$dir")/$UNIT"
  if [[ -L "$path" && "$(readlink "$path")" == /dev/null ]]; then
    bad "$UNIT is masked ($dir/$UNIT is a link to /dev/null)"
    unit=masked
    break
  fi
  if [[ -e "$path" ]]; then
    unit="$(inside "$dir/$UNIT")"
    break
  fi
done
exec_start=""
if [[ -z "$unit" ]]; then
  bad "the installer has no $UNIT"
elif [[ "$unit" != masked ]]; then
  ok "systemd unit ${unit#"$root"}"
  bus_name="$(value "$unit" BusName)"
  [[ "$bus_name" == "$NAME" ]] || bad "$UNIT owns '$bus_name', not $NAME, so its D-Bus activation never finishes"
  type="$(value "$unit" Type)"
  [[ "$type" == dbus ]] || bad "$UNIT is Type=$type, not Type=dbus"
  exec_start="$(value "$unit" ExecStart)"
  for dir in /usr/lib/systemd/system /run/systemd/system /etc/systemd/system; do
    for dropin in "$(inside "$dir")/$UNIT.d"/*.conf; do
      [[ -f "$dropin" ]] || continue
      if [[ -L "$dropin" && "$(readlink "$dropin")" == /dev/null ]]; then continue; fi
      grep -q '^[[:space:]]*ExecStart[[:space:]]*=' "$dropin" && exec_start="$(value "$dropin" ExecStart)"
    done
  done
fi

# The program the unit starts, and the interpreter it names.
if [[ -n "$exec_start" ]]; then
  program="${exec_start%% *}"
  while [[ "$program" == [-@:+!]* ]]; do program="${program#?}"; done
  if [[ ! -f "$(inside "$program")" || ! -x "$(inside "$program")" ]]; then
    bad "$UNIT starts $program, which the installer does not have (or cannot run)"
  else
    ok "ExecStart $exec_start"
    first="$(head -n 1 "$(inside "$program")" | tr -d '\r')"
    if [[ "$first" == '#!'* ]]; then
      interpreter="${first#\#!}"
      interpreter="${interpreter#"${interpreter%%[![:space:]]*}"}"
      interpreter="${interpreter%% *}"
      if [[ -x "$(inside "$interpreter")" && ! -d "$(inside "$interpreter")" ]]; then
        ok "interpreter $interpreter"
      else
        bad "$program needs $interpreter, which the installer does not have"
      fi
    fi
  fi
elif [[ -n "$unit" && "$unit" != masked ]]; then
  bad "$UNIT has no ExecStart="
fi

# The policy that lets the service own its name on the system bus.
policy=""
for dir in /usr/share/dbus-1/system.d /etc/dbus-1/system.d; do
  file="$(inside "$dir")/$NAME.conf"
  [[ -f "$file" ]] && grep -Eq "<allow[^>]*own(_prefix)?=\"$NAME\"" "$file" && policy="$dir/$NAME.conf"
done
if [[ -n "$policy" ]]; then ok "D-Bus policy $policy"; else bad "no D-Bus policy lets lvmdbusd own $NAME"; fi

# What lvmdbusd runs: the lvm command its path.py names, and the profile it sets for it.
site_dirs=()
for dir in "$root"/usr/lib/python3*/site-packages "$root"/usr/lib64/python3*/site-packages; do
  [[ -d "$dir" ]] && site_dirs+=("$dir")
done
lvm_command=/usr/bin/lvm
for dir in ${site_dirs[@]+"${site_dirs[@]}"}; do
  [[ -f "$dir/lvmdbusd/path.py" ]] || continue
  named="$(sed -n 's/^LVM_BINARY[[:space:]]*=[[:space:]]*["'\'']\([^"'\'']*\)["'\''].*/\1/p' "$dir/lvmdbusd/path.py" | head -n 1)"
  [[ -z "$named" ]] || lvm_command="$named"
done
if [[ -x "$(inside "$lvm_command")" ]]; then ok "lvm command $lvm_command"; else bad "lvmdbusd runs $lvm_command, which the installer does not have"; fi
if [[ -f "$(inside /etc/lvm/profile/lvmdbusd.profile)" ]]; then
  ok "lvm profile /etc/lvm/profile/lvmdbusd.profile"
else
  bad "the installer has no /etc/lvm/profile/lvmdbusd.profile, which lvmdbusd sets for every lvm command"
fi

# The Python modules lvmdbusd imports (the runtime check imports them for real).
for module in lvmdbusd dbus gi pyudev; do
  found=""
  for dir in ${site_dirs[@]+"${site_dirs[@]}"}; do
    [[ -d "$dir/$module" || -f "$dir/$module.py" ]] && found="${dir#"$root"}/$module"
  done
  if [[ -n "$found" ]]; then ok "Python module $found"; else bad "the installer has no Python module $module, which lvmdbusd imports"; fi
done

# The libblockdev plugin that talks to lvmdbusd, where the installer's configuration picks it.
picked=""
for file in "$root"/etc/libblockdev/*/conf.d/*.cfg; do
  [[ -f "$file" ]] && grep -q 'libbd_lvm-dbus' "$file" && picked="${file#"$root"}"
done
if [[ -n "$picked" ]]; then
  plugin=""
  for file in "$root"/usr/lib64/libbd_lvm-dbus.so.* "$root"/usr/lib/libbd_lvm-dbus.so.*; do
    [[ -e "$file" ]] && plugin="${file#"$root"}"
  done
  if [[ -n "$plugin" ]]; then
    ok "libblockdev's LVM plugin is $plugin ($picked), so Anaconda needs this service"
  else
    bad "$picked picks libblockdev's lvm-dbus plugin, which the installer does not have"
  fi
fi

if [[ -n "$failed" ]]; then
  echo "check-installer: the installer cannot start $NAME" >&2
  exit 1
fi
if [[ -n "$static" ]]; then
  echo "The installer's D-Bus activation of $NAME is complete (files only)."
  exit 0
fi

# Inside the root, as systemd would run it but on a private bus: imports, lvm, the name, a read.
[[ "$(id -u)" == 0 ]] || { echo "check-installer: starting lvmdbusd needs root (or use --static)" >&2; exit 2; }
for dir in proc sys dev run tmp; do mkdir -p "$root/$dir"; done
mount -t proc proc "$root/proc"
mounted+=("$root/proc")
# A sysfs of its own, without the host's SELinux file system under it.
mount -t sysfs sysfs "$root/sys"
mounted+=("$root/sys")
mount --bind /dev "$root/dev"
mounted+=("$root/dev")
mount -t tmpfs tmpfs "$root/run"
mounted+=("$root/run")
mount -t tmpfs tmpfs "$root/tmp"
mounted+=("$root/tmp")
mkdir -p "$root/run/lock"

in_root() {
  chroot "$root" /usr/bin/env -i PATH=/usr/bin:/usr/sbin HOME=/root LC_ALL=C "$@"
}

if in_root python3 -c 'import dbus, dbus.mainloop.glib, dbus.service, gi, pyudev
gi.require_version("GLib", "2.0")
from gi.repository import GLib
import lvmdbusd.main'; then
  ok "lvmdbusd and its modules import"
else
  bad "lvmdbusd or a module it needs does not import in the installer"
fi
help="$(in_root LVM_COMMAND_PROFILE=lvmdbusd "$lvm_command" help 2>&1)" || bad "'lvm help' fails in the installer: $help"
# lvmdbusd starts only when lvm lists fullreport (its JSON output).
if grep -q fullreport <<<"$help"; then
  ok "lvm help lists fullreport"
else
  bad "lvm in the installer has no fullreport, so lvmdbusd exits at once"
fi

cat >"$root/tmp/check-bus.conf" <<'EOF'
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=/tmp/check-bus</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
EOF
in_root dbus-daemon --config-file=/tmp/check-bus.conf --fork --print-pid >"$root/tmp/check-bus.pid" ||
  { echo "check-installer: dbus-daemon does not start in the installer" >&2; exit 1; }
bus_pid="$(cat "$root/tmp/check-bus.pid")"
address=unix:path=/tmp/check-bus
bus() { in_root busctl --address="$address" "$@"; }

# shellcheck disable=SC2086 # The unit's command line, split into words as systemd does here.
chroot "$root" /usr/bin/env -i PATH=/usr/bin:/usr/sbin HOME=/root LVM_DBUSD_USE_SESSION=1 DBUS_SESSION_BUS_ADDRESS="$address" \
  ${exec_start#[-@:+!]} --debug >"$root/tmp/lvmdbusd.log" 2>&1 &
service_pid=$!
waited=0
while ! bus status "$NAME" >/dev/null 2>&1; do
  if ! kill -0 "$service_pid" 2>/dev/null || (( waited >= START_WAIT * 4 )); then
    bad "lvmdbusd did not take $NAME within $START_WAIT s; its output:"
    tail -n 40 "$root/tmp/lvmdbusd.log" >&2
    kill "$service_pid" 2>/dev/null || true
    exit 1
  fi
  sleep 0.25
  waited=$((waited + 1))
done
ok "lvmdbusd took $NAME after about $(( (waited + 3) / 4 )) s"
if bus --timeout=60 call "$NAME" /com/redhat/lvmdbus1/Manager "$NAME.Manager" Refresh >/dev/null; then
  ok "lvmdbusd read the disks (Manager.Refresh)"
else
  bad "lvmdbusd took its name but could not read the disks (Manager.Refresh failed)"
fi
version="$(bus get-property "$NAME" /com/redhat/lvmdbus1/Manager "$NAME.Manager" Version 2>/dev/null || true)"
if [[ -n "$version" ]]; then ok "Manager.Version $version"; else bad "lvmdbusd does not answer Manager.Version"; fi
if kill -0 "$service_pid" 2>/dev/null; then ok "lvmdbusd is still running"; else bad "lvmdbusd stopped after it started"; fi
kill "$service_pid" 2>/dev/null || true
wait "$service_pid" 2>/dev/null || true

if [[ -n "$failed" ]]; then
  echo "check-installer: lvmdbusd's output:" >&2
  tail -n 40 "$root/tmp/lvmdbusd.log" >&2
  echo "check-installer: the installer cannot start $NAME" >&2
  exit 1
fi
echo "The installer starts $NAME and it reads the disks."
