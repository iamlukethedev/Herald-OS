import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const fileHandlers = vi.hoisted(() => new Map<string, (request: Request) => Promise<Response>>())
const trashItem = vi.hoisted(() => vi.fn(async (_file: string) => undefined))
const openPath = vi.hoisted(() => vi.fn(async (_file: string) => ''))
const platform = vi.hoisted(() => ({
  launchApp: vi.fn(async (_file: string) => undefined),
  appIcon: vi.fn(async (_file: string) => Buffer.from('icon')),
  revealPath: vi.fn(async (_file: string) => undefined),
  openIn: vi.fn(async (_editor: string, _file: string) => undefined),
  thumbnail: vi.fn(async () => null)
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  clipboard: {},
  ClipboardItem: class {},
  dialog: {},
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler), on: () => {} },
  nativeImage: {
    createFromPath: (file: string) => {
      const image = { toDataURL: () => `data:${file}`, isEmpty: () => false, toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 1, height: 1 }), resize: () => image }

      return image
    }
  },
  session: {
    fromPartition: (partition: string) => ({
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {},
      setDevicePermissionHandler: () => {},
      on: () => {},
      protocol: { handle: (scheme: string, handler: (request: Request) => Promise<Response>) => fileHandlers.set(`${partition}:${scheme}`, handler) }
    })
  },
  shell: { trashItem, openPath },
  systemPreferences: {},
  webContents: { getAllWebContents: () => [] },
  app: { getPath: () => '/tmp', on: () => {} }
}))
vi.mock('../log.ts', () => ({ log: vi.fn() }))
vi.mock('../platform/index.ts', () => ({ hostPlatform: () => platform }))

const { ENV_SEARCH_LIMIT, HOME_SECRETS, OPEN_ATTEMPTS, OPEN_BACKOFF_MAX_MS, OPEN_IMMEDIATE_RETRIES, OPEN_RETRY_BUDGET_MS, assertPreviewFolder, assertProjectFolder, assertReadable, assertWritable, checkWritable, openBackoff, openChecked, readDir, readFile, registerFsIpc, writeChecked } = await import('./fs.ts')
const { WebViews, confineFiles, registerWebIpc, servableFile, serveOpenFile } = await import('./web.ts')
const { registerAppsIpc } = await import('./apps.ts')
const { registerCanvasIpc } = await import('../canvas/ipc.ts')
const { registerOfficeIpc } = await import('../office/ipc.ts')
const { registerCaptureIpc } = await import('./capture.ts')
const { registerThemeIpc } = await import('./theme.ts')
const { IPC } = await import('../../shared/ipc.ts')

registerFsIpc(() => null)
registerCanvasIpc(() => null)
registerOfficeIpc(() => null)
registerCaptureIpc(() => {})
registerThemeIpc({ panels: false, broadcast: () => {}, backend: {} as never })
registerAppsIpc()
const openFile = vi.spyOn(WebViews.prototype, 'openFile').mockReturnValue('web-1')
registerWebIpc(false)

// In worker threads os.homedir() does not see a stubbed HOME, so it is read from the environment here.
vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME ?? '')

/** Outside every temporary root, so a path outside the home folder is never let in as a temporary one. */
const BASE = fs.realpathSync(fs.existsSync('/var/tmp') ? '/var/tmp' : os.homedir())

/** Run `test` as if on `name` (process.platform), for the macOS and Windows rules. */
async function onPlatform(name: NodeJS.Platform, test: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...original, value: name })

  try {
    await test()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

const owner = () => Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
let sender = owner()
const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => Promise.resolve(handlers.get(channel)!({ sender }, ...args))
const PROTECTED = /is a protected location/
const CONFINED = /only looks through folders inside your home folder/
const EDITS = /only edits files inside your home folder/
const HOLDS = /holds a protected location/
const TOO_LARGE = /too large to check/
const CHANGED = /changed while it was being opened/
const PROJECT_OUTSIDE = /project folders must be inside your home folder/

let home: string
let hermes: string

const write = (file: string, content = ''): string => {
  const full = path.join(home, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)

  return full
}
const link = (target: string, at: string): void => {
  fs.mkdirSync(path.dirname(path.join(home, at)), { recursive: true })
  fs.symlinkSync(path.isAbsolute(target) ? target : path.join(home, target), path.join(home, at))
}
/** Move a credential folder into ~/dotfiles and leave a symlink where it was, as dotfile managers do. */
const moveBehindLink = (secret: string, to: string): void => {
  fs.mkdirSync(path.dirname(path.join(home, to)), { recursive: true })
  fs.renameSync(path.join(home, secret), path.join(home, to))
  link(to, secret)
}
const names = async (dir: string): Promise<string[]> => (await readDir(dir)).map(entry => entry.name)
const listed = async (root: string): Promise<string[]> => ((await invoke(IPC.fsListTree, root, 100)) as { entries: Array<{ path: string }> }).entries.map(entry => entry.path).sort()
const size = async (dir: string) => (await invoke(IPC.fsDirSize, dir)) as { bytes: number; files: number; complete: boolean }

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(BASE, 'herald-read-')))
  hermes = path.join(home, '.hermes')
  vi.stubEnv('HOME', home)
  vi.stubEnv('HERMES_HOME', '')
  trashItem.mockClear()
  openPath.mockClear()
  openFile.mockClear()
  Object.values(platform).forEach(mock => mock.mockClear())

  write('.ssh/id_rsa', 'PRIVATE KEY')
  write('.gnupg/private-keys-v1.d/key.key', 'GPG')
  write('.aws/credentials', 'aws_secret_access_key=x')
  write('Library/Keychains/login.keychain-db', 'KEYCHAIN')
  write('.config/gh/hosts.yml', 'oauth_token: x')
  write('.hermes/.env', 'OPENROUTER_API_KEY=x')
  write('.hermes/auth.json', '{"token":"x"}')
  write('.hermes/profiles/work/.env', 'KEY=x')
  write('.hermes/profiles/work/.env.local', 'KEY=x')
  write('.hermes/config.yaml', 'model: x')
  write('.hermes/memories/MEMORY.md', 'remember this')
  write('.hermes/memories/USER.md', 'about me')
  write('.hermes/skills/notes/SKILL.md', '# Notes')
  write('.hermes/herald-os/office/slide-themes.json', '[]')
  write('Projects/site/index.html', '<h1>hi</h1>')
  write('Projects/site/.env', 'PROJECT_KEY=x')
  write('Downloads/report.txt', 'report')
  write('.Trash/old.txt', 'old')
  write('notes.md', 'notes')
})

afterEach(() => {
  sender.emit('destroyed')
  sender = owner()
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('reading the places the shell reads', () => {
  it('reads the home folder and the Files sidebar places', async () => {
    expect(await names(home)).toEqual(expect.arrayContaining(['Downloads', 'Projects', 'notes.md', '.ssh', '.hermes']))
    expect(await names(`${home}/`)).toEqual(await names(home))
    expect(await names('~/Downloads')).toEqual(['report.txt'])
    expect(await names(`${home}/.Trash`)).toEqual(['old.txt'])
    expect((await readFile(`${home}/Downloads/report.txt`)).content).toBe('report')
  })

  it('reads memory files, the Hermes config, skills and the custom slide themes', async () => {
    expect(await names(`${hermes}/memories`)).toEqual(['MEMORY.md', 'USER.md'])
    expect((await readFile(`${hermes}/memories/MEMORY.md`)).content).toBe('remember this')
    expect((await readFile(`${hermes}/config.yaml`)).content).toBe('model: x')
    expect((await readFile(`${hermes}/skills/notes/SKILL.md`)).content).toBe('# Notes')
    expect((await readFile(`${hermes}/herald-os/office/slide-themes.json`)).content).toBe('[]')
  })

  it('keeps the test home outside every temporary folder', () => {
    const temps = [os.tmpdir(), '/tmp', '/private/tmp'].filter(dir => fs.existsSync(dir))

    expect(temps.some(dir => home.startsWith(fs.realpathSync(dir) + path.sep))).toBe(false)
  })

  it("reads a Studio project's files, its own .env included", async () => {
    expect(await names(`${home}/Projects/site`)).toEqual(['.env', 'index.html'])
    expect((await readFile(`${home}/Projects/site/index.html`)).content).toBe('<h1>hi</h1>')
    expect((await readFile(`${home}/Projects/site/.env`)).content).toBe('PROJECT_KEY=x')
  })

  it('reads an artifact in a temporary folder', async () => {
    const dir = fs.mkdtempSync('/tmp/herald-artifact-')

    try {
      fs.writeFileSync(path.join(dir, 'chart.svg'), '<svg/>')
      expect((await readFile(path.join(dir, 'chart.svg'))).kind).toBe('image')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lists and previews outside the home folder, for the breadcrumbs up to / and places like /Applications', async () => {
    expect(await names('/')).toEqual(expect.arrayContaining(['etc', 'usr']))
    expect(await names('/usr')).toEqual(expect.arrayContaining(['bin', 'lib']))
    expect(await names(path.dirname(home))).toContain(path.basename(home))
    expect((await readFile('/etc/passwd')).kind).toBe('text')
    expect(await invoke(IPC.canvasExists, '/etc/passwd')).toBe('file')
    expect(await invoke(IPC.canvasExists, '/usr')).toBe('directory')
  })

  it('reads through a symlink that leads outside the home folder, one level at a time', async () => {
    link('/etc', 'etc')

    expect(await names(`${home}/etc`)).toContain('passwd')
    expect((await readFile(`${home}/etc/passwd`)).path).toBe(`${home}/etc/passwd`)
  })

  it('reads a Hermes home that HERMES_HOME moved, and still refuses its keys', async () => {
    const moved = fs.realpathSync(fs.mkdtempSync(path.join(BASE, 'herald-hermes-')))
    vi.stubEnv('HERMES_HOME', moved)

    try {
      fs.mkdirSync(path.join(moved, 'memories'))
      fs.writeFileSync(path.join(moved, 'memories', 'MEMORY.md'), 'moved')
      fs.writeFileSync(path.join(moved, '.env'), 'KEY=x')
      expect((await readFile(path.join(moved, 'memories', 'MEMORY.md'))).content).toBe('moved')
      await expect(readFile(path.join(moved, '.env'))).rejects.toThrow(PROTECTED)
      // The default home keeps its keys refused too.
      await expect(readFile(`${hermes}/.env`)).rejects.toThrow(PROTECTED)
    } finally {
      fs.rmSync(moved, { recursive: true, force: true })
    }
  })

  it('answers a missing file with ENOENT, as the slide themes and memory readers expect', async () => {
    await expect(readFile(`${hermes}/herald-os/office/missing.json`)).rejects.toThrow(/ENOENT/)
    await expect(readDir(`${hermes}/nothing-here`)).rejects.toThrow(/ENOENT/)
  })

  it('keeps the path as written and refuses relative ones', async () => {
    expect((await readFile('~/notes.md')).path).toBe(`${home}/notes.md`)
    expect((await readDir(`${home}/Projects/`))[0].path).toBe(`${home}/Projects/site`)
    await expect(readFile('notes.md')).rejects.toThrow(/must be absolute/)
  })
})

describe('refusing credential stores', () => {
  const secrets = ['.ssh/id_rsa', '.gnupg/private-keys-v1.d/key.key', '.aws/credentials', 'Library/Keychains/login.keychain-db', '.config/gh/hosts.yml', '.hermes/.env', '.hermes/auth.json', '.hermes/profiles/work/.env', '.hermes/profiles/work/.env.local']

  it.each(secrets)('refuses to read ~/%s', async file => {
    await expect(readFile(path.join(home, file))).rejects.toThrow(PROTECTED)
    await expect(readFile(`~/${file}`)).rejects.toThrow(PROTECTED)
  })

  it.each(['.ssh', '.gnupg', '.aws', 'Library/Keychains', '.config/gh', '.hermes/profiles/work/.env'])('refuses to list ~/%s', async dir => {
    await expect(readDir(path.join(home, dir))).rejects.toThrow(PROTECTED)
    await expect(readDir(path.join(home, dir) + '/')).rejects.toThrow(PROTECTED)
  })

  it('refuses every listed credential store, whether it exists or not', async () => {
    for (const secret of HOME_SECRETS) {
      await expect(assertReadable(path.join(home, secret, 'anything'))).rejects.toThrow(PROTECTED)
    }

    await expect(readFile(`${home}/.ssh/not-there`)).rejects.toThrow(PROTECTED)
  })

  it('refuses the read handlers on secrets', async () => {
    await expect(invoke(IPC.fsReadFile, `${hermes}/.env`)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsReadDir, `${home}/.ssh`)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsDirSize, `${home}/.gnupg`)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsThumbnail, `${home}/.ssh/id_rsa`, 256)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsImageInfo, `${home}/.ssh/id_rsa`)).rejects.toThrow(PROTECTED)
  })

  it('answers exists for secrets as if they were missing', async () => {
    expect(await invoke(IPC.canvasExists, `${hermes}/herald-os/office/slide-themes.json`)).toBe('file')
    expect(await invoke(IPC.canvasExists, `${home}/nothing.png`)).toBeNull()
    expect(await invoke(IPC.canvasExists, `${home}/.ssh/id_rsa`)).toBeNull()
    expect(await invoke(IPC.canvasExists, `${hermes}/.env`)).toBeNull()

    link('.aws/credentials', 'photo.png')
    expect(await invoke(IPC.canvasExists, `${home}/photo.png`)).toBeNull()
  })

  it('refuses a Canvas image and a capture that are symlinks to a secret', async () => {
    link('.aws/credentials', 'photo.png')

    await expect(invoke(IPC.canvasReadImage, `${home}/photo.png`)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.captureReadImage, `${home}/photo.png`)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.captureCopyImage, `${home}/photo.png`)).rejects.toThrow(PROTECTED)
  })

  it('still reads a capture image in the home folder', async () => {
    write('Pictures/shot.png', 'png')

    expect(await invoke(IPC.captureReadImage, `${home}/Pictures/shot.png`)).toBe(`data:${home}/Pictures/shot.png`)
  })
})

describe('credential stores behind symlinks', () => {
  it('refuses ~/.ssh and where it leads when ~/.ssh is a symlink to ~/dotfiles/ssh', async () => {
    moveBehindLink('.ssh', 'dotfiles/ssh')

    await expect(readFile(`${home}/.ssh/id_rsa`)).rejects.toThrow(PROTECTED)
    await expect(readFile(`${home}/dotfiles/ssh/id_rsa`)).rejects.toThrow(PROTECTED)
    await expect(readDir(`${home}/dotfiles/ssh`)).rejects.toThrow(PROTECTED)
    await expect(readFile(`${home}/dotfiles/ssh/not-there`)).rejects.toThrow(PROTECTED)
    // The folder around it is an ordinary folder.
    expect(await names(`${home}/dotfiles`)).toEqual(['ssh'])
  })

  it('refuses a second symlink to the linked ~/.ssh', async () => {
    moveBehindLink('.ssh', 'dotfiles/ssh')
    link('.ssh', 'innocent')

    await expect(readFile(`${home}/innocent/id_rsa`)).rejects.toThrow(PROTECTED)
    await expect(readDir(`${home}/innocent`)).rejects.toThrow(PROTECTED)
  })

  it('refuses symlinks into a plain ~/.ssh', async () => {
    link('.ssh', 'innocent')
    link('.ssh/id_rsa', 'innocent.txt')
    link(`${hermes}/.env`, 'settings.md')

    await expect(readFile(`${home}/innocent/id_rsa`)).rejects.toThrow(PROTECTED)
    await expect(readFile(`${home}/innocent.txt`)).rejects.toThrow(PROTECTED)
    await expect(readFile(`${home}/settings.md`)).rejects.toThrow(PROTECTED)
  })

  it('refuses the files that the Hermes .env and auth.json files link to', async () => {
    moveBehindLink('.hermes/.env', 'vault/hermes.env')
    moveBehindLink('.hermes/auth.json', 'vault/hermes-auth')
    moveBehindLink('.hermes/profiles/work/.env', 'vault/work.env')

    await expect(readFile(`${home}/vault/hermes.env`)).rejects.toThrow(PROTECTED)
    await expect(readFile(`${home}/vault/hermes-auth`)).rejects.toThrow(PROTECTED)
    await expect(readFile(`${home}/vault/work.env`)).rejects.toThrow(PROTECTED)
    await expect(readFile(`${hermes}/.env`)).rejects.toThrow(PROTECTED)
  })

  it('refuses a credential store whose parent folder is a symlink', async () => {
    moveBehindLink('.config', 'dotfiles/config')

    await expect(readFile(`${home}/dotfiles/config/gh/hosts.yml`)).rejects.toThrow(PROTECTED)
    await expect(readFile(`${home}/.config/gh/hosts.yml`)).rejects.toThrow(PROTECTED)
  })

  it('refuses .. that climbs into a secret', async () => {
    await expect(readFile(`${home}/Projects/../.ssh/id_rsa`)).rejects.toThrow(PROTECTED)
    await expect(readFile('~/Downloads/../.hermes/.env')).rejects.toThrow(PROTECTED)
    expect((await readFile(`${home}/Projects/../notes.md`)).content).toBe('notes')
  })
})

describe('writes through links', () => {
  const content = (file: string): string => fs.readFileSync(path.join(home, file), 'utf8')

  it('refuses writes into credential stores, as written', async () => {
    await expect(assertWritable(`${home}/.aws/credentials`)).rejects.toThrow(PROTECTED)
    await expect(assertWritable(`${hermes}/.env`)).rejects.toThrow(PROTECTED)
    await expect(assertWritable(`${home}/.ssh/authorized_keys`)).rejects.toThrow(PROTECTED)
    await expect(assertWritable(`${hermes}/memories/MEMORY.md`)).resolves.toBe(`${hermes}/memories/MEMORY.md`)
  })

  it('refuses ~/innocent/authorized_keys when innocent links to ~/.ssh', async () => {
    link('.ssh', 'innocent')

    await expect(invoke(IPC.fsWriteText, `${home}/innocent/authorized_keys`, 'ssh-ed25519 attacker')).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsWriteText, `${home}/innocent/authorized_keys`, 'x', { atomic: true })).rejects.toThrow(PROTECTED)
    expect(fs.existsSync(`${home}/.ssh/authorized_keys`)).toBe(false)
  })

  it('refuses ~/proj/cfg/gh/hosts.yml when cfg links to ~/.config', async () => {
    link('.config', 'proj/cfg')

    await expect(invoke(IPC.fsWriteText, `${home}/proj/cfg/gh/hosts.yml`, 'oauth_token: attacker')).rejects.toThrow(PROTECTED)
    expect(content('.config/gh/hosts.yml')).toBe('oauth_token: x')
  })

  it('refuses writes where a linked ~/.ssh leads', async () => {
    moveBehindLink('.ssh', 'dotfiles/ssh')

    await expect(invoke(IPC.fsWriteText, `${home}/dotfiles/ssh/authorized_keys`, 'x')).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsWriteText, `${home}/.ssh/config`, 'x')).rejects.toThrow(PROTECTED)
  })

  it('refuses a write through a link out of the home folder', async () => {
    link('/etc', 'etc')

    await expect(invoke(IPC.fsWriteText, `${home}/etc/hosts`, 'x')).rejects.toThrow(EDITS)
    await expect(invoke(IPC.fsMkdir, `${home}/etc/new`)).rejects.toThrow(EDITS)
  })

  it('refuses mkdir, rename (both ends), trash and lock through a link to a secret', async () => {
    link('.ssh', 'innocent')

    await expect(invoke(IPC.fsMkdir, `${home}/innocent/new`)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsRename, `${home}/notes.md`, `${home}/innocent/notes.md`)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsRename, `${home}/innocent/id_rsa`, `${home}/id_rsa`)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsTrash, [`${home}/innocent/id_rsa`])).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsLock, `${home}/innocent/config.lock`, 0)).rejects.toThrow(PROTECTED)
    expect(trashItem).not.toHaveBeenCalled()
    expect(fs.existsSync(`${home}/notes.md`)).toBe(true)
  })

  it('refuses to move or trash the folder a linked ~/.ssh leads to', async () => {
    moveBehindLink('.ssh', 'dotfiles/ssh')

    await expect(invoke(IPC.fsRename, `${home}/dotfiles/ssh`, `${home}/dotfiles/old-ssh`)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsTrash, [`${home}/dotfiles/ssh/id_rsa`])).rejects.toThrow(PROTECTED)
  })

  it('moves and trashes a symlink itself, not what it points to', async () => {
    link('.ssh', 'innocent')

    await invoke(IPC.fsRename, `${home}/innocent`, `${home}/renamed`)
    expect(fs.lstatSync(`${home}/renamed`).isSymbolicLink()).toBe(true)
    await invoke(IPC.fsTrash, [`${home}/renamed`])
    expect(trashItem).toHaveBeenCalledWith(`${home}/renamed`)
  })

  it('refuses Canvas, Office and capture writes through a link to a secret', async () => {
    link('.ssh', 'innocent')

    await expect(invoke(IPC.canvasWriteFile, `${home}/innocent/picture.png`, new Uint8Array([1]))).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.canvasStreamBegin, `${home}/innocent/picture.png`, { kind: 'bytes' })).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.officeWrite, `${home}/innocent/letter.docx`, new Uint8Array([1]), { backup: false })).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.captureSaveImage, `${home}/innocent/shot.png`, 'data:image/png;base64,AA==')).rejects.toThrow(PROTECTED)
    expect(fs.readdirSync(`${home}/.ssh`)).toEqual(['id_rsa'])
  })

  it('still writes through links that stay in ordinary places', async () => {
    link('Projects/site', 'site-link')
    link('notes.md', 'notes-link.md')

    await invoke(IPC.fsWriteText, `${home}/site-link/about.html`, 'about')
    await invoke(IPC.fsWriteText, `${home}/notes-link.md`, 'edited')
    await invoke(IPC.fsWriteText, `${home}/Projects/new/deep/file.txt`, 'new')
    await invoke(IPC.canvasWriteFile, `${home}/Pictures/out.png`, new Uint8Array([1, 2]))
    await invoke(IPC.captureSaveImage, `${home}/Pictures/shot.png`, 'data:image/png;base64,AA==')

    expect(content('Projects/site/about.html')).toBe('about')
    expect(content('notes.md')).toBe('edited')
    expect(fs.lstatSync(`${home}/notes-link.md`).isSymbolicLink()).toBe(true)
    expect(content('Projects/new/deep/file.txt')).toBe('new')
    expect(fs.readFileSync(`${home}/Pictures/out.png`)).toEqual(Buffer.from([1, 2]))
    expect(fs.readFileSync(`${home}/Pictures/shot.png`)).toEqual(Buffer.from([0]))
  })
})

describe('moving and trashing folders that hold credential stores', () => {
  const exists = (file: string): boolean => fs.existsSync(path.join(home, file))

  it('refuses to rename or trash ~/.config, which holds the gh token', async () => {
    await expect(invoke(IPC.fsRename, `${home}/.config`, `${home}/cfg2`)).rejects.toThrow(HOLDS)
    await expect(invoke(IPC.fsTrash, [`${home}/.config`])).rejects.toThrow(HOLDS)
    expect(exists('.config/gh/hosts.yml')).toBe(true)
    expect(exists('cfg2')).toBe(false)
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('refuses to rename or trash a dotfiles folder holding where ~/.ssh leads', async () => {
    moveBehindLink('.ssh', 'dotfiles/ssh')

    await expect(invoke(IPC.fsRename, `${home}/dotfiles`, `${home}/moved`)).rejects.toThrow(HOLDS)
    await expect(invoke(IPC.fsTrash, [`${home}/dotfiles`])).rejects.toThrow(HOLDS)
    expect(exists('moved')).toBe(false)
    await expect(readFile(`${home}/moved/ssh/id_rsa`)).rejects.toThrow(/ENOENT/)
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('refuses to rename or trash ~/Library, which holds the keychains and cookies', async () => {
    await expect(invoke(IPC.fsRename, `${home}/Library`, `${home}/Library-old`)).rejects.toThrow(HOLDS)
    await expect(invoke(IPC.fsTrash, [`${home}/Library`])).rejects.toThrow(HOLDS)
  })

  it('refuses to rename or trash a Hermes home or a folder in it that holds a .env', async () => {
    write('.hermes/skills/deploy/.env', 'TOKEN=x')

    await expect(invoke(IPC.fsRename, hermes, `${home}/hermes-old`)).rejects.toThrow(HOLDS)
    await expect(invoke(IPC.fsRename, `${hermes}/profiles/work`, `${home}/work`)).rejects.toThrow(HOLDS)
    await expect(invoke(IPC.fsRename, `${hermes}/skills`, `${home}/skills`)).rejects.toThrow(HOLDS)
    await expect(invoke(IPC.fsTrash, [`${hermes}/skills/deploy`])).rejects.toThrow(HOLDS)
    await expect(invoke(IPC.fsTrash, [hermes])).rejects.toThrow(HOLDS)
  })

  it('refuses a rename that would put a folder where a credential store belongs', async () => {
    write('stuff/gh/hosts.yml', 'oauth_token: planted')
    fs.rmSync(path.join(home, '.config'), { recursive: true })

    await expect(invoke(IPC.fsRename, `${home}/stuff`, `${home}/.config`)).rejects.toThrow(HOLDS)
    await expect(invoke(IPC.fsRename, `${home}/stuff`, `${home}/.mozilla`)).rejects.toThrow(HOLDS)
    await expect(invoke(IPC.fsRename, `${home}/stuff`, `${home}/.ssh-new`)).resolves.toBeUndefined()
    expect(exists('.config')).toBe(false)
  })

  it('still renames and trashes ordinary folders, a project with its own .env included', async () => {
    write('.hermes/skills/notes/notes.md', '')

    await invoke(IPC.fsRename, `${home}/Projects/site`, `${home}/Projects/site2`)
    await invoke(IPC.fsRename, `${hermes}/skills/notes`, `${hermes}/skills/notes-old`)
    await invoke(IPC.fsTrash, [`${home}/Downloads`, `${home}/Projects/site2`])

    expect(exists('Projects/site2/.env')).toBe(true)
    expect(exists('.hermes/skills/notes-old/SKILL.md')).toBe(true)
    expect(trashItem.mock.calls.map(([file]) => file)).toEqual([`${home}/Downloads`, `${home}/Projects/site2`])
  })
})

describe('browser profiles', () => {
  const profiles = [
    '.config/google-chrome/Default/Cookies',
    '.config/chromium/Default/Login Data',
    '.config/BraveSoftware/Brave-Browser/Default/Cookies',
    '.config/microsoft-edge/Default/Cookies',
    '.mozilla/firefox/abcd.default-release/logins.json',
    'Library/Application Support/Google/Chrome/Default/Cookies',
    'Library/Application Support/Chromium/Default/Login Data',
    'Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies',
    'Library/Application Support/Microsoft Edge/Default/Cookies',
    'Library/Application Support/Firefox/Profiles/abcd.default/cookies.sqlite',
    'Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies',
    'Library/Cookies/Cookies.binarycookies'
  ]

  it.each(profiles)('refuses to read, list or write ~/%s', async file => {
    write(file, 'session')

    await expect(readFile(path.join(home, file))).rejects.toThrow(PROTECTED)
    await expect(readDir(path.dirname(path.join(home, file)))).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsWriteText, path.join(home, file), 'x')).rejects.toThrow(PROTECTED)
  })

  it('still lists Application Support and reads other apps there', async () => {
    write('Library/Application Support/Google/Chrome/Default/Cookies', 'session')
    write('Library/Application Support/Notes/notes.json', '{}')

    expect(await names(`${home}/Library/Application Support`)).toEqual(['Google', 'Notes'])
    expect((await readFile(`${home}/Library/Application Support/Notes/notes.json`)).content).toBe('{}')
  })
})

describe('theme images', () => {
  it('refuses to sample or save a theme image that is, or links to, a credential store', async () => {
    write('.ssh/wall.png', 'png')
    link('.ssh/wall.png', 'Pictures/wall.png')

    await expect(invoke(IPC.themeSample, `${home}/.ssh/wall.png`)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.themeSample, `file://${home}/Pictures/wall.png`)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.themeSave, { name: 'Leak' }, `${home}/Pictures/wall.png`)).rejects.toThrow(PROTECTED)
  })

  it('still samples a picture in the home folder', async () => {
    write('Pictures/beach.png', 'png')

    expect(await invoke(IPC.themeSample, `file://${home}/Pictures/beach.png`)).toBe(`data:${home}/Pictures/beach.png`)
  })
})

describe('deep operations stay in the home, Hermes home and temporary folders', () => {
  it('measures the Hermes home for Settings > Storage, without its keys', async () => {
    expect(await size(hermes)).toMatchObject({ files: 5, complete: true })
  })

  it('leaves credential stores out of the home folder size', async () => {
    write('.ssh/big', 'x'.repeat(100_000))

    // notes.md, Downloads, .Trash, two project files and five Hermes files; nothing under .ssh, .gnupg, .aws, Keychains or .config/gh.
    expect(await size(home)).toMatchObject({ files: 10 })
    expect((await size(home)).bytes).toBeLessThan(100_000)
  })

  it('leaves out where a linked ~/.ssh leads', async () => {
    moveBehindLink('.ssh', 'dotfiles/ssh')
    write('dotfiles/zshrc', 'export PATH')

    expect(await size(`${home}/dotfiles`)).toMatchObject({ files: 1, bytes: 'export PATH'.length })
    expect(await listed(`${home}/dotfiles`)).toEqual([`${home}/dotfiles/zshrc`])
  })

  it('refuses to measure or list a folder outside them', async () => {
    link('/etc', 'etc')

    await expect(invoke(IPC.fsDirSize, '/etc')).rejects.toThrow(CONFINED)
    await expect(invoke(IPC.fsDirSize, `${home}/etc`)).rejects.toThrow(CONFINED)
    await expect(invoke(IPC.fsDirSize, '/')).rejects.toThrow(CONFINED)
    await expect(invoke(IPC.fsListTree, '/usr', 100)).rejects.toThrow(PROJECT_OUTSIDE)
  })
})

describe('project folders for the Studio tree and its watcher', () => {
  it('lists and watches a project inside the home folder, with or without a trailing separator', async () => {
    const files = [`${home}/Projects/site/.env`, `${home}/Projects/site/index.html`]

    expect(await listed(`${home}/Projects/site`)).toEqual(files)
    expect(await listed(`${home}/Projects/site/`)).toEqual(files)
    expect(await listed(`${home}/Projects/site//`)).toEqual(files)
    expect(await invoke(IPC.fsWatchTree, `${home}/Projects/site/`)).toMatch(/^tree-\d+$/)
  })

  it('leaves credential stores out of a tree, by name and by where they lead', async () => {
    write('Projects/app/src/main.ts', '')
    moveBehindLink('.ssh', 'Projects/app/keys')
    link('.ssh', 'Projects/app/ssh-link')

    expect(await listed(`${home}/Projects/app`)).toEqual([`${home}/Projects/app/src`, `${home}/Projects/app/src/main.ts`, `${home}/Projects/app/ssh-link`])
  })

  it('does not report changes inside a credential store a project holds', async () => {
    moveBehindLink('.ssh', 'Projects/app/keys')
    write('Projects/app/readme.md', '')

    await invoke(IPC.fsWatchTree, `${home}/Projects/app`)
    await new Promise(resolve => setTimeout(resolve, 100))
    write('Projects/app/keys/id_new', 'KEY')
    write('Projects/app/readme.md', 'changed')
    await new Promise(resolve => setTimeout(resolve, 700))

    const reported = sender.send.mock.calls.flatMap(([, event]) => (event as { paths: string[] }).paths)
    expect(reported).toContain(`${home}/Projects/app/readme.md`)
    expect(reported.filter(file => file.includes('/keys'))).toEqual([])
  })

  it('refuses a symlink in the home folder that leads to /etc', async () => {
    link('/etc', 'etc')
    link('/', 'root')

    await expect(invoke(IPC.fsListTree, `${home}/etc`, 100)).rejects.toThrow(PROJECT_OUTSIDE)
    await expect(invoke(IPC.fsListTree, `${home}/etc/`, 100)).rejects.toThrow(PROJECT_OUTSIDE)
    await expect(invoke(IPC.fsWatchTree, `${home}/etc`)).rejects.toThrow(PROJECT_OUTSIDE)
    await expect(invoke(IPC.fsListTree, `${home}/root`, 100)).rejects.toThrow(PROJECT_OUTSIDE)
  })

  it('refuses a symlink in the home folder that leads to a credential store', async () => {
    link('.ssh', 'Projects/keys')

    await expect(invoke(IPC.fsListTree, `${home}/Projects/keys`, 100)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsListTree, `${home}/.aws`, 100)).rejects.toThrow(PROTECTED)
  })

  it('refuses the temporary folders and the root themselves, however they are written', async () => {
    for (const root of ['/tmp', '/tmp/', '/tmp//', '/private/tmp/', `${os.tmpdir()}/`, '/tmp/../tmp', '/', '//']) {
      await expect(invoke(IPC.fsListTree, root, 100)).rejects.toThrow(/system folder|project folders must be inside/)
      await expect(invoke(IPC.fsWatchTree, root)).rejects.toThrow(/system folder|project folders must be inside/)
    }
  })

  it('refuses the Hermes home as a project, and a symlink to /tmp', async () => {
    link('/tmp', 'scratch')

    await expect(assertProjectFolder(hermes)).rejects.toThrow(/system folder/)
    await expect(assertProjectFolder(`${hermes}/`)).rejects.toThrow(/system folder/)
    await expect(invoke(IPC.fsListTree, `${home}/scratch/`, 100)).rejects.toThrow(/system folder/)
  })

  it('still accepts a project folder inside a temporary folder', async () => {
    const dir = fs.mkdtempSync('/tmp/herald-project-')

    try {
      fs.writeFileSync(path.join(dir, 'index.html'), '')
      expect(await listed(`${dir}/`)).toEqual([path.join(dir, 'index.html')])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses .. that climbs out of the home folder', async () => {
    await expect(invoke(IPC.fsListTree, `${home}/Projects/../../../../../../etc`, 100)).rejects.toThrow(PROJECT_OUTSIDE)
  })
})

describe('more credential stores', () => {
  const stores = [
    '.netrc',
    '.kube/config',
    '.docker/config.json',
    '.npmrc',
    '.vault-token',
    '.cargo/credentials.toml',
    '.terraform.d/credentials.tfrc.json',
    '.config/rclone/rclone.conf',
    '.gem/credentials',
    '.m2/settings.xml',
    '.yarnrc.yml',
    '.claude/.credentials.json',
    '.codex/auth.json',
    '.zsh_history',
    '.bash_history',
    '.config/op/config',
    'Library/Messages/chat.db',
    'Library/Application Support/com.apple.TCC/TCC.db',
    'Library/Safari/History.db',
    'Library/Application Support/Arc/User Data/Default/Cookies',
    'Library/Application Support/Google/Chrome Beta/Default/Cookies',
    'Library/Application Support/Google/Chrome Canary/Default/Cookies',
    'Library/Application Support/Vivaldi/Default/Cookies',
    'Library/Application Support/com.operasoftware.Opera/Cookies',
    '.config/vivaldi/Default/Cookies',
    '.config/opera/Cookies',
    '.config/google-chrome-beta/Default/Cookies',
    'snap/firefox/common/.mozilla/firefox/abcd.default/logins.json',
    '.var/app/org.mozilla.firefox/.mozilla/firefox/abcd.default/logins.json',
    '.var/app/com.google.Chrome/config/google-chrome/Default/Cookies',
    '.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser/Default/Cookies',
    'Library/Group Containers/2BUA8C4S2C.com.1password/Library/Application Support/1Password/Data/1password.sqlite',
    'Library/Group Containers/2BUA8C4S2C.com.agilebits/Library/Application Support/1Password/data.sqlite',
    'Library/Containers/com.agilebits.onepassword7/Data/Library/data.sqlite',
    'Library/Containers/com.1password.1password/Data/Library/data.sqlite',
    '.config/1Password/settings/settings.json',
    'Library/Application Support/1Password/data.sqlite',
    '.config/Code/User/globalStorage/state.vscdb',
    'Library/Application Support/Code/User/globalStorage/state.vscdb',
    '.config/github-copilot/apps.json',
    '.ollama/id_ed25519',
    '.pgpass',
    '.my.cnf',
    '.s3cfg',
    '.boto',
    '.config/hub',
    '.config/heroku/config.json',
    '.config/doctl/config.yaml',
    'Library/Application Support/doctl/config.yaml',
    '.fly/config.yml',
    '.wrangler/config/default.toml',
    '.config/stripe/config.toml',
    '.config/microsoft-edge-beta/Default/Cookies',
    '.config/microsoft-edge-dev/Default/Cookies',
    'Library/Application Support/Microsoft Edge Beta/Default/Cookies',
    'Library/Application Support/Microsoft Edge Dev/Default/Cookies',
    '.python_history',
    '.psql_history',
    '.mysql_history'
  ]

  it.each(stores)('refuses to read or write ~/%s', async file => {
    write(file, 'secret')

    await expect(readFile(path.join(home, file))).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsWriteText, path.join(home, file), 'x')).rejects.toThrow(PROTECTED)
  })

  it('refuses a 1Password group container behind a symlink, and leaves other group containers readable', async () => {
    write('Library/Group Containers/2BUA8C4S2C.com.1password/data.sqlite', 'vault')
    write('Library/Group Containers/group.com.apple.notes/notes.json', '{}')
    moveBehindLink('Library/Group Containers/2BUA8C4S2C.com.1password', 'vault/op')

    await expect(readFile(`${home}/vault/op/data.sqlite`)).rejects.toThrow(PROTECTED)
    await expect(readFile(`${home}/Library/Group Containers/2BUA8C4S2C.com.1PASSWORD/data.sqlite`)).rejects.toThrow(PROTECTED)
    expect((await readFile(`${home}/Library/Group Containers/group.com.apple.notes/notes.json`)).content).toBe('{}')
  })

  it('refuses a .env at any depth in a Hermes home, and nothing that only looks like one', async () => {
    write('.hermes/skills/deploy/config/.env', 'TOKEN=x')
    write('.hermes/skills/deploy/.env.production', 'TOKEN=x')
    write('.hermes/skills/deploy/env.md', 'about env')
    write('Projects/site/config/.env.production', 'PROJECT=x')

    await expect(readFile(`${hermes}/skills/deploy/config/.env`)).rejects.toThrow(PROTECTED)
    await expect(readFile(`${hermes}/skills/deploy/.env.production`)).rejects.toThrow(PROTECTED)
    await expect(readDir(`${hermes}/skills/deploy/config/.env`)).rejects.toThrow(PROTECTED)
    expect((await readFile(`${hermes}/skills/deploy/env.md`)).content).toBe('about env')
    expect((await readFile(`${home}/Projects/site/config/.env.production`)).content).toBe('PROJECT=x')
  })

  it("finds each profile's key files, so links to them are refused", async () => {
    write('.hermes/profiles/work/.env.production', 'KEY=x')
    write('.hermes/profiles/work/auth.json', '{}')
    moveBehindLink('.hermes/profiles/work/auth.json', 'vault/work-auth')
    write('.hermes/profiles/work/auth.json-old', '{}')
    moveBehindLink('.hermes/profiles/work/.env.production', 'vault/work-production')
    moveBehindLink('.hermes/profiles/work/.env.local', 'vault/work-local')
    write('vault/unrelated.txt', 'fine')

    await expect(readFile(`${home}/vault/work-auth`)).rejects.toThrow(PROTECTED)
    await expect(readFile(`${home}/vault/work-production`)).rejects.toThrow(PROTECTED)
    await expect(readFile(`${home}/vault/work-local`)).rejects.toThrow(PROTECTED)
    expect((await readFile(`${home}/vault/unrelated.txt`)).content).toBe('fine')
  })

  it('leaves key files and stores out of a Hermes home listing and of ~/.config, but not of the home folder', async () => {
    write('.config/nvim/init.lua', '')
    link('.hermes', 'hermes-link')

    expect(await names(hermes)).toEqual(expect.arrayContaining(['config.yaml', 'memories', 'profiles']))
    expect(await names(hermes)).not.toContain('.env')
    expect(await names(hermes)).not.toContain('auth.json')
    expect(await names(`${home}/hermes-link`)).not.toContain('.env')
    expect(await names(`${hermes}/profiles/work`)).toEqual([])
    expect(await names(`${home}/.config`)).toEqual(['nvim'])
    expect(await names(home)).toEqual(expect.arrayContaining(['.ssh', '.aws', '.config']))
  })
})

describe('case folding on macOS', () => {
  it('matches credential stores and .env files without regard to case on macOS', async () => {
    await onPlatform('darwin', async () => {
      await expect(readFile(`${home}/.SSH/id_rsa`)).rejects.toThrow(PROTECTED)
      await expect(readFile(`${home}/library/keychains/login.keychain-db`)).rejects.toThrow(PROTECTED)
      await expect(readFile(`${hermes}/.ENV`)).rejects.toThrow(PROTECTED)
      await expect(readFile(`${hermes}/skills/x/.Env.Local`)).rejects.toThrow(PROTECTED)
      await expect(readFile(`${hermes}/skills/x/.ENV`)).rejects.toThrow(PROTECTED)
      await expect(readFile(`${hermes}/AUTH.json`)).rejects.toThrow(PROTECTED)
    })
  })

  it('finds a .ENV in a Hermes folder on macOS before moving it', async () => {
    write('.hermes/skills/deploy/.ENV', 'TOKEN=x')

    await onPlatform('darwin', async () => {
      await expect(invoke(IPC.fsTrash, [`${hermes}/skills/deploy`])).rejects.toThrow(HOLDS)
    })
    expect(trashItem).not.toHaveBeenCalled()
  })

  it.runIf(process.platform === 'linux')('treats other spellings as other files on Linux', async () => {
    await expect(readFile(`${home}/.SSH/id_rsa`)).rejects.toThrow(/ENOENT/)
    await expect(readFile(`${hermes}/.ENV`)).rejects.toThrow(/ENOENT/)
    await expect(readFile(`${hermes}/skills/x/.Env.Local`)).rejects.toThrow(/ENOENT/)
  })
})

describe('the narrower checks', () => {
  it('lets a Hermes home outside the home folder be measured, but not be a project', async () => {
    const moved = fs.realpathSync(fs.mkdtempSync(path.join(BASE, 'herald-hermes-')))
    vi.stubEnv('HERMES_HOME', moved)

    try {
      fs.mkdirSync(path.join(moved, 'skills', 'notes'), { recursive: true })
      fs.writeFileSync(path.join(moved, 'skills', 'notes', 'SKILL.md'), '# Notes')

      expect(await size(moved)).toMatchObject({ files: 1 })
      await expect(invoke(IPC.fsListTree, path.join(moved, 'skills'), 100)).rejects.toThrow(PROJECT_OUTSIDE)
      await expect(invoke(IPC.fsWatchTree, path.join(moved, 'skills'))).rejects.toThrow(PROJECT_OUTSIDE)
    } finally {
      fs.rmSync(moved, { recursive: true, force: true })
    }
  })

  it('refuses a folder outside the home and temporary folders for deep walks', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(BASE, 'herald-outside-')))

    try {
      fs.writeFileSync(path.join(outside, 'a.txt'), 'a')

      expect(await names(outside)).toEqual(['a.txt'])
      await expect(invoke(IPC.fsDirSize, outside)).rejects.toThrow(CONFINED)
      await expect(invoke(IPC.fsListTree, outside, 100)).rejects.toThrow(PROJECT_OUTSIDE)
      await expect(invoke(IPC.fsWriteText, path.join(outside, 'b.txt'), 'b')).rejects.toThrow(EDITS)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses a credential store before touching the disk, so a symlink loop in one is refused, not reported', async () => {
    link('.ssh/loop', '.ssh/loop')

    await expect(readFile(`${home}/.ssh/loop`)).rejects.toThrow(PROTECTED)
    await expect(readFile(`${home}/.ssh/loop/deeper`)).rejects.toThrow(PROTECTED)
  })

  it('counts a project under the resolved temporary folder as temporary', async () => {
    const real = fs.realpathSync(fs.mkdtempSync(path.join(BASE, 'herald-temp-')))
    const linked = `${real}-link`
    fs.symlinkSync(real, linked)
    fs.mkdirSync(path.join(real, 'site'))
    fs.writeFileSync(path.join(real, 'site', 'index.html'), '')
    const tmpdir = vi.spyOn(os, 'tmpdir').mockReturnValue(linked)

    try {
      expect(await assertProjectFolder(path.join(real, 'site'))).toBe(path.join(real, 'site'))
      await expect(assertProjectFolder(real)).rejects.toThrow(/system folder/)
    } finally {
      tmpdir.mockRestore()
      fs.rmSync(linked)
      fs.rmSync(real, { recursive: true, force: true })
    }
  })

  it('refuses / as a project even when it is the home folder', async () => {
    vi.stubEnv('HOME', '/')

    await expect(assertProjectFolder('/')).rejects.toThrow(/system folder/)
  })

  it('refuses a project that is inside the home folder only as written', async () => {
    const moved = fs.realpathSync(fs.mkdtempSync(path.join(BASE, 'herald-hermes-')))
    vi.stubEnv('HERMES_HOME', moved)

    try {
      fs.mkdirSync(path.join(moved, 'skills'))
      link(path.join(moved, 'skills'), 'skills-link')

      await expect(invoke(IPC.fsListTree, `${home}/skills-link`, 100)).rejects.toThrow(PROJECT_OUTSIDE)
    } finally {
      fs.rmSync(moved, { recursive: true, force: true })
    }
  })

  it('refuses a write through a path outside the home folder, even one that leads into it', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(BASE, 'herald-outside-')))

    try {
      fs.symlinkSync(`${home}/Projects`, path.join(outside, 'projects'))

      await expect(invoke(IPC.fsWriteText, path.join(outside, 'projects', 'planted.txt'), 'x')).rejects.toThrow(EDITS)
      expect(fs.existsSync(`${home}/Projects/planted.txt`)).toBe(false)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses to trash, rename or write the home folder itself', async () => {
    await expect(invoke(IPC.fsTrash, [home])).rejects.toThrow(EDITS)
    await expect(invoke(IPC.fsTrash, [`${home}/`])).rejects.toThrow(EDITS)
    await expect(invoke(IPC.fsRename, home, `${home}-moved`)).rejects.toThrow(EDITS)
    expect(trashItem).not.toHaveBeenCalled()
  })

  it.runIf(fs.existsSync('/usr/lib'))('refuses a write in a system folder even when the home folder is in one', async () => {
    vi.stubEnv('HOME', '/usr')

    await expect(assertWritable('/usr/lib/new-file')).rejects.toThrow(PROTECTED)
  })

  it('judges a tree by where its root resolves, so a link to a project holding the ssh target leaves it out', async () => {
    write('Projects/app/src/main.ts', '')
    moveBehindLink('.ssh', 'Projects/app/keys')
    link('Projects/app', 'app-link')

    expect(await listed(`${home}/app-link`)).toEqual([`${home}/app-link/src`, `${home}/app-link/src/main.ts`])
    expect(await size(`${home}/app-link`)).toMatchObject({ files: 1 })
  })

  it('refuses to move a folder that only holds a credential store once its parent resolves', async () => {
    moveBehindLink('.ssh', 'realdir/dotfiles/ssh')
    link('realdir', 'linkdir')

    await expect(invoke(IPC.fsTrash, [`${home}/linkdir/dotfiles`])).rejects.toThrow(HOLDS)
    await expect(invoke(IPC.fsRename, `${home}/linkdir/dotfiles`, `${home}/moved`)).rejects.toThrow(HOLDS)
    expect(trashItem).not.toHaveBeenCalled()
  })

  it(`looks through ${ENV_SEARCH_LIMIT} entries of a Hermes folder for a .env, and refuses a larger one as too large to check`, async () => {
    const fill = (dir: string, count: number) => {
      fs.mkdirSync(path.join(hermes, dir), { recursive: true })

      for (let i = 0; i < count; i++) {
        fs.writeFileSync(path.join(hermes, dir, `f${i}`), '')
      }
    }
    fill('skills/fits', ENV_SEARCH_LIMIT)
    fill('skills/big', ENV_SEARCH_LIMIT + 1)

    await invoke(IPC.fsTrash, [`${hermes}/skills/fits`])
    expect(trashItem).toHaveBeenCalledWith(`${hermes}/skills/fits`)
    await expect(invoke(IPC.fsTrash, [`${hermes}/skills/big`])).rejects.toThrow(TOO_LARGE)
    await expect(invoke(IPC.fsRename, `${hermes}/skills/big`, `${home}/big`)).rejects.toThrow(TOO_LARGE)
  })
})

describe('opening checked paths', () => {
  it('does not follow a symlink in the last place of a checked path', async () => {
    link('notes.md', 'notes-link.md')
    const swapped = { path: `${home}/notes-link.md`, real: `${home}/notes-link.md` }

    await expect(openChecked(swapped, fs.constants.O_RDONLY)).rejects.toThrow(/ELOOP|EMLINK/)
    await expect(writeChecked(swapped, 'x')).rejects.toThrow(/ELOOP|EMLINK/)
    expect(fs.readFileSync(`${home}/notes.md`, 'utf8')).toBe('notes')
  })

  const swapParent = () => {
    write('.ssh/a.txt', 'PRIVATE')
    fs.renameSync(`${home}/dir`, `${home}/dir-old`)
    link('.ssh', 'dir')
  }

  it('refuses a file whose folder was swapped for a link to a credential store after the check', async () => {
    write('dir/a.txt', 'public')
    const checked = await assertReadable(`${home}/dir/a.txt`)
    swapParent()

    await expect(openChecked(checked, fs.constants.O_RDONLY)).rejects.toThrow(CHANGED)
    await onPlatform('darwin', async () => {
      await expect(openChecked(checked, fs.constants.O_RDONLY)).rejects.toThrow(CHANGED)
    })
  })

  it('refuses such a write before anything is truncated', async () => {
    write('dir/a.txt', 'public')
    const checked = await checkWritable(`${home}/dir/a.txt`)
    swapParent()

    await expect(writeChecked(checked, 'overwritten')).rejects.toThrow(CHANGED)
    await onPlatform('darwin', async () => {
      await expect(writeChecked(checked, 'overwritten')).rejects.toThrow(CHANGED)
    })
    expect(fs.readFileSync(`${home}/.ssh/a.txt`, 'utf8')).toBe('PRIVATE')
  })

  const realOpen = fsp.open
  const contentOf = async (handle: fsp.FileHandle): Promise<string> => {
    try {
      return await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  }

  it('refuses a file opened while its folder was swapped and swapped back, however often it is tried', async () => {
    write('dir/a.txt', 'public')
    const checked = await assertReadable(`${home}/dir/a.txt`)
    const swapped = () => vi.spyOn(fsp, 'open').mockImplementation((_file, flags) => realOpen(`${home}/.ssh/id_rsa`, flags))

    try {
      const open = swapped()
      await expect(openChecked(checked, fs.constants.O_RDONLY)).rejects.toThrow(CHANGED)
      expect(open).toHaveBeenCalledTimes(OPEN_ATTEMPTS)
      await onPlatform('darwin', async () => {
        await expect(openChecked(checked, fs.constants.O_RDONLY)).rejects.toThrow(CHANGED)
      })
    } finally {
      vi.mocked(fsp.open).mockRestore()
    }
  })

  it('opens again after a swap that was undone, and gets the checked file', async () => {
    write('dir/a.txt', 'public')
    const checked = await assertReadable(`${home}/dir/a.txt`)

    for (const platform of ['linux', 'darwin'] as const) {
      await onPlatform(platform, async () => {
        const open = vi.spyOn(fsp, 'open').mockImplementationOnce((_file, flags) => realOpen(`${home}/.ssh/id_rsa`, flags))

        expect(await contentOf(await openChecked(checked, fs.constants.O_RDONLY))).toBe('public')
        expect(open).toHaveBeenCalledTimes(2)
        open.mockRestore()
      })
    }
  })

  /** Open the file, then save a new version over it by renaming, as Hermes saves memory files. */
  const replacedWhileOpening = (file: string, next: string) =>
    vi.spyOn(fsp, 'open').mockImplementationOnce(async (target, flags) => {
      const handle = await realOpen(target, flags)
      fs.writeFileSync(`${file}.tmp`, next)
      fs.renameSync(`${file}.tmp`, file)

      return handle
    })

  it.runIf(process.platform === 'linux')('reads a file replaced by a rename while it was being opened, as the version it opened', async () => {
    write('.hermes/memories/MEMORY.md', 'old')
    const checked = await assertReadable(`${hermes}/memories/MEMORY.md`)
    const open = replacedWhileOpening(`${hermes}/memories/MEMORY.md`, 'new')

    expect(await contentOf(await openChecked(checked, fs.constants.O_RDONLY))).toBe('old')
    expect(open).toHaveBeenCalledTimes(1)
    open.mockRestore()
  })

  it('opens again when a file is replaced by a rename while it is being opened elsewhere than Linux', async () => {
    write('.hermes/memories/MEMORY.md', 'old')
    const checked = await assertReadable(`${hermes}/memories/MEMORY.md`)

    await onPlatform('darwin', async () => {
      const open = replacedWhileOpening(`${hermes}/memories/MEMORY.md`, 'new')

      expect(await contentOf(await openChecked(checked, fs.constants.O_RDONLY))).toBe('new')
      expect(open).toHaveBeenCalledTimes(2)
      open.mockRestore()
    })
  })

  it('writes to the new file, not the replaced one, when a file is replaced while a write opens it', async () => {
    write('.hermes/memories/MEMORY.md', 'old')
    const checked = await checkWritable(`${hermes}/memories/MEMORY.md`)
    const open = replacedWhileOpening(`${hermes}/memories/MEMORY.md`, 'new')

    await writeChecked(checked, 'written')
    expect(open).toHaveBeenCalledTimes(2)
    expect(fs.readFileSync(`${hermes}/memories/MEMORY.md`, 'utf8')).toBe('written')
    open.mockRestore()
  })

  it('opens a read-write file again when it is replaced while it is being opened', async () => {
    write('.hermes/memories/MEMORY.md', 'old')
    const checked = await checkWritable(`${hermes}/memories/MEMORY.md`)
    const open = replacedWhileOpening(`${hermes}/memories/MEMORY.md`, 'new')

    expect(await contentOf(await openChecked(checked, fs.constants.O_RDWR))).toBe('new')
    expect(open).toHaveBeenCalledTimes(2)
    open.mockRestore()
  })

  it('opens again at once a few times, then waits longer each time, with jitter, up to a cap', () => {
    for (let attempt = 1; attempt <= OPEN_IMMEDIATE_RETRIES; attempt++) {
      expect(openBackoff(attempt, () => 1)).toBe(0)
    }

    expect([1, 2, 3, 4, 5].map(step => openBackoff(OPEN_IMMEDIATE_RETRIES + step, () => 1))).toEqual([5, 10, 20, 40, 40])
    expect([1, 2, 3].map(step => openBackoff(OPEN_IMMEDIATE_RETRIES + step, () => 0))).toEqual([2.5, 5, 10])
    expect(openBackoff(OPEN_IMMEDIATE_RETRIES + 20, () => 0.5)).toBe(30)
  })

  it('waits before each retry it makes, reaching every step and the cap, within the budget', () => {
    const waits = Array.from({ length: OPEN_ATTEMPTS - 1 }, (_, index) => openBackoff(index + 1, () => 1))

    expect(waits).toEqual([0, 0, 0, 0, 0, 5, 10, 20, 40])
    expect(Math.max(...waits)).toBe(OPEN_BACKOFF_MAX_MS)
    expect(waits.reduce((sum, wait) => sum + wait, 0)).toBeLessThan(OPEN_RETRY_BUDGET_MS)
  })

  it('closes every handle it does not return, and refuses a swap that persists within the retry budget', async () => {
    write('dir/a.txt', 'public')
    const checked = await assertReadable(`${home}/dir/a.txt`)
    const opened: fsp.FileHandle[] = []
    const open = vi.spyOn(fsp, 'open').mockImplementation(async (_file, flags) => {
      const handle = await realOpen(`${home}/.ssh/id_rsa`, flags)
      opened.push(handle)

      return handle
    })

    try {
      for (const platform of ['linux', 'darwin'] as const) {
        opened.length = 0
        const started = Date.now()

        await onPlatform(platform, async () => {
          await expect(openChecked(checked, fs.constants.O_RDONLY)).rejects.toThrow(CHANGED)
        })
        expect(Date.now() - started).toBeLessThan(OPEN_RETRY_BUDGET_MS + 250)
        expect(opened).toHaveLength(OPEN_ATTEMPTS)
        expect(opened.every(handle => handle.fd === -1)).toBe(true)
      }
    } finally {
      open.mockRestore()
    }
  })

  it('stops opening again once the retry budget is spent, however slow each open is', async () => {
    write('dir/a.txt', 'public')
    const checked = await assertReadable(`${home}/dir/a.txt`)
    const slow = OPEN_RETRY_BUDGET_MS / 4
    const open = vi.spyOn(fsp, 'open').mockImplementation(async (_file, flags) => {
      await new Promise(resolve => setTimeout(resolve, slow))

      return realOpen(`${home}/.ssh/id_rsa`, flags)
    })
    const started = Date.now()

    try {
      await expect(openChecked(checked, fs.constants.O_RDONLY)).rejects.toThrow(CHANGED)
      expect(open.mock.calls.length).toBeLessThan(OPEN_ATTEMPTS)
      expect(Date.now() - started).toBeLessThan(OPEN_RETRY_BUDGET_MS + 2 * slow)
    } finally {
      open.mockRestore()
    }
  })

  /** Hermes saving a file over and over: write a temporary file and rename it over `file`, `perSecond` times a second, in another process. */
  const saving = (file: string, perSecond: number) =>
    spawn(process.execPath, ['-e', `const fs = require('fs'); let i = 0; setInterval(() => { const tmp = ${JSON.stringify(file)} + '.hermes-tmp.' + (i++ % 4); fs.writeFileSync(tmp, 'hermes ' + i); fs.renameSync(tmp, ${JSON.stringify(file)}) }, ${Math.round(1000 / perSecond)})`], { stdio: 'ignore' })

  it.each(['linux', 'darwin'] as const)('writes through rename-over saves at 50 a second, as written on %s, and only to the checked file', async platform => {
    write('.hermes/memories/MEMORY.md', 'start')
    const file = `${hermes}/memories/MEMORY.md`
    const saver = saving(file, 50)
    const total = 150
    let written = 0

    try {
      await new Promise(resolve => setTimeout(resolve, 200))
      await onPlatform(platform, async () => {
        for (let i = 0; i < total; i++) {
          try {
            await writeChecked(await checkWritable(file), `files ${i}`)
            written++
            await (await openChecked(await assertReadable(file), fs.constants.O_RDONLY)).close()
          } catch {
            // Counted below.
          }
          await new Promise(resolve => setTimeout(resolve, 5))
        }
      })
    } finally {
      saver.kill('SIGKILL')
    }

    expect(written / total).toBeGreaterThanOrEqual(0.99)
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^(files|hermes) \d+$/)
    expect(fs.readdirSync(`${hermes}/memories`).filter(name => !name.startsWith('MEMORY.md.hermes-tmp.'))).toEqual(['MEMORY.md', 'USER.md'])
    expect(fs.readFileSync(`${home}/.ssh/id_rsa`, 'utf8')).toBe('PRIVATE KEY')
  }, 20_000)

  it.runIf(process.platform === 'linux')('does not take a file named like a replaced one for it', async () => {
    write('dir/a.txt (deleted)', 'other')
    write('dir/a.txt', 'public')
    const checked = await assertReadable(`${home}/dir/a.txt`)
    const open = vi.spyOn(fsp, 'open').mockImplementation((_file, flags) => realOpen(`${home}/dir/a.txt (deleted)`, flags))

    await expect(openChecked(checked, fs.constants.O_RDONLY)).rejects.toThrow(CHANGED)
    open.mockRestore()
  })

  it('opens and writes a checked path that did not change, on Linux and macOS alike', async () => {
    write('dir/a.txt', 'public')
    const checked = await checkWritable(`${home}/dir/a.txt`)

    await writeChecked(checked, 'longer content')
    await writeChecked(checked, 'short')
    expect(fs.readFileSync(`${home}/dir/a.txt`, 'utf8')).toBe('short')
    await onPlatform('darwin', async () => {
      await (await openChecked(checked, fs.constants.O_RDONLY)).close()
      await writeChecked(await checkWritable(`${home}/dir/new.txt`), 'new')
    })
    expect(fs.readFileSync(`${home}/dir/new.txt`, 'utf8')).toBe('new')
  })
})

describe('opening, revealing and launching', () => {
  it('opens the resolved file in a viewer, and never a credential store', async () => {
    write('Documents/report.pdf', '%PDF')
    link('Documents/report.pdf', 'report-link.pdf')

    await invoke(IPC.webOpenFile, `${home}/report-link.pdf`)
    expect(openFile).toHaveBeenCalledWith(sender, `${home}/Documents/report.pdf`, {})
    await expect(invoke(IPC.webOpenFile, `${hermes}/.env`)).rejects.toThrow(PROTECTED)
    expect(openFile).toHaveBeenCalledTimes(1)
  })

  it('opens files and folders in other apps, but not credential stores', async () => {
    link('.ssh', 'keys')

    await invoke(IPC.fsOpenPath, `${home}/notes.md`)
    expect(openPath).toHaveBeenCalledWith(`${home}/notes.md`)
    await expect(invoke(IPC.fsOpenPath, `${home}/.ssh/id_rsa`)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsOpenPath, `${home}/keys/id_rsa`)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsOpenIn, 'editor', `${hermes}/.env`)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsOpenIn, 'terminal', `${home}/.ssh`)).rejects.toThrow(PROTECTED)
    await invoke(IPC.fsOpenIn, 'editor', `${home}/Projects/site`)
    expect(openPath).toHaveBeenCalledTimes(1)
    expect(platform.openIn).toHaveBeenCalledWith('editor', `${home}/Projects/site`)
    expect(platform.openIn).toHaveBeenCalledTimes(1)
  })

  it("reveals a credential store's own entry in its parent instead of opening the store", async () => {
    moveBehindLink('.config', 'dotfiles/config')
    link('.ssh', 'keys')

    await invoke(IPC.fsReveal, `${home}/.ssh/id_rsa`)
    await invoke(IPC.fsReveal, `${home}/keys/id_rsa`)
    await invoke(IPC.fsReveal, `${home}/.config/gh/hosts.yml`)
    await invoke(IPC.fsReveal, `${home}/dotfiles/config/gh/hosts.yml`)
    await invoke(IPC.fsReveal, `${hermes}/profiles/work/.env`)
    await invoke(IPC.fsReveal, `${home}/notes.md`)

    expect(platform.revealPath.mock.calls.map(([file]) => file)).toEqual([`${home}/.ssh`, `${home}/.ssh`, `${home}/.config/gh`, `${home}/dotfiles/config/gh`, `${hermes}/profiles/work/.env`, `${home}/notes.md`])
  })

  it('launches apps and reads their icons through the resolved path, never from a credential store', async () => {
    write('Applications/Notes.app/Contents/Info.plist', '')
    link('Applications/Notes.app', 'Notes-link.app')

    await invoke(IPC.appsLaunch, `${home}/Notes-link.app`)
    expect(platform.launchApp).toHaveBeenCalledWith(`${home}/Applications/Notes.app`)
    expect(await invoke(IPC.appsIcon, `${home}/Notes-link.app`)).toBe(`data:image/png;base64,${Buffer.from('icon').toString('base64')}`)
    await expect(invoke(IPC.appsLaunch, `${home}/.ssh/id_rsa`)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.appsIcon, `${home}/.aws/credentials`)).rejects.toThrow(PROTECTED)
    expect(platform.launchApp).toHaveBeenCalledTimes(1)
  })
})

describe('the Studio preview', () => {
  const allowAll = () => true

  it('serves only resolved files that are not credential stores', async () => {
    link(`${hermes}/.env`, 'Projects/site/env.txt')
    link('Projects/site/index.html', 'Projects/site/home.html')

    const served = async (file: string) => {
      const open = await servableFile(pathToFileURL(file).toString(), allowAll)
      await open?.handle.close()

      return open && { real: open.real, size: open.size }
    }

    expect(await served(`${home}/Projects/site/index.html`)).toEqual({ real: `${home}/Projects/site/index.html`, size: 11 })
    expect(await served(`${home}/Projects/site/home.html`)).toEqual({ real: `${home}/Projects/site/index.html`, size: 11 })
    expect(await served(`${home}/Projects/site`)).toBeNull()
    expect(await served(`${home}/Projects/site/missing.html`)).toBeNull()
    expect(await servableFile(pathToFileURL(`${hermes}/.env`).toString(), allowAll)).toBeNull()
    expect(await servableFile(pathToFileURL(`${home}/.ssh/id_rsa`).toString(), allowAll)).toBeNull()
    expect(await servableFile(pathToFileURL(`${home}/Projects/site/env.txt`).toString(), allowAll)).toBeNull()
    expect(await servableFile(pathToFileURL(`${home}/notes.md`).toString(), file => file.startsWith(`${home}/Projects/`))).toBeNull()
    expect(await servableFile('file://other-host/etc/passwd', allowAll)).toBeNull()
  })

  it('serves through the registered file:// handler only what servableFile allows, from the checked file', async () => {
    write('Projects/site/clip.mp4', '0123456789')
    link(`${hermes}/.env`, 'Projects/site/env.txt')
    confineFiles('test-partition', file => file.startsWith(`${home}/Projects/`))
    const handler = fileHandlers.get('test-partition:file')!
    const fetchFile = (file: string, headers: Record<string, string> = {}) => handler(new Request(pathToFileURL(file), { headers }))

    const page = await fetchFile(`${home}/Projects/site/index.html`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await page.text()).toBe('<h1>hi</h1>')

    for (const [file, type] of [
      ['app.js', 'text/javascript; charset=utf-8'],
      ['app.mjs', 'text/javascript; charset=utf-8'],
      ['style.css', 'text/css; charset=utf-8'],
      ['data.json', 'application/json; charset=utf-8'],
      ['site.webmanifest', 'application/manifest+json; charset=utf-8'],
      ['notes.txt', 'text/plain; charset=utf-8'],
      ['logo.png', 'image/png'],
      ['blob.bin', 'application/octet-stream']
    ]) {
      write(`Projects/site/${file}`, 'x')
      const response = await fetchFile(`${home}/Projects/site/${file}`)
      expect(response.headers.get('content-type')).toBe(type)
      await response.arrayBuffer()
    }

    const part = await fetchFile(`${home}/Projects/site/clip.mp4`, { range: 'bytes=2-5' })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await part.text()).toBe('2345')
    expect(await (await fetchFile(`${home}/Projects/site/clip.mp4`, { range: 'bytes=-3' })).text()).toBe('789')
    expect((await fetchFile(`${home}/Projects/site/clip.mp4`, { range: 'bytes=20-' })).status).toBe(416)

    const ranged = async (range: string) => {
      const response = await fetchFile(`${home}/Projects/site/clip.mp4`, { range })

      return [response.status, response.headers.get('content-range'), response.headers.get('content-length'), await response.text()]
    }

    expect(await ranged('bytes=2-100')).toEqual([206, 'bytes 2-9/10', '8', '23456789'])
    expect(await ranged('bytes=-100')).toEqual([206, 'bytes 0-9/10', '10', '0123456789'])
    expect(await ranged('bytes=7-')).toEqual([206, 'bytes 7-9/10', '3', '789'])
    expect(await ranged('  bytes=2-5  ')).toEqual([206, 'bytes 2-5/10', '4', '2345'])
    expect(await ranged('xbytes=2-5')).toEqual([200, null, '10', '0123456789'])
    expect(await ranged('bytes=2-5x')).toEqual([200, null, '10', '0123456789'])
    expect(await ranged('bytes=2-5,7-8')).toEqual([200, null, '10', '0123456789'])
    expect(await ranged('bytes=-')).toEqual([200, null, '10', '0123456789'])
    expect((await fetchFile(`${home}/Projects/site/clip.mp4`)).headers.get('content-length')).toBe('10')

    // Fetch headers come trimmed; a range handed over directly may not be.
    const direct = await servableFile(pathToFileURL(`${home}/Projects/site/clip.mp4`).toString(), () => true)
    expect(await serveOpenFile(direct!, '  bytes=2-5  ').text()).toBe('2345')

    write('Projects/site/INDEX.HTML', '<p>upper</p>')
    const upper = await fetchFile(`${home}/Projects/site/INDEX.HTML`)
    expect(upper.headers.get('content-type')).toBe('text/html; charset=utf-8')
    await upper.arrayBuffer()

    write('Projects/site/empty.css', '')
    const empty = await fetchFile(`${home}/Projects/site/empty.css`)
    expect([empty.status, empty.headers.get('content-length'), empty.headers.get('content-type'), await empty.text()]).toEqual([200, '0', 'text/css; charset=utf-8', ''])

    fs.mkdirSync(`${home}/Projects/site/assets`)
    const folder = await fetchFile(`${home}/Projects/site/assets`)
    expect(folder.status).toBe(404)

    for (const refused of [`${home}/Projects/site/env.txt`, `${hermes}/.env`, `${home}/.ssh/id_rsa`, `${home}/notes.md`, `${home}/Projects/site/missing.html`]) {
      const response = await fetchFile(refused)
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('')
    }
  })

  it('refuses to serve a file whose open lands somewhere other than the checked file', async () => {
    const realOpen = fsp.open
    const open = vi.spyOn(fsp, 'open').mockImplementation((_file, flags) => realOpen(`${home}/.ssh/id_rsa`, flags))

    try {
      expect(await servableFile(pathToFileURL(`${home}/Projects/site/index.html`).toString(), allowAll)).toBeNull()
    } finally {
      open.mockRestore()
    }
  })

  it('accepts a project folder inside the home folder as the preview folder', async () => {
    expect(await assertPreviewFolder(`${home}/Projects/site/`)).toEqual({ path: `${home}/Projects/site`, real: `${home}/Projects/site` })
  })

  it('refuses the home folder or wider, a credential store, and a folder holding one as the preview folder', async () => {
    moveBehindLink('.ssh', 'dotfiles/ssh')
    link('', 'home-link')
    const preview = (root: string) => invoke(IPC.webOpenPreview, 'index.html', { root })

    await expect(preview('~')).rejects.toThrow(/inside your home folder/)
    await expect(preview(`${home}/`)).rejects.toThrow(/inside your home folder/)
    await expect(preview(`${home}/home-link`)).rejects.toThrow(/inside your home folder/)
    await expect(preview('/')).rejects.toThrow(/system folder|inside your home folder/)
    await expect(preview(path.dirname(home))).rejects.toThrow(/inside your home folder/)
    await expect(preview(`${home}/.aws`)).rejects.toThrow(PROTECTED)
    await expect(preview(`${home}/dotfiles`)).rejects.toThrow(HOLDS)
    await expect(preview(`${home}/.config`)).rejects.toThrow(HOLDS)
    await expect(preview(hermes)).rejects.toThrow(/system folder/)
  })
})
