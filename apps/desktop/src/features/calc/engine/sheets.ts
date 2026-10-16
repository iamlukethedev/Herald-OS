import { currencyMinor, unitDisplay } from './format.ts'
import { analyzeLine, matchSentence, nameKey, type Sentence, type Slice } from './line.ts'
import { lex } from './lexer.ts'
import { parseContext, parseTokens, type Node, type ParseContext } from './parser.ts'
import type { CalcValue, DocumentResult, LineResult } from './types.ts'

/*
 * A note as spreadsheet rows for Copy to Sheets: line N is row N, the value or formula in column A
 * and its label in column B.
 */

export interface SheetRow {
  /** A number, text, or a formula starting with "=" (English function names, commas between arguments); null leaves the cell empty. */
  value: number | string | null
  /** Column B: the line's label, the name it assigns, a comment's or heading's text. */
  label: string
  /** A number format for column A when the value needs one: "#,##0.00", "0.00%", "[$$]#,##0.00", "yyyy-mm-dd". */
  format?: string
  /** A heading: the row is bold. */
  heading?: boolean
}

/** Formulas where a line maps cleanly onto Sheets (arithmetic, percentages, splits, sums of the lines above, names used later as A-cells), values otherwise. */
export function toSheetRows(document: DocumentResult): SheetRow[] {
  const builder = new SheetBuilder(document)

  return document.lines.map(line => builder.row(line))
}

/** The sign a currency is written with in the locale ("$", "US$", "R$", "€"), so a column of money stays narrow. */
function currencySymbol(code: string, locale: string | undefined): string {
  try {
    const sign = new Intl.NumberFormat(locale ?? 'en-US', { style: 'currency', currency: code, currencyDisplay: 'symbol' }).formatToParts(1).find(part => part.type === 'currency')?.value

    return sign && !/[\]"]/.test(sign) ? sign : code
  } catch {
    return code
  }
}

/** A cell's formula text, how tightly it binds (1 sum … 5 atom), and whether it is a percentage. */
interface Formula {
  text: string
  level: number
  percent?: boolean
}

interface Cell {
  row: number
  kind: CalcValue['kind']
  code?: string
}

const FUNCTIONS: Readonly<Record<string, string>> = {
  sqrt: 'SQRT',
  abs: 'ABS',
  trunc: 'TRUNC',
  sign: 'SIGN',
  min: 'MIN',
  max: 'MAX',
  ln: 'LN',
  log10: 'LOG10',
  exp: 'EXP',
  sin: 'SIN',
  cos: 'COS',
  tan: 'TAN',
  asin: 'ASIN',
  acos: 'ACOS',
  atan: 'ATAN',
  sinh: 'SINH',
  cosh: 'COSH',
  tanh: 'TANH',
  asinh: 'ASINH',
  acosh: 'ACOSH',
  atanh: 'ATANH',
  gcd: 'GCD',
  lcm: 'LCM',
  factorial: 'FACT',
  combinations: 'COMBIN',
  permutations: 'PERMUT',
  sum: 'SUM',
  mean: 'AVERAGE',
  median: 'MEDIAN',
  mod: 'MOD'
}

class SheetBuilder {
  private readonly document: DocumentResult
  private readonly context: ParseContext
  private readonly names = new Map<string, Cell>()
  private readonly phrases: string[] = []
  private previous: Cell | null = null
  private blockStart = 1
  /** The currency a formula's money must all be in; null when it uses none yet. */
  private code: string | null = null

  constructor(document: DocumentResult) {
    this.document = document
    this.context = parseContext(document.locale)
  }

  row(line: LineResult): SheetRow {
    const row = line.index + 1

    switch (line.kind) {
      case 'blank':
        this.blockStart = row + 1

        return { value: null, label: '' }
      case 'heading':
        this.blockStart = row + 1

        return { value: null, label: line.label ?? line.source.trim(), heading: true }
      case 'comment':
        return { value: null, label: line.label ?? line.source.trim() }
      case 'value':
        return line.value ? this.valueRow(line, line.value, row) : { value: null, label: line.source.trim() }
      default:
        return { value: null, label: line.source.trim() }
    }
  }

  private valueRow(line: LineResult, value: CalcValue, row: number): SheetRow {
    const label = line.label ?? line.name ?? this.lineText(line.source)
    let result: SheetRow

    switch (value.kind) {
      case 'duration':
        result = { value: value.number, label: `${label} (${value.unit ?? 'day'}${value.number === 1 ? '' : 's'})` }
        break
      case 'unit':
        result = { value: value.number, label: `${label} (${unitDisplay(value.unit ?? '').symbol})` }
        break
      case 'percent': {
        const formula = this.formula(line, value, row)

        result = { value: formula ?? value.number / 100, label, format: '0.00%' }
        break
      }
      case 'currency': {
        const formula = this.formula(line, value, row)
        const code = value.unit ?? 'USD'
        const minor = currencyMinor(code, this.document.locale)

        result = { value: formula ?? value.number, label, format: `[$${currencySymbol(code, this.document.locale)}]#,##0${minor ? `.${'0'.repeat(minor)}` : ''}` }
        break
      }
      case 'number':
        result = { value: this.formula(line, value, row) ?? value.number, label }
        break
      default:
        result = { value: line.display ?? value.exact, label }
    }

    const cell: Cell = { row, kind: value.kind, code: value.kind === 'currency' ? value.unit : undefined }

    if (line.name) {
      const spaced = line.name.trim().toLowerCase().replace(/\s+/g, ' ')

      this.names.set(nameKey(line.name), cell)

      if (spaced.includes(' ') && !this.phrases.includes(spaced)) {
        this.phrases.push(spaced)
        this.phrases.sort((a, b) => b.length - a.length)
      }
    }

    this.previous = cell

    return result
  }

  /** What a line without a label is called: its trailing comment, else its text without one. */
  private lineText(source: string): string {
    const { comment } = analyzeLine(source, this.document.locale)

    if (comment === undefined) {
      return source.trim()
    }

    return source.slice(comment).replace(/^\/\/\s*/, '').trim() || source.slice(0, comment).trim()
  }

  /** The line as a formula, or null when it is a plain value or does not map cleanly. */
  private formula(line: LineResult, value: CalcValue, row: number): string | null {
    if (line.usesRates) {
      return null
    }

    this.code = value.kind === 'currency' ? (value.unit ?? null) : null

    const { shape } = analyzeLine(this.withNames(line.source), this.document.locale)

    if (shape.kind === 'total') {
      return this.total(shape.total, row, value)
    }

    if (shape.kind !== 'expression' || !shape.body.text) {
      return null
    }

    const sentence = matchSentence(shape.body)

    if (sentence) {
      return this.sentence(sentence)
    }

    const node = this.parse(shape.body)

    if (!node || isLiteral(node)) {
      return null
    }

    const formula = node && this.toFormula(node)

    return formula ? `=${formula.text}` : null
  }

  private withNames(source: string): string {
    if (!this.phrases.length) {
      return source
    }

    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${this.phrases.map(phrase => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s')).join('|')})(?![\\p{L}\\p{N}_])`, 'giu')

    return source.replace(pattern, match => match.replace(/\s/g, '_'))
  }

  private total(kind: 'sum' | 'average', row: number, value: CalcValue): string | null {
    const lines = this.document.lines.filter(line => line.index + 1 >= this.blockStart && line.index + 1 < row && line.kind === 'value')

    if (!lines.length) {
      return null
    }

    const fits = lines.every(line => {
      const kind = line.value?.kind

      return (value.kind === 'currency' && kind === 'currency' && line.value?.unit === value.unit) || (kind === 'number' && !line.usesRates)
    })

    return fits ? `=${kind === 'sum' ? 'SUM' : 'AVERAGE'}(A${this.blockStart}:A${row - 1})` : null
  }

  private sentence(sentence: Sentence): string | null {
    const part = (slice: Slice): Formula | null => {
      const node = this.parse(slice)

      return node ? this.toFormula(node) : null
    }

    switch (sentence.form) {
      case 'percentOf': {
        const piece = part(sentence.part)
        const whole = part(sentence.whole)

        return piece && whole ? `=${wrap(piece, 2)}/${wrap(whole, 3)}` : null
      }
      case 'percentOfWhat': {
        const piece = part(sentence.part)
        const rate = part(sentence.percent)

        return piece && rate ? `=${wrap(piece, 2)}/${percentText(rate)}` : null
      }
      case 'percentChange': {
        const start = part(sentence.start)
        const end = part(sentence.end)

        return start && end ? `=(${end.text}-${wrap(start, 2)})/${wrap(start, 3)}` : null
      }
      case 'adjust': {
        const base = part(sentence.base)
        const rate = part(sentence.percent)

        return base && rate ? `=${wrap(base, 2)}*(1${sentence.sign > 0 ? '+' : '-'}${percentText(rate)})` : null
      }
      case 'split': {
        const amount = part(sentence.amount)
        const ways = part(sentence.ways)

        return amount && ways ? `=${wrap(amount, 2)}/${wrap(ways, 3)}` : null
      }
    }
  }

  private parse(slice: Slice): Node | null {
    try {
      return parseTokens(lex(slice.text, this.context.symbols), this.context)
    } catch {
      return null
    }
  }

  private toFormula(node: Node): Formula | null {
    switch (node.type) {
      case 'number':
        return { text: node.value, level: 5 }
      case 'group': {
        const inner = this.toFormula(node.value)

        return inner && { ...inner, text: `(${inner.text})`, level: 5 }
      }
      case 'name':
        return this.reference(node.key)
      case 'money': {
        if (this.code !== null && node.code !== this.code) {
          return null
        }

        this.code = node.code

        return this.toFormula(node.value)
      }
      case 'percent': {
        const inner = this.toFormula(node.value)

        return inner && { text: `${wrap(inner, 5)}%`, level: 5, percent: true }
      }
      case 'negate': {
        const inner = this.toFormula(node.value)

        return inner && { text: `-${wrap(inner, 4)}`, level: 3, percent: inner.percent }
      }
      case 'factorial': {
        const inner = this.toFormula(node.value)

        return inner && { text: `FACT(${inner.text})`, level: 5 }
      }
      case 'call':
        return this.call(node)
      case 'binary':
        return this.binary(node)
      default:
        return null
    }
  }

  private reference(key: string): Formula | null {
    const constants: Readonly<Record<string, string>> = { pi: 'PI()', e: 'EXP(1)', tau: '(2*PI())', phi: '((1+SQRT(5))/2)' }

    if (constants[key]) {
      return { text: constants[key], level: 5 }
    }

    const cell = key === 'prev' || key === 'ans' ? this.previous : this.names.get(key)

    if (!cell || (cell.kind !== 'number' && cell.kind !== 'percent' && cell.kind !== 'currency')) {
      return null
    }

    if (cell.kind === 'currency') {
      if (this.code !== null && cell.code !== this.code) {
        return null
      }

      this.code = cell.code ?? null
    }

    return { text: `A${cell.row}`, level: 5, percent: cell.kind === 'percent' }
  }

  private call(node: Extract<Node, { type: 'call' }>): Formula | null {
    const args: Formula[] = []

    for (const arg of node.args) {
      const inner = node.fn.match(/^(sin|cos|tan)$/) && arg.type === 'quantity' && arg.unit.unit === 'deg' ? this.degrees(arg) : this.toFormula(arg)

      if (!inner) {
        return null
      }

      args.push(inner)
    }

    const list = args.map(arg => arg.text).join(',')
    const [first, second] = args

    switch (node.fn) {
      case 'log':
        return { text: second ? `LOG(${list})` : `LOG10(${list})`, level: 5 }
      case 'log2':
        return { text: `LOG(${first.text},2)`, level: 5 }
      case 'round':
        return { text: `ROUND(${first.text},${second?.text ?? 0})`, level: 5 }
      case 'floor':
        return { text: `INT(${first.text})`, level: 5 }
      case 'ceil':
        return { text: `-INT(-${wrap(first, 4)})`, level: 3 }
      case 'cbrt':
        return { text: `POWER(${first.text},1/3)`, level: 5 }
      case 'nthRoot':
        return { text: `POWER(${first.text},1/${wrap(second, 3)})`, level: 5 }
      case 'atan2':
        return { text: `ATAN2(${second.text},${first.text})`, level: 5 }
      case 'sec':
      case 'csc':
      case 'cot':
        return { text: `1/${node.fn === 'sec' ? 'COS' : node.fn === 'csc' ? 'SIN' : 'TAN'}(${first.text})`, level: 2 }
      case 'hypot':
        return { text: `SQRT(SUMSQ(${list}))`, level: 5 }
      default:
        return FUNCTIONS[node.fn] ? { text: `${FUNCTIONS[node.fn]}(${list})`, level: 5 } : null
    }
  }

  private degrees(node: Extract<Node, { type: 'quantity' }>): Formula | null {
    const inner = this.toFormula(node.value)

    return inner && { text: `RADIANS(${inner.text})`, level: 5 }
  }

  private binary(node: Extract<Node, { type: 'binary' }>): Formula | null {
    const left = this.toFormula(node.left)
    const right = this.toFormula(node.right)

    if (!left || !right) {
      return null
    }

    switch (node.op) {
      case '+':
      case '-':
        if (right.percent && !left.percent) {
          return { text: `${wrap(left, 2)}*(1${node.op}${wrap(right, 2)})`, level: 2 }
        }

        return { text: `${wrap(left, 1)}${node.op}${wrap(right, 2)}`, level: 1, percent: left.percent && right.percent }
      case '*':
      case 'juxt':
      case 'of':
        return { text: `${wrap(left, 2)}*${wrap(right, 3)}`, level: 2, percent: left.percent && !right.percent && node.op === '*' }
      case '/':
        return { text: `${wrap(left, 2)}/${wrap(right, 3)}`, level: 2 }
      case '^':
        return { text: `${wrap(left, 5)}^${wrap(right, 5)}`, level: 4 }
      case 'mod':
        return { text: `MOD(${left.text},${right.text})`, level: 5 }
      case 'off':
      case 'on':
        return left.percent ? { text: `${wrap(right, 2)}*(1${node.op === 'on' ? '+' : '-'}${wrap(left, 2)})`, level: 2 } : null
    }
  }
}

function wrap(formula: Formula, level: number): string {
  return formula.level < level ? `(${formula.text})` : formula.text
}

/** A percentage written as one: "15" from "15% of what" becomes "15%". */
function percentText(formula: Formula): string {
  return formula.percent ? wrap(formula, 5) : `${wrap(formula, 5)}%`
}

/** A line that is only a number, an amount or a percentage: its value goes in the cell, not a formula. */
function isLiteral(node: Node): boolean {
  if (node.type === 'number') {
    return true
  }

  return (node.type === 'money' || node.type === 'group' || node.type === 'percent') && isLiteral(node.value)
}
