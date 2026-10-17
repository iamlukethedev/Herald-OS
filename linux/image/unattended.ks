# An unattended Herald OS install: boot the installer ISO with inst.ks=<url of this file>.
# It erases one disk and encrypts it; change the passphrase (or remove --passphrase to be asked).
# The %pre at the end picks the disk: DISK if set there, else the PC's only internal disk. With
# several internal disks it stops and erases nothing until DISK is set. Every other disk is left
# alone: ignoredisk hides them from zerombr, clearpart and autopart.
# The first %pre names the account and the SSH keys that may sign in to it, and runs before the
# disk's; left empty, the first start makes the account hermes and SSH stays off.
text
lang en_US.UTF-8
keyboard us
timezone UTC --utc
%include /tmp/herald-os-disk.ks
zerombr
autopart --type=btrfs --encrypted --passphrase=change-me
# The image itself; the installer ISO points this at the image it was built from.
ostreecontainer --url=ghcr.io/iamlukethedev/herald-os:stable
# The first boot creates the session user; the shell's setup sets its password.
rootpw --lock
# The login screen needs graphical.target, which Anaconda does not pick for greetd by itself.
xconfig --startxonboot
reboot
# A %post that writes the account's name and SSH keys into the installed system, when set below.
%include /tmp/herald-os-account.ks

%pre --interpreter=/usr/bin/bash --erroronfail --log=/tmp/herald-os-account.log
# The account the first start makes, and who may sign in to it over SSH. All of it is optional: left
# empty, the first start makes the account hermes, Herald OS's setup asks for its password, and SSH
# stays off. Anything here that is not usable stops the install before a disk is erased, and
# /tmp/herald-os-account.log says why.
#
# The account's name: lowercase letters, digits, - and _, starting with a letter or _. Empty: hermes.
ACCOUNT=""
# Public keys that may sign in to the account over SSH, one a line between the quotes (the contents
# of ~/.ssh/id_ed25519.pub), and GitHub accounts, separated by spaces, whose public keys may
# (github.com/<name>.keys, read now, while the installer is online). With any key, the first start
# turns SSH on for keys only, never passwords or root (herald-os setup ssh); with none, it stays off.
SSH_KEYS=""
GITHUB_KEYS=""

say() {
  echo "herald-os: $*" >&2
  { echo "herald-os: $*" >>/dev/console; } 2>/dev/null || true
}

refuse() {
  local line
  for line in "$@"; do say "$line"; done
  exit 1
}

# A public key sshd takes: a type it accepts, key data that names the same type, and for RSA a
# modulus of 2048 bits or more (DSA and unknown types are not taken). The installer may have no
# ssh-keygen, so Python reads the key; the first start checks it again with ssh-keygen.
valid_key() {
  python3 -c '
import base64, sys
types = ("ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521",
         "sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com")
def string(blob, at):
    size = int.from_bytes(blob[at:at + 4], "big")
    if len(blob) < at + 4 + size:
        raise ValueError("short")
    return blob[at + 4:at + 4 + size], at + 4 + size
fields = sys.argv[1].split()
if len(fields) < 2:
    sys.exit("not a type and a key")
if fields[0] not in types:
    sys.exit("not a key type sshd takes")
try:
    blob = base64.b64decode(fields[1], validate=True)
    kind, at = string(blob, 0)
    if kind != fields[0].encode() or len(blob) <= at:
        sys.exit("the key\x27s data is of another type")
    if kind == b"ssh-rsa":
        _, at = string(blob, at)
        modulus, _ = string(blob, at)
        bits = int.from_bytes(modulus, "big").bit_length()
        if bits < 2048:
            sys.exit(f"an RSA key of {bits} bits is too short (2048 at least)")
except ValueError:
    sys.exit("the key is not readable")
' "$1" 2>&1
}

# A key line's type, safe to log; never any of the key itself.
key_type() {
  local first="${1%%[[:space:]]*}"
  if [[ "$first" =~ ^[A-Za-z0-9@._-]{1,48}$ ]]; then echo "$first"; else echo unknown; fi
}

# Each key's fingerprint, for the log, when the installer has ssh-keygen.
fingerprint() {
  if command -v ssh-keygen >/dev/null 2>&1; then
    say "key: $(ssh-keygen -lf - <<<"$1" 2>/dev/null || echo "${1:0:40}...")"
  else
    say "key: ${1:0:40}..."
  fi
}

# GitHub's key page: https all the way, at most three redirects, and nothing past 1 MiB.
github_page() {
  local page
  page="$(curl -fsSL --proto =https --proto-redir =https --max-redirs 3 --max-filesize 1M \
    --retry 3 --connect-timeout 10 --max-time 30 "https://github.com/$1.keys")" || return 1
  (( ${#page} <= 1048576 )) || return 1
  printf '%s\n' "$page"
}

account_pattern='^[a-z_][a-z0-9_-]{0,31}$'
github_pattern='^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'
# Names Fedora's packages and groups use, which the image may have or add later; useradd would
# also refuse a name a group has. systemd-* is the systemd family's.
reserved=" root bin daemon adm lp sync shutdown halt mail operator games ftp nobody nfsnobody sshd dbus
  polkitd tss chrony avahi greetd rpc rpcuser colord geoclue pipewire rtkit unbound dnsmasq usbmuxd
  saslauth setroubleshoot flatpak gdm sddm wheel users video input render audio seat kvm utmp tty disk
  kmem dialout cdrom tape floppy lock mem man ssh_keys printadmin wireshark docker libvirt qemu named
  postfix apache nginx mysql postgres admin "
if [[ -n "$ACCOUNT" ]]; then
  [[ "$ACCOUNT" =~ $account_pattern ]] ||
    refuse "ACCOUNT=\"$ACCOUNT\" is not an account name, so nothing was erased." \
      "Use lowercase letters, digits, - and _, starting with a letter or _."
  [[ "$reserved" != *[[:space:]]"$ACCOUNT"[[:space:]]* && "$ACCOUNT" != systemd-* ]] ||
    refuse "ACCOUNT=\"$ACCOUNT\" is a system account's or group's name, so nothing was erased." \
      "Choose a person's name for the account."
  for database in passwd group; do
    known_id="$(getent "$database" "$ACCOUNT" 2>/dev/null | cut -d: -f3)" || known_id=""
    if [[ "$known_id" =~ ^[0-9]+$ ]] && (( known_id < 1000 || known_id > 60000 )); then
      refuse "ACCOUNT=\"$ACCOUNT\" is a system $([[ $database == passwd ]] && echo account || echo group) here (id $known_id), so nothing was erased." \
        "Choose a person's name for the account."
    fi
  done
fi

keys=""
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"
  [[ -z "$line" || "$line" == \#* ]] && continue
  reason="$(valid_key "$line")" ||
    refuse "SSH_KEYS has a key of type $(key_type "$line") that sshd should not take ($reason), so nothing was erased." \
      "Put one public key on each line, as ~/.ssh/id_ed25519.pub has it: Ed25519, ECDSA, a security key, or RSA of 2048 bits or more."
  keys+="$line"$'\n'
done <<<"$SSH_KEYS"
for name in $GITHUB_KEYS; do
  [[ "$name" =~ $github_pattern ]] ||
    refuse "GITHUB_KEYS names \"$name\", which is not a GitHub user name, so nothing was erased."
  found="$(github_page "$name")" ||
    refuse "could not read https://github.com/$name.keys, so nothing was erased." \
      "Check the name and the network, or put the keys in SSH_KEYS instead."
  count=0
  number=0
  while IFS= read -r line; do
    number=$((number + 1))
    [[ -n "$line" ]] || continue
    if ! reason="$(valid_key "$line")"; then
      say "https://github.com/$name.keys line $number: skipping a key of type $(key_type "$line"): $reason"
      continue
    fi
    [[ "$line" == *" "*" "* ]] || line="$line github:$name"
    keys+="$line"$'\n'
    count=$((count + 1))
  done <<<"$found"
  (( count > 0 )) ||
    refuse "$name has no SSH keys on GitHub (https://github.com/$name.keys), so nothing was erased."
done

while IFS= read -r line; do
  [[ -z "$line" ]] || fingerprint "$line"
done <<<"$keys"
say "the account: ${ACCOUNT:-hermes}; SSH: $([[ -n "$keys" ]] && echo "on at the first start, for $(grep -c . <<<"$keys") key(s) only" || echo off)"
# The keys go through base64, so nothing in a comment can end the here-document early.
{
  echo "# The account %pre in unattended.ks wrote this."
  if [[ -n "$ACCOUNT" || -n "$keys" ]]; then
    echo "%post --interpreter=/usr/bin/bash --erroronfail"
    echo "mkdir -p /etc/herald-os"
    [[ -z "$ACCOUNT" ]] || echo "echo 'user=$ACCOUNT' >/etc/herald-os/install.conf"
    if [[ -n "$keys" ]]; then
      echo "base64 -d >/etc/herald-os/ssh-keys <<'HERALD_OS_KEYS'"
      printf %s "$keys" | base64
      echo "HERALD_OS_KEYS"
      echo "chmod 0644 /etc/herald-os/ssh-keys"
    fi
    echo "%end"
  fi
} >/tmp/herald-os-account.ks
%end

%pre --interpreter=/usr/bin/bash --erroronfail --log=/tmp/herald-os-disk.log
# The disk to erase: a name from lsblk (nvme0n1, sda, vda) or /dev/disk/by-id/<id> for an exact
# device. It must be a whole disk that is writable, not the one the installer started from, and
# not in a multipath device or RAID set; /dev/mapper multipath devices are not supported. If the
# install stops, the reason is in /tmp/herald-os-disk.log (Ctrl+Alt+F2 for a shell): the text
# installer can hide the console line.
# Empty uses the internal disk (not USB, removable, read-only, a multipath or BIOS RAID member, or
# the installer's) when there is exactly one; with none or several, it erases nothing.
DISK=""

# --log takes stdout and stderr, so the console gets its own copy.
say() {
  echo "herald-os: $*" >&2
  { echo "herald-os: $*" >>/dev/console; } 2>/dev/null || true
}

refuse() {
  local line
  for line in "$@"; do say "$line"; done
  exit 1
}

# Natural order, so nvme2n1 comes before nvme10n1.
by_name() {
  LC_ALL=C sort -V
}

# The devices under the installer's own files (a USB stick, a disk holding the ISO), down to the
# disks: lsblk -s walks from a partition, LVM volume, RAID or LUKS device to every disk below it.
installer_disks() {
  local mount source
  for mount in /run/install/repo /run/install/source /run/install/isodir; do
    source="$(findmnt -no SOURCE "$mount" 2>/dev/null)" || continue
    source="${source%%[*}"
    [[ "$source" == /dev/* ]] || continue
    lsblk -nsro NAME "$source" 2>/dev/null
  done
}

# A path to a multipath device, or a member of a BIOS (firmware) or md RAID set: erasing the one
# disk would break the set, so such disks are never counted.
in_a_set() {
  local type fstype
  while read -r type fstype; do
    [[ "$type" == mpath || "$type" == dmraid || "$type" == raid* || "$fstype" == mpath_member || "$fstype" == *_raid_member ]] && return 0
  done < <(lsblk -nro TYPE,FSTYPE "/dev/$1" 2>/dev/null)
  return 1
}

internal_disks() {
  local skip name type rm ro tran
  skip=" $(installer_disks | tr '\n' ' ') "
  while read -r name type rm ro tran; do
    [[ "$type" == disk && "$rm" == 0 && "$ro" == 0 && "$tran" != usb ]] || continue
    [[ "$name" == zram* || "$skip" == *" $name "* ]] && continue
    in_a_set "$name" && continue
    echo "$name"
  done < <(lsblk -dnro NAME,TYPE,RM,RO,TRAN | by_name)
}

# DISK as a kernel name, after checking it is a writable whole disk other than the installer's.
# It goes into ignoredisk and clearpart --drives, so spaces, commas (a list of drives) and a
# leading dash (an option) are refused before anything looks it up. lsblk refuses anything that
# is not a block device.
checked_disk() {
  local path name type ro
  [[ "$DISK" =~ ^[A-Za-z0-9/._:@+-]+$ && "$DISK" != -* && "$DISK" != */-* ]] ||
    refuse "DISK=\"$DISK\" is not a disk name, so nothing was erased." \
      "Set DISK= in the kickstart's %pre to a disk lsblk lists, or /dev/disk/by-id/<id>, with nothing else."
  [[ "$DISK" == /* ]] && path="$DISK" || path="/dev/$DISK"
  path="$(readlink -f "$path")"
  type="$(lsblk -ndo TYPE "$path" 2>/dev/null)" ||
    refuse "DISK=\"$DISK\" is not a block device, so nothing was erased." \
      "Set DISK= in the kickstart's %pre to a disk lsblk lists, or /dev/disk/by-id/<id>."
  read -r name ro < <(lsblk -ndro NAME,RO "$path" 2>/dev/null) ||
    refuse "DISK=\"$DISK\" is not a block device, so nothing was erased."
  [[ "$type" == disk ]] ||
    refuse "DISK=\"$DISK\" is $path, a $type and not a whole disk, so nothing was erased." \
      "Set DISK= in the kickstart's %pre to a whole disk (nvme0n1, not nvme0n1p1)."
  [[ "$ro" == 0 ]] ||
    refuse "DISK=\"$DISK\" is $path, which is read-only, so nothing was erased."
  [[ " $(installer_disks | tr '\n' ' ') " != *" $name "* ]] ||
    refuse "DISK=\"$DISK\" is $path, the disk the installer started from, so nothing was erased."
  ! in_a_set "$name" ||
    refuse "DISK=\"$DISK\" is $path, part of a multipath device or RAID set, so nothing was erased." \
      "Erasing one disk of a set breaks the set; install to such storage by hand."
  echo "$name"
}

if [[ -n "$DISK" ]]; then
  disk="$(checked_disk)" || exit 1
else
  disks=()
  while read -r name; do disks+=("$name"); done < <(internal_disks)
  (( ${#disks[@]} > 0 )) ||
    refuse "no internal disk to install to, so nothing was erased." \
      "Set DISK= in the kickstart's %pre to the disk to erase (a name lsblk lists, or /dev/disk/by-id/<id>)."
  (( ${#disks[@]} == 1 )) ||
    refuse "found ${#disks[@]} internal disks (${disks[*]}), so nothing was erased." \
      "Set DISK= in the kickstart's %pre to the one disk to erase: one of those names, or /dev/disk/by-id/<id>."
  disk="${disks[0]}"
fi
say "erasing $disk, and only $disk"
{
  echo "ignoredisk --only-use=$disk"
  echo "clearpart --all --drives=$disk --initlabel --disklabel=gpt"
} >/tmp/herald-os-disk.ks
%end
