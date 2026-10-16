# Herald Calc

Herald Calc is the calculator built into Herald OS. Its main view is a notepad where you write math
the way you would say it ("20% of 84.50", "5 km in miles", "days until Dec 25") and every line
shows its answer on the right as you type. It also has a classic keypad with scientific and
programmer modes, graphs, a searchable history, and buttons that turn a note into a spreadsheet or
a table in a document. It is the same exact engine Hermes uses for math, so the numbers Hermes
gives you are worked out, not guessed.

Open it from the Dock, from Applications (`Cmd+Shift+A`, `Super+A` on Linux; type "calculator",
"calc", "convert" or "units"), by asking Hermes, or by saying "open the calculator". On Herald OS
Linux it opens as a compact floating window over your work. `Cmd+1` to `Cmd+4` (`Ctrl` on Linux)
switch between its Notes, Keypad, Graph and History views.

## The notepad

Write one calculation per line. The answer appears at the right of the line, in your language's
number style, and follows every change you make.

| You write | You get |
| --- | --- |
| `0.1 + 0.2` | 0.3 (exact decimals, never 0.30000000000000004) |
| `2^100` | 1,267,650,600,228,229,401,496,703,205,376 |
| `1/3 + 1/6` | 0.5 |
| `20% of 84.50` | 16.9 |
| `84.50 + 15%` | 97.175 |
| `15% off 60` | 51 |
| `what % of 80 is 20` | 25% |
| `2,400 + 180 split 3 ways` | 860 |
| `5 km in miles` | 3.1069 mi |
| `12 in cm` | 30.48 cm (12 inches) |
| `350°F in C` | 176.67 °C |
| `1.5 GB in MB` | 1,500 MB |
| `100 USD in BRL` | the European Central Bank's rate of the day |
| `days until Dec 25` | the number of days |
| `3 weeks from today` | the date |
| `Mar 3 to Jun 9 in days` | 98 days |
| `9am Sydney in New York` | the time there, and the day when it is another one |

- **Percentages.** "20% of 84.50", "84.50 + 15%", "84.50 - 15%", "15% off 60", "15% on 60", "what %
  of 80 is 20", "20 is what % of 80", "20 is 25% of what" and "% change from 50 to 75".
- **Splitting.** "2,400 + 180 split 3 ways", "split 2,580 between 4 people", "$120 split 3 ways".
- **Units.** Length, mass, temperature, volume, area, speed, data sizes and time, with "in", "to"
  or "as" to convert: "3 ft 4 in in cm", "60 mph * 2 hours in km", "2 TB / 50 MB/s in hours".
  An "in" right after a plain number means inches when a length follows it: "12 in cm" is 30.48
  cm, and "5 ft 10 in cm" is 177.8 cm. A name keeps its own value, so after "x = 12", "x in cm" is
  12 cm.
- **Currencies.** ISO codes ("100 USD in BRL") and symbols ("€50 + £20 in USD"); "$" is your
  region's dollar. See [Currency rates](#currency-rates).
- **Dates and durations.** "days until Dec 25", "3 weeks from today", "Mar 3 to Jun 9 in days",
  "90 days ago", "today + 30 days", "days since Jan 1".
- **Time zones.** "9am Sydney in New York", "now in Tokyo", "3pm London to PST". Cities,
  countries, abbreviations and offsets all work, and daylight saving is taken care of by the
  system's own time zone data; nothing is fetched for them.
- **Names.** "budget = 1,200" on one line lets later lines use `budget`, and so does a label:
  after "Rent: 1,200", `rent` is 1,200. `prev` is the line above.
- **Words in the sum.** "4 nights * $189" and "3 coffees + 2 coffees" read the words after a number
  as what it counts; they show in grey, so you can see what was left out.
- **Totals.** A line that says `sum` or `total` adds up the lines above it, back to the last blank
  line or heading; `average` does the same for the mean. The total of the whole note is at the
  bottom of the window.
- **Layout.** A line starting with `#` is a heading, and `//` starts a comment. Lines of plain words
  stay as they are. Numbers are read and shown in your region's style: `2.400,50` in German,
  `2 400,50` in French.
- **When a line has no answer.** It shows a quiet mark instead of a result; point at it to read
  why ("A length and a mass don't add up"). Nothing you type can break the note.

Point at an answer to see the working, step by step, and to copy it or put it on a new line.

### Notes

Keep as many notes as you like in the list on the left (hide it with the sidebar button, or make
the window narrow). Every note saves itself as you type. The first time you open Herald Calc, a
Welcome note shows each kind of line.

## Currency rates

Herald Calc converts currencies with the European Central Bank's daily reference rates, which it
fetches from [Frankfurter](https://frankfurter.dev), a free service that needs no account. This is
the app's only network call: it happens at most once a day, only when a calculation needs a
currency, and it sends nothing about you. The rates are kept in Herald's data folder, so
conversions keep working offline with the last rates; the note then says which day's rates it used
("Rates from 15 Oct").

The ECB publishes rates for about 30 currencies, once each working day around 16:00 Central
European Time. They are reference rates, not the rate a bank or card will give you.

To stop the fetch, open the settings menu at the top right and turn off **Fetch currency rates
daily**. The last rates you have keep working; Herald fetches nothing until you turn it back on.

## Graphs

A line like `y = sin(x) * x` or `f(x) = x^2 - 2` draws a graph beside the note, one colour per
function. The Graph view (`Cmd+3`) gives graphs the whole window, with a list of functions you can
edit.

- **Move around.** Drag to pan; scroll or pinch to zoom around the pointer; double-click to fit.
  With the graph focused, `+` and `-` zoom, the arrow keys pan and `0` resets.
- **Trace.** Point at the graph to read exact values: a dot on each curve and the x and y there.
- **Asymptotes and gaps.** `tan(x)` and `1/x` are never joined across their asymptotes, which
  show as faint dashed lines, and `sqrt(x)` or `log(x)` simply stop where they have no value.
- **From Herald Sheets.** Write `plot column B of Budget.xlsx` (or `plot B2:B40 of ~/Sales.xlsx`)
  to draw a column's numbers, from a workbook open in Herald Sheets or a file on disk.

## The keypad

The Keypad view (`Cmd+2`) is a classic calculator with big numbers that roll as they change. Pick
**Classic**, **Scientific** or **Programmer** at the top.

- **Classic.** The four operations with the usual precedence, `%`, `±`, memory keys (`MC`, `MR`,
  `M+`, `M−`) and exact decimals.
- **Scientific.** Powers and roots, logarithms, trigonometry and its inverses and hyperbolics,
  factorials, `π`, `e`, constants, and degrees or radians (the `Deg`/`Rad` key).
- **Programmer.** Hexadecimal, decimal, octal and binary side by side, 8, 16, 32 or 64-bit words,
  signed or unsigned, `AND`, `OR`, `XOR`, `NOT`, `NAND`, `NOR`, shifts and rotates, and a grid of
  bits to click (it steps aside when the window is short).
- **Keyboard.** Type digits and operators, `Enter` or `=` for the answer, `Backspace` to delete,
  `Esc` to clear, and `A`–`F` in hexadecimal.
- **Sounds.** Soft key sounds are off at first; turn on **Key sounds** in the settings menu.

Reduce Motion (Settings > Appearance, or your system's setting) keeps the numbers still.

## History

The History view (`Cmd+4`) lists your calculations from the notepad, the keypad, your voice and
Hermes, newest first. Search it in your own words: "that mortgage thing", "coffee last week".
Choose one to bring it back into the note in front. **Clear history** deletes all of it. The
history stays on this computer, in Herald's data folder.

## Herald Office

- **Copy to Sheets** makes a new workbook in Herald Sheets from the note in front, a row for each
  line: real formulas where a line maps cleanly ("budget - rent" refers to the rows `budget` and
  `rent` came from, "sum" becomes `=SUM(…)`, "84.50 + 15%" becomes `=84.5*(1+15%)`), values for the
  rest (units, dates, converted currencies), and each line's label in the column next to it.
- **Copy to Docs** makes a new document in Herald Docs with the note as a neat table, a section
  for each heading.

## Hermes and your voice

Hermes uses Herald Calc's engine for any arithmetic, percentage, unit, currency, date or time-zone
question, through its `calc` tool, and shows you the working. Ask it to "plot sin(x) from 0 to
10" or to "open my calculation history". See [docs/SYSTEM-BRIDGE.md](../SYSTEM-BRIDGE.md).

Simple spoken math is answered at once, without waiting for Hermes: "what's 15% of 340", "how many
miles is 10 km", "convert 100 dollars to euros", "what time is it in Tokyo". Anything that needs
thinking or your context ("what's 15% of my rent") goes to Hermes as usual. See
[docs/VOICE.md](../VOICE.md).

On Herald OS Linux, `herald-os calc "20% of 84.50"` prints the answer (`--steps` adds the working),
`herald-os calc - < budget.txt` works out a whole note, `herald-os calc convert 5 km miles`
converts, and `herald-os calc history mortgage` searches the history.

## Where it keeps things

Notes, the history and the cached rates are in `~/.hermes/herald-os/calc/` (`notes/`,
`history.json` and `rates.json`).
