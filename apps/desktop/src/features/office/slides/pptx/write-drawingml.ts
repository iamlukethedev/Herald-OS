import type { Background, Box, Color, CustomPath, Fill, FontRef, Gradient, Paragraph, RunStyle, Stroke, TextBody } from '../deck.ts'
import { EMU_PER_POINT } from '../deck.ts'
import { isSlot } from '../themes.ts'
import { bulletFor, numberingFor, paragraphIndent } from '../text.ts'
import { xml, type XmlElement, type XmlNode } from './xml.ts'

/*
 * DrawingML as Herald writes it: colours, fills (gradients too), lines, text settings, run looks,
 * backgrounds and geometry (presets with their adjust values, and freeforms), and where each goes in
 * a shape's properties, whose children the schema keeps in order.
 */

export const emu = (points: number): string => String(Math.round(points * EMU_PER_POINT))

const percent = (fraction: number): number => Math.round(Math.max(0, Math.min(1, fraction)) * 100000)

/** A colour element: a theme slot by name or a literal, with its opacity. */
export function colorXml(color: Color, alpha?: number): XmlElement {
  const opacity = alpha !== undefined && alpha < 1 ? [xml('a:alpha', { val: Math.round(Math.max(0, alpha) * 100000) })] : []

  return isSlot(color) ? xml('a:schemeClr', { val: color }, opacity) : xml('a:srgbClr', { val: color.slice(1).toUpperCase() }, opacity)
}

export const solidFill = (color: Color, alpha?: number): XmlElement => xml('a:solidFill', {}, [colorXml(color, alpha)])

/** An angle as DrawingML has it: 60,000ths of a degree clockwise, less than a full turn. */
export const angleXml = (degrees: number): number => Math.round((((degrees % 360) + 360) % 360) * 60000)

/** A gradient: its stops with their opacity, along a line at its angle or spreading from the middle. */
export function gradientXml(gradient: Pick<Gradient, 'stops' | 'angle' | 'radial'>): XmlElement {
  const stops = [...gradient.stops].sort((a, b) => a.at - b.at).map((stop) => xml('a:gs', { pos: percent(stop.at) }, [colorXml(stop.color, stop.alpha)]))
  const shade = gradient.radial ? xml('a:path', { path: 'circle' }, [xml('a:fillToRect', { l: 50000, t: 50000, r: 50000, b: 50000 })]) : xml('a:lin', { ang: angleXml(gradient.angle), scaled: '0' })

  return xml('a:gradFill', { rotWithShape: '1' }, [xml('a:gsLst', {}, stops), shade])
}

/** A fill: none, a colour, or a gradient (which needs two stops at least). */
export function fillXml(fill: Fill | null): XmlElement {
  if (!fill) {
    return xml('a:noFill')
  }

  return fill.gradient && fill.gradient.stops.length >= 2 ? gradientXml(fill.gradient) : solidFill(fill.color, fill.alpha)
}

const DASH = { solid: 'solid', dash: 'dash', dot: 'sysDot', dashDot: 'dashDot', longDash: 'lgDash' } as const

/** A line (`a:ln`, or a table cell's side) in a stroke's colour, width and dash, or none. */
export function lineXml(stroke: Stroke | null | undefined, name = 'a:ln', attrs: Record<string, string> = {}): XmlElement {
  if (!stroke || stroke.width <= 0) {
    return xml(name, {}, [xml('a:noFill')])
  }

  return xml(name, { w: emu(stroke.width), ...attrs }, [solidFill(stroke.color, stroke.alpha), xml('a:prstDash', { val: DASH[stroke.dash] })])
}

const ALIGN = { left: 'l', center: 'ctr', right: 'r', justify: 'just' } as const

/** A paragraph's settings as PowerPoint reads them, all spelled out so a layout's defaults never apply. */
export function paragraphXml(paragraph: Omit<Paragraph, 'runs'>): XmlElement {
  const { margin, indent } = paragraphIndent({ ...paragraph, runs: [] })
  const level = paragraph.level ?? 0
  const points = (name: string, value: number | undefined) => xml(name, {}, [xml('a:spcPts', { val: Math.round((value ?? 0) * 100) })])
  const bullet: XmlNode[] =
    paragraph.list === 'bullet'
      ? [xml('a:buClrTx'), xml('a:buSzTx'), xml('a:buFontTx'), xml('a:buChar', { char: paragraph.bullet || bulletFor(level) })]
      : paragraph.list === 'number'
        ? [xml('a:buClrTx'), xml('a:buSzTx'), xml('a:buFontTx'), xml('a:buAutoNum', { type: paragraph.numbering ?? numberingFor(level), startAt: paragraph.startAt && paragraph.startAt !== 1 ? paragraph.startAt : undefined })]
        : [xml('a:buNone')]

  return xml('a:pPr', { marL: emu(margin), indent: emu(indent), algn: ALIGN[paragraph.align ?? 'left'], lvl: level || undefined }, [
    xml('a:lnSpc', {}, [xml('a:spcPct', { val: Math.round((paragraph.lineSpacing ?? 1) * 100000) })]),
    points('a:spcBef', paragraph.spaceBefore),
    points('a:spcAft', paragraph.spaceAfter),
    ...bullet
  ])
}

/** A text box's settings; `shrink` is the factor its text shrinks to, as last drawn (PowerPoint shows it so until the text is edited). */
export function bodyPropertiesXml(body: TextBody, shrink?: number): XmlElement {
  const [left, top, right, bottom] = body.inset
  const scale = shrink !== undefined && shrink < 1 ? Math.round(shrink * 100000) : undefined
  const fit = body.fit === 'shrink' ? [xml('a:normAutofit', { fontScale: scale })] : body.fit === 'grow' ? [xml('a:spAutoFit')] : []

  return xml('a:bodyPr', { wrap: body.wrap ? 'square' : 'none', lIns: emu(left), tIns: emu(top), rIns: emu(right), bIns: emu(bottom), rtlCol: '0', anchor: body.anchor === 'middle' ? 'ctr' : body.anchor === 'bottom' ? 'b' : 't' }, fit)
}

/** A font as DrawingML names it: the theme's heading or body font by reference, or a family. */
export function fontXml(font: FontRef): XmlElement[] {
  if (font === '+heading' || font === '+body') {
    const scheme = font === '+heading' ? 'mj' : 'mn'

    return [xml('a:latin', { typeface: `+${scheme}-lt` }), xml('a:ea', { typeface: `+${scheme}-ea` }), xml('a:cs', { typeface: `+${scheme}-cs` })]
  }

  return [xml('a:latin', { typeface: font })]
}

const flagXml = (value: boolean | undefined): string | undefined => (value === undefined ? undefined : value ? '1' : '0')

/** A run's look as run properties (`a:rPr`), or a list level's default (`a:defRPr`): only what the style says. */
export function runPropertiesXml(name: string, style: RunStyle, attrs: Record<string, string | number | undefined> = {}): XmlElement {
  return xml(
    name,
    {
      ...attrs,
      sz: style.size !== undefined ? Math.round(style.size * 100) : undefined,
      b: flagXml(style.bold),
      i: flagXml(style.italic),
      u: style.underline === undefined ? undefined : style.underline ? 'sng' : 'none',
      strike: style.strike === undefined ? undefined : style.strike ? 'sngStrike' : 'noStrike'
    },
    [...(style.color ? [solidFill(style.color)] : []), ...(style.highlight ? [xml('a:highlight', {}, [colorXml(style.highlight)])] : []), ...(style.font ? fontXml(style.font) : [])]
  )
}

/** A background of a colour or a gradient (pictures are written with their part); PowerPoint's own for none. */
export function backgroundXml(background: Background | null): XmlElement | null {
  if (!background) {
    return xml('p:bg', {}, [xml('p:bgRef', { idx: 1001 }, [xml('a:schemeClr', { val: 'bg1' })])])
  }

  if (background.kind === 'image') {
    return null
  }

  const fill = background.kind === 'solid' ? solidFill(background.color) : gradientXml(background)

  return xml('p:bg', {}, [xml('p:bgPr', {}, [fill, xml('a:effectLst')])])
}

/** A box with its rotation and flips, as a shape's `a:xfrm`. */
export function transformXml(box: Box & { rotation?: number; flipH?: boolean; flipV?: boolean }, name = 'a:xfrm'): XmlElement {
  const attrs = { rot: box.rotation ? String(Math.round(box.rotation * 60000)) : undefined, flipH: box.flipH ? '1' : undefined, flipV: box.flipV ? '1' : undefined }

  return xml(name, attrs, [xml('a:off', { x: emu(box.x), y: emu(box.y) }), xml('a:ext', { cx: emu(box.width), cy: emu(box.height) })])
}

export function presetGeometryXml(preset: string, adjust?: Record<string, number>): XmlElement {
  return xml('a:prstGeom', { prst: preset }, [
    xml(
      'a:avLst',
      {},
      Object.entries(adjust ?? {}).map(([name, value]) => xml('a:gd', { name, fmla: `val ${Math.round(value)}` }))
    )
  ])
}

const PATH_TOKENS = /[MLCQZ]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g

const PATH_ARGUMENTS = { M: 2, L: 2, C: 6, Q: 4, Z: 0 } as const

type PathCommand = { command: keyof typeof PATH_ARGUMENTS; values: number[] }

/** SVG path data of absolute M, L, C, Q and Z commands, numbers repeating a command as SVG has them (a moveto's extra pairs are linetos). */
function pathCommands(d: string): PathCommand[] {
  const commands: PathCommand[] = []
  let command: PathCommand['command'] | null = null
  let values: number[] = []

  for (const token of d.match(PATH_TOKENS) ?? []) {
    if (token in PATH_ARGUMENTS) {
      command = token as PathCommand['command']
      values = []

      if (command === 'Z') {
        commands.push({ command, values: [] })
      }

      continue
    }

    if (!command || command === 'Z') {
      continue
    }

    values.push(Number(token))

    if (values.length === PATH_ARGUMENTS[command]) {
      commands.push({ command, values })
      values = []
      command = command === 'M' ? 'L' : command
    }
  }

  return commands
}

/** How much a path's units are multiplied by so its numbers, written as whole numbers, keep five significant digits. */
function pathScale(path: CustomPath, commands: readonly PathCommand[]): number {
  const numbers = [path.width, path.height, ...commands.flatMap((entry) => entry.values)]

  if (numbers.every(Number.isInteger)) {
    return 1
  }

  return 10 ** Math.max(0, Math.ceil(Math.log10(100000 / Math.max(path.width, path.height, 1))))
}

const PATH_ELEMENTS = { M: 'a:moveTo', L: 'a:lnTo', C: 'a:cubicBezTo', Q: 'a:quadBezTo' } as const

/** Freeform outlines as DrawingML's custom geometry, text placed in the whole box. */
export function customGeometryXml(paths: readonly CustomPath[]): XmlElement {
  const pathList = paths.map((path) => {
    const commands = pathCommands(path.d)
    const scale = pathScale(path, commands)
    const segments = commands.map(({ command, values }) => {
      if (command === 'Z') {
        return xml('a:close')
      }

      const points: XmlElement[] = []

      for (let at = 0; at < values.length; at += 2) {
        points.push(xml('a:pt', { x: Math.round(values[at] * scale), y: Math.round(values[at + 1] * scale) }))
      }

      return xml(PATH_ELEMENTS[command], {}, points)
    })

    return xml('a:path', { w: Math.round(path.width * scale), h: Math.round(path.height * scale), fill: path.fill === false ? 'none' : undefined, stroke: path.stroke === false ? '0' : undefined }, segments)
  })

  return xml('a:custGeom', {}, [xml('a:avLst'), xml('a:gdLst'), xml('a:ahLst'), xml('a:cxnLst'), xml('a:rect', { l: 'l', t: 't', r: 'r', b: 'b' }), xml('a:pathLst', {}, pathList)])
}

const GEOMETRY = ['a:custGeom', 'a:prstGeom']
const FILLS = ['a:noFill', 'a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill']

/** Put `node` in shape properties in place of whichever of `names` is there, else just after the last of `after`. */
function place(spPr: XmlElement, node: XmlElement, names: readonly string[], after: readonly string[]): void {
  const at = spPr.children.findIndex((entry) => typeof entry !== 'string' && names.includes(entry.name))

  if (at >= 0) {
    spPr.children[at] = node
    spPr.children = spPr.children.filter((entry, index) => index <= at || typeof entry === 'string' || !names.includes(entry.name))

    return
  }

  let index = -1
  spPr.children.forEach((entry, position) => {
    if (typeof entry !== 'string' && after.includes(entry.name)) {
      index = position
    }
  })
  spPr.children.splice(index + 1, 0, node)
}

export const setTransform = (spPr: XmlElement, box: Parameters<typeof transformXml>[0]): void => place(spPr, transformXml(box), ['a:xfrm'], [])

export const setGeometry = (spPr: XmlElement, geometry: XmlElement): void => place(spPr, geometry, GEOMETRY, ['a:xfrm'])

export const setFill = (spPr: XmlElement, fill: XmlElement): void => place(spPr, fill, FILLS, ['a:xfrm', ...GEOMETRY])

export const setLine = (spPr: XmlElement, line: XmlElement): void => place(spPr, line, ['a:ln'], ['a:xfrm', ...GEOMETRY, ...FILLS])
