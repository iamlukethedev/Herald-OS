# Security

What Herald OS Linux does to keep the computer safe, and what you can turn on. For what Hermes may
do on the computer, see [Privacy and the audit log](privacy.md).

## The firewall

The firewall refuses every incoming connection except two: LocalSend (port 53317), for sending files
between your devices, and mDNS, so devices on your network can find each other by name.
Connections you make yourself, to websites and services, are not affected.

## SSH

SSH is off on Herald OS Linux, and the firewall does not let it in. To reach the computer from
another one, turn on both, in a terminal:

```bash
sudo systemctl enable --now sshd
sudo firewall-cmd --permanent --add-service=ssh && sudo firewall-cmd --reload
```

Use a key rather than a password (`ssh-copy-id` from the other computer), and turn it off again with
`sudo systemctl disable --now sshd` and `--remove-service=ssh` when you no longer need it. Anyone who
can sign in over SSH can do whatever your account can.

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
