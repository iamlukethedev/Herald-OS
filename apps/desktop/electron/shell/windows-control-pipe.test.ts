import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, ipcMain: { on: vi.fn(), handle: vi.fn() }, shell: {} }))
vi.mock('../log.ts', () => ({ log: vi.fn() }))

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-pipe-'))
vi.stubEnv('HERMES_HOME', path.join(scratch, 'hermes'))

const { WindowsControlPipe, windowsControlPipeName } = await import('./windows-control-pipe.ts')
const { CONTROL_LINE_MAX, desktopControlHandler, OsControlServer, osControlToken } = await import('./os-control.ts')
const { ActivityHub } = await import('../room/activity.ts')

const READ_WRITE = 0x12019b
const WRITE_DAC = 0x40000

/*
 * The client runs in its own Node process because the server polls its overlapped I/O on this
 * thread, and a client's blocking ReadFile here would stall it. It opens the pipe with the exact
 * rights it asks for, so a test can also ask for one the DACL withholds.
 */
const CLIENT = `
const ffi = require('koffi')
const kernel = ffi.load('kernel32.dll')
const open = kernel.func('void * __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *template)')
const read = kernel.func('int __stdcall ReadFile(void *handle, _Out_ uint8_t *buffer, uint32_t length, _Out_ uint32_t *count, void *overlapped)')
const write = kernel.func('int __stdcall WriteFile(void *handle, const uint8_t *buffer, uint32_t length, _Out_ uint32_t *count, void *overlapped)')
const close = kernel.func('int __stdcall CloseHandle(void *handle)')
const lastError = kernel.func('uint32_t __stdcall GetLastError()')
const [endpoint, access, piece] = process.argv.slice(1)
const size = Number(piece) || 65536
const handle = open(endpoint, Number(access), 0, null, 3, 0, null)
if (!handle || ffi.address(handle) === 0xffffffffffffffffn) {
  console.log('ERROR ' + lastError())
  process.exit(0)
}
console.log('CONNECTED')
const input = []
process.stdin.on('data', chunk => input.push(chunk))
process.stdin.on('end', () => {
  const bytes = Buffer.concat(input)
  if (bytes.length) {
    for (let offset = 0; offset < bytes.length; offset += size) {
      const chunk = bytes.subarray(offset, offset + size)
      if (!write(handle, chunk, chunk.length, [0], null)) {
        console.log('WRITE_ERROR ' + lastError())
        close(handle)
        return
      }
      // Small pieces are spaced out so the server reads them as separate fragments.
      if (piece) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40)
    }
  }
  let reply = Buffer.alloc(0)
  const buffer = Buffer.alloc(65536)
  while (!reply.includes(10)) {
    const count = [0]
    if (!read(handle, buffer, buffer.length, count, null) || count[0] === 0) break
    reply = Buffer.concat([reply, buffer.subarray(0, count[0])])
  }
  console.log(reply.length ? 'REPLY ' + reply.toString('hex') : 'EOF')
  close(handle)
})
`

const children: ChildProcessWithoutNullStreams[] = []
const stops: Array<() => Promise<void> | void> = []

afterEach(async () => {
  await Promise.all(children.splice(0).map(child => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return undefined
    }

    const closed = new Promise(resolve => child.once('close', resolve))
    child.kill()

    return closed
  }))

  for (const stop of stops.splice(0)) await stop()
})

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

/** A client that connects at once and sends `payload` when released: at once, unless `hold`; in `piece`-byte writes if given. */
function client(endpoint: string, options: { payload?: string; access?: number; hold?: boolean; piece?: number } = {}) {
  const child = spawn(process.execPath, ['-e', CLIENT, endpoint, String(options.access ?? READ_WRITE), String(options.piece ?? '')], { windowsHide: true, stdio: 'pipe', timeout: 15_000 })
  children.push(child)
  let stdout = ''
  let stderr = ''
  let ready!: () => void
  const connected = new Promise<void>(resolve => { ready = resolve })
  child.stdout.on('data', data => {
    stdout += data.toString()
    if (stdout.includes('CONNECTED')) ready()
  })
  child.stderr.on('data', data => { stderr += data.toString() })
  const done = new Promise<string>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => (code === 0 ? resolve(stdout.trim().split(/\r?\n/).at(-1) ?? '') : reject(new Error(`pipe client exited ${code}: ${stderr}`))))
  })

  child.stdin.on('error', () => undefined)
  const release = () => child.stdin.end(options.payload ?? '')

  if (!options.hold) {
    release()
  }

  return { done, connected, release }
}

/** One request line in, the parsed reply line out. */
async function ask(endpoint: string, request: Record<string, unknown>): Promise<unknown> {
  const reply = await client(endpoint, { payload: `${JSON.stringify(request)}\n` }).done
  expect(reply).toMatch(/^REPLY /)

  return JSON.parse(Buffer.from(reply.slice(6), 'hex').toString('utf8'))
}

function started(accept: (connection: import('node:stream').Duplex) => void, endpoint?: string) {
  const server = new WindowsControlPipe(accept, endpoint)
  stops.push(() => server.stop().catch(() => undefined))

  return server
}

/** Waits until nothing serves `endpoint` any more: its last handle is closed. */
async function released(endpoint: string): Promise<void> {
  await vi.waitFor(async () => expect(await client(endpoint).done).toBe('ERROR 2'), { timeout: 5000 })
}

/** An OsControlServer on a fresh pipe name, stopped and released after the test. */
function controlServer(handle: (request: Record<string, unknown>) => Promise<Record<string, unknown>>, idleMs?: number) {
  const endpoint = windowsControlPipeName()
  const server = new OsControlServer(endpoint, handle, idleMs)
  stops.push(() => {
    server.stop()

    return released(endpoint)
  })

  return { endpoint, server }
}

describe('the Windows control pipe name', () => {
  it('names this process and 128 random bits, and is fixed before the pipe exists', () => {
    const name = windowsControlPipeName()

    expect(name).toMatch(new RegExp(`^\\\\\\\\\\.\\\\pipe\\\\herald-os-${process.pid}-[0-9a-f]{32}$`))
    expect(windowsControlPipeName()).not.toBe(name)
    expect(path.resolve(name)).toBe(process.platform === 'win32' ? name : path.resolve(name))
  })
})

describe.skipIf(process.platform !== 'win32')('the Windows control pipe', () => {
  it('serves the name it was given and carries UTF-8 split inside its characters', async () => {
    const endpoint = windowsControlPipeName()
    const pieces: Buffer[] = []
    const server = started(connection => {
      connection.on('data', (piece: Buffer) => {
        pieces.push(piece)

        if (piece.includes(10)) {
          connection.write(Buffer.concat(pieces))
        }
      })
    }, endpoint)
    const text = 'Grüße 世界\n'

    expect(await server.start()).toBe(endpoint)
    expect(server.securityVerified).toBe(true)
    // Three-byte writes split ü, ß and both CJK characters across reads.
    expect(await client(endpoint, { payload: text, piece: 3 }).done).toBe(`REPLY ${Buffer.from(text).toString('hex')}`)
    expect(pieces.length).toBeGreaterThan(1)
  })

  it('refuses a name that is not this process’s herald-os pipe', async () => {
    const foreign = `\\\\.\\pipe\\herald-os-${process.pid + 1}-${'0'.repeat(32)}`

    await expect(started(connection => connection.destroy(), foreign).start()).rejects.toThrow('Invalid local Windows control pipe identity')
    await expect(started(connection => connection.destroy(), path.join(scratch, 'control.sock')).start()).rejects.toThrow('Invalid local Windows control pipe identity')
  })

  it('cannot be replaced while the first instance lives', async () => {
    const endpoint = windowsControlPipeName()
    const first = started(connection => connection.destroy(), endpoint)
    await first.start()

    await expect(started(connection => connection.destroy(), endpoint).start()).rejects.toThrow()
    expect(first.securityVerified).toBe(true)
  })

  it('does not give even its owner the right to change its permissions', async () => {
    const endpoint = await started(connection => connection.destroy()).start()

    expect(await client(endpoint, { access: WRITE_DAC }).done).toBe('ERROR 5')
  })

  it('serves one client at a time and takes the next once the first closes', async () => {
    const endpoint = await started(connection => connection.pipe(connection)).start()
    const first = client(endpoint, { payload: 'first\n', hold: true })
    await first.connected

    expect(await client(endpoint, { payload: 'second\n' }).done).toBe('ERROR 231')

    first.release()
    expect(await first.done).toBe(`REPLY ${Buffer.from('first\n').toString('hex')}`)
    await vi.waitFor(async () => expect(await client(endpoint, { payload: 'third\n' }).done).toBe(`REPLY ${Buffer.from('third\n').toString('hex')}`), { timeout: 5000 })
  })

  it('releases its name on stop, even with a client connected and waiting', async () => {
    const server = started(connection => { connection.resume() })
    const endpoint = await server.start()
    const waiting = client(endpoint, { hold: true })
    await waiting.connected

    await server.stop()
    waiting.release()

    expect(await waiting.done).toMatch(/^(EOF|WRITE_ERROR \d+)$/)
    expect(await client(endpoint).done).toBe('ERROR 2')
  })

  it('reports a failing accept and closes the pipe', async () => {
    let report!: (error: Error) => void
    const failed = new Promise<Error>(resolve => { report = resolve })
    const server = new WindowsControlPipe(() => { throw new Error('injected accept failure') }, undefined, report)
    stops.push(() => server.stop().catch(() => undefined))
    const endpoint = await server.start()
    const victim = client(endpoint)

    expect((await failed).message).toBe('injected accept failure')
    expect(server.securityVerified).toBe(false)
    expect(await victim.done).toMatch(/^(EOF|ERROR \d+)$/)
  })
})

describe.skipIf(process.platform !== 'win32')('the desktop control socket on Windows', () => {
  function liveHub() {
    const dataDir = fs.mkdtempSync(path.join(scratch, 'data-'))
    const hub = new ActivityHub({ dataDir, socket: windowsControlPipeName(), pid: 4242, alive: () => false })
    hub.start({ elsewhere: true, elsewhereLive: true })
    stops.push(() => hub.stop())
    const control = JSON.parse(fs.readFileSync(path.join(dataDir, 'observe', '4242.json'), 'utf8')) as { token: string; socket: string }

    // The control file names the pipe exactly; path.resolve must not turn it into a drive path.
    expect(control.socket).toMatch(/^\\\\\.\\pipe\\herald-os-/)

    return { hub, token: control.token }
  }

  const bridge = () => ({
    run: vi.fn(async () => ({ requestId: 'oc1', result: { ok: true, summary: 'Opened Memory', page: 'memory' } })),
    list: vi.fn(async () => ({ requestId: 'oc2', result: [] })),
    state: vi.fn(async () => ({ requestId: 'oc3', result: { page: 'overview' } }))
  })

  it('needs the launch token for ui over the pipe, as over the Unix socket', async () => {
    const { hub } = liveHub()
    const fake = bridge()
    const { endpoint, server } = controlServer(desktopControlHandler({ bridge: fake, activity: hub, relay: vi.fn() }))
    server.start()
    const ui = { cmd: 'ui', command: 'page.open', args: { name: 'memory' }, source: 'agent' }

    await vi.waitFor(async () => expect(await ask(endpoint, { ...ui, token: 'wrong' })).toEqual({ ok: false, error: 'invalid control token' }), { timeout: 5000 })
    expect(await ask(endpoint, ui)).toEqual({ ok: false, error: 'invalid control token' })
    expect(fake.run).not.toHaveBeenCalled()

    expect(await ask(endpoint, { ...ui, token: osControlToken() })).toEqual({ ok: true, summary: 'Opened Memory', page: 'memory' })
    expect(fake.run).toHaveBeenCalledTimes(1)
  })

  it('answers activity under its own token, and cuts off a line over a mebibyte', async () => {
    const { hub, token } = liveHub()
    const { endpoint, server } = controlServer(desktopControlHandler({ bridge: bridge(), activity: hub, relay: vi.fn() }))
    server.start()

    await vi.waitFor(async () => expect(await ask(endpoint, { cmd: 'activity', token, events: [] })).toEqual({ ok: true, accepted: 0 }), { timeout: 5000 })
    expect(await ask(endpoint, { cmd: 'ui', token, command: 'page.open' })).toEqual({ ok: false, error: 'invalid control token' })

    expect(await client(endpoint, { payload: 'x'.repeat(CONTROL_LINE_MAX + 1) }).done).toMatch(/^(EOF|WRITE_ERROR \d+)$/)
    await vi.waitFor(async () => expect(await ask(endpoint, { cmd: 'activity', token, events: [] })).toEqual({ ok: true, accepted: 0 }), { timeout: 5000 })
  })

  it('cuts off a client that holds the pipe without a request, but not one waiting for a slow reply', async () => {
    const slow = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 900))

      return { ok: true, slow: true }
    })
    const { endpoint, server } = controlServer(slow, 300)
    server.start()
    await vi.waitFor(async () => expect(await ask(endpoint, {})).toEqual({ ok: true, slow: true }), { timeout: 5000 })

    const squatter = client(endpoint, { hold: true })
    await squatter.connected

    // Once the idle limit passes, the next client gets the single instance.
    await vi.waitFor(async () => expect(await ask(endpoint, {})).toEqual({ ok: true, slow: true }), { timeout: 5000 })
    squatter.release()
    expect(await squatter.done).toMatch(/^(EOF|WRITE_ERROR \d+)$/)
  })

  it('serves again when stopped and started at once', async () => {
    const { endpoint, server } = controlServer(async () => ({ ok: true }))
    server.start()
    await vi.waitFor(async () => expect(await ask(endpoint, {})).toEqual({ ok: true }), { timeout: 5000 })

    server.stop()
    server.start()

    await vi.waitFor(async () => expect(await ask(endpoint, {})).toEqual({ ok: true }), { timeout: 5000 })

    // A replacement stopped before it started must not let the next one skip the wait.
    server.stop()
    server.start()
    server.stop()
    server.start()

    await vi.waitFor(async () => expect(await ask(endpoint, {})).toEqual({ ok: true }), { timeout: 5000 })
  })
})
