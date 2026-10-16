import { cn } from '../../../lib/cn.ts'

export interface SegmentedItem<T> {
  id: T
  label: string
  title?: string
}

/** A row of choices, one of them on: the keypad's mode, the word size, signed or unsigned. */
export function Segmented<T extends string | number>({ label, items, value, onChange, size = 'md', className }: { label: string; items: readonly SegmentedItem<T>[]; value: T; onChange: (id: T) => void; size?: 'sm' | 'md'; className?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex items-center gap-0.5 rounded-lg bg-black/15 p-0.5 hairline', className)}>
      {items.map(item => {
        const on = item.id === value

        return (
          <button
            key={String(item.id)}
            type="button"
            role="radio"
            aria-checked={on}
            title={item.title}
            onClick={() => onChange(item.id)}
            className={cn(
              'rounded-md font-medium whitespace-nowrap transition-colors duration-150',
              size === 'sm' ? 'h-5 px-1.5 text-[10.5px] tabular-nums' : 'h-7 px-3 text-[12.5px]',
              on ? 'bg-accent text-accent-fg' : 'text-fg-2 hover:bg-white/6 hover:text-fg'
            )}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
