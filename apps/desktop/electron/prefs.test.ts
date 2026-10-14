import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NotifyPrefs } from '../shared/ipc.ts'
import { NOTIFY_DEFAULTS } from '../shared/notify-prefs.ts'
import { PET_PREFS_DEFAULTS, type PetPrefs } from '../shared/pet.ts'
import { heraldOsDataDir } from './paths.ts'
import { readPrefs, writePrefs } from './prefs.ts'

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

describe('the name on comments in the prefs', () => {
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

describe('the language in the prefs', () => {
  it('reads a language Herald has, or following the system, and leaves out anything else', () => {
    expect(readPrefs().language).toBeUndefined()

    store({ language: 'zh-CN' })
    expect(readPrefs().language).toBe('zh-CN')

    store({ language: 'system' })
    expect(readPrefs().language).toBe('system')

    store({ language: 'fr' })
    expect(readPrefs().language).toBeUndefined()
  })

  it('writes it the same way and keeps it through other changes', () => {
    expect(writePrefs({ language: 'zh-CN' }).language).toBe('zh-CN')
    writePrefs({ theme: 'graphite' })
    expect(onDisk()).toMatchObject({ language: 'zh-CN', theme: 'graphite' })

    expect(writePrefs({ language: 'zh' as never }).language).toBeUndefined()
    expect(onDisk()).not.toHaveProperty('language')
  })
})

describe('the pet in the prefs', () => {
  it('reads the defaults when there is nothing stored, or no prefs file at all', () => {
    expect(readPrefs().pet).toEqual(PET_PREFS_DEFAULTS)

    store({ theme: 'graphite' })
    expect(readPrefs().pet).toEqual(PET_PREFS_DEFAULTS)
  })

  it('makes a stored one whole: unknown keys dropped, the spot held to the area, missing switches on', () => {
    store({ pet: { hidden: true, spot: { x: 1.4, y: 0.25 }, reactions: { running: false, dancing: false }, moods: 'none', colour: 'red' } })

    expect(readPrefs().pet).toEqual({
      ...PET_PREFS_DEFAULTS,
      hidden: true,
      spot: { x: 1, y: 0.25 },
      reactions: { ...PET_PREFS_DEFAULTS.reactions, running: false }
    })

    store({ pet: { hidden: 'yes', spot: { x: 0.5 }, followWindows: 0 } })
    expect(readPrefs().pet).toEqual(PET_PREFS_DEFAULTS)
  })

  it('writes whole sub-objects over what is stored and keeps them through other changes', () => {
    writePrefs({ pet: { ...PET_PREFS_DEFAULTS, spot: { x: 0.2, y: 0.9 } } })
    const quiet = { ...PET_PREFS_DEFAULTS, spot: { x: 0.2, y: 0.9 }, hidden: true, notes: { update: false, job: true } }

    expect(writePrefs({ pet: quiet }).pet).toEqual(quiet)
    writePrefs({ theme: 'graphite' })
    expect(onDisk()).toMatchObject({ theme: 'graphite', pet: quiet })

    expect(writePrefs({ pet: { hidden: false } as PetPrefs }).pet).toEqual({ ...quiet, hidden: false })
    expect(readPrefs().pet).toEqual({ ...quiet, hidden: false })
  })
})

describe('the Alerts switches in the prefs', () => {
  it('reads every switch on when there is no prefs file, nothing stored, or something malformed', () => {
    expect(readPrefs().notify).toEqual(NOTIFY_DEFAULTS)

    store({ theme: 'graphite' })
    expect(readPrefs().notify).toEqual(NOTIFY_DEFAULTS)

    store({ notify: { approvals: 'no', taskUpdates: false } })
    expect(readPrefs().notify).toEqual({ ...NOTIFY_DEFAULTS, taskUpdates: false })
  })

  it('merges a partial write over what is stored and keeps it through other changes', () => {
    writePrefs({ notify: { ...NOTIFY_DEFAULTS, approvals: false } })
    expect(writePrefs({ notify: { nativeWhenUnfocused: false } as NotifyPrefs }).notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false, nativeWhenUnfocused: false })

    writePrefs({ theme: 'graphite' })
    expect(onDisk()).toMatchObject({ theme: 'graphite', notify: { ...NOTIFY_DEFAULTS, approvals: false, nativeWhenUnfocused: false } })
    expect(readPrefs().notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false, nativeWhenUnfocused: false })
  })
})
