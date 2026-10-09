import { BrowserWindow, dialog, ipcMain, type WebContents, webContents } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { dialogFilters, extensionOf, OFFICE_APP_NAMES, OFFICE_APPS, OFFICE_NOUNS, type OfficeAbilities, type OfficeApp, openFormats, saveFormats } from '../../shared/office/files.ts'
import { IPC, type OfficeChangedEvent, type OfficeFileData, type OfficePdfRequest, type OfficePresence, type OfficePrintRequest, type OfficePrintResult, type OfficeRunReply, type OfficeRunRequest, type OfficeSaveTarget, type OfficeWriteResult } from '../../shared/ipc.ts'
import { assertWritable } from '../ipc/fs.ts'
import { log } from '../log.ts'
import { heraldOsDataDir } from '../paths.ts'
import { OfficeBackups } from './backups.ts'
import { convertWithLibreOffice, findSoffice } from './convert.ts'
import { digestOfBytes, FileWatcher, stampOf } from './file-watch.ts'
import { printOnPaper, printToPdf } from './print.ts'
import { registerSpellingMenus } from './spelling.ts'
import { OfficeTemplates } from './templates.ts'
import { OfficeWatches } from './watches.ts'

/** The largest Office file Herald opens or writes. */
const MAX_OFFICE_BYTES = 512 * 1024 * 1024

const isApp = (value: unknown): value is OfficeApp => OFFICE_APPS.includes(value as OfficeApp)

/** An Office file Herald may read and write: in the home folder (or /tmp), outside protected places. */
function officePath(target: unknown): string {
  return assertWritable(String(target))
}

async function abilities(): Promise<OfficeAbilities> {
  return { libreOffice: Boolean(await findSoffice()) }
}

/**
 * Replace `file` with `bytes` in one step: written beside it and renamed over it, so a reader sees
 * the old file or the new one, never half of one. The new file keeps the old one's permissions.
 */
async function atomicWrite(file: string, bytes: Uint8Array): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID().slice(0, 8)}.tmp`)
  const before = await fs.stat(file).catch(() => null)

  try {
    await fs.writeFile(temporary, bytes, { mode: before ? before.mode & 0o777 : 0o644 })
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true })
    throw error
  }
}

const watches = new OfficeWatches()

/** What each Office window has open, by web contents and app (desktop mode has all three in one window). */
const presence = new Map<string, OfficePresence>()

/** Office commands load, change and write whole files. */
const RUN_TIMEOUT_MS = 90_000
const runs = new Map<string, { resolve: (reply: OfficeRunReply) => void; timer: ReturnType<typeof setTimeout> }>()
let runCounter = 0

/** The window that reported `key` open in `app` (panels mode has one window per app). */
function ownerOf(app: OfficeApp, key: string): WebContents | null {
  for (const [id, entry] of presence) {
    if (entry.app === app && entry.documents.some((doc) => doc.key === key)) {
      const owner = webContents.fromId(Number(id.split(':')[0]))

      return owner && !owner.isDestroyed() ? owner : null
    }
  }

  return null
}

/** Web contents whose closing already clears their presence: one listener each, however often they report. */
const reporting = new WeakSet<WebContents>()

function windowFor(sender: WebContents, fallback: () => BrowserWindow | null): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(sender) ?? fallback() ?? undefined
}

const documentsFolder = () => path.join(os.homedir(), 'Documents')

/** Ask where a PDF goes, over the window that asked; null when the person cancels. */
async function pickPdf(parent: BrowserWindow | undefined, title: string, suggestedName: string): Promise<string | null> {
  const name = `${String(suggestedName || 'Untitled').replace(/[/\\]/g, '-').replace(/\.pdf$/i, '')}.pdf`
  const options: Electron.SaveDialogOptions = { title, defaultPath: path.join(documentsFolder(), name), filters: [{ name: 'PDF', extensions: ['pdf'] }] }
  const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)

  return picked.canceled || !picked.filePath ? null : picked.filePath
}

/** Write the PDF `render` makes at `target` (.pdf added when it has none), once the place is allowed. */
async function writePdf(target: string, render: () => Promise<Uint8Array>): Promise<string> {
  const file = officePath(target.toLowerCase().endsWith('.pdf') ? target : `${target}.pdf`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await atomicWrite(file, await render())

  return file
}

export function registerOfficeIpc(getWindow: () => BrowserWindow | null): void {
  const backups = new OfficeBackups(path.join(heraldOsDataDir(), 'office-backups'))
  registerSpellingMenus()

  ipcMain.handle(IPC.officeAbilities, () => abilities())

  ipcMain.handle(IPC.officePickOpen, async (event, app: OfficeApp): Promise<string[]> => {
    if (!isApp(app)) {
      throw new Error(`${String(app)} is not a Herald Office app`)
    }

    const formats = openFormats(app, await abilities())

    if (!formats.length) {
      return []
    }

    const parent = windowFor(event.sender, getWindow)
    const options: Electron.OpenDialogOptions = { title: `Open a ${OFFICE_NOUNS[app]}`, defaultPath: documentsFolder(), properties: ['openFile', 'multiSelections'], filters: dialogFilters(formats) }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)

    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(IPC.officePickSave, async (event, app: OfficeApp, suggestedName: string, preferred?: string): Promise<OfficeSaveTarget | null> => {
    if (!isApp(app)) {
      throw new Error(`${String(app)} is not a Herald Office app`)
    }

    const formats = saveFormats(app, await abilities())
    const first = formats.find((format) => format.extension === preferred) ?? formats[0]

    if (!first) {
      throw new Error(`Herald Office cannot save ${OFFICE_NOUNS[app]}s yet`)
    }

    const ordered = [first, ...formats.filter((format) => format !== first)]
    const name = `${String(suggestedName || 'Untitled').replace(/[/\\]/g, '-')}${first.extension}`
    const parent = windowFor(event.sender, getWindow)
    const options: Electron.SaveDialogOptions = { title: 'Save as', defaultPath: path.join(documentsFolder(), name), filters: ordered.map((format) => ({ name: format.label, extensions: [format.extension.slice(1)] })) }
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)

    if (result.canceled || !result.filePath) {
      return null
    }

    const chosen = formats.find((format) => format.extension === extensionOf(result.filePath!))

    return chosen ? { path: result.filePath, extension: chosen.extension } : { path: `${result.filePath}${first.extension}`, extension: first.extension }
  })

  ipcMain.handle(IPC.officeRead, async (_event, target: string): Promise<OfficeFileData> => {
    const file = officePath(target)
    const stat = await fs.stat(file)

    if (!stat.isFile()) {
      throw new Error(`${path.basename(file)} is not a file`)
    }

    if (stat.size > MAX_OFFICE_BYTES) {
      throw new Error(`${path.basename(file)} is larger than ${MAX_OFFICE_BYTES / 1024 / 1024} MB, more than Herald Office opens`)
    }

    const bytes = new Uint8Array(await fs.readFile(file))

    return { path: file, bytes, digest: digestOfBytes(bytes), size: bytes.byteLength, modifiedAt: stat.mtimeMs }
  })

  ipcMain.handle(IPC.officeWrite, async (event, target: string, bytes: Uint8Array, options: { backup?: boolean } = {}): Promise<OfficeWriteResult> => {
    const file = officePath(target)

    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_OFFICE_BYTES) {
      throw new Error(`An Office file is bytes, at most ${MAX_OFFICE_BYTES / 1024 / 1024} MB`)
    }

    await fs.mkdir(path.dirname(file), { recursive: true })
    const backup = options.backup === false ? null : await backups.before(file)
    const digest = digestOfBytes(bytes)
    const write = async () => {
      await atomicWrite(file, bytes)

      return digest
    }
    // This window's own save is not an outside change for it; other windows on the file still reload.
    const own = watches.find(file, event.sender)
    await (own ? own.ownWrite(write) : write())

    if (backup) {
      log('office', `backed up ${path.basename(file)} to ${backup}`)
    }

    return { digest, backup }
  })

  ipcMain.handle(IPC.officeWatch, async (event, target: string, loaded?: string | null): Promise<string> => {
    const file = officePath(target)
    const owner = event.sender
    const watchId = crypto.randomUUID()
    const current = await stampOf(file)
    const send = (digest: string | null) => {
      if (!owner.isDestroyed()) {
        owner.send(IPC.officeChanged, { watchId, path: file, digest } satisfies OfficeChangedEvent)
      }
    }
    // Compared with the version the window loaded, so a save landing between its read and this watch still arrives.
    const known = typeof loaded === 'string' && loaded ? loaded : (current?.digest ?? null)
    const watcher = new FileWatcher(file, known, send)
    watcher.start()

    if (known !== (current?.digest ?? null)) {
      setTimeout(() => void watcher.check(), 0)
    }

    watches.add(watchId, owner, file, watcher)

    return watchId
  })

  ipcMain.handle(IPC.officeUnwatch, (event, watchId: string) => {
    watches.remove(String(watchId), event.sender)
  })

  ipcMain.on(IPC.officeReport, (event, report: Omit<OfficePresence, 'at'> & { focused?: boolean }) => {
    if (!isApp(report?.app)) {
      return
    }

    const sender = event.sender
    const key = `${sender.id}:${report.app}`
    const known = presence.get(key)

    if (!reporting.has(sender)) {
      const id = sender.id
      reporting.add(sender)
      sender.once('destroyed', () => {
        for (const app of OFFICE_APPS) {
          presence.delete(`${id}:${app}`)
        }
      })
    }

    const documents = Array.isArray(report.documents) ? report.documents : []

    if (!documents.length) {
      presence.delete(key)

      return
    }

    presence.set(key, { app: report.app, active: report.active ?? null, documents, at: report.focused || !known ? Date.now() : known.at })
  })

  ipcMain.handle(IPC.officePresence, () => [...presence.values()].sort((a, b) => b.at - a.at))

  ipcMain.on(IPC.officeRunReply, (_event, reply: OfficeRunReply) => {
    const pending = runs.get(String(reply?.requestId))

    if (pending) {
      clearTimeout(pending.timer)
      runs.delete(String(reply.requestId))
      pending.resolve(reply)
    }
  })

  ipcMain.handle(IPC.officeRun, async (event, target: { app: OfficeApp; key: string }, command: string, args: Record<string, unknown>, source: OfficeRunRequest['source']): Promise<unknown> => {
    const owner = isApp(target?.app) ? ownerOf(target.app, String(target.key)) : null

    if (!owner || owner === event.sender) {
      throw new Error('That document is no longer open in a Herald Office window')
    }

    const requestId = `office-run-${++runCounter}`
    const reply = await new Promise<OfficeRunReply>((resolve) => {
      const timer = setTimeout(() => {
        runs.delete(requestId)
        resolve({ requestId, error: `The ${OFFICE_APP_NAMES[target.app]} window did not answer in time` })
      }, RUN_TIMEOUT_MS)
      runs.set(requestId, { resolve, timer })
      owner.send(IPC.officeRunRequest, { requestId, command: String(command), args: args && typeof args === 'object' ? args : {}, source } satisfies OfficeRunRequest)
    })

    if (reply.error) {
      throw new Error(reply.error)
    }

    return reply.result
  })

  ipcMain.handle(IPC.officeExportPdf, async (event, request: OfficePdfRequest): Promise<string | null> => {
    const named = typeof request?.path === 'string' && request.path ? request.path : null
    const target = named ?? (await pickPdf(windowFor(event.sender, getWindow), 'Export as PDF', String(request?.suggestedName || 'Untitled')))

    return target ? writePdf(target, () => printToPdf(request)) : null
  })

  ipcMain.handle(IPC.officePrint, (event, request: OfficePrintRequest): Promise<OfficePrintResult> =>
    printOnPaper(request, undefined, {
      pick: (name) => pickPdf(windowFor(event.sender, getWindow), 'Print to File', name),
      write: async (file, render) => {
        await writePdf(file, render)
      }
    })
  )

  ipcMain.handle(IPC.officeConvert, async (_event, target: string, to: string) => convertWithLibreOffice(officePath(target), String(to)))

  const templates = new OfficeTemplates(path.join(heraldOsDataDir(), 'office-templates'))
  ipcMain.handle(IPC.officeTemplates, (_event, app: OfficeApp) => templates.list(app))
  ipcMain.handle(IPC.officeTemplateSave, (_event, app: OfficeApp, name: unknown, model: unknown, id?: unknown) => templates.save(app, name, model, id))
  ipcMain.handle(IPC.officeTemplateRename, (_event, app: OfficeApp, id: unknown, name: unknown) => templates.rename(app, id, name))
  ipcMain.handle(IPC.officeTemplateRemove, (_event, app: OfficeApp, id: unknown) => templates.remove(app, id))
}
