import type { FieldAttrs, FieldKind } from '../document.ts'

/*
 * Word's field instructions ("PAGE", "DATE \@ "d MMMM yyyy"", "REF _Ref123 \h") as Herald Docs
 * fields and back. Page numbers, page counts, dates and times are fields Herald works out itself;
 * any other field is kept with its instruction and its last result, so Word can update it.
 * Links (HYPERLINK), tables of contents (TOC) and form fields are not fields in Herald Docs.
 */

const KINDS: Readonly<Record<string, FieldKind>> = { PAGE: 'page', NUMPAGES: 'pages', SECTIONPAGES: 'pages', DATE: 'date', TIME: 'time' }

/** The keywords each kind of field can be written with, the first being Herald's own. */
const KEYWORDS: Readonly<Record<Exclude<FieldKind, 'other'>, readonly string[]>> = { page: ['PAGE'], pages: ['NUMPAGES', 'SECTIONPAGES'], date: ['DATE'], time: ['TIME'] }

export const FORM_FIELDS = new Set(['FORMTEXT', 'FORMCHECKBOX', 'FORMDROPDOWN'])

/** Fields that show what is at a bookmark, which Herald Docs does not keep. */
export const CROSS_REFERENCES = new Set(['REF', 'PAGEREF', 'NOTEREF'])

const unquote = (token: string): string => (token.length > 1 && token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1).replace(/\\(["\\])/g, '$1') : token)

/** An instruction's words, switches and arguments, with the quotes taken off arguments. */
export const tokensOf = (instruction: string): string[] => (instruction.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []).map(unquote)

/** A field's keyword in capitals ("PAGE", "TOC"), or '' when it has none. */
export const keywordOf = (instruction: string): string => (/^\s*([^\s\\"]+)/.exec(instruction)?.[1] ?? '').toUpperCase()

/** The argument of a switch such as `\@` or `\o`, or null when the instruction does not have the switch. */
export function switchOf(instruction: string, name: string): string | null {
  const tokens = tokensOf(instruction)
  const index = tokens.findIndex((token) => token.toLowerCase() === `\\${name.toLowerCase()}`)

  return index < 0 ? null : (tokens[index + 1] ?? '')
}

export const hasSwitch = (instruction: string, name: string): boolean => tokensOf(instruction).some((token) => token.toLowerCase() === `\\${name.toLowerCase()}`)

/** A number format (`\* roman`) other than plain numbers, or null. */
export function numberFormatOf(instruction: string): string | null {
  const tokens = tokensOf(instruction)

  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === '\\*' && !/^(mergeformat|charformat|arabic)$/i.test(tokens[i + 1])) {
      return tokens[i + 1]
    }
  }

  return null
}

const quoted = (text: string): string => `"${text.replace(/(["\\])/g, '\\$1')}"`

/** The instruction Herald writes for a field of its own kinds. */
function canonical(kind: Exclude<FieldKind, 'other'>, format: string | null): string {
  const keyword = KEYWORDS[kind][0]

  return (kind === 'date' || kind === 'time') && format ? `${keyword} \\@ ${quoted(format)}` : keyword
}

const plain = (instruction: string): string =>
  instruction
    .replace(/\\\*\s*(mergeformat|charformat)/gi, '')
    .trim()
    .replace(/\s+/g, ' ')

/**
 * A field from its instruction and its last result. A page or date field keeps its instruction only
 * when Herald could not write it the same way from its kind and format.
 */
export function fieldOf(instruction: string, text: string | null): FieldAttrs {
  const kind = KINDS[keywordOf(instruction)] ?? 'other'
  const result = text || null

  if (kind === 'other') {
    return { kind, format: null, instruction: instruction.trim(), text: result }
  }

  const format = kind === 'date' || kind === 'time' ? switchOf(instruction, '@') || null : null

  return { kind, format, instruction: plain(instruction) === canonical(kind, format) ? null : instruction.trim(), text: result }
}

/** The instruction to write for a field: its own when it still says what the field is, else Herald's. */
export function instructionOf(attrs: FieldAttrs): string {
  if (attrs.kind === 'other') {
    return attrs.instruction?.trim() ?? ''
  }

  const own = attrs.instruction?.trim()

  if (own && KEYWORDS[attrs.kind].includes(keywordOf(own)) && (attrs.kind === 'page' || attrs.kind === 'pages' || (switchOf(own, '@') || null) === attrs.format)) {
    return own
  }

  return canonical(attrs.kind, attrs.format)
}
