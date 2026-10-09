/** A name's initials, as Word gives them: the first letters of its first and last words. */
export function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word))
  const ends = words.length > 1 ? [words[0], words[words.length - 1]] : words

  return ends.map((word) => /[\p{L}\p{N}]/u.exec(word)?.[0] ?? '').join('').toUpperCase()
}
