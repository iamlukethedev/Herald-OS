import { useStore } from '@nanostores/react'
import { IconBackspace } from '@tabler/icons-react'
import { type RefObject, useEffect, useRef, useState } from 'react'
import type { EvalResult } from '../engine/index.ts'
import { ConstantsMenu } from './ConstantsMenu.tsx'
import { Display } from './Display.tsx'
import type { Angle } from './expression.ts'
import { formatEntry, formatNumber, numberSymbols } from './format.ts'
import { Key } from './Key.tsx'
import { CLASSIC_GRID, CLASSIC_MEMORY, CONSTANTS_SLOT, DECIMAL_KEYS, decimalKeyFor, type KeySound, SCIENTIFIC_GRID, soundOf } from './keys.ts'
import { clearLabel, type DecimalKey, pendingOperator, pendingText, previewExpression, shown } from './machine.ts'
import { $keypad, pressKeypad } from './store.ts'
import { useEvaluation } from './use-evaluation.ts'
import { useFlash, useKeypadKeyboard } from './use-keyboard.ts'

type KeySize = 'main' | 'scientific' | 'memory'

const SIZES: Record<KeySize, string> = {
  main: 'text-[22px] font-normal @min-[40rem]:text-[24px]',
  scientific: 'rounded-md text-[13px] font-medium @min-[40rem]:text-[14px]',
  memory: 'rounded-md text-[12.5px] font-semibold tracking-wide'
}

/** A random decimal in [0, 1) for Rand. */
function randomDecimal(): string {
  return Math.random().toFixed(15).replace(/\.?0+$/, '') || '0'
}

/** An answer as the display shows it: a number in the locale, anything else as the engine wrote it. */
function answerText(answer: EvalResult, locale?: string): string {
  return answer.value?.kind === 'number' ? formatNumber(answer.value.exact, { locale }) : (answer.display ?? answer.value?.exact ?? '')
}

export interface DecimalPadProps {
  scientific: boolean
  active: boolean
  angle: Angle
  onAngle: (angle: Angle) => void
  locale?: string
  reduced: boolean
  sound: (sound: KeySound) => void
  root: RefObject<HTMLElement | null>
}

/** The classic keypad, and the scientific one around it. */
export function DecimalPad({ scientific, active, angle, onAngle, locale, reduced, sound, root }: DecimalPadProps) {
  const state = useStore($keypad)
  const [menuOpen, setMenuOpen] = useState(false)
  const [flash, flashKey] = useFlash()
  const lastText = useRef('0')
  const decimalMark = numberSymbols(locale).decimal
  const view = shown(state)
  const answer = useEvaluation(view.type === 'expression' ? view.expression : null)
  const preview = useEvaluation(previewExpression(state))
  const clear = clearLabel(state)
  const waiting = pendingOperator(state)

  let text = lastText.current
  let error: string | null = null

  if (view.type === 'entry') {
    text = formatEntry(view.text, locale)
  } else if (view.type === 'value') {
    text = formatNumber(view.value, { locale })
  } else if (answer?.ok) {
    text = answerText(answer, locale)
  } else if (answer) {
    text = 'Error'
    error = answer.error ?? null
  }

  const previewText = preview?.ok ? answerText(preview, locale) : null
  const exactShown = view.type === 'value' ? view.value : answer?.ok && answer.value?.kind === 'number' ? answer.value.exact : null

  useEffect(() => {
    lastText.current = text
  })

  useEffect(() => {
    if (!scientific) {
      setMenuOpen(false)
    }
  }, [scientific])

  const pressKey = (key: DecimalKey) => {
    sound(soundOf(DECIMAL_KEYS.get(key)?.tone ?? 'digit'))
    pressKeypad(key, { angle, random: key === 'rand' ? randomDecimal() : undefined, shown: exactShown })
  }

  useKeypadKeyboard(active, root, key => {
    if (menuOpen && key === 'Escape') {
      setMenuOpen(false)

      return true
    }

    const mapped = decimalKeyFor(key, decimalMark)

    if (!mapped) {
      return false
    }

    pressKey(mapped)
    flashKey(mapped)

    return true
  })

  const renderKey = (key: DecimalKey | typeof CONSTANTS_SLOT, size: KeySize) => {
    if (key === CONSTANTS_SLOT) {
      return <ConstantsMenu key={key} open={menuOpen} onOpenChange={setMenuOpen} onPick={id => pressKey(id)} locale={locale} reduced={reduced} className={SIZES[size]} />
    }

    const def = DECIMAL_KEYS.get(key)

    if (!def) {
      return null
    }

    const second = state.second ? def.second : undefined
    const label = key === 'clear' ? clear : key === 'decimal' ? decimalMark : key === 'backspace' ? <IconBackspace size={22} stroke={1.6} /> : (second?.label ?? def.label)
    const aria = key === 'clear' ? (clear === 'C' ? 'Clear' : 'All clear') : (second?.aria ?? def.aria)

    return (
      <Key
        key={key}
        keyId={key}
        label={label}
        aria={aria}
        tone={def.tone}
        onPress={() => pressKey(key)}
        flash={flash === key}
        selected={(key === 'second' && state.second) || key === waiting}
        disabled={(key === 'memory-recall' || key === 'memory-clear') && state.memory === null}
        reduced={reduced}
        className={SIZES[size]}
      />
    )
  }

  const badges =
    scientific || state.memory !== null ? (
      <>
        {scientific && (
          <button
            type="button"
            aria-label={angle === 'deg' ? 'Angles in degrees; switch to radians' : 'Angles in radians; switch to degrees'}
            title={angle === 'deg' ? 'Degrees' : 'Radians'}
            onClick={() => onAngle(angle === 'deg' ? 'rad' : 'deg')}
            className="rounded-md border border-line px-1.5 text-[11px] leading-[18px] font-semibold tracking-wide text-fg-2 hover:bg-white/8 hover:text-fg"
          >
            {angle === 'deg' ? 'DEG' : 'RAD'}
          </button>
        )}
        {state.memory !== null && (
          <span title={`Memory: ${formatNumber(state.memory, { locale })}`} className="rounded-md bg-accent-soft px-1.5 text-[11px] leading-5 font-semibold text-accent-strong">
            M
          </span>
        )}
      </>
    ) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Display label="Result" pending={pendingText(state, locale)} preview={previewText !== text ? previewText : null} error={error} text={text} reduced={reduced} badges={badges} />
      {scientific ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 @min-[40rem]:flex-row">
          <div className="grid min-h-0 flex-[5] grid-cols-6 grid-rows-5 gap-1.5 @min-[40rem]:flex-[6] @min-[40rem]:gap-2">{SCIENTIFIC_GRID.flat().map(key => renderKey(key, 'scientific'))}</div>
          <div className="grid min-h-0 flex-[6] grid-cols-4 grid-rows-5 gap-2 @min-[40rem]:flex-[4]">{CLASSIC_GRID.flat().map(key => renderKey(key, 'main'))}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="grid h-8 shrink-0 grid-cols-4 gap-2">{CLASSIC_MEMORY.map(key => renderKey(key, 'memory'))}</div>
          <div className="grid min-h-0 flex-1 grid-cols-4 grid-rows-5 gap-2">{CLASSIC_GRID.flat().map(key => renderKey(key, 'main'))}</div>
        </div>
      )}
    </div>
  )
}
