import type { MathJsInstance } from 'mathjs'
import { UNIT_DEFINITIONS } from './words.ts'

/*
 * math.js, loaded on first use so it stays in its own chunk: an exact instance (64-digit
 * BigNumbers and units) for the notepad, and a plain-number instance for drawing, made when a
 * graph first asks for it.
 */

/** Significant digits the exact instance keeps; a value that never ends is cut here. */
export const PRECISION = 64

export interface MathEngine {
  /** BigNumbers at PRECISION digits, with Herald's extra units. */
  math: MathJsInstance
  /** Plain numbers, predictable (NaN rather than complex), for drawing. */
  fast: () => MathJsInstance
}

let loading: Promise<MathEngine> | null = null
let ready: MathEngine | null = null

/** math.js, loaded once; a failed load is tried again on the next call. */
export function loadMath(): Promise<MathEngine> {
  if (!loading) {
    loading = import('mathjs').then(
      module => {
        ready = setup(module)

        return ready
      },
      (error: unknown) => {
        loading = null
        throw error
      }
    )
  }

  return loading
}

/** The engine when it has loaded already, else null. */
export function loadedMath(): MathEngine | null {
  return ready
}

function setup(module: typeof import('mathjs')): MathEngine {
  const math = module.create(module.all, { number: 'BigNumber', precision: PRECISION })

  for (const [name, { definition, prefixes }] of Object.entries(UNIT_DEFINITIONS)) {
    math.createUnit(name, prefixes ? { definition, prefixes } : { definition }, { override: true })
  }

  let fast: MathJsInstance | null = null

  return {
    math,
    fast: () => {
      if (!fast) {
        fast = module.create(module.all, { predictable: true })
        fast.import({ ln: (value: number) => Math.log(value) }, { override: true })
      }

      return fast
    }
  }
}
