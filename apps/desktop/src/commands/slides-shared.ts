import type { CommandArg, CommandContext } from '../store/os-commands.ts'

/* What Herald Slides' commands share: the arguments that name a presentation, a slide and what is on it, the theme and shape words, and where they run. */

export const office = () => import('../features/office/agent.ts')

export const presentation: CommandArg = { name: 'presentation', type: 'string', description: 'The presentation: a .pptx file (full path or ~/…) or the name of an open presentation as its tab shows it; the one in front in Herald Slides when left out' }

export const slide: CommandArg = { name: 'slide', type: 'string', description: 'A slide: its number (1 is the first), its id, or its title; the slide in front when left out' }

/** A slide argument that names several: numbers, ids or titles with commas between them, ranges, or all. */
export const slides = (fallback: string): CommandArg => ({ name: 'slide', type: 'string', description: `The slides: a number (1 is the first), an id or a title, several with commas between them ("2, 4-6"), or all; ${fallback} when left out` })

export const theme: CommandArg = {
  name: 'theme',
  type: 'string',
  description:
    'herald (white with navy text and blue accents; the default), midnight (dark navy with light text), paper (warm cream with serif type), graphite (dark grey with yellow accents), forest (pale with green accents), coral (warm peach and coral), mono (black and white with a red accent), ocean (pale blue and teal), aurora (deep blue with a soft glow and bright accents), dune (a cream-to-sand gradient with serif headings and rust accents), slate (cool off-white with blue accents and serif headings), blossom (a pale pink gradient with pink and violet accents) or ember (dark warm brown with orange and amber accents); or a custom theme’s id or name (slides.listThemes)'
}

export const x: CommandArg = { name: 'x', type: 'number', description: 'Left edge in points from the slide’s left (a wide slide is 960 by 540 points, a standard one 720 by 540); centred when left out' }
export const y: CommandArg = { name: 'y', type: 'number', description: 'Top edge in points from the slide’s top; centred when left out' }
export const width: CommandArg = { name: 'width', type: 'number', description: 'Width in points' }
export const height: CommandArg = { name: 'height', type: 'number', description: 'Height in points' }

export const color = (what: string): CommandArg => ({ name: 'color', type: 'string', description: `${what}: #rrggbb, a name like navy or teal, or a theme colour (accent1 to accent6, text, background)` })

export const fill: CommandArg = { name: 'fill', type: 'string', description: 'Fill colour: #rrggbb, a name like navy or teal, a theme colour (accent1 to accent6, text, background), or none' }

/** A gradient's colours, its angle and whether it spreads from the middle. */
export const gradient: readonly CommandArg[] = [
  { name: 'gradient', type: 'string', description: 'A gradient in place of one colour: two or more colours from first to last, with commas between them or "to" ("navy to teal", "accent1, accent2", "#13204a, #2563eb 60%, white"); theme colours follow the theme' },
  { name: 'angle', type: 'number', description: 'The gradient’s angle in degrees: 90 runs top to bottom (the default), 0 left to right, 45 from the top left' },
  { name: 'radial', type: 'boolean', description: 'The gradient spreads from the middle out instead of along the angle' }
]

export const shapeKind: CommandArg = {
  name: 'kind',
  type: 'string',
  description:
    'rect (the default), roundRect, ellipse, triangle, diamond, or any of PowerPoint’s presets by name, in families: rectangles (snip1Rect, round2SameRect, plaque), basic shapes (pentagon, hexagon, octagon, plus, can, cube, donut, heart, sun, moon, cloud, lightningBolt, smileyFace, frame, pie, teardrop), brackets and braces (bracketPair, bracePair, leftBracket, rightBrace), arrows (rightArrow, leftArrow, upArrow, downArrow, leftRightArrow, upDownArrow, quadArrow, bentArrow, uturnArrow, notchedRightArrow, chevron, homePlate), math (mathPlus, mathMinus, mathMultiply, mathDivide, mathEqual, mathNotEqual), flowchart (flowChartProcess, flowChartDecision, flowChartTerminator, flowChartInputOutput, flowChartDocument, flowChartPredefinedProcess, flowChartConnector, flowChartMagneticDisk), stars and banners (star4, star5, star6, star8, star12, wave, doubleWave) and callouts (wedgeRectCallout, wedgeRoundRectCallout, wedgeEllipseCallout, cloudCallout); words like rectangle, circle, star, arrow, callout, cylinder or decision work too'
}

/** Where a master command works. */
export const masterLayout = (what: string): CommandArg => ({ name: 'layout', type: 'string', description: `${what}: master (the slide master, whose graphics every slide shows; the default) or one of its layouts: title, title-content, two-content, comparison, section, title-only, blank or picture-caption (or its name)` })

/** The workbook, range and sheet a table comes from. */
export const sheetArgs: readonly CommandArg[] = [
  { name: 'workbook', type: 'string', description: 'The workbook: a file (full path or ~/…) or an open workbook’s name; the one in front in Herald Sheets when left out' },
  { name: 'range', type: 'string', description: 'The cells, like A1:D12 or \'Q1 sales\'!B2:F9, or selection for what is selected in an open workbook; the cells that hold something on the sheet when left out' },
  { name: 'sheet', type: 'string', description: 'The sheet, when the range does not name it; the one in front when left out' }
]

export const elements: CommandArg = { name: 'elements', type: 'string', description: 'The elements, as a JSON list or with commas between them: their ids as slides.read gives them (a group’s id names all of it), or their numbers in its list from 1' }

type Work = (args: Record<string, unknown>, context: CommandContext) => Promise<{ summary: string; data?: Record<string, unknown> }>

/** Run where the presentation lives: here, or in its own window (panels mode). */
export const run = (id: string, work: Work) => async (args: Record<string, unknown>, context: CommandContext) => (await office()).inOwnWindow('slides', id, args, 'presentation', context, () => work(args, context))
