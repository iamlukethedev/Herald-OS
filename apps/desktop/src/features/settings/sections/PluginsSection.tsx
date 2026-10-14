import { useStore } from '@nanostores/react'
import { IconAlertTriangle, IconFolder, IconPuzzle, IconRefresh, IconSparkles, IconWorld } from '@tabler/icons-react'
import { useState } from 'react'
import { describePermissions, type PluginView } from '../../../../shared/plugins.ts'
import { GlassButton, Pill, Toggle } from '../../../components/ui/glass.tsx'
import { Spinner } from '../../../components/ui/primitives.tsx'
import { openInDefaultApp } from '../../files/files-store.ts'
import { notify } from '../../../store/notifications.ts'
import { $plugins } from '../../../store/plugins.ts'
import { openAsk } from '../../../store/surface.ts'
import { openApp } from '../../../store/windows.ts'
import { useT } from '../../../store/i18n.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

const MAKE_A_WIDGET = 'Make me a Herald OS widget that '

/*
 * Settings > Plugins: widgets for the menu bar, the Overview and their own windows (ADR-019). Each
 * runs in a sandbox and gets only what its manifest asks for and the person accepted here; new ones
 * arrive turned off.
 */
export function PluginsSection() {
  const t = useT()
  const plugins = useStore($plugins)
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)

  const add = async () => {
    setAdding(true)

    try {
      const added = await window.heraldOS.plugins.add(url.trim())
      setUrl('')
      notify({ title: `${added.manifest.name} installed`, body: 'It is off until you turn it on below.', level: 'success' })
    } catch (error) {
      notify({ title: 'Could not install the plugin', body: errorText(error), level: 'error' })
    } finally {
      setAdding(false)
    }
  }

  return (
    <>
      <SectionTitle title={t('settings.section.plugins')} subtitle={t('settings.plugins.subtitle')} />

      <SettingsGroup title="Installed">
        {plugins.length === 0 && <SettingsRow icon={<IconPuzzle />} label="No plugins yet" description="Add one from git below, or ask Hermes to make one." />}
        {plugins.map(plugin => (
          <PluginRow key={plugin.manifest.id} plugin={plugin} />
        ))}
      </SettingsGroup>

      <SettingsGroup title="Add">
        <SettingsRow icon={<IconWorld />} label="From git" description="Installs it turned off; you see what it asks for before it runs." keywords="install plugin widget git">
          <form
            className="flex items-center gap-2"
            onSubmit={event => {
              event.preventDefault()
              void add()
            }}
          >
            <input value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/…/my-widget" aria-label="Plugin git URL" className="glass-input h-8 w-[260px] rounded-lg px-2.5 text-[12.5px] outline-none" />
            <GlassButton size="sm" type="submit" disabled={adding || !/^(https:\/\/|git@|ssh:\/\/)\S+$/.test(url.trim())}>
              {adding ? <Spinner /> : null} Add
            </GlassButton>
          </form>
        </SettingsRow>
        <SettingsRow icon={<IconSparkles />} label="Make one with Hermes" description='Describe it ("a strip with the weather", "my next meeting") and Hermes writes it into your plugins folder.' keywords="create widget hermes">
          <GlassButton size="sm" onClick={() => openAsk({ text: MAKE_A_WIDGET })}>
            Make a widget
          </GlassButton>
        </SettingsRow>
        <SettingsRow icon={<IconFolder />} label="Plugins folder" description={<span className="font-mono text-[11.5px]">~/.config/herald-os/plugins</span>} keywords="plugin folder files">
          <GlassButton size="sm" variant="ghost" onClick={() => openInDefaultApp('~/.config/herald-os/plugins')}>
            Open
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}

function PluginRow({ plugin }: { plugin: PluginView }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const { manifest } = plugin
  const broken = plugin.errors.length > 0

  const setEnabled = async (enabled: boolean) => {
    setBusy(true)

    try {
      await window.heraldOS.plugins.setEnabled(manifest.id, enabled)
      markSaved()
    } catch (error) {
      notify({ title: `Could not turn ${manifest.name} ${enabled ? 'on' : 'off'}`, body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  const act = async (what: 'update' | 'remove') => {
    setBusy(true)

    try {
      await (what === 'update' ? window.heraldOS.plugins.update(manifest.id) : window.heraldOS.plugins.remove(manifest.id))
      notify({ title: `${manifest.name} ${what === 'update' ? 'updated' : 'removed'}`, level: 'success' })
    } catch (error) {
      notify({ title: `Could not ${what} ${manifest.name}`, body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsRow
      icon={<IconPuzzle />}
      label={`${manifest.name}${manifest.version !== '0.0.0' ? ` ${manifest.version}` : ''}`}
      description={broken ? undefined : manifest.description || `Shows in: ${manifest.placement.join(', ')}`}
      keywords={`${manifest.id} plugin widget`}
      below={
        broken ? (
          <InlineNote tone="danger">
            <IconAlertTriangle size={13} className="inline" /> {plugin.errors.join('; ')}
          </InlineNote>
        ) : confirming ? (
          <div className="flex flex-col gap-2 rounded-lg border border-line p-3 text-[12.5px] text-fg-2">
            <span className="font-medium text-fg">Turn on {manifest.name}? It will be able to:</span>
            <ul className="list-disc pl-5 text-fg-3">
              {describePermissions(manifest).map(line => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <GlassButton size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </GlassButton>
              <GlassButton size="sm" variant="primary" onClick={() => void setEnabled(true)} disabled={busy}>
                Turn on
              </GlassButton>
            </div>
          </div>
        ) : undefined
      }
    >
      {busy && <Spinner />}
      {plugin.enabled && manifest.placement.includes('panel') && (
        <GlassButton size="sm" variant="ghost" onClick={() => openApp('widget', { payload: { plugin: manifest.id }, title: manifest.name, singleton: false })}>
          Open
        </GlassButton>
      )}
      {plugin.git && (
        <GlassButton size="sm" variant="ghost" onClick={() => void act('update')} aria-label={`Update ${manifest.name}`} disabled={busy}>
          <IconRefresh size={14} />
        </GlassButton>
      )}
      <GlassButton size="sm" variant="ghost" onClick={() => void act('remove')} disabled={busy}>
        Remove
      </GlassButton>
      {!broken && <Pill tone={plugin.enabled ? 'ok' : 'muted'}>{plugin.enabled ? 'On' : 'Off'}</Pill>}
      {!broken && <Toggle checked={plugin.enabled} onChange={next => (next ? setConfirming(true) : void setEnabled(false))} label={`${manifest.name} on`} />}
    </SettingsRow>
  )
}
