import { useStore } from '@nanostores/react'
import { IconCheck, IconExternalLink, IconKey, IconRefresh, IconSearch, IconTerminal2 } from '@tabler/icons-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { TextKey } from '../../../../shared/i18n.ts'
import { Dropdown, GlassButton, LinkAction, Pill } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { type ProviderChoice, type ProviderSetup, providerChoices } from '../../../lib/model-provider.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { $connection } from '../../../store/gateway.ts'
import { $hermesAuth, refreshHermesAuth, requestHermesLogin } from '../../../store/hermes-auth.ts'
import { useT } from '../../../store/i18n.ts'
import { $providerChanges, $providerFocus, loadEndpointKeys, loadKeyCatalog, loadModelOptions, type ModelChange, providerSlug, saveProviderKey, setHermesModel, switchToProvider } from '../../../store/model-provider.ts'
import { notify } from '../../../store/notifications.ts'
import { openWebWindow } from '../../../store/web-windows.ts'
import { openApp, showPage } from '../../../store/windows.ts'
import { errorText, focusSettings, InlineNote, markSaved, SettingsRow, useDismiss } from './shared.tsx'

/*
 * Model provider: the provider Hermes thinks with, and switching it, in Settings > Hermes & agents
 * and in first-run setup. Every provider Hermes knows is offered. One that is set up is used at
 * once, on Hermes's recommended model for it; one that signs in on an account opens the sign-in
 * card; one that takes an API key asks for it here, a custom endpoint whose entry names a key
 * variable included; the rest say what to run.
 */

const SETUP_HINT: Record<ProviderSetup, TextKey> = {
  key: 'settings.agents.provider.apiKey',
  'sign-in': 'settings.agents.provider.signIn',
  terminal: 'app.terminal',
  local: 'settings.agents.provider.thisComputer',
  endpoint: 'settings.agents.provider.yourEndpoint'
}
const READY: Record<ProviderSetup, { pill: TextKey; text: TextKey }> = {
  key: { pill: 'settings.agents.provider.keySaved', text: 'settings.agents.provider.usesKey' },
  'sign-in': { pill: 'settings.agents.provider.signedIn', text: 'settings.agents.provider.signedInText' },
  terminal: { pill: 'settings.agents.provider.signedIn', text: 'settings.agents.provider.signedInTool' },
  local: { pill: 'settings.agents.ready', text: 'settings.agents.provider.runsLocally' },
  endpoint: { pill: 'settings.agents.ready', text: 'settings.agents.provider.usesEndpoint' }
}
const NOT_READY: Record<ProviderSetup, { pill: TextKey; text: TextKey }> = {
  key: { pill: 'settings.agents.provider.noKey', text: 'settings.agents.provider.noKeyText' },
  'sign-in': { pill: 'settings.agents.provider.signedOut', text: 'settings.agents.provider.signedOutText' },
  terminal: { pill: 'settings.agents.provider.notSignedIn', text: 'settings.agents.provider.notSignedInText' },
  local: { pill: 'settings.agents.provider.notRunning', text: 'settings.agents.provider.notRunningText' },
  endpoint: { pill: 'settings.agents.provider.notSetUp', text: 'settings.agents.provider.notSetUpText' }
}

// Stand-ins for the `{slots}` a message shows in monospace; no translation contains them.
const CODE = ['\u0000', '\u0001']

/** A message with CODE stand-ins in its slots, the stand-ins drawn as `codes` in monospace. */
function withCode(text: string, codes: string[]): ReactNode[] {
  return text.split(/([\u0000\u0001])/).map((part, index) => {
    const code = CODE.indexOf(part)

    return code >= 0 ? (
      <span key={index} className="font-mono">
        {codes[code]}
      </span>
    ) : (
      part
    )
  })
}

/** The last chooser request acted on, so a row that mounts later leaves an old one alone. */
let handledFocus = 0

export function ModelProviderRow() {
  const t = useT()
  const online = useStore($connection) === 'open'
  const auth = useStore($hermesAuth)
  const changes = useStore($providerChanges)
  const focus = useStore($providerFocus)
  const options = useBackendData(loadModelOptions, [changes], { enabled: online })
  const keys = useBackendData(loadKeyCatalog, [changes])
  const endpoints = useBackendData(loadEndpointKeys, [changes])
  const choices = useMemo(() => providerChoices(options.data, auth.providers, keys.data ?? {}, endpoints.data ?? {}), [options.data, auth.providers, keys.data, endpoints.data])
  const current = choices.find(choice => choice.current) ?? null
  const [setup, setSetup] = useState<ProviderChoice | null>(null)
  const [confirm, setConfirm] = useState<Extract<ModelChange, { ok: false }> | null>(null)
  const [busy, setBusy] = useState(false)
  const [menuRequest, setMenuRequest] = useState(0)

  const openSetup = (choice: ProviderChoice) => {
    setConfirm(null)
    setSetup(choice)
  }

  // The sign-in card, setup or a command asked for the chooser, or for one provider's setup (its
  // key form even when a key is saved: the card sends a refused one here to be replaced).
  useEffect(() => {
    if (!focus || focus.ts <= handledFocus || choices.length === 0) {
      return
    }

    handledFocus = focus.ts
    const slug = focus.slug && providerSlug(focus.slug)
    const choice = slug ? choices.find(item => item.slug === slug) : undefined

    if (choice && choice.setup !== 'sign-in') {
      openSetup(choice)
    } else {
      setMenuRequest(focus.ts)
    }
  }, [focus, choices])

  const nameOf = (slug: string) => choices.find(choice => choice.slug === providerSlug(slug))?.name ?? slug

  const settle = (change: ModelChange) => {
    if (change.ok) {
      markSaved()
      notify({ title: t('settings.agents.provider.changed'), body: t('settings.agents.provider.changedBody', { provider: nameOf(change.provider), model: change.model }), level: 'success' })
    } else {
      setConfirm(change)
    }
  }

  const run = async (name: string, change: () => Promise<ModelChange>) => {
    setBusy(true)

    try {
      settle(await change())
    } catch (error) {
      notify({ title: t('settings.agents.provider.switchFailed', { name }), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const pick = (choice: ProviderChoice) => {
    setConfirm(null)
    setSetup(null)

    if (choice.ready) {
      if (!choice.current) {
        void run(choice.name, () => switchToProvider(choice.slug))
      }
    } else if (choice.setup === 'sign-in') {
      requestHermesLogin(t('settings.agents.provider.signInPrompt', { name: choice.name }), choice.slug)
    } else {
      openSetup(choice)
    }
  }

  const refresh = () => {
    void refreshHermesAuth()
    options.reload()
    keys.reload()
    endpoints.reload()
  }

  const others = auth.providers.filter(provider => provider.loggedIn && provider.id !== current?.slug).map(provider => provider.name)
  const description = !options.data
    ? !online
      ? t('menuBar.waitingForHermes')
      : options.error
        ? t('settings.agents.provider.unreadable', { error: options.error })
        : t('settings.agents.provider.checking')
    : !current
      ? t('settings.agents.provider.none')
      : current.ready
        ? [t(READY[current.setup].text), ...(others.length ? [t('settings.agents.provider.alsoSignedIn', { names: others.join(', ') })] : [])].join(' ')
        : t(NOT_READY[current.setup].text)

  return (
    <SettingsRow
      icon={<IconKey />}
      label={t('settings.agents.provider.label')}
      description={description}
      keywords="provider account sign in login oauth api key nous portal openrouter openai anthropic chatgpt codex gemini switch change llm credentials custom endpoint server key_env"
      below={
        confirm ? (
          <ModelConfirm
            message={confirm.confirm}
            busy={busy}
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              setConfirm(null)
              void run(nameOf(confirm.provider), () => setHermesModel(confirm.provider, confirm.model, true))
            }}
          />
        ) : setup ? (
          <SetupPanel
            key={setup.slug}
            choice={setup}
            onCancel={() => setSetup(null)}
            onDone={change => {
              setSetup(null)
              settle(change)
            }}
          />
        ) : undefined
      }
    >
      {current && (
        <Pill tone={current.ready ? 'ok' : 'warn'} dot>
          {t((current.ready ? READY : NOT_READY)[current.setup].pill)}
        </Pill>
      )}
      {current && <CurrentAction current={current} onSetup={openSetup} />}
      <ProviderMenu choices={choices} current={current} loading={options.loading} error={options.error} disabled={!online || busy} busy={busy} request={menuRequest} onPick={pick} />
      <GlassButton size="sm" variant="ghost" onClick={refresh} aria-label={t('settings.agents.provider.refresh')}>
        <IconRefresh />
      </GlassButton>
    </SettingsRow>
  )
}

/** The current provider's own next step: sign in, add or replace its key, or set it up. */
function CurrentAction({ current, onSetup }: { current: ProviderChoice; onSetup: (choice: ProviderChoice) => void }) {
  const t = useT()

  if (current.ready) {
    return current.setup === 'key' ? (
      <GlassButton size="sm" variant="ghost" onClick={() => onSetup(current)} aria-label={t('settings.agents.provider.replaceKey', { name: current.name })}>
        {t('settings.agents.provider.newKey')}
      </GlassButton>
    ) : null
  }

  if (current.setup === 'sign-in') {
    return (
      <GlassButton size="sm" variant="primary" onClick={() => requestHermesLogin(t('settings.agents.provider.signedOutPrompt', { name: current.name }), current.slug)} aria-label={t('settings.agents.provider.signInWith', { name: current.name })}>
        {t('settings.agents.provider.signIn')}
      </GlassButton>
    )
  }

  return (
    <GlassButton size="sm" variant="primary" onClick={() => onSetup(current)}>
      {t(current.setup === 'key' ? 'settings.agents.provider.addKey' : 'settings.agents.provider.setUp')}
    </GlassButton>
  )
}

function ProviderMenu({ choices, current, loading, error, disabled, busy, request, onPick }: { choices: ProviderChoice[]; current: ProviderChoice | null; loading: boolean; error: string | null; disabled: boolean; busy: boolean; request: number; onPick: (choice: ProviderChoice) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const ref = useDismiss(open, () => setOpen(false))

  useEffect(() => {
    if (request) {
      setOpen(true)
    }
  }, [request])

  const q = filter.trim().toLowerCase()
  const shown = q ? choices.filter(choice => choice.name.toLowerCase().includes(q) || choice.slug.includes(q)) : choices
  const groups = [
    { title: t('settings.agents.provider.readyToUse'), items: shown.filter(choice => choice.ready) },
    { title: t('settings.agents.provider.setUpFirst'), items: shown.filter(choice => !choice.ready) }
  ].filter(group => group.items.length > 0)

  return (
    <div ref={ref} className="relative">
      <Dropdown label={<span className="max-w-[200px] truncate">{busy ? t('settings.agents.provider.switching') : (current?.name ?? t('settings.agents.provider.choose'))}</span>} onClick={() => !disabled && setOpen(o => !o)} className={cn(disabled && 'opacity-50')} />
      {open && (
        <div className="float animate-pop absolute top-[calc(100%+6px)] right-0 z-30 flex w-[340px] flex-col rounded-lg" role="dialog" aria-label={t('settings.agents.provider.chooseLabel')}>
          <label className="glass-input m-2 flex h-8 items-center gap-2 rounded-lg px-2.5">
            <IconSearch size={14} className="text-fg-3" />
            <input autoFocus value={filter} onChange={event => setFilter(event.target.value)} placeholder={t('settings.agents.provider.filter')} aria-label={t('settings.agents.provider.filter')} className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-4" />
          </label>
          <div className="flex max-h-[360px] flex-col gap-3 overflow-y-auto px-2 pb-2">
            {loading && choices.length === 0 && <div className="px-1 py-2 text-[12px] text-fg-4">{t('settings.agents.provider.loading')}</div>}
            {error && <div className="px-1 py-2 text-[12px] text-danger">{error}</div>}
            {!loading && !error && shown.length === 0 && <div className="px-1 py-2 text-[12px] text-fg-4">{t('settings.agents.provider.noMatch')}</div>}
            {groups.map(group => (
              <section key={group.title}>
                <div className="mb-1 px-1 text-[11.5px] font-medium text-fg-2">{group.title}</div>
                <div className="flex flex-col" role="listbox" aria-label={group.title}>
                  {group.items.map(choice => (
                    <button
                      key={choice.slug}
                      type="button"
                      role="option"
                      aria-selected={choice.current}
                      data-os-target={`provider:${choice.slug}`}
                      onClick={() => {
                        setOpen(false)
                        setFilter('')
                        onPick(choice)
                      }}
                      className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors', choice.current ? 'bg-accent-soft text-fg' : 'text-fg-2 hover:bg-white/8 hover:text-fg')}
                    >
                      <span className="min-w-0 flex-1 truncate">{choice.name}</span>
                      {!choice.ready && <span className="shrink-0 text-[11px] text-fg-4">{t(SETUP_HINT[choice.setup])}</span>}
                      {choice.current && <IconCheck size={14} className="shrink-0 text-accent-strong" />}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function openHelp(choice: ProviderChoice): void {
  if (choice.helpUrl) {
    void openWebWindow(choice.helpUrl, { title: choice.name }).catch(() => undefined)
  }
}

function SetupPanel({ choice, onCancel, onDone }: { choice: ProviderChoice; onCancel: () => void; onDone: (change: ModelChange) => void }) {
  return choice.setup === 'key' ? <KeyForm choice={choice} onCancel={onCancel} onDone={onDone} /> : <OtherSetup choice={choice} onCancel={onCancel} onDone={onDone} />
}

function KeyForm({ choice, onCancel, onDone }: { choice: ProviderChoice; onCancel: () => void; onDone: (change: ModelChange) => void }) {
  const t = useT()
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    setError(null)

    try {
      const change = await saveProviderKey(choice, key)
      setKey('')
      onDone(change)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="animate-rise flex flex-col gap-2 rounded-lg border border-line bg-black/20 p-3"
      onSubmit={event => {
        event.preventDefault()
        void save()
      }}
    >
      <div className="text-[12px] leading-snug text-fg-2">
        {withCode(t('settings.agents.provider.pasteKey', { name: choice.name, variable: CODE[0] }), [choice.keyEnv ?? ''])}
      </div>
      <div className="flex items-center gap-2">
        <input type="password" value={key} onChange={event => setKey(event.target.value)} autoFocus autoComplete="off" spellCheck={false} placeholder={t('settings.agents.provider.apiKey')} aria-label={t('settings.agents.provider.keyFor', { name: choice.name })} className="glass-input h-8 min-w-0 flex-1 rounded-lg px-2.5 font-mono text-[12px] text-fg outline-none placeholder:text-fg-4" />
        <GlassButton size="sm" variant="ghost" onClick={onCancel}>
          {t('settings.cancel')}
        </GlassButton>
        <GlassButton size="sm" variant="primary" type="submit" disabled={saving || !key.trim()}>
          {t(saving ? 'settings.agents.provider.saving' : 'settings.agents.provider.saveAndUse')}
        </GlassButton>
      </div>
      {error && <InlineNote tone="danger">{error}</InlineNote>}
      {choice.helpUrl && <LinkAction onClick={() => openHelp(choice)}>{t('settings.agents.provider.getKey', { name: choice.name })}</LinkAction>}
    </form>
  )
}

/** A provider that signs in through its own tool, runs on this computer, or is the person's own endpoint: what to do, then use it. */
function OtherSetup({ choice, onCancel, onDone }: { choice: ProviderChoice; onCancel: () => void; onDone: (change: ModelChange) => void }) {
  const t = useT()
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const local = choice.setup === 'local'

  const check = async () => {
    setChecking(true)
    setError(null)

    try {
      onDone(await switchToProvider(choice.slug))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="animate-rise flex flex-col gap-2 rounded-lg border border-line bg-black/20 p-3 text-[12px] leading-snug text-fg-2">
      {local ? (
        <p>{t('settings.agents.provider.localSetup', { name: choice.name })}</p>
      ) : choice.setup === 'endpoint' ? (
        <p>{withCode(t('settings.agents.provider.endpointSetup', { name: choice.name, field: CODE[0], command: CODE[1] }), ['key_env', 'hermes config edit'])}</p>
      ) : (
        <>
          <p>{t('settings.agents.provider.terminalSetup', { name: choice.name })}</p>
          <code className="selectable rounded-lg border border-line bg-black/25 px-3 py-2 font-mono text-[12px] text-fg">{choice.command}</code>
        </>
      )}
      {error && <InlineNote tone="danger">{error}</InlineNote>}
      <div className="flex flex-wrap items-center gap-2">
        {local ? (
          <GlassButton
            size="sm"
            onClick={() => {
              showPage('settings')
              focusSettings({ section: 'software' })
            }}
          >
            {t('settings.agents.provider.openSoftware')}
          </GlassButton>
        ) : (
          <GlassButton size="sm" onClick={() => openApp('terminal')}>
            <IconTerminal2 />
            {t('settings.agents.provider.openTerminal')}
          </GlassButton>
        )}
        {choice.helpUrl && (
          <GlassButton size="sm" variant="ghost" onClick={() => openHelp(choice)} aria-label={t('settings.agents.provider.howSignsIn', { name: choice.name })}>
            <IconExternalLink />
            {t('settings.agents.provider.howItWorks')}
          </GlassButton>
        )}
        <span className="flex-1" />
        <GlassButton size="sm" variant="ghost" onClick={onCancel}>
          {t('settings.cancel')}
        </GlassButton>
        <GlassButton size="sm" variant="primary" onClick={() => void check()} disabled={checking}>
          {checking ? t('settings.agents.provider.checking') : t('settings.agents.provider.use', { name: choice.name })}
        </GlassButton>
      </div>
    </div>
  )
}

/** A model Hermes warns about (far pricier than most): say so, and switch only when the person agrees. */
export function ModelConfirm({ message, busy, onCancel, onConfirm }: { message: string; busy?: boolean; onCancel: () => void; onConfirm: () => void }) {
  const t = useT()

  return (
    <div className="animate-rise flex items-center gap-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2">
      <InlineNote tone="warn" className="selectable flex-1 whitespace-pre-line">
        {message}
      </InlineNote>
      <GlassButton size="sm" variant="ghost" onClick={onCancel}>
        {t('settings.cancel')}
      </GlassButton>
      <GlassButton size="sm" variant="primary" onClick={onConfirm} disabled={busy} aria-label={t('settings.agents.provider.useModelAnyway')}>
        {t('settings.agents.provider.useAnyway')}
      </GlassButton>
    </div>
  )
}
