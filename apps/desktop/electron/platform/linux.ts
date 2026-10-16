import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BatteryStatus, CalendarResult, ControlAction, DiskUsage, InstalledApp, NetworkStatus, ProcessInfo, RecentFile, StatusPanelId, StatusPanelState, SystemInfo, SystemSpeech, SystemStats } from '../../shared/ipc.ts'
import { findCodeEditor } from './editors.ts'
import { MISSING_BINARY, run, runBuffer } from './exec.ts'
import { normaliseFileQuery, rankFiles } from './find.ts'
import { linuxControlAction, linuxControlStatus } from './linux-controls.ts'
import { parseDf, parsePs } from './posix.ts'
import { linuxSpeech, renderSystemSpeech } from './system-voice.ts'
import { type EditorTarget, type HostPlatform, HostNotSupported } from './types.ts'

interface CpuSample {
  idle: number
  total: number
}

export interface OsRelease {
  prettyName?: string
  name?: string
  versionId?: string
  id?: string
}

export interface DesktopEntry {
  name: string
  exec: string
  icon?: string
  categories: string[]
  noDisplay: boolean
  hidden: boolean
  terminal: boolean
}

export interface NmcliDevice {
  type: string
  state: string
  connection: string
  device: string
}

export interface NmcliWifi {
  active: boolean
  ssid: string
  signal: number
}

export interface RecentBookmark {
  path: string
  modifiedAt: number
  visitedAt: number
}

/** XDG data dirs that ship `.desktop` entries, in override precedence order (user first, first hit wins). */
const APPLICATION_DIRS = [
  path.join(os.homedir(), '.local', 'share', 'applications'),
  '/usr/local/share/applications',
  '/usr/share/applications',
  path.join(os.homedir(), '.local', 'share', 'flatpak', 'exports', 'share', 'applications'),
  '/var/lib/flatpak/exports/share/applications'
]

/** Icon themes searched as `<theme>/<size>/apps/<name>.<ext>`. */
const ICON_THEME_DIRS = [
  path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor'),
  '/usr/share/icons/hicolor',
  '/usr/share/icons/Adwaita',
  path.join(os.homedir(), '.local', 'share', 'flatpak', 'exports', 'share', 'icons', 'hicolor'),
  '/var/lib/flatpak/exports/share/icons/hicolor'
]
/** Flat icon dirs searched as `<dir>/<name>.<ext>`. */
const ICON_FLAT_DIRS = [path.join(os.homedir(), '.local', 'share', 'icons'), '/usr/share/pixmaps']
/** Ordered for a sharp 68 px tile at scale 2; some Flatpaks ship nothing between 512 and 32. */
const ICON_SIZES = ['256x256', '128x128', '512x512', '96x96', '64x64', '48x48', 'scalable']
const ICON_EXTENSIONS = ['.png', '.svg']

/** GNOME thumbnail cache buckets, largest first. */
const THUMBNAIL_BUCKETS = ['xx-large', 'x-large', 'large', 'normal']
const RAW_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const RAW_IMAGE_LIMIT = 8 * 1024 * 1024

/**
 * freedesktop menu categories -> the LSApplicationCategoryType vocabulary darwin reports, so the
 * renderer's `nativeCategory()` needs no platform branch. Refining (additional) categories are
 * checked before main ones so `Network;WebBrowser` lands in productivity, not social networking.
 */
const DESKTOP_ADDITIONAL_CATEGORIES: Record<string, string> = {
  IDE: 'developer-tools',
  WebBrowser: 'productivity',
  Email: 'productivity',
  Calendar: 'productivity',
  WordProcessor: 'productivity',
  Spreadsheet: 'productivity',
  Presentation: 'productivity',
  Finance: 'finance',
  Photography: 'photography',
  Music: 'music',
  Player: 'video',
  Chat: 'social-networking',
  InstantMessaging: 'social-networking',
  Dictionary: 'reference'
}
const DESKTOP_MAIN_CATEGORIES: Record<string, string> = {
  Development: 'developer-tools',
  Office: 'productivity',
  Graphics: 'graphics-design',
  Audio: 'music',
  Video: 'video',
  AudioVideo: 'video',
  Game: 'games',
  Education: 'education',
  Science: 'education',
  Network: 'social-networking',
  Utility: 'utilities',
  System: 'utilities',
  Settings: 'utilities'
}

/** Parse `/etc/os-release` (KEY="value" lines; quotes and simple backslash escapes removed). */
export function parseOsRelease(text: string): OsRelease {
  const values = new Map<string, string>()

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()

    if (!line || line.startsWith('#')) {
      continue
    }

    const eq = line.indexOf('=')

    if (eq <= 0) {
      continue
    }

    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    values.set(key, value.replace(/\\(["'$`\\])/g, '$1'))
  }

  return { prettyName: values.get('PRETTY_NAME'), name: values.get('NAME'), versionId: values.get('VERSION_ID'), id: values.get('ID') }
}

/** Aggregate `cpu` line of `/proc/stat` -> jiffies; idle includes iowait. */
export function parseProcStat(text: string): CpuSample | null {
  const line = text.split('\n').find(l => /^cpu\s/.test(l))

  if (!line) {
    return null
  }

  const fields = line.trim().split(/\s+/).slice(1).map(Number)

  if (fields.length < 4 || fields.some(n => !Number.isFinite(n))) {
    return null
  }

  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields

  return { idle: idle + iowait, total: user + nice + system + idle + iowait + irq + softirq + steal }
}

/** `/proc/meminfo` -> bytes. `available` prefers MemAvailable and falls back to free + buffers + cached. */
export function parseMeminfo(text: string): { total: number; available: number } | null {
  const kb = (label: string): number | null => {
    const match = new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(text)

    return match ? Number(match[1]) * 1024 : null
  }
  const total = kb('MemTotal')

  if (total === null || total <= 0) {
    return null
  }

  const available = kb('MemAvailable') ?? (kb('MemFree') ?? 0) + (kb('Buffers') ?? 0) + (kb('Cached') ?? 0)

  return { total, available: Math.min(total, available) }
}

/** Contents of `capacity` and `status` under a `/sys/class/power_supply/BATn` entry; either missing -> not present. */
export function parseBattery(capacity: string | null | undefined, status: string | null | undefined): BatteryStatus {
  const percent = Number(capacity?.trim())

  if (capacity === null || capacity === undefined || !Number.isFinite(percent)) {
    return { present: false }
  }

  const state = (status ?? '').trim().toLowerCase()

  return { present: true, percent: Math.max(0, Math.min(100, percent)), charging: state === 'charging' || state === 'full' }
}

/** Keep the mounts a desktop user thinks of as "disks": root, /home, and removable/media mounts. */
export function filterLinuxMounts(disks: DiskUsage[]): DiskUsage[] {
  const seen = new Set<string>()
  const keep = (mount: string): boolean => mount === '/' || mount === '/home' || /^\/(?:media|run\/media|mnt)\/[^/]/.test(mount)

  return disks.filter(disk => {
    if (!keep(disk.mount) || seen.has(disk.mount)) {
      return false
    }

    seen.add(disk.mount)

    return true
  })
}

/** Strip the freedesktop field codes (`%f`, `%U`, ...) from an `Exec=` line; `%%` becomes a literal `%`. */
export function stripExecFieldCodes(exec: string): string {
  return exec
    .replace(/%%/g, '\0')
    .replace(/\s*%[fFuUdDnNickvm]/g, '')
    .replace(/\0/g, '%')
    .trim()
}

/**
 * Parse a `.desktop` file's `[Desktop Entry]` group. Returns null for non-application entries and
 * entries without a name; the caller decides what to do with `noDisplay` / `hidden` / `terminal`.
 */
export function parseDesktopEntry(text: string, filePath: string): DesktopEntry | null {
  const values = new Map<string, string>()
  let inEntry = false
  let sawEntry = false

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()

    if (!line || line.startsWith('#')) {
      continue
    }

    if (line.startsWith('[')) {
      if (inEntry) {
        break
      }

      inEntry = line === '[Desktop Entry]'
      sawEntry ||= inEntry
      continue
    }

    if (!inEntry) {
      continue
    }

    const eq = line.indexOf('=')

    if (eq <= 0) {
      continue
    }

    const key = line.slice(0, eq).trim()

    // Localised keys (`Name[pt_BR]`) are skipped; the shell shows the unlocalised name.
    if (key.includes('[') || values.has(key)) {
      continue
    }

    values.set(key, line.slice(eq + 1).trim())
  }

  const type = values.get('Type') ?? 'Application'

  if (!sawEntry || type !== 'Application') {
    return null
  }

  const name = values.get('Name') || path.basename(filePath, '.desktop')
  const flag = (key: string): boolean => (values.get(key) ?? '').toLowerCase() === 'true'

  return {
    name,
    exec: stripExecFieldCodes(values.get('Exec') ?? ''),
    icon: values.get('Icon') || undefined,
    categories: (values.get('Categories') ?? '').split(';').map(c => c.trim()).filter(Boolean),
    noDisplay: flag('NoDisplay'),
    hidden: flag('Hidden'),
    terminal: flag('Terminal')
  }
}

/** First recognised freedesktop category -> `public.app-category.*`, or undefined when none match. */
export function mapDesktopCategory(categories: string[]): string | undefined {
  for (const table of [DESKTOP_ADDITIONAL_CATEGORIES, DESKTOP_MAIN_CATEGORIES]) {
    for (const category of categories) {
      const mapped = table[category]

      if (mapped) {
        return `public.app-category.${mapped}`
      }
    }
  }

  return undefined
}

/** Split an `nmcli -t` line on unescaped colons (`\:` is a literal colon in terse mode). */
function splitTerse(line: string): string[] {
  const fields: string[] = []
  let current = ''

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]

    if (ch === '\\' && i + 1 < line.length) {
      current += line[++i]
    } else if (ch === ':') {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }

  fields.push(current)

  return fields
}

/** Parse `nmcli -t -f TYPE,STATE,CONNECTION,DEVICE dev status`. */
export function parseNmcliDevStatus(text: string): NmcliDevice[] {
  const rows: NmcliDevice[] = []

  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue
    }

    const [type = '', state = '', connection = '', device = ''] = splitTerse(line)
    rows.push({ type, state, connection: connection === '--' ? '' : connection, device })
  }

  return rows
}

/** Parse `nmcli -t -f ACTIVE,SSID,SIGNAL dev wifi list`. */
export function parseNmcliWifi(text: string): NmcliWifi[] {
  const rows: NmcliWifi[] = []

  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue
    }

    const fields = splitTerse(line)

    if (fields.length < 3) {
      continue
    }

    const signal = Number(fields[fields.length - 1])
    rows.push({ active: fields[0].toLowerCase() === 'yes', ssid: fields.slice(1, -1).join(':'), signal: Number.isFinite(signal) ? signal : 0 })
  }

  return rows
}

function decodeXmlAttribute(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/** Parse GTK's `recently-used.xbel`: `file://` bookmarks, newest `modified` first, at most `limit` rows. */
export function parseRecentlyUsed(xml: string, limit: number): RecentBookmark[] {
  const rows: RecentBookmark[] = []
  const bookmarkRe = /<bookmark\b([^>]*)>/g
  let match: RegExpExecArray | null

  while ((match = bookmarkRe.exec(xml)) !== null) {
    const attrs = match[1]
    const attr = (name: string): string | undefined => {
      const found = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)

      return found ? decodeXmlAttribute(found[1]) : undefined
    }
    const href = attr('href')

    if (!href?.startsWith('file://')) {
      continue
    }

    let filePath: string

    try {
      filePath = decodeURIComponent(href.slice('file://'.length))
    } catch {
      continue
    }

    if (!filePath.startsWith('/')) {
      continue
    }

    const modifiedAt = Date.parse(attr('modified') ?? '') || 0
    const visitedAt = Date.parse(attr('visited') ?? '') || modifiedAt
    rows.push({ path: filePath, modifiedAt, visitedAt })
  }

  rows.sort((a, b) => Math.max(b.visitedAt, b.modifiedAt) - Math.max(a.visitedAt, a.modifiedAt))

  return rows.slice(0, Math.max(0, limit))
}

/**
 * `file://` URI the way GLib's `g_filename_to_uri` builds it: UTF-8 bytes percent-encoded except
 * unreserved characters and the path punctuation GLib leaves alone. Thumbnail cache names hash this.
 */
export function fileUri(filePath: string): string {
  const keep = /[A-Za-z0-9\-_.!~*'()/:@&=+$,]/
  let out = ''

  for (const byte of Buffer.from(filePath, 'utf8')) {
    const ch = String.fromCharCode(byte)
    out += byte < 128 && keep.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }

  return `file://${out}`
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)

    return true
  } catch {
    return false
  }
}

function cpuSampleFromOs(): CpuSample {
  let idle = 0
  let total = 0

  for (const cpu of os.cpus()) {
    idle += cpu.times.idle
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle
  }

  return { idle, total }
}

async function cpuSample(): Promise<CpuSample> {
  const text = await readText('/proc/stat')

  return (text ? parseProcStat(text) : null) ?? cpuSampleFromOs()
}

/**
 * Fire-and-forget launch of a desktop program. Resolves once the child has spawned; a missing binary
 * rejects with HostNotSupported naming the package instead of crashing main with an unhandled 'error'.
 */
function spawnDetached(command: string, args: string[], requires: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ENOENT' ? new HostNotSupported(`${command} ${args.join(' ')}`.trim(), requires) : error)
    })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * Run a launcher (`gio launch`, `gtk-launch`) that hands off to a GUI app. The app inherits the
 * launcher's stdio, so a piped `run()` would block until the app quits; ignore stdio, wait only for
 * the launcher process, and treat one still alive after `graceMs` as a successful hand-off.
 * Resolves with the exit code (MISSING_BINARY when the launcher is not installed).
 */
function runLauncher(command: string, args: string[], graceMs = 5000): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.unref()
      resolve(0)
    }, graceMs)
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve(error.code === 'ENOENT' ? MISSING_BINARY : 1)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      resolve(code ?? 1)
    })
  })
}

/** Launch a `.desktop` entry through `gio launch`, else `gtk-launch`; `args` are handed to the app (files to open). */
async function launchDesktopEntry(entry: string, args: string[]): Promise<void> {
  const gio = await runLauncher('gio', ['launch', entry, ...args])

  if (gio === 0) {
    return
  }

  if (gio !== MISSING_BINARY) {
    throw new Error(`failed to launch ${path.basename(entry)} (gio launch exited ${gio})`)
  }

  const gtk = await runLauncher('gtk-launch', [path.basename(entry, '.desktop'), ...args])

  if (gtk === 0) {
    return
  }

  if (gtk === MISSING_BINARY) {
    throw new HostNotSupported('launching desktop entries', 'glib2 (gio) or gtk3 (gtk-launch)')
  }

  throw new Error(`failed to launch ${path.basename(entry)} (gtk-launch exited ${gtk})`)
}

function ipv4For(iface: string | undefined): string | undefined {
  if (!iface) {
    return undefined
  }

  return os.networkInterfaces()[iface]?.find(a => a.family === 'IPv4' && !a.internal)?.address
}

function firstExternalInterface(): string | undefined {
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (addresses?.some(a => a.family === 'IPv4' && !a.internal)) {
      return name
    }
  }

  return undefined
}

export class LinuxPlatform implements HostPlatform {
  private previousCpu: CpuSample | null = null
  private appsCache: { at: number; apps: InstalledApp[] } | null = null
  /** Desktop file -> resolved icon file (or null when the theme has none); lives for the process. */
  private iconPaths = new Map<string, string | null>()

  async systemInfo(): Promise<SystemInfo> {
    const release = parseOsRelease((await readText('/etc/os-release')) ?? (await readText('/usr/lib/os-release')) ?? '')
    const cpus = os.cpus()

    return {
      hostname: os.hostname(),
      platform: 'linux',
      arch: process.arch,
      osName: release.prettyName || release.name || 'Linux',
      osVersion: release.versionId || os.release(),
      cpuModel: cpus[0]?.model ?? 'unknown',
      cpuCount: cpus.length,
      totalMemory: os.totalmem(),
      userName: os.userInfo().username,
      fullName: await this.fullName(),
      homeDir: os.homedir()
    }
  }

  /** The name first-boot setup saved, else the GECOS field of the account (`getent` is glibc). */
  private async fullName(): Promise<string | undefined> {
    try {
      const saved = (await fs.readFile(path.join(os.homedir(), '.config', 'herald-os', 'name'), 'utf8')).trim()

      if (saved) {
        return saved
      }
    } catch {
      // Not set up through Herald OS's setup.
    }

    const result = await run('getent', ['passwd', os.userInfo().username], 3000)

    if (result.code !== 0) {
      return undefined
    }

    const gecos = result.stdout.trim().split(':')[4] ?? ''

    return gecos.split(',')[0].trim() || undefined
  }

  async sampleStats(): Promise<SystemStats> {
    const current = await cpuSample()
    const previous = this.previousCpu ?? current
    this.previousCpu = current
    const idleDelta = current.idle - previous.idle
    const totalDelta = current.total - previous.total
    const cpuPercent = totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0

    const [meminfoText, df, battery] = await Promise.all([readText('/proc/meminfo'), run('df', ['-kP']), this.battery()])
    const meminfo = meminfoText ? parseMeminfo(meminfoText) : null
    const memoryTotal = meminfo?.total ?? os.totalmem()
    const memoryUsed = meminfo ? memoryTotal - meminfo.available : memoryTotal - os.freemem()

    return {
      sampledAt: Date.now(),
      cpuPercent,
      loadAverage: os.loadavg() as [number, number, number],
      memoryTotal,
      memoryUsed,
      memoryFree: memoryTotal - memoryUsed,
      uptimeSeconds: os.uptime(),
      disks: df.code === 0 ? filterLinuxMounts(parseDf(df.stdout, () => true)) : [],
      battery
    }
  }

  private async battery(): Promise<BatteryStatus> {
    const root = '/sys/class/power_supply'
    let supplies: string[] = []

    try {
      supplies = (await fs.readdir(root)).filter(name => name.startsWith('BAT')).sort()
    } catch {
      return { present: false }
    }

    for (const supply of supplies) {
      const [capacity, status] = await Promise.all([readText(path.join(root, supply, 'capacity')), readText(path.join(root, supply, 'status'))])
      const parsed = parseBattery(capacity, status)

      if (parsed.present) {
        return parsed
      }
    }

    return { present: false }
  }

  async listProcesses(sort: 'cpu' | 'memory', limit: number): Promise<ProcessInfo[]> {
    const result = await run('ps', ['-eo', 'pid=,ppid=,user=,%cpu=,%mem=,rss=,comm='])

    if (result.code !== 0) {
      return []
    }

    const rows = parsePs(result.stdout)
    rows.sort((a, b) => (sort === 'cpu' ? b.cpuPercent - a.cpuPercent : b.rssBytes - a.rssBytes))

    return rows.slice(0, limit)
  }

  async listInstalledApps(): Promise<InstalledApp[]> {
    if (this.appsCache && Date.now() - this.appsCache.at < 60_000) {
      return this.appsCache.apps
    }

    const seen = new Set<string>()
    const apps: InstalledApp[] = []

    for (const dir of APPLICATION_DIRS) {
      let entries: string[] = []

      try {
        entries = (await fs.readdir(dir)).filter(name => name.endsWith('.desktop') && !name.startsWith('.')).sort()
      } catch {
        continue
      }

      const parsed = await Promise.all(entries.map(async name => ({ name, text: await readText(path.join(dir, name)) })))

      for (const { name, text } of parsed) {
        const id = name.slice(0, -'.desktop'.length)

        // A user-level override (even one that hides the app) shadows the same id further down the list.
        if (seen.has(id) || text === null) {
          continue
        }

        seen.add(id)
        const filePath = path.join(dir, name)
        const entry = parseDesktopEntry(text, filePath)

        if (!entry || entry.noDisplay || entry.hidden || entry.terminal || !entry.exec) {
          continue
        }

        apps.push({ name: entry.name, path: filePath, bundleId: id, category: mapDesktopCategory(entry.categories) })
      }
    }

    apps.sort((a, b) => a.name.localeCompare(b.name))
    this.appsCache = { at: Date.now(), apps }

    return apps
  }

  private async resolveIconPath(appPath: string): Promise<string | null> {
    const cached = this.iconPaths.get(appPath)

    if (cached !== undefined) {
      return cached
    }

    const text = await readText(appPath)
    const entry = text ? parseDesktopEntry(text, appPath) : null
    const resolved = entry?.icon ? await this.findIconFile(entry.icon) : null
    this.iconPaths.set(appPath, resolved)

    return resolved
  }

  private async findIconFile(icon: string): Promise<string | null> {
    if (path.isAbsolute(icon)) {
      return (await exists(icon)) ? icon : null
    }

    // Some entries carry an extension even though the spec says they should not.
    const name = /\.(png|svg|xpm)$/i.test(icon) ? icon.replace(/\.(png|svg|xpm)$/i, '') : icon
    const candidates: string[] = []

    for (const theme of ICON_THEME_DIRS) {
      for (const size of ICON_SIZES) {
        for (const ext of ICON_EXTENSIONS) {
          candidates.push(path.join(theme, size, 'apps', `${name}${ext}`))
        }
      }
    }

    for (const dir of ICON_FLAT_DIRS) {
      for (const ext of ICON_EXTENSIONS) {
        candidates.push(path.join(dir, `${name}${ext}`))
      }
    }

    for (const candidate of candidates) {
      if (await exists(candidate)) {
        return candidate
      }
    }

    return null
  }

  /** PNG straight from the icon theme; SVG rasterised through librsvg's CLI when available. */
  async appIcon(appPath: string): Promise<Buffer | null> {
    const iconFile = await this.resolveIconPath(appPath)

    if (!iconFile) {
      return null
    }

    if (iconFile.toLowerCase().endsWith('.svg')) {
      const result = await runBuffer('rsvg-convert', ['-w', '128', '-h', '128', iconFile], 10_000)

      // Missing librsvg2-tools (rsvg-convert): no icon rather than an error in the Apps grid.
      return result.code === 0 && result.stdout.length > 0 ? result.stdout : null
    }

    return fs.readFile(iconFile).catch(() => null)
  }

  async launchApp(appPath: string): Promise<void> {
    if (!appPath.endsWith('.desktop')) {
      await spawnDetached('xdg-open', [appPath], 'xdg-utils (xdg-open)')

      return
    }

    await launchDesktopEntry(appPath, [])
  }

  /** FileManager1 D-Bus (Nautilus, Dolphin, Thunar, ...) selects the item; without it, open the parent folder. */
  async revealPath(targetPath: string): Promise<void> {
    const dbus = await run('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.FileManager1', '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1.ShowItems', `array:string:${fileUri(targetPath)}`, 'string:'], 5000)

    if (dbus.code === 0) {
      return
    }

    await spawnDetached('xdg-open', [path.dirname(targetPath)], 'xdg-utils (xdg-open)')
  }

  async openIn(target: EditorTarget, targetPath: string): Promise<void> {
    switch (target) {
      case 'editor':
        await launchDesktopEntry(findCodeEditor(await this.listInstalledApps()).path, [targetPath])

        return
      case 'finder': {
        let dir = targetPath

        try {
          if (!(await fs.stat(targetPath)).isDirectory()) {
            dir = path.dirname(targetPath)
          }
        } catch {
          dir = path.dirname(targetPath)
        }

        await spawnDetached('xdg-open', [dir], 'xdg-utils (xdg-open)')

        return
      }
      case 'terminal':
        // Herald OS ships its own terminal; there is no portable "the" terminal on Linux to hand off to.
        throw new HostNotSupported('external terminal')
    }
  }

  async networkStatus(): Promise<NetworkStatus> {
    const [devices, route] = await Promise.all([run('nmcli', ['-t', '-f', 'TYPE,STATE,CONNECTION,DEVICE', 'dev', 'status'], 5000), run('ip', ['-j', 'route', 'show', 'default'], 4000)])
    let defaultInterface: string | undefined

    if (route.code === 0) {
      try {
        const routes = JSON.parse(route.stdout || '[]') as Array<{ dev?: string }>
        defaultInterface = routes.find(r => typeof r.dev === 'string')?.dev
      } catch {
        defaultInterface = undefined
      }
    }

    if (devices.code !== 0) {
      // No NetworkManager (nmcli): report what the kernel tells us and assume connectivity.
      const iface = defaultInterface ?? firstExternalInterface()

      return { online: true, defaultInterface: iface, ipv4: ipv4For(iface) }
    }

    const rows = parseNmcliDevStatus(devices.stdout)
    const connected = rows.filter(r => r.state.startsWith('connected') && r.type !== 'loopback')
    const wifiDevice = rows.find(r => r.type === 'wifi' && r.state.startsWith('connected')) ?? rows.find(r => r.type === 'wifi')
    defaultInterface ??= connected.find(r => r.type === 'ethernet')?.device ?? connected[0]?.device
    let wifi: NetworkStatus['wifi']

    if (wifiDevice) {
      const isConnected = wifiDevice.state.startsWith('connected')
      let ssid = isConnected ? wifiDevice.connection || undefined : undefined

      if (isConnected) {
        const list = await run('nmcli', ['-t', '-f', 'ACTIVE,SSID,SIGNAL', 'dev', 'wifi', 'list', '--rescan', 'no'], 5000)
        const active = list.code === 0 ? parseNmcliWifi(list.stdout).find(w => w.active && w.ssid) : undefined
        ssid = active?.ssid ?? ssid
      }

      wifi = { connected: isConnected, ssid, interface: wifiDevice.device }
    }

    return { online: connected.length > 0 || Boolean(defaultInterface), defaultInterface, ipv4: ipv4For(defaultInterface), wifi }
  }

  async calendarToday(): Promise<CalendarResult> {
    return { status: 'unavailable', events: [] }
  }

  async recentFiles(limit: number): Promise<RecentFile[]> {
    const xbel = await readText(path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'recently-used.xbel'))
    const rows: RecentFile[] = []

    if (xbel) {
      const bookmarks = parseRecentlyUsed(xbel, limit * 3)
      const stats = await Promise.all(bookmarks.map(async bookmark => ({ bookmark, stat: await fs.stat(bookmark.path).catch(() => null) })))

      for (const { bookmark, stat } of stats) {
        if (!stat) {
          continue
        }

        rows.push({
          path: bookmark.path,
          name: path.basename(bookmark.path),
          extension: path.extname(bookmark.path).toLowerCase(),
          size: stat.size,
          modifiedAt: stat.mtimeMs,
          lastUsedAt: Math.max(bookmark.visitedAt, bookmark.modifiedAt) || stat.mtimeMs,
          kind: stat.isDirectory() ? 'directory' : 'file'
        })
      }
    }

    if (rows.length === 0) {
      rows.push(...(await this.scanRecentFiles()))
    }

    rows.sort((a, b) => b.lastUsedAt - a.lastUsedAt)

    return rows.slice(0, limit)
  }

  async findFiles(query: string, limit: number): Promise<RecentFile[]> {
    const name = normaliseFileQuery(query)

    if (!name) {
      return []
    }

    // No universal file index on Linux: a bounded `find` over the home folder, hidden and build dirs pruned.
    const pattern = `*${name.replace(/[*?[\]]/g, '')}*`
    const args = [os.homedir(), '-maxdepth', '6', '(', '-name', '.*', '-o', '-name', 'node_modules', '-o', '-name', 'venv', ')', '-prune', '-o', '-iname', pattern, '-print']
    const result = await run('find', args, 8000).catch(() => ({ stdout: '' }))
    const paths = result.stdout.split('\n').filter(Boolean).slice(0, 300)
    const rows: RecentFile[] = []

    for (const file of paths) {
      const stat = await fs.stat(file).catch(() => null)

      if (stat) {
        rows.push({ path: file, name: path.basename(file), extension: path.extname(file).toLowerCase(), size: stat.size, modifiedAt: stat.mtimeMs, lastUsedAt: stat.atimeMs, kind: stat.isDirectory() ? 'directory' : 'file' })
      }
    }

    return rankFiles(name, rows, limit)
  }

  /** Fallback when GTK keeps no history: regular files touched in the last 3 days under the usual folders, two levels deep. */
  private async scanRecentFiles(): Promise<RecentFile[]> {
    const home = os.homedir()
    const since = Date.now() - 3 * 24 * 60 * 60 * 1000
    const rows: RecentFile[] = []

    const visit = async (dir: string, depth: number): Promise<void> => {
      let dirents: import('node:fs').Dirent[] = []

      try {
        dirents = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const dirent of dirents) {
        if (dirent.name.startsWith('.')) {
          continue
        }

        const full = path.join(dir, dirent.name)

        if (dirent.isDirectory()) {
          if (depth < 2) {
            await visit(full, depth + 1)
          }

          continue
        }

        if (!dirent.isFile()) {
          continue
        }

        try {
          const stat = await fs.stat(full)

          if (stat.mtimeMs >= since) {
            rows.push({ path: full, name: dirent.name, extension: path.extname(dirent.name).toLowerCase(), size: stat.size, modifiedAt: stat.mtimeMs, lastUsedAt: stat.mtimeMs, kind: 'file' })
          }
        } catch {
          // Vanished or unreadable.
        }
      }
    }

    for (const folder of ['Desktop', 'Documents', 'Downloads', 'Pictures']) {
      await visit(path.join(home, folder), 1)
    }

    return rows
  }

  /** GNOME's shared thumbnail cache (`~/.cache/thumbnails/<bucket>/<md5 of file URI>.png`), else raw small images. */
  async thumbnail(filePath: string, _size: number): Promise<Buffer | null> {
    let stat: import('node:fs').Stats

    try {
      stat = await fs.stat(filePath)
    } catch {
      return null
    }

    if (!stat.isFile()) {
      return null
    }

    const cacheRoot = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'thumbnails')
    const hash = crypto.createHash('md5').update(fileUri(filePath)).digest('hex')

    for (const bucket of THUMBNAIL_BUCKETS) {
      const png = await fs.readFile(path.join(cacheRoot, bucket, `${hash}.png`)).catch(() => null)

      if (png) {
        return png
      }
    }

    if (RAW_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) && stat.size <= RAW_IMAGE_LIMIT) {
      return fs.readFile(filePath).catch(() => null)
    }

    return null
  }

  controlStatus(panel: StatusPanelId): Promise<StatusPanelState> {
    return linuxControlStatus(panel, () => this.sampleStats())
  }

  controlAction(action: ControlAction): Promise<void> {
    return linuxControlAction(action)
  }

  systemSpeech(text: string, locale: string): Promise<SystemSpeech> {
    return renderSystemSpeech(text, linuxSpeech(locale))
  }
}
