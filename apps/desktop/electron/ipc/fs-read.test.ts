import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  BrowserWindow: class {},
  clipboard: {},
  ClipboardItem: class {},
  dialog: {},
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler), on: () => {} },
  nativeImage: { createFromPath: (file: string) => ({ toDataURL: () => `data:${file}`, isEmpty: () => false, toPNG: () => Buffer.alloc(0) }) },
  shell: {},
  systemPreferences: {},
  webContents: { getAllWebContents: () => [] },
  app: { getPath: () => '/tmp', on: () => {} }
}))
vi.mock('../log.ts', () => ({ log: vi.fn() }))

const { HOME_SECRETS, assertProjectFolder, assertReadable, readDir, readFile, registerFsIpc } = await import('./fs.ts')
const { registerCanvasIpc } = await import('../canvas/ipc.ts')
const { registerOfficeIpc } = await import('../office/ipc.ts')
const { registerCaptureIpc } = await import('./capture.ts')
const { IPC } = await import('../../shared/ipc.ts')

registerFsIpc(() => null)
registerCanvasIpc(() => null)
registerOfficeIpc(() => null)
registerCaptureIpc(() => {})

const owner = () => Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
let sender = owner()
const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => Promise.resolve(handlers.get(channel)!({ sender }, ...args))
const PROTECTED = /is a protected location/
const CONFINED = /only looks through folders inside your home folder/
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
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herald-read-')))
  hermes = path.join(home, '.hermes')
  vi.stubEnv('HOME', home)
  vi.stubEnv('HERMES_HOME', '')

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
    // The Hermes home lists its files by name, `.env` included; reading one is what is refused.
    expect(await names(hermes)).toEqual(expect.arrayContaining(['.env', 'auth.json', 'memories']))
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
    const moved = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herald-hermes-')))
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
