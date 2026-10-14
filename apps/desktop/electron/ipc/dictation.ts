import { type BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, shell, systemPreferences } from 'electron'
import { translate } from '../../shared/i18n.ts'
import { IPC, type ShellCommand, type TypeResult, type TypingPermission } from '../../shared/ipc.ts'
import { menuLanguage } from '../i18n.ts'
import { log } from '../log.ts'
import { run } from '../platform/exec.ts'

/** macOS: Cmd+Ctrl+X starts and ends dictation from any app (Linux binds Mod+Ctrl+X in niri). */
const MAC_DICTATION_KEY = 'Command+Control+X'
/** The pasted text must land before the clipboard gets its old contents back. */
const RESTORE_CLIPBOARD_MS = 700
/** Until a paste has worked this launch, macOS may be showing its Automation prompt, which takes reading. */
const FIRST_PASTE_TIMEOUT_MS = 60_000
const PASTE_TIMEOUT_MS = 10_000
/** The harmless Apple event that makes macOS ask for Automation; the prompt waits for the person. */
const AUTOMATION_PROBE_TIMEOUT_MS = 120_000

const PANES: Record<TypingPermission, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility',
  automation: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Automation'
}

let pastedThisLaunch = false
let explaining = false
const explainedThisLaunch = new Set<'setup' | TypingPermission>()

/** Tests start each case as a fresh launch. */
export function resetTypingPermissionCheck(): void {
  pastedThisLaunch = false
  explaining = false
  explainedThisLaunch.clear()
}

/**
 * Which permission a failed `osascript` paste lacked: -1743 is an Apple event macOS refused
 * (Automation, for System Events); 1002 "not allowed to send keystrokes" and -1719 "not allowed
 * assistive access" mean Accessibility. Anything else (a timeout, another error) is not known.
 */
export function missingPermission(stderr: string): TypingPermission | null {
  if (/-1743\b|not authori[sz]ed to send apple events/i.test(stderr)) {
    return 'automation'
  }

  if (/\(1002\)|\(-1719\)|not allowed to send keystrokes|assistive access/i.test(stderr)) {
    return 'accessibility'
  }

  return null
}

/** Line by line with Return between: wtype stops reading options after "--", so keys need their own call. */
async function typeLinux(text: string, submit: boolean): Promise<TypeResult> {
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      await run('wtype', ['-k', 'Return'], 5000)
    }

    if (lines[i]) {
      const result = await run('wtype', ['--', lines[i]], 20_000)

      if (result.code !== 0) {
        await clipboard.writeText(text)
        log('dictation', `wtype failed (${result.code === 127 ? 'not installed' : result.stderr.trim()}); left the text on the clipboard`)

        return { typed: false, copied: true }
      }
    }
  }

  if (submit) {
    await run('wtype', ['-k', 'Return'], 5000)
  }

  return { typed: true, copied: false }
}

/** One explanation on screen at a time, each kind at most once a launch; never awaited, so the text is already on the clipboard. */
function explain(kind: 'setup' | TypingPermission): void {
  if (explaining || explainedThisLaunch.has(kind)) {
    return
  }

  explaining = true
  explainedThisLaunch.add(kind)
  const language = menuLanguage()
  const title = translate(language, kind === 'setup' ? 'permission.typing.title' : kind === 'automation' ? 'permission.typing.automationTitle' : 'permission.typing.accessibilityTitle')
  const detail = translate(language, kind === 'setup' ? 'permission.typing.detail' : kind === 'automation' ? 'permission.typing.automationDetail' : 'permission.typing.accessibilityDetail')
  const buttons = [translate(language, kind === 'setup' ? 'permission.typing.continue' : 'permission.typing.open'), translate(language, 'permission.typing.notNow')]

  void dialog
    .showMessageBox({ type: kind === 'setup' ? 'info' : 'warning', message: title, detail, buttons, defaultId: 0, cancelId: 1 })
    .then(async ({ response }) => {
      if (response !== 0) {
        return
      }

      if (kind === 'setup') {
        await askForTypingPermissions()

        return
      }

      await shell.openExternal(PANES[kind])
    })
    .catch(error => log('dictation', `typing permission explanation: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => {
      explaining = false
    })
}

/** macOS's two prompts, one after the other: Automation (no Electron API asks for it), then Accessibility. */
async function askForTypingPermissions(): Promise<void> {
  const probe = await run('osascript', ['-e', 'tell application "System Events" to get name'], AUTOMATION_PROBE_TIMEOUT_MS)

  if (probe.code !== 0) {
    log('dictation', `automation probe: ${probe.stderr.trim() || `exit ${probe.code}`}`)
  }

  systemPreferences.isTrustedAccessibilityClient(true)
}

async function typeMac(text: string, submit: boolean): Promise<TypeResult> {
  const previous = await clipboard.readText().catch(() => '')
  await clipboard.writeText(text)

  // Without Accessibility System Events cannot press keys, so explain before macOS asks rather than fail first.
  if (!systemPreferences.isTrustedAccessibilityClient(false)) {
    log('dictation', 'Accessibility is not allowed yet; left the text on the clipboard')
    explain('setup')

    return { typed: false, copied: true, missing: 'accessibility' }
  }

  const keys = ['-e', 'tell application "System Events" to keystroke "v" using command down', ...(submit ? ['-e', 'tell application "System Events" to key code 36'] : [])]
  const result = await run('osascript', keys, pastedThisLaunch ? PASTE_TIMEOUT_MS : FIRST_PASTE_TIMEOUT_MS)

  if (result.code !== 0) {
    const missing = missingPermission(result.stderr)
    log('dictation', `paste failed: ${result.stderr.trim() || `exit ${result.code}`}`)

    if (missing) {
      explain(missing)

      return { typed: false, copied: true, missing }
    }

    return { typed: false, copied: true }
  }

  pastedThisLaunch = true
  setTimeout(() => void clipboard.writeText(previous).catch(() => undefined), RESTORE_CLIPBOARD_MS)

  return { typed: true, copied: false }
}

export function registerDictationIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.dictationType, async (_event, text: string, options: { submit?: boolean; delayMs?: number } = {}) => {
    const clean = String(text ?? '')

    if (!clean && !options.submit) {
      return { typed: false, copied: false } satisfies TypeResult
    }

    // Give an overlay that just closed time to hand focus back to the app being typed into.
    if (options.delayMs) {
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, options.delayMs ?? 0)))
    }

    if (process.platform === 'linux') {
      return typeLinux(clean, Boolean(options.submit))
    }

    if (process.platform === 'darwin') {
      return typeMac(clean, Boolean(options.submit))
    }

    await clipboard.writeText(clean)

    return { typed: false, copied: true } satisfies TypeResult
  })

  if (process.platform === 'darwin') {
    const registered = globalShortcut.register(MAC_DICTATION_KEY, () => getMainWindow()?.webContents.send(IPC.shellCommand, { type: 'dictate' } satisfies ShellCommand))

    if (!registered) {
      log('dictation', `${MAC_DICTATION_KEY} is taken by another app; dictation stays in the command bar`)
    }
  }
}
