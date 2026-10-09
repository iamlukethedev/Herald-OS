# Herald Office

Herald Office is three apps built into Herald OS: Herald Docs for documents, Herald Sheets for
spreadsheets and Herald Slides for presentations. They open and save Word, Excel and PowerPoint
files, and Hermes can work in them with you: ask for a cover letter, "remove the duplicate rows" or
"turn my report into slides", and watch each change land in the open window as a step you can undo.

Open them from the Dock's Herald Office tile, from Applications (`Cmd+Shift+A`, `Super+A` on Linux),
from Files ("Edit in Herald Docs" on a Word file, and likewise for workbooks and presentations), by
dropping a file on an app's window, or by asking Hermes. On a Mac the Dock tile offers the three
apps. On Herald OS Linux it brings back the ones that are open (or opens Applications), and each app
opens in its own window, three quarters of the screen wide.

Each app keeps its open documents in tabs beside its menus. The status bar at the bottom says
whether the document is saved and holds the Ask Hermes field. In the shortcuts below, `Cmd` on a
Mac is `Ctrl` on Herald OS Linux, and `Alt` is `Option` on a Mac.

## Herald Docs

Herald Docs writes on real pages: what you see is how the document prints, page breaks, headers and
footers included.

- **Pages.** The pages are the paper the document is set up for. View > Zoom In, Zoom Out and Actual
  Size (`Cmd+=`, `Cmd+-`, `Cmd+0`). View > Navigation Pane (`Cmd+Alt+O`) lists the headings, with a
  filter; click one to go there.
- **Styles and formatting.** Format > Paragraph Style has Normal, Title, Subtitle, Heading 1 to 3,
  Quote and Code (`Cmd+Alt+0` for Normal, `Cmd+Alt+1` to `Cmd+Alt+3` for the headings). The toolbar
  has the style, font, size, text colour and highlight. Format also has bold, italic, underline,
  strikethrough (`Cmd+Shift+X`), superscript (`Cmd+.`), subscript (`Cmd+,`), code (`Cmd+Shift+M`),
  Clear Formatting (`Cmd+\`), Align (`Cmd+L`, `Cmd+E`, `Cmd+R`, `Cmd+J`) and Line Spacing, from
  single to triple.
- **The `/` menu.** Type `/` at the start of a line or after a space, then a few letters ("h2",
  "todo", "warn"): styles, lists, a table, a picture, a divider, a page break, or a coloured panel
  (info, note, success, warning, error).
- **Lists.** Bulleted (`Cmd+Shift+8`), numbered (`Cmd+Shift+7`) and checklists (`Cmd+Shift+9`).
  `Tab` and `Shift+Tab` move an item in and out. In a plain paragraph `Tab` types a tab, and `Cmd+]`
  and `Cmd+[` indent the paragraph.
- **Tables.** Insert > Table puts in three rows and three columns with a header row; the toolbar's
  grid picks another size. The Table menu inserts and deletes rows and columns, merges and splits
  cells, turns the header row and the borders on or off, and deletes the table. `Tab` goes to the
  next cell.
- **Pictures.** Insert > Picture… (PNG, JPEG, GIF, WebP, BMP or SVG), or drop one on the page. Drag
  a corner to resize it: it keeps its proportions and is never wider than the text. A selected
  picture's bar sets its alt text, puts back its original size or removes it.
- **Headers and footers.** Double-click the top or bottom of a page, or choose Insert > Header or
  Insert > Footer, and type on the page. The bar beside it has Different first page, Different odd
  and even pages, page numbers ("Page X of Y" and the page count too) and the date; `Esc` closes it.
  Insert > Page Number puts the same fields in the text.
- **Notes and breaks.** Insert > Footnote (`Cmd+Alt+F`) and Endnote (`Cmd+Alt+E`); double-click a
  note to edit it. Insert > Break has Page Break (`Cmd+Enter`) and section breaks that start on the
  next page, on the same page, or on the next odd or even page.
- **Page setup.** Format > Page Setup… (`Cmd+Shift+P`): the paper (A4, Letter, Legal, A5 or a size
  of your own), portrait or landscape, the margins, and how far the header and footer sit from the
  edge, in centimetres or inches. In a document with section breaks it changes the section you are
  in or the whole document, so one section can be landscape for a wide table. A new document is on
  Letter where that is the usual paper (the US, Canada and Mexico) and on A4 elsewhere.
- **Table of contents.** Insert > Table of Contents lists the headings with the pages they are on,
  and keeps up as they change; click an entry to go to its heading. Select it for a bar that picks
  the heading levels it lists or removes it. Review > Update Table of Contents brings its entries up
  to date.
- **Comments.** Select some text, then Insert > Comment or Review > New Comment (`Cmd+Alt+M`).
  Comments show beside the pages, each with its replies and a box to answer it; Resolve folds a
  thread away and Reopen brings it back. The Review menu also goes to the next or previous comment,
  deletes one or all of them, and shows or hides them. Word files keep comments and their replies.
- **Templates.** File > New (`Cmd+N`) opens the gallery: a blank document, Letter, Cover letter, CV,
  Report, Memo, Meeting notes, Essay, Project proposal, Newsletter, Invoice, Thank-you note and
  Recipe, then the templates you saved with File > Save as Template…. The arrow keys move, `Enter`
  makes the document and `Esc` goes back. Only your own New opens the gallery: ask Hermes for a
  letter or a CV and it picks the template itself.
- **Find, spelling and statistics.** Edit > Find… (`Cmd+F`) and Replace… (`Cmd+Shift+H`).
  Misspelled words are underlined: right-click one for suggestions or Add to Dictionary (on a Mac,
  the system's own dictionary). Tools > Word Count and Statistics… (`Cmd+Shift+C`) counts words,
  characters, paragraphs and sentences, and gives the reading and speaking time and how easy the
  text is to read (worked out for English).
- **The writing assistant.** Select text and click Ask Hermes in the bar over it, or open the Hermes
  menu: Rewrite, Shorten, Expand, Change Tone (Professional, Friendly, Confident or Casual),
  Translate (Spanish, French, German, Portuguese, Italian, Japanese, Chinese, or Other Language…),
  Fix Spelling and Grammar, and Summarise. Summarise puts a short summary under the paragraph; the
  others replace the selection with the new text, as one step to undo, even if you click elsewhere
  while Hermes works.
- **Review with Hermes.** Review > Review with Hermes reads the whole document and leaves comments
  on exact passages, each starting Clarity, Grammar or Tone and suggesting a fix. It never changes
  the text, and the whole review is one step to undo.

## Herald Sheets

Herald Sheets is a spreadsheet: formulas are worked out as you type, and Excel workbooks keep their
formats, charts and comments. The toolbar over the grid has the font, colours, borders, alignment
and merging, and the tabs along the bottom are the workbook's sheets.

- **Formulas and formats.** Type `=` to start a formula. Format > Number format: Automatic, Number
  (1,234.50), Currency ($1,234.50), Percent (12.5%), Date (2026-10-08), Time (14:30) and Plain text.
- **Sort and filter.** Data > Sort A to Z, Sort Z to A, Sort… and Sort by several columns…. Data >
  Filter puts filter buttons on the header row, and Clear filter conditions shows every row again.
- **Freeze.** View > Freeze top row, Freeze first column, Freeze up to selection and Unfreeze keep
  headings in sight while you scroll.
- **Sheets.** Sheet > New sheet adds one. Click a tab at the bottom to switch; right-click it to
  rename or delete it.
- **Charts.** Select the cells and choose Insert > Chart…: the kinds that suit them come first,
  pictured with your data, then every kind: column, bar, line, area, pie, doughnut, scatter, and
  columns with lines (combo). Double-click a chart, or choose Insert > Chart settings…, to change
  its series, title, legend, labels, stacking and axes; Insert also copies a chart as a picture and
  deletes it. Charts are saved in the workbook as Excel charts, and Excel's charts of these kinds
  open as charts.
- **Summaries.** Data > Summarize… sums up a table the way a pivot table does: rows (and columns)
  for each value of a column, values as Sum, Count, Average, Min or Max, and filters, on a new sheet
  or at a cell. Its numbers are ordinary formulas, so they follow the data as it changes and work in
  any spreadsheet app; Data > Refresh summary adds labels that are new since.
- **Data tools.** Data > Remove duplicates…, Split text to columns…, Trim and clean, Change case,
  Convert text to numbers, Convert text to dates…, Fill down and Highlight duplicates work on the
  selected cells. The dialogs show what will change first: how many rows would go, the columns a
  split makes, the dates as they will read.
- **Names and validation.** Data > Named ranges… (also from the name box) lists the workbook's
  names: add, change, delete or go to one. Data > Data validation… sets what cells take: a dropdown
  list (typed, or from a range), whole numbers, decimals, dates, a text length or a custom formula,
  with a message shown when one is selected and an alert for a value it does not take.
- **Comments and notes.** Insert > Comment starts a thread on the active cell, with replies and
  Resolve; Insert > Note writes a note. A cell holds one or the other, as in Excel. Insert > Show
  comments opens the panel with every thread. Both are saved as Excel's comments and notes.
- **The Hermes menu.** Formula from a description…, Explain this formula, Fill from examples (the
  empty cells of a column, following the filled ones), Clean data (remove duplicate rows, fix dates,
  split a column, trim spaces, numbers stored as text) and What stands out in this sheet?.

## Herald Slides

Herald Slides makes presentations: the slides down the side, the slide in front with its speaker
notes under it, and a toolbar for text, shapes, pictures, tables, the background and the theme.

- **Slides.** Slide > New Slide (`Cmd+Shift+N`) or New Slide with Layout, Duplicate Slide, Delete
  Slide, Hide or Show Slide (a hidden slide is skipped when presenting), and Move Slide Up and Down;
  or drag slides in the list. `Shift`-click (or `Cmd`-click on a Mac) picks several.
- **Layouts.** Title, Title and Content, Two Content, Comparison, Section Header, Title Only, Blank
  and Picture with Caption. Slide > Layout changes a slide's, and its text moves into the new
  layout's places.
- **Text.** Insert > Text Box, or type in a layout's placeholder. Format has bold, italic,
  underline, strikethrough, Bigger and Smaller (`Cmd+Shift+>` and `Cmd+Shift+<`), alignment
  (`Cmd+Shift+L`, `Cmd+Shift+E`, `Cmd+Shift+R`, `Cmd+Shift+J`), Bullets (`Cmd+Shift+8`), Numbering
  (`Cmd+Shift+7`) and list levels, Text Position (top, middle or bottom) and Autofit (shrink the
  text on overflow, or resize the box to fit it). The toolbar has the font, size, colour, highlight
  and line spacing.
- **Shapes, pictures and tables.** Insert has the shapes of PowerPoint's gallery (rectangles, basic
  shapes, arrows, equation shapes, flowchart, stars and banners, callouts), lines and arrows,
  Picture… (or drop pictures on the slide) and tables. The toolbar sets a shape's fill and outline;
  the Table menu adds and deletes rows and columns and sets the borders.
- **Arranging.** Arrange has Bring to Front (`Cmd+Shift+]`), Bring Forward (`Cmd+]`), Send Backward
  (`Cmd+[`), Send to Back (`Cmd+Shift+[`), Align (to each other, or to the slide for one thing),
  Distribute (three or more), Group (`Cmd+Alt+G`) and Ungroup (`Cmd+Alt+Shift+G`). Edit > Duplicate
  (`Cmd+D`) copies what is selected.
- **Connectors.** Insert > Connector (Straight, Elbow or Curved), then drag from one shape to
  another: each end sticks to the nearest connection point and follows the shape when it moves.
- **Themes and backgrounds.** Slide > Theme gives every slide one of Herald's thirteen themes
  (Herald, Midnight, Paper, Graphite, Forest, Coral, Mono, Ocean, Aurora, Dune, Slate, Blossom and
  Ember), the theme the file came with, or one of yours: New Theme… makes one from ten colours, the
  fonts and an optional gradient, and Edit Theme… changes it. Theme for Selected Slides gives the
  picked slides their own. The toolbar's Background is the theme's, a colour, a gradient or a
  picture; Slide > Theme Background puts the theme's back. Slide Size is Widescreen (16:9) or
  Standard (4:3).
- **Master and layouts.** View > Slide Master edits what the slides share. On the master: a logo
  (Insert Logo…), the background, the header and footer, and the theme; on a layout: its background,
  whether it shows the master's drawings, and its name. Reset Master puts Herald's master back, and
  Close Master View returns to the slides. Slide > Hide Background Graphics hides the master's
  drawings on the picked slides.
- **Header and footer.** Insert > Header & Footer…: the date (kept up to date in a format you pick,
  or fixed), the slide number and a footer, and Don't show on title slide.
- **Transitions.** Slide > Transition: None, Fade, Push, Wipe, Cover, Uncover, Split or Zoom for the
  picked slides, with Effect Options for the direction, Duration (a quarter of a second to two
  seconds) and Apply Transition to All Slides. The toolbar's Transitions plays each in miniature.
- **Presenting.** Slide > Present (`Cmd+Shift+Enter`) starts from the slide in front, Present from
  the Start (`Cmd+Alt+Enter`) from the first. The right and down arrows, `Page Down`, `Space`,
  `Enter`, `N` or a click go on; the left and up arrows, `Page Up`, `Backspace` or `P` go back;
  `Home` and `End` go to the first and last slide; a number and `Enter` jump to that slide; `B` (or
  `.`) turns the screen black and `W` (or `,`) white; `Esc` ends. An end screen follows the last
  slide.
- **The presenter view.** Slide > Presenter View (`Cmd+Alt+P`, also while presenting) shows the
  slide in front large and the next one, your speaker notes (larger or smaller), the time taken
  (pause, resume or reset), the clock and the slide counter, with Previous, Next, Black screen, All
  slides (every slide, to jump to one) and End. With a second display connected, the slides go full
  screen on it in a window of their own, the audience window, and the presenter view stays on your
  screen; with one display, the large slide in the presenter view is the show itself.
- **Decks from documents and sheets.** File > New from Document… makes a deck from Word, Markdown
  or text documents: the title becomes a title slide, headings become section and content slides,
  pictures, tables, quotes and code get slides laid out for them, and a long section goes on over
  further slides. Insert > Slides from Document… adds such slides to the deck. Insert > Table from
  Spreadsheet… puts a range of an Excel or CSV file on the slide in front, or on slides of its own
  after it (a long table goes on over several, its header row on each).
- **The Hermes menu.** Speaker Notes for This Slide or for Every Slide, Tighten This Slide, Choose
  Layouts for the Content, A Deck from a Topic…, and slides from documents and workbooks open in
  Herald Docs and Sheets: Add Slides from a Document, New Deck from a Document, and Add Slides from
  a Sheet (a table, and a slide after it that sums it up).

## Opening and saving

| App | Opens | Saves |
| --- | --- | --- |
| Herald Docs | Word (`.docx`, and `.docm` without its macros), Markdown (`.md`, `.markdown`), plain text (`.txt`) | `.docx`, `.md`, `.txt` |
| Herald Sheets | Excel (`.xlsx`, and `.xlsm` without its macros), CSV (`.csv`) | `.xlsx`, `.csv` |
| Herald Slides | PowerPoint (`.pptx`) | `.pptx` |

- **Where files live.** Herald Office opens and saves files in your home folder, up to 512 MB each.
  Save As… and Export as PDF… start in Documents. A `.docm` or `.xlsm` file opens without its
  macros, and saving it asks for a new `.docx` or `.xlsx` file. OpenDocument files (`.odt`, `.ods`,
  `.odp`) do not open yet: save them from LibreOffice as Word, Excel or PowerPoint files first.
- **What Herald changed.** When a file holds something Herald shows differently or leaves out,
  opening it says so, and File > What Herald changed… (or Shown differently in the status bar)
  lists each thing.
- **The first save over a file.** Before Herald first writes over a file it opened, it asks
  "Replace …?" and lists what it showed differently and what the format will not keep. Replace saves
  over the file, Save a copy… saves to a new file instead, and Cancel goes back. A file Herald keeps
  whole saves without the question, and later saves ask again only about something new. Saving to
  another format (a workbook as CSV, say) lists what that format did not keep once it is saved.
- **Backups.** The first time Herald writes over a file after Herald OS starts, your save or
  Hermes's, the file as it was is copied into `~/.hermes/herald-os/office-backups`, in a folder for
  the day (`2026-10-09/Report.docx`). Backups are kept for 30 days and up to 2 GB in all, the oldest
  going first; files over 256 MB are not copied.
- **Saving by itself.** Once you have saved a document, it saves itself about a second and a half
  after each change, Hermes's included; a new or just-opened document waits for your first save.
  The status bar says Not saved yet, Edited, Saving soon or Saved. When a save would lose something
  you have not agreed to, Herald stops saving by itself and says why: save it yourself to go on.
- **Changes from elsewhere.** An open document follows its file. When another app or a sync client
  changes it and you have no unsaved edits, the new version comes in (Herald asks again before the
  next save over it if the new version has things it shows differently). With unsaved edits, a bar
  asks: Keep mine saves yours over theirs, Load theirs takes the new version and drops your unsaved
  edits. When the file is moved or deleted, the status bar says so, and saving puts it back.
- **Closing.** File > Close (`Cmd+W`) asks first when there are unsaved edits.

| Command | macOS | Herald OS Linux |
| --- | --- | --- |
| New, Open, Save, Save As | `Cmd+N`, `Cmd+O`, `Cmd+S`, `Cmd+Shift+S` | `Ctrl` with the same keys |
| Print, Close | `Cmd+P`, `Cmd+W` | `Ctrl+P`, `Ctrl+W` |
| Undo | `Cmd+Z` | `Ctrl+Z` |

## Printing

File > Print… (`Cmd+P`, `Ctrl+P` on Linux) opens the system's print dialog with the same pages
that File > Export as PDF… writes; Export as PDF has no shortcut.

- **Herald Docs** prints the pages as the page view lays them out, with their headers, footers and
  footnotes.
- **Herald Sheets** prints the sheet in front as it shows, hidden rows and columns left out, and
  follows the page setup the sheet brought from its Excel file: the paper, which way it turns, the
  margins, the scale or fitting to so many pages, centring across the page, and the header and
  footer with their page numbers. Herald Sheets has no page setup of its own yet; without one from
  the file, a sheet wider than the page prints landscape, under its name.
- **Herald Slides** prints one slide on each page, at the slide's size; hidden slides are left out.

The pages are laid out at the document's own size and scaled to the paper the printer has. On
Herald OS Linux, which comes without a print server, the system has no print dialog to show, so
Print asks where to save a PDF of the same pages instead (Print to File).

## Working with Hermes

Ask in the Hermes window, with your voice, or in the Ask Hermes field in the status bar ("Ask Hermes
about this document…"; Hermes > Ask Hermes… takes you there): type and press `Enter`. The
request goes with the document and what is selected in it, and Hermes works in the open window as
you watch, each change a step you can undo. While it works, the field says what it is doing, with
Cancel; when it needs your approval, Open Hermes shows the card. Its reply opens above the field,
with Undo (while you have not changed the document since), Open in Hermes for the conversation, and
Dismiss. The next request about the same document carries on the same conversation. Things that work
well:

- "Write a cover letter for a junior designer job", "turn these notes into a one-page memo", "add a
  table of contents and 'Page X of Y' in the footer", "set the whole document in Georgia, 12 point",
  "review this for grammar".
- "Make a budget for my trip to Lisbon", "add a total row", "sum the March sales", "sort this by
  date", "make a line chart of revenue by month", "summarize sales by region", "put a Yes and No
  dropdown in column E".
- "Create a presentation about volcanoes in the Midnight theme", "make slide 3 a two-column
  comparison", "write speaker notes for every slide", "tighten this slide".
- Across apps: "turn my report into slides", "put the totals from Budget.xlsx in my report as a
  table", "add a slide with the March figures from the open sheet", "export the report as a PDF".

Hermes can also change a file you do not have open, named by its path ("add page numbers to the
footer of ~/Documents/Report.docx"): it reads the file, changes it and writes it back, asking you
first every time, and the original is backed up as above. When the file holds something Herald
would not keep, Hermes has to open it in the app instead, so you see what Herald changed before
anything is saved. Hermes saves only when you ask (a document you have saved before still saves
itself), and saving over a file asks first. Its comments are signed Hermes.

Hermes works through its `docs`, `sheets` and `slides` tools, the same commands the command bar and
voice reach. On Herald OS Linux, `herald-os docs`, `herald-os sheets` and `herald-os slides` do the
same from a terminal (`herald-os docs write "## Next steps" --at end`, `herald-os sheets read
A1:D20`, `herald-os sheets write B7 "=SUM(B2:B6)"`, `herald-os slides from-doc
~/Documents/Report.docx --notes`, `herald-os slides pdf`); `herald-os commands` lists every form.

## Voice

- **Talking to Hermes.** Press the voice key (`Alt+Space` on a Mac, `Super+V` on Linux), or say
  "hey Hermes" when the wake word is on, and ask: "add a column for tax", "translate this paragraph
  into Spanish", "make the heading bold", "fill in the rest of this column". Requests like these go
  to Hermes as you said them, with what Herald Office has open, so "this paragraph", "these cells"
  and "this slide" mean what you are looking at. Short commands run at once: "new document", "new
  spreadsheet", "new presentation", "new slide", "open Herald Docs", "save the document", "save the
  presentation".
- **Dictation.** Press `Cmd+Ctrl+X` (`Super+Ctrl+X` on Linux), or say "start dictation", and speak;
  a pause ends it. In Herald Docs the words go in at the caret; in Herald Sheets into the selected
  cell and on down the column (a number becomes a number, and the selection moves down so you can
  carry on); in Herald Slides into the text box you are editing. Each dictation is one step to undo.
  Pressing the voice key and saying "type" with the words does the same. On a Mac the words go
  straight into the document; on Herald OS Linux they are typed as keys into the window in front.
- **Spoken punctuation.** Say "comma", "period" (or "full stop"), "question mark", "exclamation
  mark", "colon", "semicolon", "new line" (a new paragraph, or the next item of a list, in Docs; the
  next cell down in Sheets) and "new paragraph". End with "press enter" to press `Enter` after the
  words.

## The name on your comments

The first time you add a comment or a note in Herald Docs or Herald Sheets, Herald asks for the name
to put on it, starting from your account's name. The same name goes on your comments in every
Office app and is saved in the files you comment on; cancelling the question leaves the comment
unposted. Change it in Settings > General > Herald Office > Name on comments (clear it to be asked
again), or with Change under Herald Docs' comments. Comments Hermes adds are signed Hermes; one
added from the command bar or by voice carries your name, or "Herald user" until you have chosen
one.

## Limits

For a file you open, File > What Herald changed… lists most of these that apply to it.

- **Files.** Old Office files (`.doc`, `.xls`, `.ppt`), OpenDocument files and PowerPoint files with
  macros (`.pptm`) do not open, and macros in `.docm` and `.xlsm` files are not kept.
- **Herald Docs.** Text in columns becomes one column. Text boxes come after the paragraph they are
  anchored to, equations become plain text, and other shapes are left out. Pictures placed beside
  the text go in line with it; EMF, WMF and TIFF pictures and pictures linked from outside the file
  are left out; charts and SmartArt become pictures. Tracked changes are shown accepted. Only the
  first section's headers and footers are used, and pages are numbered on from the first in plain
  numbers, whatever a section asks. Content controls become their text, and embedded objects are
  not kept. A Word document Herald saves holds PNG, JPEG, GIF and BMP pictures only (SVG and WebP
  are left out). Markdown and plain text keep no headers, footers, comments or page setup.
- **Herald Sheets.** Macros, protection, form controls, embedded objects, data connections and
  queries (their last results stay as values), custom views, what-if scenarios, a shared workbook's
  history and digital signatures are not kept, nor are print areas, print titles and page breaks.
  Grouped rows and columns show ungrouped. Formulas that use a table's column names or another
  workbook keep their last values, and formulas that spill are saved as fixed-size arrays. Pictures,
  shapes, pivot tables, slicers and charts Herald does not draw are not shown, but go back into the
  file when it saves; Herald Sheets cannot add pictures yet. A CSV file holds the sheet in front,
  saved as its cells show (formulas as their results, no formatting). Comments stay out of undo:
  adding, answering, resolving or deleting one cannot be undone (notes can).
- **Herald Slides.** Animations, automatic slide timings, transition sounds, embedded fonts, macros,
  comments, sections, custom shows and slide masters other than the one most slides use are not
  kept. Videos show as a still picture and sounds are left out. Charts, SmartArt and embedded
  objects show as their picture (or a box) and go back into the file as they were, but cannot be
  edited; Arrange's Convert to Shapes turns SmartArt that has a drawing into shapes. Shadows and
  other effects are left out, and WordArt and vertical text are shown as plain, upright text.
- **Printing.** Herald Sheets prints the cells of the sheet in front, without its charts.
- **Hermes.** Its commands do not reach the master view, transitions or presenting yet, and it
  exports PDFs rather than printing.

## Linux notes

- **Windows.** Each app is a window of its own, three quarters of the screen wide; the Dock's Herald
  Office tile brings back the open ones, or opens Applications when none is.
- **OpenDocument files.** LibreOffice Writer, Calc and Impress come with Herald OS Linux: open an
  `.odt`, `.ods` or `.odp` file there and save it as a Word, Excel or PowerPoint file to work on it
  in Herald Office.
- **Fonts.** Office files often use Calibri and Cambria, which Herald OS Linux does not include.
  Herald Docs and Sheets draw them with Carlito and Caladea, which take the same room, when those
  are installed; otherwise, and in Herald Slides, the nearest font stands in, so lines can break in
  other places. The file keeps its fonts' names.

## Troubleshooting

- **Herald stopped saving a document by itself.** A change would lose something the format cannot
  keep, and the status bar said which. Save it yourself to agree, or use Save As… for a format that
  keeps it.
- **A file changed on disk while I had unsaved edits.** Choose Keep mine (saved over theirs) or Load
  theirs (your unsaved edits go).
- **I want the file as it was before Herald saved it.** Look in
  `~/.hermes/herald-os/office-backups`, in the folder of the day it was first saved over.
- **Hermes says a file has things Herald shows differently.** It will not rewrite that file unseen.
  Open it, check File > What Herald changed…, and ask again with the document open.
- **The Ask Hermes field says Hermes is offline or starting.** It takes requests once Hermes is
  running; if Hermes does not come back, see [Troubleshooting](troubleshooting.md).
