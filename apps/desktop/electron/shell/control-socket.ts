import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { HERALD_EVENT_NAMES, isEventName } from '../../shared/events.ts'
import type { HeraldOSPrefs, ShellCommand } from '../../shared/ipc.ts'
import { isHexColor, THEME_COLOR_KEYS, type ThemeColors, type ThemeSpec } from '../../shared/theme.ts'
import { allowAttachments } from '../attachments.ts'
import { events } from '../events/bus.ts'
import { hostPlatform } from '../platform/index.ts'
import { log } from '../log.ts'
import { readPrefs, writePrefs } from '../prefs.ts'
import { readOmarchyTheme } from '../theme/omarchy.ts'
import { findTheme, prefsForTheme } from '../theme/themes.ts'
import { describePermissions } from '../../shared/plugins.ts'
import type { PluginHost } from '../plugins/host.ts'
import type { ShellHost } from './host.ts'
import { menuFile, readMenuExtensions } from './menu-extensions.ts'
import { brandingView, setBranding } from './branding.ts'
import type { BrandingPatch, BrandingView } from '../../shared/branding.ts'
import { handleUiRequest, isUiRequest, type OsCommandBridge, type UiControlRequest } from './os-control.ts'

interface ControlRequest {
  cmd: string
  args?: string[]
  attachments?: string[]
  /** `theme`: the shell part of a theme definition. */
  shell?: Record<string, unknown>
  wallpaper?: string
  /** `theme`: the theme's colours. */
  colors?: Record<string, unknown>
}

/** Commands that open the command overlay in a given mode, with the focused window as context. */
const OVERLAY_MODES = new Set(['ask', 'command', 'applications', 'menu', 'power', 'clipboard', 'emoji'])

/**
 * Unix socket the `herald-os` CLI (and therefore every compositor hotkey) talks to:
 * one JSON object per line in, one JSON object per line out.
 */
export class ControlSocket {
  private server: net.Server | null = null

  constructor(
    private readonly shell: ShellHost,
    /** Called after the CLI changes preferences so windows and the wallpaper follow. */
    private readonly onPrefsChanged?: (prefs: HeraldOSPrefs) => void,
    /** Runs registry commands in the Hermes window (`ui`, `ui-list`, `ui-state`; token-protected). */
    private readonly osBridge?: OsCommandBridge,
    /** A theme was applied: Hermes's skin follows it. */
    private readonly onTheme?: (spec: ThemeSpec) => void,
    /** The CLI changed a switch (night light, staying awake): the menu bar follows. */
    private readonly onSwitches?: () => void,
    /** `herald-os plugin …`: the same plugin host Settings uses. */
    private readonly plugins?: PluginHost
  ) {}

  get socketPath(): string {
    const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`

    return path.join(runtime, 'herald-os', 'control.sock')
  }

  start(): void {
    const socketPath = this.socketPath

    try {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 })
      fs.unlinkSync(socketPath)
    } catch (error) {
      // A missing socket is normal; an unwritable runtime dir must not take the shell down.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log('control', `cannot prepare ${socketPath}: ${(error as Error).message}`)

        return
      }
    }

    this.server = net.createServer(connection => {
      let buffer = ''
      connection.setEncoding('utf8')
      connection.on('data', chunk => {
        buffer += chunk
        let index = buffer.indexOf('\n')

        while (index >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)

          if (line) {
            void this.handleLine(line).then(reply => connection.write(`${JSON.stringify(reply)}\n`))
          }

          index = buffer.indexOf('\n')
        }
      })
      connection.on('error', () => undefined)
    })
    this.server.on('error', error => log('control', `socket error: ${error.message}`))
    this.server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600)
      log('control', `listening on ${socketPath}`)
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null

    try {
      fs.unlinkSync(this.socketPath)
    } catch {
      // Already gone.
    }
  }

  private async handleLine(line: string): Promise<Record<string, unknown>> {
    let request: ControlRequest

    try {
      request = JSON.parse(line) as ControlRequest
    } catch {
      return { ok: false, error: 'invalid JSON' }
    }

    try {
      return await this.handle(request)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async handle(request: ControlRequest): Promise<Record<string, unknown>> {
    const args = request.args ?? []
    const { cmd } = request

    if (this.osBridge && isUiRequest(cmd)) {
      const reply = await handleUiRequest(request as unknown as UiControlRequest, this.osBridge)

      if (reply) {
        return reply
      }
    }

    if (cmd === 'os') {
      // `herald-os os <command.id> [json]`: the CLI path to the registry (no token; same user).
      const [id, json] = args

      if (!id) {
        return { ok: false, error: 'os needs a command id' }
      }

      this.shell.relay('main', { type: 'os', args: [id], payload: json ? (JSON.parse(json) as Record<string, unknown>) : undefined })

      return { ok: true }
    }

    if (cmd === 'os-run') {
      // Like `os`, but waits for the result (`herald-os bar list` prints it).
      const [id, json] = args

      if (!id || !this.osBridge) {
        return { ok: false, error: id ? 'the command registry is not available' : 'os-run needs a command id' }
      }

      const reply = await this.osBridge.run(id, json ? (JSON.parse(json) as Record<string, unknown>) : {}, 'cli')
      const result = reply.result as { ok?: boolean; summary?: string; error?: string; data?: unknown } | undefined

      if (reply.error || !result) {
        return { ok: false, error: reply.error ?? 'no result' }
      }

      return { ok: result.ok !== false, summary: result.summary, data: result.data, ...(result.ok === false ? { error: result.error ?? result.summary } : {}) }
    }

    if (OVERLAY_MODES.has(cmd)) {
      const focused = this.shell.wm?.focusedWindow() ?? null

      // Files named on the herald-os command line are the person's choice, like the file dialog's.
      if (request.attachments?.length) {
        allowAttachments(request.attachments)
      }

      const command: ShellCommand = {
        type: cmd,
        args,
        text: args.join(' ') || undefined,
        attachments: request.attachments,
        // Our own windows are not interesting context ("ask about this window" over the Hermes window).
        context: focused && !focused.ours ? focused : null
      }
      this.shell.open('command', command)

      return { ok: true }
    }

    switch (cmd) {
      case 'page': {
        const id = args[0]

        if (!id) {
          return { ok: false, error: 'page needs an id' }
        }

        this.shell.relay('main', { type: 'show-page', args: [id] })
        void this.shell.focusInCompositor('main')

        return { ok: true }
      }
      case 'open': {
        const appId = args[0]

        if (!appId) {
          return { ok: false, error: 'open needs an app id (terminal, system, chat-popout)' }
        }

        // Super+Return honours Settings > General > Terminal (Ghostty, Kitty, …); Herald's own otherwise.
        const external = appId === 'terminal' ? readPrefs().defaultTerminal : undefined

        if (external && external !== 'herald') {
          const launched = await this.launchByName(external)

          if (launched) {
            return { ok: true, launched }
          }
        }

        this.shell.open(`window:${appId}`)

        return { ok: true }
      }
      case 'launch': {
        const query = args.join(' ').trim()

        if (!query) {
          return { ok: false, error: 'launch needs an application name' }
        }

        const launched = await this.launchByName(query)

        return launched ? { ok: true, launched } : { ok: false, error: `no application matches ${query.toLowerCase()}` }
      }
      case 'notify': {
        this.shell.relay('main', { type: 'notify', args })

        return { ok: true }
      }
      case 'dictate':
        // Mod+Ctrl+X: start or finish dictation into the focused app (see store/dictation.ts).
        this.shell.relay('main', { type: 'dictate' })

        return { ok: true }
      case 'voice': {
        // toggle | start | stop | mute: the Hermes window owns the conversation (see store/voice.ts).
        const action = args[0] ?? 'toggle'

        if (!['toggle', 'start', 'stop', 'mute'].includes(action)) {
          return { ok: false, error: 'voice needs toggle | start | stop | mute' }
        }

        this.shell.relay('main', { type: 'voice', args: [action] })

        return { ok: true }
      }
      case 'update-available': {
        // From herald-os-update --check: [pendingCount, summary]. The menu bar shows a dot when > 0.
        this.shell.relay('menubar', { type: 'update-available', args })

        return { ok: true }
      }
      case 'webapp': {
        const [url, name, slug] = args

        if (!url || !/^https?:\/\//i.test(url) || !name) {
          return { ok: false, error: 'webapp needs an http(s) url and a name' }
        }

        this.shell.openWebApp(url, name, slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-'))

        return { ok: true }
      }
      case 'wallpaper': {
        const next = writePrefs({ wallpaper: args[0] ? args[0] : undefined })
        this.onPrefsChanged?.(next)

        return { ok: true, wallpaper: next.wallpaper ?? 'default' }
      }
      case 'theme': {
        // herald-os-theme has already recoloured niri, swaylock, GTK and foot; this applies the
        // shell's part (theme + accent preference, optional wallpaper) so everything switches together.
        const name = args[0]

        if (!name) {
          return { ok: false, error: 'theme needs a name' }
        }

        // The shell reads the same theme.json the engine applied; a theme only the engine can see
        // (an unusual folder) still applies from the fields it sent.
        const found = findTheme(name)
        const patch: Partial<HeraldOSPrefs> = found ? prefsForTheme(found.spec, found.dir) : this.themeFromRequest(name, request)

        if (!found && typeof request.wallpaper === 'string') {
          patch.wallpaper = request.wallpaper || undefined
        }

        const next = writePrefs(patch)
        this.onPrefsChanged?.(next)

        if (found) {
          this.onTheme?.(found.spec)
        }

        return { ok: true, theme: next.themeName ?? next.theme, accent: next.accent }
      }
      case 'branding': {
        // show | set <json patch> | reset [all|logo|lock|name]
        const [action = 'show', value = ''] = args
        const summary = (view: BrandingView) => ({ name: view.name, logo: Boolean(view.logo), lock: view.lock })

        try {
          if (action === 'set') {
            return { ok: true, branding: summary(setBranding(JSON.parse(value || '{}') as BrandingPatch)) }
          }

          if (action === 'reset') {
            const part = value || 'all'

            if (!['all', 'logo', 'lock', 'name'].includes(part)) {
              return { ok: false, error: 'branding reset [all|logo|lock|name]' }
            }

            return { ok: true, branding: summary(setBranding(part === 'all' ? { logo: null, lock: null, name: null } : { [part]: null })) }
          }

          return { ok: true, branding: summary(brandingView()) }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      case 'menu-check': {
        // `herald-os menu check`: what the control menu makes of ~/.config/herald-os/menu.json.
        const { entries, errors } = readMenuExtensions()

        return { ok: true, file: menuFile(), entries: entries.map(entry => ({ label: entry.label, group: entry.group ?? 'yours', kind: entry.action.kind })), errors }
      }
      case 'plugin': {
        // list | add <url> | enable <id> | disable <id> | update <id> | remove <id>
        if (!this.plugins) {
          return { ok: false, error: 'plugins are not available in this shell' }
        }

        const [action = 'list', target = ''] = args

        try {
          switch (action) {
            case 'list':
              return { ok: true, plugins: this.plugins.list().map(plugin => ({ ...plugin.manifest, enabled: plugin.enabled, errors: plugin.errors, grants: describePermissions(plugin.manifest) })) }
            case 'add':
              return { ok: true, plugin: (await this.plugins.add(target)).manifest }
            case 'enable':
            case 'disable':
              this.plugins.setEnabled(target, action === 'enable')

              return { ok: true }
            case 'update':
              return { ok: true, plugin: (await this.plugins.update(target)).manifest }
            case 'remove':
              await this.plugins.remove(target)

              return { ok: true }
            default:
              return { ok: false, error: 'plugin list | add <url> | enable <id> | disable <id> | update <id> | remove <id>' }
          }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      case 'theme-omarchy': {
        // Omarchy's theme-set hook (herald-os omarchy install): Herald's colours follow Omarchy's.
        const found = readOmarchyTheme()

        if (!found) {
          return { ok: false, error: "no Omarchy theme found (~/.config/omarchy/current/theme)" }
        }

        const next = writePrefs(prefsForTheme(found.spec, found.dir))
        this.onPrefsChanged?.(next)
        this.onTheme?.(found.spec)

        return { ok: true, theme: found.spec.name }
      }
      case 'state':
        return { ok: true, ...(this.shell.wm?.state() ?? { available: false, windows: [], workspaces: [], focusedWindowId: null }) }
      case 'switches':
        this.onSwitches?.()

        return { ok: true }
      case 'screensaver':
        // swayidle's screensaver timeout (linux/bin/herald-os-idle) lands here.
        this.shell.open('screensaver')

        return { ok: true }
      case 'panel': {
        // `herald-os panel wifi|bluetooth|audio|display|power|clock`: the menu bar's quick panels.
        const panel = args[0]

        if (!panel || !['wifi', 'bluetooth', 'audio', 'display', 'power', 'clock'].includes(panel)) {
          return { ok: false, error: 'panel needs wifi, bluetooth, audio, display, power or clock' }
        }

        this.shell.open('panel', { type: 'panel', args: [panel] })

        return { ok: true }
      }
      case 'event': {
        // `herald-os event <name> [key=value ...]`: the updater and scripts report events here.
        const [name, ...pairs] = args

        if (!isEventName(name)) {
          return { ok: false, error: `unknown event ${name ?? ''}; events: ${HERALD_EVENT_NAMES.join(', ')}` }
        }

        const detail: Record<string, string> = {}

        for (const pair of pairs) {
          const at = pair.indexOf('=')

          if (at > 0) {
            detail[pair.slice(0, at)] = pair.slice(at + 1)
          }
        }

        events.emit(name, detail)

        return { ok: true }
      }
      default:
        return { ok: false, error: `unknown command ${cmd}` }
    }
  }

  /** Launch an installed application by name or desktop id; the name it launched, or null. */
  private async launchByName(name: string): Promise<string | null> {
    const query = name.trim().toLowerCase()
    const apps = await hostPlatform().listInstalledApps()
    const match =
      apps.find(a => a.name.toLowerCase() === query) ??
      apps.find(a => (a.bundleId ?? '').toLowerCase() === query) ??
      apps.find(a => a.name.toLowerCase().includes(query)) ??
      apps.find(a => (a.bundleId ?? '').toLowerCase().includes(query))

    if (!match) {
      return null
    }

    await hostPlatform().launchApp(match.path)

    return match.name
  }

  private themeFromRequest(name: string, request: ControlRequest): Partial<HeraldOSPrefs> {
    const shellSpec = (request.shell ?? {}) as { theme?: string; accent?: string }

    if (shellSpec.theme === 'ocean' || shellSpec.theme === 'graphite') {
      const accent = shellSpec.accent === 'ice' || shellSpec.accent === 'violet' ? shellSpec.accent : 'blue'

      return { themeName: name, theme: shellSpec.theme, accent, themeColors: undefined, themeScheme: undefined }
    }

    const colors = request.colors ?? {}

    if (THEME_COLOR_KEYS.every(key => isHexColor(colors[key]))) {
      return { themeName: name, theme: 'ocean', accent: 'blue', themeColors: colors as unknown as ThemeColors }
    }

    return { themeName: name, theme: name.includes('graphite') ? 'graphite' : 'ocean', accent: 'blue', themeColors: undefined }
  }
}
