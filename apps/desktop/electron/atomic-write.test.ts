import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ATOMIC_TMP_PREFIX, writeTextAtomic } from './atomic-write.ts'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-atomic-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

const onPlatform = (platform: NodeJS.Platform) => vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
const errno = (code: string) => Object.assign(new Error(code), { code })

const leftovers = (folder = dir) => fs.readdirSync(folder).filter(name => name.startsWith(ATOMIC_TMP_PREFIX))

describe('writeTextAtomic', () => {
  it('creates the file and its folder, and leaves no temporary behind', async () => {
    const file = path.join(dir, 'memories', 'MEMORY.md')
    await writeTextAtomic(file, 'first\n§\nsecond')

    expect(fs.readFileSync(file, 'utf8')).toBe('first\n§\nsecond')
    expect(leftovers(path.dirname(file))).toEqual([])
  })

  it('replaces the file rather than rewriting it in place, so an open reader keeps the old text', async () => {
    const file = path.join(dir, 'MEMORY.md')
    fs.writeFileSync(file, 'old text')
    const before = fs.statSync(file).ino
    const reader = fs.openSync(file, 'r')

    try {
      await writeTextAtomic(file, 'new text')

      expect(fs.statSync(file).ino).not.toBe(before)
      expect(fs.readFileSync(reader, 'utf8')).toBe('old text')
      expect(fs.readFileSync(file, 'utf8')).toBe('new text')
    } finally {
      fs.closeSync(reader)
    }
  })

  it("keeps an existing file's permission bits", async () => {
    const file = path.join(dir, 'USER.md')
    fs.writeFileSync(file, 'x')
    // Group-writable, which the usual 022 umask would strip from a newly created file.
    fs.chmodSync(file, 0o660)
    await writeTextAtomic(file, 'y')

    expect(fs.statSync(file).mode & 0o777).toBe(0o660)
  })

  it('writes through a symlink and keeps the link', async () => {
    const real = path.join(dir, 'dotfiles', 'MEMORY.md')
    fs.mkdirSync(path.dirname(real))
    fs.writeFileSync(real, 'old')
    const link = path.join(dir, 'MEMORY.md')
    fs.symlinkSync(real, link)
    await writeTextAtomic(link, 'new')

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(real, 'utf8')).toBe('new')
  })

  it('removes the temporary and leaves the target alone when the rename fails', async () => {
    const target = path.join(dir, 'MEMORY.md')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'keep'), 'k')

    await expect(writeTextAtomic(target, 'new')).rejects.toThrow()
    expect(leftovers()).toEqual([])
    expect(fs.readdirSync(target)).toEqual(['keep'])
  })

  it('creates a new file owner-only, whatever the umask', async () => {
    const file = path.join(dir, 'MEMORY.md')
    const umask = process.umask(0)

    try {
      await writeTextAtomic(file, 'x')
    } finally {
      process.umask(umask)
    }

    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('fsyncs the folder after the rename', async () => {
    const open = vi.spyOn(fsp, 'open')
    await writeTextAtomic(path.join(dir, 'MEMORY.md'), 'x')

    expect(open).toHaveBeenLastCalledWith(dir, 'r')
  })

  it('does not fsync the folder on Windows', async () => {
    onPlatform('win32')
    const open = vi.spyOn(fsp, 'open')
    await writeTextAtomic(path.join(dir, 'MEMORY.md'), 'x')

    expect(open.mock.calls.map(call => call[0])).not.toContain(dir)
  })

  it('on Windows, retries a rename refused while the file is open elsewhere', async () => {
    onPlatform('win32')
    const rename = fsp.rename
    const spy = vi
      .spyOn(fsp, 'rename')
      .mockRejectedValueOnce(errno('EPERM'))
      .mockRejectedValueOnce(errno('EBUSY'))
      .mockRejectedValueOnce(errno('EACCES'))
      .mockImplementation(rename)
    const file = path.join(dir, 'MEMORY.md')
    await writeTextAtomic(file, 'new')

    expect(spy).toHaveBeenCalledTimes(4)
    expect(fs.readFileSync(file, 'utf8')).toBe('new')
  })

  it('on Windows, gives up after a few tries, and elsewhere does not retry at all', async () => {
    const file = path.join(dir, 'MEMORY.md')
    onPlatform('win32')
    const spy = vi.spyOn(fsp, 'rename').mockRejectedValue(errno('EBUSY'))

    await expect(writeTextAtomic(file, 'new')).rejects.toThrow('EBUSY')
    expect(spy).toHaveBeenCalledTimes(6)

    onPlatform('linux')
    spy.mockClear()

    await expect(writeTextAtomic(file, 'new')).rejects.toThrow('EBUSY')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(leftovers()).toEqual([])
  })
})
