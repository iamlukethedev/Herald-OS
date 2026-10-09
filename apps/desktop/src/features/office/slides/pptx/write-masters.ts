import type JSZip from 'jszip'
import type { Background, Deck, LayoutId, Master, Paragraph, PlaceholderRole, SlideElement, SlideLayout, SlideSize, Slot, Theme } from '../deck.ts'
import { FOOTER_ROLES, LAYOUTS, newId } from '../deck.ts'
import { coverCrop } from '../elements.ts'
import { footerText, headerFooterOf } from '../footers.ts'
import { defaultMaster, isFooterRole, layoutOf, masterOf, masterPlaceholder, type PlaceholderSpec, PROMPTS, specOf } from '../layouts.ts'
import { textBody } from '../text.ts'
import { layoutSlots, masterSlots, type PlaceholderSlot } from './placeholders.ts'
import { backgroundXml, bodyPropertiesXml, fillXml, fontXml, lineXml, paragraphXml, presetGeometryXml, runPropertiesXml, solidFill, transformXml } from './write-drawingml.ts'
import { FOOTER_NAMES, FOOTER_SIZES, footerRuns } from './write-footers.ts'
import { CONTENT_TYPES, ContentTypes, EXTENSION_TYPES, extensionOf, freshPart, type PackageWriter, RELATIONSHIP_TYPES, relativeTarget, Relationships, resolveTarget } from './write-package.ts'
import { finishTree, nameOf, placeholderXml } from './write-tree.ts'
import { child, elements, find, parseXml, serializeXml, xml, type XmlElement } from './xml.ts'

/*
 * The slide masters, their layouts and their themes, written whole from the deck in place of the
 * single master PptxGenJS writes. A master has its background, its placeholders (the title and text
 * whose look its text styles give every slide, and the date, footer and slide number) and its
 * drawings; each of Herald's layouts has its placeholders, its own date, footer and slide number or
 * the master's, its drawings and its background. Drawings are written as slides' elements are: on
 * a slide of their own in a second PptxGenJS package (placeholders stand there as plain shapes), and
 * moved here with the pictures they name. Slides with a theme of their own get a master of their own,
 * a copy of the deck's with its own theme and layouts.
 */

export interface LayoutPlan {
  layout: SlideLayout
  part: string
  /** Its placeholders and drawings, then the master's date, footer and slide number where it has none of its own. */
  elements: SlideElement[]
  slots: Map<string, PlaceholderSlot>
}

export interface MasterPlan {
  master: Master
  theme: Theme
  /** The master's background, else its theme's; none is the theme's background colour. */
  background: Background | null
  part: string
  themePart: string
  layouts: LayoutPlan[]
  /** The slides on its layouts, by index. */
  slides: number[]
}

/** What the drawings package draws on a slide of its own for each master and layout, in plan order. */
export interface DrawingSet {
  elements: SlideElement[]
  background: Background | null
  theme: Theme
}

/** PresentationML's name for each layout, which tells other apps (and readers) what the layout is for. */
const LAYOUT_TYPES: Record<LayoutId, string> = {
  title: 'title',
  'title-content': 'obj',
  'two-content': 'twoObj',
  section: 'secHead',
  'title-only': 'titleOnly',
  blank: 'blank',
  'picture-caption': 'picTx',
  comparison: 'twoTxTwoObj'
}

const themeKey = (theme: Theme): string => JSON.stringify([theme.name, theme.colors, theme.fonts, theme.background ?? null])

function layoutPlan(master: Master, id: LayoutId, part: string): LayoutPlan {
  const layout = layoutOf(master, id)
  const own = new Set(layout.elements.map((element) => element.placeholder?.role))
  const ids = new Set(layout.elements.map((element) => element.id))
  const borrowed = FOOTER_ROLES.flatMap((role) => {
    const place = own.has(role) ? undefined : masterPlaceholder(master, role)

    return place ? [ids.has(place.id) ? { ...place, id: newId('footer') } : place] : []
  })
  const all = [...layout.elements, ...borrowed]

  return { layout, part, elements: all, slots: layoutSlots(id, all) }
}

/** The masters a deck is written with: the deck's, then one for each other theme its slides have, in the order they first appear. */
export function planMasters(deck: Deck): MasterPlan[] {
  const master = masterOf(deck)
  const keys = [themeKey(deck.theme)]
  const themes = [deck.theme]
  const slides: number[][] = [[]]

  deck.slides.forEach((slide, index) => {
    const key = slide.theme ? themeKey(slide.theme) : keys[0]
    let at = keys.indexOf(key)

    if (at < 0 && slide.theme) {
      at = keys.push(key) - 1
      themes.push(slide.theme)
      slides.push([])
    }

    slides[Math.max(0, at)].push(index)
  })

  return themes.map((theme, m) => ({
    master,
    theme,
    background: master.background ?? theme.background ?? null,
    part: `ppt/slideMasters/slideMaster${m + 1}.xml`,
    themePart: `ppt/theme/theme${m + 1}.xml`,
    layouts: LAYOUTS.map((id, i) => layoutPlan(master, id, `ppt/slideLayouts/slideLayout${m * LAYOUTS.length + i + 1}.xml`)),
    slides: slides[m]
  }))
}

export const drawingSets = (plans: readonly MasterPlan[]): DrawingSet[] =>
  plans.flatMap((plan) => [{ elements: plan.master.elements, background: plan.background, theme: plan.theme }, ...plan.layouts.map((layout) => ({ elements: layout.elements, background: layout.layout.background, theme: plan.theme }))])

/** A list level's settings (`a:lvlNpPr`) from a placeholder's look; below the first, levels take Herald's own bullets and indents. */
function levelXml(level: number, spec: PlaceholderSpec): XmlElement {
  const own = spec.paragraph ?? {}
  const paragraph: Omit<Paragraph, 'runs'> =
    level === 0 ? { ...own, align: spec.align, level } : { list: own.list, lineSpacing: own.lineSpacing, spaceBefore: own.spaceBefore, spaceAfter: own.spaceAfter, align: spec.align, level }
  const settings = paragraphXml(paragraph)
  delete settings.attrs.lvl

  return xml(`a:lvl${level + 1}pPr`, settings.attrs, [...elements(settings), runPropertiesXml('a:defRPr', spec.style)])
}

const levels = (count: number, spec: PlaceholderSpec): XmlElement[] => Array.from({ length: count }, (_, level) => levelXml(level, spec))

const NAMESPACES = { 'xmlns:a': 'http://schemas.openxmlformats.org/drawingml/2006/main', 'xmlns:r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'xmlns:p': 'http://schemas.openxmlformats.org/presentationml/2006/main' }

const COLOR_MAP = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2', accent1: 'accent1', accent2: 'accent2', accent3: 'accent3', accent4: 'accent4', accent5: 'accent5', accent6: 'accent6', hlink: 'hlink', folHlink: 'folHlink' }

/** The text styles every slide's text takes: titles' and body text's from the master's title and text placeholders (Herald's own where it has none), the rest PowerPoint's. */
function textStylesXml(master: Master, size: SlideSize): XmlElement {
  const lookOf = (role: PlaceholderRole) => specOf((masterPlaceholder(master, role) ?? masterPlaceholder(defaultMaster(size), role))!)!
  const other = Array.from({ length: 9 }, (_, level) =>
    xml(`a:lvl${level + 1}pPr`, { marL: level * 457200, algn: 'l', defTabSz: 914400, rtl: '0', eaLnBrk: '1', latinLnBrk: '0', hangingPunct: '1' }, [xml('a:defRPr', { sz: 1800, kern: 1200 }, [solidFill('tx1'), ...fontXml('+body')])])
  )

  return xml('p:txStyles', {}, [
    xml('p:titleStyle', {}, levels(1, lookOf('title'))),
    xml('p:bodyStyle', {}, levels(9, lookOf('body'))),
    xml('p:otherStyle', {}, [xml('a:defPPr', {}, [xml('a:defRPr', { lang: 'en-US' })]), ...other])
  ])
}

/** Which of the date, footer and slide number the deck's settings show (slides have them as shapes of their own). */
function headerFooterXml(deck: Deck): XmlElement {
  const settings = headerFooterOf(deck)

  return xml('p:hf', { sldNum: settings.number ? undefined : '0', hdr: '0', ftr: settings.footer && settings.footerText ? undefined : '0', dt: settings.date ? undefined : '0' })
}

const PLACEHOLDER_NAMES: Record<PlaceholderRole, string> = { ...FOOTER_NAMES, title: 'Title Placeholder', subtitle: 'Subtitle', body: 'Text Placeholder', heading: 'Text Placeholder', caption: 'Text Placeholder', picture: 'Picture Placeholder' }

/** A master's or layout's placeholder: its place, its look (a master's title and text have theirs in the text styles) and its prompt, or its field. */
function placeholderShape(element: SlideElement, slot: PlaceholderSlot, names: Map<string, number>, onMaster: boolean, deck: Deck, now: Date): XmlElement {
  const spec = specOf(element)!
  const drawn = element.kind === 'text' || element.kind === 'shape' ? element : null
  const body = drawn?.body ?? textBody(spec.style, { anchor: spec.anchor })
  const custom = element.placeholder!.prompt !== PROMPTS[slot.role]
  const geometry = element.kind === 'shape' && !element.paths?.length ? presetGeometryXml(element.shape, element.adjust) : presetGeometryXml('rect')
  const looks = [...(drawn?.fill ? [fillXml(drawn.fill)] : []), ...(drawn?.stroke ? [lineXml(drawn.stroke)] : [])]
  const run = () => xml('a:rPr', { lang: 'en-US' })
  const settings = headerFooterOf(deck)
  const paragraphs = isFooterRole(slot.role)
    ? [xml('a:p', {}, footerRuns(slot.role, slot.role === 'number' ? '‹#›' : slot.role === 'date' ? footerText(deck, 'date', 0, now) : '', run(), settings))]
    : element.placeholder!.prompt.split('\n').map((line) => xml('a:p', {}, line ? [xml('a:r', {}, [run(), xml('a:t', {}, [line])])] : [xml('a:endParaRPr', { lang: 'en-US' })]))
  const inherits = onMaster && (slot.type === 'title' || slot.type === 'body')

  return xml('p:sp', {}, [
    xml('p:nvSpPr', {}, [
      xml('p:cNvPr', { id: '', name: nameOf(element, names, PLACEHOLDER_NAMES[slot.role]) }),
      xml('p:cNvSpPr', {}, [xml('a:spLocks', { noGrp: '1' })]),
      xml('p:nvPr', {}, [placeholderXml(slot, { size: isFooterRole(slot.role) ? FOOTER_SIZES[slot.role] : undefined, customPrompt: custom })])
    ]),
    xml('p:spPr', {}, [transformXml(element), geometry, ...looks]),
    xml('p:txBody', {}, [bodyPropertiesXml(body), inherits ? xml('a:lstStyle') : xml('a:lstStyle', {}, levels(spec.paragraph?.list ? 9 : 1, spec)), ...paragraphs])
  ])
}

const SCHEME: [string, Slot][] = [
  ['a:dk1', 'tx1'],
  ['a:lt1', 'bg1'],
  ['a:dk2', 'tx2'],
  ['a:lt2', 'bg2'],
  ['a:accent1', 'accent1'],
  ['a:accent2', 'accent2'],
  ['a:accent3', 'accent3'],
  ['a:accent4', 'accent4'],
  ['a:accent5', 'accent5'],
  ['a:accent6', 'accent6'],
  ['a:hlink', 'accent1'],
  ['a:folHlink', 'accent5']
]

/** A theme part from PptxGenJS's: the theme's name, colours and fonts in place of Office's. */
export function themeXml(template: string, theme: Theme): string {
  const root = parseXml(template, { canonical: false })
  const parts = child(root, 'a:themeElements')
  const fonts = child(parts, 'a:fontScheme')
  const scheme = xml(
    'a:clrScheme',
    { name: theme.name },
    SCHEME.map(([name, slot]) => xml(name, {}, [xml('a:srgbClr', { val: theme.colors[slot].slice(1).toUpperCase() })]))
  )

  root.attrs.name = theme.name

  if (parts) {
    parts.children = parts.children.map((node) => (typeof node !== 'string' && node.name === 'a:clrScheme' ? scheme : node))
  }

  if (fonts) {
    fonts.attrs.name = theme.name

    for (const [name, family] of [
      ['a:majorFont', theme.fonts.heading],
      ['a:minorFont', theme.fonts.body]
    ]) {
      const latin = find(fonts, `${name}/a:latin`)

      if (latin) {
        latin.attrs = { typeface: family }
      }
    }
  }

  return serializeXml(root)
}

/** Every element below `root`, `root` first. */
function everyElement(root: XmlElement): XmlElement[] {
  const out: XmlElement[] = []
  const stack = [root]

  while (stack.length) {
    const node = stack.pop()!
    out.push(node)
    stack.push(...elements(node))
  }

  return out
}

/** A drawn slide's shape tree and background, the parts they name (pictures) copied in under fresh names and named by `rels`, the relationships of `part`. */
async function drawnPart(drawings: JSZip, types: ContentTypes, index: number, part: string, rels: Relationships, pkg: PackageWriter): Promise<{ tree: XmlElement; background?: XmlElement }> {
  const source = `ppt/slides/slide${index + 1}.xml`
  const text = await drawings.file(source)?.async('string')
  const root = text ? parseXml(text, { canonical: false }) : undefined
  const tree = find(root, 'p:cSld/p:spTree')

  if (!root || !tree) {
    return { tree: xml('p:spTree', {}, [xml('p:nvGrpSpPr', {}, [xml('p:cNvPr', { id: 1, name: '' }), xml('p:cNvGrpSpPr'), xml('p:nvPr')]), xml('p:grpSpPr')]) }
  }

  const from = await Relationships.read(drawings, source)
  const moved = new Map<string, string>()

  for (const node of everyElement(root)) {
    for (const [name, value] of Object.entries(node.attrs)) {
      const relationship = name.startsWith('r:') ? from.get(value) : undefined

      if (!relationship) {
        continue
      }

      let id = moved.get(value)

      if (!id) {
        const at = resolveTarget(source, relationship.target)
        const file = relationship.external ? null : drawings.file(at)

        if (relationship.external) {
          id = rels.add(relationship.type, relationship.target, true)
        } else if (file) {
          const path = freshPart(pkg.zip, `ppt/media/image1.${extensionOf(at)}`)
          pkg.zip.file(path, await file.async('uint8array'))
          pkg.types.ensure(path, types.typeOf(at) ?? EXTENSION_TYPES[extensionOf(at)] ?? 'application/octet-stream')
          id = rels.add(relationship.type, relativeTarget(part, path))
        } else {
          continue
        }

        moved.set(value, id)
      }

      node.attrs[name] = id
    }
  }

  return { tree, background: find(root, 'p:cSld/p:bg') }
}

/** A master's or layout's background: a colour or gradient as Herald writes them, a picture as drawn (cropped to cover), PowerPoint's own for a master without one. */
function backgroundOf(background: Background | null, drawn: XmlElement | undefined, size: SlideSize, onMaster: boolean): XmlElement[] {
  if (!background) {
    return onMaster ? [backgroundXml(null)!] : []
  }

  if (background.kind !== 'image') {
    return [backgroundXml(background)!]
  }

  const rect = find(drawn, 'p:bgPr/a:blipFill/a:srcRect')
  const crop = coverCrop(background.natural, size)

  if (rect && crop) {
    rect.attrs = { l: String(Math.round(crop.left * 100000)), t: String(Math.round(crop.top * 100000)), r: String(Math.round(crop.right * 100000)), b: String(Math.round(crop.bottom * 100000)) }
  }

  return drawn ? [drawn] : []
}

export interface MastersContext {
  deck: Deck
  plans: readonly MasterPlan[]
  /** The package PptxGenJS wrote with a slide for each of `drawingSets(plans)`. */
  drawings: JSZip
  pkg: PackageWriter
  now: Date
}

/**
 * Write the masters, layouts and themes of `plans` into the package in place of PptxGenJS's master
 * and layouts, with the presentation's list of masters and its relationships to them. Masters and
 * layouts are numbered in one series from 2147483648, as PresentationML requires.
 */
export async function writeMasters({ deck, plans, drawings, pkg, now }: MastersContext): Promise<void> {
  const { zip, types } = pkg
  const template = await zip.file('ppt/theme/theme1.xml')!.async('string')
  const drawnTypes = await ContentTypes.read(drawings)
  const masterIds: number[] = []
  let next = 2147483648
  let drawn = 0

  const placeholders = (onMaster: boolean) => (element: SlideElement, slot: PlaceholderSlot | undefined, names: Map<string, number>) =>
    element.placeholder ? (slot ? placeholderShape(element, slot, names, onMaster, deck, now) : null) : undefined

  for (const name of Object.keys(zip.files).filter((entry) => /^ppt\/(slideMasters|slideLayouts)\//.test(entry))) {
    zip.remove(name)
  }

  for (const plan of plans) {
    const rels = Relationships.empty()
    const layoutRels = plan.layouts.map((layout) => rels.add(RELATIONSHIP_TYPES.slideLayout, relativeTarget(plan.part, layout.part)))
    masterIds.push(next++)
    const layoutIds = plan.layouts.map(() => next++)
    rels.add(RELATIONSHIP_TYPES.theme, relativeTarget(plan.part, plan.themePart))
    zip.file(plan.themePart, themeXml(template, plan.theme))
    types.override(plan.themePart, CONTENT_TYPES.theme)

    const master = await drawnPart(drawings, drawnTypes, drawn++, plan.part, rels, pkg)
    finishTree(master.tree, plan.master.elements, { part: plan.part, rels, pkg, slots: masterSlots(plan.master.elements), replace: placeholders(true) })
    zip.file(
      plan.part,
      serializeXml(
        xml('p:sldMaster', NAMESPACES, [
          xml('p:cSld', {}, [...backgroundOf(plan.background, master.background, deck.size, true), master.tree]),
          xml('p:clrMap', COLOR_MAP),
          xml(
            'p:sldLayoutIdLst',
            {},
            layoutIds.map((id, i) => xml('p:sldLayoutId', { id, 'r:id': layoutRels[i] }))
          ),
          headerFooterXml(deck),
          textStylesXml(plan.master, deck.size)
        ])
      )
    )
    rels.write(zip, plan.part)
    types.override(plan.part, CONTENT_TYPES.slideMaster)

    for (const layout of plan.layouts) {
      const own = Relationships.empty()
      own.add(RELATIONSHIP_TYPES.slideMaster, relativeTarget(layout.part, plan.part))
      const drawing = await drawnPart(drawings, drawnTypes, drawn++, layout.part, own, pkg)
      finishTree(drawing.tree, layout.elements, { part: layout.part, rels: own, pkg, slots: layout.slots, replace: placeholders(false) })
      zip.file(
        layout.part,
        serializeXml(
          xml('p:sldLayout', { ...NAMESPACES, showMasterSp: layout.layout.showMaster ? undefined : '0', type: LAYOUT_TYPES[layout.layout.id], preserve: '1' }, [
            xml('p:cSld', { name: layout.layout.name }, [...backgroundOf(layout.layout.background, drawing.background, deck.size, false), drawing.tree]),
            xml('p:clrMapOvr', {}, [xml('a:masterClrMapping')])
          ])
        )
      )
      own.write(zip, layout.part)
      types.override(layout.part, CONTENT_TYPES.slideLayout)
    }
  }

  const presentation = 'ppt/presentation.xml'
  const presentationRels = await Relationships.read(zip, presentation)
  const masterRels = plans.map(
    (plan) =>
      presentationRels.entries.find((entry) => entry.type === RELATIONSHIP_TYPES.slideMaster && resolveTarget(presentation, entry.target) === plan.part)?.id ??
      presentationRels.add(RELATIONSHIP_TYPES.slideMaster, relativeTarget(presentation, plan.part))
  )
  presentationRels.write(zip, presentation)

  const root = parseXml(await zip.file(presentation)!.async('string'), { canonical: false })
  const list = child(root, 'p:sldMasterIdLst')

  if (list) {
    list.children = plans.map((_, m) => xml('p:sldMasterId', { id: masterIds[m], 'r:id': masterRels[m] }))
  }

  zip.file(presentation, serializeXml(root))
}
