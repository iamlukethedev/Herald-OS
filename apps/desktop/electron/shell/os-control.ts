import { type BrowserWindow, ipcMain } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { IPC, type OsControlReply, type OsControlRequest, type ShellCommand } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import type { ActivityHub } from '../room/activity.ts'

/*
 * OS control: how anything outside the renderer (the agent's `os_ui` tool through the bridge
 * plugin, the `herald-os` CLI) runs a command from the renderer's registry and gets the result.
 *
 * - `OsCommandBridge` is the main <-> renderer half: it posts an `OsControlRequest` to the Hermes
 *   window and resolves when the window replies (or times out).
 * - `OsControlServer` is a JSON-lines Unix socket shared by both shell modes. In panels mode the
 *   existing `ControlSocket` hands `ui*` requests to `handleUiRequest`; in desktop mode the server
 *   runs on its own under the Herald OS data dir.
 *
 * Requests carry a per-launch token that main also gives the backend (HERALD_OS_CONTROL_TOKEN), so a
 * stray local process cannot drive the UI even though the socket is user-only (0600). Hermes
 * processes outside Herald send `activity` under a token of their own (electron/room/activity.ts),
 * which reports live steps and runs nothing.
 */

const REPLY_TIMEOUT_MS = 8_000
/** Herald Canvas and Herald Office commands load, render and save whole images and documents; Herald Calc's plots may read a closed workbook. */
const CANVAS_TIMEOUT_MS = 90_000
const LONG_COMMAND = /^(canvas|docs|sheets|slides|office|calc)\./

export class OsCommandBridge {
  private readonly pending = new Map<string, { resolve: (reply: OsControlReply) => void; timer: ReturnType<typeof setTimeout> }>()
  private counter = 0

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    ipcMain.on(IPC.osControlReply, (_event, reply: OsControlReply) => {
      const entry = this.pending.get(reply.requestId)

      if (entry) {
        clearTimeout(entry.timer)
        this.pending.delete(reply.requestId)
        entry.resolve(reply)
      }
    })
  }

  private send(request: { kind: 'run'; command: string; args: Record<string, unknown>; source: 'agent' | 'cli' | 'plugin'; session: string | null } | { kind: 'list' } | { kind: 'state' }): Promise<OsControlReply> {
    const win = this.getWindow()

    if (!win || win.isDestroyed()) {
      return Promise.resolve({ requestId: '', error: 'The Hermes window is not open.' })
    }

    const requestId = `oc${++this.counter}`
    const full = { ...request, requestId } as OsControlRequest

    const timeout = request.kind === 'run' && LONG_COMMAND.test(request.command) ? CANVAS_TIMEOUT_MS : REPLY_TIMEOUT_MS

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({ requestId, error: 'The Hermes window did not answer in time.' })
      }, timeout)
      this.pending.set(requestId, { resolve, timer })
      win.webContents.send(IPC.osControlRequest, full)
    })
  }

  run(command: string, args: Record<string, unknown>, source: 'agent' | 'cli' | 'plugin', session: string | null = null): Promise<OsControlReply> {
    return this.send({ kind: 'run', command, args, source, session })
  }

  list(): Promise<OsControlReply> {
    return this.send({ kind: 'list' })
  }

  state(): Promise<OsControlReply> {
    return this.send({ kind: 'state' })
  }
}

export interface UiControlRequest {
  cmd: string
  token?: string
  command?: string
  args?: unknown
  source?: string
  /** The live Hermes UI session whose tool sent a `ui` request; bridges from before it send none. */
  session?: unknown
}

/** A Hermes UI session id as the bridge sends it (the tui_gateway's `sid`). */
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/

function requestSession(value: unknown): string | null {
  const session = typeof value === 'string' ? value.trim() : ''

  return SESSION_ID.test(session) ? session : null
}

let controlToken = ''

/** The per-launch token main hands to the backend and requires on `ui*` requests. */
export function osControlToken(): string {
  if (!controlToken) {
    controlToken = crypto.randomBytes(24).toString('base64url')
  }

  return controlToken
}

const UI_COMMANDS = new Set(['ui', 'ui-list', 'ui-state'])

export function isUiRequest(cmd: string): boolean {
  return UI_COMMANDS.has(cmd)
}

/** Serve one `ui*` request through the bridge; `null` when `cmd` is not a UI request. */
export async function handleUiRequest(request: UiControlRequest, bridge: Pick<OsCommandBridge, 'run' | 'list' | 'state'>): Promise<Record<string, unknown> | null> {
  if (!isUiRequest(request.cmd)) {
    return null
  }

  if (request.token !== osControlToken()) {
    return { ok: false, error: 'invalid control token' }
  }

  let reply: OsControlReply

  switch (request.cmd) {
    case 'ui': {
      if (!request.command || typeof request.command !== 'string') {
        return { ok: false, error: 'ui needs a command id' }
      }

      const args = request.args && typeof request.args === 'object' && !Array.isArray(request.args) ? (request.args as Record<string, unknown>) : {}
      reply = await bridge.run(request.command, args, request.source === 'cli' ? 'cli' : 'agent', requestSession(request.session))

      break
    }
    case 'ui-list':
      reply = await bridge.list()

      break
    default:
      reply = await bridge.state()
  }

  if (reply.error) {
    return { ok: false, error: reply.error }
  }

  const result = reply.result

  if (request.cmd === 'ui' && result && typeof result === 'object') {
    return { ...(result as Record<string, unknown>) }
  }

  return { ok: true, result }
}

export interface DesktopControlOptions {
  bridge: Pick<OsCommandBridge, 'run' | 'list' | 'state'>
  /** `activity` from Hermes processes outside Herald, under a token of its own. */
  activity: Pick<ActivityHub, 'handle'>
  /** Hand a ShellCommand to the Hermes window. */
  relay: (command: ShellCommand) => void
}

/**
 * The desktop control socket's requests. No CLI talks to this socket (the Linux one serves
 * `herald-os`), so every client but a Hermes process reporting `activity` is the backend, and
 * everything else needs the launch token.
 */
export function desktopControlHandler({ bridge, activity, relay }: DesktopControlOptions): (request: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async request => {
    if (request.cmd === 'activity') {
      return activity.handle(request)
    }

    if (request.token !== osControlToken()) {
      return { ok: false, error: 'invalid control token' }
    }

    const ui = await handleUiRequest(request as unknown as UiControlRequest, bridge)

    if (ui) {
      return ui
    }

    // A few CLI conveniences the Linux socket also offers, relayed as ShellCommands.
    const cmd = String(request.cmd ?? '')
    const args = Array.isArray(request.args) ? (request.args as string[]) : []

    switch (cmd) {
      case 'page':
        relay({ type: 'show-page', args })

        return { ok: true }
      case 'notify':
        relay({ type: 'notify', args })

        return { ok: true }
      case 'voice':
        relay({ type: 'voice', args: [args[0] ?? 'toggle'] })

        return { ok: true }
      case 'os':
        relay({ type: 'os', args: [args[0]], payload: args[1] ? (JSON.parse(args[1]) as Record<string, unknown>) : undefined })

        return { ok: true }
      default:
        return { ok: false, error: `unknown command ${cmd}` }
    }
  }
}

/** The longest line either control socket holds while it waits for the newline; a client that sends more is cut off. */
export const CONTROL_LINE_MAX = 1024 * 1024

/** Read one JSON-lines connection: every complete line is answered with one line. */
export function serveJsonLines(connection: net.Socket, answer: (line: string) => Promise<Record<string, unknown>>): void {
  let pending = ''
  let pendingBytes = 0

  connection.setEncoding('utf8')
  connection.on('data', (chunk: string) => {
    let start = 0
    let end = chunk.indexOf('\n')

    while (end >= 0) {
      const line = (pending + chunk.slice(start, end)).trim()
      pending = ''
      pendingBytes = 0
      start = end + 1
      end = chunk.indexOf('\n', start)

      if (line) {
        void answer(line).then(reply => {
          if (!connection.destroyed) {
            connection.write(`${JSON.stringify(reply)}\n`)
          }
        })
      }
    }

    const rest = chunk.slice(start)
    pending += rest
    pendingBytes += Buffer.byteLength(rest)

    if (pendingBytes > CONTROL_LINE_MAX) {
      connection.destroy()
    }
  })
  connection.on('error', () => undefined)
}

/** A JSON-lines Unix socket server: one request object per line in, one reply object per line out. */
export class OsControlServer {
  private server: net.Server | null = null

  constructor(
    readonly socketPath: string,
    private readonly handle: (request: Record<string, unknown>) => Promise<Record<string, unknown>>
  ) {}

  start(): void {
    try {
      fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 })
      fs.unlinkSync(this.socketPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log('os-control', `cannot prepare ${this.socketPath}: ${(error as Error).message}`)

        return
      }
    }

    this.server = net.createServer(connection => serveJsonLines(connection, line => this.handleLine(line)))
    this.server.on('error', error => log('os-control', `socket error: ${error.message}`))
    this.server.listen(this.socketPath, () => {
      fs.chmodSync(this.socketPath, 0o600)
      log('os-control', `listening on ${this.socketPath}`)
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null

    try {
      fs.unlinkSync(this.socketPath)
    } catch {
      // Already gone.
    }
  }

  private async handleLine(line: string): Promise<Record<string, unknown>> {
    let request: Record<string, unknown>

    try {
      request = JSON.parse(line) as Record<string, unknown>
    } catch {
      return { ok: false, error: 'invalid JSON' }
    }

    try {
      return await this.handle(request)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
