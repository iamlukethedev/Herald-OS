import { describe, expect, it } from 'vitest'
import { printView } from '../../../../../shared/office/doc-html.ts'
import { type DocJSON, type DocNode, headersOf, HEADER_KINDS, PAGE_SIZES, pageOf, textOf, walk } from '../../../../../shared/office/document.ts'
import { docsSchema } from '../schema.ts'
import { documentFromTemplate, TEMPLATES } from './index.ts'

/** Faces macOS and Windows have, and Linux shows as Liberation's or another lookalike. */
const FONTS = new Set(['Arial', 'Calibri', 'Cambria', 'Georgia', 'Times New Roman'])

const nodesIn = (blocks: DocNode[]): DocNode[] => {
  const out: DocNode[] = []
  walk({ type: 'doc', content: blocks }, (node) => void out.push(node))

  return out.slice(1)
}

const ofType = (blocks: DocNode[], type: string): DocNode[] => nodesIn(blocks).filter((node) => node.type === type)

const fieldKinds = (blocks: DocNode[]): unknown[] => ofType(blocks, 'field').map((node) => node.attrs?.kind)

const textIn = (blocks: DocNode[]): string => blocks.map(textOf).join('\n')

/** Every node and mark is one the schema has, with only attrs it knows (it would drop others), and content that fits. */
function expectValid(blocks: DocNode[], where: string): void {
  const schema = docsSchema()

  if (!blocks.length) {
    return
  }

  schema.nodeFromJSON({ type: 'doc', content: blocks }).check()

  for (const node of nodesIn(blocks)) {
    const type = schema.nodes[node.type]
    expect(type, `${where}: ${node.type}`).toBeDefined()
    expect(Object.keys(type.spec.attrs ?? {}), `${where}: ${node.type}`).toEqual(expect.arrayContaining(Object.keys(node.attrs ?? {})))

    for (const mark of node.marks ?? []) {
      const markType = schema.marks[mark.type]
      expect(markType, `${where}: ${mark.type}`).toBeDefined()
      expect(Object.keys(markType.spec.attrs ?? {}), `${where}: ${mark.type}`).toEqual(expect.arrayContaining(Object.keys(mark.attrs ?? {})))
    }
  }
}

const build = (id: string, locale = 'en-GB'): DocJSON => documentFromTemplate(id, { locale })

const part = (doc: DocJSON, which: 'header' | 'footer', kind: 'default' | 'first' = 'default'): DocNode[] => headersOf(doc)?.[which][kind] ?? []

describe('the built-in templates', () => {
  it('lists the blank document first, then twelve templates with ids of their own', () => {
    expect(TEMPLATES[0]).toMatchObject({ id: 'blank', name: 'Blank document' })
    expect(TEMPLATES).toHaveLength(13)
    expect(new Set(TEMPLATES.map((entry) => entry.id)).size).toBe(13)
    expect(TEMPLATES.every((entry) => entry.name && /\.$/.test(entry.description))).toBe(true)
  })

  it.each(TEMPLATES.map((entry) => entry.id))('%s is valid in the schema, headers and footers too, and prints', (id) => {
    const doc = build(id)

    expect(() => docsSchema().nodeFromJSON(doc).check()).not.toThrow()
    expectValid(doc.content, id)

    for (const which of ['header', 'footer'] as const) {
      for (const kind of HEADER_KINDS) {
        expectValid(headersOf(doc)?.[which][kind] ?? [], `${id} ${which} ${kind}`)
      }
    }

    const firstText = nodesIn(doc.content).find((node) => node.type === 'text')?.text

    expect(id === 'blank' || Boolean(firstText)).toBe(true)
    expect(printView(doc, id)).toContain(firstText ? firstText.replace(/&/g, '&amp;') : '<div class="doc">')
  })

  it.each(TEMPLATES.map((entry) => entry.id))('%s has a look of its own in fonts every system shows, colours as hex, and sensible spacing', (id) => {
    const doc = build(id)
    const styles = doc.attrs?.styles ?? {}
    const page = pageOf(doc)

    for (const look of Object.values(styles)) {
      expect(look.font === undefined || FONTS.has(look.font), `${id}: ${look.font}`).toBe(true)
      expect(look.color === undefined || /^#[0-9a-f]{6}$/i.test(look.color), `${id}: ${look.color}`).toBe(true)
      expect(look.size === undefined || (look.size >= 8 && look.size <= 40)).toBe(true)
      expect(look.lineHeight === undefined || (look.lineHeight >= 1 && look.lineHeight <= 2)).toBe(true)
    }

    for (const node of nodesIn([...doc.content, ...part(doc, 'header'), ...part(doc, 'footer')])) {
      const color = node.marks?.find((mark) => mark.type === 'textStyle')?.attrs?.color ?? node.attrs?.background

      expect(color === undefined || /^#[0-9a-f]{6}$/i.test(String(color))).toBe(true)
    }

    expect(id === 'blank' || FONTS.has(String(styles.normal?.font))).toBe(true)
    expect(Object.values(page.margins).every((margin) => margin >= 28 && margin <= 108)).toBe(true)
    expect(page.width - page.margins.left - page.margins.right).toBeGreaterThan(280)
  })

  it('fills in only made-up details, with addresses at example.com', () => {
    for (const { id } of TEMPLATES) {
      const doc = build(id)
      const text = textIn([...doc.content, ...part(doc, 'header'), ...part(doc, 'footer')])

      for (const address of text.match(/\S+@\S+/g) ?? []) {
        expect(address).toMatch(/@example\.com\.?$/)
      }
    }
  })

  it('heads a letter with a letterhead and dates it today', () => {
    const doc = build('letter')

    expect(textIn(part(doc, 'header'))).toContain('Company Name')
    expect(fieldKinds(doc.content)).toContain('date')
    expect(doc.attrs?.styles?.normal?.font).toBe('Georgia')
    expect(pageOf(doc).margins.top).toBeGreaterThan(pageOf(doc).margins.header! + 40)
  })

  it('gives a CV and its cover letter the same name style, and the CV its name and page numbers at the foot', () => {
    const cv = build('cv')
    const letter = build('cover-letter')

    expect(cv.attrs?.styles?.title?.color).toBe(letter.attrs?.styles?.title?.color)
    expect(cv.attrs?.styles?.title?.font).toBe('Calibri')
    expect(textIn(part(cv, 'footer'))).toContain('Your Name')
    expect(fieldKinds(part(cv, 'footer'))).toEqual(['page', 'pages'])
    expect(ofType(cv.content, 'heading').map(textOf)).toEqual(expect.arrayContaining(['Profile', 'Experience', 'Education', 'Skills']))
    expect(fieldKinds(letter.content)).toContain('date')
  })

  it('gives a report a title page of its own, a table of contents and “Page X of Y” after them', () => {
    const doc = build('report')
    const breaks = doc.content.flatMap((node, index) => (node.type === 'pageBreak' ? [index] : []))

    expect(headersOf(doc)?.differentFirst).toBe(true)
    expect(part(doc, 'header', 'first')).toEqual([])
    expect(part(doc, 'footer', 'first')).toEqual([])
    expect(textIn(part(doc, 'footer'))).toBe('Page  of ')
    expect(fieldKinds(part(doc, 'footer'))).toEqual(['page', 'pages'])
    expect(breaks).toHaveLength(2)
    expect(doc.content[breaks[0] + 1]).toMatchObject({ type: 'tableOfContents', attrs: { levels: 3, title: 'Contents' } })
    expect(doc.content[0].attrs?.docStyle).toBe('title')
    expect(new Set(ofType(doc.content, 'heading').map((node) => node.attrs?.level))).toEqual(new Set([1, 2]))
  })

  it('heads a memo with To, From, Date and Subject', () => {
    const doc = build('memo')
    const [details] = ofType(doc.content, 'table')

    expect(details.attrs?.borders).toBe(false)
    expect(details.content?.map((row) => textOf(row.content![0]))).toEqual(['To', 'From', 'Copy to', 'Date', 'Subject'])
    expect(fieldKinds(details.content!)).toEqual(['date'])
    expect(fieldKinds(part(doc, 'footer'))).toEqual(['page'])
  })

  it('gives meeting notes attendees, an agenda and a checklist of actions', () => {
    const doc = build('meeting-notes')
    const [actions] = ofType(doc.content, 'taskList')

    expect(ofType(doc.content, 'heading').map(textOf)).toEqual(expect.arrayContaining(['Attendees', 'Agenda', 'Notes', 'Decisions', 'Actions']))
    expect(ofType(doc.content, 'orderedList')).toHaveLength(1)
    expect(actions.content?.length).toBeGreaterThanOrEqual(3)
    expect(actions.content?.every((item) => item.attrs?.checked === false)).toBe(true)
  })

  it('double-spaces an essay with indented paragraphs, the page number at the head and hanging indents for sources', () => {
    const doc = build('essay')
    const [header] = part(doc, 'header')
    const indented = doc.content.filter((node) => node.attrs?.firstLine === 36)
    const sources = doc.content.filter((node) => node.attrs?.firstLine === -36)

    expect(doc.attrs?.styles?.normal).toMatchObject({ font: 'Times New Roman', size: 12, lineHeight: 2 })
    expect(header.attrs?.textAlign).toBe('right')
    expect(fieldKinds([header])).toEqual(['page'])
    expect(indented.length).toBeGreaterThanOrEqual(3)
    expect(sources.every((node) => node.attrs?.indent === 36)).toBe(true)
    expect(sources).toHaveLength(3)
  })

  it('lays a proposal’s timeline and budget out in tables with header rows', () => {
    const doc = build('project-proposal')
    const tables = ofType(doc.content, 'table')
    const headed = tables.filter((node) => node.content?.[0].content?.every((cell) => cell.type === 'tableHeader'))

    expect(headed).toHaveLength(2)
    expect(headed.every((node) => node.content![0].content!.every((cell) => cell.attrs?.background === '#ECE9F6'))).toBe(true)
    expect(fieldKinds(part(doc, 'footer'))).toEqual(['page', 'pages'])
  })

  it('makes a newsletter of a masthead, a shaded box of contents, stories and a quote', () => {
    const doc = build('newsletter')

    expect(doc.content[0]).toMatchObject({ type: 'paragraph', attrs: { docStyle: 'title' } })
    expect(ofType(doc.content, 'tableCell').some((cell) => cell.attrs?.background === '#F6E9E3' && textOf(cell).includes('In this issue'))).toBe(true)
    expect(ofType(doc.content, 'blockquote')).toHaveLength(1)
    expect(ofType(doc.content, 'heading').length).toBeGreaterThanOrEqual(4)
  })

  it('totals an invoice in a table whose rows all span its four columns, the amounts on the right', () => {
    const doc = build('invoice')
    const items = ofType(doc.content, 'table').find((node) => node.content?.[0].content?.[0].type === 'tableHeader')!
    const spans = items.content!.map((row) => row.content!.reduce((sum, cell) => sum + Number(cell.attrs?.colspan ?? 1), 0))
    const widths = items.content!.map((row) => row.content!.flatMap((cell) => cell.attrs?.colwidth as number[]).length)

    expect(items.content![0].content!.map(textOf)).toEqual(['Description', 'Quantity', 'Unit price', 'Amount'])
    expect(spans.every((span) => span === 4)).toBe(true)
    expect(widths.every((count) => count === 4)).toBe(true)
    expect(items.content!.slice(1).every((row) => row.content![row.content!.length - 1].content![0].attrs?.textAlign === 'right')).toBe(true)
    expect(textOf(items.content![items.content!.length - 1])).toContain('Total due')
  })

  it('puts a thank-you note on a card: A5, or half a Letter sheet where people use Letter', () => {
    expect(pageOf(build('thank-you-note'))).toMatchObject({ width: PAGE_SIZES.a5.width, height: PAGE_SIZES.a5.height })
    expect(pageOf(build('thank-you-note', 'en-US'))).toMatchObject({ width: 396, height: 612 })
    expect(pageOf(documentFromTemplate('thank-you-note', { size: 'letter', locale: 'en-GB' }))).toMatchObject({ width: 612, height: 792 })
  })

  it('gives a recipe its facts, ingredients, method and tips', () => {
    const doc = build('recipe')

    expect(ofType(doc.content, 'tableCell').map(textOf)).toEqual(expect.arrayContaining(['SERVES\n4', 'COOKING\n30 minutes']))
    expect(ofType(doc.content, 'bulletList')).toHaveLength(1)
    expect(ofType(doc.content, 'orderedList')).toHaveLength(1)
    expect(ofType(doc.content, 'callout')).toHaveLength(1)
  })

  it('takes the locale’s paper and date order, or the size asked for', () => {
    expect(pageOf(build('report'))).toMatchObject({ width: PAGE_SIZES.a4.width, height: PAGE_SIZES.a4.height })
    expect(pageOf(build('report', 'en-US'))).toMatchObject({ width: 612, height: 792 })
    expect(pageOf(documentFromTemplate('report', { size: 'legal', locale: 'en-US' }))).toMatchObject({ width: 612, height: 1008 })
    expect(pageOf(documentFromTemplate('blank', { size: 'a5' }))).toMatchObject({ width: PAGE_SIZES.a5.width, margins: { top: 72 } })
    expect(ofType(build('letter').content, 'field')[0].attrs?.format).toBe('d MMMM yyyy')
    expect(ofType(build('letter', 'en-US').content, 'field')[0].attrs?.format).toBe('MMMM d, yyyy')
  })

  it('says which templates there are when asked for one it does not have', () => {
    expect(() => documentFromTemplate('poem')).toThrow(/no template “poem”.*letter, cover-letter/)
    expect(() => documentFromTemplate('letter', { size: 'tabloid' as never })).toThrow(/not a paper size/)
  })

  it('makes a fresh document each time', () => {
    const first = build('memo')
    first.content.length = 0

    expect(build('memo').content.length).toBeGreaterThan(5)
  })
})
