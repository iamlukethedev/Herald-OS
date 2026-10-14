import { useStore } from '@nanostores/react'
import { IconBellRinging, IconBug, IconChecklist, IconDeviceDesktop, IconShieldCheck, IconVolumeOff, IconX } from '@tabler/icons-react'
import { useState } from 'react'
import { Toggle } from '../../../components/ui/glass.tsx'
import { $prefs } from '../../../store/backend.ts'
import { setCrashHelpEnabled, setCrashMuted } from '../../../store/crashes.ts'
import { useT } from '../../../store/i18n.ts'
import { errorText, InlineNote, markSaved, readLocalFlag, SectionTitle, SettingsGroup, SettingsRow, writeLocal } from './shared.tsx'

/*
 * Notification preferences are shell-side flags in localStorage (`herald-os.notify.*`). The
 * notification store does not read them yet; see the page report for the proposed wiring.
 */

export const NOTIFY_KEYS = {
  toolCompletions: 'herald-os.notify.tool-completions',
  approvals: 'herald-os.notify.approvals',
  taskUpdates: 'herald-os.notify.task-updates',
  nativeWhenUnfocused: 'herald-os.notify.native-unfocused'
} as const

type NotifyKey = keyof typeof NOTIFY_KEYS

const ROWS: { key: NotifyKey; label: string; description: string; icon: React.ReactNode; keywords?: string }[] = [
  { key: 'toolCompletions', label: 'Tool completions', description: 'A toast when a long-running tool finishes in a session you are not looking at.', icon: <IconChecklist />, keywords: 'toast finished' },
  { key: 'approvals', label: 'Approvals', description: 'Tell me when Hermes is waiting for a decision.', icon: <IconShieldCheck />, keywords: 'permission request waiting' },
  { key: 'taskUpdates', label: 'Task updates', description: 'Scheduled tasks that ran, failed or changed.', icon: <IconBellRinging />, keywords: 'cron automations' },
  { key: 'nativeWhenUnfocused', label: 'Native notifications when unfocused', description: 'Use system notifications while Herald OS is in the background.', icon: <IconDeviceDesktop />, keywords: 'macos system background' }
]

export function NotificationsSection() {
  const t = useT()
  const [flags, setFlags] = useState<Record<NotifyKey, boolean>>(() => ({
    toolCompletions: readLocalFlag(NOTIFY_KEYS.toolCompletions, true),
    approvals: readLocalFlag(NOTIFY_KEYS.approvals, true),
    taskUpdates: readLocalFlag(NOTIFY_KEYS.taskUpdates, true),
    nativeWhenUnfocused: readLocalFlag(NOTIFY_KEYS.nativeWhenUnfocused, true)
  }))

  const set = (key: NotifyKey, value: boolean) => {
    setFlags(prev => ({ ...prev, [key]: value }))
    writeLocal(NOTIFY_KEYS[key], String(value))
    markSaved()
  }

  return (
    <>
      <SectionTitle title={t('settings.section.notifications')} subtitle={t('settings.notifications.subtitle')} />

      <SettingsGroup title="Alerts">
        {ROWS.map(row => (
          <SettingsRow key={row.key} icon={row.icon} label={row.label} description={row.description} keywords={row.keywords}>
            <Toggle checked={flags[row.key]} onChange={next => set(row.key, next)} label={row.label} />
          </SettingsRow>
        ))}
      </SettingsGroup>

      <CrashHelpGroup />
    </>
  )
}

function CrashHelpGroup() {
  const { enabled, muted } = useStore($prefs).crashHelp
  const [error, setError] = useState<string | null>(null)

  const save = (work: Promise<unknown>) =>
    work.then(
      () => {
        setError(null)
        markSaved()
      },
      reason => setError(errorText(reason))
    )

  return (
    <SettingsGroup title="Crash help">
      <SettingsRow
        icon={<IconBug />}
        label="Offer to explain crashes"
        description="When a program crashes, a notification offers to have Hermes read the crash report and say what went wrong. Nothing is sent until you ask."
        keywords="crash report core dump diagnose"
        below={error ? <InlineNote tone="danger">{error}</InlineNote> : undefined}
      >
        <Toggle checked={enabled} onChange={next => save(setCrashHelpEnabled(next))} label="Offer to explain crashes" />
      </SettingsRow>
      <SettingsRow
        icon={<IconVolumeOff />}
        label="Muted programs"
        description={muted.length === 0 ? 'Mute a program from its crash notification to stop hearing about it.' : 'Crashes from these programs stay quiet.'}
        keywords="mute crash quiet"
        below={
          muted.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {muted.map(app => (
                <span key={app} className="inline-flex h-7 items-center gap-1 rounded-full border border-line bg-white/6 pr-1 pl-2.5 text-[12px] text-fg-2">
                  {app}
                  <button type="button" aria-label={`Unmute ${app}`} onClick={() => save(setCrashMuted(app, false))} className="flex size-5 items-center justify-center rounded-full text-fg-3 hover:bg-white/10 hover:text-fg">
                    <IconX size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : undefined
        }
      />
    </SettingsGroup>
  )
}
