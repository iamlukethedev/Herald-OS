import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { CELL_TYPE, newSheet, newWorkbook } from '../../../../../shared/office/workbook.ts'
import { hasOpenpyxl, hasXmllint, malformedParts, openpyxl } from '../../../../../shared/office/xlsx/comments/checks.ts'
import { handmadePackage } from '../../../../../shared/office/xlsx/fixtures.ts'
import { workbookFromXlsx } from '../../../../../shared/office/xlsx/read.ts'
import { definedNamesXml, readResource, RESOURCES, type UDefinedName, WORKBOOK_SCOPE } from '../../../../../shared/office/xlsx/rules.ts'
import { xlsxFromWorkbook } from '../../../../../shared/office/xlsx/write.ts'
import { withHeadlessSheets } from '../headless.ts'
import { readRange, settled } from '../model.ts'
import { createName, listNames } from './model.ts'

const NAMES = [
  '<definedName name="Amounts">\'Hand Made\'!$A$2:$A$5</definedName>',
  '<definedName name="Amounts" localSheetId="0" comment="Only this sheet&#10;second line">\'Hand Made\'!$A$2:$A$3</definedName>',
  '<definedName name="Secret" hidden="1">0.5</definedName>',
  '<definedName name="Rate" comment="Sales tax">0.07</definedName>',
  '<definedName name="Taxed">SUM(\'Hand Made\'!$A$2:$A$5)*(1+Rate)</definedName>',
  '<definedName name="Newer">_xlfn.XLOOKUP(10,\'Hand Made\'!$A$2:$A$5,\'Hand Made\'!$A$2:$A$5)</definedName>',
  '<definedName name="Areas">\'Hand Made\'!$A$2,\'Hand Made\'!$C$2:$C$3</definedName>',
  '<definedName name="Column">\'Hand Made\'!$B:$B</definedName>',
  '<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\'Hand Made\'!$A$1:$C$6</definedName>'
]

const definedNamesOf = async (bytes: Uint8Array): Promise<string[]> => {
  const workbook = (await (await JSZip.loadAsync(bytes)).file('xl/workbook.xml')!.async('string')) ?? ''

  return [...workbook.matchAll(/<definedName\b[\s\S]*?<\/definedName>/g)].map((match) => match[0])
}

describe('named ranges in .xlsx files', () => {
  it('keeps sheet names, comments, hidden names and names that are formulas through a file', async () => {
    const original = await handmadePackage({ workbookExtra: `<definedNames>${NAMES.join('')}</definedNames>` })
    const { workbook } = await workbookFromXlsx(original, { id: 'names', name: 'Names' })
    const stored = Object.values(readResource<Record<string, UDefinedName>>(workbook.resources, RESOURCES.definedNames)!)

    expect(stored.map(({ id: _id, ...entry }) => entry)).toEqual([
      { name: 'Amounts', formulaOrRefString: "'Hand Made'!$A$2:$A$5", localSheetId: WORKBOOK_SCOPE },
      { name: 'Amounts', formulaOrRefString: "'Hand Made'!$A$2:$A$3", localSheetId: 'sheet-1', comment: 'Only this sheet\nsecond line' },
      { name: 'Secret', formulaOrRefString: '=0.5', localSheetId: WORKBOOK_SCOPE, hidden: true },
      { name: 'Rate', formulaOrRefString: '=0.07', localSheetId: WORKBOOK_SCOPE, comment: 'Sales tax' },
      { name: 'Taxed', formulaOrRefString: "=SUM('Hand Made'!$A$2:$A$5)*(1+Rate)", localSheetId: WORKBOOK_SCOPE },
      { name: 'Newer', formulaOrRefString: "=XLOOKUP(10,'Hand Made'!$A$2:$A$5,'Hand Made'!$A$2:$A$5)", localSheetId: WORKBOOK_SCOPE },
      { name: 'Areas', formulaOrRefString: "='Hand Made'!$A$2,'Hand Made'!$C$2:$C$3", localSheetId: WORKBOOK_SCOPE },
      { name: 'Column', formulaOrRefString: "'Hand Made'!$B:$B", localSheetId: WORKBOOK_SCOPE }
    ])

    // Through Univer, as a workbook a window has open and saves.
    const { result, snapshot } = await withHeadlessSheets(workbook, async ({ univer, workbook: book }) => {
      const target = { univer, workbook: book }
      book.getSheets()[0].getRange('D1').setValue({ f: '=Taxed' })
      await settled(target)

      return { names: listNames(target), taxed: readRange(target, { range: 'D1' }).values[0][0] }
    })

    expect(result.names.map((name) => `${name.name}@${name.scope}`)).toEqual(['Amounts@workbook', 'Areas@workbook', 'Column@workbook', 'Newer@workbook', 'Rate@workbook', 'Taxed@workbook', 'Amounts@Hand Made'])
    expect(result.taxed).toBeCloseTo(107)
    const { bytes, losses } = await xlsxFromWorkbook(snapshot, { original })
    const written = await definedNamesOf(bytes)

    expect(losses).toEqual([])

    for (const name of NAMES.filter((entry) => !entry.includes('_FilterDatabase'))) {
      expect(written).toContain(name)
    }
  })

  it('writes the names made in Herald so that Excel’s readers see them', async () => {
    const book = newWorkbook('made', 'Made', [newSheet('s1', 'Data', { 0: { 0: { v: 4, t: CELL_TYPE.number } } }), newSheet('s2', 'Q1 sales')])
    const { snapshot } = await withHeadlessSheets(book, async ({ univer, workbook }) => {
      const target = { univer, workbook }
      await createName(target, { name: 'Figures', refersTo: 'Data!A1:A9', comment: 'The figures' })
      await createName(target, { name: 'Figures', refersTo: "'Q1 sales'!B2", scope: 'Q1 sales' })
      await createName(target, { name: 'Rate', refersTo: '=0.2' })
    })
    const { bytes, losses } = await xlsxFromWorkbook(snapshot)

    expect(losses).toEqual([])
    expect(await definedNamesOf(bytes)).toEqual([
      '<definedName name="Figures" comment="The figures">Data!$A$1:$A$9</definedName>',
      '<definedName name="Figures" localSheetId="1">\'Q1 sales\'!$B$2</definedName>',
      '<definedName name="Rate">0.2</definedName>'
    ])

    if (hasXmllint()) {
      expect(await malformedParts(bytes)).toEqual([])
    }

    if (hasOpenpyxl()) {
      const read = JSON.parse(openpyxl(bytes, "print(json.dumps({'book': {k: v.attr_text for k, v in book.defined_names.items()}, 'sheet': {k: v.attr_text for k, v in book['Q1 sales'].defined_names.items()}}))"))

      expect(read).toEqual({ book: { Figures: 'Data!$A$1:$A$9', Rate: '0.2' }, sheet: { Figures: "'Q1 sales'!$B$2" } })
    }

    const { workbook } = await workbookFromXlsx(bytes, { id: 'again', name: 'Again' })
    const { result } = await withHeadlessSheets(workbook, ({ univer, workbook: again }) => listNames({ univer, workbook: again }))

    expect(result).toEqual([
      { name: 'Figures', refersTo: '=Data!$A$1:$A$9', scope: 'workbook', comment: 'The figures' },
      { name: 'Rate', refersTo: '=0.2', scope: 'workbook', comment: '' },
      { name: 'Figures', refersTo: "='Q1 sales'!$B$2", scope: 'Q1 sales', comment: '' }
    ])
  })

  it('leaves out names Excel would not open the file with, saying so', () => {
    const losses = new Set<string>()
    const names: Record<string, UDefinedName> = {
      a: { id: 'a', name: 'Good', formulaOrRefString: 'Data!$A$1', localSheetId: WORKBOOK_SCOPE },
      b: { id: 'b', name: 'GOOD', formulaOrRefString: 'Data!$A$2', localSheetId: WORKBOOK_SCOPE },
      c: { id: 'c', name: 'Two words', formulaOrRefString: 'Data!$A$3' },
      d: { id: 'd', name: 'Gone', formulaOrRefString: 'Data!$A$4', localSheetId: 'deleted-sheet' },
      e: { id: 'e', name: 'Good', formulaOrRefString: 'Data!$A$5', localSheetId: 's1' }
    }

    expect(definedNamesXml(names, ['s1'], 'book', losses)).toBe('<definedNames><definedName name="Good">Data!$A$1</definedName><definedName name="Good" localSheetId="0">Data!$A$5</definedName></definedNames>')
    expect([...losses]).toEqual(['Two names spelled alike for the same sheet or the whole workbook are saved as one.', 'The name “Two words” is not saved: Excel does not allow it.'])
  })
})
