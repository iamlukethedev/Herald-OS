import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allowAttachments, readAttachment } from './attachments.ts'

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-attachments-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const write = (name: string, data: Buffer | string) => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, data)

  return file
}

const bytesOf = (dataUrl: string) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')

describe('attachments read for Hermes', () => {
  it('refuses a file nobody chose to attach', async () => {
    const file = write('secret.txt', 'not for Hermes')

    await expect(readAttachment(file)).rejects.toThrow('only uploads files you chose')
  })

  it('reads a chosen file whole, byte for byte', async () => {
    const data = crypto.randomBytes(64 * 1024)
    const file = write('report.pdf', data)
    allowAttachments([file])

    const attachment = await readAttachment(file)

    expect(attachment).toMatchObject({ name: 'report.pdf', size: data.length })
    expect(attachment.dataUrl.startsWith('data:application/octet-stream;base64,')).toBe(true)
    expect(crypto.createHash('sha256').update(bytesOf(attachment.dataUrl)).digest('hex')).toBe(crypto.createHash('sha256').update(data).digest('hex'))
  })

  it('knows a chosen file by its normalized path, and ignores relative ones', async () => {
    const file = write('notes.md', '# Notes')
    allowAttachments([path.join(dir, 'sub', '..', 'notes.md'), 'notes.md'])

    expect((await readAttachment(file)).name).toBe('notes.md')
    await expect(readAttachment('notes.md')).rejects.toThrow('only uploads files you chose')
  })

  it('refuses a folder, a missing file and a file over the limit', async () => {
    const big = write('big.bin', Buffer.alloc(3 * 1024 * 1024))
    const gone = path.join(dir, 'gone.txt')
    allowAttachments([dir, big, gone])

    await expect(readAttachment(dir)).rejects.toThrow('not a file')
    await expect(readAttachment(gone)).rejects.toThrow()
    await expect(readAttachment(big, 2 * 1024 * 1024)).rejects.toThrow('it is 3 MB, and Hermes takes files up to 2 MB')
    await expect(readAttachment(big, 2.9 * 1024 * 1024)).rejects.toThrow('it is 3 MB, and Hermes takes files up to 2.9 MB')
    expect((await readAttachment(big, 4 * 1024 * 1024)).size).toBe(3 * 1024 * 1024)
  })
})
