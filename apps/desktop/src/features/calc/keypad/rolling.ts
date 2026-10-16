/*
 * The rolling display's slots. A digit is keyed by how many digits come before it, so the digits a
 * new value shares at the front with the old one stay still and the others roll; every other
 * character is keyed by what it is and where, so it fades in wherever it lands.
 */

export const DECIMAL_DIGITS = '0123456789'
export const HEX_DIGITS = '0123456789ABCDEF'

export interface RollingSlot {
  key: string
  char: string
  /** The digit's place in the alphabet; null for any other character. */
  digit: number | null
}

export type SlotChange = 'still' | 'roll' | 'enter'

export function rollingSlots(text: string, alphabet: string = DECIMAL_DIGITS): RollingSlot[] {
  const slots: RollingSlot[] = []
  let digits = 0
  let others = 0

  for (const char of text) {
    const digit = alphabet.indexOf(char)

    if (digit >= 0) {
      slots.push({ key: `d${digits}`, char, digit })
      digits++
      others = 0
    } else {
      slots.push({ key: `o${digits}:${others}:${char}`, char, digit: null })
      others++
    }
  }

  return slots
}

/** Each slot of `next` against `previous`: unchanged, a digit rolling to another, or new. */
export function rollingDiff(previous: string | null, next: string, alphabet: string = DECIMAL_DIGITS): (RollingSlot & { change: SlotChange })[] {
  const before = new Map(previous === null ? [] : rollingSlots(previous, alphabet).map(slot => [slot.key, slot.char]))

  return rollingSlots(next, alphabet).map(slot => {
    const old = before.get(slot.key)
    const change: SlotChange = previous === null || old === slot.char ? 'still' : old === undefined ? 'enter' : 'roll'

    return { ...slot, change }
  })
}
