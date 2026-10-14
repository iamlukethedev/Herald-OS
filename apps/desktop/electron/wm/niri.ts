import { type ChildProcess, execFile, spawn } from 'node:child_process'
import net from 'node:net'
import type { WmAction, WmLayout, WmState, WmWindow, WmWorkspace } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import type { Compositor } from './compositor.ts'

/**
 * Client for niri's IPC: keeps a mirror of windows and workspaces from `niri msg -j event-stream`
 * (the stream sends the full state first, then deltas) and issues `niri msg action ...`.
 * Windows belonging to this process (the shell's own) are flagged `ours` by pid.
 */
export class NiriClient implements Compositor {
  readonly name = 'niri' as const
  private stream: ChildProcess | null = null
  private windows = new Map<number, WmWindow>()
  private workspaces = new Map<number, WmWorkspace>()
  private focusedWindowId: number | null = null
  private listeners = new Set<(state: WmState) => void>()
  private stopped = false
  private notifyTimer: NodeJS.Timeout | null = null
  private openedAt = new Map<number, number>()
  private untiled = new Set<number>()
  private outputSizes: Array<[number, number]> = []

  get available(): boolean {
    return this.stream !== null
  }

  state(): WmState {
    return {
      available: this.available,
      windows: [...this.windows.values()].sort((a, b) => a.id - b.id),
      workspaces: [...this.workspaces.values()].sort((a, b) => a.idx - b.idx),
      focusedWindowId: this.focusedWindowId
    }
  }

  onState(listener: (state: WmState) => void): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  focusedWindow(): WmWindow | null {
    return this.focusedWindowId === null ? null : (this.windows.get(this.focusedWindowId) ?? null)
  }

  /** Our windows by title (titles are the identity niri rules use too). */
  ourWindow(title: string): WmWindow | undefined {
    return [...this.windows.values()].find(w => w.ours && w.title === title)
  }

  start(): void {
    if (this.stream || this.stopped) {
      return
    }

    const child = spawn('niri', ['msg', '-j', 'event-stream'], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.stream = child
    this.refreshOutputs()
    let buffer = ''

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')

      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)

        if (line) {
          this.handle(line)
        }

        index = buffer.indexOf('\n')
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => log('niri', chunk.trim()))
    child.on('error', error => {
      log('niri', `event stream unavailable: ${error.message}`)
      this.stream = null
      this.emit()
    })
    child.on('exit', code => {
      this.stream = null
      this.emit()

      if (!this.stopped) {
        log('niri', `event stream exited (${code}); retrying in 3s`)
        setTimeout(() => this.start(), 3000)
      }
    })
  }

  stop(): void {
    this.stopped = true
    this.stream?.kill()
    this.stream = null
  }

  async action(action: WmAction): Promise<void> {
    await this.raw(toArgs(action))
  }

  raw(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile('niri', ['msg', 'action', ...args], { timeout: 5000 }, (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message))
        } else {
          resolve()
        }
      })
    })
  }

  /**
   * Move a floating window to `x`, `y`: logical pixels from the top-left of the output's working
   * area, which for floating windows leaves out layer-shell panels but not niri's struts. Through
   * niri's socket when there is one, as a dragged window moves many times a second.
   */
  async moveFloatingWindow(id: number, x: number, y: number): Promise<void> {
    const socket = process.env.NIRI_SOCKET

    if (socket) {
      try {
        await niriRequest(socket, moveFloatingWindowRequest(id, x, y))

        return
      } catch {
        // `niri msg` below says what is wrong, if anything still is.
      }
    }

    await this.raw(moveFloatingWindowArgs(id, x, y))
  }

  /**
   * Move a floating window to `x`, `y` as `moveFloatingWindow` does, without niri sliding it there as
   * it slides any floating window moved more than 10 pixels at once: over the socket, in shorter
   * steps. In one move without the socket, or where niri has not said where the window is.
   */
  async placeFloatingWindow(win: WmWindow, x: number, y: number): Promise<void> {
    const socket = process.env.NIRI_SOCKET
    const at = win.layout

    if (socket && at && at.x !== null && at.y !== null) {
      try {
        for (const step of floatingSteps({ x: at.x, y: at.y }, { x, y })) {
          await niriRequest(socket, moveFloatingWindowRequest(win.id, step.x, step.y))
        }

        return
      } catch {
        // The one move below puts it there all the same.
      }
    }

    await this.moveFloatingWindow(win.id, x, y)
  }

  private handle(line: string): void {
    let event: Record<string, unknown>

    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }

    const [name, payload] = Object.entries(event)[0] ?? []

    if (!name || typeof payload !== 'object' || payload === null) {
      return
    }

    const p = payload as Record<string, unknown>

    switch (name) {
      case 'WorkspacesChanged': {
        // Outputs may have changed too (hotplug); workspaces are re-sent on such changes.
        this.refreshOutputs()
        this.workspaces.clear()

        for (const ws of (p.workspaces as RawWorkspace[]) ?? []) {
          this.workspaces.set(ws.id, toWorkspace(ws))
        }

        break
      }
      case 'WorkspaceActivated': {
        const id = p.id as number

        for (const ws of this.workspaces.values()) {
          if (ws.id === id) {
            ws.active = true
            ws.focused = Boolean(p.focused)
          } else if (ws.output === this.workspaces.get(id)?.output) {
            ws.active = false
            ws.focused = false
          }
        }

        break
      }
      case 'WorkspaceActiveWindowChanged': {
        const ws = this.workspaces.get(p.workspace_id as number)

        if (ws) {
          ws.activeWindowId = (p.active_window_id as number | null) ?? null
        }

        break
      }
      case 'WorkspaceUrgencyChanged':
        break
      case 'WindowsChanged': {
        this.windows.clear()

        for (const w of (p.windows as RawWindow[]) ?? []) {
          this.windows.set(w.id, toWindow(w))
        }

        this.focusedWindowId = [...this.windows.values()].find(w => w.focused)?.id ?? null
        break
      }
      case 'WindowOpenedOrChanged': {
        const w = toWindow(p.window as RawWindow)
        const isNew = !this.windows.has(w.id)
        this.windows.set(w.id, w)

        if (isNew) {
          this.openedAt.set(w.id, Date.now())
        }

        this.untileMaximizedToEdges(w)

        if (w.focused) {
          for (const other of this.windows.values()) {
            other.focused = other.id === w.id
          }

          this.focusedWindowId = w.id
        }

        break
      }
      case 'WindowClosed': {
        const id = p.id as number
        this.windows.delete(id)
        this.openedAt.delete(id)
        this.untiled.delete(id)

        if (this.focusedWindowId === id) {
          this.focusedWindowId = null
        }

        break
      }
      case 'WindowFocusChanged': {
        const id = (p.id as number | null) ?? null
        this.focusedWindowId = id

        for (const w of this.windows.values()) {
          w.focused = w.id === id
        }

        break
      }
      case 'WindowUrgencyChanged': {
        const w = this.windows.get(p.id as number)

        if (w) {
          w.urgent = Boolean(p.urgent)
        }

        break
      }
      case 'WindowLayoutsChanged': {
        for (const [id, layout] of layoutChanges(p.changes)) {
          const w = this.windows.get(id)

          if (w) {
            w.layout = layout
          }
        }

        break
      }
      default:
        return
    }

    this.emit()
  }

  /**
   * Apps that remember being maximized (Firefox, GTK apps) ask for it right after mapping, which
   * niri honours as "maximize to edges": a borderless window covering the whole output, ignoring
   * struts. Window rules only affect the open state, so undo it here for foreign windows during
   * their first seconds; a user maximizing later is left alone.
   */
  private untileMaximizedToEdges(w: WmWindow): void {
    if (w.ours || w.floating || this.untiled.has(w.id)) {
      return
    }

    const opened = this.openedAt.get(w.id) ?? 0

    if (Date.now() - opened > 5000) {
      return
    }

    const size = w.layout

    if (!size) {
      return
    }

    const coversOutput = this.outputSizes.some(([ow, oh]) => Math.abs(size.width - ow) <= 2 && Math.abs(size.height - oh) <= 2)

    if (coversOutput) {
      this.untiled.add(w.id)
      void this.raw(['maximize-window-to-edges', '--id', String(w.id)]).catch(() => undefined)
    }
  }

  private refreshOutputs(): void {
    execFile('niri', ['msg', '-j', 'outputs'], { timeout: 3000 }, (error, stdout) => {
      if (error) {
        return
      }

      try {
        const outputs = JSON.parse(stdout) as Record<string, { logical?: { width: number; height: number } | null }>
        this.outputSizes = Object.values(outputs)
          .map(o => o.logical)
          .filter((l): l is { width: number; height: number } => Boolean(l))
          .map(l => [l.width, l.height])
      } catch {
        // Ignore malformed output.
      }
    })
  }

  private emit(): void {
    // Coalesce bursts (the initial dump arrives as several events).
    if (this.notifyTimer) {
      return
    }

    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      const state = this.state()

      for (const listener of this.listeners) {
        listener(state)
      }
    }, 16)
  }
}

/** niri's `WindowLayout`; older niri sends none. */
interface RawLayout {
  pos_in_scrolling_layout?: [number, number] | null
  tile_size?: [number, number] | null
  window_size?: [number, number] | null
  tile_pos_in_workspace_view?: [number, number] | null
}

export interface RawWindow {
  id: number
  title: string | null
  app_id: string | null
  pid: number | null
  workspace_id: number | null
  is_focused: boolean
  is_floating: boolean
  is_urgent: boolean
  is_fullscreen?: boolean
  layout?: RawLayout | null
}

interface RawWorkspace {
  id: number
  idx: number
  name: string | null
  output: string | null
  is_active: boolean
  is_focused: boolean
  active_window_id: number | null
}

export function toWindow(w: RawWindow): WmWindow {
  return {
    id: w.id,
    title: w.title ?? '',
    appId: w.app_id ?? '',
    pid: w.pid ?? null,
    workspaceId: w.workspace_id ?? null,
    focused: Boolean(w.is_focused),
    floating: Boolean(w.is_floating),
    urgent: Boolean(w.is_urgent),
    ours: w.pid === process.pid,
    layout: toLayout(w.layout),
    ...(typeof w.is_fullscreen === 'boolean' ? { fullscreen: w.is_fullscreen } : {})
  }
}

function pair(value: unknown): [number, number] | null {
  return Array.isArray(value) && value.length === 2 && value.every(n => typeof n === 'number' && Number.isFinite(n)) ? [value[0], value[1]] : null
}

export function toLayout(layout: unknown): WmLayout | null {
  const raw = (layout && typeof layout === 'object' ? layout : {}) as RawLayout
  const size = pair(raw.window_size)

  if (!size) {
    return null
  }

  const tile = pair(raw.tile_size) ?? size
  const place = pair(raw.pos_in_scrolling_layout)
  const at = pair(raw.tile_pos_in_workspace_view)

  return {
    width: size[0],
    height: size[1],
    x: at ? at[0] : null,
    y: at ? at[1] : null,
    column: place ? place[0] : null,
    tile: place ? place[1] : null,
    tileWidth: tile[0],
    tileHeight: tile[1]
  }
}

/** The window ids and layouts of a `WindowLayoutsChanged` event. */
export function layoutChanges(changes: unknown): Array<[number, WmLayout | null]> {
  return (Array.isArray(changes) ? changes : []).flatMap((change): Array<[number, WmLayout | null]> =>
    Array.isArray(change) && typeof change[0] === 'number' ? [[change[0], toLayout(change[1])]] : []
  )
}

export function moveFloatingWindowRequest(id: number, x: number, y: number): unknown {
  return { Action: { MoveFloatingWindow: { id, x: { SetFixed: x }, y: { SetFixed: y } } } }
}

export function moveFloatingWindowArgs(id: number, x: number, y: number): string[] {
  // `niri msg` takes a leading minus for a move relative to where the window is.
  return ['move-floating-window', '--id', String(id), '-x', String(Math.max(0, x)), '-y', String(Math.max(0, y))]
}

/** niri slides a floating window to where it is moved when that is farther than this from where it was. */
const UNANIMATED_MOVE = 10

/**
 * Whole-pixel points from `from` to `to`, each nearer than niri's 10 pixels to the one before, the last
 * one `to`; none when the window is there already.
 */
export function floatingSteps(from: { x: number; y: number }, to: { x: number; y: number }): Array<{ x: number; y: number }> {
  const distance = Math.hypot(to.x - from.x, to.y - from.y)

  if (distance === 0) {
    return []
  }

  // Rounding the points can lengthen a step by up to a pixel on each axis.
  const count = Math.ceil(distance / (UNANIMATED_MOVE - 2))

  return Array.from({ length: count }, (_, index) => {
    const t = (index + 1) / count

    return index === count - 1 ? to : { x: Math.round(from.x + (to.x - from.x) * t), y: Math.round(from.y + (to.y - from.y) * t) }
  })
}

/** One request on niri's socket: a JSON line out, a JSON line back; rejects with niri's error. */
export function niriRequest(socket: string, request: unknown, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(socket)
    let buffer = ''
    const finish = (error: Error | null, value?: unknown) => {
      clearTimeout(timer)
      connection.destroy()

      if (error) {
        reject(error)
      } else {
        resolve(value)
      }
    }
    const timer = setTimeout(() => finish(new Error('niri did not answer')), timeoutMs)

    connection.setEncoding('utf8')
    connection.on('connect', () => connection.write(`${JSON.stringify(request)}\n`))
    connection.on('data', (chunk: string) => {
      buffer += chunk
      const end = buffer.indexOf('\n')

      if (end < 0) {
        return
      }

      try {
        const reply = JSON.parse(buffer.slice(0, end)) as { Ok?: unknown; Err?: unknown }

        if ('Err' in reply) {
          finish(new Error(String(reply.Err)))
        } else {
          finish(null, reply.Ok)
        }
      } catch {
        finish(new Error('niri sent an unreadable reply'))
      }
    })
    connection.on('error', error => finish(error))
    connection.on('close', () => finish(new Error('niri closed the connection')))
  })
}

function toWorkspace(ws: RawWorkspace): WmWorkspace {
  return {
    id: ws.id,
    idx: ws.idx,
    name: ws.name ?? null,
    output: ws.output ?? null,
    active: Boolean(ws.is_active),
    focused: Boolean(ws.is_focused),
    activeWindowId: ws.active_window_id ?? null
  }
}

export function toArgs(action: WmAction): string[] {
  switch (action.type) {
    case 'focus-window':
      return ['focus-window', '--id', String(action.id)]
    case 'close-window':
      return ['close-window', '--id', String(action.id)]
    case 'focus-workspace':
      return ['focus-workspace', String(action.ref)]
    case 'move-window-to-workspace':
      return ['move-window-to-workspace', '--window-id', String(action.id), String(action.ref)]
    case 'toggle-floating':
      return ['toggle-window-floating', '--id', String(action.id)]
    case 'fullscreen':
      return ['fullscreen-window', '--id', String(action.id)]
    case 'maximize-column':
      return ['maximize-column']
    case 'toggle-overview':
      return ['toggle-overview']
    case 'screenshot':
      return [action.what === 'screen' ? 'screenshot-screen' : action.what === 'window' ? 'screenshot-window' : 'screenshot']
    case 'raw':
      return action.args
  }
}
