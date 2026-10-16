import type { WebContents } from 'electron'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, dialog: {}, ipcMain: {}, shell: {}, app: { getPath: () => '/tmp' } }))

const { SCRATCH_FILE, folderPlace, listTree, normalizeUserPath, watchTree } = await import('./fs.ts')

describe('scratch files a project listing hides', () => {
  it("hides Hermes's and Herald's atomic-save temporaries", () => {
    expect(SCRATCH_FILE.test('.mem_k2x9q1ab.tmp')).toBe(true)
    expect(SCRATCH_FILE.test('.hermes-tmp.config.yaml')).toBe(true)
    expect(SCRATCH_FILE.test('.herald-tmp.MEMORY.md.3f2a1b')).toBe(true)
  })

  it('keeps files that only look a little like them', () => {
    expect(SCRATCH_FILE.test('MEMORY.md')).toBe(false)
    expect(SCRATCH_FILE.test('MEMORY.md.lock')).toBe(false)
    expect(SCRATCH_FILE.test('mem_notes.tmp')).toBe(false)
    expect(SCRATCH_FILE.test('.mem_notes.md')).toBe(false)
  })
})

describe('where a project folder may sit', () => {
  it('accepts the home folder, with or without a trailing separator, and anything inside it', () => {
    expect(folderPlace('/Users/me', '/Users/me')).toBe('home')
    expect(folderPlace('/Users/me/', '/Users/me')).toBe('home')
    expect(folderPlace('/Users/me/foo', '/Users/me')).toBe('inside')
    expect(folderPlace('/Users/me/foo/bar', '/Users/me')).toBe('inside')
  })

  it('refuses the parent of the home folder and a sibling that only starts with its name', () => {
    expect(folderPlace('/Users', '/Users/me')).toBeNull()
    expect(folderPlace('/Users/me-other', '/Users/me')).toBeNull()
    expect(folderPlace('/Users/me-other/foo', '/Users/me')).toBeNull()
    expect(folderPlace('/etc', '/Users/me')).toBeNull()
  })

  it('keeps the temporary folders', () => {
    expect(folderPlace('/tmp/site', '/Users/me')).toBe('temporary')
    expect(folderPlace('/private/tmp/site', '/Users/me')).toBe('temporary')
  })
})

describe("the home folder in the Studio's tree", () => {
  let home: string

  const write = (file: string): void => {
    fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true })
    fs.writeFileSync(path.join(home, file), '')
  }
  const listed = async (target: string): Promise<string[]> => (await listTree(target, 1000)).entries.map(entry => path.relative(home, entry.path)).sort()
  const owner = () => Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents & EventEmitter

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-home-'))
    vi.stubEnv('HOME', home)

    for (const file of ['Desktop/secret.txt', 'Documents/contract.pdf', 'Library/Mail/inbox', '.ssh/id', '.zshrc', 'notes.md', 'Projects/app/src/deep/file.ts', 'Projects/app/.github/ci.yml', 'Projects/app/node_modules/dep/index.js']) {
      write(file)
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('names the home folder the same way however it is written', () => {
    expect(folderPlace(normalizeUserPath('~'), os.homedir())).toBe('home')
    expect(folderPlace(normalizeUserPath('~/'), os.homedir())).toBe('home')
    expect(folderPlace(normalizeUserPath('~/Projects/..'), os.homedir())).toBe('home')
    expect(folderPlace(normalizeUserPath('~/Projects'), os.homedir())).toBe('inside')
  })

  it('lists one level of the home folder, without Library and dot-entries, and never opens a folder in it', async () => {
    const top = ['Desktop', 'Documents', 'Projects', 'notes.md']

    expect(await listed(home)).toEqual(top)
    expect(await listed(home + path.sep)).toEqual(top)
  })

  it('still lists a project folder in full, dot-folders included, without its dependencies', async () => {
    expect(await listed(path.join(home, 'Projects'))).toEqual(['Projects/app', 'Projects/app/.github', 'Projects/app/.github/ci.yml', 'Projects/app/src', 'Projects/app/src/deep', 'Projects/app/src/deep/file.ts'])
  })

  it('refuses a folder outside the home folder', async () => {
    await expect(listTree('/etc', 10)).rejects.toThrow('project folders must be inside your home folder')
  })

  it('does not watch the home folder, and does watch a project inside it', async () => {
    expect(await watchTree(owner(), home)).toBeNull()
    expect(await watchTree(owner(), home + path.sep)).toBeNull()

    const contents = owner()

    expect(await watchTree(contents, path.join(home, 'Projects'))).toMatch(/^tree-\d+$/)
    contents.emit('destroyed')
  })
})
