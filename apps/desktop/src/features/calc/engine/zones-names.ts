import { canonicalZone } from './dates-calendar.ts'

/*
 * The names a time zone goes by: the city of every IANA id the platform knows, big cities and
 * countries that are not an id's city, common abbreviations, and UTC offsets. Abbreviations name
 * the region's clock, daylight saving included ("PST" in July is Los Angeles time).
 */

/** A zone and the name to show it by. */
export interface ZoneMatch {
  zone: string
  label: string
}

/** City parts of IANA ids that read as plain words, or name a holiday or a person. */
const SKIPPED_CITIES = new Set(['beulah', 'casey', 'center', 'christmas', 'davis', 'dumontdurville', 'easter', 'knox', 'marengo', 'mawson', 'midway', 'monticello', 'new salem', 'oral', 'palmer', 'petersburg', 'resolute', 'rothera', 'stanley', 'syowa', 'tell city', 'troll', 'vevay', 'vincennes', 'vostok', 'wake', 'winamac'])

/** Today's ids for old ones the platform may still list. */
const RENAMED_IDS: Record<string, string> = {
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk'
}

/** Places that are not an id's city, by zone; "Name=Label" shows Label. */
const PLACES: Record<string, string> = {
  'America/New_York': 'NYC=New York, New York City=New York, Brooklyn, Manhattan, Boston, Washington, DC=Washington, Washington DC=Washington, Philadelphia, Philly=Philadelphia, Miami, Atlanta, Orlando, Tampa, Charlotte, Pittsburgh, Baltimore, Newark, Cleveland, Columbus, Raleigh, Florida, Massachusetts, New Jersey, USA, United States, America, Eastern, Eastern Time',
  'America/Chicago': 'Dallas, Houston, Austin, San Antonio, Minneapolis, St Louis, Saint Louis=St Louis, Kansas City, Nashville, New Orleans, Milwaukee, Memphis, Oklahoma City, Texas, Illinois, Central, Central Time',
  'America/Denver': 'Salt Lake City, Albuquerque, El Paso, Boulder, Colorado, Utah, Mountain, Mountain Time',
  'America/Phoenix': 'Tucson, Arizona',
  'America/Los_Angeles': 'San Francisco, SF=San Francisco, LA=Los Angeles, Seattle, Portland, San Diego, San Jose, Sacramento, Oakland, Las Vegas, Vegas=Las Vegas, Silicon Valley, California, Oregon, Nevada, Washington State, Pacific, Pacific Time',
  'America/Anchorage': 'Alaska',
  'Pacific/Honolulu': 'Hawaii',
  'America/Halifax': 'Nova Scotia, Atlantic',
  'America/St_Johns': 'Newfoundland',
  'America/Toronto': 'Canada, Montreal, Montréal, Ottawa, Quebec, Quebec City, Ontario',
  'America/Vancouver': 'British Columbia',
  'America/Edmonton': 'Calgary, Alberta',
  'America/Mexico_City': 'Mexico, CDMX=Mexico City, Guadalajara',
  'America/Puerto_Rico': 'San Juan',
  'America/Havana': 'Cuba',
  'America/Santo_Domingo': 'Dominican Republic',
  'America/Port-au-Prince': 'Haiti',
  'America/Tegucigalpa': 'Honduras',
  'America/Managua': 'Nicaragua',
  'America/Bogota': 'Colombia, Medellín, Medellin',
  'America/Lima': 'Peru',
  'America/Caracas': 'Venezuela',
  'America/Guayaquil': 'Ecuador, Quito',
  'America/La_Paz': 'Bolivia',
  'America/Asuncion': 'Paraguay',
  'America/Montevideo': 'Uruguay',
  'America/Santiago': 'Chile',
  'America/Argentina/Buenos_Aires': 'Argentina',
  'America/Sao_Paulo': 'São Paulo, Sao Paulo=São Paulo, Brazil, Rio, Rio de Janeiro, Brasília, Brasilia=Brasília, Belo Horizonte, Curitiba, Porto Alegre',
  'America/Nuuk': 'Greenland',
  'Atlantic/Reykjavik': 'Iceland',
  'Atlantic/Stanley': 'Falklands, Falkland Islands',
  'Europe/London': 'UK, United Kingdom, Britain, Great Britain, England, Scotland, Wales, Northern Ireland, Edinburgh, Manchester, Birmingham, Glasgow, Liverpool, Leeds, Bristol, Cardiff, Belfast, British Summer=BST',
  'Europe/Dublin': 'Ireland, Cork',
  'Europe/Lisbon': 'Portugal, Porto, Western European=WET',
  'Europe/Madrid': 'Spain, Barcelona, Valencia, Seville, Malaga, Ibiza',
  'Europe/Paris': 'France, Lyon, Marseille, Toulouse, Bordeaux, Central European=CET',
  'Europe/Brussels': 'Belgium, Antwerp',
  'Europe/Amsterdam': 'Netherlands, Holland, Rotterdam, The Hague, Hague=The Hague',
  'Europe/Berlin': 'Germany, Munich, Frankfurt, Hamburg, Cologne, Düsseldorf, Dusseldorf=Düsseldorf, Stuttgart',
  'Europe/Zurich': 'Switzerland, Geneva, Basel, Bern, Lausanne',
  'Europe/Rome': 'Italy, Milan, Venice, Florence, Naples, Turin',
  'Europe/Vienna': 'Austria, Salzburg',
  'Europe/Prague': 'Czechia, Czech Republic',
  'Europe/Bratislava': 'Slovakia',
  'Europe/Budapest': 'Hungary',
  'Europe/Warsaw': 'Poland, Krakow, Kraków',
  'Europe/Copenhagen': 'Denmark',
  'Europe/Oslo': 'Norway',
  'Europe/Stockholm': 'Sweden, Gothenburg',
  'Europe/Helsinki': 'Finland',
  'Europe/Tallinn': 'Estonia',
  'Europe/Riga': 'Latvia',
  'Europe/Vilnius': 'Lithuania',
  'Europe/Athens': 'Greece, Thessaloniki, Eastern European=EET',
  'Europe/Bucharest': 'Romania',
  'Europe/Sofia': 'Bulgaria',
  'Europe/Belgrade': 'Serbia',
  'Europe/Zagreb': 'Croatia',
  'Europe/Ljubljana': 'Slovenia',
  'Europe/Sarajevo': 'Bosnia, Bosnia and Herzegovina',
  'Europe/Skopje': 'North Macedonia',
  'Europe/Tirane': 'Albania, Tirana',
  'Europe/Podgorica': 'Montenegro',
  'Europe/Chisinau': 'Moldova',
  'Europe/Kyiv': 'Ukraine',
  'Europe/Minsk': 'Belarus',
  'Europe/Moscow': 'Russia, St Petersburg, Saint Petersburg=St Petersburg',
  'Europe/Istanbul': 'Turkey, Türkiye, Ankara',
  'Asia/Nicosia': 'Cyprus',
  'Asia/Jerusalem': 'Israel, Tel Aviv, Haifa',
  'Asia/Beirut': 'Lebanon',
  'Asia/Amman': 'Jordan',
  'Asia/Damascus': 'Syria',
  'Asia/Baghdad': 'Iraq',
  'Asia/Tehran': 'Iran',
  'Asia/Riyadh': 'Saudi Arabia, Saudi, Jeddah, Mecca',
  'Asia/Dubai': 'UAE, United Arab Emirates, Emirates, Abu Dhabi, Sharjah, Gulf',
  'Asia/Qatar': 'Doha',
  'Asia/Muscat': 'Oman',
  'Asia/Kabul': 'Afghanistan',
  'Asia/Karachi': 'Pakistan, Lahore, Islamabad',
  'Asia/Kolkata': 'India, Mumbai, Bombay, Delhi, New Delhi, Bangalore, Bengaluru, Chennai, Madras, Hyderabad, Pune, Ahmedabad',
  'Asia/Colombo': 'Sri Lanka',
  'Asia/Kathmandu': 'Nepal',
  'Asia/Thimphu': 'Bhutan',
  'Asia/Dhaka': 'Bangladesh',
  'Asia/Yangon': 'Myanmar, Burma',
  'Asia/Bangkok': 'Thailand, Phuket, Chiang Mai',
  'Asia/Ho_Chi_Minh': 'Vietnam, Viet Nam, Hanoi, Ho Chi Minh City, HCMC=Ho Chi Minh City',
  'Asia/Phnom_Penh': 'Cambodia',
  'Asia/Vientiane': 'Laos',
  'Asia/Kuala_Lumpur': 'Malaysia, KL=Kuala Lumpur, Penang',
  'Asia/Jakarta': 'Indonesia, Surabaya, Bandung',
  'Asia/Makassar': 'Bali, Denpasar',
  'Asia/Manila': 'Philippines, Cebu',
  'Asia/Shanghai': "China, Beijing, Shenzhen, Guangzhou, Chengdu, Hangzhou, Wuhan, Nanjing, Tianjin, Chongqing, Xi'an",
  'Asia/Hong_Kong': 'HK=Hong Kong',
  'Asia/Taipei': 'Taiwan',
  'Asia/Seoul': 'South Korea, Korea, Busan, Incheon',
  'Asia/Pyongyang': 'North Korea',
  'Asia/Tokyo': 'Japan, Kyoto, Osaka, Yokohama, Nagoya, Sapporo, Fukuoka, Kobe',
  'Asia/Ulaanbaatar': 'Mongolia',
  'Asia/Almaty': 'Kazakhstan, Astana',
  'Asia/Tashkent': 'Uzbekistan',
  'Asia/Bishkek': 'Kyrgyzstan',
  'Asia/Dushanbe': 'Tajikistan',
  'Asia/Ashgabat': 'Turkmenistan',
  'Asia/Tbilisi': 'Georgia',
  'Asia/Yerevan': 'Armenia',
  'Asia/Baku': 'Azerbaijan',
  'Asia/Dili': 'Timor-Leste, East Timor',
  'Africa/Cairo': 'Egypt',
  'Africa/Casablanca': 'Morocco, Marrakech, Rabat',
  'Africa/Algiers': 'Algeria',
  'Africa/Tunis': 'Tunisia',
  'Africa/Tripoli': 'Libya',
  'Africa/Lagos': 'Nigeria, Abuja, West Africa',
  'Africa/Accra': 'Ghana',
  'Africa/Abidjan': "Ivory Coast, Côte d'Ivoire",
  'Africa/Dakar': 'Senegal',
  'Africa/Nairobi': 'Kenya, East Africa',
  'Africa/Addis_Ababa': 'Ethiopia',
  'Africa/Dar_es_Salaam': 'Tanzania, Zanzibar',
  'Africa/Kampala': 'Uganda',
  'Africa/Kigali': 'Rwanda',
  'Africa/Khartoum': 'Sudan',
  'Africa/Johannesburg': 'South Africa, Cape Town, Durban, Pretoria',
  'Africa/Harare': 'Zimbabwe',
  'Africa/Lusaka': 'Zambia',
  'Africa/Maputo': 'Mozambique, Central Africa',
  'Africa/Luanda': 'Angola',
  'Africa/Kinshasa': 'Congo, DR Congo, DRC',
  'Africa/Douala': 'Cameroon',
  'Africa/Windhoek': 'Namibia',
  'Africa/Gaborone': 'Botswana',
  'Indian/Antananarivo': 'Madagascar',
  'Indian/Christmas': 'Christmas Island',
  'Australia/Sydney': 'Australia, Canberra, NSW, New South Wales, Australian Eastern=AET',
  'Australia/Melbourne': 'Victoria',
  'Australia/Brisbane': 'Queensland, Gold Coast, Cairns',
  'Australia/Adelaide': 'South Australia, Australian Central=ACST',
  'Australia/Perth': 'Western Australia, Australian Western=AWST',
  'Australia/Hobart': 'Tasmania',
  'Australia/Darwin': 'Northern Territory',
  'Pacific/Auckland': 'New Zealand, NZ, Wellington, Christchurch, Queenstown',
  'Pacific/Apia': 'Samoa',
  'Pacific/Port_Moresby': 'Papua New Guinea, PNG',
  'Pacific/Easter': 'Easter Island',
  'Pacific/Wake': 'Wake Island',
  'Pacific/Midway': 'Midway Islands, Midway Atoll',
  UTC: 'Greenwich Mean=GMT, Coordinated Universal=UTC, Universal=UTC'
}

/** Abbreviations, by the zone whose clock they name. */
const ABBREVIATIONS: Record<string, string> = {
  UTC: 'UTC UT GMT Z',
  'America/New_York': 'ET EST EDT',
  'America/Chicago': 'CT CST CDT',
  'America/Denver': 'MT MST MDT',
  'America/Los_Angeles': 'PT PST PDT',
  'America/Anchorage': 'AKT AKST AKDT',
  'Pacific/Honolulu': 'HST HAST',
  'America/Halifax': 'AST ADT',
  'America/St_Johns': 'NST NDT',
  'America/Sao_Paulo': 'BRT BRST',
  'America/Argentina/Buenos_Aires': 'ART',
  'Europe/London': 'BST',
  'Europe/Lisbon': 'WET',
  'Europe/Paris': 'CET CEST MEZ MESZ',
  'Europe/Athens': 'EET EEST',
  'Europe/Moscow': 'MSK',
  'Europe/Istanbul': 'TRT',
  'Asia/Dubai': 'GST',
  'Asia/Tehran': 'IRST',
  'Asia/Karachi': 'PKT',
  'Asia/Kolkata': 'IST',
  'Asia/Kathmandu': 'NPT',
  'Asia/Bangkok': 'ICT',
  'Asia/Jakarta': 'WIB',
  'Asia/Makassar': 'WITA',
  'Asia/Singapore': 'SGT',
  'Asia/Kuala_Lumpur': 'MYT',
  'Asia/Hong_Kong': 'HKT',
  'Asia/Manila': 'PHT',
  'Asia/Tokyo': 'JST',
  'Asia/Seoul': 'KST',
  'Australia/Perth': 'AWST',
  'Australia/Adelaide': 'ACST ACDT',
  'Australia/Sydney': 'AET AEST AEDT',
  'Pacific/Auckland': 'NZT NZST NZDT',
  'Africa/Johannesburg': 'SAST',
  'Africa/Nairobi': 'EAT',
  'Africa/Lagos': 'WAT',
  'Pacific/Guam': 'CHST'
}

const RENAMED = new Map(Object.entries(RENAMED_IDS))
const LEGACY = new Map(Object.entries(RENAMED_IDS).map(([old, current]) => [current, old]))

/** A name reduced for lookup: lower case, no accents, dots or apostrophes, words split by single spaces. */
function zoneKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

let platform: ReadonlySet<string> | null = null

function platformZones(): ReadonlySet<string> {
  if (!platform) {
    try {
      platform = new Set(Intl.supportedValuesOf('timeZone'))
    } catch {
      platform = new Set()
    }
  }

  return platform
}

function isKnown(zone: string): boolean {
  return platformZones().has(zone) || canonicalZone(zone) !== null
}

/** The id to hand on for a zone: today's name when the platform knows it, else the one it does. */
function currentId(zone: string): string | null {
  const renamed = RENAMED.get(zone)
  if (renamed && isKnown(renamed)) return renamed
  if (isKnown(zone)) return zone
  const legacy = LEGACY.get(zone)

  return legacy && isKnown(legacy) ? legacy : null
}

/** The name to show for a zone: its city ("New York"), or the offset of a fixed one ("UTC+3"). */
export function zoneLabel(zone: string): string {
  if (zone === 'UTC' || zone === 'Etc/UTC' || zone === 'Etc/GMT' || zone === 'GMT') return 'UTC'
  const etc = /^Etc\/GMT([+-])(\d{1,2})$/.exec(zone)
  if (etc) return `UTC${etc[1] === '-' ? '+' : '−'}${etc[2]}`
  const fixed = /^([+-])(\d{2}):(\d{2})$/.exec(zone)
  if (fixed) return `UTC${fixed[1] === '+' ? '+' : '−'}${Number(fixed[2])}${fixed[3] === '00' ? '' : `:${fixed[3]}`}`
  const id = RENAMED.get(zone) ?? zone

  return (id.split('/').pop() ?? id).replace(/_/g, ' ')
}

let table: Map<string, ZoneMatch> | null = null
let spoken: readonly string[] | null = null

function zoneTable(): Map<string, ZoneMatch> {
  if (table) return table
  const built = new Map<string, ZoneMatch>()
  const add = (name: string, zone: string, label: string) => built.set(zoneKey(name), { zone, label })
  for (const id of [...platformZones(), ...RENAMED.values()]) {
    const zone = currentId(id)
    if (!zone) continue
    for (const source of new Set([id, zone])) {
      const city = (source.split('/').pop() ?? source).replace(/_/g, ' ')
      if (source.includes('/') && !SKIPPED_CITIES.has(zoneKey(city))) add(city, zone, zoneLabel(zone))
    }
  }
  for (const [zone, names] of Object.entries(PLACES)) {
    const id = currentId(zone)
    if (!id) continue
    for (const entry of names.split(',')) {
      const [name, label] = entry.trim().split('=')
      add(name, id, label ?? name)
    }
  }
  for (const [zone, abbreviations] of Object.entries(ABBREVIATIONS)) {
    const id = currentId(zone)
    if (id) for (const abbreviation of abbreviations.split(' ')) add(abbreviation, id, abbreviation)
  }
  table = built

  return built
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function readOffset(name: string): ZoneMatch | null {
  const match = /^(utc|gmt|z)?\s*([+\-−])\s*(\d{1,2})(?::?(\d{2}))?$/.exec(name.trim().toLowerCase())
  if (!match) return null
  const hours = Number(match[3])
  const minutes = Number(match[4] ?? 0)
  if (hours > 14 || minutes > 59) return null
  const east = match[2] === '+'
  const prefix = match[1] === 'gmt' ? 'GMT' : 'UTC'
  if (hours === 0 && minutes === 0) return { zone: 'UTC', label: prefix }
  const label = `${prefix}${east ? '+' : '−'}${hours}${minutes ? `:${pad(minutes)}` : ''}`
  const etc = `Etc/GMT${east ? '-' : '+'}${hours}`
  if (minutes === 0 && canonicalZone(etc)) return { zone: etc, label }
  const fixed = `${east ? '+' : '-'}${pad(hours)}:${pad(minutes)}`

  return canonicalZone(fixed) ? { zone: fixed, label } : null
}

/** The zone a place, country, abbreviation, offset or IANA id names, with the name to show; null when none. */
export function lookupZone(name: string): ZoneMatch | null {
  const offset = readOffset(name)
  if (offset) return offset
  const key = zoneKey(name)
  if (!key) return null
  const zones = zoneTable()
  const bare = key.replace(/^the /, '')
  const found = zones.get(key) ?? zones.get(bare) ?? zones.get(bare.replace(/ time$/, '')) ?? zones.get(bare.replace(/ (?:standard|daylight|daylight saving|summer) time$/, ''))
  if (found) return found
  if (!name.includes('/')) return null
  const canonical = canonicalZone(name.trim())
  const id = canonical ? currentId(canonical) : null

  return id ? { zone: id, label: zoneLabel(id) } : null
}

/** Every name lookupZone knows, lower case, with and without accents; no offsets or ids. */
export function knownZoneNames(): readonly string[] {
  if (spoken) return spoken
  const names = new Set(zoneTable().keys())
  for (const entries of Object.values(PLACES)) {
    for (const entry of entries.split(',')) names.add(entry.trim().split('=')[0].toLowerCase())
  }
  spoken = Object.freeze([...names].sort())

  return spoken
}
