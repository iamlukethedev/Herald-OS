import { describe, expect, it, vi } from 'vitest'

const edges = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  systemSpeech: vi.fn(async (_text: string, _locale: string) => ({ ok: false, reason: 'missing', detail: 'say is not installed' }))
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  globalShortcut: { register: () => true, unregister: () => undefined },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => edges.handlers.set(channel, handler) },
  session: { defaultSession: { setPermissionRequestHandler: () => undefined, setPermissionCheckHandler: () => undefined } },
  systemPreferences: { getMediaAccessStatus: () => 'granted', askForMediaAccess: async () => true }
}))
vi.mock('../platform/index.ts', () => ({ hostPlatform: () => ({ systemSpeech: edges.systemSpeech }) }))
vi.mock('../i18n.ts', () => ({ systemLanguages: () => ['pt-BR', 'en-US'] }))
vi.mock('../log.ts', () => ({ log: () => undefined }))
vi.mock('../paths.ts', () => ({ isShellPage: () => true }))

const { IPC } = await import('../../shared/ipc.ts')
const { registerVoiceIpc } = await import('./voice.ts')

describe('the system voice handler', () => {
  it("hands the platform the text and the system's language, and never anything but text", async () => {
    registerVoiceIpc({ audioWsUrl: () => 'ws://127.0.0.1:1/api/audio/speak-stream' } as unknown as Parameters<typeof registerVoiceIpc>[0])
    const speak = edges.handlers.get(IPC.voiceSystemSpeech)!

    expect(await speak({}, 'Hello there.')).toEqual({ ok: false, reason: 'missing', detail: 'say is not installed' })
    expect(edges.systemSpeech).toHaveBeenLastCalledWith('Hello there.', 'pt-BR')

    await speak({}, { text: 'not text' })
    expect(edges.systemSpeech).toHaveBeenLastCalledWith('', 'pt-BR')
  })
})
