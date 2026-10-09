import { type Child, childNamed, childrenOf, placeChild, tagEnd } from '../opc.ts'
import { encodeXml } from '../xml.ts'

/*
 * Small edits on the XML of a package being finished, on top of how opc.ts finds a part's children
 * (re-exported here): extension lists grown or made, attributes set or dropped, and the namespace
 * declarations an element needs when it moves from one part to another.
 */

export { type Child, childNamed, childrenFrom, childrenOf, localName, placeChild, rootContent, WORKBOOK_ORDER, WORKSHEET_ORDER } from '../opc.ts'

/** The order of the style sheet's elements (CT_Stylesheet). */
export const STYLESHEET_ORDER = ['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles', 'dxfs', 'tableStyles', 'colors', 'extLst']

/** The children of an element given whole (an extension list's extensions), each whole. */
export function innerElements(element: string): string[] {
  return childrenOf(element).map((child) => element.slice(child.start, child.end))
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
