import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WmWindow } from '../../shared/ipc.ts'
import { floatingSteps, layoutChanges, moveFloatingWindowArgs, moveFloatingWindowRequest, NiriClient, niriRequest, type RawWindow, toLayout, toWindow } from './niri.ts'

const raw = (overrides: Partial<RawWindow> = {}): RawWindow => ({
  id: 7,
  title: 'Inbox',
  app_id: 'firefox',
  pid: 99,
  workspace_id: 1,
  is_focused: false,
  is_floating: false,
  is_urgent: false,
  ...overrides
})

describe('niri windows', () => {
  it('reads where a tile sits in its column, its sizes, and no position, which niri leaves out for tiles', () => {
    const win = toWindow(raw({ layout: { pos_in_scrolling_layout: [2, 1], tile_size: [964, 1026], window_size: [960, 1022], tile_pos_in_workspace_view: null } }))

    expect(win.layout).toEqual({ width: 960, height: 1022, x: null, y: null, column: 2, tile: 1, tileWidth: 964, tileHeight: 1026 })
    expect(win).not.toHaveProperty('fullscreen')
  })

  it('reads a floating window with its position in the view and no column', () => {
    const win = toWindow(raw({ is_floating: true, layout: { pos_in_scrolling_layout: null, tile_size: [120, 120], window_size: [120, 120], tile_pos_in_workspace_view: [1776, 856.5] } }))

    expect(win.layout).toEqual({ width: 120, height: 120, x: 1776, y: 856.5, column: null, tile: null, tileWidth: 120, tileHeight: 120 })
  })

  it('takes full screen only from a niri that reports it, and no layout from one that sends none', () => {
    expect(toWindow(raw({ is_fullscreen: true })).fullscreen).toBe(true)
    expect(toWindow(raw({ is_fullscreen: false })).fullscreen).toBe(false)
    expect(toWindow(raw()).layout).toBeNull()
    expect(toLayout({ tile_size: [10, 10] })).toBeNull()
    expect(toLayout({ window_size: [10, 'tall'] })).toBeNull()
    expect(toLayout({ window_size: [300, 200] })).toMatchObject({ tileWidth: 300, tileHeight: 200, column: null, x: null })
  })

  it('flags the shell its own windows by pid', () => {
    expect(toWindow(raw({ pid: process.pid })).ours).toBe(true)
    expect(toWindow(raw()).ours).toBe(false)
  })

  it('reads the layout changes niri batches, skipping anything malformed', () => {
    const changes = [
      [7, { pos_in_scrolling_layout: [1, 1], tile_size: [500, 400], window_size: [496, 396], tile_pos_in_workspace_view: null }],
      [8, { window_size: [120, 120], tile_pos_in_workspace_view: [24, 30] }],
      ['9', { window_size: [1, 1] }],
      'nonsense'
    ]

    expect(layoutChanges(changes)).toEqual([
      [7, { width: 496, height: 396, x: null, y: null, column: 1, tile: 1, tileWidth: 500, tileHeight: 400 }],
      [8, { width: 120, height: 120, x: 24, y: 30, column: null, tile: null, tileWidth: 120, tileHeight: 120 }]
    ])
    expect(layoutChanges(undefined)).toEqual([])
  })
})

describe('moving a floating window', () => {
  it('asks niri for a fixed position over the socket', () => {
    expect(JSON.stringify(moveFloatingWindowRequest(12, 1700, -4))).toBe('{"Action":{"MoveFloatingWindow":{"id":12,"x":{"SetFixed":1700},"y":{"SetFixed":-4}}}}')
  })

  it('keeps `niri msg` positions absolute: a leading minus would move it relative to where it is', () => {
    expect(moveFloatingWindowArgs(12, 1700, 860)).toEqual(['move-floating-window', '--id', '12', '-x', '1700', '-y', '860'])
    expect(moveFloatingWindowArgs(12, -3, -40)).toEqual(['move-floating-window', '--id', '12', '-x', '0', '-y', '0'])
  })
})

/** niri animates a floating move when its square is more than 10 * 10 (`move_and_animate` in its floating layout). */
const animated = (a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 > 100

describe('moving a floating window without niri sliding it', () => {
  it('goes in whole-pixel steps niri does not animate, ending where it was asked', () => {
    for (const [from, to] of [
      [{ x: 828, y: 905 }, { x: 516, y: 905 }],
      [{ x: 828, y: 905 }, { x: 1140, y: 841 }],
      [{ x: 600.5, y: 995.25 }, { x: 0, y: 0 }],
      [{ x: 10, y: 10 }, { x: 17, y: 3 }]
    ]) {
      const steps = floatingSteps(from, to)

      expect(steps.at(-1)).toEqual(to)
      steps.forEach((step, index) => {
        expect(Number.isInteger(step.x) && Number.isInteger(step.y)).toBe(true)
        expect(animated(index === 0 ? from : steps[index - 1], step)).toBe(false)
      })
    }
  })

  it('takes as few steps as that allows, and none when the window is there already', () => {
    expect(floatingSteps({ x: 828, y: 905 }, { x: 516, y: 905 })).toHaveLength(39)
    expect(floatingSteps({ x: 4, y: 4 }, { x: 0, y: 1 })).toEqual([{ x: 0, y: 1 }])
    expect(floatingSteps({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual([])
  })
})

describe('niriRequest', () => {
  let dir = ''
  let server: net.Server | null = null

  afterEach(async () => {
    vi.unstubAllEnvs()
    await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()))
    server = null

    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
      dir = ''
    }
  })

  /** A stand-in for niri's socket: hands each request line to `answer` and writes back what it returns. */
  async function fakeNiri(answer: (line: string) => string): Promise<{ socket: string; lines: string[] }> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'niri-'))
    const socket = path.join(dir, 'niri.sock')
    const lines: string[] = []
    server = net.createServer(connection => {
      let buffer = ''
      connection.setEncoding('utf8')
      connection.on('data', (chunk: string) => {
        buffer += chunk
        const end = buffer.indexOf('\n')

        if (end >= 0) {
          lines.push(buffer.slice(0, end))
          connection.write(answer(buffer.slice(0, end)))
        }
      })
    })
    await new Promise<void>(resolve => server?.listen(socket, resolve))

    return { socket, lines }
  }

  it('sends one JSON line and resolves with what niri handled', async () => {
    const niri = await fakeNiri(() => '{"Ok":"Handled"}\n')

    await expect(niriRequest(niri.socket, { Action: { FocusWindow: { id: 3 } } })).resolves.toBe('Handled')
    expect(niri.lines).toEqual(['{"Action":{"FocusWindow":{"id":3}}}'])
  })

  it('rejects with niri’s error, an unreadable reply, a silent niri or no niri at all', async () => {
    const niri = await fakeNiri(line => (line.includes('Bad') ? '{"Err":"no such window"}\n' : line.includes('Garbled') ? 'nope\n' : ''))

    await expect(niriRequest(niri.socket, { Bad: true })).rejects.toThrow('no such window')
    await expect(niriRequest(niri.socket, { Garbled: true })).rejects.toThrow('unreadable')
    await expect(niriRequest(niri.socket, { Quiet: true }, 100)).rejects.toThrow('did not answer')
    await expect(niriRequest(path.join(dir, 'missing.sock'), {})).rejects.toThrow()
  })

  it('places a floating window in steps, and in one move where niri gave no position', async () => {
    const niri = await fakeNiri(() => '{"Ok":"Handled"}\n')
    vi.stubEnv('NIRI_SOCKET', niri.socket)
    const menu: WmWindow = { id: 12, title: 'Herald OS · Dock Menu', appId: 'herald-os', pid: 1, workspaceId: 1, focused: false, floating: true, urgent: false, ours: true, layout: { width: 264, height: 107, x: 828, y: 905, column: null, tile: null, tileWidth: 264, tileHeight: 107 } }

    await new NiriClient().placeFloatingWindow(menu, 800, 905)
    expect(niri.lines).toEqual(['821', '814', '807', '800'].map(x => `{"Action":{"MoveFloatingWindow":{"id":12,"x":{"SetFixed":${x}},"y":{"SetFixed":905}}}}`))

    niri.lines.length = 0
    await new NiriClient().placeFloatingWindow({ ...menu, layout: null }, 700, 905)
    expect(niri.lines).toEqual([JSON.stringify(moveFloatingWindowRequest(12, 700, 905))])
  })
})
