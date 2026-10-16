import type { DocumentResult } from '../engine/types.ts'

/*
 * A note as a document for Copy to Docs: the note's name as its title, each part of the note under
 * a heading as a two-column table of what was worked out and its answer, short comments as quiet
 * lines where they stand, and the note's total in bold last.
 */

export interface DocsTable {
  markdown: string
  /** The note's lines the document shows: calculations, headings and the comments kept. */
  lines: number
}

/** A comment longer than this is the note's own prose, which stays out of the document. */
export const SHORT_COMMENT = 140

const HEADER = ['| Calculation | Result |', '| --- | ---: |']

interface Section {
  heading: string | null
  /** In the note's order: comments as text, calculations as their two cells. */
  parts: Array<string | [calculation: string, result: string]>
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Text that reads as itself in Markdown, a table cell's pipes included. */
const plain = (text: string): string => squash(text).replace(/[\\`*_[\]<>~|#&]/g, '\\$&')

const row = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`

const totalRow = (total: string): string => row(['**Total**', `**${plain(total)}**`])

/** The first line's whole text when the title is that line, or that line cut short; null otherwise. */
function titleFor(line: string, title: string): string | null {
  const a = line.toLowerCase()
  const b = title.toLowerCase()

  return a === b || (b.endsWith('…') && a.startsWith(b.slice(0, -1))) ? line : null
}

/** The note as Markdown for Herald Docs, and how many of its lines it shows. */
export function docsTable(document: DocumentResult, title: string): DocsTable {
  let name = squash(title) || 'Calculations'
  const sections: Section[] = [{ heading: null, parts: [] }]
  let lines = 0
  let first = true

  for (const line of document.lines) {
    if (line.kind === 'blank') {
      continue
    }

    const section = sections[sections.length - 1]
    const opening = first
    first = false

    if (line.kind === 'heading' || line.kind === 'comment') {
      const text = squash(line.label ?? line.source.replace(line.kind === 'heading' ? /^\s*#+/ : /^\s*\/\//, ''))
      const named = opening && text ? titleFor(text, name) : null

      if (named) {
        name = named.length <= SHORT_COMMENT ? named : name
      } else if (text && line.kind === 'heading') {
        sections.push({ heading: text, parts: [] })
        lines++
      } else if (text && text.length <= SHORT_COMMENT) {
        section.parts.push(text)
        lines++
      }
    } else if (line.kind === 'value' || line.kind === 'error') {
      const calculation = squash(line.source)

      if (calculation) {
        section.parts.push([calculation, line.kind === 'value' ? squash(line.display ?? line.value?.exact ?? '') || '—' : '—'])
        lines++
      }
    }
  }

  // A comment between calculations splits their table, so everything reads in the note's order.
  const blocks = [`# ${plain(name)}`]
  const tables: string[][][] = []
  const placed: Array<string | string[][]> = []

  for (const section of sections) {
    if (section.heading) {
      placed.push(`## ${plain(section.heading)}`)
    }

    let rows: string[][] | null = null

    for (const part of section.parts) {
      if (typeof part === 'string') {
        rows = null
        placed.push(`_${plain(part)}_`)
      } else {
        if (!rows) {
          rows = []
          tables.push(rows)
          placed.push(rows)
        }

        rows.push([plain(part[0]), plain(part[1])])
      }
    }
  }

  const total = squash(document.totalDisplay ?? '')

  for (const block of placed) {
    if (typeof block === 'string') {
      blocks.push(block)
    } else {
      blocks.push([...HEADER, ...block.map(row), ...(total && tables.length === 1 ? [totalRow(total)] : [])].join('\n'))
    }
  }

  // With several tables the total is the whole note's, so it stands alone rather than under the last.
  if (total && tables.length !== 1) {
    blocks.push([totalRow(total), HEADER[1]].join('\n'))
  }

  return { markdown: `${blocks.join('\n\n')}\n`, lines }
}

/** The note as a neat Markdown document: its name, a table for each heading's part, the total in bold. */
export function toDocsMarkdown(document: DocumentResult, title: string): string {
  return docsTable(document, title).markdown
}
