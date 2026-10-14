import { useStore } from '@nanostores/react'
import { atom, computed } from 'nanostores'
import { type RefObject, useEffect, useState } from 'react'
import type { DirEntry, RecentFile } from '../../../shared/ipc.ts'
import { formatBytes } from '../../lib/format.ts'
import { type AsyncState, useLocalData } from '../../lib/use-async.ts'
import { $prefs, updatePrefs } from '../../store/backend.ts'
import { sendPrompt } from '../../store/chat.ts'
import { notify } from '../../store/notifications.ts'
import { fileManagerName } from '../../lib/platform-labels.ts'
import { $activeSpace } from '../../store/spaces.ts'
import { openFileWindow } from '../../store/web-windows.ts'
import { showPage } from '../../store/windows.ts'
import { isViewable } from '../../../shared/viewer.ts'
import { isProjectPath } from '../../../shared/canvas/files.ts'
import { openInCanvas } from '../canvas/open.ts'

/*
 * Page-local state for Files: where we are, what is selected, how we look at it, plus the
 * lazy caches (thumbnails, folder counts) that make the card grid cheap to scroll.
 */

export interface FileItem {
  name: string
  path: string
  kind: 'file' | 'directory'
  size: number
  modifiedAt: number
  extension: string
  hidden: boolean
}

export type Location = { kind: 'dir'; path: string } | { kind: 'recent' } | { kind: 'favorites' }
export type ViewMode = 'grid' | 'list'
export type KindFilter = 'all' | 'folders' | 'images' | 'documents'

/** MIME type used for dragging cards onto sidebar folders. */
export const DRAG_MIME = 'application/x-herald-os-path'

export const $home = atom<string | null>(null)
export const $location = atom<Location | null>(null)
export const $history = atom<{ stack: Location[]; index: number }>({ stack: [], index: -1 })
export const $selectedPath = atom<string | null>(null)
export const $viewMode = atom<ViewMode>('grid')
export const $showHidden = atom(false)
export const $kindFilter = atom<KindFilter>('all')
export const $query = atom('')
export const $refreshTick = atom(0)

export const $canGoBack = computed($history, history => history.index > 0)
export const $canGoForward = computed($history, history => history.index < history.stack.length - 1)
/** The breadcrumb root: the active space's folder when set, else the home folder. */
export const $root = computed([$activeSpace, $home], (space, home) => (home ? expandHome(space.cwd, home) ?? home : null))

// ---- Paths -----------------------------------------------------------------------------------

export function expandHome(path: string | undefined, home: string | null): string | undefined {
  if (!path) {
    return undefined
  }

  if (home && (path === '~' || path.startsWith('~/'))) {
    return home + path.slice(1)
  }

  return path.replace(/\/+$/, '') || '/'
}

export function parentOf(path: string): string | null {
  if (path === '/' || !path) {
    return null
  }

  return path.replace(/\/[^/]+\/?$/, '') || '/'
}

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

export function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export function locationKey(location: Location | null): string {
  if (!location) {
    return ''
  }

  return location.kind === 'dir' ? `dir:${location.path}` : location.kind
}

export function sameLocation(a: Location | null, b: Location | null): boolean {
  return locationKey(a) === locationKey(b)
}

// ---- Navigation ------------------------------------------------------------------------------

let homeRequest: Promise<string> | null = null

/** Resolve the home folder once and land on the root when nothing is open yet. */
export function ensureHome(): Promise<string> {
  if (!homeRequest) {
    homeRequest = window.heraldOS.fs
      .home()
      .then(home => {
        $home.set(home)

        if (!$location.get()) {
          navigate({ kind: 'dir', path: $root.get() ?? home })
        }

        return home
      })
      .catch(error => {
        homeRequest = null
        notify({ title: 'Could not read the home folder', body: messageOf(error), level: 'error' })
        throw error
      })
  }

  return homeRequest
}

export function navigate(location: Location): void {
  if (sameLocation(location, $location.get())) {
    return
  }

  const history = $history.get()
  const stack = [...history.stack.slice(0, history.index + 1), location].slice(-60)
  $history.set({ stack, index: stack.length - 1 })
  $location.set(location)
  $selectedPath.set(null)
  $query.set('')
}

export function goBack(): void {
  const history = $history.get()

  if (history.index <= 0) {
    return
  }

  $history.set({ ...history, index: history.index - 1 })
  $location.set(history.stack[history.index - 1])
  $selectedPath.set(null)
}

export function goForward(): void {
  const history = $history.get()

  if (history.index >= history.stack.length - 1) {
    return
  }

  $history.set({ ...history, index: history.index + 1 })
  $location.set(history.stack[history.index + 1])
  $selectedPath.set(null)
}

export function goUp(): void {
  const location = $location.get()

  if (!location) {
    return
  }

  if (location.kind !== 'dir') {
    const root = $root.get()

    if (root) {
      navigate({ kind: 'dir', path: root })
    }

    return
  }

  const parent = parentOf(location.path)

  if (parent) {
    navigate({ kind: 'dir', path: parent })
  }
}

export function refresh(): void {
  $refreshTick.set($refreshTick.get() + 1)
}

/** Current folder path, or null on virtual listings (Recent, Favorites). */
export function currentDir(): string | null {
  const location = $location.get()

  return location?.kind === 'dir' ? location.path : null
}

// ---- Listing ---------------------------------------------------------------------------------

function fromDirEntry(entry: DirEntry): FileItem {
  return {
    name: entry.name,
    path: entry.path,
    kind: entry.kind === 'directory' ? 'directory' : 'file',
    size: entry.size,
    modifiedAt: entry.modifiedAt,
    extension: entry.extension.replace(/^\./, '').toLowerCase(),
    hidden: entry.hidden
  }
}

const MAX_HIDDEN_RECENTS = 500

/** Recent files minus the ones the user removed from Recents. */
export async function loadRecents(limit: number): Promise<RecentFile[]> {
  const hidden = new Set($prefs.get().hiddenRecents ?? [])
  const recent = await window.heraldOS.fs.recent(Math.min(200, limit + hidden.size))

  return recent.filter(entry => !hidden.has(entry.path)).slice(0, limit)
}

/** Hide a file from Recents here and on the Overview; the file itself is untouched. */
export async function removeFromRecents(path: string): Promise<void> {
  const hidden = [path, ...($prefs.get().hiddenRecents ?? []).filter(p => p !== path)].slice(0, MAX_HIDDEN_RECENTS)
  await updatePrefs({ hiddenRecents: hidden })
  $refreshTick.set($refreshTick.get() + 1)
}

export function fromRecent(entry: RecentFile): FileItem {
  return {
    name: entry.name,
    path: entry.path,
    kind: entry.kind,
    size: entry.size,
    modifiedAt: entry.modifiedAt,
    extension: entry.extension.replace(/^\./, '').toLowerCase(),
    hidden: entry.name.startsWith('.')
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function sortItems(items: FileItem[]): FileItem[] {
  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'directory' ? -1 : 1
    }

    return collator.compare(a.name, b.name)
  })
}

async function loadFavorites(paths: string[]): Promise<FileItem[]> {
  const byParent = new Map<string, string[]>()

  for (const path of paths) {
    const parent = parentOf(path)

    if (parent) {
      byParent.set(parent, [...(byParent.get(parent) ?? []), path])
    }
  }

  const found = new Map<string, FileItem>()
  await Promise.all(
    [...byParent.entries()].map(async ([parent, wanted]) => {
      try {
        const entries = await window.heraldOS.fs.readDir(parent)

        for (const entry of entries) {
          if (wanted.includes(entry.path)) {
            found.set(entry.path, fromDirEntry(entry))
          }
        }
      } catch {
        // A favourite whose parent vanished is simply not shown.
      }
    })
  )

  return paths.map(path => found.get(path)).filter((item): item is FileItem => Boolean(item))
}

export async function loadLocation(location: Location, favorites: string[]): Promise<FileItem[]> {
  switch (location.kind) {
    case 'dir':
      return sortItems((await window.heraldOS.fs.readDir(location.path)).map(fromDirEntry))
    case 'recent':
      return (await loadRecents(40)).map(fromRecent)
    case 'favorites':
      return loadFavorites(favorites)
  }
}

/** The items of the current location; reloads on navigation, refresh and favourite changes. */
export function useListing(): AsyncState<FileItem[]> {
  const location = useStore($location)
  const tick = useStore($refreshTick)
  const prefs = useStore($prefs)
  const favoritesKey = location?.kind === 'favorites' ? prefs.favorites.join('\n') : ''

  return useLocalData(() => (location ? loadLocation(location, prefs.favorites) : Promise.resolve([] as FileItem[])), [locationKey(location), tick, favoritesKey])
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'svg', 'tiff', 'tif', 'bmp', 'avif'])
const DOCUMENT_EXTS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'key', 'xls', 'xlsx', 'numbers', 'pages', 'md', 'txt', 'rtf', 'csv', 'json'])

export function isImage(item: FileItem): boolean {
  return item.kind === 'file' && IMAGE_EXTS.has(item.extension)
}

export function filterItems(items: FileItem[], options: { showHidden: boolean; kind: KindFilter; query: string }): FileItem[] {
  const needle = options.query.trim().toLowerCase()

  return items.filter(item => {
    if (!options.showHidden && item.hidden) {
      return false
    }

    if (options.kind === 'folders' && item.kind !== 'directory') {
      return false
    }

    if (options.kind === 'images' && !isImage(item)) {
      return false
    }

    if (options.kind === 'documents' && !(item.kind === 'file' && DOCUMENT_EXTS.has(item.extension))) {
      return false
    }

    return !needle || item.name.toLowerCase().includes(needle)
  })
}

// ---- Search ----------------------------------------------------------------------------------

const NATURAL_WORDS = new Set(['find', 'show', 'my', 'from', 'yesterday', 'today', 'screenshots', 'last', 'week', 'recent', 'all', 'with', 'that', 'where', 'search', 'get', 'list', 'which', 'about', 'the'])

/** Plain text filters the listing; sentences go to Hermes. */
export function looksLikeNaturalLanguage(query: string): boolean {
  const words = query.trim().split(/\s+/).filter(Boolean)

  if (words.length > 4) {
    return true
  }

  if (words.length < 2) {
    return false
  }

  return words.some(word => NATURAL_WORDS.has(word.toLowerCase().replace(/[^a-z]/g, '')))
}

export function askHermesToFind(query: string): void {
  showPage('hermes')
  void sendPrompt(`Find files: ${query}. Use system_find_files and list the paths.`)
}

export function askHermesAbout(path: string): void {
  showPage('hermes')
  void sendPrompt(`Take a look at ${path} and tell me what it is and what I might do with it.`)
}

// ---- Descriptions ----------------------------------------------------------------------------

const TYPE_LABELS: Record<string, string> = {
  pdf: 'PDF document',
  doc: 'Word document',
  docx: 'Word document',
  ppt: 'PowerPoint presentation',
  pptx: 'PowerPoint presentation',
  key: 'Keynote presentation',
  xls: 'Excel spreadsheet',
  xlsx: 'Excel spreadsheet',
  numbers: 'Numbers spreadsheet',
  pages: 'Pages document',
  md: 'Markdown document',
  txt: 'Plain text',
  rtf: 'Rich text document',
  csv: 'CSV table',
  json: 'JSON file',
  yaml: 'YAML file',
  yml: 'YAML file',
  html: 'HTML document',
  css: 'Stylesheet',
  ts: 'TypeScript source',
  tsx: 'TypeScript source',
  js: 'JavaScript source',
  jsx: 'JavaScript source',
  py: 'Python source',
  sh: 'Shell script',
  zip: 'ZIP archive',
  dmg: 'Disk image',
  app: 'Application',
  mp4: 'MPEG-4 video',
  mov: 'QuickTime movie',
  mp3: 'MP3 audio',
  wav: 'WAV audio',
  m4a: 'AAC audio'
}

export function describeType(item: FileItem): string {
  if (item.kind === 'directory') {
    return 'Folder'
  }

  if (IMAGE_EXTS.has(item.extension)) {
    return `${item.extension.toUpperCase()} image`
  }

  if (!item.extension) {
    return 'Document'
  }

  return TYPE_LABELS[item.extension] ?? `${item.extension.toUpperCase()} file`
}

export interface ExtBadge {
  label: string
  className: string
}

/** Small rounded square shown on file thumbnails: PDF red, Word blue, PowerPoint amber, images neutral. */
export function extBadge(item: FileItem): ExtBadge | null {
  if (item.kind !== 'file' || !item.extension) {
    return null
  }

  switch (item.extension) {
    case 'pdf':
      return { label: 'PDF', className: 'bg-danger text-white' }
    case 'doc':
    case 'docx':
    case 'pages':
      return { label: 'W', className: 'bg-accent text-accent-fg' }
    case 'ppt':
    case 'pptx':
    case 'key':
      return { label: 'P', className: 'bg-warn text-bg' }
    case 'xls':
    case 'xlsx':
    case 'numbers':
    case 'csv':
      return { label: 'X', className: 'bg-ok text-bg' }
    default:
      return { label: item.extension.toUpperCase().slice(0, 4), className: 'bg-white/15 text-fg-2 backdrop-blur' }
  }
}

const DAY = 86_400_000

/** "Modified today, 9:14 AM" (withTime) / "Modified 2 days ago" / "Modified Sep 16". */
export function formatModified(epochMs: number, withTime = false): string {
  if (!epochMs) {
    return 'Modified —'
  }

  const ms = epochMs < 1e12 ? epochMs * 1000 : epochMs
  const date = new Date(ms)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayDelta = Math.floor((startOfToday - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / DAY)
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

  if (dayDelta <= 0) {
    return withTime ? `Modified today, ${time}` : 'Modified today'
  }

  if (dayDelta === 1) {
    return withTime ? `Modified yesterday, ${time}` : 'Modified yesterday'
  }

  if (dayDelta < 7) {
    return `Modified ${dayDelta} days ago`
  }

  const sameYear = date.getFullYear() === now.getFullYear()

  return `Modified ${date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })}`
}

export function itemCountLabel(count: number | null): string {
  if (count == null) {
    return 'Folder'
  }

  return count === 1 ? '1 item' : `${count} items`
}

export function fileMeta(item: FileItem, count: number | null): string {
  return item.kind === 'directory' ? `${itemCountLabel(count)} · ${formatModified(item.modifiedAt)}` : `${formatBytes(item.size)} · ${formatModified(item.modifiedAt)}`
}

// ---- Lazy caches -----------------------------------------------------------------------------

const thumbnails = new Map<string, Promise<string | null>>()
const dirCounts = new Map<string, Promise<number | null>>()

export function loadThumbnail(path: string, size: number): Promise<string | null> {
  const key = `${size}:${path}`
  let pending = thumbnails.get(key)

  if (!pending) {
    pending = window.heraldOS.fs.thumbnail(path, size).catch(() => null)
    thumbnails.set(key, pending)
  }

  return pending
}

export function loadDirCount(path: string): Promise<number | null> {
  let pending = dirCounts.get(path)

  if (!pending) {
    pending = window.heraldOS.fs
      .readDir(path)
      .then(entries => entries.filter(entry => !entry.hidden).length)
      .catch(() => null)
    dirCounts.set(path, pending)
  }

  return pending
}

/** Drop cached thumbnails and counts for a path (and its parent folder's count). */
export function invalidatePath(path: string): void {
  for (const key of [...thumbnails.keys()]) {
    if (key.endsWith(`:${path}`) || key.includes(`:${path}/`)) {
      thumbnails.delete(key)
    }
  }

  for (const key of [...dirCounts.keys()]) {
    if (key === path || key.startsWith(`${path}/`)) {
      dirCounts.delete(key)
    }
  }

  const parent = parentOf(path)

  if (parent) {
    dirCounts.delete(parent)
  }
}

export function useThumbnail(path: string | null, size: number, enabled = true): { url: string | null; loading: boolean } {
  const [state, setState] = useState<{ path: string | null; url: string | null; loading: boolean }>({ path: null, url: null, loading: false })

  useEffect(() => {
    if (!path || !enabled) {
      return
    }

    let cancelled = false
    setState({ path, url: null, loading: true })
    void loadThumbnail(path, size).then(url => {
      if (!cancelled) {
        setState({ path, url, loading: false })
      }
    })

    return () => {
      cancelled = true
    }
  }, [path, size, enabled])

  return state.path === path ? { url: state.url, loading: state.loading } : { url: null, loading: Boolean(path && enabled) }
}

export function useDirCount(path: string | null, enabled = true): number | null {
  const [state, setState] = useState<{ path: string | null; count: number | null }>({ path: null, count: null })

  useEffect(() => {
    if (!path || !enabled) {
      return
    }

    let cancelled = false
    void loadDirCount(path).then(count => {
      if (!cancelled) {
        setState({ path, count })
      }
    })

    return () => {
      cancelled = true
    }
  }, [path, enabled])

  return state.path === path ? state.count : null
}

/** True once the element has scrolled into view (and stays true so cached work is not redone). */
export function useInView(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const node = ref.current

    if (!node || inView) {
      return
    }

    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)

      return
    }

    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setInView(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(node)

    return () => observer.disconnect()
  }, [ref, inView])

  return inView
}

// ---- Mutations (user-initiated fs calls, honest about failure) --------------------------------

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function trashItems(items: FileItem[]): Promise<boolean> {
  if (items.length === 0) {
    return false
  }

  const label = items.length === 1 ? `"${items[0].name}"` : `${items.length} items`

  if (!window.confirm(`Move ${label} to the Trash?`)) {
    return false
  }

  try {
    await window.heraldOS.fs.trash(items.map(item => item.path))
    items.forEach(item => invalidatePath(item.path))

    if (items.some(item => item.path === $selectedPath.get())) {
      $selectedPath.set(null)
    }

    refresh()
    notify({ title: `Moved ${label} to the Trash`, level: 'success' })

    return true
  } catch (error) {
    notify({ title: 'Could not move to the Trash', body: messageOf(error), level: 'error' })

    return false
  }
}

export async function renameItem(item: FileItem, name: string): Promise<boolean> {
  const trimmed = name.trim()
  const parent = parentOf(item.path)

  if (!trimmed || trimmed === item.name || !parent) {
    return false
  }

  if (trimmed.includes('/')) {
    notify({ title: 'Names cannot contain "/"', level: 'warn' })

    return false
  }

  const to = joinPath(parent, trimmed)

  try {
    await window.heraldOS.fs.rename(item.path, to)
    invalidatePath(item.path)
    invalidatePath(to)
    $selectedPath.set(to)
    refresh()

    return true
  } catch (error) {
    notify({ title: `Could not rename "${item.name}"`, body: messageOf(error), level: 'error' })

    return false
  }
}

export async function moveItem(from: string, dir: string, dirLabel: string): Promise<boolean> {
  const name = basename(from)
  const to = joinPath(dir, name)

  if (from === to || parentOf(from) === dir) {
    return false
  }

  if (!window.confirm(`Move "${name}" to ${dirLabel}?`)) {
    return false
  }

  try {
    await window.heraldOS.fs.rename(from, to)
    invalidatePath(from)
    invalidatePath(to)

    if ($selectedPath.get() === from) {
      $selectedPath.set(null)
    }

    refresh()
    notify({ title: `Moved "${name}" to ${dirLabel}`, level: 'success' })

    return true
  } catch (error) {
    notify({ title: `Could not move "${name}"`, body: messageOf(error), level: 'error' })

    return false
  }
}

export async function createFolder(dir: string, name: string): Promise<string | null> {
  const trimmed = name.trim()

  if (!trimmed) {
    return null
  }

  const path = joinPath(dir, trimmed)

  try {
    await window.heraldOS.fs.mkdir(path)
    invalidatePath(path)
    refresh()
    $selectedPath.set(path)

    return path
  } catch (error) {
    notify({ title: 'Could not create the folder', body: messageOf(error), level: 'error' })

    return null
  }
}

export async function createTextFile(dir: string, name: string): Promise<string | null> {
  let trimmed = name.trim()

  if (!trimmed) {
    return null
  }

  if (!/\.[a-z0-9]{1,8}$/i.test(trimmed)) {
    trimmed += '.txt'
  }

  const path = joinPath(dir, trimmed)

  try {
    await window.heraldOS.fs.writeText(path, '')
    invalidatePath(path)
    refresh()
    $selectedPath.set(path)

    return path
  } catch (error) {
    notify({ title: 'Could not create the file', body: messageOf(error), level: 'error' })

    return null
  }
}

export function openItem(item: FileItem): void {
  // A Herald Canvas project is a folder on Linux (a package on the Mac): it opens in Canvas.
  if (isProjectPath(item.path)) {
    openInCanvas(item.path)

    return
  }

  if (item.kind === 'directory') {
    navigate({ kind: 'dir', path: item.path })

    return
  }

  // PDFs, images, text and media open inside Herald OS; other types go to the app that owns them.
  if (isViewable(item.path)) {
    openFileWindow(item.path).catch(error => notify({ title: `Could not open "${item.name}"`, body: messageOf(error), level: 'error' }))

    return
  }

  openInDefaultApp(item.path, item.name)
}

/** Open a file or folder in the app the system gives it, saying so when that fails. */
export function openInDefaultApp(path: string, name = basename(path)): void {
  window.heraldOS.fs.openPath(path).catch(error => notify({ title: `Could not open "${name}"`, body: messageOf(error), level: 'error' }))
}

export function revealItem(path: string): void {
  window.heraldOS.fs.reveal(path).catch(error => notify({ title: `Could not show in ${fileManagerName()}`, body: messageOf(error), level: 'error' }))
}

export function copyPath(path: string): void {
  navigator.clipboard
    .writeText(path)
    .then(() => notify({ title: 'Path copied', body: path, level: 'success' }))
    .catch(error => notify({ title: 'Could not copy the path', body: messageOf(error), level: 'error' }))
}

export function isFavorite(path: string): boolean {
  return $prefs.get().favorites.includes(path)
}

export function toggleFavorite(path: string): void {
  const favorites = $prefs.get().favorites
  const next = favorites.includes(path) ? favorites.filter(p => p !== path) : [...favorites, path]
  updatePrefs({ favorites: next }).catch(error => notify({ title: 'Could not update favourites', body: messageOf(error), level: 'error' }))
}
