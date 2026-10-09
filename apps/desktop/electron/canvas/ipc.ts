import { BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, type WebContents } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseManifest } from '../../shared/canvas/comp-format.ts'
import { CANVAS_IMAGE_EXTENSIONS, CONVERTED_IMAGE_EXTENSIONS, isLayeredImage, isProjectPath, PROJECT_EXTENSION, projectContaining } from '../../shared/canvas/files.ts'
import {
  type CanvasChangedEvent,
  type CanvasFetched,
  type CanvasFilePart,
  type CanvasPasted,
  type CanvasPresence,
  type CanvasProject,
  type CanvasRawImage,
  type CanvasSaveKind,
  type CanvasStreamKind,
  type CanvasWrite,
  IPC
} from '../../shared/ipc.ts'
import { assertWritable, normalizeUserPath } from '../ipc/fs.ts'
import { whileOpen, WindowWatches } from '../ipc/watches.ts'
import { log } from '../log.ts'
import { convertToPng } from './convert.ts'
import { type PackageContents, PackageWatcher, readAsset, readPackage, writePackage } from './package-io.ts'
import { decodePng, encodePng, PngStream, toChannels } from './png.ts'

const MAX_IMAGE_BYTES = 512 * 1024 * 1024

/** The largest layered file (PSD, PSB) Herald Canvas opens: what its reader can hold in memory. */
const MAX_LAYERED_BYTES = 2 * 1024 * 1024 * 1024

/** The most one part of a file read or written in parts may hold (a message must stay well under Chromium's limit). */
const MAX_PART_BYTES = 64 * 1024 * 1024

/** The largest colour table read: a 65-entry `.cube` written with plenty of digits. */
const MAX_TABLE_BYTES = 64 * 1024 * 1024

/** The largest export: PNG and JPEG sides, and pixels in all. */
const MAX_EXPORT_SIDE = 65_535
const MAX_EXPORT_PIXELS = 1_000_000_000

/**
 * A PNG as exact pixels when it decodes here (a browser canvas would round semi-transparent
 * colours), otherwise its bytes for the window to decode.
 */
function pixelsOrBytes(bytes: Uint8Array, channels: 1 | 4): CanvasRawImage | Uint8Array {
  try {
    const image = decodePng(bytes)

    return { width: image.width, height: image.height, channels, data: toChannels(image, channels) }
  } catch {
    return bytes
  }
}

/** A project Herald may read and write: a `.comp` folder in the home folder (or /tmp), outside protected places. */
export function projectPath(target: string): string {
  const dir = assertWritable(String(target)).replace(/[/\\]+$/, '')

  if (!isProjectPath(dir)) {
    throw new Error(`A Herald Canvas project is a folder whose name ends in ${PROJECT_EXTENSION}`)
  }

  return dir
}

/** An image Herald may open as a new project. */
function imagePath(target: string): string {
  const file = assertWritable(String(target))

  if (!CANVAS_IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
    throw new Error(`Herald Canvas does not open ${path.extname(file) || 'this kind of file'}`)
  }

  return file
}

const toProject = (dir: string, contents: PackageContents): CanvasProject => ({ path: dir, manifest: contents.manifest, assets: contents.assets, digest: contents.digest })

/** A layered file Herald may read (a PSD or PSB in the home folder or /tmp). */
function layeredPath(target: string): string {
  const file = assertWritable(String(target))

  if (!isLayeredImage(file)) {
    throw new Error(`${path.basename(file)} is not a Photoshop document`)
  }

  return file
}

/** Files being written in parts: the place they go, the temporary file they grow in, and how they are written. */
interface Stream {
  file: string
  partial: string
  png?: PngStream
  handle?: fs.FileHandle
  /** Takes the export's close listener off its window. */
  release: () => void
}

const streams = new Map<string, Stream>()

async function abortStream(id: string): Promise<void> {
  const stream = streams.get(id)
  streams.delete(id)

  if (stream) {
    stream.release()
    await (stream.png ? stream.png.abort() : stream.handle?.close().catch(() => {}))
    await fs.rm(stream.partial, { force: true })
  }
}

interface Watch {
  watcher: PackageWatcher
  dir: string
}

const watches = new WindowWatches<Watch>()

const SAVE_FILTERS: Record<CanvasSaveKind, Electron.FileFilter[]> = {
  project: [{ name: 'Herald Canvas project', extensions: ['comp'] }],
  png: [{ name: 'PNG image', extensions: ['png'] }],
  jpeg: [{ name: 'JPEG image', extensions: ['jpg', 'jpeg'] }],
  webp: [{ name: 'WebP image', extensions: ['webp'] }],
  psd: [{ name: 'Photoshop document', extensions: ['psd'] }]
}

const SAVE_EXTENSION: Record<CanvasSaveKind, string> = { project: '.comp', png: '.png', jpeg: '.jpg', webp: '.webp', psd: '.psd' }

function windowFor(sender: WebContents, fallback: () => BrowserWindow | null): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(sender) ?? fallback() ?? undefined
}

export function registerCanvasIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.canvasPickOpen, async event => {
    const parent = windowFor(event.sender, getWindow)
    const options: Electron.OpenDialogOptions = {
      title: 'Open in Herald Canvas',
      defaultPath: path.join(os.homedir(), 'Pictures'),
      // On Linux a dialog picks files or folders, not both: pick a file inside a project to open it.
      properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
      filters: [{ name: 'Projects and images', extensions: ['comp', 'json', ...[...CANVAS_IMAGE_EXTENSIONS].map(ext => ext.slice(1))] }]
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const picked = result.canceled ? null : result.filePaths[0]

    return picked ? (projectContaining(picked) ?? picked) : null
  })

  ipcMain.handle(IPC.canvasPickSave, async (event, kind: CanvasSaveKind, suggestedName: string) => {
    const parent = windowFor(event.sender, getWindow)
    const extension = SAVE_EXTENSION[kind] ?? '.png'
    const name = `${String(suggestedName || 'Untitled').replace(/[/\\]/g, '-')}${extension}`
    const options: Electron.SaveDialogOptions = { title: kind === 'project' ? 'Save project' : 'Export', defaultPath: path.join(os.homedir(), 'Pictures', name), filters: SAVE_FILTERS[kind] }
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)

    if (result.canceled || !result.filePath) {
      return null
    }

    return result.filePath.toLowerCase().endsWith(extension) ? result.filePath : `${result.filePath}${extension}`
  })

  ipcMain.handle(IPC.canvasRead, async (_event, target: string) => {
    const dir = projectPath(target)

    return toProject(dir, await readPackage(dir))
  })

  ipcMain.handle(IPC.canvasReadAsset, async (_event, target: string, name: string) => {
    const asset = String(name)

    const bytes = await readAsset(projectPath(target), asset)

    return asset.endsWith('.png') ? pixelsOrBytes(bytes, asset.endsWith('.mask.png') ? 1 : 4) : bytes
  })

  ipcMain.handle(IPC.canvasWrite, async (event, target: string, request: CanvasWrite) => {
    const dir = projectPath(target)
    const write = () => writePackage(dir, { manifest: parseManifest(request.manifest), assets: request.assets ?? {}, preview: request.preview })
    // This window's own save is not an outside change for it; other windows on the project still reload.
    const own = watches.find(event.sender, watch => watch.dir === dir)

    return own ? own.watcher.ownWrite(write) : write()
  })

  ipcMain.handle(IPC.canvasReadImage, async (_event, target: string) => {
    const file = imagePath(target)
    const stat = await fs.stat(file)

    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) {
      throw new Error(`${path.basename(file)} is too large to open`)
    }

    // Photoshop documents normally open in the window with their layers; asked for as one picture, the system flattens them.
    if (CONVERTED_IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()) || isLayeredImage(file)) {
      return pixelsOrBytes(await convertToPng(file), 4)
    }

    return pixelsOrBytes(new Uint8Array(await fs.readFile(file)), 4)
  })

  ipcMain.handle(IPC.canvasReadTable, async (_event, target: string): Promise<Uint8Array> => {
    const file = assertWritable(String(target))

    if (path.extname(file).toLowerCase() !== '.cube') {
      throw new Error(`${path.basename(file)} is not a .cube colour table`)
    }

    const stat = await fs.stat(file)

    if (!stat.isFile() || stat.size > MAX_TABLE_BYTES) {
      throw new Error(`${path.basename(file)} is larger than a colour table can be (${MAX_TABLE_BYTES / 1024 / 1024} MB)`)
    }

    return new Uint8Array(await fs.readFile(file))
  })

  ipcMain.handle(IPC.canvasReadPart, async (_event, target: string, offset: number, length: number): Promise<CanvasFilePart> => {
    const file = layeredPath(target)
    const handle = await fs.open(file, 'r')

    try {
      const { size } = await handle.stat()

      if (size > MAX_LAYERED_BYTES) {
        throw new Error(`${path.basename(file)} is larger than ${MAX_LAYERED_BYTES / 1024 ** 3} GB, more than Herald Canvas opens`)
      }

      const start = Math.max(0, Math.min(size, Math.floor(Number(offset) || 0)))
      const count = Math.max(0, Math.min(MAX_PART_BYTES, Math.floor(Number(length) || 0), size - start))
      const bytes = new Uint8Array(count)
      await handle.read(bytes, 0, count, start)

      return { size, bytes }
    } finally {
      await handle.close()
    }
  })

  ipcMain.handle(IPC.canvasStreamBegin, async (event, target: string, kind: CanvasStreamKind) => {
    const file = assertWritable(String(target))
    await fs.mkdir(path.dirname(file), { recursive: true })
    const id = crypto.randomUUID()
    const partial = `${file}.${id.slice(0, 8)}.part`

    const stream: Stream = { file, partial, release: () => {} }

    if (kind?.kind === 'png') {
      const { width, height } = kind

      if (width > MAX_EXPORT_SIDE || height > MAX_EXPORT_SIDE || width * height > MAX_EXPORT_PIXELS) {
        throw new Error(`An export is at most ${MAX_EXPORT_SIDE.toLocaleString('en')} pixels a side and ${(MAX_EXPORT_PIXELS / 1e9).toLocaleString('en')} billion in all`)
      }

      stream.png = await PngStream.open(partial, width, height, 4, kind.ppi)
    } else {
      stream.handle = await fs.open(partial, 'w')
    }

    streams.set(id, stream)
    // A window that closes mid-export leaves no half-written file behind.
    stream.release = whileOpen(event.sender, () => void abortStream(id))

    return id
  })

  ipcMain.handle(IPC.canvasStreamWrite, async (_event, id: string, bytes: Uint8Array) => {
    const stream = streams.get(String(id))

    if (!stream) {
      throw new Error('That export is no longer being written')
    }

    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_PART_BYTES * 2) {
      throw new Error('An export part must be bytes, at most 128 MB')
    }

    try {
      await (stream.png ? stream.png.write(bytes) : stream.handle!.write(bytes))
    } catch (error) {
      await abortStream(String(id))
      throw error
    }
  })

  ipcMain.handle(IPC.canvasStreamEnd, async (_event, id: string) => {
    const stream = streams.get(String(id))

    if (!stream) {
      throw new Error('That export is no longer being written')
    }

    try {
      await (stream.png ? stream.png.finish() : stream.handle!.close())
      streams.delete(String(id))
      stream.release()
      await fs.rename(stream.partial, stream.file)
    } catch (error) {
      await abortStream(String(id))
      throw error
    }

    return stream.file
  })

  ipcMain.handle(IPC.canvasStreamAbort, (_event, id: string) => abortStream(String(id)))

  ipcMain.handle(IPC.canvasWriteFile, async (_event, target: string, data: Uint8Array | CanvasRawImage, ppi?: number) => {
    const file = assertWritable(String(target))
    const bytes = data instanceof Uint8Array ? data : encodePng(data as CanvasRawImage & { channels: 1 | 4 }, ppi)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, bytes)

    return file
  })

  ipcMain.handle(IPC.canvasWatch, async (event, target: string, loaded?: string) => {
    const dir = projectPath(target)
    const owner = event.sender
    const watchId = crypto.randomUUID()
    const contents = await readPackage(dir)
    const send = (changed: PackageContents) => {
      if (!owner.isDestroyed()) {
        owner.send(IPC.canvasChanged, { watchId, project: toProject(dir, changed) } satisfies CanvasChangedEvent)
      }
    }
    // Compared with the version the window loaded, so a save landing between its read and this watch still arrives.
    const watcher = new PackageWatcher(dir, typeof loaded === 'string' && loaded ? loaded : contents.digest, send)
    watcher.start()

    if (typeof loaded === 'string' && loaded && loaded !== contents.digest) {
      setTimeout(() => void watcher.check(), 0)
    }
    watches.add(watchId, owner, { watcher, dir }, () => watcher.stop())
    log('canvas', `watching ${dir}`)

    return watchId
  })

  ipcMain.handle(IPC.canvasUnwatch, (event, watchId: string) => {
    watches.remove(String(watchId), event.sender)
  })

  ipcMain.handle(IPC.canvasExists, async (_event, target: string) => {
    try {
      const stat = await fs.stat(normalizeUserPath(String(target)))

      return stat.isDirectory() ? 'directory' : 'file'
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.canvasFetch, async (_event, address: string) => fetchImage(String(address)))

  ipcMain.on(IPC.canvasReport, (event, report: Omit<CanvasPresence, 'at'> & { focused?: boolean }) => {
    const id = event.sender.id
    const known = presence.get(id)

    if (!known) {
      event.sender.once('destroyed', () => presence.delete(id))
    }

    presence.set(id, { active: report.active ?? null, documents: Array.isArray(report.documents) ? report.documents : [], at: report.focused || !known ? Date.now() : known.at })
  })

  ipcMain.handle(IPC.canvasPresence, () => [...presence.values()].sort((a, b) => b.at - a.at))

  ipcMain.handle(IPC.canvasCopyImage, async (_event, image: CanvasRawImage) => {
    const png = encodePng({ width: image.width, height: image.height, channels: image.channels === 1 ? 1 : 4, data: image.data })
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
    // Read back the way Paste reads, so the comparison holds however the system stores images.
    ownCopy = digestOf(await clipboardImage())
  })

  ipcMain.handle(IPC.canvasPasteImage, async (): Promise<CanvasPasted | null> => {
    const bytes = await clipboardImage()

    if (!bytes) {
      return null
    }

    return { image: pixelsOrBytes(bytes, 4), own: ownCopy !== null && digestOf(bytes) === ownCopy }
  })
}

/** A digest of what Herald Canvas last put on the clipboard, to tell its own copies from other apps'. */
let ownCopy: string | null = null

const digestOf = (bytes: Uint8Array | null): string | null => (bytes ? crypto.createHash('sha256').update(bytes).digest('hex') : null)

/** The clipboard's image as PNG bytes, or null when it holds none. */
async function clipboardImage(): Promise<Uint8Array | null> {
  for (const item of await clipboard.read()) {
    const type = item.types.find((entry) => entry === 'image/png') ?? item.types.find((entry) => entry.startsWith('image/'))

    if (type) {
      const blob = (await item.getType(type)) as Blob
      const bytes = new Uint8Array(await blob.arrayBuffer())

      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new Error('The image on the clipboard is too large')
      }

      return bytes
    }
  }

  return null
}

/** What each Canvas window has open, by its web contents. */
const presence = new Map<number, CanvasPresence>()

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024

/** An image from the web for a new layer: http(s) only, limited in size and time. */
export async function fetchImage(address: string): Promise<CanvasFetched> {
  const url = new URL(address)

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Images come from http or https addresses')
  }

  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) })

  if (!response.ok || !response.body) {
    throw new Error(`${url.host} answered ${response.status}`)
  }

  const declared = Number(response.headers.get('content-length') ?? 0)

  if (declared > MAX_DOWNLOAD_BYTES) {
    throw new Error('That image is larger than 100 MB')
  }

  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()

  for (;;) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

    total += value.byteLength

    if (total > MAX_DOWNLOAD_BYTES) {
      await reader.cancel()
      throw new Error('That image is larger than 100 MB')
    }

    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0

  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  const type = response.headers.get('content-type') ?? ''
  const svg = type.includes('svg') || url.pathname.toLowerCase().endsWith('.svg')

  return { image: svg ? bytes : pixelsOrBytes(bytes, 4), svg }
}
