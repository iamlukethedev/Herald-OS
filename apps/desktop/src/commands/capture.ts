import type { CaptureTool, ScreenshotMode } from '../../shared/ipc.ts'
import { describeQr, parseQrReading, type QrReading } from '../../shared/qr.ts'
import { CLI_UNAVAILABLE_MESSAGE, runHeraldOs } from '../lib/herald-os-cli.ts'
import { $env } from '../store/backend.ts'
import { $recording, askAbout, offerCapture } from '../store/capture.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { isPanels } from '../store/shell.ts'
import { $windows, closeWindow, openApp } from '../store/windows.ts'

/* The capture suite: screenshots, recording, the colour picker, QR codes, text, markup, the camera. */

/** A Herald OS Linux tool run through the CLI (it draws its own selection where it needs one). */
async function linuxTool(argv: string[], title: string) {
  const outcome = await runHeraldOs(argv)

  if (outcome.unavailable) {
    return fail(`${title}: ${CLI_UNAVAILABLE_MESSAGE.toLowerCase()}.`)
  }

  return outcome.ok ? ok(outcome.output || title, { data: { output: outcome.output } }) : fail(outcome.output || `${title} did not work`)
}

const isMac = () => $env.get()?.platform === 'darwin'

/** The colour picker, a QR code or text from the screen: macOS's own tools, through main. */
async function screenTool(tool: CaptureTool, linuxArgv: string[], title: string) {
  if (!isMac()) {
    return linuxTool(linuxArgv, title)
  }

  const result = await window.heraldOS.capture.tool(tool)

  if (result.cancelled) {
    return fail(`${title}: cancelled.`)
  }

  if (!result.text) {
    return fail(tool === 'qr' ? 'No QR code or barcode in that part of the screen.' : 'No text in that part of the screen.')
  }

  if (tool === 'qr') {
    return qrResult(describeQr(result.text))
  }

  const summary = tool === 'colour' ? `Copied ${result.text}` : `Copied ${result.lines === 1 ? 'a line' : `${result.lines} lines`} of text`

  return ok(summary, { data: { text: result.text } })
}

/**
 * What a QR code says stays on the clipboard: the caption (and the voice) say what kind of thing it
 * is, and Hermes gets the contents only when they are an ordinary link or text.
 */
function qrResult(reading: QrReading) {
  const { kind, caption, description, text } = reading

  return ok(caption, {
    data: text === undefined ? { kind, description, onClipboard: true, note: 'The contents are on the clipboard for the person to paste and are kept out of this conversation; do not ask for them.' } : { kind, description, text }
  })
}

async function readQr() {
  if (isMac()) {
    return screenTool('qr', [], 'QR code')
  }

  const outcome = await runHeraldOs(['capture', 'qr', '--json'])

  if (outcome.unavailable) {
    return fail(`QR code: ${CLI_UNAVAILABLE_MESSAGE.toLowerCase()}.`)
  }

  if (!outcome.ok) {
    return fail(outcome.output || 'QR code did not work')
  }

  // An older CLI prints the contents themselves; say only that something was copied.
  return qrResult(parseQrReading(outcome.output) ?? { kind: 'secret', caption: 'QR code copied', description: 'a QR code' })
}

export const captureCommands: readonly OsCommand[] = [
  {
    id: 'capture.screenshot',
    title: 'Take a screenshot',
    description: 'Screenshot a region you select, the focused window or the whole screen; then offer to mark it up, copy it, ask Hermes about it or show it.',
    tier: 'act',
    args: [
      { name: 'mode', type: 'string', description: 'region, window or screen', enum: ['region', 'window', 'screen'] },
      { name: 'edit', type: 'boolean', description: 'Open it in Markup straight away' }
    ],
    phrases: ['take a screenshot', { phrase: 'screenshot the whole screen', args: { mode: 'screen' } }, { phrase: 'screenshot this window', args: { mode: 'window' } }],
    run: async ({ mode, edit }, context) => {
      const file = await window.heraldOS.capture.screenshot(mode as ScreenshotMode)

      if (!file) {
        return fail('No screenshot: the selection was cancelled.')
      }

      if (edit) {
        openApp('capture-editor', { payload: { file } })
      } else if (context.source !== 'agent') {
        offerCapture(file)
      }

      return ok(`Saved ${file.split('/').pop()}`, { data: { file } })
    }
  },
  {
    id: 'capture.record',
    title: 'Record the screen',
    description: 'Start or stop a screen recording (the whole screen, or a region you select), optionally with the microphone. The menu bar shows a red dot while it records.',
    tier: 'act',
    args: [
      { name: 'action', type: 'string', description: 'toggle, start or stop', enum: ['toggle', 'start', 'stop'] },
      { name: 'region', type: 'boolean', description: 'Select a region to record (Herald OS Linux)' },
      { name: 'audio', type: 'boolean', description: 'Record the microphone too' }
    ],
    phrases: [{ phrase: 'start recording the screen', args: { action: 'start' } }, { phrase: 'stop recording', args: { action: 'stop' } }, { phrase: 'record my screen', args: { action: 'start' } }],
    run: async ({ action, region, audio }) => {
      const state = await window.heraldOS.capture.record((action as 'toggle' | 'start' | 'stop') ?? 'toggle', { region: Boolean(region), audio: Boolean(audio) })

      return ok(state.recording ? 'Recording the screen; run it again (or click the red dot) to stop' : state.file ? `Saved ${state.file.split('/').pop()}` : 'Not recording', { data: { ...state } })
    }
  },
  {
    id: 'capture.edit',
    title: 'Mark up a screenshot',
    description: 'Open a picture in Markup: arrows, boxes, highlights, text, and hiding private details.',
    tier: 'act',
    args: [{ name: 'file', type: 'string', description: 'The picture', required: true }],
    hidden: true,
    run: ({ file }) => {
      openApp('capture-editor', { payload: { file: String(file) } })

      return ok('Opened Markup')
    }
  },
  {
    id: 'capture.copy',
    title: 'Copy a picture',
    description: 'Put a picture on the clipboard.',
    tier: 'act',
    args: [{ name: 'file', type: 'string', description: 'The picture', required: true }],
    hidden: true,
    run: async ({ file }) => {
      await window.heraldOS.capture.copyImage(String(file))

      return ok('Copied to the clipboard')
    }
  },
  {
    id: 'capture.ask',
    title: 'Ask Hermes about a picture',
    description: 'Open "Ask Hermes" with a picture attached.',
    tier: 'act',
    args: [
      { name: 'file', type: 'string', description: 'The picture', required: true },
      { name: 'question', type: 'string', description: 'The question, if already known' }
    ],
    hidden: true,
    run: ({ file, question }) => {
      askAbout(String(file), question ? String(question) : '')

      return ok('Ask your question')
    }
  },
  {
    id: 'capture.color',
    title: 'Pick a colour from the screen',
    description: 'Click anywhere on screen to copy that colour (#rrggbb) to the clipboard.',
    tier: 'act',
    args: [],
    phrases: ['pick a colour', 'pick a color from the screen', 'what colour is this'],
    run: () => screenTool('colour', ['capture', 'color'], 'Colour picker')
  },
  {
    id: 'capture.qr',
    title: 'Read a QR code',
    description: 'Select a QR code or barcode on screen and copy what it says. You get the contents of ordinary links and text; for a 2FA setup code, Wi-Fi details or anything that looks like a password you only get what kind of thing it is, and the contents stay on the clipboard.',
    tier: 'act',
    args: [],
    phrases: ['read this qr code', 'scan the qr code'],
    run: () => readQr()
  },
  {
    id: 'capture.text',
    title: 'Copy text from the screen',
    description: 'Select part of the screen and copy the text in it (OCR).',
    tier: 'act',
    args: [],
    phrases: ['copy the text on screen', 'read the text on screen'],
    run: () => screenTool('text', ['capture', 'text'], 'Text from the screen')
  },
  {
    id: 'capture.transcode',
    title: 'Convert a recording',
    description: 'Turn a recording into a GIF, a smaller MP4 or a WebM (Herald OS Linux, with ffmpeg).',
    tier: 'act',
    args: [
      { name: 'file', type: 'string', description: 'The recording', required: true },
      { name: 'format', type: 'string', description: 'gif, mp4 or webm', enum: ['gif', 'mp4', 'webm'] }
    ],
    run: ({ file, format }) => linuxTool(['capture', 'transcode', String(file), String(format ?? 'gif')], 'Convert')
  },
  {
    id: 'capture.share',
    title: 'Share a file',
    description: 'Copy a file to the clipboard and open LocalSend when it is installed (Herald OS Linux).',
    tier: 'act',
    args: [{ name: 'file', type: 'string', description: 'The file', required: true }],
    run: ({ file }) => linuxTool(['capture', 'share', String(file)], 'Share')
  },
  {
    id: 'camera.show',
    title: 'Camera bubble',
    description: 'Show (or hide) your camera in a round bubble, for screen recordings.',
    tier: 'act',
    args: [{ name: 'enabled', type: 'boolean', description: 'false to hide it' }],
    phrases: [{ phrase: 'show my camera', args: { enabled: true } }, { phrase: 'hide my camera', args: { enabled: false } }],
    run: async ({ enabled }) => {
      if (enabled === false) {
        if (isPanels) {
          await window.heraldOS.shell.close('window:camera')
        } else {
          Object.values($windows.get())
            .filter(win => win.appId === 'camera')
            .forEach(win => closeWindow(win.id))
        }

        return ok('Camera hidden')
      }

      openApp('camera')

      return ok($recording.get().recording ? 'Camera on; it shows in the recording' : 'Camera on')
    }
  }
]
