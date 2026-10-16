import { type MouseEvent, type PointerEvent, type ReactNode, useState } from 'react'
import { cn } from '../../../lib/cn.ts'
import type { KeyTone } from './keys.ts'

const TONES: Record<KeyTone, string> = {
  digit: 'border-line bg-white/8 text-fg shadow-card hover:bg-white/12',
  control: 'border-line bg-white/14 text-fg shadow-card hover:bg-white/18',
  function: 'border-line/60 bg-white/4 text-fg-2 hover:bg-white/9 hover:text-fg',
  memory: 'border-transparent bg-transparent text-fg-3 hover:bg-white/6 hover:text-fg',
  operator: 'border-accent/40 bg-accent-soft text-accent-strong hover:bg-accent/30',
  equals: 'border-accent-strong/60 bg-accent text-accent-fg shadow-[0_6px_20px_var(--color-accent-soft)] hover:bg-accent-strong'
}

/** A key that stays lit: 2nd while on, an operator waiting for its right side. */
const SELECTED = 'border-accent-strong bg-accent/45 text-fg shadow-[0_4px_14px_var(--color-accent-soft)]'

export interface KeyProps {
  keyId: string
  label: ReactNode
  aria: string
  /** A tooltip: the name by default, none for digits. */
  title?: string
  tone: KeyTone
  onPress: () => void
  /** The keyboard pressed it just now. */
  flash?: boolean
  selected?: boolean
  disabled?: boolean
  reduced: boolean
  className?: string
}

/** A rounded glass key that sinks and lights up under the pointer, and flashes when its key is typed. */
export function Key({ keyId, label, aria, title, tone, onPress, flash = false, selected = false, disabled = false, reduced, className }: KeyProps) {
  const [held, setHeld] = useState(false)
  const pressed = (held || flash) && !disabled
  const release = () => setHeld(false)

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || disabled) {
      return
    }

    setHeld(true)
    onPress()
  }

  // Pointer presses act on pointer down; a click with no pointer behind it is the keyboard or assistive tech.
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail === 0) {
      onPress()
    }
  }

  return (
    <button
      type="button"
      aria-label={aria}
      title={title ?? (tone === 'digit' ? undefined : aria)}
      aria-pressed={keyId === 'second' ? selected : undefined}
      disabled={disabled}
      data-key={keyId}
      onPointerDown={onPointerDown}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onClick={onClick}
      className={cn(
        'flex h-full min-h-0 w-full min-w-0 touch-manipulation items-center justify-center rounded-lg border leading-none whitespace-nowrap tabular-nums select-none',
        'disabled:cursor-not-allowed disabled:opacity-30',
        !reduced && 'transition-[transform,filter,background-color,border-color,color,box-shadow] duration-100 ease-out',
        selected ? SELECTED : TONES[tone],
        pressed && (tone === 'equals' || selected ? 'brightness-90' : 'brightness-125'),
        pressed && !reduced && 'translate-y-px scale-[0.97]',
        className
      )}
    >
      {label}
    </button>
  )
}
