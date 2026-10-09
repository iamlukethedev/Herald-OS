import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reviewMenuItems } from '../docs/review-menus.ts'
import { $reviewProvider } from '../docs/review-provider.ts'
import { hermesReview, offerHermesReview } from './docs-review.ts'

const hermes = vi.hoisted(() => ({ state: 'ready', working: new Set<string>(), askHermes: vi.fn(async (_request: unknown) => true) }))
const docs = vi.hoisted(() => ({ text: 'Our results was better then expected.', notify: vi.fn() }))

vi.mock('./ask.ts', () => ({
  $hermesState: { get: () => hermes.state },
  askOf: (docKey: string) => ({ phase: hermes.working.has(docKey) ? 'working' : 'idle' }),
  askHermes: hermes.askHermes,
  draftAsk: vi.fn()
}))

vi.mock('../agent.ts', () => ({ openEntries: async () => [] }))

vi.mock('../docs/actions.ts', () => ({ hasEditor: () => true, apply: vi.fn() }))

vi.mock('../docs/store.ts', async () => {
  const { atom } = await import('nanostores')
  const editor = {
    state: {
      doc: {
        get textContent() {
          return docs.text
        }
      }
    }
  }

  return {
    docsSession: { $activeKey: atom<string | null>('report'), notify: docs.notify },
    editorOf: (key: string | null) => (key === 'report' ? editor : null),
    activeEditor: () => editor,
    $pages: atom({})
  }
})

const REVIEW_REQUEST = { app: 'docs', docKey: 'report', words: 'Review for clarity, grammar and tone', action: { id: 'review' } }

beforeEach(() => {
  hermes.state = 'ready'
  hermes.working.clear()
  docs.text = 'Our results was better then expected.'
  vi.clearAllMocks()
  $reviewProvider.set(null)
})

describe('Review with Hermes', () => {
  it('is offered while Herald Docs shows, and taken away after', () => {
    const stop = offerHermesReview()

    expect($reviewProvider.get()).toBe(hermesReview)
    expect($reviewProvider.get()?.label).toBe('Review with Hermes')

    stop()

    expect($reviewProvider.get()).toBeNull()
  })

  it('leaves another review in place when it is taken away', () => {
    const stop = offerHermesReview()
    const other = { label: 'Another review', run: () => {} }
    $reviewProvider.set(other)
    stop()

    expect($reviewProvider.get()).toBe(other)
  })

  it('asks Hermes for a review of the document, through its Ask Hermes bar', async () => {
    await hermesReview.run('report')

    expect(hermes.askHermes).toHaveBeenCalledOnce()
    expect(hermes.askHermes).toHaveBeenCalledWith(REVIEW_REQUEST)
  })

  it('waits, as the inline actions do, while Hermes is offline or already working on the document', async () => {
    hermes.state = 'offline'

    expect(hermesReview.enabled?.('report')).toBe(false)

    await hermesReview.run('report')
    hermes.state = 'ready'
    hermes.working.add('report')

    expect(hermesReview.enabled?.('report')).toBe(false)

    await hermesReview.run('report')

    expect(hermes.askHermes).not.toHaveBeenCalled()
    expect(hermesReview.enabled?.('notes')).toBe(true)
  })

  it('says there is nothing to review in an empty document, without asking Hermes', async () => {
    docs.text = ' \n '
    await hermesReview.run('report')

    expect(docs.notify).toHaveBeenCalledWith('There is nothing to review in this document yet')
    expect(hermes.askHermes).not.toHaveBeenCalled()
  })
})

describe('the Review menu', () => {
  it('ends with Review with Hermes while it is offered, which reviews the document in front', async () => {
    const { menu } = reviewMenuItems()

    expect(menu?.items.map((item) => item.id)).not.toContain('review-ai')

    const stop = offerHermesReview()
    const item = menu!.items.at(-1)!

    expect(item).toMatchObject({ id: 'review-ai', label: 'Review with Hermes', dividerBefore: true })
    expect(item.shortcut).toBeUndefined()
    expect(item.enabled?.()).toBe(true)

    hermes.working.add('report')

    expect(item.enabled?.()).toBe(false)

    hermes.working.clear()
    item.run()
    await vi.waitFor(() => expect(hermes.askHermes).toHaveBeenCalledWith(REVIEW_REQUEST))
    stop()

    expect(menu!.items.map((item) => item.id)).not.toContain('review-ai')
  })

  it('enables a review that does not say when it can run whenever a document is in front', () => {
    $reviewProvider.set({ label: 'Another review', run: () => {} })
    const item = reviewMenuItems().menu!.items.at(-1)!

    expect(item.label).toBe('Another review')
    expect(item.enabled?.()).toBe(true)
  })
})
