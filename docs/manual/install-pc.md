# Installing on a PC

Herald OS Linux is a whole operating system for a 64-bit Intel or AMD PC: Fedora underneath,
everything you see is Herald. The installer has been tested in a virtual machine in CI, not yet on
much real hardware, so try it on a computer you can spare and keep backups.

## What you need

- A 64-bit Intel or AMD PC. ARM PCs have no installer yet; Apple Silicon Macs use the
  [virtual machine](virtual-machine.md#from-the-terminal-on-an-apple-silicon-mac). To try it on a Windows PC
  first, there will be a [Hyper-V virtual machine](virtual-machine.md#on-windows-with-hyper-v)
  (not yet available, [#186](https://github.com/iamlukethedev/Herald-OS/issues/186)).
- A USB stick of 8 GB or more (it is erased).
- A wired network for the first start helps: it installs Hermes Agent from the internet. Without one,
  the desktop comes up first and Hermes installs once you join Wi-Fi.
- Wi-Fi, Bluetooth and laptop sound (including the Sound Open Firmware most recent Intel laptops
  need) work out of the box. An NVIDIA graphics card works too, on the open-source driver; to run
  local models on it, switch to the NVIDIA image after installing ([NVIDIA graphics](#nvidia-graphics)).

## 1. Download and join the installer

GitHub takes files of up to 2 GB, so the ISO comes in two parts. Download
`herald-os-<version>-x86_64.iso.part0`, `.part1` and the `.sha256` from the
[releases page](https://github.com/iamlukethedev/Herald-OS/releases), then join them.

On macOS or Linux:

```bash
VERSION=0.1.0-alpha.4    # replace with the version you downloaded
cat "herald-os-$VERSION-x86_64.iso.part"* > "herald-os-$VERSION-x86_64.iso"
shasum -a 256 -c "herald-os-$VERSION-x86_64.iso.sha256"    # sha256sum -c on Linux
```

Releases built after 0.1.0-alpha.4 also have a `.sha256sums` with a line per part. Download it too
and check the parts before joining them, so a bad download shows which part to fetch again:

```bash
shasum -a 256 -c "herald-os-$VERSION-x86_64.iso.sha256sums"    # sha256sum -c on Linux
```

On Windows, in a Command Prompt, join the parts, then compare the hash `certutil` prints with the one
in the `.sha256`:

```bat
rem replace with the version you downloaded
set "VERSION=0.1.0-alpha.4"
copy /b herald-os-%VERSION%-x86_64.iso.part0 + herald-os-%VERSION%-x86_64.iso.part1 herald-os-%VERSION%-x86_64.iso
certutil -hashfile herald-os-%VERSION%-x86_64.iso SHA256
```

If there are more parts, add `+ herald-os-%VERSION%-x86_64.iso.part2` (and so on) in order. To list them, run
`dir herald-os-%VERSION%-x86_64.iso.part*`. Don't use a wildcard with `copy /b`, because it may join the parts out of order.

## 2. Write the USB stick

Write the joined ISO with [Fedora Media Writer](https://fedoraproject.org/workstation/download) or
[balenaEtcher](https://etcher.balena.io). Copying the file onto the stick does not work; it has to be
written as an image.

## 3. Start the PC from the stick

Plug the stick in, turn the PC on and open its boot menu (often `F12`, `F11`, `Esc` or `F8` at
power-on; the PC's manual says which). Pick the USB stick.

- **Secure Boot can stay on.** Herald OS starts through Fedora's signed shim.
- **The disk screen is yours to decide.** Erase the whole disk, or keep Windows and install next to
  it (see [Dual boot](#dual-boot) below).
- **Encryption is on.** "Encrypt my data" is already ticked on the disk screen, and the installer
  asks for the disk password in a window of its own. You then type it at every start, before Herald
  OS loads, so use a wired keyboard for it (see [below](#the-disk-password-and-your-keyboard)).
  Untick the box to install without encryption: anyone who takes the computer or its disk out can
  then read your files, and a [reset](setup-and-reset.md#reset) deletes them without a secure erase.
  Next to Windows, only Herald OS's own part of the disk is encrypted. `herald-os password --disk`
  changes the disk password later.

## 4. The first start

The first start creates your account and installs Hermes Agent, which takes a few minutes. Then
Herald OS's setup asks who the computer is for (see [Setting it up for someone else](setup-and-reset.md)).
For yourself, it asks for your name, a password, Wi-Fi and Hermes's sign-in. Hermes needs a model
provider: a [Nous Portal](https://portal.nousresearch.com) account, or an API key for OpenRouter,
OpenAI, Anthropic, a local model and others.

## Dual boot

The installer's disk screen can install Herald OS next to Windows on the same disk. Make room first:
in Windows, Disk Management's "Shrink Volume" frees space at the end of the Windows partition, and a
backup beforehand is wise. Afterwards, the PC's boot menu, or the menu Herald OS shows at power-on,
picks which system starts. Herald OS's updates leave the Windows partition alone.

## NVIDIA graphics

The installer puts the standard image on every PC. It runs an NVIDIA card's screen with the
open-source driver, which has no CUDA, so local models do not use the card. If the PC has one, a
notification after the first sign-in says so. The NVIDIA image has NVIDIA's own driver, for the
GeForce GTX 16 and RTX 20 series and newer, and needs a `/boot` partition of 2 GiB, which the
installer makes unless you lay out the disk yourself. In a terminal:

```bash
herald-os-gpu-check switch stable
systemctl reboot
```

It checks that `/boot` has room first, and changes nothing if it does not (on a `/boot` of 1 GiB or
less it stops unless you add `--force`).

### Secure Boot: one key, once

With Secure Boot on, the NVIDIA driver only loads once Universal Blue's signing key is enrolled in
the computer. Until then, including the NVIDIA image's first start, the screen has the basic display
(on a laptop, the integrated graphics as usual) and a notification says how to enroll the key.
Enrolling it trusts everything Universal Blue signs with that key, not only this driver, and it
stays enrolled if you switch back. [The NVIDIA image](../LINUX.md#the-nvidia-image) says how to
check the key before you trust it, and how to remove it.

1. With the NVIDIA image running, in a terminal:

   ```bash
   sudo mokutil --import /etc/pki/akmods/certs/akmods-ublue.der
   ```

   It asks for a password twice (`input password:`). Choose a one-time password; it is only asked
   once more, at the next start.
2. Restart. Before Herald OS starts, a screen says `Press any key to perform MOK management`:
   press a key before its countdown ends.
3. Pick `Enroll MOK`, then `Continue`, `Yes`, type the password, and pick `Reboot`.

Afterwards `nvidia-smi` lists the card, and `modinfo -F signer nvidia` says `ublue kernel`.

## The disk password and your keyboard

With encryption on, the disk password is asked for on the boot splash, before Herald OS (and its
drivers for Bluetooth and some USB hubs) has started. A Bluetooth keyboard cannot type there, and a
keyboard behind a dock or hub may not either, so keep a wired keyboard, the laptop's own, or a
wireless one with its own 2.4 GHz USB receiver at hand for that prompt. The keyboard layout there
may not be yours, which is why the disk password takes only letters, digits, spaces and the symbols
on the keyboard.

## Next

- [Updates, channels and rollback](updates.md): keeping it up to date, and going back.
- [Security](security.md): the firewall, fingerprint and security keys.
- [Troubleshooting](troubleshooting.md#herald-os-linux): a bad update, Wi-Fi, sound.
