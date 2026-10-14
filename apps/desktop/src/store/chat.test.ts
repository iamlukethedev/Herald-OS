import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyChat } from '../lib/chat-model.ts'

// Hermes's socket, faked: each request is recorded and answered by `reply`.
const hermes = vi.hoisted(() => ({ requests: [] as string[], reply: (_method: string): unknown => ({}) }))

vi.mock('./gateway.ts', () => ({
  gatewayRequest: async (method: string) => {
    hermes.requests.push(method)

    return hermes.reply(method)
  },
  isGatewayOpen: () => false,
  onGatewayEvent: () => () => undefined,
  onAnyGatewayEvent: () => () => undefined
}))

const { $chats, runSlash } = await import('./chat.ts')

describe('runSlash', () => {
  beforeEach(() => {
    hermes.requests.length = 0
    $chats.set({ s1: emptyChat('s1', 'stored-1') })
  })

  it('answers a bare /model from model.options, which knows the model before the agent is built', async () => {
    hermes.reply = method =>
      method === 'model.options' ? { model: 'qwen3-30b-a3b', provider: 'custom:qwen-flash', providers: [{ slug: 'qwen-flash', name: 'qwen-flash', aliases: ['custom:qwen-flash', 'qwen-flash'] }] } : { output: 'Current model: (unknown)' }

    await runSlash('/model', 's1')

    expect(hermes.requests).toEqual(['model.options'])
    expect($chats.get().s1.messages).toMatchObject([
      { role: 'user', text: '/model' },
      { role: 'system', text: 'Current model: qwen3-30b-a3b (qwen-flash)' }
    ])
  })

  it("leaves a switch, and a session model.options names no model for, to Hermes's slash commands", async () => {
    hermes.reply = method => (method === 'model.options' ? { model: '', providers: [] } : { output: 'Current model: (unknown)' })

    await runSlash('/model', 's1')
    await runSlash('/model gpt-5 --provider openai-api', 's1')

    expect(hermes.requests).toEqual(['model.options', 'slash.exec', 'slash.exec'])
  })
})
