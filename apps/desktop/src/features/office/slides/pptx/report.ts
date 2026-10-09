/*
 * What opening a PowerPoint file kept: each element counted by kind as kept, shown approximately or
 * left out, why each approximation was made, and what of the deck Herald does not keep (animations,
 * macros…). Its notes are what the fidelity report lists before the first save over the file.
 */

export const REPORT_KINDS = ['text', 'shape', 'picture', 'line', 'group', 'table', 'chart', 'smartart', 'video', 'audio', 'ole', 'ink', 'other'] as const

export type ReportKind = (typeof REPORT_KINDS)[number]

export interface KindCount {
  imported: number
  approximated: number
  skipped: number
}

export interface ImportReport {
  counts: Record<ReportKind, KindCount>
  /** Why elements were approximated or left out, with how many times each. */
  reasons: Record<string, number>
  /** What the deck had that Herald does not keep, with how many (slides, fonts, comments…). */
  dropped: Record<string, number>
}

export function emptyReport(): ImportReport {
  return { counts: Object.fromEntries(REPORT_KINDS.map((kind) => [kind, { imported: 0, approximated: 0, skipped: 0 }])) as Record<ReportKind, KindCount>, reasons: {}, dropped: {} }
}

/** Count one element; reasons say what was approximated, or why it was left out. */
export function count(report: ImportReport, kind: ReportKind, outcome: keyof KindCount, reasons?: string | readonly string[]): void {
  report.counts[kind][outcome]++

  for (const reason of typeof reasons === 'string' ? [reasons] : (reasons ?? [])) {
    note(report, reason)
  }
}

/** Note why something was shown differently (`times` adds to what is known), for an element counted already or for no one element (a slide's transition). */
export function note(report: ImportReport, reason: string, times = 1): void {
  report.reasons[reason] = (report.reasons[reason] ?? 0) + times
}

/** Note something of the deck as a whole that is not kept (`times` adds to what is known). */
export function drop(report: ImportReport, what: string, times = 1): void {
  report.dropped[what] = (report.dropped[what] ?? 0) + times
}

const NOUNS: Record<ReportKind, [string, string]> = {
  text: ['text box', 'text boxes'],
  shape: ['shape', 'shapes'],
  picture: ['picture', 'pictures'],
  line: ['line', 'lines'],
  group: ['group', 'groups'],
  table: ['table', 'tables'],
  chart: ['chart', 'charts'],
  smartart: ['SmartArt graphic', 'SmartArt graphics'],
  video: ['video', 'videos'],
  audio: ['sound', 'sounds'],
  ole: ['embedded object', 'embedded objects'],
  ink: ['ink drawing', 'ink drawings'],
  other: ['other object', 'other objects']
}

const counted = (n: number, kind: ReportKind): string => `${n} ${NOUNS[kind][n === 1 ? 0 : 1]}`

const list = (items: string[]): string => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)

export const totals = (report: ImportReport): KindCount =>
  Object.values(report.counts).reduce((sum, entry) => ({ imported: sum.imported + entry.imported, approximated: sum.approximated + entry.approximated, skipped: sum.skipped + entry.skipped }), { imported: 0, approximated: 0, skipped: 0 })

/** The report as the lines the fidelity dialog shows; none when everything was kept. */
export function reportNotes(report: ImportReport): string[] {
  const notes: string[] = []
  const all = totals(report)
  const approximated = REPORT_KINDS.filter((kind) => report.counts[kind].approximated).map((kind) => counted(report.counts[kind].approximated, kind))
  const skipped = REPORT_KINDS.filter((kind) => report.counts[kind].skipped).map((kind) => counted(report.counts[kind].skipped, kind))

  if (approximated.length) {
    notes.push(`Shown approximately: ${list(approximated)}.`)
  }

  if (skipped.length) {
    notes.push(`Left out: ${list(skipped)}.`)
  }

  for (const [reason, times] of Object.entries(report.reasons).sort((a, b) => b[1] - a[1])) {
    notes.push(`${reason[0].toUpperCase()}${reason.slice(1)}${times > 1 ? ` (${times})` : ''}.`)
  }

  // A count goes after the thing's name, before any explanation in brackets.
  const dropped = Object.entries(report.dropped).map(([what, times]) => {
    const [name, ...explanation] = what.split(' (')

    return times > 1 ? `${name}: ${times}${explanation.length ? ` (${explanation.join(' (')}` : ''}` : what
  })

  if (dropped.length) {
    notes.push(`Not kept: ${list(dropped)}.`)
  }

  if (notes.length && all.imported) {
    notes.unshift(`Kept ${all.imported} of ${all.imported + all.approximated + all.skipped} elements as they were.`)
  }

  return notes
}
