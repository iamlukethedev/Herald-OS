import { useStore } from '@nanostores/react'
import { IconCalendarEvent, IconClock, IconMapPin, IconRepeat, IconVideo } from '@tabler/icons-react'
import { useMemo } from 'react'
import { GlassButton, GlassCard } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { formatDate, formatSpan } from '../../lib/format.ts'
import { type CronJob, rest } from '../../lib/rest.ts'
import { deviceNoun } from '../../lib/platform-labels.ts'
import { useBackendData, useLocalData } from '../../lib/use-async.ts'
import { $language, useT } from '../../store/i18n.ts'
import { formatHourMinute, isToday, Quiet, Shimmer, toMs } from './shared.tsx'

/*
 * Today's timeline: macOS Calendar events (through the bridge, which owns the permission prompt)
 * merged with Hermes cron jobs that run today. One vertical line, one dot per entry.
 */

interface DayEntry {
  id: string
  at: number
  end?: number
  allDay?: boolean
  title: string
  detail?: string
  kind: 'event' | 'automation'
  chips: { icon: React.ReactNode; label: string }[]
}

const MEETING_APPS: [RegExp, string][] = [
  [/zoom\.us|\bzoom\b/i, 'Zoom'],
  [/meet\.google|\bgoogle meet\b|\bmeet\b/i, 'Meet'],
  [/teams\.microsoft|\bteams\b/i, 'Teams'],
  [/webex/i, 'Webex'],
  [/facetime/i, 'FaceTime'],
  [/slack\.com\/huddle|\bhuddle\b/i, 'Slack']
]

function meetingApp(text: string): string | null {
  for (const [pattern, label] of MEETING_APPS) {
    if (pattern.test(text)) {
      return label
    }
  }

  return null
}

function firstLine(text: string | undefined): string {
  return (text ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? ''
}

export function YourDay({ now }: { now: Date }) {
  const t = useT()
  const language = useStore($language)
  const calendar = useLocalData(() => window.heraldOS.calendar.today(), [])
  const jobs = useBackendData(() => rest.get<CronJob[]>('/api/cron/jobs'))
  const status = calendar.data?.status

  const entries = useMemo<DayEntry[]>(() => {
    const out: DayEntry[] = []

    for (const event of calendar.data?.events ?? []) {
      const start = toMs(event.start) ?? now.getTime()
      const end = toMs(event.end) ?? start
      const haystack = [event.location, event.url, event.notes].filter(Boolean).join(' ')
      const app = meetingApp(haystack)
      const chips: DayEntry['chips'] = []
      const span = formatSpan((end - start) / 60_000)

      if (!event.allDay && span) {
        chips.push({ icon: <IconClock size={11} />, label: span })
      }

      if (app) {
        chips.push({ icon: <IconVideo size={11} />, label: app })
      } else if (event.location) {
        chips.push({ icon: <IconMapPin size={11} />, label: firstLine(event.location) })
      }

      out.push({ id: `ev-${event.id}`, at: start, end, allDay: event.allDay, title: event.title || t('overview.day.untitledEvent'), detail: firstLine(event.notes) || (app ? firstLine(event.location) : '') || event.calendar, kind: 'event', chips })
    }

    for (const job of jobs.data ?? []) {
      const at = toMs(job.next_run_at)

      if (at === null || job.enabled === false || !isToday(at, now)) {
        continue
      }

      out.push({
        id: `cron-${job.id}`,
        at,
        title: job.name || firstLine(job.prompt) || t('overview.day.automation'),
        detail: job.name ? firstLine(job.prompt) : undefined,
        kind: 'automation',
        chips: [{ icon: <IconRepeat size={11} />, label: job.schedule_display ?? job.schedule?.display ?? t('overview.day.automation') }]
      })
    }

    return out.sort((a, b) => Number(Boolean(b.allDay)) - Number(Boolean(a.allDay)) || a.at - b.at)
  }, [calendar.data, jobs.data, now, language])

  return (
    <section className="flex flex-col gap-3" aria-label={t('overview.yourDay')}>
      <div>
        <h2 className="text-[16px] font-semibold text-fg">{t('overview.yourDay')}</h2>
        <div className="text-[12.5px] text-fg-3">{formatDate(now)}</div>
      </div>

      {calendar.loading && !calendar.data ? (
        <div className="flex flex-col gap-3 pt-1">
          <Shimmer className="h-10" />
          <Shimmer className="h-10" />
        </div>
      ) : status === 'not-determined' || status === 'denied' || status === 'restricted' ? (
        <GlassCard className="flex flex-col gap-2.5 p-3.5">
          <div className="flex items-center gap-2.5">
            <span className="icon-tile flex size-8 shrink-0 items-center justify-center rounded-lg" aria-hidden="true">
              <IconCalendarEvent size={16} />
            </span>
            <div className="text-[13px] font-medium text-fg">{t('overview.day.calendarNeeded')}</div>
          </div>
          <div className="text-[12px] text-fg-3">{status === 'not-determined' ? t('overview.day.calendarAsk') : t('overview.day.calendarDenied')}</div>
          <GlassButton size="sm" variant="primary" className="self-start" onClick={() => calendar.reload()}>
            {t('overview.day.grantAccess')}
          </GlassButton>
        </GlassCard>
      ) : status === 'unavailable' && entries.length === 0 ? (
        <Quiet>{calendar.data?.error || t('overview.day.calendarUnavailable', { device: deviceNoun() })}</Quiet>
      ) : entries.length === 0 ? (
        <Quiet>{t('overview.day.nothing')}</Quiet>
      ) : (
        <ol className="stagger relative flex flex-col" aria-label={t('overview.day.timeline')}>
          <span aria-hidden="true" className="absolute top-2 bottom-2 left-[3px] w-px bg-line" />
          {entries.map(entry => (
            <li key={entry.id} className="relative flex gap-3 py-2 pl-4">
              <span aria-hidden="true" className={cn('absolute top-[13px] left-0 size-[7px] rounded-full ring-2 ring-bg', entry.kind === 'automation' ? 'bg-progress' : 'bg-accent-strong')} />
              <div className="w-[38px] shrink-0 pt-px text-[12px] tabular-nums text-fg-2">{entry.allDay ? t('overview.day.allDay') : formatHourMinute(entry.at)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
                  {entry.kind === 'automation' && <IconRepeat size={12} className="shrink-0 text-progress" aria-label={t('overview.day.automation')} />}
                  <span className="truncate" title={entry.title}>
                    {entry.title}
                  </span>
                </div>
                {entry.detail && (
                  <div className="truncate text-[11.5px] text-fg-3" title={entry.detail}>
                    {entry.detail}
                  </div>
                )}
                {entry.chips.length > 0 && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    {entry.chips.map(chip => (
                      <span key={chip.label} className="inline-flex max-w-full items-center gap-1 text-[11px] text-fg-3">
                        <span className="shrink-0 text-fg-4">{chip.icon}</span>
                        <span className="truncate">{chip.label}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
