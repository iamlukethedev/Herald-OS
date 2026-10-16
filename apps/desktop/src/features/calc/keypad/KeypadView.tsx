import { useStore } from '@nanostores/react'
import { IconVolume, IconVolumeOff } from '@tabler/icons-react'
import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react'
import { CALC_PREFS_DEFAULTS, type CalcKeypad } from '../../../../shared/calc.ts'
import { cn } from '../../../lib/cn.ts'
import { logFailure } from '../../../lib/report.ts'
import { $prefs, updatePrefs } from '../../../store/backend.ts'
import { $locale } from '../../../store/i18n.ts'
import { useReducedMotion } from '../../pet/hooks.ts'
import { recordCalc } from '../history/store.ts'
import { DecimalPad } from './DecimalPad.tsx'
import { type Angle, expressionOf, sequenceText } from './expression.ts'
import { formatNumber } from './format.ts'
import type { KeySound } from './keys.ts'
import { ProgrammerPad } from './ProgrammerPad.tsx'
import { programmerHistoryInput, wordLiteral } from './programmer-machine.ts'
import { Segmented } from './Segmented.tsx'
import { playKeySound } from './sounds.ts'
import { $keypad, $programmer, claimEquals, resolveKeypad } from './store.ts'
import { evaluateExpression } from './use-evaluation.ts'
import { isTyping } from './use-keyboard.ts'

const MODES = [
  { id: 'classic', label: 'Classic' },
  { id: 'scientific', label: 'Scientific' },
  { id: 'programmer', label: 'Programmer' }
] as const

export interface KeypadViewProps {
  /** The view is on screen: it takes the keyboard. */
  active: boolean
  className?: string
}

/** Each '=' once: the engine's exact value back into the keypad, and the calculation into the history. */
function useResults(locale?: string): void {
  const last = useStore($keypad).last
  const lastWord = useStore($programmer).last

  useEffect(() => {
    if (!last || !claimEquals('keypad', last.id)) {
      return
    }

    const expression = expressionOf(last.items)
    const input = sequenceText(last.items, locale)

    if (!expression) {
      return
    }

    void evaluateExpression(expression).then(answer => {
      if (!answer.ok) {
        return
      }

      const exact = answer.value?.kind === 'number' ? answer.value.exact : null

      if (exact !== null) {
        resolveKeypad(last.id, exact)
      }

      recordCalc({ input, result: exact === null ? (answer.display ?? '') : formatNumber(exact, { locale }), source: 'keypad' })
    })
  }, [last, locale])

  useEffect(() => {
    if (!lastWord || !claimEquals('programmer', lastWord.id)) {
      return
    }

    const state = $programmer.get()
    recordCalc({ input: programmerHistoryInput(state, lastWord.items), result: wordLiteral(lastWord.value, state), source: 'keypad' })
  }, [lastWord])
}

/** Herald Calc's keypads: classic, scientific and programmer, with the exact engine behind them. */
export function KeypadView({ active, className }: KeypadViewProps) {
  const prefs = useStore($prefs)
  const calc = prefs.calc ?? CALC_PREFS_DEFAULTS
  const locale = useStore($locale)
  const reduced = useReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)
  // Choices show at once; the saved prefs take over once main has them.
  const [modeChoice, setModeChoice] = useState<CalcKeypad | null>(null)
  const [angleChoice, setAngleChoice] = useState<Angle | null>(null)
  const [soundsChoice, setSoundsChoice] = useState<boolean | null>(null)
  const mode = modeChoice ?? calc.keypad
  const angle = angleChoice ?? calc.angle
  const sounds = soundsChoice ?? calc.sounds

  useResults(locale)

  useEffect(() => {
    const root = rootRef.current

    if (active && root && !isTyping(document.activeElement) && !root.contains(document.activeElement)) {
      root.focus({ preventScroll: true })
    }
  }, [active])

  const sound = useCallback(
    (kind: KeySound) => {
      if (sounds) {
        playKeySound(kind)
      }
    },
    [sounds]
  )

  const chooseMode = (keypad: CalcKeypad) => {
    setModeChoice(keypad)
    void updatePrefs({ calc: { keypad } })
      .catch(logFailure('prefs.calc.keypad'))
      .finally(() => setModeChoice(current => (current === keypad ? null : current)))
  }

  const chooseAngle = (next: Angle) => {
    setAngleChoice(next)
    void updatePrefs({ calc: { angle: next } })
      .catch(logFailure('prefs.calc.angle'))
      .finally(() => setAngleChoice(current => (current === next ? null : current)))
  }

  const toggleSounds = () => {
    const next = !sounds
    setSoundsChoice(next)
    void updatePrefs({ calc: { sounds: next } })
      .catch(logFailure('prefs.calc.sounds'))
      .finally(() => setSoundsChoice(current => (current === next ? null : current)))
  }

  // Keys never take focus: the keypad keeps it, so Enter is always '='.
  const keepFocus = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault()

    if (document.activeElement !== rootRef.current) {
      rootRef.current?.focus({ preventScroll: true })
    }
  }

  return (
    <div ref={rootRef} role="group" aria-label="Keypad" tabIndex={-1} onMouseDown={keepFocus} className={cn('flex h-full min-h-0 flex-col gap-3 p-3 outline-none select-none [container-type:size]', className)}>
      <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2">
        <span />
        <Segmented<CalcKeypad> label="Keypad" items={MODES} value={mode} onChange={chooseMode} />
        <button
          type="button"
          aria-label={sounds ? 'Key sounds on; turn them off' : 'Key sounds off; turn them on'}
          aria-pressed={sounds}
          title={sounds ? 'Key sounds on' : 'Key sounds off'}
          onClick={toggleSounds}
          className="flex size-7 items-center justify-center justify-self-end rounded-lg text-fg-3 hover:bg-white/8 hover:text-fg"
        >
          {sounds ? <IconVolume size={16} stroke={1.7} /> : <IconVolumeOff size={16} stroke={1.7} />}
        </button>
      </div>
      {mode === 'programmer' ? (
        <ProgrammerPad active={active} locale={locale} reduced={reduced} sound={sound} root={rootRef} />
      ) : (
        <DecimalPad scientific={mode === 'scientific'} active={active} angle={angle} onAngle={chooseAngle} locale={locale} reduced={reduced} sound={sound} root={rootRef} />
      )}
    </div>
  )
}
