---
name: herald-sheets
description: Work in Herald Sheets, the spreadsheet in Herald OS - read workbooks, write values and formulas (a formula from a description, explaining one, filling it down), fill a column from examples, clean data (duplicates, spaces, numbers and dates kept as text, splitting a column, letter case), say what stands out, build a workbook such as a trip budget, format numbers and cells, sort, filter, freeze, manage sheets, put a range in a Herald Docs report, save Excel and CSV files and export PDFs, all through the sheets tool
metadata:
  hermes:
    tags: [herald-os, sheets, spreadsheet, excel, xlsx, csv, formulas, functions, budget, data cleaning, dedupe, dates, sort, filter, analysis, pdf]
---

# Herald Sheets

Herald Sheets is the spreadsheet built into Herald OS. It opens and saves Excel workbooks (`.xlsx`)
and CSV files, and the person watches every change land in the Sheets window. Use the `sheets`
tool whenever they want a spreadsheet read, built or changed: "total this column", "what does
this formula do", "remove the duplicates", "make me a budget for the Lisbon trip", "what stands
out in these sales", "sort by date", "save it as a CSV".

## The workflow

1. **Find the workbook.** `sheets action=list` shows the workbooks open in Herald Sheets: name,
   path, unsaved edits, the one in front (`active`) and the range selected in each.
   `sheets action=list_all` adds what is open in Herald Docs and Slides, and `os_ui action=state`
   carries the same list as `office`. "This sheet" is the one in front, and "these cells" are
   its selection (`range=selection`). Name a workbook by its file
   (`workbook="~/Documents/Budget.xlsx"`) or by its tab (`workbook="Budget.xlsx"`); left out, a
   call works on the one in front.
2. **Read first.** `sheets action=read` gives the sheets (size, hidden, frozen panes) and, without
   `range`, the cells that hold something on the sheet in front: `values`, `formulas` where there
   are any, and `text` (what the cells show: formatted numbers and dates) where it differs. A big
   sheet comes back from its top, as many rows as fit in 10,000 cells; read the rest by range
   (`range="A200:F400"`). From the read, learn the headers (usually row 1), where the data starts
   and ends, which columns hold numbers, dates or text, and which formulas are already there.
   `sheets action=find text="Lisbon"` lists the cells where something is.
3. **Write values and formulas.** `sheets action=write range="A1" values=[["Item", "Cost"],
   ["Rent", 1200]]` writes rows from that cell (at most 10,000 cells a call); a whole range takes
   exactly its size, and one value (`values=[["0"]]`) fills every cell of it.
   - Text starting with `=` is a formula: English function names, commas between arguments
     (`=SUMIFS($D$2:$D$90, $C$2:$C$90, "Food")`), `$` for references that must not move.
   - Numbers go in as plain numbers (`1200`, `0.15`, `-40`), never `"1,200"` or `"$1,200"`; show
     them as money or percentages with a number format. Text that only looks like a number (an ID,
     a phone number, a postcode with a leading zero) stays text, and a leading `'` keeps any value
     as text.
   - Dates are numbers shown in a date format. Write `=DATE(2026, 3, 14)`, or write the dates as
     text and turn them into dates with `clean` (`dates`), then format them (`yyyy-mm-dd`).
4. **One call, one step.** Every call is one step the person can undo (Ctrl+Z, ⌘Z on a Mac, or
   `sheets action=undo`, with `steps=3` for several). Land a whole change in one call: several
   writes, formats and fills go in one `sheets action=edit` (below).
5. **Check.** Read back what you changed (`range="E2:E6"`) and look at what it shows. An error in
   a cell (`#NAME?` an unknown function or a typo, `#REF!` a reference that no longer exists,
   `#DIV/0!` a division by an empty cell, `#VALUE!` text where a number belongs) means fix it
   before you say it is done.

An open workbook changes in its window. A file that is not open is read, changed and written
straight back to disk: the person is asked first every time, Herald backs the original up the
first time it writes over it, and it refuses when the file holds something it cannot keep (see
the end). Then open it (`sheets action=open path="~/Documents/Budget.xlsx"`; the answer lists the
sheets and anything Herald shows differently) and work in the window.

## A formula from a description

"Total the amounts for each category", "add a 10% tip", "how many days until each deadline":

1. Read the used range and find the columns by their headers: Amount is D, Category is C, the
   data runs from row 2 to row 90.
2. Write the formula where it was asked for, or in the first empty column with a header of its
   own, over ranges that cover all the data. Fix with `$` what must stay put when it is filled.
3. A whole column is one `fill`: the formula goes in the first cell and its references move for
   each row, the way dragging the fill handle does.
4. Read the results back and say what the formula does in a sentence.

```
sheets action=read
sheets action=edit edits=[{"op": "write", "range": "E1", "values": [["With tip"]]}, {"op": "fill", "range": "E2:E31", "formula": "=D2*1.1"}]
sheets action=read range="E1:E6"
```

Useful functions: `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`, `COUNTIFS`, `SUMIFS`,
`AVERAGEIFS`, `IF`, `IFS`, `IFERROR`, `AND`, `OR`, `XLOOKUP` (or `INDEX` with `MATCH`), `ROUND`,
`TEXT`, `LEFT`, `RIGHT`, `MID`, `LEN`, `TRIM`, `PROPER`, `TEXTJOIN`, `TEXTSPLIT`, `DATE`, `TODAY`,
`YEAR`, `MONTH`, `EOMONTH`, `DATEDIF`, `NETWORKDAYS`, `UNIQUE`, `FILTER`, `SORT` and `SUMPRODUCT`.
Prefer one clear formula to a clever one.

## Explaining a formula

`sheets action=read range="F2"` gives the formula and its result. Read the cells it refers to as
well, then explain it step by step in plain words with the real values ("it looks up the price of
the item in B2 in the Prices sheet, multiplies it by the quantity in C2, and gives 0 instead of
an error when the item is missing"). Change nothing unless the person asks for a fix.

## Filling a column from examples

"Fill in the rest like the first three": read the examples and the columns they come from, work
out the rule, and check it against every example before you write anything. When a formula can
compute it (first names out of "Rivera, Ana", a code from two columns, a price with tax), write
the formula in the first empty cell and `fill` it down, so the person can see and reuse it. When
it cannot (a category chosen by meaning), write all the values in one `write`. Say the rule you
followed.

## Cleaning data

`sheets action=clean range="A1:F400" clean=<what> header=true` cleans a range as one step, and
keeps formulas as they are:

- `dedupe`: removes rows that repeat an earlier one, by every column or `by="A,C"` (letters or
  headers); the rows below move up.
- `trim`: spaces at the ends of cells and doubled spaces inside.
- `numbers`: numbers kept as text ("1,200", "$5", "(300)", "12%") become numbers.
- `dates`: dates kept as text become real dates in `dateFormat` (`yyyy-mm-dd`); whether the day
  or the month comes first is read from the data, or say `order=dmy` or `order=mdy` for dates
  like 03/04/2026.
- `split`: one column split at `delimiter` (comma, the default, semicolon, space, tab, pipe or
  any character) into the columns to its right; it refuses when those hold data, unless
  `overwrite=true`.
- `case`: `case=upper`, `lower` or `title` (the default).

Read first to pick the range and to see whether row 1 is a header, then make every cleaning in
one `edit` (`{"op": "clean", "range": "C2:C400", "action": "dates", "order": "dmy"}`; inside
`edits` the op's own word is `action`), and read back to check. `replace` takes care of single
values (`find="N/A" replacement=""`); `sort` groups what belongs together.

## What stands out

"What stands out", "anything odd here", "how did we do": read the whole used range (in parts when
it is big) and look at totals, averages, the biggest and smallest values, trends over time,
outliers, empty or repeated rows, entries spelled two ways, and cells with errors. Answer in a few
short points with the numbers and the cells they are in ("March is the only month below target:
$8,200 in D4"). Change nothing; offer to highlight, sort or fix what you found.

## Building something new

Plan the layout first: headers in row 1, one row per item, numbers in their own columns, a total
row at the bottom with formulas. Then make it in two calls: `new` with the values and formulas,
and one `edit` for the formats and the frozen header.

```
sheets action=new name="Lisbon trip budget" values=[["Item", "Planned", "Actual", "Difference"], ["Flights", 640, 612, "=B2-C2"], ["Hotel (4 nights)", 520, 0, "=B3-C3"], ["Food", 300, 0, "=B4-C4"], ["Transport", 80, 0, "=B5-C5"], ["Total", "=SUM(B2:B5)", "=SUM(C2:C5)", "=B6-C6"]]
sheets action=edit edits=[{"op": "format", "range": "A1:D1", "format": {"bold": true, "background": "#e8eefc"}}, {"op": "format", "range": "B2:D6", "format": {"numberFormat": "€#,##0.00"}}, {"op": "format", "range": "A6:D6", "format": {"bold": true, "border": {"edges": "top", "style": "thin"}}}, {"op": "freeze", "rows": 1}]
```

Templates give a workbook its usual shape: `budget`, `expenses`, `todo`, `schedule` and
`invoice` (`sheets action=new template=budget name="2026 budget"`). `path` saves the new
workbook at once (`.xlsx` or `.csv`, never over a file that exists): give it only when the person
said where.

## Formats, sorting, filtering and sheets

- `format` takes `numberFormat` (`"#,##0.00"`, `"0%"`, `"yyyy-mm-dd"`, `"$#,##0"`), `bold`,
  `italic`, `underline`, `strikethrough`, `font`, `size`, `color`, `background`, `align`,
  `verticalAlign`, `wrap` and `border` (`{"edges": "outside", "style": "medium", "color":
  "#999999"}`): `sheets action=format range="B2:B40" format={"numberFormat": "$#,##0.00"}`.
- `sheets action=sort range="A1:F90" by="Date" header=true` (`by` is a letter, a header or a
  number from the range's first column; `ascending=false` for largest or newest first).
- `sheets action=filter range="A1:F90" by="Status" values=[["Paid", "Due"]]` keeps the rows
  showing one of those; `condition={"operator": "greaterThan", "value": 100}` keeps rows meeting
  a test (equal, notEqual, greaterThan, greaterThanOrEqual, lessThan, lessThanOrEqual), and
  `clear=true` takes the filter off.
- `sheets action=freeze rows=1` keeps the header in view (`columns=1` the first column; `rows=0
  columns=0` unfreezes).
- `add_sheet name="Q2"` (`index` for where), `rename_sheet sheet="Sheet1" name="Budget"`, and
  `remove_sheet sheet="Old"`, which deletes everything on it and asks the person first.

## Across documents

A range goes into a Herald Docs document as a table, as its cells show: `docs
action=insert_range workbook="Budget.xlsx" range="A1:D6" document="Trip notes.docx" at=end`. A
table from a document comes the other way by reading it (`docs action=read`) and writing its rows
in one `write`. `list_all` finds what is open in both.

## Saving and exporting

- Never save unless the person asks. An open workbook keeps its unsaved edits (its tab says so),
  and they save with Ctrl+S (⌘S on a Mac) or ask you to.
- "Save it": `sheets action=save`. Saving over the workbook's own file asks the person every
  time; the first time Herald writes over a file it shows what it cannot keep, and the original
  goes to Herald's Office backups.
- A workbook never saved needs a place: `sheets action=save to="~/Documents/Trip budget.xlsx"`. A
  file that exists is replaced only with `overwrite=true`, which asks first.
- A CSV file keeps only values: the sheet in front, each cell as it shows (a formula's result, a
  number in its format), no formulas, formatting or other sheets. Say so when the person asks for
  CSV and the workbook has more, and offer `.xlsx` as well.
- A PDF: `sheets action=export_pdf` writes the sheet in front as a new PDF in ~/Documents, laid
  out as it prints, or `to="~/Desktop/Budget.pdf"`. Say where it went.

## What Herald Sheets cannot do yet

No charts and no pivot tables yet: a chart in a file is not kept (the data it shows stays), and a
pivot table's cells stay as plain values. Pictures, shapes, text boxes and comments are not shown
or kept, and Excel tables become plain ranges. Say so plainly, and offer what works: a summary
table with `SUMIFS` or `COUNTIFS` in place of a pivot table, a sorted range with the key figures
in place of a chart.
