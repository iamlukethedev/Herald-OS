# Hotkeys

On Herald OS Linux the system key is `Super` (the Windows or Command key); in the virtual machine on
a Mac it is `Alt` instead, because macOS keeps `Command` for itself. `Super+K` shows every Linux
shortcut on screen. Herald's own pages also answer to `Ctrl` on Linux, so `Ctrl+K` and `Ctrl+1`
work everywhere.

## Hermes and Herald OS

| Action | macOS | Herald OS Linux |
| --- | --- | --- |
| Command bar | `Cmd+K` | `Super+Shift+Space` or `Ctrl+K` |
| All applications | `Cmd+Shift+A` | `Super+A` |
| Talk to Hermes | `Alt+Space` | `Super+V` |
| Go to the approval or question Hermes is waiting on | `Cmd+Option+A` | `Super+Shift+A` |
| Dictate into any app (again, or a pause, to finish) | `Cmd+Ctrl+X` | `Super+Ctrl+X` |
| Emoji, typed into any app | `Cmd+Ctrl+E` | `Super+Ctrl+E` |
| Put the desktop pet away, or bring it back | `Cmd+Ctrl+H` | `Super+Ctrl+H` |
| Ask about part of the screen | `Cmd+Shift+S` | `Super+Shift+S` |
| Ask about the focused window | | `Super+Space` |
| Screenshot of the whole screen, to Hermes | | `Super+Ctrl+Shift+S` |
| Herald OS menu: apps, themes, updates | | `Super+M` or `Super+Alt+Space` |
| Show these hotkeys | | `Super+K` |
| Overview, Hermes, Missions, Memory, Files, Automations, Connections | `Cmd+1` ... `Cmd+7` | `Ctrl+1` ... `Ctrl+7` |
| Settings | `Cmd+,` | `Super+,` |
| Terminal | `Cmd+8` | `Super+Return` |
| Files | | `Super+E` |
| Browser | | `Super+Shift+Return` |
| System monitor | | `Super+I` |
| Missions | | `Super+Shift+M` |
| The Hermes window | | ``Super+` `` |
| Toggle the sidebar | `Cmd+\` | `Ctrl+\` |
| Clipboard history | | `Super+Ctrl+V` |
| Lock, power menu | | `Super+Ctrl+L`, `Super+Escape` |
| Leave or enter fullscreen, quit | `Cmd+Ctrl+F`, `Cmd+Q` | `Super+Shift+Escape` quits the session |

## Windows (Herald OS Linux)

| Action | Keys |
| --- | --- |
| Close the window | `Super+Q` |
| Focus left, right, down, up | `Super+H`, `Super+L`, `Super+J`, `Super+U` or the arrow keys |
| Move the window | `Super+Shift` with the same keys |
| Make the column wide, fullscreen | `Super+F`, `Super+Shift+F` |
| Float or tile the window | `Super+T` |
| Tabs in a column, centre the column | `Super+W`, `Super+C` |
| Overview of every window | `Super+O` |
| Column width presets, narrower, wider | `Super+R`, `Super+Minus`, `Super+Equal` |
| Spaces: Personal, Work, Ideas | `Super+1`, `Super+2`, `Super+3` (with `Shift` to move the window there) |
| Previous window | `Super+Tab` |

## Quick panels and switches (Herald OS Linux)

| Action | Keys |
| --- | --- |
| Wi-Fi, Bluetooth, sound | `Super+Ctrl+W`, `Super+Ctrl+B`, `Super+Ctrl+A` |
| Displays, battery and power | `Super+Ctrl+D`, `Super+Ctrl+P` |
| Night light, stay awake, do not disturb | `Super+Ctrl+N`, `Super+Ctrl+I`, `Super+Ctrl+,` |
| Turn the screens off | `Super+Shift+P` |

## Capture (Herald OS Linux)

| Action | Keys |
| --- | --- |
| Screenshot of a selection | `Print` |
| Screenshot of the window, of the screen | `Super+Print`, `Super+Shift+Print` |
| Record the screen (again to stop) | `Super+Alt+Print` |
| Pick a colour from the screen | `Super+Ctrl+Print` |
| Ask Hermes about part of the screen | `Super+Shift+S` |

## The Terminal

In Herald's Terminal, `Ctrl+C` stops the running command, as in any terminal, so copy and paste
add `Shift`. Right-click (or press `Shift+F10` or the keyboard's menu key) for Copy and Paste; Copy
is there once some text is selected. A paste reaches the program as a paste, so an editor or a
shell that tells pasted text from typing still does. Escape sequences and other control characters
are taken out of what you paste, so text copied from a web page cannot end the paste early and run
a command of its own. Text dragged onto the Terminal pastes the same way. Only text is pasted: a
link or a picture dragged from a browser pastes as its address, while a file, or a link from an
app that sends no text with it, can't be dropped, and a notice says so. The Terminal pastes or
copies up to 1 MiB at a time.

| Action | macOS | Herald OS Linux |
| --- | --- | --- |
| Copy the selected text | `Cmd+C` or `Ctrl+Shift+C` | `Ctrl+Shift+C` |
| Paste | `Cmd+V` or `Ctrl+Shift+V` | `Ctrl+Shift+V` or `Shift+Insert` |
| Copy and Paste menu | Right-click, `Shift+F10` | Right-click, `Shift+F10` |
| Stop the running command | `Ctrl+C` | `Ctrl+C` |

## Herald Canvas

The image editor uses the usual photo-editor keys; [the Herald Canvas page](canvas.md#tools) lists
them all. `Cmd` on a Mac is `Ctrl` on Herald OS Linux.

| Action | Keys |
| --- | --- |
| Move, Marquee, Lasso, Magic Wand and Object Select, Crop | `V`, `M`, `L`, `W`, `C` |
| Eyedropper, Spot Healing, Brush, Eraser, Bucket and Gradient | `I`, `J`, `B`, `E`, `G` |
| Type, Shape, Hand, Zoom | `T`, `U`, `H` (or hold `Space`), `Z` |
| Brush size, hardness | `[` and `]`, with `Shift` for hardness |
| Swap colours, reset them | `X`, `D` |
| Free Transform, Merge Down, Group | `Cmd+T`, `Cmd+E`, `Cmd+G` |
| Duplicate (or copy the selection to a layer), Deselect | `Cmd+J`, `Cmd+D` |
| Fit on screen, actual pixels | `Cmd+0`, `Cmd+1` |

## Omarchy keys (Herald OS Linux)

Coming from Omarchy? Settings > General > Keymap, or `herald-os keymap omarchy`, makes `Super+C`,
`Super+X` and `Super+V` copy, cut and paste in every app, terminals included. Talking to Hermes
moves to `Super+Shift+V` and centring a column to `Super+Ctrl+C`; `herald-os keymap herald` switches
back.

## Your own shortcuts

On Herald OS Linux, add binds to `~/.config/niri/local.kdl`, which Herald OS never overwrites; any
`herald-os` command can be a bind, and binding a key Herald OS already uses replaces it.
[Make it yours](make-it-yours.md#keyboard-shortcuts) has examples, including switching a key off,
and Hermes can write them for you: "add a shortcut that opens Obsidian".
