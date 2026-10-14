# Herald OS Linux

Herald OS as a whole operating system: a Fedora base, greetd signing you in, niri arranging the
windows, the Herald shell drawing the menu bar, dock and system menus, and Hermes Agent underneath.
Today it installs on x86_64 PCs from the installer ISO in the v0.1.0-alpha.4 release (tested in a
virtual machine in CI, not yet on real PC hardware), runs as an app inside Omarchy, and on an Apple
Silicon Mac (aarch64) runs in a virtual machine for trying it and for development; nothing on the
Mac changes.

This page is about how Herald OS Linux is built and how to develop it. For using it, see
[the manual](manual/README.md): [installing on a PC](manual/install-pc.md), [trying it in a virtual
machine](manual/virtual-machine.md), [setup and reset](manual/setup-and-reset.md), [the menu bar and
quick panels](manual/menu-bar.md), [installing software](manual/installing-software.md),
[updates and rollback](manual/updates.md), [security](manual/security.md) and
[the `herald-os` command line](manual/command-line.md).

```
kernel + systemd  ->  greetd (autologin/login*)   ->  niri  ->  Herald OS shell  ->  hermes serve
                                                                      |                    |
                                                          HostPlatform (linux.ts)   herald-os-bridge (LinuxHost)
                                                                      \__________  ps ss nmcli wpctl gio journalctl plocate
```

\* greetd signs `hermes` in by itself on an image install and in the development VM. On a system
switched from another bootc system it shows a login screen (agreety) instead, and the session starts
for whoever signs in, unless no account there can sign in, when `hermes` signs in by itself without
a password, outside `wheel` ([Switching a bootc system to Herald OS](#switching-a-bootc-system-to-herald-os)).

## Quick start (QEMU, all from the terminal)

```bash
brew install qemu                       # once
bash linux/vm/download-image.sh         # Fedora Cloud Base aarch64 qcow2 (~500 MB)
bash linux/vm/make-seed.sh              # cloud-init seed + SSH key (linux/vm/build/)
bash linux/vm/run-qemu.sh               # boots; first boot provisions (30-45 min, mostly downloads)
bash linux/vm/run-qemu.sh console       # watch it; wait for "==> Provisioning complete"
bash linux/dev/push.sh                  # push the repo, build the shell, start Herald OS
```

A QEMU window appears on the Mac. After provisioning and the first push, the VM starts Herald OS
with no login prompt, and every later boot goes straight to it. `bash linux/vm/run-qemu.sh
stop|status|reset` manage it.

Window size: QEMU shows guest pixels 1:1 with the Mac's device pixels. The framebuffer defaults to
the main display's width and its height minus the menu and title bars (3024x1820 on a 14-inch
MacBook Pro), so the window fills the screen; override with `GUEST_W`/`GUEST_H`. On Retina, set
`HERALD_OS_SCALE=2` in `session.env` and `scale 2` in `~/.config/niri/local.kdl` so the desktop
matches Mac apps in size. View -> Zoom To Fit in QEMU's menu still works (toggle it after boot;
enabling it at launch makes the guest adopt the initial window size).

### Signing Hermes in

Hermes in the VM starts signed out. Sign it in from the card Herald OS shows (a short code you
confirm on any device), choose another provider or paste an API key under Settings > Hermes &
agents > Model provider, or set it up from a shell in the VM:

```bash
bash linux/dev/push.sh ssh
hermes setup          # any provider, including API keys; `hermes portal` for Nous Portal only
```

`--with-hermes-config` copies `~/.hermes/{config.yaml,.env}` (model choice and any API keys) into
the VM. It deliberately does not copy `auth.json`: OAuth providers (Nous Portal, Codex, Copilot)
use rotating refresh tokens, so a copied login works only until the next refresh and whichever
machine refreshes second is logged out. (`--with-hermes-auth` copies it anyway, for short
experiments where that trade-off is fine.)

To use the Mac's Nous Portal sign-in without copying it, run Hermes's subscription proxy on the Mac
and point the VM at it. The credentials stay on the Mac, which is the only machine that refreshes
them:

```bash
hermes proxy start                       # on the Mac; serves http://127.0.0.1:8645/v1
bash linux/dev/push.sh ssh               # then, in the VM:
hermes config set model.provider custom
hermes config set model.base_url http://10.0.2.2:8645/v1   # QEMU's address for the Mac
hermes config set model.api_key proxy    # any value; the proxy attaches the real token
hermes config set model.default <model>  # a Portal model id, as in the Mac's config.yaml
```

## Quick start (UTM, a nicer window)

1. `brew install --cask utm`. Run `download-image.sh` and `make-seed.sh` as above.
2. UTM: Create a New Virtual Machine, Virtualize, Linux. Tick "Use Apple Virtualization".
   Boot from `linux/vm/build/fedora-cloud-44-aarch64.qcow2` (import the disk; UTM converts it).
   4 cores, 8 GB, "Enable hardware OpenGL acceleration".
3. Add a second drive from `linux/vm/build/cidata.iso` (read-only, removable).
4. Sharing: add a VirtioFS shared directory pointing at this repo, tag `herald-os`.
5. Network: emulated VLAN with a port forward, guest 22 -> host 2222 (or use Bridged and set
   `HERALD_VM_HOST=<vm-ip>` for the scripts).
6. Boot. cloud-init mounts the share at `/mnt/herald-os`, provisions, builds the shell from the
   share, and greetd starts the desktop. Later, inside the VM, `herald-os-sync` re-syncs and
   rebuilds from the share; from the Mac `bash linux/dev/push.sh` works too.

## What provisioning does (`linux/provision.sh`)

- SELinux permissive (greetd and the compositors have no tailored policy yet; Stage 2 writes one).
- `dnf install`: niri, cage, greetd, seatd, PipeWire, NetworkManager, BlueZ, UPower, portals,
  Electron runtime libraries, fonts, Node.js + toolchain, and the CLI tools the Linux adapters use
  (`xdg-utils`, `gio`, `plocate`, `fd`, `rsvg-convert`, `notify-send`, `grim`), plus Firefox,
  Nautilus, Text Editor and `foot` as a rescue terminal.
- Hermes Agent cloned to `~/.hermes/hermes-agent` at the revision in `upstream/UPSTREAM.lock`,
  installed with upstream's `setup-hermes.sh` (prompts answered "no").
- Session files installed (below); `greetd` enabled; default target `graphical`.
- Dev helpers on the `hermes` user's PATH: `herald-os-build`, `herald-os-sync`,
  `herald-os-restart-shell`, `herald-os-shot`.

## Session model (`linux/session/`)

| Piece | Role |
| --- | --- |
| `/etc/greetd/config.toml` | Logs `hermes` in on VT1 and runs `herald-os-compositor`. Respawns when it exits. On a system switched from another bootc system it is `greetd-login.toml` instead: a login screen (agreety) that starts `herald-os-compositor` for whoever signs in. |
| `herald-os-compositor` | Sets `XDG_*`, picks `WLR_RENDERER=pixman` when there is no GPU render node, sources `~/.config/herald-os/session.env`, renders Herald's niri config (`~/.config/niri/herald-os.kdl`, from the installed template and your keymap) and starts niri with it. A `~/.config/niri/config.kdl` of your own is never read or changed, so the session also starts on a fresh account; Herald's other files beside it are `theme.kdl`, `outputs.kdl` and `local.kdl` (yours to edit). Without hardware GL (QEMU and Apple Virtualization without virgl) niri runs windowed inside `cage` (`herald-os-niri-nested`). `HERALD_OS_COMPOSITOR=cage` runs the Stage 1 kiosk instead. |
| `herald-os-session` | Publishes `WAYLAND_DISPLAY` to systemd/D-Bus, starts PipeWire + portals and the session services below, runs Electron on Wayland (Ozone) as panels: the menu bar, dock and Hermes window are separate windows niri places. Restarts the shell on a crash (5 per minute), exits on a clean quit. |
| `herald-os.desktop` | `wayland-sessions` entry so a normal greeter can also start Herald OS. |

The Hermes backend is still spawned by the shell (`electron/backend/manager.ts`), the same as on
macOS. A systemd unit comes with the Stage 2 broker.

`~/.config/herald-os/session.env` overrides (all optional; changes to this file or to the session
scripts need `sudo systemctl restart greetd`, because the running session loop keeps its old copy):

```
HERALD_OS_SCALE=1.5                          # page zoom for HiDPI framebuffers (1.5 for 2048x1280, 2 for 2880x1800)
HERALD_OS_DEV_SERVER=http://127.0.0.1:5180   # load the Vite dev server instead of dist/
HERALD_OS_REMOTE_DEBUG_PORT=9333             # Chrome DevTools protocol for scripted checks
HERALD_OS_NO_SANDBOX=1                       # if user namespaces are disabled
HERALD_OS_APP=/path/to/apps/desktop          # alternate build location
```

## Dev loop

- **From the Mac**: `bash linux/dev/push.sh` (rsync over SSH, build, restart shell,
  ~30 s). `bash linux/dev/push.sh ssh` opens a shell. `bash linux/dev/shot.sh` grabs a screenshot
  via `grim` into `linux/vm/build/shots/`.
- **Inside the VM** (UTM share): `herald-os-sync`. Logs: `~/.local/state/herald-os/shell.log`,
  `journalctl -u greetd`, `journalctl --user -b`.
- HMR: run `npm run dev:renderer` in an SSH session and set `HERALD_OS_DEV_SERVER` in
  `session.env`, then `herald-os-restart-shell`.

Native modules must be installed on Linux, so the repo is copied (rsync) rather than used in place
from the share; `node_modules`, `dist`, `.git` and the upstream snapshot are excluded and fetched
inside the VM by `scripts/bootstrap.sh`.

## Services (niri session)

How these look to someone using them is in the manual: [the menu bar and quick
panels](manual/menu-bar.md), [clipboard history](manual/clipboard.md), [lock screen, idle and the
screensaver](manual/lock-and-idle.md), [dictation and emoji](manual/dictation-and-emoji.md) and
[hotkeys](manual/hotkeys.md). Underneath:

- **Transient user units** started by `herald-os-session`: `wl-paste --watch cliphist store` (text
  and images) and `herald-os-idle`, which runs `swayidle` with the timings Settings > General writes
  to `~/.config/herald-os/idle.conf` (the idle lock is armed only when the account has a password;
  "stay awake" stops the unit). Night light is `wlsunset` as the `herald-os-nightlight` unit.
- **Notifications** from other apps arrive through the shell's own
  `org.freedesktop.Notifications` daemon.
- **The lock.** The `hermes` VM user has no password by default, so `herald-os lock` refuses until
  you run `herald-os password` in a terminal; a lock nobody can undo would leave the compositor's
  session lock engaged.
- **The control menu** (`Mod+M` or `Mod+Alt+Space`): every item is a `herald-os` command, so the
  agent (`system_os` tool) and scripts can do the same. `Mod` is `Super` on real hardware and `Alt`
  when niri runs nested (the QEMU VM), where `Mod+Alt+Space` is only `Alt+Space` and `Mod+M` is the
  way in.
- **Web apps** (`herald-os install webapp <name> <url>`) open as their own frameless windows.
- **Quick panels** (`herald-os panel wifi|bluetooth|audio|display|power|clock`) are backed by
  `nmcli`, `bluetoothctl`, `pactl`, `niri msg output`, `powerprofilesctl` and `upower`.
- **The Dock menu.** Right-clicking a running app lists its windows in a small window of its own
  above the Dock ("Herald OS · Dock Menu"), as the Dock's window is only 84 pixels tall: the shell
  moves it over the icon through niri before drawing it, and the keys stay with the Dock. Escape, a
  click elsewhere or the keys going to another window close it.
- **Dictation and emoji** (`herald-os dictate`, `herald-os emoji`) type into the focused app with
  `wtype`; dictation transcribes through Hermes's speech-to-text.
- **Keymaps.** `herald-os keymap omarchy` renders `~/.config/niri/herald-os.kdl` from the installed
  template (`linux/niri/config.kdl`) with Omarchy's `Super+C/X/V` copy, cut and paste;
  `herald-os keymap herald` restores Herald's keys. Every session start renders it again, so an
  update's new template takes effect at the next login.

## Themes, omakase, updates

The manual covers these for people using them: [Make it yours](manual/make-it-yours.md),
[Installing software](manual/installing-software.md) and
[Updates, channels and rollback](manual/updates.md).

- **Themes** live in `linux/themes/<name>/theme.json` (twelve ship, two of them light). `herald-os
  theme set <name>` (or Style → Theme in the control menu, or the agent's `system_os theme_set`)
  recolours the shell, niri borders/backdrop (`~/.config/niri/theme.kdl`), swaylock, GTK 3/4
  (`gtk.css` + `gsettings`), and the `foot` rescue terminal in one step; a theme may also ship a
  wallpaper. Add a theme by dropping a folder into `~/.config/herald-os/themes/`.
- **Widgets** (ADR-019) live in `~/.config/herald-os/plugins/<id>/`: a `manifest.json` and web
  files, shown in the menu bar, on the Overview or in their own window. `herald-os plugin add
  <git-url>` clones one turned off; `herald-os plugin list | enable | disable | update | remove`
  manage them, and `enable` prints what the widget may do and asks at the terminal. Settings >
  Plugins does the same, and Hermes's `system_os plugin_*` actions can do everything except turn
  one on. Each runs in a sandboxed frame served from `herald-plugin://<id>/`, under a Content
  Security Policy that allows only its own files and the hosts it was granted. The manual's
  [Make it yours](manual/make-it-yours.md#widgets) explains how to write one.
- **The menu bar, the menu and branding.** `herald-os bar` shows, hides and moves menu-bar items
  and sets the clock (the `bar.*` commands behind Settings > Appearance > Menu bar).
  `~/.config/herald-os/menu.json` adds entries to the control menu, read each time it opens;
  `herald-os menu check` reports what it understood. `herald-os branding set --logo <image>
  --lock <image> --name <text>` copies the images into `~/.config/herald-os/branding/`; About
  shows the logo and name, and `herald-os lock` passes the picture to swaylock (`--image`,
  `--scaling fill`). Your own keys go in `~/.config/niri/local.kdl`, included last, where a bind
  replaces Herald's bind for the same key.
- **The install catalog** (`linux/catalog/*.json`, run by `herald-os-catalog`) is everything else
  worth one click: coding agents (Claude Code, Codex, OpenCode, Gemini CLI, Copilot CLI through npm
  in `~/.local`), Ollama and LM Studio with "Use with Hermes", languages through mise, editors,
  terminals, games, a Windows 11 VM (`herald-os install windows`, dockur/windows under Podman), media
  apps, services and web apps. Each entry lists install methods in order (Flatpak, dnf, pacman, AUR,
  npm, mise, a recipe, a web app, a download page); the first one the machine can use wins, so the
  same catalog serves Fedora, Arch and Omarchy, and the image (Flatpak and `~/.local` only). It
  backs Settings > Software, Install and Remove in the control menu, `herald-os install <id>`, and
  Hermes's `system_os catalog_*` actions. On macOS the shell installs the entries that have a Mac
  method (npm, Homebrew, a download page).
- **Omakase** (`linux/omakase/{packages,flatpaks,webapps}.txt`) is the curated software set every
  install gets: Firefox, Nautilus, Text Editor, LibreOffice, Loupe, Papers, Calculator, Calendar,
  VLC, developer tools, fonts; Obsidian, Spotify, LocalSend, VS Code, Signal from Flathub; and web
  apps (HEY, Google Calendar/Messages, WhatsApp, X, YouTube, ChatGPT, GitHub) as their own windows.
  Provisioning installs it (`HERALD_OS_OMAKASE=0` to skip); `herald-os omakase install` re-syncs.
- **Updates**: `herald-os update` pulls the repo on the chosen channel (`herald-os channel
  stable|edge`; both track `main` until releases exist), runs one-shot `linux/migrations/*.sh`
  (tracked in `/var/lib/herald-os/migrations`), upgrades the system (dnf on Fedora, pacman and the
  AUR helper on Arch; on Omarchy it leaves the system to `omarchy-update`, which Omarchy requires;
  the Herald OS image updates as a whole with `bootc upgrade`) and Flatpaks, updates Hermes Agent,
  rebuilds the shell and restarts it. A daily user timer runs `herald-os update
  --check`, which lights the menu-bar indicator when anything is pending. A repo pushed from a Mac
  (no `.git`) skips the shell step; use `linux/dev/push.sh` there. A release tarball in
  `/opt/herald-os` updates from GitHub releases instead
  ([Another Linux](#another-linux-the-release-tarball)).

## The Herald OS image (Fedora bootc)

Herald OS ships as a bootable container image (ADR-018), built in two halves that the development
VM's provisioner also runs, so the VM and the image cannot drift apart:

- **`linux/image/packages.sh`, at image build:** the packages in `linux/image/packages.txt` (and the
  omakase set), the session and CLIs under `/usr`, the prebuilt shell in `/usr/share/herald-os/app`,
  the boot splash and its initramfs, Flathub, the services. `--dev` does the same for the VM under
  `/usr/local`, with the build tools from `packages-dev.txt`.
- **`linux/image/firstboot.sh`, on the first boot:** the session user, its niri config, theme and
  update timer, and Hermes Agent (`herald-os-firstboot.service`, before the login screen), then the
  omakase Flatpaks (`herald-os-firstboot-apps.service`, while the session is up). Hermes Agent comes
  from GitHub, so a first boot without a network (Wi-Fi is joined later, in setup) leaves it to
  `herald-os-hermes.service`: it waits for the network, installs Hermes with its voice extras, runs
  `herald-os setup` and tries again ten minutes after a failed install. Meanwhile the shell's boot
  screen says how it goes, shows the Wi-Fi panel and starts Hermes once it is set up
  (`journalctl -u herald-os-hermes` has the details).

`linux/image/Containerfile` starts from `quay.io/fedora/fedora-bootc:44`; `.github/workflows/image.yml`
builds it for x86_64 and aarch64 on matching runners, pushes it to the repository's GHCR package
(`ghcr.io/iamlukethedev/herald-os`) and, for a release, turns it into:

- **an x86_64 installer ISO** (bootc-image-builder `anaconda-iso`, `linux/image/iso.toml`): the
  storage screen stays interactive, so it can install next to another system and encrypt the disk
  (btrfs) if you tick "Encrypt my data". Boot it with `inst.ks=<url>` and a kickstart like
  `linux/image/unattended.ks` for an unattended install: its `%pre` picks one disk (`DISK=` set
  in it, or else the only internal disk) and writes `ignoredisk --only-use` and
  `clearpart --drives` for it, so other disks are left alone. `DISK=` must be one name (no spaces,
  commas or options), resolve (`readlink -f`) to a writable `lsblk` `TYPE` `disk`, and not be a
  disk under the installer's mounts, which `lsblk -s` traces through partitions, LVM and RAID. The
  automatic choice also skips multipath and BIOS RAID members. With several internal disks and no
  `DISK=`, or a `DISK=` that fails those checks, it stops before erasing anything.
  `linux/tests/test_unattended.py` runs the `%pre` against fake `lsblk` output.
- **an aarch64 VM disk** (`qcow2`, `linux/image/disk.toml`): `bash linux/vm/run-qemu.sh --image <disk>`
  or `bash linux/vm/run-vf.sh --image <disk>` boot it, and `bash linux/vm/try.sh` fetches the latest
  release's disk and boots it in one command. It also goes out as a UTM bundle
  (`aarch64.utm.zip`, made by `linux/vm/make-utm.py`) that opens in UTM with a double-click.
- **an x86_64 VM disk** from the same `disk.toml`: as a `qcow2.zst`, and as a Hyper-V VHDX
  (`x86_64.vhdx.zip`) for a generation 2 machine on Windows.

`linux/vm/package-disk.sh` names, compresses and checksums them. Files over the 2 GiB GitHub takes
for one release file go up in parts: the ISO and the `qcow2.zst` as `.part0`, `.part1` that `cat`
joins again, the zips as `.001`, `.002` that 7-Zip and Keka open as one archive. The `.sha256` is the
joined file's, and a split file's `.sha256sums` has one line per part. `try.sh` joins its parts
itself; by hand:

```bash
sha256sum -c herald-os-<version>-aarch64.qcow2.zst.sha256sums    # each part
cat herald-os-<version>-aarch64.qcow2.zst.part* > herald-os-<version>-aarch64.qcow2.zst
sha256sum -c herald-os-<version>-aarch64.qcow2.zst.sha256          # the joined file
```

The zips join the same way from `.001`, `.002` (`cat <file>.zip.[0-9][0-9][0-9] > <file>.zip`).
`package-disk.sh` deletes the builder's `disk.qcow2` and the VHDX once they are converted, and the
workflow removes the images after the builder, so the runner has room for every output.
`.github/workflows/installer-test.yml` installs a release's ISO into a KVM machine (with an
unattended disk layout added to the ISO's kickstart), boots it and screenshots its first start.

On the image, apps install through Flatpak or into `~/.local` (the catalog picks those methods
there); the system itself changes only by a whole new image.

**Updates you can undo.** `herald-os update` runs `bootc upgrade` (the image tag of the channel:
`stable` follows releases, `edge` follows main (rebuilt when image files change);
`herald-os channel edge` switches with `bootc switch`), then Flatpaks and `hermes update`. The new
image starts on the next restart and the previous one stays in the boot menu; `herald-os rollback`
(or Update > Go back to the previous version) makes it the default again.

**Setup and reset.** The first boot makes the account and installs Hermes; then the shell's setup
asks who the computer is for. For yourself: a name, a password (set with `passwd` as you, so the
setup never needs root), Wi-Fi and Hermes's sign-in. For someone else: just Wi-Fi, and setup waits
for them at the next start. `herald-os reset` (type ERASE, then your password) erases the account,
its apps and saved networks on the next restart and runs setup again; the system stays. A system
switched from another bootc system is different: it gets a login screen and a locked account instead
([Switching a bootc system to Herald OS](#switching-a-bootc-system-to-herald-os)).

**Security.**

- **Firewall:** firewalld with a `herald-os` zone that refuses incoming connections except LocalSend
  (port 53317) and mDNS. SSH is off in release images; the development VM's zone allows it.
- **Secure Boot:** works through Fedora's signed shim.
- **Sign-in:** `herald-os setup fingerprint` (fprintd) and `herald-os setup fido2` (a security key,
  pam-u2f) enrol it and turn it on for the lock screen and sudo: through authselect on Fedora and
  the image, by adding the rule to `/etc/pam.d/sudo` and `/etc/pam.d/swaylock` on Arch (each file
  keeps a `.herald-os.bak` copy), and through Omarchy's own `omarchy-setup-security-fingerprint` and
  `omarchy-setup-security-fido2` on Omarchy.
- **Firmware:** `herald-os firmware check|update` (fwupd), also in the menu under Update.
- **Image signatures:** the image workflow signs each image with the project's cosign key, never
  keyless (which would publish to a transparency log) and without a log upload. Once
  `linux/image/cosign.pub` is in the repository, the image only accepts signed updates of itself
  (a `sigstoreSigned` policy for `ghcr.io/iamlukethedev/herald-os`). Turning signing on is a
  maintainer step, in this order, so no image ever carries the policy without a matching signature:
  1. Generate the key pair: `cosign generate-key-pair` (keep `cosign.key` and its password offline).
  2. Set the repository secrets `COSIGN_PRIVATE_KEY` (the contents of `cosign.key`) and
     `COSIGN_PASSWORD`.
  3. Set the repository variable `SIGNING_ENABLED` to `true`. CI's Signing policy check warns until
     `cosign.pub` is committed.
  4. Verify: run the Herald OS image workflow from `main`, then
     `cosign verify --key cosign.pub --insecure-ignore-tlog=true ghcr.io/iamlukethedev/herald-os:edge`
     (no transparency log, as above).
  5. Only then commit `cosign.pub` as `linux/image/cosign.pub`. From then on the image workflow fails
     if `COSIGN_PRIVATE_KEY` is missing or does not match it, and CI fails if `SIGNING_ENABLED` is
     not `true`.
- **SELinux** stays permissive for now (ADR-012).

### Switching a bootc system to Herald OS

Fedora Silverblue, Kinoite, Bazzite, Bluefin and other bootc systems can switch to the Herald OS
image in place. It replaces the system you run, so try it on a spare machine or in a virtual machine,
not on the computer you work on. What happens on its first start:

- **A login screen, and your account stays.** The first boot sees the accounts your system already
  has, so greetd does not sign anyone in by itself. It shows a text login screen on the first
  console (agreety) instead, as long as one of those accounts can sign in there: a local account
  with a shell and a password, a systemd-homed account (including one stored as a LUKS image,
  `/home/<name>.home`), or an SSSD or LDAP account with a folder in `/home`. First boot and the
  check at every start wait for `systemd-homed`, `systemd-userdbd` and `sssd`, so those accounts
  are there to be seen. Sign in with your own account and its password, and you get the
  Herald OS desktop. Herald OS's first-start setup then asks only for your name, Wi-Fi and Hermes's
  sign-in. Your password stays as it is (`herald-os password` changes it). The first boot installs
  Hermes Agent only for `hermes`, so run `herald-os setup` in a terminal once in your own account
  to install Hermes there too.
- **A locked `hermes` account, not yet an administrator.** The first boot also creates `hermes`, the
  account Herald OS sets Hermes Agent up for. On a switched system it is never an administrator
  without a password: it starts outside `wheel` and joins at the first start after it has one. It is
  locked and has no shell (`/usr/sbin/nologin`), so no one can sign in to it, with a password or an
  SSH key. Its
  user manager (PipeWire, portals, the update timer) does not run either (`loginctl
  disable-linger`). To use it, give it a password from your own account with `sudo passwd hermes`.
  At the next start Herald OS gives back the shell it had before it was locked
  (`/var/lib/herald-os/hermes-shell`), adds it to `wheel` and turns its user manager back on (it
  stays on whenever `hermes` has a password, whatever its shell). To do it at once, run
  `sudo usermod -s /bin/bash -aG wheel hermes`. After that, `hermes` can sign in at the login screen
  too. If you take `hermes` out of `wheel` yourself later, Herald OS leaves it out.
- **Checked at every start.** `herald-os-login.service` runs before greetd at every start, and greetd
  waits for it to succeed: if it fails, there is no login screen rather than one that signs someone
  in. Any other greetd config is replaced with the login screen. A system switched with an earlier
  Herald OS image, which signed `hermes` in with no password, gets the login screen at its next
  start, and a `hermes` without a password is locked and taken out of `wheel`.
- **What counts as switched.** Accounts from before Herald OS: local ones (UIDs 1000 to 60000),
  systemd-homed ones (60001 to 60513), and folders in `/home` that belong to someone other than
  `hermes`, which accounts from SSSD or LDAP have too, and systemd-homed's LUKS images
  (`/home/<name>.home`). Folders that root or another system account owns are not counted, nor are
  folders of accounts newer than `hermes`. When the account list cannot be read, the system counts as switched. The
  first boot decides this once and records the answer (`/var/lib/herald-os/switched` or
  `/var/lib/herald-os/image-install`). Accounts added later, and `herald-os reset`, do not change it.
  The check at every start records nothing until first-boot setup has finished, so a run before the
  accounts are there cannot turn a switched system into an image install for good.
- **When no account can sign in.** If none of those accounts has a shell and a password (and none is
  a systemd-homed, SSSD or LDAP account), a login screen would have no one to let in. Accounts that
  sign in only with a fingerprint, a smartcard or an SSH key (a password starting with `!` or `*`)
  are among them. Herald OS then keeps greetd signing `hermes` in, with no password, and the
  first-start setup asks for one at once. But `hermes` stays out of `wheel`, so it cannot use `sudo`
  or approve system changes, until it has a password. It joins `wheel` at the next start after that,
  and a `hermes` an earlier image left in `wheel` without a password is taken out. In doubt, Herald
  OS assumes someone can sign in and shows the login screen. That covers a folder in `/home` whose
  owner cannot be looked up (SSSD or LDAP offline at first boot), and an account list that neither
  `getent` nor `/etc/passwd` gives (when only `getent` fails, `/etc/passwd` is read instead). `journalctl -u herald-os-login`
  and `journalctl -u herald-os-firstboot` say so with a warning. If one of your accounts gets a
  password later, the next start switches to the login screen and locks `hermes`. A login screen
  is never switched back to signing `hermes` in, even when its last account goes.
- **The first start takes a while.** It installs Hermes Agent, which needs the network, before the
  login screen appears. Without a network the login screen comes up first, and Hermes installs once
  you are online.
- **SELinux becomes permissive** (greetd and the compositors have no policy yet, ADR-012).
- **The firewall changes.** firewalld's default zone becomes `herald-os`, which refuses every
  incoming connection except LocalSend (port 53317) and mDNS, so SSH and other ports you opened are
  closed.
- **Nothing checks the image's signature yet.** `linux/image/cosign.pub` is not in the repository, so
  neither the switch nor later updates verify it; you trust GHCR and the connection to it.
- **`edge` follows `main`.** The image workflow publishes it on pushes to `main`; `stable` follows
  releases.

bootc keeps the changes you made to `/etc` yourself, so where you changed one of these settings,
yours stays. Note the image you run now, so you can come back to it, then switch and restart:

```bash
sudo bootc status                # your current image, for later
sudo bootc switch ghcr.io/iamlukethedev/herald-os:stable
systemctl reboot
```

If `bootc` is missing or refuses, `sudo rpm-ostree rebase
ostree-unverified-registry:ghcr.io/iamlukethedev/herald-os:stable` switches through rpm-ostree instead
(`unverified`: without a signature check, as above).

**When there is no login screen.** greetd waits for `herald-os-login.service`, so if that fails, the
first console stays empty. Press Ctrl+Alt+F2 for a text console (Herald OS keeps `getty@tty2` on),
sign in with your own account and see why:

```bash
sudo journalctl -b -u herald-os-login     # what went wrong
sudo systemctl restart herald-os-login    # once it is fixed
sudo systemctl start greetd
```

**When no account can sign in at all** (for example, the account you used was removed or its
password was locked after the login screen took over), start the rescue shell. In the boot menu,
press `e`, add `systemd.unit=rescue.target systemd.setenv=SYSTEMD_SULOGIN_FORCE=1` to the line that
starts with `linux`, and press Ctrl+X. The second setting gives a root shell even though Herald OS
installs lock the root account. There, give an account a password and a shell, then carry on
booting:

```bash
passwd hermes                          # or your own account
usermod -s /bin/bash hermes
systemctl default
```

**Going back.** The system you switched from stays in the boot menu: `sudo bootc rollback` (on Herald
OS, `herald-os rollback`) makes it the default again, and the next restart starts it as it was. Once
Herald OS has updated itself, that place holds the previous Herald OS version instead; to keep your old
system in the boot menu through updates, run `sudo ostree admin pin booted` before you switch
(`ostree admin status` lists what is pinned). `sudo bootc switch <your old image>` works too, but it
keeps what changed in `/etc` under Herald OS, the `hermes` account among it: remove that with
`sudo userdel -r hermes`. After a rollback, Herald OS's files in `/var` stay behind, the `hermes`
home folder (`/var/home/hermes`) and `/var/lib/herald-os`; delete them when you no longer want them.

On bootc and ostree systems Herald OS did not make, `herald-os update` and `herald-os rollback` never
run `bootc`: the system is left to its own updates. The install catalog uses Flatpak and `~/.local`
there, as on the image.

## Arch Linux (and Omarchy)

[Arch and other Linux](manual/other-linux.md) in the manual is the short version for installing.
Fedora stays the base Herald OS builds and tests on (ADR-017); Arch gets a package.
`packaging/arch/herald-os-bin` packages the release tarball and `packaging/arch/herald-os-git` builds
from source; both lay out the same files: the app in `/opt/herald-os`, the CLIs and session scripts
in `/usr/bin`, shared data in `/usr/share/herald-os`, the session for the login screen in
`/usr/share/wayland-sessions/herald-os.desktop`, and Herald OS as an app in the application menu.
Neither is on the AUR yet; build them from the repository:

```bash
cd packaging/arch/herald-os-bin
makepkg -si            # downloads the release tarball for this architecture
herald-os setup        # once per user: Hermes Agent and the bridge plugin
```

`HERALD_OS_TARBALL_URL=file:///path/to/herald-os-<version>-linux-x64.tar.gz makepkg -si --skipchecksums`
packages a tarball you built yourself instead.

The session needs niri (and a login screen such as greetd); the optional dependencies list what
each panel and feature uses. `.github/workflows/arch.yml` builds the package from a fresh tarball in
an Arch container, lints it with namcap, installs it and runs the CLIs.

## Another Linux (the release tarball)

Every release has `herald-os-<version>-linux-x64.tar.gz` and `-linux-arm64.tar.gz`, each with a
`.sha256`: the app, and under `resources/` the `herald-os` commands, the session scripts, the niri
template, themes, the install catalog and the bridge plugin. It goes in `/opt/herald-os`:

```bash
sha256sum -c herald-os-<version>-linux-x64.tar.gz.sha256
sudo mkdir -p /opt/herald-os
sudo tar -xzf herald-os-<version>-linux-x64.tar.gz -C /opt/herald-os --strip-components=1
sudo /opt/herald-os/resources/herald-os-linux/bin/herald-os-tarball install
herald-os setup        # once per user: Hermes Agent and the bridge plugin
```

`herald-os-tarball install` lays out what the Arch package does, under `/usr/local`, which package
managers leave alone:

- the `herald-os` commands and the session scripts in `/usr/local/bin`, as links into
  `/opt/herald-os` (the commands find the catalog, themes, niri template and migrations there);
- Herald OS on the login screen, `/usr/share/wayland-sessions/herald-os.desktop`, only when niri is
  installed (install niri, then run the command again). On Silverblue and other ostree systems,
  whose `/usr` is read-only, the entry goes in `/usr/local/share/wayland-sessions`, which GDM and
  SDDM read too;
- `herald-os-app` in the application menu (`/usr/local/share/applications/herald-os.desktop`), with
  its icon;
- the update-check user units in `/usr/local/lib/systemd/user`; `systemctl --user enable --now
  herald-os-update-check.timer` turns the daily check (the menu bar's update dot) on for an account;
- `chrome-sandbox` owned by root and setuid, which Electron needs where unprivileged user namespaces
  are off.

It is safe to run again, never replaces a file that is not one of its own links, and leaves a
`/opt/herald-os` that a package installed (`herald-os-bin`) to the package. `herald-os-tarball
status` shows the version and what is in place; `sudo herald-os-tarball remove` takes it all out
again, and `sudo rm -rf /opt/herald-os /opt/herald-os.previous` then deletes the app.

**The full session** needs niri and what the menu bar, dock and panels call: swaybg, swaylock,
swayidle, cliphist, wl-clipboard, wtype, grim, slurp, brightnessctl, playerctl, PipeWire,
NetworkManager, BlueZ, UPower, power-profiles-daemon and the portals, the rest of
[linux/image/packages.txt](../linux/image/packages.txt) (Fedora's names; the Arch package's optional
dependencies give Arch's). A login screen that lists `wayland-sessions` starts it (GDM, SDDM and
LightDM do). The session applies Herald's theme to the account that runs it, rewriting
`~/.config/gtk-3.0/gtk.css`, `~/.config/gtk-4.0/gtk.css`, `~/.config/foot/foot.ini` and
`~/.config/swaylock/config`, and setting GNOME's `color-scheme` and `gtk-theme`, which your usual
desktop reads as well. On a machine you already use, try the session from a second account
(`sudo useradd -m herald && sudo passwd herald`). Picking a theme in `herald-os-app`'s Settings
inside your own desktop changes none of those files.

**Updates.** `herald-os update` asks GitHub for the newest release with a tarball for this
architecture (releases on the `stable` channel; `edge` also takes pre-releases), downloads it with
its `.sha256` over HTTPS only (a redirect to plain http is refused) and checks it, unpacks it beside
`/opt/herald-os`, and then swaps the two folders in one step (the kernel's `renameat2` exchange), so
`/opt/herald-os` is never missing or half replaced. On a filesystem that cannot exchange (NFS, some
FUSE mounts) it falls back to two renames, a moment apart, and puts the version in use back if the
second fails. The version before stays in `/opt/herald-os.previous`, and `herald-os rollback` swaps
back the same way; both take effect at the next login, or the next start of `herald-os-app`. If a
step fails anyway, the message says which version is in which folder. Replacing `/opt/herald-os`
needs sudo: in a terminal it asks for your password,
while Update in the menu bar can only use sudo without one. The checksum proves the download is the
file the release published, not who published it, so a release is trusted as far as GitHub is.
`herald-os update` also updates the system's packages as before (`dnf upgrade` on Fedora).

## Inside Hyprland and Omarchy (app mode)

Herald OS also runs as an app inside another compositor: `herald-os-app` starts the single-window
shell (fullscreen, as on macOS) and leaves the compositor's bar, keys and window rules alone. The
shell finds the compositor from `NIRI_SOCKET` or `HYPRLAND_INSTANCE_SIGNATURE`; on Hyprland it mirrors
windows through `hyprctl -j` and the event socket, so "ask about this window" works, and `herald-os
wm` maps niri's action names to Hyprland dispatchers: Lua ones (`hl.dsp.…`) for a Lua config
(Hyprland 0.55 and later, as on Omarchy 4), the classic ones for `hyprland.conf`. The `herald-os` CLI
reaches the one window through the same control socket the niri session uses, so every `herald-os`
command works as a key.

On Omarchy, `herald-os omarchy install` sets the rest up, and `herald-os omarchy remove` takes it out
again ([Running inside Omarchy](manual/omarchy.md) in the manual). It handles Omarchy 4 (the package in `/usr/share/omarchy`, a Lua Hyprland config, state in
`~/.local/state/omarchy`) and Omarchy 3 (the checkout in `~/.local/share/omarchy`, `hyprland.conf`):

- **Theme:** a hook in `~/.config/omarchy/hooks/theme-set.d/` runs `herald-os theme omarchy` when the
  Omarchy theme changes (Omarchy 4 runs that folder itself; on Omarchy 3 a small `theme-set` hook
  does), and Herald takes the theme's colours from its `colors.toml` (or `alacritty.toml`) and its
  background as the wallpaper. Herald's `theme list`, `set` and `current` hand off to Omarchy there.
- **Menu:** on Omarchy 4, a "Herald OS" row on the Omarchy menu, from
  `~/.config/omarchy/extensions/omarchy-menu.jsonc`. On Omarchy 3, Herald is in Applications.
- **Keys:** on Omarchy 4, `Super+Alt+H` opens Herald OS and `Super+Alt+` A (ask about this window),
  C (command bar), V (voice), X (dictate), E (emoji) and M (Missions) do the rest, from
  `~/.config/hypr/herald-os.lua`, none of them taken by Omarchy. On Omarchy 3, the same keys come one
  after `Super+Alt+H` (Return opens Herald OS), from `~/.config/hypr/herald-os.conf`.
- **Sign-in:** `herald-os setup fingerprint` and `setup fido2` run Omarchy's own
  `omarchy-setup-security-fingerprint` and `omarchy-setup-security-fido2`.
- **Updates and installs:** `herald-os update` leaves the system to `omarchy-update` and catalog
  installs go through `omarchy-pkg-add` and the AUR helper Omarchy ships.

Files that already exist (a `theme-set` hook, a menu file that isn't Omarchy 4's object of entries)
are never overwritten; the command prints the line to add instead.

This has been tested under Hyprland 0.56 with Omarchy 4's own config, theme scripts
(`omarchy-theme-set`, `omarchy-hook`) and menu parser, including real key presses, but not yet on an
Omarchy install on real hardware. Reports are welcome.

**Sharing a Hermes home.** Omarchy's Hermes Desktop owns `~/.hermes` and runs its own backend and
messaging gateway. A second backend from Herald is safe (Hermes takes a lock for every cron tick and
keeps one gateway per home), and Settings > Network says when another app's gateway is running. To
not run a second backend at all, start Herald with `HERALD_OS_BACKEND_URL=http://127.0.0.1:<port>`
and the backend's token in `HERALD_OS_BACKEND_TOKEN` (or `~/.config/herald-os/backend-token`); Herald
then attaches to it and writes `~/.hermes/herald-os/control.json` (mode 0600) so the bridge plugin
can still drive Herald's UI.

**A Hermes on another computer.** The address must be a loopback one, but it can be the near end of
a tunnel (`ssh -L <port>:127.0.0.1:<port> other-computer`) to Hermes elsewhere. When Herald attaches,
it writes a small file and asks Hermes to read it back. Unless Hermes does (an older Hermes cannot be
asked; `hermes update` fixes that), Herald takes it that the two do not share files and works around
it: files attached in the composers, the command bar or with a screenshot are uploaded into the
session before the prompt goes out (Hermes keeps them in its home's `attachments/` folder, and the
message names that copy), new chats start in Hermes's own folders rather than at a path on this
computer, and Hermes is told that paths you mention are on your computer, so it asks you to attach a
file instead of searching for it. A file over 100 MB (11 MB for an older Hermes) is refused before
anything is sent, and the draft stays in the composer. Canvas AI needs a Hermes that reads this
computer's files, so it says so instead.

## Known limits

- No calendar (`calendar.today` reports `unavailable`); Evolution Data Server integration is later.
- No print server (CUPS) ships in the image or the VM yet, and Electron opens no print dialog on a
  system without a printer, so File > Print in Herald Docs, Sheets and Slides offers Print to File
  there instead: a PDF where you choose, the same pages Export as PDF writes. With CUPS and a
  printer it opens GTK's print dialog.
- The VM has one display, so Herald Slides' audience window (the slides on a second display while
  the presenter view stays on the first) has not been tried under niri; with one display the
  presenter view shows the slides beside it, full screen.
- QEMU has no GPU acceleration on macOS: niri runs nested inside cage, which renders with pixman,
  and Electron runs with `--disable-gpu`. UTM's Apple Virtualization backend gives virtio-gpu-gl.
- Under the `HERALD_OS_COMPOSITOR=cage` kiosk, a launched app (Firefox, Nautilus) covers the shell
  fullscreen and returns to it when closed; there is no switching between other apps' windows.
- SELinux is permissive on the VM.
- Apple Silicon Macs cannot boot this natively (no Asahi support for M4/M5); the VM is the target.
  On x86_64 PCs it installs from the ISO above, which has been tested in a KVM virtual machine
  (`installer-test.yml`) but not yet on real PC hardware.
