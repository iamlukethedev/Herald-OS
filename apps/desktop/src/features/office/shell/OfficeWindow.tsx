import { useStore } from '@nanostores/react'
import { IconFilePlus, IconFolderOpen, IconInfoCircle, IconPlus, IconX } from '@tabler/icons-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { OFFICE_APP_NAMES } from '../../../../shared/office/files.ts'
import { AppTile } from '../../../components/app-icon.tsx'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { keysLabel } from '../../../lib/shortcuts.ts'
import type { AppIconId } from '../../../shell/apps.ts'
import { messageOf } from '../../canvas/errors.ts'
import { Menu, type MenuItemDef } from '../../files/Menu.tsx'
import { bindOfficeRelay } from '../agent.ts'
import { $nameQuestion, loadCommentName } from '../comment-name.ts'
import { AskHermesBar } from '../hermes/AskHermesBar.tsx'
import type { OfficeSession } from '../session.ts'
import type { OfficeDocument } from '../types.ts'
import { CommentNamePrompt } from './CommentNamePrompt.tsx'
import { type OfficeCommand, type OfficeMenu, runShortcut } from './commands.ts'
import { CloseDialog, FidelityDialog, NotesDialog } from './dialogs.tsx'

export function menuItems(commands: readonly OfficeCommand[]): MenuItemDef[] {
  return commands.map((command) => ({
    id: command.id,
    label: command.label,
    hint: command.shortcut ? keysLabel(command.shortcut) : undefined,
    disabled: !(command.enabled?.() ?? true),
    checked: command.checked?.(),
    dividerBefore: command.dividerBefore,
    submenu: command.submenu && menuItems(command.submenu),
    onSelect: command.run
  }))
}

function MenuBar({ menus }: { menus: readonly OfficeMenu[] }) {
  const [open, setOpen] = useState<string | null>(null)

  return (
    <div className="flex items-center gap-0.5" role="menubar">
      {menus.map((menu) => (
        <div key={menu.id} className="relative">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === menu.id}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => setOpen(open === menu.id ? null : menu.id)}
            onMouseEnter={() => open && open !== menu.id && setOpen(menu.id)}
            className={cn('h-7 rounded-md px-2.5 text-[12.5px] text-fg-2 hover:bg-white/8 hover:text-fg', open === menu.id && 'bg-white/10 text-fg')}
          >
            {menu.label}
          </button>
          {open === menu.id && <Menu align="left" className="top-full mt-1 min-w-60" onClose={() => setOpen(null)} items={menuItems(menu.items)} />}
        </div>
      ))}
    </div>
  )
}

function Tabs<Model>({ session, documents, active, onNew }: { session: OfficeSession<Model>; documents: OfficeDocument<Model>[]; active: OfficeDocument<Model> | null; onNew: () => void }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2" role="tablist">
      {documents.map((doc) => (
        <div
          key={doc.key}
          role="tab"
          aria-selected={doc === active}
          onClick={() => session.activate(doc.key)}
          className={cn('group flex h-7 max-w-52 shrink-0 cursor-default items-center gap-1.5 rounded-md pl-2.5 pr-1 text-[12px]', doc === active ? 'bg-white/10 text-fg' : 'text-fg-3 hover:bg-white/5 hover:text-fg-2')}
          title={doc.path ?? doc.name}
        >
          <span className="truncate">{doc.name}</span>
          {doc.modified && <span className="size-1.5 shrink-0 rounded-full bg-fg-3" aria-label="Unsaved changes" />}
          <button
            type="button"
            aria-label={`Close ${doc.name}`}
            onClick={(event) => {
              event.stopPropagation()
              session.$dialog.set({ kind: 'close', key: doc.key })
            }}
            className="grid size-5 place-items-center rounded text-fg-3 opacity-0 group-hover:opacity-100 hover:bg-white/10 hover:text-fg"
          >
            <IconX size={12} />
          </button>
        </div>
      ))}
      <button type="button" aria-label="New" title="New" onClick={() => onNew()} className="grid size-6 shrink-0 place-items-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg">
        <IconPlus size={14} />
      </button>
    </div>
  )
}

function ConflictBar<Model>({ session }: { session: OfficeSession<Model> }) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-line bg-warn/10 px-3 py-1.5 text-[12px] text-fg-2">
      <span className="flex-1">This file changed on disk while it had unsaved edits here.</span>
      <GlassButton size="sm" variant="ghost" onClick={() => void session.resolveConflict('mine')}>
        Keep mine
      </GlassButton>
      <GlassButton size="sm" variant="primary" onClick={() => void session.resolveConflict('theirs')}>
        Load theirs
      </GlassButton>
    </div>
  )
}

function StatusBar<Model>({ session, doc, noun }: { session: OfficeSession<Model>; doc: OfficeDocument<Model> | null; noun: string }) {
  const notice = useStore(session.$notice)
  const [now, setNow] = useState(Date.now())
  const fresh = notice && now - notice.at < 6000

  useEffect(() => {
    if (!notice) {
      return
    }

    setNow(Date.now())
    const timer = setTimeout(() => setNow(Date.now()), 6100)

    return () => clearTimeout(timer)
  }, [notice])

  const state = doc ? (doc.path ? (doc.modified ? (doc.autosave ? 'Saving soon' : 'Edited') : 'Saved') : 'Not saved yet') : ''
  const status = doc?.editor?.status()

  return (
    <div className="flex h-7 shrink-0 items-center gap-4 border-t border-line px-3 text-[11.5px] text-fg-3 tabular-nums">
      {doc && <span className="shrink-0">{state}</span>}
      {status && <span className="shrink-0">{status}</span>}
      {doc && doc.notes.length > 0 && (
        <button type="button" onClick={() => session.$dialog.set({ kind: 'notes', title: `Opening ${doc.name}`, notes: doc.notes })} className="flex shrink-0 items-center gap-1 text-fg-3 hover:text-fg">
          <IconInfoCircle size={13} /> Shown differently
        </button>
      )}
      <span className={cn('ml-auto min-w-0 truncate', fresh && notice.tone === 'error' && 'text-danger')}>{fresh ? notice.message : ''}</span>
      {doc && <AskHermesBar app={session.adapter.app} docKey={doc.key} noun={noun} focusDocument={() => doc.editor?.focus?.()} />}
    </div>
  )
}

function StartScreen<Model>({ session, start, canOpen, onNew }: { session: OfficeSession<Model>; start: StartInfo; canOpen: boolean; onNew: () => void }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-5 p-8 text-center">
      <AppTile id={start.icon} size={56} />
      <div>
        <div className="text-[18px] font-medium text-fg">{OFFICE_APP_NAMES[session.adapter.app]}</div>
        <div className="mt-1 max-w-md text-[12.5px] text-fg-3">{start.blurb}</div>
      </div>
      <div className="flex gap-2">
        <GlassButton variant="primary" onClick={() => onNew()}>
          <IconFilePlus size={16} /> {start.newLabel}
        </GlassButton>
        {canOpen && (
          <GlassButton onClick={() => void session.openPicked()}>
            <IconFolderOpen size={16} /> Open…
          </GlassButton>
        )}
      </div>
      {start.hint && <div className="text-[11.5px] text-fg-3">{start.hint}</div>}
    </div>
  )
}

export interface StartInfo {
  icon: AppIconId
  blurb: string
  newLabel: string
  hint?: string
}

export interface OfficeWindowProps<Model> {
  session: OfficeSession<Model>
  menus: readonly OfficeMenu[]
  payload?: Record<string, unknown>
  start: StartInfo
  noun: string
  canOpen: boolean
  /** Opens a dropped file, or says why not; null leaves drops alone. */
  onDropFile?: (file: string) => void
  /** What the person's New does (the tab bar's + and the start screen); a blank document without one. A `command: 'new'` payload is always blank. */
  onNew?: () => void
  /** One document's editor. Every open document keeps its editor once it has one; only the active one shows. */
  renderEditor: (doc: OfficeDocument<Model>, active: boolean) => ReactNode
  /**
   * A document gets its editor the first time it is in front (or a command wants one), not when the
   * window opens: for editors that cost a lot each, as a workbook's Univer and its worker do.
   */
  mountWhenShown?: boolean
  /** A bar under the menus for the active document (formatting tools and the like). */
  toolbar?: (doc: OfficeDocument<Model>) => ReactNode
}

/** The frame Herald Docs, Sheets and Slides share: menus, tabs, the editors, the status bar and dialogs. */
export function OfficeWindow<Model>({ session, menus, payload, start, noun, canOpen, onDropFile, onNew, renderEditor, mountWhenShown = false, toolbar }: OfficeWindowProps<Model>) {
  const documents = useStore(session.$documents)
  const activeKey = useStore(session.$activeKey)
  const dialog = useStore(session.$dialog)
  const conflict = useStore(session.$conflict)
  const awake = useStore(session.$awake)
  const root = useRef<HTMLDivElement>(null)
  const doc = documents.find((entry) => entry.key === activeKey) ?? null
  // Documents this window has shown keep their editors (and their undo) until they close.
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set(activeKey ? [activeKey] : []))

  if (activeKey && !shown.has(activeKey)) {
    setShown(new Set([...shown, activeKey]))
  }

  const hasEditor = (entry: OfficeDocument<Model>) => !mountWhenShown || entry === doc || shown.has(entry.key) || awake.has(entry.key)
  const requested = typeof payload?.path === 'string' ? payload.path : null
  const command = typeof payload?.command === 'string' ? payload.command : null
  const requestedAt = payload?.at
  const newDocument = onNew ?? (() => session.create())

  // A file handed over by Herald (Files, the viewer, Hermes), or a new document asked for.
  useEffect(() => {
    if (requested) {
      session.open(requested).catch((error: unknown) => session.notify(`Could not open ${requested.split('/').pop()}: ${messageOf(error)}`, 'error'))
    } else if (command === 'new') {
      session.create()
    }
  }, [requested, command, requestedAt])

  // Main keeps track of what each Office window has open (Hermes's commands work on what is in front).
  useEffect(() => {
    const element = root.current
    const focused = () => session.report(true)
    session.report(true)
    bindOfficeRelay()
    element?.addEventListener('focusin', focused)

    return () => {
      element?.removeEventListener('focusin', focused)
      window.heraldOS.office.report({ app: session.adapter.app, active: null, documents: [] })
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => session.report(), 300)

    return () => clearTimeout(timer)
  }, [documents, activeKey])

  // The name on the person's comments, with the one Herald Docs kept before, ready before their first comment.
  useEffect(() => {
    loadCommentName().catch(() => {})
  }, [])

  // A native listener: Univer's editors are React roots of their own, whose key events never reach
  // this root's React handlers. Stopping a handled key here keeps the desktop's own shortcuts out.
  useEffect(() => {
    const element = root.current
    const onKeyDown = (event: KeyboardEvent) => {
      if (!session.$dialog.get() && $nameQuestion.get()?.app !== session.adapter.app && runShortcut(event, menus)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    element?.addEventListener('keydown', onKeyDown)

    return () => element?.removeEventListener('keydown', onKeyDown)
  }, [menus])

  // Native for the same reason: a file dropped on a document lands in Univer's root.
  const dropFile = useRef(onDropFile)
  dropFile.current = onDropFile
  const takesDrops = Boolean(onDropFile)
  useEffect(() => {
    const element = root.current

    if (!element || !takesDrops) {
      return
    }

    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) {
        event.preventDefault()
      }
    }
    const onDrop = (event: DragEvent) => {
      const files = [...(event.dataTransfer?.files ?? [])].map((file) => window.heraldOS.fs.pathForFile(file)).filter(Boolean)

      if (files.length) {
        event.preventDefault()
        event.stopPropagation()
        files.forEach((file) => dropFile.current?.(file))
      }
    }
    element.addEventListener('dragover', onDragOver, true)
    element.addEventListener('drop', onDrop, true)

    return () => {
      element.removeEventListener('dragover', onDragOver, true)
      element.removeEventListener('drop', onDrop, true)
    }
  }, [takesDrops])

  return (
    <div
      ref={root}
      data-office-root={session.adapter.app}
      tabIndex={-1}
      className="relative flex h-full min-h-0 flex-col outline-none"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
        <MenuBar menus={menus} />
        <Tabs session={session} documents={documents} active={doc} onNew={newDocument} />
      </div>
      {doc && toolbar?.(doc)}
      {conflict && conflict.key === doc?.key && <ConflictBar session={session} />}
      <div className="relative flex min-h-0 flex-1">
        {documents.map((entry) => (
          <div key={entry.key} className={cn('absolute inset-0 flex', entry !== doc && 'pointer-events-none invisible')} aria-hidden={entry !== doc}>
            {hasEditor(entry) && renderEditor(entry, entry === doc)}
          </div>
        ))}
        {!doc && <StartScreen session={session} start={start} canOpen={canOpen} onNew={newDocument} />}
      </div>
      <StatusBar session={session} doc={doc} noun={noun} />
      {dialog?.kind === 'close' && <CloseDialog session={session} docKey={dialog.key} />}
      {dialog?.kind === 'fidelity' && <FidelityDialog session={session} docKey={dialog.key} notes={dialog.notes} losses={dialog.losses} resolve={dialog.resolve} />}
      {dialog?.kind === 'notes' && <NotesDialog session={session} title={dialog.title} notes={dialog.notes} />}
      <CommentNamePrompt app={session.adapter.app} />
    </div>
  )
}
