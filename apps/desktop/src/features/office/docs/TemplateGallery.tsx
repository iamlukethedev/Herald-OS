import { IconPencil, IconTrash } from '@tabler/icons-react'
import type { Editor } from '@tiptap/core'
import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { DocJSON } from '../../../../shared/office/document.ts'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { messageOf } from '../../canvas/errors.ts'
import { $editors, $templateGallery, docsSession } from './store.ts'
import { type Direction, freshName, moveSelection, rowLength } from './templates/gallery.ts'
import { documentFromTemplate, TEMPLATES } from './templates/index.ts'
import { removeTemplate, renameTemplate, type SavedTemplate, savedTemplates } from './templates/saved.ts'
import { thumbnailOf } from './templates/thumbnail.ts'

/*
 * The gallery a new document starts from: the blank document, first and selected so that New and
 * then Enter make one, Herald's templates and the person's own, each a live thumbnail of its first
 * page. The arrow keys move, Enter makes the document and Escape goes back. Only the person's own
 * New opens it: a document asked for by Hermes or another app is blank, with no dialog.
 */

const THUMB = { width: 124, height: 175 }

const DIRECTIONS: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'home', End: 'end' }

const locale = (): string => (typeof navigator === 'undefined' ? 'en-GB' : navigator.language)

interface Card {
  key: string
  name: string
  description: string
  doc: DocJSON
  saved?: SavedTemplate
}

const savedCard = (template: SavedTemplate): Card => {
  const date = new Date(template.savedAt)

  return { key: `saved-${template.id}`, name: template.name, description: Number.isNaN(date.getTime()) ? 'One of your templates.' : `Saved on ${date.toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' })}.`, doc: template.doc, saved: template }
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

function CardAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event: MouseEvent) => {
        event.stopPropagation()
        onClick()
      }}
      className="grid size-6 place-items-center rounded-md bg-black/60 text-white/85 hover:bg-black/80 hover:text-white"
    >
      {children}
    </button>
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
  const builtIn = useMemo<Card[]>(() => TEMPLATES.map((template) => ({ key: template.id, name: template.name, description: template.description, doc: documentFromTemplate(template.id, { locale: locale() }) })), [])
  const [saved, setSaved] = useState<SavedTemplate[]>([])
  const [selected, setSelected] = useState(0)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<SavedTemplate | null>(null)
  const elements = useRef<(HTMLDivElement | null)[]>([])
  const before = useRef<Element | null>(document.activeElement)
  const created = useRef(false)
  // The template being renamed, so that Enter and the blur after it rename it once.
  const naming = useRef<string | null>(null)
  const cards = useMemo(() => [...builtIn, ...saved.map(savedCard)], [builtIn, saved])
  const current = cards[Math.min(selected, cards.length - 1)]

  useEffect(() => {
    let live = true
    void savedTemplates()
      .then((list) => live && setSaved(list))
      .catch((error: unknown) => docsSession.notify(`Could not read your templates: ${messageOf(error)}`, 'error'))

    return () => {
      live = false
    }
  }, [])

  // The selected card has the focus, so the keys and a screen reader follow the selection.
  useEffect(() => {
    if (!renaming && !deleting) {
      elements.current[selected]?.focus()
    }
  }, [selected, cards.length, renaming, deleting])

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
    const model = card.saved ? structuredClone(card.saved.doc) : card.key === 'blank' ? null : documentFromTemplate(card.key, { locale: locale() })
    const doc = model ? docsSession.create({ model, name: freshName(card.name, names) }) : docsSession.create()
    focusWhenReady(doc.key)
  }

  const startRename = (template: SavedTemplate) => {
    naming.current = template.id
    setRenaming(template.id)
  }

  const rename = (template: SavedTemplate, name: string | null) => {
    if (naming.current !== template.id) {
      return
    }

    naming.current = null
    setRenaming(null)
    const wanted = name?.trim()

    if (!wanted || wanted === template.name) {
      return
    }

    renameTemplate(template.id, wanted)
      .then((info) => setSaved((list) => list.map((entry) => (entry.id === template.id ? { ...entry, name: info.name } : entry))))
      .catch((error: unknown) => docsSession.notify(`Could not rename “${template.name}”: ${messageOf(error)}`, 'error'))
  }

  const remove = (template: SavedTemplate) => {
    setDeleting(null)
    removeTemplate(template.id)
      .then(() => {
        setSaved((list) => list.filter((entry) => entry.id !== template.id))
        setSelected((index) => Math.min(index, cards.length - 2))
      })
      .catch((error: unknown) => docsSession.notify(`Could not delete “${template.name}”: ${messageOf(error)}`, 'error'))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    const direction = DIRECTIONS[event.key]

    // The name field takes its own keys.
    if (target.tagName === 'INPUT') {
      return
    }

    if (event.key === 'Escape') {
      if (deleting) {
        setDeleting(null)
      } else {
        close()
      }
    } else if (event.key === 'Enter') {
      // A button takes its own Enter.
      if (target.closest('button')) {
        return
      }

      if (deleting) {
        remove(deleting)
      } else {
        create(current)
      }
    } else if (direction && !deleting) {
      const tops = elements.current.slice(0, builtIn.length).map((element) => element?.offsetTop ?? 0)
      setSelected(moveSelection([builtIn.length, saved.length], rowLength(tops), selected, direction))
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && current?.saved && !deleting) {
      setDeleting(current.saved)
    } else {
      return
    }

    event.preventDefault()
    event.stopPropagation()
  }

  const cardView = (card: Card, index: number) => (
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
      className={cn('group relative flex cursor-default flex-col items-center gap-2 rounded-xl border p-2 outline-none transition-colors duration-120', index === selected ? 'border-accent-strong/70 bg-accent-soft' : 'border-transparent hover:bg-white/6')}
    >
      <Thumbnail doc={card.doc} scope={card.key} />
      {card.saved && renaming === card.saved.id ? (
        <input
          autoFocus
          aria-label="Template name"
          defaultValue={card.name}
          maxLength={120}
          onFocus={(event) => event.target.select()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              rename(card.saved!, event.currentTarget.value)
            } else if (event.key === 'Escape') {
              rename(card.saved!, null)
            }
          }}
          onBlur={(event) => rename(card.saved!, event.currentTarget.value)}
          className="glass-input h-5 w-full min-w-0 rounded-md px-1.5 text-center text-[12px] text-fg outline-none"
        />
      ) : (
        <div className="w-full truncate text-center text-[12px] text-fg">{card.name}</div>
      )}
      {card.saved && renaming !== card.saved.id && (
        <div className={cn('absolute top-3 right-3 flex gap-1', index === selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')} onDoubleClick={(event) => event.stopPropagation()}>
          <CardAction
            label={`Rename ${card.name}`}
            onClick={() => {
              setSelected(index)
              startRename(card.saved!)
            }}
          >
            <IconPencil size={13} />
          </CardAction>
          <CardAction
            label={`Delete ${card.name}`}
            onClick={() => {
              setSelected(index)
              setDeleting(card.saved!)
            }}
          >
            <IconTrash size={13} />
          </CardAction>
        </div>
      )}
    </div>
  )

  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-black/35 p-6" onMouseDown={close}>
      <div role="dialog" aria-label="New document" className="float menu-surface flex max-h-full w-full max-w-[790px] flex-col rounded-2xl animate-pop" onMouseDown={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="px-5 pt-5 pb-3 text-[14px] font-medium text-fg">New document</div>
        <div role="listbox" aria-label="Templates" className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          <div role="group" aria-label="Herald’s templates" className="grid grid-cols-[repeat(auto-fill,140px)] justify-center gap-x-2 gap-y-1">
            {builtIn.map(cardView)}
          </div>
          <div role="group" aria-label="Your templates" className="pt-4">
            <div aria-hidden="true" className="px-1 pb-1.5 text-[11.5px] font-medium tracking-wide text-fg-3 uppercase">
              Your templates
            </div>
            {saved.length ? (
              <div className="grid grid-cols-[repeat(auto-fill,140px)] justify-center gap-x-2 gap-y-1">{cards.slice(builtIn.length).map((card, index) => cardView(card, builtIn.length + index))}</div>
            ) : (
              <p className="px-1 text-[12px] text-fg-3">Keep any document as a template with File &gt; Save as Template…, and it appears here.</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-line px-5 py-3">
          {deleting ? (
            <>
              <span className="min-w-0 flex-1 text-[12.5px] text-fg-2">Delete your template “{deleting.name}”? This cannot be undone.</span>
              <GlassButton variant="ghost" onClick={() => setDeleting(null)}>
                Cancel
              </GlassButton>
              <GlassButton variant="danger" autoFocus onClick={() => remove(deleting)}>
                Delete
              </GlassButton>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-[12px] text-fg-3">{current?.description}</span>
              <GlassButton variant="ghost" onClick={close}>
                Cancel
              </GlassButton>
              <GlassButton variant="primary" onClick={() => create(current)}>
                Create
              </GlassButton>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
