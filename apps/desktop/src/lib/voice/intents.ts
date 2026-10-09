// The voice fast path: match a transcript against the command registry's phrases without a model
// round-trip. Deliberately conservative: only whole-utterance matches count, destructive commands
// never match here (they go to Hermes for the approval card), and anything unmatched is handed to
// Hermes unchanged. Pure, so the grammar is unit-tested in node.
import { type CommandPhrase, type CommandSummary, listCommands } from '../../store/os-commands.ts'
import { dictationRemainder } from './dictation.ts'

export interface IntentMatch {
  command: string
  args: Record<string, unknown>
  title: string
  /** 1 for a literal phrase, lower for slot matches and looser grammars. */
  confidence: number
}

const FILLERS = [
  // The wake phrase as transcribers hear it: "hey Hermes", "hey herpes", "hey, …" with the name lost.
  /^(hey|ok|okay|hi|hello|yo)(?:[,!\s]|\.(?=\s|$))+((hermes|herm[eèi]s|herpes|hermies|harmes|her mess)(?:[,!\s]|\.(?=\s|$))*)?/i,
  /^(hermes|herm[eè]s)(?:[,!\s]|\.(?=\s|$))+/i,
  /^(please|now)[,\s]+/i,
  /^(can|could|would|will) you (please )?/i,
  /^(i want to|i'?d like to|i would like to|i need to|let'?s|just)\s+/i,
  /^(go ahead and|please go ahead and)\s+/i
]

const TRAILERS = [/[,\s]+please$/i, /[,\s]+(for me|now|thanks|thank you)$/i, /[,\s]+hermes$/i]

/** Drop the wake word and leading politeness, keeping the user's casing and punctuation. */
export function stripFillers(text: string): string {
  let out = text.replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim()

  for (let i = 0; i < 3; i++) {
    for (const filler of FILLERS) {
      out = out.replace(filler, '')
    }
  }

  return out.trim()
}

/** American spellings for the few verbs British speakers (and transcribers) spell differently. */
const SPELLINGS: Array<[RegExp, string]> = [
  [/\bminimi[sz]e\b/g, 'minimize'],
  [/\bmaximi[sz]e\b/g, 'maximize'],
  [/\bcolour\b/g, 'color'],
  [/\bfavourites\b/g, 'favorites'],
  [/\bfavourite\b/g, 'favorite'],
  [/\bfull ?screen\b/g, 'fullscreen']
]

/** Lower-case, strip punctuation, drop leading/trailing politeness and the wake word. */
export function normaliseUtterance(text: string): string {
  let out = text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”"`]/g, '')
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  for (let i = 0; i < 3; i++) {
    for (const filler of FILLERS) {
      out = out.replace(filler, '')
    }

    for (const trailer of TRAILERS) {
      out = out.replace(trailer, '')
    }
  }

  for (const [pattern, replacement] of SPELLINGS) {
    out = out.replace(pattern, replacement)
  }

  // Slots compare against plain words; drop remaining apostrophes ("I'm" -> "im") consistently.
  return out.replace(/'/g, '').replace(/[.!?,;:]+$/g, '').trim()
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface CompiledPhrase {
  command: CommandSummary
  regex: RegExp
  slots: string[]
  literalWords: number
  presetArgs: Record<string, unknown>
  /** The phrase says the slot is a name ("find files named {query}"), whatever its words. */
  byName: boolean
}

function compile(command: CommandSummary, phrase: CommandPhrase): CompiledPhrase {
  const text = typeof phrase === 'string' ? phrase : phrase.phrase
  const presetArgs = typeof phrase === 'string' ? {} : phrase.args
  const slots: string[] = []
  const parts = text.split(/(\{[a-zA-Z]+\})/).map(part => {
    const slot = /^\{([a-zA-Z]+)\}$/.exec(part)

    if (slot) {
      slots.push(slot[1])

      // Slots swallow optional articles so "open the missions" and "open missions" both match.
      return '(?:the |my |a |an )?(.+?)'
    }

    return escape(part.toLowerCase()).replace(/\s+/g, '\\s+')
  })
  const literalWords = text
    .replace(/\{[a-zA-Z]+\}/g, '')
    .split(/\s+/)
    .filter(Boolean).length

  return { command, regex: new RegExp(`^${parts.join('')}$`, 'i'), slots, literalWords, presetArgs, byName: /\b(named|called)\b/i.test(text) }
}

let cache: { key: string; compiled: CompiledPhrase[] } | null = null

function compiledFor(commands: readonly CommandSummary[]): CompiledPhrase[] {
  const key = commands.map(c => `${c.id}:${c.phrases.length}`).join('|')

  if (cache?.key === key) {
    return cache.compiled
  }

  const compiled: CompiledPhrase[] = []

  for (const command of commands) {
    if (command.tier === 'destructive') {
      continue
    }

    for (const phrase of command.phrases) {
      compiled.push(compile(command, phrase))
    }
  }

  // Most specific first: more literal words, then fewer slots.
  compiled.sort((a, b) => b.literalWords - a.literalWords || a.slots.length - b.slots.length)
  cache = { key, compiled }

  return compiled
}

/** A single token ending in a common document/media extension. */
const BARE_FILE = /^(?:https?:\/\/)?(?:www\.)?[\w-]+(?:[.-][\w-]+)*\.(?:pdf|docx?|xlsx?|pptx?|key|pages|numbers|txt|md|csv|json|png|jpe?g|gif|heic|webp|svg|mp4|mov|mp3|wav|m4a|rtf|epub)$/i

/**
 * "create / build / make (me) a [few words] website|app|page|store|game …": a request to build
 * something new. Needs "a"/"an" so "make the app icon bigger" (an edit) never matches.
 * Group 1 is the goal ("a website for a hair salon").
 */
const BUILD_REQUEST = /^(?:create|build|make|design|code|develop|generate|put together|spin up)(?: me| us| for me)? ((?:an?|some) (?:[\w'&-]+ ){0,4}?(?:website|web site|site|web page|webpage|landing page|web app|app|application|online store|store|shop|portfolio|blog|game|dashboard|page)\b.*)$/

/** Words that mean the utterance is a request for Hermes to think, not a shell command. */
const HERMES_MARKERS = /\b(why|how come|explain|summari[sz]e|write|draft|fix|debug|refactor|research|compare|analy[sz]e|tell me about|what do you think)\b/i

/**
 * Sorting, renaming or filing documents ("rename it properly and put it where it belongs", "file the
 * invoices in this folder"): Hermes has to read the files first, so no command matches these.
 */
const FILING_REQUEST = /\b(renam(?:e|ing)|organi[sz]e|tidy up|sort (?:out|through)|where (?:it|they|this|these|those|that) (?:belongs?|goes|go|should go))\b|(?:^|\b(?:and|then|to|please|also)\s+)file (?:it|them|this|these|those|that|the|my|all|every|everything)\b/i

/** What Herald Docs, Sheets and Slides make, and the parts of one that a request changes. */
const DOCUMENTS = 'spreadsheet|sheet|workbook|document|doc|report|letter|memo|essay|resume|cv|invoice|quote|estimate|budget|forecast|itinerary|plan|schedule|timetable|rota|agenda|outline|summary|proposal|presentation|deck|slideshow|slide|chart|graph|table|list|checklist|tracker|calendar|timeline|newsletter|brochure|flyer|poster|template|form|minutes|notes'
const PARTS = 'row|column|cell|heading|title|subtitle|header|footer|paragraph|section|sentence|bullet points?|bullets|page numbers|footnote|caption|formula|total|text|words?|line|selection|numbers|values|dates|names'
const LINKS = 'for|about|on|of|with|that|to|from|in|by|and|so|called|named|titled|showing|comparing|listing|covering|tracking|using|based|per|at'
/** A describing word before the noun ("a monthly sales report"), never a link or an article ("a website with a table" is a website). */
const MODIFIER = `(?!(?:${LINKS}|an?|the|my|our|this|it)\\b)[\\w'&-]+`
const THING = `(?:${DOCUMENTS}|${PARTS})s?\\b`

/**
 * Making or changing what a document holds: Hermes does that work in Herald Docs, Sheets and
 * Slides, so these never fill a command's slot ("build me {goal}", "make {name} bigger") or start a
 * build; a whole command phrase ("new document", "make it bigger") still runs.
 */
const OFFICE_REQUESTS: readonly RegExp[] = [
  // "Make a budget for my trip", "create a presentation about volcanoes", "put together an itinerary".
  new RegExp(`^(?:i (?:need|want) |(?:make|create|build|design|generate|prepare|produce|put together|set up|start|draft|write|do|give|get)(?: me| us| for me)? )(?:(?:an?|some|the|my|our|this|that|new) )?(?:${MODIFIER} ){0,3}?(?:${DOCUMENTS})s?(?=$|[,;:]| (?:${LINKS})\\b)`),
  // "Turn this into slides", "make this a table", "put my budget table on a slide".
  new RegExp(`^(?:turn|convert|change|make|format|reformat|transform|put|present|lay out|split|merge) (?:it|this|that|these|those|them|everything|(?:the|this|that|my|our) (?:${MODIFIER} ){0,3}?[\\w'-]+)(?: (?:into|in to|onto|on|to|as|in))? (?:(?:an?|some|the) )?(?:${MODIFIER} ){0,2}?${THING}`),
  // A part by its number or letter: "make slide 3 a two-column comparison", "go to cell B5", "hide column C".
  /^(?:make|turn|change|convert|format|style|move|put|merge|split|duplicate|delete|remove|hide|unhide|show|go to|jump to|select) (?:slide|page|sheet|row|column|cell)s? (?:\d+|[a-z]{1,3}\d*)\b/,
  // "Add a total row", "add a column for tax", "insert a chart"; "add … to my memory" is memory's.
  new RegExp(`^(?:add|insert|append|include) (?!.*\\bto (?:my )?memory$)(?:(?:an?|some|the|another|one more|a new|new|two|three|four|five|\\d+) )?(?:${MODIFIER} ){0,3}?${THING}`),
  // "Sum the March sales", "sort this by date", "translate this paragraph into Spanish", "fill in the rest of this column".
  /^(?:bold|unbold|italici[sz]e|underline|highlight|cent(?:er|re)|align|justify|indent|outdent|capitali[sz]e|uppercase|lowercase|strike ?through|merge|wrap|freeze|unfreeze|sum|total|add up|average|count|calculate|work out|sort|filter|dedupe|de-?duplicate|transpose|translate|proofread|rephrase|reword|rewrite|shorten|lengthen|condense|simplify|reformat|restyle|clean up|fill)\b/,
  // "Make the heading bold", "set the title to Q3 results", "make the first row bigger".
  new RegExp(`^(?:make|set|turn|change|colou?r|format|style|resize) (?:the|this|that|these|those|all the|all|every|each|my) (?:${MODIFIER} ){0,3}?${THING}`),
  // "Make this bold", "make it more formal".
  /^(?:make|turn) (?:it|this|that|these|those|them|everything|the selection) (?:bold|italics?|italici[sz]ed|underlined|bigger|smaller|larger|shorter|longer|uppercase|lowercase|all caps|capitals|cent(?:ered|red)|justified|(?:left|right)[ -]aligned|red|orange|yellow|green|blue|purple|pink|black|white|gr[ae]y|more|less)\b/
]

/** A slot that describes a document by what it is or who sent it ("the invoice from Acme") rather than naming it. */
const DOCUMENT_DESCRIPTION = /\b(invoices?|receipts?|bills|statements?|payslips?|contracts?|from|sent by|dated)\b/i
const NAMED_FILE = /\.[a-z0-9]{1,5}$|\s+dot\s+[a-z0-9]{1,5}$/i

/** Commands that look a file, folder or app up by its name: a description is no name. */
const LOOKUP_COMMANDS = new Set(['open.any', 'file.open', 'files.search'])

/** Commands whose "that" is ambiguous right after Hermes acted. */
const UNDO_COMMANDS = new Set(['edit.undo', 'edit.redo'])

export interface MatchContext {
  /**
   * The previous turn of the conversation was Hermes using its tools (it moved a file, say). "Undo
   * that" then means Hermes's change, so it goes to Hermes instead of the text field's undo.
   */
  afterHermesAction?: boolean
}

/**
 * Match one utterance against the registry. Returns null when nothing matches confidently; the
 * caller then sends the utterance to Hermes. `commands` defaults to the live registry.
 */
export function matchIntent(text: string, commands: readonly CommandSummary[] = listCommands({ includeHidden: true }), context: MatchContext = {}): IntentMatch | null {
  // Dictation first: "type …" keeps the exact words (any length, any question) for the text field.
  const dictated = dictationRemainder(stripFillers(text))
  const typeCommand = commands.find(c => c.id === 'text.type')

  if (dictated && typeCommand) {
    return { command: 'text.type', args: { text: dictated }, title: `Type: ${dictated.slice(0, 60)}`, confidence: 1 }
  }

  const utterance = normaliseUtterance(text)

  // A lone file name ("hello.pdf", or a transcriber's "www.openhello.pdf") means "open that file".
  const bareFile = BARE_FILE.exec(utterance)

  if (bareFile && commands.some(c => c.id === 'file.open')) {
    const name = restoreCasing(text, utterance).replace(/^(?:https?:\/\/)?(?:www\.)?(?:open\s*)?/i, '')

    return { command: 'file.open', args: { name }, title: `Open a file: ${name}`, confidence: 0.8 }
  }

  const office = OFFICE_REQUESTS.some(pattern => pattern.test(utterance))

  // "Create a website for a hair salon where people can book": any length, the Studio takes it from here.
  const build = office ? null : BUILD_REQUEST.exec(utterance)

  if (build && commands.some(c => c.id === 'build.start')) {
    // People repeat themselves ("create a website, create a website for a hair salon"): keep the last ask.
    const repeated = /\b(?:create|build|make)(?: me| us)? ((?:an?|some) .+)$/.exec(build[1])
    const goal = restoreCasing(text, repeated ? repeated[1] : build[1]).trim()

    return { command: 'build.start', args: { goal }, title: `Build: ${goal.slice(0, 60)}`, confidence: 0.85 }
  }

  if (!utterance || utterance.split(' ').length > 14 || HERMES_MARKERS.test(utterance) || FILING_REQUEST.test(utterance)) {
    return null
  }

  for (const entry of compiledFor(commands)) {
    if (office && entry.slots.length > 0) {
      continue
    }

    const match = entry.regex.exec(utterance)

    if (!match) {
      continue
    }

    if (context.afterHermesAction && UNDO_COMMANDS.has(entry.command.id)) {
      return null
    }

    const args: Record<string, unknown> = { ...entry.presetArgs }
    let valid = true

    entry.slots.forEach((slot, index) => {
      const value = (match[index + 1] ?? '').trim()

      if (!value) {
        valid = false
      }

      args[slot] = restoreCasing(text, value)
    })

    if (!valid) {
      continue
    }

    // Slot values that are themselves whole requests ("open the file I edited yesterday") are for Hermes.
    if (entry.slots.some(slot => String(args[slot]).split(' ').length > 6)) {
      continue
    }

    // "Show me the invoice from Acme": only Hermes can find a document by what it says.
    if (LOOKUP_COMMANDS.has(entry.command.id) && !entry.byName && entry.slots.some(slot => describesDocument(String(args[slot])))) {
      continue
    }

    const confidence = entry.slots.length === 0 ? 1 : entry.literalWords >= 2 ? 0.9 : 0.75

    return { command: entry.command.id, args, title: describe(entry.command, args), confidence }
  }

  return null
}

function describesDocument(value: string): boolean {
  return DOCUMENT_DESCRIPTION.test(value) && !NAMED_FILE.test(value.trim())
}

/** Slot values come out of the lower-cased utterance; give them back the user's casing when it is findable. */
export function restoreCasing(original: string, value: string): string {
  const source = original.replace(/[’‘]/g, "'").replace(/'/g, '')
  const index = source.toLowerCase().indexOf(value)

  return index >= 0 ? source.slice(index, index + value.length) : value
}

function describe(command: CommandSummary, args: Record<string, unknown>): string {
  const first = command.args.find(arg => args[arg.name] !== undefined && arg.type === 'string')

  return first ? `${command.title}: ${String(args[first.name])}` : command.title
}
