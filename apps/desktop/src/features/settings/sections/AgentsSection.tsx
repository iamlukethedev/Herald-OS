import { useStore } from '@nanostores/react'
import { IconBolt, IconCloud, IconCpu, IconFileText, IconHistory, IconLock, IconMessage, IconScale, IconSearch, IconUsers } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
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
import { ModelConfirm, ModelProviderRow } from './ProviderRow.tsx'
import { useT } from '../../../store/i18n.ts'
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
 *   bridge policy tier `act`                           -> Ask before sending messages
 *   bridge audit log                                   -> Activity history
 */

export function AgentsSection() {
  const t = useT()
  const connection = useStore($connection)
  const ready = connection === 'open'

  return (
    <>
      <SectionTitle title={t('settings.section.agents')} subtitle={t('settings.agents.subtitle')} />

      <SettingsBlock label="Hermes" description="Personal agent" keywords="status identity ready connecting">
        <GlassCard className="flex items-center gap-3.5 px-4 py-3">
          <HermesAvatar size={44} rounded={11} />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold text-fg">Hermes</div>
            <div className="text-[12px] text-fg-3">Personal agent</div>
            <div className="mt-1 flex items-center gap-1.5 text-[12px] text-fg-2">
              <StatusDot tone={ready ? 'ok' : connection === 'error' || connection === 'closed' ? 'danger' : 'warn'} pulse={!ready} />
              {ready ? 'Ready' : connection === 'connecting' ? 'Connecting' : connection === 'error' ? 'Connection error' : connection === 'closed' ? 'Disconnected' : 'Waiting for Hermes'}
            </div>
          </div>
        </GlassCard>
      </SettingsBlock>

      <AutonomyBlock ready={ready} />

      <SettingsGroup title="Account">
        <ModelProviderRow />
      </SettingsGroup>

      <SettingsGroup title="Model & performance">
        <PreferredModelRow ready={ready} />
        <RunOnRow />
        <BackgroundAgentsRow />
        <ToolSearchRow />
      </SettingsGroup>

      <SettingsGroup title="Privacy & control">
        <RememberPreferencesRow />
        <AskBeforeSendingRow />
        <ActivityHistoryRow />
      </SettingsGroup>
    </>
  )
}

// ---- Autonomy ------------------------------------------------------------------------------

type ApprovalMode = 'manual' | 'smart' | 'off'

const AUTONOMY: { mode: ApprovalMode; label: string; description: string; icon: React.ReactNode }[] = [
  { mode: 'manual', label: 'Ask first', description: 'Confirm each action', icon: <IconMessage /> },
  { mode: 'smart', label: 'Balanced', description: 'Work freely. Ask before sharing.', icon: <IconScale /> },
  { mode: 'off', label: 'Independent', description: 'Follow your saved rules', icon: <IconBolt /> }
]

function normalizeMode(value: unknown): ApprovalMode | null {
  const raw = String(value ?? '').toLowerCase()

  return raw === 'manual' || raw === 'smart' || raw === 'off' ? raw : null
}

function AutonomyBlock({ ready }: { ready: boolean }) {
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
      notify({ title: 'Autonomy updated', body: AUTONOMY.find(item => item.mode === mode)?.label, level: 'success' })
    } catch (error) {
      setOverride(null)
      notify({ title: 'Could not change autonomy', body: errorText(error), level: 'error' })
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
    <SettingsBlock title="Autonomy" label="Autonomy" description="Ask first. Balanced. Independent. How much Hermes checks in before acting." keywords="approvals mode manual smart off yolo confirm">
      <div className="flex gap-3" aria-label="Autonomy">
        {AUTONOMY.map(item => (
          <RadioCard key={item.mode} icon={item.icon} label={item.label} description={item.description} selected={pendingOff ? item.mode === 'off' : current === item.mode} onSelect={() => choose(item.mode)} disabled={!ready || busy} />
        ))}
      </div>
      {pendingOff && (
        <GlassCard className="flex items-center gap-3 px-3.5 py-2.5">
          <InlineNote tone="warn" className="flex-1">
            Hermes will run gated actions without asking.
          </InlineNote>
          <GlassButton size="sm" variant="ghost" onClick={() => setPendingOff(false)}>
            Cancel
          </GlassButton>
          <GlassButton size="sm" variant="primary" onClick={() => void apply('off')} aria-label="Confirm independent mode">
            Confirm
          </GlassButton>
        </GlassCard>
      )}
      {setting.error && <InlineNote tone="danger">Could not read the approval mode: {setting.error}</InlineNote>}
    </SettingsBlock>
  )
}

// ---- Preferred model -----------------------------------------------------------------------

function shortModel(model: string | undefined | null): string {
  if (!model) {
    return 'Automatic'
  }

  return model.includes('/') ? model.slice(model.indexOf('/') + 1) : model
}

function PreferredModelRow({ ready }: { ready: boolean }) {
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
      notify({ title: 'Model changed', body: `${name} · ${change.model}, ${chat ? 'in this chat and new ones' : 'for new conversations'}.`, level: 'success' })
    } catch (error) {
      notify({ title: 'Could not change model', body: errorText(error), level: 'error' })
    } finally {
      setPending(null)
    }
  }

  return (
    <SettingsRow
      icon={<IconCpu />}
      label="Preferred model"
      description="Choose the model Hermes uses for most tasks."
      keywords="llm provider"
      below={confirm ? <ModelConfirm message={confirm.confirm} busy={Boolean(pending)} onCancel={() => setConfirm(null)} onConfirm={() => void setModel(confirm.provider, confirm.model, true)} /> : undefined}
    >
      <div ref={ref} className="relative">
        <Dropdown label={<span className="max-w-[240px] truncate">{providerLabel ? `${providerLabel} · ${shortModel(current)}` : `Hermes · ${shortModel(current)}`}</span>} onClick={() => ready && setOpen(o => !o)} className={cn(!ready && 'opacity-50')} />
        {open && (
          <div className="float animate-pop absolute top-[calc(100%+6px)] right-0 z-30 flex w-[380px] flex-col rounded-lg" role="dialog" aria-label="Choose model">
            <label className="glass-input m-2 flex h-8 items-center gap-2 rounded-lg px-2.5">
              <IconSearch size={14} className="text-fg-3" />
              <input autoFocus value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter models" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-4" />
            </label>
            <div className="flex max-h-[360px] flex-col gap-3 overflow-y-auto px-2 pb-2">
              {options.loading && providers.length === 0 && <div className="px-1 py-2 text-[12px] text-fg-4">Loading models…</div>}
              {options.error && <div className="px-1 py-2 text-[12px] text-danger">{options.error}</div>}
              {!options.loading && !options.error && providers.length === 0 && <div className="px-1 py-2 text-[12px] text-fg-4">No configured models match.</div>}
              {providers.map(p => (
                <section key={p.slug}>
                  <div className="mb-1 flex items-center gap-2 px-1">
                    <span className="text-[11.5px] font-medium text-fg-2">{p.name}</span>
                    {p.is_current && <Pill tone="accent">current</Pill>}
                  </div>
                  <div className="flex flex-col">
                    {p.models.slice(0, 40).map(model => {
                      const active = Boolean(p.is_current) && model === current
                      const busy = pending === `${p.slug}:${model}`

                      return (
                        <button key={model} type="button" disabled={Boolean(pending)} onClick={() => void setModel(p.slug, model)} className={cn('flex items-center justify-between rounded-md px-2 py-1.5 text-left font-mono text-[12px] transition-colors disabled:opacity-60', active ? 'bg-accent-soft text-fg' : 'text-fg-2 hover:bg-white/8 hover:text-fg', busy && 'opacity-60')}>
                          <span className="truncate">{model}</span>
                          {active && <span className="ml-2 text-[10.5px] text-accent-strong">active</span>}
                        </button>
                      )
                    })}
                    {(p.total_models ?? 0) > 40 && <span className="px-2 py-1 text-[11px] text-fg-4">+{(p.total_models ?? 0) - 40} more via /model</span>}
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

const backendLabel = (row: TerminalBackendRow | undefined, name: string) => (name === 'local' ? 'This device' : (row?.label ?? name))

function RunOnRow() {
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
      notify({ title: 'Execution backend changed', body: `${backendLabel(rows.find(row => row.name === name), name)}. New sessions use it.`, level: 'success' })
    } catch (error) {
      setOverride(null)
      notify({ title: 'Could not change backend', body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      backends.reload()
    }
  }

  const statusTone = (status: string | undefined): PillTone => (status === 'ready' ? 'ok' : status === 'needs_setup' ? 'warn' : 'muted')

  return (
    <SettingsRow icon={<IconCloud />} label="Run on" description={activeRow?.detail && activeRow.status !== 'ready' ? activeRow.detail : 'Where agents execute your tasks.'} keywords="terminal backend execution docker ssh modal cloud local">
      <MenuDropdown
        ariaLabel="Execution backend"
        label={backendLabel(activeRow, active)}
        value={active}
        disabled={busy || rows.length === 0}
        menuClassName="min-w-[300px]"
        items={rows.map(row => ({
          id: row.name,
          label: backendLabel(row, row.name),
          description: row.description,
          trailing: row.status ? <Pill tone={statusTone(row.status)}>{row.status.replace('_', ' ')}</Pill> : undefined
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
      notify({ title: 'Could not change background agents', body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      config.reload()
    }
  }

  return (
    <SettingsRow icon={<IconUsers />} label="Background agents" description="Number of concurrent background agents." keywords="delegation subagents parallel concurrency">
      <Stepper value={value} onChange={next => void change(next)} min={1} max={32} disabled={busy || value === null} label="background agents" />
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
      notify({ title: next ? 'Memory on' : 'Memory paused', body: next ? 'Hermes can save memories again.' : 'Hermes stops saving to its own memory, in its CLI too, but still uses it.', level: 'success' })
    } catch (error) {
      setOverride(null)
      notify({ title: 'Could not change memory', body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      toolsets.reload()
    }
  }

  return (
    <SettingsRow icon={<IconFileText />} label="Remember preferences" description="Let Hermes remember your settings and learn from your choices." keywords="memory toolset learn">
      <Toggle checked={enabled} onChange={next => void toggle(next)} label="Remember preferences" disabled={busy || !row} />
    </SettingsRow>
  )
}

// ---- Ask before sending messages (bridge `act` tier) ---------------------------------------

function AskBeforeSendingRow() {
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
      notify({ title: 'Could not update permissions', body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      policy.reload()
    }
  }

  return (
    <SettingsRow icon={<IconLock />} label="Ask before sending messages" description="Get a confirmation before Hermes sends messages on your behalf. Sets the system bridge's “act” tier to confirm." keywords="permissions policy act tier bridge">
      <Toggle checked={confirm} onChange={next => void toggle(next)} label="Ask before sending messages" disabled={busy || !policy.data} />
    </SettingsRow>
  )
}

// ---- Activity history (bridge audit) --------------------------------------------------------

function ActivityHistoryRow() {
  const [open, setOpen] = useState(false)
  // Only read the log while the panel is open; `open` in deps refetches on every expand.
  const audit = useLocalData(() => (open ? window.heraldOS.bridge.readAudit(200) : Promise.resolve<AuditEntry[]>([])), [open])

  return (
    <SettingsRow
      icon={<IconHistory />}
      label="Activity history"
      description="View and manage your past agent activity."
      keywords="audit log bridge actions"
      below={
        open ? (
          <div className="animate-rise flex flex-col gap-2">
            <div className="flex items-center justify-between text-[12px] text-fg-3">
              <span>Every action the system bridge took or refused, newest first.</span>
              <GlassButton size="sm" variant="ghost" onClick={audit.reload}>
                Refresh
              </GlassButton>
            </div>
            <div className="flex max-h-[320px] flex-col overflow-y-auto rounded-lg border border-line bg-black/20">
              {audit.loading && !audit.data?.length && <div className="p-3 text-[12px] text-fg-4">Loading…</div>}
              {!audit.loading && (audit.data?.length ?? 0) === 0 && <div className="p-3 text-[12px] text-fg-4">No bridge activity yet.</div>}
              {(audit.data ?? []).map((entry, index) => (
                <AuditRow key={`${entry.ts}-${index}`} entry={entry} />
              ))}
            </div>
          </div>
        ) : undefined
      }
    >
      <LinkAction onClick={() => setOpen(o => !o)}>{open ? 'Hide history' : 'View history'}</LinkAction>
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
