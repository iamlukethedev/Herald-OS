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
  shell: {},
  app: { getPath: () => '/tmp' }
}))

const { HOME_SECRETS, assertProjectFolder, assertReadable, assertWritable, readDir, readFile, registerFsIpc } = await import('./fs.ts')
const { registerCanvasIpc } = await import('../canvas/ipc.ts')
const { IPC } = await import('../../shared/ipc.ts')

registerFsIpc(() => null)
registerCanvasIpc(() => null)

const owner = () => Object.assign(new EventEmitter(), { isDestroyed: () => false, send: () => {} })
let sender = owner()
const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => Promise.resolve(handlers.get(channel)!({ sender }, ...args))
const PROTECTED = /is a protected location/
const OUTSIDE = /only reads files inside your home folder/

let home: string
let hermes: string

const write = (file: string, content = ''): string => {
  const full = path.join(home, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)

  return full
}
const names = async (dir: string): Promise<string[]> => (await readDir(dir)).map(entry => entry.name)

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herald-read-')))
  hermes = path.join(home, '.hermes')
  vi.stubEnv('HOME', home)
  vi.stubEnv('HERMES_HOME', '')

  write('.ssh/id_ed25519', 'PRIVATE KEY')
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
  const secrets = ['.ssh/id_ed25519', '.gnupg/private-keys-v1.d/key.key', '.aws/credentials', 'Library/Keychains/login.keychain-db', '.config/gh/hosts.yml', '.hermes/.env', '.hermes/auth.json', '.hermes/profiles/work/.env', '.hermes/profiles/work/.env.local']

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

  it('refuses writes into them too', () => {
    expect(() => assertWritable(`${home}/.aws/credentials`)).toThrow(PROTECTED)
    expect(() => assertWritable(`${hermes}/.env`)).toThrow(PROTECTED)
    expect(() => assertWritable(`${hermes}/memories/MEMORY.md`)).not.toThrow()
  })

  it('refuses system files and folders outside the home folder', async () => {
    await expect(readFile('/etc/passwd')).rejects.toThrow(OUTSIDE)
    await expect(readDir('/')).rejects.toThrow(OUTSIDE)
    await expect(readDir(path.dirname(home) === os.tmpdir() ? '/usr' : path.dirname(home))).rejects.toThrow(OUTSIDE)
  })
})

describe('symlinks and .. traversal', () => {
  it('refuses a symlink in the home folder that points at a secret', async () => {
    fs.symlinkSync(`${home}/.ssh/id_ed25519`, `${home}/innocent.txt`)
    fs.symlinkSync(`${hermes}/.env`, `${home}/settings.md`)
    fs.symlinkSync(`${home}/.ssh`, `${home}/keys`)

    await expect(readFile(`${home}/innocent.txt`)).rejects.toThrow(PROTECTED)
    await expect(readFile(`${home}/settings.md`)).rejects.toThrow(PROTECTED)
    await expect(readDir(`${home}/keys`)).rejects.toThrow(PROTECTED)
    await expect(readFile(`${home}/keys/id_ed25519`)).rejects.toThrow(PROTECTED)
  })

  it('refuses a symlink in the home folder that points outside it', async () => {
    fs.symlinkSync('/etc', `${home}/etc`)
    fs.symlinkSync('/etc/passwd', `${home}/passwd.txt`)

    await expect(readDir(`${home}/etc`)).rejects.toThrow(OUTSIDE)
    await expect(readFile(`${home}/passwd.txt`)).rejects.toThrow(OUTSIDE)
    await expect(readFile(`${home}/etc/hosts`)).rejects.toThrow(OUTSIDE)
  })

  it('reads through a symlink that stays inside, keeping the path as written', async () => {
    fs.symlinkSync(`${home}/Projects/site`, `${home}/site-link`)

    expect((await readDir(`${home}/site-link`)).map(entry => entry.path)).toEqual([`${home}/site-link/.env`, `${home}/site-link/index.html`])
    expect((await readFile(`${home}/site-link/index.html`)).content).toBe('<h1>hi</h1>')
  })

  it('refuses .. that climbs into a secret or out of the home folder', async () => {
    await expect(readFile(`${home}/Projects/../.ssh/id_ed25519`)).rejects.toThrow(PROTECTED)
    await expect(readFile('~/Downloads/../.hermes/.env')).rejects.toThrow(PROTECTED)
    await expect(readFile(`${home}/../../../../../../etc/passwd`)).rejects.toThrow(OUTSIDE)
    await expect(readDir(`${home}/Projects/../../../../../..`)).rejects.toThrow(OUTSIDE)
  })
})

describe('read-type IPC', () => {
  it('answers exists for readable places and looks missing for secrets and system files', async () => {
    expect(await invoke(IPC.canvasExists, `${hermes}/herald-os/office/slide-themes.json`)).toBe('file')
    expect(await invoke(IPC.canvasExists, `${home}/Projects`)).toBe('directory')
    expect(await invoke(IPC.canvasExists, `${home}/nothing.png`)).toBeNull()
    expect(await invoke(IPC.canvasExists, `${home}/.ssh/id_ed25519`)).toBeNull()
    expect(await invoke(IPC.canvasExists, `${hermes}/.env`)).toBeNull()
    expect(await invoke(IPC.canvasExists, '/etc/passwd')).toBeNull()

    fs.symlinkSync(`${home}/.aws/credentials`, `${home}/photo.png`)
    expect(await invoke(IPC.canvasExists, `${home}/photo.png`)).toBeNull()
  })

  it('refuses the read handlers on secrets', async () => {
    await expect(invoke(IPC.fsReadFile, `${hermes}/.env`)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsReadDir, `${home}/.ssh`)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsDirSize, `${home}/.gnupg`)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsThumbnail, `${home}/.ssh/id_ed25519`, 256)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsImageInfo, `${home}/.ssh/id_ed25519`)).rejects.toThrow(PROTECTED)
  })

  it('measures the Hermes home for Settings > Storage', async () => {
    expect(await invoke(IPC.fsDirSize, hermes)).toMatchObject({ files: 9, complete: true })
  })

  it('refuses a Canvas image that is a symlink to a secret', async () => {
    fs.symlinkSync(`${home}/.aws/credentials`, `${home}/photo.png`)

    await expect(invoke(IPC.canvasReadImage, `${home}/photo.png`)).rejects.toThrow(PROTECTED)
  })
})

describe('project folders for the Studio tree and its watcher', () => {
  const listed = async (root: string): Promise<string[]> => ((await invoke(IPC.fsListTree, root, 100)) as { entries: Array<{ path: string }> }).entries.map(entry => entry.path).sort()

  it('lists and watches a project inside the home folder, with or without a trailing separator', async () => {
    const files = [`${home}/Projects/site/.env`, `${home}/Projects/site/index.html`]

    expect(await listed(`${home}/Projects/site`)).toEqual(files)
    expect(await listed(`${home}/Projects/site/`)).toEqual(files)
    expect(await listed(`${home}/Projects/site//`)).toEqual(files)
    expect(await invoke(IPC.fsWatchTree, `${home}/Projects/site/`)).toMatch(/^tree-\d+$/)
  })

  it('refuses a symlink in the home folder that leads to /etc', async () => {
    fs.symlinkSync('/etc', `${home}/etc`)
    fs.symlinkSync('/', `${home}/root`)

    await expect(invoke(IPC.fsListTree, `${home}/etc`, 100)).rejects.toThrow(OUTSIDE)
    await expect(invoke(IPC.fsListTree, `${home}/etc/`, 100)).rejects.toThrow(OUTSIDE)
    await expect(invoke(IPC.fsWatchTree, `${home}/etc`)).rejects.toThrow(OUTSIDE)
    await expect(invoke(IPC.fsListTree, `${home}/root`, 100)).rejects.toThrow(OUTSIDE)
  })

  it('refuses a symlink in the home folder that leads to a credential store', async () => {
    fs.symlinkSync(`${home}/.ssh`, `${home}/Projects/keys`)

    await expect(invoke(IPC.fsListTree, `${home}/Projects/keys`, 100)).rejects.toThrow(PROTECTED)
    await expect(invoke(IPC.fsListTree, `${home}/.aws`, 100)).rejects.toThrow(PROTECTED)
  })

  it('refuses the temporary folders and the root themselves, however they are written', async () => {
    for (const root of ['/tmp', '/tmp/', '/tmp//', '/private/tmp/', `${os.tmpdir()}/`, '/tmp/../tmp', '/', '//']) {
      await expect(invoke(IPC.fsListTree, root, 100)).rejects.toThrow(/system folder|only reads files inside/)
      await expect(invoke(IPC.fsWatchTree, root)).rejects.toThrow(/system folder|only reads files inside/)
    }
  })

  it('refuses the Hermes home as a project, and a symlink to /tmp', async () => {
    fs.symlinkSync('/tmp', `${home}/scratch`)

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
    await expect(invoke(IPC.fsListTree, `${home}/Projects/../../../../../../etc`, 100)).rejects.toThrow(OUTSIDE)
  })
})
