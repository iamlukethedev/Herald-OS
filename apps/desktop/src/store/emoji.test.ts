import { beforeEach, describe, expect, it, vi } from 'vitest'

const edges = vi.hoisted(() => {
  const storage = new Map<string, string>()
  const type = vi.fn(async (_text: string, _options: Record<string, unknown>) => ({ typed: true, copied: false }) as { typed: boolean; copied: boolean; missing?: string })

  Object.assign(globalThis, {
    window: { heraldOS: { dictation: { type } } },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }
  })

  return { type, relayToMain: vi.fn(), closeThisSurface: vi.fn(), notify: vi.fn() }
})

vi.mock('./shell.ts', () => ({
  isPanels: false,
  surface: 'emoji',
  closeThisSurface: edges.closeThisSurface,
  openSurface: vi.fn(),
  relayToMain: edges.relayToMain
}))
vi.mock('./edit-target.ts', () => ({ performEdit: vi.fn(), rememberFocusedEditable: vi.fn() }))
vi.mock('./notifications.ts', () => ({ notify: edges.notify }))

const { insertEmoji } = await import('./emoji.ts')

beforeEach(() => {
  edges.type.mockClear()
  edges.relayToMain.mockClear()
  edges.closeThisSurface.mockClear()
})

describe('an emoji picked over another app', () => {
  it('says nothing when it was typed', async () => {
    await insertEmoji('🎉')

    expect(edges.type).toHaveBeenCalledWith('🎉', { delayMs: 220 })
    expect(edges.closeThisSurface).toHaveBeenCalledTimes(1)
    expect(edges.relayToMain).not.toHaveBeenCalled()
  })

  it('tells the Hermes window it is on the clipboard', async () => {
    edges.type.mockResolvedValueOnce({ typed: false, copied: true })
    await insertEmoji('🎉')

    expect(edges.relayToMain).toHaveBeenCalledWith({ type: 'notify', args: ['Copied 🎉', 'It could not be typed into the app, so it is on the clipboard. Paste it where you want it.'] })
  })

  it('names the macOS permission that kept it from being typed', async () => {
    edges.type.mockResolvedValueOnce({ typed: false, copied: true, missing: 'accessibility' })
    await insertEmoji('🎉')

    expect(edges.relayToMain.mock.calls[0][0].args[1]).toMatch(/^Herald OS can't type into other apps without the Accessibility permission/)
  })

  it('stays quiet when main could not be reached', async () => {
    edges.type.mockRejectedValueOnce(new Error('gone'))
    await insertEmoji('🎉')

    expect(edges.relayToMain).not.toHaveBeenCalled()
  })
})
