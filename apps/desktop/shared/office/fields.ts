import type { FieldAttrs, FieldKind } from './document.ts'

/*
 * What a field shows: the page it is on, the document's page count, or the date or time in a
 * picture of Word's (`d MMMM yyyy`, `dddd`, `HH:mm`, `h:mm am/pm`, text in single quotes). The page
 * view and the print view both show fields through this, so a page number reads the same in both.
 */

export interface FieldContext {
  /** The page the field is on, from 1; unknown outside a laid-out page. */
  page?: number
  pages?: number
  now?: Date
  locale?: string
}

const FIELD_KINDS: readonly FieldKind[] = ['page', 'pages', 'date', 'time', 'other']

/** A field's attrs from anything, with what is missing or unknown made safe. */
export function fieldAttrs(value: Partial<Record<keyof FieldAttrs, unknown>> | null | undefined): FieldAttrs {
  const text = (key: keyof FieldAttrs): string | null => (typeof value?.[key] === 'string' ? (value[key] as string) : null)
  const kind = FIELD_KINDS.includes(value?.kind as FieldKind) ? (value!.kind as FieldKind) : 'other'

  return { kind, format: text('format'), instruction: text('instruction'), text: text('text') }
}

const TOKEN = /'[^']*'|dddd|ddd|dd|d|MMMM|MMM|MM|M|yyyy|yy|HH|H|hh|h|mm|m|ss|s|am\/pm|AM\/PM/g

const pad = (value: number): string => String(value).padStart(2, '0')

/** A date in a Word date and time picture. */
export function formatDate(date: Date, picture: string, locale = 'en-GB'): string {
  const name = (options: Intl.DateTimeFormatOptions): string => new Intl.DateTimeFormat(locale, options).format(date)
  const hours12 = date.getHours() % 12 || 12

  return picture.replace(TOKEN, (token) => {
    switch (token) {
      case 'dddd':
        return name({ weekday: 'long' })
      case 'ddd':
        return name({ weekday: 'short' })
      case 'dd':
        return pad(date.getDate())
      case 'd':
        return String(date.getDate())
      case 'MMMM':
        return name({ month: 'long' })
      case 'MMM':
        return name({ month: 'short' })
      case 'MM':
        return pad(date.getMonth() + 1)
      case 'M':
        return String(date.getMonth() + 1)
      case 'yyyy':
        return String(date.getFullYear())
      case 'yy':
        return pad(date.getFullYear() % 100)
      case 'HH':
        return pad(date.getHours())
      case 'H':
        return String(date.getHours())
      case 'hh':
        return pad(hours12)
      case 'h':
        return String(hours12)
      case 'mm':
        return pad(date.getMinutes())
      case 'm':
        return String(date.getMinutes())
      case 'ss':
        return pad(date.getSeconds())
      case 's':
        return String(date.getSeconds())
      case 'am/pm':
        return date.getHours() < 12 ? 'am' : 'pm'
      case 'AM/PM':
        return date.getHours() < 12 ? 'AM' : 'PM'
      default:
        return token.slice(1, -1)
    }
  })
}

/** What a field shows in `context`; a page field off a page shows its last result, or `#`. */
export function fieldText(value: Partial<Record<keyof FieldAttrs, unknown>> | null | undefined, context: FieldContext = {}): string {
  const attrs = fieldAttrs(value)
  const locale = context.locale ?? 'en-GB'
  const now = context.now ?? new Date()

  switch (attrs.kind) {
    case 'page':
      return context.page ? String(context.page) : (attrs.text ?? '#')
    case 'pages':
      return context.pages ? String(context.pages) : (attrs.text ?? '#')
    case 'date':
      return attrs.format ? formatDate(now, attrs.format, locale) : now.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' })
    case 'time':
      return attrs.format ? formatDate(now, attrs.format, locale) : now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    default:
      return attrs.text ?? ''
  }
}
