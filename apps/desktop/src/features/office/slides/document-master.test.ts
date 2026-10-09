import { describe, expect, it, vi } from 'vitest'
import { findSlide, SLIDE_SIZES, withElements } from './deck.ts'
import { SlidesDocument } from './document.ts'
import { layoutOf, masterOf } from './layouts.ts'
import * as model from './model.ts'

const threeSlides = () => {
  let deck = model.newDeck('Pitch')
  deck = model.addSlide(deck, { layout: 'title-content' }).deck

  return model.addSlide(deck, { layout: 'two-content' }).deck
}

const logo = { src: 'data:image/png;base64,AAAA', natural: { width: 200, height: 100 } }

describe('the master view of a SlidesDocument', () => {
  it('edits the master and its layouts as the slides of a deck of their own, from the layout of the slide in front', () => {
    const doc = new SlidesDocument(threeSlides(), () => {})
    const deck = doc.presentation
    doc.goTo(deck.slides[1].id)
    doc.enterMaster()

    expect(doc.mode).toBe('master')
    expect(doc.deck).toBe(model.masterDeck(deck))
    expect(doc.base).toBe(doc.deck)
    expect(doc.presentation).toBe(deck)
    expect(doc.history.present).toBe(deck)
    expect(doc.slideId).toBe(model.layoutSlideId('title-content'))
    expect(doc.pickedSlides).toEqual([model.layoutSlideId('title-content')])

    doc.goTo(model.MASTER_SLIDE_ID, true)
    expect(doc.pickedSlides).toEqual([model.MASTER_SLIDE_ID])
  })

  it('keeps the same master’s deck while the deck’s master stays, whatever else changes', () => {
    const doc = new SlidesDocument(threeSlides(), () => {})
    doc.enterMaster()
    const before = doc.deck
    doc.commit(model.setNotes(doc.presentation, doc.presentation.slides[0].id, 'Say hello'))

    expect(doc.presentation.slides[0].notes).toBe('Say hello')
    expect(doc.deck).toBe(before)
  })

  it('makes a change of the master’s deck one step of the deck, undone and redone in the view', () => {
    const edited = vi.fn()
    const doc = new SlidesDocument(threeSlides(), edited)
    const before = doc.presentation
    doc.enterMaster('master')
    const added = model.addShape(doc.base, model.MASTER_SLIDE_ID, { shape: 'rect' })
    doc.commit({ ...added, focus: { selected: [added.elementId] } })
    const onMaster = () => masterOf(doc.presentation).elements.some((element) => element.id === added.elementId)

    expect(edited).toHaveBeenCalledOnce()
    expect(onMaster()).toBe(true)
    expect(doc.presentation.slides).toBe(before.slides)
    expect(doc.selected).toEqual([added.elementId])
    expect(doc.slide.elements.some((element) => element.id === added.elementId)).toBe(true)

    expect(doc.undo()).toBe('New Shape')
    expect(doc.presentation).toBe(before)
    expect(doc.selected).toEqual([])
    expect(doc.history.canUndo).toBe(false)
    expect(doc.redo()).toBe('New Shape')
    expect(onMaster()).toBe(true)
    expect(doc.mode).toBe('master')
  })

  it('shows a drag of the master’s deck as a preview and keeps it as one step when it ends', () => {
    const doc = new SlidesDocument(model.newDeck('Pitch'), () => {})
    doc.enterMaster('master')
    const title = doc.slide.elements.find((element) => element.placeholder?.role === 'title')!
    const moved = (y: number) => withElements(doc.base, model.MASTER_SLIDE_ID, new Set([title.id]), (element) => ({ ...element, y }))

    doc.show(moved(10))
    doc.show(moved(20))
    expect(doc.slide.elements.find((element) => element.id === title.id)?.y).toBe(20)
    expect(doc.history.canUndo).toBe(false)

    doc.commit({ deck: doc.preview!, label: 'Move', focus: { selected: [title.id] } })
    expect(doc.preview).toBeNull()
    expect(masterOf(doc.presentation).elements.find((element) => element.id === title.id)?.y).toBe(20)
    expect(doc.undo()).toBe('Move')
    expect(masterOf(doc.presentation).elements.find((element) => element.id === title.id)?.y).toBe(title.y)
  })

  it('drops a preview made in the other view', () => {
    const doc = new SlidesDocument(model.newDeck('Pitch'), () => {})
    const slidesPreview = model.addSlide(doc.presentation).deck
    doc.enterMaster()
    doc.show(slidesPreview)
    expect(doc.preview).toBeNull()

    const masterPreview = doc.base
    doc.exitMaster()
    doc.show(masterPreview)
    expect(doc.preview).toBeNull()
  })

  it('takes a change of the deck itself as it is in the view, and goes to its slide on the way back', () => {
    const doc = new SlidesDocument(threeSlides(), () => {})
    const [a, b, c] = doc.presentation.slides.map((slide) => slide.id)
    doc.goTo(c)
    doc.enterMaster()
    const front = doc.slideId
    doc.commit(model.setHeaderFooter(doc.presentation, { number: true }))

    expect(doc.presentation.headerFooter?.number).toBe(true)
    expect(doc.slideId).toBe(front)

    doc.commit(model.removeSlides(doc.presentation, [c]))
    expect(doc.mode).toBe('master')
    expect(doc.slideId).toBe(front)
    expect(doc.presentation.slides.map((slide) => slide.id)).toEqual([a, b])

    doc.exitMaster()
    expect(doc.slideId).toBe(b)
  })

  it('maps a change of the master’s deck into the master even after the view has closed', () => {
    const doc = new SlidesDocument(model.newDeck('Pitch'), () => {})
    doc.enterMaster('master')
    const late = model.addShape(doc.base, model.MASTER_SLIDE_ID, { shape: 'ellipse' })
    doc.exitMaster()
    doc.commit(late)

    expect(doc.presentation.slides.map((slide) => slide.id)).toEqual([doc.slideId])
    expect(masterOf(doc.presentation).elements.some((element) => element.id === late.elementId)).toBe(true)
  })

  it('leaves the master as it is for what only slides take: another layout, another size', () => {
    const doc = new SlidesDocument(model.newDeck('Pitch'), () => {})
    const before = doc.presentation
    doc.enterMaster('title')
    doc.commit(model.setLayout(doc.base, model.layoutSlideId('title'), 'blank'))
    doc.commit(model.setSize(doc.base, SLIDE_SIZES.standard))

    expect(doc.presentation).toBe(before)
    expect(doc.history.canUndo).toBe(false)
    expect(doc.slide.elements).toBe(layoutOf(masterOf(before), 'title').elements)
  })

  it('goes back to the slide that was in front and the slides picked, or a slide in its place', () => {
    const doc = new SlidesDocument(threeSlides(), () => {})
    const [, b, c] = doc.presentation.slides.map((slide) => slide.id)
    doc.goTo(b)
    doc.goTo(c, true)
    doc.enterMaster()
    expect(doc.slideId).toBe(model.layoutSlideId('two-content'))

    doc.goTo(model.MASTER_SLIDE_ID)
    doc.exitMaster()
    expect(doc.mode).toBe('slides')
    expect(doc.deck).toBe(doc.presentation)
    expect(doc.slideId).toBe(c)
    expect(doc.pickedSlides).toEqual([b, c])

    doc.enterMaster()
    doc.reset(model.newDeck('From disk'))
    doc.exitMaster()
    expect(doc.slideId).toBe(doc.presentation.slides[0].id)
  })

  it('draws a layout over the master’s drawings and background, and the master on its own', () => {
    const doc = new SlidesDocument(model.newDeck('Pitch'), () => {})
    const plain = doc.viewOptions(doc.slide)
    expect(plain).toEqual({})

    let deck = model.addLogo(doc.presentation, { ...logo, corner: 'top-right' }).deck
    deck = model.setMasterBackground(deck, { kind: 'solid', color: 'accent1' }).deck
    doc.commit({ deck, label: 'Logo' })
    doc.enterMaster('master')
    expect(doc.viewOptions(doc.slide)).toEqual({ inherit: false })

    doc.goTo(model.layoutSlideId('title-content'))
    const options = doc.viewOptions(doc.slide)
    const [backdrop, drawn] = options.behind ?? []
    expect(options.inherit).toBe(false)
    expect(backdrop).toMatchObject({ kind: 'shape', shape: 'rect', x: 0, y: 0, width: deck.size.width, height: deck.size.height, fill: { color: 'accent1' } })
    expect(drawn).toMatchObject({ kind: 'image', name: 'Logo' })
    expect(options.behind?.some((element) => element.placeholder)).toBe(false)
    expect(doc.viewOptions(doc.slide)).toBe(options)

    // The Blank layout shares its id with the master's own slide, yet shows the master's drawings as its layout says.
    expect(layoutOf(masterOf(doc.presentation), 'blank').showMaster).toBe(true)
    expect(doc.viewOptions(findSlide(doc.deck, model.layoutSlideId('blank'))!).behind).toHaveLength(2)

    doc.commit(model.setShowMaster(doc.presentation, 'title-content', false))
    expect(doc.viewOptions(doc.slide).behind).toEqual([backdrop])

    doc.commit(model.setLayoutBackground(doc.presentation, 'title-content', { kind: 'solid', color: 'bg2' }))
    expect(doc.viewOptions(doc.slide)).toEqual({ inherit: false })

    doc.exitMaster()
    expect(doc.viewOptions(doc.slide)).toEqual({})
  })

  it('draws a picture background behind a layout cut to cover the slide', () => {
    const doc = new SlidesDocument(model.newDeck('Pitch'), () => {})
    doc.commit(model.setMasterBackground(doc.presentation, { kind: 'image', ...logo }))
    doc.enterMaster('title-only')
    const [backdrop] = doc.viewOptions(doc.slide).behind ?? []

    expect(backdrop).toMatchObject({ kind: 'image', src: logo.src, x: 0, y: 0, width: doc.deck.size.width })
    expect(backdrop.kind === 'image' && backdrop.crop).toBeTruthy()
  })
})
