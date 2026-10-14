# Crash help

When a program crashes, Herald OS offers to have Hermes explain it, in plain words: what went wrong,
whether it is likely to happen again, and whether it is worth reporting to whoever makes the
program.

## When something crashes

A notification says "*Program* quit unexpectedly", with two buttons:

- **Ask Hermes** opens a conversation in which Hermes reads the crash report and explains it.
- **Mute *program*** stops the offers for that program.

The offer comes at most once every ten minutes for the same program, so a program that keeps
crashing does not bury you in notifications. Herald OS's own processes are left out.

## Settings

Settings > Notifications > Crash help:

- **Offer to explain crashes** turns the offers on or off. It is on to begin with.
- **Muted programs** lists what you muted, to unmute.

## From the command line (Linux)

```bash
herald-os crash list                 # crashes from the last 7 days
herald-os crash diagnose firefox     # have Hermes explain the latest one (a name or a process id)
herald-os crash mute steam           # stop the offers; `herald-os crash mute steam off` to undo
```

Or ask Hermes: "why did Firefox crash?"

## Where crash reports come from

On Herald OS Linux, crashes are read from systemd-coredump, through `journalctl`. On a Mac, they are
the reports macOS writes to `~/Library/Logs/DiagnosticReports`. The report goes to your model
provider only when you press Ask Hermes.

If offers never come, see [Troubleshooting](troubleshooting.md#crashes-and-notifications).
