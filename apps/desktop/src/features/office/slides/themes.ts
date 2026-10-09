import { type Background, type Color, type Deck, type FontRef, type GradientStop, type Slide, type Slot, SLOTS, type Theme } from './deck.ts'

/*
 * Herald Slides' themes: ten colour slots (backgrounds, text and six accents, as PowerPoint's theme
 * has them) and a heading and a body font. Elements name slots and theme fonts, so applying a theme
 * repaints a deck without touching what was picked by hand. Each built-in theme's text reads at
 * 4.5:1 or better on both its backgrounds and its accents at 3:1 or better on the first; its fonts
 * are a Mac's, and `fontStack` finds their look-alikes elsewhere.
 */

const theme = (id: string, name: string, fonts: [string, string], colors: string[], background?: Background): Theme => ({
  id,
  name,
  fonts: { heading: fonts[0], body: fonts[1] },
  colors: Object.fromEntries(SLOTS.map((slot, index) => [slot, colors[index]])) as Record<Slot, string>,
  ...(background ? { background } : {})
})

/** A gradient between theme slots, so it repaints with the theme's colours. */
const shade = (from: Slot, to: Slot, angle: number, radial = false): Background => {
  const stops: GradientStop[] = [
    { at: 0, color: from },
    { at: 1, color: to }
  ]

  return { kind: 'gradient', stops, angle, ...(radial ? { radial } : {}) }
}

/** In slot order: bg1, tx1, bg2, tx2, accent1 to accent6. */
export const THEMES: readonly Theme[] = [
  theme('herald', 'Herald', ['Avenir Next', 'Avenir Next'], ['#ffffff', '#13204a', '#eef3ff', '#3a4a7a', '#2563eb', '#0d8a7f', '#b86e00', '#d6405b', '#6d5ce8', '#1a7fb0']),
  theme('midnight', 'Midnight', ['Helvetica Neue', 'Helvetica Neue'], ['#0a1435', '#f3f7ff', '#142357', '#b4c4ee', '#5c9dff', '#36e6a6', '#f2c25e', '#ff7a7a', '#a99cff', '#3ad4ff']),
  theme('paper', 'Paper', ['Georgia', 'Georgia'], ['#fbf7ef', '#2b2520', '#f2eadb', '#5f5044', '#a84b24', '#3e6b59', '#8f6514', '#6b4e8a', '#2f6690', '#8c3b3b']),
  theme('graphite', 'Graphite', ['Futura', 'Avenir Next'], ['#1e1f23', '#edeef0', '#2b2d33', '#b0b5be', '#f2c85c', '#4cc2ff', '#ff8a6b', '#7bd88f', '#c38fff', '#ff6f98']),
  theme('forest', 'Forest', ['Gill Sans', 'Gill Sans'], ['#f5f7f2', '#1e2b22', '#e2eadb', '#3f5845', '#2e7d4f', '#66751a', '#a8620f', '#3f739c', '#8c5e3c', '#b5463e']),
  theme('coral', 'Coral', ['Futura', 'Avenir Next'], ['#fff8f4', '#3a1e1c', '#ffe6da', '#7a3e36', '#de4a2b', '#b36b00', '#d63a6f', '#5b4cff', '#13867c', '#8d5a97']),
  theme('mono', 'Mono', ['Helvetica Neue', 'Helvetica Neue'], ['#ffffff', '#111111', '#f1f1f1', '#555555', '#111111', '#d62839', '#5c5c5c', '#8a8a8a', '#333333', '#9b1c27']),
  theme('ocean', 'Ocean', ['Trebuchet MS', 'Trebuchet MS'], ['#f2fafc', '#0d2b3a', '#d8eef4', '#2a5466', '#0b7d97', '#0f8a7e', '#b4651a', '#2f5fd0', '#5a7d24', '#c94a5e']),
  theme('aurora', 'Aurora', ['Avenir Next', 'Helvetica Neue'], ['#0b1020', '#eef2ff', '#1a2245', '#aab5d8', '#7c9cff', '#2fd4b4', '#c38bff', '#ff8fa3', '#ffd166', '#4cc9f0'], shade('bg2', 'bg1', 90, true)),
  theme('dune', 'Dune', ['Palatino', 'Optima'], ['#fbf6ee', '#3b2a1a', '#f0e2cc', '#6e4d2e', '#b4541c', '#7d6414', '#2f6f73', '#9b3b4d', '#556b2f', '#4a5a8c'], shade('bg1', 'bg2', 90)),
  theme('slate', 'Slate', ['Charter', 'Helvetica Neue'], ['#f7f9fb', '#1c2733', '#e3e8ee', '#46546a', '#2b6cb0', '#2f855a', '#c05621', '#6b46c1', '#b83280', '#2c7a7b']),
  theme('blossom', 'Blossom', ['Baskerville', 'Avenir Next'], ['#fff7f9', '#3d1f2b', '#fbe3ea', '#7f3a59', '#d6336c', '#7048e8', '#c2550c', '#0c7f92', '#4f7f0b', '#a33bbd'], shade('bg1', 'bg2', 45)),
  theme('ember', 'Ember', ['Futura', 'Gill Sans'], ['#1c1412', '#fbefe6', '#2e201c', '#dcbcaa', '#ff7a45', '#ffc145', '#ff6b80', '#4dd4ac', '#7aa2ff', '#c792ea'], shade('bg2', 'bg1', 90))
]

export const DEFAULT_THEME = THEMES[0]

export const themeById = (id: string): Theme | undefined => THEMES.find((entry) => entry.id === id)

let customThemes: readonly Theme[] = []

/** The custom themes `findTheme` knows besides the built-in ones, as the theme store has them. */
export function setCustomThemes(themes: readonly Theme[]): void {
  customThemes = themes
}

/** A built-in theme by id, or a custom one. */
export const findTheme = (id: string): Theme | undefined => themeById(id) ?? customThemes.find((entry) => entry.id === id)

function sameData(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }

  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    return false
  }

  const keys = Object.keys(a).filter((key) => (a as Record<string, unknown>)[key] !== undefined)

  return keys.length === Object.keys(b).filter((key) => (b as Record<string, unknown>)[key] !== undefined).length && keys.every((key) => sameData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/** Whether two backgrounds are the same (two nulls are). */
export const sameBackground = (a: Background | null | undefined, b: Background | null | undefined): boolean => sameData(a ?? null, b ?? null)

/** Whether two themes are the same theme with the same colours, fonts and background. */
export const sameTheme = (a: Theme, b: Theme): boolean => a === b || (a.id === b.id && sameData(a, b))

export interface ThemePatch {
  name?: string
  colors?: Partial<Record<Slot, string>>
  fonts?: Partial<{ heading: string; body: string }>
  /** Null takes the theme's background away (slides then show its background colour). */
  background?: Background | null
}

const family = (value: string | undefined, fallback: string): string => (value?.startsWith('+') ? '' : (value ?? '').replace(/["\\;{}<>]/g, '').trim().slice(0, 80)) || fallback

/** A theme with some of its name, colours (`#rgb` or `#rrggbb`), fonts and background changed, as the theme editor makes it; it keeps its id. */
export function editTheme(of: Theme, patch: ThemePatch): Theme {
  const colors = { ...of.colors }

  for (const [slot, value] of Object.entries(patch.colors ?? {})) {
    const hex = normalHex(value)

    if (!isSlot(slot)) {
      throw new Error(`A theme has no colour called ${slot}`)
    }

    if (!hex) {
      throw new Error(`${String(value)} is not a colour; give it as #rrggbb`)
    }

    colors[slot] = hex
  }

  const next: Theme = { ...of, name: patch.name?.trim().slice(0, 120) || of.name, colors, fonts: { heading: family(patch.fonts?.heading, of.fonts.heading), body: family(patch.fonts?.body, of.fonts.body) } }

  if (patch.background === null) {
    delete next.background
  } else if (patch.background) {
    if (patch.background.kind === 'image') {
      throw new Error('A theme’s background is a colour or a gradient')
    }

    next.background = patch.background
  }

  return next
}

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

const SERIF = /georgia|times|garamond|baskerville|palatino|didot|bodoni|caslon|cambria|serif|book antiqua|charter|hoefler|minion|constantia|gelasio|pagella/i
const MONO = /mono|courier|menlo|consolas|monaco|code/i

/** Families drawn alike, a Mac's first and then what Linux and Windows have in their place (metric-compatible cuts where there are any). */
const LOOKALIKES: readonly [RegExp, readonly string[]][] = [
  [/^(helvetica( neue)?|arial)$/i, ['Helvetica Neue', 'Helvetica', 'Arial', 'Liberation Sans', 'Nimbus Sans', 'Noto Sans']],
  [/^(avenir( next)?|futura|century gothic)$/i, ['Avenir Next', 'Avenir', 'Century Gothic', 'URW Gothic', 'TeX Gyre Adventor', 'Noto Sans']],
  [/^(gill sans( mt)?|optima|seravek|trebuchet ms|candara|calibri)$/i, ['Gill Sans', 'Gill Sans MT', 'Trebuchet MS', 'Cantarell', 'Ubuntu', 'Noto Sans']],
  [/^(verdana|tahoma)$/i, ['Verdana', 'Tahoma', 'DejaVu Sans', 'Noto Sans']],
  [/^(palatino( linotype)?|book antiqua)$/i, ['Palatino', 'Palatino Linotype', 'Book Antiqua', 'TeX Gyre Pagella', 'P052', 'URW Palladio L', 'Noto Serif']],
  [/^(times( new roman)?)$/i, ['Times New Roman', 'Times', 'Liberation Serif', 'Tinos', 'Nimbus Roman', 'Noto Serif']],
  [/^georgia$/i, ['Georgia', 'Gelasio', 'Noto Serif', 'DejaVu Serif']],
  [/^(bitstream )?charter$/i, ['Charter', 'Bitstream Charter', 'Charis SIL', 'Georgia', 'Noto Serif']],
  [/^baskerville$/i, ['Baskerville', 'Libre Baskerville', 'Baskerville Old Face', 'Georgia', 'Noto Serif']]
]

const GENERIC_ALIKE: Record<'serif' | 'sans-serif' | 'monospace', readonly string[]> = {
  serif: ['Georgia', 'Noto Serif', 'DejaVu Serif'],
  'sans-serif': ['Helvetica Neue', 'Noto Sans', 'Arial'],
  monospace: ['SF Mono', 'Menlo', 'JetBrains Mono', 'DejaVu Sans Mono', 'Noto Sans Mono']
}

/** A CSS font stack for a family: it first, then what looks like it on machines without it. */
export function fontStack(family: string): string {
  const clean = family.replace(/["\\;{}<>]/g, '').trim() || 'Helvetica Neue'
  const generic = MONO.test(clean) ? 'monospace' : SERIF.test(clean) ? 'serif' : 'sans-serif'
  const alike = LOOKALIKES.find(([pattern]) => pattern.test(clean))?.[1] ?? GENERIC_ALIKE[generic]
  const names = [clean, ...alike.filter((name) => name.toLowerCase() !== clean.toLowerCase())]

  return `${names.map((name) => `"${name}"`).join(', ')}, ${generic}`
}

/** Families offered in the font menu besides the theme's, all on a Mac and most elsewhere. */
export const COMMON_FONTS = ['Arial', 'Avenir Next', 'Baskerville', 'Charter', 'Futura', 'Georgia', 'Gill Sans', 'Helvetica Neue', 'Menlo', 'Optima', 'Palatino', 'Times New Roman', 'Trebuchet MS', 'Verdana']

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
