import { rootNamespaces } from '../opc.ts'
import { attributesOf, decodeXml, encodeXml } from '../xml.ts'
import type { Keep } from './context.ts'
import type { SheetNames } from './formulas.ts'
import { carried, childNamed, extensionsOf, placeChild, uriOf, withExtensions, withNamespace, WORKSHEET_ORDER } from './markup.ts'

/*
 * What a worksheet of the source holds in its own XML that Herald keeps: sparklines (an extension
 * of the sheet, their formulas naming sheets by their names now) and the sheet's background picture.
 * Then each written sheet gets what the steps gave it, in the schema's order.
 */

const SPARKLINES = '{05C60535-1F16-4fd2-B633-F4F36F0B64E0}'
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** Formula elements (`<xm:f>`) with their sheet names as they are now; null when one names a sheet that is gone. */
function formulasNow(xml: string, names: SheetNames): string | null {
  let gone = false
  const out = xml.replace(/<((?:[\w.-]+:)?)f>([^<]*)<\/\1f>/g, (whole, prefix: string, text: string) => {
    const now = names.formula(decodeXml(text))
    gone ||= now === null

    return now === null ? whole : `<${prefix}f>${encodeXml(now)}</${prefix}f>`
  })

  return gone ? null : out
}

/** A sheet's sparkline extension with its formulas' sheet names as they are now, without the sparklines whose data is on a sheet that is gone. */
export function sparklinesNow(extension: string, names: SheetNames): { xml: string | null; dropped: boolean } {
  let dropped = false
  let groups = 0
  const xml = extension.replace(/<((?:[\w.-]+:)?)sparklineGroup\b[^>]*>[\s\S]*?<\/\1sparklineGroup>/g, (group) => {
    const list = /<((?:[\w.-]+:)?)sparklines\b[^>]*>[\s\S]*?<\/\1sparklines>/.exec(group)

    if (!list) {
      return ''
    }

    // A group's own formula (its dates) is outside its sparklines.
    const before = formulasNow(group.slice(0, list.index), names)
    const after = formulasNow(group.slice(list.index + list[0].length), names)
    let lines = 0
    const kept = list[0].replace(/<((?:[\w.-]+:)?)sparkline\b[^>]*>[\s\S]*?<\/\1sparkline>/g, (line) => {
      const now = formulasNow(line, names)
      dropped ||= now === null
      lines += now === null ? 0 : 1

      return now ?? ''
    })

    if (before === null || after === null) {
      dropped = true

      return ''
    }

    groups += lines ? 1 : 0

    return lines ? `${before}${kept}${after}` : ''
  })

  return { xml: groups ? xml : null, dropped }
}

/** Keep each sheet's sparklines. */
export function keepSparklines(keep: Keep): void {
  for (const sheet of keep.sheets) {
    const extension = extensionsOf(sheet.xml).find((entry) => uriOf(entry) === SPARKLINES)

    if (!extension) {
      continue
    }

    const { xml, dropped } = sparklinesNow(extension, keep.names)

    if (dropped) {
      keep.loss(`Sparklines on ${sheet.written.name} that showed a deleted sheet’s data are not kept.`)
    }

    if (xml) {
      keep.extendSheet(sheet, carried(xml, rootNamespaces(sheet.xml, 'worksheet')))
    }
  }
}

/** Keep each sheet's background picture. */
export async function keepBackgrounds(keep: Keep): Promise<void> {
  for (const sheet of keep.sheets) {
    const picture = childNamed(sheet.xml, 'picture')
    const id = picture ? attributesOf(sheet.xml.slice(picture.start, picture.end))['r:id'] : undefined
    const rel = id ? sheet.relationships.find((entry) => entry.id === id && !entry.external) : undefined
    const target = rel ? await keep.copier.copy(rel.target) : null

    if (rel && target) {
      keep.addToSheet(sheet, 'picture', `<picture r:id="${await keep.ctx.writer.relate(sheet.written.path, rel.type, target)}"/>`)
    }
  }
}

/** Give each written sheet the elements and extensions the steps kept for it. */
export async function finishSheets(keep: Keep): Promise<void> {
  for (const sheet of keep.sheets) {
    const additions = keep.sheetAdditions.get(sheet.written.id)
    let xml = additions ? await keep.ctx.writer.text(sheet.written.path) : undefined

    if (!additions || !xml) {
      continue
    }

    for (const [element, content] of additions.elements) {
      if (!childNamed(xml, element)) {
        xml = placeChild(xml, WORKSHEET_ORDER, element, content)
      }
    }

    await keep.ctx.writer.put(sheet.written.path, withNamespace(withExtensions(xml, WORKSHEET_ORDER, additions.extensions), 'r', RELATIONSHIPS))
  }
}
