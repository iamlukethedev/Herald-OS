import { IconChevronDown, IconRefresh, IconTrash } from '@tabler/icons-react'
import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { useEditorState } from '@tiptap/react'
import { useMemo, useState } from 'react'
import { cn } from '../../../lib/cn.ts'
import { Menu } from '../../files/Menu.tsx'
import { applyLive, headingsOf, setTableOfContents, tocPages } from './model.ts'
import { anchorIn, clampLeft, useScrollTick } from './overlay.ts'
import { $pages, docsSession } from './store.ts'
import { ToolButton } from './Toolbar.tsx'

const WIDTH = 252
const LEVELS = [1, 2, 3, 4, 5, 6]

const levelsLabel = (levels: number): string => (levels === 1 ? 'Heading 1 only' : `Headings 1 to ${levels}`)

/** A selected table of contents: its page numbers kept now, the heading levels it lists, or out. */
export function TocBar({ editor, docKey }: { editor: Editor; docKey: string }) {
  const toc = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const selection = current.isDestroyed ? null : current.state.selection

      return selection instanceof NodeSelection && selection.node.type.name === 'tableOfContents' ? { pos: selection.from, levels: Number(selection.node.attrs.levels) || 3 } : null
    }
  })
  const desk = useMemo(() => ({ current: editor.view.dom.closest<HTMLElement>('.docs-desk') }), [editor])
  const tick = useScrollTick(desk)
  const [choosing, setChoosing] = useState(false)

  if (!toc) {
    return null
  }

  void tick
  const frame = editor.view.dom.closest<HTMLElement>('.docs-frame')
  const element = editor.view.nodeDOM(toc.pos)
  const rect = element instanceof HTMLElement ? element.getBoundingClientRect() : null
  const shown = desk.current?.getBoundingClientRect()
  const anchor = anchorIn(frame, rect)

  if (!frame || !rect || !shown || !anchor || rect.bottom < shown.top || rect.top > shown.bottom) {
    return null
  }

  // Above the table, or at the top of the desk while the table runs up past it.
  const top = Math.max(anchor.top - 46, shown.top - frame.getBoundingClientRect().top + 8)

  const update = () => {
    const pages = tocPages(headingsOf(editor.state.doc), toc.levels, $pages.get()[docKey]?.headings)

    if (!applyLive(editor.view, setTableOfContents(toc.pos, { pages }))) {
      docsSession.notify('The table of contents is up to date')
    }
  }

  return (
    <div className="float menu-surface absolute z-30 flex items-center gap-1 rounded-xl p-1.5 animate-pop" style={{ width: WIDTH, left: clampLeft(frame, anchor.left, WIDTH), top }} onMouseDown={(event) => event.preventDefault()}>
      <button type="button" title="Keep the page each entry is on now" onClick={update} className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-fg-2 hover:bg-white/8 hover:text-fg [&_svg]:size-4">
        <IconRefresh />
        Update
      </button>
      <div className="relative min-w-0 flex-1">
        <button
          type="button"
          aria-label="Heading levels"
          aria-haspopup="menu"
          aria-expanded={choosing}
          onClick={() => setChoosing(!choosing)}
          className={cn('flex h-7 w-full items-center gap-1 rounded-md pr-1 pl-2 text-[12px] text-fg-2 hover:bg-white/8 hover:text-fg', choosing && 'bg-white/10 text-fg')}
        >
          <span className="min-w-0 flex-1 truncate text-left">{levelsLabel(toc.levels)}</span>
          <IconChevronDown size={13} className="shrink-0 text-fg-3" />
        </button>
        {choosing && (
          <Menu
            align="left"
            className="top-full mt-1 min-w-44"
            onClose={() => setChoosing(false)}
            items={LEVELS.map((levels) => ({ id: `levels-${levels}`, label: levelsLabel(levels), checked: levels === toc.levels, onSelect: () => applyLive(editor.view, setTableOfContents(toc.pos, { levels })) }))}
          />
        )}
      </div>
      <ToolButton label="Remove table of contents" onClick={() => editor.chain().focus().deleteSelection().run()}>
        <IconTrash />
      </ToolButton>
    </div>
  )
}
