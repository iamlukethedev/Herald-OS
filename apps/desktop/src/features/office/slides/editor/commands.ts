import { atom } from 'nanostores'
import { keysLabel } from '../../../../lib/shortcuts.ts'
import { messageOf } from '../../../canvas/errors.ts'
import type { MenuItemDef } from '../../../files/Menu.tsx'
import type {
  Anchor,
  ArrowHead,
  AutoFit,
  Background,
  Color,
  ConnectorPreset,
  Deck,
  Fill,
  FontRef,
  LayoutId,
  ListKind,
  RunStyle,
  ShapeKind,
  SlideElement,
  SlideSize,
  Stroke,
  TableElement,
  TextAlign,
  TextBody,
  Theme,
  Transition
} from '../deck.ts'
import { findElement } from '../deck.ts'
import type { SlidesDocument } from '../document.ts'
import { lineElement, shapeElement, textElement } from '../elements.ts'
import * as model from '../model.ts'
import type { DeckChange } from '../model.ts'
import { normalizeDeck } from '../normalize.ts'
import { startPresenting } from '../Present.tsx'
import { decks, slidesSession } from '../store.ts'
import { type CellRef, cellUnder, fillCells, nextCell, tableText } from '../tables.ts'
import { allRuns, effectiveStyle, paragraphsAll, styleAll, textBody, withParagraph } from '../text.ts'
import { $textSession, flushTyping, requestEditStart, textSessionOf } from './active.ts'
import { $borderPen, type BorderChoice, bordersFor } from './borders.ts'
import { decksFromDocuments, type FileAccess, officeFiles, pickDocuments, withDocumentSlides } from './from-files.ts'
import { changeParagraphs, selectedParagraphs, shiftLevel, toggleList } from './paragraphs.ts'

/*
 * What the menus, the formatting bar and the keyboard do to the deck in front. Each change is one
 * step (typing in progress is folded in first), and formatting goes to the selected text while
 * typing and to every selected box otherwise.
 */

/** The deck in front in this window. */
export const live = (): SlidesDocument | undefined => {
  const active = slidesSession.active()

  return active ? decks.get(active.key) : undefined
}

/** Make a change to the deck in front (or `doc`) as one step; nothing when it changes nothing. */
export function change<T extends DeckChange>(make: (deck: Deck, doc: SlidesDocument) => T | null | undefined, doc = live()): T | null {
  if (!doc) {
    return null
  }

  flushTyping(doc)
  const next = make(doc.base, doc)

  if (next && next.deck !== doc.base) {
    doc.commit(next)
  }

  return next ?? null
}

const editing = (doc = live()) => textSessionOf(doc)

/** The text bodies formatting applies to among the selection: text boxes' and shapes', and every cell of a table. */
const textBodies = (doc: SlidesDocument): TextBody[] =>
  doc.selection.flatMap((element) => (element.kind === 'text' || element.kind === 'shape' ? [element.body] : element.kind === 'table' ? element.cells.flat().flatMap((cell) => (cell.merged ? [] : [cell.body])) : []))

/** An element with each of its text bodies changed. */
function withBodies(element: SlideElement, edit: (body: TextBody) => TextBody): SlideElement {
  if (element.kind === 'text' || element.kind === 'shape') {
    return { ...element, body: edit(element.body) }
  }

  return element.kind === 'table' ? { ...element, cells: element.cells.map((row) => row.map((cell) => (cell.merged ? cell : { ...cell, body: edit(cell.body) }))) } : element
}

function changeBodies(label: string, edit: (body: TextBody) => TextBody, doc = live()): void {
  change((deck, d) => {
    const ids = d.selection.filter((element) => element.kind === 'text' || element.kind === 'shape' || element.kind === 'table').map((element) => element.id)

    return ids.length ? model.updateElements(deck, d.slideId, ids, (element) => withBodies(element, edit), label) : null
  }, doc)
}

/** The selected table, when the selection is one table. */
function selectedTable(doc: SlidesDocument | undefined): TableElement | null {
  const [only] = doc?.selection ?? []

  return doc?.selected.length === 1 && only?.kind === 'table' ? only : null
}

/** The text of the selected table's cell being typed into. */
function typingCellBody(doc: SlidesDocument): TextBody | undefined {
  const table = selectedTable(doc)
  const cell = doc.editing ? doc.cell : null

  return table && cell ? table.cells[cell.row][cell.column].body : undefined
}

export const notify = (message: string): void => slidesSession.notify(message, 'error')

/** Present the deck in front, from the slide in front or from the start. */
export function present(fromStart: boolean): void {
  const active = slidesSession.active()
  const doc = live()

  if (active && doc) {
    flushTyping(doc)
    doc.edit(null)
    startPresenting(active.key, fromStart ? 0 : doc.index)
  }
}

export const newSlide = (layout: LayoutId = 'title-content') => change((deck, doc) => model.addSlide(deck, { layout, after: doc.slideId }))

export const duplicateSlides = () => change((deck, doc) => model.duplicateSlides(deck, doc.pickedSlides))

export const deleteSlides = () => change((deck, doc) => model.removeSlides(deck, doc.pickedSlides))

export function toggleHidden(): void {
  change((deck, doc) => {
    const picked = doc.pickedSlides
    const hide = !picked.every((id) => deck.slides.find((slide) => slide.id === id)?.hidden)

    return model.setHidden(deck, picked, hide)
  })
}

export function moveSlidesBy(by: number): void {
  change((deck, doc) => {
    const picked = doc.pickedSlides
    const first = deck.slides.findIndex((slide) => slide.id === picked[0])

    return model.moveSlides(deck, picked, Math.max(0, first + by))
  })
}

export const moveSlidesTo = (ids: string[], index: number) => change((deck) => model.moveSlides(deck, ids, index))

export const setLayout = (layout: LayoutId) => change((deck, doc) => model.setLayout(deck, doc.slideId, layout))

export const applyTheme = (theme: Theme | string) => change((deck) => model.applyTheme(deck, theme))

export const setBackground = (background: Background | null, all = false) => change((deck, doc) => model.setBackground(deck, all ? 'all' : doc.pickedSlides, background))

export const setSlideSize = (size: SlideSize) => change((deck) => model.setSize(deck, size))

export const setTransition = (transition: Transition) => change((deck) => model.setTransition(deck, transition))

/** A new text box in the middle of the slide, ready to type into. */
export function insertText(): void {
  const doc = live()

  if (!doc) {
    return
  }

  const { width, height } = doc.deck.size
  const element = textElement({ x: width / 2 - 180, y: height / 2 - 20, width: 360, height: 40 }, textBody({ font: '+body', size: 24, color: 'tx1' }, { fit: 'grow' }))
  change((deck) => model.insertElements(deck, doc.slideId, [element], 'New Text Box'), doc)
  requestEditStart({ elementId: element.id, select: 'end' })
  doc.edit(element.id)
}

export function insertShape(kind: ShapeKind): void {
  const doc = live()

  if (!doc) {
    return
  }

  const { width, height } = doc.deck.size
  const side = kind === 'rect' || kind === 'roundRect' || kind.includes('Arrow') || kind.includes('Callout') ? { w: 240, h: 150 } : { w: 180, h: 180 }
  const element = shapeElement(kind, { x: width / 2 - side.w / 2, y: height / 2 - side.h / 2, width: side.w, height: side.h })
  change((deck) => model.insertElements(deck, doc.slideId, [element], 'New Shape'), doc)
}

export function insertLine(end: ArrowHead = 'none'): void {
  const doc = live()

  if (!doc) {
    return
  }

  const { width, height } = doc.deck.size
  const element = lineElement([width / 2 - 140, height / 2], [width / 2 + 140, height / 2], { end })
  change((deck) => model.insertElements(deck, doc.slideId, [element], end === 'none' ? 'New Line' : 'New Arrow'), doc)
}

export const CONNECTOR_NAMES = { straightConnector1: 'Straight', bentConnector3: 'Elbow', curvedConnector3: 'Curved' } as const satisfies Partial<Record<ConnectorPreset, string>>

/** The connector the next drag on the slide draws, from where it starts to where it ends, each end glued to the site it is near. */
export const $drawing = atom<keyof typeof CONNECTOR_NAMES | null>(null)

export function drawConnector(preset: keyof typeof CONNECTOR_NAMES, doc = live()): void {
  if (!doc) {
    return
  }

  textSessionOf(doc)?.finish()
  doc.edit(null)
  $drawing.set(preset)
  slidesSession.notify('Drag from one shape to another to join them; Escape stops drawing')
}

/** A table of `rows` by `columns` in the middle of the slide, typing in its first cell, as PowerPoint inserts one; its id. */
export function insertTable(rows: number, columns: number, doc = live()): string | null {
  const added = doc ? change((deck) => model.addTable(deck, doc.slideId, { rows, columns }), doc) : null

  if (!doc || !added) {
    return null
  }

  requestEditStart({ elementId: added.elementId, select: 'end' })
  doc.goToCell(added.elementId, { row: 0, column: 0 }, true)

  return added.elementId
}

/** Start typing into a cell of the selected table (rows and columns count from 0; a covered cell is typed into as the merged cell over it). */
export function editCell(row: number, column: number, select: 'end' | 'all' = 'end', doc = live()): void {
  const table = selectedTable(doc)

  if (!doc || !table || !table.cells[row]?.[column]) {
    return
  }

  textSessionOf(doc)?.finish()
  requestEditStart({ elementId: table.id, select })
  doc.goToCell(table.id, cellUnder(table, { row, column }), true)
}

/** Typing moves to the next cell of the selected table, or back one; past the last cell a new row comes first, as in PowerPoint. */
export function moveCell(by: 1 | -1, doc = live()): void {
  const table = selectedTable(doc)
  const cell = doc?.cell

  if (!doc || !table || !cell) {
    return
  }

  let next = nextCell(table, cell, by)

  if (!next && by < 0) {
    return
  }

  textSessionOf(doc)?.finish()

  if (!next) {
    change((deck) => model.insertTableRow(deck, doc.slideId, table.id, table.rows.length - 1, 'below'), doc)
    const grown = findElement(doc.slide, table.id)
    next = grown?.kind === 'table' && grown.rows.length > table.rows.length ? { row: table.rows.length, column: 0 } : cell
  }

  requestEditStart({ elementId: table.id, select: 'all' })
  doc.goToCell(table.id, next, true)
}

/**
 * A change to the selected table about its current cell, as one step: `make` gives the change and
 * the cell to be in afterwards. Typing in the table ends first and goes on in that cell.
 */
function changeAtCell(doc: SlidesDocument | undefined, make: (deck: Deck, slideId: string, table: TableElement, cell: CellRef | null) => { change: DeckChange; cell: CellRef | null } | null): void {
  const table = selectedTable(doc)

  if (!doc || !table) {
    return
  }

  const cell = doc.cell
  const typing = doc.editing === table.id && Boolean(textSessionOf(doc))
  textSessionOf(doc)?.finish()
  const deck = doc.base
  const made = make(deck, doc.slideId, model.requireTable(deck, doc.slideId, table.id), cell)

  if (!made) {
    return
  }

  change(() => made.change, doc)
  const after = findElement(doc.slide, table.id)
  const at = made.change.deck === deck ? cell : made.cell

  if (after?.kind === 'table' && at) {
    if (typing) {
      requestEditStart({ elementId: table.id, select: 'end' })
    }

    doc.goToCell(table.id, cellUnder(after, at), typing)
  }
}

const reachOf = (table: TableElement, cell: CellRef) => ({ rows: table.cells[cell.row][cell.column].rowSpan ?? 1, columns: table.cells[cell.row][cell.column].colSpan ?? 1 })

/** A new row above or below the selected table's current cell (above the first row or below the last without one). */
export function insertRow(where: 'above' | 'below', doc = live()): void {
  changeAtCell(doc, (deck, slideId, table, cell) => {
    const row = cell ? (where === 'above' ? cell.row : cell.row + reachOf(table, cell).rows - 1) : where === 'above' ? 0 : table.rows.length - 1

    return { change: model.insertTableRow(deck, slideId, table.id, row, where), cell: cell && where === 'above' ? { ...cell, row: cell.row + 1 } : cell }
  })
}

/** A new column left or right of the selected table's current cell (left of the first column or right of the last without one). */
export function insertColumn(where: 'left' | 'right', doc = live()): void {
  changeAtCell(doc, (deck, slideId, table, cell) => {
    const column = cell ? (where === 'left' ? cell.column : cell.column + reachOf(table, cell).columns - 1) : where === 'left' ? 0 : table.columns.length - 1

    return { change: model.insertTableColumn(deck, slideId, table.id, column, where), cell: cell && where === 'left' ? { ...cell, column: cell.column + 1 } : cell }
  })
}

/** Delete the rows the selected table's current cell is in; the table goes with its last row. */
export function deleteRows(doc = live()): void {
  changeAtCell(doc, (deck, slideId, table, cell) => (cell ? { change: model.removeTableRows(deck, slideId, table.id, Array.from({ length: reachOf(table, cell).rows }, (_, k) => cell.row + k)), cell } : null))
}

/** Delete the columns the selected table's current cell is in; the table goes with its last column. */
export function deleteColumns(doc = live()): void {
  changeAtCell(doc, (deck, slideId, table, cell) => (cell ? { change: model.removeTableColumns(deck, slideId, table.id, Array.from({ length: reachOf(table, cell).columns }, (_, k) => cell.column + k)), cell } : null))
}

/** Whether the selection is one table with a current cell, for the row and column commands that need one. */
export const hasTableCell = (doc = live()): boolean => Boolean(selectedTable(doc) && doc?.cell)

/** A fill for cells of the selected table: those given, or else the cell being typed into, or else every cell. */
export function setCellFill(fill: Fill | null, cells?: readonly CellRef[] | 'all', doc = live()): void {
  const table = selectedTable(doc)
  const typing = doc?.editing === table?.id ? doc?.cell : null

  if (doc && table) {
    change((deck) => model.setCellFill(deck, doc.slideId, table.id, cells ?? (typing ? [typing] : 'all'), fill), doc)
  }
}

/** Borders on the selected table's cell being typed into, or else on all its cells, in the border pen (or none). */
export function setBorders(choice: BorderChoice, doc = live()): void {
  const table = selectedTable(doc)
  const typing = doc?.editing === table?.id ? (doc?.cell ?? null) : null

  if (doc && table) {
    const { cells, sides, stroke } = bordersFor(choice, $borderPen.get(), typing)
    change((deck) => model.setCellBorders(deck, doc.slideId, table.id, cells, sides, stroke), doc)
  }
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif'])
const LONGEST_SIDE = 4096

const readAsDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

/**
 * A picture file as image data PowerPoint takes (PNG, JPEG or GIF; other kinds become PNG) and its
 * size; very large pictures are scaled down to 4096 pixels on their longest side.
 */
export async function readPicture(file: Blob): Promise<{ src: string; natural: { width: number; height: number } }> {
  const bitmap = await createImageBitmap(file)

  try {
    const natural = { width: bitmap.width, height: bitmap.height }
    const scale = Math.min(1, LONGEST_SIDE / Math.max(natural.width, natural.height))

    if (IMAGE_TYPES.has(file.type) && scale === 1) {
      return { src: await readAsDataUrl(file), natural }
    }

    const width = Math.max(1, Math.round(natural.width * scale))
    const height = Math.max(1, Math.round(natural.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height)
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'

    return { src: await readAsDataUrl(await canvas.convertToBlob({ type, quality: 0.9 })), natural: { width, height } }
  } finally {
    bitmap.close()
  }
}

/** Pictures put on the slide in front, centred on `at` (points) when given. */
export async function insertPictures(files: readonly Blob[], at?: [number, number], doc = live()): Promise<void> {
  if (!doc) {
    return
  }

  for (const [index, file] of files.entries()) {
    try {
      const picture = await readPicture(file)
      const slideId = doc.slideId
      change((deck) => {
        const placed = model.addImage(deck, slideId, { src: picture.src, natural: picture.natural })

        if (!at) {
          return placed
        }

        const element = placed.deck.slides.find((slide) => slide.id === slideId)?.elements.find((entry) => entry.id === placed.elementId)

        return element ? model.updateElements(placed.deck, slideId, [element.id], (entry) => ({ ...entry, x: at[0] - entry.width / 2 + index * 16, y: at[1] - entry.height / 2 + index * 16 }), placed.label) : placed
      }, doc)
    } catch {
      slidesSession.notify('Herald Slides could not read that picture', 'error')
    }
  }
}

let picker: HTMLInputElement | null = null

/** Ask for picture files, then put them on the slide (into an empty picture placeholder first). */
export function pickPictures(doc = live()): void {
  picker ??= Object.assign(document.createElement('input'), { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml', multiple: true })
  picker.onchange = () => {
    const files = [...(picker?.files ?? [])]
    picker!.value = ''
    void insertPictures(files, undefined, doc)
  }
  picker.click()
}

/** New presentations made from documents picked, in the theme of the deck in front. */
export async function newFromDocument(access: FileAccess = officeFiles()): Promise<void> {
  for (const { name, deck } of await decksFromDocuments(access, notify, live()?.presentation.theme)) {
    slidesSession.create({ name, model: deck })
  }
}

/** The slides of documents picked, after the slide in front, as one step. */
export async function insertSlidesFromDocument(access: FileAccess = officeFiles(), doc = live()): Promise<void> {
  const picked = doc ? await pickDocuments(access, notify) : []

  if (!doc || !picked.length) {
    return
  }

  const files = picked.map((entry) => entry.file).join(', ')

  try {
    const made = change((deck, d) => withDocumentSlides(deck, picked.map((entry) => entry.doc), d.slideId), doc)

    if (made && !made.slideIds.length) {
      notify(`${files} ${picked.length > 1 ? 'have' : 'has'} nothing to make slides of`)
    }
  } catch (error) {
    notify(`Could not make slides from ${files}: ${messageOf(error)}`)
  }
}

export const deleteSelection = () => change((deck, doc) => (doc.selected.length ? model.removeElements(deck, doc.slideId, doc.selected) : null))

export const duplicateSelection = () => change((deck, doc) => (doc.selected.length ? model.duplicateElements(deck, doc.slideId, doc.selected) : null))

export function selectAll(): void {
  const doc = live()
  doc?.select(doc.slide.elements.map((element) => element.id))
}

export const arrange = (how: model.Arrangement) => change((deck, doc) => (doc.selected.length ? model.arrange(deck, doc.slideId, doc.selected, how) : null))

export const alignSelection = (edge: model.AlignEdge) => change((deck, doc) => (doc.selected.length ? model.align(deck, doc.slideId, doc.selected, edge) : null))

export const distributeSelection = (axis: 'horizontal' | 'vertical') => change((deck, doc) => (doc.selected.length > 2 ? model.distribute(deck, doc.slideId, doc.selected, axis) : null))

export const nudgeSelection = (dx: number, dy: number) => change((deck, doc) => (doc.selected.length ? model.nudge(deck, doc.slideId, doc.selected, dx, dy) : null))

/** Whether grouping the selection makes a group: it has two elements or groups (placeholders aside). */
export function canGroup(doc = live()): boolean {
  if (!doc?.selected.length) {
    return false
  }

  const ids = new Set(model.expandToGroups(doc.slide, doc.selected))

  return new Set(doc.slide.elements.filter((element) => ids.has(element.id) && !element.placeholder).map((element) => element.group?.[0] ?? element.id)).size > 1
}

export const canUngroup = (doc = live()): boolean => Boolean(doc?.selection.some((element) => element.group?.length))

/** Whether the selection has a kept object with a drawing of its own (SmartArt) to turn into shapes. */
export const canConvert = (doc = live()): boolean => Boolean(doc?.selection.some((element) => element.kind === 'object' && element.shapes?.length))

export const groupSelection = (doc = live()) => change((deck, d) => (d.selected.length ? model.groupElements(deck, d.slideId, d.selected) : null), doc)

export const ungroupSelection = (doc = live()) => change((deck, d) => (d.selected.length ? model.ungroupElements(deck, d.slideId, d.selected) : null), doc)

export const convertSelection = (doc = live()) => change((deck, d) => (d.selected.length ? model.convertToShapes(deck, d.slideId, d.selected) : null), doc)

/** The slide's context menu items for grouping and for kept objects: those that do something to the selection. */
export function selectionMenuItems(doc = live()): MenuItemDef[] {
  const items: MenuItemDef[] = [
    ...(canGroup(doc) ? [{ id: 'group', label: 'Group', hint: keysLabel('mod+alt+g'), onSelect: () => groupSelection(doc) }] : []),
    ...(canUngroup(doc) ? [{ id: 'ungroup', label: 'Ungroup', hint: keysLabel('mod+alt+shift+g'), onSelect: () => ungroupSelection(doc) }] : []),
    ...(canConvert(doc) ? [{ id: 'convert', label: 'Convert to Shapes', onSelect: () => convertSelection(doc) }] : [])
  ]

  return items.map((item, index) => ({ ...item, dividerBefore: index === 0 }))
}

/** Start typing into the selected text box or shape, or the selected table's current cell. */
export function editSelection(select: 'end' | 'all' = 'end'): void {
  const doc = live()
  const [only] = doc?.selection ?? []

  if (doc && only && doc.selected.length === 1 && (only.kind === 'text' || only.kind === 'shape' || only.kind === 'table')) {
    requestEditStart({ elementId: only.id, select })
    doc.edit(only.id)
  }
}

export const changeSelected = (label: string, edit: (element: SlideElement) => SlideElement) => change((deck, doc) => (doc.selected.length ? model.updateElements(deck, doc.slideId, doc.selected, edit, label) : null))

/** A fill for shapes and text boxes, and for a table the cell being typed into or else every cell; fills with the same `join` in quick succession are one step (a gradient being tuned). */
export function setFill(fill: Fill | null, doc = live(), join?: string): void {
  change((deck, d) => {
    const typing = d.editing ? d.cell : null
    const fillOf = (element: SlideElement): SlideElement =>
      element.kind === 'shape' || element.kind === 'text' ? { ...element, fill } : element.kind === 'table' ? fillCells(element, typing && d.editing === element.id ? [typing] : 'all', fill) : element

    return d.selected.length ? { ...model.updateElements(deck, d.slideId, d.selected, fillOf, 'Fill'), ...(join ? { join: `${join}:${d.selected.join(',')}` } : {}) } : null
  }, doc)
}

/** The outline of shapes, text boxes and pictures, and the stroke of lines (which always have one). */
export function setStroke(patch: Partial<Stroke> | null): void {
  changeSelected('Outline', (element) => {
    if (element.kind === 'line') {
      return patch ? { ...element, stroke: { ...element.stroke, ...patch } } : element
    }

    if (element.kind === 'object') {
      return element
    }

    const base: Stroke = element.stroke ?? { color: 'tx1', width: 1, dash: 'solid' }

    return { ...element, stroke: patch ? { ...base, ...patch } : null }
  })
}

export const setArrowHeads = (patch: { start?: ArrowHead; end?: ArrowHead }) => changeSelected('Arrows', (element) => (element.kind === 'line' ? { ...element, ...patch } : element))

export const setShapeKind = (shape: ShapeKind) => changeSelected('Change Shape', (element) => (element.kind === 'shape' ? { ...element, shape, adjust: undefined } : element))

export const resetCrop = () => changeSelected('Reset Crop', (element) => (element.kind === 'image' ? { ...element, crop: undefined } : element))

export const setAlt = (alt: string) => changeSelected('Description', (element) => (element.kind === 'image' ? { ...element, alt } : element))

export type Switch = 'bold' | 'italic' | 'underline' | 'strike'

const SWITCH_LABELS: Record<Switch, string> = { bold: 'Bold', italic: 'Italic', underline: 'Underline', strike: 'Strikethrough' }

export function toggleSwitch(key: Switch): void {
  const session = editing()

  if (session) {
    session.editor.chain().focus().toggleMark(key).run()

    return
  }

  const doc = live()

  if (!doc) {
    return
  }

  const on = !textBodies(doc).every((body) => allRuns(body, key, true))
  changeBodies(SWITCH_LABELS[key], (body) => styleAll(body, { [key]: on }), doc)
}

const RUN_LABELS: Record<keyof RunStyle, string> = { font: 'Font', size: 'Text Size', color: 'Text Colour', highlight: 'Highlight', bold: 'Bold', italic: 'Italic', underline: 'Underline', strike: 'Strikethrough' }

/** A font, size, colour or highlight for the selected text (`null` takes it back to the box's own). */
export function setRunStyle(patch: { font?: FontRef | null; size?: number | null; color?: Color | null; highlight?: Color | null }): void {
  const session = editing()
  const key = Object.keys(patch)[0] as keyof RunStyle

  if (session) {
    const chain = session.editor.chain().focus().setMark('textStyle', patch)
    const clears = Object.values(patch).some((value) => value === null)
    ;(clears ? chain.removeEmptyTextStyle() : chain).run()

    return
  }

  changeBodies(RUN_LABELS[key] ?? 'Text', (body) => {
    const set = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null)) as RunStyle
    const cleared = (Object.keys(patch) as (keyof RunStyle)[]).filter((name) => patch[name as keyof typeof patch] === null)
    const next = styleAll(body, set)

    if (!cleared.length) {
      return next
    }

    const style = { ...next.style }

    // Only a highlight can leave the box's own style; the others go back to it.
    if (cleared.includes('highlight')) {
      delete style.highlight
    }

    return {
      ...next,
      style,
      paragraphs: next.paragraphs.map((paragraph) => ({
        ...paragraph,
        runs: paragraph.runs.map((run) => {
          const plain = { ...run }

          for (const name of cleared) {
            delete plain[name]
          }

          return plain
        })
      }))
    }
  })
}

/** The text size one step up or down from the selection's. */
export function stepSize(direction: 1 | -1): void {
  const sizes = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96, 120, 144]
  const current = currentFormat().size
  const next = direction > 0 ? (sizes.find((size) => size > current + 0.01) ?? current + 12) : ([...sizes].reverse().find((size) => size < current - 0.01) ?? Math.max(1, current - 1))
  setRunStyle({ size: next })
}

export function setAlign(align: TextAlign): void {
  const session = editing()

  if (session) {
    changeParagraphs(session.editor, () => ({ align }))

    return
  }

  changeBodies('Align Text', (body) => paragraphsAll(body, { align }))
}

export function toggleListKind(kind: ListKind): void {
  const session = editing()

  if (session) {
    toggleList(session.editor, kind)

    return
  }

  const doc = live()

  if (!doc) {
    return
  }

  const all = textBodies(doc).every((body) => body.paragraphs.every((paragraph) => paragraph.list === kind))
  changeBodies(kind === 'bullet' ? 'Bullets' : 'Numbering', (body) => ({ ...body, paragraphs: body.paragraphs.map((paragraph) => withParagraph(paragraph, all ? { list: undefined, level: undefined } : { list: kind })) }), doc)
}

export function shiftLevels(by: 1 | -1): void {
  const session = editing()

  if (session) {
    shiftLevel(session.editor, by)

    return
  }

  changeBodies(by > 0 ? 'Increase Level' : 'Decrease Level', (body) => ({
    ...body,
    paragraphs: body.paragraphs.map((paragraph) => (paragraph.list ? withParagraph(paragraph, { level: Math.max(0, Math.min(8, (paragraph.level ?? 0) + by)), bullet: undefined, numbering: undefined }) : paragraph))
  }))
}

export function setLineSpacing(lineSpacing: number): void {
  const session = editing()

  if (session) {
    changeParagraphs(session.editor, () => ({ lineSpacing: lineSpacing === 1 ? null : lineSpacing }))

    return
  }

  changeBodies('Line Spacing', (body) => paragraphsAll(body, { lineSpacing: lineSpacing === 1 ? undefined : lineSpacing }))
}

export const setAnchor = (anchor: Anchor) => changeBodies('Text Position', (body) => ({ ...body, anchor }))

export const setAutoFit = (fit: AutoFit) => changeBodies('Autofit', (body) => ({ ...body, fit }))

export interface Format {
  font: FontRef
  size: number
  color: Color
  highlight: Color | null
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  align: TextAlign
  list: ListKind | null
  lineSpacing: number
}

/** The formatting of the text being edited at its selection, or of the first selected box. */
export function currentFormat(doc = live()): Format {
  const session = textSessionOf(doc)
  const body = (doc && ((session ? typingCellBody(doc) : undefined) ?? textBodies(doc)[0])) ?? textBody({ font: '+body', size: 18, color: 'tx1' })

  if (session) {
    const { editor } = session
    const style = editor.getAttributes('textStyle')
    const paragraph = selectedParagraphs(editor)[0]?.node.attrs ?? {}

    return {
      font: style.font ?? body.style.font,
      size: Number(style.size ?? body.style.size),
      color: style.color ?? body.style.color,
      highlight: style.highlight ?? null,
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      underline: editor.isActive('underline'),
      strike: editor.isActive('strike'),
      align: paragraph.align ?? 'left',
      list: paragraph.list ?? null,
      lineSpacing: Number(paragraph.lineSpacing ?? 1)
    }
  }

  const first = body.paragraphs[0]
  const run = effectiveStyle(first?.runs[0] ?? {}, body)

  return {
    font: run.font,
    size: run.size,
    color: run.color,
    highlight: run.highlight ?? null,
    bold: allRuns(body, 'bold', true),
    italic: allRuns(body, 'italic', true),
    underline: allRuns(body, 'underline', true),
    strike: allRuns(body, 'strike', true),
    align: first?.align ?? 'left',
    list: first?.list ?? null,
    lineSpacing: first?.lineSpacing ?? 1
  }
}

/** Whether text formatting has anything to work on. */
export const canFormatText = (doc = live()): boolean => Boolean($textSession.get()?.doc === doc && doc) || Boolean(doc && textBodies(doc).length)

const CLIPBOARD_TYPE = 'application/x-herald-slides'

/** The selection on the clipboard: Herald's own copy, and its words as text for other apps. */
export function copySelection(data: DataTransfer, doc = live()): boolean {
  const chosen = doc?.selection ?? []

  if (!chosen.length) {
    return false
  }

  data.setData(CLIPBOARD_TYPE, JSON.stringify({ elements: chosen }))
  data.setData(
    'text/plain',
    chosen
      .map((element) => (element.kind === 'text' || element.kind === 'shape' ? element.body.paragraphs.map((paragraph) => paragraph.runs.map((run) => run.text).join('')).join('\n') : element.kind === 'table' ? tableText(element) : ''))
      .filter(Boolean)
      .join('\n\n')
  )

  return true
}

/** Copy (or cut) the selection from a menu: the copy event goes to the page, whatever has focus. */
export function copyToClipboard(cut = false, doc = live()): void {
  const onCopy = (event: ClipboardEvent) => {
    if (event.clipboardData && copySelection(event.clipboardData, doc)) {
      event.preventDefault()

      if (cut) {
        deleteSelection()
      }
    }
  }

  document.addEventListener('copy', onCopy, { once: true, capture: true })
  document.execCommand('copy')
  document.removeEventListener('copy', onCopy, { capture: true })
}

/** Elements copied from Herald Slides, made safe. */
export function clipboardElements(text: string): SlideElement[] {
  try {
    const parsed = JSON.parse(text) as { elements?: unknown }

    return normalizeDeck({ slides: [{ elements: parsed.elements }] }).slides[0].elements
  } catch {
    return []
  }
}

/** Paste what the clipboard holds: Herald's own elements, pictures, or text as a new text box. */
export async function pasteFrom(data: DataTransfer, doc = live()): Promise<boolean> {
  if (!doc) {
    return false
  }

  const own = data.getData(CLIPBOARD_TYPE)

  if (own) {
    const elements = clipboardElements(own)
    const onSlide = new Set(doc.slide.elements.map((element) => element.id))
    const offset = elements.some((element) => onSlide.has(element.id)) ? 12 : 0

    change((deck) => (elements.length ? model.pasteElements(deck, doc.slideId, elements, offset) : null), doc)

    return elements.length > 0
  }

  const pictures = [...data.files].filter((file) => file.type.startsWith('image/'))

  if (pictures.length) {
    await insertPictures(pictures, undefined, doc)

    return true
  }

  const text = data.getData('text/plain').trim()

  if (text) {
    change((deck) => model.addText(deck, doc.slideId, { text }), doc)

    return true
  }

  return false
}
