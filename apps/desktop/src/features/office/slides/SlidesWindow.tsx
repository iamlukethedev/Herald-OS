import { useEffect, useMemo, useState } from 'react'
import { openFormats } from '../../../../shared/office/files.ts'
import { messageOf } from '../../canvas/errors.ts'
import { officeAbilities } from '../session.ts'
import type { OfficeCommand } from '../shell/commands.ts'
import { officeMenus } from '../shell/commands.ts'
import { OfficeWindow } from '../shell/OfficeWindow.tsx'
import type { OfficeDocument } from '../types.ts'
import { type Deck, LAYOUTS, SLIDE_SIZES, TRANSITIONS } from './deck.ts'
import { $textSession } from './editor/active.ts'
import * as commands from './editor/commands.ts'
import { Toolbar } from './editor/Toolbar.tsx'
import { LAYOUT_NAMES } from './layouts.ts'
import { ALIGN_LABELS, type AlignEdge, ARRANGE_LABELS } from './model.ts'
import { Present } from './Present.tsx'
import { INSERTABLE, SHAPE_NAMES } from './shapes.ts'
import { SlideEditor } from './SlideEditor.tsx'
import { decks, slidesSession } from './store.ts'
import { THEMES } from './themes.ts'

const hasDeck = () => Boolean(commands.live())
const hasSelection = () => Boolean(commands.live()?.selected.length)
const notTyping = () => !$textSession.get()
const canEditSelection = () => hasSelection() && notTyping()
const canFormat = () => commands.canFormatText()
const TRANSITION_NAMES = { none: 'None', fade: 'Fade', push: 'Push', wipe: 'Wipe', cover: 'Cover', uncover: 'Uncover', split: 'Split', zoom: 'Zoom' } as const

function slideCommands(): OfficeCommand[] {
  return [
    { id: 'new-slide', label: 'New Slide', shortcut: 'mod+shift+n', enabled: hasDeck, run: () => commands.newSlide() },
    { id: 'new-slide-layout', label: 'New Slide with Layout', enabled: hasDeck, run: () => {}, submenu: LAYOUTS.map((layout) => ({ id: `new-${layout}`, label: LAYOUT_NAMES[layout], run: () => commands.newSlide(layout) })) },
    { id: 'duplicate-slide', label: 'Duplicate Slide', enabled: hasDeck, run: commands.duplicateSlides },
    { id: 'delete-slide', label: 'Delete Slide', enabled: hasDeck, run: commands.deleteSlides },
    { id: 'hide-slide', label: 'Hide or Show Slide', enabled: hasDeck, run: commands.toggleHidden },
    { id: 'slide-up', label: 'Move Slide Up', enabled: hasDeck, run: () => commands.moveSlidesBy(-1), dividerBefore: true },
    { id: 'slide-down', label: 'Move Slide Down', enabled: hasDeck, run: () => commands.moveSlidesBy(1) },
    {
      id: 'layout',
      label: 'Layout',
      enabled: hasDeck,
      run: () => {},
      dividerBefore: true,
      submenu: LAYOUTS.map((layout) => ({ id: `layout-${layout}`, label: LAYOUT_NAMES[layout], checked: () => commands.live()?.slide.layout === layout, run: () => commands.setLayout(layout) }))
    },
    { id: 'theme', label: 'Theme', enabled: hasDeck, run: () => {}, submenu: THEMES.map((theme) => ({ id: `theme-${theme.id}`, label: theme.name, checked: () => commands.live()?.deck.theme.id === theme.id, run: () => commands.applyTheme(theme) })) },
    { id: 'transition', label: 'Transition', enabled: hasDeck, run: () => {}, submenu: TRANSITIONS.map((transition) => ({ id: `transition-${transition}`, label: TRANSITION_NAMES[transition], checked: () => commands.live()?.deck.transition === transition, run: () => commands.setTransition(transition) })) },
    {
      id: 'size',
      label: 'Slide Size',
      enabled: hasDeck,
      run: () => {},
      submenu: [
        { id: 'size-wide', label: 'Widescreen (16:9)', checked: () => commands.live()?.deck.size.width === SLIDE_SIZES.wide.width, run: () => commands.setSlideSize(SLIDE_SIZES.wide) },
        { id: 'size-standard', label: 'Standard (4:3)', checked: () => commands.live()?.deck.size.width === SLIDE_SIZES.standard.width, run: () => commands.setSlideSize(SLIDE_SIZES.standard) }
      ]
    },
    { id: 'background-theme', label: 'Theme Background', enabled: hasDeck, run: () => commands.setBackground(null) },
    { id: 'present', label: 'Present', shortcut: 'mod+shift+enter', enabled: hasDeck, run: () => commands.present(false), dividerBefore: true },
    { id: 'present-start', label: 'Present from the Start', shortcut: 'mod+alt+enter', enabled: hasDeck, run: () => commands.present(true) }
  ]
}

/** Rows and columns of the tables the Insert menu offers; the toolbar's grid picks any size up to 8 by 10. */
const TABLE_SIZES = [
  [2, 2],
  [3, 2],
  [3, 3],
  [4, 3],
  [4, 4],
  [5, 4],
  [6, 5]
] as const

function insertCommands(): OfficeCommand[] {
  return [
    { id: 'insert-text', label: 'Text Box', enabled: hasDeck, run: commands.insertText },
    { id: 'insert-shape', label: 'Shape', enabled: hasDeck, run: () => {}, submenu: INSERTABLE.map((kind) => ({ id: `shape-${kind}`, label: SHAPE_NAMES[kind], run: () => commands.insertShape(kind) })) },
    { id: 'insert-line', label: 'Line', enabled: hasDeck, run: () => commands.insertLine('none') },
    { id: 'insert-arrow', label: 'Arrow', enabled: hasDeck, run: () => commands.insertLine('triangle') },
    { id: 'insert-picture', label: 'Picture…', enabled: hasDeck, run: () => commands.pickPictures() },
    {
      id: 'insert-table',
      label: 'Table',
      enabled: hasDeck,
      run: () => {},
      submenu: TABLE_SIZES.map(([rows, columns]) => ({ id: `table-${rows}-${columns}`, label: `${rows} rows, ${columns} columns`, run: () => commands.insertTable(rows, columns) }))
    }
  ]
}

const hasTable = () => {
  const doc = commands.live()

  return Boolean(doc && doc.selected.length === 1 && doc.selection[0]?.kind === 'table')
}

function tableCommands(): OfficeCommand[] {
  return [
    { id: 'table-row-above', label: 'Insert Row Above', enabled: hasTable, run: () => commands.insertRow('above') },
    { id: 'table-row-below', label: 'Insert Row Below', enabled: hasTable, run: () => commands.insertRow('below') },
    { id: 'table-column-left', label: 'Insert Column Left', enabled: hasTable, run: () => commands.insertColumn('left') },
    { id: 'table-column-right', label: 'Insert Column Right', enabled: hasTable, run: () => commands.insertColumn('right') },
    { id: 'table-delete-row', label: 'Delete Row', enabled: () => commands.hasTableCell(), run: () => commands.deleteRows(), dividerBefore: true },
    { id: 'table-delete-column', label: 'Delete Column', enabled: () => commands.hasTableCell(), run: () => commands.deleteColumns() }
  ]
}

function formatCommands(): OfficeCommand[] {
  const align = (value: 'left' | 'center' | 'right' | 'justify', label: string, shortcut: string): OfficeCommand => ({ id: `align-${value}`, label, shortcut, enabled: canFormat, run: () => commands.setAlign(value) })

  return [
    { id: 'bold', label: 'Bold', shortcut: 'mod+b', enabled: canFormat, run: () => commands.toggleSwitch('bold') },
    { id: 'italic', label: 'Italic', shortcut: 'mod+i', enabled: canFormat, run: () => commands.toggleSwitch('italic') },
    { id: 'underline', label: 'Underline', shortcut: 'mod+u', enabled: canFormat, run: () => commands.toggleSwitch('underline') },
    { id: 'strike', label: 'Strikethrough', shortcut: 'mod+shift+x', enabled: canFormat, run: () => commands.toggleSwitch('strike') },
    { id: 'bigger', label: 'Bigger', shortcut: 'mod+shift+>', enabled: canFormat, run: () => commands.stepSize(1), dividerBefore: true },
    { id: 'smaller', label: 'Smaller', shortcut: 'mod+shift+<', enabled: canFormat, run: () => commands.stepSize(-1) },
    align('left', 'Align Left', 'mod+shift+l'),
    { ...align('center', 'Centre', 'mod+shift+e'), dividerBefore: false },
    align('right', 'Align Right', 'mod+shift+r'),
    align('justify', 'Justify', 'mod+shift+j'),
    { id: 'bullets', label: 'Bullets', shortcut: 'mod+shift+8', enabled: canFormat, run: () => commands.toggleListKind('bullet'), dividerBefore: true },
    { id: 'numbering', label: 'Numbering', shortcut: 'mod+shift+7', enabled: canFormat, run: () => commands.toggleListKind('number') },
    { id: 'level-up', label: 'Increase List Level', enabled: canFormat, run: () => commands.shiftLevels(1) },
    { id: 'level-down', label: 'Decrease List Level', enabled: canFormat, run: () => commands.shiftLevels(-1) },
    {
      id: 'anchor',
      label: 'Text Position',
      enabled: canFormat,
      run: () => {},
      dividerBefore: true,
      submenu: (['top', 'middle', 'bottom'] as const).map((anchor) => ({ id: `anchor-${anchor}`, label: anchor === 'top' ? 'Top' : anchor === 'middle' ? 'Middle' : 'Bottom', run: () => commands.setAnchor(anchor) }))
    },
    {
      id: 'autofit',
      label: 'Autofit',
      enabled: canFormat,
      run: () => {},
      submenu: [
        { id: 'fit-none', label: 'Do Not Autofit', run: () => commands.setAutoFit('none') },
        { id: 'fit-shrink', label: 'Shrink Text on Overflow', run: () => commands.setAutoFit('shrink') },
        { id: 'fit-grow', label: 'Resize Box to Fit Text', run: () => commands.setAutoFit('grow') }
      ]
    }
  ]
}

function arrangeCommands(): OfficeCommand[] {
  const edges: AlignEdge[] = ['left', 'center', 'right', 'top', 'middle', 'bottom']

  return [
    { id: 'front', label: ARRANGE_LABELS.front, shortcut: 'mod+shift+]', enabled: canEditSelection, run: () => commands.arrange('front') },
    { id: 'forward', label: ARRANGE_LABELS.forward, shortcut: 'mod+]', enabled: canEditSelection, run: () => commands.arrange('forward') },
    { id: 'backward', label: ARRANGE_LABELS.backward, shortcut: 'mod+[', enabled: canEditSelection, run: () => commands.arrange('backward') },
    { id: 'back', label: ARRANGE_LABELS.back, shortcut: 'mod+shift+[', enabled: canEditSelection, run: () => commands.arrange('back') },
    { id: 'align', label: 'Align', enabled: canEditSelection, run: () => {}, dividerBefore: true, submenu: edges.map((edge) => ({ id: `align-${edge}`, label: ALIGN_LABELS[edge], run: () => commands.alignSelection(edge) })) },
    {
      id: 'distribute',
      label: 'Distribute',
      enabled: () => (commands.live()?.selected.length ?? 0) > 2 && notTyping(),
      run: () => {},
      submenu: [
        { id: 'distribute-h', label: 'Horizontally', run: () => commands.distributeSelection('horizontal') },
        { id: 'distribute-v', label: 'Vertically', run: () => commands.distributeSelection('vertical') }
      ]
    }
  ]
}

const zoom = (step: 'in' | 'out' | 'reset') => () => slidesSession.active()?.editor?.zoom?.(step)

/** Herald Slides: decks of slides drawn in the page, edited in place and presented full screen. */
export function SlidesWindow({ payload }: { payload?: Record<string, unknown> }) {
  const [canOpen, setCanOpen] = useState(true)

  useEffect(() => {
    void officeAbilities().then((abilities) => setCanOpen(openFormats('slides', abilities).length > 0))
  }, [])

  const menus = useMemo(
    () =>
      officeMenus({
        session: slidesSession,
        canSave: true,
        edit: [
          { id: 'cut', label: 'Cut', shortcut: 'mod+x', enabled: canEditSelection, run: () => commands.copyToClipboard(true), dividerBefore: true },
          { id: 'copy', label: 'Copy', shortcut: 'mod+c', enabled: canEditSelection, run: () => commands.copyToClipboard(false) },
          { id: 'duplicate', label: 'Duplicate', shortcut: 'mod+d', enabled: canEditSelection, run: commands.duplicateSelection },
          { id: 'delete', label: 'Delete', enabled: canEditSelection, run: commands.deleteSelection },
          { id: 'select-all', label: 'Select All', shortcut: 'mod+a', enabled: () => hasDeck() && notTyping(), run: commands.selectAll, dividerBefore: true }
        ],
        menus: [
          { id: 'insert', label: 'Insert', items: insertCommands() },
          { id: 'slide', label: 'Slide', items: slideCommands() },
          { id: 'format', label: 'Format', items: formatCommands() },
          { id: 'arrange', label: 'Arrange', items: arrangeCommands() },
          { id: 'table', label: 'Table', items: tableCommands() },
          {
            id: 'view',
            label: 'View',
            items: [
              { id: 'zoom-in', label: 'Zoom In', shortcut: 'mod+=', enabled: hasDeck, run: zoom('in') },
              { id: 'zoom-out', label: 'Zoom Out', shortcut: 'mod+-', enabled: hasDeck, run: zoom('out') },
              { id: 'zoom-fit', label: 'Fit Slide', shortcut: 'mod+0', enabled: hasDeck, run: zoom('reset') }
            ]
          }
        ]
      }),
    []
  )

  const open = (file: string) => slidesSession.open(file).catch((error: unknown) => slidesSession.notify(`Could not open ${file.split('/').pop()}: ${messageOf(error)}`, 'error'))

  return (
    <div
      className="contents"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
        }
      }}
      onDrop={(event) => {
        const files = [...event.dataTransfer.files]
        const slides = files.filter((file) => /\.(pptx|pptm)$/i.test(file.name))
        const pictures = files.filter((file) => file.type.startsWith('image/'))

        if (!slides.length && !pictures.length) {
          return
        }

        event.preventDefault()
        slides.forEach((file) => {
          const path = window.heraldOS.fs.pathForFile(file)

          if (path) {
            void open(path)
          }
        })

        if (pictures.length) {
          void commands.insertPictures(pictures)
        }
      }}
    >
      <OfficeWindow
        session={slidesSession}
        menus={menus}
        payload={payload}
        noun="presentation"
        canOpen={canOpen}
        start={{ icon: 'slides', blurb: 'Slides with rich text, shapes, pictures, layouts and themes, presented full screen. PowerPoint files open and save; Export as PDF keeps a copy.', newLabel: 'New presentation', hint: 'Or drop a PowerPoint file here.' }}
        toolbar={(doc: OfficeDocument<Deck>) => {
          const live = decks.get(doc.key)

          return live ? <Toolbar key={doc.key} doc={live} /> : null
        }}
        renderEditor={(doc) => <SlideEditor doc={doc} />}
      />
      <Present />
    </div>
  )
}
