import { describe, expect, it } from 'vitest'
import { distinctAppLabel } from '../../shell/apps.ts'
import { buildCatalog, filterTiles } from './app-catalog.ts'

const NAUTILUS = { name: 'Files', path: '/usr/share/applications/org.gnome.Nautilus.desktop', bundleId: 'org.gnome.Nautilus' }

describe('distinctAppLabel', () => {
  it('names an installed app after its id when Herald already shows that name', () => {
    expect(distinctAppLabel(NAUTILUS, new Set(['files']))).toBe('Files (Nautilus)')
  })

  it('leaves every other name alone', () => {
    expect(distinctAppLabel({ name: 'Text Editor', bundleId: 'org.gnome.TextEditor' }, new Set(['files']))).toBe('Text Editor')
    expect(distinctAppLabel({ name: 'Files' }, new Set(['files']))).toBe('Files')
  })
})

describe('buildCatalog', () => {
  it('keeps Herald Files and GNOME Files apart, and finds both by "files"', () => {
    const tiles = buildCatalog([NAUTILUS])

    expect(tiles.filter(tile => tile.label === 'Files')).toHaveLength(1)
    expect(filterTiles(tiles, 'all', 'files').map(tile => tile.label)).toEqual(expect.arrayContaining(['Files', 'Files (Nautilus)']))
  })

  it('puts Herald Docs, Sheets and Slides after Herald Canvas, found by the names people know', () => {
    const labels = buildCatalog([]).map(tile => tile.label)
    const canvas = labels.indexOf('Herald Canvas')

    expect(labels.slice(canvas, canvas + 4)).toEqual(['Herald Canvas', 'Herald Docs', 'Herald Sheets', 'Herald Slides'])
    expect(filterTiles(buildCatalog([]), 'all', 'excel').map(tile => tile.label)).toEqual(['Herald Sheets'])
    expect(filterTiles(buildCatalog([]), 'productivity', 'powerpoint').map(tile => tile.label)).toEqual(['Herald Slides'])
  })

  it('puts the Pet Room after Missions, found by its name and by what it shows', () => {
    const labels = buildCatalog([]).map(tile => tile.label)

    expect(labels[labels.indexOf('Missions') + 1]).toBe('Pet Room')
    expect(filterTiles(buildCatalog([]), 'all', 'pet room').map(tile => tile.label)).toEqual(['Pet Room'])
    expect(filterTiles(buildCatalog([]), 'productivity', 'agents').map(tile => tile.label)).toEqual(['Pet Room'])
  })

  it('puts Herald Calc after Herald Slides, found as a calculator and by what it does', () => {
    const labels = buildCatalog([]).map(tile => tile.label)

    expect(labels[labels.indexOf('Herald Slides') + 1]).toBe('Herald Calc')

    for (const query of ['calculator', 'calc', 'Calc', 'convert', 'units', 'currency', 'math']) {
      expect(filterTiles(buildCatalog([]), 'all', query).map(tile => tile.label), query).toEqual(['Herald Calc'])
    }

    expect(filterTiles(buildCatalog([]), 'productivity', 'calculator')).toMatchObject([{ kind: 'hermes', appId: 'calc', icon: 'calc' }])
  })
})
