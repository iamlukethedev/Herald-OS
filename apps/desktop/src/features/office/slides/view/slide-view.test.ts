import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Background, Deck, HeaderFooter, LineElement, Master, ObjectElement, Slide, SlideElement } from '../deck.ts'
import { lineElement, shapeElement, textElement } from '../elements.ts'
import { formatDate } from '../footers.ts'
import { defaultMaster } from '../layouts.ts'
import { DEFAULT_THEME, themeById } from '../themes.ts'
import { textBody } from '../text.ts'
import { gradientLine } from './paint.tsx'
import { SlideView, type SlideViewProps } from './SlideView.tsx'

const SIZE = { width: 960, height: 540 }

const { accent1, accent2, accent3 } = DEFAULT_THEME.colors

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

const slideOf = (id: string, layout: Slide['layout'], elements: SlideElement[], patch: Partial<Slide> = {}): Slide => ({ id, layout, background: null, elements, notes: '', hidden: false, ...patch })

const deckOf = (slides: Slide[], patch: Partial<Deck> = {}): Deck => ({ id: 'deck-view', title: 'View', size: SIZE, theme: DEFAULT_THEME, transition: 'none', slides, ...patch })

const draw = (props: Pick<SlideViewProps, 'deck' | 'slide'> & Partial<SlideViewProps>): string => renderToStaticMarkup(createElement(SlideView, { scale: 1, mode: 'present', ...props }))

/** Herald's master with a logo of its own and a band on the Title and Content layout. */
function brandedMaster(showMaster = true): Master {
  const base = defaultMaster(SIZE)
  const logo = shapeElement('ellipse', box(880, 20, 60, 60), { id: 'logo', fill: { color: 'accent2' } })
  const band = shapeElement('rect', box(0, 500, 960, 40), { id: 'band', fill: { color: '#123456' } })

  return { ...base, elements: [...base.elements, logo], layouts: base.layouts.map((layout) => (layout.id === 'title-content' ? { ...layout, elements: [...layout.elements, band], showMaster } : layout)) }
}

const own = shapeElement('star5', box(100, 100, 200, 200), { id: 'own', fill: { color: 'accent3' } })

describe('a slide on its master', () => {
  it('draws the master’s and the layout’s drawings behind the slide’s own, none of them to be picked', () => {
    const slide = slideOf('a', 'title-content', [own])
    const html = draw({ deck: deckOf([slide], { master: brandedMaster() }), slide, mode: 'edit' })

    expect(html.match(/data-decoration=""/g)).toHaveLength(2)
    expect(html).not.toContain('data-element-id="logo"')
    expect(html).not.toContain('data-element-id="band"')
    expect(html.indexOf(accent2)).toBeLessThan(html.indexOf('#123456'))
    expect(html.indexOf('#123456')).toBeLessThan(html.indexOf('data-element-id="own"'))
    expect(html).toMatch(/<div class="hs-el" data-decoration="" style="[^"]*pointer-events:none/)
    expect(html).not.toContain('Click to add')
  })

  it('leaves the master’s drawings off a layout that hides them, and everything inherited off when asked', () => {
    const slide = slideOf('a', 'title-content', [own])
    const hidden = draw({ deck: deckOf([slide], { master: brandedMaster(false) }), slide })
    const alone = draw({ deck: deckOf([slide], { master: { ...brandedMaster(), background: { kind: 'solid', color: 'accent1' } } }), slide, inherit: false })

    expect(hidden.match(/data-decoration=""/g)).toHaveLength(1)
    expect(hidden).not.toContain(accent2)
    expect(alone).not.toContain('data-decoration')
    expect(alone).toContain(`background-color:${DEFAULT_THEME.colors.bg1}`)
    expect(alone).toContain('data-element-id="own"')
  })

  it('draws elements given to show behind the slide under its own, not to be picked', () => {
    const slide = slideOf('a', 'blank', [own])
    const behind = [shapeElement('rect', box(0, 0, 960, 80), { id: 'header', fill: { color: '#abcdef' } })]
    const html = draw({ deck: deckOf([slide]), slide, behind, inherit: false, mode: 'edit' })

    expect(html).toContain('data-decoration="behind"')
    expect(html).not.toContain('data-element-id="header"')
    expect(html.indexOf('#abcdef')).toBeLessThan(html.indexOf('data-element-id="own"'))
  })

  it('shows the slide’s background, else its layout’s, else the master’s, gradients with their stops’ transparency', () => {
    const master: Master = {
      ...brandedMaster(),
      background: { kind: 'gradient', radial: true, angle: 0, stops: [{ at: 0, color: 'accent1' }, { at: 1, color: '#000000', alpha: 0.25 }] }
    }
    const solid: Background = { kind: 'solid', color: 'accent2' }
    const onLayout: Master = { ...master, layouts: master.layouts.map((layout) => (layout.id === 'section' ? { ...layout, background: solid } : layout)) }
    const plain = slideOf('a', 'title-content', [])
    const section = slideOf('b', 'section', [])
    const ownBackground = slideOf('c', 'section', [], { background: { kind: 'gradient', angle: 90, stops: [{ at: 0, color: 'accent3' }, { at: 1, color: 'bg1', alpha: 0.5 }] } })

    expect(draw({ deck: deckOf([plain], { master }), slide: plain })).toContain(`background-image:radial-gradient(ellipse farthest-corner at 50% 50%, ${accent1} 0%, rgba(0, 0, 0, 0.250) 100%)`)
    expect(draw({ deck: deckOf([section], { master: onLayout }), slide: section })).toContain(`background-color:${accent2}`)
    expect(draw({ deck: deckOf([ownBackground], { master: onLayout }), slide: ownBackground })).toContain(`linear-gradient(180deg, ${accent3} 0%, rgba(255, 255, 255, 0.500) 100%)`)
  })

  it('draws a slide in its own theme', () => {
    const midnight = themeById('midnight')!
    const slide = slideOf('a', 'blank', [own], { theme: midnight })
    const html = draw({ deck: deckOf([slide]), slide })

    expect(html).toContain(`background-color:${midnight.colors.bg1}`)
    expect(html).toContain(`fill="${midnight.colors.accent3}"`)
    expect(html).not.toContain(accent3)
  })
})

describe('footers on slides', () => {
  const settings: HeaderFooter = { date: true, dateFormat: 'datetime4', number: true, footer: true, footerText: 'Quarterly review', skipTitle: true }
  const title = slideOf('t', 'title', [])
  const content = slideOf('c', 'title-content', [own])
  const footer = (html: string, role: string) => html.split(`data-footer="${role}"`)[1]?.split('class="hs-el"')[0] ?? ''

  it('puts today’s date, the footer and the slide number where the master places them, in their look', () => {
    for (const mode of ['present', 'thumb', 'print', 'edit'] as const) {
      const html = draw({ deck: deckOf([title, content], { headerFooter: settings }), slide: content, mode })

      expect(footer(html, 'date'), mode).toContain(`>${formatDate('datetime4', new Date())}</span>`)
      expect(footer(html, 'footer'), mode).toContain('>Quarterly review</span>')
      expect(footer(html, 'number'), mode).toContain('>2</span>')
    }

    const html = draw({ deck: deckOf([title, content], { headerFooter: settings }), slide: content })

    expect(footer(html, 'number')).toMatch(/^ style="left:684px;top:498px;width:216px;height:26px;pointer-events:none"/)
    expect(footer(html, 'number')).toContain('text-align:right')
    expect(footer(html, 'footer')).toContain('text-align:center')
    expect(html.match(/<div class="hs-el" data-footer="\w+" style="/g)).toHaveLength(3)
    expect(html.indexOf('data-element-id="own"')).toBeLessThan(html.indexOf('data-footer'))
  })

  it('leaves them off a title slide when the settings say, and off a deck without settings', () => {
    expect(draw({ deck: deckOf([title, content], { headerFooter: settings }), slide: title })).not.toContain('data-footer')
    expect(draw({ deck: deckOf([title, content]), slide: content })).not.toContain('data-footer')
    expect(draw({ deck: deckOf([title, content], { headerFooter: { ...settings, dateText: 'Spring 2026' } }), slide: content })).toContain('>Spring 2026</span>')
  })

  it('numbers a slide by the index given where the deck has no slides, and leaves the number off where nothing says', () => {
    const deck = { size: SIZE, theme: DEFAULT_THEME, headerFooter: settings }
    const numbered = draw({ deck, slide: content, index: 4 })
    const unknown = draw({ deck, slide: content })

    expect(footer(numbered, 'number')).toContain('>5</span>')
    expect(unknown).not.toContain('data-footer="number"')
    expect(unknown).toContain('data-footer="date"')
  })

  it('leaves a footer to a slide that has its own placeholder for it', () => {
    const ownFooter = textElement(box(300, 490, 360, 30), textBody({ font: '+body', size: 12, color: 'tx2' }, { text: 'Our own footer' }), { id: 'own-footer', placeholder: { role: 'footer', prompt: 'Footer' } })
    const slide = slideOf('f', 'title-content', [ownFooter])
    const html = draw({ deck: deckOf([slide], { headerFooter: settings }), slide })

    expect(html).not.toContain('data-footer="footer"')
    expect(html).toContain('Our own footer')
    expect(html).toContain('data-footer="number"')
  })
})

describe('painting shapes', () => {
  const gradient = { angle: 90, stops: [{ at: 0, color: 'accent1' as const }, { at: 1, color: '#000000' as const, alpha: 0.5 }] }

  it('lays a gradient across the shape’s box, with an id of its own in each element and each slide view', () => {
    const first = shapeElement('rect', box(10, 10, 200, 100), { id: 'g1', fill: { color: 'accent1', gradient } })
    const second = textElement(box(300, 10, 200, 100), textBody({ font: '+body', size: 18, color: 'tx1' }, { text: 'Shaded' }), { id: 'g2', fill: { color: 'accent1', gradient: { ...gradient, angle: 0 } } })
    const slide = slideOf('a', 'blank', [first, second])
    const html = draw({ deck: deckOf([slide]), slide })
    const ids = [...html.matchAll(/<linearGradient id="([^"]+)" gradientUnits="userSpaceOnUse" x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)">/g)]

    expect(ids.map((match) => match.slice(2).map(Number))).toEqual([
      [100, 0, 100, 100],
      [0, 50, 200, 50]
    ])
    expect(ids[0][1]).not.toBe(ids[1][1])
    expect(html).toContain(`fill="url(#${ids[0][1]})"`)
    expect(html).toContain(`<stop offset="0" stop-color="${accent1}"></stop><stop offset="1" stop-color="#000000" stop-opacity="0.5"></stop>`)

    const twice = renderToStaticMarkup(createElement(Fragment, null, createElement(SlideView, { deck: deckOf([slide]), slide, scale: 1, mode: 'thumb' }), createElement(SlideView, { deck: deckOf([slide]), slide, scale: 1, mode: 'thumb' })))
    const all = [...twice.matchAll(/<linearGradient id="([^"]+)"/g)].map((match) => match[1])

    expect(new Set(all).size).toBe(4)
  })

  it('spreads a radial gradient from the middle to the corners', () => {
    const slide = slideOf('a', 'blank', [shapeElement('ellipse', box(0, 0, 200, 100), { id: 'r', fill: { color: 'accent1', gradient: { ...gradient, radial: true } } })])
    const html = draw({ deck: deckOf([slide]), slide })

    expect(html).toMatch(/<radialGradient id="[^"]+" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate\(100 50\) scale\(141\.42\d* 70\.71\d*\)">/)
  })

  it('runs a gradient’s line through the box so its end colours reach the corners', () => {
    expect(gradientLine(0, 200, 100)).toEqual({ x1: 0, y1: 50, x2: 200, y2: 50 })
    expect(gradientLine(45, 200, 100)).toEqual({ x1: 25, y1: -25, x2: 175, y2: 125 })
    expect(gradientLine(180, 200, 100)).toEqual({ x1: 200, y1: 50, x2: 0, y2: 50 })
  })

  it('shades the parts PowerPoint shades, and cuts holes by the even-odd rule', () => {
    const can = shapeElement('can', box(0, 0, 100, 200), { id: 'can', fill: { color: 'accent1', alpha: 0.5 } })
    const donut = shapeElement('donut', box(200, 0, 100, 100), { id: 'donut' })
    const slide = slideOf('a', 'blank', [can, donut])
    const html = draw({ deck: deckOf([slide]), slide })

    expect(html).toContain('fill="#ffffff" fill-opacity="0.2"')
    expect(html).toContain('fill-rule="evenodd"')
    expect(html.match(/<path [^>]*stroke="none"/g)!.length).toBeGreaterThan(2)
  })

  it('draws a freeform’s paths stretched over its box, outlined and filled as each says, with its text in the whole box', () => {
    const freeform = shapeElement('ellipse', box(0, 0, 200, 100), {
      id: 'free',
      stroke: { color: 'tx1', width: 2, dash: 'solid' },
      paths: [
        { width: 10, height: 10, d: 'M0,0 L10,0 L10,10 Z' },
        { width: 10, height: 10, d: 'M0,10 L10,0', fill: false }
      ],
      body: textBody({ font: '+body', size: 18, color: 'bg1' }, { text: 'Freeform', anchor: 'middle' })
    })
    const slide = slideOf('a', 'blank', [freeform])
    const html = draw({ deck: deckOf([slide]), slide })

    expect(html).toMatch(/<path d="M0 0 L200 0 L200 100 Z" fill="#[0-9a-f]{6}" fill-rule="evenodd" stroke="#[0-9a-f]{6}"/)
    expect(html).toMatch(/<path d="M0 100 L200 0" fill="none" fill-rule="evenodd" stroke="#[0-9a-f]{6}"/)
    expect(html).toMatch(/class="hs-text" data-anchor="middle" style="left:7.2px;top:3.6px;width:185.6\d*px;height:92.8\d*px"/)
  })
})

describe('connectors and kept objects', () => {
  it('draws a connector’s preset mirrored as it is flipped, its heads along its end segments', () => {
    const connector: LineElement = { ...lineElement([0, 0], [200, 100], { id: 'c', end: 'triangle' }), flipH: true, connector: { preset: 'bentConnector3' } }
    const slide = slideOf('a', 'blank', [connector])
    const edited = draw({ deck: deckOf([slide]), slide, mode: 'edit' })

    expect(edited).toContain('<g transform="matrix(-1 0 0 1 200 0)">')
    expect(edited).toContain('d="M0,0 L100,0 L100,100 L200,100" fill="none" stroke="transparent"')
    expect(edited).toContain('d="M0,0 L100,0 L100,100 L195.2,100" fill="none" stroke=')
    expect(edited).toContain('d="M200,100 L194,103 L194,97 Z"')
    expect(draw({ deck: deckOf([slide], { master: { ...defaultMaster(SIZE), elements: [connector] } }), slide: slideOf('b', 'blank', []), mode: 'edit' })).not.toContain('stroke="transparent"')
  })

  const kept = (patch: Partial<ObjectElement>): ObjectElement => ({
    id: 'obj',
    kind: 'object',
    object: 'chart',
    ...box(100, 100, 400, 200),
    rotation: 0,
    source: { xml: '<p:graphicFrame/>', parts: [] },
    ...patch
  })

  it('shows a kept object’s picture stretched to its box', () => {
    const slide = slideOf('a', 'blank', [kept({ preview: { src: 'data:image/png;base64,AAAA', natural: { width: 10, height: 5 } } })])
    const html = draw({ deck: deckOf([slide]), slide })

    expect(html).toContain('data-element-id="obj"')
    expect(html).toContain('<img src="data:image/png;base64,AAAA" alt="Chart" draggable="false" style="left:0;top:0;width:400px;height:200px"/>')
  })

  it('draws a kept object’s drawing from its top left, stretched from the box it was laid out in, none of it to be picked', () => {
    const part = shapeElement('rect', box(10, 10, 100, 50), { id: 'part', fill: { color: 'accent2' } })
    const slide = slideOf('a', 'blank', [kept({ object: 'diagram', shapes: [part], drawnIn: { width: 200, height: 100 } })])
    const html = draw({ deck: deckOf([slide]), slide, mode: 'edit' })

    expect(html).toContain('<div class="hs-kept-drawing" style="width:200px;height:100px;transform:scale(2, 2)">')
    expect(html).toContain(`<div class="hs-el" data-kept="" style="left:10px;top:10px;width:100px;height:50px;pointer-events:none">`)
    expect(html).not.toContain('data-element-id="part"')
    expect(html).toContain(`fill="${accent2}"`)
  })

  it('shows a quiet box saying what a kept object is where the file has no picture or drawing for it', () => {
    for (const [object, label, icon] of [
      ['chart', 'Chart', 'chart-bar'],
      ['diagram', 'SmartArt', 'sitemap'],
      ['ole', 'Embedded object', 'package'],
      ['media', 'Media', 'movie']
    ] as const) {
      const slide = slideOf('a', 'blank', [kept({ object })])
      const html = draw({ deck: deckOf([slide]), slide })

      expect(html).toContain(`<span>${label} (kept from the file)</span>`)
      expect(html).toContain(`tabler-icon-${icon}`)
    }
  })
})
