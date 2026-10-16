import { useStore } from '@nanostores/react'
import { IconListSearch } from '@tabler/icons-react'
import { useState } from 'react'
import { Toggle } from '../../../components/ui/glass.tsx'
import { useBackendData } from '../../../lib/use-async.ts'
import { $backend } from '../../../store/backend.ts'
import { useT } from '../../../store/i18n.ts'
import { notify } from '../../../store/notifications.ts'
import { readToolSearch, setToolSearch } from '../../../store/tool-search.ts'
import { errorText, InlineNote, markSaved, SettingsRow } from './shared.tsx'

/*
 * Tool search: Hermes's `tools.tool_search.enabled` (/api/config), one setting for every Hermes
 * session. Herald OS turns it off at setup (ADR-010); this is where it goes back on.
 */

export function ToolSearchRow() {
  const t = useT()
  const setting = useBackendData(readToolSearch)
  const bridgeError = useStore($backend).bridgeError
  const [override, setOverride] = useState<{ base: unknown; on: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const on = override && override.base === setting.data ? override.on : setting.data

  const toggle = async (next: boolean) => {
    setOverride({ base: setting.data, on: next })
    setBusy(true)

    try {
      await setToolSearch(next)
      markSaved()
      notify({ title: t(next ? 'settings.agents.toolSearch.on' : 'settings.agents.toolSearch.off'), body: t(next ? 'settings.agents.toolSearch.onBody' : 'settings.agents.toolSearch.offBody'), level: 'success' })
    } catch (error) {
      setOverride(null)
      notify({ title: t('settings.agents.toolSearch.failed'), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      setting.reload()
    }
  }

  return (
    <SettingsRow
      icon={<IconListSearch />}
      label={t('settings.agents.toolSearch.label')}
      description={t('settings.agents.toolSearch.hint')}
      keywords="tool search defer plugins mcp system tools bridge prompt tokens"
      below={bridgeError ? <InlineNote tone="danger">{t('settings.agents.toolSearch.bridgeError', { error: bridgeError })}</InlineNote> : undefined}
    >
      <Toggle checked={on ?? false} onChange={next => void toggle(next)} label={t('settings.agents.toolSearch.label')} disabled={busy || on === null || on === undefined} />
    </SettingsRow>
  )
}
