import { describe, expect, it } from 'vitest'
import { isAuthErrorText, parseActiveProvider, signInTarget } from './hermes-auth.ts'

describe('parseActiveProvider', () => {
  it('reads model.provider from the raw config', () => {
    expect(parseActiveProvider("model:\n  provider: nous\n  default: z-ai/glm-5.2\n  base_url: ''\nagent:\n  reasoning_effort: high\n")).toBe('nous')
    expect(parseActiveProvider('model:\n  default: gpt-5\n  provider: "openai-codex"\n')).toBe('openai-codex')
  })

  it('returns null when absent', () => {
    expect(parseActiveProvider('agent:\n  provider: not-the-model\n')).toBeNull()
    expect(parseActiveProvider('')).toBeNull()
  })
})

describe('signInTarget', () => {
  const nous = { id: 'nous', flow: 'device_code' }
  const codex = { id: 'openai-codex', flow: 'device_code' }
  const copilot = { id: 'copilot-acp', flow: 'external' }
  const providers = [copilot, nous, codex]

  it('signs in to the provider the person picked, else to the active one', () => {
    expect(signInTarget(providers, 'nous', 'openai-codex')).toBe(codex)
    expect(signInTarget(providers, 'copilot-acp', null)).toBe(copilot)
  })

  it('with no provider set yet, signs in to the first one with a code', () => {
    expect(signInTarget(providers, null, null)).toBe(nous)
    expect(signInTarget(providers, 'auto', null)).toBe(nous)
  })

  it('has nothing to sign in to while Hermes uses an API key', () => {
    expect(signInTarget(providers, 'openrouter', null)).toBeNull()
  })
})

describe('isAuthErrorText', () => {
  it('matches sign-in failures only', () => {
    expect(isAuthErrorText('agent init failed: No access token found for Nous Portal login.')).toBe(true)
    expect(isAuthErrorText('Refresh session has been revoked (invalid_grant)')).toBe(true)
    expect(isAuthErrorText('Tool terminal timed out after 60s')).toBe(false)
    expect(isAuthErrorText(undefined)).toBe(false)
  })
})
