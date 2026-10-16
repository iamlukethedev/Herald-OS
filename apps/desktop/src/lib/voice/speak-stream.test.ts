import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Chromium's audio element, as far as the whole-utterance player uses it. Like Chromium, `pause()`
 * queues its event and `load()` drops it, and taking the source away and loading fires no `error`.
 */
class FakeAudio {
  static made: FakeAudio[] = []
  static refuse: Error | null = null
  paused = true
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  onpause: (() => void) | null = null
  private pauseEvent: ReturnType<typeof setTimeout> | null = null

  constructor(public src: string) {
    FakeAudio.made.push(this)
  }

  play(): Promise<void> {
    if (FakeAudio.refuse) {
      return Promise.reject(FakeAudio.refuse)
    }

    this.paused = false

    return Promise.resolve()
  }

  pause(): void {
    if (!this.paused) {
      this.paused = true
      this.pauseEvent = setTimeout(() => this.onpause?.(), 0)
    }
  }

  removeAttribute(name: string): void {
    if (name === 'src') {
      this.src = ''
    }
  }

  load(): void {
    if (this.pauseEvent) {
      clearTimeout(this.pauseEvent)
      this.pauseEvent = null
    }
  }

  finish(): void {
    this.paused = true
    this.onended?.()
  }
}

// The renderer bridge: POST /api/audio/speak answers when the test says so.
const speech = vi.hoisted(() => ({ answer: null as null | ((value: unknown) => void), requests: [] as unknown[] }))

Object.assign(globalThis, {
  Audio: FakeAudio,
  window: {
    heraldOS: {
      backend: {
        rest: (request: unknown) => {
          speech.requests.push(request)

          return new Promise(resolve => (speech.answer = resolve))
        }
      }
    }
  }
})

const { playbackTicket, playClip, speakOnce, stopFallbackAudio, synthesizeOnce } = await import('./speak-stream.ts')

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const EDGE_CLIP = { ok: true, data_url: 'data:audio/mpeg;base64,AAAA', provider: 'edge' }

beforeEach(() => {
  FakeAudio.made.length = 0
  FakeAudio.refuse = null
  speech.requests.length = 0
  speech.answer = null
})

describe('synthesizeOnce', () => {
  it("returns Hermes's clip with the provider that spoke it, and asks nothing for blank text", async () => {
    const clip = synthesizeOnce('  Hello there.  ')
    speech.answer?.(EDGE_CLIP)

    expect(await clip).toEqual({ src: EDGE_CLIP.data_url, provider: 'edge' })
    expect(speech.requests).toEqual([{ method: 'POST', path: '/api/audio/speak', body: { text: 'Hello there.' }, query: undefined }])
    expect(await synthesizeOnce('   ')).toBeNull()
    expect(speech.requests).toHaveLength(1)
  })
})

describe('the whole-utterance player', () => {
  it('plays a line and resolves when it ends', async () => {
    let done = false
    const spoken = speakOnce('Hello there.').then(() => (done = true))
    speech.answer?.(EDGE_CLIP)
    await vi.waitFor(() => expect(FakeAudio.made).toHaveLength(1))

    expect(FakeAudio.made[0].src).toBe(EDGE_CLIP.data_url)
    expect(FakeAudio.made[0].paused).toBe(false)
    await flush()
    expect(done).toBe(false)

    FakeAudio.made[0].finish()
    await spoken
    expect(done).toBe(true)
  })

  it('never starts a line late when barge-in came while it was being made', async () => {
    const spoken = speakOnce('A long reply that takes a while to synthesize.')
    stopFallbackAudio()
    speech.answer?.(EDGE_CLIP)
    await spoken

    expect(FakeAudio.made).toHaveLength(0)
  })

  it('stops the clip playing now on barge-in, and its wait ends though Chromium fires no pause or error', async () => {
    const spoken = speakOnce('Hello there.')
    speech.answer?.(EDGE_CLIP)
    await vi.waitFor(() => expect(FakeAudio.made).toHaveLength(1))

    stopFallbackAudio()

    await expect(spoken).resolves.toBeUndefined()
    expect(FakeAudio.made[0].paused).toBe(true)
    expect(FakeAudio.made[0].src).toBe('')
  })

  it('lets a newer clip take the player over without dropping lines still being made', async () => {
    const ticket = playbackTicket()
    const first = playClip('blob:first', ticket)
    await flush()
    const second = playClip('blob:second', ticket)
    await first

    expect(FakeAudio.made.map(audio => [audio.src, audio.paused])).toEqual([
      ['', true],
      ['blob:second', false]
    ])
    expect(ticket()).toBe(true)

    stopFallbackAudio()
    await second
    expect(ticket()).toBe(false)
    expect(playbackTicket()()).toBe(true)
  })

  it('says when the clip is audible, and rejects one that cannot be played', async () => {
    const audible = vi.fn()
    const playing = playClip('blob:hello', undefined, audible)
    await vi.waitFor(() => expect(audible).toHaveBeenCalledTimes(1))
    FakeAudio.made[0].finish()
    await playing

    FakeAudio.refuse = new Error('NotSupportedError: The element has no supported sources.')
    await expect(playClip('blob:broken')).rejects.toThrow('NotSupportedError')
  })

  it('plays nothing for a ticket barge-in has made stale', async () => {
    const ticket = playbackTicket()
    stopFallbackAudio()
    await playClip('blob:late', ticket)

    expect(FakeAudio.made).toHaveLength(0)
  })
})
