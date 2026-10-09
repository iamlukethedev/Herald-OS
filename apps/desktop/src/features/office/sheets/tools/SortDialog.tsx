import { IconArrowDown, IconArrowUp, IconPlus } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { openDialog } from '../ui/overlay.tsx'
import { describeTable, sortBy } from './model.ts'
import { Check, Choices, Heading, Note, RemoveButton, Select, ToolDialog, useLive } from './ui.tsx'

/* Data → Sort by several columns…: the columns to sort by in turn, each up or down, and whether the first row is headers. */

interface Key {
  column: string
  ascending: boolean
}

const move = (keys: Key[], index: number, by: number): Key[] => {
  const next = [...keys]
  const [key] = next.splice(index, 1)
  next.splice(index + by, 0, key)

  return next
}

function SortDialog({ docKey, range, sheet }: { docKey: string; range: string; sheet: string }) {
  const table = useLive(docKey, (target) => describeTable(target, { range, sheet }), [range, sheet])
  const [keys, setKeys] = useState<Key[]>([])
  const [header, setHeader] = useState(true)
  const columns = table.value?.columns ?? []
  const nameOf = (letter: string) => {
    const column = columns.find((entry) => entry.letter === letter)

    return header && column ? `${column.name} (${letter})` : `Column ${letter}`
  }

  useEffect(() => {
    if (table.value) {
      setHeader(table.value.header)
      setKeys(table.value.columns.length ? [{ column: table.value.columns[0].letter, ascending: true }] : [])
    }
  }, [table.value])

  const free = columns.filter((column) => !keys.some((key) => key.column === column.letter))
  const set = (index: number, change: Partial<Key>) => setKeys(keys.map((key, other) => (other === index ? { ...key, ...change } : key)))

  return (
    <ToolDialog
      docKey={docKey}
      title="Sort by several columns"
      action="Sort"
      ready={Boolean(table.value && keys.length)}
      confirm={async (target) => {
        const done = await sortBy(target, { range: table.value!.range, sheet, keys, header })

        return `Sorted ${done.range} by ${done.keys.map((key) => `${nameOf(key.column)} ${key.ascending ? 'A to Z' : 'Z to A'}`).join(', then ')}`
      }}
    >
      {table.error ? (
        <Note tone="warn">{table.error}</Note>
      ) : (
        <>
          <section>
            <Heading
              action={
                <button type="button" disabled={!free.length} onClick={() => setKeys([...keys, { column: free[0].letter, ascending: true }])} className="flex items-center gap-1 text-[11.5px] text-accent-strong hover:underline disabled:opacity-40">
                  <IconPlus size={12} /> Add a column
                </button>
              }
            >
              Sort {table.value?.range ?? range} by
            </Heading>
            <div className="flex flex-col gap-1.5">
              {keys.map((key, index) => (
                <div key={index} className="flex items-center gap-1.5">
                  <span className="w-10 shrink-0 text-[11.5px] text-fg-3">{index === 0 ? 'First' : 'Then'}</span>
                  <Select label={`Column to sort by, ${index + 1}`} value={key.column} autoFocus={index === 0} onChange={(event) => set(index, { column: event.target.value })} className="min-w-0 flex-1">
                    {columns
                      .filter((column) => column.letter === key.column || !keys.some((other) => other.column === column.letter))
                      .map((column) => (
                        <option key={column.letter} value={column.letter}>
                          {nameOf(column.letter)}
                        </option>
                      ))}
                  </Select>
                  <div className="w-36 shrink-0">
                    <Choices
                      label={`Order for ${nameOf(key.column)}`}
                      value={key.ascending ? 'up' : 'down'}
                      options={[
                        { id: 'up', label: 'A to Z', title: 'Ascending: smallest first' },
                        { id: 'down', label: 'Z to A', title: 'Descending: largest first' }
                      ]}
                      onChange={(id) => set(index, { ascending: id === 'up' })}
                    />
                  </div>
                  <button type="button" aria-label="Sort by this earlier" title="Earlier" disabled={index === 0} onClick={() => setKeys(move(keys, index, -1))} className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg disabled:opacity-30">
                    <IconArrowUp size={13} />
                  </button>
                  <button type="button" aria-label="Sort by this later" title="Later" disabled={index === keys.length - 1} onClick={() => setKeys(move(keys, index, 1))} className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg disabled:opacity-30">
                    <IconArrowDown size={13} />
                  </button>
                  <RemoveButton label={`Do not sort by ${nameOf(key.column)}`} onClick={() => setKeys(keys.filter((_, other) => other !== index))} />
                </div>
              ))}
            </div>
          </section>
          <Check checked={header} onChange={setHeader}>
            My data has headers (the first row stays on top)
          </Check>
        </>
      )}
    </ToolDialog>
  )
}

/** Open Sort by several columns for the selection (or the table around a single cell) in a document. */
export function openSortBy(docKey: string, selection: { sheet: string; range: string }): void {
  openDialog(docKey, <SortDialog docKey={docKey} range={selection.range} sheet={selection.sheet} />)
}
