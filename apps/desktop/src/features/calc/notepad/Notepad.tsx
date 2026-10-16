import { useStore } from '@nanostores/react'
import { IconArrowBackUp, IconNotes, IconPlus, IconX } from '@tabler/icons-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { normalizeCalcPrefs, noteTitle } from '../../../../shared/calc.ts'
import { EmptyGlass, GlassButton } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { $prefs } from '../../../store/backend.ts'
import { $locale } from '../../../store/i18n.ts'
import { useReducedMotion } from '../../pet/hooks.ts'
import { GraphView } from '../graph/GraphView.tsx'
import { recordCalc } from '../history/store.ts'
import { useCalcContext, useStable } from '../hooks.ts'
import { $calcRates } from '../rates.ts'
import { $notepadSignal, $notesSidebar, $noteScope, $openNote } from '../store.ts'
import { type CaretLine, type Commit, COMMIT_IDLE_MS, committedLine, historyEntry, idleCaret, leaveCaret, moveCaret } from './commit.ts'
import { Editor } from './Editor.tsx'
import { noteGraphEntries, noteScope, sameEntries, sameScope } from './graph.ts'
import { alignResults, lineAt, lineEnd, lineStart, SIDEBAR_INLINE_PX, sidebarShown, splitLines } from './layout.ts'
import { NotesFooter } from './NotesFooter.tsx'
import { NotesSidebar } from './NotesSidebar.tsx'
import { useEvaluation } from './use-evaluation.ts'
import { type DeletedNote, useNotes } from './use-notes.ts'

const SIDEBAR_PX = 240
/** The graph goes beside the note from this wide, under it below. */
const GRAPH_BESIDE_PX = 720
const GRAPH_KEY = 'herald-calc:note-graph'
const UNDO_MS = 8000
const MAX_WAITING_COMMITS = 24
const PLACEHOLDER = 'Try 20% of 84.50, 5 km in miles or days until Dec 25'

function graphPreference(): boolean {
  try {
    return localStorage.getItem(GRAPH_KEY) !== 'hidden'
  } catch {
    return true
  }
}

/** Put text into the textarea as typing would, so the person's undo takes it back; plain state when that is not possible. */
function insertText(element: HTMLTextAreaElement | null, at: number, insert: string, fallback: () => void): void {
  if (element && !element.disabled) {
    element.focus()
    element.setSelectionRange(at, at)

    if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, insert)) {
      return
    }
  }

  fallback()
}

/** The Notes view: the notes list, the sentence notepad with its results, its graph and its total. */
export function Notepad({ active, width }: { active: boolean; width: number }) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const editing = useCallback(() => inputRef.current !== null && document.activeElement === inputRef.current, [])
  const { notes, failed, ready, note, setText, select, create, remove, flush, retry } = useNotes(editing)
  const text = note?.text ?? ''
  const context = useCalcContext(text)
  const evaluation = useEvaluation(note?.id ?? null, text, context)
  const doc = evaluation?.document ?? null
  const lines = useMemo(() => splitLines(text), [text])
  const views = useMemo(() => alignResults(lines, doc?.lines ?? null), [lines, doc])
  const reduced = useReducedMotion()
  const locale = useStore($locale)
  const rates = useStore($calcRates)
  const calcPrefs = normalizeCalcPrefs(useStore($prefs).calc)
  const sidebarSetting = useStore($notesSidebar)
  const signal = useStore($notepadSignal)
  const [typingLine, setTypingLine] = useState<number | null>(null)
  const [deleted, setDeleted] = useState<DeletedNote | null>(null)
  const [graphWanted, setGraphWanted] = useState(graphPreference)
  const caret = useRef<CaretLine | null>(null)
  const commits = useRef<Commit[]>([])
  const lastRecorded = useRef<string | null>(null)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // The editor takes the keyboard once another note than `from` is on screen.
  const pendingFocus = useRef<{ from: string | null; at: number | 'end' } | null>(null)
  // Where the caret goes once text put in without the textarea's help is on screen.
  const pendingCaret = useRef<number | null>(null)
  const handledSignal = useRef(0)
  const latest = useRef({ evaluation, text })
  latest.current = { evaluation, text }

  const sidebarOpen = sidebarShown(sidebarSetting, width)
  const overlay = sidebarOpen && width > 0 && width < SIDEBAR_INLINE_PX
  const mainWidth = width > 0 ? width - (sidebarOpen && !overlay ? SIDEBAR_PX : 0) : 0

  // Lines the person is done with go into the history once the engine has answered for them.
  const settle = useCallback(() => {
    const current = latest.current

    if (!current.evaluation || !commits.current.length) {
      return
    }

    const { document: answer, text: answered } = current.evaluation
    const fresh = answered === current.text
    const title = noteTitle(answered)
    commits.current = commits.current.filter(commit => {
      if (!fresh && !committedLine(commit, answer.lines)) {
        return true
      }

      const found = historyEntry(commit, answer.lines, title, lastRecorded.current)

      if (found) {
        lastRecorded.current = found.key
        recordCalc(found.entry)
      }

      return false
    })
  }, [])

  const queue = useCallback(
    (commit: Commit | null) => {
      if (commit) {
        commits.current = [...commits.current, commit].slice(-MAX_WAITING_COMMITS)
        settle()
      }
    },
    [settle]
  )

  useEffect(settle, [evaluation, settle])

  const track = useCallback(
    (current: string, offset: number, typed: boolean) => {
      const index = lineAt(current, offset)
      const step = moveCaret(caret.current, index, current.slice(lineStart(current, index), lineEnd(current, index)), typed)
      caret.current = step.state
      queue(step.commit)

      if (typed) {
        setTypingLine(index)
        clearTimeout(idleTimer.current)
        idleTimer.current = setTimeout(() => {
          const idle = idleCaret(caret.current)
          caret.current = idle.state
          queue(idle.commit)
          setTypingLine(null)
        }, COMMIT_IDLE_MS)
      } else {
        setTypingLine(line => (line === index ? line : null))
      }
    },
    [queue]
  )

  /** The caret left the note: the line it was on is done. */
  const leave = useCallback(() => {
    clearTimeout(idleTimer.current)
    const step = leaveCaret(caret.current)
    caret.current = step.state
    queue(step.commit)
    setTypingLine(null)
  }, [queue])

  useEffect(() => () => clearTimeout(idleTimer.current), [])

  // Lines still waiting for an answer belong to the note left behind.
  useEffect(() => {
    commits.current = []
    caret.current = null
  }, [note?.id])

  const onText = useCallback(
    (next: string, offset: number) => {
      setText(next)
      track(next, offset, true)
    },
    [setText, track]
  )

  const onCaret = useCallback((offset: number) => track(inputRef.current?.value ?? '', offset, false), [track])

  const onBlur = useCallback(() => {
    leave()
    void flush()
  }, [leave, flush])

  const choose = useCallback(
    (id: string) => {
      leave()

      if (overlay) {
        $notesSidebar.set('auto')
      }

      if (id === note?.id) {
        inputRef.current?.focus()

        return
      }

      pendingFocus.current = { from: note?.id ?? null, at: 0 }
      void select(id)
    },
    [leave, overlay, note?.id, select]
  )

  const startNote = useCallback(
    (initial = '', focus = true) => {
      leave()
      const from = note?.id ?? null
      pendingFocus.current = focus ? { from, at: 'end' } : null

      void create(initial).then(id => {
        // New note on a blank note keeps it: no other note comes to take the keyboard.
        if (focus && id !== null && id === from) {
          pendingFocus.current = null
          inputRef.current?.focus()
        }
      })
    },
    [leave, note?.id, create]
  )

  const deleteNote = useCallback(
    (id: string) => {
      if (id === note?.id) {
        leave()
      }

      void remove(id).then(removed => {
        if (removed) {
          setDeleted(removed)
        }
      })
    },
    [leave, note?.id, remove]
  )

  const insertBelow = useCallback(
    (index: number, value: string) => {
      const element = inputRef.current
      const current = element?.value ?? text
      const at = lineEnd(current, index)
      const insert = `\n${value}`
      insertText(element, at, insert, () => {
        pendingCaret.current = at + insert.length
        onText(current.slice(0, at) + insert + current.slice(at), at + insert.length)
      })
    },
    [text, onText]
  )

  const appendLine = useCallback(
    (line: string) => {
      const element = inputRef.current
      const current = element?.value ?? text
      const insert = current && !current.endsWith('\n') ? `\n${line}` : line
      insertText(element, current.length, insert, () => {
        pendingCaret.current = current.length + insert.length
        onText(current + insert, current.length + insert.length)
      })
    },
    [text, onText]
  )

  useLayoutEffect(() => {
    const element = inputRef.current
    const wanted = pendingFocus.current

    if (!element || !wanted || note?.id === wanted.from) {
      return
    }

    pendingFocus.current = null
    const at = wanted.at === 'end' ? element.value.length : Math.min(wanted.at, element.value.length)
    element.focus()
    element.setSelectionRange(at, at)
  }, [note?.id])

  useLayoutEffect(() => {
    const element = inputRef.current
    const at = pendingCaret.current

    if (!element || at === null) {
      return
    }

    pendingCaret.current = null
    element.focus()
    element.setSelectionRange(Math.min(at, element.value.length), Math.min(at, element.value.length))
  }, [text])

  // Requests and shortcuts from the window: a new note, or a line from the history.
  useEffect(() => {
    if (!signal || !ready || signal.id <= handledSignal.current) {
      return
    }

    handledSignal.current = signal.id
    $notepadSignal.set(null)

    if (signal.kind === 'new' || !note) {
      startNote(signal.text, signal.focus)
    } else {
      appendLine(signal.text)
    }
  }, [signal, ready, note, startNote, appendLine])

  useEffect(() => {
    if (!deleted) {
      return
    }

    const timer = setTimeout(() => setDeleted(null), UNDO_MS)

    return () => clearTimeout(timer)
  }, [deleted])

  useEffect(() => {
    $openNote.set({ title: note ? noteTitle(text) : '', text, document: evaluation?.document ?? null, documentText: evaluation?.text ?? null, context })
  }, [note, text, evaluation, context])

  const graphEntries = useMemo(() => noteGraphEntries(doc), [doc])
  const scope = useMemo(() => noteScope(doc), [doc])
  // Steady while the functions and names stay the same, so the graph does not draw again at every keystroke.
  const stableEntries = useStable(graphEntries, sameEntries)
  const stableScope = useStable(scope, sameScope)

  useEffect(() => {
    if (!sameScope($noteScope.get(), stableScope)) {
      $noteScope.set(stableScope)
    }
  }, [stableScope])

  const hasGraph = stableEntries.length > 0
  const graphShown = hasGraph && graphWanted
  const graphBeside = mainWidth === 0 || mainWidth >= GRAPH_BESIDE_PX

  const setGraph = useCallback((shown: boolean) => {
    setGraphWanted(shown)

    try {
      localStorage.setItem(GRAPH_KEY, shown ? 'shown' : 'hidden')
    } catch {
      // Not remembered, then.
    }
  }, [])

  const showGraph = useCallback(() => setGraph(true), [setGraph])

  const body = failed ? (
    <div className="flex flex-1 items-center justify-center p-6">
      <EmptyGlass
        icon={<IconNotes />}
        title="Could not read your notes"
        description="Herald keeps them in its data folder; it may be busy for a moment."
        action={
          <GlassButton size="sm" onClick={retry}>
            Try again
          </GlassButton>
        }
      />
    </div>
  ) : !ready ? (
    <div className="flex-1 space-y-3 px-5 pt-5" aria-hidden="true">
      {[70, 45, 60].map(size => (
        <div key={size} className={cn('h-4 rounded-md', !reduced && 'shimmer')} style={{ width: `${size}%` }} />
      ))}
    </div>
  ) : !note ? (
    <div className="flex flex-1 items-center justify-center p-6">
      <EmptyGlass
        icon={<IconNotes />}
        title="No notes"
        description="A note is a page of sums: each line works itself out as you type."
        action={
          <GlassButton size="sm" variant="primary" onClick={() => startNote()}>
            <IconPlus />
            New note
          </GlassButton>
        }
      />
    </div>
  ) : (
    <div className={cn('flex min-h-0 flex-1', graphBeside ? 'flex-row' : 'flex-col')}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Editor
          key={note.id}
          text={text}
          lines={lines}
          views={views}
          typingLine={typingLine}
          inputRef={inputRef}
          reduced={reduced}
          placeholder={PLACEHOLDER}
          onText={onText}
          onCaret={onCaret}
          onBlur={onBlur}
          onInsertBelow={insertBelow}
          onShowGraph={showGraph}
        />
      </div>
      {graphShown && (
        <div className={cn('flex min-h-0 min-w-0 shrink-0', graphBeside ? 'w-[min(42%,26rem)] border-l border-line' : 'h-[clamp(10rem,38%,16rem)] border-t border-line', !reduced && 'animate-fade-in')}>
          <GraphView entries={stableEntries} scope={stableScope} compact className="min-h-0 min-w-0 flex-1" />
        </div>
      )}
    </div>
  )

  return (
    <div className="relative flex h-full min-h-0 w-full">
      {sidebarOpen && (
        <>
          {overlay && <button type="button" aria-label="Close the notes list" tabIndex={-1} onClick={() => $notesSidebar.set('auto')} className={cn('absolute inset-0 z-20 cursor-default bg-black/25', !reduced && 'animate-fade-in')} />}
          <NotesSidebar notes={notes} activeId={note?.id ?? null} overlay={overlay} reduced={reduced} onSelect={choose} onNew={() => startNote()} onDelete={deleteNote} onClose={() => $notesSidebar.set('auto')} />
        </>
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {body}
        {ready && note && (
          <NotesFooter
            total={doc?.totalDisplay ?? null}
            usesRates={Boolean(doc?.usesRates)}
            rates={rates}
            fetchRates={calcPrefs.fetchRates}
            locale={locale}
            graph={hasGraph ? { shown: graphShown, toggle: () => setGraph(!graphWanted) } : null}
            reduced={reduced}
          />
        )}
        {deleted && (
          <div role="status" className={cn('float absolute bottom-14 left-1/2 z-20 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-1 rounded-xl py-1 pr-1 pl-3 text-[12.5px]', !reduced && 'animate-rise')}>
            <span className="min-w-0 truncate text-fg-2">Deleted “{deleted.title}”</span>
            <GlassButton
              size="sm"
              variant="ghost"
              onClick={() => {
                const restored = deleted
                setDeleted(null)
                startNote(restored.text, active)
              }}
            >
              <IconArrowBackUp />
              Undo
            </GlassButton>
            <button type="button" aria-label="Dismiss" onClick={() => setDeleted(null)} className="flex size-7 items-center justify-center rounded-lg text-fg-4 hover:bg-white/8 hover:text-fg-2">
              <IconX size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
