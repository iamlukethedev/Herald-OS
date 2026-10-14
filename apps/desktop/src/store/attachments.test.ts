import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendState } from '../../shared/ipc.ts'
import { ELSEWHERE_NOTE } from '../lib/attachments.ts'
import { $uploading, attachFiles } from './attachments.ts'
import { $backend, $env } from './backend.ts'
import { $activeChatId, $chats, sendPrompt } from './chat.ts'

const bridge = vi.hoisted(() => ({ reads: [] as { file: string; maxBytes: number }[], unreadable: new Set<string>() }))
const gateway = vi.hoisted(() => ({ calls: [] as { method: string; params: Record<string, unknown> }[], refusal: null as Error | null }))

// main's side of the preload bridge: a file read whole, as electron/attachments.ts does.
vi.hoisted(() => {
  Object.assign(globalThis, {
    window: {
      heraldOS: {
        fs: {
          attachment: async (file: string, maxBytes: number) => {
            bridge.reads.push({ file, maxBytes })

            if (bridge.unreadable.has(file)) {
              throw new Error("Error invoking remote method 'herald-os:fs:attachment': Error: it is not a file")
            }

            const name = file.split('/').pop() ?? file

            return { name, size: name.length, dataUrl: `data:application/octet-stream;base64,${btoa(name)}` }
          }
        }
      }
    }
  })
})

vi.mock('./gateway.ts', () => ({
  gatewayRequest: vi.fn(async (method: string, params: Record<string, unknown>) => {
    gateway.calls.push({ method, params })

    switch (method) {
      case 'session.create':
        return { session_id: 'live-1', stored_session_id: 'stored-1', info: { desktop_contract: 8 }, messages: params.messages ?? [] }
      case 'file.attach': {
        if (gateway.refusal) {
          throw gateway.refusal
        }

        const copy = `/home/hermes/.hermes/attachments/${String(params.name)}`

        return { attached: true, name: params.name, path: copy, ref_path: copy, ref_text: `@file:${copy}`, uploaded: true }
      }
      case 'prompt.submit':
        return { status: 'streaming' }
      default:
        throw new Error(`unexpected ${method}`)
    }
  }),
  onAnyGatewayEvent: () => () => undefined,
  onGatewayEvent: () => () => undefined
}))

vi.mock('./sessions.ts', () => ({ refreshSessions: async () => undefined, rememberRuntimeId: () => undefined }))

const FILES = ['/Users/me/Desktop/report.pdf', '/Users/me/Downloads/notes.txt']
const COPIES = '/home/hermes/.hermes/attachments/report.pdf, /home/hermes/.hermes/attachments/notes.txt'
const dataUrl = (name: string) => `data:application/octet-stream;base64,${btoa(name)}`
const backend = (localFiles?: boolean): BackendState => ({ phase: 'ready', attempt: 0, logTail: [], localFiles })
const userTexts = () => ($chats.get()['live-1']?.messages ?? []).map(message => (message.role === 'user' ? message.text : `(${message.role})`))

beforeEach(() => {
  bridge.reads.length = 0
  bridge.unreadable.clear()
  gateway.calls.length = 0
  gateway.refusal = null
  $chats.set({})
  $activeChatId.set(null)
  $env.set({ homeDir: '/Users/me' } as never)
})

afterEach(() => $backend.set({ phase: 'idle', attempt: 0, logTail: [] }))

describe('files for a Hermes that reads this computer’s files', () => {
  it('are named by their own paths, and never read', async () => {
    for (const localFiles of [true, undefined]) {
      $backend.set(backend(localFiles))
      await expect(attachFiles('live-1', FILES, 8)).resolves.toBe(`Attached: ${FILES.join(', ')}`)
    }

    expect(bridge.reads).toEqual([])
    expect(gateway.calls).toEqual([])
  })

  it('go with the prompt from a chat that starts in the home folder, with no note', async () => {
    $backend.set(backend(true))
    await sendPrompt('', { attachments: [FILES[0]] })

    expect(gateway.calls[0]).toEqual({ method: 'session.create', params: { source: 'herald_os', cwd: '/Users/me', title: null } })
    expect(gateway.calls[1]).toMatchObject({ method: 'prompt.submit', params: { text: `Attached: ${FILES[0]}` } })
  })
})

describe('files for a Hermes that cannot read this computer’s files', () => {
  it('are uploaded into the session one by one, and named by the copies Hermes made', async () => {
    $backend.set(backend(false))
    const progress: unknown[] = []
    const stop = $uploading.listen(value => progress.push(value))

    await expect(attachFiles('live-1', FILES, 8)).resolves.toBe(`Attached (uploaded from my computer): ${COPIES}`)
    stop()

    // No `path`: Hermes would take a file of its own at the same path instead.
    expect(gateway.calls).toEqual([
      { method: 'file.attach', params: { session_id: 'live-1', name: 'report.pdf', data_url: dataUrl('report.pdf') } },
      { method: 'file.attach', params: { session_id: 'live-1', name: 'notes.txt', data_url: dataUrl('notes.txt') } }
    ])
    expect(progress).toEqual([{ name: 'report.pdf', index: 0, count: 2 }, { name: 'notes.txt', index: 1, count: 2 }, null])
  })

  it('are held to what an older Hermes’s WebSocket takes', async () => {
    $backend.set(backend(false))
    await attachFiles('live-1', [FILES[0]], 4)
    await attachFiles('live-1', [FILES[0]], 8)

    expect(bridge.reads.map(read => read.maxBytes)).toEqual([11 * 1024 * 1024, Number.MAX_SAFE_INTEGER])
  })

  it('stop at the first that cannot go, naming it', async () => {
    $backend.set(backend(false))
    bridge.unreadable.add(FILES[0])

    await expect(attachFiles('live-1', FILES, 8)).rejects.toThrow(/^report\.pdf was not sent to Hermes: it is not a file$/)
    expect(bridge.reads).toHaveLength(1)
    expect(gateway.calls).toEqual([])
    expect($uploading.get()).toBeNull()
  })

  it('go with the prompt from a chat that starts in Hermes’s own folders, told where the person is', async () => {
    $backend.set(backend(false))
    await sendPrompt('What is in these?', { attachments: FILES })

    expect(gateway.calls.map(call => call.method)).toEqual(['session.create', 'file.attach', 'file.attach', 'prompt.submit'])
    expect(gateway.calls[0].params).toEqual({ source: 'herald_os', cwd: null, title: null, messages: [{ role: 'user', content: ELSEWHERE_NOTE, display_kind: 'hidden' }] })
    expect(gateway.calls[3].params).toMatchObject({ session_id: 'live-1', text: `What is in these?\nAttached (uploaded from my computer): ${COPIES}` })
    // The note is Hermes's to read, not the person's.
    expect(userTexts()).toEqual([`What is in these?\nAttached (uploaded from my computer): ${COPIES}`])
  })

  it('that cannot go keep the prompt from being sent or shown', async () => {
    $backend.set(backend(false))
    gateway.refusal = new Error('the disk is full')

    await expect(sendPrompt('Summarise this', { attachments: [FILES[0]] })).rejects.toThrow('report.pdf was not sent to Hermes: the disk is full')
    expect(gateway.calls.map(call => call.method)).toEqual(['session.create', 'file.attach'])
    expect(userTexts()).toEqual([])
  })
})
