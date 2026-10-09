import './navigation.css'
import { useStore } from '@nanostores/react'
import { IconChevronRight, IconListTree, IconSearch, IconX } from '@tabler/icons-react'
import type { Editor, EditorEvents } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { Mapping } from '@tiptap/pm/transform'
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { cn } from '../../../lib/cn.ts'
import { keysLabel } from '../../../lib/shortcuts.ts'
import { counts } from './model.ts'
import { currentEntry, mapPositions, navigationEntries, navigationKey, navigationRows, navigationTree, type NavNode, rowOf } from './navigation.ts'
import { NAVIGATION_PANE_SHORTCUT } from './navigation-menus.ts'
import { $navigationPane, showNavigationPane } from './navigation-store.ts'
import { pagesOf } from './pages/map.ts'
import { $statistics } from './StatisticsDialog.tsx'
import { $pages } from './store.ts'

/** How long the pane lets the document change before it reads the headings again, in milliseconds. */
const SETTLE = 150

/** Room above a heading the pane scrolls to, and around the row it keeps in sight. */
const ABOVE = 24
const ROW_ROOM = 4

const INDENT = 12

const plural = (count: number, one: string, many: string): string => `${count.toLocaleString()} ${count === 1 ? one : many}`

interface Outline {
  doc: PMNode
  tree: NavNode[]
  words: number
  /** The entry the caret is under, or -1. */
  current: number
}

function outlineOf(editor: Editor): Outline {
  const { doc, selection } = editor.state
  const tree = navigationTree(navigationEntries(doc))

  return { doc, tree, words: counts(doc).words, current: currentEntry(tree, selection.head) }
}

const reducedMotion = (): boolean => document.documentElement.dataset.reduceMotion === 'true' || window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Scroll the desk a document is on so the block at `from` is near its top. */
function scrollToBlock(editor: Editor, from: number): void {
  const desk = editor.view.dom.closest<HTMLElement>('.docs-desk')
  const block = editor.view.nodeDOM(from)

  if (!desk) {
    return
  }

  const top = block instanceof HTMLElement ? block.getBoundingClientRect().top : editor.view.coordsAtPos(from + 1).top
  desk.scrollTo({ top: desk.scrollTop + top - desk.getBoundingClientRect().top - ABOVE, behavior: reducedMotion() ? 'auto' : 'smooth' })
}

function keepInView(list: HTMLElement, row: HTMLElement): void {
  const top = row.offsetTop - ROW_ROOM
  const bottom = row.offsetTop + row.offsetHeight + ROW_ROOM

  if (top < list.scrollTop) {
    list.scrollTop = top
  } else if (bottom > list.scrollTop + list.clientHeight) {
    list.scrollTop = bottom - list.clientHeight
  }
}

/** Text with the parts a filter matched marked. */
function Marked({ text, marks }: { text: string; marks: readonly [number, number][] }) {
  const parts: ReactNode[] = []
  let at = 0

  for (const [from, to] of marks) {
    parts.push(
      text.slice(at, from),
      <mark key={from} className="rounded-[3px] bg-accent-soft text-fg">
        {text.slice(from, to)}
      </mark>
    )
    at = to
  }

  parts.push(text.slice(at))

  return <>{parts}</>
}

/** The document's outline beside the pages, for moving through it. */
export function NavigationPane({ editor, docKey }: { editor: Editor; docKey: string }): ReactNode {
  return useStore($navigationPane) ? <Pane editor={editor} docKey={docKey} /> : null
}

function Pane({ editor, docKey }: { editor: Editor; docKey: string }) {
  const [outline, setOutline] = useState(() => outlineOf(editor))
  /** Where the folded entries start. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set())
  const [query, setQuery] = useState('')
  /** Where the entry of the row with the keyboard focus starts, while the list has it. */
  const [focused, setFocused] = useState<number | null>(null)
  const map = useStore($pages)[docKey]
  const list = useRef<HTMLDivElement>(null)
  const firstDoc = useRef(outline.doc)
  const listId = useId()
  const { tree, words, current } = outline
  const rows = useMemo(() => navigationRows(tree, collapsed, query), [tree, collapsed, query])
  const pages = useMemo(() => (map ? pagesOf(map, tree.map((node) => node.from)) : null), [map, tree])
  const currentRow = rowOf(rows, tree, current)
  const focusedRow = focused === null ? -1 : rows.findIndex((row) => tree[row.index].from === focused)
  const tabRow = focusedRow >= 0 ? focusedRow : Math.max(currentRow, 0)

  useEffect(() => {
    let timer = 0
    let last = firstDoc.current
    let changes = new Mapping()
    let replaced = false
    const refresh = () => {
      timer = 0

      if (editor.isDestroyed) {
        return
      }

      const next = outlineOf(editor)
      const starts = new Set(next.tree.map((node) => node.from))
      const moved = changes
      const lost = replaced
      changes = new Mapping()
      replaced = false
      setOutline(next)
      setCollapsed((positions) => (lost ? new Set() : new Set([...mapPositions(positions, moved)].filter((pos) => starts.has(pos)))))
      setFocused((at) => (at === null || lost ? null : moved.map(at, 1)))
    }
    const onTransaction = ({ transaction, appendedTransactions }: EditorEvents['transaction']) => {
      let changed = false

      for (const tr of [transaction, ...appendedTransactions]) {
        // A state put in place whole (a version reloaded from disk) comes without the steps that made it.
        replaced ||= tr.before !== last
        last = tr.doc

        if (tr.docChanged) {
          changes.appendMapping(tr.mapping)
          changed = true
        }
      }

      if (changed || replaced) {
        timer ||= window.setTimeout(refresh, SETTLE)
      } else if (!timer) {
        const head = editor.state.selection.head
        setOutline((shown) => {
          const at = currentEntry(shown.tree, head)

          return at === shown.current ? shown : { ...shown, current: at }
        })
      }
    }
    editor.on('transaction', onTransaction)

    return () => {
      editor.off('transaction', onTransaction)
      window.clearTimeout(timer)
    }
  }, [editor])

  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(`[data-row="${currentRow}"]`)

    if (row && list.current) {
      keepInView(list.current, row)
    }
  }, [currentRow, current])

  const go = (index: number) => {
    const node = tree[index]

    if (!node || editor.isDestroyed) {
      return
    }

    const { state, view } = editor
    setFocused(null)
    view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(Math.min(node.from + 1, state.doc.content.size)))))
    view.focus()
    scrollToBlock(editor, node.from)
  }

  const toggle = (index: number) => {
    const from = tree[index].from
    setCollapsed((positions) => {
      const next = new Set(positions)

      if (!next.delete(from)) {
        next.add(from)
      }

      return next
    })
  }

  const focusRow = (at: number) => {
    const row = list.current?.querySelector<HTMLElement>(`[data-row="${at}"]`)

    if (row && list.current) {
      row.focus({ preventScroll: true })
      keepInView(list.current, row)
    }
  }

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      editor.view.focus()

      return
    }

    const step = navigationKey(rows, tree, tabRow, event.key)

    if (!step) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    if ('go' in step) {
      go(step.go)
    } else if ('toggle' in step) {
      toggle(step.toggle)
    } else {
      focusRow(step.focus)
    }
  }

  return (
    <aside aria-label="Navigation pane" className="flex w-60 shrink-0 flex-col border-r border-line">
      <div className="flex h-9 shrink-0 items-center gap-1 pr-1.5 pl-3">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg-2">Navigation</span>
        <button type="button" aria-label="Close the navigation pane" title={`Close (${keysLabel(NAVIGATION_PANE_SHORTCUT)})`} onClick={() => showNavigationPane(false)} className="grid size-6 place-items-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg">
          <IconX size={14} />
        </button>
      </div>
      {tree.length ? (
        <>
          <div className="shrink-0 px-2 pb-1.5">
            <label className="glass-input flex h-7 items-center gap-1.5 rounded-md px-2">
              <IconSearch size={13} className="shrink-0 text-fg-3" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' && rows.length) {
                    event.preventDefault()
                    focusRow(0)
                  } else if (event.key === 'Enter' && query.trim() && rows.length) {
                    event.preventDefault()
                    go((rows.find((row) => !row.context) ?? rows[0]).index)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()

                    if (query) {
                      setQuery('')
                    } else {
                      editor.view.focus()
                    }
                  }
                }}
                placeholder="Filter headings"
                aria-label="Filter headings"
                aria-controls={listId}
                className="min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-fg-4"
              />
              {query && (
                <button type="button" aria-label="Clear the filter" onClick={() => setQuery('')} className="grid size-4 shrink-0 place-items-center rounded text-fg-3 hover:text-fg">
                  <IconX size={12} />
                </button>
              )}
            </label>
          </div>
          {rows.length ? (
            <div
              ref={list}
              id={listId}
              role="tree"
              aria-label="Headings"
              className="relative min-h-0 flex-1 overflow-y-auto px-1.5 pb-2"
              onKeyDown={onListKey}
              onBlur={(event) => {
                if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) {
                  setFocused(null)
                }
              }}
            >
              {rows.map((row, at) => {
                const node = tree[row.index]
                const here = at === currentRow

                return (
                  <div
                    key={row.index}
                    role="treeitem"
                    data-row={at}
                    tabIndex={at === tabRow ? 0 : -1}
                    aria-level={node.depth + 1}
                    aria-expanded={row.expanded ?? undefined}
                    aria-selected={here}
                    aria-current={here ? 'location' : undefined}
                    aria-label={pages ? `${node.text}, page ${pages[row.index]}` : undefined}
                    title={node.text}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => go(row.index)}
                    onFocus={() => setFocused(node.from)}
                    style={{ paddingLeft: 4 + node.depth * INDENT }}
                    className={cn(
                      'docs-nav-row relative flex h-7 cursor-default items-center gap-1 rounded-md pr-2 text-[12px]',
                      here ? 'bg-white/10 before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-accent' : 'hover:bg-white/5',
                      row.context ? 'text-fg-3' : here || node.level <= 1 ? 'text-fg' : 'text-fg-2',
                      node.level === 0 ? 'font-semibold' : node.level === 1 && 'font-medium'
                    )}
                  >
                    <span
                      aria-hidden="true"
                      onClick={(event) => {
                        if (row.expanded !== null) {
                          event.stopPropagation()
                          toggle(row.index)
                        }
                      }}
                      className={cn('grid size-4 shrink-0 place-items-center rounded text-fg-3', row.expanded !== null && 'hover:bg-white/10 hover:text-fg')}
                    >
                      {row.expanded !== null && <IconChevronRight size={12} className={cn('transition-transform', row.expanded && 'rotate-90')} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      <Marked text={node.text} marks={row.marks} />
                    </span>
                    {pages && <span className={cn('shrink-0 pl-1 text-[11px] font-normal tabular-nums', here ? 'text-fg-3' : 'text-fg-4')}>{pages[row.index]}</span>}
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="min-h-0 flex-1 px-4 py-3 text-[12px] text-fg-3">No headings match “{query.trim()}”.</p>
          )}
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center px-5 pt-10 text-center">
          <IconListTree size={22} className="text-fg-4" />
          <p className="mt-2.5 text-[12.5px] text-fg-2">Headings appear here</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-fg-3">Give a paragraph a heading style, and it shows here so you can go straight to it.</p>
        </div>
      )}
      <button type="button" title="Word count and statistics" onClick={() => $statistics.set(true)} className="flex h-8 shrink-0 items-center border-t border-line px-3 text-left text-[11.5px] text-fg-3 tabular-nums hover:bg-white/5 hover:text-fg-2">
        {plural(words, 'word', 'words')}
        {map ? ` · ${plural(map.pages.length, 'page', 'pages')}` : ''}
      </button>
    </aside>
  )
}
