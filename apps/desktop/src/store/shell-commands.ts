import type { CrashReport, ShellCommand } from '../../shared/ipc.ts'
import { HERMES_APPS, type HermesAppId, PAGES, type PageId } from '../shell/apps.ts'
import { composePrompt } from '../shell/surfaces/shell-utils.ts'
import { runHeraldOsWithToast } from '../lib/herald-os-cli.ts'
import { updatePrefs } from './backend.ts'
import { openStoredSession, runSlash, sendPrompt } from './chat.ts'
import { offerCrashHelp } from './crashes.ts'
import { openEmojiPicker } from './emoji.ts'
import { $notificationsOpen, notify } from './notifications.ts'
import { runCommand } from './os-commands.ts'
import { isMainSurface, isPanels, onShellCommand, openSurface } from './shell.ts'
import { openStatusPanel } from './status-panel.ts'
import { $screensaverUp } from './switches.ts'
import { $applicationsOpen, openAsk, toggleCommandBar } from './surface.ts'
import { openWebWindow } from './web-windows.ts'
import { openApp, showPage } from './windows.ts'

/*
 * `ShellCommand`s addressed to the Hermes window: from the `herald-os` CLI (compositor hotkeys), the
 * command overlay (panels mode) and the Electron control server. One handler serves the macOS
 * desktop window and the panels-mode main surface alike, so every hotkey the Linux session has works
 * on the Mac too. Voice commands are handled by store/voice.ts on the same bus.
 */

const isPageId = (value: string | undefined): value is PageId => PAGES.some(page => page.id === value)

/** Style > Wallpaper: the Hermes window owns the file dialog because the overlay closes when it loses focus. */
async function pickWallpaper(): Promise<void> {
  try {
    const [wallpaper] = await window.heraldOS.fs.pickFiles({ multiple: false })

    if (!wallpaper) {
      return
    }

    await updatePrefs({ wallpaper })
    notify({ title: 'Wallpaper updated', body: wallpaper.split('/').pop() || wallpaper, level: 'success' })
  } catch (error) {
    notify({ title: 'Could not set wallpaper', body: error instanceof Error ? error.message : String(error), level: 'error' })
  }
}

/** The ask panel again, with the question and files it sent: it closed on Send, before they could fail to reach Hermes. */
function askAgain(command: ShellCommand): void {
  const draft = { text: command.text ?? '', attachments: command.attachments ?? [] }

  if (isPanels) {
    openSurface('command', { type: 'ask', ...draft, context: command.context })
  } else {
    openAsk(draft)
  }
}

export function handleShellCommand(command: ShellCommand): void {
  switch (command.type) {
    case 'show-page': {
      const id = command.args?.[0]

      if (isPageId(id)) {
        showPage(id)
      }

      return
    }
    case 'send-prompt': {
      const text = composePrompt(command.text ?? '', command.context)
      const attachments = command.attachments ?? []

      if (!text && attachments.length === 0) {
        return
      }

      showPage('hermes')
      openSurface('main')

      // A bare slash command from the palette runs as one; anything with context or files is a prompt.
      if (text.startsWith('/') && !command.context && attachments.length === 0) {
        void runSlash(text)
      } else {
        void sendPrompt(text, { attachments }).catch((error: unknown) => {
          notify({ title: 'Not sent to Hermes', body: error instanceof Error ? error.message : String(error), level: 'error' })

          if (attachments.length > 0) {
            askAgain(command)
          }
        })
      }

      return
    }
    case 'open-session': {
      const id = command.args?.[0]

      if (id) {
        showPage('hermes')
        void openStoredSession(id)
      }

      return
    }
    case 'notify': {
      const [title, ...rest] = command.args ?? []

      if (title) {
        notify({ title, body: rest.join(' ') || command.text || undefined })
      }

      return
    }
    case 'notifications':
      $notificationsOpen.set(!$notificationsOpen.get())

      return
    case 'command':
    // One window (app mode inside Hyprland or Omarchy): the panels-only overlays fall back to the command bar.
    case 'menu':
    case 'power':
    case 'clipboard':
      toggleCommandBar(true)

      return
    case 'applications':
      $applicationsOpen.set(true)

      return
    case 'ask': {
      const context = command.context ? `About ${command.context.appId || 'the window'} "${command.context.title}": ` : ''
      openAsk({ text: `${context}${command.text ?? ''}`, attachments: command.attachments })

      return
    }
    case 'emoji':
      openEmojiPicker()

      return
    case 'panel': {
      const panel = command.args?.[0]

      if (panel === 'wifi' || panel === 'bluetooth' || panel === 'audio' || panel === 'display' || panel === 'power' || panel === 'clock') {
        openStatusPanel(panel)
      }

      return
    }
    case 'open-app': {
      const app = command.args?.[0]

      if (app && HERMES_APPS.some(item => item.id === app)) {
        openApp(app as HermesAppId)
      }

      return
    }
    case 'webapp': {
      const [url, name] = command.args ?? []

      if (url && /^https?:\/\//.test(url)) {
        void openWebWindow(url, { title: name || undefined })
      }

      return
    }
    case 'herald-os': {
      // The overlay hands off commands that must run after it closed (screenshot, OCR, hotkey overlay).
      const args = command.args ?? []

      if (args.length > 0) {
        void runHeraldOsWithToast(args, command.text || args.join(' '))
      }

      return
    }
    case 'pick-wallpaper':
      void pickWallpaper()

      return
    case 'screensaver':
      // Desktop mode: main noticed the idle time (panels mode opens its own window instead).
      $screensaverUp.set(true)

      return
    case 'crash': {
      // Main's crash watcher found a crash worth offering help with.
      const report = command.payload as unknown as CrashReport | undefined

      if (report?.id && report.app) {
        offerCrashHelp(report)
      }

      return
    }
    case 'os': {
      // `herald-os os <command.id> [json args]`: run a registry command from the CLI.
      const id = command.args?.[0]

      if (id) {
        void runCommand(id, (command.payload as Record<string, unknown> | undefined) ?? {}, { source: 'cli' })
      }

      return
    }
    default:
      return
  }
}

let bound = false

/** Subscribe the Hermes window to the command bus once (desktop and panels main surface). */
export function bindShellCommands(): () => void {
  if (bound || !isMainSurface) {
    return () => undefined
  }

  bound = true
  const off = onShellCommand(handleShellCommand)

  return () => {
    off()
    bound = false
  }
}
