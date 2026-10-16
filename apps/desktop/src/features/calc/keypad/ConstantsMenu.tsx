import { IconChevronUp } from '@tabler/icons-react'
import { useEffect, useRef } from 'react'
import { cn } from '../../../lib/cn.ts'
import { CONSTANTS, type ConstantId } from './expression.ts'
import { formatNumber } from './format.ts'
import { Key } from './Key.tsx'

const MENU: ConstantId[] = ['c', 'g', 'h', 'na', 'k', 'qe', 'phi']

export interface ConstantsMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (id: ConstantId) => void
  locale?: string
  reduced: boolean
  className?: string
}

/** The scientific keypad's constants: a key that opens a short menu, each value named in its tooltip. */
export function ConstantsMenu({ open, onOpenChange, onPick, locale, reduced, className }: ConstantsMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) {
        onOpenChange(false)
      }
    }

    document.addEventListener('pointerdown', onPointer, true)

    return () => document.removeEventListener('pointerdown', onPointer, true)
  }, [open, onOpenChange])

  return (
    <div ref={ref} className="relative h-full min-h-0">
      <Key
        keyId="constants"
        label={
          <span className="flex items-center gap-0.5">
            const
            <IconChevronUp size={12} stroke={2} className="opacity-70" />
          </span>
        }
        aria="Constants"
        tone="function"
        selected={open}
        onPress={() => onOpenChange(!open)}
        reduced={reduced}
        className={className}
      />
      {open && (
        <div role="menu" aria-label="Constants" className={cn('float menu-surface absolute bottom-full left-0 z-20 mb-1.5 w-72 max-w-[80cqw] rounded-xl p-1.5', !reduced && 'animate-pop')}>
          {MENU.map(id => {
            const constant = CONSTANTS[id]
            const value = formatNumber(constant.value, { locale, digits: 12 })
            const unit = constant.unit ? ` ${constant.unit}` : ''

            return (
              <button
                key={id}
                type="button"
                role="menuitem"
                title={`${constant.name}: ${value}${unit}`}
                aria-label={`${constant.name}, ${value}${unit}`}
                onClick={() => {
                  onPick(id)
                  onOpenChange(false)
                }}
                className="flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left hover:bg-white/8"
              >
                <span className="w-7 shrink-0 text-[15px] font-medium text-fg">{constant.symbol}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-2">{constant.name}</span>
                <span className="shrink-0 text-[11.5px] text-fg-3 tabular-nums">{value}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
