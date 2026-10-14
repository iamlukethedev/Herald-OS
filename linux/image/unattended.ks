# An unattended Herald OS install: boot the installer ISO with inst.ks=<url of this file>.
# It erases one disk and encrypts it; change the passphrase (or remove --passphrase to be asked).
# The %pre at the end picks the disk: DISK if set there, else the PC's only internal disk. With
# several internal disks it stops and erases nothing until DISK is set. Every other disk is left
# alone: ignoredisk hides them from zerombr, clearpart and autopart.
text
lang en_US.UTF-8
keyboard us
timezone UTC --utc
%include /tmp/herald-os-disk.ks
zerombr
autopart --type=btrfs --encrypted --passphrase=change-me
# The image itself; the installer ISO points this at the image it was built from.
ostreecontainer --url=ghcr.io/iamlukethedev/herald-os:stable
# The first boot creates the session user; the shell's setup sets the name and password.
rootpw --lock
# The login screen needs graphical.target, which Anaconda does not pick for greetd by itself.
xconfig --startxonboot
reboot

%pre --interpreter=/usr/bin/bash --erroronfail --log=/tmp/herald-os-disk.log
# The disk to erase: a name from lsblk (nvme0n1, sda, vda) or /dev/disk/by-id/<id> for an exact
# device. It must be a whole disk that is writable and not the one the installer started from;
# /dev/mapper multipath devices are not supported. If the install stops, the reason is in
# /tmp/herald-os-disk.log (Ctrl+Alt+F2 for a shell): the text installer can hide the console line.
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
