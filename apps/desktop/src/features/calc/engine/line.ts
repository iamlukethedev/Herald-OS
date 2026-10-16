import { lex, type Token } from './lexer.ts'
import { isOperatorWord, parseContext, type ParseContext } from './parser.ts'
import type { TokenSpan, TokenType } from './types.ts'
import {
  CONSTANT_NAMES,
  CURRENCY_CODES,
  CURRENCY_LETTER_SYMBOLS,
  CURRENCY_NAMES,
  FUNCTION_NAMES,
  KEYWORDS,
  LOWERCASE_CODES,
  NUMBER_WORDS,
  POUND_WORDS,
  findUnit
} from './words.ts'

/*
 * What a line is before anything is worked out: blank, a heading, a comment, a total, a function
 * to draw, or an expression with its label, the name it assigns and its trailing comment; the
 * sentence forms ("what % of 80 is 20", "split 3 ways"); and its tokens for highlighting. Pure and
 * memoized by the line's text, so a note re-reads only the lines that changed.
 */

/** A piece of the line and where it sits. */
export interface Slice {
  text: string
  from: number
  to: number
}

export type LineShape =
  | { kind: 'blank' }
  | { kind: 'heading'; label: string }
  | { kind: 'comment'; label: string }
  | { kind: 'total'; total: 'sum' | 'average'; label?: Slice }
  | { kind: 'function'; name: string; variable: string; body: Slice; label?: Slice }
  | { kind: 'plot'; body: Slice; name?: string; label?: Slice }
  | {
      kind: 'expression'
      body: Slice
      label?: Slice
      /** The name it assigns. */
      name?: Slice
      /** A name that is built in and cannot be assigned. */
      reserved?: string
      /** The right side uses x: a function to draw unless x has a value. */
      usesX?: boolean
    }

export interface LineAnalysis {
  shape: LineShape
  /** Where a trailing "// …" starts. */
  comment?: number
  tokens: TokenSpan[]
}

export type Sentence =
  | { form: 'percentOf'; part: Slice; whole: Slice }
  | { form: 'percentOfWhat'; part: Slice; percent: Slice }
  | { form: 'percentChange'; start: Slice; end: Slice }
  | { form: 'adjust'; base: Slice; percent: Slice; sign: 1 | -1 }
  | { form: 'split'; amount: Slice; ways: Slice }

/** Names that are built in: functions, constants and the words that total or refer back. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(FUNCTION_NAMES),
  ...Object.keys(CONSTANT_NAMES),
  'sum',
  'total',
  'subtotal',
  'average',
  'avg',
  'mean',
  'prev',
  'ans',
  'plot',
  'graph',
  'draw',
  'in',
  'to',
  'of',
  'off',
  'on',
  'as',
  'per',
  'mod',
  'what',
  'is',
  'split'
])

const CACHE_LIMIT = 4000
const cache = new Map<string, LineAnalysis>()

/** The shape and tokens of one line, read in `locale`. */
export function analyzeLine(line: string, locale?: string): LineAnalysis {
  const key = `${locale ?? ''}\u0000${line}`
  const cached = cache.get(key)

  if (cached) {
    return cached
  }

  const analysis = readLine(line, parseContext(locale))

  if (cache.size >= CACHE_LIMIT) {
    cache.delete(cache.keys().next().value as string)
  }

  cache.set(key, analysis)

  return analysis
}

const TOTAL = /^(sum|total|subtotal|grand total|average|avg|mean)(?:\s+(?:of\s+)?(?:the\s+)?(?:above|lines\s+above))?\s*:?$/i
const QUESTION = /^(?:what(?:'s|’s|\s+is)|how\s+much\s+is|calculate|compute|evaluate|work\s+out|convert)\s+/i
const HOW_MANY = /^how\s+many\s+(.+?)\s+(?:are\s+)?in\s+(?:an?\s+|one\s+)?(.+)$/i
const FUNCTION_DEFINITION = /^([\p{L}_][\p{L}\p{N}_]*)\s*\(\s*([\p{L}_][\p{L}\p{N}_]*)\s*\)\s*=\s*(.+)$/u
const ASSIGNMENT = /^([\p{L}_][\p{L}\p{N}_]*(?: [\p{L}_][\p{L}\p{N}_]*){0,3})\s*=(?!=)\s*(.*)$/u
const PLOT = /^(?:plot|graph|draw)\s+(.+)$/i
const PLOT_NAME = /^([\p{L}_][\p{L}\p{N}_]*)\s*(?:\(\s*x\s*\))?\s*=\s*(.+)$/u

function readLine(line: string, context: ParseContext): LineAnalysis {
  if (!line.trim()) {
    return { shape: { kind: 'blank' }, tokens: [] }
  }

  const heading = /^\s*#+\s*(.*)$/.exec(line)

  if (heading) {
    return { shape: { kind: 'heading', label: heading[1].trim() }, tokens: [{ from: 0, to: line.length, type: 'heading' }] }
  }

  const comment = /^\s*\/\/\s*(.*)$/.exec(line)

  if (comment) {
    return { shape: { kind: 'comment', label: comment[1].trim() }, tokens: [{ from: 0, to: line.length, type: 'comment' }] }
  }

  const trailing = /(^|\s)\/\//.exec(line)
  const commentAt = trailing ? trailing.index + trailing[1].length : undefined
  const content = slice(line, 0, commentAt ?? line.length)
  const extras: TokenSpan[] = commentAt === undefined ? [] : [{ from: commentAt, to: line.length, type: 'comment' }]
  let body = content
  let label: Slice | undefined

  const colon = body.text.indexOf(':')

  if (colon > 0) {
    const before = body.text.slice(0, colon)
    const timeLike = /\d$/.test(before) && /^\d/.test(body.text.slice(colon + 1))

    if (/^[\p{L}][^=:]{0,59}$/u.test(before.trim()) && !timeLike) {
      const colonAt = body.from + colon

      label = slice(line, body.from, body.from + before.trimEnd().length)
      body = slice(line, colonAt + 1, body.to)
      extras.push({ from: label.from, to: colonAt + 1, type: 'label' })
    }
  }

  const finish = (shape: LineShape): LineAnalysis => ({ shape, comment: commentAt, tokens: lineTokens(line, shape, extras, context) })

  if (!body.text) {
    const total = label ? TOTAL.exec(label.text) : null

    if (total) {
      return finish({ kind: 'total', total: /^(average|avg|mean)$/i.test(total[1]) ? 'average' : 'sum', label })
    }

    return finish({ kind: 'comment', label: label?.text ?? '' })
  }

  const total = TOTAL.exec(body.text)

  if (total) {
    return finish({ kind: 'total', total: /^(average|avg|mean)$/i.test(total[1]) ? 'average' : 'sum', label })
  }

  const plot = PLOT.exec(body.text)

  if (plot) {
    let rest = slice(line, body.to - plot[1].length, body.to)
    const named = PLOT_NAME.exec(rest.text)
    let name: string | undefined

    if (named) {
      name = named[1]
      rest = slice(line, rest.to - named[2].length, rest.to)
    }

    return finish({ kind: 'plot', body: rest, name, label })
  }

  const definition = FUNCTION_DEFINITION.exec(body.text)

  if (definition && !RESERVED_NAMES.has(definition[1].toLowerCase())) {
    return finish({ kind: 'function', name: definition[1], variable: definition[2], body: slice(line, body.to - definition[3].length, body.to), label })
  }

  const assignment = ASSIGNMENT.exec(body.text)

  if (assignment) {
    const name = slice(line, body.from, body.from + assignment[1].length)
    const rhs = slice(line, body.to - assignment[2].length, body.to)
    const key = nameKey(name.text)

    if (RESERVED_NAMES.has(key)) {
      return finish({ kind: 'expression', body: rhs, label, reserved: name.text })
    }

    return finish({ kind: 'expression', body: question(line, rhs), label, name, usesX: key !== 'x' && mentionsX(rhs.text, context) })
  }

  return finish({ kind: 'expression', body: question(line, body), label })
}

const LABEL_NAME = /^[\p{L}_][\p{L}\p{N}_]*(?: [\p{L}_][\p{L}\p{N}_]*){0,3}$/u

/** The name a label gives its line's value ("Hotel: …" → "Hotel"), unless it is built in or a unit's or currency's word. */
export function labelName(label: string): string | null {
  const text = label.trim().replace(/\s+/g, ' ')

  return LABEL_NAME.test(text) && !RESERVED_NAMES.has(nameKey(text)) && !findUnit(text) && !CURRENCY_NAMES[text.toLowerCase()] ? text : null
}

/** A name as scope keys it: lower case, spaces as underscores ("Monthly rent" → "monthly_rent"). */
export function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '_')
}

/** `line` from `from` to `to`, trimmed, with its new bounds. */
function slice(line: string, from: number, to: number): Slice {
  let start = from
  let end = to

  while (start < end && /\s/u.test(line[start])) {
    start++
  }

  while (end > start && /\s/u.test(line[end - 1])) {
    end--
  }

  return { text: line.slice(start, end), from: start, to: end }
}

/** The body without a question around it: "what is 5 + 3?" reads as "5 + 3"; "how many feet in a mile" as "1 mile in feet". */
function question(line: string, body: Slice): Slice {
  const many = HOW_MANY.exec(body.text)

  if (many) {
    const amount = /^[\d.,]/.test(many[2]) ? many[2] : `1 ${many[2]}`

    return { text: `${amount.replace(/\?+$/, '').trim()} in ${many[1]}`, from: body.from, to: body.to }
  }

  const prefix = QUESTION.exec(body.text)
  const trimmed = slice(line, body.from + (prefix ? prefix[0].length : 0), body.to)
  const end = /[\s?=.]+$/.exec(trimmed.text)

  return end ? slice(line, trimmed.from, trimmed.to - end[0].length) : trimmed
}

function mentionsX(text: string, context: ParseContext): boolean {
  const tokens = lex(text, context.symbols)

  return tokens.some((token, index) => {
    if (token.kind !== 'word' || token.lower !== 'x') {
      return false
    }

    const before = tokens[index - 1]
    const after = tokens[index + 1]
    const times = before && after && (before.kind === 'number' || before.value === ')') && (after.kind === 'number' || after.value === '(')

    return !times
  })
}

const PERCENT = String.raw`(?:%|percent(?:age)?|per\s+cent)`
const PEOPLE = String.raw`(?:\s+(?:people|persons|ways|friends|of\s+us))?`

const SENTENCES: ReadonlyArray<{ pattern: RegExp; build: (groups: Slice[]) => Sentence }> = [
  { pattern: new RegExp(String.raw`^what\s*${PERCENT}\s+of\s+(.+?)\s+is\s+(.+)$`, 'id'), build: ([whole, part]) => ({ form: 'percentOf', part, whole }) },
  { pattern: new RegExp(String.raw`^(.+?)\s+is\s+what\s*${PERCENT}\s+of\s+(.+)$`, 'id'), build: ([part, whole]) => ({ form: 'percentOf', part, whole }) },
  { pattern: new RegExp(String.raw`^(.+?)\s+as\s+(?:an?\s+)?${PERCENT}\s+of\s+(.+)$`, 'id'), build: ([part, whole]) => ({ form: 'percentOf', part, whole }) },
  { pattern: new RegExp(String.raw`^(.+?)\s+out\s+of\s+(.+?)\s+(?:as|in)\s+(?:an?\s+)?${PERCENT}$`, 'id'), build: ([part, whole]) => ({ form: 'percentOf', part, whole }) },
  { pattern: new RegExp(String.raw`^(.+?)\s+is\s+(.+?)\s*${PERCENT}\s+of\s+what$`, 'id'), build: ([part, percent]) => ({ form: 'percentOfWhat', part, percent }) },
  { pattern: new RegExp(String.raw`^(.+?)\s*${PERCENT}\s+of\s+what\s+is\s+(.+)$`, 'id'), build: ([percent, part]) => ({ form: 'percentOfWhat', part, percent }) },
  {
    pattern: new RegExp(String.raw`^${PERCENT}\s+(?:change|increase|decrease|difference)\s+from\s+(.+?)\s+to\s+(.+)$`, 'id'),
    build: ([start, end]) => ({ form: 'percentChange', start, end })
  },
  { pattern: /^change\s+from\s+(.+?)\s+to\s+(.+)$/id, build: ([start, end]) => ({ form: 'percentChange', start, end }) },
  { pattern: new RegExp(String.raw`^(?:from\s+)?(.+?)\s+to\s+(.+?)\s+is\s+what\s*${PERCENT}$`, 'id'), build: ([start, end]) => ({ form: 'percentChange', start, end }) },
  {
    pattern: new RegExp(String.raw`^(.+?)\s+(?:with|after|less)\s+(?:an?\s+)?(.+?)\s*${PERCENT}\s+(?:off|discount)$`, 'id'),
    build: ([base, percent]) => ({ form: 'adjust', base, percent, sign: -1 })
  },
  {
    pattern: new RegExp(String.raw`^(.+?)\s+(?:with|plus|and)\s+(?:an?\s+)?(.+?)\s*${PERCENT}\s+(?:tip|tax|vat|gst|markup|mark-up|interest|service|surcharge|on\s+top)$`, 'id'),
    build: ([base, percent]) => ({ form: 'adjust', base, percent, sign: 1 })
  },
  { pattern: new RegExp(String.raw`^increase\s+(.+?)\s+by\s+(.+?)\s*${PERCENT}$`, 'id'), build: ([base, percent]) => ({ form: 'adjust', base, percent, sign: 1 }) },
  { pattern: new RegExp(String.raw`^decrease\s+(.+?)\s+by\s+(.+?)\s*${PERCENT}$`, 'id'), build: ([base, percent]) => ({ form: 'adjust', base, percent, sign: -1 }) },
  { pattern: new RegExp(String.raw`^(.+?)\s+(?:increased|raised)\s+by\s+(.+?)\s*${PERCENT}$`, 'id'), build: ([base, percent]) => ({ form: 'adjust', base, percent, sign: 1 }) },
  { pattern: new RegExp(String.raw`^(.+?)\s+(?:decreased|reduced|cut)\s+by\s+(.+?)\s*${PERCENT}$`, 'id'), build: ([base, percent]) => ({ form: 'adjust', base, percent, sign: -1 }) },
  { pattern: /^(.+?)\s+split\s+(.+?)\s+ways?$/id, build: ([amount, ways]) => ({ form: 'split', amount, ways }) },
  {
    pattern: new RegExp(String.raw`^(.+?)\s+split\s+(?:between|among|amongst|by|across|into)\s+(.+?)${PEOPLE}$`, 'id'),
    build: ([amount, ways]) => ({ form: 'split', amount, ways })
  },
  {
    pattern: new RegExp(String.raw`^split\s+(.+?)\s+(?:between|among|amongst|by|across|into|in)\s+(.+?)${PEOPLE}$`, 'id'),
    build: ([amount, ways]) => ({ form: 'split', amount, ways })
  },
  { pattern: /^split\s+(.+?)\s+(\S+)\s+ways?$/id, build: ([amount, ways]) => ({ form: 'split', amount, ways }) },
  {
    pattern: new RegExp(String.raw`^(.+?)\s+(?:divided|shared)\s+(?:among|amongst|between|across)\s+(.+?)${PEOPLE}$`, 'id'),
    build: ([amount, ways]) => ({ form: 'split', amount, ways })
  },
  { pattern: /^(.+?)\s+split\s+(.+)$/id, build: ([amount, ways]) => ({ form: 'split', amount, ways }) }
]

/** The sentence form a body is written in, with its parts, or null for a plain expression. */
export function matchSentence(body: Slice): Sentence | null {
  for (const { pattern, build } of SENTENCES) {
    const match = pattern.exec(body.text)

    if (match?.indices) {
      const indices = match.indices
      const groups = match.slice(1).map((text, index) => {
        const [from, to] = indices[index + 1] ?? [0, 0]

        return { text, from: body.from + from, to: body.from + to }
      })

      return build(groups)
    }
  }

  return null
}

function lineTokens(line: string, shape: LineShape, extras: TokenSpan[], context: ParseContext): TokenSpan[] {
  const end = extras.find(extra => extra.type === 'comment')?.from ?? line.length
  const tokens = lex(line.slice(0, end), context.symbols)
  const spans: TokenSpan[] = [...extras]
  const nameSpan = shape.kind === 'expression' && shape.name ? shape.name : undefined

  tokens.forEach((token, index) => {
    if (extras.some(extra => token.from >= extra.from && token.to <= extra.to)) {
      return
    }

    const type = nameSpan && token.from >= nameSpan.from && token.to <= nameSpan.to ? 'variable' : tokenType(token, tokens[index - 1], tokens[index + 1])

    if (type) {
      spans.push({ from: token.from, to: token.to, type })
    }
  })

  return spans.sort((a, b) => a.from - b.from)
}

/** How a token is highlighted, from the token and its neighbours; "in" is a keyword until the line is worked out and its inches are known. */
function tokenType(token: Token, before?: Token, after?: Token): TokenType | null {
  if (token.kind === 'number') {
    return 'number'
  }

  if (token.kind === 'currency') {
    return 'currency'
  }

  if (token.kind === 'symbol') {
    return token.value === '(' || token.value === ')' || token.value === ',' || token.value === ';' ? null : 'operator'
  }

  const word = token.lower ?? ''
  const afterAmount = before?.kind === 'number' || before?.kind === 'currency' || (before?.kind === 'word' && /^(in|into|to|as|per)$/.test(before.lower ?? ''))

  if (word === 'x' && before && after && (before.kind === 'number' || before.value === ')') && after.kind === 'number') {
    return 'operator'
  }

  if (FUNCTION_NAMES[word] && after?.value === '(') {
    return 'function'
  }

  if (CURRENCY_LETTER_SYMBOLS[token.text] || CURRENCY_NAMES[word] || CURRENCY_CODES.has(token.text) || LOWERCASE_CODES.has(token.text)) {
    return 'currency'
  }

  if (word !== 'in' && (findUnit(token.text) || POUND_WORDS.has(word) || /^[cfCF]$/.test(token.text)) && (afterAmount || token.text.length > 2)) {
    return 'unit'
  }

  if (KEYWORDS.has(word) || /^(in|into|to|as)$/.test(word)) {
    return 'keyword'
  }

  if (FUNCTION_NAMES[word] || CONSTANT_NAMES[token.text] || CONSTANT_NAMES[word]) {
    return 'function'
  }

  if (NUMBER_WORDS[word]) {
    return 'number'
  }

  if (isOperatorWord(word)) {
    return 'operator'
  }

  return 'variable'
}
