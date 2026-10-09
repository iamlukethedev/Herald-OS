import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { describe, expect, it } from 'vitest'
import type { Deck, ImageElement, LineElement, ShapeElement, Slide, SlideElement, TableElement, TextElement } from '../deck.ts'
import { plainText } from '../text.ts'
import { colorIn, OFFICE_SCHEME, type Paint, type Palette, STANDARD_MAP } from './color.ts'
import { imageSize } from './image-size.ts'
import { importPresentation } from './import.ts'
import { type ImportReport, reportNotes } from './report.ts'
import { parseXml } from './xml.ts'

const HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS = `xmlns:a="${A}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`
const MC = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"'
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'

/** A 1 by 1 PNG. */
const DOT = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (char) => char.charCodeAt(0))

const emu = (points: number): number => Math.round(points * 12700)

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0))

/** A PNG's signature and header for a picture of a size: all that is read of it. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  const view = new DataView(bytes.buffer)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii('IHDR')])
  view.setUint32(16, width)
  view.setUint32(20, height)
  bytes.set([8, 6, 0, 0, 0], 24)

  return bytes
}

type Rel = [id: string, type: string, target: string, external?: boolean]

const rels = (entries: readonly Rel[]): string =>
  `${HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(([id, type, target, external]) => `<Relationship Id="${id}" Type="${type.includes('/') ? type : RELATIONSHIPS + type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`)
    .join('')}</Relationships>`

const tree = (shapes: string): string => `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree>`
const xfrm = (x: number, y: number, width: number, height: number, attrs = ''): string => `<a:xfrm${attrs}><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(width)}" cy="${emu(height)}"/></a:xfrm>`
const geometry = (preset: string, guides = ''): string => `<a:prstGeom prst="${preset}"><a:avLst>${guides}</a:avLst></a:prstGeom>`
const srgb = (hex: string, modifiers = ''): string => `<a:srgbClr val="${hex}">${modifiers}</a:srgbClr>`
const scheme = (name: string, modifiers = ''): string => `<a:schemeClr val="${name}">${modifiers}</a:schemeClr>`
const solid = (color: string): string => `<a:solidFill>${color}</a:solidFill>`
const line = (width: number, color: string, more = ''): string => `<a:ln w="${emu(width)}">${solid(color)}${more}</a:ln>`
const run = (text: string, attrs = '', props = ''): string => `<a:r><a:rPr lang="en-GB"${attrs}>${props}</a:rPr><a:t>${text}</a:t></a:r>`
const paragraph = (content: string, props = ''): string => `<a:p>${props}${content}</a:p>`
const level = (n: number, attrs: string, inner: string): string => `<a:lvl${n}pPr${attrs}>${inner}</a:lvl${n}pPr>`

interface ShapeSpec {
  id?: number
  name?: string
  ph?: string
  textBox?: boolean
  hidden?: boolean
  props?: string
  style?: string
  text?: string
  bodyPr?: string
  lstStyle?: string
}

function sp(spec: ShapeSpec): string {
  const id = spec.id ?? 2
  const body = spec.text === undefined ? '' : `<p:txBody>${spec.bodyPr ?? '<a:bodyPr/>'}${spec.lstStyle ?? '<a:lstStyle/>'}${spec.text}</p:txBody>`

  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${spec.name ?? `Shape ${id}`}"${spec.hidden ? ' hidden="1"' : ''}/><p:cNvSpPr${spec.textBox ? ' txBox="1"' : ''}/><p:nvPr>${spec.ph ?? ''}</p:nvPr></p:nvSpPr><p:spPr>${spec.props ?? ''}</p:spPr>${spec.style ?? ''}${body}</p:sp>`
}

interface PictureSpec {
  id?: number
  name?: string
  embed: string
  descr?: string
  props?: string
  blip?: string
  fill?: string
  nvPr?: string
}

const pic = (spec: PictureSpec): string =>
  `<p:pic><p:nvPicPr><p:cNvPr id="${spec.id ?? 5}" name="${spec.name ?? 'Picture'}"${spec.descr ? ` descr="${spec.descr}"` : ''}/><p:cNvPicPr/><p:nvPr>${spec.nvPr ?? ''}</p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="${spec.embed}">${spec.blip ?? ''}</a:blip>${spec.fill ?? '<a:stretch><a:fillRect/></a:stretch>'}</p:blipFill><p:spPr>${spec.props ?? xfrm(10, 10, 100, 50) + geometry('rect')}</p:spPr></p:pic>`

const connector = (props: string, style = '', name = 'Connector'): string => `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="7" name="${name}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${props}</p:spPr>${style}</p:cxnSp>`

const group = (outer: [number, number, number, number], inner: [number, number, number, number], shapes: string, attrs = '', name = 'Group', props = ''): string =>
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="20" name="${name}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm${attrs}><a:off x="${emu(outer[0])}" y="${emu(outer[1])}"/><a:ext cx="${emu(outer[2])}" cy="${emu(outer[3])}"/><a:chOff x="${emu(inner[0])}" y="${emu(inner[1])}"/><a:chExt cx="${emu(inner[2])}" cy="${emu(inner[3])}"/></a:xfrm>${props}</p:grpSpPr>${shapes}</p:grpSp>`

const frame = (uri: string, inner = '', name = 'Frame'): string =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="${name}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${emu(50)}" y="${emu(60)}"/><a:ext cx="${emu(200)}" cy="${emu(100)}"/></p:xfrm><a:graphic><a:graphicData uri="${uri}">${inner}</a:graphicData></a:graphic></p:graphicFrame>`

const filled = (name: string, fill: string, preset = 'rect'): string => sp({ name, props: xfrm(0, 0, 100, 100) + geometry(preset) + fill })

const SCHEME: Record<string, string> = {
  dk1: '000000',
  lt1: 'FFFFFF',
  dk2: '1F2A44',
  lt2: 'EEECE1',
  accent1: '4472C4',
  accent2: 'ED7D31',
  accent3: 'A5A5A5',
  accent4: 'FFC000',
  accent5: '5B9BD5',
  accent6: '70AD47',
  hlink: '0563C1',
  folHlink: '954F72'
}

const FORMATS = `<a:fmtScheme name="Test"><a:fillStyleLst>${solid(scheme('phClr'))}<a:gradFill><a:gsLst><a:gs pos="0">${scheme('phClr', '<a:tint val="50000"/>')}</a:gs><a:gs pos="100000">${scheme('phClr')}</a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill>${solid(scheme('phClr', '<a:shade val="50000"/>'))}</a:fillStyleLst><a:lnStyleLst><a:ln w="6350">${solid(scheme('phClr'))}</a:ln><a:ln w="12700">${solid(scheme('phClr'))}</a:ln><a:ln w="19050">${solid(scheme('phClr'))}<a:prstDash val="dash"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000">${srgb('000000', '<a:alpha val="63000"/>')}</a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${solid(scheme('phClr'))}${solid(scheme('phClr', '<a:tint val="95000"/>'))}<a:gradFill><a:gsLst><a:gs pos="0">${scheme('phClr')}</a:gs><a:gs pos="100000">${srgb('000000')}</a:gs></a:gsLst><a:lin ang="0"/></a:gradFill></a:bgFillStyleLst></a:fmtScheme>`

function themeXml(name = 'Test Theme', fonts: [string, string] = ['Georgia', 'Verdana'], colors = SCHEME): string {
  const entries = Object.entries(colors).map(([key, hex]) => (key === 'dk1' ? `<a:dk1><a:sysClr val="windowText" lastClr="${hex}"/></a:dk1>` : `<a:${key}>${srgb(hex)}</a:${key}>`))

  return `${HEADER}<a:theme xmlns:a="${A}" name="${name}"><a:themeElements><a:clrScheme name="Test">${entries.join('')}</a:clrScheme><a:fontScheme name="Test"><a:majorFont><a:latin typeface="${fonts[0]}"/></a:majorFont><a:minorFont><a:latin typeface="${fonts[1]}"/></a:minorFont></a:fontScheme>${FORMATS}</a:themeElements></a:theme>`
}

const colorMap = (dark: boolean, tag = 'p:clrMap'): string =>
  `<${tag} bg1="${dark ? 'dk1' : 'lt1'}" tx1="${dark ? 'lt1' : 'dk1'}" bg2="${dark ? 'dk2' : 'lt2'}" tx2="${dark ? 'lt2' : 'dk2'}" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>`

const MASTER_MAPPING = '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'

const TEXT_STYLES = `<p:txStyles><p:titleStyle>${level(1, ' algn="l"', `<a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:buNone/><a:defRPr sz="4400">${solid(scheme('tx1'))}<a:latin typeface="+mj-lt"/></a:defRPr>`)}</p:titleStyle><p:bodyStyle>${level(
  1,
  ' marL="228600" indent="-228600"',
  `<a:spcBef><a:spcPts val="1000"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="2800">${solid(scheme('tx1'))}<a:latin typeface="+mn-lt"/></a:defRPr>`
)}${level(2, ' marL="685800" indent="-228600"', `<a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="2400">${solid(scheme('tx1'))}<a:latin typeface="+mn-lt"/></a:defRPr>`)}</p:bodyStyle><p:otherStyle>${level(1, ' marL="0"', `<a:defRPr sz="1800">${solid(scheme('tx1'))}<a:latin typeface="+mn-lt"/></a:defRPr>`)}</p:otherStyle></p:txStyles>`

const MASTER_PLACEHOLDERS = [
  sp({ id: 2, name: 'Title Placeholder 1', ph: '<p:ph type="title"/>', props: xfrm(60, 30, 840, 100) + geometry('rect'), text: paragraph(run('Click to edit Master title style')), bodyPr: '<a:bodyPr anchor="ctr"/>' }),
  sp({ id: 3, name: 'Text Placeholder 2', ph: '<p:ph type="body" idx="1"/>', props: xfrm(60, 140, 840, 340) + geometry('rect'), text: paragraph(run('Click to edit Master text styles')), bodyPr: '<a:bodyPr><a:normAutofit/></a:bodyPr>' }),
  sp({ id: 4, name: 'Date Placeholder 3', ph: '<p:ph type="dt" sz="half" idx="2"/>', props: xfrm(60, 500, 220, 30), text: paragraph(run('1 January 2026')), lstStyle: `<a:lstStyle>${level(1, '', '<a:defRPr sz="1200"/>')}</a:lstStyle>` }),
  sp({ id: 5, name: 'Slide Number Placeholder 4', ph: '<p:ph type="sldNum" sz="quarter" idx="4"/>', props: xfrm(680, 500, 220, 30), text: paragraph('<a:fld id="{1}" type="slidenum"><a:rPr lang="en-GB"/><a:t>‹#›</a:t></a:fld>'), lstStyle: `<a:lstStyle>${level(1, ' algn="r"', '<a:defRPr sz="1200"/>')}</a:lstStyle>` })
].join('')

interface MasterSpec {
  shapes?: string
  clrMap?: string
  bg?: string
  rels?: Rel[]
}

const masterXml = (spec: MasterSpec = {}): string =>
  `${HEADER}<p:sldMaster ${NS}><p:cSld>${spec.bg ?? `<p:bg><p:bgRef idx="1001">${scheme('bg1')}</p:bgRef></p:bg>`}${tree(MASTER_PLACEHOLDERS + (spec.shapes ?? ''))}</p:cSld>${spec.clrMap ?? colorMap(false)}<p:sldLayoutIdLst/>${TEXT_STYLES}</p:sldMaster>`

const TITLE_LAYOUT = tree(
  sp({ id: 2, name: 'Title 1', ph: '<p:ph type="ctrTitle"/>', props: xfrm(120, 160, 720, 120), text: paragraph(run('Click to edit Master title style')), bodyPr: '<a:bodyPr anchor="b"/>', lstStyle: `<a:lstStyle>${level(1, ' algn="ctr"', '<a:defRPr sz="6000"/>')}</a:lstStyle>` }) +
    sp({
      id: 3,
      name: 'Subtitle 2',
      ph: '<p:ph type="subTitle" idx="1"/>',
      props: xfrm(120, 290, 720, 80),
      text: paragraph(run('Click to edit Master subtitle style')),
      lstStyle: `<a:lstStyle>${level(1, ' marL="0" indent="0" algn="ctr"', `<a:buNone/><a:defRPr sz="2400">${solid(scheme('tx2'))}</a:defRPr>`)}</a:lstStyle>`
    })
)

const CONTENT_LAYOUT = tree(sp({ id: 2, name: 'Title 1', ph: '<p:ph type="title"/>', text: paragraph(run('Click to edit Master title style')) }) + sp({ id: 3, name: 'Content Placeholder 2', ph: '<p:ph idx="1"/>', text: paragraph(run('Click to edit Master text styles')) }))

interface LayoutSpec {
  type?: string
  name?: string
  tree?: string
  attrs?: string
  rels?: Rel[]
}

const layoutXml = (spec: LayoutSpec): string =>
  `${HEADER}<p:sldLayout ${NS}${spec.type ? ` type="${spec.type}"` : ''}${spec.attrs ?? ''}><p:cSld${spec.name ? ` name="${spec.name}"` : ''}>${spec.tree ?? tree('')}</p:cSld>${MASTER_MAPPING}</p:sldLayout>`

/** Layouts 1 to 3: a title layout, a title and content layout, and a blank one. */
const LAYOUTS: LayoutSpec[] = [{ type: 'title', tree: TITLE_LAYOUT }, { type: 'obj', tree: CONTENT_LAYOUT }, { type: 'blank' }]

interface SlideSpec {
  shapes?: string
  /** Which of the deck's layouts, from 1 (the title and content layout when not said). */
  layout?: number
  attrs?: string
  bg?: string
  /** What follows the shapes: the colour map override, transition and timing. */
  after?: string
  rels?: Rel[]
  notes?: string
}

const slideXml = (spec: SlideSpec): string => `${HEADER}<p:sld ${NS}${spec.attrs ?? ''}><p:cSld>${spec.bg ?? ''}${tree(spec.shapes ?? '')}</p:cSld>${spec.after ?? MASTER_MAPPING}</p:sld>`

const notesXml = (text: string): string =>
  `${HEADER}<p:notes ${NS}><p:cSld>${tree(
    sp({ id: 2, name: 'Slide Image Placeholder 1', ph: '<p:ph type="sldImg"/>' }) +
      sp({
        id: 3,
        name: 'Notes Placeholder 2',
        ph: '<p:ph type="body" idx="1"/>',
        text: text
          .split('\n')
          .map((entry) => paragraph(run(entry)))
          .join('')
      })
  )}</p:cSld></p:notes>`

interface DeckSpec {
  size?: [number, number]
  theme?: string
  master?: MasterSpec
  layouts?: LayoutSpec[]
  slides: SlideSpec[]
  files?: Record<string, string | Uint8Array>
  presentation?: string
  presentationRels?: Rel[]
  contentTypes?: string
}

function build(spec: DeckSpec): JSZip {
  const zip = new JSZip()
  const layouts = spec.layouts ?? LAYOUTS
  const [cx, cy] = spec.size ?? [12192000, 6858000]
  const slideList = spec.slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rIdSlide${index + 1}"/>`).join('')

  zip.file(
    '[Content_Types].xml',
    `${HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${spec.contentTypes ?? ''}</Types>`
  )
  zip.file('_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]))
  zip.file(
    'ppt/presentation.xml',
    `${HEADER}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst><p:sldIdLst>${slideList}</p:sldIdLst><p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/>${spec.presentation ?? ''}</p:presentation>`
  )
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    rels([['rIdMaster', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rIdTheme', 'theme', 'theme/theme1.xml'], ...spec.slides.map((_, index): Rel => [`rIdSlide${index + 1}`, 'slide', `slides/slide${index + 1}.xml`]), ...(spec.presentationRels ?? [])])
  )
  zip.file('ppt/theme/theme1.xml', spec.theme ?? themeXml())
  zip.file('ppt/slideMasters/slideMaster1.xml', masterXml(spec.master))
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([...layouts.map((_, index): Rel => [`rIdLayout${index + 1}`, 'slideLayout', `../slideLayouts/slideLayout${index + 1}.xml`]), ['rIdTheme', 'theme', '../theme/theme1.xml'], ...(spec.master?.rels ?? [])]))

  layouts.forEach((layout, index) => {
    zip.file(`ppt/slideLayouts/slideLayout${index + 1}.xml`, layoutXml(layout))
    zip.file(`ppt/slideLayouts/_rels/slideLayout${index + 1}.xml.rels`, rels([['rIdMaster', 'slideMaster', '../slideMasters/slideMaster1.xml'], ...(layout.rels ?? [])]))
  })

  spec.slides.forEach((slide, index) => {
    const number = index + 1
    const own: Rel[] = [['rIdLayout', 'slideLayout', `../slideLayouts/slideLayout${slide.layout ?? 2}.xml`], ...(slide.rels ?? [])]

    if (slide.notes !== undefined) {
      own.push(['rIdNotes', 'notesSlide', `../notesSlides/notesSlide${number}.xml`])
      zip.file(`ppt/notesSlides/notesSlide${number}.xml`, notesXml(slide.notes))
    }

    zip.file(`ppt/slides/slide${number}.xml`, slideXml(slide))
    zip.file(`ppt/slides/_rels/slide${number}.xml.rels`, rels(own))
  })

  for (const [path, data] of Object.entries(spec.files ?? {})) {
    zip.file(path, data)
  }

  return zip
}

/** A built deck saved and opened again, as a file from disk would be. */
async function open(spec: DeckSpec): Promise<{ deck: Deck; report: ImportReport }> {
  const zip = await JSZip.loadAsync(await build(spec).generateAsync({ type: 'uint8array' }))

  return importPresentation(zip, 'Test deck')
}

/** One slide of shapes on the blank layout. */
const shapes = async (content: string, more: Partial<DeckSpec> = {}): Promise<{ slide: Slide; report: ImportReport }> => {
  const { deck, report } = await open({ ...more, slides: [{ shapes: content, layout: 3, ...more.slides?.[0] }] })

  return { slide: deck.slides[0], report }
}

function named<T extends SlideElement>(slide: Slide, name: string): T {
  const element = slide.elements.find((entry) => entry.name === name)

  if (!element) {
    throw new Error(`No element named ${name}`)
  }

  return element as T
}

const counts = (report: ImportReport) => Object.fromEntries(Object.entries(report.counts).filter(([, entry]) => entry.imported || entry.approximated || entry.skipped))

describe('importPresentation: the deck', () => {
  it('reads the slide size in points, fractions kept', async () => {
    expect((await open({ slides: [{}] })).deck.size).toEqual({ width: 960, height: 540 })
    expect((await open({ size: [9144000, 6858000], slides: [{}] })).deck.size).toEqual({ width: 720, height: 540 })
    expect((await open({ size: [12188952, 6858000], slides: [{}] })).deck.size).toEqual({ width: 959.76, height: 540 })
  })

  it('builds the theme from the first master: its fonts, and its colours through the colour map', async () => {
    const { deck } = await open({ slides: [{}] })

    expect(deck).toMatchObject({ title: 'Test deck', transition: 'none' })
    expect(deck.theme).toEqual({
      id: 'imported',
      name: 'Test Theme',
      fonts: { heading: 'Georgia', body: 'Verdana' },
      colors: { bg1: '#ffffff', tx1: '#000000', bg2: '#eeece1', tx2: '#1f2a44', accent1: '#4472c4', accent2: '#ed7d31', accent3: '#a5a5a5', accent4: '#ffc000', accent5: '#5b9bd5', accent6: '#70ad47' }
    })

    const dark = await open({ master: { clrMap: colorMap(true) }, slides: [{}] })

    expect(dark.deck.theme.colors).toMatchObject({ bg1: '#000000', tx1: '#ffffff', bg2: '#1f2a44', tx2: '#eeece1' })
  })

  it('falls back on Office fonts and a theme name when the theme says nothing', async () => {
    const { deck } = await open({ theme: `${HEADER}<a:theme xmlns:a="${A}"><a:themeElements/></a:theme>`, slides: [{}] })

    expect(deck.theme.name).toBe('Imported theme')
    expect(deck.theme.fonts).toEqual({ heading: 'Calibri', body: 'Calibri' })
    expect(deck.theme.colors.accent1).toBe('#4472c4')
  })

  it('keeps slides in the order the presentation lists them, with their layouts, notes and hidden state', async () => {
    const { deck } = await open({
      slides: [{ layout: 1, notes: 'First line\nSecond line' }, { layout: 2, attrs: ' show="0"' }, { layout: 3 }]
    })

    expect(deck.slides.map((slide) => slide.layout)).toEqual(['title', 'title-content', 'blank'])
    expect(deck.slides.map((slide) => slide.notes)).toEqual(['First line\nSecond line', '', ''])
    expect(deck.slides.map((slide) => slide.hidden)).toEqual([false, true, false])
  })

  it('names layouts by their type, else by their name, else by their placeholders', async () => {
    const layouts: LayoutSpec[] = [
      { type: 'secHead' },
      { type: 'twoObj' },
      { type: 'twoTxTwoObj' },
      { type: 'titleOnly' },
      { type: 'picTx' },
      { type: 'cust', tree: CONTENT_LAYOUT },
      { tree: tree(sp({ ph: '<p:ph type="title"/>' })) },
      { tree: tree(sp({ ph: '<p:ph type="ctrTitle"/>' })) },
      { type: 'cust' },
      { name: 'Section Header', tree: CONTENT_LAYOUT },
      { name: 'Title Slide' },
      { type: 'obj', name: 'Blank' }
    ]
    const { deck } = await open({ layouts, slides: layouts.map((_, index) => ({ layout: index + 1 })) })

    expect(deck.slides.map((slide) => slide.layout)).toEqual(['section', 'two-content', 'comparison', 'title-only', 'picture-caption', 'title-content', 'title-only', 'title', 'blank', 'section', 'title', 'title-content'])
  })

  it('throws for a file without a presentation', async () => {
    await expect(importPresentation(new JSZip(), 'Empty')).rejects.toThrow('This is not a PowerPoint presentation')

    const word = new JSZip()
    word.file('_rels/.rels', rels([['rId1', 'officeDocument', 'word/document.xml']]))
    word.file('word/document.xml', `${HEADER}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`)

    await expect(importPresentation(word, 'Letter')).rejects.toThrow('This is not a PowerPoint presentation')
  })

  it('finds the presentation through the content types when the package relationships are missing', async () => {
    const zip = build({ slides: [{}] })
    zip.remove('_rels/.rels')

    expect((await importPresentation(zip, 'Deck')).deck.slides).toHaveLength(1)
  })

  it('gives a file without slides one blank slide', async () => {
    const { deck } = await open({ slides: [] })

    expect(deck.slides).toHaveLength(1)
    expect(deck.slides[0]).toMatchObject({ layout: 'blank', elements: [] })
  })
})

describe('importPresentation: text', () => {
  it('reads runs with their bold, italic, underline, strike, colour, size, font and highlight', async () => {
    const runs = [
      run('Plain ', ' sz="2000"', solid(srgb('333333'))),
      run('bold', ' sz="2000" b="1"', solid(srgb('333333'))),
      run(' italic', ' sz="2000" i="1"', solid(srgb('333333'))),
      run(' under', ' sz="2000" u="sng"', solid(srgb('333333'))),
      run(' red', ' sz="2000"', solid(srgb('FF0000'))),
      run(' big', ' sz="3200"', solid(srgb('333333'))),
      run(' serif', ' sz="2000"', solid(srgb('333333')) + '<a:latin typeface="Times New Roman"/>'),
      run(' heading', ' sz="2000"', solid(srgb('333333')) + '<a:latin typeface="+mj-lt"/>'),
      run(' struck', ' sz="2000" strike="sngStrike"', solid(srgb('333333'))),
      run(' marked', ' sz="2000"', solid(srgb('333333')) + `<a:highlight>${srgb('FFFF00')}</a:highlight>`)
    ]
    const { slide, report } = await shapes(sp({ name: 'Text', textBox: true, props: xfrm(10, 20, 300, 100) + geometry('rect') + '<a:noFill/>', text: paragraph(runs.join('')) + paragraph(run('One', ' sz="2000"') + '<a:br/>' + run('Two', ' sz="2000"')) }))
    const text = named<TextElement>(slide, 'Text')

    expect(text).toMatchObject({ kind: 'text', x: 10, y: 20, width: 300, height: 100, rotation: 0, fill: null, stroke: null })
    expect(text.body.style).toEqual({ font: '+body', size: 20, color: '#333333' })
    expect(text.body.paragraphs[0].runs).toEqual([
      { text: 'Plain ' },
      { text: 'bold', bold: true },
      { text: ' italic', italic: true },
      { text: ' under', underline: true },
      { text: ' red', color: '#ff0000' },
      { text: ' big', size: 32 },
      { text: ' serif', font: 'Times New Roman' },
      { text: ' heading', font: '+heading' },
      { text: ' struck', strike: true },
      { text: ' marked', highlight: '#ffff00' }
    ])
    expect(text.body.paragraphs[1].runs).toEqual([{ text: 'One\nTwo', color: 'tx1' }])
    expect(counts(report)).toEqual({ text: { imported: 1, approximated: 0, skipped: 0 } })
  })

  it('keeps an empty paragraph as one empty run sized by its end of paragraph', async () => {
    const { slide } = await shapes(sp({ name: 'Text', textBox: true, props: xfrm(0, 0, 100, 50), text: paragraph(run('Big', ' sz="4000"')) + '<a:p><a:endParaRPr lang="en-GB" sz="1000"/></a:p>' }))

    expect(named<TextElement>(slide, 'Text').body.paragraphs.map((entry) => entry.runs)).toEqual([[{ text: 'Big' }], [{ text: '', size: 10 }]])
  })

  it('reads bullets and numbering with their levels, glyphs, styles and indents', async () => {
    const paragraphs = [
      paragraph(run('One'), '<a:pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>'),
      paragraph(run('Two'), '<a:pPr lvl="1" marL="685800" indent="-342900"><a:buFont typeface="Wingdings"/><a:buChar char="§"/></a:pPr>'),
      paragraph(run('Three'), '<a:pPr lvl="2" marL="1028700" indent="-342900"><a:buAutoNum type="romanUcPeriod" startAt="3"/></a:pPr>'),
      paragraph(run('Four'), '<a:pPr marL="342900" indent="-342900"><a:buAutoNum type="arabicPeriod"/></a:pPr>'),
      paragraph(run('Five'), '<a:pPr marL="457200" indent="-228600"><a:buAutoNum type="circleNumDbPlain"/></a:pPr>'),
      paragraph(run('Six'), '<a:pPr marL="342900" indent="-342900"><a:buFont typeface="Wingdings"/><a:buChar char="&#xF0D8;"/></a:pPr>'),
      paragraph(run('Seven'), '<a:pPr><a:buNone/></a:pPr>')
    ]
    const { slide, report } = await shapes(sp({ name: 'List', textBox: true, props: xfrm(0, 0, 400, 300), text: paragraphs.join('') }))
    const list = named<TextElement>(slide, 'List').body.paragraphs.map(({ runs, ...rest }) => ({ text: runs[0].text, ...rest }))

    expect(list).toEqual([
      { text: 'One', list: 'bullet' },
      { text: 'Two', list: 'bullet', level: 1, bullet: '▪' },
      { text: 'Three', list: 'number', level: 2, numbering: 'romanUcPeriod', startAt: 3 },
      { text: 'Four', list: 'number' },
      { text: 'Five', list: 'number', margin: 36, indent: -18 },
      { text: 'Six', list: 'bullet', bullet: '➢' },
      { text: 'Seven' }
    ])
    expect(report.counts.text).toEqual({ imported: 0, approximated: 1, skipped: 0 })
    expect(report.reasons).toEqual({ 'list numbers shown in the nearest style Herald has': 1 })
  })

  it('reads alignment, line spacing, paragraph spacing and the body properties', async () => {
    const paragraphs = [
      paragraph(run('Centred', ' sz="2000"'), '<a:pPr algn="ctr"><a:lnSpc><a:spcPct val="150000"/></a:lnSpc><a:spcBef><a:spcPts val="600"/></a:spcBef><a:spcAft><a:spcPts val="1200"/></a:spcAft></a:pPr>'),
      paragraph(run('Right', ' sz="2000"'), '<a:pPr algn="r"/>'),
      paragraph(run('Justified', ' sz="2000"'), '<a:pPr algn="just"><a:spcBef><a:spcPct val="50000"/></a:spcBef></a:pPr>'),
      paragraph(run('Exact', ' sz="2000"'), '<a:pPr><a:lnSpc><a:spcPts val="3600"/></a:lnSpc></a:pPr>')
    ]
    const { slide, report } = await shapes(sp({ name: 'Text', textBox: true, props: xfrm(0, 0, 400, 300), bodyPr: '<a:bodyPr wrap="none" lIns="0" tIns="12700" rIns="25400" bIns="0" anchor="ctr"><a:spAutoFit/></a:bodyPr>', text: paragraphs.join('') }))
    const body = named<TextElement>(slide, 'Text').body

    expect(body.paragraphs.map(({ runs, ...rest }) => rest)).toEqual([{ align: 'center', lineSpacing: 1.5, spaceBefore: 6, spaceAfter: 12 }, { align: 'right' }, { align: 'justify', spaceBefore: 10 }, { lineSpacing: 1.5 }])
    expect(body).toMatchObject({ anchor: 'middle', inset: [0, 1, 2, 0], fit: 'grow', wrap: false })
    expect(report.reasons).toEqual({ 'exact line spacing shown as a multiple': 1 })
  })

  it('notes text Herald shows differently, once per text box with every reason', async () => {
    const shadow = `<a:effectLst><a:outerShdw blurRad="38100" dist="38100" dir="2700000">${srgb('000000')}</a:outerShdw></a:effectLst>`
    const text = paragraph(run('Link', '', '<a:hlinkClick r:id="rIdLink"/>') + run(' up', ' baseline="30000"') + run(' loud', ' cap="all"') + run(' shadowed', '', shadow))
    const { slide, report } = await shapes(sp({ name: 'Odd', textBox: true, props: xfrm(0, 0, 100, 100), bodyPr: '<a:bodyPr vert="vert270" numCol="2"/>', text }), {
      slides: [{ rels: [['rIdLink', 'hyperlink', 'https://example.com', true]] }]
    })

    expect(named<TextElement>(slide, 'Odd').body.paragraphs[0].runs.map((entry) => entry.text).join('')).toBe('Link up LOUD shadowed')
    expect(report.counts.text).toEqual({ imported: 0, approximated: 1, skipped: 0 })
    expect(report.reasons).toEqual({
      'links kept as plain text': 1,
      'superscript and subscript shown as ordinary text': 1,
      'all caps kept as capital letters': 1,
      'shadows and other effects left out': 1,
      'vertical text shown horizontally': 1,
      'text in columns shown as one column': 1
    })
  })
})

describe('importPresentation: placeholders', () => {
  it('gives placeholders the position, size, colour and look their layout and master lend them', async () => {
    const { deck, report } = await open({
      slides: [
        { layout: 1, shapes: sp({ name: 'Title', ph: '<p:ph type="ctrTitle"/>', text: paragraph(run('Welcome')) }) + sp({ id: 3, name: 'Subtitle', ph: '<p:ph type="subTitle" idx="1"/>', text: paragraph(run('A subtitle')) }) },
        {
          layout: 2,
          shapes:
            sp({ name: 'Title', ph: '<p:ph type="title"/>', text: paragraph(run('Agenda')) }) +
            sp({ id: 3, name: 'Body', ph: '<p:ph idx="1"/>', text: paragraph(run('First point')) + paragraph(run('Second'), '<a:pPr lvl="1"/>') }) +
            sp({ id: 4, name: 'Number', ph: '<p:ph type="sldNum" sz="quarter" idx="12"/>', text: paragraph('<a:fld id="{1}" type="slidenum"><a:rPr lang="en-GB"/><a:t>‹#›</a:t></a:fld>') })
        }
      ]
    })
    const [first, second] = deck.slides
    const title = named<TextElement>(first, 'Title')
    const subtitle = named<TextElement>(first, 'Subtitle')
    const agenda = named<TextElement>(second, 'Title')
    const body = named<TextElement>(second, 'Body')
    const number = named<TextElement>(second, 'Number')

    expect(title).toMatchObject({ x: 120, y: 160, width: 720, height: 120, placeholder: { role: 'title', prompt: 'Click to add title' } })
    expect(title.body).toMatchObject({ style: { font: '+heading', size: 60, color: 'tx1' }, anchor: 'bottom', paragraphs: [{ align: 'center', lineSpacing: 0.9, runs: [{ text: 'Welcome' }] }] })
    expect(subtitle).toMatchObject({ x: 120, y: 290, width: 720, height: 80, placeholder: { role: 'subtitle' } })
    expect(subtitle.body).toMatchObject({ style: { font: '+body', size: 24, color: 'tx2' }, fit: 'shrink', paragraphs: [{ align: 'center', spaceBefore: 10, runs: [{ text: 'A subtitle' }] }] })
    expect(subtitle.body.paragraphs[0].list).toBeUndefined()

    expect(agenda).toMatchObject({ x: 60, y: 30, width: 840, height: 100, placeholder: { role: 'title' } })
    expect(agenda.body).toMatchObject({ style: { font: '+heading', size: 44, color: 'tx1' }, anchor: 'middle' })
    expect(body).toMatchObject({ x: 60, y: 140, width: 840, height: 340, placeholder: { role: 'body', prompt: 'Click to add text' } })
    expect(body.body).toMatchObject({
      style: { font: '+body', size: 28, color: 'tx1' },
      fit: 'shrink',
      paragraphs: [
        { list: 'bullet', spaceBefore: 10, margin: 18, indent: -18, runs: [{ text: 'First point' }] },
        { list: 'bullet', level: 1, bullet: '•', margin: 54, indent: -18, runs: [{ text: 'Second', size: 24 }] }
      ]
    })
    expect(number).toMatchObject({ x: 680, y: 500, body: { style: { size: 12 }, paragraphs: [{ align: 'right', runs: [{ text: '2' }] }] } })
    expect(number.placeholder).toBeUndefined()
    expect(counts(report)).toEqual({ text: { imported: 5, approximated: 0, skipped: 0 } })
  })

  it('lets a slide placeholder keep its own position and look over what it inherits', async () => {
    const { deck } = await open({
      slides: [{ shapes: sp({ name: 'Title', ph: '<p:ph type="title"/>', props: xfrm(10, 10, 200, 50), bodyPr: '<a:bodyPr anchor="t"/>', text: paragraph(run('Moved', ' sz="2000"', solid(scheme('accent2')))) }) }]
    })

    expect(named<TextElement>(deck.slides[0], 'Title')).toMatchObject({ x: 10, y: 10, width: 200, height: 50, body: { anchor: 'top', style: { size: 20, color: 'accent2', font: '+heading' } } })
  })

  it('keeps empty placeholders as prompts, a picture placeholder as an empty picture frame', async () => {
    const layouts: LayoutSpec[] = [
      {
        type: 'picTx',
        tree: tree(
          sp({ name: 'Title 1', ph: '<p:ph type="title"/>' }) +
            sp({ id: 3, name: 'Picture 2', ph: '<p:ph type="pic" idx="1"/>', props: xfrm(400, 50, 450, 400) }) +
            sp({ id: 4, name: 'Text 3', ph: '<p:ph type="body" sz="half" idx="2" hasCustomPrompt="1"/>', props: xfrm(60, 180, 300, 300), text: paragraph(run('Say what the picture shows')) })
        )
      }
    ]
    const empty = '<a:p><a:endParaRPr lang="en-GB"/></a:p>'
    const { deck } = await open({
      layouts,
      files: { 'ppt/media/image1.png': png(400, 200) },
      slides: [
        { layout: 1, shapes: sp({ name: 'Title', ph: '<p:ph type="title"/>', text: empty }) + sp({ id: 3, name: 'Picture', ph: '<p:ph type="pic" idx="1"/>' }) + sp({ id: 4, name: 'Caption', ph: '<p:ph type="body" sz="half" idx="2"/>', text: empty }) },
        { layout: 1, shapes: pic({ name: 'Photo', embed: 'rIdImage', nvPr: '<p:ph type="pic" idx="1"/>', props: '' }), rels: [['rIdImage', 'image', '../media/image1.png']] }
      ]
    })
    const slide = deck.slides[0]

    expect(slide.layout).toBe('picture-caption')
    expect(named<TextElement>(slide, 'Title')).toMatchObject({ kind: 'text', placeholder: { role: 'title', prompt: 'Click to add title' }, body: { paragraphs: [{ runs: [{ text: '' }] }] } })
    expect(named<ImageElement>(slide, 'Picture')).toMatchObject({ kind: 'image', src: '', natural: { width: 0, height: 0 }, x: 400, y: 50, width: 450, height: 400, placeholder: { role: 'picture', prompt: 'Click to add a picture' } })
    expect(named<TextElement>(slide, 'Caption')).toMatchObject({ placeholder: { role: 'caption', prompt: 'Say what the picture shows' } })
    expect(named<ImageElement>(deck.slides[1], 'Photo')).toMatchObject({ kind: 'image', x: 400, y: 50, width: 450, height: 400, natural: { width: 400, height: 200 }, placeholder: { role: 'picture' } })
  })

  it('draws the shapes of the master and layout behind those of each slide, counted once', async () => {
    const logo = sp({ id: 10, name: 'Logo', props: xfrm(880, 10, 60, 30) + geometry('ellipse') + solid(scheme('accent1')) })
    const numberBox = sp({ id: 11, name: 'Page', textBox: true, props: xfrm(900, 510, 50, 20), text: paragraph('<a:fld id="{2}" type="slidenum"><a:rPr lang="en-GB"/><a:t>‹#›</a:t></a:fld>') })
    const rule = sp({ id: 12, name: 'Rule', props: xfrm(60, 132, 840, 0) + geometry('line') + line(1, scheme('accent2')) })
    const { deck, report } = await open({
      master: { shapes: logo + numberBox },
      layouts: [{ type: 'obj', tree: tree(sp({ name: 'Title 1', ph: '<p:ph type="title"/>' }) + rule) }],
      slides: [{ layout: 1, shapes: sp({ name: 'Own', textBox: true, props: xfrm(0, 0, 10, 10), text: paragraph(run('Mine')) }) }, { layout: 1 }, { layout: 1, attrs: ' showMasterSp="0"' }]
    })

    expect(deck.slides[0].elements.map((element) => element.name)).toEqual(['Logo', 'Page', 'Rule', 'Own'])
    expect(deck.slides[1].elements.map((element) => element.name)).toEqual(['Logo', 'Page', 'Rule'])
    expect(deck.slides[2].elements).toEqual([])
    expect(named<TextElement>(deck.slides[1], 'Page').body.paragraphs[0].runs[0].text).toBe('2')
    expect(named<ShapeElement>(deck.slides[0], 'Logo')).toMatchObject({ kind: 'shape', shape: 'ellipse', fill: { color: 'accent1' } })
    expect(deck.slides[0].elements[0].id).not.toBe(deck.slides[1].elements[0].id)
    expect(counts(report)).toEqual({ text: { imported: 2, approximated: 0, skipped: 0 }, shape: { imported: 1, approximated: 0, skipped: 0 }, line: { imported: 1, approximated: 0, skipped: 0 } })
  })
})

describe('importPresentation: colours', () => {
  const fills = (slide: Slide) => Object.fromEntries(slide.elements.map((element) => [element.name, element.kind === 'shape' ? element.fill : null]))

  it('keeps theme colours as slots through the colour map, and makes the rest literal', async () => {
    const content = [
      filled('accent2', solid(scheme('accent2'))),
      filled('tx2', solid(scheme('tx2'))),
      filled('dk2', solid(scheme('dk2'))),
      filled('lt1', solid(scheme('lt1'))),
      filled('hlink', solid(scheme('hlink'))),
      filled('clear bg1', solid(scheme('bg1', '<a:alpha val="50000"/>'))),
      filled('preset', solid('<a:prstClr val="red"/>')),
      filled('system', solid('<a:sysClr val="windowText" lastClr="111111"/>')),
      filled('lighter', solid(scheme('accent1', '<a:lumMod val="60000"/><a:lumOff val="40000"/>'))),
      filled('darker', solid(scheme('accent1', '<a:lumMod val="75000"/>'))),
      filled('grey', solid(scheme('tx1', '<a:lumMod val="50000"/><a:lumOff val="50000"/>'))),
      filled('shaded', solid(scheme('bg1', '<a:lumMod val="85000"/>'))),
      filled('unchanged', solid(scheme('accent3', '<a:lumMod val="100000"/>')))
    ].join('')
    const { slide } = await shapes(content)

    expect(fills(slide)).toEqual({
      accent2: { color: 'accent2' },
      tx2: { color: 'tx2' },
      dk2: { color: 'tx2' },
      lt1: { color: 'bg1' },
      hlink: { color: '#0563c1' },
      'clear bg1': { color: 'bg1', alpha: 0.5 },
      preset: { color: '#ff0000' },
      system: { color: '#111111' },
      lighter: { color: '#8faadc' },
      darker: { color: '#2f5597' },
      grey: { color: '#808080' },
      shaded: { color: '#d9d9d9' },
      unchanged: { color: 'accent3' }
    })
  })

  it('keeps the colours and fonts of a master with another theme as they look', async () => {
    const content = filled('Accent', solid(scheme('accent1'))) + sp({ id: 3, name: 'Words', textBox: true, props: xfrm(0, 0, 100, 50), text: paragraph(run('Hello')) })
    const { deck } = await open({
      files: {
        'ppt/theme/theme2.xml': themeXml('Other', ['Impact', 'Tahoma'], { ...SCHEME, accent1: 'FF00FF' }),
        'ppt/slideMasters/slideMaster2.xml': masterXml(),
        'ppt/slideMasters/_rels/slideMaster2.xml.rels': rels([['rIdLayout', 'slideLayout', '../slideLayouts/slideLayout9.xml'], ['rIdTheme', 'theme', '../theme/theme2.xml']]),
        'ppt/slideLayouts/slideLayout9.xml': layoutXml({ type: 'blank' }),
        'ppt/slideLayouts/_rels/slideLayout9.xml.rels': rels([['rIdMaster', 'slideMaster', '../slideMasters/slideMaster2.xml']])
      },
      slides: [
        { layout: 3, shapes: content },
        { layout: 9, shapes: content }
      ]
    })
    const [mine, theirs] = deck.slides

    expect(deck.theme.name).toBe('Test Theme')
    expect(named<ShapeElement>(mine, 'Accent').fill).toEqual({ color: 'accent1' })
    expect(named<TextElement>(mine, 'Words').body.style).toEqual({ font: '+body', size: 18, color: 'tx1' })
    expect(named<ShapeElement>(theirs, 'Accent').fill).toEqual({ color: '#ff00ff' })
    expect(named<TextElement>(theirs, 'Words').body.style).toEqual({ font: 'Tahoma', size: 18, color: '#000000' })
  })

  it('maps scheme colours onto the slots a dark colour map gives them', async () => {
    const content = [filled('dk1', solid(scheme('dk1'))), filled('lt1', solid(scheme('lt1'))), filled('tx1', solid(scheme('tx1'))), filled('bg2', solid(scheme('bg2')))].join('')
    const { slide } = await shapes(content, { master: { clrMap: colorMap(true) } })

    expect(fills(slide)).toEqual({ dk1: { color: 'bg1' }, lt1: { color: 'tx1' }, tx1: { color: 'tx1' }, bg2: { color: 'bg2' } })
  })

  it('resolves the colour map of a slide onto the slots of the deck theme, so a dark slide stays dark', async () => {
    const { slide } = await shapes(sp({ name: 'Text', textBox: true, props: xfrm(0, 0, 100, 50), text: paragraph(run('Light on dark')) }), {
      slides: [{ after: `<p:clrMapOvr>${colorMap(true, 'a:overrideClrMapping')}</p:clrMapOvr>` }]
    })

    expect(named<TextElement>(slide, 'Text').body.style.color).toBe('bg1')
    expect(slide.background).toEqual({ kind: 'solid', color: 'tx1' })
  })

  it('takes fills, outlines and text colour from the style references of a shape', async () => {
    const style = `<p:style><a:lnRef idx="2">${scheme('accent1', '<a:shade val="50000"/>')}</a:lnRef><a:fillRef idx="1">${scheme('accent1')}</a:fillRef><a:effectRef idx="0">${scheme('accent1')}</a:effectRef><a:fontRef idx="minor">${scheme('lt1')}</a:fontRef></p:style>`
    const { slide, report } = await shapes(
      sp({ name: 'Styled', props: xfrm(0, 0, 100, 50) + geometry('rect'), style, text: paragraph(run('Label'), '<a:pPr algn="ctr"/>'), bodyPr: '<a:bodyPr anchor="ctr"/>' }) +
        sp({ id: 3, name: 'Shadowed', props: xfrm(0, 0, 100, 50) + geometry('ellipse'), style: style.replace('a:effectRef idx="0"', 'a:effectRef idx="3"').replace('a:fillRef idx="1"', 'a:fillRef idx="3"') }) +
        sp({ id: 4, name: 'Gradient', props: xfrm(0, 0, 100, 50) + geometry('ellipse'), style: style.replace('a:fillRef idx="1"', 'a:fillRef idx="2"') })
    )

    expect(named<ShapeElement>(slide, 'Styled')).toMatchObject({ kind: 'shape', shape: 'rect', fill: { color: 'accent1' }, stroke: { color: '#2f528f', width: 1, dash: 'solid' }, body: { anchor: 'middle', style: { color: 'bg1', font: '+body' } } })
    expect(named<ShapeElement>(slide, 'Shadowed').fill).toEqual({ color: '#2f528f' })
    expect(named<ShapeElement>(slide, 'Gradient').fill?.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(report.reasons).toEqual({ 'shadows and other effects left out': 1, 'gradient fills shown as a solid colour': 1 })
  })

  it('reads colour elements and their modifiers', () => {
    const palette: Palette = { scheme: OFFICE_SCHEME, map: STANDARD_MAP, slots: { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2', accent1: 'accent1', accent2: 'accent2', accent3: 'accent3', accent4: 'accent4', accent5: 'accent5', accent6: 'accent6' } }
    const color = (inner: string, placeholder: Paint | null = null) => colorIn(parseXml(`<a:solidFill xmlns:a="${A}">${inner}</a:solidFill>`), palette, placeholder)

    expect(color(srgb('ABCDEF'))).toEqual({ color: '#abcdef', alpha: 1 })
    expect(color('<a:scrgbClr r="100000" g="50000" b="0"/>')).toEqual({ color: '#ffbc00', alpha: 1 })
    expect(color('<a:hslClr hue="7200000" sat="100000" lum="50000"/>')).toEqual({ color: '#00ff00', alpha: 1 })
    expect(color('<a:prstClr val="navy"/>')?.color).toBe('#000080')
    expect(color('<a:sysClr val="window"/>')?.color).toBe('#ffffff')
    expect(color(srgb('FF0000', '<a:comp/>'))?.color).toBe('#00ffff')
    expect(color(srgb('FF0000', '<a:inv/>'))?.color).toBe('#00ffff')
    expect(color(srgb('FF0000', '<a:gray/>'))?.color).toBe('#4d4d4d')
    expect(color(srgb('FF0000', '<a:tint val="0"/>'))?.color).toBe('#ffffff')
    expect(color(scheme('accent1', '<a:shade val="50000"/>'))?.color).toBe('#2f528f')
    expect(color(scheme('accent1', '<a:alpha val="50000"/><a:alphaMod val="50000"/>'))).toEqual({ color: 'accent1', alpha: 0.25 })
    expect(color(scheme('phClr', '<a:lumMod val="75000"/>'), { color: 'accent1', alpha: 1 })?.color).toBe('#2f5597')
    expect(color(scheme('phClr'), { color: 'accent2', alpha: 0.5 })).toEqual({ color: 'accent2', alpha: 0.5 })
    expect(color(scheme('phClr'))).toBeNull()
    expect(color('<a:srgbClr val="nonsense"/>')).toBeNull()
    expect(colorIn(parseXml(`<a:solidFill xmlns:a="${A}">${scheme('accent1')}</a:solidFill>`), { ...palette, slots: null })?.color).toBe('#4472c4')
  })
})

describe('importPresentation: shapes and lines', () => {
  it('keeps shapes with their fills, outlines, dashes, rotation, flips and adjust values', async () => {
    const content = [
      sp({ name: 'Rounded', props: xfrm(10, 20, 200, 100, ' rot="2700000"') + geometry('roundRect', '<a:gd name="adj" fmla="val 25000"/>') + solid(srgb('FF0000', '<a:alpha val="50000"/>')) + line(2, srgb('0000FF'), '<a:prstDash val="sysDot"/>') }),
      sp({ name: 'Oval', props: xfrm(0, 0, 50, 50, ' flipV="1" rot="-5400000"') + geometry('ellipse') + solid(srgb('00FF00')) + line(1, srgb('000000'), '<a:prstDash val="lgDash"/>') }),
      sp({ name: 'Arrow', props: xfrm(0, 0, 50, 50) + geometry('rightArrow') + solid(srgb('00FF00')) + line(1, srgb('000000'), '<a:prstDash val="lgDashDot"/>') })
    ].join('')
    const { slide, report } = await shapes(content)

    expect(named<ShapeElement>(slide, 'Rounded')).toMatchObject({
      kind: 'shape',
      shape: 'roundRect',
      adjust: { adj: 25000 },
      x: 10,
      y: 20,
      width: 200,
      height: 100,
      rotation: 45,
      fill: { color: '#ff0000', alpha: 0.5 },
      stroke: { color: '#0000ff', width: 2, dash: 'dot' }
    })
    expect(named<ShapeElement>(slide, 'Oval')).toMatchObject({ shape: 'ellipse', rotation: 270, flipV: true, stroke: { dash: 'longDash' } })
    expect(named<ShapeElement>(slide, 'Arrow')).toMatchObject({ shape: 'rightArrow', stroke: { dash: 'dashDot' } })
    expect(named<ShapeElement>(slide, 'Arrow').adjust).toBeUndefined()
    expect(counts(report)).toEqual({ shape: { imported: 3, approximated: 0, skipped: 0 } })
  })

  it('shows presets Herald does not draw as the nearest it does, and custom shapes as rectangles', async () => {
    const content = [
      filled('Decision', solid(srgb('FF0000')), 'star16'),
      filled('Cube', solid(srgb('FF0000')), 'cube'),
      sp({ name: 'Custom', props: xfrm(0, 0, 50, 50) + '<a:custGeom><a:pathLst><a:path w="10" h="10"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="10" y="10"/></a:lnTo></a:path></a:pathLst></a:custGeom>' + solid(srgb('FF0000')) }),
      sp({ name: 'Invisible', props: xfrm(0, 0, 50, 50) + '<a:custGeom/>', text: paragraph(run('Just text')) })
    ].join('')
    const { slide, report } = await shapes(content)

    expect(named<ShapeElement>(slide, 'Decision').shape).toBe('star5')
    expect(named<ShapeElement>(slide, 'Cube').shape).toBe('cube')
    expect(named<ShapeElement>(slide, 'Custom').shape).toBe('rect')
    expect(named(slide, 'Invisible').kind).toBe('text')
    expect(counts(report)).toEqual({ text: { imported: 1, approximated: 0, skipped: 0 }, shape: { imported: 1, approximated: 2, skipped: 0 } })
    expect(report.reasons).toEqual({ 'shapes Herald does not draw shown as the nearest shape it does': 1, 'custom shapes drawn as rectangles': 1 })
  })

  it('reads lines with arrowheads and flips, folding rotation into their ends', async () => {
    const content = [
      connector(xfrm(100, 100, 200, 50, ' flipH="1"') + geometry('straightConnector1') + line(1.5, srgb('333333'), '<a:headEnd type="triangle"/><a:tailEnd type="oval" w="lg"/>'), '', 'Arrow'),
      sp({ name: 'Turned', props: xfrm(100, 200, 100, 0, ' rot="5400000"') + geometry('line') + line(1, srgb('000000')) }),
      connector(xfrm(0, 0, 50, 50) + geometry('bentConnector3'), `<p:style><a:lnRef idx="1">${scheme('accent1')}</a:lnRef><a:fillRef idx="0">${scheme('accent1')}</a:fillRef><a:effectRef idx="0">${scheme('accent1')}</a:effectRef><a:fontRef idx="minor">${scheme('tx1')}</a:fontRef></p:style>`, 'Bent'),
      connector(xfrm(0, 0, 50, 0) + geometry('line'), '', 'Unseen')
    ].join('')
    const { slide, report } = await shapes(content)

    expect(named<LineElement>(slide, 'Arrow')).toMatchObject({ kind: 'line', x: 100, y: 100, width: 200, height: 50, flipH: true, flipV: false, rotation: 0, start: 'triangle', end: 'oval', stroke: { color: '#333333', width: 1.5, dash: 'solid' } })
    expect(named<LineElement>(slide, 'Turned')).toMatchObject({ x: 150, y: 150, width: 0, height: 100, flipH: false, flipV: false, rotation: 0 })
    expect(named<LineElement>(slide, 'Bent')).toMatchObject({ start: 'none', end: 'none', stroke: { color: 'accent1', width: 0.5 } })
    expect(named<LineElement>(slide, 'Unseen').stroke.alpha).toBe(0)
    expect(counts(report)).toEqual({ line: { imported: 3, approximated: 1, skipped: 0 } })
    expect(report.reasons).toEqual({ 'connectors drawn straight': 1 })
  })

  it('flattens groups, placing members from the coordinates of their group', async () => {
    const member = (name: string, x: number, y: number, width: number, height: number, attrs = '') => sp({ name, props: xfrm(x, y, width, height, attrs) + geometry('rect') + solid(srgb('FF0000')) })
    const inner = group([0, 100, 200, 100], [0, 0, 100, 50], member('C', 0, 0, 50, 50), '', 'Inner')
    const content = [
      group([100, 100, 200, 100], [0, 0, 400, 200], member('A', 0, 0, 200, 100) + member('B', 200, 100, 200, 100) + inner, '', 'Outer'),
      group([100, 100, 200, 100], [100, 100, 200, 100], member('Turned', 100, 100, 100, 100), ' rot="5400000"', 'Turning'),
      group([100, 100, 200, 100], [100, 100, 200, 100], member('Mirrored', 100, 100, 100, 100, ' rot="1800000"'), ' flipH="1"', 'Mirror')
    ].join('')
    const { slide, report } = await shapes(content)
    const box = (name: string) => {
      const element = named(slide, name)

      return [element.x, element.y, element.width, element.height, element.rotation, element.flipH ?? false]
    }

    expect(slide.elements.map((element) => element.name)).toEqual(['A', 'B', 'C', 'Turned', 'Mirrored'])
    expect(box('A')).toEqual([100, 100, 100, 50, 0, false])
    expect(box('B')).toEqual([200, 150, 100, 50, 0, false])
    expect(box('C')).toEqual([100, 150, 50, 50, 0, false])
    expect(box('Turned')).toEqual([150, 50, 100, 100, 90, false])
    expect(box('Mirrored')).toEqual([200, 100, 100, 100, 330, true])
    expect(counts(report)).toEqual({ shape: { imported: 5, approximated: 0, skipped: 0 }, group: { imported: 0, approximated: 4, skipped: 0 } })
    expect(report.reasons).toEqual({ 'grouped elements kept as separate elements': 4 })
  })

  it('gives members a group fill from their group', async () => {
    const member = sp({ name: 'Member', props: xfrm(0, 0, 50, 50) + geometry('ellipse') + '<a:grpFill/>' })
    const { slide } = await shapes(group([0, 0, 100, 100], [0, 0, 100, 100], member, '', 'Filled', solid(srgb('123456'))))

    expect(named<ShapeElement>(slide, 'Member').fill).toEqual({ color: '#123456' })
  })
})

describe('importPresentation: pictures and media', () => {
  const media: Rel[] = [
    ['rIdImage', 'image', '../media/image1.png'],
    ['rIdEmf', 'image', '../media/image2.emf'],
    ['rIdGone', 'image', '../media/missing.png'],
    ['rIdVideo', 'video', '../media/movie.mp4'],
    ['rIdMedia', 'http://schemas.microsoft.com/office/2007/relationships/media', '../media/movie.mp4'],
    ['rIdSound', 'audio', '../media/sound.mp3'],
    ['rIdOnline', 'image', 'https://example.com/picture.png', true]
  ]
  const files = { 'ppt/media/image1.png': png(400, 200), 'ppt/media/image2.emf': new Uint8Array([1, 0, 0, 0, 108, 0, 0, 0]), 'ppt/media/movie.mp4': new Uint8Array(16), 'ppt/media/sound.mp3': new Uint8Array(16) }

  it('reads a picture with its crop, alt text, outline and natural size', async () => {
    const { slide, report } = await shapes(pic({ name: 'Chart', embed: 'rIdImage', descr: 'A chart of sales', fill: '<a:srcRect l="10000" r="20000" b="5000"/><a:stretch><a:fillRect/></a:stretch>', props: xfrm(30, 40, 320, 190) + geometry('rect') + line(1, srgb('000000')) }), {
      files,
      slides: [{ rels: media }]
    })
    const picture = named<ImageElement>(slide, 'Chart')

    expect(picture).toMatchObject({ kind: 'image', x: 30, y: 40, width: 320, height: 190, natural: { width: 400, height: 200 }, alt: 'A chart of sales', crop: { left: 0.1, top: 0, right: 0.2, bottom: 0.05 }, stroke: { color: '#000000', width: 1 } })
    expect(picture.src.startsWith('data:image/png;base64,iVBORw0KGgo')).toBe(true)
    expect(counts(report)).toEqual({ picture: { imported: 1, approximated: 0, skipped: 0 } })
  })

  it('leaves out pictures it cannot show, and approximates shaped, inset and tiled ones', async () => {
    const content = [
      pic({ name: 'Emf', embed: 'rIdEmf' }),
      pic({ name: 'Gone', embed: 'rIdGone' }),
      pic({ name: 'Online', embed: 'rIdOnline' }),
      pic({ name: 'Round', embed: 'rIdImage', props: xfrm(0, 0, 50, 50) + geometry('ellipse') }),
      pic({ name: 'Inset', embed: 'rIdImage', fill: '<a:srcRect l="-10000" t="-10000"/><a:stretch/>' }),
      pic({ name: 'Tiled', embed: 'rIdImage', fill: '<a:tile/>' })
    ].join('')
    const { slide, report } = await shapes(content, { files, slides: [{ rels: media }] })

    expect(slide.elements.map((element) => element.name)).toEqual(['Round', 'Inset', 'Tiled'])
    expect(named<ImageElement>(slide, 'Inset').crop).toBeUndefined()
    expect(counts(report)).toEqual({ picture: { imported: 0, approximated: 3, skipped: 3 } })
    expect(report.reasons).toEqual({
      'pictures in formats Herald cannot show': 1,
      'pictures missing from the file left out': 1,
      'pictures linked from outside the file left out': 1,
      'pictures cut to shapes shown as rectangles': 1,
      'pictures inset in their frames shown filling them': 1,
      'tiled pictures shown stretched': 1
    })
  })

  it('uses the PNG an SVG picture carries, and finds media whose names are escaped', async () => {
    const svg = '<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rIdSvg"/></a:ext></a:extLst>'
    const { slide, report } = await shapes(pic({ name: 'Icon', embed: 'rIdImage', blip: svg }) + pic({ name: 'Spaced', embed: 'rIdSpaced' }), {
      files: { ...files, 'ppt/media/image 3.png': png(10, 20), 'ppt/media/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' },
      slides: [
        {
          rels: [...media, ['rIdSvg', 'image', '../media/icon.svg'], ['rIdSpaced', 'image', '../media/image%203.png']]
        }
      ]
    })

    expect(named<ImageElement>(slide, 'Icon').natural).toEqual({ width: 400, height: 200 })
    expect(named<ImageElement>(slide, 'Spaced').natural).toEqual({ width: 10, height: 20 })
    expect(counts(report)).toEqual({ picture: { imported: 2, approximated: 0, skipped: 0 } })
  })

  it('shows a video as its poster frame and leaves sounds out', async () => {
    const content = [
      pic({ name: 'Movie', embed: 'rIdImage', nvPr: `<a:videoFile r:link="rIdVideo"/><p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media ${MC} r:embed="rIdMedia"/></p:ext></p:extLst>` }),
      pic({ name: 'Sound', embed: 'rIdImage', nvPr: '<a:audioFile r:link="rIdSound"/>' })
    ].join('')
    const { slide, report } = await shapes(content, { files, slides: [{ rels: media }] })

    expect(slide.elements.map((element) => [element.name, element.kind])).toEqual([['Movie', 'image']])
    expect(counts(report)).toEqual({ video: { imported: 0, approximated: 1, skipped: 0 }, audio: { imported: 0, approximated: 0, skipped: 1 } })
    expect(report.reasons).toEqual({ 'videos shown as their poster frame': 1, 'sounds left out': 1 })
  })

  it('shows a picture-filled rectangle as the picture, its text on top', async () => {
    const fill = '<a:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>'
    const content = [sp({ name: 'Photo', props: xfrm(0, 0, 200, 100) + geometry('rect') + fill, text: paragraph(run('Caption')) }), sp({ name: 'Star', props: xfrm(0, 0, 100, 100) + geometry('star5') + fill })].join('')
    const { slide, report } = await shapes(content, { files, slides: [{ rels: media }] })

    expect(slide.elements.map((element) => [element.name, element.kind])).toEqual([
      ['Photo', 'image'],
      ['Photo', 'text'],
      ['Star', 'shape']
    ])
    expect(named<ShapeElement>(slide, 'Star').fill).toEqual({ color: 'accent1' })
    expect(counts(report)).toEqual({ shape: { imported: 0, approximated: 2, skipped: 0 } })
    expect(report.reasons).toEqual({ 'shapes filled with a picture shown as the picture': 1, 'picture fills shown as a colour': 1 })
  })

  it('takes the fallback of a markup choice, and shows an embedded object as its picture', async () => {
    const fallback = `<mc:AlternateContent ${MC}><mc:Choice Requires="p14"><p:contentPart r:id="rIdInk"/></mc:Choice><mc:Fallback>${pic({ name: 'Ink picture', embed: 'rIdImage' })}</mc:Fallback></mc:AlternateContent>`
    const ole = frame(
      'http://schemas.openxmlformats.org/presentationml/2006/ole',
      `<mc:AlternateContent ${MC}><mc:Choice Requires="v"><p:oleObj spid="_x0000_s1026" name="Worksheet" r:id="rIdObject"/></mc:Choice><mc:Fallback><p:oleObj name="Worksheet" r:id="rIdObject"><p:embed/>${pic({ name: 'Preview', embed: 'rIdImage' })}</p:oleObj></mc:Fallback></mc:AlternateContent>`,
      'Worksheet'
    )
    const { slide, report } = await shapes(fallback + ole, { files, slides: [{ rels: media }] })

    expect(slide.elements.map((element) => element.name)).toEqual(['Ink picture', 'Worksheet'])
    expect(named<ImageElement>(slide, 'Worksheet')).toMatchObject({ x: 50, y: 60, width: 200, height: 100 })
    expect(counts(report)).toEqual({ picture: { imported: 1, approximated: 0, skipped: 0 }, ole: { imported: 0, approximated: 1, skipped: 0 } })
  })
})

describe('importPresentation: backgrounds', () => {
  it('reads solid, gradient and picture backgrounds, inheriting from the layout and master', async () => {
    const picture = (embed: string) => `<p:bg><p:bgPr><a:blipFill><a:blip r:embed="${embed}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`
    const { deck, report } = await open({
      files: { 'ppt/media/wide.png': png(1920, 1080), 'ppt/media/square.png': png(400, 400) },
      slides: [
        { bg: `<p:bg><p:bgPr>${solid(srgb('112233'))}<a:effectLst/></p:bgPr></p:bg>` },
        { bg: `<p:bg><p:bgPr><a:gradFill><a:gsLst><a:gs pos="100000">${scheme('accent1')}</a:gs><a:gs pos="0">${srgb('FFFFFF')}</a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:effectLst/></p:bgPr></p:bg>` },
        { bg: picture('rIdWide'), rels: [['rIdWide', 'image', '../media/wide.png']] },
        { bg: picture('rIdSquare'), rels: [['rIdSquare', 'image', '../media/square.png']] },
        {},
        { bg: `<p:bg><p:bgRef idx="1003">${scheme('accent1')}</p:bgRef></p:bg>` },
        { bg: `<p:bg><p:bgPr>${solid(scheme('bg1'))}</p:bgPr></p:bg>` }
      ]
    })
    const backgrounds = deck.slides.map((slide) => slide.background)

    expect(backgrounds[0]).toEqual({ kind: 'solid', color: '#112233' })
    expect(backgrounds[1]).toEqual({ kind: 'gradient', angle: 90, stops: [{ at: 0, color: '#ffffff' }, { at: 1, color: 'accent1' }] })
    expect(backgrounds[2]).toMatchObject({ kind: 'image', natural: { width: 1920, height: 1080 } })
    expect(backgrounds[3]).toMatchObject({ kind: 'image', natural: { width: 400, height: 400 } })
    expect(backgrounds[4]).toBeNull()
    expect(backgrounds[5]).toEqual({ kind: 'gradient', angle: 0, stops: [{ at: 0, color: 'accent1' }, { at: 1, color: '#000000' }] })
    expect(backgrounds[6]).toBeNull()
    expect(report.reasons).toEqual({ 'background pictures fill the slide without stretching': 1 })
  })
})

const TABLE = 'http://schemas.openxmlformats.org/drawingml/2006/table'

/** A table cell: its text, its own attributes (merging) and its properties. */
const tc = (text: string, attrs = '', props = '<a:tcPr/>'): string => `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/>${text ? paragraph(run(text)) : '<a:p/>'}</a:txBody>${props}</a:tc>`

/** A table in a frame at (50, 60), 200 by 100: grid column widths, then each row's height and cells. */
const tableFrame = (grid: readonly number[], rows: readonly [number, string][], tblPr = '<a:tblPr/>', name = 'Table'): string =>
  frame(TABLE, `<a:tbl>${tblPr}<a:tblGrid>${grid.map((width) => `<a:gridCol w="${emu(width)}"/>`).join('')}</a:tblGrid>${rows.map(([height, cells]) => `<a:tr h="${emu(height)}">${cells}</a:tr>`).join('')}</a:tbl>`, name)

const sides = (color: string, width = 1): string => ['a:lnL', 'a:lnR', 'a:lnT', 'a:lnB'].map((side) => `<${side} w="${emu(width)}">${solid(srgb(color))}</${side}>`).join('')

const tableTexts = (table: TableElement) => table.cells.map((row) => row.map((cell) => (cell.merged ? '·' : plainText(cell.body))))

describe('importPresentation: tables', () => {
  it('reads a table’s grid, rows, merged cells, text, fills and lines', async () => {
    const lines = sides('000000')
    const content = tableFrame(
      [80, 120],
      [
        [40, tc('Name', ' gridSpan="2"', `<a:tcPr marL="0" anchor="ctr">${lines}${solid(srgb('FF0000'))}</a:tcPr>`) + tc('', ' hMerge="1"', `<a:tcPr>${lines}</a:tcPr>`)],
        [30, tc('Oslo', ' rowSpan="2"', `<a:tcPr>${lines}<a:noFill/></a:tcPr>`) + tc('12', '', `<a:tcPr>${lines}${solid(scheme('accent2'))}</a:tcPr>`)],
        [30, tc('', ' vMerge="1"', `<a:tcPr>${lines}</a:tcPr>`) + tc('8', '', `<a:tcPr>${lines}</a:tcPr>`)]
      ]
    )
    const { slide, report } = await shapes(content)
    const table = named<TableElement>(slide, 'Table')

    expect(table).toMatchObject({ kind: 'table', x: 50, y: 60, width: 200, height: 100, rotation: 0, columns: [80, 120], rows: [40, 30, 30], stroke: { color: '#000000', width: 1, dash: 'solid' } })
    expect(tableTexts(table)).toEqual([
      ['Name', '·'],
      ['Oslo', '12'],
      ['·', '8']
    ])
    expect(table.cells.map((row) => row.map((cell) => (cell.merged ? '·' : `${cell.colSpan ?? 1}x${cell.rowSpan ?? 1}`)))).toEqual([
      ['2x1', '·'],
      ['1x2', '1x1'],
      ['·', '1x1']
    ])
    expect(table.cells[0][0]).toMatchObject({ fill: { color: '#ff0000' }, body: { anchor: 'middle', inset: [0, 3.6, 7.2, 3.6] } })
    expect([table.cells[1][0].fill, table.cells[1][1].fill, table.cells[2][1].fill]).toEqual([null, { color: 'accent2' }, null])
    expect(counts(report)).toEqual({ table: { imported: 1, approximated: 0, skipped: 0 } })
  })

  it('works a table style in the file out into each cell’s fill and text, its lines into the table’s', async () => {
    const id = '{11111111-2222-3333-4444-555555555555}'
    const styles = `${HEADER}<a:tblStyleLst xmlns:a="${A}" def="${id}"><a:tblStyle styleId="${id}" styleName="Mine"><a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"/>${scheme('dk1')}</a:tcTxStyle><a:tcStyle><a:tcBdr><a:insideH>${line(2, srgb('00FF00'))}</a:insideH></a:tcBdr><a:fill>${solid(srgb('EEEEEE'))}</a:fill></a:tcStyle></a:wholeTbl><a:band1H><a:tcStyle><a:fill>${solid(srgb('CCCCCC'))}</a:fill></a:tcStyle></a:band1H><a:firstRow><a:tcTxStyle b="on">${scheme('lt1')}</a:tcTxStyle><a:tcStyle><a:fill>${solid(scheme('accent2'))}</a:fill></a:tcStyle></a:firstRow></a:tblStyle></a:tblStyleLst>`
    const rows: [number, string][] = ['Head', 'One', 'Two', 'Three'].map((text) => [25, tc(text)])
    const { slide, report } = await shapes(tableFrame([200], rows, `<a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>${id}</a:tableStyleId></a:tblPr>`), {
      files: { 'ppt/tableStyles.xml': styles },
      presentationRels: [['rIdStyles', 'tableStyles', 'tableStyles.xml']]
    })
    const table = named<TableElement>(slide, 'Table')

    expect(table.cells.map(([cell]) => cell.fill?.color)).toEqual(['accent2', '#cccccc', '#eeeeee', '#cccccc'])
    expect(table.cells[0][0].body.style).toMatchObject({ color: 'bg1', bold: true })
    expect(table.cells[1][0].body.style).toMatchObject({ color: 'tx1' })
    expect(table.cells[1][0].body.style.bold).toBeFalsy()
    expect(table.stroke).toEqual({ color: '#00ff00', width: 2, dash: 'solid' })
    expect(counts(report)).toEqual({ table: { imported: 1, approximated: 0, skipped: 0 } })
  })

  it('shows PowerPoint’s default style when the file names it without holding it, and reports what it simplifies', async () => {
    const styled = (id: string, name: string) => tableFrame([100, 100], [[40, tc('A') + tc('B')], [30, tc('1') + tc('2')], [30, tc('3') + tc('4')]], `<a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>${id}</a:tableStyleId></a:tblPr>`, name)
    const turned = tableFrame([200], [[100, tc('Up')]], '<a:tblPr/>', 'Turned').replace('<p:xfrm>', '<p:xfrm rot="5400000">')
    const { slide, report } = await shapes(styled('{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}', 'Default') + styled('{00000000-0000-0000-0000-000000000000}', 'Unknown') + turned)
    const table = named<TableElement>(slide, 'Default')
    const fills = table.cells.map((row) => row[0].fill?.color)

    expect(fills[0]).toBe('accent1')
    expect(fills.slice(1).every((color) => /^#[0-9a-f]{6}$/.test(color ?? ''))).toBe(true)
    expect(new Set(fills).size).toBe(3)
    expect(table.cells[0][0].body.style).toMatchObject({ color: 'bg1', bold: true })
    expect(table.stroke).toEqual({ color: 'bg1', width: 1, dash: 'solid' })
    expect(named<TableElement>(slide, 'Turned').rotation).toBe(0)
    expect(counts(report)).toEqual({ table: { imported: 0, approximated: 3, skipped: 0 } })
    expect(report.reasons).toEqual({ 'table borders shown as one kind of line for the whole table': 2, 'table styles not in the file shown as the default table style': 1, 'turned tables shown upright': 1 })
  })
})

describe('importPresentation: what Herald leaves out', () => {
  it('counts charts, SmartArt, ink, hidden objects and tables without cells as left out', async () => {
    const content = [
      frame('http://schemas.openxmlformats.org/drawingml/2006/table', '<a:tbl/>'),
      frame('http://schemas.openxmlformats.org/drawingml/2006/chart', '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdChart"/>'),
      frame('http://schemas.openxmlformats.org/drawingml/2006/diagram', '<dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rId1" r:lo="rId2" r:qs="rId3" r:cs="rId4"/>'),
      frame('http://schemas.openxmlformats.org/presentationml/2006/ole', '<p:oleObj name="Object" r:id="rIdObject"><p:embed/></p:oleObj>'),
      frame('http://schemas.microsoft.com/office/drawing/2010/slicer'),
      '<p:contentPart r:id="rIdInk"/>',
      sp({ name: 'Hidden', hidden: true, props: xfrm(0, 0, 10, 10) + geometry('rect') + solid(srgb('FF0000')) }),
      group([0, 0, 10, 10], [0, 0, 10, 10], filled('Inside', solid(srgb('FF0000')))).replace('name="Group"', 'name="Group" hidden="1"')
    ].join('')
    const { slide, report } = await shapes(content)

    expect(slide.elements).toEqual([])
    expect(counts(report)).toEqual({
      shape: { imported: 0, approximated: 0, skipped: 1 },
      group: { imported: 0, approximated: 0, skipped: 1 },
      table: { imported: 0, approximated: 0, skipped: 1 },
      chart: { imported: 0, approximated: 0, skipped: 1 },
      smartart: { imported: 0, approximated: 0, skipped: 1 },
      ole: { imported: 0, approximated: 0, skipped: 1 },
      ink: { imported: 0, approximated: 0, skipped: 1 },
      other: { imported: 0, approximated: 0, skipped: 1 }
    })
    expect(report.reasons).toEqual({ 'tables without cells left out': 1, 'hidden objects left out': 2 })
  })

  it('reports transitions, animations, timings, embedded fonts, macros, comments and sections', async () => {
    const timing = '<p:timing><p:tnLst><p:par><p:cTn id="1" nodeType="tmRoot"><p:childTnLst><p:seq><p:cTn id="2" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3" presetClass="entr"><p:childTnLst><p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="4" dur="500"/><p:tgtEl><p:spTgt spid="2"/></p:tgtEl></p:cBhvr></p:animEffect></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'
    const vortex = `<mc:AlternateContent ${MC}><mc:Choice Requires="p14"><p:transition spd="slow" p14:dur="2000"><p14:vortex dir="r"/></p:transition></mc:Choice><mc:Fallback><p:transition spd="slow"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>`
    const sections = `<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst ${MC}><p14:section name="One" id="{1}"><p14:sldIdLst><p14:sldId id="256"/></p14:sldIdLst></p14:section><p14:section name="Two" id="{2}"><p14:sldIdLst/></p14:section></p14:sectionLst></p:ext></p:extLst>`
    const fonts = '<p:embeddedFontLst><p:embeddedFont><p:font typeface="Lato"/><p:regular r:id="rIdFont1"/></p:embeddedFont><p:embeddedFont><p:font typeface="Lora"/><p:regular r:id="rIdFont2"/></p:embeddedFont></p:embeddedFontLst>'
    const shows = '<p:custShowLst><p:custShow name="Short" id="0"><p:sldLst><p:sld r:id="rIdSlide1"/></p:sldLst></p:custShow></p:custShowLst>'
    const { deck, report } = await open({
      presentation: fonts + shows + sections,
      files: { 'ppt/vbaProject.bin': new Uint8Array(8), 'ppt/comments/comment1.xml': `${HEADER}<p:cmLst ${NS}><p:cm authorId="0" idx="1"><p:pos x="10" y="10"/><p:text>One</p:text></p:cm><p:cm authorId="0" idx="2"><p:pos x="10" y="10"/><p:text>Two</p:text></p:cm></p:cmLst>` },
      slides: [
        { after: `${MASTER_MAPPING}<p:transition spd="med" advTm="3000"><p:fade/></p:transition>`, rels: [['rIdComments', 'comments', '../comments/comment1.xml']] },
        { after: `${MASTER_MAPPING}<p:transition><p:push dir="u"/></p:transition>${timing}` },
        { after: MASTER_MAPPING + vortex },
        {}
      ]
    })

    expect(deck.transition).toBe('fade')
    expect(report.dropped).toEqual({
      animations: 1,
      'transitions (Herald uses one transition for the whole deck)': 3,
      'automatic slide timings': 1,
      'embedded fonts': 2,
      macros: 1,
      comments: 2,
      sections: 2,
      'custom shows': 1
    })
  })

  it('keeps a transition every slide shares without reporting it', async () => {
    const fade = `${MASTER_MAPPING}<p:transition><p:fade/></p:transition>`
    const { deck, report } = await open({ slides: [{ after: fade }, { after: fade }] })

    expect(deck.transition).toBe('fade')
    expect(report.dropped).toEqual({})
  })

  it('reads a macro-enabled file the same way, noting its macros', async () => {
    const { deck, report } = await open({ contentTypes: '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>', slides: [{}] })

    expect(deck.slides).toHaveLength(1)
    expect(report.dropped).toEqual({ macros: 1 })
  })

  it('lists what it kept, approximated and left out as the fidelity notes', async () => {
    const content = [
      sp({ name: 'Kept', textBox: true, props: xfrm(0, 0, 10, 10), text: paragraph(run('Fine')) }),
      filled('Gradient', `<a:gradFill><a:gsLst><a:gs pos="0">${srgb('FF0000')}</a:gs><a:gs pos="100000">${srgb('0000FF')}</a:gs></a:gsLst></a:gradFill>`),
      filled('Pattern', `<a:pattFill prst="pct50"><a:fgClr>${srgb('FF0000')}</a:fgClr><a:bgClr>${srgb('FFFFFF')}</a:bgClr></a:pattFill>`),
      filled('Another gradient', `<a:gradFill><a:gsLst><a:gs pos="0">${srgb('FF0000')}</a:gs></a:gsLst></a:gradFill>`),
      frame('http://schemas.openxmlformats.org/drawingml/2006/table')
    ].join('')
    const { report } = await shapes(content, { presentation: '<p:embeddedFontLst><p:embeddedFont><p:font typeface="Lato"/></p:embeddedFont></p:embeddedFontLst>' })

    expect(reportNotes(report)).toEqual([
      'Kept 1 of 5 elements as they were.',
      'Shown approximately: 3 shapes.',
      'Left out: 1 table.',
      'Gradient fills shown as a solid colour (2).',
      'Pattern fills shown as a solid colour.',
      'Tables without cells left out.',
      'Not kept: embedded fonts.'
    ])
    expect(reportNotes((await shapes(sp({ name: 'Kept', textBox: true, props: xfrm(0, 0, 10, 10), text: paragraph(run('Fine')) }))).report)).toEqual([])
  })
})

describe('importPresentation: damaged files', () => {
  it('keeps going past slides, pictures and shapes it cannot read', async () => {
    const zip = build({
      slides: [{ shapes: filled('Good', solid(srgb('FF0000'))) }, {}, {}, { shapes: pic({ name: 'Missing', embed: 'rIdNothing' }) }]
    })
    zip.remove('ppt/slides/slide2.xml')
    zip.file('ppt/slides/slide3.xml', '<p:sld><p:cSld>')
    const { deck, report } = await importPresentation(zip, 'Damaged')

    expect(deck.slides).toHaveLength(4)
    expect(deck.slides.map((slide) => slide.elements.length)).toEqual([1, 0, 0, 0])
    expect(report.dropped).toEqual({ 'slides that could not be read': 2 })
    expect(counts(report)).toEqual({ shape: { imported: 1, approximated: 0, skipped: 0 }, picture: { imported: 0, approximated: 0, skipped: 1 } })
  })

  it('falls back on defaults for numbers that are not numbers', async () => {
    const { slide } = await shapes(sp({ name: 'Odd', props: '<a:xfrm rot="sideways"><a:off x="ten" y="20"/><a:ext cx="-5" cy="1270000"/></a:xfrm>' + geometry('rect') + solid(srgb('FF0000')), text: paragraph(run('Text', ' sz="big"')) }))

    expect(named<ShapeElement>(slide, 'Odd')).toMatchObject({ x: 0, y: 0, width: 0, height: 100, rotation: 0, body: { style: { size: 18 } } })
  })

  it('stops at groups nested too deeply', async () => {
    let nested = filled('Deep', solid(srgb('FF0000')))

    for (let depth = 0; depth < 40; depth++) {
      nested = group([0, 0, 100, 100], [0, 0, 100, 100], nested)
    }

    const { slide, report } = await shapes(nested)

    expect(slide.elements).toEqual([])
    expect(report.counts.group).toEqual({ imported: 0, approximated: 32, skipped: 1 })
    expect(report.reasons['groups nested too deeply left out']).toBe(1)
  })
})

describe('importPresentation: PptxGenJS decks', () => {
  async function generated(make: (pptx: PptxGenJS) => void): Promise<{ deck: Deck; report: ImportReport }> {
    const pptx = new PptxGenJS()
    make(pptx)
    const bytes = (await pptx.write({ outputType: 'uint8array' })) as Uint8Array

    return importPresentation(await JSZip.loadAsync(bytes), 'Generated')
  }

  it('reads the sizes of its layouts', async () => {
    const sizes: Deck['size'][] = []

    for (const layout of ['LAYOUT_WIDE', 'LAYOUT_16x9', 'LAYOUT_4x3']) {
      const { deck } = await generated((pptx) => {
        pptx.layout = layout
        pptx.addSlide()
      })
      sizes.push(deck.size)
    }

    expect(sizes).toEqual([
      { width: 960, height: 540 },
      { width: 720, height: 405 },
      { width: 720, height: 540 }
    ])
  })

  it('gives back the layouts and placeholder roles of a deck Herald wrote', async () => {
    const comparison = ['title', 'heading', 'body', 'heading2', 'body2']
    const section = ['title', 'subtitle']
    const master = (names: string[]) =>
      names.map((name, index) => ({ placeholder: { options: { name, type: index ? ('body' as const) : ('title' as const), x: 1, y: index + 0.5, w: 8, h: 0.8 }, text: 'Prompt' } }))
    const { deck } = await generated((pptx) => {
      pptx.defineSlideMaster({ title: 'Comparison', objects: master(comparison) })
      pptx.defineSlideMaster({ title: 'Section Header', objects: master(section) })
      const first = pptx.addSlide({ masterName: 'Comparison' })
      const second = pptx.addSlide({ masterName: 'Section Header' })

      for (const name of comparison) {
        first.addText(`Text for ${name}`, { placeholder: name })
      }

      for (const name of section) {
        second.addText(`Text for ${name}`, { placeholder: name })
      }
    })

    expect(deck.slides.map((slide) => slide.layout)).toEqual(['comparison', 'section'])
    expect(deck.slides.map((slide) => slide.elements.map((element) => element.placeholder?.role))).toEqual([
      ['title', 'heading', 'body', 'heading', 'body'],
      ['title', 'subtitle']
    ])
  })

  it('reads its text, lists, shapes, lines, pictures, notes, tables, charts and hidden slides', async () => {
    const { deck, report } = await generated((pptx) => {
      pptx.layout = 'LAYOUT_WIDE'
      const slide = pptx.addSlide()
      slide.background = { color: 'F1F1F1' }
      slide.addText('Hello world', { x: 1, y: 1, w: 4, h: 1, fontSize: 24, bold: true, italic: true, underline: { style: 'sng' }, color: 'FF0000', fontFace: 'Georgia', align: 'center', valign: 'middle' })
      slide.addText(
        [
          { text: 'First', options: { bullet: true } },
          { text: 'Second', options: { bullet: { type: 'number' }, indentLevel: 1 } },
          { text: 'Third', options: { bullet: { code: '25BA' } } }
        ],
        { x: 1, y: 2, w: 5, h: 2, lineSpacingMultiple: 1.5, paraSpaceAfter: 6 }
      )
      slide.addShape(pptx.ShapeType.roundRect, { x: 6, y: 1, w: 2, h: 1, fill: { color: '00FF00', transparency: 50 }, line: { color: '0000FF', width: 2, dashType: 'dash' }, rectRadius: 0.2, rotate: 45 })
      slide.addShape(pptx.ShapeType.line, { x: 6, y: 3, w: 2, h: 0, line: { color: '333333', width: 1, beginArrowType: 'triangle', endArrowType: 'oval' }, flipH: true })
      slide.addImage({ data: `image/png;base64,${btoa(String.fromCharCode(...DOT))}`, x: 9, y: 1, w: 1, h: 1, altText: 'A dot', sizing: { type: 'crop', w: 0.5, h: 0.5 } })
      slide.addNotes('Speaker notes')
      slide.addTable([[{ text: 'A' }, { text: 'B' }]], { x: 1, y: 5, w: 4 })
      slide.addChart(pptx.ChartType.bar, [{ name: 'Sales', labels: ['Q1', 'Q2'], values: [1, 2] }], { x: 6, y: 4, w: 4, h: 3 })
      pptx.addSlide().hidden = true
    })
    const [slide, hidden] = deck.slides
    const [title, list, shape, rule, picture, table] = slide.elements as [TextElement, TextElement, ShapeElement, LineElement, ImageElement, TableElement]

    expect(deck.size).toEqual({ width: 960, height: 540 })
    expect(slide).toMatchObject({ layout: 'blank', background: { kind: 'solid', color: '#f1f1f1' }, notes: 'Speaker notes', hidden: false })
    expect(hidden.hidden).toBe(true)
    expect(title).toMatchObject({ kind: 'text', x: 72, y: 72, width: 288, height: 72, body: { anchor: 'middle', style: { font: 'Georgia', size: 24, color: '#ff0000', bold: true, italic: true, underline: true }, paragraphs: [{ align: 'center', runs: [{ text: 'Hello world' }] }] } })
    expect(list.body.paragraphs.map(({ runs, ...rest }) => ({ text: runs[0].text, ...rest }))).toEqual([
      { text: 'First', list: 'bullet', lineSpacing: 1.5, spaceAfter: 6 },
      { text: 'Second', list: 'number', level: 1, numbering: 'arabicPeriod', lineSpacing: 1.5, spaceAfter: 6 },
      { text: 'Third', list: 'bullet', bullet: '►', lineSpacing: 1.5, spaceAfter: 6 }
    ])
    expect(shape).toMatchObject({ kind: 'shape', shape: 'roundRect', rotation: 45, fill: { color: '#00ff00', alpha: 0.5 }, stroke: { color: '#0000ff', width: 2, dash: 'dash' } })
    expect(Object.keys(shape.adjust ?? {})).toEqual(['adj'])
    expect(rule).toMatchObject({ kind: 'line', x: 432, y: 216, width: 144, height: 0, flipH: true, start: 'triangle', end: 'oval', stroke: { color: '#333333', width: 1 } })
    expect(picture).toMatchObject({ kind: 'image', x: 648, y: 72, width: 36, height: 36, alt: 'A dot', natural: { width: 1, height: 1 }, crop: { left: 0, top: 0, right: 0.5, bottom: 0.5 } })
    expect(table).toMatchObject({ kind: 'table', x: 72, y: 360, width: 288, columns: [144, 144], stroke: null })
    expect(table.cells[0].map((cell) => [plainText(cell.body), cell.fill])).toEqual([
      ['A', null],
      ['B', null]
    ])
    expect(table.rows[0]).toBeGreaterThan(12)
    expect(counts(report)).toEqual({
      text: { imported: 2, approximated: 0, skipped: 0 },
      shape: { imported: 1, approximated: 0, skipped: 0 },
      picture: { imported: 1, approximated: 0, skipped: 0 },
      line: { imported: 1, approximated: 0, skipped: 0 },
      table: { imported: 1, approximated: 0, skipped: 0 },
      chart: { imported: 0, approximated: 0, skipped: 1 }
    })
  })
})

describe('imageSize', () => {
  const jpeg = (width: number, height: number, marker = 0xc0): Uint8Array =>
    new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF'), 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, marker, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0x01, 0x22, 0x00])

  function bmp(width: number, height: number): Uint8Array {
    const bytes = new Uint8Array(54)
    const view = new DataView(bytes.buffer)
    bytes.set(ascii('BM'))
    view.setUint32(14, 40, true)
    view.setInt32(18, width, true)
    view.setInt32(22, height, true)

    return bytes
  }

  function webp(chunk: string, body: number[]): Uint8Array {
    return new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii(chunk), 0, 0, 0, 0, ...body])
  }

  it('reads PNG, JPEG, GIF, BMP and WebP sizes', () => {
    expect(imageSize(png(640, 480))).toEqual({ width: 640, height: 480, mime: 'image/png' })
    expect(imageSize(DOT)).toEqual({ width: 1, height: 1, mime: 'image/png' })
    expect(imageSize(jpeg(1024, 768))).toEqual({ width: 1024, height: 768, mime: 'image/jpeg' })
    expect(imageSize(jpeg(300, 200, 0xc2))).toEqual({ width: 300, height: 200, mime: 'image/jpeg' })
    expect(imageSize(new Uint8Array([...ascii('GIF89a'), 0x2c, 0x01, 0x96, 0x00, 0, 0]))).toEqual({ width: 300, height: 150, mime: 'image/gif' })
    expect(imageSize(bmp(120, -80))).toEqual({ width: 120, height: 80, mime: 'image/bmp' })
    expect(imageSize(webp('VP8X', [0, 0, 0, 0, 0x7f, 0x02, 0x00, 0x67, 0x01, 0x00]))).toEqual({ width: 640, height: 360, mime: 'image/webp' })
    expect(imageSize(webp('VP8L', [0x2f, 0x2b, 0x41, 0x25, 0x00]))).toEqual({ width: 300, height: 150, mime: 'image/webp' })
    expect(imageSize(webp('VP8 ', [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00]))).toEqual({ width: 320, height: 240, mime: 'image/webp' })
  })

  it('gives null for other formats, garbage and files cut short', () => {
    expect(imageSize(new Uint8Array())).toBeNull()
    expect(imageSize(new Uint8Array([1, 0, 0, 0, 108, 0, 0, 0, 0, 0, 0, 0]))).toBeNull()
    expect(imageSize(new Uint8Array([0xd7, 0xcd, 0xc6, 0x9a, 0, 0]))).toBeNull()
    expect(imageSize(new Uint8Array([...ascii('II*'), 0, 8, 0, 0, 0]))).toBeNull()
    expect(imageSize(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(imageSize(png(640, 480).slice(0, 20))).toBeNull()
    expect(imageSize(jpeg(1024, 768).slice(0, 26))).toBeNull()
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08]))).toBeNull()
    expect(imageSize(new Uint8Array([...ascii('BM'), 0, 0, 0, 0]))).toBeNull()
    expect(imageSize(png(0, 480))).toBeNull()
  })
})
