import { BrowserWindow, ipcMain, session, type WebContents, WebContentsView } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { IPC, type WebOpenOptions, type WebViewBounds, type WebViewEvent } from '../../shared/ipc.ts'
import { isViewable } from '../../shared/viewer.ts'
import { log } from '../log.ts'
import { READ_FLAGS, assertPreviewFolder, assertReadable, openChecked } from './fs.ts'

/*
 * Embedded web pages. Herald OS is a whole environment, so a web page (the provider sign-in portal,
 * for now) opens inside it rather than in the system browser. In desktop mode the page is a
 * `WebContentsView` layered over the shell window; the renderer's window manager draws the frame and
 * streams the content rect here so the page sits exactly inside it. In panels mode (niri) there is
 * no single desktop window, so the page gets a real compositor window instead.
 *
 * The guest is locked down: sandboxed, isolated, no Node, no preload, its own storage partition with
 * every permission denied, http(s) only, popups denied (same-origin ones navigate the same view).
 */

export const WEB_PARTITION = 'persist:herald-web'
const VIEWER_PARTITION = 'persist:herald-viewer'
const DETACHED_SIZE = { width: 1000, height: 720 }

const isHttp = (url: string): boolean => /^https?:\/\//i.test(url)

interface EmbeddedView {
  kind: 'view'
  id: string
  view: WebContentsView
  host: BrowserWindow
  owner: WebContents
}

interface DetachedView {
  kind: 'window'
  id: string
  win: BrowserWindow
  owner: WebContents
}

type Entry = EmbeddedView | DetachedView

export const GUEST_PREFERENCES: Electron.WebPreferences = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  plugins: false,
  spellcheck: false,
  partition: WEB_PARTITION
}

/** Local files: same lockdown, own partition, plus Chromium's PDF viewer plugin. */
const VIEWER_PREFERENCES: Electron.WebPreferences = { ...GUEST_PREFERENCES, plugins: true, partition: VIEWER_PARTITION }

/** Studio previews of the site Hermes is building: same lockdown, own partition so dev-server state never mixes with browsing. */
const PREVIEW_PARTITION = 'persist:herald-preview'
const PREVIEW_PREFERENCES: Electron.WebPreferences = { ...GUEST_PREFERENCES, partition: PREVIEW_PARTITION }

/** A preview may show http(s) pages and local files inside the project folder, nothing else. */
function previewAllows(url: string, root: string | null): boolean {
  if (isHttp(url)) {
    return true
  }

  if (!root || !url.startsWith('file://')) {
    return false
  }

  try {
    return isInside(path.normalize(decodeURIComponent(new URL(url).pathname)), root)
  } catch {
    return false
  }
}

function isInside(file: string, folder: string): boolean {
  return file === folder || file.startsWith(folder + path.sep)
}

function resolveHomePath(raw: string): string {
  return path.resolve(raw.replace(/^~(?=\/|$)/, os.homedir()))
}

function realPath(target: string): string {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

export class WebViews {
  private readonly entries = new Map<string, Entry>()
  private readonly hookedOwners = new WeakSet<WebContents>()
  private counter = 0

  /** `embed`: layer views over the sender's window (desktop mode); otherwise open real windows. */
  constructor(private readonly embed: boolean) {}

  register(): void {
    ipcMain.handle(IPC.webOpen, (event, url: string, options: WebOpenOptions = {}) => this.open(event.sender, url, options))
    ipcMain.handle(IPC.webOpenFile, async (event, filePath: string, options: WebOpenOptions = {}) => this.openFile(event.sender, (await assertReadable(String(filePath))).real, options))
    ipcMain.on(IPC.webSetBounds, (event, id: string, bounds: WebViewBounds, visible: boolean) => this.setBounds(event.sender, id, bounds, visible))
    ipcMain.handle(IPC.webClose, (event, id: string) => this.close(id, event.sender))
    ipcMain.handle(IPC.webOpenPreview, (event, target: string, options: WebOpenOptions = {}) => this.openPreview(event.sender, target, options))
    ipcMain.handle(IPC.webNavigate, (event, id: string, target: string) => this.navigate(event.sender, id, target))
    ipcMain.handle(IPC.webReload, (event, id: string) => {
      const contents = this.contentsFor(id, event.sender)
      contents?.reloadIgnoringCache()
    })
  }

  private readonly previewRoots = new Map<string, string | null>()
  private readonly previewFolders = new Map<string, string>()
  private readonly viewerFiles = new Map<string, string>()

  /**
   * A Studio preview: a web page (usually the dev server on localhost) or a local file inside the
   * project folder (`options.root`), for static sites. Links between the project's own pages work.
   */
  async openPreview(owner: WebContents, target: string, options: WebOpenOptions): Promise<string> {
    // Strictly inside the home folder, holding no credential store; every file it serves is checked again on request.
    const folder = typeof options.root === 'string' && options.root ? await assertPreviewFolder(resolveHomePath(options.root)) : null
    const root = folder?.path ?? null

    lockDownPartition(WEB_PARTITION)
    lockDownPartition(PREVIEW_PARTITION)
    confineFiles(PREVIEW_PARTITION, file => [...this.previewFolders.values()].some(folder => isInside(file, folder)))
    this.hookOwner(owner)
    const id = `web-${++this.counter}`
    const host = BrowserWindow.fromWebContents(owner)
    const title = typeof options.title === 'string' ? options.title.slice(0, 200) : 'Preview'
    const entry: Entry = this.embed && host && !host.isDestroyed() ? this.createEmbedded(id, host, owner, PREVIEW_PREFERENCES) : this.createDetached(id, owner, title, PREVIEW_PREFERENCES)
    this.entries.set(id, entry)
    this.previewRoots.set(id, root)

    if (folder) {
      this.previewFolders.set(id, folder.real)
    }
    const contents = entry.kind === 'view' ? entry.view.webContents : entry.win.webContents
    this.guardPreview(id, contents)

    try {
      this.navigate(owner, id, target)
    } catch (error) {
      this.close(id)
      throw error
    }

    log('web', `opened preview ${id} (${entry.kind}) ${target}`)

    return id
  }

  /** Point a preview somewhere else (a new dev-server port, another page of the site). */
  navigate(owner: WebContents, id: string, target: string): void {
    const contents = this.contentsFor(id, owner)

    if (!contents || !this.previewRoots.has(id)) {
      throw new Error('no such preview')
    }

    const root = this.previewRoots.get(id) ?? null
    const url = isHttp(target) ? target : target.startsWith('file://') ? target : pathToFileURL(resolveHomePath(target)).toString()

    if (!previewAllows(url, root)) {
      throw new Error('a preview shows web pages or files inside the project folder')
    }

    void contents.loadURL(url).catch(error => log('web', `${id}: load failed: ${error instanceof Error ? error.message : String(error)}`))
  }

  private guardPreview(id: string, contents: WebContents): void {
    const allowed = (url: string) => previewAllows(url, this.previewRoots.get(id) ?? null)
    contents.setWindowOpenHandler(({ url }) => {
      if (allowed(url)) {
        void contents.loadURL(url).catch(() => undefined)
      }

      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!allowed(url)) {
        event.preventDefault()
      }
    })
    contents.on('will-redirect', (event, url) => {
      if (!allowed(url)) {
        event.preventDefault()
      }
    })
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('page-title-updated', (_event, title) => this.emitFor(id, { id, type: 'title', title }))
    const reportUrl = () => {
      if (!contents.isDestroyed()) {
        this.emitFor(id, { id, type: 'url', url: contents.getURL() })
      }
    }
    contents.on('did-navigate', reportUrl)
    contents.on('did-navigate-in-page', reportUrl)
    contents.on('did-start-loading', () => this.emitFor(id, { id, type: 'loading', loading: true }))
    contents.on('did-stop-loading', () => this.emitFor(id, { id, type: 'loading', loading: false }))
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        this.emitFor(id, { id, type: 'error', error: `${description} (${url})` })
      }
    })
  }

  open(owner: WebContents, url: string, options: WebOpenOptions): string {
    if (typeof url !== 'string' || !isHttp(url)) {
      throw new Error('only http(s) URLs may be opened in a Herald OS web window')
    }

    lockDownPartition(WEB_PARTITION)
    this.hookOwner(owner)
    const id = `web-${++this.counter}`
    const host = BrowserWindow.fromWebContents(owner)
    const title = typeof options.title === 'string' ? options.title.slice(0, 200) : undefined
    const entry: Entry = this.embed && host && !host.isDestroyed() ? this.createEmbedded(id, host, owner) : this.createDetached(id, owner, title)
    this.entries.set(id, entry)
    const contents = entry.kind === 'view' ? entry.view.webContents : entry.win.webContents
    this.guard(id, contents, new URL(url).origin)
    void contents.loadURL(url).catch(error => log('web', `${id}: load failed: ${error instanceof Error ? error.message : String(error)}`))
    log('web', `opened ${id} (${entry.kind}) ${url}`)

    return id
  }

  /** Show a local file (PDF, image, text, media) inside Herald OS; the view can never navigate elsewhere. */
  openFile(owner: WebContents, filePath: string, options: WebOpenOptions): string {
    const resolved = typeof filePath === 'string' ? path.resolve(filePath.replace(/^~(?=\/|$)/, os.homedir())) : ''
    const stat = resolved ? fs.statSync(resolved, { throwIfNoEntry: false }) : undefined

    if (!stat?.isFile()) {
      throw new Error(`${filePath} is not a file`)
    }

    if (!isViewable(resolved)) {
      throw new Error(`Herald OS cannot display ${path.extname(resolved) || 'this kind of'} files yet`)
    }

    this.hookOwner(owner)
    const id = `web-${++this.counter}`
    const host = BrowserWindow.fromWebContents(owner)
    const title = typeof options.title === 'string' ? options.title.slice(0, 200) : path.basename(resolved)
    const entry: Entry = this.embed && host && !host.isDestroyed() ? this.createEmbedded(id, host, owner, VIEWER_PREFERENCES) : this.createDetached(id, owner, title, VIEWER_PREFERENCES)
    this.entries.set(id, entry)
    this.viewerFiles.set(id, realPath(resolved))
    const contents = entry.kind === 'view' ? entry.view.webContents : entry.win.webContents
    lockDownPartition(VIEWER_PARTITION)
    confineFiles(VIEWER_PARTITION, file => [...this.viewerFiles.values()].includes(file))
    const fileUrl = pathToFileURL(resolved).toString()
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // A viewer shows one file: links inside a PDF or page never navigate the view.
    contents.on('will-navigate', (event, url) => {
      if (url !== fileUrl) {
        event.preventDefault()
      }
    })
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('did-start-loading', () => this.emitFor(id, { id, type: 'loading', loading: true }))
    contents.on('did-stop-loading', () => this.emitFor(id, { id, type: 'loading', loading: false }))
    void contents.loadFile(resolved).catch(error => log('web', `${id}: load failed: ${error instanceof Error ? error.message : String(error)}`))
    log('web', `opened ${id} (${entry.kind}) file ${resolved}`)

    return id
  }

  private emitFor(id: string, event: WebViewEvent): void {
    const entry = this.entries.get(id)

    if (entry) {
      this.emit(entry, event)
    }
  }

  setBounds(sender: WebContents, id: string, bounds: WebViewBounds, visible: boolean): void {
    const entry = this.entries.get(id)

    if (!entry || entry.owner !== sender || entry.kind !== 'view' || entry.host.isDestroyed()) {
      return
    }

    // The renderer measures in CSS pixels; the view is placed in device-independent pixels.
    const zoom = entry.host.webContents.getZoomFactor() || 1
    const scale = (value: number) => Math.round(Number(value) * zoom)
    entry.view.setBounds({ x: scale(bounds.x), y: scale(bounds.y), width: Math.max(1, scale(bounds.width)), height: Math.max(1, scale(bounds.height)) })
    // Rounded corners follow the frame (macOS and Windows honour this; elsewhere it is a no-op).
    entry.view.setBorderRadius(Math.max(0, scale(bounds.radius ?? 0)))
    entry.view.setVisible(Boolean(visible))
  }

  close(id: string, sender?: WebContents): void {
    const entry = this.entries.get(id)

    if (!entry || (sender && entry.owner !== sender)) {
      return
    }

    this.entries.delete(id)
    this.previewRoots.delete(id)
    this.previewFolders.delete(id)
    this.viewerFiles.delete(id)

    if (entry.kind === 'view') {
      if (!entry.host.isDestroyed()) {
        entry.host.contentView.removeChildView(entry.view)
      }

      if (!entry.view.webContents.isDestroyed()) {
        entry.view.webContents.close()
      }
    } else if (!entry.win.isDestroyed()) {
      entry.win.close()
    }

    this.emit(entry, { id, type: 'closed' })
    log('web', `closed ${id}`)
  }

  /** The guest contents of a view this owner opened (for typing/editing into a web page). */
  contentsFor(id: string, owner: WebContents): WebContents | null {
    const entry = this.entries.get(id)

    if (!entry || entry.owner !== owner) {
      return null
    }

    const contents = entry.kind === 'view' ? entry.view.webContents : entry.win.webContents

    return contents.isDestroyed() ? null : contents
  }

  closeAll(owner?: WebContents): void {
    for (const [id, entry] of [...this.entries]) {
      if (!owner || entry.owner === owner) {
        this.close(id)
      }
    }
  }

  private createEmbedded(id: string, host: BrowserWindow, owner: WebContents, preferences: Electron.WebPreferences = GUEST_PREFERENCES): EmbeddedView {
    const view = new WebContentsView({ webPreferences: { ...preferences } })
    // Hidden until the renderer reports the frame's content rect, so nothing flashes at (0, 0).
    view.setVisible(false)
    view.setBounds({ x: 0, y: 0, width: 1, height: 1 })
    view.setBackgroundColor('#ffffff')
    host.contentView.addChildView(view)
    view.webContents.on('destroyed', () => this.close(id))

    return { kind: 'view', id, view, host, owner }
  }

  private createDetached(id: string, owner: WebContents, title?: string, preferences: Electron.WebPreferences = GUEST_PREFERENCES): DetachedView {
    const win = new BrowserWindow({
      ...DETACHED_SIZE,
      frame: false,
      title: title ?? 'Herald OS · Web',
      backgroundColor: '#ffffff',
      webPreferences: { ...preferences }
    })
    // The title is the window's identity for the compositor; the page title travels as an event.
    win.on('page-title-updated', event => event.preventDefault())
    win.on('closed', () => this.close(id))

    return { kind: 'window', id, win, owner }
  }

  /** Navigation policy and event mirroring for one guest. */
  private guard(id: string, contents: WebContents, origin: string): void {
    contents.setWindowOpenHandler(({ url }) => {
      // Same-origin popups become navigations of the same view; everything else is denied.
      if (isHttp(url) && new URL(url).origin === origin) {
        void contents.loadURL(url).catch(() => undefined)
      }

      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!isHttp(url)) {
        event.preventDefault()
      }
    })
    contents.on('will-redirect', (event, url) => {
      if (!isHttp(url)) {
        event.preventDefault()
      }
    })
    // No <webview>, no devtools shortcuts, no drag-and-drop file navigation in the guest.
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.key.toLowerCase() === 'i' && input.alt && (input.meta || input.control)))) {
        event.preventDefault()
      }
    })

    const entryFor = () => this.entries.get(id)
    contents.on('page-title-updated', (_event, title) => {
      const entry = entryFor()

      if (entry) {
        this.emit(entry, { id, type: 'title', title })
      }
    })
    const reportUrl = () => {
      const entry = entryFor()

      if (entry && !contents.isDestroyed()) {
        this.emit(entry, { id, type: 'url', url: contents.getURL() })
      }
    }
    contents.on('did-navigate', reportUrl)
    contents.on('did-navigate-in-page', reportUrl)
    contents.on('did-start-loading', () => {
      const entry = entryFor()

      if (entry) {
        this.emit(entry, { id, type: 'loading', loading: true })
      }
    })
    contents.on('did-stop-loading', () => {
      const entry = entryFor()

      if (entry) {
        this.emit(entry, { id, type: 'loading', loading: false })
      }
    })
  }

  private emit(entry: Entry, event: WebViewEvent): void {
    if (!entry.owner.isDestroyed()) {
      entry.owner.send(IPC.webEvent, event)
    }
  }

  /** A renderer that reloads or goes away takes its views with it. */
  private hookOwner(owner: WebContents): void {
    if (this.hookedOwners.has(owner)) {
      return
    }

    this.hookedOwners.add(owner)
    owner.on('did-navigate', () => this.closeAll(owner))
    owner.on('destroyed', () => this.closeAll(owner))
  }
}

const lockedPartitions = new Set<string>()

/** Guest partitions grant nothing: no camera, mic, notifications, clipboard, or downloads. */
export function lockDownPartition(partition: string): void {
  if (lockedPartitions.has(partition)) {
    return
  }

  lockedPartitions.add(partition)
  const guest = session.fromPartition(partition)
  guest.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  guest.setPermissionCheckHandler(() => false)
  guest.setDevicePermissionHandler(() => false)
  guest.on('will-download', event => event.preventDefault())
}

/** A file a confined file:// request is served from: checked, resolved, and open through the verified handle. */
export interface Servable {
  real: string
  handle: FileHandle
  size: number
}

/**
 * The file a confined file:// request is served from, or null: never a credential store, only what `allows` accepts,
 * and opened through openChecked, so what is served is the file that was checked. Only regular files are served; the
 * open does not wait on a FIFO.
 */
export async function servableFile(url: string, allows: (file: string) => boolean): Promise<Servable | null> {
  let checked

  try {
    checked = await assertReadable(fileURLToPath(url))
  } catch {
    // Malformed URLs and credential stores are refused like the rest.
    return null
  }

  if (!allows(checked.real)) {
    return null
  }

  const handle = await openChecked(checked, READ_FLAGS).catch(() => null)
  const stat = await handle?.stat().catch(() => null)

  if (!handle || !stat?.isFile()) {
    await handle?.close()

    return null
  }

  return { real: checked.real, handle, size: stat.size }
}

/** Content types for what previews and viewers load, text in UTF-8; anything else is sent as bytes. */
const WEB_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac'
}

/** The open file as a response: its type from its extension, and one byte range when asked for one (media seeking). */
export function serveOpenFile({ real, handle, size }: Servable, range: string | null): Response {
  const type = WEB_TYPES[path.extname(real).toLowerCase()] ?? 'application/octet-stream'
  const asked = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
  let start = 0
  let end = size - 1

  if (asked && (asked[1] || asked[2])) {
    start = asked[1] ? Number(asked[1]) : Math.max(0, size - Number(asked[2]))
    end = asked[1] && asked[2] ? Math.min(Number(asked[2]), size - 1) : size - 1

    if (start > end) {
      void handle.close()

      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
    }
  }

  const partial = Boolean(asked && (asked[1] || asked[2]))
  const headers: Record<string, string> = { 'content-type': type, 'content-length': String(Math.max(0, end - start + 1)), 'accept-ranges': 'bytes' }

  if (partial) {
    headers['content-range'] = `bytes ${start}-${end}/${size}`
  }

  if (size === 0) {
    void handle.close()

    return new Response(null, { status: 200, headers })
  }

  return new Response(Readable.toWeb(handle.createReadStream({ start, end })) as ReadableStream<Uint8Array>, { status: partial ? 206 : 200, headers })
}

const confinedPartitions = new Set<string>()

/**
 * Electron lets a file:// page read every other file:// URL, so a previewed site or an SVG in the
 * viewer could read ~/.hermes/.env. Here a partition serves only the files `allows` accepts, judged
 * after symlinks resolve, never a credential store, and from the handle that was checked; anything
 * else looks missing.
 */
export function confineFiles(partition: string, allows: (file: string) => boolean): void {
  if (confinedPartitions.has(partition)) {
    return
  }

  confinedPartitions.add(partition)
  session.fromPartition(partition).protocol.handle('file', async request => {
    const file = await servableFile(request.url, allows)

    return file ? serveOpenFile(file, request.headers.get('range')) : new Response(null, { status: 404 })
  })
}

export function registerWebIpc(embed: boolean): WebViews {
  const views = new WebViews(embed)
  views.register()

  return views
}
