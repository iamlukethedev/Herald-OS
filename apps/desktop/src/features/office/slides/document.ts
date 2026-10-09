import { type Deck, DeckHistory, findElement, findSlide, type Slide, type SlideElement } from './deck.ts'
import type { DeckChange } from './model.ts'
import type { CellRef } from './tables.ts'

/*
 * One open deck in the editor: its history, the slide in front, the slides picked in the list, what
 * is selected on the slide and what is being typed into. A drag shows its deck as a preview and
 * becomes one step when it ends; every other change is a step as it happens.
 */
export class SlidesDocument {
  readonly history: DeckHistory
  slideId: string
  /** Slides picked in the slide list, the one in front among them. */
  picked: string[]
  /** Elements selected on the slide in front, in the order they were picked. */
  selected: string[] = []
  /** The element whose text is being edited. */
  editing: string | null = null
  /** The table cell typed into last, and its table. */
  private lastCell: { tableId: string; cell: CellRef } | null = null
  /** A deck shown while a drag is under way, not yet a step. */
  preview: Deck | null = null
  /** How big the slide is shown: fitted to the window, or CSS pixels a point. */
  zoom: 'fit' | number = 'fit'
  /** What is edited: the deck's slides, or its master and layouts as the slides of a deck of their own. */
  mode: 'slides' | 'master' = 'slides'
  revision = 0
  private readonly listeners = new Set<() => void>()

  constructor(
    deck: Deck,
    private readonly onEdit: () => void
  ) {
    this.history = new DeckHistory(deck)
    this.slideId = deck.slides[0]?.id ?? ''
    this.picked = [this.slideId]
  }

  get deck(): Deck {
    return this.preview ?? this.history.present
  }

  get slide(): Slide {
    return findSlide(this.deck, this.slideId) ?? this.deck.slides[0]
  }

  /** How a slide of `deck` is drawn beyond its own content: in the master view, a layout over the master's drawings. */
  viewOptions(slide: Slide): { inherit?: boolean; behind?: readonly SlideElement[] } {
    return this.mode === 'master' && slide ? { inherit: false } : {}
  }

  get index(): number {
    return Math.max(0, this.deck.slides.findIndex((slide) => slide.id === this.slide.id))
  }

  /** The selected elements as they are now, in the slide's order. */
  get selection(): SlideElement[] {
    const ids = new Set(this.selected)

    return this.slide.elements.filter((element) => ids.has(element.id))
  }

  /** The cell of the selected table being typed into, or typed into last while the table stayed selected. */
  get cell(): CellRef | null {
    const table = this.selected.length === 1 ? findElement(this.slide, this.selected[0]) : undefined
    const last = this.lastCell

    if (table?.kind !== 'table' || last?.tableId !== table.id) {
      return null
    }

    const cell = table.cells[last.cell.row]?.[last.cell.column]

    return cell && !cell.merged ? last.cell : null
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    this.revision++
    this.listeners.forEach((listener) => listener())
  }

  /** Keep the slide in front, the picked slides and the selection pointing at things that exist. */
  private settle(): void {
    if (!findSlide(this.deck, this.slideId)) {
      this.slideId = this.deck.slides[Math.min(this.index, this.deck.slides.length - 1)]?.id ?? this.deck.slides[0].id
    }

    const slides = new Set(this.deck.slides.map((slide) => slide.id))
    this.picked = this.picked.filter((id) => slides.has(id))

    if (!this.picked.includes(this.slideId)) {
      this.picked = [this.slideId]
    }

    const ids = new Set(this.slide.elements.map((element) => element.id))
    this.selected = this.selected.filter((id) => ids.has(id))

    // Typing goes on only in an element that is still there and still the one selected (in a table, in a cell still there).
    if (this.editing && (!ids.has(this.editing) || !this.selected.includes(this.editing) || (findElement(this.slide, this.editing)?.kind === 'table' && !this.cell))) {
      this.editing = null
    }
  }

  /** Record a change as one step and go where it says. */
  commit(change: DeckChange): void {
    this.preview = null
    this.history.commit(change.deck, change.label, change.join)

    if (change.focus?.slideId && change.focus.slideId !== this.slideId) {
      this.slideId = change.focus.slideId
      this.picked = [change.focus.slideId]
      this.editing = null
    }

    if (change.focus?.selected) {
      this.selected = [...change.focus.selected]
    }

    this.settle()
    this.changed()
    this.onEdit()
  }

  show(preview: Deck | null): void {
    this.preview = preview
    this.changed()
  }

  /** Start over from a deck loaded from disk. */
  reset(deck: Deck): void {
    this.preview = null
    this.editing = null
    this.history.reset(deck)
    this.settle()
    this.changed()
  }

  undo(): string | null {
    const label = this.history.undo()
    this.editing = null
    this.settle()
    this.changed()

    if (label) {
      this.onEdit()
    }

    return label
  }

  redo(): string | null {
    const label = this.history.redo()
    this.editing = null
    this.settle()
    this.changed()

    if (label) {
      this.onEdit()
    }

    return label
  }

  /** Bring a slide to the front; `extend` adds it to the picked slides (or takes it out again). */
  goTo(slideId: string, extend = false): void {
    if (!findSlide(this.deck, slideId)) {
      return
    }

    if (extend) {
      this.picked = this.picked.includes(slideId) && this.picked.length > 1 ? this.picked.filter((id) => id !== slideId) : [...new Set([...this.picked, slideId])]
      this.slideId = this.picked.includes(slideId) ? slideId : this.picked[this.picked.length - 1]
    } else {
      this.picked = [slideId]
      this.slideId = slideId
    }

    this.selected = []
    this.editing = null
    this.changed()
  }

  /** The picked slides in the deck's order. */
  get pickedSlides(): string[] {
    const ids = new Set(this.picked)

    return this.deck.slides.filter((slide) => ids.has(slide.id)).map((slide) => slide.id)
  }

  select(ids: readonly string[]): void {
    this.selected = [...ids]
    this.editing = null
    this.changed()
  }

  setZoom(zoom: 'fit' | number): void {
    this.zoom = zoom === 'fit' ? 'fit' : Math.max(0.1, Math.min(8, zoom))
    this.changed()
  }

  /** Start or stop typing into an element (which is then the selection); a table is typed into at its last cell, or its first. */
  edit(elementId: string | null): void {
    this.editing = elementId

    if (elementId) {
      this.selected = [elementId]

      if (findElement(this.slide, elementId)?.kind === 'table' && !this.cell) {
        this.lastCell = { tableId: elementId, cell: { row: 0, column: 0 } }
      }
    }

    this.changed()
  }

  /** Make a cell of a table the one commands act on (`typing` starts typing into it). */
  goToCell(tableId: string, cell: CellRef, typing = false): void {
    this.lastCell = { tableId, cell: { row: cell.row, column: cell.column } }

    if (typing) {
      this.edit(tableId)
    } else {
      this.changed()
    }
  }
}
