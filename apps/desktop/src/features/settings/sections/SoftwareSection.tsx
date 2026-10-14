import { useStore } from '@nanostores/react'
import { IconApps, IconBrain, IconBrandWindows, IconCode, IconDeviceGamepad2, IconDownload, IconKey, IconMovie, IconRefresh, IconTerminal2, IconWorld } from '@tabler/icons-react'
import { type ComponentType, useEffect, useState } from 'react'
import type { CatalogEntryView } from '../../../../shared/ipc.ts'
import { GlassButton, Pill } from '../../../components/ui/glass.tsx'
import { Spinner } from '../../../components/ui/primitives.tsx'
import { hostPlatform } from '../../../lib/platform-labels.ts'
import { $catalog, loadCatalog, runCatalog, useWithHermes } from '../../../store/catalog.ts'
import { notify } from '../../../store/notifications.ts'
import { openTerminalProgram } from '../../../store/terminal.ts'
import { useT } from '../../../store/i18n.ts'
import { errorText, InlineNote, MenuDropdown, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

const GROUP_ICONS: Record<string, ComponentType<{ size?: number }>> = {
  ai: IconBrain,
  developer: IconCode,
  editors: IconCode,
  terminals: IconTerminal2,
  gaming: IconDeviceGamepad2,
  windows: IconBrandWindows,
  media: IconMovie,
  services: IconKey,
  webapps: IconWorld
}

/*
 * Software: the install catalog, grouped. Each row installs the right way for this machine
 * (Flatpak, the package manager, npm or mise in ~/.local, a web app), or says why it cannot.
 */
export function SoftwareSection() {
  const t = useT()
  const catalog = useStore($catalog)
  const [refreshing, setRefreshing] = useState(false)
  const linux = hostPlatform() === 'linux'

  useEffect(() => {
    void loadCatalog()
  }, [])

  const refresh = () => {
    setRefreshing(true)
    void loadCatalog().finally(() => setRefreshing(false))
  }

  return (
    <>
      <SectionTitle title={t('settings.section.software')} subtitle={linux ? t('settings.software.subtitleLinux') : t('settings.software.subtitleMac')} />

      {catalog.error && <InlineNote tone="danger">{catalog.error}</InlineNote>}
      {!catalog.loaded && (
        <div className="flex items-center gap-3 px-1 py-4 text-[12.5px] text-fg-3">
          <Spinner /> Checking what is installed…
        </div>
      )}

      {catalog.groups.map(group => {
        const Icon = GROUP_ICONS[group.id] ?? IconApps

        return (
          <SettingsGroup key={group.id} title={group.label}>
            {group.entries.map(entry => (
              <CatalogRow key={entry.id} entry={entry} icon={<Icon size={16} />} busy={catalog.busy[entry.id]} />
            ))}
          </SettingsGroup>
        )
      })}

      {catalog.loaded && (
        <div className="flex justify-end">
          <GlassButton size="sm" variant="ghost" onClick={refresh} disabled={refreshing} aria-label="Check again">
            <IconRefresh size={14} /> Check again
          </GlassButton>
        </div>
      )}
    </>
  )
}

function CatalogRow({ entry, icon, busy }: { entry: CatalogEntryView; icon: React.ReactNode; busy?: 'install' | 'remove' }) {
  const description = entry.available || entry.installed ? entry.description : `${entry.description} ${entry.reason ? `(${entry.reason[0]?.toUpperCase()}${entry.reason.slice(1)}.)` : ''}`

  return (
    <SettingsRow icon={icon} label={entry.label} description={description} keywords={`${entry.id} ${entry.group} install`}>
      {busy ? (
        <span className="flex items-center gap-2 text-[12px] text-fg-3">
          <Spinner /> {busy === 'install' ? 'Installing…' : 'Removing…'}
        </span>
      ) : entry.installed ? (
        <>
          <Pill tone="ok">Installed</Pill>
          {entry.terminal && (
            <GlassButton size="sm" onClick={() => openTerminalProgram(entry.id, entry.label)} aria-label={`Open ${entry.label} in the Terminal`}>
              <IconTerminal2 size={14} /> Open
            </GlassButton>
          )}
          {entry.hermes && <UseWithHermes kind={entry.hermes} label={entry.label} />}
          {entry.removable && (
            <GlassButton size="sm" variant="ghost" onClick={() => void runCatalog(entry.id, 'remove')} aria-label={`Remove ${entry.label}`}>
              Remove
            </GlassButton>
          )}
        </>
      ) : entry.available ? (
        <GlassButton size="sm" onClick={() => void runCatalog(entry.id, 'install')} aria-label={`Install ${entry.label}`}>
          <IconDownload size={14} /> {entry.method === 'link' ? 'Download' : 'Install'}
        </GlassButton>
      ) : (
        <span className="text-[12px] text-fg-4">Not here</span>
      )}
    </SettingsRow>
  )
}

/** Point Hermes at one of the local server's models. */
function UseWithHermes({ kind, label }: { kind: 'ollama' | 'lmstudio'; label: string }) {
  const [models, setModels] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)

    try {
      setModels(await window.heraldOS.catalog.localModels(kind))
    } catch (error) {
      notify({ title: `${label} is not ready`, body: errorText(error), level: 'warn' })
    } finally {
      setLoading(false)
    }
  }

  const choose = async (model: string) => {
    try {
      await useWithHermes(kind, model)
      notify({ title: `Hermes uses ${model}`, body: `Through ${label} on this computer; switch back in Settings > Hermes & agents.`, level: 'success' })
    } catch (error) {
      notify({ title: 'Could not switch Hermes', body: errorText(error), level: 'error' })
    }
  }

  if (!models) {
    return (
      <GlassButton size="sm" onClick={() => void load()} disabled={loading} aria-label={`Use ${label} with Hermes`}>
        {loading ? <Spinner /> : <IconBrain size={14} />} Use with Hermes
      </GlassButton>
    )
  }

  return <MenuDropdown ariaLabel={`Model on ${label}`} label="Choose a model" items={models.map(model => ({ id: model, label: model }))} onSelect={model => void choose(model)} />
}
