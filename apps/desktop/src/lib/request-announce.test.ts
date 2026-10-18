// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { $prefs } from '../store/backend.ts'
import type { PendingRequest } from '../store/requests.ts'
import { announcementOf, freshArrivals } from './request-announce.ts'

const request = (kind: PendingRequest['kind'], id: string, params: Record<string, unknown>) => ({ kind, request: { id, method: kind, params, respond: vi.fn(), fail: vi.fn() }, receivedAt: 0 }) as unknown as PendingRequest

const approval = request('approval', 'r1', { description: 'Move Budget.xlsx to Archive', command: 'mv Budget.xlsx Archive/' })

afterEach(() => {
  $prefs.set({ ...$prefs.get(), language: 'en' })
})

describe('announcementOf', () => {
  it('says what an approval asks, how many more wait, and the keys that go to it', () => {
    $prefs.set({ ...$prefs.get(), language: 'en' })

    expect(announcementOf(approval, 0, 'Cmd+Option+A')).toBe('Hermes is asking for permission: Move Budget.xlsx to Archive. Press Cmd+Option+A to go to it.')
    expect(announcementOf(approval, 2, 'Super+Shift+A')).toBe('Hermes is asking for permission: Move Budget.xlsx to Archive. 2 more are waiting. Press Super+Shift+A to go to it.')
    expect(announcementOf(approval, 1, 'Super+Shift+A')).toContain('1 more is waiting.')
  })

  it('reads the question, the password request and the secret, never a value', () => {
    $prefs.set({ ...$prefs.get(), language: 'en' })

    expect(announcementOf(request('clarify', 'c1', { question: 'Which folder?' }), 0, 'K')).toBe('Hermes has a question: Which folder? Press K to go to it.')
    expect(announcementOf(request('clarify', 'c2', { questions: [{ qid: 'a', question: 'Keep both?' }] }), 0, 'K')).toContain('Keep both?')
    expect(announcementOf(request('sudo', 's1', { command: 'apt upgrade' }), 0, 'K')).toBe('Hermes needs the administrator password. Press K to go to it.')
    expect(announcementOf(request('secret', 'x1', { env_var: 'OPENAI_API_KEY' }), 0, 'K')).toBe('Hermes needs a secret: OPENAI_API_KEY. Press K to go to it.')
  })

  it('falls back to the plain sentence when a request says nothing, and cuts a long detail', () => {
    $prefs.set({ ...$prefs.get(), language: 'en' })

    expect(announcementOf(request('approval', 'r2', {}), 0, 'K')).toBe('Hermes is asking for permission. Press K to go to it.')
    expect(announcementOf(request('secret', 'x2', {}), 0, 'K')).toBe('Hermes needs a secret. Press K to go to it.')
    const long = announcementOf(request('approval', 'r3', { command: `rm ${'x'.repeat(400)}` }), 0, 'K')
    expect(long.length).toBeLessThan(260)
    expect(long).toContain('…')
  })

  it('speaks Brazilian Portuguese', () => {
    $prefs.set({ ...$prefs.get(), language: 'pt-BR' })

    expect(announcementOf(approval, 2, 'Super+Shift+A')).toBe('O Hermes está pedindo permissão: Move Budget.xlsx to Archive. Mais 2 pedidos aguardando. Pressione Super+Shift+A para ir até o pedido.')
    expect(announcementOf(approval, 1, 'K')).toContain('Mais 1 pedido aguardando.')
  })

  it('speaks Simplified Chinese', () => {
    $prefs.set({ ...$prefs.get(), language: 'zh-CN' })

    expect(announcementOf(approval, 2, 'Cmd+Option+A')).toBe('Hermes 请求你的批准：Move Budget.xlsx to Archive。还有 2 个请求在等待。按 Cmd+Option+A 前往该请求。')
  })
})

describe('freshArrivals', () => {
  it('returns each request once, however often it is asked', () => {
    const announced = new Set<string>()
    const second = request('clarify', 'c1', { question: 'Which?' })

    expect(freshArrivals([approval], announced).map(entry => entry.request.id)).toEqual(['r1'])
    expect(freshArrivals([approval], announced)).toEqual([])
    expect(freshArrivals([approval, second], announced).map(entry => entry.request.id)).toEqual(['c1'])
  })

  it('forgets requests that are answered, so an id that comes back is announced again', () => {
    const announced = new Set<string>()
    freshArrivals([approval], announced)

    freshArrivals([], announced)

    expect(announced.size).toBe(0)
    expect(freshArrivals([approval], announced)).toHaveLength(1)
  })
})
