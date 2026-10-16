import { useEffect, useLayoutEffect, useRef } from 'react'
import { cn } from '../../../lib/cn.ts'
import { motion } from '../../../lib/motion.ts'
import { DECIMAL_DIGITS, rollingDiff } from './rolling.ts'

const ROLL_MS = 340
const STAGGER_MS = 18
const STAGGER_SLOTS = 8

function DigitSlot({ digit, alphabet, enter, reduced, delay }: { digit: number; alphabet: string; enter: boolean; reduced: boolean; delay: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  // Only a slot that is new rises in, once, as it mounts.
  const rises = useRef(enter && !reduced)

  useLayoutEffect(() => {
    if (rises.current) {
      ref.current?.animate(
        [
          { transform: 'translateY(55%)', opacity: 0 },
          { transform: 'translateY(0)', opacity: 1 }
        ],
        { duration: ROLL_MS, easing: motion.ease }
      )
    }
  }, [])

  return (
    <span ref={ref} className="relative inline-block h-[1.15em] overflow-hidden">
      <span
        className={cn('flex flex-col', !reduced && 'transition-transform')}
        style={{
          transform: `translateY(${(-100 * digit) / alphabet.length}%)`,
          ...(reduced ? {} : { transitionDuration: `${ROLL_MS}ms`, transitionDelay: `${delay}ms`, transitionTimingFunction: motion.ease })
        }}
      >
        {[...alphabet].map(char => (
          <span key={char} className="block h-[1.15em] text-center leading-[1.15em]">
            {char}
          </span>
        ))}
      </span>
    </span>
  )
}

/**
 * Text that rolls like an odometer: each digit slides from its old value to its new one, the
 * digits a new value shares at the front stay still, and other characters fade in. Nothing moves
 * with Reduce Motion. Screen readers get the text from the caller; this is only the picture.
 */
export function RollingNumber({ text, alphabet = DECIMAL_DIGITS, reduced, className }: { text: string; alphabet?: string; reduced: boolean; className?: string }) {
  const previous = useRef<string | null>(null)
  const slots = rollingDiff(reduced ? null : previous.current, text, alphabet)

  useEffect(() => {
    previous.current = text
  }, [text])

  return (
    <span aria-hidden className={cn('inline-flex items-start whitespace-pre tabular-nums', className)}>
      {slots.map((slot, index) =>
        slot.digit === null ? (
          <span key={slot.key} className={cn('inline-block h-[1.15em] leading-[1.15em]', slot.change === 'enter' && 'animate-fade-in')}>
            {slot.char}
          </span>
        ) : (
          <DigitSlot key={slot.key} digit={slot.digit} alphabet={alphabet} enter={slot.change === 'enter'} reduced={reduced} delay={Math.min(slots.length - 1 - index, STAGGER_SLOTS) * STAGGER_MS} />
        )
      )}
    </span>
  )
}
