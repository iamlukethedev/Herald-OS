import type { TextKey } from '../../shared/i18n.ts'
import { t } from '../store/i18n.ts'

// Messages the gateway client raises in English, word for word.
// A Map, so inherited object keys such as 'toString' or '__proto__' never match.
const KNOWN_ERRORS: ReadonlyMap<string, TextKey> = new Map<string, TextKey>([
  ['gateway not connected', 'settings.agents.gatewayNotConnected']
])

/** `value` as text, or null when it has none: String() throws for an object without a prototype or a working toString. */
function textOf(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }

  try {
    return String(value)
  } catch {
    return null
  }
}

/**
 * What went wrong, in the person's language when it is a message Herald knows; any other as it
 * came. One with no text (blank, null, undefined, a plain object) says something went wrong, so a
 * note or a "…: {error}" message is never left empty.
 */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : error
  const text = typeof message === 'string' ? message : textOf(message)
  const key = text?.trim().toLowerCase()

  if (!key || key === '[object object]') {
    return t('settings.somethingWentWrong')
  }

  const known = KNOWN_ERRORS.get(key)

  return known ? t(known) : (text as string)
}
