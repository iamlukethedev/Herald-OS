import type { DocJSON } from '../../../../../shared/office/document.ts'
import { baseName, extensionOf } from '../../../../../shared/office/files.ts'
import type { SheetSnapshot, WorkbookSnapshot } from '../../../../../shared/office/workbook.ts'
import { messageOf } from '../../../canvas/errors.ts'
import { decodeText, unitId } from '../../print.ts'
import type { Deck, Theme } from '../deck.ts'
import { addSlideFromSheet, addTableFromSheet, deckFromDocument, type DeckChange, sheetRange, slidesFromDocument } from '../model.ts'

/*
 * Slides from other Office files: documents picked in Herald Docs' open dialog become a deck or
 * slides of one, and a range of a spreadsheet picked in Herald Sheets' becomes a table. Files are
 * read as their own apps read them, the converters loaded only when one is needed. The dialog and
 * the reading come in as `FileAccess`, so all of this runs without Herald around it.
 */

/** Picking and reading Office files: Herald's open dialog and its file reading, or stand-ins for them. */
export interface FileAccess {
  pickOpen: (app: 'docs' | 'sheets') => Promise<string[]>
  read: (file: string) => Promise<{ bytes: Uint8Array }>
}

export const officeFiles = (): FileAccess => window.heraldOS.office

type Report = (message: string) => void

/** A file's name with its extension, as messages give it. */
const nameOf = (file: string): string => file.split(/[/\\]/).pop() || file

/** A document file as Herald Docs reads it: Word documents, Markdown and plain text. */
export async function documentFromFile(file: string, bytes: Uint8Array): Promise<DocJSON> {
  const extension = extensionOf(file)

  if (extension === '.docx' || extension === '.docm') {
    const { documentFromDocx } = await import('../../../../../shared/office/docx/read.ts')

    return (await documentFromDocx(bytes)).doc
  }

  if (extension === '.md' || extension === '.markdown' || extension === '.txt') {
    const { documentFromMarkdown, documentFromText } = await import('../../../../../shared/office/doc-text.ts')
    const { text } = decodeText(bytes)

    return (extension === '.txt' ? documentFromText(text) : documentFromMarkdown(text)).document
  }

  throw new Error(`Herald Slides cannot make slides from ${extension || 'these'} files`)
}

/** A spreadsheet file as Herald Sheets reads it: Excel workbooks and CSV. */
export async function workbookFromFile(file: string, bytes: Uint8Array): Promise<WorkbookSnapshot> {
  const extension = extensionOf(file)
  const name = baseName(file)

  if (extension === '.xlsx' || extension === '.xlsm') {
    const { workbookFromXlsx } = await import('../../../../../shared/office/xlsx/read.ts')

    return (await workbookFromXlsx(bytes, { id: unitId('book'), name, extension })).workbook
  }

  if (extension === '.csv') {
    const [{ decodeCsv }, { workbookFromCsv }] = await Promise.all([import('../../../../../shared/office/csv.ts'), import('../../../../../shared/office/sheet-csv.ts')])

    return workbookFromCsv(decodeCsv(bytes).text, { id: unitId('book'), name }).workbook
  }

  throw new Error(`Herald Slides cannot take tables from ${extension || 'these'} files`)
}

export interface PickedDocument {
  /** The file's name with its extension, for messages. */
  file: string
  /** The file's name without its extension. */
  name: string
  doc: DocJSON
}

/** Documents picked in Herald Docs' open dialog, each read; one that cannot be read is reported by its name and left out. */
export async function pickDocuments(access: FileAccess, report: Report): Promise<PickedDocument[]> {
  const picked: PickedDocument[] = []

  for (const file of await access.pickOpen('docs')) {
    try {
      picked.push({ file: nameOf(file), name: baseName(file), doc: await documentFromFile(file, (await access.read(file)).bytes) })
    } catch (error) {
      report(`Could not read ${nameOf(file)}: ${messageOf(error)}`)
    }
  }

  return picked
}

/** New decks from documents picked, each titled with its file's name, in `theme` when one is given (the deck in front's). */
export async function decksFromDocuments(access: FileAccess, report: Report, theme?: Theme): Promise<{ name: string; deck: Deck }[]> {
  return (await pickDocuments(access, report)).flatMap(({ file, name, doc }) => {
    try {
      return [{ name, deck: deckFromDocument(doc, { title: name, ...(theme ? { theme } : {}) }) }]
    } catch (error) {
      report(`Could not make slides from ${file}: ${messageOf(error)}`)

      return []
    }
  })
}

/** The slides of documents after `after` (at the end without it), one document's after another's, as one step. */
export function withDocumentSlides(deck: Deck, docs: readonly DocJSON[], after: string | null): DeckChange & { slideIds: string[] } {
  let next = deck
  const slideIds: string[] = []

  for (const doc of docs) {
    const made = slidesFromDocument(next, doc, { after: slideIds[slideIds.length - 1] ?? after })
    next = made.deck
    slideIds.push(...made.slideIds)
  }

  return { deck: next, label: 'Slides from Document', slideIds, ...(slideIds.length ? { focus: { slideId: slideIds[0], selected: [] } } : {}) }
}

export interface PickedWorkbook {
  /** The file's name with its extension, for messages. */
  file: string
  workbook: WorkbookSnapshot
}

/** The spreadsheet picked first in Herald Sheets' open dialog, read; null when none is picked or it cannot be read (which is reported by its name). */
export async function pickWorkbook(access: FileAccess, report: Report): Promise<PickedWorkbook | null> {
  const [file] = await access.pickOpen('sheets')

  if (!file) {
    return null
  }

  try {
    return { file: nameOf(file), workbook: await workbookFromFile(file, (await access.read(file)).bytes) }
  } catch (error) {
    report(`Could not read ${nameOf(file)}: ${messageOf(error)}`)

    return null
  }
}

/** A workbook's sheets in its order. */
export const sheetsOf = (workbook: WorkbookSnapshot): SheetSnapshot[] => workbook.sheetOrder.map((id) => workbook.sheets[id]).filter(Boolean)

/** The sheet a workbook has in front, else its first. */
export function frontSheet(workbook: WorkbookSnapshot): SheetSnapshot | undefined {
  const active = typeof workbook.activeSheetId === 'string' ? workbook.sheets[workbook.activeSheetId] : undefined

  return active ?? sheetsOf(workbook)[0]
}

/** What a range of a sheet takes (its used range when the range is empty): the range with its rows and columns, or why it cannot be taken. */
export function rangeSummary(workbook: WorkbookSnapshot, sheetId: string, range: string): { ref: string; rows: number; columns: number } | { error: string } {
  const sheet = workbook.sheets[sheetId]

  if (!sheet) {
    return { error: 'The workbook has no such sheet' }
  }

  try {
    const taken = sheetRange(sheet, range, workbook)

    if (!taken.cells.length) {
      return { error: range.trim() ? `There is nothing to show in ${range.trim()}` : `${sheet.name} is empty` }
    }

    return { ref: taken.ref, rows: taken.cells.length, columns: taken.cells[0].length }
  } catch (error) {
    return { error: messageOf(error) }
  }
}

export interface SheetPlacement {
  /** The sheet's id. */
  sheet: string
  /** Its used range when empty. */
  range: string
  header: boolean
  /** As a table on the slide, or on new slides of their own after it. */
  place: 'slide' | 'slides'
}

/** A range of a workbook's sheet put in a deck by a slide: a table on it, or new slides after it. */
export function placeSheet(deck: Deck, slideId: string, workbook: WorkbookSnapshot, placement: SheetPlacement): DeckChange {
  const options = { sheet: workbook.sheets[placement.sheet]?.name ?? placement.sheet, range: placement.range.trim() || undefined, header: placement.header }

  return placement.place === 'slide' ? addTableFromSheet(deck, slideId, workbook, options) : addSlideFromSheet(deck, workbook, { ...options, after: slideId })
}
