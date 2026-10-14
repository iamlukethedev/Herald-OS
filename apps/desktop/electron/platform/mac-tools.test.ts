import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { CONCEALED_COPY_SCRIPT, copyConcealedMac, parseVisionOutput } from './mac-tools.ts'

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

  it('declares the concealed marker with the text, and writes the marker before the text', async () => {
    run.mockClear()
    await copyConcealedMac(secret)

    const script = fs.readFileSync(run.mock.calls[0][1][2], 'utf8')
    expect(script).toBe(CONCEALED_COPY_SCRIPT)

    const declare = script.indexOf('board.declareTypesOwner($([concealed, $.NSPasteboardTypeString]), null)')
    const marker = script.indexOf('board.setDataForType($.NSData.data, concealed)')
    const text = script.indexOf('board.setStringForType(text, $.NSPasteboardTypeString)')
    expect(script).toContain("const concealed = 'org.nspasteboard.ConcealedType'")
    expect(declare).toBeGreaterThan(-1)
    expect(marker).toBeGreaterThan(declare)
    expect(text).toBeGreaterThan(marker)
    expect(script).not.toContain('clearContents')
  })

  it('fails loudly so the caller can decide whether a plain copy is safe', async () => {
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'execution error' })

    await expect(copyConcealedMac(secret)).rejects.toThrow('execution error')
  })
})
