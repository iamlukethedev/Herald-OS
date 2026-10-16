import { IconPlus, IconTrash, IconX } from '@tabler/icons-react'
import type { CalcNoteSummary } from '../../../../shared/calc.ts'
import { cn } from '../../../lib/cn.ts'
import { formatRelative } from '../../../lib/format.ts'
import { keysLabel } from '../../../lib/shortcuts.ts'
import { useMinute } from '../hooks.ts'

export interface NotesSidebarProps {
  notes: CalcNoteSummary[] | null
  activeId: string | null
  /** Over the editor in a narrow window, with a close button. */
  overlay: boolean
  reduced: boolean
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onClose: () => void
}

/** The list of notes: newest first, each with its title, when it changed and its first lines. */
export function NotesSidebar({ notes, activeId, overlay, reduced, onSelect, onNew, onDelete, onClose }: NotesSidebarProps) {
  // Each minute, so "5m ago" moves on.
  useMinute()

  return (
    <aside aria-label="Notes" className={cn('flex min-h-0 w-60 shrink-0 flex-col border-r border-line', overlay && 'float absolute inset-y-0 left-0 z-30 w-[min(17rem,85%)] border-r-0 rounded-r-xl', overlay && !reduced && 'animate-rise')}>
      <div className="flex h-10 shrink-0 items-center gap-1 pr-1.5 pl-3.5">
        <span className="min-w-0 flex-1 text-[12px] font-medium text-fg-3">Notes</span>
        <button type="button" aria-label="New note" title={`New note (${keysLabel('mod+n')})`} onClick={onNew} className="flex size-7 items-center justify-center rounded-lg text-fg-3 transition-colors duration-150 hover:bg-white/8 hover:text-fg">
          <IconPlus size={16} />
        </button>
        {overlay && (
          <button type="button" aria-label="Close the notes list" onClick={onClose} className="flex size-7 items-center justify-center rounded-lg text-fg-3 transition-colors duration-150 hover:bg-white/8 hover:text-fg">
            <IconX size={15} />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {notes === null ? (
          <div className="space-y-1.5 px-1 pt-1" aria-hidden="true">
            {[0, 1, 2].map(row => (
              <div key={row} className={cn('h-11 rounded-lg', !reduced && 'shimmer')} />
            ))}
          </div>
        ) : notes.length === 0 ? (
          <p className="px-2 pt-2 text-[12px] text-fg-4">No notes yet.</p>
        ) : (
          <ul className="space-y-0.5">
            {notes.map(note => {
              const active = note.id === activeId

              return (
                <li key={note.id} className="group/reveal-row relative">
                  <button
                    type="button"
                    data-os-target={`calc-note:${note.id}`}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => onSelect(note.id)}
                    className={cn('flex w-full flex-col gap-0.5 rounded-lg py-2 pr-9 pl-2.5 text-left transition-colors duration-150', active ? 'bg-accent-soft' : 'hover:bg-white/6')}
                  >
                    <span className="truncate text-[13px] font-medium text-fg">{note.title}</span>
                    <span className="truncate text-[12px] text-fg-3">
                      <span className="text-fg-4 tabular-nums">{formatRelative(note.updatedAt)}</span>
                      {note.preview && <span> · {note.preview}</span>}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${note.title}`}
                    title="Delete"
                    onClick={() => onDelete(note.id)}
                    className={cn('absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-fg-4 transition-[opacity,color,background-color] duration-150 hover:bg-white/8 hover:text-fg-2', !active && 'reveal')}
                  >
                    <IconTrash size={14} />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}
