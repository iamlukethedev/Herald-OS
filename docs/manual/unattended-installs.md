# Unattended installs

For setting up several PCs the same way, the installer can run from a kickstart file instead of
asking questions. It is for people comfortable with Anaconda, Fedora's installer: a kickstart can
wipe a disk without asking.

## The example kickstart

[`linux/image/unattended.ks`](../../linux/image/unattended.ks) is a starting point. As it stands, it:

- erases the disks the installer finds (`clearpart --all`), which on a PC with one disk is all of
  it, and partitions them with btrfs; add `ignoredisk --only-use=nvme0n1` (with your disk's name)
  to limit it to one disk;
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
- `clearpart --all` erases every partition on the disks it uses, Windows included. To keep another
  system, install by hand instead.
- Anaconda's [kickstart reference](https://pykickstart.readthedocs.io/en/latest/kickstart-docs.html)
  lists every command.
