import { BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import type { CalcChange, CalcPrefs } from '../../shared/calc.ts'
import { IPC } from '../../shared/ipc.ts'
import { HistoryStore } from './history.ts'
import { NotesStore } from './notes.ts'
import { RatesService } from './rates.ts'

export interface CalcIpcOptions {
  /** Herald Calc's folder: `calc` in Herald's data folder. */
  dir: string
  /** Herald Calc's preferences as saved now (readPrefs().calc). */
  prefs: () => Partial<CalcPrefs> | undefined
  fetch?: typeof fetch
  now?: () => number
}

/** Every window hears what changed, the one that changed it too. */
function broadcast(what: CalcChange): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(IPC.calcChanged, what)
    }
  }
}

/** What a window may ask of the rates: only `true` asks for the cache or a refresh. */
function ratesOptions(raw: unknown): { cached: boolean; refresh: boolean } {
  const options = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}

  return { cached: options.cached === true, refresh: options.refresh === true }
}

/**
 * Herald Calc's side of main (shared/calc.ts CalcBridge): the currency rates, the notes and the
 * history in Herald's data folder, each store checking what a window sends, and IPC.calcChanged
 * to every window after a change.
 */
export function registerCalcIpc({ dir, prefs, fetch, now }: CalcIpcOptions) {
  const rates = new RatesService({ file: path.join(dir, 'rates.json'), prefs, fetch, now, onChange: () => broadcast('rates') })
  const notes = new NotesStore({ dir: path.join(dir, 'notes'), now, onChange: () => broadcast('notes') })
  const history = new HistoryStore({ file: path.join(dir, 'history.json'), now, onChange: () => broadcast('history') })

  ipcMain.handle(IPC.calcRates, (_event, options: unknown) => rates.get(ratesOptions(options)))
  ipcMain.handle(IPC.calcNotesList, () => notes.list())
  ipcMain.handle(IPC.calcNoteRead, (_event, id: unknown) => notes.read(id))
  ipcMain.handle(IPC.calcNoteSave, (_event, note: unknown) => notes.save(note))
  ipcMain.handle(IPC.calcNoteDelete, (_event, id: unknown) => notes.remove(id))
  ipcMain.handle(IPC.calcHistory, (_event, limit: unknown) => history.list(limit))
  ipcMain.handle(IPC.calcHistoryAdd, (_event, entries: unknown) => history.add(entries))
  ipcMain.handle(IPC.calcHistoryClear, () => history.clear())

  return { rates, notes, history }
}
