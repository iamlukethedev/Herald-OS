import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Box, Deck, SlideElement } from '../deck.ts'
import { findElement, findSlide, withElements } from '../deck.ts'
import type { SlidesDocument } from '../document.ts'
import { boundsOf, boundsOfAll, center, moveElement, type Point, withBox, withEnds } from '../elements.ts'
import { isEmptyPlaceholder } from '../layouts.ts'
import * as model from '../model.ts'
import { slidesSession } from '../store.ts'
import type { CellRef } from '../tables.ts'
import { type EditingSlot, SlideView } from '../view/SlideView.tsx'
import { requestEditStart, textSessionOf } from './active.ts'
import * as commands from './commands.ts'
import { type GuideLine, type Handle, marqueeHits, moveLineEnd, moveWithSnapping, resizeBox, rotationFor, scaleGroup, snapLines, snapResize, spanBox } from './gestures.ts'
import { Overlay } from './Overlay.tsx'
import { selectWordAt, TextEditor } from './TextEditor.tsx'

/*
 * The slide being edited: shown fitted to the window or at a zoom, with everything done to it by
 * pointer and keyboard. A drag shows its result as the document's preview and becomes one step when
 * the pointer lets go; a click on a selected text box, or on a cell of a selected table, starts
 * typing where it was clicked.
 */

export function useDeck(doc: SlidesDocument | undefined): number {
  return useSyncExternalStore(
    (listener) => (doc ? doc.subscribe(listener) : () => {}),
    () => doc?.revision ?? -1
  )
}

/** Room around the slide, in screen pixels. */
const PAD = 36
/** How near a line has to be to pull a dragged edge onto it, in screen pixels. */
const SNAP = 6

type Gesture =
  | { kind: 'press'; id: string; wasSelected: boolean; start: Point; client: Point; duplicate: boolean; cell: CellRef | null }
  | { kind: 'move'; base: Deck; ids: string[]; bounds: Box; start: Point; label: string; lines: ReturnType<typeof snapLines>; others: Box[] }
  | { kind: 'resize'; base: Deck; ids: string[]; handle: Handle; start: Point; box: Box; rotation: number; ratio: boolean; lines: ReturnType<typeof snapLines> }
  | { kind: 'rotate'; base: Deck; id: string; middle: Point; start: Point; rotation: number }
  | { kind: 'line'; base: Deck; id: string; end: 'from' | 'to' }
  | { kind: 'marquee'; start: Point; initial: string[] }

export const isTyping = (target: EventTarget | null): boolean => target instanceof Element && Boolean(target.closest('.ProseMirror, input, textarea, select, [contenteditable="true"]'))

const isTextual = (element: SlideElement | undefined): element is SlideElement & { kind: 'text' | 'shape' } => element?.kind === 'text' || element?.kind === 'shape'

/** The table cell drawn under an event's target. */
function cellAt(target: EventTarget | null): CellRef | null {
  const cell = target instanceof Element ? target.closest('[data-row][data-column]') : null

  return cell ? { row: Number(cell.getAttribute('data-row')), column: Number(cell.getAttribute('data-column')) } : null
}

export function Stage({ doc, onContextMenu }: { doc: SlidesDocument; onContextMenu?: (at: { x: number; y: number }) => void }) {
  useDeck(doc)
  const scroller = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const [area, setArea] = useState({ width: 0, height: 0 })
  const [guides, setGuides] = useState<GuideLine[]>([])
  const [marquee, setMarquee] = useState<Box | null>(null)
  const deck = doc.deck
  const slide = doc.slide
  const fit = area.width ? Math.max(0.05, Math.min((area.width - PAD * 2) / deck.size.width, (area.height - PAD * 2) / deck.size.height)) : 0
  const scale = doc.zoom === 'fit' ? fit : doc.zoom
  const width = deck.size.width * scale
  const height = deck.size.height * scale
  const contentWidth = Math.max(area.width, width + PAD * 2)
  const contentHeight = Math.max(area.height, height + PAD * 2)
  stageScales.set(doc, { scale, fit })

  useLayoutEffect(() => {
    const element = scroller.current

    if (!element) {
      return
    }

    const measure = () => setArea({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  // Pinching or ⌘-scrolling zooms about the pointer; the listener is native to be allowed to stop the page's own zoom.
  useEffect(() => {
    const element = scroller.current

    if (!element) {
      return
    }

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return
      }

      event.preventDefault()
      const now = stageScales.get(doc)?.scale ?? 1
      doc.setZoom(now * Math.exp(-event.deltaY * 0.01))
    }
    element.addEventListener('wheel', onWheel, { passive: false })

    return () => element.removeEventListener('wheel', onWheel)
  }, [doc])

  const toSlide = (event: { clientX: number; clientY: number }): Point => {
    const rect = frame.current?.getBoundingClientRect()

    return rect ? [(event.clientX - rect.left) / scale, (event.clientY - rect.top) / scale] : [0, 0]
  }

  const reach = SNAP / Math.max(scale, 0.01)
  const selectionNow = (base: Deck, ids: readonly string[]) => (findSlide(base, doc.slideId)?.elements ?? []).filter((element) => ids.includes(element.id))
  const othersNow = (base: Deck, ids: readonly string[]) => (findSlide(base, doc.slideId)?.elements ?? []).filter((element) => !ids.includes(element.id))

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }

    const target = event.target as HTMLElement
    const session = textSessionOf(doc)

    if (session && target.closest('.ProseMirror')) {
      return
    }

    session?.finish()
    scroller.current?.focus({ preventScroll: true })
    const point = toSlide(event)
    const base = doc.history.present
    const here = findSlide(base, doc.slideId)

    if (!here) {
      return
    }

    const capture = () => event.currentTarget.setPointerCapture(event.pointerId)
    const handle = target.closest('[data-handle]')?.getAttribute('data-handle') as Handle | null

    if (handle && doc.selected.length) {
      const chosen = selectionNow(base, doc.selected)
      const single = chosen.length === 1 ? chosen[0] : null
      const box = single ? { x: single.x, y: single.y, width: single.width, height: single.height } : boundsOfAll(chosen)

      if (box) {
        gesture.current = { kind: 'resize', base, ids: chosen.map((element) => element.id), handle, start: point, box, rotation: single?.rotation ?? 0, ratio: !single || single.kind === 'image', lines: snapLines(base.size, othersNow(base, doc.selected)) }
        capture()
      }

      return
    }

    if (target.closest('[data-rotate]') && doc.selected.length === 1) {
      const element = selectionNow(base, doc.selected)[0]

      if (element) {
        gesture.current = { kind: 'rotate', base, id: element.id, middle: center(element), start: point, rotation: element.rotation }
        capture()
      }

      return
    }

    const end = target.closest('[data-line-end]')?.getAttribute('data-line-end')

    if (end === 'from' || end === 'to') {
      gesture.current = { kind: 'line', base, id: doc.selected[0], end }
      capture()

      return
    }

    const id = target.closest('[data-element-id]')?.getAttribute('data-element-id')

    if (id && here.elements.some((element) => element.id === id)) {
      const wasSelected = doc.selected.includes(id)

      if (event.shiftKey || event.metaKey) {
        doc.select(wasSelected ? doc.selected.filter((entry) => entry !== id) : [...doc.selected, id])

        if (wasSelected) {
          return
        }
      } else if (!wasSelected) {
        doc.select([id])
      }

      gesture.current = { kind: 'press', id, wasSelected: wasSelected && !event.shiftKey && !event.metaKey, start: point, client: [event.clientX, event.clientY], duplicate: event.altKey, cell: cellAt(target) }
      capture()

      return
    }

    if (!event.shiftKey) {
      doc.select([])
    }

    gesture.current = { kind: 'marquee', start: point, initial: event.shiftKey ? [...doc.selected] : [] }
    capture()
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    let now = gesture.current

    if (!now) {
      return
    }

    const point = toSlide(event)

    if (now.kind === 'press') {
      if (Math.hypot(event.clientX - now.client[0], event.clientY - now.client[1]) < 3) {
        return
      }

      let base = doc.history.present
      let ids = [...doc.selected]

      if (now.duplicate) {
        const copied = model.pasteElements(base, doc.slideId, selectionNow(base, ids), 0, 'Duplicate')
        base = copied.deck
        ids = copied.focus?.selected ?? ids
        doc.select(ids)
      }

      const moving = selectionNow(base, ids)
      const others = othersNow(base, ids)
      now = { kind: 'move', base, ids, bounds: boundsOfAll(moving) ?? { x: 0, y: 0, width: 0, height: 0 }, start: now.start, label: now.duplicate ? 'Duplicate' : 'Move', lines: snapLines(base.size, others), others: others.map(boundsOf) }
      gesture.current = now
    }

    const dx = point[0] - ('start' in now ? now.start[0] : 0)
    const dy = point[1] - ('start' in now ? now.start[1] : 0)
    const snap = !(event.metaKey || event.ctrlKey)

    if (now.kind === 'move') {
      const moved = moveWithSnapping(now.bounds, dx, dy, { lines: now.lines, reach, others: now.others, size: now.base.size, axis: event.shiftKey, snap })
      doc.show(withElements(now.base, doc.slideId, new Set(now.ids), (element) => moveElement(element, moved.dx, moved.dy)))
      setGuides(moved.guides)
    } else if (now.kind === 'resize') {
      let box = resizeBox(now.box, now.rotation, now.handle, dx, dy, { keepRatio: now.ratio !== event.shiftKey, fromCenter: event.altKey })
      let shown: GuideLine[] = []

      if (!now.rotation && snap) {
        const snapped = snapResize(box, now.handle, now.lines, reach)
        box = snapped.box
        shown = snapped.landed.map((line) => (line.axis === 'x' ? { axis: 'x', at: line.value, from: 0, to: now.base.size.height } : { axis: 'y', at: line.value, from: 0, to: now.base.size.width }))
      }

      const ids = new Set(now.ids)
      const chosen = selectionNow(now.base, now.ids)
      const scaled = chosen.length === 1 ? [withBox(chosen[0], box)] : scaleGroup(chosen, now.box, box)
      const byId = new Map(scaled.map((element) => [element.id, element]))
      doc.show(withElements(now.base, doc.slideId, ids, (element) => byId.get(element.id) ?? element))
      setGuides(shown)
    } else if (now.kind === 'rotate') {
      const rotation = rotationFor(now.middle, now.start, point, now.rotation, { step: event.shiftKey })
      doc.show(withElements(now.base, doc.slideId, new Set([now.id]), (element) => ({ ...element, rotation })))
    } else if (now.kind === 'line') {
      const line = findElement(findSlide(now.base, doc.slideId), now.id)

      if (line?.kind === 'line') {
        const ends = moveLineEnd(line, now.end, point, event.shiftKey)
        doc.show(withElements(now.base, doc.slideId, new Set([now.id]), () => withEnds(line, ends.from, ends.to)))
      }
    } else if (now.kind === 'marquee') {
      const box = spanBox(now.start, point)
      setMarquee(box)
      const hits = marqueeHits(slide.elements, box)
      doc.select([...new Set([...now.initial, ...hits])])
    }
  }

  const onPointerUp = () => {
    const done = gesture.current
    gesture.current = null
    setGuides([])
    setMarquee(null)

    if (!done) {
      return
    }

    if (done.kind === 'press') {
      const element = findElement(doc.slide, done.id)

      if (done.wasSelected && doc.selected.length === 1 && isTextual(element)) {
        requestEditStart({ elementId: done.id, point: { x: done.client[0], y: done.client[1] }, select: 'caret' })
        doc.edit(done.id)
      } else if (done.wasSelected && doc.selected.length === 1 && element?.kind === 'table' && done.cell) {
        requestEditStart({ elementId: done.id, point: { x: done.client[0], y: done.client[1] }, select: 'caret' })
        doc.goToCell(done.id, done.cell, true)
      } else if (done.wasSelected && element && element.kind === 'image' && isEmptyPlaceholder(element)) {
        commands.pickPictures(doc)
      }

      return
    }

    if (done.kind !== 'marquee' && doc.preview) {
      const label = done.kind === 'move' ? done.label : done.kind === 'resize' ? 'Resize' : done.kind === 'rotate' ? 'Rotate' : 'Move Line'
      doc.commit({ deck: doc.preview, label, focus: { selected: done.kind === 'move' || done.kind === 'resize' ? done.ids : [done.id] } })
    } else if (doc.preview) {
      doc.show(null)
    }
  }

  const onDoubleClick = (event: React.MouseEvent) => {
    const id = (event.target as HTMLElement).closest('[data-element-id]')?.getAttribute('data-element-id')
    const element = findElement(doc.slide, id)
    const session = textSessionOf(doc)

    if (!element) {
      return
    }

    const cell = element.kind === 'table' ? cellAt(event.target) : null

    if (session?.elementId === element.id && (!cell || (cell.row === doc.cell?.row && cell.column === doc.cell.column))) {
      selectWordAt(session.editor, event.clientX, event.clientY)
    } else if (cell) {
      requestEditStart({ elementId: element.id, point: { x: event.clientX, y: event.clientY }, select: 'word' })
      doc.goToCell(element.id, cell, true)
    } else if (isTextual(element)) {
      requestEditStart({ elementId: element.id, point: { x: event.clientX, y: event.clientY }, select: 'word' })
      doc.edit(element.id)
    } else if (element.kind === 'image' && isEmptyPlaceholder(element)) {
      doc.select([element.id])
      commands.pickPictures(doc)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (isTyping(event.target) || event.metaKey || event.ctrlKey) {
      return
    }

    const step = event.shiftKey ? 10 : 1
    const arrows: Record<string, Point> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }

    if (arrows[event.key] && doc.selected.length) {
      commands.nudgeSelection(...arrows[event.key])
    } else if ((event.key === 'Backspace' || event.key === 'Delete') && doc.selected.length) {
      commands.deleteSelection()
    } else if (event.key === 'Escape' && doc.selected.length) {
      doc.select([])
    } else if ((event.key === 'Enter' || event.key === 'F2') && doc.selected.length === 1) {
      commands.editSelection(event.key === 'F2' ? 'end' : 'all')
    } else if (event.key === 'Tab' && slide.elements.length) {
      const order = slide.elements.map((element) => element.id)
      const at = doc.selected.length ? order.indexOf(doc.selected[doc.selected.length - 1]) : -1
      doc.select([order[(at + (event.shiftKey ? -1 : 1) + order.length) % order.length]])
    } else {
      return
    }

    event.preventDefault()
    event.stopPropagation()
  }

  const onDrop = (event: React.DragEvent) => {
    const files = [...event.dataTransfer.files]

    if (!files.length) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const pictures = files.filter((file) => file.type.startsWith('image/'))
    const decks = files.filter((file) => /\.(pptx|pptm)$/i.test(file.name))

    if (pictures.length) {
      void commands.insertPictures(pictures, toSlide(event), doc)
    }

    for (const file of decks) {
      const path = window.heraldOS.fs.pathForFile(file)

      if (path) {
        slidesSession.open(path).catch((error: unknown) => slidesSession.notify(`Could not open ${file.name}: ${error instanceof Error ? error.message : String(error)}`, 'error'))
      }
    }

    if (!pictures.length && !decks.length) {
      slidesSession.notify(`Herald Slides does not take ${files[0].name}`, 'error')
    }
  }

  const editingId = doc.editing
  const cell = editingId ? doc.cell : null
  const editing: EditingSlot | null = editingId
    ? {
        id: editingId,
        cell,
        render: (body) => <TextEditor key={cell ? `${editingId}:${cell.row}:${cell.column}` : editingId} doc={doc} slideId={slide.id} elementId={editingId} cell={cell} onTab={(by) => commands.moveCell(by, doc)} body={body} theme={deck.theme} />
      }
    : null
  const editingElement = editingId ? (findElement(slide, editingId) ?? null) : null

  return (
    <div
      ref={scroller}
      tabIndex={0}
      data-slides-stage=""
      role="application"
      aria-label={`Slide ${doc.index + 1} of ${deck.slides.length}`}
      className="relative min-h-0 min-w-0 flex-1 overflow-auto outline-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        event.preventDefault()
        const id = (event.target as HTMLElement).closest('[data-element-id]')?.getAttribute('data-element-id')

        if (id && !doc.selected.includes(id)) {
          doc.select([id])
        }

        const cell = cellAt(event.target)

        // The table's row and column commands act on the cell clicked, unless it is being typed in.
        if (id && cell && doc.editing !== id && findElement(doc.slide, id)?.kind === 'table') {
          doc.goToCell(id, cell)
        }

        const rect = scroller.current?.getBoundingClientRect()
        onContextMenu?.({ x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) })
      }}
      onCopy={(event) => {
        if (!isTyping(event.target) && commands.copySelection(event.clipboardData, doc)) {
          event.preventDefault()
        }
      }}
      onCut={(event) => {
        if (!isTyping(event.target) && commands.copySelection(event.clipboardData, doc)) {
          event.preventDefault()
          commands.deleteSelection()
        }
      }}
      onPaste={(event) => {
        if (!isTyping(event.target)) {
          event.preventDefault()
          void commands.pasteFrom(event.clipboardData, doc)
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={onDrop}
    >
      {scale > 0 && (
        <div className="relative" style={{ width: contentWidth, height: contentHeight }}>
          <div ref={frame} className="absolute shadow-[0_10px_40px_rgba(0,8,50,.55)]" style={{ left: (contentWidth - width) / 2, top: (contentHeight - height) / 2, width, height }}>
            <SlideView deck={deck} slide={slide} scale={scale} mode="edit" editing={editing} className="hs-stage" style={{ ['--hs-scale' as string]: scale }} />
            <Overlay selection={doc.selection} editing={editingElement} scale={scale} guides={guides} marquee={marquee} />
          </div>
        </div>
      )}
    </div>
  )
}

/** The scale each document's slide is shown at, and the scale that fits it, for the zoom commands. */
export const stageScales = new WeakMap<SlidesDocument, { scale: number; fit: number }>()
