import { quoteSheet } from '../address.ts'

/*
 * Sheet names in the formulas of the parts Herald keeps (charts, sparklines, pivot caches, defined
 * names): a renamed sheet's new name is written in, and a formula naming a sheet that is gone is
 * found, since it no longer points at anything. References to other workbooks ([1]Sheet1!A1) stay
 * as they are.
 */

const NAME = /[A-Za-z_\\\u00C0-\uFFFF][\w.\u00C0-\uFFFF]*/y
const ERROR = /#[A-Za-z0-9/]+[!?]?/y
const EXTERNAL_SHEET = /[^\s!'"(),;=<>&+\-*/^{}[\]]+!/y

/** Where a literal opening at `start` ends, after its closing quote (doubled quotes stay inside it). */
function quotedEnd(formula: string, start: number): number {
  const quote = formula[start]
  let at = start + 1

  while (at < formula.length) {
    if (formula[at] === quote && formula[at + 1] === quote) {
      at += 2
    } else if (formula[at] === quote) {
      return at + 1
    } else {
      at++
    }
  }

  return at
}

/** Where a bracketed part (a structured reference, possibly nested, or a workbook's index) ends. */
function bracketEnd(formula: string, start: number): number {
  let depth = 0

  for (let at = start; at < formula.length; at++) {
    depth += formula[at] === '[' ? 1 : formula[at] === ']' ? -1 : 0

    if (depth === 0) {
      return at + 1
    }
  }

  return formula.length
}

const match = (pattern: RegExp, text: string, at: number): string | undefined => {
  pattern.lastIndex = at

  return pattern.exec(text)?.[0]
}

/** Sheet names as a formula writes them before "!": one name, or two for a range of sheets, quoted when one needs it. */
function sheetPrefix(names: string[]): string {
  return names.every((name) => quoteSheet(name) === name) ? names.join(':') : `'${names.join(':').replace(/'/g, "''")}'`
}

/** A formula with each sheet name it uses passed through `change`; null when `change` has no sheet for one of them. */
export function renameSheetsIn(formula: string, change: (name: string) => string | null): string | null {
  let out = ''
  let at = 0
  const sheets = (names: string[]): string | null => {
    const now = names.map(change)

    return now.every((name): name is string => name !== null) ? sheetPrefix(now) : null
  }

  while (at < formula.length) {
    const char = formula[at]

    if (char === '"') {
      const end = quotedEnd(formula, at)
      out += formula.slice(at, end)
      at = end
      continue
    }

    if (char === "'") {
      const end = quotedEnd(formula, at)
      const inner = formula.slice(at + 1, end - 1).replace(/''/g, "'")

      // A sheet name holds none of [ ] \ /: a quoted name with them is another workbook's.
      if (formula[end] === '!' && !/[[\]\\/]/.test(inner)) {
        const renamed = sheets(inner.split(':'))

        if (renamed === null) {
          return null
        }

        out += renamed
      } else {
        out += formula.slice(at, end)
      }

      at = end
      continue
    }

    if (char === '[') {
      let end = bracketEnd(formula, at)
      end += match(EXTERNAL_SHEET, formula, end)?.length ?? 0
      out += formula.slice(at, end)
      at = end
      continue
    }

    const error = char === '#' ? match(ERROR, formula, at) : undefined

    if (error) {
      out += error
      at += error.length
      continue
    }

    const name = match(NAME, formula, at)

    if (!name) {
      out += char
      at++
      continue
    }

    const second = formula[at + name.length] === ':' ? match(NAME, formula, at + name.length + 1) : undefined
    const names = second && formula[at + name.length + 1 + second.length] === '!' ? [name, second] : formula[at + name.length] === '!' ? [name] : null

    if (!names) {
      out += name
      at += name.length
      continue
    }

    const renamed = sheets(names)

    if (renamed === null) {
      return null
    }

    out += renamed
    at += names.join(':').length
  }

  return out
}

/** The sheets of the written workbook by the names the source file gave them. */
export class SheetNames {
  private readonly renamed = new Map<string, string>()
  private readonly present = new Set<string>()

  /** `kept`: each sheet of the source that is still there, with its name then and now; `present`: every sheet name of the written workbook. */
  constructor(kept: { from: string; to: string }[], present: string[]) {
    kept.forEach(({ from, to }) => this.renamed.set(from.toLowerCase(), to))
    present.forEach((name) => this.present.add(name.toLowerCase()))
  }

  /** A sheet name of the source as it is now; null when no sheet has it any more. A workbook's file name ("Book.xlsx") stays. */
  readonly sheet = (name: string): string | null => this.renamed.get(name.toLowerCase()) ?? (this.present.has(name.toLowerCase()) || /\.xl\w{1,2}$/i.test(name) ? name : null)

  /** A source sheet that is still there, by its name then: its name now; null when it is gone. */
  readonly kept = (name: string): string | null => this.renamed.get(name.toLowerCase()) ?? null

  /** A formula of the source with its sheet names as they are now; null when it names a sheet that is gone. */
  formula(text: string): string | null {
    return renameSheetsIn(text, this.sheet)
  }
}
