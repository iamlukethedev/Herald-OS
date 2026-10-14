# Lock screen, idle and the screensaver

What Herald OS Linux does when you step away, and how to lock it yourself.

## Locking

`Super+Ctrl+L` locks the screen, as does Lock in the System section of the Herald OS menu, or
`herald-os lock`. Type your password to unlock. The lock screen follows your theme, and
`herald-os branding set --lock <image>` puts your own picture on it (see
[Make it yours](make-it-yours.md#branding)).

Locking needs a password on your account: a lock nobody could undo would shut you out, so Herald OS
refuses to lock an account without one and says so. Set one in the first-start setup, or later with
`herald-os password` in a terminal. A fingerprint or security key can unlock it too; see
[Security](security.md).

## When you step away

Settings > General > When you step away sets what happens after some minutes without input:

| Setting | Default |
| --- | --- |
| Lock the screen after | 10 minutes (only when your account has a password) |
| Turn the screens off after | 15 minutes |
| Sleep after | Never: the computer only sleeps when you ask |

The screen also locks before the computer goes to sleep. From a terminal, `herald-os idle show`
prints the timings and `herald-os idle set lock=5 screen_off=10 suspend=30` changes them (minutes;
`0` is never).

## Stay awake

Stay awake stops all of that for as long as it is on, for a presentation, a download or a long
build: `Super+Ctrl+I`, Settings > General > Switches > Stay awake, or `herald-os toggle idle`. A light
in the menu bar shows it is on; click it to turn it off. On a Mac, Stay awake keeps the Mac from
sleeping while Herald OS runs.

## The screensaver

The screensaver shows the living wallpaper and a large clock after a few idle minutes. Turn it on in
Settings > General > Switches > Screensaver, and choose the minutes there (5 unless you change it).
Show it now with Toggle > Show the screensaver in the Herald OS menu, or `herald-os screensaver`.
Any key or movement of the mouse ends it. It does not lock the screen by itself; the lock comes at
its own time.

## Night light

Night light warms the screen's colours for the evening: `Super+Ctrl+N`, Settings > General >
Switches > Night light, or `herald-os toggle nightlight`. It is part of Herald OS Linux; on a Mac,
use macOS's own Night Shift.

## Power

`Super+Escape` opens the power menu: sleep, restart, shut down and log out. `herald-os suspend`
puts the computer to sleep straight away.
