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
   "hide the sidebar", "switch to the live voice engine". Hermes hears a short acknowledgement
   ("Opening Missions."). Anything that needs reasoning, is long, or is destructive goes to Hermes.
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
"translate this paragraph into Spanish", "make the heading bold". The app commands stay instant:
"new document", "new spreadsheet", "open Herald Docs", "open Sheets", "save the document", "undo",
"open budget.xlsx". Every spoken request also carries what Herald Office has open, for the model
only and before the screen line: the document in front with its file, its sheet and selection (or
the selected text, or the slide), and the other open documents, so "this sheet", "this paragraph"
and "the selection" mean what you are looking at.

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
`overlay.*`, `sidebar.toggle`, `space.switch`, `help.commands`; `chat.new|open|stop|popout`; `mission.start|open|list|pause|markReviewed`;
`memory.show|search|add|update|forget`; `file.open|openExternal`, `files.open|show|search|reveal|newFolder`; `automation.list|show|run|pause|resume|create|delete`;
`connection.list|show|enable|disable`; `build.start`, `studio.open|preview|file|close`; `native.launch`, `web.open`; `settings.open`, `theme.set`, `accent.set`,
`motion.reduce`, `dock.autoHide`, `voice.engine.set`, `voice.wake.set`; `agents.pauseAll`, `agents.toolSearch.set`;
`docs.open|new|save`, `sheets.open|new|save` and the rest of `docs.*`, `sheets.*`, `office.list` for Hermes.

Tiers: `read` and `act` commands run immediately (audited when Hermes runs them); `mutate` (add a
memory, pause an automation, change a setting) runs and is shown in the caption; `destructive`
(forget, delete, trash) never runs from the fast path and asks for approval when Hermes runs it.

## Settings

Settings > Voice: enable, microphone permission, engine, wake word, hotkey (Electron accelerator
syntax), follow-up window, speak notifications aloud, speech providers, Live limits, and two test
buttons ("Say hello", "Start talking").

Preferences live in Herald OS's `prefs.json` (`voice.*`). Speech providers and the wake word's
enabled flag are written to the Hermes runtime's `config.yaml` (`stt.provider`, `tts.provider`,
`wake_word.enabled`) so `hermes tools` and the CLI see the same choice.

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
- When the model provider is signed out (expired or revoked login), Herald OS shows its sign-in
  card: one click opens the provider's page with a one-time code inside Herald OS, as a Herald OS
  window beside the card (never the system browser), and both the page and the card close
  themselves once the sign-in is approved. The voice says so too instead of failing silently.
  Settings > Hermes & agents > Account shows the current state and a Sign in button.
- The wake word runs inside the Hermes runtime (openWakeWord, on-device). On runtimes older than
  0.21.3 the runtime opens the host mic itself; newer ones take audio from Herald OS. Only one
  Hermes client can own the detector at a time.

## Architecture

```
apps/desktop/src/store/voice.ts          state machine, hotkey/CLI commands, announcements, Live accounting
apps/desktop/src/store/wake.ts           wake.start / wake.feed / wake.detected
apps/desktop/src/lib/voice/audio-capture.ts   one mic graph (AudioWorklet -> 16 kHz int16 frames)
apps/desktop/src/lib/voice/vad.ts        energy endpointing (utterance start/end, barge-in)
apps/desktop/src/lib/voice/chained-engine.ts  free engine
apps/desktop/src/lib/voice/live-engine.ts     GPT-Live engine (WebRTC + delegation loop)
apps/desktop/src/lib/voice/speak-stream.ts    /api/audio/speak-stream player, POST /api/audio/speak fallback
apps/desktop/src/lib/voice/speech-text.ts     sanitizer, sentence chunker, commentary chunking, stop phrases
apps/desktop/src/features/voice/               VoiceOrb, MicButton, VoiceIndicator
apps/desktop/src/features/office/typing.ts     dictation into the Docs page, Sheets cell or Slides text box in front
apps/desktop/electron/ipc/voice.ts        mic permission, audio WebSocket URL, global hotkey
```

Decisions: `docs/DECISIONS.md` ADR-013 (and the ADR-007 amendment).
