---
name: herald-slides
description: Make and change presentations in Herald Slides, the presentation editor in Herald OS - a deck from a topic (an outline first, a title slide, one idea a slide, short bullets, speaker notes, a closing slide), decks from a Herald Docs document and slides of a Herald Sheets range, layouts chosen for the content, the slide master and its layouts (a logo, slide numbers, a footer and the date on every slide, placeholders, backgrounds), themes and custom themes in a brand's colours, transitions, gradients, flowcharts and diagrams with grouped shapes and connectors, table borders, speaker notes for every slide, pictures, tables, text boxes and shapes, reordering, duplicating and hiding slides, find and replace, saving PowerPoint files and exporting PDFs, all through the slides tool
metadata:
  hermes:
    tags: [herald-os, slides, presentation, deck, powerpoint, pptx, talk, pitch, outline, speaker notes, layouts, slide master, logo, slide numbers, footer, themes, custom themes, brand, transitions, gradients, shapes, flowchart, diagram, connectors, groups, table borders, pdf]
---

# Herald Slides

Herald Slides is the presentation editor built into Herald OS. It opens and saves PowerPoint files
(`.pptx`), and the person watches every change land in the Slides window. Use the `slides` tool
whenever they want a deck made or changed: "make a deck about our Q3 results", "turn my report
into slides", "put the budget table on a slide", "add our logo and slide numbers", "make it
darker", "draw the approval process as a flowchart", "export it as a PDF".

## The workflow

1. **Find the deck.** `slides action=list` shows the presentations open in Herald Slides: name,
   path, unsaved edits, the one in front (`active`), its slide in front and what is selected.
   `slides action=list_all` adds what is open in Herald Docs and Sheets, and `os_ui action=state`
   carries the same list as `office`. "This slide" is the slide in front. Name a deck by its file
   (`presentation="~/Documents/Q3 review.pptx"`) or by its tab (`presentation="Q3 review"`); left
   out, a call works on the one in front.
2. **Read before you change anything.** `slides action=read` gives the size, theme, transition,
   header and footer, and each slide's number, id, layout, title, text, speaker notes, whether it
   is hidden, its own theme, transition and background where it has them, and its elements with
   their ids, boxes in points, groups and what each connector joins (`slide=3` for one). Name a
   slide by its number (1 is the first), its id or its title; left out, a call works on the slide
   in front. Name an element by its id from `read` (or its number in the slide's list).
   `slides action=find text="Q2"` lists the slides where something appears.
3. **Write the words yourself.** Titles are short (a few words, no full stop). `body` is one line
   a bullet; two spaces or a tab at the start of a line go a level deeper.
4. **One call, one step.** Every call is one step the person can undo (Ctrl+Z, ⌘Z on a Mac, or
   `slides action=undo`, with `steps=3` for several). Land a whole change in one call. Several
   changes go in one `slides action=edit` (below), never a string of small calls.
5. **Check.** Read the deck back (`slides action=read`) and say in a sentence what you made or
   changed.

An open deck changes in its window. A file that is not open is read, changed and written straight
back to disk: the person is asked first every time, Herald backs the original up the first time
it writes over it, and it refuses when the file holds something it cannot keep (see the end).
Then open it (`slides action=open path="~/Documents/Q3 review.pptx"`; the answer lists the slides
and what Herald shows differently from the file) and work in the window, above all before naming
elements, whose ids a file that is not open may not keep from one call to the next.

## A deck from a topic

1. **Plan the outline first:** the story in 6 to 12 slide titles, from the opening question to
   the answer. When the person wants to see the outline before you build it, give it and wait;
   otherwise build it straight away.
2. **One idea a slide.** A title slide (the deck's title, and a line with who and when), then a
   slide for each point, a section slide between the parts of a long deck, and a closing slide
   (the takeaway, the next steps, or the question to discuss).
3. **Short, parallel bullets:** three to five a slide, each a few words, all built the same way
   ("Cut costs", "Grow sales", "Hire two engineers"). The detail goes in the speaker notes, in
   full sentences: what to say on that slide.
4. **Make it in one call**, with a theme that suits the audience:

```
slides action=new name="Q3 review" theme=herald slides=[
  {"layout": "title", "title": "Q3 review", "body": "Finance team · October 2026"},
  {"title": "Where we landed", "body": "Revenue up 12%\nCosts flat\nMargin at 18%", "notes": "Lead with revenue: it beat the plan by 4 points, mostly from the new subscription tier."},
  {"layout": "two-content", "title": "Subscriptions vs one-off sales", "body": ["Subscriptions\n  Up 31%\n  Churn 2.1%", "One-off sales\n  Down 6%\n  Mostly hardware"], "notes": "The mix keeps moving to subscriptions."},
  {"layout": "section", "title": "Next quarter", "body": "What we will change"},
  {"title": "Three priorities", "body": "Raise prices on the base tier\nCut delivery times\nHire two support staff", "notes": "Ask for a decision on prices today."},
  {"title": "Thank you", "body": "Questions and next steps", "notes": "Close on the price decision."}
]
```

5. **Finish it on the master** in one `edit`: slide numbers and a footer, the logo if they have
   one (below).

`path` saves the new deck at once (a new `.pptx`, never over a file that exists): give it only
when the person said where.

## From a document or a sheet

- **A document becomes a deck:** `slides action=from_document document="~/Documents/Report.docx"`
  makes a new presentation named after it as one step, as File > New from Document does: a title
  slide from its title, then each heading's slides of bullets (its paragraphs and list items, list
  levels kept), going on over "(continued)" slides as they need; a top heading with headings under
  it makes a section header; pictures go beside their text or on slides of their own, and tables,
  quotes and code on slides of their own. Fields read as the text they show, and notes as their
  raised numbers with their text in the speaker notes. `level=2` makes only the second-level
  headings start slides (deeper ones become bullets, higher ones section headers); `notes=true`
  is for a talk with a script (every paragraph in the speaker notes, short bullets on the slides);
  `presentation=` adds the slides to the end of a deck instead. Then read it and tidy it in one
  `edit`: shorter titles, thin slides merged, a closing slide, a theme.
- **Figures from a sheet:** `slides action=insert_range workbook="~/Documents/Budget.xlsx"
  range="A1:D6" slide="Costs"` puts the range on the slide as a table, as its cells show
  (formatted numbers and dates), in place of the slide's empty text placeholder or under its
  title (`x`, `y`, `width` place it yourself; `range=selection` takes what is selected in an open
  workbook). `slides action=add_slide_from_sheet workbook="~/Documents/Budget.xlsx" range="A1:D30"
  title="Budget" after="Costs"` makes a Title Only slide of it, going on over more slides with the
  header row repeated when it is long. Keep a table to what matters (a few rows and columns), and
  add a summary slide with the two or three figures to remember.

## Layouts for the content

- `title`: the deck's first slide; `body` is the line under the title.
- `title-content`: a title and bullets, the default.
- `two-content`: two columns, for comparisons, before and after, pros and cons. Give `body` as a
  list of two bodies and name both sides in the title ("Rent vs buy").
- `comparison`: two columns, each under a bold heading of its own.
- `section`: a big title and a line under it, between the parts of a long deck.
- `title-only`: a title and the room under it, for a table, a picture, a diagram or a big number.
- `blank`: nothing, for a picture that fills the slide.
- `picture-caption`: a title, a picture on the right and a caption on the left (`body` is the
  caption; `add_image` without a place fills the picture's spot).

A big number reads best alone: a `title-only` slide, then `add_text text="12%" size="120"
bold=true align=center` (sizes go from 4 to 400 points) with a smaller line under it. Change a
slide's layout with `set_slide layout=two-content`; its text moves into the new layout's places.

## The slide master and its layouts

What every slide shares lives on the slide master, and what every slide of one layout shares on
that layout: **change the master or a layout rather than every slide.** `slides action=read_master`
shows the master's background, placeholders and elements, each layout with the slides on it, and
the header and footer.

- **Slide numbers, a footer, the date:** `set_header_footer number=true footer="Acme ·
  Confidential" skipTitle=true` (`date=true dateFormat=dmy`, or `dateText="Q3 2026"`). They go in
  the master's own places on every slide; never draw them as text boxes.
- **A logo on every slide:** `add_logo source="~/Pictures/logo.png" corner=top-right` (clear of
  the footer; `layout=title` for title slides only).
- **Drawings on every slide:** `add_master_shape kind=rect x=0 y=0 width=960 height=12
  fill=accent1` (a band), `add_master_text text="Draft"`, `add_master_image` (a watermark);
  `layout=` puts them on one layout's slides. `remove_from_master elements=[...]` takes them off.
- **Placeholders:** `set_placeholder role=title size="36" color=accent1` restyles the master's
  title, and every layout's and slide's title that still looked like it follows; `layout=` and
  `which=` (the second text of `two-content` is 2) reach one layout's, `x`, `y`, `width`,
  `height` move it.
- **Backgrounds:** `set_background layout=master gradient="background2 to background"` behind every
  slide, `layout=section` for section slides, `slide="1, 7"` for some slides; `source=` a picture.
- `show_master_graphics show=false slide=1` hides the logo and bands on a slide (a cover photo),
  `layout=` on a layout's slides; `rename_layout`, and `reset_master` puts Herald's own master
  back (it asks the person first, as `remove_from_master` does).

## Themes and backgrounds

`theme` (on `new`, or `slides action=set_theme theme=midnight`) changes the colours and fonts
everywhere they come from the theme, and keeps what was picked by hand: `herald` (white with navy
text and blue accents, the default), `midnight` (dark navy with light text, for big screens and
keynotes), `paper` (warm cream with serif type, for stories and teaching), `graphite` (dark grey
with yellow accents), `forest` (pale with green accents), `coral` (warm peach and coral, friendly),
`mono` (black and white with a red accent, stark), `ocean` (pale blue and teal, calm), `aurora`
(deep blue with a soft glow, bold), `dune` (a cream-to-sand gradient with serif headings), `slate`
(cool off-white with blue accents, sober), `blossom` (a pale pink gradient) and `ember` (dark warm
brown with orange accents). `set_theme slide="3, 4"` gives some slides a theme of their own.

- **Custom themes:** for a brand, `make_theme name="Acme" from=slate colors={"accent1": "#e4002b",
  "text": "#1d1d1b"} headingFont="Futura" apply=true` saves a theme of the person's own for every
  deck and puts it on this one. `list_themes` lists Herald's and theirs (by id and name);
  `delete_theme` takes one away and asks first. Keep text readable on its backgrounds.
- `set_slide background=accent1` colours one slide (a section slide, the closing slide);
  `set_background gradient="navy to teal" angle=45` gives slides a gradient. Colours are `#rrggbb`,
  names like `navy`, or theme colours `accent1` to `accent6`, `text` and `background`, which follow
  the theme when it changes. `size=standard` on `new` makes a 4:3 deck instead of 16:9.

## Transitions

`slides action=set_transition kind=push slide=all` gives every slide (and the deck) one transition;
without `slide=all` it is the slide in front's own, or `slide="2-4"`'s. Kinds: `none`, `fade`,
`push`, `wipe`, `cover`, `uncover`, `split` and `zoom`; `direction` is the way the new slide
moves (`left` comes in from the right, `right`, `up`, `down`; `in` or `out` for split and zoom),
`duration` its seconds (0.5). Keep to one quiet kind for a whole deck; a different one marks a
section.

## Speaker notes, order and hiding

- Notes for every slide: read the deck, then write them all in one `edit` with a `setSlide` per
  slide (`{"op": "setSlide", "slide": "2", "notes": "..."}`): what to say, in full sentences,
  about a minute a slide, with the numbers on the slide explained.
- `move_slide slide="Risks" to=last` (a number, `first` or `last`), `duplicate_slide slide=3`
  (a copy right after it, notes and all), `set_slide slide=7 hidden=true` (skipped when
  presenting, still in the file), and `remove_slide slide=4`, which deletes it and asks the
  person first.
- Presenting is the person's: they start it from the Slides window.

## Pictures, tables, text and shapes

Boxes are in points from the top-left: a wide slide is 960 by 540, a standard one 720 by 540.
Without a place, things go in the middle or into the slide's empty placeholder.

- Pictures from files (PNG, JPEG, GIF, WebP or BMP): `slides action=add_image slide=3
  source="~/Pictures/team.jpg"`; with `x`, `y`, `width`, `height`, `fit=contain` (all of it),
  `cover` (fills the box, cut to fit) or `stretch`; `fit=slide` fills the whole slide. Use the
  person's pictures, or ones they ask you to find or make.
- Tables: `slides action=add_table slide="Prices" cells=[["Plan", "Price"], ["Base", "$9"],
  ["Pro", "$19"]]` (the first row is the header); or `insert_range` from Herald Sheets. Lines:
  `set_cell_borders range="A1:C1" sides=bottom color=accent1 width=2` (`sides` outer, inner, all,
  top, bottom, left, right or none; cells as a sheet names them, or `row 1`, `column 2`).
- Text boxes: `add_text text="Draft" x=40 y=480 size="18" color=accent2`.
- Shapes: `add_shape kind=roundRect x=600 y=380 width=300 height=100 fill=accent1 text="New in
  Q3"`. `kind` is any of PowerPoint's presets by name, in families: rectangles, basic shapes
  (`hexagon`, `can`, `cloud`, `heart`, `lightningBolt`…), brackets and braces, arrows
  (`rightArrow`, `chevron`, `bentArrow`, `uturnArrow`…), math (`mathPlus`, `mathEqual`…),
  flowchart (`flowChartProcess`, `flowChartDecision`, `flowChartTerminator`,
  `flowChartInputOutput`, `flowChartDocument`…), stars and banners (`star5`, `star12`, `wave`) and
  callouts (`wedgeRoundRectCallout`, `cloudCallout`…); words like circle, star, cylinder or decision
  work too.
- Gradients: `gradient="accent1 to accent2" angle=0` on `add_shape`, or `set_fill
  elements=["shape-2"] gradient=...` (`fill=` a colour, or none) on what is there.

## Diagrams: groups and connectors

A flowchart is shapes joined by connectors: add the shapes (`flowChartTerminator` for start and
end, `flowChartProcess` for steps, `flowChartDecision` for questions) in rows or columns with room
between them, then `add_connector from="shape-1" to="shape-2"` for each arrow. A connector is glued
to the two shapes' nearest connection sites and follows them when they move; `kind=elbow` bends at
right angles, `curved` curves, `arrow` puts its head at the end (the default), the start, both or
neither; `connection_sites element=...` lists a shape's sites for `fromSite` and `toSite`. Build a
whole diagram in one `edit` (an `addShape` per box, then an `addConnector` per arrow, naming the
shapes by their numbers on the slide). Then `group elements=[...]` makes it one thing to move,
`rotate elements=[...] degrees=90` turns elements together, `ungroup` takes a group apart, and
`convert_to_shapes` turns a file's SmartArt into shapes that can be edited.

## Several changes as one step

`slides action=edit edits=[...]` makes every change in order as ONE step to undo, and if one
fails, none is made. Each edit sees the deck as the ones before left it: a slide one edit adds can
be named by its title in the next, and an edit without a slide lands where the one before went.
The ops: `addSlide`, `setSlide`, `duplicateSlide`, `moveSlide`, `removeSlide`, `addText`,
`addShape`, `addImage`, `addTable`, `setTheme` and `replace`; and, with the same arguments as the
actions of the same words, `setBackground`, `addMasterText`, `addMasterShape`, `addMasterImage`,
`addLogo`, `removeFromMaster`, `setPlaceholder`, `showMasterGraphics`, `renameLayout`,
`resetMaster`, `setHeaderFooter`, `setTransition`, `group`, `ungroup`, `rotate`,
`convertToShapes`, `addConnector`, `setCellBorders`, `setFill` and `addSlideFromSheet`. A batch
that removes a slide or something from the master asks the person first, as the action alone does.

```
slides action=edit edits=[
  {"op": "addSlide", "title": "Approval", "layout": "title-only"},
  {"op": "addShape", "kind": "flowChartTerminator", "x": 80, "y": 230, "width": 160, "height": 70, "text": "Request"},
  {"op": "addShape", "kind": "flowChartDecision", "x": 400, "y": 210, "width": 160, "height": 110, "text": "Under $500?"},
  {"op": "addShape", "kind": "flowChartProcess", "x": 720, "y": 230, "width": 160, "height": 70, "text": "Approve"},
  {"op": "addConnector", "from": "2", "to": "3"},
  {"op": "addConnector", "from": "3", "to": "4"},
  {"op": "setHeaderFooter", "number": true, "skipTitle": true},
  {"op": "setTransition", "kind": "fade", "slide": "all"}
]
```

`slides action=replace find="Q2" replacement="Q3"` changes titles, text, shapes, tables and notes
everywhere (`all=false` only the first; leaving out `replacement` deletes the matches).

## Saving and exporting

- Never save unless the person asks. An open deck keeps its unsaved edits (its tab says so), and
  they save with Ctrl+S (⌘S on a Mac) or ask you to.
- "Save it": `slides action=save`. Saving over the deck's own file asks the person every time;
  the first time Herald writes over a file it shows what it cannot keep, and the original goes to
  Herald's Office backups.
- A deck never saved needs a place: `slides action=save to="~/Documents/Q3 review.pptx"`. A file
  that exists is replaced only with `overwrite=true`, which asks first.
- A PDF: `slides action=export_pdf` writes a page a slide (hidden slides left out) to a new file
  in ~/Documents, or `to="~/Desktop/Q3 review.pdf"`. Say where it went.

## What Herald Slides cannot do yet

No animations (a file's animations and automatic timings are not kept), no charts (a file's
charts are approximated, and its SmartArt shows as a drawing until `convert_to_shapes`), videos
shown as their poster frame, sounds left out, and no comments, macros, embedded fonts, sections
or custom shows. Opening a file lists what it had. Say so plainly, and offer what works: a table
or a big-number slide in place of a chart, a diagram of shapes and connectors in place of
SmartArt, a picture exported from Herald Canvas in place of a drawing, a duplicated slide with one
more bullet in place of a build animation.
