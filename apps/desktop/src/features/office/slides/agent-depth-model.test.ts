import { describe, expect, it } from 'vitest'
import { documentFromMarkdown } from '../../../../shared/office/doc-text.ts'
import type { DocJSON, DocNode } from '../../../../shared/office/document.ts'
import { fieldText } from '../../../../shared/office/fields.ts'
import { CELL_TYPE, type CellMatrix, newSheet, newWorkbook, type WorkbookSnapshot } from '../../../../shared/office/workbook.ts'
import { addCommentsChange, type Change, commentItemOf, insertFieldChange, insertNoteChange, insertTocChange } from '../docs/agent-depth-model.ts'
import { jsonOf, stateOf } from '../docs/model.ts'
import {
  addConnectorStep,
  addLogoStep,
  addMasterImageStep,
  addMasterShapeStep,
  addMasterTextStep,
  batchPictures,
  batchWorkbooks,
  cellsOf,
  connectionSitesOf,
  convertToShapesStep,
  DEPTH_STEPS,
  EDIT_OPS,
  editsOf,
  groupStep,
  masterPlaceOf,
  readMaster,
  removeFromMasterStep,
  renameLayoutStep,
  resetMasterStep,
  rotateStep,
  runBatch,
  setBackgroundStep,
  setCellBordersStep,
  setFillStep,
  setHeaderFooterStep,
  setPlaceholderStep,
  setTransitionStep,
  showMasterGraphicsStep,
  themeFromArgs,
  themesList,
  ungroupStep
} from './agent-depth-model.ts'
import { addShapeStep, addTableStep, addTextStep, documentOptionsOf, documentSlidesStep, insertRangeStep, newDeckWith, type Picture, rangeSlidesStep, readDeck, setThemeStep, type SheetSource, SLIDE_EDIT_OPS } from './agent-model.ts'
import type { Deck, LineElement, ObjectElement, ShapeElement, Slide, SlideElement, TableElement, TextElement } from './deck.ts'
import { SlidesDocument } from './document.ts'
import { lineEndsOnSlide, moveElement, shapeElement } from './elements.ts'
import { footersOf } from './footers.ts'
import { backgroundOf, decorationsOf, layoutOf, masterOf, placeholderFor } from './layouts.ts'
import * as model from './model.ts'
import { editTheme, THEMES } from './themes.ts'
import { plainText } from './text.ts'

const none = { front: null }

const pictures: ReadonlyMap<string, Picture> = new Map([['~/logo.png', { src: 'data:image/png;base64,iVBORw0KGgo=', natural: { width: 200, height: 100 } }]])

const textOf = (element: SlideElement | undefined): string => (element && (element.kind === 'text' || element.kind === 'shape') ? plainText(element.body) : '')
const titles = (deck: Deck) => deck.slides.map((slide) => model.slideTitle(slide))
const layouts = (deck: Deck) => deck.slides.map((slide) => slide.layout)
const bullets = (slide: Slide) => (placeholderFor(slide, 'body') as TextElement).body.paragraphs.map((paragraph) => [paragraph.runs.map((run) => run.text).join(''), paragraph.level ?? 0])
const elementOn = (deck: Deck, slide: number, id: unknown) => deck.slides[slide - 1].elements.find((element) => element.id === id)!

/** A title slide and two slides of bullets: Pitch, Plan and Team. */
const pitch = (): Deck => newDeckWith('Pitch', { slides: [{ title: 'Pitch', body: 'Seed round' }, { title: 'Plan', body: 'Research\nBuild' }, { title: 'Team', body: 'Ana\nBen' }] })

/** A slide of its own with two squares side by side, 100 points each, at x 100 and 400 (or `gap` apart). */
function squares(gap = 300) {
  const first = addShapeStep(model.newDeck('Flow'), { slide: 1, kind: 'rect', x: 100, y: 100, width: 100, height: 100 }, none)
  const second = addShapeStep(first.deck, { slide: 1, kind: 'ellipse', x: 100 + gap, y: 100, width: 100, height: 100 }, none)

  return { deck: second.deck, a: String(first.info?.element), b: String(second.info?.element) }
}

/** A brand theme the person made from Ocean. */
const brand = { ...editTheme(THEMES[7], { name: 'Brand', colors: { accent1: '#ff0066' } }), id: 'custom-brand' }

describe('the slide master and its layouts', () => {
  it('reads the master’s placeholders and elements, and each layout with the slides on it', () => {
    const read = readMaster(pitch())

    expect(read.master.background).toBe('the theme’s background colour')
    expect(read.master.placeholders.map((placeholder) => placeholder.role)).toEqual(['title', 'body', 'date', 'footer', 'number'])
    expect(read.master.placeholders[0]).toMatchObject({ box: [60, 36, 840, 84], font: 'heading (Avenir Next)', size: 40, color: 'text', align: 'left', anchor: 'middle' })
    expect(read.master.elements).toEqual([])
    expect(read.layouts.map((layout) => [layout.id, layout.name, layout.slides])).toEqual([
      ['title', 'Title', [1]],
      ['title-content', 'Title and Content', [2, 3]],
      ['two-content', 'Two Content', []],
      ['section', 'Section Header', []],
      ['title-only', 'Title Only', []],
      ['blank', 'Blank', []],
      ['picture-caption', 'Picture with Caption', []],
      ['comparison', 'Comparison', []]
    ])
    expect(read.layouts[0]).toMatchObject({ background: 'the master’s', showsMasterGraphics: true, elements: [] })
    expect(read.layouts[0].placeholders.map((placeholder) => placeholder.role)).toEqual(['title', 'subtitle'])
    expect(readMaster(pitch(), 'two-content').layouts.map((layout) => layout.id)).toEqual(['two-content'])
    expect(readMaster(pitch(), 'master').layouts).toEqual([])
    expect(read.headerFooter).toBeUndefined()
  })

  it('names the master and its layouts by id, Herald’s name or the deck’s own', () => {
    const deck = renameLayoutStep(pitch(), { layout: 'title-content', name: 'Bullets' }).deck

    expect(['', 'master', 'Slide Master', 'two columns', 'Section Header', 'bullets'].map((value) => masterPlaceOf(deck, value))).toEqual(['master', 'master', 'master', 'two-content', 'section', 'title-content'])
    expect(() => masterPlaceOf(deck, 'mosaic')).toThrow('layout is master (the slide master) or one of its layouts: title, title-content')
  })

  it('puts text, a shape and a picture on the master or a layout, behind the slides that show it', () => {
    const deck = pitch()
    const text = addMasterTextStep(deck, { text: 'Confidential', x: 40, y: 500, size: 12 }, none)
    const band = addMasterShapeStep(deck, { layout: 'title', kind: 'rect', x: 0, y: 0, width: 960, height: 40, gradient: 'accent1 to accent2' }, none)
    const picture = addMasterImageStep(deck, { layout: 'picture-caption', source: '~/logo.png' }, { front: null, pictures })
    const shape = layoutOf(masterOf(band.deck), 'title').elements.find((element) => element.kind === 'shape') as ShapeElement

    expect([text.label, text.done, text.focus]).toEqual(['Add to Master', 'added a text box to the slide master', undefined])
    expect(readMaster(text.deck).master.elements).toEqual([{ number: 1, id: text.info?.element, kind: 'Text box', text: 'Confidential', box: [40, 500, 480, 24] }])
    expect(decorationsOf(text.deck, 'title-content').map((element) => element.id)).toEqual([text.info?.element])
    expect(text.deck.slides).toBe(deck.slides)
    expect([band.label, band.done]).toEqual(['Add to Layout', 'added a rectangle to the Title layout'])
    expect(shape.fill?.gradient?.stops.map((stop) => stop.color)).toEqual(['accent1', 'accent2'])
    expect(decorationsOf(band.deck, 'title').map((element) => element.id)).toEqual([shape.id])
    expect(decorationsOf(band.deck, 'title-content')).toEqual([])
    // Without a place, a picture on a layout leaves its picture placeholder empty and goes in the middle at its own proportions.
    expect(readMaster(picture.deck, 'picture-caption').layouts[0]).toMatchObject({ placeholders: [{ role: 'title' }, { role: 'picture' }, { role: 'caption' }], elements: [{ number: 1, kind: 'Picture', box: [380, 220, 200, 100] }] })
    expect(picture.done).toBe('added a picture to the Picture with Caption layout')
    expect(() => addMasterTextStep(deck, { text: ' ' }, none)).toThrow('Say what the text box says')
  })

  it('puts a logo in a corner of every slide, clear of the footer, and takes elements off by id or number', () => {
    const deck = pitch()
    const logo = addLogoStep(deck, { source: '~/logo.png', corner: 'bottom right' }, { front: null, pictures })
    const text = addMasterTextStep(logo.deck, { text: 'Draft' }, none)
    const read = readMaster(text.deck)

    expect(logo.done).toBe('put the logo in the bottom right corner of every slide that shows the master’s graphics')
    expect(read.master.elements.map((element) => [element.number, element.kind, element.box])).toEqual([
      [1, 'Picture', [840, 442, 96, 48]],
      [2, 'Text box', [240, 252, 480, 37]]
    ])
    expect(addLogoStep(deck, { source: '~/logo.png', layout: 'section' }, { front: null, pictures }).done).toBe('put the logo in the top right corner of the slides of the Section Header layout')
    expect(readMaster(removeFromMasterStep(text.deck, { elements: '2' }).deck).master.elements.map((element) => element.kind)).toEqual(['Picture'])
    expect(readMaster(removeFromMasterStep(text.deck, { elements: [logo.info?.element] }).deck).master.elements.map((element) => element.kind)).toEqual(['Text box'])
    expect(removeFromMasterStep(text.deck, { elements: '1, 2' }).done).toBe('removed 2 elements from the slide master and its layouts')
    expect(() => removeFromMasterStep(deck, { elements: '3' })).toThrow('the slide master has no element “3”, and no elements of its own')
    expect(() => removeFromMasterStep(text.deck, { elements: 'logo' })).toThrow(/has no element “logo”: its elements are 1\. Picture/)
    expect(() => addLogoStep(deck, { source: '~/logo.png', corner: 'middle' }, { front: null, pictures })).toThrow('corner is top-left, top-right (the default), bottom-left or bottom-right')
    expect(() => addLogoStep(deck, { source: '~/other.png' }, { front: null, pictures })).toThrow('The picture ~/other.png was not read')
  })

  it('moves and restyles a placeholder, the layouts and slides that looked as it did following', () => {
    const deck = pitch()
    const moved = setPlaceholderStep(deck, { role: 'title', y: 20, size: 36, color: 'accent1', bold: true })
    const title = (elements: readonly SlideElement[]) => elements.find((element) => element.placeholder?.role === 'title') as TextElement
    const master = masterOf(moved.deck)
    const slideTitle = placeholderFor(moved.deck.slides[1], 'title') as TextElement

    expect(moved.done).toBe('changed the place and text of the slide master’s title placeholder')
    expect([title(master.elements).y, title(master.elements).body.style]).toEqual([20, { font: '+heading', size: 36, color: 'accent1', bold: true }])
    expect([title(layoutOf(master, 'title-content').elements).y, title(layoutOf(master, 'title-content').elements).body.style.size]).toEqual([20, 36])
    expect([slideTitle.y, slideTitle.body.style.size, plainText(slideTitle.body)]).toEqual([20, 36, 'Plan'])
    // The Title layout's title sat and was sized its own way, so it keeps its place and size.
    expect([title(layoutOf(master, 'title').elements).y, title(layoutOf(master, 'title').elements).body.style.size]).toEqual([150, 54])
    expect(layoutOf(masterOf(setPlaceholderStep(deck, { layout: 'two-content', role: 'text', which: 2, width: 300 }).deck), 'two-content').elements.filter((element) => element.placeholder?.role === 'body').map((element) => element.width)).toEqual([408, 300])
    expect(setPlaceholderStep(moved.deck, { role: 'title', y: 20 }).done).toBe('the slide master’s title placeholder already looks that way')
    expect(() => setPlaceholderStep(deck, { role: 'logo' })).toThrow('role is the placeholder: title, subtitle, body (the text)')
    expect(() => setPlaceholderStep(deck, { layout: 'two-content', role: 'body', which: 3, x: 0 })).toThrow('the Two Content layout has no text placeholder 3: it has title, text')
    expect(() => setPlaceholderStep(deck, { role: 'title' })).toThrow('Say what to change')
  })

  it('shows or hides the master’s graphics on a layout’s slides or on chosen slides, and renames layouts', () => {
    const deck = pitch()
    const hidden = showMasterGraphicsStep(deck, { show: false, slide: '2, 3' }, none)
    const section = showMasterGraphicsStep(deck, { show: 'false', layout: 'section' }, none)
    const renamed = renameLayoutStep(deck, { layout: 'title-content', name: 'Bullets' })

    expect(hidden.deck.slides.map((slide) => slide.showMaster)).toEqual([undefined, false, false])
    expect(hidden.done).toBe('hid the master’s graphics on slides 2 and 3')
    expect(showMasterGraphicsStep(hidden.deck, { show: false, slide: 2 }, none)).toMatchObject({ deck: hidden.deck, done: 'slide 2 (“Plan”) already hides the master’s graphics' })
    expect(showMasterGraphicsStep(hidden.deck, { show: true }, { front: hidden.deck.slides[2].id }).deck.slides.map((slide) => slide.showMaster)).toEqual([undefined, false, undefined])
    expect(layoutOf(masterOf(section.deck), 'section').showMaster).toBe(false)
    expect(section.done).toBe('hid the master’s graphics on the Section Header layout’s slides')
    expect([layoutOf(masterOf(renamed.deck), 'title-content').name, renamed.done]).toEqual(['Bullets', 'named the Title and Content layout “Bullets”'])
    expect(layoutOf(masterOf(renameLayoutStep(renamed.deck, { layout: 'Bullets', name: 'default' }).deck), 'title-content').name).toBe('Title and Content')
    expect(() => showMasterGraphicsStep(deck, { slide: 2 }, none)).toThrow('Say whether the master’s graphics show')
    expect(() => showMasterGraphicsStep(deck, { show: false, layout: 'master' }, none)).toThrow(/not on the master itself/)
    expect(() => renameLayoutStep(deck, { name: 'Big' })).toThrow('Say which layout to rename')
  })

  it('puts Herald’s own master back', () => {
    const deck = addLogoStep(pitch(), { source: '~/logo.png' }, { front: null, pictures }).deck
    const reset = resetMasterStep(deck)

    expect(reset.deck.master).toBeUndefined()
    expect(readMaster(reset.deck).master.elements).toEqual([])
    expect(reset.done).toMatch(/^put Herald’s own master and layouts back/)
    expect(resetMasterStep(pitch()).done).toBe('it already has Herald’s own master')
  })

  it('sets the date, slide number and footer every slide shows, title slides left without them', () => {
    const deck = pitch()
    const shown = setHeaderFooterStep(deck, { number: true, footer: 'Acme · Confidential', skipTitle: true })

    expect(shown.deck.headerFooter).toEqual({ date: false, dateFormat: 'datetime1', number: true, footer: true, footerText: 'Acme · Confidential', skipTitle: true })
    expect(shown.done).toBe('slides now show the slide number and the footer “Acme · Confidential”, but not on title slides')
    expect(footersOf(shown.deck, shown.deck.slides[1], 1).map((footer) => [footer.role, footer.text])).toEqual([
      ['footer', 'Acme · Confidential'],
      ['number', '2']
    ])
    expect(footersOf(shown.deck, shown.deck.slides[0], 0)).toEqual([])
    expect(readHeaderFooterOf(setHeaderFooterStep(deck, { dateFormat: 'dmy' }).deck)).toEqual({ date: { format: 'dmy' } })
    expect(readHeaderFooterOf(setHeaderFooterStep(deck, { dateText: 'Q3 2026', number: 'yes' }).deck)).toEqual({ date: { text: 'Q3 2026' }, slideNumber: true })
    expect(setHeaderFooterStep(shown.deck, { footer: 'none' }).deck.headerFooter).toMatchObject({ footer: false, number: true })
    expect(setHeaderFooterStep(shown.deck, { number: true }).done).toBe('slides already show the slide number and the footer “Acme · Confidential”, but not on title slides')
    expect(() => setHeaderFooterStep(deck, {})).toThrow('Say what slides show')
    expect(() => setHeaderFooterStep(deck, { dateFormat: 'roman' })).toThrow('dateFormat is numeric (10/9/2026, the default), long')
    expect(() => setHeaderFooterStep(deck, { footer: 'on' })).toThrow('Say what the footer says')
  })
})

/** The header and footer as slides.read gives them. */
const readHeaderFooterOf = (deck: Deck) => readDeck(deck).headerFooter

describe('backgrounds and fills', () => {
  it('gives slides, a layout or the master a colour, a gradient, a picture or none', () => {
    const deck = pitch()
    const slides = setBackgroundStep(deck, { slide: '2-3', background: 'navy' }, none)
    const master = setBackgroundStep(deck, { layout: 'master', gradient: 'background2 to background', angle: 45 }, none)
    const section = setBackgroundStep(deck, { layout: 'section', source: '~/logo.png' }, { front: null, pictures })
    const cleared = setBackgroundStep(slides.deck, { slide: 2, background: 'none' }, none)

    expect(slides.deck.slides.map((slide) => slide.background)).toEqual([null, { kind: 'solid', color: '#000080' }, { kind: 'solid', color: '#000080' }])
    expect(slides.done).toBe('gave slides 2 and 3 the background #000080')
    expect(masterOf(master.deck).background).toEqual({ kind: 'gradient', stops: [{ at: 0, color: 'bg2' }, { at: 1, color: 'bg1' }], angle: 45 })
    expect(master.done).toBe('gave the slide master the background gradient background2 to background, 45°')
    expect(backgroundOf(master.deck, master.deck.slides[1])).toEqual(masterOf(master.deck).background)
    expect(layoutOf(masterOf(section.deck), 'section').background).toEqual({ kind: 'image', src: 'data:image/png;base64,iVBORw0KGgo=', natural: { width: 200, height: 100 } })
    expect([cleared.deck.slides[1].background, cleared.done]).toEqual([null, 'gave slide 2 (“Plan”) no background of its own'])
    expect(setBackgroundStep(slides.deck, { slide: 2, background: 'navy' }, none).deck).toBe(slides.deck)
    expect(() => setBackgroundStep(deck, {}, none)).toThrow('Say what the background is')
    expect(() => setBackgroundStep(deck, { gradient: 'navy' }, none)).toThrow('gradient is two or more colours from first to last')
  })

  it('fills shapes and text boxes with a colour, a gradient or nothing', () => {
    const { deck, a } = squares()
    const text = addTextStep(deck, { slide: 1, text: 'Note', x: 600, y: 300 }, none)
    const both = setFillStep(text.deck, { elements: [a, text.info?.element], gradient: 'navy, teal 60%, white', angle: 0 }, none)
    const gradient = { stops: [{ at: 0, color: '#000080' }, { at: 0.6, color: '#008080' }, { at: 1, color: '#ffffff' }], angle: 0 }
    const picture = model.addImage(deck, deck.slides[0].id, { src: 'data:image/png;base64,iVBORw0KGgo=', natural: { width: 10, height: 10 }, x: 0, y: 0 })

    expect([elementOn(both.deck, 1, a), elementOn(both.deck, 1, text.info?.element)].map((element) => (element as ShapeElement).fill)).toEqual([
      { color: '#000080', gradient },
      { color: '#000080', gradient }
    ])
    expect(both.done).toBe('filled 2 elements on slide 1 with a gradient of #000080 to #008080 to #ffffff')
    expect((elementOn(setFillStep(deck, { elements: a, fill: 'none' }, none).deck, 1, a) as ShapeElement).fill).toBeNull()
    expect((elementOn(setFillStep(deck, { elements: a, gradient: 'accent1 to accent2', radial: true }, none).deck, 1, a) as ShapeElement).fill?.gradient).toEqual({ stops: [{ at: 0, color: 'accent1' }, { at: 1, color: 'accent2' }], angle: 90, radial: true })
    expect(() => setFillStep(picture.deck, { elements: picture.elementId, fill: 'red' }, none)).toThrow(`Picture ${picture.elementId} takes no fill: shapes and text boxes do`)
    expect(() => setFillStep(deck, { elements: a }, none)).toThrow('Say what fills them')
  })

  it('gives a new shape a gradient fill', () => {
    const step = addShapeStep(model.newDeck('T'), { kind: 'cylinder', gradient: 'accent1 to accent3', angle: 180 }, none)
    const shape = elementOn(step.deck, 1, step.info?.element) as ShapeElement

    expect([shape.shape, shape.fill]).toEqual(['can', { color: 'accent1', gradient: { stops: [{ at: 0, color: 'accent1' }, { at: 1, color: 'accent3' }], angle: 180 } }])
  })
})

describe('themes', () => {
  it('applies a theme to the whole deck or to chosen slides, the person’s own themes too', () => {
    const deck = pitch()
    const some = setThemeStep(deck, { theme: 'midnight', slide: '2, 3' }, none)
    const custom = { front: null, themes: [brand] }

    expect([some.deck.theme.id, ...some.deck.slides.map((slide) => slide.theme?.id)]).toEqual(['herald', undefined, 'midnight', 'midnight'])
    expect(some.done).toBe('gave slides 2 and 3 the Midnight theme')
    expect(readDeck(some.deck).slides.map((slide) => ('theme' in slide ? slide.theme : null))).toEqual([null, 'Midnight', 'Midnight'])
    expect(setThemeStep(deck, { theme: 'midnight', slide: 'all' }, none).deck.theme.id).toBe('midnight')
    expect(setThemeStep(deck, { theme: 'Brand' }, custom).deck.theme).toBe(brand)
    expect(setThemeStep(deck, { theme: 'custom-brand' }, custom).deck.theme).toBe(brand)
    expect(() => setThemeStep(deck, { theme: 'neon' }, custom)).toThrow('theme is one of herald, midnight, paper, graphite, forest, coral, mono, ocean, aurora, dune, slate, blossom, ember or a custom theme (Brand: custom-brand), not “neon”')
  })

  it('makes a custom theme from another with colours and fonts changed, under a name of its own', () => {
    const made = themeFromArgs({ name: 'Harbour', colors: '{"accent1": "#ff0066", "background": "navy", "text2": "accent2"}', headingFont: 'Georgia', gradient: 'background2 to background' }, THEMES[7], THEMES)

    expect([made.id, made.name, made.colors.accent1, made.colors.bg1, made.colors.tx2, made.colors.accent3]).toEqual(['ocean', 'Harbour', '#ff0066', '#000080', THEMES[7].colors.accent2, THEMES[7].colors.accent3])
    expect(made.fonts).toEqual({ heading: 'Georgia', body: 'Trebuchet MS' })
    expect(made.background).toEqual({ kind: 'gradient', stops: [{ at: 0, color: 'bg2' }, { at: 1, color: 'bg1' }], angle: 90 })
    expect(themeFromArgs({ name: 'Calm', colors: 'accent1 #123456, text navy' }, THEMES[0], THEMES).colors).toMatchObject({ accent1: '#123456', tx1: '#000080' })
    expect(themeFromArgs({ name: 'Flat', background: 'none' }, THEMES[8], THEMES).background).toBeUndefined()
    expect(() => themeFromArgs({ name: 'ocean' }, THEMES[0], THEMES)).toThrow('There is already a theme called Ocean (ocean): give the new one another name')
    expect(() => themeFromArgs({ name: 'Brand' }, THEMES[0], [...THEMES, brand])).toThrow('There is already a theme called Brand (custom-brand): give the new one another name, or delete that one first (slides.deleteTheme)')
    expect(() => themeFromArgs({}, THEMES[0], THEMES)).toThrow('Say what the new theme is called')
    expect(() => themeFromArgs({ name: 'Odd', colors: '{"border": "red"}' }, THEMES[0], THEMES)).toThrow('colors names theme colours: background, text, background2, text2 and accent1 to accent6; not “border”')
    expect(() => themeFromArgs({ name: 'Odd', background: 'navy' }, THEMES[0], THEMES)).toThrow('A theme’s background colour is one of its colours')
  })

  it('lists Herald’s themes and the person’s', () => {
    const listed = themesList([brand])

    expect(listed.themes.map((theme) => theme.id)).toEqual(THEMES.map((theme) => theme.id))
    expect(listed.themes.find((theme) => theme.id === 'aurora')?.background).toBe('gradient background2 to background, radial')
    expect(listed.custom).toEqual([{ id: 'custom-brand', name: 'Brand', fonts: THEMES[7].fonts, colors: expect.objectContaining({ accent1: '#ff0066', background: THEMES[7].colors.bg1 }) }])
  })
})

describe('transitions', () => {
  it('gives a slide, several or every slide a transition of a kind, direction and duration', () => {
    const deck = pitch()
    const one = setTransitionStep(deck, { kind: 'push', direction: 'from the right', duration: 1.5 }, { front: deck.slides[1].id })
    const split = setTransitionStep(deck, { kind: 'Split', direction: 'in', orientation: 'vertical', slide: '2-3' }, none)
    const all = setTransitionStep(deck, { kind: 'zoom', slide: 'all' }, none)

    expect(one.deck.slides.map((slide) => slide.transition)).toEqual([undefined, { kind: 'push', duration: 1500, direction: 'left' }, undefined])
    expect(one.done).toBe('gave slide 2 (“Plan”) the Push transition (left), 1.5 s')
    expect(readDeck(one.deck).slides.map((slide) => ('transition' in slide ? slide.transition : null))).toEqual([null, { kind: 'push', direction: 'left', seconds: 1.5 }, null])
    expect(split.deck.slides.slice(1).map((slide) => slide.transition)).toEqual(Array.from({ length: 2 }, () => ({ kind: 'split', duration: 500, direction: 'in', orientation: 'vertical' })))
    expect([all.deck.transition, all.deck.slides.every((slide) => slide.transition?.kind === 'zoom'), all.done]).toEqual(['zoom', true, 'gave every slide the Zoom transition (in), 0.5 s'])
    expect(setTransitionStep(one.deck, { kind: 'push', direction: 'left', duration: 1.5, slide: 2 }, none).deck).toBe(one.deck)
    expect(() => setTransitionStep(deck, { kind: 'spin' }, none)).toThrow('kind is a transition: none, fade, push, wipe, cover, uncover, split, zoom; not “spin”')
    expect(() => setTransitionStep(deck, { kind: 'fade', direction: 'up' }, none)).toThrow('Fade goes no way in particular: leave direction out')
    expect(() => setTransitionStep(deck, { kind: 'push', direction: 'in' }, none)).toThrow('Push goes up, left, down, right; not “in”')
    expect(() => setTransitionStep(deck, { kind: 'wipe', orientation: 'vertical' }, none)).toThrow('orientation is for split: horizontal or vertical')
  })
})

describe('groups', () => {
  it('groups elements, turns a group as one about its middle, and ungroups it', () => {
    const { deck, a, b } = squares()
    const grouped = groupStep(deck, { elements: [a, b] }, none)
    const group = String(grouped.info?.group)
    const turned = rotateStep(grouped.deck, { elements: a, degrees: 90 }, none)

    expect(grouped.done).toBe('grouped 2 elements on slide 1')
    expect([a, b].map((id) => elementOn(grouped.deck, 1, id).group)).toEqual([[group], [group]])
    expect(readDeck(grouped.deck).slides[0].elements.filter((element) => 'group' in element).map((element) => element.group)).toEqual([group, group])
    expect([a, b].map((id) => elementOn(turned.deck, 1, id)).map((element) => [Math.round(element.x), Math.round(element.y), element.rotation])).toEqual([
      [250, -50, 90],
      [250, 250, 90]
    ])
    expect(turned.done).toBe('turned 2 elements on slide 1 90° clockwise')
    expect(rotateStep(deck, { elements: '3', degrees: -45 }, none).done).toBe('turned 1 element on slide 1 45° anticlockwise')
    expect([a, b].map((id) => elementOn(ungroupStep(grouped.deck, { elements: group }, none).deck, 1, id).group)).toEqual([undefined, undefined])
    expect(ungroupStep(deck, { elements: a }, none)).toMatchObject({ deck, done: 'none of them is in a group' })
    expect(() => groupStep(deck, { elements: a }, none)).toThrow('A group takes two or more elements or groups')
    expect(() => groupStep(deck, { elements: [a, 'nope'] }, none)).toThrow(/There is no element “nope” on that slide: its elements are 1\. Title \(text-/)
    expect(() => rotateStep(deck, { elements: a }, none)).toThrow('Say how far to turn them')
  })

  it('turns SmartArt into a group of shapes that can be edited', () => {
    const smart: ObjectElement = {
      id: 'object-1',
      kind: 'object',
      object: 'diagram',
      x: 100,
      y: 100,
      width: 400,
      height: 200,
      rotation: 0,
      source: { xml: '', parts: [] },
      shapes: [shapeElement('rect', { x: 0, y: 0, width: 100, height: 50 }), shapeElement('ellipse', { x: 100, y: 50, width: 100, height: 50 })],
      drawnIn: { width: 200, height: 100 }
    }
    const deck = model.newDeck('T')
    const withSmart = { ...deck, slides: [{ ...deck.slides[0], elements: [...deck.slides[0].elements, smart] }] }
    const step = convertToShapesStep(withSmart, {}, none)
    const shapes = step.deck.slides[0].elements.filter((element) => element.kind === 'shape')

    expect(shapes.map((shape) => [shape.x, shape.y, shape.width, shape.height])).toEqual([
      [100, 100, 200, 100],
      [300, 200, 200, 100]
    ])
    expect(new Set(shapes.map((shape) => shape.group?.[0])).size).toBe(1)
    expect(step.done).toBe('turned 1 object on slide 1 into 2 shapes')
    expect(() => convertToShapesStep(pitch(), {}, none)).toThrow('slide 1 (“Pitch”) has no SmartArt to turn into shapes')
  })
})

describe('connectors', () => {
  it('connects two elements at the sites nearest each other, or those asked for, and follows them', () => {
    const { deck, a, b } = squares()
    const joined = addConnectorStep(deck, { from: a, to: b }, none)
    const line = elementOn(joined.deck, 1, joined.info?.element)
    const bent = addConnectorStep(deck, { from: '3', to: '4', fromSite: 2, toSite: 4, kind: 'elbow', arrow: 'both', color: 'accent2', width: 3, dash: 'dashed' }, none)
    const elbow = elementOn(bent.deck, 1, bent.info?.element)
    const moved = model.updateElements(joined.deck, joined.deck.slides[0].id, [b], (element) => moveElement(element, 0, 100), 'Move').deck

    expect(joined.info).toMatchObject({ from: a, fromSite: 3, to: b, toSite: 2 })
    expect(line.kind === 'line' && [line.connector, line.start, line.end, line.stroke]).toEqual([{ preset: 'straightConnector1', start: { element: a, site: 3 }, end: { element: b, site: 2 } }, 'none', 'triangle', { color: 'tx1', width: 2, dash: 'solid' }])
    expect(joined.done).toBe('connected the shape to the shape on slide 1 with a straight connector')
    expect(readDeck(joined.deck).slides[0].elements.at(-1)).toMatchObject({ kind: 'Connector', connector: { kind: 'straight', from: a, fromSite: 3, to: b, toSite: 2 } })
    expect(elbow.kind === 'line' && [elbow.connector?.preset, elbow.connector?.start?.site, elbow.connector?.end?.site, elbow.start, elbow.end, elbow.stroke]).toEqual(['bentConnector3', 2, 4, 'triangle', 'triangle', { color: 'accent2', width: 3, dash: 'dash' }])
    expect(bent.done).toBe('connected the shape to the shape on slide 1 with an elbow connector')
    // The connector's glued end follows the element it is glued to.
    expect(lineEndsOnSlide(elementOn(moved, 1, joined.info?.element) as LineElement).to).toEqual(model.connectionSites(elementOn(moved, 1, b))[2])
    expect(() => addConnectorStep(deck, { from: a, to: b, fromSite: 9 }, none)).toThrow(`Shape ${a} has connection sites 0 to 3 (slides.connectionSites lists them)`)
    expect(() => addConnectorStep(deck, { from: a, to: a }, none)).toThrow('A connector runs from one element (from) to another (to)')
    expect(() => addConnectorStep(deck, { from: a, to: b, kind: 'zigzag' }, none)).toThrow('kind is straight (the default), elbow or curved, not “zigzag”')
    expect(() => addConnectorStep(deck, { from: a, to: b, arrow: 'left' }, none)).toThrow('arrow is end (the default), start, both or none, not “left”')
  })

  it('lists an element’s connection sites, where each is and which way it faces', () => {
    const { deck, a, b } = squares()

    expect(connectionSitesOf(deck, { element: a }, none)).toEqual({
      slide: 1,
      element: a,
      kind: 'Shape',
      sites: [
        { site: 0, x: 150, y: 100, facing: 'up' },
        { site: 1, x: 100, y: 150, facing: 'left' },
        { site: 2, x: 150, y: 200, facing: 'down' },
        { site: 3, x: 200, y: 150, facing: 'right' }
      ]
    })
    expect(connectionSitesOf(deck, { element: b }, none).sites).toHaveLength(8)
  })
})

describe('table borders', () => {
  const costs = () => {
    const slide = model.addSlide(model.newDeck('T'), { title: 'Costs' })
    const step = addTableStep(slide.deck, { slide: 2, cells: '[["A", "B", "C"], ["1", "2", "3"], ["4", "5", "6"]]' }, none)

    return { deck: step.deck, table: String(step.info?.element) }
  }
  const tableOn = (deck: Deck, id: string) => elementOn(deck, 2, id) as TableElement

  it('draws lines on some sides of some cells, or of all of them, or takes them off', () => {
    const { deck, table } = costs()
    const pen = { color: 'accent2', width: 2, dash: 'solid' }
    const outer = setCellBordersStep(deck, { slide: 2, range: 'A1:B2', sides: 'outer', color: 'accent2', width: 2 }, none)
    const cells = tableOn(outer.deck, table).cells

    expect([cells[0][0].borders, cells[0][1].borders, cells[1][0].borders, cells[1][1].borders]).toEqual([
      { left: pen, top: pen },
      { top: pen, right: pen },
      { left: pen, bottom: pen },
      { right: pen, bottom: pen }
    ])
    expect(cells[2][2].borders).toBeUndefined()
    expect(outer.done).toBe('drew 2-point accent2 borders (outer) on cells A1:B2 of the table on slide 2 (“Costs”)')
    expect(tableOn(setCellBordersStep(deck, { slide: 2, element: table, range: 'row 1', sides: 'bottom' }, none).deck, table).cells[0].map((cell) => cell.borders?.bottom)).toEqual(Array.from({ length: 3 }, () => ({ color: 'tx1', width: 1, dash: 'solid' })))
    expect(tableOn(setCellBordersStep(outer.deck, { slide: 2, sides: 'none' }, none).deck, table).cells[0][0].borders).toEqual({ left: null, top: null, right: null, bottom: null })
    expect(() => setCellBordersStep(deck, { slide: 2, range: 'Z9' }, none)).toThrow('The table has 3 rows and 3 columns (A1 to C3); Z9 is outside it')
    expect(() => setCellBordersStep(deck, { slide: 2, sides: 'diagonal' }, none)).toThrow('sides is all (the default), outer, inner, top, bottom, left, right or none, or several of them; not “diagonal”')
    expect(() => setCellBordersStep(deck, { slide: 2, element: '1' }, none)).toThrow(/^Title text-\S+ is not a table$/)
    expect(() => setCellBordersStep(deck, { slide: 1 }, none)).toThrow('That slide has no table')
  })

  it('reads cells as a sheet names them, or by row or column', () => {
    const { deck, table: id } = costs()
    const table = tableOn(deck, id)

    expect(cellsOf('', table)).toBe('all')
    expect(cellsOf('b2', table)).toEqual([{ row: 1, column: 1 }])
    expect(cellsOf('column 2', table)).toEqual([0, 1, 2].map((row) => ({ row, column: 1 })))
    expect(cellsOf('rows 2-3', table)).toHaveLength(6)
    expect(cellsOf('B:C', table)).toHaveLength(6)
    expect(cellsOf('columns a-b', table)).toHaveLength(6)
    expect(() => cellsOf('diagonal', table)).toThrow("range is the table's cells: A1:C3 or B2")
    expect(() => cellsOf('row a', table)).toThrow("range is the table's cells")
  })
})

/** A header row over `count` rows of a region and its units. */
function salesBook(count: number): WorkbookSnapshot {
  const cellData: CellMatrix = { 0: { 0: { v: 'Region', t: CELL_TYPE.string }, 1: { v: 'Units', t: CELL_TYPE.string } } }

  for (let row = 1; row <= count; row++) {
    cellData[row] = { 0: { v: `Region ${row}`, t: CELL_TYPE.string }, 1: { v: row * 100, t: CELL_TYPE.number } }
  }

  return newWorkbook('book', 'Book', [newSheet('s1', 'Sales', cellData)])
}

describe('tables and slides from a sheet', () => {
  const source: SheetSource = { name: 'Sales.xlsx', workbook: salesBook(3), selection: { sheet: 'Sales', range: 'A1:B2' } }
  const sheets = new Map([
    ['Sales.xlsx', source],
    ['', source]
  ])
  const texts = (table: SlideElement | undefined) => (table?.kind === 'table' ? table.cells.map((row) => row.map((cell) => plainText(cell.body))) : [])
  const deck = newDeckWith('Review', { slides: [{ title: 'Review' }, { title: 'Costs', layout: 'title-content' }] })

  it('puts a range on a slide in place of its empty text placeholder, or in the box x, y and width give', () => {
    const put = insertRangeStep(deck, { slide: 'Costs', workbook: 'Sales.xlsx' }, { front: null, sheets })
    const boxed = insertRangeStep(deck, { slide: 2, workbook: 'Sales.xlsx', range: 'A1:B3', x: 100, y: 200, width: 400 }, { front: null, sheets })
    const table = elementOn(put.deck, 2, put.info?.element)

    expect(put.done).toBe('put A1:B4 of Sales.xlsx (4 rows) on slide 2 as a table')
    expect(put.info).toEqual({ slide: 2, element: table.id, from: { workbook: 'Sales.xlsx', sheet: 'Sales', range: 'A1:B4' } })
    expect([table.x, table.y, Math.round(table.width)]).toEqual([60, 136, 840])
    expect(placeholderFor(put.deck.slides[1], 'body')).toBeUndefined()
    expect(texts(table)[1]).toEqual(['Region 1', '100'])
    expect(elementOn(boxed.deck, 2, boxed.info?.element)).toMatchObject({ x: 100, y: 200, width: 400 })
    expect(placeholderFor(boxed.deck.slides[1], 'body')).toBeDefined()

    const selected = insertRangeStep(deck, { slide: 2, range: 'selection' }, { front: null, sheets })

    expect(texts(elementOn(selected.deck, 2, selected.info?.element))).toEqual([
      ['Region', 'Units'],
      ['Region 1', '100']
    ])
    expect(() => insertRangeStep(deck, { slide: 2, workbook: 'Sales.xlsx', range: 'selection' }, { front: null, sheets: new Map([['Sales.xlsx', { ...source, selection: null }]]) })).toThrow('Only a workbook open in Herald Sheets has a selection: give a range of Sales.xlsx, like A1:D12')
    expect(() => insertRangeStep(deck, { workbook: 'Other.xlsx' }, { front: null, sheets })).toThrow('The workbook Other.xlsx was not read')
  })

  it('makes new slides of a range, after a slide or the one in front', () => {
    const fresh = insertRangeStep(deck, { slide: 'new', workbook: 'Sales.xlsx' }, { front: deck.slides[0].id, sheets })
    const titled = rangeSlidesStep(deck, { workbook: 'Sales.xlsx', range: "'Sales'!A1:B2", title: 'Units by region', after: 'Review', header: false }, { front: null, sheets })

    expect(titles(fresh.deck)).toEqual(['Review', 'Sales', 'Costs'])
    expect(fresh.done).toBe('added slide 2 with A1:B4 of Sales.xlsx as a table')
    expect(fresh.info).toEqual({ slide: 2, slides: 1, from: { workbook: 'Sales.xlsx', sheet: 'Sales', range: 'A1:B4' } })
    expect([titles(titled.deck), layouts(titled.deck)]).toEqual([
      ['Review', 'Units by region', 'Costs'],
      ['title', 'title-only', 'title-content']
    ])
    expect(texts(titled.deck.slides[1].elements.find((element) => element.kind === 'table'))).toEqual([
      ['Region', 'Units'],
      ['Region 1', '100']
    ])
  })
})

// Documents as Herald Docs holds them.
const p = (text: string): DocNode => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const h = (level: number, text: string): DocNode => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] })
const ul = (...items: string[]): DocNode => ({ type: 'bulletList', content: items.map((item) => ({ type: 'listItem', content: [p(item)] })) })
const doc = (...content: DocNode[]): DocJSON => ({ type: 'doc', content })

/** A change of Herald Docs' made to a document as on a file, and the document it leaves. */
function made(change: Change, json: DocJSON): DocJSON {
  const state = stateOf(json)
  const tr = change.build(state, null, false)(state)

  return tr && tr.steps.length ? jsonOf(tr.doc) : json
}

describe('slides from a document, as File > New from Document makes them', () => {
  const course = doc(h(1, 'Part one'), h(2, 'Intro'), p('Hello there.'), h(3, 'Detail'), ul('A', 'B'), h(1, 'Part two'), h(2, 'Wrap'))

  it('starts slides at every heading, or at the level asked for: deeper headings are bullets, higher ones section headers', () => {
    const every = model.deckFromDocument(course, { title: 'Course' })
    const second = model.deckFromDocument(course, { title: 'Course', level: 2 })
    const first = model.deckFromDocument(course, { title: 'Course', level: 1 })

    expect([layouts(every), titles(every)]).toEqual([
      ['title', 'section', 'title-content', 'title-content', 'section', 'section'],
      ['Course', 'Part one', 'Intro', 'Detail', 'Part two', 'Wrap']
    ])
    expect([layouts(second), titles(second)]).toEqual([
      ['title', 'section', 'title-content', 'section', 'section'],
      ['Course', 'Part one', 'Intro', 'Part two', 'Wrap']
    ])
    expect(bullets(second.slides[2])).toEqual([
      ['Hello there.', 0],
      ['Detail', 0],
      ['A', 1],
      ['B', 1]
    ])
    expect([layouts(first), titles(first)]).toEqual([
      ['title', 'title-content', 'title-content'],
      ['Course', 'Part one', 'Part two']
    ])
    expect(bullets(first.slides[1])).toEqual([
      ['Intro', 0],
      ['Hello there.', 1],
      ['Detail', 1],
      ['A', 2],
      ['B', 2]
    ])
    expect(bullets(first.slides[2])).toEqual([['Wrap', 0]])
  })

  it('takes a lone top heading as the title unless slides start at its level, and makes one slide of headings below the level', () => {
    const plan = doc(h(1, 'Launch plan'), p('Spring 2027'), h(2, 'Goals'), ul('Ship'), h(2, 'Team'), ul('Ana', 'Ben'))
    const asked = model.deckFromDocument(plan, { title: 'Plan', level: 1 })
    const shop = model.deckFromDocument(doc(h(2, 'Milk'), h(3, 'Whole')), { title: 'Shop', level: 1 })

    expect(titles(model.deckFromDocument(plan, { title: 'Plan' }))).toEqual(['Launch plan', 'Goals', 'Team'])
    expect(titles(asked)).toEqual(['Plan', 'Launch plan'])
    expect(bullets(asked.slides[1])).toEqual([
      ['Spring 2027', 0],
      ['Goals', 0],
      ['Ship', 1],
      ['Team', 0],
      ['Ana', 1],
      ['Ben', 1]
    ])
    expect(titles(shop)).toEqual(['Shop', 'Shop'])
    expect(bullets(shop.slides[1])).toEqual([
      ['Milk', 0],
      ['Whole', 1]
    ])
  })

  it('with notes, puts every paragraph in the speaker notes and keeps the bullets short', () => {
    const item = 'Hire engineers for the platform team as soon as the budget is approved by finance'
    const talk = doc(h(1, 'Plan'), p('We will hire two engineers this quarter. They start in May.'), ul(item), h(1, 'Risks'), p('Supply chains are slow. Prices may rise.'))
    const plain = model.deckFromDocument(talk, { title: 'Talk' })
    const told = model.deckFromDocument(talk, { title: 'Talk', notes: true })

    expect(bullets(plain.slides[1]).map(([text]) => text)).toEqual(['We will hire two engineers this quarter. They start in May.', item])
    expect(plain.slides.map((slide) => slide.notes)).toEqual(['', '', ''])
    expect(told.slides.slice(1).map((slide) => [model.slideTitle(slide), bullets(slide).map(([text]) => text), slide.notes])).toEqual([
      ['Plan', ['Hire engineers for the platform team as soon as the budget is approved by…'], `We will hire two engineers this quarter. They start in May.\n\n${item}`],
      ['Risks', ['Supply chains are slow.'], 'Supply chains are slow. Prices may rise.']
    ])
    expect(documentOptionsOf({ level: 'h2', notes: 'true' })).toEqual({ level: 2, notes: true })
    expect(documentOptionsOf({})).toEqual({})
    expect(() => documentOptionsOf({ level: 7 })).toThrow('level is a heading level from 1 to 6')
  })

  it('makes a document with a table of contents, notes, fields and comments into slides that read as its pages do', () => {
    let guide = documentFromMarkdown('# Field guide\n\nA short tour of the season.\n\n## Results\n\nSales grew in March.\n\nBudget for FY is approved.\n\n## Next steps\n\n- Hire two people\n- Figures are on p.\n').document
    guide = made(insertTocChange({ heading: 'Field guide', mode: 'prepend' }), guide)
    guide = made(insertNoteChange({ quote: 'Sales grew in March.' }, { text: 'Source: the annual report.' }), guide)
    guide = made(insertNoteChange({ kind: 'endnote', quote: 'Hire two people' }, { text: 'Budget permitting.' }), guide)
    guide = made(insertFieldChange({ field: 'date', format: 'yy', quote: 'Budget for FY' }), guide)
    guide = made(insertFieldChange({ field: 'page', quote: 'on p.' }), guide)
    guide = made(addCommentsChange([commentItemOf({ text: 'Which month?', quote: 'Sales grew' })], 'Reviewer', true), guide)
    const year = fieldText({ kind: 'date', format: 'yy' })
    const deck = model.deckFromDocument(guide, { title: 'Guide' })
    const results = placeholderFor(deck.slides[1], 'body') as TextElement

    expect(guide.content.map((block) => block.type).slice(0, 3)).toEqual(['heading', 'tableOfContents', 'paragraph'])
    expect(JSON.stringify(guide)).toContain('"comment"')
    // No slide of the table of contents' entries, and its place between the title and the subtitle takes nothing away.
    expect([layouts(deck), titles(deck)]).toEqual([
      ['title', 'title-content', 'title-content'],
      ['Field guide', 'Results', 'Next steps']
    ])
    expect(textOf(placeholderFor(deck.slides[0], 'subtitle'))).toBe('A short tour of the season.')
    expect(bullets(deck.slides[1]).map(([text]) => text)).toEqual(['Sales grew in March.¹', `Budget for FY${year} is approved.`])
    expect(bullets(deck.slides[2]).map(([text]) => text)).toEqual(['Hire two peopleⁱ', 'Figures are on p.#'])
    expect(deck.slides.map((slide) => slide.notes)).toEqual(['', '¹ Source: the annual report.', 'ⁱ Budget permitting.'])
    // The comment on "Sales grew" leaves the text in one run, as if it were not there.
    expect(results.body.paragraphs[0].runs).toEqual([{ text: 'Sales grew in March.¹' }])
  })

  it('adds a document’s slides to the end of a deck as one step, as Insert > Slides from Document does', () => {
    const deck = pitch()
    const step = documentSlidesStep(deck, course, { name: 'Course.docx', from: '~/Course.docx' })
    const titled: DocNode = { type: 'paragraph', attrs: { docStyle: 'title' }, content: [{ type: 'text', text: 'Talk' }] }
    const told = documentSlidesStep(deck, doc(titled, h(1, 'Plan'), p('We start in May. Then we hire.'), h(1, 'Risks'), ul('Slow suppliers')), { name: 'Talk.md', from: 'Talk.md' }, { notes: true })

    // Without a title of its own, the document's first heading heads its slides.
    expect(titles(step.deck)).toEqual(['Pitch', 'Plan', 'Team', 'Part one', 'Intro', 'Detail', 'Part two', 'Wrap'])
    expect(step).toMatchObject({ label: 'Slides from Course', done: 'added 5 slides from Course.docx at the end', info: { from: '~/Course.docx', first: 4, slides: 5 } })
    expect(told.deck.slides.slice(3).map((slide) => [model.slideTitle(slide), slide.layout === 'title' ? [] : bullets(slide).map(([text]) => text), slide.notes])).toEqual([
      ['Talk', [], ''],
      ['Plan', ['We start in May.'], 'We start in May. Then we hire.'],
      ['Risks', ['Slow suppliers'], '']
    ])
    expect(() => documentSlidesStep(deck, doc(p('')), { name: 'Empty.docx', from: 'Empty.docx' })).toThrow('Empty.docx has nothing to make slides of')
  })
})

describe('reading a deck’s depth', () => {
  it('reads slides’ own themes, transitions and backgrounds, groups, connectors, hidden master graphics and the header and footer', () => {
    let deck = pitch()
    deck = setThemeStep(deck, { theme: 'midnight', slide: 2 }, none).deck
    deck = setTransitionStep(deck, { kind: 'push', slide: 2 }, none).deck
    deck = setBackgroundStep(deck, { slide: 3, gradient: 'accent1 to accent2' }, none).deck
    deck = showMasterGraphicsStep(deck, { show: false, slide: 3 }, none).deck
    deck = setHeaderFooterStep(deck, { number: true, date: true }).deck
    const read = readDeck(deck)

    expect(read).toMatchObject({ theme: 'Herald', transition: 'fade', headerFooter: { date: { format: 'numeric' }, slideNumber: true } })
    expect(read.slides[0]).not.toHaveProperty('theme')
    expect(read.slides[0]).not.toHaveProperty('transition')
    expect(read.slides[1]).toMatchObject({ theme: 'Midnight', transition: { kind: 'push', direction: 'up', seconds: 0.5 } })
    expect(read.slides[2]).toMatchObject({ background: 'gradient accent1 to accent2, 90°', masterGraphics: 'hidden' })
  })
})

describe('a batch with the depth’s changes', () => {
  it('makes them all as one step to undo, each op named after its command', () => {
    const deck = pitch()
    const doc = new SlidesDocument(deck, () => {})
    const edits = editsOf(
      JSON.stringify([
        { op: 'setHeaderFooter', number: true, skipTitle: true },
        { op: 'addLogo', source: '~/logo.png' },
        { op: 'setBackground', layout: 'master', gradient: 'background2 to background' },
        { op: 'setTransition', kind: 'fade', slide: 'all', duration: 1 },
        { op: 'addShape', slide: 2, kind: 'flowChartDecision', x: 100, y: 300, width: 100, height: 100 },
        { op: 'addShape', kind: 'flowChartProcess', x: 400, y: 300, width: 100, height: 100 },
        { op: 'addConnector', from: '3', to: '4', kind: 'elbow' },
        { op: 'setTheme', theme: 'brand' },
        { op: 'addSlideFromSheet', workbook: 'Sales.xlsx', title: 'Units' }
      ])
    )
    const source: SheetSource = { name: 'Sales.xlsx', workbook: salesBook(2), selection: null }
    const step = runBatch(doc.presentation, edits, { front: doc.slideId, pictures, sheets: new Map([['Sales.xlsx', source]]), themes: [brand] })
    doc.commit({ ...step, label: `Hermes: ${step.label}` })
    const after = doc.presentation

    expect(after.headerFooter).toMatchObject({ number: true, skipTitle: true })
    expect(readMaster(after).master.elements.map((element) => element.kind)).toEqual(['Picture'])
    expect(masterOf(after).background).toMatchObject({ kind: 'gradient' })
    // The slides there were when every slide got the transition have it as their own; the one added after takes the deck's.
    expect([after.transition, after.slides.map((slide) => slide.transition?.duration)]).toEqual(['fade', [1000, 1000, 1000, undefined]])
    expect(readDeck(after).slides[1].elements.map((element) => element.kind)).toEqual(['Title', 'Text', 'Shape', 'Shape', 'Connector'])
    expect(after.theme.id).toBe('custom-brand')
    expect(titles(after).at(-1)).toBe('Units')
    expect(batchPictures(edits)).toEqual(['~/logo.png'])
    expect(batchWorkbooks(edits)).toEqual(['Sales.xlsx'])
    expect(doc.undo()).toBe('Hermes: 9 edits')
    expect(doc.presentation).toBe(deck)
  })

  it('reads every op slides.edit takes, in any case, and stops at one that fails', () => {
    expect(EDIT_OPS).toEqual([...SLIDE_EDIT_OPS, ...Object.keys(DEPTH_STEPS)])
    expect(editsOf('[{"op": "removefrommaster", "elements": "1"}, {"op": " SetCellBorders "}]').map((edit) => edit.op)).toEqual(['removeFromMaster', 'setCellBorders'])
    expect(() => editsOf('[{"op": "explode"}]')).toThrow(/^Edit 1: op is one of addSlide, .*, setFill, addSlideFromSheet, not “explode”$/)
    expect(() => runBatch(pitch(), editsOf('[{"op": "addSlide", "title": "Risks"}, {"op": "setTransition", "kind": "spin"}]'), none)).toThrow('Edit 2 (setTransition): kind is a transition')
  })
})
