# Herald OS Architecture

Herald OS is an agent-native operating system: it makes Hermes Agent the primary interface between
the user and the computer. Herald OS Linux is the whole system (Fedora underneath, the Herald shell
as the session); on macOS the same shell runs fullscreen over the macOS desktop. It is a separate
product from Hermes Desktop: it consumes the upstream Hermes runtime unchanged and grows its own
shell on top.

## Three authorities

The same seam rules upstream Hermes Desktop uses apply here:

| Party | Owns | Lives in |
| --- | --- | --- |
| Electron main | The machine: window/fullscreen lifecycle, backend process, PTYs, filesystem, app discovery, system stats, notifications, typed IPC | `apps/desktop/electron` |
| Renderer (React) | The experience: surfaces, navigation, presentation, ephemeral interaction state | `apps/desktop/src` |
| Hermes runtime | The work: sessions, model calls, tools, skills, memory, cron, approvals | the user's Hermes install (`$HERMES_HOME/hermes-agent`) |

The renderer never touches Node or Electron directly; native power arrives through a narrow,
typed preload bridge (`window.heraldOS`). Agent behaviour is never re-implemented in React.

```mermaid
flowchart LR
  subgraph shell [apps/desktop Electron shell]
    Main[Electron main]
    Preload[preload bridge]
    Renderer[React renderer]
    Main --> Preload --> Renderer
  end
  subgraph runtime [Hermes runtime in HERMES_HOME]
    Serve["hermes serve (JSON-RPC + REST)"]
    Agent[AIAgent, tools, skills, memory]
    Bridge[herald-os-bridge plugin]
    Serve --> Agent --> Bridge
  end
  Renderer -->|"WebSocket JSON-RPC (@herald-os/client)"| Serve
  Main -->|"REST with session token"| Serve
  Bridge -->|"request_tool_approval"| Serve
  Bridge -->|"mdfind, open, lsof, ps, osascript"| macOS[(macOS)]
  Bridge -->|"plocate, gio, ss, ps, nmcli, journalctl"| Linux[(Linux)]
```

## Host platforms

Both seams (`HostPlatform` in Electron main, `HostAdapter` in the bridge plugin) are implemented per
host. The renderer and the agent see identical tool names and return shapes on every platform.

| | macOS | Linux (Herald OS Linux) | Windows |
| --- | --- | --- | --- |
| Shell runs as | fullscreen over the macOS desktop | the whole session: `greetd` -> `niri` -> shell (`cage` as a fallback) | stub |
| `HostPlatform` | `platform/darwin.ts` (`plutil`, `sips`, `qlmanage`, `mdfind`, EventKit JXA) | `platform/linux.ts` (`/proc`, `.desktop` entries, icon themes, `nmcli`, `recently-used.xbel`, GNOME thumbnail cache) | `platform/generic.ts` |
| `HostAdapter` | `host/darwin.py` (`osascript`, `lsof`, `mdfind`, `system_profiler`, `pmset`) | `host/linux.py` (`ps`, `ss`, `plocate`/`fd`, `gio`, `xdg-open`, `nmcli`, `bluetoothctl`, `wpctl`, `gsettings`, `journalctl`, `loginctl`) | `host/windows.py` stub |
| App launch / reveal | `shell.openPath` / `showItemInFolder` | `gio launch <.desktop>` / `org.freedesktop.FileManager1` | |
| Calendar | EventKit with permission state | unavailable (EDS later) | |

Setup, session model and dev loop for Linux: `docs/LINUX.md`.

## Backend lifecycle

1. Resolve a runtime through an ordered ladder (`apps/desktop/electron/backend/resolve.ts`):
   `HERALD_OS_HERMES_ROOT` -> `$HERMES_HOME/hermes-agent` managed install (its `venv/bin/python`)
   -> `hermes` on `PATH`. Each candidate is probed before use.
2. Spawn `hermes serve --host 127.0.0.1 --port 0` with `HERMES_DASHBOARD_SESSION_TOKEN` (random per
   launch), `HERALD_OS=1`, and `HERMES_HOME`.
3. Read `HERMES_BACKEND_READY port=N` from stdout, then poll `GET /api/status` with
   `X-Hermes-Session-Token` until it answers.
4. Hand `{ wsUrl, baseUrl }` to the renderer. The renderer dials `ws://127.0.0.1:N/api/ws?token=...`
   with the upstream `JsonRpcGatewayClient`; REST calls go through main so the renderer only ever
   sees a capability, not a credential.
5. On exit the child is restarted with bounded backoff; after the budget is exhausted the shell
   shows a recoverable failure screen instead of spinning.

## Wire contract

The wire is declared in Python (`tui_gateway/contracts`) and generated into
`apps/shared/src/gateway-contract.generated.ts` upstream. Herald OS re-exports that file through
`packages/hermes-client`, so a field the backend stops sending fails `tsc` here instead of drifting.

Sessions are created with `source: "herald_os"`. Upstream only folds Desktop-only GUI tools into
sessions whose source is `desktop`, so a Herald OS session never receives tools whose client half
lives in Hermes Desktop.

Server-to-client requests the shell answers: `approval`, `clarify`, `sudo`, `secret`. Anything else
is declined with `-32601` so the backend treats it as unanswered rather than hanging.

## Renderer

Paths in this section and the next are relative to `apps/desktop`.

The renderer draws a whole desktop: wallpaper, menu bar, dock, command bar (`Cmd+K`), notifications
and a small window manager. Its apps are registered in `src/shell/apps.ts`:

- **Pages** of the main Hermes window, picked from its sidebar: Overview, Hermes (chat), Missions,
  Memory, Files, Automations, Connections, Settings.
- **Floating apps** with their own window: Terminal, System, Web, Studio, and a chat pop-out.

It runs in one of two modes, chosen by Electron main (`electron/shell/mode.ts`):

| Mode | Used by | Windows |
| --- | --- | --- |
| `desktop` | macOS, Linux under `cage` | One fullscreen Electron window; the renderer's own window manager (`src/store/windows.ts`, `src/shell/wm/`) lays out every app inside it. |
| `panels` | Linux under `niri` (`HERALD_OS_SHELL_MODE=panels`) | One Electron window per surface (menu bar, dock, main window, command bar, wallpaper, each floating app), tiled by the compositor. `src/shell/ShellRoot.tsx` picks what each window shows. |

Code layout (details in [`apps/desktop/README.md`](../apps/desktop/README.md), conventions in
[`apps/desktop/DESIGN.md`](../apps/desktop/DESIGN.md)): `src/shell` is the desktop chrome,
`src/features/<app>` holds one folder per app, `src/store` the nanostores state and actions,
`src/lib` pure helpers with their tests, `src/commands` the OS command catalogue.

## OS control

Everything a user can do in the shell is also a registered command (`src/store/os-commands.ts`,
catalogue in `src/commands/`), so three callers drive the UI the same way:

1. The command bar.
2. The voice fast path (`src/lib/voice/intents.ts`), which runs simple requests such as "open
   missions" or "hide the sidebar" locally, without a model round-trip.
3. Hermes itself, through the bridge's `os_ui` tool. Electron main serves a JSON-lines Unix socket
   (`~/.hermes/herald-os/control.sock` in desktop mode, `$XDG_RUNTIME_DIR/herald-os/control.sock`
   in panels mode) and hands the backend its path and a per-launch token
   (`HERALD_OS_CONTROL_SOCKET`, `HERALD_OS_CONTROL_TOKEN`). The socket is readable only by the
   user (mode 0600) and refuses requests without the token. In panels mode it also serves the
   `herald-os` CLI that the compositor's hotkeys call; those commands need no token.

Voice (engines, wake word, barge-in) is described in [`VOICE.md`](VOICE.md).

## Pick up where you left off

The Overview leads with up to three threads of work the user may want to resume.

- **Electron main** (`electron/context/snapshot.ts`, `electron/ipc/context.ts`) takes a context
  snapshot on request: documents opened or changed in the last three days (the platform's recents
  plus new files on the Desktop and in Downloads), folders under the usual project roots with
  activity this week (branch, uncommitted changes and last commit for git repositories, read with
  `--no-optional-locks` so looking never rewrites the index), and the GUI apps running. Folders and
  words the user excluded are dropped before anything leaves main. `powerMonitor` turns a wake, an
  unlock or the end of a 15-minute idle stretch into a `context:returned` event when the user was
  away for at least ten minutes.
- **The renderer** (`src/store/continuity.ts`) adds recent Hermes conversations and today's
  calendar, numbers every entry (`f1`, `p1`, `c1`) and sends it with fixed instructions through the
  gateway's `llm.oneshot`: one stateless model call with no session, no tools and no transcript.
  `src/lib/continuity.ts` parses the JSON answer and keeps only items whose ids were in the
  evidence, so a card cannot point at a file the model made up. Threads are stored in prefs and
  refreshed on boot (when older than ten minutes), when the user returns, and on demand.
- **Acting stays with the user.** Continue reopens a thread's conversation (in Studio when it built
  the thread's project), its folder and its documents. The suggested next step is a button that
  sends the prompt Hermes proposed. A return only updates the cards, or posts a notification when
  another page is showing. `continuity.catchUp`, `continuity.continue` and `continuity.nextStep`
  expose the same actions to voice, the command bar and Hermes.

The feature stays off until the user turns it on, because the names of files, projects,
conversations and events go to the model provider.

## Herald Canvas

The image editor (decision record: ADR-020; using it: [the manual](manual/canvas.md)) lives in
`src/features/canvas`, with the project format in `shared/canvas` and file access in
`electron/canvas`.

- **The document** (`engine/document.ts`) is an immutable state of layers in `.comp` order with
  shared rasters, so undo swaps states; pixel edits keep their own history. `shared/canvas/comp-format.ts`
  reads and writes the manifest, holding every value to the ranges Compositor accepts.
- **The compositor** (`engine/gpu/`) draws a document, or any area of it, on WebGL2: layers, blend
  modes, folders, masks, clipping, adjustment and effect passes. The view (`gpu/view.ts`) composites
  what is on screen at the screen's resolution and drafts at half resolution on software renderers
  while things move; `engine/tiles.ts` plans the tiles that exports, previews and the AI tools render
  in, and `gpu/gl.ts` holds rasters past the GPU's largest texture in pieces.
- **Main** reads and writes projects atomically and watches them (`electron/canvas/package-io.ts`),
  converts HEIC, TIFF and RAW through the system's tools (`convert.ts`), streams PNG exports a band
  of rows at a time (`png.ts`), reads Photoshop files in parts, and downloads and verifies the
  on-device models (`model-store.ts`).
- **Workers** run what would stall the window: the ONNX models (`ai/ml-worker.ts`), PatchMatch
  (`ai/inpaint-worker.ts`) and Photoshop files (`psd/psd-worker.ts`, mapped by `psd/psd-map.ts`).
- **Hermes** edits through the `canvas.*` commands (`src/commands/canvas.ts`, `agent.ts`), which change
  the open document as one step and save it, or change the project on disk; the bridge's `canvas`
  tool maps its actions to them. In panels mode the commands run in the Hermes window and the Canvas
  window, its own process, reloads the project when it changes.

## Herald Office

Herald Docs, Sheets and Slides (decision record: ADR-021, proposed) live in `src/features/office`,
with the formats in `shared/office` and file access in `electron/office`.

- **One window for three apps** (`shell/OfficeWindow.tsx`): menus, document tabs, the status bar and
  the dialogs. Each app's session (`session.ts`) opens, saves, watches and closes its documents,
  through an adapter that reads, writes and prints its formats (`docs/adapter.ts` and so on).
- **The save policy.** Before the first save over a file, the fidelity report lists what Herald
  showed differently and what the format will not keep; main copies the original into
  `office-backups` under the Herald OS data folder the first time Herald writes over it in a session
  (`electron/office/backups.ts`). Herald saves a document by itself only once the person has saved
  it, and stops when a save would lose something new.
- **Sheets** is Univer's open-source packages (`univer/`), one instance per open workbook, in
  Herald's palette (`palette.ts`, `theme.ts`, `univer.css`); formulas are worked out in a worker,
  `.xlsx` is read and written in another (`sheets/xlsx-worker.ts`), and `sheets/headless.ts` runs
  Univer without a window for the workbook API (`sheets/model.ts`).
- **Docs** is TipTap 3 (`docs/`): one schema (`docs/schema.ts`) for the editor, the converters, the
  print view and the document API (`docs/model.ts`), which works on a live editor or a file's JSON.
  Word files go through Herald's own reader and the docx package (`shared/office/docx`), and the
  page spell-checks with suggestions on right-click (`electron/office/spelling.ts`).
- **Slides** is a DOM slide editor: a deck in points with PowerPoint's model (`slides/deck.ts`),
  one view that draws a slide for the editor, the slide list, presenting and PDF export
  (`slides/view/`), TipTap for the text in boxes, shapes and table cells (`slides/editor/`), and the
  deck API (`slides/model.ts`, applied by `slides/live.ts`). PowerPoint files are written by
  PptxGenJS with a finishing pass and read by Herald's own DrawingML reader (`slides/pptx/`), and
  each file Herald saves carries its deck for exact reopening (`slides/pptx/herald-part.ts`).
- **Hermes** works through the `docs.*`, `sheets.*` and `office.list` commands (`src/commands/docs.ts`,
  `sheets.ts`, `office.ts`), which find their document in `features/office/agent.ts`: open in this
  window, the change is one transaction (Docs) or one Univer undo group (Sheets), so it is one step
  to undo and saves the way the person's edits do; a file that is not open is changed and written
  back only when Herald keeps everything in it. In panels mode each Office app is its own window, and
  main relays a command from the Hermes window to the window that has the document open
  (`officeRun`). Each window's report carries its documents' selections, which `office.list`, the
  `os_ui` state and spoken requests pass on to Hermes. An Ask Hermes request marks the text it is
  about (`docs/marked.ts`), so the answer lands there even after the person clicks elsewhere.
- **Main** reads and writes files whole and atomically, watches each open file's folder with a poll
  as a safety net (`file-watch.ts`), keeps what each window has open for Hermes, prints PDFs, and
  can convert OpenDocument files through headless LibreOffice when it is installed (`convert.ts`);
  no window converts through it yet, so `.odt`, `.ods` and `.odp` stay off in
  `shared/office/files.ts`.

## System bridge

`plugins/herald-os-bridge` is a regular out-of-tree Hermes plugin. It registers a narrow toolset
(`herald_os`) that exposes the host machine through explicit, permission-tiered tools. Execution
happens on the backend host behind a `HostAdapter` abstraction (`darwin` and `linux` implemented;
`windows` is a stub). Sensitive operations route through upstream's own approval gate
(`tools.approval.request_tool_approval`) so the shell renders one approval card for everything.
See [`SYSTEM-BRIDGE.md`](SYSTEM-BRIDGE.md).

## Upstream compatibility

- The Python runtime is never forked: it is whatever `hermes update` installs.
- Only `apps/shared/src` is compiled into Herald OS, from a pinned snapshot
  (`upstream/UPSTREAM.lock`, fetched by `scripts/sync-upstream.sh`).
- The plugin uses only public plugin APIs (`register`, `ctx.register_tool`, `ctx.register_skill`,
  `tools.approval.request_tool_approval`), and reads each turn's session source the way Hermes's own
  tools do (`gateway.session_context.get_session_env`) to keep its tools to Herald OS sessions.
- Anything Herald OS needs from core that does not exist yet (for example a generic plugin
  server-request hook for client-side execution) is proposed upstream rather than patched locally.
