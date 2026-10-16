import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SystemSpeech } from '../../../shared/ipc.ts'

// Main's renderer of the system voice, and the speakers: each clip "plays" until `during` returns.
const edges = vi.hoisted(() => ({
  rendered: [] as string[],
  /** How many renders had been asked for when each clip started playing. */
  playedAfter: [] as number[],
  answer: (_text: string): SystemSpeech | Promise<SystemSpeech> => ({ ok: true, audio: new Uint8Array([82, 73, 70, 70]), mimeType: 'audio/wav' }),
  during: async (_index: number): Promise<void> => undefined,
  refuse: null as Error | null
}))

vi.mock('./speak-stream.ts', () => {
  let silencedAt = 0

  return {
    playbackTicket: () => {
      const taken = silencedAt

      return () => taken === silencedAt
    },
    stopFallbackAudio: () => {
      silencedAt++
    },
    playClip: async (_src: string, ticket?: () => boolean, onPlaying?: () => void) => {
      if (ticket && !ticket()) {
        return
      }

      if (edges.refuse) {
        throw edges.refuse
      }

      edges.playedAfter.push(edges.rendered.length)
      onPlaying?.()
      await edges.during(edges.playedAfter.length - 1)
    }
  }
})

Object.assign(globalThis, {
  window: {
    heraldOS: {
      voice: {
        systemSpeech: async (text: string) => {
          edges.rendered.push(text)

          return edges.answer(text)
        }
      }
    }
  }
})

const { playbackTicket, stopFallbackAudio } = await import('./speak-stream.ts')
const { chunkForSystemVoice } = await import('./speech-text.ts')
const { SystemVoiceError, speakWithSystemVoice } = await import('./system-voice.ts')

const sentence = (n: number) => `This is sentence number ${n} of a long reply from Hermes, said by the system voice.`
const REPLY = Array.from({ length: 12 }, (_, i) => sentence(i + 1)).join(' ')
const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

beforeEach(() => {
  edges.rendered.length = 0
  edges.playedAfter.length = 0
  edges.answer = () => ({ ok: true, audio: new Uint8Array([82, 73, 70, 70]), mimeType: 'audio/wav' })
  edges.during = async () => undefined
  edges.refuse = null
  warn.mockClear()
})

afterEach(() => {
  stopFallbackAudio()
})

describe('speakWithSystemVoice', () => {
  it('says a long reply piece by piece, the next one rendering while one plays', async () => {
    const pieces = chunkForSystemVoice(REPLY)
    const audible = vi.fn()

    expect(pieces.length).toBeGreaterThan(2)
    await expect(speakWithSystemVoice(REPLY, playbackTicket(), audible)).resolves.toBe(true)

    expect(edges.rendered).toEqual(pieces)
    expect(edges.playedAfter).toEqual([...pieces.slice(1).map((_, i) => i + 2), pieces.length])
    expect(audible).toHaveBeenCalledTimes(1)
  })

  it('says when this computer has no voice of its own, and renders nothing more', async () => {
    edges.answer = () => ({ ok: false, reason: 'missing', detail: 'espeak-ng, espeak, flite are not installed' })

    const error = await speakWithSystemVoice(REPLY, playbackTicket()).catch(caught => caught)

    expect(error).toBeInstanceOf(SystemVoiceError)
    expect(error).toMatchObject({ reason: 'missing', message: 'espeak-ng, espeak, flite are not installed' })
    expect(edges.rendered).toHaveLength(1)
    expect(edges.playedAfter).toEqual([])
  })

  it('fails when the first piece cannot be rendered or played', async () => {
    edges.answer = () => {
      throw new Error("Error invoking remote method 'herald-os:voice:system-speech': Error: boom")
    }

    await expect(speakWithSystemVoice('Hello.', playbackTicket())).rejects.toMatchObject({ reason: 'failed' })

    edges.answer = () => ({ ok: true, audio: new Uint8Array([82, 73, 70, 70]), mimeType: 'audio/wav' })
    edges.refuse = new Error('NotSupportedError')

    await expect(speakWithSystemVoice('Hello.', playbackTicket())).rejects.toMatchObject({ reason: 'failed', message: 'its audio could not be played: NotSupportedError' })
  })

  it('leaves out a later piece that fails, says so in the log, and carries on', async () => {
    const pieces = chunkForSystemVoice(REPLY)
    edges.answer = text => (text === pieces[1] ? { ok: false, reason: 'failed', detail: 'say exited with 1' } : { ok: true, audio: new Uint8Array([1]), mimeType: 'audio/wav' })

    await expect(speakWithSystemVoice(REPLY, playbackTicket())).resolves.toBe(true)

    expect(edges.playedAfter).toHaveLength(pieces.length - 1)
    expect(warn).toHaveBeenCalledWith('[voice] the system voice left out part of a reply: say exited with 1')
  })

  it('stops after the piece barge-in cut off', async () => {
    edges.during = async index => {
      if (index === 0) {
        stopFallbackAudio()
      }
    }

    await expect(speakWithSystemVoice(REPLY, playbackTicket())).resolves.toBe(true)

    expect(edges.playedAfter).toHaveLength(1)
  })

  it('plays nothing when barge-in came while the first piece was rendering', async () => {
    const audible = vi.fn()
    edges.answer = () => {
      stopFallbackAudio()

      return { ok: true, audio: new Uint8Array([1]), mimeType: 'audio/wav' }
    }

    await expect(speakWithSystemVoice(REPLY, playbackTicket(), audible)).resolves.toBe(false)

    expect(edges.playedAfter).toEqual([])
    expect(audible).not.toHaveBeenCalled()
  })
})
