import type { SectionKind } from '../../../../../shared/office/document.ts'

/*
 * Where Herald Docs' pages end, worked out on the text as it lies in one long column: each box's
 * top and bottom in CSS pixels from the top of the text. A page takes boxes while they fit. One
 * that does not fit splits where it may, between lines (two lines of a paragraph kept on each
 * side), between table rows, or between the items and blocks of a list or a box; otherwise it
 * starts the next page and takes the headings before it along. Page and section breaks start
 * pages, and footnotes take room at the foot of the page their reference is on. A box taller than
 * a page stays on its page and runs past its end.
 */

/** How a page that starts at a box is made: a spacer before a block, in a paragraph before a line, or before a table row. */
export type BreakKind = 'block' | 'line' | 'row'

/** A page or section break before a box: the section that starts there, and how it starts. */
export interface Force {
  kind: SectionKind | 'page'
  section: number
}

export interface FlowBox<R> {
  /** A block's border box, a line's box or a row's, in the column as it lies without pages. */
  top: number
  bottom: number
  kind: BreakKind
  /** What finds the box again: its place in the document. */
  ref: R
  /** Headings: they go to the next page with what follows them. */
  keepWithNext?: boolean
  /** Never split across pages. */
  keepTogether?: boolean
  force?: Force
  /** The footnotes referred to in the box, by number. */
  notes?: readonly number[]
  /** What the box splits into: lines (two kept on each side), table rows, or blocks that may split again. */
  split?: 'lines' | 'rows' | 'blocks'
  parts?: () => readonly FlowBox<R>[]
}

export interface LayoutOptions {
  /** The height page `number` (from 1) of section `section` gives text, before its footnotes. */
  room: (number: number, section: number) => number
  noteHeight: (note: number) => number
  /** The rule and space above a page's footnotes. */
  noteRule: number
}

export interface Page<R> {
  /** The box it starts at: null for the first page and for a blank one. */
  ref: R | null
  kind: BreakKind | 'first' | 'blank'
  /** Where its text starts in the column, and where what comes before it ends (a block that starts a page is lined up after it). */
  top: number
  before: number
  section: number
  notes: number[]
  /** Where its text ends, and how far that is past its room. */
  end: number
  overflow: number
}

/** How far measurements may be off, in pixels. */
const SLACK = 0.5

interface Mark<R> {
  page: Page<R>
  notes: number
  noteSum: number
  end: number
  overflow: number
  empty: boolean
}

class Pager<R> {
  readonly pages: Page<R>[] = []
  private page!: Page<R>
  private room = 0
  private noteSum = 0
  private empty = true
  private section = 0

  constructor(private readonly options: LayoutOptions) {
    this.open(null, 'first', 0, 0)
  }

  private open(ref: R | null, kind: Page<R>['kind'], top: number, before: number): void {
    this.page = { ref, kind, top, before, section: this.section, notes: [], end: top, overflow: 0 }
    this.pages.push(this.page)
    this.room = this.options.room(this.pages.length, this.section)
    this.noteSum = 0
    this.empty = true
  }

  /** The height of the page's footnotes with `extra` added. */
  private notesArea(extra: readonly number[] = []): number {
    if (!this.page.notes.length && !extra.length) {
      return 0
    }

    return this.options.noteRule + this.noteSum + extra.reduce((sum, note) => sum + this.options.noteHeight(note), 0)
  }

  private fits(box: FlowBox<R>): boolean {
    return box.bottom - this.page.top + this.notesArea(box.notes) <= this.room + SLACK
  }

  private place(box: FlowBox<R>): void {
    for (const note of box.notes ?? []) {
      this.page.notes.push(note)
      this.noteSum += this.options.noteHeight(note)
    }

    this.page.end = Math.max(this.page.end, box.bottom)
    this.page.overflow = Math.max(this.page.overflow, box.bottom - this.page.top + this.notesArea() - this.room)
    this.empty = false
  }

  private mark(): Mark<R> {
    return { page: this.page, notes: this.page.notes.length, noteSum: this.noteSum, end: this.page.end, overflow: this.page.overflow, empty: this.empty }
  }

  /** Back to a mark on the current page. */
  private restore(mark: Mark<R>): void {
    this.page.notes.length = mark.notes
    this.noteSum = mark.noteSum
    this.page.end = mark.end
    this.page.overflow = mark.overflow
    this.empty = mark.empty
  }

  private breakBefore(box: FlowBox<R>, before: FlowBox<R> | undefined): void {
    this.open(box.ref, box.kind, box.top, before ? before.bottom : box.top)
  }

  private force(box: FlowBox<R>, before: FlowBox<R> | undefined): void {
    const { kind, section } = box.force!

    // A continuous section goes on on this page; the pages after it are the section's.
    if (kind === 'continuous') {
      this.section = section

      return
    }

    const parity = kind === 'evenPage' ? 0 : kind === 'oddPage' ? 1 : -1

    if (parity >= 0 && (this.pages.length + 1) % 2 !== parity) {
      this.open(null, 'blank', box.top, before ? before.bottom : box.top)
    }

    if (kind !== 'page') {
      this.section = section
    }

    this.breakBefore(box, before)
  }

  /** Lays out blocks from the current page on; false when the first has to go to the next page, with what holds it. */
  blocks(list: readonly FlowBox<R>[], top: boolean): boolean {
    const marks: Mark<R>[] = []

    for (let i = 0; i < list.length; i++) {
      const box = list[i]

      if (box.force && !marks[i]) {
        this.force(box, list[i - 1])
      }

      marks[i] = this.mark()

      if (this.fits(box)) {
        this.place(box)
        continue
      }

      if (box.parts && !box.keepTogether) {
        const parts = box.parts()

        if (box.split === 'blocks' ? this.blocks(parts, false) : this.leaves(parts, box.split === 'lines' ? 2 : 1)) {
          continue
        }
      } else if (this.empty) {
        this.place(box)
        continue
      }

      let at = i

      while (at > 0 && list[at - 1].keepWithNext && marks[at - 1].page === this.page && !marks[at - 1].empty) {
        at--
      }

      if (at === 0 && !top) {
        this.restore(marks[0])

        return false
      }

      this.restore(marks[at])
      this.breakBefore(list[at], list[at - 1])
      i = at - 1
    }

    return true
  }

  /** How many parts from `from` on fit on the current page, with their footnotes. */
  private fitCount(parts: readonly FlowBox<R>[], from: number): number {
    let count = this.page.notes.length
    let sum = this.noteSum
    let k = from

    for (; k < parts.length; k++) {
      const part = parts[k]
      const add = (part.notes ?? []).reduce((total, note) => total + this.options.noteHeight(note), 0)
      const notes = count + (part.notes?.length ?? 0)

      if (part.bottom - this.page.top + (notes ? this.options.noteRule + sum + add : 0) > this.room + SLACK) {
        break
      }

      count = notes
      sum += add
    }

    return k - from
  }

  /** Lays out lines or rows, at least `min` on each side of a page end; false when the first `min` do not fit after what is on the page. */
  private leaves(parts: readonly FlowBox<R>[], min: number): boolean {
    let start = 0

    for (;;) {
      const fit = this.fitCount(parts, start)
      let at = start + fit

      if (at < parts.length) {
        at = Math.min(at, parts.length - min)

        if (start === 0 && !this.empty && at < min) {
          return false
        }

        // A page holds at least one part, even one taller than it.
        if (at <= start) {
          at = start + Math.max(1, fit)
        }
      }

      if (at >= parts.length) {
        for (let k = start; k < parts.length; k++) {
          this.place(parts[k])
        }

        return true
      }

      for (let k = start; k < at; k++) {
        this.place(parts[k])
      }

      this.breakBefore(parts[at], parts[at - 1])
      start = at
    }
  }
}

/** The pages a column of boxes takes. */
export function paginate<R>(boxes: readonly FlowBox<R>[], options: LayoutOptions): Page<R>[] {
  const pager = new Pager<R>(options)
  pager.blocks(boxes, true)

  return pager.pages
}
