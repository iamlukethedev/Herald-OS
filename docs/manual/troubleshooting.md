# Troubleshooting

The [README](../../README.md#troubleshooting) covers installation problems. This page is for when
Herald OS is running but something misbehaves.

## Hermes

- **Hermes does not answer.** The menu bar shows a badge while Hermes is unreachable. Run
  `hermes doctor` in a terminal; if it asks you to sign in, sign in or change provider under
  Settings > Hermes & agents > Model provider, or run `hermes setup`. Herald OS's own log is
  `~/.hermes/logs/herald-os.log`.
- **Hermes cannot reach a model server on your network.** A Mac lets an app reach devices on your
  local network only once you allow it, and Hermes counts as part of Herald OS, which starts it.
  Allow Herald OS when macOS asks, or turn it on in System Settings > Privacy & Security > Local
  Network. Mac builds up to 0.1.0 alpha 4 never ask, and every request to the server fails with "No
  route to host" (Errno 65, in `~/.hermes/logs/agent.log`). Hermes Desktop uses a Hermes that is
  already running, so if you open it while Herald OS runs, it uses Herald OS's and fails the same way.
- **Hermes runs shell commands instead of its system tools.** The system bridge is not loaded:
  run `npm run bootstrap` in your Herald OS checkout (or `herald-os setup` from a package), then
  restart Herald OS. `hermes plugins list` should show `herald-os-bridge` as enabled.
- **An action was refused.** Protected folders (`~/.ssh`, keychains, Hermes's credentials) are
  always refused, and destructive actions ask every time. Settings > Privacy shows the rules and the
  audit log of what happened.

## The Terminal

- **The Terminal says "posix_spawnp failed." and never shows a shell.** The Mac builds up to 0.1.0
  alpha 4 shipped the helper that starts its shells without permission to run. Run this once, then
  press Try again:

  ```bash
  chmod +x "/Applications/Herald OS.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
  ```

## Themes and the look

- **A theme does not change everything.** On a Mac, Herald OS recolours itself and Hermes's skin;
  macOS apps keep their own look. On Herald OS Linux, GTK apps pick up a new theme when they next
  start, and Obsidian needs its own theme setting.
- **Hermes's command line stopped following the theme.** Herald OS only selects its `herald-os`
  skin when you have not picked another one. Run `/skin herald-os` in Hermes to go back to it.
- **Something is unreadable in a light theme.** Switch back with "use the ocean theme" and tell us
  which screen it was.

## Crashes and notifications

- **I never get crash offers.** Settings > Notifications > Crash help must be on, and the program
  must not be muted there. On Linux, crashes are read from systemd-coredump through `journalctl`;
  `herald-os crash list` shows what it sees.
- **The same program keeps crashing.** Herald OS offers help once every ten minutes per program;
  mute it from the notification if you do not need the offers.
- **macOS shows no notifications from Herald OS.** macOS only delivers notifications from signed
  builds; inside Herald OS they still appear in the bell.

## Hooks and event automations

- **A hook does not run.** It must be executable (`chmod +x`) and must not end in `.sample`. Its
  output is in `~/.hermes/logs/herald-os.log`, on lines starting with `[hooks]`.
- **An event automation did not run.** Hermes must be running when the event happens, and the
  automation must be on. The log has a `[events]` line for every event and every automation fired.

## The shell

- **A window stays blank, or part of a page never fills in.** The window's errors are in
  `~/.hermes/logs/herald-os.log`, on lines starting with `[renderer]` and the window's name:
  `desktop` when the shell is one window, as on a Mac, and on Herald OS Linux the part it draws
  (`main`, `menubar`, `dock` and so on).

## Herald OS Linux

### An update went wrong

The version before stays in the boot menu. If the computer still starts, choose Update > Go back to
the previous version in the Herald OS menu (`Super+M`), or run `herald-os rollback`, and restart. If
it does not start, or the desktop never appears, pick the previous entry in the boot menu at
power-on; once it is running, `herald-os rollback` makes it the default. Your files are not touched
either way. Then [tell us](https://github.com/iamlukethedev/Herald-OS/issues) what broke, with the
output of `herald-os debug`. On the tarball, `herald-os rollback` swaps back to
`/opt/herald-os.previous` at the next login.

### Locked out of your account

- **The lock screen does not take your password.** Check Caps Lock and the keyboard layout. A
  fingerprint or security key you set up works too.
- **You forgot the password,** but another account on the computer is an administrator: sign in
  there and run `sudo passwd <your account>`.
- **Nobody knows a password.** Start the rescue shell: in the boot menu, press `e`, add
  `systemd.unit=rescue.target systemd.setenv=SYSTEMD_SULOGIN_FORCE=1` to the end of the line that
  starts with `linux`, and press `Ctrl+X`. At the root prompt, `passwd <your account>` sets a new
  password; `systemctl default` then carries on starting. On an encrypted disk, the disk password is
  still needed first, and it cannot be recovered: without it, the files are gone.
- **The screen will not lock at all.** Your account has no password yet: set one with
  `herald-os password`.

### Wi-Fi stopped working

1. Open the Wi-Fi panel (`Super+Ctrl+W`): turn Wi-Fi off and on, and forget and rejoin the network.
2. Check that no airplane-mode key or switch is on: `rfkill list` shows what is blocked, and
   `rfkill unblock wifi` lifts a software block.
3. `nmcli device status` should list the Wi-Fi device. If it is missing, the computer may need
   firmware Herald OS does not have yet; `herald-os debug` and the output of `lspci -nn` (or `lsusb`
   for a USB adapter) help a bug report.
4. `sudo systemctl restart NetworkManager` restarts the network service.

### Bluetooth stopped working

1. Open the Bluetooth panel (`Super+Ctrl+B`), turn Bluetooth off and on, and pair the device again
   (remove it on the device's side too, if it remembers the computer).
2. `rfkill list` shows whether Bluetooth is blocked; `rfkill unblock bluetooth` lifts it.
3. `sudo systemctl restart bluetooth` restarts the Bluetooth service.

### No sound

1. Open the Sound panel (`Super+Ctrl+A`): check the volume and mute, and that the right speakers or
   headphones are chosen. Plugging in headphones or a monitor with speakers can move the sound there.
2. If the panel says PipeWire is not running, restart the sound services:
   `systemctl --user restart pipewire pipewire-pulse wireplumber`.
3. A Bluetooth headset that plays but will not use its microphone (or the other way round) can be
   switched in the Sound panel by choosing it as the input or the output.

### Apps look too large or too small

- **The whole screen:** the Displays panel (`Super+Ctrl+D`) sets each display's scale, from 100% to
  200%; it is kept in `~/.config/niri/outputs.kdl`. On a laptop with a sharp screen, 150% or 200%
  is usual.
- **In a virtual machine on a Retina or HiDPI screen,** where Herald OS runs inside a window of its
  own: set `HERALD_OS_SCALE=2` (or `1.5`) in `~/.config/herald-os/session.env`, and put
  `output "winit" { scale 2; }` in `~/.config/niri/local.kdl`, then restart the session with
  `sudo systemctl restart greetd`. The first start writes `local.kdl` from `HERALD_OS_SCALE` when it
  is missing, and never changes it after that.
- **One app:** most apps zoom with `Ctrl+Plus` and `Ctrl+Minus`.

## Collecting details for a bug report

On Herald OS Linux, `herald-os debug` prints the versions and the last lines of the logs. On a Mac,
attach the end of `~/.hermes/logs/herald-os.log`. Report security problems privately, as described
in [SECURITY.md](../../SECURITY.md).
