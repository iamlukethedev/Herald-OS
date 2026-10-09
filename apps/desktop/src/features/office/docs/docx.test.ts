import { Document, ExternalHyperlink, HeadingLevel, ImageRun, LevelFormat, Packer, PageBreak, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { dataUrl, type DocMark, type DocNode } from '../../../../shared/office/document.ts'
import { png } from '../../../../shared/office/docx/fixtures.ts'
import { documentFromDocx } from '../../../../shared/office/docx/read.ts'
import { docsSchema } from './schema.ts'

// Word files made here, from XML written in the tests and with the docx package, so no file is needed.

const NAMESPACES: Record<string, string> = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  v: 'urn:schemas-microsoft-com:vml',
  o: 'urn:schemas-microsoft-com:office:office',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml'
}

const XMLNS = Object.entries(NAMESPACES)
  .map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`)
  .join(' ')

const RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const RELATIONSHIP_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

interface Parts {
  body: string
  styles?: string
  numbering?: string
  footnotes?: string
  comments?: string
  /** The theme's heading and body fonts. */
  theme?: [string, string]
  /** More relationships of the main document: id, type (short or full), target, and whether it is external. */
  relationships?: [string, string, string, boolean?][]
  /** Other parts, by their path in the zip. */
  files?: Record<string, string | Uint8Array>
}

async function wordFile(parts: Parts): Promise<Uint8Array> {
  const zip = new JSZip()
  const relationships = [...(parts.relationships ?? [])]
  const part = (name: string, root: string, inner: string | undefined): void => {
    if (inner !== undefined) {
      zip.file(`word/${name}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${root} ${XMLNS}>${inner}</w:${root}>`)
      relationships.push([`rId${name}`, name, `${name}.xml`])
    }
  }

  part('styles', 'styles', parts.styles)
  part('numbering', 'numbering', parts.numbering)
  part('footnotes', 'footnotes', parts.footnotes)
  part('comments', 'comments', parts.comments)

  if (parts.theme) {
    const [major, minor] = parts.theme
    zip.file(
      'word/theme/theme1.xml',
      `<a:theme xmlns:a="${NAMESPACES.a}" name="Office"><a:themeElements><a:fontScheme name="Office"><a:majorFont><a:latin typeface="${major}"/></a:majorFont><a:minorFont><a:latin typeface="${minor}"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`
    )
    relationships.push(['rIdTheme', 'theme', 'theme/theme1.xml'])
  }

  for (const [path, content] of Object.entries(parts.files ?? {})) {
    zip.file(path, content)
  }

  const relationshipXml = relationships
    .map(([id, type, target, external]) => `<Relationship Id="${id}" Type="${type.includes('/') ? type : `${RELATIONSHIP_TYPE}/${type}`}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`)
    .join('')
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  )
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELATIONSHIPS}"><Relationship Id="rId1" Type="${RELATIONSHIP_TYPE}/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${XMLNS}><w:body>${parts.body}</w:body></w:document>`)
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELATIONSHIPS}">${relationshipXml}</Relationships>`)

  return zip.generateAsync({ type: 'uint8array' })
}

/** Reads a file and checks the document against Herald Docs' schema. */
async function read(file: Parts | Uint8Array) {
  const result = await documentFromDocx(file instanceof Uint8Array ? file : await wordFile(file))
  docsSchema().nodeFromJSON(result.doc).check()

  return result
}

const run = (text: string, rPr = ''): string => `<w:r>${rPr && `<w:rPr>${rPr}</w:rPr>`}<w:t xml:space="preserve">${text}</w:t></w:r>`
const para = (content: string, pPr = ''): string => `<w:p>${pPr && `<w:pPr>${pPr}</w:pPr>`}${content}</w:p>`
const pStyle = (id: string): string => `<w:pStyle w:val="${id}"/>`
const numPr = (numId: number, ilvl: number): string => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`
const paragraphStyle = (id: string, name: string, inner = ''): string => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>${inner}</w:style>`
const characterStyle = (id: string, name: string, rPr = ''): string => `<w:style w:type="character" w:styleId="${id}"><w:name w:val="${name}"/><w:rPr>${rPr}</w:rPr></w:style>`

const DEFAULTS =
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'

const BASE_STYLES = [
  DEFAULTS,
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
  '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/></w:style>',
  '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style>',
  '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr></w:style>',
  characterStyle('Hyperlink', 'Hyperlink', '<w:color w:val="0563C1"/><w:u w:val="single"/>'),
  paragraphStyle('ListParagraph', 'List Paragraph', '<w:pPr><w:ind w:left="720"/></w:pPr>')
].join('')

const THEME: [string, string] = ['Calibri Light', 'Calibri']

const text = (value: string, marks?: DocMark[]): DocNode => (marks ? { type: 'text', text: value, marks } : { type: 'text', text: value })
const paragraph = (value?: string, attrs?: Record<string, unknown>): DocNode => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), ...(value ? { content: [text(value)] } : {}) })
const item = (value: string): DocNode => ({ type: 'listItem', content: [paragraph(value)] })
const link = (href: string): DocMark => ({ type: 'link', attrs: { href } })
const bold: DocMark = { type: 'bold' }
const italic: DocMark = { type: 'italic' }
const textStyle = (attrs: Record<string, string>): DocMark => ({ type: 'textStyle', attrs })

const graphic = (id: string, cx: number, cy: number, attrs = ''): string =>
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip ${attrs || `r:embed="${id}"`}/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`

const inlinePicture = (id: string, cx: number, cy: number, descr: string, attrs = ''): string =>
  `<w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="Picture 1" descr="${descr}"/>${graphic(id, cx, cy, attrs)}</wp:inline></w:drawing></w:r>`

const floatingPicture = (id: string, cx: number, cy: number, descr: string): string =>
  `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="2" name="Picture 2" descr="${descr}"/>${graphic(id, cx, cy)}</wp:anchor></w:drawing></w:r>`

const field = (instruction: string, result: string): string =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instruction} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${result}<w:r><w:fldChar w:fldCharType="end"/></w:r>`

describe('documentFromDocx: styles', () => {
  it('resolves the document defaults and basedOn chains into a whole look for each style the file has', async () => {
    const { doc, notes } = await read({
      theme: THEME,
      styles: [
        BASE_STYLES,
        paragraphStyle('Title', 'Title', '<w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:sz w:val="56"/></w:rPr>'),
        paragraphStyle('Heading1', 'heading 1', '<w:pPr><w:spacing w:before="240" w:after="0"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:color w:val="2F5496"/><w:sz w:val="32"/></w:rPr>'),
        '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Heading1"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:sz w:val="26"/></w:rPr></w:style>'
      ].join(''),
      body: [
        para(run('Quarterly plan'), pStyle('Title')),
        para(run('Goals'), pStyle('Heading1')),
        para(run('Big', '<w:sz w:val="32"/>') + run(' smaller', '<w:sz w:val="28"/>'), pStyle('Heading1')),
        para(run('Scope'), pStyle('Heading2')),
        para(run('Body text'))
      ].join('')
    })

    expect(doc.content).toEqual([
      paragraph('Quarterly plan', { docStyle: 'title' }),
      { type: 'heading', attrs: { level: 1 }, content: [text('Goals')] },
      { type: 'heading', attrs: { level: 1 }, content: [text('Big'), text(' smaller', [textStyle({ fontSize: '14pt' })])] },
      { type: 'heading', attrs: { level: 2 }, content: [text('Scope')] },
      paragraph('Body text')
    ])
    expect(doc.attrs?.styles).toEqual({
      normal: { font: 'Calibri', size: 11, bold: false, italic: false, spaceBefore: 0, spaceAfter: 8, lineHeight: 1.079 },
      title: { font: 'Calibri Light', size: 28, bold: false, italic: false, spaceBefore: 0, spaceAfter: 0, lineHeight: 1.079 },
      heading1: { font: 'Calibri Light', size: 16, color: '#2f5496', bold: false, italic: false, spaceBefore: 12, spaceAfter: 0, lineHeight: 1.079 },
      heading2: { font: 'Calibri Light', size: 13, color: '#2f5496', bold: false, italic: false, spaceBefore: 12, spaceAfter: 0, lineHeight: 1.079 }
    })
    expect(notes).toEqual([])
  })

  it('keeps styles Herald Docs does not have as the formatting they give, and names them once', async () => {
    const { doc, notes } = await read({
      theme: THEME,
      styles: [
        BASE_STYLES,
        paragraphStyle('QuoteBox', 'Quote Box', '<w:pPr><w:spacing w:before="120"/><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:color w:val="1F4E79"/></w:rPr>'),
        paragraphStyle('Caption', 'caption', '<w:rPr><w:i/><w:color w:val="44546A"/><w:sz w:val="18"/></w:rPr>'),
        paragraphStyle('NoSpacing', 'No Spacing', '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'),
        paragraphStyle('Aside', 'Aside')
      ].join(''),
      body: [para(run('Ada said so'), pStyle('QuoteBox')), para(run('Figure 1'), pStyle('Caption')), para(run('Tight'), pStyle('NoSpacing')), para(run('By the way'), pStyle('Aside')), para(run('Again'), pStyle('QuoteBox'))].join('')
    })

    const boxed = (value: string): DocNode => ({ type: 'paragraph', attrs: { textAlign: 'center', spaceBefore: 6 }, content: [text(value, [textStyle({ color: '#1f4e79' }), italic])] })

    expect(doc.content).toEqual([
      boxed('Ada said so'),
      { type: 'paragraph', content: [text('Figure 1', [textStyle({ color: '#44546a', fontSize: '9pt' }), italic])] },
      paragraph('Tight', { lineHeight: 1, spaceAfter: 0 }),
      paragraph('By the way'),
      boxed('Again')
    ])
    expect(notes).toEqual(['Styles Herald Docs does not have (Quote Box, Caption, No Spacing and others) are kept as the formatting they give the text.'])
  })

  it('applies character styles, which turn off what the paragraph style turns on, as in Word', async () => {
    const { doc, notes } = await read({
      styles: [BASE_STYLES, paragraphStyle('Lead', 'Lead', '<w:rPr><w:b/></w:rPr>'), characterStyle('Strong', 'Strong', '<w:b/>'), characterStyle('VerbatimChar', 'Verbatim Char', '<w:rFonts w:ascii="Consolas"/>')].join(''),
      body: [
        para(run('Lead in ') + run('strong', '<w:rStyle w:val="Strong"/>'), pStyle('Lead')),
        para(run('Bold', '<w:rStyle w:val="Strong"/>') + run(' and ') + run('npm test', '<w:rStyle w:val="VerbatimChar"/><w:b/>'))
      ].join('')
    })

    expect(doc.content).toEqual([
      { type: 'paragraph', content: [text('Lead in ', [bold]), text('strong')] },
      { type: 'paragraph', content: [text('Bold', [bold]), text(' and '), text('npm test', [{ type: 'code' }])] }
    ])
    expect(notes).toEqual(['Styles Herald Docs does not have (Lead, Strong) are kept as the formatting they give the text.'])
  })

  it('finds titles and headings by name, id and outline level, and shows deeper headings as level 6', async () => {
    const { doc, notes } = await read({
      styles: [
        BASE_STYLES,
        paragraphStyle('Subtitle', 'Subtitle'),
        paragraphStyle('berschrift3', 'heading 3'),
        paragraphStyle('Chapter', 'Chapter', '<w:pPr><w:outlineLvl w:val="1"/></w:pPr>'),
        paragraphStyle('Heading8', 'heading 8')
      ].join(''),
      body: [para(run('Overview'), pStyle('Subtitle')), para(run('Three'), pStyle('berschrift3')), para(run('Two'), pStyle('Chapter')), para(run('One'), '<w:outlineLvl w:val="0"/>'), para(run('Eight'), pStyle('Heading8'))].join('')
    })

    expect(doc.content).toEqual([
      paragraph('Overview', { docStyle: 'subtitle' }),
      { type: 'heading', attrs: { level: 3 }, content: [text('Three')] },
      { type: 'heading', attrs: { level: 2 }, content: [text('Two')] },
      { type: 'heading', attrs: { level: 1 }, content: [text('One')] },
      { type: 'heading', attrs: { level: 6 }, content: [text('Eight')] }
    ])
    expect(notes).toEqual(['Headings below level 6 are shown as level 6 headings.'])
  })

  it('puts quote, code and callout paragraphs together', async () => {
    const { doc } = await read({
      styles: [
        BASE_STYLES,
        paragraphStyle('Quote', 'Quote', '<w:rPr><w:i/></w:rPr>'),
        paragraphStyle('IntenseQuote', 'Intense Quote', '<w:rPr><w:b/><w:i/></w:rPr>'),
        paragraphStyle('SourceCode', 'Source Code', '<w:rPr><w:rFonts w:ascii="Consolas"/></w:rPr>'),
        paragraphStyle('HeraldCalloutWarning', 'Callout Warning'),
        paragraphStyle('HeraldCalloutInfo', 'Callout Info')
      ].join(''),
      body: [
        para(run('Ada said'), pStyle('Quote')),
        para(run('loudly'), pStyle('IntenseQuote')),
        para(run('let a = 1'), pStyle('SourceCode')),
        para('', pStyle('SourceCode')),
        para('<w:r><w:tab/><w:t>a()</w:t></w:r>', pStyle('SourceCode')),
        para(run('Mind the gap'), pStyle('HeraldCalloutWarning')),
        para(run('Twice'), pStyle('HeraldCalloutWarning')),
        para(run('For your information'), pStyle('HeraldCalloutInfo'))
      ].join('')
    })

    expect(doc.content).toEqual([
      { type: 'blockquote', content: [paragraph('Ada said'), { type: 'paragraph', content: [text('loudly', [bold])] }] },
      { type: 'codeBlock', content: [text('let a = 1\n\n\ta()')] },
      { type: 'callout', attrs: { kind: 'warning' }, content: [paragraph('Mind the gap'), paragraph('Twice')] },
      { type: 'callout', content: [paragraph('For your information')] }
    ])
  })
})

describe('documentFromDocx: paragraphs and runs', () => {
  it('reads alignment, spacing, line spacing and indents that differ from the style', async () => {
    const { doc } = await read({
      theme: THEME,
      styles: BASE_STYLES,
      body: [
        para(run('Justified'), '<w:spacing w:before="240" w:after="0" w:line="360" w:lineRule="auto"/><w:jc w:val="both"/>'),
        para(run('Exact'), '<w:spacing w:line="330" w:lineRule="exact"/>'),
        para(run('Hanging'), '<w:ind w:left="720" w:hanging="360"/>'),
        para(run('First line'), '<w:ind w:start="1440" w:firstLine="360"/><w:jc w:val="end"/>')
      ].join('')
    })

    expect(doc.content).toEqual([
      paragraph('Justified', { textAlign: 'justify', lineHeight: 1.5, spaceBefore: 12, spaceAfter: 0 }),
      paragraph('Exact', { lineHeight: 1.25 }),
      paragraph('Hanging', { indent: 36, firstLine: -18 }),
      paragraph('First line', { textAlign: 'right', indent: 72, firstLine: 18 })
    ])
  })

  it('reads run formatting as marks, and leaves hidden text out', async () => {
    const { doc, notes } = await read({
      theme: THEME,
      styles: BASE_STYLES,
      body: para(
        [
          run('b', '<w:b/>'),
          run('i', '<w:i/>'),
          run('u', '<w:u w:val="single"/>'),
          run('n', '<w:u w:val="none"/>'),
          run('s', '<w:strike/>'),
          run('d', '<w:dstrike/>'),
          run('c', '<w:color w:val="C00000"/>'),
          run('a', '<w:color w:val="auto"/>'),
          run('h', '<w:highlight w:val="cyan"/>'),
          run('f', '<w:shd w:val="clear" w:color="auto" w:fill="FFF2CC"/>'),
          run('z', '<w:sz w:val="36"/>'),
          run('g', '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/>'),
          run('2', '<w:vertAlign w:val="superscript"/>'),
          run('o', '<w:vertAlign w:val="subscript"/>'),
          run('secret', '<w:vanish/>')
        ].join('')
      )
    })

    expect(doc.content).toEqual([
      {
        type: 'paragraph',
        content: [
          text('b', [bold]),
          text('i', [italic]),
          text('u', [{ type: 'underline' }]),
          text('n'),
          text('sd', [{ type: 'strike' }]),
          text('c', [textStyle({ color: '#c00000' })]),
          text('a'),
          text('h', [{ type: 'highlight', attrs: { color: '#00ffff' } }]),
          text('f', [{ type: 'highlight', attrs: { color: '#fff2cc' } }]),
          text('z', [textStyle({ fontSize: '18pt' })]),
          text('g', [textStyle({ fontFamily: 'Georgia' })]),
          text('2', [{ type: 'superscript' }]),
          text('o', [{ type: 'subscript' }])
        ]
      }
    ])
    expect(notes).toEqual(['Hidden text is left out.'])
  })

  it('reads line breaks, tabs, hyphens and symbols, and splits paragraphs at page breaks', async () => {
    const { doc } = await read({
      body: [
        para('<w:r><w:t>one</w:t><w:br/><w:t>two</w:t><w:br w:type="textWrapping"/><w:t>three</w:t><w:cr/><w:t>four</w:t></w:r>'),
        para('<w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:noBreakHyphen/><w:t>c</w:t><w:softHyphen/><w:t>d</w:t><w:sym w:font="Symbol" w:char="03A9"/></w:r>'),
        para('<w:r><w:t>before</w:t><w:br w:type="page"/><w:t>after</w:t></w:r>'),
        para('<w:r><w:br w:type="page"/><w:t>top</w:t></w:r>'),
        para('<w:r><w:t>end</w:t><w:br w:type="page"/></w:r>'),
        para('<w:r><w:t>col</w:t><w:br w:type="column"/><w:lastRenderedPageBreak/><w:t>umn</w:t></w:r><w:bookmarkStart w:id="0" w:name="here"/><w:proofErr w:type="spellStart"/><w:bookmarkEnd w:id="0"/>'),
        para('<w:r><w:t>  trimmed  </w:t></w:r><w:r><w:t xml:space="preserve"> kept </w:t></w:r>')
      ].join('')
    })
    const hardBreak = { type: 'hardBreak' }
    const pageBreak = { type: 'pageBreak' }

    expect(doc.content).toEqual([
      { type: 'paragraph', content: [text('one'), hardBreak, text('two'), hardBreak, text('three'), hardBreak, text('four')] },
      paragraph('a\tb\u2011c\u00add\u03a9'),
      paragraph('before'),
      pageBreak,
      paragraph('after'),
      pageBreak,
      paragraph('top'),
      paragraph('end'),
      pageBreak,
      paragraph('column'),
      paragraph('trimmed kept ')
    ])
  })

  it('breaks the page before a paragraph that asks for it, except the first, and reads rules', async () => {
    const { doc } = await read({
      body: [
        para(run('First'), '<w:pageBreakBefore/>'),
        para(run('Second'), '<w:pageBreakBefore/>'),
        para('', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>'),
        para('<w:r><w:pict><v:rect style="width:0;height:1.5pt" o:hralign="center" o:hrstd="t" o:hr="t" fillcolor="#a0a0a0" stroked="f"/></w:pict></w:r>')
      ].join('')
    })

    expect(doc.content).toEqual([paragraph('First'), { type: 'pageBreak' }, paragraph('Second'), { type: 'horizontalRule' }, { type: 'horizontalRule' }])
  })
})

const level = (ilvl: number, format: string, text: string, indent: number, extra = ''): string =>
  `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>${extra}<w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr></w:lvl>`

const NUMBERING = [
  `<w:abstractNum w:abstractNumId="0">${level(0, 'bullet', '\u2022', 720)}${level(1, 'decimal', '%2.', 1440)}</w:abstractNum>`,
  `<w:abstractNum w:abstractNumId="1">${level(0, 'decimal', '%1.', 720)}${level(1, 'lowerLetter', '%2.', 1440)}${level(2, 'lowerRoman', '%3.', 2160)}</w:abstractNum>`,
  `<w:abstractNum w:abstractNumId="2">${level(0, 'decimalZero', '%1.', 720)}</w:abstractNum>`,
  `<w:abstractNum w:abstractNumId="3">${level(0, 'decimal', '%1.', 0, '<w:pStyle w:val="Heading1"/>')}${level(1, 'decimal', '%1.%2', 0, '<w:pStyle w:val="Heading2"/>')}</w:abstractNum>`,
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>',
  '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>',
  '<w:num w:numId="3"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>',
  '<w:num w:numId="4"><w:abstractNumId w:val="2"/></w:num>',
  '<w:num w:numId="5"><w:abstractNumId w:val="3"/></w:num>'
].join('')

describe('documentFromDocx: lists', () => {
  it('reads bullet and numbered levels, their nesting and their starts', async () => {
    const { doc, notes } = await read({
      styles: BASE_STYLES,
      numbering: NUMBERING,
      body: [
        para(run('Milk'), numPr(1, 0)),
        para(run('Whole'), numPr(1, 1)),
        para(run('Skimmed'), numPr(1, 1)),
        para(run('Bread'), numPr(1, 0)),
        para(run('Between')),
        para(run('Fifth'), numPr(3, 0)),
        para(run('Sixth'), numPr(3, 0)),
        para(run('Deep'), numPr(3, 1))
      ].join('')
    })

    expect(doc.content).toEqual([
      { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('Milk'), { type: 'orderedList', content: [item('Whole'), item('Skimmed')] }] }, item('Bread')] },
      paragraph('Between'),
      { type: 'orderedList', attrs: { start: 5 }, content: [item('Fifth'), { type: 'listItem', content: [paragraph('Sixth'), { type: 'orderedList', attrs: { type: 'a' }, content: [item('Deep')] }] }] }
    ])
    expect(notes).toEqual([])
  })

  it('nests a level that jumps deeper only one level down, keeping how it numbers', async () => {
    const { doc } = await read({ numbering: NUMBERING, body: [para(run('Top'), numPr(2, 0)), para(run('Two down'), numPr(2, 2)), para(run('Back'), numPr(2, 0))].join('') })

    expect(doc.content).toEqual([{ type: 'orderedList', content: [{ type: 'listItem', content: [paragraph('Top'), { type: 'orderedList', attrs: { type: 'i' }, content: [item('Two down')] }] }, item('Back')] }])
  })

  it('goes on counting across the paragraphs between a list’s items, as Word does', async () => {
    const { doc } = await read({ numbering: NUMBERING, body: [para(run('One'), numPr(2, 0)), para(run('Two'), numPr(2, 0)), para(run('A note')), para(run('Three'), numPr(2, 0))].join('') })

    expect(doc.content).toEqual([{ type: 'orderedList', content: [item('One'), item('Two')] }, paragraph('A note'), { type: 'orderedList', attrs: { start: 3 }, content: [item('Three')] }])
  })

  it('takes numbering from a paragraph style, and List Paragraphs after an item into the item', async () => {
    const { doc, notes } = await read({
      styles: BASE_STYLES + paragraphStyle('ListNumber', 'List Number', `<w:pPr>${numPr(2, 0)}</w:pPr>`),
      numbering: NUMBERING,
      body: [para(run('Plan'), pStyle('ListNumber')), para(run('Details of the plan'), pStyle('ListParagraph')), para(run('Act'), pStyle('ListNumber')), para(run('After'), pStyle('ListParagraph') + '<w:ind w:left="2880"/>')].join('')
    })

    expect(doc.content).toEqual([{ type: 'orderedList', content: [{ type: 'listItem', content: [paragraph('Plan'), paragraph('Details of the plan')] }, item('Act')] }, paragraph('After', { indent: 144 })])
    expect(notes).toEqual([])
  })

  it('reads paragraphs that start with a ballot box as checklist items', async () => {
    const { doc, notes } = await read({
      styles: BASE_STYLES,
      body: [
        para(run('\u2610 Buy milk'), pStyle('ListParagraph')),
        para(run('\u2612 Call Ada'), pStyle('ListParagraph')),
        para(run('\u2611 Book the room'), pStyle('ListParagraph') + '<w:ind w:left="1440"/>'),
        para(`<w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="0"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:rPr><w:rFonts w:ascii="MS Gothic"/></w:rPr><w:t>\u2610</w:t></w:r></w:sdtContent></w:sdt>${run(' Fill in the form')}`)
      ].join('')
    })
    const task = (value: string, checked = false, more: DocNode[] = []): DocNode => ({ type: 'taskItem', ...(checked ? { attrs: { checked } } : {}), content: [paragraph(value), ...more] })

    expect(doc.content).toEqual([{ type: 'taskList', content: [task('Buy milk'), task('Call Ada', true, [{ type: 'taskList', content: [task('Book the room', true)] }]), task('Fill in the form')] }])
    expect(notes).toEqual(['Content controls (form fields, checkboxes) are shown as their text.'])
  })

  it('keeps numbered headings’ numbers as text, and shows other number formats as plain numbers', async () => {
    const { doc, notes } = await read({
      styles: BASE_STYLES + paragraphStyle('Heading1', 'heading 1', `<w:pPr><w:numPr><w:numId w:val="5"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr>`) + paragraphStyle('Heading2', 'heading 2', `<w:pPr>${numPr(5, 1)}</w:pPr>`),
      numbering: NUMBERING,
      body: [para(run('Intro'), pStyle('Heading1')), para(run('Scope'), pStyle('Heading2')), para(run('Zero one'), numPr(4, 0)), para(run('Background'), pStyle('Heading1'))].join('')
    })

    expect(doc.content).toEqual([
      { type: 'heading', attrs: { level: 1 }, content: [text('1. Intro')] },
      { type: 'heading', attrs: { level: 2 }, content: [text('1.1 Scope')] },
      { type: 'orderedList', content: [item('Zero one')] },
      { type: 'heading', attrs: { level: 1 }, content: [text('2. Background')] }
    ])
    expect(notes).toEqual(['Numbered headings keep their numbers as text.', 'Some list numbering (such as 01 or First) is shown as plain numbers.'])
  })
})

const cell = (value: string, colwidth?: number[], attrs: Record<string, unknown> = {}): DocNode => ({ type: 'tableCell', ...(colwidth || Object.keys(attrs).length ? { attrs: { ...(colwidth ? { colwidth } : {}), ...attrs } } : {}), content: [paragraph(value || undefined)] })

describe('documentFromDocx: tables', () => {
  it('reads column and row spans, header rows, widths and shading', async () => {
    const { doc } = await read({
      styles: BASE_STYLES,
      body: `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="1500"/><w:gridCol w:w="1500"/><w:gridCol w:w="3000"/></w:tblGrid>
        <w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${para(run('Name'))}</w:tc><w:tc>${para(run('Notes'))}</w:tc></w:tr>
        <w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/><w:shd w:val="clear" w:color="auto" w:fill="E2EFDA"/></w:tcPr>${para(run('Ada'))}</w:tc><w:tc>${para(run('A'))}</w:tc><w:tc>${para(run('First'))}</w:tc></w:tr>
        <w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr>${para('')}</w:tc><w:tc>${para(run('B'))}</w:tc><w:tc>${para(run('Second'))}</w:tc></w:tr>
      </w:tbl>${para('')}`
    })

    expect(doc.content).toEqual([
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [{ ...cell('Name', [100, 100], { colspan: 2 }), type: 'tableHeader' }, { ...cell('Notes', [200]), type: 'tableHeader' }] },
          { type: 'tableRow', content: [cell('Ada', [100], { background: '#e2efda', rowspan: 2 }), cell('A', [100]), cell('First', [200])] },
          { type: 'tableRow', content: [cell('B', [100]), cell('Second', [200])] }
        ]
      }
    ])
  })

  it('fills rows out to the grid, and turns borders off only when neither the table nor its style draws any', async () => {
    const none = '<w:tblBorders><w:top w:val="none"/><w:left w:val="nil"/><w:bottom w:val="none"/><w:right w:val="none"/><w:insideH w:val="none"/><w:insideV w:val="none"/></w:tblBorders>'
    const grid = '<w:tblGrid><w:gridCol w:w="1500"/><w:gridCol w:w="1500"/><w:gridCol w:w="1500"/></w:tblGrid>'
    const tc = (value: string) => `<w:tc>${para(run(value))}</w:tc>`
    const { doc } = await read({
      styles: BASE_STYLES,
      body: [
        `<w:tbl><w:tblPr>${none}</w:tblPr>${grid}<w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr>${tc('b')}${tc('c')}</w:tr><w:tr><w:trPr><w:gridAfter w:val="1"/></w:trPr>${tc('a')}${tc('b')}</w:tr><w:tr>${tc('only')}</w:tr></w:tbl>`,
        `<w:tbl><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="1500"/></w:tblGrid><w:tr>${tc('inner')}</w:tr></w:tbl>${para('')}</w:tc></w:tr></w:tbl>`
      ].join('')
    })
    const empty = (span = 1): DocNode => ({ type: 'tableCell', ...(span > 1 ? { attrs: { colspan: span } } : {}), content: [paragraph()] })

    expect(doc.content).toEqual([
      {
        type: 'table',
        attrs: { borders: false },
        content: [
          { type: 'tableRow', content: [empty(), cell('b', [100]), cell('c', [100])] },
          { type: 'tableRow', content: [cell('a', [100]), cell('b', [100]), empty()] },
          { type: 'tableRow', content: [cell('only', [100]), empty(2)] }
        ]
      },
      { type: 'table', attrs: { borders: false }, content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colwidth: [200] }, content: [{ type: 'table', content: [{ type: 'tableRow', content: [cell('inner', [100])] }] }] }] }] }
    ])
  })
})

describe('documentFromDocx: pictures, links and fields', () => {
  it('reads pictures in the line and placed beside the text, and leaves out the ones it cannot show', async () => {
    const logo = png(4, 2)
    const dot = png(2, 2)
    const { doc, notes } = await read({
      relationships: [
        ['rIdLogo', 'image', 'media/image1.png'],
        ['rIdOld', 'image', 'media/image2.emf'],
        ['rIdDot', 'image', 'media/image3.png'],
        ['rIdRemote', 'image', 'https://example.com/logo.png', true]
      ],
      files: { 'word/media/image1.png': logo, 'word/media/image2.emf': new Uint8Array([1, 0, 0, 0, 108, 0, 0, 0]), 'word/media/image3.png': dot },
      body: [
        para(run('Logo ') + inlinePicture('rIdLogo', 952500, 476250, 'Company logo')),
        para(floatingPicture('rIdDot', 190500, 190500, 'Dot')),
        para(inlinePicture('rIdOld', 952500, 952500, 'Old drawing')),
        para('<w:r><w:pict><v:shape style="width:75pt;height:37.5pt" alt="Old style"><v:imagedata r:id="rIdLogo" o:title=""/></v:shape></w:pict></w:r>'),
        para(inlinePicture('', 952500, 952500, 'Linked', 'r:link="rIdRemote"'))
      ].join('')
    })
    const image = (bytes: Uint8Array, alt: string, width: number, height: number): DocNode => ({ type: 'image', attrs: { src: dataUrl(bytes, 'image/png'), alt, width, height } })

    expect(doc.content).toEqual([
      { type: 'paragraph', content: [text('Logo '), image(logo, 'Company logo', 100, 50)] },
      { type: 'paragraph', content: [image(dot, 'Dot', 20, 20)] },
      paragraph(),
      { type: 'paragraph', content: [image(logo, 'Old style', 100, 50)] },
      paragraph()
    ])
    expect(notes).toEqual([
      'Pictures placed beside the text are shown in line with it.',
      'Pictures in formats Herald Docs cannot show (EMF, WMF or TIFF) are left out.',
      'Pictures linked from outside the file are left out.'
    ])
  })

  it('reads links through relationships and HYPERLINK fields, and links inside the document as text', async () => {
    const { doc, notes } = await read({
      styles: BASE_STYLES,
      relationships: [['rIdPlan', 'hyperlink', 'https://example.com/plan', true]],
      body: [
        para(`<w:hyperlink r:id="rIdPlan"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>the plan</w:t></w:r></w:hyperlink>`),
        para(run('See ') + field('HYPERLINK "https://example.com/team" \\o "Team"', run('the team', '<w:rStyle w:val="Hyperlink"/>')) + run('.')),
        para(`<w:fldSimple w:instr=" HYPERLINK &quot;mailto:ada@example.com&quot; ">${run('Ada')}</w:fldSimple>`),
        para(`<w:hyperlink w:anchor="_Top">${run('Back to the top')}</w:hyperlink>`)
      ].join('')
    })

    expect(doc.content).toEqual([
      { type: 'paragraph', content: [text('the plan', [link('https://example.com/plan')])] },
      { type: 'paragraph', content: [text('See '), text('the team', [link('https://example.com/team')]), text('.')] },
      { type: 'paragraph', content: [text('Ada', [link('mailto:ada@example.com')])] },
      paragraph('Back to the top')
    ])
    expect(notes).toEqual(['Links to places inside the document are kept as plain text.'])
  })

  it('reads page numbers and dates, simple and complex, as fields with their last result', async () => {
    const { doc, notes } = await read({
      body: [para(run('Page ') + `<w:fldSimple w:instr=" PAGE ">${run('3')}</w:fldSimple>`), para(field('DATE \\@ "d MMMM yyyy"', run('8 October 2026')))].join('')
    })

    expect(doc.content).toEqual([
      { type: 'paragraph', content: [text('Page '), { type: 'field', attrs: { kind: 'page', format: null, instruction: null, text: '3' } }] },
      { type: 'paragraph', content: [{ type: 'field', attrs: { kind: 'date', format: 'd MMMM yyyy', instruction: null, text: '8 October 2026' } }] }
    ])
    expect(notes).toEqual([])
  })
})

describe('documentFromDocx: sections and the page', () => {
  it('takes the page from the first section, with a break holding the next section’s kind and page between sections', async () => {
    const a4 = '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>'
    const { doc, notes } = await read({
      body: [
        para(run('Part one'), `<w:sectPr>${a4}</w:sectPr>`),
        para(run('Part two'), `<w:sectPr><w:type w:val="nextPage"/>${a4}</w:sectPr>`),
        para(run('Part three')),
        '<w:sectPr><w:type w:val="continuous"/><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/><w:pgMar w:top="720" w:right="1080" w:bottom="720" w:left="1080" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
      ].join('')
    })
    const landscape = { width: 792, height: 612, margins: { top: 36, right: 54, bottom: 36, left: 54, header: 35.4, footer: 35.4 } }

    expect(doc.content).toEqual([
      paragraph('Part one'),
      { type: 'sectionBreak', attrs: { kind: 'nextPage', page: null } },
      paragraph('Part two'),
      { type: 'sectionBreak', attrs: { kind: 'continuous', page: landscape } },
      paragraph('Part three')
    ])
    expect(doc.attrs?.page).toEqual({ width: 595.3, height: 841.9, margins: { top: 72, right: 72, bottom: 72, left: 72 } })
    expect(notes).toEqual([])
  })

  it('turns a landscape page written the wrong way round, and gives an empty file one paragraph', async () => {
    const { doc } = await read({ body: '<w:sectPr><w:pgSz w:w="12240" w:h="15840" w:orient="landscape"/></w:sectPr>' })

    expect(doc.content).toEqual([paragraph()])
    expect(doc.attrs?.page).toEqual({ width: 792, height: 612, margins: { top: 72, right: 72, bottom: 72, left: 72 } })
  })
})

describe('documentFromDocx: what it cannot show', () => {
  it('says what it approximates or leaves out, each once and in order', async () => {
    const textBox = `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="2" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="1828800" cy="457200"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="3" name="Text Box 3"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr/><wps:txbx><w:txbxContent>${para(run('Boxed text'))}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape style="width:144pt;height:36pt"><v:textbox><w:txbxContent>${para(run('Boxed text'))}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>`
    const { doc, notes } = await read({
      styles: [BASE_STYLES, paragraphStyle('TOC1', 'toc 1'), paragraphStyle('FootnoteText', 'footnote text'), characterStyle('FootnoteReference', 'footnote reference', '<w:vertAlign w:val="superscript"/>')].join(''),
      comments: '<w:comment w:id="0" w:author="Ada" w:date="2026-10-01T10:00:00Z" w:initials="A"><w:p><w:r><w:t>Check this</w:t></w:r></w:p></w:comment>',
      footnotes: [
        '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>',
        '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>',
        `<w:footnote w:id="1"><w:p><w:pPr>${pStyle('FootnoteText')}</w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>${run(' Source: the plan.')}</w:p></w:footnote>`
      ].join(''),
      relationships: [
        ['rIdHeader', 'header', 'header1.xml'],
        ['rIdMacros', 'http://schemas.microsoft.com/office/2006/relationships/vbaProject', 'vbaProject.bin']
      ],
      files: {
        'word/header1.xml': `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${XMLNS}>${para(run('Quarterly plan'))}</w:hdr>`,
        'word/vbaProject.bin': new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])
      },
      body: [
        para(`<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:hyperlink w:anchor="_Toc1"><w:r><w:t>Goals</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>1</w:t></w:r></w:hyperlink>`, pStyle('TOC1')),
        para('<w:r><w:fldChar w:fldCharType="end"/></w:r>'),
        para(
          `<w:commentRangeStart w:id="0"/>${run('Kept ')}<w:ins w:id="1" w:author="Ada" w:date="2026-10-01T10:00:00Z"><w:r><w:t>inserted</w:t></w:r></w:ins><w:del w:id="2" w:author="Ada" w:date="2026-10-01T10:00:00Z"><w:r><w:delText>deleted</w:delText></w:r></w:del><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>${run(' text')}<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>`
        ),
        para(run('Anchor') + textBox),
        para('<m:oMathPara><m:oMath><m:r><m:t>x=1</m:t></m:r></m:oMath></m:oMathPara>'),
        `<w:sdt><w:sdtPr><w:alias w:val="Name"/></w:sdtPr><w:sdtContent>${para(run('Ada'))}</w:sdtContent></w:sdt>`,
        '<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/><w:cols w:num="2" w:space="720"/></w:sectPr>'
      ].join('')
    })

    expect(doc.content).toEqual([
      { type: 'tableOfContents', attrs: { levels: 3, title: null, pages: [1] } },
      {
        type: 'paragraph',
        content: [text('Kept inserted', [{ type: 'comment', attrs: { id: '0' } }]), text(' text'), { type: 'note', attrs: { kind: 'footnote', content: [paragraph('Source: the plan.')] } }]
      },
      paragraph('Anchor'),
      { type: 'textBox', attrs: { width: 144, height: 36, align: null, border: null, fill: null }, content: [paragraph('Boxed text')] },
      paragraph('x=1'),
      paragraph('Ada')
    ])
    expect(doc.attrs?.headers).toEqual({ header: { default: [paragraph('Quarterly plan')] }, footer: {} })
    expect(doc.attrs?.comments).toEqual([{ id: '0', author: 'Ada', initials: 'A', date: '2026-10-01T10:00:00.000Z', text: 'Check this' }])
    expect(notes).toEqual([
      'Text boxes placed beside the text are shown after the paragraph they are anchored to.',
      'Equations are shown as plain text.',
      'Tracked changes are shown accepted, and saving keeps them accepted.',
      'Content controls (form fields, checkboxes) are shown as their text.',
      'Text in columns is shown in one column, and saving keeps it in one column.',
      'Macros are not kept: Herald Docs saves Word documents without them.'
    ])
  })

  it('shows the picture Word keeps of a chart, or leaves the chart out when there is none', async () => {
    const chart = '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdChart"/></a:graphicData></a:graphic>'
    const frame = (inner: string) => `<w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="4" name="Chart 4"/>${inner}</wp:inline></w:drawing>`
    const picture = png(3, 3)
    const { doc, notes } = await read({
      relationships: [['rIdFallback', 'image', 'media/chart.png']],
      files: { 'word/media/chart.png': picture },
      body: [
        para(`<w:r><mc:AlternateContent><mc:Choice Requires="cx1">${frame(chart)}</mc:Choice><mc:Fallback>${frame(graphic('rIdFallback', 952500, 952500))}</mc:Fallback></mc:AlternateContent></w:r>`),
        para(`<w:r>${frame(chart)}</w:r>`)
      ].join('')
    })

    expect(doc.content).toEqual([{ type: 'paragraph', content: [{ type: 'image', attrs: { src: dataUrl(picture, 'image/png'), width: 100, height: 100 } }] }, paragraph()])
    expect(notes).toEqual(['Charts and SmartArt are shown as pictures, or left out when the file has no picture of them.'])
  })

  it('reads a table of contents in a building block as one, not as a form control', async () => {
    const toc = `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent>${para(field('TOC \\o "1-3" \\h', run('Goals')))}</w:sdtContent></w:sdt>`
    const { doc, notes } = await read({ body: toc + para(run('After')) })

    expect(doc.content).toEqual([{ type: 'tableOfContents', attrs: { levels: 3, title: null, pages: null } }, paragraph('After')])
    expect(notes).toEqual([])
  })

  it('accepts tracked changes: deleted paragraphs and rows go, inserted text stays', async () => {
    const change = 'w:author="Ada" w:date="2026-10-01T10:00:00Z"'
    const { doc, notes } = await read({
      body: [
        para(run('Kept')),
        para(`<w:del w:id="1" ${change}><w:r><w:delText>A deleted paragraph</w:delText></w:r></w:del>`, `<w:rPr><w:del w:id="2" ${change}/></w:rPr>`),
        `<w:tbl><w:tblGrid><w:gridCol w:w="1500"/></w:tblGrid><w:tr><w:tc>${para(run('Row'))}</w:tc></w:tr><w:tr><w:trPr><w:del w:id="3" ${change}/></w:trPr><w:tc>${para(run('Gone'))}</w:tc></w:tr></w:tbl>`,
        para(`<w:moveTo w:id="4" ${change}>${run('Moved here')}</w:moveTo><w:moveFrom w:id="5" ${change}>${run('Moved away')}</w:moveFrom>`)
      ].join('')
    })

    expect(doc.content).toEqual([paragraph('Kept'), { type: 'table', attrs: { borders: false }, content: [{ type: 'tableRow', content: [cell('Row', [100])] }] }, paragraph('Moved here')])
    expect(notes).toEqual(['Tracked changes are shown accepted, and saving keeps them accepted.'])
  })

  it('reads Strict Open XML files, whose namespaces and relationship types differ', async () => {
    const strict = 'http://purl.oclc.org/ooxml'
    const zip = new JSZip()
    zip.file('_rels/.rels', `<Relationships xmlns="${RELATIONSHIPS}"><Relationship Id="rId1" Type="${strict}/officeDocument/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
    zip.file('word/_rels/document.xml.rels', `<Relationships xmlns="${RELATIONSHIPS}"><Relationship Id="rId2" Type="${strict}/officeDocument/relationships/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>`)
    zip.file(
      'word/document.xml',
      `<w:document xmlns:w="${strict}/wordprocessingml/main" xmlns:r="${strict}/officeDocument/relationships"><w:body><w:p><w:hyperlink r:id="rId2"><w:r><w:t>Strict link</w:t></w:r></w:hyperlink></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`
    )
    const { doc } = await read(await zip.generateAsync({ type: 'uint8array' }))

    expect(doc.content).toEqual([{ type: 'paragraph', content: [text('Strict link', [link('https://example.com')])] }])
    expect(doc.attrs?.page).toMatchObject({ width: 595.3, height: 841.9 })
  })

  it('reads elements whatever prefix the file gives their namespace', async () => {
    const zip = await JSZip.loadAsync(await wordFile({ body: '' }))
    zip.file('word/document.xml', `<ns0:document xmlns:ns0="${NAMESPACES.w}"><ns0:body><ns0:p><ns0:r><ns0:t>Odd prefixes</ns0:t></ns0:r></ns0:p></ns0:body></ns0:document>`)
    const { doc } = await read(await zip.generateAsync({ type: 'uint8array' }))

    expect(doc.content).toEqual([paragraph('Odd prefixes')])
  })

  it('throws for files that are not Word documents', async () => {
    const spreadsheet = new JSZip()
    spreadsheet.file('_rels/.rels', `<Relationships xmlns="${RELATIONSHIPS}"><Relationship Id="rId1" Type="${RELATIONSHIP_TYPE}/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
    spreadsheet.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>')
    const emptyZip = new JSZip()
    emptyZip.file('notes.txt', 'Quarterly plan')

    await expect(documentFromDocx(new TextEncoder().encode('Quarterly plan'))).rejects.toThrow('This is not a Word document')
    await expect(documentFromDocx(await emptyZip.generateAsync({ type: 'uint8array' }))).rejects.toThrow('This is not a Word document')
    await expect(documentFromDocx(await spreadsheet.generateAsync({ type: 'uint8array' }))).rejects.toThrow('This is not a Word document')
  })
})

describe('documentFromDocx: files made with the docx package', () => {
  it('reads styles, formatting, lists, tables, pictures, links, page breaks and the page', async () => {
    const picture = png(4, 2)
    const file = new Document({
      styles: { paragraphStyles: [{ id: 'Aside', name: 'Aside', basedOn: 'Normal', run: { italics: true, color: '7030A0' }, paragraph: { spacing: { before: 120 } } }] },
      numbering: {
        config: [
          {
            reference: 'steps',
            levels: [
              { level: 0, format: LevelFormat.DECIMAL, text: '%1.', start: 4, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
              { level: 1, format: LevelFormat.LOWER_LETTER, text: '%2)', start: 1, style: { paragraph: { indent: { left: 1440, hanging: 360 } } } }
            ]
          }
        ]
      },
      sections: [
        {
          properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } } },
          children: [
            new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun('Quarterly plan')] }),
            new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Goals')] }),
            new Paragraph({ children: [new TextRun({ text: 'Bold', bold: true }), new TextRun(' and '), new TextRun({ text: 'italic', italics: true }), new TextRun({ text: ' red', color: 'FF0000', size: 28 })] }),
            new Paragraph({ style: 'Aside', children: [new TextRun('An aside')] }),
            new Paragraph({ numbering: { reference: 'steps', level: 0 }, children: [new TextRun('Fourth step')] }),
            new Paragraph({ numbering: { reference: 'steps', level: 1 }, children: [new TextRun('Detail')] }),
            new Paragraph({ numbering: { reference: 'steps', level: 0 }, children: [new TextRun('Fifth step')] }),
            new Paragraph({ bullet: { level: 0 }, children: [new TextRun('A point')] }),
            new Table({
              columnWidths: [3000, 4500],
              rows: [
                new TableRow({ tableHeader: true, children: [new TableCell({ columnSpan: 2, children: [new Paragraph('Team')] })] }),
                new TableRow({ children: [new TableCell({ rowSpan: 2, children: [new Paragraph('Ada')] }), new TableCell({ children: [new Paragraph('Lead')] })] }),
                new TableRow({ children: [new TableCell({ children: [new Paragraph('Design')] })] })
              ]
            }),
            new Paragraph({ children: [new ImageRun({ type: 'png', data: picture, transformation: { width: 40, height: 20 }, altText: { name: 'Chart', description: 'Growth' } })] }),
            new Paragraph({ children: [new ExternalHyperlink({ link: 'https://example.com/plan', children: [new TextRun({ text: 'the plan', style: 'Hyperlink' })] })] }),
            new Paragraph({ children: [new PageBreak()] }),
            new Paragraph('The end')
          ]
        }
      ]
    })
    const { doc, notes } = await read(await Packer.pack(file, 'uint8array'))

    expect(doc.content).toEqual([
      paragraph('Quarterly plan', { docStyle: 'title' }),
      { type: 'heading', attrs: { level: 1 }, content: [text('Goals')] },
      { type: 'paragraph', content: [text('Bold', [bold]), text(' and '), text('italic', [italic]), text(' red', [textStyle({ color: '#ff0000', fontSize: '14pt' })])] },
      { type: 'paragraph', attrs: { spaceBefore: 6 }, content: [text('An aside', [textStyle({ color: '#7030a0' }), italic])] },
      { type: 'orderedList', attrs: { start: 4 }, content: [{ type: 'listItem', content: [paragraph('Fourth step'), { type: 'orderedList', attrs: { type: 'a' }, content: [item('Detail')] }] }, item('Fifth step')] },
      { type: 'bulletList', content: [item('A point')] },
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 2, colwidth: [200, 300] }, content: [paragraph('Team')] }] },
          { type: 'tableRow', content: [cell('Ada', [200], { rowspan: 2 }), cell('Lead', [300])] },
          { type: 'tableRow', content: [cell('Design', [300])] }
        ]
      },
      { type: 'paragraph', content: [{ type: 'image', attrs: { src: dataUrl(picture, 'image/png'), alt: 'Growth', width: 40, height: 20 } }] },
      { type: 'paragraph', content: [text('the plan', [link('https://example.com/plan')])] },
      { type: 'pageBreak' },
      paragraph('The end')
    ])
    expect(doc.attrs?.page).toEqual({ width: 595.3, height: 841.9, margins: { top: 56.7, right: 56.7, bottom: 56.7, left: 56.7, header: 35.4, footer: 35.4 } })
    expect(notes).toEqual(['Styles Herald Docs does not have (Aside) are kept as the formatting they give the text.'])
  })
})
