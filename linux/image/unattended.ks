# An unattended Herald OS install: boot the installer ISO with inst.ks=<url of this file>.
# It erases one disk and encrypts it; change the passphrase (or remove --passphrase to be asked).
# The %pre at the end picks the disk (the first internal one; set DISK there to choose) and every
# other disk is left alone: ignoredisk hides them from zerombr, clearpart and autopart.
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
# device. Empty picks the first internal disk, by name: not USB, removable or read-only, and not
# the one the installer started from.
DISK=""

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

pick_disk() {
  local skip name type rm ro tran
  skip=" $(installer_disks | tr '\n' ' ') "
  while read -r name type rm ro tran; do
    [[ "$type" == disk && "$rm" == 0 && "$ro" == 0 && "$tran" != usb ]] || continue
    [[ "$name" == zram* || "$skip" == *" $name "* ]] && continue
    echo "$name"
    return 0
  done < <(lsblk -dnro NAME,TYPE,RM,RO,TRAN | LC_ALL=C sort)
  return 1
}

disk="${DISK:-$(pick_disk)}"
if [[ -z "$disk" ]]; then
  echo "herald-os: no internal disk to install to; set DISK in the kickstart's %pre" >&2
  exit 1
fi
echo "herald-os: erasing $disk, and only $disk" >&2
{
  echo "ignoredisk --only-use=$disk"
  echo "clearpart --all --drives=$disk --initlabel --disklabel=gpt"
} >/tmp/herald-os-disk.ks
%end
