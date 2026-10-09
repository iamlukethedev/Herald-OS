import { describe, expect, it } from 'vitest'
import type { CommandSummary } from '../../store/os-commands.ts'
import { type MatchContext, matchIntent, normaliseUtterance } from './intents.ts'

// A slice of the real catalogue's phrases (the registry itself needs the DOM to import).
const commands: CommandSummary[] = [
  { id: 'open.any', title: 'Open', description: '', tier: 'act', hidden: true, args: [{ name: 'name', type: 'string', description: '', required: true }], phrases: ['open {name}', 'show {name}', 'go to {name}', 'show me {name}', 'launch {name}'] },
  { id: 'page.open', title: 'Open a page', description: '', tier: 'read', hidden: false, args: [{ name: 'name', type: 'string', description: '', required: true }], phrases: ['open the {name} page', 'switch to {name}'] },
  { id: 'memory.show', title: 'Show memory', description: '', tier: 'read', hidden: false, args: [{ name: 'query', type: 'string', description: '' }], phrases: ['show my memory', 'open memory', 'what do you remember about {query}', 'search my memory for {query}'] },
  { id: 'memory.add', title: 'Remember something', description: '', tier: 'mutate', hidden: false, args: [{ name: 'text', type: 'string', description: '', required: true }], phrases: ['remember that {text}', 'add {text} to my memory', 'remember {text}'] },
  { id: 'memory.forget', title: 'Forget', description: '', tier: 'destructive', hidden: false, args: [{ name: 'match', type: 'string', description: '', required: true }], phrases: ['forget {match}', 'forget that {match}'] },
  { id: 'window.close', title: 'Close a window', description: '', tier: 'act', hidden: false, args: [{ name: 'name', type: 'string', description: '' }], phrases: ['close {name}', 'close the {name} window', 'close this window'] },
  { id: 'chat.new', title: 'New chat', description: '', tier: 'act', hidden: false, args: [], phrases: ['new chat', 'start a new chat'] },
  { id: 'automation.pause', title: 'Pause an automation', description: '', tier: 'mutate', hidden: false, args: [{ name: 'name', type: 'string', description: '', required: true }], phrases: ['pause the {name} automation', 'pause {name}'] },
  { id: 'mission.start', title: 'Start a mission', description: '', tier: 'mutate', hidden: false, args: [{ name: 'goal', type: 'string', description: '', required: true }], phrases: ['start a mission to {goal}'] },
  { id: 'text.type', title: 'Type text', description: '', tier: 'mutate', hidden: false, args: [{ name: 'text', type: 'string', description: '', required: true }], phrases: ['type {text}'] },
  { id: 'edit.copy', title: 'Copy', description: '', tier: 'act', hidden: false, args: [], phrases: ['copy', 'copy that'] },
  { id: 'window.minimize', title: 'Minimize', description: '', tier: 'act', hidden: false, args: [{ name: 'name', type: 'string', description: '' }], phrases: ['minimize', 'minimize it', 'minimize {name}'] },
  { id: 'file.open', title: 'Open a file', description: '', tier: 'act', hidden: false, args: [{ name: 'name', type: 'string', description: '', required: true }], phrases: ['open the file {name}', 'open file {name}', 'find and open {name}'] },
  {
    id: 'build.start',
    title: 'Build something',
    description: '',
    tier: 'mutate',
    hidden: false,
    args: [
      { name: 'goal', type: 'string', description: '', required: true },
      { name: 'prefix', type: 'string', description: '' }
    ],
    phrases: [{ phrase: 'create a website for {goal}', args: { prefix: 'a website for' } }, { phrase: 'build me an app that {goal}', args: { prefix: 'an app that' } }, 'build me {goal}']
  },
  { id: 'studio.open', title: 'Show the Studio', description: '', tier: 'read', hidden: false, args: [], phrases: ['show me the code', 'show me what youre doing', 'show me'] },
  { id: 'overlay.applications', title: 'Show all apps', description: '', tier: 'read', hidden: false, args: [], phrases: ['show applications', 'open apps', 'open my apps', 'show all apps'] },
  {
    id: 'sidebar.toggle',
    title: 'Toggle sidebar',
    description: '',
    tier: 'read',
    hidden: false,
    args: [{ name: 'collapsed', type: 'boolean', description: '' }],
    phrases: ['toggle the sidebar', { phrase: 'hide the sidebar', args: { collapsed: true } }, { phrase: 'show the sidebar', args: { collapsed: false } }]
  }
]

const match = (text: string) => matchIntent(text, commands)

describe('normaliseUtterance', () => {
  it('drops the wake word, politeness and punctuation', () => {
    expect(normaliseUtterance('Hey Hermes, could you please open Missions?')).toBe('open missions')
    expect(normaliseUtterance('Open the memory page, please.')).toBe('open the memory page')
    expect(normaliseUtterance("I'd like to see my automations now")).toBe('see my automations')
  })
})

describe('matchIntent', () => {
  it('routes simple opens through the open router with articles stripped', () => {
    expect(match('open missions')).toMatchObject({ command: 'open.any', args: { name: 'missions' } })
    expect(match('Hey Hermes, open the memory')).toMatchObject({ command: 'open.any', args: { name: 'memory' } })
    expect(match('show me my downloads')).toMatchObject({ command: 'open.any', args: { name: 'downloads' } })
    expect(match('launch Safari')).toMatchObject({ command: 'open.any', args: { name: 'Safari' } })
  })

  it('prefers the more specific phrase', () => {
    expect(match('open the missions page')).toMatchObject({ command: 'page.open', args: { name: 'missions' } })
    expect(match('close the terminal window')).toMatchObject({ command: 'window.close', args: { name: 'terminal' } })
    expect(match('open memory')).toMatchObject({ command: 'memory.show' })
  })

  it('fills preset arguments from the words', () => {
    expect(match('hide the sidebar')).toMatchObject({ command: 'sidebar.toggle', args: { collapsed: true } })
    expect(match('show the sidebar')).toMatchObject({ command: 'sidebar.toggle', args: { collapsed: false } })
  })

  it('captures free text slots with the original casing', () => {
    expect(match('remember that I prefer short answers')).toMatchObject({ command: 'memory.add', args: { text: 'I prefer short answers' } })
    expect(match('what do you remember about Herald')).toMatchObject({ command: 'memory.show', args: { query: 'Herald' } })
    expect(match('pause the daily digest automation')).toMatchObject({ command: 'automation.pause', args: { name: 'daily digest' } })
    expect(match('start a mission to clean up my downloads')).toMatchObject({ command: 'mission.start', args: { goal: 'clean up my downloads' } })
  })

  it('never runs destructive commands from the fast path', () => {
    expect(match('forget that I like tea')).toBeNull()
  })

  it('hands reasoning and long requests to Hermes', () => {
    expect(match('open the file I was editing yesterday afternoon in the herald project')).toBeNull()
    expect(match('why is my disk full')).toBeNull()
    expect(match('write a summary of my missions')).toBeNull()
    expect(match('stop the dev server on port 3000')).toBeNull()
    expect(match('')).toBeNull()
  })

  it('routes dictation to text.type with the exact words, even when it sounds like a question', () => {
    expect(match('Hey Hermes, type how hi are you?')).toMatchObject({ command: 'text.type', args: { text: 'how hi are you?' } })
    expect(match('type why is the sky blue and write me a long essay about it please')).toMatchObject({ command: 'text.type' })
  })

  it('matches bare editing and window verbs, with British spellings', () => {
    expect(match('copy that')).toMatchObject({ command: 'edit.copy' })
    expect(match('Minimise it.')).toMatchObject({ command: 'window.minimize' })
    expect(match('minimize')).toMatchObject({ command: 'window.minimize', args: {} })
  })

  it('opens the app launcher for "open apps"', () => {
    expect(match('Hey Hermes, open Apps.')).toMatchObject({ command: 'overlay.applications' })
    expect(match('show all apps')).toMatchObject({ command: 'overlay.applications' })
  })

  it('routes spoken file names to the file opener, including mis-heard web addresses', () => {
    expect(match('Open hello.pdf.')).toMatchObject({ command: 'open.any', args: { name: 'hello.pdf' } })
    expect(match('open hello dot pdf')).toMatchObject({ command: 'open.any', args: { name: 'hello dot pdf' } })
    expect(match('open the file Budget.xlsx')).toMatchObject({ command: 'file.open', args: { name: 'Budget.xlsx' } })
    expect(match('www.openhello.pdf')).toMatchObject({ command: 'file.open', args: { name: 'hello.pdf' } })
    expect(match('hello.pdf')).toMatchObject({ command: 'file.open', args: { name: 'hello.pdf' } })
  })

  it('starts builds and opens the Studio', () => {
    expect(match('Hey Hermes, create a website for a hair salon.')).toMatchObject({ command: 'build.start', args: { goal: 'a website for a hair salon' } })
    expect(match('build me an app that tracks my runs')).toMatchObject({ command: 'build.start', args: { goal: 'an app that tracks my runs' } })
    expect(match('build me a portfolio site')).toMatchObject({ command: 'build.start', args: { goal: 'a portfolio site' } })
    // The transcriber often loses the name after "hey", or mishears it.
    expect(match('Hey, create a website for a hair salon.')).toMatchObject({ command: 'build.start', args: { goal: 'a website for a hair salon' } })
    expect(match('Hey herpes, build me a simple landing page for my bakery with a contact form and opening hours')).toMatchObject({ command: 'build.start', args: { goal: 'a simple landing page for my bakery with a contact form and opening hours' } })
    expect(match('Can you make an online store for handmade candles?')).toMatchObject({ command: 'build.start', args: { goal: 'an online store for handmade candles' } })
    expect(match('make the app icon bigger')).toBeNull()
    expect(match('Create a website, create a website for a hair salon.')).toMatchObject({ command: 'build.start', args: { goal: 'a website for a hair salon' } })
    expect(match('Hey, open missions')).toMatchObject({ command: 'open.any', args: { name: 'missions' } })
    expect(match("show me what you're doing")).toMatchObject({ command: 'studio.open' })
    expect(match('show me the code')).toMatchObject({ command: 'studio.open' })
    expect(match('show me my downloads')).toMatchObject({ command: 'open.any' })
  })

  it('reports confidence', () => {
    expect(match('new chat')?.confidence).toBe(1)
    expect(match('open missions')?.confidence).toBeLessThan(1)
  })
})

describe('document requests', () => {
  const withFiles: CommandSummary[] = [
    ...commands,
    { id: 'files.search', title: 'Search files', description: '', tier: 'read', hidden: false, args: [{ name: 'query', type: 'string', description: '', required: true }], phrases: ['find files named {query}', 'search files for {query}', 'find {query} in my files', 'look for {query} in files'] },
    { id: 'files.newFolder', title: 'New folder', description: '', tier: 'mutate', hidden: false, args: [{ name: 'name', type: 'string', description: '', required: true }], phrases: ['create a folder called {name}', 'new folder {name}', 'make a folder named {name}'] },
    { id: 'edit.undo', title: 'Undo', description: '', tier: 'mutate', hidden: false, args: [], phrases: ['undo', 'undo that', 'undo it', 'take that back'] }
  ]
  const route = (text: string, context?: MatchContext) => matchIntent(text, withFiles, context)

  it('hands finding, renaming and filing documents to Hermes, whole', () => {
    for (const text of [
      'Find the invoice from Acme in my Downloads, rename it properly and put it where it belongs.',
      'Hey Hermes, file the invoices in this folder.',
      'file these',
      'Can you rename this file properly?',
      'put it where it belongs',
      'organise my downloads',
      'find the invoice from Acme in my files',
      'show me the invoices in my Downloads',
      'open the invoice from Acme',
      'find and open the Acme invoice',
      'pull up the receipt from the plumber'
    ]) {
      expect(route(text), text).toBeNull()
    }
  })

  it('keeps file names and other commands on the fast path', () => {
    expect(route('open invoice.pdf')).toMatchObject({ command: 'open.any', args: { name: 'invoice.pdf' } })
    expect(route('find files named invoice')).toMatchObject({ command: 'files.search', args: { query: 'invoice' } })
    expect(route('create a folder called Invoices')).toMatchObject({ command: 'files.newFolder', args: { name: 'Invoices' } })
    expect(route('remember that I file my invoices by year')).toMatchObject({ command: 'memory.add', args: { text: 'I file my invoices by year' } })
    expect(route('type rename the file')).toMatchObject({ command: 'text.type', args: { text: 'rename the file' } })
    expect(route('show me my downloads')).toMatchObject({ command: 'open.any', args: { name: 'downloads' } })
  })

  it('sends "undo that" to Hermes right after Hermes acted', () => {
    expect(route('undo that')).toMatchObject({ command: 'edit.undo' })
    expect(route('undo that', { afterHermesAction: true })).toBeNull()
    expect(route('Take that back.', { afterHermesAction: true })).toBeNull()
    expect(route('copy that', { afterHermesAction: true })).toMatchObject({ command: 'edit.copy' })
  })
})

describe('Office requests', () => {
  const command = (id: string, phrases: CommandSummary['phrases'], args: CommandSummary['args'] = []): CommandSummary => ({ id, title: id, description: '', tier: 'act', hidden: false, args, phrases })
  const named = [{ name: 'name', type: 'string' as const, description: '', required: true }]
  const withOffice: CommandSummary[] = [
    ...commands,
    command('edit.undo', ['undo', 'undo that', 'undo it', 'take that back']),
    command('docs.open', ['open herald docs', 'open docs', 'open the word processor']),
    command('docs.new', ['new document', 'start a new document', 'new doc']),
    command('docs.save', ['save the document']),
    command('sheets.open', ['open herald sheets', 'open sheets', 'open the spreadsheet app']),
    command('sheets.new', ['new spreadsheet', 'new workbook', 'start a new spreadsheet']),
    command('sheets.save', ['save the spreadsheet', 'save the workbook']),
    command('slides.open', ['open herald slides', 'open slides', 'open the presentation app']),
    command('slides.new', ['new presentation', 'new deck', 'new slideshow']),
    command('slides.addSlide', ['new slide', 'add a slide']),
    command('slides.save', ['save the presentation']),
    command('window.maximize', ['maximize', 'make it bigger', 'maximize {name}', 'make {name} bigger'], named),
    command('software.install', ['install {name}', 'get me {name}'], named)
  ]
  const route = (text: string) => matchIntent(text, withOffice)

  it('hands making and changing documents, sheets and decks to Hermes, whole', () => {
    for (const text of [
      'Make a budget for my trip.',
      'Hey Hermes, write a cover letter',
      'draft a report on our Q3 numbers',
      'turn this into slides',
      'Make this a table.',
      'convert this into bullet points',
      'Create a presentation about volcanoes.',
      'put together an itinerary',
      'add a total row',
      'Add a column for tax.',
      'fill in the rest of this column',
      'sum the March sales',
      'Summarise this document.',
      'translate this paragraph into Spanish',
      'clean up this sheet',
      'sort this by date',
      'make the heading bold',
      'can you make me a spreadsheet of my expenses',
      'make a slide deck for my app launch',
      'create a presentation about our new web app',
      'build me a budget for my trip',
      'get me a spreadsheet of my monthly costs',
      'create a spreadsheet called Budget',
      'make the title bigger',
      'add a new slide about pricing',
      'insert a table',
      'make this bold',
      'make it more formal',
      'highlight the duplicates',
      'put this in a table'
    ]) {
      expect(route(text), text).toBeNull()
    }
  })

  it('keeps the bare app commands, file names and builds on the fast path', () => {
    expect(route('new document')).toMatchObject({ command: 'docs.new' })
    expect(route('Start a new document.')).toMatchObject({ command: 'docs.new' })
    expect(route('new spreadsheet')).toMatchObject({ command: 'sheets.new' })
    expect(route('start a new spreadsheet')).toMatchObject({ command: 'sheets.new' })
    expect(route('Open Herald Docs')).toMatchObject({ command: 'docs.open' })
    expect(route('open sheets')).toMatchObject({ command: 'sheets.open' })
    expect(route('open the word processor')).toMatchObject({ command: 'docs.open' })
    expect(route('save the document')).toMatchObject({ command: 'docs.save' })
    expect(route('save the workbook')).toMatchObject({ command: 'sheets.save' })
    expect(route('undo')).toMatchObject({ command: 'edit.undo' })
    expect(route('open the file report.docx')).toMatchObject({ command: 'file.open', args: { name: 'report.docx' } })
    expect(route('open budget.xlsx')).toMatchObject({ command: 'open.any', args: { name: 'budget.xlsx' } })
    expect(route('make it bigger')).toMatchObject({ command: 'window.maximize', args: {} })
    expect(route('make the terminal bigger')).toMatchObject({ command: 'window.maximize', args: { name: 'terminal' } })
    expect(route('get me Spotify')).toMatchObject({ command: 'software.install', args: { name: 'Spotify' } })
    expect(route('build me a portfolio site')).toMatchObject({ command: 'build.start', args: { goal: 'a portfolio site' } })
    expect(route('create a website for a hair salon')).toMatchObject({ command: 'build.start' })
    expect(route('remember that I make a budget every month')).toMatchObject({ command: 'memory.add', args: { text: 'I make a budget every month' } })
    expect(route('add the meeting notes to my memory')).toMatchObject({ command: 'memory.add', args: { text: 'meeting notes' } })
    expect(route('hide the sidebar')).toMatchObject({ command: 'sidebar.toggle', args: { collapsed: true } })
  })

  it('keeps the bare Herald Slides commands on the fast path and hands work on a deck to Hermes', () => {
    expect(route('open Herald Slides')).toMatchObject({ command: 'slides.open' })
    expect(route('open slides')).toMatchObject({ command: 'slides.open' })
    expect(route('open the presentation app')).toMatchObject({ command: 'slides.open' })
    expect(route('new presentation')).toMatchObject({ command: 'slides.new' })
    expect(route('New deck.')).toMatchObject({ command: 'slides.new' })
    expect(route('new slideshow')).toMatchObject({ command: 'slides.new' })
    expect(route('new slide')).toMatchObject({ command: 'slides.addSlide' })
    expect(route('Add a slide.')).toMatchObject({ command: 'slides.addSlide' })
    expect(route('save the presentation')).toMatchObject({ command: 'slides.save' })

    for (const text of [
      'add a new slide about pricing',
      'make a slide deck for my app launch',
      'Turn this into slides.',
      'add speaker notes to every slide',
      'make slide 3 a two-column comparison',
      'put my budget table on a slide',
      'go to slide 3',
      'show slide 3',
      'Hey Hermes, create a presentation from my report'
    ]) {
      expect(route(text), text).toBeNull()
    }
  })

  it('still types what follows "type", word for word', () => {
    expect(route('type make this a table')).toMatchObject({ command: 'text.type', args: { text: 'make this a table' } })
    expect(route('Type add a total row.')).toMatchObject({ command: 'text.type', args: { text: 'add a total row.' } })
  })
})
