import { useStore } from '@nanostores/react'
import { IconCheck, IconExternalLink, IconKey, IconRefresh, IconSearch, IconTerminal2 } from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'
import { Dropdown, GlassButton, LinkAction, Pill } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { type ProviderChoice, type ProviderSetup, providerChoices } from '../../../lib/model-provider.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { $connection } from '../../../store/gateway.ts'
import { $hermesAuth, refreshHermesAuth, requestHermesLogin } from '../../../store/hermes-auth.ts'
import { $providerChanges, $providerFocus, loadKeyCatalog, loadModelOptions, type ModelChange, saveProviderKey, setHermesModel, switchToProvider } from '../../../store/model-provider.ts'
import { notify } from '../../../store/notifications.ts'
import { openWebWindow } from '../../../store/web-windows.ts'
import { openApp, showPage } from '../../../store/windows.ts'
import { errorText, focusSettings, InlineNote, markSaved, SettingsRow, useDismiss } from './shared.tsx'

/*
 * Model provider: the provider Hermes thinks with, and switching it, in Settings > Hermes & agents
 * and in first-run setup. Every provider Hermes knows is offered. One that is set up is used at
 * once, on Hermes's recommended model for it; one that signs in on an account opens the sign-in
 * card; one that takes an API key asks for it here; the rest say what to run.
 */

const SETUP_HINT: Record<ProviderSetup, string> = { key: 'API key', 'sign-in': 'Sign in', terminal: 'Terminal', local: 'This computer' }
const READY: Record<ProviderSetup, { pill: string; text: string }> = {
  key: { pill: 'Key saved', text: 'Uses your API key.' },
  'sign-in': { pill: 'Signed in', text: 'Signed in.' },
  terminal: { pill: 'Signed in', text: 'Signed in through its own tool.' },
  local: { pill: 'Ready', text: 'Runs on this computer.' }
}
const NOT_READY: Record<ProviderSetup, { pill: string; text: string }> = {
  key: { pill: 'No key', text: 'Its API key is missing. Hermes cannot answer until you add one or choose another provider.' },
  'sign-in': { pill: 'Signed out', text: 'Signed out. Hermes cannot answer until you sign in or choose another provider.' },
  terminal: { pill: 'Not signed in', text: 'Not signed in. Hermes cannot answer until it is, or until you choose another provider.' },
  local: { pill: 'Not running', text: 'Not running. Hermes cannot answer until it is, or until you choose another provider.' }
}

/** The last chooser request acted on, so a row that mounts later leaves an old one alone. */
let handledFocus = 0

export function ModelProviderRow() {
  const online = useStore($connection) === 'open'
  const auth = useStore($hermesAuth)
  const changes = useStore($providerChanges)
  const focus = useStore($providerFocus)
  const options = useBackendData(loadModelOptions, [changes], { enabled: online })
  const keys = useBackendData(loadKeyCatalog, [changes])
  const choices = useMemo(() => providerChoices(options.data, auth.providers, keys.data ?? {}), [options.data, auth.providers, keys.data])
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
    const choice = focus.slug ? choices.find(item => item.slug === focus.slug) : undefined

    if (choice && choice.setup !== 'sign-in') {
      openSetup(choice)
    } else {
      setMenuRequest(focus.ts)
    }
  }, [focus, choices])

  const nameOf = (slug: string) => choices.find(choice => choice.slug === slug)?.name ?? slug

  const settle = (change: ModelChange) => {
    if (change.ok) {
      markSaved()
      notify({ title: 'Model provider changed', body: `Hermes now thinks with ${nameOf(change.provider)} (${change.model}).`, level: 'success' })
    } else {
      setConfirm(change)
    }
  }

  const run = async (name: string, change: () => Promise<ModelChange>) => {
    setBusy(true)

    try {
      settle(await change())
    } catch (error) {
      notify({ title: `Could not switch to ${name}`, body: errorText(error), level: 'error' })
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
      requestHermesLogin(`Sign in to ${choice.name} to use it with Hermes.`, choice.slug)
    } else {
      openSetup(choice)
    }
  }

  const refresh = () => {
    void refreshHermesAuth()
    options.reload()
    keys.reload()
  }

  const others = auth.providers.filter(provider => provider.loggedIn && provider.id !== current?.slug).map(provider => provider.name)
  const description = !options.data
    ? !online
      ? 'Waiting for Hermes.'
      : options.error
        ? `Could not read the providers: ${options.error}`
        : 'Checking…'
    : !current
      ? 'Hermes has no model provider yet. Choose one to sign in to, or one to give an API key.'
      : current.ready
        ? `${READY[current.setup].text}${others.length ? ` Also signed in: ${others.join(', ')}.` : ''}`
        : NOT_READY[current.setup].text

  return (
    <SettingsRow
      icon={<IconKey />}
      label="Model provider"
      description={description}
      keywords="provider account sign in login oauth api key nous portal openrouter openai anthropic chatgpt codex gemini switch change llm credentials"
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
          {(current.ready ? READY : NOT_READY)[current.setup].pill}
        </Pill>
      )}
      {current && <CurrentAction current={current} onSetup={openSetup} />}
      <ProviderMenu choices={choices} current={current} loading={options.loading} error={options.error} disabled={!online || busy} busy={busy} request={menuRequest} onPick={pick} />
      <GlassButton size="sm" variant="ghost" onClick={refresh} aria-label="Refresh providers">
        <IconRefresh />
      </GlassButton>
    </SettingsRow>
  )
}

/** The current provider's own next step: sign in, add or replace its key, or set it up. */
function CurrentAction({ current, onSetup }: { current: ProviderChoice; onSetup: (choice: ProviderChoice) => void }) {
  if (current.ready) {
    return current.setup === 'key' ? (
      <GlassButton size="sm" variant="ghost" onClick={() => onSetup(current)} aria-label={`Replace the ${current.name} API key`}>
        New key
      </GlassButton>
    ) : null
  }

  if (current.setup === 'sign-in') {
    return (
      <GlassButton size="sm" variant="primary" onClick={() => requestHermesLogin(`${current.name} is signed out.`, current.slug)} aria-label={`Sign in with ${current.name}`}>
        Sign in
      </GlassButton>
    )
  }

  return (
    <GlassButton size="sm" variant="primary" onClick={() => onSetup(current)}>
      {current.setup === 'key' ? 'Add key' : 'Set up'}
    </GlassButton>
  )
}

function ProviderMenu({ choices, current, loading, error, disabled, busy, request, onPick }: { choices: ProviderChoice[]; current: ProviderChoice | null; loading: boolean; error: string | null; disabled: boolean; busy: boolean; request: number; onPick: (choice: ProviderChoice) => void }) {
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
    { title: 'Ready to use', items: shown.filter(choice => choice.ready) },
    { title: 'Set up first', items: shown.filter(choice => !choice.ready) }
  ].filter(group => group.items.length > 0)

  return (
    <div ref={ref} className="relative">
      <Dropdown label={<span className="max-w-[200px] truncate">{busy ? 'Switching…' : (current?.name ?? 'Choose a provider')}</span>} onClick={() => !disabled && setOpen(o => !o)} className={cn(disabled && 'opacity-50')} />
      {open && (
        <div className="float animate-pop absolute top-[calc(100%+6px)] right-0 z-30 flex w-[340px] flex-col rounded-lg" role="dialog" aria-label="Choose a model provider">
          <label className="glass-input m-2 flex h-8 items-center gap-2 rounded-lg px-2.5">
            <IconSearch size={14} className="text-fg-3" />
            <input autoFocus value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter providers" aria-label="Filter providers" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-4" />
          </label>
          <div className="flex max-h-[360px] flex-col gap-3 overflow-y-auto px-2 pb-2">
            {loading && choices.length === 0 && <div className="px-1 py-2 text-[12px] text-fg-4">Loading providers…</div>}
            {error && <div className="px-1 py-2 text-[12px] text-danger">{error}</div>}
            {!loading && !error && shown.length === 0 && <div className="px-1 py-2 text-[12px] text-fg-4">No provider matches.</div>}
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
                      {!choice.ready && <span className="shrink-0 text-[11px] text-fg-4">{SETUP_HINT[choice.setup]}</span>}
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
        Paste your {choice.name} API key. Hermes keeps it on this computer, as <span className="font-mono">{choice.keyEnv}</span> in its own settings.
      </div>
      <div className="flex items-center gap-2">
        <input type="password" value={key} onChange={event => setKey(event.target.value)} autoFocus autoComplete="off" spellCheck={false} placeholder="API key" aria-label={`${choice.name} API key`} className="glass-input h-8 min-w-0 flex-1 rounded-lg px-2.5 font-mono text-[12px] text-fg outline-none placeholder:text-fg-4" />
        <GlassButton size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </GlassButton>
        <GlassButton size="sm" variant="primary" type="submit" disabled={saving || !key.trim()}>
          {saving ? 'Saving…' : 'Save and use'}
        </GlassButton>
      </div>
      {error && <InlineNote tone="danger">{error}</InlineNote>}
      {choice.helpUrl && <LinkAction onClick={() => openHelp(choice)}>Get a {choice.name} API key</LinkAction>}
    </form>
  )
}

/** A provider that signs in through its own tool, or runs on this computer: what to do, then use it. */
function OtherSetup({ choice, onCancel, onDone }: { choice: ProviderChoice; onCancel: () => void; onDone: (change: ModelChange) => void }) {
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
        <p>{choice.name} runs on this computer. Start it and load a model, or pick a local model in Settings &gt; Software.</p>
      ) : (
        <>
          <p>{choice.name} signs in through its own tool. Run this in the Terminal, then use it here:</p>
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
            Open Software
          </GlassButton>
        ) : (
          <GlassButton size="sm" onClick={() => openApp('terminal')}>
            <IconTerminal2 />
            Open Terminal
          </GlassButton>
        )}
        {choice.helpUrl && (
          <GlassButton size="sm" variant="ghost" onClick={() => openHelp(choice)} aria-label={`How ${choice.name} signs in`}>
            <IconExternalLink />
            How it works
          </GlassButton>
        )}
        <span className="flex-1" />
        <GlassButton size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </GlassButton>
        <GlassButton size="sm" variant="primary" onClick={() => void check()} disabled={checking}>
          {checking ? 'Checking…' : `Use ${choice.name}`}
        </GlassButton>
      </div>
    </div>
  )
}

/** A model Hermes warns about (far pricier than most): say so, and switch only when the person agrees. */
export function ModelConfirm({ message, busy, onCancel, onConfirm }: { message: string; busy?: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="animate-rise flex items-center gap-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2">
      <InlineNote tone="warn" className="selectable flex-1 whitespace-pre-line">
        {message}
      </InlineNote>
      <GlassButton size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </GlassButton>
      <GlassButton size="sm" variant="primary" onClick={onConfirm} disabled={busy} aria-label="Use this model anyway">
        Use it anyway
      </GlassButton>
    </div>
  )
}
