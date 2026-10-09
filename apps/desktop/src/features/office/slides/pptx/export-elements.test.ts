import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { type Box, type Deck, type KeptPart, type ObjectElement, SHAPE_KINDS, type SlideElement, type Stroke } from '../deck.ts'
import { imageElement, lineElement, shapeElement, textElement } from '../elements.ts'
import { defaultMaster } from '../layouts.ts'
import * as model from '../model.ts'
import { normalizeDeck } from '../normalize.ts'
import { settleSpans, tableElement, withCell } from '../tables.ts'
import { textBody } from '../text.ts'
import { writePptx } from './export.ts'
import { HERALD_PART, readEmbeddedDeck } from './herald-part.ts'
import { extensionOf, Relationships, resolveTarget } from './write-package.ts'
import { attr, child, childrenNamed, descendants, elements, find, parseXml, type XmlElement } from './xml.ts'

const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const PAPER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC'
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const emu = (points: number): string => String(Math.round(points * 12700))
const emuBox = (box: Box): string[] => [box.x, box.y, box.width, box.height].map(emu)
const boxOf = (xfrm: XmlElement | undefined): string[] => [attr(find(xfrm, 'a:off'), 'x'), attr(find(xfrm, 'a:off'), 'y'), attr(find(xfrm, 'a:ext'), 'cx'), attr(find(xfrm, 'a:ext'), 'cy')].map(String)
const base64 = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)))

async function unzip(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes)
  const text = async (name: string): Promise<string> => (await zip.file(name)?.async('string')) ?? '<missing/>'
  const read = async (name: string): Promise<XmlElement> => parseXml(await text(name))
  const raw = async (name: string): Promise<XmlElement> => parseXml(await text(name), { canonical: false })
  const related = async (part: string, id: string | undefined) => {
    const relationship = (await Relationships.read(zip, part)).get(id ?? '')

    return { type: relationship?.type ?? '', part: relationship ? resolveTarget(part, relationship.target) : '' }
  }

  return { zip, text, read, raw, related }
}

/** Every part with a content type and no content type for a missing part; every relationship pointing at a part, and every relationship id a part names among its relationships. */
async function expectWhole(zip: JSZip): Promise<void> {
  const types = parseXml(await zip.file('[Content_Types].xml')!.async('string'))
  const defaults = new Set(descendants(types, 'Default').map((entry) => attr(entry, 'Extension')?.toLowerCase()))
  const overrides = descendants(types, 'Override').map((entry) => attr(entry, 'PartName') ?? '')
  const parts = Object.keys(zip.files).filter((name) => !zip.files[name].dir && name !== '[Content_Types].xml')
  const broken: string[] = []

  expect(overrides.filter((name) => !zip.file(name.slice(1)))).toEqual([])
  expect(new Set(overrides.map((name) => name.toLowerCase())).size).toBe(overrides.length)
  expect(parts.filter((name) => !overrides.includes(`/${name}`) && !defaults.has(extensionOf(name)))).toEqual([])

  for (const part of ['', ...parts.filter((name) => name.endsWith('.xml'))]) {
    const rels = await Relationships.read(zip, part)

    for (const entry of rels.entries.filter((relationship) => !relationship.external)) {
      if (!zip.file(resolveTarget(part, entry.target))) {
        broken.push(`${part}: ${entry.target}`)
      }
    }

    const stack = part ? [parseXml(await zip.file(part)!.async('string'))] : []

    while (stack.length) {
      const node = stack.pop()!

      for (const [name, value] of Object.entries(node.attrs)) {
        if (name.startsWith('r:') && value && !rels.get(value)) {
          broken.push(`${part}: ${name}="${value}"`)
        }
      }

      stack.push(...elements(node))
    }
  }

  expect(broken).toEqual([])
}

const tree = (root: XmlElement | undefined): XmlElement[] => elements(find(root, 'p:cSld/p:spTree') ?? root).filter((node) => !['p:nvGrpSpPr', 'p:grpSpPr'].includes(node.name))
const nameOf = (node: XmlElement): string | undefined => attr(find(elements(node).find((entry) => entry.name.startsWith('p:nv')), 'p:cNvPr'), 'name')
const idOf = (node: XmlElement | undefined): string | undefined => attr(descendants(node, 'p:cNvPr')[0], 'id')

/** The ids of a tree's shapes, one for each of an `mc:AlternateContent`'s branches' shapes. */
function shapeIds(root: XmlElement): string[] {
  const out: string[] = []
  const stack = [root]

  while (stack.length) {
    const node = stack.pop()!

    if (node.name === 'p:cNvPr') {
      out.push(node.attrs.id)
    }

    stack.push(...elements(node).filter((entry) => entry.name !== 'mc:Fallback'))
  }

  return out
}

/** A deck of one blank slide holding `elements` (and more blank slides for `more`). */
function deckOf(elementsOfSlide: SlideElement[], ...more: SlideElement[][]): Deck {
  const start = model.newDeck('Elements')
  const slide = { ...start.slides[0], layout: 'blank' as const }

  return { ...start, slides: [elementsOfSlide, ...more].map((list, index) => ({ ...slide, id: `slide-${index + 1}`, elements: list })) }
}

describe('writing groups, gradients, freeforms, presets, connectors and cell lines', () => {
  it('nests grouped elements in their groups, where the first member is, members in their order', async () => {
    const box = (x: number, y: number): Box => ({ x, y, width: 40, height: 30 })
    const deck = deckOf([
      shapeElement('rect', box(10, 10), { id: 'a' }),
      shapeElement('ellipse', box(100, 10), { id: 'b', group: ['g1'] }),
      shapeElement('rect', box(100, 100), { id: 'c', group: ['g1', 'g2'] }),
      shapeElement('rect', box(300, 10), { id: 'd' }),
      textElement(box(200, 200), textBody({ font: '+body', size: 18, color: 'tx1' }, { text: 'E' }), { id: 'e', group: ['g1'] }),
      lineElement([150, 150], [190, 180], { id: 'f', group: ['g1', 'g2'] })
    ])
    const { zip, read } = await unzip(await writePptx(deck))
    const slide = await read('ppt/slides/slide1.xml')
    const [, outer] = tree(slide)
    const [, inner] = tree(outer)
    const transform = (group: XmlElement) => {
      const xfrm = find(group, 'p:grpSpPr/a:xfrm')

      return ['a:off', 'a:ext', 'a:chOff', 'a:chExt'].map((name) => Object.values(find(xfrm, name)?.attrs ?? {}).join(','))
    }

    expect(tree(slide).map(nameOf)).toEqual(['Shape 1', 'Group 1', 'Shape 4'])
    expect(tree(outer).map(nameOf)).toEqual(['Shape 2', 'Group 2', 'Text box 1'])
    expect(tree(inner).map(nameOf)).toEqual(['Shape 3', 'Line 1'])
    expect([outer.name, inner.name]).toEqual(['p:grpSp', 'p:grpSp'])
    expect(transform(outer)).toEqual([`${emu(100)},${emu(10)}`, `${emu(140)},${emu(220)}`, `${emu(100)},${emu(10)}`, `${emu(140)},${emu(220)}`])
    expect(transform(inner)).toEqual([`${emu(100)},${emu(100)}`, `${emu(90)},${emu(80)}`, `${emu(100)},${emu(100)}`, `${emu(90)},${emu(80)}`])
    expect(elements(child(outer, 'p:nvGrpSpPr')).map((node) => node.name)).toEqual(['p:cNvPr', 'p:cNvGrpSpPr', 'p:nvPr'])
    expect(new Set(shapeIds(slide)).size).toBe(shapeIds(slide).length)
    await expectWhole(zip)
  })

  it('writes gradient fills on shapes, text boxes and backgrounds, linear and radial', async () => {
    const shape = shapeElement('roundRect', { x: 60, y: 60, width: 200, height: 100 }, { fill: { color: 'accent1', gradient: { angle: 45, stops: [{ at: 0, color: 'accent1', alpha: 0.5 }, { at: 1, color: '#ff0000' }] } } })
    const text = textElement({ x: 300, y: 60, width: 200, height: 100 }, textBody({ font: '+body', size: 18, color: 'tx1' }, { text: 'Glow' }), {
      fill: { color: 'bg1', gradient: { angle: 0, radial: true, stops: [{ at: 0, color: 'bg1' }, { at: 0.6, color: 'accent2' }] } }
    })
    const deck = deckOf([shape, text])
    deck.slides[0] = { ...deck.slides[0], background: { kind: 'gradient', radial: true, angle: 0, stops: [{ at: 0, color: 'bg1' }, { at: 1, color: 'bg2' }] } }
    const { zip, read } = await unzip(await writePptx(deck))
    const slide = await read('ppt/slides/slide1.xml')
    const [linear, radial] = tree(slide).map((node) => child(node, 'p:spPr')!)
    const stops = descendants(child(linear, 'a:gradFill'), 'a:gs')

    expect(elements(linear).map((node) => node.name)).toEqual(['a:xfrm', 'a:prstGeom', 'a:gradFill', 'a:ln'])
    expect(stops.map((stop) => attr(stop, 'pos'))).toEqual(['0', '100000'])
    expect(attr(find(stops[0], 'a:schemeClr'), 'val')).toBe('accent1')
    expect(attr(find(stops[0], 'a:schemeClr/a:alpha'), 'val')).toBe('50000')
    expect(attr(find(stops[1], 'a:srgbClr'), 'val')).toBe('FF0000')
    expect(find(linear, 'a:gradFill/a:lin')?.attrs).toEqual({ ang: '2700000', scaled: '0' })
    expect(elements(radial).map((node) => node.name)).toEqual(['a:xfrm', 'a:prstGeom', 'a:gradFill', 'a:ln'])
    expect(descendants(child(radial, 'a:gradFill'), 'a:gs').map((stop) => attr(stop, 'pos'))).toEqual(['0', '60000'])
    expect(attr(find(radial, 'a:gradFill/a:path'), 'path')).toBe('circle')
    expect(find(radial, 'a:gradFill/a:path/a:fillToRect')?.attrs).toEqual({ l: '50000', t: '50000', r: '50000', b: '50000' })
    expect(find(radial, 'a:gradFill/a:lin')).toBeUndefined()
    expect(attr(find(slide, 'p:cSld/p:bg/p:bgPr/a:gradFill/a:path'), 'path')).toBe('circle')
    await expectWhole(zip)
  })

  it('writes freeforms as custom geometry, small path units scaled up', async () => {
    const shape = shapeElement('rect', { x: 100, y: 100, width: 300, height: 200 }, {
      paths: [
        { width: 1, height: 1, d: 'M 0 0 L 1 0 L 0.5 1 Z' },
        { width: 100, height: 50, d: 'M0,0 C10,20 30,40 100,50 Q 50 0 0 50', fill: false, stroke: false }
      ]
    })
    const { zip, read } = await unzip(await writePptx(deckOf([shape])))
    const spPr = child(tree(await read('ppt/slides/slide1.xml'))[0], 'p:spPr')
    const geometry = child(spPr, 'a:custGeom')
    const [triangle, curve] = childrenNamed(child(geometry, 'a:pathLst'), 'a:path')
    const segments = (path: XmlElement) => elements(path).map((node) => [node.name, ...childrenNamed(node, 'a:pt').map((pt) => `${pt.attrs.x},${pt.attrs.y}`)].join(' '))

    expect(child(spPr, 'a:prstGeom')).toBeUndefined()
    expect(elements(geometry).map((node) => node.name)).toEqual(['a:avLst', 'a:gdLst', 'a:ahLst', 'a:cxnLst', 'a:rect', 'a:pathLst'])
    expect(child(geometry, 'a:rect')?.attrs).toEqual({ l: 'l', t: 't', r: 'r', b: 'b' })
    expect(triangle.attrs).toEqual({ w: '100000', h: '100000' })
    expect(segments(triangle)).toEqual(['a:moveTo 0,0', 'a:lnTo 100000,0', 'a:lnTo 50000,100000', 'a:close'])
    expect(curve.attrs).toEqual({ w: '100', h: '50', fill: 'none', stroke: '0' })
    expect(segments(curve)).toEqual(['a:moveTo 0,0', 'a:cubicBezTo 10,20 30,40 100,50', 'a:quadBezTo 50,0 0,50'])
    await expectWhole(zip)
  })

  it('writes every preset as its own geometry, with its adjust values', async () => {
    const shapes = SHAPE_KINDS.map((kind, index) => shapeElement(kind, { x: (index % 12) * 78, y: Math.floor(index / 12) * 54, width: 70, height: 48 }, kind === 'blockArc' ? { adjust: { adj1: 10800000, adj2: 0, adj3: 25000 } } : {}))
    const { zip, read } = await unzip(await writePptx(deckOf(shapes)))
    const geometries = tree(await read('ppt/slides/slide1.xml')).map((node) => find(node, 'p:spPr/a:prstGeom')!)
    const arc = geometries[SHAPE_KINDS.indexOf('blockArc')]

    expect(geometries.map((node) => attr(node, 'prst'))).toEqual([...SHAPE_KINDS])
    expect(childrenNamed(child(arc, 'a:avLst'), 'a:gd').map((gd) => `${gd.attrs.name} ${gd.attrs.fmla}`)).toEqual(['adj1 val 10800000', 'adj2 val 0', 'adj3 val 25000'])
    expect(geometries.filter((node) => node !== arc).every((node) => elements(child(node, 'a:avLst')).length === 0)).toBe(true)
    await expectWhole(zip)
  })

  it('writes connectors glued to the shapes they join, by those shapes’ ids and connection sites', async () => {
    const link = lineElement([400, 330], [200, 130], { id: 'link', end: 'triangle', connector: { preset: 'bentConnector3', adjust: { adj1: 40000 }, start: { element: 'from', site: 3 }, end: { element: 'to', site: 1 } } })
    const loose = lineElement([10, 10], [50, 50], { id: 'loose', connector: { preset: 'straightConnector1', start: { element: 'gone', site: 0 } } })
    const from = shapeElement('rect', { x: 100, y: 100, width: 100, height: 60 }, { id: 'from' })
    const to = shapeElement('ellipse', { x: 400, y: 300, width: 100, height: 60 }, { id: 'to' })
    const { zip, read } = await unzip(await writePptx(deckOf([link, from, to, loose])))
    const [joined, start, end, free] = tree(await read('ppt/slides/slide1.xml'))
    const props = find(joined, 'p:nvCxnSpPr/p:cNvCxnSpPr')
    const xfrm = find(joined, 'p:spPr/a:xfrm')

    expect([joined.name, start.name, end.name, free.name]).toEqual(['p:cxnSp', 'p:sp', 'p:sp', 'p:cxnSp'])
    expect(nameOf(joined)).toBe('Connector 1')
    expect(elements(props).map((node) => node.name)).toEqual(['a:stCxn', 'a:endCxn'])
    expect(child(props, 'a:stCxn')?.attrs).toEqual({ id: idOf(start), idx: '3' })
    expect(child(props, 'a:endCxn')?.attrs).toEqual({ id: idOf(end), idx: '1' })
    expect(elements(joined).map((node) => node.name)).not.toContain('p:txBody')
    expect(attr(find(joined, 'p:spPr/a:prstGeom'), 'prst')).toBe('bentConnector3')
    expect(attr(find(joined, 'p:spPr/a:prstGeom/a:avLst/a:gd'), 'fmla')).toBe('val 40000')
    expect([attr(xfrm, 'flipH'), attr(xfrm, 'flipV')]).toEqual(['1', '1'])
    expect(boxOf(xfrm)).toEqual(emuBox({ x: 200, y: 130, width: 200, height: 200 }))
    expect(attr(find(joined, 'p:spPr/a:ln/a:tailEnd'), 'type')).toBe('triangle')
    expect(elements(find(free, 'p:nvCxnSpPr/p:cNvCxnSpPr'))).toEqual([])
    expect(attr(find(free, 'p:spPr/a:prstGeom'), 'prst')).toBe('straightConnector1')
    await expectWhole(zip)
  })

  it('writes each cell’s own lines, a side left out taking the table’s, and an edge two cells share the same from both', async () => {
    const red: Stroke = { color: '#ff0000', width: 3, dash: 'dash' }
    const green: Stroke = { color: '#00ff00', width: 2, dash: 'solid' }
    const blue: Stroke = { color: '#0000ff', width: 1.5, dash: 'solid' }
    let table = tableElement({ x: 100, y: 100, width: 300, height: 150 }, 3, 3)
    table = withCell(table, { row: 0, column: 0 }, (cell) => ({ ...cell, colSpan: 2, borders: { bottom: red, left: null } }))
    table = withCell(table, { row: 1, column: 1 }, (cell) => ({ ...cell, borders: { right: green } }))
    table = withCell(table, { row: 2, column: 2 }, (cell) => ({ ...cell, borders: { top: blue } }))
    table = { ...table, cells: settleSpans(table.cells, 3) }
    const { zip, read } = await unzip(await writePptx(deckOf([table])))
    const rows = descendants(await read('ppt/slides/slide1.xml'), 'a:tr').map((tr) => childrenNamed(tr, 'a:tc'))
    const line = (node: XmlElement | undefined) => (child(node, 'a:noFill') ? 'none' : [attr(find(node, 'a:solidFill/a:srgbClr'), 'val') ?? attr(find(node, 'a:solidFill/a:schemeClr'), 'val'), attr(node, 'w'), attr(child(node, 'a:prstDash'), 'val')].join(' '))
    const sides = rows.map((row) => row.map((tc) => ['a:lnL', 'a:lnR', 'a:lnT', 'a:lnB'].map((name) => line(find(tc, `a:tcPr/${name}`)))))
    const plain = 'bg1 12700 solid'
    const r = 'FF0000 38100 dash'
    const g = '00FF00 25400 solid'
    const b = '0000FF 19050 solid'

    expect(sides).toEqual([
      [
        ['none', plain, plain, r],
        [plain, plain, plain, r],
        [plain, plain, plain, plain]
      ],
      [
        [plain, plain, r, plain],
        [plain, g, r, plain],
        [g, plain, plain, b]
      ],
      [
        [plain, plain, plain, plain],
        [plain, plain, plain, plain],
        [plain, plain, b, plain]
      ]
    ])
    await expectWhole(zip)
  })
})

const CHART_PARTS = (): KeptPart[] => [
  {
    id: 'rId2',
    type: `${OFFICE}/chart`,
    path: 'ppt/charts/chart1.xml',
    contentType: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
    data: base64(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${OFFICE}"><c:chart/><c:externalData r:id="rId1"/></c:chartSpace>`),
    parts: [
      { id: 'rId1', type: `${OFFICE}/package`, path: 'ppt/embeddings/Microsoft_Excel_Worksheet.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: base64('PK workbook') },
      { id: 'rId2', type: 'http://schemas.microsoft.com/office/2011/relationships/chartStyle', path: 'ppt/charts/style1.xml', contentType: 'application/vnd.ms-office.chartstyle+xml', data: base64('<cs:chartStyle xmlns:cs="http://schemas.microsoft.com/office/drawing/2012/chartStyle" id="201"/>') },
      { id: 'rId3', type: 'http://schemas.microsoft.com/office/2011/relationships/chartColorStyle', path: 'ppt/charts/colors1.xml', contentType: 'application/vnd.ms-office.chartcolorstyle+xml', data: base64('<cs:colorStyle xmlns:cs="http://schemas.microsoft.com/office/drawing/2012/chartStyle" id="10"/>') }
    ]
  }
]

const CHART_FRAME =
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Chart 3"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId2"/></a:graphicData></a:graphic></p:graphicFrame>'

const EXTENDED_FRAME =
  '<mc:AlternateContent><mc:Choice Requires="cx1"><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="Chart 6"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="1" y="1"/><a:ext cx="1" cy="1"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/drawing/2014/chartex"><cx:chart r:id="rId5"/></a:graphicData></a:graphic></p:graphicFrame></mc:Choice><mc:Fallback><p:pic><p:nvPicPr><p:cNvPr id="7" name="Chart 6"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId6"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="1" y="1"/><a:ext cx="1" cy="1"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></mc:Fallback></mc:AlternateContent>'

const SMART_ART_FRAME =
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Diagram 4"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rId3" r:lo="rId4" r:qs="rId5" r:cs="rId6"/></a:graphicData></a:graphic></p:graphicFrame>'

const SMART_ART_DATA = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst/><dgm:extLst><a:ext uri="http://schemas.microsoft.com/office/drawing/2008/diagram"><dsp:dataModelExt xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" relId="rId7" minVer="http://schemas.openxmlformats.org/drawingml/2006/diagram"/></a:ext></dgm:extLst></dgm:dataModel>`

const DIAGRAM = (name: string, kind: string, root: string) => ({
  path: `ppt/diagrams/${name}1.xml`,
  contentType: `application/vnd.openxmlformats-officedocument.drawingml.${kind}+xml`,
  data: base64(`<dgm:${root} xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"/>`)
})

function keptObjects() {
  const chart: ObjectElement = { id: 'chart', kind: 'object', object: 'chart', x: 100, y: 120, width: 400, height: 240, rotation: 0, preview: { src: LOGO, natural: { width: 1, height: 1 } }, source: { xml: CHART_FRAME, parts: CHART_PARTS() } }
  const extended: ObjectElement = {
    id: 'extended',
    kind: 'object',
    object: 'chart',
    name: 'Funnel',
    x: 520,
    y: 40,
    width: 300,
    height: 200,
    rotation: 0,
    preview: { src: PAPER, natural: { width: 1, height: 1 } },
    source: {
      xml: EXTENDED_FRAME,
      parts: [
        { id: 'rId5', type: 'http://schemas.microsoft.com/office/2014/relationships/chartEx', path: 'ppt/charts/chartEx1.xml', contentType: 'application/vnd.ms-office.chartex+xml', data: base64('<cx:chartSpace xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"/>') },
        { id: 'rId6', type: `${OFFICE}/image`, path: 'ppt/media/image1.png', contentType: 'image/png', data: PAPER.split(',')[1] }
      ]
    }
  }
  const smartArt: ObjectElement = {
    id: 'smart-art',
    kind: 'object',
    object: 'diagram',
    name: 'Process',
    x: 520,
    y: 300,
    width: 360,
    height: 200,
    rotation: 0,
    shapes: [imageElement(LOGO, { width: 1, height: 1 }, { x: 10, y: 10, width: 40, height: 40 }, { id: 'inside' })],
    drawnIn: { width: 360, height: 200 },
    source: {
      xml: SMART_ART_FRAME,
      parts: [
        { id: 'rId3', type: `${OFFICE}/diagramData`, path: 'ppt/diagrams/data1.xml', contentType: 'application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml', data: base64(SMART_ART_DATA) },
        { id: 'rId4', type: `${OFFICE}/diagramLayout`, ...DIAGRAM('layout', 'diagramLayout', 'layoutDef') },
        { id: 'rId5', type: `${OFFICE}/diagramQuickStyle`, ...DIAGRAM('quickStyle', 'diagramStyle', 'styleDef') },
        { id: 'rId6', type: `${OFFICE}/diagramColors`, ...DIAGRAM('colors', 'diagramColors', 'colorsDef') },
        { id: 'rId7', type: 'http://schemas.microsoft.com/office/2007/relationships/diagramDrawing', path: 'ppt/diagrams/drawing1.xml', contentType: 'application/vnd.ms-office.drawingml.diagramDrawing+xml', data: base64('<dsp:drawing xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram"/>') }
      ]
    }
  }
  const before = textElement({ x: 40, y: 20, width: 200, height: 40 }, textBody({ font: '+body', size: 18, color: 'tx1' }, { text: 'Before' }), { id: 'before' })
  const between = shapeElement('rect', { x: 40, y: 400, width: 100, height: 60 }, { id: 'between' })
  const again: ObjectElement = { ...chart, id: 'again', preview: undefined, source: { xml: CHART_FRAME, parts: CHART_PARTS() } }

  return { deck: deckOf([before, chart, between, smartArt, extended], [again]), chart, extended, smartArt }
}

describe('writing kept objects back', () => {
  it('puts a kept chart back where it is in the drawing order, its parts copied in under fresh names with their own relationships', async () => {
    const { deck, chart } = keptObjects()
    const { zip, read, related } = await unzip(await writePptx(deck))
    const slide = await read('ppt/slides/slide1.xml')
    const shapes = tree(slide)
    const frame = shapes[1]
    const reference = find(frame, 'a:graphic/a:graphicData/c:chart')
    const first = await related('ppt/slides/slide1.xml', attr(reference, 'r:id'))
    const second = await related('ppt/slides/slide2.xml', attr(find(tree(await read('ppt/slides/slide2.xml'))[0], 'a:graphic/a:graphicData/c:chart'), 'r:id'))
    const inner = async (part: string) => (await Relationships.read(zip, part)).entries.map((entry) => `${entry.id} ${resolveTarget(part, entry.target)}`)
    const types = await read('[Content_Types].xml')
    const override = (part: string) => attr(descendants(types, 'Override').find((entry) => attr(entry, 'PartName') === `/${part}`), 'ContentType')

    expect(shapes.map((node) => node.name)).toEqual(['p:sp', 'p:graphicFrame', 'p:sp', 'p:graphicFrame', 'mc:AlternateContent'])
    expect(nameOf(frame)).toBe('Chart 1')
    expect(boxOf(child(frame, 'p:xfrm'))).toEqual(emuBox(chart))
    expect(first).toEqual({ type: `${OFFICE}/chart`, part: 'ppt/charts/chart1.xml' })
    expect(await zip.file(first.part)!.async('base64')).toBe(chart.source.parts[0].data)
    expect(await inner(first.part)).toEqual(['rId1 ppt/embeddings/Microsoft_Excel_Worksheet.xlsx', 'rId2 ppt/charts/style1.xml', 'rId3 ppt/charts/colors1.xml'])
    expect(second.part).toBe('ppt/charts/chart2.xml')
    expect(await inner(second.part)).toEqual(['rId1 ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx', 'rId2 ppt/charts/style2.xml', 'rId3 ppt/charts/colors2.xml'])
    expect(['ppt/charts/chart1.xml', 'ppt/charts/chart2.xml', 'ppt/charts/style2.xml', 'ppt/charts/colors1.xml'].map(override)).toEqual([
      'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
      'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
      'application/vnd.ms-office.chartstyle+xml',
      'application/vnd.ms-office.chartcolorstyle+xml'
    ])
    expect(new Set(shapeIds(slide)).size).toBe(shapeIds(slide).length)
    await expectWhole(zip)
  })

  it('puts kept SmartArt back with its data naming the drawing by the slide’s new relationship', async () => {
    const { deck, smartArt } = keptObjects()
    const { zip, read, related } = await unzip(await writePptx(deck))
    const part = 'ppt/slides/slide1.xml'
    const frame = tree(await read(part))[3]
    const ids = find(frame, 'a:graphic/a:graphicData/dgm:relIds')!
    const parts = await Promise.all(['r:dm', 'r:lo', 'r:qs', 'r:cs'].map((name) => related(part, attr(ids, name))))
    const drawing = (await Relationships.read(zip, part)).entries.find((entry) => entry.type.endsWith('/diagramDrawing'))!
    const data = parseXml(await zip.file(parts[0].part)!.async('string'))

    expect(nameOf(frame)).toBe('Process')
    expect(boxOf(child(frame, 'p:xfrm'))).toEqual(emuBox(smartArt))
    expect(parts.map((entry) => `${entry.type.split('/').pop()} ${entry.part}`)).toEqual([
      'diagramData ppt/diagrams/data1.xml',
      'diagramLayout ppt/diagrams/layout1.xml',
      'diagramQuickStyle ppt/diagrams/quickStyle1.xml',
      'diagramColors ppt/diagrams/colors1.xml'
    ])
    expect(new Set(['r:dm', 'r:lo', 'r:qs', 'r:cs'].map((name) => attr(ids, name))).size).toBe(4)
    expect(resolveTarget(part, drawing.target)).toBe('ppt/diagrams/drawing1.xml')
    expect(drawing.id).not.toBe('rId7')
    expect(attr(descendants(data, 'dsp:dataModelExt')[0] ?? descendants(data, 'dataModelExt')[0], 'relId')).toBe(drawing.id)
    expect(descendants(data, 'dgm:ptLst')).toHaveLength(1)
    await expectWhole(zip)
  })

  it('puts back a frame written two ways, declaring the namespaces it uses and placing both ways at its box under one id', async () => {
    const { deck, extended } = keptObjects()
    const { zip, read, raw, related } = await unzip(await writePptx(deck))
    const part = 'ppt/slides/slide1.xml'
    const alternatives = tree(await raw(part))[4]
    const canonical = tree(await read(part))[4]
    const choice = find(canonical, 'mc:Choice/p:graphicFrame')
    const fallback = find(canonical, 'mc:Fallback/p:pic')
    const picture = await related(part, attr(find(fallback, 'p:blipFill/a:blip'), 'r:embed'))
    const others = tree(await read(part)).slice(0, 4).map(idOf)

    expect(alternatives.attrs).toMatchObject({ 'xmlns:mc': 'http://schemas.openxmlformats.org/markup-compatibility/2006', 'xmlns:cx': 'http://schemas.microsoft.com/office/drawing/2014/chartex', 'xmlns:cx1': 'http://schemas.microsoft.com/office/drawing/2015/9/8/chartex' })
    expect(boxOf(child(choice, 'p:xfrm'))).toEqual(emuBox(extended))
    expect(boxOf(find(fallback, 'p:spPr/a:xfrm'))).toEqual(emuBox(extended))
    expect([nameOf(choice!), nameOf(fallback!)]).toEqual(['Funnel', 'Funnel'])
    expect(idOf(choice)).toBe(idOf(fallback))
    expect(others).not.toContain(idOf(choice))
    expect((await related(part, attr(find(choice, 'a:graphic/a:graphicData/cx:chart'), 'r:id'))).part).toBe('ppt/charts/chartEx1.xml')
    expect(picture.part).toMatch(/^ppt\/media\/[\w-]+\.png$/)
    expect(await zip.file(picture.part)!.async('base64')).toBe(PAPER.split(',')[1])
    await expectWhole(zip)
  })
})

describe('Herald’s own copy of a deck with a master and kept objects', () => {
  async function written() {
    const { deck: base } = keptObjects()
    const master = defaultMaster(base.size)
    const logo = imageElement(LOGO, { width: 1, height: 1 }, { x: 860, y: 20, width: 80, height: 40 }, { id: 'logo', name: 'Logo' })
    const deck: Deck = {
      ...base,
      master: {
        background: { kind: 'image', src: PAPER, natural: { width: 1, height: 1 } },
        elements: [...master.elements, logo],
        layouts: master.layouts.map((layout) => (layout.id === 'section' ? { ...layout, background: { kind: 'image' as const, src: LOGO, natural: { width: 1, height: 1 } } } : layout))
      }
    }
    const zip = await JSZip.loadAsync(await writePptx(deck))

    return { deck, zip, copy: JSON.parse(await zip.file(HERALD_PART)!.async('string')) }
  }

  it('names the parts already in the file for the master’s and layouts’ pictures, object previews and pictures, and kept parts', async () => {
    const { copy } = await written()
    const text = JSON.stringify(copy.deck)
    const [, chart, , smartArt, extended] = copy.deck.slides[0].elements

    expect(copy.version).toBe(2)
    expect(text).not.toContain(LOGO.split(',')[1])
    expect(text).not.toContain(PAPER.split(',')[1])
    expect(copy.deck.master.elements.at(-1).src).toMatch(/^part:\/ppt\/media\//)
    expect(copy.deck.master.background.src).toMatch(/^part:\/ppt\/media\//)
    expect(copy.deck.master.layouts[3].background.src).toMatch(/^part:\/ppt\/media\//)
    expect(chart.preview.src).toMatch(/^part:\/ppt\/media\//)
    expect(extended.preview.src).toMatch(/^part:\/ppt\/media\//)
    expect(smartArt.shapes[0].src).toMatch(/^part:\/ppt\/media\//)
    expect(chart.source.parts[0].data).toBe('part:/ppt/charts/chart1.xml')
    expect(chart.source.parts[0].parts.map((part: KeptPart) => part.data)).toEqual(['part:/ppt/embeddings/Microsoft_Excel_Worksheet.xlsx', 'part:/ppt/charts/style1.xml', 'part:/ppt/charts/colors1.xml'])
    expect(smartArt.source.parts[0].data).toBe(base64(SMART_ART_DATA))
    expect(smartArt.source.parts.slice(1).map((part: KeptPart) => part.data)).toEqual(['part:/ppt/diagrams/layout1.xml', 'part:/ppt/diagrams/quickStyle1.xml', 'part:/ppt/diagrams/colors1.xml', 'part:/ppt/diagrams/drawing1.xml'])
    expect(extended.source.parts[1].data).toMatch(/^part:\/ppt\/media\//)
  })

  it('reads them back exactly, and still reads copies written before kept parts were named', async () => {
    const { deck, zip, copy } = await written()
    const back = await readEmbeddedDeck(zip, deck.title)

    expect(back && 'deck' in back ? back.deck : back).toEqual(normalizeDeck(deck, deck.title))

    const plain = model.newDeck('Old')
    const old = await JSZip.loadAsync(await writePptx(plain))
    const oldCopy = JSON.parse(await old.file(HERALD_PART)!.async('string'))
    old.file(HERALD_PART, JSON.stringify({ ...oldCopy, version: 1 }))
    const read = await readEmbeddedDeck(old, plain.title)

    expect(read && 'deck' in read ? read.deck : read).toEqual(normalizeDeck(plain, plain.title))
    expect(copy.fingerprint).toMatch(/^2:/)
  })
})
