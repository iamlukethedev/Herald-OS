import { type Background, type Deck, DeckHistory, type Fill, findElement, findSlide, type LayoutId, type Master, type Slide, type SlideElement, type SlideSize } from './deck.ts'
import { coverCrop, imageElement, shapeElement } from './elements.ts'
import { layoutOf, masterOf } from './layouts.ts'
import { applyMasterDeck, layoutSlideId, MASTER_SLIDE_ID, masterDeck, slideLayoutId } from './masters.ts'
import type { DeckChange } from './model.ts'
import type { CellRef } from './tables.ts'

/*
 * One open deck in the editor: its history, the slide in front, the slides picked in the list, what
 * is selected on the slide and what is being typed into. A drag shows its deck as a preview and
 * becomes one step when it ends; every other change is a step as it happens. In the master view the
 * master and its layouts are the slides of a deck of their own (`masterDeck`): edits start from that
 * deck, and each change of it goes back into the deck's master as one step of the deck's history.
 */

/** How the slide view draws a slide beyond its own content. */
export interface ViewOptions {
  inherit?: boolean
  behind?: readonly SlideElement[]
}

const AS_IS: ViewOptions = {}

const ON_ITS_OWN: ViewOptions = { inherit: false }

/** The masters of the decks the master view made; no deck of slides has one of them. */
const viewMasters = new WeakSet<Master>()

/** Whether a slide id names the master's own slide or a layout's in the master's deck. */
export const isMasterSlideId = (id: string): boolean => id === MASTER_SLIDE_ID || slideLayoutId(id) !== null

const hasMasterSlides = (deck: Deck): boolean => deck.slides.some((slide) => isMasterSlideId(slide.id))

/** The master's background as a picture or a box over the whole slide, for a layout without a background of its own. */
function backdrop(background: Background, size: SlideSize): SlideElement {
  const box = { x: 0, y: 0, width: size.width, height: size.height }

  if (background.kind === 'image') {
    const crop = coverCrop(background.natural, box)

    return imageElement(background.src, background.natural, box, { id: 'master-background', name: 'Background', ...(crop ? { crop } : {}) })
  }

  const fill: Fill =
    background.kind === 'solid' ? { color: background.color } : { color: background.stops[0]?.color ?? 'bg1', gradient: { stops: background.stops, angle: background.angle, ...(background.radial ? { radial: true } : {}) } }

  return shapeElement('rect', box, { id: 'master-background', name: 'Background', fill })
}

export class SlidesDocument {
  /** The deck's own history, whichever view is in front. */
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
  /** Where the slides view was when the master view opened: the slide in front, its place and the picked slides. */
  private away: { slideId: string; index: number; picked: string[] } | null = null
  /** The master's deck as last made, and the deck it was made from. */
  private made: { from: Deck; deck: Deck } | null = null
  /** What was last drawn behind a layout, by whether it shows the master's drawings and background. */
  private readonly drawnBehind = new Map<string, { elements: readonly SlideElement[]; background: Background | null; size: SlideSize; options: ViewOptions }>()

  constructor(
    deck: Deck,
    private readonly onEdit: () => void
  ) {
    this.history = new DeckHistory(deck)
    this.slideId = deck.slides[0]?.id ?? ''
    this.picked = [this.slideId]
  }

  /** The deck edits start from: the deck itself, or in the master view the master's deck. */
  get base(): Deck {
    return this.mode === 'master' ? this.masterDeck : this.history.present
  }

  /** The deck itself as it stands, whichever view is in front: what is saved and presented. */
  get presentation(): Deck {
    return this.history.present
  }

  /** The master's deck for the deck as it stands; the same deck while the deck is. */
  private get masterDeck(): Deck {
    const from = this.history.present

    if (this.made?.from !== from) {
      const deck = masterDeck(from)

      if (deck.master) {
        viewMasters.add(deck.master)
      }

      this.made = { from, deck }
    }

    return this.made.deck
  }

  /** Whether a deck is the master view's or made from it: its master is one the view made, or its slides are the master's and layouts' as the deck's own are not. */
  private ofMasterView(deck: Deck): boolean {
    return (deck.master !== undefined && viewMasters.has(deck.master)) || (hasMasterSlides(deck) && !hasMasterSlides(this.history.present))
  }

  /** The deck with an edit of the master's deck in its master. Only backgrounds and drawings go in: a master's slide put on another layout, or the whole of it resized, says nothing of the master. */
  private intoMaster(edited: Deck): Deck {
    const deck = this.history.present

    if (edited.size.width !== deck.size.width || edited.size.height !== deck.size.height) {
      return deck
    }

    const kept = edited.slides.filter((slide) => slide.layout === (slideLayoutId(slide.id) ?? 'blank'))

    return applyMasterDeck(deck, kept.length === edited.slides.length ? edited : { ...edited, slides: kept })
  }

  get deck(): Deck {
    return this.preview ?? this.base
  }

  get slide(): Slide {
    return findSlide(this.deck, this.slideId) ?? this.deck.slides[0]
  }

  /** How a slide of `deck` is drawn beyond its own content: in the master view, a layout over the master's background and drawings. */
  viewOptions(slide: Slide): ViewOptions {
    if (this.mode !== 'master' || !slide) {
      return AS_IS
    }

    const layout = slideLayoutId(slide.id)
    const master = layout ? findSlide(this.deck, MASTER_SLIDE_ID) : undefined

    if (!layout || !master) {
      return ON_ITS_OWN
    }

    const shows = layoutOf(masterOf(this.history.present), layout).showMaster
    const background = slide.background ? null : master.background
    const size = this.deck.size
    const key = `${shows}:${background ? 'master' : 'own'}`
    const known = this.drawnBehind.get(key)

    if (known && known.elements === master.elements && known.background === background && known.size === size) {
      return known.options
    }

    const behind = [...(background ? [backdrop(background, size)] : []), ...(shows ? master.elements.filter((element) => !element.placeholder) : [])]
    const options = behind.length ? { inherit: false, behind } : ON_ITS_OWN
    this.drawnBehind.set(key, { elements: master.elements, background, size, options })

    return options
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

  /** Record a change as one step and go where it says; a change of the master's deck goes into the deck's master. */
  commit(change: DeckChange): void {
    this.preview = null
    const ofMaster = this.ofMasterView(change.deck)
    this.history.commit(ofMaster ? this.intoMaster(change.deck) : change.deck, change.label, change.join)
    const { slideId, selected } = change.focus ?? {}
    // A change of the deck's own slides made from the master view goes to its slide on the way back.
    const away = this.mode === 'master' && (slideId ? !isMasterSlideId(slideId) : !ofMaster)

    if (away && slideId) {
      this.away = { slideId, index: this.away?.index ?? 0, picked: [slideId] }
    } else if (!away && slideId && slideId !== this.slideId) {
      this.slideId = slideId
      this.picked = [slideId]
      this.editing = null
    }

    if (!away && selected) {
      this.selected = [...selected]
    }

    this.settle()
    this.changed()
    this.onEdit()
  }

  show(preview: Deck | null): void {
    // A preview made in the other view (a drag under way as the view changed) is dropped.
    if (preview && this.ofMasterView(preview) !== (this.mode === 'master')) {
      return
    }

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

  /** Open the master view with the layout of the slide in front in front (or the master, or another layout). */
  enterMaster(at?: 'master' | LayoutId): void {
    if (this.mode === 'master') {
      if (at) {
        this.goTo(at === 'master' ? MASTER_SLIDE_ID : layoutSlideId(at))
      }

      return
    }

    const layout = at ?? this.slide.layout
    this.away = { slideId: this.slideId, index: this.index, picked: [...this.picked] }
    this.mode = 'master'
    this.preview = null
    this.editing = null
    this.selected = []
    this.slideId = layout === 'master' ? MASTER_SLIDE_ID : layoutSlideId(layout)
    this.picked = [this.slideId]
    this.settle()
    this.changed()
  }

  /** Close the master view and go back to the slide that was in front (or one in its place). */
  exitMaster(): void {
    if (this.mode !== 'master') {
      return
    }

    const away = this.away
    this.mode = 'slides'
    this.away = null
    this.preview = null
    this.editing = null
    this.selected = []
    const slides = this.deck.slides
    this.slideId = away && findSlide(this.deck, away.slideId) ? away.slideId : slides[Math.min(away?.index ?? 0, slides.length - 1)].id
    this.picked = away?.picked ?? [this.slideId]
    this.settle()
    this.changed()
  }

  /** Bring a slide to the front; `extend` adds it to the picked slides (or takes it out again). The master view picks one at a time. */
  goTo(slideId: string, extend = false): void {
    if (!findSlide(this.deck, slideId)) {
      return
    }

    if (extend && this.mode === 'slides') {
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
