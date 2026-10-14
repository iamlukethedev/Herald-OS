import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IPC } from '../shared/ipc.ts'
import { NOTIFY_DEFAULTS } from '../shared/notify-prefs.ts'
import { handleAdoptLegacyNotify, type PrefsWindow, sendPrefsToOthers } from './prefs-ipc.ts'
import { readPrefs, writePrefs } from './prefs.ts'

const saved = process.env.HERMES_HOME
let root = ''

function fakeWindow() {
  const sent: { channel: string; payload: unknown }[] = []
  const win: PrefsWindow = { webContents: { send: (channel, payload) => void sent.push({ channel, payload }) } }

  return { win, sent }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-prefs-ipc-'))
  process.env.HERMES_HOME = root
})

afterEach(() => {
  if (saved === undefined) {
    delete process.env.HERMES_HOME
  } else {
    process.env.HERMES_HOME = saved
  }

  fs.rmSync(root, { recursive: true, force: true })
})

describe('prefs.adoptLegacyNotify over IPC', () => {
  it('saves the adopted switches and sends the result to every other window, not the one that asked', () => {
    writePrefs({ theme: 'graphite' })
    const asking = fakeWindow()
    const other = fakeWindow()
    const third = fakeWindow()

    const next = handleAdoptLegacyNotify([asking.win, other.win, third.win], asking.win.webContents, { approvals: false })

    expect(next.notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false })
    expect(readPrefs().notify).toEqual(next.notify)
    expect(asking.sent).toEqual([])
    expect(other.sent).toEqual([{ channel: IPC.prefsChanged, payload: next }])
    expect(third.sent).toEqual([{ channel: IPC.prefsChanged, payload: next }])
  })

  it('still answers with, and sends, the saved prefs when there was nothing to adopt', () => {
    writePrefs({ notify: { approvals: true } })
    const asking = fakeWindow()
    const other = fakeWindow()

    const next = handleAdoptLegacyNotify([asking.win, other.win], asking.win.webContents, { approvals: false })

    expect(next.notify.approvals).toBe(true)
    expect(other.sent.map(entry => entry.payload)).toEqual([next])
  })
})

describe('sendPrefsToOthers', () => {
  it('skips only the sender', () => {
    const a = fakeWindow()
    const b = fakeWindow()
    const prefs = readPrefs()

    sendPrefsToOthers([a.win, b.win], b.win.webContents, prefs)

    expect(a.sent).toEqual([{ channel: IPC.prefsChanged, payload: prefs }])
    expect(b.sent).toEqual([])
  })
})
