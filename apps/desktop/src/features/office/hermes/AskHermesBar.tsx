import { useStore } from '@nanostores/react'
import { IconArrowBackUp, IconShieldCheck, IconSparkles } from '@tabler/icons-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { OfficeApp } from '../../../../shared/office/files.ts'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { Spinner } from '../../../components/ui/primitives.tsx'
import { cn } from '../../../lib/cn.ts'
import { $askDraft, $asks, $hermesState, askHermes, askOf, type AskState, cancelAsk, dismissAsk, openInHermes, undoAsk } from './ask.ts'

// The Markdown renderer is most of what the bar would load; it comes when Hermes is asked something.
const loadMarkdown = () => import('../../chat/Markdown.tsx')
const Markdown = lazy(() => loadMarkdown().then((module) => ({ default: module.Markdown })))

const WAITING: Record<NonNullable<AskState['waiting']>, string> = {
  approval: 'Hermes is waiting for your approval',
  clarify: 'Hermes has a question for you',
  sudo: 'Hermes is waiting for a password',
  secret: 'Hermes is waiting for a key'
}

/** Hermes's reply to the last request, above the bar, until it is dismissed. */
function Reply({ docKey, ask, focusDocument }: { docKey: string; ask: AskState; focusDocument?: () => void }) {
  const close = (then: (key: string) => void) => {
    then(docKey)
    focusDocument?.()
  }

  return (
    <div role="dialog" aria-label="Hermes’s reply" className="float menu-surface absolute right-0 bottom-full z-50 mb-2.5 flex w-[420px] max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-xl p-3 text-fg animate-pop">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-fg-3" title={ask.words}>
        <IconSparkles size={12} className="shrink-0" />
        <span className="min-w-0 truncate">{ask.words}</span>
      </div>
      {ask.phase === 'error' ? (
        <div className="max-h-60 overflow-y-auto text-[12.5px] text-danger select-text">{ask.error}</div>
      ) : (
        <Suspense fallback={<div className="max-h-60 overflow-y-auto text-[12.5px] leading-relaxed whitespace-pre-wrap select-text">{ask.answer}</div>}>
          <Markdown text={ask.answer} className="max-h-60 overflow-y-auto text-[12.5px] leading-relaxed" />
        </Suspense>
      )}
      <div className="flex items-center justify-end gap-1.5">
        {ask.undo > 0 && (
          <GlassButton size="sm" title={ask.undo === 1 ? 'Undo what Hermes changed' : `Undo what Hermes changed (${ask.undo} steps)`} onClick={() => close(undoAsk)}>
            <IconArrowBackUp /> Undo
          </GlassButton>
        )}
        {ask.sessionId && (
          <GlassButton size="sm" variant="ghost" onClick={() => openInHermes(docKey)}>
            Open in Hermes
          </GlassButton>
        )}
        <GlassButton size="sm" variant="ghost" onClick={() => close(dismissAsk)}>
          Dismiss
        </GlassButton>
      </div>
    </div>
  )
}

/** What Hermes is doing for the request, or what it waits for, with a way to stop it. */
function Working({ docKey, ask }: { docKey: string; ask: AskState }) {
  return (
    <div className="flex h-5 w-80 min-w-0 items-center gap-1.5" title={ask.words}>
      {ask.waiting ? <IconShieldCheck size={13} className="shrink-0 text-warn" /> : <Spinner className="size-3 shrink-0" />}
      <span className={cn('min-w-0 flex-1 truncate', ask.waiting ? 'text-warn' : 'text-fg-2')}>{ask.waiting ? WAITING[ask.waiting] : `${ask.step}…`}</span>
      {ask.waiting && (
        <button type="button" onClick={() => openInHermes(docKey)} className="shrink-0 rounded px-1.5 text-fg-2 hover:bg-white/8 hover:text-fg">
          Open Hermes
        </button>
      )}
      <button type="button" onClick={() => cancelAsk(docKey)} className="shrink-0 rounded px-1.5 text-fg-3 hover:bg-white/8 hover:text-fg">
        Cancel
      </button>
    </div>
  )
}

/** Where an Office window takes requests for Hermes about the document in front, and shows how they went. */
export function AskHermesBar({ app, docKey, noun, focusDocument }: { app: OfficeApp; docKey: string; noun: string; focusDocument?: () => void }) {
  const ask = useStore($asks, { keys: [docKey], deps: [docKey] })[docKey] ?? askOf(docKey)
  const reach = useStore($hermesState)
  const draft = useStore($askDraft)
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (ask.phase !== 'idle') {
      void loadMarkdown()
    }
  }, [ask.phase])

  // A menu asked for the bar: it takes the focus, with the text the menu started.
  useEffect(() => {
    if (draft?.app !== app) {
      return
    }

    $askDraft.set(null)

    if (draft.text) {
      setText(draft.text)
    }

    setTimeout(() => {
      const element = input.current
      element?.focus()
      element?.setSelectionRange(element.value.length, element.value.length)
    })
  }, [draft, app])

  const send = () => {
    const words = text.trim()

    if (!words || reach !== 'ready') {
      return
    }

    setText('')
    void askHermes({ app, docKey, words, mark: app === 'docs' })
    focusDocument?.()
  }

  return (
    <div className="relative flex min-w-0 items-center gap-1.5">
      {(ask.phase === 'done' || ask.phase === 'error') && <Reply docKey={docKey} ask={ask} focusDocument={focusDocument} />}
      {ask.phase === 'working' ? (
        <Working docKey={docKey} ask={ask} />
      ) : (
        <>
          <IconSparkles size={13} className={cn('shrink-0', reach === 'ready' ? 'text-fg-3' : 'text-fg-4')} />
          <input
            ref={input}
            value={text}
            disabled={reach !== 'ready'}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                event.stopPropagation()
                send()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                input.current?.blur()
                focusDocument?.()
              }
            }}
            aria-label={`Ask Hermes about this ${noun}`}
            placeholder={reach === 'ready' ? `Ask Hermes about this ${noun}…` : reach === 'offline' ? 'Hermes is offline' : 'Hermes is starting…'}
            className="glass-input h-5 w-80 min-w-0 rounded-md px-2 text-[11.5px] text-fg outline-none transition-[width] duration-150 placeholder:text-fg-4 focus:w-[26rem] disabled:opacity-60"
          />
        </>
      )}
    </div>
  )
}
