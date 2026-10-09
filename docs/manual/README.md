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
