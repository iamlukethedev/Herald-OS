# Talking to Hermes

Hermes is the agent at the centre of Herald OS. Type or say what you want, and it answers, opens
things, looks things up on the computer and, when something would change, asks you first.

## Three ways in

- **The command bar:** `Cmd+K` on a Mac, `Super+Shift+Space` (or `Ctrl+K`) on Herald OS Linux. Type
  the name of an app, a page or a setting to go there, or a question or a request for Hermes. Type
  `/` for Hermes's commands and skills. Escape closes it.
- **The Hermes page:** `Cmd+2` on a Mac, `Ctrl+2` on Linux. A conversation on the left and what
  Hermes made on the right. Enter sends, `Shift+Enter` starts a new line, and the paperclip attaches
  files.
- **Your voice:** press the voice key (`Alt+Space` on a Mac, `Super+V` on Linux) and speak. With the
  wake word on, "hey Hermes" works too. Hermes answers out loud and can work the interface: "open
  missions", "switch to the Dusk theme".

On Linux, `Super+Space` asks Hermes about the window in front, and `Super+Shift+S` (`Cmd+Shift+S` on
a Mac) about a part of the screen you select.

## Conversations

New conversation, at the top of the Hermes page, starts afresh. The **⋯** menu beside it renames the
conversation, deletes it, or pops it out into a window of its own that floats over everything else;
**Sessions…** lists your earlier conversations to go back to. The command bar's Recent sessions
does the same.

## Approvals

Reading and opening things just happen. When Hermes wants to change something, such as moving or
renaming files, a card asks first:

- **Allow once:** this time only.
- **Allow this session:** the same kind of action, for the rest of this conversation.
- **Always allow:** from now on.
- **Deny:** do not do it. Hermes is told and carries on, or asks what you would like instead.

Destructive actions (moving files to the Trash, stopping a program) ask every time, without the
session and always choices. With voice on, say "yes" to allow once or "no" to deny. Hermes may also
ask a question, or for your administrator password for a system task; type it into the card, never
into the chat. [Privacy and the audit log](privacy.md) explains the rules.

A card never takes the keyboard from a field you are typing in, and never puts it on one of its
answers, so a key meant for something else cannot answer it. To reach the card from the keyboard,
press `Cmd+Option+A` on a Mac or `Super+Shift+A` on Herald OS Linux (or run **Go to the waiting
request** from the command bar), then press Tab to get to an answer. When the card goes, the
keyboard returns to where it was. Screen readers announce each card once as it arrives: what Hermes
asks, how many more are waiting, and the keys that go to it.

## Voice

Settings > Voice turns voice on (the microphone is never opened while it is off), and its **Try it**
buttons check that it works.

- **Engines:** Free transcribes what you say with the speech-to-text provider you pick there, and
  speaks Hermes's reply as it comes, at no extra cost. Live is OpenAI's realtime voice model, which
  needs an OpenAI key, costs by the minute and has a daily cap you set.
- **Wake word:** off until you turn it on; "hey Hermes", heard on this computer.
- **Global hotkey:** `Alt+Space` unless you change it; on Herald OS Linux, `Super+V` as well.
- **Follow-up window:** how many seconds Hermes keeps listening after it answers, so you can carry
  on without the key.
- **What you can say:** Show commands lists every voice command with examples, or say "what can I
  say".
- **When a voice fails:** the reply is spoken in your computer's own voice when it has one for your
  language, and a notice says so once. When it is Microsoft's free voice that failed, updating Hermes
  usually brings it back.

[docs/VOICE.md](../VOICE.md) has the details.

## Other bots

Each Hermes profile is a bot with its own memory, skills and model; see
[Talking to your other bots](README.md#talking-to-your-other-bots).

## The model

Hermes uses whichever model provider you signed in with. Settings > Hermes & agents > Model provider
changes it, and Preferred model picks the model; see the [FAQ](faq.md).
