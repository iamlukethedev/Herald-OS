import { IconCheck, IconExternalLink, IconFileText, IconFolder, IconWorld } from '@tabler/icons-react'
import type { TextKey } from '../../../shared/i18n.ts'
import { AppTile } from '../../components/app-icon.tsx'
import { GlassButton, GlassCard, Pill, type PillTone, ProgressBar } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { openStoredSession } from '../../store/chat.ts'
import { useT } from '../../store/i18n.ts'
import type { Mission, MissionStep } from '../../store/missions.ts'
import { showPage } from '../../store/windows.ts'
import { openInDefaultApp } from '../files/files-store.ts'
import { AvatarStack, FileThumb, IconTile } from './shared.tsx'

const STATUS: Record<Mission['status'], { label: TextKey; tone: PillTone; dot: boolean }> = {
  active: { label: 'overview.mission.active', tone: 'progress', dot: true },
  review: { label: 'overview.mission.review', tone: 'accent', dot: false },
  queued: { label: 'overview.mission.queued', tone: 'muted', dot: false },
  completed: { label: 'overview.mission.completed', tone: 'ok', dot: false }
}

const WEB_HINT = /\b(website|web ?site|landing|page|site|blog|homepage|web)\b/i
const DOC_HINT = /\b(brief|briefing|report|doc|document|summary|memo|essay|draft|write|writing|notes?)\b/i

function MissionGlyph({ mission }: { mission: Mission }) {
  const text = `${mission.title} ${mission.goal}`

  if (WEB_HINT.test(text)) {
    return (
      <IconTile size={40}>
        <IconWorld />
      </IconTile>
    )
  }

  if (DOC_HINT.test(text)) {
    return (
      <IconTile size={40}>
        <IconFileText />
      </IconTile>
    )
  }

  return <AppTile id="missions" size={40} />
}

export function openMission(mission: Mission): void {
  showPage('hermes')
  void openStoredSession(mission.id)
}

export function MissionCard({ mission }: { mission: Mission }) {
  const t = useT()
  const status = STATUS[mission.status]
  const artifact = mission.artifacts[0]
  const steps = mission.steps.slice(0, 4)
  const summary = mission.currentStep && mission.status === 'active' ? mission.currentStep : mission.goal
  const doneCount = mission.steps.filter(s => s.state === 'done').length
  const meta = [mission.steps.length > 0 ? t('overview.mission.steps', { done: doneCount, total: mission.steps.length }) : null, mission.artifacts.length > 0 ? t('overview.mission.files', { count: mission.artifacts.length }) : null].filter(Boolean)

  return (
    <GlassCard className="flex gap-4 p-4">
      <div className="flex min-w-0 flex-1 gap-3.5">
        <MissionGlyph mission={mission} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <button type="button" onClick={() => openMission(mission)} className="min-w-0 truncate text-left text-[14px] font-semibold text-fg hover:underline" title={mission.title}>
              {mission.title}
            </button>
            <Pill tone={status.tone} dot={status.dot}>
              {t(status.label)}
            </Pill>
            <div className="ml-auto shrink-0">
              <AvatarStack labels={mission.agents.map(a => a.goal)} label={t('overview.agents', { count: mission.agents.length })} />
            </div>
          </div>
          {summary && (
            <div className="truncate text-[12.5px] text-fg-3" title={summary}>
              {summary}
            </div>
          )}
          {meta.length > 0 && <div className="text-[11.5px] text-fg-4">{meta.join(' · ')}</div>}
          {steps.length > 0 ? (
            <StepTrack steps={steps} className="mt-2" />
          ) : (
            <div className="mt-2.5 flex items-center gap-3">
              <ProgressBar value={mission.progress} tone={mission.status === 'active' ? 'progress' : 'accent'} className="flex-1" />
              <span className="w-8 text-right text-[11px] tabular-nums text-fg-3">{Math.round(mission.progress)}%</span>
            </div>
          )}
        </div>
      </div>
      {artifact ? (
        <div className="flex w-[196px] shrink-0 flex-col gap-2 rounded-lg bg-black/15 p-2 hairline">
          <div className="flex items-center gap-2">
            {artifact.kind === 'file' ? <FileThumb path={artifact.path} size={128} className="size-9 shrink-0" /> : <IconTile size={36}><IconFolder /></IconTile>}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium text-fg" title={artifact.path}>
                {artifact.name}
              </div>
              <div className="truncate text-[11px] text-fg-4">{artifact.kind === 'folder' ? t('overview.kind.folder') : t('overview.kind.draft')}</div>
            </div>
          </div>
          <GlassButton size="sm" aria-label={t('overview.openNamed', { name: artifact.name })} onClick={() => openInDefaultApp(artifact.path, artifact.name)}>
            {t('overview.mission.openDraft')}
            <IconExternalLink />
          </GlassButton>
        </div>
      ) : (
        <div className="flex shrink-0 items-center">
          <GlassButton size="sm" aria-label={t('overview.openNamed', { name: mission.title })} onClick={() => openMission(mission)}>
            {t('overview.open')}
          </GlassButton>
        </div>
      )}
    </GlassCard>
  )
}

/** Small circles on a line: done steps are filled mint, the active one rings accent, the rest wait. */
export function StepTrack({ steps, className }: { steps: MissionStep[]; className?: string }) {
  const t = useT()

  return (
    <ol className={cn('flex w-full', className)} aria-label={t('overview.mission.stepsLabel')}>
      {steps.map((step, index) => {
        const previousDone = index > 0 && steps[index - 1].state === 'done'
        const nextReached = index < steps.length - 1 && step.state === 'done'

        return (
          <li key={step.id} className="flex min-w-0 flex-1 flex-col items-center gap-1.5" aria-current={step.state === 'active' ? 'step' : undefined}>
            <div className="flex w-full items-center">
              <span aria-hidden="true" className={cn('h-px flex-1', index === 0 ? 'bg-transparent' : previousDone && step.state !== 'pending' ? 'bg-ok/70' : 'bg-line')} />
              <StepDot state={step.state} />
              <span aria-hidden="true" className={cn('h-px flex-1', index === steps.length - 1 ? 'bg-transparent' : nextReached ? 'bg-ok/70' : 'bg-line')} />
            </div>
            <span className={cn('w-full truncate px-1 text-center text-[11px]', step.state === 'pending' ? 'text-fg-4' : step.state === 'active' ? 'text-fg' : 'text-fg-3')} title={step.label}>
              {step.label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function StepDot({ state }: { state: MissionStep['state'] }) {
  const t = useT()

  if (state === 'done') {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-ok text-bg shadow-[0_0_10px_rgba(54,230,166,.45)]" aria-label={t('overview.mission.stepDone')}>
        <IconCheck size={10} stroke={3} />
      </span>
    )
  }

  if (state === 'active') {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] border-accent-strong bg-black/25 shadow-[0_0_10px_rgba(82,150,255,.5)]" aria-label={t('overview.mission.active')}>
        <span className="size-1.5 rounded-full bg-accent-strong" />
      </span>
    )
  }

  return <span className="size-4 shrink-0 rounded-full border-[1.5px] border-line-strong bg-black/25" aria-label={t('overview.mission.stepPending')} />
}
