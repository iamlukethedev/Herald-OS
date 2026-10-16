import type { ReactNode } from 'react'
import { cn } from '../../../lib/cn.ts'
import { DECIMAL_DIGITS } from './rolling.ts'
import { RollingNumber } from './RollingNumber.tsx'

/** About how wide a character of the big display is, in ems, to shrink long numbers until they fit. */
const CHAR_EM = 0.62
const LARGEST = 'clamp(2.75rem, 11cqw, 3.75rem)'

export interface DisplayProps {
  label: string
  /** The expression so far, in quieter text above the number. */
  pending: string
  /** The live result of the whole expression. */
  preview?: string | null
  /** Why there is no result, in place of the preview. */
  error?: string | null
  text: string
  alphabet?: string
  reduced: boolean
  /** Small indicators at the start of the expression line. */
  badges?: ReactNode
  /** A row of switches above everything. */
  top?: ReactNode
  /** The number in big rolling type; without it the switches share the expression's line and `children` show the value. */
  big?: boolean
  children?: ReactNode
  className?: string
}

export function Display({ label, pending, preview, error, text, alphabet = DECIMAL_DIGITS, reduced, badges, top, big = true, children, className }: DisplayProps) {
  const width = Math.max(1, [...text].length * CHAR_EM)

  return (
    <section aria-label={label} className={cn('flex shrink-0 flex-col gap-1 rounded-xl border border-line bg-white/4 px-4 pt-2.5 pb-3 shadow-card', className)}>
      {top && big && <div className="flex min-h-5 flex-wrap items-center gap-1.5">{top}</div>}
      <div className="flex min-h-[1.5em] items-center gap-2 text-[15px]">
        {top && !big && <div className="flex shrink-0 flex-wrap items-center gap-1.5">{top}</div>}
        {badges && <div className="flex shrink-0 items-center gap-1.5">{badges}</div>}
        <div className="flex min-w-0 flex-1 items-baseline justify-end gap-1.5 overflow-hidden whitespace-nowrap text-fg-3">
          <span className="shrink-0">{pending}</span>
          {error ? <span className="shrink-0 text-[12.5px] text-warn">{error}</span> : preview && <span className="shrink-0 text-fg-2 tabular-nums">= {preview}</span>}
        </div>
      </div>
      {big ? (
        <div className="flex min-h-[calc(clamp(2.75rem,11cqw,3.75rem)*1.15)] items-end justify-end overflow-hidden">
          <div aria-live="polite" className="font-light leading-none tracking-tight text-fg" style={{ fontSize: `min(${LARGEST}, calc((100cqw - 2.5rem) / ${width.toFixed(2)}))` }}>
            <RollingNumber text={text} alphabet={alphabet} reduced={reduced} />
            <span className="sr-only">{error ? `${text}: ${error}` : text}</span>
          </div>
        </div>
      ) : (
        <div aria-live="polite" className="sr-only">
          {error ? `${text}: ${error}` : text}
        </div>
      )}
      {children}
    </section>
  )
}
