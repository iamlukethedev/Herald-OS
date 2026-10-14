import { JSON_RPC_METHOD_NOT_FOUND, JsonRpcGatewayError } from '@herald-os/client'
import { describe, expect, it } from 'vitest'
import { attachedLine, attachmentFailure, ELSEWHERE_NOTE, fileName, uploadLimit } from './attachments.ts'

describe('a prompt’s files, as Hermes receives them', () => {
  it('names files Hermes reads by their paths, and uploaded ones by the copies it made', () => {
    expect(attachedLine(['/home/me/a.txt', '/home/me/b c.pdf'], false)).toBe('Attached: /home/me/a.txt, /home/me/b c.pdf')
    expect(attachedLine(['/srv/hermes/.hermes/attachments/b c.pdf'], true)).toBe('Attached (uploaded from my computer): /srv/hermes/.hermes/attachments/b c.pdf')
    expect(attachedLine([], true)).toBe('')
  })

  it('keeps an upload within the WebSocket frame of a Hermes older than desktop contract 5', () => {
    expect(uploadLimit(4)).toBe(11 * 1024 * 1024)
    expect(uploadLimit(undefined)).toBe(11 * 1024 * 1024)
    expect(uploadLimit(5)).toBe(Number.MAX_SAFE_INTEGER)
    expect(uploadLimit(8)).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('says which file did not go, and why, without Electron’s wording', () => {
    expect(fileName('C:\\Users\\me\\notes.md')).toBe('notes.md')
    expect(attachmentFailure('/home/me/big.iso', new Error("Error invoking remote method 'herald-os:fs:attachment': Error: it is 120 MB, and Hermes takes files up to 100 MB"))).toBe(
      'big.iso was not sent to Hermes: it is 120 MB, and Hermes takes files up to 100 MB'
    )
    expect(attachmentFailure('/home/me/a.txt', 'socket closed')).toBe('a.txt was not sent to Hermes: socket closed')
  })

  it('tells the person to update a Hermes that cannot take uploads', () => {
    expect(attachmentFailure('/home/me/a.txt', new JsonRpcGatewayError('method not found', { code: JSON_RPC_METHOD_NOT_FOUND }))).toBe(
      'a.txt was not sent: this Hermes cannot take files from another computer. Update it with `hermes update`.'
    )
  })

  it('tells Hermes the person’s places are not its own, and to ask for a file', () => {
    expect(ELSEWHERE_NOTE).toMatch(/do not search for them on yours/)
    expect(ELSEWHERE_NOTE).toMatch(/ask me to attach it/)
  })
})
