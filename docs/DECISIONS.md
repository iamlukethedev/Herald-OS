# Architecture Decision Records

Short records of the decisions that shape Herald OS. Newest last.

## ADR-001: Consume upstream Hermes, do not fork it

Herald OS runs against the user's installed Hermes runtime (`$HERMES_HOME/hermes-agent`), which
`hermes update` keeps current. The only upstream code compiled into the shell is
`apps/shared/src` (JSON-RPC client and generated contract), vendored as a pinned snapshot in
`upstream/` and refreshed by `scripts/sync-upstream.sh`. Rationale: the runtime moves fast
(facade-plus-siblings decomposition, ~39k tests); a fork would fall behind within weeks, and the
upstream wire contract is already stable and generated.

## ADR-002: New lean shell instead of lifting the Hermes Desktop renderer

Hermes Desktop's renderer is ~585k lines and its chat, session and store layers are coupled to a
multi-connection pane shell. Herald OS needs a fullscreen environment with a different information
architecture, so it builds its own renderer on the same transport. Desktop is used as a reference
for patterns (backend ladder, ready handshake, terminal IPC, design tokens), not copied.

## ADR-003: Sessions use `source: "herald_os"`

Upstream folds the `desktop_ui` toolset into sessions whose source is `desktop`. Those tools need
client handlers that only Hermes Desktop implements. Herald OS declares its own source so the agent
never sees tools it cannot complete.

## ADR-004: The system bridge is an out-of-tree plugin executing on the backend host

The bridge registers tools with `ctx.register_tool(..., toolset="herald_os")` and never touches
core files. In Alpha the backend always runs on the same Mac as the shell, so the tools execute
server-side behind a `HostAdapter` abstraction. Client-side execution (for remote backends) is
deferred until upstream exposes a generic plugin server-request hook; the adapter boundary keeps
that move mechanical.

Amendment (session scope): the tools are offered and run only in sessions Herald OS starts. Hermes
enables a plugin toolset on every platform that has not saved a list without it, and the backend
shares the `cli` platform's list with the `hermes` CLI, so the person's Telegram, Discord, cron and
terminal sessions got the system tools, with read and act tiers running unprompted. No toolset list
can say "Herald OS sessions only", and `HERALD_OS=1` is not enough either: the backend runs cron
in-process, and a messaging gateway it starts inherits its environment. Every handler is wrapped to
run only when the turn's bound session source is `herald_os` (ADR-003), read through
`gateway.session_context.get_session_env` as Hermes's own tools read it; the availability check hides
the schemas from other surfaces and is registered uncached (`tools.registry.no_cache_check_fn`) so
one session's verdict is never served to another. Proposed upstream: pass the session source to
handlers with the other context keywords, or let a toolset declare the session sources it serves.

## ADR-005: Permissions reuse the upstream approval gate

Rather than inventing a parallel confirmation channel, mutating and destructive bridge operations
call `tools.approval.request_tool_approval`. The request surfaces to the shell as the standard
`approval` server request (once / session / always / deny), so approvals for shell commands and
for system-bridge actions share one card, one allowlist and one audit path. Destructive actions
use a per-call `rule_key` so "always" cannot persist for them.

## ADR-006: Fullscreen, not kiosk

Herald OS launches fullscreen and frameless but always allows leaving (`Cmd+Ctrl+F` toggles
fullscreen, `Cmd+Q` quits). Alpha runs on top of the user's macOS session and must never trap them.

## ADR-007: REST runs in Electron main

The renderer gets a `rest(method, path, body)` capability, and main adds the session token to each
request, so renderer code never handles the token for REST. The renderer does see the token inside
the gateway WebSocket URL it dials for streaming (the gateway authenticates WebSockets by query
string), so this is not a credential boundary against a compromised renderer. What protects the
backend is that it listens on 127.0.0.1 only and the token changes on every launch.

Amendment (voice): main also mints the tokenized URL for the backend's `/api/audio/speak-stream`
WebSocket (`window.heraldOS.voice.audioWsUrl`). The renderer already dials the gateway WebSocket
with the same loopback token, so this widens nothing; a WebSocket proxied through main would add
a copy of every PCM frame for no security gain. REST stays in main.

## ADR-009: Answer both request contracts (server requests and legacy events)

The pinned upstream snapshot delivers `approval` / `clarify` / `sudo` / `secret` as server-to-client
JSON-RPC requests. The runtime most users have installed today (0.21.0) still emits them as
`<kind>.request` events answered through `<kind>.respond` RPCs. Herald OS folds the legacy shape
into the same `ServerRequest` object (`apps/desktop/src/lib/legacy-requests.ts`), so cards and stores
have one code path and an older runtime keeps working until `hermes update` moves it forward.
The fallback is narrow, named, and covered by unit tests, as upstream's compatibility rule asks.

## ADR-010: System tools stay directly callable

Upstream defers plugin and MCP tools behind its Tool Search bridge (`tool_search` /
`tool_describe` / `tool_call`) to protect the prompt budget. Deferred, the model reliably fell back
to `terminal` for tasks the bridge handles better (a `find` over three folders instead of a
Spotlight screenshot query). There is no per-plugin "keep direct" knob upstream, so bootstrap sets
`tools.tool_search.enabled: off` and Settings exposes the switch. Cost: ~5k prompt tokens for the
eight schemas, cache-stable across a conversation. Proposed upstream: let a plugin manifest declare
`direct_toolsets`, or extend `_DIRECT_SURFACE_TOOLSETS` with session-source-gated toolsets.

Amendment (visible and reversible): the setting stays global, because upstream still has no
per-session or per-plugin switch and `tools.tool_search.defer` can only add tools to the deferred
set. With the tools kept to Herald OS sessions (ADR-004 amendment) it no longer puts Herald OS's
schemas into other sessions; what it still changes there is that their own plugin and MCP tools are
listed directly. So every setup (bootstrap, the app's first start, `herald-os setup`) says what each
step changes, stops at the first `hermes` step that fails, and writes the value it found to
`$HERMES_HOME/herald-os/tool-search-before` before turning it off; Settings > Hermes & agents > Tool
search (and the `agents.toolSearch.set` command) is the promised switch, and `herald-os setup --undo` puts
the value back with the rest. docs/SYSTEM-BRIDGE.md lists everything Herald OS changes in Hermes.

## ADR-011: Backend is spawned with HERMES_DESKTOP=1

Upstream keys three behaviours on this flag: the loopback token-auth exemption when a public
dashboard URL is configured, the in-process cron ticker (no gateway is running), and orphan
reaping of backends the app previously spawned. Herald OS owns its backend exactly the way Hermes
Desktop does, so it sets the flag (plus `HERALD_OS=1` for its own consumers). Session platform is
still taken from `source: "herald_os"`, never from this env var, in line with upstream's
"surface capability is a property of the session" rule.

## ADR-008: Platform abstraction in two places

Machine facts and actions used by the shell (installed apps, system stats, open/reveal) go through
`apps/desktop/electron/platform/HostPlatform`; agent-facing capabilities go through the plugin's
`HostAdapter`. Both have `darwin` and `linux` implementations and a typed stub for `win32`, so the
Windows future has a place to land without touching call sites.

## ADR-012: Herald OS Linux Stage 1 is a session, not a distribution

The first Linux target boots a stock Fedora Cloud image into the Herald OS shell as the only
session. Kernel, systemd, NetworkManager and packaging stay Fedora's; Herald OS owns what the user
sees. This proves the experience before any security or packaging work. See `docs/LINUX.md`.

- **Fedora Cloud Base + cloud-init, not the interactive installer.** The seed ISO creates the user
  and runs `linux/provision.sh` unattended, so a VM is reproducible from two scripts and works in
  both QEMU (scriptable) and UTM (nicer window) from the same qcow2.
- **`cage` as the Stage 1 compositor.** A kiosk compositor gives the shell the whole output with no
  code of our own; foreign apps stack fullscreen on top. Window management between foreign apps
  needs our own wlroots compositor and is deferred to Stage 2 with the capability broker.
- **`greetd` autologin.** `default_session` runs the compositor as the `hermes` user on VT1 and
  respawns it when it exits; there is no greeter UI. Crash recovery for free.
- **Electron on Wayland via Ozone, kiosk mode gated by `HERALD_OS_KIOSK=1`.** The same shell binary
  runs windowed on macOS and as the session on Linux; `window.ts` branches on the env var, not the
  platform, so a Linux developer can still run it windowed under GNOME.
- **The backend stays shell-managed.** `hermes serve` is spawned by Electron exactly as on macOS.
  A systemd user unit would add a second lifecycle model before the broker (Stage 2) gives it a
  reason to exist.
- **SELinux permissive on the Stage 1 VM.** greetd and cage have no tailored policy; enforcing
  mode blocks the session on Fedora. Writing policy is part of Stage 2's sandboxing work.
- **Repo copied into the VM, not used in place.** Native modules (`node-pty`, Electron) must be
  installed on Linux; rsync over SSH (`linux/dev/push.sh`) or from the VirtioFS share
  (`herald-os-sync`) keeps one source of truth on the Mac.

## ADR-013: Two voice engines behind one voice core; the free one is the default

Herald OS talks and listens through `apps/desktop/src/store/voice.ts` and two interchangeable engines
(`apps/desktop/src/lib/voice/*-engine.ts`). Hermes is the brain in both: sessions, tools, memory and
approvals never move.

- **Chained (default, no extra cost).** Renderer mic -> energy endpointing -> `POST
  /api/audio/transcribe` -> `prompt.submit` with `surface: "voice-live"` (upstream's spoken-reply
  note: short, no markdown) -> `/api/audio/speak-stream` sentence by sentence while the reply
  streams. Providers are whatever `stt.provider` / `tts.provider` say in the runtime's config
  (Nous-managed OpenAI audio for subscribers, `local` faster-whisper and `edge` for free, keys for
  the rest). Turn latency is about two seconds; barge-in and an end-of-speech cue keep it
  conversational.
- **Live (opt-in, $0.05 per open minute).** OpenAI `gpt-live-1` over WebRTC with client
  delegation, exactly the contract upstream's Desktop implements: every `session.delegation.created`
  becomes a Hermes turn and the reply returns as `session.commentary.append`. It is the only path
  with true full duplex and sub-second replies, and the only one that costs per minute, so the
  engine opens a session only for a conversation, closes it after `liveIdleSeconds` of silence,
  refuses to open past `liveDailyCapMinutes`, and shows the running meter on the orb.
- **Rejected: gpt-realtime as the brain.** Cheaper audio, but it would either replace Hermes's
  tools and memory or need a second function-call bridge to reach them.
- **Wake word stays in the runtime.** `wake.start` / `wake.feed` / `wake.detected` with
  openWakeWord's bundled "hey hermes" model; the shell streams 16 kHz PCM when the runtime asks
  for client capture and otherwise lets it open the host mic. No second detector to maintain.
- **One microphone graph.** `audio-capture.ts` opens the mic once and fans frames out to the wake
  feed, the utterance recorder, the barge-in monitor and the WebRTC sender, so the menu-bar
  indicator is literally "the mic is open".
- **Config writes go through `PUT /api/config`** (deep merge), the same path the Hermes dashboard
  uses, so `hermes tools` and Herald OS Settings never fight over the file.

## ADR-014: One command registry; the agent drives the UI through a control socket

Voice control of the OS needs the shell's actions to be nameable and callable from outside the
component that renders them. Every user-visible action is therefore an `OsCommand` in one registry
(`apps/desktop/src/store/os-commands.ts`; catalogue under `apps/desktop/src/commands/`) with typed
arguments, a permission tier and a `CommandResult` the caller can speak or show. Inline page
handlers that voice needed (automations, connections, mission start, pause-all, the panels
`ShellCommand` switch) moved into stores so the registry, the pages and the command bar share them.

- **Fast path before the model.** A pure matcher (`lib/voice/intents.ts`) compiles each command's
  phrases into whole-utterance grammars. A confident match runs locally (no tokens, under 100 ms)
  and the voice speaks the result; destructive commands never match, and long or reasoning-shaped
  utterances fall through to Hermes. A failed run also falls through, so the words are never lost.
- **Agent -> UI over the control socket, in both shell modes.** Hermes runs in the backend and had
  no way to reach the UI on macOS (the Linux `ControlSocket` was panels-only; upstream's `desktop_ui`
  is gated to Hermes Desktop sessions; plugins cannot emit WebSocket events). The Electron main
  process now serves a JSON-lines Unix socket in desktop mode too (`heraldOsDataDir()/control.sock`)
  and hands the backend its path and a per-launch token; `ui`, `ui-list` and `ui-state` requests are
  forwarded to the Hermes window over IPC and answered with the command's result. The bridge plugin's
  `os_ui` tool is the client; the command's declared tier drives the existing approval gate and audit.
  Rejected: reusing `desktop_ui` (handlers live in Hermes Desktop), notifications as commands (no
  results, not extensible), a gateway server-request (needs core changes; still the long-term path).
- **Show the work.** Commands return a `highlight` target; items carry `data-os-target` and a small
  highlighter scrolls and pulses them; an action HUD captions each voice/agent command. `tool.complete`
  events from Hermes's own memory/cron/file tools map to the matching `*.show` command during voice
  conversations (or with the Follow Hermes preference), never while the user is typing.

## ADR-015: The Studio watches builds through gateway events, not the desktop source

"Build me a website" should let the person watch Hermes work: files appearing, the code with its
changes marked, commands and dev-server output, and the running site. Upstream already streams most
of it to any client: `tool.start` (full arguments, including the content `write_file` is writing),
`tool.complete` with `inline_diff` (Hermes's rendered review diff: ANSI colours and
`a/<path> → b/<path>` headers before ordinary hunks), and `agent.terminal.output` / `terminal.close`
for background processes. The Studio (`apps/desktop/src/features/studio/`, model in `lib/studio-model.ts`,
store in `store/studio.ts`) folds those events per session, for every session the shell knows, so
"show me the code" works for a build already under way.

- **Own preview command instead of `open_preview`.** Upstream's preview tools (`open_preview`,
  `read_preview`, `drive_preview`) are in the `desktop_ui` toolset, which the gateway enables only
  for sessions whose source is `desktop`. Herald OS sessions keep `source: "herald_os"` (ADR-003);
  claiming to be Hermes Desktop would also advertise panes Herald OS does not implement. The
  Studio detects local server addresses in process output and exposes `studio.preview` through
  `os_ui` for Hermes to name one explicitly; a `preview.open` event, if one ever arrives, is honoured.
- **`build.start` owns the setup.** It creates `~/Projects/<slug>` (the `projectsRoot` pref), starts
  a session with that folder as its working directory, opens the Studio and sends a brief that asks
  for `write_file` / `patch` (so every file is visible as it is written), background servers and a
  preview. Voice matches "create / build / make a website for …" on the fast path; longer requests
  reach Hermes, which calls `build.start` through `os_ui`.
- **Previews are their own locked-down view.** `web.openPreview` uses a separate partition, allows
  http(s) and `file://` inside the project folder only, and supports `navigate` / `reload`; the
  Studio reloads it after file changes and retries while a dev server is still starting.
- **The disk is watched too.** `fs.watchTree` (recursive `fs.watch`, dependencies, build output and
  scratch files skipped) catches files that commands create, such as a scaffolded project. The home
  folder is the one exception: a chat with no project works there, so its tree is listed (one level,
  without `Library` and dot-entries) but never watched, because everything under `~` changes all the time.
- **Focus rules hold.** A session started with `build.start` opens its Studio when it starts
  working and never again after the user closes it; other sessions that start writing code only get
  a one-time caption ("say 'show me' to watch").

## ADR-016: Hermes OS is now Herald OS

The project is named after the Herald mobile app and uses its logo, the winged H. Hermes stays the
name of the agent inside it: "Ask Hermes", the "hey hermes" wake word, the `hermes` CLI, `~/.hermes`
and `packages/hermes-client` (a client for the Hermes gateway) keep their names.

- **Renamed identifiers.** `herald-os` for packages (`@herald-os/*`), the Linux CLI and session files,
  the bridge plugin (`herald-os-bridge`) and its skill; `HERALD_OS_*` environment variables;
  `herald_os` for the toolset, the session source and approval rule keys; `window.heraldOS`;
  `persist:herald-*` web partitions; app id `dev.iamluke.heraldos`.
- **Existing installs carry over without manual steps.** At launch, Electron main merges
  `$HERMES_HOME/hermes-os` into `herald-os` and moves the `Hermes OS` Chromium profile (local storage,
  web-window logins) and its partitions; the renderer moves `hermes-os.*` local-storage keys; the
  bridge plugin performs the same data-folder merge if it runs first; `npm run bootstrap` relinks the
  plugin and rewrites the Hermes config (enabled plugin, toolset lists, "always allow" approvals);
  on Linux, `linux/migrations/2026-10-03-herald-os-rename.sh` moves per-user state and retires the
  old session files.
- **Old names are still read where users set them.** `HERMES_OS_*` variables (Electron main, the
  bridge, the Linux session), the `hermes_os` config section, and sessions saved with
  `source: "hermes_os"` (listed alongside new ones).

## ADR-017: Fedora stays the base of Herald OS Linux; Arch is a package target

Omarchy showed how much an opinionated Linux can do, and it runs on Arch. Herald OS Linux stays on
Fedora and reaches Arch, Omarchy included, with a package instead. Arch has no official ARM port (its
aarch64 work is an unofficial testbed, and Arch Linux ARM is a separate distribution), while Herald OS
is developed in an aarch64 VM on Apple Silicon and Fedora builds aarch64 and x86_64 from the same
infrastructure. Fedora Asahi Remix is also the main way to run Linux natively on M1 and M2 Macs.

- **One Linux release tarball.** `HeraldOS-<version>-linux-<arch>.tar.gz` holds the built shell and
  everything the session needs: `linux/bin`, the session files, themes, the install catalog and the
  bridge plugin. The Fedora images (ADR-018) and the Arch package (`packaging/arch/`) are both built
  from it, so there is one artifact to test per architecture.
- **The CLI is distro-neutral.** `herald-os` finds the system package manager (dnf, or pacman with an
  AUR helper) and prefers Flatpak for apps. On Omarchy, system updates go through `omarchy update`,
  because Omarchy stops a direct `pacman -Syu` that would skip its snapshot and migrations.
- **Two ways to run on Arch.** The Herald OS session (niri plus the panels) is the same as on Fedora.
  App mode runs inside Hyprland, Omarchy's compositor: one fullscreen window, as on macOS, Omarchy
  keeps its own bar, Herald follows the Omarchy theme, and Herald's theme, update and install
  commands defer to Omarchy's.
- **A compositor interface.** `apps/desktop/electron/wm/` defines what the shell needs from a
  compositor (windows, workspaces, focus, actions); niri and Hyprland implement it and the session
  environment picks one.
- **Rejected: moving the base to Arch.** It would lose the aarch64 VM the project is built in and
  Asahi, and a rolling release needs its own package mirror, snapshots and migration guard to be
  safe for people who are not Linux experts. **Rejected: a full Arch edition beside Fedora.** It
  doubles the image and test matrix for one maintainer.

## ADR-018: Herald OS Linux becomes a distribution built from Fedora bootc images

This brings ADR-012's Stage 3 forward and supersedes the landscape note that put bootable images out
of scope. Herald OS Linux is built as a bootable container image (`linux/image/Containerfile`, from
`quay.io/fedora/fedora-bootc`), and `bootc-image-builder` turns it into an x86_64 installer ISO and
an aarch64 qcow2 that boots straight into Herald OS.

- **Provisioning splits in two.** What every machine needs (packages, the session, the CLI, themes,
  Plymouth, greetd, the shell from the release tarball at `/usr/share/herald-os/app`) runs at image
  build time (`linux/image/packages.sh`); what belongs to a person (Hermes, its sign-in, the default
  apps) runs at first login (`linux/image/firstboot.sh`).
- **Updates can be undone.** `herald-os update` runs `bootc upgrade`, which stages the new image for
  the next boot; `herald-os rollback` runs `bootc rollback`, and the boot menu keeps the previous
  image. This covers what Omarchy's snapshots cover (the system, not `/home`); `/etc` and per-user
  changes still go through `linux/migrations/`. Channels are image tags: `stable` follows releases,
  `edge` follows `main`.
- **Software on an image.** `/usr` is read-only, so apps come from Flatpak, command-line tools go
  into `~/.local` (npm, mise) or a toolbox container, and `dnf install` stays a development-VM tool.
- **The installer asks little.** Anaconda with a kickstart that leaves the storage screen to the
  person, who can install beside Windows, and whose disk is encrypted unless they untick
  Anaconda's "Encrypt my data" (ADR-031); a kickstart passed with `inst.ks=` installs unattended. The
  first-boot setup in the shell (name, password, Wi-Fi, Hermes sign-in) also covers handing a machine
  to a new owner, which `herald-os reset` returns to.
- **Secure by default on release images.** firewalld with only LocalSend and mDNS open, SSH off,
  Secure Boot through Fedora's signed shim, fingerprint (`fprintd`) and security keys (`pam-u2f`)
  as opt-in setup commands, firmware through `fwupd`. SELinux stays permissive until the Stage 2
  policy work (ADR-012).
- **Signed with a key, not keylessly, while the repository is private.** Images are signed with a
  cosign key pair held in CI secrets; keyless signing would publish the workflow's identity to the
  public Rekor log.
- **The development loop does not change.** The Fedora Cloud VM with cloud-init (ADR-012) stays the
  fastest way to iterate; images are for releases and for trying Herald OS.

## ADR-019: Plugins run sandboxed

Omarchy's desktop is a set of QML plugins, and third-party ones run inside its shell process with
everything the user can reach. The landscape review rejected that model for Herald OS, and this keeps
the rule while adding widgets: each plugin is a folder with a `manifest.json` and web files, rendered
in a sandboxed frame (`sandbox="allow-scripts"`, so an opaque origin with no reach into the shell's
page, storage or cookies) with no Node and no preload, served from `herald-plugin://<id>/` under a
strict Content Security Policy. The only way out is a message channel the shell answers, and main
checks every call against the manifest and what the user granted.

- **A narrow message API.** `stats` (read the system snapshot), `run` (an `OsCommand` the manifest
  names as `run:<id>`, under the command's own tier: anything that changes something asks each
  time), `notify`, and `storage` (the plugin's own key-value store, 256 KB). A plugin cannot spawn
  processes, read files or reach the network unless its manifest names hosts the user accepted
  when enabling it.
- **Installed disabled.** `herald-os plugin add <git-url>` clones into
  `~/.config/herald-os/plugins/<id>`, validates the manifest and leaves the plugin off until it is
  enabled in Settings > Plugins (or at a terminal, with `herald-os plugin enable`), as Omarchy does.
  Enabling grants exactly what the manifest asks for then; a later manifest that asks for more turns
  the plugin off until the user agrees again. Hermes can install, update and remove plugins but not
  turn them on. Saved files reload the plugin live.
- **Hermes's extension model is unchanged.** Agent capabilities stay in backend Hermes plugins such as
  the bridge, behind the approval gate; widgets are UI that Hermes can also write for you.

## ADR-020: Herald Canvas is a WebGL2 editor on Compositor's project format

Herald OS needs an image editor that Hermes can work in while the person watches, and that the
person can use on their own. Herald Canvas is built into the shell: a React editor over a WebGL2
compositor, projects in the `.comp` format that Compositor uses on the Mac, AI tools that run on the
device, and every change Hermes makes going through the command registry (ADR-014) as one undoable
step.

- **Compositor's format, written from its documentation.** A `.comp` project is a folder with
  `manifest.json` and 8-bit PNG layers and masks. Herald implements it from Compositor's public
  documentation, without its code, so projects move between the two. The reader holds every value
  to the ranges Compositor accepts (it refuses a whole project over one value outside them), keeps
  fields it does not use, and writes the images first and the manifest last, atomically. A watcher
  turns outside changes (Hermes, a script, Compositor) into undoable steps.
- **A WebGL2 compositor.** Layers are composited on the GPU in premultiplied half floats (8 bits on
  software renderers), with the blend modes in a shader, pass-through folders, masks, clipping, and
  adjustments and effects as passes. The view composites only what is on screen, at the screen's
  resolution; exports, previews, flattening and the AI tools render in tiles whose borders cover the
  blurs above them, starting on a grid so tiled output matches a single pass. The format's limits
  (30,000 pixels a side, 100 million in all), not the GPU's largest texture, decide what fits, and
  rasters past that texture are drawn from texture pieces.
- **Models on the device, downloaded when asked.** ISNet (general use) finds subjects for Remove
  Background and Select Subject, and EfficientSAM (tiny) picks objects for Object Select. They run in
  ONNX Runtime Web in a worker, on WebGPU where there is one and WebAssembly otherwise. None ships
  with Herald OS: each downloads from its publisher the first time the person allows it, pinned by
  size and SHA-256 and checked again before it runs. Only permissively licensed weights are used:
  both are Apache-2.0, though ISNet's DIS5K training images were released for research use, and its
  ONNX file is the rembg project's conversion of the authors' PyTorch weights.
- **Our own PatchMatch.** Content-Aware Fill and the Spot Healing Brush use a PatchMatch written for
  Herald Canvas, in a worker: no download, no licence question, and good on the textures people
  remove things from.
- **Generative fill goes through Hermes.** Herald saves the area and its mask and asks Hermes, which
  makes the picture with its own image generation tool (the person's provider) and places it with
  the canvas tool. Herald never calls an image API itself, so credentials, costs and the request
  stay in one place the person can see.
- **Photoshop files through ag-psd.** PSD and PSB files are read and written with ag-psd (MIT) in a
  worker and mapped to and from Herald's layers; what does not map is approximated or left out and
  listed for the person, rather than refusing the file.

Alternatives considered:

- **Rejected: an existing editor (GIMP, Krita, a web editor).** A separate app could only be scripted
  through files, not watched as it works, and none shares a project format Hermes can edit on disk
  and Compositor can open. Photopea is a closed online service.
- **Rejected: a 2D canvas or the processor for compositing.** A 2D canvas rounds premultiplied
  colour, so semi-transparent pixels drift on every save, and neither keeps blend modes,
  adjustments and blurs interactive on large images.
- **Rejected: a format of our own, or PSD as the native format.** A private format would strand
  projects; PSD cannot hold Herald's text and adjustment model exactly and is hard to write
  atomically and to edit from a script. Compositor's format is small, documented and already used.
- **Rejected: models in the app, or segmentation in the cloud.** Bundling would add about 220 MB to
  every install for tools many never use, and a cloud service would upload the person's pictures.
- **Rejected: BiRefNet-lite (MIT) for backgrounds.** ONNX Runtime Web cannot run it here: WebAssembly
  runs out of memory, and WebGPU needs more storage buffers in one shader than Chromium allows.
- **Rejected: an inpainting model (LaMa and the like) for content-aware fill.** A large download with
  licences that need care, for results PatchMatch already gives on most photos.

**Follow-up: Herald-only fields extend the format.** Compositor decodes the manifest with Swift's
synthesized Codable: it skips keys it does not know, but a value it cannot decode, such as an
adjustment kind outside its list, makes it refuse the whole project. So Herald never writes a kind
Compositor lacks. What only Herald has goes in fields of its own beside a record Compositor reads:

- **`heraldAdjustment` beside `adjustment`.** Brightness/Contrast, Vibrance, Photo Filter, Channel
  Mixer, Selective Color, Posterize, Threshold and Color Lookup keep their settings in
  `heraldAdjustment` (with its own `kind`), while `adjustment` holds a complete record of one of
  Compositor's kinds: the very same change where one exists (Brightness/Contrast is a 32-point
  Curves; Vibrance with no vibrance is Hue/Saturation; a Photo Filter without Preserve Luminosity is
  Levels on each channel), otherwise Levels that change nothing. Herald draws the Herald kind and
  makes the stand-in again from its settings on every change and every load, so the two never
  disagree; Compositor draws the stand-in.
- **Files Compositor does not name.** A Color Lookup's table is `images/<ID>.cube`, beside the
  PNGs: Compositor loads only the images its layers name, and Herald's writer removes such a file
  with its layer.
- **Newer kinds are kept.** A `heraldAdjustment` kind this version does not know is kept as it was
  and shown as its stand-in, as Compositor shows it.
- **The cost.** Saving in Compositor drops the unknown keys and files, so such a layer comes back
  to Herald as its stand-in. Rejected: a new value in `adjustment.kind` or a format version of our
  own (Compositor would refuse the project), and colour tables inside the manifest (Compositor
  refuses manifests over 4 MB, about what one 65-entry table takes as text).

## ADR-021: Herald Office: Sheets on Univer, Docs on TipTap, Slides on a slide editor of its own

**Status: Accepted.** Rewritten for what Herald Office's second phase built, extended with the
depth phases of Sheets, Docs and Slides, and final with the polish phase: printing, the
measurements below on the Mac and on Herald OS Linux under software rendering, and the licences.

Herald OS needs documents, spreadsheets and presentations that Hermes can work in while the person
watches, and that open and save the files people already have. Herald Docs, Herald Sheets and
Herald Slides are built into the shell, the way Herald Canvas is (ADR-020), each on the engine that
suits it: Sheets on Univer's open-source packages, Docs on TipTap 3, and Slides on a DOM slide
editor of Herald's own with TipTap text boxes. They share one Office window (tabs, sessions, the
save policy, the fidelity dialog, backups and PDF export) and read and write Office files through
converters of our own. Each app has a document API that Hermes's commands work through, on the
document open in a window or on a file on disk, each change one step to undo; the commands
themselves go through the command registry (ADR-014).

- **Herald Sheets on Univer 1.0.x, its free packages only.** The Apache-2.0 packages Sheets needs
  are installed one by one at 1.0.3, never through a preset: core, design, ui, themes,
  engine-render, engine-formula, rpc, docs and docs-ui (for the cell editor), and sheets with its
  formula, number format, filter, sort, conditional formatting, data validation, find-and-replace
  and hyperlink plugins; the depth phase added drawing, drawing-ui, docs-drawing, sheets-drawing
  and sheets-drawing-ui (for charts), and thread-comment, sheets-thread-comment and sheets-note
  with their UIs (for comments and notes). A test fails if `@univerjs-pro` or an advanced or
  collaboration preset appears in the lockfile, or if a Univer package there has a licence other
  than Apache-2.0 (MIT for its icons). Sheets loads only when its window opens: the shell's main
  chunk carries none of Univer, and the Sheets window loads 7.7 MB beyond it (2.1 MB compressed).
  In the packaged build, measured before the depth phase, a window is up 0.2 s after it is asked
  for and a new workbook draws 0.12 s later; the first workbook adds about 26 MB of JavaScript heap
  and 58 MB to the window's process, worker included.
- **Formulas in a worker.** Sheets work formulas out in a module worker (7.4 MB, loaded with the
  first workbook) that gets the filters too, so SUBTOTAL leaves out the rows a filter hides. On
  20,000 rows of formulas the window's thread was blocked 141 ms instead of 889 ms, with results as
  fast. `.xlsx` files are read and written through ExcelJS (MIT) in a worker of their own, with
  what ExcelJS reads badly taken from the package itself. Both workers load from the app, so the
  Content Security Policy needs no change (`worker-src` falls back to `script-src 'self'`), and
  Univer uses no `eval`.
- **Headless Univer for Hermes.** A command on a workbook that is not open in a window loads it
  into a Univer instance with nothing drawn but every plugin that keeps data in the workbook
  (Univer leaves out of a snapshot what no plugin loaded), changes it through Univer's Facade API
  as one undo group and writes it back, in about 40 ms with its recalculation; a file holding what
  Sheets cannot keep is left alone. In a browser the formula engine waits for the Rendered
  lifecycle stage, which only Univer's chrome reaches, so a headless instance moves on to it
  itself.
- **Univer in Herald's colours.** Univer reads one palette for its chrome (CSS variables on the
  page) and for its canvas, so Herald works it out from the theme's accent and background when a
  window opens. In dark mode Univer puts canvas colours through a fixed matrix that turns light
  into dark; Herald runs the matrix backwards to find the light shades that come out as the
  theme's dark ones, so the grid matches the glass, and the outer chrome is transparent on it.
  Office's fonts are drawn in the real font where it is installed, else in the one made to its
  measurements (Carlito for Calibri, Caladea for Cambria); cells keep their font's name. Univer's
  editors write their "automatic" text colour into what is typed; Herald saves it as no colour, so
  a file never gains a colour nobody chose. Each Univer editor is a React root of its own, whose
  events never reach the window's React handlers, so the Office window takes its shortcuts and
  dropped files with native listeners.
- **Charts: Univer's floating objects, drawn by ECharts.** A chart is a floating DOM object of
  Univer's sheet drawings, so Univer places, moves, resizes, layers and undoes it as it does a
  picture, and a React component inside it draws the chart's spec with ECharts (Apache-2.0) from
  the numbers in its cells, again as they change: column, bar, line, area, pie, doughnut, scatter
  and combo charts, recommended from the shape of the selection. A chart's ranges move with rows
  and columns inserted or deleted. ECharts is built with only what these charts draw and loads the
  first time a chart shows. In a workbook with nothing drawn (Hermes on a file that is not open)
  the same change goes through Univer's drawing mutation, and Herald files it for undo. Univer's
  own charts are in its paid tier.
- **Excel charts written by Herald, and Herald's part in a workbook.** ExcelJS writes no charts,
  so a finishing stage after it writes each chart as an Excel chart (a DrawingML chart part and
  its anchor in the sheet's drawing, in the order the file format sets, in files Excel and
  openpyxl open) and reads charts of those kinds back from any file, those wrapped for newer
  versions of Excel included. An Excel chart left unchanged goes back as the file had it, and a
  chart Herald cannot read or write never stops a workbook from opening or saving. What only
  Herald reads back goes into a part of its own, `herald/sheets.json`, with its content type and
  package relationship, which Excel, Numbers and LibreOffice pass over: a chart's exact spec, how
  each summary was made, and each sheet's Herald data. A section that depends on parts another app
  may have changed carries their fingerprint, and a file changed since is read from its parts, as
  Slides does with `herald/deck.json`.
- **Kept parts on save.** The parts of the file a workbook came from that Sheets does not model
  are carried into the file it saves, with their relationships and content types, where that is
  safe: pivot tables and their caches (set to refresh when Excel opens them), slicers and
  timelines, tables, sparklines, pictures, shapes, SmartArt, charts and pivot charts Herald does
  not draw, chart sheets, links to other workbooks, custom properties, background pictures and
  sensitivity labels. A sheet's parts stay with it when it is renamed or moved. A table or pivot
  table that a filter, merged cells or a formula in its headers would break in Excel, or whose
  name a defined name has taken, is left out and named. The fidelity report names only what a file
  really loses, so a workbook Herald saved reopens with nothing to report.
- **Summaries with whole-column formulas, not pivot tables.** A summary in the style of a pivot
  table is portable formulas: its row and column labels are the distinct values of their fields
  when it is made or refreshed, and each number is a SUMIFS, COUNTIFS, AVERAGEIFS, MINIFS or
  MAXIFS over the source's whole columns, matching the label cells, so the numbers follow the data
  as it changes, rows added with known labels count at once, and Excel and LibreOffice work them
  out alike. Labels and numbers take the formats of the columns they come from. How a summary was
  made is kept in its sheet's custom data (Herald's part, in a file); a refresh reads the table
  again and rewrites the labels, and refuses a summary that rows or columns have moved, so nothing
  put in its old place is cleared. Pivot tables proper are Univer's paid tier, and their caches are
  Excel's to work out.
- **Data tools, names, validation, comments and notes.** The Data menu's tools (remove
  duplicates, split text, trim, change case, convert to numbers or dates, fill down, highlight
  duplicates, sort by several columns, summarize) are each one step to undo, with a preview before
  a removal. Names are checked as Excel checks them, marks and accents included, for the workbook
  or one sheet, and kept through `.xlsx`; validation sets list, number, date, text-length and
  formula rules with input messages and error alerts, and keeps every rule. Comment threads, with
  their replies, authors and resolved state, and notes are written as Excel writes them (threaded
  comments with their persons, notes with their VML). Univer keeps comment threads out of its undo
  history, so adding or deleting a comment cannot be undone; Hermes's commands say so.
- **Herald Docs on TipTap 3 (MIT).** A document is TipTap's JSON with its page size, margins and
  style looks on the document node. The editor, the converters, the print view and the document
  API share that one schema, which builds without a window, so the API changes a live editor or a
  file's JSON with the same code, one transaction and one step to undo. TipTap was chosen over
  Univer Docs for native editing in the page (Chromium's spellcheck with suggestions on
  right-click, input methods, and copy and paste with other apps), a schema usable without a
  window, a far smaller bundle (when the engine was chosen, the Docs window's own chunks were
  0.53 MB, 0.17 MB compressed, against 3.1 MB and 0.85 MB for Univer Docs; 0.33 MB of it is TipTap
  and ProseMirror, shared with Slides), and
  the maintainer's good experience with a TipTap-based editor. Only TipTap's open-source packages
  are used, at 3.31.4: none of its paid extensions or cloud services.
- **Word files through a reader of our own and the docx package.** A `.docx` (or a `.docm`,
  without its macros) is read by Herald's own WordprocessingML reader through JSZip (MIT): styles
  with their basedOn chains and the theme's fonts, run and paragraph formatting, lists from
  numbering.xml, links, tables with merges and shading, inline and floating pictures, breaks, the
  page and its sections, headers and footers, fields, footnotes and endnotes, comments, text boxes
  and tables of contents. It is written with docx (MIT), with Title, Subtitle and headings as
  Word's own styles, and a small repacker adds what docx cannot write (the parts Herald keeps, its
  table of contents' styles) with their content types and relationships. Both load only when a
  Word file is opened or saved (the writer is 0.45 MB): opening one never loads docx. Markdown
  goes through the GFM parser the app already had.
- **Pages on screen as the PDF has them.** Herald Docs lays its text out into pages in the one
  editor, which was what Univer Docs did better: the text runs down a single column, and a spacer
  where each page starts (before a block, between two lines of a paragraph, or before a table row)
  moves what follows to the next page's text area, keeping two lines of a paragraph on each side
  of a break and a heading with what follows it; each page is drawn behind the text with its
  header, footer and footnotes. The print view lays the document out with the same code and cuts
  it where each page starts, so the PDF has the pages the screen shows, and the word count gives
  the pages as laid out. A layout runs in the frame after a change, and again when fonts or
  pictures load or the zoom changes.
- **Headers and footers, fields, notes and sections.** Word's headers and footers (for every
  page, the first page and even pages), page number, page count, date and time fields, footnotes
  and endnotes, section breaks with each section's own page, and text boxes open and save in
  `.docx`; headers, footers and notes are edited right on the page, and the page and its sections
  are set up in a dialog of their own. Markdown keeps notes as footnotes and fields as the text
  they show. A section's own page numbering is not kept (pages are numbered on from the first),
  and the fidelity report says so.
- **A table of contents of Herald's own.** A table of contents is a node of the document (its
  levels, title and the page of each entry), drawn on the page with the print view's own HTML so
  the page and the PDF lay it out alike, its entries worked out from the headings and its page
  numbers from the pages on screen, kept up to date as they change. It goes into Word as Word
  writes one: a TOC field with an entry per heading, linked to a bookmark on the heading and with
  a dotted tab to its page number, in Word's TOC styles; the page numbers are written when every
  entry has one, and otherwise Word updates the field when it opens the file. A Word TOC field
  reads back as one table of contents (a table of figures is not one).
- **Comments, templates and statistics.** Comments are threads with replies, authors, initials,
  dates and a resolved state, shown beside the pages; in Word files they are comments.xml with
  commentsExtended.xml for replies and resolved threads, and the people who commented, custom XML
  parts and the file's properties are kept as they were. Twelve built-in templates are pure
  functions of the paper and the locale, each with its own look, page setup, and headers and
  footers, shown in a gallery of live thumbnails; the person's own templates are saved by main as
  JSON files named by UUID in `office-templates/<app>/` under the Herald OS data folder.
  Statistics count words, characters, paragraphs and sentences, with reading and speaking times
  and how easy the text is to read.
- **Herald Slides on a DOM slide editor of its own, with PowerPoint's model.** A deck is
  PowerPoint's model in Herald's JSON: slides in points on a fixed 16:9 or 4:3 surface, a slide
  master with a layout for each of Herald's eight (each with its placeholders, drawings and
  background), header and footer settings, themes of ten colour slots with a heading and a body
  font, transitions, shapes as DrawingML's presets with their adjust values or as freeform paths,
  colour and gradient fills, lines and connectors, pictures, speaker notes, tables as PowerPoint
  builds them (a cell for every column in every row, merged cells kept whole, rows that grow with
  their text, no rotation, each cell's own borders), groups, and the objects Herald keeps without
  editing them; a slide may have a theme and a transition of its own. The page draws it with the
  DOM, scaled to fit, through one view for the editor, the slide list, presenting and PDF export, so
  a PDF keeps its text as text. Text boxes, shapes and table cells edit rich text through TipTap in
  the element's own text area, so input methods, spellcheck and the clipboard work as they do in
  Docs. The deck API (`slides/model.ts`) makes each change one step to undo, on the deck in a window
  or on a file on disk, which is not written over when reading it lost something.
- **Why not the Canvas engine or Univer Slides.** The first draft drew slides with the Herald
  Canvas engine, which composited a 1920 by 1080 slide in about 18 ms but could not edit rich text:
  the caret, selection, input methods, spellcheck and copy and paste would all have been Herald's
  to build on a canvas. Univer Slides' open-source packages are a skeleton with no Facade API: in
  1.0.3 a new slide does not appear in the slide list, moving an element does nothing, slide edits
  cannot be undone, and there is no present mode, layouts or themes.
- **A master and layouts that pass their look down, as PowerPoint's do.** A deck's master (Herald's
  own for its size unless the deck has one of its own) holds the background and drawings slides show
  behind their own, the title and text placeholders whose look the layouts take, and the date,
  footer and slide number placeholders; each of the eight layouts has its own placeholders,
  drawings, background and name, and says whether the master's drawings show on its slides (a slide
  may hide them for itself too). A slide's placeholders are copies of its layout's, so a change
  passes down: a change to a placeholder of the master reaches the layouts' placeholders of its
  role, and a change to a layout's placeholder reaches its slides' (the first title with the first
  title, and so on), aspect by aspect and only where the value is still the one being changed: the
  box (to half a point), the prompt, the text's anchor, each part of the run look (font, size,
  colour, bold, italic, underline, strike, highlight) and the paragraph settings that pass on
  (alignment, lists and numbering, line spacing, space before and after, margin and indent).
  Whatever a layout or a slide made its own stays. Reading a file, the master most slides use
  becomes the deck's, with the first of its layouts that maps to each of Herald's; the fidelity
  report names the other masters and layouts.
- **The header and footer in the master's places.** The date, footer and slide number show where the
  master puts them (or a layout's own place for them) and as they look there, and the deck's header
  and footer settings say which show and what they say: the date of the day in one of PowerPoint's
  four date formats or a text that stays, the slide's number (hidden slides counted, as PowerPoint
  numbers them) and a footer text, left off title slides when asked. A file gets them as
  PowerPoint's own placeholders on the master, the layouts and the slides that show them, the date
  of the day and the number as the fields PowerPoint keeps up to date. A file carries them slide by
  slide, so reading one, the deck shows each where most slides carry it, with the text most of them
  hold, and the fidelity report says where that changed a slide.
- **The master view is the slide editor in a mode of its own.** Slide Master turns the master and
  its layouts into the slides of a deck of their own (the master's on the Blank layout, then one for
  each layout, the master drawn behind each as its slides show it), and the same editor edits that
  deck, its slide list and tools included, under a bar for what only a master has (a logo,
  backgrounds, the header and footer, the theme, a layout's name and whether it shows the master's
  drawings, and putting Herald's master back). Each change there goes back into the deck's master,
  passed down as above, as one step of the deck's own history: undo and redo stay the deck's while
  the view is open and after it closes, a change Hermes makes to the slides meanwhile is a step of
  the same history, and what is saved and presented is always the deck itself.
- **Themes: Herald's thirteen, the person's own, and a theme for chosen slides.** Elements name
  theme colour slots and the theme's two fonts, so a theme repaints a deck without touching what was
  picked by hand. Herald's thirteen themes (four with a gradient between their own colours as their
  background) keep text at 4.5:1 or better on both backgrounds and accents at 3:1 or better on the
  first, which a test checks, in a Mac's fonts with look-alikes elsewhere. A theme for the whole
  deck takes slides' own themes away and brings its background to the master where the master had
  none or the old theme's; picked slides get it as a theme of their own, which a PowerPoint file
  keeps as a master of their own (a copy of the deck's with that theme and its layouts), and which
  reading a file gives the slides whose master's theme is not the deck's. The theme editor sets a
  theme's name, ten colours, two fonts and, if wanted, a gradient between two of its colours as its
  background, drawn on two sample slides as it changes, with a warning where text would read below
  4.5:1. Saved, a theme goes onto the deck or the picked slides and among the person's own themes,
  kept for every deck in one file, `office/slide-themes.json` in the Herald OS data folder
  (`~/.hermes/herald-os`), written whole on every change, one save after another, and checked as a
  deck's theme is when read; their ids (`custom-` and the name) never take a built-in theme's place.
- **Transitions as PowerPoint names them.** A slide comes in by its own transition or by the deck's:
  none, fade, push, wipe, cover, uncover, split or zoom, each with the way it goes (push, wipe,
  cover and uncover from the right, left, bottom or top; split in or out, across or up and down;
  zoom in or out) and how long it takes (500 ms unless set). Present mode plays them as Web
  Animations keyframes on the slide coming in and the one before it, going back plays them
  backwards, and with motion reduced each is a fade of at most 180 ms. A transition chosen for the
  deck is every slide's, so it takes slides' own away; Apply Transition to All Slides gives every
  slide the same one and makes its kind the deck's. A file gets each as PowerPoint's own element
  with its duration (PowerPoint 2010's `p14:dur`) and the nearest of PowerPoint 2007's speeds for
  apps that do not read it. Reading one, PowerPoint's other transitions become the nearest one
  Herald plays, which the fidelity report says, and it names automatic slide timings and transition
  sounds as not kept.
- **Groups as tags on elements, and connectors glued to connection sites.** A grouped element stays
  an element of its slide and names its groups by ids, outermost first, so groups nest while each
  member draws, edits and keeps its place in the drawing order as any other; a click picks the
  outermost group, ungrouping takes that one away, and placeholders are never grouped. A file gets
  them as nested `p:grpSp`, each where its first member is in the drawing order, and reading one
  turns its groups into tags again. A connector is a line with one of DrawingML's nine connector
  presets (straight, or bent or curved through one to four turns, with their adjust values) whose
  ends may be glued to connection sites, numbered as DrawingML numbers them for each shape, so a
  connector read from a file lands where PowerPoint put it and one written (`p:cxnSp` with its
  `a:stCxn` and `a:endCxn`) stays glued there. A glued end follows its shape as it moves, resizes or
  turns, and comes loose when the shape goes or the end is dragged off its site.
- **DrawingML's own geometry: every preset Herald keeps, gradients, freeforms and cell borders.**
  Herald keeps 103 of DrawingML's preset shapes under their DrawingML names, all offered in seven
  groups, each worked out from DrawingML's preset definition and written line for line in its
  formula language (the adjust values with their defaults, the guides, the paths with the parts
  PowerPoint shades or leaves unfilled, and the text rectangle), so a shape here and the same shape
  in PowerPoint have one outline. A preset outside them reads as the nearest one Herald draws, which
  the fidelity report says. Fills and backgrounds may be linear or radial gradients, whose stops,
  like any colour, may name theme colours and so follow the theme. Freeforms come from files:
  DrawingML's custom geometry becomes SVG path data with absolute moves, lines, curves and closes
  only (arcs turned into cubic curves of at most a quarter turn), each written back as its DrawingML
  counterpart. A table cell may have a line of its own on each side, none, or the table's, drawn
  from the Table menu and the formatting bar in the pen PowerPoint's table tools use.
- **Kept objects: what Herald does not edit, as the file had it.** A chart, a SmartArt graphic or an
  embedded object read from a PowerPoint file becomes an element that keeps its graphic frame's XML
  as the file wrote it (the markup choice around it included) and the tree of parts it names, each
  with its relationship type, content type and bytes. Herald draws it from its box: the picture the
  file keeps for it (a chart's fallback picture, an embedded object's own), SmartArt's drawing
  placed from the box's top left and stretched with it, or a labelled box. It moves, resizes, turns,
  copies and deletes as any element; a saved file gets its frame back in its place in the drawing
  order, moved and sized to its box, and its parts copied in under fresh names with relationships of
  their own, so objects copied from one file never share a part. Convert to Shapes turns SmartArt
  into a group of its shapes to edit, and what it kept for PowerPoint goes with it. Videos and
  sounds are not kept: a video shows as its poster frame and a sound is left out, as the fidelity
  report says.
- **Decks from documents and tables from sheets, by rule.** A document Herald Docs opens (a Word
  document, Markdown or plain text) becomes a deck, or slides in one, laid out by rule: its title
  makes a title slide, its headings section headers and slides of bullets, and its pictures, tables,
  quotes and code slides in the layouts made for them. How much text a slide holds is estimated from
  its placeholder's width and text size, so a long section goes on over further slides; a paragraph
  never splits between two, and one too long for a slide of its own is shortened, with the section's
  text in the notes. The same document always makes the same slides. A range of a sheet Herald
  Sheets opens (an Excel workbook or CSV) becomes a table of the text its cells show, numbers in
  their formats, on the slide in front, sized to its text, or on slides of its own after it, going
  on over further slides under its header row when it is too tall for one. The converters load only
  when a file is picked. Hermes's `slides.fromDocument` and `slides.insertRange` run the same code,
  with the heading level that starts a slide and speaker notes for every paragraph as options of
  the rules; fields read as the text they show, a note's marker stays with the note in the speaker
  notes, and a table of contents is passed over.
- **The presenter view, and the audience window as one named window.** The presenter view shows the
  slide in front large and the next one, the speaker notes at the size the presenter sets, the time
  taken, the clock and the slide counter; the keys of every window the presentation shows in move
  the one presentation state they all draw. With one display, or when asked, it is a split view in
  Herald's window whose slide in front is the one the audience sees. When the system reports another
  display, the page opens one window named `herald-slides-audience` on an empty page with
  `window.open`, and main allows only that name on that page, and only when a display other than the
  opener's is there (else it refuses, and the split view is used): a frameless window full screen on
  that display, with a fixed title, no preload, sandboxed, its navigation and its own windows
  refused, closed with its opener. `electron/window.ts` and `electron/shell/panels.ts` ask
  `audienceWindow()` first and answer every other `window.open` as before. The page draws the slides
  into the window through a React portal, with copies of its style sheets, so no page loads there;
  closing the window ends the presentation. On Herald OS Linux a niri rule in
  `linux/niri/config.kdl` matches the window by its title and opens it full screen without taking
  the focus, so the keys stay with the presenter view.
- **PowerPoint files through PptxGenJS and a reader of our own.** PptxGenJS (MIT) writes the `.pptx`
  package: each slide's text with its runs and lists, preset shapes, lines, pictures, tables,
  backgrounds and notes, and, in a second package, the master's and layouts' drawings on slides of
  their own. A finishing pass writes what PptxGenJS cannot say: the masters, layouts and themes
  whole from the deck in place of the one master and layout PptxGenJS writes, each slide's shapes as
  the deck has them (paragraph settings, adjust values, freeforms, gradients, crops, tables cell by
  cell, connectors, groups and kept objects), the date, footer and slide number, each slide's
  transition, and content types only for the parts a file has; tests check that every part has a
  content type and every relationship a part. Files are read with JSZip and Herald's own DrawingML
  reader, which follows parts through their relationships as PowerPoint does: the slide size, the
  master most slides use with its layouts, text with what its placeholder, layout, master and theme
  lend it, shapes, pictures, lines and connectors, groups, backgrounds, notes, positions, flips and
  rotation, tables with their table styles worked out into each cell, footers, transitions and the
  objects Herald keeps.
- **Herald's deck inside the file.** A saved file carries Herald's own copy of the deck as a part of
  its own (`herald/deck.json`, with its content type and a package relationship), which PowerPoint,
  Keynote and LibreOffice pass over, and a fingerprint of the slides as written. Herald reopens its
  own files exactly from that copy, and reads a file another app has changed since from its slides.
  Nothing is stored twice: the copy names the media part holding each picture (a kept object's too)
  and, since its version 2, the part each kept object's part was copied to. A version 1 copy, as the
  second phase wrote it, still opens exactly: the reader takes every version up to its own, and what
  such a deck never had takes its default (Herald's own master for its size, no date, footer or
  slide number, the deck's transition on every slide). A Herald that reads only version 1 reads a
  version 2 file from its slides.
- **What Slides costs.** PptxGenJS and the finishing pass load only when a deck is saved, the reader
  and JSZip only when one is opened, and the Word, Markdown and Excel readers only when slides are
  made from such a file. As the second phase measured it, the Slides window loaded 0.43 MB (0.13 MB
  compressed), most of it the TipTap chunk it shares with Docs, PptxGenJS and the finishing pass
  0.29 MB, the reader 44 KB and JSZip 96 KB. Herald maintains the reader and the finishing pass
  itself, and the pass depends on how PptxGenJS lays out what it writes, so a PptxGenJS upgrade
  waits for the export tests.
- **What the depth phases cost.** Measured as what a window loads beyond the shell's main chunk,
  before and after them: the Sheets window grew from 7.1 MB to 7.7 MB (1.9 MB to 2.1 MB
  compressed) with the drawing, comment and note plugins and the data tools' dialogs, ECharts adds
  0.57 MB (0.19 MB compressed) the first time a chart shows, and the `.xlsx` worker grew from
  1.09 MB to 1.19 MB; the Docs window grew from 0.86 MB to 1.02 MB (0.29 MB to 0.34 MB
  compressed) with pagination, comments, templates and their dialogs; the Slides window grew from
  0.75 MB to 0.97 MB (0.25 MB to 0.31 MB compressed) with the master view, the theme, transition
  and header and footer panels and the presenter view, PptxGenJS with the finishing pass from
  0.29 MB to 0.31 MB, and the reader from 44 KB to 61 KB; the shell's main chunk grew by 0.06 MB,
  the commands for all three apps included.
- **Printing through the print view.** File > Print (Cmd or Ctrl+P) prints the same print view as
  Export as PDF: main writes it to a file, loads it in a hidden window with scripts off, and hands
  it to the system's print dialog instead of to `printToPDF`, so paper and PDF cannot differ. The
  page's CSS sets each page's size and margins and the printer's paper takes them, scaled to fit:
  Docs prints its pages with their headers and footers, Slides one slide a page, and Sheets
  follows the sheet's page setup from its file (paper, orientation, margins, scale or fitting to
  so many pages, centring across, and the header and footer as page margin boxes with page
  numbers). Where the system has no printer, as on Herald OS Linux without a print server,
  Electron shows no dialog at all, so Print asks where a PDF goes and writes the page it loaded
  there. Printing needs no library: Chromium lays the pages out as it does for the PDF.
- **What polish measured, and changed.** On the Mac, with the production bundle: a window is up
  with its document 0.21 s (Docs), 0.31 s (Sheets) and 0.20 s (Slides) after the first open, and
  under 0.1 s when opened again; a 51-page document opens in 0.12 s, a 50,000-cell workbook in
  0.22 s with its formulas worked out by 0.9 s, and a 40-slide deck in 0.05 s. What a window
  loads to open fell where the depth phases had grown it: Docs from 1.0 MB to 0.81 MB (0.33 MB to
  0.27 MB compressed), its panels and dialogs loading when first opened; Slides from 0.95 MB to
  0.41 MB (0.31 MB to 0.14 MB), TipTap loading once the deck is up; and the formula worker every
  workbook starts from 7.2 MB to 2.8 MB, built as an ES module so Univer's lazily loaded
  hyphenation dictionaries stay out of it. A workbook gets its Univer and worker the first time
  its tab is shown, and a closed one lets them go (Univer's toolbar had kept every closed workbook
  alive): reopening Sheets with ten workbooks open builds one editor instead of ten (0.08 s
  instead of 0.63 s), and each further workbook costs 30 MB of the window's processes instead of
  46 MB. Typing in a long document lays out only what moved when a keystroke changes no height:
  15 ms from key to frame at 211 pages instead of 37 ms, 10 ms at 51 pages instead of 13 ms. On
  Herald OS Linux in a QEMU VM under software rendering, in panels mode, each app opens in about
  0.5 s, files of the same sizes in 0.31 s, 0.87 s and 0.30 s, a keystroke at 50 pages reaches the
  screen in 64 ms (80 ms at the 95th percentile, 7 ms of it the window's work), and a window with
  the 50,000-cell workbook holds 340 MB; Hermes's commands land in the window that has the
  document, in under 0.1 s.
- **Hermes in the depth features.** Each depth feature is a command on its app's model API (35
  for Sheets, 26 for Docs, 25 for Slides), so Hermes, voice, the command bar and `herald-os os`
  reach them alike, and the bridge's `sheets`, `docs` and `slides` tools have an action for each.
  Reading is `read`, changing is `act`, and removing what the person made (a chart, a name,
  validation rules, a comment, a note, a header or footer, a section break, a table of contents, an
  element of the master or a layout, a custom theme) or resetting the master is `mutate`, which
  asks. An edit batch asks as its most guarded op does, its ops matched in any case as the shell
  takes them, and a change to a file that is not open asks every time unless it only previews.
  Slides' `fromDocument` and `insertRange` run the editor's own conversions. Review > Review
  with Hermes goes through the document's Ask Hermes bar: Hermes reads the document and leaves its
  clarity, grammar and tone comments on exact passages in one `add_comments` call, signed Hermes
  and one step to undo, without changing the text.
- **One name on comments.** The name on the person's comments, replies and notes is one
  preference for every Office app, in Herald's prefs. The first time they comment, a small
  question asks which name to show, proposing the account's full name; nothing writes the
  account's name into a file before they confirm one, a cancel adds nothing, and Settings >
  General changes or clears it. Commands sign with the confirmed name or a neutral one and never
  ask.
- **Never less than the file had, silently.** What a file holds that Herald cannot keep is listed
  in a fidelity report, shown before the first save over that file: for a Word file, tracked
  changes (shown accepted), a section's own page numbering, equations, embedded objects, charts
  and SmartArt, text in columns and macros among others; for a workbook, what its parts hold that
  Sheets neither maps nor keeps; for a presentation, each element counted as kept, approximated or
  left out, with the reasons (videos shown as their poster frame and sounds not kept, among others),
  and what of the deck Herald does not keep named: animations, automatic slide timings, transition
  sounds, embedded fonts, comments, sections, custom shows, masters besides the one most slides use,
  layouts Herald has no place for, and macros. Main copies the original into `office-backups` under
  the Herald OS data folder the first time Herald saves over it in a session, with a cap on their
  size and age. Herald saves a document by itself only after the person has saved it once, and stops
  when a save would lose something new.
- **OpenDocument through LibreOffice, later.** Main can convert `.odt`, `.ods` and `.odp` with
  headless LibreOffice when it is installed, but no window converts through it yet, so the three
  formats stay off in the format table (`shared/office/files.ts`).
- **Licences.** Univer is Apache-2.0: NOTICE names it and a packaged build carries its licence
  text. electron-builder would also copy Univer's npm packages into `app.asar` (148 MB the renderer
  bundle already contains), so the build leaves them out, and the Office apps' other libraries too
  (TipTap and ProseMirror, ExcelJS, docx, PptxGenJS, JSZip, the Markdown parsers and what only
  they bring in): 58 MB less in `app.asar`, which main never loads, and ECharts with ZRender
  another 67 MB. ECharts is Apache-2.0 and brings ZRender (BSD-3-Clause) and tslib (0BSD), which
  NOTICE names with it. TipTap, ProseMirror, ExcelJS, docx, PptxGenJS and JSZip are MIT (JSZip,
  licensed MIT or GPL-3.0, is used under MIT). JSZip brings pako, which is MIT and Zlib; the zlib
  licence is permissive, and Herald already ships pako with Herald Canvas. Everything else they
  bring in is MIT, Apache-2.0, ISC or BSD: ExcelJS's old unzipper is pinned to the 0.12 line and
  its uuid to 11.1.1, so npm audit finds nothing new. NOTICE lists every package the renderer,
  main and the prebuilt ExcelJS, docx and JSZip files bundle, with its licence and copyright line,
  and `build/licenses` carries the texts that BSD-3-Clause and Apache-2.0 code asks for (ECharts
  with the d3 code it declares, ZRender, Univer). The polish phase left three more renderer-only
  libraries out of `app.asar` the same way, though not Office's: onnxruntime-web (138 MB), the
  Tabler icon sets (67 MB) and ag-psd, with an 18 MB cache in `app.asar.unpacked`. An unsigned,
  unpacked macOS build went from 709 MB to 477 MB, `app.asar` from 400 MB to 186 MB and
  `app.asar.unpacked` from 21 MB to 2.6 MB.

Alternatives considered:

- **Rejected: ONLYOFFICE.** Its editors are AGPL-3.0 with added terms under section 7 that require
  keeping its logo, and they run as a document server with a look of their own.
- **Rejected: LibreOffice or Collabora Online as the editors.** Hundreds of megabytes per platform
  (Collabora also a server), and their own interface rather than Herald's. LibreOffice stays an
  optional converter.
- **Rejected: Univer Docs for Herald Docs** (the first draft), for the reasons above. Its
  pagination, what it did better, Herald Docs now has of its own.
- **Rejected: Univer Slides or the Herald Canvas engine for Herald Slides,** for the reasons above.
  Univer Slides is worth another look once its open-source edition can present and undo.
- **Rejected: a second Herald window for the audience,** loading the app with a preload of its own
  and kept in step with the presenter view over IPC. The audience window is an empty page that the
  presenter view's page draws into, so no page loads in it, it needs no preload, and both views draw
  one presentation state.
- **Rejected: Univer's paid tier.** Its import and export, printing, charts, pivot tables and
  collaboration are closed and licensed per deployment; Herald writes the formats and prints
  itself, draws its charts with ECharts and summarizes tables with formulas.
- **Rejected: pivot tables for Sheets' summaries.** A real pivot table needs a cache that Excel
  works out and Univer's open-source packages cannot show; formulas over whole columns give the
  same table, stay live in every spreadsheet app, and need nothing of Herald's to read.

## ADR-022: The desktop pet is built into Herald and shows Hermes's own pet

Hermes has a pet of its own: `display.pet` in its `config.yaml` turns it on, picks a petdex pet
from `~/.hermes/pets` and sets its size, and the Hermes CLI, the TUI and Hermes's desktop app draw
it. Herald OS shows the same pet on its desktop as the visible face of Hermes: it acts out what
Hermes is doing, holds up approvals, chats in a bubble, takes dropped files, walks to the window
Hermes works in, and gets out of the way. It needs the shell's windows, approvals and sessions, so
it is built into the shell (`src/features/pet`, `electron/pet`, the contract in `shared/pet.ts`),
and its actions are commands in the registry (ADR-014).

- **Hermes owns the pet; Herald owns where it stands.** On or off, which pet and its size stay
  Hermes's `display.pet`, written only through Hermes's gateway (`pet.select`, `pet.scale`,
  `pet.disable`), so every Hermes surface agrees. Herald bundles no pet artwork: installing one
  from the petdex gallery goes through `pet.select` too. Main reads `config.yaml` and the pets
  folder itself, as Hermes resolves them, with the `yaml` package (ISC, no dependencies): the pet
  is there before the backend is up, multi-megabyte spritesheets never cross the gateway, and a
  stat check every 4 seconds notices changes made anywhere. Main reads only `display.pet`, never
  logs what it read (the file can hold credentials), and serves a spritesheet only from a pet's own
  folder (one path segment, no `..`, a `pet.json` path only as a plain file name, 32 MB at most).
  Herald's own choices (the spot, put away, reactions, moods, notes, following) live in
  `prefs.json`.
- **The Hermes window is the brain.** Gateway events and server requests, approvals among them,
  reach only the window that owns a session. So the Hermes window works out a snapshot of what the
  pet shows; in panels mode main relays it to the pet's window and the pet's clicks back as
  actions, and in desktop mode both are the same window. Main takes snapshots only from the Hermes
  window, and actions and placements only from the pet's.
- **Approvals on Herald's own card.** The pet holds the request host's approval card, exported with
  a choice handler, a voice hint and no autofocus. It answers only a request that is still pending
  and is an approval, with a choice the card offers; it never answers by itself and never takes
  the focus, so no keypress can approve. In desktop mode the request stack leaves the approval to
  the pet while it holds it; on Linux the Hermes window keeps its copy too, so it cannot get lost
  behind other windows. Questions, passwords and secrets stay in the stack.
- **A quiet chat.** The bubble's questions go to a background Herald session of the pet's own,
  started the way an Office window's Ask Hermes bar starts one, so it never takes over the Hermes
  window, posts into the person's chats or notifies.
- **Following from the command log.** The pet walks to a Docs, Sheets, Slides or Canvas window when
  the command log shows Hermes (its `agent` source) running a command there other than list,
  status, history or layers, rather than on guesses from the tool stream. Desktop mode takes exact
  positions from Herald's window manager. niri reports where floating windows are but not where
  tiles sit in the view, so a tile's place is estimated from the columns before it (their widths
  and niri's 10 px gaps).
- **Moods and notes from what Herald already has.** System status (sampled every 3 minutes, only
  while the pet shows), the flag `herald-os-update --check` leaves on Herald OS Linux, and Hermes's
  turns. They are few (one note at a time, 20 minutes between notes of a kind) and each kind can be
  turned off.
- **An animation that rests.** A canvas draws the spritesheet at Hermes's pace (a 1.1 s loop of six
  frames, about 5.5 a second); idle plays two loops after a change and then rests on one frame
  with no timer, nothing runs while the pet is hidden, and reduced motion shows a still frame. In
  the dev app on macOS that was 14 draws in 2.5 s of cheering, one with reduced motion and none in
  5 s idle, and idle CPU for all its Electron processes (12 samples of 5 s) was 2.41% with the pet
  resting and 2.43% with it put away.
- **On Linux, a window of its own.** The pet is a small transparent window, only as big as the pet
  and what it holds. niri's window rule (`linux/niri/config.kdl`) opens it floating and unfocused
  at the bottom right; Herald moves it through niri's IPC and sizes it through its size hints.
  niri focuses windows on hover and click, so Herald gives the keys straight back (within 0.3 s,
  measured) unless the pet's chat box is open. In the Fedora 44 aarch64 VM (niri 26.04) it opened
  unfocused, carried the box for a pending update, chatted with Hermes, held an approval whose Deny
  reached Hermes, went and came back with Put away, hid for full screen and followed a Docs window.

Alternatives considered:

- **Rejected: the tamahermes plugin from Hermes's catalogue.** It reads other tools' folders
  (`~/.codex` and more) and runs an unauthenticated loopback server; Herald will not install it or
  depend on it.
- **Rejected: a full-screen transparent overlay on Linux.** Wayland has no portable way to let
  clicks through a window, and niri has no rule for a window that never takes focus.

**Known limits.** In desktop mode, web pages (native views) paint above the pet. On Linux the pet
keeps clear of the pointer but cannot see text fields in other windows, and an Office window's own
Ask Hermes sessions do not reach the pet's brain. The automations in the background count are an
estimate (the latest run of the six most recently run enabled jobs, checked every 2 minutes and on
cron changes), and so is a tile's position on niri.

## ADR-023: Herald OS translates its own text, with catalogs of its own

Every string in the shell was English, so someone whose Mac is in Chinese saw English everywhere,
the menus included (#93). Herald now keeps its text in one catalog per language
(`apps/desktop/shared/locales/`), keyed by message and shared by Electron main, for the menus it
builds, and the renderer. English is the source of every message and what shows for any a language
has not translated; Simplified Chinese is the first translation.

- **No i18n dependency.** What Herald needs is `{name}` slots, plural forms chosen by
  `Intl.PluralRules`, the English fallback and types, which `shared/i18n.ts` does in about 160
  lines. The keys and each message's values are typed from the English catalog, so a wrong key or
  a missing value fails the type check; i18next or FormatJS would add a runtime and a message
  syntax for no more than that.
- **Text with slots, not functions.** Hermes Desktop's catalogs hold functions for messages with
  values. Herald's hold text, which a translator can edit without writing code and a test can check:
  every translation keeps the slots English has and uses only its language's plural categories.
- **Following the system unless the person chooses.** The setting (Settings > General, or
  `language.set`) defaults to the system: the first of the OS's preferred languages Herald has, as
  `app.getPreferredSystemLanguages()` reports them to main and `EnvInfo` passes them on. Traditional
  Chinese means English until it has a translation of its own. A change applies at once in every
  window; dates follow a chosen language and keep the system's format while Herald follows it.
- **A surface at a time.** Main's menus, the menu bar, the Overview, the command bar, the
  notifications panel and Settings' navigation, section titles and General section came first; the
  rest moves into the catalogs as it is worked on. Command titles, voice phrases and the app
  registry's names stay English, since Hermes and the voice matcher read them.

Alternatives considered:

- **Rejected: upstream's i18n helpers (`@hermes/shared/i18n`).** They serve catalogs of functions
  and a React context Herald does not use, and would tie Herald's strings to the upstream snapshot.
- **Rejected: Chromium's `--lang` switch, so everything follows the setting.** It takes a restart,
  and it also changes the spell checker's languages and the languages web pages are asked for.

**Known limits.** The macOS app menu is Electron's default, whose items Electron names in English;
translating it needs Herald's own application menu. The items macOS adds to menus, and Chromium's own
text, follow the system's language rather than Herald's.

## ADR-024: The voice's microphone is Herald's own choice where Herald is one app among others

Herald OS opened the system default microphone, and no other could be chosen. A device that went
away while the microphone was open left the graph silent (no `ended` handling, no `devicechange`
handling), and the Sound panel on macOS showed one placeholder output and no inputs at all.

- **Per app off Linux, per session on Linux.** On Herald OS Linux the shell *is* the session, so the
  Sound panel keeps setting the machine's PipeWire default (`pactl`) and that is the microphone the
  voice uses. Everywhere else Herald OS is one app among others: the choice is its own
  (`voice.inputDevice` in `prefs.json`) and the machine's default is left to the system, as the
  Bluetooth panel already leaves pairing to Control Center.
- **Automatic follows the system.** The choice defaults to `null`, meaning "the system default".
  Wearing a headset and letting the system pick it up therefore still works, and a person who never
  opens the picker sees no change.
- **A choice outlives its device.** A chosen device that is not connected falls back to the system
  default and is *kept*: when it comes back it is used again. A listed device that cannot be opened
  (`OverconstrainedError`) is treated the same. The fallback is quiet: the panel's
  line names the device in use and the list says the chosen one comes back on its own — a device
  that sleeps is no problem to report. Two states, not one — what was chosen
  and what is in use — because an app that forgets the choice the moment a device sleeps (as Teams
  does with Bluetooth headsets) never comes back to it.
- **A choice wins over a new device; Automatic does not.** While a chosen device is connected,
  plugging in another one does not take the microphone away from it. In Automatic the system decides,
  so a device the system makes default becomes the one in use.
- **A lost device is reopened, a system change waits.** `track.ended` from an unplugged device
  reopens the stream at once; a change caused by the system is applied when the conversation ends,
  so it never cuts into a sentence being listened to. Three reopens the system caused (a lost
  device, a device list change) in ten seconds is the guard; after that Herald OS keeps the current
  device and says so. A person's picks are not counted: choosing four microphones in a row is not a
  device flapping, and the last one picked is the one used. A device that fails to open falls back
  to the system default; when that fails too, a notice is posted and the stream's holders are told
  (`onFailed`), so Live ends with the reason rather than sending a stopped track. Frame
  subscribers are told too and stay subscribed; the device list is watched for as long as anyone
  wants the microphone, so the next device change (or pick) tries again, under the same guard, and
  the wake word is not left deaf.
- **A reopen is invisible to the consumers.** Frame subscribers keep receiving frames; the WebRTC
  sender holds the stream (`holdMicrophoneStream`) and is handed the new track for `replaceTrack`,
  so a Live session survives a change of device; mute is the graph's state, applied to every
  stream it opens. A holder keeps the microphone open like a subscriber, and releasing the last one
  closes it.
- **One microphone, one choice.** `audio-capture.ts` is the only owner of the mic (wake feed,
  utterance recorder, barge-in monitor, WebRTC sender), so there is one setting, not one per
  consumer. The decisions themselves are a pure table (`capture-policy.ts`), unit-tested without a
  browser.
- **Identity is the id, with the name as fallback.** `deviceId` is stable only for one origin, so a
  choice stores `{ id, label }`: the label identifies the device after a cache clear or a switch from
  a dev build to a packaged one, and the stored id is rewritten to the one found. A name shared by
  two devices identifies neither, so the choice is then treated as not connected. Two devices are
  the same when their groups match, or their ids when either reports no group.
- **The microphone is still only opened deliberately.** A conversation or the armed wake word; never
  by opening a panel, and never while voice is off. The level bar in the pickers is live exactly
  while the microphone is open.
- **Rejected: changing the macOS system default device.** It affects every other app and needs a
  native helper; Herald OS already declines that for Bluetooth.
- **Rejected: a separate microphone for the wake word.** The capture graph is deliberately single.
- **Rejected: priority lists and transport classification.** "Chosen, then system" covers the case;
  Chromium's label already marks `(Bluetooth)`, `(Built-in)` and `(Virtual)`, and Herald OS uses it
  only to order the list, never to decide.
- **Carried forward, not yet done:** the speaker picker (and `voice.outputDevice` with it), a
  Herald-only output volume, and a "no sound from this device" warning after a warm-up window.

## ADR-025: Intel Macs get their own build, not a universal one

The macOS release ships `HeraldOS-<version>-mac-arm64` and `-mac-x64` DMGs and zips, packed in one
`electron-builder --mac --arm64 --x64` run on the Apple Silicon runner (#13).

- **Nothing in the app is Apple Silicon-only.** node-pty, the only native module, ships `darwin-x64`
  prebuilds beside `darwin-arm64`, and `asarUnpack` already carries both; the macOS helpers are
  JavaScript for Automation run by `osascript`; tool lookup covers both Homebrew prefixes. So the
  Intel app is the same build for another architecture, and no x64 runner is needed.
- **The Mac build leaves node-pty's `build/` out** (`mac.files`). node-pty loads
  `build/Release/pty.node` before any prebuild, and a `build/` compiled on the runner is for the
  runner's architecture, so it would break the other app. Each app gets the prebuilds instead.
- **`scripts/check-mac-builds.mjs` guards the pairing.** It reads the Mach-O headers, so it runs on
  any machine. It walks every file in each app and fails the release job unless every Mach-O
  (the main binary, Electron's frameworks, the helper apps, every `.node` and `spawn-helper`) is
  thin and built for that app's architecture. Files under node-pty's `prebuilds/darwin-<arch>/`
  must match `<arch>` instead, since node-pty picks that folder by name, so both apps can carry
  both prebuilds. A `.node` or `spawn-helper` that is not Mach-O fails too, unless it sits in
  another platform's prebuild folder. The DMGs and zips must carry `package.json`'s version, and
  no other DMG or zip may be in `release/`, because the release job uploads all of them.
- **Rejected for now: one universal DMG.** It carries both copies of Electron in every download, and `@electron/universal`
  stops on the node-pty prebuilds that appear unchanged in both halves unless each is listed in
  `mac.x64ArchFiles`. The arm64 file names stay as they were, so existing links keep working.
- **Untested on Intel hardware.** The release workflow checks what the Intel app is built for, but
  no CI job ever runs it on an Intel Mac; the README says so until someone tries it on one.

## ADR-026: The Pet Room shows each live piece of Hermes work as a petdex pet

**Status: Accepted** with its third phase.

The desktop pet (ADR-022) is one face for all of Hermes. The Pet Room is a window where every live
piece of Hermes work in Herald's own backend stands as a pet of its own: each conversation, each
mission and each helper agent a conversation spawned. Pets walk to an area for the tool they are
using, a bubble says the step each one is on, a parent walks a note to a helper it spawned and the
helper brings the result back, a pet raises a sign when it needs an approval, and idle or stuck
agents show what is true about them. The first phase is the store, the shared pet pieces, the
scene, the window in both shell modes, its commands and Settings > Pet Room. The second adds
Herald's automations, an opt-in "elsewhere" lane for Hermes work outside Herald, desks for the
documents open in Herald Office and Canvas, meetings at a desk, the session that ran a command on
the bridge's control-socket requests, and the Room as Herald's screensaver. The third adds live
steps for that outside work from observer hooks in Herald's bridge plugin, Herald's own activity log
and a time-lapse that plays it back, cost meters, and a sprite cache that never refuses a sheet a
view holds.

- **Only what Hermes reports.** The Room's store (`src/features/room`) is event-sourced: one record
  per agent (kind, title, parent, phase, area, target, step, last event, approval), folded by pure
  reducers from frames and records, and every field keeps a trace of what set it (the frame's type
  and seq, or the method, and when the Room received it). Frames are cut down as they arrive: no
  message or reply text, thinking, tool arguments, previews or results survive, only a tool's name,
  an area and a target that is a name (a file's last path segment, a document's name, a web host
  without its credentials, path and query, an app's name from Hermes's tool labels; the target keys
  are Hermes's own `delegate_tool_results._TOOL_INPUT_TARGET_KEYS`). Steps and facts come from fixed
  tables ("reading Budget.xlsx", "running a command", "waiting for your OK"); a terminal step never
  shows its command. The one free text is a finished helper's result: the first sentence of Hermes's
  summary, with code, tables and Markdown taken out.
- **Read-only calls that attach to nothing.** `session.active_list` lists the live sessions and their
  status (`waiting` while a request is open); `session.events.since` reads any session's event ring
  without attaching; `delegation.status` lists the running helpers (`owner_agent_session_id` is the
  parent's `session_key`); `config.get {key: focus}` reports `display.tool_progress`. Frames this
  window already gets as an attached client are deduplicated against polled ones by seq, with one
  watermark per session and backend epoch. The Room never calls `session.activate` (it would make
  the window a viewer that receives approvals and would touch `last_active`), `approval.pending`
  (it can start an agent build for a lazily resumed session), the `session.usage` RPC (it fetches
  account usage over the network), `session.resume`, the `subagent.*` controls or `pet.*`. A
  method-not-found turns off only its part of the Room, and the header says so.
- **Reads that do not raise other windows' requests.** Hermes answers `session.events.since` with
  the requests still open on the session, and the gateway client hands those to the calling
  window's request handlers as if they had just arrived. A guard bound ahead of
  `bindServerRequests` drops the ones the Room's own reads bring back for sessions another window
  holds, so their cards neither show in the Room's window nor get declined there; the Room leaves
  alone a session this window holds while one of its requests is pending, so a read cannot bring
  back a card the person just answered.
- **Polling that follows the work.** About once a second for each session that works or waits and
  every 10 s for idle ones; the session list every 3 s while anything works and every 15 s when the
  room is quiet, and soon after `sessions.changed`; the helper list every 2 s while helpers run;
  `display.tool_progress` every minute. A session whose frames reach this window live is skipped for
  a round. A first read asks for the latest seq with a probe that returns no frames and then takes
  only the last 200 frames, so it never pulls a ring's megabytes. Nothing polls while the Room is
  closed, minimized or hidden.
- **Kinds, and the person's own pets.** A helper is a kind of its own; a session that keeps a todo
  list is a mission (Herald's missions start with one); the rest are conversations; automations and
  work elsewhere (phase 2) are kinds too. Each kind shows the installed pet the person picked in
  Settings > Pet Room, or one the Room picks so kinds differ; agents that share a sprite wear colour
  tints that stay theirs while they are in the room. The Room never installs a pet and never calls
  `pet.select`, which would change the pet every Hermes surface shows.
- **One scene, one clock, a capped cache.** The desktop pet's pure parts (sheet layout and poses,
  sheet decoding, activity and step rules) moved to `src/features/petdex`, which the desktop pet and
  the Room share, together with a renderer-wide sprite cache keyed by slug and revision that holds
  at most four decoded sheets (each about 11 MB of pixels) and one animation clock that wakes once
  for the earliest frame any pet needs and not at all when every pet rests. The Room draws every pet
  on one canvas over a static DOM floor plan, with name tags, bubbles and signs in DOM placed by the
  same tick; walks and fades tick about 30 times a second; a working pose plays a few loops after
  each piece of news and then holds, so a pet with nothing new stops moving; and a tick that would
  draw the same picture draws nothing. The desktop pet draws exactly as before.
- **Approvals on Herald's own card, answered only by a click.** Only plain approvals reach a pet;
  clarify, sudo and secret requests put the pet on the bench with a fact and stay in Hermes. The
  sign opens the request host's approval card, with the choices it offers and no focus taken. The
  window that holds the request answers through the desktop pet's `answerApproval`; any other
  window sends `approval.respond {session_id, request_id, choice}`, which withdraws the card in every
  window and keeps once, session, always and deny as they are.
- **Facts, not verdicts.** "idle for 12 minutes", "quiet for 4 minutes during a turn" (no frame for
  a minute while a turn runs), "same call 3 times" (identical consecutive tool calls, compared by a
  hash of the arguments taken on arrival), a guardrail halt from Hermes's status line mapped through
  a table of its codes, and how a helper ended (done, could not finish, ran out of time, was
  stopped). `store/agents.ts` no longer reports timed-out and interrupted helpers as complete, and
  prunes finished ones.
- **A window in both modes.** On the Mac it is a floating app opened from the Dock, the launcher, the
  Missions page and Settings; on Herald OS Linux it is a `window:room` surface, "Herald OS · Pet
  Room", with its own gateway client and a niri rule that tiles it at a third of the screen.
  `room.open` and `room.status` are commands like any other ("show the pet room").
- **Room for the later phases.** The store's reducer takes an open union of inputs, so phase 2's
  automations, lane, desks and commands came in as new inputs, phase 3's live steps and cost reads
  did too, and the activity log keeps a view of the same records. The scene takes its state as props (the
  screensaver drives it with `chrome`, `names`, `deskNames` and `interactive` off), and its areas,
  spots and lanes are a table, so the Automations corner, desks and the lane are entries. Helpers'
  `subagent.complete` token, call and cost counts are kept on `RoomResult`, which phase 3's cost
  meters show.

Phase 2:

- **Automations, coarse on purpose.** Cron agents send no gateway events, so an automation's pet
  shows only what the Automations page knows, from the same routes through Herald's backend:
  `/api/cron/jobs` for each job's name and its last run's time and outcome, and
  `/api/cron/jobs/{id}/runs?limit=1` for whether a run is under way (Hermes's own `is_active`: not
  ended and heard from in the last five minutes). A job's prompt, script, delivery target, error
  text and run titles never reach the Room. Jobs are read every 2 minutes, every 30 s while one
  runs, and a second after `cron.changed`; a job's latest run every 5 minutes, every 15 s while it
  runs, at once when its record moves, and after `cron.changed` for every job, because a scheduler
  claims a run before its record shows a change; a run not yet under way is read once more 5 s
  later. An automation that runs when something happens is a paused job by design and is not shown
  as paused. Its pet stands at the Automations board at the front of the room: at work while a run
  is under way, resting between runs, with "running for 3 minutes", "ran 2 hours ago", "failed 5
  minutes ago", "not run yet" or "paused". It opens `automation.show`.
- **The elsewhere lane: opt-in, coarse and outside the room.** `room.elsewhere` in prefs.json is off
  unless the person turns it on, and while it is off `/api/sessions` is never called. On, the lane
  reads `/api/sessions?order=recent&limit=40&exclude_sources=herald_os,hermes_os,tool` once a
  minute, keeps each row's id, title, source, times and `is_active` (never its preview, model or
  counts), and leaves out Herald's own sessions (by source, and by the stored ids its live agents
  hold), helpers, and runs of automations the Room already shows (`cron_<job id>_<time>`). Rows last
  active more than an hour ago are dropped, at most 12 are kept, and where each runs comes from a
  fixed table of sources ("Telegram", "the Hermes CLI"). Its label is as of the last read ("Telegram
  · active now", "the Hermes CLI · last active 25 minutes ago"), it shows no steps, its pets never
  walk or open anything, and its header says it is coarse. The lane takes the right edge of the
  scene; the room gives up its width.
- **Desks from presence, by name only.** The documents Herald's Office and Canvas windows report
  open (`office.presence`, `canvas.presence`, which main answers in both shell modes) stand as desks
  below their app's station: a document's key and name, never its path, selection or what is in
  front inside it, at most four an area and as many as fit the floor. An agent works at a desk when
  its target names the document; else when the latest Office or Canvas command its session ran in
  that app, within its turn and the last five minutes, names one (a closed document gets no desk);
  else, for a call on "the document in front", at that app's front document. The desk is traced to
  the frame, the command or the presence that put the agent there. Desks keep their places as
  documents come and go, and a window that reloads stops reporting what it had open.
- **Which agent ran a command.** The bridge sends `get_session_env("HERMES_UI_SESSION_ID")` (the
  live gateway session id Hermes binds for tools) as `session` on each control-socket `ui` request,
  only when bound. The shell takes it only as an id (`[A-Za-z0-9_.:-]{1,128}`), keeps it on
  `CommandEvent.session`, and an older bridge without it still works. The Room cuts each agent's
  Office or Canvas command down to its id, session, app and document name, from the same rule the
  desktop pet follows windows by (`followFrom`); in panels mode the Hermes window relays those to
  the Room's and the screensaver's windows with `ifOpen`, so the relay never opens a window.
- **Meetings.** Two or more working agents at one desk, or on one document in an area with desks,
  meet: they stand on either side of the desk and each tag says "2 agents on Launch plan.docx", a
  hint rather than a warning.
- **The Room as the screensaver.** `room.screensaver` (off by default) shows the scene in Herald's
  existing screensaver in both modes (`$screensaverUp` over the desktop, the `screensaver` surface
  in panels mode) with no header, names, facts, result summaries, document names or words on the
  furniture, and nothing that answers or opens; `room.screensaverSteps` brings back the step
  bubbles. Any key, click, pointer move or wheel ends it after a 1.2 s grace. It decides once
  Herald's preferences have loaded, and shows the clock instead while Herald Slides presents (the
  Slides store in desktop mode, the compositor's windows in panels mode) or the desktop pet is put
  away for a screen share, the one sign of sharing Herald has. The panels-mode screensaver window is
  resizable, so niri's full screen sizes it to the output.
- **Preferences a window saves.** `setPetPrefs` and `setRoomPrefs` send only the fields they change,
  and main merges them into what is on disk. Before, a window sent its whole pet object, so a stale
  copy (another Herald sharing prefs.json, such as a dev app beside the installed one, or a file
  restored from a backup) wrote `hidden: false` back with any pet change, and the next broadcast
  brought a put-away pet back: the likely cause of the one time it came back during phase 1 testing.

Phase 3:

- **Live steps from outside Herald: a second switch.** `room.elsewhereLive` sits under the lane's
  switch, is off by default and counts only while `room.elsewhere` is on. Someone who turned the lane
  on in phase 2 agreed to titles and activity read once a minute; live steps tell Herald much more,
  in real time, from every Hermes process (each tool, the names of files, folders and sites, helpers,
  approval waits), so that takes a yes of its own, and turning the lane on never turns them on.
- **Observer hooks that do nothing unless asked.** Herald's bridge plugin registers `pre_tool_call`,
  `post_tool_call`, `subagent_start`, `subagent_stop`, `on_session_start`, `on_session_end`,
  `pre_approval_request` and `post_approval_response` (the last so a sign clears when it is answered,
  not when the command ends). The backend Herald OS starts registers none, and other processes skip
  Herald OS's own sessions as the tools do. A hook first reads a cached answer to whether any
  running Herald asks for live steps: each Herald writes `$HERMES_HOME/herald-os/observe/<pid>.json`
  (0600 in a 0700 folder, written whole and renamed) at start and on every Room preference change,
  with `live`, and only while live the socket it serves and an activity token; the plugin reads the
  folder at load and at most every two seconds while hooks fire (a profile home also reads the root
  home's), and trusts only files this user owns that nobody else can read, naming an absolute
  socket. With nothing live a hook returns at once: nothing is queued and no thread starts. Hermes
  waits on most hooks and blocks the tool when `pre_tool_call` raises or stalls, so every callback
  swallows its errors, returns `None` and only appends a record to a bounded queue (512) that a
  daemon thread sends in batches of 100. A record keeps a kind, session ids, the tool's name, a
  target cut to a file's last segment, a folder's name (only the working folder for `terminal`) or a
  web host, 16 hex digits of a hash of Hermes's call id to pair a start with its end, a status from a
  fixed list, the session's source and when the hook fired: never content, arguments, commands,
  results, errors, goals, summaries, what an approval asks or how it was answered. Approvals that
  Hermes's smart mode decides wait on nobody and are not reported.
- **The `activity` command, under a token of its own.** An always-written file that held the
  per-launch `ui` token would let any process of the user drive Herald's interface; the activity
  token lets a process report and nothing else, is compared in constant time, and is replaced when
  live steps go off. Both control sockets answer `activity` before the `ui` token check, take at most
  100 events a request and 400 events and 50 requests a second from all processes together, check
  each event with `roomActivityOf` (`shared/room.ts`), give it a seq of main's own and a time no later
  than its arrival, and send it to the windows that watch, a window that starts watching first
  hearing the last ten minutes (2000 events at most). The replies are fixed strings the plugin acts
  on: a refusal stops it sending to that Herald until its file changes. Both sockets now close a
  connection whose unfinished line passes 1 MiB. One file per Herald lets a dev app beside the
  installed one each have its own.
- **Outside work in the room.** Events fold into the lane's `e:<stored id>` records: an event for a
  session the lane does not list yet brings it in at once (where it runs from the source, no title)
  and asks for an early lane read; a helper is `e:<its own session>`, which its own tool calls
  address, wears the lane's pet and comes in with a note from its parent and walks its result back.
  The fixed tables give the area and step, so outside work walks to a station, waits on the bench
  under a sign that is never a button ("Needs your OK in the Hermes CLI"), never holds a
  `RoomApproval` and opens nothing; interactivity and the door follow the kind, not the area. Events
  about Herald's own sessions, helpers or the board's automation runs are dropped; a resubscribe's
  replay is deduplicated by seq; a turn's end from the plugin outranks the session list's
  `is_active` for whether the pet rests; work that says it is busy but sends nothing for ten minutes
  goes back to coarse; turning live steps off drops every live field and the outside helpers.
- **Herald's own activity log.** `room.log` (off by default) and `room.logDays` (7, or 1, 3, 14 or
  30). The Hermes window is its one writer in both modes and, while the log is on, keeps the Room's
  feed running with nothing showing it, even while hidden. It writes a `begin` and every agent, then
  an `agent` line only when an agent's logged view changes (kind, phase, area, step, target, waiting
  or not, parent, where outside work runs, how a helper or a run ended), `gone`, hand-offs, and an
  `end` whenever the feed stops (switched off, disconnected, the page going away, a renderer reload)
  and at midnight; titles, desks, facts and approval details never enter it. Main checks every entry
  (`roomLogEntryOf`), files it under its local day in `room-log/YYYY-MM-DD.jsonl` (0600) in Herald's
  data folder, replaces each agent id with 12 hex digits of an HMAC under that day's random salt so
  Hermes's session ids never reach the disk, writes a `cap` and stops for the day at 8 MiB, keeps the
  folder under 64 MiB oldest day first, removes days past the retention, appends `end` on quit, and
  deletes everything on Delete activity log (after which the window begins the new file afresh).
- **The time-lapse.** It reads one day and indexes it once, with a keyframe every five minutes of log
  time, so a seek folds at most that much. A stretch runs from a `begin` to the next `end`, `cap` or
  `begin`, else to its last entry, and today's open stretch while the log is on runs until the day
  was read; outside the stretches the room is empty and says what was not logged. It is the same
  scene with `interactive` off, no-op handlers and `r:` ids nothing live answers to, pets named by
  kind, approvals as signs that answer nothing, the lane in its own words ("As the Room showed it
  then"), a 4-a-second timer that stops when hidden, and stillness while paused or under Reduce
  Motion.
- **Cost meters, from what Hermes already reports.** `room.costs` (each tag) and `room.costTotal`
  (the header), both off by default and never in the screensaver. A conversation's tokens are the
  running totals of `message.complete.usage` and `session.usage` frames, with the turn's share as
  their difference since `message.start`; tokens count input and output, since Hermes counts
  reasoning inside output. Money for Herald's own sessions comes from `/api/sessions` with
  `sources=herald_os,hermes_os`, read about once a minute and a few seconds after a turn, only while a
  meter option is on (phase 2's rule that `/api/sessions` is never called while the lane is off still
  holds for everyone else's sessions); the lane's rows keep their counts and cost only then; a helper
  has `subagent.complete`'s, an automation its latest run's row. The `session.usage` RPC, which
  fetches account usage over the network, is never called (a test checks). An estimate says so
  ("~$0.05 est."); a status of `actual` without a billed amount is shown as an estimate; a count of
  zero shows nothing. The total leaves helpers out, as Hermes adds a helper's cost to its parent
  conversation, and is an estimate when any part is. With meters showing, the front row and the
  lane's rows leave room for the extra line.
- **A sprite cache that never refuses a held sheet.** During the Pet Room video one pet never loaded:
  the desktop pet kept its sheet even while put away, Settings' previews held more, and the Room's
  rule of four slots less one for a shown desktop pet did not see either. Now a sheet a view holds is
  never refused for room: the cap (4) is how many unheld sheets stay decoded for reuse, released
  longest ago first, and a ceiling of 12 decoded sheets is the only refusal; a sheet that cannot be
  read keeps no slot and is not read again for ten seconds or until its revision changes. The Room
  takes one sheet for each kind of work, and a pet whose sheet failed draws a plain static figure in
  its tint where its sprite would be (never while it is still loading); Settings' previews show a
  paw.

Phase 0 findings (the installed Hermes, a git checkout from 2026-09-25, and the pinned upstream
v0.21.5 have the same methods and shapes; measured in the dev app on an Apple Silicon Mac):

- `session.active_list` answered in about 1 ms; its rows also carry `preview`, the last message's
  text, which the Room never reads. `session.events.since` answered in 0.8 ms on average and 3.4 ms
  at most, and an unknown session id gives an empty answer, not an error. A two-tool turn polled
  every second moved 40 KB in 27 polls; after five turns a session's ring held 284 events and
  242 KB. Frames carry no time, so the Room stamps them on arrival; `session.info` arrived only when
  a session opened and after each turn, so turns are read from `message.start` and
  `message.complete`.
- In this Hermes `delegate_task` dispatches helpers in the background: the tool returned in 0.05 s
  and the parent's turn ended while its two helpers worked. They reported `subagent.start`,
  `subagent.tool`, `subagent.progress` and `subagent.complete` (summaries of 249 and 424
  characters, 5.8 s and 24.3 s) on the parent's session, and after the last one a new parent turn
  delivered the results. `delegation.status` answered in under 1 ms.
- With approvals set to manual for the test (the config was restored byte for byte), the session
  listed as `waiting`, `open_requests` held the approval with the same id as the Hermes window's
  card, and `approval.respond` resolved it in 0.6 ms: the card went away in the Hermes window and
  the command ran. In smart mode Hermes's judge ran the same harmless command without asking.
- `display.tool_progress` was unset, so `all`. Switched off for the test, a turn sent no
  `tool.start` or `tool.complete` at all, and `config.get {key: focus}` reported `off`; the Room says
  so instead of guessing.
- A method the backend does not have rejects with code -32601.
- Polling five calls a second (four sessions at once a second, the session list and the helper list)
  for a minute took the backend from 3.63% to 3.85% of a core and the renderer from 0.82% to 0.87%.
  With the Room built, an open room with two resting pets cost about 0.4% of a core across all of
  Herald's processes; with a conversation in a long command and its pet holding still, about 1.8%,
  nearly all of it compositing on a 3440-pixel display.
- Hermes also has "hosted rooms", group chats titled "Group: …"; the Pet Room is unrelated, and its
  name keeps them apart.

Alternatives considered:

- **Rejected: attaching the Room to sessions** (`session.activate`, `session.resume`) to receive
  their frames and requests. It changes which window holds the session's approvals and touches
  what Hermes and other surfaces see.
- **Rejected: reading tool results for Hermes's guardrail notes.** They are in the model's view of
  the result, next to file content; the Room counts identical calls itself.
- **Rejected: a canvas or a timer per pet**, as the desktop pet had: the cost grows with every
  agent, and many timers drift apart.
- **Rejected: one `/api/sessions?source=cron` call for every job's runs.** It covers one profile;
  the Automations page reads each job's runs from the profile that holds it, and so does the Room.
- **Rejected: the lane on by default, or previews for richer labels.** Work outside Herald is the
  person's other surfaces: the lane is opt-in and stays at titles and activity.
- **Rejected: giving a command to whichever agent is in that app.** Two agents in Docs at once are
  ordinary; the session the bridge sends tells them apart.

Phase 2 findings (the same installed Hermes, the dev app on an Apple Silicon Mac, and the QEMU VM in
panels mode):

- `HERMES_UI_SESSION_ID` is the gateway's live session id (eight hex characters), the id
  `session.active_list` lists. A `ui` request sent with it through the bridge landed on the command
  log with that session, while the agents' own commands through the installed, older bridge
  carried none and ran as before.
- A triggered test automation showed as running about 2.5 s later, through `cron.changed`.
  `POST /api/cron/jobs/{id}/trigger` returns only when the run has finished; the run's session is
  `cron_<job id>_<YYYYmmdd_HHMMSS>`, and its usage line goes to `cron/usage_audit.jsonl` and its
  execution to `cron/executions.db`.
- Hermes CLI one-shots (`hermes chat -q … --oneshot`) are stored with the source `oneshot`.
- Office presence names a document without its extension ("Launch plan"), so names are compared with
  or without one.
- A renderer reload keeps its web contents, so main went on reporting the documents of Office and
  Canvas windows that were gone; presence is now cleared on `did-navigate`.
- In the VM, niri runs nested in cage, and the display Electron reported (1540x936) was larger than
  niri's output (1508x894): the screensaver window, not resizable, overhung the screen.
- An open Room with four resting pets (two of them automations) and three desks cost about 0.6% of a
  core over the same Herald with the Room closed, across main (0.07 points), the GPU (0.23), the
  renderer (0.04) and Hermes (0.24). As the screensaver, the Room cost about 0.65% more than the
  clock.

Phase 3 findings (the same installed Hermes, the dev app on an Apple Silicon Mac, a throwaway
Hermes home under /tmp, and the QEMU VM in panels mode):

- A Hermes CLI one-shot run from a folder under /tmp, with the worktree's plugin as a project plugin
  (`HERMES_ENABLE_PROJECT_PLUGINS=1`), came into the lane as "the Hermes CLI" at once, walked to
  Files during its `read_file` and back to the lane when the turn ended. With live steps off its
  next one-shot sent nothing, and the file named no socket or token. Driving the hooks from a script
  against the throwaway home's Herald, a wrong token, a shorter one and none were all refused; a
  Telegram session stood at the Terminal "running a command" with only its folder's name, its helper
  searched the web with no query shown, and a CLI approval stood on the bench under a sign that
  cleared when the approval ended. In the VM the file named `$XDG_RUNTIME_DIR/herald-os/control.sock`,
  the same steps and sign showed in the Room's window, and only the Hermes window wrote the log.
- `on_session_end` fires as each turn ends, while `on_session_start` fires only for a new session, so
  a resumed one is first heard of at its first tool call. `subagent_stop` has no `child_subagent_id`,
  approval hooks carry a session id only during a tool call, and `post_tool_call`'s status also
  says `cancelled` and `timeout`. While any `post_tool_call` hook is registered, Hermes works out
  each result's status, gate closed or not.
- A helper's session is stored with its parent's source (`herald_os` for Herald's), not `tool`.
- Hermes gives a new session an instant title, the first line of the message that started it, until
  its model title arrives: the lane shows that title for a minute or so, as Hermes's own apps do.
- A first lane read could come before the first automations read and let the board's own runs into
  the lane for a minute; an automations read now takes them out.
- Six different sheets were decoded at once in one window (the Room's three kinds, Settings' two
  other kinds and the desktop pet), none refused; a damaged sheet drew the fallback figure.
- Cost meters: a test conversation read 48k tokens from its frames and its estimated cost from
  `/api/sessions`, which rose when its helper's cost was folded in; the helper read 73k tokens at
  its end.
- Whole-app samples of the dev build swing by a point or two between identical minutes, more than
  the Room's share, so the renderer's main-thread time (DevTools' TaskDuration) was compared
  instead: 1.28% of a core with the Room closed, the same with the log on and the Room closed, 1.33%
  with the Room open (resting pets, the lane, meters, the log), and 2.49% while a time-lapse played
  at a minute a second. A hook with live steps on takes about 2.5 µs.
- Running the Hermes CLI with a fresh `HERMES_HOME` against the self-updating install made Hermes
  finish what it took for an interrupted update, which rebuilt the TUI, the web UI and the desktop
  app from the installed checkout and reinstalled `/Applications/Hermes.app`; test homes now point
  at an installed runtime only once that home is set up, or use a project plugin in the person's own
  home.

Phase 3 alternatives considered:

- **Rejected: one switch for the lane and live steps.** It would widen, without asking, what those
  who turned the lane on in phase 2 agreed to.
- **Rejected: the per-launch `ui` token in an always-written file.** Any process of the user could
  read it and drive the interface; the activity token can only report.
- **Rejected: events from the plugin to the gateway.** Plugins cannot send gateway events (ADR-014),
  and the processes outside Herald are not Herald's backend anyway.
- **Rejected: logging from the Room's window, or in main.** The Room's window is open only some of
  the day and in panels mode is a second writer; main has neither the gateway client nor the
  reducer. The Hermes window already has both.
- **Rejected: titles in the log.** They are often the person's own first words; a replay names its
  pets by kind.
- **Rejected: a bigger fixed cap for every sheet.** Unheld sheets would take memory for nothing; the
  views that hold sheets bound what is decoded, under a ceiling.

Changes upstream that would help (not proposed there):

- A time, and a seq the Room can rely on everywhere, on every gateway event frame: the Room stamps
  frames when they arrive, up to ten seconds late for an idle session.
- A helper's target and its running token and cost counts on `subagent.*` events, not only when it
  completes: today a helper's tool shows without what it works on, and its meter only at its end.
- A side-effect-free call to observe a session's live state and open requests without attaching,
  touching `last_active` or replaying requests to the caller's handlers.
- A turn-start hook without the message, `on_session_start` for resumed sessions, `child_subagent_id`
  on `subagent_stop`, and a session id on every approval hook.
- Not working out `post_tool_call`'s status from the result when no consumer asks for it.
- A fresh `HERMES_HOME` that does not set off the install's update tail.

**Known limits.** Times are when the Room received a frame: up to a second late for a working
session and ten for an idle one. A session counts as a mission only once it keeps a todo list. With
`display.tool_progress` off, pets cannot show tools or areas. A session's ring keeps 512 frames, so
a burst between two polls can drop frames, which the Room reads as a gap rather than guessing.
Helpers show the tool they use but not its target, since Hermes gives only a free-text preview. A
backend restart starts the Room again from what Hermes lists. An automation's run is under way by
Hermes's `is_active`, so one that died silently looks under way for up to five minutes. The lane
reads the default profile's sessions, and its labels are up to a minute old. A document gets a desk
only while it is open in Herald, and meetings are found only in the Office and Canvas areas. The
screensaver knows of Herald Slides presenting and of the pet put away, not of another app sharing
the screen. Commands from an older bridge carry no session, so their agents find desks by their
steps alone.

Live steps come only from Hermes processes on this computer that load Herald's bridge plugin from
this Hermes home (or, for a profile, from the root home); a profile's sessions are not in the lane's
list, so they show with no title. A tool call that takes milliseconds may end before its pet has
walked anywhere. An approval in a process where Hermes binds no session id is not shown, and a sign
or a busy turn that hears nothing for ten minutes goes back to coarse. Two Heralds on one account
serve one socket path, so only the one started last hears live steps. The activity log holds what
the Room showed while the Hermes window fed it: a reload, a lost connection or a closed Herald is a
gap, a day is the local day it was written on, and a replay names pets by kind. Cost meters show a
helper's tokens only once it finishes, and the total is of the work in the room now, not of a day.

## ADR-027: Herald Calc is math.js under Herald's own sentence parser, and the math tool Hermes uses

**Status: Accepted.**

Herald Calc is a notepad where each line is a calculation written the way people say it ("20% of
84.50", "5 km in miles", "days until Dec 25", "9am Sydney in New York"), answered as they type,
with a classic keypad and its scientific and programmer modes, graphs, a searchable history, and
links to Herald Sheets and Docs. The same engine answers Hermes's `calc` tool, the `calc.*`
commands, `herald-os calc` and simple spoken math, so a number Hermes gives is worked out, not
guessed.

- **math.js for numbers, units and functions; Herald's parser for sentences.** math.js (Apache-2.0)
  brings exact decimal arithmetic on arbitrary-precision decimals, fractions, a unit system whose
  conversions include temperature offsets, and the usual functions, in one well-tested library. The
  forms people write (percent of, off and on, "what % of", "split 3 ways", labels, names, totals,
  "in" and "to" conversions, currency symbols, number styles of their region) are read by Herald's
  own parser and evaluator, which keep exact fractions themselves and hand math.js 64-digit
  decimals, units and functions, so math.js never sees English and every form has a test.
  math.js is loaded only when Herald Calc, a `calc.*` command or voice math first needs it: it is a
  chunk of its own (about 180 KB compressed), and so are Herald's engine and the window. What the
  shell loads at start is the commands and the voice grammar with the words and places it knows,
  about 27 KB compressed.
- **"in" after a plain number is inches when a length follows.** "12 in cm" is 30.48 cm, the way
  people write inches, and the 10 of "5 ft 10 in cm" is inches too. Only a number written there
  counts: a name, a sum or a bracket before "in" keeps its value ("x in cm" is 12 cm after "x =
  12", "12 + 3 in cm" is 15 cm), "to" and "as" never mean inches, and `calc.convert` writes "to"
  for an amount with no unit. Voice math writes the inches out ("12 inches in cm"), so the answer
  says what it read.
- **Dates and time zones from the platform.** Calendar arithmetic and time-zone conversion use Intl
  and the system's time-zone database, daylight saving included, so nothing is fetched for them and
  nothing goes stale with the app.
- **Currencies from the ECB, at most once a day, and nothing else on the network.** The European
  Central Bank's daily reference rates come through Frankfurter's keyless v2 route for that provider
  (`api.frankfurter.dev/v2/providers/ecb/rates`); Frankfurter's operators encourage caching, set no
  quotas and log no personal data, and the ECB allows reuse of its rates with the source named. Main
  fetches, never a window: only when a calculation names a currency and the cached rates are a day
  old, never twice within a day, and a failed try waits an hour. The request is a bare GET with an
  Accept header. The rates live in Herald's data folder, so conversions work offline from the last
  rates with a quiet "Rates from <date>", and a setting turns the fetch off.
- **One engine for the person and for Hermes.** The `calc.*` commands in the registry run the
  engine in the shell; the bridge's `calc` tool relays to them and is read tier, because it only
  computes: it opens no window (its plot action returns what a graph shows; `os_ui` with
  `calc.plot` shows one) and reads the history without clearing it. The `herald-calc` skill tells
  Hermes to use it for any arithmetic, percentage, unit, currency, date or time-zone math and to
  show the working the engine returns. The CLI runs the same commands.
- **Voice math on the fast path, and only simple math.** A pure grammar accepts an utterance only
  when every word is a number, an operator word, a unit, a currency, a place or a date word, and
  hands it to `calc.eval`, which answers at once with the voice Herald already speaks with.
  Anything else, including "15% of my rent", goes to Hermes unchanged.
- **A plotter of our own on a canvas.** Drawing functions well is mostly sampling: adaptive steps
  where a curve bends, no line drawn across an asymptote or a jump, gaps where a function has no
  value. A small canvas plotter does that exactly, takes its colours from Herald's theme tokens,
  and adds no dependency; ECharts, already in the bundle for Sheets, samples evenly and knows
  nothing of asymptotes.
- **Copy to Sheets writes formulas.** Each line becomes a row: a formula where the line maps
  cleanly onto a spreadsheet (arithmetic, percentages, splits, sums, names used later as cell
  references), the value otherwise, and the line's label in the next column. In panels mode, where
  Herald Sheets is another process, Calc opens a blank workbook there and writes into it through
  main's Office relay, since `sheets.new` there opens a workbook without values.
- **Everything stays on the computer.** Notes (a JSON file each), the history (the newest 2,000)
  and the rates are in `calc/` in Herald's data folder.

Limits. The ECB publishes about 30 currencies once each working day, so rates are a day old at best
and some currencies are missing; they are reference rates, not what a bank charges. Months and
years as durations are calendar months and years in date sentences and average lengths in unit
arithmetic. The voice grammar is English.

## ADR-028: When Hermes cannot speak, the computer's own voice does, on Herald's player

**Status: Accepted.**

Microsoft began asking its free read-aloud service for a new token, and the edge-tts Hermes pinned
(7.2.7) got HTTP 403 for every line. Edge is the free provider the voice falls back to (ADR-013), so
nothing was left to try: the voice went quiet, and every reply showed the raw error.

- **The chain ends with the computer's voice.** Speech goes to the configured provider, then to the
  free Edge voice when that provider is not set up, then to the system voice when Hermes's voice
  still fails for any reason. A failure of the free provider is never a setup problem, so it does
  not touch the config.
- **Rendered in main, played by the renderer.** Main renders a line to WAV (`say -o` on macOS;
  espeak-ng, espeak, then flite on Linux) with the text on stdin, and the renderer plays it on the
  whole-utterance player Hermes's speech uses. Echo cancellation only removes what Chromium plays,
  so a voice played by `say` itself, or by `speechSynthesis` (which hands speech to the system), would
  reach the microphone and trip barge-in on itself. The shared player also keeps the stop button,
  barge-in, the end of a conversation and the output device working as they do for Hermes's voices.
- **A few sentences at a time.** `say` takes a second or two to start and renders about five times
  faster than it speaks, so a reply is cut into a short first part and longer ones after it, each
  rendering while the one before plays. A part is at most 1,000 characters and 30 seconds, main runs
  four renders at once at most, and a reply is cut at about five minutes.
- **A stop drops lines still being made.** Barge-in, the stop button and the end of a conversation
  make every playback ticket taken before them stale, and a line whose ticket is stale is never
  played. That also closes an older gap, where Edge audio that arrived after a barge-in played over
  the next request. A stopped clip's wait now ends at once too: once the player takes the source
  away and loads, Chromium fires neither `pause` nor `error`, so a stop used to leave a spoken
  notification, and Say hello, waiting for good.
- **Once a session, in plain words.** The first stand-in, and the first time nothing can speak, each
  post one notice; the error goes to the log. Say hello reports which voice spoke instead.
- **Rejected: `speechSynthesis`.** No echo cancellation, no shared stop, and on Linux it needs
  speech-dispatcher and a Chromium switch the image has neither of.
- **Linux.** The image lists flite itself. ffmpeg-free's filters (and the omakase apps' WebKitGTK)
  pull it in as well, so listing it adds nothing to the image, but the voice no longer depends on
  them. It speaks English, so it stands in only for an English locale. espeak-ng would cover other
  languages for about 24 MiB installed (9.4 MiB to download), and is not in the image.

## ADR-029: NVIDIA's driver comes in an image of its own, built on Universal Blue's signed modules

**Status: Accepted.** Supersedes the decision in #62, which closed an NVIDIA image as not planned.

Local models want CUDA, and the default image drives NVIDIA GPUs with nouveau, which has none. The
driver's kernel modules are built for one kernel and, for Secure Boot, signed; a bootc image can
neither build them on the person's machine (akmods writes to `/usr`) nor sign them with a key it
does not hold.

- **A second image, not a choice inside one.** `ghcr.io/iamlukethedev/herald-os-nvidia` is the
  default image plus `linux/image/nvidia.sh`: `linux/image/Containerfile.nvidia` starts from the
  default image the same run builds, so the two cannot drift. Everyone else keeps an image without
  NVIDIA's proprietary userspace, its 1 GiB, or a second signing key. x86_64 only.
- **Universal Blue's prebuilt modules.** `ghcr.io/ublue-os/akmods-nvidia-open` publishes NVIDIA's
  open modules for each Fedora kernel, signed with their key, with negativo17's driver to match;
  the images' labels name Bluefin and Aurora, which use them too. Building and signing them here
  would mean a kernel-module key of our own for people to enroll, and a build per kernel; theirs
  may already be enrolled on machines switched from those systems.
- **Rejected: a Universal Blue base image.** Their NVIDIA images start from Silverblue's desktop
  base, not `fedora-bootc`, and would change everything under Herald, not only the driver.
- **Trusting Universal Blue, checked.** Enrolling their key trusts every module (and boot binary)
  they sign with it, for good, and that was accepted. The build trusts no more than that: the akmods
  images go in by digest once their cosign signatures check out against Universal Blue's key,
  committed in the repository; `nvidia.sh` pins the certificate people enroll by its SHA-256 and the
  repositories' signing keys, and checks negativo17's signatures on the driver RPMs against a key
  database that holds that key alone. `kmod-nvidia` carries no RPM signature; the cosign signature
  on its image vouches for it.
- **Digests resolved each run, not committed.** Each run resolves the akmods tags for the base's
  kernel to digests, logs them, checks their cosign signatures and builds from those digests;
  `Containerfile.nvidia` has no default for them, so no build takes a tag as it stands. The digests
  are not in the repository, so a run takes what Universal Blue signed for that kernel without a
  change here. The stricter alternative is to commit the digests and have a bump PR (by hand or
  automated) move them with each kernel: every module build would then be reviewed before it ships,
  at the cost of an NVIDIA image that waits for that PR after every Fedora kernel update.
- **One kernel.** The workflow pins the base by digest and takes the akmods images for its kernel,
  and `nvidia.sh` refuses a mismatch. When Universal Blue has not caught up with a new kernel, the
  NVIDIA build fails on its own, with a warning in the run, and the default image is not held back.
- **A Containerfile of its own.** `Containerfile.nvidia` starts from the default image, so the
  default image's build has no akmods stages to pull, whatever the builder does with unused stages.
- **Found, not guessed.** No installer of its own: on an NVIDIA GPU, the default image says how to
  switch, and the NVIDIA image, with Secure Boot on and the driver refused, how to enroll the key
  (`herald-os-gpu-check`). `herald-os-gpu-check switch` checks `/boot` first, since the NVIDIA
  image needs a 2 GiB one (with 1 GiB or less it refuses unless `--force`), and uses rpm-ostree
  wherever bootc would refuse, by the same check as `herald-os update` (#156). Once the image
  carries the project's signing key, the rebase goes ahead only where the policy requires that key
  for the NVIDIA image; `ostree-unverified-registry:` applies the policy too, and
  `ostree-image-signed:` is used only under a default stricter than Fedora's
  `insecureAcceptAnything`, which it refuses. `herald-os channel`
  keeps to the image, and both repositories are in the signature policy.
- **Turing and newer.** The open modules need a GSP, so GTX 900 and 1000 cards stay on nouveau;
  NVIDIA's 580 legacy driver (`akmods-nvidia-lts`) could be a third image if they turn out to matter.
- **Firmware in every image.** Fedora's `linux-firmware` only recommends the Wi-Fi, GPU and audio
  firmware split out of it, and the image installs without weak dependencies, so `packages.txt`
  names them. `fedora-bootc:44` ships most today; what it lacked was Sound Open Firmware, ALSA's UCM
  profiles (Intel laptops' speakers and microphones) and the older Intel Wi-Fi firmware, about
  13 MiB in all. The default image stays lean: the NVIDIA driver's 1.6 GB is only in its own image.

## ADR-030: SSH is rate-limited per address by an nftables table of Herald's own, beside firewalld

**Status: Accepted.** From #56.

`herald-os setup ssh` opens SSH in firewalld's zone and limits how fast anyone can try it. The
limit has to count each source address on its own: one bucket for everyone lets a single guesser,
or a scanner, use it up and lock the owner out.

- **Not firewalld's own limit.** A rich rule's `limit value="4/m"` is one bucket for every source.
  firewalld has no per-source meter, and its direct interface, which could pass `hashlimit` rules,
  is deprecated and needs the iptables tools, which an nftables-only image does not carry.
- **An nftables table of Herald's own.** `table inet herald_os_ssh` hooks input at priority
  `filter - 10`, before firewalld's table, and drops new connections to sshd's ports past 4 a minute
  (burst 4) from one IPv4 address or one IPv6 /64, using dynamic sets whose entries expire after 5
  minutes. It counts packets that open a connection (conntrack state new), so a client's resent SYNs
  count too: one whose first SYN was dropped, or that times out and retries, uses up more of its
  allowance, and an address over the limit keeps being dropped while it retries, until the rate
  allows again. Clients behind one NAT address share an allowance. A drop in any table is final, so
  a connection it lets through still needs the zone's `rule service name="ssh" accept`. firewalld
  manages only its own table and leaves this one alone on reload. The table is not tied to a zone:
  on interfaces whose zone does not allow SSH, firewalld refuses those connections anyway.
- **Loaded at boot by a unit `setup ssh` writes.** `/etc/herald-os/ssh-limit.nft` replaces the table
  each time it loads, and `/etc/systemd/system/herald-os-ssh-limit.service` loads it before
  `network-pre.target` and sshd. `sshd.service` and `sshd.socket` each get a drop-in with
  `Requires=` and `After=` on it, so a limit that fails leaves sshd stopped instead of running
  without it, and stopping the limit stops sshd too. `setup ssh --off` removes the drop-ins, stops
  the unit (which deletes the table) and removes its files. Nothing is in the image itself, so a
  machine that never turns SSH on has neither the table nor the unit.
- **firewalld required by default.** Without firewalld running, `setup ssh` refuses unless
  `--no-firewall`, which warns, and still loads the limit when `nft` is there.

## ADR-031: The disk is encrypted unless the person says otherwise, and its password follows its owner

**Status: Accepted.** From #37.

A computer that is lost or handed on is the first way files leak, and an unencrypted disk can be
read by anyone who takes it out. Omarchy encrypts by default; Herald OS now does too, without making
the installer less of the person's.

- **A kickstart line, not a second boot entry.** Anaconda has no configuration setting for the
  "Encrypt my data" box: its storage screen (the GTK one; the bootc `anaconda-iso` does not ship the
  web interface) ticks it when the kickstart's automatic partitioning is encrypted. So `iso.toml`'s
  kickstart has `autopart --type=btrfs --encrypted`, with no passphrase, which Anaconda then asks for
  in a window of its own once the disks are read, and no `clearpart`, `zerombr` or `ignoredisk`,
  so nothing is erased unless the person chooses it and every disk stays on the screen. Unticking
  the box installs without encryption. Two boot entries ("Install Herald OS" and "Install without
  encryption") would have needed the same line for the encrypted one, plus a second kickstart and
  GRUB menus rewritten inside the ISO after bootc-image-builder made it, which every builder update
  could break.
- **What the line changes.** With partitioning in the kickstart, Anaconda applies it as the disks
  are read: until the person opens the storage screen, the layout is automatic, into free space, on
  every disk it may use. An install into free space next to another system therefore encrypts only
  Herald OS's own partitions, and a full disk shows an error until the person picks what to do.
  Anaconda starts a kickstart install by itself once every screen is complete, but the Root Account
  screen stays incomplete here (no `rootpw`, no account), so the person still has to open it, which
  also stops that.
- **A disk password change never leaves the disk without one.** `herald-os password --disk` adds
  the new passphrase, checks that it opens every LUKS device under the root filesystem (a btrfs over
  two encrypted disks has two), and only then removes the old one, rather than `luksChangeKey`,
  which replaces a slot device by device without a check in between. Signals wait until it is done,
  on both sides: the person's side waits for the root side rather than stopping sudo with it.
  Only a key slot of its own counts as the disk password. A secret that opens a slot a token uses
  (the recovery key, TPM or FIDO2) is refused, whether it opens only that slot (it is not the disk
  password) or a plain slot as well (the same secret in both, which that way of unlocking must stop
  sharing first), as replacing it would keep the owner's password or take the token's slot with it. Every slot is tried on its own (`--key-slot`), and a password is removed by
  killing exactly the plain slots it opens, never by `luksRemoveKey` until it opens nothing, which
  would take a token's slot holding the same secret with it.
  If adding fails on one device, the new passphrase comes out of the others again. The devices come
  from `lsblk` only: when it cannot list them, nothing changes, because `/etc/crypttab` also names
  data and USB disks whose other key slots `--new-owner` would remove. It runs as root
  through sudo, asked for before anything else, and takes only printable ASCII: there is no input
  method at start-up, and the keyboard layout there may differ.
- **A new owner gets a disk password of their own.** After setup "for someone else" or `herald-os
  reset`, the new owner unlocks the disk at the next start with the password they were given, which
  they therefore know; setup then asks for it and a new one, and `--new-owner` removes every other
  key slot and any token left without one, so neither the old password nor a key someone else added
  opens the disk afterwards. No key is kept on the disk for this. On a disk that is not encrypted,
  setup and `herald-os reset` say plainly that a reset deletes files and is not a secure erase.
- **Not here: TPM unlocking.** The base image has `clevis-pin-tpm2`, so the disk could unlock by
  itself on the machine it was installed on. That trades the password at start-up for trust in the
  firmware, and stays a separate decision.
