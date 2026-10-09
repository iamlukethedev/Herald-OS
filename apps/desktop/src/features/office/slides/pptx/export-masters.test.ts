import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { type Background, type Box, type Deck, LAYOUTS, type SlideTransition } from '../deck.ts'
import { imageElement, shapeElement, textElement } from '../elements.ts'
import { defaultMaster, LAYOUT_NAMES, placeholderElement, placeholderFor } from '../layouts.ts'
import * as model from '../model.ts'
import { textBody } from '../text.ts'
import { themeById } from '../themes.ts'
import { writePptx } from './export.ts'
import { extensionOf, Relationships, resolveTarget } from './write-package.ts'
import { attr, child, childrenNamed, descendants, elements, find, parseXml, textOf, type XmlElement } from './xml.ts'

const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const PAPER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC'
const NOW = new Date(2026, 9, 9)

const emu = (points: number): string => String(Math.round(points * 12700))
const boxOf = (xfrm: XmlElement | undefined): string[] => [attr(find(xfrm, 'a:off'), 'x'), attr(find(xfrm, 'a:off'), 'y'), attr(find(xfrm, 'a:ext'), 'cx'), attr(find(xfrm, 'a:ext'), 'cy')].map(String)
const emuBox = (box: Box): string[] => [box.x, box.y, box.width, box.height].map(emu)

async function unzip(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes)
  const text = async (name: string): Promise<string> => (await zip.file(name)?.async('string')) ?? '<missing/>'
  const read = async (name: string): Promise<XmlElement> => parseXml(await text(name))
  const raw = async (name: string): Promise<XmlElement> => parseXml(await text(name), { canonical: false })
  const target = async (part: string, id: string | undefined): Promise<string> => {
    const relationship = (await Relationships.read(zip, part)).get(id ?? '')

    return relationship ? resolveTarget(part, relationship.target) : ''
  }

  return { zip, read, raw, target }
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

    if (!part) {
      continue
    }

    const stack = [parseXml(await zip.file(part)!.async('string'))]

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

async function contentTypeOf(zip: JSZip, part: string): Promise<string | undefined> {
  const types = parseXml(await zip.file('[Content_Types].xml')!.async('string'))
  const override = descendants(types, 'Override').find((entry) => attr(entry, 'PartName') === `/${part}`)

  return attr(override, 'ContentType') ?? attr(descendants(types, 'Default').find((entry) => attr(entry, 'Extension') === extensionOf(part)), 'ContentType')
}

const tree = (root: XmlElement): XmlElement[] => elements(find(root, 'p:cSld/p:spTree')).filter((node) => node.name !== 'p:nvGrpSpPr' && node.name !== 'p:grpSpPr')
const phOf = (node: XmlElement): XmlElement | undefined => find(elements(node).find((entry) => entry.name.startsWith('p:nv')), 'p:nvPr/p:ph')
const nameOf = (node: XmlElement): string | undefined => attr(find(elements(node).find((entry) => entry.name.startsWith('p:nv')), 'p:cNvPr'), 'name')
const byType = (root: XmlElement, type: string): XmlElement | undefined => tree(root).find((node) => attr(phOf(node), 'type') === type)

/** A deck with a master of its own: a band and a logo, a styled title, layouts with drawings, a background and footers of their own, and the header and footer settings on. */
function masterDeck() {
  const start = model.newDeck('Masters', { theme: themeById('ocean') })
  const base = defaultMaster(start.size)
  const logo = imageElement(LOGO, { width: 1, height: 1 }, { x: 860, y: 20, width: 80, height: 40 }, { name: 'Logo' })
  const band = shapeElement('rect', { x: 0, y: 520, width: 960, height: 20 }, { fill: { color: 'accent2' } })
  const stamp = textElement({ x: 700, y: 60, width: 200, height: 30 }, textBody({ font: '+body', size: 12, color: 'tx2' }, { text: 'Confidential' }))
  const corner = placeholderElement({ role: 'number', box: { x: 880, y: 10, width: 60, height: 20 }, style: { font: '+body', size: 10, color: 'accent1' }, anchor: 'top', align: 'right' })
  const paper: Background = { kind: 'image', src: PAPER, natural: { width: 1, height: 1 } }
  const master = base.elements.map((element) =>
    element.placeholder?.role === 'title' && element.kind === 'text' ? { ...element, body: { ...element.body, style: { ...element.body.style, size: 44, color: 'accent1' as const, bold: true }, paragraphs: [{ ...element.body.paragraphs[0], align: 'center' as const }] } } : element
  )
  const layouts = base.layouts.map((layout) => {
    switch (layout.id) {
      case 'title':
        return { ...layout, showMaster: false }
      case 'title-only':
        return { ...layout, elements: layout.elements.map((element) => (element.placeholder ? { ...element, placeholder: { ...element.placeholder, prompt: 'Name the chapter' } } : element)) }
      case 'title-content':
        return { ...layout, elements: [...layout.elements, stamp] }
      case 'section':
        return { ...layout, background: paper }
      case 'blank':
        return { ...layout, elements: [...layout.elements, corner] }
      default:
        return layout
    }
  })
  let deck: Deck = {
    ...start,
    master: { background: { kind: 'solid', color: 'bg2' }, elements: [band, ...master, logo], layouts },
    headerFooter: { date: true, dateFormat: 'datetime2', number: true, footer: true, footerText: 'Herald OS', skipTitle: true }
  }
  deck = model.addSlide(deck, { layout: 'title-content', title: 'Plan', body: ['One'] }).deck
  deck = model.addSlide(deck, { layout: 'blank' }).deck
  deck = model.addSlide(deck, { layout: 'section', title: 'Part two' }).deck

  return { deck, logo, band, stamp, corner, master }
}

describe('writing the slide master, its layouts and its theme', () => {
  it('writes the master’s background, placeholders, text styles and drawings with their pictures', async () => {
    const { deck, master: elementsOfMaster, logo } = masterDeck()
    const { zip, read, target } = await unzip(await writePptx(deck, { now: NOW }))
    const part = 'ppt/slideMasters/slideMaster1.xml'
    const master = await read(part)
    const shapes = tree(master)
    const styles = child(master, 'p:txStyles')
    const body = childrenNamed(child(styles, 'p:bodyStyle'), 'a:lvl1pPr').concat(elements(child(styles, 'p:bodyStyle')).slice(1))
    const picture = shapes.find((node) => node.name === 'p:pic')!
    const media = await target(part, attr(find(picture, 'p:blipFill/a:blip'), 'r:embed'))

    expect(attr(find(master, 'p:cSld/p:bg/p:bgPr/a:solidFill/a:schemeClr'), 'val')).toBe('bg2')
    expect(shapes.map((node) => attr(phOf(node), 'type') ?? node.name)).toEqual(['p:sp', 'title', 'body', 'dt', 'ftr', 'sldNum', 'p:pic'])
    expect(shapes.map((node) => attr(phOf(node), 'idx') ?? '')).toEqual(['', '', '1', '2', '3', '4', ''])
    expect(shapes.slice(1, 6).map((node) => boxOf(find(node, 'p:spPr/a:xfrm')))).toEqual(elementsOfMaster.map(emuBox))
    expect(nameOf(picture)).toBe('Logo')
    expect(boxOf(find(picture, 'p:spPr/a:xfrm'))).toEqual(emuBox(logo))
    expect(media).toMatch(/^ppt\/media\/[\w-]+\.png$/)
    expect(await zip.file(media)!.async('base64')).toBe(LOGO.split(',')[1])
    expect((await Relationships.read(zip, part)).entries.find((entry) => resolveTarget(part, entry.target) === media)?.type).toBe('http://schemas.openxmlformats.org/officeDocument/2006/relationships/image')
    expect(await contentTypeOf(zip, media)).toBe('image/png')
    expect(find(byType(master, 'title')!, 'p:txBody/a:lstStyle')?.children).toEqual([])

    expect(elements(styles).map((node) => node.name)).toEqual(['p:titleStyle', 'p:bodyStyle', 'p:otherStyle'])
    expect(attr(find(styles, 'p:titleStyle/a:lvl1pPr'), 'algn')).toBe('ctr')
    expect(find(styles, 'p:titleStyle/a:lvl1pPr/a:defRPr')?.attrs).toMatchObject({ sz: '4400', b: '1' })
    expect(attr(find(styles, 'p:titleStyle/a:lvl1pPr/a:defRPr/a:solidFill/a:schemeClr'), 'val')).toBe('accent1')
    expect(attr(find(styles, 'p:titleStyle/a:lvl1pPr/a:defRPr/a:latin'), 'typeface')).toBe('+mj-lt')
    expect(body.map((level) => level.name)).toEqual(Array.from({ length: 9 }, (_, n) => `a:lvl${n + 1}pPr`))
    expect(body.slice(0, 3).map((level) => attr(child(level, 'a:buChar'), 'char'))).toEqual(['•', '◦', '▪'])
    expect(body.slice(0, 3).map((level) => attr(level, 'marL'))).toEqual(['342900', '685800', '1028700'])
    expect(body.map((level) => attr(child(level, 'a:defRPr'), 'sz'))).toEqual(Array(9).fill('2400'))
    expect(attr(find(body[0], 'a:defRPr/a:latin'), 'typeface')).toBe('+mn-lt')

    expect(child(master, 'p:hf')?.attrs).toEqual({ hdr: '0' })
    expect(elements(master).map((node) => node.name)).toEqual(['p:cSld', 'p:clrMap', 'p:sldLayoutIdLst', 'p:hf', 'p:txStyles'])
    await expectWhole(zip)
  })

  it('writes a layout for each of the master’s layouts, with its placeholders, its own footers or the master’s, its drawings and its background', async () => {
    const { deck, stamp, corner, master: elementsOfMaster } = masterDeck()
    const { zip, read, target } = await unzip(await writePptx(deck, { now: NOW }))
    const masterPart = 'ppt/slideMasters/slideMaster1.xml'
    const master = await read(masterPart)
    const parts = await Promise.all(childrenNamed(child(master, 'p:sldLayoutIdLst'), 'p:sldLayoutId').map((entry) => target(masterPart, attr(entry, 'r:id'))))
    const layouts = await Promise.all(parts.map(read))
    const named = (id: (typeof LAYOUTS)[number]) => layouts[LAYOUTS.indexOf(id)]
    const content = named('title-content')
    const blank = named('blank')
    const section = named('section')
    const masterFooters = elementsOfMaster.filter((element) => element.placeholder && ['date', 'footer', 'number'].includes(element.placeholder.role))

    expect(layouts.map((layout) => attr(find(layout, 'p:cSld'), 'name'))).toEqual(LAYOUTS.map((id) => LAYOUT_NAMES[id]))
    expect(layouts.map((layout) => attr(layout, 'type'))).toEqual(['title', 'obj', 'twoObj', 'secHead', 'titleOnly', 'blank', 'picTx', 'twoTxTwoObj'])
    expect(layouts.map((layout) => attr(layout, 'showMasterSp') ?? '1')).toEqual(['0', '1', '1', '1', '1', '1', '1', '1'])
    expect(await Promise.all(parts.map((part) => Relationships.read(zip, part).then((rels) => rels.entries.filter((entry) => entry.type.endsWith('/slideMaster')).map((entry) => resolveTarget(part, entry.target)))))).toEqual(Array(8).fill([masterPart]))

    expect(tree(content).map((node) => attr(phOf(node), 'type') ?? nameOf(node))).toEqual(['title', 'body', 'Text box 1', 'dt', 'ftr', 'sldNum'])
    expect(tree(content).map((node) => attr(phOf(node), 'idx') ?? '')).toEqual(['', '1', '', '10', '11', '12'])
    expect(descendants(tree(content)[2], 'a:t').map(textOf)).toEqual(['Confidential'])
    expect(boxOf(find(tree(content)[2], 'p:spPr/a:xfrm'))).toEqual(emuBox(stamp))
    expect(tree(content).slice(3).map((node) => boxOf(find(node, 'p:spPr/a:xfrm')))).toEqual(masterFooters.map(emuBox))
    expect(attr(find(byType(content, 'title')!, 'p:txBody/a:lstStyle/a:lvl1pPr/a:defRPr'), 'sz')).toBe('4000')
    expect(childrenNamed(find(byType(content, 'body')!, 'p:txBody/a:lstStyle'), 'a:lvl9pPr')).toHaveLength(1)
    expect(descendants(byType(content, 'body')!, 'a:t').map(textOf)).toEqual(['Click to add text'])

    expect(tree(named('comparison')).map((node) => [attr(phOf(node), 'type') ?? 'obj', attr(phOf(node), 'idx') ?? ''])).toEqual([
      ['title', ''],
      ['body', '1'],
      ['obj', '2'],
      ['body', '3'],
      ['obj', '4'],
      ['dt', '10'],
      ['ftr', '11'],
      ['sldNum', '12']
    ])
    expect(tree(named('picture-caption')).map((node) => attr(phOf(node), 'type'))).toEqual(['title', 'pic', 'body', 'dt', 'ftr', 'sldNum'])
    expect(phOf(byType(named('title-only'), 'title')!)?.attrs).toEqual({ type: 'title', hasCustomPrompt: '1' })
    expect(descendants(byType(named('title-only'), 'title')!, 'a:t').map(textOf)).toEqual(['Name the chapter'])
    expect(attr(phOf(byType(content, 'title')!), 'hasCustomPrompt')).toBeUndefined()

    const number = byType(blank, 'sldNum')!
    expect(boxOf(find(number, 'p:spPr/a:xfrm'))).toEqual(emuBox(corner))
    expect(attr(phOf(number), 'idx')).toBe('12')
    expect(attr(find(number, 'p:txBody/a:lstStyle/a:lvl1pPr'), 'algn')).toBe('r')
    expect(attr(find(number, 'p:txBody/a:lstStyle/a:lvl1pPr/a:defRPr'), 'sz')).toBe('1000')
    expect(attr(find(number, 'p:txBody/a:p/a:fld'), 'type')).toBe('slidenum')
    expect(tree(blank).map((node) => attr(phOf(node), 'type'))).toEqual(['sldNum', 'dt', 'ftr'])

    const picture = await target(parts[LAYOUTS.indexOf('section')], attr(find(section, 'p:cSld/p:bg/p:bgPr/a:blipFill/a:blip'), 'r:embed'))
    expect(await zip.file(picture)?.async('base64')).toBe(PAPER.split(',')[1])
    expect(find(content, 'p:cSld/p:bg')).toBeUndefined()
    await expectWhole(zip)
  })

  it('fills each slide’s layout placeholders by role and index, pictures too, an empty one waiting for its picture', async () => {
    let deck = model.newDeck('Placeholders')
    deck = model.addSlide(deck, { layout: 'picture-caption', title: 'Harbour' }).deck
    const filled = model.addSlide(deck, { layout: 'picture-caption', title: 'Hills' })
    const picture = placeholderFor(filled.deck.slides[2], 'picture')!
    deck = model.updateElements(filled.deck, filled.slideId, [picture.id], (element) => (element.kind === 'image' ? { ...element, src: LOGO, natural: { width: 1, height: 1 } } : element), 'Picture').deck
    deck = model.addSlide(deck, { layout: 'comparison', title: 'Before and after' }).deck
    const { zip, read } = await unzip(await writePptx(deck))
    const [waiting, chosen, comparison] = await Promise.all([2, 3, 4].map((n) => read(`ppt/slides/slide${n}.xml`)))
    const placeholders = (slide: XmlElement) => tree(slide).filter((node) => phOf(node))
    const empty = byType(waiting, 'pic')!
    const full = byType(chosen, 'pic')!

    expect(placeholders(waiting).map((node) => [attr(phOf(node), 'type'), attr(phOf(node), 'idx') ?? ''])).toEqual([
      ['title', ''],
      ['pic', '1'],
      ['body', '2']
    ])
    expect(empty.name).toBe('p:sp')
    expect(boxOf(find(empty, 'p:spPr/a:xfrm'))).toEqual(emuBox(placeholderFor(deck.slides[1], 'picture')!))
    expect(child(empty, 'p:txBody')).toBeUndefined()
    expect(full.name).toBe('p:pic')
    expect(attr(phOf(full), 'idx')).toBe('1')
    expect(attr(find(full, 'p:nvPicPr/p:cNvPicPr/a:picLocks'), 'noGrp')).toBe('1')
    expect(placeholders(comparison).map((node) => [attr(phOf(node), 'type') ?? 'obj', attr(phOf(node), 'idx') ?? ''])).toEqual([
      ['title', ''],
      ['body', '1'],
      ['obj', '2'],
      ['body', '3'],
      ['obj', '4']
    ])
    expect(attr(find(placeholders(comparison)[1], 'p:nvSpPr/p:cNvSpPr'), 'txBox')).toBeUndefined()
    await expectWhole(zip)
  })

  it('writes the theme’s name, colours and fonts', async () => {
    const { deck } = masterDeck()
    const { read } = await unzip(await writePptx(deck, { now: NOW }))
    const theme = await read('ppt/theme/theme1.xml')
    const scheme = find(theme, 'a:themeElements/a:clrScheme')
    const colors = deck.theme.colors

    expect(attr(theme, 'name')).toBe(deck.theme.name)
    expect(['a:dk1', 'a:lt1', 'a:dk2', 'a:lt2', 'a:accent1', 'a:accent6'].map((name) => attr(find(scheme, `${name}/a:srgbClr`), 'val'))).toEqual(
      [colors.tx1, colors.bg1, colors.tx2, colors.bg2, colors.accent1, colors.accent6].map((hex) => hex.slice(1).toUpperCase())
    )
    expect(attr(find(theme, 'a:themeElements/a:fontScheme/a:majorFont/a:latin'), 'typeface')).toBe(deck.theme.fonts.heading)
    expect(attr(find(theme, 'a:themeElements/a:fontScheme/a:minorFont/a:latin'), 'typeface')).toBe(deck.theme.fonts.body)
  })
})

describe('writing the date, footer and slide number', () => {
  it('gives each slide the ones the settings ask for, where its layout or the master puts them', async () => {
    const { deck, corner, master: elementsOfMaster } = masterDeck()
    const { read, target } = await unzip(await writePptx(deck, { now: NOW }))
    const [title, content, blank] = await Promise.all(['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide3.xml'].map(read))
    const place = (role: string) => elementsOfMaster.find((element) => element.placeholder?.role === role)!
    const date = byType(content, 'dt')!
    const footer = byType(content, 'ftr')!
    const number = byType(content, 'sldNum')!

    expect(['dt', 'ftr', 'sldNum'].map((type) => byType(title, type))).toEqual([undefined, undefined, undefined])
    expect(tree(content).slice(-3)).toEqual([date, footer, number])
    expect([date, footer, number].map((node) => attr(phOf(node), 'idx'))).toEqual(['10', '11', '12'])
    expect(boxOf(find(date, 'p:spPr/a:xfrm'))).toEqual(emuBox(place('date')))
    expect(boxOf(find(footer, 'p:spPr/a:xfrm'))).toEqual(emuBox(place('footer')))
    expect(find(date, 'p:txBody/a:p/a:fld')?.attrs).toMatchObject({ type: 'datetime2' })
    expect(textOf(find(date, 'p:txBody/a:p/a:fld/a:t'))).toBe('Friday, October 9, 2026')
    expect(find(footer, 'p:txBody/a:p/a:fld')).toBeUndefined()
    expect(textOf(find(footer, 'p:txBody/a:p/a:r/a:t'))).toBe('Herald OS')
    expect(attr(find(number, 'p:txBody/a:p/a:fld'), 'type')).toBe('slidenum')
    expect(textOf(find(number, 'p:txBody/a:p/a:fld/a:t'))).toBe('2')
    expect(attr(find(number, 'p:txBody/a:p/a:fld/a:rPr'), 'sz')).toBe('1200')
    expect(boxOf(find(byType(blank, 'sldNum'), 'p:spPr/a:xfrm'))).toEqual(emuBox(corner))
    expect(textOf(find(byType(blank, 'sldNum'), 'p:txBody/a:p/a:fld/a:t'))).toBe('3')
    expect(attr(find(await read(await target('ppt/slides/slide3.xml', 'rId1')), 'p:cSld'), 'name')).toBe('Blank')
  })

  it('writes a fixed date as text, and nothing when the deck shows none', async () => {
    const { deck } = masterDeck()
    const fixed = await unzip(await writePptx({ ...deck, headerFooter: { ...deck.headerFooter!, dateText: 'Autumn 2026' } }, { now: NOW }))
    const none = await unzip(await writePptx({ ...deck, headerFooter: undefined }, { now: NOW }))
    const date = byType(await fixed.read('ppt/slides/slide2.xml'), 'dt')!
    const slides = await Promise.all([1, 2, 3, 4].map((n) => none.read(`ppt/slides/slide${n}.xml`)))

    expect(find(date, 'p:txBody/a:p/a:fld')).toBeUndefined()
    expect(textOf(find(date, 'p:txBody/a:p/a:r/a:t'))).toBe('Autumn 2026')
    expect(slides.flatMap((slide) => tree(slide).filter((node) => ['dt', 'ftr', 'sldNum'].includes(attr(phOf(node), 'type') ?? '')))).toEqual([])
    expect(child(await none.read('ppt/slideMasters/slideMaster1.xml'), 'p:hf')?.attrs).toEqual({ sldNum: '0', hdr: '0', ftr: '0', dt: '0' })
  })
})

describe('writing slide transitions', () => {
  const kinds: (SlideTransition | null)[] = [
    { kind: 'fade', duration: 400 },
    { kind: 'push', duration: 700, direction: 'left' },
    { kind: 'wipe', duration: 1000, direction: 'up' },
    { kind: 'cover', duration: 600, direction: 'down' },
    { kind: 'uncover', duration: 500, direction: 'right' },
    { kind: 'split', duration: 800, direction: 'in', orientation: 'vertical' },
    { kind: 'zoom', duration: 300, direction: 'out' },
    { kind: 'none', duration: 500 },
    null
  ]

  async function written() {
    let deck = model.setTransition(model.newDeck('Moving'), 'push').deck

    for (let n = 1; n < kinds.length; n++) {
      deck = model.addSlide(deck, { layout: 'blank' }).deck
    }

    deck = { ...deck, slides: deck.slides.map((slide, index) => (kinds[index] ? { ...slide, transition: kinds[index]! } : slide)) }

    return unzip(await writePptx(deck))
  }

  it('writes each slide’s own transition with its duration, and the speed nearest it for older apps', async () => {
    const { read, raw } = await written()
    const slides = await Promise.all(kinds.map((_, index) => read(`ppt/slides/slide${index + 1}.xml`)))
    const choices = slides.map((slide) => find(slide, 'mc:AlternateContent/mc:Choice/p:transition'))
    const fallbacks = slides.map((slide) => find(slide, 'mc:AlternateContent/mc:Fallback/p:transition'))
    const effect = (transition: XmlElement | undefined) => {
      const [node] = elements(transition)

      return node ? [node.name, ...Object.entries(node.attrs).map(([key, value]) => `${key}=${value}`)].join(' ') : null
    }
    const expected = ['p:fade', 'p:push dir=l', 'p:wipe dir=u', 'p:cover dir=d', 'p:pull dir=r', 'p:split orient=vert dir=in', 'p:zoom dir=out', null, 'p:push dir=u']

    expect(choices.map(effect)).toEqual(expected)
    expect(fallbacks.map(effect)).toEqual(expected)
    expect(choices.map((node) => attr(node, 'p14:dur') ?? null)).toEqual(['400', '700', '1000', '600', '500', '800', '300', null, '500'])
    expect(choices.map((node) => attr(node, 'spd') ?? null)).toEqual(['fast', 'med', 'slow', 'med', 'fast', 'slow', 'fast', null, 'fast'])
    expect(fallbacks.map((node) => attr(node, 'spd') ?? null)).toEqual(['fast', 'med', 'slow', 'med', 'fast', 'slow', 'fast', null, 'fast'])
    expect(fallbacks.map((node) => (node ? Object.keys(node.attrs) : null))).toEqual(kinds.map((kind) => (kind?.kind === 'none' ? null : ['spd'])))

    const pushed = await raw('ppt/slides/slide2.xml')
    const alternatives = child(pushed, 'mc:AlternateContent')!
    expect(pushed.attrs).toMatchObject({ 'xmlns:mc': 'http://schemas.openxmlformats.org/markup-compatibility/2006', 'mc:Ignorable': 'p14', 'xmlns:p14': 'http://schemas.microsoft.com/office/powerpoint/2010/main' })
    expect(child(alternatives, 'mc:Choice')?.attrs).toEqual({ 'xmlns:p14': 'http://schemas.microsoft.com/office/powerpoint/2010/main', Requires: 'p14' })
    expect(elements(pushed).map((node) => node.name)).toEqual(['p:cSld', 'p:clrMapOvr', 'mc:AlternateContent'])
    expect(elements(slides[7]).map((node) => node.name)).toEqual(['p:cSld', 'p:clrMapOvr'])
    expect(descendants(slides[7], 'p:transition')).toEqual([])
  })
})

describe('writing slides with a theme of their own', () => {
  it('gives each other theme a master of its own, with its own theme part and layouts, and points its slides at them', async () => {
    let deck = model.newDeck('Themes', { theme: themeById('forest') })

    for (let n = 0; n < 3; n++) {
      deck = model.addSlide(deck, { layout: 'title-content', title: `Slide ${n + 2}` }).deck
    }

    deck = { ...deck, slides: deck.slides.map((slide, index) => (index === 1 || index === 2 ? { ...slide, theme: themeById('midnight') } : index === 3 ? { ...slide, theme: themeById('paper') } : slide)) }
    const { zip, read, raw, target } = await unzip(await writePptx(deck))
    const presentation = await read('ppt/presentation.xml')
    const entries = childrenNamed(child(presentation, 'p:sldMasterIdLst'), 'p:sldMasterId')
    const masters = await Promise.all(entries.map((entry) => target('ppt/presentation.xml', attr(entry, 'r:id'))))
    const layoutIds = (await Promise.all(masters.map(read))).flatMap((master) => childrenNamed(child(master, 'p:sldLayoutIdLst'), 'p:sldLayoutId').map((entry) => Number(attr(entry, 'id'))))
    const ids = [...entries.map((entry) => Number(attr(entry, 'id'))), ...layoutIds]
    const masterOfSlide = async (n: number) => {
      const layout = await target(`ppt/slides/slide${n}.xml`, 'rId1')

      return (await Relationships.read(zip, layout)).entries.filter((entry) => entry.type.endsWith('/slideMaster')).map((entry) => resolveTarget(layout, entry.target))
    }
    const themeOfMaster = async (master: string) => (await Relationships.read(zip, master)).entries.filter((entry) => entry.type.endsWith('/theme')).map((entry) => resolveTarget(master, entry.target))

    expect(masters).toEqual(['ppt/slideMasters/slideMaster1.xml', 'ppt/slideMasters/slideMaster2.xml', 'ppt/slideMasters/slideMaster3.xml'])
    expect(layoutIds).toHaveLength(24)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id >= 2147483648)).toBe(true)
    expect(await Promise.all([1, 2, 3, 4].map(masterOfSlide))).toEqual([[masters[0]], [masters[1]], [masters[1]], [masters[2]]])
    expect(await Promise.all(masters.map(themeOfMaster))).toEqual([['ppt/theme/theme1.xml'], ['ppt/theme/theme2.xml'], ['ppt/theme/theme3.xml']])
    const midnight = themeById('midnight')!
    expect(await Promise.all(['ppt/theme/theme2.xml', 'ppt/theme/theme3.xml'].map(async (part) => attr(await read(part), 'name')))).toEqual([midnight.name, themeById('paper')!.name])
    expect(attr(find(await read('ppt/theme/theme2.xml'), 'a:themeElements/a:clrScheme/a:accent1/a:srgbClr'), 'val')).toBe(midnight.colors.accent1.slice(1).toUpperCase())
    expect(attr(find(await read('ppt/theme/theme2.xml'), 'a:themeElements/a:fontScheme/a:majorFont/a:latin'), 'typeface')).toBe(midnight.fonts.heading)
    expect(await target('ppt/slides/slide2.xml', 'rId1')).toBe('ppt/slideLayouts/slideLayout10.xml')
    expect(attr(find(await raw('ppt/slideLayouts/slideLayout10.xml'), 'p:cSld'), 'name')).toBe('Title and Content')
    await expectWhole(zip)
  })

  it('hides the master’s and layout’s drawings on a slide that hides them, and reads it back so', async () => {
    let deck = model.addSlide(model.newDeck('Plain'), { layout: 'title-content' }).deck
    deck = { ...deck, slides: deck.slides.map((slide, index) => (index === 1 ? { ...slide, showMaster: false as const } : slide)) }
    const { read } = await unzip(await writePptx(deck, { now: NOW, embed: false }))

    expect(attr(await read('ppt/slides/slide1.xml'), 'showMasterSp')).toBeUndefined()
    expect(attr(await read('ppt/slides/slide2.xml'), 'showMasterSp')).toBe('0')
  })
})
