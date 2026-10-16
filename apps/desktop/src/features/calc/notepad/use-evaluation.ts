import { useEffect, useRef, useState } from 'react'
import { describeError, logFailure } from '../../../lib/report.ts'
import { evaluateDocument } from '../engine/index.ts'
import type { CalcContext, DocumentResult } from '../engine/types.ts'

/** How long typing rests before the note is worked out again. */
export const EVALUATE_DELAY_MS = 60

export interface Evaluation {
  /** The note it belongs to. */
  key: string
  text: string
  document: DocumentResult
}

const reported = new Set<string>()

/** Each distinct engine failure once a session: the note asks again after every keystroke. */
function reportOnce(error: unknown): void {
  const text = describeError(error)

  if (!reported.has(text)) {
    reported.add(text)
    logFailure('calc.evaluateDocument')(error)
  }
}

/** The note worked out a moment after each change of its text or context; answers to older asks are dropped. */
export function useEvaluation(key: string | null, text: string, context: CalcContext): Evaluation | null {
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null)
  const ticket = useRef(0)

  useEffect(() => {
    const mine = ++ticket.current

    if (key === null) {
      return
    }

    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => evaluateDocument(text, context))
        .then(
          document => {
            if (mine === ticket.current) {
              setEvaluation({ key, text, document })
            }
          },
          error => {
            if (mine === ticket.current) {
              reportOnce(error)
            }
          }
        )
    }, EVALUATE_DELAY_MS)

    return () => clearTimeout(timer)
  }, [key, text, context])

  return evaluation && evaluation.key === key ? evaluation : null
}
