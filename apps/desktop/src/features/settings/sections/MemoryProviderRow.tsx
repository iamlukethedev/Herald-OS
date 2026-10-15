import { IconDatabase } from '@tabler/icons-react'
import { useState } from 'react'
import { Pill, type PillTone } from '../../../components/ui/glass.tsx'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { getMemoryStatus, memoryErrorText, memoryProviderView, memoryStatusLabel, setMemoryProvider } from '../../memory/memory-provider.ts'
import { InlineNote, markSaved, MenuDropdown, SettingsRow } from './shared.tsx'

/*
 * Memory provider: Hermes's `memory.provider` (GET /api/memory, PUT /api/memory/provider). An
 * external provider such as Honcho saves and recalls alongside MEMORY.md and USER.md, so what the
 * Memory page lists isn't everything Hermes remembers.
 */

const SCOPE = 'Applies to all of Hermes, including CLI and messaging. New sessions only.'

const statusTone = (status: string | null): PillTone => (status === 'ready' ? 'ok' : status === 'needs_config' ? 'warn' : 'muted')

export function MemoryProviderRow() {
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
      notify({ title: 'Memory provider changed', body: `${view.choices.find(choice => choice.id === id)?.label ?? id}. New sessions use it.`, level: 'success' })
    } catch (error) {
      setOverride(null)
      notify({ title: 'Could not change memory provider', body: memoryErrorText(error), level: 'error' })
    } finally {
      setBusy(false)
      memory.reload()
    }
  }

  return (
    <SettingsRow
      icon={<IconDatabase />}
      label="Memory provider"
      description={`${memory.data ? view.description : 'Where Hermes saves and recalls memories.'} ${SCOPE}`}
      keywords="memory provider honcho mem0 external built-in recall cli messaging"
      below={memory.error ? <InlineNote tone="danger">Could not read the memory provider: {memoryErrorText(memory.error)}</InlineNote> : undefined}
    >
      <MenuDropdown
        ariaLabel="Memory provider"
        label={memory.data ? view.label : memory.error ? 'Unavailable' : '…'}
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
