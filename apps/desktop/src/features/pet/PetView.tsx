import { IconBattery1, IconBox, IconDatabaseExclamation, IconNote, IconX } from '@tabler/icons-react'
import { type CSSProperties, type DragEvent, type HTMLAttributes, type RefObject, useLayoutEffect, useRef, useState } from 'react'
import type { PetActivity, PetDropSuggestionId, PetSnapshot } from '../../../shared/pet.ts'
import { cn } from '../../lib/cn.ts'
import { takeRequestFocus } from '../../lib/request-focus.ts'
import { requestShortcut } from '../../lib/request-keys.ts'
import { ApprovalCard } from '../../shell/RequestHost.tsx'
import { useT } from '../../store/i18n.ts'
import { dropAction, dropSuggestions } from './drops.ts'
import type { PetDrop, PetExtras, PetUi } from './hooks.ts'
import { PetBubble } from './PetBubble.tsx'
import { PetSprite } from './PetSprite.tsx'
import type { LoadedSheet } from './sheet.ts'
import type { PetPose } from './sprite.ts'
import type { ExtrasLayout } from './stage.ts'
import { petAct } from './transport.ts'

const DOING: Record<PetActivity, string> = {
  idle: 'Hermes is free',
  thinking: 'Hermes is thinking',
  running: 'Hermes is running a tool',
  cheering: 'Hermes finished',
  drooping: 'Something went wrong',
  listening: 'Hermes is listening',
  waiting: 'Hermes needs your answer'
}

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation()

export const hasFiles = (event: DragEvent): boolean => [...event.dataTransfer.types].includes('Files')

export function droppedPaths(event: DragEvent): string[] {
  return [...event.dataTransfer.files].map(file => window.heraldOS.fs.pathForFile(file)).filter((value): value is string => Boolean(value))
}

/** What a dropped file can become: the suggestions that fit it, and a box to ask anything about it. */
function DropPanel({ drop, onPick, onClose }: { drop: PetDrop; onPick: (suggestion: PetDropSuggestionId, text?: string) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const names = drop.paths.map(item => item.split(/[\\/]/).pop()).join(', ')
  const asks = drop.suggestions.some(suggestion => suggestion.id === 'ask')

  return (
    <div className="float pointer-events-auto flex w-[270px] flex-col gap-2 rounded-2xl p-3 animate-pop">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-[12.5px] font-medium" title={names}>
          {names}
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="flex size-6 items-center justify-center rounded-md text-fg-3 hover:bg-white/10 hover:text-fg">
          <IconX size={14} />
        </button>
      </div>
      <div className="flex flex-col gap-1">
        {drop.suggestions
          .filter(suggestion => suggestion.id !== 'ask')
          .map(suggestion => (
            <button key={suggestion.id} type="button" onClick={() => onPick(suggestion.id)} className="rounded-lg bg-white/6 px-2.5 py-1.5 text-left text-[12.5px] text-fg hover:bg-white/10">
              {suggestion.label}
            </button>
          ))}
      </div>
      {asks && (
        <input
          value={text}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && text.trim()) {
              event.preventDefault()
              onPick('ask', text.trim())
            } else if (event.key === 'Escape') {
              onClose()
            }
          }}
          placeholder="Or ask about it"
          aria-label="Ask about the file"
          className="glass-input h-8 rounded-lg px-2.5 text-[12.5px] outline-none"
        />
      )}
    </div>
  )
}

export interface PetViewProps {
  sheet: LoadedSheet
  scale: number
  snapshot: PetSnapshot
  ui: PetUi
  extras: PetExtras
  layout: ExtrasLayout
  pose: PetPose
  poseSince: number
  rest: boolean
  reduced: boolean
  paused: boolean
  dropping: boolean
  onDropping: (on: boolean) => void
  /** Pointer handlers for dragging and clicking the pet, from its window. */
  spriteProps: HTMLAttributes<HTMLDivElement>
  groupRef?: RefObject<HTMLDivElement | null>
  inputRef?: RefObject<HTMLInputElement | null>
  className?: string
  style?: CSSProperties
}

/**
 * The approval in the pet's hands. It never takes the focus as it appears; the request shortcut can
 * move the focus to it, and when it goes the focus returns to where it came from.
 */
export function PetApprovalCard({ approval, waiting }: { approval: NonNullable<PetSnapshot['approval']>; waiting: number }) {
  const t = useT()
  const card = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => (card.current ? takeRequestFocus(card.current, { take: false }) : undefined), [])

  return (
    <div ref={card} role="group" aria-label={t('requests.card.approval')} aria-keyshortcuts={requestShortcut().aria} data-request-card={approval.id} tabIndex={-1} className="float pointer-events-auto w-[360px] rounded-2xl p-4 outline-none animate-rise">
      <ApprovalCard id={approval.id} params={approval.params} voiceHint={approval.voice} onChoice={choice => petAct({ type: 'answer', id: approval.id, choice })} />
      {waiting > 0 && <div className="mt-2 text-right text-[11px] text-fg-3">{waiting} more waiting</div>}
    </div>
  )
}

/** The pet and what it holds: the approval card, its chat, what a dropped file can become, or a few words. */
export function PetView({ sheet, scale, snapshot, ui, extras, layout, pose, poseSince, rest, reduced, paused, dropping, onDropping, spriteProps, groupRef, inputRef, className, style }: PetViewProps) {
  const approval = snapshot.approval
  const note = snapshot.note
  const mood = snapshot.mood

  const pick = (drop: PetDrop, suggestion: PetDropSuggestionId, text?: string) => {
    ui.setDrop(null)
    petAct({ type: 'drop', paths: drop.paths, suggestion, text })

    if (dropAction(suggestion, drop.paths, text)?.kind === 'prompt') {
      ui.setBubble(true)
    }
  }

  const extrasNode =
    extras === 'card' && approval ? (
      <PetApprovalCard approval={approval} waiting={snapshot.approvalsWaiting} />
    ) : extras === 'drop' && ui.drop ? (
      <DropPanel drop={ui.drop} onPick={(suggestion, text) => pick(ui.drop!, suggestion, text)} onClose={() => ui.setDrop(null)} />
    ) : extras === 'bubble' ? (
      <PetBubble
        chat={snapshot.chat}
        step={snapshot.chat.working ? (snapshot.chat.step ?? 'Thinking') : snapshot.step}
        inputRef={inputRef}
        onAsk={text => petAct({ type: 'ask', text })}
        onStop={() => petAct({ type: 'stop' })}
        onOpen={() => petAct({ type: 'openInHermes' })}
        onNew={() => petAct({ type: 'newChat' })}
        onClose={() => ui.setBubble(false)}
      />
    ) : extras === 'say' && ui.say ? (
      <button type="button" onClick={() => ui.setBubble(true)} className="float pointer-events-auto w-max max-w-[260px] rounded-2xl px-3 py-2 text-left text-[12.5px] leading-snug text-fg animate-pop">
        {ui.say}
      </button>
    ) : null

  const label = `${DOING[snapshot.activity]}${snapshot.step ? `: ${snapshot.step}` : ''}`

  return (
    <div ref={groupRef} className={cn('flex flex-col gap-2', layout.align === 'end' ? 'items-end' : 'items-start', className)} style={style}>
      {layout.above && extrasNode}
      <div
        {...spriteProps}
        role="button"
        aria-label={`Hermes's pet. ${label}`}
        title={label}
        onDragOver={event => {
          if (hasFiles(event)) {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
            onDropping(true)
          }
        }}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            onDropping(false)
          }
        }}
        onDrop={event => {
          onDropping(false)

          if (!hasFiles(event)) {
            return
          }

          event.preventDefault()
          const paths = droppedPaths(event)

          if (paths.length) {
            ui.setBubble(false)
            ui.setDrop({ paths, suggestions: dropSuggestions(paths) })
          }
        }}
        className={cn('pointer-events-auto relative cursor-grab touch-none rounded-2xl transition-[background-color] select-none active:cursor-grabbing', dropping && 'bg-accent-soft')}
      >
        <PetSprite sheet={sheet} pose={pose} since={poseSince} scale={scale} reduced={reduced} paused={paused} rest={rest} />
        {snapshot.badge > 0 && (
          <span title={`${snapshot.badge} running in the background`} className="absolute top-0 right-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-fg tabular-nums">
            {snapshot.badge}
          </span>
        )}
        {mood && (
          <span title={mood.text} aria-label={mood.text} className="absolute top-0 left-0 flex size-5 items-center justify-center rounded-full bg-bg-elevated text-warn shadow">
            {mood.kind === 'battery' ? <IconBattery1 size={13} /> : <IconDatabaseExclamation size={13} />}
          </span>
        )}
        {note && (
          <span className="group/reveal-row absolute bottom-0 left-0 flex items-center" onPointerDown={stop} onClick={stop}>
            <button type="button" title={note.text} aria-label={note.text} onClick={() => petAct({ type: 'openNote' })} className="flex size-6 items-center justify-center rounded-full bg-bg-elevated text-accent-strong shadow hover:bg-surface-3">
              {note.kind === 'update' ? <IconBox size={14} /> : <IconNote size={14} />}
            </button>
            <button type="button" aria-label="Not now" title="Not now" onClick={() => petAct({ type: 'dismissNote' })} className="reveal ml-0.5 flex size-4 items-center justify-center rounded-full bg-bg-elevated text-fg-3 hover:text-fg">
              <IconX size={10} />
            </button>
          </span>
        )}
      </div>
      {!layout.above && extrasNode}
    </div>
  )
}
