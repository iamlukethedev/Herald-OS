// @vitest-environment happy-dom
import type { ModelOptionsResult } from '@herald-os/client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Language, TextKey } from '../../../shared/i18n.ts'
import type { SetupResult, SetupState } from '../../../shared/ipc.ts'
import { en } from '../../../shared/locales/en.ts'
import { $prefs } from '../../store/backend.ts'
import { $connection, $connectionEpoch } from '../../store/gateway.ts'
import { $hermesAuth } from '../../store/hermes-auth.ts'
import { t } from '../../store/i18n.ts'
import { FirstRunSetup } from './FirstRunSetup.tsx'

// The preload bridge setup reads from. By default setup is due for someone who signed in at the
// login screen, so the account step asks only a name, and Hermes has no provider signed in.
const bridge = vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const setup = {
    state: vi.fn(async (): Promise<Partial<SetupState>> => ({ needed: true, signedIn: true })),
    name: vi.fn(async () => undefined),
    password: vi.fn(async (): Promise<SetupResult> => ({ ok: true })),
    diskPassword: vi.fn(async (_request: { current: string; password: string; account: string }): Promise<SetupResult> => ({ ok: true })),
    keyring: vi.fn(async (_request: { password: string }): Promise<SetupResult> => ({ ok: true })),
    finish: vi.fn(async () => undefined)
  }
  const rest = vi.fn(async (_request: { path: string }): Promise<unknown> => null)
  Object.assign(window, { heraldOS: { backend: { rest }, setup } })

  return { setup, rest }
})

vi.mock('../status/StatusPanel.tsx', () => ({ StatusPanel: () => null }))

vi.mock('../../store/model-provider.ts', async importActual => ({
  ...(await importActual<typeof import('../../store/model-provider.ts')>()),
  providerName: vi.fn((slug: string | null | undefined) => (slug === 'openrouter' ? 'OpenRouter' : null)),
  loadModelOptions: vi.fn(async () => ({ providers: [{ slug: 'openrouter', name: 'OpenRouter', authenticated: true, models: ['openrouter/auto'] }] }) as ModelOptionsResult),
  loadKeyCatalog: vi.fn(async () => ({})),
  loadEndpointKeys: vi.fn(async () => ({}))
}))

const SIGNED_OUT_AUTH = $hermesAuth.get()

// What may read the same in every language: product names, and the keyboard shortcuts, commands
// and units that stay as they are (en.ts says which). The longer command goes first.
const KEPT = ['Herald OS', 'Hermes', 'OpenRouter', 'Super+Space', 'Super+M', 'herald-os password --disk --new-owner', 'herald-os keyring setup --password', 'herald-os password', 'API', 'GHz', 'TPM', 'FIDO2', 'VS Code', 'Signal', 'GitHub CLI']

// Portuguese words spelled as English ones are ("o menu", "for ligado", "use pelo menos", "um terminal",
// "teclado Bluetooth", "os apps").
const NATIVE: Record<Exclude<Language, 'en'>, string[]> = { 'pt-BR': ['Bluetooth', 'for', 'menu', 'terminal', 'use', 'Use', 'app', 'apps', 'Apps'], 'zh-CN': [] }

let root: Root | null = null
let container: HTMLElement | null = null

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)))
  }
}

const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.trim().startsWith(text))
const heading = (host: HTMLElement) => host.querySelector('h2')?.textContent

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy()
  await act(async () => (element as HTMLElement).click())
  await settle()
}

async function type(input: HTMLInputElement | null, value: string) {
  expect(input).toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** The words a person reads or hears: the text, and the labels, tooltips and placeholders of the controls. */
function readable(host: HTMLElement): string[] {
  const texts = new Set<string>()
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim()

    if (text && /\p{L}/u.test(text)) {
      texts.add(text)
    }
  }

  for (const element of host.querySelectorAll('[aria-label], [title], [placeholder]')) {
    for (const name of ['aria-label', 'title', 'placeholder']) {
      const value = element.getAttribute(name)?.trim()

      if (value && /\p{L}/u.test(value)) {
        texts.add(value)
      }
    }
  }

  return [...texts]
}

/** The Latin words of three letters or more in a text, once what may stay as it is has gone. */
function words(text: string): string[] {
  let rest = text

  for (const kept of KEPT) {
    rest = rest.split(kept).join(' ')
  }

  return rest.match(/[A-Za-z]{3,}/g) ?? []
}

async function mount(language: Language): Promise<HTMLElement> {
  $prefs.set({ ...$prefs.get(), language })
  const host = document.createElement('div')
  document.body.append(host)
  container = host
  root = createRoot(host)
  await act(async () => root?.render(<FirstRunSetup />))
  await settle()

  return host
}

type Path = 'mine' | 'signed in' | 'someone else' | 'new owner'

// Each way the disk password can fail, and what setup says.
const DISK_FAILURES = [
  ['wrongCurrent', 'firstRun.disk.wrongCurrent'],
  ['notAdmin', 'firstRun.disk.notAdmin'],
  ['notEncrypted', 'firstRun.disk.notEncrypted'],
  ['partly', 'firstRun.disk.partly'],
  ['notTakenBack', 'firstRun.disk.notTakenBack'],
  ['recoveryKey', 'firstRun.disk.recoveryKey'],
  ['tpmKey', 'firstRun.disk.tpmKey'],
  ['fido2Key', 'firstRun.disk.fido2Key'],
  ['otherKey', 'firstRun.disk.otherKey'],
  ['newIsOtherKey', 'firstRun.disk.newIsOtherKey'],
  ['sameAsCurrent', 'firstRun.disk.sameAsCurrent'],
  ['timeout', 'firstRun.disk.timeout'],
  ['noTerminal', 'firstRun.disk.noTerminal'],
  ['tooShort', 'firstRun.account.tooShort'],
  ['notAscii', 'firstRun.disk.notAscii'],
  ['failed', 'firstRun.disk.failed']
] as const

// Each way making the keyring can fail and setup stays on the step, and what it says.
const KEYRING_FAILURES = [
  ['noKeyringService', 'firstRun.keyring.noService'],
  ['tooShort', 'firstRun.account.tooShort'],
  ['failed', 'firstRun.keyring.failed']
] as const

/** Every step on one way through setup, each with what it shows, checked to have its own heading. */
async function walk(language: Language, path: Path): Promise<{ step: string; texts: string[] }[]> {
  const shown: { step: string; texts: string[] }[] = []
  const host = await mount(language)
  const at = (step: string, title: TextKey) => {
    expect(heading(host), `${language} ${path}: ${step}`).toBe(t(title))
    shown.push({ step, texts: readable(host) })
  }

  at('welcome', 'firstRun.welcome.title')

  if (path === 'someone else') {
    await click(button(host, t('firstRun.welcome.forSomeoneElse')))
    at('wifi', 'firstRun.wifi.title')
    await click(button(host, t('firstRun.next')))
    at('hand over', 'firstRun.handOver.title')
    await click(button(host, t('firstRun.handOver.done')))
    expect(bridge.setup.finish).toHaveBeenLastCalledWith({ later: true })

    return shown
  }

  await click(button(host, t('firstRun.welcome.forMe')))
  const says = (expected: string) => expect(host.querySelector('.text-danger')?.textContent).toBe(expected)

  if (path === 'new owner') {
    at('account', 'firstRun.account.title')
    await type(host.querySelector('input[autocomplete="name"]'), 'Ana')
    for (const input of host.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
      await type(input, 'correct horse')
    }
    await click(button(host, t('firstRun.next')))
    at('disk', 'firstRun.disk.title')
    // The account password is known from the step before, so only the disk passwords are asked.
    const [current, password, again, ...more] = host.querySelectorAll<HTMLInputElement>('input[type="password"]')
    expect(more).toHaveLength(0)
    await type(current, 'given at start-up')
    await type(password, 'my own disk pass')
    await type(again, 'my own disk pasz')
    at('disk passwords differ', 'firstRun.disk.title')
    says(t('firstRun.disk.mismatch'))
    await type(password, 'coração do disco')
    await type(again, 'coração do disco')
    at('disk password not ASCII', 'firstRun.disk.title')
    says(t('firstRun.disk.notAscii'))
    expect(button(host, t('firstRun.next'))?.disabled).toBe(true)
    await type(password, 'my own disk pass')
    await type(again, 'my own disk pass')
    for (const [reason, key] of DISK_FAILURES) {
      bridge.setup.diskPassword.mockResolvedValueOnce({ ok: false, reason })
      await click(button(host, t('firstRun.next')))
      at(`disk ${reason}`, 'firstRun.disk.title')
      says(t(key))
    }
    bridge.setup.diskPassword.mockRejectedValueOnce(new Error('No handler registered for herald-os:setup:disk-password'))
    await click(button(host, t('firstRun.next')))
    says(t('firstRun.disk.failed'))
  } else if (path === 'mine') {
    at('account', 'firstRun.account.title')
    await type(host.querySelector('input[autocomplete="name"]'), 'Ana')
    const [password, again] = host.querySelectorAll<HTMLInputElement>('input[type="password"]')
    await type(password, 'correct horse')
    await type(again, 'correct hors')
    at('passwords differ', 'firstRun.account.title')
    expect(host.querySelector('.text-danger')?.textContent).toBe(t('firstRun.account.mismatch'))
    await type(again, 'correct horse')
    bridge.setup.password.mockResolvedValueOnce({ ok: false, reason: 'refused' })
    await click(button(host, t('firstRun.next')))
    at('password refused', 'firstRun.account.title')
    says(t('firstRun.account.refusedNoReason'))
    // pwquality's reason is English whatever the language, so this step is not compared with English.
    // Its own full stop goes, so the message's is the only one.
    bridge.setup.password.mockResolvedValueOnce({ ok: false, reason: 'refused', detail: 'The password fails the dictionary check - it is based on a dictionary word.' })
    await click(button(host, t('firstRun.next')))
    says(t('firstRun.account.refused', { reason: 'The password fails the dictionary check - it is based on a dictionary word' }))
    bridge.setup.password.mockResolvedValueOnce({ ok: false, reason: 'tooShort' })
    await click(button(host, t('firstRun.next')))
    at('password too short', 'firstRun.account.title')
    says(t('firstRun.account.tooShort'))
    bridge.setup.password.mockResolvedValueOnce({ ok: false, reason: 'noTerminal' })
    await click(button(host, t('firstRun.next')))
    at('no terminal for passwd', 'firstRun.account.title')
    says(t('firstRun.account.noTerminal'))
    bridge.setup.password.mockResolvedValueOnce({ ok: false, reason: 'timeout' })
    await click(button(host, t('firstRun.next')))
    at('password timed out', 'firstRun.account.title')
    says(t('firstRun.account.timeout'))
    bridge.setup.password.mockResolvedValueOnce({ ok: false, reason: 'failed' })
    await click(button(host, t('firstRun.next')))
    at('password not set', 'firstRun.account.title')
    says(t('firstRun.account.passwordNotSet'))
    bridge.setup.password.mockResolvedValueOnce({ ok: false })
    await click(button(host, t('firstRun.next')))
    says(t('firstRun.account.passwordNotSet'))
    bridge.setup.password.mockRejectedValueOnce(new Error('No handler registered for herald-os:setup:password'))
    await click(button(host, t('firstRun.next')))
    at('password call failed', 'firstRun.account.title')
    says(t('firstRun.account.passwordNotSet'))
    const tries = bridge.setup.password.mock.calls.length
    bridge.setup.name.mockRejectedValueOnce(new Error('EACCES: permission denied'))
    await click(button(host, t('firstRun.next')))
    at('name call failed', 'firstRun.account.title')
    says(t('firstRun.account.nameNotSaved'))
    expect(bridge.setup.password.mock.calls.length, 'the password is not tried once the name failed').toBe(tries)
  } else {
    at('account', 'firstRun.account.titleSignedIn')
    await type(host.querySelector('input[autocomplete="name"]'), 'Ana')
    bridge.setup.name.mockRejectedValueOnce(new Error('EACCES: permission denied'))
    await click(button(host, t('firstRun.next')))
    at('name call failed', 'firstRun.account.titleSignedIn')
    says(t('firstRun.account.nameNotSaved'))
  }

  await click(button(host, t('firstRun.next')))

  if (path === 'mine') {
    // The disk is not encrypted and there is no keyring yet.
    at('keyring', 'firstRun.keyring.title')
    expect(host.textContent).toContain(t('firstRun.keyring.text'))
    expect(button(host, t('firstRun.next'))?.disabled).toBe(true)
    await click(button(host, t('firstRun.keyring.password')))
    const [password, again, ...more] = host.querySelectorAll<HTMLInputElement>('input[type="password"]')
    expect(more).toHaveLength(0)
    await type(password, 'keyring pass')
    await type(again, 'keyring pasz')
    at('keyring passwords differ', 'firstRun.keyring.title')
    says(t('firstRun.keyring.mismatch'))
    expect(button(host, t('firstRun.next'))?.disabled).toBe(true)
    await type(again, 'keyring pass')
    for (const [reason, key] of KEYRING_FAILURES) {
      bridge.setup.keyring.mockResolvedValueOnce({ ok: false, reason })
      await click(button(host, t('firstRun.next')))
      at(`keyring ${reason}`, 'firstRun.keyring.title')
      says(t(key))
    }
    bridge.setup.keyring.mockRejectedValueOnce(new Error('No handler registered for herald-os:setup:keyring'))
    await click(button(host, t('firstRun.next')))
    says(t('firstRun.keyring.failed'))
    await click(button(host, t('firstRun.next')))
    expect(bridge.setup.keyring).toHaveBeenLastCalledWith({ password: 'keyring pass' })
  }

  at('wifi', 'firstRun.wifi.title')
  if (path === 'new owner') {
    // An encrypted disk: the keyring is made with no password of its own, without asking.
    expect(bridge.setup.keyring).toHaveBeenLastCalledWith({ password: '' })
    expect(bridge.setup.diskPassword).toHaveBeenLastCalledWith({ current: 'given at start-up', password: 'my own disk pass', account: 'correct horse' })
  }
  await click(button(host, t('firstRun.next')))
  at('hermes', 'firstRun.hermes.title')

  if (path === 'mine' || path === 'new owner') {
    expect(button(host, t('settings.agents.provider.signIn'))).toBeTruthy()
    await click(button(host, t('firstRun.hermes.otherProvider')))
    at('another provider', 'firstRun.hermes.title')
    await click(button(host, t('firstRun.later')))
  } else {
    expect(host.textContent).toContain(t('firstRun.hermes.thinksWith', { provider: 'OpenRouter' }))
    await click(button(host, t('firstRun.next')))
  }

  at('done', 'firstRun.done.title')
  expect(host.textContent?.includes(t('firstRun.keyring.encrypted')), 'the note on the keyring').toBe(path === 'new owner')
  await click(button(host, t('firstRun.done.start')))
  expect(bridge.setup.finish).toHaveBeenLastCalledWith({ later: false })

  return shown
}

function unmount() {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
}

function given(path: Path) {
  bridge.setup.state.mockResolvedValue({
    needed: true,
    signedIn: path === 'signed in' || path === 'someone else',
    diskEncrypted: path === 'new owner',
    newOwner: path === 'new owner',
    keyring: path === 'mine' || path === 'new owner' ? 'none' : 'open',
    keyringEncrypted: path === 'new owner'
  })
  bridge.rest.mockImplementation(async ({ path: url }) => {
    if (path !== 'signed in') {
      return null
    }

    return url === '/api/providers/oauth' ? { providers: [{ id: 'openrouter', name: 'OpenRouter', flow: 'external', status: { logged_in: true } }] } : url === '/api/config/raw' ? { yaml: 'model:\n  provider: openrouter\n' } : null
  })
}

beforeEach(() => {
  $connection.set('open')
  $connectionEpoch.set(1)
})

afterEach(() => {
  unmount()
  $prefs.set({ ...$prefs.get(), language: undefined })
  $connection.set('idle')
  $connectionEpoch.set(0)
  $hermesAuth.set(SIGNED_OUT_AUTH)
  bridge.setup.state.mockResolvedValue({ needed: true, signedIn: true })
  bridge.rest.mockImplementation(async () => null)
})

describe("first-run setup's Hermes step", () => {
  it('offers the model provider row in the language chosen', async () => {
    const host = await mount('pt-BR')

    await click(button(host, t('firstRun.welcome.forMe')))
    await type(host.querySelector('input[autocomplete="name"]'), 'Ana')
    await click(button(host, t('firstRun.next')))
    await click(button(host, t('firstRun.next')))
    await click(button(host, t('firstRun.hermes.otherProvider')))

    for (const key of ['settings.agents.provider.label', 'settings.agents.provider.none'] as const) {
      expect(t(key), key).not.toBe(en[key])
      expect(host.textContent, key).toContain(t(key))
      expect(host.textContent, key).not.toContain(en[key])
    }

    await click(button(host, t('settings.agents.provider.choose')))
    expect(host.querySelector(`[role="dialog"][aria-label="${t('settings.agents.provider.chooseLabel')}"]`)).not.toBeNull()
    expect(host.querySelector(`[role="listbox"][aria-label="${t('settings.agents.provider.readyToUse')}"]`)?.textContent).toBe('OpenRouter')
    expect(host.querySelector('[role="option"] > span.truncate')?.getAttribute('title')).toBe('OpenRouter')
    expect(host.textContent).not.toContain(en['settings.agents.provider.readyToUse'])
  })
})

describe("first-run setup's account step for a new account", () => {
  /** The account step with a name and a matching password filled in, as someone setting it up for themselves. */
  async function filledIn(language: Language): Promise<HTMLElement> {
    given('mine')
    const host = await mount(language)
    await click(button(host, t('firstRun.welcome.forMe')))
    await type(host.querySelector('input[autocomplete="name"]'), 'Ana')
    for (const input of host.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
      await type(input, 'correct horse')
    }

    return host
  }

  const error = (host: HTMLElement) => host.querySelector('.text-danger')?.textContent

  it.each(['en', 'pt-BR', 'zh-CN'] as const)('says the name was not saved in %s when that fails first, and never tries the password', async language => {
    const host = await filledIn(language)
    bridge.setup.password.mockClear()
    bridge.setup.name.mockRejectedValueOnce(new Error('EACCES: permission denied'))
    await click(button(host, t('firstRun.next')))

    expect(error(host)).toBe(t('firstRun.account.nameNotSaved'))
    expect(error(host)).not.toBe(t('firstRun.account.passwordNotSet'))
    expect(bridge.setup.password).not.toHaveBeenCalled()
    expect(heading(host)).toBe(t('firstRun.account.title'))
  })

  it.each(['__proto__', 'toString', 'constructor', 'hasOwnProperty', 'valueOf'])('says the password was not set for the unknown code %s, never an inherited key', async code => {
    const host = await filledIn('pt-BR')
    bridge.setup.password.mockResolvedValueOnce({ ok: false, reason: code as SetupResult['reason'] })
    await click(button(host, t('firstRun.next')))

    expect(error(host)).toBe(t('firstRun.account.passwordNotSet'))
  })

  it.each(['__proto__', 'toString'])("shows pwquality's reason %s as text in the refusal", async detail => {
    const host = await filledIn('en')
    bridge.setup.password.mockResolvedValueOnce({ ok: false, reason: 'refused', detail })
    await click(button(host, t('firstRun.next')))

    expect(error(host)).toBe(`That password was refused: ${detail}.`)
  })

  it.each([
    ['en', 'That password was refused: The password is shorter than 8 characters.'],
    ['pt-BR', 'Essa senha foi recusada: The password is shorter than 8 characters.'],
    ['zh-CN', '这个密码被拒绝了：The password is shorter than 8 characters。']
  ] as const)("ends the refusal in %s with one full stop, whether or not pwquality's reason has its own", async (language, expected) => {
    const host = await filledIn(language)

    for (const detail of ['The password is shorter than 8 characters.', 'The password is shorter than 8 characters']) {
      bridge.setup.password.mockResolvedValueOnce({ ok: false, reason: 'refused', detail })
      await click(button(host, t('firstRun.next')))
      expect(error(host), detail).toBe(expected)
    }
  })

  it.each([
    ['tooShort', 'Use at least 8 characters.'],
    ['noTerminal', 'The password cannot be set here; run herald-os password in a terminal.'],
    ['timeout', 'Setting the password took too long. Try again.'],
    ['failed', 'The password was not set.']
  ] as const)('says %s in its own words', async (reason, expected) => {
    const host = await filledIn('en')
    bridge.setup.password.mockResolvedValueOnce({ ok: false, reason })
    await click(button(host, t('firstRun.next')))

    expect(error(host)).toBe(expected)
  })
})

describe('first-run setup', () => {
  it.each(['mine', 'signed in', 'someone else', 'new owner'] as const)('reads as before in English, the %s way through', async path => {
    given(path)
    const steps = await walk('en', path)
    const all = steps.flatMap(step => step.texts)

    expect(all).toContain('Welcome to Herald OS')
    expect(all).toContain('Set up Herald OS')
    expect(all).toContain(path === 'someone else' ? 'Ready to hand over' : 'You are all set')
    if (path !== 'someone else') {
      expect(all).toContain('It is for me')
    }
  })

  describe.each(['pt-BR', 'zh-CN'] as const)('in %s', language => {
    it.each(['mine', 'signed in', 'someone else', 'new owner'] as const)('keeps nothing English but product names, the %s way through', async path => {
      given(path)
      const english = await walk('en', path)
      unmount()
      const translated = await walk(language, path)

      expect(translated.map(step => step.step)).toEqual(english.map(step => step.step))
      translated.forEach(({ step, texts }, index) => {
        const englishTexts = new Set(english[index].texts)
        const englishWords = new Set(english[index].texts.flatMap(words).map(word => word.toLowerCase()))
        const same = texts.filter(text => englishTexts.has(text))

        expect(same.filter(text => words(text).length > 0), `${step}: shown as in English`).toEqual([])
        expect(
          texts.flatMap(words).filter(word => englishWords.has(word.toLowerCase()) && !NATIVE[language].includes(word)),
          `${step}: English words`
        ).toEqual([])
      })
    })

    it('labels the dialog in the language chosen', async () => {
      const host = await mount(language)

      expect(t('firstRun.label')).not.toBe(en['firstRun.label'])
      expect(host.querySelector(`[role="dialog"][aria-label="${t('firstRun.label')}"]`)).not.toBeNull()
      expect(host.querySelector(`[aria-label="${en['firstRun.label']}"]`)).toBeNull()
    })
  })
})

describe("first-run setup's disk password", () => {
  async function toTheStepAfterTheAccount(state: { diskEncrypted: boolean | null; newOwner: boolean; signedIn?: boolean }): Promise<HTMLElement> {
    bridge.setup.state.mockResolvedValue({ needed: true, signedIn: state.signedIn ?? false, ...state })
    const host = await mount('en')
    await click(button(host, t('firstRun.welcome.forMe')))
    await type(host.querySelector('input[autocomplete="name"]'), 'Ana')
    for (const input of host.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
      await type(input, 'correct horse')
    }
    await click(button(host, t('firstRun.next')))

    return host
  }

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [null, true]
  ])('is not asked for when the disk is encrypted: %s, and the owner is new: %s', async (diskEncrypted, newOwner) => {
    const host = await toTheStepAfterTheAccount({ diskEncrypted, newOwner })
    expect(heading(host)).toBe(t('firstRun.wifi.title'))
  })

  it('says to use a wired or 2.4 GHz keyboard, and that the old one still works until it changes', async () => {
    const host = await toTheStepAfterTheAccount({ diskEncrypted: true, newOwner: true })
    expect(host.textContent).toContain('wired keyboard')
    expect(host.textContent).toContain('2.4 GHz')
    expect(host.textContent).toContain(t('firstRun.disk.laterHint'))
  })

  it('can wait, without changing anything', async () => {
    bridge.setup.diskPassword.mockClear()
    const host = await toTheStepAfterTheAccount({ diskEncrypted: true, newOwner: true })
    await click(button(host, t('firstRun.later')))
    expect(heading(host)).toBe(t('firstRun.wifi.title'))
    expect(bridge.setup.diskPassword).not.toHaveBeenCalled()
  })

  it('asks for the account password when the account step did not set one', async () => {
    const host = await toTheStepAfterTheAccount({ diskEncrypted: true, newOwner: true, signedIn: true })
    const inputs = host.querySelectorAll<HTMLInputElement>('input[type="password"]')
    expect(inputs).toHaveLength(4)
    expect(host.textContent).toContain(t('firstRun.disk.account'))
    await type(inputs[0], 'given at start-up')
    await type(inputs[1], 'my own disk pass')
    await type(inputs[2], 'my own disk pass')
    expect(button(host, t('firstRun.next'))?.disabled).toBe(true)
    await type(inputs[3], 'my account pass')
    await click(button(host, t('firstRun.next')))
    expect(bridge.setup.diskPassword).toHaveBeenLastCalledWith({ current: 'given at start-up', password: 'my own disk pass', account: 'my account pass' })
    expect(heading(host)).toBe(t('firstRun.wifi.title'))
  })
})

describe("first-run setup's keyring", () => {
  async function afterTheAccount(state: Partial<SetupState>, language: Language = 'en'): Promise<HTMLElement> {
    bridge.setup.keyring.mockClear()
    bridge.setup.state.mockResolvedValue({ needed: true, signedIn: true, newOwner: false, ...state })
    const host = await mount(language)
    await click(button(host, t('firstRun.welcome.forMe')))
    await type(host.querySelector('input[autocomplete="name"]'), 'Ana')
    await click(button(host, t('firstRun.next')))

    return host
  }

  it.each([
    [true, 'open'],
    [true, 'password'],
    [false, 'open'],
    [false, 'password'],
    [false, 'other'],
    [null, 'other'],
    [false, null],
    [false, undefined]
  ] as const)('leaves a keyring alone, and asks nothing, when its disk is encrypted: %s and the keyring is %s', async (keyringEncrypted, keyring) => {
    const host = await afterTheAccount({ diskEncrypted: keyringEncrypted, keyringEncrypted, keyring })
    expect(heading(host)).toBe(t('firstRun.wifi.title'))
    expect(bridge.setup.keyring).not.toHaveBeenCalled()
  })

  it.each<[boolean, string]>([
    // The system disk does not decide: only the disk that holds the keyring folder does.
    [true, 'an encrypted system disk'],
    [false, 'a system disk that is not encrypted, under an encrypted home']
  ])('makes one with no password of its own when its disk is encrypted, with %s, without asking, and says so at the end', async diskEncrypted => {
    const host = await afterTheAccount({ diskEncrypted, keyringEncrypted: true, keyring: 'none' })
    expect(heading(host)).toBe(t('firstRun.wifi.title'))
    expect(bridge.setup.keyring).toHaveBeenCalledExactlyOnceWith({ password: '' })
    await click(button(host, t('firstRun.next')))
    await click(button(host, t('firstRun.later')))
    expect(heading(host)).toBe(t('firstRun.done.title'))
    expect(host.textContent).toContain(t('firstRun.keyring.encrypted'))
  })

  it('says nothing about a keyring it could not make on an encrypted disk', async () => {
    bridge.setup.keyring.mockResolvedValueOnce({ ok: false, reason: 'noKeyringService' })
    const host = await afterTheAccount({ diskEncrypted: true, keyringEncrypted: true, keyring: 'none' })
    await click(button(host, t('firstRun.next')))
    await click(button(host, t('firstRun.later')))
    expect(heading(host)).toBe(t('firstRun.done.title'))
    expect(host.textContent).not.toContain(t('firstRun.keyring.encrypted'))
  })

  it.each([
    [false, false, 'firstRun.keyring.text'],
    // Unknown: setup asks, without saying the disk is unencrypted.
    [null, null, 'firstRun.keyring.textUnknown'],
    [false, null, 'firstRun.keyring.textUnknown'],
    // An encrypted system disk with /home (or the keyring folder) on one that is not, or cannot be told.
    [true, false, 'firstRun.keyring.text'],
    [true, null, 'firstRun.keyring.textUnknown']
  ] as const)('asks how to protect it when the system disk is encrypted: %s and the keyring disk: %s, saying %s', async (diskEncrypted, keyringEncrypted, text) => {
    const host = await afterTheAccount({ diskEncrypted, keyringEncrypted, keyring: 'none' })
    expect(heading(host)).toBe(t('firstRun.keyring.title'))
    expect(host.textContent).toContain(t(text))
    expect(host.textContent).not.toContain(t(keyringEncrypted === false ? 'firstRun.keyring.textUnknown' : 'firstRun.keyring.text'))
    expect(bridge.setup.keyring).not.toHaveBeenCalled()
  })

  it.each(['en', 'pt-BR', 'zh-CN'] as const)('says in %s what each choice means', async language => {
    const host = await afterTheAccount({ diskEncrypted: false, keyringEncrypted: false, keyring: 'none' }, language)
    for (const key of ['firstRun.keyring.password', 'firstRun.keyring.passwordHint', 'firstRun.keyring.open', 'firstRun.keyring.openHint', 'firstRun.keyring.laterHint'] as const) {
      expect(host.textContent, key).toContain(t(key))
    }
    const words = {
      en: ['anyone who has the disk can read them', 'If you forget it'],
      'pt-BR': ['quem estiver com o disco consegue ler', 'Se você esquecer'],
      'zh-CN': ['拿到那块磁盘的人都能读取', '如果忘记了']
    }[language]
    for (const word of words) {
      expect(host.textContent, word).toContain(word)
    }
  })

  it('makes one with no password of its own when chosen, and asks for none', async () => {
    const host = await afterTheAccount({ diskEncrypted: false, keyringEncrypted: false, keyring: 'none' })
    await click(button(host, t('firstRun.keyring.open')))
    expect(host.querySelectorAll('input[type="password"]')).toHaveLength(0)
    expect(button(host, t('firstRun.keyring.open'))?.getAttribute('aria-pressed')).toBe('true')
    await click(button(host, t('firstRun.next')))
    expect(bridge.setup.keyring).toHaveBeenCalledExactlyOnceWith({ password: '' })
    expect(heading(host)).toBe(t('firstRun.wifi.title'))
  })

  it('needs 8 characters typed the same twice for a keyring password', async () => {
    const host = await afterTheAccount({ diskEncrypted: false, keyringEncrypted: false, keyring: 'none' })
    await click(button(host, t('firstRun.keyring.password')))
    const [password, again] = host.querySelectorAll<HTMLInputElement>('input[type="password"]')
    await type(password, 'short')
    await type(again, 'short')
    expect(button(host, t('firstRun.next'))?.disabled).toBe(true)
    // Seven characters are one too few; eight are enough.
    await type(password, 'correct')
    await type(again, 'correct')
    expect(button(host, t('firstRun.next'))?.disabled).toBe(true)
    await type(password, 'correct!')
    await type(again, 'correct!')
    expect(button(host, t('firstRun.next'))?.disabled).toBe(false)
    // Characters, as the command counts them: 8 UTF-16 units each, but 4 and 7 characters.
    for (const short of ['😀😀😀😀', 'abcdef😀']) {
      await type(password, short)
      await type(again, short)
      expect(button(host, t('firstRun.next'))?.disabled, short).toBe(true)
    }
    await type(password, 'abcdefg😀')
    await type(again, 'abcdefg😀')
    expect(button(host, t('firstRun.next'))?.disabled).toBe(false)
    await type(password, 'senha do coração')
    await type(again, 'senha do coração')
    expect(host.textContent).toContain(t('firstRun.keyring.sameAsAccount'))
    await click(button(host, t('firstRun.next')))
    expect(bridge.setup.keyring).toHaveBeenCalledExactlyOnceWith({ password: 'senha do coração' })
    expect(heading(host)).toBe(t('firstRun.wifi.title'))
  })

  it('can wait, without making anything', async () => {
    const host = await afterTheAccount({ diskEncrypted: false, keyringEncrypted: false, keyring: 'none' })
    await click(button(host, t('firstRun.later')))
    expect(heading(host)).toBe(t('firstRun.wifi.title'))
    expect(bridge.setup.keyring).not.toHaveBeenCalled()
  })

  it('moves on when the account has a keyring by then, which stays as it is', async () => {
    bridge.setup.keyring.mockResolvedValueOnce({ ok: false, reason: 'keyringExists' })
    const host = await afterTheAccount({ diskEncrypted: false, keyringEncrypted: false, keyring: 'none' })
    await click(button(host, t('firstRun.keyring.open')))
    await click(button(host, t('firstRun.next')))
    expect(heading(host)).toBe(t('firstRun.wifi.title'))
  })

  it('is not asked for someone else', async () => {
    bridge.setup.keyring.mockClear()
    bridge.setup.state.mockResolvedValue({ needed: true, signedIn: false, diskEncrypted: false, newOwner: false, keyring: 'none', keyringEncrypted: false })
    const host = await mount('en')
    await click(button(host, t('firstRun.welcome.forSomeoneElse')))
    await click(button(host, t('firstRun.next')))
    expect(heading(host)).toBe(t('firstRun.handOver.title'))
    expect(bridge.setup.keyring).not.toHaveBeenCalled()
  })
})

describe('handing the computer over', () => {
  it.each([
    [true, 'firstRun.handOver.textEncrypted', false, false],
    [false, 'firstRun.handOver.text', true, false],
    // Unknown: neither the disk password to pass on nor a claim that the disk is unencrypted, but it says it could not tell.
    [null, 'firstRun.handOver.text', false, true]
  ] as const)('on a disk encrypted: %s, says %s and whether a reset is a secure erase', async (diskEncrypted, text, warns, unknown) => {
    bridge.setup.state.mockResolvedValue({ needed: true, signedIn: false, diskEncrypted, newOwner: false })
    const host = await mount('en')
    await click(button(host, t('firstRun.welcome.forSomeoneElse')))
    await click(button(host, t('firstRun.next')))
    expect(heading(host)).toBe(t('firstRun.handOver.title'))
    expect(host.textContent).toContain(t(text))
    expect(host.textContent?.includes(t('firstRun.handOver.notEncrypted'))).toBe(warns)
    expect(host.textContent?.includes(t('firstRun.handOver.encryptionUnknown'))).toBe(unknown)
  })
})

describe("the disk step's warning", () => {
  it.each(['en', 'pt-BR', 'zh-CN'] as const)('says in %s that every other way to open the disk goes too', async language => {
    bridge.setup.state.mockResolvedValue({ needed: true, signedIn: false, diskEncrypted: true, newOwner: true })
    const host = await mount(language)
    await click(button(host, t('firstRun.welcome.forMe')))
    await type(host.querySelector('input[autocomplete="name"]'), 'Ana')
    for (const input of host.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
      await type(input, 'correct horse')
    }
    await click(button(host, t('firstRun.next')))
    expect(heading(host)).toBe(t('firstRun.disk.title'))
    const text = host.textContent ?? ''
    const words = { en: ['recovery keys', 'security key', 'TPM'], 'pt-BR': ['chaves de recuperação', 'chave de segurança', 'TPM'], 'zh-CN': ['恢复密钥', '安全密钥', 'TPM'] }[language]
    for (const word of words) {
      expect(text, word).toContain(word)
    }
  })
})

describe('a refused current disk password', () => {
  it('says which way of unlocking it belongs to, never the recovery key for the others, in every language', () => {
    const keys = ['firstRun.disk.recoveryKey', 'firstRun.disk.tpmKey', 'firstRun.disk.fido2Key', 'firstRun.disk.otherKey'] as const
    const recovery = { en: 'recovery key', 'pt-BR': 'chave de recuperação', 'zh-CN': '恢复密钥' } as const
    for (const language of ['en', 'pt-BR', 'zh-CN'] as const) {
      $prefs.set({ ...$prefs.get(), language })
      const texts = keys.map(key => t(key))
      expect(new Set(texts).size, language).toBe(4)
      expect(texts[0], language).toContain(recovery[language])
      for (const text of texts.slice(1)) {
        expect(text, language).not.toContain(recovery[language])
      }
      expect(texts[1], language).toContain('TPM')
      expect(texts[2], language).toContain('FIDO2')
    }
  })
})

describe('handing over a computer whose encryption could not be told', () => {
  it.each(['en', 'pt-BR', 'zh-CN'] as const)('says so in %s', async language => {
    bridge.setup.state.mockResolvedValue({ needed: true, signedIn: false, diskEncrypted: null, newOwner: false })
    const host = await mount(language)
    await click(button(host, t('firstRun.welcome.forSomeoneElse')))
    await click(button(host, t('firstRun.next')))
    expect(heading(host)).toBe(t('firstRun.handOver.title'))
    expect(host.textContent).toContain(t('firstRun.handOver.encryptionUnknown'))
    expect(host.textContent).not.toContain(t('firstRun.handOver.notEncrypted'))
    if (language !== 'en') {
      expect(t('firstRun.handOver.encryptionUnknown')).not.toBe(en['firstRun.handOver.encryptionUnknown'])
    }
  })
})

describe('a disk password whose secret another way of unlocking shares', () => {
  it.each(['en', 'pt-BR', 'zh-CN'] as const)('says so in %s, and does not ask for it again', async language => {
    bridge.setup.state.mockResolvedValue({ needed: true, signedIn: false, diskEncrypted: true, newOwner: true })
    const host = await mount(language)
    await click(button(host, t('firstRun.welcome.forMe')))
    await type(host.querySelector('input[autocomplete="name"]'), 'Ana')
    for (const input of host.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
      await type(input, 'correct horse')
    }
    await click(button(host, t('firstRun.next')))
    const [current, password, again] = host.querySelectorAll<HTMLInputElement>('input[type="password"]')
    await type(current, 'given at start-up')
    await type(password, 'my own disk pass')
    await type(again, 'my own disk pass')
    bridge.setup.diskPassword.mockClear()
    bridge.setup.diskPassword.mockResolvedValue({ ok: false, reason: 'sharedSecret' })
    await click(button(host, t('firstRun.next')))
    expect(host.querySelector('.text-danger')?.textContent).toBe(t('firstRun.disk.sharedSecret'))
    // Not the recovery key's or the TPM's "that is not the disk password", and no asking to type it again.
    expect(t('firstRun.disk.sharedSecret')).not.toBe(t('firstRun.disk.recoveryKey'))
    expect(t('firstRun.disk.sharedSecret')).not.toBe(t('firstRun.disk.tpmKey'))
    expect(button(host, t('firstRun.next'))?.disabled).toBe(true)
    await act(async () => host.querySelector('form')?.requestSubmit())
    await settle()
    expect(bridge.setup.diskPassword).toHaveBeenCalledTimes(1)
    await click(button(host, t('firstRun.later')))
    expect(heading(host)).toBe(t('firstRun.wifi.title'))
    bridge.setup.diskPassword.mockReset()
    bridge.setup.diskPassword.mockResolvedValue({ ok: true })
  })

  it('names the shared secret, not a wrong password, in every language', () => {
    for (const language of ['en', 'pt-BR', 'zh-CN'] as const) {
      $prefs.set({ ...$prefs.get(), language })
      const text = t('firstRun.disk.sharedSecret')
      expect(text, language).toContain('herald-os password --disk --new-owner')
      // A TPM token's secret is random, never a password typed twice: the examples are the recovery key and a password.
      expect(text, language).not.toContain('TPM')
      expect(text, language).toContain({ en: 'recovery key', 'pt-BR': 'chave de recuperação', 'zh-CN': '恢复密钥' }[language])
    }
    $prefs.set({ ...$prefs.get(), language: 'en' })
    expect(t('firstRun.disk.sharedSecret')).not.toMatch(/type the password/i)
    expect(t('firstRun.disk.sharedSecret')).toContain('secret of its own first')
  })
})
