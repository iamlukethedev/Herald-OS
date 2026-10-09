import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfficeCommand } from '../../shell/commands.ts'
import { SlidesDocument } from '../document.ts'
import { layoutOf, masterOf } from '../layouts.ts'
import * as model from '../model.ts'
import type { Presentation } from '../present/state.ts'
import { showPresenterView, startPresenting } from '../Present.tsx'
import { $presentation } from '../store.ts'
import { $customThemes } from '../theme-store.ts'
import { THEMES } from '../themes.ts'
import { present } from './commands.ts'
import { $slidesDialog, insertLogo } from './master-commands.ts'
import { backgroundGraphicsCommands, headerFooterCommands, masterViewCommands, presentCommands, themeCommands, transitionCommands } from './slides-menus.ts'

const live = vi.hoisted(() => ({ doc: undefined as SlidesDocument | undefined }))

vi.mock('./commands.ts', () => ({
  live: () => live.doc,
  notify: vi.fn(),
  present: vi.fn(),
  readPicture: vi.fn(async () => ({ src: 'data:image/png;base64,AAAA', natural: { width: 200, height: 100 } }))
}))

vi.mock('../Present.tsx', () => ({ startPresenting: vi.fn(), showPresenterView: vi.fn() }))

vi.mock('../store.ts', async () => {
  const { atom } = await import('nanostores')

  return { $presentation: atom(null), slidesSession: { active: () => ({ key: 'deck' }) } }
})

const every = (items: readonly OfficeCommand[]): OfficeCommand[] => items.flatMap((item) => [item, ...every(item.submenu ?? [])])

const all = () => [...masterViewCommands(), ...themeCommands(), ...headerFooterCommands(), ...backgroundGraphicsCommands(), ...transitionCommands(), ...presentCommands()]

function item(id: string): OfficeCommand {
  const found = every(all()).find((entry) => entry.id === id)

  if (!found) {
    throw new Error(`No menu item ${id}`)
  }

  return found
}

const enabled = (id: string) => item(id).enabled?.() ?? true

const checked = (id: string) => item(id).checked?.() ?? false

function open(): SlidesDocument {
  let deck = model.newDeck('Pitch')
  deck = model.addSlide(deck, { layout: 'title-content' }).deck
  deck = model.addSlide(deck, { layout: 'two-content' }).deck
  live.doc = new SlidesDocument(deck, () => {})

  return live.doc
}

const presenting = (mode: Presentation['mode']) => $presentation.set({ mode } as Presentation)

beforeEach(() => {
  live.doc = undefined
  $presentation.set(null)
  $customThemes.set([])
  $slidesDialog.set(null)
  vi.clearAllMocks()
})

describe('the slides menus', () => {
  it('wait for a deck', () => {
    for (const id of ['slide-master', 'theme', 'theme-selected', 'theme-new', 'header-footer', 'hide-background-graphics', 'transition', 'transition-all', 'present', 'present-start', 'presenter-view']) {
      expect([id, enabled(id)]).toEqual([id, false])
    }
  })

  it('turn the master view on and off, but not while presenting', () => {
    const doc = open()

    expect([enabled('slide-master'), checked('slide-master')]).toEqual([true, false])
    item('slide-master').run()
    expect(doc.mode).toBe('master')
    expect(checked('slide-master')).toBe(true)
    item('slide-master').run()
    expect(doc.mode).toBe('slides')

    presenting('slides')
    expect(enabled('slide-master')).toBe(false)
  })

  it('leave work on the slides for the slides view while the master is open', () => {
    const doc = open()
    doc.enterMaster('master')

    for (const id of ['theme-selected', 'transition', 'transition-effect', 'transition-duration', 'transition-all', 'present', 'present-start', 'presenter-view', 'hide-background-graphics']) {
      expect([id, enabled(id)]).toEqual([id, false])
    }

    for (const id of ['slide-master', 'theme', 'theme-new', 'header-footer']) {
      expect([id, enabled(id)]).toEqual([id, true])
    }

    doc.goTo(model.layoutSlideId('title-only'))
    expect(enabled('hide-background-graphics')).toBe(true)
  })

  it('put a theme on every slide or on the picked ones, with the one in use checked', () => {
    const doc = open()
    const [, second] = doc.presentation.slides

    expect(item('theme').submenu?.map((entry) => entry.id)).toEqual(THEMES.map((theme) => `theme-all-${theme.id}`))
    expect(checked(`theme-all-${THEMES[0].id}`)).toBe(true)

    item('theme-all-midnight').run()
    expect(doc.presentation.theme.id).toBe('midnight')
    expect(checked('theme-all-midnight')).toBe(true)
    expect(doc.history.undoLabel).toBe('Theme')

    doc.goTo(second.id)
    item('theme-selected-paper').run()
    expect(doc.presentation.slides.map((slide) => slide.theme?.id)).toEqual([undefined, 'paper', undefined])
    expect([checked('theme-selected-paper'), checked('theme-all-paper'), checked('theme-all-midnight')]).toEqual([true, false, true])
  })

  it('list the custom themes after Herald’s, and edit the deck’s when it is one', () => {
    const doc = open()
    const custom = { ...model.editTheme(THEMES[2], { name: 'Mine' }), id: 'custom-mine' }
    $customThemes.set([custom])
    const themes = item('theme').submenu ?? []

    expect(themes.at(-1)).toMatchObject({ id: 'theme-all-custom-mine', label: 'Mine', dividerBefore: true })
    expect(enabled('theme-edit')).toBe(false)

    item('theme-all-custom-mine').run()
    expect(doc.presentation.theme).toBe(custom)
    expect(enabled('theme-edit')).toBe(true)

    item('theme-edit').run()
    expect($slidesDialog.get()).toMatchObject({ kind: 'theme', doc, theme: custom, fresh: false, scope: 'all' })

    item('theme-new').run()
    expect($slidesDialog.get()).toMatchObject({ kind: 'theme', fresh: true })
  })

  it('open the header and footer dialog for the deck in front', () => {
    const doc = open()
    item('header-footer').run()

    expect($slidesDialog.get()).toEqual({ kind: 'header-footer', doc })
  })

  it('hide background graphics on the picked slides, or on the layout in front of the master view', () => {
    const doc = open()
    const [first, second] = doc.presentation.slides.map((slide) => slide.id)
    doc.goTo(second, true)

    expect([enabled('hide-background-graphics'), checked('hide-background-graphics')]).toEqual([true, false])
    item('hide-background-graphics').run()
    expect(doc.presentation.slides.map((slide) => slide.showMaster)).toEqual([false, false, undefined])
    expect(checked('hide-background-graphics')).toBe(true)
    item('hide-background-graphics').run()
    expect(doc.presentation.slides.map((slide) => slide.showMaster)).toEqual([undefined, undefined, undefined])

    doc.goTo(first)
    doc.enterMaster()
    expect(doc.slideId).toBe(model.layoutSlideId('title'))
    item('hide-background-graphics').run()
    expect(layoutOf(masterOf(doc.presentation), 'title').showMaster).toBe(false)
    expect(checked('hide-background-graphics')).toBe(true)
    expect(doc.mode).toBe('master')
  })

  it('set how the picked slides come in, its effect and duration, or one transition for every slide', () => {
    const doc = open()
    const [, second, third] = doc.presentation.slides.map((slide) => slide.id)
    doc.goTo(second)
    doc.goTo(third, true)

    expect([checked('transition-fade'), enabled('transition-effect'), enabled('transition-duration')]).toEqual([true, false, true])
    item('transition-none').run()
    expect([checked('transition-none'), enabled('transition-duration')]).toEqual([true, false])
    item('transition-push').run()
    expect(doc.presentation.slides.map((slide) => slide.transition?.kind)).toEqual([undefined, 'push', 'push'])
    expect([checked('transition-push'), enabled('transition-effect'), enabled('transition-duration')]).toEqual([true, true, true])

    expect(item('transition-effect').submenu?.map((entry) => entry.label)).toEqual(['From Bottom', 'From Right', 'From Top', 'From Left'])
    expect(checked('effect-up')).toBe(true)
    item('effect-left').run()
    item('duration-1').run()
    expect(doc.presentation.slides[2].transition).toEqual({ kind: 'push', direction: 'left', duration: 1000 })
    expect([checked('effect-left'), checked('duration-1'), checked('duration-0.5')]).toEqual([true, true, false])

    item('transition-wipe').run()
    expect(doc.presentation.slides[2].transition).toEqual({ kind: 'wipe', direction: 'left', duration: 1000 })

    item('transition-all').run()
    expect(doc.presentation.transition).toBe('wipe')
    expect(doc.presentation.slides.every((slide) => slide.transition?.kind === 'wipe')).toBe(true)

    item('transition-split').run()
    expect(item('transition-effect').submenu?.map((entry) => entry.label)).toEqual(['Out', 'In', 'Horizontal', 'Vertical'])
    item('effect-vertical').run()
    expect(doc.presentation.slides[2].transition?.orientation).toBe('vertical')
  })

  it('present from the slide in front or from the start, and show the presenter view', () => {
    const doc = open()
    doc.goTo(doc.presentation.slides[1].id)

    item('present').run()
    item('present-start').run()
    expect(vi.mocked(present).mock.calls).toEqual([[false], [true]])
    expect(item('presenter-view').shortcut).toBe('mod+alt+p')

    item('presenter-view').run()
    expect(startPresenting).toHaveBeenCalledWith('deck', 1, { presenter: true })

    presenting('slides')
    expect([enabled('present'), enabled('presenter-view'), checked('presenter-view')]).toEqual([false, true, false])
    item('presenter-view').run()
    expect(showPresenterView).toHaveBeenLastCalledWith(true)

    presenting('split')
    expect(checked('presenter-view')).toBe(true)
    item('presenter-view').run()
    expect(showPresenterView).toHaveBeenLastCalledWith(false)
  })
})

describe('the master view’s commands', () => {
  it('put a logo on one layout and pick it there', async () => {
    const doc = open()
    doc.enterMaster('title-content')
    await insertLogo(new Blob(), { corner: 'bottom-left', layoutId: 'title-content' })
    const logo = layoutOf(masterOf(doc.presentation), 'title-content').elements.find((element) => element.kind === 'image')

    expect(logo).toMatchObject({ name: 'Logo', x: 24 })
    expect(doc.slideId).toBe(model.layoutSlideId('title-content'))
    expect(doc.selected).toEqual([logo?.id])
    expect(masterOf(doc.presentation).elements.some((element) => element.kind === 'image')).toBe(false)
  })
})
