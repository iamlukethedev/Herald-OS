import { IconFileText, IconTable } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { notify } from '../../../store/notifications.ts'
import { useReducedMotion } from '../../pet/hooks.ts'
import { systemZone } from '../context.ts'
import { evaluateDocument } from '../engine/index.ts'
import { copyToDocs, copyToSheets } from '../office/send.ts'
import { $openNote } from '../store.ts'
import { messageOf } from './format.ts'

type Target = 'sheets' | 'docs'

const TARGETS: Record<Target, { label: string; short: string; failed: string; send: typeof copyToSheets }> = {
  sheets: { label: 'Copy to Sheets', short: 'Sheets', failed: 'Could not copy to Sheets', send: copyToSheets },
  docs: { label: 'Copy to Docs', short: 'Docs', failed: 'Could not copy to Docs', send: copyToDocs }
}

/** The note as worked out for exactly its text now: the last answer when it is current, else a fresh one. */
async function currentDocument() {
  const note = $openNote.get()

  if (note.document && note.documentText === note.text) {
    return note.document
  }

  return evaluateDocument(note.text, note.context ?? { now: Date.now(), zone: systemZone(), rates: null })
}

/** The header's Copy to Sheets and Copy to Docs for the open note. */
export function NotesActions({ labels }: { labels: boolean }) {
  const [busy, setBusy] = useState<Target | null>(null)
  const reduced = useReducedMotion()

  const copy = async (target: Target) => {
    const note = $openNote.get()

    if (!note.text.trim()) {
      notify({ title: 'Nothing to copy yet', body: 'Write a line or two in the note first.', level: 'info' })

      return
    }

    setBusy(target)

    try {
      const line = await TARGETS[target].send(await currentDocument(), note.title)
      notify({ title: line, level: 'success' })
    } catch (error) {
      notify({ title: TARGETS[target].failed, body: messageOf(error), level: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {(['sheets', 'docs'] as const).map(target => (
        <GlassButton
          key={target}
          variant="ghost"
          size={labels ? 'sm' : 'icon'}
          disabled={busy !== null}
          aria-label={TARGETS[target].label}
          title={TARGETS[target].label}
          onClick={() => void copy(target)}
          aria-busy={busy === target}
          className={cn(!labels && 'size-8', busy === target && (reduced ? 'opacity-60' : 'shimmer'))}
        >
          {target === 'sheets' ? <IconTable /> : <IconFileText />}
          {labels && TARGETS[target].short}
        </GlassButton>
      ))}
    </>
  )
}
