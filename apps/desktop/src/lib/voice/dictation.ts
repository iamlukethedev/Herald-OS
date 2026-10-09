// Dictation: turn "type how are you question mark and press enter" into the text to type and
// whether to submit it. Pure, unit-tested; used by the voice matcher and the `text.type` command.

const SPOKEN_PUNCTUATION: Array<[RegExp, string]> = [
  [/\s*\b(question mark)\b/gi, '?'],
  [/\s*\b(exclamation (mark|point))\b/gi, '!'],
  [/\s*\b(full stop|period)\b/gi, '.'],
  [/\s*\bcomma\b/gi, ','],
  [/\s*\bcolon\b/gi, ':'],
  [/\s*\bsemicolon\b/gi, ';'],
  [/\s*\b(new line|newline|next line)\b\s*/gi, '\n'],
  [/\s*\b(new paragraph)\b\s*/gi, '\n\n']
]

const SUBMIT_SUFFIX = /[,.\s]*\b(?:and |then )*(?:press|hit) (?:enter|return)\b[.!]?$|[,.\s]*\band (?:send|submit) it\b[.!]?$|[,.\s]*\band send\b[.!]?$/i

/** Leading verbs that mean "type the rest"; the capture group is the text. */
const DICTATION = /^(?:please\s+)?(?:type|dictate|write down|enter the text|type in|type out)\s*[:,]?\s+(?:the (?:text|words?)\s+)?([\s\S]+)$/i

export interface Dictation {
  text: string
  submit: boolean
}

/** Replace spoken punctuation words ("comma", "question mark") with the characters. */
export function applySpokenPunctuation(text: string): string {
  let out = text

  for (const [pattern, replacement] of SPOKEN_PUNCTUATION) {
    out = out.replace(pattern, replacement)
  }

  return out.replace(/[ \t]+([?!.,:;])/g, '$1')
}

/** Split off "and press enter" / "and send it" and clean the text the user wants typed. */
export function parseDictationText(raw: string): Dictation {
  let text = raw.trim()
  const submit = SUBMIT_SUFFIX.test(text)

  if (submit) {
    text = text.replace(SUBMIT_SUFFIX, '')
  }

  // Strip quotes the transcriber sometimes adds around dictated text.
  text = text.replace(/^["“'‘]+|["”'’]+$/g, '').trim()
  text = applySpokenPunctuation(text)
  // Transcribers end most utterances with a period the user did not dictate; keep ? and !.
  text = text.replace(/(?<![.])\.$/, '')

  return { text, submit }
}

/** Consecutive dictations read as one sentence: the space the person did not say, when the caret follows a word. */
export function withLeadingSpace(before: string | null, text: string): string {
  return before && !/\s/.test(before) && /^[\p{L}\p{N}"'(]/u.test(text) ? ` ${text}` : text
}

/** The raw words after "type …" (original casing and punctuation), or null when not a dictation. */
export function dictationRemainder(utterance: string): string | null {
  const match = DICTATION.exec(utterance.trim())

  return match ? match[1].trim() || null : null
}

/** When the utterance is a dictation ("type …"), the text to type; null otherwise. */
export function matchDictation(utterance: string): Dictation | null {
  const raw = dictationRemainder(utterance)

  if (!raw) {
    return null
  }

  const dictation = parseDictationText(raw)

  return dictation.text || dictation.submit ? dictation : null
}
