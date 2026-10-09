import JSZip from 'jszip'
import { attributesOf, decodeXml, elementsOf, firstElement } from './xml.ts'

/*
 * An .xlsx file as the package of parts it is (OPC): the workbook and its sheets found through
 * their relationships, plus the parts ExcelJS does not read, for the fidelity report and for what
 * Herald maps itself (data validation, filter criteria, defined names, the theme).
 */

export interface PackageSheet {
  name: string
  path: string
  state: 'visible' | 'hidden' | 'veryHidden'
  kind: 'worksheet' | 'chartsheet' | 'dialogsheet' | 'macrosheet' | 'other'
  /** The worksheet's XML around its cells: before `<sheetData>`, and from `</sheetData>` (or after an empty `<sheetData/>`) on. */
  head: string
  tail: string
  /** The sheet's own relationships, by type (the last part of the type URI). */
  related: { id: string; type: string; target: string; external: boolean }[]
}

export interface DefinedName {
  name: string
  formula: string
  /** The position of the sheet it belongs to, in the workbook's sheet list. */
  localSheetId?: number
  hidden?: boolean
  comment?: string
}

export interface XlsxPackage {
  files: string[]
  sheets: PackageSheet[]
  definedNames: DefinedName[]
  date1904: boolean
  activeTab: number
  workbookXml: string
  themeXml?: string
  stylesXml?: string
  read: (path: string) => Promise<string | undefined>
  /** A part as it is stored, for pictures and other binary parts. */
  binary: (path: string) => Promise<Uint8Array | undefined>
}

const relationshipType = (type: string): string => type.split('/').pop() ?? type

/** A relationship target as a path in the package, relative to the part that names it. */
export function resolvePart(from: string, target: string): string {
  if (target.startsWith('/')) {
    return target.slice(1)
  }

  const parts = from.split('/').slice(0, -1)

  for (const piece of target.split('/')) {
    if (piece === '..') {
      parts.pop()
    } else if (piece && piece !== '.') {
      parts.push(piece)
    }
  }

  return parts.join('/')
}

const relsPath = (part: string): string => {
  const slash = part.lastIndexOf('/')

  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
}

async function relationships(zip: JSZip, part: string): Promise<{ id: string; type: string; target: string; external: boolean }[]> {
  const xml = await zip.file(relsPath(part))?.async('string')

  return xml
    ? elementsOf(xml, 'Relationship').map(({ attributes }) => ({
        id: attributes.Id ?? '',
        type: relationshipType(attributes.Type ?? ''),
        target: attributes.TargetMode === 'External' ? (attributes.Target ?? '') : resolvePart(part, attributes.Target ?? ''),
        external: attributes.TargetMode === 'External'
      }))
    : []
}

/** Open a package and read its workbook, sheets and shared parts; throws when it is not a workbook. */
export async function openPackage(bytes: Uint8Array | ArrayBuffer): Promise<XlsxPackage> {
  let zip: JSZip

  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    throw new Error('This is not an Excel workbook (.xlsx): it is not a zip package. An older .xls file can be saved as .xlsx in Excel or LibreOffice first.')
  }

  const read = async (path: string) => zip.file(path)?.async('string')
  const root = await relationships(zip, '')
  const workbookPath = root.find((rel) => rel.type === 'officeDocument')?.target ?? 'xl/workbook.xml'
  const workbookXml = await read(workbookPath)

  if (!workbookXml) {
    throw new Error(zip.file('word/document.xml') || zip.file('ppt/presentation.xml') ? 'This is a Word or PowerPoint file, not an Excel workbook.' : 'This package has no workbook in it.')
  }

  const rels = await relationships(zip, workbookPath)
  const byId = new Map(rels.map((rel) => [rel.id, rel]))
  const sheets: PackageSheet[] = []

  for (const { attributes } of elementsOf(firstElement(workbookXml, 'sheets')?.inner ?? '', 'sheet')) {
    const rel = byId.get(attributes['r:id'] ?? '')
    const path = rel?.target ?? ''
    const kind = (['worksheet', 'chartsheet', 'dialogsheet', 'macrosheet'] as const).find((type) => type === rel?.type || (type === 'macrosheet' && rel?.type === 'xlMacrosheet')) ?? 'other'
    const xml = kind === 'worksheet' ? ((await read(path)) ?? '') : ''
    const start = xml.indexOf('<sheetData')
    // A sheet without cells has an empty <sheetData/>: its tail is what follows it.
    const empty = start >= 0 ? /^<sheetData\b[^>]*\/>/.exec(xml.slice(start, start + 256)) : null
    const end = empty ? start + empty[0].length : xml.lastIndexOf('</sheetData>')
    const state = attributes.state === 'hidden' || attributes.state === 'veryHidden' ? attributes.state : 'visible'

    sheets.push({
      name: attributes.name ?? '',
      path,
      state,
      kind,
      head: start >= 0 ? xml.slice(0, start) : xml,
      tail: end >= 0 ? xml.slice(end) : '',
      related: path ? await relationships(zip, path) : []
    })
  }

  const definedNames = elementsOf(firstElement(workbookXml, 'definedNames')?.inner ?? '', 'definedName').map(({ attributes, inner }) => ({
    name: attributes.name ?? '',
    formula: decodeXml(inner),
    ...(attributes.localSheetId !== undefined ? { localSheetId: Number(attributes.localSheetId) } : {}),
    ...(attributes.hidden === '1' || attributes.hidden === 'true' ? { hidden: true } : {}),
    ...(attributes.comment ? { comment: attributes.comment } : {})
  }))
  const workbookPr = /<(?:\w+:)?workbookPr\b[^>]*>/.exec(workbookXml)
  const view = /<(?:\w+:)?workbookView\b[^>]*>/.exec(workbookXml)
  const date1904 = workbookPr ? ['1', 'true'].includes(attributesOf(workbookPr[0]).date1904 ?? '') : false
  const themePath = rels.find((rel) => rel.type === 'theme')?.target
  const stylesPath = rels.find((rel) => rel.type === 'styles')?.target

  return {
    files: Object.keys(zip.files).filter((name) => !zip.files[name].dir),
    sheets,
    definedNames,
    date1904,
    activeTab: view ? Number(attributesOf(view[0]).activeTab ?? 0) || 0 : 0,
    workbookXml,
    themeXml: themePath ? await read(themePath) : undefined,
    stylesXml: stylesPath ? await read(stylesPath) : undefined,
    read,
    binary: async (path) => zip.file(path)?.async('uint8array')
  }
}
