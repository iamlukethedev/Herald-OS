# Unattended installs

For setting up several PCs the same way, the installer can run from a kickstart file instead of
asking questions. It is for people comfortable with Anaconda, Fedora's installer: a kickstart can
wipe a disk without asking.

## The example kickstart

[`linux/image/unattended.ks`](../../linux/image/unattended.ks) is a starting point. As it stands, it:

- erases one disk and partitions it with btrfs. The `%pre` section at the end of the file picks
  the first internal disk by name (`nvme0n1` before `nvme1n1`, `sda` before `sdb`), skipping USB
  and removable disks and the one the installer started from. Every other disk is left alone. To
  choose the disk, set `DISK=` in that section to a name `lsblk` lists (`DISK="nvme1n1"`), or to
  `/dev/disk/by-id/<id>` for an exact device. If it finds no disk, the install stops before
  erasing anything;
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
  install by hand instead. On a PC with more than one internal disk, set `DISK=` rather than
  relying on the name order. While the installer runs, `/tmp/herald-os-disk.log` (from the shell
  on `Ctrl+Alt+F2`) says which disk it chose.
- Anaconda's [kickstart reference](https://pykickstart.readthedocs.io/en/latest/kickstart-docs.html)
  lists every command.
