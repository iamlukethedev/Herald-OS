import { handmadePackage } from '../fixtures.ts'

/*
 * For tests: packages written by hand as Excel writes notes and comment threads, on the one sheet
 * of `handmadePackage`. The people in them are made up.
 */

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships'

export const ROBIN = '{6A9B7C1D-2E3F-4A5B-8C7D-9E0F1A2B3C4D}'
export const SAM = '{0F1E2D3C-4B5A-4968-8776-A5B4C3D2E1F0}'
export const THREAD = '{B71D7C5F-66E6-40C9-A882-EBBD19E08FCA}'
export const REPLY = '{FA7EABBB-366A-44CD-ABFC-276B08A99920}'
export const RESOLVED = '{39CEC35F-4940-4B7F-A554-0005668A10C1}'

const shape = (id: number, row: number, col: number, size: string, shown: boolean) =>
  `<v:shape id="_x0000_s${id}" type="#_x0000_t202" style='position:absolute;margin-left:107.25pt;margin-top:1.5pt;${size};z-index:1;visibility:${shown ? 'visible' : 'hidden'}' fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style='mso-direction-alt:auto'><div style='text-align:left'></div></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>2, 15, 0, 2, 4, 15, 4, 2</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>${row}</x:Row><x:Column>${col}</x:Column>${shown ? '<x:Visible/>' : ''}</x:ClientData></v:shape>`

const vml = (shapes: string[]) =>
  `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>${shapes.join('')}</xml>`

const NOTE_RUN = '<rPr><sz val="9"/><color indexed="81"/><rFont val="Tahoma"/><family val="2"/></rPr>'

/** Two notes as Excel writes them: one starting with its author's name in bold (and a carriage return Excel escapes), one plain and shown. */
export function excelNotes(): Promise<Uint8Array> {
  return handmadePackage({
    sheetTail: '<legacyDrawing r:id="rId2"/>',
    sheetRels: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE}"><Relationship Id="rId1" Type="${OFFICE}/comments" Target="../comments1.xml"/><Relationship Id="rId2" Type="${OFFICE}/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/></Relationships>`,
    extraContentTypes: '<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/><Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>',
    extraParts: {
      'xl/comments1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<comments xmlns="${MAIN}"><authors><author>Robin Example</author><author>Sam Sample</author></authors><commentList><comment ref="B2" authorId="0"><text><r><rPr><b/><sz val="9"/><color indexed="81"/><rFont val="Tahoma"/><family val="2"/></rPr><t>Robin Example:</t></r><r>${NOTE_RUN}<t xml:space="preserve">_x000D_\nCheck this total
before sending</t></r></text></comment><comment ref="C4" authorId="1"><text><t>Plain note &amp; more</t></text></comment></commentList></comments>`,
      'xl/drawings/vmlDrawing1.vml': vml([shape(1025, 1, 1, 'width:144pt;height:72pt', false), shape(1026, 3, 2, 'width:96pt;height:55.5pt', true)])
    }
  })
}

/** A comment thread with a reply and a mention, a resolved thread, and a note, as Excel 365 writes them, with the placeholders it keeps for older versions. */
export function excelThreads(): Promise<Uint8Array> {
  const placeholder = (text: string) => `[Threaded comment]\n\nYour version of Excel allows you to read this threaded comment; however, any edits to it will get removed if the file is opened in a newer version of Excel. Learn more: https://go.microsoft.com/fwlink/?linkid=870924\n\nComment:\n    ${text}`

  return handmadePackage({
    sheetTail: '<legacyDrawing r:id="rId3"/>',
    sheetRels: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE}"><Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" Target="../threadedComments/threadedComment1.xml"/><Relationship Id="rId2" Type="${OFFICE}/comments" Target="../comments1.xml"/><Relationship Id="rId3" Type="${OFFICE}/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/></Relationships>`,
    extraContentTypes:
      '<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/><Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/><Override PartName="/xl/threadedComments/threadedComment1.xml" ContentType="application/vnd.ms-excel.threadedcomments+xml"/><Override PartName="/xl/persons/person.xml" ContentType="application/vnd.ms-excel.person+xml"/>',
    extraParts: {
      'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE}"><Relationship Id="rId1" Type="${OFFICE}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${OFFICE}/styles" Target="styles.xml"/><Relationship Id="rId3" Type="${OFFICE}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="${OFFICE}/theme" Target="theme/theme1.xml"/><Relationship Id="rId5" Type="http://schemas.microsoft.com/office/2017/10/relationships/person" Target="persons/person.xml"/></Relationships>`,
      'xl/persons/person.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments" xmlns:x="${MAIN}"><person displayName="Robin Example" id="${ROBIN}" userId="S::robin@example.com::5c1d2e3f-0000-4000-8000-000000000001" providerId="AD"/><person displayName="Sam Sample" id="${SAM}" userId="Sam Sample" providerId="None"/></personList>`,
      'xl/threadedComments/threadedComment1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments" xmlns:x="${MAIN}"><threadedComment ref="B3" dT="2026-03-04T05:06:07.89" personId="${ROBIN}" id="${THREAD}"><text>Is this total right?
It looks high.</text></threadedComment><threadedComment ref="B3" dT="2026-03-04T06:00:00.00" personId="${SAM}" id="${REPLY}" parentId="${THREAD}"><text>@Robin Example yes, checked.</text><mentions><mention mentionpersonId="${ROBIN}" mentionId="{11111111-2222-4333-8444-555555555555}" startIndex="0" length="14"/></mentions></threadedComment><threadedComment ref="C2" dT="2026-03-05T09:30:00.00" personId="${SAM}" id="${RESOLVED}" done="1"><text>Fixed the rate</text></threadedComment></ThreadedComments>`,
      'xl/comments1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<comments xmlns="${MAIN}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="xr" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision"><authors><author>tc=${THREAD}</author><author>tc=${RESOLVED}</author><author>Robin Example</author></authors><commentList><comment ref="C2" authorId="1" shapeId="0" xr:uid="${RESOLVED}"><text><t>${placeholder('Fixed the rate')}</t></text></comment><comment ref="B3" authorId="0" shapeId="0" xr:uid="${THREAD}"><text><t>${placeholder('Is this total right?')}</t></text></comment><comment ref="A6" authorId="2" shapeId="0" xr:uid="{C0FFEE00-1234-4567-89AB-CDEF01234567}"><text><t>An old-style note</t></text></comment></commentList></comments>`,
      'xl/drawings/vmlDrawing1.vml': vml([shape(1025, 1, 2, 'width:108pt;height:59.25pt', false), shape(1026, 2, 1, 'width:108pt;height:59.25pt', false), shape(1027, 5, 0, 'width:120pt;height:40pt', false)])
    }
  })
}
