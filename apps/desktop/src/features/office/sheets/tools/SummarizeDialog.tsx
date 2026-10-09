import { IconChevronDown, IconChevronRight } from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'
import { quoteSheet } from '../../../../../shared/office/xlsx/address.ts'
import type { CellInput } from '../model.ts'
import { openDialog } from '../ui/overlay.tsx'
import { labelKey, SUMMARY_FUNCTIONS, type SummaryFunction, summarize, summarySource, valueName } from './summary.ts'
import { Check, Choices, counted, Heading, Note, PreviewGrid, RemoveButton, Select, TextField, ToolDialog, useLive } from './ui.tsx'

/* Data → Summarize…: a pivot-style summary of the table, its fields from the header row put in rows, columns, values and filters. */

type Field = ReturnType<typeof summarySource>['fields'][number]

const FUNCTION_NAMES: Record<SummaryFunction, string> = { sum: 'Sum', count: 'Count', average: 'Average', min: 'Min', max: 'Max' }

/** A list to add a field to, then remove it from. */
function FieldList({ title, fields, chosen, onChange }: { title: string; fields: Field[]; chosen: string[]; onChange: (chosen: string[]) => void }) {
  const free = fields.filter((field) => !chosen.includes(field.name))

  return (
    <section>
      <Heading
        action={
          <Select label={`Add a field to ${title.toLowerCase()}`} value="" disabled={!free.length} onChange={(event) => event.target.value && onChange([...chosen, event.target.value])} className="h-6 w-36">
            <option value="">Add a field…</option>
            {free.map((field) => (
              <option key={field.name} value={field.name}>
                {field.name}
              </option>
            ))}
          </Select>
        }
      >
        {title}
      </Heading>
      {chosen.length ? (
        <div className="flex flex-col gap-1">
          {chosen.map((name) => (
            <div key={name} className="flex min-h-7 items-center gap-2 rounded-md bg-white/4 pl-2 text-[12.5px] text-fg">
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <RemoveButton label={`Remove ${name} from ${title.toLowerCase()}`} onClick={() => onChange(chosen.filter((other) => other !== name))} />
            </div>
          ))}
        </div>
      ) : (
        <Note>None</Note>
      )}
    </section>
  )
}

/** A filter's values, each kept or not. */
function FilterValues({ field, kept, onChange }: { field: Field; kept: CellInput[]; onChange: (kept: CellInput[]) => void }) {
  const keys = new Set(kept.map(labelKey))

  return (
    <div className="mt-1 ml-2 flex max-h-32 flex-col gap-1 overflow-y-auto rounded-md border border-line p-1.5">
      <div className="flex gap-3 text-[11.5px]">
        <button type="button" className="text-accent-strong hover:underline" onClick={() => onChange(field.values.map((entry) => entry.value))}>
          All
        </button>
        <button type="button" className="text-accent-strong hover:underline" onClick={() => onChange([])}>
          None
        </button>
      </div>
      {field.values.map((entry) => (
        <Check key={labelKey(entry.value)} checked={keys.has(labelKey(entry.value))} onChange={(on) => onChange(on ? [...kept, entry.value] : kept.filter((value) => labelKey(value) !== labelKey(entry.value)))}>
          {entry.text}
        </Check>
      ))}
    </div>
  )
}

function SummarizeDialog({ docKey, range }: { docKey: string; range: string }) {
  const [source, setSource] = useState(range)
  const [typed, setTyped] = useState(range)
  const table = useLive(docKey, (target) => summarySource(target, { source }), [source])
  const fields = table.value?.fields ?? []
  const [rows, setRows] = useState<string[]>([])
  const [columns, setColumns] = useState<string[]>([])
  const [values, setValues] = useState<{ field: string; fn: SummaryFunction }[]>([])
  const [filters, setFilters] = useState<{ field: string; values: CellInput[] }[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [where, setWhere] = useState<'new' | 'cell'>('new')
  const [cell, setCell] = useState('')

  // A table read afresh starts with a likely summary: its first text field down, its first number field added up.
  useEffect(() => {
    if (!table.value) {
      return
    }

    const label = fields.find((field) => !field.numeric) ?? fields[0]
    const number = fields.find((field) => field.numeric && field.name !== label?.name)
    setTyped(`${quoteSheet(table.value.sheet)}!${table.value.range}`)
    setRows(label ? [label.name] : [])
    setColumns([])
    setValues(number ? [{ field: number.name, fn: 'sum' }] : label ? [{ field: label.name, fn: 'count' }] : [])
    setFilters([])
  }, [table.value])

  const definition = useMemo(() => ({ source, rows, columns, values, filters: filters.filter((filter) => filter.values.length), destination: where === 'new' ? 'new' : cell }), [source, rows, columns, values, filters, where, cell])
  const ready = Boolean(table.value && rows.length && values.length && (where === 'new' || cell.trim()))
  const preview = useLive(docKey, (target) => (ready ? summarize(target, { ...definition, preview: true }) : null), [definition, ready])
  const fieldOf = (name: string) => fields.find((field) => field.name === name)
  const setFn = (field: string, fn: SummaryFunction) => setValues(values.map((value) => (value.field === field ? { ...value, fn } : value)))

  return (
    <ToolDialog
      docKey={docKey}
      title="Summarize"
      action="Summarize"
      ready={ready && !preview.error}
      confirm={async (target) => {
        const made = await summarize(target, definition)
        const across = made.columns ? ` by ${counted(made.columns, 'column label')}` : ''

        return `Summarized ${made.source} on ${made.newSheet ? 'the new sheet ' : ''}${made.sheet}: ${counted(made.rows, 'row label')}${across}`
      }}
    >
      <label className="flex items-center gap-2 text-[12px] text-fg-2">
        <span className="w-12 shrink-0">Table</span>
        <TextField
          label="Table to summarize"
          autoFocus
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={() => setSource(typed)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && typed !== source) {
              event.stopPropagation()
              event.preventDefault()
              setSource(typed)
            }
          }}
          className="flex-1"
        />
        {table.value && <span className="shrink-0 text-fg-3">{table.value.rows.toLocaleString('en-US')} rows</span>}
      </label>
      {table.error ? (
        <Note tone="warn">{table.error}</Note>
      ) : (
        <div className="-mx-1 flex max-h-[min(26rem,52vh)] flex-col gap-3 overflow-y-auto px-1">
          <FieldList title="Rows" fields={fields.filter((field) => !columns.includes(field.name))} chosen={rows} onChange={setRows} />
          <FieldList title="Columns" fields={fields.filter((field) => !rows.includes(field.name))} chosen={columns} onChange={setColumns} />
          <section>
            <Heading
              action={
                <Select label="Add a value" value="" onChange={(event) => event.target.value && setValues([...values, { field: event.target.value, fn: fieldOf(event.target.value)?.numeric ? 'sum' : 'count' }])} className="h-6 w-36">
                  <option value="">Add a field…</option>
                  {fields.map((field) => (
                    <option key={field.name} value={field.name}>
                      {field.name}
                    </option>
                  ))}
                </Select>
              }
            >
              Values
            </Heading>
            {values.length ? (
              <div className="flex flex-col gap-1">
                {values.map((value, index) => (
                  <div key={`${value.field} ${index}`} className="flex min-h-7 items-center gap-2 rounded-md bg-white/4 pl-2 text-[12.5px] text-fg">
                    <span className="min-w-0 flex-1 truncate">{valueName(value)}</span>
                    <Select label={`What to work out of ${value.field}`} value={value.fn} onChange={(event) => setFn(value.field, event.target.value as SummaryFunction)} className="h-6">
                      {SUMMARY_FUNCTIONS.map((fn) => (
                        <option key={fn} value={fn}>
                          {FUNCTION_NAMES[fn]}
                        </option>
                      ))}
                    </Select>
                    <RemoveButton label={`Remove ${valueName(value)}`} onClick={() => setValues(values.filter((_, other) => other !== index))} />
                  </div>
                ))}
              </div>
            ) : (
              <Note>Add what to work out, like the sum of a column of numbers</Note>
            )}
          </section>
          <section>
            <Heading
              action={
                <Select
                  label="Filter by a field"
                  value=""
                  onChange={(event) => {
                    const field = fieldOf(event.target.value)

                    if (field) {
                      setFilters([...filters, { field: field.name, values: field.values.map((entry) => entry.value) }])
                      setOpen(field.name)
                    }
                  }}
                  className="h-6 w-36"
                >
                  <option value="">Add a field…</option>
                  {fields
                    .filter((field) => !filters.some((filter) => filter.field === field.name) && field.values.length === field.distinct)
                    .map((field) => (
                      <option key={field.name} value={field.name}>
                        {field.name}
                      </option>
                    ))}
                </Select>
              }
            >
              Filters
            </Heading>
            {filters.length ? (
              <div className="flex flex-col gap-1">
                {filters.map((filter) => {
                  const field = fieldOf(filter.field)

                  return (
                    <div key={filter.field}>
                      <div className="flex min-h-7 items-center gap-1 rounded-md bg-white/4 pl-1 text-[12.5px] text-fg">
                        <button type="button" aria-expanded={open === filter.field} onClick={() => setOpen(open === filter.field ? null : filter.field)} className="flex min-w-0 flex-1 items-center gap-1 text-left">
                          {open === filter.field ? <IconChevronDown size={13} className="shrink-0 text-fg-3" /> : <IconChevronRight size={13} className="shrink-0 text-fg-3" />}
                          <span className="truncate">{filter.field}</span>
                          <span className="shrink-0 text-[11.5px] text-fg-3">
                            {filter.values.length} of {field?.distinct ?? 0}
                          </span>
                        </button>
                        <RemoveButton label={`Remove the filter on ${filter.field}`} onClick={() => setFilters(filters.filter((other) => other !== filter))} />
                      </div>
                      {open === filter.field && field && <FilterValues field={field} kept={filter.values} onChange={(kept) => setFilters(filters.map((other) => (other === filter ? { ...other, values: kept } : other)))} />}
                    </div>
                  )
                })}
              </div>
            ) : (
              <Note>None: every row counts</Note>
            )}
          </section>
          <section>
            <Heading>Put it on</Heading>
            <div className="flex items-center gap-2">
              <Choices
                label="Where the summary goes"
                value={where}
                options={[
                  { id: 'new', label: 'A new sheet' },
                  { id: 'cell', label: 'A cell' }
                ]}
                onChange={setWhere}
              />
              {where === 'cell' && <TextField label="First cell of the summary" placeholder="Sheet2!A1" value={cell} onChange={(event) => setCell(event.target.value)} className="w-32" />}
            </div>
          </section>
        </div>
      )}
      {preview.value && (
        <section>
          <Heading>
            {preview.value.range} on {preview.value.newSheet ? 'a new sheet' : preview.value.sheet}
          </Heading>
          <PreviewGrid rows={[preview.value.headers, ...preview.value.labels.map((labels) => [...labels, ...preview.value!.headers.slice(labels.length).map(() => '…')]), ...(preview.value.rows > preview.value.labels.length ? [[`${preview.value.rows - preview.value.labels.length} more`]] : []), ['Grand total']]} />
        </section>
      )}
      {preview.error && <Note tone="warn">{preview.error}</Note>}
    </ToolDialog>
  )
}

/** Open Summarize for the selection (or the table around a single cell) in a document. */
export function openSummarize(docKey: string, range: string): void {
  openDialog(docKey, <SummarizeDialog docKey={docKey} range={range} />)
}
