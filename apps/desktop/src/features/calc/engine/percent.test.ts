import { describe, expect, it } from 'vitest'
import { evaluate, evaluateDocument } from './index.ts'
import type { CalcContext, EvalResult } from './types.ts'

const CONTEXT: CalcContext = { locale: 'en-US', now: Date.UTC(2026, 9, 16, 2), zone: 'Australia/Sydney', rates: null }

async function answer(text: string): Promise<EvalResult> {
  const result = await evaluate(text, CONTEXT)

  expect(result.ok, `${text}: ${result.error}`).toBe(true)

  return result
}

describe('percentages', () => {
  it('takes a percentage of an amount, with the working', async () => {
    const result = await answer('20% of 84.50')

    expect(result.value).toMatchObject({ kind: 'number', exact: '16.9' })
    expect(result.display).toBe('16.9')
    expect(result.steps).toEqual(['20% of 84.50 = 84.50 × 0.20', '= 16.90'])
  })

  it('adds and takes off a percentage of the amount itself', async () => {
    const plus = await answer('84.50 + 15%')

    expect(plus.value?.exact).toBe('97.175')
    expect(plus.display).toBe('97.175')
    expect(plus.steps).toEqual(['15% of 84.50 = 12.675', '84.50 + 12.675 = 97.175'])

    const minus = await answer('84.50 - 15%')

    expect(minus.value?.exact).toBe('71.825')
    expect(minus.steps).toEqual(['15% of 84.50 = 12.675', '84.50 − 12.675 = 71.825'])
  })

  it('reads off, on, with … off and less', async () => {
    expect((await answer('15% off 60')).value?.exact).toBe('51')
    expect((await answer('15% off 60')).steps).toEqual(['15% of 60 = 9', '60 − 9 = 51'])
    expect((await answer('60 with 15% off')).value?.exact).toBe('51')
    expect((await answer('60 after a 15% discount')).value?.exact).toBe('51')
    expect((await answer('60 less 15%')).value?.exact).toBe('51')
    expect((await answer('15% on 60')).value?.exact).toBe('69')
    expect((await answer('15% on 60')).steps).toEqual(['15% of 60 = 9', '60 + 9 = 69'])
  })

  it('adds tips and taxes, and increases or decreases by a percentage', async () => {
    expect((await answer('84.50 with 15% tip')).value?.exact).toBe('97.175')
    expect((await answer('100 plus 10% tax')).value?.exact).toBe('110')
    expect((await answer('increase 50 by 10%')).value?.exact).toBe('55')
    expect((await answer('decrease 50 by 10%')).value?.exact).toBe('45')
    expect((await answer('80 reduced by 25%')).value?.exact).toBe('60')
  })

  it('finds what percentage one amount is of another', async () => {
    for (const text of ['what % of 80 is 20', 'what percent of 80 is 20', '20 is what % of 80', '20 as a % of 80', '20 as a percentage of 80', '20 out of 80 as a %']) {
      const result = await answer(text)

      expect(result.value, text).toMatchObject({ kind: 'percent', exact: '25' })
      expect(result.display, text).toBe('25%')
    }

    expect((await answer('20 is what % of 80')).steps).toEqual(['20 ÷ 80 = 0.25', '0.25 × 100 = 25%'])
  })

  it('finds the whole from a part and its percentage', async () => {
    const whole = await answer('20 is 25% of what')

    expect(whole.value).toMatchObject({ kind: 'number', exact: '80' })
    expect(whole.steps).toEqual(['20 ÷ 0.25 = 80'])
    expect((await answer('5% of what is 6')).value?.exact).toBe('120')
    expect((await answer('6 is 5 percent of what')).value?.exact).toBe('120')
  })

  it('finds the change between two amounts as a percentage', async () => {
    for (const text of ['% change from 50 to 75', 'percent change from 50 to 75', '50 to 75 is what %', 'change from 50 to 75']) {
      expect((await answer(text)).value, text).toMatchObject({ kind: 'percent', exact: '50' })
    }

    expect((await answer('% change from 80 to 60')).display).toBe('-25%')
    expect((await answer('% change from 50 to 75')).steps).toEqual(['75 − 50 = 25', '25 ÷ 50 = 0.5', '0.5 × 100 = 50%'])
  })

  it('converts plain numbers to percentages', async () => {
    expect((await answer('0.25 as %')).value).toMatchObject({ kind: 'percent', exact: '25' })
    expect((await answer('1/8 in percent')).display).toBe('12.5%')
  })

  it('keeps a lone percentage, adds percentages, and scales by one', async () => {
    expect((await answer('15%')).value).toMatchObject({ kind: 'percent', exact: '15', number: 15 })
    expect((await answer('20% + 5%')).display).toBe('25%')
    expect((await answer('200 * 15%')).value?.exact).toBe('30')
    expect((await answer('15% * 200')).value?.exact).toBe('30')
    expect((await answer('15 percent of 200')).value?.exact).toBe('30')
  })

  it('works on money and units', async () => {
    const money = await answer('$84.50 + 15%')

    expect(money.value).toMatchObject({ kind: 'currency', exact: '97.175', unit: 'USD' })
    expect(money.display).toBe('$97.18')
    expect((await answer('5 km + 10%')).display).toBe('5.5 km')
    expect((await answer('20% of $50')).display).toBe('$10.00')
  })

  it('asks for the percentage after the amount', async () => {
    const result = await evaluate('15% + 60', CONTEXT)

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/after the amount/)
  })
})

describe('splitting', () => {
  it('splits a sum a number of ways, showing the sum first', async () => {
    const result = await answer('2,400 + 180 split 3 ways')

    expect(result.value?.exact).toBe('860')
    expect(result.steps).toEqual(['2,400 + 180 = 2,580', '2,580 ÷ 3 = 860'])
  })

  it('reads every way of saying it', async () => {
    expect((await answer('split 2,580 between 4 people')).value?.exact).toBe('645')
    expect((await answer('2,580 divided among 4')).value?.exact).toBe('645')
    expect((await answer('2,580 shared between 4 friends')).value?.exact).toBe('645')
    expect((await answer('split 90 3 ways')).value?.exact).toBe('30')
    expect((await answer('90 split 3')).value?.exact).toBe('30')
    expect((await answer('100 split among 3')).display).toBe('33.33333333')
  })

  it('splits money to its minor units', async () => {
    const result = await answer('$120 split 3 ways')

    expect(result.value).toMatchObject({ kind: 'currency', exact: '40', unit: 'USD' })
    expect(result.display).toBe('$40.00')
    expect((await answer('$100 split 3 ways')).display).toBe('$33.33')
  })

  it('keeps a label before the split', async () => {
    const document = await evaluateDocument('Dinner: $120 split 4 ways', CONTEXT)

    expect(document.lines[0]).toMatchObject({ kind: 'value', label: 'Dinner', display: '$30.00' })
  })

  it('needs a number of ways', async () => {
    const result = await evaluate('$120 split 0 ways', CONTEXT)

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/number of ways/)
  })
})
