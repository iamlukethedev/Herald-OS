import { IconPlus, IconTag } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import { quoteSheet } from '../../../../../shared/office/xlsx/address.ts'
import { nameProblem } from '../../../../../shared/office/xlsx/rules.ts'
import { GlassButton } from '../../../../components/ui/glass.tsx'
import { cn } from '../../../../lib/cn.ts'
import { messageOf } from '../../../canvas/errors.ts'
import { Modal } from '../../shell/dialogs.tsx'
import { liveTarget, selectionIn } from '../live.ts'
import { closeDialog, openDialog } from '../ui/overlay.tsx'
import { createName, deleteName, goToName, listNames, type NamedRange, updateName } from './model.ts'

/* Data → Named ranges…: the workbook's names with what each stands for; new, edit, delete and go to. */

/** "B2:D9" as "$B$2:$D$9", "C:C" as "$C:$C". */
const absolute = (range: string): string =>
  range
    .split(':')
    .map((part) => part.replace(/^\$?([A-Za-z]*)\$?(\d*)$/, (_whole, column: string, row: string) => `${column ? `$${column.toUpperCase()}` : ''}${row ? `$${row}` : ''}`))
    .join(':')

/** What a new name starts as: the selection, named after the text of its first cell when that makes a name. */
function fromSelection(docKey: string): { name: string; refersTo: string } {
  const target = liveTarget(docKey)
  const selection = selectionIn(docKey)

  if (!target || !selection) {
    return { name: '', refersTo: '' }
  }

  const corner = selection.range.split(':')[0]
  const first = /^[A-Za-z]+\d+$/.test(corner) ? target.workbook.getActiveSheet().getRange(corner).getDisplayValue().trim().replace(/\s+/g, '_') : ''

  return { name: first && !nameProblem(first) ? first : '', refersTo: `=${quoteSheet(selection.sheet)}!${absolute(selection.range)}` }
}

type Mode = { kind: 'list' } | { kind: 'edit'; name: NamedRange | null } | { kind: 'delete'; name: NamedRange }

const field = 'glass-input h-8 min-w-0 rounded-lg px-2.5 text-[12.5px] text-fg outline-none'

function NameForm({ docKey, editing, onDone }: { docKey: string; editing: NamedRange | null; onDone: () => void }) {
  const start = useMemo(() => (editing ? { name: editing.name, refersTo: editing.refersTo } : fromSelection(docKey)), [docKey, editing])
  const sheets = useMemo(() => liveTarget(docKey)?.workbook.getSheets().map((sheet) => sheet.getSheetName()) ?? [], [docKey])
  const [name, setName] = useState(start.name)
  const [refersTo, setRefersTo] = useState(start.refersTo)
  const [scope, setScope] = useState(editing?.scope ?? 'workbook')
  const [comment, setComment] = useState(editing?.comment ?? '')
  const [error, setError] = useState('')
  const problem = name.trim() ? nameProblem(name.trim()) : null

  const save = async () => {
    const target = liveTarget(docKey)

    if (!target) {
      return
    }

    try {
      if (editing) {
        await updateName(target, { name: editing.name, scope: editing.scope, newName: name, refersTo, comment })
      } else {
        await createName(target, { name, refersTo, scope, comment })
      }

      onDone()
    } catch (failure) {
      setError(messageOf(failure))
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
        Name
        <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Costs" aria-invalid={Boolean(problem)} className={cn(field, problem && 'ring-1 ring-danger/60')} />
        {problem && <span className="text-[11.5px] text-danger">{problem}</span>}
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
        Refers to
        <input value={refersTo} onChange={(event) => setRefersTo(event.target.value)} placeholder="=Sheet1!$B$2:$B$9 or =0.07" className={cn(field, 'font-mono text-[12px]')} />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
        Scope
        <select value={scope} disabled={Boolean(editing)} onChange={(event) => setScope(event.target.value)} className={cn(field, 'disabled:opacity-60')}>
          <option value="workbook">Workbook</option>
          {sheets.map((sheet) => (
            <option key={sheet} value={sheet}>
              {sheet}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
        Comment
        <textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={2} maxLength={255} className="glass-input min-w-0 resize-none rounded-lg px-2.5 py-1.5 text-[12.5px] text-fg outline-none" />
      </label>
      {error && <p className="text-[12px] text-danger">{error}</p>}
      <div className="mt-1 flex justify-end gap-2">
        <GlassButton variant="ghost" onClick={onDone}>
          Cancel
        </GlassButton>
        <GlassButton variant="primary" type="submit" disabled={!name.trim() || Boolean(problem) || !refersTo.trim()}>
          {editing ? 'Save' : 'Add name'}
        </GlassButton>
      </div>
    </form>
  )
}

function NameManager({ docKey }: { docKey: string }) {
  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  const [, setVersion] = useState(0)
  const [picked, setPicked] = useState<string | null>(null)
  const [error, setError] = useState('')
  const target = liveTarget(docKey)
  const names = target ? listNames(target) : []
  const keyOf = (name: NamedRange) => `${name.scope}\u0000${name.name}`
  const chosen = names.find((name) => keyOf(name) === picked) ?? null
  const back = () => {
    setMode({ kind: 'list' })
    setError('')
    setVersion((n) => n + 1)
  }

  const goTo = (name: NamedRange) => {
    try {
      goToName(liveTarget(docKey)!, { name: name.name, scope: name.scope })
      closeDialog()
    } catch (failure) {
      setError(messageOf(failure))
    }
  }

  const remove = async (name: NamedRange) => {
    try {
      await deleteName(liveTarget(docKey)!, { name: name.name, scope: name.scope })
      setPicked(null)
      back()
    } catch (failure) {
      setError(messageOf(failure))
    }
  }

  if (mode.kind === 'edit') {
    return (
      <Modal title={mode.name ? `Edit “${mode.name.name}”` : 'New name'} onClose={closeDialog}>
        <NameForm docKey={docKey} editing={mode.name} onDone={back} />
      </Modal>
    )
  }

  if (mode.kind === 'delete') {
    return (
      <Modal title={`Delete “${mode.name.name}”?`} onClose={closeDialog}>
        <p className="mb-5 text-[12.5px] text-fg-2">Formulas that use {mode.name.name} will show #NAME? until a name like it is back. Undo brings it back.</p>
        {error && <p className="mb-3 text-[12px] text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <GlassButton variant="ghost" onClick={back}>
            Cancel
          </GlassButton>
          <GlassButton variant="danger" autoFocus onClick={() => void remove(mode.name)}>
            Delete
          </GlassButton>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Named ranges" onClose={closeDialog}>
      {names.length ? (
        <div role="listbox" aria-label="Names" className="-mx-1 mb-3 flex max-h-64 flex-col gap-0.5 overflow-y-auto px-1">
          {names.map((name) => (
            <button
              key={keyOf(name)}
              type="button"
              role="option"
              aria-selected={keyOf(name) === picked}
              onClick={() => setPicked(keyOf(name))}
              onDoubleClick={() => goTo(name)}
              title={name.comment || undefined}
              className={cn('flex h-9 items-center gap-2.5 rounded-md px-2 text-left transition-colors duration-120', keyOf(name) === picked ? 'bg-accent-soft' : 'hover:bg-white/8')}
            >
              <IconTag size={14} className="shrink-0 text-fg-3" />
              <span className="w-28 shrink-0 truncate text-[12.5px] text-fg">{name.name}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-2">{name.refersTo}</span>
              <span className="max-w-24 shrink-0 truncate text-[11px] text-fg-3">{name.scope === 'workbook' ? 'Workbook' : name.scope}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="mb-4 text-[12.5px] text-fg-2">No named ranges yet. A name stands for cells or a value, so formulas can say =SUM(Costs) rather than =SUM(B2:B9).</p>
      )}
      {chosen?.comment && <p className="mb-3 text-[11.5px] text-fg-3">{chosen.comment}</p>}
      {error && <p className="mb-3 text-[12px] text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <GlassButton size="sm" onClick={() => setMode({ kind: 'edit', name: null })}>
          <IconPlus />
          New…
        </GlassButton>
        <GlassButton size="sm" disabled={!chosen} onClick={() => chosen && setMode({ kind: 'edit', name: chosen })}>
          Edit…
        </GlassButton>
        <GlassButton size="sm" disabled={!chosen} onClick={() => chosen && setMode({ kind: 'delete', name: chosen })}>
          Delete
        </GlassButton>
        <GlassButton size="sm" disabled={!chosen} onClick={() => chosen && goTo(chosen)}>
          Go to
        </GlassButton>
        <GlassButton size="sm" variant="primary" className="ml-auto" onClick={closeDialog}>
          Close
        </GlassButton>
      </div>
    </Modal>
  )
}

/** Open the Name manager over a document's sheet. */
export function openNameManager(docKey: string): void {
  openDialog(docKey, <NameManager key={Date.now()} docKey={docKey} />)
}
