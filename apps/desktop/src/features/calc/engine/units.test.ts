import { describe, expect, it } from 'vitest'
import { convert, evaluate, loadEngine } from './index.ts'
import { loadMath } from './math.ts'
import type { CalcContext, EvalResult } from './types.ts'
import { UNITS } from './words.ts'

const CONTEXT: CalcContext = { locale: 'en-US', now: Date.UTC(2026, 9, 16, 2), zone: 'Australia/Sydney', rates: null }

async function answer(text: string): Promise<EvalResult> {
  const result = await evaluate(text, CONTEXT)

  expect(result.ok, `${text}: ${result.error}`).toBe(true)

  return result
}

async function shown(text: string): Promise<string | undefined> {
  return (await answer(text)).display
}

describe('the unit table', () => {
  it('names only units math.js can build', async () => {
    const { math } = await loadMath()

    for (const entry of UNITS) {
      expect(() => math.unit(math.bignumber(1), entry.unit), entry.unit).not.toThrow()
    }
  })

  it('loads once and stays loaded', async () => {
    await loadEngine()
    await loadEngine()

    expect((await answer('1 + 1')).value?.exact).toBe('2')
  })
})

describe('conversions', () => {
  it('converts lengths', async () => {
    const miles = await answer('5 km in mi')

    expect(miles.value).toMatchObject({ kind: 'unit', unit: 'mi' })
    expect(miles.value?.number).toBeCloseTo(3.1068559612, 9)
    expect(miles.display).toBe('3.1069 mi')
    expect(await shown('1 mi in km')).toBe('1.6093 km')
    expect(await shown('3 ft 4 in in cm')).toBe('101.6 cm')
    expect(await shown('12 inches to cm')).toBe('30.48 cm')
    expect(await shown('1 nautical mile in km')).toBe('1.852 km')
    expect(await shown('100 yd -> m')).toBe('91.44 m')
    expect(await shown('5 km as mi')).toBe('3.1069 mi')
    expect(await shown('5 km into miles')).toBe('3.1069 mi')
    expect(await shown('1 m → ft')).toBe('3.2808 ft')
    expect(await shown('5\'10" in cm')).toBe('177.8 cm')
    expect(await shown('6 feet into metres')).toBe('1.8288 m')
    expect(await shown('how many feet in a mile')).toBe('5,280 ft')
  })

  it('converts masses, and pounds weigh unless money is involved', async () => {
    expect(await shown('5 kg in lb')).toBe('11.023 lb')
    expect(await shown('1 lb in g')).toBe('453.59 g')
    expect(await shown('10 stone in kg')).toBe('63.503 kg')
    expect(await shown('16 oz in lb')).toBe('1 lb')
    expect(await shown('2 t in kg')).toBe('2,000 kg')
    expect(await shown('5 pounds in kg')).toBe('2.268 kg')
    expect(await shown('500 mg in g')).toBe('0.5 g')
  })

  it('converts temperatures with their offsets', async () => {
    const oven = await answer('350°F in C')

    expect(oven.value).toMatchObject({ kind: 'unit', unit: 'degC' })
    expect(oven.display).toBe('176.67 °C')
    expect(oven.steps).toEqual(['(350 − 32) × 5/9 = 176.67 °C'])
    expect(await shown('100 C in F')).toBe('212 °F')
    expect(await shown('0 K in C')).toBe('-273.15 °C')
    expect(await shown('20 °C in K')).toBe('293.15 K')
    expect(await shown('98.6 fahrenheit in celsius')).toBe('37 °C')
    expect(await shown('20 degrees celsius to fahrenheit')).toBe('68 °F')
  })

  it('converts volumes', async () => {
    expect(await shown('1 l in ml')).toBe('1,000 mL')
    expect(await shown('1 gal in l')).toBe('3.7854 L')
    expect(await shown('2 cups in ml')).toBe('473.18 mL')
    expect(await shown('1 m³ in l')).toBe('1,000 L')
    expect(await shown('1 tbsp in tsp')).toBe('3 tsp')
    expect(await shown('12 fl oz in ml')).toBe('354.88 mL')
  })

  it('converts areas', async () => {
    expect(await shown('1 ha in m²')).toBe('10,000 m²')
    expect((await answer('1 acre in m^2')).value?.exact).toBe('4046.8564224')
    expect(await shown('100 sq ft in m²')).toBe('9.2903 m²')
    expect(await shown('1 km² in hectares')).toBe('100 ha')
    expect(await shown('1 sq mi in acres')).toBe('640 ac')
    expect(await shown('20 square feet in m2')).toBe('1.8581 m²')
  })

  it('converts speeds', async () => {
    expect(await shown('100 km/h in mph')).toBe('62.137 mph')
    expect(await shown('60 mph in km/h')).toBe('96.561 km/h')
    expect(await shown('10 m/s in km/h')).toBe('36 km/h')
    expect(await shown('1 knot in km/h')).toBe('1.852 km/h')
    expect(await shown('30 kph in m/s')).toBe('8.3333 m/s')
    expect(await shown('60 km per hour in m/s')).toBe('16.667 m/s')
  })

  it('converts data sizes and rates', async () => {
    expect(await shown('1.5 GB in MB')).toBe('1,500 MB')
    expect(await shown('1 GiB in MiB')).toBe('1,024 MiB')
    expect(await shown('1 KiB in B')).toBe('1,024 B')
    expect(await shown('8 bits in bytes')).toBe('1 B')
    expect(await shown('100 Mbps in MB/s')).toBe('12.5 MB/s')
    expect(await shown('1 TB in GB')).toBe('1,000 GB')
    expect(await shown('500 mb in gb')).toBe('0.5 GB')
    expect(await shown('1 Mb in kB')).toBe('125 kB')
  })

  it('converts times as durations', async () => {
    const minutes = await answer('3 hours 20 minutes in minutes')

    expect(minutes.value).toMatchObject({ kind: 'duration', exact: '200', unit: 'minute' })
    expect(minutes.display).toBe('200 min')
    expect(minutes.spoken).toBe('200 minutes')
    expect(await shown('90 min in hours')).toBe('1.5 h')
    expect(await shown('1 week in days')).toBe('7 days')
    expect(await shown('2 hours + 30 min')).toBe('2.5 h')
    expect(await shown('1 day in hours')).toBe('24 h')
    expect(await shown('1 year in days')).toBe('365.25 days')
    expect(await shown('1500 ms in s')).toBe('1.5 s')
  })

  it('converts energy, power and pressure', async () => {
    expect(await shown('1 kWh in J')).toBe('3,600,000 J')
    expect(await shown('1 kcal in kJ')).toBe('4.184 kJ')
    expect(await shown('1 hp in W')).toBe('745.7 W')
    expect(await shown('1 bar in psi')).toBe('14.504 psi')
    expect(await shown('1 atm in kPa')).toBe('101.325 kPa')
  })

  it('shows the factor it converts by', async () => {
    expect((await answer('5 km in mi')).steps).toEqual(['1 km = 0.621371 mi', '5 km × 0.621371 = 3.1069 mi'])
    expect((await answer('1.5 GB in MB')).steps).toEqual(['1 GB = 1,000 MB', '1.5 GB × 1,000 = 1,500 MB'])
  })

  it('reads "in" after a plain number as inches when a length follows', async () => {
    const inches = await answer('12 in cm')

    expect(inches.value).toMatchObject({ kind: 'unit', unit: 'cm', exact: '30.48' })
    expect(inches.steps).toEqual(['1 in = 2.54 cm', '12 in × 2.54 = 30.48 cm'])
    expect(await shown('12 in')).toBe('12 in')
    expect(await shown('12 in in cm')).toBe('30.48 cm')
    expect(await shown('12 inches in cm')).toBe('30.48 cm')
    expect(await shown('0.5 in mm')).toBe('12.7 mm')
    expect(await shown('-12 in cm')).toBe('-30.48 cm')
    expect(await shown('12 IN FT')).toBe('1 ft')
    expect(await shown('(12 in cm)')).toBe('30.48 cm')
    expect(await shown('12 in cm in mm')).toBe('304.8 mm')
    expect(await shown('5 ft 10 in cm')).toBe('177.8 cm')
    expect(await shown("5' 10 in cm")).toBe('177.8 cm')
  })

  it('gives a plain number the unit it is converted to otherwise', async () => {
    expect(await shown('12 to cm')).toBe('12 cm')
    expect(await shown('12 into cm')).toBe('12 cm')
    expect(await shown('12 in kg')).toBe('12 kg')
    expect(await shown('12 in sq cm')).toBe('12 cm²')
    expect(await shown('12 in km/h')).toBe('12 km/h')
    expect(await shown('100 in EUR')).toBe('€100.00')
    expect(await shown('12 + 3 in cm')).toBe('15 cm')
    expect(await shown('2 * 6 in cm')).toBe('12 cm')
    expect(await shown('(12) in cm')).toBe('12 cm')
    expect(await shown('5 ft in cm')).toBe('152.4 cm')
    expect(await shown('3 days in hours')).toBe('72 h')
  })
})

describe('unit arithmetic', () => {
  it('adds compatible units in the first one', async () => {
    expect(await shown('5 km + 300 m')).toBe('5.3 km')
    expect(await shown('1 lb + 1 oz')).toBe('1.0625 lb')
    expect(await shown('1 h - 15 min')).toBe('0.75 h')
  })

  it('multiplies and divides into the units the line names', async () => {
    expect(await shown('60 mph * 2 hours')).toBe('120 mi')
    expect(await shown('60 mph * 2 hours in km')).toBe('193.12 km')
    expect(await shown('2 TB / 50 MB/s in hours')).toBe('11.111 h')
    expect(await shown('2 TB / 50 MB/s')).toBe('11.111 h')
    expect(await shown('(100 MB/s) * (60 s)')).toBe('6,000 MB')
    expect(await shown('3 m * 2 m')).toBe('6 m²')
    expect(await shown('100 km / 2 h')).toBe('50 km/h')
    expect(await shown('2 kW * 3 h')).toBe('6 kWh')
    expect(await shown('5 km * 3')).toBe('15 km')
    expect(await shown('10 m / 4')).toBe('2.5 m')
    expect(await shown('sqrt(16 m^2)')).toBe('4 m')
  })

  it('cancels units that divide out', async () => {
    expect((await answer('10 km / 2 km')).value).toMatchObject({ kind: 'number', exact: '5' })
    expect((await answer('1 mi / 1 km')).value?.number).toBeCloseTo(1.609344, 9)
  })

  it('shows the intermediate result in tidy units', async () => {
    expect((await answer('60 mph * 2 hours in km')).steps).toEqual(['60 mph × 2 h = 120 mi', '1 mi = 1.60934 km', '120 mi × 1.60934 = 193.12 km'])
  })

  it("says gently when units don't go together", async () => {
    const add = await evaluate('5 km + 3 kg', CONTEXT)

    expect(add).toMatchObject({ ok: false, error: "A length and a mass don't add up" })
    expect((await evaluate('5 km in kg', CONTEXT)).error).toBe("A length doesn't convert to a mass")
    expect((await evaluate('5 km + 3', CONTEXT)).error).toBe("A length and a plain number don't add up")
    expect((await evaluate('20 C in kg', CONTEXT)).error).toBe("A temperature doesn't convert to a mass")
    expect((await evaluate('3 h + 2 GB', CONTEXT)).error).toBe("A time and a data size don't add up")
  })

  it('names a unit it does not know instead of guessing', async () => {
    expect(await evaluate('5 km in parsecs', CONTEXT)).toMatchObject({ ok: false, error: "Herald doesn't know the unit “parsecs”" })
    expect((await answer('$50 to Mum')).display).toBe('$50.00')
    expect((await answer('3 hours in the office')).display).toBe('3 h')
  })
})

describe('convert()', () => {
  it('converts an amount from one unit to another', async () => {
    const result = await convert('5', 'km', 'mi', CONTEXT)

    expect(result.ok).toBe(true)
    expect(result.value?.number).toBeCloseTo(3.1068559612, 9)
  })

  it('takes a quantity that names its own units', async () => {
    expect((await convert('5 ft 3 in', '', 'cm', CONTEXT)).display).toBe('160.02 cm')
    expect((await convert('100', '°F', '°C', CONTEXT)).display).toBe('37.778 °C')
    expect((await convert('5', 'pounds', 'kg', CONTEXT)).display).toBe('2.268 kg')
  })

  it('reads inches only when they are named', async () => {
    expect((await convert('12', 'in', 'cm', CONTEXT)).display).toBe('30.48 cm')
    expect((await convert('12 in', '', 'cm', CONTEXT)).display).toBe('30.48 cm')
    expect((await convert('12', '', 'cm', CONTEXT)).display).toBe('12 cm')
  })

  it('gives a number written as a sum the unit it is in', async () => {
    expect((await convert('1/2', 'in', 'cm', CONTEXT)).display).toBe('1.27 cm')
    expect((await convert('sqrt(16)', 'km', 'mi', CONTEXT)).display).toBe('2.4855 mi')
  })

  it('reads from as the place of a time of day, unless the time names its own', async () => {
    const tokyo = await convert('9am', 'Tokyo', 'London', CONTEXT)

    expect(tokyo.value).toMatchObject({ kind: 'time', zone: 'Europe/London' })
    expect(tokyo.display).toBe('1:00 AM (London)')
    expect((await convert('noon', 'New York', 'Tokyo', CONTEXT)).display).toBe('1:00 AM Fri (Tokyo)')
    expect((await convert('9am Sydney', 'Tokyo', 'London', CONTEXT)).display).toBe('11:00 PM Thu (London)')
    expect((await convert('now', 'Tokyo', 'London', CONTEXT)).display).toBe('3:00 AM (London)')
    expect(await convert('9am', 'Gotham', 'London', CONTEXT)).toMatchObject({ ok: false, error: "I don't know the time zone of “Gotham”." })
  })

  it('explains instead of throwing', async () => {
    expect((await convert('5', 'km', 'kg', CONTEXT)).ok).toBe(false)
    expect((await convert('abc', 'zz', 'qq', CONTEXT)).ok).toBe(false)
  })
})
