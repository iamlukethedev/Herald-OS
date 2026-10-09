/*
 * Herald Canvas's menus and their shortcuts, in one table so the two never disagree. Shortcuts
 * follow the usual photo-editor keys (⌘J duplicates or copies the selection to a layer, ⌘E merges
 * down, ⌘G groups, ⌘T transforms, ⇧F5 fills).
 */

import { atom } from 'nanostores'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { defaultEffect } from '../../../shared/canvas/comp-format.ts'
import { ADJUSTMENT_MENU } from './adjustment-icons.tsx'
import {
  addAdjustmentLayer,
  addFolder,
  addLayer,
  addMask,
  alignPicked,
  arrange,
  autoAdjust,
  clearLayerStyle,
  copyLayerStyle,
  deletePicked,
  distributePicked,
  duplicatePicked,
  flattenImage,
  groupPicked,
  hasCopiedStyle,
  maskAction,
  mergeDown,
  mergeTarget,
  pasteLayerStyle,
  setEffect,
  showEffects,
  toggleClipping,
  ungroupActive
} from './actions.ts'
import {
  clearSelection,
  copySelection,
  cropToSelection,
  cutSelection,
  deselect,
  fillSelection,
  flipCanvasWay,
  invertSelected,
  layerViaCopy,
  paste,
  rasterize,
  reselect,
  rotateCanvasBy,
  selectEverything,
  type SelectionChange,
  selectLayerPixels
} from './editing.ts'
import { ensureModel } from './ai/models.ts'
import { cannotSegment, selectSubject } from './ai/remove-background.ts'
import { ALIGN_EDGES, ALIGN_LABELS, DISTRIBUTE_LABELS, DISTRIBUTE_MODES } from './engine/align.ts'
import { FILTER_NAMES, type FilterKind } from './engine/filters.ts'
import { applyFilterToDocument, lastFilter } from './filter-run.ts'
import { startSelectMask } from './select-mask.ts'
import { cannotPaint } from './tools/target.ts'
import type { CanvasDocument } from './engine/document.ts'
import { EFFECT_NAMES, EFFECT_ORDER, effectKinds, takesEffects } from './engine/layer-effects.ts'
import { messageOf } from './errors.ts'
import { isMac } from './platform.ts'
import { keysLabel, matches } from '../../lib/shortcuts.ts'
import { $autosave, exportDocument, notify, openPath, save, setAutosave } from './store.ts'
import { hasOpenWork, settleTools } from './tools/sessions.ts'
import { $background, $foreground, setTool } from './tools/state.ts'
import { startTransform, turnPicked } from './tools/transform.ts'
import { $panelTab, $viewOptions, actualPixels, fitToScreen, setViewOption, showPanel, zoomStep } from './view-state.ts'

export { isMac }

/** Dialogs the window shows on request. */
export type CanvasDialog =
  | { kind: 'new' }
  | { kind: 'close'; key: string }
  | { kind: 'canvas-size' }
  | { kind: 'image-size' }
  | { kind: 'trim' }
  | { kind: 'fill' }
  | { kind: 'modify-selection'; change: SelectionChange }
  | { kind: 'remove-background' }
  | { kind: 'content-fill' }
  | { kind: 'generate'; mode: 'fill' | 'layer' }
  | { kind: 'models' }
  | { kind: 'notes'; title: string; notes: string[] }
  | { kind: 'new-guide' }
  | { kind: 'filter'; filter: FilterKind }
  | null

export const $dialog = atom<CanvasDialog>(null)

export interface CanvasCommand {
  id: string
  label: string | ((doc: CanvasDocument | null) => string)
  /** `mod` is ⌘ on the Mac and Ctrl elsewhere: `mod+shift+z`. */
  shortcut?: string
  /** Other shortcuts that run it, not shown in the menu. */
  also?: string[]
  run: (doc: CanvasDocument | null) => void
  /** Off when it cannot apply; commands that need a document are off without one. */
  enabled?: (doc: CanvasDocument) => boolean
  needsDocument?: boolean
  checked?: (doc: CanvasDocument | null) => boolean
  dividerBefore?: boolean
  /** Works on an open Free Transform rather than putting it in first. */
  inSession?: boolean
  /** Commands in a submenu of this one (which then runs nothing itself). */
  submenu?: CanvasCommand[]
}

export interface CanvasMenu {
  id: string
  label: string
  items: CanvasCommand[]
}

const onDoc = (run: (doc: CanvasDocument) => void) => (doc: CanvasDocument | null) => doc && run(doc)

const openFile = async (): Promise<void> => {
  const file = await window.heraldOS.canvas.pickOpen()

  if (file) {
    openPath(file).catch((error: unknown) => notify(`Could not open ${file.split('/').pop()}: ${messageOf(error)}`, 'error'))
  }
}

const selected = (doc: CanvasDocument): boolean => Boolean(doc.state.selection)
const hasLayer = (doc: CanvasDocument): boolean => Boolean(doc.active)
const hasMask = (doc: CanvasDocument): boolean => Boolean(doc.active?.mask)
const nothing = (): void => {}

/** Select > Subject: the model is asked for first when it is not on this computer yet. */
async function subject(doc: CanvasDocument): Promise<void> {
  if (!(await ensureModel('isnet', 'Select Subject'))) {
    return
  }

  notify('Finding the subject…')

  try {
    await selectSubject(doc)
    notify('Selected the subject')
  } catch (error) {
    notify(`Could not select the subject: ${messageOf(error)}`, 'error')
  }
}

const ADJUSTMENT_ITEMS: CanvasCommand[] = ADJUSTMENT_MENU.map(({ kind, dividerBefore }) => ({
  id: `adjustment-${kind}`,
  label: kind,
  needsDocument: true,
  dividerBefore,
  run: onDoc((doc) => addAdjustmentLayer(doc, kind))
}))

const MASK_ITEMS: CanvasCommand[] = [
  { id: 'mask-reveal', label: 'Reveal All', needsDocument: true, enabled: hasLayer, run: onDoc((doc) => maskAction(doc, 'reveal')) },
  { id: 'mask-hide', label: 'Hide All', needsDocument: true, enabled: hasLayer, run: onDoc((doc) => maskAction(doc, 'hide')) },
  { id: 'mask-reveal-selection', label: 'Reveal Selection', needsDocument: true, enabled: (doc) => hasLayer(doc) && selected(doc), run: onDoc((doc) => maskAction(doc, 'revealSelection')) },
  { id: 'mask-hide-selection', label: 'Hide Selection', needsDocument: true, enabled: (doc) => hasLayer(doc) && selected(doc), run: onDoc((doc) => maskAction(doc, 'hideSelection')) },
  { id: 'mask-invert', label: 'Invert', needsDocument: true, enabled: hasMask, run: onDoc((doc) => maskAction(doc, 'invert')), dividerBefore: true },
  { id: 'mask-apply', label: 'Apply', needsDocument: true, enabled: (doc) => hasMask(doc) && !doc.active?.isGroup && !doc.active?.adjustment, run: onDoc((doc) => maskAction(doc, 'apply')) },
  {
    id: 'mask-toggle',
    label: (doc) => (doc?.active?.maskEnabled === false ? 'Enable' : 'Disable'),
    needsDocument: true,
    enabled: hasMask,
    run: onDoc((doc) => maskAction(doc, doc.active?.maskEnabled === false ? 'enable' : 'disable'))
  },
  {
    id: 'mask-link',
    label: (doc) => (doc?.active?.maskLinked === false ? 'Link' : 'Unlink'),
    needsDocument: true,
    enabled: hasMask,
    run: onDoc((doc) => maskAction(doc, doc.active?.maskLinked === false ? 'link' : 'unlink'))
  },
  { id: 'mask-delete', label: 'Delete', needsDocument: true, enabled: hasMask, run: onDoc((doc) => maskAction(doc, 'remove')), dividerBefore: true }
]

const EFFECT_ITEMS: CanvasCommand[] = [
  ...EFFECT_ORDER.map(
    (kind): CanvasCommand => ({
      id: `effect-${kind}`,
      label: EFFECT_NAMES[kind],
      needsDocument: true,
      enabled: (doc) => takesEffects(doc.active),
      checked: (doc) => Boolean(doc?.active?.effects?.[kind]),
      // Picking one the layer lacks adds it; the Properties panel then shows its settings.
      run: onDoc((doc) => {
        const layer = doc.active

        if (layer && !layer.effects?.[kind]) {
          setEffect(doc, layer, kind, defaultEffect[kind]())
        } else if (layer) {
          setEffect(doc, layer, kind, undefined)
        }
      })
    })
  ),
  {
    id: 'effects-visible',
    label: (doc) => (effectKinds(doc?.active?.effects).every((kind) => (doc?.active?.effects?.[kind] as { enabled?: boolean }).enabled === false) ? 'Show All Effects' : 'Hide All Effects'),
    needsDocument: true,
    enabled: (doc) => effectKinds(doc.active?.effects).length > 0,
    dividerBefore: true,
    run: onDoc((doc) => {
      const layer = doc.active

      if (layer) {
        showEffects(doc, layer, effectKinds(layer.effects).every((kind) => (layer.effects?.[kind] as { enabled?: boolean }).enabled === false))
      }
    })
  },
  { id: 'style-copy', label: 'Copy Layer Style', needsDocument: true, enabled: (doc) => effectKinds(doc.active?.effects).length > 0, dividerBefore: true, run: onDoc((doc) => copyLayerStyle(doc)) },
  { id: 'style-paste', label: 'Paste Layer Style', needsDocument: true, enabled: (doc) => hasCopiedStyle() && doc.picked.some(takesEffects), run: onDoc((doc) => pasteLayerStyle(doc)) },
  { id: 'effects-clear', label: 'Clear Layer Style', needsDocument: true, enabled: (doc) => doc.picked.some((layer) => effectKinds(layer.effects).length > 0), run: onDoc((doc) => clearLayerStyle(doc)) }
]

const ALIGN_ITEMS: CanvasCommand[] = ALIGN_EDGES.map((edge, i) => ({
  id: `align-${edge}`,
  label: ALIGN_LABELS[edge].replace('Align ', ''),
  needsDocument: true,
  enabled: (doc) => doc.picked.length > 0,
  dividerBefore: i === 3,
  run: onDoc((doc) => alignPicked(doc, edge))
}))

const DISTRIBUTE_ITEMS: CanvasCommand[] = DISTRIBUTE_MODES.map((mode, i) => ({
  id: `distribute-${mode}`,
  label: DISTRIBUTE_LABELS[mode].replace('Distribute ', ''),
  needsDocument: true,
  enabled: (doc) => doc.picked.length >= 3,
  dividerBefore: i === 3 || i === 6,
  run: onDoc((doc) => distributePicked(doc, mode))
}))

/** Filter > Last Filter: the last filter again, with the same settings, without its dialog. */
async function repeatLastFilter(doc: CanvasDocument): Promise<void> {
  const spec = lastFilter()

  if (!spec) {
    return
  }

  notify(`Applying ${FILTER_NAMES[spec.kind]}…`)

  try {
    notify((await applyFilterToDocument(doc, spec)) ? `Applied ${FILTER_NAMES[spec.kind]}` : `${FILTER_NAMES[spec.kind]} changed nothing`)
  } catch (error) {
    notify(`Could not apply ${FILTER_NAMES[spec.kind]}: ${messageOf(error)}`, 'error')
  }
}

const filterItem = (kind: FilterKind): CanvasCommand => ({
  id: `filter-${kind}`,
  label: `${FILTER_NAMES[kind]}…`,
  needsDocument: true,
  enabled: (doc) => !cannotPaint(doc),
  run: () => $dialog.set({ kind: 'filter', filter: kind })
})

const SNAP_ITEMS: CanvasCommand[] = (
  [
    ['snapGuides', 'Guides'],
    ['snapLayers', 'Layers'],
    ['snapCanvas', 'Canvas Edges and Centre']
  ] as const
).map(([key, label]) => ({ id: `snap-${key}`, label, checked: () => $viewOptions.get()[key], run: () => setViewOption(key, !$viewOptions.get()[key]) }))

export const MENUS: CanvasMenu[] = [
  {
    id: 'file',
    label: 'File',
    items: [
      { id: 'new', label: 'New…', shortcut: 'mod+n', run: () => $dialog.set({ kind: 'new' }) },
      { id: 'open', label: 'Open…', shortcut: 'mod+o', run: () => void openFile() },
      { id: 'save', label: 'Save', shortcut: 'mod+s', needsDocument: true, run: onDoc((doc) => void save(doc).catch(() => {})), dividerBefore: true },
      { id: 'save-as', label: 'Save As…', shortcut: 'mod+shift+s', needsDocument: true, run: onDoc((doc) => void save(doc, { as: true }).catch(() => {})) },
      { id: 'autosave', label: 'Save Automatically', checked: () => $autosave.get(), run: () => setAutosave(!$autosave.get()) },
      { id: 'export-png', label: 'Export as PNG…', shortcut: 'mod+alt+shift+w', needsDocument: true, run: onDoc((doc) => void exportDocument(doc, 'png')), dividerBefore: true },
      { id: 'export-jpeg', label: 'Export as JPEG…', needsDocument: true, run: onDoc((doc) => void exportDocument(doc, 'jpeg')) },
      { id: 'export-webp', label: 'Export as WebP…', needsDocument: true, run: onDoc((doc) => void exportDocument(doc, 'webp')) },
      { id: 'export-psd', label: 'Export as PSD…', needsDocument: true, run: onDoc((doc) => void exportDocument(doc, 'psd')) },
      { id: 'close', label: 'Close', shortcut: 'mod+w', needsDocument: true, run: onDoc((doc) => $dialog.set({ kind: 'close', key: doc.key })), dividerBefore: true }
    ]
  },
  {
    id: 'edit',
    label: 'Edit',
    items: [
      { id: 'undo', label: (doc) => (doc?.history.undoLabel ? `Undo ${doc.history.undoLabel}` : 'Undo'), shortcut: 'mod+z', needsDocument: true, enabled: (doc) => doc.history.canUndo, run: onDoc((doc) => doc.undo()) },
      { id: 'redo', label: (doc) => (doc?.history.redoLabel ? `Redo ${doc.history.redoLabel}` : 'Redo'), shortcut: 'mod+shift+z', needsDocument: true, enabled: (doc) => doc.history.canRedo, run: onDoc((doc) => doc.redo()) },
      { id: 'toggle-last', label: 'Toggle Last State', shortcut: 'mod+alt+z', needsDocument: true, enabled: (doc) => doc.history.canUndo || doc.history.canRedo, run: onDoc((doc) => doc.toggleLast()) },
      { id: 'history', label: 'History', needsDocument: true, checked: () => $panelTab.get() === 'history', run: () => showPanel($panelTab.get() === 'history' ? 'properties' : 'history') },
      { id: 'cut', label: 'Cut', shortcut: 'mod+x', needsDocument: true, enabled: selected, run: onDoc(cutSelection), dividerBefore: true },
      { id: 'copy', label: 'Copy', shortcut: 'mod+c', needsDocument: true, enabled: hasLayer, run: onDoc((doc) => copySelection(doc)) },
      { id: 'copy-merged', label: 'Copy Merged', shortcut: 'mod+shift+c', needsDocument: true, run: onDoc((doc) => copySelection(doc, true)) },
      { id: 'paste', label: 'Paste', shortcut: 'mod+v', needsDocument: true, run: onDoc((doc) => void paste(doc).catch((error: unknown) => notify(`Could not paste: ${messageOf(error)}`, 'error'))) },
      { id: 'fill', label: 'Fill…', shortcut: 'shift+f5', also: ['shift+backspace'], needsDocument: true, enabled: hasLayer, run: () => $dialog.set({ kind: 'fill' }), dividerBefore: true },
      { id: 'fill-foreground', label: 'Fill with Foreground', shortcut: 'alt+backspace', needsDocument: true, enabled: hasLayer, run: onDoc((doc) => fillSelection(doc, [...$foreground.get(), 255])) },
      { id: 'fill-background', label: 'Fill with Background', shortcut: 'mod+backspace', needsDocument: true, enabled: hasLayer, run: onDoc((doc) => fillSelection(doc, [...$background.get(), 255])) },
      { id: 'content-fill', label: 'Content-Aware Fill…', needsDocument: true, enabled: selected, run: () => $dialog.set({ kind: 'content-fill' }) },
      { id: 'generative-fill', label: 'Generative Fill…', needsDocument: true, enabled: selected, run: () => $dialog.set({ kind: 'generate', mode: 'fill' }) },
      {
        id: 'clear',
        label: (doc) => (doc?.state.selection ? 'Clear' : 'Delete Layer'),
        shortcut: 'backspace',
        also: ['delete'],
        needsDocument: true,
        enabled: (doc) => doc.picked.length > 0,
        run: onDoc((doc) => clearSelection(doc) || deletePicked(doc))
      },
      {
        id: 'free-transform',
        label: 'Free Transform',
        shortcut: 'mod+t',
        needsDocument: true,
        enabled: hasLayer,
        inSession: true,
        run: onDoc((doc) => {
          setTool('move')
          startTransform(doc)
        }),
        dividerBefore: true
      },
      {
        id: 'distort',
        label: 'Distort',
        needsDocument: true,
        enabled: hasLayer,
        inSession: true,
        run: onDoc((doc) => {
          setTool('move')
          startTransform(doc, { distort: true })
        })
      },
      { id: 'flip-horizontal', label: 'Flip Horizontal', needsDocument: true, enabled: hasLayer, inSession: true, run: onDoc((doc) => turnPicked(doc, { flip: 'horizontal' }, 'Flip Horizontal')) },
      { id: 'flip-vertical', label: 'Flip Vertical', needsDocument: true, enabled: hasLayer, inSession: true, run: onDoc((doc) => turnPicked(doc, { flip: 'vertical' }, 'Flip Vertical')) },
      { id: 'rotate-180', label: 'Rotate 180°', needsDocument: true, enabled: hasLayer, inSession: true, run: onDoc((doc) => turnPicked(doc, { degrees: 180 }, 'Rotate 180°')) },
      { id: 'rotate-cw', label: 'Rotate 90° Clockwise', needsDocument: true, enabled: hasLayer, inSession: true, run: onDoc((doc) => turnPicked(doc, { degrees: 90 }, 'Rotate 90° Clockwise')) },
      { id: 'rotate-ccw', label: 'Rotate 90° Counter Clockwise', needsDocument: true, enabled: hasLayer, inSession: true, run: onDoc((doc) => turnPicked(doc, { degrees: -90 }, 'Rotate 90° Counter Clockwise')) },
      { id: 'models', label: 'AI Models…', run: () => $dialog.set({ kind: 'models' }), dividerBefore: true }
    ]
  },
  {
    id: 'image',
    label: 'Image',
    items: [
      { id: 'auto-tone', label: 'Auto Tone', shortcut: 'mod+shift+l', needsDocument: true, enabled: (doc) => doc.state.layers.length > 0, run: onDoc((doc) => autoAdjust(doc, 'tone')) },
      { id: 'auto-contrast', label: 'Auto Contrast', shortcut: 'mod+alt+shift+l', needsDocument: true, enabled: (doc) => doc.state.layers.length > 0, run: onDoc((doc) => autoAdjust(doc, 'contrast')) },
      { id: 'auto-color', label: 'Auto Color', shortcut: 'mod+shift+b', needsDocument: true, enabled: (doc) => doc.state.layers.length > 0, run: onDoc((doc) => autoAdjust(doc, 'color')) },
      { id: 'image-size', label: 'Image Size…', shortcut: 'mod+alt+i', needsDocument: true, run: () => $dialog.set({ kind: 'image-size' }), dividerBefore: true },
      { id: 'canvas-size', label: 'Canvas Size…', shortcut: 'mod+alt+c', needsDocument: true, run: () => $dialog.set({ kind: 'canvas-size' }) },
      { id: 'crop', label: 'Crop to Selection', needsDocument: true, enabled: selected, run: onDoc(cropToSelection), dividerBefore: true },
      { id: 'trim', label: 'Trim…', needsDocument: true, run: () => $dialog.set({ kind: 'trim' }) },
      { id: 'rotate-canvas-180', label: 'Rotate Canvas 180°', needsDocument: true, run: onDoc((doc) => rotateCanvasBy(doc, 2)), dividerBefore: true },
      { id: 'rotate-canvas-cw', label: 'Rotate Canvas 90° Clockwise', needsDocument: true, run: onDoc((doc) => rotateCanvasBy(doc, 1)) },
      { id: 'rotate-canvas-ccw', label: 'Rotate Canvas 90° Counter Clockwise', needsDocument: true, run: onDoc((doc) => rotateCanvasBy(doc, 3)) },
      { id: 'flip-canvas-horizontal', label: 'Flip Canvas Horizontal', needsDocument: true, run: onDoc((doc) => flipCanvasWay(doc, true)) },
      { id: 'flip-canvas-vertical', label: 'Flip Canvas Vertical', needsDocument: true, run: onDoc((doc) => flipCanvasWay(doc, false)) },
      { id: 'flatten', label: 'Flatten Image', needsDocument: true, enabled: (doc) => doc.state.layers.length > 0, run: onDoc(flattenImage), dividerBefore: true }
    ]
  },
  {
    id: 'layer',
    label: 'Layer',
    items: [
      { id: 'new-layer', label: 'New Layer', shortcut: 'mod+shift+n', needsDocument: true, run: onDoc(addLayer) },
      { id: 'new-folder', label: 'New Folder', needsDocument: true, run: onDoc(addFolder) },
      { id: 'new-adjustment', label: 'New Adjustment Layer', needsDocument: true, run: nothing, submenu: ADJUSTMENT_ITEMS },
      { id: 'new-generated', label: 'New Generated Layer…', needsDocument: true, run: () => $dialog.set({ kind: 'generate', mode: 'layer' }) },
      {
        id: 'duplicate',
        label: (doc) => (doc?.state.selection ? 'New Layer via Copy' : 'Duplicate'),
        shortcut: 'mod+j',
        needsDocument: true,
        enabled: (doc) => doc.picked.length > 0,
        run: onDoc((doc) => (doc.state.selection ? layerViaCopy(doc) : duplicatePicked(doc)))
      },
      { id: 'via-cut', label: 'New Layer via Cut', shortcut: 'mod+shift+j', needsDocument: true, enabled: (doc) => selected(doc) && Boolean(doc.active?.pixels), run: onDoc((doc) => layerViaCopy(doc, true)) },
      { id: 'delete', label: 'Delete', needsDocument: true, enabled: (doc) => doc.picked.length > 0, run: onDoc(deletePicked) },
      { id: 'rasterize', label: 'Rasterize', needsDocument: true, enabled: (doc) => Boolean(doc.active?.text || doc.active?.shape), run: onDoc(rasterize) },
      { id: 'remove-background', label: 'Remove Background…', needsDocument: true, enabled: (doc) => !cannotSegment(doc.active), run: () => $dialog.set({ kind: 'remove-background' }) },
      { id: 'group', label: 'Group Layers', shortcut: 'mod+g', needsDocument: true, enabled: (doc) => doc.picked.length > 0, run: onDoc(groupPicked), dividerBefore: true },
      { id: 'ungroup', label: 'Ungroup', shortcut: 'mod+shift+g', needsDocument: true, enabled: (doc) => Boolean(doc.active?.isGroup), run: onDoc(ungroupActive) },
      { id: 'mask', label: 'Add Mask', needsDocument: true, enabled: (doc) => Boolean(doc.active && !doc.active.mask), run: onDoc((doc) => addMask(doc)), dividerBefore: true },
      { id: 'layer-mask', label: 'Layer Mask', needsDocument: true, enabled: hasLayer, run: nothing, submenu: MASK_ITEMS },
      { id: 'layer-effects', label: 'Layer Style', needsDocument: true, enabled: (doc) => doc.picked.some(takesEffects), run: nothing, submenu: EFFECT_ITEMS },
      {
        id: 'clip',
        label: (doc) => (doc?.active?.maskSourceID ? 'Release Clipping Mask' : 'Create Clipping Mask'),
        shortcut: 'mod+alt+g',
        needsDocument: true,
        enabled: (doc) => Boolean(doc.active && !doc.active.isGroup),
        run: onDoc(toggleClipping),
        dividerBefore: true
      },
      { id: 'forward', label: 'Bring Forward', shortcut: 'mod+]', needsDocument: true, run: onDoc((doc) => arrange(doc, 'up')), dividerBefore: true },
      { id: 'backward', label: 'Send Backward', shortcut: 'mod+[', needsDocument: true, run: onDoc((doc) => arrange(doc, 'down')) },
      { id: 'front', label: 'Bring to Front', shortcut: 'mod+shift+]', needsDocument: true, run: onDoc((doc) => arrange(doc, 'top')) },
      { id: 'back', label: 'Send to Back', shortcut: 'mod+shift+[', needsDocument: true, run: onDoc((doc) => arrange(doc, 'bottom')) },
      { id: 'align', label: (doc) => (doc?.state.selection ? 'Align Layers to Selection' : 'Align'), needsDocument: true, enabled: (doc) => doc.picked.length > 0, run: nothing, submenu: ALIGN_ITEMS, dividerBefore: true },
      { id: 'distribute', label: 'Distribute', needsDocument: true, enabled: (doc) => doc.picked.length >= 3, run: nothing, submenu: DISTRIBUTE_ITEMS },
      { id: 'merge-down', label: 'Merge Down', shortcut: 'mod+e', needsDocument: true, enabled: (doc) => Boolean(mergeTarget(doc)), run: onDoc(mergeDown), dividerBefore: true }
    ]
  },
  {
    id: 'select',
    label: 'Select',
    items: [
      { id: 'select-all', label: 'All', shortcut: 'mod+a', needsDocument: true, run: onDoc(selectEverything) },
      { id: 'deselect', label: 'Deselect', shortcut: 'mod+d', needsDocument: true, enabled: selected, run: onDoc(deselect) },
      { id: 'reselect', label: 'Reselect', shortcut: 'mod+shift+d', needsDocument: true, enabled: (doc) => Boolean(doc.lastSelection && !doc.state.selection), run: onDoc(reselect) },
      { id: 'inverse', label: 'Inverse', shortcut: 'mod+shift+i', needsDocument: true, enabled: selected, run: onDoc(invertSelected) },
      { id: 'subject', label: 'Subject', needsDocument: true, enabled: (doc) => doc.state.layers.length > 0, run: onDoc((doc) => void subject(doc)) },
      { id: 'select-and-mask', label: 'Select and Mask…', shortcut: 'mod+alt+r', needsDocument: true, enabled: (doc) => selected(doc) || Boolean(doc.editingMask), run: onDoc(startSelectMask) },
      { id: 'feather', label: 'Feather…', shortcut: 'shift+f6', needsDocument: true, enabled: selected, run: () => $dialog.set({ kind: 'modify-selection', change: 'feather' }), dividerBefore: true },
      { id: 'expand', label: 'Expand…', needsDocument: true, enabled: selected, run: () => $dialog.set({ kind: 'modify-selection', change: 'expand' }) },
      { id: 'contract', label: 'Contract…', needsDocument: true, enabled: selected, run: () => $dialog.set({ kind: 'modify-selection', change: 'contract' }) },
      { id: 'layer-pixels', label: 'Layer Pixels', needsDocument: true, enabled: (doc) => Boolean(doc.active?.pixels), run: onDoc((doc) => selectLayerPixels(doc)), dividerBefore: true },
      { id: 'layer-mask', label: 'Layer Mask', needsDocument: true, enabled: (doc) => Boolean(doc.active?.mask), run: onDoc((doc) => selectLayerPixels(doc, doc.active, true)) }
    ]
  },
  {
    id: 'filter',
    label: 'Filter',
    items: [
      {
        id: 'last-filter',
        label: () => {
          const spec = lastFilter()

          return spec ? `Last Filter: ${FILTER_NAMES[spec.kind]}` : 'Last Filter'
        },
        shortcut: 'mod+alt+f',
        needsDocument: true,
        enabled: (doc) => Boolean(lastFilter()) && !cannotPaint(doc),
        run: onDoc((doc) => void repeatLastFilter(doc))
      },
      { id: 'filter-blur', label: 'Blur', needsDocument: true, run: nothing, submenu: [filterItem('gaussianBlur'), filterItem('motionBlur')], dividerBefore: true },
      { id: 'filter-noise', label: 'Noise', needsDocument: true, run: nothing, submenu: [filterItem('addNoise'), filterItem('median'), filterItem('reduceNoise')] },
      { id: 'filter-sharpen', label: 'Sharpen', needsDocument: true, run: nothing, submenu: [filterItem('unsharpMask'), filterItem('smartSharpen')] },
      { id: 'filter-other', label: 'Other', needsDocument: true, run: nothing, submenu: [filterItem('highPass')] }
    ]
  },
  {
    id: 'view',
    label: 'View',
    items: [
      { id: 'zoom-in', label: 'Zoom In', shortcut: 'mod+=', needsDocument: true, run: onDoc((doc) => zoomStep(doc, 1)) },
      { id: 'zoom-out', label: 'Zoom Out', shortcut: 'mod+-', needsDocument: true, run: onDoc((doc) => zoomStep(doc, -1)) },
      { id: 'fit', label: 'Fit on Screen', shortcut: 'mod+0', needsDocument: true, run: onDoc((doc) => fitToScreen(doc)) },
      { id: 'actual', label: 'Actual Pixels', shortcut: 'mod+1', needsDocument: true, run: onDoc(actualPixels) },
      { id: 'rulers', label: 'Rulers', shortcut: 'mod+r', checked: () => $viewOptions.get().rulers, run: () => setViewOption('rulers', !$viewOptions.get().rulers), dividerBefore: true },
      { id: 'show-guides', label: 'Guides', shortcut: 'mod+;', checked: () => $viewOptions.get().guides, run: () => setViewOption('guides', !$viewOptions.get().guides) },
      { id: 'lock-guides', label: 'Lock Guides', shortcut: 'mod+alt+;', checked: () => $viewOptions.get().lockGuides, run: () => setViewOption('lockGuides', !$viewOptions.get().lockGuides) },
      { id: 'new-guide', label: 'New Guide…', needsDocument: true, run: () => $dialog.set({ kind: 'new-guide' }) },
      { id: 'clear-guides', label: 'Clear Guides', needsDocument: true, enabled: (doc) => doc.state.guides.length > 0, run: onDoc((doc) => doc.commit('Clear Guides', { ...doc.state, guides: [] })) },
      { id: 'snap', label: 'Snap', shortcut: 'mod+shift+;', checked: () => $viewOptions.get().snap, run: () => setViewOption('snap', !$viewOptions.get().snap), dividerBefore: true },
      { id: 'snap-to', label: 'Snap To', run: nothing, submenu: SNAP_ITEMS },
      { id: 'smart-guides', label: 'Smart Guides', checked: () => $viewOptions.get().smartGuides, run: () => setViewOption('smartGuides', !$viewOptions.get().smartGuides) }
    ]
  }
]

export const commandLabel = (command: CanvasCommand, doc: CanvasDocument | null): string => (typeof command.label === 'function' ? command.label(doc) : command.label)

export const isEnabled = (command: CanvasCommand, doc: CanvasDocument | null): boolean => (command.needsDocument ? Boolean(doc) && (command.enabled?.(doc!) ?? true) : true)

/** Run a command, putting a tool's open work in first; Undo with work open drops that work and stops there. */
export function runCommand(command: CanvasCommand, doc: CanvasDocument | null): void {
  if (command.id === 'undo' && hasOpenWork(doc)) {
    settleTools(doc, 'cancel')

    return
  }

  if (!command.inSession) {
    settleTools(doc)
  }

  command.run(doc)
}

export { keysLabel, matches }

/** Commands with the ones in their submenus. */
const everyCommand = (commands: readonly CanvasCommand[]): CanvasCommand[] => commands.flatMap((command) => [command, ...everyCommand(command.submenu ?? [])])

/** Run the command a key press is for; true when one ran. */
export function runShortcut(event: KeyboardEvent | ReactKeyboardEvent, doc: CanvasDocument | null): boolean {
  for (const menu of MENUS) {
    for (const command of everyCommand(menu.items)) {
      if ([command.shortcut, ...(command.also ?? [])].some((shortcut) => shortcut && matches(event, shortcut)) && isEnabled(command, doc)) {
        runCommand(command, doc)

        return true
      }
    }
  }

  return false
}
