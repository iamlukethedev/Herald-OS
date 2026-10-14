import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  trusted: false,
  language: 'en',
  clipboard: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  isTrustedAccessibilityClient: vi.fn((_prompt: boolean) => false),
  showMessageBox: vi.fn(async (_options: Record<string, unknown>) => ({ response: 1 })),
  openExternal: vi.fn(async (_url: string) => undefined)
}))
const run = vi.hoisted(() => vi.fn(async (_command: string, _args: string[], _timeoutMs?: number) => ({ code: 0, stdout: '', stderr: '' })))

vi.mock('electron', () => ({
  clipboard: {
    readText: async () => electron.clipboard,
    writeText: async (text: string) => {
      electron.clipboard = text
    }
  },
  dialog: { showMessageBox: electron.showMessageBox },
  globalShortcut: { register: () => true },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => electron.handlers.set(channel, handler) },
  shell: { openExternal: electron.openExternal },
  systemPreferences: { isTrustedAccessibilityClient: electron.isTrustedAccessibilityClient }
}))
vi.mock('../platform/exec.ts', () => ({ run }))
vi.mock('../i18n.ts', () => ({ menuLanguage: () => electron.language }))
vi.mock('../log.ts', () => ({ log: vi.fn() }))

const { IPC } = await import('../../shared/ipc.ts')
const { missingPermission, registerDictationIpc, resetTypingPermissionCheck } = await import('./dictation.ts')

const platform = process.platform
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const type = (text: string, options: { submit?: boolean } = {}) => electron.handlers.get(IPC.dictationType)!({}, text, options)
const pastes = () => run.mock.calls.filter(([command, args]) => command === 'osascript' && args.some(arg => arg.includes('keystroke "v"')))
const probes = () => run.mock.calls.filter(([command, args]) => command === 'osascript' && args.includes('tell application "System Events" to get name'))
const dialogs = () => electron.showMessageBox.mock.calls.map(([options]) => options)

const AUTOMATION_REFUSED = '33:71: execution error: Not authorized to send Apple events to System Events. (-1743)\n'
const NO_KEYSTROKES = '35:66: execution error: System Events got an error: osascript is not allowed to send keystrokes. (1002)\n'

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  electron.language = 'en'
  electron.clipboard = 'before'
  electron.isTrustedAccessibilityClient.mockReset()
  electron.isTrustedAccessibilityClient.mockImplementation(() => electron.trusted)
  electron.trusted = false
  electron.showMessageBox.mockReset()
  electron.showMessageBox.mockResolvedValue({ response: 1 })
  electron.openExternal.mockClear()
  run.mockReset()
  run.mockResolvedValue({ code: 0, stdout: '', stderr: '' })
  resetTypingPermissionCheck()
  registerDictationIpc(() => null)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
})

describe('reading why a paste failed', () => {
  it('names Automation for a refused Apple event', () => {
    expect(missingPermission(AUTOMATION_REFUSED)).toBe('automation')
  })

  it('names Accessibility when System Events may not press keys', () => {
    expect(missingPermission(NO_KEYSTROKES)).toBe('accessibility')
    expect(missingPermission('execution error: osascript is not allowed assistive access. (-1719)')).toBe('accessibility')
  })

  // Each string carries exactly one of the patterns, so every pattern is needed on its own.
  it.each([
    ['the -1743 code alone', 'execution error: (-1743)', 'automation'],
    ['the refused Apple events text alone', 'execution error: Not authorized to send Apple events to System Events.', 'automation'],
    ['the British spelling of that text', 'execution error: Not authorised to send Apple events to System Events.', 'automation'],
    ['the 1002 code alone', 'execution error: System Events got an error. (1002)', 'accessibility'],
    ['-1719 with the assistive access text', 'execution error: osascript is not allowed assistive access. (-1719)', 'accessibility'],
    ['the keystrokes text alone', 'execution error: System Events got an error: osascript is not allowed to send keystrokes.', 'accessibility']
  ])('reads %s', (_name, stderr, permission) => {
    expect(missingPermission(stderr)).toBe(permission)
  })

  it.each([
    ['-1744 (consent would be needed, not refused)', 'execution error: (-1744)'],
    ['1743 without its minus sign', 'execution error: (1743)'],
    ['a longer code that starts with -1743', 'execution error: (-17430)'],
    ['a longer code that starts with 1002', 'execution error: (10020)']
  ])('does not read %s as a permission', (_name, stderr) => {
    expect(missingPermission(stderr)).toBeNull()
  })

  it('takes -1719 for Accessibility only when it says assistive access', () => {
    expect(missingPermission('execution error: System Events got an error: Invalid index. (-1719)')).toBeNull()
    expect(missingPermission('execution error: osascript is not allowed assistive access.')).toBeNull()
  })

  it('names nothing for a timeout or another error', () => {
    expect(missingPermission('')).toBeNull()
    expect(missingPermission('execution error: Can’t get application "System Events". (-1728)')).toBeNull()
  })
})

describe('typing into another app on macOS', () => {
  it('pastes as before once both permissions are allowed, without explaining anything', async () => {
    electron.trusted = true

    expect(await type('hello')).toEqual({ typed: true, copied: false })
    expect(pastes()).toHaveLength(1)
    expect(electron.isTrustedAccessibilityClient).toHaveBeenCalledWith(false)
    expect(electron.isTrustedAccessibilityClient).not.toHaveBeenCalledWith(true)
    expect(electron.showMessageBox).not.toHaveBeenCalled()
  })

  it('gives the first paste of a launch time to read macOS’s prompt, and later ones the usual 10 seconds', async () => {
    electron.trusted = true
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' })

    await type('a')
    await type('b')
    await type('c')

    expect(pastes().map(([, , timeout]) => timeout)).toEqual([60_000, 60_000, 10_000])
  })

  it('without Accessibility, explains before macOS asks, leaves the text copied and presses nothing', async () => {
    expect(await type('😀')).toEqual({ typed: false, copied: true, missing: 'accessibility' })
    expect(electron.clipboard).toBe('😀')
    expect(pastes()).toHaveLength(0)
    expect(electron.isTrustedAccessibilityClient).not.toHaveBeenCalledWith(true)
    expect(dialogs()).toEqual([
      expect.objectContaining({ message: 'Allow Herald OS to type into other apps', buttons: ['Continue', 'Not Now'], defaultId: 0, cancelId: 1 })
    ])
    expect(String(dialogs()[0].detail)).toMatch(/System Events \(Automation\), and for Accessibility\. Until both are allowed, what you pick or dictate stays on the clipboard/)
  })

  it('Continue brings up macOS’s Automation prompt, then its Accessibility prompt', async () => {
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const order: string[] = []
    run.mockImplementation(async () => {
      order.push('automation')

      return { code: 0, stdout: 'System Events\n', stderr: '' }
    })
    electron.isTrustedAccessibilityClient.mockImplementation(prompt => {
      if (prompt) {
        order.push('accessibility')
      }

      return false
    })

    await type('hello')
    await flush()
    await flush()

    expect(probes()).toHaveLength(1)
    expect(probes()[0][2]).toBe(120_000)
    expect(order).toEqual(['automation', 'accessibility'])
    expect(electron.openExternal).not.toHaveBeenCalled()
  })

  it('Not Now brings up no prompt', async () => {
    await type('hello')
    await flush()

    expect(probes()).toHaveLength(0)
    expect(electron.isTrustedAccessibilityClient).not.toHaveBeenCalledWith(true)
  })

  it('explains once a launch, and every attempt still says what is missing', async () => {
    expect(await type('one')).toMatchObject({ missing: 'accessibility' })
    await flush()
    expect(await type('two')).toMatchObject({ missing: 'accessibility' })

    expect(electron.showMessageBox).toHaveBeenCalledTimes(1)

    resetTypingPermissionCheck()
    await type('three')
    expect(electron.showMessageBox).toHaveBeenCalledTimes(2)
  })

  it('a refused Automation prompt names Automation and offers its pane', async () => {
    electron.trusted = true
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 })
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: AUTOMATION_REFUSED })

    expect(await type('hello')).toEqual({ typed: false, copied: true, missing: 'automation' })
    await flush()

    expect(electron.clipboard).toBe('hello')
    expect(dialogs()[0]).toMatchObject({ message: 'Herald OS needs Automation permission', buttons: ['Open System Settings', 'Not Now'], cancelId: 1 })
    expect(String(dialogs()[0].detail)).toMatch(/Privacy & Security > Automation, turn on System Events under Herald OS/)
    expect(electron.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Automation')
  })

  it('keystrokes refused by Accessibility name Accessibility and offer its pane', async () => {
    electron.trusted = true
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 })
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: NO_KEYSTROKES })

    expect(await type('hello')).toEqual({ typed: false, copied: true, missing: 'accessibility' })
    await flush()

    expect(dialogs()[0]).toMatchObject({ message: 'Herald OS needs Accessibility permission' })
    expect(electron.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility')
  })

  it('a timeout or another failure leaves the text copied without blaming a permission', async () => {
    electron.trusted = true
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' })

    expect(await type('hello')).toEqual({ typed: false, copied: true })
    expect(electron.clipboard).toBe('hello')
    expect(electron.showMessageBox).not.toHaveBeenCalled()
  })

  it('does not stack a second explanation on one still open', async () => {
    electron.showMessageBox.mockImplementationOnce(() => new Promise(() => undefined))
    await type('one')
    electron.trusted = true
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: AUTOMATION_REFUSED })

    expect(await type('two')).toMatchObject({ missing: 'automation' })
    expect(electron.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('says the same in Simplified Chinese', async () => {
    electron.language = 'zh-CN'
    await type('hello')

    expect(dialogs()[0]).toMatchObject({ message: '允许 Herald OS 在其他应用中输入', buttons: ['继续', '以后再说'] })
  })
})
