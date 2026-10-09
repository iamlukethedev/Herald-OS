import { describe, expect, it } from 'vitest'
import { describeOffice } from '../features/office/agent-model.ts'
import { describeScreen, withScreenContext } from './screen-context.ts'

describe('describeScreen', () => {
  it('names the folder and the selected file while Files is the page in view', () => {
    expect(describeScreen({ page: 'files', files: { folder: '/Users/sam/Downloads', view: 'folder', selected: '/Users/sam/Downloads/scan0001.pdf' }, viewerFile: null })).toBe(
      'Screen: the Files page shows the folder /Users/sam/Downloads, with /Users/sam/Downloads/scan0001.pdf selected.'
    )
    expect(describeScreen({ page: 'files', files: { folder: null, view: 'recent', selected: null }, viewerFile: null })).toBe('Screen: the Files page shows recent files.')
  })

  it('leaves Files out on other pages and names the document in front', () => {
    expect(describeScreen({ page: 'overview', files: { folder: '/Users/sam/Downloads', view: 'folder', selected: null }, viewerFile: null })).toBeNull()
    expect(describeScreen({ page: 'hermes', files: null, viewerFile: '/Users/sam/Downloads/IMG_2231.pdf' })).toBe('Screen: the viewer in front shows the file /Users/sam/Downloads/IMG_2231.pdf.')
  })

  it('goes after the spoken exchange, never into the words themselves', () => {
    expect(withScreenContext('User: file these\nHermes: Which folder?', 'Screen: x.')).toBe('User: file these\nHermes: Which folder?\nScreen: x.')
    expect(withScreenContext(undefined, 'Screen: x.')).toBe('Screen: x.')
    expect(withScreenContext(undefined, null)).toBeUndefined()
  })

  it('carries what Herald Office has open between the exchange and the screen line', () => {
    const office = 'Office: in front is Budget.xlsx in Herald Sheets (~/Budget.xlsx), selection Sheet1!B2:D9; also open: Report.docx (Herald Docs).'

    expect(withScreenContext('User: add a total row', 'Screen: the Files page shows recent files.', office)).toBe(`User: add a total row\n${office}\nScreen: the Files page shows recent files.`)
    expect(withScreenContext(undefined, null, office)).toBe(office)
    expect(withScreenContext('User: make it bold', null, `  ${office}\n`)).toBe(`User: make it bold\n${office}`)
    expect(withScreenContext(undefined, null, null)).toBeUndefined()
  })

  it('names the deck in front and its slide', () => {
    const office = describeOffice(
      [
        { app: 'slides', key: 's1', name: 'Pitch', path: '/Users/sam/Pitch.pptx', format: '.pptx', modified: true, active: true, front: true, selection: 'Slide 3: “Pricing”, text box “Starter plan” selected' },
        { app: 'docs', key: 'd1', name: 'Report', path: null, format: '.docx', modified: false, active: true, front: false }
      ],
      '/Users/sam'
    )

    expect(withScreenContext('User: make this slide a comparison', null, office)).toBe(
      'User: make this slide a comparison\nOffice: in front is Pitch in Herald Slides (~/Pitch.pptx, unsaved edits), selection Slide 3: “Pricing”, text box “Starter plan” selected; also open: Report (Herald Docs).'
    )
  })
})
