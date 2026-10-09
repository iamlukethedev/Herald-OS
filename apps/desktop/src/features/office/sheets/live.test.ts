import { describe, expect, it } from 'vitest'
import { featureWorkbook, handmadePackage } from '../../../../shared/office/xlsx/fixtures.ts'
import { DASHBOARD, keptWorkbook } from '../../../../shared/office/xlsx/keep/fixtures.ts'
import { openPackage } from '../../../../shared/office/xlsx/package.ts'
import { workbookFromXlsx } from '../../../../shared/office/xlsx/read.ts'
import { sheetsAdapter } from './adapter.ts'
import { changeFile, type FileAccess } from './live.ts'
import { renameSheet, writeRange } from './model.ts'

/** Files in memory, for changing a workbook the way a command changes one that is not open. */
function memoryFiles(files: Record<string, Uint8Array>): FileAccess & { files: Record<string, Uint8Array> } {
  return {
    files,
    read: async (path) => ({ bytes: files[path] }),
    write: async (path, bytes) => {
      files[path] = bytes
    }
  }
}

describe('changing a file that is not open', () => {
  it('changes an .xlsx file with nothing drawn and writes it back, keeping what it had', async () => {
    const bytes = await handmadePackage({
      sheetTail: '<autoFilter ref="A1:C6"/><mergeCells count="1"><mergeCell ref="A8:B8"/></mergeCells><conditionalFormatting sqref="A2:A5"><cfRule type="cellIs" priority="1" operator="greaterThan"><formula>15</formula></cfRule></conditionalFormatting><dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="D2:D6"><formula1>"x,y"</formula1></dataValidation></dataValidations>',
      workbookExtra: "<definedNames><definedName name=\"Amounts\">'Hand Made'!$A$2:$A$5</definedName></definedNames>"
    })
    const io = memoryFiles({ '/tmp/book.xlsx': bytes })
    const { result } = await changeFile('/tmp/book.xlsx', async (target) => {
      await writeRange(target, { range: 'E2', values: [['=SUM(Amounts)']] })

      return renameSheet(target, { sheet: 'Hand Made', name: 'Lists' })
    }, sheetsAdapter, io)
    const { workbook } = await workbookFromXlsx(io.files['/tmp/book.xlsx'], { id: 'b', name: 'book' })
    const sheet = workbook.sheets[workbook.sheetOrder[0]]

    expect(result).toEqual({ from: 'Hand Made', to: 'Lists' })
    expect(sheet.name).toBe('Lists')
    expect(sheet.cellData[1][4]).toMatchObject({ f: '=SUM(Amounts)', v: 100 })
    expect(sheet.mergeData).toEqual([{ startRow: 7, startColumn: 0, endRow: 7, endColumn: 1 }])
    expect(workbook.dateSystem).toBe('date1904')
    expect((workbook.resources as { name: string }[]).map((resource) => resource.name)).toEqual(['SHEET_DEFINED_NAME_PLUGIN', 'SHEET_FILTER_PLUGIN', 'SHEET_DATA_VALIDATION_PLUGIN', 'SHEET_CONDITIONAL_FORMATTING_PLUGIN'])
  })

  it('will not rewrite a file whose look it would change (a patterned fill)', async () => {
    const io = memoryFiles({ '/tmp/features.xlsx': await featureWorkbook() })

    await expect(changeFile('/tmp/features.xlsx', (target) => writeRange(target, { range: 'A1', values: [[1]] }), sheetsAdapter, io)).rejects.toThrow(/Patterned cell fills/)
  })

  it('changes a file with a pivot table, pictures and charts made elsewhere, and keeps them', async () => {
    const io = memoryFiles({ '/tmp/kept.xlsx': await keptWorkbook({ pivot: true, dashboard: DASHBOARD }) })
    await changeFile('/tmp/kept.xlsx', (target) => writeRange(target, { range: 'C2', sheet: 'Sales', values: [[150]] }), sheetsAdapter, io)
    const pkg = await openPackage(io.files['/tmp/kept.xlsx'])
    const caches = await Promise.all(pkg.files.filter((file) => /^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/.test(file)).map((file) => pkg.read(file)))

    expect(pkg.files.filter((file) => /^xl\/pivotTables\/pivotTable\d+\.xml$/.test(file))).toHaveLength(1)
    expect(caches.every((xml) => /refreshOnLoad="1"/.test(xml ?? ''))).toBe(true)
    expect(pkg.files.some((file) => /^xl\/media\/.+\.png$/.test(file))).toBe(true)
    expect(pkg.files.filter((file) => /^xl\/charts\/chart(Ex)?\d+\.xml$/.test(file)).length).toBeGreaterThanOrEqual(3)
  })

  it('will not rewrite a file holding what Herald Sheets cannot keep, or lose sheets of a CSV', async () => {
    const macros = await handmadePackage({ extraParts: { 'xl/vbaProject.bin': 'not really a project' } })
    const io = memoryFiles({ '/tmp/macros.xlsx': macros, '/tmp/list.csv': new TextEncoder().encode('a,b\n1,2\n') })

    await expect(changeFile('/tmp/macros.xlsx', (target) => writeRange(target, { range: 'A1', values: [[1]] }), sheetsAdapter, io)).rejects.toThrow(/Macros \(VBA\) are not kept.*open it in Herald Sheets/)
    expect(io.files['/tmp/macros.xlsx']).toBe(macros)
    await expect(
      changeFile('/tmp/list.csv', async ({ univer, workbook }) => {
        workbook.insertSheet('Second')
        await writeRange({ univer, workbook }, { range: 'A1', sheet: 'Second', values: [['x']] })
      }, sheetsAdapter, io)
    ).rejects.toThrow(/would lose something \(Only the sheet/)
  })
})
