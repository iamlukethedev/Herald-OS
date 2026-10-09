import { useStore } from '@nanostores/react'
import { IconBackground, IconForms, IconLayersSubtract, IconPalette, IconPencil, IconPhotoPlus, IconRestore, IconTemplate, IconX } from '@tabler/icons-react'
import { type ReactNode, useRef, useState } from 'react'
import { cn } from '../../../../lib/cn.ts'
import type { SlidesDocument } from '../document.ts'
import { layoutOf, masterOf } from '../layouts.ts'
import type { LogoCorner } from '../model.ts'
import { BackgroundPanel } from './BackgroundPanel.tsx'
import * as commands from './commands.ts'
import { HeaderFooterDialog } from './HeaderFooterDialog.tsx'
import { $slidesDialog, closeSlidesDialog, insertLogo, layoutInFront, openHeaderFooter, renameLayoutInFront, resetDeckMaster, showMasterView, toggleBackgroundGraphics } from './master-commands.ts'
import { PopoverButton } from './pickers.tsx'
import { useDeck } from './Stage.tsx'
import { ThemeEditor } from './ThemeEditor.tsx'
import { ThemePanel } from './ThemePanel.tsx'

/*
 * The bar over the slide in the master view: what goes on the master (a logo, its background, the
 * header and footer, the theme) and on the layout in front (its background, whether it shows the
 * master's drawings, its name), putting Herald's master back, and the way out of the view. Also the
 * dialogs the bar, the panels and the menus open, mounted once in the window.
 */

const CORNERS: { corner: LogoCorner; name: string; place: string }[] = [
  { corner: 'top-left', name: 'Top left', place: 'items-start justify-start' },
  { corner: 'top-right', name: 'Top right', place: 'items-start justify-end' },
  { corner: 'bottom-left', name: 'Bottom left', place: 'items-end justify-start' },
  { corner: 'bottom-right', name: 'Bottom right', place: 'items-end justify-end' }
]

const Divider = () => <span className="mx-1 h-5 w-px shrink-0 bg-line" />

function BarButton({ label, onClick, active, disabled, children }: { label: string; onClick: () => void; active?: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn('flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 whitespace-nowrap text-fg-2 hover:bg-white/8 hover:text-fg disabled:opacity-40 [&_svg]:size-4', active && 'bg-white/12 text-fg')}
    >
      {children}
    </button>
  )
}

function LogoPanel({ doc, onDone }: { doc: SlidesDocument; onDone: () => void }) {
  const [corner, setCorner] = useState<LogoCorner>('top-right')
  const [layoutOnly, setLayoutOnly] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const layout = layoutInFront(doc)

  return (
    <div className="flex w-[220px] flex-col gap-3 text-[12px] text-fg-2">
      <div className="text-[11px] font-medium tracking-wide text-fg-3 uppercase">Corner</div>
      <div role="radiogroup" aria-label="Corner" className="grid aspect-video grid-cols-2 grid-rows-2 gap-1 rounded-md border border-line p-1">
        {CORNERS.map(({ corner: at, name, place }) => (
          <button key={at} type="button" role="radio" aria-checked={corner === at} aria-label={name} title={name} onClick={() => setCorner(at)} className={cn('flex rounded-[3px] p-1.5 hover:bg-white/8', place, corner === at && 'bg-accent/15')}>
            <span className={cn('h-2.5 w-4 rounded-[2px]', corner === at ? 'bg-accent' : 'bg-fg-4')} />
          </button>
        ))}
      </div>
      {layout && (
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={layoutOnly} onChange={(event) => setLayoutOnly(event.target.checked)} />
          Only on the {layoutOf(masterOf(doc.presentation), layout).name} layout
        </label>
      )}
      <button type="button" onClick={() => file.current?.click()} className="h-8 rounded-md border border-line hover:bg-white/8">
        Choose Picture…
      </button>
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const picked = event.target.files?.[0]
          event.target.value = ''

          if (picked) {
            insertLogo(picked, { corner, ...(layout && layoutOnly ? { layoutId: layout } : {}) }, doc).then(onDone, () => commands.notify('Herald Slides could not read that picture'))
          }
        }}
      />
    </div>
  )
}

function RenamePanel({ doc, onDone }: { doc: SlidesDocument; onDone: () => void }) {
  const layout = layoutInFront(doc)
  const [name, setName] = useState(() => (layout ? layoutOf(masterOf(doc.presentation), layout).name : ''))

  return (
    <form
      className="flex w-[240px] items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        renameLayoutInFront(name, doc)
        onDone()
      }}
    >
      <input autoFocus value={name} onChange={(event) => setName(event.target.value)} aria-label="Layout name" className="glass-input h-7 min-w-0 flex-1 rounded-md px-2 text-[12px] text-fg outline-none" />
      <button type="submit" className="h-7 rounded-md bg-accent px-2.5 text-[12px] font-medium text-accent-fg hover:bg-accent-strong">
        Rename
      </button>
    </form>
  )
}

function ResetPanel({ doc, onDone }: { doc: SlidesDocument; onDone: () => void }) {
  return (
    <div className="flex w-[260px] flex-col gap-2.5 text-[12px] text-fg-2">
      <p>Put Herald’s master and layouts back in place of this deck’s? Slides keep what they say; what was added to the master and layouts goes.</p>
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onDone} className="h-7 rounded-md px-2.5 hover:bg-white/8 hover:text-fg">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            resetDeckMaster(doc)
            onDone()
          }}
          className="h-7 rounded-md bg-danger/15 px-2.5 text-danger hover:bg-danger/25"
        >
          Reset Master
        </button>
      </div>
    </div>
  )
}

export function MasterBar({ doc }: { doc: SlidesDocument }) {
  useDeck(doc)
  const layout = layoutInFront(doc)
  const own = layout ? layoutOf(masterOf(doc.presentation), layout) : null

  return (
    <div data-slides-keep-editing="" className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line bg-accent/6 px-2 text-[12px]">
      <span className="flex shrink-0 items-center gap-1.5 px-1.5 font-medium text-fg">
        <IconTemplate size={15} className="text-accent-strong" /> Slide Master
      </span>
      <span className="max-w-44 shrink-0 truncate px-1 text-fg-3">{own ? `${own.name} Layout` : 'Every slide'}</span>
      <Divider />
      <PopoverButton label="Insert Logo…" className="shrink-0 whitespace-nowrap" panel={(close) => <LogoPanel doc={doc} onDone={close} />}>
        <IconPhotoPlus /> Insert Logo…
      </PopoverButton>
      <PopoverButton label="Background" className="shrink-0 whitespace-nowrap" panel={(close) => <BackgroundPanel doc={doc} onDone={close} />}>
        <IconBackground /> Background
      </PopoverButton>
      <BarButton label="Hide Background Graphics" active={Boolean(own && !own.showMaster)} disabled={!own} onClick={() => toggleBackgroundGraphics(doc)}>
        <IconLayersSubtract /> Hide Background Graphics
      </BarButton>
      <PopoverButton label="Rename Layout" className="shrink-0 whitespace-nowrap" disabled={!own} panel={(close) => <RenamePanel doc={doc} onDone={close} />}>
        <IconPencil /> Rename Layout
      </PopoverButton>
      <Divider />
      <BarButton label="Header & Footer…" onClick={() => openHeaderFooter(doc)}>
        <IconForms /> Header & Footer…
      </BarButton>
      <PopoverButton label="Theme" className="shrink-0 whitespace-nowrap" panel={(close) => <ThemePanel doc={doc} onDone={close} />}>
        <IconPalette /> Theme
      </PopoverButton>
      <PopoverButton label="Reset Master" className="shrink-0 whitespace-nowrap" panel={(close) => <ResetPanel doc={doc} onDone={close} />}>
        <IconRestore /> Reset Master
      </PopoverButton>
      <div className="ml-auto flex shrink-0 items-center pl-2">
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => showMasterView(false, doc)}
          className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 whitespace-nowrap text-[12px] font-medium text-accent-fg hover:bg-accent-strong"
        >
          <IconX size={14} /> Close Master View
        </button>
      </div>
    </div>
  )
}

/** The theme editor or the header and footer dialog, whichever is open; mounted once in the window, outside its editors. */
export function SlidesDialogs() {
  const dialog = useStore($slidesDialog)

  if (dialog?.kind === 'theme') {
    return <ThemeEditor doc={dialog.doc} theme={dialog.theme} fresh={dialog.fresh} scope={dialog.scope} onClose={closeSlidesDialog} />
  }

  return dialog?.kind === 'header-footer' ? <HeaderFooterDialog doc={dialog.doc} onClose={closeSlidesDialog} /> : null
}
