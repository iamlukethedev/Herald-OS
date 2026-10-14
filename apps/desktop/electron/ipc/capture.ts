import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clipboard, ClipboardItem, dialog, ipcMain, nativeImage, shell, systemPreferences } from 'electron'
import { translate } from '../../shared/i18n.ts'
import { type CaptureTool, type CaptureToolResult, IPC, type RecordingState, type ScreenshotMode } from '../../shared/ipc.ts'
import { allowAttachments } from '../attachments.ts'
import { menuLanguage } from '../i18n.ts'
import { log } from '../log.ts'
import { run } from '../platform/exec.ts'
import { pickColourMac, readImageMac } from '../platform/mac-tools.ts'

/** Screen grabs handed to Hermes; they only need to outlive the question about them. */
export function capturesDir(): string {
  return path.join(os.tmpdir(), 'herald-os-captures')
}

const stamp = () => {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
}

/** Where screenshots go: the Desktop on a Mac (as macOS does), ~/Pictures/Screenshots on Linux. */
function screenshotsDir(): string {
  return process.platform === 'darwin' ? path.join(os.homedir(), 'Desktop') : path.join(os.homedir(), 'Pictures', 'Screenshots')
}

function recordingsDir(): string {
  return process.platform === 'darwin' ? path.join(os.homedir(), 'Movies') : path.join(os.homedir(), 'Videos', 'Recordings')
}

const SCREEN_RECORDING_PANE = 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture'

let probedThisLaunch = false
let explaining = false

/** Tests start each case as a fresh launch. */
export function resetScreenRecordingCheck(): void {
  probedThisLaunch = false
  explaining = false
}

/**
 * Throws, after telling the person how to turn it on, unless macOS lets Herald OS read the screen.
 * Without the permission `screencapture` still succeeds but sees only the wallpaper, the menu bar
 * and Herald's own windows, so nothing it captures may reach Hermes or text recognition. The status
 * reads `denied` until macOS has asked, and it asks only when a capture is attempted, so the first
 * refusal in a launch takes one silent capture (then deletes it) to bring up macOS's prompt and put
 * Herald OS in the pane's list. A change to the switch applies only after Herald OS reopens.
 */
export async function ensureScreenRecording(): Promise<void> {
  if (process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('screen') === 'granted') {
    return
  }

  if (!probedThisLaunch) {
    probedThisLaunch = true
    const probe = path.join(capturesDir(), `permission-${Date.now()}.png`)
    fs.mkdirSync(capturesDir(), { recursive: true })
    await run('screencapture', ['-x', '-t', 'png', probe], 15_000)
    fs.rmSync(probe, { force: true })
  }

  const language = menuLanguage()
  const title = translate(language, 'permission.screen.title')
  const detail = translate(language, 'permission.screen.detail')

  // Not awaited: the capture fails now (Hermes gets the reason) while the explanation stays up.
  if (!explaining) {
    explaining = true
    void dialog
      .showMessageBox({ type: 'warning', message: title, detail, buttons: [translate(language, 'permission.screen.open'), translate(language, 'permission.screen.notNow')], defaultId: 0, cancelId: 1 })
      .then(({ response }) => (response === 0 ? shell.openExternal(SCREEN_RECORDING_PANE) : undefined))
      .catch(error => log('capture', `screen recording explanation: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        explaining = false
      })
  }

  throw new Error(`${title}. ${detail}`)
}

async function slurp(): Promise<string | null> {
  const region = await run('slurp', [], 300_000)

  if (region.code === 127) {
    throw new Error('slurp is not installed (it draws the selection on Wayland)')
  }

  return region.code === 0 && region.stdout.trim() ? region.stdout.trim() : null
}

/**
 * Let the person draw a rectangle on screen and save it as a PNG: `screencapture -i` on macOS,
 * slurp and grim on Wayland. Resolves with the file, or null when they pressed Escape.
 */
export async function captureRegion(): Promise<string | null> {
  fs.mkdirSync(capturesDir(), { recursive: true })
  const file = path.join(capturesDir(), `region-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)

  if (process.platform === 'darwin') {
    await ensureScreenRecording()
    await run('screencapture', ['-i', '-x', '-t', 'png', file], 300_000)

    return fs.existsSync(file) ? file : null
  }

  if (process.platform === 'linux') {
    const geometry = await slurp()

    if (!geometry) {
      return null
    }

    const grab = await run('grim', ['-g', geometry, file], 30_000)

    if (grab.code === 127) {
      throw new Error('grim is not installed (it takes the screenshot on Wayland)')
    }

    return grab.code === 0 && fs.existsSync(file) ? file : null
  }

  throw new Error('Selecting part of the screen is not available on this platform yet')
}

/** The newest PNG in a folder written after `since` (niri saves window shots under its own name). */
function newestSince(dir: string, since: number): string | null {
  try {
    return (
      fs
        .readdirSync(dir)
        .filter(name => name.toLowerCase().endsWith('.png'))
        .map(name => ({ file: path.join(dir, name), at: fs.statSync(path.join(dir, name)).mtimeMs }))
        .filter(entry => entry.at >= since)
        .sort((a, b) => b.at - a.at)[0]?.file ?? null
    )
  } catch {
    return null
  }
}

/** A screenshot saved where screenshots go; null when the person cancelled the selection. */
export async function captureScreenshot(mode: ScreenshotMode): Promise<string | null> {
  const dir = screenshotsDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `Screenshot ${stamp()}.png`)

  if (process.platform === 'darwin') {
    const flags = mode === 'region' ? ['-i'] : mode === 'window' ? ['-iW'] : []
    await ensureScreenRecording()
    await run('screencapture', ['-x', ...flags, '-t', 'png', file], 300_000)

    return fs.existsSync(file) ? file : null
  }

  if (process.platform !== 'linux') {
    throw new Error('Screenshots are not available on this platform yet')
  }

  if (mode === 'window') {
    // niri knows where the focused window is and writes the shot to its own screenshot folder.
    const since = Date.now() - 1000
    const shot = await run('niri', ['msg', 'action', 'screenshot-window'], 15_000)

    if (shot.code !== 0) {
      throw new Error(shot.stderr.trim() || 'niri could not take the window screenshot')
    }

    for (let attempt = 0; attempt < 20; attempt++) {
      const found = newestSince(dir, since)

      if (found) {
        return found
      }

      await new Promise(resolve => setTimeout(resolve, 150))
    }

    return null
  }

  const geometry = mode === 'region' ? await slurp() : null

  if (mode === 'region' && !geometry) {
    return null
  }

  const grab = await run('grim', [...(geometry ? ['-g', geometry] : []), file], 30_000)

  if (grab.code === 127) {
    throw new Error('grim is not installed (it takes screenshots on Wayland)')
  }

  return grab.code === 0 && fs.existsSync(file) ? file : null
}

/**
 * One screen recording at a time: wf-recorder on Wayland, `screencapture -v` on macOS. Both
 * finish the file when they receive SIGINT, which is how a recording stops.
 */
class Recorder {
  private child: ChildProcess | null = null
  private current: RecordingState = { recording: false }

  constructor(private readonly onChange: (state: RecordingState) => void) {}

  state(): RecordingState {
    return { ...this.current }
  }

  async start(options: { region?: boolean; audio?: boolean }): Promise<RecordingState> {
    if (this.child) {
      return this.state()
    }

    const dir = recordingsDir()
    fs.mkdirSync(dir, { recursive: true })
    let command: string
    let args: string[]
    let file: string

    if (process.platform === 'darwin') {
      await ensureScreenRecording()
      file = path.join(dir, `Herald OS Recording ${stamp()}.mov`)
      command = 'screencapture'
      args = ['-v', ...(options.audio ? ['-g'] : []), file]
    } else if (process.platform === 'linux') {
      const geometry = options.region ? await slurp() : null

      if (options.region && !geometry) {
        return this.state()
      }

      file = path.join(dir, `Recording ${stamp()}.mp4`)
      command = 'wf-recorder'
      args = ['-f', file, ...(geometry ? ['-g', geometry] : []), ...(options.audio ? ['--audio'] : [])]
    } else {
      throw new Error('Screen recording is not available on this platform yet')
    }

    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', chunk => {
      stderr = (stderr + String(chunk)).slice(-1000)
    })
    child.on('error', error => {
      log('capture', `${command}: ${error.message}`)
      this.finish(false)
    })
    child.on('exit', code => {
      if (code && code !== 130) {
        log('capture', `${command} exited ${code}: ${stderr.trim().slice(-300)}`)
      }

      this.finish(true)
    })
    this.child = child
    this.current = { recording: true, file, startedAt: Date.now(), audio: Boolean(options.audio) }
    this.onChange(this.state())

    return this.state()
  }

  async stop(): Promise<RecordingState> {
    const child = this.child

    if (!child) {
      return this.state()
    }

    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.kill('SIGINT')
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 8000))])

    if (this.child === child) {
      child.kill('SIGKILL')
    }

    return this.state()
  }

  private finish(keepFile: boolean): void {
    this.child = null
    const file = this.current.file
    this.current = { recording: false, file: keepFile && file && fs.existsSync(file) ? file : undefined }
    this.onChange(this.state())
  }
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const MAX_IMAGE_BYTES = 40 * 1024 * 1024

/** Only images under the home folder or Herald OS's own capture folder are read or written here. */
function userImagePath(target: string, mustExist: boolean): string {
  const file = path.resolve(String(target).replace(/^file:\/\//, ''))
  const inside = [os.homedir(), capturesDir()].some(root => file === root || file.startsWith(`${root}${path.sep}`))

  if (!inside || !IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
    throw new Error('Only images in your home folder can be opened here')
  }

  if (mustExist) {
    const stat = fs.statSync(file)

    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) {
      throw new Error(`${path.basename(file)} is too large to edit`)
    }
  }

  return file
}

export function registerCaptureIpc(onRecording: (state: RecordingState) => void): void {
  const recorder = new Recorder(onRecording)

  // A capture is something the person may then ask Hermes about.
  const attachable = (file: string | null): string | null => {
    if (file) {
      allowAttachments([file])
    }

    return file
  }

  ipcMain.handle(IPC.captureRegion, async () => attachable(await captureRegion()))
  ipcMain.handle(IPC.captureScreenshot, async (_event, mode: ScreenshotMode) => attachable(await captureScreenshot(mode === 'window' || mode === 'screen' ? mode : 'region')))
  ipcMain.handle(IPC.captureRecord, (_event, action: 'start' | 'stop' | 'toggle', options: { region?: boolean; audio?: boolean } = {}) => {
    const start = action === 'start' || (action === 'toggle' && !recorder.state().recording)

    return start ? recorder.start(options) : recorder.stop()
  })
  ipcMain.handle(IPC.captureRecordState, () => recorder.state())
  // macOS: the colour picker, QR codes and text from the screen (Herald OS Linux runs them through its CLI).
  ipcMain.handle(IPC.captureTool, async (_event, tool: CaptureTool): Promise<CaptureToolResult> => {
    if (process.platform !== 'darwin') {
      throw new Error('On Herald OS Linux the herald-os CLI runs these tools')
    }

    if (tool === 'colour') {
      const hex = await pickColourMac()

      if (!hex) {
        return { cancelled: true }
      }

      clipboard.writeText(hex)

      return { text: hex }
    }

    const file = await captureRegion()

    if (!file) {
      return { cancelled: true }
    }

    try {
      const lines = await readImageMac(file, tool === 'qr' ? 'codes' : 'text')
      const text = lines.join('\n')

      if (text) {
        clipboard.writeText(text)
      }

      return { text, lines: lines.length }
    } finally {
      fs.rmSync(file, { force: true })
    }
  })
  ipcMain.handle(IPC.captureReadImage, (_event, target: string) => nativeImage.createFromPath(userImagePath(target, true)).toDataURL())
  ipcMain.handle(IPC.captureSaveImage, (_event, target: string, dataUrl: string) => {
    const file = userImagePath(target, false)
    const match = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl))

    if (!match) {
      throw new Error('The image must be a PNG')
    }

    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(match[1], 'base64'))

    return file
  })
  ipcMain.handle(IPC.captureCopyImage, async (_event, source: string) => {
    const image = String(source).startsWith('data:image/') ? nativeImage.createFromDataURL(String(source)) : nativeImage.createFromPath(userImagePath(source, true))

    if (image.isEmpty()) {
      throw new Error('There is no image to copy')
    }

    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })])
  })
  ipcMain.handle(IPC.cameraRequest, async () => (process.platform === 'darwin' ? systemPreferences.askForMediaAccess('camera') : true))
}
