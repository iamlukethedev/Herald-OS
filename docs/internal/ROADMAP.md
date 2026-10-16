# Roadmap

## Alpha 0.1 (macOS, Apple Silicon)

- Fullscreen Hermes-powered environment running on the user's Hermes install.
- Surfaces: Home, Chat, Agents, Tasks, Skills, Files, Apps, Terminal, System, Settings,
  Notifications, global command bar.
- System bridge plugin with permission tiers and audit log.

## Alpha 0.2

Borrowed from the field (see `LANDSCAPE.md` for the source of each):

- Crash and error capture handed to Hermes with a `diagnose-crash` skill (Omarchy).
- Whole-environment themes driven by Hermes skins; agent-authored themes (Omarchy).
- Agent Task Manager: per-session resources, tokens, approvals, stop (OpenNeo).
- Live "Hermes is acting" banner with Interrupt during GUI automation (SomaOS).
- `herald-os-tailor` skill so Hermes can reconfigure Herald OS itself (Omarchy).
- `system_shortcut` tool over macOS Shortcuts / App Intents (Apple).

Also planned:


- Client-side bridge execution for remote/cloud backends (needs a generic plugin server-request
  hook upstream; proposal to be opened against `tui_gateway/contracts/server_requests.py`).
- Projects: bind sessions to folders, open project workspaces from Home.
- Kanban board surface on `/api/plugins/kanban`.
- Voice input through the existing gateway voice methods.

## Beta

- Windows: `HostPlatform`/`HostAdapter` implementations (PowerShell, `Get-Process`, Everything or
  Windows Search for file search), NSIS installer.
- Signed and notarized macOS builds; auto-update channel.

## Herald OS Linux

No custom kernel at any stage. See `docs/LINUX.md` and ADR-012.

**Stage 1 (done): the session.** Fedora Cloud image + cloud-init, `greetd` autologin, `cage`
compositor, Electron shell in kiosk mode, Linux `HostPlatform` and `HostAdapter`
(`ps`, `ss`, `nmcli`, `wpctl`, `gio`, `journalctl`, `plocate`, `.desktop` entries). Runs in a VM
on the Mac (QEMU or UTM).

**Stage 2: Hermes owns the capability layer.**
- Capability broker: a small privileged D-Bus service holding the permission tiers, issuing
  mission-scoped grants, implementing the `xdg-desktop-portal` interfaces, and owning the audit
  journal. Shell and bridge route every privileged call through it (no enforcement at first).
- Confine the shell and the runtime (bubblewrap/Flatpak-style sandbox, Landlock, seccomp).
- Own wlroots compositor: foreign app windows inside Hermes windows, secure approval prompts drawn
  outside the shell, output power management.
- `hermes serve` as a systemd user unit on a Unix socket with peer credentials.
- SELinux policy for the session.

**Stage 3 (under way, ADR-018): a distribution.** Fedora bootc images: an x86_64 installer ISO
(optional encryption, dual boot, unattended through kickstart) and an aarch64 VM image, `bootc
upgrade` and `bootc rollback` behind `herald-os update` and `herald-os rollback`, first-boot setup and
reset, firewall and SSH off by default, fingerprint and security-key sign-in, firmware updates,
signed images, an NVIDIA image (ADR-029) and laptop Wi-Fi and sound firmware. Still to come: a
recovery partition, an NVIDIA installer ISO, Fedora Asahi for M1 and M2.
Apple Silicon M3 and later stay VM-only until Asahi covers them.

## Arch and Omarchy (ADR-017)

Fedora stays the base of Herald OS Linux; Arch gets a package. One Linux release tarball per
architecture feeds both the Fedora images and `packaging/arch/` (`herald-os-bin`, `herald-os-git`).
On Arch, Herald OS runs as its own session on niri or in app mode inside Hyprland, where it follows
the Omarchy theme and defers updates to `omarchy update`. The AUR package is published only when the
repository goes public.

## Omarchy parity (October 2026)

What Omarchy has that Herald OS lacked, in the order it is being built:

1. Agent features on both platforms: crash help, "make it yours" themes and the tailoring skill,
   asking about a screen region, a usage view, event-triggered automations and hooks, a notarized
   Mac build and a short manual.
2. Linux desktop basics: Wi-Fi, Bluetooth, audio, display and power panels; night light, do not
   disturb, stay awake and the screensaver; the capture suite; dictation into any app.
3. An install catalog: other agent CLIs, local models, developer stacks, editors, terminals,
   games, a Windows VM, media and office apps, services and web apps.
4. Arch and Omarchy support (above).
5. The distribution (Stage 3, above).
6. Sandboxed widget plugins (ADR-019), menu bar layout, menu extensions and branding.
