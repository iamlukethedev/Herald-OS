# Trying it in a virtual machine

A virtual machine runs Herald OS Linux in a window on the computer you already have, so you can try
the whole operating system without installing it. Nothing outside the virtual machine changes.

## On an Apple Silicon Mac

One command downloads the latest release's virtual machine disk (about 2.7 GB) and starts it with
Apple's Virtualization framework, so the graphics are accelerated:

```bash
brew install qemu zstd
git clone https://github.com/iamlukethedev/Herald-OS.git && cd Herald-OS
bash linux/vm/try.sh
```

The first start sets itself up in a few minutes, Hermes Agent included, then asks for your name and
a password. The virtual machine gets 4 cores and 8 GB of memory; on a Mac with 8 GB in total, start
it with `MEM=4096` in front of the command. `bash linux/vm/run-vf.sh stop` shuts it down, and
running `bash linux/vm/try.sh` again starts it with the disk it already downloaded.

The disk is also on the [releases page](https://github.com/iamlukethedev/Herald-OS/releases) in two
parts, `herald-os-<version>-aarch64.qcow2.zst.part0` and `.part1`: join them with `cat`, unpack with
`zstd -d`, and it imports into [UTM](https://mac.getutm.app).

## On an Intel Mac, Windows or Linux

Install the x86_64 installer ISO, as in [Installing on a PC](install-pc.md), into a virtual machine
that boots with UEFI: UTM on an Intel Mac, virt-manager or GNOME Boxes on Linux, or VirtualBox with
EFI turned on under Windows. Give it 4 cores, 6 GB of memory and a 40 GB disk, which is what CI
installs it with. Skip writing a USB stick: point the virtual machine's CD drive at the joined ISO.

## The system key in a virtual machine

On real hardware the system key is `Super`. When the virtual machine has no graphics acceleration,
Herald OS runs its window manager nested and uses `Alt` instead, because the host keeps `Super` (or
`Command`) for itself: `Super+A` becomes `Alt+A`, and so on. `Super+Alt+Space` then collapses into
`Alt+Space`, so open the Herald OS menu with `Alt+M` (`Super+M` on hardware).

## Scaling on a Retina or HiDPI screen

If everything looks tiny, give the virtual machine's display a larger scale, such as 200% on a
Retina screen: [Troubleshooting](troubleshooting.md#apps-look-too-large-or-too-small) has the steps.

## Building it from your checkout

To work on Herald OS Linux itself, the development virtual machine builds it from your checkout; the
[README](../../README.md#herald-os-linux-in-a-virtual-machine) and [docs/LINUX.md](../LINUX.md) have
the steps.
