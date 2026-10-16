import { shell } from 'electron'
import os from 'node:os'
import type { CalendarResult, InstalledApp, NetworkStatus, ProcessInfo, RecentFile, StatusPanelState, SystemInfo, SystemSpeech, SystemStats } from '../../shared/ipc.ts'
import { type EditorTarget, type HostPlatform, HostNotSupported } from './types.ts'

/**
 * Placeholder for win32 (and anything without a dedicated implementation): enough for the shell
 * to boot and show honest "not yet" states. Windows support is planned in docs/internal/ROADMAP.md.
 */
export class GenericPlatform implements HostPlatform {
  async systemInfo(): Promise<SystemInfo> {
    const cpus = os.cpus()

    return {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      osName: os.type(),
      osVersion: os.release(),
      cpuModel: cpus[0]?.model ?? 'unknown',
      cpuCount: cpus.length,
      totalMemory: os.totalmem(),
      userName: os.userInfo().username,
      homeDir: os.homedir()
    }
  }

  async sampleStats(): Promise<SystemStats> {
    const total = os.totalmem()
    const free = os.freemem()

    return {
      sampledAt: Date.now(),
      cpuPercent: 0,
      loadAverage: os.loadavg() as [number, number, number],
      memoryTotal: total,
      memoryUsed: total - free,
      memoryFree: free,
      uptimeSeconds: os.uptime(),
      disks: [],
      battery: { present: false }
    }
  }

  async listProcesses(): Promise<ProcessInfo[]> {
    return []
  }

  async listInstalledApps(): Promise<InstalledApp[]> {
    return []
  }

  async appIcon(): Promise<Buffer | null> {
    return null
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

  async openIn(target: EditorTarget): Promise<void> {
    throw new HostNotSupported(`openIn(${target})`)
  }

  async networkStatus(): Promise<NetworkStatus> {
    return { online: true }
  }

  async calendarToday(): Promise<CalendarResult> {
    return { status: 'unavailable', events: [] }
  }

  async recentFiles(): Promise<RecentFile[]> {
    return []
  }

  async findFiles(): Promise<RecentFile[]> {
    return []
  }

  async thumbnail(): Promise<Buffer | null> {
    return null
  }

  async controlStatus(): Promise<StatusPanelState> {
    throw new HostNotSupported('quick panels')
  }

  async controlAction(): Promise<void> {
    throw new HostNotSupported('quick panels')
  }

  async systemSpeech(): Promise<SystemSpeech> {
    return { ok: false, reason: 'missing', detail: `no system voice is known on ${process.platform}` }
  }
}
