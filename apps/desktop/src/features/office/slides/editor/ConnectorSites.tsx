import { cn } from '../../../../lib/cn.ts'
import type { Point } from '../elements.ts'

/** An element's connection sites while a connector's end is near it, in screen pixels: a dot at each, the one the end glues to filled. */
export function ConnectorSites({ sites, site, scale }: { sites: readonly Point[]; site: number; scale: number }) {
  return (
    <>
      {sites.map(([x, y], index) => (
        <span
          key={index}
          className={cn('absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent shadow-[0_0_0_1px_rgba(255,255,255,0.7)]', index === site ? 'size-[9px] bg-accent' : 'size-[7px] bg-white')}
          style={{ left: x * scale, top: y * scale }}
        />
      ))}
    </>
  )
}
