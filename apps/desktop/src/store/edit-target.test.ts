// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./web-windows.ts', async () => {
  const { atom } = await import('nanostores')

  return { $webWindows: atom({}) }
})
vi.mock('./windows.ts', async () => {
  const { atom } = await import('nanostores')

  return { $focusedWindowId: atom(null), $windows: atom({}), focusWindow: vi.fn() }
})

const { performEdit, rememberFocusedEditable, setOwnPaste } = await import('./edit-target.ts')

const perform = vi.fn()
let field: HTMLTextAreaElement

beforeEach(() => {
  perform.mockReset().mockResolvedValue(undefined)
  Object.assign(window, { heraldOS: { edit: { perform } } })
  field = document.createElement('textarea')
  document.body.append(field)
  field.focus()
})

afterEach(() => {
  field.remove()
})

describe('a field with its own paste', () => {
  it('pastes by itself instead of taking the browser’s paste', async () => {
    const paste = vi.fn(async () => null)
    const off = setOwnPaste(field, paste)

    await performEdit({ kind: 'paste' }, { needsField: true })
    off()

    expect(paste).toHaveBeenCalledOnce()
    expect(perform).not.toHaveBeenCalled()
  })

  it('goes back to the browser’s paste once its registration is undone', async () => {
    setOwnPaste(field, async () => null)()

    await performEdit({ kind: 'paste' }, { needsField: true })

    expect(perform).toHaveBeenCalledExactlyOnceWith({ kind: 'paste' })
  })

  it('keeps a newer registration when an older one for the same field is undone', async () => {
    const older = vi.fn(async () => null)
    const newer = vi.fn(async () => null)
    const offOlder = setOwnPaste(field, older)
    const offNewer = setOwnPaste(field, newer)
    offOlder()

    await performEdit({ kind: 'paste' }, { needsField: true })
    offNewer()

    expect(newer).toHaveBeenCalledOnce()
    expect(older).not.toHaveBeenCalled()
    expect(perform).not.toHaveBeenCalled()
  })

  it('does not paste by itself while it cannot have the focus, as a hidden tab cannot', async () => {
    const paste = vi.fn(async () => null)
    const off = setOwnPaste(field, paste)
    rememberFocusedEditable()
    field.blur()
    vi.spyOn(field, 'focus').mockImplementation(() => {})

    await expect(performEdit({ kind: 'paste' }, { needsField: true })).rejects.toThrow('Nothing to type into')
    off()

    expect(paste).not.toHaveBeenCalled()
    expect(perform).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'copy' },
    { kind: 'cut' },
    { kind: 'selectAll' },
    { kind: 'undo' },
    { kind: 'insert', text: 'hello' },
    { kind: 'key', key: 'enter' }
  ] as const)('leaves $kind to the browser, pasting nothing', async action => {
    const paste = vi.fn(async () => null)
    const off = setOwnPaste(field, paste)

    await performEdit(action)
    off()

    expect(paste).not.toHaveBeenCalled()
    expect(perform).toHaveBeenCalledExactlyOnceWith(action)
  })

  it('reports why it did not paste', async () => {
    const off = setOwnPaste(field, async () => 'The clipboard has no text to paste.')

    await expect(performEdit({ kind: 'paste' }, { needsField: true })).rejects.toThrow('The clipboard has no text to paste.')
    off()
  })
})
