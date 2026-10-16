---
name: herald-calc
description: Exact math with Herald Calc, the sentence calculator in Herald OS - every arithmetic, percentage, unit, currency, date and time-zone answer through the calc tool instead of mental math, with the working shown, notes of several lines with names and totals, the date of the currency rates, what the graph of a function or a sheet's column shows, opening graphs and keypads for the person, and finding their past calculations (read only)
metadata:
  hermes:
    tags: [herald-os, calc, calculator, math, arithmetic, percentages, tips, units, conversion, currency, exchange rates, dates, time zones, graphs, plots, history]
---

# Herald Calc

Herald Calc is the calculator built into Herald OS: a notepad that reads sentences ("20% of
84.50", "5 km in miles", "days until Dec 25"), keypads (classic, scientific, programmer), graphs
and a history. Its engine is exact: decimals stay decimals (0.1 + 0.2 is 0.3), big numbers keep
every digit, and a fraction that never ends comes with the fraction itself. The `calc` tool is that
engine for you. It only computes and reads, so it runs at once and never asks.

## Never do the math yourself

Use `calc` for every arithmetic, percentage, unit, currency, date or time-zone answer, even one
that looks easy: a tip, a split bill, a total, a conversion, how many days. Carries, rounding and
units are where answers go wrong; the engine does not make those mistakes.

- Give the numbers as the person gave them and never round them first; round only when you say the
  answer, the way `display` does.
- One question with parts is one call with several lines (see Notes below), not several guesses.
- When calc cannot read a sentence, rewrite it as one of the forms below. When it is math the
  engine does not do (solving an equation, a formula you have to reason out), work it out step by
  step, check each arithmetic step with calc, and say which part Herald Calc checked.

## Show the working

Every answer has `steps`, one line each ("20% of 84.50 = 84.50 × 0.20", "= 16.90"). Show them
briefly with the answer: a line or two, never a wall. The answer itself:

- `display`: the answer as Herald shows it ("16.9", "3.1069 mi", "R$564.81"); quote this one.
- `value`: the exact value as a plain decimal; `fraction` the exact fraction when there is one.
- `kind` (number, percent, unit, currency, date, time, duration), `unit` (a unit, a currency's
  ISO code, a duration's unit) and `zone` for a time.
- `result`: the one-line summary, "20% of 84.50 = 16.9".

## The forms

| Asking | `text` |
| --- | --- |
| Percentages | `20% of 84.50`, `84.50 + 15%` (a 15% tip on top), `80 - 20%`, `20% off 80` |
| Splitting | `2,400 + 180 split 3 ways` |
| Units | `5 km in miles`, `350°F in C`, `2 cups in ml`, `60 mph in km/h`, `1.5 GB in MB` |
| Currencies | `100 USD in BRL`, `€45 in AUD` |
| Dates | `days until Dec 25`, `3 weeks from today`, `Mar 3 to Jun 9 in days` |
| Time zones | `9am Sydney in New York`, `now in Tokyo` |
| Plain math | `(3 + 4) * 2`, `2^100`, `sqrt(144)`, `1/3 + 1/6` |

Right after a plain number, `in` before a length means inches: `12 in cm` is 30.48 cm and `5 ft 10
in cm` is 177.8 cm. Write the unit the person gave (`12 m in ft`, `12 inches in cm`), and put a
bare number before `in` only when they meant inches.

`calc action=convert value="5 ft 3 in" from=ft to=cm` converts an amount alone, when you have the
number and both units apart, and `value=9am from=Sydney to=London` a time of day.

## Currencies

Currency answers use the European Central Bank's reference rates, fetched at most once a day (and
only when a sum names a currency), and kept for when the computer is offline. The answer carries
`ratesDate`: say which day's rates you used ("at the ECB's rate of 15 October"). They are reference
rates, not what a bank or a card charges; say so when it matters, such as a large transfer. When
Herald has no rates, calc says so: never make a rate up.

## Notes: several lines

Send several lines in one `text` (separated by `\n`) when a question builds on itself. The engine
reads them as Herald Calc's notepad does:

```
rent = 1,850
food = 120 * 4.3
transport = 45 * 4.3
rent + food + transport
```

- `name = …` gives a value a name for the lines after it. A label before a colon names a line
  without making a variable: `Flights: 2 * 489`.
- `# Heading` and `// comment` lines are for the person and are not worked out.
- `lines` has every line with its `display`, or its `error` when it has no answer; `value` and
  `display` are the last answer's. Show the lines that matter, then the total.

## Graphs

- `calc action=plot expression="x^2 - 4"` says what the graph shows without opening anything:
  where it crosses zero (`zeros`), its local maxima and minima (`extrema`), vertical asymptotes,
  ranges with no value (`gaps`) and the range of y between `x_min` and `x_max` (-10 to 10 when left
  out). Separate several functions with `;`.
- A sheet's numbers: `workbook="Budget.xlsx" range="B:B"` (or `expression="column B of
  Budget.xlsx"`) gives the count, the smallest, the largest, the sum, the mean, the first and the
  last.
- To show the person a graph, run `os_ui action=run command=calc.plot args={"expression": "sin(x) *
  x; x^2", "from": -5, "to": 5}` (or with workbook and range): it opens Herald Calc's graph and
  answers with the same numbers. Describe a graph from those numbers, never from what a curve
  usually looks like.

## Herald Calc itself

- `os_ui action=run command=calc.open` opens it, with args `view` (notes, keypad, graph or
  history), `keypad` (classic, scientific or programmer) or `text` to start a new note with lines
  you wrote, such as a budget the person wants to keep changing.
- `calc action=history query="mortgage"` finds the person's past calculations, best match first,
  or the latest without a query: what was asked, the answer, when, and where it came from (notes,
  keypad, voice, hermes, command). Your own calls are kept there too, from Hermes.
- The history and the notes belong to the person: read the history, never clear it and never
  delete a note. If they want it cleared, they do it in Herald Calc's history.

## Voice

When the person says a simple sum ("what's 15% of 340", "how many miles is 10 km", "what time is
it in Tokyo"), Herald answers it before you hear it. What reaches you needs thought: their own
numbers ("15% of my rent"), advice ("how much should I tip"), a why. Find their numbers (ask, or
read what they point to), then do the math with calc and answer in a sentence or two.

## Examples

- "What's a 15% tip on $84.50, split three ways?": `calc action=eval text="84.50 + 15% split 3
  ways"`, then "With the tip it's $97.18, so $32.39 each (84.50 + 15% = 97.175, ÷ 3)."
- "I earn 85,000 a year: what's that a week after 30% tax?": one note,
  `text="salary = 85,000\nnet = salary - 30%\nnet / 52"`, then "About 1,144.23 a week: 85,000
  less 30% is 59,500 a year, ÷ 52."
- "How hot is 350 for my oven in Celsius?": `text="350°F in C"`, then "About 177°C (176.67)."
- "When is a 9am Sydney meeting in London?": `text="9am Sydney in London"`.
- "How many days until my trip on 3 March?": `text="days until Mar 3"`.
- "Show me sin x times x": `os_ui action=run command=calc.plot args={"expression": "sin(x) * x"}`,
  then say where it crosses zero and how high it swings, from its answer.
