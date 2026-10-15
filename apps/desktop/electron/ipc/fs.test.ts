import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, dialog: {}, ipcMain: {}, shell: {}, app: { getPath: () => '/tmp' } }))

const { SCRATCH_FILE } = await import('./fs.ts')

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
