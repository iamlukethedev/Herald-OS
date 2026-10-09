import { type Color, type Deck, type FontRef, type Slide, type Slot, SLOTS, type Theme } from './deck.ts'

/*
 * Herald Slides' themes: ten colour slots (backgrounds, text and six accents, as PowerPoint's theme
 * has them) and a heading and a body font. Elements name slots and theme fonts, so applying a theme
 * repaints a deck without touching what was picked by hand.
 */

const theme = (id: string, name: string, fonts: [string, string], colors: string[]): Theme => ({
  id,
  name,
  fonts: { heading: fonts[0], body: fonts[1] },
  colors: Object.fromEntries(SLOTS.map((slot, index) => [slot, colors[index]])) as Record<Slot, string>
})

/** In slot order: bg1, tx1, bg2, tx2, accent1 to accent6. */
export const THEMES: readonly Theme[] = [
  theme('herald', 'Herald', ['Avenir Next', 'Avenir Next'], ['#ffffff', '#13204a', '#eef3ff', '#3a4a7a', '#2f7dff', '#12b5a6', '#f2a93b', '#e5566f', '#7c6cff', '#3aa9d4']),
  theme('midnight', 'Midnight', ['Helvetica Neue', 'Helvetica Neue'], ['#0a1435', '#f3f7ff', '#142357', '#a9bceb', '#5296ff', '#36e6a6', '#f2c25e', '#ff6d6d', '#9b8cff', '#3ad4ff']),
  theme('paper', 'Paper', ['Georgia', 'Georgia'], ['#fbf7ef', '#2b2520', '#f2eadb', '#6b5b4d', '#b4532a', '#3e6b59', '#c9973a', '#6b4e8a', '#2f6690', '#8c3b3b']),
  theme('graphite', 'Graphite', ['Futura', 'Avenir Next'], ['#1e1f23', '#edeef0', '#2b2d33', '#a3a8b2', '#f2c85c', '#4cc2ff', '#ff7a59', '#7bd88f', '#c38fff', '#ff5c8a']),
  theme('forest', 'Forest', ['Gill Sans', 'Gill Sans'], ['#f5f7f2', '#1e2b22', '#e2eadb', '#46604c', '#2e7d4f', '#9daf34', '#d98e32', '#4f86b0', '#8c5e3c', '#c2524a']),
  theme('coral', 'Coral', ['Futura', 'Avenir Next'], ['#fff8f4', '#3a1e1c', '#ffe6da', '#84453c', '#ff6b4a', '#ffb547', '#e84a7f', '#5b4cff', '#2ec4b6', '#8d5a97']),
  theme('mono', 'Mono', ['Helvetica Neue', 'Helvetica Neue'], ['#ffffff', '#111111', '#f1f1f1', '#5a5a5a', '#111111', '#e63946', '#7a7a7a', '#b0b0b0', '#3d3d3d', '#d4d4d4']),
  theme('ocean', 'Ocean', ['Trebuchet MS', 'Trebuchet MS'], ['#f2fafc', '#0d2b3a', '#d8eef4', '#2f5d70', '#0e8ba8', '#1fc7b6', '#f2a65a', '#2f5fd0', '#7a9e3b', '#d9576a'])
]

export const DEFAULT_THEME = THEMES[0]

export const themeById = (id: string): Theme | undefined => THEMES.find((entry) => entry.id === id)

/** The theme a slide is drawn in: its own, or the deck's. */
export const themeOf = (deck: Pick<Deck, 'theme'>, slide: Pick<Slide, 'theme'> | undefined): Theme => slide?.theme ?? deck.theme

export const SLOT_NAMES: Record<Slot, string> = {
  bg1: 'Background',
  tx1: 'Text',
  bg2: 'Background 2',
  tx2: 'Text 2',
  accent1: 'Accent 1',
  accent2: 'Accent 2',
  accent3: 'Accent 3',
  accent4: 'Accent 4',
  accent5: 'Accent 5',
  accent6: 'Accent 6'
}

export const isSlot = (value: unknown): value is Slot => SLOTS.includes(value as Slot)

/** `#rgb` or `#rrggbb` (any case) as `#rrggbb`; null for anything else. */
export function normalHex(value: unknown): `#${string}` | null {
  const text = String(value ?? '').trim()
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text)

  if (short) {
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase() as `#${string}`
  }

  const long = /^#?([0-9a-f]{6})$/i.exec(text)

  return long ? (`#${long[1].toLowerCase()}` as `#${string}`) : null
}

/** A colour as a slot or a literal, or null when it is neither. */
export const colorOf = (value: unknown): Color | null => (isSlot(value) ? value : normalHex(value))

/** A colour as `#rrggbb` in a theme. */
export const resolveColor = (color: Color, of: Theme): string => (isSlot(color) ? of.colors[color] : color)

/** A colour in CSS, with its opacity. */
export function cssColor(color: Color, of: Theme, alpha = 1): string {
  const hex = resolveColor(color, of)

  if (alpha >= 1) {
    return hex
  }

  const value = Number.parseInt(hex.slice(1), 16)

  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${Math.max(0, alpha).toFixed(3)})`
}

/** The family a font reference stands for in a theme. */
export const resolveFont = (font: FontRef, of: Theme): string => (font === '+heading' ? of.fonts.heading : font === '+body' ? of.fonts.body : font)

const SERIF = /georgia|times|garamond|baskerville|palatino|didot|bodoni|caslon|cambria|serif|book antiqua|charter|hoefler|minion|constantia/i
const MONO = /mono|courier|menlo|consolas|monaco|code/i

/** A CSS font stack for a family: it first, then what looks like it on machines without it. */
export function fontStack(family: string): string {
  const clean = family.replace(/["\\;{}<>]/g, '').trim() || 'Helvetica Neue'
  const fallback = MONO.test(clean) ? '"SF Mono", Menlo, "JetBrains Mono", "Noto Sans Mono", monospace' : SERIF.test(clean) ? 'Georgia, "Noto Serif", "DejaVu Serif", serif' : '"Helvetica Neue", "Noto Sans", Arial, sans-serif'

  return `"${clean}", ${fallback}`
}

/** Families offered in the font menu besides the theme's, all on a Mac and most elsewhere. */
export const COMMON_FONTS = ['Arial', 'Avenir Next', 'Futura', 'Georgia', 'Gill Sans', 'Helvetica Neue', 'Menlo', 'Palatino', 'Times New Roman', 'Trebuchet MS', 'Verdana']

/** Relative luminance of `#rrggbb`, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16)
  const channel = (shift: number) => {
    const c = ((value >> shift) & 255) / 255

    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }

  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
}

/** Whether a theme's background is dark (its text then reads light). */
export const isDark = (of: Theme): boolean => luminance(of.colors.bg1) < 0.25
