import type { CSSProperties } from 'react'
import type { Box, SlideElement } from '../deck.ts'
import { boundsOfAll, lineEndsOnSlide } from '../elements.ts'
import { ConnectorSites } from './ConnectorSites.tsx'
import { type GuideLine, HANDLES, handleDirection, type Handle, type SiteTarget } from './gestures.ts'

/*
 * What sits over the slide while editing, in screen pixels so it stays crisp at any zoom: the
 * selection's outline and handles (turned with a rotated element; one frame for a group, its
 * members dashed, and the group a selection was taken into dashed around it), the line ends, the
 * connection sites a connector's end is near, the guides a drag lines up with, and the selection
 * rectangle.
 */

const ACCENT = 'var(--color-accent)'
const GUIDE = '#ff3d8b'
const CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize']

/** The resize cursor for a handle on a box turned `rotation` degrees. */
function cursorFor(handle: Handle, rotation: number): string {
  const [hx, hy] = handleDirection(handle)
  const angle = (Math.atan2(hy, hx) * 180) / Math.PI + rotation
  const step = Math.round((((angle % 180) + 180) % 180) / 45) % 4

  return CURSORS[step]
}

function handleStyle(handle: Handle, rotation: number): CSSProperties {
  const [hx, hy] = handleDirection(handle)

  return { left: `${50 + hx * 50}%`, top: `${50 + hy * 50}%`, cursor: cursorFor(handle, rotation) }
}

const HANDLE_CLASS = 'pointer-events-auto absolute size-[9px] -translate-x-1/2 -translate-y-1/2 rounded-[2px] border border-accent bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.08)]'

function Frame({ box, rotation, scale, handles, rotate, dashed, thin }: { box: Box; rotation: number; scale: number; handles?: boolean; rotate?: boolean; dashed?: boolean; thin?: boolean }) {
  return (
    <div
      className="absolute"
      style={{
        left: box.x * scale,
        top: box.y * scale,
        width: Math.max(1, box.width * scale),
        height: Math.max(1, box.height * scale),
        transform: rotation ? `rotate(${rotation}deg)` : undefined,
        outline: `${thin ? 1 : 1.5}px ${dashed ? 'dashed' : 'solid'} ${ACCENT}`
      }}
    >
      {rotate && (
        <>
          <span className="absolute left-1/2 h-[18px] w-px -translate-x-1/2 bg-accent" style={{ top: -18 }} />
          <span data-rotate="" title="Rotate (⇧ in steps of 15°)" className="pointer-events-auto absolute left-1/2 size-[11px] -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border border-accent bg-white" style={{ top: -22 }} />
        </>
      )}
      {handles && HANDLES.map((handle) => <span key={handle} data-handle={handle} className={HANDLE_CLASS} style={handleStyle(handle, rotation)} />)}
    </div>
  )
}

/** Tables and kept objects stay upright, as in PowerPoint. */
const turns = (element: SlideElement): boolean => element.kind !== 'table' && element.kind !== 'object'

export function Overlay({
  selection,
  editing,
  scale,
  guides,
  marquee,
  group = false,
  context = null,
  sites = null
}: {
  selection: SlideElement[]
  editing: SlideElement | null
  scale: number
  guides: GuideLine[]
  marquee: Box | null
  /** The selection is one group. */
  group?: boolean
  /** The box of the group the selection was taken into. */
  context?: Box | null
  sites?: SiteTarget | null
}) {
  const single = selection.length === 1 ? selection[0] : null

  return (
    <div className="pointer-events-none absolute inset-0 overflow-visible" aria-hidden="true">
      {context && !editing && <Frame box={context} rotation={0} scale={scale} dashed thin />}
      {editing ? (
        <Frame box={editing} rotation={editing.rotation} scale={scale} dashed />
      ) : single?.kind === 'line' ? (
        (() => {
          const { from, to } = lineEndsOnSlide(single)

          return (['from', 'to'] as const).map((end) => {
            const [x, y] = end === 'from' ? from : to

            return <span key={end} data-line-end={end} className="pointer-events-auto absolute size-[11px] -translate-x-1/2 -translate-y-1/2 cursor-crosshair rounded-full border border-accent bg-white" style={{ left: x * scale, top: y * scale }} />
          })
        })()
      ) : single ? (
        <Frame box={single} rotation={single.rotation} scale={scale} handles rotate={turns(single)} />
      ) : selection.length > 1 ? (
        <>
          {selection.map((element) => (element.kind === 'line' ? null : <Frame key={element.id} box={element} rotation={element.rotation} scale={scale} thin dashed={group} />))}
          <Frame box={boundsOfAll(selection)!} rotation={0} scale={scale} handles rotate={group} dashed={!group} />
        </>
      ) : null}
      {sites && <ConnectorSites sites={sites.sites} site={sites.site} scale={scale} />}
      {guides.map((guide, index) => (
        <span
          key={index}
          className="absolute"
          style={
            guide.axis === 'x'
              ? { left: guide.at * scale, top: guide.from * scale, width: 1, height: Math.max(1, (guide.to - guide.from) * scale), background: GUIDE }
              : { top: guide.at * scale, left: guide.from * scale, height: 1, width: Math.max(1, (guide.to - guide.from) * scale), background: GUIDE }
          }
        />
      ))}
      {marquee && <div className="absolute border border-accent bg-accent/10" style={{ left: marquee.x * scale, top: marquee.y * scale, width: marquee.width * scale, height: marquee.height * scale }} />}
    </div>
  )
}
