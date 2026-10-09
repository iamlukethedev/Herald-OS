import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useMemo, useState } from 'react'
import { GlassButton } from '../../../../components/ui/glass.tsx'
import { cn } from '../../../../lib/cn.ts'
import { messageOf } from '../../../canvas/errors.ts'
import { Modal } from '../../shell/dialogs.tsx'
import * as commands from './commands.ts'
import { type FileAccess, frontSheet, officeFiles, pickWorkbook, type PickedWorkbook, placeSheet, rangeSummary, type SheetPlacement, sheetsOf } from './from-files.ts'

/*
 * Insert > Table from Spreadsheet…: a spreadsheet is picked, then this dialog asks which of its
 * sheets, which range (its used range unless changed), whether the first row is a header, and
 * whether the table goes on the slide in front or on slides of its own after it.
 */

const $picked = atom<PickedWorkbook | null>(null)

/** Pick a spreadsheet, then ask how to place it. */
export async function chooseSheet(access: FileAccess = officeFiles()): Promise<void> {
  const picked = await pickWorkbook(access, commands.notify)

  if (picked) {
    $picked.set(picked)
  }
}

export function FromSheetDialog() {
  const picked = useStore($picked)

  return picked ? <SheetDialog key={picked.workbook.id} picked={picked} onClose={() => $picked.set(null)} /> : null
}

function SheetDialog({ picked, onClose }: { picked: PickedWorkbook; onClose: () => void }) {
  const { file, workbook } = picked
  const sheets = sheetsOf(workbook)
  const [sheet, setSheet] = useState(() => frontSheet(workbook)?.id ?? '')
  const used = (id: string) => {
    const summary = rangeSummary(workbook, id, '')

    return 'ref' in summary ? summary.ref : ''
  }
  const [range, setRange] = useState(() => used(sheet))
  const [header, setHeader] = useState(true)
  const [place, setPlace] = useState<SheetPlacement['place']>('slide')
  const summary = useMemo(() => rangeSummary(workbook, sheet, range), [workbook, sheet, range])
  const insert = () => {
    try {
      commands.change((deck, doc) => placeSheet(deck, doc.slideId, workbook, { sheet, range, header, place }))
      onClose()
    } catch (error) {
      commands.notify(`Could not place ${file}: ${messageOf(error)}`)
    }
  }
  const choice = (value: SheetPlacement['place'], label: string) => (
    <label className={cn('flex h-8 flex-1 cursor-pointer items-center justify-center rounded-md border border-line text-[12.5px] text-fg-2 hover:bg-white/8', place === value && 'border-accent text-fg')}>
      <input type="radio" name="place" value={value} checked={place === value} onChange={() => setPlace(value)} className="sr-only" />
      {label}
    </label>
  )

  return (
    <Modal title={`Table from ${file}`} onClose={onClose}>
      <form
        className="flex flex-col gap-3 text-[12.5px] text-fg-2"
        onSubmit={(event) => {
          event.preventDefault()
          insert()
        }}
      >
        {sheets.length > 1 && (
          <label className="flex items-center gap-3">
            <span className="w-16 shrink-0">Sheet</span>
            <select
              value={sheet}
              onChange={(event) => {
                setSheet(event.target.value)
                setRange(used(event.target.value))
              }}
              style={{ colorScheme: 'dark' }}
              className="glass-input h-8 min-w-0 flex-1 rounded-md px-2 text-[12.5px] text-fg outline-none"
            >
              {sheets.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-3">
          <span className="w-16 shrink-0">Range</span>
          <input autoFocus value={range} onChange={(event) => setRange(event.target.value)} placeholder="The cells in use" spellCheck={false} className="glass-input h-8 min-w-0 flex-1 rounded-md px-2 font-mono text-[12.5px] text-fg outline-none placeholder:font-sans placeholder:text-fg-4" />
        </label>
        <p className={cn('-mt-1 pl-[76px] text-[11.5px]', 'error' in summary ? 'text-danger' : 'text-fg-3')}>
          {'error' in summary ? summary.error : `${summary.ref}: ${summary.rows} ${summary.rows === 1 ? 'row' : 'rows'}, ${summary.columns} ${summary.columns === 1 ? 'column' : 'columns'}`}
        </p>
        <label className="flex items-center gap-2 pl-[76px]">
          <input type="checkbox" checked={header} onChange={(event) => setHeader(event.target.checked)} className="accent-(--color-accent)" />
          The first row is a header
        </label>
        <div className="flex gap-2">
          {choice('slide', 'On this slide')}
          {choice('slides', 'As new slides')}
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <GlassButton variant="ghost" onClick={onClose}>
            Cancel
          </GlassButton>
          <GlassButton type="submit" variant="primary" disabled={'error' in summary}>
            Insert
          </GlassButton>
        </div>
      </form>
    </Modal>
  )
}
