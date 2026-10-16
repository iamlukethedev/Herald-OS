import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CALC_PREFS_DEFAULTS } from '../shared/calc.ts'
import { NOTIFY_DEFAULTS } from '../shared/notify-prefs.ts'
import { PET_PREFS_DEFAULTS } from '../shared/pet.ts'
import { ROOM_PREFS_DEFAULTS } from '../shared/room.ts'
import { heraldOsDataDir } from './paths.ts'
import { adoptLegacyNotify, readPrefs, writePrefs } from './prefs.ts'

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

    expect(writePrefs({ pet: { hidden: false } }).pet).toEqual({ ...quiet, hidden: false })
    expect(readPrefs().pet).toEqual({ ...quiet, hidden: false })
  })

  it('keeps the fields a write does not name on disk, so a put-away pet stays away when another window moves it', () => {
    writePrefs({ pet: { ...PET_PREFS_DEFAULTS, hidden: true, followWindows: false } })

    expect(writePrefs({ pet: { spot: { x: 0.4, y: 0.6 } } }).pet).toEqual({ ...PET_PREFS_DEFAULTS, hidden: true, followWindows: false, spot: { x: 0.4, y: 0.6 } })
    expect(onDisk().pet).toEqual({ ...PET_PREFS_DEFAULTS, hidden: true, followWindows: false, spot: { x: 0.4, y: 0.6 } })

    writePrefs({ pet: { notes: { update: false, job: true } } })
    expect(readPrefs().pet).toEqual({ ...PET_PREFS_DEFAULTS, hidden: true, followWindows: false, spot: { x: 0.4, y: 0.6 }, notes: { update: false, job: true } })
  })
})

describe('the Pet Room in the prefs', () => {
  it('reads the defaults when there is nothing stored, or no prefs file at all', () => {
    expect(readPrefs().room).toEqual(ROOM_PREFS_DEFAULTS)

    store({ theme: 'graphite' })
    expect(readPrefs().room).toEqual(ROOM_PREFS_DEFAULTS)
  })

  it('makes a stored one whole: unknown keys, pets that are not one folder name and unknown motions dropped', () => {
    store({ room: { pets: { conversation: 'boba', mission: '../mochi', robot: 'mochi' }, motion: 'warp', tints: false, sparkle: true } })

    expect(readPrefs().room).toEqual({ ...ROOM_PREFS_DEFAULTS, pets: { ...ROOM_PREFS_DEFAULTS.pets, conversation: 'boba' }, tints: false })
  })

  it('merges a write field by field and the pets kind by kind, and keeps it through other changes', () => {
    const calm = { ...ROOM_PREFS_DEFAULTS, pets: { ...ROOM_PREFS_DEFAULTS.pets, conversation: 'boba' }, motion: 'calm' as const }

    expect(writePrefs({ room: calm }).room).toEqual(calm)
    expect(writePrefs({ room: { pets: { helper: 'mochi' } } }).room).toEqual({ ...calm, pets: { ...calm.pets, helper: 'mochi' } })
    expect(writePrefs({ room: { steps: false } }).room).toEqual({ ...calm, pets: { ...calm.pets, helper: 'mochi' }, steps: false })

    writePrefs({ theme: 'graphite' })
    expect(onDisk()).toMatchObject({ theme: 'graphite', room: { pets: { conversation: 'boba', helper: 'mochi' }, motion: 'calm', steps: false } })
    expect(readPrefs().room?.pets).toEqual({ ...calm.pets, helper: 'mochi' })
  })
})

describe('Herald Calc in the prefs', () => {
  it('reads the defaults when there is nothing stored, or no prefs file at all', () => {
    expect(readPrefs().calc).toEqual(CALC_PREFS_DEFAULTS)

    store({ theme: 'graphite' })
    expect(readPrefs().calc).toEqual(CALC_PREFS_DEFAULTS)
  })

  it('makes a stored one whole: unknown keys and values dropped, the rates fetch on unless turned off', () => {
    store({ calc: { fetchRates: 'no', sounds: true, angle: 'grad', keypad: 'programmer', theme: 'neon' } })
    expect(readPrefs().calc).toEqual({ ...CALC_PREFS_DEFAULTS, sounds: true, keypad: 'programmer' })

    store({ calc: { fetchRates: false } })
    expect(readPrefs().calc).toEqual({ ...CALC_PREFS_DEFAULTS, fetchRates: false })
  })

  it('merges a write field by field, so a window names only what it changes, and keeps it through other changes', () => {
    const scientific = { ...CALC_PREFS_DEFAULTS, fetchRates: false, keypad: 'scientific' as const, angle: 'rad' as const }

    expect(writePrefs({ calc: { fetchRates: false } }).calc).toEqual({ ...CALC_PREFS_DEFAULTS, fetchRates: false })
    expect(writePrefs({ calc: { keypad: 'scientific', angle: 'rad' } }).calc).toEqual(scientific)
    expect(writePrefs({ calc: { sounds: undefined, keypad: 'scientific' } }).calc).toEqual(scientific)

    writePrefs({ theme: 'graphite' })
    expect(onDisk()).toMatchObject({ theme: 'graphite', calc: scientific })
    expect(readPrefs().calc).toEqual(scientific)

    expect(writePrefs({ calc: { sounds: true } }).calc).toEqual({ ...scientific, sounds: true })
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
    writePrefs({ notify: { approvals: false } })
    expect(writePrefs({ notify: { nativeWhenUnfocused: false } }).notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false, nativeWhenUnfocused: false })

    writePrefs({ theme: 'graphite' })
    expect(onDisk()).toMatchObject({ theme: 'graphite', notify: { approvals: false, nativeWhenUnfocused: false } })
    expect(readPrefs().notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false, nativeWhenUnfocused: false })
  })

  it('keeps both switches when two windows each save a different one', () => {
    writePrefs({ notify: { approvals: false } })
    writePrefs({ notify: { taskUpdates: false } })
    writePrefs({ notify: { approvals: true } })

    expect(readPrefs().notify).toEqual({ ...NOTIFY_DEFAULTS, taskUpdates: false })
  })
})

describe('which Alerts switches prefs.json holds', () => {
  it('saves only the switches someone set, never the defaults, so other writes leave them unset', () => {
    writePrefs({ theme: 'graphite' })
    expect(onDisk().notify).toEqual({})

    writePrefs({ notify: { approvals: false } })
    writePrefs({ reduceMotion: true })
    expect(onDisk().notify).toEqual({ approvals: false })
    expect(readPrefs().notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false })
  })

  it('drops switch values that are not booleans, and keys that are not switches, from a write', () => {
    writePrefs({ notify: { approvals: 'false', taskUpdates: 0, toolCompletions: null, sound: false, nativeWhenUnfocused: false } as never })

    expect(onDisk().notify).toEqual({ nativeWhenUnfocused: false })
  })
})

describe('adopting Alerts switches from localStorage', () => {
  it('never lets an old localStorage value replace a switch prefs.json already has', () => {
    store({ notify: { approvals: false, taskUpdates: true } })

    const next = adoptLegacyNotify({ approvals: true, taskUpdates: false, nativeWhenUnfocused: false })

    expect(next.notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false, taskUpdates: true, nativeWhenUnfocused: false })
    expect(onDisk().notify).toEqual({ approvals: false, taskUpdates: true, nativeWhenUnfocused: false })
  })

  it('fills every switch when prefs.json has none, or only malformed ones', () => {
    store({ theme: 'graphite', notify: { approvals: 'off' } })

    expect(adoptLegacyNotify({ toolCompletions: false, approvals: false }).notify).toEqual({ ...NOTIFY_DEFAULTS, toolCompletions: false, approvals: false })
    expect(onDisk()).toMatchObject({ theme: 'graphite' })
  })

  it('writes nothing when every switch offered is already saved, and ignores unknown keys', () => {
    store({ notify: { approvals: true } })
    const before = fs.readFileSync(file(), 'utf8')

    expect(adoptLegacyNotify({ approvals: false, sound: false }).notify).toEqual(NOTIFY_DEFAULTS)
    expect(fs.readFileSync(file(), 'utf8')).toBe(before)
  })

  it('ignores flags that are null, not an object, or an array, and writes nothing', () => {
    store({ notify: { approvals: false } })
    const before = fs.readFileSync(file(), 'utf8')

    for (const flags of [null, undefined, 'approvals', 42, true, [false, false]]) {
      expect(adoptLegacyNotify(flags).notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false })
    }

    expect(fs.readFileSync(file(), 'utf8')).toBe(before)
  })

  it('takes only keys that are switches of its own, not ones inherited from Object', () => {
    store({ notify: { approvals: true } })
    const before = fs.readFileSync(file(), 'utf8')

    expect(adoptLegacyNotify({ toString: false, constructor: false, hasOwnProperty: false }).notify).toEqual(NOTIFY_DEFAULTS)
    expect(fs.readFileSync(file(), 'utf8')).toBe(before)

    expect(adoptLegacyNotify(JSON.parse('{"__proto__": {"approvals": false}, "taskUpdates": false}')).notify).toEqual({ ...NOTIFY_DEFAULTS, taskUpdates: false })
  })

  it('still adopts a switch after an earlier prefs write, such as the theme at start-up', () => {
    writePrefs({ theme: 'graphite' })

    expect(adoptLegacyNotify({ approvals: false }).notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false })
    expect(onDisk()).toMatchObject({ theme: 'graphite', notify: { approvals: false } })
  })

  it('keeps what two windows with their own localStorage each bring, and the first value for a switch both had', () => {
    adoptLegacyNotify({ approvals: false })
    adoptLegacyNotify({ approvals: true, toolCompletions: false })

    expect(readPrefs().notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false, toolCompletions: false })
  })

  it('rejects switch values that are not booleans', () => {
    writePrefs({ theme: 'graphite' })
    const before = fs.readFileSync(file(), 'utf8')

    expect(adoptLegacyNotify({ approvals: 'false', taskUpdates: 0, toolCompletions: null, nativeWhenUnfocused: {} }).notify).toEqual(NOTIFY_DEFAULTS)
    expect(fs.readFileSync(file(), 'utf8')).toBe(before)
  })

  it('does not count a corrupt prefs.json, or one holding null, as having every switch saved', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), '{"notify": {"approvals": fal')
    expect(adoptLegacyNotify({ approvals: false, taskUpdates: false }).notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false, taskUpdates: false })

    fs.writeFileSync(file(), 'null')
    expect(adoptLegacyNotify({ toolCompletions: false }).notify).toEqual({ ...NOTIFY_DEFAULTS, toolCompletions: false })
    expect(onDisk().notify).toEqual({ toolCompletions: false })
  })
})
