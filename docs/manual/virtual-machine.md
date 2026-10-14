# Trying it in a virtual machine

A virtual machine runs Herald OS Linux in a window on the computer you already have, so you can try
the whole operating system without installing it. Nothing outside the virtual machine changes.

Each release carries ready-made virtual machines: a UTM bundle for an Apple Silicon Mac, a Hyper-V
disk for Windows and a plain disk for Linux and Intel Macs. The first start sets itself up in a few
minutes, Hermes Agent included, then asks for your name and a password. The UTM bundle and the
Hyper-V disk come with releases built after 0.1.0-alpha.4; earlier releases have only the Apple
Silicon disk that `try.sh` uses ([From the terminal on an Apple Silicon Mac](#from-the-terminal-on-an-apple-silicon-mac)).

## On an Apple Silicon Mac, with UTM

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
QEMU, virt-manager, GNOME Boxes or UTM on an Intel Mac. Unpack it with `zstd -d`, then create a
machine that boots with UEFI from it as an existing disk, with 4 cores, 6 GB of memory and room for
the disk to grow to 40 GB.

## With the installer: VirtualBox and others

Any virtual machine that boots with UEFI can also install Herald OS from the x86_64 installer ISO,
as in [Installing on a PC](install-pc.md): VirtualBox with EFI turned on, on Windows 11 Home for
example. The Hyper-V disk has not been tried in VirtualBox. Give the machine 4 cores, 6 GB of memory
and a 40 GB disk, which is what CI installs it with, and skip writing a USB stick: point the virtual
machine's CD drive at the joined ISO.

## Files in parts

GitHub takes release files of up to 2 GB, so a bigger one comes in parts:

- The zips (`.utm.zip`, `.vhdx.zip`) as `.001`, `.002` and so on. Open the `.001` with
  [Keka](https://www.keka.io) on a Mac or [7-Zip](https://www.7-zip.org) on Windows, which read the
  parts as one archive.
- The `qcow2.zst` disks and the installer ISO as `.part0`, `.part1`.

Every file has a `.sha256` beside it for the whole file, and a file in parts also has a
`.sha256sums` with one line per part. From a terminal on a Mac or Linux, check the parts, join them
and check the result:

```bash
shasum -a 256 -c herald-os-<version>-x86_64.vhdx.zip.sha256sums    # each part; sha256sum -c on Linux
cat herald-os-<version>-x86_64.vhdx.zip.[0-9][0-9][0-9] > herald-os-<version>-x86_64.vhdx.zip
shasum -a 256 -c herald-os-<version>-x86_64.vhdx.zip.sha256          # the joined file
```

The `.utm.zip` joins the same way; the `.part0`, `.part1` files join with
`cat herald-os-<version>-aarch64.qcow2.zst.part* > herald-os-<version>-aarch64.qcow2.zst`.

On Windows, in a Command Prompt, join the parts with a `+` between each, then compare the hash
`certutil` prints with the one in the `.sha256`:

```bat
copy /b herald-os-<version>-x86_64.vhdx.zip.001 + herald-os-<version>-x86_64.vhdx.zip.002 herald-os-<version>-x86_64.vhdx.zip
certutil -hashfile herald-os-<version>-x86_64.vhdx.zip SHA256
```

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
