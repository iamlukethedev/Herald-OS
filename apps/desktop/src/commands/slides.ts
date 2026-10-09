import type { CommandArg, CommandContext, OsCommand } from '../store/os-commands.ts'

/*
 * Herald Slides for Hermes, voice, the command bar and `herald-os slides`. A command works on the
 * `presentation` it names (a file, or an open presentation's name) or on the one in front; open in
 * a window, each change is one step to undo there (a batch of edits too), and the person watches it
 * land. The editor's code loads only when one of these runs.
 */

const agent = () => import('../features/office/slides/agent.ts')
const office = () => import('../features/office/agent.ts')

const presentation: CommandArg = { name: 'presentation', type: 'string', description: 'The presentation: a .pptx file (full path or ~/…) or the name of an open presentation as its tab shows it; the one in front in Herald Slides when left out' }
const slide: CommandArg = { name: 'slide', type: 'string', description: 'A slide: its number (1 is the first), its id, or its title; the slide in front when left out' }
const layout: CommandArg = { name: 'layout', type: 'string', description: 'title, title-content (the default), two-content, comparison, section, title-only, blank or picture-caption; names like “title and content”, “two columns” or “section header” work too' }
const body: CommandArg = { name: 'body', type: 'string', description: 'The slide’s text, one line a bullet (two spaces or a tab at the start go a level deeper; “- ” and “1. ” are read as list markers); for two-content or comparison, a JSON list of two bodies: ["Pros\\nFast", "Cons\\nCostly"]' }
const notes: CommandArg = { name: 'notes', type: 'string', description: 'Speaker notes for the slide' }
const theme: CommandArg = {
  name: 'theme',
  type: 'string',
  description: 'herald (white with navy text and blue accents; the default), midnight (dark navy with light text), paper (warm cream with serif type), graphite (dark grey with yellow accents), forest (pale with green accents), coral (warm peach and coral), mono (black and white with a red accent) or ocean (pale blue and teal)'
}
const x: CommandArg = { name: 'x', type: 'number', description: 'Left edge in points from the slide’s left (a wide slide is 960 by 540 points, a standard one 720 by 540); centred when left out' }
const y: CommandArg = { name: 'y', type: 'number', description: 'Top edge in points from the slide’s top; centred when left out' }
const width: CommandArg = { name: 'width', type: 'number', description: 'Width in points' }
const height: CommandArg = { name: 'height', type: 'number', description: 'Height in points' }
const to = (what: string): CommandArg => ({ name: 'to', type: 'string', description: `${what} (full path or ~/…)` })
const overwrite: CommandArg = { name: 'overwrite', type: 'boolean', description: 'Replace a file at to' }

/** Run where the presentation lives: here, or in its own window (panels mode). */
const run =
  (id: string, work: (args: Record<string, unknown>, context: CommandContext) => Promise<{ summary: string; data?: Record<string, unknown> }>) =>
  async (args: Record<string, unknown>, context: CommandContext) =>
    (await office()).inOwnWindow('slides', id, args, 'presentation', context, () => work(args, context))

export const slidesCommands: readonly OsCommand[] = [
  {
    id: 'slides.open',
    title: 'Open Herald Slides',
    description: 'Open Herald Slides, or open a PowerPoint presentation (.pptx) in it so the person sees it. The answer lists its slides, and anything Herald shows differently from the file.',
    tier: 'act',
    args: [{ name: 'path', type: 'string', description: 'A PowerPoint presentation (full path or ~/…)' }],
    phrases: ['open herald slides', 'open slides', 'open the presentation app'],
    run: async ({ path }) => (await office()).done((await agent()).open({ path }))
  },
  {
    id: 'slides.new',
    title: 'Start a new presentation',
    description:
      'Start a new presentation in Herald Slides and show it: an empty title slide, or a whole deck from a brief in one call with slides (write the titles, bullets and notes yourself). With path it is saved there at once (never over a file that exists).',
    tier: 'act',
    args: [
      { name: 'name', type: 'string', description: 'The tab’s name, and the file name it is offered when saved' },
      { name: 'slides', type: 'string', description: 'The slides it starts with, as a JSON list: [{"layout": "title", "title": "Q3 review", "body": "Finance team"}, {"title": "Results", "body": "Revenue up 12%\\nCosts flat", "notes": "Lead with revenue"}]; the first is a title slide unless its layout says otherwise, the rest title-content' },
      { ...theme, description: `Its theme: ${theme.description}` },
      { name: 'size', type: 'string', description: 'wide (16:9, the default) or standard (4:3)' },
      { name: 'path', type: 'string', description: 'Save it here at once: a new .pptx file (full path or ~/…)' }
    ],
    phrases: ['new presentation', 'new deck', 'new slideshow'],
    run: run('slides.new', async (args, context) => (await agent()).create(args, context))
  },
  {
    id: 'slides.list',
    title: 'What is open in Herald Slides',
    description: 'The presentations open in Herald Slides (name, path, unsaved edits), which one is in front, and the slide in front and what is selected on it in each.',
    tier: 'read',
    args: [],
    run: async () => (await office()).done((await agent()).list())
  },
  {
    id: 'slides.read',
    title: 'Read a presentation',
    description:
      'Read a presentation: its size, theme and transition, and each slide’s number, id, layout, title, text (bullets indented by level), speaker notes, whether it is hidden, and its elements (id, kind, text, box in points). An open presentation also says which slide is in front and what is selected.',
    tier: 'read',
    args: [presentation, { ...slide, description: 'Only this slide: its number (1 is the first), its id, or its title' }],
    run: run('slides.read', async (args) => (await agent()).read(args))
  },
  {
    id: 'slides.find',
    title: 'Find in a presentation',
    description: 'Find text in a presentation’s titles, text, shapes, tables and speaker notes: how many times it appears, and each slide and place with the line around it.',
    tier: 'read',
    args: [presentation, { name: 'text', type: 'string', description: 'What to find', required: true }, { name: 'caseSensitive', type: 'boolean', description: 'Match upper and lower case exactly' }],
    run: run('slides.find', async (args) => (await agent()).find(args))
  },
  {
    id: 'slides.addSlide',
    title: 'Add a slide',
    description: 'Add a slide with a layout, its title, text and speaker notes as one step to undo, after a slide or at the end. A JSON list of two bodies makes a two-column slide.',
    tier: 'act',
    args: [presentation, layout, { name: 'title', type: 'string', description: 'The slide’s title' }, body, notes, { name: 'after', type: 'string', description: 'Put it after this slide (number, id or title); at the end when left out' }],
    phrases: ['new slide', 'add a slide'],
    run: run('slides.addSlide', async (args) => (await agent()).addSlide(args))
  },
  {
    id: 'slides.setSlide',
    title: 'Change a slide',
    description: 'Change a slide as one step to undo, however many of these are given: its title, text, speaker notes, layout (its text moves into the new layout’s places), hidden (skipped when presenting) and background colour.',
    tier: 'act',
    args: [
      presentation,
      slide,
      { name: 'title', type: 'string', description: 'Its new title' },
      { name: 'body', type: 'string', description: 'Its new text in place of what it has, one line a bullet (two spaces or a tab go a level deeper); for two columns, a JSON list of two bodies' },
      { name: 'notes', type: 'string', description: 'Its new speaker notes' },
      layout,
      { name: 'hidden', type: 'boolean', description: 'Hide the slide when presenting (true) or show it again (false)' },
      { name: 'background', type: 'string', description: 'Its background colour: #rrggbb, a name like navy or teal, or a theme colour (accent1 to accent6, text, background); theme goes back to the theme’s' }
    ],
    run: run('slides.setSlide', async (args) => (await agent()).setSlide(args))
  },
  {
    id: 'slides.duplicateSlide',
    title: 'Duplicate a slide',
    description: 'Copy a slide, everything on it and its notes, to right after it, as one step to undo.',
    tier: 'act',
    args: [presentation, slide],
    run: run('slides.duplicateSlide', async (args) => (await agent()).duplicateSlide(args))
  },
  {
    id: 'slides.moveSlide',
    title: 'Move a slide',
    description: 'Move a slide to another place in the presentation as one step to undo.',
    tier: 'act',
    args: [presentation, slide, { name: 'to', type: 'string', description: 'Its new number (1 is the first), or first or last', required: true }],
    run: run('slides.moveSlide', async (args) => (await agent()).moveSlide(args))
  },
  {
    id: 'slides.removeSlide',
    title: 'Remove a slide',
    description: 'Remove a slide and everything on it (one step to undo in an open presentation). The only slide left is emptied instead.',
    tier: 'mutate',
    args: [presentation, { ...slide, description: 'The slide to remove: its number (1 is the first), its id, or its title', required: true }],
    run: run('slides.removeSlide', async (args) => (await agent()).removeSlide(args))
  },
  {
    id: 'slides.addText',
    title: 'Add a text box to a slide',
    description: 'Put a text box on a slide as one step to undo: its text (a paragraph a line), where it goes and how big, its size, colour, boldness and alignment. Without a place it goes in the middle, its box as tall as its text.',
    tier: 'act',
    args: [
      presentation,
      slide,
      { name: 'text', type: 'string', description: 'What it says', required: true },
      x,
      y,
      { ...width, description: 'Width in points (480 when left out)' },
      { ...height, description: 'Height in points (as tall as its text when left out)' },
      { name: 'size', type: 'number', description: 'Font size in points (24)' },
      { name: 'color', type: 'string', description: 'Text colour: #rrggbb, a name like navy or teal, or a theme colour (accent1 to accent6, text, background)' },
      { name: 'bold', type: 'boolean', description: 'Bold' },
      { name: 'align', type: 'string', description: 'left (the default), center, right or justify' }
    ],
    run: run('slides.addText', async (args) => (await agent()).addText(args))
  },
  {
    id: 'slides.addShape',
    title: 'Add a shape to a slide',
    description: 'Put a shape on a slide as one step to undo, filled with the theme’s first accent unless fill says otherwise, with centred text if given. Without a place it goes in the middle, 240 by 160 points.',
    tier: 'act',
    args: [
      presentation,
      slide,
      {
        name: 'kind',
        type: 'string',
        description: 'rect (the default), roundRect, ellipse, triangle, rtTriangle, diamond, parallelogram, trapezoid, pentagon, hexagon, octagon, plus, star5, rightArrow, leftArrow, upArrow, downArrow, leftRightArrow, chevron, homePlate, wedgeRectCallout or wedgeRoundRectCallout; words like rectangle, circle, star, arrow or callout work too'
      },
      x,
      y,
      width,
      height,
      { name: 'fill', type: 'string', description: 'Fill colour: #rrggbb, a name like navy or teal, a theme colour (accent1 to accent6, text, background), or none' },
      { name: 'text', type: 'string', description: 'Text in the shape' }
    ],
    run: run('slides.addShape', async (args) => (await agent()).addShape(args))
  },
  {
    id: 'slides.addImage',
    title: 'Put a picture on a slide',
    description: 'Put a picture from a file (PNG, JPEG, GIF, WebP or BMP) on a slide as one step to undo. Without a place it fills the slide’s empty picture placeholder, or goes in the middle at its own proportions.',
    tier: 'act',
    args: [
      presentation,
      slide,
      { name: 'source', type: 'string', description: 'The picture file (full path or ~/…)', required: true },
      x,
      y,
      width,
      height,
      { name: 'fit', type: 'string', description: 'With width and height: contain (the default: all of it, at its proportions, in the middle of that box), cover (fills the box, cut to fit) or stretch; slide fills the whole slide, cut to fit' }
    ],
    run: run('slides.addImage', async (args) => (await agent()).addImage(args))
  },
  {
    id: 'slides.addTable',
    title: 'Put a table on a slide',
    description: 'Put a table on a slide as one step to undo, the first row a header row. Without a place it takes the slide’s empty text placeholder, or goes under the title, three quarters of the slide wide.',
    tier: 'act',
    args: [
      presentation,
      slide,
      { name: 'cells', type: 'string', description: 'The cells as JSON rows: [["Item", "Cost"], ["Rent", "1200"]]' },
      { name: 'rows', type: 'number', description: 'Rows, for an empty table' },
      { name: 'columns', type: 'number', description: 'Columns, for an empty table' },
      x,
      y,
      width
    ],
    run: run('slides.addTable', async (args) => (await agent()).addTable(args))
  },
  {
    id: 'slides.setTheme',
    title: 'Change a presentation’s theme',
    description: 'Give a presentation another theme as one step to undo: its colours and fonts change everywhere they come from the theme; what was picked by hand stays.',
    tier: 'act',
    args: [presentation, { ...theme, required: true }],
    run: run('slides.setTheme', async (args) => (await agent()).setTheme(args))
  },
  {
    id: 'slides.replace',
    title: 'Find and replace in a presentation',
    description: 'Replace text across a presentation’s titles, text, shapes, tables and speaker notes as one step to undo: every match (the default) or the first; each replacement keeps the formatting where its match starts. An empty replacement deletes the matches.',
    tier: 'act',
    args: [
      presentation,
      { name: 'find', type: 'string', description: 'The text to replace', required: true },
      { name: 'replacement', type: 'string', description: 'What goes in its place (nothing deletes it)' },
      { name: 'all', type: 'boolean', description: 'Every match (true, the default) or only the first (false)' },
      { name: 'caseSensitive', type: 'boolean', description: 'Match upper and lower case exactly' }
    ],
    run: run('slides.replace', async (args) => (await agent()).replace(args))
  },
  {
    id: 'slides.edit',
    title: 'Make several edits in a presentation at once',
    description:
      'Make several changes to a presentation as ONE step to undo: edits is a JSON list of objects, each with an op and that op’s arguments: addSlide (layout, title, body, notes, after), setSlide (slide, title, body, notes, layout, hidden, background), duplicateSlide (slide), moveSlide (slide, to), removeSlide (slide), addText (slide, text, x, y, width, height, size, color, bold, align), addShape (slide, kind, x, y, width, height, fill, text), addImage (slide, source, x, y, width, height, fit), addTable (slide, cells, x, y, width), setTheme (theme) and replace (find, replacement, all, caseSensitive). Each edit sees the presentation as the ones before left it: a slide added by one can be named by its title in the next, and an edit without a slide lands on the slide the one before it went to. If one fails, none is made.',
    tier: 'act',
    args: [presentation, { name: 'edits', type: 'string', description: 'JSON list: [{"op": "addSlide", "title": "Risks", "body": "Supply\\nHiring"}, {"op": "addShape", "slide": "Risks", "kind": "star", "x": 820, "y": 40, "width": 80, "height": 80}, {"op": "setTheme", "theme": "paper"}]', required: true }],
    run: run('slides.edit', async (args) => (await agent()).edit(args))
  },
  {
    id: 'slides.fromDocument',
    title: 'Make slides from a document',
    description:
      'Turn a Herald Docs document (open, or a file) into slides as one step: a title slide from its title, then a slide for each heading of a level with its list items and short paragraphs as bullets (deeper headings and nested lists a level deeper), long paragraphs shortened with the whole of them in the speaker notes, tables on slides of their own, more than eight bullets continued on another slide, and section slides for the headings above that level. Into a new presentation named after the document, or added to the end of one.',
    tier: 'act',
    args: [
      { name: 'document', type: 'string', description: 'The document: a .docx, .md or .txt file (full path or ~/…) or the name of an open document as its tab shows it; the one in front in Herald Docs when left out' },
      { ...presentation, description: 'Add the slides to this presentation (an open one’s name, or a .pptx file); a new presentation named after the document when left out' },
      { name: 'level', type: 'number', description: 'The heading level that starts a slide, 1 to 6; by default the document’s top level below its title' },
      { name: 'notes', type: 'boolean', description: 'Put every paragraph in the speaker notes and keep the bullets short (a talk with a script)' }
    ],
    run: run('slides.fromDocument', async (args, context) => (await agent()).fromDocument(args, context))
  },
  {
    id: 'slides.insertRange',
    title: 'Put a sheet range on a slide',
    description: 'Put a range of a Herald Sheets workbook (open, or a file) on a slide as a table, as its cells show (formatted numbers and dates), as one step to undo. Without a range, the workbook’s selection, or else its sheet’s cells that hold something.',
    tier: 'act',
    args: [
      presentation,
      slide,
      { name: 'workbook', type: 'string', description: 'The workbook: a file (full path or ~/…) or an open workbook’s name; the one in front in Herald Sheets when left out' },
      { name: 'range', type: 'string', description: 'The cells, like A1:D12 or \'Q1 sales\'!B2:F9; selection for what is selected' },
      { name: 'sheet', type: 'string', description: 'The sheet, when the range does not name it' },
      x,
      y,
      width
    ],
    run: run('slides.insertRange', async (args) => (await agent()).insertRange(args))
  },
  {
    id: 'slides.save',
    title: 'Save a presentation',
    description:
      'Save a presentation open in Herald Slides: over its own file, or as a new .pptx with to (an existing file is replaced only with overwrite=true). Saving over a file follows Herald’s policy: the first time, the person sees what Herald cannot keep, and the original goes to Herald’s Office backups. A file that is not open is saved as another file with to.',
    tier: 'mutate',
    args: [presentation, to('Save as this .pptx file instead'), overwrite],
    phrases: ['save the presentation'],
    run: run('slides.save', async (args) => (await agent()).save(args))
  },
  {
    id: 'slides.exportPdf',
    title: 'Export a presentation as a PDF',
    description: 'Write a presentation as a PDF, a page a slide (hidden slides left out): to a file you name, or a new file in ~/Documents. An existing file is replaced only with overwrite=true.',
    tier: 'act',
    args: [presentation, to('The PDF to write'), overwrite],
    run: run('slides.exportPdf', async (args) => (await agent()).exportPdf(args))
  },
  {
    id: 'slides.undo',
    title: 'Undo in Herald Slides',
    description: 'Undo the last change to a presentation open in Herald Slides, whoever made it (each Hermes change is one step, a batch of edits too); steps undoes several.',
    tier: 'act',
    args: [presentation, { name: 'steps', type: 'number', description: 'How many steps (1)' }],
    run: run('slides.undo', async (args) => (await agent()).step('undo', args))
  },
  {
    id: 'slides.redo',
    title: 'Redo in Herald Slides',
    description: 'Redo what was last undone in a presentation open in Herald Slides; steps redoes several.',
    tier: 'act',
    args: [presentation, { name: 'steps', type: 'number', description: 'How many steps (1)' }],
    run: run('slides.redo', async (args) => (await agent()).step('redo', args))
  }
]
