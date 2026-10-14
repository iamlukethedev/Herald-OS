import { describe, expect, it, vi } from 'vitest'
import { copyConcealedMac, parseVisionOutput } from './mac-tools.ts'

const run = vi.hoisted(() => vi.fn(async (_command: string, _args: string[], _timeout?: number, _input?: string) => ({ code: 0, stdout: '', stderr: '' })))

vi.mock('./exec.ts', () => ({ run }))

describe('parseVisionOutput', () => {
  it('keeps the lines Vision read, trimmed, without blanks', () => {
    expect(parseVisionOutput('["Hello from Herald OS", "  Order 4471 ", ""]\n')).toEqual(['Hello from Herald OS', 'Order 4471'])
  })

  it('treats anything else as nothing found', () => {
    expect(parseVisionOutput('')).toEqual([])
    expect(parseVisionOutput('not json')).toEqual([])
    expect(parseVisionOutput('{"a": 1}')).toEqual([])
    expect(parseVisionOutput('[1, "x"]')).toEqual(['x'])
  })
})

describe('copyConcealedMac', () => {
  const secret = 'otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP'

  it('hands the text over on stdin, never on the command line', async () => {
    await copyConcealedMac(secret)

    const [command, args, , input] = run.mock.calls[0]
    expect(command).toBe('osascript')
    expect(args.join(' ')).not.toContain('JBSWY3DPEHPK3PXP')
    expect(input).toBe(secret)
  })

  it('fails loudly so the caller can fall back to a plain copy', async () => {
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'execution error' })

    await expect(copyConcealedMac(secret)).rejects.toThrow('execution error')
  })
})
