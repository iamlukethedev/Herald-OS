import { countCharacters, countWords, type DocNode, round, walk } from '../../../../shared/office/document.ts'

/*
 * Document statistics, a writing aid that only counts: words, characters, paragraphs and
 * sentences, how long the text takes to read and to say, and how easy it is to read. They cover
 * the body text, not notes, comments, headers or footers, and words are counted as the status bar
 * counts them. Readability is Flesch's reading ease and the Flesch-Kincaid grade over an English
 * syllable count taken from spelling, so it suits English text; code blocks are left out of it.
 */

/** Silent reading in words a minute: about what adults read non-fiction at. */
export const READING_SPEED = 238

/** Reading aloud in words a minute: an unhurried talk. */
export const SPEAKING_SPEED = 140

export interface Readability {
  /** Flesch reading ease, from 0 (very hard) to 100 (very easy). */
  score: number
  /** What the score means, in plain words: "Fairly easy". */
  label: string
  /** The Flesch-Kincaid grade: the years of (US) schooling the text asks for. */
  grade: number
}

export interface DocumentStatistics {
  words: number
  /** Characters with spaces; line ends are not counted. */
  characters: number
  charactersNoSpaces: number
  /** Paragraphs with text in them: headings, list items and cells too. */
  paragraphs: number
  sentences: number
  /** Words per sentence on average; 0 without sentences. */
  wordsPerSentence: number
  syllables: number
  /** Minutes the text takes to read, at about 238 words a minute. */
  readingMinutes: number
  /** Minutes it takes to read aloud, at about 140 words a minute. */
  speakingMinutes: number
  /** Null when there are no sentences to score. */
  readability: Readability | null
  /** The page count, when the caller knows it. */
  pages?: number
}

export interface StatisticsOptions {
  /** How many pages the document fills, where it is laid out. */
  pages?: number | null
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu

const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'codeBlock'])

/** A block's own text: its runs, with line breaks as new lines; fields, notes and pictures add none. */
const blockText = (node: DocNode): string => (node.content ?? []).map((child) => (child.type === 'text' ? (child.text ?? '') : child.type === 'hardBreak' ? '\n' : '')).join('')

/** The paragraphs, headings and code blocks of the body, in order, with their text. */
export function bodyBlocks(doc: DocNode): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = []

  walk(doc, (node) => {
    if (TEXT_BLOCKS.has(node.type)) {
      out.push({ code: node.type === 'codeBlock', text: blockText(node) })

      return false
    }
  })

  return out
}

/**
 * Syllables in an English word, from its spelling: groups of vowels, less the endings that add
 * none ("make", "liked", "notes"), plus vowels said apart ("radio", "curious", "actual").
 */
export function countSyllables(word: string): number {
  let w = word.normalize('NFD').toLowerCase().replace(/[^a-z]/g, '')

  if (!w) {
    return /\p{N}/u.test(word) ? 1 : 0
  }

  if (w.length <= 3) {
    return 1
  }

  let count = /[^aeioun]n['’]t$/i.test(word) ? 1 : 0

  // A silent final e, and -ed and -es that add nothing; -le after a consonant is a syllable ("table").
  if (!/[^aeiouy]les?$/.test(w)) {
    w = w.replace(/(?:[^aeioutd]ed|[^aeiouysxzcgh]es|[^aeiouy]e)$/, (ending) => ending[0])
  }

  // A y before a vowel is a consonant: "year", "beyond", "player".
  w = w.replace(/^y(?=[aeiou])/, '').replace(/([aeiou])y(?=[aeiou])/g, '$1-')
  count += (w.match(/[aeiouy]+/g) ?? []).length
  count += (w.match(/[^tscxgh]io(?!u)|[^tcxg]iou|[^cts]ia|iu|[^gq]ua|[^q]uo|eo/g) ?? []).length
  count -= (w.match(/peo|[gc]eo[nu]/g) ?? []).length
  count -= /[^aeiouyl]e(?:ly|ful|fully|ness|less|ment)$/.test(w) ? 1 : 0
  count += /ism$/.test(w) ? 1 : 0

  return Math.max(1, count)
}

/** Titles that come before a name with a full stop, so the stop ends no sentence. */
const TITLES = new Set(['mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'rev', 'hon', 'st', 'mt', 'sr', 'jr', 'fr', 'gen', 'capt', 'lt', 'col', 'sgt', 'vs'])

/** Abbreviations that come before a number: "No. 5", "Fig. 2", "pp. 10". */
const NUMBERED = new Set(['no', 'nos', 'fig', 'figs', 'vol', 'p', 'pp', 'ch', 'sec', 'art'])

const OPENING = /^[(["'‘“«]+/u

/**
 * Sentences in one block of text: those ending in . ! ? or …, and words after the last end. A full
 * stop after a title, an initial or an abbreviation, or before a word in lower case, ends none.
 */
export function countSentences(text: string): number {
  const tokens = text.split(/\s+/).filter(Boolean)
  let count = 0
  let open = false

  tokens.forEach((token, index) => {
    if (/[\p{L}\p{N}]/u.test(token)) {
      open = true
    }

    if (!open || !/[.!?…][)\]"'’”»]*$/u.test(token)) {
      return
    }

    const next = (tokens[index + 1] ?? '').replace(OPENING, '')
    const bare = token.replace(OPENING, '').replace(/[)\]"'’”».!?…]+$/u, '').replace(/\./g, '').toLowerCase()
    const stop = /[.…][)\]"'’”»]*$/u.test(token)

    if (stop && (/^\p{Ll}/u.test(next) || TITLES.has(bare) || /^\p{L}$/u.test(bare) || (NUMBERED.has(bare) && /^\p{N}/u.test(next)))) {
      return
    }

    count++
    open = false
  })

  return count + (open ? 1 : 0)
}

const syllablesIn = (text: string): number => (text.match(WORD) ?? []).reduce((sum, word) => sum + word.split(/[-_]+/).reduce((parts, part) => parts + (part ? countSyllables(part) : 0), 0), 0)

const BANDS: readonly [number, string][] = [
  [90, 'Very easy'],
  [80, 'Easy'],
  [70, 'Fairly easy'],
  [60, 'Plain English'],
  [50, 'Fairly difficult'],
  [30, 'Difficult'],
  [0, 'Very difficult']
]

/** What a Flesch reading-ease score means, in plain words. */
export const readabilityLabel = (score: number): string => (BANDS.find(([floor]) => score >= floor) ?? BANDS[BANDS.length - 1])[1]

/** Flesch reading ease (kept between 0 and 100) and the Flesch-Kincaid grade (not below 0). */
export function readabilityOf(words: number, sentences: number, syllables: number): Readability | null {
  if (!words || !sentences) {
    return null
  }

  const perSentence = words / sentences
  const perWord = syllables / words
  const score = round(Math.min(100, Math.max(0, 206.835 - 1.015 * perSentence - 84.6 * perWord)), 1)

  return { score, label: readabilityLabel(score), grade: round(Math.max(0, 0.39 * perSentence + 11.8 * perWord - 15.59), 1) }
}

/** The statistics of a document's body (or of a selection's, as a document of its own). */
export function documentStatistics(doc: DocNode, options: StatisticsOptions = {}): DocumentStatistics {
  const blocks = bodyBlocks(doc)
  const text = blocks.map((block) => block.text).join('\n')
  const prose = blocks.filter((block) => !block.code).map((block) => block.text)
  const words = countWords(text)
  const proseWords = countWords(prose.join('\n'))
  const sentences = prose.reduce((sum, block) => sum + countSentences(block), 0)
  const syllables = syllablesIn(prose.join('\n'))
  const pages = options.pages

  return {
    words,
    characters: countCharacters(text),
    charactersNoSpaces: [...text].filter((char) => !/\s/u.test(char)).length,
    paragraphs: blocks.filter((block) => /\S/u.test(block.text)).length,
    sentences,
    wordsPerSentence: sentences ? round(proseWords / sentences, 1) : 0,
    syllables,
    readingMinutes: round(words / READING_SPEED, 2),
    speakingMinutes: round(words / SPEAKING_SPEED, 2),
    readability: readabilityOf(proseWords, sentences, syllables),
    ...(typeof pages === 'number' && Number.isFinite(pages) && pages > 0 ? { pages: Math.round(pages) } : {})
  }
}

/** A time in minutes as people say it: "Under a minute", "About 4 minutes", "About 1 hour 5 minutes". */
export function durationLabel(minutes: number): string {
  if (minutes < 1) {
    return 'Under a minute'
  }

  const total = Math.round(minutes)
  const unit = (count: number, word: string) => (count ? `${count} ${word}${count === 1 ? '' : 's'}` : '')

  return `About ${[unit(Math.floor(total / 60), 'hour'), unit(total % 60, 'minute')].filter(Boolean).join(' ')}`
}
