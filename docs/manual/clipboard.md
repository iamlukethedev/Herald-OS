# Clipboard history

On Herald OS Linux, everything you copy is remembered, text and images alike, so you can paste
something you copied an hour ago.

## Using it

1. Press `Super+Ctrl+V` (or run `herald-os clipboard`).
2. The latest 50 copies are listed, newest first; type to narrow them down.
3. Press Return, or click one, to put it back on the clipboard, then paste with `Ctrl+V` as usual.

Images show as a short description of the picture data rather than a thumbnail.

## What it keeps, and where

The history is kept by `cliphist`, in your home folder, and never leaves the computer. It records
whatever any app copies, passwords from a password manager included, so be mindful of that on a
shared account. Herald OS has no button to clear it yet; in a terminal, `cliphist wipe` empties it.

## On a Mac

macOS has no clipboard history of its own, and Herald OS does not add one there.
