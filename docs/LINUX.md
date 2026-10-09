# Herald OS Linux

Herald OS as a whole operating system: a Fedora base, greetd signing you in, niri arranging the
windows, the Herald shell drawing the menu bar, dock and system menus, and Hermes Agent underneath.
Today it installs on x86_64 PCs from the installer ISO in the v0.1.0-alpha.3 release (tested in a
virtual machine in CI, not yet on real PC hardware), runs as an app inside Omarchy, and on an Apple
Silicon Mac (aarch64) runs in a virtual machine for trying it and for development; nothing on the
Mac changes.

```
kernel + systemd  ->  greetd (autologin: hermes)  ->  niri  ->  Herald OS shell  ->  hermes serve
                                                                      |                    |
                                                          HostPlatform (linux.ts)   herald-os-bridge (LinuxHost)
                                                                      \__________  ps ss nmcli wpctl gio journalctl plocate
```

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
confirm on any device), or from a shell in the VM:

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
| `/etc/greetd/config.toml` | Logs `hermes` in on VT1 and runs `herald-os-compositor`. Respawns when it exits. |
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

`herald-os-session` starts, as transient user units: `wl-paste --watch cliphist store` (text and
images; `Mod+Ctrl+V` opens the picker), and `herald-os-idle`, which runs `swayidle` with the timings
from Settings > General (`~/.config/herald-os/idle.conf`: screensaver, lock after 10 min only when
the account has a password, screens off after 15, no sleep by default; "stay awake" stops the
unit). Night light is `wlsunset` as the `herald-os-nightlight` unit. Notifications from other apps
arrive through the shell's own `org.freedesktop.Notifications` daemon. The `hermes` VM user has no password by default, so
`herald-os lock` refuses until you run `herald-os password` in a terminal; a lock nobody can undo
would leave the compositor's session lock engaged.

`Mod+M` or `Mod+Alt+Space` opens the control menu (Install / Remove / Update / Style / Trigger /
System / Hermes); every item is a `herald-os` command, so the agent (`system_os` tool) and scripts
can do the same. `Mod` is `Super` on real hardware and `Alt` when niri runs nested (the QEMU VM),
where `Mod+Alt+Space` is only `Alt+Space` and `Mod+M` is the way in. `Mod+K` lists every hotkey.
Web apps (`herald-os install webapp <name> <url>`) open as their own frameless windows.

The menu bar's status items open quick panels (`herald-os panel wifi|bluetooth|audio|display|power|clock`,
backed by `nmcli`, `bluetoothctl`, `pactl`, `niri msg output`, `powerprofilesctl` and `upower`).
Dictation (`Mod+Ctrl+X`, `herald-os dictate`) records until a pause, transcribes through Hermes's
speech-to-text and types the words into the focused app with `wtype`; the emoji picker
(`Mod+Ctrl+E`) types its pick the same way. `herald-os keymap omarchy` renders
`~/.config/niri/herald-os.kdl` from the installed template (`linux/niri/config.kdl`) with Omarchy's
`Super+C/X/V` copy, cut and paste; `herald-os keymap herald` restores Herald's keys. Every session
start renders it again, so an update's new template takes effect at the next login.

## Themes, omakase, updates

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
  omakase Flatpaks (`herald-os-firstboot-apps.service`, while the session is up).

`linux/image/Containerfile` starts from `quay.io/fedora/fedora-bootc:44`; `.github/workflows/image.yml`
builds it for x86_64 and aarch64 on matching runners, pushes it to the repository's GHCR package
(`ghcr.io/iamlukethedev/herald-os`) and, for a release, turns it into:

- **an x86_64 installer ISO** (bootc-image-builder `anaconda-iso`, `linux/image/iso.toml`): the
  storage screen stays interactive, so it can install next to another system and encrypt the disk
  (btrfs) if you tick "Encrypt my data". Boot it with `inst.ks=<url>` and a kickstart like
  `linux/image/unattended.ks` for an unattended install.
- **an aarch64 VM disk** (`qcow2`, `linux/image/disk.toml`): `bash linux/vm/run-qemu.sh --image <disk>`
  or `bash linux/vm/run-vf.sh --image <disk>` boot it, and `bash linux/vm/try.sh` fetches the latest
  release's disk and boots it in one command.

Both are bigger than the 2 GiB GitHub takes for one release file, so they go up in parts (`.part0`,
`.part1`) that `cat` joins again; the `.sha256` is the joined file's. `try.sh` joins them itself.
`.github/workflows/installer-test.yml` installs a release's ISO into a KVM machine (with an
unattended disk layout added to the ISO's kickstart), boots it and screenshots its first start.

On the image, apps install through Flatpak or into `~/.local` (the catalog picks those methods
there); the system itself changes only by a whole new image.

**Updates you can undo.** `herald-os update` runs `bootc upgrade` (the image tag of the channel:
`stable` for releases, `edge` for main once it is published; `herald-os channel edge` switches with
`bootc switch`), then
Flatpaks and `hermes update`. The new image starts on the next restart and the previous one stays in
the boot menu; `herald-os rollback` (or Update > Go back to the previous version) makes it the
default again.

**Setup and reset.** The first boot makes the account and installs Hermes; then the shell's setup
asks who the computer is for. For yourself: a name, a password (set with `passwd` as you, so the
setup never needs root), Wi-Fi and Hermes's sign-in. For someone else: just Wi-Fi, and setup waits
for them at the next start. `herald-os reset` (type ERASE, then your password) erases the account,
its apps and saved networks on the next restart and runs setup again; the system stays.

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
  (a `sigstoreSigned` policy for `ghcr.io/iamlukethedev/herald-os`).
- **SELinux** stays permissive for now (ADR-012).

### Switching a bootc system to Herald OS

Fedora Silverblue, Kinoite, Bazzite, Bluefin and other bootc systems can switch to the Herald OS
image in place. It replaces the system you run, so try it on a spare machine or in a virtual machine,
not on the computer you work on. What happens on its first start:

- **A new account signs in by itself.** The first boot creates `hermes`, an administrator (in
  `wheel`) with no password, and greetd signs it in with no login screen, so you cannot pick your own
  account there. Until you set a password in Herald OS's first-start setup (or with
  `herald-os password`), anyone at the keyboard has administrator rights. Your own account and its
  files stay.
- **The first start takes a while.** It installs Hermes Agent, which needs the network, before the
  desktop appears.
- **SELinux becomes permissive** (greetd and the compositors have no policy yet, ADR-012).
- **The firewall changes.** firewalld's default zone becomes `herald-os`, which refuses every
  incoming connection except LocalSend (port 53317) and mDNS, so SSH and other ports you opened are
  closed.
- **Nothing checks the image's signature yet.** `linux/image/cosign.pub` is not in the repository, so
  neither the switch nor later updates verify it; you trust GHCR and the connection to it.
- **Only the `stable` tag is published.** `edge` does not exist yet, so `herald-os channel edge`
  fails.

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
again. It handles Omarchy 4 (the package in `/usr/share/omarchy`, a Lua Hyprland config, state in
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
