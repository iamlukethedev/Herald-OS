import { quoteSheet } from '../address.ts'
import { decodeXml, encodeXml } from '../xml.ts'
import type { Keep } from './context.ts'
import { type Refusal, refused } from './parts.ts'

/*
 * Charts Herald does not draw, kept in drawings and chart sheets: their formulas name sheets by
 * their names now, the hidden names newer charts read their ranges through come along, and a chart
 * of a pivot table that is not kept becomes a chart of the cells it shows. A chart whose data is on
 * a sheet that is gone is not kept, since its formulas would point at nothing.
 */

/** A chart part (chart or chartEx) as the written file has it; refused when it shows a sheet that is gone. */
export function chartPart(keep: Keep, xml: string): string | Refusal {
  let gone = false
  const out = xml.replace(/<((?:[\w.-]+:)?)f(\s[^>]*)?>([^<]*)<\/\1f>/g, (whole, prefix: string, attributes = '', text: string) => {
    const formula = decodeXml(text)
    const name = keep.pkg.definedNames.find((entry) => entry.localSheetId === undefined && entry.name.toLowerCase() === formula.trim().toLowerCase())

    if (name) {
      const now = keep.names.formula(name.formula)
      gone ||= now === null

      if (now !== null) {
        keep.needName({ name: name.name, formula: now, hidden: name.hidden })
      }

      return whole
    }

    const now = keep.names.formula(formula)
    gone ||= now === null

    return now === null ? whole : `<${prefix}f${attributes}>${encodeXml(now)}</${prefix}f>`
  })

  return gone ? refused('gone') : withPivotSource(keep, out)
}

/** A pivot chart's source pivot table by its sheet's name now; without one that is kept, the chart is a chart of its cells. */
function withPivotSource(keep: Keep, xml: string): string {
  const source = /<((?:[\w.-]+:)?)pivotSource>[\s\S]*?<\/\1pivotSource>/.exec(xml)

  if (!source) {
    return xml
  }

  const name = decodeXml(/<(?:[\w.-]+:)?name>([^<]*)</.exec(source[0])?.[1] ?? '')
  const parts = /^(\[[^\]]*\])?(?:'((?:[^']|'')+)'|([^!']+))!(.+)$/.exec(name)
  const sheet = parts ? (parts[2]?.replace(/''/g, "'") ?? parts[3]) : undefined
  const now = sheet ? keep.names.kept(sheet) : null

  if (parts && sheet && now !== null && keep.hasPivotTable(sheet, parts[4])) {
    const renamed = source[0].replace(/(<(?:[\w.-]+:)?name>)[^<]*/, (_whole, open: string) => `${open}${encodeXml(`${parts[1] ?? ''}${quoteSheet(now)}!${parts[4]}`)}`)

    return `${xml.slice(0, source.index)}${renamed}${xml.slice(source.index + source[0].length)}`
  }

  return `${xml.slice(0, source.index)}${xml.slice(source.index + source[0].length)}`
    .replace(/<((?:[\w.-]+:)?)pivotFmts\b(?:[^>]*\/>|[\s\S]*?<\/\1pivotFmts>)/g, '')
    .replace(/<((?:[\w.-]+:)?)ext\s[^>]*uri="\{781A3756-C4B2-4CAC-9D66-4F8BD8637D16\}"[\s\S]*?<\/\1ext>/g, '')
}

/**
 * A SmartArt data part without the reference to its drawing: that reference names a relationship of
 * the sheet's drawing, whose ids the drawing builder gives anew, and Excel draws SmartArt from its
 * data and layout without it.
 */
export function diagramDataPart(xml: string): string {
  return xml.replace(/<((?:[\w.-]+:)?)ext\s[^>]*uri="http:\/\/schemas\.microsoft\.com\/office\/drawing\/2008\/diagram"[\s\S]*?<\/\1ext>/g, '')
}
