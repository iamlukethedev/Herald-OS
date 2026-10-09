import '../univer/univer.css'
import './fonts.css'
import { useEffect, useMemo, useState } from 'react'
import { officeAppFor, openFormats } from '../../../../shared/office/files.ts'
import { messageOf } from '../../canvas/errors.ts'
import { officeAbilities } from '../session.ts'
import { type OfficeCommand, type OfficeMenu, officeMenus } from '../shell/commands.ts'
import { OfficeWindow } from '../shell/OfficeWindow.tsx'
import { activeKey, failed } from './active.ts'
import { chartCommands } from './charts/commands.tsx'
import { commentCommands } from './comments/commands.tsx'
import { liveTarget, runInDocument, selectionIn } from './live.ts'
import { freeze, setFormat } from './model.ts'
import { nameCommands } from './names/commands.tsx'
import { SheetsEditor } from './SheetsEditor.tsx'
import { sheetsSession } from './store.ts'
import { dataToolCommands } from './tools/commands.tsx'
import { validationCommands } from './validation/commands.tsx'

// Univer measures text when it first draws a cell: Office's fonts are ready before a workbook opens.
void Promise.all(['Calibri', 'Cambria', 'Aptos Narrow'].flatMap((family) => [`11pt "${family}"`, `bold 11pt "${family}"`].map((font) => document.fonts.load(font)))).catch(() => {})

const NUMBER_FORMATS: [string, string, string][] = [
  ['format-general', 'Automatic', 'General'],
  ['format-number', 'Number (1,234.50)', '#,##0.00'],
  ['format-currency', 'Currency ($1,234.50)', '"$"#,##0.00'],
  ['format-percent', 'Percent (12.5%)', '0.0%'],
  ['format-date', 'Date (2026-10-08)', 'yyyy-mm-dd'],
  ['format-time', 'Time (14:30)', 'hh:mm'],
  ['format-text', 'Plain text', '@']
]

/** A command that runs Univer's own command on the selection. */
const univerCommand = (id: string, label: string, command: string, extra: Partial<OfficeCommand> = {}): OfficeCommand => ({
  id,
  label,
  enabled: () => Boolean(activeKey()),
  run: () => {
    const key = activeKey()

    if (key) {
      runInDocument(key, command)
    }
  },
  ...extra
})

function numberFormat(pattern: string): void {
  const key = activeKey()
  const target = key && liveTarget(key)
  const selection = key && selectionIn(key)

  if (target && selection) {
    setFormat(target, { range: selection.range, sheet: selection.sheet, format: { numberFormat: pattern } }).catch(failed)
  }
}

/** Freeze the first row or column, keeping what is frozen the other way; or nothing. */
function freezeFirst(which: 'row' | 'column' | 'none'): void {
  const key = activeKey()
  const target = key && liveTarget(key)

  if (!target) {
    return
  }

  const current = target.workbook.getActiveSheet().getFreeze()
  const rows = which === 'none' ? 0 : which === 'row' ? 1 : Math.max(0, current.ySplit)
  const columns = which === 'none' ? 0 : which === 'column' ? 1 : Math.max(0, current.xSplit)
  freeze(target, { rows, columns }).catch(failed)
}

function sheetMenus(): { edit: OfficeCommand[]; menus: OfficeMenu[] } {
  const menus: OfficeMenu[] = [
    { id: 'insert', label: 'Insert', items: [...chartCommands(), ...commentCommands()] },
    {
      id: 'format',
      label: 'Format',
      items: [
        {
          id: 'number-format',
          label: 'Number format',
          enabled: () => Boolean(activeKey()),
          run: () => {},
          submenu: NUMBER_FORMATS.map(([id, label, pattern]) => ({ id, label, enabled: () => Boolean(activeKey()), run: () => numberFormat(pattern) }))
        }
      ]
    },
    {
      id: 'data',
      label: 'Data',
      items: [
        univerCommand('sort-asc', 'Sort A to Z', 'sheet.command.sort-range-asc'),
        univerCommand('sort-desc', 'Sort Z to A', 'sheet.command.sort-range-desc'),
        univerCommand('sort-custom', 'Sort…', 'sheet.command.sort-range-custom'),
        univerCommand('filter', 'Filter', 'sheet.command.smart-toggle-filter', { dividerBefore: true }),
        univerCommand('filter-clear', 'Clear filter conditions', 'sheet.command.clear-filter-criteria'),
        ...dataToolCommands(),
        ...validationCommands(),
        ...nameCommands()
      ]
    },
    {
      id: 'view',
      label: 'View',
      items: [
        { id: 'freeze-row', label: 'Freeze top row', enabled: () => Boolean(activeKey()), run: () => freezeFirst('row') },
        { id: 'freeze-column', label: 'Freeze first column', enabled: () => Boolean(activeKey()), run: () => freezeFirst('column') },
        univerCommand('freeze-selection', 'Freeze up to selection', 'sheet.command.set-selection-frozen'),
        { id: 'unfreeze', label: 'Unfreeze', enabled: () => Boolean(activeKey()), run: () => freezeFirst('none') }
      ]
    },
    {
      id: 'sheet',
      label: 'Sheet',
      items: [univerCommand('sheet-new', 'New sheet', 'sheet.command.insert-sheet')]
    }
  ]

  return {
    edit: [univerCommand('find', 'Find…', 'ui.operation.open-find-dialog', { dividerBefore: true, shortcut: 'mod+f' }), univerCommand('replace', 'Find and Replace…', 'ui.operation.open-replace-dialog')],
    menus: menus.filter((menu) => menu.items.length)
  }
}

/** Herald Sheets: spreadsheets on Univer in a Herald window. */
export function SheetsWindow({ payload }: { payload?: Record<string, unknown> }) {
  const [canOpen, setCanOpen] = useState(true)

  useEffect(() => {
    void officeAbilities().then((abilities) => setCanOpen(openFormats('sheets', abilities).length > 0))
  }, [])

  const menus = useMemo(() => officeMenus({ session: sheetsSession, canSave: true, ...sheetMenus() }), [])

  const onDropFile = (file: string) => {
    void officeAbilities().then((abilities) => {
      if (officeAppFor(file, abilities) === 'sheets') {
        sheetsSession.open(file).catch((error: unknown) => sheetsSession.notify(`Could not open ${file.split('/').pop()}: ${messageOf(error)}`, 'error'))
      } else {
        sheetsSession.notify(`Herald Sheets does not open ${file.split('/').pop()}`, 'error')
      }
    })
  }

  return (
    <OfficeWindow
      session={sheetsSession}
      menus={menus}
      payload={payload}
      noun="spreadsheet"
      canOpen={canOpen}
      onDropFile={onDropFile}
      start={{ icon: 'sheets', blurb: 'Excel workbooks and CSV files, with formulas, number formats, sorting and filters worked out as you type.', newLabel: 'New spreadsheet', hint: 'Or drop an Excel or CSV file here.' }}
      renderEditor={(doc) => <SheetsEditor doc={doc} />}
    />
  )
}
