# Coming from Windows

Herald OS Linux replaces Windows on a PC, or sits next to it. Most of what you reach for has a home
here, often on the same `Super` key (the Windows key), and Hermes can do most of it for you if you
just ask. In the virtual machine, `Super` is `Alt` instead (see [Hotkeys](hotkeys.md)).

## Where things went

| You reach for | In Herald OS |
| --- | --- |
| The Start menu | All applications: `Super+A`. Or the command bar, `Super+Shift+Space`: type an app, a file, a command or a question |
| Copilot | Hermes: the command bar, or the voice key `Super+V` |
| File Explorer (`Win+E`) | Files: `Super+E`, or ask "show me the PDFs I downloaded this week" |
| Task Manager (`Ctrl+Shift+Esc`) | The System monitor: `Super+I`, or ask "what is using the most memory?" |
| Settings (`Win+I`) | Settings: `Super+,`; the Herald OS menu (`Super+M`) installs, updates and changes the theme |
| Action Center and quick settings (`Win+A`) | The menu bar's Wi-Fi, Bluetooth, sound and battery icons, and the bell for notifications |
| Snipping Tool (`Win+Shift+S`) | `Print` takes a screenshot of a selection; `Super+Shift+S` selects a region and asks Hermes about it |
| Clipboard history (`Win+V`) | `Super+Ctrl+V` |
| The emoji panel (`Win+.`) | `Super+Ctrl+E`, typed into any app |
| Voice typing (`Win+H`) | Dictation: `Super+Ctrl+X`, speak, pause |
| Lock (`Win+L`) | `Super+Ctrl+L` |
| Alt+F4 | `Super+Q` closes the window |
| Task View (`Win+Tab`) | The overview of every window: `Super+O` |
| Virtual desktops (`Win+Ctrl+Left` and `Right`) | Spaces: `Super+1`, `Super+2`, `Super+3` (Personal, Work, Ideas) |
| Snapping (`Win+Left`, `Win+Up`) | Windows line up by themselves; `Super+Shift+Left` and `Right` move one, `Super+F` makes it wide |
| Night light, Focus | `Super+Ctrl+N`, and do not disturb with `Super+Ctrl+,` |
| The Microsoft Store | Settings > Software, Install in the `Super+M` menu, or ask "install Spotify" |
| Windows Update | Update in the `Super+M` menu, or `herald-os update`; `herald-os rollback` undoes it |
| Windows apps you cannot do without | A Windows 11 virtual machine: [The Windows VM](windows-vm.md) |

`Super+K` shows every key on screen.

## What is different

- **Hermes asks before it changes anything.** Reading is free and opening an app just happens;
  moving, renaming or deleting asks you first, and anything destructive asks every time. Settings >
  Privacy has the rules and the log.
- **You can say what you want instead of finding the button.** "Turn on night light", "switch to the
  Dusk theme", "remind me in 20 minutes to stretch" and "open my last chat about the budget" all
  work from the command bar or by voice.
- **Windows place themselves.** niri, the window manager, lines windows up in scrolling columns
  instead of overlapping them; there is nothing to drag or snap. See
  [Windows and Spaces](windows-and-spaces.md).
- **Apps come from one place.** Installing from Settings > Software or the menu picks the right way
  for your machine (most apps are Flatpaks from Flathub). There are no installers to download.
- **Updates are whole and undoable.** An update installs a complete new version of the system next
  to the one you run; it takes effect at the next restart, and the previous one stays in the boot
  menu.
- **Copy and paste are `Ctrl+C` and `Ctrl+V` in apps,** as on Windows. In the Terminal, where
  `Ctrl+C` stops the running command, they are `Ctrl+Shift+C` and `Ctrl+Shift+V`, or right-click.

## Your files

Copy your Documents, Pictures and the rest from Windows with a USB drive, or over the network with
LocalSend (installed, and allowed through the firewall), and drop them into the same folders in your
home folder.

Give it a week: press `Super+K` whenever you forget a key, and ask Hermes whenever you forget where
something is.
