import { describe, expect, it } from 'vitest'
import type { CalcRates } from '../../../../shared/calc.ts'
import { evaluate } from './index.ts'
import type { CalcContext, EvalResult } from './types.ts'

const RATES: CalcRates = {
  base: 'EUR',
  date: '2026-10-15',
  fetchedAt: Date.UTC(2026, 9, 15, 16),
  rates: {
    EUR: 1,
    USD: 1.25,
    GBP: 0.8,
    BRL: 6.25,
    AUD: 1.6,
    CAD: 1.5,
    NZD: 1.75,
    JPY: 160,
    CNY: 8,
    INR: 100,
    CHF: 0.95,
    SEK: 11.5,
    NOK: 11.8,
    DKK: 7.46,
    KRW: 1500,
    TRY: 40,
    ILS: 4,
    PHP: 65,
    THB: 38,
    PLN: 4.25,
    MXN: 20,
    ZAR: 20,
    HKD: 9.75,
    SGD: 1.5,
    MYR: 5,
    HUF: 400,
    CZK: 25
  }
}

function context(locale = 'en-US', rates: CalcRates | null = RATES): CalcContext {
  return { locale, now: Date.UTC(2026, 9, 16, 2), zone: 'Australia/Sydney', rates }
}

async function answer(text: string, locale = 'en-US', rates: CalcRates | null = RATES): Promise<EvalResult> {
  const result = await evaluate(text, context(locale, rates))

  expect(result.ok, `${text}: ${result.error}`).toBe(true)

  return result
}

describe('currency conversion', () => {
  it('converts through the euro rates and says which day they are from', async () => {
    const result = await answer('100 USD in BRL')

    expect(result.value).toMatchObject({ kind: 'currency', exact: '500', unit: 'BRL' })
    expect(result.display).toBe('R$500.00')
    expect(result.usesRates).toBe(true)
    expect(result.steps[0]).toBe('ECB rates on 2026-10-15: 1 EUR = 1.25 USD, 1 EUR = 6.25 BRL')
    expect(result.steps[1]).toBe('$100.00 ÷ 1.25 × 6.25 = R$500.00')
  })

  it('adds different currencies in the first and converts the total', async () => {
    const result = await answer('€50 + £20 in USD')

    expect(result.value).toMatchObject({ exact: '93.75', unit: 'USD' })
    expect(result.display).toBe('$93.75')
  })

  it('works out the amount before converting it', async () => {
    const result = await answer('$1,200 * 12 in EUR')

    expect(result.value).toMatchObject({ exact: '11520', unit: 'EUR' })
    expect(result.display).toBe('€11,520.00')
    expect(result.steps[0]).toBe('$1,200.00 × 12 = $14,400.00')
  })

  it('converts one unit of a currency named alone', async () => {
    expect((await answer('USD in EUR')).display).toBe('€0.80')
    expect((await answer('1200 in EUR')).display).toBe('€1,200.00')
  })
})

describe('currency symbols', () => {
  it('reads $ as the dollar of the locale', async () => {
    expect((await answer('$100 in EUR', 'en-US')).value?.exact).toBe('80')
    expect((await answer('$100 in EUR', 'en-AU')).value?.exact).toBe('62.5')
    expect((await answer('$100 in EUR', 'en-CA')).display).toBe('€66.67')
    expect((await answer('$100 in EUR', 'en-NZ')).display).toBe('€57.14')
    expect((await answer('100 dollars in euros', 'en-AU')).value?.exact).toBe('62.5')
  })

  it('reads dollars with a country', async () => {
    expect((await answer('A$100 in USD')).display).toBe('$78.13')
    expect((await answer('AU$160 in EUR')).value?.exact).toBe('100')
    expect((await answer('US$100 in EUR', 'en-AU')).value?.exact).toBe('80')
    expect((await answer('C$150 in EUR')).value?.exact).toBe('100')
    expect((await answer('NZ$175 in EUR')).value?.exact).toBe('100')
    expect((await answer('HK$975 in EUR')).value?.exact).toBe('100')
    expect((await answer('S$150 in EUR')).value?.exact).toBe('100')
    expect((await answer('R$625 in EUR')).value?.exact).toBe('100')
  })

  it('reads the other signs', async () => {
    const cases: Array<[string, string]> = [
      ['€10 in EUR', '10'],
      ['£8 in EUR', '10'],
      ['¥1600 in EUR', '10'],
      ['CN¥80 in EUR', '10'],
      ['₹1000 in EUR', '10'],
      ['₩1500 in EUR', '1'],
      ['₺40 in EUR', '1'],
      ['₪4 in EUR', '1'],
      ['₱65 in EUR', '1'],
      ['฿38 in EUR', '1'],
      ['4.25 zł in EUR', '1'],
      ['115 kr in EUR', '10'],
      ['Fr. 95 in EUR', '100'],
      ['95 CHF in EUR', '100'],
      ['400 Ft in EUR', '1'],
      ['25 Kč in EUR', '1']
    ]

    for (const [text, euros] of cases) {
      expect((await answer(text)).value?.exact, text).toBe(euros)
    }
  })

  it('reads ¥ as yuan and kr as the krone where the locale says so', async () => {
    expect((await answer('¥80 in EUR', 'zh-CN')).value?.exact).toBe('10')
    expect((await answer('118 kr in EUR', 'nb-NO')).value?.exact).toBe('10')
    expect((await answer('74,6 kr in EUR', 'da-DK')).value?.exact).toBe('10')
  })
})

describe('currency names', () => {
  it('reads names in the singular and plural', async () => {
    const cases: Array<[string, string]> = [
      ['10 euros in dollars', '12.5'],
      ['100 reais in USD', '20'],
      ['1000 yen in EUR', '6.25'],
      ['80 yuan in EUR', '10'],
      ['100 rupees in EUR', '1'],
      ['20 pesos in EUR', '1'],
      ['95 francs in EUR', '100'],
      ['115 kronor in EUR', '10'],
      ['20 rand in EUR', '1'],
      ['1500 won in EUR', '1'],
      ['38 baht in EUR', '1'],
      ['5 ringgit in EUR', '1'],
      ['4.25 zloty in EUR', '1'],
      ['40 lira in EUR', '1'],
      ['4 shekels in EUR', '1'],
      ['400 forint in EUR', '1'],
      ['25 koruna in EUR', '1'],
      ['10 us dollars in euros', '8'],
      ['8 pounds sterling in EUR', '10']
    ]

    for (const [text, value] of cases) {
      expect((await answer(text)).value?.exact, text).toBe(value)
    }
  })

  it('reads pounds as sterling only when the other side is money', async () => {
    expect((await answer('5 pounds in USD')).display).toBe('$7.81')
    expect((await answer('$10 in pounds')).display).toBe('£6.40')
    expect((await answer('£5 + 5 pounds')).display).toBe('£10.00')
    expect((await answer('5 pounds in kg')).value).toMatchObject({ kind: 'unit', unit: 'kg' })
  })
})

describe('money arithmetic', () => {
  it('needs no rates for one currency', async () => {
    const split = await answer('$120 split 3 ways', 'en-US', null)

    expect(split.display).toBe('$40.00')
    expect(split.usesRates).toBeFalsy()
    expect((await answer('$5 + $3', 'en-US', null)).display).toBe('$8.00')
    expect((await answer('€10 + 5', 'en-US', null)).display).toBe('€15.00')
    expect((await answer('$100 / $20', 'en-US', null)).value).toMatchObject({ kind: 'number', exact: '5' })
  })

  it('shows each currency at its minor units', async () => {
    expect((await answer('€10 in JPY')).display).toBe('¥1,600')
    expect((await answer('€10 in USD', 'de-DE')).display).toBe('12,50\u00a0$')
    expect((await answer('$1234.5', 'en-US', null)).display).toBe('$1,234.50')
    expect((await answer('-$5', 'en-US', null)).display).toBe('-$5.00')
  })

  it('speaks money in words', async () => {
    expect((await answer('100 USD', 'en-US', null)).spoken).toBe('100 US dollars')
    expect((await answer('$16.90', 'en-US', null)).spoken).toBe('16.90 US dollars')
  })

  it('does not multiply money by money', async () => {
    const result = await evaluate('$5 * $3', context())

    expect(result).toMatchObject({ ok: false, error: "Two amounts of money don't multiply" })
  })
})

describe('without the rates it needs', () => {
  it('says the rates have not come yet', async () => {
    const result = await evaluate('100 USD in BRL', context('en-US', null))

    expect(result).toMatchObject({ ok: false, error: "No currency rates yet: Herald fetches the European Central Bank's once a day when it can" })
  })

  it('names a currency the ECB has no rate for', async () => {
    expect((await evaluate('100 USD in XYZ', context())).error).toBe('The ECB publishes no rate for XYZ')
    expect((await evaluate('100 XYZ in USD', context())).error).toBe('The ECB publishes no rate for XYZ')
    expect((await evaluate('5 RUB in EUR', context())).error).toBe('The ECB publishes no rate for RUB')
  })
})
