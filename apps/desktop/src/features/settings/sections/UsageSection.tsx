import { useStore } from '@nanostores/react'
import { IconCalendarStats, IconChartBar, IconCoin, IconCreditCard, IconGauge, IconLayoutNavbar, IconRefresh } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { GlassButton, ProgressBar, Toggle } from '../../../components/ui/glass.tsx'
import { formatDollars, formatTokens, planPercent, type UsageSummary } from '../../../lib/usage.ts'
import { $prefs, updatePrefs } from '../../../store/backend.ts'
import { $usage, loadUsage } from '../../../store/usage.ts'
import { openWebWindow } from '../../../store/web-windows.ts'
import { useT } from '../../../store/i18n.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * What Hermes has used: the provider plan's limits (Nous Portal reports them through `usage.bars`
 * and `billing.state`) and Hermes's own token accounting per session (`/api/analytics/usage`).
 */

export function UsageSection() {
  const t = useT()
  const usage = useStore($usage)
  const prefs = useStore($prefs)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setLoading(true)

    try {
      await loadUsage()
      setError(null)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const plan = usage?.plan
  const billing = usage?.billing
  const pct = planPercent(plan)

  return (
    <>
      <SectionTitle title={t('settings.section.usage')} subtitle={t('settings.usage.subtitle')} />

      <SettingsGroup title="Plan">
        {plan?.available ? (
          <>
            <SettingsRow
              icon={<IconGauge />}
              label={plan.plan_name || 'Your plan'}
              description={[plan.plan_bar ? `${plan.plan_bar.spent_display} of ${plan.plan_bar.total_display} used` : null, plan.renews_display ? `renews ${plan.renews_display}` : null].filter(Boolean).join(' · ') || undefined}
              keywords="limit quota subscription plan"
              below={plan.plan_bar ? <ProgressBar value={Math.round(pct ?? 0)} tone={pct !== null && pct >= 90 ? 'progress' : 'accent'} /> : undefined}
            >
              {pct !== null && <span className="text-[13px] font-medium tabular-nums text-fg">{Math.round(pct)}%</span>}
            </SettingsRow>
            {plan.topup_bar && (
              // A fuel gauge: `fill_fraction` is the share still left.
              <SettingsRow icon={<IconCoin />} label="Top-up credit" description={`${plan.topup_bar.remaining_display} left of ${plan.topup_bar.total_display}`} keywords="credit topup balance" below={<ProgressBar value={Math.round((plan.topup_bar.fill_fraction ?? 0) * 100)} tone="ok" />} />
            )}
          </>
        ) : (
          <SettingsRow
            icon={<IconGauge />}
            label="Plan limits"
            description={billing?.logged_in ? 'Your provider does not report plan limits.' : 'Plan limits appear here when Hermes is signed in to Nous Portal; other providers show their usage on their own site.'}
            keywords="limit quota subscription plan"
          />
        )}
        {billing?.logged_in && (billing.balance_display || billing.monthly_cap) && (
          <SettingsRow
            icon={<IconCreditCard />}
            label={billing.org_name || 'Billing'}
            description={[billing.balance_display ? `Balance ${billing.balance_display}` : null, billing.monthly_cap ? `${billing.monthly_cap.spent_display} of ${billing.monthly_cap.limit_display} this month` : null].filter(Boolean).join(' · ')}
            keywords="billing balance spend cap"
          >
            {billing.portal_url && (
              <GlassButton size="sm" onClick={() => void openWebWindow(billing.portal_url as string, { title: 'Billing' })}>
                Manage
              </GlassButton>
            )}
          </SettingsRow>
        )}
      </SettingsGroup>

      <UsagePeriod title="This week" icon={<IconChartBar />} summary={usage?.week ?? null} />
      <UsagePeriod title="Last 30 days" icon={<IconCalendarStats />} summary={usage?.month ?? null} />

      <SettingsGroup title="Menu bar">
        <SettingsRow icon={<IconLayoutNavbar />} label="Show plan usage in the menu bar" description="A small meter next to the clock while your plan reports a limit." keywords="menu bar meter percent">
          <Toggle checked={Boolean(prefs.usageInMenuBar)} onChange={next => void updatePrefs({ usageInMenuBar: next }).then(markSaved)} label="Show plan usage in the menu bar" />
        </SettingsRow>
      </SettingsGroup>

      <div className="flex items-center justify-between gap-3">
        {error ? <InlineNote tone="danger">{error}</InlineNote> : <span className="text-[11.5px] text-fg-4">{usage ? `Updated ${new Date(usage.loadedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</span>}
        <GlassButton size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()}>
          <IconRefresh />
          {loading ? 'Refreshing…' : 'Refresh'}
        </GlassButton>
      </div>
    </>
  )
}

function UsagePeriod({ title, icon, summary }: { title: string; icon: React.ReactNode; summary: UsageSummary | null }) {
  if (!summary) {
    return null
  }

  const peak = Math.max(1, ...summary.daily.map(day => day.tokens))

  return (
    <SettingsGroup title={title}>
      <SettingsRow
        icon={icon}
        label={`${formatTokens(summary.tokens)} tokens`}
        description={[`${summary.sessions} session${summary.sessions === 1 ? '' : 's'}`, summary.cost > 0 ? `about ${formatDollars(summary.cost)}` : null, summary.topModel ? `mostly ${summary.topModel}` : null].filter(Boolean).join(' · ')}
        keywords="tokens sessions cost model"
        below={
          summary.daily.length > 1 ? (
            <div className="flex h-10 items-end gap-1" aria-label={`Tokens per day, ${title.toLowerCase()}`}>
              {summary.daily.slice(-30).map(day => (
                <span key={day.day} title={`${day.day}: ${formatTokens(day.tokens)} tokens`} className="min-w-1 flex-1 rounded-t-sm bg-accent/60" style={{ height: `${Math.max(4, (day.tokens / peak) * 100)}%` }} />
              ))}
            </div>
          ) : undefined
        }
      >
        <span className="text-[12px] tabular-nums text-fg-3">
          {formatTokens(summary.input)} in · {formatTokens(summary.output)} out
        </span>
      </SettingsRow>
    </SettingsGroup>
  )
}
