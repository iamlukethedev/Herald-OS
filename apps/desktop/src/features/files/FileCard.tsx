import { IconCopy, IconExternalLink, IconFile, IconFileText, IconFolderFilled, IconFolderOpen, IconMessage, IconPencil, IconPhotoEdit, IconPresentation, IconTable, IconTrash } from '@tabler/icons-react'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { canOpenInCanvas } from '../../../shared/canvas/files.ts'
import { OFFICE_APP_NAMES } from '../../../shared/office/files.ts'
import { officeAppForFile } from '../office/open.ts'
import { MoreButton } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { formatBytes, formatRelative } from '../../lib/format.ts'
import { revealLabel } from '../../lib/platform-labels.ts'
import { DRAG_MIME, type FileItem, extBadge, fileMeta, useDirCount, useInView, useThumbnail } from './files-store.ts'
import { Menu, type MenuItemDef } from './Menu.tsx'

export type CardAction = 'open' | 'reveal' | 'rename' | 'copy-path' | 'trash' | 'ask' | 'edit-canvas' | 'edit-office'

const OFFICE_ICONS = { docs: <IconFileText />, sheets: <IconTable />, slides: <IconPresentation /> }

export interface FileCardProps {
  item: FileItem
  selected: boolean
  renaming: boolean
  onSelect: () => void
  onOpen: () => void
  onAction: (action: CardAction) => void
  onRename: (name: string) => void
  onCancelRename: () => void
}

function buildMenu(item: FileItem, onAction: (action: CardAction) => void): MenuItemDef[] {
  const editable = canOpenInCanvas(item.path) && (item.kind !== 'directory' || item.path.toLowerCase().endsWith('.comp'))
  const office = item.kind === 'file' ? officeAppForFile(item.path) : null

  return [
    { id: 'open', label: 'Open', icon: <IconExternalLink />, onSelect: () => onAction('open') },
    ...(editable ? [{ id: 'edit-canvas', label: 'Edit in Herald Canvas', icon: <IconPhotoEdit />, onSelect: () => onAction('edit-canvas') }] : []),
    ...(office ? [{ id: 'edit-office', label: `Edit in ${OFFICE_APP_NAMES[office]}`, icon: OFFICE_ICONS[office], onSelect: () => onAction('edit-office') }] : []),
    { id: 'reveal', label: revealLabel(), icon: <IconFolderOpen />, onSelect: () => onAction('reveal') },
    { id: 'rename', label: 'Rename', icon: <IconPencil />, onSelect: () => onAction('rename') },
    { id: 'copy', label: 'Copy path', icon: <IconCopy />, onSelect: () => onAction('copy-path') },
    { id: 'ask', label: 'Ask Hermes about this', icon: <IconMessage />, onSelect: () => onAction('ask'), dividerBefore: true },
    { id: 'trash', label: item.kind === 'directory' ? 'Move folder to Trash' : 'Move to Trash', icon: <IconTrash />, onSelect: () => onAction('trash'), danger: true, dividerBefore: true }
  ]
}

function startDrag(event: React.DragEvent, item: FileItem): void {
  event.dataTransfer.setData(DRAG_MIME, item.path)
  event.dataTransfer.setData('text/plain', item.path)
  event.dataTransfer.effectAllowed = 'move'
}

/** Inline rename field: Enter commits, Escape cancels, blur commits (unless `commitOnBlur` is off). */
export function RenameField({ name, onCommit, onCancel, className, commitOnBlur = true }: { name: string; onCommit: (name: string) => void; onCancel: () => void; className?: string; commitOnBlur?: boolean }) {
  const [value, setValue] = useState(name)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    const node = ref.current

    if (!node) {
      return
    }

    node.focus()
    const dot = name.lastIndexOf('.')
    node.setSelectionRange(0, dot > 0 ? dot : name.length)
  }, [name])

  const finish = (commit: boolean) => {
    if (done.current) {
      return
    }

    done.current = true

    if (commit) {
      onCommit(value)
    } else {
      onCancel()
    }
  }

  return (
    <input
      ref={ref}
      value={value}
      aria-label="New name"
      onChange={event => setValue(event.target.value)}
      onClick={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
      onBlur={() => commitOnBlur && finish(true)}
      onKeyDown={event => {
        event.stopPropagation()

        if (event.key === 'Enter') {
          finish(true)
        } else if (event.key === 'Escape') {
          finish(false)
        }
      }}
      className={cn('glass-input h-7 w-full rounded-md px-2 text-[13px] text-fg outline-none', className)}
    />
  )
}

export function FolderGlyph({ size = 84, className }: { size?: number; className?: string }) {
  return (
    <span className={cn('inline-flex text-accent-strong drop-shadow-[0_10px_24px_rgba(0,20,90,.55)]', className)} aria-hidden="true">
      <IconFolderFilled size={size} stroke={1} />
    </span>
  )
}

export function Thumbnail({ item, size, inView, className, imgClassName }: { item: FileItem; size: number; inView: boolean; className?: string; imgClassName?: string }) {
  const thumb = useThumbnail(item.kind === 'file' ? item.path : null, size, inView)
  const badge = extBadge(item)

  return (
    <div className={cn('relative flex items-center justify-center overflow-hidden rounded-lg bg-black/18', className)}>
      {item.kind === 'directory' ? (
        <FolderGlyph />
      ) : thumb.url ? (
        <img src={thumb.url} alt="" draggable={false} className={cn('max-h-full max-w-full rounded-[3px] object-contain shadow-[0_6px_18px_rgba(0,8,50,.45)]', imgClassName)} />
      ) : thumb.loading || !inView ? (
        <div className="shimmer absolute inset-2 rounded-md" />
      ) : (
        <IconFile size={44} stroke={1.2} className="text-fg-4" />
      )}
      {badge && item.kind === 'file' && (
        <span className={cn('absolute bottom-2 left-2 inline-flex h-6 min-w-6 items-center justify-center rounded-md px-1.5 text-[10.5px] font-semibold tracking-wide shadow-[0_2px_8px_rgba(0,8,50,.45)]', badge.className)}>{badge.label}</span>
      )}
    </div>
  )
}

/** One entry in the grid: thumbnail or folder glyph, name, meta line, kebab menu. */
export function FileCard({ item, selected, renaming, onSelect, onOpen, onAction, onRename, onCancelRename }: FileCardProps) {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref)
  const count = useDirCount(item.kind === 'directory' ? item.path : null, inView)
  const [menu, setMenu] = useState(false)

  return (
    <div
      ref={ref}
      role="option"
      aria-selected={selected}
      aria-label={item.name}
      tabIndex={-1}
      data-path={item.path}
      data-os-target={`file:${item.path}`}
      draggable={!renaming}
      onDragStart={event => startDrag(event, item)}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={event => {
        event.preventDefault()
        onSelect()
        setMenu(true)
      }}
      className={cn('glass-card glass-card-hover relative flex cursor-pointer flex-col gap-2 rounded-xl p-3 text-left outline-none', selected && 'glass-card-selected', item.hidden && 'opacity-70', menu && 'z-30')}
    >
      <div className="absolute top-2 right-2 z-10" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
        <MoreButton aria-label={`More actions for ${item.name}`} onClick={() => setMenu(open => !open)} className="flex size-7 items-center justify-center rounded-lg text-fg-3 hover:bg-white/10 hover:text-fg" />
        {menu && <Menu items={buildMenu(item, onAction)} onClose={() => setMenu(false)} className="top-8" />}
      </div>

      <Thumbnail item={item} size={384} inView={inView} className="h-[120px] w-full p-2" imgClassName="max-h-[104px]" />

      <div className="flex min-w-0 flex-col gap-0.5 px-0.5">
        {renaming ? <RenameField name={item.name} onCommit={onRename} onCancel={onCancelRename} /> : <div className="truncate text-[13px] text-fg">{item.name}</div>}
        <div className="truncate text-[12px] text-fg-3">{fileMeta(item, count)}</div>
      </div>
    </div>
  )
}

/** Compact list-view row: name, size, modified. */
export function FileRow({ item, selected, renaming, onSelect, onOpen, onAction, onRename, onCancelRename }: FileCardProps) {
  const [menu, setMenu] = useState(false)
  const badge = extBadge(item)

  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={item.name}
      tabIndex={-1}
      data-path={item.path}
      data-os-target={`file:${item.path}`}
      draggable={!renaming}
      onDragStart={event => startDrag(event, item)}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={event => {
        event.preventDefault()
        onSelect()
        setMenu(true)
      }}
      className={cn('group relative flex h-9 cursor-pointer items-center gap-3 rounded-lg px-2.5 text-[12.5px] transition-colors duration-120', selected ? 'bg-accent-soft text-fg' : 'text-fg-2 hover:bg-white/5', item.hidden && 'opacity-70', menu && 'z-30')}
    >
      <span className="flex w-5 shrink-0 items-center justify-center">
        {item.kind === 'directory' ? (
          <IconFolderFilled size={17} className="text-accent-strong" />
        ) : badge ? (
          <span className={cn('inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] px-1 text-[8.5px] font-semibold', badge.className)}>{badge.label.slice(0, 3)}</span>
        ) : (
          <IconFile size={15} className="text-fg-4" />
        )}
      </span>
      <span className="min-w-0 flex-1">{renaming ? <RenameField name={item.name} onCommit={onRename} onCancel={onCancelRename} className="h-6 text-[12.5px]" /> : <span className="block truncate">{item.name}</span>}</span>
      <span className="w-20 shrink-0 text-right text-[11.5px] tabular-nums text-fg-4">{item.kind === 'directory' ? '' : formatBytes(item.size)}</span>
      <span className="w-20 shrink-0 text-right text-[11.5px] text-fg-4">{formatRelative(item.modifiedAt)}</span>
      <span className="relative shrink-0" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
        <MoreButton aria-label={`More actions for ${item.name}`} onClick={() => setMenu(open => !open)} className="flex size-7 items-center justify-center rounded-lg text-fg-3 reveal hover:bg-white/10 hover:text-fg" aria-expanded={menu} />
        {menu && <Menu items={buildMenu(item, onAction)} onClose={() => setMenu(false)} className="top-8" />}
      </span>
    </div>
  )
}
