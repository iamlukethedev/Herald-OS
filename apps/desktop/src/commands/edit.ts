import type { KeyModifier } from '../../shared/ipc.ts'
import { parseDictationText, withLeadingSpace } from '../lib/voice/dictation.ts'
import { charBeforeCaret, NoEditTargetError, performEdit, scrollFront } from '../store/edit-target.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'

/*
 * Typing and editing: what the keyboard does, by voice or by Hermes. Everything lands on the focused
 * text field, the terminal, or the web page in front (see store/edit-target.ts).
 */

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const WORD_MOD: KeyModifier = isMac ? 'alt' : 'control'
const LINE_MOD: KeyModifier = isMac ? 'meta' : 'control'

async function edit(run: () => Promise<{ target: string }>, done: (target: string) => string) {
  try {
    const { target } = await run()

    // The caption says exactly what happened; the voice just confirms.
    return ok(done(target), { spoken: 'Done.' })
  } catch (error) {
    return fail(error instanceof NoEditTargetError ? error.message : error instanceof Error ? error.message : String(error))
  }
}

/** The Herald Docs page, Sheets cell or Slides text box in front takes the words itself (one step to undo); null leaves them to the focused field. */
async function typeInOffice(text: string, submit: boolean): Promise<string | null> {
  try {
    const { typeIntoOffice } = await import('../features/office/typing.ts')

    return await typeIntoOffice(text, { submit })
  } catch {
    return null
  }
}

const KEY_ALIASES: Record<string, { key: string; modifiers?: KeyModifier[] }> = {
  enter: { key: 'enter' },
  return: { key: 'enter' },
  tab: { key: 'tab' },
  escape: { key: 'escape' },
  esc: { key: 'escape' },
  backspace: { key: 'backspace' },
  delete: { key: 'backspace' },
  space: { key: 'space' },
  'space bar': { key: 'space' },
  up: { key: 'up' },
  'up arrow': { key: 'up' },
  down: { key: 'down' },
  'down arrow': { key: 'down' },
  left: { key: 'left' },
  'left arrow': { key: 'left' },
  right: { key: 'right' },
  'right arrow': { key: 'right' },
  home: { key: 'home' },
  end: { key: 'end' },
  'page up': { key: 'pageup' },
  'page down': { key: 'pagedown' },
  'control c': { key: 'c', modifiers: ['control'] },
  'control d': { key: 'd', modifiers: ['control'] },
  'control l': { key: 'l', modifiers: ['control'] }
}

export const KEY_NAMES: readonly string[] = Object.keys(KEY_ALIASES)

export const editCommands: readonly OsCommand[] = [
  {
    id: 'text.type',
    title: 'Type text',
    description: 'Type text into the focused field, the terminal or the web page; with Herald Docs, Sheets or Slides in front, at the caret, into the active cell (then down the column) or into the text box being edited. Say "comma", "question mark", "new line" for punctuation; end with "and press enter" to submit.',
    tier: 'mutate',
    args: [
      { name: 'text', type: 'string', description: 'What to type', required: true },
      { name: 'submit', type: 'boolean', description: 'Press Enter afterwards' }
    ],
    phrases: ['type {text}', 'dictate {text}', 'type in {text}', 'write down {text}'],
    run: async ({ text, submit }) => {
      const parsed = parseDictationText(String(text))
      const pressEnter = Boolean(submit) || parsed.submit
      const office = await typeInOffice(parsed.text, pressEnter)

      if (office) {
        return ok(office, { spoken: 'Done.' })
      }

      const insert = withLeadingSpace(charBeforeCaret(), parsed.text)

      return edit(
        async () => {
          const result = parsed.text ? await performEdit({ kind: 'insert', text: insert }, { needsField: true }) : { target: '' }

          if (pressEnter) {
            return performEdit({ kind: 'key', key: 'enter' }, { needsField: true })
          }

          return result
        },
        target => `Typed "${parsed.text.slice(0, 60)}"${pressEnter ? ' and pressed Enter' : ''} in ${target}`
      )
    }
  },
  {
    id: 'key.press',
    title: 'Press a key',
    description: 'Press Enter, Tab, Escape, Backspace, an arrow key, Page Up/Down, Home/End, or Control-C/D/L.',
    tier: 'mutate',
    args: [{ name: 'key', type: 'string', description: 'Key name (enter, tab, escape, backspace, up, down, left, right, page down, control c, …)', required: true }],
    phrases: ['press {key}', 'hit {key}', 'press the {key} key', 'hit the {key} key', { phrase: 'send it', args: { key: 'enter' } }, { phrase: 'submit', args: { key: 'enter' } }, { phrase: 'press enter', args: { key: 'enter' } }],
    run: ({ key }) => {
      const alias = KEY_ALIASES[String(key).toLowerCase().replace(/\s+key$/, '').trim()]

      if (!alias) {
        return fail(`I do not know the key "${String(key)}". Try enter, tab, escape, backspace, an arrow, or page down.`)
      }

      return edit(
        () => performEdit({ kind: 'key', key: alias.key, modifiers: alias.modifiers }, { needsField: true }),
        target => `Pressed ${String(key)} in ${target}`
      )
    }
  },
  {
    id: 'text.newLine',
    title: 'New line',
    description: 'Start a new line without sending (Shift+Enter).',
    tier: 'mutate',
    args: [],
    phrases: ['new line', 'next line', 'line break'],
    run: () => edit(() => performEdit({ kind: 'key', key: 'enter', modifiers: ['shift'] }, { needsField: true }), target => `New line in ${target}`)
  },
  {
    id: 'edit.selectAll',
    title: 'Select all',
    description: 'Select everything in the focused field or page.',
    tier: 'act',
    args: [],
    phrases: ['select all', 'select everything', 'select all the text', 'select all text'],
    run: () => edit(() => performEdit({ kind: 'selectAll' }), target => `Selected all in ${target}`)
  },
  {
    id: 'edit.select',
    title: 'Select a word or line',
    description: 'Extend the selection back by a word or to the start of the line.',
    tier: 'act',
    args: [{ name: 'scope', type: 'string', description: 'word or line', required: true, enum: ['word', 'line'] }],
    phrases: [
      { phrase: 'select the last word', args: { scope: 'word' } },
      { phrase: 'select the previous word', args: { scope: 'word' } },
      { phrase: 'select word', args: { scope: 'word' } },
      { phrase: 'select the line', args: { scope: 'line' } },
      { phrase: 'select the whole line', args: { scope: 'line' } },
      { phrase: 'select line', args: { scope: 'line' } }
    ],
    run: ({ scope }) =>
      edit(
        () => performEdit({ kind: 'key', key: 'left', modifiers: ['shift', scope === 'line' ? LINE_MOD : WORD_MOD] }, { needsField: true }),
        target => `Selected the ${String(scope)} in ${target}`
      )
  },
  {
    id: 'edit.deselect',
    title: 'Deselect',
    description: 'Clear the selection.',
    tier: 'act',
    args: [],
    phrases: ['deselect', 'unselect', 'clear the selection', 'select nothing'],
    run: () => edit(() => performEdit({ kind: 'unselect' }), target => `Cleared the selection in ${target}`)
  },
  {
    id: 'edit.copy',
    title: 'Copy',
    description: 'Copy the selection to the clipboard.',
    tier: 'act',
    args: [],
    phrases: ['copy', 'copy that', 'copy it', 'copy this', 'copy the selection'],
    run: () => edit(() => performEdit({ kind: 'copy' }), () => 'Copied')
  },
  {
    id: 'edit.cut',
    title: 'Cut',
    description: 'Cut the selection to the clipboard.',
    tier: 'mutate',
    args: [],
    phrases: ['cut', 'cut that', 'cut it', 'cut this', 'cut the selection'],
    run: () => edit(() => performEdit({ kind: 'cut' }, { needsField: true }), target => `Cut from ${target}`)
  },
  {
    id: 'edit.paste',
    title: 'Paste',
    description: 'Paste the clipboard into the focused field, terminal or page.',
    tier: 'mutate',
    args: [],
    phrases: ['paste', 'paste that', 'paste it', 'paste here', 'paste the clipboard'],
    run: () => edit(() => performEdit({ kind: 'paste' }, { needsField: true }), target => `Pasted into ${target}`)
  },
  {
    id: 'edit.undo',
    title: 'Undo',
    description: 'Undo the last edit.',
    tier: 'mutate',
    args: [],
    phrases: ['undo', 'undo that', 'undo it', 'take that back'],
    run: () => edit(() => performEdit({ kind: 'undo' }), target => `Undid the last edit in ${target}`)
  },
  {
    id: 'edit.redo',
    title: 'Redo',
    description: 'Redo the last undone edit.',
    tier: 'mutate',
    args: [],
    phrases: ['redo', 'redo that', 'redo it'],
    run: () => edit(() => performEdit({ kind: 'redo' }), target => `Redid in ${target}`)
  },
  {
    id: 'edit.delete',
    title: 'Delete',
    description: 'Delete the selection or the character before the cursor; "the last word" deletes a word; "clear" empties the field.',
    tier: 'mutate',
    args: [{ name: 'what', type: 'string', description: 'selection, word or all', enum: ['selection', 'word', 'all'] }],
    phrases: [
      { phrase: 'delete that', args: { what: 'selection' } },
      { phrase: 'delete it', args: { what: 'selection' } },
      { phrase: 'delete', args: { what: 'selection' } },
      { phrase: 'erase that', args: { what: 'selection' } },
      { phrase: 'backspace', args: { what: 'selection' } },
      { phrase: 'delete the last word', args: { what: 'word' } },
      { phrase: 'delete the previous word', args: { what: 'word' } },
      { phrase: 'delete word', args: { what: 'word' } },
      { phrase: 'clear the field', args: { what: 'all' } },
      { phrase: 'clear it', args: { what: 'all' } },
      { phrase: 'clear the text', args: { what: 'all' } },
      { phrase: 'clear everything', args: { what: 'all' } },
      { phrase: 'delete everything', args: { what: 'all' } }
    ],
    run: ({ what }) =>
      edit(
        async () => {
          if (what === 'all') {
            await performEdit({ kind: 'selectAll' }, { needsField: true })
          }

          return performEdit({ kind: 'key', key: 'backspace', modifiers: what === 'word' ? [WORD_MOD] : [] }, { needsField: true })
        },
        target => (what === 'all' ? `Cleared ${target}` : what === 'word' ? `Deleted a word in ${target}` : `Deleted in ${target}`)
      )
  },
  {
    id: 'view.scroll',
    title: 'Scroll',
    description: 'Scroll the frontmost window up, down, to the top or to the bottom.',
    tier: 'read',
    args: [{ name: 'direction', type: 'string', description: 'up, down, top or bottom', required: true, enum: ['down', 'up', 'top', 'bottom'] }],
    phrases: [
      { phrase: 'scroll down', args: { direction: 'down' } },
      { phrase: 'scroll up', args: { direction: 'up' } },
      { phrase: 'page down', args: { direction: 'down' } },
      { phrase: 'page up', args: { direction: 'up' } },
      { phrase: 'scroll to the top', args: { direction: 'top' } },
      { phrase: 'go to the top', args: { direction: 'top' } },
      { phrase: 'scroll to the bottom', args: { direction: 'bottom' } },
      { phrase: 'go to the bottom', args: { direction: 'bottom' } }
    ],
    run: ({ direction }) => (scrollFront(direction as 'up' | 'down' | 'top' | 'bottom') ? ok(`Scrolled ${String(direction)}`) : fail('Nothing here scrolls.'))
  }
]
