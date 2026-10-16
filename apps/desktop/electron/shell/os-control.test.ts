import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { OsControlReply } from '../../shared/ipc.ts'
import type { ShellHost } from './host.ts'
import type { UiControlRequest } from './os-control.ts'

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, ipcMain: { on: vi.fn(), handle: vi.fn() }, shell: {} }))
vi.mock('../log.ts', () => ({ log: vi.fn() }))

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-'))
vi.stubEnv('HERMES_HOME', path.join(scratch, 'hermes'))

const { CONTROL_LINE_MAX, desktopControlHandler, handleUiRequest, OsCommandBridge, OsControlServer, osControlToken } = await import('./os-control.ts')
const { ControlSocket } = await import('./control-socket.ts')
const { ActivityHub } = await import('../room/activity.ts')

const OPENED: OsControlReply = { requestId: 'oc1', result: { ok: true, summary: 'Opened Memory', page: 'memory' } }

function fakeBridge() {
  return {
    run: vi.fn(async (_command: string, _args: Record<string, unknown>, _source: 'agent' | 'cli' | 'plugin', _session?: string | null) => OPENED),
    list: vi.fn(async (): Promise<OsControlReply> => ({ requestId: 'oc2', result: [] })),
    state: vi.fn(async (): Promise<OsControlReply> => ({ requestId: 'oc3', result: { page: 'overview' } }))
  }
}

const ui = (extra: Partial<UiControlRequest> = {}): UiControlRequest => ({ cmd: 'ui', token: osControlToken(), command: 'page.open', args: { name: 'memory' }, source: 'agent', ...extra })

describe('a ui request on the control socket', () => {
  it('hands the renderer the live Hermes session it names', async () => {
    const bridge = fakeBridge()

    expect(await handleUiRequest(ui({ session: ' a1b2c3d4 ' }), bridge)).toEqual({ ok: true, summary: 'Opened Memory', page: 'memory' })
    expect(bridge.run).toHaveBeenLastCalledWith('page.open', { name: 'memory' }, 'agent', 'a1b2c3d4')

    await handleUiRequest(ui({ session: 'agent:main_1.2-x', source: 'cli' }), bridge)
    expect(bridge.run).toHaveBeenLastCalledWith('page.open', { name: 'memory' }, 'cli', 'agent:main_1.2-x')

    await handleUiRequest(ui({ session: 's'.repeat(128) }), bridge)
    expect(bridge.run).toHaveBeenLastCalledWith('page.open', { name: 'memory' }, 'agent', 's'.repeat(128))
  })

  it('drops a session that is not an id and still runs the command', async () => {
    const bridge = fakeBridge()

    for (const session of [42, null, '', '   ', 'tab 1', '../a1b2', 's'.repeat(129), { id: 'a1b2c3d4' }, ['a1b2c3d4']]) {
      expect(await handleUiRequest(ui({ session }), bridge)).toMatchObject({ ok: true })
      expect(bridge.run).toHaveBeenLastCalledWith('page.open', { name: 'memory' }, 'agent', null)
    }
  })

  it('runs a request without a session, as a bridge from before it sends', async () => {
    const bridge = fakeBridge()

    expect(await handleUiRequest(ui(), bridge)).toEqual({ ok: true, summary: 'Opened Memory', page: 'memory' })
    expect(bridge.run).toHaveBeenCalledWith('page.open', { name: 'memory' }, 'agent', null)
    expect(await handleUiRequest({ cmd: 'ui-state', token: osControlToken() }, bridge)).toEqual({ ok: true, result: { page: 'overview' } })
  })

  it('refuses a request without the launch token, whatever session it names', async () => {
    const bridge = fakeBridge()

    expect(await handleUiRequest(ui({ token: 'guess', session: 'a1b2c3d4' }), bridge)).toEqual({ ok: false, error: 'invalid control token' })
    expect(await handleUiRequest(ui({ token: undefined, session: 'a1b2c3d4' }), bridge)).toEqual({ ok: false, error: 'invalid control token' })
    expect(bridge.run).not.toHaveBeenCalled()
  })
})

describe('how long the Hermes window has to answer a command', () => {
  it('is 90 seconds for the commands that open whole files, Herald Calc among them, and 8 for the rest', async () => {
    vi.useFakeTimers()

    try {
      const send = vi.fn()
      const bridge = new OsCommandBridge(() => ({ isDestroyed: () => false, webContents: { send } }) as unknown as BrowserWindow)
      const commands = ['page.open', 'calculator.open', 'calc.plot', 'calc.evaluate', 'sheets.read', 'canvas.export']
      const timedOut: string[] = []

      for (const command of commands) {
        void bridge.run(command, {}, 'agent').then(reply => {
          if (reply.error) {
            timedOut.push(command)
          }
        })
      }

      expect(send).toHaveBeenCalledTimes(commands.length)
      await vi.advanceTimersByTimeAsync(8_000)
      expect(timedOut).toEqual(['page.open', 'calculator.open'])
      await vi.advanceTimersByTimeAsync(82_000)
      expect(timedOut).toEqual(commands)
    } finally {
      vi.useRealTimers()
    }
  })
})

const stops: (() => void)[] = []

afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop()
  }
})

afterAll(() => {
  vi.unstubAllEnvs()
  fs.rmSync(scratch, { recursive: true, force: true })
})

/** A hub with live detail on, in a folder of its own, and the token its control file names. */
function liveHub() {
  const dataDir = fs.mkdtempSync(path.join(scratch, 'data-'))
  const hub = new ActivityHub({ dataDir, socket: path.join(dataDir, 'control.sock'), pid: 4242, alive: () => false })
  hub.start({ elsewhere: true, elsewhereLive: true })
  const { token } = JSON.parse(fs.readFileSync(path.join(dataDir, 'observe', '4242.json'), 'utf8')) as { token: string }

  return { hub, token }
}

const SESSION_START = [{ kind: 'session.start', session: 'a1b2c3d4', source: 'telegram' }]
const NO_TOKEN = { ok: false, error: 'invalid control token' }

/** One request line over the socket, and the reply line. */
function ask(socketPath: string, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => client.write(`${JSON.stringify(request)}\n`))
    let reply = ''
    client.setEncoding('utf8')
    client.on('data', chunk => {
      reply += chunk

      if (reply.includes('\n')) {
        client.end()
        resolve(JSON.parse(reply))
      }
    })
    client.on('error', reject)
  })
}

/** Send `data` without a newline; resolves once the server has hung up. */
function hungUp(socketPath: string, data: string): Promise<void> {
  return new Promise(resolve => {
    const client = net.createConnection(socketPath, () => client.write(data))
    client.on('error', () => undefined)
    client.on('close', () => resolve())
  })
}

describe('the desktop control socket', () => {
  it('answers activity under the activity token without the launch token, and still refuses the rest without it', async () => {
    const { hub, token } = liveHub()
    const bridge = fakeBridge()
    const relay = vi.fn()
    const handle = desktopControlHandler({ bridge, activity: hub, relay })

    expect(await handle({ cmd: 'activity', token, events: SESSION_START })).toEqual({ ok: true, accepted: 1 })
    expect(await handle({ cmd: 'activity', token: osControlToken(), events: SESSION_START })).toEqual({ ok: false, error: 'invalid activity token' })
    expect(await handle({ cmd: 'activity', events: SESSION_START })).toEqual({ ok: false, error: 'invalid activity token' })
    expect(await handle({ ...ui(), token })).toEqual(NO_TOKEN)
    expect(await handle({ ...ui(), token: undefined })).toEqual(NO_TOKEN)
    expect(await handle({ cmd: 'page', token, args: ['memory'] })).toEqual(NO_TOKEN)
    expect(bridge.run).not.toHaveBeenCalled()
    expect(relay).not.toHaveBeenCalled()

    expect(await handle({ ...ui() })).toEqual({ ok: true, summary: 'Opened Memory', page: 'memory' })
    expect(await handle({ cmd: 'page', token: osControlToken(), args: ['memory'] })).toEqual({ ok: true })
    expect(relay).toHaveBeenCalledWith({ type: 'show-page', args: ['memory'] })
  })

  it('does the same over its socket, and cuts off a client that sends more than a mebibyte without a newline', async () => {
    const { hub, token } = liveHub()
    const socketPath = path.join(fs.mkdtempSync(path.join(scratch, 's-')), 'control.sock')
    const server = new OsControlServer(socketPath, desktopControlHandler({ bridge: fakeBridge(), activity: hub, relay: vi.fn() }))
    server.start()
    stops.push(() => server.stop())
    await vi.waitFor(() => expect(fs.existsSync(socketPath)).toBe(true))

    expect(await ask(socketPath, { cmd: 'activity', token, events: SESSION_START })).toEqual({ ok: true, accepted: 1 })
    expect(await ask(socketPath, { ...ui(), token })).toEqual(NO_TOKEN)

    // A long line that ends in time is still read.
    expect(await ask(socketPath, { cmd: 'activity', token, events: [], pad: 'x'.repeat(CONTROL_LINE_MAX - 1000) })).toEqual({ ok: true, accepted: 0 })

    await hungUp(socketPath, 'x'.repeat(CONTROL_LINE_MAX + 1))

    expect(await ask(socketPath, { cmd: 'activity', token, events: SESSION_START })).toEqual({ ok: true, accepted: 1 })
  })
})

describe('the panels control socket', () => {
  it('answers activity under the activity token without the launch token, and still refuses ui without it', async () => {
    vi.stubEnv('XDG_RUNTIME_DIR', fs.mkdtempSync(path.join(scratch, 'r-')))
    const { hub, token } = liveHub()
    const bridge = fakeBridge()
    const socket = new ControlSocket({} as ShellHost, undefined, bridge, undefined, undefined, undefined, hub)
    socket.start()
    stops.push(() => socket.stop())
    await vi.waitFor(() => expect(fs.existsSync(socket.socketPath)).toBe(true))

    expect(await ask(socket.socketPath, { cmd: 'activity', token, events: SESSION_START })).toEqual({ ok: true, accepted: 1 })
    expect(await ask(socket.socketPath, { cmd: 'activity', token: osControlToken(), events: SESSION_START })).toEqual({ ok: false, error: 'invalid activity token' })
    expect(await ask(socket.socketPath, { ...ui(), token })).toEqual(NO_TOKEN)
    expect(await ask(socket.socketPath, { ...ui(), token: undefined })).toEqual(NO_TOKEN)
    expect(bridge.run).not.toHaveBeenCalled()

    expect(await ask(socket.socketPath, ui())).toEqual({ ok: true, summary: 'Opened Memory', page: 'memory' })

    await hungUp(socket.socketPath, 'x'.repeat(CONTROL_LINE_MAX + 1))

    expect(await ask(socket.socketPath, { cmd: 'activity', token, events: SESSION_START })).toEqual({ ok: true, accepted: 1 })
  })
})
