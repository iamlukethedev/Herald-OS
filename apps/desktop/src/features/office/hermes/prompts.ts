import { OFFICE_APP_NAMES, type OfficeApp } from '../../../../shared/office/files.ts'
import { columnName, parseCell, parseRange, quoteSheet, splitSheet } from '../../../../shared/office/xlsx/address.ts'
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
const MAX_SLIDE_TEXT = 1500
const MAX_TITLES = 40
const MAX_TITLE = 48

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

/** The slide in front of a deck, and the deck's slides by title. */
export interface SlideSelection {
  kind: 'slide'
  /** Its number from 1, and how many slides the deck has. */
  number: number
  count: number
  id: string
  layout: string
  title: string
  /** Its text, one line a bullet (indented a level deeper); two of them on a two-column slide. */
  bodies: string[]
  notes: string
  /** What is selected on it: "title", "text box “Q3 grew”". */
  selected: string[]
  /** Every slide's title in order, "" for a slide without one. */
  titles: string[]
}

export type PromptSelection = TextSelection | CellSelection | SlideSelection

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

export type SlidesAction =
  | { id: 'notes' | 'allNotes' | 'layouts' | 'tighten' }
  | { id: 'fromDocument'; document: OpenDocument; into: 'this' | 'new' }
  | { id: 'fromSheet'; workbook: OpenDocument }

export type HermesAction = DocsAction | SheetsAction | SlidesAction

export interface PromptContext {
  app: OfficeApp
  document: { name: string; path: string | null }
  /** What the person typed. An action brings words of its own. */
  words: string
  selection?: PromptSelection | null
  /** What is on screen, as the editor says it, when there is no selection to give. */
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

const quoted = (text: string): string => {
  const trimmed = text.trim()

  return `"""\n${trimmed.length > MAX_SLIDE_TEXT ? `${trimmed.slice(0, MAX_SLIDE_TEXT)}…` : trimmed}\n"""`
}

const shortTitle = (title: string): string => (title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title)

function slideBlock(selection: SlideSelection): string {
  const bodies = selection.bodies.filter((body) => body.trim())
  const lines = [`In front: slide ${selection.number} of ${selection.count}${selection.title ? `, “${selection.title}”` : ''} (layout ${selection.layout}, id ${selection.id}).`]

  if (bodies.length) {
    lines.push(bodies.length > 1 ? 'Its two columns:' : 'Its text:', ...bodies.map(quoted))
  }

  if (selection.notes.trim()) {
    lines.push('Its speaker notes:', quoted(selection.notes))
  }

  if (selection.selected.length) {
    lines.push(`Selected on it: ${selection.selected.join('; ')}.`)
  }

  const titles = selection.titles.slice(0, MAX_TITLES).map((title, index) => `${index + 1} ${title.trim() ? `“${shortTitle(title.trim())}”` : '(no title)'}`)
  const more = selection.titles.length > MAX_TITLES ? `, and ${selection.titles.length - MAX_TITLES} more` : ''
  lines.push(`The slides: ${titles.join(', ')}${more}.`)

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

function generalRules(app: OfficeApp, target: string, selection: PromptSelection | null): string[] {
  if (app === 'docs') {
    const marked = selection?.kind === 'text' && selection.marked && Boolean(selection.text.trim())

    return [`Work on that document with the docs tool (${target}).`, ONE_CALL, ...(marked ? ['When the request is about the marked text, replace it with action=write at=marked.'] : []), 'Do not save unless asked.', REPLY]
  }

  if (app === 'sheets') {
    return [`Work on that workbook with the sheets tool (${target}); range=selection is the selected cells.`, ONE_CALL, 'Do not save unless asked.', REPLY]
  }

  const front = selection?.kind === 'slide' ? `; slide=${selection.number} is the slide in front` : ''

  return [`Work on that presentation with the slides tool (${target})${front}.`, ONE_CALL, 'Do not save unless asked.', REPLY]
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

const refOf = (doc: OpenDocument, home: string): string => JSON.stringify(doc.path ? tildePath(doc.path, home) : doc.name)

/** A workbook's selection, when it is more than one cell: the cells a table is made of. */
function selectedRange(selection: string | undefined): string | null {
  const range = selection ? parseRange(splitSheet(selection).ref) : null

  return range && (range.endRow > range.startRow || range.endColumn > range.startColumn) ? selection! : null
}

const LAYOUT_IDS = 'title, title-content, two-content, comparison, section, title-only, blank or picture-caption'

function slidesRequest(action: SlidesAction, target: string, slide: SlideSelection | null, home: string): { ask: string; rules: string[] } {
  const number = slide?.number ?? null
  const on = number ? ` slide=${number}` : ''
  const which = number ? `slide ${number}` : 'the slide in front'
  const readFirst = `Read the deck first (slides action=read ${target}).`
  const reply = 'Reply with one short sentence.'

  switch (action.id) {
    case 'notes':
      return { ask: `Write speaker notes for ${which}.`, rules: [`Make ONE slides call: action=set_slide ${target}${on} notes=<two to four short sentences to say aloud, in the slide’s language>.`, 'Change nothing else; do not save.', reply] }
    case 'allNotes':
      return {
        ask: 'Write speaker notes for every slide.',
        rules: [readFirst, `Then make ONE slides call: action=edit ${target} edits=[{"op": "setSlide", "slide": <its number>, "notes": "<two to four short sentences to say aloud>"}, …], one setSlide for each slide with something on it.`, 'Change nothing else; do not save.', reply]
      }
    case 'layouts':
      return {
        ask: 'Choose each slide’s layout for what it holds.',
        rules: [readFirst, `Then make ONE slides call: action=edit ${target} edits=[{"op": "setSlide", "slide": <its number>, "layout": "<${LAYOUT_IDS}>"}, …] for each slide whose layout does not suit what it holds; its text moves into the new layout.`, 'Change nothing else; do not save.', 'Reply with one short sentence saying which slides changed.']
      }
    case 'tighten':
      return {
        ask: `Tighten ${which}: shorter, parallel bullets.`,
        rules: [`Make ONE slides call: action=set_slide ${target}${on} body=<the tightened text: one line a bullet, two spaces at the start a level deeper; a JSON list of two bodies on a two-column slide>, with title= too when a shorter title says the same.`, 'Keep its meaning, its language and its order; leave its notes as they are; change nothing else.', 'Do not save.', reply]
      }
    case 'fromDocument': {
      const document = `document=${refOf(action.document, home)}`
      const made = 'Reply with one short sentence saying how many slides it made.'

      return action.into === 'this'
        ? { ask: `Make slides from the document “${action.document.name}” and add them at the end of this presentation.`, rules: [`Make ONE slides call: action=from_document ${document} ${target}.`, 'Do not save.', made] }
        : { ask: `Make a new presentation from the document “${action.document.name}”.`, rules: [`Make ONE slides call: action=from_document ${document}, leaving presentation out so the slides go in a new presentation named after the document.`, 'Do not save.', made] }
    }
    case 'fromSheet': {
      const workbook = `workbook=${refOf(action.workbook, home)}`
      const range = selectedRange(action.workbook.selection)

      return {
        ask: `Put the cells of “${action.workbook.name}” on a new slide${number ? ` after slide ${number}` : ''} as a table, with a slide after it that sums them up.`,
        rules: [
          range ? `Read the cells first (sheets action=read ${workbook} range=${range}).` : `Read the cells first: sheets action=read ${workbook} with no range gives the ones that hold something, and their range is the one to use.`,
          `Add both slides with ONE slides call: action=edit ${target} edits=[{"op": "addSlide", "layout": "title-only", "title": "<what the table shows>"${number ? `, "after": ${number}` : ''}}, {"op": "addSlide", "title": "<the point the numbers make>", "body": "<three or four bullets on what they show>", "after": "<the table slide’s title>"}].`,
          `Then put the table on the first of them with ONE more call: action=insert_range ${target} slide="<the table slide’s title>" ${workbook} range=${range ?? '<that range>'}.`,
          'Do not save.',
          reply
        ]
      }
    }
  }
}

const DOCS_ACTIONS: readonly string[] = ['rewrite', 'shorten', 'expand', 'tone', 'translate', 'fix', 'summarise']
const SHEETS_ACTIONS: readonly string[] = ['explain', 'fill', 'insights', 'clean']

const isDocsAction = (action: HermesAction): action is DocsAction => DOCS_ACTIONS.includes(action.id)
const isSheetsAction = (action: HermesAction): action is SheetsAction => SHEETS_ACTIONS.includes(action.id)

function actionRequest(action: HermesAction, target: string, selection: PromptSelection | null, home: string): { ask: string; rules: string[] } {
  if (isDocsAction(action)) {
    return docsRequest(action, target)
  }

  return isSheetsAction(action) ? sheetsRequest(action, target, selection?.kind === 'cells' ? selection : null) : slidesRequest(action, target, selection?.kind === 'slide' ? selection : null, home)
}

const READING: Record<string, string> = { docs: 'Reading the document', sheets: 'Reading the cells', slides: 'Reading the presentation' }

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
  return ['docs', 'sheets', 'slides'].includes(tool) || (typeof args?.command === 'string' && /^(docs|sheets|slides)\./.test(args.command))
}

/** The text sent to Hermes for a request about a document. */
export function buildPrompt(context: PromptContext): string {
  const { app, document: doc, home = '', action } = context
  const appName = OFFICE_APP_NAMES[app]
  const ref = doc.path ? tildePath(doc.path, home) : doc.name
  const target = `${({ docs: 'document', sheets: 'workbook', slides: 'presentation' } as const)[app]}=${JSON.stringify(ref)}`
  const selection = context.selection ?? null
  const request = action ? actionRequest(action, target, selection, home) : null
  const parts = [`[${appName}] The person is working on “${doc.name}” (${doc.path ? ref : `not saved yet: call it "${doc.name}"`}) in ${appName} and asks: ${request?.ask ?? context.words.trim()}`]
  const block = !selection ? null : selection.kind === 'text' ? textBlock(selection) : selection.kind === 'cells' ? cellsBlock(selection) : slideBlock(selection)

  if (block) {
    parts.push(block)
  } else if (context.detail) {
    parts.push(`On screen: ${context.detail}.`)
  }

  const others = action ? null : othersLine(context.others ?? [], home)

  if (others) {
    parts.push(others)
  }

  const complete = selection?.kind === 'text' && selection.marked && Boolean(selection.text.trim()) && selection.text.length <= MAX_TEXT
  const rules = request ? [...(complete && action && isDocsAction(action) ? ['The whole marked text is above: no need to read the document first.'] : []), ...request.rules] : generalRules(app, target, selection)
  parts.push(rules.map((rule) => `- ${rule}`).join('\n'))

  return parts.join('\n\n')
}
