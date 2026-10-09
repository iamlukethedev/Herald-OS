import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import type { Box, CellBorders, Deck, ObjectElement, ShapeElement, Slide, SlideElement, SlideTransition, Stroke, TableElement } from '../deck.ts'
import { layoutOf, masterOf, masterPlaceholder, placeholderFor } from '../layouts.ts'
import * as model from '../model.ts'
import { themeById } from '../themes.ts'
import { writePptx } from './export.ts'
import { importPresentation } from './import.ts'

/*
 * Decks written as PowerPoint files without Herald's own copy and read back by the DrawingML
 * reader, as a file from another app would be: what each part of this phase writes must come back.
 */

const NOW = new Date(2026, 9, 9)
const DOT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function again(deck: Deck): Promise<{ deck: Deck; reasons: Record<string, number> }> {
  const bytes = await writePptx(deck, { embed: false, now: NOW })
  const read = await importPresentation(await JSZip.loadAsync(bytes), deck.title)

  return { deck: read.deck, reasons: read.report.reasons }
}

const near = (box: Box, like: Box) => {
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(box[key] - like[key])).toBeLessThan(0.6)
  }
}

const named = (slide: Slide, name: string): SlideElement => {
  const found = slide.elements.find((element) => element.name === name)

  if (!found) {
    throw new Error(`No ${name} on the slide: ${slide.elements.map((element) => element.name).join(', ')}`)
  }

  return found
}

const nameAll = (deck: Deck, slideId: string, names: Record<string, string>): Deck =>
  model.updateElements(deck, slideId, Object.keys(names), (element) => ({ ...element, name: names[element.id] }), 'Name').deck

/** A slide with shapes a, b and c in a row, named as their ids say. */
function shapes() {
  let deck = model.addSlide(model.newDeck('Round trip'), { layout: 'blank' }).deck
  const slideId = deck.slides[1].id
  const ids: string[] = []

  for (const x of [60, 300, 540]) {
    const change = model.addShape(deck, slideId, { shape: 'rect', x, y: 200, width: 120, height: 80 })
    deck = change.deck
    ids.push(change.elementId)
  }

  deck = nameAll(deck, slideId, { [ids[0]]: 'A', [ids[1]]: 'B', [ids[2]]: 'C' })

  return { deck, slideId, ids }
}

describe('round trips through PowerPoint files: masters and layouts', () => {
  it('keeps the master’s logo, background and title look, a moved layout placeholder, hidden master drawings and a renamed layout', async () => {
    let deck = model.addSlide(model.newDeck('Masters'), { layout: 'title-content', title: 'Agenda', body: ['One', 'Two'] }).deck
    const logo = model.addLogo(deck, { src: DOT, natural: { width: 1, height: 1 }, corner: 'top-right', width: 60 })
    deck = logo.deck
    deck = model.setMasterBackground(deck, { kind: 'gradient', stops: [{ at: 0, color: 'bg1' }, { at: 1, color: 'bg2' }], angle: 90 }).deck
    deck = model.setPlaceholderStyle(deck, 'master', 'title', { color: 'accent2', size: 44, bold: true }).deck
    deck = model.setPlaceholderBox(deck, 'title-content', 'body', { x: 120, y: 150, width: 720, height: 330 }).deck
    deck = model.setShowMaster(deck, 'section', false).deck
    deck = model.renameLayout(deck, 'title-content', 'Agenda Points').deck
    const master = masterOf(deck)
    const placedLogo = master.elements.find((element) => element.id === logo.elementId)!

    const { deck: read, reasons } = await again(deck)
    const back = masterOf(read)
    const content = layoutOf(back, 'title-content')
    const drawings = back.elements.filter((element) => !element.placeholder)

    expect(drawings).toHaveLength(1)
    expect(drawings[0].kind).toBe('image')
    near(drawings[0], placedLogo)
    expect(back.background).toMatchObject({ kind: 'gradient', angle: 90, stops: [{ at: 0, color: 'bg1' }, { at: 1, color: 'bg2' }] })
    expect(masterPlaceholder(back, 'title')).toMatchObject({ body: { style: { color: 'accent2', size: 44, bold: true } } })
    expect(placeholderFor({ ...read.slides[1], elements: content.elements }, 'title')).toMatchObject({ body: { style: { color: 'accent2', size: 44 } } })
    near(placeholderFor({ ...read.slides[1], elements: content.elements }, 'body')!, { x: 120, y: 150, width: 720, height: 330 })
    near(placeholderFor(read.slides[1], 'body')!, { x: 120, y: 150, width: 720, height: 330 })
    expect(content.name).toBe('Agenda Points')
    expect(layoutOf(back, 'section').showMaster).toBe(false)
    expect(layoutOf(back, 'title').showMaster).toBe(true)
    expect(reasons).toEqual({})
  })

  it('keeps the header and footer settings, and a slide that hides its master’s drawings', async () => {
    let deck = model.newDeck('Footers')
    deck = model.addSlide(deck, { title: 'One' }).deck
    deck = model.addSlide(deck, { title: 'Two' }).deck
    deck = model.setHeaderFooter(deck, { number: true, footer: true, footerText: 'Herald OS', date: true, dateFormat: 'datetime2', skipTitle: true }).deck
    deck = model.setShowMasterOnSlides(deck, [deck.slides[2].id], false).deck

    const { deck: read } = await again(deck)

    expect(read.headerFooter).toMatchObject({ number: true, footer: true, footerText: 'Herald OS', date: true, dateFormat: 'datetime2', skipTitle: true })
    expect(read.slides.map((slide) => slide.showMaster)).toEqual([undefined, undefined, false])
    expect(read.slides.flatMap((slide) => slide.elements).some((element) => ['date', 'footer', 'number'].includes(element.placeholder?.role ?? ''))).toBe(false)
  })

  it('keeps a slide in a theme of its own', async () => {
    let deck = model.addSlide(model.newDeck('Themes'), { title: 'Second' }).deck
    const ocean = themeById('ocean')!
    deck = model.applyTheme(deck, ocean, [deck.slides[1].id]).deck

    const { deck: read } = await again(deck)

    expect(read.theme.colors).toEqual(deck.theme.colors)
    expect(read.slides[0].theme).toBeUndefined()
    expect(read.slides[1].theme?.colors).toEqual(ocean.colors)
    expect(read.slides[1].theme?.fonts).toEqual(ocean.fonts)
  })
})

describe('round trips through PowerPoint files: transitions', () => {
  it('keeps each slide’s transition with its duration and direction', async () => {
    const transitions: (SlideTransition | null)[] = [
      { kind: 'push', duration: 800, direction: 'left' },
      { kind: 'wipe', duration: 1200, direction: 'up' },
      { kind: 'split', duration: 600, direction: 'out', orientation: 'vertical' },
      { kind: 'zoom', duration: 400, direction: 'in' },
      { kind: 'uncover', duration: 750, direction: 'down' },
      { kind: 'cover', duration: 1000, direction: 'right' },
      { kind: 'fade', duration: 500 },
      null
    ]
    let deck = model.newDeck('Transitions')

    for (let index = 1; index < transitions.length; index++) {
      deck = model.addSlide(deck, { title: `Slide ${index + 1}` }).deck
    }

    transitions.forEach((transition, index) => {
      deck = model.setSlideTransition(deck, [deck.slides[index].id], transition ?? { kind: 'none', duration: 500 }).deck
    })

    const { deck: read, reasons } = await again(deck)

    expect(read.slides.map((slide) => slide.transition)).toEqual(transitions.map((transition) => transition ?? { kind: 'none', duration: 500 }))
    expect(reasons).toEqual({})
  })

  it('keeps one transition applied to every slide', async () => {
    let deck = model.addSlide(model.addSlide(model.newDeck('All'), { title: 'Two' }).deck, { title: 'Three' }).deck
    deck = model.applyTransitionToAll(deck, { kind: 'push', duration: 900, direction: 'up' }).deck

    const { deck: read } = await again(deck)

    expect(read.transition).toBe('push')
    expect(read.slides.map((slide) => slide.transition)).toEqual(deck.slides.map(() => ({ kind: 'push', duration: 900, direction: 'up' })))
  })
})

describe('round trips through PowerPoint files: elements', () => {
  it('keeps groups as groups, nested ones too, with their members where they were', async () => {
    const { deck: start, slideId, ids } = shapes()
    let deck = model.groupElements(start, slideId, [ids[0], ids[1]]).deck
    deck = model.groupElements(deck, slideId, [ids[0], ids[2]]).deck
    const slide = deck.slides[1]

    const { deck: read } = await again(deck)
    const back = read.slides[1]
    const [a, b, c] = ['A', 'B', 'C'].map((name) => named(back, name))

    expect(a.group).toHaveLength(2)
    expect(b.group).toEqual(a.group)
    expect(c.group).toHaveLength(1)
    expect(c.group?.[0]).toBe(a.group?.[0])
    expect(new Set([...a.group!, ...c.group!]).size).toBe(2)
    ;['A', 'B', 'C'].forEach((name) => near(named(back, name), named(slide, name)))
  })

  it('keeps linear and radial gradient fills on shapes and gradient backgrounds', async () => {
    const { deck: start, slideId, ids } = shapes()
    let deck = model.updateElements(start, slideId, [ids[0]], (element) => (element.kind === 'shape' ? { ...element, fill: model.gradientFill('accent1', '#ff0000', 45) } : element), 'Fill').deck
    deck = model.updateElements(deck, slideId, [ids[1]], (element) => (element.kind === 'shape' ? { ...element, fill: { color: 'accent2', gradient: { stops: [{ at: 0, color: 'accent2' }, { at: 1, color: 'bg1', alpha: 0.5 }], angle: 0, radial: true } } } : element), 'Fill').deck
    deck = model.setBackground(deck, [slideId], { kind: 'gradient', stops: [{ at: 0, color: 'accent5' }, { at: 1, color: 'accent6' }], angle: 135, radial: true }).deck

    const { deck: read, reasons } = await again(deck)
    const back = read.slides[1]

    expect((named(back, 'A') as ShapeElement).fill?.gradient).toMatchObject({ angle: 45, stops: [{ at: 0, color: 'accent1' }, { at: 1, color: '#ff0000' }] })
    expect((named(back, 'A') as ShapeElement).fill?.gradient?.radial).toBeUndefined()
    expect((named(back, 'B') as ShapeElement).fill?.gradient).toMatchObject({ radial: true, stops: [{ at: 0, color: 'accent2' }, { at: 1, color: 'bg1', alpha: 0.5 }] })
    expect(back.background).toMatchObject({ kind: 'gradient', radial: true, stops: [{ at: 0, color: 'accent5' }, { at: 1, color: 'accent6' }] })
    expect(reasons).toEqual({})
  })

  it('keeps freeforms and the new preset shapes with their adjust values', async () => {
    const { deck: start, slideId, ids } = shapes()
    const paths = [{ width: 100, height: 100, d: 'M0,0 L100,0 C100,50 50,100 0,100 Z' }, { width: 100, height: 100, d: 'M20,20 L80,80', fill: false }]
    let deck = model.updateElements(start, slideId, [ids[0]], (element) => (element.kind === 'shape' ? { ...element, paths } : element), 'Freeform').deck
    deck = model.updateElements(deck, slideId, [ids[1]], (element) => (element.kind === 'shape' ? { ...element, shape: 'cloud' } : element), 'Shape').deck
    deck = model.updateElements(deck, slideId, [ids[2]], (element) => (element.kind === 'shape' ? { ...element, shape: 'flowChartDecision', adjust: undefined } : element), 'Shape').deck

    const { deck: read, reasons } = await again(deck)
    const back = read.slides[1]
    const freeform = named(back, 'A') as ShapeElement

    expect(freeform.paths).toHaveLength(2)
    expect(freeform.paths?.[0].d.match(/[MLCQZ]|-?[\d.]+/g)).toEqual('M 0 0 L 100 0 C 100 50 50 100 0 100 Z'.split(' '))
    expect(freeform.paths?.[1].fill).toBe(false)
    expect((named(back, 'B') as ShapeElement).shape).toBe('cloud')
    expect((named(back, 'C') as ShapeElement).shape).toBe('flowChartDecision')
    expect(reasons).toEqual({})
  })

  it('keeps connectors glued to their shapes', async () => {
    const { deck: start, slideId, ids } = shapes()
    const elbow = model.addConnector(start, slideId, { from: { element: ids[0], site: 3 }, to: { element: ids[1], site: 1 }, preset: 'bentConnector3', end: 'triangle' })
    const curved = model.addConnector(elbow.deck, slideId, { from: { element: ids[1], site: 2 }, to: { element: ids[2], site: 0 }, preset: 'curvedConnector3' })
    const deck = nameAll(curved.deck, slideId, { [elbow.elementId]: 'Elbow', [curved.elementId]: 'Curved' })
    const slide = deck.slides[1]

    const { deck: read, reasons } = await again(deck)
    const back = read.slides[1]
    const [a, b, c] = ['A', 'B', 'C'].map((name) => named(back, name).id)
    const [elbowBack, curvedBack] = ['Elbow', 'Curved'].map((name) => named(back, name))

    expect(elbowBack).toMatchObject({ kind: 'line', end: 'triangle', connector: { preset: 'bentConnector3', start: { element: a, site: 3 }, end: { element: b, site: 1 } } })
    expect(curvedBack).toMatchObject({ kind: 'line', connector: { preset: 'curvedConnector3', start: { element: b, site: 2 }, end: { element: c, site: 0 } } })
    near(elbowBack, named(slide, 'Elbow'))
    near(curvedBack, named(slide, 'Curved'))
    expect(reasons).toEqual({})
  })

  it('keeps each cell’s own borders', async () => {
    let deck = model.addSlide(model.newDeck('Tables'), { layout: 'title-only' }).deck
    const slideId = deck.slides[1].id
    const table = model.addTable(deck, slideId, { rows: 3, columns: 3, cells: [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']] })
    deck = table.deck
    const thick: Stroke = { color: 'accent1', width: 3, dash: 'solid' }
    deck = model.setCellBorders(deck, slideId, table.elementId, 'all', ['inner'], null).deck
    deck = model.setCellBorders(deck, slideId, table.elementId, 'all', ['outer'], thick).deck
    const written = deck.slides[1].elements.find((element) => element.id === table.elementId) as TableElement

    const { deck: read, reasons } = await again(deck)
    const back = read.slides[1].elements.find((element) => element.kind === 'table') as TableElement
    const sides = (of: TableElement) => of.cells.map((row) => row.map((cell) => (['left', 'top', 'right', 'bottom'] as const).map((side) => sideOf(of, cell.borders, side))))

    expect(sides(back)).toEqual(sides(written))
    expect(reasons).toEqual({})
  })
})

const sideOf = (table: TableElement, borders: CellBorders | undefined, side: keyof CellBorders): Stroke | null => {
  const own = borders?.[side]
  const line = own === undefined ? table.stroke : own

  return line && line.width > 0 ? { color: line.color, width: line.width, dash: line.dash } : null
}

describe('round trips through Herald’s own copy', () => {
  it('reopens a deck with every part of this phase exactly as it was', async () => {
    const { deck: start, slideId, ids } = shapes()
    let deck = model.addLogo(start, { src: DOT, natural: { width: 1, height: 1 }, corner: 'bottom-left' }).deck
    deck = model.setHeaderFooter(deck, { number: true, footer: true, footerText: 'Draft' }).deck
    deck = model.setSlideTransition(deck, [slideId], { kind: 'split', duration: 700, direction: 'in', orientation: 'vertical' }).deck
    deck = model.groupElements(deck, slideId, [ids[0], ids[1]]).deck
    deck = model.updateElements(deck, slideId, [ids[2]], (element) => (element.kind === 'shape' ? { ...element, shape: 'heart', fill: model.gradientFill('accent3', 'accent4') } : element), 'Fill').deck
    deck = model.addConnector(deck, slideId, { from: { element: ids[1], site: 3 }, to: { element: ids[2], site: 1 }, preset: 'bentConnector3' }).deck
    const table = model.addTable(deck, slideId, { rows: 2, columns: 2, x: 60, y: 400, width: 300, height: 60 })
    deck = model.setCellBorders(table.deck, slideId, table.elementId, 'all', ['outer'], { color: 'accent2', width: 2, dash: 'dash' }).deck
    deck = model.applyTheme(deck, 'slate', [deck.slides[0].id]).deck
    deck = model.setShowMasterOnSlides(deck, [deck.slides[0].id], false).deck

    const { readPresentation } = await import('./read.ts')
    const { model: back } = await readPresentation(await writePptx(deck, { now: NOW }), deck.title)

    expect(back).toEqual(deck)
  })
})

describe('round trips through PowerPoint files: kept objects', () => {
  it('keeps a chart Herald does not edit, with its parts, where it was moved to', async () => {
    const chartXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:plotArea><c:layout/></c:plotArea></c:chart></c:chartSpace>'
    const frame =
      '<p:graphicFrame xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:nvGraphicFramePr><p:cNvPr id="4" name="Chart 3"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="1270000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/></a:graphicData></a:graphic></p:graphicFrame>'
    const chart: ObjectElement = {
      id: 'chart',
      kind: 'object',
      object: 'chart',
      name: 'Chart 3',
      x: 100,
      y: 120,
      width: 400,
      height: 250,
      rotation: 0,
      preview: { src: DOT, natural: { width: 1, height: 1 } },
      source: {
        xml: frame,
        parts: [{ id: 'rId9', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart', path: 'ppt/charts/chart1.xml', contentType: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml', data: btoa(chartXml) }]
      }
    }
    let deck = model.addSlide(model.newDeck('Charts'), { layout: 'title-only', title: 'Sales' }).deck
    deck = model.insertElements(deck, deck.slides[1].id, [chart], 'Paste').deck

    const { deck: read, reasons } = await again(deck)
    const back = read.slides[1].elements.find((element) => element.kind === 'object') as ObjectElement

    expect(back).toMatchObject({ object: 'chart' })
    near(back, chart)
    expect(back.source.parts).toHaveLength(1)
    expect(atob(back.source.parts[0].data)).toBe(chartXml)
    expect(reasons).toEqual({ 'charts shown as a box (kept in the file as they were)': 1 })
  })
})
