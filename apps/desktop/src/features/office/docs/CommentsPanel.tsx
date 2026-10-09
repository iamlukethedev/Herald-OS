import './review.css'
import { useStore } from '@nanostores/react'
import { IconArrowBackUp, IconCheck, IconChevronDown, IconChevronRight, IconDots, IconMessagePlus, IconX } from '@tabler/icons-react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CommentReply } from '../../../../shared/office/document.ts'
import { HermesAvatar } from '../../../components/app-icon.tsx'
import { cn } from '../../../lib/cn.ts'
import { keysLabel } from '../../../lib/shortcuts.ts'
import { useSystemInfo } from '../../../store/system.ts'
import { Menu } from '../../files/Menu.tsx'
import { $author, initialsOf, setAuthor } from './comment-author.ts'
import { $commentsShown, $composeRequest, cancelComment, commentsState, leaveComment, postComment, removeThread, resolveThread, showThread, startComment } from './comments.ts'
import { applyLive, comments, editComment, replyToComment } from './model.ts'
import { keepInList } from './overlay.ts'
import { docsSession } from './store.ts'
import { TocBar } from './TocBar.tsx'
import { ToolButton } from './Toolbar.tsx'

/*
 * The comments beside the pages, as in Word and Google Docs: a card for each thread in the order of
 * its text, its replies under it and a box to answer it in, resolved threads folded away, and a
 * card for a new comment while it is written. A card picked selects its text; the caret in
 * commented text picks its card. The bar for a selected table of contents is drawn here too, over
 * the page, as the other bars are.
 */

interface ThreadView {
  id: string
  author: string
  initials: string | null
  date: string | null
  text: string
  resolved: boolean
  replies: CommentReply[]
  quote: string
  /** Whether its text is still in the document. */
  placed: boolean
}

interface PanelView {
  threads: ThreadView[]
  active: string | null
  /** The comment being written: what it quotes, and how many open threads' text starts before it. */
  draft: { quote: string; before: number } | null
}

function panelView(editor: Editor): PanelView {
  const { state } = editor
  const plugin = commentsState(state)
  const all = comments(state.doc)
  const draft = plugin?.draft ?? null

  return {
    threads: all.map(({ from, to: _to, ...thread }) => ({ ...thread, placed: from !== null })),
    active: plugin?.active ?? null,
    draft: draft && { quote: state.doc.textBetween(draft.from, draft.to, '\n', ' '), before: all.filter((thread) => !thread.resolved && thread.from !== null && thread.from <= draft.from).length }
  }
}

/** Now, again every half minute, for the comments' relative dates. */
function useNow(): number {
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)

    return () => clearInterval(timer)
  }, [])

  return now
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** When a comment was written, as people say it: just now, 5 minutes ago, yesterday, 3 Oct. */
function relativeDate(date: string | null, now: number): string {
  const time = date ? Date.parse(date) : Number.NaN

  if (Number.isNaN(time)) {
    return ''
  }

  const seconds = (time - now) / 1000
  const say = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

  if (Math.abs(seconds) < 45) {
    return 'Just now'
  }

  for (const [unit, size, limit] of [['minute', 60, 60], ['hour', 3600, 24], ['day', 86_400, 7]] as const) {
    const count = Math.round(seconds / size)

    if (Math.abs(count) < limit) {
      return capital(say.format(count, unit))
    }
  }

  const when = new Date(time)

  return when.toLocaleDateString(undefined, when.getFullYear() === new Date(now).getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}

const TONES = ['bg-accent/25 text-accent-strong', 'bg-ok/20 text-ok', 'bg-progress/20 text-progress', 'bg-warn/20 text-warn', 'bg-info/20 text-info', 'bg-danger/20 text-danger']

function Avatar({ name, initials, small = false }: { name: string; initials: string | null; small?: boolean }) {
  if (name === 'Hermes') {
    return <HermesAvatar size={small ? 20 : 24} rounded={999} />
  }

  const tone = TONES[[...name].reduce((sum, letter) => sum + (letter.codePointAt(0) ?? 0), 0) % TONES.length]

  return (
    <span aria-hidden="true" className={cn('grid shrink-0 place-items-center rounded-full font-semibold', small ? 'size-5 text-[9px]' : 'size-6 text-[10px]', tone)}>
      {(initials || initialsOf(name) || '?').slice(0, 2)}
    </span>
  )
}

/** The name Herald proposes the first time: the account's full name, or its user name. */
function useAccountName(): string {
  const info = useSystemInfo()
  const user = info?.userName?.trim() ?? ''

  return info?.fullName?.trim() || capital(user)
}

/** A box to write a comment, a reply or an edit in: Enter posts, Shift+Enter starts a new line, Escape leaves. */
function Composer({
  initial = '',
  placeholder,
  action,
  focusRequest = 0,
  signs = false,
  onPost,
  onEscape,
  onCancel
}: {
  initial?: string
  placeholder: string
  action: string
  /** The box takes the focus when it shows with this set, and whenever this changes. */
  focusRequest?: number
  /** Asks for the person's name when Herald does not know it yet. */
  signs?: boolean
  onPost: (text: string, author: string) => void
  onEscape?: (text: string) => void
  /** A Cancel button beside the one that posts. */
  onCancel?: () => void
}) {
  const author = useStore($author)
  const account = useAccountName()
  const [text, setText] = useState(initial)
  const [name, setName] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  const nameField = useRef<HTMLInputElement>(null)
  const asks = signs && !author

  useEffect(() => {
    if (asks && account) {
      setName((typed) => typed || account)
    }
  }, [asks, account])

  useEffect(() => {
    const element = area.current

    if (focusRequest && element) {
      element.focus({ preventScroll: true })
      element.setSelectionRange(element.value.length, element.value.length)
    }
  }, [focusRequest])

  useLayoutEffect(() => {
    const element = area.current

    if (element) {
      element.style.height = 'auto'
      element.style.height = `${Math.min(element.scrollHeight, 160)}px`
    }
  }, [text])

  const post = () => {
    const value = text.replace(/\s+$/, '')

    if (!value.trim()) {
      return
    }

    const by = asks ? name.trim() : author

    if (asks) {
      if (!by) {
        nameField.current?.focus()

        return
      }

      setAuthor(by)
    }

    setText('')
    onPost(value, by)
  }

  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      post()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()

      if (onEscape) {
        onEscape(text)
      } else {
        event.currentTarget.blur()
      }
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      {asks && (
        <label className="flex items-center gap-2 text-[11.5px] text-fg-3">
          <span className="shrink-0">Your name</span>
          <input
            ref={nameField}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={onKey}
            placeholder="Shown on your comments"
            aria-label="Your name, shown on your comments"
            className="glass-input h-7 min-w-0 flex-1 rounded-md px-2 text-[12px] text-fg outline-none"
          />
        </label>
      )}
      <textarea
        ref={area}
        rows={1}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKey}
        placeholder={placeholder}
        aria-label={placeholder}
        className="glass-input min-h-8 resize-none rounded-lg px-2.5 py-1.5 text-[12.5px] leading-snug text-fg outline-none"
      />
      {(text.trim() || onCancel) && (
        <div className="flex justify-end gap-1.5">
          {onCancel && (
            <button type="button" onClick={onCancel} className="h-7 rounded-md px-2.5 text-[12px] text-fg-2 hover:bg-white/8 hover:text-fg">
              Cancel
            </button>
          )}
          <button type="button" disabled={!text.trim()} onClick={post} className="h-7 rounded-md bg-accent px-2.5 text-[12px] font-medium text-accent-fg hover:bg-accent-strong disabled:opacity-40 disabled:hover:bg-accent">
            {action}
          </button>
        </div>
      )}
    </div>
  )
}

/** A comment or a reply: who wrote it and when, what it says (or a box to change that), and what can be done with it. */
function Entry({ comment, small = false, now, actions, editing, onSave, onStopEditing }: { comment: CommentReply; small?: boolean; now: number; actions: ReactNode; editing: boolean; onSave: (text: string) => void; onStopEditing: () => void }) {
  const when = comment.date ? new Date(comment.date) : null

  return (
    <div className="group/entry flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Avatar name={comment.author} initials={comment.initials ?? null} small={small} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate font-medium text-fg">{comment.author || 'Unknown author'}</div>
          {when && !Number.isNaN(when.getTime()) && (
            <time dateTime={comment.date!} title={when.toLocaleString()} className="text-[11px] text-fg-3">
              {relativeDate(comment.date, now)}
            </time>
          )}
        </div>
        {actions}
      </div>
      {editing ? (
        <Composer
          initial={comment.text}
          placeholder="Edit the comment"
          action="Save"
          focusRequest={1}
          onPost={(text) => {
            onSave(text)
            onStopEditing()
          }}
          onEscape={onStopEditing}
          onCancel={onStopEditing}
        />
      ) : (
        <p className="break-words whitespace-pre-wrap text-fg-2">{comment.text}</p>
      )}
    </div>
  )
}

function CardButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onMouseDown={(event) => event.preventDefault()} onClick={onClick} className="grid size-6 shrink-0 place-items-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg [&_svg]:size-4">
      {children}
    </button>
  )
}

/** The menu of a comment or a reply: change what it says, or delete it. */
function MoreMenu({ label, onEdit, onDelete }: { label: string; onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onClick={() => setOpen(!open)}
        className={cn('grid size-6 place-items-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg [&_svg]:size-4', open && 'bg-white/10 text-fg')}
      >
        <IconDots />
      </button>
      {open && (
        <Menu
          className="top-full mt-1 min-w-36"
          onClose={() => setOpen(false)}
          items={[
            { id: 'edit', label: 'Edit', onSelect: onEdit },
            { id: 'delete', label: 'Delete', danger: true, onSelect: onDelete }
          ]}
        />
      )}
    </div>
  )
}

const QUOTE = 'mb-2 line-clamp-2 border-l-2 border-warn/70 pl-2 text-[11.5px] break-words whitespace-pre-wrap text-fg-3'

function ThreadCard({ thread, active, editor, now, list }: { thread: ThreadView; active: boolean; editor: Editor; now: number; list: HTMLElement | null }) {
  const card = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const view = editor.view

  useEffect(() => {
    if (active) {
      keepInList(list, card.current)
    }
  }, [active, list])

  const pick = (event: MouseEvent | KeyboardEvent) => {
    if (event.target instanceof Element && event.target.closest('button, textarea, input, label, [role="menu"]')) {
      return
    }

    showThread(view, thread.id)
  }

  const save = (id: string) => (text: string) => applyLive(view, editComment(id, text))
  const more = (id: string, label: string) => <MoreMenu label={label} onEdit={() => setEditing(id)} onDelete={() => removeThread(view, id)} />

  return (
    <div
      ref={card}
      role="article"
      tabIndex={0}
      aria-label={`Comment by ${thread.author || 'an unknown author'}`}
      onClick={pick}
      onKeyDown={(event) => event.key === 'Enter' && event.target === event.currentTarget && pick(event)}
      className={cn('glass-card flex flex-col gap-2.5 rounded-xl p-3 text-[12.5px] outline-none', active ? 'glass-card-selected' : 'glass-card-hover cursor-pointer', thread.resolved && 'opacity-80')}
    >
      <div className="flex flex-col">
        {thread.placed ? <p className={QUOTE}>{thread.quote}</p> : <p className="mb-2 text-[11.5px] text-fg-3 italic">The text was removed</p>}
        <Entry
          comment={thread}
          now={now}
          editing={editing === thread.id}
          onSave={save(thread.id)}
          onStopEditing={() => setEditing(null)}
          actions={
            <>
              {thread.resolved ? (
                <CardButton label="Reopen" onClick={() => resolveThread(view, thread.id, false)}>
                  <IconArrowBackUp />
                </CardButton>
              ) : (
                <CardButton label="Resolve" onClick={() => resolveThread(view, thread.id)}>
                  <IconCheck />
                </CardButton>
              )}
              {more(thread.id, 'More for this comment')}
            </>
          }
        />
      </div>
      {thread.replies.map((reply) => (
        <div key={reply.id} className="border-t border-line pt-2.5">
          <Entry comment={reply} small now={now} editing={editing === reply.id} onSave={save(reply.id)} onStopEditing={() => setEditing(null)} actions={<div className="opacity-0 group-hover/entry:opacity-100 focus-within:opacity-100">{more(reply.id, 'More for this reply')}</div>} />
        </div>
      ))}
      {active && !thread.resolved && <Composer placeholder="Reply" action="Reply" signs onPost={(text, author) => applyLive(view, replyToComment(thread.id, text, author))} />}
    </div>
  )
}

function DraftCard({ editor, quote, list }: { editor: Editor; quote: string; list: HTMLElement | null }) {
  const card = useRef<HTMLDivElement>(null)
  const request = useStore($composeRequest)
  const view = editor.view

  useEffect(() => keepInList(list, card.current), [list, request])

  return (
    <div ref={card} className="glass-card glass-card-selected flex flex-col rounded-xl p-3 text-[12.5px]">
      <p className={QUOTE}>{quote}</p>
      <Composer
        placeholder="Add a comment"
        action="Comment"
        focusRequest={request || 1}
        signs
        onPost={(text, author) => postComment(view, text, author)}
        onEscape={(text) => (text.trim() ? leaveComment(view) : cancelComment(view, true))}
        onCancel={() => cancelComment(view, true)}
      />
    </div>
  )
}

/** Who the person's comments are by, and a way to change it. */
function AuthorLine() {
  const author = useStore($author)
  const [name, setName] = useState<string | null>(null)

  if (!author) {
    return null
  }

  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-t border-line px-3 text-[11.5px] text-fg-3">
      {name === null ? (
        <>
          <span className="min-w-0 truncate">
            Commenting as <span className="text-fg-2">{author}</span>
          </span>
          <button type="button" onClick={() => setName(author)} className="shrink-0 text-accent-strong hover:underline">
            Change
          </button>
        </>
      ) : (
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setName(null)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && name.trim()) {
              setAuthor(name)
              setName(null)
            } else if (event.key === 'Escape') {
              event.stopPropagation()
              setName(null)
            }
          }}
          aria-label="Your name, shown on your comments"
          className="glass-input h-7 min-w-0 flex-1 rounded-md px-2 text-[12px] text-fg outline-none"
        />
      )}
    </div>
  )
}

function CommentsColumn({ editor, docKey }: { editor: Editor; docKey: string }) {
  const view = useEditorState({ editor, selector: ({ editor: current }) => (current.isDestroyed ? null : panelView(current)) })
  const chosen = useStore($commentsShown)[docKey]
  const [showResolved, setShowResolved] = useState(false)
  const [list, setList] = useState<HTMLDivElement | null>(null)
  const now = useNow()

  if (!view || !(chosen ?? (view.threads.length > 0 || view.draft !== null))) {
    return null
  }

  const open = view.threads.filter((thread) => !thread.resolved)
  const resolved = view.threads.filter((thread) => thread.resolved)
  const card = (thread: ThreadView) => <ThreadCard key={thread.id} thread={thread} active={thread.id === view.active} editor={editor} now={now} list={list} />
  const cards = open.map(card)

  if (view.draft) {
    cards.splice(view.draft.before, 0, <DraftCard key="draft" editor={editor} quote={view.draft.quote} list={list} />)
  }

  const newComment = () => {
    if (!startComment(editor.view, docKey)) {
      docsSession.notify('Select some text to comment on')
    }
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-line" aria-label="Comments">
      <header className="flex h-10 shrink-0 items-center gap-0.5 border-b border-line pr-1.5 pl-3">
        <h2 className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-fg">
          Comments{open.length > 0 && <span className="ml-1.5 font-normal text-fg-3 tabular-nums">{open.length}</span>}
        </h2>
        <ToolButton label="New comment" shortcut="mod+alt+m" onClick={newComment}>
          <IconMessagePlus />
        </ToolButton>
        <ToolButton label="Hide comments" onClick={() => $commentsShown.setKey(docKey, false)}>
          <IconX />
        </ToolButton>
      </header>
      <div ref={setList} className="relative flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {cards}
        {!cards.length && (
          <div className="px-2 py-8 text-center text-[12px] text-fg-3">
            <p className="text-fg-2">No comments yet</p>
            <p className="mt-1">Select some text, then choose New Comment ({keysLabel('mod+alt+m')}).</p>
          </div>
        )}
        {resolved.length > 0 && (
          <div className="flex flex-col gap-3">
            <button type="button" aria-expanded={showResolved} onClick={() => setShowResolved(!showResolved)} className="flex items-center gap-1 self-start rounded-md px-1 py-0.5 text-[11.5px] font-medium text-fg-3 hover:text-fg-2">
              {showResolved ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
              Resolved ({resolved.length})
            </button>
            {showResolved && resolved.map(card)}
          </div>
        )}
      </div>
      <AuthorLine />
    </aside>
  )
}

/** The comments beside the pages (when the document has some, or the person asked for them), and the bar of a selected table of contents. */
export function CommentsPanel({ editor, docKey }: { editor: Editor; docKey: string }): ReactNode {
  return (
    <>
      <TocBar editor={editor} docKey={docKey} />
      <CommentsColumn editor={editor} docKey={docKey} />
    </>
  )
}
