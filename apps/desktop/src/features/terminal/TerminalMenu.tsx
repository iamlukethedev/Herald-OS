import { IconClipboard, IconCopy } from '@tabler/icons-react'
import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useT } from '../../store/i18n.ts'

/** Keeps the menu this far inside the Terminal's edges. */
const EDGE = 4

export interface TerminalMenuProps {
  /** Where it opened, in its offset parent's coordinates. */
  x: number
  y: number
  canCopy: boolean
  /** Each item's keys: `hint` shown beside it, such as "Ctrl+Shift+C", and `aria` for aria-keyshortcuts. */
  keys: Record<'copy' | 'paste', { hint: string; aria: string }>
  onCopy: () => void
  onPaste: () => void
  /** `refocus`: give the keyboard back to the terminal, as Escape does; a click elsewhere gives it to what was clicked. */
  onClose: (refocus: boolean) => void
}

/** The Terminal's right-click menu: Copy (when text is selected) and Paste. */
export function TerminalMenu({ x, y, canCopy, keys, onCopy, onPaste, onClose }: TerminalMenuProps) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: x, top: y })
  const items = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]

  useLayoutEffect(() => {
    const menu = ref.current
    const bounds = menu?.offsetParent as HTMLElement | null
    items()[0]?.focus()

    if (menu && bounds) {
      const fitsBelow = y + menu.offsetHeight + EDGE <= bounds.clientHeight
      setPlace({
        left: Math.max(EDGE, Math.min(x, bounds.clientWidth - menu.offsetWidth - EDGE)),
        top: Math.max(EDGE, fitsBelow ? y : y - menu.offsetHeight)
      })
    }
  }, [x, y])

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        onClose(false)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose(true)
      }
    }
    // The menu had the keyboard, so the terminal gets it back for when the window is in front again.
    const onLeave = () => onClose(true)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onLeave)
    window.addEventListener('resize', onLeave)

    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onLeave)
      window.removeEventListener('resize', onLeave)
    }
  }, [onClose])

  const onKeyDown = (event: React.KeyboardEvent) => {
    const list = items()
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? (at + 1) % list.length : event.key === 'ArrowUp' ? (at - 1 + list.length) % list.length : event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : null

    if (next !== null && list.length) {
      event.preventDefault()
      list[next].focus()
    } else if (event.key === 'Tab') {
      event.preventDefault()
      onClose(true)
    }
  }

  const row = (label: string, shortcut: { hint: string; aria: string }, icon: React.ReactNode, onSelect: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      aria-keyshortcuts={shortcut.aria}
      disabled={disabled}
      onClick={() => {
        onClose(true)
        onSelect()
      }}
      className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[12.5px] whitespace-nowrap text-fg-2 outline-none hover:bg-white/8 hover:text-fg focus-visible:bg-white/8 focus-visible:text-fg disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-[15px] [&_svg]:shrink-0"
    >
      <span className="text-fg-3">{icon}</span>
      <span className="flex-1">{label}</span>
      <span className="pl-4 font-mono text-[11px] text-fg-3">{shortcut.hint}</span>
    </button>
  )

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('terminal.menu')}
      className="float menu-surface absolute z-30 min-w-48 rounded-xl p-1 animate-pop"
      style={place}
      onKeyDown={onKeyDown}
      onContextMenu={event => event.preventDefault()}
    >
      {row(t('terminal.copy'), keys.copy, <IconCopy />, onCopy, !canCopy)}
      {row(t('terminal.paste'), keys.paste, <IconClipboard />, onPaste)}
    </div>
  )
}
