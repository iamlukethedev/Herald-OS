import { type Icon, IconBox, IconChartBar, IconMovie, IconPackage, IconPhoto, IconSitemap } from '@tabler/icons-react'
import { type CSSProperties, memo, type ReactNode, useLayoutEffect, useRef } from 'react'
import type {
  Background,
  Box,
  Deck,
  Fill,
  FooterRole,
  ImageElement,
  ObjectElement,
  ObjectKind,
  ShapeElement,
  Slide,
  SlideElement,
  Stroke,
  TableCell,
  TableElement,
  TextBody,
  TextElement,
  Theme
} from '../deck.ts'
import { footersOf } from '../footers.ts'
import { backgroundOf, decorationsOf, isEmptyPlaceholder, isFooterRole } from '../layouts.ts'
import { customParts, shapeParts, textArea } from '../shapes.ts'
import type { CellRef } from '../tables.ts'
import { cssColor, resolveColor, themeOf } from '../themes.ts'
import { effectiveStyle, isBlank, listMarkers } from '../text.ts'
import { fitText, shrinkFactors } from './fit.ts'
import { LineView } from './LineView.tsx'
import { gradientCss, ShapeGeometry } from './paint.tsx'
import { addSlideStyles } from './slide-css.ts'
import { flowCss, paragraphCss, runCss } from './text-style.ts'

/*
 * A slide drawn in the page: its background, the master's and its layout's drawings, its own
 * elements and its date, footer and slide number, positioned in points and scaled as a whole. The
 * same view is the slide being edited (with placeholders' prompts), the slide list, the presented
 * slide and the printed page. Only the slide's own elements can be picked.
 */

export type ViewMode = 'edit' | 'thumb' | 'present' | 'print'

/** The text editor, drawn in place of one element's text (one cell's, in a table). */
export interface EditingSlot {
  id: string
  cell?: CellRef | null
  render: (body: TextBody) => ReactNode
}

export function backgroundCss(background: Background | null, theme: Theme): CSSProperties {
  if (!background || background.kind === 'solid') {
    return { backgroundColor: resolveColor(background?.color ?? 'bg1', theme) }
  }

  if (background.kind === 'gradient') {
    return { backgroundColor: theme.colors.bg1, backgroundImage: gradientCss(background, theme) }
  }

  return { backgroundColor: theme.colors.bg1, backgroundImage: `url("${background.src}")` }
}

/** A fill as a CSS background (a table cell's). */
function fillCss(fill: Fill | null, theme: Theme): CSSProperties {
  if (!fill) {
    return {}
  }

  return fill.gradient ? { backgroundImage: gradientCss(fill.gradient, theme) } : { backgroundColor: cssColor(fill.color, theme, fill.alpha) }
}

function Paragraphs({ body, theme, prompt }: { body: TextBody; theme: Theme; prompt?: string }) {
  const paragraphs = prompt ? [{ ...body.paragraphs[0], runs: [{ text: prompt }] }] : body.paragraphs
  const markers = listMarkers(paragraphs)

  return (
    <>
      {paragraphs.map((paragraph, index) => {
        const marker = markers[index]
        const empty = paragraph.runs.every((run) => !run.text)

        return (
          <p key={index} className={prompt ? 'hs-p hs-prompt' : 'hs-p'} data-marker={marker ?? undefined} style={paragraphCss(paragraph, body, theme, marker) as CSSProperties}>
            {empty ? (
              <br />
            ) : (
              paragraph.runs.map((run, at) => {
                const lines = run.text.split('\n')

                return (
                  <span key={at} style={runCss(effectiveStyle(run, body), theme) as CSSProperties}>
                    {lines.map((line, n) => (n ? [<br key={n} />, line] : line))}
                  </span>
                )
              })
            )}
          </p>
        )
      })}
    </>
  )
}

/** Where a body's text goes in its element, insets taken off. */
function innerBox(area: Box, body: TextBody): Box {
  const [left, top, right, bottom] = body.inset

  return { x: area.x + left, y: area.y + top, width: Math.max(1, area.width - left - right), height: Math.max(1, area.height - top - bottom) }
}

export function TextView({ body, theme, area, prompt, editor, upsideDown }: { body: TextBody; theme: Theme; area: Box; prompt?: string; editor?: ReactNode; upsideDown?: boolean }) {
  const flow = useRef<HTMLDivElement>(null)
  const inner = innerBox(area, body)

  useLayoutEffect(() => {
    if (flow.current && !editor) {
      if (body.fit === 'shrink') {
        shrinkFactors.set(body, fitText(flow.current, inner.height))
      } else {
        flow.current.style.removeProperty('--hs-shrink')
      }
    }
  })

  return (
    <div className="hs-text" data-anchor={body.anchor} style={{ left: inner.x, top: inner.y, width: inner.width, height: inner.height, transform: upsideDown ? 'rotate(180deg)' : undefined }}>
      {editor ?? (
        <div ref={flow} className="hs-flow" data-wrap={body.wrap ? undefined : 'false'} style={flowCss(body, theme) as CSSProperties}>
          <Paragraphs body={body} theme={theme} prompt={prompt} />
        </div>
      )}
    </div>
  )
}

function mirrored(area: Box, element: SlideElement): Box {
  return { ...area, x: element.flipH ? element.width - area.x - area.width : area.x, y: element.flipV ? element.height - area.y - area.height : area.y }
}

function PictureView({ element, theme, mode }: { element: ImageElement; theme: Theme; mode: ViewMode }) {
  if (!element.src) {
    return mode === 'edit' ? (
      <div className="hs-empty-picture">
        <IconPhoto size={34} stroke={1.4} />
        <span>{element.placeholder?.prompt ?? 'Picture'}</span>
      </div>
    ) : null
  }

  const crop = element.crop ?? { left: 0, top: 0, right: 0, bottom: 0 }
  const width = element.width / Math.max(0.01, 1 - crop.left - crop.right)
  const height = element.height / Math.max(0.01, 1 - crop.top - crop.bottom)
  const flip = element.flipH || element.flipV ? `scale(${element.flipH ? -1 : 1}, ${element.flipV ? -1 : 1})` : undefined
  const { stroke } = element

  return (
    <>
      <div className="hs-picture" style={{ transform: flip }}>
        <img src={element.src} alt={element.alt ?? ''} draggable={false} style={{ left: -crop.left * width, top: -crop.top * height, width, height }} />
      </div>
      {stroke && stroke.width > 0 && <ShapeGeometry parts={shapeParts('rect', element.width, element.height)} fill={null} stroke={stroke} theme={theme} width={element.width} height={element.height} />}
    </>
  )
}

const DASH_STYLES = { solid: 'solid', dash: 'dashed', dot: 'dotted', dashDot: 'dashed', longDash: 'dashed' } as const

const SIDES = ['left', 'top', 'right', 'bottom'] as const

/** One side of a cell: a line centred on the cell's edge, reaching half its width past the corners so lines meet. */
function sideCss(side: (typeof SIDES)[number], line: Stroke, theme: Theme): CSSProperties {
  const half = line.width / 2
  const border = `${line.width}px ${DASH_STYLES[line.dash]} ${cssColor(line.color, theme, line.alpha)}`

  switch (side) {
    case 'left':
      return { left: -half, top: -half, bottom: -half, width: 0, borderLeft: border }
    case 'right':
      return { right: -half, top: -half, bottom: -half, width: 0, borderRight: border }
    case 'top':
      return { top: -half, left: -half, right: -half, height: 0, borderTop: border }
    default:
      return { bottom: -half, left: -half, right: -half, height: 0, borderBottom: border }
  }
}

/** A cell's own line for a side where it has one (null: none), else the table's. */
const sideLine = (cell: TableCell, table: TableElement, side: (typeof SIDES)[number]): Stroke | null => (cell.borders?.[side] === undefined ? table.stroke : cell.borders[side])

/**
 * A table as a grid: each row at least its height and as tall as its text, each cell filled and
 * padded by its insets with its text placed as its anchor says. Each cell draws its own sides,
 * centred on its edges over every cell's fill, so neighbours share one line and the text does not
 * move for them.
 */
function TableView({ table, theme, editor, cell: editing }: { table: TableElement; theme: Theme; editor?: EditingSlot['render']; cell?: CellRef | null }) {
  const across = table.columns.reduce((sum, width) => sum + width, 0) || 1
  const down = table.rows.reduce((sum, height) => sum + height, 0) || 1

  return (
    <div
      className="hs-table"
      style={{
        gridTemplateColumns: table.columns.map((width) => `${(width / across) * table.width}px`).join(' '),
        gridTemplateRows: table.rows.map((height) => `minmax(${(height / down) * table.height}px, auto)`).join(' ')
      }}
    >
      {table.cells.flatMap((row, r) =>
        row.map((cell, c) => {
          if (cell.merged) {
            return null
          }

          const [left, top, right, bottom] = cell.body.inset
          const typing = editor && editing?.row === r && editing.column === c

          return (
            <div
              key={`${r}:${c}`}
              className="hs-cell"
              data-row={r}
              data-column={c}
              data-anchor={cell.body.anchor}
              style={{
                gridRow: `${r + 1} / span ${cell.rowSpan ?? 1}`,
                gridColumn: `${c + 1} / span ${cell.colSpan ?? 1}`,
                padding: `${top}px ${right}px ${bottom}px ${left}px`,
                ...fillCss(cell.fill, theme)
              }}
            >
              {typing ? (
                editor(cell.body)
              ) : (
                <div className="hs-flow" style={flowCss(cell.body, theme) as CSSProperties}>
                  <Paragraphs body={cell.body} theme={theme} />
                </div>
              )}
              {SIDES.map((side) => {
                const line = sideLine(cell, table, side)

                return line && line.width > 0 ? <span key={side} className="hs-side" data-side={side} style={sideCss(side, line, theme)} /> : null
              })}
            </div>
          )
        })
      )}
    </div>
  )
}

const OBJECT_NAMES: Record<ObjectKind, string> = { chart: 'Chart', diagram: 'SmartArt', ole: 'Embedded object', media: 'Media', other: 'Object' }

const OBJECT_ICONS: Record<ObjectKind, Icon> = { chart: IconChartBar, diagram: IconSitemap, ole: IconPackage, media: IconMovie, other: IconBox }

const KEPT = { 'data-kept': '' }

/** Something kept from a file: the picture it has, else its drawing stretched to its box, else a quiet box saying what it is. */
function ObjectView({ element, theme, mode }: { element: ObjectElement; theme: Theme; mode: ViewMode }) {
  const name = OBJECT_NAMES[element.object] ?? OBJECT_NAMES.other

  if (element.preview?.src) {
    return (
      <div className="hs-picture">
        <img src={element.preview.src} alt={name} draggable={false} style={{ left: 0, top: 0, width: element.width, height: element.height }} />
      </div>
    )
  }

  if (element.shapes?.length) {
    const from = element.drawnIn ?? { width: element.width, height: element.height }
    const sx = from.width > 0 ? element.width / from.width : 1
    const sy = from.height > 0 ? element.height / from.height : 1

    return (
      <div className="hs-kept-drawing" style={{ width: from.width, height: from.height, transform: sx !== 1 || sy !== 1 ? `scale(${sx}, ${sy})` : undefined }}>
        {element.shapes.map((shape, index) => (
          <ElementView key={`${index}:${shape.id}`} element={shape} theme={theme} mode={mode} mark={KEPT} />
        ))}
      </div>
    )
  }

  const Icon = OBJECT_ICONS[element.object] ?? OBJECT_ICONS.other

  return (
    <div className="hs-kept">
      <Icon size={28} stroke={1.4} />
      <span>{name} (kept from the file)</span>
    </div>
  )
}

export function ElementView({
  element,
  theme,
  mode,
  hidden,
  editor,
  cell,
  mark
}: {
  element: SlideElement
  theme: Theme
  mode: ViewMode
  hidden?: boolean
  editor?: EditingSlot['render']
  cell?: CellRef | null
  /** Drawn only, never picked: the attributes it is marked with in place of its id (`data-decoration`, `data-footer`…). */
  mark?: Record<`data-${string}`, string>
}) {
  const style: CSSProperties = {
    left: element.x,
    top: element.y,
    width: element.width,
    height: element.height,
    transform: element.rotation ? `rotate(${element.rotation}deg)` : undefined,
    visibility: hidden ? 'hidden' : undefined,
    pointerEvents: element.kind === 'line' || mark ? 'none' : undefined
  }
  const prompt = mode === 'edit' && !editor && !mark && isEmptyPlaceholder(element) ? element.placeholder?.prompt : undefined

  if ((mode !== 'edit' || mark) && isEmptyPlaceholder(element)) {
    return null
  }

  let content: ReactNode

  if (element.kind === 'text' || element.kind === 'shape') {
    const full = { x: 0, y: 0, width: element.width, height: element.height }
    const custom = element.kind === 'shape' && element.paths?.length ? element.paths : null
    const parts = custom ? customParts(custom, element.width, element.height) : shapeParts(element.kind === 'shape' ? element.shape : 'rect', element.width, element.height, element.kind === 'shape' ? element.adjust : undefined)
    const area = element.kind === 'shape' && !custom ? mirrored(textArea(element.shape, element.width, element.height, element.adjust), element) : full
    const showsText = Boolean(editor) || Boolean(prompt) || !isBlank(element.body)

    content = (
      <>
        <ShapeGeometry parts={parts} fill={element.fill} stroke={element.stroke} theme={theme} width={element.width} height={element.height} flipH={element.flipH} flipV={element.flipV} />
        {showsText && <TextView body={element.body} theme={theme} area={area} prompt={prompt} editor={editor?.(element.body)} upsideDown={element.flipV} />}
      </>
    )
  } else if (element.kind === 'image') {
    content = <PictureView element={element} theme={theme} mode={mode} />
  } else if (element.kind === 'table') {
    content = <TableView table={element} theme={theme} editor={editor} cell={cell} />
  } else if (element.kind === 'line') {
    content = <LineView element={element} theme={theme} hit={mode === 'edit' && !mark} />
  } else {
    content = <ObjectView element={element} theme={theme} mode={mode} />
  }

  return (
    <div className="hs-el" {...(mark ?? { 'data-element-id': element.id })} style={style}>
      {content}
    </div>
  )
}

/** A footer's place on the master or layout with its text: its box, look, alignment and anchor, and the one run of text. */
function footerElement(place: TextElement | ShapeElement, text: string): TextElement | ShapeElement {
  const first = place.body.paragraphs[0] ?? { runs: [] }
  const paragraph = { ...first, list: undefined, runs: [{ ...first.runs[0], text }] }

  return { ...place, placeholder: undefined, body: { ...place.body, paragraphs: [paragraph] } }
}

/** Where a slide is in its deck (the same slide, or one with its id); -1 when the deck has no slides or not this one. */
function positionOf(slides: readonly Slide[] | undefined, slide: Slide): number {
  const at = slides?.indexOf(slide) ?? -1

  return at >= 0 || !slides ? at : slides.findIndex((entry) => entry.id === slide.id)
}

const DECORATION = { 'data-decoration': '' }

const BEHIND = { 'data-decoration': 'behind' }

export interface SlideViewProps {
  /** The deck's master and header and footer settings, where given, put the master's drawings and the footers on the slide. */
  deck: Pick<Deck, 'size' | 'theme'> & Partial<Pick<Deck, 'master' | 'headerFooter' | 'slides' | 'transition'>>
  slide: Slide
  /** CSS pixels a point. */
  scale: number
  mode: ViewMode
  /** The slide's place in the deck (0 first) for its slide number, where `deck.slides` does not say. */
  index?: number
  /** False draws only the slide's own background and elements: no layout or master behind them, and no footers. */
  inherit?: boolean
  /** Drawn under the slide's own elements and never picked (the master's drawings behind a layout being edited). */
  behind?: readonly SlideElement[]
  /** Elements left out of the drawing (a picture being placed). */
  hide?: ReadonlySet<string>
  editing?: EditingSlot | null
  className?: string
  style?: CSSProperties
  children?: ReactNode
}

/** A slide at `scale`; `children` go over it, inside the scaled slide (in points). */
export const SlideView = memo(function SlideView({ deck, slide, scale, mode, index, inherit = true, behind, hide, editing, className, style, children }: SlideViewProps) {
  addSlideStyles()
  const { width, height } = deck.size
  const theme = themeOf(deck, slide)
  const background = inherit ? backgroundOf(deck, slide) : slide.background
  const decorations = inherit ? decorationsOf(deck, slide.layout, slide) : []
  const at = index ?? positionOf(deck.slides, slide)
  const own = new Set<FooterRole>(
    slide.elements.flatMap((element) => {
      const role = element.placeholder?.role

      return isFooterRole(role) ? [role] : []
    })
  )
  const footers = inherit ? footersOf(deck, slide, Math.max(0, at)).filter((footer) => (footer.role !== 'number' || at >= 0) && !own.has(footer.role)) : []

  return (
    <div className={className} style={{ position: 'relative', overflow: 'hidden', width: width * scale, height: height * scale, ...style }} data-slide-id={slide.id}>
      <div className="hs-slide" style={{ width, height, transform: `scale(${scale})`, ...backgroundCss(background, theme) }}>
        {decorations.map((element, n) => (
          <ElementView key={`d${n}:${element.id}`} element={element} theme={theme} mode={mode} mark={DECORATION} />
        ))}
        {behind?.map((element, n) => (
          <ElementView key={`b${n}:${element.id}`} element={element} theme={theme} mode={mode} mark={BEHIND} />
        ))}
        {slide.elements.map((element) => (
          <ElementView key={element.id} element={element} theme={theme} mode={mode} hidden={hide?.has(element.id)} editor={editing?.id === element.id ? editing.render : undefined} cell={editing?.id === element.id ? editing.cell : undefined} />
        ))}
        {footers.map((footer) => (
          <ElementView key={`f:${footer.role}`} element={footerElement(footer.place, footer.text)} theme={theme} mode={mode} mark={{ 'data-footer': footer.role }} />
        ))}
        {children}
      </div>
    </div>
  )
})
