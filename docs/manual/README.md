# The Herald OS manual

Herald OS is an operating system built around an AI agent, Hermes. You talk or type to it, and it
works across the whole machine: it opens apps, finds and organises files, keeps an eye on what is
running, remembers what matters to you, runs routines, and builds software while you watch. Anything
that changes something asks first.

This manual is for using Herald OS day to day. The [README](../../README.md) covers installing it;
[docs/ARCHITECTURE.md](../ARCHITECTURE.md) covers how it is built.

- [Coming from macOS](coming-from-macos.md): where your habits go.
- [Hotkeys](hotkeys.md): every shortcut on macOS and on Herald OS Linux.
- [Make it yours](make-it-yours.md): themes, fonts, widgets, the menu bar, your own menu entries,
  branding, keyboard shortcuts, and hooks and automations that run when something happens.
- [Herald Canvas](canvas.md): the image editor, its tools and AI features, Photoshop files, and
  working on pictures with Hermes.
- [Herald Office](office.md): Herald Docs, Sheets and Slides, the files they open and save,
  printing, and working on documents with Hermes and your voice.
- [The desktop pet](pet.md): Hermes's pet on the desktop, what it shows, approvals, chat and
  dropped files, and keeping it out of the way.
- [Troubleshooting](troubleshooting.md): when something does not work.
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
Herald OS can install in one step: coding agents for the terminal (Claude Code, Codex, OpenCode,
Gemini CLI, Copilot CLI), local models with Ollama and LM Studio, languages (Node, Python, Go, Rust,
Ruby and Rails, PHP and Laravel, and more), editors, terminals, games, a Windows 11 virtual machine,
media apps, password managers and web apps. Each one installs the right way for your machine, and
says why when it cannot (Steam needs an x86_64 PC, Windows needs virtualization). On a Mac the list
is the coding agents and local model apps.

- **Coding agents** open from the Terminal's new-tab menu (the arrow next to `+`).
- **Local models:** once Ollama or LM Studio has a model, "Use with Hermes" makes Hermes use it.
- **Windows** asks how much memory, how many cores and how much disk to give it, installs itself in
  10 to 20 minutes, and shares `~/Windows` with your files. Open it from Applications.

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
