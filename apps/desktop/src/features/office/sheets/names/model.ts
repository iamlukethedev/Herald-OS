import { generateRandomId, ICommandService, RANGE_TYPE } from '@univerjs/core'
import { IDefinedNamesService } from '@univerjs/engine-formula'
import { getPrimaryForRange, SetSelectionsOperation } from '@univerjs/sheets'
import type { FWorksheet } from '@univerjs/sheets/facade'
import { type CellRange, columnName, MAX_COLUMNS, MAX_ROWS, parseRange, quoteSheet, splitSheet } from '../../../../../shared/office/xlsx/address.ts'
import { nameProblem, WORKBOOK_SCOPE } from '../../../../../shared/office/xlsx/rules.ts'
import { oneStep, type SheetsTarget, sheetOf } from '../model.ts'

/* What Hermes's commands and the menus do with named ranges: creating, changing, removing and going to them, on a workbook (see ../model.ts). */

export interface NamedRange {
  name: string
  /** What the name stands for, as Excel's Name Manager shows it: "=Data!$B$2:$D$9", "=0.07". */
  refersTo: string
  /** "workbook", or the name of the sheet the name belongs to. */
  scope: string
  comment: string
}

interface StoredName {
  id: string
  name: string
  formulaOrRefString: string
  localSheetId?: string
  comment?: string
  hidden?: boolean
}

/** The workbook's names as Univer keeps them, hidden ones too. */
function storedNames(target: SheetsTarget): StoredName[] {
  const map = target.univer.__getInjector().get(IDefinedNamesService).getDefinedNameMap(target.workbook.getId())

  return Object.values(map ?? {}) as StoredName[]
}

const isWorkbookScope = (scope: string | undefined): boolean => !scope || scope === WORKBOOK_SCOPE

const scopeName = (target: SheetsTarget, scope: string | undefined): string => (isWorkbookScope(scope) ? 'workbook' : (target.workbook.getSheetBySheetId(scope!)?.getSheetName() ?? scope!))

const shown = (target: SheetsTarget, entry: StoredName): NamedRange => ({
  name: entry.name,
  refersTo: entry.formulaOrRefString.startsWith('=') ? entry.formulaOrRefString : `=${entry.formulaOrRefString}`,
  scope: scopeName(target, entry.localSheetId),
  comment: entry.comment ?? ''
})

/** The named ranges of a workbook (Excel's hidden names left out), workbook names first, then by name. */
export function listNames(target: SheetsTarget): NamedRange[] {
  return storedNames(target)
    .filter((entry) => !entry.hidden)
    .sort((a, b) => Number(!isWorkbookScope(a.localSheetId)) - Number(!isWorkbookScope(b.localSheetId)) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .map((entry) => shown(target, entry))
}

/** A scope as Univer keeps it: the workbook's, or a sheet's id. */
function scopeOf(target: SheetsTarget, scope: unknown): { id: string; sheet: FWorksheet | null } {
  const text = String(scope ?? '').trim()

  if (!text || text.toLowerCase() === 'workbook') {
    return { id: WORKBOOK_SCOPE, sheet: null }
  }

  const sheet = sheetOf(target.workbook, text)

  return { id: sheet.getSheetId(), sheet }
}

/** A reference split where its areas are ("Data!A1:A3,Data!C1"), passing over commas inside quoted sheet names. */
function areasOf(text: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false

  for (const char of text) {
    if (char === "'") {
      quoted = !quoted
    }

    if (char === ',' && !quoted) {
      parts.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }

  return [...parts, current.trim()]
}

/** Cells as an absolute reference: "$B$2:$D$9", "$C:$C", "$3:$5". */
function absolute(range: CellRange): string {
  if (range.startRow === 0 && range.endRow >= MAX_ROWS - 1) {
    return `$${columnName(range.startColumn)}:$${columnName(range.endColumn)}`
  }

  if (range.startColumn === 0 && range.endColumn >= MAX_COLUMNS - 1) {
    return `$${range.startRow + 1}:$${range.endRow + 1}`
  }

  const start = `$${columnName(range.startColumn)}$${range.startRow + 1}`
  const end = `$${columnName(range.endColumn)}$${range.endRow + 1}`

  return start === end ? start : `${start}:${end}`
}

/** The areas of a reference, each on its sheet (the one it names, or `sheet`); null when the text is not cells. */
function referenceAreas(target: SheetsTarget, text: string, sheet: FWorksheet): { sheet: FWorksheet; range: CellRange }[] | null {
  const areas = areasOf(text).map((part) => ({ ...splitSheet(part), part }))

  if (!areas.every(({ ref }) => parseRange(ref))) {
    return null
  }

  return areas.map(({ sheet: named, ref }) => ({ sheet: named ? sheetOf(target.workbook, named) : sheet, range: parseRange(ref)! }))
}

/** Whether a formula's parentheses and quotes close. */
function balanced(formula: string): boolean {
  let depth = 0
  let quote: string | null = null

  for (const char of formula) {
    if (quote) {
      quote = char === quote ? null : quote
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '(') {
      depth++
    } else if (char === ')' && --depth < 0) {
      return false
    }
  }

  return depth === 0 && !quote
}

/** What a name stands for as Univer keeps it: cells as an absolute reference on their sheet ("Data!$B$2:$D$9"), or a formula with its "=". */
function refersToOf(target: SheetsTarget, refersTo: unknown, sheet: FWorksheet): string {
  const text = String(refersTo ?? '').trim().replace(/^=\s*/, '')

  if (!text) {
    throw new Error('Say what the name stands for: cells like Data!B2:D9 (on the sheet in front when no sheet is named), or a formula like =0.07')
  }

  const areas = referenceAreas(target, text, sheet)

  if (areas) {
    const reference = areas.map((area) => `${quoteSheet(area.sheet.getSheetName())}!${absolute(area.range)}`).join(',')

    // Univer keeps several areas as a formula, as reading a file does.
    return areas.length > 1 ? `=${reference}` : reference
  }

  if (!balanced(text)) {
    throw new Error(`“=${text}” is neither cells nor a whole formula: check its brackets and quotes`)
  }

  return `=${text}`
}

const commentOf = (comment: unknown): string => {
  const text = String(comment ?? '').trim()

  if (text.length > 255) {
    throw new Error(`The comment is ${text.length} characters long; a name’s comment has at most 255`)
  }

  return text
}

/** A name Excel accepts, not taken in its scope (names compare without case, as Excel's do). */
function checkedName(target: SheetsTarget, name: unknown, scope: string, current?: StoredName): string {
  const text = String(name ?? '').trim()
  const problem = nameProblem(text)

  if (problem) {
    throw new Error(problem)
  }

  const taken = storedNames(target).find((entry) => entry.id !== current?.id && entry.name.toLowerCase() === text.toLowerCase() && (isWorkbookScope(entry.localSheetId) ? isWorkbookScope(scope) : entry.localSheetId === scope))

  if (taken) {
    throw new Error(`There is a${taken.hidden ? ' hidden' : ''} name “${taken.name}” ${isWorkbookScope(scope) ? 'in the workbook' : `on ${scopeName(target, scope)}`} already: give another name${taken.hidden ? '' : ', or change that one'}`)
  }

  return text
}

/**
 * The name a command means: the one in `scope` when given; else the only one so spelled, or, of
 * several, the one of the sheet in front, then the workbook's (as formulas find names).
 */
function findName(target: SheetsTarget, name: unknown, scope?: unknown): StoredName {
  const text = String(name ?? '').trim()
  const matches = storedNames(target).filter((entry) => entry.name.toLowerCase() === text.toLowerCase())

  if (!text || !matches.length) {
    const names = listNames(target).map((entry) => entry.name)

    throw new Error(`${text ? `There is no name called “${text}”` : 'Say which name'}; ${names.length ? `the names are ${[...new Set(names)].join(', ')}` : 'the workbook has no names'}`)
  }

  if (scope !== undefined && scope !== null && String(scope).trim()) {
    const { id } = scopeOf(target, scope)
    const found = matches.find((entry) => (isWorkbookScope(id) ? isWorkbookScope(entry.localSheetId) : entry.localSheetId === id))

    if (!found) {
      throw new Error(`“${matches[0].name}” is not a name ${isWorkbookScope(id) ? 'of the workbook' : `on ${scopeName(target, id)}`}; it is one ${matches.map((entry) => (isWorkbookScope(entry.localSheetId) ? 'of the workbook' : `on ${scopeName(target, entry.localSheetId)}`)).join(' and ')}`)
    }

    return found
  }

  const active = target.workbook.getActiveSheet().getSheetId()

  return matches.length === 1 ? matches[0] : (matches.find((entry) => entry.localSheetId === active) ?? matches.find((entry) => isWorkbookScope(entry.localSheetId)) ?? matches[0])
}

/** The sheet a name's unqualified cells are on: its own sheet's, or the one in front. */
const homeSheet = (target: SheetsTarget, scope: string | undefined): FWorksheet => (isWorkbookScope(scope) ? null : target.workbook.getSheetBySheetId(scope!)) ?? target.workbook.getActiveSheet()

/** Name cells or a formula, for the workbook or for one sheet; one step to undo. */
export async function createName(target: SheetsTarget, args: { name: unknown; refersTo: unknown; scope?: unknown; comment?: unknown }): Promise<NamedRange> {
  const scope = scopeOf(target, args.scope)
  const name = checkedName(target, args.name, scope.id)
  const formulaOrRefString = refersToOf(target, args.refersTo, scope.sheet ?? target.workbook.getActiveSheet())
  const comment = commentOf(args.comment)
  const entry: StoredName = { id: generateRandomId(10), name, formulaOrRefString, localSheetId: scope.id, ...(comment ? { comment } : {}) }
  await oneStep(target, () => target.workbook.insertDefinedNameBuilder({ ...entry, unitId: target.workbook.getId() }))

  return shown(target, entry)
}

/** Rename a name, or change what it stands for or its comment; one step to undo. */
export async function updateName(target: SheetsTarget, args: { name: unknown; newName?: unknown; refersTo?: unknown; comment?: unknown; scope?: unknown }): Promise<NamedRange> {
  const current = findName(target, args.name, args.scope)
  const given = (value: unknown) => value !== undefined && value !== null

  if (!given(args.newName) && !given(args.refersTo) && !given(args.comment)) {
    throw new Error('Say what to change: newName, refersTo or comment')
  }

  const next: StoredName = {
    ...current,
    name: given(args.newName) ? checkedName(target, args.newName, current.localSheetId ?? WORKBOOK_SCOPE, current) : current.name,
    formulaOrRefString: given(args.refersTo) ? refersToOf(target, args.refersTo, homeSheet(target, current.localSheetId)) : current.formulaOrRefString
  }

  if (given(args.comment)) {
    const comment = commentOf(args.comment)
    delete next.comment

    if (comment) {
      next.comment = comment
    }
  }

  await oneStep(target, () => target.workbook.updateDefinedNameBuilder({ ...next, unitId: target.workbook.getId() }))

  return shown(target, next)
}

/** Remove a name (formulas that use it show #NAME? until it is back); one step to undo. */
export async function deleteName(target: SheetsTarget, args: { name: unknown; scope?: unknown }): Promise<NamedRange> {
  const entry = findName(target, args.name, args.scope)
  const facade = target.workbook.getDefinedNames().find((name) => name.getName() === entry.name && (name.getLocalSheetId() ?? WORKBOOK_SCOPE) === (entry.localSheetId ?? WORKBOOK_SCOPE))

  if (!facade) {
    throw new Error(`“${entry.name}” could not be removed`)
  }

  await oneStep(target, () => facade.delete())

  return shown(target, entry)
}

/** Select the cells a name stands for, bringing their sheet to the front. */
export function goToName(target: SheetsTarget, args: { name: unknown; scope?: unknown }): { name: string; sheet: string; range: string } {
  const entry = findName(target, args.name, args.scope)
  const text = entry.formulaOrRefString.replace(/^=/, '')
  const areas = referenceAreas(target, text, homeSheet(target, entry.localSheetId))

  if (!areas) {
    throw new Error(`“${entry.name}” stands for a formula (=${text}), not cells to go to`)
  }

  const sheet = areas[0].sheet

  if (sheet.isSheetHidden()) {
    throw new Error(`“${entry.name}” is on ${sheet.getSheetName()}, which is hidden: show that sheet to go to it`)
  }

  const onSheet = areas.filter((area) => area.sheet.getSheetId() === sheet.getSheetId())
  target.workbook.setActiveSheet(sheet)
  const worksheet = sheet.getSheet()
  const ranges = onSheet.map(({ range }) => ({
    ...range,
    endRow: Math.min(range.endRow, sheet.getMaxRows() - 1),
    endColumn: Math.min(range.endColumn, sheet.getMaxColumns() - 1),
    rangeType: range.startRow === 0 && range.endRow >= MAX_ROWS - 1 ? RANGE_TYPE.COLUMN : range.startColumn === 0 && range.endColumn >= MAX_COLUMNS - 1 ? RANGE_TYPE.ROW : RANGE_TYPE.NORMAL
  }))
  target.univer.__getInjector().get(ICommandService).syncExecuteCommand(SetSelectionsOperation.id, {
    unitId: target.workbook.getId(),
    subUnitId: sheet.getSheetId(),
    reveal: true,
    selections: ranges.map((range, index) => ({ range, primary: index === ranges.length - 1 ? getPrimaryForRange(range, worksheet) : null, style: null }))
  })

  return { name: entry.name, sheet: sheet.getSheetName(), range: onSheet.map(({ range }) => absolute(range).replace(/\$/g, '')).join(',') }
}
