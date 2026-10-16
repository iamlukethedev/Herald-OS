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

- **No login screen appears** on a system switched from another bootc system: press `Ctrl+Alt+F2`
  for a text console, sign in with your own account, and `sudo journalctl -b -u herald-os-login`
  says why. Once it is fixed, `sudo systemctl restart herald-os-login` and
  `sudo systemctl start greetd` bring the login screen back
  ([docs/LINUX.md](../LINUX.md#switching-a-bootc-system-to-herald-os) has more).
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

### Wi-Fi, Bluetooth, sound or the touchpad stopped working

Before you restart the computer, restart only the part that stopped: System > Fix in the Herald OS
menu (`Super+M`), Restart at the bottom of the Wi-Fi, Bluetooth or Sound panel, or in a terminal:

- `herald-os restart wifi` lifts an airplane-mode block (`rfkill`), turns networking and the Wi-Fi
  radio back on, and looks for networks again.
- `herald-os restart bluetooth` lifts the block and turns the Bluetooth adapter back on: try it
  when a headset will not reconnect.
- `herald-os restart sound` restarts PipeWire, its PulseAudio server and WirePlumber, and forces
  them down first if they are stuck: try it when the sound vanished after unplugging a monitor or a
  headset.
- `herald-os restart touchpad` rebinds the touchpad's driver (`i2c_hid_acpi`, or reloads
  `intel_quicki2c`), for a touchpad that went dead after waking up. It needs administrator rights,
  so it asks for your password; run it in a terminal if the menu cannot ask.

Hermes can do the same: say "my sound stopped working". If that does not help, the steps below go
further.

### Wi-Fi stopped working

1. Open the Wi-Fi panel (`Super+Ctrl+W`): turn Wi-Fi off and on, and forget and rejoin the network.
2. Check that no airplane-mode key or switch is on: `rfkill list` shows what is blocked, and
   `rfkill unblock wifi` lifts a software block.
3. `nmcli device status` should list the Wi-Fi device. If it is missing, the computer may need
   firmware Herald OS does not have yet (`sudo dmesg | grep -i firmware` names the file it looked
   for); `herald-os debug` and the output of `lspci -nn` (or `lsusb` for a USB adapter) help a bug
   report.
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
4. If the Sound panel lists only "Dummy Output", the sound chip did not start:
   `sudo dmesg | grep -i -e sof -e firmware` shows why, and helps a bug report with `herald-os debug`.

### Local models do not use the NVIDIA card

The standard image drives NVIDIA cards with the open-source driver, which has no CUDA. Switch to the
NVIDIA image ([NVIDIA graphics](install-pc.md#nvidia-graphics)). On the NVIDIA image, if `nvidia-smi`
says it cannot talk to the driver, Secure Boot is probably refusing it until Universal Blue's key is
enrolled; the same page says how.

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
