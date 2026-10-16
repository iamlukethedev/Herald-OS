import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalcNote } from '../../../../shared/calc.ts'
import { createNoteSaver, SAVE_DELAY_MS } from './saver.ts'

let clock = 1000
const saved = (note: { id: string; text: string }): CalcNote => ({ id: note.id, text: note.text, createdAt: 1, updatedAt: ++clock })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createNoteSaver', () => {
  it('saves a moment after typing rests, only the latest text', async () => {
    const save = vi.fn(async (note: { id: string; text: string }) => saved(note))
    const saver = createNoteSaver({ save, onError: vi.fn() })
    saver.schedule('a', '2')
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 50)
    saver.schedule('a', '2 +')
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 50)
    saver.schedule('a', '2 + 3')

    expect(save).not.toHaveBeenCalled()
    expect(saver.pending()).toBe(true)

    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS)

    expect(save.mock.calls).toEqual([[{ id: 'a', text: '2 + 3' }]])
    expect(saver.pending()).toBe(false)
    expect(saver.updatedAt('a')).toBe(clock)
  })

  it('saves at once on flush, and not again for text already sent', async () => {
    const save = vi.fn(async (note: { id: string; text: string }) => saved(note))
    const saver = createNoteSaver({ save, onError: vi.fn() })
    saver.known({ id: 'a', text: 'opened', updatedAt: 5 })
    saver.schedule('a', 'opened')
    await saver.flush()

    expect(save).not.toHaveBeenCalled()

    saver.schedule('a', 'typed')
    await saver.flush()
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS * 2)

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('saves one at a time and in order, so an older text never lands last', async () => {
    const landed: string[] = []
    let release: () => void = () => undefined
    const save = vi.fn(async (note: { id: string; text: string }) => {
      if (note.text === 'first') {
        await new Promise<void>(resolve => {
          release = resolve
        })
      }

      landed.push(note.text)

      return saved(note)
    })
    const saver = createNoteSaver({ save, onError: vi.fn() })
    saver.schedule('a', 'first')
    void saver.flush()
    saver.schedule('a', 'second')
    const done = saver.flush()
    await vi.advanceTimersByTimeAsync(0)

    expect(landed).toEqual([])

    release()
    await done

    expect(landed).toEqual(['first', 'second'])
  })

  it('sends text typed back to what is on its way, rather than trusting a save not yet done', async () => {
    let release: () => void = () => undefined
    const save = vi.fn(async (note: { id: string; text: string }) => {
      if (note.text === 'ab') {
        await new Promise<void>(resolve => {
          release = resolve
        })
      }

      return saved(note)
    })
    const saver = createNoteSaver({ save, onError: vi.fn() })
    saver.known({ id: 'a', text: 'a', updatedAt: 1 })
    saver.schedule('a', 'ab')
    void saver.flush()
    saver.schedule('a', 'a')
    const done = saver.flush()
    await vi.advanceTimersByTimeAsync(0)
    release()
    await done

    expect(save.mock.calls.map(([note]) => note.text)).toEqual(['ab', 'a'])
  })

  it('saves the other note first when typing moves to another', async () => {
    const save = vi.fn(async (note: { id: string; text: string }) => saved(note))
    const saver = createNoteSaver({ save, onError: vi.fn() })
    saver.schedule('a', 'in a')
    saver.schedule('b', 'in b')
    await saver.flush()

    expect(save.mock.calls.map(([note]) => note.id)).toEqual(['a', 'b'])
  })

  it('tells of a failed save and keeps the text for the next flush', async () => {
    const onError = vi.fn()
    const save = vi.fn<(note: { id: string; text: string }) => Promise<CalcNote>>().mockRejectedValueOnce(new Error('disk full')).mockImplementation(async note => saved(note))
    const saver = createNoteSaver({ save, onError })
    saver.schedule('a', 'precious')
    await saver.flush()

    expect(onError).toHaveBeenCalledWith(new Error('disk full'))
    expect(saver.pending()).toBe(true)

    await saver.flush()

    expect(save.mock.calls.map(([note]) => note.text)).toEqual(['precious', 'precious'])
    expect(saver.pending()).toBe(false)
  })
})
