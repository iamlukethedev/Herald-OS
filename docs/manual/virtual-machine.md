# Trying it in a virtual machine

A virtual machine runs Herald OS Linux in a window on the computer you already have, so you can try
the whole operating system without installing it. Nothing outside the virtual machine changes.

Releases carry a ready-made virtual machine disk. The first start sets itself up in a few minutes,
Hermes Agent included, then asks for your name and a password. So far every release has only the
Apple Silicon disk, the `aarch64.qcow2.zst` that `try.sh` downloads and boots
([From the terminal on an Apple Silicon Mac](#from-the-terminal-on-an-apple-silicon-mac)).

The UTM bundle for an Apple Silicon Mac (`aarch64.utm.zip`) and the x86_64 disks, the Hyper-V
`.vhdx.zip` for Windows and the `x86_64.qcow2.zst` for Linux and Intel Macs, are not yet available:
no release has published them so far
([#186](https://github.com/iamlukethedev/Herald-OS/issues/186)).

## On an Apple Silicon Mac, with UTM

**Not yet available.** No release has published the UTM bundle yet, so these steps are for when one
does. Until then,
[From the terminal on an Apple Silicon Mac](#from-the-terminal-on-an-apple-silicon-mac) downloads
the Apple Silicon disk and boots it.

No Homebrew or terminal needed:

1. Install [UTM](https://mac.getutm.app), a free app that runs virtual machines.
2. Download `herald-os-<version>-aarch64.utm.zip` from the
   [releases page](https://github.com/iamlukethedev/Herald-OS/releases) and open it. Finder unpacks
   `Herald OS.utm`. If the release has it in parts, see [Files in parts](#files-in-parts).
3. Double-click `Herald OS.utm`. UTM adds it to its list; press the play button.

The bundle gives the virtual machine 4 cores and 6 GB of memory; UTM's settings for the machine
change them. It runs on Apple's hypervisor with GPU-accelerated graphics, and asks UTM for sound, a
shared clipboard and a screen that follows the window's size. How much of that Herald OS Linux uses
inside UTM is still being tested ([#67](https://github.com/iamlukethedev/Herald-OS/issues/67)).

## On Windows, with Hyper-V

**Not yet available.** No release has published the Hyper-V disk yet
([#186](https://github.com/iamlukethedev/Herald-OS/issues/186)), so these steps are for when one
does; Windows support is tracked in [#92](https://github.com/iamlukethedev/Herald-OS/issues/92).
Until then, use
[the installer in another virtual machine](#with-the-installer-virtualbox-and-others).

Hyper-V comes with Windows 11 Pro, Enterprise and Education. Windows 11 Home has no Hyper-V: use
[the installer in another virtual machine](#with-the-installer-virtualbox-and-others) instead.

1. Turn Hyper-V on: Start, type "Turn Windows features on or off", tick **Hyper-V** and restart.
2. Download `herald-os-<version>-x86_64.vhdx.zip` from the
   [releases page](https://github.com/iamlukethedev/Herald-OS/releases) and unpack it to a folder
   with 40 GB free; the disk grows up to that as you use it. If the release has it in parts, see
   [Files in parts](#files-in-parts).
3. In Hyper-V Manager, **New > Virtual Machine**: generation 2, 6144 MB of memory, the **Default
   Switch** network, and **Use an existing virtual hard disk** with the `.vhdx`.
4. Before the first start, open the machine's **Settings**: under **Security** set the Secure Boot
   template to **Microsoft UEFI Certificate Authority** (the Windows one refuses Linux), and under
   **Processor** give it 4 virtual processors.
5. **Connect**, then **Start**.

Hyper-V gives Linux no 3D acceleration, so the processor draws the screen, and there is no sound or
shared clipboard there yet.

## On Linux or an Intel Mac

`herald-os-<version>-x86_64.qcow2.zst` (and `aarch64` for ARM machines) is a ready-made disk for
QEMU, virt-manager, GNOME Boxes or UTM on an Intel Mac. The x86_64 one is not yet available: no
release has published it so far ([#186](https://github.com/iamlukethedev/Herald-OS/issues/186)); the
`aarch64` one is in every release. Unpack it with `zstd -d`, then create a machine that boots with
UEFI from it as an existing disk, with 4 cores, 6 GB of memory and room for the disk to grow to
40 GB.

## With the installer: VirtualBox and others

Any virtual machine that boots with UEFI can also install Herald OS from the x86_64 installer ISO,
as in [Installing on a PC](install-pc.md): VirtualBox with EFI turned on, on Windows 11 Home for
example. The Hyper-V disk has not been tried in VirtualBox. Give the machine 4 cores, 6 GB of memory
and a 40 GB disk, which is what CI installs it with, and skip writing a USB stick: point the virtual
machine's CD drive at the joined ISO.

## Files in parts

GitHub takes release files of up to 2 GB, so a bigger one comes in parts:

- The `qcow2.zst` disks and the installer ISO as `.part0`, `.part1`.
- The zips (`.utm.zip`, `.vhdx.zip`), once a release has them, as `.001`, `.002` and so on. Open
  the `.001` with [Keka](https://www.keka.io) on a Mac or [7-Zip](https://www.7-zip.org) on
  Windows, which read the parts as one archive.

Every disk and the installer ISO has a `.sha256` beside it for the whole file. From a terminal on
a Mac or Linux, join the parts and check the result, here the Apple Silicon disk:

```bash
VERSION=0.1.0-alpha.4    # replace with the version you downloaded
cat "herald-os-$VERSION-aarch64.qcow2.zst.part"* > "herald-os-$VERSION-aarch64.qcow2.zst"
shasum -a 256 -c "herald-os-$VERSION-aarch64.qcow2.zst.sha256"    # sha256sum -c on Linux
```

Releases after 0.1.0-alpha.4 will also have a `.sha256sums` with one line per part. With it, check
the parts before joining them, so a bad download shows which part to fetch again:

```bash
shasum -a 256 -c "herald-os-$VERSION-aarch64.qcow2.zst.sha256sums"    # sha256sum -c on Linux
```

The zips join with `.[0-9][0-9][0-9]` instead (the `.vhdx.zip` here; the `.utm.zip` is the same):

```bash
shasum -a 256 -c "herald-os-$VERSION-x86_64.vhdx.zip.sha256sums"    # each part
cat "herald-os-$VERSION-x86_64.vhdx.zip."[0-9][0-9][0-9] > "herald-os-$VERSION-x86_64.vhdx.zip"
shasum -a 256 -c "herald-os-$VERSION-x86_64.vhdx.zip.sha256"          # the joined file
```

On Windows, in a Command Prompt, join the parts with a `+` between each, then compare the hash
`certutil` prints with the one in the `.sha256`:

```bat
rem replace with the version you downloaded
set "VERSION=0.1.0-alpha.4"
copy /b herald-os-%VERSION%-aarch64.qcow2.zst.part0 + herald-os-%VERSION%-aarch64.qcow2.zst.part1 herald-os-%VERSION%-aarch64.qcow2.zst
certutil -hashfile herald-os-%VERSION%-aarch64.qcow2.zst SHA256
```

If there are more parts, add `+ herald-os-%VERSION%-aarch64.qcow2.zst.part2` (and so on) in order. To list them, run
`dir herald-os-%VERSION%-aarch64.qcow2.zst.part*`. Don't use a wildcard with `copy /b`, because it may join the parts out of order.
A zip in parts joins the same way, from `.001`, `.002`.

On Windows, 7-Zip's right-click menu also has **CRC SHA > SHA-256** for a file.

## From the terminal on an Apple Silicon Mac

One command downloads the latest release's disk (about 2.7 GB), joins and unpacks it, and starts it
with Apple's Virtualization framework:

```bash
brew install qemu zstd
git clone https://github.com/iamlukethedev/Herald-OS.git && cd Herald-OS && bash linux/vm/try.sh
```

This virtual machine gets 4 cores and 8 GB of memory; on a Mac with 8 GB in total, start it with
`MEM=4096` in front of the command. `bash linux/vm/run-vf.sh stop` shuts it down, and running
`bash linux/vm/try.sh` again starts it with the disk it already downloaded.

## The system key in a virtual machine

On real hardware the system key is `Super`. When the virtual machine has no graphics acceleration,
Herald OS runs its window manager nested and uses `Alt` instead, because the host keeps `Super` (or
`Command`) for itself: `Super+A` becomes `Alt+A`, and so on. `Super+Alt+Space` then collapses into
`Alt+Space`, so open the Herald OS menu with `Alt+M` (`Super+M` on hardware).

- **Hyper-V** has no graphics acceleration for Linux, so use `Alt`.
- **UTM** gives the virtual machine accelerated graphics, so `Super` should work as on hardware, but
  how UTM passes the Mac's `Command` key through has not been tried yet. If `Super` does nothing,
  try `Alt`.

## Scaling on a Retina or HiDPI screen

If everything looks tiny, give the virtual machine's display a larger scale, such as 200% on a
Retina screen: [Troubleshooting](troubleshooting.md#apps-look-too-large-or-too-small) has the steps.

## Building it from your checkout

To work on Herald OS Linux itself, the development virtual machine builds it from your checkout; the
[README](../../README.md#herald-os-linux-in-a-virtual-machine) and [docs/LINUX.md](../LINUX.md) have
the steps.
