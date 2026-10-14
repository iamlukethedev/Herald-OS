import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backendReadsLocalFiles } from './local-files.ts'

const BASE = 'http://127.0.0.1:8642'

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-local-files-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** A backend on this computer: it reads the file it is asked about from this disk. */
const sameComputer: typeof fetch = async input => {
  const url = new URL(String(input))
  const file = url.searchParams.get('path') ?? ''

  return Response.json({ text: fs.readFileSync(file, 'utf8'), path: file })
}

describe('backendReadsLocalFiles', () => {
  it('trusts a backend that reads back the token Herald just wrote, with the session token', async () => {
    const seen: { path: string; token: string | null }[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      seen.push({ path: url.pathname, token: new Headers(init?.headers).get('X-Hermes-Session-Token') })

      return sameComputer(input, init)
    }

    expect(await backendReadsLocalFiles(BASE, 'secret-token', dir, fetchImpl)).toBe(true)
    expect(seen).toEqual([{ path: '/api/fs/read-text', token: 'secret-token' }])
  })

  it('finds a backend on another computer, which cannot find or read the file, or takes its path for nonsense', async () => {
    for (const [status, detail] of [
      [404, 'File not found'],
      [403, 'File is not readable'],
      [400, 'Path must be absolute']
    ] as const) {
      const elsewhere: typeof fetch = async () => Response.json({ detail }, { status })

      expect(await backendReadsLocalFiles(BASE, 'token', dir, elsewhere)).toBe(false)
    }
  })

  it('does not trust a file at the same path that holds something else', async () => {
    const lookalike: typeof fetch = async () => Response.json({ text: 'another computer, same user name' })

    expect(await backendReadsLocalFiles(BASE, 'token', dir, lookalike)).toBe(false)
  })

  it('cannot tell for a backend it cannot reach, one without the route, or one that answers otherwise', async () => {
    const down: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }

    expect(await backendReadsLocalFiles(BASE, 'token', dir, down)).toBeUndefined()
    expect(await backendReadsLocalFiles(BASE, 'token', dir, async () => Response.json({ detail: 'Not Found' }, { status: 404 }))).toBeUndefined()
    expect(await backendReadsLocalFiles(BASE, 'token', dir, async () => new Response('<!doctype html>', { status: 200 }))).toBeUndefined()
    expect(await backendReadsLocalFiles(BASE, 'token', dir, async () => Response.json({ detail: 'Internal error' }, { status: 500 }))).toBeUndefined()
    expect(await backendReadsLocalFiles(BASE, 'token', dir, async () => Response.json({ detail: 'Unauthorized' }, { status: 401 }))).toBeUndefined()
  })

  it('leaves no probe file behind, whatever the answer', async () => {
    await backendReadsLocalFiles(BASE, 'token', dir, sameComputer)
    await backendReadsLocalFiles(BASE, 'token', dir, async () => new Response('nope', { status: 500 }))

    expect(fs.readdirSync(dir)).toEqual([])
  })
})
