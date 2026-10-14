import { IconArrowUp, IconPaperclip } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { useSlashCatalog } from '../chat/use-slash-catalog.ts'
import { ComposerFileChips, type ComposerSubmit, restoreDraft, useComposerFiles } from '../hermes/ComposerFiles.tsx'
import { MicButton } from '../voice/MicButton.tsx'

/*
 * The Overview's glass prompt: one line that grows, a paperclip whose files wait as chips and go
 * with the prompt (see hermes/ComposerFiles.tsx), the mic and a round blue send. Enter sends,
 * Shift+Enter breaks the line and "/" completes slash commands from the gateway catalog, like the
 * chat Composer does.
 */

export interface OverviewComposerProps {
  disabled?: boolean
  placeholder?: string
  onSubmit: ComposerSubmit
  className?: string
  /** A starter sentence to put in the field for the person to finish (a new `id` puts it in again). */
  draft?: { text: string; id: number }
}

export function OverviewComposer({ disabled, placeholder, onSubmit, className, draft }: OverviewComposerProps) {
  const [value, setValue] = useState('')
  const [selected, setSelected] = useState(0)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const files = useComposerFiles(onSubmit)
  const busy = disabled || Boolean(files.sending)
  const catalog = useSlashCatalog()
  const slashQuery = value.startsWith('/') && !value.includes(' ') && !value.includes('\n') ? value.slice(1).toLowerCase() : null
  const completions = slashQuery !== null ? catalog.filter(entry => entry.name.toLowerCase().startsWith(slashQuery)).slice(0, 8) : []

  useEffect(() => {
    if (!draft) {
      return
    }

    setValue(draft.text)
    requestAnimationFrame(() => {
      const el = textarea.current

      if (el) {
        el.focus()
        el.setSelectionRange(draft.text.length, draft.text.length)
      }
    })
  }, [draft?.id])

  useEffect(() => {
    const el = textarea.current

    if (!el) {
      return
    }

    el.style.height = '0px'
    el.style.height = `${Math.min(200, Math.max(24, el.scrollHeight))}px`
  }, [value])

  useEffect(() => {
    setSelected(0)
  }, [slashQuery])

  const submit = async () => {
    const text = value.trim()

    if (busy || (!text && files.files.length === 0)) {
      return
    }

    setValue('')
    await files.send(text, draft => setValue(restoreDraft(draft)))
  }

  const attach = async () => {
    await files.pick()
    textarea.current?.focus()
  }

  return (
    <div className={cn('relative', className)}>
      {completions.length > 0 && (
        <div className="float animate-rise absolute bottom-full left-0 mb-2 w-full max-w-md overflow-hidden rounded-lg">
          {completions.map((entry, index) => (
            <button
              key={entry.name}
              type="button"
              onMouseDown={event => {
                event.preventDefault()
                setValue(`/${entry.name} `)
              }}
              className={cn('flex w-full items-baseline gap-3 px-3 py-1.5 text-left text-[12.5px]', index === selected ? 'bg-white/6 text-fg' : 'text-fg-2')}
            >
              <span className="font-mono">/{entry.name}</span>
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-3">{entry.description}</span>
            </button>
          ))}
        </div>
      )}
      <div className="glass-input flex flex-col gap-2 rounded-xl py-2 pr-2 pl-4">
        <ComposerFileChips state={files} disabled={disabled} />
        <div className="flex items-end gap-2">
          <textarea
            ref={textarea}
            value={value}
            disabled={disabled}
            rows={1}
            aria-label="Ask Hermes"
            placeholder={placeholder ?? 'What would you like to make happen?'}
            onChange={event => setValue(event.target.value)}
            onKeyDown={event => {
              if (completions.length > 0) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setSelected(i => (i + 1) % completions.length)

                  return
                }

                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setSelected(i => (i - 1 + completions.length) % completions.length)

                  return
                }

                if (event.key === 'Tab') {
                  event.preventDefault()
                  setValue(`/${completions[selected].name} `)

                  return
                }
              }

              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()

                if (completions.length > 0 && slashQuery !== null && completions[selected].name.toLowerCase() !== slashQuery) {
                  setValue(`/${completions[selected].name} `)

                  return
                }

                void submit()
              }
            }}
            className="max-h-[200px] min-h-6 flex-1 resize-none self-center bg-transparent py-1.5 text-[14px] leading-6 outline-none placeholder:text-fg-3 disabled:opacity-50"
          />
          <div className="flex items-center gap-0.5 self-center">
            <span aria-hidden="true" className="mr-1.5 h-6 w-px bg-line" />
            <button type="button" aria-label="Attach files" disabled={busy || files.picking} onClick={() => void attach()} className="flex size-9 items-center justify-center rounded-lg text-fg-2 transition-colors duration-120 hover:bg-white/8 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40">
              <IconPaperclip size={17} />
            </button>
            <MicButton size={17} className="size-9" disabled={disabled} />
            <button
              type="button"
              aria-label="Send"
              disabled={busy || (!value.trim() && files.files.length === 0)}
              onClick={() => void submit()}
              className="ml-1 flex size-9 items-center justify-center rounded-full bg-accent text-accent-fg shadow-[0_4px_16px_rgba(47,125,255,.45)] transition-colors duration-120 hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              {files.sending ? <Spinner /> : <IconArrowUp size={17} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
