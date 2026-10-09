import { OFFICE_APP_NAMES, type OfficeApp } from '../../../../shared/office/files.ts'
import { columnName, parseCell, quoteSheet } from '../../../../shared/office/xlsx/address.ts'
import { tildePath } from '../agent-model.ts'

/*
 * What an Office window sends Hermes: the document, the person's words, what is selected and what
 * else is open, then short, exact instructions, so the change lands in the window as one step to
 * undo and the reply fits the Ask Hermes bar. The inline actions name the one tool call they want.
 * Pure, and tested directly.
 */

/** The most selected text a prompt carries; longer selections are cut, with a way to read the rest. */
export const MAX_TEXT = 2000

/** The most rows and columns of a selection a prompt shows. */
export const MAX_GRID_ROWS = 30
export const MAX_GRID_COLUMNS = 12

const MAX_CELL_TEXT = 40
const MAX_OTHERS = 8

export interface TextSelection {
  kind: 'text'
  /** The selected text; empty when only the caret's place is marked. */
  text: string
  /** Marked for this request: Hermes's at=marked lands there even after the person clicks elsewhere. */
  marked: boolean
}

export interface CellSelection {
  kind: 'cells'
  sheet: string
  /** The selected range, "B2:D9" or "D2". */
  range: string
  rows: number
  columns: number
  /** Where the grid starts, zero-based. */
  top: number
  left: number
  /** What the cells show, at most MAX_GRID_ROWS by MAX_GRID_COLUMNS of them. */
  grid: string[][]
  /** The active cell, "D2", and its formula. */
  cell: string
  formula: string | null
}

export type PromptSelection = TextSelection | CellSelection

/** Another open Office document, for requests that reach across documents. */
export interface OpenDocument {
  app: OfficeApp
  name: string
  path: string | null
  /** What is selected in a workbook, "Sheet1!B2:D9". */
  selection?: string
}

export type CleanKind = 'dedupe' | 'dates' | 'split' | 'trim' | 'numbers'

export type DocsAction = { id: 'rewrite' | 'shorten' | 'expand' | 'fix' | 'summarise' } | { id: 'tone'; tone: string } | { id: 'translate'; language: string }

export type SheetsAction = { id: 'explain' | 'fill' | 'insights' } | { id: 'clean'; clean: CleanKind }

export type SlidesAction = { id: 'notes' | 'layout' }

export type HermesAction = DocsAction | SheetsAction | SlidesAction

export interface PromptContext {
  app: OfficeApp
  document: { name: string; path: string | null }
  /** What the person typed. An action brings words of its own. */
  words: string
  selection?: PromptSelection | null
  /** What is on screen when nothing is selected, as Herald Slides says it ("slide 3 of 12 (“Market”)"). */
  detail?: string
  others?: readonly OpenDocument[]
  home?: string
  action?: HermesAction
}

const count = (n: number, noun: string): string => `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`

const cellText = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')

  return flat.length > MAX_CELL_TEXT ? `${flat.slice(0, MAX_CELL_TEXT - 1)}…` : flat
}

const cellsRef = (selection: CellSelection): string => `${quoteSheet(selection.sheet)}!${selection.range}`

function textBlock(selection: TextSelection): string | null {
  if (!selection.text.trim()) {
    return selection.marked ? 'Nothing is selected; the caret’s place is marked for this request (at=marked writes there).' : null
  }

  const cut = selection.text.length > MAX_TEXT
  const label = selection.marked ? 'Selected text, marked for this request' : 'Selected text'
  const note = cut ? ` (its first ${MAX_TEXT.toLocaleString('en-US')} characters; docs action=read part=selection gives all of it)` : ''

  return `${label}${note}:\n"""\n${cut ? `${selection.text.slice(0, MAX_TEXT)}…` : selection.text}\n"""`
}

function cellsBlock(selection: CellSelection): string {
  const size = selection.rows * selection.columns > 1 ? ` (${count(selection.rows, 'row')} × ${count(selection.columns, 'column')})` : ''
  const lines = [`Selection: ${cellsRef(selection)}${size}; the active cell ${selection.cell} ${selection.formula ? `holds ${selection.formula}` : 'has no formula'}.`]
  const width = Math.max(0, ...selection.grid.map((row) => row.length))

  if (selection.grid.length && width) {
    lines.push('What the cells show:', ['row', ...Array.from({ length: width }, (_, n) => columnName(selection.left + n))].join(' | '))
    selection.grid.forEach((row, r) => lines.push([String(selection.top + r + 1), ...Array.from({ length: width }, (_, c) => cellText(row[c] ?? ''))].join(' | ')))

    if (selection.rows > selection.grid.length || selection.columns > width) {
      lines.push(`(the first ${count(selection.grid.length, 'row')} and ${count(width, 'column')}; sheets action=read gives the rest)`)
    }
  }

  return lines.join('\n')
}

function othersLine(others: readonly OpenDocument[], home: string): string | null {
  if (!others.length) {
    return null
  }

  const shown = others.slice(0, MAX_OTHERS).map((doc) => `“${doc.name}” (${OFFICE_APP_NAMES[doc.app]}, ${doc.path ? tildePath(doc.path, home) : 'not saved yet'}${doc.selection ? `, selection ${doc.selection}` : ''})`)
  const more = others.length > MAX_OTHERS ? `, and ${others.length - MAX_OTHERS} more` : ''

  return `Also open in Herald Office: ${shown.join('; ')}${more}.`
}

const REPLY = 'Reply in one or two short sentences saying what changed (or the answer, for a question).'
const ONE_CALL = 'Land the whole change in ONE call where you can (action=edit for several changes): each call is one step the person can undo.'

function generalRules(app: OfficeApp, target: string, marked: boolean): string[] {
  if (app === 'docs') {
    return [`Work on that document with the docs tool (${target}).`, ONE_CALL, ...(marked ? ['When the request is about the marked text, replace it with action=write at=marked.'] : []), 'Do not save unless asked.', REPLY]
  }

  if (app === 'sheets') {
    return [`Work on that workbook with the sheets tool (${target}); range=selection is the selected cells.`, ONE_CALL, 'Do not save unless asked.', REPLY]
  }

  return [
    `Work on that presentation (${target}) with the slides commands, through os_ui action=run: slides.addSlide adds a slide, slides.setSlide changes one (its text, notes or layout), slides.fromDocument makes slides from a document, slides.insertRange puts a workbook’s cells on a slide; os_ui action=list gives their arguments.`,
    'Each call is one step the person can undo: make the change in as few calls as the commands allow.',
    'Do not save unless asked.',
    REPLY
  ]
}

const KEEP = 'Keep its language, and its emphasis and links where they still fit; no quotes around it; change nothing else.'

const replaceMarked = (target: string, content: string, rules: string[]): string[] => [`Replace the marked text with ONE docs call: action=write ${target} at=marked content=<${content}, in Markdown>.`, ...rules, 'Do not save.', 'Reply with one short sentence.']

function docsRequest(action: DocsAction, target: string): { ask: string; rules: string[] } {
  switch (action.id) {
    case 'rewrite':
      return { ask: 'Rewrite the marked text so it reads more clearly, keeping its meaning.', rules: replaceMarked(target, 'the rewritten text', [KEEP]) }
    case 'shorten':
      return { ask: 'Shorten the marked text, keeping what matters.', rules: replaceMarked(target, 'the shorter text', [KEEP]) }
    case 'expand':
      return { ask: 'Expand the marked text with more detail, in the same voice.', rules: replaceMarked(target, 'the longer text', [KEEP]) }
    case 'tone':
      return { ask: `Rewrite the marked text in a ${action.tone.toLowerCase()} tone, keeping its meaning.`, rules: replaceMarked(target, 'the rewritten text', [KEEP]) }
    case 'translate':
      return { ask: `Translate the marked text into ${action.language}.`, rules: replaceMarked(target, `the ${action.language} translation`, ['Keep its emphasis and links where they still fit; no quotes around it; change nothing else.']) }
    case 'fix':
      return {
        ask: 'Fix the spelling and grammar in the marked text.',
        rules: replaceMarked(target, 'the corrected text', ['Change only what is wrong, and keep its language, emphasis and links; no quotes around it; change nothing else.', 'If nothing is wrong, make no call and say so.'])
      }
    case 'summarise':
      return {
        ask: 'Summarise the marked text.',
        rules: [`Put the summary under its paragraph with ONE docs call: action=write ${target} at=after content=<a short paragraph in Markdown, in the text’s language>.`, 'Leave the marked text as it is; change nothing else.', 'Do not save.', 'Reply with one short sentence.']
      }
  }
}

const CLEANING: Record<CleanKind, (ref: string) => string> = {
  dedupe: (ref) => `Remove the duplicate rows in ${ref}.`,
  dates: (ref) => `Turn the dates kept as text in ${ref} into real dates.`,
  split: (ref) => `Split ${ref} at its delimiter into the columns to its right.`,
  trim: (ref) => `Trim the extra spaces in ${ref}.`,
  numbers: (ref) => `Turn the numbers stored as text in ${ref} into numbers.`
}

const CLEANING_NOTE: Partial<Record<CleanKind, string>> = { dates: ' (day or month first, as the data shows)', split: ' (with the delimiter the data uses)' }

/** The selected column for a fill: the selection, or the whole column of a single cell. */
function fillRef(selection: CellSelection): string {
  const single = parseCell(selection.range)

  return single ? `${quoteSheet(selection.sheet)}!${columnName(single.column)}:${columnName(single.column)}` : cellsRef(selection)
}

function sheetsRequest(action: SheetsAction, target: string, selection: CellSelection | null): { ask: string; rules: string[] } {
  const ref = selection ? cellsRef(selection) : 'selection'
  const place = selection ? ref : 'the selected cells'

  switch (action.id) {
    case 'explain':
      return {
        ask: `Explain the formula in ${selection?.cell ?? 'the active cell'} step by step.`,
        rules: [`Read the cells it refers to when that helps (sheets action=read ${target}), and change nothing.`, 'Reply with a short step-by-step explanation in plain words: what each part does and what the result means.']
      }
    case 'fill': {
      const column = selection ? fillRef(selection) : 'the selected column'

      return {
        ask: `Fill the empty cells of ${column} following the filled ones.`,
        rules: [
          `Read ${column} and the columns beside it first (sheets action=read ${target}).`,
          'When a rule works the values out from other cells, fill a formula with ONE call: action=fill range=<the empty cells> formula=<the first one’s formula>.',
          'Otherwise write all the missing values with ONE call: action=write (or action=edit when the empty cells are not next to each other).',
          'Leave the filled cells as they are; do not save.',
          'Reply with one short sentence saying what you filled.'
        ]
      }
    }
    case 'clean':
      return {
        ask: CLEANING[action.clean](place),
        rules: [`Make ONE sheets call: action=clean ${target} range=${ref} clean=${action.clean}${CLEANING_NOTE[action.clean] ?? ''}, with header=true when its first row holds column names.`, 'Change nothing else; do not save.', 'Reply with one short sentence saying what changed.']
      }
    case 'insights':
      return {
        ask: 'What stands out in this sheet?',
        rules: [`Read the sheet’s cells that hold something (sheets action=read ${target}, no range), and change nothing.`, 'Answer in a few short lines: totals, trends, outliers and gaps worth knowing, naming the cells.']
      }
  }
}

function slidesRequest(action: SlidesAction, target: string): { ask: string; rules: string[] } {
  const done = ['Change nothing else on the slide; do not save.', 'Reply with one short sentence.']

  switch (action.id) {
    case 'notes':
      return { ask: 'Write speaker notes for the slide in front.', rules: [`Make ONE call: os_ui action=run command=slides.setSlide on the slide in front (${target}), setting its speaker notes: two to four short sentences to say aloud.`, ...done] }
    case 'layout':
      return { ask: 'Give the slide in front the layout that suits its content.', rules: [`Make ONE call: os_ui action=run command=slides.setSlide on the slide in front (${target}), setting its layout and keeping its text.`, ...done] }
  }
}

const DOCS_ACTIONS: readonly string[] = ['rewrite', 'shorten', 'expand', 'tone', 'translate', 'fix', 'summarise']
const SHEETS_ACTIONS: readonly string[] = ['explain', 'fill', 'insights', 'clean']

const isDocsAction = (action: HermesAction): action is DocsAction => DOCS_ACTIONS.includes(action.id)
const isSheetsAction = (action: HermesAction): action is SheetsAction => SHEETS_ACTIONS.includes(action.id)

function actionRequest(action: HermesAction, target: string, selection: PromptSelection | null): { ask: string; rules: string[] } {
  if (isDocsAction(action)) {
    return docsRequest(action, target)
  }

  return isSheetsAction(action) ? sheetsRequest(action, target, selection?.kind === 'cells' ? selection : null) : slidesRequest(action, target)
}

const READING: Record<string, string> = { docs: 'Reading the document', sheets: 'Reading the cells' }

/** What the bar says Hermes is doing, from its latest tool call: "docs · write", "slides · setSlide". */
export function stepLabel(tool: string, args?: Record<string, unknown> | null): string {
  const action = typeof args?.action === 'string' ? args.action : ''
  const command = typeof args?.command === 'string' ? args.command : ''

  if (action === 'read' && READING[tool]) {
    return READING[tool]
  }

  if (action === 'list_all') {
    return 'Looking at what is open'
  }

  if (command) {
    return command.replace('.', ' · ')
  }

  return action ? `${tool} · ${action}` : tool
}

/** Whether a tool call works on an Office document, so the steps it adds to a document are Hermes's. */
export function editsOffice(tool: string, args?: Record<string, unknown> | null): boolean {
  return tool === 'docs' || tool === 'sheets' || (typeof args?.command === 'string' && /^(docs|sheets|slides)\./.test(args.command))
}

/** The text sent to Hermes for a request about a document. */
export function buildPrompt(context: PromptContext): string {
  const { app, document: doc, home = '', action } = context
  const appName = OFFICE_APP_NAMES[app]
  const ref = doc.path ? tildePath(doc.path, home) : doc.name
  const target = `${({ docs: 'document', sheets: 'workbook', slides: 'presentation' } as const)[app]}=${JSON.stringify(ref)}`
  const selection = context.selection ?? null
  const request = action ? actionRequest(action, target, selection) : null
  const parts = [`[${appName}] The person is working on “${doc.name}” (${doc.path ? ref : `not saved yet: call it "${doc.name}"`}) in ${appName} and asks: ${request?.ask ?? context.words.trim()}`]
  const block = selection ? (selection.kind === 'text' ? textBlock(selection) : cellsBlock(selection)) : null

  if (block) {
    parts.push(block)
  } else if (context.detail) {
    parts.push(`On screen: ${context.detail}.`)
  }

  const others = action ? null : othersLine(context.others ?? [], home)

  if (others) {
    parts.push(others)
  }

  const marked = selection?.kind === 'text' && selection.marked && Boolean(selection.text.trim())
  const complete = marked && selection.text.length <= MAX_TEXT
  const rules = request ? [...(complete && action && isDocsAction(action) ? ['The whole marked text is above: no need to read the document first.'] : []), ...request.rules] : generalRules(app, target, marked)
  parts.push(rules.map((rule) => `- ${rule}`).join('\n'))

  return parts.join('\n\n')
}
