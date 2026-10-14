# The Windows VM

For the Windows app you cannot do without, Herald OS Linux can install Windows 11 in a virtual
machine: a Windows PC in a window, sharing a folder with you.

## What you need

- An x86_64 PC with virtualization (Intel VT-x or AMD-V, "KVM") turned on in its firmware settings.
  Without it, Settings > Software says so.
- Memory and disk to spare: by default Windows gets half your memory (between 4 and 8 GB), half your
  processor cores (between 2 and 4) and a 64 GB disk, and the install needs about 10 GB more than the
  disk you give it.

## Installing

Settings > Software > Windows > Install, or in a terminal:

```bash
herald-os install windows
```

In a terminal it asks how much memory, how many cores and how much disk to give Windows; press
Return to keep each suggestion. Windows then downloads and installs itself, which takes 10 to 20
minutes, and a window shows its progress. You do not have to click through Windows's own setup.

Windows runs with [dockur/windows](https://github.com/dockur/windows) under Podman, in your account,
and is reachable only from this computer, not from your network.

## Using it

Open **Windows** from Applications (`Super+A`). It connects with Remote Desktop, which gives a sharp
picture and a shared clipboard, or shows Windows in a browser window when no Remote Desktop client
is installed. Windows's account name and password are made for you, kept in
`~/.config/herald-os/windows.json`, and filled in for you.

The `~/Windows` folder in your home folder is shared with Windows, which sees it as a shared folder
on the network: put files there to open them in Windows, and save there from Windows to get them
back.

```bash
herald-os windows status       # running, stopped or not installed
herald-os windows stop         # shut it down (it starts again when you open it)
herald-os windows start
herald-os windows connect      # the same as opening it from Applications
```

## Removing it

`herald-os windows remove` (or Remove in Settings > Software) takes the virtual machine away but
keeps its disk, so installing again picks up where you left off. `herald-os windows remove --purge`
deletes the disk too. `~/Windows` is never touched.

## Good to know

- Windows needs a licence of its own to activate; without one it runs with a watermark and some
  settings locked.
- There is no graphics acceleration, so it suits office and business apps, not games.
- It is Windows: keep it updated, and treat what runs in it with the usual care.
