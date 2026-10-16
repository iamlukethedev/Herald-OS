import { describe, expect, it } from 'vitest'
import { chunkForCommentary, chunkForSystemVoice, COMMENTARY_MAX_CHARS, isNoiseTranscript, isStopPhrase, sanitizeForSpeech, SentenceChunker, SYSTEM_VOICE_MAX_CHARS } from './speech-text.ts'

describe('sanitizeForSpeech', () => {
  it('strips markdown, code and links', () => {
    const text = '## Result\n\nI found **three** files:\n- `a.txt`\n- [docs](https://example.com/x)\n\n```js\nconsole.log(1)\n```\nDone.'
    const spoken = sanitizeForSpeech(text)
    expect(spoken).not.toContain('#')
    expect(spoken).not.toContain('**')
    expect(spoken).not.toContain('console.log')
    expect(spoken).not.toContain('https://')
    expect(spoken).toContain('three files')
    expect(spoken).toContain('docs')
    expect(spoken).toContain('Done.')
  })

  it('drops thinking blocks', () => {
    expect(sanitizeForSpeech('<think>secret</think>Hello there.')).toBe('Hello there.')
  })
})

describe('SentenceChunker', () => {
  it('yields sentences as they close and keeps the tail', () => {
    const chunker = new SentenceChunker()
    expect(chunker.feed('Hello there. How are')).toEqual(['Hello there.'])
    expect(chunker.pending).toBe('How are')
    expect(chunker.feed(' you today? Fine')).toEqual(['How are you today?'])
    expect(chunker.flush()).toEqual(['Fine'])
    expect(chunker.pending).toBe('')
  })

  it('does not cut on a period without following whitespace (decimals, versions)', () => {
    const chunker = new SentenceChunker()
    expect(chunker.feed('Version 0.21.3 is out')).toEqual([])
    expect(chunker.feed('. ')).toEqual(['Version 0.21.3 is out.'])
  })

  it('treats a blank line as a boundary', () => {
    const chunker = new SentenceChunker()
    expect(chunker.feed('First item\n\nSecond')).toEqual(['First item'])
    expect(chunker.flush()).toEqual(['Second'])
  })
})

describe('chunkForCommentary', () => {
  it('returns one chunk for short text', () => {
    expect(chunkForCommentary('Short **answer**.')).toEqual(['Short answer.'])
  })

  it('splits long text at sentence boundaries under the cap', () => {
    const sentence = 'This is a fairly long sentence that keeps going for a while. '
    const chunks = chunkForCommentary(sentence.repeat(60))
    expect(chunks.length).toBeGreaterThan(1)

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(COMMENTARY_MAX_CHARS)
      expect(chunk.endsWith('.')).toBe(true)
    }
  })

  it('hard-splits a single oversized sentence', () => {
    const chunks = chunkForCommentary('x'.repeat(COMMENTARY_MAX_CHARS * 2 + 10))
    expect(chunks.length).toBe(3)
  })

  it('returns nothing for empty input', () => {
    expect(chunkForCommentary('   ')).toEqual([])
  })
})

describe('chunkForSystemVoice', () => {
  it('keeps a short line whole', () => {
    expect(chunkForSystemVoice('Hello. This is Hermes, speaking from Herald OS.')).toEqual(['Hello. This is Hermes, speaking from Herald OS.'])
    expect(chunkForSystemVoice('  ')).toEqual([])
  })

  it('starts with a short piece, then groups whole sentences into longer ones', () => {
    const sentence = (n: number) => `This is sentence number ${n} of a long reply from Hermes, said by the system voice.`
    const reply = Array.from({ length: 20 }, (_, i) => sentence(i + 1)).join(' ')
    const pieces = chunkForSystemVoice(reply)

    expect(pieces[0]).toBe(`${sentence(1)} ${sentence(2)}`)
    expect(pieces[0].length).toBeLessThanOrEqual(200)
    expect(pieces.slice(1).every(piece => piece.length <= 600 && piece.length > 200)).toBe(true)
    expect(pieces.join(' ')).toBe(reply)
  })

  it('cuts a long first sentence after a comma, so speech starts soon', () => {
    const first = `${'Hermes looked through every folder in your Documents and Downloads, '.repeat(3)}and found nothing.`
    const pieces = chunkForSystemVoice(`${first} Done.`)

    expect(pieces[0].length).toBeLessThanOrEqual(200)
    expect(pieces[0].endsWith(',')).toBe(true)
    expect(pieces.join(' ')).toBe(`${first} Done.`)
  })

  it('cuts a sentence with no pauses between words', () => {
    const words = 'word '.repeat(300).trim()
    const pieces = chunkForSystemVoice(words)

    expect(pieces.every(piece => piece.length <= 600 && !piece.startsWith(' ') && !piece.endsWith(' '))).toBe(true)
    expect(pieces.join(' ')).toBe(words)
  })

  it('stops at about five minutes of speech', () => {
    const reply = 'Here is one more sentence of a very long answer. '.repeat(400)
    const total = chunkForSystemVoice(reply).join(' ').length

    expect(total).toBeLessThanOrEqual(SYSTEM_VOICE_MAX_CHARS)
    expect(total).toBeGreaterThan(SYSTEM_VOICE_MAX_CHARS - 100)
  })
})

describe('isStopPhrase', () => {
  it('matches whole-utterance stop commands regardless of case and punctuation', () => {
    expect(isStopPhrase('Stop.')).toBe(true)
    expect(isStopPhrase("That's all, Hermes")).toBe(true)
    expect(isStopPhrase('okay stop')).toBe(true)
  })

  it('does not match stop words inside a request', () => {
    expect(isStopPhrase('stop the dev server on port 3000')).toBe(false)
    expect(isStopPhrase('')).toBe(false)
  })
})

describe('isNoiseTranscript', () => {
  it('flags whisper hallucinations on silence', () => {
    expect(isNoiseTranscript('Thank you.')).toBe(true)
    expect(isNoiseTranscript('you')).toBe(true)
    expect(isNoiseTranscript('Open Safari')).toBe(false)
  })
})
