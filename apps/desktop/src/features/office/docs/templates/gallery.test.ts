import { describe, expect, it, vi } from 'vitest'
import type { DocJSON } from '../../../../../shared/office/document.ts'
import { isMac } from '../../../../lib/shortcuts.ts'
import type { OfficeSession } from '../../session.ts'
import { officeMenus, runShortcut } from '../../shell/commands.ts'
import { freshName, moveSelection, rowLength } from './gallery.ts'
import { documentFromTemplate } from './index.ts'
import { firstPageBlocks, thumbnailOf } from './thumbnail.ts'

describe('moving through the gallery', () => {
  // Thirteen built-in cards four to a row (rows 0-3, 4-7, 8-11, 12), then two of the person's own (13, 14).
  const sizes = [13, 2]

  it('goes along with left and right, across rows and sections, and stops at the ends', () => {
    expect(moveSelection(sizes, 4, 3, 'right')).toBe(4)
    expect(moveSelection(sizes, 4, 12, 'right')).toBe(13)
    expect(moveSelection(sizes, 4, 14, 'right')).toBe(14)
    expect(moveSelection(sizes, 4, 0, 'left')).toBe(0)
    expect(moveSelection(sizes, 4, 7, 'home')).toBe(0)
    expect(moveSelection(sizes, 4, 7, 'end')).toBe(14)
  })

  it('keeps the column going up and down, taking a shorter row’s last card, and moves between sections', () => {
    expect(moveSelection(sizes, 4, 1, 'down')).toBe(5)
    expect(moveSelection(sizes, 4, 9, 'down')).toBe(12)
    expect(moveSelection(sizes, 4, 12, 'down')).toBe(13)
    expect(moveSelection(sizes, 4, 11, 'down')).toBe(12)
    expect(moveSelection(sizes, 4, 14, 'up')).toBe(12)
    expect(moveSelection(sizes, 4, 12, 'up')).toBe(8)
    expect(moveSelection(sizes, 4, 2, 'up')).toBe(2)
    expect(moveSelection(sizes, 4, 14, 'down')).toBe(14)
  })

  it('copes with no cards, empty sections and odd column counts', () => {
    expect(moveSelection([], 4, 3, 'down')).toBe(0)
    expect(moveSelection([3, 0, 2], 5, 1, 'down')).toBe(4)
    expect(moveSelection([3], 0, 0, 'down')).toBe(1)
    expect(moveSelection([3], 4, 9, 'left')).toBe(1)
  })

  it('counts a row’s cards from their tops', () => {
    expect(rowLength([10, 10, 10, 10, 220, 220])).toBe(4)
    expect(rowLength([10])).toBe(1)
    expect(rowLength([])).toBe(1)
  })

  it('names a document after its template, numbered when that name is open', () => {
    expect(freshName('Letter', ['Untitled'])).toBe('Letter')
    expect(freshName('Letter', ['Letter', 'Letter 2'])).toBe('Letter 3')
  })
})

describe('template thumbnails', () => {
  const now = new Date(2026, 9, 9)

  it('show the first page: what comes before the first page break or new-page section', () => {
    const doc: DocJSON = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
        { type: 'sectionBreak', attrs: { kind: 'continuous', page: null } },
        { type: 'paragraph', content: [{ type: 'text', text: 'Two' }] },
        { type: 'sectionBreak', attrs: { kind: 'nextPage', page: null } },
        { type: 'paragraph', content: [{ type: 'text', text: 'Three' }] }
      ]
    }

    expect(firstPageBlocks(doc)).toHaveLength(3)
    expect(thumbnailOf({ ...doc, content: [doc.content[0], { type: 'pageBreak' }, doc.content[2]] }, '.t').body).toBe('<p>One</p>')
  })

  it('leave the head and foot of a report’s title page empty, and fill in fields as page 1 shows them', () => {
    const report = thumbnailOf(documentFromTemplate('report', { locale: 'en-GB' }), '.t', { now })
    const cv = thumbnailOf(documentFromTemplate('cv', { locale: 'en-GB' }), '.t', { now })
    const letter = thumbnailOf(documentFromTemplate('letter', { locale: 'en-GB' }), '.t', { now, locale: 'en-GB' })

    expect(report.header).toBeNull()
    expect(report.footer).toBeNull()
    expect(report.body).toContain('Report Title')
    expect(report.body).not.toContain('Summary')
    expect(cv.footer?.replace(/<[^>]+>/g, '')).toBe('Your Name · Page 1 of 1')
    expect(letter.header).toContain('Company Name')
    expect(letter.body).toContain('9 October 2026')
  })

  it('scope their styles to the element the page is drawn in', () => {
    const { css } = thumbnailOf(documentFromTemplate('newsletter', { locale: 'en-GB' }), '[data-thumb="newsletter"]')
    const rules = css.split('\n').filter((line) => line.includes('{'))

    expect(rules.every((rule) => rule.includes('[data-thumb="newsletter"]'))).toBe(true)
    expect(css).toContain('font-family: Georgia')
  })
})

describe('New with a gallery', () => {
  const press = { key: 'n', code: 'KeyN', metaKey: isMac, ctrlKey: !isMac, shiftKey: false, altKey: false } as KeyboardEvent

  it('runs the app’s own New for File > New instead of making a blank document', () => {
    const session = { active: () => null, create: vi.fn() }
    const onNew = vi.fn()
    const menus = officeMenus({ session: session as unknown as OfficeSession<unknown>, canSave: true, onNew })

    expect(runShortcut(press, menus)).toBe(true)
    expect(onNew).toHaveBeenCalledOnce()
    expect(session.create).not.toHaveBeenCalled()
  })
})
