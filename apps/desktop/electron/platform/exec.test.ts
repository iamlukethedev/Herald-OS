import { describe, expect, it } from 'vitest'
import { run } from './exec.ts'

describe('run', () => {
  it.skipIf(process.platform === 'win32')('writes input to stdin', async () => {
    expect(await run('cat', [], 5000, 'on stdin')).toEqual({ code: 0, stdout: 'on stdin', stderr: '' })
  })

  it('reports a missing binary as 127', async () => {
    expect((await run('herald-os-no-such-binary', [], 5000, 'x')).code).toBe(127)
  })
})
