---
name: herald-docs
description: Write and edit documents in Herald Docs, the word processor in Herald OS - letters, cover letters, reports, memos, meeting notes, resumes, proposals and essays drafted from a brief or a template, rewrites of the text Herald marked for a request (shorter, longer, another tone, another language, spelling and grammar), summaries, formatting and paragraph styles, find and replace, tables, pictures, a Herald Sheets range as a table in a report, page setup, saving Word, Markdown and text files and exporting PDFs, all through the docs tool
metadata:
  hermes:
    tags: [herald-os, docs, documents, writing, word, docx, markdown, letter, cover letter, report, memo, resume, proposal, essay, rewrite, translate, formatting, tables, pdf]
---

# Herald Docs

Herald Docs is the word processor built into Herald OS. It opens and saves Word documents
(`.docx`), Markdown (`.md`) and text files (`.txt`), and the person watches every change land in
the Docs window. Use the `docs` tool whenever they want a document written or changed: "write a
cover letter for this job", "make this paragraph friendlier", "turn my notes into a report", "put
the budget table in the report", "fix the typos", "export it as a PDF". Code, configuration and
other plain files are for your file tools; reading a PDF is `system_documents`.

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
   (20000). `docs action=find text="deadline"` lists each place a phrase appears, with the words
   around it and the heading it is under.
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

- Templates give a document its usual shape: `letter`, `cover letter`, `report`, `memo`,
  `meeting notes`, `resume`, `proposal` and `essay`. `docs action=new template=report name="Q3
  report"` starts one with its headings and [placeholders] (a report has Summary, Background,
  Findings, Recommendations and Next steps; meeting notes have Agenda, Decisions and Action items).
  Use a template when the person wants one to fill in themselves. For a real draft, follow its
  shape and write the content yourself in `new`, which takes `template` or `content`, not both.
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
- The page: `docs action=page size=a4 orientation=portrait margins="2cm"` (`size=letter`; margins
  in points, or `"1in"`, `"20mm"`).

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

## Several changes as one step

`docs action=edit edits=[...]` makes every change in order as ONE step to undo, each one seeing
the document as the ones before left it. The ops: `write` (content, format, at, heading, mode),
`replace` (find, replacement, all, caseSensitive, wholeWord, regex), `format` (the format
arguments), `table` (cells, or rows and cols, header, at, heading, mode), `image` (source, alt,
at, heading, mode), `pageBreak` (at, heading, mode) and `page` (size, orientation, margins).

```
docs action=edit document="Report.docx" edits=[
  {"op": "write", "at": "start", "content": "## Summary\n\nSales rose 12% on last year, ..."},
  {"op": "replace", "find": "DRAFT - ", "replacement": ""},
  {"op": "format", "at": "heading", "heading": "Summary", "color": "#1f6feb"},
  {"op": "pageBreak", "at": "heading", "heading": "Appendix", "mode": "prepend"}
]
```

Use it for "fix the typos" (one `replace` per mistake, with `wholeWord=true`, so the formatting
stays), "make every heading blue" (one `format` per heading in the outline), "update the dates
everywhere", and for filling in a template section by section (`write` with `at=heading
mode=replace` for each one).

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

Comments (left out, and not kept when saving), tracked changes (shown accepted), headers and
footers (not shown or kept), footnotes and endnotes (shown as numbered notes at the end), fields
such as a table of contents or page numbers (shown as their last result), text boxes, text in
columns and embedded objects. Opening a file lists the ones it has. Say so plainly when a request
needs one, and offer what works instead: a "Notes" section in place of comments, a line under the
title in place of a header, a list of the headings in place of a table of contents.
