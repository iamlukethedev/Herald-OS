# Notifications and do not disturb

Herald OS shows its own notifications and, on Herald OS Linux, those of every other app: a message
from Signal, a finished download, a reminder. Each appears briefly in the corner of the screen and
then waits in the bell.

## The bell

The bell at the right of the menu bar opens the list of notifications; a dot on it means some are
new. Notifications with a button (such as "Ask Hermes" on a crash) can be answered from the list.
**Clear all** empties it. The list keeps the latest 200.

On a Mac, Herald OS's notifications also reach macOS's Notification Center while you are in another
app, but only from a code-signed build, which the current release is not yet; inside Herald OS they
always appear in the bell.

## Do not disturb

Do not disturb collects notifications in the bell without showing them, playing a sound or reading
them aloud. A light in the menu bar shows that it is on; click the light to turn it off.

- `Super+Ctrl+,` on Herald OS Linux, or `herald-os toggle dnd`.
- Settings > General > Switches > Do not disturb, on either platform.
- Toggle > Do not disturb in the Herald OS menu (`Super+M`).
- Or ask: "turn on do not disturb".

## Notifications read aloud

With voice on, Settings > Voice > Speak notifications has Hermes say new notifications out loud. Do
not disturb silences that too.

## Crash notifications

When a program crashes, a notification offers to have Hermes explain it. Settings > Notifications >
Crash help turns the offers off or mutes a program; see [Crash help](crash-help.md).

## Your own notifications

`herald-os notify <title> [body]` shows one from a script, a hook or a key of your own, and
`herald-os reminder 20m stretch` schedules one; see [Reminders, notices and weather](reminders.md).
