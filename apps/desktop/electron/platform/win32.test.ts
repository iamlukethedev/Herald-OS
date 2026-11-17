import { shell } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { run } from './exec.ts'
import { parseWindowsHardware, parseWindowsNetwork, parseWindowsProcesses, walkWindowsFiles, WindowsPlatform, WINDOWS_QUERIES } from './win32.ts'

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() } }))
vi.mock('./exec.ts', () => ({ run: vi.fn() }))
const roots: string[] = []
async function temporary() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'herald-win32-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.mocked(run).mockReset()
  vi.mocked(shell.openPath).mockClear()
  vi.mocked(shell.showItemInFolder).mockClear()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

describe('Windows records', () => {
  it('distinguishes absent, unknown and charging batteries and validates disks', () => {
    expect(() => parseWindowsHardware(null)).toThrow('invalid record')
    expect(parseWindowsHardware({ disks: [], batteries: [] })).toEqual({ disks: [], battery: { present: false } })
    expect(parseWindowsHardware({ disks: [
      { DeviceID: 'C:', Size: '1000', FreeSpace: '400' },
      { DeviceID: 'D:', Size: 0, FreeSpace: 0 },
      { DeviceID: 'E:', Size: 10, FreeSpace: 20 }
    ], batteries: [{ EstimatedChargeRemaining: 76, BatteryStatus: 2 }] })).toEqual({ disks: [{ mount: 'C:\\', total: 1000, free: 400, used: 600 }], battery: { present: true, percent: 76 } })
    expect(parseWindowsHardware({ disks: [], batteries: [{ EstimatedChargeRemaining: 50, BatteryStatus: 6 }] }).battery.charging).toBe(true)
    expect(parseWindowsHardware({ disks: [], batteries: [{ EstimatedChargeRemaining: 101, BatteryStatus: 1 }] }).battery).toEqual({ present: true, charging: false })
  })

  it('does not invent CPU data for disappeared process samples', () => {
    expect(parseWindowsProcesses([
      { pid: 0, ppid: 0, name: 'Idle', rss: 0, cpu: 999 },
      { pid: 8, ppid: 4, name: 'hello.exe', rss: '250', cpu: '120' },
      { pid: 9, ppid: 4, name: 'gone.exe', rss: 10, cpu: null }
    ], 1000, 4)).toEqual([{ pid: 8, ppid: 4, name: 'hello.exe', command: 'hello.exe', user: '', rssBytes: 250, cpuPercent: 30, memPercent: 25 }])
  })

  it('requires an actual noninternal interface and a default gateway', () => {
    const interfaces = { Ethernet: [{ address: '10.0.0.2', netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: '10.0.0.2/24' }] }
    expect(parseWindowsNetwork([{ IPAddress: ['10.0.0.2'], DefaultIPGateway: [] }], interfaces)).toEqual({ online: false })
    expect(parseWindowsNetwork([{ IPAddress: ['10.0.0.2'], DefaultIPGateway: ['10.0.0.1'] }], interfaces)).toEqual({ online: true, defaultInterface: 'Ethernet', ipv4: '10.0.0.2' })
  })
})

describe('Windows adapter', () => {
  it('uses only the native PowerShell module directory for diagnostics', () => {
    for (const command of Object.values(WINDOWS_QUERIES)) {
      expect(command).toContain("$env:PSModulePath = $PSHOME + '\\Modules';")
    }
  })

  it('shares a slow process query across callers and caches only after it completes', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let resolve!: (value: Awaited<ReturnType<typeof run>>) => void
    vi.mocked(run).mockReturnValueOnce(new Promise(done => { resolve = done }))
    vi.mocked(run).mockResolvedValue({ code: 0, stdout: '[]', stderr: '' })
    const platform = new WindowsPlatform()
    const cpu = platform.listProcesses('cpu', 1)
    now += 5000
    const memory = platform.listProcesses('memory', 2)
    const singleFlightCalls = vi.mocked(run).mock.calls.length
    resolve({ code: 0, stdout: JSON.stringify([
      { pid: 1, ppid: 0, name: 'cpu.exe', rss: 10, cpu: 90 },
      { pid: 2, ppid: 0, name: 'memory.exe', rss: 90, cpu: 10 }
    ]), stderr: '' })
    const results = await Promise.all([cpu, memory])
    expect(singleFlightCalls).toBe(1)
    expect(results.map(rows => rows.map(row => row.pid))).toEqual([[1], [2, 1]])
    now += 1999
    expect((await platform.listProcesses('cpu')).map(row => row.pid)).toEqual([1, 2])
    expect(run).toHaveBeenCalledTimes(1)
    now += 1
    await expect(platform.listProcesses()).resolves.toEqual([])
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('clears a failed shared query so the next process query can recover', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.mocked(run).mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'private diagnostic' })
      .mockResolvedValue({ code: 0, stdout: '[]', stderr: '' })
    const platform = new WindowsPlatform()
    const results = await Promise.allSettled([platform.listProcesses(), platform.listProcesses('memory')])
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect(run).toHaveBeenCalledTimes(1)
    await expect(platform.listProcesses()).resolves.toEqual([])
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('uses the bounded constant command and fails on failed or malformed replies', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.mocked(run).mockResolvedValueOnce({ code: 0, stdout: '[]', stderr: '' })
    await expect(new WindowsPlatform().listProcesses('memory', 3)).resolves.toEqual([])
    expect(run).toHaveBeenLastCalledWith('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERIES.processes], 20_000)
    vi.mocked(run).mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'must not leak' })
    await expect(new WindowsPlatform().listProcesses()).rejects.toThrow('Windows processes query failed (exit 1)')
    for (const stdout of ['broken', 'null', '42']) {
      vi.mocked(run).mockResolvedValueOnce({ code: 0, stdout, stderr: '' })
      await expect(new WindowsPlatform().listProcesses()).rejects.toThrow('invalid JSON')
    }
    vi.stubEnv('SystemRoot', undefined)
    await expect(new WindowsPlatform().listProcesses()).rejects.toThrow('Windows PowerShell 5.1')
    expect(run).toHaveBeenCalledTimes(5)
  })

  it('shares the hardware query and uses Node counters for CPU and memory', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.mocked(run).mockResolvedValue({ code: 0, stdout: '{"disks":[],"batteries":[]}', stderr: '' })
    const cpu = (idle: number, user: number) => [{ model: 'test', speed: 1, times: { idle, user, nice: 0, sys: 0, irq: 0 } }]
    vi.spyOn(os, 'cpus').mockReturnValueOnce(cpu(100, 100)).mockReturnValueOnce(cpu(150, 150))
    vi.spyOn(os, 'totalmem').mockReturnValue(1000)
    vi.spyOn(os, 'freemem').mockReturnValue(400)
    const platform = new WindowsPlatform()
    expect((await platform.sampleStats()).cpuPercent).toBe(0)
    expect(await platform.sampleStats()).toMatchObject({ cpuPercent: 50, memoryTotal: 1000, memoryFree: 400, memoryUsed: 600 })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('falls back to no disks and no battery when the hardware query fails, and retries it only after a pause', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.mocked(run).mockResolvedValue({ code: 1, stdout: '', stderr: 'blocked by policy' })
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const platform = new WindowsPlatform()

    await expect(platform.sampleStats()).resolves.toMatchObject({ disks: [], battery: { present: false } })
    now.mockReturnValue(1_000_000 + 60_000)
    await expect(platform.sampleStats()).resolves.toMatchObject({ disks: [] })
    expect(run).toHaveBeenCalledTimes(1)

    now.mockReturnValue(1_000_000 + 5 * 60_000)
    vi.mocked(run).mockResolvedValue({ code: 0, stdout: '{"disks":[{"DeviceID":"C:","Size":100,"FreeSpace":40}],"batteries":[]}', stderr: '' })
    await expect(platform.sampleStats()).resolves.toMatchObject({ disks: [{ mount: 'C:\\', total: 100, free: 40 }] })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('treats a malformed hardware record like a failed query', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.mocked(run).mockResolvedValue({ code: 0, stdout: '{"disks":null,"batteries":[]}', stderr: '' })
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
    const platform = new WindowsPlatform()

    await expect(platform.sampleStats()).resolves.toMatchObject({ disks: [], battery: { present: false } })
    now.mockReturnValue(2_000_000 + 60_000)
    await platform.sampleStats()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('keeps unsupported capabilities unavailable and reveals only literal full paths', async () => {
    const platform = new WindowsPlatform()
    await expect(platform.calendarToday()).resolves.toEqual({ status: 'unavailable', events: [] })
    await expect(platform.thumbnail()).resolves.toBeNull()
    await expect(platform.controlStatus()).rejects.toThrow('quick panels')
    await expect(platform.openIn('editor', 'C:\\notes.txt')).rejects.toThrow('openIn(editor)')
    await platform.openIn('finder', "C:\\a & 'b.txt")
    expect(shell.showItemInFolder).toHaveBeenCalledWith("C:\\a & 'b.txt")
    for (const invalid of ['relative.txt', '\\root-relative', '\\\\.\\pipe\\name', '\\\\?\\C:\\file']) {
      await expect(platform.revealPath(invalid)).rejects.toThrow('absolute file path')
    }
    expect(run).not.toHaveBeenCalled()
  })

  it.each([String.raw`\\server\share\file.txt`, '//server/share/file.txt', String.raw`\\?\UNC\server\share\file.txt`, String.raw`\\.\pipe\name`, String.raw`\??\C:\file.txt`])('refuses network/device reveal before invoking the shell: %s', async target => {
    const platform = new WindowsPlatform()
    await expect(platform.revealPath(target)).rejects.toThrow('absolute file path')
    await expect(platform.openIn('finder', target)).rejects.toThrow('absolute file path')
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
    expect(shell.openPath).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
})

describe('private metadata fixtures', () => {
  it('searches literal filenames and excludes hidden/configuration folders', async () => {
    const root = await temporary()
    await fs.writeFile(path.join(root, "a & 'report.txt"), 'fixture')
    for (const name of ['AppData', '.hermes', 'node_modules']) {
      await fs.mkdir(path.join(root, name))
      await fs.writeFile(path.join(root, name, 'report.txt'), 'excluded')
    }
    vi.spyOn(os, 'homedir').mockReturnValue(root)
    expect((await new WindowsPlatform().findFiles("a & 'report", 5)).map(file => file.path)).toEqual([path.join(root, "a & 'report.txt")])
    expect((await walkWindowsFiles([root], 'files')).map(file => file.name)).toEqual(["a & 'report.txt"])
  })
})

describe.skipIf(process.platform !== 'win32')('Windows Start menu', () => {
  it('opens only a listed shortcut via mocked Electron', async () => {
    const root = await temporary()
    vi.stubEnv('APPDATA', root)
    vi.stubEnv('ProgramData', root)
    const menu = path.join(root, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    await fs.mkdir(menu, { recursive: true })
    const shortcut = path.join(menu, "Editor & 'Test.lnk")
    await fs.writeFile(shortcut, 'fake shortcut: Electron is mocked')
    await fs.writeFile(path.join(menu, 'ignored.ps1'), 'not executed')
    const platform = new WindowsPlatform()
    expect(await platform.listInstalledApps()).toEqual([{ name: "Editor & 'Test", path: shortcut }])
    await platform.launchApp(shortcut)
    expect(shell.openPath).toHaveBeenCalledWith(shortcut)
    await expect(platform.launchApp(path.join(root, 'outside.exe'))).rejects.toThrow('not in the Windows Start menu')
    expect(shell.openPath).toHaveBeenCalledTimes(1)
  })
})
