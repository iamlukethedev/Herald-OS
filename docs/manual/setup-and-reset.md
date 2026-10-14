# Setting it up for someone else, and reset

Herald OS Linux asks who the computer is for the first time it starts, so you can install it for a
friend or a relative and hand it over ready to use. When a computer changes hands later, reset
starts it over.

## The first-start setup

After the installer and the first start (which installs Hermes Agent), Herald OS's setup asks:

- **It is for me:** your name, a password of at least 8 characters, Wi-Fi, and Hermes's sign-in
  (Nous Portal by default; "Use another provider" takes an API key). "Later" skips the sign-in, and
  the sign-in card comes back the first time Hermes needs a model.
- **For someone else:** only Wi-Fi, so you can check the computer works. Setup does not finish: at
  the next start it waits for the new owner, who chooses "It is for me" and picks their own name and
  password.

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

## Handing over a computer

1. Install Herald OS, choose **For someone else**, and join Wi-Fi.
2. Install the apps they will want from Settings > Software, if you like; they stay.
3. Restart or shut down. The new owner turns it on, chooses **It is for me**, and signs Hermes in
   with their own account.
