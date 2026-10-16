import { useCallback, useEffect, useMemo, useState } from 'react'
import { messageOf } from '../../canvas/errors.ts'
import { compileFunction } from '../engine/index.ts'
import type { CompiledFunction } from '../engine/types.ts'
import { parseSheetPlot } from './sampling.ts'
import { readSheetSeries } from './sheets-source.ts'
import type { GraphEntry, GraphSeries, SheetPlotRef } from './types.ts'

/* What each line of the Graph view draws, a compiled function or a sheet's numbers, kept across renders and views. */

export type EntrySource =
  | { kind: 'empty' }
  | { kind: 'loading'; sheet: SheetPlotRef | null }
  | { kind: 'function'; fn: CompiledFunction }
  | { kind: 'sheet'; sheet: SheetPlotRef; series: GraphSeries }
  | { kind: 'error'; message: string; sheet: SheetPlotRef | null }

interface Job<T> {
  promise: Promise<T>
  at: number
  value?: T
  error?: string
  /** What the read before gave, shown while this one is under way. */
  previous?: T
}

type Plan = { kind: 'empty' } | { kind: 'function'; key: string; expression: string } | { kind: 'sheet'; key: string; sheet: SheetPlotRef }

const compiled = new Map<string, Job<CompiledFunction>>()
const sheets = new Map<string, Job<GraphSeries>>()
const MOST_COMPILED = 200
/** A sheet read longer ago than this is read again the next time a graph asks for it. */
const SHEET_FRESH_MS = 60_000

function settle<T>(promise: Promise<T>, previous?: T): Job<T> {
  const job: Job<T> = { promise, at: Date.now(), ...(previous === undefined ? {} : { previous }) }

  promise.then(
    value => {
      job.value = value
    },
    (error: unknown) => {
      job.error = messageOf(error)
    }
  )

  return job
}

/** What to compile from a line as typed: "y = sin(x)", "f(x) = x^2" and "plot sin(x)" draw what follows. */
export function expressionOf(text: string): string {
  return text
    .trim()
    .replace(/^(?:plot|graph|draw)\s+/i, '')
    .replace(/^(?:y|[a-z]\w*\s*\(\s*x\s*\))\s*=(?!=)\s*/i, '')
    .trim()
}

function planOf(text: string, scopeKey: string): Plan {
  const sheet = parseSheetPlot(text)

  if (sheet) {
    return { kind: 'sheet', key: JSON.stringify(sheet), sheet }
  }

  const expression = expressionOf(text)

  return expression ? { kind: 'function', key: `${scopeKey}\n${expression}`, expression } : { kind: 'empty' }
}

function start(plan: Plan, scope: Record<string, number> | undefined): Job<unknown> | null {
  if (plan.kind === 'function') {
    const known = compiled.get(plan.key)

    if (known) {
      return known
    }

    const job = settle(compileFunction(plan.expression, { variable: 'x', scope }))
    compiled.set(plan.key, job)

    if (compiled.size > MOST_COMPILED) {
      const oldest = compiled.keys().next().value

      if (oldest !== undefined) {
        compiled.delete(oldest)
      }
    }

    return job
  }

  if (plan.kind === 'sheet') {
    const known = sheets.get(plan.key)

    if (known && !(known.value !== undefined && Date.now() - known.at > SHEET_FRESH_MS)) {
      return known
    }

    const job = settle(readSheetSeries(plan.sheet), known?.value ?? known?.previous)
    sheets.set(plan.key, job)

    return job
  }

  return null
}

function sourceOf(plan: Plan): EntrySource {
  if (plan.kind === 'empty') {
    return plan
  }

  if (plan.kind === 'function') {
    const job = compiled.get(plan.key)

    if (job?.value) {
      return { kind: 'function', fn: job.value }
    }

    return job?.error !== undefined ? { kind: 'error', message: job.error, sheet: null } : { kind: 'loading', sheet: null }
  }

  const job = sheets.get(plan.key)

  if (job?.value) {
    return { kind: 'sheet', sheet: plan.sheet, series: job.value }
  }

  if (job?.error !== undefined) {
    return { kind: 'error', message: job.error, sheet: plan.sheet }
  }

  return job?.previous ? { kind: 'sheet', sheet: plan.sheet, series: job.previous } : { kind: 'loading', sheet: plan.sheet }
}

const scopeKeyOf = (scope: Record<string, number> | undefined): string =>
  scope
    ? JSON.stringify(
        Object.entries(scope)
          .filter(([, value]) => typeof value === 'number')
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      )
    : ''

/** Each entry's function or numbers, compiled and read once per text and scope; `retry` reads a sheet again. */
export function useGraphSources(entries: readonly GraphEntry[], scope?: Record<string, number>): { sources: EntrySource[]; retry: (text: string) => void } {
  const scopeKey = scopeKeyOf(scope)
  const textsKey = entries.map(entry => entry.text).join('\u0000')
  const [settled, setSettled] = useState(0)
  const [attempt, setAttempt] = useState(0)

  // The scope's values are in scopeKey; its object is new on every render of the note.
  useEffect(() => {
    let live = true
    const bump = () => {
      if (live) {
        setSettled(count => count + 1)
      }
    }

    for (const text of textsKey.split('\u0000')) {
      void start(planOf(text, scopeKey), scope)?.promise.then(bump, bump)
    }

    return () => {
      live = false
    }
  }, [textsKey, scopeKey, attempt])

  const count = entries.length
  // `settled` and `attempt` change when a read finishes and when one is asked for again.
  const sources = useMemo(() => (count ? textsKey.split('\u0000').map(text => sourceOf(planOf(text, scopeKey))) : []), [count, textsKey, scopeKey, settled, attempt])

  const retry = useCallback((text: string) => {
    const sheet = parseSheetPlot(text)

    if (sheet) {
      sheets.delete(JSON.stringify(sheet))
      setAttempt(count => count + 1)
    }
  }, [])

  return { sources, retry }
}
