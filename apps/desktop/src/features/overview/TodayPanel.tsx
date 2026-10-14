import { useStore } from '@nanostores/react'
import { IconBell, IconCalendar, IconLayoutSidebarRightCollapse, IconLayoutSidebarRightExpand, IconShieldCheck, IconUsers } from '@tabler/icons-react'
import { cn } from '../../lib/cn.ts'
import { $chats } from '../../store/chat.ts'
import { useT } from '../../store/i18n.ts'
import { $reviewMissions } from '../../store/missions.ts'
import { setPanelCollapsed, togglePanel, usePanelCollapsed } from '../../store/panels.ts'
import { $pendingRequests } from '../../store/requests.ts'
import { showPage } from '../../store/windows.ts'
import { Attention } from './Attention.tsx'
import { OverviewWidgets } from '../plugins/PluginSlots.tsx'
import { MemoryCard } from './MemoryCard.tsx'
import { WorkingWithYou } from './WorkingWithYou.tsx'
import { YourDay } from './YourDay.tsx'

export const TODAY_PANEL_ID = 'overview.today'
const EXPANDED_WIDTH = 236
const RAIL_WIDTH = 44

/** Right column of Overview. Collapses to an icon rail; the rail still surfaces counts so nothing is lost. */
export function TodayPanel({ now, stacked = false }: { now: Date; stacked?: boolean }) {
  const t = useT()
  // Stacked under the main column (narrow windows) the panel is always expanded and full width.
  const collapsed = usePanelCollapsed(TODAY_PANEL_ID) && !stacked
  const pending = useStore($pendingRequests)
  const reviews = useStore($reviewMissions)
  const chats = useStore($chats)

  const attention = pending.length + reviews.length
  const working = Object.values(chats).some(chat => chat.streaming)
  const expand = () => setPanelCollapsed(TODAY_PANEL_ID, false)

  return (
    <aside
      className={cn('relative flex shrink-0 flex-col transition-[width] duration-200 ease-(--ease-out)', collapsed ? 'items-center' : 'gap-7')}
      style={{ width: stacked ? '100%' : collapsed ? RAIL_WIDTH : EXPANDED_WIDTH }}
      aria-label={t('overview.today')}
      data-collapsed={collapsed || undefined}
    >
      {collapsed ? (
        <div className="flex h-full w-full flex-col items-center gap-1.5 animate-fade-in">
          <RailButton label={t('overview.showPanel')} onClick={() => togglePanel(TODAY_PANEL_ID)}>
            <IconLayoutSidebarRightExpand size={16} stroke={1.9} />
          </RailButton>
          <span className="my-1 h-px w-5 bg-line" />
          <RailButton label={t('overview.yourDay')} onClick={expand}>
            <IconCalendar size={16} stroke={1.9} />
          </RailButton>
          <RailButton label={attention ? t('overview.attentionCount', { count: attention }) : t('overview.attention')} onClick={expand}>
            <IconBell size={16} stroke={1.9} />
            {attention > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9.5px] font-semibold text-accent-fg shadow-[0_2px_8px_rgba(47,125,255,.6)]">
                {attention > 9 ? '9+' : attention}
              </span>
            )}
          </RailButton>
          <RailButton label={working ? t('overview.workingActive') : t('overview.working')} onClick={expand}>
            <IconUsers size={16} stroke={1.9} />
            {working && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-ok text-ok shadow-[0_0_8px_currentColor]" />}
          </RailButton>
          <div className="mt-auto">
            <RailButton label={t('app.memory')} onClick={() => showPage('memory')}>
              <IconShieldCheck size={16} stroke={1.9} />
            </RailButton>
          </div>
        </div>
      ) : (
        <>
          {!stacked && (
          <button
            type="button"
            onClick={() => togglePanel(TODAY_PANEL_ID)}
            aria-label={t('overview.hidePanel')}
            title={t('overview.hidePanel')}
            className="absolute -top-1.5 right-0 flex size-7 items-center justify-center rounded-lg text-fg-4 transition-colors hover:bg-white/8 hover:text-fg"
          >
            <IconLayoutSidebarRightCollapse size={15} stroke={1.9} />
          </button>
          )}
          <div className="flex min-h-0 flex-1 flex-col gap-7 animate-fade-in">
            <YourDay now={now} />
            <Attention />
            <WorkingWithYou />
            <OverviewWidgets />
            <div className="mt-auto pt-2">
              <MemoryCard />
            </div>
          </div>
        </>
      )}
    </aside>
  )
}

function RailButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="side-item group relative flex size-9 items-center justify-center rounded-lg text-fg-2 transition-colors duration-150 hover:bg-white/8 hover:text-fg"
    >
      {children}
      <span className="side-tip side-tip-left">{label}</span>
    </button>
  )
}
