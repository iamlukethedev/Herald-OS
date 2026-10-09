import type { CommandArg, OsCommand } from '../store/os-commands.ts'
import { slidesDepthCommands } from './slides-depth.ts'
import { fill, gradient, height, office, presentation, run, sheetArgs, shapeKind, slide, slides, theme, width, x, y } from './slides-shared.ts'

/*
 * Herald Slides for Hermes, voice, the command bar and `herald-os slides`. A command works on the
 * `presentation` it names (a file, or an open presentation's name) or on the one in front; open in
 * a window, each change is one step to undo there (a batch of edits too), and the person watches it
 * land. The editor's code loads only when one of these runs.
 */

const agent = () => import('../features/office/slides/agent.ts')

const layout: CommandArg = { name: 'layout', type: 'string', description: 'title, title-content (the default), two-content, comparison, section, title-only, blank or picture-caption; names like “title and content”, “two columns” or “section header” work too' }
const body: CommandArg = { name: 'body', type: 'string', description: 'The slide’s text, one line a bullet (two spaces or a tab at the start go a level deeper; “- ” and “1. ” are read as list markers); for two-content or comparison, a JSON list of two bodies: ["Pros\\nFast", "Cons\\nCostly"]' }
const notes: CommandArg = { name: 'notes', type: 'string', description: 'Speaker notes for the slide' }
const to = (what: string): CommandArg => ({ name: 'to', type: 'string', description: `${what} (full path or ~/…)` })
const overwrite: CommandArg = { name: 'overwrite', type: 'boolean', description: 'Replace a file at to' }

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
      'Read a presentation: its size, theme and transition, its header and footer (date, slide number, footer), and each slide’s number, id, layout, title, text (bullets indented by level), speaker notes, whether it is hidden, its own theme, transition and background where it has them, whether it hides the master’s graphics, and its elements (id, kind, shape, text, box in points, rotation, group, and what a connector joins). An open presentation also says which slide is in front and what is selected. slides.readMaster reads the slide master and its layouts.',
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
    description: 'Put a shape on a slide as one step to undo, filled with the theme’s first accent unless fill or gradient says otherwise, with centred text if given. Without a place it goes in the middle, 240 by 160 points.',
    tier: 'act',
    args: [presentation, slide, shapeKind, x, y, width, height, fill, ...gradient, { name: 'text', type: 'string', description: 'Text in the shape' }],
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
    description:
      'Give a presentation another theme, Herald’s own or a custom one, as one step to undo: its colours and fonts change everywhere they come from the theme; what was picked by hand stays. With slide, only those slides take it, as a theme of their own.',
    tier: 'act',
    args: [presentation, { ...theme, required: true }, slides('the whole deck')],
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
      'Make several changes to a presentation as ONE step to undo: edits is a JSON list of objects, each with an op and that op’s arguments: addSlide (layout, title, body, notes, after), setSlide (slide, title, body, notes, layout, hidden, background), duplicateSlide (slide), moveSlide (slide, to), removeSlide (slide), addText (slide, text, x, y, width, height, size, color, bold, align), addShape (slide, kind, x, y, width, height, fill, gradient, angle, radial, text), addImage (slide, source, x, y, width, height, fit), addTable (slide, cells, x, y, width), setTheme (theme, slide) and replace (find, replacement, all, caseSensitive); and, each with the arguments of the command of its name: setBackground, addMasterText, addMasterShape, addMasterImage, addLogo, removeFromMaster, setPlaceholder, showMasterGraphics, renameLayout, resetMaster, setHeaderFooter, setTransition, group, ungroup, rotate, convertToShapes, addConnector, setCellBorders, setFill and addSlideFromSheet. Each edit sees the presentation as the ones before left it: a slide added by one can be named by its title in the next, and an edit without a slide lands on the slide the one before it went to. If one fails, none is made.',
    tier: 'act',
    args: [
      presentation,
      {
        name: 'edits',
        type: 'string',
        description: 'JSON list: [{"op": "addSlide", "title": "Risks", "body": "Supply\\nHiring"}, {"op": "addShape", "slide": "Risks", "kind": "star", "x": 820, "y": 40, "width": 80, "height": 80}, {"op": "setHeaderFooter", "number": true, "skipTitle": true}, {"op": "setTheme", "theme": "paper"}]',
        required: true
      }
    ],
    run: run('slides.edit', async (args) => (await agent()).edit(args))
  },
  {
    id: 'slides.fromDocument',
    title: 'Make slides from a document',
    description:
      'Turn a Herald Docs document (open, or a file) into slides as one step, as File > New from Document does: a title slide from its title, then each heading’s slides of bullets (its paragraphs and list items, list levels kept), going on over “(continued)” slides as they need; a top heading with headings under it, or a heading with nothing under it, makes a section header; pictures go beside their text or on slides of their own, and tables, quotes and code on slides of their own. Fields read as the text they show, and notes as their numbers with their text in the speaker notes. Into a new presentation named after the document, or added to the end of one.',
    tier: 'act',
    args: [
      { name: 'document', type: 'string', description: 'The document: a .docx, .md or .txt file (full path or ~/…) or the name of an open document as its tab shows it; the one in front in Herald Docs when left out' },
      { ...presentation, description: 'Add the slides to this presentation (an open one’s name, or a .pptx file); a new presentation named after the document when left out' },
      { name: 'level', type: 'number', description: 'The heading level that starts a slide, 1 to 6: deeper headings become bullets of it and higher ones section headers; every heading starts slides when left out' },
      { name: 'notes', type: 'boolean', description: 'Put every paragraph in the speaker notes and keep the bullets short (a talk with a script)' }
    ],
    run: run('slides.fromDocument', async (args, context) => (await agent()).fromDocument(args, context))
  },
  {
    id: 'slides.insertRange',
    title: 'Put a sheet range on a slide',
    description:
      'Put a range of a Herald Sheets workbook (open, or a file) on a slide as a table, as its cells show (formatted numbers and dates), as one step to undo: in place of the slide’s empty text placeholder, else under its title, at a text size its rows fit, or in the box x, y and width give. slide=new puts it on a new slide after the one in front (slides.addSlideFromSheet makes one anywhere, with a title).',
    tier: 'act',
    args: [presentation, { ...slide, description: `${slide.description}; new for a new slide after it` }, ...sheetArgs, { ...x, description: 'Left edge in points from the slide’s left; centred when left out' }, { ...y, description: 'Top edge in points; under the title when left out' }, { ...width, description: 'Width in points; the slide’s text width when left out' }],
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
  },
  ...slidesDepthCommands
]
