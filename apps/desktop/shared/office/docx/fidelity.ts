import type { WordPackage } from './package.ts'
import { intOf } from './styles.ts'
import { attr, child, children, type XmlElement } from './xml.ts'

/*
 * What opening a Word file approximates or leaves out, as sentences for the person opening it:
 * what reading the text finds (hidden text, fields Herald cannot keep, floating pictures) and what
 * the sections and the package hold (later sections' headers, columns, macros). Each is said once,
 * only when the file has it, and always in the same order.
 */

export type NoteKey =
  | 'deepHeadings'
  | 'headingNumbers'
  | 'listNumbers'
  | 'hiddenText'
  | 'internalLinks'
  | 'fields'
  | 'crossReferences'
  | 'pageNumbers'
  | 'tocOptions'
  | 'floatingPictures'
  | 'unshownPictures'
  | 'linkedPictures'
  | 'charts'
  | 'textBoxes'
  | 'shapes'
  | 'equations'
  | 'noteMarks'
  | 'trackedChanges'
  | 'laterHeaders'
  | 'contentControls'
  | 'columns'
  | 'objects'
  | 'macros'

/** The sentence for each note, in the order notes are given. */
export const NOTES: Readonly<Record<NoteKey, string>> = {
  deepHeadings: 'Headings below level 6 are shown as level 6 headings.',
  headingNumbers: 'Numbered headings keep their numbers as text.',
  listNumbers: 'Some list numbering (such as 01 or First) is shown as plain numbers.',
  hiddenText: 'Hidden text is left out.',
  internalLinks: 'Links to places inside the document are kept as plain text.',
  fields: 'Fields whose result runs over several paragraphs or holds pictures are shown as their last result and no longer update.',
  crossReferences: 'Cross-references keep their last result, but Word cannot update them, as the places they refer to are not kept.',
  pageNumbers: 'Page numbers in letters or Roman numerals, or starting again in a section, are shown as plain numbers counting from the first page.',
  tocOptions: "Tables of contents list the document's headings by level; their other options (such as other styles) are not kept.",
  floatingPictures: 'Pictures placed beside the text are shown in line with it.',
  unshownPictures: 'Pictures in formats Herald Docs cannot show (EMF, WMF or TIFF) are left out.',
  linkedPictures: 'Pictures linked from outside the file are left out.',
  charts: 'Charts and SmartArt are shown as pictures, or left out when the file has no picture of them.',
  textBoxes: 'Text boxes placed beside the text are shown after the paragraph they are anchored to.',
  shapes: 'Shapes other than pictures and text boxes are left out.',
  equations: 'Equations are shown as plain text.',
  noteMarks: 'Footnotes and endnotes with marks of their own (such as *) are numbered instead.',
  trackedChanges: 'Tracked changes are shown accepted, and saving keeps them accepted.',
  laterHeaders: "Headers and footers of later sections are not shown; the first section's are used on every page.",
  contentControls: 'Content controls (form fields, checkboxes) are shown as their text.',
  columns: 'Text in columns is shown in one column, and saving keeps it in one column.',
  objects: 'Embedded objects (such as spreadsheets) are shown as their pictures and are not kept.',
  macros: 'Macros are not kept: Herald Docs saves Word documents without them.'
}

/** The note for styles Herald Docs has no style of its own for, naming up to three. */
export function stylesNote(names: readonly string[]): string {
  const listed = names.slice(0, 3).join(', ')

  return `Styles Herald Docs does not have (${names.length > 3 ? `${listed} and others` : listed}) are kept as the formatting they give the text.`
}

/** The notes for what was found, styles first, then in the order of NOTES. */
export function fidelityNotes(found: ReadonlySet<NoteKey>, unknownStyles: readonly string[]): string[] {
  const notes = unknownStyles.length ? [stylesNote(unknownStyles)] : []

  for (const key of Object.keys(NOTES) as NoteKey[]) {
    if (found.has(key)) {
      notes.push(NOTES[key])
    }
  }

  return notes
}

const columned = (section: XmlElement): boolean => {
  const columns = child(section, 'w:cols')

  return (intOf(attr(columns, 'w:num')) ?? 1) > 1 || children(columns, 'w:col').length > 1
}

/** Whether a section numbers its pages its own way: starting again, or in letters or Roman numerals. */
const ownPageNumbers = (section: XmlElement): boolean => {
  const numbers = child(section, 'w:pgNumType')
  const format = attr(numbers, 'w:fmt')

  return attr(numbers, 'w:start') !== undefined || Boolean(format && format !== 'decimal')
}

/** Whether a section has headers or footers of its own, or a first page of its own. */
const ownHeaders = (section: XmlElement): boolean =>
  children(section, 'w:headerReference').length > 0 || children(section, 'w:footerReference').length > 0 || (child(section, 'w:titlePg') !== undefined && attr(child(section, 'w:titlePg'), 'w:val') !== '0')

/**
 * Notes for what the document's sections and package hold beside its text: later sections' own
 * headers, page numbering of their own, columns, tracked section changes, and macros. `sections`
 * are all the document's w:sectPr, in order.
 */
export function packageNotes(pkg: WordPackage, sections: readonly XmlElement[]): NoteKey[] {
  const found: NoteKey[] = []

  if (sections.slice(1).some(ownHeaders)) {
    found.push('laterHeaders')
  }

  if (sections.some(ownPageNumbers)) {
    found.push('pageNumbers')
  }

  if (sections.some((section) => child(section, 'w:sectPrChange'))) {
    found.push('trackedChanges')
  }

  if (sections.some(columned)) {
    found.push('columns')
  }

  if (pkg.macros) {
    found.push('macros')
  }

  return found
}
