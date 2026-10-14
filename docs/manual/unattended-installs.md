# Unattended installs

For setting up several PCs the same way, the installer can run from a kickstart file instead of
asking questions. It is for people comfortable with Anaconda, Fedora's installer: a kickstart can
wipe a disk without asking.

## The example kickstart

[`linux/image/unattended.ks`](../../linux/image/unattended.ks) is a starting point. As it stands, it:

- erases one disk and partitions it with btrfs, and leaves every other disk alone. The disk is
  the one set with `DISK=` in the `%pre` section at the end of the file: a name `lsblk` lists
  (`DISK="nvme1n1"`), or `/dev/disk/by-id/<id>` for an exact device. It must be a whole disk
  (`nvme0n1`, not the partition `nvme0n1p1`) that can be written to, and not the USB stick or the
  disk holding the installer, even when the ISO file sits on an LVM volume or RAID set. `DISK=`
  takes one name and nothing else: spaces, commas and options such as `--foo` are refused.
  Multipath storage and RAID sets are not supported: a `/dev/mapper/` multipath device
  (`/dev/mapper/mpatha`, or its `/dev/disk/by-id/dm-uuid-mpath-` link) is refused as `DISK=`
  because it is not a whole disk, and so is one disk of a set, such as `sda` when it is a path to
  `mpatha`, or a disk that is a member of a BIOS or md RAID set, because erasing it would break
  the set. Install to such storage by hand.
  With `DISK=` left empty, it uses the PC's internal disk if there is exactly one, not counting
  USB and removable disks, disks that belong to a multipath device or a BIOS or md RAID set, or
  the one the installer started from. If `DISK=` is not usable, or it finds no internal disk or
  more than one, the install stops before erasing anything and writes why to
  `/tmp/herald-os-disk.log`. With several disks it names them in order (`nvme2n1` before
  `nvme10n1`). It also prints the reason on the screen, but the text installer can draw over that
  line, so if the install stops, press `Ctrl+Alt+F2` for a shell and run
  `cat /tmp/herald-os-disk.log`;
- encrypts it with the passphrase `change-me` (change it, or remove `--passphrase=change-me` to be
  asked for one at install time);
- sets English, a US keyboard and UTC, which you can change in the `lang`, `keyboard` and
  `timezone` lines;
- installs the `stable` Herald OS image and locks the root account;
- restarts when it is done.

It creates no account: the first start does that, and the first-start setup asks who the computer is
for, as in [Setting it up for someone else](setup-and-reset.md). Choose "For someone else" on each
machine to leave them waiting for their owners.

## Running it

1. Copy `unattended.ks`, edit it, and put it where the PCs can download it over the network, for
   example on a web server (`http://192.168.1.10/herald.ks`).
2. Write the installer to a USB stick as in [Installing on a PC](install-pc.md).
3. Start a PC from the stick. In the boot menu, press `e` on the install entry, add
   `inst.ks=http://192.168.1.10/herald.ks` to the end of the line that starts with `linux`, and press
   `Ctrl+X`.

The installer then runs without stopping, and the PC restarts into Herald OS's first start.

## Before you rely on it

- Test the kickstart in a [virtual machine](virtual-machine.md) first, with a disk you do not need.
- The disk it picks loses every partition, Windows included. To keep another system on that disk,
  install by hand instead. On PCs with more than one internal disk, the kickstart needs `DISK=`
  set, so one file may not suit every PC; a `/dev/disk/by-id/<id>` path names one exact disk.
  `/tmp/herald-os-disk.log`, read from the shell on `Ctrl+Alt+F2` while the installer runs, says
  which disk it chose or why it stopped.
- Anaconda's [kickstart reference](https://pykickstart.readthedocs.io/en/latest/kickstart-docs.html)
  lists every command.
