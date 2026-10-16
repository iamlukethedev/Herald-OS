import { app, BrowserWindow, globalShortcut, ipcMain, Notification, protocol, shell } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { type EnvInfo, type HeraldOSPrefs, IPC, type PrefsPatch, type RestRequest, type ShellCommand, type WindowState } from '../shared/ipc.ts'
import { BackendManager } from './backend/manager.ts'
import { forgetInheritedSession } from './backend/session-env.ts'
import { CrashWatcher } from './crash/watch.ts'
import { mayOpenExternally } from './external-url.ts'
import { fireEventAutomations } from './events/automations.ts'
import { events } from './events/bus.ts'
import { runHooks } from './events/hooks.ts'
import { run } from './platform/exec.ts'
import { startEventSources } from './events/sources.ts'
import { registerAppsIpc } from './ipc/apps.ts'
import { registerBridgeIpc } from './ipc/bridge.ts'
import { registerCalcIpc } from './calc/ipc.ts'
import { registerCanvasIpc } from './canvas/ipc.ts'
import { registerModelIpc } from './canvas/model-ipc.ts'
import { registerOfficeIpc } from './office/ipc.ts'
import { MODEL_SCHEME } from '../shared/canvas/models.ts'
import { normalizeRoomPrefs } from '../shared/room.ts'
import { registerCaptureIpc } from './ipc/capture.ts'
import { registerControlsIpc } from './ipc/controls.ts'
import { registerCatalogIpc } from './ipc/catalog.ts'
import { registerSetupIpc } from './ipc/setup.ts'
import { PluginHost } from './plugins/host.ts'
import { registerDictationIpc } from './ipc/dictation.ts'
import { registerContextIpc } from './ipc/context.ts'
import { registerFsIpc } from './ipc/fs.ts'
import { registerSystemIpc } from './ipc/system.ts'
import { registerTerminalIpc } from './ipc/terminal.ts'
import { registerThemeIpc, syncHermesSkin } from './ipc/theme.ts'
import { applyVoiceHotkey, registerVoiceIpc } from './ipc/voice.ts'
import { registerEditIpc } from './ipc/edit.ts'
import { registerWebIpc } from './ipc/web.ts'
import { systemLanguages } from './i18n.ts'
import { log, logTail } from './log.ts'
import { migrateLegacyData } from './migrate.ts'
import { registerNotificationHistoryIpc } from './notifications-history.ts'
import { registerPetIpc } from './pet/ipc.ts'
import { PetWindow } from './pet/window.ts'
import { ActivityHub } from './room/activity.ts'
import { registerRoomIpc } from './room/ipc.ts'
import { RoomLog } from './room/log.ts'
import { SwitchService } from './switches.ts'
import { hermesHome, heraldOsDataDir, isDev } from './paths.ts'
import { readPrefs, writePrefs } from './prefs.ts'
import { handleAdoptLegacyNotify, sendPrefsToOthers } from './prefs-ipc.ts'
import { forwardRendererConsole } from './renderer-console.ts'
import { isOmarchy, readOmarchyTheme } from './theme/omarchy.ts'
import { prefsForTheme } from './theme/themes.ts'
import { ControlSocket } from './shell/control-socket.ts'
import { DesktopHost, type ShellHost } from './shell/host.ts'
import { shellMode } from './shell/mode.ts'
import { createCompositor, detectCompositor } from './wm/compositor.ts'
import { NotificationDaemon } from './shell/notification-daemon.ts'
import { desktopControlHandler, OsCommandBridge, OsControlServer, osControlToken } from './shell/os-control.ts'
import { PanelShell } from './shell/panels.ts'
import { registerBrandingIpc } from './shell/branding.ts'
import { EmojiPanel } from './shell/emoji-panel.ts'
import { registerMenuExtensionsIpc } from './shell/menu-extensions.ts'
import { registerServiceIpc } from './shell/services.ts'
import { WallpaperService } from './shell/wallpaper.ts'
import { appIconPath, createMainWindow } from './window.ts'

app.setName('Herald OS')
// Chromium turns WebGL off where it does not accelerate the graphics (virtual machines, drivers it
// blocklists), and Herald Canvas draws with WebGL: there it falls back to SwiftShader, Chromium's
// software renderer, rather than to nothing. Machines it accelerates are not affected.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-unsafe-swiftshader')
}
// Widget plugins load from herald-plugin://<id>/, Canvas's verified models from herald-model://<model>/
// (registered before the app is ready, as Electron requires).
protocol.registerSchemesAsPrivileged([
  { scheme: 'herald-plugin', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: MODEL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

// Electron shows a modal dialog for an uncaught main-process error and waits on it: the whole
// shell, the Linux session included, would freeze behind a box nobody may see. Log it and go on.
process.on('uncaughtException', error => log('main', `uncaught exception: ${error.stack ?? error.message}`))
// Renderer faults go to each window's console (src/lib/report.ts), which only DevTools shows.
forwardRendererConsole()

// Started by a command a Hermes session ran, Herald OS inherits that session; the terminals, apps,
// hooks and backend it starts must not pass for it (backend/session-env.ts).
for (const name of forgetInheritedSession()) {
  log('main', `dropped the inherited ${name}`)
}

for (const line of migrateLegacyData({ hermesHome: hermesHome(), appData: app.getPath('appData'), userData: app.getPath('userData') })) {
  log('migrate', line)
}

const backend = new BackendManager()
let mainWindow: BrowserWindow | null = null
const mode = shellMode()
// Panels mode (niri): several surface windows, compositor state mirror, control socket for hotkeys.
const panels = mode === 'panels' ? new PanelShell(win => attachMainWindow(win)) : null
const wallpaper = panels ? new WallpaperService(panels) : null
// Panels mode: the desktop pet is a window of its own, which main moves through niri.
const petWindow = panels ? new PetWindow(panels) : null
// The agent's `os_ui` tool and the CLI run registry commands in the Hermes window through this bridge.
const osBridge = new OsCommandBridge(() => (panels ? panels.mainWindow() : mainWindow))
const plugins = new PluginHost(
  () => BrowserWindow.getAllWindows(),
  () => (panels ? panels.mainWindow() : mainWindow),
  osBridge
)
/** The Room's live detail and activity log follow every change to the preferences made through this Herald. */
function followRoomPrefs(next: HeraldOSPrefs): void {
  const room = normalizeRoomPrefs(next.room)
  activity.setPrefs(room)
  void roomLog.setPrefs(room)
}
/** Preferences changed outside a renderer (the CLI, a theme): every window and the wallpaper follow. */
function broadcastPrefs(next: HeraldOSPrefs): void {
  followRoomPrefs(next)
  wallpaper?.apply(next.wallpaper)

  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.prefsChanged, next)
  }
}

const switches = new SwitchService({
  session: Boolean(panels),
  getWindows: () => BrowserWindow.getAllWindows(),
  onPrefs: broadcastPrefs,
  showScreensaver: () => mainWindow?.webContents.send(IPC.shellCommand, { type: 'screensaver' } satisfies ShellCommand)
})
// Linux without the panels session: Herald as an app inside Hyprland or Omarchy, or the cage kiosk.
// The `herald-os` CLI (and so the compositor's hotkeys) reaches the one window through the same socket.
const appHost = !panels && process.platform === 'linux' ? new DesktopHost(() => mainWindow, createCompositor(detectCompositor())) : null
// macOS: Cmd+Ctrl+E opens the emoji picker over any app (Herald OS Linux binds it in niri).
const emojiPanel = !panels && process.platform === 'darwin' ? new EmojiPanel(() => mainWindow) : null
const shellHost: ShellHost | null = panels ?? appHost
// Where the backend and Hermes processes reach main: the compositor CLI's socket in panels mode, the OS control server's otherwise.
const osControlPath = panels ? path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`, 'herald-os', 'control.sock') : path.join(heraldOsDataDir(), 'control.sock')
// The Room's live activity from Hermes outside Herald and its activity log, both off until the person turns them on.
const activity = new ActivityHub({ dataDir: heraldOsDataDir(), socket: osControlPath })
const roomLog = new RoomLog({ dir: path.join(heraldOsDataDir(), 'room-log') })
const control = shellHost
  ? new ControlSocket(
      shellHost,
      broadcastPrefs,
      osBridge,
      spec => {
        syncHermesSkin(spec, backend)
        events.emit('theme-set', { theme: spec.name })
      },
      () => void switches.broadcast(),
      plugins,
      activity
    )
  : null
// Desktop mode has no compositor CLI socket; the OS control server gives it the same `ui*` surface.
const osControl = panels
  ? null
  : new OsControlServer(
      osControlPath,
      desktopControlHandler({
        bridge: osBridge,
        activity,
        relay: command => {
          mainWindow?.webContents.send(IPC.shellCommand, command)
          mainWindow?.show()
        }
      })
    )
backend.setControl(osControlPath, osControlToken())
// Serves org.freedesktop.Notifications so other apps' notifications reach the shell.
const notifications = panels ? new NotificationDaemon(panels) : null
/** Deliver a ShellCommand to the Hermes window; panels mode queues it until that window has loaded. */
const toHermesWindow = (command: ShellCommand) => (panels ? panels.relay('main', command) : mainWindow?.webContents.send(IPC.shellCommand, command))
const crashes = new CrashWatcher(
  report => toHermesWindow({ type: 'crash', payload: { ...report } }),
  () => [backend.childPid()].filter((pid): pid is number => pid !== null),
  report => events.emit('crash', { app: report.app, pid: report.pid, reason: report.reason })
)
// Every event runs the person's hook scripts and fires the Hermes automations waiting for it.
events.on(event => {
  runHooks(event)
  void fireEventAutomations(event, backend)
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

function windowState(win: BrowserWindow): WindowState {
  return { fullscreen: win.isFullScreen(), focused: win.isFocused() }
}

function broadcastWindowState(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.windowState, windowState(mainWindow))
  }
}

function registerCoreIpc(): void {
  ipcMain.handle(IPC.backendGetState, () => backend.getState())
  ipcMain.handle(IPC.backendRestart, () => backend.restart())
  ipcMain.handle(IPC.backendRest, (_event, request: RestRequest) => backend.rest(request))
  ipcMain.handle(IPC.backendLogTail, (_event, lines: number) => [...logTail(lines), ...backend.getState().logTail])

  ipcMain.handle(IPC.notifyNative, (_event, title: string, body: string) => {
    if (Notification.isSupported()) {
      const notification = new Notification({ title: String(title).slice(0, 120), body: String(body).slice(0, 400), silent: true })
      // macOS only shows notifications from code-signed apps; unsigned builds fail here.
      notification.on('failed', (_event, error) => log('notify', `native notification failed: ${error}`))
      notification.show()
    }
  })

  ipcMain.handle(IPC.windowGetState, () => (mainWindow ? windowState(mainWindow) : { fullscreen: false, focused: false }))
  ipcMain.handle(IPC.windowToggleFullscreen, () => {
    if (mainWindow) {
      mainWindow.setFullScreen(!mainWindow.isFullScreen())
    }
  })
  ipcMain.handle(IPC.windowQuit, () => app.quit())

  ipcMain.handle(IPC.shellOpenExternal, (_event, url: unknown) => {
    if (mayOpenExternally(url)) {
      return shell.openExternal(url)
    }

    throw new Error(process.platform === 'darwin' ? 'only http(s) URLs and Privacy & Security settings may be opened externally' : 'only http(s) URLs may be opened externally')
  })

  ipcMain.handle(IPC.prefsGet, () => readPrefs())
  ipcMain.handle(IPC.prefsSet, (_event, patch: PrefsPatch) => {
    const next = writePrefs(patch)

    if (patch.room) {
      followRoomPrefs(next)
    }

    if ('wallpaper' in patch) {
      wallpaper?.apply(next.wallpaper)
    }

    if (patch.voice) {
      applyVoiceHotkey(next.voice.enabled ? next.voice.hotkey : '', () => BrowserWindow.getAllWindows())
    }

    if ('idle' in patch || 'screensaver' in patch) {
      void switches.applyIdle(next)
    }

    if ('doNotDisturb' in patch || 'screensaver' in patch) {
      void switches.broadcast()
    }

    // The keymap lives in niri's config, which the CLI renders (niri reloads it by itself).
    if ('keymap' in patch && process.platform === 'linux') {
      void run('herald-os', ['keymap', next.keymap === 'omarchy' ? 'omarchy' : 'herald'], 10_000).then(result => result.code !== 0 && log('keymap', result.stderr.trim()))
    }

    // Every surface window sees the same preferences.
    sendPrefsToOthers(BrowserWindow.getAllWindows(), _event.sender, next)

    return next
  })
  ipcMain.handle(IPC.prefsAdoptLegacyNotify, (event, flags: unknown) => handleAdoptLegacyNotify(BrowserWindow.getAllWindows(), event.sender, flags))

  ipcMain.handle(
    IPC.envInfo,
    (): EnvInfo => ({ platform: process.platform, hermesHome: hermesHome(), homeDir: os.homedir(), version: app.getVersion(), isDev, shellMode: mode, languages: systemLanguages() })
  )

  registerFsIpc(() => mainWindow)
  registerCanvasIpc(() => mainWindow)
  registerModelIpc()
  registerOfficeIpc(() => mainWindow)
  registerAppsIpc()
  registerBridgeIpc()
  registerServiceIpc()
  registerMenuExtensionsIpc()
  registerBrandingIpc()
  registerSystemIpc(() => BrowserWindow.getAllWindows())
  registerContextIpc(
    () => BrowserWindow.getAllWindows(),
    back => events.emit('returned', { reason: back.reason, away_minutes: Math.round(back.awayMs / 60_000) })
  )
  registerThemeIpc({ panels: Boolean(panels), broadcast: broadcastPrefs, backend })
  registerCaptureIpc(state => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.captureRecordChanged, state)
    }
  })
  registerControlsIpc()
  registerNotificationHistoryIpc()
  registerPetIpc({ hermesWindow: () => (panels ? panels.mainWindow() : mainWindow), petWindow })
  registerRoomIpc({ activity, log: roomLog })
  registerCalcIpc({ dir: path.join(heraldOsDataDir(), 'calc'), prefs: () => readPrefs().calc })
  registerDictationIpc(() => (panels ? panels.mainWindow() : mainWindow))
  registerCatalogIpc()
  registerSetupIpc()
  plugins.registerIpc()
  plugins.registerProtocol()
  plugins.watch()
  emojiPanel?.register()
  registerTerminalIpc(() => mainWindow)
  registerVoiceIpc(backend)
  // Desktop mode layers pages over the shell window; panels mode gives them compositor windows.
  const webViews = registerWebIpc(mode === 'desktop')
  registerEditIpc(() => webViews)
}

function attachMainWindow(win: BrowserWindow): void {
  mainWindow = win

  win.on('enter-full-screen', broadcastWindowState)
  win.on('leave-full-screen', broadcastWindowState)
  win.on('focus', broadcastWindowState)
  win.on('blur', broadcastWindowState)

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null
    }
  })
}

function createWindow(): void {
  if (panels) {
    panels.start()
    petWindow?.start()
    void notifications?.start()
    control?.start()
    wallpaper?.start(readPrefs().wallpaper)

    return
  }

  attachMainWindow(createMainWindow(readPrefs()))
  osControl?.start()
  appHost?.start()
  control?.start()

  // Inside Omarchy, Herald wears Omarchy's theme from the start (its theme-set hook keeps it in step),
  // unless a Herald theme was picked since.
  const themeName = readPrefs().themeName
  const omarchy = appHost && isOmarchy() && (!themeName || themeName.startsWith('omarchy-')) ? readOmarchyTheme() : null

  if (omarchy) {
    broadcastPrefs(writePrefs(prefsForTheme(omarchy.spec, omarchy.dir)))
  }
}

app.whenReady().then(async () => {
  log('main', `Herald OS ${app.getVersion()} starting (dev=${isDev}, mode=${mode}, HERMES_HOME=${hermesHome()})`)
  // A packaged app carries its icon in the bundle; `electron .` would show Electron's.
  const icon = isDev ? appIconPath() : undefined

  if (icon && process.platform === 'darwin') {
    app.dock?.setIcon(icon)
  }

  registerCoreIpc()
  events.registerIpc()
  crashes.start()
  startEventSources()
  switches.start()
  backend.onState(state => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.backendState, state)
    }
  })
  createWindow()
  // Once the sockets listen: the control file names one of them.
  const room = normalizeRoomPrefs(readPrefs().room)
  activity.start(room)
  void roomLog.setPrefs(room)
  // Cmd+Ctrl+F is the standard macOS fullscreen toggle; register it as a local shortcut so the
  // user can always leave the environment. Only this shortcut follows focus: the voice hotkey
  // (ipc/voice.ts) must keep working while another app is in front.
  const fullscreenAccelerator = process.platform === 'darwin' ? 'Command+Control+F' : 'F11'
  app.on('browser-window-focus', () => {
    globalShortcut.register(fullscreenAccelerator, () => {
      mainWindow?.setFullScreen(!mainWindow.isFullScreen())
    })
  })
  app.on('browser-window-blur', () => globalShortcut.unregister(fullscreenAccelerator))
  const voicePrefs = readPrefs().voice
  applyVoiceHotkey(voicePrefs.enabled ? voicePrefs.hotkey : '', () => BrowserWindow.getAllWindows())
  void backend.start()
})

app.on('second-instance', () => {
  if (mainWindow) {
    mainWindow.show()
    mainWindow.focus()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('window-all-closed', () => {
  // In panels mode the menu bar and dock keep the session alive; closing the Hermes window is fine.
  if (!panels) {
    app.quit()
  }
})

let quitting = false
app.on('before-quit', event => {
  if (quitting) {
    return
  }

  quitting = true
  event.preventDefault()
  globalShortcut.unregisterAll()
  crashes.stop()
  plugins.stop()
  emojiPanel?.stop()
  control?.stop()
  osControl?.stop()
  activity.stop()
  roomLog.stop()
  wallpaper?.stop()
  notifications?.stop()
  panels?.stop()
  appHost?.stop()
  void backend.stop().finally(() => app.quit())
})
