import { t } from '../../store/i18n.ts'
import type { MemoryState } from '../memory/memory-store.ts'

export interface MemorySummary {
  label: string
  detail: string
}

/**
 * The Overview memory card's two lines, or null until memory has been read once. Pausing turns off
 * the `memory` toolset, which stops new saves but leaves saved entries in every conversation.
 */
export function memorySummary(memory: Pick<MemoryState, 'entries' | 'loaded' | 'error'>, paused: boolean): MemorySummary | null {
  if (!memory.loaded) {
    return null
  }

  const count = memory.entries.length
  const detail = memory.error ? t('overview.memory.unreadable') : count === 0 ? t('overview.memory.empty') : paused ? t('overview.memory.inUse', { count }) : t('overview.memory.remembered', { count })

  return { label: paused ? t('overview.memory.paused') : t('overview.memory.on'), detail }
}
