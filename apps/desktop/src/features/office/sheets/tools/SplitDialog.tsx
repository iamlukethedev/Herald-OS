import { useState } from 'react'
import { openDialog } from '../ui/overlay.tsx'
import { splitText } from './model.ts'
import type { Delimiter } from './text.ts'
import { Check, Choices, counted, Heading, Note, PreviewGrid, TextField, ToolDialog, useLive } from './ui.tsx'

/* Data → Split text to columns…: the delimiter, where the parts go, and the first rows as they would split. */

const DELIMITER_CHOICES: { id: Delimiter; label: string }[] = [
  { id: 'comma', label: 'Comma' },
  { id: 'semicolon', label: 'Semicolon' },
  { id: 'tab', label: 'Tab' },
  { id: 'space', label: 'Space' },
  { id: 'other', label: 'Other' }
]

function SplitDialog({ docKey, range, sheet }: { docKey: string; range: string; sheet: string }) {
  const [delimiter, setDelimiter] = useState<Delimiter>('comma')
  const [other, setOther] = useState('')
  const [consecutive, setConsecutive] = useState(false)
  const [destination, setDestination] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const args = { range, sheet, delimiter, other, consecutive, destination: destination.trim() || undefined, overwrite }
  const preview = useLive(docKey, (target) => (delimiter === 'other' && !other ? null : splitText(target, { ...args, preview: true })), [delimiter, other, consecutive, destination])
  const result = preview.value

  return (
    <ToolDialog
      docKey={docKey}
      title="Split text to columns"
      action="Split"
      ready={Boolean(result?.rows) && (!result?.overwrites || overwrite)}
      confirm={async (target) => {
        const done = await splitText(target, args)

        return `Split ${counted(done.rows, 'cell')} of ${done.range} into ${counted(done.columns, 'column')} in ${done.destination}`
      }}
    >
      <section>
        <Heading>Split at</Heading>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <Choices label="Delimiter" value={delimiter} options={DELIMITER_CHOICES} onChange={setDelimiter} autoFocus />
          </div>
          {delimiter === 'other' && <TextField label="Text to split at" placeholder="|" value={other} onChange={(event) => setOther(event.target.value)} autoFocus className="w-14 shrink-0" />}
        </div>
      </section>
      <Check checked={consecutive} onChange={setConsecutive}>
        Treat a run of delimiters as one
      </Check>
      <label className="flex items-center gap-2 text-[12px] text-fg-2">
        <span className="shrink-0">Put the parts from</span>
        <TextField label="First cell for the parts" placeholder={range.split(':')[0]} value={destination} onChange={(event) => setDestination(event.target.value)} className="w-28" />
        <span className="text-fg-3">{destination.trim() ? '' : 'over the column itself'}</span>
      </label>
      {result && (
        <section>
          <Heading>
            {result.rows ? `${counted(result.rows, 'cell')} split into ${counted(result.columns, 'column')}, ${result.destination}` : `Nothing in ${result.range} splits`}
          </Heading>
          {result.preview.length > 0 && <PreviewGrid rows={result.preview} />}
        </section>
      )}
      {result && result.overwrites > 0 && (
        <Check checked={overwrite} onChange={setOverwrite}>
          Write over {counted(result.overwrites, 'cell')} with data in the way
        </Check>
      )}
      {preview.error && <Note tone="warn">{preview.error}</Note>}
    </ToolDialog>
  )
}

/** Open Split text to columns for the selection (or a cell's column in its table) in a document. */
export function openSplitText(docKey: string, selection: { sheet: string; range: string }): void {
  openDialog(docKey, <SplitDialog docKey={docKey} range={selection.range} sheet={selection.sheet} />)
}
