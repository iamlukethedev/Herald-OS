import { fromHsl, isHexColor, toHsl } from '../../../../../shared/theme.ts'
import { hexOf } from './cells.ts'
import type { ChartTheme } from './option.ts'

/* Herald's theme as charts draw in it, read from the page's CSS variables as Univer's palette is (../../univer/theme.ts). */

const token = (style: CSSStyleDeclaration, name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback

/** The colours and font charts take from Herald's current theme; on a dark theme a chart sits a little above the navy of the cells. */
export function heraldChartTheme(): ChartTheme {
  const style = getComputedStyle(document.documentElement)
  const dark = !(style.colorScheme || token(style, 'color-scheme', 'dark')).includes('light')
  const background = token(style, '--color-bg', '#050f33')

  return {
    background: dark ? fromHsl({ h: toHsl(isHexColor(background) ? background : '#050f33').h, s: 0.5, l: 0.14 }) : '#ffffff',
    text: token(style, '--color-fg', dark ? '#f3f7ff' : '#1d2433'),
    label: token(style, '--color-fg-2', dark ? 'rgba(216, 228, 255, 0.84)' : '#3d4659'),
    muted: token(style, '--color-fg-3', dark ? 'rgba(176, 196, 245, 0.68)' : '#5f6b80'),
    grid: token(style, '--color-line', dark ? 'rgba(140, 180, 255, 0.26)' : 'rgba(0, 0, 0, 0.12)'),
    font: getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif'
  }
}

/** Herald's own colours for a chart's series: the theme's accent, then its signal colours. */
export function heraldPalette(): string[] {
  const style = getComputedStyle(document.documentElement)

  return ['--color-accent', '--color-progress', '--color-ok', '--color-warn', '--color-danger', '--color-info'].map((name) => token(style, name, '')).filter(isHexColor).map(hexOf)
}
