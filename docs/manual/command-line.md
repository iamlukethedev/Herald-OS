# The `herald-os` command line

On Herald OS Linux, everything the hotkeys and menus do is a `herald-os` command, so you, Hermes and
your scripts drive the system the same way. Any of them can be a key of your own (see
[Make it yours](make-it-yours.md#keyboard-shortcuts)). `herald-os commands` lists every command,
`herald-os --help` shows them grouped, and `herald-os debug` prints what a bug report needs.

## Hermes and the desktop

| Command | What it does |
| --- | --- |
| `herald-os ask [text]` | Ask Hermes about the focused window, or about the text |
| `herald-os command` | Open the command bar |
| `herald-os voice` | Start or end a voice conversation |
| `herald-os applications` | Open Applications |
| `herald-os page missions` | Show a page: `overview`, `hermes`, `missions`, `memory`, `files`, `automations`, `connections`, `settings` |
| `herald-os open terminal` | Open the Terminal, or `system` for the System monitor |
| `herald-os launch firefox` | Start an installed app |
| `herald-os menu` | Open the Herald OS menu |
| `herald-os panel wifi` | Open a quick panel: `wifi`, `bluetooth`, `audio`, `display`, `power`, `clock` |
| `herald-os os <command.id> [json]` | Run any Herald OS command, the same ones Hermes uses |

## Software and updates

| Command | What it does |
| --- | --- |
| `herald-os install <id>` | Install from the catalog; `herald-os catalog list` shows it |
| `herald-os install app <name>` | Install any Flatpak app |
| `herald-os install webapp <name> <url>` | Make a web app |
| `herald-os remove …` | The same, the other way |
| `herald-os windows status` | The Windows VM: `start`, `stop`, `connect`, `remove` |
| `herald-os update` | Update everything (`--check` only reports) |
| `herald-os channel [stable\|edge]` | Show or change the update channel |
| `herald-os rollback` | Go back to the previous version |
| `herald-os firmware [check\|update]` | Firmware updates |
| `herald-os omakase install` | Put back the apps every install starts with |

## The look

| Command | What it does |
| --- | --- |
| `herald-os theme set <name>` | Change the theme (`theme list` shows them) |
| `herald-os font set <family>` | The interface font (`--mono` for the code font) |
| `herald-os wallpaper <image>` | Set the wallpaper |
| `herald-os bar` | Show, hide and move menu-bar items, and set the clock |
| `herald-os branding set` | Your logo and name in About, your picture on the lock screen |
| `herald-os plugin list` | Widgets: `add`, `enable`, `disable`, `update`, `remove` |
| `herald-os keymap omarchy` | Omarchy's copy and paste keys (`keymap herald` switches back) |

## Everyday

| Command | What it does |
| --- | --- |
| `herald-os capture screenshot` | Screenshots, recording, colours, QR codes and text ([Screenshots, recording, text and QR codes](capture.md)) |
| `herald-os clipboard` | Clipboard history |
| `herald-os dictate`, `herald-os emoji` | Dictation and the emoji picker |
| `herald-os reminder 20m stretch` | A reminder (`reminder list`, `reminder clear`) |
| `herald-os notify <title> [body]` | Show a notification |
| `herald-os weather` | The weather (`weather location --set <city>`) |
| `herald-os toggle dnd` | Switch `nightlight`, `dnd`, `idle` (stay awake) or `screensaver` |
| `herald-os idle show` | The idle timings (`idle set lock=10`) |
| `herald-os crash list` | Recent crashes (`crash diagnose`, `crash mute`) |
| `herald-os hook list` | Scripts that run when something happens |
| `herald-os event <name>` | Report an event, so hooks and event automations run |

## The system

| Command | What it does |
| --- | --- |
| `herald-os lock` | Lock the screen |
| `herald-os password` | Set your password |
| `herald-os suspend`, `herald-os power` | Sleep now, or open the power menu |
| `herald-os setup` | Once per account on Arch or the tarball: Hermes Agent and Herald's tools (`herald-os setup --undo` takes them back) |
| `herald-os setup fingerprint` | Fingerprint sign-in (`setup fido2` for a security key) |
| `herald-os reset` | Erase this computer's account and start setup again |
| `herald-os omarchy install` | Run Herald OS inside Omarchy |
| `herald-os wm <action>` | A window-manager action, such as `wm toggle-overview` |
| `herald-os state`, `herald-os debug` | Diagnostics |

## In scripts

Commands that act on the desktop talk to the running Herald OS over its control socket, so they need
a session to be running; system chores (install, update, reminders) work without one. The
`herald-os os` command takes the ids Hermes uses, for example
`herald-os os page.open '{"name": "missions"}'`.
