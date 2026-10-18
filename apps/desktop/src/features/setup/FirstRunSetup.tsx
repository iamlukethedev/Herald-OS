import { useStore } from '@nanostores/react'
import { IconArrowRight, IconCheck, IconGift, IconLock, IconUser, IconWifi } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { HeraldLogo } from '../../components/herald-logo.tsx'
import { GlassButton, GlassCard, LinkAction } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import type { PasswordFailure, SetupResult } from '../../../shared/ipc.ts'
import type { TextKey } from '../../../shared/i18n.ts'
import { $hermesAuth, refreshHermesAuth, requestHermesLogin } from '../../store/hermes-auth.ts'
import { t, useT } from '../../store/i18n.ts'
import { $providerFocus, providerName } from '../../store/model-provider.ts'
import { ModelProviderRow } from '../settings/sections/ProviderRow.tsx'
import { StatusPanel } from '../status/StatusPanel.tsx'

type Step = 'welcome' | 'account' | 'wifi' | 'hermes' | 'done'

/**
 * First-boot setup on the Herald OS image: who the computer is for, their name and password,
 * Wi-Fi, and Hermes's sign-in. Setting it up for someone else skips the account and leaves setup
 * waiting for them at the next start.
 */
export function FirstRunSetup() {
  const t = useT()
  const [due, setDue] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [step, setStep] = useState<Step>('welcome')
  const [forSomeoneElse, setForSomeoneElse] = useState(false)
  // Kept here: the Hermes step unmounts while the sign-in card is up.
  const [otherProvider, setOtherProvider] = useState(false)
  const auth = useStore($hermesAuth)
  const providerFocus = useStore($providerFocus)

  useEffect(() => {
    void window.heraldOS.setup
      ?.state()
      .then(state => {
        setDue(state.needed)
        setSignedIn(state.signedIn)
      })
      .catch(() => undefined)
  }, [])

  // The sign-in card's "Use another provider" lands on the Hermes step while setup is up.
  useEffect(() => {
    if (providerFocus) {
      setOtherProvider(true)
    }
  }, [providerFocus])

  if (!due) {
    return null
  }

  // Signing in happens on Hermes's own card; setup steps aside until it is done.
  if (step === 'hermes' && auth.needsLogin) {
    return null
  }

  const finish = async () => {
    await window.heraldOS.setup.finish({ later: forSomeoneElse })
    setDue(false)
  }

  const steps: Step[] = forSomeoneElse ? ['welcome', 'wifi', 'done'] : ['welcome', 'account', 'wifi', 'hermes', 'done']
  const next = () => setStep(steps[Math.min(steps.length - 1, steps.indexOf(step) + 1)] ?? 'done')

  return (
    <div className="absolute inset-0 z-(--z-boot) flex items-center justify-center bg-bg/85 backdrop-blur-md animate-fade-in" role="dialog" aria-label={t('firstRun.label')}>
      <div className="float flex w-[min(560px,92vw)] flex-col gap-5 rounded-2xl p-7">
        <div className="flex items-center gap-3">
          <HeraldLogo height={22} />
          <span className="flex-1" />
          <div className="flex gap-1.5" aria-hidden>
            {steps.map(item => (
              <span key={item} className={cn('h-1.5 w-6 rounded-full bg-white/15', steps.indexOf(item) <= steps.indexOf(step) && 'bg-accent-strong')} />
            ))}
          </div>
        </div>

        {step === 'welcome' && (
          <Welcome
            signedIn={signedIn}
            onChoose={someoneElse => {
              setForSomeoneElse(someoneElse)
              setStep(someoneElse ? 'wifi' : 'account')
            }}
          />
        )}
        {step === 'account' && <Account onDone={next} signedIn={signedIn} />}
        {step === 'wifi' && (
          <div className="flex flex-col gap-4">
            <Heading icon={<IconWifi size={18} />} title={t('firstRun.wifi.title')} text={t('firstRun.wifi.text')} />
            <div className="max-h-[320px] overflow-y-auto rounded-xl">
              <StatusPanel panel="wifi" />
            </div>
            <Footer onNext={next} label={t('firstRun.next')} />
          </div>
        )}
        {step === 'hermes' && <HermesStep onDone={next} choosing={otherProvider} onChoose={() => setOtherProvider(true)} />}
        {step === 'done' && (
          <div className="flex flex-col gap-4">
            <Heading
              icon={forSomeoneElse ? <IconGift size={18} /> : <IconCheck size={18} />}
              title={t(forSomeoneElse ? 'firstRun.handOver.title' : 'firstRun.done.title')}
              text={t(forSomeoneElse ? 'firstRun.handOver.text' : 'firstRun.done.text')}
            />
            <Footer onNext={() => void finish()} label={t(forSomeoneElse ? 'firstRun.handOver.done' : 'firstRun.done.start')} />
          </div>
        )}
      </div>
    </div>
  )
}

function Heading({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-fg">
        <span className="icon-tile size-8 rounded-lg">{icon}</span>
        <h2 className="text-[19px] font-semibold tracking-tight">{title}</h2>
      </div>
      <p className="text-[13px] leading-relaxed text-fg-3">{text}</p>
    </div>
  )
}

function Footer({ onNext, label, busy, disabled }: { onNext: () => void; label: string; busy?: boolean; disabled?: boolean }) {
  return (
    <div className="flex justify-end">
      <GlassButton variant="primary" onClick={onNext} disabled={busy || disabled}>
        {busy ? <Spinner /> : null} {label} <IconArrowRight size={15} />
      </GlassButton>
    </div>
  )
}

function Welcome({ onChoose, signedIn }: { onChoose: (someoneElse: boolean) => void; signedIn: boolean }) {
  const t = useT()

  return (
    <div className="flex flex-col gap-4">
      <Heading icon={<IconUser size={18} />} title={t('firstRun.welcome.title')} text={t('firstRun.welcome.text')} />
      <div className="grid grid-cols-2 gap-3">
        <button type="button" onClick={() => onChoose(false)} className="glass-input flex flex-col items-start gap-1 rounded-xl p-4 text-left hover:border-line-strong">
          <span className="text-[14px] font-medium text-fg">{t('firstRun.welcome.forMe')}</span>
          <span className="text-[12px] text-fg-3">{t(signedIn ? 'firstRun.welcome.forMeSignedInHint' : 'firstRun.welcome.forMeHint')}</span>
        </button>
        <button type="button" onClick={() => onChoose(true)} className="glass-input flex flex-col items-start gap-1 rounded-xl p-4 text-left hover:border-line-strong">
          <span className="text-[14px] font-medium text-fg">{t('firstRun.welcome.forSomeoneElse')}</span>
          <span className="text-[12px] text-fg-3">{t('firstRun.welcome.forSomeoneElseHint')}</span>
        </button>
      </div>
    </div>
  )
}

const PASSWORD_FAILURES: Record<Exclude<PasswordFailure, 'refused'>, TextKey> = {
  tooShort: 'firstRun.account.tooShort',
  timeout: 'firstRun.account.timeout',
  noTerminal: 'firstRun.account.noTerminal',
  failed: 'firstRun.account.passwordNotSet'
}

/** Why the password was not set, in the person's language; pwquality's reason is the only text taken from the system. */
function passwordError({ reason, detail }: SetupResult): string {
  if (reason === 'refused') {
    const why = detail?.trim()

    return why ? t('firstRun.account.refused', { reason: why.replace(/\.$/, '') }) : t('firstRun.account.refusedNoReason')
  }

  return t(reason && Object.hasOwn(PASSWORD_FAILURES, reason) ? PASSWORD_FAILURES[reason] : 'firstRun.account.passwordNotSet')
}

/** The name, and the password unless the account signed in at a login screen with one of its own. */
function Account({ onDone, signedIn }: { onDone: () => void; signedIn: boolean }) {
  const t = useT()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<SetupResult | null>(null)
  const [busy, setBusy] = useState(false)
  const mismatch = again.length > 0 && password !== again

  const save = async () => {
    setBusy(true)
    setError(null)

    try {
      await window.heraldOS.setup.name(name)
      const result = signedIn ? { ok: true } : await window.heraldOS.setup.password(password)

      if (result.ok) {
        onDone()
      } else {
        setError(result)
      }
    } catch {
      setError({ ok: false, reason: 'failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={event => {
        event.preventDefault()
        void save()
      }}
    >
      <Heading
        icon={<IconLock size={18} />}
        title={t(signedIn ? 'firstRun.account.titleSignedIn' : 'firstRun.account.title')}
        text={t(signedIn ? 'firstRun.account.textSignedIn' : 'firstRun.account.text')}
      />
      <label className="flex flex-col gap-1.5 text-[12px] text-fg-3">
        {t('firstRun.account.name')}
        <input value={name} onChange={event => setName(event.target.value)} autoFocus autoComplete="name" className="glass-input h-10 rounded-lg px-3 text-[14px] text-fg outline-none" />
      </label>
      {!signedIn && (
        <>
          <label className="flex flex-col gap-1.5 text-[12px] text-fg-3">
            {t('firstRun.account.password')}
            <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" className="glass-input h-10 rounded-lg px-3 text-[14px] text-fg outline-none" />
          </label>
          <label className="flex flex-col gap-1.5 text-[12px] text-fg-3">
            {t('firstRun.account.passwordAgain')}
            <input type="password" value={again} onChange={event => setAgain(event.target.value)} autoComplete="new-password" className="glass-input h-10 rounded-lg px-3 text-[14px] text-fg outline-none" />
          </label>
        </>
      )}
      {(error || mismatch) && <p className="text-[12.5px] text-danger">{mismatch ? t('firstRun.account.mismatch') : signedIn ? t('firstRun.account.nameNotSaved') : error && passwordError(error)}</p>}
      <Footer onNext={() => void save()} label={t('firstRun.next')} busy={busy} disabled={!name.trim() || (!signedIn && (password.length < 8 || password !== again))} />
    </form>
  )
}

/** Hermes's model provider: sign in to the default one, or choose another (an account or an API key). */
function HermesStep({ onDone, choosing, onChoose }: { onDone: () => void; choosing: boolean; onChoose: () => void }) {
  const t = useT()
  const auth = useStore($hermesAuth)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    void refreshHermesAuth().finally(() => setChecking(false))
  }, [])

  const signedIn = auth.checked && !auth.needsLogin && Boolean(auth.activeProvider)

  return (
    <div className="flex flex-col gap-4">
      <Heading
        icon={<IconUser size={18} />}
        title={t('firstRun.hermes.title')}
        text={signedIn ? t('firstRun.hermes.thinksWith', { provider: providerName(auth.activeProvider) ?? auth.activeProvider ?? '' }) : t('firstRun.hermes.text')}
      />
      {choosing && (
        <GlassCard className="flex flex-col">
          <ModelProviderRow />
        </GlassCard>
      )}
      <div className="flex items-center justify-end gap-2">
        {!choosing && (
          <LinkAction className="mr-auto" onClick={onChoose}>
            {t('firstRun.hermes.otherProvider')}
          </LinkAction>
        )}
        {!signedIn && (
          <GlassButton variant="ghost" onClick={onDone}>
            {t('firstRun.later')}
          </GlassButton>
        )}
        {signedIn ? (
          <Footer onNext={onDone} label={t('firstRun.next')} />
        ) : (
          !choosing && (
            <GlassButton variant="primary" onClick={() => requestHermesLogin('setup')} disabled={checking}>
              {checking ? <Spinner /> : null} {t('settings.agents.provider.signIn')} <IconArrowRight size={15} />
            </GlassButton>
          )
        )}
      </div>
    </div>
  )
}
