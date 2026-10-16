# linux/

Everything needed to run Herald OS as the whole desktop of a Fedora machine (Stage 1: a VM on
your Mac). Full guide: [docs/LINUX.md](../docs/LINUX.md).

```
linux/
  provision.sh            first-boot provisioner (root, idempotent)
  image/                  the bootc image: Containerfile, packages.sh, first boot, disk and ISO
                          settings (docs/BUILDING-THE-IMAGE.md)
  bin/                    herald-os (the CLI every hotkey and menu calls), -theme, -omakase, -update,
                          -tarball (installs and updates the release tarball in /opt/herald-os)
  session/                greetd config, compositor + session launchers, wayland-sessions entry,
                          update-check timer, lock-screen style
  niri/config.kdl         the managed niri config (rendered to ~/.config/niri/herald-os.kdl): hotkeys,
                          window rules, workspaces
  themes/                 whole-desktop themes (shell, niri, terminal, wallpaper): herald-*
  omakase/                the default app set: dnf packages, Flatpaks, web apps
  plymouth/herald-os/     boot splash
  migrations/             one-shot upgrade steps herald-os-update runs once per machine
  dev/                    push.sh and vm-ssh.sh (Mac -> VM); build.sh, sync.sh, restart-shell.sh,
                          shot.sh (inside the VM)
  vm/                     download-image.sh, make-seed.sh (cloud-init), run-qemu.sh, run-vf.sh
  vm/build/               generated: image, seed ISO, SSH key, overlay disk, screenshots (gitignored)
```

```bash
bash linux/vm/download-image.sh && bash linux/vm/make-seed.sh && bash linux/vm/run-qemu.sh
bash linux/vm/run-qemu.sh console            # first boot provisions (30-45 min, mostly downloads)
bash linux/dev/push.sh --with-hermes-config  # build the shell in the VM, copy model config (not OAuth logins)
bash linux/dev/push.sh ssh                   # then: hermes setup (or sign in from the card in Herald OS)
```
