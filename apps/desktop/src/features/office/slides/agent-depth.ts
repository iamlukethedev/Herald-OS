import { openEntries, type Outcome } from '../agent.ts'
import {
  addConnectorStep,
  addLogoStep,
  addMasterImageStep,
  addMasterShapeStep,
  addMasterTextStep,
  connectionSitesOf,
  convertToShapesStep,
  groupStep,
  masterPlaceOf,
  readMaster as masterRead,
  removeFromMasterStep,
  renameLayoutStep,
  resetMasterStep,
  rotateStep,
  setBackgroundStep,
  setCellBordersStep,
  setFillStep,
  setHeaderFooterStep,
  setPlaceholderStep,
  setTransitionStep,
  showMasterGraphicsStep,
  themeFromArgs,
  themesList,
  ungroupStep
} from './agent-depth-model.ts'
import { flag, rangeSlidesStep, setThemeStep, type StepMaker, themeOf } from './agent-model.ts'
import { count, located, picturesFor, reading, sheetSources, stepOn } from './agent.ts'
import type { Theme } from './deck.ts'
import { deleteCustomTheme, loadCustomThemes, saveCustomTheme } from './theme-store.ts'
import { THEMES } from './themes.ts'

/*
 * What Hermes (and voice, the command bar and `herald-os slides`) does with Herald Slides' depth:
 * the slide master and its layouts, backgrounds, the header and footer, themes of the person's own,
 * transitions, groups, connectors, table borders, fills and slides from a sheet. As in agent.ts, a
 * command works on the presentation it names or the one in front, and each change is one step to
 * undo in an open presentation, or the file written back.
 */

type Args = Record<string, unknown>

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '')

const given = (value: unknown): boolean => value !== undefined && value !== null && value !== ''

/** A depth step made on the presentation a command names. */
const stepping =
  (make: StepMaker) =>
  async (args: Args): Promise<Outcome> =>
    stepOn(await located(args.presentation), (deck, context) => make(deck, args, context))

/** A depth step that puts in a picture from a file, read first. */
const picturing =
  (make: StepMaker) =>
  async (args: Args): Promise<Outcome> => {
    const pictures = await picturesFor([text(args.source)])

    return stepOn(await located(args.presentation), (deck, context) => make(deck, args, context), { pictures })
  }

export async function readMaster(args: Args): Promise<Outcome> {
  const { name, path, on } = await reading(await located(args.presentation))
  const read = masterRead(on.deck, given(args.layout) ? masterPlaceOf(on.deck, args.layout) : null)
  const used = read.layouts.filter((layout) => layout.slides.length).map((layout) => `${layout.name} (${count(layout.slides.length, 'slide')})`)

  return {
    summary: `${name}: the slide master has ${count(read.master.elements.length, 'element')} of its own and ${count(read.master.placeholders.length, 'placeholder')}${used.length ? `; the slides are on ${used.join(', ')}` : ''}`,
    data: { name, path, ...read }
  }
}

export const setBackground = picturing(setBackgroundStep)

export const addMasterText = stepping(addMasterTextStep)

export const addMasterShape = stepping(addMasterShapeStep)

export const addMasterImage = picturing(addMasterImageStep)

export const addLogo = picturing(addLogoStep)

export const removeFromMaster = stepping(removeFromMasterStep)

export const setPlaceholder = stepping(setPlaceholderStep)

export const showMasterGraphics = stepping(showMasterGraphicsStep)

export const renameLayout = stepping(renameLayoutStep)

export const resetMaster = stepping(resetMasterStep)

export const setHeaderFooter = stepping(setHeaderFooterStep)

export const setTransition = stepping(setTransitionStep)

export const group = stepping(groupStep)

export const ungroup = stepping(ungroupStep)

export const rotate = stepping(rotateStep)

export const convertToShapes = stepping(convertToShapesStep)

export const addConnector = stepping(addConnectorStep)

export const setCellBorders = stepping(setCellBordersStep)

export const setFill = stepping(setFillStep)

export async function connectionSites(args: Args): Promise<Outcome> {
  const { name, on } = await reading(await located(args.presentation))
  const read = connectionSitesOf(on.deck, args, { front: on.doc?.slideId ?? null })

  return {
    summary: `The ${read.kind.toLowerCase()} ${read.element} on slide ${read.slide} of ${name} has ${count(read.sites.length, 'connection site')}${read.sites.length ? `: ${read.sites.map((site) => `${site.site} ${site.facing}`).join(', ')}` : ''}`,
    data: { name, ...read }
  }
}

export async function addSlideFromSheet(args: Args): Promise<Outcome> {
  const sheets = await sheetSources([text(args.workbook)])

  return stepOn(await located(args.presentation), (deck, context) => rangeSlidesStep(deck, args, context), { sheets })
}

export async function listThemes(): Promise<Outcome> {
  const custom = await loadCustomThemes()
  const listed = themesList(custom)

  return {
    summary: `${count(listed.themes.length, 'built-in theme')} (${THEMES.map((theme) => theme.id).join(', ')}) and ${count(custom.length, 'custom theme')}${custom.length ? ` (${custom.map((theme) => `${theme.name}: ${theme.id}`).join(', ')})` : ''}`,
    data: listed
  }
}

/** The theme a new one starts from: the one named, else the presentation's, else Herald's own. */
async function baseTheme(args: Args, custom: readonly Theme[]): Promise<Theme> {
  if (given(args.from)) {
    return themeOf(args.from, custom)
  }

  if (!given(args.presentation) && !(await openEntries()).some((entry) => entry.app === 'slides')) {
    return THEMES[0]
  }

  return (await reading(await located(args.presentation))).on.deck.theme
}

/** A custom theme made from another with colours and fonts changed, saved among the person's themes, and put on the presentation with apply. */
export async function makeTheme(args: Args): Promise<Outcome> {
  const custom = await loadCustomThemes()
  const base = await baseTheme(args, custom)
  const made = themeFromArgs(args, base, [...THEMES, ...custom])
  const saved = await saveCustomTheme({ ...made, id: 'new' })
  const said = `Made the custom theme ${saved.name} (${saved.id}) from ${base.name}`

  if (flag(args.apply) !== true) {
    return { summary: `${said}; slides.setTheme theme=${saved.id} puts it on a presentation`, data: { theme: saved.id, name: saved.name, from: base.id } }
  }

  const applied = await stepOn(await located(args.presentation), (deck, context) => setThemeStep(deck, { theme: saved.id, slide: args.slide }, context), { themes: [...custom, saved] })

  return { summary: `${said}. ${applied.summary}`, data: { ...applied.data, theme: saved.id, name: saved.name, from: base.id } }
}

export async function deleteTheme(args: Args): Promise<Outcome> {
  const asked = text(args.theme)

  if (!asked) {
    throw new Error('Say which custom theme to delete (theme: its id or name, as slides.listThemes gives them)')
  }

  const wanted = asked.toLowerCase()
  const builtIn = THEMES.find((theme) => theme.id === wanted || theme.name.toLowerCase() === wanted)

  if (builtIn) {
    throw new Error(`${builtIn.name} is one of Herald’s own themes, which stay: only custom themes are deleted`)
  }

  const custom = await loadCustomThemes()
  const found = custom.find((theme) => theme.id === wanted) ?? custom.find((theme) => theme.name.toLowerCase() === wanted)

  if (!found) {
    throw new Error(custom.length ? `There is no custom theme “${asked}”: the custom themes are ${custom.map((theme) => `${theme.name} (${theme.id})`).join(', ')}` : 'There are no custom themes to delete')
  }

  await deleteCustomTheme(found.id)

  return { summary: `Deleted the custom theme ${found.name} (${found.id}); presentations that use it keep its colours and fonts`, data: { theme: found.id, name: found.name } }
}
