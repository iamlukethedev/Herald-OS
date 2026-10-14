import { useStore } from '@nanostores/react'
import { IconDeviceFloppy, IconHome } from '@tabler/icons-react'
import { GlassButton, ProgressBar } from '../../../components/ui/glass.tsx'
import { formatBytes } from '../../../lib/format.ts'
import { deviceNoun } from '../../../lib/platform-labels.ts'
import { useLocalData } from '../../../lib/use-async.ts'
import { $env } from '../../../store/backend.ts'
import { sendPrompt } from '../../../store/chat.ts'
import { useSystemStats } from '../../../store/system.ts'
import { showPage } from '../../../store/windows.ts'
import { useT } from '../../../store/i18n.ts'
import { SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

export function StorageSection() {
  const t = useT()
  const stats = useSystemStats()
  const env = useStore($env)
  const hermesHome = env?.hermesHome ?? null
  const homeSize = useLocalData(() => (hermesHome ? window.heraldOS.fs.dirSize(hermesHome) : Promise.resolve(null)), [hermesHome])

  const askHermes = () => {
    showPage('hermes')
    void sendPrompt("What's using all my disk space? Start from my home folder.")
  }

  return (
    <>
      <SectionTitle title={t('settings.section.storage')} subtitle={t('settings.storage.subtitle', { device: deviceNoun() })} />

      <SettingsGroup title="Disks">
        {(stats?.disks ?? []).length === 0 && <SettingsRow icon={<IconDeviceFloppy />} label="Disks" description="Reading disk usage…" keywords="volume mount" />}
        {(stats?.disks ?? []).map(disk => {
          const percent = disk.total > 0 ? (disk.used / disk.total) * 100 : 0

          return (
            <SettingsRow
              key={disk.mount}
              icon={<IconDeviceFloppy />}
              label={disk.mount === '/' ? 'Macintosh HD' : disk.mount}
              description={`${formatBytes(disk.used)} used of ${formatBytes(disk.total)} · ${formatBytes(disk.free)} free`}
              keywords="disk volume mount free used"
              below={<ProgressBar value={percent} tone={percent > 90 ? 'progress' : 'accent'} />}
            >
              <span className="text-[12px] tabular-nums text-fg-2">{Math.round(percent)}%</span>
            </SettingsRow>
          )
        })}
      </SettingsGroup>

      <SettingsGroup title="Hermes">
        <SettingsRow
          icon={<IconHome />}
          label="Hermes home"
          description={
            <span className="selectable font-mono text-[11.5px]">
              {hermesHome ?? '—'}
              {homeSize.data ? ` · ${formatBytes(homeSize.data.bytes)}${homeSize.data.complete ? '' : '+'} in ${homeSize.data.files.toLocaleString()} files` : homeSize.loading ? ' · measuring…' : ''}
            </span>
          }
          keywords="hermes home folder size sessions memories"
        >
          <GlassButton size="sm" onClick={askHermes} aria-label="Ask Hermes what is using space">
            Ask Hermes what is using space
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}
