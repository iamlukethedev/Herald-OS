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

## Collecting details for a bug report

On Herald OS Linux, `herald-os debug` prints the versions and the last lines of the logs. On a Mac,
attach the end of `~/.hermes/logs/herald-os.log`. Report security problems privately, as described
in [SECURITY.md](../../SECURITY.md).
