import type { WebContents } from 'electron'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { whileOpen, WindowWatches } from './watches.ts'

const owner = (closed = false) => Object.assign(new EventEmitter(), { isDestroyed: () => closed }) as unknown as WebContents & EventEmitter
const project = (dir: string) => ({ dir })

describe('WindowWatches', () => {
  it('leaves no close listener behind after many watch and unwatch cycles', () => {
    const watches = new WindowWatches<{ dir: string }>()
    const contents = owner()
    const stop = vi.fn()

    for (let cycle = 0; cycle < 40; cycle++) {
      watches.add(`w${cycle}`, contents, project('/tmp/Poster.comp'), stop)
      watches.remove(`w${cycle}`, contents)
    }

    expect(contents.listenerCount('destroyed')).toBe(0)
    expect(stop).toHaveBeenCalledTimes(40)
    expect(watches.size).toBe(0)
  })

  it('takes each watch’s close listener with it when the window unwatches it', () => {
    const watches = new WindowWatches<{ dir: string }>()
    const contents = owner()
    const stops = Array.from({ length: 40 }, () => vi.fn())

    stops.forEach((stop, index) => watches.add(`w${index}`, contents, project(`/tmp/Poster-${index}.comp`), stop))
    expect(contents.listenerCount('destroyed')).toBe(40)

    stops.forEach((_stop, index) => watches.remove(`w${index}`, contents))

    expect(contents.listenerCount('destroyed')).toBe(0)
    expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true)
    expect(watches.size).toBe(0)
  })

  it('ends every watch a window kept when it closes, each once, and leaves other windows’ watches', () => {
    const watches = new WindowWatches<{ dir: string }>()
    const contents = owner()
    const other = owner()
    const first = vi.fn()
    const second = vi.fn()
    const kept = vi.fn()
    watches.add('a', contents, project('/tmp/Poster.comp'), first)
    watches.add('b', contents, project('/tmp/site'), second)
    watches.add('c', other, project('/tmp/Poster.comp'), kept)

    contents.emit('destroyed')
    watches.remove('a', contents)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(kept).not.toHaveBeenCalled()
    expect(contents.listenerCount('destroyed')).toBe(0)
    expect(other.listenerCount('destroyed')).toBe(1)
    expect(watches.find(contents, () => true)).toBeUndefined()
    expect(watches.size).toBe(1)
  })

  it('finds a window’s own watch, and lets no other window end it', () => {
    const watches = new WindowWatches<{ dir: string }>()
    const mine = owner()
    const other = owner()
    const poster = project('/tmp/Poster.comp')
    const stop = vi.fn()
    watches.add('a', mine, poster, stop)

    watches.remove('a', other)
    other.emit('destroyed')

    expect(stop).not.toHaveBeenCalled()
    expect(watches.find(mine, (watch) => watch.dir === poster.dir)).toBe(poster)
    expect(watches.find(other, (watch) => watch.dir === poster.dir)).toBeUndefined()
    expect(mine.listenerCount('destroyed')).toBe(1)
    expect(watches.size).toBe(1)
  })

  it('ends a watch at once when its window closed before the watch began', () => {
    const watches = new WindowWatches<{ dir: string }>()
    const contents = owner(true)
    const stop = vi.fn()

    watches.add('a', contents, project('/tmp/Poster.comp'), stop)

    expect(stop).toHaveBeenCalledTimes(1)
    expect(contents.listenerCount('destroyed')).toBe(0)
    expect(watches.size).toBe(0)
  })
})

describe('whileOpen', () => {
  it('takes its close listener off when the work ends, however many times it runs', () => {
    const contents = owner()
    const onClose = vi.fn()

    for (let run = 0; run < 40; run++) {
      whileOpen(contents, onClose)()
    }

    expect(contents.listenerCount('destroyed')).toBe(0)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('runs once when the window closes first, and at once when it already has', () => {
    const contents = owner()
    const onClose = vi.fn()
    const release = whileOpen(contents, onClose)

    contents.emit('destroyed')
    release()
    whileOpen(owner(true), onClose)

    expect(onClose).toHaveBeenCalledTimes(2)
    expect(contents.listenerCount('destroyed')).toBe(0)
  })
})
