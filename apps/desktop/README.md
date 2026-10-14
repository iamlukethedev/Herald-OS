# apps/desktop

The Herald OS shell, built on Electron. Its renderer draws everything you see in Herald OS: the menu
bar, dock, windows, launcher and Herald's own apps. Setup is in the
[root README](../../README.md); how the pieces talk to each other is in
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md); conventions for pages are in
[DESIGN.md](DESIGN.md).

## Layout

```
electron/              Electron main: owns the machine
  main.ts              entry: data migration, single-instance lock, windows, IPC, backend
  backend/             finds the Hermes install, spawns `hermes serve`, restarts it, forwards REST
  ipc/                 IPC handlers: files, apps, system stats, terminals, voice, web views, editing
  platform/            HostPlatform per OS: darwin.ts, linux.ts, generic.ts (placeholder elsewhere)
  shell/               shell modes, panels-mode windows, control socket, notification daemon
  wm/                  niri compositor IPC (Linux panels mode)
preload/index.ts       the `window.heraldOS` bridge, the renderer's only way to reach main
shared/                types shared by main, preload and renderer (IPC contract, voice settings),
                       and the translations (i18n.ts, locales/)
src/                   React renderer
  main.tsx             entry
  shell/               the desktop: ShellRoot, app registry, menu bar, dock, command bar, boot screen
    wm/                window frame for floating apps
    surfaces/          panels-mode surfaces (one Electron window each under niri)
  features/<app>/      one folder per page or app: hermes (chat), missions, memory, files, studio...
  commands/            the OS command catalogue (what the command bar, voice and Hermes can run)
  store/               nanostores state and actions (gateway, chat, windows, voice...)
  lib/                 pure helpers, unit-tested next to the code (`*.test.ts`)
  components/          shared UI primitives and the two brand marks
public/                served as-is: favicon, audio-capture worklet
build/                 app icons and macOS entitlements for electron-builder
scripts/               bundle-electron.mjs (esbuild for main and preload), after-pack.mjs (electron-builder hook), check-mac-signing-config.mjs (release check)
```

## Scripts

Run them here, or from the repository root (`npm run dev`, `npm run build`, `npm test`, ...).

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite on `127.0.0.1:5180` plus Electron; renderer edits reload live, main edits need a restart |
| `npm run build` | Renderer into `dist/renderer`, main and preload into `dist/electron` |
| `npm start` | Build, then run the built app |
| `npm run typecheck` | `tsc` for the renderer and for main and preload |
| `npm test` | Vitest over `src`, `electron`, `shared` and `scripts` |
| `npm run dist:mac` | Apple Silicon (`-mac-arm64`) and Intel (`-mac-x64`) DMGs and zips in `release/` (unsigned); `node scripts/check-mac-builds.mjs` checks every Mach-O in each app against its architecture |
| `npm run pack:mac` | The packaging half of `dist:mac`, on an existing `npm run build`; the release workflow signs here ([MACOS-SIGNING.md](../../docs/MACOS-SIGNING.md)) |
| `npm run dist:linux` | `herald-os-<version>-linux-<arch>.tar.gz` in `release/` for this machine's architecture (`-- --x64` or `-- --arm64` to pick), with the Linux CLIs, session, themes, catalog and bridge plugin in `resources/` |

## Common changes

- **A page or app.** Follow [DESIGN.md](DESIGN.md): register it in `src/shell/apps.ts`, put it in
  `src/features/<name>/`, mount pages in `src/shell/MainWindow.tsx`.
- **An action users or Hermes can trigger.** Register an `OsCommand` in `src/commands/<area>.ts`.
  The command bar, the voice fast path and the agent's `os_ui` tool all pick it up.
- **Text people read.** Add it to `shared/locales/en.ts` and show it with `t` from `useT()`
  (`src/store/i18n.ts`); [docs/TRANSLATING.md](../../docs/TRANSLATING.md) has the details.
- **A native capability.** Add it to `HostPlatform` (`electron/platform/types.ts`), implement it in
  each platform file, handle it in `electron/ipc/`, expose it in `preload/index.ts` and type it in
  `shared/ipc.ts`.
