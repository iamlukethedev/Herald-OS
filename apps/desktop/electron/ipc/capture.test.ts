import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  status: 'denied',
  language: 'en',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showMessageBox: vi.fn(async (_options: Record<string, unknown>) => ({ response: 1 })),
  openExternal: vi.fn(async () => undefined),
  relaunch: vi.fn(),
  quit: vi.fn()
}))
const run = vi.hoisted(() => vi.fn(async (_command: string, args: string[]) => {
  // screencapture writes its file wherever it is told to.
  fs.writeFileSync(args[args.length - 1], 'png')

  return { code: 0, stdout: '', stderr: '' }
}))
const readImageMac = vi.hoisted(() => vi.fn(async (_file: string, _mode: string) => ['Order 4471']))
const copyConcealedMac = vi.hoisted(() => vi.fn(async (_text: string) => undefined))
const writeText = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: { relaunch: electron.relaunch, quit: electron.quit },
  clipboard: { writeText },
  ClipboardItem: class {},
  dialog: { showMessageBox: electron.showMessageBox },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => electron.handlers.set(channel, handler) },
  nativeImage: {},
  shell: { openExternal: electron.openExternal },
  systemPreferences: { getMediaAccessStatus: () => electron.status, askForMediaAccess: vi.fn() }
}))
vi.mock('../platform/exec.ts', () => ({ run }))
vi.mock('../platform/mac-tools.ts', () => ({ copyConcealedMac, pickColourMac: vi.fn(), readImageMac }))
vi.mock('../i18n.ts', () => ({ menuLanguage: () => electron.language }))
vi.mock('../attachments.ts', () => ({ allowAttachments: vi.fn() }))
vi.mock('../log.ts', () => ({ log: vi.fn() }))

const { IPC } = await import('../../shared/ipc.ts')
const { captureRegion, captureScreenshot, capturesDir, QR_NOT_COPIED, registerCaptureIpc, resetScreenRecordingCheck } = await import('./capture.ts')

const platform = process.platform
const blocked = /^Herald OS needs Screen Recording permission\. Turn on Herald OS in System Settings > Privacy & Security > Screen & System Audio Recording/
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const interactive = () => run.mock.calls.filter(([command, args]) => command === 'screencapture' && args.some(flag => flag.startsWith('-i') || flag === '-v'))
const probes = () => run.mock.calls.filter(([command, args]) => command === 'screencapture' && args.length === 4 && args[0] === '-x')

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  electron.status = 'denied'
  electron.language = 'en'
  run.mockClear()
  readImageMac.mockClear()
  copyConcealedMac.mockReset()
  writeText.mockClear()
  electron.showMessageBox.mockClear()
  electron.openExternal.mockClear()
  electron.relaunch.mockClear()
  electron.quit.mockClear()
  resetScreenRecordingCheck()
  registerCaptureIpc(() => undefined)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
})

describe('the Screen Recording check on macOS', () => {
  it('captures as before when the permission is granted', async () => {
    electron.status = 'granted'
    const file = await captureRegion()

    expect(file).toMatch(/region-.*\.png$/)
    expect(interactive()).toHaveLength(1)
    expect(electron.showMessageBox).not.toHaveBeenCalled()
    fs.rmSync(file!, { force: true })
  })

  it('without it, lets macOS ask once, discards that capture, explains, and never selects a region', async () => {
    await expect(captureRegion()).rejects.toThrow(blocked)

    expect(probes()).toHaveLength(1)
    const probe = probes()[0][1][3]
    expect(path.basename(path.dirname(probe))).toMatch(/^herald-os-permission-/)
    expect(path.dirname(probe)).not.toBe(capturesDir())
    expect(fs.existsSync(path.dirname(probe))).toBe(false)
    expect(interactive()).toHaveLength(0)
    expect(electron.showMessageBox).toHaveBeenCalledTimes(1)
    expect(electron.showMessageBox.mock.calls[0][0]).toMatchObject({ message: 'Herald OS needs Screen Recording permission', buttons: ['Open System Settings', 'Quit & Reopen', 'Not Now'], cancelId: 2 })
  })

  it('asks macOS only once a launch, and does not stack explanations', async () => {
    electron.showMessageBox.mockImplementationOnce(() => new Promise(() => undefined))
    await expect(captureRegion()).rejects.toThrow(blocked)
    await expect(captureScreenshot('screen')).rejects.toThrow(blocked)

    expect(probes()).toHaveLength(1)
    expect(electron.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('opens the Screen Recording pane when the person asks to', async () => {
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(captureScreenshot('window')).rejects.toThrow(blocked)
    await flush()

    expect(electron.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture')
  })

  it('Quit & Reopen relaunches Herald OS so a changed switch applies', async () => {
    electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(captureRegion()).rejects.toThrow(blocked)
    await flush()

    expect(electron.relaunch).toHaveBeenCalledTimes(1)
    expect(electron.quit).toHaveBeenCalledTimes(1)
    expect(electron.openExternal).not.toHaveBeenCalled()
  })

  it('Not Now opens and relaunches nothing', async () => {
    electron.showMessageBox.mockResolvedValueOnce({ response: 2 })
    await expect(captureRegion()).rejects.toThrow(blocked)
    await flush()

    expect(electron.openExternal).not.toHaveBeenCalled()
    expect(electron.relaunch).not.toHaveBeenCalled()
  })

  it('when a restriction (device management, Screen Time, parental controls) decides, says so, without asking macOS', async () => {
    electron.status = 'restricted'
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(captureRegion()).rejects.toThrow(
      'Screen Recording is restricted on this Mac. A restriction on this Mac, such as a device-management profile, Screen Time or parental controls, decides whether Herald OS may record the screen, so the switch in System Settings may be locked. Ask whoever set the restriction to allow Screen Recording for Herald OS.'
    )
    await flush()

    expect(probes()).toHaveLength(0)
    expect(interactive()).toHaveLength(0)
    expect(electron.showMessageBox.mock.calls[0][0]).toMatchObject({ message: 'Screen Recording is restricted on this Mac', buttons: ['OK'], cancelId: 0 })
    expect(electron.openExternal).not.toHaveBeenCalled()
    expect(electron.relaunch).not.toHaveBeenCalled()
  })

  it('says the same in Simplified Chinese', async () => {
    electron.language = 'zh-CN'
    electron.status = 'restricted'
    await expect(captureRegion()).rejects.toThrow(/^这台 Mac 限制了“屏幕录制”\. .*设备管理描述文件、“屏幕使用时间”或家长控制/)
    expect(electron.showMessageBox.mock.calls[0][0]).toMatchObject({ message: '这台 Mac 限制了“屏幕录制”', buttons: ['好'] })

    resetScreenRecordingCheck()
    electron.status = 'denied'
    await expect(captureRegion()).rejects.toThrow(/^Herald OS 需要“屏幕录制”权限/)
    expect(electron.showMessageBox.mock.calls[1][0]).toMatchObject({ buttons: ['打开系统设置', '退出并重新打开', '以后再说'] })
  })

  it('a probe that fails or times out still ends in the permission message', async () => {
    run.mockRejectedValueOnce(new Error('spawn screencapture ENOENT'))
    await expect(captureRegion()).rejects.toThrow(blocked)
    expect(probes()).toHaveLength(1)
    expect(fs.existsSync(path.dirname(probes()[0][1][3]))).toBe(false)
  })

  it('a folder that cannot be made does not hide the permission message', async () => {
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied, mkdir'), { code: 'EACCES' })
    })
    const mkdtemp = vi.spyOn(fs, 'mkdtempSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device, mkdtemp'), { code: 'ENOSPC' })
    })

    try {
      await expect(captureRegion()).rejects.toThrow(blocked)
      await expect(captureScreenshot('screen')).rejects.toThrow(blocked)
      await expect(electron.handlers.get(IPC.captureRecord)!({}, 'start')).rejects.toThrow(blocked)
      await expect(electron.handlers.get(IPC.captureTool)!({}, 'text')).rejects.toThrow(blocked)
      expect(run).not.toHaveBeenCalled()
    } finally {
      mkdir.mockRestore()
      mkdtemp.mockRestore()
    }
  })

  it('stops the text and QR readers before anything is read or copied', async () => {
    const tool = electron.handlers.get(IPC.captureTool)!

    await expect(tool({}, 'text')).rejects.toThrow(blocked)
    await expect(tool({}, 'qr')).rejects.toThrow(blocked)
    expect(readImageMac).not.toHaveBeenCalled()
    expect(interactive()).toHaveLength(0)
  })

  it('does not start a recording', async () => {
    const record = electron.handlers.get(IPC.captureRecord)!

    await expect(record({}, 'start')).rejects.toThrow(blocked)
    expect(interactive()).toHaveLength(0)
    expect(await electron.handlers.get(IPC.captureRecordState)!({})).toEqual({ recording: false })
  })

  it('hands nothing over to be attached to a question', async () => {
    await expect(electron.handlers.get(IPC.captureRegion)!({})).rejects.toThrow(blocked)
    await expect(electron.handlers.get(IPC.captureScreenshot)!({}, 'region')).rejects.toThrow(blocked)
    expect(interactive()).toHaveLength(0)
  })
})

describe('the QR and text readers on macOS', () => {
  const OTP = 'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub'

  beforeEach(() => {
    electron.status = 'granted'
  })

  it('copies a QR code marked as concealed, and hands the renderer only a description', async () => {
    readImageMac.mockResolvedValueOnce([OTP])
    const result = await electron.handlers.get(IPC.captureTool)!({}, 'qr')

    expect(result).toEqual({ codes: 1, qr: { kind: 'otp', caption: '2FA setup code copied', description: 'a 2FA setup code for GitHub' } })
    expect(JSON.stringify(result)).not.toContain('JBSWY3DPEHPK3PXP')
    expect(readImageMac.mock.calls[0][1]).toBe('codes')
    expect(copyConcealedMac).toHaveBeenCalledWith(OTP)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('copies nothing when the selection has several codes', async () => {
    readImageMac.mockResolvedValueOnce(['https://example.com', 'WIFI:S:Home;T:WPA;P:hunter22;;'])
    const result = await electron.handlers.get(IPC.captureTool)!({}, 'qr')

    expect(result).toEqual({ codes: 2 })
    expect(copyConcealedMac).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('counts the same code read twice once', async () => {
    readImageMac.mockResolvedValueOnce(['https://example.com/menu', 'https://example.com/menu'])

    expect(await electron.handlers.get(IPC.captureTool)!({}, 'qr')).toMatchObject({ codes: 1, qr: { kind: 'link', text: 'https://example.com/menu' } })
    expect(copyConcealedMac).toHaveBeenCalledWith('https://example.com/menu')
  })

  it('reports no code without copying anything', async () => {
    readImageMac.mockResolvedValueOnce([])

    expect(await electron.handlers.get(IPC.captureTool)!({}, 'qr')).toEqual({ codes: 0 })
    expect(copyConcealedMac).not.toHaveBeenCalled()
  })

  it.each([OTP, 'WIFI:S:Home;T:WPA;P:hunter22;;', 'https://example.com/reset?token=0000aaaa1111bbbb', 'ab12cd34ef56'])('refuses a secret it cannot copy concealed, rather than copy it plainly: %s', async code => {
    readImageMac.mockResolvedValueOnce([code])
    copyConcealedMac.mockRejectedValueOnce(new Error('osascript failed'))

    const error = await Promise.resolve(electron.handlers.get(IPC.captureTool)!({}, 'qr')).then(
      () => null,
      (failure: Error) => failure
    )

    expect(error?.message).toBe(QR_NOT_COPIED)
    expect(error?.message).not.toContain(code)
    expect(writeText).not.toHaveBeenCalled()
  })

  it.each(['https://example.com/menu', 'Table 4'])('still copies a link or text plainly when the concealed copy fails, so pasting works: %s', async code => {
    readImageMac.mockResolvedValueOnce([code])
    copyConcealedMac.mockRejectedValueOnce(new Error('osascript failed'))

    expect(await electron.handlers.get(IPC.captureTool)!({}, 'qr')).toMatchObject({ codes: 1, qr: { text: code } })
    expect(writeText).toHaveBeenCalledWith(code)
  })

  it('copies text read off the screen as before', async () => {
    readImageMac.mockResolvedValueOnce(['Order 4471'])

    expect(await electron.handlers.get(IPC.captureTool)!({}, 'text')).toEqual({ text: 'Order 4471', lines: 1 })
    expect(writeText).toHaveBeenCalledWith('Order 4471')
    expect(copyConcealedMac).not.toHaveBeenCalled()
  })
})
