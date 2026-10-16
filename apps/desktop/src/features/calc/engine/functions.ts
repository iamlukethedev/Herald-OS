import { lex } from './lexer.ts'
import type { MathEngine } from './math.ts'
import { ParseError, parseContext, parseTokens } from './parser.ts'
import { printExpression } from './printer.ts'
import type { CompiledFunction } from './types.ts'

/*
 * Functions of one variable for drawing. Herald's parser reads them, so "2x", "x²", "π" and "ln x"
 * work as in the notepad; math.js compiles the result once over plain numbers, fast enough to
 * call thousands of times a frame.
 */

/** "y =" or "f(x) =" before the expression. */
const DEFINITION = /^\s*[\p{L}_][\p{L}\p{N}_]*\s*(?:\(\s*[\p{L}_][\p{L}\p{N}_]*\s*\))?\s*=(?!=)\s*/u

/** `expression` compiled over `variable`; throws an Error with a plain message when it does not read. */
export function compile(engine: MathEngine, expression: string, variable: string, scope: Readonly<Record<string, number>>): CompiledFunction {
  const context = parseContext('en-US')
  const text = expression.replace(DEFINITION, '')
  const names = new Map(Object.keys(scope).map(name => [name.toLowerCase(), name]))
  let printed: string

  try {
    const node = parseTokens(lex(text, context.symbols), context)

    printed = printExpression(node, key => (key === variable.toLowerCase() ? variable : (names.get(key) ?? null)))
  } catch (error) {
    throw new Error(error instanceof ParseError ? error.message : `“${expression}” doesn't read as a function of ${variable}`)
  }

  let code: { evaluate: (scope?: Record<string, number>) => unknown }

  try {
    code = engine.fast().compile(printed)
  } catch {
    throw new Error(`“${expression}” doesn't read as a function of ${variable}`)
  }

  const values: Record<string, number> = { ...scope, [variable]: 0 }

  return (x: number): number => {
    values[variable] = x

    try {
      const result = code.evaluate(values)

      return typeof result === 'number' && Number.isFinite(result) ? result : Number.NaN
    } catch {
      return Number.NaN
    }
  }
}
