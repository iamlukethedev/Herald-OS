import { IMAGE_TYPES } from '../../../../shared/office/document.ts'
import { baseName, extensionOf, officeAppFor } from '../../../../shared/office/files.ts'
import type { CommandContext, CommandResult } from '../../../store/os-commands.ts'
import { isMainSurface, isPanels } from '../../../store/shell.ts'
import { openApp } from '../../../store/windows.ts'
import { exists, homeDir, type Local, locate, openEntries, type Outcome, resolve, showDocument, withEditor } from '../agent.ts'
import { documentFileName, fileName, freePath, stepCount, tildePath } from '../agent-model.ts'
import { openInOffice } from '../open.ts'
import type { OfficeDocument } from '../types.ts'
import { slidesAdapter } from './adapter.ts'
import {
  addImageStep,
  addShapeStep,
  addSlideStep,
  addSpecs,
  addTableStep,
  addTextStep,
  deckFromSpecs,
  duplicateSlideStep,
  findInDeck,
  headingLevelOf,
  moveSlideStep,
  newDeckWith,
  type Picture,
  readDeck,
  removeSlideStep,
  replaceStep,
  runEdits,
  setSlideStep,
  setThemeStep,
  sizeOf,
  slideEditsOf,
  slideIdOf,
  slideNumber,
  slideSpecsOf,
  slidesFromDocument,
  type Step,
  type StepContext,
  themeOf
} from './agent-model.ts'
import type { Deck } from './deck.ts'
import { flushTyping } from './editor/active.ts'
import { isEmptyPlaceholder } from './layouts.ts'
import { makeTargets, type SlidesTarget } from './live.ts'
import * as model from './model.ts'
import { decks, slidesSession as session } from './store.ts'

/*
 * What Hermes (and voice, the command bar and `herald-os slides`) does in Herald Slides. A command
 * works on the presentation it names or the one in front. Open in a window, each change is one
 * step to undo there (a batch too) and saves the way the person's own edits do; a file that is not
 * open is read, changed and written back, unless reading it approximated something (then it has to
 * be opened first, so nothing is lost silently). Main backs a file up before Herald first writes over it.
 */

type Args = Record<string, unknown>

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '')

const given = (value: unknown): boolean => value !== undefined && value !== null && value !== ''

const where = (file: string | null): string => (file ? tildePath(file, homeDir()) : 'not saved yet')

const count = (n: number, word: string, plural = `${word}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? word : plural}`

const stem = (name: string): string => name.replace(/\.[a-z0-9]{1,5}$/i, '')

const capitalised = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1)

async function located(ref: unknown): Promise<Local<Deck>> {
  const found = await locate('slides', session, ref)

  if (found.kind === 'remote') {
    throw new Error(`${found.entry.name} is open in another Herald Slides window: ask there`)
  }

  return found
}

/** Where a command's change lands (live.ts): the deck it names in front, this window's decks and the files on disk behind. */
function targetsFor(found: Local<Deck>) {
  return makeTargets({
    documents: () => session.$documents.get(),
    active: () => (found.kind === 'live' ? found.doc : session.active()),
    live: (key) => decks.get(key),
    changed: (doc) => session.changed(doc),
    read: (file) => window.heraldOS.office.read(file),
    write: (file, bytes) => window.heraldOS.office.write(file, bytes),
    adapter: slidesAdapter,
    flush: (doc) => flushTyping(doc)
  })
}

/** The deck as it is now: live in its window (typing folded in), as last held while its window is closed, or read from its file. */
async function reading(found: Local<Deck>): Promise<{ name: string; path: string | null; on: SlidesTarget }> {
  const on = await targetsFor(found).target(found.kind === 'file' ? found.path : null)

  return { name: found.kind === 'file' ? fileName(found.path) : found.doc.name, path: on.path, on }
}

/** A change that changes nothing leaves `apply` this way, so it is neither a step to undo nor a file written again. */
class Unchanged extends Error {
  step: Step

  constructor(step: Step) {
    super('Nothing changed')
    this.step = step
  }
}

interface Changed {
  step: Step
  changed: boolean
  name: string
  path: string | null
}

/**
 * Make one change, worked out from the deck as it is when it lands: one step to undo in an open
 * deck (its window comes back first if it was closed, so the person sees it), or the file written back.
 */
async function change(found: Local<Deck>, make: (deck: Deck, front: string | null) => Step): Promise<Changed> {
  if (found.kind === 'live') {
    await withEditor('slides', found.doc)
  }

  const targets = targetsFor(found)
  const on = await targets.target(found.kind === 'file' ? found.path : null)
  const name = found.kind === 'file' ? fileName(found.path) : found.doc.name

  try {
    const landed = await targets.apply(on, (deck) => {
      const step = make(deck, on.doc?.slideId ?? null)

      if (step.deck === deck) {
        throw new Unchanged(step)
      }

      return { ...step, label: `Hermes: ${step.label}` }
    })

    return { step: landed as Step, changed: true, name, path: on.path }
  } catch (error) {
    if (error instanceof Unchanged) {
      return { step: error.step, changed: false, name, path: on.path }
    }

    throw error
  }
}

function outcomeOf({ step, changed, name, path }: Changed): Outcome {
  return { summary: changed ? `${capitalised(step.done)} in ${name}` : `Nothing changed in ${name}: ${step.done}`, data: { name, path, changed, ...step.info } }
}

async function stepOn(found: Local<Deck>, make: (deck: Deck, context: StepContext) => Step, pictures?: ReadonlyMap<string, Picture>): Promise<Outcome> {
  return outcomeOf(await change(found, (deck, front) => make(deck, { front, pictures })))
}

/** A picture file as a slide holds it (PNG, JPEG or GIF; WebP and BMP become PNG, very large ones are scaled down), read before the change is made. */
async function picture(source: string): Promise<Picture> {
  const { readPicture } = await import('./editor/commands.ts')

  if (source.startsWith('data:image/')) {
    return readPicture(await (await fetch(source)).blob())
  }

  if (/^https?:/i.test(source)) {
    throw new Error(`Herald Slides puts in pictures from files: save ${source} first and give its path`)
  }

  const file = resolve(source.replace(/^file:\/\//, ''))
  const type = IMAGE_TYPES[extensionOf(file).slice(1)] ?? ''

  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'].includes(type)) {
    throw new Error(`${fileName(file)} is not a picture Herald Slides shows (PNG, JPEG, GIF, WebP or BMP)`)
  }

  if (!(await exists(file))) {
    throw new Error(`There is no file at ${file}`)
  }

  try {
    return await readPicture(new Blob([(await window.heraldOS.office.read(file)).bytes as Uint8Array<ArrayBuffer>], { type }))
  } catch {
    throw new Error(`Herald Slides could not read the picture in ${fileName(file)}`)
  }
}

async function picturesFor(sources: readonly string[]): Promise<Map<string, Picture>> {
  return new Map(await Promise.all([...new Set(sources.filter(Boolean))].map(async (source) => [source, await picture(source)] as const)))
}

// New presentations.

/** The deck in front when it is a new one nobody has touched (never saved, unchanged, one empty slide): a new presentation goes into it rather than a tab of its own. */
function untouched(): OfficeDocument<Deck> | null {
  const doc = session.active()
  const live = doc ? decks.get(doc.key) : undefined
  const deck = live?.history.present ?? doc?.initial

  return doc && deck && !doc.path && !doc.modified && !live?.history.canUndo && deck.slides.length === 1 && !deck.slides[0].notes && deck.slides[0].elements.every(isEmptyPlaceholder) ? doc : null
}

/** A new deck shown in its window, and saved at `file` (a new file) when given. */
async function startDeck(deck: Deck, name: string | undefined, file: string | null): Promise<OfficeDocument<Deck>> {
  const blank = untouched()
  const doc = blank ?? session.create({ name, model: deck })

  if (blank) {
    blank.name = name || blank.name

    if (blank.editor) {
      blank.editor.load(deck)
    } else {
      blank.initial = deck
    }

    session.refresh(blank)
  }

  await showDocument('slides', session, doc)

  if (file) {
    await session.save(doc, { to: file })
  }

  return doc
}

/**
 * Panels mode, from the Hermes window with no Herald Slides window open: the new presentation is
 * made in Herald Slides' own window, which comes up with a blank one; the command runs there and fills it.
 */
async function inSlidesWindow(command: string, args: Args, context: CommandContext): Promise<Outcome> {
  const before = new Set((await openEntries()).filter((entry) => entry.app === 'slides').map((entry) => entry.key))
  const until = Date.now() + 10_000
  openInOffice('slides', { blank: true })

  while (Date.now() < until) {
    await new Promise((done) => setTimeout(done, 150))
    const entry = (await openEntries()).find((candidate) => candidate.app === 'slides' && !before.has(candidate.key))

    if (entry) {
      const result = (await window.heraldOS.office.run({ app: 'slides', key: entry.key }, command, args, context.source)) as CommandResult | undefined

      if (!result?.ok) {
        throw new Error(result?.error ?? result?.summary ?? `Herald Slides did not run ${command}`)
      }

      return { summary: result.summary, data: result.data }
    }
  }

  throw new Error('Herald Slides did not open in time; try again')
}

// Commands.

export async function open(args: Args): Promise<Outcome> {
  if (!text(args.path)) {
    openInOffice('slides')

    return { summary: 'Opened Herald Slides' }
  }

  const file = resolve(text(args.path))

  if (!(await exists(file))) {
    throw new Error(`There is no file at ${file}`)
  }

  if (officeAppFor(file, { libreOffice: false }) !== 'slides') {
    throw new Error(`Herald Slides opens PowerPoint presentations (.pptx), not ${fileName(file)}`)
  }

  if (isPanels) {
    openInOffice('slides', { file })

    return { summary: `Opened ${fileName(file)} in Herald Slides`, data: { path: file } }
  }

  openApp('slides')
  const doc = await session.open(file)
  await showDocument('slides', session, doc)
  const deck = decks.get(doc.key)?.history.present ?? doc.initial

  return {
    summary: `Opened ${doc.name} in Herald Slides: ${count(deck.slides.length, 'slide')}${doc.notes.length ? ` (shown differently: ${doc.notes.join('; ')})` : ''}`,
    data: { name: doc.name, path: doc.path, slides: model.outline(deck).split('\n'), ...(doc.notes.length ? { approximated: doc.notes } : {}) }
  }
}

export async function create(args: Args, context: CommandContext): Promise<Outcome> {
  let file: string | null = null

  if (text(args.path)) {
    file = resolve(text(args.path))
    file = extensionOf(file) ? file : `${file}.pptx`

    if (extensionOf(file) !== '.pptx') {
      throw new Error('A new presentation is saved as .pptx')
    }

    if (await exists(file)) {
      throw new Error(`${fileName(file)} already exists: slides.new never replaces a file (open it with slides.open)`)
    }
  }

  const name = file ? baseName(file) : text(args.name)
  const deck = newDeckWith(name || 'Untitled', { ...(given(args.size) ? { size: sizeOf(args.size) } : {}), ...(given(args.theme) ? { theme: themeOf(args.theme) } : {}), ...(given(args.slides) ? { slides: slideSpecsOf(args.slides) } : {}) })

  if (isPanels && isMainSurface) {
    return inSlidesWindow('slides.new', args, context)
  }

  const doc = await startDeck(deck, name || undefined, file)

  return {
    summary: `Started ${doc.name}, ${count(deck.slides.length, 'slide')}${doc.path ? `, saved as ${where(doc.path)}` : ''}`,
    data: { name: doc.name, path: doc.path, slides: model.outline(deck).split('\n') }
  }
}

export async function list(): Promise<Outcome> {
  const open = (await openEntries()).filter((entry) => entry.app === 'slides')
  const current = open.find((entry) => entry.active) ?? open[0]

  return {
    summary: open.length ? `${count(open.length, 'presentation')} open${current ? `; in front: ${current.name}${current.selection ? ` (${current.selection})` : ''}` : ''}` : 'Nothing is open in Herald Slides',
    data: { presentations: open.map(({ key: _key, app: _app, front: _front, ...entry }) => entry), current: current ? (current.path ?? current.name) : null }
  }
}

export async function read(args: Args): Promise<Outcome> {
  const { name, path, on } = await reading(await located(args.presentation))
  const only = given(args.slide) ? slideIdOf(on.deck, args.slide, on.doc?.slideId) : null
  const result = readDeck(on.deck, only)
  const front = on.doc ? slideNumber(on.deck, on.doc.slideId) : 0

  return {
    summary: `${name}: ${count(result.slideCount, 'slide')}, ${result.size}, ${result.theme} theme${front ? `; slide ${front} is in front` : ''}`,
    data: { name, path, ...result, ...(front ? { front } : {}), ...(on.doc?.selected.length ? { selected: on.doc.selected } : {}), ...(on.notes.length ? { approximated: on.notes } : {}) }
  }
}

export async function find(args: Args): Promise<Outcome> {
  const query = typeof args.text === 'string' ? args.text : ''

  if (!query.trim()) {
    throw new Error('Say what to find (text)')
  }

  const { name, on } = await reading(await located(args.presentation))
  const found = findInDeck(on.deck, query, { caseSensitive: args.caseSensitive === true })
  const slides = [...new Set(found.matches.map((match) => match.slide))]

  return { summary: `${count(found.count, 'match', 'matches')} for “${query}” in ${name}${slides.length ? ` (slide${slides.length === 1 ? '' : 's'} ${slides.join(', ')})` : ''}`, data: { name, ...found } }
}

export const addSlide = async (args: Args): Promise<Outcome> => stepOn(await located(args.presentation), (deck, context) => addSlideStep(deck, args, context))

export const setSlide = async (args: Args): Promise<Outcome> => stepOn(await located(args.presentation), (deck, context) => setSlideStep(deck, args, context))

export const duplicateSlide = async (args: Args): Promise<Outcome> => stepOn(await located(args.presentation), (deck, context) => duplicateSlideStep(deck, args, context))

export const moveSlide = async (args: Args): Promise<Outcome> => stepOn(await located(args.presentation), (deck, context) => moveSlideStep(deck, args, context))

export const removeSlide = async (args: Args): Promise<Outcome> => stepOn(await located(args.presentation), (deck, context) => removeSlideStep(deck, args, context))

export const addText = async (args: Args): Promise<Outcome> => stepOn(await located(args.presentation), (deck, context) => addTextStep(deck, args, context))

export const addShape = async (args: Args): Promise<Outcome> => stepOn(await located(args.presentation), (deck, context) => addShapeStep(deck, args, context))

export const addTable = async (args: Args): Promise<Outcome> => stepOn(await located(args.presentation), (deck, context) => addTableStep(deck, args, context))

export const setTheme = async (args: Args): Promise<Outcome> => stepOn(await located(args.presentation), (deck) => setThemeStep(deck, args))

export const replace = async (args: Args): Promise<Outcome> => stepOn(await located(args.presentation), (deck) => replaceStep(deck, args))

export async function addImage(args: Args): Promise<Outcome> {
  const source = text(args.source)

  if (!source) {
    throw new Error('Say which picture (source: a file path)')
  }

  const found = await located(args.presentation)

  return stepOn(found, (deck, context) => addImageStep(deck, args, context), await picturesFor([source]))
}

/** A batch of edits as one step to undo; pictures are read first, then every edit is made in one go. */
export async function edit(args: Args): Promise<Outcome> {
  const edits = slideEditsOf(args.edits)
  const found = await located(args.presentation)
  const pictures = await picturesFor(edits.filter((entry) => entry.op === 'addImage').map((entry) => text(entry.source)))
  const { step, changed, name, path } = await change(found, (deck, front) => runEdits(deck, edits, { front, pictures }))

  return {
    summary: changed ? `Made ${count(edits.length, 'edit')} to ${name} as one step: ${step.done}` : `Nothing changed in ${name}: ${step.done}`,
    data: { name, path, changed, edits: edits.length, done: step.done }
  }
}

/** A Herald Docs document (open, or a file) as slides: in a new presentation named after it, or added to the end of one. */
export async function fromDocument(args: Args, context: CommandContext): Promise<Outcome> {
  const level = given(args.level) ? headingLevelOf(args.level) : undefined
  const fresh = !text(args.presentation)

  if (fresh && isPanels && isMainSurface) {
    return inSlidesWindow('slides.fromDocument', args, context)
  }

  const { documentJSON } = await import('../docs/agent.ts')
  const source = await documentJSON(args.document)
  const made = slidesFromDocument(source.json, { name: stem(source.name), level, notes: args.notes === true })

  if (fresh) {
    const deck = deckFromSpecs(made.title, made.slides)
    const doc = await startDeck(deck, stem(source.name), null)

    return {
      summary: `Made ${count(deck.slides.length, 'slide')} from ${source.name} in a new presentation, ${doc.name}`,
      data: { name: doc.name, path: doc.path, from: source.path ?? source.name, slides: model.outline(deck).split('\n') }
    }
  }

  const found = await located(args.presentation)
  const result = await change(found, (deck) => {
    const added = addSpecs(deck, made.slides, { asSection: true })

    return { ...added, label: `Slides from ${stem(source.name)}`, done: `added ${count(added.added.length, 'slide')} from ${source.name} at the end`, info: { from: source.path ?? source.name, first: slideNumber(added.deck, added.added[0]), slides: added.added.length } }
  })

  return outcomeOf(result)
}

/** A range of a Herald Sheets workbook (open, or a file) as a table on a slide, as its cells show. */
export async function insertRange(args: Args): Promise<Outcome> {
  const { rangeTable } = await import('../sheets/agent.ts')
  const source = await rangeTable({ workbook: args.workbook, range: args.range, sheet: args.sheet })
  const found = await located(args.presentation)
  const result = await change(found, (deck, front) => {
    const step = addTableStep(deck, { slide: args.slide, x: args.x, y: args.y, width: args.width, cells: source.cells }, { front })

    return { ...step, label: 'Table', done: `put ${source.range} of ${source.name} (${count(source.cells.length, 'row')}) on slide ${String(step.info?.slide)} as a table`, info: { ...step.info, from: { workbook: source.name, sheet: source.sheet, range: source.range } } }
  })

  return outcomeOf(result)
}

export async function save(args: Args): Promise<Outcome> {
  const found = await located(args.presentation)
  let to = text(args.to) ? resolve(text(args.to)) : null
  to = to && !extensionOf(to) ? `${to}.pptx` : to

  if (to && extensionOf(to) !== '.pptx') {
    throw new Error(`Herald Slides saves presentations as .pptx, not ${extensionOf(to)}`)
  }

  if (to && (await exists(to)) && args.overwrite !== true) {
    throw new Error(`${fileName(to)} already exists: pass overwrite=true to replace it`)
  }

  if (found.kind === 'file') {
    if (!to) {
      return { summary: `${fileName(found.path)} is not open, so there is nothing unsaved: changes to it are written as they are made`, data: { path: found.path } }
    }

    // Save as for a file: read, and written again under the new name.
    const { on } = await reading(found)
    const written = await slidesAdapter.write(on.deck, '.pptx', undefined)
    await window.heraldOS.office.write(to, written.bytes)

    return { summary: `Saved ${fileName(found.path)} as ${fileName(to)}${on.notes.length ? ` (as Herald shows it: ${on.notes.join('; ')})` : ''}`, data: { path: to, ...(on.notes.length ? { approximated: on.notes } : {}) } }
  }

  const { doc } = found

  if (!to && !doc.path) {
    throw new Error(`${doc.name} has never been saved: say where, with to=~/Documents/${documentFileName(doc.name, '.pptx')}`)
  }

  const saved = await session.save(doc, to ? { to } : {})

  if (!saved) {
    return { summary: `${doc.name} was not saved: the person kept the file as it was`, data: { name: doc.name, path: doc.path, saved: false } }
  }

  return { summary: `Saved ${doc.name} (${where(doc.path)})`, data: { name: doc.name, path: doc.path, saved: true } }
}

export async function exportPdf(args: Args): Promise<Outcome> {
  const found = await located(args.presentation)
  const name = found.kind === 'file' ? fileName(found.path) : found.doc.name
  let to = text(args.to) ? resolve(text(args.to)) : null
  to = to && !to.toLowerCase().endsWith('.pdf') ? `${to}.pdf` : to

  if (to && (await exists(to)) && args.overwrite !== true) {
    throw new Error(`${fileName(to)} already exists: pass overwrite=true to replace it`)
  }

  const file = to ?? (await freePath(resolve('~/Documents'), `${stem(name)}.pdf`, exists))

  if (found.kind === 'file') {
    const { on } = await reading(found)
    const view = await slidesAdapter.print(on.deck, name)
    await window.heraldOS.office.exportPdf({ html: view.html, suggestedName: name, landscape: view.landscape, path: file })
  } else if (!(await session.exportPdf(found.doc, file))) {
    throw new Error(`Could not export ${name} as a PDF`)
  }

  return { summary: `Exported ${name} as ${where(file)}`, data: { path: file } }
}

export async function step(direction: 'undo' | 'redo', args: Args): Promise<Outcome> {
  const found = await located(args.presentation)

  if (found.kind === 'file') {
    throw new Error(`Undo works in the open Herald Slides window: ${fileName(found.path)} is not open`)
  }

  const { doc } = found
  await withEditor('slides', doc)
  const live = decks.get(doc.key)

  if (!live) {
    throw new Error(`${doc.name} is not showing in Herald Slides`)
  }

  flushTyping(live)
  const wanted = stepCount(args.steps)
  const labels: string[] = []

  while (labels.length < wanted) {
    const label = direction === 'undo' ? live.undo() : live.redo()

    if (!label) {
      break
    }

    labels.push(label)
  }

  if (!labels.length) {
    throw new Error(direction === 'undo' ? `Nothing to undo in ${doc.name}` : `Nothing to redo in ${doc.name}`)
  }

  return {
    summary: `${direction === 'undo' ? 'Undid' : 'Redid'} ${labels.length === 1 ? `“${labels[0]}”` : `${labels.length} steps`} in ${doc.name}`,
    data: { name: doc.name, steps: labels.length, labels, more: direction === 'undo' ? live.history.canUndo : live.history.canRedo }
  }
}
