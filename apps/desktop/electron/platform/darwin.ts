import { shell } from 'electron'
import crypto from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BatteryStatus, CalendarEvent, CalendarResult, ControlAction, InstalledApp, NetworkStatus, ProcessInfo, RecentFile, StatusPanelId, StatusPanelState, SystemInfo, SystemSpeech, SystemStats } from '../../shared/ipc.ts'
import { heraldOsDataDir } from '../paths.ts'
import { darwinControlAction, darwinControlStatus } from './darwin-controls.ts'
import { run } from './exec.ts'
import { normaliseFileQuery, rankFiles } from './find.ts'
import { parseDf, parsePs } from './posix.ts'
import { findCodeEditor } from './editors.ts'
import { MAC_SPEECH, renderSystemSpeech } from './system-voice.ts'
import { type EditorTarget, type HostPlatform } from './types.ts'

// The `df -kP` / `ps -o` parsers are POSIX-generic and live in posix.ts; re-exported for existing importers.
export { parseDf, parsePs } from './posix.ts'

const APP_DIRS = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', path.join(os.homedir(), 'Applications')]

interface CpuSample {
  idle: number
  total: number
}

async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++]
      await fn(item)
    }
  })
  await Promise.all(workers)
}

async function readPlistKeys(plist: string, keys: string[]): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {}
  const result = await run('plutil', ['-convert', 'json', '-o', '-', plist], 5000)

  if (result.code === 0) {
    try {
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>

      for (const key of keys) {
        out[key] = typeof parsed[key] === 'string' ? (parsed[key] as string) : undefined
      }
    } catch {
      // Malformed plist: leave undefined.
    }
  }

  return out
}

/** How long the calendar script waits for an answer to the permission prompt. */
const CALENDAR_PROMPT_MS = 60_000

/** Runs inside `osascript -l JavaScript`; prints one JSON document. */
export const CALENDAR_JXA = String.raw`
ObjC.import('EventKit');
ObjC.import('Foundation');
function out(o){ return JSON.stringify(o); }
// JXA hands NSInteger results back as strings (macOS 26 does), so the status goes through Number().
function authStatus(){ return Number($.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent)); }
var store = $.EKEventStore.alloc.init;
var status = authStatus();
// 0 notDetermined, 1 restricted, 2 denied, 3 fullAccess (authorized), 4 writeOnly (cannot read events).
if (status === 0) {
  var done = false; var granted = false;
  var sel = store.respondsToSelector('requestFullAccessToEventsWithCompletion:');
  var handler = function(g, e){ granted = g; done = true; };
  if (sel) { store.requestFullAccessToEventsWithCompletion(handler); } else { store.requestAccessToEntityTypeCompletion($.EKEntityTypeEvent, handler); }
  var deadline = Date.now() + ${CALENDAR_PROMPT_MS};
  while (!done && Date.now() < deadline) { $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1)); }
  status = authStatus();
}
if (status === 1) { out({status:'restricted', events:[]}); }
else if (status === 2 || status === 4) { out({status:'denied', events:[]}); }
else if (status === 0) { out({status:'not-determined', events:[]}); }
else {
  var cal = $.NSCalendar.currentCalendar;
  var start = cal.startOfDayForDate($.NSDate.date);
  var end = start.dateByAddingTimeInterval(86400);
  var pred = store.predicateForEventsWithStartDateEndDateCalendars(start, end, $());
  var events = store.eventsMatchingPredicate(pred);
  var list = [];
  var n = events.count;
  for (var i = 0; i < n; i++) {
    var ev = events.objectAtIndex(i);
    var loc = ev.location; var notes = ev.notes; var url = ev.URL;
    list.push({
      id: ObjC.unwrap(ev.eventIdentifier),
      title: ObjC.unwrap(ev.title) || 'Untitled',
      start: Math.round(ev.startDate.timeIntervalSince1970 * 1000),
      end: Math.round(ev.endDate.timeIntervalSince1970 * 1000),
      allDay: !!ev.isAllDay,
      location: loc.isNil() ? undefined : ObjC.unwrap(loc),
      notes: notes.isNil() ? undefined : String(ObjC.unwrap(notes)).slice(0, 400),
      calendar: ObjC.unwrap(ev.calendar.title),
      url: url.isNil() ? undefined : ObjC.unwrap(url.absoluteString)
    });
  }
  out({status:'authorized', events:list});
}
`

function cpuSample(): CpuSample {
  let idle = 0
  let total = 0

  for (const cpu of os.cpus()) {
    idle += cpu.times.idle
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle
  }

  return { idle, total }
}

/** Parse `vm_stat` into used bytes (active + wired + compressor), which is what Activity Monitor reports as "used". */
export function parseVmStat(text: string): { pageSize: number; usedBytes: number } | null {
  const pageMatch = /page size of (\d+) bytes/.exec(text)

  if (!pageMatch) {
    return null
  }

  const pageSize = Number(pageMatch[1])
  const pages = (label: string): number => {
    const match = new RegExp(`${label}:\\s+(\\d+)`).exec(text)

    return match ? Number(match[1]) : 0
  }
  const used = pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')

  return { pageSize, usedBytes: used * pageSize }
}

/** Parse `pmset -g batt`. */
export function parsePmset(text: string): BatteryStatus {
  const match = /(\d+)%;\s*([a-zA-Z ]+?);/.exec(text)

  if (!match) {
    return { present: false }
  }

  const state = match[2].trim().toLowerCase()

  return { present: true, percent: Number(match[1]), charging: state === 'charging' || state === 'charged' }
}

/** The Wi-Fi device (`en0` on most Macs) from `networksetup -listallhardwareports`. */
export function parseWifiDevice(ports: string): string | undefined {
  return /Hardware Port: Wi-Fi\s*\nDevice:\s*(\S+)/.exec(ports)?.[1]
}

/** Parse `ipconfig getsummary <device>`. macOS shows `<redacted>` as the SSID to apps without location access. */
export function parseWifiSummary(summary: string, device: string): NonNullable<NetworkStatus['wifi']> {
  const ssid = /^\s*SSID : (.+)$/m.exec(summary)?.[1]?.trim()

  return { connected: /LinkStatusActive : TRUE/.test(summary), ssid: ssid && !ssid.includes('redacted') ? ssid : undefined, interface: device }
}

export class DarwinPlatform implements HostPlatform {
  private previousCpu = cpuSample()
  private appsCache: { at: number; apps: InstalledApp[] } | null = null

  async systemInfo(): Promise<SystemInfo> {
    const [name, version, fullName] = await Promise.all([run('sw_vers', ['-productName']), run('sw_vers', ['-productVersion']), run('id', ['-F'])])
    const cpus = os.cpus()

    return {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      osName: name.stdout.trim() || 'macOS',
      osVersion: version.stdout.trim(),
      cpuModel: cpus[0]?.model ?? 'Apple Silicon',
      cpuCount: cpus.length,
      totalMemory: os.totalmem(),
      userName: os.userInfo().username,
      fullName: fullName.stdout.trim() || undefined,
      homeDir: os.homedir()
    }
  }

  async sampleStats(): Promise<SystemStats> {
    const current = cpuSample()
    const idleDelta = current.idle - this.previousCpu.idle
    const totalDelta = current.total - this.previousCpu.total
    this.previousCpu = current
    const cpuPercent = totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0

    const [vm, df, batt] = await Promise.all([run('vm_stat', []), run('df', ['-kP']), run('pmset', ['-g', 'batt'])])
    const memoryTotal = os.totalmem()
    const parsedVm = parseVmStat(vm.stdout)
    const memoryUsed = parsedVm ? Math.min(memoryTotal, parsedVm.usedBytes) : memoryTotal - os.freemem()

    return {
      sampledAt: Date.now(),
      cpuPercent,
      loadAverage: os.loadavg() as [number, number, number],
      memoryTotal,
      memoryUsed,
      memoryFree: memoryTotal - memoryUsed,
      uptimeSeconds: os.uptime(),
      disks: parseDf(df.stdout),
      battery: parsePmset(batt.stdout)
    }
  }

  async listProcesses(sort: 'cpu' | 'memory', limit: number): Promise<ProcessInfo[]> {
    const result = await run('ps', ['-Axo', 'pid=,ppid=,user=,%cpu=,%mem=,rss=,comm='])
    const rows = parsePs(result.stdout)
    rows.sort((a, b) => (sort === 'cpu' ? b.cpuPercent - a.cpuPercent : b.rssBytes - a.rssBytes))

    return rows.slice(0, limit)
  }

  async listInstalledApps(): Promise<InstalledApp[]> {
    if (this.appsCache && Date.now() - this.appsCache.at < 60_000) {
      return this.appsCache.apps
    }

    const found = new Map<string, InstalledApp>()

    for (const dir of APP_DIRS) {
      let entries: string[] = []

      try {
        entries = await fs.readdir(dir)
      } catch {
        continue
      }

      for (const entry of entries) {
        if (!entry.endsWith('.app') || entry.startsWith('.')) {
          continue
        }

        const appPath = path.join(dir, entry)
        const name = entry.slice(0, -4)

        if (!found.has(name)) {
          found.set(name, { name, path: appPath })
        }
      }
    }

    const apps = [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
    // Categories come from Info.plist; read them in a bounded pool so a cold start stays quick.
    await mapPool(apps, 8, async app => {
      const info = await readPlistKeys(path.join(app.path, 'Contents', 'Info.plist'), ['CFBundleIdentifier', 'LSApplicationCategoryType'])
      app.bundleId = info.CFBundleIdentifier
      app.category = info.LSApplicationCategoryType
    })
    this.appsCache = { at: Date.now(), apps }

    return apps
  }

  async networkStatus(): Promise<NetworkStatus> {
    const route = await run('route', ['-n', 'get', 'default'], 4000)
    const iface = /interface:\s*(\S+)/.exec(route.stdout)?.[1]
    const ipv4 = iface ? (await run('ipconfig', ['getifaddr', iface], 4000)).stdout.trim() || undefined : undefined
    // Not system_profiler SPAirPortDataType: it scans for nearby networks on every call, which takes
    // seconds and disturbs the Wi-Fi link each time the menu bar refreshes.
    const device = parseWifiDevice((await run('networksetup', ['-listallhardwareports'], 4000)).stdout)
    const wifi = device ? parseWifiSummary((await run('ipconfig', ['getsummary', device], 4000)).stdout, device) : undefined

    return { online: Boolean(iface), defaultInterface: iface, ipv4, wifi }
  }

  /**
   * EventKit through JXA: no compile step, prompts for Calendar access on first use, and reports the
   * authorization state honestly so the UI can show "Grant access" instead of an empty day.
   */
  async calendarToday(): Promise<CalendarResult> {
    const result = await run('osascript', ['-l', 'JavaScript', '-e', CALENDAR_JXA], CALENDAR_PROMPT_MS + 25_000)

    if (result.code !== 0) {
      return { status: 'unavailable', events: [], error: result.stderr.trim() || 'osascript failed' }
    }

    try {
      const parsed = JSON.parse(result.stdout.trim()) as { status: CalendarResult['status']; events?: CalendarEvent[]; error?: string }

      return { status: parsed.status, events: (parsed.events ?? []).sort((a, b) => a.start - b.start), error: parsed.error }
    } catch (error) {
      return { status: 'unavailable', events: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  async recentFiles(limit: number): Promise<RecentFile[]> {
    const home = os.homedir()
    const scopes = ['Desktop', 'Documents', 'Downloads', 'Projects', 'Apps', 'Developer'].map(d => path.join(home, d)).filter(d => fsSync.existsSync(d))
    const query = 'kMDItemLastUsedDate >= $time.today(-14) && kMDItemContentTypeTree != "public.folder" && kMDItemFSName != ".DS_Store"'
    const result = await run('mdfind', [...scopes.flatMap(s => ['-onlyin', s]), query], 15_000)
    const paths = result.stdout.split('\n').filter(Boolean).slice(0, 400)
    const rows: RecentFile[] = []

    await mapPool(paths, 16, async file => {
      try {
        const stat = await fs.stat(file)
        const used = await run('mdls', ['-name', 'kMDItemLastUsedDate', '-raw', file], 4000)
        const usedAt = Date.parse(used.stdout.trim().replace(' +0000', 'Z').replace(' ', 'T')) || stat.atimeMs
        rows.push({ path: file, name: path.basename(file), extension: path.extname(file).toLowerCase(), size: stat.size, modifiedAt: stat.mtimeMs, lastUsedAt: usedAt, kind: stat.isDirectory() ? 'directory' : 'file' })
      } catch {
        // Vanished between mdfind and stat.
      }
    })
    rows.sort((a, b) => b.lastUsedAt - a.lastUsedAt)

    return rows.slice(0, limit)
  }

  async findFiles(query: string, limit: number): Promise<RecentFile[]> {
    const name = normaliseFileQuery(query)

    if (!name) {
      return []
    }

    // Spotlight's filename index: substring match on the name, case-insensitive, home folder only.
    const result = await run('mdfind', ['-onlyin', os.homedir(), '-name', name], 10_000)
    const paths = result.stdout.split('\n').filter(Boolean).slice(0, 300)
    const rows: RecentFile[] = []

    await mapPool(paths, 16, async file => {
      try {
        const stat = await fs.stat(file)
        rows.push({ path: file, name: path.basename(file), extension: path.extname(file).toLowerCase(), size: stat.size, modifiedAt: stat.mtimeMs, lastUsedAt: stat.atimeMs, kind: stat.isDirectory() ? 'directory' : 'file' })
      } catch {
        // Vanished between mdfind and stat.
      }
    })

    return rankFiles(name, rows, limit)
  }

  async thumbnail(filePath: string, size: number): Promise<Buffer | null> {
    const cacheDir = path.join(heraldOsDataDir(), 'cache', 'thumbs')
    let stamp = ''

    try {
      stamp = String((await fs.stat(filePath)).mtimeMs)
    } catch {
      return null
    }

    const cacheFile = path.join(cacheDir, `${crypto.createHash('sha1').update(`${filePath}|${stamp}|${size}`).digest('hex')}.png`)

    try {
      return await fs.readFile(cacheFile)
    } catch {
      // Not cached.
    }

    await fs.mkdir(cacheDir, { recursive: true })
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'herald-os-thumb-'))

    try {
      const ql = await run('qlmanage', ['-t', '-s', String(size), '-o', tmpDir, filePath], 20_000)

      if (ql.code !== 0) {
        return null
      }

      const produced = (await fs.readdir(tmpDir)).find(n => n.endsWith('.png'))

      if (!produced) {
        return null
      }

      await fs.copyFile(path.join(tmpDir, produced), cacheFile)

      return fs.readFile(cacheFile)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  }

  /**
   * `app.getFileIcon` traps Electron 40 on macOS 26, so icons come from the bundle itself:
   * `CFBundleIconFile` -> `sips` renders the .icns to PNG; bundles that only ship an asset
   * catalog fall back to a QuickLook thumbnail (`qlmanage`).
   */
  async appIcon(appPath: string): Promise<Buffer | null> {
    const cacheDir = path.join(heraldOsDataDir(), 'cache', 'icons')
    const cacheFile = path.join(cacheDir, `${crypto.createHash('sha1').update(appPath).digest('hex')}.png`)

    try {
      return await fs.readFile(cacheFile)
    } catch {
      // Not cached yet.
    }

    await fs.mkdir(cacheDir, { recursive: true })
    const plist = await run('plutil', ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')])
    const iconName = plist.code === 0 ? plist.stdout.trim() : ''

    if (iconName) {
      const icns = path.join(appPath, 'Contents', 'Resources', iconName.endsWith('.icns') ? iconName : `${iconName}.icns`)
      const sips = await run('sips', ['-s', 'format', 'png', '-Z', '256', icns, '--out', cacheFile], 10_000)

      if (sips.code === 0) {
        return fs.readFile(cacheFile).catch(() => null)
      }
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'herald-os-icon-'))

    try {
      const ql = await run('qlmanage', ['-t', '-s', '256', '-o', tmpDir, appPath], 15_000)

      if (ql.code !== 0) {
        return null
      }

      const produced = (await fs.readdir(tmpDir)).find(name => name.endsWith('.png'))

      if (!produced) {
        return null
      }

      await fs.copyFile(path.join(tmpDir, produced), cacheFile)

      return fs.readFile(cacheFile)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  }

  async launchApp(appPath: string): Promise<void> {
    const error = await shell.openPath(appPath)

    if (error) {
      throw new Error(error)
    }
  }

  async revealPath(targetPath: string): Promise<void> {
    shell.showItemInFolder(targetPath)
  }

  async openIn(target: EditorTarget, targetPath: string): Promise<void> {
    const table: Record<Exclude<EditorTarget, 'editor'>, string[]> = {
      finder: ['-R', targetPath],
      terminal: ['-a', 'Terminal', targetPath]
    }
    const args = target === 'editor' ? ['-a', findCodeEditor(await this.listInstalledApps()).path, targetPath] : table[target]
    const result = await run('open', args)

    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `open failed with code ${result.code}`)
    }
  }

  controlStatus(panel: StatusPanelId): Promise<StatusPanelState> {
    return darwinControlStatus(
      panel,
      () => this.sampleStats(),
      () => this.networkStatus()
    )
  }

  controlAction(action: ControlAction): Promise<void> {
    return darwinControlAction(action)
  }

  /** `say` speaks in the system voice the person chose, which already follows their language. */
  systemSpeech(text: string): Promise<SystemSpeech> {
    return renderSystemSpeech(text, MAC_SPEECH)
  }
}
