import type { CommandArg, OsCommand } from '../store/os-commands.ts'
import { color, elements, fill, gradient, height, masterLayout, presentation, run, sheetArgs, shapeKind, slide, slides, width, x, y } from './slides-shared.ts'

/*
 * Herald Slides' depth for Hermes: the slide master and its layouts, backgrounds, the header and
 * footer, custom themes, transitions, groups, connectors, table borders, fills and slides from a
 * sheet. Like the rest of slides.*, a command works on the presentation it names or the one in
 * front, and each change is one step to undo in an open presentation.
 */

const depth = () => import('../features/office/slides/agent-depth.ts')

const source = (what: string): CommandArg => ({ name: 'source', type: 'string', description: `${what}: a picture file, PNG, JPEG, GIF, WebP or BMP (full path or ~/…)`, required: true })

const dash: CommandArg = { name: 'dash', type: 'string', description: 'solid (the default), dash, dot, dashDot or longDash' }

export const slidesDepthCommands: readonly OsCommand[] = [
  {
    id: 'slides.readMaster',
    title: 'Read a presentation’s slide master',
    description:
      'Read a presentation’s slide master and its layouts: the master’s background, its placeholders (title, text, date, footer, slide number: id, place in points, font, size, colour, alignment) and its own elements (logos, bands, text: number, id, kind, box); each layout’s id, name, background, whether its slides show the master’s graphics, its placeholders and elements, and the slides on it; and the header and footer the slides show. Change the master or a layout rather than every slide.',
    tier: 'read',
    args: [presentation, { name: 'layout', type: 'string', description: 'Only this layout (title, title-content…, or its name), with the master; master for the master alone' }],
    run: run('slides.readMaster', async (args) => (await depth()).readMaster(args))
  },
  {
    id: 'slides.setBackground',
    title: 'Set a background',
    description:
      'Give slides, a layout or the slide master a background as one step to undo: a colour, a gradient (gradient, angle, radial) or a picture (source). The master’s shows on every slide whose layout and slide have none of their own, a layout’s on the slides on it; background=none takes a background of their own away so the one underneath shows.',
    tier: 'act',
    args: [
      presentation,
      slides('the slide in front'),
      { name: 'layout', type: 'string', description: 'A layout (title, title-content…, or its name) whose background to set, or master for the slide master’s, in place of slides’' },
      { name: 'background', type: 'string', description: 'A colour: #rrggbb, a name like navy or teal, or a theme colour (accent1 to accent6, text, background); none takes their own background away' },
      ...gradient,
      { ...source('A picture that fills the background'), required: false }
    ],
    run: run('slides.setBackground', async (args) => (await depth()).setBackground(args))
  },
  {
    id: 'slides.addMasterText',
    title: 'Put text on the slide master',
    description:
      'Put a text box on the slide master (so every slide that shows the master’s graphics has it) or on one layout’s slides, as one step to undo: its text, where it goes, its size, colour, boldness and alignment ("Confidential", a tagline). For the date, slide number or footer use slides.setHeaderFooter instead.',
    tier: 'act',
    args: [
      presentation,
      masterLayout('Where it goes'),
      { name: 'text', type: 'string', description: 'What it says', required: true },
      x,
      y,
      { ...width, description: 'Width in points (480 when left out)' },
      { ...height, description: 'Height in points (as tall as its text when left out)' },
      { name: 'size', type: 'number', description: 'Font size in points (24)' },
      color('Text colour'),
      { name: 'bold', type: 'boolean', description: 'Bold' },
      { name: 'align', type: 'string', description: 'left (the default), center, right or justify' }
    ],
    run: run('slides.addMasterText', async (args) => (await depth()).addMasterText(args))
  },
  {
    id: 'slides.addMasterShape',
    title: 'Put a shape on the slide master',
    description:
      'Put a shape on the slide master (so every slide that shows the master’s graphics has it) or on one layout’s slides, as one step to undo: a band across the top, a corner mark, a frame; filled with the theme’s first accent unless fill or gradient says otherwise, with centred text if given.',
    tier: 'act',
    args: [presentation, masterLayout('Where it goes'), shapeKind, x, y, width, height, fill, ...gradient, { name: 'text', type: 'string', description: 'Text in the shape' }],
    run: run('slides.addMasterShape', async (args) => (await depth()).addMasterShape(args))
  },
  {
    id: 'slides.addMasterImage',
    title: 'Put a picture on the slide master',
    description:
      'Put a picture from a file on the slide master or on one layout’s slides, as one step to undo: a watermark, a pattern, a picture behind every slide (for a logo in a corner, slides.addLogo). Without a place it goes in the middle at its own proportions; fit=slide covers the whole slide.',
    tier: 'act',
    args: [
      presentation,
      masterLayout('Where it goes'),
      source('The picture'),
      x,
      y,
      width,
      height,
      { name: 'fit', type: 'string', description: 'With width and height: contain (the default: all of it, at its proportions, in the middle of that box), cover (fills the box, cut to fit) or stretch; slide covers the whole slide' }
    ],
    run: run('slides.addMasterImage', async (args) => (await depth()).addMasterImage(args))
  },
  {
    id: 'slides.addLogo',
    title: 'Put a logo on every slide',
    description: 'Put a logo in a corner of every slide as one step to undo: a picture on the slide master (or on one layout’s slides), set in from the edges, sized to the slide and kept clear of the date, footer and slide number.',
    tier: 'act',
    args: [
      presentation,
      source('The logo'),
      { name: 'corner', type: 'string', description: 'top-right (the default), top-left, bottom-left or bottom-right' },
      { ...width, description: 'Its width in points (96 on a slide 540 high when left out)' },
      masterLayout('Where it goes')
    ],
    run: run('slides.addLogo', async (args) => (await depth()).addLogo(args))
  },
  {
    id: 'slides.removeFromMaster',
    title: 'Take something off the slide master',
    description: 'Take elements off the slide master or its layouts (a logo, a band, text, a placeholder) as one step to undo; slides.readMaster lists them. Every slide that showed them loses them.',
    tier: 'mutate',
    args: [
      presentation,
      { ...elements, description: 'The elements, as a JSON list or with commas between them: their ids as slides.readMaster gives them, or the numbers of the master’s (or the layout’s) own elements', required: true },
      masterLayout('Whose numbered elements they are')
    ],
    run: run('slides.removeFromMaster', async (args) => (await depth()).removeFromMaster(args))
  },
  {
    id: 'slides.setPlaceholder',
    title: 'Change a placeholder of the slide master',
    description:
      'Move, resize or restyle a placeholder of the slide master or a layout as one step to undo, however many of these are given: the title, text, subtitle, date, footer or slide number. Placeholders on layouts and slides that still sat or looked as it did follow, as in PowerPoint; what slides made their own stays.',
    tier: 'act',
    args: [
      presentation,
      masterLayout('Whose placeholder'),
      { name: 'role', type: 'string', description: 'The placeholder: title, subtitle, body (the text), heading, caption, picture, date, footer or number (the slide number)', required: true },
      { name: 'which', type: 'number', description: 'Which of its placeholders of that role, from 1 (two-content’s second text is 2)' },
      { ...x, description: 'Its new left edge in points' },
      { ...y, description: 'Its new top edge in points' },
      { ...width, description: 'Its new width in points' },
      { ...height, description: 'Its new height in points' },
      { name: 'font', type: 'string', description: 'A font family, or heading or body for the theme’s' },
      { name: 'size', type: 'number', description: 'Font size in points' },
      color('Text colour'),
      { name: 'bold', type: 'boolean', description: 'Bold on or off' },
      { name: 'italic', type: 'boolean', description: 'Italic on or off' },
      { name: 'align', type: 'string', description: 'left, center, right or justify' },
      { name: 'anchor', type: 'string', description: 'top, middle or bottom: where its text sits in its box' }
    ],
    run: run('slides.setPlaceholder', async (args) => (await depth()).setPlaceholder(args))
  },
  {
    id: 'slides.showMasterGraphics',
    title: 'Show or hide the master’s graphics',
    description: 'Show or hide the slide master’s graphics (its logo, bands, pictures) on some slides, or on every slide of a layout, as one step to undo (PowerPoint’s Hide Background Graphics).',
    tier: 'act',
    args: [
      presentation,
      { name: 'show', type: 'boolean', description: 'true shows them, false hides them', required: true },
      slides('the slide in front'),
      { name: 'layout', type: 'string', description: 'A layout (title, title-content…, or its name) whose slides show them or not, in place of slides' }
    ],
    run: run('slides.showMasterGraphics', async (args) => (await depth()).showMasterGraphics(args))
  },
  {
    id: 'slides.renameLayout',
    title: 'Rename a layout',
    description: 'Give one of the slide master’s layouts a name of its own, as PowerPoint shows it, as one step to undo; default gives Herald’s back.',
    tier: 'act',
    args: [
      presentation,
      { name: 'layout', type: 'string', description: 'The layout: title, title-content, two-content, comparison, section, title-only, blank or picture-caption, or its name', required: true },
      { name: 'name', type: 'string', description: 'Its new name', required: true }
    ],
    run: run('slides.renameLayout', async (args) => (await depth()).renameLayout(args))
  },
  {
    id: 'slides.resetMaster',
    title: 'Reset the slide master',
    description:
      'Put Herald’s own slide master and layouts back in place of the presentation’s, as one step to undo: the master’s and layouts’ backgrounds, logos and drawings go, and placeholders go back to Herald’s places and looks (what slides say stays). Slides’ own backgrounds and the theme stay.',
    tier: 'mutate',
    args: [presentation],
    run: run('slides.resetMaster', async (args) => (await depth()).resetMaster(args))
  },
  {
    id: 'slides.setHeaderFooter',
    title: 'Set the slides’ date, footer and slide number',
    description:
      'Set what every slide shows in the master’s date, footer and slide number places, as one step to undo, however many of these are given: the date (the day’s, or text of your own), the slide number, the footer’s text, and whether title slides go without. Put slide numbers and a footer here rather than in text boxes.',
    tier: 'act',
    args: [
      presentation,
      { name: 'date', type: 'boolean', description: 'Show the date (true) or not (false)' },
      { name: 'dateFormat', type: 'string', description: 'numeric (10/9/2026, the default), long (Friday, October 9, 2026), dmy (9 October 2026) or mdy (October 9, 2026)' },
      { name: 'dateText', type: 'string', description: 'Text shown in place of the date ("Q3 2026"); today goes back to the day’s date' },
      { name: 'number', type: 'boolean', description: 'Show the slide number (true) or not (false)' },
      { name: 'footer', type: 'string', description: 'The footer’s text, shown on every slide; none takes it off' },
      { name: 'skipTitle', type: 'boolean', description: 'Leave them off title slides (true) or show them there too (false)' }
    ],
    run: run('slides.setHeaderFooter', async (args) => (await depth()).setHeaderFooter(args))
  },
  {
    id: 'slides.listThemes',
    title: 'List the slide themes',
    description: 'The themes a presentation can take: Herald’s own and the custom ones the person made (slides.makeTheme), each with its id, name, fonts, colours (background, text, accent1 to accent6) and background gradient.',
    tier: 'read',
    args: [],
    run: run('slides.listThemes', async () => (await depth()).listThemes())
  },
  {
    id: 'slides.makeTheme',
    title: 'Make a custom theme',
    description:
      'Make a custom theme from an existing one with some of its colours and fonts changed (a brand’s colours, say) under a new name, saved among the person’s themes for every presentation; with apply=true it goes on a presentation too (the whole deck, or the slides given) as one step to undo.',
    tier: 'act',
    args: [
      { name: 'name', type: 'string', description: 'The new theme’s name (no theme has it yet)', required: true },
      { name: 'from', type: 'string', description: 'The theme it starts from: a built-in or custom theme’s id or name; the presentation’s theme when left out' },
      { name: 'colors', type: 'string', description: 'The colours to change, as a JSON object of theme colours: {"accent1": "#0b7d97", "background": "#f2fafc", "text": "#0d2b3a"} (background, text, background2, text2, accent1 to accent6)' },
      { name: 'headingFont', type: 'string', description: 'The font family of its titles' },
      { name: 'bodyFont', type: 'string', description: 'The font family of its text' },
      { ...gradient[0], description: 'A background gradient the theme brings: two or more colours, best its own theme colours ("background2 to background") so they follow it' },
      gradient[1],
      gradient[2],
      { name: 'background', type: 'string', description: 'none takes the background gradient of the theme it starts from away' },
      { name: 'apply', type: 'boolean', description: 'Put it on the presentation too (true)' },
      { ...presentation, description: `With apply: ${presentation.description}` },
      slides('the whole deck')
    ],
    run: run('slides.makeTheme', async (args) => (await depth()).makeTheme(args))
  },
  {
    id: 'slides.deleteTheme',
    title: 'Delete a custom theme',
    description: 'Delete one of the person’s custom themes (by id or name, as slides.listThemes gives them); presentations that use it keep its colours and fonts. Herald’s own themes stay.',
    tier: 'mutate',
    args: [{ name: 'theme', type: 'string', description: 'The custom theme’s id or name', required: true }],
    run: run('slides.deleteTheme', async (args) => (await depth()).deleteTheme(args))
  },
  {
    id: 'slides.setTransition',
    title: 'Set a slide transition',
    description:
      'Set how slides come in when presenting, as one step to undo: a slide’s own transition, several slides’, or every slide’s (slide=all, which makes it the deck’s too): its kind, which way it goes and how long it takes. slides.read shows a slide’s own where it differs from the deck’s.',
    tier: 'act',
    args: [
      presentation,
      slides('the slide in front'),
      { name: 'kind', type: 'string', description: 'none, fade, push, wipe, cover, uncover, split or zoom', required: true },
      {
        name: 'direction',
        type: 'string',
        description: 'push, wipe, cover and uncover: the way the new slide moves: left (in from the right), right (in from the left), up (in from the bottom) or down (in from the top); split and zoom: in or out; the kind’s own when left out'
      },
      { name: 'duration', type: 'number', description: 'How long it takes, in seconds (0.5)' },
      { name: 'orientation', type: 'string', description: 'split: horizontal (the default) or vertical' }
    ],
    run: run('slides.setTransition', async (args) => (await depth()).setTransition(args))
  },
  {
    id: 'slides.group',
    title: 'Group elements',
    description: 'Group elements of a slide (two or more, or groups) so they are picked, moved, resized and turned together, as one step to undo; placeholders stay out of groups. slides.read shows each element’s group.',
    tier: 'act',
    args: [presentation, slide, { ...elements, required: true }],
    run: run('slides.group', async (args) => (await depth()).group(args))
  },
  {
    id: 'slides.ungroup',
    title: 'Ungroup elements',
    description: 'Take a group apart (its outermost level: groups inside it stay) as one step to undo; name any of its elements, or the group’s id as slides.read gives it.',
    tier: 'act',
    args: [presentation, slide, { ...elements, required: true }],
    run: run('slides.ungroup', async (args) => (await depth()).ungroup(args))
  },
  {
    id: 'slides.rotate',
    title: 'Rotate elements',
    description: 'Turn elements of a slide (a group as a whole) by some degrees, together about their middle, as one step to undo; tables move round but stay upright, as in PowerPoint.',
    tier: 'act',
    args: [presentation, slide, { ...elements, required: true }, { name: 'degrees', type: 'number', description: 'How far, clockwise; negative turns anticlockwise', required: true }],
    run: run('slides.rotate', async (args) => (await depth()).rotate(args))
  },
  {
    id: 'slides.convertToShapes',
    title: 'Convert SmartArt to shapes',
    description: 'Turn SmartArt (and other objects a PowerPoint file keeps a drawing for) into a group of ordinary shapes that can be edited, as one step to undo; every such object on the slide when elements is left out.',
    tier: 'act',
    args: [presentation, slide, elements],
    run: run('slides.convertToShapes', async (args) => (await depth()).convertToShapes(args))
  },
  {
    id: 'slides.addConnector',
    title: 'Connect two elements',
    description:
      'Connect two elements of a slide with a line glued to their connection sites, as one step to undo, so it follows them as they move (flowcharts, diagrams). Without sites it joins the two sites nearest each other; slides.connectionSites lists an element’s.',
    tier: 'act',
    args: [
      presentation,
      slide,
      { name: 'from', type: 'string', description: 'The element it starts from: its id as slides.read gives it, or its number', required: true },
      { name: 'to', type: 'string', description: 'The element it ends at: its id as slides.read gives it, or its number', required: true },
      { name: 'fromSite', type: 'number', description: 'The connection site it starts from (slides.connectionSites); the one nearest the other element when left out' },
      { name: 'toSite', type: 'number', description: 'The connection site it ends at; the one nearest the other element when left out' },
      { name: 'kind', type: 'string', description: 'straight (the default), elbow or curved' },
      { name: 'arrow', type: 'string', description: 'end (the default: an arrowhead where it ends), start, both or none' },
      color('Its colour (text when left out)'),
      { ...width, description: 'Its thickness in points (2)' },
      dash
    ],
    run: run('slides.addConnector', async (args) => (await depth()).addConnector(args))
  },
  {
    id: 'slides.connectionSites',
    title: 'List an element’s connection sites',
    description: 'An element’s connection sites, numbered as slides.addConnector takes them: where each is on the slide, in points, and which way it faces.',
    tier: 'read',
    args: [presentation, slide, { name: 'element', type: 'string', description: 'The element: its id as slides.read gives it, or its number', required: true }],
    run: run('slides.connectionSites', async (args) => (await depth()).connectionSites(args))
  },
  {
    id: 'slides.setCellBorders',
    title: 'Set a table’s cell borders',
    description: 'Draw lines on a table’s cells, or take them off, as one step to undo: on some sides of some cells or of all of them, in a colour, thickness and dash.',
    tier: 'act',
    args: [
      presentation,
      slide,
      { name: 'element', type: 'string', description: 'The table: its id as slides.read gives it, or its number; the slide’s only table when left out' },
      { name: 'range', type: 'string', description: 'The cells: A1:C3 or B2 (columns lettered from A, rows numbered from 1), row 1, rows 2-4 or column 3; every cell when left out' },
      { name: 'sides', type: 'string', description: 'all (the default: around and between them), outer, inner, top, bottom, left or right, several with commas between them; none takes the lines off' },
      color('The lines’ colour (text when left out)'),
      { ...width, description: 'The lines’ thickness in points (1)' },
      dash
    ],
    run: run('slides.setCellBorders', async (args) => (await depth()).setCellBorders(args))
  },
  {
    id: 'slides.setFill',
    title: 'Fill shapes and text boxes',
    description: 'Fill shapes and text boxes of a slide with a colour, a gradient (gradient, angle, radial) or nothing, as one step to undo.',
    tier: 'act',
    args: [presentation, slide, { ...elements, required: true }, fill, ...gradient],
    run: run('slides.setFill', async (args) => (await depth()).setFill(args))
  },
  {
    id: 'slides.addSlideFromSheet',
    title: 'Make a slide of a sheet range',
    description:
      'Make a slide of a range of a Herald Sheets workbook (open, or a file) as one step to undo: a Title Only slide titled with its sheet’s name (or title) holding the range as a table, as its cells show (formatted numbers and dates), going on over more slides with the header row repeated when it is long.',
    tier: 'act',
    args: [
      presentation,
      ...sheetArgs,
      { name: 'title', type: 'string', description: 'The slide’s title; the sheet’s name when left out' },
      { name: 'header', type: 'boolean', description: 'The first row is a header row (true, the default)' },
      { name: 'after', type: 'string', description: 'Put it after this slide (number, id or title); at the end when left out' }
    ],
    run: run('slides.addSlideFromSheet', async (args) => (await depth()).addSlideFromSheet(args))
  }
]
