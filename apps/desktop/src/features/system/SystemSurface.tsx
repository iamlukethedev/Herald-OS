import { useStore } from '@nanostores/react'
import { IconMessage, IconRefresh } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { ProcessInfo } from '../../../shared/ipc.ts'
import { Button } from '../../components/ui/button.tsx'
import { Meter, Stat } from '../../components/ui/primitives.tsx'
import { ErrorNote, SurfaceFrame } from '../../components/ui/surface-frame.tsx'
import { cn } from '../../lib/cn.ts'
import { formatBytes, formatDuration, formatPercent } from '../../lib/format.ts'
import { logFailure } from '../../lib/report.ts'
import { rest } from '../../lib/rest.ts'
import { useBackendData } from '../../lib/use-async.ts'
import { sendPrompt } from '../../store/chat.ts'
import { showSurface } from '../../store/surface.ts'
import { $systemInfoFailed, loadSystemInfo, useSystemInfo, useSystemStats } from '../../store/system.ts'

export function SystemSurface() {
  const stats = useSystemStats()
  const info = useSystemInfo()
  const infoFailed = useStore($systemInfoFailed)
  const [sort, setSort] = useState<'cpu' | 'memory'>('cpu')
  const [processes, setProcesses] = useState<ProcessInfo[]>([])
  const [processesFailed, setProcessesFailed] = useState(false)
  const [refreshes, setRefreshes] = useState(0)
  const hermes = useBackendData(() => rest.get<Record<string, unknown>>('/api/status'))
  const refresh = () => setRefreshes(count => count + 1)

  useEffect(() => {
    let cancelled = false
    // Polled every few seconds: a failure is logged as it starts, not each time it repeats.
    let failing = false
    const load = () =>
      window.heraldOS.system.processes(sort, 30).then(
        rows => {
          if (!cancelled) {
            failing = false
            setProcesses(rows)
            setProcessesFailed(false)
          }
        },
        (error: unknown) => {
          if (!cancelled) {
            if (!failing) {
              logFailure('system.processes')(error)
            }

            failing = true
            setProcessesFailed(true)
          }
        }
      )
    void load()
    const timer = setInterval(() => void load(), 4000)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sort, refreshes])

  const memPercent = stats ? (stats.memoryUsed / stats.memoryTotal) * 100 : 0
  const askHermes = (text: string) => {
    showSurface('chat')
    void sendPrompt(text)
  }

  return (
    <SurfaceFrame
      title="System"
      subtitle={info ? `${info.hostname} · ${info.osName} ${info.osVersion} · ${info.cpuModel}` : undefined}
      actions={
        <Button variant="ghost" size="sm" onClick={() => askHermes("What's using the most CPU and memory right now, and is anything worth stopping?")}>
          <IconMessage size={14} /> Ask Hermes
        </Button>
      }
    >
      {infoFailed && !info && (
        <div className="mb-6">
          <ErrorNote message="Could not read this computer's details." onRetry={() => void loadSystemInfo()} />
        </div>
      )}
      <div className="grid grid-cols-4 gap-8">
        <div className="flex flex-col gap-2">
          <Stat label="CPU" value={stats ? formatPercent(stats.cpuPercent) : '—'} sub={stats ? `load ${stats.loadAverage.map(v => v.toFixed(1)).join(' / ')}` : undefined} />
          <Meter value={stats?.cpuPercent ?? 0} tone={(stats?.cpuPercent ?? 0) > 85 ? 'danger' : 'accent'} />
        </div>
        <div className="flex flex-col gap-2">
          <Stat label="Memory" value={stats ? formatBytes(stats.memoryUsed, 1) : '—'} sub={stats ? `of ${formatBytes(stats.memoryTotal, 0)}` : undefined} />
          <Meter value={memPercent} tone={memPercent > 90 ? 'danger' : memPercent > 75 ? 'warn' : 'accent'} />
        </div>
        <div className="flex flex-col gap-2">
          <Stat label="Disk" value={stats?.disks[0] ? formatBytes(stats.disks[0].free, 0) : '—'} sub={stats?.disks[0] ? `free of ${formatBytes(stats.disks[0].total, 0)}` : undefined} />
          {stats?.disks[0] && <Meter value={(stats.disks[0].used / stats.disks[0].total) * 100} tone="accent" />}
        </div>
        <Stat label="Uptime" value={stats ? formatDuration(stats.uptimeSeconds) : '—'} sub={stats?.battery.present ? `battery ${stats.battery.percent}%${stats.battery.charging ? ', charging' : ''}` : undefined} />
      </div>

      {stats && stats.disks.length > 1 && (
        <div className="mt-6 flex flex-col gap-2">
          <div className="px-1 text-[11px] tracking-[0.08em] text-fg-3 uppercase">Volumes</div>
          {stats.disks.map(disk => (
            <div key={disk.mount} className="flex items-center gap-4 text-[12.5px]">
              <span className="w-48 truncate font-mono text-fg-2">{disk.mount}</span>
              <Meter value={(disk.used / disk.total) * 100} className="flex-1" />
              <span className="w-40 text-right tabular-nums text-fg-3">{formatBytes(disk.free, 0)} free of {formatBytes(disk.total, 0)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-8 flex items-center justify-between">
        <div className="px-1 text-[11px] tracking-[0.08em] text-fg-3 uppercase">Processes</div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-sm bg-surface p-0.5 hairline">
            {(['cpu', 'memory'] as const).map(key => (
              <button key={key} type="button" onClick={() => setSort(key)} className={cn('h-6 rounded-xs px-2.5 text-[12px] uppercase', sort === key ? 'bg-surface-3 text-fg' : 'text-fg-3 hover:text-fg-2')}>
                {key}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Refresh" onClick={refresh}>
            <IconRefresh size={15} />
          </Button>
        </div>
      </div>
      {processesFailed && (
        <div className="mt-2">
          <ErrorNote message="Could not list the running processes." onRetry={refresh} />
        </div>
      )}
      <table className="mt-2 w-full text-[12.5px]">
        <thead className="text-left text-[11px] text-fg-3">
          <tr>
            <th className="py-1.5 pr-3 font-medium">Process</th>
            <th className="w-16 py-1.5 pr-3 text-right font-medium">PID</th>
            <th className="w-20 py-1.5 pr-3 text-right font-medium">CPU</th>
            <th className="w-24 py-1.5 pr-3 text-right font-medium">Memory</th>
            <th className="w-28 py-1.5 font-medium">User</th>
            <th className="w-24 py-1.5" />
          </tr>
        </thead>
        <tbody>
          {processes.map(proc => (
            <tr key={proc.pid} className="group/reveal-row border-t border-hairline">
              <td className="max-w-0 truncate py-1.5 pr-3 font-mono text-fg-2" title={proc.command}>
                {proc.name}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-fg-3">{proc.pid}</td>
              <td className={cn('py-1.5 pr-3 text-right tabular-nums', proc.cpuPercent > 50 ? 'text-warn' : 'text-fg-2')}>{proc.cpuPercent.toFixed(1)}%</td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-fg-2">{formatBytes(proc.rssBytes, 0)}</td>
              <td className="truncate py-1.5 text-fg-3">{proc.user}</td>
              <td className="py-1.5 text-right">
                <button type="button" onClick={() => askHermes(`Tell me about the process "${proc.name}" (pid ${proc.pid}) that is using ${proc.cpuPercent.toFixed(0)}% CPU. Should I stop it? If I confirm, stop it.`)} className="reveal text-[11.5px] text-fg-4 hover:text-accent">
                  Ask Hermes
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {hermes.data && (
        <div className="mt-8">
          <div className="px-1 text-[11px] tracking-[0.08em] text-fg-3 uppercase">Hermes runtime</div>
          <div className="mt-2 flex flex-wrap gap-x-8 gap-y-2 text-[12.5px] text-fg-2">
            {Object.entries(hermes.data)
              .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
              .slice(0, 12)
              .map(([key, value]) => (
                <div key={key} className="flex flex-col">
                  <span className="text-[11px] text-fg-4">{key.replace(/_/g, ' ')}</span>
                  <span className="selectable tabular-nums">{String(value)}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </SurfaceFrame>
  )
}
