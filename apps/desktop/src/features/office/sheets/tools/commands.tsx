import { parseRange, quoteSheet } from '../../../../../shared/office/xlsx/address.ts'
import type { OfficeCommand } from '../../shell/commands.ts'
import { activeKey, activeWorkbook, failed } from '../active.ts'
import type { SheetsTarget } from '../model.ts'
import { sheetsSession } from '../store.ts'
import { openConvertDates } from './DatesDialog.tsx'
import { openRemoveDuplicates } from './DuplicatesDialog.tsx'
import { changeCase, convertToNumbers, fillDown, highlightDuplicates, listSummaries, refreshSummary, summariesOf, trimText } from './model.ts'
import { openSortBy } from './SortDialog.tsx'
import { openSplitText } from './SplitDialog.tsx'
import { openSummarize } from './SummarizeDialog.tsx'
import type { TextCase } from './text.ts'
import { counted } from './ui.tsx'

type Selection = { sheet: string; range: string }

/** The workbook in front, when it has a selection to work on. */
function selected(): { key: string; target: SheetsTarget; selection: Selection } | null {
  const active = activeWorkbook()

  return active?.selection ? { key: active.key, target: active.target, selection: active.selection } : null
}

const hasDocument = () => Boolean(activeKey())

/** A command that runs a tool on the selection and says what it did in the window's notice. */
const onSelection = (id: string, label: string, work: (target: SheetsTarget, selection: Selection) => Promise<string>, extra: Partial<OfficeCommand> = {}): OfficeCommand => ({
  id,
  label,
  enabled: hasDocument,
  run: () => {
    const active = selected()

    if (active) {
      work(active.target, active.selection).then((message) => sheetsSession.notify(message), failed)
    }
  },
  ...extra
})

/** A command that opens a tool's dialog for the selection. */
const withDialog = (id: string, label: string, open: (docKey: string, selection: Selection) => void, extra: Partial<OfficeCommand> = {}): OfficeCommand => ({
  id,
  label,
  enabled: hasDocument,
  run: () => {
    const active = selected()

    if (active) {
      open(active.key, active.selection)
    }
  },
  ...extra
})

const CASES: [TextCase, string][] = [
  ['upper', 'UPPER'],
  ['lower', 'lower'],
  ['title', 'Title Case'],
  ['sentence', 'Sentence case']
]

const quoted = (entries: { cell: string; text: string }[], total: number): string => `${entries.slice(0, 3).map((entry) => `${entry.cell} “${entry.text}”`).join(', ')}${total > 3 ? '…' : ''}`

/** Refresh the summary the selection is in, or every summary on the sheet in front. */
async function refreshHere(target: SheetsTarget, selection: Selection): Promise<string> {
  const at = parseRange(selection.range)
  const inside = listSummaries(target, { sheet: selection.sheet }).summaries.find((summary) => {
    const area = parseRange(summary.range)

    return at && area && at.startRow >= area.startRow && at.startRow <= area.endRow && at.startColumn >= area.startColumn && at.startColumn <= area.endColumn
  })
  const done = await refreshSummary(target, { sheet: selection.sheet, summary: inside?.id })

  if (done.summaries.length !== 1) {
    return `Refreshed ${counted(done.summaries.length, 'summary', 'summaries')} on ${done.sheet}`
  }

  const [summary] = done.summaries
  const change = summary.rows - summary.before

  return `Refreshed the summary in ${summary.range}: ${counted(summary.rows, 'row label')}${change ? ` (${Math.abs(change)} ${change > 0 ? 'more' : 'fewer'})` : ''}`
}

/** The Data menu's data tools and summaries. */
export function dataToolCommands(): OfficeCommand[] {
  return [
    withDialog('summarize', 'Summarize…', (docKey, selection) => openSummarize(docKey, `${quoteSheet(selection.sheet)}!${selection.range}`), { dividerBefore: true }),
    onSelection('summary-refresh', 'Refresh summary', refreshHere, {
      enabled: () => {
        const active = activeWorkbook()

        return Boolean(active && summariesOf(active.target.workbook.getActiveSheet()).length)
      }
    }),
    withDialog('remove-duplicates', 'Remove duplicates…', openRemoveDuplicates, { dividerBefore: true }),
    withDialog('split-text', 'Split text to columns…', openSplitText),
    onSelection('trim-text', 'Trim and clean', async (target, selection) => {
      const done = await trimText(target, selection)

      return done.changed ? `Trimmed and cleaned ${counted(done.changed, 'cell')} in ${done.range}` : `Nothing to trim or clean in ${done.range}`
    }),
    {
      id: 'change-case',
      label: 'Change case',
      enabled: hasDocument,
      run: () => {},
      submenu: CASES.map(([to, label]) =>
        onSelection(`case-${to}`, label, async (target, selection) => {
          const done = await changeCase(target, { ...selection, to })

          return done.changed ? `Changed ${counted(done.changed, 'cell')} in ${done.range} to ${label}` : `The text in ${done.range} is in ${label} already`
        })
      )
    },
    onSelection('convert-numbers', 'Convert text to numbers', async (target, selection) => {
      const done = await convertToNumbers(target, selection)
      const left = done.failed ? `${counted(done.failed, 'cell')} did not read as numbers (${quoted(done.notConverted, done.failed)})` : ''

      if (!done.converted) {
        return left ? `Nothing converted in ${done.range}: ${left}` : `No text holding numbers in ${done.range}`
      }

      return `Converted ${counted(done.converted, 'cell')} in ${done.range} to numbers${left ? `; ${left}` : ''}`
    }),
    withDialog('convert-dates', 'Convert text to dates…', openConvertDates),
    onSelection('fill-down', 'Fill down', async (target, selection) => {
      const done = await fillDown(target, selection)

      return done.filled ? `Filled ${counted(done.filled, 'empty cell')} in ${done.range} from above` : `No empty cells under values to fill in ${done.range}`
    }),
    onSelection(
      'highlight-duplicates',
      'Highlight duplicates',
      async (target, selection) => {
        const done = await highlightDuplicates(target, selection)

        return done.duplicates ? `Highlighted ${counted(done.duplicates, 'duplicate cell')} in ${done.range}` : `No duplicates in ${done.range} yet; any that appear are highlighted`
      },
      { dividerBefore: true }
    ),
    withDialog('sort-several', 'Sort by several columns…', openSortBy)
  ]
}
