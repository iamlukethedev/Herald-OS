// Text shaping for speech: strip what a voice cannot read (markdown, code, URLs), cut streaming
// text into sentences so TTS can start before the turn ends, and size chunks for GPT-Live's
// `session.commentary.append` (500-token cap per append). Pure functions, unit-tested in node.

const SENTENCE_END = /([.!?…]+["')\]]*)(\s+|$)/

/** Remove markdown and other unspeakable syntax; returns plain prose. */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' code omitted. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, 'a link')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, ' ')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/^-{3,}\s*$/gm, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** Accumulates streaming text and yields whole sentences as soon as they close. */
export class SentenceChunker {
  private buffer = ''

  get pending(): string {
    return this.buffer
  }

  feed(delta: string): string[] {
    this.buffer += delta
    const out: string[] = []

    // A blank line always closes whatever is buffered (paragraph, list item, heading).
    for (;;) {
      const paragraph = this.buffer.indexOf('\n\n')
      const match = SENTENCE_END.exec(this.buffer)
      const sentenceEnd = match && match[2].length > 0 ? match.index + match[1].length : -1

      if (paragraph === -1 && sentenceEnd === -1) {
        break
      }

      const cut = paragraph !== -1 && (sentenceEnd === -1 || paragraph < sentenceEnd) ? paragraph : sentenceEnd
      const sentence = this.buffer.slice(0, cut).trim()
      this.buffer = this.buffer.slice(cut).replace(/^\s+/, '')

      if (sentence) {
        out.push(sentence)
      }
    }

    return out
  }

  /** Whatever is left, closed or not. */
  flush(): string[] {
    const rest = this.buffer.trim()
    this.buffer = ''

    return rest ? [rest] : []
  }

  reset(): void {
    this.buffer = ''
  }
}

/** ~4 characters per token keeps appends comfortably under the 500-token cap. */
export const COMMENTARY_MAX_CHARS = 1400

/** Split text at sentence boundaries into pieces the live model accepts in one append. */
export function chunkForCommentary(text: string, maxChars = COMMENTARY_MAX_CHARS): string[] {
  const cleaned = sanitizeForSpeech(text)

  if (!cleaned) {
    return []
  }

  if (cleaned.length <= maxChars) {
    return [cleaned]
  }

  const chunker = new SentenceChunker()
  const sentences = [...chunker.feed(cleaned), ...chunker.flush()]
  const out: string[] = []
  let current = ''

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current) {
        out.push(current)
        current = ''
      }

      for (let i = 0; i < sentence.length; i += maxChars) {
        out.push(sentence.slice(i, i + maxChars))
      }

      continue
    }

    if ((current + ' ' + sentence).trim().length > maxChars) {
      out.push(current)
      current = sentence
    } else {
      current = (current + ' ' + sentence).trim()
    }
  }

  if (current) {
    out.push(current)
  }

  return out
}

/** The most of a reply the computer's own voice reads, about five minutes of speech. */
export const SYSTEM_VOICE_MAX_CHARS = 5000

/** A sentence in pieces of at most `maxChars`, cut after a comma, semicolon or colon where one comes late enough, else between words. */
function piecesUpTo(sentence: string, maxChars: number): string[] {
  const out: string[] = []
  let rest = sentence.trim()

  while (rest.length > maxChars) {
    const head = rest.slice(0, maxChars + 1)
    const pause = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '))
    const space = head.lastIndexOf(' ')
    const cut = pause > maxChars / 2 ? pause + 1 : space > maxChars / 2 ? space : maxChars
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }

  return rest ? [...out, rest] : out
}

/**
 * Split a line for the computer's own voice, which renders each piece whole before it plays: a
 * short first piece starts the reply soon, and longer ones after it keep the renders few. Stops
 * before the piece that would pass `SYSTEM_VOICE_MAX_CHARS`.
 */
export function chunkForSystemVoice(text: string, firstMax = 200, restMax = 600): string[] {
  const chunker = new SentenceChunker()
  const sentences = [...chunker.feed(text.trim()), ...chunker.flush()].map(sentence => sentence.replace(/\s+/g, ' '))
  const pieces = sentences.flatMap((sentence, index) => piecesUpTo(sentence, index === 0 ? firstMax : restMax))
  const out: string[] = []
  let current = ''
  let total = 0

  for (const piece of pieces) {
    total += piece.length + 1

    if (total > SYSTEM_VOICE_MAX_CHARS + 1) {
      break
    }

    const joined = current ? `${current} ${piece}` : piece

    if (current && joined.length > (out.length === 0 ? firstMax : restMax)) {
      out.push(current)
      current = piece
    } else {
      current = joined
    }
  }

  return current ? [...out, current] : out
}

/** Default phrases that end a conversation when they are the whole utterance. */
export const DEFAULT_STOP_PHRASES = ['stop', 'stop listening', "that's all", 'that is all', 'thanks hermes', 'thank you hermes', 'goodbye', 'never mind', 'nevermind', 'cancel']

/** True when the utterance is only a stop phrase (punctuation and case ignored). */
export function isStopPhrase(text: string, phrases: readonly string[] = DEFAULT_STOP_PHRASES): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return false
  }

  return phrases.some(phrase => {
    const p = phrase.toLowerCase().trim()

    return normalized === p || normalized === `${p} hermes` || normalized === `hermes ${p}` || normalized === `okay ${p}` || normalized === `ok ${p}`
  })
}

/** Common Whisper hallucinations on silence; treat as no speech. */
const NOISE_TRANSCRIPTS = new Set(['', 'you', 'thank you', 'thanks for watching', 'bye', '.', 'the', 'uh', 'um', 'hmm', 'mm'])

export function isNoiseTranscript(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return NOISE_TRANSCRIPTS.has(normalized) || normalized.length < 2
}
