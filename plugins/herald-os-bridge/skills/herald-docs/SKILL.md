---
name: herald-docs
description: Write and edit documents in Herald Docs, the word processor in Herald OS - letters, cover letters, CVs, reports, memos, meeting notes, proposals, essays and newsletters drafted from a brief or a template, rewrites of the text Herald marked for a request (shorter, longer, another tone, another language, spelling and grammar), reviews that comment on clarity, grammar and tone, summaries, formatting and paragraph styles, find and replace, tables, pictures, a Herald Sheets range as a table in a report, headers and footers with page numbers and dates, fields, footnotes and endnotes, page setup and sections, comments and replies, tables of contents, templates, statistics such as word count and reading time, saving Word, Markdown and text files and exporting PDFs, all through the docs tool
metadata:
  hermes:
    tags: [herald-os, docs, documents, writing, word, docx, markdown, letter, cover letter, report, memo, resume, cv, proposal, essay, newsletter, rewrite, translate, formatting, tables, headers, footers, page numbers, fields, footnotes, endnotes, sections, page setup, comments, review, proofreading, grammar, tone, table of contents, templates, statistics, word count, readability, pdf]
---

# Herald Docs

Herald Docs is the word processor built into Herald OS. It opens and saves Word documents
(`.docx`), Markdown (`.md`) and text files (`.txt`), and the person watches every change land in
the Docs window. Use the `docs` tool whenever they want a document written or changed: "write a
cover letter for this job", "make this paragraph friendlier", "turn my notes into a report", "put
the budget table in the report", "fix the typos", "add page numbers", "review this", "export it as
a PDF". Code, configuration and other plain files are for your file tools; reading a PDF is
`system_documents`.

## The workflow

1. **Find the document.** `docs action=list` shows what is open in Herald Docs: each document's
   name, path, unsaved edits, the one in front (`active`) and the text selected in it.
   `docs action=list_all` adds what is open in Herald Sheets and Slides, and `os_ui action=state`
   carries the same list as `office`. "This document" is the one in front. Name a document by its
   file (`document="~/Documents/Report.docx"`) or by its tab (`document="Untitled 2"`); left out,
   a call works on the one in front.
2. **Read before you write.** `docs action=read` gives the outline, the word count, the page and
   the content as Markdown. On a long document read `part=outline` first, then a section at a
   time (`heading="Findings"`, or `heading=3` for the third heading); content is cut at `maxChars`
   (20000). `part=comments`, `notes`, `headers` (headers and footers), `sections` or `tocs`
   (tables of contents) gives those, and the other reads say which of them the document has.
   `docs action=find text="deadline"` lists each place a phrase appears, with the words around it
   and the heading it is under.
3. **Write Markdown.** `content` is Markdown: `#` headings, `**bold**`, `*italic*`, lists, `- [ ]`
   task lists, tables, links, `>` quotes, code, and pictures from files
   (`![Sales by month](~/Pictures/sales.png)`). `at` says where it goes: `end` (the default),
   `start`, `selection` (in place of what is selected, or at the caret), `marked` (in place of
   the text marked for the request), `after` (under the paragraph the selection is in), or
   `heading` with `heading=` and `mode=append` (the end of its section, the default), `prepend`
   (right under the heading) or `replace` (the section's text, keeping the heading). One paragraph
   written at the selection joins its line of text. `selection`, `marked` and `after` need the
   document open in its window; a file on disk takes `end`, `start` or a heading.
4. **One call, one step.** Every call is one step the person can undo (Ctrl+Z, ⌘Z on a Mac, or
   `docs action=undo`, with `steps=3` for several). Land a whole change in one call. Several
   changes, in one place or all over the document, go in one `docs action=edit` (below), never a
   string of small calls.
5. **Check, then say it in a sentence.** Read back what you changed (`docs action=read
   heading="Summary"`) before you say it is done, and say what changed, not how.

An open document changes in its window, where the person sees it. A file that is not open is
read, changed and written straight back to disk: the person is asked first every time, Herald
backs the original up the first time it writes over it, and it refuses when the file holds
something it cannot keep (see the end). Then open it (`docs action=open
path="~/Documents/Report.docx"`; the answer gives its outline and lists what Herald shows
differently from the file) and work in the window, where the person saves when they are happy.

## Drafting from a brief

- Ask nothing you can infer. The person's name, the date, the recipient and the facts they gave
  you go straight in. Something only they know becomes a short placeholder in brackets
  (`[phone number]`), and you say which ones are left to fill.
- Give it a shape: a title, a heading for each part, short paragraphs, lists for steps and
  options, a table for figures. Match the length to the job: a cover letter fits on one page (250
  to 400 words), a memo is short, a report opens with its summary.
- Match the tone to the reader: warm and plain for a personal letter, direct for a memo, formal
  for an official one. Write in the language the person writes to you in, unless they ask for
  another.
- Write the whole draft in one call:

```
docs action=new name="Cover letter - Product designer" content="Dear Hiring Manager,\n\nI am writing to apply for the Product Designer role at Acme, which I saw on your careers page. ...\n\nKind regards,\n\n[Your name]"
```

- Templates give a document its look: a page, styles, headers and footers, and sample text to
  replace. `docs action=list_templates` lists Herald Docs' own, each with what it holds (`blank`,
  `letter`, `cover-letter`, `cv`, `report`, `memo`, `meeting-notes`, `essay`,
  `project-proposal`, `newsletter`, `invoice`, `thank-you-note` and `recipe`), and the ones the
  person saved. `docs action=new template=report name="Q3 report"` starts one with its sample
  text, for the person to fill in, or for you to replace section by section after a read.
- For a real draft give the content too: `docs action=new template=cover-letter content="..."`
  keeps the template's page, styles, headers and footers and puts your content in place of all
  its sample text, so write the whole document, title and headings included. A header or footer
  may still hold sample words (a report's header says "Report Title"): read `part=headers` and
  set them (below). A template the person saved goes by its name, and `resume`, `proposal` or
  `meeting notes` work too.
- `size=a4` (`letter`, `legal` or `a5`) picks the paper of a new document; left out, the
  locale's.
- `path` saves the new document at once (`path="~/Documents/Q3 report.docx"`), never over a file
  that exists: give it only when the person said where. Otherwise the document stays unsaved
  until they save it or ask you to.

## Marked and selected text

When the person asks Hermes about text they selected in Herald Docs, Herald marks that text (it
stays tinted while you work) and the request says text is marked for it. `docs action=read
part=selection` gives it as `marked`, and what is selected now as `selection`. When nothing was
selected, the caret's place is marked instead, and `at=marked` writes there.

- **Rewrite, shorten, expand, change the tone, translate, fix the spelling and grammar:** write
  the new text with `at=marked`. It replaces exactly the marked text as one step, even when the
  person has clicked elsewhere since. Keep its language (unless asked to translate), its
  formatting (bold, links, lists, headings), and the facts, names and numbers in it; change only
  what was asked.
- **Summarise, explain, list the action items, suggest a title:** leave the text as it is. A
  summary or note goes under it with `at=after`, which is under the paragraph the selection is
  in: the marked text, as long as `selection` still matches `marked`. If the person has moved on,
  give the answer in your reply, or ask where it should go. A question gets its answer in your
  reply.
- Without marked text, "this paragraph" and "what I selected" are the selection: read
  `part=selection` and write `at=selection`. With nothing selected, find the part by its words
  (`find`) or ask which part they mean.

```
docs action=read part=selection
docs action=write at=marked content="Thank you for your patience while we looked into this. ..."
docs action=write at=after content="**In short:** the supplier missed two deadlines and has offered a 10% credit."
```

## Formatting

Write structure in Markdown as you write; use `format` for what Markdown cannot say. `at` picks
what it applies to: `selection` (the default), `marked`, `all`, `heading` (the heading line),
`section` (a heading and its section, with `heading=`) or `text` (every place `text=` appears;
`caseSensitive`, `wholeWord` or `regex` narrow it).

- Paragraph styles: `style=` `normal`, `title`, `subtitle`, `heading1` to `heading6`, `quote` or
  `code`.
- Marks: `bold`, `italic`, `underline` and `strike` (true or false), `color` and `highlight` (any
  CSS colour; `none` takes one off), `font`, `size` in points (`"0"` goes back to the style's),
  `link` (a web address, or `none`), and `clear=true` to clear the formatting first.
- Paragraphs: `align=left`, `center`, `right` or `justify`; `lineSpacing=1.15` (1, 1.15, 1.5, 2).
- The page: `docs action=page size=a4 orientation=portrait margins="2cm"`; more under Sections
  and page setup.

```
docs action=format at=text text="Herald OS" bold=true color="#1f6feb"
docs action=format at=section heading="Appendix" size="10"
docs action=format at=all font="Georgia" lineSpacing=1.15
```

Find and replace keeps the formatting where each match starts: `docs action=replace find="Acme
Ltd" replacement="Acme Group" wholeWord=true` changes every match (`all=false` only the first),
and leaving `replacement` out deletes the matches.

## Tables and pictures

- A table: a Markdown table inside `content`, or `docs action=table cells=[["Item", "Cost"],
  ["Flights", "$1,240"], ["Hotel", "$860"]] at=after`. The first row is the header unless
  `header=false`; `rows=4 cols=3` makes an empty one. Its columns share the text width.
- A picture from a file (PNG, JPEG, GIF, WebP, BMP or SVG): `docs action=image
  source="~/Pictures/team.jpg" alt="The team at the offsite" width=480 at=after`, or
  `![alt](~/path.png)` in Markdown. It is never wider than the text.
- Figures from Herald Sheets: `docs action=insert_range workbook="~/Documents/Budget.xlsx"
  range="A1:D12" at=heading heading="Costs"` puts the range in as a table, as its cells show
  (formatted numbers and dates). Without `range` it takes the workbook's selection, or else the
  cells that hold something.

## Headers, footers and page numbers

`docs action=set_footer content="Page {page} of {pages}" align=center` numbers every page at its
foot, and `set_header` writes the top of the page the same way. `content` is Markdown, a line or
a few, and replaces what the header or footer said: `{page}` is the page number, `{pages}` the
page count, and `{date}` and `{time}` are today's (`{date:d MMMM yyyy}` with a picture of your
own), kept up to date as the pages change. `align` is `left`, `center` or `right`.

- `kind=first` writes the first page's own and `kind=even` the even pages' own (the default ones
  then go on odd pages), and turns that option on. `set_header_options differentFirst=true` alone
  gives a title page no header or footer; `false` turns it off again, and `differentOddEven`
  works the same way.
- `clear_header` and `clear_footer` take one kind away (`kind=first`), or every one when `kind`
  is left out, and ask the person first.
- `docs action=read part=headers` shows what each one says, with `{page}` and `{pages}` where
  those fields are. A document has one set, shown in every section.
- A page number, page count, date or time in the text itself is a field: `docs
  action=insert_field field=date format="d MMMM yyyy" quote="Dated:"` puts today's date right
  after those words (`field=page`, `pageOfPages` for "Page 2 of 9", `pages`, `date` or `time`).
  Without `quote` it goes at the caret (`at=selection`), in place of the marked text, or on a
  line of its own at the end or where `heading` says.

```
docs action=set_header content="**Acme** · Q3 report" align=right
docs action=set_footer content="Page {page} of {pages}" align=center
docs action=set_header_options differentFirst=true
```

## Footnotes and endnotes

`docs action=insert_note quote="grew by a third" content="Office for National Statistics, 2025."`
puts a footnote's number right after those words and the note at the foot of the page;
`kind=endnote` puts the note at the end of the document instead. Notes are numbered in the order
they come. Without `quote` the number goes at the caret or the marked text, or at the end of the
text where `at` and `heading` say. `docs action=list_notes` (or `read part=notes`) lists them by
name ("footnote 2", "endnote 1"), with what each says and the words its number follows;
`set_note note="footnote 2" content="..."` changes one, and `remove_note note="footnote 2"` takes
it and its number out (the rest are numbered again), asking the person first. Markdown written
with `write` can hold footnotes too (`grew by a third[^1]`, and a line `[^1]: The source.`).

## Sections and page setup

`docs action=page` sets the paper, orientation and margins: `size=a4` (`letter`, `legal`, `a5`,
or width by height like `"8.5x11in"`), `orientation=landscape`, `margins="2cm"` for all four or
`top`, `right`, `bottom` and `left` for one side each, and `headerDistance` and `footerDistance`
for how far the header and footer sit from the edges. Lengths are points, or `"1in"`, `"2cm"`,
`"20mm"`.

A section break starts pages that can have a setup of their own: landscape pages for a wide
table, an appendix with other margins. `docs action=insert_section_break quote="Appendix"
orientation=landscape` starts a new section on a new page after the paragraph with those words
(`kind=continuous` keeps it on the same page, and `oddPage` or `evenPage` starts the next odd or
even page), with the page you give it, or else the page of the section it is in. For one wide
table, break before it with `orientation=landscape` and after it with `orientation=portrait`.

- `docs action=list_sections` (or `read part=sections`) lists the sections in order, each with
  its number, how it starts, its page and its first words.
- `page` without `section` changes the document's page (the first section's, and that of the
  sections that keep it); `page section=2 margins="1in"` changes one section's alone, and
  `section=all` every section's.
- `remove_section_break section=3` joins section 3 to the one before it, whose page it takes, and
  asks the person first.

## Tables of contents

`docs action=insert_toc quote="Q3 report" levels=3` puts a table of contents after the title (the
paragraph with those words), listing Heading 1 to Heading 3 with the page each is on, under the
title "Contents" (`title="In this report"`, or `title=none` for no title). Without a place it goes
at the start, and `heading="Summary" mode=before` puts it right before a heading. Its entries
follow the headings as they change; after headings change or text moves to other pages,
`update_tocs` brings its page numbers up to date. `set_toc levels=2` (or `title`) changes one
(`toc=2` for the second), `remove_toc` takes one out and asks first, and `read part=tocs` lists
them.

## Comments

`docs action=read part=comments` (or `list_comments`, with `heading=` for one section) gives each
comment's id, author, date, what it says, the words it is on (`quote`), the heading it is under,
whether it is resolved, and its replies.

- `add_comment quote="grew by a third" text="Against which year?"` comments on those words
  (`all=true` on every place they appear); `heading="Summary"` comments on a heading's line, and
  `at=selection` or `at=marked` on what is selected or marked in an open document. The answer
  gives the new comment's id.
- `reply_to_comment comment=<id> text="..."` answers a comment, `edit_comment` changes what a
  comment or a reply says, `resolve_comment comment=<id>` marks it resolved (`resolved=false`
  opens it again), and `delete_comment comment=<id>` deletes a comment with its replies (a reply's
  id deletes only that reply; `all=true` every comment in the document), asking the person first.
- What you write is signed Hermes, so the person sees who said it. Each change is one step to
  undo, and an open document shows its comments beside the pages.
- "Deal with the comments": read them, make the changes in one `edit`, and in the same batch
  reply to or resolve each one you dealt with (`{"op": "resolveComment", "comment": "c3"}`).

## Reviewing a document

"Review this", "check the grammar", "is the tone right", "proofread my essay": a review comments
on the text and leaves it as it is. Asking to fix or rewrite it is a rewrite (see Marked and
selected text).

1. Read the whole document first (`docs action=read`; when it comes back cut short, a section at
   a time with `heading=`), so every comment rests on text you have read. When the read says it
   has comments already, read them (`part=comments`) and repeat none. When text is marked for
   the request, review only that (`part=selection`).
2. Make ONE `add_comments` call with every comment, so the review lands as one step the person
   can undo. Each comment goes on an exact quote of a short passage: a few words copied from one
   paragraph, without Markdown marks, enough to tell the place apart (a comment goes on the first
   match of its quote). Each says its kind and the fix: Clarity (vague, wordy or hard to follow),
   Grammar (spelling, grammar and punctuation) or Tone (what does not suit the readers). Comment
   only where a change would help, in the document's language, and keep to what was asked: a
   grammar check is about grammar. When nothing needs a comment, make no call and say so.
3. Never rewrite the text in a review unless the person asks; they decide what to take. When they
   then say "fix them", make the fixes in one `edit` and resolve the comments you dealt with.
4. Then say it in one line: how many comments of each kind and what most needs work ("9
   comments: 4 grammar, 3 clarity, 2 tone; the summary buries the result").

```
docs action=add_comments comments=[
  {"text": "Grammar: 'affect' is the verb. Suggest: 'a big effect on sales'.", "quote": "a big affect on sales"},
  {"text": "Clarity: who decided? Suggest: name the team.", "quote": "it was decided"},
  {"text": "Tone: too casual for a client report. Suggest: 'We expect'.", "quote": "We reckon"}
]
```

The answer counts the comments added and lists any whose quote was not found (`missing`): make
no second call for those, and say how many did not land. `"all": true` puts one comment on every
place a slip repeats, and an item with `heading` in place of `quote` comments on a whole section.

## Statistics

"How long is it", "how long will it take to read", "is it easy to read": `docs action=statistics`
gives the words, characters (with and without spaces), paragraphs, sentences, words per sentence,
reading and speaking time, reading ease (Flesch, 0 to 100, higher is easier, with what it means),
the US school grade (Flesch-Kincaid), and the pages of an open document. `heading=` gives one
section's and `selection=true` the selection's. They count the body, not notes, comments, headers
or footers. Answer with the numbers asked for, in a sentence.

## Several changes as one step

`docs action=edit edits=[...]` makes every change in order as ONE step to undo, each one seeing
the document as the ones before left it. The ops: `write` (content, format, at, heading, mode),
`replace` (find, replacement, all, caseSensitive, wholeWord, regex), `format` (the format
arguments), `table` (cells, or rows and cols, header, at, heading, mode), `image` (source, alt,
at, heading, mode), `pageBreak` (at, heading, mode) and `page` (the page arguments); and
`setHeader`, `setFooter`, `clearHeader`, `clearFooter`, `setHeaderOptions`, `insertField`,
`insertNote`, `setNote`, `removeNote`, `insertSectionBreak`, `removeSectionBreak`, `addComment`,
`addComments`, `replyToComment`, `editComment`, `resolveComment`, `deleteComment`, `insertToc`,
`setToc`, `updateTocs` and `removeToc`, each with the arguments of the action of the same words.
A batch that takes something away (a header, a note, a comment, a table of contents) asks the
person first, as that action does alone.

```
docs action=edit document="Report.docx" edits=[
  {"op": "write", "at": "start", "content": "## Summary\n\nSales rose 12% on last year, ..."},
  {"op": "replace", "find": "DRAFT - ", "replacement": ""},
  {"op": "format", "at": "heading", "heading": "Summary", "color": "#1f6feb"},
  {"op": "pageBreak", "at": "heading", "heading": "Appendix", "mode": "prepend"},
  {"op": "setFooter", "content": "Page {page} of {pages}", "align": "center"}
]
```

Use it for "fix the typos" (one `replace` per mistake, with `wholeWord=true`, so the formatting
stays), "make every heading blue" (one `format` per heading in the outline), "update the dates
everywhere", "add page numbers and a table of contents" (a `setFooter` and an `insertToc`), and
for filling in a template section by section (`write` with `at=heading mode=replace` for each
one).

## Work across documents

"Put the budget in the report and say what it shows": `docs action=list_all` finds both (or use
their paths), `sheets action=read workbook="Budget.xlsx"` gives the headers and figures, then
make one call to the report. When it needs only the table, that is `docs action=insert_range`.
When it needs words around the figures too, make one `docs action=edit` with a `write` for the
words and a `table` whose cells are the range as it shows (the read's `text` when it has one,
else its `values`). Quote totals exactly as the sheet shows them, and keep one call per document
so each one is a single step to undo.

## Saving and exporting

- Never save unless the person asks. An open document keeps its unsaved edits (its tab says so),
  and they save with Ctrl+S (⌘S on a Mac) or ask you to.
- "Save it": `docs action=save`. Saving over the document's own file asks the person every time;
  the first time Herald writes over a file it shows what it cannot keep, and the original goes to
  Herald's Office backups. If they keep the file as it was, say so and leave it there.
- A document never saved ("Untitled 2") needs a place: `docs action=save to="~/Documents/Cover
  letter.docx"`. The extension picks the format: `.docx`, `.md` or `.txt`. A file that exists is
  replaced only with `overwrite=true`, which asks the person first.
- A PDF: `docs action=export_pdf` writes a new PDF in ~/Documents, laid out as it prints, or
  `to="~/Desktop/Report.pdf"`. Say where it went.

## What Herald Docs cannot do yet

Tracked changes (shown accepted, and saved accepted), text in columns (shown and saved in one
column), headers and footers of their own in later sections (the first section's show on every
page), page numbering that starts again in a section, equations (shown as plain text), shapes
other than pictures and text boxes, and embedded objects (shown as their pictures and not kept).
Opening a file lists the ones it has. Say so plainly when a request needs one, and offer what
works instead: a comment with the new wording in place of a tracked change, one column in place
of several.
