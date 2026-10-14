# Windows and Spaces

On Herald OS Linux, windows place themselves. niri, the window manager, lines them up side by side in
columns on a strip that scrolls left and right, instead of piling them on top of each other. A new
window opens as a new column next to the one you are in, and the strip scrolls to show it. Nothing
gets lost behind anything else.

These keys are for Herald OS Linux; in the virtual machine, `Super` is `Alt`. `Super+K` shows them
all.

## Moving around

| Action | Keys |
| --- | --- |
| Focus the column to the left or right | `Super+H`, `Super+L`, or `Super+Left`, `Super+Right` |
| Focus the window below or above, in a column | `Super+J`, `Super+U`, or `Super+Down`, `Super+Up` |
| Go back to the previous window | `Super+Tab` |
| See every window at once | `Super+O`, the overview: click one to go there |
| Bring up the Hermes window | ``Super+` `` |

Right-click an app in the Dock to see its windows, pick one, or close them.

## Arranging

| Action | Keys |
| --- | --- |
| Move the window left, right, down, up | `Super+Shift` with `H`, `L`, `J`, `U` or the arrow keys |
| Stack the window into the column beside it, or take it out | `Super+[`, `Super+]` |
| Make the column wide (again to go back) | `Super+F` |
| Fullscreen | `Super+Shift+F` |
| Cycle the column's width, the window's height | `Super+R`, `Super+Shift+R` |
| Column narrower, wider | `Super+Minus`, `Super+Equal` |
| Show the column's windows as tabs | `Super+W` |
| Centre the column on screen | `Super+C` |
| Float the window above the others, or tile it again | `Super+T` |
| Close the window | `Super+Q` |

Herald's own panels (the menu bar, the Dock, the command bar) always float, and the Hermes window
opens at half the screen's width.

## Spaces

Spaces are separate strips of windows for separate parts of your life: **Personal**, **Work** and
**Ideas**. The menu bar shows them in the middle, and the Hermes window's sidebar lists them too;
click one to switch.

| Action | Keys |
| --- | --- |
| Go to Personal, Work, Ideas | `Super+1`, `Super+2`, `Super+3` |
| Move the window there | `Super+Shift+1`, `Super+Shift+2`, `Super+Shift+3` |
| The next or previous Space | `Super+Page Down`, `Super+Page Up` |
| Back to the Space you were in | `Super+Shift+Tab` |

## More than one display

The Displays panel (`Super+Ctrl+D`) turns a display on or off and sets its resolution and scale. `Super+Shift+P` turns the screens off until you move the
mouse or press a key.

## Your own keys

Add binds in `~/.config/niri/local.kdl`, which Herald OS never overwrites; a bind there replaces
Herald's for the same key. [Make it yours](make-it-yours.md#keyboard-shortcuts) has examples.
