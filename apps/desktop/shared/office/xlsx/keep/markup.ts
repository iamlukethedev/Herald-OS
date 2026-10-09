import { encodeXml } from '../xml.ts'

/*
 * Small edits on the XML of a package being finished: the children of a part's root found by their
 * place (nested elements of any name passed over, so an extension list inside a conditional format
 * is not taken for the sheet's own), elements put where the schema orders them, attributes set or
 * dropped, and the namespace declarations an element needs when it moves from one part to another.
 */

export interface Child {
  /** The element's name with its prefix, as "extLst" or "x14:slicerList". */
  name: string
  /** Where its start tag opens and where its end tag closes (one past it). */
  start: number
  end: number
}

/** The order of a worksheet's elements (CT_Worksheet). */
export const WORKSHEET_ORDER = ['sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios', 'autoFilter', 'sortState', 'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr', 'conditionalFormatting', 'dataValidations', 'hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst']

/** The order of the workbook's elements (CT_Workbook). */
export const WORKBOOK_ORDER = ['fileVersion', 'fileSharing', 'workbookPr', 'workbookProtection', 'bookViews', 'sheets', 'functionGroups', 'externalReferences', 'definedNames', 'calcPr', 'oleSize', 'customWorkbookViews', 'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing', 'fileRecoveryPr', 'webPublishObjects', 'extLst']

/** The order of the style sheet's elements (CT_Stylesheet). */
export const STYLESHEET_ORDER = ['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles', 'dxfs', 'tableStyles', 'colors', 'extLst']

export const localName = (name: string): string => name.slice(name.indexOf(':') + 1)

/** Where the tag opening at `open` ends (its ">"), passing over quoted attribute values; -1 when it does not. */
function tagEnd(xml: string, open: number): number {
  let quote = ''

  for (let at = open + 1; at < xml.length; at++) {
    const char = xml[at]

    if (quote) {
      quote = char === quote ? '' : quote
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return at
    }
  }

  return -1
}

/** The elements from `from` to the end tag of the element holding them, whole and in order; a sheetData is passed over without reading its cells. */
export function childrenFrom(xml: string, from: number): Child[] {
  const children: Child[] = []
  let depth = 0
  let current = { name: '', start: 0 }
  let at = from

  while (at < xml.length) {
    const open = xml.indexOf('<', at)

    if (open < 0) {
      break
    }

    const skip = xml.startsWith('<!--', open) ? '-->' : xml.startsWith('<?', open) ? '?>' : xml.startsWith('<![CDATA[', open) ? ']]>' : ''

    if (skip) {
      const end = xml.indexOf(skip, open)
      at = end < 0 ? xml.length : end + skip.length
      continue
    }

    const end = tagEnd(xml, open)

    if (end < 0) {
      break
    }

    const closing = xml[open + 1] === '/'
    const empty = !closing && xml[end - 1] === '/'

    if (closing) {
      if (depth === 0) {
        break
      }

      depth--

      if (depth === 0) {
        children.push({ ...current, end: end + 1 })
      }
    } else if (depth === 0) {
      const name = /^<([\w:.-]+)/.exec(xml.slice(open, open + 256))?.[1] ?? ''
      current = { name, start: open }

      if (empty) {
        children.push({ ...current, end: end + 1 })
      } else if (localName(name) === 'sheetData') {
        const close = xml.indexOf(`</${name}>`, end)
        const finish = close < 0 ? xml.length : close + name.length + 3
        children.push({ ...current, end: finish })
        at = finish
        continue
      } else {
        depth = 1
      }
    } else if (!empty) {
      depth++
    }

    at = end + 1
  }

  return children
}

/** Where the content of a part's root element starts: just after its start tag. */
export function rootContent(xml: string): number {
  const root = /<(?![?!])[\w:.-]+/.exec(xml)

  return root ? tagEnd(xml, root.index) + 1 : -1
}

/** The children of a part's root element, in order. */
export const childrenOf = (xml: string): Child[] => {
  const start = rootContent(xml)

  return start > 0 ? childrenFrom(xml, start) : []
}

/** The child of a part's root with this local name. */
export const childNamed = (xml: string, name: string): Child | undefined => childrenOf(xml).find((child) => localName(child.name) === name)

/** The children of an element given whole (an extension list's extensions), each whole. */
export function innerElements(element: string): string[] {
  return childrenOf(element).map((child) => element.slice(child.start, child.end))
}

/** Put a child into a part's root where `order` has it: before the first child that comes after it, else at the end. */
export function placeChild(xml: string, order: string[], element: string, content: string): string {
  const rank = order.indexOf(element)
  const later = childrenOf(xml).find((child) => order.indexOf(localName(child.name)) > rank)
  const at = later ? later.start : xml.lastIndexOf('</')

  return `${xml.slice(0, at)}${content}${xml.slice(at)}`
}

/** An element given whole with content put at its end (an empty element gets an end tag). */
export function grown(element: string, content: string): string {
  if (element.endsWith('/>')) {
    const name = /^<([\w:.-]+)/.exec(element)?.[1] ?? ''

    return `${element.slice(0, -2).trimEnd()}>${content}</${name}>`
  }

  const close = element.lastIndexOf('</')

  return `${element.slice(0, close)}${content}${element.slice(close)}`
}

/** Put content at the end of a child of a part's root. */
export function appendToChild(xml: string, child: Child, content: string): string {
  return `${xml.slice(0, child.start)}${grown(xml.slice(child.start, child.end), content)}${xml.slice(child.end)}`
}

/** Extensions added to a part's root extension list, which is made when there is none. */
export function withExtensions(xml: string, order: string[], extensions: string[]): string {
  if (!extensions.length) {
    return xml
  }

  const list = childNamed(xml, 'extLst')

  return list ? appendToChild(xml, list, extensions.join('')) : placeChild(xml, order, 'extLst', `<extLst>${extensions.join('')}</extLst>`)
}

/** The extensions of a part's root extension list, each whole. */
export function extensionsOf(xml: string): string[] {
  const list = childNamed(xml, 'extLst')

  return list ? innerElements(xml.slice(list.start, list.end)) : []
}

/** An extension's uri. */
export const uriOf = (extension: string): string => /^<[\w:.-]+\s[^>]*?\buri="([^"]*)"/.exec(extension)?.[1] ?? ''

const escapeName = (name: string): string => name.replace(/[.:-]/g, (char) => `\\${char}`)

/** A start tag with an attribute set to `value`, added when the tag has none of that name. */
export function withAttribute(tag: string, name: string, value: string): string {
  const pattern = new RegExp(`(\\s${escapeName(name)}\\s*=\\s*)(?:"[^"]*"|'[^']*')`)

  return pattern.test(tag) ? tag.replace(pattern, (_whole, before: string) => `${before}"${encodeXml(value)}"`) : tag.replace(/\s*(\/?>)$/, ` ${name}="${encodeXml(value)}"$1`)
}

/** A start tag without the attributes whose names `names` matches. */
export function withoutAttributes(tag: string, names: RegExp): string {
  return tag.replace(/\s([\w:.-]+)\s*=\s*(?:"[^"]*"|'[^']*')/g, (whole, name: string) => (names.test(name) ? '' : whole))
}

/** A part whose root element declares `prefix`, given the declaration when it lacks it. */
export function withNamespace(xml: string, prefix: string, uri: string): string {
  const root = /<(?![?!])[\w:.-]+/.exec(xml)

  if (!root || new RegExp(`\\sxmlns:${escapeName(prefix)}\\s*=`).test(xml.slice(root.index, tagEnd(xml, root.index)))) {
    return xml
  }

  const at = root.index + root[0].length

  return `${xml.slice(0, at)} xmlns:${prefix}="${encodeXml(uri)}"${xml.slice(at)}`
}

/** An element moved out of a part, given the declarations of the prefixes it uses that the part's root made. */
export function carried(element: string, rootNamespaces: Record<string, string>): string {
  const declared = new Set([...element.matchAll(/\sxmlns:([\w.-]+)\s*=/g)].map((found) => found[1]))
  const used = new Set([...element.matchAll(/<\/?([\w.-]+):/g), ...element.matchAll(/\s([\w.-]+):[\w.-]+\s*=/g)].map((found) => found[1]))
  const missing = [...used].filter((prefix) => prefix !== 'xmlns' && prefix !== 'xml' && !declared.has(prefix) && rootNamespaces[`xmlns:${prefix}`])

  return missing.length ? element.replace(/^<([\w:.-]+)/, (start) => `${start}${missing.map((prefix) => ` xmlns:${prefix}="${encodeXml(rootNamespaces[`xmlns:${prefix}`])}"`).join('')}`) : element
}
