import { useStore } from '@nanostores/react'
import type { ApprovalChoice, ApprovalRequestParams, ClarifyRequestParams } from '@herald-os/client'
import { IconKey, IconLock, IconMicrophone, IconQuestionMark, IconShieldCheck } from '@tabler/icons-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from '../components/ui/button.tsx'
import { Badge } from '../components/ui/primitives.tsx'
import { type ApprovalShape, approvalFacts } from '../lib/approval-choices.ts'
import { deviceNoun } from '../lib/platform-labels.ts'
import { takeRequestFocus } from '../lib/request-focus.ts'
import { $petHeldApproval } from '../features/pet/transport.ts'
import { $pendingRequests, type PendingRequest, resolveRequest } from '../store/requests.ts'
import { $voiceActive, $voiceSessionId } from '../store/voice.ts'

/**
 * One host for every server->client question. Cards stack bottom-right; the oldest is on top so
 * the agent thread that has waited longest unblocks first. Gestures never grant approval. An
 * approval the desktop pet is holding up stays with the pet. No card ever focuses one of its own
 * answers, so a key pressed for something else cannot answer it.
 */
export function RequestHost() {
  const held = useStore($petHeldApproval)
  const pending = useStore($pendingRequests).filter(entry => entry.request.id !== held)

  if (pending.length === 0) {
    return null
  }

  const [current, ...rest] = pending

  return (
    <div className="pointer-events-none absolute right-5 bottom-[92px] z-(--z-request) flex w-[420px] flex-col items-stretch gap-2">
      {rest.length > 0 && <div className="pointer-events-auto self-end text-[11px] text-fg-3">{rest.length} more waiting</div>}
      <RequestFrame key={current.request.id} entry={current} />
    </div>
  )
}

const FRAME_LABEL: Record<PendingRequest['kind'], string> = { approval: 'Hermes is asking for permission', clarify: 'Hermes has a question', sudo: 'Administrator password', secret: 'Hermes needs a secret' }

/** One request's card: it takes the focus only from nothing being typed in, and gives it back when it goes. */
function RequestFrame({ entry }: { entry: PendingRequest }) {
  const frame = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => (frame.current ? takeRequestFocus(frame.current) : undefined), [])

  return (
    <div ref={frame} role="group" aria-label={FRAME_LABEL[entry.kind]} tabIndex={-1} className="float pointer-events-auto rounded-2xl p-4 outline-none animate-rise">
      <RequestCard entry={entry} />
    </div>
  )
}

function RequestCard({ entry }: { entry: PendingRequest }) {
  switch (entry.kind) {
    case 'approval':
      return <ApprovalCard id={entry.request.id} params={entry.request.params} />
    case 'clarify':
      return <ClarifyCard id={entry.request.id} params={entry.request.params} />
    case 'sudo':
      return <ValueCard id={entry.request.id} icon={<IconLock size={16} />} title="Administrator password" description={entry.request.params.command} secret />
    case 'secret':
      return <ValueCard id={entry.request.id} icon={<IconKey size={16} />} title={entry.request.params.prompt || `Provide ${entry.request.params.env_var}`} description={entry.request.params.env_var} secret />
  }
}

const CHOICE_LABEL: Record<ApprovalChoice, string> = { once: 'Allow once', session: 'Allow this session', always: 'Always allow', deny: 'Deny' }

export type ApprovalCardParams = ApprovalShape & Pick<Partial<ApprovalRequestParams>, 'session_id' | 'gateway_session_id'>

/**
 * The approval card, here and in the pet's hands. `onChoice` routes the answer (the pet's goes to the
 * window that holds the request); `voiceHint` says whether a spoken answer counts when this window
 * cannot tell. No answer is ever focused for the person, so a key pressed elsewhere cannot answer it.
 */
export function ApprovalCard({ id, params, onChoice, voiceHint }: { id: string; params: ApprovalCardParams; onChoice?: (choice: ApprovalChoice) => void; voiceHint?: boolean }) {
  const voiceActive = useStore($voiceActive)
  const voiceSession = useStore($voiceSessionId)
  // A running conversation on this card's session takes a spoken "yes" (allow once) or "no".
  const answerByVoice = voiceHint ?? (voiceActive && voiceSession !== null && (params.session_id === voiceSession || params.gateway_session_id === voiceSession))
  const { bridgeTool, toolName, destructive, choices } = approvalFacts(params)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-accent">
          <IconShieldCheck size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px] font-medium">
            {bridgeTool ? `Hermes wants to act on this ${deviceNoun()}` : 'Hermes is asking for permission'}
            {toolName && <Badge tone={destructive ? 'danger' : 'accent'}>{toolName.replace(/^system_/, '').replace(/_/g, ' ')}</Badge>}
          </div>
          {params.description && <div className="mt-1 text-[12.5px] text-fg-2">{params.description}</div>}
        </div>
      </div>
      {params.command && !bridgeTool && (
        <pre className="selectable max-h-40 overflow-auto rounded-md bg-surface px-3 py-2 font-mono text-[12px] leading-relaxed text-fg hairline whitespace-pre-wrap">{params.command}</pre>
      )}
      {answerByVoice && (
        <div className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
          <IconMicrophone size={13} />
          Or say "yes" to allow once, or "no" to deny.
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {choices.map(choice => (
          <Button
            key={choice}
            variant={choice === 'deny' ? 'danger' : choice === 'once' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => (onChoice ? onChoice(choice) : resolveRequest(id, { choice }))}
          >
            {CHOICE_LABEL[choice]}
          </Button>
        ))}
      </div>
    </div>
  )
}

function ClarifyCard({ id, params }: { id: string; params: ClarifyRequestParams }) {
  const questions = params.questions?.length ? params.questions : [{ qid: '_single', question: params.question ?? 'Hermes needs more information', choices: params.choices ?? null, multi_select: Boolean(params.multi_select) }]
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const single = questions.length === 1 && questions[0].qid === '_single'
  const set = (qid: string, value: string) => setAnswers(prev => ({ ...prev, [qid]: value }))
  const submit = () => {
    if (single) {
      resolveRequest(id, { answer: answers._single ?? '' })
    } else {
      resolveRequest(id, { answers })
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-info">
          <IconQuestionMark size={16} />
        </span>
        <div className="text-[13px] font-medium">Hermes has a question</div>
      </div>
      {questions.map(question => (
        <div key={question.qid} className="flex flex-col gap-2">
          <div className="text-[12.5px] text-fg-2">{question.question}</div>
          {question.choices?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {question.choices.map(choice => {
                const selected = question.multi_select ? (answers[question.qid] ?? '').split('\n').includes(choice) : answers[question.qid] === choice

                return (
                  <button
                    key={choice}
                    type="button"
                    onClick={() => {
                      if (!question.multi_select) {
                        set(question.qid, choice)

                        return
                      }

                      const current = (answers[question.qid] ?? '').split('\n').filter(Boolean)
                      set(question.qid, (current.includes(choice) ? current.filter(c => c !== choice) : [...current, choice]).join('\n'))
                    }}
                    className={`rounded-sm px-2.5 py-1 text-[12px] transition-colors ${selected ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-fg-2 hover:bg-surface-3'}`}
                  >
                    {choice}
                  </button>
                )
              })}
            </div>
          ) : null}
          <input
            value={answers[question.qid] ?? ''}
            onChange={event => set(question.qid, event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                submit()
              }
            }}
            placeholder={question.choices?.length ? 'Or type your own answer' : 'Type your answer'}
            className="h-8 rounded-sm bg-surface px-2.5 text-[12.5px] outline-none hairline focus:shadow-[0_0_0_1px_var(--color-accent)]"
          />
        </div>
      ))}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => resolveRequest(id, single ? { answer: '' } : {})}>
          Skip
        </Button>
        <Button variant="primary" size="sm" onClick={submit}>
          Answer
        </Button>
      </div>
    </div>
  )
}

function ValueCard({ id, icon, title, description, secret }: { id: string; icon: React.ReactNode; title: string; description?: string; secret?: boolean }) {
  const [value, setValue] = useState('')

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-warn">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{title}</div>
          {description && <pre className="selectable mt-1 max-h-24 overflow-auto font-mono text-[12px] whitespace-pre-wrap text-fg-2">{description}</pre>}
        </div>
      </div>
      <input
        type={secret ? 'password' : 'text'}
        value={value}
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            resolveRequest(id, { value })
          }
        }}
        className="h-8 rounded-sm bg-surface px-2.5 text-[12.5px] outline-none hairline focus:shadow-[0_0_0_1px_var(--color-accent)]"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => resolveRequest(id, { value: '' })}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={() => resolveRequest(id, { value })}>
          Continue
        </Button>
      </div>
    </div>
  )
}
