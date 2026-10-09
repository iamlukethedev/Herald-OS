import { describe, expect, it } from 'vitest'
import { type DocJSON, type DocNode, paragraphNode, textNode } from '../../../../../shared/office/document.ts'
import { docxFromDocument } from '../../../../../shared/office/docx/write.ts'
import { CELL_TYPE, newSheet, newWorkbook } from '../../../../../shared/office/workbook.ts'
import { xlsxFromWorkbook } from '../../../../../shared/office/xlsx/write.ts'
import { type Deck, findSlide, type TableElement } from '../deck.ts'
import * as model from '../model.ts'
import { THEMES } from '../themes.ts'
import { plainText } from '../text.ts'
import { decksFromDocuments, type FileAccess, pickDocuments, pickWorkbook, placeSheet, rangeSummary, withDocumentSlides } from './from-files.ts'

const doc = (...content: DocNode[]): DocJSON => ({ type: 'doc', attrs: { page: null, styles: null }, content })
const h = (level: number, text: string): DocNode => ({ type: 'heading', attrs: { level }, content: [textNode(text)] })
const p = (text: string): DocNode => paragraphNode([textNode(text)])
const ul = (...items: string[]): DocNode => ({ type: 'bulletList', content: items.map((item) => ({ type: 'listItem', content: [p(item)] })) })

/** Herald's open dialog and file reading, standing in: what each app's dialog picks and the files there are, noting which dialogs opened and which files were read. */
function access(files: Record<string, Uint8Array | string>, picked: Partial<Record<'docs' | 'sheets', string[]>>): FileAccess & { asked: string[]; reads: string[] } {
  const asked: string[] = []
  const reads: string[] = []

  return {
    asked,
    reads,
    pickOpen: async (app) => {
      asked.push(app)

      return picked[app] ?? []
    },
    read: async (file) => {
      const content = files[file]
      reads.push(file)

      if (content === undefined) {
        throw new Error(`There is no file at ${file}`)
      }

      return { bytes: typeof content === 'string' ? new TextEncoder().encode(content) : content }
    }
  }
}

const PLAN = '# Plan\n\nWhy we do it.\n\n## Goals\n\n- Ship it\n- Test it\n'

const titles = (deck: Deck) => deck.slides.map(model.slideTitle)

const tablesOn = (deck: Deck, slideId: string): TableElement[] => findSlide(deck, slideId)!.elements.filter((element): element is TableElement => element.kind === 'table')

const texts = (table: TableElement) => table.cells.map((row) => row.map((cell) => plainText(cell.body)))

describe('decks from documents', () => {
  it('reads Markdown, plain text and Word documents as Herald Docs does, each a deck titled by its file in the theme given', async () => {
    const word = await docxFromDocument(doc(h(1, 'Report'), p('Quarterly numbers.'), h(2, 'Sales'), ul('North is up', 'South is flat')))
    const files = access({ '/notes/Plan.md': PLAN, '/notes/Ideas.txt': 'Ideas\n\nA faster start.', '/notes/Report.docx': word.bytes }, { docs: ['/notes/Plan.md', '/notes/Ideas.txt', '/notes/Report.docx'] })
    const reported: string[] = []
    const theme = THEMES[2]
    const made = await decksFromDocuments(files, (message) => reported.push(message), theme)

    expect(files.asked).toEqual(['docs'])
    expect(reported).toEqual([])
    expect(made.map((entry) => entry.name)).toEqual(['Plan', 'Ideas', 'Report'])
    expect(made.every((entry) => entry.deck.theme.id === theme.id)).toBe(true)
    expect(titles(made[0].deck)).toEqual(['Plan', 'Goals'])
    expect(titles(made[2].deck)).toEqual(['Report', 'Sales'])
    expect(made[0].deck.title).toBe('Plan')
  })

  it('reports a file it cannot read by its name, and goes on with the rest', async () => {
    const files = access({ '/notes/Broken.docx': new Uint8Array([1, 2, 3, 4]), '/notes/Plan.md': PLAN, '/notes/Old.odt': 'odt' }, { docs: ['/notes/Broken.docx', '/notes/Gone.md', '/notes/Old.odt', '/notes/Plan.md'] })
    const reported: string[] = []
    const picked = await pickDocuments(files, (message) => reported.push(message))

    expect(picked.map((entry) => entry.file)).toEqual(['Plan.md'])
    expect(reported).toHaveLength(3)
    expect(reported[0]).toMatch(/^Could not read Broken\.docx: /)
    expect(reported[1]).toMatch(/^Could not read Gone\.md: There is no file/)
    expect(reported[2]).toBe('Could not read Old.odt: Herald Slides cannot make slides from .odt files')
  })

  it('puts the slides of documents after the slide in front, one document after another, as one step', async () => {
    const deck = model.addSlide(model.newDeck('Pitch'), { layout: 'title-content', title: 'Last' }).deck
    const [first, last] = deck.slides
    const alpha = doc(h(1, 'Alpha'), ul('One', 'Two'))
    const beta = doc(h(2, 'Beta'), ul('Three'))
    const alone = (document: DocJSON) => {
      const made = model.slidesFromDocument(deck, document)

      return made.slideIds.map((id) => model.slideTitle(findSlide(made.deck, id)!))
    }
    const change = withDocumentSlides(deck, [alpha, beta], first.id)

    expect(change.label).toBe('Slides from Document')
    expect(change.deck.slides[0].id).toBe(first.id)
    expect(change.deck.slides.at(-1)?.id).toBe(last.id)
    expect(change.slideIds).toHaveLength(change.deck.slides.length - 2)
    expect(change.deck.slides.slice(1, -1).map((slide) => slide.id)).toEqual(change.slideIds)
    expect(alone(alpha)[0]).toBe('Alpha')
    expect(titles(change.deck).slice(1, -1)).toEqual([...alone(alpha), ...alone(beta)])
    expect(change.focus).toEqual({ slideId: change.slideIds[0], selected: [] })
    expect(withDocumentSlides(deck, [], first.id)).toMatchObject({ deck, slideIds: [] })
  })
})

describe('tables from spreadsheets', () => {
  const sales = () => newWorkbook('book', 'Sales', [newSheet('s1', 'Sales', { 0: { 0: { v: 'Region', t: CELL_TYPE.string }, 1: { v: 'Units', t: CELL_TYPE.string } }, 1: { 0: { v: 'North', t: CELL_TYPE.string }, 1: { v: 120, t: CELL_TYPE.number } }, 2: { 0: { v: 'South', t: CELL_TYPE.string }, 1: { v: 80, t: CELL_TYPE.number } } }), newSheet('s2', 'Empty')])

  it('reads a CSV file and an Excel workbook as Herald Sheets does, the first picked only', async () => {
    const xlsx = await xlsxFromWorkbook(sales())
    const files = access({ '/books/Sales.csv': 'Region,Units\nNorth,120\nSouth,80\n', '/books/Sales.xlsx': xlsx.bytes }, { sheets: ['/books/Sales.csv', '/books/Sales.xlsx'] })
    const csv = await pickWorkbook(files, () => {})

    expect(files.asked).toEqual(['sheets'])
    expect(files.reads).toEqual(['/books/Sales.csv'])
    expect(csv?.file).toBe('Sales.csv')
    expect(rangeSummary(csv!.workbook, csv!.workbook.sheetOrder[0], '')).toEqual({ ref: 'A1:B3', rows: 3, columns: 2 })

    const excel = await pickWorkbook(access({ '/books/Sales.xlsx': xlsx.bytes }, { sheets: ['/books/Sales.xlsx'] }), () => {})
    const names = excel!.workbook.sheetOrder.map((id) => excel!.workbook.sheets[id].name)

    expect(names).toEqual(['Sales', 'Empty'])
    expect(rangeSummary(excel!.workbook, excel!.workbook.sheetOrder[0], '')).toMatchObject({ ref: 'A1:B3', rows: 3, columns: 2 })
  })

  it('reports a spreadsheet it cannot read by its name, and takes nothing when nothing is picked', async () => {
    const reported: string[] = []

    expect(await pickWorkbook(access({ '/books/Broken.xlsx': new Uint8Array([9, 9, 9]) }, { sheets: ['/books/Broken.xlsx'] }), (message) => reported.push(message))).toBeNull()
    expect(reported[0]).toMatch(/^Could not read Broken\.xlsx: /)
    expect(await pickWorkbook(access({}, {}), (message) => reported.push(message))).toBeNull()
    expect(reported).toHaveLength(1)
  })

  it('sums up a range, or says why it cannot be taken', () => {
    const workbook = sales()

    expect(rangeSummary(workbook, 's1', 'A2:B3')).toEqual({ ref: 'A2:B3', rows: 2, columns: 2 })
    expect(rangeSummary(workbook, 's1', 'here')).toEqual({ error: 'here is not a range of cells; give one such as A1:D10' })
    expect(rangeSummary(workbook, 's1', 'A:B')).toEqual({ ref: 'A1:B3', rows: 3, columns: 2 })
    expect(rangeSummary(workbook, 's2', '')).toEqual({ error: 'Empty is empty' })
  })

  it('places a range as a table on the slide in front, or on slides of its own after it', () => {
    const deck = model.addSlide(model.newDeck('Pitch'), { layout: 'title-only', title: 'Numbers' }).deck
    const slideId = deck.slides[1].id
    const workbook = sales()
    const here = placeSheet(deck, slideId, workbook, { sheet: 's1', range: '', header: true, place: 'slide' })
    const [table] = tablesOn(here.deck, slideId)

    expect(here.deck.slides).toHaveLength(2)
    expect(texts(table)).toEqual([
      ['Region', 'Units'],
      ['North', '120'],
      ['South', '80']
    ])

    const apart = placeSheet(deck, deck.slides[0].id, workbook, { sheet: 's1', range: ' A1:B2 ', header: false, place: 'slides' })
    const added = apart.deck.slides[1]

    expect(apart.deck.slides.map((slide) => slide.id)).toEqual([deck.slides[0].id, added.id, slideId])
    expect(model.slideTitle(added)).toBe('Sales')
    expect(texts(tablesOn(apart.deck, added.id)[0])).toEqual([
      ['Region', 'Units'],
      ['North', '120']
    ])
  })
})
