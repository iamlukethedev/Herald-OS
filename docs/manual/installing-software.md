# Installing software

Settings > Software (or Install in the `Super+M` menu on Linux, or just "install Steam") lists what
Herald OS can install in one step: coding agents for the terminal, local models, languages, editors,
terminals, games, a Windows 11 virtual machine, media apps, password managers and web apps. Each one
installs the right way for your machine, and says why when it cannot (Steam needs an x86_64 PC,
Windows needs virtualization). On a Mac the list is the coding agents and the local model apps.

## The catalog

| Group | What is in it |
| --- | --- |
| AI | Claude Code, Codex, OpenCode, Gemini CLI, Copilot CLI, Ollama and LM Studio ([Coding agents and local models](coding-agents.md)) |
| Developer | mise, Node, Bun, Deno, Python, Go, Rust, Ruby and Rails, PHP and Laravel, Java, Elixir, .NET, Zig, Podman, lazydocker |
| Editors | VS Code, Zed, Sublime Text, Neovim, Helix, Emacs |
| Terminals | Ghostty, Alacritty, Kitty |
| Gaming | Steam, Lutris, Heroic, RetroArch, Prism Launcher, Moonlight, GeForce NOW, Xbox Cloud Gaming ([Games](games.md)) |
| Windows | A Windows 11 virtual machine ([The Windows VM](windows-vm.md)) |
| Media and office | OBS, Kdenlive, mpv, Pinta, Video Trimmer, Snapshot, Xournal++, Déjà Dup |
| Services | 1Password, Bitwarden, Dropbox, Tailscale |
| Web apps | Basecamp, Google Photos, Maps and Contacts, Zoom, Discord, Grok ([Web apps](web-apps.md)) |

Each entry has **Install** or **Remove**, and **Open** for the ones that run in a terminal. From a
terminal, `herald-os catalog list` shows the catalog (`--group gaming` for one group) and
`herald-os install steam` or `herald-os remove steam` does the same as the buttons.

## Any other app

Anything on [Flathub](https://flathub.org) installs too: Install > App… in the Herald OS menu, or
`herald-os install app obsidian` (a name or a Flatpak id such as `md.obsidian.Obsidian`), or ask
"install Obsidian". `herald-os remove app obsidian` takes it out. On Fedora and Arch with Herald OS
as a package, `herald-os install app` uses the system's own packages when they have the app.

## What comes installed

Every Herald OS Linux install starts with a curated set: Firefox, Files (Nautilus), Text Editor,
LibreOffice, Loupe, Papers, Calculator, Calendar, VLC and developer tools; Obsidian, Spotify,
LocalSend, VS Code and Signal from Flathub; and web apps for HEY, Google Calendar, Google Messages,
WhatsApp, X, YouTube, ChatGPT and GitHub. `herald-os omakase list` shows it, and
`herald-os omakase install` puts back anything you removed.

## How it installs

Each entry knows several ways to install, in order: Flatpak, the system's packages (dnf, pacman, the
AUR), npm, mise, its own recipe, a web app, or a download page. The first one your machine can use
wins. On the Herald OS image the system itself only changes by a whole update, so apps come as
Flatpaks or go into your home folder (`~/.local`), and need no administrator password.

Installed apps appear in Applications (`Super+A`) and the command bar. They update with the rest of
the system: see [Updates, channels and rollback](updates.md).
