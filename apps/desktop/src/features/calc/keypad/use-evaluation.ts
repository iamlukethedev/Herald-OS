import { useEffect, useState } from 'react'
import { describeError } from '../../../lib/report.ts'
import { calcContext } from '../context.ts'
import { type CalcContext, type EvalResult, evaluate } from '../engine/index.ts'

/*
 * The engine for the keypads: each expression is evaluated once and remembered, so the display, the
 * live preview and '=' share answers while the person types.
 */

const ANSWERS_MAX = 400
const CONTEXT_MAX_AGE_MS = 60_000
const answers = new Map<string, EvalResult>()
const running = new Map<string, Promise<EvalResult>>()
let context: { at: number; value: Promise<CalcContext> } | null = null

function keypadContext(): Promise<CalcContext> {
  if (!context || Date.now() - context.at > CONTEXT_MAX_AGE_MS) {
    context = { at: Date.now(), value: calcContext() }
  }

  return context.value
}

function remember(expression: string, result: EvalResult): void {
  answers.delete(expression)
  answers.set(expression, result)

  if (answers.size > ANSWERS_MAX) {
    const oldest = answers.keys().next()

    if (!oldest.done) {
      answers.delete(oldest.value)
    }
  }
}

/** The engine's answer; not reaching the engine is an answer too, but one that is not kept. */
export function evaluateExpression(expression: string): Promise<EvalResult> {
  const known = answers.get(expression)

  if (known) {
    return Promise.resolve(known)
  }

  let answer = running.get(expression)

  if (!answer) {
    answer = keypadContext()
      .then(calc => evaluate(expression, calc))
      .then(
        result => {
          remember(expression, result)

          return result
        },
        (error: unknown): EvalResult => {
          context = null

          return { ok: false, input: expression, steps: [], error: describeError(error) }
        }
      )
      .finally(() => running.delete(expression))
    running.set(expression, answer)
  }

  return answer
}

/** The answer for `expression` once the engine has it; null while it works, and for no expression. */
export function useEvaluation(expression: string | null): EvalResult | null {
  const [answer, setAnswer] = useState<{ expression: string; result: EvalResult } | null>(null)

  useEffect(() => {
    if (!expression || answers.has(expression)) {
      return
    }

    let live = true

    void evaluateExpression(expression).then(result => {
      if (live) {
        setAnswer({ expression, result })
      }
    })

    return () => {
      live = false
    }
  }, [expression])

  if (!expression) {
    return null
  }

  return answers.get(expression) ?? (answer?.expression === expression ? answer.result : null)
}
