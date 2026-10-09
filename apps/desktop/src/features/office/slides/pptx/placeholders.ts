import type { FooterRole, LayoutId, PlaceholderRole, Slide, SlideElement } from '../deck.ts'
import { isFooterRole, layoutPlaceholders } from '../layouts.ts'

/*
 * How placeholders meet in a PowerPoint file. Each placeholder of the master and of its layouts gets
 * PresentationML's type for its role and an index, as PowerPoint numbers them: a title has none, the
 * master's text is 1 and its date, footer and slide number 2, 3 and 4, a layout's other placeholders
 * count from 1 and its date, footer and slide number are 10, 11 and 12. A slide's placeholder
 * elements fill their layout's by role, in order, and name them by type and index.
 */

/** The names Herald's layouts gave their text placeholders in files written before the master was Herald's to write, in order. */
export function placeholderNames(layout: LayoutId): { name: string; role: PlaceholderRole }[] {
  const seen: Partial<Record<PlaceholderRole, number>> = {}

  return layoutPlaceholders(layout)
    .filter((spec) => spec.role !== 'picture')
    .map((spec) => {
      const n = (seen[spec.role] = (seen[spec.role] ?? 0) + 1)

      return { name: n > 1 ? `${spec.role}${n}` : spec.role, role: spec.role }
    })
}

/** The index those files gave a layout's placeholder (PptxGenJS numbered them from 100). */
export const placeholderIndex = (layout: LayoutId, name: string): number => 100 + placeholderNames(layout).findIndex((entry) => entry.name === name)

/** A placeholder in the file: the role it answers for, PresentationML's type for it (`obj` is written as no type) and its index. */
export interface PlaceholderSlot {
  role: PlaceholderRole
  type: string
  idx?: number
}

const FOOTER_TYPES: Record<FooterRole, string> = { date: 'dt', footer: 'ftr', number: 'sldNum' }

const LAYOUT_FOOTERS: Record<FooterRole, number> = { date: 10, footer: 11, number: 12 }

const MASTER_FOOTERS: Record<FooterRole, number> = { date: 2, footer: 3, number: 4 }

/** Layouts whose text placeholders stand for another role in other apps (a section's subtitle, a comparison's headings, a picture's caption). */
const TEXT_ROLES: Partial<Record<LayoutId, PlaceholderRole>> = { section: 'subtitle', comparison: 'heading', 'picture-caption': 'caption' }

/** PresentationML's placeholder type for a role on a layout, as PowerPoint's own layouts have them. */
export function placeholderType(layout: LayoutId, role: PlaceholderRole): string {
  if (isFooterRole(role)) {
    return FOOTER_TYPES[role]
  }

  switch (role) {
    case 'title':
      return layout === 'title' ? 'ctrTitle' : 'title'
    case 'subtitle':
      return layout === 'section' ? 'body' : 'subTitle'
    case 'picture':
      return 'pic'
    case 'body':
      return TEXT_ROLES[layout] ? 'obj' : 'body'
    default:
      return 'body'
  }
}

/** Indexes from 1, past the ones PowerPoint keeps for the date, footer and slide number. */
const contentIndex = (n: number): number => (n < 10 ? n : n + 3)

/** The placeholders among a layout part's elements, in their order, each with its type and index. */
export function layoutSlots(layout: LayoutId, elements: readonly SlideElement[]): Map<string, PlaceholderSlot> {
  const slots = new Map<string, PlaceholderSlot>()
  const footers = new Set<FooterRole>()
  let titled = false
  let next = 1

  for (const element of elements) {
    const role = element.placeholder?.role

    if (!role) {
      continue
    }

    const type = placeholderType(layout, role)

    if (isFooterRole(role) && !footers.has(role)) {
      footers.add(role)
      slots.set(element.id, { role, type, idx: LAYOUT_FOOTERS[role] })
    } else if (role === 'title' && !titled) {
      titled = true
      slots.set(element.id, { role, type })
    } else {
      slots.set(element.id, { role, type, idx: contentIndex(next++) })
    }
  }

  return slots
}

/** The master's placeholders: its title, its text and its date, footer and slide number; any others are more text. */
export function masterSlots(elements: readonly SlideElement[]): Map<string, PlaceholderSlot> {
  const slots = new Map<string, PlaceholderSlot>()
  const footers = new Set<FooterRole>()
  let titled = false
  let next = 0

  for (const element of elements) {
    const role = element.placeholder?.role

    if (!role) {
      continue
    }

    if (isFooterRole(role) && !footers.has(role)) {
      footers.add(role)
      slots.set(element.id, { role, type: FOOTER_TYPES[role], idx: MASTER_FOOTERS[role] })
    } else if (role === 'title' && !titled) {
      titled = true
      slots.set(element.id, { role, type: 'title' })
    } else {
      slots.set(element.id, { role, type: 'body', idx: next ? 12 + next : 1 })
      next++
    }
  }

  return slots
}

/** Which of a slide's elements fill which of its layout's placeholders (the date, footer and slide number are the deck's to show). */
export function slideSlots(slide: Slide, layout: ReadonlyMap<string, PlaceholderSlot>): Map<string, PlaceholderSlot> {
  const free = [...layout.values()].filter((slot) => !isFooterRole(slot.role))
  const slots = new Map<string, PlaceholderSlot>()

  for (const element of slide.elements) {
    const role = element.placeholder?.role
    const fits = element.kind === 'image' ? role === 'picture' : (element.kind === 'text' || element.kind === 'shape') && role !== 'picture'
    const at = role && fits ? free.findIndex((slot) => slot.role === role) : -1

    if (at >= 0) {
      slots.set(element.id, free[at])
      free.splice(at, 1)
    }
  }

  return slots
}
