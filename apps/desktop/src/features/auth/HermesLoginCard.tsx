import { useStore } from '@nanostores/react'
import { IconCheck, IconCopy, IconExternalLink, IconKey, IconRefresh, IconWorld, IconX } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { HermesAvatar } from '../../components/app-icon.tsx'
import { GlassButton, Pill } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import {
  $hermesAuth,
  cancelDeviceLogin,
  completeHermesLogin,
  type DeviceLoginStart,
  type DeviceLoginStatus,
  loginTarget,
  type OAuthProvider,
  pollDeviceLogin,
  refreshHermesAuth,
  snoozeHermesLogin,
  startDeviceLogin
} from '../../store/hermes-auth.ts'
import { focusProvider, providerName, providersChanged, switchToProvider } from '../../store/model-provider.ts'
import { notify } from '../../store/notifications.ts'
import { isPanels } from '../../store/shell.ts'
import { $webWindows, closeWebWindow, focusWebWindow, openWebWindow } from '../../store/web-windows.ts'
import { type Bounds, desktopArea, showPage } from '../../store/windows.ts'
import { errorText, focusSettings } from '../settings/sections/shared.tsx'

/** The card's width plus the gap it keeps from the screen edge and from the sign-in window. */
const CARD_WIDTH = 440
const CARD_GUTTER = 24

/** Sign-in window bounds: fill the desktop area's left side, leaving the card room on the right. */
function signInBounds(): Bounds {
  const area = desktopArea()
  const width = Math.max(480, Math.min(980, area.width - CARD_WIDTH - CARD_GUTTER * 2))
  const height = Math.min(760, area.height)

  return { x: area.x, y: area.y + (area.height - height) / 2, width, height }
}

type Phase = { kind: 'idle' } | { kind: 'starting' } | { kind: 'code'; login: DeviceLoginStart; status: DeviceLoginStatus; error: string | null; secondsLeft: number } | { kind: 'done' } | { kind: 'failed'; message: string }

/** Close the card and show the provider chooser (Settings, or first-run setup while it is up), at `slug`'s setup when given. */
function chooseAnotherProvider(close: () => void, slug?: string): void {
  close()
  showPage('settings')
  focusSettings({ section: 'agents' })
  focusProvider(slug)
}

/**
 * Signed in: a provider other than the active one (picked in Settings, or the first on a fresh
 * install) becomes the one Hermes thinks with, on its recommended model.
 */
async function finishSignIn(provider: OAuthProvider): Promise<void> {
  const auth = await refreshHermesAuth()

  if (auth.activeProvider !== provider.id) {
    try {
      const change = await switchToProvider(provider.id)

      if (!change.ok) {
        notify({ title: `Choose a model for ${provider.name}`, body: `${change.confirm} Pick one in Settings > Hermes & agents > Preferred model.`, level: 'info' })
      }
    } catch (error) {
      notify({ title: `Signed in, but Hermes still uses ${providerName(auth.activeProvider) ?? auth.activeProvider ?? 'its old provider'}`, body: errorText(error), level: 'error' })
    }
  }

  await completeHermesLogin(provider.name)
  providersChanged()
}

/**
 * The OS-level sign-in for Hermes's model provider. Shown when the active provider has no usable
 * credentials (boot check or a failed turn), or for a provider the person picked to sign in to.
 * Runs the runtime's device-code flow: show the code, open the portal in a Herald OS web window
 * beside the card, poll until approved; the runtime persists the credentials itself. The portal
 * never opens in the system browser. When Hermes uses an API key there is nothing to sign in to,
 * and a refused turn sends the person to Settings to replace the key or change provider.
 */
export function HermesLoginCard() {
  const auth = useStore($hermesAuth)
  const webWindows = useStore($webWindows)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)
  const [webId, setWebId] = useState<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionRef = useRef<string | null>(null)
  const webRef = useRef<string | null>(null)
  webRef.current = webId
  const target = loginTarget(auth)
  // The sign-in page is open beside the card (desktop mode); panels mode has its own window.
  const beside = Boolean(webId && webWindows[webId]) && !isPanels

  // Cancel a pending session and close the sign-in page when the card goes away.
  useEffect(
    () => () => {
      if (pollTimer.current) {
        clearTimeout(pollTimer.current)
      }

      if (sessionRef.current) {
        void cancelDeviceLogin(sessionRef.current)
      }

      if (webRef.current) {
        closeWebWindow(webRef.current)
      }
    },
    []
  )

  // A finished sign-in stays mounted (hidden); the next request starts the card fresh.
  useEffect(() => {
    if (auth.needsLogin) {
      setPhase(current => (current.kind === 'done' ? { kind: 'idle' } : current))
    }
  }, [auth.needsLogin])

  // Another provider picked while the card is up gets a sign-in of its own, not this one's code.
  const targetId = target?.id

  useEffect(() => {
    if (sessionRef.current) {
      void cancelDeviceLogin(sessionRef.current)
      sessionRef.current = null
    }

    if (pollTimer.current) {
      clearTimeout(pollTimer.current)
    }

    if (webRef.current) {
      closeWebWindow(webRef.current)
      webRef.current = null
      setWebId(null)
    }

    setPhase(current => (current.kind === 'done' ? current : { kind: 'idle' }))
  }, [targetId])

  if (!auth.needsLogin) {
    return null
  }

  if (!target) {
    return auth.activeProvider ? <ProviderRefusedCard slug={auth.activeProvider} reason={auth.reason} /> : null
  }

  const closeSignInPage = () => {
    if (webRef.current) {
      closeWebWindow(webRef.current)
      webRef.current = null
      setWebId(null)
    }
  }

  /** Show the portal inside Herald OS: raise the existing window, or open one beside the card. */
  const openSignInPage = async (url: string) => {
    if (webRef.current && $webWindows.get()[webRef.current]) {
      focusWebWindow(webRef.current)

      return
    }

    try {
      const id = await openWebWindow(url, { title: `Sign in to ${target.name}`, bounds: signInBounds() })
      webRef.current = id
      setWebId(id)
    } catch {
      // The code stays on the card; the user can try the button again.
      setWebId(null)
    }
  }

  const begin = async () => {
    setPhase({ kind: 'starting' })

    try {
      const login = await startDeviceLogin(target.id)
      sessionRef.current = login.sessionId
      setPhase({ kind: 'code', login, status: 'pending', error: null, secondsLeft: login.expiresIn })
      // The portal URL already carries the code; opening it is the whole gesture for most users.
      closeSignInPage()
      void openSignInPage(login.verificationUrl)
      poll(login)
    } catch (error) {
      setPhase({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const poll = (login: DeviceLoginStart) => {
    const startedAt = Date.now()
    const tick = async () => {
      if (sessionRef.current !== login.sessionId) {
        return
      }

      const secondsLeft = Math.max(0, login.expiresIn - Math.floor((Date.now() - startedAt) / 1000))

      try {
        const result = await pollDeviceLogin(target.id, login.sessionId)

        if (sessionRef.current !== login.sessionId) {
          return
        }

        if (result.status === 'approved') {
          sessionRef.current = null
          setPhase({ kind: 'done' })
          // The portal has done its job; the page closes with the approval.
          closeSignInPage()
          await finishSignIn(target)

          return
        }

        if (result.status !== 'pending' || secondsLeft === 0) {
          sessionRef.current = null
          setPhase({ kind: 'code', login, status: secondsLeft === 0 ? 'expired' : result.status, error: result.error, secondsLeft })

          return
        }

        setPhase({ kind: 'code', login, status: 'pending', error: null, secondsLeft })
      } catch (error) {
        sessionRef.current = null
        setPhase({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })

        return
      }

      pollTimer.current = setTimeout(tick, login.pollInterval * 1000)
    }

    pollTimer.current = setTimeout(tick, login.pollInterval * 1000)
  }

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable; the code is on screen.
    }
  }

  const close = () => {
    if (sessionRef.current) {
      void cancelDeviceLogin(sessionRef.current)
      sessionRef.current = null
    }

    if (pollTimer.current) {
      clearTimeout(pollTimer.current)
    }

    closeSignInPage()
    setPhase({ kind: 'idle' })
    snoozeHermesLogin()
  }

  const others = auth.providers.filter(p => p.id !== target.id && p.loggedIn)
  // Signing in to a provider Hermes does not use yet (picked, or the first on a fresh install) moves Hermes to it.
  const switching = target.id !== auth.activeProvider

  return (
    // With the sign-in page open the card steps aside: no dimming, anchored right, page on the left.
    <div
      className={cn('absolute inset-0 z-(--z-request) flex items-center', beside ? 'pointer-events-none justify-end pr-6' : 'justify-center bg-black/35 backdrop-blur-[2px]')}
      role="dialog"
      aria-modal={!beside}
      aria-labelledby="hermes-login-title"
    >
      <div className={cn('float w-[440px] rounded-2xl p-5 animate-rise', beside && 'pointer-events-auto')}>
        <div className="flex items-start gap-3">
          <HermesAvatar size={36} rounded={10} />
          <div className="min-w-0 flex-1">
            <h2 id="hermes-login-title" className="text-[15px] font-semibold text-fg">
              Sign in to Hermes
            </h2>
            <p className="mt-0.5 text-[12.5px] leading-snug text-fg-2">
              {switching ? (
                <>
                  Sign in to <span className="font-medium text-fg">{target.name}</span> and Hermes thinks with it from then on.
                </>
              ) : (
                <>
                  Hermes uses <span className="font-medium text-fg">{target.name}</span> for its model and is signed out, so it cannot answer until you sign in.
                </>
              )}
            </p>
          </div>
          <button type="button" aria-label="Not now" onClick={close} className="-mt-1 -mr-1 flex size-7 items-center justify-center rounded-md text-fg-3 hover:bg-white/10 hover:text-fg">
            <IconX size={15} />
          </button>
        </div>

        {auth.reason && phase.kind === 'idle' && !switching && <div className="mt-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[11.5px] leading-snug text-warn">{auth.reason}</div>}

        <div className="mt-4">
          {target.flow === 'external' ? (
            <ExternalInstructions name={target.name} command={target.cliCommand} docsUrl={target.docsUrl} />
          ) : phase.kind === 'idle' || phase.kind === 'failed' ? (
            <>
              {phase.kind === 'failed' && <div className="mb-3 text-[12px] text-danger">{phase.message}</div>}
              <GlassButton variant="primary" className="w-full justify-center" onClick={() => void begin()} aria-label={`Sign in with ${target.name}`}>
                <IconKey />
                Sign in with {target.name}
              </GlassButton>
              <p className="mt-2 text-center text-[11.5px] text-fg-3">Opens {target.name} right here in Herald OS with a one-time code. Nothing to type in a terminal.</p>
            </>
          ) : phase.kind === 'starting' ? (
            <div className="flex h-11 items-center justify-center text-[12.5px] text-fg-2">Requesting a sign-in code…</div>
          ) : phase.kind === 'done' ? (
            <div className="flex h-11 items-center justify-center gap-2 text-[13px] text-ok">
              <IconCheck size={16} /> Signed in
            </div>
          ) : (
            <CodePanel phase={phase} copied={copied} beside={beside} onCopy={copyCode} onRetry={() => void begin()} onOpenPage={() => void openSignInPage(phase.login.verificationUrl)} />
          )}
        </div>

        <div className="mt-4 flex items-start justify-between gap-3 border-t border-line pt-3 text-[11.5px] leading-snug text-fg-3">
          <span className="min-w-0 flex-1">
            {others.length > 0 ? (
              <>
                {others.map(p => p.name).join(', ')} {others.length === 1 ? 'is' : 'are'} already signed in.{' '}
              </>
            ) : null}
            <button type="button" className="text-accent-strong hover:underline" onClick={() => chooseAnotherProvider(close)}>
              Use another provider
            </button>
          </span>
          <GlassButton size="sm" variant="ghost" onClick={close} aria-label="Not now">
            Not now
          </GlassButton>
        </div>
      </div>
    </div>
  )
}

/** Hermes uses an API key and a turn was refused for its credentials: nothing to sign in to, so the key or the provider changes in Settings. */
function ProviderRefusedCard({ slug, reason }: { slug: string; reason: string | null }) {
  return (
    <div className="absolute inset-0 z-(--z-request) flex items-center justify-center bg-black/35 backdrop-blur-[2px]" role="dialog" aria-modal aria-labelledby="hermes-refused-title">
      <div className="float w-[440px] rounded-2xl p-5 animate-rise">
        <div className="flex items-start gap-3">
          <HermesAvatar size={36} rounded={10} />
          <div className="min-w-0 flex-1">
            <h2 id="hermes-refused-title" className="text-[15px] font-semibold text-fg">
              Hermes cannot reach its model
            </h2>
            <p className="mt-0.5 text-[12.5px] leading-snug text-fg-2">
              <span className="font-medium text-fg">{providerName(slug) ?? slug}</span> turned Hermes down: the API key Hermes has for it is missing or no longer works. Replace it, or choose another provider.
            </p>
          </div>
          <button type="button" aria-label="Not now" onClick={snoozeHermesLogin} className="-mt-1 -mr-1 flex size-7 items-center justify-center rounded-md text-fg-3 hover:bg-white/10 hover:text-fg">
            <IconX size={15} />
          </button>
        </div>

        {reason && <div className="mt-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[11.5px] leading-snug text-warn">{reason}</div>}

        <div className="mt-4 flex items-center justify-end gap-2 border-t border-line pt-3">
          <GlassButton size="sm" variant="ghost" onClick={snoozeHermesLogin} aria-label="Not now">
            Not now
          </GlassButton>
          <GlassButton size="sm" variant="primary" onClick={() => chooseAnotherProvider(snoozeHermesLogin, slug)}>
            Open Settings
          </GlassButton>
        </div>
      </div>
    </div>
  )
}

function CodePanel({
  phase,
  copied,
  beside,
  onCopy,
  onRetry,
  onOpenPage
}: {
  phase: Extract<Phase, { kind: 'code' }>
  copied: boolean
  /** The sign-in page is open next to the card. */
  beside: boolean
  onCopy: (code: string) => void
  onRetry: () => void
  onOpenPage: () => void
}) {
  const { login, status, error, secondsLeft } = phase
  const pending = status === 'pending'
  const minutes = Math.floor(secondsLeft / 60)
  const seconds = String(secondsLeft % 60).padStart(2, '0')

  return (
    <div className="flex flex-col gap-3">
      <div className="text-center text-[12px] text-fg-2">{beside ? 'Enter this code on the sign-in page beside this card:' : 'Enter this code on the sign-in page:'}</div>
      <button
        type="button"
        onClick={() => onCopy(login.userCode)}
        aria-label="Copy sign-in code"
        title="Copy"
        className="glass-input mx-auto flex h-14 items-center justify-center gap-3 rounded-xl px-6 font-mono text-[26px] font-semibold tracking-[0.18em] text-fg hover:border-line-strong"
      >
        {login.userCode}
        {copied ? <IconCheck size={18} className="text-ok" /> : <IconCopy size={18} className="text-fg-3" />}
      </button>
      <div className="flex items-center justify-center gap-2">
        <GlassButton size="sm" onClick={onOpenPage} aria-label={beside ? 'Show the sign-in page' : 'Open the sign-in page in Herald OS'}>
          <IconWorld />
          {beside ? 'Show sign-in page' : 'Open sign-in page'}
        </GlassButton>
        {!pending && (
          <GlassButton size="sm" variant="primary" onClick={onRetry} aria-label="Get a new code">
            <IconRefresh />
            New code
          </GlassButton>
        )}
      </div>
      <div className={cn('flex items-center justify-center gap-2 text-[11.5px]', pending ? 'text-fg-3' : 'text-warn')}>
        {pending ? (
          <>
            <Pill tone="progress" dot>
              Waiting for approval
            </Pill>
            <span className="tabular-nums">
              code expires in {minutes}:{seconds}
            </span>
          </>
        ) : (
          <span>{status === 'expired' ? 'The code expired.' : status === 'denied' ? 'The sign-in was denied.' : error || 'The sign-in failed.'} Get a new code to try again.</span>
        )}
      </div>
    </div>
  )
}

function ExternalInstructions({ name, command, docsUrl }: { name: string; command: string | null; docsUrl: string | null }) {
  return (
    <div className="flex flex-col gap-2 text-[12.5px] text-fg-2">
      <p>{name} signs in through its own tool; Hermes picks the credentials up automatically afterwards.</p>
      {command && <code className="selectable rounded-lg border border-line bg-black/25 px-3 py-2 font-mono text-[12px] text-fg">{command}</code>}
      {docsUrl && (
        <GlassButton size="sm" onClick={() => void openWebWindow(docsUrl, { title: `${name} sign-in` }).catch(() => undefined)} aria-label={`Open ${name} documentation`}>
          <IconExternalLink />
          How to sign in
        </GlassButton>
      )}
    </div>
  )
}
