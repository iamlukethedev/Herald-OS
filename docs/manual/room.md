# The Pet Room

The Pet Room is a window where everything Hermes is working on in Herald shows as a petdex pet of
its own: each conversation, each mission, each helper agent Hermes hands part of a job to, and each
of your automations. Pets walk to the area for the tool they are using, a bubble says what each one
is doing, a pet walks a note over to a helper it started and the helper brings the result back, a
pet holds up a sign when it needs your OK, and pets that are idle or have gone quiet say so. The
documents you have open in Herald stand as desks, and a pet working on one stands at its desk. With
the activity log on, the room can play a day back as a time-lapse, and cost meters can show the
tokens and cost Hermes counted for each piece of work.

Open it from the Dock (the sofa), from Applications, with the Pet Room button at the top of the
Missions page, from Settings > Pet Room, or by saying "show the pet room". It can also be your
screensaver (see [The Room as the screensaver](#the-room-as-the-screensaver)).

## What you see

| In the room | What it means |
| --- | --- |
| A pet at Docs, Sheets, Slides or Canvas | Hermes is working on that document, workbook, presentation or image ("working on Q3 report") |
| A desk below Docs, Sheets, Slides or Canvas | A document open in Herald Docs, Sheets or Slides, or a project open in Herald Canvas (see [Desks and meetings](#desks-and-meetings)) |
| A pet at a desk | Hermes is working on that document |
| Two pets at one desk | Two agents are working on the same document at once ("2 agents on Launch plan.docx") |
| A pet at the Terminal | Hermes is running a command, or checking the system. The room never shows the command itself |
| A pet at the Browser | Hermes is searching the web or reading a page ("reading example.com") |
| A pet at Files | Hermes is reading, writing or searching files ("reading Budget.xlsx") |
| A pet at the Studio | Hermes is running code |
| A pet at Memory | Hermes is updating its memory, reading a skill or searching past conversations |
| A pet at Messages | Hermes is sending a message or using a connected app ("using Gmail") |
| A pet standing in the lounge, reading | A turn has started and Hermes is thinking, with no tool yet |
| A pet resting in the lounge | That conversation is idle |
| A pet on the bench with a sign | It needs your OK (see [Approvals](#approvals)) |
| A pet on the bench, no sign | Hermes asked something in the conversation itself: a question, a password or a secret |
| A pet coming in at the door | A helper agent Hermes started for this work |
| A pet at the Automations board, at work | One of your automations is running (see [Automations](#automations)) |
| A pet resting by the Automations board | An automation between runs |
| A pet in the lane at the right edge | Hermes at work outside Herald, when you turn that on (see [Hermes outside Herald](#hermes-outside-herald)) |
| A pet from the lane at a station, or on the bench with a sign | With live steps on, work outside Herald at the tool it is using, or waiting for your OK in its own app ("Needs your OK in Telegram") |
| A plain grey figure | A pet whose picture cannot be read: its tag, bubble and facts still show (see [Which pets](#which-pets)) |

The stations a pet works at glow while it is there, and so does a desk. The top of the window counts
what is going on ("2 working", "1 waiting for you", "3 idle", helpers, automations running and work
active outside Herald).

Each pet has a name tag: the conversation's title, the job a helper was given, or the automation's
name; hover over a pet for the whole title. Under the tag, short facts say what is true right now:

- "idle for 12 minutes"
- "quiet for 4 minutes during a turn": nothing has come from Hermes for a while, though the turn is
  still running. A long command or a slow model looks like this too.
- "same call 3 times": Hermes made the same tool call with the same arguments three times in a row.
- "Hermes stopped a repeating call to terminal": Hermes's own guardrail stopped a loop.
- "2 agents on Launch plan.docx": two agents are working on the same document. It is a hint, not a
  warning: they may be taking turns on purpose.
- For a helper that has finished: done, could not finish, ran out of time or was stopped.
- For an automation: "running for 3 minutes", "ran 2 hours ago", "failed 5 minutes ago", "not run
  yet" or "paused".
- For work outside Herald: where it runs and how active it is ("Telegram · active now", "the Hermes
  CLI · last active 3 minutes ago") and, with live steps on, "waiting for your OK in Telegram".

These are facts, not verdicts: the room says what it sees and leaves the judging to you. A working
pet moves for a few seconds each time Hermes reports something and then holds still, so a pet that
stops moving has had no news.

Click a pet to open its conversation in the Hermes window; a helper opens the conversation that
started it, and an automation opens Automations at its job. Pets of Hermes work outside Herald open
nothing, in the lane or out of it: that work belongs to another Hermes app.

## Helpers

When Hermes hands work to helper agents, each helper comes in at the door as a pet of its own. The
pet that started it walks over with a note, hands it over and goes back, and the helper walks to the
area for the tool it uses. When the helper finishes, it walks back with the result and, for a few
seconds, says the first sentence of Hermes's summary of what it found. Then it leaves through the
door.

When a helper's work completes, a white roadster lifts off over the room on jets of vapor, flips
over a truck and flies away: a few seconds, at most once a minute, and any key or click ends it
(a click in the room that ends it does nothing else).
With Reduce Motion on it is a single still frame instead. Settings > Appearance > Flyover animations
turns it off.

Hermes often lets helpers work in the background: the conversation can be resting in the lounge
while its helpers are still busy, and it starts working again when their results come in.

## Approvals

When Hermes needs a yes or no, the pet goes to the bench and holds up a sign that says Needs your
OK. Click the sign for Herald's own approval card, with the choices it offers anywhere else: Allow
once, Allow this session, Always allow and Deny, as the request allows. Answering here answers it
everywhere, and the card in the Hermes window goes away too. Nothing is ever answered for you, and
the sign and the card never take the keyboard, so a key pressed in another window cannot answer
them. Escape closes the card without answering.

Questions, passwords and secrets never reach the pets: the pet waits on the bench and you answer
in the Hermes window.

## Automations

Each automation on your Automations page stands in the Automations corner, at the front of the room
by the board. While a run is under way its pet is at work at the board ("Running"); between runs it
rests there, and its facts say when the last run was and whether it failed. Automations that run
when something happens are not shown as paused, though Hermes keeps them paused between events.

Automations send Hermes no step by step news, so the room only knows what the Automations page
knows: whether a run is under way, and when the last run happened and how it ended. Hermes counts a
run as under way until it ends or has been silent for five minutes. The room notices a run starting
within a few seconds, as soon as Hermes's automations change.

## Desks and meetings

Each document open in Herald Docs, Sheets or Slides, and each project open in Herald Canvas, stands
as a desk below its app, with the document's name over it (only the name: never where it is or what
is in it). A pet stands at a desk when it works on that document: when its step names the document,
when the latest command its conversation ran in that app named it, or, for a step on "the document
in front", the document in front of that app's window. Up to four desks stand under each app, as
many as fit the room; a document without a desk still has its pet at the app's station.

Two or more pets working on the same document meet at its desk, one on each side, and their tags say
"2 agents on Launch plan.docx". Turn the names on desks off in Settings > Pet Room to leave the
desks unnamed in the room's window.

Herald knows which conversation ran a command in Docs, Sheets, Slides or Canvas because the system
bridge sends it along with each command (see [the system bridge](../SYSTEM-BRIDGE.md)). With an
older bridge, pets still go to desks by their steps and the document in front.

## Hermes outside Herald

Settings > Pet Room > Show Hermes work outside Herald adds a lane at the right edge of the room for
Hermes at work in its other apps: messaging bots, the Hermes CLI and TUI, Hermes's own desktop app,
and automations Hermes's messaging gateway runs. It is off until you turn it on, and while it is off
the room never reads Hermes's list of sessions at all.

The lane is coarse, and says so at its top: it reads Hermes's session list once a minute and shows
each session's title, where it runs ("Telegram", "the Hermes CLI") and how active it is
("Telegram · active now", "the Hermes CLI · last active 25 minutes ago"), for sessions active in the
last hour.
It never shows steps, desks or what anyone wrote. Herald's own conversations stay in the room, and
runs of automations the room already shows stay at the Automations board. The titles are Hermes's
own: until Hermes names a new session, its title is the first line of the message that started it,
as in Hermes's other apps.

### Live steps

Settings > Pet Room > Live steps from Hermes outside Herald, under the lane's switch and off unless
you turn it on, lets that work show its steps too. Herald's bridge plugin runs in every Hermes app
that loads it (messaging bots, the Hermes CLI and TUI, automations Hermes's messaging gateway runs),
and while this is on it tells Herald which tool each piece of work is using, the helpers it starts
and the approvals it waits on. A pet then walks out of the lane to the station for its tool, with
its step in a bubble ("Running a command", "Reading Budget.xlsx"), helpers come in beside it and walk
their results back, and it returns to the lane when its turn ends. The lane's top says "Live steps
from Hermes in each app".

- **What it sends, and what it never sends.** The kind of event (a turn, a tool call, a helper or an
  approval wait starting or ending), Hermes's session ids, the tool's name, what the call works on
  cut to a file's name, a folder's name or a web site's name, how it ended, where it runs and when.
  Never what you or Hermes wrote, a command, a file's content, a search, a result, a helper's job
  or summary, or what an approval asks.
- **Approvals are shown, never answered here.** A pet waiting for your OK stands on the bench with a
  sign that says where to answer ("Needs your OK in the Hermes CLI"); the sign is not a button, and
  you answer in that app as you always do.
- **Off means off.** While it is off, Herald gives Hermes no way to reach it: the plugin in each
  Hermes app looks for a note from Herald saying live steps are on, finds none, and does nothing at
  all. Turning it off also takes back the key Herald gave out, so an app that still has it is turned
  away at once. Herald's own work is never sent this way; the room already sees it.

A helper outside Herald wears the lane's pet and is called "A helper outside Herald". Herald's
bridge plugin has to be the one in that Hermes app: Hermes apps on another computer, or on a Hermes
without the plugin, stay coarse ([the system bridge](../SYSTEM-BRIDGE.md#live-steps-for-the-pet-room)).

## The activity log and the time-lapse

Settings > Pet Room > Keep an activity log, off unless you turn it on, keeps a record of what the
room showed so you can play a day back. It keeps the kind of each agent, the area it worked in, its
steps and the names it worked on, hand-offs between agents and helpers, approval waits (never what
they asked), how helpers and automation runs ended, and where work outside Herald ran. It never keeps
titles, document names on desks, chat or file content, tool arguments, results or Hermes's thinking,
and every agent in it goes by a code that changes from day to day.

The log is a file a day in Herald's data folder (`room-log` in `~/.hermes/herald-os`), never in
Hermes's own folders. It keeps 7 days unless you pick 1, 3, 14 or 30, a day's file stops at 8 MB and
the whole log at 64 MB (the oldest days go first), and Delete activity log removes all of it at
once. While the log is on, the Hermes window keeps the room's feed running even with the room
closed, so what happens while you are elsewhere is logged too.

The **Time-lapse** button in the room's header (shown while the log is on or has days in it) plays a
day back in the room's window:

- the same room, clearly marked Replay, with the day and the time at the top and Back to live
  (or Escape) to return;
- play and pause (Space), speeds of 1 minute, 5 minutes, 15 minutes or 1 hour a second, a scrubber
  across the day that shows where the log ran and where it did not, the arrow keys to move a minute
  (a quarter of an hour with Shift, an hour with Page Up and Page Down), the previous and next
  logged stretch, and a pick of the days the log holds;
- honest gaps: where nothing was logged (before the log was on, while Herald was closed or Hermes
  disconnected, after a day's file filled up), the room is empty and says so ("Nothing was logged
  from 12:10 to 13:45");
- pets named by what they were ("A conversation", "A helper", "An automation"), never by title.

Pets in a replay never open a conversation or answer anything: the replay only reads the log.

## Cost meters

Settings > Pet Room > Show cost meters puts the tokens and cost Hermes counted for each piece of
work under its pet's name tag ("48k tokens · ~$0.05 est."), and Show the total adds them up in the
header ("In the room: 90.3k tokens · ~$0.09 est."). Both are off unless you turn them on, and the
screensaver never shows them.

- **Where the numbers come from.** A conversation's tokens from the running totals Hermes sends with
  each turn (its tooltip also says this turn's share), its cost from Hermes's session records; a
  helper's from what Hermes reports when it finishes; an automation's from its latest run; work
  outside Herald from Hermes's session records, read with the lane.
- **Estimates say so.** A cost Hermes estimated reads "~$0.05 est." and its tooltip says it is
  Hermes's estimate; one the provider billed reads "$0.05"; one included in a plan says so; and when
  Hermes does not know the cost, only the tokens show.
- **The total leaves helpers out:** Hermes adds a helper's cost to the conversation that started it.
  The total is an estimate when any part of it is.

While both are off, the room reads nothing extra for them. The room never asks Hermes for your
account's usage, which it would fetch over the network.

## The Room as the screensaver

Settings > Pet Room > Show the Pet Room as the screensaver turns Herald's screensaver into the room:
the scene alone, with no names, document names, facts or bubbles. Steps in the screensaver brings
back the bubbles that say what each pet is doing, and nothing else. Any key, click, scroll or move
of the mouse ends it, and nothing in it answers or opens: a pet waiting for your OK holds up a sign
with no words, which you answer once you are back.

While Herald Slides is presenting, or while the desktop pet is put away for a screen share, the
screensaver shows the clock instead. Herald knows of these two; it cannot tell when another app
shares your screen. When the screensaver starts, and whether it is on at all, stays in Settings >
General (see [Lock screen, idle and the screensaver](lock-and-idle.md)).

## Which pets

The room borrows the pets you have installed for Hermes; Settings > Pet has the petdex gallery. It
never installs a pet and never changes the pet Hermes shows on your desktop and in its other apps.
With no pet installed, the room still works and shows name tags, bubbles and signs.

Each kind of work has a pet: conversations, missions, helpers, automations and, with its lane on,
Hermes outside Herald. A conversation counts as a mission once it keeps a to-do list, as the
missions Herald starts do. Settings > Pet Room picks which pet each kind shows; left on Pick for me,
the room spreads your pets over the kinds. When several agents share a pet (with one pet installed,
they all do), each wears a colour of its own, and it keeps that colour while it is in the room.

Every pet the room needs loads beside the desktop pet and the pictures in Settings: a window keeps
up to four pets' pictures nobody is showing for reuse, and never decodes more than twelve at once. A
pet whose picture cannot be read (a damaged file, say) stands as a plain figure, grey or in the
colour it wears, with its tag, bubble and facts as usual, and Settings shows a paw for it.

## Settings

Settings > Pet Room:

- **Open the Pet Room.**
- **A pet for each kind of work**: conversations, missions, helpers, automations and, while the
  lane is on, Hermes outside Herald, each with a picture, from the pets you have installed or Pick
  for me.
- **Tell pets apart by colour**, for agents that share a pet.
- **Motion**: Full (pets walk between areas), Calm (they appear where they work, without walking) or
  Still (still pictures). With Reduce motion on, in Herald's Accessibility settings or the system's,
  the room is always still.
- **Show each step**: the bubble that says what each pet is doing. Off leaves the name tags, signs
  and facts.
- **Document names on desks**, on unless you turn it off.
- **Show Hermes work outside Herald**: the lane, off unless you turn it on, and under it **Live steps
  from Hermes outside Herald**, off unless you turn it on (see [Live steps](#live-steps)).
- **Keep an activity log**, off unless you turn it on, **Keep the log for** 1, 3, 7, 14 or 30 days,
  and **Delete activity log**, which asks once more and says how much the log takes (see [The
  activity log and the time-lapse](#the-activity-log-and-the-time-lapse)).
- **Show cost meters** and **Show the total**, both off unless you turn them on (see [Cost
  meters](#cost-meters)).
- **Show the Pet Room as the screensaver**, off unless you turn it on, and **Steps in the
  screensaver**.

## Commands and voice

| Command | What it does | Say |
| --- | --- | --- |
| `room.open` | Opens the Pet Room | "show the pet room", "open the pet room", "show what Hermes is doing" |
| `room.status` | Says how many agents are at work, waiting for you or idle, which automations are running, and what each one is doing; with the lane on, it adds the work active outside Herald, with its steps when live steps are on | "what is in the pet room", "what is Hermes doing" |

On Herald OS Linux, `herald-os os room.open` opens it from a terminal.

## What it shows, and what it does not

- Work that runs through Herald's own Hermes: the Hermes window's conversations and missions, their
  helpers, the desktop pet's chat and Herald Office's Ask Hermes, plus your automations. Hermes work
  elsewhere (messaging bots, the Hermes CLI and TUI, Hermes's own desktop app, and automations run
  by Hermes's messaging gateway) shows only when you turn the lane on, as titles and how active each
  one is, and with its steps only when you turn live steps on as well.
- Titles and steps only. The room never shows what you or Hermes wrote, what a file holds, a
  command's text or Hermes's thinking, and a web address shows as its site's name only. The one
  exception is a helper's result: its bubble shows the first sentence of Hermes's own summary, as
  the Hermes window does. An automation shows its name, never its instructions. A desk shows its
  document's name, never where it is, what is selected in it or what it says.
- If Hermes's tool progress is off (`display.tool_progress: off` in its config, or Hermes's focus
  mode), Hermes does not say which tools it uses, so pets cannot go to areas; the room says so at
  the top.
- Steps follow Hermes about a second behind for busy conversations and up to ten seconds for idle
  ones. When Hermes restarts, the room fills again from what Hermes lists. Live steps from outside
  Herald arrive within a second or so of the tool starting.
- The activity log and the time-lapse keep and show the same metadata as the room, minus titles and
  document names; cost meters show only numbers Hermes itself counted.

## Cost

The room asks Hermes about its work about once a second for each busy conversation, and every ten
seconds for idle ones; nothing at all while the window is closed, minimized or hidden. It reads your
automations every two minutes (every 30 seconds while one runs, and soon after they change) and each
automation's latest run every five minutes (every 15 seconds while it runs); the documents open in
Herald every ten seconds (every two while a pet works in Office or Canvas), which Herald answers
itself; and, with the lane on, Hermes's session list once a minute. Pets that rest draw nothing, and
all pets share one picture and one timer.

On an Apple Silicon Mac, an open room with four resting pets (two of them automations) and three
desks cost about 0.6% of one processor core in all, Hermes's share included, over the same Herald
with the room closed. Shown as the screensaver, the room cost about 0.65% more than the clock.

With the activity log on, the Hermes window feeds the room at the same pace while the room is
closed, minimized or hidden, and writes a few lines to the log when something changes. Live steps
cost the Hermes apps outside Herald nothing while they are off, and a few microseconds a hook while
they are on; Herald takes what they send on the same timer as its own news. Cost meters read
Hermes's session records about once a minute. On the same Mac, the window's own work with the log
on and the room closed was no more than with both off (1.28% of a core's time in either case), an
open room with resting pets, the lane, meters and the log added about 0.05 points to that, and a
time-lapse playing at a minute a second added about 1.2 points while it played.

## Linux notes

- The Pet Room is a window of its own, "Herald OS · Pet Room", with its own connection to Hermes.
  Herald's niri config opens it at a third of the screen beside your work; `Super+R` makes it wider.
  In a narrow room, long document names on desks are shortened.
- Its approval card answers through Hermes directly, and the card in the Hermes window goes away as
  soon as you answer.
- The Hermes window passes the room which conversation ran each Office and Canvas command, only
  while the room or the screensaver is open.
- The Hermes window keeps the activity log, with a feed of its own; the room's window reads the log
  for the time-lapse. Live steps from Hermes apps outside Herald reach the session's control socket
  and go straight to the room's window.
- The screensaver is a full screen window of its own, as the clock is.
