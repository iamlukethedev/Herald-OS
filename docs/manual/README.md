# The Herald OS manual

Herald OS is an operating system built around an AI agent, Hermes. You talk or type to it, and it
works across the whole machine: it opens apps, finds and organises files, keeps an eye on what is
running, remembers what matters to you, runs routines, and builds software while you watch. Anything
that changes something asks first.

This manual is for installing and using Herald OS day to day.
[docs/ARCHITECTURE.md](../ARCHITECTURE.md) covers how it is built, and [docs/LINUX.md](../LINUX.md)
how Herald OS Linux is put together.

## Chapters

### Getting started

- [Installing on a PC](install-pc.md): the installer, the USB stick, Secure Boot, encryption, dual
  boot, and the disk password.
- [Installing on a Mac](install-mac.md): the app, Hermes Agent and macOS's permissions.
- [Trying it in a virtual machine](virtual-machine.md): on a Mac, on Windows or on Linux.
- [Setting it up for someone else, and reset](setup-and-reset.md): the first-start setup, handing a
  computer over, and starting again.
- [Unattended installs](unattended-installs.md): installing several PCs from a kickstart.

### Moving over

- [Coming from macOS](coming-from-macos.md): where your habits go.
- [Coming from Windows](coming-from-windows.md): the same, for Windows.
- [Windows and Spaces](windows-and-spaces.md): niri's columns, floating windows and the overview.

### The desktop

- [The menu bar and quick panels](menu-bar.md): the status icons, Wi-Fi, Bluetooth, sound and
  display panels, the Herald OS menu and the Dock.
- [Notifications and do not disturb](notifications.md).
- [Clipboard history](clipboard.md).
- [Screenshots, recording, text and QR codes](capture.md).
- [Dictation and emoji](dictation-and-emoji.md): typing by voice, and emoji, in any app.
- [Reminders, notices and weather](reminders.md).
- [Lock screen, idle and the screensaver](lock-and-idle.md): locking, stay awake, night light.
- [Hotkeys](hotkeys.md): every shortcut on macOS and on Herald OS Linux.
- [Make it yours](make-it-yours.md): themes, fonts, the language, widgets, the menu bar, your own
  menu entries, branding, keyboard shortcuts, and hooks and automations that run when something
  happens.

### Hermes

- [Talking to Hermes](talking-to-hermes.md): the command bar, conversations, approvals and voice.
- [Missions](missions.md): bigger jobs Hermes plans and works through.
- [Memory](memory.md): what Hermes knows about you, and why.
- [Automations](automations.md): on a schedule, or when something happens.
- [Connections](connections.md): MCP servers, messaging platforms and accounts.
- [Studio](studio.md): watching Hermes build software.
- [Usage](usage.md): what your model plan has used.
- [Privacy and the audit log](privacy.md): permission tiers, protected folders and the log.
- [Crash help](crash-help.md): Hermes explains crashes.
- [The desktop pet](pet.md): Hermes's pet on the desktop, what it shows, approvals, chat and
  dropped files, and keeping it out of the way.
- [The Pet Room](room.md): every conversation, mission, helper and automation Hermes is working on
  as a pet of its own, at the tool it uses or the desk of its document, with its approvals and what
  is true about it; also as your screensaver.

### Apps

- [Installing software](installing-software.md): the catalog, any Flatpak app, and what comes
  installed.
- [Web apps](web-apps.md): websites in windows of their own.
- [Games](games.md): Steam, Lutris, Heroic and the rest.
- [The Windows VM](windows-vm.md): Windows 11 in a window.
- [Coding agents and local models](coding-agents.md): Claude Code, Codex and others, Ollama and LM
  Studio.
- [Herald Canvas](canvas.md): the image editor, its tools and AI features, Photoshop files, and
  working on pictures with Hermes.
- [Herald Office](office.md): Herald Docs, Sheets and Slides, the files they open and save,
  printing, and working on documents with Hermes and your voice.
- [Herald Calc](calc.md): the sentence notepad, currencies and time zones, graphs, the keypads,
  the history, and math with Hermes and your voice.

### The system

- [Updates, channels and rollback](updates.md).
- [Security](security.md): the firewall, SSH, fingerprints and security keys, encryption.
- [The `herald-os` command line](command-line.md): every hotkey and menu item as a command.
- [Running inside Omarchy](omarchy.md).
- [Arch and other Linux](other-linux.md): the Arch package and the tarball.

### Help

- [Troubleshooting](troubleshooting.md): when something does not work, a bad update, a locked-out
  account, Wi-Fi, Bluetooth, sound, and the size of things.
- [FAQ](faq.md): short answers to common questions.

## The first five minutes

1. **Say hello.** Press `Cmd+K` on a Mac or `Super+Shift+Space` on Herald OS Linux and type what
   you want, or press the voice key (`Alt+Space` on a Mac, `Super+V` on Linux) and say it.
2. **Let Hermes catch you up.** The Overview offers to look at the names of your recent files,
   projects and chats and suggest where to pick up. It is off until you turn it on.
3. **Make it look like yours.** Settings > Appearance has twelve themes, and "Make a theme from an
   image" turns any photo into one. Or just ask: "make me a calm green theme".
4. **Hand Hermes a chore.** "Every weekday at 9, tell me what is on my calendar" becomes an
   automation; "every time I log in, check my disk space" runs whenever you log in.
5. **Look at what Hermes did.** Settings > Privacy has the audit log of every system action, and
   Settings > Usage shows how much your model plan has used.

## Talking to your other bots

Every Hermes profile is a bot: it has its own memory, skills, model and conversations, and Hermes
Desktop's Bot Mode gives it a name and a picture. Hermes itself is the default profile. Once you
have more than one, you choose who a conversation is with.

- **Start a conversation with a bot.** On the Hermes page, the bot's picture beside New
  conversation opens the list of your bots, Hermes first; on the Overview, the bot's name in front
  of Plan my day does the same. Choosing one starts a new conversation with it (the Bot Chat it
  has in Hermes Desktop stays in its session list), and New conversation keeps that bot until you
  choose another. "Talk to Alfred", typed in the command bar or said, does the same, and "which
  bots do I have" lists them.
- **See who you are talking to.** The conversation shows the bot's name and picture, and the
  message box says who it asks.
- **Each bot keeps its own conversations.** Sessions… on the Hermes page lists those of the bot on
  screen, and its name at the top of the list switches to another bot's.
- **What stays with Hermes.** The chats Herald OS starts for its own features run as Hermes: the
  desktop pet, Ask Hermes in Herald Office, missions, Studio and crash help. Buttons elsewhere that
  ask Hermes something (Plan my day, Find files, the command bar's Ask Hermes, voice) go to the
  conversation on screen, whoever it is with, and start one with Hermes when none is open.
  Missions and the command bar's recent sessions show Hermes's conversations only.
- **Not yet.** Herald OS sets its system tools (files, apps, settings) up for Hermes, so a bot has
  them only when its profile has the `herald-os-bridge` plugin. Voice speaks a bot's replies in
  Hermes's voice.

## Installing software

Settings > Software (or Install in the `Super+M` menu on Linux, or just "install Steam") lists what
Herald OS can install in one step: coding agents, local models, languages, editors, terminals,
games, a Windows 11 virtual machine, media apps, password managers and web apps. Each one installs
the right way for your machine, and says why when it cannot. [Installing software](installing-software.md)
has the whole catalog; [Coding agents and local models](coding-agents.md),
[Games](games.md) and [The Windows VM](windows-vm.md) have more on each.

## Finding and filing documents

Downloads fills up with files called scan0001.pdf and document(3).pdf. Ask Hermes, typed or spoken:
"find the invoice from Acme in my Downloads, rename it properly and put it where it belongs", or
open the folder in Files and say "file the invoices in this folder".

- Hermes reads the documents themselves, scans and photos included (the text is recognised on this
  computer; nothing is uploaded), and tells invoices from receipts, statements and everything else.
- It names files the way your filed documents are already named, or like
  `2026-09-14 Acme Corp invoice INV-1234 $560.00.pdf` when there is nothing to follow, and puts them
  in the folder you already use (Invoices by year, say). It asks before creating new folders.
- You see the plan first and approve it on the card. Nothing is overwritten, duplicates are pointed
  out, and "undo that" puts everything back.
- On Herald OS Linux, scans are read with tesseract, which is installed; `poppler-utils` makes text
  PDFs faster to read but is optional.

## Asking about what is on screen, and typing anywhere

- **Dictation:** `Cmd+Ctrl+X` (Mac) or `Super+Ctrl+X` (Linux) in any app, speak, pause, and the
  words are typed where the cursor is. Say "comma", "new line" or "press enter".
- **Emoji:** `Super+Ctrl+E` on Linux, `Cmd+Ctrl+E` on a Mac, in any app: search, press Return,
  and the emoji is typed where you were.
- **Colours, QR codes and text on screen:** "pick a colour", "read this QR code" or "copy the text
  on screen" (the command bar, or ask Hermes). The colour picker copies `#rrggbb`; the other two ask
  you to select the area and copy what they read. On a Mac they use macOS's own eyedropper and text
  recognition.
- **Part of the screen:** `Cmd+Shift+S` (Mac) or `Super+Shift+S` (Linux), drag a rectangle, then
  type your question. The selection goes to Hermes as an image.
- **The window in front (Linux):** `Super+Space` asks about the focused window.
- **A crash:** when a program crashes, a notification offers "Ask Hermes". Hermes reads the crash
  report and tells you, in plain words, what went wrong and whether it is worth reporting. Mute a
  program from the same notification if you do not care about it.
