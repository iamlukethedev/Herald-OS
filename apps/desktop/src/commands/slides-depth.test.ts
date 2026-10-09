import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EDIT_OPS } from '../features/office/slides/agent-depth-model.ts'
import { SHAPE_KINDS, TRANSITIONS } from '../features/office/slides/deck.ts'
import { THEMES } from '../features/office/slides/themes.ts'
import { COMMAND_ID, validateArgs } from '../store/os-commands.ts'
import { slidesDepthCommands } from './slides-depth.ts'
import { slidesCommands } from './slides.ts'

const TIERS: Record<string, string> = {
  'slides.readMaster': 'read',
  'slides.setBackground': 'act',
  'slides.addMasterText': 'act',
  'slides.addMasterShape': 'act',
  'slides.addMasterImage': 'act',
  'slides.addLogo': 'act',
  'slides.removeFromMaster': 'mutate',
  'slides.setPlaceholder': 'act',
  'slides.showMasterGraphics': 'act',
  'slides.renameLayout': 'act',
  'slides.resetMaster': 'mutate',
  'slides.setHeaderFooter': 'act',
  'slides.listThemes': 'read',
  'slides.makeTheme': 'act',
  'slides.deleteTheme': 'mutate',
  'slides.setTransition': 'act',
  'slides.group': 'act',
  'slides.ungroup': 'act',
  'slides.rotate': 'act',
  'slides.convertToShapes': 'act',
  'slides.addConnector': 'act',
  'slides.connectionSites': 'read',
  'slides.setCellBorders': 'act',
  'slides.setFill': 'act',
  'slides.addSlideFromSheet': 'act'
}

/** The commands that write the person's theme store rather than change a deck, so a batch has no op for them. */
const STORE = ['slides.makeTheme', 'slides.deleteTheme']

/** Shape presets the descriptions name in lower case, besides the camelCase ones. */
const PLAIN_SHAPES = ['rect', 'ellipse', 'triangle', 'diamond', 'plaque', 'pentagon', 'hexagon', 'octagon', 'plus', 'can', 'cube', 'donut', 'heart', 'sun', 'moon', 'cloud', 'frame', 'pie', 'teardrop', 'chevron', 'wave']

const FAMILIES = ['rectangles', 'basic shapes', 'brackets', 'arrows', 'math', 'flowchart', 'stars', 'callouts']

const command = (id: string) => slidesCommands.find((entry) => entry.id === id)!

const argOf = (id: string, name: string): string => command(id).args.find((arg) => arg.name === name)?.description ?? ''

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../../../../plugins/herald-os-bridge/${path}`, import.meta.url)), 'utf8')

/** The themes a description lists before what follows its first semicolon: each name before its words in brackets. */
const themesIn = (description: string): string[] => [...description.replace(/\([^)]*\)/g, '()').split(';')[0].matchAll(/([a-z]+) \(\)/g)].map((match) => match[1])

/** The words of a list like "none, fade, push or zoom". */
const listed = (words: string): string[] => words.split(/,\s*|\s+or\s+/).map((word) => word.trim())

/** Shape presets a description names in camelCase. */
const camelCase = (description: string): string[] => description.match(/\b[a-z]+(?:[A-Z0-9][a-z0-9]*)+\b/g) ?? []

/** A property's description in the bridge's slides schema. */
function bridgeProperty(name: string): string {
  const tools = read('bridge/tools.py')
  const schema = tools.slice(tools.indexOf('SLIDES_SCHEMA = _schema('))
  const found = new RegExp(`"${name}": _desc\\(_[A-Z]+, "((?:[^"\\\\]|\\\\.)*)"\\)`).exec(schema)

  return found ? found[1] : ''
}

describe('Herald Slides’ depth commands', () => {
  it('each read, change or take away what the person made at their tier, once each', () => {
    const ids = slidesCommands.map((entry) => entry.id)

    expect(slidesDepthCommands.map((entry) => entry.id)).toEqual(Object.keys(TIERS))
    expect(Object.fromEntries(Object.keys(TIERS).map((id) => [id, command(id)?.tier]))).toEqual(TIERS)
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
    expect(ids.filter((id) => !COMMAND_ID.test(id))).toEqual([])
  })

  it('describe every argument for Hermes, give no optional one a fixed list of choices, and take each once', () => {
    for (const entry of slidesCommands) {
      expect(entry.description.length, entry.id).toBeGreaterThan(40)
      expect(new Set(entry.args.map((arg) => arg.name)).size, entry.id).toBe(entry.args.length)

      for (const arg of entry.args) {
        expect(arg.description, `${entry.id} ${arg.name}`).toBeTruthy()
        expect(arg.enum, `${entry.id} ${arg.name}`).toBeUndefined()
      }
    }
  })

  it('have a command for each op of slides.edit, named after it, so a batch asks as its ops alone do', () => {
    const changes = slidesDepthCommands.filter((entry) => entry.tier !== 'read' && !STORE.includes(entry.id)).map((entry) => entry.id.slice('slides.'.length))

    expect(EDIT_OPS.filter((op) => !slidesCommands.some((entry) => entry.id === `slides.${op}`))).toEqual([])
    expect(changes.filter((op) => !EDIT_OPS.includes(op))).toEqual([])
    expect(changes.every((op) => command('slides.edit').description.includes(op))).toBe(true)
  })

  it('keep Phase 3’s arguments, take chosen slides for a theme and a gradient for a shape', () => {
    const names = (id: string) => command(id).args.map((arg) => arg.name)

    expect(names('slides.fromDocument')).toEqual(['document', 'presentation', 'level', 'notes'])
    expect(names('slides.insertRange')).toEqual(['presentation', 'slide', 'workbook', 'range', 'sheet', 'x', 'y', 'width'])
    expect(names('slides.setTheme')).toEqual(['presentation', 'theme', 'slide'])
    expect(names('slides.addShape')).toEqual(['presentation', 'slide', 'kind', 'x', 'y', 'width', 'height', 'fill', 'gradient', 'angle', 'radial', 'text'])
    expect(validateArgs(command('slides.setTheme'), { theme: 'midnight', slide: '2-4' })).toEqual({ args: { theme: 'midnight', slide: '2-4' } })
    expect(validateArgs(command('slides.removeFromMaster'), { elements: ['logo-1', 'shape-2'] })).toEqual({ args: { elements: '["logo-1","shape-2"]' } })
    expect(validateArgs(command('slides.makeTheme'), { name: 'Brand', colors: { accent1: '#0b7d97' }, apply: 'true' })).toEqual({ args: { name: 'Brand', colors: '{"accent1":"#0b7d97"}', apply: true } })
    expect(validateArgs(command('slides.addConnector'), { from: 'shape-1' })).toEqual({ error: expect.stringMatching(/^slides\.addConnector needs "to"/) })
  })

  it('name every theme and transition as they are, and the families of shapes', () => {
    const themes = THEMES.map((theme) => theme.id)

    for (const id of ['slides.new', 'slides.setTheme']) {
      expect(themesIn(argOf(id, 'theme')), id).toEqual(themes)
    }

    expect(listed(argOf('slides.setTransition', 'kind'))).toEqual([...TRANSITIONS])

    for (const id of ['slides.addShape', 'slides.addMasterShape']) {
      const kinds = argOf(id, 'kind')

      expect(FAMILIES.filter((family) => !kinds.includes(family)), id).toEqual([])
      expect(camelCase(kinds).filter((kind) => !(SHAPE_KINDS as readonly string[]).includes(kind)), id).toEqual([])
      expect(camelCase(kinds).length, id).toBeGreaterThan(40)
    }

    expect(PLAIN_SHAPES.filter((kind) => !(SHAPE_KINDS as readonly string[]).includes(kind) || !argOf('slides.addShape', 'kind').includes(kind))).toEqual([])
  })

  it('are described the same way by the bridge and the skill', () => {
    const skill = read('skills/herald-slides/SKILL.md').replace(/\s+/g, ' ')
    const kinds = bridgeProperty('kind')

    expect(themesIn(bridgeProperty('theme'))).toEqual(THEMES.map((theme) => theme.id))
    expect(listed(/set_transition: ([a-z, ]+?);/.exec(kinds)?.[1] ?? '')).toEqual([...TRANSITIONS])
    expect(FAMILIES.filter((family) => !kinds.includes(family))).toEqual([])
    expect(camelCase(kinds).filter((kind) => !(SHAPE_KINDS as readonly string[]).includes(kind))).toEqual([])
    expect(THEMES.filter((theme) => !skill.includes(`\`${theme.id}\``)).map((theme) => theme.id)).toEqual([])
    expect(TRANSITIONS.filter((kind) => !skill.includes(`\`${kind}\``))).toEqual([])
    expect(FAMILIES.filter((family) => !skill.includes(family))).toEqual([])
  })
})
