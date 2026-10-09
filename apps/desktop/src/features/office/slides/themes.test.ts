import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { $env } from '../../../store/backend.ts'
import { type Background, SLOTS, type Theme } from './deck.ts'
import { masterOf } from './layouts.ts'
import * as model from './model.ts'
import { $customThemes, customThemesPath, deleteCustomTheme, loadCustomThemes, saveCustomTheme } from './theme-store.ts'
import { DEFAULT_THEME, editTheme, findTheme, fontStack, luminance, setCustomThemes, themeById, THEMES } from './themes.ts'

const contrast = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)

  return (light + 0.05) / (dark + 0.05)
}

const GRADIENT: Background = {
  kind: 'gradient',
  stops: [
    { at: 0, color: 'bg1' },
    { at: 1, color: 'bg2' }
  ],
  angle: 90
}

describe('built-in themes', () => {
  it('keeps every theme there was and adds more, some with gradient backgrounds', () => {
    const ids = THEMES.map((theme) => theme.id)

    expect(ids.slice(0, 8)).toEqual(['herald', 'midnight', 'paper', 'graphite', 'forest', 'coral', 'mono', 'ocean'])
    expect(ids.length).toBeGreaterThanOrEqual(12)
    expect(new Set(ids).size).toBe(ids.length)
    expect(THEMES.filter((theme) => theme.background?.kind === 'gradient').length).toBeGreaterThanOrEqual(2)
    expect(DEFAULT_THEME.background).toBeUndefined()
  })

  it.each(THEMES.map((theme) => [theme.name, theme] as const))('%s: text reads at 4.5:1 on both backgrounds and accents at 3:1 on the first', (_, theme) => {
    for (const text of [theme.colors.tx1, theme.colors.tx2]) {
      expect(contrast(text, theme.colors.bg1)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(text, theme.colors.bg2)).toBeGreaterThanOrEqual(4.5)
    }

    for (const slot of SLOTS.filter((entry) => entry.startsWith('accent'))) {
      expect(contrast(theme.colors[slot], theme.colors.bg1)).toBeGreaterThanOrEqual(3)
    }
  })

  it('stacks each theme font with look-alikes for machines without it', () => {
    expect(fontStack('Avenir Next')).toMatch(/^"Avenir Next", .*"URW Gothic".*, sans-serif$/)
    expect(fontStack('Palatino')).toMatch(/^"Palatino", .*"TeX Gyre Pagella".*, serif$/)
    expect(fontStack('Helvetica Neue')).toContain('"Liberation Sans"')
    expect(fontStack('Menlo')).toMatch(/monospace$/)
    expect(fontStack('Some Display Face')).toBe('"Some Display Face", "Helvetica Neue", "Noto Sans", "Arial", sans-serif')

    for (const theme of THEMES) {
      expect(fontStack(theme.fonts.heading).split(', ').length).toBeGreaterThan(3)
      expect(fontStack(theme.fonts.body).split(', ').length).toBeGreaterThan(3)
    }
  })
})

describe('editing themes', () => {
  it('changes a theme’s name, colours, fonts and background, keeping its id', () => {
    const base = themeById('paper')!
    const edited = editTheme(base, { name: '  Letterhead ', colors: { accent1: '#C0F', tx2: '#123456' }, fonts: { heading: 'Baskerville' }, background: GRADIENT })

    expect(edited).toMatchObject({ id: 'paper', name: 'Letterhead', fonts: { heading: 'Baskerville', body: 'Georgia' }, background: GRADIENT })
    expect(edited.colors).toMatchObject({ accent1: '#cc00ff', tx2: '#123456', bg1: base.colors.bg1 })
    expect(base.colors.accent1).not.toBe('#cc00ff')
    expect(editTheme(edited, { background: null, name: ' ', fonts: { body: '+heading' } })).toMatchObject({ name: 'Letterhead', fonts: { body: 'Georgia' } })
    expect(editTheme(edited, { background: null }).background).toBeUndefined()
    expect(() => editTheme(base, { colors: { bg1: 'blue' } })).toThrow(/not a colour/)
    expect(() => editTheme(base, { background: { kind: 'image', src: 'data:image/png;base64,', natural: { width: 1, height: 1 } } })).toThrow(/colour or a gradient/)
  })
})

describe('applying themes', () => {
  const gradient = editTheme(themeById('ocean')!, { name: 'Tide', background: GRADIENT })

  it('moves a theme’s background into the master with the theme, and takes it back with the next', () => {
    const deck = model.newDeck('Pitch')
    const tide = model.applyTheme(deck, gradient).deck

    expect(tide.theme).toBe(gradient)
    expect(masterOf(tide).background).toEqual(GRADIENT)

    const plain = model.applyTheme(tide, 'mono').deck
    expect(plain.theme.id).toBe('mono')
    expect(masterOf(plain).background).toBeNull()

    const own = model.setMasterBackground(tide, { kind: 'solid', color: 'accent2' }).deck
    expect(masterOf(model.applyTheme(own, 'mono').deck).background).toEqual({ kind: 'solid', color: 'accent2' })
    expect(masterOf(model.applyTheme(own, themeById('aurora')!).deck).background).toEqual({ kind: 'solid', color: 'accent2' })
    expect(model.applyTheme(plain, 'mono').deck).toBe(plain)
  })

  it('gives chosen slides a theme of their own, with its background, and clears them for the whole deck', () => {
    const deck = model.addSlide(model.addSlide(model.newDeck('Pitch')).deck).deck
    const [first, second, third] = deck.slides.map((slide) => slide.id)
    const change = model.applyTheme(deck, gradient, [first, second])

    expect(change.label).toBe('Theme')
    expect(change.deck.slides.map((slide) => slide.theme?.name)).toEqual(['Tide', 'Tide', undefined])
    expect(change.deck.slides[0].background).toEqual(GRADIENT)
    expect(change.deck.theme).toBe(deck.theme)
    expect(change.deck.slides[2]).toBe(deck.slides[2])

    const back = model.applyTheme(change.deck, deck.theme, [second, third]).deck
    expect(back.slides[1].theme).toBeUndefined()
    expect(back.slides[1].background).toBeNull()
    expect(back.slides[2]).toBe(deck.slides[2])

    const whole = model.applyTheme(change.deck, 'forest').deck
    expect(whole.slides.every((slide) => !slide.theme && slide.background === null)).toBe(true)
    expect(model.applyTheme(deck, deck.theme, [third]).deck).toBe(deck)
  })

  it('starts a deck in a theme with its background on the master', () => {
    const deck = model.newDeck('Pitch', { theme: themeById('dune') })

    expect(masterOf(deck).background).toEqual(themeById('dune')!.background)
    expect(model.newDeck('Pitch').master).toBeUndefined()
  })
})

describe('custom themes', () => {
  let files: Map<string, string>
  let writes: number

  beforeEach(() => {
    files = new Map()
    writes = 0
    $env.set({ platform: 'darwin', hermesHome: '/home/me/.hermes/', homeDir: '/home/me', version: '0.0.0', isDev: false, shellMode: 'panels' })
    ;(globalThis as unknown as { window: unknown }).window = {
      heraldOS: {
        canvas: { exists: async (path: string) => (files.has(path) ? 'file' : null) },
        fs: {
          readFile: async (path: string) => {
            const content = files.get(path)

            if (content === undefined) {
              throw new Error(`Error invoking remote method 'herald-os:fs:readFile': Error: ENOENT: no such file or directory, stat '${path}'`)
            }

            return { path, kind: 'text', size: content.length, content }
          },
          writeText: async (path: string, content: string) => {
            writes++
            files.set(path, content)
          }
        }
      }
    }
  })

  afterEach(() => {
    $env.set(null)
    setCustomThemes([])
    $customThemes.set([])
  })

  const path = '/home/me/.hermes/herald-os/office/slide-themes.json'

  it('keeps custom themes in Herald’s data folder under ids of their own', async () => {
    expect(customThemesPath('/home/me/.hermes/')).toBe(path)
    expect(await loadCustomThemes()).toEqual([])
    expect(writes).toBe(0)

    const acme = await saveCustomTheme(editTheme(themeById('herald')!, { name: 'Acme Café', colors: { accent1: '#ff0066' }, background: GRADIENT }))
    const second = await saveCustomTheme(editTheme(themeById('mono')!, { name: 'Acme Café' }))
    const file = JSON.parse(files.get(path)!)

    expect(acme.id).toBe('custom-acme-cafe')
    expect(second.id).toBe('custom-acme-cafe-2')
    expect(file).toMatchObject({ format: 'herald-slide-themes', version: 1 })
    expect(file.themes.map((theme: Theme) => theme.id)).toEqual(['custom-acme-cafe', 'custom-acme-cafe-2'])
    expect(file.themes[0]).toMatchObject({ name: 'Acme Café', colors: { accent1: '#ff0066' }, background: GRADIENT })
    expect($customThemes.get().map((theme) => theme.id)).toEqual(['custom-acme-cafe', 'custom-acme-cafe-2'])
    expect(findTheme('custom-acme-cafe')?.colors.accent1).toBe('#ff0066')
    expect(model.applyTheme(model.newDeck('Pitch'), 'custom-acme-cafe').deck.theme.name).toBe('Acme Café')

    const renamed = await saveCustomTheme({ ...acme, name: 'Acme' })
    expect(renamed.id).toBe('custom-acme-cafe')
    expect(JSON.parse(files.get(path)!).themes.map((theme: Theme) => theme.name)).toEqual(['Acme', 'Acme Café'])

    await deleteCustomTheme('custom-acme-cafe')
    expect($customThemes.get().map((theme) => theme.id)).toEqual(['custom-acme-cafe-2'])
    expect(findTheme('custom-acme-cafe')).toBeUndefined()

    setCustomThemes([])
    $customThemes.set([])
    expect((await loadCustomThemes()).map((theme) => theme.name)).toEqual(['Acme Café'])
  })

  it('checks what it reads, and says what went wrong', async () => {
    files.set(path, JSON.stringify({ format: 'herald-slide-themes', version: 1, themes: [{ id: 'herald', name: 'Odd', colors: { bg1: 'nope' } }, 'junk'] }))
    const [odd, junk] = await loadCustomThemes()

    expect(odd).toMatchObject({ id: 'custom-odd', name: 'Odd' })
    expect(odd.colors.bg1).toBe(DEFAULT_THEME.colors.bg1)
    expect(junk.id).toMatch(/^custom-/)

    files.set(path, '{ not json')
    await expect(loadCustomThemes()).rejects.toThrow(/damaged/)
    await expect(saveCustomTheme(DEFAULT_THEME)).rejects.toThrow(/damaged/)
    expect(files.get(path)).toBe('{ not json')

    files.set(path, JSON.stringify({ format: 'herald-slide-themes', version: 2, themes: [] }))
    await expect(loadCustomThemes()).rejects.toThrow(/newer Herald/)

    $env.set(null)
    await expect(loadCustomThemes()).rejects.toThrow(/Hermes home/)
  })
})
