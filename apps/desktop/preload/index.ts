import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  type AudioWsKind,
  type AuditEntry,
  type BackendState,
  type CalendarResult,
  type CanvasChangedEvent,
  type CanvasFetched,
  type CanvasFilePart,
  type CanvasPasted,
  type CanvasPresence,
  type CanvasProject,
  type CanvasRawImage,
  type CanvasSaveKind,
  type CanvasStreamKind,
  type CanvasWrite,
  type CatalogGroupView,
  type CatalogResult,
  type SetupResult,
  type SetupState,
  type ClipboardEntry,
  type ContextReturn,
  type ContextSnapshot,
  type ControlAction,
  type CrashReport,
  type HeraldOsResult,
  type IncomingNotification,
  type PowerAction,
  type DirEntry,
  type EditAction,
  type EnvInfo,
  type FilePreview,
  type HeraldOSPrefs,
  type ImageInfo,
  type InstalledApp,
  IPC,
  type MicPermission,
  type NetworkStatus,
  type OfficeChangedEvent,
  type OfficeFileData,
  type OfficePdfRequest,
  type OfficePresence,
  type OfficeRunReply,
  type OfficeRunRequest,
  type OfficeSaveTarget,
  type OfficeWriteResult,
  type OsControlReply,
  type OsControlRequest,
  type ProcessInfo,
  type RecentFile,
  type RecordingState,
  type CaptureTool,
  type CaptureToolResult,
  type RestRequest,
  type ScreenshotMode,
  type ShellCommand,
  type ShellMode,
  type ShellSurface,
  type StatusPanelId,
  type StatusPanelState,
  type SwitchName,
  type SwitchState,
  type SystemInfo,
  type SystemStats,
  type TerminalCreateOptions,
  type TerminalHandle,
  type TreeChangedEvent,
  type TreeEntry,
  type WebOpenOptions,
  type WebViewBounds,
  type WebViewEvent,
  type WindowState,
  type WmAction,
  type WmState
} from '../shared/ipc.ts'
import type { BrandingPatch, BrandingView } from '../shared/branding.ts'
import type { ModelId, ModelProgress, ModelStatus } from '../shared/canvas/models.ts'
import type { OfficeAbilities, OfficeApp } from '../shared/office/files.ts'
import type { MenuExtensions } from '../shared/menu-extensions.ts'
import type { PluginMethod, PluginView } from '../shared/plugins.ts'
import type { HeraldEvent } from '../shared/events.ts'
import type { ThemeSpec, ThemeSummary } from '../shared/theme.ts'

type Unsubscribe = () => void

// Main passes the surface identity as extra Chromium switches so it is known before any IPC.
const argValue = (name: string): string | undefined => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const SURFACE = (argValue('hermes-surface') ?? 'desktop') as ShellSurface
const SHELL_MODE = (argValue('hermes-shell-mode') === 'panels' ? 'panels' : 'desktop') as ShellMode

const subscribe = <T,>(channel: string, listener: (payload: T) => void): Unsubscribe => {
  const wrapped = (_event: unknown, payload: T) => listener(payload)
  ipcRenderer.on(channel, wrapped)

  return () => ipcRenderer.removeListener(channel, wrapped)
}

/** The whole capability surface the renderer gets. Keep it narrow and typed. */
const api = {
  backend: {
    getState: (): Promise<BackendState> => ipcRenderer.invoke(IPC.backendGetState),
    onState: (listener: (state: BackendState) => void): Unsubscribe => subscribe(IPC.backendState, listener),
    restart: (): Promise<void> => ipcRenderer.invoke(IPC.backendRestart),
    rest: <T,>(request: RestRequest): Promise<T> => ipcRenderer.invoke(IPC.backendRest, request),
    logTail: (lines = 200): Promise<string[]> => ipcRenderer.invoke(IPC.backendLogTail, lines)
  },
  system: {
    info: (): Promise<SystemInfo> => ipcRenderer.invoke(IPC.systemInfo),
    stats: (): Promise<SystemStats> => ipcRenderer.invoke(IPC.systemStats),
    processes: (sort: 'cpu' | 'memory', limit: number): Promise<ProcessInfo[]> => ipcRenderer.invoke(IPC.systemProcesses, sort, limit),
    network: (): Promise<NetworkStatus> => ipcRenderer.invoke(IPC.systemNetwork),
    subscribeStats: (listener: (stats: SystemStats) => void): Unsubscribe => {
      const off = subscribe(IPC.systemStatsPush, listener)
      void ipcRenderer.invoke(IPC.systemStatsSubscribe, true)

      return () => {
        off()
        void ipcRenderer.invoke(IPC.systemStatsSubscribe, false)
      }
    }
  },
  apps: {
    list: (): Promise<InstalledApp[]> => ipcRenderer.invoke(IPC.appsList),
    launch: (appPath: string): Promise<void> => ipcRenderer.invoke(IPC.appsLaunch, appPath),
    icon: (appPath: string): Promise<string> => ipcRenderer.invoke(IPC.appsIcon, appPath)
  },
  fs: {
    home: (): Promise<string> => ipcRenderer.invoke(IPC.fsHome),
    readDir: (target: string): Promise<DirEntry[]> => ipcRenderer.invoke(IPC.fsReadDir, target),
    readFile: (target: string): Promise<FilePreview> => ipcRenderer.invoke(IPC.fsReadFile, target),
    reveal: (target: string): Promise<void> => ipcRenderer.invoke(IPC.fsReveal, target),
    openPath: (target: string): Promise<void> => ipcRenderer.invoke(IPC.fsOpenPath, target),
    openIn: (app: 'editor' | 'finder' | 'terminal', target: string): Promise<void> => ipcRenderer.invoke(IPC.fsOpenIn, app, target),
    recent: (limit = 30): Promise<RecentFile[]> => ipcRenderer.invoke(IPC.fsRecent, limit),
    /** Files under the home folder whose name matches, best match first. */
    find: (query: string, limit = 10): Promise<RecentFile[]> => ipcRenderer.invoke(IPC.fsFind, query, limit),
    thumbnail: (target: string, size = 512): Promise<string | null> => ipcRenderer.invoke(IPC.fsThumbnail, target, size),
    imageInfo: (target: string): Promise<ImageInfo | null> => ipcRenderer.invoke(IPC.fsImageInfo, target),
    writeText: (target: string, content: string): Promise<void> => ipcRenderer.invoke(IPC.fsWriteText, target, content),
    mkdir: (target: string): Promise<void> => ipcRenderer.invoke(IPC.fsMkdir, target),
    rename: (from: string, to: string): Promise<void> => ipcRenderer.invoke(IPC.fsRename, from, to),
    trash: (targets: string[]): Promise<void> => ipcRenderer.invoke(IPC.fsTrash, targets),
    exportPdf: (html: string, suggestedName: string): Promise<string | null> => ipcRenderer.invoke(IPC.fsExportPdf, html, suggestedName),
    pickFiles: (options?: { directory?: boolean; multiple?: boolean }): Promise<string[]> => ipcRenderer.invoke(IPC.fsPickFiles, options ?? {}),
    dirSize: (target: string): Promise<{ bytes: number; files: number; complete: boolean }> => ipcRenderer.invoke(IPC.fsDirSize, target),
    listTree: (root: string, limit = 3000): Promise<{ entries: TreeEntry[]; truncated: boolean }> => ipcRenderer.invoke(IPC.fsListTree, root, limit),
    watchTree: (root: string): Promise<string> => ipcRenderer.invoke(IPC.fsWatchTree, root),
    unwatchTree: (watchId: string): Promise<void> => ipcRenderer.invoke(IPC.fsUnwatchTree, watchId),
    onTreeChanged: (listener: (event: TreeChangedEvent) => void): Unsubscribe => subscribe(IPC.fsTreeChanged, listener),
    /** Absolute path of a File dropped from Finder (Electron removed File.path). */
    pathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    }
  },
  calendar: {
    today: (): Promise<CalendarResult> => ipcRenderer.invoke(IPC.calendarToday)
  },
  context: {
    /** Recent documents, active project folders and running apps, minus the user's exclusions. */
    snapshot: (): Promise<ContextSnapshot> => ipcRenderer.invoke(IPC.contextSnapshot),
    /** The user is back after sleep, a lock or a long idle stretch (fires in every window). */
    onReturned: (listener: (event: ContextReturn) => void): Unsubscribe => subscribe(IPC.contextReturned, listener)
  },
  crash: {
    /** Programs that crashed since Herald OS started, newest first. */
    recent: (): Promise<CrashReport[]> => ipcRenderer.invoke(IPC.crashRecent)
  },
  theme: {
    list: (): Promise<ThemeSummary[]> => ipcRenderer.invoke(IPC.themeList),
    /** Apply an installed theme everywhere; resolves with the new preferences. */
    apply: (name: string): Promise<HeraldOSPrefs> => ipcRenderer.invoke(IPC.themeApply, name),
    /** Save a theme into ~/.config/herald-os/themes (with its wallpaper image copied in). */
    save: (spec: ThemeSpec, imagePath?: string): Promise<string> => ipcRenderer.invoke(IPC.themeSave, spec, imagePath),
    /** A small PNG data URL of an image, to take theme colours from (null when it is not an image). */
    sample: (imagePath: string): Promise<string | null> => ipcRenderer.invoke(IPC.themeSample, imagePath),
    /** Install the themes in a git repository; resolves with their names. */
    install: (url: string): Promise<string[]> => ipcRenderer.invoke(IPC.themeInstall, url)
  },
  fonts: {
    list: (): Promise<string[]> => ipcRenderer.invoke(IPC.fontsList)
  },
  capture: {
    /** The person draws a rectangle on screen; resolves with the PNG's path, or null when cancelled. */
    region: (): Promise<string | null> => ipcRenderer.invoke(IPC.captureRegion),
    /** A screenshot saved where screenshots go (null when the selection was cancelled). */
    screenshot: (mode: ScreenshotMode): Promise<string | null> => ipcRenderer.invoke(IPC.captureScreenshot, mode),
    record: (action: 'start' | 'stop' | 'toggle', options: { region?: boolean; audio?: boolean } = {}): Promise<RecordingState> => ipcRenderer.invoke(IPC.captureRecord, action, options),
    recordState: (): Promise<RecordingState> => ipcRenderer.invoke(IPC.captureRecordState),
    /** macOS: the colour picker, a QR code or the text in part of the screen, copied to the clipboard. */
    tool: (tool: CaptureTool): Promise<CaptureToolResult> => ipcRenderer.invoke(IPC.captureTool, tool),
    onRecordChanged: (listener: (state: RecordingState) => void): Unsubscribe => subscribe(IPC.captureRecordChanged, listener),
    readImage: (file: string): Promise<string> => ipcRenderer.invoke(IPC.captureReadImage, file),
    saveImage: (file: string, dataUrl: string): Promise<string> => ipcRenderer.invoke(IPC.captureSaveImage, file, dataUrl),
    copyImage: (source: string): Promise<void> => ipcRenderer.invoke(IPC.captureCopyImage, source),
    requestCamera: (): Promise<boolean> => ipcRenderer.invoke(IPC.cameraRequest)
  },
  canvas: {
    /** A `.comp` project or an image to open (null when cancelled). */
    pickOpen: (): Promise<string | null> => ipcRenderer.invoke(IPC.canvasPickOpen),
    pickSave: (kind: CanvasSaveKind, suggestedName: string): Promise<string | null> => ipcRenderer.invoke(IPC.canvasPickSave, kind, suggestedName),
    read: (project: string): Promise<CanvasProject> => ipcRenderer.invoke(IPC.canvasRead, project),
    /** A layer image or mask: exact pixels, or PNG bytes when only the window can decode it. */
    readAsset: (project: string, name: string): Promise<CanvasRawImage | Uint8Array> => ipcRenderer.invoke(IPC.canvasReadAsset, project, name),
    /** Save a project (creating it if needed); resolves with its new digest. */
    write: (project: string, request: CanvasWrite): Promise<string> => ipcRenderer.invoke(IPC.canvasWrite, project, request),
    /** An image's pixels, or its bytes for the window to decode (HEIC, TIFF and RAW arrive converted). */
    readImage: (file: string): Promise<CanvasRawImage | Uint8Array> => ipcRenderer.invoke(IPC.canvasReadImage, file),
    /** Part of a layered file (PSD, PSB) from `offset`, with the whole file's size. */
    readPart: (file: string, offset: number, length: number): Promise<CanvasFilePart> => ipcRenderer.invoke(IPC.canvasReadPart, file, offset, length),
    /** A colour table file (`.cube`) for a Color Lookup layer, as its bytes. */
    readTable: (file: string): Promise<Uint8Array> => ipcRenderer.invoke(IPC.canvasReadTable, file),
    /** Write an export: encoded bytes, or raw pixels to save as PNG. */
    writeFile: (file: string, data: Uint8Array | CanvasRawImage, ppi?: number): Promise<string> => ipcRenderer.invoke(IPC.canvasWriteFile, file, data, ppi),
    /** Start a file written in parts (resolves with its stream id); it appears only once ended. */
    streamBegin: (file: string, kind: CanvasStreamKind): Promise<string> => ipcRenderer.invoke(IPC.canvasStreamBegin, file, kind),
    /** The next part: whole PNG rows, top to bottom, or bytes. */
    streamWrite: (stream: string, bytes: Uint8Array): Promise<void> => ipcRenderer.invoke(IPC.canvasStreamWrite, stream, bytes),
    /** Finish the file; resolves with its path. */
    streamEnd: (stream: string): Promise<string> => ipcRenderer.invoke(IPC.canvasStreamEnd, stream),
    streamAbort: (stream: string): Promise<void> => ipcRenderer.invoke(IPC.canvasStreamAbort, stream),
    /** Follow a project; `loaded` is the digest of the version this window has, so nothing slips by. */
    watch: (project: string, loaded?: string | null): Promise<string> => ipcRenderer.invoke(IPC.canvasWatch, project, loaded ?? undefined),
    unwatch: (watchId: string): Promise<void> => ipcRenderer.invoke(IPC.canvasUnwatch, watchId),
    onChanged: (listener: (event: CanvasChangedEvent) => void): Unsubscribe => subscribe(IPC.canvasChanged, listener),
    /** Is something at this path: a file, a folder (projects on Linux), or nothing? */
    exists: (target: string): Promise<'file' | 'directory' | null> => ipcRenderer.invoke(IPC.canvasExists, target),
    /** An image from an http(s) address, downloaded by main. */
    fetchImage: (url: string): Promise<CanvasFetched> => ipcRenderer.invoke(IPC.canvasFetch, url),
    /** Tell main what this window has open, for Hermes's commands. */
    report: (presence: Omit<CanvasPresence, 'at'> & { focused?: boolean }): void => ipcRenderer.send(IPC.canvasReport, presence),
    /** Every Canvas window's open documents, the most recently used window first. */
    presence: (): Promise<CanvasPresence[]> => ipcRenderer.invoke(IPC.canvasPresence),
    /** Put copied pixels on the system clipboard as a PNG, for other apps. */
    copyImage: (image: CanvasRawImage): Promise<void> => ipcRenderer.invoke(IPC.canvasCopyImage, image),
    /** The image on the system clipboard (null when there is none), and whether Herald Canvas put it there. */
    pasteImage: (): Promise<CanvasPasted | null> => ipcRenderer.invoke(IPC.canvasPasteImage),
    /** On-device models: downloaded only when the person allows it, checked before they run. */
    models: {
      list: (): Promise<ModelStatus[]> => ipcRenderer.invoke(IPC.canvasModels),
      /** Resolves once the model is downloaded and verified. */
      download: (id: ModelId): Promise<void> => ipcRenderer.invoke(IPC.canvasModelDownload, id),
      cancel: (id: ModelId): Promise<void> => ipcRenderer.invoke(IPC.canvasModelCancel, id),
      remove: (id: ModelId): Promise<void> => ipcRenderer.invoke(IPC.canvasModelRemove, id),
      onProgress: (listener: (progress: ModelProgress) => void): Unsubscribe => subscribe(IPC.canvasModelProgress, listener)
    }
  },
  office: {
    /** What this machine adds to the formats: LibreOffice for OpenDocument files. */
    abilities: (): Promise<OfficeAbilities> => ipcRenderer.invoke(IPC.officeAbilities),
    /** Files to open in an Office app (none when cancelled). */
    pickOpen: (app: OfficeApp): Promise<string[]> => ipcRenderer.invoke(IPC.officePickOpen, app),
    /** Where to save and in which of the app's formats, `preferred` offered first (null when cancelled). */
    pickSave: (app: OfficeApp, suggestedName: string, preferred?: string): Promise<OfficeSaveTarget | null> => ipcRenderer.invoke(IPC.officePickSave, app, suggestedName, preferred),
    read: (file: string): Promise<OfficeFileData> => ipcRenderer.invoke(IPC.officeRead, file),
    /** Replace a file atomically; the first write over an existing file this session backs it up first. */
    write: (file: string, bytes: Uint8Array, options: { backup?: boolean } = {}): Promise<OfficeWriteResult> => ipcRenderer.invoke(IPC.officeWrite, file, bytes, options),
    /** Follow a file; `loaded` is the digest of the version this window has, so nothing slips by. */
    watch: (file: string, loaded?: string | null): Promise<string> => ipcRenderer.invoke(IPC.officeWatch, file, loaded ?? null),
    unwatch: (watchId: string): Promise<void> => ipcRenderer.invoke(IPC.officeUnwatch, watchId),
    onChanged: (listener: (event: OfficeChangedEvent) => void): Unsubscribe => subscribe(IPC.officeChanged, listener),
    /** Tell main what this app's window has open, for Hermes's commands. */
    report: (presence: Omit<OfficePresence, 'at'> & { focused?: boolean }): void => ipcRenderer.send(IPC.officeReport, presence),
    /** Every Office window's open documents, the most recently used first. */
    presence: (): Promise<OfficePresence[]> => ipcRenderer.invoke(IPC.officePresence),
    /** Panels mode: run a command in the window that has `key` open in `app`; resolves with its result. */
    run: (target: { app: OfficeApp; key: string }, command: string, args: Record<string, unknown>, source: OfficeRunRequest['source']): Promise<unknown> => ipcRenderer.invoke(IPC.officeRun, target, command, args, source),
    /** An Office window takes commands for its documents from main, and answers each one. */
    onRunRequest: (listener: (request: OfficeRunRequest) => void): Unsubscribe => subscribe(IPC.officeRunRequest, listener),
    runReply: (reply: OfficeRunReply): void => ipcRenderer.send(IPC.officeRunReply, reply),
    /** Print a print view to a PDF the person names; resolves with its path (null when cancelled). */
    exportPdf: (request: OfficePdfRequest): Promise<string | null> => ipcRenderer.invoke(IPC.officeExportPdf, request),
    /** A file converted by LibreOffice to `to` (an extension without its dot), as bytes. */
    convert: (file: string, to: string): Promise<Uint8Array> => ipcRenderer.invoke(IPC.officeConvert, file, to)
  },
  catalog: {
    /** The install catalog with each entry's state on this machine (Linux: everything; macOS: what installs here). */
    list: (): Promise<CatalogGroupView[]> => ipcRenderer.invoke(IPC.catalogList),
    install: (id: string): Promise<CatalogResult> => ipcRenderer.invoke(IPC.catalogInstall, id),
    remove: (id: string): Promise<CatalogResult> => ipcRenderer.invoke(IPC.catalogRemove, id),
    /** The models a local server has (for "Use with Hermes"); rejects with what to do when it is not running. */
    localModels: (kind: 'ollama' | 'lmstudio'): Promise<string[]> => ipcRenderer.invoke(IPC.catalogLocalModels, kind)
  },
  plugins: {
    /** Installed widget plugins: manifest, enabled, problems, and a revision that bumps on saves. */
    list: (): Promise<PluginView[]> => ipcRenderer.invoke(IPC.pluginsList),
    setEnabled: (id: string, enabled: boolean): Promise<PluginView[]> => ipcRenderer.invoke(IPC.pluginsSetEnabled, id, enabled),
    add: (url: string): Promise<PluginView> => ipcRenderer.invoke(IPC.pluginsAdd, url),
    update: (id: string): Promise<PluginView> => ipcRenderer.invoke(IPC.pluginsUpdate, id),
    remove: (id: string): Promise<PluginView[]> => ipcRenderer.invoke(IPC.pluginsRemove, id),
    /** One message from a widget frame, answered (and permission-checked) by main. */
    call: (id: string, method: PluginMethod, params: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke(IPC.pluginCall, id, method, params),
    onChanged: (listener: (plugins: PluginView[]) => void): Unsubscribe => subscribe(IPC.pluginsChanged, listener)
  },
  branding: {
    /** About's logo and name, and the Linux lock-screen picture. */
    get: (): Promise<BrandingView> => ipcRenderer.invoke(IPC.brandingGet),
    /** Image paths are copied into ~/.config/herald-os/branding; null removes one. */
    set: (patch: BrandingPatch): Promise<BrandingView> => ipcRenderer.invoke(IPC.brandingSet, patch),
    onChanged: (listener: (branding: BrandingView) => void): Unsubscribe => subscribe(IPC.brandingChanged, listener)
  },
  setup: {
    /** First-boot setup on the Herald OS image: due or not, the account, the name so far. */
    state: (): Promise<SetupState> => ipcRenderer.invoke(IPC.setupState),
    name: (name: string): Promise<SetupResult> => ipcRenderer.invoke(IPC.setupName, name),
    password: (password: string): Promise<SetupResult> => ipcRenderer.invoke(IPC.setupPassword, password),
    /** `later`: setting it up for someone else, who finishes setup at the next start. */
    finish: (options: { later?: boolean } = {}): Promise<SetupResult> => ipcRenderer.invoke(IPC.setupFinish, options)
  },
  dictation: {
    /** Type text into the focused app (any app); `copied` when it could only be left on the clipboard. */
    type: (text: string, options: { submit?: boolean; delayMs?: number } = {}): Promise<{ typed: boolean; copied: boolean }> => ipcRenderer.invoke(IPC.dictationType, text, options)
  },
  events: {
    /** Events Herald OS saw lately (login, wake, crash, low battery, …), newest first. */
    recent: (): Promise<HeraldEvent[]> => ipcRenderer.invoke(IPC.eventsRecent)
  },
  switches: {
    get: (): Promise<SwitchState> => ipcRenderer.invoke(IPC.switchesGet),
    /** Night light, do not disturb, staying awake, the screensaver; resolves with every switch. */
    set: (name: SwitchName, enabled: boolean): Promise<SwitchState> => ipcRenderer.invoke(IPC.switchesSet, name, enabled),
    onChanged: (listener: (state: SwitchState) => void): Unsubscribe => subscribe(IPC.switchesChanged, listener)
  },
  notificationHistory: {
    /** The last week of notifications, kept across restarts. */
    load: (): Promise<unknown[]> => ipcRenderer.invoke(IPC.notificationsLoad),
    save: (items: unknown[]): Promise<void> => ipcRenderer.invoke(IPC.notificationsSave, items)
  },
  controls: {
    /** A quick panel's state: Wi-Fi networks, Bluetooth devices, audio devices, displays, power. */
    status: (panel: StatusPanelId): Promise<StatusPanelState> => ipcRenderer.invoke(IPC.controlsStatus, panel),
    /** Change something from a quick panel; resolves with that panel's new state. */
    act: (action: ControlAction): Promise<StatusPanelState> => ipcRenderer.invoke(IPC.controlsAction, action)
  },
  terminal: {
    create: (options: TerminalCreateOptions): Promise<TerminalHandle> => ipcRenderer.invoke(IPC.terminalCreate, options),
    write: (id: string, data: string): void => ipcRenderer.send(IPC.terminalWrite, id, data),
    resize: (id: string, cols: number, rows: number): void => ipcRenderer.send(IPC.terminalResize, id, cols, rows),
    dispose: (id: string): Promise<void> => ipcRenderer.invoke(IPC.terminalDispose, id),
    onData: (listener: (id: string, data: string) => void): Unsubscribe => {
      const wrapped = (_event: unknown, id: string, data: string) => listener(id, data)
      ipcRenderer.on(IPC.terminalData, wrapped)

      return () => ipcRenderer.removeListener(IPC.terminalData, wrapped)
    },
    onExit: (listener: (id: string, code: number) => void): Unsubscribe => {
      const wrapped = (_event: unknown, id: string, code: number) => listener(id, code)
      ipcRenderer.on(IPC.terminalExit, wrapped)

      return () => ipcRenderer.removeListener(IPC.terminalExit, wrapped)
    }
  },
  notifications: {
    native: (title: string, body: string): Promise<void> => ipcRenderer.invoke(IPC.notifyNative, title, body)
  },
  window: {
    getState: (): Promise<WindowState> => ipcRenderer.invoke(IPC.windowGetState),
    onState: (listener: (state: WindowState) => void): Unsubscribe => subscribe(IPC.windowState, listener),
    toggleFullscreen: (): Promise<void> => ipcRenderer.invoke(IPC.windowToggleFullscreen),
    quit: (): Promise<void> => ipcRenderer.invoke(IPC.windowQuit)
  },
  shell: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.shellOpenExternal, url),
    /** Which surface this window is, and how the shell is composed. Known synchronously at load. */
    surface: SURFACE,
    mode: SHELL_MODE,
    /** Panels mode: open a surface window (optionally delivering a command to it). */
    open: (surface: ShellSurface, command?: ShellCommand): Promise<void> => ipcRenderer.invoke(IPC.shellOpen, surface, command),
    /** Close a surface window (this one when omitted). */
    close: (surface?: ShellSurface): Promise<void> => ipcRenderer.invoke(IPC.shellClose, surface),
    /** Deliver a command to another surface (e.g. the command overlay asking main to send a prompt). */
    relay: (target: ShellSurface, command: ShellCommand): Promise<void> => ipcRenderer.invoke(IPC.shellRelay, target, command),
    /** Commands arriving for this surface: from the `herald-os` CLI (hotkeys) or another surface. */
    onCommand: (listener: (command: ShellCommand) => void): Unsubscribe => subscribe(IPC.shellCommand, listener),
    /** Ask main to resize this surface window (overlays size to their content). */
    resize: (width: number, height: number): Promise<void> => ipcRenderer.invoke(IPC.shellResize, width, height),
    /** Wallpaper surface only: hand a rendered PNG frame to main for swaybg. */
    wallpaperFrame: (dataUrl: string): Promise<void> => ipcRenderer.invoke(IPC.shellWallpaperFrame, dataUrl),
    /** Run a `herald-os` CLI command from the shell (Linux; rejects elsewhere). */
    heraldOs: (args: string[]): Promise<HeraldOsResult> => ipcRenderer.invoke(IPC.shellHeraldOs, args),
    /** The person's control-menu entries from ~/.config/herald-os/menu.json. */
    menuExtensions: (): Promise<MenuExtensions> => ipcRenderer.invoke(IPC.menuExtensions),
    /** Start a menu.json entry's program (main reads it from the file; only the id crosses). */
    runMenuExtension: (id: string): Promise<void> => ipcRenderer.invoke(IPC.menuExtensionRun, id),
    /** Suspend, reboot, power off, log out, or lock. */
    power: (action: PowerAction): Promise<void> => ipcRenderer.invoke(IPC.shellPower, action)
  },
  edit: {
    /** Type, press a key, or run a clipboard/undo action on the focused element (or in a web view). */
    perform: (action: EditAction, webViewId?: string): Promise<void> => ipcRenderer.invoke(IPC.editAction, action, webViewId)
  },
  web: {
    /** Open an http(s) page in an embedded view owned by this window; resolves with the view id. */
    open: (url: string, options: WebOpenOptions = {}): Promise<string> => ipcRenderer.invoke(IPC.webOpen, url, options),
    /** Show a local file in a viewer view owned by this window; resolves with the view id. */
    openFile: (filePath: string, options: WebOpenOptions = {}): Promise<string> => ipcRenderer.invoke(IPC.webOpenFile, filePath, options),
    /** Place the view over the frame's content rect (CSS px); hidden views keep their bounds. */
    setBounds: (id: string, bounds: WebViewBounds, visible: boolean): void => ipcRenderer.send(IPC.webSetBounds, id, bounds, visible),
    close: (id: string): Promise<void> => ipcRenderer.invoke(IPC.webClose, id),
    openPreview: (target: string, options: WebOpenOptions = {}): Promise<string> => ipcRenderer.invoke(IPC.webOpenPreview, target, options),
    navigate: (id: string, target: string): Promise<void> => ipcRenderer.invoke(IPC.webNavigate, id, target),
    reload: (id: string): Promise<void> => ipcRenderer.invoke(IPC.webReload, id),
    onEvent: (listener: (event: WebViewEvent) => void): Unsubscribe => subscribe(IPC.webEvent, listener)
  },
  clipboard: {
    history: (limit = 50): Promise<ClipboardEntry[]> => ipcRenderer.invoke(IPC.clipboardHistory, limit),
    paste: (id: string): Promise<void> => ipcRenderer.invoke(IPC.clipboardPaste, id)
  },
  desktopNotifications: {
    onIncoming: (listener: (notification: IncomingNotification) => void): Unsubscribe => subscribe(IPC.notificationsIncoming, listener),
    /** Report that the user invoked an action (or 'default' for a click) on a notification. */
    action: (id: number, actionKey: string): Promise<void> => ipcRenderer.invoke(IPC.notificationsAction, id, actionKey)
  },
  wm: {
    getState: (): Promise<WmState> => ipcRenderer.invoke(IPC.wmGetState),
    onState: (listener: (state: WmState) => void): Unsubscribe => subscribe(IPC.wmState, listener),
    action: (action: WmAction): Promise<void> => ipcRenderer.invoke(IPC.wmAction, action)
  },
  prefs: {
    get: (): Promise<HeraldOSPrefs> => ipcRenderer.invoke(IPC.prefsGet),
    set: (patch: Partial<HeraldOSPrefs>): Promise<HeraldOSPrefs> => ipcRenderer.invoke(IPC.prefsSet, patch),
    /** Preferences changed from another surface window. */
    onChanged: (listener: (prefs: HeraldOSPrefs) => void): Unsubscribe => subscribe(IPC.prefsChanged, listener)
  },
  osControl: {
    /** Main asks this window to run a registry command / list commands / report state. */
    onRequest: (listener: (request: OsControlRequest) => void): Unsubscribe => subscribe(IPC.osControlRequest, listener),
    reply: (reply: OsControlReply): void => ipcRenderer.send(IPC.osControlReply, reply)
  },
  voice: {
    /** Current OS-level microphone authorization (always 'granted' outside macOS). */
    microphoneStatus: (): Promise<MicPermission> => ipcRenderer.invoke(IPC.voiceMicrophoneStatus),
    /** Prompt the OS for microphone access when it has not been decided yet. */
    requestMicrophone: (): Promise<MicPermission> => ipcRenderer.invoke(IPC.voiceRequestMicrophone),
    /** Tokenized URL for an authenticated audio WebSocket (speak-stream). */
    audioWsUrl: (kind: AudioWsKind): Promise<string> => ipcRenderer.invoke(IPC.voiceAudioWsUrl, kind),
    /** The global voice hotkey was pressed (fires in every window; the main surface acts). */
    onHotkey: (listener: () => void): Unsubscribe => subscribe<void>(IPC.voiceHotkey, () => listener())
  },
  bridge: {
    readPolicy: (): Promise<string> => ipcRenderer.invoke(IPC.bridgePolicyRead),
    writePolicy: (text: string): Promise<void> => ipcRenderer.invoke(IPC.bridgePolicyWrite, text),
    readAudit: (limit = 200): Promise<AuditEntry[]> => ipcRenderer.invoke(IPC.bridgeAuditRead, limit)
  },
  env: (): Promise<EnvInfo> => ipcRenderer.invoke(IPC.envInfo)
}

export type HeraldOSApi = typeof api

contextBridge.exposeInMainWorld('heraldOS', api)
