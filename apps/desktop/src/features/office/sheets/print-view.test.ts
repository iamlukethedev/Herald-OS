import { describe, expect, it } from 'vitest'
import { CELL_TYPE, newSheet, newWorkbook, type WorkbookSnapshot } from '../../../../shared/office/workbook.ts'
import { formatterFor, printHtml } from './adapter.ts'
import { printHtml as printSheet } from './print.ts'

const body = (html: string) => /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? ''

function report(): WorkbookSnapshot {
  const sheet = newSheet('s', 'Report', {
    0: { 0: { v: 'Quarterly report', s: 'title' } },
    1: { 0: { v: 'Rent', t: CELL_TYPE.string }, 1: { v: 1200.5, t: CELL_TYPE.number, s: 'money' }, 2: { v: 'secret' } },
    2: { 0: { v: 'Paid on', t: CELL_TYPE.string }, 1: { v: 46303, t: CELL_TYPE.number, s: 'date' } },
    3: { 0: { v: 'hidden row' } },
    4: { 0: { v: 'Done', t: CELL_TYPE.string }, 1: { v: 1, t: CELL_TYPE.boolean } }
  })
  sheet.mergeData = [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 2 }]
  sheet.rowData = { 0: { h: 32 }, 3: { hd: 1 } }
  sheet.columnData = { 0: { w: 120 }, 2: { hd: 1 } }

  return {
    ...newWorkbook('b', 'Book', [sheet]),
    styles: { title: { bl: 1, fs: 14, bg: { rgb: '#dbe5f1' }, ht: 2, bd: { b: { s: 8, cl: { rgb: '#1f497d' } } } }, money: { n: { pattern: '#,##0.00' } }, date: { n: { pattern: 'yyyy-mm-dd' } } }
  }
}

describe('the print view', () => {
  it('shows numbers as the sheet does, with Univer’s formatter', () => {
    const format = formatterFor(report())

    expect(format(1200.5, '#,##0.00')).toBe('1,200.50')
    expect(format(46303, 'yyyy-mm-dd')).toBe('2026-10-08')
    expect(formatterFor({ ...report(), dateSystem: 'date1904' })(44841, 'yyyy-mm-dd')).toBe('2026-10-08')
  })

  it('prints styles, merged cells and sizes, and leaves hidden rows and columns out', () => {
    const html = body(printHtml(report(), 'Book').html)

    expect(html).toContain('<td colspan="2" style="font-size:14pt;font-weight:bold;background:#dbe5f1;border-bottom:2px solid #1f497d;text-align:center">Quarterly report</td>')
    expect(html).toContain('<tr style="height:32px">')
    expect(html).toContain('<td class="n">1,200.50</td>')
    expect(html).toContain('<td class="n">2026-10-08</td>')
    expect(html).toContain('<td>TRUE</td>')
    expect(html).not.toContain('secret')
    expect(html).not.toContain('hidden row')
    expect(html).toContain('<col style="width:120px"><col style="width:88px">')
  })

  it('turns the page for a wide sheet, in the page’s own CSS', () => {
    const narrow = printHtml(report(), 'Book')
    const wide = report()
    wide.sheets.s.columnData = { 1: { w: 900 } }

    expect(narrow.landscape).toBe(false)
    expect(narrow.html).toContain('@page { size: A4 portrait;')
    expect(printHtml(wide, 'Book')).toMatchObject({ landscape: true, html: expect.stringContaining('@page { size: A4 landscape;') })
  })

  it('prints on the paper and the way round the sheet’s page setup says', () => {
    const letter = report()
    letter.sheets.s.custom = { herald: { page: { pageSetup: { orientation: 'landscape', paperSize: 1 } } } }
    const unknown = report()
    unknown.sheets.s.custom = { herald: { page: { pageSetup: { paperSize: 70 } } } }

    expect(printHtml(letter, 'Book')).toMatchObject({ landscape: true, html: expect.stringContaining('@page { size: letter landscape;') })
    expect(printHtml(unknown, 'Book')).toMatchObject({ landscape: false, html: expect.stringContaining('@page { size: A4 portrait;') })
  })

  it('follows the rest of the page setup: its margins, fitting to a page across, scaling and centring', () => {
    const fitted = report()
    fitted.sheets.s.columnData = { 0: { w: 120 }, 1: { w: 2000 }, 2: { hd: 1 } }
    fitted.sheets.s.custom = { herald: { page: { pageSetup: { fitToPage: true, fitToHeight: 0, horizontalCentered: true }, margins: { left: 0.25, right: 0.25, top: 1, bottom: 1, header: 0.5, footer: 0.5 } } } }
    const scaled = report()
    scaled.sheets.s.columnData = { 0: { w: 120 }, 1: { w: 2000 }, 2: { hd: 1 } }
    scaled.sheets.s.custom = { herald: { page: { pageSetup: { scale: 75 } } } }
    const fittedView = printHtml(fitted, 'Book')

    // A4 is 8.27in across; less the margins that is 745.92px, for a table 2,120px wide.
    expect(fittedView.landscape).toBe(false)
    expect(fittedView.html).toContain('@page { size: A4 portrait; margin: 1in 0.25in 1in 0.25in; }')
    expect(fittedView.html).toContain(`<table style="width:2120px;zoom:${Number((745.92 / 2120).toFixed(4))};margin:0 auto">`)
    expect(printHtml(scaled, 'Book')).toMatchObject({ landscape: false, html: expect.stringContaining('<table style="width:2120px;zoom:0.75">') })
    expect(printHtml(scaled, 'Book').html).toContain('margin: 0.75in 0.7in 0.75in 0.7in;')
    expect(printHtml(report(), 'Book').html).toContain('@page { size: A4 portrait; margin: 0.5in 0.5in 0.5in 0.5in; }')
  })

  it('prints the header and footer the file gives the page, page numbers and all, in place of the heading', () => {
    const workbook = report()
    workbook.sheets.s.custom = { herald: { page: { headerFooter: { oddHeader: '&L&"Arial,Bold"&14Quarterly&RPrinted &D', oddFooter: '&LConfidential && <internal>&CPage &P of &N&R&F, &A' } } } }
    const { html } = printSheet(workbook, 'Book.xlsx', undefined, new Date(2026, 9, 10, 9, 30))

    expect(html).toContain('@top-left { content: "Quarterly"; text-align: left; vertical-align: top; padding-top: 0.3in;')
    expect(html).toContain(`@top-right { content: "Printed ${new Date(2026, 9, 10).toLocaleDateString()}";`)
    expect(html).toContain('@bottom-left { content: "Confidential & \\3C internal>"; text-align: left; vertical-align: bottom; padding-bottom: 0.3in;')
    expect(html).toContain('@bottom-center { content: "Page " counter(page) " of " counter(pages);')
    expect(html).toContain('@bottom-right { content: "Book.xlsx, Report";')
    expect(html).toContain('@page { size: A4 portrait; margin: 0.75in 0.7in 0.75in 0.7in; @top-left')
    expect(body(html)).not.toContain('<h1>')
    expect(body(printHtml(report(), 'Book').html)).toContain('<h1>Report</h1>')
  })

  it('prints a sheet whose cells have a key that is not a row, as Univer can leave one', () => {
    const workbook = report()
    Object.assign(workbook.sheets.s.cellData, { NaN: { 9: { v: 'stray' } } })

    expect(body(printHtml(workbook, 'Book').html)).toContain('<td>Rent</td>')
  })
})
