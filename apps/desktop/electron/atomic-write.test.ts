import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATOMIC_TMP_PREFIX, writeTextAtomic } from './atomic-write.ts'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-atomic-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

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
})
