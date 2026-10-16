import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICE_DEFAULTS } from '../../shared/voice-prefs.ts'

// A spoken sum through the voice store's fast path: the matcher, the registry and the calc
// commands are real; Herald Calc's engine, its context and history, and the stores voice reads are
// stand-ins.

vi.hoisted(() => {
  Object.assign(globalThis, { window: { innerWidth: 1440, innerHeight: 900, heraldOS: {} }, document: { activeElement: null } })
})

const calc = vi.hoisted(() => ({ evaluate: vi.fn(), convert: vi.fn(), compileFunction: vi.fn(), loadEngine: vi.fn(), recordCalc: vi.fn() }))

vi.mock('./backend.ts', () => ({
  $prefs: atom({ voice: { ...VOICE_DEFAULTS, enabled: true, engine: 'chained' } }),
  $prefsLoaded: atom(true),
  $env: atom({ platform: 'darwin' }),
  $windowState: atom({ fullscreen: false, focused: true }),
  updatePrefs: async () => undefined
}))
vi.mock('./gateway.ts', () => ({ $gatewayReady: atom({ version: 'test' }), gatewayRequest: async () => ({}), onGatewayEvent: () => () => undefined }))
vi.mock('./wake.ts', () => ({ pauseWake: async () => undefined, resumeWake: async () => undefined }))
vi.mock('./shell.ts', () => ({ isMainSurface: true, onShellCommand: () => () => undefined }))
vi.mock('../lib/voice/earcons.ts', () => ({ earcons: new Proxy({}, { get: () => () => undefined }) }))
vi.mock('../features/calc/engine/index.ts', () => ({ evaluate: calc.evaluate, convert: calc.convert, compileFunction: calc.compileFunction, loadEngine: calc.loadEngine }))
vi.mock('../features/calc/context.ts', () => ({ calcContext: async () => ({ locale: 'en-AU', now: 0, zone: 'Australia/Sydney', rates: null }) }))
vi.mock('../features/calc/history/store.ts', () => ({ recordCalc: calc.recordCalc }))
vi.mock('../features/calc/open.ts', () => ({ openCalc: () => undefined }))

const { calcCommands } = await import('../commands/calc.ts')
const { defineCommands, resetCommands } = await import('./os-commands.ts')
const { runVoiceIntent } = await import('./voice.ts')

beforeEach(() => {
  vi.clearAllMocks()
  resetCommands()
  defineCommands(calcCommands)
})

describe('spoken math on the voice fast path', () => {
  it('answers at once with the engine, in words to speak', async () => {
    calc.evaluate.mockResolvedValue({ ok: true, input: '15% of 340', value: { kind: 'number', exact: '51', number: 51 }, display: '51', spoken: '51', steps: ['15% of 340 = 0.15 × 340', '= 51'] })

    expect(await runVoiceIntent("What's 15% of 340?")).toEqual({ handled: true, spoken: '15% of 340 is 51', ok: true })
    expect(calc.evaluate).toHaveBeenCalledWith('15% of 340', expect.objectContaining({ locale: 'en-AU' }))
    expect(calc.recordCalc).toHaveBeenCalledWith({ input: '15% of 340', result: '51', source: 'voice', context: 'Voice' })
  })

  it('hands a sum the engine cannot read to Hermes', async () => {
    calc.evaluate.mockResolvedValue({ ok: false, input: '2 + 2', steps: [], error: 'Herald Calc is not ready' })

    expect(await runVoiceIntent('what is 2 plus 2')).toEqual({ handled: false, spoken: 'Herald Calc is not ready', ok: false })
  })

  it('hands personal and reasoning math to Hermes without working anything out', async () => {
    for (const said of ["What's 15% of my rent?", 'how much should I tip on my dinner', 'explain compound interest']) {
      expect(await runVoiceIntent(said), said).toEqual({ handled: false, spoken: '', ok: false })
    }

    expect(calc.evaluate).not.toHaveBeenCalled()
  })
})
