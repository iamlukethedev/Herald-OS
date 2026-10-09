import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { heraldOsDataDir } from './paths.ts'
import { readPrefs, writePrefs } from './prefs.ts'

describe('the name on comments in the prefs', () => {
  const saved = process.env.HERMES_HOME
  let root = ''
  const file = () => path.join(root, 'herald-os', 'prefs.json')
  const onDisk = () => JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, unknown>

  function store(prefs: Record<string, unknown>) {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(prefs))
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-prefs-'))
    process.env.HERMES_HOME = root
    expect(heraldOsDataDir()).toBe(path.join(root, 'herald-os'))
  })

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.HERMES_HOME
    } else {
      process.env.HERMES_HOME = saved
    }

    fs.rmSync(root, { recursive: true, force: true })
  })

  it('reads it as one line with single spaces, cut to 80 characters, and leaves out one that is empty or not text', () => {
    store({ commentName: '  Sam \n  Rivera  ' })
    expect(readPrefs().commentName).toBe('Sam Rivera')

    store({ commentName: 'x'.repeat(200) })
    expect(readPrefs().commentName).toHaveLength(80)

    store({ commentName: '   ' })
    expect(readPrefs().commentName).toBeUndefined()

    store({ commentName: 42 })
    expect(readPrefs().commentName).toBeUndefined()

    store({ theme: 'graphite' })
    expect(readPrefs().commentName).toBeUndefined()
  })

  it('writes it the same way, keeps it through other changes, and clears it with an empty one', () => {
    expect(writePrefs({ commentName: ' Sam   Rivera ' }).commentName).toBe('Sam Rivera')
    expect(onDisk().commentName).toBe('Sam Rivera')

    writePrefs({ theme: 'graphite' })
    expect(onDisk()).toMatchObject({ commentName: 'Sam Rivera', theme: 'graphite' })

    expect(writePrefs({ commentName: '' }).commentName).toBeUndefined()
    expect(onDisk()).not.toHaveProperty('commentName')
    expect(readPrefs().commentName).toBeUndefined()
  })
})
