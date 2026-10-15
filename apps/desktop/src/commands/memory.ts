import { $env } from '../store/backend.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { showPage } from '../store/windows.ts'
import { $memory, addEntry, focusMemory, forgetEntry, loadMemory, type MemoryEntry, type MemoryFile, updateEntry } from '../features/memory/memory-store.ts'

/* Hermes memory (MEMORY.md / USER.md), edited through the same store as the Memory page. */

async function ensureLoaded(options: { fresh?: boolean } = {}): Promise<string> {
  const home = $env.get()?.hermesHome

  if (!home) {
    throw new Error('Hermes home is not known yet.')
  }

  // Hermes's own memory tool writes the same files behind our back; re-read before showing or matching.
  if (options.fresh || !$memory.get().loaded) {
    await loadMemory(home)
  }

  return home
}

const clean = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim()

/** Entries mentioning the query: exact title, then full text, then the query's first words. */
function findEntries(query: string): MemoryEntry[] {
  const needle = clean(query)

  if (!needle) {
    return []
  }

  const entries = $memory.get().entries
  const exact = entries.filter(e => clean(e.title) === needle)

  if (exact.length) {
    return exact
  }

  const full = entries.filter(e => clean(e.text).includes(needle))

  if (full.length) {
    return full
  }

  const words = needle.split(' ').filter(w => w.length > 2)

  for (let take = Math.min(4, words.length); take >= 2; take--) {
    const prefix = words.slice(0, take).join(' ')
    const partial = entries.filter(e => clean(e.text).includes(prefix))

    if (partial.length) {
      return partial
    }
  }

  return []
}

const fileArg = { name: 'file', type: 'string', description: 'memory (what Hermes knows) or user (facts about you)', enum: ['memory', 'user'] } as const
const toFile = (value: unknown): MemoryFile => (String(value ?? 'memory').toLowerCase() === 'user' ? 'USER.md' : 'MEMORY.md')

export const memoryCommands: readonly OsCommand[] = [
  {
    id: 'memory.show',
    title: 'Show memory',
    description: 'Open the Memory page, optionally filtered to a search.',
    tier: 'read',
    args: [{ name: 'query', type: 'string', description: 'Text to filter by' }],
    phrases: ['show my memory', 'open memory', 'what do you remember about {query}', 'show memories about {query}', 'search my memory for {query}'],
    run: async ({ query }) => {
      await ensureLoaded({ fresh: true })
      showPage('memory')
      const text = query ? String(query) : ''

      if (!text) {
        focusMemory({ query: '' })

        return ok(`Showing ${$memory.get().entries.length} memories`, { page: 'memory' })
      }

      const matches = findEntries(text)
      // Filter the list by the words that actually matched, and select the best hit.
      const filter = matches.length ? (clean(matches[0].text).includes(clean(text)) ? text : '') : text
      focusMemory({ query: filter, entryId: matches[0]?.id })

      return ok(matches.length ? `${matches.length} memor${matches.length === 1 ? 'y' : 'ies'} about "${text}"` : `Nothing in memory about "${text}"`, {
        page: 'memory',
        highlight: matches[0] ? { kind: 'memory', id: matches[0].id } : undefined,
        items: matches.slice(0, 10).map(e => ({ id: e.id, title: e.title, text: e.text, file: e.file, kind: e.kind }))
      })
    }
  },
  {
    id: 'memory.search',
    title: 'Search memory',
    description: 'Return memory entries matching a query (no navigation).',
    tier: 'read',
    args: [{ name: 'query', type: 'string', description: 'Text to search for', required: true }],
    hidden: true,
    run: async ({ query }) => {
      await ensureLoaded({ fresh: true })
      const matches = findEntries(String(query))

      return ok(`${matches.length} match${matches.length === 1 ? '' : 'es'}`, { items: matches.map(e => ({ id: e.id, title: e.title, text: e.text, file: e.file })) })
    }
  },
  {
    id: 'memory.add',
    title: 'Remember something',
    description: 'Add an entry to Hermes memory (or to the facts about you) and show it.',
    tier: 'mutate',
    args: [{ name: 'text', type: 'string', description: 'What to remember', required: true }, fileArg],
    phrases: ['remember that {text}', 'add to memory {text}', 'add {text} to my memory', 'save to memory {text}', 'remember {text}'],
    run: async ({ text, file }) => {
      const home = await ensureLoaded()
      const target = toFile(file)
      const id = await addEntry(home, target, String(text))
      showPage('memory')
      focusMemory({ query: '', entryId: id })

      return ok(`Remembered: ${String(text)}`, { spoken: 'Got it, I will remember that.', page: 'memory', highlight: { kind: 'memory', id }, data: { id, file: target } })
    }
  },
  {
    id: 'memory.update',
    title: 'Update a memory',
    description: 'Replace the text of an existing memory entry.',
    tier: 'mutate',
    args: [
      { name: 'match', type: 'string', description: 'Text identifying the entry', required: true },
      { name: 'text', type: 'string', description: 'The new text', required: true }
    ],
    hidden: true,
    run: async ({ match, text }) => {
      const home = await ensureLoaded({ fresh: true })
      const matches = findEntries(String(match))

      if (matches.length !== 1) {
        return fail(matches.length ? `"${String(match)}" matches ${matches.length} entries; be more specific.` : `No memory matches "${String(match)}".`, { items: matches.map(e => e.title) })
      }

      await updateEntry(home, matches[0], String(text))
      showPage('memory')
      focusMemory({ query: '', entryId: matches[0].id })

      return ok(`Updated "${matches[0].title}"`, { page: 'memory', highlight: { kind: 'memory', id: matches[0].id } })
    }
  },
  {
    id: 'memory.forget',
    title: 'Forget a memory',
    description: 'Delete a memory entry.',
    tier: 'destructive',
    args: [{ name: 'match', type: 'string', description: 'Text identifying the entry', required: true }],
    phrases: ['forget {match}', 'forget that {match}', 'delete the memory about {match}', 'remove {match} from memory'],
    run: async ({ match }) => {
      const home = await ensureLoaded({ fresh: true })
      const matches = findEntries(String(match))

      if (matches.length !== 1) {
        return fail(matches.length ? `"${String(match)}" matches ${matches.length} entries; be more specific.` : `No memory matches "${String(match)}".`, { items: matches.map(e => e.title) })
      }

      const title = matches[0].title
      await forgetEntry(home, matches[0])
      showPage('memory')
      focusMemory({ query: '' })

      return ok(`Forgot "${title}"`, { spoken: 'Forgotten.', page: 'memory' })
    }
  }
]
