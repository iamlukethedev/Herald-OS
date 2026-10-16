import { describe, expect, it, vi } from 'vitest'
import { expressionOf } from './sources.ts'

vi.mock('../engine/index.ts', () => ({ compileFunction: vi.fn() }))

vi.mock('./sheets-source.ts', () => ({ readSheetSeries: vi.fn() }))

describe('what a line of the graph compiles', () => {
  it.each([
    ['sin(x) * x', 'sin(x) * x'],
    ['y = sin(x) * x', 'sin(x) * x'],
    ['f(x) = x^2 - 2', 'x^2 - 2'],
    ['g (x)=1/x', '1/x'],
    ['plot sin(x)', 'sin(x)'],
    ['  2x + 1  ', '2x + 1'],
    ['y == 3', 'y == 3'],
    ['   ', '']
  ])('reads “%s” as “%s”', (text, expression) => {
    expect(expressionOf(text)).toBe(expression)
  })
})
