import { pageOf, type PageSettings, pageSizeName } from '../../../../shared/office/document.ts'
import type { OfficeCommand } from '../shell/commands.ts'
import * as act from './actions.ts'
import { activeEditor } from './store.ts'

/** Whether the page of the document in front passes `test`, for the checks in Page Setup. */
const pageIs = (test: (page: PageSettings) => boolean) => () => {
  const editor = activeEditor()

  return Boolean(editor && test(pageOf({ type: 'doc', attrs: editor.state.doc.attrs })))
}

/** The menu items for the page: what Insert and Format offer for headers, footers, notes, breaks and page setup. */
export function pageMenuItems(): { insert: OfficeCommand[]; format: OfficeCommand[] } {
  const has = act.hasEditor

  return {
    insert: [],
    format: [
      {
        id: 'page',
        label: 'Page Setup',
        enabled: has,
        dividerBefore: true,
        run: () => {},
        submenu: [
          { id: 'page-a4', label: 'A4', enabled: has, checked: pageIs((page) => pageSizeName(page) === 'a4'), run: () => act.page({ size: 'a4' }) },
          { id: 'page-letter', label: 'Letter', enabled: has, checked: pageIs((page) => pageSizeName(page) === 'letter'), run: () => act.page({ size: 'letter' }) },
          { id: 'page-portrait', label: 'Portrait', enabled: has, dividerBefore: true, checked: pageIs((page) => page.width <= page.height), run: () => act.page({ orientation: 'portrait' }) },
          { id: 'page-landscape', label: 'Landscape', enabled: has, checked: pageIs((page) => page.width > page.height), run: () => act.page({ orientation: 'landscape' }) },
          { id: 'margins-normal', label: 'Normal Margins (2.54 cm)', enabled: has, dividerBefore: true, run: () => act.page({ margins: 72 }) },
          { id: 'margins-narrow', label: 'Narrow Margins (1.27 cm)', enabled: has, run: () => act.page({ margins: 36 }) },
          { id: 'margins-wide', label: 'Wide Margins (3.81 cm)', enabled: has, run: () => act.page({ margins: 108 }) }
        ]
      }
    ]
  }
}
