import type { DateFormat, FooterRole, HeaderFooter, LayoutId, Master } from '../deck.ts'
import { DATE_FORMATS, FOOTER_ROLES } from '../deck.ts'
import { showsFooter } from '../footers.ts'
import { footerPlace } from '../layouts.ts'

/*
 * The date, footer and slide number a deck shows, worked out from the placeholders its slides
 * carry for them: each shown where most slides (title slides aside) carry it, with the text most
 * of them hold, and left off title slides when they carry none.
 */

/** A date, footer or slide number placeholder a slide carries, with what it holds. */
export interface FooterFound {
  role: FooterRole
  /** A footer's text or a fixed date's; empty for a slide number or a date field. */
  text: string
  /** A date field's format. */
  field?: DateFormat
  /** Placed elsewhere than its layout places it. */
  moved?: boolean
}

export interface SlideFooters {
  layout: LayoutId
  found: FooterFound[]
}

/** What a placeholder of a role holds, from its text and the types of its fields; null when it shows nothing. */
export function footerFound(role: FooterRole, text: string, fields: readonly string[]): FooterFound | null {
  if (role === 'number') {
    return { role, text: '' }
  }

  const field = role === 'date' ? fields.find((type) => type.startsWith('datetime')) : undefined

  if (field) {
    return { role, text: '', field: DATE_FORMATS.includes(field as DateFormat) ? (field as DateFormat) : 'datetime1' }
  }

  return text.trim() ? { role, text: text.trim() } : null
}

const carries = (slide: SlideFooters, role: FooterRole): boolean => slide.found.some((entry) => entry.role === role)

/** The entry most slides hold of a role, the first of those tied. */
function mostHeld(slides: readonly SlideFooters[], role: FooterRole): FooterFound | undefined {
  const held = new Map<string, { entry: FooterFound; times: number }>()

  for (const entry of slides.flatMap((slide) => slide.found.filter((found) => found.role === role))) {
    const key = entry.field ?? ` ${entry.text}`
    const known = held.get(key) ?? { entry, times: 0 }
    known.times++
    held.set(key, known)
  }

  return [...held.values()].reduce<{ entry: FooterFound; times: number } | undefined>((best, next) => (!best || next.times > best.times ? next : best), undefined)?.entry
}

/** The deck's header and footer settings from what its slides carry; none when no role is shown. */
export function headerFooterFrom(slides: readonly SlideFooters[]): HeaderFooter | undefined {
  const others = slides.filter((slide) => slide.layout !== 'title')
  const judged = others.length ? others : slides
  const shown = FOOTER_ROLES.filter((role) => judged.filter((slide) => carries(slide, role)).length * 2 > judged.length)

  if (!shown.length) {
    return undefined
  }

  const date = mostHeld(slides, 'date')
  const titles = slides.filter((slide) => slide.layout === 'title')

  return {
    date: shown.includes('date'),
    dateFormat: date?.field ?? 'datetime1',
    ...(date && !date.field ? { dateText: date.text } : {}),
    number: shown.includes('number'),
    footer: shown.includes('footer'),
    footerText: mostHeld(slides, 'footer')?.text ?? '',
    skipTitle: titles.length > 0 && others.length > 0 && titles.every((slide) => !shown.some((role) => carries(slide, role)))
  }
}

/**
 * Whether each placeholder a slide carried shows as it was (where its layout places it) under the
 * deck's settings and `master`'s places for them, and how many roles the slide shows that it did
 * not carry.
 */
export function compareFooters(settings: HeaderFooter | undefined, slide: SlideFooters, master: Master): { same: boolean[]; added: number } {
  const deck = { headerFooter: settings }
  const shows = (role: FooterRole): boolean => {
    const place = footerPlace(master, slide.layout, role)

    return showsFooter(deck, slide, role) && (place?.kind === 'text' || place?.kind === 'shape')
  }
  const holds = (entry: FooterFound): boolean => {
    if (entry.role === 'footer') {
      return entry.text === settings?.footerText
    }

    if (entry.role === 'date') {
      return entry.field ? !settings?.dateText && entry.field === settings?.dateFormat : entry.text === settings?.dateText
    }

    return true
  }

  return {
    same: slide.found.map((entry) => !entry.moved && shows(entry.role) && holds(entry)),
    added: FOOTER_ROLES.filter((role) => shows(role) && !carries(slide, role)).length
  }
}
