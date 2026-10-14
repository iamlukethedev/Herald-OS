import { beforeEach, describe, expect, it, vi } from 'vitest'

const edges = vi.hoisted(() => {
  const type = vi.fn(async (_text: string, _options: Record<string, unknown>) => ({ typed: true, copied: false }) as { typed: boolean; copied: boolean; missing?: string })

  Object.assign(globalThis, { window: { heraldOS: { dictation: { type } } } })

  return { type, notify: vi.fn(), frame: null as null | ((frame: { pcm: Int16Array; level: number; ms: number }) => void) }
})

vi.mock('../lib/voice/audio-capture.ts', () => ({
  subscribeMicrophone: async (onFrame: (frame: { pcm: Int16Array; level: number; ms: number }) => void) => {
    edges.frame = onFrame

    return () => undefined
  }
}))
vi.mock('../lib/voice/vad.ts', () => ({
  DEFAULT_ENDPOINTER: {},
  // Every frame is speech; the test ends dictation itself.
  Endpointer: class {
    feed() {
      return 'speech-start'
    }
  }
}))
vi.mock('../lib/rest.ts', () => ({ rest: { post: async () => ({ transcript: 'meet at noon' }) } }))
vi.mock('../lib/voice/provider-fallback.ts', () => ({ withProviderFallback: (_kind: string, attempt: () => Promise<unknown>) => attempt() }))
vi.mock('./shell.ts', () => ({ isMainSurface: false, isPanels: false, surface: 'desktop', onShellCommand: () => () => undefined }))
vi.mock('./voice.ts', async () => ({ $voiceActive: (await import('nanostores')).atom(false) }))
vi.mock('./notifications.ts', () => ({ notify: edges.notify }))

const { finishDictation, startDictation } = await import('./dictation.ts')
const { TARGET_SAMPLE_RATE } = await import('../lib/voice/pcm.ts')

async function dictate(): Promise<void> {
  await startDictation()
  edges.frame!({ pcm: new Int16Array(TARGET_SAMPLE_RATE), level: 0.5, ms: 1000 })
  await finishDictation()
}

beforeEach(() => {
  edges.type.mockClear()
  edges.notify.mockClear()
})

describe('dictation into another app', () => {
  it('says nothing when the words were typed', async () => {
    await dictate()

    expect(edges.type).toHaveBeenCalledTimes(1)
    expect(edges.notify).not.toHaveBeenCalled()
  })

  it('says the words are on the clipboard, as before', async () => {
    edges.type.mockResolvedValueOnce({ typed: false, copied: true })
    await dictate()

    expect(edges.notify).toHaveBeenCalledWith({ title: 'Dictation copied', body: expect.stringMatching(/^Paste it where you want it: /), level: 'info' })
  })

  it('names the macOS permission that kept them from being typed', async () => {
    edges.type.mockResolvedValueOnce({ typed: false, copied: true, missing: 'automation' })
    await dictate()

    expect(edges.notify).toHaveBeenCalledWith({
      title: 'Dictation copied',
      body: expect.stringMatching(/^Herald OS can't type into other apps without the Automation permission for System Events .*Paste it where you want it: /),
      level: 'warn'
    })
  })
})
