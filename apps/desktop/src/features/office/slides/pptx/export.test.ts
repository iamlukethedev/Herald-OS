import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { type Deck, type ImageElement, type LineElement, type ShapeElement, SLIDE_SIZES, type TableElement, type TextElement } from '../deck.ts'
import { LAYOUT_NAMES, placeholderFor } from '../layouts.ts'
import * as model from '../model.ts'
import { settleSpans, withCell } from '../tables.ts'
import { themeById } from '../themes.ts'
import { plainText } from '../text.ts'
import { writePptx } from './export.ts'
import { HERALD_CONTENT_TYPE, HERALD_PART, HERALD_RELATIONSHIP } from './herald-part.ts'
import { readPresentation } from './read.ts'
import { attr, child, childrenNamed, descendants, elements, find, parseXml, textOf, type XmlElement } from './xml.ts'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

/** A deck with a little of everything Herald makes. */
function sampleDeck(): Deck {
  let deck = model.newDeck('Sample', { theme: themeById('forest') })
  const first = deck.slides[0].id
  deck = model.setTitle(deck, first, 'Quarterly review').deck
  deck = model.setBody(deck, first, 'Herald OS').deck
  deck = model.updateElements(deck, first, [placeholderFor(deck.slides[0], 'title')!.id], (element) => (element.kind === 'text' ? { ...element, body: { ...element.body, paragraphs: [{ align: 'center', runs: [{ text: 'Quarterly ' }, { text: 'review', bold: true, color: 'accent2' }] }] } } : element), 'Style').deck
  deck = model.setNotes(deck, first, 'Welcome everyone\n\nThen the agenda').deck

  const list = model.addSlide(deck, { layout: 'title-content', title: 'Plan', body: ['Research', '  Interviews', 'Build'] })
  deck = list.deck
  const body = placeholderFor(list.deck.slides[1], 'body')!
  deck = model.updateElements(deck, list.slideId, [body.id], (element) => (element.kind === 'text' ? { ...element, body: { ...element.body, paragraphs: [...element.body.paragraphs, { list: 'number', runs: [{ text: 'Ship', italic: true }] }, { list: 'number', runs: [{ text: 'Celebrate' }] }] } } : element), 'More').deck

  const shapes = model.addSlide(deck, { layout: 'blank' })
  deck = shapes.deck
  deck = model.addShape(deck, shapes.slideId, { shape: 'roundRect', x: 60, y: 60, width: 240, height: 120, fill: { color: 'accent2', alpha: 0.5 }, stroke: { color: '#123456', width: 3, dash: 'dash' }, text: 'Inside' }).deck
  deck = model.addShape(deck, shapes.slideId, { shape: 'star5', x: 400, y: 60, width: 120, height: 120 }).deck
  const star = deck.slides[2].elements.at(-1) as ShapeElement
  deck = model.updateElements(deck, shapes.slideId, [star.id], (element) => ({ ...element, rotation: 30, adjust: { adj: 30000 } }), 'Star').deck
  deck = model.addLine(deck, shapes.slideId, { from: [700, 300], to: [600, 200], end: 'triangle', start: 'oval' }).deck
  deck = model.addLine(deck, shapes.slideId, { from: [100, 500], to: [400, 520] }).deck
  deck = model.addImage(deck, shapes.slideId, { src: PNG, natural: { width: 1, height: 1 }, x: 100, y: 300, width: 200, height: 100, alt: 'A dot' }).deck
  const picture = deck.slides[2].elements.at(-1) as ImageElement
  deck = model.updateElements(deck, shapes.slideId, [picture.id], (element) => ({ ...element, crop: { left: 0.1, top: 0.2, right: 0.05, bottom: 0 } }), 'Crop').deck
  const table = model.addTable(deck, shapes.slideId, {
    rows: 3,
    columns: 3,
    x: 560,
    y: 360,
    width: 360,
    height: 120,
    cells: [
      ['Team', '', 'Size'],
      ['North', 'Oslo', '12'],
      ['', 'Bergen', '8']
    ]
  })
  deck = model.updateElements(
    table.deck,
    shapes.slideId,
    [table.elementId],
    (element) => {
      if (element.kind !== 'table') {
        return element
      }

      const merged = withCell(withCell(element, { row: 0, column: 0 }, (cell) => ({ ...cell, colSpan: 2 })), { row: 1, column: 0 }, (cell) => ({ ...cell, rowSpan: 2 }))
      const styled = withCell(merged, { row: 1, column: 1 }, (cell) => ({ ...cell, body: { ...cell.body, anchor: 'middle', paragraphs: [{ align: 'center', runs: [{ text: 'Oslo', bold: true, color: 'accent2' }] }] } }))

      return { ...styled, cells: settleSpans(styled.cells, styled.columns.length) }
    },
    'Merge'
  ).deck
  deck = model.setCellFill(deck, shapes.slideId, table.elementId, [{ row: 1, column: 2 }], { color: '#ffcc00' }).deck
  deck = model.setBackground(deck, [shapes.slideId], { kind: 'gradient', stops: [{ at: 0, color: 'bg1' }, { at: 1, color: 'accent1' }], angle: 90 }).deck

  const hidden = model.addSlide(deck, { layout: 'section', title: 'Backup' })
  deck = model.setHidden(hidden.deck, [hidden.slideId], true).deck
  deck = model.setBackground(deck, [hidden.slideId], { kind: 'image', src: PNG, natural: { width: 1, height: 1 } }).deck

  return model.setTransition(deck, 'push').deck
}

async function unzip(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes)
  const read = async (name: string): Promise<XmlElement> => parseXml((await zip.file(name)?.async('string')) ?? '<missing/>')

  return { zip, read }
}

const shapesOf = (slide: XmlElement): XmlElement[] => descendants(find(slide, 'p:cSld/p:spTree'), 'p:sp')

/** A relationship's target as a part name, from the folder of the part it belongs to. */
function partAt(folder: string, target: string): string {
  if (target.startsWith('/')) {
    return target.slice(1)
  }

  const names: string[] = []

  for (const segment of `${folder}${target}`.split('/')) {
    if (segment === '..') {
      names.pop()
    } else if (segment && segment !== '.') {
      names.push(segment)
    }
  }

  return names.join('/')
}

describe('writing PowerPoint files', () => {
  it('writes a slide for each slide, with the layouts it uses and real title placeholders', async () => {
    const { zip, read } = await unzip(await writePptx(sampleDeck()))
    const slide = await read('ppt/slides/slide1.xml')
    const typed = (type: string) => shapesOf(slide).find((sp) => attr(find(sp, 'p:nvSpPr/p:nvPr/p:ph'), 'type') === type)
    const title = typed('ctrTitle')!
    const layouts = await Promise.all(Object.keys(zip.files).filter((name) => /slideLayouts\/slideLayout\d+\.xml$/.test(name)).map(read))
    const titleLayout = layouts.find((layout) => attr(find(layout, 'p:cSld'), 'name') === 'Title')!

    expect(Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(4)
    expect(layouts.map((layout) => attr(find(layout, 'p:cSld'), 'name')).sort()).toEqual(Object.values(LAYOUT_NAMES).sort())
    expect(descendants(title, 'a:t').map(textOf).join('')).toBe('Quarterly review')
    expect(attr(find(title, 'p:nvSpPr/p:cNvPr'), 'name')).toBe('Title 1')
    expect(descendants(typed('subTitle')!, 'a:t').map(textOf).join('')).toBe('Herald OS')
    expect(typed('title')).toBeUndefined()
    expect(attr(titleLayout, 'type')).toBe('title')
    expect(descendants(titleLayout, 'p:ph').map((ph) => ph.attrs.type)).toEqual(expect.arrayContaining(['ctrTitle', 'subTitle']))
  })

  it('gives each paragraph one set of settings, with its list, level and spacing spelled out', async () => {
    const { read } = await unzip(await writePptx(sampleDeck()))
    const slide = await read('ppt/slides/slide2.xml')
    const body = shapesOf(slide).find((sp) => attr(find(sp, 'p:nvSpPr/p:nvPr/p:ph'), 'type') === 'body')!
    const paragraphs = descendants(body, 'a:p')

    expect(paragraphs.map((p) => descendants(p, 'a:pPr').length)).toEqual([1, 1, 1, 1, 1])
    expect(paragraphs.map((p) => attr(child(p, 'a:pPr'), 'lvl') ?? '0')).toEqual(['0', '1', '0', '0', '0'])
    expect(paragraphs.map((p) => attr(child(p, 'a:pPr'), 'marL'))).toEqual(['342900', '685800', '342900', '342900', '342900'])
    expect(attr(find(paragraphs[0], 'a:pPr/a:buChar'), 'char')).toBe('•')
    expect(attr(find(paragraphs[1], 'a:pPr/a:buChar'), 'char')).toBe('◦')
    expect(attr(find(paragraphs[3], 'a:pPr/a:buAutoNum'), 'type')).toBe('arabicPeriod')
    expect(attr(find(paragraphs[0], 'a:pPr/a:spcAft/a:spcPts'), 'val')).toBe('600')
    expect(attr(find(paragraphs[3], 'a:r/a:rPr'), 'i')).toBe('1')
  })

  it('writes theme colours as slots, runs with their own style, and the deck’s theme', async () => {
    const { read } = await unzip(await writePptx(sampleDeck()))
    const slide = await read('ppt/slides/slide1.xml')
    const theme = await read('ppt/theme/theme1.xml')
    const runs = descendants(slide, 'a:r')
    const review = runs.find((run) => textOf(run) === 'review')!

    expect(attr(review, 'b') ?? attr(child(review, 'a:rPr'), 'b')).toBe('1')
    expect(attr(find(review, 'a:rPr/a:solidFill/a:schemeClr'), 'val')).toBe('accent2')
    expect(attr(find(review, 'a:rPr/a:latin'), 'typeface')).toBe('Gill Sans')
    expect(attr(theme, 'name')).toBe('Forest')
    expect(attr(find(theme, 'a:themeElements/a:clrScheme/a:accent1/a:srgbClr'), 'val')).toBe('2E7D4F')
    expect(attr(find(theme, 'a:themeElements/a:fontScheme/a:majorFont/a:latin'), 'typeface')).toBe('Gill Sans')
  })

  it('writes shapes as preset geometry with their adjust values, outlines, rotation, lines and cropped pictures', async () => {
    const { read } = await unzip(await writePptx(sampleDeck()))
    const slide = await read('ppt/slides/slide3.xml')
    const [round, star, line] = shapesOf(slide)
    const picture = descendants(slide, 'p:pic')[0]

    expect(attr(find(round, 'p:spPr/a:prstGeom'), 'prst')).toBe('roundRect')
    expect(attr(find(round, 'p:spPr/a:solidFill/a:schemeClr/a:alpha'), 'val')).toBe('50000')
    expect(attr(find(round, 'p:spPr/a:ln'), 'w')).toBe('38100')
    expect(attr(find(round, 'p:spPr/a:ln/a:prstDash'), 'val')).toBe('dash')
    expect(attr(find(star, 'p:spPr/a:prstGeom/a:avLst/a:gd'), 'fmla')).toBe('val 30000')
    expect(attr(find(star, 'p:spPr/a:xfrm'), 'rot')).toBe('1800000')
    expect(attr(find(line, 'p:spPr/a:prstGeom'), 'prst')).toBe('line')
    expect([attr(find(line, 'p:spPr/a:xfrm'), 'flipH'), attr(find(line, 'p:spPr/a:xfrm'), 'flipV')]).toEqual(['1', '1'])
    expect([attr(find(line, 'p:spPr/a:ln/a:headEnd'), 'type'), attr(find(line, 'p:spPr/a:ln/a:tailEnd'), 'type')]).toEqual(['oval', 'triangle'])
    expect(find(picture, 'p:blipFill/a:srcRect')?.attrs).toEqual({ l: '10000', t: '20000', r: '5000', b: '0' })
    expect(attr(find(picture, 'p:nvPicPr/p:cNvPr'), 'descr')).toBe('A dot')
  })

  it('writes tables as PowerPoint has them: a grid column a column, a cell a column in every row, merged cells spanning and covering', async () => {
    const { read } = await unzip(await writePptx(sampleDeck()))
    const tree = find(await read('ppt/slides/slide3.xml'), 'p:cSld/p:spTree')
    const [frame] = descendants(tree, 'p:graphicFrame')
    const tbl = find(frame, 'a:graphic/a:graphicData/a:tbl')
    const rows = childrenNamed(tbl, 'a:tr')
    const cells = rows.map((tr) => childrenNamed(tr, 'a:tc'))
    const ids = descendants(tree, 'p:cNvPr').map((node) => node.attrs.id)
    const properties = (row: number, column: number) => child(cells[row][column], 'a:tcPr')

    expect(new Set(ids).size).toBe(ids.length)
    expect(attr(find(frame, 'p:nvGraphicFramePr/p:cNvPr'), 'name')).toBe('Table 1')
    expect(attr(find(frame, 'a:graphic/a:graphicData'), 'uri')).toBe('http://schemas.openxmlformats.org/drawingml/2006/table')
    expect(['a:off', 'a:ext'].flatMap((name) => Object.values(find(frame, `p:xfrm/${name}`)?.attrs ?? {}))).toEqual(['7112000', '4572000', '4572000', '1524000'])
    expect(elements(tbl).map((node) => node.name)).toEqual(['a:tblPr', 'a:tblGrid', 'a:tr', 'a:tr', 'a:tr'])
    expect(childrenNamed(child(tbl, 'a:tblGrid'), 'a:gridCol').map((column) => column.attrs.w)).toEqual(['1524000', '1524000', '1524000'])
    expect(rows.map((tr) => tr.attrs.h)).toEqual(['508000', '508000', '508000'])
    expect(cells.map((row) => row.length)).toEqual([3, 3, 3])

    for (const tc of cells.flat()) {
      const body = elements(child(tc, 'a:txBody'))

      expect(elements(tc).map((node) => node.name)).toEqual(['a:txBody', 'a:tcPr'])
      expect(body.map((node) => node.name)).toEqual(['a:bodyPr', 'a:lstStyle', ...body.slice(2).map(() => 'a:p')])
      expect(body.length).toBeGreaterThan(2)
    }

    expect(cells.map((row) => row.map((tc) => ['gridSpan', 'rowSpan', 'hMerge', 'vMerge'].map((key) => tc.attrs[key] ?? '').join(',')))).toEqual([
      ['2,,,', ',,1,', ',,,'],
      [',2,,', ',,,', ',,,'],
      [',,,1', ',,,', ',,,']
    ])
    expect(cells.map((row) => row.map((tc) => descendants(tc, 'a:t').map(textOf).join('')))).toEqual([
      ['Team', '', 'Size'],
      ['North', 'Oslo', '12'],
      ['', 'Bergen', '8']
    ])
    expect(elements(properties(0, 0)).map((node) => node.name)).toEqual(['a:lnL', 'a:lnR', 'a:lnT', 'a:lnB', 'a:solidFill'])
    expect(properties(0, 0)?.attrs).toEqual({ marL: '91440', marR: '91440', marT: '45720', marB: '45720', anchor: 't' })
    expect(attr(find(properties(0, 0), 'a:lnB'), 'w')).toBe('12700')
    expect(attr(find(properties(0, 0), 'a:lnB/a:solidFill/a:schemeClr'), 'val')).toBe('bg1')
    expect(attr(find(properties(0, 0), 'a:solidFill/a:schemeClr'), 'val')).toBe('accent1')
    expect(attr(find(properties(1, 1), 'a:solidFill/a:schemeClr/a:alpha'), 'val')).toBe('40000')
    expect(attr(properties(1, 1), 'anchor')).toBe('ctr')
    expect(attr(find(properties(1, 2), 'a:solidFill/a:srgbClr'), 'val')).toBe('FFCC00')
    expect(attr(find(cells[1][1], 'a:txBody/a:p/a:pPr'), 'algn')).toBe('ctr')
    expect(attr(find(cells[1][1], 'a:txBody/a:p/a:r/a:rPr'), 'b')).toBe('1')
    expect(attr(find(cells[1][1], 'a:txBody/a:p/a:r/a:rPr/a:solidFill/a:schemeClr'), 'val')).toBe('accent2')
    expect(attr(find(cells[0][0], 'a:txBody/a:p/a:r/a:rPr/a:solidFill/a:schemeClr'), 'val')).toBe('bg1')
  })

  it('writes a table without lines or fills as having none', async () => {
    const start = model.newDeck('Plain')
    const slideId = start.slides[0].id
    const added = model.addTable(start, slideId, { rows: 1, columns: 2 })
    let deck = model.updateElements(added.deck, slideId, [added.elementId], (element) => (element.kind === 'table' ? { ...element, stroke: null } : element), 'Plain').deck
    deck = model.setCellFill(deck, slideId, added.elementId, 'all', null).deck
    const { read } = await unzip(await writePptx(deck))
    const settings = descendants(await read('ppt/slides/slide1.xml'), 'a:tcPr')

    expect(settings.map((node) => elements(node).map((part) => part.name + (child(part, 'a:noFill') ? ' none' : '')))).toEqual(Array(2).fill(['a:lnL none', 'a:lnR none', 'a:lnT none', 'a:lnB none', 'a:noFill']))
  })

  it('writes gradient and picture backgrounds, hidden slides, the transition and notes a paragraph a line', async () => {
    const { read } = await unzip(await writePptx(sampleDeck()))
    const gradient = await read('ppt/slides/slide3.xml')
    const hidden = await read('ppt/slides/slide4.xml')
    const notes = await read('ppt/notesSlides/notesSlide1.xml')
    const notesBody = shapesOf(notes).find((sp) => attr(find(sp, 'p:nvSpPr/p:nvPr/p:ph'), 'type') === 'body')!

    expect(descendants(find(gradient, 'p:cSld/p:bg'), 'a:gs').map((stop) => attr(stop, 'pos'))).toEqual(['0', '100000'])
    expect(attr(find(gradient, 'p:cSld/p:bg/p:bgPr/a:gradFill/a:lin'), 'ang')).toBe('5400000')
    expect(find(hidden, 'p:cSld/p:bg/p:bgPr/a:blipFill/a:blip')).toBeDefined()
    expect(attr(hidden, 'show')).toBe('0')
    expect(find(gradient, 'mc:AlternateContent/mc:Fallback/p:transition/p:push')).toBeDefined()
    expect(descendants(notesBody, 'a:p').map(textOf)).toEqual(['Welcome everyone', '', 'Then the agenda'])
  })

  it('puts Herald’s own copy of the deck in with its content type and relationship', async () => {
    const { zip, read } = await unzip(await writePptx(sampleDeck()))
    const types = await read('[Content_Types].xml')
    const rels = await read('_rels/.rels')
    const copy = JSON.parse((await zip.file(HERALD_PART)?.async('string')) ?? '{}')

    expect(descendants(types, 'Override').some((entry) => attr(entry, 'PartName') === `/${HERALD_PART}` && attr(entry, 'ContentType') === HERALD_CONTENT_TYPE)).toBe(true)
    expect(descendants(rels, 'Relationship').some((entry) => attr(entry, 'Type') === HERALD_RELATIONSHIP && attr(entry, 'Target') === HERALD_PART)).toBe(true)
    expect(copy.format).toBe('herald-slides')
    expect(JSON.stringify(copy.deck)).not.toContain('base64')
    expect(JSON.stringify(copy.deck)).toContain('part:/ppt/media/')
  })

  it('gives a content type to every part in the file and to no part that is not there', async () => {
    const { zip, read } = await unzip(await writePptx(sampleDeck()))
    const types = await read('[Content_Types].xml')
    const defaults = new Set(descendants(types, 'Default').map((entry) => attr(entry, 'Extension')?.toLowerCase()))
    const overrides = descendants(types, 'Override').map((entry) => attr(entry, 'PartName') ?? '')
    const parts = Object.keys(zip.files).filter((name) => !zip.files[name].dir && name !== '[Content_Types].xml')

    expect(overrides.filter((name) => !zip.file(name.slice(1)))).toEqual([])
    expect(parts.filter((name) => !overrides.includes(`/${name}`) && !defaults.has(name.split('.').pop()?.toLowerCase()))).toEqual([])
  })

  it('points every relationship at a part in the file', async () => {
    const { zip, read } = await unzip(await writePptx(sampleDeck()))
    const missing: string[] = []
    let checked = 0

    for (const name of Object.keys(zip.files).filter((entry) => entry.endsWith('.rels'))) {
      const folder = name.replace(/_rels\/[^/]*$/, '')

      for (const relationship of descendants(await read(name), 'Relationship')) {
        const target = attr(relationship, 'Target') ?? ''

        if (attr(relationship, 'TargetMode') === 'External') {
          continue
        }

        checked++

        if (!zip.file(partAt(folder, target))) {
          missing.push(`${name}: ${target}`)
        }
      }
    }

    expect(checked).toBeGreaterThan(20)
    expect(missing).toEqual([])
  })

  it('reads its own files back exactly', async () => {
    const deck = sampleDeck()
    const read = await readPresentation(await writePptx(deck), deck.title)

    expect(read.notes).toEqual([])
    expect(read.model).toEqual(deck)
  })

  it('reads a file changed by another app from its slides', async () => {
    const deck = sampleDeck()
    const zip = await JSZip.loadAsync(await writePptx(deck))
    const name = 'ppt/slides/slide2.xml'
    zip.file(name, (await zip.file(name)!.async('string')).replace('Research', 'Research, edited elsewhere'))
    const read = await readPresentation(await zip.generateAsync({ type: 'uint8array' }), deck.title)

    expect(read.notes[0]).toMatch(/changed in another app/)
    expect(read.model.slides[1].elements.some((element) => (element.kind === 'text' || element.kind === 'shape') && plainText(element.body).includes('edited elsewhere'))).toBe(true)
  })

  it('says how far text that shrinks to fit was shrunk when last drawn', async () => {
    const deck = sampleDeck()
    const title = placeholderFor(deck.slides[0], 'title') as TextElement
    const { read } = await unzip(await writePptx(deck, { shrink: (body) => (body === title.body ? 0.75 : undefined) }))
    const slide = await read('ppt/slides/slide1.xml')

    expect(descendants(slide, 'a:normAutofit').map((fit) => attr(fit, 'fontScale') ?? null)).toEqual(['75000', null])
  })

  it('writes 4:3 decks at their size', async () => {
    const deck = model.newDeck('Square', { size: SLIDE_SIZES.standard })
    const { read } = await unzip(await writePptx(deck))
    const presentation = await read('ppt/presentation.xml')

    expect([attr(child(presentation, 'p:sldSz'), 'cx'), attr(child(presentation, 'p:sldSz'), 'cy')]).toEqual(['9144000', '6858000'])
  })
})

describe('reading Herald’s files without its own copy', () => {
  it('gets back the slides, text, lists, shapes, lines, pictures and backgrounds from the slides themselves', async () => {
    const deck = sampleDeck()
    const read = await readPresentation(await writePptx(deck, { embed: false }), deck.title)
    const back = read.model

    expect(back.size).toEqual(deck.size)
    expect(back.slides.map((slide) => slide.layout)).toEqual(deck.slides.map((slide) => slide.layout))
    expect(back.slides.map((slide) => slide.hidden)).toEqual([false, false, false, true])
    expect(back.transition).toBe('push')
    expect(back.theme.colors).toEqual(deck.theme.colors)
    expect(back.theme.fonts).toEqual(deck.theme.fonts)
    expect(back.slides[0].notes).toBe('Welcome everyone\n\nThen the agenda')

    const title = placeholderFor(back.slides[0], 'title') as TextElement
    expect(plainText(title.body)).toBe('Quarterly review')
    expect(title.body.paragraphs[0].runs.find((run) => run.text === 'review')).toMatchObject({ bold: true, color: 'accent2' })

    const list = placeholderFor(back.slides[1], 'body') as TextElement
    expect(list.body.paragraphs.map((paragraph) => [paragraph.list, paragraph.level ?? 0])).toEqual([
      ['bullet', 0],
      ['bullet', 1],
      ['bullet', 0],
      ['number', 0],
      ['number', 0]
    ])

    const [round, star, line, flat, picture] = back.slides[2].elements as [ShapeElement, ShapeElement, LineElement, LineElement, ImageElement]
    expect(round).toMatchObject({ kind: 'shape', shape: 'roundRect', x: 60, y: 60, width: 240, height: 120, fill: { color: 'accent2', alpha: 0.5 }, stroke: { color: '#123456', width: 3, dash: 'dash' } })
    expect(plainText(round.body)).toBe('Inside')
    expect(star).toMatchObject({ shape: 'star5', rotation: 30, adjust: { adj: 30000 } })
    expect(line).toMatchObject({ kind: 'line', x: 600, y: 200, width: 100, height: 100, flipH: true, flipV: true, start: 'oval', end: 'triangle' })
    expect(flat).toMatchObject({ kind: 'line', x: 100, y: 500, width: 300, height: 20, start: 'none', end: 'none' })
    expect(Boolean(flat.flipH) || Boolean(flat.flipV)).toBe(false)
    expect(picture).toMatchObject({ kind: 'image', alt: 'A dot', crop: { left: 0.1, top: 0.2, right: 0.05, bottom: 0 } })

    const table = back.slides[2].elements[5] as TableElement
    expect(table).toMatchObject({ kind: 'table', x: 560, y: 360, width: 360, height: 120, columns: [120, 120, 120], rows: [40, 40, 40], stroke: { color: 'bg1', width: 1, dash: 'solid' } })
    expect(table.cells.map((row) => row.map((cell) => (cell.merged ? '·' : plainText(cell.body))))).toEqual([
      ['Team', '·', 'Size'],
      ['North', 'Oslo', '12'],
      ['·', 'Bergen', '8']
    ])
    expect(table.cells[0][0]).toMatchObject({ colSpan: 2, fill: { color: 'accent1' }, body: { style: { color: 'bg1', bold: true } } })
    expect(table.cells[1][0].rowSpan).toBe(2)
    expect(table.cells[1][1]).toMatchObject({ fill: { color: 'accent1', alpha: 0.4 }, body: { anchor: 'middle', style: { color: 'accent2', bold: true }, paragraphs: [{ align: 'center' }] } })
    expect(table.cells[1][2].fill).toEqual({ color: '#ffcc00' })
    expect(read.notes.join(' ')).not.toMatch(/table/i)
    expect(back.slides[2].background).toMatchObject({ kind: 'gradient', angle: 90 })
    expect(back.slides[3].background?.kind).toBe('image')
  })
})
