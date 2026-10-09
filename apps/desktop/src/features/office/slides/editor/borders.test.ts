import { describe, expect, it } from 'vitest'
import { findElement, findSlide, type TableElement } from '../deck.ts'
import * as model from '../model.ts'
import { $borderPen, BORDER_CHOICES, bordersFor } from './borders.ts'

const PEN = { color: 'accent2', width: 2.25, dash: 'solid' } as const

/** A 3 by 3 table on a blank slide, with a choice of borders put on it. */
function bordered(choice: (typeof BORDER_CHOICES)[number], typing: { row: number; column: number } | null = null): TableElement {
  const deck = model.addSlide(model.newDeck('Pitch'), { layout: 'blank' }).deck
  const slideId = deck.slides[1].id
  const added = model.addTable(deck, slideId, { rows: 3, columns: 3 })
  const { cells, sides, stroke } = bordersFor(choice, PEN, typing)
  const change = model.setCellBorders(added.deck, slideId, added.elementId, cells, sides, stroke)

  return findElement(findSlide(change.deck, slideId), added.elementId) as TableElement
}

describe('table borders', () => {
  it('draws in a 1 point line of the text colour until another pen is chosen', () => {
    expect($borderPen.get()).toEqual({ color: 'tx1', width: 1, dash: 'solid' })
  })

  it('puts each choice on the sides it names, of every cell when none is typed into', () => {
    expect(bordersFor('all', PEN, null)).toEqual({ cells: 'all', sides: ['all'], stroke: PEN })
    expect(bordersFor('outer', PEN, null).sides).toEqual(['outer'])
    expect(bordersFor('inner', PEN, null).sides).toEqual(['inner'])
    expect(BORDER_CHOICES.filter((choice) => choice !== 'all' && choice !== 'outer' && choice !== 'inner' && choice !== 'none').map((choice) => bordersFor(choice, PEN, null).sides)).toEqual([['top'], ['bottom'], ['left'], ['right']])
    expect(bordersFor('none', PEN, null)).toEqual({ cells: 'all', sides: ['all'], stroke: null })
  })

  it('outlines the whole table, or lines it inside only', () => {
    const outside = bordered('outer')

    expect(outside.cells[0][1].borders).toEqual({ top: PEN })
    expect(outside.cells[1][1].borders).toBeUndefined()
    expect(outside.cells[2][2].borders).toEqual({ right: PEN, bottom: PEN })

    const inside = bordered('inner')

    expect(inside.cells[0][0].borders).toEqual({ right: PEN, bottom: PEN })
    expect(inside.cells[1][1].borders).toEqual({ left: PEN, top: PEN, right: PEN, bottom: PEN })
  })

  it('borders only the cell being typed into, and takes every line away with No Borders', () => {
    const typed = bordered('bottom', { row: 1, column: 1 })

    expect(typed.cells[1][1].borders).toEqual({ bottom: PEN })
    expect(typed.cells[2][1].borders).toEqual({ top: PEN })
    expect(typed.cells[0][0].borders).toBeUndefined()

    const none = bordered('none')

    expect(none.cells[1][1].borders).toEqual({ left: null, top: null, right: null, bottom: null })
  })
})
