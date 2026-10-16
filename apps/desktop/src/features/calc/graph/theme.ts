import { type RefObject, useEffect, useState } from 'react'

/* The Graph view's colours, read from the theme's tokens at runtime so the canvas follows a theme change. */

export interface GraphTheme {
  /** One colour a curve, in order: the accent, then the semantic colours. */
  curves: readonly string[]
  grid: string
  axis: string
  label: string
  /** Behind labels and dots, so they read over the curves. */
  halo: string
  font: string
}

const CURVE_TOKENS = ['--color-accent', '--color-ok', '--color-progress', '--color-warn', '--color-info'] as const

/** The swatch beside each line in the list and the legend, in the curves' order. */
export const CURVE_SWATCHES = ['bg-accent', 'bg-ok', 'bg-progress', 'bg-warn', 'bg-info'] as const

export const curveColour = (theme: GraphTheme, index: number): string => theme.curves[index % theme.curves.length]

export const swatchOf = (index: number): string => CURVE_SWATCHES[index % CURVE_SWATCHES.length]

/** Each token resolved to a colour the canvas takes, through `probe`, an element inside the graph. */
export function readGraphTheme(probe: HTMLElement): GraphTheme {
  const style = getComputedStyle(probe)
  const colour = (token: string): string => {
    probe.style.color = `var(${token}, currentColor)`

    return style.color
  }
  const theme: GraphTheme = {
    curves: CURVE_TOKENS.map(colour),
    grid: colour('--color-line'),
    axis: colour('--color-line-strong'),
    label: colour('--color-fg-3'),
    halo: colour('--color-bg'),
    font: style.fontFamily || 'system-ui, sans-serif'
  }
  probe.style.color = ''

  return theme
}

const same = (a: GraphTheme | null, b: GraphTheme): boolean => Boolean(a) && JSON.stringify(a) === JSON.stringify(b)

/** The theme as the graph draws it, read again when the root's theme attributes or the system's scheme change. */
export function useGraphTheme(probe: RefObject<HTMLElement | null>): GraphTheme | null {
  const [theme, setTheme] = useState<GraphTheme | null>(null)

  useEffect(() => {
    const element = probe.current

    if (!element) {
      return
    }

    const read = () => {
      const next = readGraphTheme(element)
      setTheme(previous => (same(previous, next) ? previous : next))
    }

    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-accent', 'data-scheme', 'data-shell-mode'] })
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    scheme.addEventListener('change', read)

    return () => {
      observer.disconnect()
      scheme.removeEventListener('change', read)
    }
  }, [probe])

  return theme
}
