import { ThreadCommentPanelService } from '@univerjs/thread-comment-ui'
import { cellName } from '../../../../../shared/office/xlsx/address.ts'
import type { OfficeCommand } from '../../shell/commands.ts'
import { activeKey, activeWorkbook, failed } from '../active.ts'
import { runInDocument } from '../live.ts'
import { listComments, listNotes } from './model.ts'

/** Univer's own editors and panel, on the active cell. */
const COMMENT_EDITOR = 'sheet.operation.show-comment-modal'
const NOTE_EDITOR = 'sheet.operation.add-note-popup'
const COMMENTS_PANEL = 'sheet.operation.toggle-comment-panel'

/** The cell the cursor is in on the sheet in front, and whether it holds a comment thread or a note. */
function activeCell() {
  const active = activeWorkbook()
  const sheet = active?.target.workbook.getActiveSheet()
  const cell = sheet?.getSelection()?.getCurrentCell()

  if (!active || !sheet || !cell) {
    return null
  }

  const name = cellName(cell.actualRow, cell.actualColumn)
  const on = (entry: { sheet: string; cell: string }) => entry.sheet === sheet.getSheetName() && entry.cell === name

  return { key: active.key, name, thread: listComments(active.target, { sheet: sheet.getSheetName() }).some(on), note: listNotes(active.target, { sheet: sheet.getSheetName() }).some(on) }
}

const panelOpen = (): boolean => {
  const injector = activeWorkbook()?.target.univer.__getInjector()

  return Boolean(injector?.has(ThreadCommentPanelService) && injector.get(ThreadCommentPanelService).panelVisible)
}

/** The Insert menu's comments and notes: Univer's comment editor and note editor on the active cell, and its comments panel. */
export function commentCommands(): OfficeCommand[] {
  return [
    {
      id: 'comment-new',
      label: 'Comment',
      dividerBefore: true,
      enabled: () => Boolean(activeKey()),
      run: () => {
        const cell = activeCell()

        // A cell holds a note or a comment thread, as in Excel.
        if (cell?.note) {
          failed(new Error(`${cell.name} has a note: a cell holds a note or a comment`))
        } else if (cell) {
          runInDocument(cell.key, COMMENT_EDITOR)
        }
      }
    },
    {
      id: 'note-new',
      label: 'Note',
      enabled: () => Boolean(activeKey()),
      run: () => {
        const cell = activeCell()

        if (cell?.thread) {
          failed(new Error(`${cell.name} has a comment: a cell holds a note or a comment`))
        } else if (cell) {
          runInDocument(cell.key, NOTE_EDITOR)
        }
      }
    },
    {
      id: 'comments-show',
      label: 'Show comments',
      enabled: () => Boolean(activeKey()),
      checked: panelOpen,
      run: () => {
        const key = activeKey()

        if (key) {
          runInDocument(key, COMMENTS_PANEL)
        }
      }
    }
  ]
}
