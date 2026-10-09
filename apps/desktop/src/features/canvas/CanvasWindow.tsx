import { useStore } from '@nanostores/react'
import { IconFolderOpen, IconPhotoPlus, IconX } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { canOpenInCanvas, isProjectPath, projectContaining } from '../../../shared/canvas/files.ts'
import { GlassButton } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { Menu, type MenuItemDef } from '../files/Menu.tsx'
import { nudge, placeImage, setLayer } from './actions.ts'
import { stepThrough } from './agent-model.ts'
import { ContentFillDialog } from './ai/ContentFillDialog.tsx'
import { AskHermesField, GenerateDialog } from './ai/HermesPrompts.tsx'
import { ModelPrompt, ModelsDialog } from './ai/ModelDialogs.tsx'
import { RemoveBackgroundDialog } from './ai/RemoveBackgroundDialog.tsx'
import { CloseDialog, NewDocumentDialog, NotesDialog } from './dialogs.tsx'
import { CanvasSizeDialog, FillDialog, ImageSizeDialog, ModifySelectionDialog, NewGuideDialog, TrimDialog } from './edit-dialogs.tsx'
import type { CanvasDocument } from './engine/document.ts'
import { FilterDialog } from './FilterDialog.tsx'
import { loadFonts } from './fonts.ts'
import type { Raster, Rect } from './engine/raster.ts'
import { messageOf } from './errors.ts'
import { HistoryPanel } from './HistoryPanel.tsx'
import { useActiveDocument } from './hooks.ts'
import { LayersPanel } from './LayersPanel.tsx'
import { $dialog, type CanvasCommand, commandLabel, isEnabled, keysLabel, MENUS, runCommand, runShortcut } from './menus.ts'
import { OptionsBar } from './OptionsBar.tsx'
import { PropertiesPanel } from './PropertiesPanel.tsx'
import { Rulers } from './Rulers.tsx'
import { SelectMaskPanel } from './SelectMaskPanel.tsx'
import { $activeKey, $conflict, $documents, $notice, activate, notify, openPath, reportPresence, resolveConflict } from './store.ts'
import { HANDLERS } from './tools/index.ts'
import { settleTools } from './tools/sessions.ts'
import { $bucket, $gradient, $heal, $refineBrush, $spaceHeld, $tool, paintOptionsFor, resetColours, setTool, stepSize, swapColours, toolForKey } from './tools/state.ts'
import { ToolPalette } from './ToolPalette.tsx'
import { $panelTab, $pointer, $views, forgetView, type PanelTab, showPanel, zoomLabel } from './view-state.ts'
import { Viewport } from './Viewport.tsx'

const describe = messageOf

/** Number keys set an opacity: 1 is 10%, 0 is 100%, two quick digits (4 then 5) 45%. */
const typedOpacity = { digits: '', at: 0 }

function opacityFromKey(digit: string): number {
  const now = Date.now()
  const quick = now - typedOpacity.at < 600 && typedOpacity.digits.length === 1
  typedOpacity.digits = quick ? typedOpacity.digits + digit : digit
  typedOpacity.at = now

  if (typedOpacity.digits.length === 2) {
    const value = Number(typedOpacity.digits)

    return (value === 0 ? 100 : value) / 100
  }

  return (digit === '0' ? 100 : Number(digit) * 10) / 100
}

/** Set the opacity of the tool in hand (or the active layer's, with the Move tool) from a number key. */
function setOpacityFromKey(doc: CanvasDocument | null, digit: string): void {
  const opacity = opacityFromKey(digit)
  const tool = $tool.get()
  const options = paintOptionsFor(tool)

  if (options) {
    options.set({ ...options.get(), opacity })
  } else if (tool === 'bucket') {
    $bucket.set({ ...$bucket.get(), opacity })
  } else if (tool === 'gradient') {
    $gradient.set({ ...$gradient.get(), opacity })
  } else if (doc?.active && (tool === 'move' || !options)) {
    setLayer(doc, doc.active.id, { opacity }, 'Opacity Change')

    return
  }

  notify(`Opacity ${Math.round(opacity * 100)}%`)
}

const isTyping = (target: EventTarget | null): boolean => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

/** A menu's commands as the menu shows them, submenus included. */
function menuItems(commands: CanvasCommand[], doc: CanvasDocument | null): MenuItemDef[] {
  return commands.map((command) => ({
    id: command.id,
    label: commandLabel(command, doc),
    hint: command.shortcut ? keysLabel(command.shortcut) : undefined,
    disabled: !isEnabled(command, doc),
    checked: command.checked?.(doc),
    dividerBefore: command.dividerBefore,
    submenu: command.submenu && menuItems(command.submenu, doc),
    onSelect: () => runCommand(command, doc)
  }))
}

function MenuBar({ doc }: { doc: CanvasDocument | null }) {
  const [open, setOpen] = useState<string | null>(null)

  return (
    <div className="flex items-center gap-0.5" role="menubar">
      {MENUS.map((menu) => (
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
          {open === menu.id && (
            <Menu align="left" className="top-full mt-1 min-w-60" onClose={() => setOpen(null)} items={menuItems(menu.items, doc)} />
          )}
        </div>
      ))}
    </div>
  )
}

function Tabs({ documents, active }: { documents: CanvasDocument[]; active: CanvasDocument | null }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2" role="tablist">
      {documents.map((doc) => (
        <div
          key={doc.key}
          role="tab"
          aria-selected={doc === active}
          onClick={() => activate(doc.key)}
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
              $dialog.set({ kind: 'close', key: doc.key })
            }}
            className="grid size-5 place-items-center rounded text-fg-3 opacity-0 hover:bg-white/10 hover:text-fg group-hover:opacity-100"
          >
            <IconX size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

const bounds = new WeakMap<Raster, Rect | null>()

/** A selection's bounds, worked out once per selection. */
function selectionBounds(selection: Raster | null): Rect | null {
  if (!selection) {
    return null
  }

  if (!bounds.has(selection)) {
    bounds.set(selection, selection.opaqueBounds())
  }

  return bounds.get(selection) ?? null
}

function StatusBar({ doc }: { doc: CanvasDocument | null }) {
  const views = useStore($views)
  const pointer = useStore($pointer)
  const notice = useStore($notice)
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

  const view = doc ? views[doc.key] : undefined
  const selection = selectionBounds(doc?.state.selection ?? null)

  return (
    <div className="flex h-7 shrink-0 items-center gap-4 border-t border-line px-3 text-[11.5px] text-fg-3 tabular-nums">
      {doc && (
        <>
          {view && <span>{zoomLabel(view.zoom)}</span>}
          <span>
            {doc.state.width} × {doc.state.height} px
          </span>
          {pointer && (
            <span>
              {pointer.x}, {pointer.y}
            </span>
          )}
          {selection && (
            <span>
              Selection {selection.width} × {selection.height}
            </span>
          )}
        </>
      )}
      <span className={cn('ml-auto truncate', fresh && notice.tone === 'error' && 'text-danger')}>
        {fresh ? notice.message : doc ? (doc.path ? (doc.modified ? 'Edited' : 'Saved') : 'Not saved yet') : ''}
      </span>
      {doc && <AskHermesField doc={doc} />}
    </div>
  )
}

function ConflictBar() {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-line bg-warn/10 px-3 py-1.5 text-[12px] text-fg-2">
      <span className="flex-1">This project changed on disk while it had unsaved edits here.</span>
      <GlassButton size="sm" variant="ghost" onClick={() => void resolveConflict('mine')}>
        Keep mine
      </GlassButton>
      <GlassButton size="sm" variant="primary" onClick={() => void resolveConflict('theirs')}>
        Load theirs
      </GlassButton>
    </div>
  )
}

const PROPERTIES_HEIGHT_KEY = 'herald-canvas.properties-height'

const PANEL_TABS: { id: PanelTab; label: string }[] = [
  { id: 'properties', label: 'Properties' },
  { id: 'history', label: 'History' }
]

function PanelTabs() {
  const tab = useStore($panelTab)

  return (
    <div role="tablist" aria-label="Panels" className="flex shrink-0 items-center gap-0.5">
      {PANEL_TABS.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="tab"
          aria-selected={tab === entry.id}
          onClick={() => showPanel(entry.id)}
          className={cn('h-6 rounded-md px-2 text-[11px] font-medium tracking-wide uppercase', tab === entry.id ? 'bg-white/10 text-fg-2' : 'text-fg-3 hover:text-fg-2')}
        >
          {entry.label}
        </button>
      ))}
    </div>
  )
}

/** Layers above, and Properties or History below, with a divider to share the height between them. */
function SidePanels({ doc }: { doc: CanvasDocument }) {
  const [height, setHeight] = useState(() => Number(globalThis.localStorage?.getItem(PROPERTIES_HEIGHT_KEY)) || 340)
  const tab = useStore($panelTab)
  const aside = useRef<HTMLElement>(null)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startY = event.clientY
    const start = height
    const total = aside.current?.clientHeight ?? 800
    let last = start
    const move = (e: PointerEvent) => {
      last = Math.round(Math.max(140, Math.min(total - 180, start - (e.clientY - startY))))
      setHeight(last)
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      globalThis.localStorage?.setItem(PROPERTIES_HEIGHT_KEY, String(last))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }

  return (
    <aside ref={aside} className="flex w-72 shrink-0 flex-col border-l border-line" aria-label="Panels">
      <LayersPanel doc={doc} />
      <div role="separator" aria-orientation="horizontal" aria-label="Resize the Properties panel" onPointerDown={onPointerDown} className="h-1.5 shrink-0 cursor-row-resize border-t border-line hover:bg-accent/30" />
      <div className="flex min-h-0 shrink-0 flex-col" style={{ height, maxHeight: '65%' }}>
        {tab === 'history' ? <HistoryPanel doc={doc} header={<PanelTabs />} /> : <PropertiesPanel doc={doc} header={<PanelTabs />} />}
      </div>
    </aside>
  )
}

function StartScreen() {
  const open = async () => {
    const file = await window.heraldOS.canvas.pickOpen()

    if (file) {
      openPath(file).catch((error: unknown) => notify(`Could not open ${file.split('/').pop()}: ${describe(error)}`, 'error'))
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-5 p-8 text-center">
      <div>
        <div className="text-[18px] font-medium text-fg">Herald Canvas</div>
        <div className="mt-1 text-[12.5px] text-fg-3">Layers, masks and blend modes, on the GPU. Hermes can edit along with you.</div>
      </div>
      <div className="flex gap-2">
        <GlassButton variant="primary" onClick={() => $dialog.set({ kind: 'new' })}>
          <IconPhotoPlus size={16} /> New image
        </GlassButton>
        <GlassButton onClick={() => void open()}>
          <IconFolderOpen size={16} /> Open…
        </GlassButton>
      </div>
      <div className="text-[11.5px] text-fg-3">Or drop an image or a .comp project here.</div>
    </div>
  )
}

/** Herald Canvas: a layered image editor in a Herald window. */
export function CanvasWindow({ payload }: { payload?: Record<string, unknown> }) {
  const documents = useStore($documents)
  const doc = useActiveDocument()
  const dialog = useStore($dialog)
  const conflict = useStore($conflict)
  const root = useRef<HTMLDivElement>(null)
  const requested = typeof payload?.path === 'string' ? payload.path : null
  const requestedAt = payload?.at

  // A file handed over by Herald (Edit in Canvas, Hermes, the launcher), or Hermes's undo and redo.
  const command = typeof payload?.command === 'string' ? payload.command : null
  const steps = typeof payload?.steps === 'number' ? payload.steps : 1
  useEffect(() => {
    if (command === 'undo' || command === 'redo') {
      const target = $documents.get().find((entry) => entry.path === requested) ?? $documents.get().find((entry) => entry.key === $activeKey.get())
      const labels = target ? stepThrough(target, command, steps) : []
      notify(labels.length ? `${command === 'undo' ? 'Undid' : 'Redid'} ${labels.join(', ')}` : command === 'undo' ? 'Nothing to undo' : 'Nothing to redo')
    } else if (requested) {
      openPath(requested).catch((error: unknown) => notify(`Could not open ${requested.split('/').pop()}: ${describe(error)}`, 'error'))
    }
  }, [command, requested, requestedAt, steps])

  // Views of closed documents go with them.
  useEffect(() => {
    const open = new Set(documents.map((entry) => entry.key))
    Object.keys($views.get())
      .filter((key) => !open.has(key))
      .forEach(forgetView)
  }, [documents])

  // The computer's fonts, so text layers name and draw their faces exactly.
  useEffect(() => void loadFonts(), [])

  useEffect(() => {
    const release = () => $spaceHeld.set(false)
    window.addEventListener('blur', release)

    return () => window.removeEventListener('blur', release)
  }, [])

  // Main keeps track of what each Canvas window has open (Hermes's commands work on the image in front).
  const revision = doc?.revision
  useEffect(() => {
    const timer = setTimeout(() => reportPresence(), 300)

    return () => clearTimeout(timer)
  }, [documents, doc, revision])

  useEffect(() => {
    const element = root.current
    const focused = () => reportPresence(true)
    reportPresence(true)
    element?.addEventListener('focusin', focused)

    return () => {
      element?.removeEventListener('focusin', focused)
      window.heraldOS.canvas.report({ active: null, documents: [] })
    }
  }, [])

  useEffect(() => {
    if (!$activeKey.get() && documents.length) {
      activate(documents[0].key)
    }
  }, [documents])

  // A dialog closed: the window takes the keys back.
  useEffect(() => {
    if (!dialog && (!document.activeElement || document.activeElement === document.body)) {
      root.current?.focus({ preventScroll: true })
    }
  }, [dialog])

  // Another document in front: what a tool had open on the last one is put in first.
  const shown = useRef(doc)
  useEffect(() => {
    if (shown.current && shown.current !== doc) {
      settleTools(shown.current)
    }

    shown.current = doc
  }, [doc])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (isTyping(event.target) || dialog) {
      return
    }

    // The tool in hand first: Enter and Escape end a transform or a crop, Backspace takes back a lasso corner.
    if (doc && !event.metaKey && !event.ctrlKey && HANDLERS[$tool.get()]?.key?.(doc, event.nativeEvent)) {
      event.preventDefault()
      event.stopPropagation()

      return
    }

    if (runShortcut(event, doc)) {
      event.preventDefault()
      event.stopPropagation()

      return
    }

    if (event.key === ' ') {
      event.preventDefault()
      $spaceHeld.set(true)

      return
    }

    if (event.metaKey || event.ctrlKey || event.altKey) {
      return
    }

    const code = event.code
    const letter = /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : event.key.toLowerCase()
    const tool = toolForKey(letter, event.shiftKey)

    if (tool) {
      setTool(tool)

      return
    }

    if (letter === 'x') {
      swapColours()

      return
    }

    if (letter === 'd') {
      resetColours()

      return
    }

    if (code === 'BracketLeft' || code === 'BracketRight') {
      const options = paintOptionsFor($tool.get())
      const direction = code === 'BracketRight' ? 1 : -1

      if (options) {
        const current = options.get()
        options.set(event.shiftKey ? { ...current, hardness: Math.max(0, Math.min(1, Math.round((current.hardness + direction * 0.25) * 4) / 4)) } : { ...current, size: stepSize(current.size, direction) })
      } else if ($tool.get() === 'heal') {
        $heal.set({ size: stepSize($heal.get().size, direction) })
      } else if ($tool.get() === 'refine') {
        $refineBrush.set({ size: stepSize($refineBrush.get().size, direction) })
      }

      return
    }

    if (/^Digit\d$/.test(code)) {
      setOpacityFromKey(doc, code.slice(5))

      return
    }

    if (!doc) {
      return
    }

    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }

    if (arrows[event.key] && $tool.get() === 'move') {
      event.preventDefault()
      const step = event.shiftKey ? 10 : 1
      nudge(doc, arrows[event.key][0] * step, arrows[event.key][1] * step)
    }
  }

  const onDrop = (event: React.DragEvent) => {
    const files = [...event.dataTransfer.files].map((file) => window.heraldOS.fs.pathForFile(file)).filter(Boolean)

    if (!files.length) {
      return
    }

    event.preventDefault()

    for (const file of files) {
      const project = isProjectPath(file) || projectContaining(file)

      if (doc && !project && canOpenInCanvas(file)) {
        placeImage(doc, file).catch((error: unknown) => notify(`Could not place ${file.split('/').pop()}: ${describe(error)}`, 'error'))
      } else if (project || canOpenInCanvas(file)) {
        openPath(file).catch((error: unknown) => notify(`Could not open ${file.split('/').pop()}: ${describe(error)}`, 'error'))
      } else {
        notify(`Herald Canvas does not open ${file.split('/').pop()}`, 'error')
      }
    }
  }

  return (
    <div
      ref={root}
      data-canvas-root
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => event.key === ' ' && $spaceHeld.set(false)}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
        }
      }}
      onDrop={onDrop}
      className="relative flex h-full min-h-0 flex-col outline-none"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
        <MenuBar doc={doc} />
        <Tabs documents={documents} active={doc} />
      </div>
      {doc && <OptionsBar doc={doc} />}
      {conflict && conflict.key === doc?.key && <ConflictBar />}
      <div className="flex min-h-0 flex-1">
        <ToolPalette />
        {doc ? (
          <Rulers doc={doc}>
            <Viewport doc={doc} />
          </Rulers>
        ) : (
          <StartScreen />
        )}
        {doc && <SidePanels doc={doc} />}
      </div>
      <StatusBar doc={doc} />
      {dialog?.kind === 'new' && <NewDocumentDialog />}
      {dialog?.kind === 'close' && <CloseDialog docKey={dialog.key} />}
      {doc && dialog?.kind === 'canvas-size' && <CanvasSizeDialog doc={doc} />}
      {doc && dialog?.kind === 'image-size' && <ImageSizeDialog doc={doc} />}
      {doc && dialog?.kind === 'trim' && <TrimDialog doc={doc} />}
      {doc && dialog?.kind === 'fill' && <FillDialog doc={doc} />}
      {doc && dialog?.kind === 'new-guide' && <NewGuideDialog doc={doc} />}
      {doc && dialog?.kind === 'filter' && <FilterDialog key={dialog.filter} doc={doc} kind={dialog.filter} />}
      {doc && dialog?.kind === 'modify-selection' && <ModifySelectionDialog doc={doc} change={dialog.change} />}
      {doc && dialog?.kind === 'remove-background' && <RemoveBackgroundDialog doc={doc} />}
      {doc && dialog?.kind === 'content-fill' && <ContentFillDialog doc={doc} />}
      {doc && dialog?.kind === 'generate' && <GenerateDialog doc={doc} mode={dialog.mode} />}
      {dialog?.kind === 'models' && <ModelsDialog />}
      {dialog?.kind === 'notes' && <NotesDialog title={dialog.title} notes={dialog.notes} />}
      {doc && <SelectMaskPanel />}
      <ModelPrompt />
    </div>
  )
}
