import { REL } from '../opc.ts'
import { attributesOf, elementsOf, encodeXml, firstElement } from '../xml.ts'
import type { ChartSheet, Keep } from './context.ts'
import { appendToChild, childNamed, innerElements, placeChild, withAttribute, withExtensions, withNamespace, WORKBOOK_ORDER } from './markup.ts'

/*
 * What the source file holds for the whole workbook that Herald keeps: its theme (over ExcelJS's
 * default, so theme colours in kept parts and in the Normal font look as they did), its custom
 * document properties, its links to other workbooks (formulas name them by their place in the list),
 * and its chart sheets, put back among the sheets where they were. Then the workbook gets what the
 * steps gave it.
 */

const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const RELATIONSHIPS = OFFICE
const THEME = `${OFFICE}/theme`
const CUSTOM_PROPERTIES = `${OFFICE}/custom-properties`

/** Write the source's theme over the one ExcelJS wrote. */
export async function keepTheme(keep: Keep): Promise<void> {
  const source = keep.sourceRelationships.find((rel) => rel.type === THEME && !rel.external)
  const target = (await keep.ctx.writer.relationships(keep.workbookPath)).find((rel) => rel.type === THEME && !rel.external)

  if (source && target) {
    await keep.copier.copyTo(source.target, target.target)
  }
}

/** Keep the source's custom document properties. */
export async function keepCustomProperties(keep: Keep): Promise<void> {
  const source = (await keep.copier.relationships('')).find((rel) => rel.type === CUSTOM_PROPERTIES && !rel.external)

  if (!source || (await keep.ctx.writer.relationships('')).some((rel) => rel.type === CUSTOM_PROPERTIES)) {
    return
  }

  const target = keep.ctx.writer.has('docProps/custom.xml') ? keep.ctx.writer.freshName((n) => `docProps/custom${n}.xml`) : 'docProps/custom.xml'

  if (await keep.copier.copyTo(source.target, target)) {
    await keep.ctx.writer.relate('', CUSTOM_PROPERTIES, target)
  }
}

/** Keep the source's links to other workbooks, all in their order or none. */
export async function keepExternalLinks(keep: Keep): Promise<void> {
  const references = elementsOf(firstElement(keep.pkg.workbookXml, 'externalReferences')?.inner ?? '', 'externalReference').map(({ attributes }) => attributes['r:id'] ?? '')
  const rels = references.map((id) => keep.sourceRelationships.find((rel) => rel.id === id && !rel.external))

  if (!rels.length || childNamed(keep.workbookXml, 'externalReferences')) {
    return
  }

  for (const rel of rels) {
    if (!rel || (await keep.copier.check(rel.target))) {
      return
    }
  }

  for (const rel of rels) {
    const target = rel ? await keep.copier.copy(rel.target) : null

    if (rel && target) {
      keep.workbookAdditions.externals.push(await keep.ctx.writer.relate(keep.workbookPath, rel.type, target))
    }
  }
}

/** Put the source's chart sheets back, each after the sheet it followed. */
export async function keepChartSheets(keep: Keep): Promise<void> {
  const taken = new Set(keep.ctx.sheets.map((sheet) => sheet.name.toLowerCase()))
  let previous: string | null = null

  for (const sheet of keep.pkg.sheets) {
    if (sheet.kind !== 'chartsheet') {
      previous = keep.sheets.find((kept) => kept.source === sheet)?.written.name ?? previous
      continue
    }

    const rel = keep.sourceRelationships.find((entry) => entry.target === sheet.path && !entry.external)

    if (!rel) {
      continue
    }

    if (taken.has(sheet.name.toLowerCase())) {
      keep.loss(`The chart sheet ${sheet.name} is left out: another sheet has its name.`)
      continue
    }

    const target = await keep.copier.copy(sheet.path)

    if (!target) {
      keep.loss(`The chart sheet ${sheet.name} is left out${(await keep.copier.check(sheet.path)) === 'gone' ? ': the sheet its chart showed is gone' : ''}.`)
      continue
    }

    keep.workbookAdditions.chartSheets.push({ name: sheet.name, state: sheet.state, id: await keep.ctx.writer.relate(keep.workbookPath, rel.type, target), after: previous })
    taken.add(sheet.name.toLowerCase())
    previous = sheet.name
  }
}

/** The workbook's sheets with the chart sheets among them; defined names and the views count sheets by their place, chart sheets included. */
function withChartSheets(xml: string, chartSheets: ChartSheet[]): string {
  const list = childNamed(xml, 'sheets')

  if (!list) {
    return xml
  }

  const element = xml.slice(list.start, list.end)
  const placed = innerElements(element).map((sheet, place) => ({ sheet, place }))
  let next = Math.max(0, ...placed.map(({ sheet }) => Number(attributesOf(sheet).sheetId) || 0)) + 1

  for (const chart of chartSheets) {
    const after = chart.after === null ? -1 : placed.findIndex(({ sheet }) => (attributesOf(sheet).name ?? '').toLowerCase() === chart.after?.toLowerCase())
    placed.splice(after + 1, 0, { sheet: `<sheet name="${encodeXml(chart.name)}" sheetId="${next++}"${chart.state === 'visible' ? '' : ` state="${chart.state}"`} r:id="${chart.id}"/>`, place: -1 })
  }

  const moved = new Map(placed.flatMap(({ place }, now) => (place >= 0 ? [[place, now] as const] : [])))
  const move = (value: string | undefined) => String(moved.get(Number(value)) ?? value)
  const open = /^<[^>]*>/.exec(element)?.[0] ?? '<sheets>'

  return `${xml.slice(0, list.start)}${open}${placed.map(({ sheet }) => sheet).join('')}</${list.name}>${xml.slice(list.end)}`
    .replace(/<(?:[\w.-]+:)?definedName\b[^>]*>/g, (tag) => (attributesOf(tag).localSheetId === undefined ? tag : withAttribute(tag, 'localSheetId', move(attributesOf(tag).localSheetId))))
    .replace(/<(?:[\w.-]+:)?workbookView\b[^>]*>/g, (tag) => ['activeTab', 'firstSheet'].reduce((view, name) => (attributesOf(view)[name] === undefined ? view : withAttribute(view, name, move(attributesOf(view)[name]))), tag))
}

/** Give the workbook the links, defined names, pivot caches, extensions and chart sheets the steps kept. */
export async function finishWorkbook(keep: Keep): Promise<void> {
  const { externals, extensions, names, chartSheets } = keep.workbookAdditions
  let xml = await keep.ctx.writer.text(keep.workbookPath)

  if (!xml || (!externals.length && !extensions.length && !names.length && !chartSheets.length && !keep.pivotCaches.size)) {
    return
  }

  if (externals.length) {
    xml = placeChild(xml, WORKBOOK_ORDER, 'externalReferences', `<externalReferences>${externals.map((id) => `<externalReference r:id="${id}"/>`).join('')}</externalReferences>`)
  }

  if (names.length) {
    const entries = names.map((name) => `<definedName name="${encodeXml(name.name)}"${name.hidden ? ' hidden="1"' : ''}>${encodeXml(name.formula)}</definedName>`).join('')
    const list = childNamed(xml, 'definedNames')
    xml = list ? appendToChild(xml, list, entries) : placeChild(xml, WORKBOOK_ORDER, 'definedNames', `<definedNames>${entries}</definedNames>`)
  }

  if (keep.pivotCaches.size) {
    const entries: string[] = []

    for (const [cacheId, { target }] of [...keep.pivotCaches].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      entries.push(`<pivotCache cacheId="${encodeXml(cacheId)}" r:id="${await keep.ctx.writer.relate(keep.workbookPath, REL.pivotCacheDefinition, target)}"/>`)
    }

    const list = childNamed(xml, 'pivotCaches')
    xml = list ? appendToChild(xml, list, entries.join('')) : placeChild(xml, WORKBOOK_ORDER, 'pivotCaches', `<pivotCaches>${entries.join('')}</pivotCaches>`)
  }

  xml = withExtensions(xml, WORKBOOK_ORDER, extensions)
  await keep.ctx.writer.put(keep.workbookPath, withNamespace(chartSheets.length ? withChartSheets(xml, chartSheets) : xml, 'r', RELATIONSHIPS))
}
