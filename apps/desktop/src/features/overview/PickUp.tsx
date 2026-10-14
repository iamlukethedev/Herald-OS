import { useStore } from '@nanostores/react'
import { IconBrain, IconCode, IconFileText, IconFolder, IconMessageCircle, IconPlayerPause, IconPlayerPlay, IconSparkles, IconX } from '@tabler/icons-react'
import type { ContinuityItem, ContinuityThread } from '../../../shared/ipc.ts'
import { EmptyGlass, GlassButton, GlassCard, LinkAction, Section } from '../../components/ui/glass.tsx'
import { formatRelative } from '../../lib/format.ts'
import { deviceNoun } from '../../lib/platform-labels.ts'
import { $catchUp, $continuity, $threads, continueThread, dismissThread, openThreadItem, refreshThreads, setContinuityEnabled, startNextStep } from '../../store/continuity.ts'
import { $connection } from '../../store/gateway.ts'
import { useT } from '../../store/i18n.ts'
import { IconTile, Shimmer } from './shared.tsx'

const GLYPH: Record<ContinuityItem['kind'], React.ReactNode> = {
  chat: <IconMessageCircle />,
  file: <IconFileText />,
  folder: <IconFolder />,
  project: <IconCode />
}

/** The Overview's lead section: what Hermes thinks the user will want to resume, one card per thread. */
export function PickUp() {
  const t = useT()
  const continuity = useStore($continuity)
  const threads = useStore($threads)
  const status = useStore($catchUp)
  const online = useStore($connection) === 'open'

  if (continuity.enabled === false) {
    return null
  }

  if (continuity.enabled === null) {
    return <PickUpOffer />
  }

  const thinking = status.phase === 'thinking'
  // Before the first catch-up has run it is about to, so show it coming rather than "nothing".
  const waiting = thinking || (!continuity.updatedAt && status.phase === 'idle' && online)
  const action = (
    <div className="flex items-center gap-3">
      <span className="text-[11.5px] text-fg-4" aria-live="polite">
        {thinking ? t('overview.pickUp.catchingUp') : continuity.updatedAt ? t('overview.pickUp.updated', { time: formatRelative(continuity.updatedAt) }) : ''}
      </span>
      {!thinking && online && <LinkAction onClick={() => void refreshThreads({ force: true })}>{t('overview.refresh')}</LinkAction>}
    </div>
  )

  return (
    <Section title={t('overview.pickUp.title')} action={action}>
      {threads.length > 0 ? (
        <div className="stagger flex flex-col gap-3">
          {threads.map(thread => (
            <ThreadCard key={thread.id} thread={thread} online={online} />
          ))}
        </div>
      ) : waiting ? (
        <ThinkingCards />
      ) : status.phase === 'error' ? (
        <EmptyGlass
          className="min-h-28"
          title={t('overview.pickUp.failed')}
          description={status.message}
          action={
            online && (
              <GlassButton size="sm" onClick={() => void refreshThreads({ force: true })}>
                {t('overview.tryAgain')}
              </GlassButton>
            )
          }
        />
      ) : (
        <EmptyGlass className="min-h-28" title={t('overview.pickUp.empty')} description={t('overview.pickUp.emptyHint', { device: deviceNoun() })} />
      )}
    </Section>
  )
}

function ThreadCard({ thread, online }: { thread: ContinuityThread; online: boolean }) {
  const t = useT()
  const lead = thread.items.find(item => item.kind === 'project') ?? thread.items[0]

  return (
    <GlassCard className="group/reveal-row flex flex-col gap-3 p-4" data-os-target={`thread:${thread.id}`}>
      <div className="flex gap-3.5">
        <IconTile size={40}>{lead ? GLYPH[lead.kind] : <IconBrain />}</IconTile>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <div className="min-w-0 truncate text-[14px] font-semibold text-fg" title={thread.title}>
              {thread.title}
            </div>
            <button
              type="button"
              aria-label={t('overview.pickUp.dismissNamed', { title: thread.title })}
              title={t('overview.pickUp.dismiss')}
              onClick={() => void dismissThread(thread.id)}
              className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-lg text-fg-4 reveal transition-opacity duration-120 hover:bg-white/8 hover:text-fg"
            >
              <IconX size={14} />
            </button>
          </div>
          <div className="text-[12.5px] leading-snug text-fg-2">{thread.summary}</div>
          {thread.stopped && (
            <div className="flex items-center gap-1.5 text-[12px] text-fg-3">
              <IconPlayerPause size={13} className="shrink-0 text-fg-4" aria-hidden="true" />
              <span className="min-w-0 truncate" title={thread.stopped}>
                {thread.stopped}
              </span>
            </div>
          )}
        </div>
      </div>
      {(thread.items.length > 0 || thread.next) && (
        <div className="flex flex-wrap items-center gap-2 pl-[54px]">
          {thread.items.slice(0, 4).map(item => (
            <ItemChip key={`${item.kind}:${item.ref}`} item={item} />
          ))}
          <div className="ml-auto flex items-center gap-2">
            {thread.items.length > 0 && (
              <GlassButton size="sm" aria-label={t('overview.pickUp.continueNamed', { title: thread.title })} onClick={() => void continueThread(thread)}>
                <IconPlayerPlay />
                {t('overview.pickUp.continue')}
              </GlassButton>
            )}
            {thread.next && (
              <GlassButton size="sm" variant="primary" disabled={!online} title={thread.next.prompt} onClick={() => void startNextStep(thread)}>
                <IconSparkles />
                {thread.next.label}
              </GlassButton>
            )}
          </div>
        </div>
      )}
    </GlassCard>
  )
}

function ItemChip({ item }: { item: ContinuityItem }) {
  return (
    <button
      type="button"
      onClick={() => void openThreadItem(item)}
      title={item.kind === 'chat' ? item.label : item.ref}
      className="inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-full border border-line bg-white/6 px-2.5 text-[11.5px] text-fg-2 transition-colors duration-120 hover:border-line-strong hover:bg-white/10 hover:text-fg [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-fg-3"
    >
      {GLYPH[item.kind]}
      <span className="truncate">{item.label}</span>
    </button>
  )
}

function ThinkingCards() {
  const t = useT()

  return (
    <div className="flex flex-col gap-3" role="status" aria-label={t('overview.pickUp.catchingUpLabel')}>
      {[0, 1].map(index => (
        <GlassCard key={index} className="flex gap-3.5 p-4">
          <Shimmer className="size-10 rounded-xl" />
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <Shimmer className="h-3.5 w-2/5" />
            <Shimmer className="h-3 w-4/5" />
            <Shimmer className="h-3 w-3/5" />
          </div>
        </GlassCard>
      ))}
    </div>
  )
}

/** First run: the catch-up sends names to the model provider, so it starts only when the user says so. */
function PickUpOffer() {
  const t = useT()

  return (
    <GlassCard className="flex items-center gap-4 p-4">
      <IconTile size={40}>
        <IconBrain />
      </IconTile>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold text-fg">{t('overview.pickUp.title')}</div>
        <div className="mt-0.5 text-[12.5px] leading-snug text-fg-3">{t('overview.pickUp.offer')}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <GlassButton size="sm" variant="ghost" onClick={() => void setContinuityEnabled(false)}>
          {t('overview.pickUp.notNow')}
        </GlassButton>
        <GlassButton size="sm" variant="primary" onClick={() => void setContinuityEnabled(true)}>
          {t('overview.pickUp.turnOn')}
        </GlassButton>
      </div>
    </GlassCard>
  )
}
