# Voice ("Jarvis mode")

Talk to Hermes and hear it answer, from anywhere in Herald OS. Hermes stays the brain in every
mode: the same sessions, tools, memory and approval cards; only the audio path changes.

## Starting a conversation

| How | Where |
| --- | --- |
| Global hotkey (`Alt+Space` by default) | Any app, while Herald OS runs |
| "Hey Hermes" wake word | Anywhere, when enabled in Settings > Voice |
| Microphone button | Menu bar, Overview composer, Hermes composer, Applications overlay |
| `herald-os voice [toggle\|start\|stop\|mute]`, `Mod+V` | Linux session |

While a conversation runs the orb sits at the bottom of the Hermes window: state (listening,
thinking, speaking), captions, mute, "stop talking" and end. Say "stop", "that's all" or
"never mind" to end it by voice. The menu-bar microphone lights whenever the mic is open.

After Hermes finishes speaking the mic keeps listening for a follow-up (8 s by default), then the
conversation closes on its own.

## Engines

### Free (default)

`mic -> transcription -> Hermes turn -> speech, streamed sentence by sentence`

- Turn latency is about two seconds (end-of-speech detection, transcription, first sentence).
- Speak over Hermes to interrupt it; the turn is stopped and your new request is sent.
- Nothing extra is billed. Speech providers come from the Hermes runtime's config and are chosen
  in Settings > Voice > Speech providers:

| Provider | Cost | Notes |
| --- | --- | --- |
| Nous subscription (`nous`) | Included | OpenAI `gpt-4o-mini-transcribe` / `gpt-4o-mini-tts` through the Nous gateway; needs a Nous Portal sign-in (`hermes portal`) with a plan that includes managed tools |
| On this device (`local` STT, `edge` TTS) | Free | faster-whisper runs offline; Edge neural voices need internet, no key |
| OpenAI / ElevenLabs / Groq / Mistral | Your key | Set the key in `~/.hermes/.env`; OpenAI and ElevenLabs stream PCM |
| NeuTTS / KittenTTS / Piper | Free, local | Install the matching extra in the Hermes venv |

If the configured provider cannot run (no API key, a managed gateway your account is not entitled
to, a missing package), Herald OS switches that setting to the free provider (`local` for speech
to text, `edge` for speech), tells you once, and retries. Pick a different provider in Settings
whenever you want it back.

#### When a voice fails

Speech goes down a chain, so a reply is heard even when a voice fails:

1. **The provider Hermes is set to use** (`tts.provider`).
2. **The free Edge voice**, when that provider is not set up (as above). A failure of the Edge voice
   itself is never treated as a setup problem: it needs no key, so there is nothing to switch to.
3. **The computer's own voice**, when Hermes's voice still fails, for whatever reason: Microsoft
   refusing the Edge voice (HTTP 403), no network, a missing `edge_tts` module, a provider that is
   down. On macOS that is `say`, in the voice chosen under System Settings > Accessibility > Spoken
   Content. On Linux it is espeak-ng (or espeak) in the system's language, else flite, which speaks
   only English and so only stands in for an English locale.

The same chain speaks conversation replies, spoken notifications and Settings > Voice > Say hello.
Every reply tries Hermes's voice first, so it is back as soon as it works again.

Electron main renders the system voice to WAV files a few sentences at a time, the text passed to
the program on stdin (at most 1,000 characters and 30 seconds a part, about five minutes a reply),
and they play on the player Hermes's whole-reply speech uses. So barge-in, the stop button and the
end of the conversation cut it off as they do any other voice, it plays on the same speakers, and
echo cancellation keeps it out of the microphone, which it could not do for a voice the system
played by itself.

The first time in a session the system voice stands in, a notice says so in plain words: "Microsoft's
free voice isn't working right now, so Herald OS is using your Mac's voice. Updating Hermes usually
fixes it." (on Linux, "the system voice"). When the computer has no voice of its own, or it fails
too, a notice says that instead, also once, and replies show in the captions without being spoken.
Neither repeats for later replies, conversations or notifications; the error itself goes to
`~/.hermes/logs/herald-os.log`. Say hello reports which voice spoke: Hermes's, or that it failed and
the system voice said hello instead.

The Herald OS Linux image lists flite for this, but not espeak-ng, so its system voice speaks English
only.

### Live (opt-in)

OpenAI `gpt-live-1` listens and speaks over WebRTC, full duplex, and delegates every real request
to Hermes. Replies start in under a second and interruptions feel natural.

- Cost: **$0.05 per minute** of open session, billed per second by OpenAI (about 15 s minimum per
  session). Hermes's own tokens are unchanged.
- Needs an OpenAI key (`OPENAI_API_KEY` or `voice.gpt_live.api_key` in Hermes config) and Hermes
  0.21.3 or newer (`hermes update`). The Nous gateway does not proxy Live sessions.
- Cost controls in Settings > Voice: the session closes after `Close after silence` seconds of
  quiet (45 s default) and new sessions are refused once today's `Daily cap` is spent (60 min
  default). The orb shows the session clock and today's estimate. When Live cannot start, the
  free engine is used and the reason is shown.

## Controlling the OS by voice

Every user-visible action in Herald OS is a command in one registry (`apps/desktop/src/store/os-commands.ts`,
catalogue under `apps/desktop/src/commands/`). Three things call it:

1. **The voice fast path.** Simple utterances match a command locally in under 100 ms and cost no
   tokens: "open missions", "show my memory", "open the terminal", "close this window", "remember
   that I prefer short answers", "pause the daily digest", "start a mission to …", "open Safari",
   "hide the sidebar", "switch to the live voice engine", "what's 15% of 340". Herald says a short
   acknowledgement ("Opening Missions.") or the answer. Anything that needs reasoning, is long, or
   is destructive goes to Hermes.
2. **Hermes itself** through the `os_ui` tool (bridge plugin): `list` the catalogue, read the
   screen `state`, `run` a command. Hermes uses it whenever you ask it to open, show, add, find or
   change something in the OS, and to show its work after its own memory / automation / file tools.
   Results (page, highlighted item, list data) flow back so it can answer precisely.
3. **The command bar** (Cmd+K, group "Do") and the `herald-os os <id> [json]` CLI on Linux.

You watch it happen: a caption at the top of the Hermes window names each action ("Remembered:
…", "Paused Daily digest") with its origin (voice / Hermes), the page switches, and the touched
item scrolls into view with a brief accent pulse. "Follow Hermes" (Settings > Voice) extends this to
typed conversations too.

**Typing and editing** act on the focused text field, the terminal, or the web page in front (the
field you were in before clicking the mic is remembered): "type how are you question mark",
"type ls -la and press enter", "new line", "press escape", "select all", "select the last word",
"copy", "cut", "paste", "undo", "redo", "delete that", "delete the last word", "clear the field",
"scroll down", "go to the top". Say "comma", "period", "question mark", "new line" for punctuation.
With Herald Docs, Sheets or Slides in front in the one-window desktop shell (macOS), dictation
(`Cmd+Ctrl+X`, or "start dictation") and "type …" go into the document itself, as one step to undo
and without the clipboard: at the caret in a Docs page (each "new line" starts a paragraph, or a
list's next item), into the active Sheets cell and on down the column (a number becomes a number,
"=SUM(B2:B9)" stays a formula, and the selection moves to the cell below so dictation carries on),
or into Slides: at the caret of the text box being edited, at the end of the selected text box,
shape or table, or else in a new text box on the slide, selected so more dictation carries on in
it. A cell being edited, the find bar, the speaker notes or any other field takes the words as
before; so does another app in front. In the Linux panels session the Office apps are windows of
their own and get dictation as typed keys.

**Files and apps stay inside Herald OS.** "Open hello.pdf" (or "open hello dot pdf", "open the file
report") finds the file by name in your home folder (Spotlight on macOS, a bounded `find` on Linux;
exact names beat partial ones, user folders beat caches) and shows PDFs, images, text and media in a
Herald OS viewer window (Chromium's PDF viewer, no network, no downloads). Other file types open in
Files with the file selected; say "open it in its app" to hand one to macOS. "Open Apps" is the
Herald OS app launcher. A transcript that looks like a web address but ends in a file extension
("www.openhello.pdf") is treated as a file. When Hermes calls `system_open` while the shell is
running, web pages open in a Herald OS window, files in the viewer and folders in Files; only a
named Mac app ("open it in Preview") leaves the OS.

**Documents go to Hermes whole.** "Find the invoice from Acme in my Downloads, rename it properly and
put it where it belongs", "file the invoices in this folder", "show me the receipts from the
plumber": the fast path never matches renaming, sorting or filing, and never treats a description
("the invoice from Acme") as a file name, so Hermes gets the sentence as said and reads the
documents (the `file-documents` skill). A real file name still opens instantly ("open
invoice.pdf"). Every spoken request also carries what is on screen as context for the model only
(the person's words stay as said): the folder the Files page shows and the selected file, or the
document in the viewer in front, so "this folder" and "this file" mean what you are looking at.
Moving or renaming files shows the approval card (see below). Right after Hermes has done
something, "undo that" (or "take that back") goes to Hermes, which reverses its own change; at
other times it is the text field's undo.

**Herald Office work goes to Hermes too.** Asking to make or change a document, a sheet or a deck
sends the sentence to Hermes as said; it never fills a command's slot or starts a build: "make a
budget for my trip", "write a cover letter", "draft a report on our Q3 numbers", "create a
presentation about volcanoes", "turn this into slides", "make this a table", "add a total row", "add
a column for tax", "fill in the rest of this column", "sum the March sales", "sort this by date",
"translate this paragraph into Spanish", "make the heading bold", "make slide 3 a two-column
comparison", "hide column C". The app commands stay instant: "new document", "new spreadsheet",
"new presentation", "new slide", "open Herald Docs", "open Sheets", "open Slides", "save the
document", "save the presentation", "undo"; "open budget.xlsx" finds the file and shows it in
Files, where Edit in Herald Sheets opens it. Every spoken request also carries what Herald Office
has open, for the model only and before the screen line: the document in front with its file, its
sheet and selection (or the selected text, or the slide), and the other open documents, so "this
sheet", "this paragraph" and "the selection" mean what you are looking at.

**Simple math is answered at once.** A spoken sum goes straight to Herald Calc's exact engine
(`calc.eval`) and Herald speaks the answer with no Hermes turn: "what's 15% of 340" ("15% of 340 is
51"), "what is two plus two", "three hundred and forty divided by eight", "half of 340", "84.50 plus
15%", "2,400 plus 180 split three ways", "two to the power of ten", "the square root of 144", "how
many miles is 10 km", "how many cups in a litre", "convert 100 dollars to euros" (at the European
Central Bank's reference rates), "what's 5 foot 10 in centimetres" (a plain number before "in" and a
length is inches, as in the notepad, and the answer says so), "what time is it in Tokyo", "what's
9am Sydney in New York", "how many days until December 25th", "what date is 90 days from today".
"Calculate …" and "work out …" count too. The grammar (`lib/voice/math.ts`) reads number words ("fifteen", "three hundred and
forty", "one point five", "a million", "two and a half", "half"), spoken operators (plus, minus,
take away, times, divided by, over, to the power of, squared, cubed, square root of, percent, of,
off, split N ways) and the units, currencies and places Herald Calc knows; every other word sends
the sentence to Hermes, and so does anything over 16 words. What goes to Hermes, as said, is math
that needs thought or context: the person's own numbers ("what's 15% of my rent", "what's the
total of my invoices"), advice ("how much should I tip"), and why or explain ("why is 0.1 plus 0.2
not 0.3 in JavaScript", "explain compound interest"). Hermes then does the math with the same
engine (the `calc` tool). A sum the engine cannot read goes to Hermes as well. Starting a
conversation loads the engine, so the first answer is as quick as the rest; each answer shows in the
caption and is kept in Herald Calc's history. "Open the calculator", "open the scientific
calculator", "open the graphing calculator", "show my calculations" and "what was my last
calculation" open Herald Calc or read from its history.

**Approvals by voice.** While one of the conversation's approval cards is up, a short answer decides
it instead of interrupting Hermes: "yes", "yes, go ahead", "do it", "approve" or "okay" allow it
once; "no", "cancel", "don't" or "stop" deny it. The card says so ("Or say yes…") while a
conversation runs. Anything longer ("yes, but call it Acme") interrupts and becomes the next request,
as before. A spoken yes never picks "allow for this session" or "always"; those stay on the card's
buttons, and cards from other sessions (a mission in the background) are never answered by voice.

**Build something and watch it happen.** "Create a website for a hair salon" (also "build me …",
"make an app that …", "start a project to …") creates a project folder under `~/Projects`
(Settings > General > Projects folder), starts a Hermes session working there and opens the
**Studio**, one large window per session:

- Files: the project tree; new files are marked A, edited ones M, the one being written pulses.
- Code: the file Hermes is writing appears as it types, then syntax-coloured, with the lines each
  edit changed marked and scrolled into view. It follows Hermes from file to file; the pin keeps
  it on one file. One click opens it in your code editor.
- Terminal: every command Hermes ran with its output, plus a live read-only tab per background
  process (the dev server).
- Preview: the running site. The dev server's address is picked up from its output (or Hermes names
  it with `studio.preview`); a static site previews its `index.html`. It waits while the server
  starts and refreshes after each change.
- Header: what Hermes is doing now, the todo progress, a box to ask for a change, Stop, and the
  conversation.

Keep talking while it works: "make the header pink", "stop", "show me the code" (`studio.open`
brings the Studio back), "close the studio". A session you did not start with "build" shows a
caption the first time Hermes writes code; say "show me" to open its Studio.

**Windows** respond to plain verbs on the window in front: "close", "minimize" (or "minimise"),
"expand"/"maximize", "restore", "fullscreen", "go back".

The complete, always-current list is **Settings > Voice commands** (say "what can I say"): every
command grouped by area, the words to say, what it does, whether it asks first, and a Try button.

Command families: `page.open|back`, `window.focus|close|minimize|maximize|restore`, `text.type|newLine`,
`key.press`, `edit.selectAll|select|deselect|copy|cut|paste|undo|redo|delete`, `view.scroll`,
`overlay.*`, `sidebar.toggle`, `space.switch`, `help.commands`; `chat.new|open|stop|popout`, `bots.list|chat`; `mission.start|open|list|pause|markReviewed`;
`memory.show|search|add|update|forget`; `file.open|openExternal`, `files.open|show|search|reveal|newFolder`; `automation.list|show|run|pause|resume|create|delete`;
`connection.list|show|enable|disable`; `build.start`, `studio.open|preview|file|close`; `native.launch`, `web.open`; `settings.open`, `theme.set`, `accent.set`,
`motion.reduce`, `dock.autoHide`, `voice.engine.set`, `voice.wake.set`; `agents.pauseAll`, `agents.toolSearch.set`;
`docs.open|new|save`, `sheets.open|new|save`, `slides.open|new|addSlide|save` and the rest of `docs.*`, `sheets.*`, `slides.*`, `office.list` for Hermes;
`calc.eval|convert|plot|open|history`.

Tiers: `read` and `act` commands run immediately (audited when Hermes runs them); `mutate` (add a
memory, pause an automation, change a setting) runs and is shown in the caption; `destructive`
(forget, delete, trash) never runs from the fast path and asks for approval when Hermes runs it.

## Settings

Settings > Voice: enable, microphone permission, engine, wake word, hotkey (Electron accelerator
syntax), follow-up window, speak notifications aloud, speech providers, Live limits, the microphone
the voice listens through with a level bar, and two test buttons ("Say hello", "Start talking").

Preferences live in Herald OS's `prefs.json` (`voice.*`). Speech providers and the wake word's
enabled flag are written to the Hermes runtime's `config.yaml` (`stt.provider`, `tts.provider`,
`wake_word.enabled`) so `hermes tools` and the CLI see the same choice.

### Choosing the microphone

Hermes is the brain in every mode, so a conversation's microphone is Herald OS's to choose. On
Herald OS Linux the shell *is* the session, so the Sound panel sets the machine's PipeWire default
and that is what the voice uses. Everywhere else Herald OS is one app among others, so its choice
belongs to Herald OS alone: `voice.inputDevice` in `prefs.json`, applied with Chromium's
`getUserMedia({ deviceId: { exact } })`, and the machine's default is left to the system.

- **Automatic** (`null`, the default) follows the system default, so wearing a headset and having
  the system pick it up is enough.
- A **chosen device wins while it is connected**, even when another device is plugged in later.
  That is what makes "AirPods for the speakers, a desk microphone for the voice" possible.
- A chosen device that **goes away**, or cannot be opened (away, busy, a device error), falls back
  to the system default and is remembered; when it comes back it is used again. The fallback is
  quiet: the panel names the device in use and no notice is posted. A notice is posted only when
  not even the system default can be opened (a revoked permission, say), and then a GPT-Live
  session ends with that reason instead of sending a stopped track. The wake word and a chained
  conversation are told as well: the wake word says in Settings that it cannot hear and stays
  subscribed, and the next device change or pick opens the microphone again (under the same
  guard), after which it hears once more; or when the system keeps
  changing device (three of its reopens in ten seconds). Picks the person makes never count toward
  that guard, however many in a row.
- A device that disappears mid-conversation reopens the stream immediately, and so does a new
  choice; a change caused by the system waits for the conversation to end. A GPT-Live session keeps
  running across a reopen (its WebRTC sender swaps in the new track), and a muted conversation stays
  muted on the new device.
- Device ids are stable only for one origin, so the name is the fallback identity: if the id is gone
  but exactly one device with the same name is there, that device is used and the stored id is
  rewritten to its new one, so both pickers show it as chosen. With two devices of that name the
  choice counts as not connected rather than being guessed.
- A device is the same one when its group matches, or, for devices that report no group, its id.
- The picker shows the devices as Chromium reports them, with its own `(Bluetooth)`, `(Built-in)`
  and `(Virtual)` suffixes; virtual devices are ordered last but never hidden.
- The microphone is only ever opened by a conversation or by the armed wake word, so the level bar
  is live exactly while the microphone is open, and "voice off" still means it is never opened.

The same control is in the menu bar's Sound panel (macOS and the other desktop hosts) and in
Settings > Voice, and the `audio.input` and `audio.devices` commands reach it without the mouse.

Local transcription accuracy: Hermes's default local model (`base`) mishears short commands. Once,
when voice is on and `stt.provider` is `local`, Herald OS sets `stt.local.model: small.en` (about
0.8 s per sentence on a laptop CPU) unless you chose another model, and writes a Herald OS
vocabulary to `stt.local.initial_prompt` unless you wrote your own. Settings > Voice > Transcription
model switches between fast, accurate, multilingual and most-accurate models.

## Requirements and troubleshooting

- macOS asks for microphone access on the first conversation. If it was denied: System Settings >
  Privacy & Security > Microphone > Herald OS.
- `npm run bootstrap` reports the runtime version and whether `openwakeword`, `faster_whisper` and
  `edge_tts` import in the Hermes venv (`pip install 'hermes-agent[voice]'` inside the venv adds them).
  Today's Hermes installs keep no venv in the checkout; there
  `hermes pm install --extra voice --extra edge-tts --extra wake-openwakeword` adds them, and
  `hermes update` keeps them. The Herald OS image adds them at its first boot either way.
- **Microsoft's free voice returns 403**: the system voice speaks instead, and herald-os.log shows
  `TTS generation failed (edge): 403`. Microsoft changed what its read-aloud service asks for, and
  Hermes needs edge-tts 7.3.0 or newer to answer it. Until Hermes ships a newer edge-tts, upgrade it in
  Hermes's own environment with Hermes's uv:

  ```bash
  ~/.hermes/bin/uv pip install --python <hermes venv python> "edge-tts>=7.3.1"
  ```

  `<hermes venv python>` is `venv/bin/python` in a Hermes checkout that has a venv, or the
  `venv/bin/python` under `~/.hermes/installs/<install>/environments/<environment>/` for an install
  `hermes pm` manages. A `hermes update` may put the older edge-tts back until Hermes raises its pin,
  so run the upgrade again if the 403 returns. Herald OS never changes Hermes's environment itself.
- When the model provider is signed out (expired or revoked login), Herald OS shows its sign-in
  card: one click opens the provider's page with a one-time code inside Herald OS, as a Herald OS
  window beside the card (never the system browser), and both the page and the card close
  themselves once the sign-in is approved. The voice says so too instead of failing silently.
  Settings > Hermes & agents > Model provider shows the current state and a Sign in button, and
  switches to another provider.
- The wake word runs inside the Hermes runtime (openWakeWord, on-device). On runtimes older than
  0.21.3 the runtime opens the host mic itself; newer ones take audio from Herald OS. Only one
  Hermes client can own the detector at a time.
- A conversation that hears nothing closes with "Heard nothing": the microphone opened but no speech
  reached the endpointing. Check the level meter in Settings > Voice or the Sound panel, and that
  the device in use is the one you are speaking into. A device that is virtual (BlackHole, a screen
  recorder) or asleep delivers a flat signal, which looks the same as a silent room.

## Architecture

```
apps/desktop/src/store/voice.ts          state machine, hotkey/CLI commands, announcements, Live accounting
apps/desktop/src/store/wake.ts           wake.start / wake.feed / wake.detected
apps/desktop/src/store/audio-devices.ts  which microphones exist, which one is used, the level bar
apps/desktop/src/lib/audio-devices.ts    device list, identity of a stored choice, name matcher (pure)
apps/desktop/src/lib/voice/audio-capture.ts   one mic graph (AudioWorklet -> 16 kHz int16 frames)
apps/desktop/src/lib/voice/capture-policy.ts  when to reopen the mic and when to wait (pure)
apps/desktop/src/lib/voice/vad.ts        energy endpointing (utterance start/end, barge-in)
apps/desktop/src/lib/voice/chained-engine.ts  free engine
apps/desktop/src/lib/voice/live-engine.ts     GPT-Live engine (WebRTC + delegation loop)
apps/desktop/src/lib/voice/speak-stream.ts    /api/audio/speak-stream player, POST /api/audio/speak fallback
apps/desktop/src/lib/voice/speak-fallback.ts  the speech chain (provider, free voice, system voice) and its notices
apps/desktop/src/lib/voice/system-voice.ts    the computer's own voice, a few sentences at a time
apps/desktop/electron/platform/system-voice.ts  say / espeak-ng / flite rendered to WAV in main
apps/desktop/src/lib/voice/speech-text.ts     sanitizer, sentence chunker, commentary chunking, stop phrases
apps/desktop/src/lib/voice/math.ts            spoken math: the sentence Herald Calc's engine reads, or null (pure)
apps/desktop/src/features/voice/               VoiceOrb, MicButton, VoiceIndicator
apps/desktop/src/features/office/typing.ts     dictation into the Docs page, Sheets cell or Slides text box in front
apps/desktop/electron/ipc/voice.ts        mic permission, audio WebSocket URL, global hotkey
```

Decisions: `docs/DECISIONS.md` ADR-013, ADR-024, ADR-028 (and the ADR-007 amendment).
