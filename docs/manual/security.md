# Security

What Herald OS Linux does to keep the computer safe, and what you can turn on. For what Hermes may
do on the computer, see [Privacy and the audit log](privacy.md).

## The firewall

The firewall refuses every incoming connection except two: LocalSend (port 53317), for sending files
between your devices, and mDNS, so devices on your network can find each other by name.
Connections you make yourself, to websites and services, are not affected.

## SSH

SSH is off on Herald OS Linux, and the firewall does not let it in. To reach the computer from
another one, turn it on with your public key (the contents of `~/.ssh/id_ed25519.pub` on the other
computer), or the keys you keep on GitHub:

```bash
herald-os setup ssh --key 'ssh-ed25519 AAAA… you@laptop'
herald-os setup ssh --github your-github-name
```

It adds the key to `~/.ssh/authorized_keys` (only you can read it), and then:

- signs in with keys only: passwords, keyboard-interactive logins and root are turned off in
  `/etc/ssh/sshd_config.d/10-herald-os.conf`. It checks with `sshd` that those settings are the ones
  in effect, and if another file overrules them it takes its change back and leaves SSH off;
- starts `sshd` and keeps it on after restarts;
- opens SSH in the firewall for at most four new connections a minute, which slows anyone guessing;
- prints the computer's host-key fingerprints, to compare the first time you connect, and the
  `ssh` command for each of its addresses.

Without a key it refuses and changes nothing. To sign in with your account's password instead, add
`--passwords` (root still cannot sign in). Running it again with the same key changes nothing.

```bash
herald-os setup ssh --status    # whether SSH is on, how you can sign in, and the firewall
herald-os setup ssh --off       # stop sshd, remove its settings and close the firewall again
```

`--off` leaves `~/.ssh/authorized_keys` as it is; its keys let no one in while SSH is off. Anyone who
can sign in over SSH can do whatever your account can, so turn it off when you no longer need it.
Hermes cannot turn SSH on: it is only in the terminal. For installing several computers with SSH on
from the start, see [Unattended installs](unattended-installs.md).

## Passwords, fingerprints and security keys

Your account's password unlocks the lock screen and approves administrator tasks. Set or change it
with `herald-os password` in a terminal. A fingerprint reader or a security key can do the same:

```bash
herald-os setup fingerprint     # enrol a finger, for the lock screen and sudo
herald-os setup fido2           # a security key such as a YubiKey
```

Each walks you through it in the terminal, and turns it on for the lock screen and `sudo`. On
Omarchy they run Omarchy's own setup instead.

## Disk encryption

The installer encrypts the disk when you tick "Encrypt my data" on its disk screen. With it on,
someone who takes the computer or its disk cannot read your files without the disk password. It
cannot be turned on afterwards without installing again, so decide at install time; see
[Installing on a PC](install-pc.md).

## Secure Boot

Secure Boot can stay on: Herald OS starts through Fedora's signed shim.

## Updates

Updates come from the project's image on GitHub's container registry, over an encrypted connection.
The images are signed, but Herald OS does not check those signatures yet; until it does, updates are
trusted as far as GitHub is. Firmware updates come through fwupd: `herald-os firmware check`.

## Still to come

**SELinux** is permissive for now: it logs what it would block instead of blocking it, until Herald
OS has a policy of its own for the login screen and the window manager.

## Reporting a security problem

Please report vulnerabilities privately, as described in [SECURITY.md](../../SECURITY.md).
