import { atom } from 'nanostores'

/*
 * Who writes comments: the name the person gives the first time they comment, kept on this
 * computer for all their documents, and the initials their comments show.
 */

const STORAGE_KEY = 'herald.docs.author'

function stored(): string {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

/** The person's name on their comments; empty until they give one. */
export const $author = atom<string>(stored())

export function setAuthor(name: string): void {
  const value = name.trim().replace(/\s+/g, ' ')
  $author.set(value)

  try {
    if (value) {
      globalThis.localStorage?.setItem(STORAGE_KEY, value)
    } else {
      globalThis.localStorage?.removeItem(STORAGE_KEY)
    }
  } catch {
    // Storage may be unavailable; the name still holds for this session.
  }
}

/** A name's initials, as Word gives them: the first letters of its first and last words. */
export function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word))
  const ends = words.length > 1 ? [words[0], words[words.length - 1]] : words

  return ends.map((word) => /[\p{L}\p{N}]/u.exec(word)?.[0] ?? '').join('').toUpperCase()
}
