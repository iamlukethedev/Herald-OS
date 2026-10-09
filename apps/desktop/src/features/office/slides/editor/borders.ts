import { atom } from 'nanostores'
import type { Stroke } from '../deck.ts'
import type { BorderSide, CellRef } from '../tables.ts'

/*
 * A table's borders as the Table menu and the formatting bar offer them: which lines of the cells
 * each choice draws, in the pen PowerPoint's table tools draw them with (a colour and a width).
 */

export const BORDER_CHOICES = ['all', 'outer', 'inner', 'top', 'bottom', 'left', 'right', 'none'] as const

export type BorderChoice = (typeof BORDER_CHOICES)[number]

export const BORDER_LABELS: Record<BorderChoice, string> = {
  all: 'All Borders',
  outer: 'Outside Borders',
  inner: 'Inside Borders',
  top: 'Top Border',
  bottom: 'Bottom Border',
  left: 'Left Border',
  right: 'Right Border',
  none: 'No Borders'
}

const SIDES: Record<BorderChoice, BorderSide[]> = { all: ['all'], outer: ['outer'], inner: ['inner'], top: ['top'], bottom: ['bottom'], left: ['left'], right: ['right'], none: ['all'] }

/** The pen borders are drawn with: a 1 point line in the text colour until the formatting bar picks another. */
export const $borderPen = atom<Stroke>({ color: 'tx1', width: 1, dash: 'solid' })

/** What a choice does to a table: the sides of the cell being typed into (else of every cell) it draws the pen's line on, or takes lines off. */
export function bordersFor(choice: BorderChoice, pen: Stroke, typing: CellRef | null): { cells: CellRef[] | 'all'; sides: BorderSide[]; stroke: Stroke | null } {
  return { cells: typing ? [typing] : 'all', sides: SIDES[choice], stroke: choice === 'none' ? null : { ...pen } }
}
