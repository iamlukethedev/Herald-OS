# The menu bar and quick panels

The menu bar runs along the top of the screen on Herald OS Linux. On the left, a badge says when
Hermes is starting or unreachable; in the middle are your Spaces; on the right are the status icons,
each of which opens a quick panel. On a Mac, the Wi-Fi and Bluetooth panels point you to macOS's
Control Center and the Displays panel to System Settings, which do that work there.

## The status icons

From left to right, as they come: Search (the command bar), Widgets, Voice, the pet, status lights,
plan usage, Wi-Fi, Bluetooth, Sound, Battery (on a laptop), Notifications and the clock.

- **Status lights** appear only while something is on: recording, dictating, do not disturb, stay
  awake or night light. Click one to turn it off or stop it.
- **Plan usage** shows how much of your model plan is used, when you turn it on in Settings > Usage.
- **An update dot** appears when updates are waiting; click it to update.

Settings > Appearance > Menu bar shows, hides and reorders them and sets the clock, or use
`herald-os bar` (see [Make it yours](make-it-yours.md#the-menu-bar)).

## Quick panels

| Panel | Open it | What it does |
| --- | --- | --- |
| Wi-Fi | Click the icon, `Super+Ctrl+W` | Turn Wi-Fi on or off, join a network (with its password), disconnect, forget |
| Bluetooth | `Super+Ctrl+B` | Turn Bluetooth on or off, look for devices, pair, connect and disconnect |
| Sound | `Super+Ctrl+A` | Volume and mute, choose the speakers or headphones and the microphone, see the microphone level |
| Displays | `Super+Ctrl+D` | Brightness, turn each display on or off, its resolution and refresh rate, and scale from 100% to 200% |
| Battery and power | `Super+Ctrl+P` | Charge and time left, and the power profile: Performance, Balanced or Power saver |
| Calendar | Click the clock | A month and today's events |

Each panel's footer opens the matching page of Settings. `herald-os panel wifi` (or `bluetooth`,
`audio`, `display`, `power`, `clock`) opens one from a script or a key of your own.

## The Herald OS menu

`Super+M` (or `Super+Alt+Space`) opens the Herald OS menu, which does the system's chores. Every item
is a `herald-os` command, so Hermes and your scripts can do the same.

| Section | What is in it |
| --- | --- |
| Install, Remove | Apps from the catalog, any Flatpak app, and web apps |
| Update | Herald OS, firmware, and going back to the previous version |
| Style | The theme and the wallpaper |
| Trigger | A reminder, asking about part of the screen, and notices of the time, battery and weather |
| Capture | Screenshots, recording (with the microphone, or the camera bubble), picking a colour, reading a QR code, copying text |
| Toggle | Night light, do not disturb, stay awake, the screensaver |
| System | Lock, suspend, restart, shut down, log out |
| Hermes | Applications, Terminal, Files, Settings and the hotkeys |

Entries of your own go in `~/.config/herald-os/menu.json` and show up in a section called Yours; see
[Make it yours](make-it-yours.md#your-own-menu-entries).

## The Dock

The Dock along the bottom holds your apps. Click one to open it or bring it forward, and right-click
a running one for the list of its windows, with Close and Close all.
