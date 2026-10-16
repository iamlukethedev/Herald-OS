# Updates, channels and rollback

## Herald OS Linux

Update in the Herald OS menu (`Super+M`), or in a terminal:

```bash
herald-os update            # install everything that is waiting
herald-os update --check    # only say what is waiting
```

One update covers the system, your Flatpak apps and Hermes Agent. A check runs every day by itself
(ten minutes after you start the computer, then daily), and a dot in the menu bar says when updates
are waiting; click it to update.

**On the Herald OS image**, the system updates as a whole: the new version is downloaded next to the
one you run and starts at the next restart. Nothing changes under your feet, and a failed download
leaves the system as it was.

If you added packages to the image yourself (`rpm-ostree install`, a local RPM, or `rpm-ostree
override remove` or `override replace`), `bootc upgrade` refuses to update it. `herald-os update`
notices them and updates with `rpm-ostree upgrade` instead. It says so, names the packages, and keeps
them in the new version. To go back to plain bootc updates, take them out with `rpm-ostree uninstall`
or `rpm-ostree override reset`.

### When something does not update

Each part updates on its own, and the update ends with a summary of every part: what it used, and
for anything that failed, why. A Flatpak that does not update (no space, a broken remote) is named
with its error, and the other apps still update.

`herald-os update` exits with 1 when the system or Herald OS itself (its shell, release, one-shot
migrations or rebuild) did not update. Flatpaks and Hermes Agent that did not update are reported in
the summary and the notification, but the exit status stays 0.

### Going back

The previous version stays in the boot menu. To make it the default again, choose Update > Go back to
the previous version in the Herald OS menu, or run `herald-os rollback`, then restart. If the new
version does not start at all, pick the previous entry in the boot menu at power-on. Your files and
settings are not part of the system, so going back leaves them as they are.

### Channels

```bash
herald-os channel           # which one you are on
herald-os channel stable    # releases (the default)
herald-os channel edge      # the latest from main, for testers
```

`edge` gets fixes sooner and breaks sooner. On the image, switching downloads that channel's image
right away, and it starts at the next restart; if the switch fails, you stay on the channel you had.

### Firmware

`herald-os firmware check` lists firmware updates for the computer's BIOS, dock, SSD and other
devices that support them (through fwupd), and `herald-os firmware update` installs them. Both are in
the menu under Update too.

## On a Mac

Download the new DMG from the [releases page](https://github.com/iamlukethedev/Herald-OS/releases)
and replace the app in Applications. Hermes updates itself with `hermes update`, whenever you like.
Herald OS from source updates with `git pull` and `npm run bootstrap`.

## Arch, Omarchy and the tarball

- **The Arch package:** `git pull` and `makepkg -si` again in `packaging/arch/herald-os-bin`.
  `herald-os update` updates the system's packages, Flatpaks and Hermes.
- **Omarchy:** `herald-os update` updates Herald OS's parts and Hermes, and leaves the system to
  `omarchy-update`, as Omarchy requires.
- **The tarball:** `herald-os update` downloads the newest release, checks it against its `.sha256`
  and swaps it into `/opt/herald-os`, keeping the version before in `/opt/herald-os.previous`;
  `herald-os rollback` swaps back. Both take effect when you next log in.

See [Arch and other Linux](other-linux.md).
