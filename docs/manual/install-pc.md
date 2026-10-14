# Installing on a PC

Herald OS Linux is a whole operating system for a 64-bit Intel or AMD PC: Fedora underneath,
everything you see is Herald. The installer has been tested in a virtual machine in CI, not yet on
much real hardware, so try it on a computer you can spare and keep backups.

## What you need

- A 64-bit Intel or AMD PC. ARM PCs have no installer yet; Apple Silicon Macs use the
  [virtual machine](virtual-machine.md#on-an-apple-silicon-mac-with-utm). To try it on a Windows PC
  first, there is a [Hyper-V virtual machine](virtual-machine.md#on-windows-with-hyper-v).
- A USB stick of 8 GB or more (it is erased).
- A wired network for the first start helps: it installs Hermes Agent from the internet. Without one,
  the desktop comes up first and Hermes installs once you join Wi-Fi.

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
copy /b herald-os-<version>-x86_64.iso.part0 + herald-os-<version>-x86_64.iso.part1 herald-os-<version>-x86_64.iso
certutil -hashfile herald-os-<version>-x86_64.iso SHA256
```

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
- **Encryption:** tick "Encrypt my data" on the disk screen to encrypt the disk. It is off unless you
  tick it. You then type the disk password at every start, before Herald OS loads.

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

## The disk password and your keyboard

With encryption on, the disk password is asked for on the boot splash, before Herald OS (and its
drivers for Bluetooth and some USB hubs) has started. A Bluetooth keyboard cannot type there, and a
keyboard behind a dock or hub may not either, so keep a wired keyboard, or the laptop's own, at hand
for that prompt.

## Next

- [Updates, channels and rollback](updates.md): keeping it up to date, and going back.
- [Security](security.md): the firewall, fingerprint and security keys.
- [Troubleshooting](troubleshooting.md#herald-os-linux): a bad update, Wi-Fi, sound.
