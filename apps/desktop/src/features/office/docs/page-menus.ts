import type { OfficeCommand } from '../shell/commands.ts'
import * as act from './actions.ts'

/** The menu items for the page: what Insert and Format offer for headers, footers, notes, breaks and page setup. */
export function pageMenuItems(): { insert: OfficeCommand[]; format: OfficeCommand[] } {
  const has = act.hasEditor
  const inText = act.inText

  return {
    insert: [
      { id: 'header', label: 'Header', enabled: has, dividerBefore: true, run: () => act.editPart('header') },
      { id: 'footer', label: 'Footer', enabled: has, run: () => act.editPart('footer') },
      {
        id: 'page-number',
        label: 'Page Number',
        enabled: has,
        run: () => {},
        submenu: [
          { id: 'field-page', label: 'Page Number', enabled: has, run: () => act.field('page') },
          { id: 'field-page-of', label: 'Page X of Y', enabled: has, run: () => act.field('pageOfPages') },
          { id: 'field-pages', label: 'Page Count', enabled: has, run: () => act.field('pages') },
          { id: 'field-date', label: 'Date', enabled: has, dividerBefore: true, run: () => act.field('date') },
          { id: 'field-time', label: 'Time', enabled: has, run: () => act.field('time') }
        ]
      },
      { id: 'footnote', label: 'Footnote', shortcut: 'mod+alt+f', enabled: inText, dividerBefore: true, run: () => act.note('footnote') },
      { id: 'endnote', label: 'Endnote', shortcut: 'mod+alt+e', enabled: inText, run: () => act.note('endnote') },
      {
        id: 'break',
        label: 'Break',
        enabled: inText,
        dividerBefore: true,
        run: () => {},
        submenu: [
          { id: 'break-page', label: 'Page Break', shortcut: 'mod+enter', enabled: inText, run: act.pageBreak },
          { id: 'break-next-page', label: 'Section Break (Next Page)', enabled: inText, dividerBefore: true, run: () => act.sectionBreak('nextPage') },
          { id: 'break-continuous', label: 'Section Break (Continuous)', enabled: inText, run: () => act.sectionBreak('continuous') },
          { id: 'break-odd-page', label: 'Section Break (Odd Page)', enabled: inText, run: () => act.sectionBreak('oddPage') },
          { id: 'break-even-page', label: 'Section Break (Even Page)', enabled: inText, run: () => act.sectionBreak('evenPage') }
        ]
      }
    ],
    format: [{ id: 'page-setup', label: 'Page Setup…', shortcut: 'mod+shift+p', enabled: has, dividerBefore: true, run: act.pageSetup }]
  }
}
