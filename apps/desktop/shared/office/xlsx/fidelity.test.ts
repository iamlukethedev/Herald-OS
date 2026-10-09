import { describe, expect, it } from 'vitest'
import { counted, inspectPackage } from './fidelity.ts'
import { featureWorkbook, handmadePackage, patchParts } from './fixtures.ts'
import { keptWorkbook } from './keep/fixtures.ts'
import { openPackage } from './package.ts'
import { workbookFromXlsx } from './read.ts'

const DRAWING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/></xdr:nvGraphicFramePr></xdr:graphicFrame></xdr:twoCellAnchor><xdr:oneCellAnchor><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Picture 1"/></xdr:nvPicPr></xdr:pic></xdr:oneCellAnchor><xdr:twoCellAnchor><xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="5" name="TextBox 1"/></xdr:nvSpPr></xdr:sp></xdr:twoCellAnchor></xdr:wsDr>`
const COMMENTS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>A</author></authors><commentList><comment ref="A1" authorId="0"><text><t>one</t></text></comment></commentList></comments>'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const relationships = (entries: string[][]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`

async function notesOf(bytes: Uint8Array, extension = '.xlsx'): Promise<string[]> {
  return (await workbookFromXlsx(bytes, { id: 'f', name: 'Fidelity', extension })).notes
}

/** The notes the package's parts give, without those of the features that read them (charts, comments). */
async function packageNotes(bytes: Uint8Array): Promise<string[]> {
  return (await inspectPackage(await openPackage(bytes))).notes
}

describe('fidelity report', () => {
  it('names what stays lost: macros, protection, print areas, form controls, embedded objects, data connections and the rest', async () => {
    const bytes = await handmadePackage({
      extraParts: {
        'xl/vbaProject.bin': 'binary',
        'xl/embeddings/oleObject1.bin': 'binary',
        'xl/ctrlProps/ctrlProp1.xml': '<formControlPr/>',
        'xl/connections.xml': '<connections/>',
        'xl/richData/rdrichvalue.xml': '<rvData/>',
        'xl/metadata.xml': '<metadata><dynamicArrayProperties fDynamic="1" fCollapsed="0"/></metadata>',
        '_xmlsignatures/sig1.xml': '<Signature/>'
      },
      sheetTail: '<sheetProtection sheet="1" objects="1"/><rowBreaks count="1"><brk id="10" max="16383" man="1"/></rowBreaks><legacyDrawingHF r:id="rId2"/><oleObjects><oleObject progId="Word.Document.12" shapeId="1025" r:id="rId1"/></oleObjects>',
      sheetRels: relationships([['rId1', 'oleObject', '../embeddings/oleObject1.bin']]),
      workbookExtra: '<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">\'Hand Made\'!$A$1:$C$6</definedName><definedName name="Rate">0.07</definedName></definedNames>'
    })
    const { workbook, notes } = await workbookFromXlsx(bytes, { id: 'f', name: 'Fidelity' })

    expect(workbook.sheets[workbook.sheetOrder[0]].cellData[1][0]).toEqual({ v: 10, t: 2 })
    expect(notes).toEqual([
      'Macros (VBA) are not kept: Herald Sheets does not run them, and a copy it saves has none.',
      'Protection (locked sheets, structure or a password to open for editing) is not kept: a saved copy is unprotected.',
      'Print areas, print titles and page breaks are not kept; page size, orientation, margins, scaling and headers stay.',
      'Pictures in page headers and footers are not kept.',
      'Form controls (buttons, check boxes, lists) are not kept.',
      'Embedded objects (other documents inside the workbook) are not kept.',
      'Data connections, queries and the data model are not kept; their last results stay as values.',
      'Pictures in cells and linked data types (such as stocks) are shown as plain values.',
      'Formulas that spill (dynamic arrays) are saved as fixed-size array formulas.',
      'The digital signature does not survive saving: a saved copy is unsigned.'
    ])
  })

  it('has nothing to say about what Herald keeps: charts, pictures, shapes, pivot tables, slicers, tables, sparklines, chart sheets, comments and the rest', async () => {
    const bytes = await handmadePackage({
      extraParts: {
        'xl/drawings/drawing1.xml': DRAWING,
        'xl/charts/chart1.xml': '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>',
        'xl/comments1.xml': COMMENTS,
        'xl/externalLinks/externalLink1.xml': '<externalLink/>',
        'xl/embeddings/Microsoft_Excel_Worksheet.xlsx': 'binary',
        'docProps/custom.xml': '<Properties/>'
      },
      sheetTail: '<picture r:id="rId9"/><extLst><ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}"><x14:sparklineGroups xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:sparklineGroup><x14:sparklines/></x14:sparklineGroup></x14:sparklineGroups></ext></extLst>'
    })

    expect(await packageNotes(bytes)).toEqual([])
    expect(await packageNotes(await keptWorkbook())).toEqual([])
  })

  it('names pivot tables, tables and slicers fed by a data connection, which go with it', async () => {
    const bytes = await patchParts(await keptWorkbook({ chartSheet: false }), {
      'xl/pivotCache/pivotCacheDefinition1.xml': (xml) => xml.replace(/<cacheSource type="worksheet">.*?<\/cacheSource>/, '<cacheSource type="external" connectionId="1"/>'),
      'xl/tables/table1.xml': (xml) => xml.replace('<table ', '<table tableType="queryTable" ')
    })

    expect(await packageNotes(bytes)).toEqual([
      'One pivot table fed by a data connection or the data model: its cells stay as plain values, without the pivot table that made them.',
      'One table fed by a data connection or an XML map becomes a plain range: data and formatting stay.',
      'Slicers and timelines on a data connection or the data model are not kept.'
    ])
  })

  it('names macros for a macro-enabled workbook, and dialog sheets', async () => {
    const bytes = await patchParts(await handmadePackage({ extraParts: { 'xl/dialogsheets/sheet2.xml': '<dialogsheet/>' } }), {
      'xl/workbook.xml': (xml) => xml.replace('</sheets>', '<sheet name="Dialog1" sheetId="2" r:id="rId9"/></sheets>'),
      'xl/_rels/workbook.xml.rels': (xml) => xml.replace('</Relationships>', '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/dialogsheet" Target="dialogsheets/sheet2.xml"/></Relationships>')
    })
    const { workbook, notes } = await workbookFromXlsx(bytes, { id: 'f', name: 'F', extension: '.xlsm' })

    expect(notes).toEqual(['Macros (VBA) are not kept: Herald Sheets does not run them, and a copy it saves has none.', 'One dialog or Excel 4.0 macro sheet is left out.'])
    expect(workbook.sheetOrder).toHaveLength(1)
  })

  it('has nothing to say about a plain workbook', async () => {
    expect(await notesOf(await handmadePackage())).toEqual([])
    expect((await notesOf(await featureWorkbook())).filter((note) => !note.startsWith('Patterned'))).toEqual([])
  })

  it('counts in words for one', () => {
    expect([counted(1, 'chart'), counted(3, 'chart'), counted(1200, 'note'), counted(2, 'shape or text box', 'shapes and text boxes')]).toEqual(['one chart', '3 charts', '1,200 notes', '2 shapes and text boxes'])
  })
})
