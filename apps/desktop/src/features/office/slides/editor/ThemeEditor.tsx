import { IconAlertTriangle } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import { GlassButton } from '../../../../components/ui/glass.tsx'
import { cn } from '../../../../lib/cn.ts'
import { messageOf } from '../../../canvas/errors.ts'
import { Modal } from '../../shell/dialogs.tsx'
import { type Background, type Slot, SLOTS, type Theme } from '../deck.ts'
import type { SlidesDocument } from '../document.ts'
import { $customThemes, saveCustomTheme } from '../theme-store.ts'
import { COMMON_FONTS, editTheme, fontStack, isSlot, luminance, normalHex, SLOT_NAMES } from '../themes.ts'
import { SlideView } from '../view/SlideView.tsx'
import * as commands from './commands.ts'
import { applyThemeTo, type ThemeScope } from './master-commands.ts'
import { contentSample, titleSample } from './ThemePanel.tsx'

/*
 * A custom theme made or changed: its name, its ten colours, its fonts and, if wanted, a gradient
 * between two of its colours behind every slide, drawn on two sample slides as it is edited, with a
 * warning where text would be hard to read. Saved, it goes among the custom themes and onto the
 * deck (or the picked slides).
 */

/** A two-stop gradient between theme colours, as the editor offers one. */
interface TwoStops {
  from: Slot
  to: Slot
  angle: number
  radial: boolean
}

type BackgroundChoice = 'none' | 'gradient' | 'kept'

const BACKGROUND_LABELS: Record<BackgroundChoice, string> = { none: 'None', gradient: 'Gradient', kept: 'As it is' }

const FONTS_LIST = 'hs-theme-fonts'

/** The theme's background as two stops between its colours, when it is one. */
function twoStopsOf(background: Background | undefined): TwoStops | null {
  if (background?.kind !== 'gradient' || background.stops.length !== 2) {
    return null
  }

  const [from, to] = background.stops

  return isSlot(from.color) && isSlot(to.color) && (from.alpha ?? 1) === 1 && (to.alpha ?? 1) === 1 ? { from: from.color, to: to.color, angle: background.angle, radial: Boolean(background.radial) } : null
}

/** How far apart two colours read, from 1:1 to 21:1. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)

  return (light + 0.05) / (dark + 0.05)
}

function ColourRow({ slot, value, onChange }: { slot: Slot; value: string; onChange: (value: string) => void }) {
  const hex = normalHex(value)

  return (
    <div className="flex items-center gap-2">
      <input type="color" value={hex ?? '#000000'} onChange={(event) => onChange(event.target.value)} aria-label={`${SLOT_NAMES[slot]} colour`} className="h-6 w-7 shrink-0 cursor-pointer rounded border border-line bg-transparent p-0" />
      <span className="min-w-0 flex-1 truncate">{SLOT_NAMES[slot]}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        aria-label={`${SLOT_NAMES[slot]} as #rrggbb`}
        aria-invalid={!hex}
        className={cn('glass-input h-6 w-[76px] rounded-md px-1.5 font-mono text-[11.5px] text-fg outline-none', !hex && 'ring-1 ring-danger')}
      />
    </div>
  )
}

function FontField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-fg-3">{label}</span>
      <input list={FONTS_LIST} value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} className="glass-input h-7 rounded-md px-2 text-[12.5px] text-fg outline-none" style={{ fontFamily: fontStack(value.trim() || 'Helvetica Neue') }} />
    </label>
  )
}

function SlotPicker({ label, value, theme, onPick }: { label: string; value: Slot; theme: Theme; onPick: (slot: Slot) => void }) {
  return (
    <div role="radiogroup" aria-label={`Gradient ${label.toLowerCase()}`} className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-fg-3">{label}</span>
      <div className="flex gap-1">
        {SLOTS.map((slot) => (
          <button
            key={slot}
            type="button"
            role="radio"
            aria-checked={value === slot}
            aria-label={SLOT_NAMES[slot]}
            title={SLOT_NAMES[slot]}
            onClick={() => onPick(slot)}
            className={cn('size-5 rounded-[4px] border border-black/15', value === slot && 'ring-2 ring-accent ring-offset-1 ring-offset-transparent')}
            style={{ background: theme.colors[slot] }}
          />
        ))}
      </div>
    </div>
  )
}

export function ThemeEditor({ doc, theme: base, fresh, scope: asked, onClose }: { doc: SlidesDocument; theme: Theme; fresh: boolean; scope: ThemeScope; onClose: () => void }) {
  const [name, setName] = useState(() => (fresh ? `Custom ${$customThemes.get().length + 1}` : base.name))
  const [colors, setColors] = useState<Record<Slot, string>>(() => ({ ...base.colors }))
  const [fonts, setFonts] = useState(() => ({ ...base.fonts }))
  const [choice, setChoice] = useState<BackgroundChoice>(() => (!base.background ? 'none' : twoStopsOf(base.background) ? 'gradient' : 'kept'))
  const [stops, setStops] = useState<TwoStops>(() => twoStopsOf(base.background) ?? { from: 'bg2', to: 'bg1', angle: 90, radial: false })
  const [scope, setScope] = useState<ThemeScope>(doc.mode === 'slides' ? asked : 'all')
  const [saving, setSaving] = useState(false)
  const size = doc.presentation.size
  const choices: BackgroundChoice[] = base.background && !twoStopsOf(base.background) ? ['none', 'gradient', 'kept'] : ['none', 'gradient']
  const invalid = SLOTS.some((slot) => !normalHex(colors[slot]))

  const theme = useMemo(() => {
    const background: Background | null | undefined =
      choice === 'none' ? null : choice === 'kept' ? undefined : { kind: 'gradient', stops: [{ at: 0, color: stops.from }, { at: 1, color: stops.to }], angle: stops.angle, ...(stops.radial ? { radial: true } : {}) }

    return editTheme(base, { name, colors: Object.fromEntries(SLOTS.filter((slot) => normalHex(colors[slot])).map((slot) => [slot, colors[slot]])), fonts, background })
  }, [base, name, colors, fonts, choice, stops])

  const view = useMemo(() => ({ size, theme }), [size, theme])
  const samples = useMemo(() => [titleSample(theme, size), contentSample(theme, size)], [theme, size])

  // Text reads well at 4.5:1 or more on each background: the two background colours, and the gradient's stops.
  const hard = useMemo(() => {
    const backgrounds = [...new Set<Slot>(['bg1', 'bg2', ...(choice === 'gradient' ? [stops.from, stops.to] : [])])]

    return (['tx1', 'tx2'] as const).flatMap((text) =>
      backgrounds.flatMap((back) => {
        const ratio = contrast(theme.colors[text], theme.colors[back])

        return ratio < 4.5 ? [`${SLOT_NAMES[text]} on ${SLOT_NAMES[back]}${back === 'bg1' || back === 'bg2' ? '' : ' (in the gradient)'} reads at ${ratio.toFixed(1)}:1`] : []
      })
    )
  }, [theme, choice, stops])

  const save = () => {
    setSaving(true)
    saveCustomTheme(fresh ? { ...theme, id: 'new' } : theme).then(
      (saved) => {
        applyThemeTo(saved, scope, doc)
        onClose()
      },
      (error: unknown) => {
        setSaving(false)
        commands.notify(`Herald Slides could not save the theme: ${messageOf(error)}`)
      }
    )
  }

  return (
    <Modal title={fresh ? 'New Theme' : `Edit Theme “${base.name}”`} onClose={onClose}>
      <div className="-mx-1 flex max-h-[62vh] flex-col gap-3.5 overflow-y-auto px-1 text-[12px] text-fg-2">
        <label className="flex items-center gap-2">
          <span className="w-10 shrink-0 text-fg-3">Name</span>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} className="glass-input h-7 min-w-0 flex-1 rounded-md px-2 text-[12.5px] text-fg outline-none" />
        </label>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          {SLOTS.map((slot) => (
            <ColourRow key={slot} slot={slot} value={colors[slot]} onChange={(value) => setColors((now) => ({ ...now, [slot]: value }))} />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <FontField label="Heading font" value={fonts.heading} onChange={(heading) => setFonts((now) => ({ ...now, heading }))} />
          <FontField label="Body font" value={fonts.body} onChange={(body) => setFonts((now) => ({ ...now, body }))} />
          <datalist id={FONTS_LIST}>
            {COMMON_FONTS.map((font) => (
              <option key={font} value={font} />
            ))}
          </datalist>
        </div>
        <div className="flex flex-col gap-2">
          <div role="radiogroup" aria-label="Background" className="flex items-center gap-3">
            <span className="w-[72px] shrink-0 text-fg-3">Background</span>
            {choices.map((value) => (
              <label key={value} className="flex items-center gap-1.5">
                <input type="radio" name="hs-theme-background" checked={choice === value} onChange={() => setChoice(value)} />
                {BACKGROUND_LABELS[value]}
              </label>
            ))}
          </div>
          {choice === 'gradient' && (
            <div className="flex flex-col gap-1.5">
              <SlotPicker label="From" value={stops.from} theme={theme} onPick={(from) => setStops((now) => ({ ...now, from }))} />
              <SlotPicker label="To" value={stops.to} theme={theme} onPick={(to) => setStops((now) => ({ ...now, to }))} />
              <div className="flex items-center gap-2">
                <span className="w-10 shrink-0 text-fg-3">Angle</span>
                <input
                  type="number"
                  min={0}
                  max={359}
                  step={15}
                  value={stops.angle}
                  onChange={(event) => {
                    const angle = event.target.valueAsNumber

                    if (Number.isFinite(angle)) {
                      setStops((now) => ({ ...now, angle: ((Math.round(angle) % 360) + 360) % 360 }))
                    }
                  }}
                  aria-label="Angle in degrees"
                  className="glass-input h-6 w-16 rounded-md px-1.5 text-[12px] text-fg tabular-nums outline-none"
                />
                <span className="text-fg-3">degrees</span>
                <label className="ml-3 flex items-center gap-1.5">
                  <input type="checkbox" checked={stops.radial} onChange={(event) => setStops((now) => ({ ...now, radial: event.target.checked }))} />
                  From the middle
                </label>
              </div>
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {samples.map((slide, index) => (
            <SlideView key={index} deck={view} slide={slide} scale={192 / size.width} mode="thumb" className="pointer-events-none rounded-[3px] ring-1 ring-black/10" />
          ))}
        </div>
        {hard.length > 0 && (
          <div className="flex gap-2 rounded-lg bg-warn/10 px-2.5 py-2 text-[11.5px]">
            <IconAlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
            <span>Text may be hard to read (4.5:1 or more reads well): {hard.join('; ')}.</span>
          </div>
        )}
      </div>
      <div className="mt-4 flex items-center gap-2">
        {doc.mode === 'slides' && (
          <select value={scope} onChange={(event) => setScope(event.target.value as ThemeScope)} aria-label="Where the theme goes" className="glass-input h-8 rounded-md px-2 text-[12px] text-fg outline-none">
            <option value="all">Apply to all slides</option>
            <option value="selected">Apply to selected slides</option>
          </select>
        )}
        <span className="flex-1" />
        <GlassButton variant="ghost" onClick={onClose}>
          Cancel
        </GlassButton>
        <GlassButton variant="primary" disabled={saving || invalid} onClick={save}>
          Save
        </GlassButton>
      </div>
    </Modal>
  )
}
