import { redoDepth, undoDepth } from '@tiptap/pm/history'
import type { EditorState } from '@tiptap/pm/state'
import { documentFromMarkdown } from '../../../../shared/office/doc-text.ts'
import { blankDocument, type DocJSON, type DocNode, IMAGE_TYPES } from '../../../../shared/office/document.ts'
import { baseName, extensionOf, officeAppFor } from '../../../../shared/office/files.ts'
import { isPanels } from '../../../store/shell.ts'
import { openApp } from '../../../store/windows.ts'
import { exists, homeDir, type Local, locate, openEntries, type Outcome, resolve, showDocument, withEditor } from '../agent.ts'
import { documentFileName, freePath, stepCount, tildePath } from '../agent-model.ts'
import { openInOffice } from '../open.ts'
import { docsAdapter } from './adapter.ts'
import { alignmentOf, cellsOf, chain, chainBuilt, editsOf, findWithContext, type Marked, markChangeOf, pageArgsOf, placeFor, readDocument, readOptions, searchOptions, styleOf, targetFor, templateOf } from './agent-model.ts'
import { pictureFrom } from './editor.ts'
import { markedRangeOf } from './marked.ts'
import { applyLive, applyToJSON, clearFormatting, insert, insertImage, insertPageBreak, insertTable, jsonOf, type Op, replaceText, setAlignment, setLineSpacing, setMarks, setPage, setStyle, stateOf, textWidthOf } from './model.ts'
import { docsSession as session, editorOf } from './store.ts'

/*
 * What Hermes (and voice, the command bar and `herald-os docs`) does in Herald Docs. A command
 * works on the document it names or the one in front. Open in a window, each change is one step to
 * undo there and saves the way the person's own edits do; a file that is not open is read, changed
 * and written back, unless writing it would lose something Herald cannot keep (then it has to be
 * opened, so the fidelity report comes first). Main backs a file up before Herald first writes over it.
 */

type Args = Record<string, unknown>

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const where = (file: string | null): string => (file ? tildePath(file, homeDir()) : 'not saved yet')

async function located(ref: unknown): Promise<Local<DocJSON>> {
  const found = await locate('docs', session, ref)

  if (found.kind === 'remote') {
    throw new Error(`${found.entry.name} is open in another Herald Docs window: ask there`)
  }

  return found
}

interface Reading {
  name: string
  path: string | null
  state: EditorState
  /** The live editor's state, which has a selection (null for a file). */
  live: boolean
  marked: Marked | null
}

async function readFile(file: string) {
  const data = await window.heraldOS.office.read(file)

  return docsAdapter.read(data.bytes, extensionOf(file), baseName(file))
}

async function reading(target: Local<DocJSON>): Promise<Reading> {
  if (target.kind === 'file') {
    return { name: baseName(target.path), path: target.path, state: stateOf((await readFile(target.path)).model), live: false, marked: null }
  }

  // Reading leaves a closed window closed: without an editor, the document as it was last held.
  const { doc } = target
  const editor = editorOf(doc.key)
  const state = editor?.state ?? stateOf(doc.editor?.snapshot() ?? doc.initial)

  return { name: doc.name, path: doc.path, state, live: Boolean(editor), marked: editor ? markedRangeOf(editor.state) : null }
}

/**
 * Make one change: built from the document as it is (and the text marked for Hermes), it is one step
 * to undo in an open document, or the file written back.
 */
async function change(target: Local<DocJSON>, build: (state: EditorState, marked: Marked | null, live: boolean) => Op): Promise<{ changed: boolean; name: string; path: string | null }> {
  if (target.kind === 'file') {
    const file = target.path
    const read = await readFile(file)

    if (read.notes.length) {
      throw new Error(`${baseName(file)} has things Herald Docs shows differently (${read.notes[0].replace(/\.$/, '')}${read.notes.length > 1 ? `, and ${read.notes.length - 1} more` : ''}): open it in Herald Docs to change it (docs.open)`)
    }

    const state = stateOf(read.model)
    const tr = build(state, null, false)(state)

    if (!tr || !tr.steps.length) {
      return { changed: false, name: baseName(file), path: file }
    }

    const written = await docsAdapter.write(jsonOf(tr.doc), extensionOf(file), read.layout)

    if (written.losses.length) {
      throw new Error(`Saving ${baseName(file)} would lose something (${written.losses[0].replace(/\.$/, '')}): open it in Herald Docs to change it (docs.open)`)
    }

    await window.heraldOS.office.write(file, written.bytes)

    return { changed: true, name: baseName(file), path: file }
  }

  const { doc } = target
  await withEditor('docs', doc)
  const editor = editorOf(doc.key)

  if (editor) {
    return { changed: applyLive(editor.view, build(editor.state, markedRangeOf(editor.state), true)), name: doc.name, path: doc.path }
  }

  // Its window would not show it: the change goes into what the document holds, like a typed edit.
  const before = doc.editor?.snapshot() ?? doc.initial
  const after = applyToJSON(before, build(stateOf(before), null, false))

  if (after) {
    doc.initial = after
    session.changed(doc)
  }

  return { changed: Boolean(after), name: doc.name, path: doc.path }
}

// Content.

const isRemote = (src: string): boolean => /^https?:/i.test(src)

/** A picture from a file (or a data URL) as the document holds it, at most `maxWidth` wide. */
async function picture(source: string, maxWidth: number): Promise<{ src: string; width: number; height: number }> {
  if (source.startsWith('data:')) {
    const match = /^data:([^;,]+)[;,]/.exec(source)
    const bytes = Uint8Array.from(atob(source.slice(source.indexOf(',') + 1)), (char) => char.charCodeAt(0))
    const found = pictureFrom(bytes, match?.[1] ?? '', maxWidth)

    if (!found) {
      throw new Error('That picture is not one Herald Docs shows (PNG, JPEG, GIF, WebP, BMP or SVG)')
    }

    return found
  }

  if (isRemote(source)) {
    throw new Error(`Herald Docs puts in pictures from files: save ${source} first and give its path`)
  }

  const file = resolve(source.replace(/^file:\/\//, ''))
  const mime = IMAGE_TYPES[/\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase() ?? ''] ?? ''
  const found = pictureFrom((await window.heraldOS.office.read(file)).bytes, mime, maxWidth)

  if (!found) {
    throw new Error(`${baseName(file)} is not a picture Herald Docs shows (PNG, JPEG, GIF, WebP, BMP or SVG)`)
  }

  return found
}

/** Markdown as blocks, with the pictures it names from files read in. */
async function markdownBlocks(markdown: string, maxWidth: number): Promise<DocNode[]> {
  const blocks = documentFromMarkdown(markdown).document.content ?? []
  const images: DocNode[] = []
  const visit = (node: DocNode) => {
    if (node.type === 'image' && typeof node.attrs?.src === 'string' && !node.attrs.src.startsWith('data:')) {
      images.push(node)
    }

    node.content?.forEach(visit)
  }
  blocks.forEach(visit)

  for (const image of images) {
    const found = await picture(String(image.attrs!.src), maxWidth)
    image.attrs = { ...image.attrs, src: found.src, width: found.width, height: found.height }
  }

  return blocks
}

const TEXT_WIDTH = 624

/** What a write puts in: Markdown (the default) or plain text. */
async function contentOf(args: Args, maxWidth = TEXT_WIDTH): Promise<{ blocks: DocNode[] } | { text: string }> {
  const content = typeof args.content === 'string' ? args.content : ''
  const format = text(args.format).toLowerCase() || 'markdown'

  if (format !== 'markdown' && format !== 'text') {
    throw new Error(`format is markdown or text, not “${format}”`)
  }

  return format === 'text' ? { text: content } : { blocks: await markdownBlocks(content, maxWidth) }
}

const wordsIn = (value: string): number => value.split(/\s+/).filter(Boolean).length

const placeLabel = (args: Args): string => {
  const at = text(args.at).toLowerCase()

  if (args.heading !== undefined && args.heading !== '' && (!at || at === 'heading')) {
    const mode = text(args.mode).toLowerCase()

    return mode === 'replace' ? `in place of what was under “${String(args.heading)}”` : mode === 'prepend' ? `under “${String(args.heading)}”` : `at the end of “${String(args.heading)}”`
  }

  return ({ start: 'at the start', selection: 'at the selection', marked: 'in place of the marked text', after: 'after the selection' } as Record<string, string>)[at] ?? 'at the end'
}

// Commands.

export async function open(args: Args): Promise<Outcome> {
  if (!text(args.path)) {
    openInOffice('docs')

    return { summary: 'Opened Herald Docs' }
  }

  const file = resolve(text(args.path))

  if (!(await exists(file))) {
    throw new Error(`There is no file at ${file}`)
  }

  if (officeAppFor(file, { libreOffice: false }) !== 'docs') {
    throw new Error(`Herald Docs opens Word documents (.docx), Markdown and text files, not ${baseName(file)}`)
  }

  if (isPanels) {
    openInOffice('docs', { file })

    return { summary: `Opened ${baseName(file)} in Herald Docs`, data: { path: file } }
  }

  openApp('docs')
  const doc = await session.open(file)
  await showDocument('docs', session, doc)
  const read = readDocument((editorOf(doc.key)?.state ?? stateOf(doc.initial)).doc, { part: 'outline', maxChars: 0 })

  return {
    summary: `Opened ${doc.name} in Herald Docs${doc.notes.length ? ` (shown differently: ${doc.notes.join('; ')})` : ''}`,
    data: { name: doc.name, path: doc.path, words: read.words, outline: read.outline.slice(0, 40), ...(doc.notes.length ? { notes: doc.notes } : {}) }
  }
}

export async function create(args: Args): Promise<Outcome> {
  const template = args.template !== undefined && args.template !== '' ? templateOf(args.template) : null
  const content = typeof args.content === 'string' && args.content.trim() ? args.content : (template?.markdown ?? '')
  let file: string | null = null

  if (text(args.path)) {
    file = resolve(text(args.path))
    file = extensionOf(file) ? file : `${file}.docx`

    if (!['.docx', '.md', '.txt'].includes(extensionOf(file))) {
      throw new Error('A new document is saved as .docx, .md or .txt')
    }

    if (await exists(file)) {
      throw new Error(`${baseName(file)} already exists: docs.new never replaces a file (open it with docs.open)`)
    }
  }

  const model: DocJSON = content ? { ...blankDocument(), content: await markdownBlocks(content, TEXT_WIDTH) } : blankDocument()
  const name = file ? baseName(file) : text(args.name) || template?.label

  if (isPanels) {
    openInOffice('docs', { blank: true })

    return { summary: 'Started a new document in Herald Docs; write into it with docs.write', data: { name: name ?? 'Untitled' } }
  }

  const doc = session.create({ name, model })
  await showDocument('docs', session, doc)

  if (file) {
    await session.save(doc, { to: file })
  }

  return { summary: `Started ${doc.name}${doc.path ? ` (saved as ${where(doc.path)})` : ''}${template ? ` from the ${template.label.toLowerCase()} template` : ''}`, data: { name: doc.name, path: doc.path } }
}

export async function list(): Promise<Outcome> {
  const docs = (await openEntries()).filter((entry) => entry.app === 'docs')
  const current = docs.find((entry) => entry.active) ?? docs[0]

  return {
    summary: docs.length ? `${docs.length} document${docs.length === 1 ? '' : 's'} open${current ? `; in front: ${current.name}` : ''}` : 'Nothing is open in Herald Docs',
    data: { documents: docs.map(({ key: _key, app: _app, front: _front, ...entry }) => entry), current: current ? (current.path ?? current.name) : null }
  }
}

export async function read(args: Args): Promise<Outcome> {
  const options = readOptions(args)
  const target = await located(args.document)
  const { name, path, state, live, marked } = await reading(target)
  const result = readDocument(state.doc, options)
  const selected = live && state.selection.to > state.selection.from ? state.doc.textBetween(state.selection.from, state.selection.to, '\n', ' ') : null
  const markedText = marked && marked.to > marked.from ? state.doc.textBetween(marked.from, marked.to, '\n', ' ') : null

  if (options.part === 'selection' && !live) {
    throw new Error('Only a document open in Herald Docs has a selection: open it first (docs.open)')
  }

  return {
    summary: `${name}: ${result.words.toLocaleString('en-US')} words, ${result.outline.length} heading${result.outline.length === 1 ? '' : 's'}${result.truncated ? ` (the first ${options.maxChars.toLocaleString('en-US')} characters; read a section with heading)` : ''}`,
    data: { name, path, ...result, ...(selected !== null ? { selection: selected } : {}), ...(markedText !== null ? { marked: markedText } : {}) }
  }
}

/** A document's content as it is now (open, or a file), for work elsewhere: a deck from its headings. */
export async function documentJSON(ref: unknown): Promise<{ name: string; path: string | null; json: DocJSON }> {
  const { name, path, state } = await reading(await located(ref))

  return { name, path, json: jsonOf(state.doc) }
}

export async function find(args: Args): Promise<Outcome> {
  const query = text(args.text)

  if (!query) {
    throw new Error('Say what to find (text)')
  }

  const { name, state } = await reading(await located(args.document))
  const found = findWithContext(state.doc, query, searchOptions(args))

  return { summary: `${found.count} match${found.count === 1 ? '' : 'es'} for “${query}” in ${name}`, data: { name, ...found } }
}

/** Content is read (and pictures loaded) before the change is built, so the step is built on the document as it is then. */
async function prepared(args: Args, target: Local<DocJSON>): Promise<{ blocks: DocNode[] } | { text: string }> {
  const { state } = await reading(target)

  return contentOf(args, textWidthOf(state.doc))
}

export async function write(args: Args): Promise<Outcome> {
  if (typeof args.content !== 'string') {
    throw new Error('Say what to write (content, in Markdown)')
  }

  const target = await located(args.document)
  const content = await prepared(args, target)
  const result = await change(target, (state, marked, live) => insert(content, placeFor(live ? state : null, args, marked)))

  return {
    summary: result.changed ? `Wrote ${wordsIn(args.content).toLocaleString('en-US')} words ${placeLabel(args)} of ${result.name}` : `Nothing changed in ${result.name}`,
    data: { name: result.name, path: result.path, changed: result.changed }
  }
}

export async function replace(args: Args): Promise<Outcome> {
  const query = typeof args.find === 'string' ? args.find : ''

  if (!query) {
    throw new Error('Say what to replace (find)')
  }

  const replacement = typeof args.replacement === 'string' ? args.replacement : ''
  const options = { ...searchOptions(args), all: args.all !== false }
  const target = await located(args.document)
  const before = findWithContext((await reading(target)).state.doc, query, options, 0).count
  const result = await change(target, () => replaceText(query, replacement, options))
  const count = result.changed ? (options.all ? before : 1) : 0

  return { summary: count ? `Replaced ${count} match${count === 1 ? '' : 'es'} of “${query}” in ${result.name}` : `“${query}” is not in ${result.name}`, data: { name: result.name, path: result.path, replaced: count } }
}

/** The operations a format request makes, in order. */
function formatOps(args: Args, state: EditorState, marked: Marked | null, live: boolean): Op[] {
  const target = targetFor(live ? state : null, args, marked)
  const ops: Op[] = []

  if (args.clear === true) {
    ops.push(clearFormatting(target))
  }

  if (args.style !== undefined && args.style !== '') {
    ops.push(setStyle(styleOf(args.style), target))
  }

  const marks = markChangeOf(args)

  if (Object.keys(marks).length) {
    ops.push(setMarks(marks, target))
  }

  if (args.align !== undefined && args.align !== '') {
    ops.push(setAlignment(alignmentOf(args.align), target))
  }

  if (args.lineSpacing !== undefined && args.lineSpacing !== '') {
    const spacing = Number(args.lineSpacing)

    if (!Number.isFinite(spacing) || spacing < 0.5 || spacing > 5) {
      throw new Error('lineSpacing is a multiple of the line, from 0.5 to 5 (1.15, 1.5, 2)')
    }

    ops.push(setLineSpacing(spacing, target))
  }

  if (!ops.length) {
    throw new Error('Say what to change: style, bold, italic, underline, strike, color, highlight, font, size, link, align, lineSpacing or clear')
  }

  return ops
}

export async function format(args: Args): Promise<Outcome> {
  const target = await located(args.document)
  const result = await change(target, (state, marked, live) => chain(formatOps(args, state, marked, live)))

  return { summary: result.changed ? `Formatted ${result.name}` : `Nothing changed in ${result.name}: it already looks that way`, data: { name: result.name, path: result.path, changed: result.changed } }
}

function tableOp(args: Args, state: EditorState, marked: Marked | null, live: boolean): Op {
  const cells = args.cells !== undefined && args.cells !== '' ? cellsOf(args.cells) : undefined
  const rows = cells ? cells.length : Math.round(Number(args.rows))
  const cols = cells ? Math.max(...cells.map((row) => row.length)) : Math.round(Number(args.cols))

  if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows < 1 || cols < 1) {
    throw new Error('Give the table its cells (rows of text), or rows and cols')
  }

  return insertTable({ rows, cols, cells, header: args.header !== false }, placeFor(live ? state : null, args, marked))
}

export async function table(args: Args): Promise<Outcome> {
  const target = await located(args.document)
  const result = await change(target, (state, marked, live) => tableOp(args, state, marked, live))

  return { summary: result.changed ? `Put a table ${placeLabel(args)} of ${result.name}` : `Nothing changed in ${result.name}`, data: { name: result.name, path: result.path, changed: result.changed } }
}

export async function image(args: Args): Promise<Outcome> {
  const source = text(args.source)

  if (!source) {
    throw new Error('Say which picture (source: a file path)')
  }

  const target = await located(args.document)
  const { state } = await reading(target)
  const maxWidth = Math.min(textWidthOf(state.doc), args.width !== undefined && args.width !== '' ? Math.max(16, Number(args.width)) : Number.POSITIVE_INFINITY)
  const found = await picture(source, maxWidth)
  const result = await change(target, (current, marked, live) => insertImage({ ...found, alt: text(args.alt) || undefined }, placeFor(live ? current : null, args, marked)))

  return { summary: result.changed ? `Put the picture ${placeLabel(args)} of ${result.name}` : `Nothing changed in ${result.name}`, data: { name: result.name, path: result.path, width: found.width, height: found.height } }
}

export async function page(args: Args): Promise<Outcome> {
  const change_ = pageArgsOf(args)

  if (!Object.keys(change_).length) {
    throw new Error('Say what to change: size (a4 or letter), orientation (portrait or landscape) or margins (points, or "1in", "20mm")')
  }

  const result = await change(await located(args.document), () => setPage(change_))

  return { summary: result.changed ? `Set up the page of ${result.name}` : `${result.name} already has that page setup`, data: { name: result.name, path: result.path, ...change_ } }
}

/** A batch of edits as one step to undo: write, replace, format, table, image, pageBreak and page. */
export async function edit(args: Args): Promise<Outcome> {
  const edits = editsOf(args.edits)
  const target = await located(args.document)
  const { state: first } = await reading(target)
  // Content and pictures are read before the change, which is then built in one go.
  const contents = await Promise.all(edits.map((entry) => (entry.op === 'write' ? contentOf(entry, textWidthOf(first.doc)) : null)))
  const pictures = await Promise.all(edits.map((entry) => (entry.op === 'image' ? picture(text(entry.source), textWidthOf(first.doc)) : null)))
  const result = await change(target, (_state, _marked, live) =>
    chainBuilt(
      edits.map((entry, index) => (state: EditorState) => {
        const marked = markedRangeOf(state)

        switch (entry.op) {
          case 'write':
            return insert(contents[index]!, placeFor(live ? state : null, entry, marked))
          case 'replace':
            return replaceText(String(entry.find ?? ''), typeof entry.replacement === 'string' ? entry.replacement : '', { ...searchOptions(entry), all: entry.all !== false })
          case 'format':
            return chain(formatOps(entry, state, marked, live))
          case 'table':
            return tableOp(entry, state, marked, live)
          case 'image':
            return insertImage({ ...pictures[index]!, alt: text(entry.alt) || undefined }, placeFor(live ? state : null, entry, marked))
          case 'pageBreak':
            return insertPageBreak(placeFor(live ? state : null, { at: 'end', ...entry }, marked))
          default:
            return setPage(pageArgsOf(entry))
        }
      })
    )
  )

  return { summary: result.changed ? `Made ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${result.name} as one step` : `Nothing changed in ${result.name}`, data: { name: result.name, path: result.path, edits: edits.length, changed: result.changed } }
}

/** A range of a workbook (open, or a file) as a table in the document: the cells as they show. */
export async function insertRange(args: Args): Promise<Outcome> {
  const { rangeTable } = await import('../sheets/agent.ts')
  const source = await rangeTable({ workbook: args.workbook, range: args.range, sheet: args.sheet })
  const target = await located(args.document)
  const result = await change(target, (state, marked, live) => insertTable({ rows: source.cells.length, cols: Math.max(...source.cells.map((row) => row.length)), cells: source.cells, header: args.header !== false }, placeFor(live ? state : null, args, marked)))

  return {
    summary: result.changed ? `Put ${source.range} of ${source.name} (${source.cells.length} rows) ${placeLabel(args)} of ${result.name} as a table` : `Nothing changed in ${result.name}`,
    data: { name: result.name, path: result.path, from: { workbook: source.name, sheet: source.sheet, range: source.range }, rows: source.cells.length }
  }
}

export async function save(args: Args): Promise<Outcome> {
  const target = await located(args.document)
  const to = text(args.to) ? resolve(text(args.to)) : null

  if (to && (await exists(to)) && args.overwrite !== true) {
    throw new Error(`${baseName(to)} already exists: pass overwrite=true to replace it`)
  }

  if (target.kind === 'file') {
    if (!to) {
      return { summary: `${baseName(target.path)} is not open, so there is nothing unsaved: changes to it are written as they are made`, data: { path: target.path } }
    }

    // Save as for a file: read in its format, written in the new one.
    const read = await readFile(target.path)
    const written = await docsAdapter.write(read.model, extensionOf(to), extensionOf(to) === extensionOf(target.path) ? read.layout : undefined)
    await window.heraldOS.office.write(to, written.bytes)

    return { summary: `Saved ${baseName(target.path)} as ${baseName(to)}${written.losses.length ? ` (it cannot keep: ${written.losses.join('; ')})` : ''}`, data: { path: to, ...(written.losses.length ? { losses: written.losses } : {}) } }
  }

  const { doc } = target

  if (!to && !doc.path) {
    throw new Error(`${doc.name} has never been saved: say where, with to=~/Documents/${documentFileName(doc.name, '.docx')}`)
  }

  const saved = await session.save(doc, to ? { to } : {})

  if (!saved) {
    return { summary: `${doc.name} was not saved: the person kept the file as it was`, data: { name: doc.name, path: doc.path, saved: false } }
  }

  return { summary: `Saved ${doc.name} (${where(doc.path)})`, data: { name: doc.name, path: doc.path, saved: true } }
}

export async function exportPdf(args: Args): Promise<Outcome> {
  const target = await located(args.document)
  const { name } = target.kind === 'file' ? { name: baseName(target.path) } : target.doc
  const stem = name.replace(/\.[a-z0-9]{1,5}$/i, '')
  let to = text(args.to) ? resolve(text(args.to)) : null
  to = to && !to.toLowerCase().endsWith('.pdf') ? `${to}.pdf` : to

  if (to && (await exists(to)) && args.overwrite !== true) {
    throw new Error(`${baseName(to)} already exists: pass overwrite=true to replace it`)
  }

  const file = to ?? (await freePath(resolve('~/Documents'), `${stem}.pdf`, exists))

  if (target.kind === 'file') {
    const view = await docsAdapter.print((await readFile(target.path)).model, name)
    await window.heraldOS.office.exportPdf({ html: view.html, suggestedName: name, landscape: view.landscape, path: file })
  } else if (!(await session.exportPdf(target.doc, file))) {
    throw new Error(`Could not export ${name} as a PDF`)
  }

  return { summary: `Exported ${name} as ${where(file)}`, data: { path: file } }
}

export async function step(direction: 'undo' | 'redo', args: Args): Promise<Outcome> {
  const target = await located(args.document)

  if (target.kind === 'file') {
    throw new Error(`Undo works in the open Herald Docs window: ${baseName(target.path)} is not open`)
  }

  const { doc } = target
  await withEditor('docs', doc)
  const editor = editorOf(doc.key)

  if (!editor) {
    throw new Error(`${doc.name} is not showing in Herald Docs`)
  }

  const wanted = stepCount(args.steps)
  const depth = direction === 'undo' ? undoDepth(editor.state) : redoDepth(editor.state)
  const count = Math.min(wanted, depth)

  if (!count) {
    throw new Error(direction === 'undo' ? `Nothing to undo in ${doc.name}` : `Nothing to redo in ${doc.name}`)
  }

  for (let n = 0; n < count; n++) {
    if (direction === 'undo') {
      editor.commands.undo()
    } else {
      editor.commands.redo()
    }
  }

  return { summary: `${direction === 'undo' ? 'Undid' : 'Redid'} ${count === 1 ? 'a step' : `${count} steps`} in ${doc.name}`, data: { name: doc.name, steps: count, left: direction === 'undo' ? undoDepth(editor.state) : redoDepth(editor.state) } }
}
