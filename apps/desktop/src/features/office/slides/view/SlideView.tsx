import { IconPhoto } from '@tabler/icons-react'
import { type CSSProperties, memo, type ReactNode, useLayoutEffect, useRef } from 'react'
import type { Background, Box, Deck, ImageElement, LineElement, ShapeElement, Slide, SlideElement, TableElement, TextBody, TextElement, Theme } from '../deck.ts'
import { lineEnds } from '../elements.ts'
import { isEmptyPlaceholder } from '../layouts.ts'
import { arrowHead, dashArray, shapePath, textArea } from '../shapes.ts'
import type { CellRef } from '../tables.ts'
import { cssColor, resolveColor } from '../themes.ts'
import { effectiveStyle, isBlank, listMarkers } from '../text.ts'
import { fitText, shrinkFactors } from './fit.ts'
import { addSlideStyles } from './slide-css.ts'
import { flowCss, paragraphCss, runCss } from './text-style.ts'

/*
 * A slide drawn in the page: its background and its elements, positioned in points and scaled as
 * a whole. The same view is the slide being edited (with placeholders' prompts), the slide list,
 * the presented slide and the printed page.
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
    const stops = [...background.stops].sort((a, b) => a.at - b.at).map((stop) => `${resolveColor(stop.color, theme)} ${Math.round(stop.at * 1000) / 10}%`)

    return { backgroundColor: theme.colors.bg1, backgroundImage: `linear-gradient(${background.angle + 90}deg, ${stops.join(', ')})` }
  }

  return { backgroundColor: theme.colors.bg1, backgroundImage: `url("${background.src}")` }
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

function Outline({ element, theme, path }: { element: TextElement | ShapeElement; theme: Theme; path: string }) {
  if (!element.fill && !element.stroke) {
    return null
  }

  const { fill, stroke } = element
  const flip = element.flipH || element.flipV ? `scale(${element.flipH ? -1 : 1}, ${element.flipV ? -1 : 1})` : undefined

  return (
    <svg className="hs-geom" width={Math.max(1, element.width)} height={Math.max(1, element.height)} style={{ transform: flip, transformOrigin: 'center' }} aria-hidden="true">
      <path
        d={path}
        fill={fill ? cssColor(fill.color, theme) : 'none'}
        fillOpacity={fill?.alpha}
        stroke={stroke && stroke.width > 0 ? cssColor(stroke.color, theme) : 'none'}
        strokeOpacity={stroke?.alpha}
        strokeWidth={stroke?.width}
        strokeDasharray={stroke ? dashArray(stroke.dash, stroke.width) : undefined}
        strokeLinejoin="miter"
      />
    </svg>
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
      {stroke && stroke.width > 0 && (
        <svg className="hs-geom" width={Math.max(1, element.width)} height={Math.max(1, element.height)} aria-hidden="true">
          <rect x={0} y={0} width={element.width} height={element.height} fill="none" stroke={cssColor(stroke.color, theme)} strokeOpacity={stroke.alpha} strokeWidth={stroke.width} strokeDasharray={dashArray(stroke.dash, stroke.width)} />
        </svg>
      )}
    </>
  )
}

function LineView({ element, theme, mode }: { element: LineElement; theme: Theme; mode: ViewMode }) {
  const ends = lineEnds({ ...element, x: 0, y: 0 })
  const { stroke } = element
  const head = arrowHead(element.end, ends.to, ends.from, stroke.width)
  const tail = arrowHead(element.start, ends.from, ends.to, stroke.width)
  const length = Math.hypot(ends.to[0] - ends.from[0], ends.to[1] - ends.from[1]) || 1
  const along = (point: [number, number], toward: [number, number], by: number): [number, number] => [point[0] + ((toward[0] - point[0]) / length) * by, point[1] + ((toward[1] - point[1]) / length) * by]
  const from = tail?.inset ? along(ends.from, ends.to, tail.inset) : ends.from
  const to = head?.inset ? along(ends.to, ends.from, head.inset) : ends.to
  const color = cssColor(stroke.color, theme)

  return (
    <svg className="hs-geom" width={Math.max(1, element.width)} height={Math.max(1, element.height)} aria-hidden="true">
      {mode === 'edit' && <path d={`M${ends.from[0]},${ends.from[1]} L${ends.to[0]},${ends.to[1]}`} stroke="transparent" strokeWidth={Math.max(12, stroke.width + 8)} style={{ pointerEvents: 'stroke' }} />}
      <path d={`M${from[0]},${from[1]} L${to[0]},${to[1]}`} fill="none" stroke={color} strokeOpacity={stroke.alpha} strokeWidth={stroke.width} strokeDasharray={dashArray(stroke.dash, stroke.width)} />
      {[head, tail].map((part, index) =>
        part ? <path key={index} d={part.d} fill={part.filled ? color : 'none'} fillOpacity={stroke.alpha} stroke={color} strokeOpacity={stroke.alpha} strokeWidth={part.filled ? stroke.width * 0.5 : stroke.width} strokeLinejoin="miter" /> : null
      )}
    </svg>
  )
}

const DASH_STYLES = { solid: 'solid', dash: 'dashed', dot: 'dotted', dashDot: 'dashed', longDash: 'dashed' } as const

/**
 * A table as a grid: each row at least its height and as tall as its text, each cell filled and
 * padded by its insets with its text placed as its anchor says. The lines are outlines centred on
 * the cells' edges, so neighbours share one line and the text does not move for them.
 */
function TableView({ table, theme, editor, cell: editing }: { table: TableElement; theme: Theme; editor?: EditingSlot['render']; cell?: CellRef | null }) {
  const across = table.columns.reduce((sum, width) => sum + width, 0) || 1
  const down = table.rows.reduce((sum, height) => sum + height, 0) || 1
  const { stroke } = table
  const line: CSSProperties = stroke && stroke.width > 0 ? { outline: `${stroke.width}px ${DASH_STYLES[stroke.dash]} ${cssColor(stroke.color, theme, stroke.alpha)}`, outlineOffset: -stroke.width / 2 } : {}

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
                backgroundColor: cell.fill ? cssColor(cell.fill.color, theme, cell.fill.alpha) : undefined,
                ...line
              }}
            >
              {typing ? (
                editor(cell.body)
              ) : (
                <div className="hs-flow" style={flowCss(cell.body, theme) as CSSProperties}>
                  <Paragraphs body={cell.body} theme={theme} />
                </div>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}

export function ElementView({ element, theme, mode, hidden, editor, cell }: { element: SlideElement; theme: Theme; mode: ViewMode; hidden?: boolean; editor?: EditingSlot['render']; cell?: CellRef | null }) {
  const style: CSSProperties = {
    left: element.x,
    top: element.y,
    width: element.width,
    height: element.height,
    transform: element.rotation ? `rotate(${element.rotation}deg)` : undefined,
    visibility: hidden ? 'hidden' : undefined,
    pointerEvents: element.kind === 'line' ? 'none' : undefined
  }
  const prompt = mode === 'edit' && !editor && isEmptyPlaceholder(element) ? element.placeholder?.prompt : undefined

  if (mode !== 'edit' && isEmptyPlaceholder(element)) {
    return null
  }

  let content: ReactNode

  if (element.kind === 'text' || element.kind === 'shape') {
    const full = { x: 0, y: 0, width: element.width, height: element.height }
    const path = element.kind === 'shape' ? shapePath(element.shape, element.width, element.height, element.adjust) : shapePath('rect', element.width, element.height)
    const area = element.kind === 'shape' ? mirrored(textArea(element.shape, element.width, element.height, element.adjust), element) : full
    const showsText = Boolean(editor) || Boolean(prompt) || !isBlank(element.body)

    content = (
      <>
        <Outline element={element} theme={theme} path={path} />
        {showsText && <TextView body={element.body} theme={theme} area={area} prompt={prompt} editor={editor?.(element.body)} upsideDown={element.flipV} />}
      </>
    )
  } else if (element.kind === 'image') {
    content = <PictureView element={element} theme={theme} mode={mode} />
  } else if (element.kind === 'table') {
    content = <TableView table={element} theme={theme} editor={editor} cell={cell} />
  } else if (element.kind === 'line') {
    content = <LineView element={element} theme={theme} mode={mode} />
  } else {
    content = null
  }

  return (
    <div className="hs-el" data-element-id={element.id} style={style}>
      {content}
    </div>
  )
}

export interface SlideViewProps {
  deck: Pick<Deck, 'size' | 'theme'>
  slide: Slide
  /** CSS pixels a point. */
  scale: number
  mode: ViewMode
  /** Elements left out of the drawing (a picture being placed). */
  hide?: ReadonlySet<string>
  editing?: EditingSlot | null
  className?: string
  style?: CSSProperties
  children?: ReactNode
}

/** A slide at `scale`; `children` go over it, inside the scaled slide (in points). */
export const SlideView = memo(function SlideView({ deck, slide, scale, mode, hide, editing, className, style, children }: SlideViewProps) {
  addSlideStyles()
  const { width, height } = deck.size

  return (
    <div className={className} style={{ position: 'relative', overflow: 'hidden', width: width * scale, height: height * scale, ...style }} data-slide-id={slide.id}>
      <div className="hs-slide" style={{ width, height, transform: `scale(${scale})`, ...backgroundCss(slide.background, deck.theme) }}>
        {slide.elements.map((element) => (
          <ElementView key={element.id} element={element} theme={deck.theme} mode={mode} hidden={hide?.has(element.id)} editor={editing?.id === element.id ? editing.render : undefined} cell={editing?.id === element.id ? editing.cell : undefined} />
        ))}
        {children}
      </div>
    </div>
  )
})
