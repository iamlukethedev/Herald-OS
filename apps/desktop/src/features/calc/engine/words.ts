/*
 * The words and symbols the engine reads: units, currencies, functions, constants and operator
 * words. One table for the parser, the formatter and the voice vocabulary; plain data, so importing
 * it never loads math.js.
 */

export type Measure =
  | 'length'
  | 'mass'
  | 'time'
  | 'temperature'
  | 'angle'
  | 'volume'
  | 'area'
  | 'speed'
  | 'data'
  | 'data rate'
  | 'energy'
  | 'power'
  | 'pressure'
  | 'frequency'
  | 'force'

export interface UnitWord {
  /** The unit as math.js reads it ("km", "mph", "degC", "m^2"). */
  unit: string
  /** What the notepad shows ("km", "°C", "fl oz"). */
  symbol: string
  /** Words to speak, singular then plural, where Intl has none. */
  names: readonly [string, string]
  /** Intl's unit, for the locale's own words ("kilometer", "celsius", "mile-per-hour"). */
  intl?: string
  measure: Measure
  /** Read whatever the case, including phrases ("kilometres", "sq ft", "degrees celsius"). */
  words?: readonly string[]
  /** Read only exactly as written ("B" is a byte, "b" a bit, "K" kelvin). */
  exact?: readonly string[]
}

export const UNITS: readonly UnitWord[] = [
  { unit: 'm', symbol: 'm', names: ['metre', 'metres'], intl: 'meter', measure: 'length', words: ['meter', 'meters', 'metre', 'metres'], exact: ['m'] },
  { unit: 'km', symbol: 'km', names: ['kilometre', 'kilometres'], intl: 'kilometer', measure: 'length', words: ['km', 'kms', 'kilometer', 'kilometers', 'kilometre', 'kilometres'] },
  { unit: 'cm', symbol: 'cm', names: ['centimetre', 'centimetres'], intl: 'centimeter', measure: 'length', words: ['cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres'] },
  { unit: 'mm', symbol: 'mm', names: ['millimetre', 'millimetres'], intl: 'millimeter', measure: 'length', words: ['mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres'] },
  { unit: 'um', symbol: 'µm', names: ['micrometre', 'micrometres'], measure: 'length', words: ['µm', 'μm', 'micron', 'microns', 'micrometer', 'micrometers', 'micrometre', 'micrometres'] },
  { unit: 'nm', symbol: 'nm', names: ['nanometre', 'nanometres'], measure: 'length', words: ['nanometer', 'nanometers', 'nanometre', 'nanometres'], exact: ['nm'] },
  { unit: 'mi', symbol: 'mi', names: ['mile', 'miles'], intl: 'mile', measure: 'length', words: ['mi', 'mile', 'miles'] },
  { unit: 'yd', symbol: 'yd', names: ['yard', 'yards'], intl: 'yard', measure: 'length', words: ['yd', 'yds', 'yard', 'yards'] },
  { unit: 'ft', symbol: 'ft', names: ['foot', 'feet'], intl: 'foot', measure: 'length', words: ['ft', 'foot', 'feet', '′'], exact: ["'"] },
  { unit: 'inch', symbol: 'in', names: ['inch', 'inches'], intl: 'inch', measure: 'length', words: ['in', 'inch', 'inches', '″'], exact: ['"'] },
  { unit: 'nmi', symbol: 'nmi', names: ['nautical mile', 'nautical miles'], measure: 'length', words: ['nmi', 'nautical mile', 'nautical miles'] },
  { unit: 'lightyear', symbol: 'ly', names: ['light-year', 'light-years'], measure: 'length', words: ['ly', 'lightyear', 'lightyears', 'light year', 'light years', 'light-year', 'light-years'] },

  { unit: 'kg', symbol: 'kg', names: ['kilogram', 'kilograms'], intl: 'kilogram', measure: 'mass', words: ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms', 'kilogramme', 'kilogrammes'] },
  { unit: 'g', symbol: 'g', names: ['gram', 'grams'], intl: 'gram', measure: 'mass', words: ['gram', 'grams', 'gramme', 'grammes'], exact: ['g'] },
  { unit: 'mg', symbol: 'mg', names: ['milligram', 'milligrams'], measure: 'mass', words: ['mg', 'milligram', 'milligrams'] },
  { unit: 'ug', symbol: 'µg', names: ['microgram', 'micrograms'], measure: 'mass', words: ['µg', 'μg', 'mcg', 'microgram', 'micrograms'] },
  { unit: 'tonne', symbol: 't', names: ['tonne', 'tonnes'], measure: 'mass', words: ['tonne', 'tonnes', 'metric ton', 'metric tons'], exact: ['t'] },
  { unit: 'ton', symbol: 'ton', names: ['short ton', 'short tons'], measure: 'mass', words: ['ton', 'tons', 'short ton', 'short tons'] },
  { unit: 'lb', symbol: 'lb', names: ['pound', 'pounds'], intl: 'pound', measure: 'mass', words: ['lb', 'lbs'] },
  { unit: 'oz', symbol: 'oz', names: ['ounce', 'ounces'], intl: 'ounce', measure: 'mass', words: ['oz', 'ounce', 'ounces'] },
  { unit: 'stone', symbol: 'st', names: ['stone', 'stone'], intl: 'stone', measure: 'mass', words: ['stone', 'stones'] },

  { unit: 'degC', symbol: '°C', names: ['degree Celsius', 'degrees Celsius'], intl: 'celsius', measure: 'temperature', words: ['°c', '℃', 'degc', 'celsius', 'centigrade', 'degree celsius', 'degrees celsius'] },
  { unit: 'degF', symbol: '°F', names: ['degree Fahrenheit', 'degrees Fahrenheit'], intl: 'fahrenheit', measure: 'temperature', words: ['°f', '℉', 'degf', 'fahrenheit', 'degree fahrenheit', 'degrees fahrenheit'] },
  { unit: 'K', symbol: 'K', names: ['kelvin', 'kelvin'], measure: 'temperature', words: ['kelvin', 'kelvins'], exact: ['K'] },

  { unit: 'deg', symbol: '°', names: ['degree', 'degrees'], intl: 'degree', measure: 'angle', words: ['°', 'deg', 'degs', 'degree', 'degrees'] },
  { unit: 'rad', symbol: 'rad', names: ['radian', 'radians'], measure: 'angle', words: ['rad', 'rads', 'radian', 'radians'] },

  { unit: 'l', symbol: 'L', names: ['litre', 'litres'], intl: 'liter', measure: 'volume', words: ['liter', 'liters', 'litre', 'litres', 'ltr'], exact: ['l', 'L'] },
  { unit: 'ml', symbol: 'mL', names: ['millilitre', 'millilitres'], intl: 'milliliter', measure: 'volume', words: ['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres'] },
  { unit: 'cl', symbol: 'cL', names: ['centilitre', 'centilitres'], measure: 'volume', words: ['cl', 'centiliter', 'centiliters', 'centilitre', 'centilitres'] },
  { unit: 'dl', symbol: 'dL', names: ['decilitre', 'decilitres'], measure: 'volume', words: ['dl', 'deciliter', 'deciliters', 'decilitre', 'decilitres'] },
  { unit: 'm^3', symbol: 'm³', names: ['cubic metre', 'cubic metres'], measure: 'volume', words: ['m³', 'm3', 'cubic meter', 'cubic meters', 'cubic metre', 'cubic metres'] },
  { unit: 'cm^3', symbol: 'cm³', names: ['cubic centimetre', 'cubic centimetres'], measure: 'volume', words: ['cm³', 'cm3', 'cc', 'cubic centimeter', 'cubic centimeters', 'cubic centimetre', 'cubic centimetres'] },
  { unit: 'ft^3', symbol: 'ft³', names: ['cubic foot', 'cubic feet'], measure: 'volume', words: ['ft³', 'ft3', 'cu ft', 'cubic foot', 'cubic feet'] },
  { unit: 'gallon', symbol: 'gal', names: ['gallon', 'gallons'], intl: 'gallon', measure: 'volume', words: ['gal', 'gals', 'gallon', 'gallons'] },
  { unit: 'quart', symbol: 'qt', names: ['quart', 'quarts'], measure: 'volume', words: ['qt', 'qts', 'quart', 'quarts'] },
  { unit: 'pint', symbol: 'pt', names: ['pint', 'pints'], measure: 'volume', words: ['pt', 'pts', 'pint', 'pints'] },
  { unit: 'cup', symbol: 'cup', names: ['cup', 'cups'], measure: 'volume', words: ['cup', 'cups'] },
  { unit: 'floz', symbol: 'fl oz', names: ['fluid ounce', 'fluid ounces'], intl: 'fluid-ounce', measure: 'volume', words: ['floz', 'fl oz', 'fluid ounce', 'fluid ounces'] },
  { unit: 'tablespoon', symbol: 'tbsp', names: ['tablespoon', 'tablespoons'], measure: 'volume', words: ['tbsp', 'tbs', 'tablespoon', 'tablespoons'] },
  { unit: 'teaspoon', symbol: 'tsp', names: ['teaspoon', 'teaspoons'], measure: 'volume', words: ['tsp', 'teaspoon', 'teaspoons'] },

  { unit: 'm^2', symbol: 'm²', names: ['square metre', 'square metres'], measure: 'area', words: ['m²', 'm2', 'sq m', 'sqm', 'square meter', 'square meters', 'square metre', 'square metres'] },
  { unit: 'km^2', symbol: 'km²', names: ['square kilometre', 'square kilometres'], measure: 'area', words: ['km²', 'km2', 'sq km', 'square kilometer', 'square kilometers', 'square kilometre', 'square kilometres'] },
  { unit: 'cm^2', symbol: 'cm²', names: ['square centimetre', 'square centimetres'], measure: 'area', words: ['cm²', 'cm2', 'sq cm', 'square centimeter', 'square centimeters', 'square centimetre', 'square centimetres'] },
  { unit: 'hectare', symbol: 'ha', names: ['hectare', 'hectares'], intl: 'hectare', measure: 'area', words: ['ha', 'hectare', 'hectares'] },
  { unit: 'acre', symbol: 'ac', names: ['acre', 'acres'], intl: 'acre', measure: 'area', words: ['ac', 'acre', 'acres'] },
  { unit: 'ft^2', symbol: 'ft²', names: ['square foot', 'square feet'], measure: 'area', words: ['ft²', 'ft2', 'sq ft', 'sqft', 'square foot', 'square feet'] },
  { unit: 'inch^2', symbol: 'in²', names: ['square inch', 'square inches'], measure: 'area', words: ['in²', 'sq in', 'square inch', 'square inches'] },
  { unit: 'yd^2', symbol: 'yd²', names: ['square yard', 'square yards'], measure: 'area', words: ['yd²', 'sq yd', 'square yard', 'square yards'] },
  { unit: 'mi^2', symbol: 'mi²', names: ['square mile', 'square miles'], measure: 'area', words: ['mi²', 'mi2', 'sq mi', 'square mile', 'square miles'] },

  { unit: 'm/s', symbol: 'm/s', names: ['metre per second', 'metres per second'], intl: 'meter-per-second', measure: 'speed', words: ['m/s', 'meter per second', 'meters per second', 'metre per second', 'metres per second'] },
  { unit: 'km/h', symbol: 'km/h', names: ['kilometre per hour', 'kilometres per hour'], intl: 'kilometer-per-hour', measure: 'speed', words: ['km/h', 'kph', 'kmh', 'km/hr', 'kmph', 'kilometer per hour', 'kilometers per hour', 'kilometre per hour', 'kilometres per hour'] },
  { unit: 'mph', symbol: 'mph', names: ['mile per hour', 'miles per hour'], intl: 'mile-per-hour', measure: 'speed', words: ['mph', 'mi/h', 'mile per hour', 'miles per hour'] },
  { unit: 'knot', symbol: 'kn', names: ['knot', 'knots'], measure: 'speed', words: ['kn', 'kt', 'kts', 'knot', 'knots'] },
  { unit: 'ft/s', symbol: 'ft/s', names: ['foot per second', 'feet per second'], intl: 'foot-per-second', measure: 'speed', words: ['ft/s', 'foot per second', 'feet per second'] },

  { unit: 'b', symbol: 'bit', names: ['bit', 'bits'], intl: 'bit', measure: 'data', words: ['bit', 'bits'], exact: ['b'] },
  { unit: 'B', symbol: 'B', names: ['byte', 'bytes'], intl: 'byte', measure: 'data', words: ['byte', 'bytes'], exact: ['B'] },
  { unit: 'kB', symbol: 'kB', names: ['kilobyte', 'kilobytes'], intl: 'kilobyte', measure: 'data', words: ['kb', 'kilobyte', 'kilobytes'], exact: ['kB', 'KB'] },
  { unit: 'MB', symbol: 'MB', names: ['megabyte', 'megabytes'], intl: 'megabyte', measure: 'data', words: ['mb', 'megabyte', 'megabytes'] },
  { unit: 'GB', symbol: 'GB', names: ['gigabyte', 'gigabytes'], intl: 'gigabyte', measure: 'data', words: ['gb', 'gig', 'gigs', 'gigabyte', 'gigabytes'] },
  { unit: 'TB', symbol: 'TB', names: ['terabyte', 'terabytes'], intl: 'terabyte', measure: 'data', words: ['tb', 'terabyte', 'terabytes'] },
  { unit: 'PB', symbol: 'PB', names: ['petabyte', 'petabytes'], intl: 'petabyte', measure: 'data', words: ['pb', 'petabyte', 'petabytes'] },
  { unit: 'KiB', symbol: 'KiB', names: ['kibibyte', 'kibibytes'], measure: 'data', words: ['kib', 'kibibyte', 'kibibytes'] },
  { unit: 'MiB', symbol: 'MiB', names: ['mebibyte', 'mebibytes'], measure: 'data', words: ['mib', 'mebibyte', 'mebibytes'] },
  { unit: 'GiB', symbol: 'GiB', names: ['gibibyte', 'gibibytes'], measure: 'data', words: ['gib', 'gibibyte', 'gibibytes'] },
  { unit: 'TiB', symbol: 'TiB', names: ['tebibyte', 'tebibytes'], measure: 'data', words: ['tib', 'tebibyte', 'tebibytes'] },
  { unit: 'kb', symbol: 'kbit', names: ['kilobit', 'kilobits'], intl: 'kilobit', measure: 'data', words: ['kbit', 'kilobit', 'kilobits'], exact: ['Kb'] },
  { unit: 'Mb', symbol: 'Mbit', names: ['megabit', 'megabits'], intl: 'megabit', measure: 'data', words: ['mbit', 'megabit', 'megabits'], exact: ['Mb'] },
  { unit: 'Gb', symbol: 'Gbit', names: ['gigabit', 'gigabits'], intl: 'gigabit', measure: 'data', words: ['gbit', 'gigabit', 'gigabits'], exact: ['Gb'] },
  { unit: 'Tb', symbol: 'Tbit', names: ['terabit', 'terabits'], intl: 'terabit', measure: 'data', words: ['tbit', 'terabit', 'terabits'], exact: ['Tb'] },

  { unit: 'b/s', symbol: 'bit/s', names: ['bit per second', 'bits per second'], measure: 'data rate', words: ['bps', 'bit/s', 'bits per second'] },
  { unit: 'kb/s', symbol: 'kbit/s', names: ['kilobit per second', 'kilobits per second'], intl: 'kilobit-per-second', measure: 'data rate', words: ['kbps', 'kbit/s', 'kilobits per second'] },
  { unit: 'Mb/s', symbol: 'Mbit/s', names: ['megabit per second', 'megabits per second'], intl: 'megabit-per-second', measure: 'data rate', words: ['mbps', 'mbit/s', 'megabits per second'], exact: ['Mb/s'] },
  { unit: 'Gb/s', symbol: 'Gbit/s', names: ['gigabit per second', 'gigabits per second'], intl: 'gigabit-per-second', measure: 'data rate', words: ['gbps', 'gbit/s', 'gigabits per second'], exact: ['Gb/s'] },
  { unit: 'B/s', symbol: 'B/s', names: ['byte per second', 'bytes per second'], measure: 'data rate', words: ['bytes per second'], exact: ['B/s', 'Bps'] },
  { unit: 'kB/s', symbol: 'kB/s', names: ['kilobyte per second', 'kilobytes per second'], intl: 'kilobyte-per-second', measure: 'data rate', words: ['kb/s', 'kilobytes per second'], exact: ['kB/s', 'KB/s', 'kBps', 'KBps'] },
  { unit: 'MB/s', symbol: 'MB/s', names: ['megabyte per second', 'megabytes per second'], intl: 'megabyte-per-second', measure: 'data rate', words: ['mb/s', 'megabytes per second'], exact: ['MBps'] },
  { unit: 'GB/s', symbol: 'GB/s', names: ['gigabyte per second', 'gigabytes per second'], intl: 'gigabyte-per-second', measure: 'data rate', words: ['gb/s', 'gigabytes per second'], exact: ['GBps'] },

  { unit: 'ms', symbol: 'ms', names: ['millisecond', 'milliseconds'], intl: 'millisecond', measure: 'time', words: ['ms', 'msec', 'msecs', 'millisecond', 'milliseconds'] },
  { unit: 's', symbol: 's', names: ['second', 'seconds'], intl: 'second', measure: 'time', words: ['sec', 'secs', 'second', 'seconds'], exact: ['s'] },
  { unit: 'min', symbol: 'min', names: ['minute', 'minutes'], intl: 'minute', measure: 'time', words: ['min', 'mins', 'minute', 'minutes'] },
  { unit: 'h', symbol: 'h', names: ['hour', 'hours'], intl: 'hour', measure: 'time', words: ['h', 'hr', 'hrs', 'hour', 'hours'] },
  { unit: 'day', symbol: 'd', names: ['day', 'days'], intl: 'day', measure: 'time', words: ['d', 'day', 'days'] },
  { unit: 'week', symbol: 'wk', names: ['week', 'weeks'], intl: 'week', measure: 'time', words: ['wk', 'wks', 'week', 'weeks'] },
  { unit: 'month', symbol: 'mo', names: ['month', 'months'], intl: 'month', measure: 'time', words: ['mo', 'mos', 'month', 'months'] },
  { unit: 'year', symbol: 'yr', names: ['year', 'years'], intl: 'year', measure: 'time', words: ['yr', 'yrs', 'year', 'years'] },

  { unit: 'J', symbol: 'J', names: ['joule', 'joules'], measure: 'energy', words: ['joule', 'joules'], exact: ['J'] },
  { unit: 'kJ', symbol: 'kJ', names: ['kilojoule', 'kilojoules'], measure: 'energy', words: ['kj', 'kilojoule', 'kilojoules'] },
  { unit: 'cal', symbol: 'cal', names: ['calorie', 'calories'], measure: 'energy', words: ['cal', 'calorie', 'calories'] },
  { unit: 'kcal', symbol: 'kcal', names: ['kilocalorie', 'kilocalories'], measure: 'energy', words: ['kcal', 'kilocalorie', 'kilocalories'], exact: ['Cal'] },
  { unit: 'Wh', symbol: 'Wh', names: ['watt-hour', 'watt-hours'], measure: 'energy', words: ['wh', 'watt hour', 'watt hours', 'watt-hour', 'watt-hours'] },
  { unit: 'kWh', symbol: 'kWh', names: ['kilowatt-hour', 'kilowatt-hours'], measure: 'energy', words: ['kwh', 'kilowatt hour', 'kilowatt hours', 'kilowatt-hour', 'kilowatt-hours'] },
  { unit: 'MWh', symbol: 'MWh', names: ['megawatt-hour', 'megawatt-hours'], measure: 'energy', words: ['mwh', 'megawatt hour', 'megawatt hours'] },
  { unit: 'BTU', symbol: 'BTU', names: ['BTU', 'BTUs'], measure: 'energy', words: ['btu', 'btus'] },

  { unit: 'W', symbol: 'W', names: ['watt', 'watts'], measure: 'power', words: ['watt', 'watts'], exact: ['W'] },
  { unit: 'kW', symbol: 'kW', names: ['kilowatt', 'kilowatts'], measure: 'power', words: ['kw', 'kilowatt', 'kilowatts'] },
  { unit: 'MW', symbol: 'MW', names: ['megawatt', 'megawatts'], measure: 'power', words: ['megawatt', 'megawatts'], exact: ['MW'] },
  { unit: 'hp', symbol: 'hp', names: ['horsepower', 'horsepower'], measure: 'power', words: ['hp', 'horsepower'] },

  { unit: 'Pa', symbol: 'Pa', names: ['pascal', 'pascals'], measure: 'pressure', words: ['pascal', 'pascals'], exact: ['Pa'] },
  { unit: 'kPa', symbol: 'kPa', names: ['kilopascal', 'kilopascals'], measure: 'pressure', words: ['kpa', 'kilopascal', 'kilopascals'] },
  { unit: 'hPa', symbol: 'hPa', names: ['hectopascal', 'hectopascals'], measure: 'pressure', words: ['hpa', 'hectopascal', 'hectopascals'] },
  { unit: 'bar', symbol: 'bar', names: ['bar', 'bars'], measure: 'pressure', words: ['bar', 'bars'] },
  { unit: 'mbar', symbol: 'mbar', names: ['millibar', 'millibars'], measure: 'pressure', words: ['mbar', 'millibar', 'millibars'] },
  { unit: 'psi', symbol: 'psi', names: ['psi', 'psi'], measure: 'pressure', words: ['psi'] },
  { unit: 'atm', symbol: 'atm', names: ['atmosphere', 'atmospheres'], measure: 'pressure', words: ['atm', 'atmosphere', 'atmospheres'] },
  { unit: 'mmHg', symbol: 'mmHg', names: ['millimetre of mercury', 'millimetres of mercury'], measure: 'pressure', words: ['mmhg'] },

  { unit: 'Hz', symbol: 'Hz', names: ['hertz', 'hertz'], measure: 'frequency', words: ['hz', 'hertz'] },
  { unit: 'kHz', symbol: 'kHz', names: ['kilohertz', 'kilohertz'], measure: 'frequency', words: ['khz', 'kilohertz'] },
  { unit: 'MHz', symbol: 'MHz', names: ['megahertz', 'megahertz'], measure: 'frequency', words: ['mhz', 'megahertz'] },
  { unit: 'GHz', symbol: 'GHz', names: ['gigahertz', 'gigahertz'], measure: 'frequency', words: ['ghz', 'gigahertz'] },

  { unit: 'N', symbol: 'N', names: ['newton', 'newtons'], measure: 'force', words: ['newton', 'newtons'], exact: ['N'] },
  { unit: 'kN', symbol: 'kN', names: ['kilonewton', 'kilonewtons'], measure: 'force', words: ['kilonewton', 'kilonewtons'], exact: ['kN'] }
]

/** Units by the engine's own name ("km", "degC", "m^2"). */
export const UNIT_BY_NAME: ReadonlyMap<string, UnitWord> = new Map(UNITS.map(entry => [entry.unit, entry]))

const exactUnits = new Map<string, UnitWord>()
const looseUnits = new Map<string, UnitWord>()

for (const entry of UNITS) {
  for (const word of entry.exact ?? []) {
    exactUnits.set(word, entry)
  }

  for (const word of entry.words ?? []) {
    looseUnits.set(word.toLowerCase(), entry)
  }
}

/** The unit a word or phrase names: exact spellings first ("B", "Mb", "K"), then any case ("Miles"). */
export function findUnit(text: string): UnitWord | undefined {
  return exactUnits.get(text) ?? looseUnits.get(text.toLowerCase())
}

/** Durations' units as the dates engine names them, to math.js's. */
export const DURATION_UNITS: Readonly<Record<string, string>> = {
  millisecond: 'ms',
  second: 's',
  minute: 'min',
  hour: 'h',
  day: 'day',
  week: 'week',
  month: 'month',
  year: 'year'
}

/** "pound" and "pounds" weigh, unless the other side of the sentence is money: then they are sterling. */
export const POUND_WORDS: ReadonlySet<string> = new Set(['pound', 'pounds'])

/** Units math.js lacks or rounds, defined on load (acre is 4046.86 m² in math.js; the international acre is exact). */
export const UNIT_DEFINITIONS: Readonly<Record<string, { definition: string; prefixes?: 'short' }>> = {
  mph: { definition: '1 mi/h' },
  knot: { definition: '1852 m/h' },
  nmi: { definition: '1852 m' },
  lightyear: { definition: '9460730472580800 m' },
  cal: { definition: '4.184 J', prefixes: 'short' },
  acre: { definition: '4046.8564224 m^2' }
}

/** ISO 4217 codes read as currencies whether or not the ECB publishes a rate for them. */
export const CURRENCY_CODES: ReadonlySet<string> = new Set(
  (
    'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF ' +
    'CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD ' +
    'HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD ' +
    'MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN ' +
    'PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY ' +
    'TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWG'
  ).split(' ')
)

/** Codes read in lower case too ("usd"); the rest only in capitals, since "all", "cup" and "try" are words. */
export const LOWERCASE_CODES: ReadonlySet<string> = new Set(
  'aud brl cad chf cny czk dkk eur gbp hkd huf idr ils inr isk jpy krw mxn myr nok nzd php pln sek sgd thb usd zar rub aed sar twd'.split(' ')
)

/**
 * Currency names to codes. "$" stands for the locale's dollar, "kr" for its krona and "krone" for
 * its krone; "pounds" is not here because it also weighs.
 */
export const CURRENCY_NAMES: Readonly<Record<string, string>> = {
  dollar: '$',
  dollars: '$',
  buck: '$',
  bucks: '$',
  'us dollar': 'USD',
  'us dollars': 'USD',
  'american dollars': 'USD',
  'australian dollar': 'AUD',
  'australian dollars': 'AUD',
  'canadian dollar': 'CAD',
  'canadian dollars': 'CAD',
  'new zealand dollar': 'NZD',
  'new zealand dollars': 'NZD',
  'hong kong dollar': 'HKD',
  'hong kong dollars': 'HKD',
  'singapore dollar': 'SGD',
  'singapore dollars': 'SGD',
  euro: 'EUR',
  euros: 'EUR',
  'pound sterling': 'GBP',
  'pounds sterling': 'GBP',
  'british pound': 'GBP',
  'british pounds': 'GBP',
  sterling: 'GBP',
  quid: 'GBP',
  real: 'BRL',
  reais: 'BRL',
  reals: 'BRL',
  'brazilian real': 'BRL',
  'brazilian reais': 'BRL',
  yen: 'JPY',
  'japanese yen': 'JPY',
  yuan: 'CNY',
  renminbi: 'CNY',
  rmb: 'CNY',
  'chinese yuan': 'CNY',
  rupee: 'INR',
  rupees: 'INR',
  'indian rupee': 'INR',
  'indian rupees': 'INR',
  peso: 'MXN',
  pesos: 'MXN',
  'mexican peso': 'MXN',
  'mexican pesos': 'MXN',
  'philippine peso': 'PHP',
  'philippine pesos': 'PHP',
  franc: 'CHF',
  francs: 'CHF',
  'swiss franc': 'CHF',
  'swiss francs': 'CHF',
  krona: 'SEK',
  kronor: 'SEK',
  'swedish krona': 'SEK',
  'swedish kronor': 'SEK',
  krone: 'krone',
  kroner: 'krone',
  'norwegian krone': 'NOK',
  'norwegian kroner': 'NOK',
  'danish krone': 'DKK',
  'danish kroner': 'DKK',
  'icelandic krona': 'ISK',
  'icelandic kronur': 'ISK',
  rand: 'ZAR',
  won: 'KRW',
  baht: 'THB',
  ringgit: 'MYR',
  zloty: 'PLN',
  zlotys: 'PLN',
  złoty: 'PLN',
  lira: 'TRY',
  liras: 'TRY',
  lire: 'TRY',
  shekel: 'ILS',
  shekels: 'ILS',
  forint: 'HUF',
  forints: 'HUF',
  koruna: 'CZK',
  korunas: 'CZK',
  koruny: 'CZK',
  rupiah: 'IDR',
  leu: 'RON',
  lei: 'RON',
  lev: 'BGN',
  leva: 'BGN',
  ruble: 'RUB',
  rubles: 'RUB',
  rouble: 'RUB',
  roubles: 'RUB',
  hryvnia: 'UAH',
  dirham: 'AED',
  dirhams: 'AED',
  riyal: 'SAR',
  riyals: 'SAR',
  dong: 'VND'
}

/** Currency symbols written before or after the amount; "$", "¥" and "kr" depend on the locale. */
export const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  $: '$',
  US$: 'USD',
  A$: 'AUD',
  AU$: 'AUD',
  C$: 'CAD',
  CA$: 'CAD',
  NZ$: 'NZD',
  HK$: 'HKD',
  S$: 'SGD',
  R$: 'BRL',
  MX$: 'MXN',
  Mex$: 'MXN',
  '€': 'EUR',
  '£': 'GBP',
  '¥': '¥',
  'CN¥': 'CNY',
  'JP¥': 'JPY',
  '₹': 'INR',
  '₩': 'KRW',
  '₺': 'TRY',
  '₪': 'ILS',
  '₱': 'PHP',
  '฿': 'THB',
  '₽': 'RUB',
  '₫': 'VND',
  '₦': 'NGN',
  '₴': 'UAH'
}

/** Currency symbols made of letters, read exactly as written ("Ft" is forint, "ft" feet). */
export const CURRENCY_LETTER_SYMBOLS: Readonly<Record<string, string>> = {
  zł: 'PLN',
  kr: 'kr',
  'kr.': 'kr',
  'Fr.': 'CHF',
  Kč: 'CZK',
  Ft: 'HUF',
  Rs: 'INR',
  'Rs.': 'INR',
  RM: 'MYR',
  Rp: 'IDR'
}

/** Function names people write, to the engine's own ("arcsin" is asin, "lg" is log10). */
export const FUNCTION_NAMES: Readonly<Record<string, string>> = {
  sqrt: 'sqrt',
  cbrt: 'cbrt',
  root: 'nthRoot',
  nthroot: 'nthRoot',
  abs: 'abs',
  round: 'round',
  floor: 'floor',
  ceil: 'ceil',
  ceiling: 'ceil',
  trunc: 'trunc',
  fix: 'trunc',
  sign: 'sign',
  min: 'min',
  max: 'max',
  log: 'log',
  ln: 'ln',
  log10: 'log10',
  lg: 'log10',
  log2: 'log2',
  exp: 'exp',
  sin: 'sin',
  cos: 'cos',
  tan: 'tan',
  asin: 'asin',
  acos: 'acos',
  atan: 'atan',
  arcsin: 'asin',
  arccos: 'acos',
  arctan: 'atan',
  atan2: 'atan2',
  sinh: 'sinh',
  cosh: 'cosh',
  tanh: 'tanh',
  asinh: 'asinh',
  acosh: 'acosh',
  atanh: 'atanh',
  sec: 'sec',
  csc: 'csc',
  cot: 'cot',
  gcd: 'gcd',
  hcf: 'gcd',
  lcm: 'lcm',
  factorial: 'factorial',
  fact: 'factorial',
  ncr: 'combinations',
  choose: 'combinations',
  combinations: 'combinations',
  npr: 'permutations',
  permutations: 'permutations',
  sum: 'sum',
  avg: 'mean',
  average: 'mean',
  mean: 'mean',
  median: 'median',
  hypot: 'hypot',
  mod: 'mod'
}

/** Constants by every name they go by. */
export const CONSTANT_NAMES: Readonly<Record<string, string>> = {
  pi: 'pi',
  π: 'pi',
  e: 'e',
  phi: 'phi',
  φ: 'phi',
  ϕ: 'phi',
  tau: 'tau',
  τ: 'tau'
}

/** Operator words and phrases, to the operator they stand for. */
export const OPERATOR_WORDS: Readonly<Record<string, string>> = {
  plus: '+',
  minus: '-',
  less: '-',
  times: '*',
  'multiplied by': '*',
  'divided by': '/',
  over: '/',
  'to the power of': '^',
  'raised to the power of': '^',
  'raised to': '^',
  mod: 'mod',
  modulo: 'mod',
  percent: '%',
  'per cent': '%',
  pct: '%',
  squared: '²',
  cubed: '³',
  'square root of': '√',
  'square root': '√',
  'cube root of': '∛',
  'cube root': '∛',
  factorial: '!',
  negative: 'neg',
  of: 'of',
  off: 'off',
  on: 'on',
  per: '/'
}

/** Scale words after a number ("3 million", "2.5k", "4 bn"), to the factor. */
export const SCALE_WORDS: Readonly<Record<string, string>> = {
  hundred: '100',
  thousand: '1000',
  thousands: '1000',
  k: '1000',
  grand: '1000',
  million: '1000000',
  millions: '1000000',
  mn: '1000000',
  billion: '1000000000',
  billions: '1000000000',
  bn: '1000000000',
  trillion: '1000000000000',
  trillions: '1000000000000',
  lakh: '100000',
  lakhs: '100000',
  lac: '100000',
  lacs: '100000',
  crore: '10000000',
  crores: '10000000',
  dozen: '12'
}

/** Words for a part or a multiple ("half of 120", "double 15"), as a fraction. */
export const NUMBER_WORDS: Readonly<Record<string, string>> = {
  half: '1/2',
  third: '1/3',
  quarter: '1/4',
  double: '2',
  twice: '2',
  triple: '3',
  thrice: '3'
}

/** Words of the sentence forms and conversions, highlighted as keywords. */
export const KEYWORDS: ReadonlySet<string> = new Set([
  'in',
  'into',
  'to',
  'as',
  'with',
  'what',
  'is',
  'split',
  'ways',
  'way',
  'between',
  'among',
  'people',
  'change',
  'from',
  'sum',
  'total',
  'subtotal',
  'average',
  'avg',
  'mean',
  'plot',
  'graph',
  'draw',
  'by',
  'percentage',
  'increase',
  'decrease',
  'discount',
  'tip',
  'tax'
])
