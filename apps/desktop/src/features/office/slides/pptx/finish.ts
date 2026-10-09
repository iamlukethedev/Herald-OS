import type JSZip from 'jszip'
import type { Deck, Slide, SlideElement } from '../deck.ts'
import { SLIDE_SIZES } from '../deck.ts'
import { coverCrop } from '../elements.ts'
import { transitionOf } from '../transitions.ts'
import { type PlaceholderSlot, slideSlots } from './placeholders.ts'
import { backgroundXml, transformXml } from './write-drawingml.ts'
import { footerShapes } from './write-footers.ts'
import { type LayoutPlan, type MasterPlan, writeMasters } from './write-masters.ts'
import { ContentTypes, type PackageWriter, RELATIONSHIP_TYPES, relativeTarget, Relationships } from './write-package.ts'
import { writeTransition } from './write-transitions.ts'
import { finishTree, nameOf, placeholderXml, type ShrinkOf } from './write-tree.ts'
import { child, elements, find, parseXml, serializeXml, xml, type XmlElement } from './xml.ts'

export type { ShrinkOf } from './write-tree.ts'

/*
 * What a PowerPoint file needs after PptxGenJS has written it. PptxGenJS writes one master and
 * layout of its own, repeats a paragraph's settings before each of its runs, cannot write
 * gradients, freeforms, crops, adjust values, connectors, groups or a table's cells as PowerPoint
 * has them, numbers tables apart from other shapes, and knows nothing of kept objects, footers or
 * per-slide transitions. So the masters, layouts and themes are written whole from the deck, each
 * slide points at its layout, its shapes are finished from the deck (see write-tree.ts), its date,
 * footer and slide number and its transition go in, and every part gets its content type.
 */

interface SlideContext {
  part: string
  rels: Relationships
  pkg: PackageWriter
  layout: LayoutPlan
  shrink?: ShrinkOf
  now: Date
}

/** An empty picture placeholder: a shape in its place that PowerPoint fills with its layout's prompt. */
function emptyPicture(element: SlideElement, slot: PlaceholderSlot, names: Map<string, number>): XmlElement {
  return xml('p:sp', {}, [
    xml('p:nvSpPr', {}, [xml('p:cNvPr', { id: '', name: nameOf(element, names) }), xml('p:cNvSpPr', {}, [xml('a:spLocks', { noGrp: '1' })]), xml('p:nvPr', {}, [placeholderXml(slot)])]),
    xml('p:spPr', {}, [transformXml(element)])
  ])
}

function finishBackground(cSld: XmlElement, slide: Slide, deck: Deck): void {
  const background = slide.background

  if (background?.kind === 'gradient') {
    const at = cSld.children.findIndex((node) => typeof node !== 'string' && node.name === 'p:bg')
    const replacement = backgroundXml(background)!

    if (at >= 0) {
      cSld.children[at] = replacement
    } else {
      cSld.children.unshift(replacement)
    }
  } else if (background?.kind === 'image') {
    const rect = find(cSld, 'p:bg/p:bgPr/a:blipFill/a:srcRect')
    const crop = coverCrop(background.natural, deck.size)

    if (rect && crop) {
      rect.attrs = { l: String(Math.round(crop.left * 100000)), t: String(Math.round(crop.top * 100000)), r: String(Math.round(crop.right * 100000)), b: String(Math.round(crop.bottom * 100000)) }
    }
  }
}

function finishSlide(root: XmlElement, slide: Slide, index: number, deck: Deck, ctx: SlideContext): void {
  const cSld = child(root, 'p:cSld')
  const tree = child(cSld, 'p:spTree')

  if (!cSld || !tree) {
    return
  }

  if (slide.showMaster === false) {
    root.attrs.showMasterSp = '0'
  }

  finishTree(tree, slide.elements, {
    part: ctx.part,
    rels: ctx.rels,
    pkg: ctx.pkg,
    shrink: ctx.shrink,
    slots: slideSlots(slide, ctx.layout.slots),
    replace: (element, slot, names) => (element.kind === 'image' && !element.src ? (slot ? emptyPicture(element, slot, names) : null) : undefined),
    extra: footerShapes(deck, slide, index, ctx.layout.slots, ctx.now)
  })
  finishBackground(cSld, slide, deck)
  writeTransition(root, transitionOf(deck, slide))
}

/** Speaker notes a paragraph a line (PptxGenJS puts them in one). */
function finishNotes(root: XmlElement, notes: string): void {
  for (const sp of elements(find(root, 'p:cSld/p:spTree')).filter((node) => node.name === 'p:sp')) {
    if (find(sp, 'p:nvSpPr/p:nvPr/p:ph')?.attrs.type !== 'body') {
      continue
    }

    const txBody = child(sp, 'p:txBody')

    if (txBody) {
      const lines = notes.split('\n')
      txBody.children = [
        ...txBody.children.filter((node) => typeof node !== 'string' && (node.name === 'a:bodyPr' || node.name === 'a:lstStyle')),
        ...lines.map((line) => (line ? xml('a:p', {}, [xml('a:r', {}, [xml('a:rPr', { lang: 'en-US', dirty: '0' }), xml('a:t', {}, [line])])]) : xml('a:p', {}, [xml('a:endParaRPr', { lang: 'en-US', dirty: '0' })])))
      ]
    }
  }
}

async function rewrite(zip: JSZip, name: string, change: (root: XmlElement) => void): Promise<void> {
  const file = zip.file(name)

  if (!file) {
    return
  }

  const root = parseXml(await file.async('string'), { canonical: false })
  change(root)
  zip.file(name, serializeXml(root))
}

export interface FinishOptions {
  /** The masters to write (`planMasters`), and the package PptxGenJS wrote with their drawings (`drawingSets`). */
  plans: MasterPlan[]
  drawings: JSZip
  shrink?: ShrinkOf
  /** The day the date fields show. */
  now?: Date
}

/** Finish a PowerPoint file PptxGenJS wrote for `deck`. */
export async function finishPresentation(zip: JSZip, deck: Deck, options: FinishOptions): Promise<void> {
  const pkg: PackageWriter = { zip, types: await ContentTypes.read(zip) }
  const now = options.now ?? new Date()
  await writeMasters({ deck, plans: options.plans, drawings: options.drawings, pkg, now })

  for (const [index, slide] of deck.slides.entries()) {
    const plan = options.plans.find((entry) => entry.slides.includes(index)) ?? options.plans[0]
    const layout = plan.layouts.find((entry) => entry.layout.id === slide.layout) ?? plan.layouts[0]
    const part = `ppt/slides/slide${index + 1}.xml`
    const rels = await Relationships.read(zip, part)

    for (const entry of rels.entries.filter((relationship) => relationship.type === RELATIONSHIP_TYPES.slideLayout)) {
      entry.target = relativeTarget(part, layout.part)
    }

    await rewrite(zip, part, (root) => finishSlide(root, slide, index, deck, { part, rels, pkg, layout, shrink: options.shrink, now }))
    rels.write(zip, part)

    if (slide.notes) {
      await rewrite(zip, `ppt/notesSlides/notesSlide${index + 1}.xml`, (root) => finishNotes(root, slide.notes))
    }
  }

  const app = zip.file('docProps/app.xml')

  if (app) {
    const format = deck.size.width === SLIDE_SIZES.standard.width && deck.size.height === SLIDE_SIZES.standard.height ? 'On-screen Show (4:3)' : deck.size.width / deck.size.height === 16 / 9 ? 'On-screen Show (16:9)' : 'Custom'
    zip.file('docProps/app.xml', (await app.async('string')).replace(/<PresentationFormat>[^<]*<\/PresentationFormat>/, `<PresentationFormat>${format}</PresentationFormat>`))
  }

  pkg.types.write(zip)
}
