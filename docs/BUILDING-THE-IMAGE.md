# Building and customizing the Herald OS image

Herald OS Linux ships as a Fedora bootc image (ADR-018): a container image that is also a bootable
system. This page is for building that image yourself, booting your build and changing what goes
into it. [docs/LINUX.md](LINUX.md#the-herald-os-image-fedora-bootc) covers what the image is, its
installer and disks, signing and switching another bootc system to it; the
[manual](manual/README.md) covers using it.

## Where the recipe lives

| File | What it does |
| --- | --- |
| [`linux/image/Containerfile`](../linux/image/Containerfile) | The recipe. Starts from `quay.io/fedora/fedora-bootc:44`, copies `linux/` and the shell tarball into `/tmp/herald-os`, runs `packages.sh --image` on them, clears the dnf caches, `/tmp/herald-os`, `/var/cache` and `/var/log`, labels the image (`containers.bootc=1` and the OCI title, description, source and licence) and ends with `bootc container lint`. |
| [`linux/image/packages.sh`](../linux/image/packages.sh) | The system half, run as root at build time ([below](#what-packagessh---image-does)). The development VM runs the same script with `--dev`, so the VM and the image are set up by the same steps. |
| [`linux/image/packages.txt`](../linux/image/packages.txt) | The Fedora packages the session, the shell and the CLIs need. |
| [`linux/omakase/packages.txt`](../linux/omakase/packages.txt) | The curated Fedora apps every install gets (LibreOffice, VLC, developer tools, fonts). |
| [`linux/omakase/flatpaks.txt`](../linux/omakase/flatpaks.txt), [`webapps.txt`](../linux/omakase/webapps.txt) | The Flathub apps and web apps. Not in the image: they are installed for the session user on the first boot and the first login ([Flatpaks](#flatpaks)). |
| [`linux/image/firstboot.sh`](../linux/image/firstboot.sh) and the `herald-os-*.service` units | The per-machine half, run on the installed system: the session user, its home folder and Hermes Agent, then the omakase Flatpaks; also Hermes once the computer is online, reset, and the login screen on a switched system. |
| [`linux/image/kargs.toml`](../linux/image/kargs.toml) | Kernel arguments for every boot (`rhgb quiet plymouth.ignore-serial-consoles`), installed as `/usr/lib/bootc/kargs.d/10-herald-os.toml`. |
| [`linux/image/firewall-zone.xml`](../linux/image/firewall-zone.xml) | The `herald-os` firewalld zone: LocalSend and mDNS in, nothing else. |
| [`linux/plymouth/herald-os/`](../linux/plymouth/herald-os/) | The boot splash. |
| [`linux/image/disk.toml`](../linux/image/disk.toml), [`iso.toml`](../linux/image/iso.toml) | bootc-image-builder settings for the VM disk (`qcow2`, a root of at least 40 GiB) and the installer ISO (`anaconda-iso`). |
| [`linux/vm/package-disk.sh`](../linux/vm/package-disk.sh) | Names, compresses, converts and checksums bootc-image-builder's output for a release. |
| [`linux/image/Containerfile.nvidia`](../linux/image/Containerfile.nvidia), [`nvidia.sh`](../linux/image/nvidia.sh) | The NVIDIA image (x86_64 only): the default image with NVIDIA's open kernel modules from Universal Blue's akmods images, negativo17's driver and CUDA libraries and NVIDIA's container toolkit on top. Its header has the commands to build it locally, pinned by digest ([docs/LINUX.md](LINUX.md#the-nvidia-image)). |
| [`.github/workflows/image.yml`](../.github/workflows/image.yml) | CI: builds the image per architecture, pushes it to GHCR, joins the multi-arch tag, signs it when the key is set up, and makes the ISO and disks for tags and on request. An NVIDIA leg on x86_64 builds the default image from a base pinned by digest, then `Containerfile.nvidia` on it, and pushes `herald-os-nvidia` under the channel's tag; it may fail (until Universal Blue publishes modules for a new kernel) without holding back the default image. |

`linux/dev/build.sh` is not part of the image. It builds the shell from a checkout inside the
development VM, where `linux/provision.sh` installs it as `herald-os-build`: it runs
`scripts/bootstrap.sh`, compiles node-pty, runs `npm run build --workspace apps/desktop`, fixes
Electron's `chrome-sandbox` and installs the session files, CLIs, themes, omakase lists and catalog
under `/usr/local`, then runs the one-shot migrations. The image never builds the shell: it unpacks
the prebuilt shell tarball instead. Use the VM ([docs/LINUX.md](LINUX.md#quick-start-qemu-all-from-the-terminal))
for working on the shell, and the image for trying the system as it ships.

### What `packages.sh --image` does

Six of the eight steps print a `--- <step>` line in the build log; the image's name (4) and the
signature policy (6) print none. The script ends with `==> system half done (--image)`. The NVIDIA
image's layer, `nvidia.sh`, prints four `--- <step>` lines of its own and ends with
`==> NVIDIA layer done (<driver version>)`.

1. **SELinux permissive** (ADR-012).
2. **Packages.** `dnf -y install --setopt=install_weak_deps=False` with everything in
   `linux/image/packages.txt`, then `linux/omakase/packages.txt` with `--skip-unavailable`. A line
   is one package; `#` starts a comment.
3. **The session and CLIs.** `linux/session/herald-os-{compositor,session,niri-nested}` and
   `linux/bin/herald-os*` go to `/usr/bin`; `themes`, `omakase`, `catalog`, `niri`, `migrations`,
   `plymouth` and `session` from `linux/` go to `/usr/share/herald-os`. Also the Wayland session
   entry, the update-check user units and greetd's config (`/etc/greetd/config.toml`).
4. **The image's name.** `IMAGE_ID=herald-os` goes in `/usr/lib/os-release`. Every other
   os-release line stays Fedora's.
5. **The shell.** The tarball is unpacked to `/usr/share/herald-os/app` (the build stops if it has
   no `resources/app.asar`), `chrome-sandbox` is made setuid root, the bridge plugin is linked at
   `/usr/share/herald-os/bridge` and the icon goes to
   `/usr/share/icons/hicolor/512x512/apps/herald-os.png`. The first-boot, Hermes, reset and login
   units go to `/usr/lib/systemd/system`, `firstboot.sh` and `reset-helper` to
   `/usr/libexec/herald-os`, and `kargs.toml` to `/usr/lib/bootc/kargs.d`.
6. **The signature policy**, only when `linux/image/cosign.pub` exists
   ([Signing](#signing)).
7. **The boot splash.** The Plymouth theme is installed and made the default, and the initramfs of
   the newest kernel in `/usr/lib/modules` is rebuilt with `dracut --no-hostonly`.
8. **Services.** Flathub is written as a remote in `/etc/flatpak/remotes.d` (downloaded from
   `dl.flathub.org` during the build); NetworkManager, Bluetooth, greetd, a text console on
   `tty2`, the `plocate` timer, firewalld and the Herald OS units are enabled; the default target is
   `graphical.target`, the default firewall zone is `herald-os`, and `sshd` is disabled.

## Building it locally

A typical build, the shell tarball and then the image, takes about 23 minutes. On GitHub's runners,
the image workflow's job for one architecture takes 10 to 12 minutes.

### Prerequisites

- **Linux on the architecture you build for**: x86_64 for an `amd64` image, aarch64 for `arm64`.
  node-pty is compiled for the shell, not cross-built, so CI builds each architecture on a runner
  of its own (`ubuntu-24.04` and `ubuntu-24.04-arm`).
- **Podman.** The commands below run it with `sudo`, as CI does. Root's image store
  (`/var/lib/containers/storage`) is the one bootc-image-builder reads.
- **Node.js 22 and npm**, a C/C++ toolchain and Python 3, for the shell. CI installs
  `build-essential` and `python3` on Ubuntu.
- **A network connection.** The build downloads the pinned Hermes snapshot, the npm packages and
  Electron, the base image from quay.io, the Fedora packages and Flathub's remote file.
- **Plain HTTP to `ciscobinary.openh264.org`.** Fedora's openh264 repository
  (`fedora-cisco-openh264`, enabled in the base image) sends its packages from
  `codecs.fedoraproject.org` there over `http://`, and the image installs `openh264` and
  `mozilla-openh264` from it (Firefox, `libavcodec-free` and `libheif` need them). A proxy or
  firewall that allows only HTTPS stops the package step.
- **Disk space** for `node_modules`, the shell build and the image, which is about 5.7 GB on its
  own, plus the disk you make from it.
- **btrfs in the host's kernel**, only for making a VM disk or an installer
  ([step 3](#3-make-a-disk-or-an-installer-optional)).

### 1. Build the shell tarball

From the repository root, the same steps as the workflow's "Build the shell for this architecture":

```bash
npm run sync-upstream
npm ci
npm run dist:linux --workspace apps/desktop -- --x64     # --arm64 on an aarch64 machine
cp apps/desktop/release/herald-os-*-linux-x64.tar.gz herald-os-linux.tar.gz   # -linux-arm64 there
```

`npm run dist:linux` writes `apps/desktop/release/herald-os-<version>-linux-<x64|arm64>.tar.gz`
(`herald-os-0.1.0-alpha.4-linux-x64.tar.gz`, about 160 MB, at version 0.1.0-alpha.4): the app,
with the bridge plugin and the icon under `resources/`. The Containerfile copies the
tarball from the build context, so it has to be inside the repository; `herald-os-linux.tar.gz` at
the root is the name it expects and is ignored by git. `--build-arg SHELL_TARBALL=<path>` names
another file in the repository, outside the folders `.containerignore` leaves out of the build
context (`apps/desktop/release` among them, with `.git`, `node_modules`, `output` and the VM
disks), which keeps the context to `linux/`, the tarball and a few small files.

### 2. Build the image

```bash
sudo podman build -f linux/image/Containerfile --build-arg SHELL_TARBALL=herald-os-linux.tar.gz -t herald-os .
```

This is the command at the top of the Containerfile, with `sudo` as in CI. It runs seven steps,
and step 5 is `packages.sh` with its `--- <step>` lines. The NVIDIA image is a second build on top
of this one, with `linux/image/Containerfile.nvidia`. The end of a successful build looks like
this:

```
==> system half done (--image)
...
STEP 7/7: RUN bootc container lint
...
Checks passed: 12
Checks skipped: 1
Warnings: 2
COMMIT herald-os
...
Successfully tagged localhost/herald-os:latest
```

CI's build prints the same two lint warnings (content in `/run` and `/var`), and a
`dracut-install: ERROR: installing '/root'` line in the boot splash step; neither stops it. The
image is `localhost/herald-os:latest` in root's image store, about 5.7 GB on x86_64:

```bash
sudo podman images localhost/herald-os
sudo podman run --rm localhost/herald-os grep IMAGE_ID /usr/lib/os-release   # IMAGE_ID=herald-os
```

The scripts, lists and units in the image come from `linux/` in your checkout, and only the app
comes from the tarball. A change under `linux/` needs only this step again; a change to the shell
(`apps/`, `packages/`, `plugins/`, `upstream/`) needs the tarball rebuilt first.

### 3. Make a disk or an installer (optional)

The workflow's "Build the disk with bootc-image-builder" step, pointed at your local image. For the
VM disk:

```bash
mkdir -p output
sudo podman run --rm --privileged --pull=newer --security-opt label=type:unconfined_t \
  -v ./output:/output -v ./linux/image/disk.toml:/config.toml:ro \
  -v /var/lib/containers/storage:/var/lib/containers/storage \
  quay.io/centos-bootc/bootc-image-builder@sha256:2b52843ea2bfda73b0a08d97e76b734393b1d3a804681b9fabb26723bd3a2f0b \
  --type qcow2 --rootfs btrfs --local localhost/herald-os:latest
```

That writes `output/qcow2/disk.qcow2`. The builder runs privileged and mounts the new btrfs root
itself, so the host's kernel must support btrfs: without it, the build stops with
`unknown filesystem type 'btrfs'`. For the installer, mount `linux/image/iso.toml` as
`/config.toml` and use `--type anaconda-iso`, which writes `output/bootiso/install.iso`; CI makes the
ISO for x86_64 only. The builder is pinned to the digest the workflow uses, its last multi-arch
build.

To name and compress them as a release does (it needs `qemu-img`, `zip` and `zstd`):

```bash
sudo chown -R "$(id -u)" output
bash linux/vm/package-disk.sh output amd64 <version> dist   # arm64 for an aarch64 disk
```

`dist/` then has `herald-os-<version>-x86_64.qcow2.zst` and `herald-os-<version>-x86_64.vhdx.zip`
(or `herald-os-<version>-aarch64.qcow2.zst` and `herald-os-<version>-aarch64.utm.zip`), or
`herald-os-<version>-x86_64.iso`, each with a `.sha256`, and split into parts when over 2 GiB
([docs/LINUX.md](LINUX.md#the-herald-os-image-fedora-bootc) has the parts and how to join them).
`<version>` may use only letters, digits, `.`, `_` and `-`. `package-disk.sh` deletes the builder's
`disk.qcow2` once it is converted.

### In CI, on your fork

`.github/workflows/image.yml` pushes to `ghcr.io/<repository owner>/herald-os`, so on a fork it
publishes to your own GHCR package. Run "Herald OS image" from the Actions tab: a run from a branch
other than `main` gets the tag `dev-<first 7 characters of the commit>`, so it never replaces a
channel, and ticking "Also build the ISO and the VM disk" adds the disks as artifacts of the run.
A push to `main` that touches the image's files publishes `edge`, and a `v*` tag publishes
`stable` and the version and attaches the disks to a draft release. The workflow makes nothing
public: the GHCR package stays private until you change it in the package's settings.

## Booting or switching to your build

### Switching a running system

On Herald OS, or another bootc system, switch to an image in a registry:

```bash
sudo bootc status                # the image you run now, to come back to
sudo bootc switch <registry>/<owner>/herald-os:<tag>
systemctl reboot
```

For example `ghcr.io/<owner>/herald-os:dev-1a2b3c4` from a run on your fork, after `podman push`
of your local build to a registry of your own, or `ghcr.io/iamlukethedev/herald-os:edge`. Where
`bootc` is missing or refuses, rpm-ostree does the same:

```bash
sudo rpm-ostree rebase ostree-unverified-registry:<registry>/<owner>/herald-os:<tag>
```

To boot an image you built on the machine itself, without a registry, switch to it in root's image
store, where `sudo podman build` put it (the image has Podman, so a Herald OS machine can build its
own next image):

```bash
sudo bootc switch --transport containers-storage localhost/herald-os:latest
systemctl reboot
```

The new image starts on the next restart, and the one before stays in the boot menu:
`herald-os rollback` (or `sudo bootc rollback`) makes it the default again. A machine that already
ran Herald OS keeps its account and Hermes, since the first-boot units run once per machine
(`/var/lib/herald-os/firstboot-done`); on a system switched from another bootc system, the first
boot does more, as in [Switching a bootc system to Herald OS](LINUX.md#switching-a-bootc-system-to-herald-os).

Afterwards, on your build:

- `herald-os update` runs `bootc upgrade` (or `rpm-ostree upgrade` when packages are layered),
  which follows the image `bootc status` shows: rebuild or push the same tag, then update.
- `herald-os channel stable` and `herald-os channel edge` need a registry image. They keep the
  repository of the image `bootc status` shows, change only the tag and run `bootc switch` with
  bootc's default transport, the registry, so they work only where `stable` and `edge` tags exist
  there. After `bootc switch --transport containers-storage`, the channel switch looks for
  `localhost/herald-os:<channel>` in a registry, fails and leaves the channel as it was; switch
  back to a registry image with `bootc switch` first.
- Keep `IMAGE_ID=herald-os`. `herald-os` and `herald-os-update` tell the Herald OS image from other
  bootc systems by that line, and leave other systems' updates and rollbacks alone.

### In a virtual machine

On an Apple Silicon Mac, an aarch64 `disk.qcow2` boots with QEMU or Apple's Virtualization
framework:

```bash
bash linux/vm/run-qemu.sh --image output/qcow2/disk.qcow2
bash linux/vm/run-vf.sh --image output/qcow2/disk.qcow2
```

Elsewhere, create a virtual machine that boots with UEFI from the qcow2 as an existing disk, as in
the README's [On Linux or an Intel Mac](../README.md#on-linux-or-an-intel-mac), with 4 cores, 6 GB
of memory and the 40 GB disk. The first boot creates the account and installs Hermes Agent, as on
a release disk.

### On a PC

Write the ISO to a USB stick and install from it as in [Installing on a PC](manual/install-pc.md).

## Customizing

### Packages

- **Add or remove a system package** in `linux/image/packages.txt`. Every name there must exist in
  Fedora 44's repositories: `dnf install` runs without `--skip-unavailable`, so one unknown name
  fails the build. Weak dependencies are not installed, so name what you need.
- **Add or remove an app** in `linux/omakase/packages.txt`. These install with
  `--skip-unavailable`, and a failure prints `WARNING: some omakase packages did not install`
  without stopping the build.
- `linux/image/packages-dev.txt` is for the development VM only (Node.js and the build tools).
- The image enables no repositories beyond the base image's: RPM Fusion and COPR packages are not
  available to these lists (`packages.txt` notes that RPM Fusion's `libheif-freeworld` is left out
  for this reason).
- The development VM installs the same two lists (`packages.sh --dev`), so a change can be tried
  there before an image build.

The system on an installed machine changes only by a whole new image. Apps a person installs go
through Flatpak or into `~/.local` ([Installing software](manual/installing-software.md)).

### Flatpaks

`linux/omakase/flatpaks.txt` holds one Flathub app ID per line. The image does not contain the
apps: it ships the list (in `/usr/share/herald-os/omakase`) and the Flathub remote. On the first
boot, `herald-os-firstboot-apps.service` runs `firstboot.sh apps`, which runs
`herald-os-omakase install --flatpaks` as the session user: `flatpak install --user` from Flathub
for each ID, skipping those already installed and printing a warning for any that fail. Add or
remove an ID and rebuild to change what new installs get.

On a machine that is already set up, the service has run (`/var/lib/herald-os/firstboot-apps-done`),
so new IDs arrive with `herald-os-omakase install --flatpaks`, run as that user after updating to an
image that has them.
Removing an ID from the list does not uninstall the app anywhere.

`linux/omakase/webapps.txt` works the same way for web apps, which the session installs at the
first login.

### Branding

What the image carries:

- **The boot splash:** `linux/plymouth/herald-os/` (`herald-os.plymouth`, the script, `logo.png`
  and `bar.png`). The image installs it as the default Plymouth theme and builds the initramfs with
  it, so a new `logo.png` shows from the next image.
- **The app icon:** `apps/desktop/build/icon.png`, which travels in the shell tarball and is
  installed as `/usr/share/icons/hicolor/512x512/apps/herald-os.png`. It needs the tarball rebuilt.
- **Themes:** `linux/themes/<name>/theme.json`, copied to `/usr/share/herald-os/themes`. A folder
  added there ships with the image; the first boot applies the current theme, `herald-ocean` unless
  one is chosen (`DEFAULT` in `linux/bin/herald-os-theme`).
  [Make it yours](manual/make-it-yours.md#writing-a-theme-by-hand) describes the file.
- **The container image's labels** (`org.opencontainers.image.*` in the Containerfile): what
  registries show for it.
- **os-release:** only `IMAGE_ID` is Herald's, and the update tools depend on it
  ([above](#switching-a-running-system)).

The logo and name in About and the lock-screen picture are per account, not part of the image:
Settings > About > Branding or `herald-os branding set`
([Branding](manual/make-it-yours.md#branding) in the manual).

### Signing

`packages.sh` installs a signature policy only when `linux/image/cosign.pub` exists, and that policy
names `ghcr.io/iamlukethedev/herald-os` and `ghcr.io/iamlukethedev/herald-os-nvidia`, so either
image accepts signed updates of itself and of the other. Without the file, as today, a build accepts updates
without a signature check. With it committed, the image workflow stops unless `COSIGN_PRIVATE_KEY`
is set and matches it. [docs/LINUX.md](LINUX.md#the-herald-os-image-fedora-bootc) has the
maintainer's steps for turning signing on.

### An NVIDIA variant

The NVIDIA image, which GPUs it is for, switching to it and Secure Boot are in
[The NVIDIA image](LINUX.md#the-nvidia-image) in docs/LINUX.md.

## Checking a change

`npm run test:bridge` runs the bridge plugin's tests and `linux/tests` with pytest, as CI does.
Among them, `test_image.py` checks how the CLIs tell the image from other bootc systems,
`test_firstboot.py` the first boot, `test_vm_disks.py` the VM disks and `test_unattended.py` the
unattended kickstart. The image itself is only built by the image workflow, so a change to it is
tried with the build above, or with a run of that workflow on your fork.
