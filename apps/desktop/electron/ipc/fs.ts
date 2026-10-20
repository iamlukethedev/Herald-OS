import { BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import { constants as fsConstants, type FSWatcher, watch as watchFs } from 'node:fs'
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

/**
 * One level of a folder. In a Hermes home and in `~/.config`, the credential stores among the entries are left out.
 * The listing reads the resolved folder; a folder on the way swapped for a symlink between the check and the read is
 * not caught here, but every file in it is checked again when it is opened.
 */
export async function readDir(target: string): Promise<DirEntry[]> {
  const { path: dir, real, places } = await checkReadable(target)
  const configs = places.homes.map(home => path.join(home, '.config'))
  const hides = [dir, real].some(folder => [...places.hermes, ...configs].some(root => within(folder, root)))
  const dirents = (await fs.readdir(real, { withFileTypes: true })).filter(dirent => !hides || ![path.join(dir, dirent.name), path.join(real, dirent.name)].some(file => isSecret(file, places)))
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

/** Up to `max` bytes of an open file from `position`, read until the end of the file: as many as there are, never padded. */
async function readFrom(handle: fs.FileHandle, position: number, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0

  while (total < max) {
    const chunk = Buffer.alloc(Math.min(READ_CHUNK, max - total))
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position + total)

    if (bytesRead === 0) {
      break
    }

    chunks.push(chunk.subarray(0, bytesRead))
    total += bytesRead
  }

  return Buffer.concat(chunks, total)
}

const READ_CHUNK = 64 * 1024
const BINARY_PROBE = 8192

/** Opening for a read never waits on a FIFO with no writer; regular files read the same either way. */
export const READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0)

/**
 * A preview of a file. Its kind and size come from the opened file, and only the bytes read are kept, so a file swapped
 * for a shorter or longer one after the check is read as it is, never padded with NULs or cut short. A folder answers
 * as one; anything else that is not a regular file (a FIFO, a socket, a device) is refused.
 */
export async function readFile(target: string): Promise<FilePreview> {
  const checked = await assertReadable(target)
  const file = checked.path
  let handle: fs.FileHandle

  try {
    handle = await openChecked(checked, READ_FLAGS)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EISDIR') {
      return { path: file, kind: 'directory', size: 0 }
    }

    throw error
  }

  try {
    const stat = await handle.stat()

    if (stat.isDirectory()) {
      return { path: file, kind: 'directory', size: 0 }
    }

    if (!stat.isFile()) {
      throw new Error(`${file} is not a regular file`)
    }

    const ext = path.extname(file).toLowerCase()
    const imageMime = IMAGE_MIME[ext]

    if (imageMime) {
      if (stat.size > IMAGE_LIMIT) {
        return { path: file, kind: 'too-large', size: stat.size, mime: imageMime }
      }

      const data = await readFrom(handle, 0, IMAGE_LIMIT + 1)

      if (data.length > IMAGE_LIMIT) {
        return { path: file, kind: 'too-large', size: Math.max(data.length, (await handle.stat()).size), mime: imageMime }
      }

      return { path: file, kind: 'image', size: data.length, mime: imageMime, content: `data:${imageMime};base64,${data.toString('base64')}` }
    }

    const looksText = TEXT_EXTENSIONS.has(ext) || ext === '' || /^\.[a-z0-9]{1,6}rc$/.test(ext)
    const head = await readFrom(handle, 0, BINARY_PROBE)

    if (!looksText && head.includes(0)) {
      return { path: file, kind: 'binary', size: Math.max(stat.size, head.length) }
    }

    const data = head.length < BINARY_PROBE ? head : Buffer.concat([head, await readFrom(handle, head.length, TEXT_LIMIT + 1 - head.length)])
    const truncated = data.length > TEXT_LIMIT

    return { path: file, kind: 'text', size: truncated ? Math.max(stat.size, data.length) : data.length, content: data.subarray(0, TEXT_LIMIT).toString('utf8'), truncated }
  } finally {
    await handle.close()
  }
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
  '.yarnrc.yml',
  '.vault-token',
  '.cargo/credentials',
  '.cargo/credentials.toml',
  '.terraform.d/credentials.tfrc.json',
  '.gem/credentials',
  '.m2/settings.xml',
  '.config/gcloud',
  '.config/gh',
  '.config/rclone',
  '.config/op',
  '.local/share/keyrings',
  '.claude/.credentials.json',
  '.codex/auth.json',
  '.zsh_history',
  '.bash_history',
  'Library/Keychains',
  'Library/Cookies',
  'Library/Messages',
  'Library/Application Support/com.apple.TCC',
  '.pgpass',
  '.my.cnf',
  '.s3cfg',
  '.boto',
  '.fly',
  '.wrangler',
  '.config/hub',
  '.config/heroku',
  '.config/doctl',
  'Library/Application Support/doctl',
  '.config/stripe',
  '.python_history',
  '.psql_history',
  '.mysql_history',
  // Password managers.
  '.config/1Password',
  'Library/Application Support/1Password',
  'Library/Containers/com.agilebits.onepassword7',
  'Library/Containers/com.1password.1password',
  // Editor and assistant tool tokens.
  '.config/Code/User/globalStorage',
  'Library/Application Support/Code/User/globalStorage',
  '.config/github-copilot',
  '.ollama/id_ed25519',
  // Browser profiles: saved passwords, cookies and session tokens.
  '.config/google-chrome',
  '.config/google-chrome-beta',
  '.config/google-chrome-unstable',
  '.config/chromium',
  '.config/BraveSoftware',
  '.config/microsoft-edge',
  '.config/microsoft-edge-beta',
  '.config/microsoft-edge-dev',
  '.config/vivaldi',
  '.config/opera',
  '.mozilla/firefox',
  'snap/firefox/common/.mozilla/firefox',
  'snap/chromium/common/chromium',
  '.var/app/org.mozilla.firefox/.mozilla/firefox',
  '.var/app/com.google.Chrome/config/google-chrome',
  '.var/app/com.brave.Browser/config/BraveSoftware',
  'Library/Safari',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Google/Chrome Beta',
  'Library/Application Support/Google/Chrome Canary',
  'Library/Application Support/Chromium',
  'Library/Application Support/BraveSoftware',
  'Library/Application Support/Microsoft Edge',
  'Library/Application Support/Microsoft Edge Beta',
  'Library/Application Support/Microsoft Edge Dev',
  'Library/Application Support/Arc',
  'Library/Application Support/Vivaldi',
  'Library/Application Support/com.operasoftware.Opera',
  'Library/Application Support/Firefox',
  'Library/Containers/com.apple.Safari/Data/Library/Cookies'
]

/** Credential stores whose folder name varies: `*` matches within one name, without regard to case. */
export const HOME_SECRET_PATTERNS = ['Library/Group Containers/*1password*', 'Library/Group Containers/*agilebits*']

const patternExpression = (pattern: string): RegExp => new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}(?:/|$)`, 'i')
const SECRET_EXPRESSIONS = HOME_SECRET_PATTERNS.map(patternExpression)

const TEMP_ROOTS = ['/tmp', '/private/tmp']
const SYSTEM_ROOTS = ['/System', '/usr', '/bin', '/sbin', '/private/etc', '/Library']

/**
 * The home folder, the Hermes homes, the temporary folders and the credential stores, each as written and with its
 * symlinks resolved, so `~/.ssh -> ~/dotfiles/ssh` makes `~/dotfiles/ssh` a credential store too.
 */
interface Places {
  homes: string[]
  hermes: string[]
  temps: string[]
  secrets: string[]
}

/** macOS and Windows file systems ignore case, so `~/.SSH` is `~/.ssh` there. */
const foldCase = (): boolean => process.platform === 'darwin' || process.platform === 'win32'
const comparable = (file: string): string => (foldCase() ? file.toLowerCase() : file)

const within = (file: string, root: string): boolean => {
  const [a, b] = [comparable(file), comparable(root)]

  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
}

/** `$HERMES_HOME` and the default `~/.hermes`: a profile that moved its home still leaves keys in the old one. */
const hermesHomes = (): string[] => [hermesHome(), path.join(os.homedir(), '.hermes')]

const isEnvFile = (name: string): boolean => comparable(name) === '.env' || comparable(name).startsWith('.env.')

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

const names = (dir: string): Promise<string[]> => fs.readdir(dir).catch((): string[] => [])

/** `auth.json`, `.env` and `.env.*` at the top of a Hermes home and of each of its profiles. */
async function hermesKeys(hermes: string): Promise<string[]> {
  const profiles = path.join(hermes, 'profiles')
  const dirs = [hermes, ...(await names(profiles)).map(name => path.join(profiles, name))]
  const found = await Promise.all(dirs.map(async dir => (await names(dir)).filter(isEnvFile).map(name => path.join(dir, name))))

  return [...dirs.flatMap(dir => [path.join(dir, '.env'), path.join(dir, 'auth.json')]), ...found.flat()]
}

/** The folders on disk that a {@link HOME_SECRET_PATTERNS} entry names in `home`. */
async function patternStores(home: string): Promise<string[]> {
  const found = await Promise.all(
    HOME_SECRET_PATTERNS.map(async (pattern, index) => {
      const parent = path.join(home, path.dirname(pattern))

      return (await names(parent)).map(name => path.join(parent, name)).filter(file => SECRET_EXPRESSIONS[index].test(path.relative(home, file)))
    })
  )

  return found.flat()
}

/** gnome-keyring's folder where `$XDG_DATA_HOME` moves it from ~/.local/share (an absolute path only, as the XDG specification says). */
function dataHomeKeyrings(): string[] {
  const data = process.env.XDG_DATA_HOME ?? ''

  return path.isAbsolute(data) ? [path.join(data, 'keyrings')] : []
}

async function resolvedPlaces(): Promise<Places> {
  const withReal = async (dirs: string[]) => [...new Set([...dirs, ...(await Promise.all(dirs.map(dir => realpathDeep(dir).catch(() => dir))))])]
  const [homes, hermes, temps] = await Promise.all([withReal([os.homedir()]), withReal(hermesHomes()), withReal([...TEMP_ROOTS, os.tmpdir()])])
  const [keys, patterned] = await Promise.all([Promise.all(hermes.map(hermesKeys)), Promise.all(homes.map(patternStores))])
  const secrets = await withReal([...homes.flatMap(home => HOME_SECRETS.map(secret => path.join(home, secret))), ...dataHomeKeyrings(), ...keys.flat(), ...patterned.flat()])

  return { homes, hermes, temps, secrets }
}

/**
 * A credential store: a {@link HOME_SECRETS} entry, a {@link HOME_SECRET_PATTERNS} match or a Hermes key file, as
 * written or where it resolves, or any `.env` under a Hermes home.
 */
function isSecret(file: string, places: Places): boolean {
  return (
    places.secrets.some(secret => within(file, secret)) ||
    places.homes.some(home => within(file, home) && SECRET_EXPRESSIONS.some(expression => expression.test(path.relative(home, file)))) ||
    places.hermes.some(hermes => within(file, hermes) && path.relative(comparable(hermes), comparable(file)).split(path.sep).some(isEnvFile))
  )
}

/** The credential store `file` lies in, as its own entry in its parent folder: the outermost folder (or file) that is one. */
function storeEntry(file: string, places: Places): string {
  let entry = file

  for (let parent = path.dirname(entry); parent !== entry && isSecret(parent, places); parent = path.dirname(parent)) {
    entry = parent
  }

  return entry
}

/** Whether a path under `root` (as the caller wrote it) is a credential store, by its spelling or by where it resolves. */
async function secretsUnder(root: string): Promise<(file: string) => boolean> {
  const [places, real] = await Promise.all([resolvedPlaces(), realpathDeep(root)])

  return file => isSecret(file, places) || isSecret(path.join(real, path.relative(root, file)), places)
}

const withoutTrailingSeparator = (file: string): string => (file.length > 1 ? file.replace(/[\\/]+$/, '') || path.sep : file)

/** A checked path, as the caller wrote it (normalized) and with its symlinks resolved. Read and write through `real`. */
export interface CheckedPath {
  path: string
  real: string
}

/** Refuse a credential store, judged as written (before touching the disk) and again once symlinks resolve. */
async function outsideSecrets(file: string, places: Places, resolve: (file: string) => Promise<string> = realpathDeep): Promise<string> {
  if (isSecret(file, places)) {
    throw new Error(`${file} is a protected location`)
  }

  const real = await resolve(file)

  if (isSecret(real, places)) {
    throw new Error(`${file} is a protected location`)
  }

  return real
}

async function checkReadable(target: string): Promise<CheckedPath & { places: Places }> {
  const file = withoutTrailingSeparator(normalizeUserPath(target))
  const places = await resolvedPlaces()

  return { path: file, real: await outsideSecrets(file, places), places }
}

/** Paths the shell may read, stat, open or list one level of: anywhere but a credential store ({@link isSecret}), wherever a path or its target lands. */
export async function assertReadable(target: string): Promise<CheckedPath> {
  const { path: file, real } = await checkReadable(target)

  return { path: file, real }
}

/**
 * What to show in the file manager for `target`: the path itself, or for a path in a credential store, the store's own
 * entry in its parent folder. The file manager then never opens a store, and nothing comes back to the window.
 */
export async function revealablePath(target: string): Promise<string> {
  const file = withoutTrailingSeparator(normalizeUserPath(target))
  const places = await resolvedPlaces()
  const real = await realpathDeep(file)
  const secret = [file, real].find(candidate => isSecret(candidate, places))

  return secret ? storeEntry(secret, places) : file
}

/**
 * Paths the shell may walk or measure in depth: readable, and inside the home folder, the Hermes home or a
 * temporary folder once symlinks resolve.
 */
export async function assertConfined(target: string, outside = 'Herald OS only looks through folders inside your home folder'): Promise<CheckedPath> {
  const { path: file, real, places } = await checkReadable(target)

  if (![...places.homes, ...places.hermes, ...places.temps].some(root => within(real, root))) {
    throw new Error(outside)
  }

  return { path: file, real }
}

const PROJECT_OUTSIDE = 'project folders must be inside your home folder'

/**
 * A folder that may be listed deeply or watched: confined, inside the home folder or a temporary folder once
 * symlinks resolve, and not a whole system folder such as `/`, `/tmp` or the Hermes home. As the caller wrote it,
 * without a trailing separator.
 */
export async function assertProjectFolder(target: string): Promise<string> {
  const { path: root, real } = await assertConfined(target, PROJECT_OUTSIDE)
  const places = await resolvedPlaces()

  if (path.dirname(real) === real || [...places.temps, ...places.hermes].some(dir => comparable(dir) === comparable(real))) {
    throw new Error(`${root} is a system folder, not a project folder`)
  }

  if (![...places.homes, ...places.temps].some(dir => within(real, dir))) {
    throw new Error(PROJECT_OUTSIDE)
  }

  return root
}

/** The most entries looked through for `.env` files before a folder in a Hermes home is refused as too large to check. */
export const ENV_SEARCH_LIMIT = 5000

/** Whether `dir` holds a `.env` or `.env.*` file anywhere below it; `unknown` when the search runs out first. */
async function holdsEnvFile(dir: string): Promise<boolean | 'unknown'> {
  const stack = [dir]
  let seen = 0

  while (stack.length) {
    const current = stack.pop()!
    const dirents = await fs.readdir(current, { withFileTypes: true }).catch(() => [])

    for (const dirent of dirents) {
      if (isEnvFile(dirent.name)) {
        return true
      }

      if (++seen > ENV_SEARCH_LIMIT) {
        return 'unknown'
      }

      if (dirent.isDirectory()) {
        stack.push(path.join(current, dirent.name))
      }
    }
  }

  return false
}

/** Refuse a folder that holds a credential store (`file`, resolved: `real`), or would once moved into place. */
async function refuseHoldingSecret(file: string, real: string, places: Places): Promise<void> {
  if (places.secrets.some(secret => within(secret, file) || within(secret, real))) {
    throw new Error(`${file} holds a protected location`)
  }

  if (!places.hermes.some(hermes => within(file, hermes) || within(real, hermes)) || !(await fs.lstat(real).then(stat => stat.isDirectory(), () => false))) {
    return
  }

  const env = await holdsEnvFile(real)

  if (env === 'unknown') {
    throw new Error(`${file} is too large to check for protected files`)
  }

  if (env) {
    throw new Error(`${file} holds a protected location`)
  }
}

/** A Studio preview's folder: a project folder strictly inside the home folder, as written and resolved, that holds no credential store. */
export async function assertPreviewFolder(target: string): Promise<CheckedPath> {
  const root = await assertProjectFolder(target)
  const places = await resolvedPlaces()
  const real = await realpathDeep(root)
  const insideHome = (candidate: string) => places.homes.some(home => within(candidate, home) && comparable(candidate) !== comparable(home))

  if (!insideHome(root) || !insideHome(real)) {
    throw new Error('a preview folder must be inside your home folder')
  }

  await refuseHoldingSecret(root, real, places)

  return { path: root, real }
}

export interface WritableOptions {
  /**
   * The entry itself (a rename or a trash moves a symlink, not what it points to): only its folder is resolved, and an
   * entry that holds a credential store, or would once a rename lands, is refused.
   */
  entry?: boolean
}

/**
 * Paths the shell may write to directly (user-initiated edits): inside the home folder or a temporary folder, as
 * written and once symlinks resolve (the nearest existing folder's, for a new file), and never a system folder or a
 * credential store. Everything else goes through the audited bridge.
 */
export async function checkWritable(target: string, options: WritableOptions = {}): Promise<CheckedPath> {
  const file = normalizeUserPath(target)
  const places = await resolvedPlaces()
  const editable = [...places.homes, ...places.temps]
  const inside = (candidate: string) => editable.some(root => within(candidate, root) && comparable(candidate) !== comparable(root))

  if (!inside(file)) {
    throw new Error('Herald OS only edits files inside your home folder')
  }

  const real = await outsideSecrets(file, places, async entry => (options.entry ? path.join(await realpathDeep(path.dirname(entry)), path.basename(entry)) : realpathDeep(entry)))

  if (!inside(real)) {
    throw new Error('Herald OS only edits files inside your home folder')
  }

  if ([file, real].some(candidate => SYSTEM_ROOTS.some(root => within(candidate, root)))) {
    throw new Error(`${file} is a protected location`)
  }

  if (options.entry) {
    await refuseHoldingSecret(file, real, places)
  }

  return { path: file, real }
}

/** {@link checkWritable}, as the caller wrote the path. */
export async function assertWritable(target: string, options: WritableOptions = {}): Promise<string> {
  return (await checkWritable(target, options)).path
}

/**
 * Opens of a checked path before one that keeps changing is refused: a save that renames a new file into place (as
 * Hermes saves memory, sometimes many times a second) can land between the open and its check. The handle is closed
 * between attempts. A failed check means a rename has just landed, and a saver writes its next file before the next
 * rename, so the first OPEN_IMMEDIATE_RETRIES opens again at once. The last four wait, doubling from OPEN_BACKOFF_MS
 * to OPEN_BACKOFF_MAX_MS (5, 10, 20 and 40 ms, each between half and all of it), 75 ms at most in all.
 *
 * No new attempt starts once OPEN_RETRY_BUDGET_MS have passed since the first, waits, opens and checks included, so
 * retrying on a slow disk stops too. The budget is checked between attempts only: a single open or check that does
 * not return (a stalled network disk, a FIFO with no writer) is not cut short.
 */
export const OPEN_ATTEMPTS = 10
export const OPEN_IMMEDIATE_RETRIES = 5
export const OPEN_BACKOFF_MS = 5
export const OPEN_BACKOFF_MAX_MS = 40
export const OPEN_RETRY_BUDGET_MS = 300

/**
 * The wait before attempt `attempt + 1`: none for the first OPEN_IMMEDIATE_RETRIES, then doubling from OPEN_BACKOFF_MS
 * up to OPEN_BACKOFF_MAX_MS, between half and all of it.
 */
export function openBackoff(attempt: number, random: () => number = Math.random): number {
  if (attempt <= OPEN_IMMEDIATE_RETRIES) {
    return 0
  }

  const ceiling = Math.min(OPEN_BACKOFF_MAX_MS, OPEN_BACKOFF_MS * 2 ** (attempt - 1 - OPEN_IMMEDIATE_RETRIES))

  return ceiling / 2 + random() * (ceiling / 2)
}

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Open a checked path through its resolved form, without following a symlink put in its place after the check, and
 * make sure the file opened is the one checked. A folder on the way swapped for a symlink between the check and the
 * open is caught here: on Linux by the path the kernel reports for the open file; elsewhere by resolving the path
 * again and comparing the file there with the one open, which leaves only a swap undone and redone in between. Only a
 * verified handle is returned; every other one is closed before the next attempt.
 */
export async function openChecked(checked: CheckedPath, flags: number): Promise<fs.FileHandle> {
  const started = Date.now()

  for (let attempt = 1; ; attempt++) {
    const handle = await fs.open(checked.real, flags | (fsConstants.O_NOFOLLOW ?? 0))
    let verified: boolean

    try {
      verified = await opensChecked(handle, checked, flags)
    } catch (error) {
      await handle.close()
      throw error
    }

    if (verified) {
      return handle
    }

    await handle.close()
    const wait = openBackoff(attempt)

    if (attempt >= OPEN_ATTEMPTS || Date.now() - started + wait > OPEN_RETRY_BUDGET_MS) {
      throw new Error(`${checked.path} changed while it was being opened`)
    }

    if (wait > 0) {
      await pause(wait)
    }
  }
}

const writes = (flags: number): boolean => (flags & (fsConstants.O_WRONLY | fsConstants.O_RDWR)) !== 0

async function opensChecked(handle: fs.FileHandle, checked: CheckedPath, flags: number): Promise<boolean> {
  if (process.platform === 'linux') {
    const opened = await fs.readlink(`/proc/self/fd/${handle.fd}`).catch(() => null)

    if (opened !== null) {
      // Replaced by a rename after the open, the checked file shows as "<path> (deleted)". Reading it is still reading
      // the checked file; a file really named so keeps its links. Writing to it would be lost, so a write opens again.
      return opened === checked.real || (opened === `${checked.real} (deleted)` && !writes(flags) && (await handle.stat()).nlink === 0)
    }
  }

  const [opened, now, there] = await Promise.all([handle.stat(), realpathDeep(checked.path).catch(() => null), fs.stat(checked.real).catch(() => null)])

  return now === checked.real && there !== null && there.dev === opened.dev && there.ino === opened.ino
}

/** Opening for a write never waits on a FIFO with no reader (it fails with ENXIO instead); regular files write the same either way. */
export const WRITE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | (fsConstants.O_NONBLOCK ?? 0)

/**
 * Write a whole file at a checked path through its resolved form, creating its folder. Nothing is truncated or written
 * before the open is verified, and only a regular file is written: a FIFO, with a reader or without, a socket or a
 * device is refused before anything reaches it. A new file is created by the open itself (O_CREAT), so when a folder
 * on the way was swapped for a symlink, an empty file can be left where the swap led even though the write is
 * refused; it is not removed, as deleting by path would race the same swap.
 */
export async function writeChecked(checked: CheckedPath, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(checked.real), { recursive: true })
  const notRegular = () => new Error(`${checked.path} is not a regular file`)
  // A FIFO, socket, device or symlink already there is refused without being opened; the check on the open handle
  // below stays the one that counts, for whatever is there by the time of the open.
  const existing = await fs.lstat(checked.real).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null
    }

    throw error
  })

  if (existing && !existing.isFile()) {
    throw notRegular()
  }

  let handle: fs.FileHandle

  try {
    handle = await openChecked(checked, WRITE_FLAGS)
  } catch (error) {
    throw (error as NodeJS.ErrnoException).code === 'ENXIO' ? notRegular() : error
  }

  try {
    if (!(await handle.stat()).isFile()) {
      throw notRegular()
    }

    await handle.truncate(0)
    await handle.writeFile(data)
  } finally {
    await handle.close()
  }
}

async function dirSize(target: string, budgetMs = 4000): Promise<{ bytes: number; files: number; complete: boolean }> {
  const root = (await assertConfined(target)).real
  const secret = await secretsUnder(root)
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

      if (secret(full)) {
        continue
      }

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

type FolderPlace = 'home' | 'inside' | 'temporary'

/** Where a project folder may sit: the home folder itself (`~` and `~/` name it alike), inside it, or in a temporary folder. Anywhere else is `null`. */
export function folderPlace(root: string, home: string): FolderPlace | null {
  if (root === home || root === home + path.sep) {
    return 'home'
  }

  if (root.startsWith(home + path.sep)) {
    return 'inside'
  }

  return root.startsWith('/tmp/') || root.startsWith('/private/tmp/') ? 'temporary' : null
}

/** A chat with no project works in the home folder, so the home folder is accepted: listed one level deep, and never watched. */
const atHome = (root: string): boolean => folderPlace(root, os.homedir()) === 'home'

/** Project folders must be real directories inside the home folder. */
async function projectRoot(target: string): Promise<string> {
  const root = await assertProjectFolder(target)

  if (!folderPlace(root, os.homedir())) {
    throw new Error('project folders must be inside your home folder')
  }

  if (!(await fs.stat(root)).isDirectory()) {
    throw new Error(`${root} is not a folder`)
  }

  return root
}

/** Left out of the home folder's listing: `Library` and everything starting with a dot (`.Trash`, `.ssh`, `.hermes`). */
const hiddenAtHome = (name: string): boolean => name === 'Library' || name.startsWith('.')

/**
 * List a project folder. The home folder is listed one level deep and without `Library` and dot-entries: a deeper
 * walk opens ~/Desktop, ~/Documents and ~/Downloads (macOS asks permission for each) and everything else the apps keep there.
 */
export async function listTree(target: string, limit: number): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const root = await projectRoot(target)
  const listingHome = atHome(root)
  const maxDepth = listingHome ? 0 : 10
  const entries: TreeEntry[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  const secret = await secretsUnder(root)

  while (queue.length) {
    const { dir, depth } = queue.shift()!
    let dirents: import('node:fs').Dirent[] = []

    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const dirent of dirents) {
      if (SKIPPED_DIRS.has(dirent.name) || SCRATCH_FILE.test(dirent.name) || (listingHome && hiddenAtHome(dirent.name))) {
        continue
      }

      const full = path.join(dir, dirent.name)

      if (secret(full)) {
        continue
      }

      if (entries.length >= limit) {
        return { entries, truncated: true }
      }

      if (dirent.isDirectory()) {
        entries.push({ path: full, kind: 'directory' })

        if (depth < maxDepth) {
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

/**
 * Report changes under a project folder to the renderer, batched, ignoring dependencies and build output.
 * The home folder is never watched, so its watch id is `null`: everything under it changes all the time
 * (`Library`, `~/.hermes`, caches) and none of it is a project's files.
 */
export async function watchTree(owner: WebContents, target: string): Promise<string | null> {
  const root = await projectRoot(target)

  if (atHome(root)) {
    return null
  }

  const watchId = `tree-${++treeWatchCounter}`
  const secret = await secretsUnder(root)
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

    if (!relative || skipped(relative) || secret(path.join(root, relative))) {
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
    const checked = await checkWritable(target)
    const file = checked.path

    if (options?.atomic) {
      return writeTextAtomic(file, String(content), options.expect === undefined ? {} : { expect: options.expect === null ? null : String(options.expect) })
    }

    await writeChecked(checked, String(content))

    return true
  })
  ipcMain.handle(IPC.fsLock, async (event, target: string, timeoutMs: number): Promise<FileLockResult> => {
    const file = await assertWritable(target)
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
    await fs.mkdir(await assertWritable(target), { recursive: true })
  })
  ipcMain.handle(IPC.fsRename, async (_event, from: string, to: string) => {
    const source = await assertWritable(from, { entry: true })
    const dest = await assertWritable(to, { entry: true })

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
      await shell.trashItem(await assertWritable(target, { entry: true }))
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
      await writeChecked(await checkWritable(picked.filePath), pdf)

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
  // A path in a credential store shows the store's entry in its parent folder instead (see revealablePath).
  ipcMain.handle(IPC.fsReveal, async (_event, target: string) => hostPlatform().revealPath(await revealablePath(target)))
  ipcMain.handle(IPC.fsOpenPath, async (_event, target: string) => {
    const error = await shell.openPath((await assertReadable(target)).real)

    if (error) {
      throw new Error(error)
    }
  })
  ipcMain.handle(IPC.fsOpenIn, async (_event, editor: EditorTarget, target: string) => hostPlatform().openIn(editor, (await assertReadable(target)).real))
}
