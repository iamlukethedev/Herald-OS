import { cn } from '../../../lib/cn.ts'
import { bitAt, type WordSize } from './programmer.ts'

const ROWS = [3, 2, 1, 0]
const NIBBLES = [3, 2, 1, 0]

/** All 64 bits, most significant first, in nibbles; a click flips one, and bits above the word size are dimmed. */
export function BitGrid({ value, bits, onToggle, className }: { value: bigint; bits: WordSize; onToggle: (index: number) => void; className?: string }) {
  return (
    <div role="group" aria-label="Bits" className={cn('grid shrink-0 grid-cols-1 gap-x-5 gap-y-0.5 rounded-xl border border-line/60 bg-white/3 px-3 py-1.5 @min-[40rem]:grid-cols-2', className)}>
      {ROWS.map(row => (
        <div key={row} className="flex items-center gap-2">
          <span className="w-5 shrink-0 text-right text-[10px] text-fg-4 tabular-nums">{row * 16 + 15}</span>
          <div className="flex min-w-0 flex-1 gap-2">
            {NIBBLES.map(nibble => (
              <div key={nibble} className="flex flex-1">
                {NIBBLES.map(bit => {
                  const index = row * 16 + nibble * 4 + bit
                  const on = bitAt(value, index)
                  const outside = index >= bits

                  return (
                    <button
                      key={bit}
                      type="button"
                      disabled={outside}
                      aria-label={`Bit ${index}`}
                      aria-pressed={on}
                      onClick={() => onToggle(index)}
                      className={cn(
                        'h-[18px] min-w-0 flex-1 rounded-sm font-mono text-[11px] tabular-nums transition-colors duration-100',
                        outside ? 'cursor-default text-fg-4 opacity-40' : on ? 'font-semibold text-accent-strong hover:bg-accent-soft' : 'text-fg-3 hover:bg-white/8 hover:text-fg-2'
                      )}
                    >
                      {on && !outside ? '1' : '0'}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
          <span className="w-5 shrink-0 text-[10px] text-fg-4 tabular-nums">{row * 16}</span>
        </div>
      ))}
    </div>
  )
}
