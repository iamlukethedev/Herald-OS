import { useStore } from '@nanostores/react'
import { IconArrowRight, IconCheck, IconGift, IconLock, IconUser, IconWifi } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { HeraldLogo } from '../../components/herald-logo.tsx'
import { GlassButton, GlassCard, LinkAction } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { $hermesAuth, refreshHermesAuth, requestHermesLogin } from '../../store/hermes-auth.ts'
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
  const [due, setDue] = useState(false)
  const [step, setStep] = useState<Step>('welcome')
  const [forSomeoneElse, setForSomeoneElse] = useState(false)
  // Kept here: the Hermes step unmounts while the sign-in card is up.
  const [otherProvider, setOtherProvider] = useState(false)
  const auth = useStore($hermesAuth)
  const providerFocus = useStore($providerFocus)

  useEffect(() => {
    void window.heraldOS.setup
      ?.state()
      .then(state => setDue(state.needed))
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
    <div className="absolute inset-0 z-(--z-boot) flex items-center justify-center bg-bg/85 backdrop-blur-md animate-fade-in" role="dialog" aria-label="Set up Herald OS">
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
            onChoose={someoneElse => {
              setForSomeoneElse(someoneElse)
              setStep(someoneElse ? 'wifi' : 'account')
            }}
          />
        )}
        {step === 'account' && <Account onDone={next} />}
        {step === 'wifi' && (
          <div className="flex flex-col gap-4">
            <Heading icon={<IconWifi size={18} />} title="Get online" text="Pick a network; you can also plug in a cable. Skip it to stay offline for now." />
            <div className="max-h-[320px] overflow-y-auto rounded-xl">
              <StatusPanel panel="wifi" />
            </div>
            <Footer onNext={next} label="Next" />
          </div>
        )}
        {step === 'hermes' && <HermesStep onDone={next} choosing={otherProvider} onChoose={() => setOtherProvider(true)} />}
        {step === 'done' && (
          <div className="flex flex-col gap-4">
            <Heading
              icon={forSomeoneElse ? <IconGift size={18} /> : <IconCheck size={18} />}
              title={forSomeoneElse ? 'Ready to hand over' : 'You are all set'}
              text={forSomeoneElse ? 'The next time it starts, it asks its new owner for a name, a password and their Hermes sign-in.' : 'Press Super+Space to ask Hermes about anything on screen, or Super+M for the Herald OS menu.'}
            />
            <Footer onNext={() => void finish()} label={forSomeoneElse ? 'Done' : 'Start using Herald OS'} />
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

function Welcome({ onChoose }: { onChoose: (someoneElse: boolean) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <Heading icon={<IconUser size={18} />} title="Welcome to Herald OS" text="A computer you can talk to. A few questions and it is yours." />
      <div className="grid grid-cols-2 gap-3">
        <button type="button" onClick={() => onChoose(false)} className="glass-input flex flex-col items-start gap-1 rounded-xl p-4 text-left hover:border-line-strong">
          <span className="text-[14px] font-medium text-fg">It is for me</span>
          <span className="text-[12px] text-fg-3">Choose your name, a password and sign in to Hermes.</span>
        </button>
        <button type="button" onClick={() => onChoose(true)} className="glass-input flex flex-col items-start gap-1 rounded-xl p-4 text-left hover:border-line-strong">
          <span className="text-[14px] font-medium text-fg">For someone else</span>
          <span className="text-[12px] text-fg-3">Get it online now; they finish setup when they first start it.</span>
        </button>
      </div>
    </div>
  )
}

function Account({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mismatch = again.length > 0 && password !== again

  const save = async () => {
    setBusy(true)
    setError(null)

    try {
      await window.heraldOS.setup.name(name)
      const result = await window.heraldOS.setup.password(password)

      if (result.ok) {
        onDone()
      } else {
        setError(result.error ?? 'The password was not set.')
      }
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
      <Heading icon={<IconLock size={18} />} title="Your name and password" text="Herald OS greets you by name. The password unlocks the screen and approves changes to the system." />
      <label className="flex flex-col gap-1.5 text-[12px] text-fg-3">
        Name
        <input value={name} onChange={event => setName(event.target.value)} autoFocus autoComplete="name" className="glass-input h-10 rounded-lg px-3 text-[14px] text-fg outline-none" />
      </label>
      <label className="flex flex-col gap-1.5 text-[12px] text-fg-3">
        Password (at least 8 characters)
        <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" className="glass-input h-10 rounded-lg px-3 text-[14px] text-fg outline-none" />
      </label>
      <label className="flex flex-col gap-1.5 text-[12px] text-fg-3">
        The same password again
        <input type="password" value={again} onChange={event => setAgain(event.target.value)} autoComplete="new-password" className="glass-input h-10 rounded-lg px-3 text-[14px] text-fg outline-none" />
      </label>
      {(error || mismatch) && <p className="text-[12.5px] text-danger">{mismatch ? 'The passwords do not match.' : error}</p>}
      <Footer onNext={() => void save()} label="Next" busy={busy} disabled={!name.trim() || password.length < 8 || password !== again} />
    </form>
  )
}

/** Hermes's model provider: sign in to the default one, or choose another (an account or an API key). */
function HermesStep({ onDone, choosing, onChoose }: { onDone: () => void; choosing: boolean; onChoose: () => void }) {
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
        title="Sign in to Hermes"
        text={
          signedIn
            ? `Hermes thinks with ${providerName(auth.activeProvider) ?? auth.activeProvider}.`
            : 'Hermes needs a model provider to think with. Signing in opens the provider page beside a short code; another provider can take an API key instead.'
        }
      />
      {choosing && (
        <GlassCard className="flex flex-col">
          <ModelProviderRow />
        </GlassCard>
      )}
      <div className="flex items-center justify-end gap-2">
        {!choosing && (
          <LinkAction className="mr-auto" onClick={onChoose}>
            Use another provider
          </LinkAction>
        )}
        {!signedIn && (
          <GlassButton variant="ghost" onClick={onDone}>
            Later
          </GlassButton>
        )}
        {signedIn ? (
          <Footer onNext={onDone} label="Next" />
        ) : (
          !choosing && (
            <GlassButton variant="primary" onClick={() => requestHermesLogin('setup')} disabled={checking}>
              {checking ? <Spinner /> : null} Sign in <IconArrowRight size={15} />
            </GlassButton>
          )
        )}
      </div>
    </div>
  )
}
