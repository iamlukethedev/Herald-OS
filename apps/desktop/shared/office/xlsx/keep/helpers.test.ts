import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { PackageWriter } from '../opc.ts'
import { renameSheetsIn, SheetNames } from './formulas.ts'
import { carried, childrenOf, extensionsOf, placeChild, withAttribute, withExtensions, withoutAttributes, WORKSHEET_ORDER } from './markup.ts'
import { StyleMerger } from './styles.ts'

const names = new SheetNames(
  [
    { from: 'Sales', to: 'Revenue' },
    { from: 'Q1 2024', to: 'First' },
    { from: "It's", to: "Bob's" },
    { from: 'Jan', to: 'January' },
    { from: 'Mar', to: 'Mar' }
  ],
  ['Revenue', 'First', "Bob's", 'January', 'Mar', 'Added']
)

/** A sheet as ExcelJS writes one with a data bar: an extension list inside the rule, none of the sheet's own. */
const SHEET = '<worksheet xmlns="m" xmlns:r="r"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><conditionalFormatting sqref="A1"><cfRule type="dataBar" priority="1"><dataBar/><extLst><ext uri="{B025F937-C7B1-47D3-B67F-A62EFF666E3E}"><x14:id/></ext></extLst></cfRule></conditionalFormatting><pageMargins left="0.7"/><pageSetup/></worksheet>'

describe('sheet names in formulas', () => {
  it('writes renamed sheets in, quoting where a name needs it', () => {
    expect(names.formula('SUM(Sales!A1:A3,\'Q1 2024\'!B2)')).toBe('SUM(Revenue!A1:A3,First!B2)')
    expect(names.formula("'It''s'!$A$1")).toBe("'Bob''s'!$A$1")
    expect(renameSheetsIn('Sales!A1', () => 'Sales 2024')).toBe("'Sales 2024'!A1")
    expect(names.formula('SUM(Jan:Mar!B2)')).toBe('SUM(January:Mar!B2)')
    expect(names.formula('_xlfn.XLOOKUP(Sales!A1,Added!A:A,Added!B:B)')).toBe('_xlfn.XLOOKUP(Revenue!A1,Added!A:A,Added!B:B)')
  })

  it('leaves text, other workbooks, structured references and errors as they are', () => {
    expect(names.formula('"Sales!A1"&Sales!A1')).toBe('"Sales!A1"&Revenue!A1')
    expect(names.formula("[1]Sales!A1+'[Book.xlsx]Sales'!B2+'C:\\Files\\[Old.xlsx]Sales'!C3")).toBe("[1]Sales!A1+'[Book.xlsx]Sales'!B2+'C:\\Files\\[Old.xlsx]Sales'!C3")
    expect(names.formula('SUM(Targets[Target])+Targets[[#This Row],[Target]]')).toBe('SUM(Targets[Target])+Targets[[#This Row],[Target]]')
    expect(names.formula('#REF!+Sales!A1+[0]!Total+Book.xlsx!Total')).toBe('#REF!+Revenue!A1+[0]!Total+Book.xlsx!Total')
  })

  it('finds a formula naming a sheet that is gone', () => {
    expect(names.formula('Gone!A1')).toBeNull()
    expect(names.formula("SUM(Sales!A1,'Old one'!B2)")).toBeNull()
    expect(names.kept('Added')).toBeNull()
    expect(names.sheet('Added')).toBe('Added')
  })
})

describe('placing elements', () => {
  it('passes over an extension list inside a conditional format', () => {
    expect(childrenOf(SHEET).map((child) => child.name)).toEqual(['sheetData', 'conditionalFormatting', 'pageMargins', 'pageSetup'])
    const placed = placeChild(SHEET, WORKSHEET_ORDER, 'tableParts', '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>')
    expect(placed).toContain('<pageSetup/><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>')
    const extended = withExtensions(placed, WORKSHEET_ORDER, ['<ext uri="a"/>'])
    expect(extended).toContain('</tableParts><extLst><ext uri="a"/></extLst></worksheet>')
    expect(extensionsOf(withExtensions(extended, WORKSHEET_ORDER, ['<ext uri="b"/>']))).toEqual(['<ext uri="a"/>', '<ext uri="b"/>'])
    expect(extensionsOf(SHEET)).toEqual([])
  })

  it('carries the namespace declarations an element uses from the root it leaves', () => {
    const root = { 'xmlns:xm': 'urn:xm', 'xmlns:x14': 'urn:x14', 'xmlns:mc': 'urn:mc' }

    expect(carried('<ext uri="u" xmlns:x14="urn:x14"><x14:a><xm:f>A1</xm:f></x14:a></ext>', root)).toBe('<ext xmlns:xm="urn:xm" uri="u" xmlns:x14="urn:x14"><x14:a><xm:f>A1</xm:f></x14:a></ext>')
  })

  it('sets and drops attributes on a start tag', () => {
    expect(withAttribute('<pivotCacheDefinition r:id="rId1">', 'refreshOnLoad', '1')).toBe('<pivotCacheDefinition r:id="rId1" refreshOnLoad="1">')
    expect(withAttribute('<worksheetSource ref="A1:C7" sheet="Sales"/>', 'sheet', 'R&D')).toBe('<worksheetSource ref="A1:C7" sheet="R&amp;D"/>')
    expect(withoutAttributes('<tableStyleInfo name="Mine" showRowStripes="1"/>', /^name$/)).toBe('<tableStyleInfo showRowStripes="1"/>')
  })
})

describe('the style sheet', () => {
  it('adds the number formats, differential formats and table styles kept parts use, with their new ids', async () => {
    const source = '<styleSheet xmlns="m"><numFmts count="2"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="#,##0&quot; kg&quot;"/></numFmts><cellXfs count="1"><xf/></cellXfs><dxfs count="2"><dxf><font><b/></font></dxf><dxf><font><i/></font></dxf></dxfs><tableStyles count="1"><tableStyle name="Mine" pivot="0" count="1"><tableStyleElement type="wholeTable" dxfId="1"/></tableStyle></tableStyles></styleSheet>'
    const zip = new JSZip()
    zip.file('xl/styles.xml', '<styleSheet xmlns="m"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0&quot; kg&quot;"/></numFmts><cellXfs count="1"><xf/></cellXfs><dxfs count="1"><dxf><fill/></dxf></dxfs><tableStyles count="0" defaultTableStyle="TableStyleMedium2"/></styleSheet>')
    const writer = new PackageWriter(zip)
    const styles = new StyleMerger(source)
    await styles.load(writer, 'xl/styles.xml')

    expect(styles.withStyleIds('<dataField numFmtId="165"/><format dxfId="1"/><x numFmtId="14" dataDxfId="7"/>')).toBe('<dataField numFmtId="164"/><format dxfId="1"/><x numFmtId="14"/>')
    expect(styles.numFmt(164)).toBe(165)
    expect(styles.tableStyle('Mine')).toBe(true)
    expect(styles.tableStyle('TableStyleLight9')).toBe(true)
    expect(styles.tableStyle('Missing')).toBe(false)
    await styles.flush(writer)
    const written = await writer.text('xl/styles.xml')

    expect(written).toContain('<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0&quot; kg&quot;"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts>')
    expect(written).toContain('<dxfs count="2"><dxf><fill/></dxf><dxf><font><i/></font></dxf></dxfs>')
    expect(written).toContain('<tableStyles count="1" defaultTableStyle="TableStyleMedium2"><tableStyle name="Mine" pivot="0" count="1"><tableStyleElement type="wholeTable" dxfId="1"/></tableStyle></tableStyles>')
  })
})
