import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureToolResult, HeraldOsResult } from '../../shared/ipc.ts'
import { $env } from '../store/backend.ts'
import type { CommandContext } from '../store/os-commands.ts'
import { captureCommands } from './capture.ts'

const bridge = vi.hoisted(() => ({
  tool: vi.fn(async (_tool: string): Promise<CaptureToolResult> => ({ cancelled: true })),
  heraldOs: vi.fn(async (_argv: string[]): Promise<HeraldOsResult> => ({ code: 0, stdout: '', stderr: '' }))
}))

// The stores read the preload bridge and the viewport when they load; tests run without a DOM.
vi.hoisted(() => {
  Object.assign(globalThis, {
    window: {
      innerWidth: 1440,
      innerHeight: 900,
      matchMedia: () => ({ matches: true }),
      heraldOS: { capture: { tool: bridge.tool }, shell: { heraldOs: bridge.heraldOs } }
    },
    document: { documentElement: { dataset: {}, style: { setProperty: () => undefined, removeProperty: () => undefined } } }
  })
})

const AGENT: CommandContext = { source: 'agent' }
const ENV = { hermesHome: '/h/.hermes', homeDir: '/h', version: '0.0.0', isDev: false, shellMode: 'desktop' as const }
const OTP = 'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub'
const readQr = () => captureCommands.find(command => command.id === 'capture.qr')!.run({}, AGENT)

beforeEach(() => {
  bridge.tool.mockReset()
  bridge.heraldOs.mockReset()
})

describe('capture.qr on a Mac', () => {
  beforeEach(() => $env.set({ ...ENV, platform: 'darwin' }))

  it('says a 2FA code was copied, and keeps the secret out of the caption and of Hermes', async () => {
    bridge.tool.mockResolvedValue({ text: OTP, lines: 1 })
    const result = await readQr()

    expect(bridge.tool).toHaveBeenCalledWith('qr')
    expect(result).toMatchObject({ ok: true, summary: '2FA setup code copied', data: { kind: 'otp', description: 'a 2FA setup code for GitHub', onClipboard: true } })
    expect(JSON.stringify(result)).not.toContain('JBSWY3DPEHPK3PXP')
  })

  it('says where a link points, and hands Hermes the link', async () => {
    bridge.tool.mockResolvedValue({ text: 'https://example.com/menu', lines: 1 })

    expect(await readQr()).toMatchObject({ ok: true, summary: 'Link copied: example.com', data: { kind: 'link', text: 'https://example.com/menu' } })
  })

  it('hands Hermes ordinary text without showing it in the caption', async () => {
    bridge.tool.mockResolvedValue({ text: 'Table 4', lines: 1 })

    expect(await readQr()).toMatchObject({ ok: true, summary: 'QR code copied', data: { kind: 'text', text: 'Table 4' } })
  })

  it('reports nothing found and cancelling as before', async () => {
    bridge.tool.mockResolvedValueOnce({ text: '', lines: 0 })
    expect(await readQr()).toMatchObject({ ok: false, error: 'No QR code or barcode in that part of the screen.' })
    bridge.tool.mockResolvedValueOnce({ cancelled: true })
    expect(await readQr()).toMatchObject({ ok: false, error: 'QR code: cancelled.' })
  })
})

describe('capture.qr on Herald OS Linux', () => {
  beforeEach(() => $env.set({ ...ENV, platform: 'linux' }))

  it('asks the CLI for a description rather than the contents', async () => {
    bridge.heraldOs.mockResolvedValue({ code: 0, stdout: '{"kind": "wifi", "caption": "Wi-Fi details copied", "description": "a Wi-Fi network called \\"Home\\""}\n', stderr: '' })
    const result = await readQr()

    expect(bridge.heraldOs).toHaveBeenCalledWith(['capture', 'qr', '--json'])
    expect(result).toMatchObject({ ok: true, summary: 'Wi-Fi details copied', data: { kind: 'wifi', description: 'a Wi-Fi network called "Home"', onClipboard: true } })
    expect(result.data).not.toHaveProperty('text')
  })

  it('passes on a link the CLI judged ordinary', async () => {
    bridge.heraldOs.mockResolvedValue({ code: 0, stdout: '{"kind": "link", "caption": "Link copied: example.com", "description": "a link to example.com", "text": "https://example.com"}', stderr: '' })

    expect(await readQr()).toMatchObject({ summary: 'Link copied: example.com', data: { text: 'https://example.com' } })
  })

  it('shows nothing of what an older CLI printed', async () => {
    bridge.heraldOs.mockResolvedValue({ code: 0, stdout: `${OTP}\n`, stderr: '' })
    const result = await readQr()

    expect(result).toMatchObject({ ok: true, summary: 'QR code copied' })
    expect(JSON.stringify(result)).not.toContain('JBSWY3DPEHPK3PXP')
  })

  it('reports a failed scan', async () => {
    bridge.heraldOs.mockResolvedValue({ code: 127, stdout: '', stderr: 'herald-os: zbarimg is not installed (dnf install zbar)' })

    expect(await readQr()).toMatchObject({ ok: false, error: 'QR code: available on herald os linux.' })
    bridge.heraldOs.mockResolvedValue({ code: 1, stdout: '', stderr: 'herald-os: zbarimg is not installed (dnf install zbar)' })
    expect(await readQr()).toMatchObject({ ok: false, error: 'herald-os: zbarimg is not installed (dnf install zbar)' })
  })
})
