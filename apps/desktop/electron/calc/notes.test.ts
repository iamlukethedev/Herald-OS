import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CALC_NOTE_ID, CALC_NOTE_MAX_CHARS, CALC_NOTES_MAX } from '../../shared/calc.ts'
import { NotesStore } from './notes.ts'

const NOON = Date.UTC(2026, 9, 15, 12, 0)

const folders: string[] = []

afterEach(() => {
  for (const folder of folders.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calc-notes-'))
  folders.push(root)
  const dir = path.join(root, 'calc', 'notes')
  const clock = { now: NOON }
  const onChange = vi.fn()
  const store = new NotesStore({ dir, now: () => clock.now, onChange })
  const onDisk = (id: string) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')) as unknown

  return { root, dir, clock, onChange, store, onDisk }
}

describe("Herald Calc's notes", () => {
  it('make a new note under a short random id, in a file of its own only the person can read', async () => {
    const { store, dir, onDisk, onChange } = setup()
    const note = await store.save({ text: '# Groceries\n2 * 3.50' })

    expect(note).toEqual({ id: expect.stringMatching(/^[0-9a-f]{10}$/), text: '# Groceries\n2 * 3.50', createdAt: NOON, updatedAt: NOON })
    expect(CALC_NOTE_ID.test(note.id)).toBe(true)
    expect(onDisk(note.id)).toEqual(note)
    expect(await store.read(note.id)).toEqual(note)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect((await store.save({ text: 'Another' })).id).not.toBe(note.id)

    if (process.platform !== 'win32') {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
      expect(fs.statSync(path.join(dir, `${note.id}.json`)).mode & 0o777).toBe(0o600)
    }
  })

  it('replace a note, keeping when it was made, and leave a save that changes nothing alone', async () => {
    const { store, clock, onChange, onDisk } = setup()
    const note = await store.save({ text: 'Rent 1200' })

    clock.now += 60_000
    const edited = await store.save({ id: note.id, text: 'Rent 1250' })
    expect(edited).toEqual({ id: note.id, text: 'Rent 1250', createdAt: NOON, updatedAt: NOON + 60_000 })
    expect(onDisk(note.id)).toEqual(edited)

    clock.now += 60_000
    expect(await store.save({ id: note.id, text: 'Rent 1250' })).toEqual(edited)
    expect(onDisk(note.id)).toEqual(edited)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('make a note again under its id when another window deleted it while this one edited it', async () => {
    const { store, clock } = setup()
    const note = await store.save({ text: 'Trip' })
    await store.remove(note.id)

    clock.now += 1000
    expect(await store.save({ id: note.id, text: 'Trip, edited' })).toEqual({ id: note.id, text: 'Trip, edited', createdAt: NOON + 1000, updatedAt: NOON + 1000 })
    expect(await store.save({ id: 'budget-2026', text: 'Budget' })).toMatchObject({ id: 'budget-2026', text: 'Budget' })
  })

  it("list every note's title and preview, the one changed last first, and skip files that are not notes", async () => {
    const { store, clock, dir } = setup()
    expect(await store.list()).toEqual([])

    const groceries = await store.save({ text: '# Groceries\n\nMilk 2 * 1.20\nBread 3.10\nEggs 12 * 0.35\nTotal' })
    clock.now += 1000
    const rent = await store.save({ text: '// Rent split\n1200 / 3' })
    clock.now += 1000
    const empty = await store.save({ text: '' })
    clock.now += 1000
    await store.save({ id: groceries.id, text: '# Groceries\nMilk 2 * 1.25' })

    fs.writeFileSync(path.join(dir, 'README.txt'), 'hello')
    fs.writeFileSync(path.join(dir, '.herald-tmp.abc.json.123'), '{}')
    fs.writeFileSync(path.join(dir, 'Bad Name.json'), JSON.stringify({ id: 'Bad Name', text: 'x', createdAt: 1, updatedAt: 1 }))
    fs.writeFileSync(path.join(dir, 'broken.json'), '{"id": "broken", "text": ')
    fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ id: rent.id, text: 'x', createdAt: 1, updatedAt: 1 }))

    expect(await store.list()).toEqual([
      { id: groceries.id, title: 'Groceries', preview: 'Milk 2 * 1.25', createdAt: NOON, updatedAt: NOON + 3000 },
      { id: empty.id, title: 'Untitled', preview: '', createdAt: NOON + 2000, updatedAt: NOON + 2000 },
      { id: rent.id, title: 'Rent split', preview: '1200 / 3', createdAt: NOON + 1000, updatedAt: NOON + 1000 }
    ])
  })

  it('use only ids that are CALC_NOTE_ID, so no file name leaves the notes folder', async () => {
    const { store, root, dir } = setup()
    const outside = path.join(root, 'calc', 'prefs.json')
    fs.mkdirSync(path.dirname(outside), { recursive: true })
    fs.writeFileSync(outside, JSON.stringify({ id: '../prefs', text: 'secret', createdAt: 1, updatedAt: 1 }))

    for (const id of ['../prefs', '..', 'A', '-x', 'x'.repeat(65), 'a/b', 'a.b', '', 42, null, { id: 'x' }]) {
      expect(await store.read(id), String(id)).toBeNull()
    }

    for (const id of ['../prefs', 'Notes', 'a b', 42, '']) {
      await expect(store.save({ id, text: 'x' }), String(id)).rejects.toThrow('That is not a note id.')
    }

    await store.remove('../prefs')
    expect(fs.existsSync(outside)).toBe(true)
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('refuse a note longer than CALC_NOTE_MAX_CHARS rather than cutting it, and anything that is not a note', async () => {
    const { store } = setup()

    await expect(store.save({ text: 'x'.repeat(CALC_NOTE_MAX_CHARS + 1) })).rejects.toThrow('A note holds at most 200,000 characters.')

    for (const note of [null, 'text', ['x'], { text: 42 }, {}]) {
      await expect(store.save(note), JSON.stringify(note)).rejects.toThrow('A note needs its text.')
    }

    expect(await store.list()).toEqual([])

    const longest = await store.save({ text: 'x'.repeat(CALC_NOTE_MAX_CHARS) })
    expect((await store.read(longest.id))?.text).toHaveLength(CALC_NOTE_MAX_CHARS)
  })

  it('keep at most CALC_NOTES_MAX: a new note past that is refused, while editing one still works', async () => {
    const { store, dir, clock } = setup()
    fs.mkdirSync(dir, { recursive: true })

    for (let index = 0; index < CALC_NOTES_MAX; index++) {
      const id = `note-${index}`
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, text: `Note ${index}`, createdAt: 1, updatedAt: 1 + index }))
    }

    await expect(store.save({ text: 'One too many' })).rejects.toThrow(`Herald Calc keeps at most ${CALC_NOTES_MAX} notes; delete one to make room.`)
    await expect(store.save({ id: 'brand-new', text: 'Also one too many' })).rejects.toThrow('delete one to make room')
    expect(await store.save({ id: 'note-7', text: 'Note 7, edited' })).toEqual({ id: 'note-7', text: 'Note 7, edited', createdAt: 1, updatedAt: clock.now })

    await store.remove('note-0')
    expect(await store.save({ text: 'Room again' })).toMatchObject({ text: 'Room again' })
    expect(await store.list()).toHaveLength(CALC_NOTES_MAX)
  })

  it('delete a note, and a note that is not there is nothing to delete', async () => {
    const { store, dir, onChange } = setup()
    const note = await store.save({ text: 'Tip 15% of 64' })
    await store.remove(note.id)

    expect(await store.read(note.id)).toBeNull()
    expect(fs.readdirSync(dir)).toEqual([])
    expect(onChange).toHaveBeenCalledTimes(2)

    await store.remove(note.id)
    await store.remove('never-there')
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('save one at a time, so saves from two windows at once both land, the later one last', async () => {
    const { store } = setup()
    const [first, second] = await Promise.all([store.save({ text: 'From one window' }), store.save({ text: 'From another' })])

    expect(first.id).not.toBe(second.id)
    expect(await store.list()).toHaveLength(2)

    await Promise.all([store.save({ id: first.id, text: 'First edit' }), store.save({ id: first.id, text: 'Second edit' })])
    expect((await store.read(first.id))?.text).toBe('Second edit')
  })
})
