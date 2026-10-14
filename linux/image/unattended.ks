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
# device. Empty uses the internal disk (not USB, removable or read-only, and not the one the
# installer started from) when there is exactly one; with none or several, it erases nothing.
DISK=""

# --log takes stdout and stderr, so the console gets its own copy.
say() {
  echo "herald-os: $*" >&2
  { echo "herald-os: $*" >>/dev/console; } 2>/dev/null || true
}

# The disks under the installer's own files (a USB stick, a disk holding the ISO).
installer_disks() {
  local mount source parent
  for mount in /run/install/repo /run/install/source /run/install/isodir; do
    source="$(findmnt -no SOURCE "$mount" 2>/dev/null)" || continue
    source="${source%%[*}"
    [[ "$source" == /dev/* ]] || continue
    parent="$(lsblk -ndo PKNAME "$source" 2>/dev/null)"
    echo "${parent:-${source#/dev/}}"
  done
}

internal_disks() {
  local skip name type rm ro tran
  skip=" $(installer_disks | tr '\n' ' ') "
  while read -r name type rm ro tran; do
    [[ "$type" == disk && "$rm" == 0 && "$ro" == 0 && "$tran" != usb ]] || continue
    [[ "$name" == zram* || "$skip" == *" $name "* ]] && continue
    echo "$name"
  done < <(lsblk -dnro NAME,TYPE,RM,RO,TRAN)
}

if [[ -z "$DISK" ]]; then
  mapfile -t disks < <(internal_disks)
  if (( ${#disks[@]} == 0 )); then
    say "no internal disk to install to, so nothing was erased."
    say "Set DISK= in the kickstart's %pre to the disk to erase (a name lsblk lists, or /dev/disk/by-id/<id>)."
    exit 1
  fi
  if (( ${#disks[@]} > 1 )); then
    say "found ${#disks[@]} internal disks (${disks[*]}), so nothing was erased."
    say "Set DISK= in the kickstart's %pre to the one disk to erase: one of those names, or /dev/disk/by-id/<id>."
    exit 1
  fi
  DISK="${disks[0]}"
fi
say "erasing $DISK, and only $DISK"
{
  echo "ignoredisk --only-use=$DISK"
  echo "clearpart --all --drives=$DISK --initlabel --disklabel=gpt"
} >/tmp/herald-os-disk.ks
%end
