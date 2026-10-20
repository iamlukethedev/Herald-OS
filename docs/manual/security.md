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

It shows each key's fingerprint (`ssh-keygen -lf`) before adding it to `~/.ssh/authorized_keys`
(only you can read it), so you can check it is the one you meant. It takes Ed25519 and ECDSA keys,
security keys (`sk-…`), and RSA keys of 2048 bits or more; shorter RSA keys and DSA keys are
refused, and a GitHub account's weaker keys are skipped. GitHub's key list is read over HTTPS only,
with at most three redirects, and nothing over 1 MiB. Then it:

- signs in with keys only: passwords, keyboard-interactive logins and root are turned off in
  `/etc/ssh/sshd_config.d/10-herald-os.conf`. It asks `sshd` what is in effect, by default and for
  someone signing in from the internet as you or as root, and reads every sshd file for a `Match`
  block that lets in more (passwords, root, empty passwords, keyboard-interactive). If anything
  overrules its settings, if a file is included from inside a `Match` block, or if any sshd file
  cannot be read, it takes its change back and leaves SSH off;
- drops new SSH connections past four a minute from any one address (an IPv6 /64 counts as one),
  so guessing is slow and one guesser cannot lock everyone else out. Every attempt to connect
  counts, including the ones a client repeats on its own when an answer is slow, so a flaky
  connection or several computers behind one router can reach the limit sooner; wait a minute and
  try again. sshd cannot start without this limit: if it ever fails to load, SSH stays off rather
  than running unlimited;
- opens SSH in the firewall, and starts `sshd` and keeps it on after restarts;
- prints the computer's host-key fingerprints, to compare the first time you connect, and the
  `ssh` command for each of its addresses.

Without a key it refuses and changes nothing. To sign in with your account's password instead, add
`--passwords` (root still cannot sign in). Running it again with the same key changes nothing. If
the firewall (firewalld) is not running it refuses too, since SSH would then be open with nothing
else closed; `--no-firewall` turns SSH on anyway, with a warning. Without nftables it refuses,
because there would be no limit on guessing, except with `--no-firewall`, which then warns that
there is no rate limit at all. If any step fails partway, or it is stopped (Ctrl+C, closing the
terminal, a shutdown), or a command it runs hangs, it puts everything back as it was before and says
what it put back; if it could not put everything back, it says so and what to check. `--status`
warns about anything that keeps SSH from working.

```bash
herald-os setup ssh --status    # whether SSH is on, how you sign in, the firewall, sessions
herald-os setup ssh --off       # stop sshd, remove its settings and rate limit, close the firewall
```

`--off` asks, in a terminal, whether to end the SSH sessions that are still open (`--end-sessions`
ends them without asking; yours last, if you are connected over SSH). It leaves
`~/.ssh/authorized_keys` as it is; its keys let no one in while SSH is off. Anyone who can sign in
over SSH can do whatever your account can, so turn it off when you no longer need it. Hermes cannot
turn SSH on: it is only in the terminal. Resetting the computer turns SSH off and ends its sessions.
For installing several computers with SSH on from the start, see
[Unattended installs](unattended-installs.md).

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

The installer encrypts the disk unless you untick "Encrypt my data" on its disk screen. With it on,
someone who takes the computer or its disk cannot read your files without the disk password. It
cannot be turned on afterwards without installing again, so decide at install time; see
[Installing on a PC](install-pc.md). The disk password is typed before Bluetooth starts, so keep a
wired keyboard (or one with a 2.4 GHz receiver) for it.

`herald-os password --disk` changes the disk password; it asks for the current one first. When the
computer passes to someone else, setup asks the new owner for their own, and the previous one stops
working ([Setting it up for someone else, and reset](setup-and-reset.md)). The disk password cannot
be recovered: without it, the files are gone.

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
