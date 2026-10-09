import type { DateFormat, Deck, FooterRole, HeaderFooter, Slide } from './deck.ts'
import { footerPlace, masterOf } from './layouts.ts'

/*
 * The date, footer and slide number a slide shows: where the master (or the slide's layout) puts
 * them and how they look, with what the deck's header and footer settings say goes in them.
 */

export const NO_FOOTERS: HeaderFooter = { date: false, dateFormat: 'datetime1', number: false, footer: false, footerText: '', skipTitle: false }

export const headerFooterOf = (deck: Pick<Deck, 'headerFooter'>): HeaderFooter => deck.headerFooter ?? NO_FOOTERS

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** A date as PowerPoint's date field of that format shows it in English. */
export function formatDate(format: DateFormat, date: Date): string {
  const day = date.getDate()
  const month = MONTHS[date.getMonth()]
  const year = date.getFullYear()

  switch (format) {
    case 'datetime2':
      return `${DAYS[date.getDay()]}, ${month} ${day}, ${year}`
    case 'datetime3':
      return `${day} ${month} ${year}`
    case 'datetime4':
      return `${month} ${day}, ${year}`
    default:
      return `${date.getMonth() + 1}/${day}/${year}`
  }
}

/** Whether a slide shows a footer role: the settings ask for it, and the slide is not a title slide left without them. */
export function showsFooter(deck: Pick<Deck, 'headerFooter'>, slide: Pick<Slide, 'layout'>, role: FooterRole): boolean {
  const settings = headerFooterOf(deck)

  if (settings.skipTitle && slide.layout === 'title') {
    return false
  }

  return role === 'date' ? settings.date : role === 'number' ? settings.number : settings.footer && Boolean(settings.footerText)
}

/** What goes in a footer role on the slide at `index` (0-based, hidden slides counted, as PowerPoint numbers them). */
export function footerText(deck: Pick<Deck, 'headerFooter'>, role: FooterRole, index: number, now = new Date()): string {
  const settings = headerFooterOf(deck)

  if (role === 'number') {
    return String(index + 1)
  }

  if (role === 'footer') {
    return settings.footerText
  }

  return settings.dateText || formatDate(settings.dateFormat, now)
}

/** The footer roles a slide shows, each with the element that places and styles it and its text. */
export function footersOf(deck: Pick<Deck, 'headerFooter' | 'master' | 'size'>, slide: Pick<Slide, 'layout'>, index: number, now = new Date()) {
  const master = masterOf(deck)

  return (['date', 'footer', 'number'] as const).flatMap((role) => {
    const place = showsFooter(deck, slide, role) ? footerPlace(master, slide.layout, role) : undefined

    return place && (place.kind === 'text' || place.kind === 'shape') ? [{ role, place, text: footerText(deck, role, index, now) }] : []
  })
}
