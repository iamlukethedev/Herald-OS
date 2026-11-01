---
name: desktop
description: Operate desktop apps on Herald OS Linux with desktop control (the desktop tool) - read an app's accessibility tree, click buttons, fill in fields, choose options, tick boxes, open and quit apps, read and set the clipboard, take a screenshot, wait for a window or a text - with the snapshot, act and check loop, refs, safe retries, what asks first, and what does not work yet under cage and niri
metadata:
  hermes:
    tags: [herald-os, linux, desktop, desktop control, apps, accessibility, at-spi, click, type, forms, buttons, checkboxes, menus, windows, clipboard, screenshot]
---

# Desktop control

The `desktop` tool operates the apps on this Herald OS Linux computer through their accessibility
tree (AT-SPI): the same buttons, fields, lists and menus a screen reader sees. It does not look at
pixels and it does not move a pointer. Every call returns the app's own JSON result (`data`) or an
error with a `code`. Herald's own windows have better tools (`os_ui`, `docs`, `sheets`, `slides`,
`canvas`, `calc`): use `desktop` for the other apps (Firefox, Files, Text Editor, settings dialogs).

## The loop

Observe, act on a ref, then observe again to check.

1. `desktop command=list-apps`, then `desktop command=snapshot app=<name from list-apps>`. A
   snapshot reads only the elements you can act on (`interactive_only` and `compact` are on).
   For a big app, `skeleton=true` first, then `root=<ref>` to read one part.
2. Act on a ref from that snapshot: `command=click ref=@s8f3k2p9:e12`.
3. Snapshot the same app (or `root=` the same part) and check that the change happened.

- `find` is quicker when you know what you want: `command=find app=firefox role=button
  name=Reload first=true`.
- After something that takes time (an app opening, a dialog appearing), use `wait` (`window=`,
  `text=` with `app=`, `ref=` with `predicate=actionable`) instead of guessing; `ms=` only as a
  last resort.
- `app` takes the name `list-apps` prints (`gnome-text-editor`, `nautilus`, `firefox`) or the app's
  desktop-entry name, never a window title.

## Refs

- A ref looks like `@s8f3k2p9:e5` and belongs to the snapshot it came from. Pass it exactly.
- Refs go stale when the app changes. `STALE_REF` or `SNAPSHOT_NOT_FOUND`: snapshot again and use
  the new ref. `AMBIGUOUS_TARGET`: narrow it down with `find` (role and name) or `root=`.
- Acting on a ref needs a snapshot or find from this conversation's recent calls: the approval
  names the element ("click the button “Save” in Text Editor"), so a ref you made up or kept from
  long ago is refused before anything happens.

## Which command

- `click` presses a button, link or menu item. `toggle` flips a check box or switch.
- `type` inserts text into a field; `set-value` replaces a field's whole value; `select` chooses an
  option in a list or drop-down by its text.
- `focus` moves the keyboard focus to an element (a GTK4 app may refuse: `grab_focus_rejected`).
- `get` reads an element's `text`, `value`, `title`, `bounds`, `role` or `states`; `is` answers
  `visible`, `enabled`, `checked`, `focused`, `expanded` or `selected`.
- `launch app=<name>` opens an app and returns once it runs; `wait window=<title>` for its window.
- `clipboard-get`, `clipboard-set text=...`, `clipboard-clear`.
- `screenshot app=<name>` (or the whole screen without `app`) saves a picture and returns its path
  as `screenshot`; look at it with the vision tool. Prefer a snapshot: it is exact and cheaper.
- `batch steps=[{...}, {...}]` runs up to 20 steps in order after one approval and stops at the
  first that fails, saying which ran (`completed`) and which failed (`failed_step`).

## Asking first

Reading (snapshot, find, get, is, wait, the list commands, status) runs without asking. Acting in
an app (click, type, set-value, select, toggle, scroll, focus, press, launch, clipboard-set) asks
first, and "always" holds for that one command in that one app. A screenshot and reading the
clipboard ask too, because they show you what is on screen or copied. Quitting an app, acting on or
dismissing notifications and clearing the clipboard ask every time. A batch asks once, at the
highest of its steps, and lists every step. Say what you are about to do before a long batch.

Never run the desktop control program from the terminal or from code: such calls are blocked. Use
the tool.

## Results and retries

An action's result carries `disposition` with `delivery` and `retry`.

- Repeat an action only when `retry` is `safe` (only `not_delivered` is). Anything else may have
  landed: a second click can submit twice and a second `toggle` undoes the first.
- When it is not safe, read the live state (`get`, `is` or a fresh snapshot) and decide from that.
- Decide by `code` and `disposition`, not by the wording of the message.
- Two clicks on one GTK4 button less than about 250 ms apart count once: wait for the effect
  between them.
- In Firefox, `select` can change a value without the page noticing; check the page's own effect.

## What works on Herald OS Linux

Herald OS runs Wayland compositors (cage for the desktop, niri for panels), not GNOME. Reading the
tree and the semantic actions on refs (click, toggle, type, set-value, select) go through AT-SPI and
work there. Keyboard and pointer input does not, for now: `press`, key-by-key typing, `scroll`
(wheel input), pointer gestures (double-click, hover, drag) and moving or resizing windows need
GNOME's Mutter RemoteDesktop or an X11 session. Such a call fails with `ACTION_NOT_SUPPORTED` or
`PLATFORM_NOT_SUPPORTED`; reach the same result through refs instead (click the menu item rather
than pressing its shortcut, `set-value` rather than typing keys). Also:

- Notifications (list, act, dismiss) read GNOME Shell and answer `PLATFORM_NOT_SUPPORTED` here.
  Herald's own notices are in `os_ui`.
- `close-app` asks an X11 app to quit; a Wayland app may need `force=true`, which loses unsaved
  work: say so before you ask.
- `screenshot` goes through the screenshot portal and may show the person a consent dialog.
- Qt apps join the tree because the session sets `QT_ACCESSIBILITY=1`. A Chromium app (Chrome,
  Chromium itself, not Electron) appears only when started with `--force-renderer-accessibility`.
- An empty `supported_surfaces` in `status` means the accessibility bus did not answer, not that
  nothing is open: tell the person, and do not try to restart the bus.
- A GTK4 field that hides its characters may still show its text in a snapshot; only a password
  role is withheld. Do not read such text back to the person or put it anywhere else.

Adapted from the skills of agent-desktop by Vercel Labs (Apache License 2.0); see
`third_party/agent-desktop/PATCHES.md`.
