import { describe, expect, it } from 'vitest'
import { evaluate } from './index.ts'
import type { CalcContext, EvalResult } from './types.ts'

const CONTEXT: CalcContext = { locale: 'en-US', now: Date.UTC(2026, 9, 16, 2), zone: 'Australia/Sydney', rates: null }

async function answer(text: string): Promise<EvalResult> {
  const result = await evaluate(text, CONTEXT)

  expect(result.ok, `${text}: ${result.error}`).toBe(true)

  return result
}

async function exact(text: string): Promise<string | undefined> {
  return (await answer(text)).value?.exact
}

async function shown(text: string): Promise<string | undefined> {
  return (await answer(text)).display
}

async function failure(text: string): Promise<string | undefined> {
  const result = await evaluate(text, CONTEXT)

  expect(result.ok, `${text} should fail`).toBe(false)

  return result.error
}

describe('exact arithmetic', () => {
  it('adds decimals without float error', async () => {
    expect(await exact('0.1 + 0.2')).toBe('0.3')
    expect(await shown('0.1 + 0.2')).toBe('0.3')
    expect(await exact('0.1 * 3')).toBe('0.3')
    expect(await exact('1.1 - 0.9')).toBe('0.2')
  })

  it('keeps rationals exact through division', async () => {
    expect(await exact('1/3 * 3')).toBe('1')
    expect(await exact('(1/3 + 1/6) * 2')).toBe('1')
    expect(await exact('10/4')).toBe('2.5')
    expect(await exact('2^-2')).toBe('0.25')
  })

  it('keeps every digit of big integers', async () => {
    expect(await exact('2^200')).toBe('1606938044258990275541962092341162602522202993782792835301376')
    expect(await exact('30!')).toBe('265252859812191058636308480000000')
    expect(await exact('9007199254740993 + 1')).toBe('9007199254740994')
    expect(await shown('2^100')).toBe('1,267,650,600,228,229,401,496,703,205,376')
  })

  it('carries a fraction for a rational that never ends and shows ten digits', async () => {
    const third = await answer('1/3')

    expect(third.value?.fraction).toBe('1/3')
    expect(third.display).toBe('0.3333333333')
    expect(third.value?.exact.startsWith('0.333333333333333333333333')).toBe(true)
    expect((await answer('2/3')).display).toBe('0.6666666667')
    expect((await answer('-7/12')).value?.fraction).toBe('-7/12')
    expect((await answer('22/7')).value?.fraction).toBe('22/7')
    expect((await answer('10/4')).value?.fraction).toBeUndefined()
  })

  it('reads thousands separators and scientific notation', async () => {
    expect(await exact('1,234,567.89 + 0.11')).toBe('1234568')
    expect(await exact('1.5e3')).toBe('1500')
    expect(await exact('2.5E-3')).toBe('0.0025')
    expect(await exact('1e-20 * 1e20')).toBe('1')
    expect(await exact('0x1F')).toBe('31')
    expect(await exact('0b1010')).toBe('10')
  })

  it('reads scale words and suffixes', async () => {
    expect(await exact('2.5k')).toBe('2500')
    expect(await exact('300K')).toBe('300000')
    expect(await exact('1.5M')).toBe('1500000')
    expect(await exact('3 million')).toBe('3000000')
    expect(await exact('1.2 billion')).toBe('1200000000')
    expect(await exact('4bn')).toBe('4000000000')
    expect(await exact('2 thousand')).toBe('2000')
    expect(await exact('3 dozen')).toBe('36')
    expect(await exact('2 lakh')).toBe('200000')
  })

  it('snaps transcendental answers that land on short decimals', async () => {
    expect(await exact('sqrt(2)^2')).toBe('2')
    expect(await exact('sin(30°)')).toBe('0.5')
    expect(await exact('log(1000)')).toBe('3')
  })
})

describe('operators', () => {
  it('reads operator words', async () => {
    expect(await exact('7 plus 8 minus 2')).toBe('13')
    expect(await exact('3 times 4')).toBe('12')
    expect(await exact('6 multiplied by 7')).toBe('42')
    expect(await exact('10 divided by 4')).toBe('2.5')
    expect(await exact('100 over 8')).toBe('12.5')
    expect(await exact('2 to the power of 10')).toBe('1024')
    expect(await exact('5 squared')).toBe('25')
    expect(await exact('2 cubed')).toBe('8')
    expect(await exact('square root of 81')).toBe('9')
    expect(await exact('cube root of 27')).toBe('3')
    expect(await exact('negative 5 + 2')).toBe('-3')
  })

  it('reads typographic symbols and x for times', async () => {
    expect(await exact('6 × 7')).toBe('42')
    expect(await exact('84 ÷ 4')).toBe('21')
    expect(await exact('3 · 4')).toBe('12')
    expect(await exact('10 − 4')).toBe('6')
    expect(await exact('2 x 3')).toBe('6')
    expect(await exact('2x3')).toBe('6')
    expect(await exact('4.50 x 3')).toBe('13.5')
    expect(await exact('√16')).toBe('4')
    expect(await exact('∛27')).toBe('3')
    expect(await exact('3²')).toBe('9')
  })

  it('multiplies implicitly', async () => {
    expect(await exact('2(3 + 4)')).toBe('14')
    expect(await exact('(1 + 2)(3 + 4)')).toBe('21')
    expect(await shown('2 pi')).toBe('6.283185307')
    expect(await shown('2π')).toBe('6.283185307')
  })

  it('follows precedence: powers first, right to left, before signs', async () => {
    expect(await exact('2 + 3 * 4')).toBe('14')
    expect(await exact('-2^2')).toBe('-4')
    expect(await exact('2^-1')).toBe('0.5')
    expect(await exact('2^3^2')).toBe('512')
    expect(await exact('(2 + 3)!')).toBe('120')
  })

  it('does mod with the sign of the divisor', async () => {
    expect(await exact('10 mod 3')).toBe('1')
    expect(await exact('10 % 3')).toBe('1')
    expect(await exact('-7 mod 3')).toBe('2')
  })

  it('reads parts and multiples', async () => {
    expect(await exact('half of 120')).toBe('60')
    expect(await exact('a third of 90')).toBe('30')
    expect(await exact('double 15')).toBe('30')
    expect(await exact('twice 21')).toBe('42')
    expect(await exact('3/4 of 120')).toBe('90')
  })

  it('reads questions around the math', async () => {
    expect(await exact('what is 5 + 3?')).toBe('8')
    expect(await exact("what's 6 * 7")).toBe('42')
    expect(await exact('5 + 3 =')).toBe('8')
    expect(await exact('calculate 2^10')).toBe('1024')
  })
})

describe('functions and constants', () => {
  it('works out the common functions', async () => {
    expect(await exact('sqrt(16)')).toBe('4')
    expect(await exact('sqrt 16')).toBe('4')
    expect(await shown('sqrt(2)')).toBe('1.414213562')
    expect(await exact('cbrt(27)')).toBe('3')
    expect(await exact('abs(-5)')).toBe('5')
    expect(await exact('round(2.345, 2)')).toBe('2.35')
    expect(await exact('round(2.5)')).toBe('3')
    expect(await exact('floor(-2.5)')).toBe('-3')
    expect(await exact('ceil(2.1)')).toBe('3')
    expect(await exact('min(3, 1, 2)')).toBe('1')
    expect(await exact('max(3, 1, 2)')).toBe('3')
    expect(await exact('gcd(12, 18)')).toBe('6')
    expect(await exact('lcm(4, 6)')).toBe('12')
    expect(await exact('factorial(5)')).toBe('120')
    expect(await exact('choose(5, 2)')).toBe('10')
    expect(await exact('hypot(3, 4)')).toBe('5')
    expect(await exact('median(3, 1, 2)')).toBe('2')
    expect(await exact('average(1, 2, 3, 4)')).toBe('2.5')
    expect(await exact('sum(1, 2, 3)')).toBe('6')
    expect(await exact('root(32, 5)')).toBe('2')
  })

  it('reads log as base 10 and ln as natural', async () => {
    expect(await exact('log(1000)')).toBe('3')
    expect(await exact('log(8, 2)')).toBe('3')
    expect(await exact('log10(0.01)')).toBe('-2')
    expect(await exact('log2(1024)')).toBe('10')
    expect(await exact('ln(e)')).toBe('1')
    expect(await exact('exp(0)')).toBe('1')
    expect(await shown('ln 2')).toBe('0.6931471806')
  })

  it('knows pi, e, phi and tau', async () => {
    expect(await shown('pi')).toBe('3.141592654')
    expect(await shown('π')).toBe('3.141592654')
    expect(await shown('e')).toBe('2.718281828')
    expect(await shown('phi')).toBe('1.618033989')
    expect(await shown('tau')).toBe('6.283185307')
  })

  it('reads angles in radians unless a degree unit is written', async () => {
    expect(await exact('sin(0)')).toBe('0')
    expect(await exact('sin(pi)')).toBe('0')
    expect(await exact('cos(pi)')).toBe('-1')
    expect(await exact('sin(pi/2)')).toBe('1')
    expect(await exact('sin(30°)')).toBe('0.5')
    expect(await exact('sin(30 deg)')).toBe('0.5')
    expect(await exact('cos(60 degrees)')).toBe('0.5')
    expect(await exact('tan(45°)')).toBe('1')
    expect(await shown('sin(30)')).toBe('-0.9880316241')
    expect(await shown('atan(1)')).toBe('0.7853981634')
    expect(await exact('cosh(0)')).toBe('1')
  })

  it('converts an inverse trig answer to degrees', async () => {
    const result = await answer('asin(0.5) in deg')

    expect(result.value).toMatchObject({ kind: 'unit', unit: 'deg', exact: '30' })
    expect(result.display).toBe('30°')
  })

  it('shows the gamma of a fraction like any value that never ends', async () => {
    expect(await shown('0.5!')).toBe('0.8862269255')
  })
})

describe('steps', () => {
  it('shows inner operations first', async () => {
    expect((await answer('2 + 3 * 4')).steps).toEqual(['3 × 4 = 12', '2 + 12 = 14'])
    expect((await answer('sqrt(16) + 1')).steps).toEqual(['√16 = 4', '4 + 1 = 5'])
    expect((await answer('(2 + 3) * 4')).steps).toEqual(['2 + 3 = 5', '5 × 4 = 20'])
  })

  it('has none for a lone number', async () => {
    expect((await answer('42')).steps).toEqual([])
  })
})

describe('gentle errors', () => {
  it('explains what has no answer', async () => {
    expect(await failure('1/0')).toBe('Dividing by zero has no answer')
    expect(await failure('sqrt(-4)')).toMatch(/negative number isn't a real number/)
    expect(await failure('log(0)')).toBe('A logarithm needs a number above zero')
    expect(await failure('asin(2)')).toMatch(/from −1 to 1/)
    expect(await failure('(-8)^(1/2)')).toMatch(/fractional power/)
    expect(await failure('5000!')).toMatch(/too big/)
  })

  it('takes odd roots of negative numbers', async () => {
    expect(await exact('(-8)^(1/3)')).toBe('-2')
    expect(await exact('cbrt(-27)')).toBe('-3')
  })

  it('says what is missing from a line that does not read', async () => {
    expect(await failure('(2 + 3')).toMatch(/never closed/)
    expect(await failure('2 +')).toBe('Something is missing after “+”')
    expect(await failure('2 + 3)')).toMatch(/without its “\(”/)
  })

  it('goes to scientific notation for enormous answers', async () => {
    expect(await shown('10^100000')).toBe('1e100000')
  })

  it('never throws, whatever it is given', async () => {
    const inputs = ['', '   ', ')(', '@@@', '\u0000', '1/(1-1)', 'sin(', 'what', '%%%', '$', '£', '1e999999', '((((((', '√', '2^^2', '...', '#', '//', '5 km in', 'in', '=', 'x =', '1,,2']

    for (const input of inputs) {
      const result = await evaluate(input, CONTEXT)

      expect(typeof result.ok).toBe('boolean')
      expect(result.input).toBe(input)
    }
  })
})
