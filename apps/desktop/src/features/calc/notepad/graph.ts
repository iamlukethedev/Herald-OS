import type { DocumentResult, PlotFunction } from '../engine/types.ts'
import type { GraphEntry } from '../graph/types.ts'

/** What a function draws in the Graph view, which reads functions of x. */
export function functionText(plot: PlotFunction): string {
  const variable = plot.variable.trim()

  if (!variable || variable === 'x' || !/^[\p{L}_][\p{L}\d_]*$/u.test(variable)) {
    return plot.expression
  }

  return plot.expression.replace(new RegExp(`(?<![\\p{L}\\d_])${variable}(?![\\p{L}\\d_])`, 'gu'), 'x')
}

/** The note's graph: each function to draw (and each sheet to read) in line order. */
export function noteGraphEntries(document: DocumentResult | null): GraphEntry[] {
  const entries: GraphEntry[] = []

  for (const line of document?.lines ?? []) {
    if ((line.kind === 'function' || line.kind === 'plot') && line.plot) {
      entries.push({ id: `note-${line.index}`, text: functionText(line.plot) })
    } else if (line.kind === 'plot' && line.plotSource?.trim()) {
      entries.push({ id: `note-${line.index}`, text: line.plotSource.trim() })
    }
  }

  return entries
}

/** The numbers the note names, as they stand at its end, for functions that use them ("a * x^2"). */
export function noteScope(document: DocumentResult | null): Record<string, number> {
  const scope: Record<string, number> = {}

  for (const line of document?.lines ?? []) {
    if (line.name && line.value?.kind === 'number' && Number.isFinite(line.value.number)) {
      scope[line.name] = line.value.number
    }
  }

  return scope
}

/** Two lists draw the same things. */
export function sameEntries(a: readonly GraphEntry[], b: readonly GraphEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry.id === b[index].id && entry.text === b[index].text)
}

/** Two scopes name the same numbers. */
export function sameScope(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a)

  return keys.length === Object.keys(b).length && keys.every(key => b[key] === a[key])
}
