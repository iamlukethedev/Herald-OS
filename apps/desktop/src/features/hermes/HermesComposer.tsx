import { IconPaperclip, IconPlayerStop, IconSend2 } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { MicButton } from '../voice/MicButton.tsx'
import { ComposerFileChips, type ComposerSubmit, restoreDraft, useComposerFiles } from './ComposerFiles.tsx'

/*
 * The Hermes page composer. Same behaviour as chat/Composer.tsx (Enter sends, Shift+Enter breaks
 * a line, Stop while streaming) with the mockup's chrome: paperclip, mic, blue send. Slash
 * completions are intentionally left to the classic chat surface. Attached files wait as chips
 * and go with the prompt (see ComposerFiles.tsx).
 */
export function HermesComposer({ disabled, streaming, placeholder, autoFocus, onSubmit, onInterrupt, className }: { disabled?: boolean; streaming?: boolean; placeholder?: string; autoFocus?: boolean; onSubmit: ComposerSubmit; onInterrupt?: () => void; className?: string }) {
  const [value, setValue] = useState('')
  const textarea = useRef<HTMLTextAreaElement>(null)
  const files = useComposerFiles(onSubmit)
  const busy = disabled || Boolean(files.sending)

  useEffect(() => {
    const el = textarea.current

    if (!el) {
      return
    }

    el.style.height = '0px'
    el.style.height = `${Math.min(200, Math.max(24, el.scrollHeight))}px`
  }, [value])

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
    <div className={cn('glass-input flex flex-col gap-2 rounded-xl px-2.5 py-2', className)}>
      <ComposerFileChips state={files} disabled={disabled} />
      <div className="flex items-end gap-2">
        <button type="button" aria-label="Attach files" disabled={busy || files.picking} onClick={() => void attach()} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-3 hover:bg-white/8 hover:text-fg disabled:opacity-40">
          <IconPaperclip size={17} stroke={1.7} />
        </button>
        <textarea
          ref={textarea}
          value={value}
          autoFocus={autoFocus}
          disabled={disabled}
          rows={1}
          placeholder={placeholder ?? 'Ask Hermes anything…'}
          aria-label="Message Hermes"
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
          className="max-h-[200px] min-h-6 flex-1 resize-none bg-transparent py-1 text-[13.5px] leading-6 outline-none placeholder:text-fg-4 disabled:opacity-50"
        />
        <MicButton size={17} className="size-8" disabled={disabled} />
        {streaming && onInterrupt ? (
          <button type="button" aria-label="Stop" onClick={onInterrupt} className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-danger/40 bg-danger/15 text-danger hover:bg-danger/25">
            <IconPlayerStop size={15} />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send"
            disabled={busy || (!value.trim() && files.files.length === 0)}
            onClick={() => void submit()}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-accent-strong/60 bg-accent text-accent-fg shadow-[0_4px_14px_rgba(47,125,255,.45)] transition-colors duration-120 hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            {files.sending ? <Spinner /> : <IconSend2 size={16} stroke={1.8} />}
          </button>
        )}
      </div>
    </div>
  )
}
