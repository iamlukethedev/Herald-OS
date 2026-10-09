import type { OfficeApp } from '../../../../shared/office/files.ts'
import type { OfficeCommand, OfficeMenu } from '../shell/commands.ts'
import { $hermesState, askHermes, askOf, draftAsk } from './ask.ts'
import type { CleanKind, DocsAction, HermesAction, SheetsAction, SlidesAction } from './prompts.ts'

/*
 * The inline actions: Hermes rewrites, shortens, translates or summarises the selection in Herald
 * Docs; explains a formula, fills a column from its examples or cleans data in Herald Sheets; writes
 * speaker notes or picks a layout in Herald Slides. Each goes through the Ask Hermes bar with a
 * prompt that names the one call landing the change as a step to undo. A window gives what only it
 * reads cheaply: the document in front and what is selected in it.
 */

export const TONES = ['Professional', 'Friendly', 'Confident', 'Casual'] as const

export const LANGUAGES = ['Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Japanese', 'Chinese'] as const

export const CLEANINGS: readonly { clean: CleanKind; label: string }[] = [
  { clean: 'dedupe', label: 'Remove duplicate rows' },
  { clean: 'dates', label: 'Fix dates' },
  { clean: 'split', label: 'Split column' },
  { clean: 'trim', label: 'Trim spaces' },
  { clean: 'numbers', label: 'Numbers stored as text' }
]

/** What the bar shows of an action while Hermes works on it, and above its reply. */
export function actionName(action: HermesAction): string {
  switch (action.id) {
    case 'rewrite':
      return 'Rewrite'
    case 'shorten':
      return 'Shorten'
    case 'expand':
      return 'Expand'
    case 'tone':
      return `Change tone: ${action.tone}`
    case 'translate':
      return `Translate into ${action.language}`
    case 'fix':
      return 'Fix spelling and grammar'
    case 'summarise':
      return 'Summarise'
    case 'explain':
      return 'Explain this formula'
    case 'fill':
      return 'Fill from examples'
    case 'clean':
      return CLEANINGS.find((entry) => entry.clean === action.clean)?.label ?? 'Clean data'
    case 'insights':
      return 'What stands out in this sheet?'
    case 'notes':
      return 'Write speaker notes'
    case 'layout':
      return 'Suggest a layout'
  }
}

/** Whether an action can start on a document now: Hermes is reachable and not working on it already. */
const free = (docKey: string | null): docKey is string => Boolean(docKey) && $hermesState.get() === 'ready' && askOf(docKey!).phase !== 'working'

function runAction(app: OfficeApp, docKey: string | null, action: HermesAction): void {
  if (free(docKey)) {
    void askHermes({ app, docKey, words: actionName(action), action, mark: app === 'docs' })
  }
}

export interface DocsSource {
  /** The document in front, while its editor is on screen. */
  docKey: () => string | null
  hasSelection: () => boolean
}

/** Herald Docs' way to the bar and actions on the selection, for the Hermes menu and the selection bubble. */
export function docsActions(source: DocsSource): OfficeCommand[] {
  const enabled = () => free(source.docKey()) && source.hasSelection()
  const action = (id: string, label: string, chosen: DocsAction, extra: Partial<OfficeCommand> = {}): OfficeCommand => ({ id: `hermes-${id}`, label, enabled, run: () => runAction('docs', source.docKey(), chosen), ...extra })

  return [
    { id: 'hermes-ask', label: 'Ask Hermes…', enabled: () => Boolean(source.docKey()), run: () => draftAsk('docs') },
    action('rewrite', 'Rewrite', { id: 'rewrite' }, { dividerBefore: true }),
    action('shorten', 'Shorten', { id: 'shorten' }),
    action('expand', 'Expand', { id: 'expand' }),
    { id: 'hermes-tone', label: 'Change Tone', enabled, run: () => {}, submenu: TONES.map((tone) => action(`tone-${tone.toLowerCase()}`, tone, { id: 'tone', tone })) },
    {
      id: 'hermes-translate',
      label: 'Translate',
      enabled,
      run: () => {},
      submenu: [
        ...LANGUAGES.map((language) => action(`translate-${language.toLowerCase()}`, language, { id: 'translate', language })),
        { id: 'hermes-translate-other', label: 'Other Language…', enabled, dividerBefore: true, run: () => draftAsk('docs', 'Translate the selection into ') }
      ]
    },
    action('fix', 'Fix Spelling and Grammar', { id: 'fix' }),
    action('summarise', 'Summarise', { id: 'summarise' }, { dividerBefore: true })
  ]
}

/** Herald Docs' Hermes menu. */
export function docsHermesMenu(source: DocsSource): OfficeMenu {
  return { id: 'hermes', label: 'Hermes', items: docsActions(source) }
}

export interface SheetsSource {
  /** The workbook in front, while its sheet is on screen. */
  docKey: () => string | null
  /** The active cell, "D2", and its formula. */
  cell: () => { cell: string; formula: string | null } | null
}

/** Herald Sheets' Hermes menu: the bar, and the actions on the selection or the active cell. */
export function sheetsHermesMenu(source: SheetsSource): OfficeMenu {
  const enabled = () => free(source.docKey())
  const action = (id: string, label: string, chosen: SheetsAction, extra: Partial<OfficeCommand> = {}): OfficeCommand => ({ id: `hermes-${id}`, label, enabled, run: () => runAction('sheets', source.docKey(), chosen), ...extra })

  return {
    id: 'hermes',
    label: 'Hermes',
    items: [
      { id: 'hermes-ask', label: 'Ask Hermes…', enabled: () => Boolean(source.docKey()), run: () => draftAsk('sheets') },
      { id: 'hermes-formula', label: 'Formula from a description…', enabled, dividerBefore: true, run: () => draftAsk('sheets', `Write a formula in ${source.cell()?.cell ?? 'the active cell'} that `) },
      action('explain', 'Explain this formula', { id: 'explain' }, { enabled: () => enabled() && Boolean(source.cell()?.formula) }),
      action('fill', 'Fill from examples', { id: 'fill' }),
      { id: 'hermes-clean', label: 'Clean data', enabled, run: () => {}, submenu: CLEANINGS.map(({ clean, label }) => action(`clean-${clean}`, label, { id: 'clean', clean })) },
      action('insights', 'What stands out in this sheet?', { id: 'insights' }, { dividerBefore: true })
    ]
  }
}

/** Herald Slides' Hermes menu, for its window to add: the bar, the actions on the slide in front, and decks made from a topic, a document or cells. */
export function slidesHermesMenu(source: { docKey: () => string | null }): OfficeMenu {
  const enabled = () => free(source.docKey())
  const action = (id: string, label: string, chosen: SlidesAction): OfficeCommand => ({ id: `hermes-${id}`, label, enabled, run: () => runAction('slides', source.docKey(), chosen) })

  return {
    id: 'hermes',
    label: 'Hermes',
    items: [
      { id: 'hermes-ask', label: 'Ask Hermes…', enabled: () => Boolean(source.docKey()), run: () => draftAsk('slides') },
      { ...action('notes', 'Write Speaker Notes', { id: 'notes' }), dividerBefore: true },
      action('layout', 'Suggest a Layout', { id: 'layout' }),
      { id: 'hermes-from-topic', label: 'Slides from a Topic…', enabled, dividerBefore: true, run: () => draftAsk('slides', 'Make slides about ') },
      { id: 'hermes-from-document', label: 'Slides from a Document…', enabled, run: () => draftAsk('slides', 'Make slides from the document ') },
      { id: 'hermes-from-cells', label: 'Slide from Selected Cells', enabled, run: () => draftAsk('slides', 'Put the cells selected in Herald Sheets on a new slide') }
    ]
  }
}
