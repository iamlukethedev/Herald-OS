import { useStore } from '@nanostores/react'
import { IconArrowRight, IconEye, IconKey, IconMessageQuestion, IconShieldCheck } from '@tabler/icons-react'
import type { TextKey } from '../../../shared/i18n.ts'
import { GlassButton, GlassCard, Section } from '../../components/ui/glass.tsx'
import { openStoredSession } from '../../store/chat.ts'
import { t, useT } from '../../store/i18n.ts'
import { $reviewMissions, markReviewed } from '../../store/missions.ts'
import { $pendingRequests, type PendingRequest } from '../../store/requests.ts'
import { showPage } from '../../store/windows.ts'
import { FileThumb, IconTile, Quiet } from './shared.tsx'

/*
 * Things only the user can unblock: open approval / clarify / sudo / secret requests (answered in
 * the RequestHost on the Hermes page) and missions whose result is waiting to be looked at.
 */

const REQUEST_COPY: Record<PendingRequest['kind'], { title: TextKey; icon: React.ReactNode }> = {
  approval: { title: 'overview.attention.approval', icon: <IconShieldCheck /> },
  clarify: { title: 'overview.attention.question', icon: <IconMessageQuestion /> },
  sudo: { title: 'overview.attention.password', icon: <IconKey /> },
  secret: { title: 'overview.attention.password', icon: <IconKey /> }
}

function describe(entry: PendingRequest): string {
  const params = entry.request.params as Record<string, unknown>
  const text = [params.description, params.command, params.question, params.prompt, params.tool_name].find((v): v is string => typeof v === 'string' && v.trim().length > 0)

  return text ?? t('overview.attention.waiting')
}

export function Attention() {
  useT()
  const pending = useStore($pendingRequests)
  const reviews = useStore($reviewMissions)
  const empty = pending.length === 0 && reviews.length === 0

  return (
    <Section title={t('overview.attention')}>
      {empty ? (
        <Quiet>{t('overview.attention.nothing')}</Quiet>
      ) : (
        <div className="stagger flex flex-col gap-2.5">
          {pending.map(entry => {
            const copy = REQUEST_COPY[entry.kind]

            return (
              <GlassCard key={entry.request.id} className="flex flex-col gap-2.5 p-3">
                <div className="flex items-start gap-2.5">
                  <IconTile size={34}>{copy.icon}</IconTile>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-fg">{t(copy.title)}</div>
                    <div className="truncate text-[12px] text-fg-3" title={describe(entry)}>
                      {describe(entry)}
                    </div>
                  </div>
                </div>
                <GlassButton size="sm" variant="primary" className="self-start" onClick={() => showPage('hermes')}>
                  {t('overview.attention.review')}
                  <IconArrowRight />
                </GlassButton>
              </GlassCard>
            )
          })}
          {reviews.map(mission => {
            const artifact = mission.artifacts[0]

            return (
              <GlassCard key={mission.id} className="flex flex-col gap-2.5 p-3">
                <div className="flex items-start gap-2.5">
                  <IconTile size={34}>
                    <IconEye />
                  </IconTile>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-fg" title={mission.title}>
                      {t('overview.attention.ready', { title: mission.title })}
                    </div>
                    <div className="text-[12px] text-fg-3">{t('overview.attention.preview')}</div>
                  </div>
                  {artifact?.kind === 'file' && <FileThumb path={artifact.path} size={128} className="size-11 shrink-0" />}
                </div>
                <GlassButton
                  size="sm"
                  variant="primary"
                  className="self-start"
                  onClick={() => {
                    showPage('hermes')
                    void openStoredSession(mission.id)
                    markReviewed(mission.id)
                  }}
                >
                  {t('overview.attention.reviewChanges')}
                  <IconArrowRight />
                </GlassButton>
              </GlassCard>
            )
          })}
        </div>
      )}
    </Section>
  )
}
