# Installing on a Mac

On a Mac, Herald OS runs fullscreen over macOS: the same interface, Hermes and tools, with macOS
underneath for the hardware and your Mac apps. Nothing on the Mac is replaced, and `Cmd+Q` quits.

## What you need

- A Mac with macOS 13 (Ventura) or later, with Apple Silicon (M1 or later) or an Intel processor.
  The Intel build is new and has not been tried on an Intel Mac yet; if it gives you trouble,
  [open an issue](https://github.com/iamlukethedev/Herald-OS/issues), or run
  [Herald OS Linux in a virtual machine](virtual-machine.md) instead.
- Hermes Agent with a model provider: a [Nous Portal](https://portal.nousresearch.com) account, or
  an API key for OpenRouter, OpenAI, Anthropic, a local model and others.

## 1. Install Hermes Agent

If you do not have it yet, in Terminal:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
source ~/.zshrc
hermes setup
```

`hermes setup` asks for your model provider and signs you in.

## 2. Install Herald OS

Download `HeraldOS-<version>-mac-arm64.dmg` on Apple Silicon or `HeraldOS-<version>-mac-x64.dmg` on
an Intel Mac from the [releases page](https://github.com/iamlukethedev/Herald-OS/releases), open it
and drag Herald OS to Applications. Apple menu > About This Mac says which you have: "Chip: Apple M…"
is Apple Silicon, "Processor: … Intel …" is Intel.

## 3. Let it open

This build is not notarized by Apple yet, so macOS stops it the first time. Run this once, then open
Herald OS from Applications:

```bash
xattr -dr com.apple.quarantine "/Applications/Herald OS.app"
```

## 4. The first start

Herald OS takes over the screen. `Cmd+Ctrl+F` leaves or re-enters fullscreen, and `Cmd+Q` quits and
stops the Hermes it started. On its first start it adds its system tools to Hermes
(`~/.hermes/plugins/herald-os-bridge`).

macOS asks for permissions the first time a feature needs them, not all at once: the microphone for
voice and dictation, Screen Recording for asking about the screen and screenshots, Accessibility and
Automation for typing into other apps and quitting apps, Calendars for today's events, Local Network
for a model server on your network, and Files and Folders for your Desktop, Documents and Downloads.
The [README](../../README.md#macos) lists what each one is for. You can change them later in System
Settings > Privacy & Security.

## Updating

Download the new DMG and replace the app in Applications. Hermes updates itself with `hermes update`.
See [Updates, channels and rollback](updates.md).

## Next

- [Coming from macOS](coming-from-macos.md): where your habits go.
- [Hotkeys](hotkeys.md): every shortcut.
