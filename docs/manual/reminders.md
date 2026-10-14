# Reminders, notices and weather

Small things Herald OS Linux tells you when you ask, as a notification.

## Reminders

Say or type "remind me in 20 minutes to stretch", or use Trigger > Reminder… in the Herald OS menu
(`Super+M`). From a terminal:

```bash
herald-os reminder 20m stretch          # also 90s, 1h, 1h30m
herald-os reminder list                 # what is coming, and when
herald-os reminder clear                # cancel them all
```

When it is time, a notification says what you asked to be reminded of. Reminders are kept until you
log out or restart; for something every day or at a set time, make an
[automation](automations.md) instead ("every weekday at 9, remind me to check the post").

## Notices

The Trigger section of the Herald OS menu shows a notice of the time and date, the battery (charge
and whether it is charging), or the weather, for when the menu bar is hidden or you would rather
hear it: with Settings > Voice > Speak notifications on, Hermes reads it out. `herald-os notice time`,
`herald-os notice battery` and `herald-os notice weather` do the same.

## Weather

The weather comes from [wttr.in](https://wttr.in), for the place your network appears to be in. To
set the place yourself:

```bash
herald-os weather location --set Melbourne     # a city, an airport code, or ~a landmark
herald-os weather location --clear             # back to automatic
herald-os weather                              # the weather now
```

Or ask Hermes: "what's the weather like?"

## On a Mac

These commands are part of Herald OS Linux. On a Mac, ask Hermes, or make an automation for anything
that repeats.
