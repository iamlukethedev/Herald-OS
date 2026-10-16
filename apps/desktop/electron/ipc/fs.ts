import { BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import { type FSWatcher, watch as watchFs } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type DirEntry, type FileLockResult, type FilePreview, IPC, type TreeEntry, type WriteTextOptions } from '../../shared/ipc.ts'
import { hermesHome } from '../paths.ts'
import { allowAttachments, readAttachment } from '../attachments.ts'
import { writeTextAtomic } from '../atomic-write.ts'
import { type FileLock, lockFile } from '../file-lock.ts'
import { run } from '../platform/exec.ts'
import { type EditorTarget, hostPlatform } from '../platform/index.ts'
import { WindowWatches } from './watches.ts'

const TEXT_LIMIT = 2 * 1024 * 1024
const IMAGE_LIMIT = 24 * 1024 * 1024
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon'
}
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.log',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h',
  '.cpp', '.hpp', '.cs', '.sh', '.zsh', '.bash', '.fish', '.sql', '.html', '.css', '.scss', '.xml', '.csv', '.plist',
  '.gitignore', '.lock', '.mk', '.cmake', '.gradle', '.properties', '.tf', '.vue', '.svelte', '.astro', '.graphql'
])

/** Only absolute paths; `~` expands to home. Relative paths are refused so the renderer cannot probe cwd. */
export function normalizeUserPath(input: string): string {
  const expanded = input === '~' || input.startsWith('~/') ? path.join(os.homedir(), input.slice(1)) : input

  if (!path.isAbsolute(expanded)) {
    throw new Error(`path must be absolute: ${input}`)
  }

  return path.normalize(expanded)
}

export async function readDir(target: string): Promise<DirEntry[]> {
  const { path: dir, real } = await assertReadable(target)
  const dirents = await fs.readdir(real, { withFileTypes: true })
  const entries = await Promise.all(
    dirents.map(async dirent => {
      const full = path.join(dir, dirent.name)
      let size = 0
      let modifiedAt = 0
      let kind: DirEntry['kind'] = dirent.isDirectory() ? 'directory' : dirent.isFile() ? 'file' : dirent.isSymbolicLink() ? 'symlink' : 'other'

      try {
        const stat = await fs.stat(path.join(real, dirent.name))
        size = stat.size
        modifiedAt = stat.mtimeMs

        if (kind === 'symlink') {
          kind = stat.isDirectory() ? 'directory' : 'file'
        }
      } catch {
        // Broken symlink or permission denied: keep the dirent-derived kind.
      }

      return {
        name: dirent.name,
        path: full,
        kind,
        size,
        modifiedAt,
        hidden: dirent.name.startsWith('.'),
        extension: path.extname(dirent.name).toLowerCase()
      }
    })
  )

  entries.sort((a, b) => {
    if (a.kind !== b.kind && (a.kind === 'directory' || b.kind === 'directory')) {
      return a.kind === 'directory' ? -1 : 1
    }

    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  })

  return entries
}

export async function readFile(target: string): Promise<FilePreview> {
  const { path: file, real } = await assertReadable(target)
  const stat = await fs.stat(real)

  if (stat.isDirectory()) {
    return { path: file, kind: 'directory', size: 0 }
  }

  const ext = path.extname(file).toLowerCase()
  const imageMime = IMAGE_MIME[ext]

  if (imageMime) {
    if (stat.size > IMAGE_LIMIT) {
      return { path: file, kind: 'too-large', size: stat.size, mime: imageMime }
    }

    const data = await fs.readFile(real)

    return { path: file, kind: 'image', size: stat.size, mime: imageMime, content: `data:${imageMime};base64,${data.toString('base64')}` }
  }

  const looksText = TEXT_EXTENSIONS.has(ext) || ext === '' || /^\.[a-z0-9]{1,6}rc$/.test(ext)
  const handle = await fs.open(real, 'r')

  try {
    const probe = Buffer.alloc(Math.min(8192, stat.size))
    await handle.read(probe, 0, probe.length, 0)
    const binary = !looksText && probe.includes(0)

    if (binary || (!looksText && probe.includes(0))) {
      return { path: file, kind: 'binary', size: stat.size }
    }

    const readable = Math.min(stat.size, TEXT_LIMIT)
    const buffer = Buffer.alloc(readable)
    await handle.read(buffer, 0, readable, 0)

    return { path: file, kind: 'text', size: stat.size, content: buffer.toString('utf8'), truncated: stat.size > TEXT_LIMIT }
  } finally {
    await handle.close()
  }
}

/** Paths the shell may write to directly (user-initiated edits). Everything else goes through the audited bridge. */
export function assertWritable(target: string): string {
  const file = normalizeUserPath(target)
  const home = os.homedir()
  const protectedRoots = [path.join(home, '.ssh'), path.join(home, 'Library', 'Keychains'), '/System', '/usr', '/bin', '/sbin', '/private/etc', '/Library']

  if (!file.startsWith(home + path.sep) && !file.startsWith('/tmp/') && !file.startsWith('/private/tmp/')) {
    throw new Error('Herald OS only edits files inside your home folder')
  }

  if (protectedRoots.some(root => file === root || file.startsWith(root + path.sep)) || isSecret(file, lexicalPlaces())) {
    throw new Error(`${file} is a protected location`)
  }

  return file
}

/** Credential stores under the home folder (and the bridge's `BUILTIN_PROTECTED` secrets): never read, listed, watched or written by the shell. */
export const HOME_SECRETS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.password-store',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.config/gcloud',
  '.config/gh',
  '.local/share/keyrings',
  'Library/Keychains',
  'Library/Cookies'
]

const TEMP_ROOTS = ['/tmp', '/private/tmp']

/** The home folder, the Hermes homes and the temporary folders, each as written and with its symlinks resolved. */
interface Places {
  homes: string[]
  hermes: string[]
  temps: string[]
}

/** macOS and Windows file systems ignore case, so `~/.SSH` is `~/.ssh` there. */
const foldCase = process.platform === 'darwin' || process.platform === 'win32'
const comparable = (file: string): string => (foldCase ? file.toLowerCase() : file)

const within = (file: string, root: string): boolean => {
  const [a, b] = [comparable(file), comparable(root)]

  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
}

/** `$HERMES_HOME` and the default `~/.hermes`: a profile that moved its home still leaves keys in the old one. */
const hermesHomes = (): string[] => [hermesHome(), path.join(os.homedir(), '.hermes')]

function lexicalPlaces(): Places {
  return { homes: [os.homedir()], hermes: hermesHomes(), temps: [...TEMP_ROOTS, os.tmpdir()] }
}

/** The path with every symlink resolved; for a path that does not exist (yet), its nearest existing folder's. */
async function realpathDeep(file: string): Promise<string> {
  const rest: string[] = []
  let head = file

  for (;;) {
    try {
      return path.join(await fs.realpath(head), ...rest)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const parent = path.dirname(head)

      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === head) {
        throw error
      }

      rest.unshift(path.basename(head))
      head = parent
    }
  }
}

async function resolvedPlaces(): Promise<Places> {
  const lexical = lexicalPlaces()
  const withReal = async (dirs: string[]) => [...new Set([...dirs, ...(await Promise.all(dirs.map(dir => realpathDeep(dir).catch(() => dir))))])]

  return { homes: await withReal(lexical.homes), hermes: await withReal(lexical.hermes), temps: await withReal(lexical.temps) }
}

const isEnvFile = (name: string): boolean => comparable(name) === '.env' || comparable(name).startsWith('.env.')

/** A credential store: a {@link HOME_SECRETS} entry, `auth.json` in a Hermes home, or any `.env` anywhere under one. */
function isSecret(file: string, places: Places): boolean {
  if (places.homes.some(home => HOME_SECRETS.some(secret => within(file, path.join(home, secret))))) {
    return true
  }

  return places.hermes.some(hermes => within(file, path.join(hermes, 'auth.json')) || (within(file, hermes) && path.relative(comparable(hermes), comparable(file)).split(path.sep).some(isEnvFile)))
}

const withoutTrailingSeparator = (file: string): string => (file.length > 1 ? file.replace(/[\\/]+$/, '') || path.sep : file)

/** A path the shell may read, as the caller wrote it (normalized) and with its symlinks resolved. Read through `real`. */
export interface ReadablePath {
  path: string
  real: string
}

/**
 * Paths the shell may read, list, stat or watch: the home folder, the Hermes home and the temporary folders, judged
 * after symlinks resolve. Credential stores ({@link isSecret}) are refused wherever a path or its target lands.
 */
export async function assertReadable(target: string): Promise<ReadablePath> {
  const file = withoutTrailingSeparator(normalizeUserPath(target))
  const places = await resolvedPlaces()

  // Judged before touching the disk, so a protected path is refused the same whether it exists or not.
  if (isSecret(file, places)) {
    throw new Error(`${file} is a protected location`)
  }

  const real = await realpathDeep(file)

  if (![...places.homes, ...places.hermes, ...places.temps].some(root => within(real, root))) {
    throw new Error('Herald OS only reads files inside your home folder')
  }

  if (isSecret(real, places)) {
    throw new Error(`${file} is a protected location`)
  }

  return { path: file, real }
}

async function dirSize(target: string, budgetMs = 4000): Promise<{ bytes: number; files: number; complete: boolean }> {
  const root = (await assertReadable(target)).real
  const deadline = Date.now() + budgetMs
  let bytes = 0
  let files = 0
  let complete = true
  const stack = [root]

  while (stack.length) {
    if (Date.now() > deadline) {
      complete = false
      break
    }

    const dir = stack.pop()!
    let entries: import('node:fs').Dirent[] = []

    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        try {
          bytes += (await fs.stat(full)).size
          files++
        } catch {
          // Skip unreadable.
        }
      }
    }
  }

  return { bytes, files, complete }
}

/** Folders a project listing and watcher skip: dependencies, VCS data, caches and build output. */
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.nuxt', '.vite', '.turbo', '.cache', '.parcel-cache', '__pycache__', '.venv', 'venv', '.pytest_cache', '.DS_Store', 'coverage', '.idea'])

/** Scratch files: Hermes's and Herald's atomic-save temporaries (`.mem_*.tmp` for memory), editor swap and backup files. */
export const SCRATCH_FILE = /^\.hermes-tmp\.|^\.herald-tmp\.|^\.mem_.*\.tmp$|^\.#|\.sw[op]$|~$|^\.DS_Store$/

const skipped = (relative: string): boolean => relative.split(path.sep).some(part => SKIPPED_DIRS.has(part)) || SCRATCH_FILE.test(path.basename(relative))

/** Project folders must be real directories inside the home folder. */
async function projectRoot(target: string): Promise<string> {
  const root = normalizeUserPath(target)

  if (!root.startsWith(os.homedir() + path.sep) && !root.startsWith('/tmp/') && !root.startsWith('/private/tmp/')) {
    throw new Error('project folders must be inside your home folder')
  }

  if (!(await fs.stat(root)).isDirectory()) {
    throw new Error(`${root} is not a folder`)
  }

  return root
}

async function listTree(target: string, limit: number): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const root = await projectRoot(target)
  const entries: TreeEntry[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]

  while (queue.length) {
    const { dir, depth } = queue.shift()!
    let dirents: import('node:fs').Dirent[] = []

    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const dirent of dirents) {
      if (SKIPPED_DIRS.has(dirent.name) || SCRATCH_FILE.test(dirent.name)) {
        continue
      }

      const full = path.join(dir, dirent.name)

      if (entries.length >= limit) {
        return { entries, truncated: true }
      }

      if (dirent.isDirectory()) {
        entries.push({ path: full, kind: 'directory' })

        if (depth < 10) {
          queue.push({ dir: full, depth: depth + 1 })
        }
      } else if (dirent.isFile() || dirent.isSymbolicLink()) {
        entries.push({ path: full, kind: 'file' })
      }
    }
  }

  return { entries, truncated: false }
}

interface TreeWatch {
  watcher: FSWatcher
  pending: Set<string>
  timer: ReturnType<typeof setTimeout> | null
}

const treeWatches = new WindowWatches<TreeWatch>()

const LOCK_WAIT_MAX_MS = 60_000
const LOCK_HOLD_MAX_MS = 30_000
const heldLocks = new WindowWatches<{ id: string; lock: FileLock }>()
let lockCounter = 0
let treeWatchCounter = 0

function stopTree(watch: TreeWatch): void {
  watch.watcher.close()

  if (watch.timer) {
    clearTimeout(watch.timer)
  }
}

/** Report changes under a project folder to the renderer, batched, ignoring dependencies and build output. */
async function watchTree(owner: WebContents, target: string): Promise<string> {
  const root = await projectRoot(target)
  const watchId = `tree-${++treeWatchCounter}`
  const watch: TreeWatch = { watcher: watchFs(root, { recursive: true }), pending: new Set(), timer: null }
  const flush = () => {
    watch.timer = null

    if (!owner.isDestroyed() && watch.pending.size) {
      owner.send(IPC.fsTreeChanged, { watchId, paths: [...watch.pending].slice(0, 500) })
    }

    watch.pending.clear()
  }

  watch.watcher.on('change', (_type, filename) => {
    const relative = typeof filename === 'string' ? filename : filename?.toString()

    if (!relative || skipped(relative)) {
      return
    }

    watch.pending.add(path.join(root, relative))
    watch.timer ??= setTimeout(flush, 250)
  })
  watch.watcher.on('error', () => treeWatches.remove(watchId, owner))
  treeWatches.add(watchId, owner, watch, () => stopTree(watch))

  return watchId
}

export function registerFsIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.fsListTree, (_event, target: string, limit: number) => listTree(target, Math.max(1, Math.min(10_000, Number(limit) || 3000))))
  ipcMain.handle(IPC.fsWatchTree, (event, target: string) => watchTree(event.sender, target))
  ipcMain.handle(IPC.fsUnwatchTree, (event, watchId: string) => {
    treeWatches.remove(String(watchId), event.sender)
  })
  ipcMain.handle(IPC.fsHome, () => os.homedir())
  ipcMain.handle(IPC.fsRecent, (_event, limit: number) => hostPlatform().recentFiles(Math.max(1, Math.min(200, Number(limit) || 30))))
  ipcMain.handle(IPC.fsFind, (_event, query: string, limit: number) => hostPlatform().findFiles(String(query ?? '').slice(0, 200), Math.max(1, Math.min(50, Number(limit) || 10))))
  ipcMain.handle(IPC.fsThumbnail, async (_event, target: string, size: number) => {
    const png = await hostPlatform().thumbnail((await assertReadable(target)).real, Math.max(64, Math.min(1024, Number(size) || 512)))

    return png ? `data:image/png;base64,${png.toString('base64')}` : null
  })
  ipcMain.handle(IPC.fsImageInfo, async (_event, target: string) => {
    const file = (await assertReadable(target)).real
    const result = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], 5000)
    const width = Number(/pixelWidth:\s*(\d+)/.exec(result.stdout)?.[1])
    const height = Number(/pixelHeight:\s*(\d+)/.exec(result.stdout)?.[1])

    return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null
  })
  ipcMain.handle(IPC.fsWriteText, async (_event, target: string, content: string, options?: WriteTextOptions) => {
    const file = assertWritable(target)

    if (options?.atomic) {
      return writeTextAtomic(file, String(content), options.expect === undefined ? {} : { expect: options.expect === null ? null : String(options.expect) })
    }

    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, String(content), 'utf8')

    return true
  })
  ipcMain.handle(IPC.fsLock, async (event, target: string, timeoutMs: number): Promise<FileLockResult> => {
    const file = assertWritable(target)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const outcome = await lockFile(file, Math.max(0, Math.min(LOCK_WAIT_MAX_MS, Number(timeoutMs) || 0)))

    if (outcome.status !== 'locked') {
      return outcome
    }

    const id = `lock-${++lockCounter}`
    const owner = event.sender
    // Hermes waits on this lock without a timeout, so a window that never unlocks must not hold it for long.
    const expiry = setTimeout(() => heldLocks.remove(id, owner), LOCK_HOLD_MAX_MS)
    heldLocks.add(id, owner, { id, lock: outcome.lock }, () => {
      clearTimeout(expiry)
      void outcome.lock.release()
    })

    return { status: 'locked', id }
  })
  ipcMain.handle(IPC.fsUnlock, async (event, id: string) => {
    const held = heldLocks.find(event.sender, value => value.id === String(id))
    heldLocks.remove(String(id), event.sender)
    await held?.lock.release()
  })
  ipcMain.handle(IPC.fsMkdir, async (_event, target: string) => {
    await fs.mkdir(assertWritable(target), { recursive: true })
  })
  ipcMain.handle(IPC.fsRename, async (_event, from: string, to: string) => {
    const source = assertWritable(from)
    const dest = assertWritable(to)

    try {
      await fs.access(dest)
      throw new Error(`${dest} already exists`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }

    await fs.rename(source, dest)
  })
  ipcMain.handle(IPC.fsTrash, async (_event, targets: string[]) => {
    for (const target of targets) {
      await shell.trashItem(assertWritable(target))
    }
  })
  ipcMain.handle(IPC.fsExportPdf, async (_event, html: string, suggestedName: string) => {
    const win = getWindow()

    if (!win) {
      throw new Error('no window')
    }

    const picked = await dialog.showSaveDialog(win, { defaultPath: path.join(os.homedir(), 'Documents', suggestedName.endsWith('.pdf') ? suggestedName : `${suggestedName}.pdf`), filters: [{ name: 'PDF', extensions: ['pdf'] }] })

    if (picked.canceled || !picked.filePath) {
      return null
    }

    const printer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } })

    try {
      await printer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(String(html))}`)
      const pdf = await printer.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } })
      await fs.writeFile(assertWritable(picked.filePath), pdf)

      return picked.filePath
    } finally {
      printer.destroy()
    }
  })
  ipcMain.handle(IPC.fsPickFiles, async (_event, options: { directory?: boolean; multiple?: boolean } = {}) => {
    const win = getWindow()

    if (!win) {
      return []
    }

    const result = await dialog.showOpenDialog(win, { properties: [options.directory ? 'openDirectory' : 'openFile', ...(options.multiple ? ['multiSelections' as const] : [])] })

    if (result.canceled) {
      return []
    }

    if (!options.directory) {
      allowAttachments(result.filePaths)
    }

    return result.filePaths
  })
  ipcMain.handle(IPC.fsAttachment, (_event, target: string, maxBytes: number) => readAttachment(target, maxBytes))
  ipcMain.handle(IPC.fsDirSize, (_event, target: string) => dirSize(target))
  ipcMain.handle(IPC.fsReadDir, (_event, target: string) => readDir(target))
  ipcMain.handle(IPC.fsReadFile, (_event, target: string) => readFile(target))
  ipcMain.handle(IPC.fsReveal, (_event, target: string) => hostPlatform().revealPath(normalizeUserPath(target)))
  ipcMain.handle(IPC.fsOpenPath, async (_event, target: string) => {
    const error = await shell.openPath(normalizeUserPath(target))

    if (error) {
      throw new Error(error)
    }
  })
  ipcMain.handle(IPC.fsOpenIn, (_event, editor: EditorTarget, target: string) => hostPlatform().openIn(editor, normalizeUserPath(target)))
}
