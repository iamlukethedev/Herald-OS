import { child, children, parseXml, type XmlElement } from '../../docx/xml.ts'
import { mixed, tinted } from '../colors.ts'
import { encodeXml } from '../xml.ts'

/*
 * The DrawingML a chart part and its anchor are written in: the namespaces, parts read as trees
 * whose names carry the usual prefixes whatever a file declared, and colours and fills as the
 * plain colour Herald draws.
 */

export const NS = {
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  xdr: 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006'
} as const

const PREFIXES: Record<string, string> = Object.fromEntries(Object.entries(NS).map(([prefix, uri]) => [uri, prefix]))

/** A part as a tree with the prefixes of NS; null when it is not well-formed XML. */
export function parsePart(xml: string): XmlElement | null {
  try {
    return parseXml(xml, { prefixes: PREFIXES })
  } catch {
    return null
  }
}

/** An element cut out of a part (a drawing's anchor), read with the namespaces its part's root declares. */
export function parseFragment(xml: string, namespaces: Record<string, string>): XmlElement | null {
  const declarations = Object.entries(namespaces)
    .filter(([name]) => name === 'xmlns' || name.startsWith('xmlns:'))
    .map(([name, uri]) => `${name}="${encodeXml(uri)}"`)
    .join(' ')
  const root = parsePart(`<fragment ${declarations}>${xml}</fragment>`)

  return root ? (children(root)[0] ?? null) : null
}

/** A CT_Boolean: an element without `val` says yes; undefined when there is no element. */
export function flag(element: XmlElement | undefined): boolean | undefined {
  if (!element) {
    return undefined
  }

  const value = element.attrs.val

  return value === undefined || value === '1' || value === 'true'
}

/** The number in an element's `val` ("75" or "75%"); undefined when there is none. */
export function numberIn(element: XmlElement | undefined): number | undefined {
  const value = Number.parseFloat(element?.attrs.val ?? '')

  return Number.isFinite(value) ? value : undefined
}

/** The theme slot of each scheme colour name, in the order themeColors gives them. */
const SCHEME_SLOT: Record<string, number> = { lt1: 0, bg1: 0, dk1: 1, tx1: 1, lt2: 2, bg2: 2, dk2: 3, tx2: 3, accent1: 4, accent2: 5, accent3: 6, accent4: 7, accent5: 8, accent6: 9, hlink: 10, folHlink: 11 }

const PRESET: Record<string, string> = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', lime: '00FF00', blue: '0000FF', yellow: 'FFFF00', orange: 'FFA500', gray: '808080', grey: '808080', silver: 'C0C0C0', navy: '000080', purple: '800080' }

const hex2 = (value: number): string => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation
  const p = 2 * lightness - q
  const channel = (t: number): number => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t

    return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p
  }

  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)].map((v) => hex2(v * 255)).join('')
}

/** A colour element's own colour as "RRGGBB", before its transforms. */
function baseColor(element: XmlElement, theme: string[]): string | undefined {
  const { val, lastClr } = element.attrs

  switch (element.name) {
    case 'a:srgbClr':
      return val
    case 'a:schemeClr':
      return theme[SCHEME_SLOT[val ?? ''] ?? -1]
    case 'a:sysClr':
      return lastClr ?? (val === 'window' ? 'FFFFFF' : '000000')
    case 'a:prstClr':
      return PRESET[val ?? '']
    case 'a:scrgbClr': {
      // scRGB is linear light; its gamma brings it back to sRGB closely enough.
      const linear = ['r', 'g', 'b'].map((key) => Math.max(0, Number(element.attrs[key]) / 100000 || 0))

      return linear.map((v) => hex2(Math.pow(v, 1 / 2.2) * 255)).join('')
    }
    case 'a:hslClr':
      return hslToHex((Number(element.attrs.hue) || 0) / 21600000, (Number(element.attrs.sat) || 0) / 100000, (Number(element.attrs.lum) || 0) / 100000)
    default:
      return undefined
  }
}

/**
 * The colour of the colour element under `parent` (srgbClr, schemeClr through the theme, sysClr, …),
 * as "#rrggbb", with its luminance, tint and shade worked out the way Office does closely enough.
 */
export function colorIn(parent: XmlElement | undefined, theme: string[]): string | undefined {
  for (const element of children(parent)) {
    const base = baseColor(element, theme)

    if (!base || !/^[0-9a-f]{6}$/i.test(base)) {
      continue
    }

    let color = `#${base.toLowerCase()}`
    let lumMod = 1
    let lumOff = 0

    for (const transform of children(element)) {
      const amount = (Number(transform.attrs.val) || 0) / 100000

      if (transform.name === 'a:lumMod') {
        lumMod = amount
      } else if (transform.name === 'a:lumOff') {
        lumOff = amount
      } else if (transform.name === 'a:tint') {
        color = mixed(color, '#ffffff', amount)
      } else if (transform.name === 'a:shade') {
        color = mixed(color, '#000000', amount)
      }
    }

    // Office's lighter and darker variants keep lumMod + lumOff at 1 or lumOff at 0, which a tint gives exactly.
    if (lumMod !== 1 || lumOff !== 0) {
      color = `#${tinted(color.slice(1), lumOff > 0 ? lumOff : lumMod - 1).toLowerCase()}`
    }

    return color
  }

  return undefined
}

/** What a fill or line draws with: a colour, nothing, or a colour standing in for a gradient, pattern or picture. */
export interface Paint {
  color?: string
  none?: boolean
  approximate?: 'gradient' | 'pattern' | 'picture'
}

/** The paint of the fill (EG_FillProperties) among an element's children; undefined when it has none. */
export function fillIn(parent: XmlElement | undefined, theme: string[]): Paint | undefined {
  for (const element of children(parent)) {
    switch (element.name) {
      case 'a:noFill':
        return { none: true }
      case 'a:solidFill':
        return { color: colorIn(element, theme) }
      case 'a:gradFill':
        return { color: colorIn(child(child(element, 'a:gsLst'), 'a:gs'), theme), approximate: 'gradient' }
      case 'a:pattFill':
        return { color: colorIn(child(element, 'a:fgClr'), theme), approximate: 'pattern' }
      case 'a:blipFill':
        return { approximate: 'picture' }
    }
  }

  return undefined
}

/** A colour as DrawingML writes it: `<a:srgbClr val="4472C4"/>`. */
export const srgb = (color: string): string => `<a:srgbClr val="${color.replace(/^#/, '').toUpperCase()}"/>`

export const solidFill = (color: string): string => `<a:solidFill>${srgb(color)}</a:solidFill>`
