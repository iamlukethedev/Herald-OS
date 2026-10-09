import { describe, expect, it } from 'vitest'
import { type Box, type Deck, findSlide, LAYOUTS, type LayoutId, type SlideElement, type TextElement } from './deck.ts'
import { shapeElement, withBox } from './elements.ts'
import { footersOf } from './footers.ts'
import { decorationsOf, layoutOf, masterOf, masterPlaceholder, placeholderFor } from './layouts.ts'
import * as model from './model.ts'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

const boxOf = (element: SlideElement | undefined): Box => ({ x: element?.x ?? NaN, y: element?.y ?? NaN, width: element?.width ?? NaN, height: element?.height ?? NaN })
const textOf = (element: SlideElement | undefined) => element as TextElement
const slideAt = (deck: Deck, slideId: string) => findSlide(deck, slideId)!
const layoutTitle = (deck: Deck, layout: LayoutId) => layoutOf(masterOf(deck), layout).elements.find((element) => element.placeholder?.role === 'title')

/** A deck with two Title and Content slides, the second with its title moved and its text made smaller by hand. */
function deckWithSlides() {
  let deck = model.newDeck('Pitch')
  const plain = model.addSlide(deck, { layout: 'title-content', title: 'Plain' })
  deck = plain.deck
  const custom = model.addSlide(deck, { layout: 'title-content', title: 'Custom' })
  deck = custom.deck
  const title = placeholderFor(slideAt(deck, custom.slideId), 'title')!
  deck = model.updateElements(deck, custom.slideId, [title.id], (element) => withBox(element, { x: 100, y: 20, width: 500, height: 60 }), 'Move').deck
  deck = model.updateElements(deck, custom.slideId, [title.id], (element) => ({ ...element, body: { ...textOf(element).body, style: { ...textOf(element).body.style, size: 30 } } }) as SlideElement, 'Font Size').deck

  return { deck, plain: plain.slideId, custom: custom.slideId }
}

describe('the master’s deck', () => {
  it('opens the master and each layout as slides, and gives back the same deck while the master is unchanged', () => {
    const deck = model.newDeck('Pitch')
    const pseudo = model.masterDeck(deck)

    expect(pseudo.slides.map((slide) => slide.id)).toEqual(['master', ...LAYOUTS.map((id) => `layout-${id}`)])
    expect(pseudo.slides[0]).toMatchObject({ layout: 'blank', background: null })
    expect(pseudo.slides[0].elements).toBe(masterOf(deck).elements)
    expect(pseudo.slides[2]).toMatchObject({ layout: 'title-content' })
    expect(pseudo.slides[2].elements).toBe(layoutOf(masterOf(deck), 'title-content').elements)
    expect(pseudo.size).toEqual(deck.size)
    expect(pseudo.theme).toBe(deck.theme)
    expect(pseudo.headerFooter).toBeUndefined()
    expect(decorationsOf(pseudo, 'blank')).toEqual([])
    expect(model.masterDeck(deck)).toBe(pseudo)
    expect(model.applyMasterDeck(deck, pseudo)).toBe(deck)
    expect(model.slideLayoutId('layout-two-content')).toBe('two-content')
    expect(model.slideLayoutId('master')).toBeNull()
  })

  it('takes the edited master back as the deck’s own, even from Herald’s default', () => {
    const deck = model.newDeck('Pitch')
    const pseudo = model.masterDeck(deck)
    const edited = model.setBackground(pseudo, ['master', 'layout-section'], { kind: 'solid', color: 'accent2' }).deck
    const next = model.applyMasterDeck(deck, edited)

    expect(deck.master).toBeUndefined()
    expect(next.master?.background).toEqual({ kind: 'solid', color: 'accent2' })
    expect(layoutOf(next.master!, 'section').background).toEqual({ kind: 'solid', color: 'accent2' })
    expect(layoutOf(next.master!, 'title').background).toBeNull()
    expect(next.slides).toBe(deck.slides)
    expect(model.masterDeck(next)).not.toBe(pseudo)
    expect(model.masterDeck(next).slides[0].background).toEqual({ kind: 'solid', color: 'accent2' })
  })

  it('passes a change to the master’s title to the layouts and slides that still had the old value, and only to those', () => {
    const { deck, plain, custom } = deckWithSlides()
    const before = boxOf(masterPlaceholder(masterOf(deck), 'title'))
    const box = { x: 72, y: 30, width: 816, height: 96 }
    const change = model.setPlaceholderBox(deck, 'master', 'title', box)
    const next = change.deck

    expect(change.label).toBe('Placeholder')
    expect(before).toEqual({ x: 60, y: 36, width: 840, height: 84 })
    expect(boxOf(masterPlaceholder(next.master!, 'title'))).toEqual(box)
    expect(boxOf(layoutTitle(next, 'title-content'))).toEqual(box)
    expect(boxOf(layoutTitle(next, 'title-only'))).toEqual(box)
    expect(boxOf(layoutTitle(next, 'title'))).toEqual({ x: 80, y: 150, width: 800, height: 130 })
    expect(boxOf(placeholderFor(slideAt(next, plain), 'title'))).toEqual(box)
    expect(boxOf(placeholderFor(slideAt(next, custom), 'title'))).toEqual({ x: 100, y: 20, width: 500, height: 60 })
    expect(boxOf(placeholderFor(slideAt(next, deck.slides[0].id), 'title'))).toEqual({ x: 80, y: 150, width: 800, height: 130 })
  })

  it('passes text looks and prompts down the same way, leaving what a slide made its own', () => {
    const { deck, plain, custom } = deckWithSlides()
    const styled = model.setPlaceholderStyle(deck, 'master', 'title', { size: 44, color: 'accent1', align: 'center' }).deck
    const plainTitle = textOf(placeholderFor(slideAt(styled, plain), 'title'))
    const customTitle = textOf(placeholderFor(slideAt(styled, custom), 'title'))

    expect(textOf(layoutTitle(styled, 'title-content')).body.style).toMatchObject({ size: 44, color: 'accent1' })
    expect(textOf(layoutTitle(styled, 'title')).body.style.size).toBe(54)
    expect(textOf(layoutTitle(styled, 'title')).body.style.color).toBe('accent1')
    expect(plainTitle.body.style).toMatchObject({ size: 44, color: 'accent1' })
    expect(plainTitle.body.paragraphs[0].align).toBe('center')
    expect(customTitle.body.style).toMatchObject({ size: 30, color: 'accent1' })

    const pseudo = model.masterDeck(styled)
    const masterTitle = masterPlaceholder(styled.master!, 'title')!
    const prompted = model.updateElements(pseudo, 'master', [masterTitle.id], (element) => ({ ...element, placeholder: { role: 'title', prompt: 'Say it in a line' } }), 'Prompt').deck
    const next = model.applyMasterDeck(styled, prompted)

    expect(layoutTitle(next, 'section')?.placeholder?.prompt).toBe('Say it in a line')
    expect(placeholderFor(slideAt(next, custom), 'title')?.placeholder?.prompt).toBe('Say it in a line')
  })

  it('compares boxes within half a point', () => {
    const { deck, plain } = deckWithSlides()
    const title = placeholderFor(slideAt(deck, plain), 'title')!
    const nudged = model.updateElements(deck, plain, [title.id], (element) => ({ ...element, x: element.x + 0.4 }), 'Nudge').deck
    const box = { x: 90, y: 40, width: 780, height: 80 }

    expect(boxOf(placeholderFor(slideAt(model.setPlaceholderBox(nudged, 'title-content', 'title', box).deck, plain), 'title'))).toEqual(box)
  })

  it('passes a layout’s change to the matching placeholder of its slides only', () => {
    let deck = model.addSlide(model.newDeck('Pitch'), { layout: 'two-content' }).deck
    deck = model.addSlide(deck, { layout: 'title-content' }).deck
    const [, two, one] = deck.slides.map((slide) => slide.id)
    const box = { x: 500, y: 150, width: 380, height: 300 }
    const next = model.setPlaceholderBox(deck, 'two-content', 'body', box, 1).deck

    expect(boxOf(placeholderFor(slideAt(next, two), 'body', 1))).toEqual(box)
    expect(boxOf(placeholderFor(slideAt(next, two), 'body', 0))).toEqual(boxOf(placeholderFor(slideAt(deck, two), 'body', 0)))
    expect(slideAt(next, one)).toBe(slideAt(deck, one))
    expect(() => model.setPlaceholderBox(deck, 'blank', 'title', box)).toThrow(/Blank layout has no title placeholder/)
  })

  it('moves layouts’ footers with the master’s', () => {
    const deck = model.newDeck('Pitch')
    const footer = masterPlaceholder(masterOf(deck), 'footer')!
    const pseudo = model.masterDeck(deck)
    const own = { ...footer, id: 'layout-footer' }
    const withOwn = model.applyMasterDeck(deck, model.insertElements(pseudo, 'layout-section', [own], 'Footer').deck)
    const moved = model.setPlaceholderBox(withOwn, 'master', 'footer', { x: 300, y: 500, width: 360, height: 24 }).deck
    const placed = layoutOf(moved.master!, 'section').elements.find((element) => element.id === 'layout-footer')

    expect(boxOf(placed)).toEqual({ x: 300, y: 500, width: 360, height: 24 })
  })
})

describe('master operations', () => {
  it('sets the master’s and a layout’s backgrounds', () => {
    const deck = model.newDeck('Pitch')
    const master = model.setMasterBackground(deck, { kind: 'solid', color: 'bg2' })
    const layout = model.setLayoutBackground(master.deck, 'section', { kind: 'solid', color: 'accent1' })

    expect(master.label).toBe('Master Background')
    expect(master.deck.master?.background).toEqual({ kind: 'solid', color: 'bg2' })
    expect(layout.label).toBe('Layout Background')
    expect(layoutOf(layout.deck.master!, 'section').background).toEqual({ kind: 'solid', color: 'accent1' })
    expect(model.setMasterBackground(layout.deck, null).deck.master?.background).toBeNull()
  })

  it('adds drawings to the master or a layout, and takes them off again', () => {
    const deck = model.newDeck('Pitch')
    const band = model.addShape(deck, deck.slides[0].id, { shape: 'rect', x: 0, y: 0, width: 960, height: 12 })
    const shape = findSlide(band.deck, deck.slides[0].id)!.elements.at(-1)!
    const onMaster = model.addMasterElements(deck, [shape])
    const onLayout = model.addMasterElements(deck, [{ ...shape, id: 'layout-band' }], 'title')

    expect(onMaster.label).toBe('Add to Master')
    expect(decorationsOf(onMaster.deck, 'title-content').map((element) => element.id)).toEqual([shape.id])
    expect(onLayout.label).toBe('Add to Layout')
    expect(decorationsOf(onLayout.deck, 'title').map((element) => element.id)).toEqual(['layout-band'])
    expect(decorationsOf(onLayout.deck, 'section')).toEqual([])
    expect(model.addMasterElements(deck, []).deck).toBe(deck)

    const removed = model.removeMasterElements(onMaster.deck, [shape.id])
    expect(decorationsOf(removed.deck, 'title-content')).toEqual([])
  })

  it('puts a logo in a corner, set in from the edges and clear of the footers', () => {
    const deck = model.newDeck('Pitch')
    const bottom = model.addLogo(deck, { src: PNG, natural: { width: 400, height: 200 }, corner: 'bottom-right' })
    const logo = bottom.deck.master!.elements.find((element) => element.id === bottom.elementId)!
    const number = masterPlaceholder(masterOf(deck), 'number')!

    expect(bottom.label).toBe('Logo')
    expect(logo).toMatchObject({ kind: 'image', name: 'Logo', width: 96, height: 48 })
    expect(logo.x + logo.width).toBeCloseTo(deck.size.width - 24)
    expect(logo.y + logo.height).toBeLessThanOrEqual(number.y - 8 + 1e-9)
    expect(decorationsOf(bottom.deck, 'title-content').map((element) => element.id)).toContain(logo.id)

    const top = model.addLogo(deck, { src: PNG, natural: { width: 100, height: 100 }, corner: 'top-left', width: 60, layoutId: 'title' })
    const placed = layoutOf(top.deck.master!, 'title').elements.find((element) => element.id === top.elementId)!

    expect(placed).toMatchObject({ x: 24, y: 24, width: 60, height: 60 })
    expect(top.deck.master!.elements.some((element) => element.id === top.elementId)).toBe(false)
  })

  it('shows or hides the master’s drawings on a layout and renames it', () => {
    const deck = model.addMasterElements(model.newDeck('Pitch'), [shapeElement('rect', { x: 0, y: 0, width: 960, height: 12 })]).deck
    const hidden = model.setShowMaster(deck, 'section', false)

    expect(hidden.label).toBe('Hide Background Graphics')
    expect(decorationsOf(hidden.deck, 'section')).toEqual([])
    expect(model.setShowMaster(hidden.deck, 'section', false).deck).toBe(hidden.deck)
    expect(model.setShowMaster(hidden.deck, 'section', true).label).toBe('Show Background Graphics')

    const renamed = model.renameLayout(deck, 'section', '  Chapter  ')
    expect(layoutOf(renamed.deck.master!, 'section').name).toBe('Chapter')
    expect(layoutOf(model.renameLayout(renamed.deck, 'section', ' ').deck.master!, 'section').name).toBe('Section Header')
  })

  it('resets the master to Herald’s, moving slides that followed their layouts back too', () => {
    const { deck, plain, custom } = deckWithSlides()
    const moved = model.setPlaceholderBox(deck, 'title-content', 'title', { x: 72, y: 30, width: 816, height: 96 }).deck
    const reset = model.resetMaster(moved)

    expect(reset.label).toBe('Reset Master')
    expect(reset.deck.master).toBeUndefined()
    expect(boxOf(placeholderFor(slideAt(reset.deck, plain), 'title'))).toEqual({ x: 60, y: 36, width: 840, height: 84 })
    expect(boxOf(placeholderFor(slideAt(reset.deck, custom), 'title'))).toEqual({ x: 100, y: 20, width: 500, height: 60 })
    expect(model.resetMaster(reset.deck).deck).toBe(reset.deck)
  })

  it('sets what the header and footer show', () => {
    const deck = model.newDeck('Pitch')
    const change = model.setHeaderFooter(deck, { footer: true, footerText: 'Herald', number: true, skipTitle: false })
    const next = model.addSlide(change.deck, { layout: 'title-content' }).deck

    expect(change.label).toBe('Header and Footer')
    expect(change.deck.headerFooter).toMatchObject({ footer: true, footerText: 'Herald', number: true, date: false })
    expect(footersOf(next, next.slides[1], 1).map((footer) => [footer.role, footer.text])).toEqual([
      ['footer', 'Herald'],
      ['number', '2']
    ])
    expect(model.setHeaderFooter(change.deck, { footerText: 'Herald' }).deck).toBe(change.deck)
    expect(model.setHeaderFooter(change.deck, { dateText: '  ' }).deck.headerFooter?.dateText).toBeUndefined()
    expect(model.setHeaderFooter(deck, {}).deck).toBe(deck)
  })
})
