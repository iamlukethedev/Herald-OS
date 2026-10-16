# Make it yours

## Themes

A theme recolours everything at once: the shell, the in-shell terminal, the wallpaper's colours,
Hermes's own command-line skin and, on Herald OS Linux, the window borders, GTK apps, the lock
screen and the rescue terminal. Settings > Appearance shows every theme as a card; click one. Or say
"switch to the Paper theme".

Herald OS ships twelve: Ocean (the default), Graphite, Ice, Violet, Ember, Forest, Dusk, Onyx (true
black), Rose, Lagoon, and two light ones, Paper and Cloud.

- **From an image.** "Make a theme from an image" in Settings, or "make a theme from my
  wallpaper", takes the colours of a photo or artwork, builds a complete theme from them and uses
  the image as the wallpaper. On Herald OS Linux, `herald-os theme new <image> [name]` does the same.
- **From a description.** Ask Hermes: "make me a theme that feels like a foggy forest morning". It
  writes the theme file and switches to it.
- **From someone else.** Paste the https address of a theme repository into "Install themes from
  git" (or `herald-os theme install <url>`). Only colours and images are kept, so a theme can never
  run code on your machine.
- **Follow Hermes.** With "Follow Hermes skins" on, changing Hermes's skin with `/skin` in a chat
  restyles Herald OS too.

### Writing a theme by hand

Your themes live in `~/.config/herald-os/themes/<name>/theme.json` on every platform. The name is
the folder name: lowercase letters, digits and dashes.

```json
{
  "name": "sunset",
  "label": "Sunset",
  "description": "Warm dusk orange on deep plum.",
  "shell": { "scheme": "dark" },
  "wallpaper": "default",
  "colors": {
    "bg": "#170d14", "bg2": "#26131f", "surface": "#2e1726",
    "fg": "#fbefe9", "fg_dim": "#c4a0a4",
    "accent": "#ff8a4c", "accent_strong": "#ffa36e",
    "border_active": "#ff8a4c", "border_inactive": "#3e1f30",
    "urgent": "#ff6b6b", "ok": "#5fd39a", "warn": "#f2c25e"
  },
  "gtk": { "color_scheme": "prefer-dark", "theme": "Adwaita-dark" }
}
```

Every colour is `#rrggbb`. Keep text (`fg`) at 7:1 contrast or more against `bg` and the accent at
3:1 or more. A light theme sets `"scheme": "light"` and `"gtk": {"color_scheme": "default",
"theme": "Adwaita"}`. `"wallpaper"` is `"default"` (the drawn wallpaper, tinted to the theme) or an
image file in the theme's folder. An optional `"terminal"` block sets the terminal's 16 colours.

To share a theme, put its folder (or several, one per theme) in a git repository.

## Fonts

Settings > Appearance > Fonts sets the interface font and the code font (the terminal and code
views); leave a field empty for the default. "Use the font Inter" works too. On Herald OS Linux,
`herald-os font list` shows what is installed and `herald-os font set <family> [--mono]` sets it.

## Language

Settings > General > Language shows Herald OS in English, in Brazilian Portuguese (Português
(Brasil)) or in Simplified Chinese (简体中文), each listed under its own name, and the change takes
effect at once. Until you pick one it follows the system: the first of your preferred languages (on
a Mac, System Settings > General > Language & Region) that Herald has. Any Portuguese (Portugal's,
Angola's) shows Brazilian Portuguese, and Traditional Chinese shows English for now. "Switch to
Portuguese", "switch to Chinese", "use English" and "use the system language" work too; the voice
phrases stay in English.

The menus Herald builds, the menu bar, the Overview, the command bar, the notifications panel and
Settings' sections and General page are translated so far; the rest is still in English and follows
as it is translated ([docs/TRANSLATING.md](../TRANSLATING.md) says how to help). Dates and times
follow the language you pick. Hermes answers in the language you write to it in. The macOS menu
bar's own menu (Herald OS, Edit, Window) stays in English for now.

## Widgets

Widgets are small pages Herald OS shows in the menu bar, on the Overview or in a window of their
own: a CPU meter, the weather, a countdown to Friday. Each one is sealed off from the rest of the
system and can do only what you allowed when you turned it on.

- **Ask Hermes for one.** "Make me a widget that shows the weather in the menu bar". Settings >
  Plugins > Make a widget starts the sentence for you. Hermes writes it into your plugins folder,
  and you turn it on.
- **Install one.** Paste a git address into Settings > Plugins > From git (on Herald OS Linux,
  `herald-os plugin add <url>`). It arrives turned off.
- **Turn it on.** Flip its switch in Settings > Plugins. Herald OS lists what it will be able to do
  (see system stats, show notifications, keep its own settings, run a named Herald OS command,
  connect to a named website) and turns it on only when you agree. If an update asks for more, it
  turns itself off until you agree again.
- **Open one in a window.** Widgets that can live in a window have an Open button in Settings >
  Plugins, or say "open the System meter widget".
- **Remove one.** Remove in Settings > Plugins turns it off and moves its folder to the Trash.

### Writing a widget

A widget is a folder, `~/.config/herald-os/plugins/<id>/`, with a `manifest.json` and web files.
[examples/widgets/system-meter](../../examples/widgets/system-meter) is a complete one:

```json
{
  "id": "system-meter",
  "name": "System meter",
  "version": "1.0.0",
  "description": "CPU and memory at a glance.",
  "entry": "index.html",
  "placement": ["menubar", "overview", "panel"],
  "size": { "width": 150, "height": 96 },
  "permissions": ["stats"],
  "hosts": []
}
```

- `id` is lowercase letters, digits and dashes, and is also the folder's name.
- `placement` is where it may sit: `menubar` (a strip 24 pixels tall and `size.width` wide, up to
  240), `overview` (a card `size.height` tall) and `panel` (its own window).
- `permissions` are `stats` (CPU, memory, disks, battery), `notify`, `storage` (its own small
  settings store) and `run:<command>` for each Herald OS command it may run, such as
  `run:page.open`. A command that changes something still asks you each time.
- `hosts` are the websites it may fetch from, over HTTPS. It can reach nothing else.

The page loads `<script src="herald-plugin://sdk/widget.js"></script>`, then its own script files
(scripts written inline in the page are blocked). The SDK gives it:

- `await herald.stats()`, `herald.notify(title, body)`, `herald.storage.get(key)` and
  `herald.storage.set(key, value)`.
- `herald.run('page.open', { name: 'missions' })` for the commands it was granted.
- `herald.placement` (`menubar`, `overview` or `panel`), also set as `data-placement` on `<html>`
  for your CSS.
- The theme's colours as CSS variables (`--herald-bg`, `--herald-surface`, `--herald-fg`,
  `--herald-fg-dim`, `--herald-accent`, `--herald-line`, `--herald-ok`, `--herald-warn`,
  `--herald-urgent`), and `herald.onTheme(colors => …)` when they change.

While a widget is on, saving any of its files reloads it. It keeps up to 256 KB in its store and
cannot see your files, other apps or the rest of Herald OS. To share it, put the folder in a git
repository. On Herald OS Linux, `herald-os plugin list`, `enable`, `disable`, `update` and `remove`
manage widgets from the terminal; `enable` shows the same list and asks you first.

## The menu bar

Settings > Appearance > Menu bar lists the menu bar's items from left to right. Drag one (or use
its arrows) to move it, and flip its switch to show or hide it. The status lights for recording,
dictation and switches that are on always show, so you can tell when the screen is recorded or
the microphone is typing for you. The same page sets the clock: 12 or 24 hours (or your region's
choice), seconds, and a short, long or no date.

Or ask: "hide the Bluetooth icon", "use a 24-hour clock", "put the clock first". On Herald OS
Linux, `herald-os bar` does the same:

```sh
herald-os bar                          # the items, in order, and which are shown
herald-os bar hide bluetooth
herald-os bar move clock first         # or last, a position (1 is leftmost), before/after an item
herald-os bar clock 24h seconds date none
herald-os bar reset
```

## Your own menu entries

The control menu (`Super+M` on Herald OS Linux) takes entries of your own from
`~/.config/herald-os/menu.json`. Each entry has a label and one thing to do: a `herald-os`
command, a program to start, a web address, or a Herald OS command.

```json
{
  "entries": [
    { "label": "Notes", "hint": "Obsidian", "icon": "notes", "herald-os": ["launch", "obsidian"] },
    { "label": "Back up photos", "group": "trigger", "exec": ["rsync", "-a", "~/Pictures/", "/mnt/backup/Pictures/"] },
    { "label": "Standup doc", "icon": "world", "url": "https://docs.example.com/standup" },
    { "label": "Missions", "command": "page.open", "args": { "name": "missions" } }
  ]
}
```

- `exec` is the program and its arguments as a list; `~/` means your home folder. It does not go
  through a shell, so pipes and `&&` need a script of their own.
- `group` puts the entry into one of the menu's groups (`install`, `remove`, `update`, `style`,
  `trigger`, `capture`, `toggle`, `system`, `hermes`); without one it goes under Yours.
- `icon` is one of star, app, terminal, world, bolt, folder, notes, music, camera, code, calendar,
  mail, chat, heart, home or rocket.

The menu reads the file every time it opens, so there is nothing to restart. `herald-os menu check`
shows what it understood, and a "menu.json has problems" entry appears under Yours when something
is wrong. Hermes can write the file for you: "add my backup script to the menu".

## Branding

Settings > About > Branding puts your own logo (PNG, JPEG, WebP or SVG) at the top of About, with
a name under it such as your company. On Herald OS Linux it also sets the picture behind the
password on the lock screen (PNG or JPEG). The images are copied, so the originals can move.
On Herald OS Linux, `herald-os branding` does the same:

```sh
herald-os branding set --logo ~/Pictures/acme.svg --name "Acme Corp"
herald-os branding set --lock ~/Pictures/beach.jpg
herald-os branding reset lock              # or logo, name, all
```

## Keyboard shortcuts

On Herald OS Linux, your own binds go in `~/.config/niri/local.kdl`, which Herald OS never
overwrites. niri reloads it as soon as you save:

```kdl
binds {
    Mod+Shift+O hotkey-overlay-title="Obsidian" { spawn "flatpak" "run" "md.obsidian.Obsidian"; }
    Mod+Ctrl+D { spawn "herald-os" "theme" "set" "herald-dusk"; }
}
```

Check a bind is free in the hotkey overlay (`Super+K`) first.

To change one of Herald OS's own keys, bind the same key in `local.kdl`. It is read last, and a
later bind replaces an earlier one. To switch a key off, bind it to nothing, for example
`Mod+Q { spawn "true"; }` so `Super+Q` no longer closes windows. Bind each key only once inside
`local.kdl` itself, because niri refuses a file that binds the same key twice;
`niri validate -c ~/.config/niri/herald-os.kdl` checks it.

Running Herald OS as an app inside Omarchy, its keys live in `~/.config/hypr/herald-os.lua` on
Omarchy 4 (`herald-os.conf` on Omarchy 3), which `herald-os omarchy install` rewrites. Change them in
your own Hyprland config instead. On Omarchy 4, below the `require("hypr.herald-os")` line at the end
of `~/.config/hypr/hyprland.lua`, so it runs after Herald's: `hl.unbind("SUPER + ALT + H")`, then an
`o.bind("SUPER + H", "Herald OS", "herald-os-app")` of your own. On Omarchy 3,
`unbind = SUPER ALT, H`, then a `bind = …` line.

## When something happens

Herald OS notices these moments: you log in, the computer wakes, you unlock the screen, you come
back after a break, the battery runs low, the network changes, a program crashes, the theme
changes, and Herald OS finishes an update (plus locking the screen and going to sleep, for scripts).

### Automations

On the Automations page, a new automation can run "On a schedule" or "When something happens".
For a crash you can name the program, for a network change the Wi-Fi network. Hermes runs it each
time, with the same history and delivery as scheduled automations. Or just ask: "every time I log
in, tell me what is on my calendar".

### Hooks

For chores that need no Hermes (a script, a sound, syncing a folder), drop an executable script into
`~/.config/herald-os/hooks/<event>.d/`, where `<event>` is `login`, `wake`, `unlock`, `returned`,
`battery-low`, `network-change`, `crash`, `theme-set`, `after-update`, `lock` or `sleep`. It runs
with the event name as its first argument and in `HERALD_EVENT`, each detail in its own variable
(`HERALD_EVENT_APP` for a crash, `HERALD_EVENT_PERCENT` for low battery, `HERALD_EVENT_WIFI` for a
network change) and everything as JSON in `HERALD_EVENT_JSON`. Files ending in `.sample` are
skipped, and a hook gets two minutes.

```sh
#!/bin/sh
# ~/.config/herald-os/hooks/battery-low.d/dim
brightnessctl set 30%
```

On Herald OS Linux, `herald-os hook list` shows your hooks, `herald-os hook install <event>
<script>` copies one in, and `herald-os event <name>` sets one off to test it.
