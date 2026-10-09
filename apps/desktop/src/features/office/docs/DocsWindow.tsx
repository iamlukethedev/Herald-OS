import './docs.css'
import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type CalloutKind, pageOf, type PageSettings, pageSizeName } from '../../../../shared/office/document.ts'
import { officeAppFor, openFormats } from '../../../../shared/office/files.ts'
import { messageOf } from '../../canvas/errors.ts'
import { officeAbilities } from '../session.ts'
import { type OfficeCommand, type OfficeMenu, officeMenus } from '../shell/commands.ts'
import { OfficeWindow } from '../shell/OfficeWindow.tsx'
import * as act from './actions.ts'
import { CALLOUT_LABELS, LINE_SPACINGS } from './choices.ts'
import { DocsEditor, dragPoint } from './DocsEditor.tsx'
import { mimeOfName } from './editor.ts'
import { BLOCK_STYLES, styleAt } from './model.ts'
import { $pickImage } from './slash.ts'
import { activeEditor, docsSession } from './store.ts'
import { TABLE_ACTIONS } from './table-menu.ts'
import { $templateGallery, openTemplateGallery, TemplateGallery } from './TemplateGallery.tsx'
import { DocsToolbar } from './Toolbar.tsx'

const STYLE_SHORTCUTS: Record<string, string> = { normal: 'mod+alt+0', heading1: 'mod+alt+1', heading2: 'mod+alt+2', heading3: 'mod+alt+3' }

/** Whether the page of the document in front passes `test`, for the checks in Page Setup. */
const pageIs = (test: (page: PageSettings) => boolean) => () => {
  const editor = activeEditor()

  return Boolean(editor && test(pageOf({ type: 'doc', attrs: editor.state.doc.attrs })))
}

function docsMenus(): OfficeMenu[] {
  const has = act.hasEditor
  const mark = (id: act.MarkName, label: string, shortcut: string): OfficeCommand => ({ id, label, shortcut, enabled: has, checked: () => act.isActive(id), run: () => act.toggleMark(id) })

  const insert: OfficeCommand[] = [
    { id: 'link', label: 'Link…', shortcut: 'mod+k', enabled: has, run: act.editLink },
    { id: 'picture', label: 'Picture…', enabled: has, run: () => $pickImage.set($pickImage.get() + 1) },
    { id: 'insert-table', label: 'Table', enabled: has, run: () => act.table(3, 3) },
    { id: 'rule', label: 'Divider', enabled: has, run: act.rule, dividerBefore: true },
    { id: 'page-break', label: 'Page Break', shortcut: 'mod+enter', enabled: has, run: act.pageBreak },
    { id: 'panel', label: 'Panel', enabled: has, run: () => act.callout('info'), submenu: (Object.entries(CALLOUT_LABELS) as [CalloutKind, string][]).map(([kind, label]) => ({ id: `panel-${kind}`, label, enabled: has, run: () => act.callout(kind) })) },
    { id: 'code-block', label: 'Code Block', shortcut: 'mod+alt+c', enabled: has, run: () => act.style('code'), dividerBefore: true },
    { id: 'quote', label: 'Quote', shortcut: 'mod+shift+b', enabled: has, run: () => act.style('quote') }
  ]

  const format: OfficeCommand[] = [
    mark('bold', 'Bold', 'mod+b'),
    mark('italic', 'Italic', 'mod+i'),
    mark('underline', 'Underline', 'mod+u'),
    mark('strike', 'Strikethrough', 'mod+shift+x'),
    mark('superscript', 'Superscript', 'mod+.'),
    mark('subscript', 'Subscript', 'mod+,'),
    mark('code', 'Code', 'mod+shift+m'),
    { id: 'clear', label: 'Clear Formatting', shortcut: 'mod+\\', enabled: has, run: act.clear },
    {
      id: 'style',
      label: 'Paragraph Style',
      enabled: has,
      dividerBefore: true,
      run: () => {},
      submenu: BLOCK_STYLES.map((entry) => ({ id: `style-${entry.id}`, label: entry.label, shortcut: STYLE_SHORTCUTS[entry.id], enabled: has, checked: () => Boolean(activeEditor() && styleAt(activeEditor()!.state) === entry.id), run: () => act.style(entry.id) }))
    },
    {
      id: 'align',
      label: 'Align',
      enabled: has,
      run: () => {},
      submenu: [
        { id: 'align-left', label: 'Left', shortcut: 'mod+l', enabled: has, run: () => act.align('left') },
        { id: 'align-center', label: 'Centre', shortcut: 'mod+e', enabled: has, run: () => act.align('center') },
        { id: 'align-right', label: 'Right', shortcut: 'mod+r', enabled: has, run: () => act.align('right') },
        { id: 'align-justify', label: 'Justify', shortcut: 'mod+j', enabled: has, run: () => act.align('justify') }
      ]
    },
    { id: 'spacing', label: 'Line Spacing', enabled: has, run: () => {}, submenu: LINE_SPACINGS.map((entry) => ({ id: `spacing-${entry.value}`, label: entry.label, enabled: has, run: () => act.lineSpacing(entry.value) })) },
    {
      id: 'lists',
      label: 'Lists',
      enabled: has,
      run: () => {},
      submenu: [
        { id: 'list-bullet', label: 'Bulleted List', shortcut: 'mod+shift+8', enabled: has, checked: () => act.isActive('bulletList'), run: () => act.list('bullet') },
        { id: 'list-ordered', label: 'Numbered List', shortcut: 'mod+shift+7', enabled: has, checked: () => act.isActive('orderedList'), run: () => act.list('ordered') },
        { id: 'list-task', label: 'Checklist', shortcut: 'mod+shift+9', enabled: has, checked: () => act.isActive('taskList'), run: () => act.list('task') }
      ]
    },
    { id: 'indent', label: 'Increase Indent', shortcut: 'mod+]', enabled: has, run: () => act.shiftIndent(1) },
    { id: 'outdent', label: 'Decrease Indent', shortcut: 'mod+[', enabled: has, run: () => act.shiftIndent(-1) },
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

  const table: OfficeCommand[] = [
    { id: 'table-new', label: 'Insert Table', enabled: has, run: () => act.table(3, 3) },
    ...TABLE_ACTIONS.map((action, index) => ({
      id: `table-${action.id}`,
      label: action.label,
      dividerBefore: index === 0 || action.dividerBefore,
      enabled: () => Boolean(activeEditor() && action.enabled(activeEditor()!)),
      checked: action.checked && (() => Boolean(activeEditor() && action.checked!(activeEditor()!))),
      run: () => {
        const editor = activeEditor()

        if (editor) {
          action.run(editor)
        }
      }
    }))
  ]

  const key = () => docsSession.$activeKey.get()
  const view: OfficeCommand[] = [
    { id: 'zoom-in', label: 'Zoom In', shortcut: 'mod+=', enabled: has, run: () => key() && act.zoom(key()!, 'in') },
    { id: 'zoom-out', label: 'Zoom Out', shortcut: 'mod+-', enabled: has, run: () => key() && act.zoom(key()!, 'out') },
    { id: 'zoom-reset', label: 'Actual Size', shortcut: 'mod+0', enabled: has, run: () => key() && act.zoom(key()!, 'reset') }
  ]

  return officeMenus({
    session: docsSession,
    canSave: true,
    onNew: openTemplateGallery,
    edit: [
      { id: 'find', label: 'Find…', shortcut: 'mod+f', enabled: has, run: () => act.openFind(false), dividerBefore: true },
      { id: 'replace', label: 'Replace…', shortcut: 'mod+shift+h', enabled: has, run: () => act.openFind(true) }
    ],
    menus: [
      { id: 'insert', label: 'Insert', items: insert },
      { id: 'format', label: 'Format', items: format },
      { id: 'table', label: 'Table', items: table },
      { id: 'view', label: 'View', items: view }
    ]
  })
}

/** Herald Docs: Word documents, Markdown and plain text on real pages, in a Herald window. */
export function DocsWindow({ payload }: { payload?: Record<string, unknown> }) {
  const [canOpen, setCanOpen] = useState(true)
  const gallery = useStore($templateGallery)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void officeAbilities().then((abilities) => setCanOpen(openFormats('docs', abilities).length > 0))
  }, [])

  // The '/' menu and Insert > Picture ask for a file.
  useEffect(() => $pickImage.listen(() => picker.current?.click()), [])

  const menus = useMemo(docsMenus, [])

  const onDropFile = (file: string) => {
    if (mimeOfName(file)) {
      void act.pictureFromPath(file, dragPoint.key === docsSession.$activeKey.get() ? dragPoint : undefined)

      return
    }

    void officeAbilities().then((abilities) => {
      if (officeAppFor(file, abilities) === 'docs') {
        docsSession.open(file).catch((error: unknown) => docsSession.notify(`Could not open ${file.split('/').pop()}: ${messageOf(error)}`, 'error'))
      } else {
        docsSession.notify(`Herald Docs does not open ${file.split('/').pop()}`, 'error')
      }
    })
  }

  return (
    <>
      <OfficeWindow
        session={docsSession}
        menus={menus}
        payload={payload}
        noun="document"
        canOpen={canOpen}
        onDropFile={onDropFile}
        onNew={openTemplateGallery}
        start={{ icon: 'docs', blurb: 'Write on real pages with styles, lists, tables and pictures. Word documents, Markdown and plain text open and save.', newLabel: 'New document', hint: 'Or drop a Word, Markdown or text file here.' }}
        toolbar={(doc) => <DocsToolbar key={doc.key} docKey={doc.key} />}
        renderEditor={(doc, active) => <DocsEditor doc={doc} active={active} />}
      />
      <input
        ref={picker}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml"
        multiple
        hidden
        onChange={(event) => {
          void act.picturesFromFiles([...(event.target.files ?? [])])
          event.target.value = ''
        }}
      />
      {gallery && <TemplateGallery />}
    </>
  )
}
