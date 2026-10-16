import { describe, expect, it } from 'vitest'
import { compileFunction, evaluateDocument } from './index.ts'

describe('compileFunction', () => {
  it('compiles a function of x to call over and over', async () => {
    const square = await compileFunction('x^2')
    const wave = await compileFunction('sin(x) * x')

    expect(square(3)).toBe(9)
    expect(square(-1.5)).toBe(2.25)
    expect(wave(Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12)
  })

  it('reads the notepad’s way of writing', async () => {
    expect((await compileFunction('2x + 1'))(2)).toBe(5)
    expect((await compileFunction('x²'))(3)).toBe(9)
    expect((await compileFunction('π x'))(1)).toBeCloseTo(Math.PI, 12)
    expect((await compileFunction('√x'))(16)).toBe(4)
    expect((await compileFunction('log(x)'))(100)).toBeCloseTo(2, 12)
    expect((await compileFunction('ln(x)'))(Math.E)).toBeCloseTo(1, 12)
    expect((await compileFunction('sin(x°)'))(30)).toBeCloseTo(0.5, 12)
    expect((await compileFunction('x × 3 ÷ 2'))(4)).toBe(6)
  })

  it('takes a y = or f(x) = in front', async () => {
    expect((await compileFunction('y = x + 1'))(1)).toBe(2)
    expect((await compileFunction('f(x) = x^2'))(2)).toBe(4)
  })

  it('gives NaN where the function has no value', async () => {
    const root = await compileFunction('sqrt(x)')
    const inverse = await compileFunction('1/x')
    const log = await compileFunction('ln(x)')

    expect(root(4)).toBe(2)
    expect(root(-1)).toBeNaN()
    expect(inverse(0)).toBeNaN()
    expect(log(-1)).toBeNaN()
  })

  it('draws over another variable, with numbers from a scope', async () => {
    expect((await compileFunction('t^2', { variable: 't' }))(4)).toBe(16)
    expect((await compileFunction('a x^2 + b', { scope: { a: 2, b: 1 } }))(3)).toBe(19)
    expect((await compileFunction('A * x', { scope: { A: 3 } }))(2)).toBe(6)
  })

  it('throws a friendly error when it does not read', async () => {
    await expect(compileFunction('k * x')).rejects.toThrow('“k” has no value to draw with: use x, or give it a number on a line above')
    await expect(compileFunction('(x + 1')).rejects.toThrow(/never closed/)
    await expect(compileFunction('x + 5 km')).rejects.toThrow('Graphs draw plain numbers, without units')
    await expect(compileFunction('')).rejects.toThrow()
  })

  it('compiles what a note’s function lines hand on', async () => {
    const document = await evaluateDocument('a = 3\nf(x) = ln(x) + log(x) + a\ny = sin(x°)', { locale: 'de-DE', now: 0, zone: 'UTC', rates: null })
    const [first, second] = await Promise.all(document.functions.map(plot => compileFunction(plot.expression, { variable: plot.variable })))

    expect(first(10)).toBeCloseTo(Math.log(10) + 1 + 3, 12)
    expect(second(90)).toBeCloseTo(1, 12)
  })

  it('is fast enough to sample many times a frame', async () => {
    const fn = await compileFunction('sin(x) * x^2 + sqrt(abs(x))')
    const started = performance.now()

    for (let index = 0; index < 20_000; index++) {
      fn(index / 100)
    }

    expect(performance.now() - started).toBeLessThan(1000)
  })
})
