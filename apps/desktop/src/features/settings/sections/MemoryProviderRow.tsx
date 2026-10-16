import { IconDatabase } from '@tabler/icons-react'
import { useState } from 'react'
import { Pill, type PillTone } from '../../../components/ui/glass.tsx'
import { useBackendData } from '../../../lib/use-async.ts'
import { useT } from '../../../store/i18n.ts'
import { notify } from '../../../store/notifications.ts'
import { getMemoryStatus, memoryErrorText, memoryProviderView, memoryStatusLabel, setMemoryProvider } from '../../memory/memory-provider.ts'
import { InlineNote, markSaved, MenuDropdown, SettingsRow } from './shared.tsx'

/*
 * Memory provider: Hermes's `memory.provider` (GET /api/memory, PUT /api/memory/provider). An
 * external provider such as Honcho saves and recalls alongside MEMORY.md and USER.md, so what the
 * Memory page lists isn't everything Hermes remembers.
 */

const statusTone = (status: string | null): PillTone => (status === 'ready' ? 'ok' : status === 'needs_config' ? 'warn' : 'muted')

export function MemoryProviderRow() {
  const t = useT()
  const memory = useBackendData(getMemoryStatus)
  const [override, setOverride] = useState<{ base: unknown; active: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const view = memoryProviderView(override && override.base === memory.data ? { ...memory.data, active: override.active } : memory.data)

  const select = async (id: string) => {
    if (busy || id === view.active) {
      return
    }

    setOverride({ base: memory.data, active: id })
    setBusy(true)

    try {
      await setMemoryProvider(id)
      markSaved()
      notify({ title: t('settings.agents.memoryProvider.changed'), body: t('settings.agents.newSessionsUseIt', { name: view.choices.find(choice => choice.id === id)?.label ?? id }), level: 'success' })
    } catch (error) {
      setOverride(null)
      notify({ title: t('settings.agents.memoryProvider.failed'), body: memoryErrorText(error), level: 'error' })
    } finally {
      setBusy(false)
      memory.reload()
    }
  }

  return (
    <SettingsRow
      icon={<IconDatabase />}
      label={t('settings.agents.memoryProvider.label')}
      description={`${memory.data ? view.description : t('settings.agents.memoryProvider.hint')} ${t('settings.agents.memoryProvider.scope')}`}
      keywords="memory provider honcho mem0 external built-in recall cli messaging"
      below={memory.error ? <InlineNote tone="danger">{t('settings.agents.memoryProvider.unreadable', { error: memoryErrorText(memory.error) })}</InlineNote> : undefined}
    >
      <MenuDropdown
        ariaLabel={t('settings.agents.memoryProvider.label')}
        label={memory.data ? view.label : memory.error ? t('settings.agents.memoryProvider.unavailable') : '…'}
        value={view.active}
        disabled={busy || !memory.data}
        menuClassName="min-w-[300px]"
        items={view.choices.map(choice => ({
          id: choice.id,
          label: choice.label,
          description: choice.description || undefined,
          trailing: choice.status ? <Pill tone={statusTone(choice.status)}>{memoryStatusLabel(choice.status)}</Pill> : undefined
        }))}
        onSelect={id => void select(id)}
      />
    </SettingsRow>
  )
}
