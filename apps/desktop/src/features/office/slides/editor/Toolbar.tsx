import { useStore } from '@nanostores/react'
import {
  IconAlignCenter,
  IconAlignJustified,
  IconAlignLeft,
  IconAlignRight,
  IconArrowNarrowRight,
  IconBackground,
  IconBold,
  IconChevronDown,
  IconCircle,
  IconColumnInsertLeft,
  IconColumnInsertRight,
  IconColumnRemove,
  IconIndentDecrease,
  IconIndentIncrease,
  IconItalic,
  IconLayoutBoardSplit,
  IconLetterT,
  IconLineDashed,
  IconLineHeight,
  IconList,
  IconListNumbers,
  IconPalette,
  IconPhoto,
  IconPlayerPlay,
  IconPlus,
  IconRowInsertBottom,
  IconRowInsertTop,
  IconRowRemove,
  IconSquare,
  IconStrikethrough,
  IconTable,
  IconTriangle,
  IconUnderline
} from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { cn } from '../../../../lib/cn.ts'
import { ARROW_HEADS, type ArrowHead, type Color, type Dash, DASHES, type LineElement, type ShapeElement, type TableElement, type TextElement, type Theme } from '../deck.ts'
import type { SlidesDocument } from '../document.ts'
import { ARROW_NAMES } from '../elements.ts'
import { DASH_NAMES, INSERTABLE, SHAPE_NAMES, shapePath } from '../shapes.ts'
import { resolveColor, resolveFont } from '../themes.ts'
import { $textRevision, $textSession } from './active.ts'
import { BackgroundPanel } from './BackgroundPanel.tsx'
import * as commands from './commands.ts'
import { ColorGrid, FontList, LayoutGrid, PopoverButton, SizeList, TableGrid, ThemeGrid } from './pickers.tsx'
import { useDeck } from './Stage.tsx'

/*
 * The formatting bar over the slide: new slides with their layout, things to insert, and the tools
 * for what is selected (text, shapes, lines, pictures), then the theme and Present. Text tools
 * format the selected words while typing and whole boxes otherwise.
 */

function Tool({ label, onClick, active, children, disabled, className }: { label: string; onClick: () => void; active?: boolean; children: ReactNode; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn('grid h-7 min-w-7 place-items-center rounded-md px-1.5 text-fg-2 hover:bg-white/8 hover:text-fg disabled:opacity-40 [&_svg]:size-4', active && 'bg-white/12 text-fg', className)}
    >
      {children}
    </button>
  )
}

const Divider = () => <span className="mx-1 h-5 w-px shrink-0 bg-line" />

function ShapeIcon({ kind }: { kind: Parameters<typeof shapePath>[0] }) {
  return (
    <svg viewBox="-1 -1 22 16" className="h-4 w-5" aria-hidden="true">
      <path d={shapePath(kind, 20, 14)} fill="none" stroke="currentColor" strokeWidth={1.4} />
    </svg>
  )
}

function Swatch({ color, theme }: { color: Color | null; theme: Theme }) {
  return <span className="h-[3px] w-4 rounded-full" style={{ background: color ? resolveColor(color, theme) : 'transparent', outline: color ? undefined : '1px dashed currentColor' }} />
}

function TextTools({ doc }: { doc: SlidesDocument }) {
  useStore($textRevision)
  const format = commands.currentFormat(doc)
  const theme = doc.deck.theme
  const fontName = resolveFont(format.font, theme)

  return (
    <>
      <PopoverButton label="Font" className="w-[132px] justify-between text-[12px]" panel={(close) => <FontList theme={theme} value={format.font} onPick={(font) => (commands.setRunStyle({ font }), close())} />}>
        <span className="truncate">{fontName}</span>
        <IconChevronDown size={12} />
      </PopoverButton>
      <PopoverButton label="Text size" className="w-[54px] justify-between text-[12px] tabular-nums" panel={(close) => <SizeList value={format.size} onPick={(size) => (commands.setRunStyle({ size }), close())} />}>
        <span>{Math.round(format.size * 10) / 10}</span>
        <IconChevronDown size={12} />
      </PopoverButton>
      <Tool label="Bold" active={format.bold} onClick={() => commands.toggleSwitch('bold')}>
        <IconBold />
      </Tool>
      <Tool label="Italic" active={format.italic} onClick={() => commands.toggleSwitch('italic')}>
        <IconItalic />
      </Tool>
      <Tool label="Underline" active={format.underline} onClick={() => commands.toggleSwitch('underline')}>
        <IconUnderline />
      </Tool>
      <Tool label="Strikethrough" active={format.strike} onClick={() => commands.toggleSwitch('strike')}>
        <IconStrikethrough />
      </Tool>
      <PopoverButton label="Text colour" panel={(close) => <ColorGrid theme={theme} value={format.color} onPick={(color) => (commands.setRunStyle({ color: color ?? 'tx1' }), close())} />}>
        <span className="flex flex-col items-center gap-[2px] text-[12px] leading-none font-semibold">
          A
          <Swatch color={format.color} theme={theme} />
        </span>
      </PopoverButton>
      <PopoverButton label="Highlight" panel={(close) => <ColorGrid theme={theme} value={format.highlight} none noneLabel="No highlight" onPick={(highlight) => (commands.setRunStyle({ highlight }), close())} />}>
        <span className="flex flex-col items-center gap-[2px]">
          <IconPalette size={14} />
          <Swatch color={format.highlight} theme={theme} />
        </span>
      </PopoverButton>
      <Divider />
      <PopoverButton
        label="Align text"
        panel={(close) => (
          <div className="flex gap-1">
            {(
              [
                ['left', IconAlignLeft, 'Align left'],
                ['center', IconAlignCenter, 'Centre'],
                ['right', IconAlignRight, 'Align right'],
                ['justify', IconAlignJustified, 'Justify']
              ] as const
            ).map(([align, Icon, label]) => (
              <Tool key={align} label={label} active={format.align === align} onClick={() => (commands.setAlign(align), close())}>
                <Icon />
              </Tool>
            ))}
          </div>
        )}
      >
        {format.align === 'center' ? <IconAlignCenter /> : format.align === 'right' ? <IconAlignRight /> : format.align === 'justify' ? <IconAlignJustified /> : <IconAlignLeft />}
      </PopoverButton>
      <Tool label="Bullets" active={format.list === 'bullet'} onClick={() => commands.toggleListKind('bullet')}>
        <IconList />
      </Tool>
      <Tool label="Numbering" active={format.list === 'number'} onClick={() => commands.toggleListKind('number')}>
        <IconListNumbers />
      </Tool>
      <Tool label="Decrease list level" onClick={() => commands.shiftLevels(-1)}>
        <IconIndentDecrease />
      </Tool>
      <Tool label="Increase list level" onClick={() => commands.shiftLevels(1)}>
        <IconIndentIncrease />
      </Tool>
      <PopoverButton
        label="Line spacing"
        panel={(close) => (
          <div className="flex w-28 flex-col">
            {[1, 1.15, 1.5, 2, 2.5, 3].map((spacing) => (
              <button key={spacing} type="button" onClick={() => (commands.setLineSpacing(spacing), close())} className={cn('h-7 rounded-md px-2 text-left text-[12px] text-fg-2 hover:bg-white/8 hover:text-fg', Math.abs(format.lineSpacing - spacing) < 0.01 && 'bg-white/12 text-fg')}>
                {spacing.toFixed(spacing % 1 ? 2 : 1).replace(/0$/, '')}
              </button>
            ))}
          </div>
        )}
      >
        <IconLineHeight />
      </PopoverButton>
    </>
  )
}

function ShapeTools({ doc }: { doc: SlidesDocument }) {
  const theme = doc.deck.theme
  const selection = doc.selection
  const filled = selection.find((element): element is TextElement | ShapeElement | TableElement => element.kind === 'shape' || element.kind === 'text' || element.kind === 'table')
  const line = selection.find((element): element is LineElement => element.kind === 'line')
  const typing = filled?.kind === 'table' && doc.editing === filled.id ? doc.cell : null
  const fill = filled?.kind === 'table' ? ((typing ? filled.cells[typing.row][typing.column] : filled.cells[0]?.[0])?.fill ?? null) : (filled?.fill ?? null)
  const first = selection[0]
  const stroke = first && first.kind !== 'object' ? (first.stroke ?? null) : null

  return (
    <>
      {filled && (
        <PopoverButton
          label={filled.kind === 'table' ? (typing ? 'Cell fill' : 'Fill all cells') : 'Fill'}
          panel={(close) => <ColorGrid theme={theme} value={fill?.color ?? null} none noneLabel="No fill" onPick={(color) => (commands.setFill(color ? { color } : null), close())} />}
        >
          <span className="flex flex-col items-center gap-[2px]">
            <IconSquare size={14} />
            <Swatch color={fill?.color ?? null} theme={theme} />
          </span>
        </PopoverButton>
      )}
      <PopoverButton
        label="Outline"
        panel={(close) => (
          <div className="flex flex-col gap-3">
            <ColorGrid theme={theme} value={stroke?.color ?? null} none={!line} noneLabel="No outline" onPick={(color) => (commands.setStroke(color ? { color } : null), close())} />
            <div className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
              Width
              {[0.75, 1, 1.5, 2, 3, 4.5, 6].map((width) => (
                <button key={width} type="button" onClick={() => commands.setStroke({ width })} className={cn('h-6 min-w-6 rounded px-1 tabular-nums text-fg-2 hover:bg-white/8', stroke?.width === width && 'bg-white/12 text-fg')}>
                  {width}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 text-[11.5px] text-fg-3">
              {DASHES.map((dash: Dash) => (
                <button key={dash} type="button" title={DASH_NAMES[dash]} aria-label={DASH_NAMES[dash]} onClick={() => commands.setStroke({ dash })} className={cn('grid h-6 w-9 place-items-center rounded hover:bg-white/8', stroke?.dash === dash && 'bg-white/12')}>
                  <svg width="26" height="4" aria-hidden="true">
                    <line x1="0" y1="2" x2="26" y2="2" stroke="currentColor" strokeWidth="2" strokeDasharray={dash === 'solid' ? undefined : dash === 'dot' ? '2 2' : dash === 'dash' ? '6 3' : dash === 'dashDot' ? '6 3 2 3' : '10 3'} />
                  </svg>
                </button>
              ))}
            </div>
          </div>
        )}
      >
        <span className="flex flex-col items-center gap-[2px]">
          <IconLineDashed size={14} />
          <Swatch color={stroke?.color ?? null} theme={theme} />
        </span>
      </PopoverButton>
      {line && (
        <PopoverButton
          label="Arrows"
          panel={(close) => (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-fg-2">
              <span className="text-[11px] text-fg-3 uppercase">Start</span>
              <span className="text-[11px] text-fg-3 uppercase">End</span>
              {ARROW_HEADS.map((head: ArrowHead) => (
                <div key={head} className="contents">
                  <button type="button" onClick={() => (commands.setArrowHeads({ start: head }), close())} className={cn('h-7 rounded-md px-2 text-left hover:bg-white/8', line.start === head && 'bg-white/12 text-fg')}>
                    {ARROW_NAMES[head]}
                  </button>
                  <button type="button" onClick={() => (commands.setArrowHeads({ end: head }), close())} className={cn('h-7 rounded-md px-2 text-left hover:bg-white/8', line.end === head && 'bg-white/12 text-fg')}>
                    {ARROW_NAMES[head]}
                  </button>
                </div>
              ))}
            </div>
          )}
        >
          <IconArrowNarrowRight />
        </PopoverButton>
      )}
    </>
  )
}

/** Rows and columns in and out at the selected table's current cell. */
function TableTools({ doc }: { doc: SlidesDocument }) {
  const atCell = commands.hasTableCell(doc)

  return (
    <>
      <Tool label="Insert row above" onClick={() => commands.insertRow('above', doc)}>
        <IconRowInsertTop />
      </Tool>
      <Tool label="Insert row below" onClick={() => commands.insertRow('below', doc)}>
        <IconRowInsertBottom />
      </Tool>
      <Tool label="Insert column left" onClick={() => commands.insertColumn('left', doc)}>
        <IconColumnInsertLeft />
      </Tool>
      <Tool label="Insert column right" onClick={() => commands.insertColumn('right', doc)}>
        <IconColumnInsertRight />
      </Tool>
      <Tool label="Delete row" disabled={!atCell} onClick={() => commands.deleteRows(doc)}>
        <IconRowRemove />
      </Tool>
      <Tool label="Delete column" disabled={!atCell} onClick={() => commands.deleteColumns(doc)}>
        <IconColumnRemove />
      </Tool>
    </>
  )
}

export function Toolbar({ doc }: { doc: SlidesDocument }) {
  useDeck(doc)
  const session = useStore($textSession)
  const deck = doc.deck
  const selection = doc.selection
  const texty = session?.doc === doc || selection.some((element) => element.kind === 'text' || element.kind === 'shape' || element.kind === 'table')

  return (
    <div data-slides-keep-editing="" className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto overflow-y-visible border-b border-line px-2 text-[12px]">
      <div className="relative flex">
        <Tool label="New slide" className="rounded-r-none px-2" onClick={() => commands.newSlide(doc.slide.layout === 'title' ? 'title-content' : doc.slide.layout)}>
          <span className="flex items-center gap-1.5">
            <IconPlus size={15} /> Slide
          </span>
        </Tool>
        <PopoverButton label="New slide with a layout" className="rounded-l-none px-0.5" panel={(close) => <LayoutGrid deck={deck} onPick={(layout) => (commands.newSlide(layout), close())} />}>
          <IconChevronDown size={13} />
        </PopoverButton>
      </div>
      <PopoverButton label="Layout" panel={(close) => <LayoutGrid deck={deck} current={doc.slide.layout} onPick={(layout) => (commands.setLayout(layout), close())} />}>
        <IconLayoutBoardSplit />
      </PopoverButton>
      <Divider />
      <Tool label="Text box" onClick={commands.insertText}>
        <IconLetterT />
      </Tool>
      <PopoverButton
        label="Shape"
        panel={(close) => (
          <div className="grid w-[244px] grid-cols-6 gap-1">
            {INSERTABLE.map((kind) => (
              <Tool key={kind} label={SHAPE_NAMES[kind]} onClick={() => (commands.insertShape(kind), close())}>
                <ShapeIcon kind={kind} />
              </Tool>
            ))}
            <Tool label="Line" onClick={() => (commands.insertLine('none'), close())}>
              <svg viewBox="0 0 20 14" className="h-4 w-5" aria-hidden="true">
                <line x1="2" y1="12" x2="18" y2="2" stroke="currentColor" strokeWidth={1.6} />
              </svg>
            </Tool>
            <Tool label="Arrow" onClick={() => (commands.insertLine('triangle'), close())}>
              <IconArrowNarrowRight />
            </Tool>
          </div>
        )}
      >
        <span className="flex items-center">
          <IconTriangle size={15} />
          <IconCircle size={11} className="-ml-1" />
        </span>
      </PopoverButton>
      <Tool label="Picture" onClick={() => commands.pickPictures(doc)}>
        <IconPhoto />
      </Tool>
      <PopoverButton label="Table" panel={(close) => <TableGrid onPick={(rows, columns) => (close(), commands.insertTable(rows, columns, doc))} />}>
        <IconTable />
      </PopoverButton>
      {texty && (
        <>
          <Divider />
          <TextTools doc={doc} />
        </>
      )}
      {selection.length > 0 && (
        <>
          <Divider />
          <ShapeTools doc={doc} />
        </>
      )}
      {selection.length === 1 && selection[0].kind === 'table' && (
        <>
          <Divider />
          <TableTools doc={doc} />
        </>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-2">
        <PopoverButton label="Background" align="right" panel={(close) => <BackgroundPanel doc={doc} onDone={close} />}>
          <IconBackground />
        </PopoverButton>
        <PopoverButton label="Theme" align="right" className="text-[12px]" panel={(close) => <ThemeGrid deck={deck} onPick={(theme) => (commands.applyTheme(theme), close())} />}>
          <span className="flex items-center gap-1.5 pr-0.5">
            <span className="flex">
              {(['accent1', 'accent2', 'accent3'] as const).map((slot) => (
                <span key={slot} className="-mr-1 size-3 rounded-full ring-1 ring-black/20" style={{ background: deck.theme.colors[slot] }} />
              ))}
            </span>
            <span className="ml-1">{deck.theme.name}</span>
            <IconChevronDown size={12} />
          </span>
        </PopoverButton>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => commands.present(false)}
          className="ml-1 flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[12px] font-medium text-accent-fg hover:bg-accent-strong"
        >
          <IconPlayerPlay size={14} /> Present
        </button>
      </div>
    </div>
  )
}
