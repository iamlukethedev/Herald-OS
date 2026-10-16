import { useStore } from '@nanostores/react'
import { IconBolt, IconCloud, IconCpu, IconFileText, IconHistory, IconLock, IconMessage, IconScale, IconSearch, IconUsers } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import type { TextKey } from '../../../../shared/i18n.ts'
import type { AuditEntry } from '../../../../shared/ipc.ts'
import { HermesAvatar } from '../../../components/app-icon.tsx'
import { Dropdown, GlassButton, GlassCard, LinkAction, Pill, type PillTone, StatusDot, Toggle } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { formatRelative } from '../../../lib/format.ts'
import { rest } from '../../../lib/rest.ts'
import { useBackendData, useLocalData } from '../../../lib/use-async.ts'
import { $activeChat } from '../../../store/chat.ts'
import { $connection, gatewayRequest } from '../../../store/gateway.ts'
import { $providerChanges, type ModelChange, setHermesModel } from '../../../store/model-provider.ts'
import { notify } from '../../../store/notifications.ts'
import { readTier, withTier } from './policy.ts'
import { MemoryProviderRow } from './MemoryProviderRow.tsx'
import { ModelConfirm, ModelProviderRow } from './ProviderRow.tsx'
import { t, useT } from '../../../store/i18n.ts'
import { errorText, InlineNote, markSaved, MenuDropdown, RadioCard, SectionTitle, SettingsBlock, SettingsGroup, SettingsRow, Stepper, useDismiss } from './shared.tsx'
import { ToolSearchRow } from './ToolSearchRow.tsx'

/*
 * Hermes & agents: the default Settings section. Every control here binds to real Hermes state:
 *   approvals.mode (gateway config.get/set)            -> Autonomy cards
 *   model.options, /api/providers/oauth, /api/env      -> Model provider (ProviderRow.tsx)
 *   model.options + /api/model/set + config.set model  -> Preferred model
 *   /api/tools/terminal/backend(s)                     -> Run on
 *   delegation.max_concurrent_children (/api/config)   -> Background agents
 *   `memory` toolset (/api/tools/toolsets)             -> Remember preferences
 *   memory.provider (/api/memory)                      -> Memory provider (MemoryProviderRow.tsx)
 *   bridge policy tier `act`                           -> Ask before sending messages
 *   bridge audit log                                   -> Activity history
 */

const CONNECTION: Partial<Record<string, TextKey>> = {
  open: 'settings.agents.ready',
  connecting: 'settings.agents.connecting',
  error: 'settings.agents.connectionError',
  closed: 'settings.agents.disconnected'
}

export function AgentsSection() {
  const t = useT()
  const connection = useStore($connection)
  const ready = connection === 'open'

  return (
    <>
      <SectionTitle title={t('settings.section.agents')} subtitle={t('settings.agents.subtitle')} />

      <SettingsBlock label={t('app.hermes')} description={t('settings.agents.personalAgent')} keywords="status identity ready connecting">
        <GlassCard className="flex items-center gap-3.5 px-4 py-3">
          <HermesAvatar size={44} rounded={11} />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold text-fg">{t('app.hermes')}</div>
            <div className="text-[12px] text-fg-3">{t('settings.agents.personalAgent')}</div>
            <div className="mt-1 flex items-center gap-1.5 text-[12px] text-fg-2">
              <StatusDot tone={ready ? 'ok' : connection === 'error' || connection === 'closed' ? 'danger' : 'warn'} pulse={!ready} />
              {t(CONNECTION[connection] ?? 'menuBar.waitingForHermes')}
            </div>
          </div>
        </GlassCard>
      </SettingsBlock>

      <AutonomyBlock ready={ready} />

      <SettingsGroup title={t('settings.agents.account')}>
        <ModelProviderRow />
      </SettingsGroup>

      <SettingsGroup title={t('settings.agents.modelPerformance')}>
        <PreferredModelRow ready={ready} />
        <RunOnRow />
        <BackgroundAgentsRow />
        <ToolSearchRow />
      </SettingsGroup>

      <SettingsGroup title={t('settings.agents.privacyControl')}>
        <RememberPreferencesRow />
        <MemoryProviderRow />
        <AskBeforeSendingRow />
        <ActivityHistoryRow />
      </SettingsGroup>
    </>
  )
}

// ---- Autonomy ------------------------------------------------------------------------------

type ApprovalMode = 'manual' | 'smart' | 'off'

const AUTONOMY: { mode: ApprovalMode; label: TextKey; description: TextKey; icon: React.ReactNode }[] = [
  { mode: 'manual', label: 'settings.agents.askFirst', description: 'settings.agents.askFirstHint', icon: <IconMessage /> },
  { mode: 'smart', label: 'settings.agents.balanced', description: 'settings.agents.balancedHint', icon: <IconScale /> },
  { mode: 'off', label: 'settings.agents.independent', description: 'settings.agents.independentHint', icon: <IconBolt /> }
]

function normalizeMode(value: unknown): ApprovalMode | null {
  const raw = String(value ?? '').toLowerCase()

  return raw === 'manual' || raw === 'smart' || raw === 'off' ? raw : null
}

function AutonomyBlock({ ready }: { ready: boolean }) {
  const t = useT()
  const setting = useBackendData(() => gatewayRequest('config.get', { key: 'approvals.mode' }), [], { enabled: ready })
  const [override, setOverride] = useState<{ base: unknown; mode: ApprovalMode } | null>(null)
  const [pendingOff, setPendingOff] = useState(false)
  const [busy, setBusy] = useState(false)
  const current = override && override.base === setting.data ? override.mode : normalizeMode(setting.data?.value)

  const apply = async (mode: ApprovalMode) => {
    setPendingOff(false)
    setOverride({ base: setting.data, mode })
    setBusy(true)

    try {
      await gatewayRequest('config.set', { key: 'approvals.mode', value: mode })
      markSaved()
      const chosen = AUTONOMY.find(item => item.mode === mode)
      notify({ title: t('settings.agents.autonomyUpdated'), body: chosen && t(chosen.label), level: 'success' })
    } catch (error) {
      setOverride(null)
      notify({ title: t('settings.agents.autonomyFailed'), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      setting.reload()
    }
  }

  const choose = (mode: ApprovalMode) => {
    if (mode === current) {
      setPendingOff(false)

      return
    }

    if (mode === 'off') {
      setPendingOff(true)

      return
    }

    void apply(mode)
  }

  return (
    <SettingsBlock title={t('settings.agents.autonomy')} label={t('settings.agents.autonomy')} description={t('settings.agents.autonomyHint')} keywords="autonomy approvals mode manual smart off yolo confirm">
      <div className="flex min-w-0 gap-3" aria-label={t('settings.agents.autonomy')}>
        {AUTONOMY.map(item => (
          <RadioCard key={item.mode} icon={item.icon} label={t(item.label)} description={t(item.description)} selected={pendingOff ? item.mode === 'off' : current === item.mode} onSelect={() => choose(item.mode)} disabled={!ready || busy} />
        ))}
      </div>
      {pendingOff && (
        <GlassCard className="flex items-center gap-3 px-3.5 py-2.5">
          <InlineNote tone="warn" className="min-w-0 flex-1">
            {t('settings.agents.independentWarning')}
          </InlineNote>
          <GlassButton size="sm" variant="ghost" onClick={() => setPendingOff(false)}>
            {t('settings.cancel')}
          </GlassButton>
          <GlassButton size="sm" variant="primary" onClick={() => void apply('off')} aria-label={t('settings.agents.confirmIndependent')}>
            {t('settings.agents.confirm')}
          </GlassButton>
        </GlassCard>
      )}
      {setting.error && <InlineNote tone="danger">{t('settings.agents.autonomyUnreadable', { error: setting.error })}</InlineNote>}
    </SettingsBlock>
  )
}

// ---- Preferred model -----------------------------------------------------------------------

function shortModel(model: string | undefined | null, automatic: string): string {
  if (!model) {
    return automatic
  }

  return model.includes('/') ? model.slice(model.indexOf('/') + 1) : model
}

function PreferredModelRow({ ready }: { ready: boolean }) {
  const t = useT()
  const chat = useStore($activeChat)
  const changes = useStore($providerChanges)
  const options = useBackendData(() => gatewayRequest('model.options', { include_unconfigured: false }), [changes], { enabled: ready })
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Extract<ModelChange, { ok: false }> | null>(null)
  const ref = useDismiss(open, () => setOpen(false))

  const current = options.data?.model ?? chat?.info.model
  const provider = options.data?.provider ?? chat?.info.provider
  // Hermes names a custom endpoint `custom:<name>` where its row has the bare name.
  const nameOf = (slug: string) => options.data?.providers.find(p => p.slug === slug || p.aliases?.includes(slug))?.name ?? slug
  const providerLabel = provider && nameOf(provider)
  const providers = useMemo(() => {
    const q = filter.trim().toLowerCase()

    return (options.data?.providers ?? [])
      .filter(p => p.authenticated !== false && (p.models?.length ?? 0) > 0)
      .map(p => ({ ...p, models: (p.models ?? []).filter(model => !q || model.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) }))
      .filter(p => p.models.length > 0)
  }, [options.data, filter])

  const setModel = async (providerSlug: string, model: string, confirmed = false) => {
    setPending(`${providerSlug}:${model}`)
    setConfirm(null)

    try {
      const change = await setHermesModel(providerSlug, model, confirmed)
      setOpen(false)

      if (!change.ok) {
        setConfirm(change)

        return
      }

      markSaved()
      const name = nameOf(change.provider)
      notify({ title: t('settings.agents.modelChanged'), body: t(chat ? 'settings.agents.modelChangedChat' : 'settings.agents.modelChangedNew', { provider: name, model: change.model }), level: 'success' })
    } catch (error) {
      notify({ title: t('settings.agents.modelFailed'), body: errorText(error), level: 'error' })
    } finally {
      setPending(null)
    }
  }

  return (
    <SettingsRow
      icon={<IconCpu />}
      label={t('settings.agents.preferredModel')}
      description={t('settings.agents.preferredModelHint')}
      keywords="llm provider"
      below={confirm ? <ModelConfirm message={confirm.confirm} busy={Boolean(pending)} onCancel={() => setConfirm(null)} onConfirm={() => void setModel(confirm.provider, confirm.model, true)} /> : undefined}
    >
      <div ref={ref} className="relative">
        <Dropdown label={<span className="max-w-[240px] truncate">{`${providerLabel || t('app.hermes')} · ${shortModel(current, t('settings.agents.automatic'))}`}</span>} onClick={() => ready && setOpen(o => !o)} className={cn(!ready && 'opacity-50')} />
        {open && (
          <div className="float animate-pop absolute top-[calc(100%+6px)] right-0 z-30 flex w-[380px] flex-col rounded-lg" role="dialog" aria-label={t('settings.agents.chooseModel')}>
            <label className="glass-input m-2 flex h-8 items-center gap-2 rounded-lg px-2.5">
              <IconSearch size={14} className="text-fg-3" />
              <input autoFocus value={filter} onChange={event => setFilter(event.target.value)} placeholder={t('settings.agents.filterModels')} aria-label={t('settings.agents.filterModels')} className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-4" />
            </label>
            <div className="flex max-h-[360px] flex-col gap-3 overflow-y-auto px-2 pb-2">
              {options.loading && providers.length === 0 && <div className="px-1 py-2 text-[12px] text-fg-4">{t('settings.agents.loadingModels')}</div>}
              {options.error && <div className="px-1 py-2 text-[12px] text-danger">{options.error}</div>}
              {!options.loading && !options.error && providers.length === 0 && <div className="px-1 py-2 text-[12px] text-fg-4">{t('settings.agents.noModels')}</div>}
              {providers.map(p => (
                <section key={p.slug}>
                  <div className="mb-1 flex items-center gap-2 px-1">
                    <span className="text-[11.5px] font-medium text-fg-2">{p.name}</span>
                    {p.is_current && <Pill tone="accent">{t('settings.agents.current')}</Pill>}
                  </div>
                  <div className="flex flex-col">
                    {p.models.slice(0, 40).map(model => {
                      const active = Boolean(p.is_current) && model === current
                      const busy = pending === `${p.slug}:${model}`

                      return (
                        <button key={model} type="button" disabled={Boolean(pending)} onClick={() => void setModel(p.slug, model)} className={cn('flex items-center justify-between rounded-md px-2 py-1.5 text-left font-mono text-[12px] transition-colors disabled:opacity-60', active ? 'bg-accent-soft text-fg' : 'text-fg-2 hover:bg-white/8 hover:text-fg', busy && 'opacity-60')}>
                          <span className="truncate">{model}</span>
                          {active && <span className="ml-2 text-[10.5px] text-accent-strong">{t('settings.agents.active')}</span>}
                        </button>
                      )
                    })}
                    {(p.total_models ?? 0) > 40 && <span className="px-2 py-1 text-[11px] text-fg-4">{t('settings.agents.moreModels', { count: (p.total_models ?? 0) - 40 })}</span>}
                  </div>
                </section>
              ))}
            </div>
          </div>
        )}
      </div>
    </SettingsRow>
  )
}

// ---- Run on ---------------------------------------------------------------------------------

interface TerminalBackendRow {
  name: string
  label: string
  description?: string
  active?: boolean
  status?: 'ready' | 'needs_setup' | 'unavailable' | string
  detail?: string | null
}

interface TerminalBackendsPayload {
  active: string
  backends: TerminalBackendRow[]
}

const backendLabel = (row: TerminalBackendRow | undefined, name: string) => (name === 'local' ? t('settings.agents.thisDevice') : (row?.label ?? name))

const BACKEND_STATUS: Partial<Record<string, TextKey>> = {
  ready: 'settings.agents.status.ready',
  needs_setup: 'settings.agents.status.needsSetup',
  unavailable: 'settings.agents.status.unavailable'
}

const backendStatus = (status: string) => {
  const key = BACKEND_STATUS[status]

  return key ? t(key) : status.replace('_', ' ')
}

function RunOnRow() {
  const t = useT()
  const backends = useBackendData(() => rest.get<TerminalBackendsPayload>('/api/tools/terminal/backends'))
  const [override, setOverride] = useState<{ base: unknown; active: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const active = override && override.base === backends.data ? override.active : (backends.data?.active ?? 'local')
  const rows = backends.data?.backends ?? []
  const activeRow = rows.find(row => row.name === active)

  const select = async (name: string) => {
    if (name === active) {
      return
    }

    setOverride({ base: backends.data, active: name })
    setBusy(true)

    try {
      await rest.put('/api/tools/terminal/backend', { backend: name })
      markSaved()
      notify({ title: t('settings.agents.backendChanged'), body: t('settings.agents.newSessionsUseIt', { name: backendLabel(rows.find(row => row.name === name), name) }), level: 'success' })
    } catch (error) {
      setOverride(null)
      notify({ title: t('settings.agents.backendFailed'), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      backends.reload()
    }
  }

  const statusTone = (status: string | undefined): PillTone => (status === 'ready' ? 'ok' : status === 'needs_setup' ? 'warn' : 'muted')

  return (
    <SettingsRow icon={<IconCloud />} label={t('settings.agents.runOn')} description={activeRow?.detail && activeRow.status !== 'ready' ? activeRow.detail : t('settings.agents.runOnHint')} keywords="terminal backend execution docker ssh modal cloud local">
      <MenuDropdown
        ariaLabel={t('settings.agents.executionBackend')}
        label={backendLabel(activeRow, active)}
        value={active}
        disabled={busy || rows.length === 0}
        menuClassName="min-w-[300px]"
        items={rows.map(row => ({
          id: row.name,
          label: backendLabel(row, row.name),
          description: row.description,
          trailing: row.status ? <Pill tone={statusTone(row.status)}>{backendStatus(row.status)}</Pill> : undefined
        }))}
        onSelect={name => void select(name)}
      />
    </SettingsRow>
  )
}

// ---- Background agents ---------------------------------------------------------------------

interface HermesConfigPayload {
  delegation?: { max_concurrent_children?: number | string | null; [key: string]: unknown }
  [key: string]: unknown
}

function BackgroundAgentsRow() {
  const t = useT()
  const config = useBackendData(() => rest.get<HermesConfigPayload>('/api/config'))
  const [override, setOverride] = useState<{ base: unknown; value: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const raw = Number(config.data?.delegation?.max_concurrent_children)
  const value = override && override.base === config.data ? override.value : config.data ? (Number.isFinite(raw) && raw >= 1 ? Math.round(raw) : 10) : null

  const change = async (next: number) => {
    setOverride({ base: config.data, value: next })
    setBusy(true)

    try {
      await rest.put('/api/config', { config: { delegation: { max_concurrent_children: next } } })
      markSaved()
    } catch (error) {
      setOverride(null)
      notify({ title: t('settings.agents.backgroundAgentsFailed'), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      config.reload()
    }
  }

  return (
    <SettingsRow icon={<IconUsers />} label={t('settings.agents.backgroundAgents')} description={t('settings.agents.backgroundAgentsHint')} keywords="delegation subagents parallel concurrency">
      <Stepper value={value} onChange={next => void change(next)} min={1} max={32} disabled={busy || value === null} label={t('settings.agents.backgroundAgentsCount')} />
    </SettingsRow>
  )
}

// ---- Remember preferences (memory toolset) -------------------------------------------------

interface ToolsetRow {
  name: string
  label?: string
  enabled?: boolean
  [key: string]: unknown
}

function RememberPreferencesRow() {
  const t = useT()
  const toolsets = useBackendData(() => rest.get<ToolsetRow[]>('/api/tools/toolsets'))
  const [override, setOverride] = useState<{ base: unknown; enabled: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const row = toolsets.data?.find(item => item.name === 'memory')
  const enabled = override && override.base === toolsets.data ? override.enabled : (row?.enabled ?? true)

  const toggle = async (next: boolean) => {
    setOverride({ base: toolsets.data, enabled: next })
    setBusy(true)

    try {
      await rest.put('/api/tools/toolsets/memory', { enabled: next })
      markSaved()
      notify({ title: t(next ? 'overview.memory.on' : 'overview.memory.paused'), body: t(next ? 'settings.agents.memoryOnBody' : 'settings.agents.memoryPausedBody'), level: 'success' })
    } catch (error) {
      setOverride(null)
      notify({ title: t('settings.agents.memoryFailed'), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      toolsets.reload()
    }
  }

  return (
    <SettingsRow icon={<IconFileText />} label={t('settings.agents.rememberPreferences')} description={t('settings.agents.rememberPreferencesHint')} keywords="memory toolset learn">
      <Toggle checked={enabled} onChange={next => void toggle(next)} label={t('settings.agents.rememberPreferences')} disabled={busy || !row} />
    </SettingsRow>
  )
}

// ---- Ask before sending messages (bridge `act` tier) ---------------------------------------

function AskBeforeSendingRow() {
  const t = useT()
  const policy = useLocalData(() => window.heraldOS.bridge.readPolicy())
  const [override, setOverride] = useState<{ base: unknown; confirm: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const tier = policy.data ? readTier(policy.data, 'act') : null
  const confirm = override && override.base === policy.data ? override.confirm : tier === 'confirm' || tier === 'deny'

  const toggle = async (next: boolean) => {
    if (!policy.data) {
      return
    }

    setOverride({ base: policy.data, confirm: next })
    setBusy(true)

    try {
      await window.heraldOS.bridge.writePolicy(withTier(policy.data, 'act', next ? 'confirm' : 'allow'))
      markSaved()
    } catch (error) {
      setOverride(null)
      notify({ title: t('settings.agents.permissionsFailed'), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      policy.reload()
    }
  }

  return (
    <SettingsRow icon={<IconLock />} label={t('settings.agents.askBeforeSending')} description={t('settings.agents.askBeforeSendingHint')} keywords="permissions policy act tier bridge">
      <Toggle checked={confirm} onChange={next => void toggle(next)} label={t('settings.agents.askBeforeSending')} disabled={busy || !policy.data} />
    </SettingsRow>
  )
}

// ---- Activity history (bridge audit) --------------------------------------------------------

function ActivityHistoryRow() {
  const t = useT()
  const [open, setOpen] = useState(false)
  // Only read the log while the panel is open; `open` in deps refetches on every expand.
  const audit = useLocalData(() => (open ? window.heraldOS.bridge.readAudit(200) : Promise.resolve<AuditEntry[]>([])), [open])

  return (
    <SettingsRow
      icon={<IconHistory />}
      label={t('settings.agents.activityHistory')}
      description={t('settings.agents.activityHistoryHint')}
      keywords="audit log bridge actions"
      below={
        open ? (
          <div className="animate-rise flex flex-col gap-2">
            <div className="flex items-center justify-between text-[12px] text-fg-3">
              <span>{t('settings.agents.activityHistoryIntro')}</span>
              <GlassButton size="sm" variant="ghost" onClick={audit.reload}>
                {t('overview.refresh')}
              </GlassButton>
            </div>
            <div className="flex max-h-[320px] flex-col overflow-y-auto rounded-lg border border-line bg-black/20">
              {audit.loading && !audit.data?.length && <div className="p-3 text-[12px] text-fg-4">{t('settings.agents.loading')}</div>}
              {!audit.loading && (audit.data?.length ?? 0) === 0 && <div className="p-3 text-[12px] text-fg-4">{t('settings.agents.noActivity')}</div>}
              {(audit.data ?? []).map((entry, index) => (
                <AuditRow key={`${entry.ts}-${index}`} entry={entry} />
              ))}
            </div>
          </div>
        ) : undefined
      }
    >
      <LinkAction onClick={() => setOpen(o => !o)}>{t(open ? 'settings.agents.hideHistory' : 'settings.agents.viewHistory')}</LinkAction>
    </SettingsRow>
  )
}

export function AuditRow({ entry }: { entry: AuditEntry }) {
  const tone: PillTone = !entry.ok ? 'danger' : entry.decision === 'denied' || entry.decision === 'blocked' ? 'warn' : entry.tier === 'destructive' ? 'warn' : 'muted'

  return (
    <div className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-[12px] last:border-b-0">
      <span className="w-14 shrink-0 text-fg-4">{formatRelative(Date.parse(entry.ts))}</span>
      <span className="w-40 shrink-0 truncate font-mono text-fg-2">
        {entry.tool}
        {entry.action ? `.${entry.action}` : ''}
      </span>
      <Pill tone={tone}>{entry.decision}</Pill>
      <span className="selectable min-w-0 flex-1 truncate text-fg-3">{entry.summary ?? entry.error ?? ''}</span>
    </div>
  )
}
