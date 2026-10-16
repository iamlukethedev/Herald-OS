import { atom } from 'nanostores'
import { type DecimalKey, INITIAL_KEYPAD, type KeypadState, type PressContext, press, resolve } from './machine.ts'
import { INITIAL_PROGRAMMER, type ProgrammerKey, type ProgrammerState, pressWord } from './programmer-machine.ts'

/* The keypads' state in this window, kept while the view comes and goes. */

export const $keypad = atom<KeypadState>(INITIAL_KEYPAD)
export const $programmer = atom<ProgrammerState>(INITIAL_PROGRAMMER)

export function pressKeypad(key: DecimalKey, context: PressContext): void {
  $keypad.set(press($keypad.get(), key, context))
}

export function resolveKeypad(id: number, value: string): void {
  $keypad.set(resolve($keypad.get(), id, value))
}

export function pressProgrammer(key: ProgrammerKey): void {
  $programmer.set(pressWord($programmer.get(), key))
}

export function updateProgrammer(change: (state: ProgrammerState) => ProgrammerState): void {
  $programmer.set(change($programmer.get()))
}

const settled = { keypad: 0, programmer: 0 }

/** True the first time an '=' id is seen, so each is evaluated and kept in the history once. */
export function claimEquals(pad: keyof typeof settled, id: number): boolean {
  if (id <= settled[pad]) {
    return false
  }

  settled[pad] = id

  return true
}
