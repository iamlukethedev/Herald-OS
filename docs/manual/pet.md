# The desktop pet

The desktop pet is Hermes's own pet, a small animated character from the petdex gallery, out on
your desktop. It shows what Hermes is doing, holds up approvals for you to answer, takes questions
in a chat bubble and files you drop on it, walks over to the window Hermes is working in, and keeps
out of your way.

It is the same pet everywhere Hermes shows one: the Hermes CLI, the TUI, Hermes's desktop app and
Herald. Which pet, its size and whether it shows at all are Hermes's own settings (`display.pet` in
Hermes's config), so a change made in one of them shows in all of them. Where the pet stands, what
it reacts to and whether it is put away for now are Herald's.

On a Mac the pet stands over your windows and the Dock, and under the menu bar, the command bar and
notifications; web pages open in Herald (a web window, the Studio's preview) draw over it. Clicks
go through to whatever is underneath, except on the pet and what it holds, and clicking the pet
never takes the keyboard from where you were typing. On Herald OS Linux it is a small window of its
own at the bottom right, above the Dock (see [Linux notes](#linux-notes)). Drag it anywhere and it
remembers the spot.

## Getting a pet

Herald OS comes with no pet: you choose one from the petdex gallery, and Hermes keeps the pets you
install in `~/.hermes/pets`. If Hermes already shows a pet, Herald shows the same one.

- **In Settings.** Settings > Pet > Petdex gallery: click Browse the petdex gallery, search if you
  like, and click Install on a pet. Hermes downloads it from petdex.dev and makes it the pet it
  shows. Under Which pet, Use switches to another pet you have.
- **In a terminal.** `hermes pets install boba --select` installs the pet called boba and makes it
  the one Hermes shows; `hermes pets list` browses the gallery.
- **By asking.** "Use the boba pet" switches to an installed pet by its name, or installs it from
  the gallery first.

## What it shows

| The pet | What it means |
| --- | --- |
| Rests | Hermes is free |
| Reads along | Hermes is thinking |
| Runs | A tool is running |
| Jumps for a moment | A turn finished cleanly |
| Droops for a moment | A turn failed |
| Waves, then listens | The wake word heard you and a voice conversation started |
| Holds up a card | Hermes needs a yes or no from you (see [Approvals](#approvals)) |
| Walks | It is on its way: to its corner with an approval, to Hermes's work, or back to its spot |

Hover over the pet to see what Hermes is doing, and click it for its chat bubble, which shows the
current step at the top ("Running a command", "Reading the document"). A small number at its top
right counts the Hermes work running in the background: other conversations that are working (not
the one in the Hermes window, and not the pet's own) and automations that are running. The
automations are an estimate, checked every two minutes from their latest runs. The
[Pet Room](room.md) shows each piece of Hermes work as a pet of its own.

When nothing is happening the pet rests on one frame and costs no measurable processor time, and
nothing runs while it is hidden. With Reduce motion on (Herald's setting or the system's) it shows
a still frame for each state.

## Approvals

When Hermes needs a yes or no, the pet walks to the bottom-right corner of the screen and holds up
Herald's own approval card, with the same choices it offers anywhere else (Allow once, Deny and the
rest). Answer it there; when more approvals are waiting, the card says how many (on a Mac they
wait with the pet rather than in a second card beside it). Each one is a new card, so answering
one from the keyboard never leaves the keyboard on the next one's answers.

The card in the pet's hands never takes the keyboard, so a key pressed in another window cannot
answer it, and nothing is ever answered for you; `Cmd+Option+A` (`Super+Shift+A` on Herald OS
Linux) moves the keyboard to it. In a voice conversation, saying "yes" or "no" still answers it, as
the card says. On a Mac the usual card shows while the pet walks over, then the pet holds it alone;
on Herald OS Linux the Hermes window shows it too, so it cannot get lost behind other windows. While
the pet is away or hidden, approvals appear in the usual place. Questions, passwords and secrets that
Hermes asks for are never handed to the pet: they appear where they always do.

## The chat bubble

Click the pet and ask Hermes anything: type and press `Enter`. The question goes to a conversation
of the pet's own, titled "Pet ·" and your first words, which starts quietly in the background the
way a Herald Office window's Ask Hermes field does: the Hermes window stays as it was, and no
notification says the turn finished. While Hermes works, the top of the bubble says what it is
doing, and Stop ends the turn.

Replies come back as speech bubbles, without Markdown marks, and long ones are shortened: "The rest
is in Hermes" shows the whole reply. Open in Hermes carries on the conversation in the Hermes
window, and New chat (`+`) starts a fresh one. If you close the bubble while Hermes is still
answering, the reply pops up beside the pet for a few seconds; click it to open the chat again.

The chat box, and the question box of a drop (below), are the only parts of the pet that take the
keyboard, and only while they are open: `Esc` closes them and hands the keys back.

## Dropping files

Drop files on the pet, up to 10 at a time, and it offers what fits them:

| You drop | The pet offers |
| --- | --- |
| A PDF | Summarise it, File it as an invoice, Turn it into slides |
| An image | Edit in Herald Canvas, What is in it?, File it as an invoice |
| A Word, Markdown or text document | Summarise it, Turn it into slides, Open in Herald Docs |
| An Excel workbook or a CSV file | Summarise it, Open in Herald Sheets |
| A PowerPoint presentation | Summarise it, Open in Herald Slides |
| Several files | Summarise them, and File them as invoices when they are all PDFs or images |

Every drop also has a box to type your own question about the files. Hermes's answers come back in
the chat bubble.

- **Filing** hands the files to Hermes's document filing (see
  [Finding and filing documents](README.md#finding-and-filing-documents)): it reads them, proposes
  names and folders, and moves nothing until you approve the plan.
- **Edit in Herald Canvas** opens the image as a new Canvas project; the file itself is not changed.
- **Turn it into slides** has Herald Slides lay a document out as a deck itself, as its File > New
  from Document… does, without asking Hermes. From a PDF, Hermes makes a short deck of its key
  points.
- **Open in Herald Docs, Sheets or Slides** is offered only for files Herald Office opens. Other
  documents, such as old Office files or OpenDocument files, get Summarise it and your own
  question.

## Following the work

When Hermes works in a Herald Docs, Sheets, Slides or Canvas window, reading or changing what is
open there, the pet walks over to that window. It perches on the window's top edge near its right
end, or sits inside its bottom-right corner when there is no room above. It stays while Hermes
keeps working there, and walks back to its spot about 20 seconds after Hermes is done.

Dragging the pet away stops it following for the rest of that piece of work, and Settings > Pet >
Walk to Hermes's work turns following off. On Herald OS Linux the pet can land a little off a tiled
window (see [Linux notes](#linux-notes)).

## Moods and notes

The pet tells you about a few things, quietly:

- **Worried**, hands together with a battery or disk mark, when the battery is at 15% or less and
  not charging (until it charges or passes 20%), or when the disk your home folder is on has less
  than 5% or 5 GB free (until it has 8% and 8 GB again). Herald looks every three minutes, and only
  while the pet is on screen.
- **Carrying a box** when an update is ready. On Herald OS Linux this is the update check behind
  the menu bar's update dot; Herald OS on a Mac has no update source for it yet.
- **Bringing a note** when Hermes finishes something you were not watching that ran for two minutes
  or more ("Finished:" and the conversation's title).

When one arrives, a few words in a speech bubble say what it is. Click a note to open its
conversation in Hermes (the box opens the update menu on Linux, or Settings > About on a Mac);
hover over it and click its small × (Not now) to dismiss it. The pet brings one note at a time,
the same kind at most every 20 minutes, and a note you dismissed never comes back. Settings > Pet >
Moods and notes turns each kind off.

## Getting it out of the way

The pet hides by itself while a Herald app is full screen (on Herald OS Linux, also while any
window covers the whole screen), while Herald Slides presents (the show and the presenter view,
and on Linux while the audience window is open), and during Do Not Disturb.

It also steps aside: rest the pointer on it for a moment without clicking and it moves out of the
way, then walks back to its spot a little later. On a Mac it moves for a click right next to it
too, and keeps off the text field you are typing in.

To put it away for a while, before a screen share for instance:

- press `Cmd+Ctrl+H` on a Mac or `Super+Ctrl+H` on Herald OS Linux (`Alt+Ctrl+H` in the virtual
  machine);
- click the paw in the menu bar;
- or say or type "hide the pet".

It stays away, across restarts, until you bring it back the same way, or with "show the pet". The
paw shows only while a pet is on, and Settings > Appearance > Menu bar can hide it like any other
item.

To turn the pet off altogether, switch off Settings > Pet > Show the pet, or say "turn off the
pet". That is Hermes's own setting, so the pet goes from every Hermes surface, not only Herald.

## Settings

Settings > Pet has it all in one place:

- **Show the pet** turns it on or off, for every Hermes surface.
- **Which pet** lists the pets you have, with a picture of each; Use switches to one.
- **Size** goes from 15% to 120% (Hermes starts at 33%). It is Hermes's size for the pet, so the
  other Hermes surfaces follow.
- **Put away for now** does what the shortcut and the paw do.
- **Walk to Hermes's work** lets it follow Hermes to the window it works in.
- **Reactions**: Thinking, Running, Cheering, Drooping and Listening. With one off, the pet rests
  instead.
- **Moods and notes**: Disk nearly full, Battery low, Update ready and Long job finished.
- **Petdex gallery**: browse and install pets.

## Commands and voice

The pet's actions are commands like any other in Herald OS: in the command bar, by voice, for
Hermes, and on Herald OS Linux with `herald-os os <command>`.

| Command | What it does | Say |
| --- | --- | --- |
| `pet.show`, `pet.hide`, `pet.toggle` | Brings the pet back (turning it on if it was off), puts it away, or hides or shows it as the shortcut does | "show the pet", "bring back the pet", "hide the pet", "put the pet away" |
| `pet.select` | Makes a pet the one Hermes shows, by its name or folder name, installing it from the gallery if need be | "use the boba pet" |
| `pet.size` | Sets its size (`scale`, 0.1 to 3), or makes it a step bigger or smaller (`step`, 1 or -1) | "make the pet bigger", "make the pet smaller" |
| `pet.enable` | Turns the pet on or off for every Hermes surface | "turn off the pet", "turn the pet on" |
| `pet.status` | Says which pet it is and what it is doing, or why it is away | "what is the pet doing" |
| `pet.list` | Lists the installed pets | "list the pets" |
| `pet.chat` | Opens the chat bubble | "talk to the pet" |

On Herald OS Linux, `herald-os os pet.hide` puts the pet away from a terminal, and a command's
arguments follow as JSON: `herald-os os pet.size '{"step": 1}'`.

## Linux notes

- **A window of its own.** The pet is a small window, "Herald OS · Pet": no frame, transparent, and
  only as big as the pet and what it holds. Herald's niri config floats it at the bottom right
  without focusing it, and binds `Super+Ctrl+H` to put it away and bring it back. Herald moves the
  window as the pet walks; putting the pet away hides the window, and bringing it back puts it in
  its spot again.
- **The keyboard.** niri gives a window the keys when the pointer passes over it or you click it.
  When that happens to the pet, Herald hands them straight back to the window you were in, unless
  the pet's chat box is open.
- **The Hermes window does the thinking.** What the pet shows is worked out in the Hermes window,
  which holds Hermes's conversations and approvals, and sent to the pet's window.
- **What it cannot see.** The pet keeps clear of the pointer, but cannot see text fields in other
  windows. Work you ask for in a Herald Office window's own Ask Hermes field does not show on the
  pet.
- **Following the work.** niri says where floating windows are, but not where tiled ones sit in
  view, so Herald works a tiled window's place out from the columns before it on the workspace.

## Privacy

- The pet is part of Herald, not a plugin, and needs nothing else installed. Hermes's plugin
  catalogue has a pet plugin of its own, tamahermes; Herald does not use it or need it.
- Apart from what you ask Hermes, the pet reaches the network only for the petdex gallery, when you
  browse it or install a pet, and then through Hermes.
- Herald reads only the pet setting from Hermes's config file, which can also hold credentials, and
  never writes what it read to a log.
- What you ask the pet is a Hermes conversation like any other: it goes to your model provider, and
  Open in Hermes shows it.
- Speech bubbles never show more of an approval than the card does.
