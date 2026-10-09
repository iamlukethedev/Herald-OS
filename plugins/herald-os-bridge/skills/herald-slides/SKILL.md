---
name: herald-slides
description: Make and change presentations in Herald Slides, the presentation editor in Herald OS - a deck from a topic (an outline first, a title slide, one idea a slide, short bullets, speaker notes, a closing slide), slides from a Herald Docs document, a Herald Sheets table on a slide, layouts chosen for the content, themes, speaker notes for every slide, pictures, tables, text boxes and shapes, reordering, duplicating and hiding slides, find and replace, saving PowerPoint files and exporting PDFs, all through the slides tool
metadata:
  hermes:
    tags: [herald-os, slides, presentation, deck, powerpoint, pptx, talk, pitch, outline, speaker notes, layouts, themes, pdf]
---

# Herald Slides

Herald Slides is the presentation editor built into Herald OS. It opens and saves PowerPoint files
(`.pptx`), and the person watches every change land in the Slides window. Use the `slides` tool
whenever they want a deck made or changed: "make a deck about our Q3 results", "turn my report
into slides", "put the budget table on a slide", "add speaker notes", "move the risks slide to the
end", "make it darker", "export it as a PDF".

## The workflow

1. **Find the deck.** `slides action=list` shows the presentations open in Herald Slides: name,
   path, unsaved edits, the one in front (`active`), its slide in front and what is selected.
   `slides action=list_all` adds what is open in Herald Docs and Sheets, and `os_ui action=state`
   carries the same list as `office`. "This slide" is the slide in front. Name a deck by its file
   (`presentation="~/Documents/Q3 review.pptx"`) or by its tab (`presentation="Q3 review"`); left
   out, a call works on the one in front.
2. **Read before you change anything.** `slides action=read` gives the size, theme and each
   slide's number, id, layout, title, text, speaker notes, whether it is hidden, and its elements
   with their boxes in points (`slide=3` for one). Name a slide by its number (1 is the first),
   its id or its title; left out, a call works on the slide in front. `slides action=find
   text="Q2"` lists the slides where something appears.
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
and what Herald shows differently from the file) and work in the window.

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

`path` saves the new deck at once (a new `.pptx`, never over a file that exists): give it only
when the person said where.

## From a document or a sheet

- **A document becomes a deck:** `slides action=from_document document="~/Documents/Report.docx"`
  makes a new presentation named after it, as one step: a title slide from its title, a slide for
  each heading with its list items and short paragraphs as bullets, long paragraphs shortened (the
  whole of them in the speaker notes), tables on slides of their own, more than eight bullets
  continued on another slide, and section slides for the headings above. `level=2` when the top
  headings are the parts; `notes=true` for a talk with a script (every paragraph in the notes,
  short bullets on the slides); `presentation=` adds the slides to the end of a deck instead. Then
  read it and tidy it in one `edit`: shorter titles, thin slides merged, a closing slide, a theme.
- **Figures from a sheet:** `slides action=insert_range workbook="~/Documents/Budget.xlsx"
  range="A1:D6" slide="Costs"` puts the range on the slide as a table, as its cells show
  (formatted numbers and dates). Give the table a `title-only` slide of its own, keep it to what
  matters (a few rows and columns), and add a summary slide with the two or three figures to
  remember.

## Layouts for the content

- `title`: the deck's first slide; `body` is the line under the title.
- `title-content`: a title and bullets, the default.
- `two-content`: two columns, for comparisons, before and after, pros and cons. Give `body` as a
  list of two bodies and name both sides in the title ("Rent vs buy").
- `comparison`: two columns, each under a bold heading of its own.
- `section`: a big title and a line under it, between the parts of a long deck.
- `title-only`: a title and the room under it, for a table, a picture or a big number.
- `blank`: nothing, for a picture that fills the slide.
- `picture-caption`: a title, a picture on the right and a caption on the left (`body` is the
  caption; `add_image` without a place fills the picture's spot).

A big number reads best alone: a `title-only` slide, then `add_text text="12%" size="120"
bold=true align=center` (sizes go from 4 to 400 points) with a smaller line under it. Change a slide's layout with `set_slide
layout=two-content`; its text moves into the new layout's places.

## Themes and backgrounds

`theme` (on `new`, or `slides action=set_theme theme=midnight`) changes the colours and fonts
everywhere they come from the theme, and keeps what was picked by hand: `herald` (white with navy
text and blue accents, the default), `midnight` (dark navy with light text, for big screens and
keynotes), `paper` (warm cream with serif type, for stories and teaching), `graphite` (dark grey
with yellow accents), `forest` (pale with green accents), `coral` (warm peach and coral, friendly),
`mono` (black and white with a red accent, stark) and `ocean` (pale blue and teal, calm).
`set_slide background=accent1` colours one slide (a section slide, the closing slide); colours are
`#rrggbb`, names like `navy`, or theme colours `accent1` to `accent6`, `text` and `background`,
which follow the theme when it changes. `size=standard` on `new` makes a 4:3 deck instead of 16:9.

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
  ["Pro", "$19"]]` (the first row is the header); or `insert_range` from Herald Sheets.
- Text boxes: `add_text text="Draft" x=40 y=480 size="18" color=accent2`; shapes: `add_shape
  kind=roundRect x=600 y=380 width=300 height=100 fill=accent1 text="New in Q3"` (stars, arrows,
  callouts and more).

## Several changes as one step

`slides action=edit edits=[...]` makes every change in order as ONE step to undo, and if one
fails, none is made. Each edit sees the deck as the ones before left it: a slide one edit adds can
be named by its title in the next, and an edit without a slide lands where the one before went.
The ops: `addSlide`, `setSlide`, `duplicateSlide`, `moveSlide`, `removeSlide`, `addText`,
`addShape`, `addImage`, `addTable`, `setTheme` and `replace`, with the same arguments as the
actions. A batch that removes a slide asks the person first, as `remove_slide` does.

```
slides action=edit edits=[
  {"op": "addSlide", "title": "Risks", "body": "Supplier delays\nHiring", "after": "Three priorities"},
  {"op": "addShape", "kind": "star5", "x": 840, "y": 40, "width": 70, "height": 70, "text": "New"},
  {"op": "moveSlide", "slide": "Thank you", "to": "last"},
  {"op": "setTheme", "theme": "midnight"}
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

No animations (a file's animations and automatic timings are not kept), one transition for the
whole deck, no charts (a file's charts and SmartArt are approximated), videos shown as their
poster frame, sounds left out, and no comments, macros, embedded fonts, sections or custom shows.
Opening a file lists what it had. Say so plainly, and offer what works: a table or a big-number
slide in place of a chart, a picture exported from Herald Canvas in place of a drawing, a
duplicated slide with one more bullet in place of a build animation.
