import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AudioWsKind, BackendRuntime, BackendState, RestRequest } from '../../shared/ipc.ts'
import { osEnv } from '../env.ts'
import { log } from '../log.ts'
import { hermesHome, heraldOsDataDir } from '../paths.ts'
import { ensureBridgePlugin } from './bridge-plugin.ts'
import { type AttachTarget, attachTarget, foreignGateway } from './coexist.ts'
import { waitForStatus } from './probe.ts'
import { LineBuffer, parseReadyLine, readyFileName, staleReadyFiles } from './ready.ts'
import { pendingInstall, resolveBackendRuntime } from './resolve.ts'
import { withoutInheritedSession } from './session-env.ts'
import { loginShellPath } from './shell-env.ts'

const READY_TIMEOUT_MS = 90_000
const STATUS_TIMEOUT_MS = 60_000
const MAX_RESTARTS = 4
const BACKOFF_MS = [1_000, 3_000, 7_000, 15_000]
const LOG_TAIL_LINES = 200
/** How often the shell looks again for a Hermes Agent to start while it waits for one. */
export const WAIT_POLL_MS = 3_000

/** What the boot screen says while there is no Hermes to start (`install`: the image's note, see pendingInstall). */
export function waitingReason(install: string | null): string {
  switch (install) {
    case null:
      return 'No Hermes runtime found. Install Hermes Agent (curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash) or set HERALD_OS_HERMES_ROOT; Herald OS starts it as soon as it is installed.'
    case 'offline':
      return 'Hermes Agent comes from the internet, and this computer was offline when it first started. Join a network and it installs by itself, which takes a few minutes; Herald OS starts it then.'
    case 'installing':
      return 'Installing Hermes Agent. It takes a few minutes; Herald OS starts it when it is ready.'
    case 'retrying':
      return 'Hermes Agent did not install, so it tries again in a few minutes (journalctl -u herald-os-hermes says why). Herald OS starts it when it is ready.'
    default:
      return 'Hermes Agent is not installed yet. It installs by itself once this computer is online; Herald OS starts it then.'
  }
}

export type BackendListener = (state: BackendState) => void

/**
 * Owns the `hermes serve` child: resolve -> spawn -> ready -> probe -> ready state, restart with
 * bounded backoff on unexpected exit, and REST forwarding that adds the token in main (ADR-007).
 */
export class BackendManager {
  private state: BackendState = { phase: 'idle', attempt: 0, logTail: [] }
  private child: ChildProcess | null = null
  private token = ''
  /** Control socket the bridge plugin's `os_ui` tool dials, and the token it must present. */
  private control: { socketPath: string; token: string } | null = null
  private listeners = new Set<BackendListener>()

  setControl(socketPath: string, token: string): void {
    this.control = { socketPath, token }
  }
  private stopping = false
  private startGeneration = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private waitTimer: ReturnType<typeof setInterval> | null = null
  private readonly tail: string[] = []

  getState(): BackendState {
    return { ...this.state, logTail: this.tail.slice(-LOG_TAIL_LINES) }
  }

  /** Process id of the running `hermes serve`, if any. */
  childPid(): number | null {
    return this.child?.pid ?? null
  }

  onState(listener: BackendListener): () => void {
    this.listeners.add(listener)
    listener(this.getState())

    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    this.stopping = false
    await this.launch(0)
  }

  /** User-driven restart: resets the attempt budget. */
  async restart(): Promise<void> {
    log('backend', 'restart requested')
    this.clearRestartTimer()
    this.clearWaitTimer()
    await this.killChild()
    this.stopping = false
    await this.launch(0)
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearRestartTimer()
    this.clearWaitTimer()
    await this.killChild()
    this.update({ phase: 'stopped', wsUrl: undefined, baseUrl: undefined, port: undefined })
  }

  /**
   * Tokenized URL for an authenticated audio WebSocket. The renderer already receives the gateway
   * `wsUrl` with the same loopback token, so this widens nothing (ADR-007 amendment).
   */
  audioWsUrl(kind: AudioWsKind): string {
    const { port, phase } = this.state

    if (!port || phase !== 'ready') {
      throw new Error('Hermes backend is not ready')
    }

    const paths: Record<AudioWsKind, string> = { 'speak-stream': '/api/audio/speak-stream' }

    return `ws://127.0.0.1:${port}${paths[kind]}?token=${encodeURIComponent(this.token)}`
  }

  async rest<T>(request: RestRequest): Promise<T> {
    const { baseUrl } = this.state

    if (!baseUrl || this.state.phase !== 'ready') {
      throw new Error('Hermes backend is not ready')
    }

    if (!request.path.startsWith('/api/')) {
      throw new Error(`refusing REST path outside /api: ${request.path}`)
    }

    const url = new URL(baseUrl + request.path)

    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value))
      }
    }

    const response = await fetch(url, {
      method: request.method,
      headers: {
        'X-Hermes-Session-Token': this.token,
        ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(60_000)
    })

    const text = await response.text()

    if (!response.ok) {
      let detail = response.statusText

      try {
        const parsed = JSON.parse(text) as { detail?: unknown; error?: unknown }
        detail = String(parsed.detail ?? parsed.error ?? detail)
      } catch {
        detail = text || detail
      }

      throw new Error(`${request.method} ${request.path} -> ${response.status}: ${detail}`)
    }

    return (text ? JSON.parse(text) : null) as T
  }

  private async launch(attempt: number): Promise<void> {
    const generation = ++this.startGeneration
    this.clearWaitTimer()
    this.update({ phase: attempt === 0 ? 'resolving' : 'restarting', attempt, error: undefined, install: undefined })

    let attach: AttachTarget | null

    try {
      attach = attachTarget()
    } catch (error) {
      this.update({ phase: 'failed', error: error instanceof Error ? error.message : String(error) })

      return
    }

    if (attach) {
      await this.attach(attach, attempt, generation)

      return
    }

    const install = pendingInstall()
    const runtime = install ? null : resolveBackendRuntime()

    if (!runtime) {
      this.wait(install, generation)

      return
    }

    this.update({ runtime, phase: 'starting' })

    try {
      const bridgeError = (await ensureBridgePlugin(runtime)) ?? undefined
      const port = await this.spawnServe(runtime, generation)

      if (generation !== this.startGeneration) {
        return
      }

      const baseUrl = `http://127.0.0.1:${port}`
      await waitForStatus(baseUrl, this.token, STATUS_TIMEOUT_MS)

      if (generation !== this.startGeneration) {
        return
      }

      const wsUrl = `ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(this.token)}`
      this.update({ phase: 'ready', port, baseUrl, wsUrl, error: undefined, sharedGateway: this.sharedGateway()?.pid, bridgeError })
      log('backend', `ready on ${baseUrl} via ${runtime.label}`)
    } catch (error) {
      if (generation !== this.startGeneration) {
        return
      }

      const message = error instanceof Error ? error.message : String(error)
      log('backend', `start failed: ${message}`)
      await this.killChild()
      this.scheduleRestart(attempt, message)
    }
  }

  /**
   * No Hermes to start: say why, and look again every few seconds. On the image that means waiting
   * for firstboot.sh's note to go (Hermes is installed and set up then); elsewhere, for one to resolve.
   */
  private wait(install: string | null, generation: number): void {
    log('backend', install ? `waiting for Hermes Agent to be installed (${install})` : 'no Hermes runtime found; waiting for one to be installed')
    this.update({ phase: 'waiting', runtime: undefined, install: install ?? undefined, error: waitingReason(install) })
    this.waitTimer = setInterval(() => {
      if (generation !== this.startGeneration) {
        this.clearWaitTimer()

        return
      }

      const now = pendingInstall()

      if (!now && resolveBackendRuntime()) {
        log('backend', 'Hermes Agent is installed; starting it')
        void this.launch(0)
      } else if ((now ?? undefined) !== this.state.install) {
        this.update({ install: now ?? undefined, error: waitingReason(now) })
      }
    }, WAIT_POLL_MS)
  }

  /** Use a backend that is already running (HERALD_OS_BACKEND_URL) instead of starting a second one. */
  private async attach(target: AttachTarget, attempt: number, generation: number): Promise<void> {
    this.token = target.token
    this.update({ runtime: { kind: 'attached', label: `the Hermes backend at ${target.baseUrl}`, command: [] }, phase: 'starting' })

    try {
      await waitForStatus(target.baseUrl, this.token, STATUS_TIMEOUT_MS)

      if (generation !== this.startGeneration) {
        return
      }

      // It did not get our control socket in its environment; the bridge plugin reads this instead.
      if (this.control) {
        const file = path.join(heraldOsDataDir(), 'control.json')
        fs.mkdirSync(heraldOsDataDir(), { recursive: true })
        fs.writeFileSync(file, JSON.stringify({ socket: this.control.socketPath, token: this.control.token }), { mode: 0o600 })
        fs.chmodSync(file, 0o600)
      }

      const url = new URL(target.baseUrl)
      const port = Number(url.port) || 80
      this.update({ phase: 'ready', port, baseUrl: target.baseUrl, wsUrl: `ws://${url.host}/api/ws?token=${encodeURIComponent(this.token)}`, error: undefined, sharedGateway: undefined, bridgeError: undefined })
      log('backend', `attached to ${target.baseUrl}`)
    } catch (error) {
      if (generation === this.startGeneration) {
        this.scheduleRestart(attempt, `could not reach ${target.baseUrl}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Another app's messaging gateway on this Hermes home (Hermes Desktop, say), for Settings to mention. */
  sharedGateway(): { pid: number } | null {
    return foreignGateway(hermesHome(), { appPid: process.pid, backendPid: this.child?.pid ?? null }, { alive: isProcessAlive, parentOf: parentPid })
  }

  private async spawnServe(runtime: BackendRuntime, generation: number): Promise<number> {
    this.token = crypto.randomBytes(32).toString('base64url')
    const [command, ...head] = runtime.command
    const args = [...head, 'serve', '--host', '127.0.0.1', '--port', '0']
    const dataDir = heraldOsDataDir()
    const readyFile = path.join(dataDir, readyFileName(process.pid))
    fs.mkdirSync(dataDir, { recursive: true })
    fs.rmSync(readyFile, { force: true })

    for (const name of staleReadyFiles(fs.readdirSync(dataDir), process.pid, isProcessAlive)) {
      fs.rmSync(path.join(dataDir, name), { force: true })
    }

    const env = serveEnvironment(process.env, {
      PATH: await loginShellPath(),
      HERMES_HOME: hermesHome(),
      // Sessions start in the user's world, not inside the runtime checkout.
      TERMINAL_CWD: osEnv('DEFAULT_CWD') || os.homedir(),
      HERMES_DASHBOARD_SESSION_TOKEN: this.token,
      // The loopback token exemption, in-process cron ticker and orphan reaping upstream key on
      // this flag; Herald OS spawns and owns the backend exactly the way Desktop does.
      HERMES_DESKTOP: '1',
      HERALD_OS: '1',
      HERMES_PARENT_PID: String(process.pid),
      // Remove parent-identity markers inherited from an outer Hermes session
      // (the app may have been launched from a running Hermes CLI or Desktop
      // shell). A leaked HERMES_PARENT_START_MARKER + HERMES_PARENT_NONCE pairs
      // with the marker-parsing watchdog in upstream web_server_lifecycle.py:
      // the backend would conclusively decide "parent replaced" against the
      // real Electron PID and exit immediately after setup.ready. With no
      // marker, the watchdog degrades to plain PID liveness, which is safe.
      HERMES_PARENT_START_MARKER: undefined,
      HERMES_PARENT_NONCE: undefined,
      HERMES_SPAWN: undefined,
      HERMES_DESKTOP_READY_FILE: readyFile,
      PYTHONUNBUFFERED: '1',
      ...(this.control ? { HERALD_OS_CONTROL_SOCKET: this.control.socketPath, HERALD_OS_CONTROL_TOKEN: this.control.token } : {})
    })

    log('backend', `spawning ${[command, ...args].join(' ')} (cwd ${runtime.root ?? process.cwd()})`)
    const child = spawn(command, args, {
      cwd: runtime.root ?? undefined,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    })
    this.child = child

    return new Promise<number>((resolve, reject) => {
      let settled = false
      const stdout = new LineBuffer()
      const stderr = new LineBuffer()
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          clearInterval(filePoll)
          fs.rmSync(readyFile, { force: true })
          fn()
        }
      }
      const timer = setTimeout(() => settle(() => reject(new Error('timed out waiting for HERMES_BACKEND_READY'))), READY_TIMEOUT_MS)
      // Fallback for interpreters whose fd 1 is not our pipe: upstream also publishes the port in a ready file.
      const filePoll = setInterval(() => {
        try {
          const parsed = JSON.parse(fs.readFileSync(readyFile, 'utf8')) as { port?: unknown }

          if (typeof parsed.port === 'number') {
            settle(() => resolve(parsed.port as number))
          }
        } catch {
          // Not written yet.
        }
      }, 500)

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        for (const line of stdout.push(chunk)) {
          this.record(`[out] ${line}`)
          const port = parseReadyLine(line)

          if (port !== null) {
            settle(() => resolve(port))
          }
        }
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        for (const line of stderr.push(chunk)) {
          this.record(`[err] ${line}`)
        }
      })
      child.on('error', error => settle(() => reject(error)))
      child.on('exit', (code, signal) => {
        for (const line of [...stdout.flush(), ...stderr.flush()]) {
          this.record(line)
        }

        log('backend', `serve exited code=${code} signal=${signal}`)

        if (this.child === child) {
          this.child = null
        }

        settle(() => reject(new Error(`hermes serve exited early (code ${code ?? 'null'}, signal ${signal ?? 'none'})`)))

        if (settled && generation === this.startGeneration && !this.stopping && this.state.phase === 'ready') {
          this.scheduleRestart(this.state.attempt, `backend exited unexpectedly (code ${code ?? 'null'})`)
        }
      })
    })
  }

  private scheduleRestart(previousAttempt: number, reason: string): void {
    if (this.stopping) {
      return
    }

    const next = previousAttempt + 1

    if (next > MAX_RESTARTS) {
      this.update({ phase: 'failed', error: reason, wsUrl: undefined, baseUrl: undefined, port: undefined })

      return
    }

    const delay = BACKOFF_MS[Math.min(next - 1, BACKOFF_MS.length - 1)]
    log('backend', `restart ${next}/${MAX_RESTARTS} in ${delay}ms: ${reason}`)
    this.update({ phase: 'restarting', attempt: next, error: reason, wsUrl: undefined, baseUrl: undefined, port: undefined })
    this.clearRestartTimer()
    this.restartTimer = setTimeout(() => void this.launch(next), delay)
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private clearWaitTimer(): void {
    if (this.waitTimer) {
      clearInterval(this.waitTimer)
      this.waitTimer = null
    }
  }

  private async killChild(): Promise<void> {
    const child = this.child
    this.child = null
    // Any in-flight launch belongs to a previous generation now.
    this.startGeneration++

    if (!child || child.exitCode !== null) {
      return
    }

    await new Promise<void>(resolve => {
      const force = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }

        resolve()
      }, 4000)
      child.once('exit', () => {
        clearTimeout(force)
        resolve()
      })

      try {
        child.kill('SIGTERM')
      } catch {
        clearTimeout(force)
        resolve()
      }
    })
  }

  private record(line: string): void {
    this.tail.push(line)

    if (this.tail.length > LOG_TAIL_LINES * 2) {
      this.tail.splice(0, this.tail.length - LOG_TAIL_LINES)
    }

    log('serve', line)
  }

  private update(patch: Partial<BackendState>): void {
    this.state = { ...this.state, ...patch }
    const snapshot = this.getState()

    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }
}

/**
 * The environment `hermes serve` runs with: the app's, then `own`. A session the app inherited
 * (HERMES_SESSION_* and the rest, see session-env.ts) would otherwise be the backend's, and through
 * it every gateway and command the backend starts.
 */
export function serveEnvironment(inherited: NodeJS.ProcessEnv, own: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...withoutInheritedSession(inherited), ...own }
  delete env.ELECTRON_RUN_AS_NODE

  return env
}

function parentPid(pid: number): number | null {
  try {
    if (process.platform === 'linux') {
      // /proc/<pid>/stat: "pid (comm) state ppid …"; comm may contain spaces, so split after the ")".
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')

      return Number(fields[1]) || null
    }

    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 })

    return Number(out.trim()) || null
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    // EPERM: alive, owned by someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
