# Setting it up for someone else, and reset

Herald OS Linux asks who the computer is for the first time it starts, so you can install it for a
friend or a relative and hand it over ready to use. When a computer changes hands later, reset
starts it over.

## The first-start setup

After the installer and the first start (which installs Hermes Agent), Herald OS's setup asks:

- **It is for me:** your name, a password of at least 8 characters, Wi-Fi, and Hermes's sign-in
  (Nous Portal by default; "Use another provider" takes an API key). "Later" skips the sign-in, and
  the sign-in card comes back the first time Hermes needs a model. When the disk that holds the
  keyring folder (usually in your home folder) is not encrypted, or Herald OS cannot tell whether it
  is, it also asks how to protect the passwords apps save ([Saved passwords](security.md#saved-passwords-the-keyring)).
- **For someone else:** only Wi-Fi, so you can check the computer works. Setup does not finish: at
  the next start it waits for the new owner, who chooses "It is for me" and picks their own name and
  password. On an encrypted disk (the installer's default), tell them the disk password you chose
  when installing: they type it once to start the computer, and setup then asks them for a disk
  password of their own, which replaces yours. Yours stops working.

The password is the one for the lock screen and for administrator tasks. Until there is one, the
lock screen refuses to lock (an unlockable lock would shut you out), so set one in setup or later
with `herald-os password` in a terminal.

## Reset

Reset erases this computer's account, its files and apps, and its saved Wi-Fi networks, and runs
the first-start setup again at the next restart. Herald OS itself stays, at the version it has.

1. Back up anything you want to keep: reset deletes your home folder.
2. In a terminal, run `herald-os reset`.
3. Type `ERASE` to confirm, then your password.

The computer restarts, erases the account, every Flatpak app and every saved network, sets itself up
again (Hermes Agent included), and greets the next owner with setup. Reset is only on the Herald OS
image; on Arch, Omarchy or the tarball, remove the account the way that system does.

What stays on the disk depends on its encryption:

- **Encrypted** (the installer's default): the disk password stays yours until the next owner
  chooses theirs in setup. Tell it to them; they type it once to start the computer. Setup then
  asks for it and a new one, and only the new one opens the disk afterwards: every other way to open
  it goes too, including other passwords, recovery keys, and unlocking with a security key (FIDO2)
  or the TPM.
- **Not encrypted:** reset deletes the files, but it is not a secure erase. Someone with the disk and
  recovery tools may get some of them back, and `herald-os reset` says so before it asks you to
  confirm.

## The disk password

To change it yourself, run `herald-os password --disk` in a terminal. It asks for your account
password (for `sudo`), the current disk password (the one typed at start-up, not a recovery
key, which it refuses), then the new one twice. It adds the new one and
checks it before it removes the old one, so the disk always has a password that opens it; keep the
computer on until it says it is done. If the new owner chose "Later" in setup, `herald-os password
--disk --new-owner` does what setup would have done.

## Handing over a computer

1. Install Herald OS, choose **For someone else**, and join Wi-Fi.
2. Install the apps they will want from Settings > Software, if you like; they stay.
3. Restart or shut down, and give the new owner the disk password with it. They turn it on, type
   that disk password, choose **It is for me**, set their own password and disk password, and sign
   Hermes in with their own account.
