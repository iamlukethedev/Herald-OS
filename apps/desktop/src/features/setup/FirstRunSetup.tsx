import { useStore } from '@nanostores/react'
import { IconArrowRight, IconCheck, IconGift, IconKey, IconLock, IconUser, IconWifi } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { HeraldLogo } from '../../components/herald-logo.tsx'
import { GlassButton, GlassCard, LinkAction } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import type { DiskPasswordFailure, DiskPlainPart, KeyringFailure, KeyringState, PasswordFailure, SetupResult } from '../../../shared/ipc.ts'
import type { TextKey } from '../../../shared/i18n.ts'
import { $hermesAuth, refreshHermesAuth, requestHermesLogin } from '../../store/hermes-auth.ts'
import { t, useT } from '../../store/i18n.ts'
import { $providerFocus, providerName } from '../../store/model-provider.ts'
import { ModelProviderRow } from '../settings/sections/ProviderRow.tsx'
import { StatusPanel } from '../status/StatusPanel.tsx'

type Step = 'welcome' | 'account' | 'disk' | 'keyring' | 'wifi' | 'hermes' | 'done'

/**
 * First-boot setup on the Herald OS image: who the computer is for, their name and password,
 * Wi-Fi, and Hermes's sign-in. Setting it up for someone else skips the account and leaves setup
 * waiting for them at the next start. On an encrypted disk, a new owner (after that, or a reset)
 * also replaces the disk password they were given with one of their own.
 * The keyring apps keep passwords in: where the disk that holds it is encrypted (not only the system
 * disk), setup makes it with no password of its own, which that disk's password protects; otherwise it
 * asks how to protect it.
 */
export function FirstRunSetup() {
  const t = useT()
  const [due, setDue] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  // null: it could not be told, so setup neither asks for a disk password nor says the disk is unencrypted.
  const [diskEncrypted, setDiskEncrypted] = useState<boolean | null>(null)
  // On an encrypted disk, the parts written without encryption: a warning only, never a reason to skip
  // the disk password, which the computer still asks for when it starts.
  const [diskPlainParts, setDiskPlainParts] = useState<DiskPlainPart[]>([])
  const [newOwner, setNewOwner] = useState(false)
  // null: it could not be told, so setup leaves the keyring alone.
  const [keyring, setKeyring] = useState<KeyringState | null>(null)
  // Every filesystem that holds the keyring folder is on LUKS; null: it could not be told.
  const [keyringEncrypted, setKeyringEncrypted] = useState<boolean | null>(null)
  // Setup made the keyring with no password of its own (its disk is encrypted).
  const [keyringOpen, setKeyringOpen] = useState(false)
  // The account password from the account step, for sudo when the disk password changes.
  const [accountPassword, setAccountPassword] = useState('')
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
        setDiskEncrypted(state.diskEncrypted)
        setDiskPlainParts(state.diskEncrypted === true && state.diskProtection === 'partial' ? (state.diskPlainParts ?? []) : [])
        setNewOwner(state.newOwner)
        setKeyring(state.keyring ?? null)
        setKeyringEncrypted(state.keyringEncrypted ?? null)
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

  const steps: Step[] = forSomeoneElse
    ? ['welcome', 'wifi', 'done']
    : ['welcome', 'account', ...(diskEncrypted === true && newOwner ? (['disk'] as const) : []), ...(keyringEncrypted !== true && keyring === 'none' ? (['keyring'] as const) : []), 'wifi', 'hermes', 'done']
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
        {step === 'account' && (
          <Account
            onDone={password => {
              setAccountPassword(password)

              if (keyringEncrypted === true && keyring === 'none') {
                void window.heraldOS.setup
                  .keyring({ password: '' })
                  .then(result => setKeyringOpen(result.ok))
                  .catch(() => undefined)
              }

              next()
            }}
            signedIn={signedIn}
          />
        )}
        {step === 'disk' && <DiskStep onDone={next} account={accountPassword} plainParts={diskPlainParts} />}
        {step === 'keyring' && <KeyringStep onDone={next} encrypted={keyringEncrypted} />}
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
              text={t(forSomeoneElse ? (diskEncrypted === true ? 'firstRun.handOver.textEncrypted' : 'firstRun.handOver.text') : 'firstRun.done.text')}
            />
            {forSomeoneElse && diskEncrypted === false && <p className="text-[12.5px] leading-relaxed text-fg-3">{t('firstRun.handOver.notEncrypted')}</p>}
            {forSomeoneElse && diskEncrypted === null && <p className="text-[12.5px] leading-relaxed text-fg-3">{t('firstRun.handOver.encryptionUnknown')}</p>}
            {diskPlainParts.length > 0 && <PartlyEncrypted parts={diskPlainParts} />}
            {!forSomeoneElse && keyringOpen && <p className="text-[12.5px] leading-relaxed text-fg-3">{t('firstRun.keyring.encrypted')}</p>}
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

  return t(reason && Object.hasOwn(PASSWORD_FAILURES, reason) ? PASSWORD_FAILURES[reason as keyof typeof PASSWORD_FAILURES] : 'firstRun.account.passwordNotSet')
}

/** The name, and the password unless the account signed in at a login screen with one of its own. */
function Account({ onDone, signedIn }: { onDone: (password: string) => void; signedIn: boolean }) {
  const t = useT()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  // 'name': saving the name failed, so the password was never tried.
  const [error, setError] = useState<SetupResult | 'name' | null>(null)
  const [busy, setBusy] = useState(false)
  const mismatch = again.length > 0 && password !== again

  const save = async () => {
    setBusy(true)
    setError(null)

    try {
      const named = await window.heraldOS.setup.name(name).then(
        () => true,
        () => false
      )

      if (!named) {
        setError('name')

        return
      }

      const result = signedIn ? { ok: true } : await window.heraldOS.setup.password(password)

      if (result.ok) {
        onDone(signedIn ? '' : password)
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
      {(error || mismatch) && <p className="text-[12.5px] text-danger">{mismatch ? t('firstRun.account.mismatch') : error === 'name' ? t('firstRun.account.nameNotSaved') : error && passwordError(error)}</p>}
      <Footer onNext={() => void save()} label={t('firstRun.next')} busy={busy} disabled={!name.trim() || (!signedIn && (password.length < 8 || password !== again))} />
    </form>
  )
}

const DISK_FAILURES: Record<DiskPasswordFailure, TextKey> = {
  tooShort: 'firstRun.account.tooShort',
  notAscii: 'firstRun.disk.notAscii',
  wrongCurrent: 'firstRun.disk.wrongCurrent',
  notAdmin: 'firstRun.disk.notAdmin',
  notEncrypted: 'firstRun.disk.notEncrypted',
  partly: 'firstRun.disk.partly',
  notTakenBack: 'firstRun.disk.notTakenBack',
  recoveryKey: 'firstRun.disk.recoveryKey',
  tpmKey: 'firstRun.disk.tpmKey',
  fido2Key: 'firstRun.disk.fido2Key',
  otherKey: 'firstRun.disk.otherKey',
  newIsOtherKey: 'firstRun.disk.newIsOtherKey',
  sameAsCurrent: 'firstRun.disk.sameAsCurrent',
  sharedSecret: 'firstRun.disk.sharedSecret',
  timeout: 'firstRun.disk.timeout',
  noTerminal: 'firstRun.disk.noTerminal',
  failed: 'firstRun.disk.failed'
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

/**
 * A new owner's disk password, in place of the one they typed at start-up (whoever set the computer
 * up before them chose it). The account password goes to sudo; it is asked here only when the account
 * step did not set it (an account that signed in at a login screen).
 */
const PLAIN_PART_KEYS = {
  cipher_null: 'firstRun.disk.plain.cipherNull',
  journal: 'firstRun.disk.plain.journal',
  log: 'firstRun.disk.plain.log',
  realtime: 'firstRun.disk.plain.realtime'
} as const

/** The warning for an encrypted disk that is partly written without encryption, naming those parts. */
function PartlyEncrypted({ parts }: { parts: DiskPlainPart[] }) {
  const t = useT()

  return (
    <div className="flex flex-col gap-1 text-[12.5px] leading-relaxed text-warn" role="note">
      <p>{t('firstRun.disk.partial')}</p>
      <ul className="list-disc pl-5">
        {parts.map(part => (
          <li key={`${part.kind}:${part.device}`}>{t(PLAIN_PART_KEYS[part.kind], { device: part.device })}</li>
        ))}
      </ul>
      <p>{t('firstRun.disk.partialFix')}</p>
    </div>
  )
}

function DiskStep({ onDone, account, plainParts }: { onDone: () => void; account: string; plainParts: DiskPlainPart[] }) {
  const t = useT()
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [accountPassword, setAccountPassword] = useState(account)
  const [error, setError] = useState<TextKey | null>(null)
  const [busy, setBusy] = useState(false)
  const mismatch = again.length > 0 && password !== again
  const notAscii = !PRINTABLE_ASCII.test(password)
  // The same secret opens another way of unlocking: trying again gives the same answer until that way
  // has a secret of its own, which setup cannot do, so only "Later" goes on.
  const blocked = error === 'firstRun.disk.sharedSecret'

  const save = async () => {
    if (blocked) {
      return
    }

    setBusy(true)
    setError(null)

    try {
      const result = await window.heraldOS.setup.diskPassword({ current, password, account: accountPassword })

      if (result.ok) {
        onDone()
      } else {
        const reason = result.reason as DiskPasswordFailure | undefined
        setError(reason && Object.hasOwn(DISK_FAILURES, reason) ? DISK_FAILURES[reason] : 'firstRun.disk.failed')
      }
    } catch {
      setError('firstRun.disk.failed')
    } finally {
      setBusy(false)
    }
  }

  const field = (label: TextKey, value: string, onChange: (value: string) => void, autoComplete: string, autoFocus = false) => (
    <label className="flex flex-col gap-1.5 text-[12px] text-fg-3">
      {t(label)}
      <input
        type="password"
        value={value}
        onChange={event => onChange(event.target.value)}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        disabled={busy}
        className="glass-input h-10 rounded-lg px-3 text-[14px] text-fg outline-none"
      />
    </label>
  )
  const problem = mismatch ? 'firstRun.disk.mismatch' : notAscii ? 'firstRun.disk.notAscii' : error

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={event => {
        event.preventDefault()
        void save()
      }}
    >
      <Heading icon={<IconKey size={18} />} title={t('firstRun.disk.title')} text={t('firstRun.disk.text')} />
      <p className="text-[12.5px] leading-relaxed text-fg-3">{t('firstRun.disk.keyboard')}</p>
      {plainParts.length > 0 && <PartlyEncrypted parts={plainParts} />}
      {field('firstRun.disk.current', current, setCurrent, 'current-password', true)}
      {field('firstRun.disk.password', password, setPassword, 'new-password')}
      {field('firstRun.disk.passwordAgain', again, setAgain, 'new-password')}
      {!account && field('firstRun.disk.account', accountPassword, setAccountPassword, 'current-password')}
      {busy && <p className="text-[12.5px] text-fg-3">{t('firstRun.disk.busy')}</p>}
      {problem && <p className="text-[12.5px] text-danger">{t(problem)}</p>}
      <p className="text-[12px] leading-relaxed text-fg-3">{t('firstRun.disk.laterHint')}</p>
      <div className="flex items-center justify-end gap-2">
        <GlassButton variant="ghost" onClick={onDone} disabled={busy}>
          {t('firstRun.later')}
        </GlassButton>
        <Footer onNext={() => void save()} label={t('firstRun.next')} busy={busy} disabled={blocked || !current || password.length < 8 || password !== again || notAscii || !accountPassword} />
      </div>
    </form>
  )
}

const KEYRING_FAILURES: Record<KeyringFailure, TextKey> = {
  tooShort: 'firstRun.account.tooShort',
  passwordRefused: 'firstRun.keyring.passwordRefused',
  keyringExists: 'firstRun.keyring.failed',
  noKeyringService: 'firstRun.keyring.noService',
  wrongPassword: 'firstRun.keyring.wrongPassword',
  keyringNeedsPassword: 'firstRun.keyring.needsPassword',
  failed: 'firstRun.keyring.failed'
}

/**
 * How the keyring is protected where the disk that holds it is not encrypted (or that could not be
 * told): a password of its own, asked by the first app that needs it after each start, or none, which
 * anyone who has the disk can read past.
 */
function KeyringStep({ onDone, encrypted }: { onDone: () => void; encrypted: boolean | null }) {
  const t = useT()
  const [choice, setChoice] = useState<'password' | 'open' | null>(null)
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<TextKey | null>(null)
  const [busy, setBusy] = useState(false)
  const mismatch = choice === 'password' && again.length > 0 && password !== again
  // Characters (code points), as `herald-os keyring` counts them, not UTF-16 units.
  const ready = choice === 'open' || (choice === 'password' && [...password].length >= 8 && password === again)

  const save = async () => {
    setBusy(true)
    setError(null)

    try {
      const result = await window.heraldOS.setup.keyring({ password: choice === 'password' ? password : '' })
      const reason = result.reason as KeyringFailure | undefined

      // One made since setup looked (an app asked for it) stays as it is.
      if (result.ok || reason === 'keyringExists') {
        onDone()
      } else {
        // A keyring an interrupted try started with another password: it is typed again, from empty fields.
        if (reason === 'wrongPassword') {
          setPassword('')
          setAgain('')
        }

        // Such a keyring with a password of its own, and "No keyring password" chosen: its password is asked.
        if (reason === 'keyringNeedsPassword') {
          setChoice('password')
          setPassword('')
          setAgain('')
        }

        setError(reason && Object.hasOwn(KEYRING_FAILURES, reason) ? KEYRING_FAILURES[reason] : 'firstRun.keyring.failed')
      }
    } catch {
      setError('firstRun.keyring.failed')
    } finally {
      setBusy(false)
    }
  }

  const option = (value: 'password' | 'open', label: TextKey, hint: TextKey) => (
    <button
      type="button"
      aria-pressed={choice === value}
      disabled={busy}
      onClick={() => setChoice(value)}
      className={cn('glass-input flex flex-col items-start gap-1 rounded-xl p-4 text-left hover:border-line-strong', choice === value && 'border-accent-strong hover:border-accent-strong')}
    >
      <span className="text-[14px] font-medium text-fg">{t(label)}</span>
      <span className="text-[12px] text-fg-3">{t(hint)}</span>
    </button>
  )
  const field = (label: TextKey, value: string, onChange: (value: string) => void) => (
    <label className="flex flex-col gap-1.5 text-[12px] text-fg-3">
      {t(label)}
      <input type="password" value={value} onChange={event => onChange(event.target.value)} autoComplete="new-password" disabled={busy} className="glass-input h-10 rounded-lg px-3 text-[14px] text-fg outline-none" />
    </label>
  )
  const problem = mismatch ? 'firstRun.keyring.mismatch' : error

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={event => {
        event.preventDefault()

        if (ready) {
          void save()
        }
      }}
    >
      <Heading icon={<IconKey size={18} />} title={t('firstRun.keyring.title')} text={t(encrypted === false ? 'firstRun.keyring.text' : 'firstRun.keyring.textUnknown')} />
      <div className="grid grid-cols-2 gap-3">
        {option('password', 'firstRun.keyring.password', 'firstRun.keyring.passwordHint')}
        {option('open', 'firstRun.keyring.open', 'firstRun.keyring.openHint')}
      </div>
      {choice === 'password' && (
        <>
          {field('firstRun.keyring.field', password, setPassword)}
          {field('firstRun.keyring.fieldAgain', again, setAgain)}
          <p className="text-[12px] text-fg-3">{t('firstRun.keyring.sameAsAccount')}</p>
        </>
      )}
      {problem && <p className="text-[12.5px] text-danger">{t(problem)}</p>}
      <p className="text-[12px] leading-relaxed text-fg-3">{t('firstRun.keyring.laterHint')}</p>
      <div className="flex items-center justify-end gap-2">
        <GlassButton variant="ghost" onClick={onDone} disabled={busy}>
          {t('firstRun.later')}
        </GlassButton>
        <Footer onNext={() => void save()} label={t('firstRun.next')} busy={busy} disabled={!ready} />
      </div>
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
