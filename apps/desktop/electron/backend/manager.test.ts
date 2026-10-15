import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendRuntime } from '../../shared/ipc.ts'

const found = vi.hoisted(() => ({ runtime: null as BackendRuntime | null, install: null as string | null }))

vi.mock('./resolve.ts', () => ({ resolveBackendRuntime: () => found.runtime, pendingInstall: () => found.install }))
vi.mock('./bridge-plugin.ts', () => ({ ensureBridgePlugin: async () => null }))
vi.mock('./shell-env.ts', () => ({ loginShellPath: async () => process.env.PATH ?? '' }))
vi.mock('../log.ts', () => ({ log: () => undefined }))

import { BackendManager, restErrorDetail, WAIT_POLL_MS, waitingReason } from './manager.ts'

let dir: string
let manager: BackendManager

/** A Hermes whose `serve` exits at once, so a start gets as far as spawning it and no further. */
const installed = (): BackendRuntime => ({ kind: 'managed', label: 'managed Hermes install', root: dir, command: [process.execPath, '-e', 'process.exit(3)'] })

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-manager-'))
  vi.stubEnv('HERMES_HOME', dir)
  vi.stubEnv('HERALD_OS_BACKEND_URL', undefined)
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  found.runtime = null
  found.install = null
  manager = new BackendManager()
})

afterEach(async () => {
  await manager.stop()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('BackendManager without a Hermes to start', () => {
  it('waits, then starts the Hermes that gets installed', async () => {
    await manager.start()
    expect(manager.getState()).toMatchObject({ phase: 'waiting', error: waitingReason(null) })

    vi.advanceTimersByTime(WAIT_POLL_MS)
    expect(manager.getState().phase).toBe('waiting')

    found.runtime = installed()
    vi.advanceTimersByTime(WAIT_POLL_MS)
    expect(manager.getState()).toMatchObject({ phase: 'starting', runtime: { label: 'managed Hermes install' } })
    await vi.waitFor(() => expect(manager.getState().phase).toBe('restarting'))
  })

  it("waits for the image's first-boot install even once Hermes is there", async () => {
    found.runtime = installed()
    found.install = 'offline'
    await manager.start()
    expect(manager.getState()).toMatchObject({ phase: 'waiting', install: 'offline', error: waitingReason('offline') })

    found.install = 'installing'
    vi.advanceTimersByTime(WAIT_POLL_MS)
    expect(manager.getState()).toMatchObject({ phase: 'waiting', install: 'installing', error: waitingReason('installing') })

    found.install = null
    vi.advanceTimersByTime(WAIT_POLL_MS)
    expect(manager.getState()).toMatchObject({ phase: 'starting', install: undefined })
    await vi.waitFor(() => expect(manager.getState().phase).toBe('restarting'))
  })

  it('stops waiting when the shell stops it', async () => {
    await manager.start()
    await manager.stop()

    found.runtime = installed()
    vi.advanceTimersByTime(WAIT_POLL_MS * 2)
    expect(manager.getState().phase).toBe('stopped')
  })
})

describe('restErrorDetail', () => {
  it("reads Hermes's reason from a JSON error body", () => {
    expect(restErrorDetail('{"detail":"Memory provider \'mem0\' is not ready."}', 'Bad Request')).toBe("Memory provider 'mem0' is not ready.")
    expect(restErrorDetail('{"error":"no such job"}', 'Not Found')).toBe('no such job')
    expect(restErrorDetail('"plain reason"', 'Bad Request')).toBe('plain reason')
  })

  it('shows the message inside an object detail instead of [object Object]', () => {
    expect(restErrorDetail('{"detail":{"message":"Provider needs an API key."}}', 'Bad Request')).toBe('Provider needs an API key.')
    expect(restErrorDetail('{"detail":{"detail":"Nested reason."}}', 'Bad Request')).toBe('Nested reason.')
    expect(restErrorDetail('{"error":{"code":42,"message":"Quota exceeded."}}', 'Too Many Requests')).toBe('Quota exceeded.')
    expect(restErrorDetail('{"detail":[{"loc":["body","provider"],"msg":"field required"},{"msg":"must be a string"}]}', 'Unprocessable Entity')).toBe('field required; must be a string')
  })

  it('falls back to the status text when the JSON carries no reason', () => {
    expect(restErrorDetail('{"detail":{"code":42}}', 'Bad Request')).toBe('Bad Request')
    expect(restErrorDetail('{}', 'Bad Request')).toBe('Bad Request')
    expect(restErrorDetail('', 'Bad Gateway')).toBe('Bad Gateway')
  })

  it('gives nothing for an HTML page, so the caller words it from the status code', () => {
    expect(restErrorDetail('<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>', 'Bad Gateway')).toBe('')
    expect(restErrorDetail('\n  <html>Internal Server Error</html>', 'Internal Server Error')).toBe('')
  })

  it('keeps a plain-text body', () => {
    expect(restErrorDetail('upstream timed out', 'Gateway Timeout')).toBe('upstream timed out')
  })
})
