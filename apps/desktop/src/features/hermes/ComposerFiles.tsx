import { useStore } from '@nanostores/react'
import { IconPaperclip, IconX } from '@tabler/icons-react'
import { useState } from 'react'
import { Spinner } from '../../components/ui/primitives.tsx'
import { fileName } from '../../lib/attachments.ts'
import { $uploading } from '../../store/attachments.ts'

/*
 * Files attached in a composer (the Hermes page's and the Overview's): chips in the field, sent
 * with the prompt. While they are on their way the chips say so and Send waits; when one cannot
 * reach Hermes, the draft and its files come back with the reason, and nothing is sent.
 */

export type ComposerSubmit = (text: string, attachments: string[]) => void | Promise<void>

export interface ComposerFiles {
  files: string[]
  /** The files of the send under way, if it has any. */
  sending: string[] | null
  picking: boolean
  error: string | null
  pick: () => Promise<void>
  remove: (file: string) => void
  /** Send `text` with the files; on failure `restore` gets the text back. */
  send: (text: string, restore: (text: string) => void) => Promise<void>
}

export function useComposerFiles(onSubmit: ComposerSubmit): ComposerFiles {
  const [files, setFiles] = useState<string[]>([])
  const [sending, setSending] = useState<string[] | null>(null)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pick = async () => {
    if (picking) {
      return
    }

    setPicking(true)

    try {
      const picked = await window.heraldOS.fs.pickFiles({ multiple: true })

      if (picked.length > 0) {
        setFiles(current => [...current, ...picked.filter(file => !current.includes(file))])
        setError(null)
      }
    } catch {
      // The dialog was dismissed or refused; nothing to attach.
    } finally {
      setPicking(false)
    }
  }

  const remove = (file: string) => setFiles(current => current.filter(item => item !== file))

  const send = async (text: string, restore: (text: string) => void) => {
    const outgoing = files
    setFiles([])
    setError(null)
    setSending(outgoing.length > 0 ? outgoing : null)

    try {
      await onSubmit(text, outgoing)
    } catch (failure) {
      restore(text)
      setFiles(current => [...outgoing, ...current.filter(file => !outgoing.includes(file))])
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSending(null)
    }
  }

  return { files, sending, picking, error, pick, remove, send }
}

/** A draft restored after a failed send goes before whatever was typed since. */
export const restoreDraft = (draft: string) => (current: string) => (current.trim() ? `${draft}\n${current}` : draft)

/** The attached files and, after a failed send, why. */
export function ComposerFileChips({ state, disabled }: { state: ComposerFiles; disabled?: boolean }) {
  const uploading = useStore($uploading)
  const shown = state.sending ?? state.files

  if (shown.length === 0 && !state.error) {
    return null
  }

  return (
    <div className="flex flex-col gap-1.5">
      {shown.length > 0 && (
        <div role="list" aria-label="Attached files" className="flex flex-wrap gap-1.5">
          {shown.map(file => (
            <span key={file} role="listitem" title={file} className="inline-flex h-7 max-w-[260px] items-center gap-1.5 rounded-lg border border-line bg-white/6 pr-1 pl-2 text-[12px] text-fg-2">
              {state.sending ? <Spinner className="shrink-0" /> : <IconPaperclip size={13} className="shrink-0 text-fg-3" />}
              <span className="truncate">{fileName(file)}</span>
              {!state.sending && (
                <button type="button" aria-label={`Remove ${fileName(file)}`} disabled={disabled} onClick={() => state.remove(file)} className="flex size-5 shrink-0 items-center justify-center rounded text-fg-3 hover:bg-white/10 hover:text-fg disabled:opacity-40">
                  <IconX size={12} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {state.sending && uploading && (
        <div className="text-[11.5px] text-fg-3" aria-live="polite">
          Uploading {uploading.name}
          {uploading.count > 1 ? ` (${uploading.index + 1} of ${uploading.count})` : ''}…
        </div>
      )}
      {state.error && (
        <div role="alert" className="text-[12px] leading-snug text-danger">
          {state.error}
        </div>
      )}
    </div>
  )
}
