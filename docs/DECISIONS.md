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
  scratch files skipped) catches files that commands create, such as a scaffolded project.
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
  person, who can encrypt the disk (Anaconda's "Encrypt my data", off by default) and install
  beside Windows; a kickstart passed with `inst.ks=` installs unattended. The
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
