import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { type Deck, findSlide, type Slide, type TableElement } from '../deck.ts'
import * as model from '../model.ts'
import { settleSpans, tableElement, withCell } from '../tables.ts'
import { DEFAULT_THEME } from '../themes.ts'
import { SlideView } from './SlideView.tsx'

const { accent1, accent2, bg1 } = DEFAULT_THEME.colors

/** A slide holding one table, drawn for presenting. */
function drawTable(table: TableElement): string {
  const slide: Slide = { id: 'slide-table', layout: 'blank', background: null, elements: [table], notes: '', hidden: false }
  const deck: Deck = { id: 'deck-table', title: 'Table', size: { width: 960, height: 540 }, theme: DEFAULT_THEME, transition: 'none', slides: [slide] }

  return renderToStaticMarkup(createElement(SlideView, { deck, slide, scale: 1, mode: 'present' }))
}

/** The lines a cell draws, side by side, as their style attributes. */
function sides(html: string, row: number, column: number): Record<string, string> {
  const cell = html.split(`data-row="${row}" data-column="${column}"`)[1].split('class="hs-cell"')[0]

  return Object.fromEntries([...cell.matchAll(/<span class="hs-side" data-side="(\w+)" style="([^"]*)"><\/span>/g)].map((match) => [match[1], match[2]]))
}

describe('a table on a slide', () => {
  it('draws a grid of cells with their text, fills and lines, a merged cell spanning the cells it covers', () => {
    const start = model.newDeck('Plan')
    const slideId = start.slides[0].id
    const added = model.addTable(start, slideId, { rows: 2, columns: 3, cells: [['Name', 'Role', 'Team']] })
    const { deck } = model.updateElements(
      added.deck,
      slideId,
      [added.elementId],
      (element) => {
        if (element.kind !== 'table') {
          return element
        }

        const spanning = withCell(element, { row: 1, column: 1 }, (cell) => ({ ...cell, colSpan: 2 }))

        return { ...spanning, cells: settleSpans(spanning.cells, spanning.columns.length) }
      },
      'Merge'
    )
    const html = renderToStaticMarkup(createElement(SlideView, { deck, slide: findSlide(deck, slideId)!, scale: 1, mode: 'present' }))

    expect(html).toContain(`data-element-id="${added.elementId}"`)
    expect(html).toContain('grid-template-columns:240px 240px 240px')
    expect(html).toContain('grid-template-rows:minmax(29.2px, auto) minmax(29.2px, auto)')
    expect(html.match(/class="hs-cell"/g)).toHaveLength(5)
    expect(html).toContain('data-row="1" data-column="1" data-anchor="top" style="grid-row:2 / span 1;grid-column:2 / span 2')
    expect(html).not.toContain('data-row="1" data-column="2"')
    expect(html).toContain(`background-color:${accent1}`)
    expect(html).toContain(`<span class="hs-side" data-side="left" style="left:-0.5px;top:-0.5px;bottom:-0.5px;width:0;border-left:1px solid ${bg1}"></span>`)
    expect(html).toMatch(/<span[^>]*>Name<\/span>/)
  })

  it('draws the text editor in the cell being typed into, and the other cells as they are', () => {
    const start = model.newDeck('Plan')
    const slideId = start.slides[0].id
    const { deck, elementId } = model.addTable(start, slideId, { rows: 2, columns: 2, cells: [['a', 'b'], ['c', 'd']] })
    const editing = { id: elementId, cell: { row: 1, column: 0 }, render: () => createElement('i', { 'data-typing': '' }) }
    const html = renderToStaticMarkup(createElement(SlideView, { deck, slide: findSlide(deck, slideId)!, scale: 1, mode: 'edit', editing }))

    expect(html).toMatch(/data-row="1" data-column="0"[^>]*><i data-typing="">/)
    expect(html.match(/data-typing/g)).toHaveLength(1)
    expect(html).not.toMatch(/<span[^>]*>c<\/span>/)
    expect(html).toMatch(/<span[^>]*>d<\/span>/)
  })

  it('draws each cell’s own lines, the table’s where a cell says nothing and none where it has none, centred on its edges', () => {
    const table = withCell(tableElement({ x: 0, y: 0, width: 400, height: 200 }, 2, 2), { row: 1, column: 1 }, (cell) => ({
      ...cell,
      borders: { left: null, top: { color: 'accent2', width: 3, dash: 'dash' }, bottom: { color: '#000000', width: 2, dash: 'dot', alpha: 0.5 } }
    }))
    const html = drawTable(table)
    const own = sides(html, 1, 1)

    expect(own.left).toBeUndefined()
    expect(own.top).toBe(`top:-1.5px;left:-1.5px;right:-1.5px;height:0;border-top:3px dashed ${accent2}`)
    expect(own.bottom).toBe('bottom:-1px;left:-1px;right:-1px;height:0;border-bottom:2px dotted rgba(0, 0, 0, 0.500)')
    expect(own.right).toBe(`right:-0.5px;top:-0.5px;bottom:-0.5px;width:0;border-right:1px solid ${bg1}`)
    expect(Object.keys(sides(html, 0, 0)).sort()).toEqual(['bottom', 'left', 'right', 'top'])
  })

  it('draws no lines for a table without them, unless a cell has its own', () => {
    const bare = { ...tableElement({ x: 0, y: 0, width: 400, height: 200 }, 2, 2), stroke: null }
    const html = drawTable(withCell(bare, { row: 0, column: 0 }, (cell) => ({ ...cell, borders: { right: { color: 'tx1', width: 1, dash: 'solid' } } })))

    expect(html.match(/class="hs-side"/g)).toHaveLength(1)
    expect(Object.keys(sides(html, 0, 0))).toEqual(['right'])
  })
})
