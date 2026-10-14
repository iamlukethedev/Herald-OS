# Automations

An automation is a job Hermes does without being asked each time: on a schedule, or whenever
something happens on the computer. The Automations page (`Cmd+6` on a Mac, `Ctrl+6` on Linux) lists
them.

## Making one

Say it: "every weekday at 9, tell me what is on my calendar", or "every time I log in, check my disk
space". Or press **New automation** and fill in:

- **Name:** what to call it.
- **When:** **On a schedule** takes short phrases ("weekdays at 8:00", "every 6h", "every monday
  9am", "daily at 7am"), a cron line (`0 9 * * 1-5`) or a date and time for a single run
  (`2026-02-03T14:00`); the form shows how it understood you. **When something happens** picks an event (below).
- **What Hermes should do:** the instructions, as you would type them in a chat.
- **Deliver to:** where the result goes: saved as a briefing to open in Hermes, or posted to a
  messaging platform you connected (see [Connections](connections.md)).

**Describe it to Hermes** hands the whole thing to Hermes to set up in a conversation instead.

## Events

| When something happens | Notes |
| --- | --- |
| When I log in | |
| When the computer wakes up | |
| When I unlock the screen | |
| When I come back after a break | |
| When the battery is low | |
| When the network changes | Optionally only for one Wi-Fi network |
| When a program crashes | Optionally only for one program |
| When the theme changes | |
| After Herald OS updates | |

Event automations run while Herald OS is open, each time the event happens on this computer.
Scheduled ones run whenever Hermes is running.

## Managing them

Each automation's switch turns it on or off. Its menu has **Run now**, **Duplicate** and **Delete**.
**Recent runs** shows what ran and what came of it. Or ask: "pause the morning briefing", "run the
disk check now".

## Hooks

For something that should run a script rather than ask Hermes, Herald OS Linux has hooks: executable
files in `~/.config/herald-os/hooks/<event>.d/` run when the event happens. `herald-os hook list`
shows them and `herald-os hook install battery-low ~/bin/dim` adds one.
[Make it yours](make-it-yours.md#hooks) has examples, and
[Troubleshooting](troubleshooting.md#hooks-and-event-automations) helps when one does not run.
