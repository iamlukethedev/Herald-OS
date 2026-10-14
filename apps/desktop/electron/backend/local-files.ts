import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/*
 * Whether an attached backend reads this computer's files. HERALD_OS_BACKEND_URL must be a loopback
 * address, but the end of an SSH tunnel is one too, so the address says nothing about where Hermes
 * runs. The backend is asked to read back a file Herald has just written, holding a token it cannot
 * guess: only a backend that sees this computer's files gives the token back.
 */

const PROBE_TIMEOUT_MS = 5_000

/** What /api/fs/read-text answers with its own refusals: the file is not there, or not readable, from where Hermes runs. */
const REFUSALS = new Set([400, 403, 404])

/**
 * True when the backend at `baseUrl` read back the probe Herald wrote in `dir`, false when it
 * looked for the probe and could not read it, and undefined when it could not be asked (no answer,
 * or a Hermes without the route, whose 404 is the framework's bare "Not Found").
 */
export async function backendReadsLocalFiles(baseUrl: string, token: string, dir: string, fetchImpl: typeof fetch = fetch): Promise<boolean | undefined> {
  const secret = crypto.randomBytes(16).toString('hex')
  const file = path.join(dir, `files-probe-${crypto.randomBytes(6).toString('hex')}.txt`)

  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, secret, { mode: 0o600 })
    const url = new URL('/api/fs/read-text', baseUrl)
    url.searchParams.set('path', file)
    const response = await fetchImpl(url, { headers: { 'X-Hermes-Session-Token': token }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    const body = (await response.json().catch(() => null)) as { text?: unknown; detail?: unknown } | null

    if (response.ok) {
      return typeof body?.text === 'string' ? body.text.trim() === secret : undefined
    }

    return REFUSALS.has(response.status) && typeof body?.detail === 'string' && body.detail !== 'Not Found' ? false : undefined
  } catch {
    return undefined
  } finally {
    await fs.rm(file, { force: true }).catch(() => undefined)
  }
}
