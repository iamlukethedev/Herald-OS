import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { CELL_TYPE, newSheet, newWorkbook } from '../workbook.ts'
import { childElements } from './drawing.ts'
import { DrawingBuilder } from './finish.ts'
import { HERALD_PART, readHeraldPart } from './herald-part.ts'
import { CONTENT_TYPE, PackageWriter, placeInWorkbook, placeInWorksheet, REL, relativeTarget } from './opc.ts'
import { openPackage } from './package.ts'
import { workbookFromXlsx } from './read.ts'
import { xlsxFromWorkbook } from './write.ts'

const SHEET = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/><pageMargins left="0.7"/><pageSetup/><tableParts count="0"/><extLst><ext uri="x"><x14:drawing/></ext></extLst></worksheet>'

describe('package helpers', () => {
  it('names a part from another relative to the first, as relationships do', () => {
    expect(relativeTarget('xl/worksheets/sheet1.xml', 'xl/drawings/drawing1.xml')).toBe('../drawings/drawing1.xml')
    expect(relativeTarget('xl/workbook.xml', 'xl/pivotCache/pivotCacheDefinition1.xml')).toBe('pivotCache/pivotCacheDefinition1.xml')
    expect(relativeTarget('_', 'herald/sheets.json')).toBe('herald/sheets.json')
  })

  it('puts elements where the schema has them, passing over names reused inside the extension list', () => {
    const placed = placeInWorksheet(SHEET, 'drawing', '<drawing r:id="rId1"/>')

    expect(placed.indexOf('<drawing r:id')).toBeGreaterThan(placed.indexOf('<pageSetup'))
    expect(placed.indexOf('<drawing r:id')).toBeLessThan(placed.indexOf('<tableParts'))
    const legacy = placeInWorksheet(placed, 'legacyDrawing', '<legacyDrawing r:id="rId2"/>')
    expect(legacy.indexOf('<legacyDrawing')).toBeGreaterThan(legacy.indexOf('<drawing r:id'))
    expect(legacy.indexOf('<legacyDrawing')).toBeLessThan(legacy.indexOf('<tableParts'))
    expect(placeInWorkbook('<workbook><sheets/><definedNames/><calcPr/><extLst/></workbook>', 'pivotCaches', '<pivotCaches/>')).toBe('<workbook><sheets/><definedNames/><calcPr/><pivotCaches/><extLst/></workbook>')
  })

  it('gives new relationships ids of their own and writes content types once', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types><Default Extension="xml" ContentType="application/xml"/></Types>')
    zip.file('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships><Relationship Id="rId1" Type="t" Target="../x.xml"/></Relationships>')
    const writer = new PackageWriter(zip)
    const id = await writer.relate('xl/worksheets/sheet1.xml', REL.drawing, 'xl/drawings/drawing1.xml')
    await writer.put('xl/drawings/drawing1.xml', '<xdr:wsDr/>', CONTENT_TYPE.drawing)
    await writer.setDefault('png', 'image/png')
    await writer.flush()

    expect(id).toBe('rId2')
    expect(await zip.file('xl/worksheets/_rels/sheet1.xml.rels')!.async('string')).toContain('Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"')
    const types = await zip.file('[Content_Types].xml')!.async('string')
    expect(types).toContain('<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>')
    expect(types).toContain('<Default Extension="png" ContentType="image/png"/>')
  })
})

describe('drawings', () => {
  it('writes the anchors a sheet gets into one drawing part, keeping the shape ids they bring', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types/>')
    zip.file('xl/worksheets/sheet1.xml', SHEET)
    const writer = new PackageWriter(zip)
    const drawings = new DrawingBuilder()
    drawings.add('s1', { xml: '<xdr:twoCellAnchor><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="7" name="Kept"/></xdr:nvPicPr><a:blip r:embed="{{rel:0}}"/></xdr:pic></xdr:twoCellAnchor>', relationships: [{ type: REL.image, target: 'xl/media/image1.png' }], namespaces: { 'xmlns:a14': 'urn:a14', 'mc:Ignorable': 'a14' } })
    drawings.add('s1', { xml: '<xdr:twoCellAnchor><xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="{{id}}" name="Chart"/></xdr:nvGraphicFramePr><c:chart r:id="{{rel:0}}"/></xdr:graphicFrame></xdr:twoCellAnchor>', relationships: [{ type: REL.chart, target: 'xl/charts/chart1.xml' }] })
    await drawings.write({ writer, sheets: [{ id: 's1', name: 'One', path: 'xl/worksheets/sheet1.xml' }] })
    await writer.flush()
    const drawing = await zip.file('xl/drawings/drawing1.xml')!.async('string')
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string')

    expect(drawing).toContain('<xdr:cNvPr id="7" name="Kept"/>')
    expect(drawing).toContain('<xdr:cNvPr id="8" name="Chart"/>')
    expect(drawing).toContain('r:embed="rId1"')
    expect(drawing).toContain('r:id="rId2"')
    expect(drawing).toMatch(/mc:Ignorable="a14"/)
    expect(sheet).toMatch(/<worksheet xmlns:r="[^"]+"/)
    expect(sheet.indexOf('<drawing r:id="rId1"/>')).toBeLessThan(sheet.indexOf('<tableParts'))
    expect(await zip.file('xl/drawings/_rels/drawing1.xml.rels')!.async('string')).toContain('Target="../charts/chart1.xml"')
  })
})

describe('source drawings', () => {
  it('splits a drawing into its anchors, an alternate content holding nested ones counted as one', () => {
    const slicer = '<mc:AlternateContent><mc:Choice Requires="sle15"><xdr:twoCellAnchor><mc:AlternateContent><mc:Choice/></mc:AlternateContent></xdr:twoCellAnchor></mc:Choice><mc:Fallback><xdr:twoCellAnchor/></mc:Fallback></mc:AlternateContent>'
    const xml = `<?xml version="1.0"?><xdr:wsDr xmlns:xdr="x"><xdr:twoCellAnchor editAs="oneCell"><xdr:pic/></xdr:twoCellAnchor><!-- note -->${slicer}<xdr:absoluteAnchor/></xdr:wsDr>`

    expect(childElements(xml)).toEqual(['<xdr:twoCellAnchor editAs="oneCell"><xdr:pic/></xdr:twoCellAnchor>', slicer, '<xdr:absoluteAnchor/>'])
  })
})

describe('Herald part', () => {
  it('keeps the Herald data of each sheet through a file, by the sheet’s name', async () => {
    const summary = { source: 'A1:C9', rows: ['Region'] }
    const sheet = { ...newSheet('s1', 'Summary', { 0: { 0: { v: 'Region', t: CELL_TYPE.string } } }), custom: { herald: { summaries: [summary] } } }
    const { bytes } = await xlsxFromWorkbook(newWorkbook('book', 'Book', [newSheet('s0', 'Data'), sheet]))
    const pkg = await openPackage(bytes)

    expect(pkg.files).toContain(HERALD_PART)
    expect((await readHeraldPart(pkg))?.sheets).toEqual({ Summary: { summaries: [summary] } })
    const { workbook } = await workbookFromXlsx(bytes, { id: 'again', name: 'Book' })
    expect((workbook.sheets['sheet-2'].custom as { herald?: unknown }).herald).toEqual({ summaries: [summary] })
  })

  it('writes no part for a workbook without Herald data', async () => {
    const { bytes } = await xlsxFromWorkbook(newWorkbook('book', 'Book'))

    expect((await openPackage(bytes)).files).not.toContain(HERALD_PART)
  })
})
