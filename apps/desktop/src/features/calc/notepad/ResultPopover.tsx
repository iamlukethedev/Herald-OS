import { IconCheck, IconCopy, IconRowInsertBottom } from '@tabler/icons-react'
import type React from 'react'
import { useEffect, useState } from 'react'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { notify } from '../../../store/notifications.ts'
import type { LineResult } from '../engine/types.ts'
import { messageOf } from './format.ts'
import type { ResultCell } from './layout.ts'

const COPIED_MS = 1400

export interface ResultPopoverProps {
  ref?: React.Ref<HTMLDivElement>
  result: LineResult
  cell: ResultCell
  reduced: boolean
  className?: string
  style?: React.CSSProperties
  onInsertBelow: () => void
  onPointerEnter: () => void
  onPointerLeave: () => void
}

/** A result's working and what to do with it, or a line's gentle explanation of why it has none. */
export function ResultPopover({ ref, result, cell, reduced, className, style, onInsertBelow, onPointerEnter, onPointerLeave }: ResultPopoverProps) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) {
      return
    }

    const timer = setTimeout(() => setCopied(false), COPIED_MS)

    return () => clearTimeout(timer)
  }, [copied])

  const copy = (display: string) => {
    navigator.clipboard.writeText(display).then(
      () => setCopied(true),
      (error: unknown) => notify({ title: 'Could not copy the result', body: messageOf(error), level: 'error' })
    )
  }

  const steps = (result.steps ?? []).filter(step => step.trim())

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={cell.kind === 'error' ? 'Why this line has no result' : 'How this was worked out'}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={style}
      className={cn('float menu-surface absolute z-20 w-72 max-w-[calc(100%-1.5rem)] rounded-xl p-3 text-[12.5px]', !reduced && 'animate-pop', className)}
    >
      <div className="truncate text-fg-3">{result.source.trim()}</div>
      {cell.kind === 'error' ? (
        <p className="mt-1.5 leading-snug text-fg-2">{cell.message}</p>
      ) : (
        <>
          {steps.length > 0 && (
            <ol className="selectable mt-2 space-y-0.5 border-l border-line pl-2.5 leading-snug text-fg-2 tabular-nums">
              {steps.map((step, index) => (
                <li key={index} className="break-words">
                  {step}
                </li>
              ))}
            </ol>
          )}
          {cell.kind === 'value' && (
            <>
              <div className="selectable mt-2 text-[16px] font-semibold break-words text-fg tabular-nums">{cell.display}</div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <GlassButton size="sm" onClick={() => copy(cell.display)} aria-label={copied ? 'Copied' : `Copy ${cell.display}`}>
                  {copied ? <IconCheck className="text-ok" /> : <IconCopy />}
                  {copied ? 'Copied' : 'Copy'}
                </GlassButton>
                <GlassButton size="sm" onClick={onInsertBelow} aria-label={`Insert ${cell.display} on a new line below`}>
                  <IconRowInsertBottom />
                  Insert below
                </GlassButton>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
