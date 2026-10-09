import JSZip from 'jszip'
import { parseRelationships, relsPathOf } from '../opc.ts'
import { attributesOf, elementsOf, firstElement } from '../xml.ts'
import { childrenOf, localName, WORKBOOK_ORDER, WORKSHEET_ORDER } from './markup.ts'

/*
 * What Excel would repair in a package, for the tests of what Herald keeps: relationships to parts
 * that are missing, parts without a content type, relationship ids a part names that it does not
 * have, an id given twice, worksheet and workbook elements out of the schema's order or inside
 * other elements, shape ids given twice in a drawing, sheets a defined name counts past, and pivot
 * caches the workbook and its pivot tables disagree on.
 */

const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** Elements a part's root may hold more than once. */
const REPEATED = new Set(['conditionalFormatting', 'sheet'])

/** Worksheet elements that belong only to the worksheet itself, never inside another element. */
const TOP_LEVEL_ONLY = ['mergeCells', 'conditionalFormatting', 'dataValidations', 'hyperlinks', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'picture', 'oleObjects', 'controls', 'tableParts']

/** A worksheet element of those found inside another element. */
function nested(xml: string): string | undefined {
  const top = childrenOf(xml).map((child) => child.name)

  return TOP_LEVEL_ONLY.find((name) => (xml.match(new RegExp(`<${name}[\\s/>]`, 'g'))?.length ?? 0) > top.filter((entry) => entry === name).length)
}

function outOfOrder(xml: string, order: string[]): string | null {
  let last = -1
  const seen = new Set<string>()

  for (const child of childrenOf(xml)) {
    const name = localName(child.name)
    const rank = order.indexOf(name)

    if (rank < 0) {
      continue
    }

    if (rank < last || (seen.has(name) && !REPEATED.has(name))) {
      return name
    }

    last = rank
    seen.add(name)
  }

  return null
}

/** A written package to look into: its parts, its sheets as the workbook lists them, and the parts each part relates to. */
export async function openedPackage(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes)
  const text = async (path: string) => (await zip.file(path)?.async('string')) ?? ''
  const workbook = await text('xl/workbook.xml')
  const workbookRels = parseRelationships('xl/workbook.xml', await text('xl/_rels/workbook.xml.rels'))
  const sheets = elementsOf(firstElement(workbook, 'sheets')?.inner ?? '', 'sheet').map(({ attributes }) => ({
    name: attributes.name ?? '',
    sheetId: attributes.sheetId ?? '',
    state: attributes.state,
    path: workbookRels.find((rel) => rel.id === attributes['r:id'])?.target ?? ''
  }))
  const relationships = async (part: string) => parseRelationships(part, await text(relsPathOf(part)))
  const related = async (part: string, type: string) => (await relationships(part)).filter((rel) => rel.type.endsWith(`/${type}`)).map((rel) => rel.target)
  const files = (pattern: RegExp) => Object.keys(zip.files).filter((name) => !zip.files[name].dir && pattern.test(name))

  return { zip, text, workbook, workbookRels, sheets, relationships, related, files, sheet: (name: string) => sheets.find((sheet) => sheet.name === name)?.path ?? '' }
}

/** The problems a package has that would make Excel repair it; none for a sound one. */
export async function packageProblems(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes)
  const files = Object.keys(zip.files).filter((name) => !zip.files[name].dir)
  const read = async (path: string) => (await zip.file(path)?.async('string')) ?? ''
  const problems: string[] = []
  const types = await read('[Content_Types].xml')
  const overrides = new Map(elementsOf(types, 'Override').map(({ attributes }) => [String(attributes.PartName ?? '').replace(/^\//, '').toLowerCase(), attributes.ContentType ?? '']))
  const defaults = new Set(elementsOf(types, 'Default').map(({ attributes }) => String(attributes.Extension ?? '').toLowerCase()))
  const typeOf = (path: string) => overrides.get(path.toLowerCase()) ?? (defaults.has(path.split('.').pop()?.toLowerCase() ?? '') ? 'default' : undefined)

  for (const path of overrides.keys()) {
    if (!files.some((file) => file.toLowerCase() === path)) {
      problems.push(`${path} has a content type but is missing`)
    }
  }

  for (const file of files.filter((name) => name !== '[Content_Types].xml')) {
    if (!typeOf(file)) {
      problems.push(`${file} has no content type`)
    }

    if (file.endsWith('.rels')) {
      continue
    }

    const relationships = parseRelationships(file, zip.file(relsPathOf(file)) ? await read(relsPathOf(file)) : undefined)
    const ids = new Set<string>()

    for (const rel of relationships) {
      if (ids.has(rel.id)) {
        problems.push(`${file} has two relationships ${rel.id}`)
      }

      ids.add(rel.id)

      if (!rel.external && !zip.file(rel.target)) {
        problems.push(`${file} relates ${rel.id} to ${rel.target}, which is missing`)
      }
    }

    if (!/\.(xml|vml)$/i.test(file)) {
      continue
    }

    const xml = await read(file)
    const prefixes = [...new Set([...xml.matchAll(/\sxmlns:([\w.-]+)="([^"]*)"/g)].filter((found) => found[2] === RELATIONSHIPS).map((found) => found[1]))]

    for (const prefix of prefixes) {
      for (const found of xml.matchAll(new RegExp(`\\s${prefix}:[\\w.-]+="([^"]*)"`, 'g'))) {
        if (!ids.has(found[1])) {
          problems.push(`${file} names ${found[1]}, which it has no relationship for`)
        }
      }
    }

    const type = typeOf(file) ?? ''

    if (type.endsWith('worksheet+xml') && outOfOrder(xml, WORKSHEET_ORDER)) {
      problems.push(`${file} has ${outOfOrder(xml, WORKSHEET_ORDER)} out of order`)
    }

    if (type.endsWith('worksheet+xml') && nested(xml)) {
      problems.push(`${file} has ${nested(xml)} inside another element`)
    }

    if (type.endsWith('sheet.main+xml')) {
      if (outOfOrder(xml, WORKBOOK_ORDER)) {
        problems.push(`${file} has ${outOfOrder(xml, WORKBOOK_ORDER)} out of order`)
      }

      const sheets = elementsOf(firstElement(xml, 'sheets')?.inner ?? '', 'sheet')
      const tooFar = elementsOf(firstElement(xml, 'definedNames')?.inner ?? '', 'definedName').filter(({ attributes }) => attributes.localSheetId !== undefined && Number(attributes.localSheetId) >= sheets.length)
      tooFar.forEach(({ attributes }) => problems.push(`the defined name ${attributes.name} is on sheet ${attributes.localSheetId}, past the last`))

      // Each pivot table names a cache the workbook lists, and relates to that cache's definition.
      const caches = new Map(elementsOf(firstElement(xml, 'pivotCaches')?.inner ?? '', 'pivotCache').map(({ attributes }) => [attributes.cacheId ?? '', relationships.find((rel) => rel.id === attributes['r:id'])?.target]))

      for (const table of files.filter((name) => overrides.get(name.toLowerCase())?.endsWith('pivotTable+xml'))) {
        const cacheId = attributesOf(/<(?:\w+:)?pivotTableDefinition\b[^>]*>/.exec(await read(table))?.[0] ?? '').cacheId ?? ''
        const definition = parseRelationships(table, await read(relsPathOf(table))).find((rel) => rel.type.endsWith('/pivotCacheDefinition'))?.target

        if (!caches.has(cacheId) || caches.get(cacheId) !== definition) {
          problems.push(`${table} names cache ${cacheId}, which the workbook does not list for ${definition}`)
        }
      }
    }

    if (type.endsWith('drawing+xml')) {
      const shapeIds = [...xml.matchAll(/<(?:\w+:)?cNvPr\b[^>]*?\sid="(\d+)"/g)].map((found) => found[1]).filter((id) => id !== '0')
      const twice = shapeIds.filter((id, n) => shapeIds.indexOf(id) !== n)

      if (twice.length) {
        problems.push(`${file} gives shape ids ${[...new Set(twice)].join(', ')} twice`)
      }
    }
  }

  return problems
}
