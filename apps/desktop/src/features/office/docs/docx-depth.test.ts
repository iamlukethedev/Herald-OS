import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { dataUrl, type DocJSON, type DocMark, type DocNode, type PageSettings } from '../../../../shared/office/document.ts'
import { png } from '../../../../shared/office/docx/fixtures.ts'
import { documentFromDocx } from '../../../../shared/office/docx/read.ts'
import { docxFromDocument } from '../../../../shared/office/docx/write.ts'
import { attr, children, findAll, parseXml, wellFormed } from '../../../../shared/office/docx/xml.ts'
import { docsSchema } from './schema.ts'

// Headers and footers, fields, tables of contents, comments, notes, sections, text boxes and kept parts, in Word files made here.

const NAMESPACES: Record<string, string> = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  wpg: 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
  v: 'urn:schemas-microsoft-com:vml',
  o: 'urn:schemas-microsoft-com:office:office',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  w15: 'http://schemas.microsoft.com/office/word/2012/wordml'
}

const XMLNS = Object.entries(NAMESPACES)
  .map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`)
  .join(' ')

const PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

type Relationship = [id: string, type: string, target: string]

interface Part {
  /** Its path under word/. */
  name: string
  id: string
  /** The end of its relationship type ("header") or the whole type. */
  type: string
  content: string
  relationships?: Relationship[]
}

interface Fixture {
  body: string
  styles?: string
  settings?: string
  parts?: Part[]
  /** Other files, by their path in the zip. */
  files?: Record<string, string | Uint8Array>
  /** Relationships of the package itself, besides the main document's. */
  packageRelationships?: Relationship[]
  /** Content types by part name. */
  overrides?: Record<string, string>
}

const xmlPart = (root: string, inner: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${root} ${XMLNS}>${inner}</${root}>`

const relationshipsXml = (items: readonly Relationship[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PACKAGE}">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type.includes('/') ? type : `${OFFICE}/${type}`}" Target="${target}"/>`).join('')}</Relationships>`

async function word({ body, styles, settings, parts = [], files = {}, packageRelationships = [], overrides = {} }: Fixture): Promise<Uint8Array> {
  const zip = new JSZip()
  const all = [...parts, ...(styles ? [{ name: 'styles.xml', id: 'rIdStyles', type: 'styles', content: xmlPart('w:styles', styles) }] : []), ...(settings ? [{ name: 'settings.xml', id: 'rIdSettings', type: 'settings', content: xmlPart('w:settings', settings) }] : [])]

  for (const part of all) {
    zip.file(`word/${part.name}`, part.content)

    if (part.relationships) {
      zip.file(`word/_rels/${part.name}.rels`, relationshipsXml(part.relationships))
    }
  }

  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content)
  }

  const types = Object.entries(overrides)
    .map(([name, type]) => `<Override PartName="/${name}" ContentType="${type}"/>`)
    .join('')
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${types}</Types>`
  )
  zip.file('_rels/.rels', relationshipsXml([['rId1', 'officeDocument', 'word/document.xml'], ...packageRelationships]))
  zip.file('word/document.xml', xmlPart('w:document', `<w:body>${body}</w:body>`))
  zip.file('word/_rels/document.xml.rels', relationshipsXml(all.map((part) => [part.id, part.type, part.name])))

  return zip.generateAsync({ type: 'uint8array' })
}

const schema = docsSchema()

/** Checks a document, its headers' and notes' blocks too, against Herald Docs' schema. */
function check(doc: DocJSON): void {
  schema.nodeFromJSON(doc).check()
  const headers = doc.attrs?.headers

  for (const blocks of [...Object.values(headers?.header ?? {}), ...Object.values(headers?.footer ?? {})]) {
    schema.nodeFromJSON({ type: 'doc', content: blocks }).check()
  }

  for (const note of findNodes(doc, 'note')) {
    schema.nodeFromJSON({ type: 'doc', content: note.attrs?.content as DocNode[] }).check()
  }
}

function findNodes(node: DocNode, type: string, out: DocNode[] = []): DocNode[] {
  if (node.type === type) {
    out.push(node)
  }

  for (const item of node.content ?? []) {
    findNodes(item, type, out)
  }

  return out
}

async function read(bytes: Uint8Array) {
  const result = await documentFromDocx(bytes)
  check(result.doc)

  return result
}

/** Writes a document and opens the file again. */
async function roundTrip(doc: DocJSON) {
  check(doc)
  const { bytes, losses } = await docxFromDocument(doc)
  const { doc: back, notes } = await read(bytes)

  return { bytes, losses, doc: back, notes }
}

/** A document as the editor keeps it: Herald's schema puts marks in order and fills in attrs. */
const normalized = (doc: DocJSON) => schema.nodeFromJSON(doc).toJSON()

async function partsOf(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes)
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir)
  const read = async (name: string): Promise<string> => (await zip.file(name)?.async('string')) ?? ''

  return { names, read, xml: async (name: string) => parseXml(await read(name)) }
}

const run = (value: string, rPr = ''): string => `<w:r>${rPr && `<w:rPr>${rPr}</w:rPr>`}<w:t xml:space="preserve">${value}</w:t></w:r>`
const para = (content: string, pPr = ''): string => `<w:p>${pPr && `<w:pPr>${pPr}</w:pPr>`}${content}</w:p>`
const pStyle = (id: string): string => `<w:pStyle w:val="${id}"/>`
const field = (instruction: string, result: string): string =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instruction} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${result}<w:r><w:fldChar w:fldCharType="end"/></w:r>`
const paragraphStyle = (id: string, name: string, inner = ''): string => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>${inner}</w:style>`
const characterStyle = (id: string, name: string, rPr = ''): string => `<w:style w:type="character" w:styleId="${id}"><w:name w:val="${name}"/><w:rPr>${rPr}</w:rPr></w:style>`

const BASE_STYLES = [
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>',
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
  paragraphStyle('Heading1', 'heading 1', '<w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr>'),
  paragraphStyle('Heading2', 'heading 2', '<w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr>')
].join('')

const graphic = (id: string, cx: number, cy: number): string =>
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`

const inlinePicture = (id: string, cx: number, cy: number, descr: string): string =>
  `<w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="Picture 1" descr="${descr}"/>${graphic(id, cx, cy)}</wp:inline></w:drawing></w:r>`

const text = (value: string, marks?: DocMark[]): DocNode => (marks?.length ? { type: 'text', text: value, marks } : { type: 'text', text: value })
const paragraph = (...content: (DocNode | string)[]): DocNode => {
  const nodes = content.map((item) => (typeof item === 'string' ? text(item) : item))

  return nodes.length ? { type: 'paragraph', content: nodes } : { type: 'paragraph' }
}
const heading = (level: number, value: string): DocNode => ({ type: 'heading', attrs: { level }, content: [text(value)] })
const bold: DocMark = { type: 'bold' }
const comment = (id: string): DocMark => ({ type: 'comment', attrs: { id } })
const fieldNode = (kind: string, value: string | null, extra: { format?: string | null; instruction?: string | null } = {}, marks?: DocMark[]): DocNode => ({
  type: 'field',
  attrs: { kind, format: extra.format ?? null, instruction: extra.instruction ?? null, text: value },
  ...(marks ? { marks } : {})
})
const noteNode = (kind: 'footnote' | 'endnote', ...content: DocNode[]): DocNode => ({ type: 'note', attrs: { kind, content } })

const LETTER: PageSettings = { width: 612, height: 792, margins: { top: 72, right: 72, bottom: 72, left: 72 } }

describe('Word files: headers and footers', () => {
  it('reads the first section’s headers and footers of each kind, with their fields and pictures', async () => {
    const logo = png(4, 2)
    const bytes = await word({
      settings: '<w:evenAndOddHeaders/>',
      parts: [
        { name: 'header1.xml', id: 'rIdH1', type: 'header', content: xmlPart('w:hdr', para(run('Odd pages ') + inlinePicture('rIdLogo', 952500, 476250, 'Logo'))), relationships: [['rIdLogo', 'image', 'media/logo.png']] },
        { name: 'header2.xml', id: 'rIdH2', type: 'header', content: xmlPart('w:hdr', para(run('Title page'))) },
        { name: 'header3.xml', id: 'rIdH3', type: 'header', content: xmlPart('w:hdr', para(run('Even pages'))) },
        { name: 'footer1.xml', id: 'rIdF1', type: 'footer', content: xmlPart('w:ftr', para(run('Page ') + field('PAGE', run('2')) + run(' of ') + field('NUMPAGES', run('9')))) },
        { name: 'footer2.xml', id: 'rIdF2', type: 'footer', content: xmlPart('w:ftr', para('')) }
      ],
      files: { 'word/media/logo.png': logo },
      body:
        para(run('Body')) +
        '<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/><w:headerReference w:type="first" r:id="rIdH2"/><w:headerReference w:type="even" r:id="rIdH3"/><w:footerReference w:type="default" r:id="rIdF1"/><w:footerReference w:type="first" r:id="rIdF2"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="567" w:footer="720"/><w:titlePg/></w:sectPr>'
    })
    const { doc, notes } = await read(bytes)

    expect(doc.attrs?.headers).toEqual({
      header: {
        default: [paragraph('Odd pages ', { type: 'image', attrs: { src: dataUrl(logo, 'image/png'), alt: 'Logo', width: 100, height: 50 } })],
        first: [paragraph('Title page')],
        even: [paragraph('Even pages')]
      },
      footer: { default: [paragraph('Page ', fieldNode('page', '2'), ' of ', fieldNode('pages', '9'))] },
      differentFirst: true,
      differentOddEven: true
    })
    expect(doc.attrs?.page).toEqual({ ...LETTER, margins: { ...LETTER.margins, header: 28.35 } })
    expect(notes).toEqual([])
  })

  it('keeps the first section’s headers when a later section has its own, and says what it numbers its own way', async () => {
    const { doc, notes } = await read(
      await word({
        parts: [
          { name: 'header1.xml', id: 'rIdH1', type: 'header', content: xmlPart('w:hdr', para(run('Front matter'))) },
          { name: 'header2.xml', id: 'rIdH2', type: 'header', content: xmlPart('w:hdr', para(run('Chapter one'))) }
        ],
        body: [
          para(run('Preface'), '<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/><w:pgNumType w:fmt="lowerRoman"/></w:sectPr>'),
          para(run('Chapter')),
          '<w:sectPr><w:headerReference w:type="default" r:id="rIdH2"/><w:pgNumType w:start="1"/></w:sectPr>'
        ].join('')
      })
    )

    expect(doc.attrs?.headers).toEqual({ header: { default: [paragraph('Front matter')] }, footer: {} })
    expect(notes).toEqual([
      'Page numbers in letters or Roman numerals, or starting again in a section, are shown as plain numbers counting from the first page.',
      "Headers and footers of later sections are not shown; the first section's are used on every page."
    ])
  })

  it('writes headers and footers of each kind with their flags, fields, pictures and distances, and reads them back', async () => {
    const logo = png(6, 3)
    const doc: DocJSON = {
      type: 'doc',
      attrs: {
        page: { ...LETTER, margins: { ...LETTER.margins, header: 24, footer: 30 } },
        styles: null,
        headers: {
          header: {
            default: [paragraph({ type: 'image', attrs: { src: dataUrl(logo, 'image/png'), alt: 'Logo', width: 60, height: 30 } }, '\tQuarterly report')],
            first: [paragraph('Cover')],
            even: [paragraph('Quarterly report\t', fieldNode('page', null))]
          },
          footer: { default: [{ type: 'paragraph', attrs: { textAlign: 'center' }, content: [text('Page '), fieldNode('page', '1'), text(' of '), fieldNode('pages', '4', { instruction: 'SECTIONPAGES' })] }] },
          differentFirst: true,
          differentOddEven: true
        }
      },
      content: [paragraph('Body')]
    }
    const { bytes, doc: back, losses, notes } = await roundTrip(doc)
    const { names, read: readPart } = await partsOf(bytes)
    const document = await readPart('word/document.xml')
    const headers = await Promise.all(names.filter((name) => /^word\/header\d\.xml$/.test(name)).map(readPart))

    expect(back.attrs?.headers).toEqual(doc.attrs?.headers)
    expect(back.attrs?.page).toEqual(doc.attrs?.page)
    expect(document).toContain('<w:titlePg/>')
    expect(document).toContain('w:header="480" w:footer="600"')
    expect(findAll(parseXml(document), 'w:headerReference').map((element) => attr(element, 'w:type'))).toEqual(['default', 'first', 'even'])
    expect(await readPart('word/settings.xml')).toContain('<w:evenAndOddHeaders/>')
    expect(headers.filter((xml) => xml.includes('Quarterly report'))).toHaveLength(2)
    expect(names.some((name) => /^word\/_rels\/header\d\.xml\.rels$/.test(name))).toBe(true)
    expect(names.some((name) => name.startsWith('word/media/'))).toBe(true)
    expect(await readPart('word/footer1.xml')).toContain('SECTIONPAGES')
    expect(losses).toEqual([])
    expect(notes).toEqual([])
  })

  it('writes an empty first-page header when the first page has its own but no header was given', async () => {
    const { bytes, doc } = await roundTrip({ type: 'doc', attrs: { page: LETTER, styles: null, headers: { header: { default: [paragraph('Every page')] }, footer: {}, differentFirst: true } }, content: [paragraph('Body')] })
    const document = await (await partsOf(bytes)).read('word/document.xml')

    expect(findAll(parseXml(document), 'w:headerReference').map((element) => attr(element, 'w:type'))).toEqual(['default', 'first'])
    expect(doc.attrs?.headers).toEqual({ header: { default: [paragraph('Every page')] }, footer: {}, differentFirst: true })
  })
})

describe('Word files: fields', () => {
  it('keeps other fields with their instruction and last result, and says which ones it cannot keep or update', async () => {
    const { doc, notes } = await read(
      await word({
        body: [
          para(run('See ') + field('REF _Ref1 \\h', run('Figure 1')) + run(' and ') + `<w:fldSimple w:instr=" DOCPROPERTY Client ">${run('Example Ltd')}</w:fldSimple>`),
          para(field('SEQ Figure \\* ARABIC', run('2', '<w:b/>'))),
          para(run('Pages ') + field('SECTIONPAGES', run('4')) + run(', page ') + field('PAGE \\* roman', run('iv'))),
          para(field('TIME', '')),
          para(run('Before ') + '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> QUOTE "x" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' + run('one')),
          para(run('two') + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'),
          para('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> IF </w:instrText></w:r>' + field('MERGEFIELD Name', run('Ann')) + '<w:r><w:instrText> = "Ann" "Hi" "Hello" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' + run('Hi') + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'),
          para(field('FORMTEXT', run('Ann Example'))),
          para(run('Term') + '<w:r><w:rPr><w:vanish/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:instrText> XE "Term" </w:instrText></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:fldChar w:fldCharType="end"/></w:r>')
        ].join('')
      })
    )

    expect(doc.content).toEqual([
      paragraph('See ', fieldNode('other', 'Figure 1', { instruction: 'REF _Ref1 \\h' }), ' and ', fieldNode('other', 'Example Ltd', { instruction: 'DOCPROPERTY Client' })),
      paragraph(fieldNode('other', '2', { instruction: 'SEQ Figure \\* ARABIC' }, [bold])),
      paragraph('Pages ', fieldNode('pages', '4', { instruction: 'SECTIONPAGES' }), ', page ', fieldNode('page', 'iv', { instruction: 'PAGE \\* roman' })),
      paragraph(fieldNode('time', null)),
      paragraph('Before one'),
      paragraph('two'),
      paragraph('Hi'),
      paragraph('Ann Example'),
      paragraph('Term')
    ])
    expect(notes).toEqual([
      'Hidden text is left out.',
      'Fields whose result runs over several paragraphs or holds pictures are shown as their last result and no longer update.',
      'Cross-references keep their last result, but Word cannot update them, as the places they refer to are not kept.',
      'Page numbers in letters or Roman numerals, or starting again in a section, are shown as plain numbers counting from the first page.',
      'Content controls (form fields, checkboxes) are shown as their text.'
    ])
  })

  it('writes fields back as complex fields with their last result, so Word can update them', async () => {
    const doc: DocJSON = {
      type: 'doc',
      attrs: { page: LETTER, styles: null },
      content: [
        paragraph('See ', fieldNode('other', 'Figure 1', { instruction: 'REF _Ref1 \\h' }), ' and ', fieldNode('other', 'Example Ltd', { instruction: 'DOCPROPERTY Client' }, [bold])),
        paragraph(fieldNode('date', null, { format: 'd MMMM yyyy' }), ' at ', fieldNode('time', null, { format: 'HH:mm' })),
        paragraph('Page ', fieldNode('page', '3', { instruction: 'PAGE \\* roman' }), ' of ', fieldNode('pages', null))
      ]
    }
    const { bytes, doc: back } = await roundTrip(doc)
    const document = await (await partsOf(bytes)).read('word/document.xml')
    const instructions = findAll(parseXml(document), 'w:instrText').map((element) => element.children.join('').trim())
    const [date, , time] = back.content[1].content ?? []

    expect(instructions).toEqual(['REF _Ref1 \\h', 'DOCPROPERTY Client', 'DATE \\@ "d MMMM yyyy"', 'TIME \\@ "HH:mm"', 'PAGE \\* roman', 'NUMPAGES'])
    expect(back.content[0]).toEqual(doc.content[0])
    expect(date).toMatchObject({ type: 'field', attrs: { kind: 'date', format: 'd MMMM yyyy', instruction: null } })
    expect(String(date.attrs?.text)).toMatch(/^\d{1,2} \w+ \d{4}$/)
    expect(time).toMatchObject({ type: 'field', attrs: { kind: 'time', format: 'HH:mm', instruction: null } })
    expect(back.content[2]).toEqual(doc.content[2])
  })

  it('writes text that reads like one of the docx package’s field names as text', async () => {
    const { doc } = await roundTrip({ type: 'doc', content: [paragraph('SECTION'), paragraph('CURRENT'), paragraph('TOTAL_PAGES')] })

    expect(doc.content).toEqual([paragraph('SECTION'), paragraph('CURRENT'), paragraph('TOTAL_PAGES')])
  })
})

const TOC_STYLES = [
  BASE_STYLES,
  paragraphStyle('TOCHeading', 'TOC Heading', '<w:pPr><w:outlineLvl w:val="9"/></w:pPr>'),
  paragraphStyle('TOC1', 'toc 1'),
  paragraphStyle('TOC2', 'toc 2', '<w:pPr><w:ind w:left="220"/></w:pPr>'),
  paragraphStyle('TableofFigures', 'table of figures')
].join('')

const tocEntry = (anchor: string, title: string, page: string, style: string, start = ''): string =>
  para(`${start}<w:hyperlink w:anchor="${anchor}" w:history="1">${run(title)}<w:r><w:tab/></w:r>${field(`PAGEREF ${anchor} \\h`, run(page))}</w:hyperlink>`, pStyle(style))

const tocBegin = (instruction: string): string => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instruction} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>`

const tocEnd = para('<w:r><w:fldChar w:fldCharType="end"/></w:r>')

const building = (inner: string): string => `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent>${inner}</w:sdtContent></w:sdt>`

describe('Word files: tables of contents', () => {
  it('reads Word’s table of contents as one: its levels, its title and the page of each entry, not its entries’ text', async () => {
    const { doc, notes } = await read(
      await word({
        styles: TOC_STYLES,
        body: [
          building(
            para(run('Contents'), pStyle('TOCHeading')) + tocEntry('_Toc1', 'Goals', '1', 'TOC1', tocBegin('TOC \\o "1-2" \\h \\z \\u')) + tocEntry('_Toc2', 'Scope', '3', 'TOC2') + tocEnd
          ),
          para(`<w:bookmarkStart w:id="1" w:name="_Toc1"/>${run('Goals')}<w:bookmarkEnd w:id="1"/>`, pStyle('Heading1')),
          para(`<w:bookmarkStart w:id="2" w:name="_Toc2"/>${run('Scope')}<w:bookmarkEnd w:id="2"/>`, pStyle('Heading2'))
        ].join('')
      })
    )

    expect(doc.content).toEqual([{ type: 'tableOfContents', attrs: { levels: 2, title: 'Contents', pages: [1, 3] } }, heading(1, 'Goals'), heading(2, 'Scope')])
    expect(notes).toEqual([])
  })

  it('keeps a table of figures as its text, and says which options of a table of contents it does not keep', async () => {
    const { doc, notes } = await read(
      await word({
        styles: TOC_STYLES,
        body: [
          para(tocBegin('TOC \\h \\z \\c "Figure"') + run('Figure 1: Growth') + '<w:r><w:tab/></w:r>' + run('2'), pStyle('TableofFigures')),
          tocEnd,
          para(tocBegin('TOC \\o "1-3" \\h \\t "Title,1"') + run('Goals') + '<w:r><w:tab/></w:r>' + run('1'), pStyle('TOC1')),
          tocEnd
        ].join('')
      })
    )

    expect(doc.content).toEqual([paragraph('Figure 1: Growth\t2'), paragraph(), { type: 'tableOfContents', attrs: { levels: 3, title: null, pages: [1] } }])
    expect(notes).toEqual([
      'Styles Herald Docs does not have (Table of figures) are kept as the formatting they give the text.',
      'Fields whose result runs over several paragraphs or holds pictures are shown as their last result and no longer update.',
      "Tables of contents list the document's headings by level; their other options (such as other styles) are not kept."
    ])
  })

  it('writes a table of contents with its title, entries linked to bookmarks on the headings and the page numbers it was given', async () => {
    const doc: DocJSON = {
      type: 'doc',
      attrs: { page: LETTER, styles: null },
      content: [
        { type: 'tableOfContents', attrs: { levels: 2, title: 'Contents', pages: [1, 2, 2] } },
        heading(1, 'Goals'),
        heading(3, 'Detail'),
        heading(2, 'Scope'),
        heading(2, 'Budget')
      ]
    }
    const { bytes, doc: back } = await roundTrip(doc)
    const document = await (await partsOf(bytes)).read('word/document.xml')
    const root = parseXml(document)
    const bookmarks = findAll(root, 'w:bookmarkStart').map((element) => attr(element, 'w:name'))
    const anchors = findAll(root, 'w:hyperlink').map((element) => attr(element, 'w:anchor'))
    const instructions = findAll(root, 'w:instrText').map((element) => element.children.join('').trim())

    expect(back.content).toEqual(doc.content)
    expect(bookmarks).toHaveLength(3)
    expect(anchors).toEqual(bookmarks)
    expect(instructions).toEqual(['TOC \\o "1-2" \\h \\z \\u', ...bookmarks.map((name) => `PAGEREF ${name} \\h`)])
    expect(document).toContain('<w:docPartGallery w:val="Table of Contents"/>')
    expect(document).toContain('<w:pStyle w:val="TOCHeading"/>')
    expect(document).not.toContain('w:dirty')
    expect(findAll(root, 'w:pStyle').map((element) => attr(element, 'w:val'))).toEqual(['TOCHeading', 'TOC1', 'TOC2', 'TOC2', 'Heading1', 'Heading3', 'Heading2', 'Heading2'])
  })

  it('leaves the page numbers for Word to fill in when the headings changed since they were worked out', async () => {
    const { bytes, doc } = await roundTrip({ type: 'doc', content: [{ type: 'tableOfContents', attrs: { levels: 3, title: null, pages: [1] } }, heading(1, 'One'), heading(1, 'Two')] })
    const document = await (await partsOf(bytes)).read('word/document.xml')

    expect(document).toContain('<w:fldChar w:fldCharType="begin" w:dirty="true"/>')
    expect(document).not.toContain('PAGEREF')
    expect(doc.content[0]).toEqual({ type: 'tableOfContents', attrs: { levels: 3, title: null, pages: null } })
  })

  it('writes the TOC styles Word shows entries in: indented by level, with the page number at the end of the text', async () => {
    const { bytes } = await docxFromDocument({ type: 'doc', attrs: { page: LETTER, styles: null }, content: [{ type: 'tableOfContents', attrs: { levels: 3, title: null, pages: null } }, heading(1, 'One')] })
    const styles = children(parseXml(await (await partsOf(bytes)).read('word/styles.xml')), 'w:style')
    const style = (id: string) => styles.find((element) => attr(element, 'w:styleId') === id)
    const pPr = (id: string) => children(style(id), 'w:pPr')[0]
    const tab = (id: string) => findAll(pPr(id), 'w:tab')[0]

    expect(attr(children(style('TOC1'), 'w:name')[0], 'w:val')).toBe('toc 1')
    expect(attr(tab('TOC1'), 'w:pos')).toBe('9360')
    expect(attr(findAll(pPr('TOC2'), 'w:ind')[0], 'w:left')).toBe('220')
    expect(attr(findAll(pPr('TOCHeading'), 'w:outlineLvl')[0], 'w:val')).toBe('9')
  })
})

const COMMENTS = [
  '<w:comment w:id="0" w:author="Ann Example" w:initials="AE" w:date="2026-10-01T09:00:00Z"><w:p w14:paraId="0A000001"><w:r><w:annotationRef/></w:r><w:r><w:t>Check the figures</w:t></w:r></w:p><w:p w14:paraId="0A000002"><w:r><w:t>and the dates</w:t></w:r></w:p></w:comment>',
  '<w:comment w:id="1" w:author="Bo Example" w:date="2026-10-01T10:00:00Z"><w:p w14:paraId="0A000003"><w:r><w:t>Done</w:t></w:r></w:p></w:comment>',
  '<w:comment w:id="2" w:author="Bo Example" w:date="2026-10-02T09:00:00"><w:p w14:paraId="0A000004"><w:r><w:t>Overlaps</w:t></w:r></w:p></w:comment>',
  '<w:comment w:id="3" w:author="Ann Example" w:date="2026-10-03T09:00:00Z"><w:p w14:paraId="0A000005"><w:r><w:t>One word</w:t></w:r></w:p></w:comment>',
  '<w:comment w:id="4" w:author="Ann Example" w:date="2026-10-03T10:00:00Z"><w:p w14:paraId="0A000006"><w:r><w:t>At the start</w:t></w:r></w:p></w:comment>'
].join('')

const COMMENTS_EXTENDED = [
  '<w15:commentEx w15:paraId="0A000002" w15:done="1"/>',
  '<w15:commentEx w15:paraId="0A000003" w15:paraIdParent="0A000002" w15:done="1"/>',
  '<w15:commentEx w15:paraId="0A000004" w15:done="0"/>'
].join('')

const reference = (id: number): string => `<w:r><w:commentReference w:id="${id}"/></w:r>`

const commentsFile = (): Promise<Uint8Array> =>
  word({
    parts: [
      { name: 'comments.xml', id: 'rIdComments', type: 'comments', content: xmlPart('w:comments', COMMENTS) },
      { name: 'commentsExtended.xml', id: 'rIdExtended', type: 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended', content: xmlPart('w15:commentsEx', COMMENTS_EXTENDED) }
    ],
    body: [
      para('<w:commentRangeStart w:id="0"/><w:commentRangeStart w:id="1"/>' + run('Revenue rose ') + '<w:commentRangeStart w:id="2"/>' + run('by a third')),
      para(run('in May') + '<w:commentRangeEnd w:id="0"/><w:commentRangeEnd w:id="1"/>' + reference(0) + reference(1) + run(' and June') + '<w:commentRangeEnd w:id="2"/>' + reference(2) + run(' overall.')),
      para(run('Costs fell sharply. ') + reference(3)),
      para(reference(4) + run('Next steps follow.'))
    ].join('')
  })

const THREADS = [
  {
    id: '0',
    author: 'Ann Example',
    initials: 'AE',
    date: '2026-10-01T09:00:00.000Z',
    text: 'Check the figures\nand the dates',
    resolved: true,
    replies: [{ id: '1', author: 'Bo Example', date: '2026-10-01T10:00:00.000Z', text: 'Done' }]
  },
  { id: '2', author: 'Bo Example', date: '2026-10-02T09:00:00.000Z', text: 'Overlaps' },
  { id: '3', author: 'Ann Example', date: '2026-10-03T09:00:00.000Z', text: 'One word' },
  { id: '4', author: 'Ann Example', date: '2026-10-03T10:00:00.000Z', text: 'At the start' }
]

const COMMENTED = [
  paragraph(text('Revenue rose ', [comment('0')]), text('by a third', [comment('0'), comment('2')])),
  paragraph(text('in May', [comment('0'), comment('2')]), text(' and June', [comment('2')]), ' overall.'),
  paragraph('Costs fell ', text('sharply.', [comment('3')]), ' '),
  paragraph(text('Next', [comment('4')]), ' steps follow.')
]

describe('Word files: comments', () => {
  it('reads threads with their replies and whether they are resolved, and marks the text they are on, across paragraphs and overlapping', async () => {
    const { doc, notes } = await read(await commentsFile())

    expect(doc.attrs?.comments).toEqual(THREADS)
    expect(doc.content).toEqual(COMMENTED)
    expect(notes).toEqual([])
  })

  it('writes the threads back with their replies, ranges and references, and reads the same document again', async () => {
    const { doc: first } = await read(await commentsFile())
    const { bytes, doc, losses } = await roundTrip(first)
    const { names, read: readPart } = await partsOf(bytes)
    const document = parseXml(await readPart('word/document.xml'))
    const extended = children(parseXml(await readPart('word/commentsExtended.xml')), 'w15:commentEx')

    expect(normalized(doc).content).toEqual(normalized(first).content)
    expect(doc.attrs?.comments).toEqual(THREADS)
    expect(findAll(document, 'w:commentRangeStart').map((element) => attr(element, 'w:id'))).toEqual(['0', '1', '2', '3', '4'])
    expect(findAll(document, 'w:commentReference').map((element) => attr(element, 'w:id'))).toEqual(['0', '1', '2', '3', '4'])
    expect(extended.map((element) => [attr(element, 'w15:paraIdParent') ?? null, attr(element, 'w15:done')])).toEqual([
      [null, '1'],
      ['00000001', '1'],
      [null, undefined],
      [null, undefined],
      [null, undefined]
    ])
    expect(names).toContain('word/comments.xml')
    expect(losses).toEqual([])
  })

  it('keeps a resolved thread without replies resolved', async () => {
    const doc: DocJSON = {
      type: 'doc',
      attrs: { page: LETTER, styles: null, comments: [{ id: 'a', author: 'Ann Example', date: '2026-10-05T08:00:00.000Z', text: 'Fixed', resolved: true }] },
      content: [paragraph('Take ', text('this', [comment('a')]), ' out.')]
    }
    const { doc: back, bytes } = await roundTrip(doc)
    const { read: readPart } = await partsOf(bytes)

    expect(back.attrs?.comments).toEqual([{ id: '0', author: 'Ann Example', date: '2026-10-05T08:00:00.000Z', text: 'Fixed', resolved: true }])
    expect(back.content).toEqual([paragraph('Take ', text('this', [comment('0')]), ' out.')])
    expect(await readPart('[Content_Types].xml')).toContain('/word/commentsExtended.xml')
    expect(await readPart('word/_rels/document.xml.rels')).toContain('commentsExtended.xml')
  })

  it('leaves out threads whose text was deleted, and says so', async () => {
    const doc: DocJSON = {
      type: 'doc',
      attrs: {
        page: LETTER,
        styles: null,
        comments: [
          { id: 'a', author: 'Ann Example', date: null, text: 'Gone' },
          { id: 'b', author: 'Bo Example', date: '2026-10-05T08:00:00.000Z', text: 'Kept' }
        ]
      },
      content: [paragraph('Only ', text('this', [comment('b')]), ' is left.')]
    }
    const { doc: back, losses } = await roundTrip(doc)

    expect(back.attrs?.comments).toEqual([{ id: '1', author: 'Bo Example', date: '2026-10-05T08:00:00.000Z', text: 'Kept' }])
    expect(losses).toEqual(['Comments whose text was deleted are left out.'])
  })
})

const NOTE_STYLES = [
  BASE_STYLES,
  paragraphStyle('FootnoteText', 'footnote text', '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr>'),
  paragraphStyle('EndnoteText', 'endnote text', '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr>'),
  characterStyle('FootnoteReference', 'footnote reference', '<w:vertAlign w:val="superscript"/>'),
  characterStyle('EndnoteReference', 'endnote reference', '<w:vertAlign w:val="superscript"/>')
].join('')

const separators = (kind: 'footnote' | 'endnote'): string =>
  `<w:${kind} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${kind}><w:${kind} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}>`

const noteMark = (kind: 'footnote' | 'endnote'): string => `<w:r><w:rPr><w:rStyle w:val="${kind === 'footnote' ? 'Footnote' : 'Endnote'}Reference"/></w:rPr><w:${kind}Ref/></w:r>`

const noteReference = (kind: 'footnote' | 'endnote', id: number, extra = ''): string => `<w:r><w:rPr><w:rStyle w:val="${kind === 'footnote' ? 'Footnote' : 'Endnote'}Reference"/></w:rPr><w:${kind}Reference${extra} w:id="${id}"/>${extra ? '<w:t>*</w:t>' : ''}</w:r>`

describe('Word files: footnotes and endnotes', () => {
  it('reads each note where its reference is, with its formatting, without its number or the note style’s size', async () => {
    const { doc, notes } = await read(
      await word({
        styles: NOTE_STYLES,
        parts: [
          {
            name: 'footnotes.xml',
            id: 'rIdFootnotes',
            type: 'footnotes',
            content: xmlPart(
              'w:footnotes',
              separators('footnote') +
                `<w:footnote w:id="1"><w:p><w:pPr>${pStyle('FootnoteText')}</w:pPr>${noteMark('footnote')}${run(' Source: ')}${run('the plan', '<w:b/>')}</w:p></w:footnote>` +
                `<w:footnote w:id="2"><w:p><w:pPr>${pStyle('FootnoteText')}</w:pPr>${run('A starred note')}</w:p></w:footnote>`
            )
          },
          {
            name: 'endnotes.xml',
            id: 'rIdEndnotes',
            type: 'endnotes',
            content: xmlPart('w:endnotes', separators('endnote') + `<w:endnote w:id="1"><w:p><w:pPr>${pStyle('EndnoteText')}</w:pPr>${noteMark('endnote')}${run(' First')}</w:p><w:p><w:pPr>${pStyle('EndnoteText')}</w:pPr>${run('Second', '<w:i/>')}</w:p></w:endnote>`)
          }
        ],
        body: [
          para(run('Revenue rose') + noteReference('footnote', 1) + run(' sharply') + noteReference('endnote', 1) + run('.')),
          para(run('Costs') + noteReference('footnote', 2, ' w:customMarkFollows="1"') + run(' fell.'))
        ].join('')
      })
    )

    expect(doc.content).toEqual([
      paragraph('Revenue rose', noteNode('footnote', paragraph('Source: ', text('the plan', [bold]))), ' sharply', noteNode('endnote', paragraph('First'), paragraph(text('Second', [{ type: 'italic' }]))), '.'),
      paragraph('Costs', noteNode('footnote', paragraph('A starred note')), ' fell.')
    ])
    expect(notes).toEqual(['Footnotes and endnotes with marks of their own (such as *) are numbered instead.'])
  })

  it('writes real footnotes and endnotes, in their own parts, and reads the same notes back', async () => {
    const doc: DocJSON = {
      type: 'doc',
      attrs: { page: LETTER, styles: null },
      content: [
        paragraph('Revenue rose', noteNode('footnote', paragraph('Source: ', text('the plan', [bold]))), ' sharply', noteNode('endnote', paragraph('First'), paragraph(text('Second', [{ type: 'italic' }]))), '.'),
        paragraph('Costs fell', noteNode('footnote', paragraph('See ', text('the report', [{ type: 'link', attrs: { href: 'https://example.com/report' } }]), '.'))),
        { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('In a list', noteNode('endnote', paragraph('Listed')))] }] }
      ]
    }
    const { bytes, doc: back, losses } = await roundTrip(doc)
    const { read: readPart } = await partsOf(bytes)
    const footnotes = parseXml(await readPart('word/footnotes.xml'))
    const endnotes = parseXml(await readPart('word/endnotes.xml'))

    expect(normalized(back).content).toEqual(normalized(doc).content)
    expect(children(footnotes, 'w:footnote').map((element) => attr(element, 'w:id'))).toEqual(['-1', '0', '1', '2'])
    expect(children(endnotes, 'w:endnote').map((element) => attr(element, 'w:id'))).toEqual(['-1', '0', '1', '2'])
    expect(findAll(children(footnotes, 'w:footnote')[0], 'w:footnoteRef')).toHaveLength(0)
    expect(findAll(children(footnotes, 'w:footnote')[2], 'w:pStyle').map((element) => attr(element, 'w:val'))).toEqual(['FootnoteText'])
    expect(await readPart('word/_rels/footnotes.xml.rels')).toContain('https://example.com/report')
    expect(losses).toEqual([])
  })

  it('leaves out notes in headers, as Word has notes in the text only, and says so', async () => {
    const { doc, losses } = await roundTrip({
      type: 'doc',
      attrs: { page: LETTER, styles: null, headers: { header: { default: [paragraph('Report', noteNode('footnote', paragraph('Nowhere')))] }, footer: {} } },
      content: [paragraph('Body')]
    })

    expect(doc.attrs?.headers).toEqual({ header: { default: [paragraph('Report')] }, footer: {} })
    expect(losses).toEqual(['Footnotes and endnotes in headers, footers and other notes are left out, as Word has notes in the text only.'])
  })
})

const A4: PageSettings = { width: 595.3, height: 841.9, margins: { top: 72, right: 72, bottom: 72, left: 72 } }

describe('Word files: sections', () => {
  it('writes a section for each part of the document, with its own page size, orientation, margins and start, and reads them back', async () => {
    const landscape: PageSettings = { width: 792, height: 612, margins: { top: 54, right: 54, bottom: 54, left: 54, footer: 24 } }
    const doc: DocJSON = {
      type: 'doc',
      attrs: { page: A4, styles: null, headers: { header: { default: [paragraph('Every section')] }, footer: {} } },
      content: [
        heading(1, 'Portrait'),
        { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colwidth: [300] }, content: [paragraph('Cell')] }] }] },
        { type: 'sectionBreak', attrs: { kind: 'nextPage', page: landscape } },
        paragraph('Wide'),
        { type: 'sectionBreak', attrs: { kind: 'continuous', page: null } },
        paragraph('Same page'),
        { type: 'sectionBreak', attrs: { kind: 'oddPage', page: A4 } },
        paragraph('Back to A4')
      ]
    }
    const { bytes, doc: back } = await roundTrip(doc)
    const sections = findAll(parseXml(await (await partsOf(bytes)).read('word/document.xml')), 'w:sectPr')

    expect(normalized(back).content).toEqual(normalized(doc).content)
    expect(back.attrs?.page).toEqual(A4)
    expect(sections.map((section) => [attr(children(section, 'w:type')[0], 'w:val') ?? null, attr(children(section, 'w:pgSz')[0], 'w:orient'), children(section, 'w:headerReference').length])).toEqual([
      [null, 'portrait', 1],
      ['nextPage', 'landscape', 0],
      ['continuous', 'landscape', 0],
      ['oddPage', 'portrait', 0]
    ])
  })
})

/** A DrawingML text box placed beside the text, with VML for older programs. */
const floatingBox = (inner: string, spPr: string, align: string): string =>
  `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="2" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="margin"><wp:align>${align}</wp:align></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="2286000" cy="914400"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="3" name="Text Box 3"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr>${spPr}</wps:spPr><wps:txbx><w:txbxContent>${inner}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape style="position:absolute;width:180pt;height:72pt"><v:textbox><w:txbxContent>${inner}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>`

const groupOfBoxes = (): string => {
  const shape = (cx: number, value: string) =>
    `<wps:wsp><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="457200"/></a:xfrm><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr><wps:txbx><w:txbxContent>${para(run(value))}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp>`

  return `<w:r><w:drawing><wp:inline><wp:extent cx="2743200" cy="457200"/><wp:docPr id="4" name="Group 4"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"><wpg:wgp><wpg:cNvGrpSpPr/><wpg:grpSpPr/>${shape(1371600, 'Left half')}${shape(1371600, 'Right half')}<wps:wsp><wps:spPr><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom></wps:spPr><wps:bodyPr/></wps:wsp></wpg:wgp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
}

describe('Word files: text boxes', () => {
  it('reads text boxes with their size, place, border and fill, after the paragraph they are anchored to', async () => {
    const { doc, notes } = await read(
      await word({
        body: [
          para(run('Anchor') + floatingBox(para(run('Boxed ')) + para(run('twice', '<w:b/>')), '<a:solidFill><a:srgbClr val="FFF2CC"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:ln>', 'center')),
          para('<w:r><w:pict><v:shape style="width:2in;height:36pt" strokecolor="#2f5496" fillcolor="white [3212]"><v:textbox><w:txbxContent>' + para(run('Old style')) + '</w:txbxContent></v:textbox></v:shape></w:pict></w:r>', '<w:jc w:val="right"/>'),
          para(groupOfBoxes())
        ].join('')
      })
    )

    expect(doc.content).toEqual([
      paragraph('Anchor'),
      { type: 'textBox', attrs: { width: 180, height: 72, align: 'center', border: '#c00000', fill: '#fff2cc' }, content: [paragraph('Boxed '), paragraph(text('twice', [bold]))] },
      { type: 'textBox', attrs: { width: 144, height: 36, align: 'right', border: '#2f5496', fill: '#ffffff' }, content: [paragraph('Old style')] },
      { type: 'textBox', attrs: { width: 108, height: 36, align: null, border: null, fill: null }, content: [paragraph('Left half')] },
      { type: 'textBox', attrs: { width: 108, height: 36, align: null, border: null, fill: null }, content: [paragraph('Right half')] }
    ])
    expect(notes).toEqual(['Text boxes placed beside the text are shown after the paragraph they are anchored to.', 'Shapes other than pictures and text boxes are left out.'])
  })

  it('writes text boxes as VML text boxes in a paragraph of their own, which python-docx and Word read, and reads them back', async () => {
    const doc: DocJSON = {
      type: 'doc',
      attrs: { page: LETTER, styles: null },
      content: [
        paragraph('Before'),
        { type: 'textBox', attrs: { width: 200, height: 80, align: 'center', border: '#c00000', fill: '#fff2cc' }, content: [paragraph(text('Boxed', [bold])), { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('Point')] }] }] },
        { type: 'textBox', attrs: { width: null, height: null, align: null, border: null, fill: null }, content: [paragraph('Plain')] },
        paragraph('After')
      ]
    }
    const { bytes, doc: back } = await roundTrip(doc)
    const document = await (await partsOf(bytes)).read('word/document.xml')

    expect(normalized(back).content).toEqual(normalized({ ...doc, content: doc.content.map((node, index) => (index === 2 ? { ...node, attrs: { ...node.attrs, width: 468 } } : node)) }).content)
    expect(document).toContain('<v:shape id="_x0000_s1025" type="#_x0000_t202" style="width:200pt;height:80pt" stroked="t" strokecolor="#c00000" strokeweight="0.75pt" filled="t" fillcolor="#fff2cc">')
    expect(document).toContain('stroked="f"')
    expect(document).toContain('<v:textbox style="mso-fit-shape-to-text:t">')
  })
})

describe('Word files: what Herald keeps without showing it', () => {
  const ITEM = '<?xml version="1.0" encoding="UTF-8"?><b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography" SelectedStyle="APA"/>'
  const ITEM_PROPS = '<?xml version="1.0" encoding="UTF-8" standalone="no"?><ds:datastoreItem ds:itemID="{0A1B2C3D-0000-4000-8000-000000000001}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs/></ds:datastoreItem>'
  const CUSTOM =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Client"><vt:lpwstr>Example Ltd</vt:lpwstr></property></Properties>'
  const CORE =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Quarterly plan</dc:title><dc:creator>Ann Example</dc:creator><cp:keywords>plan, revenue</cp:keywords></cp:coreProperties>'
  const PROPS_TYPE = 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml'
  const CUSTOM_TYPE = 'application/vnd.openxmlformats-officedocument.custom-properties+xml'

  const keptFile = (): Promise<Uint8Array> =>
    word({
      body: para(run('Client: ') + field('DOCPROPERTY Client', run('Example Ltd'))),
      files: {
        'customXml/item1.xml': ITEM,
        'customXml/itemProps1.xml': ITEM_PROPS,
        'customXml/_rels/item1.xml.rels': relationshipsXml([['rId1', 'customXmlProps', 'itemProps1.xml']]),
        'docProps/custom.xml': CUSTOM,
        'docProps/core.xml': CORE
      },
      parts: [{ name: '../customXml/item1.xml', id: 'rIdItem', type: 'customXml', content: ITEM }],
      packageRelationships: [
        ['rIdCustom', 'custom-properties', 'docProps/custom.xml'],
        ['rIdCore', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml']
      ],
      overrides: { 'customXml/itemProps1.xml': PROPS_TYPE, 'docProps/custom.xml': CUSTOM_TYPE }
    })

  it('keeps custom XML data, custom properties and the title, author and keywords, and writes them back', async () => {
    const { doc } = await read(await keptFile())
    const { bytes, doc: back } = await roundTrip(doc)
    const { names, read: readPart } = await partsOf(bytes)

    expect(doc.attrs?.kept).toMatchObject({ properties: { title: 'Quarterly plan', creator: 'Ann Example', keywords: 'plan, revenue' } })
    expect((doc.attrs?.kept as { parts: { path: string }[] }).parts.map((part) => part.path).sort()).toEqual(['customXml/_rels/item1.xml.rels', 'customXml/item1.xml', 'customXml/itemProps1.xml', 'docProps/custom.xml'])
    expect(names).toEqual(expect.arrayContaining(['customXml/item1.xml', 'customXml/itemProps1.xml', 'customXml/_rels/item1.xml.rels']))
    expect(await readPart('customXml/item1.xml')).toBe(ITEM)
    expect(await readPart('docProps/custom.xml')).toBe(CUSTOM)
    expect(await readPart('word/_rels/document.xml.rels')).toContain('Target="../customXml/item1.xml"')
    expect(await readPart('[Content_Types].xml')).toContain(`<Override ContentType="${PROPS_TYPE}" PartName="/customXml/itemProps1.xml"/>`)
    expect(await readPart('docProps/core.xml')).toContain('<dc:title>Quarterly plan</dc:title>')
    expect(await readPart('docProps/core.xml')).toContain('<dc:creator>Ann Example</dc:creator>')
    expect(back.attrs?.kept).toEqual(doc.attrs?.kept)

    for (const name of names.filter((part) => /\.(xml|rels)$/.test(part))) {
      expect(wellFormed(await readPart(name)), name).toBe(true)
    }
  })

  it('never writes a kept part over one Herald writes, nor one outside the package', async () => {
    const forged = { parts: [{ path: 'word/document.xml', type: null, data: 'AA==' }, { path: '../evil.xml', type: null, data: 'AA==' }], relationships: [], properties: { title: 'Plan', extra: 'x' } }
    const { bytes, doc } = await roundTrip({ type: 'doc', attrs: { page: LETTER, styles: null, kept: forged }, content: [paragraph('Safe')] })
    const { names } = await partsOf(bytes)

    expect(doc.content).toEqual([paragraph('Safe')])
    expect(names.some((name) => name.includes('evil'))).toBe(false)
  })
})
