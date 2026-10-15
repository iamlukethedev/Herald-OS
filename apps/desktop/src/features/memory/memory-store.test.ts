import { beforeEach, describe, expect, it, vi } from 'vitest'
import { $memory, addEntry, forgetEntry, loadMemory, MemoryEntryGoneError, parse, serialize, updateEntry } from './memory-store.ts'

// The Electron file bridge, backed by a map from path to file text.
const disk = vi.hoisted(() => {
  const files = new Map<string, string>()
  const truncated = new Set<string>()
  const writes: { path: string; options?: { atomic?: boolean } }[] = []
  Object.assign(globalThis, {
    window: {
      heraldOS: {
        fs: {
          readDir: async (dir: string) =>
            [...files.keys()].filter(path => path.startsWith(`${dir}/`)).map(path => ({ name: path.slice(dir.length + 1), path, isDirectory: false, size: 0, modifiedAt: 1 })),
          readFile: async (path: string) => ({ path, kind: 'text', size: 0, content: files.get(path) ?? '', truncated: truncated.has(path) }),
          writeText: async (path: string, content: string, options?: { atomic?: boolean }) => {
            writes.push({ path, options })
            files.set(path, content)
          },
          mkdir: async () => undefined
        }
      }
    }
  })

  return { files, truncated, writes }
})

const HOME = '/home/sam/.hermes'
const MEMORY = `${HOME}/memories/MEMORY.md`

const onDisk = () => parse(disk.files.get(MEMORY) ?? '')
const entry = (text: string) => $memory.get().entries.find(e => e.text === text)!

/** Herald loads the file, then Hermes's memory tool rewrites it before Herald's next write. */
async function loadThenHermesWrites(loaded: string[], hermes: string[]) {
  disk.files.set(MEMORY, serialize(loaded))
  await loadMemory(HOME)
  disk.files.set(MEMORY, serialize(hermes))
}

beforeEach(() => {
  disk.files.clear()
  disk.truncated.clear()
  disk.writes.length = 0
})

describe('memory writes', () => {
  it('keeps an entry Hermes saved after Herald loaded the file when Herald adds one', async () => {
    await loadThenHermesWrites(['A', 'B'], ['A', 'B', 'saved by Hermes'])
    const id = await addEntry(HOME, 'MEMORY.md', 'added by Herald')

    expect(onDisk()).toEqual(['A', 'B', 'saved by Hermes', 'added by Herald'])
    expect(id).toBe('MEMORY.md:3')
    expect($memory.get().entries.find(e => e.id === id)?.text).toBe('added by Herald')
  })

  it('does not bring back an entry Hermes removed when Herald forgets another', async () => {
    await loadThenHermesWrites(['A', 'B', 'C'], ['B', 'C'])
    await forgetEntry(HOME, entry('C'))

    expect(onDisk()).toEqual(['B'])
  })

  it('edits the entry with the same text, not whatever now sits at its old position', async () => {
    await loadThenHermesWrites(['A', 'B', 'C'], ['B', 'C'])
    await updateEntry(HOME, entry('B'), 'B, edited')

    expect(onDisk()).toEqual(['B, edited', 'C'])
  })

  it('fails cleanly, and writes nothing, when the entry to edit or forget is gone', async () => {
    await loadThenHermesWrites(['A', 'B'], ['B', 'saved by Hermes'])
    const stale = entry('A')

    await expect(forgetEntry(HOME, stale)).rejects.toBeInstanceOf(MemoryEntryGoneError)
    await expect(updateEntry(HOME, stale, 'A, edited')).rejects.toThrow('"A" is no longer in MEMORY.md')
    expect(disk.writes).toEqual([])
    expect(onDisk()).toEqual(['B', 'saved by Hermes'])
    expect($memory.get().entries.map(e => e.text)).toEqual(['B', 'saved by Hermes'])
  })

  it('keeps both entries when two adds from Herald overlap', async () => {
    disk.files.set(MEMORY, serialize(['A']))
    await loadMemory(HOME)
    const ids = await Promise.all([addEntry(HOME, 'MEMORY.md', 'first'), addEntry(HOME, 'MEMORY.md', 'second')])

    expect(onDisk()).toEqual(['A', 'first', 'second'])
    expect(ids).toEqual(['MEMORY.md:1', 'MEMORY.md:2'])
  })

  it('carries on after a failed write', async () => {
    await loadThenHermesWrites(['A'], [])
    await expect(forgetEntry(HOME, entry('A'))).rejects.toThrow()
    await addEntry(HOME, 'MEMORY.md', 'after the failure')

    expect(onDisk()).toEqual(['after the failure'])
  })

  it('refuses to write back a file it could only read part of, even if it was whole when loaded', async () => {
    await loadThenHermesWrites(['A'], ['A', 'a very long entry'])
    disk.truncated.add(MEMORY)

    await expect(addEntry(HOME, 'MEMORY.md', 'B')).rejects.toThrow('MEMORY.md is too large to edit safely from here')
    expect(disk.writes).toEqual([])
  })

  it('creates the file on the first add, and writes atomically', async () => {
    await loadMemory(HOME)
    await addEntry(HOME, 'MEMORY.md', 'first memory')

    expect(onDisk()).toEqual(['first memory'])
    expect(disk.writes).toEqual([{ path: MEMORY, options: { atomic: true } }])
  })
})
