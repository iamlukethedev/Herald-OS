import type { Node as PMNode } from '@tiptap/pm/model'
import { DEFAULT_HEADER_DISTANCE, pageOf, type PageSettings, type SectionKind } from '../../../../../shared/office/document.ts'

/*
 * A page's frame in CSS pixels (96 an inch) from its settings in points: its size, its margins, and
 * how far its header and footer sit from its edges. The page view and the print view both lay
 * pages out in these.
 */

export const PX = 96 / 72

export interface Frame {
  width: number
  height: number
  top: number
  right: number
  bottom: number
  left: number
  /** From the top edge to the header, and from the bottom edge to the footer. */
  header: number
  footer: number
}

export function frameOf(page: PageSettings): Frame {
  const { margins } = page

  return {
    width: page.width * PX,
    height: page.height * PX,
    top: margins.top * PX,
    right: margins.right * PX,
    bottom: margins.bottom * PX,
    left: margins.left * PX,
    header: (margins.header ?? DEFAULT_HEADER_DISTANCE) * PX,
    footer: (margins.footer ?? DEFAULT_HEADER_DISTANCE) * PX
  }
}

/** The width a page gives text. */
export const textWidthOf = (frame: Frame): number => Math.max(24, frame.width - frame.left - frame.right)

export interface Section {
  page: PageSettings
  frame: Frame
  /** The index of the top-level block it starts at. */
  start: number
  /** How it starts: a continuous section on a page of another size starts a new page, as in Word. */
  kind: SectionKind
}

const SECTION_KINDS: readonly SectionKind[] = ['nextPage', 'continuous', 'evenPage', 'oddPage']

/** Each section of a document: the first has the document's page, the others start after section breaks. */
export function sectionsOfDoc(doc: PMNode): Section[] {
  const first = pageOf({ type: 'doc', attrs: doc.attrs })
  const out: Section[] = [{ page: first, frame: frameOf(first), start: 0, kind: 'nextPage' }]

  doc.forEach((node, _offset, index) => {
    if (node.type.name !== 'sectionBreak') {
      return
    }

    const before = out[out.length - 1]
    const page = (node.attrs.page as PageSettings | null) ?? before.page
    const kind = SECTION_KINDS.includes(node.attrs.kind) ? (node.attrs.kind as SectionKind) : 'nextPage'
    const resized = Math.abs(page.width - before.page.width) > 0.5 || Math.abs(page.height - before.page.height) > 0.5
    out.push({ page, frame: frameOf(page), start: index + 1, kind: kind === 'continuous' && resized ? 'nextPage' : kind })
  })

  return out
}

/** The section the top-level block at `index` is in. */
export function sectionAt(sections: readonly Section[], index: number): number {
  let at = 0

  while (at + 1 < sections.length && sections[at + 1].start <= index) {
    at++
  }

  return at
}

/** Where a page's text goes: below its header and above its footer, a tall one pushing the text in, as in Word. */
export function bodyOf(frame: Frame, header: number, footer: number): { top: number; bottom: number } {
  return { top: Math.max(frame.top, frame.header + header), bottom: Math.max(frame.bottom, frame.footer + footer) }
}
