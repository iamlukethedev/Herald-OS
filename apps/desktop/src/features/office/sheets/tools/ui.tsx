import { IconX } from '@tabler/icons-react'
import { type ReactNode, useEffect, useState } from 'react'
import { GlassButton } from '../../../../components/ui/glass.tsx'
import { cn } from '../../../../lib/cn.ts'
import { messageOf } from '../../../canvas/errors.ts'
import { Modal } from '../../shell/dialogs.tsx'
import { liveTarget } from '../live.ts'
import type { SheetsTarget } from '../model.ts'
import { sheetsSession } from '../store.ts'
import { closeDialog } from '../ui/overlay.tsx'

/* The pieces the data tools' dialogs share: the dialog itself (Enter confirms, Escape cancels), headings, choices and checkboxes. */

/** "1 row", "3 rows". */
export const counted = (n: number, noun: string, plural = `${noun}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? noun : plural}`

/**
 * A data tool's dialog over its document: `confirm` runs on Enter (outside buttons) or the main
 * button, and its message is shown in the window's notice; what fails is shown in the dialog.
 */
export function ToolDialog({ docKey, title, action, ready = true, confirm, children }: { docKey: string; title: string; action: string; ready?: boolean; confirm: (target: SheetsTarget) => Promise<string>; children: ReactNode }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async () => {
    const target = liveTarget(docKey)

    if (!target || !ready || busy) {
      return
    }

    setBusy(true)
    setError('')

    try {
      const message = await confirm(target)
      closeDialog()
      sheetsSession.notify(message)
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={title} onClose={closeDialog}>
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(event) => {
          event.preventDefault()
          void run()
        }}
        onKeyDown={(event) => {
          const button = event.target instanceof HTMLButtonElement ? event.target : null

          // Enter confirms from any field, a choice included; another button pressed with Enter does what it says.
          if (event.key === 'Enter' && (!button || button.getAttribute('role') === 'radio')) {
            event.preventDefault()
            void run()
          }
        }}
      >
        {children}
        {error && <p className="text-[12px] text-danger">{error}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <GlassButton variant="ghost" onClick={closeDialog}>
            Cancel
          </GlassButton>
          <GlassButton type="submit" variant="primary" disabled={!ready || busy}>
            {action}
          </GlassButton>
        </div>
      </form>
    </Modal>
  )
}

export function Heading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2">
      <span className="text-[11.5px] font-medium tracking-wide text-fg-3 uppercase">{children}</span>
      {action}
    </div>
  )
}

/** One of a few choices, as a row of buttons; a choice's detail goes on a second line. */
export function Choices<T extends string>({ label, value, options, onChange, autoFocus }: { label: string; value: T; options: { id: T; label: ReactNode; detail?: string; title?: string }[]; onChange: (id: T) => void; autoFocus?: boolean }) {
  const tall = options.some((option) => option.detail)

  return (
    <div className="flex rounded-md bg-white/5 p-0.5 ring-1 ring-line" role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          title={option.title}
          aria-checked={option.id === value}
          autoFocus={autoFocus && index === 0}
          onClick={() => onChange(option.id)}
          className={cn('flex min-w-0 flex-1 flex-col items-center justify-center rounded px-1.5 text-[12px]', tall ? 'h-10' : 'h-7', option.id === value ? 'bg-white/14 text-fg' : 'text-fg-3 hover:text-fg')}
        >
          <span className="max-w-full truncate">{option.label}</span>
          {option.detail && <span className="max-w-full truncate text-[11px] text-fg-3">{option.detail}</span>}
        </button>
      ))}
    </div>
  )
}

export function Check({ checked, onChange, children, autoFocus }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode; autoFocus?: boolean }) {
  return (
    <label className="flex min-w-0 items-center gap-2 text-[12.5px] text-fg-2">
      <input type="checkbox" autoFocus={autoFocus} checked={checked} onChange={(event) => onChange(event.target.checked)} className="accent-(--color-accent)" />
      <span className="truncate">{children}</span>
    </label>
  )
}

export function TextField({ label, className, ...props }: { label: string } & React.ComponentProps<'input'>) {
  return <input aria-label={label} {...props} className={cn('glass-input h-7 min-w-0 rounded-md px-2 text-[12px] text-fg outline-none placeholder:text-fg-4', className)} />
}

export function Select({ label, className, children, ...props }: { label: string } & React.ComponentProps<'select'>) {
  return (
    <select aria-label={label} {...props} style={{ colorScheme: 'dark' }} className={cn('glass-input h-7 min-w-0 rounded-md px-1.5 text-[12px] text-fg outline-none', className)}>
      {children}
    </select>
  )
}

export function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg">
      <IconX size={13} />
    </button>
  )
}

/** A line of small print under a part of a dialog. */
export function Note({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warn' }) {
  return <p className={cn('text-[11.5px] leading-snug', tone === 'warn' ? 'text-warn' : 'text-fg-3')}>{children}</p>
}

/** What `work` gives for a document's live workbook, again whenever `deps` change; its error as text when it throws. */
export function useLive<T>(docKey: string, work: (target: SheetsTarget) => T | Promise<T>, deps: unknown[]): { value: T | null; error: string } {
  const [state, setState] = useState<{ value: T | null; error: string }>({ value: null, error: '' })

  useEffect(() => {
    let current = true
    const target = liveTarget(docKey)

    if (!target) {
      setState({ value: null, error: 'This workbook is not on screen' })

      return
    }

    Promise.resolve()
      .then(() => work(target))
      .then(
        (value) => current && setState({ value, error: '' }),
        (failure: unknown) => current && setState({ value: null, error: messageOf(failure) })
      )

    return () => {
      current = false
    }
  }, [docKey, ...deps])

  return state
}

/** A small grid of what a tool would write, its first rows. */
export function PreviewGrid({ rows, className }: { rows: (string | number | boolean | null)[][]; className?: string }) {
  const width = Math.max(1, ...rows.map((row) => row.length))

  return (
    <div className={cn('overflow-hidden rounded-md border border-line', className)}>
      <table className="w-full table-fixed border-collapse text-[11.5px]">
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-b border-line last:border-b-0">
              {Array.from({ length: width }, (_, c) => (
                <td key={c} className="truncate border-r border-line px-1.5 py-1 text-fg-2 last:border-r-0">
                  {row[c] === null || row[c] === undefined ? '' : String(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
