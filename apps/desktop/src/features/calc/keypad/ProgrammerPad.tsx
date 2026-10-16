import { useStore } from '@nanostores/react'
import { IconBackspace } from '@tabler/icons-react'
import type { RefObject } from 'react'
import { cn } from '../../../lib/cn.ts'
import { BitGrid } from './BitGrid.tsx'
import { Display } from './Display.tsx'
import { Key } from './Key.tsx'
import { type KeySound, PROGRAMMER_GRID, PROGRAMMER_KEYS, programmerKeyFor, soundOf } from './keys.ts'
import { BASES, type Base, digitValue, WORD_SIZES, type WordSize } from './programmer.ts'
import { flipBit, pendingWordOperator, previewWord, programmerClearLabel, programmerPendingText, type ProgrammerKey, setBase, setSigned, setWordSize, shownWord, wordText } from './programmer-machine.ts'
import { DECIMAL_DIGITS, HEX_DIGITS } from './rolling.ts'
import { RollingNumber } from './RollingNumber.tsx'
import { Segmented } from './Segmented.tsx'
import { $programmer, pressProgrammer, updateProgrammer } from './store.ts'
import { useFlash, useKeypadKeyboard } from './use-keyboard.ts'

const BASE_NAMES: Record<Base, string> = { hex: 'Hexadecimal', dec: 'Decimal', oct: 'Octal', bin: 'Binary' }
const WORD_ITEMS = WORD_SIZES.map(bits => ({ id: bits, label: String(bits), title: `${bits}-bit words` }))
const SIGN_ITEMS = [
  { id: 'signed', label: 'Signed', title: "Two's complement" },
  { id: 'unsigned', label: 'Unsigned' }
] as const

export interface ProgrammerPadProps {
  active: boolean
  locale?: string
  reduced: boolean
  sound: (sound: KeySound) => void
  root: RefObject<HTMLElement | null>
}

/** Integers in 8 to 64 bits: four bases at once, the bits to click, and the bitwise operators. */
export function ProgrammerPad({ active, locale, reduced, sound, root }: ProgrammerPadProps) {
  const state = useStore($programmer)
  const [flash, flashKey] = useFlash()
  const value = shownWord(state)
  const preview = previewWord(state)
  const failed = state.error !== null || value === null
  const text = failed ? 'Error' : wordText(value, state, locale)
  const previewText = preview === null ? null : wordText(preview, state, locale)
  const clear = programmerClearLabel(state)
  const waiting = pendingWordOperator(state)

  const pressKey = (key: ProgrammerKey) => {
    sound(soundOf(PROGRAMMER_KEYS.get(key)?.tone ?? 'digit'))
    pressProgrammer(key)
  }

  useKeypadKeyboard(active, root, key => {
    const mapped = programmerKeyFor(key, state.base)

    if (!mapped) {
      return false
    }

    pressKey(mapped)
    flashKey(mapped)

    return true
  })

  const top = (
    <>
      <Segmented<WordSize> label="Word size" size="sm" items={WORD_ITEMS} value={state.word.bits} onChange={bits => updateProgrammer(current => setWordSize(current, bits))} />
      <Segmented label="Sign" size="sm" items={SIGN_ITEMS} value={state.word.signed ? 'signed' : 'unsigned'} onChange={id => updateProgrammer(current => setSigned(current, id === 'signed'))} />
    </>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
      <Display
        label="Result"
        pending={programmerPendingText(state)}
        preview={previewText !== text ? previewText : null}
        error={state.error ?? (value === null ? "Can't divide by zero" : null)}
        text={text}
        alphabet={state.base === 'hex' ? HEX_DIGITS : DECIMAL_DIGITS}
        reduced={reduced}
        top={top}
        big={false}
      >
        <div role="radiogroup" aria-label="Base" className="mt-1 flex flex-col gap-px">
          {BASES.map(base => {
            const on = base === state.base
            const digits = value === null ? '' : wordText(value, { base, word: state.word }, locale)

            return (
              <button
                key={base}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={`${BASE_NAMES[base]} ${digits}`}
                onClick={() => updateProgrammer(current => setBase(current, base))}
                className={cn('flex items-baseline gap-3 rounded-md px-1.5 py-px text-left transition-colors duration-100', on ? 'bg-accent-soft text-fg' : 'text-fg-3 hover:bg-white/6 hover:text-fg-2')}
              >
                <span className={cn('w-8 shrink-0 text-[10.5px] font-semibold tracking-wider', on ? 'text-accent-strong' : 'text-fg-4')}>{base.toUpperCase()}</span>
                {on ? (
                  <span className="min-w-0 flex-1 font-mono text-[22px] leading-[30px] font-light break-words tabular-nums">
                    <RollingNumber text={digits} alphabet={base === 'hex' ? HEX_DIGITS : DECIMAL_DIGITS} reduced={reduced} />
                  </span>
                ) : (
                  <span className="min-w-0 flex-1 font-mono text-[12px] leading-[18px] break-words tabular-nums">{digits}</span>
                )}
              </button>
            )
          })}
        </div>
      </Display>
      <BitGrid value={value ?? 0n} bits={state.word.bits} onToggle={index => updateProgrammer(current => flipBit(current, index))} className="[@container(max-height:600px)]:hidden" />
      <div className="grid min-h-56 flex-1 grid-cols-6 grid-rows-[repeat(7,minmax(1.75rem,1fr))] gap-1.5">
        {PROGRAMMER_GRID.flat().map(key => {
          const def = PROGRAMMER_KEYS.get(key)

          if (!def) {
            return null
          }

          const digit = key.length === 1
          const label = key === 'clear' ? clear : key === 'backspace' ? <IconBackspace size={20} stroke={1.6} /> : def.label

          return (
            <Key
              key={key}
              keyId={key}
              label={label}
              aria={key === 'clear' ? (clear === 'C' ? 'Clear' : 'All clear') : def.aria}
              tone={def.tone}
              onPress={() => pressKey(key)}
              flash={flash === key}
              selected={key === waiting}
              disabled={digit && digitValue(key, state.base) === null}
              reduced={reduced}
              className={cn(digit ? 'text-[19px]' : 'text-[12.5px] font-medium', def.span === 2 && 'col-span-2', def.span === 3 && 'col-span-3', 'rounded-md')}
            />
          )
        })}
      </div>
    </div>
  )
}
