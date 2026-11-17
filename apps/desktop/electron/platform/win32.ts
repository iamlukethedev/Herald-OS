import { shell } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BatteryStatus, DiskUsage, InstalledApp, NetworkStatus, ProcessInfo, RecentFile, SystemInfo, SystemStats } from '../../shared/ipc.ts'
import { run } from './exec.ts'
import { rankFiles, normaliseFileQuery } from './find.ts'
import { GenericPlatform } from './generic.ts'
import { type EditorTarget, HostNotSupported } from './types.ts'

const PREFIX = "$ErrorActionPreference = 'Stop'; $env:PSModulePath = $PSHOME + '\\Modules'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
export const WINDOWS_QUERIES = {
  hardware: PREFIX + "[PSCustomObject]@{ disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType = 3' | Select-Object DeviceID,Size,FreeSpace); batteries = @(Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus) } | ConvertTo-Json -Compress -Depth 4",
  processes: PREFIX + "$cpu = @{}; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { $cpu[[int]$_.IDProcess] = $_.PercentProcessorTime }; @(Get-CimInstance Win32_Process | Select-Object -First 4096 | ForEach-Object { [PSCustomObject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; rss = $_.WorkingSetSize; cpu = $cpu[[int]$_.ProcessId] } }) | ConvertTo-Json -Compress -Depth 3",
  network: PREFIX + "@(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled = TRUE' | Select-Object -First 256 Description,IPAddress,DefaultIPGateway) | ConvertTo-Json -Compress -Depth 4"
} as const

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const rows = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value : value == null ? [] : [value]).map(object)
const number = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}
const strings = (value: unknown): string[] => (Array.isArray(value) ? value : value == null ? [] : [value]).filter((item): item is string => typeof item === 'string')
const cap = (value: number, maximum: number): number => Math.max(1, Math.min(maximum, Number.isFinite(value) ? Math.trunc(value) : maximum))

async function queryWindows(kind: keyof typeof WINDOWS_QUERIES): Promise<unknown> {
  const root = process.env.SystemRoot
  if (!root || !/^[A-Za-z]:[\\/]/.test(root)) throw new HostNotSupported('Windows diagnostics', 'Windows PowerShell 5.1')
  // Performance counters can take several seconds to initialize or contend with another CIM reader.
  const result = await run(path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERIES[kind]], kind === 'processes' ? 20_000 : 8000)
  if (result.code !== 0) throw new Error(`Windows ${kind} query failed (exit ${result.code})`)
  const text = result.stdout.replace(/^\uFEFF/, '').trim()
  if (!text && kind !== 'hardware') return []
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
    return parsed
  } catch { throw new Error(`Windows ${kind} returned invalid JSON`) }
}

export function parseWindowsHardware(value: unknown): { disks: DiskUsage[]; battery: BatteryStatus } {
  const data = object(value)
  if (!Array.isArray(data.disks) || !Array.isArray(data.batteries)) throw new Error('Windows hardware returned an invalid record')
  const disks: DiskUsage[] = []
  for (const row of rows(data.disks)) {
    const total = number(row.Size), free = number(row.FreeSpace)
    if (typeof row.DeviceID !== 'string' || !/^[A-Za-z]:$/.test(row.DeviceID) || total === undefined || total === 0 || free === undefined || free > total) continue
    disks.push({ mount: row.DeviceID + '\\', total, free, used: total - free })
  }
  const batteries = rows(data.batteries)
  const percents = batteries.map(row => number(row.EstimatedChargeRemaining)).filter((percent): percent is number => percent !== undefined && percent <= 100)
  const states = batteries.map(row => number(row.BatteryStatus))
  return { disks, battery: {
    present: batteries.length > 0,
    ...(percents.length ? { percent: Math.round(percents.reduce((a, b) => a + b, 0) / percents.length) } : {}),
    ...(states.some(state => state !== undefined && [6, 7, 8, 9].includes(state)) ? { charging: true } : states.length && states.every(state => state !== undefined && [1, 3, 4, 5].includes(state)) ? { charging: false } : {})
  } }
}

export function parseWindowsProcesses(value: unknown, totalMemory: number, cpuCount: number): ProcessInfo[] {
  return rows(value).flatMap(row => {
    const pid = number(row.pid), ppid = number(row.ppid), rss = number(row.rss), cpu = number(row.cpu)
    // A process can disappear between the independent CIM samples. Do not invent a CPU value.
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0 || ppid === undefined || !Number.isSafeInteger(ppid) || rss === undefined || cpu === undefined || typeof row.name !== 'string' || !row.name) return []
    return [{ pid, ppid, name: row.name, command: row.name, user: '', rssBytes: rss,
      cpuPercent: Math.min(100, cpu / Math.max(1, cpuCount)),
      memPercent: totalMemory > 0 ? Math.min(100, 100 * rss / totalMemory) : 0 }]
  })
}

export function parseWindowsNetwork(value: unknown, interfaces: ReturnType<typeof os.networkInterfaces>): NetworkStatus {
  // Reports a local addressed interface with a gateway, not an Internet reachability probe.
  for (const row of rows(value)) {
    if (!strings(row.DefaultIPGateway).some(address => address && address !== '0.0.0.0' && address !== '::')) continue
    const addresses = strings(row.IPAddress).filter(address => address !== '::1' && !address.startsWith('127.') && !address.startsWith('169.254.') && !address.toLowerCase().startsWith('fe80:'))
    const matching = Object.entries(interfaces).find(([, entries]) => entries?.some(entry => !entry.internal && addresses.includes(entry.address)))
    if (!matching) continue
    const ipv4 = matching[1]?.find(entry => entry.family === 'IPv4' && !entry.internal && addresses.includes(entry.address))?.address
    return { online: true, defaultInterface: matching[0], ...(ipv4 ? { ipv4 } : {}) }
  }
  return { online: false }
}

function cpuSample(): { idle: number; total: number } {
  return os.cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 })
}

const SKIP_NAMES = new Set(['appdata', 'node_modules', 'vendor', 'dist', 'build', 'library', 'windows', 'program files', 'program files (x86)', 'venv', '__pycache__'])

/** Bounded metadata walk. No file bodies, junctions or UNC roots; deadline checked between I/O. */
export async function walkWindowsFiles(roots: readonly string[], mode: 'files' | 'shortcuts'): Promise<RecentFile[]> {
  const files: RecentFile[] = []
  const queue = roots.filter(root => process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(root)).map(root => ({ directory: path.resolve(root), depth: 0 }))
  const seen = new Set<string>()
  const deadline = Date.now() + 1500
  const maxEntries = mode === 'shortcuts' ? 4000 : 5000
  const maxDepth = mode === 'shortcuts' ? 6 : 4
  let visited = 0
  while (queue.length && visited < maxEntries && Date.now() < deadline) {
    const next = queue.shift()!
    if (seen.has(next.directory)) continue
    seen.add(next.directory)
    try {
      const root = await fs.lstat(next.directory)
      if (!root.isDirectory() || root.isSymbolicLink()) continue
      const directory = await fs.opendir(next.directory)
      for await (const entry of directory) {
        if (++visited > maxEntries || Date.now() >= deadline) return files
        if (entry.name.startsWith('.') || SKIP_NAMES.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue
        const file = path.join(next.directory, entry.name)
        let stat
        try { stat = await fs.lstat(file) } catch { continue }
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) continue
        if (stat.isDirectory() && next.depth < maxDepth) queue.push({ directory: file, depth: next.depth + 1 })
        if (mode === 'shortcuts' && (!stat.isFile() || path.extname(file).toLowerCase() !== '.lnk')) continue
        files.push({ path: file, name: entry.name, extension: stat.isDirectory() ? '' : path.extname(entry.name).slice(1).toLowerCase(), size: stat.size,
          modifiedAt: stat.mtimeMs, lastUsedAt: stat.mtimeMs, kind: stat.isDirectory() ? 'directory' : 'file' })
      }
    } catch { /* Unreadable or concurrently removed folders are not searched. */ }
  }
  return files
}

function startMenuRoots(): string[] {
  return [process.env.APPDATA, process.env.ProgramData ?? process.env.PROGRAMDATA]
    .filter((value): value is string => Boolean(value && /^[A-Za-z]:[\\/]/.test(value)))
    .map(root => path.win32.join(root, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
}

export class WindowsPlatform extends GenericPlatform {
  private previousCpu: ReturnType<typeof cpuSample> | null = null
  private hardware: { at: number; pending: Promise<ReturnType<typeof parseWindowsHardware>> } | null = null
  private processes: { expiresAt: number; pending: Promise<ProcessInfo[]> } | null = null

  override async systemInfo(): Promise<SystemInfo> {
    return { ...await super.systemInfo(), platform: 'win32', osName: 'Windows' }
  }

  override async sampleStats(): Promise<SystemStats> {
    if (!this.hardware || Date.now() - this.hardware.at >= 10_000) {
      const pending = queryWindows('hardware').then(parseWindowsHardware)
      const entry = { at: Date.now(), pending }
      this.hardware = entry
      void pending.catch(() => { if (this.hardware === entry) this.hardware = null })
    }
    const hardware = await this.hardware.pending
    const current = cpuSample(), previous = this.previousCpu
    this.previousCpu = current
    const elapsed = previous ? current.total - previous.total : 0
    const cpuPercent = previous && elapsed > 0 ? Math.max(0, Math.min(100, 100 * (1 - (current.idle - previous.idle) / elapsed))) : 0
    const total = os.totalmem(), free = os.freemem()
    return { sampledAt: Date.now(), cpuPercent, loadAverage: [0, 0, 0], memoryTotal: total, memoryUsed: total - free, memoryFree: free, uptimeSeconds: os.uptime(), ...hardware }
  }

  override async listProcesses(sort: 'cpu' | 'memory' = 'cpu', limit = 25): Promise<ProcessInfo[]> {
    if (!this.processes || Date.now() >= this.processes.expiresAt) {
      const pending = queryWindows('processes').then(value => parseWindowsProcesses(value, os.totalmem(), os.cpus().length))
      // Keep sharing a slow in-flight query; the short cache starts only after completion.
      const entry = { expiresAt: Infinity, pending }
      this.processes = entry
      void pending.then(() => { entry.expiresAt = Date.now() + 2000 }, () => { if (this.processes === entry) this.processes = null })
    }
    const processes = await this.processes.pending
    return [...processes].sort((a, b) => sort === 'memory' ? b.rssBytes - a.rssBytes || a.pid - b.pid : b.cpuPercent - a.cpuPercent || a.pid - b.pid).slice(0, cap(limit, 200))
  }

  override async networkStatus(): Promise<NetworkStatus> {
    return parseWindowsNetwork(await queryWindows('network'), os.networkInterfaces())
  }

  override async listInstalledApps(): Promise<InstalledApp[]> {
    const shortcuts = await walkWindowsFiles(startMenuRoots(), 'shortcuts')
    const seen = new Set<string>()
    return shortcuts.flatMap(file => {
      if (seen.has(file.path)) return []
      seen.add(file.path)
      return [{ name: file.name.slice(0, -4), path: file.path }]
    }).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 1000)
  }

  override async launchApp(appPath: string): Promise<void> {
    const app = (await this.listInstalledApps()).find(item => item.path === path.resolve(appPath))
    if (!app) throw new Error('The application is not in the Windows Start menu')
    const stat = await fs.lstat(app.path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The application shortcut is unavailable')
    const error = await shell.openPath(app.path)
    if (error) throw new Error(error)
  }

  override async revealPath(targetPath: string): Promise<void> {
    const normal = targetPath.replaceAll('/', '\\')
    const qualified = /^[A-Za-z]:\\/.test(normal)
    if (!qualified || /^\\\\[?.]\\/.test(normal) || normal.includes('\0')) throw new Error('An absolute file path is required')
    shell.showItemInFolder(targetPath)
  }

  override async openIn(target: EditorTarget, targetPath = ''): Promise<void> {
    if (target === 'finder') return this.revealPath(targetPath)
    throw new HostNotSupported(`openIn(${target})`)
  }

  override async recentFiles(limit = 30): Promise<RecentFile[]> {
    const files = await walkWindowsFiles([os.homedir()], 'files')
    return files.filter(file => file.kind === 'file').sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, cap(limit, 200))
  }

  override async findFiles(query = '', limit = 10): Promise<RecentFile[]> {
    const normal = normaliseFileQuery(query.slice(0, 200))
    if (!normal) return []
    return rankFiles(normal, await walkWindowsFiles([os.homedir()], 'files'), cap(limit, 50))
  }
}
