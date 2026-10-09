import type { Editor } from '@tiptap/core'
import { atom } from 'nanostores'
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { DocJSON } from '../../../../shared/office/document.ts'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { $editors, docsSession } from './store.ts'
import { type Direction, freshName, moveSelection, rowLength } from './templates/gallery.ts'
import { documentFromTemplate, TEMPLATES } from './templates/index.ts'
import { thumbnailOf } from './templates/thumbnail.ts'

/*
 * The gallery a new document starts from: the blank document, first and selected so that New and
 * then Enter make one, and Herald's templates, each a live thumbnail of its first page. The arrow
 * keys move, Enter makes the document and Escape goes back. Only the person's own New opens it:
 * a document asked for by Hermes or another app is blank, with no dialog.
 */

/** Whether the gallery is open over Herald Docs. */
export const $templateGallery = atom(false)

export const openTemplateGallery = (): void => $templateGallery.set(true)

const THUMB = { width: 124, height: 175 }

const DIRECTIONS: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'home', End: 'end' }

const locale = (): string => (typeof navigator === 'undefined' ? 'en-GB' : navigator.language)

interface Card {
  key: string
  name: string
  description: string
  doc: DocJSON
}

/** A document's first page, scaled down to fit the card at the page's own proportions. */
function Thumbnail({ doc, scope }: { doc: DocJSON; scope: string }) {
  const thumb = useMemo(() => thumbnailOf(doc, `[data-thumb="${scope}"]`, { locale: locale() }), [doc, scope])
  const { page } = thumb
  const { margins } = page
  const zoom = Math.min(THUMB.width / ((page.width * 96) / 72), THUMB.height / ((page.height * 96) / 72))
  const sides = { left: `${margins.left}pt`, right: `${margins.right}pt` }

  return (
    <div className="grid shrink-0 place-items-center" style={THUMB} aria-hidden="true">
      <div data-thumb={scope} className="pointer-events-none relative overflow-hidden bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,.3),0_4px_14px_rgba(0,0,0,.28)] select-none" style={{ width: `${page.width}pt`, height: `${page.height}pt`, zoom }}>
        <style>{thumb.css}</style>
        {thumb.header && <div className="absolute" style={{ top: `${margins.header ?? 36}pt`, ...sides }} dangerouslySetInnerHTML={{ __html: thumb.header }} />}
        <div className="absolute overflow-hidden" style={{ top: `${margins.top}pt`, bottom: `${margins.bottom}pt`, ...sides }} dangerouslySetInnerHTML={{ __html: thumb.body }} />
        {thumb.footer && <div className="absolute" style={{ bottom: `${margins.footer ?? 36}pt`, ...sides }} dangerouslySetInnerHTML={{ __html: thumb.footer }} />}
      </div>
    </div>
  )
}

/** Put the caret at the start of a new document as soon as its editor is there. */
function focusWhenReady(key: string): void {
  const focus = (editors: Readonly<Record<string, Editor>>): boolean => {
    editors[key]?.commands.focus('start')

    return Boolean(editors[key])
  }

  if (focus($editors.get())) {
    return
  }

  const stop = $editors.listen((editors) => {
    if (focus(editors)) {
      queueMicrotask(stop)
    }
  })
  setTimeout(stop, 10000)
}

export function TemplateGallery() {
  const cards = useMemo<Card[]>(() => TEMPLATES.map((template) => ({ key: template.id, name: template.name, description: template.description, doc: documentFromTemplate(template.id, { locale: locale() }) })), [])
  const [selected, setSelected] = useState(0)
  const elements = useRef<(HTMLDivElement | null)[]>([])
  const before = useRef<Element | null>(document.activeElement)
  const created = useRef(false)
  const current = cards[Math.min(selected, cards.length - 1)]

  // The selected card has the focus, so the keys and a screen reader follow the selection.
  useEffect(() => {
    elements.current[selected]?.focus()
  }, [selected])

  // Closed without a new document, the focus goes back where it was.
  useEffect(
    () => () => {
      if (!created.current && before.current instanceof HTMLElement && before.current.isConnected) {
        before.current.focus()
      }
    },
    []
  )

  const close = () => $templateGallery.set(false)

  const create = (card: Card | undefined) => {
    if (!card) {
      return
    }

    created.current = true
    close()
    const names = docsSession.$documents.get().map((doc) => doc.name)
    const doc = card.key === 'blank' ? docsSession.create() : docsSession.create(documentFromTemplate(card.key, { locale: locale() }), freshName(card.name, names))
    focusWhenReady(doc.key)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    const direction = DIRECTIONS[event.key]

    if (event.key === 'Escape') {
      close()
    } else if (event.key === 'Enter') {
      // A button takes its own Enter.
      if (target.closest('button')) {
        return
      }

      create(current)
    } else if (direction) {
      const tops = elements.current.slice(0, cards.length).map((element) => element?.offsetTop ?? 0)
      setSelected(moveSelection([cards.length], rowLength(tops), selected, direction))
    } else {
      return
    }

    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-black/35 p-6" onMouseDown={close}>
      <div role="dialog" aria-label="New document" className="float menu-surface flex max-h-full w-full max-w-[790px] flex-col rounded-2xl animate-pop" onMouseDown={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="px-5 pt-5 pb-3 text-[14px] font-medium text-fg">New document</div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          <div role="listbox" aria-label="Templates" className="grid grid-cols-[repeat(auto-fill,140px)] justify-center gap-x-2 gap-y-1">
            {cards.map((card, index) => (
              <div
                key={card.key}
                ref={(element) => {
                  elements.current[index] = element
                }}
                role="option"
                aria-selected={index === selected}
                tabIndex={index === selected ? 0 : -1}
                title={card.description}
                onClick={() => setSelected(index)}
                onDoubleClick={() => create(card)}
                className={cn('flex cursor-default flex-col items-center gap-2 rounded-xl border p-2 outline-none transition-colors duration-120', index === selected ? 'border-accent-strong/70 bg-accent-soft' : 'border-transparent hover:bg-white/6')}
              >
                <Thumbnail doc={card.doc} scope={card.key} />
                <div className="w-full truncate text-center text-[12px] text-fg">{card.name}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-line px-5 py-3">
          <span className="min-w-0 flex-1 truncate text-[12px] text-fg-3">{current?.description}</span>
          <GlassButton variant="ghost" onClick={close}>
            Cancel
          </GlassButton>
          <GlassButton variant="primary" onClick={() => create(current)}>
            Create
          </GlassButton>
        </div>
      </div>
    </div>
  )
}
