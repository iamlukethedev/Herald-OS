import { useStore } from '@nanostores/react'
import { IconChevronRight, IconShieldCheck } from '@tabler/icons-react'
import { useEffect } from 'react'
import { GlassCard } from '../../components/ui/glass.tsx'
import { $env } from '../../store/backend.ts'
import { useT } from '../../store/i18n.ts'
import { showPage } from '../../store/windows.ts'
import { $memory, loadMemory } from '../memory/memory-store.ts'
import { useMemoryToolset } from '../memory/use-memory-toolset.ts'
import { memorySummary } from './memory-summary.ts'
import { IconTile, Shimmer } from './shared.tsx'

/** One-line memory health: the entries the Memory page lists, and whether memory is paused. */
export function MemoryCard() {
  useT()
  const hermesHome = useStore($env)?.hermesHome ?? null
  const memory = useStore($memory)
  const toolset = useMemoryToolset()
  const summary = memorySummary(memory, toolset.paused)

  useEffect(() => {
    if (hermesHome) {
      void loadMemory(hermesHome)
    }
  }, [hermesHome])

  return (
    <GlassCard as="button" interactive onClick={() => showPage('memory')} className="flex w-full items-center gap-3 p-3">
      <IconTile size={34}>
        <IconShieldCheck />
      </IconTile>
      <div className="min-w-0 flex-1">
        {summary ? (
          <>
            <div className="truncate text-[13px] font-medium text-fg">{summary.label}</div>
            <div className="truncate text-[11.5px] text-fg-3">{summary.detail}</div>
          </>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Shimmer className="h-3 w-28 rounded" />
            <Shimmer className="h-2.5 w-20 rounded" />
          </div>
        )}
      </div>
      <IconChevronRight size={15} className="shrink-0 text-fg-4" aria-hidden="true" />
    </GlassCard>
  )
}
