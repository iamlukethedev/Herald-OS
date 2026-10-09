import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { CELL_TYPE, newSheet, newWorkbook } from '../../../../../shared/office/workbook.ts'
import { hasOpenpyxl, hasXmllint, malformedParts, openpyxl } from '../../../../../shared/office/xlsx/comments/checks.ts'
import { handmadePackage } from '../../../../../shared/office/xlsx/fixtures.ts'
import { workbookFromXlsx } from '../../../../../shared/office/xlsx/read.ts'
import { type UValidation, validationsXml } from '../../../../../shared/office/xlsx/rules.ts'
import { xlsxFromWorkbook } from '../../../../../shared/office/xlsx/write.ts'
import { withHeadlessSheets } from '../headless.ts'
import { getValidation, OPERATORS, setValidation, type ValidationSettings } from './model.ts'

type Args = Parameters<typeof setValidation>[1]

/** A rule of every type, every operator, and every kind of message, each on its own cells. */
const RULES: Args[] = [
  { range: 'A2:A20', rule: { type: 'list', items: ['Small', 'Medium', 'Large'] }, input: { title: 'Size', message: 'Pick a size\nfrom the list' }, error: { style: 'stop', title: 'Not a size', message: 'Pick one of the sizes' } },
  { range: 'B2:B20', rule: { type: 'list', source: "'Lists'!A1:A3" }, dropdown: false, error: { style: 'warning', message: 'Not in the list' } },
  ...OPERATORS.map((operator, index): Args => ({ range: `C${index + 2}`, rule: { type: 'whole', operator, ...(operator.endsWith('etween') ? { min: -5, max: 10 } : { value: 7 }) }, allowBlank: index % 2 === 0 })),
  { range: 'D2', rule: { type: 'decimal', operator: 'between', min: 0.5, max: 99.75 }, error: { style: 'information', title: 'Unusual', message: 'Check the amount' } },
  { range: 'D3', rule: { type: 'decimal', operator: 'greaterThanOrEqual', value: '=Lists!B1' }, error: false },
  { range: 'E2', rule: { type: 'date', operator: 'between', min: '2026-01-01', max: '2026-12-31' }, input: { message: 'A date this year' } },
  { range: 'E3', rule: { type: 'date', operator: 'lessThan', value: '2030-06-30' } },
  { range: 'E4', rule: { type: 'date', operator: 'greaterThan', value: '=TODAY()' } },
  { range: 'F2', rule: { type: 'textLength', operator: 'lessThanOrEqual', value: 12 }, input: { title: 'Short code' } },
  { range: 'F3', rule: { type: 'textLength', operator: 'notBetween', min: 3, max: 5 } },
  { range: 'G2:G9', rule: { type: 'custom', formula: '=AND(G2>0,G2<=$H$1)' }, error: { style: 'stop', message: 'Positive, at most H1' } },
  { range: 'H2:H9', rule: { type: 'any' }, input: { title: 'Notes', message: 'Anything you like' } }
]

/** The rules as set, read back from Herald. */
async function written(): Promise<{ bytes: Uint8Array; set: ValidationSettings[]; losses: string[] }> {
  const book = newWorkbook('book', 'Book', [newSheet('s1', 'Orders'), newSheet('s2', 'Lists', { 0: { 0: { v: 'Red', t: CELL_TYPE.string }, 1: { v: 2, t: CELL_TYPE.number } } })])
  const { result, snapshot } = await withHeadlessSheets(book, async ({ univer, workbook }) => {
    const target = { univer, workbook }
    const set: ValidationSettings[] = []

    for (const args of RULES) {
      set.push(...(await setValidation(target, args)).rules)
    }

    return set
  })
  const { bytes, losses } = await xlsxFromWorkbook(snapshot)

  return { bytes, set: result, losses }
}

const sheetXml = async (bytes: Uint8Array): Promise<string> => (await (await JSZip.loadAsync(bytes)).file('xl/worksheets/sheet1.xml')!.async('string')) ?? ''

describe('data validation in .xlsx files', () => {
  it('writes every type, operator and message as Excel keeps them: dates as day numbers, line breaks kept', async () => {
    const { bytes, losses } = await written()
    const xml = await sheetXml(bytes)

    expect(losses).toEqual([])
    expect(xml).toContain('<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorTitle="Not a size" error="Pick one of the sizes" promptTitle="Size" prompt="Pick a size&#10;from the list" sqref="A2:A20"><formula1>&quot;Small,Medium,Large&quot;</formula1></dataValidation>')
    expect(xml).toContain('<dataValidation type="list" errorStyle="warning" allowBlank="1" showDropDown="1" showErrorMessage="1" error="Not in the list" sqref="B2:B20"><formula1>Lists!$A$1:$A$3</formula1></dataValidation>')
    expect(xml).toContain('<dataValidation type="whole" allowBlank="1" showErrorMessage="1" sqref="C2"><formula1>-5</formula1><formula2>10</formula2></dataValidation>')
    expect(xml).toContain('<dataValidation type="whole" operator="notBetween" showErrorMessage="1" sqref="C3"><formula1>-5</formula1><formula2>10</formula2></dataValidation>')
    expect(xml).toContain('<dataValidation type="whole" operator="lessThanOrEqual" showErrorMessage="1" sqref="C9"><formula1>7</formula1></dataValidation>')
    expect(xml).toContain('<dataValidation type="decimal" errorStyle="information" allowBlank="1" showErrorMessage="1" errorTitle="Unusual" error="Check the amount" sqref="D2"><formula1>0.5</formula1><formula2>99.75</formula2></dataValidation>')
    expect(xml).toContain('<dataValidation type="decimal" operator="greaterThanOrEqual" allowBlank="1" sqref="D3"><formula1>Lists!B1</formula1></dataValidation>')
    expect(xml).toContain('<dataValidation type="date" allowBlank="1" showInputMessage="1" showErrorMessage="1" prompt="A date this year" sqref="E2"><formula1>46023</formula1><formula2>46387</formula2></dataValidation>')
    expect(xml).toContain('<formula1>47664</formula1>')
    expect(xml).toContain('<dataValidation type="date" operator="greaterThan" allowBlank="1" showErrorMessage="1" sqref="E4"><formula1>TODAY()</formula1></dataValidation>')
    expect(xml).toContain('<dataValidation type="textLength" operator="lessThanOrEqual" allowBlank="1" showInputMessage="1" showErrorMessage="1" promptTitle="Short code" sqref="F2"><formula1>12</formula1></dataValidation>')
    expect(xml).toContain('<dataValidation type="custom" allowBlank="1" showErrorMessage="1" error="Positive, at most H1" sqref="G2:G9"><formula1>AND(G2&gt;0,G2&lt;=$H$1)</formula1></dataValidation>')
    expect(xml).toContain('<dataValidation allowBlank="1" showInputMessage="1" promptTitle="Notes" prompt="Anything you like" sqref="H2:H9"></dataValidation>')

    if (hasXmllint()) {
      expect(await malformedParts(bytes)).toEqual([])
    }
  })

  it('reads back every rule as it was set', async () => {
    const { bytes, set } = await written()
    const { workbook } = await workbookFromXlsx(bytes, { id: 'again', name: 'Again' })
    const { result } = await withHeadlessSheets(workbook, ({ univer, workbook: book }) => getValidation({ univer, workbook: book }, { range: 'A1:H20', sheet: 'Orders' }).rules)
    const byRange = (rules: ValidationSettings[]) => [...rules].sort((a, b) => a.range.localeCompare(b.range))

    expect(byRange(result)).toEqual(byRange(set))
  })

  it('writes rules openpyxl reads as Excel would', async () => {
    if (!hasOpenpyxl()) {
      return
    }

    const { bytes } = await written()
    const rules = JSON.parse(
      openpyxl(bytes, "print(json.dumps({str(dv.sqref): [dv.type, dv.operator, dv.formula1, dv.formula2, dv.allow_blank, dv.showDropDown, dv.showErrorMessage, dv.errorStyle, dv.promptTitle, dv.prompt] for dv in book['Orders'].data_validations.dataValidation}))")
    ) as Record<string, unknown[]>

    // In the file, showDropDown hides the list's arrow.
    expect(rules['A2:A20']).toEqual(['list', null, '"Small,Medium,Large"', null, true, false, true, null, 'Size', 'Pick a size\nfrom the list'])
    expect(rules['B2:B20']).toEqual(['list', null, 'Lists!$A$1:$A$3', null, true, true, true, 'warning', null, null])
    expect(rules.C3).toEqual(['whole', 'notBetween', '-5', '10', false, false, true, null, null, null])
    expect(rules.D3).toEqual(['decimal', 'greaterThanOrEqual', 'Lists!B1', null, true, false, false, null, null, null])
    expect(rules.E2).toEqual(['date', null, '46023', '46387', true, false, true, null, null, 'A date this year'])
    expect(rules.F3).toEqual(['textLength', 'notBetween', '3', '5', true, false, true, null, null, null])
    expect(rules['G2:G9'][2]).toBe('AND(G2>0,G2<=$H$1)')
  })

  it('reads rules Excel wrote, its newer extension list rules too, with dates shown as dates', async () => {
    const tail =
      '<dataValidations count="2"><dataValidation type="date" operator="greaterThanOrEqual" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorTitle="Too early" error="From 2026&#10;on" promptTitle="Start" prompt="When it starts" sqref="B2:B4 D2"><formula1>46023</formula1></dataValidation><dataValidation type="textLength" errorStyle="information" operator="equal" showErrorMessage="1" sqref="C2"><formula1>4</formula1></dataValidation></dataValidations>' +
      '<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:dataValidations count="1" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:dataValidation type="list" allowBlank="1" showErrorMessage="1"><x14:formula1><xm:f>Other!$A$1:$A$9</xm:f></x14:formula1><xm:sqref>A2:A9</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst>'
    const { workbook } = await workbookFromXlsx(await handmadePackage({ sheetTail: tail }), { id: 'excel', name: 'Excel' })
    // The hand-made file counts dates from 1904.
    const { result } = await withHeadlessSheets(workbook, ({ univer, workbook: book }) => getValidation({ univer, workbook: book }, { range: 'A1:D9' }).rules)

    expect([...result].sort((a, b) => a.range.localeCompare(b.range))).toEqual([
      { range: 'A2:A9', rule: { type: 'list', source: 'Other!$A$1:$A$9' }, allowBlank: true, dropdown: true, error: { style: 'stop', title: '', message: '' } },
      { range: 'B2:B4,D2', rule: { type: 'date', operator: 'greaterThanOrEqual', value: '2030-01-02' }, allowBlank: true, input: { title: 'Start', message: 'When it starts' }, error: { style: 'stop', title: 'Too early', message: 'From 2026\non' } },
      { range: 'C2', rule: { type: 'textLength', operator: 'equal', value: 4 }, allowBlank: false, error: { style: 'information', title: '', message: '' } }
    ])
  })

  it('counts dates from 1904 in a workbook that does, and leaves out or shortens what Excel cannot keep, saying so', () => {
    const rule = (extra: Partial<UValidation>): UValidation => ({ uid: 'r', ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }], type: 'date', operator: 'equal', formula1: '2026-10-09', ...extra })

    expect(validationsXml([rule({})], 'book', { date1904: true }).xml).toContain('<formula1>44842</formula1>')
    expect(validationsXml([rule({ formula1: '2026-10-09 18:00' })], 'book').xml).toContain('<formula1>46304.75</formula1>')
    expect(validationsXml([rule({ type: 'time', formula1: '08:30' })], 'book').xml).toContain('<formula1>0.3541666667</formula1>')

    const { xml, losses } = validationsXml(
      [
        rule({ formula1: 'next Friday' }),
        rule({ type: 'list', operator: undefined, formula1: JSON.stringify(['x'.repeat(200), 'y'.repeat(60)]) }),
        rule({ type: 'list', operator: undefined, formula1: JSON.stringify(['a,b', 'c']) }),
        rule({ type: 'whole', operator: 'greaterThan', formula1: '1', showInputMessage: true, promptTitle: 't'.repeat(40), prompt: 'p'.repeat(300), showErrorMessage: true, error: 'e'.repeat(300) }),
        rule({ type: 'listMultiple', operator: undefined, formula1: '["a","b"]' }),
        rule({ type: 'checkbox', operator: undefined, formula1: undefined })
      ],
      'book'
    )

    expect(losses).toEqual([
      'A date validation rule with a date Excel cannot read (“next Friday”) is not saved.',
      'Dropdown lists longer than 255 characters written into a rule are not saved: put the items in cells and make the list from them.',
      'List items with commas in them are split at the commas: Excel separates a list’s items with commas.',
      'Validation messages longer than Excel keeps (32 characters for a title, 255 for an input message, 225 for an error message) are shortened.',
      'Lists that allow picking several items are saved as lists of one item.',
      'Checkbox validation is not saved: Excel has no such rule.'
    ])
    expect(xml).toContain(`promptTitle="${'t'.repeat(32)}" prompt="${'p'.repeat(255)}"`)
    expect(xml).toContain(`error="${'e'.repeat(225)}"`)
    expect(xml).toContain('<formula1>&quot;a,b,c&quot;</formula1>')
    expect(xml).toContain('<formula1>&quot;a,b&quot;</formula1>')
    expect(xml.match(/<dataValidation /g)).toHaveLength(3)
  })
})
